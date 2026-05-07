import type { DeliveryId, WebhookDeliveryId } from '../ids.js';
import type { IsoTimestamp } from '../time.js';

/** A persisted GitHub webhook delivery. The payload is held verbatim; this row is evidence. */
export interface WebhookDelivery {
  readonly id: WebhookDeliveryId;
  readonly deliveryId: DeliveryId; // X-GitHub-Delivery
  readonly event: string;
  readonly action: string | null;
  readonly signatureValid: boolean;
  readonly payloadJson: string;
  readonly receivedAt: IsoTimestamp;
  readonly processedAt: IsoTimestamp | null;
  readonly processingOutcome: string | null;
}
