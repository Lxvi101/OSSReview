/**
 * GitHub App manifest flow.
 *
 * The manifest creation flow lets a one-click setup register the App with
 * predeclared permissions, webhook URL/secret, and event subscriptions.
 * Manual creation is a 12-field foot-gun.
 *
 * Sequence:
 *   1. UI POSTs an HTML form to https://github.com/settings/apps/new with the
 *      manifest in a hidden field. (See apps/server/src/web/setup/* for the form.)
 *   2. GitHub redirects back to `/setup/callback?code=...&state=...`.
 *   3. The server exchanges `code` via POST /app-manifests/{code}/conversions.
 *      The response contains `id`, `pem`, `webhook_secret`, etc.
 *   4. The server persists those (encrypted) and the App is ready to install.
 *
 * This module owns:
 *   - Manifest builder
 *   - URL preflight (GitHub's manifest validator rejects localhost / .local / 127.0.0.1)
 *   - Code-to-credentials exchange
 */

export interface ManifestBuilderInput {
  readonly name: string;
  readonly publicUrl: string; // PUBLIC_URL from env
  readonly description?: string;
}

export interface AppManifest {
  readonly name: string;
  readonly url: string;
  readonly hook_attributes: { readonly url: string };
  readonly redirect_url: string;
  readonly callback_urls: ReadonlyArray<string>;
  readonly public: boolean;
  readonly default_permissions: Readonly<Record<string, 'read' | 'write'>>;
  readonly default_events: ReadonlyArray<string>;
  readonly description?: string;
}

export function buildManifest(input: ManifestBuilderInput): AppManifest {
  return {
    name: input.name,
    url: input.publicUrl,
    hook_attributes: { url: `${input.publicUrl}/webhooks/github` },
    redirect_url: `${input.publicUrl}/setup/callback`,
    callback_urls: [`${input.publicUrl}/setup/callback`],
    public: false,
    // Permission set kept minimal:
    //   pull_requests: write — post review + comments
    //   issues:        write — react with `eyes` on the comment that triggered a re-run
    //   contents:      read  — clone the repo
    //   metadata:      read  — required for any App
    default_permissions: {
      pull_requests: 'write',
      issues: 'write',
      contents: 'read',
      metadata: 'read',
    },
    // ONLY user-subscribable events go here. `installation` and
    // `installation_repositories` are App-level lifecycle events that GitHub
    // sends automatically to the webhook URL — they cannot appear in
    // default_events (the manifest validator rejects them).
    default_events: ['pull_request', 'issue_comment'],
    ...(input.description ? { description: input.description } : {}),
  };
}

export interface UrlPreflightOk {
  readonly ok: true;
  readonly url: string;
}
export interface UrlPreflightFail {
  readonly ok: false;
  readonly reason: string;
  readonly suggestion: string;
}
export type UrlPreflight = UrlPreflightOk | UrlPreflightFail;

/**
 * Verify a candidate `PUBLIC_URL` is acceptable to GitHub's manifest
 * validator BEFORE we send the user off to fill in the form. Surfaces an
 * actionable error in the UI instead of GitHub's terse rejection page.
 *
 * GitHub's hard requirements (verified against their validator output):
 *   - https:// scheme (http allowed for `localhost` only — but localhost
 *     itself is rejected as not-publicly-reachable)
 *   - hostname must resolve from the open internet
 *   - cannot be `localhost`, `127.0.0.1`, `::1`, `*.local`, or an RFC1918 address
 */
export function preflightPublicUrl(input: string): UrlPreflight {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return {
      ok: false,
      reason: `"${input}" is not a valid URL.`,
      suggestion:
        'Set PUBLIC_URL to something like https://smee.io/abc123 or https://your-domain.example.',
    };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return {
      ok: false,
      reason: `unsupported scheme: ${url.protocol}`,
      suggestion: 'Use https:// (recommended) or http://.',
    };
  }

  const host = url.hostname.toLowerCase();
  const unreachable =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.endsWith('.local') ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);

  if (unreachable) {
    return {
      ok: false,
      reason: `${host} is not reachable from the public internet — GitHub's webhook deliveries can't reach it.`,
      suggestion:
        'For local development, use a webhook proxy: visit https://smee.io/new, copy the channel URL, ' +
        'set PUBLIC_URL=<that URL> in .env, restart the stack, then run a smee client to forward to ' +
        'localhost:3000/webhooks/github. The README has the exact command.',
    };
  }

  return { ok: true, url: url.toString().replace(/\/$/, '') };
}

export interface ConvertedManifest {
  readonly id: number;
  readonly slug: string;
  readonly client_id: string;
  readonly client_secret: string;
  readonly webhook_secret: string;
  readonly pem: string;
  readonly html_url: string;
}

export async function exchangeManifestCode(code: string): Promise<ConvertedManifest> {
  // Use native fetch — this is a one-shot, unauthenticated POST and pulling
  // in @octokit/request just for it would be wasteful.
  const url = `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'github-code-reviewer',
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`manifest exchange failed (${res.status}): ${body.slice(0, 500)}`);
  }
  return (await res.json()) as ConvertedManifest;
}
