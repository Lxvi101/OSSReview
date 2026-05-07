import type { Clock, WebhookDeliveryRecord, WebhookDeliveryRepo } from '@gcr/core';
import type { Kysely } from 'kysely';
import type { DB } from '../schema.js';

export class WebhookDeliveryRepository implements WebhookDeliveryRepo {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly clock: Clock,
  ) {}

  async recordIfNew(input: {
    deliveryId: string;
    event: string;
    action: string | null;
    signatureValid: boolean;
    payloadJson: string;
  }): Promise<{ created: boolean }> {
    const result = await this.db
      .insertInto('webhook_deliveries')
      .values({
        delivery_id: input.deliveryId,
        event: input.event,
        action: input.action,
        signature_valid: input.signatureValid ? 1 : 0,
        payload_json: input.payloadJson,
      })
      .onConflict((oc) => oc.column('delivery_id').doNothing())
      .executeTakeFirst();
    return { created: (result.numInsertedOrUpdatedRows ?? 0n) > 0n };
  }

  async markProcessed(deliveryId: string, outcome: string): Promise<void> {
    await this.db
      .updateTable('webhook_deliveries')
      .set({ processed_at: this.clock.now(), processing_outcome: outcome })
      .where('delivery_id', '=', deliveryId)
      .execute();
  }

  async recentInvalidSignatureCount(sinceIso: string): Promise<number> {
    const row = await this.db
      .selectFrom('webhook_deliveries')
      .select((eb) => eb.fn.count<number>('id').as('n'))
      .where('signature_valid', '=', 0)
      .where('received_at', '>=', sinceIso)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  async byDeliveryId(deliveryId: string): Promise<WebhookDeliveryRecord | null> {
    const row = await this.db
      .selectFrom('webhook_deliveries')
      .select(['delivery_id', 'event', 'action', 'payload_json', 'received_at'])
      .where('delivery_id', '=', deliveryId)
      .executeTakeFirst();
    if (!row) return null;
    return {
      deliveryId: row.delivery_id,
      event: row.event,
      action: row.action,
      payloadJson: row.payload_json,
      receivedAt: row.received_at,
    };
  }
}
