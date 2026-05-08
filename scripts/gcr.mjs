#!/usr/bin/env node
/**
 * `gcr` — small operator CLI. Self-contained: opens the SQLite database
 * directly so it works whether or not the server is running.
 *
 *   gcr jobs                 # list recent jobs (any state)
 *   gcr jobs --state failed  # filter by state
 *   gcr jobs requeue <id>    # mark failed → queued; worker picks it up
 *   gcr jobs delete <id>     # hard delete
 *   gcr prune --days 30      # delete completed/failed jobs older than N days
 *   gcr runs --state failed  # list recent review runs
 *   gcr runs cancel <id>     # request cancellation of a running review
 */

import { resolve } from 'node:path';
import Database from 'better-sqlite3';

const DB_PATH = process.env.DATABASE_PATH ?? './data/gcr.sqlite';

const G = (s) => `\x1b[32m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const B = (s) => `\x1b[1m${s}\x1b[0m`;
const D = (s) => `\x1b[2m${s}\x1b[0m`;

function colorState(s) {
  if (s === 'completed') return G(s);
  if (s === 'queued' || s === 'running') return Y(s);
  if (s === 'failed') return R(s);
  if (s === 'cancelled') return D(s);
  return s;
}

function openDb() {
  try {
    return new Database(resolve(DB_PATH), { fileMustExist: true });
  } catch (err) {
    process.stderr.write(`${R('error')}: cannot open ${DB_PATH}: ${err.message}\n`);
    process.stderr.write(
      'set DATABASE_PATH or run from a directory where ./data/gcr.sqlite exists\n',
    );
    process.exit(2);
  }
}

function ago(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return iso;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? `${s.slice(0, n - 1)}…` : s.padEnd(n);
}

function listJobs(db, state) {
  const sql = state
    ? 'SELECT id, name, state, attempts, max_attempts, last_error, enqueued_at, completed_at FROM jobs WHERE state = ? ORDER BY id DESC LIMIT 50'
    : 'SELECT id, name, state, attempts, max_attempts, last_error, enqueued_at, completed_at FROM jobs ORDER BY id DESC LIMIT 50';
  const rows = state ? db.prepare(sql).all(state) : db.prepare(sql).all();
  if (rows.length === 0) {
    process.stdout.write(`${D('no jobs')}\n`);
    return;
  }
  process.stdout.write(
    `${B(pad('ID', 6))} ${B(pad('NAME', 30))} ${B(pad('STATE', 10))} ${B('ATTEMPTS')}  ${B(pad('WHEN', 12))} ${B('ERROR')}\n`,
  );
  for (const r of rows) {
    const when = r.completed_at ?? r.enqueued_at;
    process.stdout.write(
      `${pad(r.id, 6)} ${pad(r.name, 30)} ${pad(colorState(r.state), 19)} ${pad(`${r.attempts}/${r.max_attempts}`, 8)}  ${pad(ago(when), 12)} ${(r.last_error ?? '').slice(0, 80)}\n`,
    );
  }
}

function listRuns(db, state) {
  const sql = state
    ? `SELECT rr.id, rr.state, rr.attempts, rr.error_class, rr.error_message, rr.updated_at,
              repo.owner || '/' || repo.name AS repo_full, pr.github_pr_number AS pr_num
       FROM review_runs rr
       JOIN pull_requests pr ON pr.id = rr.pull_request_id
       JOIN repositories repo ON repo.id = pr.repository_id
       WHERE rr.state = ? ORDER BY rr.id DESC LIMIT 50`
    : `SELECT rr.id, rr.state, rr.attempts, rr.error_class, rr.error_message, rr.updated_at,
              repo.owner || '/' || repo.name AS repo_full, pr.github_pr_number AS pr_num
       FROM review_runs rr
       JOIN pull_requests pr ON pr.id = rr.pull_request_id
       JOIN repositories repo ON repo.id = pr.repository_id
       ORDER BY rr.id DESC LIMIT 50`;
  const rows = state ? db.prepare(sql).all(state) : db.prepare(sql).all();
  if (rows.length === 0) {
    process.stdout.write(`${D('no runs')}\n`);
    return;
  }
  process.stdout.write(
    `${B(pad('ID', 6))} ${B(pad('STATE', 10))} ${B(pad('REPO #PR', 36))} ${B(pad('WHEN', 12))} ${B('ERROR')}\n`,
  );
  for (const r of rows) {
    const where = `${r.repo_full}${r.pr_num ? ` #${r.pr_num}` : ''}`;
    const err = r.error_class
      ? `${r.error_class}${r.error_message ? `: ${r.error_message.slice(0, 60)}` : ''}`
      : '';
    process.stdout.write(
      `${pad(r.id, 6)} ${pad(colorState(r.state), 19)} ${pad(where, 36)} ${pad(ago(r.updated_at), 12)} ${err}\n`,
    );
  }
}

function requeueJob(db, id) {
  const r = db
    .prepare(
      `UPDATE jobs SET state='queued', run_after=strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_by=NULL, locked_at=NULL WHERE id = ? AND state = 'failed'`,
    )
    .run(id);
  if (r.changes === 0) {
    process.stderr.write(`${R('error')}: job ${id} not found or not in 'failed' state\n`);
    process.exit(1);
  }
  process.stdout.write(`${G('ok')} requeued job ${id}\n`);
}

function deleteJob(db, id) {
  const r = db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
  if (r.changes === 0) {
    process.stderr.write(`${R('error')}: job ${id} not found\n`);
    process.exit(1);
  }
  process.stdout.write(`${G('ok')} deleted job ${id}\n`);
}

function cancelRun(db, id) {
  const r = db
    .prepare(
      `UPDATE review_runs SET cancel_requested_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND state IN ('queued','preparing','fetching','reviewing','posting')`,
    )
    .run(id);
  if (r.changes === 0) {
    process.stderr.write(`${R('error')}: run ${id} not found or already terminal\n`);
    process.exit(1);
  }
  process.stdout.write(`${G('ok')} cancel requested for run ${id}; worker will abort within ~2s\n`);
}

function prune(db, days) {
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  const jobs = db
    .prepare(`DELETE FROM jobs WHERE state IN ('completed','failed') AND completed_at < ?`)
    .run(cutoff);
  const runs = db
    .prepare(
      `DELETE FROM review_runs WHERE state IN ('completed','failed','cancelled') AND updated_at < ?`,
    )
    .run(cutoff);
  process.stdout.write(
    `${G('ok')} pruned ${jobs.changes} jobs and ${runs.changes} runs older than ${days}d\n`,
  );
}

function help() {
  process.stdout.write(`gcr — operator CLI

usage:
  gcr jobs [--state STATE]       list recent jobs
  gcr jobs requeue <id>          mark a failed job 'queued'
  gcr jobs delete <id>           hard delete a job

  gcr runs [--state STATE]       list recent review runs
  gcr runs cancel <id>           request cancellation of a running review

  gcr prune --days N             delete completed/failed older than N days

env:
  DATABASE_PATH                  defaults to ./data/gcr.sqlite
`);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    help();
    process.exit(argv.length === 0 ? 64 : 0);
  }
  const cmd = argv[0];
  const sub = argv[1];

  const stateIdx = argv.indexOf('--state');
  const state = stateIdx >= 0 ? argv[stateIdx + 1] : null;

  const daysIdx = argv.indexOf('--days');
  const days = daysIdx >= 0 ? Number.parseInt(argv[daysIdx + 1], 10) : null;

  const db = openDb();
  try {
    if (cmd === 'jobs') {
      if (!sub || sub.startsWith('-')) return listJobs(db, state);
      if (sub === 'requeue') return requeueJob(db, Number.parseInt(argv[2], 10));
      if (sub === 'delete') return deleteJob(db, Number.parseInt(argv[2], 10));
    }
    if (cmd === 'runs') {
      if (!sub || sub.startsWith('-')) return listRuns(db, state);
      if (sub === 'cancel') return cancelRun(db, Number.parseInt(argv[2], 10));
    }
    if (cmd === 'prune') {
      if (!days || !Number.isFinite(days) || days < 1) {
        process.stderr.write(`${R('error')}: --days N (>=1) required\n`);
        process.exit(64);
      }
      return prune(db, days);
    }
    process.stderr.write(`${R('error')}: unknown command\n`);
    help();
    process.exit(64);
  } finally {
    db.close();
  }
}

main();
