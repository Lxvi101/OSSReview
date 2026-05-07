import { Writable } from 'node:stream';
import pino, { type Logger as PinoLogger } from 'pino';
import { getContext } from './context.js';
import { PINO_REDACT_PATHS, redactTokens } from './redact.js';

export type Logger = PinoLogger;

export interface LoggerOptions {
  readonly level?: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  readonly nodeEnv?: 'development' | 'production' | 'test';
  /** Stream override — used in tests to capture lines. */
  readonly stream?: NodeJS.WritableStream;
}

/**
 * Build the root logger.
 *
 * Two layers of secret redaction:
 *
 * Layer 1 — pino's `redact`: removes known sensitive *fields* by JSON path
 * (`req.headers.authorization`, `*.password`, etc).
 *
 * Layer 2 — a `Writable` wrapper around the destination stream: runs
 * `redactTokens` on every byte chunk before forwarding. This catches token
 * shapes that land in unexpected places — error messages, third-party log
 * lines piped to us, anything pino's path-based redact can't see. Only the
 * final serialized JSON is scanned, so it costs one regex pass per line.
 *
 * The `mixin` injects the AsyncLocalStorage correlation context into every
 * log line so we don't need `logger.child(...)` at every call site.
 */
export function buildLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? 'info';
  const destination: NodeJS.WritableStream = opts.stream ?? process.stdout;
  const wrapped = wrapWithRedactor(destination);

  return pino(
    {
      level,
      base: { pid: process.pid, app: 'gcr' },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: [...PINO_REDACT_PATHS], censor: '[REDACTED]' },
      mixin() {
        return getContext();
      },
      formatters: {
        level(label) {
          return { level: label };
        },
      },
    },
    wrapped,
  );
}

/**
 * Sit between pino and its destination. Redact on the way through.
 *
 * Pino emits one chunk per log line, so per-chunk redaction is safe — a
 * token will not straddle two chunks.
 */
function wrapWithRedactor(downstream: NodeJS.WritableStream): NodeJS.WritableStream {
  return new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      downstream.write(redactTokens(s), cb);
    },
  });
}
