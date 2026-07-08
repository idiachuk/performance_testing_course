import express, { Request, Response, NextFunction } from "express";
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from "prom-client";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT ?? 3000);

// Demo credentials for the auth lessons. Override via environment variables;
// never hard-code real credentials in test files (see the course section on
// environment variables and secrets).
const LAB_USER = process.env.LAB_USER ?? "student";
const LAB_PASSWORD = process.env.LAB_PASSWORD ?? "artillery";

const app = express();

// --- Prometheus registry -------------------------------------------------
// A dedicated registry keeps our metrics isolated and easy to expose.
const register = new Registry();
register.setDefaultLabels({ app: "load-test-service" });

// Node.js process metrics: CPU, memory, event-loop lag, GC, etc.
collectDefaultMetrics({ register });

// Latency histogram. Buckets are in seconds and chosen to give useful
// resolution from a few ms up to ~1s, so p95/p99 are meaningful under load.
const httpDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [register],
});

// In-flight requests gauge-style counter via histogram is overkill; a simple
// counter of total requests complements the histogram's _count series.
const httpTotal = new Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status_code"] as const,
  registers: [register],
});

// Number of requests currently being processed. This is the single most
// useful signal for understanding load-shedding: it rises as the service
// falls behind and is what we threshold on to return 503s.
const inFlight = new Gauge({
  name: "http_requests_in_flight",
  help: "Number of in-flight HTTP requests being processed",
  registers: [register],
});

// Cache behaviour of the /api/search endpoint. Watching hits vs misses in
// Grafana is the whole point of the CSV-payload lesson: identical queries are
// served from cache (cheap), unique queries do real work (expensive).
const searchCacheHits = new Counter({
  name: "lab_search_cache_hits_total",
  help: "Search requests served from the in-memory cache",
  registers: [register],
});
const searchCacheMisses = new Counter({
  name: "lab_search_cache_misses_total",
  help: "Search requests that had to compute results (cache miss)",
  registers: [register],
});

// --- Load-sensitivity model ----------------------------------------------
// The previous handler awaited a setTimeout, which is non-blocking: Node can
// hold tens of thousands of pending timers with no contention, so latency
// stayed flat no matter how many vusers hit it. To make the service degrade
// realistically under load we combine three mechanisms, each driving a
// different panel on the Grafana dashboard:
//
//   1. BASE_LATENCY  — a small async delay simulating baseline I/O (a DB call).
//      Non-blocking; sets the floor of the latency graph at low load.
//   2. CPU_BURN_MS   — real synchronous CPU work per request. Because Node is
//      single-threaded, these bursts serialise: total CPU demand is
//      arrivalRate * CPU_BURN_MS, so the thread saturates near
//      1000 / CPU_BURN_MS ≈ 250 req/s. As you approach that knee, requests
//      queue behind each other, latency climbs non-linearly, and
//      nodejs_eventloop_lag_p99 climbs right along with it.
//   3. MAX_CONCURRENT — a capacity cap. Once more than this many requests are
//      in flight, the service sheds load by returning 503 instead of queueing
//      forever. This is what populates the error-rate panel at the spike peak.
//
// Defaults are tuned for the load/test.yml profile (ramp to ~300): calm at the
// baseline of 10/s, visibly degrading latency as the spike ramps, and 503s at
// the 300/s sustain — then full recovery on the ramp-down. Edit these to move
// the breaking point.
const BASE_LATENCY_MIN_MS = 8; // floor of baseline latency
const BASE_LATENCY_JITTER_MS = 7; // random extra, so the graph isn't a flat line
const CPU_BURN_MS = 4; // synchronous CPU cost per request -> ~250 req/s ceiling
const MAX_CONCURRENT = 100; // shed with 503 beyond this many in-flight requests

//   4. LAG_SHED_MS — lag-aware load shedding. The MAX_CONCURRENT check alone
//      is not enough: under CPU saturation the queue forms in the event loop
//      *before* requests ever reach a handler, where an in-flight counter
//      cannot see it. Requests then wait many seconds and die as client-side
//      socket timeouts instead of clean 503s. So we also watch the event-loop
//      delay itself: when it exceeds this threshold, every request (except
//      /metrics and /health) is rejected immediately with a cheap 503. Cheap
//      rejections let the loop drain, latency stays bounded, and the failure
//      mode under overload becomes "fast 503" instead of "10-second timeout" —
//      graceful degradation you can see on the dashboard. Because the trigger
//      is the lag itself, this adapts automatically to however much CPU the
//      Docker VM on a student's machine actually provides.
const LAG_SHED_MS = 100;

// Rolling event-loop delay measurement feeding the lag shedder. The histogram
// is sampled and reset twice a second; under heavy load the sampling timer
// itself is delayed, which only makes the measured lag more honest.
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
let currentLagMs = 0;
setInterval(() => {
  currentLagMs = loopDelay.mean / 1e6;
  loopDelay.reset();
}, 500).unref();

// A cache miss on /api/search costs noticeably more CPU than /api/hello, so
// the difference between hitting and missing the cache is obvious on the
// latency and cache panels.
const SEARCH_CPU_BURN_MS = 25;

// Live count of in-flight requests, used for the capacity check. Mirrored into
// the inFlight gauge so it's visible in Prometheus too.
let currentInFlight = 0;

// Burn CPU for roughly `ms` milliseconds of wall-clock time. The work is real
// (and consumed below) so V8 can't optimise the loop away. This blocks the
// event loop, which is precisely what creates load-dependent latency and lag.
function burnCpu(ms: number): number {
  const end = performance.now() + ms;
  let acc = 0;
  while (performance.now() < end) {
    // A handful of float ops per iteration keeps the perf.now() polling cost
    // from dominating while still being genuine work.
    for (let i = 0; i < 1000; i++) acc += Math.sqrt(acc * 1.0000001 + i);
  }
  return acc;
}

// --- Metrics middleware --------------------------------------------------
app.use((req: Request, res: Response, next: NextFunction) => {
  const endTimer = httpDuration.startTimer();
  res.on("finish", () => {
    // Use the matched route pattern (e.g. /api/hello) instead of the raw URL
    // so high-cardinality paths don't explode the metric label set.
    const route = req.route?.path ?? req.path;
    const labels = {
      method: req.method,
      route,
      status_code: String(res.statusCode),
    };
    endTimer(labels);
    httpTotal.inc(labels);
  });
  next();
});

// Lag-aware load shedding (see the load-sensitivity model above). Skips
// /metrics and /health so monitoring keeps working while the app drowns —
// in production this is why exporters run as sidecars.
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === "/metrics" || req.path === "/health") return next();
  if (currentLagMs > LAG_SHED_MS) {
    res
      .status(503)
      .set("Retry-After", "1")
      .json({ error: "service overloaded (event loop lagging), try again" });
    return;
  }
  next();
});

// Parse JSON request bodies (only applies when Content-Type is
// application/json, so the raw-stream /api/upload endpoint is unaffected).
app.use(express.json());

// --- Auth (deliberately minimal) ------------------------------------------
// Just enough auth to teach Artillery's capture + before/after hooks:
// POST /api/login returns a bearer token, protected endpoints check it,
// POST /api/logout invalidates it. Tokens live in memory — no JWT, no expiry —
// because the lesson is about the load-testing workflow, not about auth.
const validTokens = new Set<string>();

function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !validTokens.has(token)) {
    res.status(401).json({ error: "missing or invalid bearer token" });
    return;
  }
  next();
}

app.post("/api/login", (req: Request, res: Response) => {
  const { username, password } = req.body ?? {};
  if (username !== LAB_USER || password !== LAB_PASSWORD) {
    res.status(401).json({ error: "invalid credentials" });
    return;
  }
  const token = randomUUID();
  validTokens.add(token);
  res.json({ token, tokenType: "Bearer" });
});

app.post("/api/logout", requireAuth, (req: Request, res: Response) => {
  const token = (req.headers.authorization ?? "").slice(7);
  validTokens.delete(token);
  res.json({ message: "logged out" });
});

// Protected endpoint — the target for the hooks lesson: login (before hook),
// call this with the captured token, logout (after hook).
app.get("/api/user", requireAuth, (_req: Request, res: Response) => {
  res.json({
    username: LAB_USER,
    role: "performance-tester",
    memberSince: "2026-01-01",
    plan: "lab",
  });
});

// --- Search with an in-memory cache ----------------------------------------
// Demonstrates why load tests need varied test data (the CSV-payload lesson):
// repeated queries are served from cache and look artificially fast; unique
// queries pay the real computation cost. Compare the two on the dashboard's
// cache panel and latency panel.
const searchCache = new Map<string, { count: number; results: string[] }>();
// Safety cap so a long soak test with unique CSV keywords doesn't grow the
// cache without bound — the lab service itself must not be the memory leak.
const SEARCH_CACHE_MAX_ENTRIES = 50_000;

app.post("/api/search", async (req: Request, res: Response) => {
  const query = req.body?.query;
  if (typeof query !== "string" || query.length === 0) {
    res.status(400).json({ error: "body must contain a non-empty 'query' string" });
    return;
  }

  const cachedEntry = searchCache.get(query);
  if (cachedEntry) {
    searchCacheHits.inc();
    res.json({ query, cached: true, ...cachedEntry });
    return;
  }

  // Cache miss: pay the baseline I/O delay plus a heavy CPU cost, exactly the
  // work the cache exists to avoid.
  searchCacheMisses.inc();
  const base = BASE_LATENCY_MIN_MS + Math.random() * BASE_LATENCY_JITTER_MS;
  await new Promise((r) => setTimeout(r, base));
  burnCpu(SEARCH_CPU_BURN_MS);

  const results = Array.from({ length: 5 }, (_, i) => `${query}-result-${i + 1}`);
  const entry = { count: results.length, results };
  if (searchCache.size >= SEARCH_CACHE_MAX_ENTRIES) searchCache.clear();
  searchCache.set(query, entry);
  res.json({ query, cached: false, ...entry });
});

// --- Upload sink -----------------------------------------------------------
// Target for the custom-processor lesson (multipart file upload built in JS).
// It streams the request body and reports how many bytes arrived — enough to
// prove the upload worked without storing anything on disk.
app.post("/api/upload", (req: Request, res: Response) => {
  let receivedBytes = 0;
  req.on("data", (chunk: Buffer) => {
    receivedBytes += chunk.length;
  });
  req.on("end", () => {
    res.json({ receivedBytes, contentType: req.headers["content-type"] ?? "unknown" });
  });
});

// --- Products (volume-test target) ------------------------------------------
// Response size scales with ?limit=N, so students can observe how payload
// volume (not user count) drives latency and bandwidth — the volume-test
// lesson. Generation cost and serialisation cost both grow with N.
const PRODUCTS_MAX_LIMIT = 5000;

app.get("/api/products", (req: Request, res: Response) => {
  const requested = Number(req.query.limit ?? 20);
  const limit = Math.min(Math.max(Number.isFinite(requested) ? requested : 20, 1), PRODUCTS_MAX_LIMIT);
  const products = Array.from({ length: limit }, (_, i) => ({
    id: i + 1,
    sku: `SKU-${String(i + 1).padStart(6, "0")}`,
    name: `Product ${i + 1}`,
    price: Math.round((10 + (i % 90) + Math.random()) * 100) / 100,
    description:
      "A reliably average product used to pad response payloads so that " +
      "volume tests have something substantial to download and parse.",
  }));
  res.json({ count: products.length, products });
});

// --- Routes --------------------------------------------------------------
// The endpoint Artillery targets. It models a service that degrades under
// load: cheap when idle, slow as the single thread saturates, and shedding
// load with 503s once it's past capacity. See the load-sensitivity model above.
app.get("/api/hello", async (_req: Request, res: Response) => {
  // 1. Capacity check / load shedding. If we're already at the concurrency
  //    ceiling, reject fast with 503 rather than queueing without bound. This
  //    is what makes the error-rate panel light up at the spike peak.
  if (currentInFlight >= MAX_CONCURRENT) {
    res
      .status(503)
      .set("Retry-After", "1")
      .json({ error: "service overloaded, try again" });
    return;
  }

  currentInFlight++;
  inFlight.set(currentInFlight);
  try {
    // 2. Baseline async I/O — non-blocking, sets the latency floor at low load.
    const base = BASE_LATENCY_MIN_MS + Math.random() * BASE_LATENCY_JITTER_MS;
    await new Promise((r) => setTimeout(r, base));

    // 3. Synchronous CPU work — the bottleneck. These bursts serialise on the
    //    single thread, so latency and event-loop lag climb together as load
    //    approaches the ~1000 / CPU_BURN_MS req/s ceiling.
    burnCpu(CPU_BURN_MS);

    res.json({ message: "hello", timestamp: Date.now() });
  } finally {
    currentInFlight--;
    inFlight.set(currentInFlight);
  }
});

// Prometheus scrape endpoint.
app.get("/metrics", async (_req: Request, res: Response) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

// Health check.
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`Service listening on http://localhost:${PORT}`);
  console.log(`  GET  /api/hello          — basic load test target`);
  console.log(`  POST /api/login          — returns a bearer token (${LAB_USER}/<password>)`);
  console.log(`  GET  /api/user           — protected; requires Authorization: Bearer <token>`);
  console.log(`  POST /api/logout         — protected; invalidates the token`);
  console.log(`  POST /api/search         — cached search ({ "query": "..." })`);
  console.log(`  POST /api/upload         — upload sink, reports received bytes`);
  console.log(`  GET  /api/products?limit — volume-test target, payload scales with limit`);
  console.log(`  GET  /metrics            — Prometheus scrape endpoint`);
});
