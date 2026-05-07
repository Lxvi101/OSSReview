import type { IdGenerator } from '../ports/ids.js';

/** Deterministic id generator for tests. Sequential UUIDs. */
export class FakeIdGenerator implements IdGenerator {
  private uuidCounter = 0;
  private hexCounter = 0;

  uuid(): string {
    this.uuidCounter++;
    const n = this.uuidCounter.toString(16).padStart(12, '0');
    return `00000000-0000-4000-8000-${n}`;
  }

  hex(lengthChars: number): string {
    this.hexCounter++;
    return this.hexCounter.toString(16).padStart(lengthChars, '0').slice(0, lengthChars);
  }
}
