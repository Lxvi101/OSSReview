import type { DB } from '@gcr/storage';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';

export interface HealthDeps {
  readonly db: Kysely<DB>;
}

/**
 * /health: the process is up. Cheap, never touches the DB. Used by Docker
 * healthchecks where startup might still be initializing dependencies.
 *
 * /ready: dependencies are reachable. Used by load balancers / orchestrators
 * to gate traffic. Does a SELECT 1 against SQLite.
 */
export async function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps): Promise<void> {
  app.get('/health', async (_req, reply) => {
    reply.code(200).send({ status: 'ok' });
  });

  app.get('/ready', async (_req, reply) => {
    try {
      await deps.db
        .selectNoFrom((eb) => eb.lit(1).as('one'))
        .executeTakeFirstOrThrow();
      reply.code(200).send({ status: 'ready' });
    } catch (err) {
      reply.code(503).send({ status: 'not_ready', error: (err as Error).message });
    }
  });
}
