/**
 * @gcr/storage — Kysely + better-sqlite3 + numbered raw-SQL migrations.
 *
 * Composition root usage:
 *   const handle = openDatabase({ path });
 *   runMigrations(handle);
 *   const repos = makeRepositories(handle.kysely, { clock, secretBox });
 *   // ... use handle.kysely for queries; handle.sqlite for raw access ...
 *   await handle.destroy();   // closes both
 */

export * from './db.js';
export * from './schema.js';
export * from './secrets/secretBox.js';
export * from './repositories/index.js';
export { runMigrations, currentVersion } from './migrations/run.js';
