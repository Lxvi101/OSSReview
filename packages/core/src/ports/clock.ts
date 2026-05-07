import type { IsoTimestamp } from '../time.js';

/**
 * Clock — the domain reads time through this so tests can pin it.
 *
 * Real implementation: `new SystemClock()`. Tests: `new FixedClock("2026-...")`
 * (see `core/testing/fixtures.ts`).
 */
export interface Clock {
  now(): IsoTimestamp;
  /** Monotonic millisecond ticks, for measuring durations safely across DST/leap. */
  monotonicMs(): number;
}
