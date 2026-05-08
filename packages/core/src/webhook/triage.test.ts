import { describe, expect, it } from 'vitest';
import { mentionsBot, triage } from './triage.js';

const BOT = 'gcr-bot';

describe('mentionsBot', () => {
  it('detects a leading mention', () => {
    expect(mentionsBot('@gcr-bot please re-review', BOT)).toBe(true);
  });
  it('detects a mention after whitespace', () => {
    expect(mentionsBot('hey @gcr-bot please look', BOT)).toBe(true);
  });
  it('is case-insensitive on login', () => {
    expect(mentionsBot('@GCR-BOT please', BOT)).toBe(true);
  });
  it('rejects substring matches', () => {
    expect(mentionsBot('email@gcr-bot-fake.example', BOT)).toBe(false);
    expect(mentionsBot('@gcr-bot-extended please', BOT)).toBe(false);
  });
  it('rejects empty input', () => {
    expect(mentionsBot('', BOT)).toBe(false);
  });

  it('strips [bot] suffix from the stored login', () => {
    // The settings table holds the login as `<slug>[bot]` (matching GitHub's
    // API responses), but `@`-mentions use the bare slug. The function must
    // accept the stored form and match against the bare-slug user-typed form.
    expect(mentionsBot('@gcr-bot-demo please re-review', 'gcr-bot-demo[bot]')).toBe(true);
    expect(mentionsBot('hey @gcr-bot-demo', 'gcr-bot-demo[bot]')).toBe(true);
    // `[` is a valid char after the handle (it's not a word char), so the
    // literal `@gcr-bot-demo[bot]` form ALSO matches — that's fine, the user
    // is clearly trying to mention the bot.
    expect(mentionsBot('@gcr-bot-demo[bot] please', 'gcr-bot-demo[bot]')).toBe(true);
  });
});

describe('triage', () => {
  const base = { botLogin: BOT, payload: {} };

  it('ignores ping', () => {
    expect(triage({ ...base, event: 'ping', action: null })).toEqual({
      kind: 'ignore',
      reason: 'ping',
    });
  });

  it('enqueues review on pull_request.opened', () => {
    expect(
      triage({
        ...base,
        event: 'pull_request',
        action: 'opened',
        payload: { pull_request: { draft: false } },
      }),
    ).toEqual({ kind: 'enqueue_review', reason: 'pull_request_event' });
  });

  it('ignores draft PRs unless ready_for_review', () => {
    expect(
      triage({
        ...base,
        event: 'pull_request',
        action: 'opened',
        payload: { pull_request: { draft: true } },
      }),
    ).toEqual({ kind: 'ignore', reason: 'draft_pr' });

    expect(
      triage({
        ...base,
        event: 'pull_request',
        action: 'ready_for_review',
        payload: { pull_request: { draft: false } },
      }),
    ).toEqual({ kind: 'enqueue_review', reason: 'pull_request_event' });
  });

  it('detects @-mention on PR comments', () => {
    expect(
      triage({
        ...base,
        event: 'issue_comment',
        action: 'created',
        payload: {
          issue: { pull_request: { url: 'https://api.github.com/...' } },
          comment: { body: 'hey @gcr-bot can you re-review?', user: { login: 'someone' } },
        },
      }),
    ).toEqual({ kind: 'enqueue_mention_review', reason: 'issue_comment_mention' });
  });

  it('ignores comments on issues (not PRs)', () => {
    expect(
      triage({
        ...base,
        event: 'issue_comment',
        action: 'created',
        payload: { issue: {}, comment: { body: '@gcr-bot' } },
      }),
    ).toEqual({ kind: 'ignore', reason: 'issue_comment_on_issue_not_pr' });
  });

  it('ignores self-mentions to prevent loops', () => {
    expect(
      triage({
        ...base,
        event: 'issue_comment',
        action: 'created',
        payload: {
          issue: { pull_request: {} },
          comment: { body: '@gcr-bot here is my review', user: { login: BOT } },
        },
      }),
    ).toEqual({ kind: 'ignore', reason: 'self_mention' });
  });

  it('routes installation events to install_repos', () => {
    expect(triage({ ...base, event: 'installation', action: 'created' }).kind).toBe(
      'install_repos',
    );
    expect(triage({ ...base, event: 'installation_repositories', action: 'added' }).kind).toBe(
      'install_repos',
    );
  });
});
