import { z } from 'zod';

/**
 * Zod schema for the `submit_findings` tool's input.
 *
 * The Claude Code SDK validates tool inputs against this schema before
 * surfacing them. If the model returns malformed output we get an explicit
 * error rather than silent garbage — and we can give the model one repair
 * turn (see adapter.ts).
 */

export const FindingSchema = z.object({
  filePath: z
    .string()
    .min(1)
    .max(2048)
    .refine((p) => !p.includes('..') && !p.startsWith('/'), 'must be repo-relative POSIX path'),
  lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().positive().optional(),
  severity: z.enum(['blocker', 'warning', 'suggestion', 'nit', 'praise']),
  body: z.string().min(1).max(10_000),
  suggestion: z.string().max(50_000).optional(),
  category: z.string().max(64).optional(),
});

export const SubmitFindingsInputSchema = z.object({
  summary: z.object({
    body: z.string().min(1).max(20_000),
    verdict: z.enum(['approve', 'request_changes', 'comment']),
  }),
  findings: z.array(FindingSchema).max(200),
});

export type SubmitFindingsInput = z.infer<typeof SubmitFindingsInputSchema>;
