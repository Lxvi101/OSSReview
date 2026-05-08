#!/usr/bin/env node
/**
 * `pnpm gcr smoke` — pre-flight check before opening your first PR.
 *
 * Hits the three "is the system alive?" endpoints and prints a colored
 * report:
 *
 *   - GET /health             process up
 *   - GET /ready              dependencies reachable
 *   - GET /setup/status       configuration completeness (JSON)
 *
 * Exits 0 if everything is green, 1 otherwise. Suitable for `set -e` shell
 * scripts and CI smoke jobs.
 *
 * Defaults to PUBLIC_URL or http://localhost:3000. Override with `--url`.
 */

const url = pickUrl();

const G = (s) => `\x1b[32m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const B = (s) => `\x1b[1m${s}\x1b[0m`;

function pickUrl() {
  const arg = process.argv.find((a) => a.startsWith('--url='));
  if (arg) return arg.slice('--url='.length);
  return process.env.PUBLIC_URL ?? 'http://localhost:3000';
}

async function get(path, accept) {
  const r = await fetch(`${url}${path}`, { headers: accept ? { Accept: accept } : {} });
  let body;
  try {
    body = accept === 'application/json' ? await r.json() : await r.text();
  } catch {
    body = await r.text();
  }
  return { status: r.status, body };
}

let failures = 0;

async function main() {
  process.stdout.write(`Smoke check: ${B(url)}\n\n`);

  // 1. /health — process up?
  try {
    const r = await get('/health');
    if (r.status === 200) process.stdout.write(`  ${G('ok')}  /health\n`);
    else {
      process.stdout.write(`  ${R('fail')} /health (${r.status})\n`);
      failures++;
    }
  } catch (err) {
    process.stdout.write(`  ${R('fail')} /health unreachable: ${err.message}\n`);
    failures++;
    // If the process isn't even up the rest will all fail; bail early.
    process.exit(1);
  }

  // 2. /ready — DB reachable?
  try {
    const r = await get('/ready');
    if (r.status === 200) process.stdout.write(`  ${G('ok')}  /ready\n`);
    else {
      process.stdout.write(`  ${R('fail')} /ready (${r.status}): ${r.body}\n`);
      failures++;
    }
  } catch (err) {
    process.stdout.write(`  ${R('fail')} /ready unreachable: ${err.message}\n`);
    failures++;
  }

  // 3. /setup/status — config complete?
  process.stdout.write('\nConfiguration:\n');
  try {
    const r = await get('/setup/status', 'application/json');
    if (typeof r.body !== 'object' || r.body === null) {
      process.stdout.write(
        `  ${R('fail')} /setup/status returned non-JSON: ${String(r.body).slice(0, 200)}\n`,
      );
      failures++;
    } else {
      for (const c of r.body.checks ?? []) {
        const tag = c.status === 'ok' ? G('ok  ') : c.status === 'warn' ? Y('warn') : R('fail');
        process.stdout.write(`  ${tag} ${c.name.padEnd(22)} ${c.detail}\n`);
        if (c.status === 'fail') failures++;
      }
    }
  } catch (err) {
    process.stdout.write(`  ${R('fail')} /setup/status unreachable: ${err.message}\n`);
    failures++;
  }

  process.stdout.write('\n');
  if (failures === 0) {
    process.stdout.write(
      `${G('All systems go.')} Open a PR on a tracked repo to trigger your first review.\n`,
    );
    process.exit(0);
  }
  process.stdout.write(
    `${R(`${failures} failure(s).`)} Visit ${url}/setup/status for the full report.\n`,
  );
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`smoke: unexpected error: ${err.stack ?? err.message}\n`);
  process.exit(2);
});
