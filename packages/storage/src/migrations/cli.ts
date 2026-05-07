#!/usr/bin/env node
/**
 * `pnpm gcr db migrate` (and `--dry-run`).
 *
 * Reads DATABASE_PATH from process.env. Validation deliberately minimal here —
 * the long-running app does the full BootEnv parse, this CLI just needs to
 * point at a file.
 */

import { openDatabase } from '../db.js';
import { runMigrations } from './run.js';

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd !== 'up') {
    process.stderr.write(`usage: gcr-migrate up [--dry-run]\n`);
    process.exit(64);
  }
  const dryRun = process.argv.includes('--dry-run');
  const path = process.env.DATABASE_PATH;
  if (!path) {
    process.stderr.write('DATABASE_PATH is required\n');
    process.exit(78);
  }

  const db = openDatabase({ path });
  try {
    const { applied } = runMigrations(db, {
      dryRun,
      logger: {
        info(obj: object, msg: string) {
          process.stdout.write(`${msg} ${JSON.stringify(obj)}\n`);
        },
      },
    });
    process.stdout.write(`done. applied=${applied.length}\n`);
  } finally {
    await db.destroy();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`migrate failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
