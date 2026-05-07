import { triage } from '@gcr/core';
import { verifyWebhookSignature } from '@gcr/github';
import { type Metrics, withContextAsync } from '@gcr/observability';
import type { JobQueue } from '@gcr/queue';
import type { DB, Repositories } from '@gcr/storage';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';

/**
 * The webhook ingress.
 *
 * Target p99 < 100ms. Strategy:
 *
 *   1. Read raw body. Verify HMAC. Reject 401 on failure with no DB write
 *      (an attacker hammering us with bad sigs costs us a hash, not a write).
 *   2. ONE transaction:
 *        a. INSERT INTO webhook_deliveries ON CONFLICT(delivery_id) DO NOTHING.
 *           If it was a redelivery, mark the outcome and short-circuit.
 *        b. Triage. If we're enqueueing, INSERT INTO jobs in the same tx.
 *        c. UPDATE webhook_deliveries SET processed_at, processing_outcome.
 *      Either delivery+job both exist or neither does.
 *   3. Return 202.
 */
export interface WebhookDeps {
  readonly repos: Repositories;
  readonly queue: JobQueue;
  readonly db: Kysely<DB>;
  readonly metrics: Metrics;
}

export async function registerWebhookRoutes(
  app: FastifyInstance,
  deps: WebhookDeps,
): Promise<void> {
  app.post('/webhooks/github', async (req, reply) => {
    const deliveryId = String(req.headers['x-github-delivery'] ?? '');
    const event = String(req.headers['x-github-event'] ?? '');
    const signatureHeader = req.headers['x-hub-signature-256'] as string | undefined;

    if (!deliveryId || !event) {
      deps.metrics.webhookInvalidSignatureTotal.inc();
      return reply.code(400).send({ error: 'missing required headers' });
    }

    const secret = await deps.repos.settings.getSecret('github.app.webhook_secret');
    if (!secret) {
      // App not configured yet — this is a setup-state error, not a security one.
      return reply.code(503).send({ error: 'github app not yet configured' });
    }

    const rawBody = (req.body as { __rawBody?: Buffer })?.__rawBody;
    if (!rawBody) {
      deps.metrics.webhookInvalidSignatureTotal.inc();
      return reply.code(400).send({ error: 'missing body' });
    }

    if (!verifyWebhookSignature({ secret, rawBody, signatureHeader })) {
      deps.metrics.webhookInvalidSignatureTotal.inc();
      void deps.repos.auditLog.record({
        actor: 'webhook',
        kind: 'webhook.signature_invalid',
        subjectType: 'delivery',
        subjectId: deliveryId,
        data: { event, ip: req.ip },
      });
      req.log.warn({ deliveryId, event }, 'webhook.signature_invalid');
      return reply.code(401).send({ error: 'invalid signature' });
    }

    // Strip the raw-body shim before serializing the persisted payload.
    const body = req.body as Record<string, unknown> & { __rawBody?: Buffer };
    delete body.__rawBody;

    const action = (body.action as string | undefined) ?? null;
    const payloadJson = JSON.stringify(body);

    const botLogin = (await deps.repos.settings.getPlain<string>('github.app.bot_login')) ?? 'gcr';
    const decision = triage({ event, action, payload: body, botLogin });

    return withContextAsync({ deliveryId }, async () => {
      const outcome = await deps.db.transaction().execute(async (tx) => {
        const inserted = await tx
          .insertInto('webhook_deliveries')
          .values({
            delivery_id: deliveryId,
            event,
            action,
            signature_valid: 1,
            payload_json: payloadJson,
          })
          .onConflict((oc) => oc.column('delivery_id').doNothing())
          .executeTakeFirst();

        if ((inserted.numInsertedOrUpdatedRows ?? 0n) === 0n) {
          // Already seen — short-circuit.
          return 'duplicate' as const;
        }

        let outcomeStr: string;
        switch (decision.kind) {
          case 'enqueue_review':
            await deps.queue.enqueueIn(tx, {
              name: 'review_pr',
              data: { deliveryId },
              uniqueKey: `webhook:${deliveryId}`,
              maxAttempts: 5,
              priority: 0,
            });
            outcomeStr = 'enqueued:review';
            break;
          case 'enqueue_mention_review':
            await deps.queue.enqueueIn(tx, {
              name: 'review_pr_mention',
              data: { deliveryId },
              uniqueKey: `webhook:${deliveryId}`,
              maxAttempts: 5,
              priority: 5,
            });
            outcomeStr = 'enqueued:mention';
            break;
          case 'install_repos':
            await deps.queue.enqueueIn(tx, {
              name: 'sync_installation_repos',
              data: { deliveryId },
              uniqueKey: `webhook:${deliveryId}`,
              maxAttempts: 5,
            });
            outcomeStr = 'enqueued:install_sync';
            break;
          case 'ignore':
            outcomeStr = `ignored:${decision.reason}`;
            break;
        }

        await tx
          .updateTable('webhook_deliveries')
          .set({
            processed_at: new Date().toISOString(),
            processing_outcome: outcomeStr,
          })
          .where('delivery_id', '=', deliveryId)
          .execute();

        return outcomeStr;
      });

      deps.metrics.webhookDeliveriesTotal.inc({ event, outcome });
      reply.code(202).send({ outcome });
    });
  });
}
