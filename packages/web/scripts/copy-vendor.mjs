#!/usr/bin/env node
/**
 * Copy pinned vendor JS into `dist/static/` at build time.
 *
 * Why this script vs. fetching at runtime:
 *   - Versions are pinned in package.json (`htmx.org` and `alpinejs`).
 *   - pnpm's lockfile gives us reproducible installs.
 *   - The build is hermetic: no network needed at deploy time.
 *
 * The companion `scripts/fetch-vendor-assets.mjs` at the repo root is a
 * fallback for environments that prefer not to install the npm packages
 * (e.g. air-gapped builds with a checked-in static asset).
 */

import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const DIST_STATIC = join(here, '..', 'dist', 'static');
mkdirSync(DIST_STATIC, { recursive: true });

const COPIES = [
  // htmx.org ships its dist as the package main; resolve and walk one up.
  {
    name: 'htmx.min.js',
    from: require.resolve('htmx.org/dist/htmx.min.js'),
  },
  // alpinejs ships its CDN build as `dist/cdn.min.js`.
  {
    name: 'alpine.min.js',
    from: require.resolve('alpinejs/dist/cdn.min.js'),
  },
];

for (const c of COPIES) {
  const dest = join(DIST_STATIC, c.name);
  copyFileSync(c.from, dest);
  process.stdout.write(`copied ${c.name} ← ${c.from}\n`);
}
