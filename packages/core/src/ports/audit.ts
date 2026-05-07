import type { AuditEvent, NewAuditEvent } from '../audit/event.js';

export interface AuditLog {
  /** Append-only. Returns the persisted event. */
  record(event: NewAuditEvent): Promise<AuditEvent>;

  /** Most-recent first. For UI use. */
  list(opts?: { limit?: number; before?: string }): Promise<AuditEvent[]>;
}
