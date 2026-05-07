import type { GithubPrNumber, PullRequestId, RepositoryId } from '../ids.js';
import type { IsoTimestamp } from '../time.js';

/**
 * `PullRequest` aggregate — a snapshot of a PR's metadata at last-seen time.
 *
 * `headSha` is the dimension that drives idempotency: a new push changes it.
 */
export interface PullRequest {
  readonly id: PullRequestId;
  readonly repositoryId: RepositoryId;
  readonly githubPrNumber: GithubPrNumber;
  readonly headSha: string;
  readonly baseSha: string;
  readonly authorLogin: string;
  readonly isDraft: boolean;
  readonly title: string;
  readonly lastSeenAt: IsoTimestamp;
}
