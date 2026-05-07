import type { BootEnv } from '@gcr/config';
import type { Clock } from '@gcr/core';
import type { Logger, Metrics } from '@gcr/observability';
import type { JobQueue } from '@gcr/queue';
import type { DB, Repositories } from '@gcr/storage';
import { STATIC_DIR, WebRenderer } from '@gcr/web';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import staticPlugin from '@fastify/static';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { registerHealthRoutes } from './http/health.js';
import { registerMetricsRoutes } from './http/metrics.js';
import { registerSetupRoutes } from './http/setup.js';
import { registerUiRoutes } from './http/ui.js';
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

export async function buildApp(deps: BuildAppDeps): Promise<FastifyInstance> {
  // Fastify v5's `FastifyBaseLogger` shape diverges slightly from pino's
  // exported `Logger` type (`msgPrefix` on child loggers). At runtime they're
  // the same object — we cast at the boundary to silence the type checker.
  const app = Fastify({
    loggerInstance: deps.logger as unknown as FastifyBaseLogger,
    bodyLimit: 8 * 1024 * 1024, // GitHub webhooks can be ~5MB on big PRs
    disableRequestLogging: false,
    trustProxy: true,
  });

  // Capture raw body for webhook signature verification BEFORE Fastify
  // dispatches to handlers. We add the raw bytes onto the request as
  // `request.rawBody` for `/webhooks/*` routes only.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    try {
      const buf = body as Buffer;
      const json = buf.length === 0 ? {} : JSON.parse(buf.toString('utf8'));
      // Stash the raw body for routes that need it (webhooks).
      (json as { __rawBody?: Buffer }).__rawBody = buf;
      done(null, json);
    } catch (err) {
      done(err as Error);
    }
  });

  await app.register(formbody);
  await app.register(cookie, { secret: deps.env.SESSION_SECRET });
  await app.register(staticPlugin, { root: STATIC_DIR, prefix: '/static/' });

  const renderer = new WebRenderer();

  await registerHealthRoutes(app, deps);
  await registerMetricsRoutes(app, deps);
  await registerWebhookRoutes(app, deps);
  await registerUiRoutes(app, { ...deps, renderer });
  await registerSetupRoutes(app, { ...deps, renderer });

  // 404 handler — the dashboard for a known route, plain text otherwise.
  app.setNotFoundHandler((req, reply) => {
    reply.code(404).type('text/plain').send(`not found: ${req.url}\n`);
  });

  return app;
}
