import type { BootEnv } from '@gcr/config';
import { asGithubInstallationId, asGithubRepoId } from '@gcr/core';
import { buildManifest, exchangeManifestCode, preflightPublicUrl } from '@gcr/github';
import type { Repositories } from '@gcr/storage';
import type { FastifyInstance, FastifyReply } from 'fastify';

export interface SetupDeps {
  readonly env: BootEnv;
  readonly repos: Repositories;
}

/**
 * GitHub App manifest setup flow.
 *
 * The dashboard SPA renders the wizard UI (/setup, /setup/status). The
 * routes below are the server-side pieces that *can't* live in the SPA:
 *
 *   - POST /setup/manifest  emits an HTML form that the browser auto-submits
 *     to `https://github.com/settings/apps/new` with the manifest in a hidden
 *     field. (GitHub requires a real form post; the SPA can't call
 *     `fetch()` against github.com cross-origin.)
 *   - GET  /setup/callback  GitHub redirects back here with `code` + `state`.
 *     We exchange the code for App credentials and persist them encrypted.
 *   - GET  /setup/install   one-shot redirect to the install page.
 *
 * Preflight URL validation also runs server-side so the SPA can render a
 * helpful error before letting the user tap "Create App".
 */
export async function registerSetupRoutes(app: FastifyInstance, deps: SetupDeps): Promise<void> {
  // ── Manifest form (autosubmits to GitHub) ─────────────────────────────────
  app.post<{ Body: { name: string } }>('/setup/manifest', async (req, reply) => {
    const preflight = preflightPublicUrl(deps.env.PUBLIC_URL);
    if (!preflight.ok) {
      reply
        .code(400)
        .type('text/html; charset=utf-8')
        .send(`<!doctype html>
<meta charset="utf-8"><title>PUBLIC_URL invalid</title>
<style>body{font:14px/1.5 -apple-system,Segoe UI,sans-serif;max-width:720px;margin:48px auto;padding:0 24px;color:#0e1116}
h1{color:#d1242f} pre{background:#f6f7f9;padding:12px;border-radius:6px;white-space:pre-wrap}</style>
<h1>PUBLIC_URL is not acceptable to GitHub</h1>
<p><strong>Reason:</strong> ${escapeHtml(preflight.reason)}</p>
<p><strong>What to do:</strong> ${escapeHtml(preflight.suggestion)}</p>
<pre>Currently: PUBLIC_URL=${escapeHtml(deps.env.PUBLIC_URL)}</pre>
<p>Update <code>.env</code>, restart the stack, and refresh <a href="/setup">/setup</a>.</p>`);
      return;
    }

    const name = (req.body?.name ?? 'gcr-bot').slice(0, 34);
    const manifest = buildManifest({ name, publicUrl: deps.env.PUBLIC_URL });
    const json = JSON.stringify(manifest)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;');
    const html = `<!doctype html><html><body onload="document.forms[0].submit()">
<form action="https://github.com/settings/apps/new" method="post">
  <input type="hidden" name="manifest" value="${json}">
  <p>Redirecting you to GitHub…</p>
  <noscript><button type="submit">Continue to GitHub →</button></noscript>
</form>
</body></html>`;
    sendHtml(reply, html);
  });

  // ── Manifest exchange callback ────────────────────────────────────────────
  app.get<{ Querystring: { code?: string } }>('/setup/callback', async (req, reply) => {
    const code = req.query.code;
    if (!code) {
      reply.code(400).send({ error: 'missing code' });
      return;
    }
    try {
      const credentials = await exchangeManifestCode(code);
      await deps.repos.settings.setPlain('github.app.id', credentials.id);
      await deps.repos.settings.setPlain('github.app.slug', credentials.slug);
      await deps.repos.settings.setPlain('github.app.client_id', credentials.client_id);
      await deps.repos.settings.setSecret('github.app.client_secret', credentials.client_secret);
      await deps.repos.settings.setSecret('github.app.webhook_secret', credentials.webhook_secret);
      await deps.repos.settings.setSecret('github.app.private_key', credentials.pem);
      await deps.repos.settings.setPlain('github.app.bot_login', `${credentials.slug}[bot]`);
      await deps.repos.auditLog.record({
        actor: 'setup',
        kind: 'admin.signed_in',
        subjectType: 'github_app',
        subjectId: String(credentials.id),
        data: { slug: credentials.slug },
      });
      reply.redirect('/setup/install');
    } catch (err) {
      reply.code(502).send({ error: 'manifest exchange failed', detail: (err as Error).message });
    }
  });

  app.get('/setup/install', async (_req, reply) => {
    const slug = await deps.repos.settings.getPlain<string>('github.app.slug');
    if (!slug) {
      reply.redirect('/setup');
      return;
    }
    reply.redirect(`https://github.com/apps/${encodeURIComponent(slug)}/installations/new`);
  });

  app.get('/setup/done', async (_req, reply) => {
    reply.redirect('/repositories');
  });

  // Helper accessible to tests for upserting installation rows.
  app.post<{
    Body: { installationId: number; repos: Array<{ id: number; owner: string; name: string }> };
  }>('/setup/_dev/install_repos', async (req, reply) => {
    if (deps.env.NODE_ENV === 'production') {
      reply.code(404).send();
      return;
    }
    const { installationId, repos } = req.body;
    for (const r of repos) {
      await deps.repos.repositories.upsertFromInstallation({
        githubRepoId: asGithubRepoId(r.id),
        owner: r.owner,
        name: r.name,
        installationId: asGithubInstallationId(installationId),
      });
    }
    reply.code(200).send({ ok: true });
  });
}

function sendHtml(reply: FastifyReply, html: string): void {
  reply.code(200).type('text/html; charset=utf-8').send(html);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
