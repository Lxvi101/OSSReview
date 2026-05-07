# GitHub Code Reviewer

A self-hosted, open-source GitHub pull request review bot powered by local,
subscription-backed Claude Code or Codex CLI installations.

It listens for webhooks on the repositories you track, reviews each new pull
request once automatically, and runs again on demand when you `@mention` it.
Comments are posted under your own GitHub App identity.

The codebase is built to be **read, modified, and operated for the next decade**.
See [`docs/architecture.md`](docs/architecture.md) for the design and
[`docs/adr/`](docs/adr/) for the decisions and the alternatives that were rejected.

## Highlights

- **Single-user, single-tenant, self-hosted.** Your laptop, a Raspberry Pi, or
  a tiny VPS. One `docker compose up`.
- **Real GitHub App.** Manifest-flow setup — no manual permission checkboxes,
  no PAT to leak. Comments appear from your bot identity, not from you.
- **Subscription-backed local reviewers.** The worker can route reviews to
  Claude Code or Codex using the CLI account already logged in on the host.
  No Anthropic API key is required for the default path.
- **Durable.** Webhooks are persisted before any work begins. Jobs survive
  crashes and resume safely. SQLite + WAL + [Litestream][litestream] backups.
- **Observable.** Structured JSON logs with correlation IDs, Prometheus
  metrics, optional OpenTelemetry tracing, and an audit log surfaced in the UI.
- **Boring on purpose.** Server-rendered HTML, HTMX, Alpine.js — the UI you
  ship today will render identically in 2036.

## Install

The end-to-end install + GitHub-App-wiring guide lives in
[`INSTALL.md`](INSTALL.md). It walks through the full flow — server
prerequisites, secrets generation, the manifest-flow App setup, smoke
check, and your first review — in about 20 minutes.

```bash
# Three-command quickstart (assumes you've read INSTALL.md):
cp .env.example .env                                                 # then fill in
docker compose -f docker/compose.yml up -d --build
docker compose -f docker/compose.yml exec server pnpm smoke           # all green = ready
```

For local-machine dev with real webhooks, [smee.io][smee] gives you a
public URL without any TLS setup.

## How a review happens

```
GitHub PR opened
  │
  ▼
POST /webhooks/github  ──tx──►  webhook_deliveries + jobs   (returns 202 in <100ms)
                                                      │
                                                      ▼
                                             apps/worker pickup
                                                      │
                                                      ▼
                          ReviewRun created with idempotency key
                          state machine: queued → preparing → fetching
                                                      │
                              token-authenticated git clone (before review)
                                                      │
                                            .git stripped from workspace
                                                      │
                          state: reviewing  ──►  local reviewer provider:
                                                  - Claude Code SDK via `claude`
                                                  - or Codex CLI via `codex`
                                                  - read-only review prompt/tools
                                                  - structured findings output
                                                      │
                          state: posting    ──►  GitHub Review API: line comments
                                                  + summary + verdict
                                                      │
                          state: completed
```

If the worker crashes mid-review, the run resumes from a safe state on restart
(see [`docs/architecture.md`](docs/architecture.md#restart-during-review)).
If the same webhook is redelivered, the idempotency key absorbs it.

## Project layout

```
apps/
  server/     HTTP: webhook ingress, UI, JSON API, /health, /metrics
  worker/     Background job processor — pulls jobs from SQLite, runs reviews
packages/
  core/       Pure domain. ReviewRun aggregate, state machine, formatter,
              policy ("should we review?"), port interfaces. Zero I/O.
  github/     @octokit/* — App auth, webhook signature verify, PR client
  reviewer/   Reviewer port + local Claude/Codex adapters + legacy sandbox
  storage/    Kysely + better-sqlite3 + numbered raw-SQL migrations
  queue/      SQLite-backed durable job queue (~300 LOC, hand-rolled)
  config/     zod-validated env loader
  observability/  pino logger, prom-client metrics, AsyncLocalStorage context
  web/        Eta templates + HTMX + Alpine — server-rendered UI
docker/       Dockerfile.app, Dockerfile.sandbox, seccomp, compose, network
docs/         architecture.md, operations.md, adr/
tests/        integration, e2e, security, fixtures
```

The boundary table in [`docs/architecture.md`](docs/architecture.md) describes
which package can import which. It's enforced by ESLint in CI.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — the design, the lifecycle,
  the state machine, the durability story.
- [`docs/operations.md`](docs/operations.md) — the runbook. Where to look when
  something breaks. How to back up, restore, requeue, drain.
- [`docs/adr/`](docs/adr/) — every consequential decision with the rejected
  alternative. Read these in 2030 to know whether to reverse a choice.
- [`SECURITY.md`](SECURITY.md) — how to report vulnerabilities.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — code style, commit format, how to run
  the test suite, how to file an ADR.

## See all runs here:
https://github.com/settings/apps/gcr-bot-demo/advanced

## License

Apache-2.0 — see [`LICENSE`](LICENSE). Apache was chosen over MIT for the
explicit patent grant and trademark protection, both of which matter for
adoption inside larger organizations.

[litestream]: https://litestream.io
[smee]: https://smee.io
