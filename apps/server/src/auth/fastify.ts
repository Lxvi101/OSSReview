import type { DB } from '@gcr/storage';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { AuthInstance } from './instance.js';

/**
 * Bridge Better Auth's Web Standards handler into Fastify.
 *
 * Better Auth exposes `auth.handler(Request): Promise<Response>`. We:
 *   1. Build a Web `Request` from the Fastify request,
 *   2. Hand it to the auth handler,
 *   3. Write the resulting `Response` back to the Fastify reply, preserving
 *      multi-valued `Set-Cookie` headers (session + csrf).
 *
 * The pre-handler enforces our "first-user-only signup" policy: while the
 * user table is empty, signups are allowed; once any user exists, the
 * signup endpoint 403s. The library has no built-in concept of this — it
 * lives at the application layer where the decision belongs.
 */
export interface AuthRoutesDeps {
  readonly auth: AuthInstance;
  readonly db: Kysely<DB>;
}

const AUTH_PREFIX = '/api/auth';
const SIGNUP_PATH_PREFIX = '/api/auth/sign-up';

export async function registerAuthRoutes(
  app: FastifyInstance,
  deps: AuthRoutesDeps,
): Promise<void> {
  // Public bootstrap probe — the Login page uses this to decide whether to
  // render the signup form (first boot) or the signin form.
  app.get('/api/auth/can-signup', async () => {
    return { allowed: !(await anyUserExists(deps.db)) };
  });

  app.route({
    method: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    url: `${AUTH_PREFIX}/*`,
    handler: async (req, reply) => {
      if (req.url.startsWith(SIGNUP_PATH_PREFIX) && req.method === 'POST') {
        if (await anyUserExists(deps.db)) {
          reply.code(403).send({ error: 'signups disabled — admin already exists' });
          return;
        }
      }
      const webRequest = fastifyToWebRequest(req);
      const webResponse = await deps.auth.handler(webRequest);
      await writeWebResponse(webResponse, reply);
    },
  });
}

async function anyUserExists(db: Kysely<DB>): Promise<boolean> {
  const row = await db.selectFrom('user').select('id').limit(1).executeTakeFirst();
  return row !== undefined;
}

function fastifyToWebRequest(req: FastifyRequest): Request {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? req.protocol ?? 'http';
  const host = req.hostname ?? 'localhost';
  const url = new URL(req.url, `${proto}://${host}`);

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      for (const item of v) headers.append(k, String(item));
    } else {
      headers.set(k, String(v));
    }
  }

  const init: RequestInit = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const raw = (req.body as { __rawBody?: Buffer } | undefined)?.__rawBody;
    if (raw) {
      init.body = raw;
    } else if (req.body !== undefined && req.body !== null) {
      init.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    }
  }
  return new Request(url, init);
}

async function writeWebResponse(response: Response, reply: FastifyReply): Promise<void> {
  reply.code(response.status);
  const setCookies = response.headers.getSetCookie?.() ?? [];
  if (setCookies.length > 0) {
    reply.raw.setHeader('set-cookie', setCookies);
  }
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') return;
    reply.header(key, value);
  });
  if (response.body) {
    const buf = Buffer.from(await response.arrayBuffer());
    reply.send(buf);
  } else {
    reply.send();
  }
}
