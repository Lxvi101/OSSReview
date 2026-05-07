/**
 * Token-shape redactor.
 *
 * Two layers of defence:
 *   1. pino's structured `redact` removes known sensitive paths (Authorization,
 *      cookies, secret-shaped fields).
 *   2. This regex pass runs over the serialized line as a belt-and-suspenders
 *      catch for tokens that show up in unexpected places (inside an error
 *      message thrown by Octokit, sandbox stdout, etc.).
 *
 * Patterns are conservative but specific — they target known *shapes* of
 * secrets, not "anything that looks long and hex." Earlier versions used a
 * bare `\b[a-f0-9]{32,}\b` catch-all, which was correct for HMAC keys but
 * collateral-damaged every git commit SHA in every log line. We now rely on:
 *
 *   - the structured pino redact for known field names
 *   - shape-specific patterns below for tokens that escape into prose
 *
 * If a brand-new token shape appears, add it here AND add a sentinel to
 * `tests/integration/secretLeak.test.ts`.
 */

const PATTERNS: ReadonlyArray<RegExp> = [
  // Anthropic API keys
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  // GitHub PAT / OAuth / App / Refresh / User-to-server tokens (gh[pousr]_)
  /gh[pousr]_[A-Za-z0-9]{30,}/g,
  // GitHub server-to-server installation tokens are issued in `ghs_…` form
  // (already covered by the line above) and also occasionally as a v1.<hex>
  // shape used by the App auth flow.
  /\bv1\.[a-f0-9]{40,}\b/g,
  // Bearer tokens (Authorization header values that escaped redaction)
  /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/g,
  // JWTs (three base64url segments). Catches the third-segment hex naturally.
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // SECRETS_KEY shape: 64-char lowercase hex. Specific enough to avoid
  // matching git SHAs (which are 40 hex) but catch the at-rest crypto key
  // if it ever leaks.
  /\b[a-f0-9]{64}\b/g,
];

const REDACTED = '[REDACTED]';

export function redactTokens(input: string): string {
  let out = input;
  for (const re of PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

/** pino `redact` paths. Wildcards permitted — see pino docs. */
export const PINO_REDACT_PATHS: ReadonlyArray<string> = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-hub-signature-256"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.secret',
  '*.apiKey',
  '*.api_key',
  '*.privateKey',
  '*.private_key',
  '*.webhookSecret',
  '*.webhook_secret',
];
