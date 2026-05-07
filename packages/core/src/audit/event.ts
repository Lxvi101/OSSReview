import type { AuditEventId } from '../ids.js';
import type { IsoTimestamp } from '../time.js';

/** A persisted audit-log event. Append-only by convention. */
export interface AuditEvent {
  readonly id: AuditEventId;
  readonly at: IsoTimestamp;
  readonly actor: string;
  readonly kind: AuditKind;
  readonly subjectType: string | null;
  readonly subjectId: string | null;
  readonly data: Readonly<Record<string, unknown>>;
}

/** What the audit log can record. New kinds: append, never reuse. */
export type AuditKind =
  | 'repo.added'
  | 'repo.removed'
  | 'repo.settings_updated'
  | 'review.queued'
  | 'review.skipped'
  | 'review.started'
  | 'review.posted'
  | 'review.failed'
  | 'review.retried'
  | 'review.cancelled'
  | 'webhook.received'
  | 'webhook.signature_invalid'
  | 'secrets.rotated'
  | 'admin.signed_in'
  | 'admin.signed_out'
  | 'cost.cap_reached';

/** What an adapter receives when something needs auditing. */
export interface NewAuditEvent {
  readonly actor: string;
  readonly kind: AuditKind;
  readonly subjectType?: string | null;
  readonly subjectId?: string | null;
  readonly data?: Record<string, unknown>;
}
