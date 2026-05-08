import {
  type Clock,
  type ReviewEvent,
  type ReviewEventKind,
  type ReviewEventRepo,
  type ReviewRunId,
  asReviewRunId,
  parseIso,
} from '@gcr/core';
import type { Kysely } from 'kysely';
import type { DB } from '../schema.js';

/**
 * Append-only event log per review run.
 *
 * `seq` is computed inside a transaction as `(MAX(seq) WHERE
 * review_run_id=?) + 1`. SQLite WAL serializes writes per database, so two
 * concurrent appenders for the same run can't both win the same sequence
 * number — the UNIQUE(review_run_id, seq) constraint catches it as a
 * defense-in-depth, and our retry loop bumps and retries once if it fires.
 */
export class ReviewEventRepository implements ReviewEventRepo {
  constructor(
    private readonly db: Kysely<DB>,
    // Clock is not used for `at` (the SQL DEFAULT does that) but is wired
    // for symmetry with the other repos in case we add caller-supplied
    // timestamps for replay later.
    private readonly _clock: Clock,
  ) {}

  async append(input: {
    reviewRunId: ReviewRunId;
    kind: ReviewEventKind;
    payload: Record<string, unknown>;
  }): Promise<{ seq: number }> {
    const payloadJson = safeStringify(input.payload);

    // Try up to 3 times: on UNIQUE collision (rare race), recompute seq.
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const seq = await this.db.transaction().execute(async (tx) => {
          const row = await tx
            .selectFrom('review_events')
            .select((eb) => eb.fn.max<number>('seq').as('m'))
            .where('review_run_id', '=', input.reviewRunId as number)
            .executeTakeFirst();
          const next = (row?.m ?? 0) + 1;
          await tx
            .insertInto('review_events')
            .values({
              review_run_id: input.reviewRunId as number,
              seq: next,
              kind: input.kind,
              payload_json: payloadJson,
            })
            .execute();
          return next;
        });
        return { seq };
      } catch (err) {
        lastErr = err;
        // SQLite UNIQUE constraint violation surfaces with this code in
        // better-sqlite3. Other errors propagate up immediately.
        const msg = err instanceof Error ? err.message : String(err);
        if (!/UNIQUE constraint failed/.test(msg)) throw err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('append: unknown failure');
  }

  async listForRun(input: {
    reviewRunId: ReviewRunId;
    since?: number;
    limit?: number;
  }): Promise<ReviewEvent[]> {
    let q = this.db
      .selectFrom('review_events')
      .selectAll()
      .where('review_run_id', '=', input.reviewRunId as number)
      .orderBy('seq');
    if (input.since !== undefined) q = q.where('seq', '>', input.since);
    if (input.limit !== undefined) q = q.limit(input.limit);
    const rows = await q.execute();
    return rows.map((r) => ({
      id: r.id,
      reviewRunId: asReviewRunId(r.review_run_id),
      seq: r.seq,
      at: parseIso(r.at),
      kind: r.kind,
      payload: JSON.parse(r.payload_json) as Record<string, unknown>,
    }));
  }
}

/**
 * Defensive JSON stringify: caps payload size, drops un-serializable
 * values. The driver passes objects that may contain circular refs (rare)
 * or deeply nested SDK shapes — better to truncate than to crash the
 * reviewer because of a noisy event we couldn't store.
 */
function safeStringify(payload: Record<string, unknown>): string {
  const MAX = 64 * 1024;
  let json: string;
  try {
    json = JSON.stringify(payload);
  } catch {
    json = JSON.stringify({ __unserializable: true, hint: Object.keys(payload).join(',') });
  }
  if (json.length > MAX) {
    json = JSON.stringify({
      __truncated: true,
      original_length: json.length,
      preview: json.slice(0, MAX - 200),
    });
  }
  return json;
}
