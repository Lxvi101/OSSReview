import type {
  GithubCommentId,
  GithubInstallationId,
  GithubPrNumber,
  GithubReviewId,
} from '../ids.js';

/**
 * The minimum GitHub surface the domain knows about.
 *
 * Implemented by `@gcr/github` using `@octokit/*`. Anything Octokit-shaped
 * (RequestError, ResponseHeaders, etc.) MUST stay inside the adapter; the
 * domain receives plain shapes.
 */

export interface InstallationToken {
  readonly token: string;
  readonly expiresAt: string; // ISO
}

export interface PostReviewInput {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: GithubPrNumber;
  readonly headSha: string;
  readonly summaryBody: string;
  readonly verdict: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  readonly inlineComments: ReadonlyArray<{
    readonly path: string;
    readonly line: number;
    readonly body: string;
  }>;
}

export interface PostedReview {
  readonly githubReviewId: GithubReviewId;
  readonly inlineCommentIds: ReadonlyArray<GithubCommentId>;
}

/**
 * A snapshot of a PR's mutable fields. Used by the mention handler because
 * `issue_comment` payloads do not carry head/base SHAs.
 */
export interface PullRequestSnapshot {
  readonly headSha: string;
  readonly baseSha: string;
  readonly title: string;
  readonly body: string;
  readonly authorLogin: string;
  readonly isDraft: boolean;
}

export interface GithubAppClient {
  /** Cached, refreshed before expiry. Implementation handles the JWT exchange. */
  installationToken(installationId: GithubInstallationId): Promise<InstallationToken>;

  /** Fetch a PR snapshot. */
  getPullRequest(input: {
    token: InstallationToken;
    owner: string;
    repo: string;
    prNumber: GithubPrNumber;
  }): Promise<PullRequestSnapshot>;

  /**
   * The repos this installation token can currently access. Authoritative —
   * use this to reconcile when GitHub's webhook delivery missed something
   * (e.g. revokes from "All repositories" mode often don't fire a webhook).
   * Paginates internally.
   */
  listInstallationRepositories(token: InstallationToken): Promise<
    ReadonlyArray<{
      readonly githubRepoId: number;
      readonly owner: string;
      readonly name: string;
    }>
  >;

  /**
   * Clone the head into a clean directory and return it. `.git` MUST be
   * removed before the workspace is handed to a reviewer provider.
   */
  cloneHead(input: {
    token: InstallationToken;
    owner: string;
    repo: string;
    headSha: string;
    /** Absolute path to a directory the implementation may create. */
    targetDir: string;
  }): Promise<{ workspaceDir: string }>;

  fetchDiff(input: {
    token: InstallationToken;
    owner: string;
    repo: string;
    base: string;
    head: string;
  }): Promise<string>;

  postReview(input: PostReviewInput, token: InstallationToken): Promise<PostedReview>;

  /** For mention handler: react with eyes immediately so the user sees acknowledgement. */
  reactToComment(input: {
    token: InstallationToken;
    owner: string;
    repo: string;
    commentId: GithubCommentId;
    content: 'eyes' | '+1' | 'rocket' | 'confused';
  }): Promise<void>;

  /** Find an existing bot review by its embedded marker comment, for resume. */
  findExistingReview(input: {
    token: InstallationToken;
    owner: string;
    repo: string;
    prNumber: GithubPrNumber;
    marker: string;
  }): Promise<{ githubReviewId: GithubReviewId } | null>;
}
