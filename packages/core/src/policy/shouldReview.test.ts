import { describe, expect, it } from 'vitest';
import { shouldReview } from './shouldReview.js';

const repo = { enabled: true, settings: {} };
const pr = { isDraft: false, authorLogin: 'alice' };

describe('shouldReview', () => {
  it('reviews enabled, non-draft, normal-author PRs', () => {
    expect(shouldReview({ repo, pr, trigger: 'auto' })).toEqual({ review: true });
  });

  it('skips disabled repos', () => {
    expect(shouldReview({ repo: { ...repo, enabled: false }, pr, trigger: 'auto' })).toEqual({
      review: false,
      reason: 'repo_disabled',
    });
  });

  it('skips drafts on auto by default', () => {
    expect(shouldReview({ repo, pr: { ...pr, isDraft: true }, trigger: 'auto' })).toEqual({
      review: false,
      reason: 'draft_pr',
    });
  });

  it('reviews drafts when skipDrafts=false', () => {
    expect(
      shouldReview({
        repo: { ...repo, settings: { skipDrafts: false } },
        pr: { ...pr, isDraft: true },
        trigger: 'auto',
      }),
    ).toEqual({ review: true });
  });

  it('mentions bypass draft skip', () => {
    expect(shouldReview({ repo, pr: { ...pr, isDraft: true }, trigger: 'mention' })).toEqual({
      review: true,
    });
  });

  it('skips configured author logins', () => {
    const decision = shouldReview({
      repo,
      pr,
      trigger: 'auto',
      skipAuthorLogins: ['alice'],
    });
    expect(decision).toEqual({ review: false, reason: 'author_skipped:alice' });
  });
});
