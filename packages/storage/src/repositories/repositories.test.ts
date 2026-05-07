import {
  asGithubInstallationId,
  asGithubPrNumber,
  asGithubRepoId,
  autoIdempotencyKey,
} from '@gcr/core';
import { FixedClock } from '@gcr/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DatabaseHandle, openDatabase } from '../db.js';
import { runMigrations } from '../migrations/run.js';
import { SecretBox } from '../secrets/secretBox.js';
import { type Repositories, makeRepositories } from './index.js';

const KEY = '0'.repeat(64);

describe('repositories (integration vs :memory: sqlite)', () => {
  let handle: DatabaseHandle;
  let repos: Repositories;
  const clock = new FixedClock('2026-01-15T12:00:00.000Z');

  beforeEach(() => {
    handle = openDatabase({ path: ':memory:' });
    runMigrations(handle);
    repos = makeRepositories(handle.kysely, { clock, secretBox: new SecretBox(KEY) });
  });

  afterEach(async () => {
    await handle.destroy();
  });

  it('upserts a repository by github_repo_id', async () => {
    const r1 = await repos.repositories.upsertFromInstallation({
      githubRepoId: asGithubRepoId(101),
      owner: 'acme',
      name: 'widgets',
      installationId: asGithubInstallationId(42),
    });
    const r2 = await repos.repositories.upsertFromInstallation({
      githubRepoId: asGithubRepoId(101),
      owner: 'acme',
      name: 'widgets-renamed',
      installationId: asGithubInstallationId(42),
    });
    expect(r1.id).toBe(r2.id);
    expect(r2.name).toBe('widgets-renamed');
  });

  it('upserts a PR keyed on (repository_id, pr_number)', async () => {
    const repo = await repos.repositories.upsertFromInstallation({
      githubRepoId: asGithubRepoId(101),
      owner: 'a',
      name: 'b',
      installationId: asGithubInstallationId(1),
    });
    const pr1 = await repos.pullRequests.upsert({
      repositoryId: repo.id,
      githubPrNumber: asGithubPrNumber(7),
      headSha: 'abc',
      baseSha: 'main',
      authorLogin: 'alice',
      isDraft: false,
      title: 'Initial',
    });
    const pr2 = await repos.pullRequests.upsert({
      repositoryId: repo.id,
      githubPrNumber: asGithubPrNumber(7),
      headSha: 'def',
      baseSha: 'main',
      authorLogin: 'alice',
      isDraft: true,
      title: 'Updated',
    });
    expect(pr1.id).toBe(pr2.id);
    expect(pr2.headSha).toBe('def');
    expect(pr2.isDraft).toBe(true);
  });

  it('upsertByIdempotency creates once, returns same row second time', async () => {
    const repo = await repos.repositories.upsertFromInstallation({
      githubRepoId: asGithubRepoId(101),
      owner: 'a',
      name: 'b',
      installationId: asGithubInstallationId(1),
    });
    const pr = await repos.pullRequests.upsert({
      repositoryId: repo.id,
      githubPrNumber: asGithubPrNumber(7),
      headSha: 'abc',
      baseSha: 'main',
      authorLogin: 'alice',
      isDraft: false,
      title: 't',
    });
    const key = autoIdempotencyKey(repo.id, pr.githubPrNumber, pr.headSha);

    const a = await repos.reviewRuns.upsertByIdempotency({
      pullRequestId: pr.id,
      idempotencyKey: key,
      trigger: 'auto',
      triggeredBy: null,
      headSha: pr.headSha,
      reviewerName: 'claude-code',
    });
    const b = await repos.reviewRuns.upsertByIdempotency({
      pullRequestId: pr.id,
      idempotencyKey: key,
      trigger: 'auto',
      triggeredBy: null,
      headSha: pr.headSha,
      reviewerName: 'claude-code',
    });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(a.run.id).toBe(b.run.id);
  });

  it('transition uses optimistic locking and rejects illegal moves', async () => {
    const repo = await repos.repositories.upsertFromInstallation({
      githubRepoId: asGithubRepoId(1),
      owner: 'a',
      name: 'b',
      installationId: asGithubInstallationId(1),
    });
    const pr = await repos.pullRequests.upsert({
      repositoryId: repo.id,
      githubPrNumber: asGithubPrNumber(1),
      headSha: 'abc',
      baseSha: 'main',
      authorLogin: 'alice',
      isDraft: false,
      title: 't',
    });
    const { run } = await repos.reviewRuns.upsertByIdempotency({
      pullRequestId: pr.id,
      idempotencyKey: autoIdempotencyKey(repo.id, pr.githubPrNumber, 'abc'),
      trigger: 'auto',
      triggeredBy: null,
      headSha: 'abc',
      reviewerName: 'claude-code',
    });

    const r1 = await repos.reviewRuns.transition(run.id, 'queued', { state: 'preparing' });
    expect(r1.state).toBe('preparing');

    // Same expected state should now fail (optimistic lock).
    await expect(
      repos.reviewRuns.transition(run.id, 'queued', { state: 'fetching' }),
    ).rejects.toThrow();
  });

  it('records and retrieves audit events', async () => {
    await repos.auditLog.record({
      actor: 'system',
      kind: 'webhook.received',
      subjectType: 'delivery',
      subjectId: 'abc',
      data: { event: 'pull_request' },
    });
    const events = await repos.auditLog.list();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('webhook.received');
  });

  it('settings: round-trips secrets via SecretBox', async () => {
    await repos.settings.setSecret('anthropic.api_key', 'sk-ant-secret');
    const got = await repos.settings.getSecret('anthropic.api_key');
    expect(got).toBe('sk-ant-secret');

    // Plain encoding is JSON.
    await repos.settings.setPlain('default_model', 'claude-sonnet-4-5');
    expect(await repos.settings.getPlain('default_model')).toBe('claude-sonnet-4-5');
  });

  it('webhook delivery is idempotent on delivery_id', async () => {
    const a = await repos.webhookDeliveries.recordIfNew({
      deliveryId: 'd-1',
      event: 'ping',
      action: null,
      signatureValid: true,
      payloadJson: '{}',
    });
    const b = await repos.webhookDeliveries.recordIfNew({
      deliveryId: 'd-1',
      event: 'ping',
      action: null,
      signatureValid: true,
      payloadJson: '{}',
    });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
  });
});
