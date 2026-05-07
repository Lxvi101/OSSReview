import type { Clock } from '@gcr/core';
import type { Kysely } from 'kysely';
import type { DB } from '../schema.js';
import type { SecretBox } from '../secrets/secretBox.js';

/**
 * Generic key-value settings table.
 *
 * Two flavors of write:
 *   - `setPlain(key, value)`: serialize as JSON, store verbatim.
 *   - `setSecret(key, plaintext)`: encrypt with libsodium, store envelope.
 *
 * Reads mirror this with `getPlain` and `getSecret`. The repository never
 * decides which kind a key is — the caller knows.
 */
export class SettingsRepository {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly clock: Clock,
    private readonly secretBox: SecretBox,
  ) {}

  async setPlain(key: string, value: unknown): Promise<void> {
    await this.upsertRaw(key, JSON.stringify(value));
  }

  async getPlain<T>(key: string): Promise<T | null> {
    const row = await this.fetch(key);
    return row ? (JSON.parse(row.value_json) as T) : null;
  }

  async setSecret(key: string, plaintext: string): Promise<void> {
    await this.upsertRaw(key, this.secretBox.encryptToJson(plaintext));
  }

  async getSecret(key: string): Promise<string | null> {
    const row = await this.fetch(key);
    return row ? this.secretBox.decryptFromJson(row.value_json) : null;
  }

  async delete(key: string): Promise<void> {
    await this.db.deleteFrom('settings').where('key', '=', key).execute();
  }

  async list(): Promise<Array<{ key: string; updatedAt: string }>> {
    const rows = await this.db
      .selectFrom('settings')
      .select(['key', 'updated_at'])
      .orderBy('key')
      .execute();
    return rows.map((r) => ({ key: r.key, updatedAt: r.updated_at }));
  }

  private async fetch(key: string) {
    return this.db
      .selectFrom('settings')
      .select(['value_json'])
      .where('key', '=', key)
      .executeTakeFirst();
  }

  private async upsertRaw(key: string, valueJson: string): Promise<void> {
    const now = this.clock.now();
    await this.db
      .insertInto('settings')
      .values({ key, value_json: valueJson, updated_at: now })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value_json: valueJson, updated_at: now }))
      .execute();
  }
}
