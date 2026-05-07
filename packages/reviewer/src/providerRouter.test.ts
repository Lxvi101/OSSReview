import { describe, expect, it } from 'vitest';
import type { ReviewResult, Reviewer, ReviewerInput } from './port.js';
import { ProviderRouterReviewer } from './providerRouter.js';

const result = (reviewerName: string): ReviewResult => ({
  summary: { body: 'ok', verdict: 'comment' },
  findings: [],
  meta: { reviewerName, reviewerVersion: 'test', durationMs: 1 },
});

const input = (reviewerProvider?: 'claude' | 'codex'): ReviewerInput => ({
  workspaceDir: '/tmp/workspace',
  diff: '',
  pr: {
    owner: 'acme',
    repo: 'widgets',
    number: 1,
    title: 'Test',
    description: '',
    authorLogin: 'octocat',
    headSha: 'head',
    baseSha: 'base',
  },
  settings: {
    ...(reviewerProvider !== undefined ? { reviewerProvider } : {}),
  },
  signal: new AbortController().signal,
});

function fakeReviewer(name: string): Reviewer {
  return {
    name,
    version: 'test',
    async review() {
      return result(name);
    },
  };
}

describe('ProviderRouterReviewer', () => {
  it('uses the default provider when input has no override', async () => {
    const router = new ProviderRouterReviewer({
      defaultProvider: 'claude',
      claude: fakeReviewer('claude'),
      codex: fakeReviewer('codex'),
    });

    await expect(router.review(input())).resolves.toMatchObject({
      meta: { reviewerName: 'claude' },
    });
  });

  it('uses the per-review provider override', async () => {
    const router = new ProviderRouterReviewer({
      defaultProvider: 'claude',
      claude: fakeReviewer('claude'),
      codex: fakeReviewer('codex'),
    });

    await expect(router.review(input('codex'))).resolves.toMatchObject({
      meta: { reviewerName: 'codex' },
    });
  });
});
