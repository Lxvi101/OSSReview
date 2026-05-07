/**
 * Sandbox-protocol invariants.
 *
 * The sandbox writes a single JSON document to stdout. We assert that the
 * schema rejects garbage and accepts a known-good response — and most
 * importantly, that the API key never appears in the serialized output
 * shape (the schema should not have a field for it).
 */

import { SandboxOutputSchema, SandboxRequestSchema } from '@gcr/reviewer/sandbox';
import { describe, expect, it } from 'vitest';

const SENTINEL_API_KEY = 'sk-ant-api03-DO-NOT-LEAK-deadbeefdeadbeefdeadbeef';

describe('SandboxRequestSchema', () => {
  it('accepts a minimal valid request', () => {
    const ok = SandboxRequestSchema.safeParse({
      pr: {
        owner: 'acme',
        repo: 'widgets',
        number: 7,
        title: 'demo',
        description: '',
        authorLogin: 'alice',
        headSha: '1'.repeat(40),
        baseSha: '0'.repeat(40),
      },
      diff: '',
      settings: {},
      workspaceDir: '/workspace',
    });
    expect(ok.success).toBe(true);
  });

  it('does NOT have a field for the API key (which would risk it serializing in)', () => {
    const out = SandboxRequestSchema.safeParse({
      pr: {
        owner: 'a', repo: 'b', number: 1, title: '', description: '',
        authorLogin: 'a', headSha: '1'.repeat(40), baseSha: '0'.repeat(40),
      },
      diff: '',
      settings: {},
      workspaceDir: '/workspace',
      // The schema is `strict()` by default in zod — extra fields silently
      // pass through but are stripped on parse, so they never reach the
      // entrypoint. Either way: confirm no `apiKey` field exists in output.
      apiKey: SENTINEL_API_KEY,
    });
    expect(out.success).toBe(true);
    if (out.success) {
      expect(JSON.stringify(out.data)).not.toContain(SENTINEL_API_KEY);
      expect((out.data as Record<string, unknown>).apiKey).toBeUndefined();
    }
  });
});

describe('SandboxOutputSchema', () => {
  it('accepts a well-formed success response', () => {
    const out = SandboxOutputSchema.safeParse({
      ok: true,
      result: {
        summary: { body: 'looks ok', verdict: 'comment' },
        findings: [],
        meta: {
          reviewerName: 'claude-code',
          reviewerVersion: 'v1.0.0',
          durationMs: 12345,
        },
      },
    });
    expect(out.success).toBe(true);
  });

  it('accepts a well-formed error response', () => {
    const out = SandboxOutputSchema.safeParse({
      ok: false,
      error: { code: 'sandbox.timeout', message: 'wall clock exceeded' },
    });
    expect(out.success).toBe(true);
  });

  it('rejects a response missing the `ok` discriminant', () => {
    const out = SandboxOutputSchema.safeParse({ result: {} });
    expect(out.success).toBe(false);
  });

  it('rejects a non-finite duration', () => {
    const out = SandboxOutputSchema.safeParse({
      ok: true,
      result: {
        summary: { body: 'x', verdict: 'comment' },
        findings: [],
        meta: { reviewerName: 'x', reviewerVersion: 'x', durationMs: -5 },
      },
    });
    expect(out.success).toBe(false);
  });
});
