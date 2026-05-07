import type { Clock } from '@gcr/core';
import type { DB } from '@gcr/storage';
import type { Kysely, Transaction } from 'kysely';
import type { EnqueueInput, Job } from './types.js';

/**
 * Durable job queue on SQLite.
 *
 * Picking semantics:
 *   - workers poll: `SELECT ... WHERE state='queued' AND run_after<=now ORDER BY priority DESC, id LIMIT 1`
 *   - mark `state='running', locked_by=workerId, locked_at=now` in same tx
 *   - SQLite WAL handles writer serialization
 *
 * Why hand-rolled: BullMQ requires Redis (a second moving part); pg-boss is
 * Postgres-only. ~300 lines on the database we already have is the right
 * trade-off for a small single-tenant app. (See ADR 0004.)
 */
export class JobQueue {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly clock: Clock,
  ) {}

  /**
   * Enqueue inside an externally-controlled transaction. This is the variant
   * the webhook handler uses so that the WebhookDelivery row and the Job row
   * land atomically. Returns the (existing or new) job id.
   */
  async enqueueIn<TName extends string, TData>(
    tx: Transaction<DB>,
    input: EnqueueInput<TName, TData>,
  ): Promise<{ id: number; created: boolean }> {
    const result = await tx
      .insertInto('jobs')
      .values({
        name: input.name,
        data_json: JSON.stringify(input.data),
        state: 'queued',
        unique_key: input.uniqueKey ?? null,
        attempts: 0,
        max_attempts: input.maxAttempts ?? 5,
        priority: input.priority ?? 0,
        run_after: input.runAfter ?? this.clock.now(),
      })
      .onConflict((oc) => oc.column('unique_key').doNothing())
      .executeTakeFirst();

    if ((result.numInsertedOrUpdatedRows ?? 0n) > 0n && result.insertId !== undefined) {
      return { id: Number(result.insertId), created: true };
    }
    // Fetch the existing one by unique_key.
    if (input.uniqueKey) {
      const existing = await tx
        .selectFrom('jobs')
        .select('id')
        .where('unique_key', '=', input.uniqueKey)
        .executeTakeFirst();
      if (existing) return { id: existing.id, created: false };
    }
    throw new Error('enqueue failed and no unique_key to resolve');
  }

  /** Stand-alone enqueue (no caller-managed tx). */
  async enqueue<TName extends string, TData>(
    input: EnqueueInput<TName, TData>,
  ): Promise<{ id: number; created: boolean }> {
    return this.db.transaction().execute((tx) => this.enqueueIn(tx, input));
  }

  /**
   * Atomically pick one job and mark it running. Returns null if nothing's
   * ready. Implemented as a single transaction with optimistic update on
   * `state='queued'`.
   */
  async pickOne(workerId: string): Promise<Job | null> {
    return this.db.transaction().execute(async (tx) => {
      const candidate = await tx
        .selectFrom('jobs')
        .selectAll()
        .where('state', '=', 'queued')
        .where('run_after', '<=', this.clock.now())
        .orderBy('priority', 'desc')
        .orderBy('id')
        .limit(1)
        .executeTakeFirst();
      if (!candidate) return null;

      const claimed = await tx
        .updateTable('jobs')
        .set({ state: 'running', locked_by: workerId, locked_at: this.clock.now() })
        .where('id', '=', candidate.id)
        .where('state', '=', 'queued')
        .executeTakeFirst();

      if ((claimed.numUpdatedRows ?? 0n) === 0n) return null;
      return this.toDomain({ ...candidate, state: 'running', locked_by: workerId, locked_at: this.clock.now() });
    });
  }

  async markCompleted(id: number): Promise<void> {
    await this.db
      .updateTable('jobs')
      .set({
        state: 'completed',
        completed_at: this.clock.now(),
        locked_by: null,
        locked_at: null,
      })
      .where('id', '=', id)
      .execute();
  }

  /**
   * Schedule a retry with exponential backoff capped at 1h.
   * `attempts` is incremented; if it would exceed `max_attempts`, mark failed.
   */
  async markFailedOrRequeue(id: number, error: string): Promise<{ requeued: boolean }> {
    return this.db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom('jobs')
        .select(['attempts', 'max_attempts'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();

      const nextAttempts = row.attempts + 1;
      if (nextAttempts >= row.max_attempts) {
        await tx
          .updateTable('jobs')
          .set({
            state: 'failed',
            attempts: nextAttempts,
            last_error: error.slice(0, 8000),
            completed_at: this.clock.now(),
            locked_by: null,
            locked_at: null,
          })
          .where('id', '=', id)
          .execute();
        return { requeued: false };
      }

      const delaySec = Math.min(3600, 2 ** nextAttempts * 5);
      const runAfter = new Date(Date.now() + delaySec * 1000).toISOString();
      await tx
        .updateTable('jobs')
        .set({
          state: 'queued',
          attempts: nextAttempts,
          last_error: error.slice(0, 8000),
          run_after: runAfter,
          locked_by: null,
          locked_at: null,
        })
        .where('id', '=', id)
        .execute();
      return { requeued: true };
    });
  }

  /**
   * Sweep for stale locks. Any job in `running` whose `locked_at` is older
   * than `staleMs` is requeued (with the attempt counter NOT incremented —
   * the worker died, that's not the job's fault).
   *
   * Called periodically by the worker, and once at startup.
   */
  async releaseStaleLocks(staleMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - staleMs).toISOString();
    const result = await this.db
      .updateTable('jobs')
      .set({
        state: 'queued',
        locked_by: null,
        locked_at: null,
        run_after: this.clock.now(),
      })
      .where('state', '=', 'running')
      .where('locked_at', '<', cutoff)
      .execute();
    return Number(result.reduce((acc, r) => acc + (r.numUpdatedRows ?? 0n), 0n));
  }

  async dlqCount(name?: string): Promise<number> {
    let q = this.db
      .selectFrom('jobs')
      .select((eb) => eb.fn.count<number>('id').as('n'))
      .where('state', '=', 'failed');
    if (name) q = q.where('name', '=', name);
    const row = await q.executeTakeFirstOrThrow();
    return Number(row.n);
  }

  async byId(id: number): Promise<Job | null> {
    const row = await this.db
      .selectFrom('jobs')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? this.toDomain(row) : null;
  }

  /** For UI / DLQ list. */
  async list(opts: { state?: 'queued' | 'running' | 'completed' | 'failed'; limit?: number } = {}): Promise<Job[]> {
    let q = this.db.selectFrom('jobs').selectAll().orderBy('id', 'desc').limit(opts.limit ?? 50);
    if (opts.state) q = q.where('state', '=', opts.state);
    const rows = await q.execute();
    return rows.map((r) => this.toDomain(r));
  }

  private toDomain(row: {
    id: number;
    name: string;
    data_json: string;
    state: 'queued' | 'running' | 'completed' | 'failed';
    unique_key: string | null;
    attempts: number;
    max_attempts: number;
    priority: number;
    run_after: string;
    locked_by: string | null;
    locked_at: string | null;
    enqueued_at: string;
    completed_at: string | null;
    last_error: string | null;
  }): Job {
    return {
      id: row.id,
      name: row.name,
      data: JSON.parse(row.data_json),
      state: row.state,
      uniqueKey: row.unique_key,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      priority: row.priority,
      runAfter: row.run_after,
      lockedBy: row.locked_by,
      lockedAt: row.locked_at,
      enqueuedAt: row.enqueued_at,
      completedAt: row.completed_at,
      lastError: row.last_error,
    };
  }
}
