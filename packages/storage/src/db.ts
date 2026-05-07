import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database, { type Database as BetterSqliteDatabase } from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import type { DB } from './schema.js';

export interface OpenDatabaseOptions {
  /** Filesystem path or `:memory:` for tests. */
  readonly path: string;
  /** Override pragmas. Defaults are tuned for production. */
  readonly pragmas?: Record<string, string | number>;
  /** Read-only handle (e.g. for the metrics endpoint). */
  readonly readonly?: boolean;
}

/**
 * The handle returned by `openDatabase`.
 *
 * `kysely` is what 99% of code reads/writes through. `sqlite` is the raw
 * better-sqlite3 handle, exposed because the migration runner needs `exec()`
 * for multi-statement SQL files (Kysely's executor doesn't support that),
 * and ad-hoc operator scripts find it useful.
 *
 * `destroy()` cleans up both handles atomically.
 */
export interface DatabaseHandle {
  readonly kysely: Kysely<DB>;
  readonly sqlite: BetterSqliteDatabase;
  destroy(): Promise<void>;
}

/**
 * Open a tuned SQLite database wrapped in a Kysely instance.
 *
 * Pragmas (overridable via `opts.pragmas`):
 *   - journal_mode=WAL     concurrent readers + 1 writer; the production model.
 *   - synchronous=NORMAL   safe with WAL, faster than FULL with no real
 *                          durability loss for the kind of crash we care about.
 *   - busy_timeout=5000    ride out brief contention, surface true deadlocks.
 *   - foreign_keys=ON      SQLite default is OFF — always turn it on.
 *   - temp_store=MEMORY    tmp tables in RAM, not disk.
 *   - mmap_size=256MB      cheaper reads on big DBs.
 */
export function openDatabase(opts: OpenDatabaseOptions): DatabaseHandle {
  // First-run convenience: ensure the parent directory exists. better-sqlite3
  // surfaces a baffling "Cannot open database because the directory does not
  // exist" otherwise, and this is the most common first-install snag with
  // bind-mounted compose volumes (the host path doesn't exist yet on Docker
  // Desktop for Mac, which doesn't auto-create them). Idempotent; cheap.
  // Skipped for the in-memory database used by tests.
  if (opts.path !== ':memory:') {
    mkdirSync(dirname(opts.path), { recursive: true });
  }

  const sqlite = new Database(opts.path, opts.readonly ? { readonly: true } : {});

  const pragmas: Record<string, string | number> = {
    journal_mode: 'WAL',
    synchronous: 'NORMAL',
    busy_timeout: 5000,
    foreign_keys: 'ON',
    temp_store: 'MEMORY',
    mmap_size: 256 * 1024 * 1024,
    ...opts.pragmas,
  };
  for (const [k, v] of Object.entries(pragmas)) {
    sqlite.pragma(`${k} = ${v}`);
  }

  const kysely = new Kysely<DB>({ dialect: new SqliteDialect({ database: sqlite }) });

  return {
    kysely,
    sqlite,
    async destroy() {
      await kysely.destroy();
      sqlite.close();
    },
  };
}
