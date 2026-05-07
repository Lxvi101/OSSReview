import { asRepositoryId, fullName, type RepositorySettings } from '@gcr/core';
import type { JobQueue } from '@gcr/queue';
import type { Repositories } from '@gcr/storage';
import type { WebRenderer } from '@gcr/web';
import type { FastifyInstance, FastifyReply } from 'fastify';

export interface UiDeps {
  readonly repos: Repositories;
  readonly queue: JobQueue;
  readonly renderer: WebRenderer;
}

export async function registerUiRoutes(app: FastifyInstance, deps: UiDeps): Promise<void> {
  // ── Dashboard ─────────────────────────────────────────────────────────────
  app.get('/', async (_req, reply) => {
    const recent = await deps.repos.reviewRuns.recent({ limit: 10 });
    const repos = await deps.repos.repositories.list();
    const repoMap = new Map(repos.map((r) => [r.id, r]));
    const recentEnriched = await Promise.all(
      recent.map(async (r) => {
        const pr = await deps.repos.pullRequests.byId(r.pullRequestId);
        const repo = pr ? repoMap.get(pr.repositoryId) : undefined;
        return {
          id: r.id,
          state: r.state,
          repo: repo ? fullName(repo) : '?',
          prNumber: pr?.githubPrNumber ?? '?',
          createdAt: r.createdAt,
          relativeAge: relative(r.createdAt),
        };
      }),
    );

    const inFlight = (await deps.queue.list({ state: 'running', limit: 1000 })).length;
    const queued = (await deps.queue.list({ state: 'queued', limit: 1000 })).length;
    const dlq = await deps.queue.dlqCount();

    sendHtml(
      reply,
      deps.renderer.page('dashboard.eta', {
        ctx: { title: 'Dashboard', currentPath: '/' },
        recentReviews: recentEnriched,
        queue: { inFlight, queued, dlq },
        month: { reviews: recent.length, costUsd: 0 },
      }),
    );
  });

  // ── Repositories: refresh from GitHub ─────────────────────────────────────
  // Enqueues a `reconcile_installation_repos` job for every installation we
  // know about. The job hits GitHub's authoritative repo list and disables
  // anything we have but GitHub no longer grants — handles the case where
  // GitHub doesn't fire a `repositories_removed` webhook (notably "All
  // repositories" mode and silent delivery drops).
  //
  // Returns a 303 redirect back to /repositories so a plain browser submit
  // works. Idempotent — re-running is a no-op when nothing changed.
  app.post('/repositories/refresh', async (_req, reply) => {
    const repos = await deps.repos.repositories.list();
    const installationIds = [...new Set(repos.map((r) => r.installationId as number))];
    for (const installationId of installationIds) {
      await deps.queue.enqueue({
        name: 'reconcile_installation_repos',
        data: { installationId },
        // Coalesce duplicate refresh clicks within the same second.
        uniqueKey: `reconcile:${installationId}:${Math.floor(Date.now() / 1000)}`,
        maxAttempts: 3,
        priority: 5,
      });
    }
    reply.code(303).header('Location', '/repositories?refreshed=1').send();
  });

  // ── Repositories list ─────────────────────────────────────────────────────
  // `?show=all` includes repos GitHub revoked access from (we keep the rows
  // around for historical review-run visibility, but default to hiding them).
  app.get<{ Querystring: { show?: string; refreshed?: string } }>('/repositories', async (req, reply) => {
    const showAll = req.query.show === 'all';
    const justRefreshed = req.query.refreshed === '1';
    const all = await deps.repos.repositories.list();
    const enabled = all.filter((r) => r.enabled);
    const disabled = all.filter((r) => !r.enabled);
    const visible = showAll ? all : enabled;

    // Group by installation so we can render a Configure deep-link per install.
    // GitHub URL pattern: https://github.com/settings/installations/<id>
    // (org installations live under /organizations/<org>/settings/... but the
    // personal-settings URL redirects there too, so the simple pattern works.)
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

    // Last few install-related audit events so the user can see whether
    // GitHub is actually sending webhooks for their edits.
    const auditTail = (await deps.repos.auditLog.list({ limit: 50 }))
      .filter((e) => e.kind === 'repo.added' || e.kind === 'repo.removed')
      .slice(0, 8);

    const appSlug = await deps.repos.settings.getPlain<string>('github.app.slug');

    sendHtml(
      reply,
      deps.renderer.page('repositories.eta', {
        ctx: { title: 'Repositories', currentPath: '/repositories' },
        repositories: visible.map((r) => ({
          id: r.id,
          fullName: fullName(r),
          enabled: r.enabled,
          updatedAt: r.updatedAt,
        })),
        showAll,
        justRefreshed,
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
      }),
    );
  });

  // ── Repository detail + settings ──────────────────────────────────────────
  // GET /repositories/:id — settings page for a single tracked repo. Lets the
  // operator override per-repo prompt addendum, severity floor, ignore globs,
  // model/provider, and toggle enabled state without going to GitHub.
  app.get<{ Params: { id: string }; Querystring: { saved?: string } }>(
    '/repositories/:id',
    async (req, reply) => {
      const id = parseRepoId(req.params.id);
      if (id === null) {
        reply.code(404).type('text/plain').send('not found\n');
        return;
      }
      const repo = await deps.repos.repositories.byId(id);
      if (!repo) {
        reply.code(404).type('text/plain').send('not found\n');
        return;
      }
      // Recent reviews for this repo. Filter the global recent list by
      // resolving each run's pull_request → repository_id. Cheap enough at
      // single-tenant scale; if it ever isn't, add a `recent({repositoryId})`
      // overload to ReviewRunRepo.
      const recentReviews = await deps.repos.reviewRuns.recent({ limit: 30 });
      const myReviews: Array<{ id: number; state: string; prNumber: number; createdAt: string }> = [];
      for (const run of recentReviews) {
        const pr = await deps.repos.pullRequests.byId(run.pullRequestId);
        if (pr && pr.repositoryId === repo.id) {
          myReviews.push({
            id: run.id as number,
            state: run.state,
            prNumber: pr.githubPrNumber as number,
            createdAt: run.createdAt,
          });
        }
        if (myReviews.length >= 10) break;
      }

      sendHtml(
        reply,
        deps.renderer.page('repoDetail.eta', {
          ctx: { title: fullName(repo), currentPath: '/repositories' },
          repo: {
            id: repo.id as number,
            fullName: fullName(repo),
            owner: repo.owner,
            name: repo.name,
            installationId: repo.installationId as number,
            githubUrl: `https://github.com/${repo.owner}/${repo.name}`,
            configureInstallUrl: `https://github.com/settings/installations/${repo.installationId as number}`,
            enabled: repo.enabled,
            createdAt: repo.createdAt,
            updatedAt: repo.updatedAt,
          },
          settings: {
            severityFloor: repo.settings.severityFloor ?? '',
            promptAddendum: repo.settings.promptAddendum ?? '',
            model: repo.settings.model ?? '',
            reviewerProvider: repo.settings.reviewerProvider ?? '',
            ignorePaths: (repo.settings.ignorePaths ?? []).join('\n'),
            skipDrafts: repo.settings.skipDrafts ?? true,
            maxMentionsPerPr: repo.settings.maxMentionsPerPr ?? '',
          },
          recentReviews: myReviews,
          saved: req.query.saved === '1',
        }),
      );
    },
  );

  // POST /repositories/:id/settings — replace settings JSON with form values.
  // Empty fields clear the override; non-empty values become the new override.
  app.post<{
    Params: { id: string };
    Body: {
      severityFloor?: string;
      promptAddendum?: string;
      model?: string;
      reviewerProvider?: string;
      ignorePaths?: string;
      skipDrafts?: string;
      maxMentionsPerPr?: string;
    };
  }>('/repositories/:id/settings', async (req, reply) => {
    const id = parseRepoId(req.params.id);
    if (id === null) {
      reply.code(404).type('text/plain').send('not found\n');
      return;
    }
    const b = req.body ?? {};
    // Build a mutable shape for assembly, cast to the readonly Partial<...>
    // when handing it off. Empty strings → undefined (clear override).
    type Mut<T> = { -readonly [K in keyof T]?: T[K] };
    const patch: Mut<RepositorySettings> = {};

    if (b.severityFloor) {
      const allowed = ['blocker', 'warning', 'suggestion', 'nit', 'praise'] as const;
      const sev = allowed.find((s) => s === b.severityFloor);
      if (sev) patch.severityFloor = sev;
    }

    if (b.promptAddendum?.trim()) patch.promptAddendum = b.promptAddendum.trim();
    if (b.model?.trim()) patch.model = b.model.trim();
    if (b.reviewerProvider === 'claude' || b.reviewerProvider === 'codex') {
      patch.reviewerProvider = b.reviewerProvider;
    }

    const ignoreList = (b.ignorePaths ?? '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ignoreList.length > 0) patch.ignorePaths = ignoreList;

    // Form checkboxes: presence means "true", absence means "false"
    patch.skipDrafts = b.skipDrafts === 'on';

    if (b.maxMentionsPerPr?.trim()) {
      const n = Number.parseInt(b.maxMentionsPerPr, 10);
      if (Number.isFinite(n) && n >= 0 && n <= 100) patch.maxMentionsPerPr = n;
    }

    // The form is the canonical source — fields the user cleared should
    // disappear from the persisted JSON, not be merged-over with the old
    // values. `replaceSettings` does the full overwrite.
    await deps.repos.repositories.replaceSettings(id, patch as RepositorySettings);
    await deps.repos.auditLog.record({
      actor: 'web',
      kind: 'repo.settings_updated',
      subjectType: 'repository',
      subjectId: String(id),
      data: { keys: Object.keys(patch) },
    });
    reply.code(303).header('Location', `/repositories/${id}?saved=1`).send();
  });

  // POST /repositories/:id/enabled — local toggle. Doesn't touch GitHub; the
  // "Refresh from GitHub" button is the way to re-sync access. This is for
  // pausing reviews on a repo we still have access to (e.g. a noisy WIP repo).
  app.post<{ Params: { id: string }; Body: { enabled?: string } }>(
    '/repositories/:id/enabled',
    async (req, reply) => {
      const id = parseRepoId(req.params.id);
      if (id === null) {
        reply.code(404).type('text/plain').send('not found\n');
        return;
      }
      const enabled = req.body?.enabled === 'on';
      await deps.repos.repositories.setEnabled(id, enabled);
      await deps.repos.auditLog.record({
        actor: 'web',
        kind: enabled ? 'repo.added' : 'repo.removed',
        subjectType: 'repository',
        subjectId: String(id),
        data: { via: 'manual_toggle', enabled },
      });
      reply.code(303).header('Location', `/repositories/${id}?saved=1`).send();
    },
  );

  // ── Reviews list ──────────────────────────────────────────────────────────
  app.get('/reviews', async (_req, reply) => {
    const recent = await deps.repos.reviewRuns.recent({ limit: 100 });
    const repos = await deps.repos.repositories.list();
    const repoMap = new Map(repos.map((r) => [r.id, r]));
    const enriched = await Promise.all(
      recent.map(async (r) => {
        const pr = await deps.repos.pullRequests.byId(r.pullRequestId);
        const repo = pr ? repoMap.get(pr.repositoryId) : undefined;
        return {
          id: r.id,
          state: r.state,
          repo: repo ? fullName(repo) : '?',
          prNumber: pr?.githubPrNumber ?? '?',
          trigger: r.trigger,
          createdAt: r.createdAt,
          costUsd: r.costUsdMicros !== null ? r.costUsdMicros / 1_000_000 : null,
        };
      }),
    );
    sendHtml(
      reply,
      deps.renderer.page('reviews.eta', {
        ctx: { title: 'Reviews', currentPath: '/reviews' },
        reviews: enriched,
      }),
    );
  });

  // ── Review detail (and a fragment endpoint for HTMX polling) ──────────────
  app.get<{ Params: { id: string } }>('/reviews/:id', async (req, reply) => {
    const html = await renderReview(deps, req.params.id, /* fragmentOnly */ false);
    if (!html) return reply.code(404).send();
    sendHtml(reply, html);
  });

  app.get<{ Params: { id: string } }>('/reviews/:id/fragment', async (req, reply) => {
    const html = await renderReview(deps, req.params.id, /* fragmentOnly */ true);
    if (!html) return reply.code(404).send();
    sendHtml(reply, html);
  });

  // ── Audit log ─────────────────────────────────────────────────────────────
  app.get('/audit', async (_req, reply) => {
    const events = await deps.repos.auditLog.list({ limit: 200 });
    sendHtml(
      reply,
      deps.renderer.page('audit.eta', {
        ctx: { title: 'Audit', currentPath: '/audit' },
        events: events.map((e) => ({
          at: e.at,
          actor: e.actor,
          kind: e.kind,
          subjectType: e.subjectType,
          subjectId: e.subjectId,
        })),
      }),
    );
  });
}

async function renderReview(deps: UiDeps, idStr: string, fragmentOnly: boolean): Promise<string | null> {
  const id = Number.parseInt(idStr, 10);
  if (!Number.isFinite(id)) return null;
  const run = await deps.repos.reviewRuns.byId(id as unknown as Parameters<typeof deps.repos.reviewRuns.byId>[0]);
  if (!run) return null;
  const pr = await deps.repos.pullRequests.byId(run.pullRequestId);
  const repos = await deps.repos.repositories.list();
  const repo = pr ? repos.find((r) => r.id === pr.repositoryId) : undefined;
  const findings = await deps.repos.reviewRuns.listComments(run.id);
  const view = {
    id: run.id,
    state: run.state,
    terminal: run.state === 'completed' || run.state === 'failed' || run.state === 'cancelled',
    repo: repo ? fullName(repo) : '?',
    prNumber: pr?.githubPrNumber ?? '?',
    trigger: run.trigger,
    attempts: run.attempts,
    durationMs: run.durationMs,
    costUsd: run.costUsdMicros !== null ? run.costUsdMicros / 1_000_000 : null,
    errorMessage: run.errorMessage,
  };
  const ctx = { title: `Review ${run.id}`, currentPath: '/reviews' };
  if (fragmentOnly) {
    return deps.renderer.render('reviewDetail.eta', { ctx, review: view, findings });
  }
  return deps.renderer.page('reviewDetail.eta', { ctx, review: view, findings });
}

/** Parse a repository id from a URL param. Returns null on garbage. */
function parseRepoId(s: string) {
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return asRepositoryId(n);
}

function sendHtml(reply: FastifyReply, html: string): void {
  reply.code(200).type('text/html; charset=utf-8').send(html);
}

function relative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
