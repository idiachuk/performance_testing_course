# Performance Testing Lab — Artillery + Prometheus + Grafana

The hands-on companion for the **Performance Testing with Artillery.io** course.
It gives you a complete, safe playground on your own machine:

- a **service under test** that behaves like a real production app — fast when
  idle, slower under load, and returning errors past its capacity;
- **Prometheus + Grafana** so you can watch the server from the inside while
  Artillery applies load from the outside;
- **ready-to-run Artillery test files** for every lesson in the course.

Never load-test public APIs or websites you don't own — it violates their
terms of service and can get your IP blocked. Everything in this course runs
against this lab instead.

```
service/        Express + TypeScript app (the system under test)
monitoring/     Prometheus + Grafana configuration
load/lessons/   One Artillery test file per course lesson
load/ci/        Reference GitHub Actions workflow
load/test.yml   Spike-test showcase used in the demo video
```

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker
  Engine + Compose on Linux)
- [Node.js](https://nodejs.org/) 20+ (for Artillery itself)
- Artillery: `npm install -g artillery`

## Start the lab

From the repository root:

```bash
docker compose up -d --build
```

Verify everything is up:

| What | Where | Check |
|---|---|---|
| Service under test | http://localhost:3000 | `curl http://localhost:3000/api/hello` |
| Prometheus | http://localhost:9090 | Status → Targets: `load-test-service` is **UP** |
| Grafana | http://localhost:3001 | Open the **Load test service** dashboard |

Grafana allows anonymous admin access — no login needed.

## Run your first test

```bash
cd load/lessons
artillery run first-test.yml
```

Then try a test that actually moves the dashboard — the spike showcase:

```bash
artillery run ../test.yml
```

Watch Grafana while it runs: request rate climbing, p95/p99 latency bending
upward, event-loop lag rising, 503 errors at the spike peak — then recovery.

## The service's API

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/hello` | GET | Basic load target; degrades realistically under load |
| `/api/login` | POST | `{ "username", "password" }` → `{ "token" }` (demo creds: `student` / `artillery`) |
| `/api/user` | GET | Protected — requires `Authorization: Bearer <token>` |
| `/api/logout` | POST | Protected — invalidates the token |
| `/api/search` | POST | `{ "query": "..." }`; repeated queries are served from cache |
| `/api/upload` | POST | Accepts any body, replies with the byte count |
| `/api/products?limit=N` | GET | Response payload scales with `N` (volume testing) |
| `/health` | GET | Health check |
| `/metrics` | GET | Prometheus scrape endpoint |

Demo credentials can be changed in `docker-compose.yml` (`LAB_USER` /
`LAB_PASSWORD`).

## How the service degrades (by design)

The app models three real-world behaviors, tuned in `service/src/index.ts`:

1. **Baseline latency** (~8–15 ms) — simulated I/O, the floor of the latency graph.
2. **CPU burn per request** (4 ms, synchronous) — Node's single thread
   saturates near **~250 req/s**; past that, latency and event-loop lag climb
   non-linearly. This is the "knee" you'll find in the breakpoint lesson.
3. **Load shedding** — beyond 100 concurrent requests it returns **503**
   instead of queueing forever.

Search (`/api/search`) adds a fourth: an **in-memory cache**. Cache misses
burn ~25 ms of CPU; hits are nearly free. The CSV-payload lesson makes this
visible on the dashboard's cache panel.

## Lesson files

Each file in `load/lessons/` is self-contained and commented. Suggested order
follows the course:

| File | Course topic |
|---|---|
| `first-test.yml` | Your first Artillery test |
| `post-request.yml` | Constructing a POST request |
| `capture-and-log.yml` | Reading responses, capture and log |
| `ensure-checks.yml` | Result validation with ensure and expect |
| `load-profile.yml` | Load test |
| `stress-profile.yml` | Stress test |
| `scalability-environments.yml` | Scalability test (stepped environments) |
| `spike-profile.yml` | Spike test |
| `volume-profile.yml` | Volume test |
| `soak-profile.yml` | Endurance (soak) test |
| `breakpoint-profile.yml` | Breakpoint test |
| `csv-payload.yml` + `keywords.csv` | Test data from CSV |
| `realistic-flow.yml` | Think time, weights, loops, conditionals |
| `hooks-auth.yml` | before/after hooks with bearer auth |
| `env-vars.yml` | Credentials via environment variables |
| `multi-environments.yml` | Multiple configs in one file |
| `processor-upload.yml` + `processor.js` | Custom JavaScript processors |
| `../ci/github-actions-perf.yml` | Artillery in CI/CD |

The upload lesson needs one extra dependency (from `load/`): `npm install`.

## Running the service outside Docker (optional)

For faster edit-restart cycles while exploring the service code:

```bash
cd service
npm install
npm run dev
```

Then point Prometheus at the host instead of the container: in
`monitoring/prometheus.yml` change the target to `host.docker.internal:3000`
(on Linux, also add `extra_hosts: ["host.docker.internal:host-gateway"]` to
the `prometheus` service in `docker-compose.yml`), and restart the stack.

## Tear down

```bash
docker compose down
```

## Notes

- The histogram buckets in `service/src/index.ts` are in **seconds**; adjust
  them if you make the endpoints much slower or faster.
- To also push Artillery's own client-side metrics into Prometheus (so load
  and server metrics share a timeline), add the `publish-metrics` plugin to a
  test — a good stretch exercise.
