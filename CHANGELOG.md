# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added — M1 (foundations)
- Monorepo skeleton: pnpm workspaces, Turborepo, biome, vitest, base CI.
- `packages/core`: domain types, `ReviewRun` state machine, idempotency keys,
  port interfaces, formatter, policy. 100% pure, no I/O.
- `packages/config`: zod-validated boot env loader.
- `packages/observability`: pino logger, AsyncLocalStorage correlation context,
  prom-client metrics registry, two-layer redaction (pino path + per-chunk
  regex over the serialized output).
- `packages/storage`: better-sqlite3 + Kysely + numbered raw-SQL migrations
  + libsodium SecretBox + repositories for every aggregate.
- `packages/queue`: hand-rolled SQLite-backed durable job queue (~250 LOC) with
  retry/backoff, stale-lock sweeper, atomic `enqueueIn` for tx-coupled writes.
- `packages/github`: webhook signature verification, App auth via Octokit,
  PR client, manifest-flow exchange (native `fetch`, no extra dep).
- `packages/reviewer`: `Reviewer` port, `ClaudeReviewer` adapter, sandbox
  runner with full security flags (read-only root, cap-drop ALL, seccomp,
  no-new-privileges, pids/memory/cpu caps, egress firewall network), reaper.
- `apps/server`: Fastify with raw-body content parser, webhook ingress
  (single-tx persist + enqueue), setup wizard (GitHub App manifest flow),
  dashboard, repository list, review list and detail (HTMX-polled), audit log,
  `/health`, `/ready`, `/metrics`.
- `apps/worker`: composition root, review handler with state-machine driving,
  installation-repos sync handler, graceful shutdown.
- `docker/`: Dockerfile.app (server+worker), Dockerfile.sandbox (per-review),
  seccomp profile, compose, network setup README.
- `docs/`: `architecture.md`, `operations.md`, ADRs 0001–0003, 0006.

### Added — M2 (hardening, real reviewer, abuse guards)
- **Real Claude SDK driver** (`packages/reviewer/src/claude/driver.ts`):
  registers `submit_findings` as an in-process MCP tool, runs `query()` with
  `permissionMode: 'dontAsk'`, only `Read/Glob/Grep/LS` allowlisted alongside
  the submit tool, file-write/Bash/WebFetch explicitly disallowed. Captures
  cost + token usage from the SDK `result` message. Wall-clock timeout +
  caller-abort combined into one `AbortController`.
- **Mention handler now fetches PR head/base SHAs.** Added `getPullRequest`
  to the `GithubAppClient` port + Octokit implementation.
- **Cost / abuse guards** in `@gcr/core/policy/costGuards`:
  - `checkMentionCap` — per-PR rate-cap on mention re-runs (default 3, override
    in repo settings).
  - `checkCostCap` — daily $-cap pause; reads from `cost.daily_cap_micros`
    setting. Audit-logged with `cost.cap_reached` when triggered.
  - `selectDiffMode` — switches the prompt to "summary mode" above 256kB diffs
    so vendored / lockfile churn doesn't burn budget.
- **Litestream sidecar** wired in `docker/compose.yml` with
  `docker/litestream.yml` (local-file replica by default; S3 stanza commented
  in for production).
- **Vendor JS via npm**: `htmx.org@2.0.4` + `alpinejs@3.14.3` are real
  dependencies; the web build copies them into `dist/static/` at build time.
  No more placeholders. The `pnpm fetch-vendor` script remains as an air-gap
  fallback.
- **Boundaries lint** migrated to ESLint v9 flat config
  (`eslint.boundaries.config.mjs`) with `@typescript-eslint/parser`. Passes.
- **CI workflow** reordered: build first so generated dist exists for the
  downstream typecheck and test steps.

### Added — tests
- 105 tests passing across 13 files. Of those, the following are new in M2:
  - `core/policy/costGuards.test.ts` (9 tests) — all three guard functions.
  - `tests/integration/cloneStripsGit.test.ts` (2 tests) — verifies the
    workspace contains no `.git` after the clone-and-strip flow.
  - `tests/integration/sandboxProtocol.test.ts` (6 tests) — request/response
    schema invariants; explicit "API key never appears in serialized output."
  - `tests/integration/webhookE2E.test.ts` (10 tests) — real Fastify app via
    `app.inject(...)`: bad sig 401 + no persist, 202 + enqueue + idempotent
    on redelivery, draft ignored, mention enqueues mention job,
    install enqueues install-sync, `/health` `/ready` `/metrics` all respond.

### Added — docs
- ADR 0004: hand-rolled SQLite job queue (with rejected alternatives).
- ADR 0005: one Docker container per review run (with the threat model and
  the alternatives — gVisor, Firecracker, in-process — explicitly weighed).

### Fixed
- `DomainError.cause` correctly `override`s `Error.cause`.
- Reviewer/sandbox code imports `Reviewer`/`ReviewerInput`/`ReviewResult`
  from `@gcr/reviewer` (their owner) rather than `@gcr/core`.
- Storage repos use Kysely's `Selectable<T>` for `toDomain` row types.
- `SystemClock` moved to `@gcr/core` proper (was in `testing/`); re-exported
  from `@gcr/core/testing` for back-compat.
- Logger wraps the destination stream with a per-chunk `redactTokens` pass —
  the previous `formatters.log` ran *before* pino assembled the `msg` field
  and missed embedded tokens. Test now passes with sentinels in arbitrary
  positions.
- `openDatabase` returns a `DatabaseHandle = { kysely, sqlite, destroy }`
  instead of reaching into Kysely internals for the raw handle (which broke
  in Kysely 0.27.x).
- `manifest.exchangeManifestCode` uses native `fetch` (one fewer dep).
- Fastify v5 / pino `Logger` type mismatch handled with a single boundary cast.
