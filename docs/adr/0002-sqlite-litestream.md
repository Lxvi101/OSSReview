# ADR 0002: SQLite (WAL) as the system of record + Litestream for durability

- Status: Accepted
- Date: 2026-05-03

## Context

We need a system of record for: tracked repositories, PRs, review runs, line
comments, webhook deliveries (verbatim), audit log, settings, and a job queue.

Workload characteristics:
- Single host, single tenant (by design — see ADR 0001 for the project shape).
- Writes: webhook ingest (~10/s sustained burst), worker job state transitions,
  audit append. All small (< 10kB).
- Reads: UI dashboards, occasional ad-hoc operator queries.
- Tens of thousands of rows in the largest table after a year.

## Decision

**SQLite in WAL mode**, accessed via `better-sqlite3` (synchronous; faster
and simpler in our usage), schema modeled in **Kysely**, durability assured
by a **Litestream** sidecar continuously replicating the WAL to local disk
and (optionally) S3.

## Alternatives considered

- **Postgres** — overkill for one box. Adds a second process, an auth model,
  a network listener, a tuning surface, a backup story. We may need it in
  multi-tenant land (post-1.0); the Kysely abstraction means the swap is
  mechanical.
- **DuckDB** — analytical, not OLTP. Wrong tool.
- **Plain JSON files / LMDB** — losing transactions in 2026 is not a thing
  we want to do.
- **MySQL/MariaDB** — same downsides as Postgres without the upsides.

## Consequences

- Database is a *file*. Backups, snapshots, copying for inspection — all
  trivial.
- Litestream lets us recover to any point in the last N hours (configurable).
  RPO ≈ 1 second, RTO ≈ "restart with the restored file".
- `better-sqlite3` is **synchronous**, which means we never need to reason
  about a write-vs-read race within a single process. Multi-process write
  safety is handled by SQLite's own WAL locking.
- We forgo connection pooling decisions, replication topology, and a long
  tail of "did the migration apply on the right replica?" bugs.
- We accept one writer at a time. Our peak write load is ~3 orders of
  magnitude below SQLite's WAL write throughput.

## Reversal cost

Medium. The Kysely query layer means a Postgres swap rewrites adapter
internals, not call sites. Migrations are the cost: SQLite's permissive type
system means a few patterns (e.g. `INTEGER` for booleans) need rewriting
when moving to a stricter system.
