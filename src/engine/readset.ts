// What a query read and what a mutation wrote, so realtime can rerun only the
// subscriptions a write can affect. Matching mirrors the SQL the query ran:
// json_extract turns booleans into 1/0 and missing fields into NULL, and
// SQLite orders NULL < numbers < text.
import type { Document } from "./store.ts";

export type SqlValue = string | number | null;

export interface Bound {
  value: SqlValue;
  inclusive: boolean;
}

/** Rows of `table` where every `eq` holds and `field` lies within the bounds. No conditions = whole table. */
export interface RangeRead {
  kind: "range";
  table: string;
  eq: [field: string, value: SqlValue][];
  range?: { field: string; lower?: Bound; upper?: Bound };
}

export interface DocRead {
  kind: "doc";
  table: string;
  id: string;
}

export type ReadSet = RangeRead | DocRead;

export type Change =
  | { table: string; id: string; before: Document | null; after: Document | null }
  /** A write the engine cannot describe per document (e.g. a bulk SQL delete). */
  | { table: string; all: true };

export function toSqlValue(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "string") return value;
  // json_extract returns objects and arrays as JSON text.
  return JSON.stringify(value);
}

function fieldValue(doc: Document, path: string): SqlValue {
  let value: unknown = doc;
  for (const part of path.split(".")) {
    if (typeof value !== "object" || value === null) return null;
    value = (value as Record<string, unknown>)[part];
  }
  return toSqlValue(value);
}

const rank = (v: SqlValue) => (v === null ? 0 : typeof v === "number" ? 1 : 2);

function compare(a: SqlValue, b: SqlValue): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (a === null || b === null) return 0;
  return a < b ? -1 : a > b ? 1 : 0;
}

function inRange(doc: Document, read: RangeRead): boolean {
  for (const [field, value] of read.eq) {
    const actual = fieldValue(doc, field);
    if (value === null ? actual !== null : actual === null || compare(actual, value) !== 0) return false;
  }
  if (read.range) {
    const actual = fieldValue(doc, read.range.field);
    // In SQL a comparison with NULL is never true.
    if (actual === null) return false;
    const { lower, upper } = read.range;
    if (lower && lower.value !== null) {
      const c = compare(actual, lower.value);
      if (c < 0 || (c === 0 && !lower.inclusive)) return false;
    }
    if (upper && upper.value !== null) {
      const c = compare(actual, upper.value);
      if (c > 0 || (c === 0 && !upper.inclusive)) return false;
    }
  }
  return true;
}

/** Could `change` alter the result of a query that made `read`? */
export function affects(read: ReadSet, change: Change): boolean {
  if (read.table !== change.table) return false;
  if ("all" in change) return true;
  if (read.kind === "doc") return read.id === change.id;
  // Before and after both count: a document moving out of a range changes the result too.
  return (!!change.before && inRange(change.before, read)) || (!!change.after && inRange(change.after, read));
}
