#!/usr/bin/env node
/**
 * Entrypoint that runs INSIDE the sandbox container.
 *
 * Lifecycle:
 *   1. Read API key from /etc/secrets/anthropic, then unlink that file.
 *   2. Read SandboxRequest JSON from stdin (one line).
 *   3. Construct ClaudeReviewer and run review().
 *   4. Print SandboxResponse JSON to stdout. Exit 0 on success.
 *   5. On error: print SandboxError JSON to stdout. Exit 1.
 *
 * The container is built so that `node entrypoint.js` IS the only thing the
 * unprivileged process ever does. There is no shell.
 */

import { readFile, unlink } from 'node:fs/promises';
import { ClaudeReviewer } from '../claude/adapter.js';
import type { ReviewerInput } from '../port.js';
import { SandboxRequestSchema, type SandboxResponse, type SandboxError } from './protocol.js';

type ReviewerInputSettings = ReviewerInput['settings'];

async function main(): Promise<void> {
  let apiKey: string;
  try {
    apiKey = (await readFile('/etc/secrets/anthropic', 'utf8')).trim();
  } catch (err) {
    return fail('sandbox.no_api_key', `unable to read /etc/secrets/anthropic: ${describe(err)}`);
  }
  // Unlink immediately so future fork/exec or accidental fs traversal can't
  // re-read it. The variable in our process keeps the value live.
  try {
    await unlink('/etc/secrets/anthropic');
  } catch {
    // best effort
  }

  const raw = await readStdin();
  const parsed = SandboxRequestSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) return fail('sandbox.bad_request', parsed.error.message);
  const req = parsed.data;

  const reviewer = new ClaudeReviewer({
    apiKey,
    defaultModel: req.settings.model ?? 'claude-sonnet-4-5',
  });

  const controller = new AbortController();
  // Honor SIGTERM gracefully: signal abort, give the SDK driver a chance to clean up.
  process.on('SIGTERM', () => controller.abort());
  process.on('SIGINT', () => controller.abort());

  // Drop undefined keys so they don't trip exactOptionalPropertyTypes on the
  // ReviewerInput.settings shape.
  const settings: ReviewerInputSettings = compact(req.settings);

  try {
    const result = await reviewer.review({
      workspaceDir: req.workspaceDir,
      diff: req.diff,
      pr: req.pr,
      settings,
      signal: controller.signal,
    });
    // SandboxResponseSchema treats `findings` as a mutable array; ReviewResult
    // is readonly. The shape is identical at runtime — JSON.stringify doesn't
    // care — so we cast through unknown for the type checker.
    const response = { ok: true as const, result } as unknown as SandboxResponse;
    process.stdout.write(`${JSON.stringify(response)}\n`);
    process.exit(0);
  } catch (err) {
    return fail('sandbox.review_failed', describe(err));
  }
}

/** Strip keys whose value is `undefined` (so exactOptionalPropertyTypes is happy). */
function compact<T>(o: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}

function fail(code: string, message: string): void {
  const err: SandboxError = { ok: false, error: { code, message } };
  process.stdout.write(`${JSON.stringify(err)}\n`);
  process.exit(1);
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

main().catch((err: unknown) => {
  fail('sandbox.unexpected', describe(err));
});
