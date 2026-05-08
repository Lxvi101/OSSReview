import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import staticPlugin from '@fastify/static';
import type { BootEnv } from '@gcr/config';
import type { Clock } from '@gcr/core';
import type { Logger, Metrics } from '@gcr/observability';
import type { JobQueue } from '@gcr/queue';
import type { DB, Repositories } from '@gcr/storage';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { registerApiRoutes } from './http/api.js';
import { registerHealthRoutes } from './http/health.js';
import { registerMetricsRoutes } from './http/metrics.js';
import { registerSetupRoutes } from './http/setup.js';
import { registerWebhookRoutes } from './http/webhooks.js';

export interface BuildAppDeps {
  readonly env: BootEnv;
  readonly logger: Logger;
  readonly db: Kysely<DB>;
  readonly repos: Repositories;
  readonly queue: JobQueue;
  readonly metrics: Metrics;
  readonly clock: Clock;
}

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the dashboard build directory.
 *
 * - In a Docker image we copy `apps/dashboard/dist` next to `apps/server/dist`.
 * - In dev (`pnpm dev:server`) the file lives at `apps/dashboard/dist`
 *   relative to the repo root, two `..`s above `apps/server/dist`.
 *
 * Allow `DASHBOARD_DIST` to override for unusual layouts.
 */
function resolveDashboardDist(env: BootEnv): string {
  if (env.DASHBOARD_DIST) return resolve(env.DASHBOARD_DIST);
  // dist/app.js → ../../../dashboard/dist  (when running compiled JS)
  // src/app.ts  → ../../../dashboard/dist  (when running --watch / ts)
  return resolve(here, '../../dashboard/dist');
}

export async function buildApp(deps: BuildAppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: deps.logger as unknown as FastifyBaseLogger,
    bodyLimit: 8 * 1024 * 1024,
    disableRequestLogging: false,
    trustProxy: true,
  });

  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    try {
      const buf = body as Buffer;
      const json = buf.length === 0 ? {} : JSON.parse(buf.toString('utf8'));
      (json as { __rawBody?: Buffer }).__rawBody = buf;
      done(null, json);
    } catch (err) {
      done(err as Error);
    }
  });

  await app.register(formbody);
  await app.register(cookie, { secret: deps.env.SESSION_SECRET });

  // Serve the React SPA build at /. Static asset paths (e.g. /assets/foo.js)
  // are served from disk; unknown paths fall through to the not-found
  // handler, which returns index.html so client-side routing works.
  const dashboardDist = resolveDashboardDist(deps.env);
  await app.register(staticPlugin, {
    root: dashboardDist,
    prefix: '/',
    wildcard: false,
  });

  await registerHealthRoutes(app, deps);
  await registerMetricsRoutes(app, deps);
  await registerWebhookRoutes(app, deps);
  await registerApiRoutes(app, deps);
  await registerSetupRoutes(app, deps);

  // SPA fallback: any GET that doesn't match a registered route OR a static
  // asset returns the dashboard index.html. API/webhook/health requests get
  // a JSON 404 instead so client tooling sees a real error.
  app.setNotFoundHandler(async (req, reply) => {
    const accept = req.headers.accept ?? '';
    const isApiPath =
      req.url.startsWith('/api/') ||
      req.url.startsWith('/webhooks/') ||
      req.url === '/health' ||
      req.url === '/ready' ||
      req.url === '/metrics';
    if (req.method !== 'GET' || isApiPath || !accept.includes('text/html')) {
      reply.code(404).type('application/json').send({ error: 'not found', path: req.url });
      return;
    }
    reply.code(200).type('text/html; charset=utf-8');
    return reply.sendFile('index.html', dashboardDist);
  });

  return app;
}
