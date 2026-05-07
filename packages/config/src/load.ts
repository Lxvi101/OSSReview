import { type BootEnv, BootEnvSchema } from './schema.js';

/** Exit code for "configuration error" per sysexits.h. */
export const EX_CONFIG = 78;

/**
 * Validate `process.env` against the boot schema.
 *
 * On success: returns the parsed env.
 * On failure: prints a single human-readable block to stderr and exits 78.
 *
 * Tests can call `parseBootEnv(env)` directly to inspect errors.
 */
export function loadBootEnv(env: NodeJS.ProcessEnv = process.env): BootEnv {
  const result = parseBootEnv(env);
  if (!result.ok) {
    process.stderr.write(formatErrors(result.errors));
    process.exit(EX_CONFIG);
  }
  return result.value;
}

export type ParseResult =
  | { ok: true; value: BootEnv }
  | { ok: false; errors: ReadonlyArray<{ path: string; message: string }> };

export function parseBootEnv(env: NodeJS.ProcessEnv): ParseResult {
  const result = BootEnvSchema.safeParse(env);
  if (result.success) return { ok: true, value: result.data };
  const errors = result.error.errors.map((e) => ({
    path: e.path.join('.') || '(root)',
    message: e.message,
  }));
  return { ok: false, errors };
}

function formatErrors(errors: ReadonlyArray<{ path: string; message: string }>): string {
  const lines: string[] = [
    '',
    '────────────────────────────────────────────────────────────────',
    ' Configuration error: invalid or missing environment variables',
    '────────────────────────────────────────────────────────────────',
  ];
  for (const e of errors) {
    lines.push(`  ${e.path}: ${e.message}`);
  }
  lines.push('');
  lines.push(' See .env.example for the complete list. Refusing to start.');
  lines.push('────────────────────────────────────────────────────────────────');
  lines.push('');
  return lines.join('\n');
}
