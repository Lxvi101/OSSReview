import type { Clock } from '../ports/clock.js';
import { type IsoTimestamp, parseIso, toIso } from '../time.js';

/** A pinnable clock. `advance(ms)` for tests. */
export class FixedClock implements Clock {
  private current: Date;
  private monotonic: number;

  constructor(start: string | Date = '2026-01-01T00:00:00.000Z', monotonicStart = 0) {
    this.current = typeof start === 'string' ? new Date(parseIso(start)) : start;
    this.monotonic = monotonicStart;
  }

  now(): IsoTimestamp {
    return toIso(this.current);
  }

  monotonicMs(): number {
    return this.monotonic;
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
    this.monotonic += ms;
  }
}

// `SystemClock` lives in `../clock.ts` because it is a production class.
// Re-exported here for backward compatibility with imports of @gcr/core/testing.
export { SystemClock } from '../clock.js';
