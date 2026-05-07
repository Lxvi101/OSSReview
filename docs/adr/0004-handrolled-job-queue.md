# ADR 0004: Hand-rolled SQLite-backed job queue

- Status: Accepted
- Date: 2026-05-03

## Context

The system has exactly one queue: "review this PR." Volume is on the order of
tens of jobs per hour for a busy single-tenant install. Requirements:

- Survive a worker crash (a job either finishes or is requeued — never lost).
- Idempotency: webhook redeliveries with the same `unique_key` must collapse.
- Retry with backoff for transient failures; terminal-fail with a DLQ.
- Stale-lock recovery if a worker dies while holding a job.
- Atomic `enqueueIn(tx, ...)` so the webhook handler can persist a delivery
  *and* enqueue a job in one SQLite transaction (the durability lynchpin).

## Decision

A ~250-LOC hand-rolled queue inside the existing SQLite database
(`packages/queue/`). One `jobs` table; pick-one is `SELECT … LIMIT 1` +
`UPDATE … WHERE state='queued'` in a transaction, with WAL-level writer
serialization. Workers poll once a second when idle, immediately when busy.

## Alternatives considered

- **BullMQ.** Excellent. Requires Redis. Adding a second moving part (a
  second listening process, a second backup story, a second ops surface)
  for ten jobs an hour fails the cost/benefit test.
- **pg-boss.** Postgres-only. We chose SQLite for the system of record
  (ADR 0002); pg-boss would force a second database.
- **graphile-worker.** Same: Postgres-only.
- **temporal.io / Restate.** Sledgehammer. We are not building distributed
  workflows.
- **In-process EventEmitter.** Loses jobs on restart. Hard no.

## Consequences

- One source of truth (SQLite); one backup story (Litestream); one ops
  surface.
- The `enqueueIn(tx, ...)` API is the single most important method in the
  package — the webhook ingress builds on it for atomicity. Callers MUST
  use it (not `enqueue(...)`) when correlating to another row.
- We forgo BullMQ's UI / advanced flow control / cron primitives. None
  needed for this product.
- One process at a time can be the writer. Concurrency means N worker
  processes coordinating through the queue's atomic claim — simpler than
  in-process worker pools and easier to debug.
- We accept the ~5ms tail-latency hit of the polling loop. Empty-poll cost
  is one indexed `SELECT … WHERE state='queued' AND run_after <= now`
  (microseconds on SQLite).

## Reversal cost

Low. The interface is small (`enqueue`, `enqueueIn`, `pickOne`, `markCompleted`,
`markFailedOrRequeue`). Swapping for BullMQ or pg-boss is a 1–2 day project
that touches only the queue package and the worker composition root.
