# GitHub Code Reviewer — server + worker share this image.
#
# Multi-stage:
#   1. deps    — install pnpm + production deps (cached when lockfile unchanged)
#   2. build   — full install + tsc to dist/
#   3. runtime — slim Node, reviewer CLIs, only dist + production node_modules

ARG NODE_VERSION=20.11.0
ARG CLAUDE_CODE_VERSION=2.1.129
ARG CODEX_CLI_VERSION=0.128.0

# ── 1. deps ──────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
# Install pnpm directly rather than via `corepack enable`. Corepack inside
# Docker is brittle — its on-the-fly fetch of pnpm fails with "Internal
# Error: Error when performing the request to https://registry.npmjs.org/pnpm"
# in some environments (DNS, IPv6, registry rate limits). Pinning here
# eliminates that variable entirely. Version matches `packageManager` in
# the root package.json.
RUN npm install -g pnpm@9.12.0
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY apps/worker/package.json apps/worker/
COPY packages/config/package.json packages/config/
COPY packages/core/package.json packages/core/
COPY packages/github/package.json packages/github/
COPY packages/observability/package.json packages/observability/
COPY packages/queue/package.json packages/queue/
COPY packages/reviewer/package.json packages/reviewer/
COPY packages/storage/package.json packages/storage/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile

# ── 2. build ────────────────────────────────────────────────────────────────
FROM deps AS build
COPY . .
RUN pnpm build

# ── 3. runtime ──────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates dumb-init \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g \
      @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
      @openai/codex@${CODEX_CLI_VERSION}
WORKDIR /app

# Bring node_modules and built JS only.
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps ./apps
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/pnpm-workspace.yaml ./pnpm-workspace.yaml

# Runtime data dir. Also used as HOME so Claude/Codex subscription auth can
# persist on the mounted compose volume.
RUN mkdir -p /var/lib/gcr/.claude /var/lib/gcr/.codex && chown -R 10001:10001 /var/lib/gcr
USER 10001:10001

ENV NODE_ENV=production \
    DATABASE_PATH=/var/lib/gcr/data.sqlite \
    HOME=/var/lib/gcr \
    CLAUDE_CODE_HOME=/var/lib/gcr \
    CODEX_HOME=/var/lib/gcr/.codex

# A single image, two entrypoints. Compose chooses which.
EXPOSE 3000
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "--enable-source-maps", "apps/server/dist/main.js"]
