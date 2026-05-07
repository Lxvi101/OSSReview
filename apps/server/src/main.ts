/**
 * Composition root for the HTTP tier.
 *
 * Wires:
 *   env → logger
 *       → SQLite (open + migrate)
 *       → SecretBox + Repositories
 *       → JobQueue
 *       → Webhook handler (uses Repositories + Queue + Audit)
 *       → Web routes
 *       → /health /ready /metrics
 *       → Fastify boot
 *
 * No globals. Everything is constructor-injected so a 2030 reader can swap
 * pieces in tests by passing different deps.
 */

import { loadBootEnv } from '@gcr/config';
import { SystemClock } from '@gcr/core';
import { Metrics, buildLogger } from '@gcr/observability';
import { JobQueue } from '@gcr/queue';
import { SecretBox, makeRepositories, openDatabase, runMigrations } from '@gcr/storage';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const env = loadBootEnv();
  const logger = buildLogger({ level: env.LOG_LEVEL, nodeEnv: env.NODE_ENV });
  logger.info({ node: process.version, pid: process.pid }, 'server.boot');

  const handle = openDatabase({ path: env.DATABASE_PATH });
  runMigrations(handle, { logger });

  const clock = new SystemClock();
  const secretBox = new SecretBox(env.SECRETS_KEY);
  const repos = makeRepositories(handle.kysely, { clock, secretBox });
  const queue = new JobQueue(handle.kysely, clock);
  const metrics = new Metrics();

  const app = await buildApp({
    env,
    logger,
    db: handle.kysely,
    repos,
    queue,
    metrics,
    clock,
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'server.shutdown');
    try {
      await app.close();
    } finally {
      await handle.destroy();
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  logger.info({ port: env.PORT, publicUrl: env.PUBLIC_URL }, 'server.listening');
}

void main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
