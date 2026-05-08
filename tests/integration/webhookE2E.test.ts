/**
 * End-to-end test for the webhook ingress.
 *
 * Stands up a real Fastify app wired to:
 *   - an in-memory SQLite (with real migrations)
 *   - real Repositories / JobQueue / SecretBox
 *   - a real `Metrics` registry
 *
 * Then exercises the durability + idempotency + signature-verification path
 * using the same fixture corpus as `webhookTriage.test.ts`. This is the test
 * that catches "I broke the webhook ingress in a refactor."
 *
 * The Claude SDK / GitHub adapter are NOT involved — we stop at "the right
 * job got enqueued in the same transaction as the delivery row."
 */

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BootEnv } from '@gcr/config';
import { SystemClock } from '@gcr/core';
import { Metrics, buildLogger } from '@gcr/observability';
import { JobQueue } from '@gcr/queue';
import { buildApp } from '@gcr/server/app';
import { SecretBox, makeRepositories, openDatabase, runMigrations } from '@gcr/storage';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, '..', 'fixtures', 'webhooks');
const SECRET = 'test-webhook-secret';
const SECRETS_KEY = '0'.repeat(64);
const SESSION_SECRET = 'a'.repeat(48);

function loadFixture(name: string): { body: Buffer; event: string; deliveryId: string } {
  const body = readFileSync(join(FIXTURES, name));
  const eventMap: Record<string, string> = {
    'pull_request.opened.json': 'pull_request',
    'pull_request.synchronize.json': 'pull_request',
    'pull_request.draft.json': 'pull_request',
    'issue_comment.created.mention.json': 'issue_comment',
    'issue_comment.created.no_mention.json': 'issue_comment',
    'installation.created.json': 'installation',
    'ping.json': 'ping',
  };
  const event = eventMap[name] ?? 'pull_request';
  const deliveryId = `test-${name}-${Math.random().toString(36).slice(2)}`;
  return { body, event, deliveryId };
}

function sign(body: Buffer): string {
  return `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
}

const env: BootEnv = {
  NODE_ENV: 'test',
  PORT: 0,
  PUBLIC_URL: 'http://localhost:0',
  DATABASE_PATH: ':memory:',
  DASHBOARD_DIST: '',
  SESSION_SECRET,
  SECRETS_KEY,
  REVIEWER_PROVIDER: 'claude',
  REVIEWER_TIMEOUT_MS: 1_200_000,
  CLAUDE_CODE_BINARY: 'claude',
  CLAUDE_CODE_HOME: '',
  CLAUDE_CODE_MODEL: 'claude-sonnet-4-5',
  CODEX_BINARY: 'codex',
  CODEX_HOME: '',
  CODEX_MODEL: 'gpt-5-codex',
  LOG_LEVEL: 'fatal',
  METRICS_BIND: '127.0.0.1:0',
};

describe('webhook ingress e2e', () => {
  let app: FastifyInstance;
  let handle: ReturnType<typeof openDatabase>;
  let queue: JobQueue;

  beforeEach(async () => {
    handle = openDatabase({ path: ':memory:' });
    runMigrations(handle);
    const clock = new SystemClock();
    const secretBox = new SecretBox(SECRETS_KEY);
    const repos = makeRepositories(handle.kysely, { clock, secretBox });
    queue = new JobQueue(handle.kysely, clock);

    // Seed the GitHub App webhook secret so the handler can verify signatures.
    await repos.settings.setSecret('github.app.webhook_secret', SECRET);
    await repos.settings.setPlain('github.app.bot_login', 'gcr-bot');

    const logger = buildLogger({ level: 'fatal' });
    const metrics = new Metrics();
    app = await buildApp({ env, logger, db: handle.kysely, repos, queue, metrics, clock });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await handle.destroy();
  });

  it('rejects requests without delivery headers (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      payload: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects bad signatures (401) and does NOT persist a delivery', async () => {
    const { body, event, deliveryId } = loadFixture('pull_request.opened.json');
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': 'sha256=deadbeef',
      },
    });
    expect(res.statusCode).toBe(401);
    const row = await handle.kysely
      .selectFrom('webhook_deliveries')
      .select('delivery_id')
      .where('delivery_id', '=', deliveryId)
      .executeTakeFirst();
    expect(row).toBeUndefined(); // bad sig MUST NOT persist
  });

  it('persists delivery + enqueues review job atomically on a valid PR opened', async () => {
    const { body, event, deliveryId } = loadFixture('pull_request.opened.json');
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': sign(body),
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().outcome).toBe('enqueued:review');

    const delivery = await handle.kysely
      .selectFrom('webhook_deliveries')
      .selectAll()
      .where('delivery_id', '=', deliveryId)
      .executeTakeFirstOrThrow();
    expect(delivery.processing_outcome).toBe('enqueued:review');

    const jobs = await queue.list({ state: 'queued', limit: 10 });
    expect(jobs.some((j) => j.name === 'review_pr')).toBe(true);
  });

  it('idempotent on redelivery of the same X-GitHub-Delivery', async () => {
    const { body, event, deliveryId } = loadFixture('pull_request.opened.json');
    const headers = {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': deliveryId,
      'x-hub-signature-256': sign(body),
    };

    const a = await app.inject({ method: 'POST', url: '/webhooks/github', payload: body, headers });
    const b = await app.inject({ method: 'POST', url: '/webhooks/github', payload: body, headers });

    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(202);
    expect(b.json().outcome).toBe('duplicate');

    // Only one delivery row, only one job.
    const rows = await handle.kysely
      .selectFrom('webhook_deliveries')
      .select('delivery_id')
      .where('delivery_id', '=', deliveryId)
      .execute();
    expect(rows).toHaveLength(1);

    const jobs = await queue.list({ limit: 10 });
    const reviewJobs = jobs.filter((j) => j.name === 'review_pr');
    expect(reviewJobs).toHaveLength(1);
  });

  it('drafts are persisted but result in ignored:draft_pr', async () => {
    const { body, event, deliveryId } = loadFixture('pull_request.draft.json');
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': sign(body),
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().outcome).toBe('ignored:draft_pr');
    const jobs = await queue.list({ state: 'queued' });
    expect(jobs.find((j) => j.name === 'review_pr')).toBeUndefined();
  });

  it('mention enqueues a mention review job', async () => {
    const { body, event, deliveryId } = loadFixture('issue_comment.created.mention.json');
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': sign(body),
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().outcome).toBe('enqueued:mention');
  });

  it('non-mention comment is ignored', async () => {
    const { body, event, deliveryId } = loadFixture('issue_comment.created.no_mention.json');
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': sign(body),
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().outcome).toBe('ignored:no_mention');
  });

  it('installation.created enqueues the install-sync job', async () => {
    const { body, event, deliveryId } = loadFixture('installation.created.json');
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': sign(body),
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().outcome).toBe('enqueued:install_sync');
  });

  it('/health returns 200; /ready returns 200 once DB is reachable', async () => {
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);

    const ready = await app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(200);
  });

  it('/metrics returns Prometheus-format text', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.body).toContain('gcr_webhook_deliveries_total');
  });
});
