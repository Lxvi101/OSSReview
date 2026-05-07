# Architecture

This document is the map. It is intentionally short — the code itself is the
detailed reference, and the [ADRs](adr/) are the *why* for each consequential
choice.

## One-screen overview

```
                       ┌─────────────────────────┐
GitHub  ──webhook──▶   │   apps/server (Fastify) │   ──HTML──▶  Operator
                       │   /webhooks/github      │   ──────▶   /metrics
                       │   /, /repositories,     │
                       │   /reviews, /audit, …   │
                       └────────┬────────────────┘
                                │ tx: insert delivery + insert job
                                ▼
                       ┌─────────────────────────┐
                       │   SQLite (WAL)          │
                       │   webhook_deliveries    │
                       │   jobs, review_runs,    │
                       │   audit_events, …       │
                       └────────┬────────────────┘
                                │ pickOne
                                ▼
                       ┌─────────────────────────┐
                       │   apps/worker           │
                       │   review_pr handler     │
                       └────────┬────────────────┘
                                │ git clone (before review)
                                │ + .git stripped
                                ▼
                       ┌─────────────────────────┐
                       │ local reviewer provider │
                       │ Claude Code or Codex CLI│
                       │ subscription auth from  │
                       │ the worker user's HOME  │
                       └────────┬────────────────┘
                                │ structured findings
                                ▼
                       worker formats → posts to GitHub Reviews API
                                │
                                ▼
                       review_runs.state = completed
```

## Package boundaries

| Package | Owns | Must NOT import |
|---|---|---|
| `core` | Domain types, state machine, formatter, port interfaces | `github`, `reviewer`, `storage`, `queue`, anything I/O |
| `github` | Octokit, webhook verify, GitHub DTOs | `core` aggregates, `reviewer`, `storage` |
| `reviewer` | Reviewer providers, Claude SDK, Codex CLI runner, prompts | `core` aggregates, `github`, `storage` |
| `storage` | Kysely, SQLite, migrations | `github`, `reviewer` |
| `queue` | Job schema, polling, retry/backoff | `core`, `github`, `reviewer` |
| `web` | Templates only | Direct DB access (must go through API) |
| `apps/*` | Composition root + HTTP | — (allowed to know everyone) |

Enforced by `eslint-plugin-boundaries` in CI (see `.eslintrc.boundaries.cjs`).

## ReviewRun state machine

```
queued → preparing → fetching → reviewing → posting → completed
   │         │           │          │          │
   └─────────┴───────────┴──────────┴──────────┴──→ failed (terminal)
                                              └──→ cancelled
```

Implemented in [`packages/core/src/reviewRun/state.ts`](../packages/core/src/reviewRun/state.ts).
Every transition is checked at runtime; illegal transitions throw
`IllegalStateTransitionError`.

## Restart-during-review

| State on resume | Action |
|---|---|
| `queued`, `preparing`, `fetching` | Restart from `preparing` |
| `reviewing` | Abort, restart from `fetching` |
| `posting` | Query GitHub for the review by an internal marker first; if posted, skip; otherwise re-post |
| `completed` / `failed` / `cancelled` | No-op |

Implemented in `resumeAction()` in the same file.

## Critical-file map

If you have 30 minutes and want to understand the system, read these in
order:

1. `packages/core/src/reviewRun/state.ts` — the state machine.
2. `packages/core/src/reviewRun/aggregate.ts` — the aggregate that runs on it.
3. `packages/storage/src/migrations/sql/0001_init.sql` — the schema.
4. `apps/server/src/http/webhooks.ts` — the durability boundary with GitHub.
5. `apps/worker/src/handlers/reviewPr.ts` — the orchestration spine.
6. `packages/reviewer/src/port.ts` — the seam Claude is on.
7. `packages/reviewer/src/providerRouter.ts` — provider selection.
8. `packages/reviewer/src/claude/driver.ts` and `packages/reviewer/src/codex/adapter.ts` — local reviewer runtimes.
