import type { BootEnv } from '@gcr/config';
import { asGithubInstallationId, asGithubRepoId } from '@gcr/core';
import { buildManifest, exchangeManifestCode, preflightPublicUrl } from '@gcr/github';
import type { Repositories } from '@gcr/storage';
import type { WebRenderer } from '@gcr/web';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { execFile } from 'node:child_process';

export interface SetupDeps {
  readonly env: BootEnv;
  readonly repos: Repositories;
  readonly renderer: WebRenderer;
}

/**
 * Setup wizard.
 *
 * Three steps:
 *   1. GET /setup            — landing form
 *   2. POST /setup/manifest  — render an HTML form that auto-submits to
 *      `https://github.com/settings/apps/new?state=...` with the manifest in
 *      a hidden field.
 *   3. GET /setup/callback   — GitHub redirects here with `code` + `state`.
 *      We exchange the code for App credentials and persist them encrypted.
 *   4. GET /setup/install    — link out to the installation page.
 *
 * Auth note: in M1 the wizard is open. Before posting reviews on real repos
 * the operator should put it behind a reverse-proxy basic auth or use the
 * planned admin login (M3). The README is explicit about this.
 */
export async function registerSetupRoutes(app: FastifyInstance, deps: SetupDeps): Promise<void> {
  // ── Landing ───────────────────────────────────────────────────────────────
  app.get('/setup', async (_req, reply) => {
    const preflight = preflightPublicUrl(deps.env.PUBLIC_URL);
    sendHtml(
      reply,
      deps.renderer.page('setupLanding.eta', {
        ctx: { title: 'Setup', currentPath: '/setup', csrfToken: 'demo-csrf' },
        suggestedName: 'gcr-bot',
        publicUrl: deps.env.PUBLIC_URL,
        preflight,
      }),
    );
  });

  // ── Manifest form (autosubmits to GitHub) ─────────────────────────────────
  app.post<{ Body: { name: string } }>('/setup/manifest', async (req, reply) => {
    // Preflight before we ship the user off to GitHub. Surfaces the actual
    // problem on our page instead of GitHub's terse rejection. The user must
    // re-edit .env and restart, then re-visit /setup.
    const preflight = preflightPublicUrl(deps.env.PUBLIC_URL);
    if (!preflight.ok) {
      reply.code(400).type('text/html; charset=utf-8').send(`<!doctype html>
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
      // Persist — the private key and webhook secret are encrypted.
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
    sendHtml(
      reply,
      `<!doctype html><html><body><h1>App created</h1>
<p>Install it on the repos you want to review:</p>
<p><a class="btn" href="https://github.com/apps/${encodeURIComponent(slug)}/installations/new">Install on GitHub →</a></p>
<p>After installation completes, return to <a href="/repositories">/repositories</a>.</p>
</body></html>`,
    );
  });

  // ── Stub: receive installation events from the worker (ManifestSync) ──────
  app.get('/setup/done', async (_req, reply) => {
    reply.redirect('/repositories');
  });

  // ── Configuration status — at-a-glance "is the bot ready?" ────────────────
  // Renders HTML for the operator. `Accept: application/json` returns the
  // same data as JSON for the `pnpm gcr smoke` CLI. This is the page to
  // open first when something looks off.
  app.get('/setup/status', async (req, reply) => {
    const checks = await collectStatusChecks(deps);
    const allOk = checks.every((c) => c.status !== 'fail');
    if (req.headers.accept?.includes('application/json')) {
      reply
        .code(allOk ? 200 : 503)
        .type('application/json')
        .send({ ok: allOk, checks });
      return;
    }
    sendHtml(
      reply,
      deps.renderer.page('setupStatus.eta', {
        ctx: { title: 'Status', currentPath: '/setup/status' },
        checks,
        allOk,
      }),
    );
  });

  // Helper accessible to tests for upserting installation rows.
  app.post<{ Body: { installationId: number; repos: Array<{ id: number; owner: string; name: string }> } }>(
    '/setup/_dev/install_repos',
    async (req, reply) => {
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
    },
  );
}

function sendHtml(reply: FastifyReply, html: string): void {
  reply.code(200).type('text/html; charset=utf-8').send(html);
}

/** Minimal HTML escaper for embedding env values into error pages. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface StatusCheck {
  readonly name: string;
  readonly description: string;
  readonly status: 'ok' | 'warn' | 'fail';
  readonly detail: string;
}

/**
 * Collect every "is X configured?" check the operator might care about. The
 * list is intentionally short and human-readable — anything that's not true
 * is a thing they need to do.
 */
async function collectStatusChecks(deps: SetupDeps): Promise<StatusCheck[]> {
  const out: StatusCheck[] = [];

  const appId = await deps.repos.settings.getPlain<number>('github.app.id');
  const slug = await deps.repos.settings.getPlain<string>('github.app.slug');
  const privateKey = await deps.repos.settings.getSecret('github.app.private_key');
  const webhookSecret = await deps.repos.settings.getSecret('github.app.webhook_secret');
  out.push({
    name: 'GitHub App',
    description: 'App ID, private key, and webhook secret persisted to the settings table.',
    ...(appId && privateKey && webhookSecret
      ? { status: 'ok' as const, detail: `App #${appId} (${slug ?? 'no slug'})` }
      : { status: 'fail' as const, detail: 'Run /setup to register the App.' }),
  });

  const repos = await deps.repos.repositories.list();
  out.push({
    name: 'Tracked repositories',
    description: 'At least one repository the App is installed on.',
    ...(repos.length > 0
      ? { status: 'ok' as const, detail: `${repos.length} tracked.` }
      : {
          status: 'warn' as const,
          detail: 'No repos yet. Install the App on a repo at /setup/install.',
        }),
  });

  out.push(await providerCheck('Claude Code CLI', deps.env.CLAUDE_CODE_BINARY, deps.env.REVIEWER_PROVIDER === 'claude'));
  out.push(await providerCheck('Codex CLI', deps.env.CODEX_BINARY, deps.env.REVIEWER_PROVIDER === 'codex'));

  out.push({
    name: 'Public URL',
    description: 'GitHub posts webhooks to PUBLIC_URL/webhooks/github.',
    status: 'ok',
    detail: deps.env.PUBLIC_URL,
  });

  return out;
}

async function providerCheck(name: string, binary: string, required: boolean): Promise<StatusCheck> {
  const result = await runVersion(binary);
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

function runVersion(binary: string): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
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
