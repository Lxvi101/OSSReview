import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthInstance } from './instance.js';

/**
 * onRequest hook that 401s on any /api or /setup request without a valid
 * session. Public paths (auth, webhooks, health, metrics, static assets)
 * pass through untouched.
 *
 * The bootstrap (very first signup) flow works because:
 *   - /api/auth/* is on the public list,
 *   - the fastify route in auth/fastify.ts enforces "first-user-only" on the
 *     signup path itself.
 */
export interface RequireAuthOptions {
  readonly auth: AuthInstance;
}

const PUBLIC_PREFIXES: ReadonlyArray<string> = [
  '/api/auth/',
  '/webhooks/',
  '/health',
  '/ready',
  '/metrics',
];

const PROTECTED_PREFIXES: ReadonlyArray<string> = ['/api/', '/setup/'];

export function buildRequireAuth(opts: RequireAuthOptions) {
  return async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const path = req.url.split('?', 1)[0] ?? req.url;
    if (!PROTECTED_PREFIXES.some((p) => path.startsWith(p))) return;
    if (PUBLIC_PREFIXES.some((p) => path.startsWith(p))) return;

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) {
        for (const item of v) headers.append(k, String(item));
      } else {
        headers.set(k, String(v));
      }
    }

    const session = await opts.auth.api.getSession({ headers });
    if (session) return;

    const accept = req.headers.accept ?? '';
    if (accept.includes('text/html')) {
      reply.redirect(`/login?next=${encodeURIComponent(req.url)}`);
      return;
    }
    reply.code(401).send({ error: 'authentication required' });
  };
}
