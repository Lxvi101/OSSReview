import type {
  GithubReviewId,
  IdempotencyKey,
  PullRequestId,
  ReviewRunId,
} from '../ids.js';
import type { IsoTimestamp } from '../time.js';
import { type ReviewRunState, assertTransition, isTerminal } from './state.js';

/** What caused the run to be created. */
export type ReviewRunTrigger = 'auto' | 'mention' | 'manual';

/** Pure data — the persisted shape of a `ReviewRun`. Repositories produce/accept this. */
export interface ReviewRun {
  readonly id: ReviewRunId;
  readonly pullRequestId: PullRequestId;
  readonly idempotencyKey: IdempotencyKey;
  readonly trigger: ReviewRunTrigger;
  readonly triggeredBy: string | null;
  readonly state: ReviewRunState;
  readonly stateReason: string | null;
  readonly attempts: number;
  readonly headSha: string;
  readonly reviewerName: string;
  readonly reviewerVersion: string | null;
  readonly model: string | null;
  /** Cost in micro-dollars (USD * 1_000_000). Integer math, no floats for money. */
  readonly costUsdMicros: number | null;
  readonly durationMs: number | null;
  readonly githubReviewId: GithubReviewId | null;
  readonly errorClass: string | null;
  readonly errorMessage: string | null;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/** Input used by the repository to create a fresh run. */
export interface NewReviewRun {
  readonly pullRequestId: PullRequestId;
  readonly idempotencyKey: IdempotencyKey;
  readonly trigger: ReviewRunTrigger;
  readonly triggeredBy: string | null;
  readonly headSha: string;
  readonly reviewerName: string;
}

/** Patch a transition produces. The repository is what writes it. */
export interface ReviewRunTransition {
  readonly state: ReviewRunState;
  readonly stateReason?: string | null;
  readonly reviewerVersion?: string | null;
  readonly model?: string | null;
  readonly costUsdMicros?: number | null;
  readonly durationMs?: number | null;
  readonly githubReviewId?: GithubReviewId | null;
  readonly errorClass?: string | null;
  readonly errorMessage?: string | null;
  readonly attemptsIncrement?: boolean;
}

/**
 * Compute the next-state patch for a run. Throws on illegal transitions.
 * Pure function — does not write anywhere. The repository writes.
 */
export function planTransition(
  current: ReviewRun,
  to: ReviewRunState,
  patch: Omit<ReviewRunTransition, 'state'> = {},
): ReviewRunTransition {
  assertTransition(current.state, to);
  return { state: to, ...patch };
}

export function isReviewRunTerminal(r: Pick<ReviewRun, 'state'>): boolean {
  return isTerminal(r.state);
}

/**
 * True if this run shouldn't be re-driven by the handler.
 *
 * Includes:
 *   - `completed` / `posting`: already produced (or producing) a successful result.
 *   - `failed` / `cancelled`: terminal states. The state machine forbids any
 *     further transition out of them, so trying to drive again would just
 *     throw `IllegalStateTransitionError`. The user retries by mentioning
 *     again — that creates a new run with a fresh idempotency key.
 *
 * The queue's job-level retry will hit this guard on every retry of a
 * failed run; we return early and the job ends cleanly, even though the
 * underlying review remains in `failed`. That's correct: job success
 * means "the handler ran and decided what to do", not "the review succeeded".
 */
export function isResolved(r: Pick<ReviewRun, 'state'>): boolean {
  return (
    r.state === 'completed' ||
    r.state === 'posting' ||
    r.state === 'failed' ||
    r.state === 'cancelled'
  );
}
