# syntax=docker/dockerfile:1.7
# Multi-stage build for the agent-jobs Next.js app + custom server.
# Runtime entrypoint is `node server.js` (compiled from server.ts).

# ---- Stage 1: deps ----
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

# ---- Stage 2: build ----
FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build the Next.js app.
RUN pnpm build
# Compile the custom server entrypoint (server.ts) and its deps
# (lib/*, seed/*) to CommonJS JS so `node server.js` works at runtime.
RUN pnpm exec tsc \
      server.ts \
      --outDir . \
      --target ES2022 \
      --module CommonJS \
      --moduleResolution node \
      --esModuleInterop \
      --skipLibCheck \
      --resolveJsonModule

# ---- Stage 3: runtime ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
RUN corepack enable

# Production deps + Next build output + compiled server.
COPY --from=deps    /app/node_modules    ./node_modules
COPY --from=builder /app/.next            ./.next
COPY --from=builder /app/public           ./public
COPY --from=builder /app/server.js        ./server.js
COPY --from=builder /app/lib              ./lib
COPY --from=builder /app/seed             ./seed
COPY --from=builder /app/package.json     ./package.json
COPY --from=builder /app/next.config.ts   ./next.config.ts

EXPOSE 3000
CMD ["node", "server.js"]
