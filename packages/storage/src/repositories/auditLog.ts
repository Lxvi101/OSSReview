import {
  type AuditEvent,
  type AuditKind,
  type AuditLog,
  type Clock,
  type NewAuditEvent,
  asAuditEventId,
  parseIso,
} from '@gcr/core';
import type { Kysely } from 'kysely';
import type { DB } from '../schema.js';

export class AuditLogRepository implements AuditLog {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly clock: Clock,
  ) {}

  async record(event: NewAuditEvent): Promise<AuditEvent> {
    const at = this.clock.now();
    const inserted = await this.db
      .insertInto('audit_events')
      .values({
        actor: event.actor,
        kind: event.kind,
        subject_type: event.subjectType ?? null,
        subject_id: event.subjectId ?? null,
        data_json: JSON.stringify(event.data ?? {}),
        at,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.toDomain(inserted);
  }

  async list(opts: { limit?: number; before?: string } = {}): Promise<AuditEvent[]> {
    let q = this.db
      .selectFrom('audit_events')
      .selectAll()
      .orderBy('at', 'desc')
      .limit(opts.limit ?? 100);
    if (opts.before) q = q.where('at', '<', opts.before);
    const rows = await q.execute();
    return rows.map((r) => this.toDomain(r));
  }

  private toDomain(row: {
    id: number;
    at: string;
    actor: string;
    kind: string;
    subject_type: string | null;
    subject_id: string | null;
    data_json: string;
  }): AuditEvent {
    return {
      id: asAuditEventId(row.id),
      at: parseIso(row.at),
      actor: row.actor,
      kind: row.kind as AuditKind,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      data: JSON.parse(row.data_json),
    };
  }
}
