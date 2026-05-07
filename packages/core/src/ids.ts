/**
 * Branded identifier types.
 *
 * Why brands: a `ReviewRunId` and a `PullRequestId` are both numbers at runtime
 * but must never be interchanged at type level. Once a regression in 2029
 * accidentally swaps them you'll be glad of this file.
 *
 * The brand is structural and erased at runtime — no perf cost.
 */

declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

export type RepositoryId = Brand<number, 'RepositoryId'>;
export type PullRequestId = Brand<number, 'PullRequestId'>;
export type ReviewRunId = Brand<number, 'ReviewRunId'>;
export type ReviewCommentId = Brand<number, 'ReviewCommentId'>;
export type WebhookDeliveryId = Brand<number, 'WebhookDeliveryId'>;
export type JobId = Brand<number, 'JobId'>;
export type AuditEventId = Brand<number, 'AuditEventId'>;

export type GithubInstallationId = Brand<number, 'GithubInstallationId'>;
export type GithubRepoId = Brand<number, 'GithubRepoId'>;
export type GithubPrNumber = Brand<number, 'GithubPrNumber'>;
export type GithubReviewId = Brand<number, 'GithubReviewId'>;
export type GithubCommentId = Brand<number, 'GithubCommentId'>;

export type IdempotencyKey = Brand<string, 'IdempotencyKey'>;
export type DeliveryId = Brand<string, 'DeliveryId'>; // GitHub's X-GitHub-Delivery (UUID)

/** Lossless coercions — no runtime check beyond type-narrowing. */
export const asRepositoryId = (n: number): RepositoryId => n as RepositoryId;
export const asPullRequestId = (n: number): PullRequestId => n as PullRequestId;
export const asReviewRunId = (n: number): ReviewRunId => n as ReviewRunId;
export const asReviewCommentId = (n: number): ReviewCommentId => n as ReviewCommentId;
export const asWebhookDeliveryId = (n: number): WebhookDeliveryId => n as WebhookDeliveryId;
export const asJobId = (n: number): JobId => n as JobId;
export const asAuditEventId = (n: number): AuditEventId => n as AuditEventId;
export const asGithubInstallationId = (n: number): GithubInstallationId =>
  n as GithubInstallationId;
export const asGithubRepoId = (n: number): GithubRepoId => n as GithubRepoId;
export const asGithubPrNumber = (n: number): GithubPrNumber => n as GithubPrNumber;
export const asGithubReviewId = (n: number): GithubReviewId => n as GithubReviewId;
export const asGithubCommentId = (n: number): GithubCommentId => n as GithubCommentId;
export const asIdempotencyKey = (s: string): IdempotencyKey => s as IdempotencyKey;
export const asDeliveryId = (s: string): DeliveryId => s as DeliveryId;
