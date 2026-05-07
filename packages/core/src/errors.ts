/**
 * Domain errors.
 *
 * Adapters translate their library-specific errors into one of these so the
 * core never has to know what an Octokit `RequestError` looks like.
 */

export class DomainError extends Error {
  override readonly name: string = 'DomainError';
  /** Stable code — safe to switch on, safe to log. */
  readonly code: string;
  /** Optional underlying cause. Use for logs; never include in user-facing strings. */
  override readonly cause?: unknown;

  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

/** A state-machine transition was illegal for the current state. */
export class IllegalStateTransitionError extends DomainError {
  override readonly name = 'IllegalStateTransitionError';
  readonly from: string;
  readonly to: string;

  constructor(from: string, to: string) {
    super('illegal_state_transition', `cannot transition from "${from}" to "${to}"`);
    this.from = from;
    this.to = to;
  }
}

/** A retryable error from an adapter — the worker may re-attempt the job. */
export class RetryableError extends DomainError {
  override readonly name = 'RetryableError';
  readonly delayMs: number | undefined;

  constructor(code: string, message: string, opts: { cause?: unknown; delayMs?: number } = {}) {
    super(code, message, opts.cause);
    this.delayMs = opts.delayMs;
  }
}

/** A terminal error from an adapter — the worker must NOT re-attempt. */
export class FatalError extends DomainError {
  override readonly name = 'FatalError';

  constructor(code: string, message: string, cause?: unknown) {
    super(code, message, cause);
  }
}
