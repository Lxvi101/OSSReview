import { execFile } from 'node:child_process';
import type { BootEnv } from '@gcr/config';
import {
  type RepositorySettings,
  type ReviewRunId,
  asGithubInstallationId,
  asRepositoryId,
  asReviewRunId,
  fullName,
} from '@gcr/core';
import { preflightPublicUrl } from '@gcr/github';
import type { JobQueue } from '@gcr/queue';
import type { Repositories } from '@gcr/storage';
import type { FastifyInstance } from 'fastify';

export interface ApiDeps {
  readonly env: BootEnv;
  readonly repos: Repositories;
  readonly queue: JobQueue;
}

/**
 * JSON API consumed by the Vite + React dashboard in `apps/dashboard`.
 *
 * Live transcript stream is at `/api/reviews/:id/events/stream` (SSE) — the
 * handler polls SQLite once a second and pushes new rows down the wire,
 * closing when the run reaches a terminal state.
 */
export async function registerApiRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  // ── Dashboard summary ─────────────────────────────────────────────────────
  app.get('/api/dashboard', async () => {
    const recent = await deps.repos.reviewRuns.recent({ limit: 10 });
    const repos = await deps.repos.repositories.list();
    const repoMap = new Map(repos.map((r) => [r.id, r]));
    const recentReviews = await Promise.all(
      recent.map(async (r) => {
        const pr = await deps.repos.pullRequests.byId(r.pullRequestId);
        const repo = pr ? repoMap.get(pr.repositoryId) : undefined;
        return {
          id: r.id as unknown as number,
          state: r.state,
          repo: repo ? fullName(repo) : '?',
          prNumber: (pr?.githubPrNumber as unknown as number | undefined) ?? null,
          createdAt: r.createdAt,
        };
      }),
    );
    const inFlight = (await deps.queue.list({ state: 'running', limit: 1000 })).length;
    const queued = (await deps.queue.list({ state: 'queued', limit: 1000 })).length;
    const dlq = await deps.queue.dlqCount();
    const recentFailures = await deps.repos.reviewRuns.recentFailures({ limit: 5 });
    return {
      recentReviews,
      queue: { inFlight, queued, dlq },
      recentFailures,
    };
  });

  // ── Reviews list ──────────────────────────────────────────────────────────
  app.get<{ Querystring: { state?: string } }>('/api/reviews', async (req) => {
    const recent = await deps.repos.reviewRuns.recent({ limit: 100 });
    const filter = req.query.state;
    const filtered = filter ? recent.filter((r) => r.state === filter) : recent;
    const repos = await deps.repos.repositories.list();
    const repoMap = new Map(repos.map((r) => [r.id, r]));
    const reviews = await Promise.all(
      filtered.map(async (r) => {
        const pr = await deps.repos.pullRequests.byId(r.pullRequestId);
        const repo = pr ? repoMap.get(pr.repositoryId) : undefined;
        return {
          id: r.id as unknown as number,
          state: r.state,
          trigger: r.trigger,
          repo: repo ? fullName(repo) : '?',
          prNumber: (pr?.githubPrNumber as unknown as number | undefined) ?? null,
          createdAt: r.createdAt,
          errorClass: r.errorClass,
        };
      }),
    );
    return { reviews };
  });

  // ── Review detail ─────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/api/reviews/:id', async (req, reply) => {
    const id = parseRunId(req.params.id);
    if (id === null) {
      reply.code(404);
      return { error: 'not found' };
    }
    const run = await deps.repos.reviewRuns.byId(id);
    if (!run) {
      reply.code(404);
      return { error: 'not found' };
    }
    const pr = await deps.repos.pullRequests.byId(run.pullRequestId);
    const repos = await deps.repos.repositories.list();
    const repo = pr ? repos.find((r) => r.id === pr.repositoryId) : undefined;
    const findings = await deps.repos.reviewRuns.listComments(run.id);
    return {
      review: {
        id: run.id as unknown as number,
        state: run.state,
        terminal: isTerminal(run.state),
        repo: repo ? fullName(repo) : '?',
        prNumber: (pr?.githubPrNumber as unknown as number | undefined) ?? null,
        trigger: run.trigger,
        attempts: run.attempts,
        durationMs: run.durationMs,
        errorClass: run.errorClass,
        errorMessage: run.errorMessage,
        cancelRequestedAt: run.cancelRequestedAt,
        createdAt: run.createdAt,
      },
      findings,
    };
  });

  // Cancel a non-terminal run. Worker polls cancel_requested_at every 2s.
  app.post<{ Params: { id: string } }>('/api/reviews/:id/cancel', async (req, reply) => {
    const id = parseRunId(req.params.id);
    if (id === null) {
      reply.code(404);
      return { error: 'not found' };
    }
    const run = await deps.repos.reviewRuns.byId(id);
    if (!run) {
      reply.code(404);
      return { error: 'not found' };
    }
    if (isTerminal(run.state)) {
      reply.code(409);
      return { error: 'run is already terminal', state: run.state };
    }
    await deps.repos.reviewRuns.requestCancel(id);
    await deps.repos.auditLog.record({
      actor: 'web',
      kind: 'review.cancel_requested',
      subjectType: 'review_run',
      subjectId: String(id),
      data: { state: run.state },
    });
    reply.code(202);
    return { ok: true };
  });

  // Pull events (initial backfill / non-streaming clients).
  app.get<{
    Params: { id: string };
    Querystring: { since?: string; limit?: string };
  }>('/api/reviews/:id/events', async (req, reply) => {
    const id = parseRunId(req.params.id);
    if (id === null) {
      reply.code(404);
      return { error: 'not found' };
    }
    const since = parseNonNegInt(req.query.since);
    const limit = parseNonNegInt(req.query.limit) ?? 200;
    const run = await deps.repos.reviewRuns.byId(id);
    if (!run) {
      reply.code(404);
      return { error: 'not found' };
    }
    const eventsArgs: Parameters<typeof deps.repos.reviewEvents.listForRun>[0] = {
      reviewRunId: id,
      limit,
      ...(since !== undefined ? { since } : {}),
    };
    const events = await deps.repos.reviewEvents.listForRun(eventsArgs);
    return {
      runId: id as unknown as number,
      runState: run.state,
      terminal: isTerminal(run.state),
      events,
    };
  });

  // SSE push stream. Polls SQLite at 1Hz and pushes new rows; closes with
  // `event: terminal` once the run is done. Honors Last-Event-ID.
  app.get<{
    Params: { id: string };
    Querystring: { since?: string };
  }>('/api/reviews/:id/events/stream', async (req, reply) => {
    const id = parseRunId(req.params.id);
    if (id === null) {
      reply.code(404).send();
      return;
    }
    const lastEventId = req.headers['last-event-id'];
    let cursor =
      typeof lastEventId === 'string'
        ? Number.parseInt(lastEventId, 10) || 0
        : (parseNonNegInt(req.query.since) ?? 0);

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.hijack();
    reply.raw.write(': connected\n\n');

    let closed = false;
    let timer: NodeJS.Timeout | null = null;
    const onClose = (): void => {
      closed = true;
      if (timer) clearTimeout(timer);
    };
    req.raw.on('close', onClose);

    // Three consecutive transient errors → close the stream so the browser
    // reconnects from scratch instead of seeing intermittent garbage.
    let consecutiveErrors = 0;
    const MAX_ERRORS = 3;

    const tick = async (): Promise<void> => {
      if (closed) return;
      try {
        const run = await deps.repos.reviewRuns.byId(id);
        if (closed) return;
        if (!run) {
          reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: 'run not found' })}\n\n`);
          reply.raw.end();
          return;
        }
        const events = await deps.repos.reviewEvents.listForRun({
          reviewRunId: id,
          since: cursor,
          limit: 200,
        });
        if (closed) return;
        for (const e of events) {
          if (closed) return;
          reply.raw.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
          if (e.seq > cursor) cursor = e.seq;
        }
        if (isTerminal(run.state)) {
          reply.raw.write(`event: terminal\ndata: ${JSON.stringify({ state: run.state })}\n\n`);
          reply.raw.end();
          return;
        }
        if (events.length === 0) reply.raw.write(': keepalive\n\n');
        consecutiveErrors = 0;
        timer = setTimeout(() => void tick(), 1000);
      } catch (err) {
        if (closed) return;
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_ERRORS) {
          const msg = err instanceof Error ? err.message : String(err);
          try {
            reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`);
            reply.raw.end();
          } catch {
            // socket already gone
          }
          return;
        }
        // Back off and retry — transient SQLite locks etc.
        timer = setTimeout(() => void tick(), 1000 * consecutiveErrors);
      }
    };
    void tick();
  });

  // ── Repositories list ─────────────────────────────────────────────────────
  app.get<{ Querystring: { show?: string } }>('/api/repositories', async (req) => {
    const showAll = req.query.show === 'all';
    const all = await deps.repos.repositories.list();
    const enabled = all.filter((r) => r.enabled);
    const disabled = all.filter((r) => !r.enabled);
    const visible = showAll ? all : enabled;

    const byInstallation = new Map<number, { owner: string; count: number }>();
    for (const r of all) {
      const cur = byInstallation.get(r.installationId as number);
      if (cur) cur.count++;
      else byInstallation.set(r.installationId as number, { owner: r.owner, count: 1 });
    }
    const installations = [...byInstallation.entries()].map(([id, v]) => ({
      id,
      owner: v.owner,
      count: v.count,
      configureUrl: `https://github.com/settings/installations/${id}`,
    }));

    const auditTail = (await deps.repos.auditLog.list({ limit: 50 }))
      .filter((e) => e.kind === 'repo.added' || e.kind === 'repo.removed')
      .slice(0, 8);

    const appSlug = await deps.repos.settings.getPlain<string>('github.app.slug');

    return {
      repositories: visible.map((r) => ({
        id: r.id as unknown as number,
        fullName: fullName(r),
        enabled: r.enabled,
        updatedAt: r.updatedAt,
      })),
      enabledCount: enabled.length,
      disabledCount: disabled.length,
      installations,
      appSlug,
      installNewUrl: appSlug
        ? `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new`
        : null,
      recentEvents: auditTail.map((e) => ({
        at: e.at,
        kind: e.kind,
        subjectType: e.subjectType,
        data: JSON.stringify(e.data),
      })),
    };
  });

  app.post('/api/repositories/refresh', async (_req, reply) => {
    const repos = await deps.repos.repositories.list();
    const installationIds = [...new Set(repos.map((r) => r.installationId as number))];
    for (const installationId of installationIds) {
      await deps.queue.enqueue({
        name: 'reconcile_installation_repos',
        data: { installationId },
        uniqueKey: `reconcile:${installationId}:${Math.floor(Date.now() / 1000)}`,
        maxAttempts: 3,
        priority: 5,
      });
    }
    reply.code(202);
    return { ok: true, queued: installationIds.length };
  });

  // ── Repository detail + settings ──────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/api/repositories/:id', async (req, reply) => {
    const id = parseRepoId(req.params.id);
    if (id === null) {
      reply.code(404);
      return { error: 'not found' };
    }
    const repo = await deps.repos.repositories.byId(id);
    if (!repo) {
      reply.code(404);
      return { error: 'not found' };
    }
    const recentReviews = await deps.repos.reviewRuns.recent({ limit: 30 });
    const myReviews: Array<{ id: number; state: string; prNumber: number; createdAt: string }> = [];
    for (const run of recentReviews) {
      const pr = await deps.repos.pullRequests.byId(run.pullRequestId);
      if (pr && pr.repositoryId === repo.id) {
        myReviews.push({
          id: run.id as unknown as number,
          state: run.state,
          prNumber: pr.githubPrNumber as unknown as number,
          createdAt: run.createdAt,
        });
      }
      if (myReviews.length >= 10) break;
    }
    return {
      repo: {
        id: repo.id as unknown as number,
        fullName: fullName(repo),
        owner: repo.owner,
        name: repo.name,
        installationId: repo.installationId as unknown as number,
        githubUrl: `https://github.com/${repo.owner}/${repo.name}`,
        configureInstallUrl: `https://github.com/settings/installations/${repo.installationId as unknown as number}`,
        enabled: repo.enabled,
        createdAt: repo.createdAt,
        updatedAt: repo.updatedAt,
      },
      settings: {
        severityFloor: repo.settings.severityFloor ?? null,
        promptAddendum: repo.settings.promptAddendum ?? null,
        model: repo.settings.model ?? null,
        reviewerProvider: repo.settings.reviewerProvider ?? null,
        ignorePaths: repo.settings.ignorePaths ?? [],
        skipDrafts: repo.settings.skipDrafts ?? true,
        maxMentionsPerPr: repo.settings.maxMentionsPerPr ?? null,
      },
      recentReviews: myReviews,
    };
  });

  app.put<{
    Params: { id: string };
    Body: {
      severityFloor?: string | null;
      promptAddendum?: string | null;
      model?: string | null;
      reviewerProvider?: string | null;
      ignorePaths?: string[];
      skipDrafts?: boolean;
      maxMentionsPerPr?: number | null;
    };
  }>('/api/repositories/:id/settings', async (req, reply) => {
    const id = parseRepoId(req.params.id);
    if (id === null) {
      reply.code(404);
      return { error: 'not found' };
    }
    const b = req.body ?? {};
    type Mut<T> = { -readonly [K in keyof T]?: T[K] };
    const patch: Mut<RepositorySettings> = {};
    if (b.severityFloor) {
      const allowed = ['blocker', 'warning', 'suggestion', 'nit', 'praise'] as const;
      const sev = allowed.find((s) => s === b.severityFloor);
      if (sev) patch.severityFloor = sev;
    }
    if (b.promptAddendum?.trim()) patch.promptAddendum = b.promptAddendum.trim();
    if (b.model?.trim()) patch.model = b.model.trim();
    if (
      b.reviewerProvider === 'claude' ||
      b.reviewerProvider === 'codex' ||
      b.reviewerProvider === 'acp'
    ) {
      patch.reviewerProvider = b.reviewerProvider;
    }
    if (Array.isArray(b.ignorePaths)) {
      const cleaned = b.ignorePaths.map((s) => s.trim()).filter(Boolean);
      if (cleaned.length > 0) patch.ignorePaths = cleaned;
    }
    patch.skipDrafts = b.skipDrafts !== false;
    if (
      typeof b.maxMentionsPerPr === 'number' &&
      Number.isFinite(b.maxMentionsPerPr) &&
      b.maxMentionsPerPr >= 0 &&
      b.maxMentionsPerPr <= 100
    ) {
      patch.maxMentionsPerPr = b.maxMentionsPerPr;
    }
    await deps.repos.repositories.replaceSettings(id, patch as RepositorySettings);
    await deps.repos.auditLog.record({
      actor: 'web',
      kind: 'repo.settings_updated',
      subjectType: 'repository',
      subjectId: String(id),
      data: { keys: Object.keys(patch) },
    });
    return { ok: true };
  });

  app.put<{ Params: { id: string }; Body: { enabled: boolean } }>(
    '/api/repositories/:id/enabled',
    async (req, reply) => {
      const id = parseRepoId(req.params.id);
      if (id === null) {
        reply.code(404);
        return { error: 'not found' };
      }
      const enabled = req.body?.enabled === true;
      await deps.repos.repositories.setEnabled(id, enabled);
      await deps.repos.auditLog.record({
        actor: 'web',
        kind: enabled ? 'repo.added' : 'repo.removed',
        subjectType: 'repository',
        subjectId: String(id),
        data: { via: 'manual_toggle', enabled },
      });
      return { ok: true, enabled };
    },
  );

  // ── Errors (first-class error log) ───────────────────────────────────────
  app.get('/api/errors', async () => {
    const failures = await deps.repos.reviewRuns.recentFailures({ limit: 100 });
    return { failures };
  });

  // ── Audit log ─────────────────────────────────────────────────────────────
  app.get('/api/audit', async () => {
    const events = await deps.repos.auditLog.list({ limit: 200 });
    return {
      events: events.map((e) => ({
        at: e.at,
        actor: e.actor,
        kind: e.kind,
        subjectType: e.subjectType,
        subjectId: e.subjectId,
      })),
    };
  });

  // ── Prune old runs ────────────────────────────────────────────────────────
  app.post<{ Body: { olderThanDays?: number } }>('/api/maintenance/prune', async (req, reply) => {
    const days =
      typeof req.body?.olderThanDays === 'number' && req.body.olderThanDays >= 1
        ? Math.min(req.body.olderThanDays, 3650)
        : 30;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const deleted = await deps.repos.reviewRuns.deleteOlderThan(cutoff);
    await deps.repos.auditLog.record({
      actor: 'web',
      kind: 'maintenance.prune_runs',
      subjectType: 'review_run',
      subjectId: null,
      data: { olderThanDays: days, deleted },
    });
    reply.code(200);
    return { ok: true, deleted, olderThanDays: days };
  });

  // ── Setup landing info ────────────────────────────────────────────────────
  app.get('/api/setup', async () => {
    const preflight = preflightPublicUrl(deps.env.PUBLIC_URL);
    const appId = await deps.repos.settings.getPlain<number>('github.app.id');
    const slug = await deps.repos.settings.getPlain<string>('github.app.slug');
    return {
      suggestedName: 'gcr-bot',
      publicUrl: deps.env.PUBLIC_URL,
      preflight,
      configured: !!appId,
      slug,
      installNewUrl: slug
        ? `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`
        : null,
    };
  });

  // ── Setup status checks ───────────────────────────────────────────────────
  app.get('/api/setup/status', async (_req, reply) => {
    const checks = await collectStatusChecks(deps);
    const allOk = checks.every((c) => c.status !== 'fail');
    if (!allOk) reply.code(503);
    return { ok: allOk, checks };
  });

  // Reset the linked GitHub App. Clears all credentials from the settings
  // table and disables every tracked repository — the existing rows reference
  // installation IDs that won't exist under a new App. Rows are kept (not
  // deleted) so historical data stays intact; the next install will re-enable
  // them via the upsert-by-github_repo_id path.
  app.delete('/api/setup/github-app', async (_req, reply) => {
    const appId = await deps.repos.settings.getPlain<number>('github.app.id');
    if (!appId) {
      reply.code(404);
      return { error: 'no GitHub App is configured' };
    }
    const slug = await deps.repos.settings.getPlain<string>('github.app.slug');
    const keys = [
      'github.app.id',
      'github.app.slug',
      'github.app.client_id',
      'github.app.client_secret',
      'github.app.webhook_secret',
      'github.app.private_key',
      'github.app.bot_login',
    ];
    for (const k of keys) await deps.repos.settings.delete(k);

    const tracked = await deps.repos.repositories.list({ enabled: true });
    const installationIds = [...new Set(tracked.map((r) => r.installationId as number))];
    let disabled = 0;
    for (const id of installationIds) {
      const n = await deps.repos.repositories.setEnabledForInstallation(
        asGithubInstallationId(id),
        false,
      );
      disabled += n;
    }

    await deps.repos.auditLog.record({
      actor: 'web',
      kind: 'admin.github_app_reset',
      subjectType: 'github_app',
      subjectId: String(appId),
      data: { slug, reposDisabled: disabled },
    });
    return { ok: true, reposDisabled: disabled };
  });
}

function isTerminal(state: string): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

function parseRepoId(s: string) {
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return asRepositoryId(n);
}

function parseRunId(s: string): ReviewRunId | null {
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return asReviewRunId(n);
}

function parseNonNegInt(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

interface StatusCheck {
  readonly name: string;
  readonly description: string;
  readonly status: 'ok' | 'warn' | 'fail';
  readonly detail: string;
}

async function collectStatusChecks(deps: ApiDeps): Promise<StatusCheck[]> {
  const acpBinary =
    deps.env.ACP_AGENT_COMMAND || (deps.env.ACP_AGENT === 'github-copilot' ? 'copilot' : '');
  const [appId, slug, privateKey, webhookSecret, repos, claudeCheck, codexCheck, acpCheck] =
    await Promise.all([
      deps.repos.settings.getPlain<number>('github.app.id'),
      deps.repos.settings.getPlain<string>('github.app.slug'),
      deps.repos.settings.getSecret('github.app.private_key'),
      deps.repos.settings.getSecret('github.app.webhook_secret'),
      deps.repos.repositories.list(),
      providerCheck(
        'Claude Code CLI',
        deps.env.CLAUDE_CODE_BINARY,
        deps.env.REVIEWER_PROVIDER === 'claude',
      ),
      providerCheck('Codex CLI', deps.env.CODEX_BINARY, deps.env.REVIEWER_PROVIDER === 'codex'),
      providerCheck(
        `ACP agent (${deps.env.ACP_AGENT})`,
        acpBinary,
        deps.env.REVIEWER_PROVIDER === 'acp',
      ),
    ]);

  const checks: StatusCheck[] = [];
  checks.push({
    name: 'GitHub App',
    description: 'App ID, private key, and webhook secret persisted to the settings table.',
    ...(appId && privateKey && webhookSecret
      ? { status: 'ok' as const, detail: `App #${appId} (${slug ?? 'no slug'})` }
      : { status: 'fail' as const, detail: 'Run /setup to register the App.' }),
  });
  checks.push({
    name: 'Tracked repositories',
    description: 'At least one repository the App is installed on.',
    ...(repos.length > 0
      ? { status: 'ok' as const, detail: `${repos.length} tracked.` }
      : {
          status: 'warn' as const,
          detail: 'No repos yet. Install the App on a repo at /setup/install.',
        }),
  });
  checks.push(claudeCheck);
  checks.push(codexCheck);
  checks.push(acpCheck);
  checks.push({
    name: 'Public URL',
    description: 'GitHub posts webhooks to PUBLIC_URL/webhooks/github.',
    status: 'ok',
    detail: deps.env.PUBLIC_URL,
  });
  return checks;
}

// 60s in-process cache so polling /api/setup/status doesn't fork off two
// child processes per request. Keyed by the binary path so toggling between
// providers in dev still returns fresh data.
interface CachedVersion {
  readonly result: { ok: true; version: string } | { ok: false; error: string };
  readonly until: number;
}
const versionCache = new Map<string, CachedVersion>();
const VERSION_TTL_MS = 60_000;

async function providerCheck(
  name: string,
  binary: string,
  required: boolean,
): Promise<StatusCheck> {
  const result = await runVersionCached(binary);
  if (result.ok) {
    return {
      name,
      description: `Local subscription-backed reviewer binary (${binary}).`,
      status: 'ok',
      detail: result.version,
    };
  }
  return {
    name,
    description: `Local subscription-backed reviewer binary (${binary}).`,
    status: required ? 'fail' : 'warn',
    detail: required
      ? result.error
      : `${result.error} This is only required for repos configured to use this provider.`,
  };
}

function runVersionCached(
  binary: string,
): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  const cached = versionCache.get(binary);
  if (cached && cached.until > Date.now()) return Promise.resolve(cached.result);
  return runVersion(binary).then((result) => {
    versionCache.set(binary, { result, until: Date.now() + VERSION_TTL_MS });
    return result;
  });
}

function runVersion(
  binary: string,
): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    execFile(binary, ['--version'], { timeout: 5_000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, error: err.message });
        return;
      }
      resolve({ ok: true, version: (stdout || stderr).trim() || 'installed' });
    });
  });
}
