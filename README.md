# GitHub Code Reviewer

Self-hosted GitHub PR review bot. Listens for webhooks, reviews each new PR
once automatically, and re-runs on demand when you `@mention` it. Uses your
local Claude Code or Codex CLI subscription — no API key required. Or point
it at any [Agent Client Protocol](https://agentclientprotocol.com/) agent
(GitHub Copilot CLI, and more) via `REVIEWER_PROVIDER=acp`.

## Quickstart

You need: Docker, ~2 GB RAM, ~5 GB disk, and a public URL GitHub can reach
(use [smee.io](https://smee.io/new) for a free dev URL with no setup).

```bash
git clone <REPO_URL> github-code-reviewer
cd github-code-reviewer
pnpm install
pnpm bootstrap
```

`bootstrap` generates `.env`, runs `docker compose up`, and prints the URL
to open the GitHub App setup wizard. Then:

```bash
docker compose -f docker/compose.yml exec worker claude auth login
```

Open `http://localhost:3000/setup`, click through the wizard, install the
App on a test repo, open a PR, watch the review post itself.

Full guide with troubleshooting: [`INSTALL.md`](INSTALL.md).

## Layout

```
apps/
  server/      HTTP: webhooks, /health, /metrics, JSON API for the dashboard
  worker/      Background job processor (pulls jobs from SQLite, runs reviews)
  dashboard/   Vite + React + Tailwind UI
packages/
  core/        Pure domain. ReviewRun aggregate, state machine, formatter, ports
  github/      @octokit/* — App auth, webhook signature verify, PR client
  reviewer/    Reviewer port + Claude SDK / Codex CLI / generic ACP adapters
  storage/     Kysely + better-sqlite3 + numbered raw-SQL migrations
  queue/       SQLite-backed durable job queue
  config/      zod-validated env loader
  observability/  pino logger, prom-client metrics, AsyncLocalStorage context
docker/        Dockerfile.app + compose.yml
scripts/       bootstrap.sh, init-env.sh, gcr.mjs (operator CLI), smoke.mjs,
               acp-selftest.mjs (verify an ACP agent end-to-end)
```

## Lifecycle

```
GitHub PR opened
  ▼
POST /webhooks/github  ── tx ──►  webhook_deliveries + jobs   (returns 202 in <100ms)
                                              │
                                              ▼
                                     apps/worker pickup
                                              │
                                              ▼
                ReviewRun upsert by idempotency key
                state: queued → preparing → fetching
                              │
                          token-authenticated git clone, .git stripped
                              │
                state: reviewing  ──►  Claude / Codex / ACP reviewer
                                       (read-only file tools, structured findings)
                              │
                state: posting   ──►  GitHub Review API
                              │
                state: completed
```

If the worker crashes mid-review, the run becomes `failed` on restart and
the user retries by `@mention`. Webhook redeliveries are absorbed by the
idempotency key.

## Day-to-day

| Task | Where |
|---|---|
| See recent reviews | `/` (dashboard) |
| See failures and cancellations | `/errors` |
| Cancel a running review | review detail page → "Cancel run" button |
| Pause a repo without uninstalling | `/repositories/<id>` → toggle off |
| Prune old runs | `/setup/status` → Maintenance card |
| Inspect/requeue jobs from CLI | `node scripts/gcr.mjs --help` |
| Smoke check | `pnpm smoke` |

## License

Apache-2.0 — see [`LICENSE`](LICENSE).
