/**
 * Random/uuid generation as a port.
 *
 * Why: predictable correlation IDs in tests, swappable RNG.
 */
export interface IdGenerator {
  /** RFC 4122 v4 UUID. */
  uuid(): string;
  /** Cryptographically-strong random hex of the requested length (in chars). */
  hex(lengthChars: number): string;
}
