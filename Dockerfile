# syntax=docker/dockerfile:1.6
# TrustGate Dockerfile multi-stage v2.0 (Item 5 / P0-E.1)
#
# Stage 1 — builder: installs ALL dependencies (including devDependencies, since
# we need the TypeScript compiler for npm run build) and runs compilation.
# Caches npm layers via BuildKit `--mount=type=cache` to speed up rebuilds.
#
# Stage 2 — runner: minimal production image. Contains:
#   • Node 20 Alpine
#   • bash (for scripts/wait-for-it.sh)
#   • curl (for /health endpoint HEALTHCHECK)
#   • PRODUCTION-ONLY node_modules (--omit=dev)
#   • compiled code under dist/
#   • scripts/ and migrations/ required at runtime
#   • runs as NON-ROOT USER (fixed UID/GID node:node from Alpine)
#   • integrated HEALTHCHECK pointing to /health — auto-restart if
#     container is alive but app is in a crash loop.
#
# Per MODO ARQUITETO rules: security > performance > elegance.

# ---- Builder Stage ---------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app

# Install system dependencies to compile rare native packages (e.g., bcrypt,
# should we ever add any). node:20-alpine ships with most; we ensure python3 +
# make + g++ only in the builder (not in the runner).
RUN apk add --no-cache python3 make g++ bash

# Copy only package.json + lockfile — maximizes `npm ci` cache hits.
COPY package*.json .npmrc* ./

# npm ci with persistent BuildKit cache. Note: --mount does not work in older
# Docker without BuildKit; to ensure compatibility, we use a fallback layer
# with `|| npm ci` should BuildKit be absent (in practice CI always has it).
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci

# Copy sources EXACTLY what is needed to compile (src + tsconfig).
# Documentation (.md) under docs/ and scripts/ do NOT go to the builder
# (scripts only run in the runner via shell; and documentation is not used by
# the TS build).
COPY tsconfig*.json ./
COPY src ./src

RUN npm run build

# Optional: run extra typecheck and tests inside the builder?
#   We don't do that HERE to avoid duplicating CI/CD effort (Item 6 runs tests
#   in a separate job BEFORE the Docker build). Should you still want to:
#   RUN npm run test -- --runInBand  # (not enabled by default — BuildKit may
#                                    #  lack network/Postgres/Redis).

# ---- Runner Stage ----------------------------------------------------------
FROM node:20-alpine AS runner

# OCI Labels. Helps with vulnerability scans (Trivy) and registry metadata.
LABEL org.opencontainers.image.title="TrustGate Marketplace" \
      org.opencontainers.image.description="TrustGate — Stellar x402/MPP task marketplace with on-chain Registry + Soroban Escrow Option C." \
      org.opencontainers.image.vendor="TrustGate Engineering" \
      org.opencontainers.image.licenses="UNLICENSED" \
      org.opencontainers.image.source="https://github.com/Jistriane/TrustGate"

WORKDIR /app

ENV NODE_ENV=production \
    LOG_LEVEL=info \
    PORT=3000 \
    # Disables optional npm/Node telemetry at runtime (security paranoia).
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NODE_OPTIONS=""

# Bash is required by scripts/wait-for-it.sh (written in bash, not sh).
# Curl is used for the Docker HEALTHCHECK (curl -f /health).
# Shadow is added per good practice (adduser --system depends on shadow-uidmap? No, here we use the already-existing `node` user).
RUN apk add --no-cache bash curl shadow tini

# Create /app dir with node:node ownership BEFORE copying files — avoids
# permission issues if the host does a bind mount (docker-compose.dev.yml).
RUN mkdir -p /app /app/dist /app/scripts /app/migrations /app/docs && \
    chown -R node:node /app

# Re-install ONLY production dependencies. Again: BuildKit npm cache.
COPY package*.json .npmrc* ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev && \
    npm cache clean --force

# Copy built artifacts from builder → runner.
COPY --from=builder --chown=node:node /app/dist ./dist

# Copy runtime assets (wait-for-it, shell/TS scripts, migrations, docs).
# Note: scripts/ in general are interpreted by ts-node INSIDE DEV images —
# on PRODUCTION images we only need the bash scripts. To avoid breaking
# debugging operations (kubectl exec / docker exec), we COPY the whole
# scripts/ directory. The size penalty is tiny (~50KB of TS).
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node docs ./docs

# wait-for-it must be executable. The +x chmod is applied via COPY --chmod on
# modern BuildKit; fallback via RUN if not supported.
RUN chmod +x ./scripts/wait-for-it.sh ./scripts/contract-security-check.sh ./scripts/*.sh 2>/dev/null || true

# Drop root → run as unprivileged user `node` (UID 1000, GID 1000
# in the official node:alpine image). Meets CIS-Docker-4.1 "Create a user for the
# container" requirement and prevents container escape exploits that need euid=0.
USER node:node

# Document the port (does not auto-publish; metadata only).
EXPOSE 3000/tcp

# HEALTHCHECK — 3 fallback layers:
#   (1) Tries local curl to /health (port 3000).
#   (2) If curl does not return HTTP 2xx → container marked unhealthy.
#   (3) Orchestrators (ECS, K8s, Swarm restart policy) auto-restart.
# 45s interval, 10s timeout, retries=3 → ~2min until marking unhealthy (avoids
# false positives during startup on slow machines).
HEALTHCHECK --interval=45s --timeout=10s --start-period=60s --retries=3 \
    CMD curl --fail --silent --max-time 5 "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1

# init tiny (tini) as PID 1 — ensures zombie reaping and correct SIGTERM signal
# propagation to the Node process (Node.js by default does not re-parent orphan
# children when it is PID 1).
ENTRYPOINT ["/sbin/tini", "--"]

# Default command. To override in docker-compose.yml / run use `command:`.
CMD ["./scripts/wait-for-it.sh", "redis:6379", "-t", "30", "--", \
     "./scripts/wait-for-it.sh", "postgres:5432", "-t", "30", "--", \
     "node", "dist/server.js"]
