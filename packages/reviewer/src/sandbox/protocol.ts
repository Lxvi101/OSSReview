/**
 * Wire protocol between worker and sandbox.
 *
 * Input: a single JSON document piped into the container's stdin. Shape
 * `SandboxRequest`. The container's entrypoint reads it, runs Claude, and
 * writes a single JSON document to stdout. Shape `SandboxResponse`.
 *
 * Why JSON-on-stdio rather than HTTP: simpler attack surface (no listening
 * port in the sandbox), trivially observable (`docker logs`), and no need
 * for a second secret to authenticate.
 */

import { z } from 'zod';

export const SandboxRequestSchema = z.object({
  pr: z.object({
    owner: z.string(),
    repo: z.string(),
    number: z.number().int(),
    title: z.string(),
    description: z.string(),
    authorLogin: z.string(),
    headSha: z.string(),
    baseSha: z.string(),
  }),
  diff: z.string(),
  settings: z.object({
    model: z.string().optional(),
    promptAddendum: z.string().optional(),
    maxTurns: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    walClockMs: z.number().int().positive().optional(),
  }),
  /** Workspace dir as seen INSIDE the container (always /workspace in M1). */
  workspaceDir: z.string(),
});

export type SandboxRequest = z.infer<typeof SandboxRequestSchema>;

export const SandboxResponseSchema = z.object({
  ok: z.literal(true),
  result: z.object({
    summary: z.object({
      body: z.string(),
      verdict: z.enum(['approve', 'request_changes', 'comment']),
    }),
    findings: z.array(
      z.object({
        filePath: z.string(),
        lineStart: z.number().int().positive().optional(),
        lineEnd: z.number().int().positive().optional(),
        severity: z.enum(['blocker', 'warning', 'suggestion', 'nit', 'praise']),
        body: z.string(),
        suggestion: z.string().optional(),
        category: z.string().optional(),
      }),
    ),
    meta: z.object({
      reviewerName: z.string(),
      reviewerVersion: z.string(),
      model: z.string().optional(),
      inputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
      cachedInputTokens: z.number().int().nonnegative().optional(),
      costUsdMicros: z.number().int().nonnegative().optional(),
      durationMs: z.number().int().nonnegative(),
    }),
  }),
});

export const SandboxErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

export type SandboxResponse = z.infer<typeof SandboxResponseSchema>;
export type SandboxError = z.infer<typeof SandboxErrorSchema>;

/**
 * Discriminated on `ok` so TS narrows cleanly after `if (parsed.data.ok)`.
 * Plain `z.union` would also work at runtime but produces a type whose
 * fields are all optional, defeating type-safe consumption.
 */
export const SandboxOutputSchema = z.discriminatedUnion('ok', [
  SandboxResponseSchema,
  SandboxErrorSchema,
]);
