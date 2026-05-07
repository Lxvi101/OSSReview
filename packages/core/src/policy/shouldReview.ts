import type { PullRequest } from '../pullRequest/aggregate.js';
import type { Repository } from '../repository/aggregate.js';
import type { ReviewRunTrigger } from '../reviewRun/aggregate.js';

/**
 * Pure policy: should the bot review this PR right now?
 *
 * Reasons are stable, machine-readable strings that we surface in audit and UI.
 */

export type PolicyDecision = { review: true } | { review: false; reason: string };

export interface PolicyInput {
  readonly repo: Pick<Repository, 'enabled' | 'settings'>;
  readonly pr: Pick<PullRequest, 'isDraft' | 'authorLogin'>;
  readonly trigger: ReviewRunTrigger;
  /**
   * Logins to never review (e.g. the bot itself, or other bots that produce
   * noise on the PR). Empty by default.
   */
  readonly skipAuthorLogins?: readonly string[];
}

export function shouldReview(input: PolicyInput): PolicyDecision {
  const { repo, pr, trigger, skipAuthorLogins = [] } = input;

  if (!repo.enabled) return { review: false, reason: 'repo_disabled' };

  // Mentions explicitly request review — they bypass draft and author skips
  // (writers can comment for a reason; respect that).
  if (trigger !== 'mention') {
    const skipDrafts = repo.settings.skipDrafts ?? true;
    if (pr.isDraft && skipDrafts) return { review: false, reason: 'draft_pr' };
    if (skipAuthorLogins.includes(pr.authorLogin)) {
      return { review: false, reason: `author_skipped:${pr.authorLogin}` };
    }
  }

  return { review: true };
}
