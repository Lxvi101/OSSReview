#!/usr/bin/env node
/**
 * Fetch pinned htmx and Alpine.js builds into packages/web/src/static/.
 *
 * Run once after `pnpm install`, and whenever the pinned versions change.
 * Both files are checked into source so the build is hermetic at deploy time.
 *
 * Why pin to a specific version (with SRI):
 *   - 2036-readability: a hard-pinned version means the UI today runs the
 *     same JS in 2036 if the registry is gone.
 *   - Supply-chain: the SRI hash means a tampered CDN can't slip code past us.
 *
 * Run: `node scripts/fetch-vendor-assets.mjs`
 */

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = join(here, '..', 'packages', 'web', 'src', 'static');

const ASSETS = [
  {
    name: 'htmx.min.js',
    version: '2.0.4',
    url: 'https://unpkg.com/htmx.org@2.0.4/dist/htmx.min.js',
    // SRI hash: paste the value reported below the first time you run this
    // script (the verification step prints "expected: <hash>"). Once set,
    // mismatches will fail the run.
    sha384: 'wS5l5IKJBvK6sPTKa2WZ1js3d947pvWXbPJ1OmWfEuxLgeHcEbjUUA5i9V5ZkpCw',
  },
  {
    name: 'alpine.min.js',
    version: '3.14.3',
    url: 'https://unpkg.com/alpinejs@3.14.3/dist/cdn.min.js',
    sha384: 'qWyT1HWOX59RQwlH0Q0X07fT/3Ea5vSEJa5DYg72N3qe8wT2TDpTEMlV5/9G4eaU',
  },
];

let failures = 0;
for (const asset of ASSETS) {
  process.stdout.write(`fetching ${asset.name} (${asset.version})… `);
  try {
    const res = await fetch(asset.url);
    if (!res.ok) {
      process.stdout.write(`HTTP ${res.status}\n`);
      failures++;
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const got = createHash('sha384').update(buf).digest('base64');
    if (asset.sha384 && asset.sha384 !== got) {
      process.stdout.write(`SRI mismatch\n  expected: ${asset.sha384}\n  got:      ${got}\n`);
      failures++;
      continue;
    }
    if (!asset.sha384) {
      process.stdout.write(`fetched.\n  expected: ${got}\n  Set asset.sha384 to that value to lock in.\n`);
    }
    await writeFile(join(STATIC_DIR, asset.name), buf);
    process.stdout.write(asset.sha384 ? `ok (${buf.length} bytes)\n` : 'wrote unverified\n');
  } catch (err) {
    process.stdout.write(`failed: ${err instanceof Error ? err.message : String(err)}\n`);
    failures++;
  }
}

process.exit(failures > 0 ? 1 : 0);
