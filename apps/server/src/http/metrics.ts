import type { Metrics } from '@gcr/observability';
import type { FastifyInstance } from 'fastify';

export interface MetricsDeps {
  readonly metrics: Metrics;
}

/**
 * /metrics — Prometheus text format.
 *
 * In production we bind the metrics endpoint to a separate listener
 * (METRICS_BIND, defaults to localhost-only) — at that point this route
 * disappears from the public-facing app. For M1 it's exposed here behind
 * the same listener; ADR 0003 documents the intended split.
 */
export async function registerMetricsRoutes(
  app: FastifyInstance,
  deps: MetricsDeps,
): Promise<void> {
  app.get('/metrics', async (_req, reply) => {
    const body = await deps.metrics.render();
    reply.code(200).type('text/plain; version=0.0.4').send(body);
  });
}
