FROM node:22-alpine

WORKDIR /app

# Install dependencies first so Docker layer caching skips this step when only
# source code changes.
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

EXPOSE 3000

# tsx runs the TypeScript source directly — no build step needed for a lab.
CMD ["npx", "tsx", "src/index.ts"]
