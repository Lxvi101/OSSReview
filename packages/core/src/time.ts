/**
 * Time as ISO-8601 strings everywhere on the wire and at rest.
 *
 * SQLite stores TEXT; we never roundtrip Date to/from epoch ints. This means
 * an operator running `sqlite3 data.sqlite "SELECT created_at FROM ..."` at
 * 2 a.m. on Saturday gets a value they can read.
 */

export type IsoTimestamp = string & { readonly __isoTimestamp: true };

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export function isIsoTimestamp(s: string): s is IsoTimestamp {
  return ISO_RE.test(s);
}

export function toIso(d: Date): IsoTimestamp {
  return d.toISOString() as IsoTimestamp;
}

export function fromIso(s: IsoTimestamp): Date {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid ISO timestamp: ${s}`);
  return d;
}

/** Cast a string from the DB to IsoTimestamp; throws on garbage. */
export function parseIso(s: string): IsoTimestamp {
  if (!isIsoTimestamp(s)) throw new Error(`invalid ISO timestamp: ${s}`);
  return s;
}

/** Subtract two timestamps and return milliseconds. */
export function elapsedMs(start: IsoTimestamp, end: IsoTimestamp): number {
  return fromIso(end).getTime() - fromIso(start).getTime();
}
