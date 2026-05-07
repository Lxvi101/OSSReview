import {
  type Clock,
  type GithubReviewId,
  IllegalStateTransitionError,
  type IdempotencyKey,
  type NewReviewRun,
  type PersistedReviewComment,
  type PullRequestId,
  type ReviewRun,
  type ReviewRunId,
  type ReviewRunRepo,
  type ReviewRunTransition,
  asGithubReviewId,
  asIdempotencyKey,
  asPullRequestId,
  asReviewCommentId,
  asReviewRunId,
  parseIso,
} from '@gcr/core';
import type { Kysely, Selectable } from 'kysely';
import type { DB, ReviewRunsTable } from '../schema.js';

type ReviewRunRow = Selectable<ReviewRunsTable>;

export class ReviewRunRepository implements ReviewRunRepo {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly clock: Clock,
  ) {}

  /**
   * Idempotent upsert. Two webhook redeliveries call this concurrently — one
   * gets `created=true`, the other `created=false` and the existing row.
   */
  async upsertByIdempotency(input: NewReviewRun): Promise<{ run: ReviewRun; created: boolean }> {
    const now = this.clock.now();

    const insert = await this.db
      .insertInto('review_runs')
      .values({
        pull_request_id: input.pullRequestId as number,
        idempotency_key: input.idempotencyKey as string,
        trigger: input.trigger,
        triggered_by: input.triggeredBy,
        state: 'queued',
        head_sha: input.headSha,
        reviewer_name: input.reviewerName,
        attempts: 0,
        updated_at: now,
      })
      .onConflict((oc) => oc.column('idempotency_key').doNothing())
      .executeTakeFirst();

    const row = await this.db
      .selectFrom('review_runs')
      .selectAll()
      .where('idempotency_key', '=', input.idempotencyKey as string)
      .executeTakeFirstOrThrow();

    return { run: this.toDomain(row), created: (insert.numInsertedOrUpdatedRows ?? 0n) > 0n };
  }

  async byId(id: ReviewRunId): Promise<ReviewRun | null> {
    const row = await this.db
      .selectFrom('review_runs')
      .selectAll()
      .where('id', '=', id as number)
      .executeTakeFirst();
    return row ? this.toDomain(row) : null;
  }

  async byIdempotencyKey(key: IdempotencyKey): Promise<ReviewRun | null> {
    const row = await this.db
      .selectFrom('review_runs')
      .selectAll()
      .where('idempotency_key', '=', key as string)
      .executeTakeFirst();
    return row ? this.toDomain(row) : null;
  }

  /**
   * Apply a transition with optimistic locking on `state`. If the row's
   * current state does not match `expectedFromState`, the update affects 0
   * rows and we throw `IllegalStateTransitionError`. This is what stops two
   * workers from both stepping the same run forward.
   */
  async transition(
    id: ReviewRunId,
    expectedFromState: string,
    patch: ReviewRunTransition,
  ): Promise<ReviewRun> {
    const now = this.clock.now();

    let q = this.db.updateTable('review_runs').set({ state: patch.state, updated_at: now });
    if (patch.stateReason !== undefined) q = q.set({ state_reason: patch.stateReason });
    if (patch.reviewerVersion !== undefined) q = q.set({ reviewer_version: patch.reviewerVersion });
    if (patch.model !== undefined) q = q.set({ model: patch.model });
    if (patch.costUsdMicros !== undefined) q = q.set({ cost_usd_micros: patch.costUsdMicros });
    if (patch.durationMs !== undefined) q = q.set({ duration_ms: patch.durationMs });
    if (patch.githubReviewId !== undefined)
      q = q.set({ github_review_id: patch.githubReviewId as number | null });
    if (patch.errorClass !== undefined) q = q.set({ error_class: patch.errorClass });
    if (patch.errorMessage !== undefined) q = q.set({ error_message: patch.errorMessage });
    if (patch.attemptsIncrement) {
      q = q.set((eb) => ({ attempts: eb('attempts', '+', 1) }));
    }

    const result = await q
      .where('id', '=', id as number)
      .where('state', '=', expectedFromState as ReviewRunsTable['state'])
      .executeTakeFirst();

    if ((result.numUpdatedRows ?? 0n) === 0n) {
      const current = await this.byId(id);
      throw new IllegalStateTransitionError(current?.state ?? 'unknown', patch.state);
    }

    return (await this.byId(id))!;
  }

  async recent(opts: { limit?: number; pullRequestId?: PullRequestId } = {}): Promise<ReviewRun[]> {
    let q = this.db
      .selectFrom('review_runs')
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(opts.limit ?? 50);
    if (opts.pullRequestId !== undefined)
      q = q.where('pull_request_id', '=', opts.pullRequestId as number);
    const rows = await q.execute();
    return rows.map((r) => this.toDomain(r));
  }

  async findNonTerminal(): Promise<ReviewRun[]> {
    const rows = await this.db
      .selectFrom('review_runs')
      .selectAll()
      .where('state', 'in', ['queued', 'preparing', 'fetching', 'reviewing', 'posting'])
      .execute();
    return rows.map((r) => this.toDomain(r));
  }

  async countMentionRunsForHead(pullRequestId: PullRequestId, headSha: string): Promise<number> {
    const row = await this.db
      .selectFrom('review_runs')
      .select((eb) => eb.fn.count<number>('id').as('n'))
      .where('pull_request_id', '=', pullRequestId as number)
      .where('head_sha', '=', headSha)
      .where('trigger', '=', 'mention')
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  async sumCostMicrosSince(sinceIso: string): Promise<number> {
    const row = await this.db
      .selectFrom('review_runs')
      .select((eb) => eb.fn.sum<number>('cost_usd_micros').as('total'))
      .where('updated_at', '>=', sinceIso)
      .where('state', '=', 'completed')
      .executeTakeFirst();
    return Number(row?.total ?? 0);
  }

  async saveComments(
    runId: ReviewRunId,
    comments: ReadonlyArray<{
      filePath: string;
      lineStart?: number | null;
      lineEnd?: number | null;
      severity: 'blocker' | 'warning' | 'suggestion' | 'nit' | 'praise';
      body: string;
      suggestion?: string | null;
      githubCommentId?: number | null;
      postedAt?: string | null;
    }>,
  ): Promise<void> {
    if (comments.length === 0) return;
    await this.db
      .insertInto('review_comments')
      .values(
        comments.map((c) => ({
          review_run_id: runId as number,
          file_path: c.filePath,
          line_start: c.lineStart ?? null,
          line_end: c.lineEnd ?? null,
          severity: c.severity,
          body: c.body,
          suggestion: c.suggestion ?? null,
          github_comment_id: c.githubCommentId ?? null,
          posted_at: c.postedAt ?? null,
        })),
      )
      .execute();
  }

  async listComments(runId: ReviewRunId): Promise<PersistedReviewComment[]> {
    const rows = await this.db
      .selectFrom('review_comments')
      .selectAll()
      .where('review_run_id', '=', runId as number)
      .orderBy('id')
      .execute();
    return rows.map((r) => ({
      id: asReviewCommentId(r.id),
      reviewRunId: asReviewRunId(r.review_run_id),
      filePath: r.file_path,
      lineStart: r.line_start,
      lineEnd: r.line_end,
      severity: r.severity,
      body: r.body,
      suggestion: r.suggestion,
      githubCommentId: r.github_comment_id,
      postedAt: r.posted_at,
    }));
  }

  private toDomain(row: ReviewRunRow): ReviewRun {
    return {
      id: asReviewRunId(row.id),
      pullRequestId: asPullRequestId(row.pull_request_id),
      idempotencyKey: asIdempotencyKey(row.idempotency_key),
      trigger: row.trigger,
      triggeredBy: row.triggered_by,
      state: row.state,
      stateReason: row.state_reason,
      attempts: row.attempts,
      headSha: row.head_sha,
      reviewerName: row.reviewer_name,
      reviewerVersion: row.reviewer_version,
      model: row.model,
      costUsdMicros: row.cost_usd_micros,
      durationMs: row.duration_ms,
      githubReviewId: row.github_review_id != null ? asGithubReviewId(row.github_review_id) : null,
      errorClass: row.error_class,
      errorMessage: row.error_message,
      createdAt: parseIso(row.created_at),
      updatedAt: parseIso(row.updated_at),
    };
  }
}
