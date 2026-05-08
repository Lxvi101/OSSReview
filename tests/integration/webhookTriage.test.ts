import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { triage } from '@gcr/core';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, '..', 'fixtures', 'webhooks');

interface FixtureCase {
  readonly file: string;
  readonly event: string;
  readonly action: string | null;
  readonly expectedKind: string;
}

const CASES: FixtureCase[] = [
  {
    file: 'pull_request.opened.json',
    event: 'pull_request',
    action: 'opened',
    expectedKind: 'enqueue_review',
  },
  {
    file: 'pull_request.synchronize.json',
    event: 'pull_request',
    action: 'synchronize',
    expectedKind: 'enqueue_review',
  },
  {
    file: 'pull_request.draft.json',
    event: 'pull_request',
    action: 'opened',
    expectedKind: 'ignore',
  },
  {
    file: 'issue_comment.created.mention.json',
    event: 'issue_comment',
    action: 'created',
    expectedKind: 'enqueue_mention_review',
  },
  {
    file: 'issue_comment.created.no_mention.json',
    event: 'issue_comment',
    action: 'created',
    expectedKind: 'ignore',
  },
  {
    file: 'installation.created.json',
    event: 'installation',
    action: 'created',
    expectedKind: 'install_repos',
  },
  { file: 'ping.json', event: 'ping', action: null, expectedKind: 'ignore' },
];

describe('webhook triage against fixture corpus', () => {
  // Sanity: the corpus matches what we declared.
  it('every fixture file is covered', () => {
    const onDisk = readdirSync(FIXTURES).filter((f) => f.endsWith('.json'));
    const declared = new Set(CASES.map((c) => c.file));
    for (const f of onDisk) expect(declared.has(f)).toBe(true);
  });

  for (const c of CASES) {
    it(`${c.file} → ${c.expectedKind}`, () => {
      const payload = JSON.parse(readFileSync(join(FIXTURES, c.file), 'utf8'));
      const decision = triage({ event: c.event, action: c.action, payload, botLogin: 'gcr-bot' });
      expect(decision.kind).toBe(c.expectedKind);
    });
  }
});
