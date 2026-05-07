import type { Logger } from '@gcr/observability';

export type JobState = 'queued' | 'running' | 'completed' | 'failed';

export interface Job<TName extends string = string, TData = unknown> {
  readonly id: number;
  readonly name: TName;
  readonly data: TData;
  readonly state: JobState;
  readonly uniqueKey: string | null;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly priority: number;
  readonly runAfter: string;
  readonly lockedBy: string | null;
  readonly lockedAt: string | null;
  readonly enqueuedAt: string;
  readonly completedAt: string | null;
  readonly lastError: string | null;
}

export interface EnqueueInput<TName extends string = string, TData = unknown> {
  readonly name: TName;
  readonly data: TData;
  /** Globally unique key. Two enqueues with the same uniqueKey produce one job. */
  readonly uniqueKey?: string;
  readonly maxAttempts?: number;
  readonly priority?: number;
  /** Earliest run time. Defaults to "now". */
  readonly runAfter?: string;
}

export interface HandlerContext {
  readonly job: Job;
  readonly logger: Logger;
  readonly signal: AbortSignal;
}

/**
 * Throw `RetryableError` from `@gcr/core` to retry; throw any other error to
 * mark the job permanently failed; return normally to mark completed.
 */
export type Handler<TName extends string = string, TData = unknown> = (
  ctx: HandlerContext & { readonly job: Job<TName, TData> },
) => Promise<void>;
