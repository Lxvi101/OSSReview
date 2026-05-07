import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import type { DatabaseHandle } from '../db.js';

/**
 * Tiny migration runner. Forward-only. Each `NNNN_<slug>.sql` is applied in
 * a single transaction and recorded in the `migrations` table.
 *
 * Why hand-rolled: a 60-line runner is easier to read in 2036 than a Knex
 * dependency that may have been deprecated.
 *
 * Both functions accept either:
 *   - the full `DatabaseHandle` returned by `openDatabase`, or
 *   - the underlying better-sqlite3 instance directly,
 * which keeps the call sites short while not coupling tests to the handle
 * shape.
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

type DbInput = DatabaseHandle | BetterSqliteDatabase;

function asSqlite(db: DbInput): BetterSqliteDatabase {
  return 'sqlite' in db ? db.sqlite : db;
}

export function listMigrations(): Migration[] {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/migrations/sql in production; src/migrations/sql in dev (vitest).
  const candidates = [join(here, 'sql'), join(here, '..', '..', 'src', 'migrations', 'sql')];
  let dir: string | null = null;
  for (const c of candidates) {
    try {
      readdirSync(c);
      dir = c;
      break;
    } catch {
      // try next
    }
  }
  if (!dir) throw new Error(`migrations directory not found near ${here}`);

  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  return files.map((f) => {
    const m = f.match(/^(\d{4})_(.+)\.sql$/);
    if (!m) throw new Error(`bad migration filename: ${f}`);
    return {
      version: Number.parseInt(m[1]!, 10),
      name: m[2]!,
      sql: readFileSync(join(dir!, f), 'utf8'),
    };
  });
}

export function currentVersion(db: DbInput): number {
  const sqlite = asSqlite(db);
  // The `migrations` table may not exist yet — handle that.
  const exists = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='migrations'")
    .get();
  if (!exists) return 0;
  const row = sqlite.prepare('SELECT MAX(version) AS v FROM migrations').get() as
    | { v: number | null }
    | undefined;
  return row?.v ?? 0;
}

export interface RunOptions {
  readonly dryRun?: boolean;
  readonly logger?: { info: (o: object, msg: string) => void };
}

export function runMigrations(db: DbInput, opts: RunOptions = {}): { applied: number[] } {
  const sqlite = asSqlite(db);
  const all = listMigrations();
  const current = currentVersion(sqlite);
  const pending = all.filter((m) => m.version > current);

  if (pending.length === 0) {
    opts.logger?.info({ current }, 'migrations: up to date');
    return { applied: [] };
  }

  if (opts.dryRun) {
    opts.logger?.info({ pending: pending.map((m) => m.version) }, 'migrations: dry run');
    return { applied: [] };
  }

  const applied: number[] = [];
  for (const m of pending) {
    sqlite.exec('BEGIN');
    try {
      sqlite.exec(m.sql);
      // 0001_init creates the migrations ledger as part of the same tx, so
      // recording the migration is safe even on the first run.
      sqlite
        .prepare(
          "INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        )
        .run(m.version, m.name);
      sqlite.exec('COMMIT');
      applied.push(m.version);
      opts.logger?.info({ version: m.version, name: m.name }, 'migration: applied');
    } catch (err) {
      sqlite.exec('ROLLBACK');
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`migration ${m.version}_${m.name} failed: ${message}`);
    }
  }
  return { applied };
}
