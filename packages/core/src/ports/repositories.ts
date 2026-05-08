import type {
  GithubInstallationId,
  GithubPrNumber,
  GithubRepoId,
  IdempotencyKey,
  PullRequestId,
  RepositoryId,
  ReviewCommentId,
  ReviewRunId,
} from '../ids.js';
import type { PullRequest } from '../pullRequest/aggregate.js';
import type { Repository, RepositorySettings } from '../repository/aggregate.js';
import type { NewReviewRun, ReviewRun, ReviewRunTransition } from '../reviewRun/aggregate.js';
import type { ReviewEvent } from '../reviewRun/event.js';

/**
 * Repository ports — implemented by `@gcr/storage`.
 *
 * Naming note: "Repository" here means the DDD pattern, NOT the GitHub
 * repository (the latter is `Repository` aggregate above). I am sorry. The
 * domain language overloads.
 */

export interface RepositoryRepo {
  upsertFromInstallation(input: {
    githubRepoId: GithubRepoId;
    owner: string;
    name: string;
    installationId: GithubInstallationId;
  }): Promise<Repository>;

  byId(id: RepositoryId): Promise<Repository | null>;
  byGithubId(id: GithubRepoId): Promise<Repository | null>;
  list(opts?: { enabled?: boolean; installationId?: GithubInstallationId }): Promise<Repository[]>;
  setEnabled(id: RepositoryId, enabled: boolean): Promise<void>;

  /**
   * Bulk enable/disable every repo belonging to a single installation.
   * Used by the installation-lifecycle webhook (uninstall, suspend,
   * unsuspend). Returns the number of rows affected.
   */
  setEnabledForInstallation(
    installationId: GithubInstallationId,
    enabled: boolean,
  ): Promise<number>;

  updateSettings(id: RepositoryId, patch: Partial<RepositorySettings>): Promise<void>;

  /**
   * Replace the entire settings JSON. Unlike `updateSettings` (merge),
   * fields absent from `next` become undefined. Used by the per-repo
   * settings form where the page IS the canonical source.
   */
  replaceSettings(id: RepositoryId, next: RepositorySettings): Promise<void>;
}

export interface PullRequestRepo {
  upsert(input: {
    repositoryId: RepositoryId;
    githubPrNumber: GithubPrNumber;
    headSha: string;
    baseSha: string;
    authorLogin: string;
    isDraft: boolean;
    title: string;
  }): Promise<PullRequest>;

  byId(id: PullRequestId): Promise<PullRequest | null>;
  byNumber(repositoryId: RepositoryId, n: GithubPrNumber): Promise<PullRequest | null>;
}

/** Pre-joined view of a failed run, for the error-log surface in the UI. */
export interface RecentFailure {
  readonly runId: ReviewRunId;
  readonly repoFullName: string;
  readonly prNumber: number | null;
  readonly state: 'failed' | 'cancelled';
  readonly errorClass: string | null;
  readonly errorMessage: string | null;
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A row from review_comments. Used for UI listing. */
export interface PersistedReviewComment {
  readonly id: ReviewCommentId;
  readonly reviewRunId: ReviewRunId;
  readonly filePath: string;
  readonly lineStart: number | null;
  readonly lineEnd: number | null;
  readonly severity: 'blocker' | 'warning' | 'suggestion' | 'nit' | 'praise';
  readonly body: string;
  readonly suggestion: string | null;
  readonly githubCommentId: number | null;
  readonly postedAt: string | null;
}

export interface ReviewRunRepo {
  /**
   * Create a new run if no row exists for this idempotency key, otherwise
   * return the existing row. The returned `created` flag tells the caller
   * which happened.
   *
   * Crucial for the worker handler: a redelivered webhook calls this and gets
   * the existing row back; it does NOT start a second review.
   */
  upsertByIdempotency(input: NewReviewRun): Promise<{ run: ReviewRun; created: boolean }>;

  byId(id: ReviewRunId): Promise<ReviewRun | null>;
  byIdempotencyKey(key: IdempotencyKey): Promise<ReviewRun | null>;

  /**
   * Apply a state transition. Implementations must verify the source state
   * (optimistic lock) so two workers can't both transition the same run.
   * Returns the new row.
   */
  transition(
    id: ReviewRunId,
    expectedFromState: string,
    patch: ReviewRunTransition,
  ): Promise<ReviewRun>;

  /** For UI / dashboard. Most recent first. */
  recent(opts?: { limit?: number; pullRequestId?: PullRequestId }): Promise<ReviewRun[]>;

  /** Used by worker startup to find runs that need resume. */
  findNonTerminal(): Promise<ReviewRun[]>;

  /**
   * How many mention-triggered runs already exist for a given PR's head SHA.
   * Drives the per-PR mention rate cap (see `checkMentionCap`).
   */
  countMentionRunsForHead(pullRequestId: PullRequestId, headSha: string): Promise<number>;

  /**
   * Mark a run for cancellation. The worker observes this on every transition
   * and aborts the in-flight SDK signal.
   */
  requestCancel(id: ReviewRunId): Promise<void>;

  /**
   * Recent failed runs across all repositories, for the dashboard error log.
   * Each row carries enough context to render without a join.
   */
  recentFailures(opts?: { limit?: number }): Promise<ReadonlyArray<RecentFailure>>;

  /**
   * Bulk-delete review runs (and their cascaded comments + events) older
   * than `cutoffIso`. Returns the number of runs deleted.
   */
  deleteOlderThan(cutoffIso: string): Promise<number>;

  /** Persist the comments of a completed run. */
  saveComments(
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
  ): Promise<void>;

  listComments(runId: ReviewRunId): Promise<PersistedReviewComment[]>;
}

export interface ReviewEventRepo {
  /**
   * Append a new event to the run's transcript. `seq` is assigned by the
   * implementation atomically (next-after-current-max for that run) so
   * concurrent appenders never collide.
   */
  append(input: {
    reviewRunId: ReviewRunId;
    kind:
      | 'phase'
      | 'assistant_text'
      | 'assistant_thinking'
      | 'tool_use'
      | 'tool_result'
      | 'sdk_status'
      | 'error';
    payload: Record<string, unknown>;
  }): Promise<{ seq: number }>;

  /**
   * List events for a run in chronological order. `since` is exclusive
   * (return events with `seq > since`) — that's what the HTMX poll loop
   * uses to fetch only-new events.
   */
  listForRun(input: {
    reviewRunId: ReviewRunId;
    since?: number;
    limit?: number;
  }): Promise<ReviewEvent[]>;
}

export interface WebhookDeliveryRecord {
  readonly deliveryId: string;
  readonly event: string;
  readonly action: string | null;
  readonly payloadJson: string;
  readonly receivedAt: string;
}

export interface WebhookDeliveryRepo {
  /**
   * INSERT ... ON CONFLICT DO NOTHING by deliveryId. Returns whether a new row
   * was created. The caller has already verified the signature.
   */
  recordIfNew(input: {
    deliveryId: string;
    event: string;
    action: string | null;
    signatureValid: boolean;
    payloadJson: string;
  }): Promise<{ created: boolean }>;

  markProcessed(deliveryId: string, outcome: string): Promise<void>;

  recentInvalidSignatureCount(sinceIso: string): Promise<number>;

  /** Read a delivery (with its verbatim payload). Used by the worker handler. */
  byDeliveryId(deliveryId: string): Promise<WebhookDeliveryRecord | null>;
}
