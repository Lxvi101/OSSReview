import type { Clock } from './ports/clock.js';
import { type IsoTimestamp, toIso } from './time.js';

/**
 * Real wall-clock implementation. Composition roots in apps/* construct one
 * and pass it down. Tests use `FixedClock` from `@gcr/core/testing`.
 *
 * `monotonicMs` uses `process.hrtime.bigint` so it is unaffected by NTP slew
 * or DST transitions; safe for measuring durations.
 */
export class SystemClock implements Clock {
  now(): IsoTimestamp {
    return toIso(new Date());
  }

  monotonicMs(): number {
    // hrtime returns nanoseconds. Number.MAX_SAFE_INTEGER ms is ~285,000 years.
    return Number(process.hrtime.bigint() / 1_000_000n);
  }
}
