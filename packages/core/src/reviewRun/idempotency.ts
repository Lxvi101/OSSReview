import type { GithubCommentId, GithubPrNumber, IdempotencyKey, RepositoryId } from '../ids.js';
import { asIdempotencyKey } from '../ids.js';

/**
 * Idempotency key generation.
 *
 * Two flavors:
 *   - `auto:{repo}:{pr}:{head_sha}` — webhook-triggered review of a specific SHA.
 *     A redelivery of the same `synchronize` event collides; a new push (new SHA)
 *     produces a new key, which is what coalescing is built on.
 *   - `mention:{comment_id}` — explicitly requested by `@`-mention.
 *     A redelivery of the same comment webhook collides; the user editing the
 *     comment doesn't change the comment id.
 */

export function autoIdempotencyKey(
  repoId: RepositoryId,
  pr: GithubPrNumber,
  headSha: string,
): IdempotencyKey {
  return asIdempotencyKey(`auto:${repoId}:${pr}:${headSha}`);
}

export function mentionIdempotencyKey(commentId: GithubCommentId): IdempotencyKey {
  return asIdempotencyKey(`mention:${commentId}`);
}

export function manualIdempotencyKey(
  repoId: RepositoryId,
  pr: GithubPrNumber,
  headSha: string,
  nonce: string,
): IdempotencyKey {
  return asIdempotencyKey(`manual:${repoId}:${pr}:${headSha}:${nonce}`);
}
