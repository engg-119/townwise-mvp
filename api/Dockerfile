# Townwise API image. Build from the repository root (the context needs the workspace manifests):
#   docker build -f api/Dockerfile -t townwise-api .
# Both stages use Node 24.22.1 on Debian bookworm slim, pinned by its multi-arch index digest.

FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS deps
WORKDIR /app
# Manifests first, so this layer is rebuilt only when a manifest or the lockfile changes.
COPY package.json package-lock.json .npmrc ./
COPY api/package.json api/
COPY backend/auth/package.json backend/auth/
COPY backend/mongo/package.json backend/mongo/
COPY backend/rate-limit/package.json backend/rate-limit/
COPY backend/redis/package.json backend/redis/
COPY backend/server-core/package.json backend/server-core/
# Production dependencies of the API workspace only, exactly as locked, with no install scripts
# (.npmrc also sets ignore-scripts and engine-strict).
RUN npm ci --omit=dev --ignore-scripts --workspace @townwise/api --no-audit --no-fund

FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY api/package.json api/production.env api/
COPY api/src api/src
COPY backend/auth/package.json backend/auth/
COPY backend/auth/src backend/auth/src
COPY backend/mongo/package.json backend/mongo/
COPY backend/mongo/src backend/mongo/src
COPY backend/rate-limit/package.json backend/rate-limit/
COPY backend/rate-limit/src backend/rate-limit/src
COPY backend/redis/package.json backend/redis/
COPY backend/redis/src backend/redis/src
COPY backend/server-core/package.json backend/server-core/
COPY backend/server-core/src backend/server-core/src
# The code is owned by root and read-only to the app; it runs as the image's unprivileged node user.
# No secrets are in any layer: they arrive as environment variables at run time.
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--env-file=api/production.env", "api/src/main.ts"]
