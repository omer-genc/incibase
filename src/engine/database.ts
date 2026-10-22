import type { Database } from "bun:sqlite";
import { z } from "zod";
import { IncibaseError } from "../errors.ts";
import { FIELD_PATH_REGEX, type IndexDefinition } from "../schema.ts";
import type { Identity } from "./engine.ts";
import { syncFiles } from "./files.ts";
import { databaseFullError, isDatabaseFull } from "./limits.ts";
import { logEvent } from "./log.ts";
import type { Change, RangeRead, ReadSet } from "./readset.ts";
import { fieldExpr, quoteIdent, rowToDoc, type Document, type DocumentRow, type Store, type TableInfo } from "./store.ts";

type Primitive = string | number | boolean | null;
type Op = "eq" | "gt" | "gte" | "lt" | "lte";
const SQL_OPS: Record<Op, string> = { eq: "=", gt: ">", gte: ">=", lt: "<", lte: "<=" };
const BATCH_SIZE = 256;

export class ValidationError extends Error {
  constructor(
    message: string,
    readonly issues: z.core.$ZodIssue[] = [],
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

function toSqlValue(value: unknown, field: string): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" || typeof value === "number") return value;
  throw new Error(`Field "${field}" can only be compared with strings, numbers, booleans or null`);
}

function condition(field: string, op: Op, value: unknown, params: unknown[]): string {
  const sqlValue = toSqlValue(value, field);
  if (sqlValue === null) {
    if (op !== "eq") throw new Error(`Cannot use ${op} with null on "${field}"`);
    return `${fieldExpr(field)} IS NULL`;
  }
  params.push(sqlValue);
  return `${fieldExpr(field)} ${SQL_OPS[op]} ?`;
}

class IndexRangeBuilder {
  readonly ops: { field: string; op: Op; value: unknown }[] = [];
  private eqCount = 0;
  private rangeField: string | null = null;

  constructor(private readonly fields: string[]) {}

  private push(field: string, op: Op, value: unknown) {
    if (op === "eq") {
      if (this.rangeField !== null) throw new Error(`.eq("${field}") cannot follow a range condition`);
      if (this.fields[this.eqCount] !== field) {
        throw new Error(`.eq("${field}") must follow the index field order (${this.fields.join(", ")})`);
      }
      this.eqCount++;
    } else {
      const expected = this.fields[this.eqCount];
      if (this.rangeField !== null && this.rangeField !== field) {
        throw new Error(`Range conditions must all be on "${this.rangeField}"`);
      }
      if (expected !== field) {
        throw new Error(`.${op}("${field}") must be on the next index field "${expected ?? "(none)"}"`);
      }
      this.rangeField = field;
    }
    this.ops.push({ field, op, value });
    return this;
  }

  eq(field: string, value: unknown) {
    return this.push(field, "eq", value);
  }
  gt(field: string, value: unknown) {
    return this.push(field, "gt", value);
  }
  gte(field: string, value: unknown) {
    return this.push(field, "gte", value);
  }
  lt(field: string, value: unknown) {
    return this.push(field, "lt", value);
  }
  lte(field: string, value: unknown) {
    return this.push(field, "lte", value);
  }
}

function encodeCursor(values: unknown[]): string {
  return Buffer.from(JSON.stringify(values)).toString("base64url");
}

function decodeCursor(cursor: string): unknown[] {
  try {
    const values = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (Array.isArray(values)) return values;
  } catch {}
  throw new IncibaseError({ code: "INVALID_CURSOR", message: "Invalid pagination cursor" });
}

export class QueryBuilder {
  private index: IndexDefinition | null = null;
  private rangeOps: { field: string; op: Op; value: unknown }[] = [];
  private whereOps: { field: string; value: unknown }[] = [];
  private predicates: ((doc: any) => boolean)[] = [];
  private direction: "asc" | "desc" = "asc";

  constructor(
    private readonly session: DbSession,
    private readonly table: TableInfo,
  ) {}

  withIndex(name: string, range?: (q: IndexRangeBuilder) => unknown) {
    if (this.index) throw new Error("withIndex can only be called once");
    const index =
      name === "by_creation_time"
        ? { name, fields: ["_creationTime"], unique: false }
        : this.table.indexes.find((i) => i.name === name);
    if (!index) throw new Error(`Table "${this.table.name}" has no index "${name}"`);
    this.index = index;
    if (range) {
      const builder = new IndexRangeBuilder(index.fields);
      range(builder);
      this.rangeOps.push(...builder.ops);
    }
    return this;
  }

  where(fields: Record<string, unknown>) {
    for (const [field, value] of Object.entries(fields)) {
      // Keys often come from callers (filters built from args), and they end up in SQL.
      if (field !== "_id" && field !== "_creationTime" && !FIELD_PATH_REGEX.test(field)) {
        throw new IncibaseError({ code: "INVALID_FIELD", message: `where(): "${field}" is not a field name or dotted field path` });
      }
      if (value === undefined) continue;
      toSqlValue(value, field); // validate early
      this.whereOps.push({ field, value });
    }
    return this;
  }

  filter(predicate: (doc: any) => boolean) {
    this.predicates.push(predicate);
    return this;
  }

  order(direction: "asc" | "desc") {
    if (direction !== "asc" && direction !== "desc") throw new Error(`Invalid order "${direction}"`);
    this.direction = direction;
    return this;
  }

  /** The rows this query can see, for realtime invalidation (JS filters only narrow it further). */
  private readRange(): RangeRead {
    const read: RangeRead = { kind: "range", table: this.table.name, eq: [] };
    for (const op of this.rangeOps) {
      const value = toSqlValue(op.value, op.field);
      if (op.op === "eq") {
        read.eq.push([op.field, value]);
        continue;
      }
      read.range ??= { field: op.field };
      const bound = { value, inclusive: op.op === "gte" || op.op === "lte" };
      if (op.op === "gt" || op.op === "gte") read.range.lower = bound;
      else read.range.upper = bound;
    }
    for (const w of this.whereOps) read.eq.push([w.field, toSqlValue(w.value, w.field)]);
    return read;
  }

  private orderColumns(): string[] {
    const fields = this.index && this.index.name !== "by_creation_time" ? this.index.fields : [];
    return [...fields.map(fieldExpr), "_creationTime", "_id"];
  }

  /** Runs the query in keyset-paginated batches so JS filters never hold a statement open. */
  private fetch(max: number, after: unknown[] | null): { docs: Document[]; last: unknown[] | null; done: boolean } {
    this.session.track(this.readRange());
    const cols = this.orderColumns();
    const dir = this.direction === "asc" ? "ASC" : "DESC";
    const docs: Document[] = [];
    let last = after;
    const filtering = this.predicates.length > 0;

    while (true) {
      const params: unknown[] = [];
      const where = [
        ...this.rangeOps.map((c) => condition(c.field, c.op, c.value, params)),
        ...this.whereOps.map((c) => condition(c.field, "eq", c.value, params)),
      ];
      if (last) {
        if (last.length !== cols.length) throw new IncibaseError({ code: "INVALID_CURSOR", message: "Cursor does not match this query" });
        where.push(`(${cols.join(", ")}) ${this.direction === "asc" ? ">" : "<"} (${cols.map(() => "?").join(", ")})`);
        params.push(...last);
      }
      const limit = filtering ? BATCH_SIZE : Math.min(max - docs.length, Number.MAX_SAFE_INTEGER);
      const sql =
        `SELECT _id, _creationTime, data, ${cols.map((c, i) => `${c} AS c${i}`).join(", ")} FROM ${quoteIdent(this.table.name)}` +
        (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
        ` ORDER BY ${cols.map((c) => `${c} ${dir}`).join(", ")}` +
        (Number.isFinite(limit) ? ` LIMIT ${limit}` : "");
      const rows = this.session.conn.query(sql).all(...(params as any[])) as (DocumentRow & Record<string, unknown>)[];

      for (const row of rows) {
        const doc = rowToDoc(row);
        last = cols.map((_, i) => row[`c${i}`]);
        if (this.predicates.every((p) => p(doc))) {
          this.session.loadedIds.add(doc._id);
          docs.push(doc);
          if (docs.length >= max) {
            return { docs, last, done: rows.length < limit && row === rows.at(-1) };
          }
        }
      }
      if (!filtering || rows.length < limit) return { docs, last, done: true };
    }
  }

  async collect() {
    return this.fetch(Infinity, null).docs;
  }

  async take(n: number) {
    if (!Number.isInteger(n) || n < 0) throw new Error("take(n) needs a non-negative integer");
    if (n === 0) return [];
    return this.fetch(n, null).docs;
  }

  async first() {
    return (await this.take(1))[0] ?? null;
  }

  async unique() {
    const docs = await this.take(2);
    if (docs.length > 1) throw new Error(`unique() matched more than one document in "${this.table.name}"`);
    return docs[0] ?? null;
  }

  async count() {
    return this.fetch(Infinity, null).docs.length;
  }

  async paginate(options: { cursor: string | null; numItems: number }) {
    if (!Number.isInteger(options.numItems) || options.numItems < 1) throw new Error("numItems must be a positive integer");
    const after = options.cursor ? decodeCursor(options.cursor) : null;
    const { docs, last, done } = this.fetch(options.numItems, after);
    return { page: docs, continueCursor: last ? encodeCursor(last) : (options.cursor ?? ""), isDone: done };
  }
}

/**
 * One function execution's view of the database. Records which tables were
 * read (for realtime invalidation) and written (to know whom to notify).
 */
export class DbSession {
  /** What this execution read; a subscription reruns only when a change affects one of these. */
  readonly reads: ReadSet[] = [];
  /** Documents this transaction wrote, with their before/after state. */
  readonly changes: Change[] = [];
  /** Documents this execution loaded; their private files may be handed out (see storage.getUrl). */
  readonly loadedIds = new Set<string>();
  private readonly commitHooks: (() => void)[] = [];

  constructor(
    readonly store: Store,
    readonly conn: Database,
    readonly writable: boolean,
    /** Who writes; undefined for trusted engine code. */
    readonly identity?: Identity,
  ) {}

  track(read: ReadSet) {
    this.reads.push(read);
  }

  /** For writes made with raw SQL that touch an unknown set of documents. */
  markTableChanged(table: string) {
    this.changes.push({ table, all: true });
  }

  onCommit(hook: () => void) {
    this.commitHooks.push(hook);
  }

  runCommitHooks() {
    for (const hook of this.commitHooks) {
      try {
        hook();
      } catch (err) {
        logEvent("error", { ev: "commit_hook_error", err }, ["[incibase] commit hook failed:", err]);
      }
    }
  }

  private tableNamed(name: string): TableInfo {
    const table = this.store.tables.get(name);
    if (!table) throw new Error(`Unknown table "${name}"`);
    return table;
  }

  private tableOf(id: string): TableInfo {
    const table = typeof id === "string" ? this.store.tableOfId(id) : null;
    if (!table) throw new IncibaseError({ code: "INVALID_ID", message: `Invalid document id "${id}"` });
    return table;
  }

  private writableTable(id: string): TableInfo {
    const table = this.tableOf(id);
    if (table.system) throw new Error(`System table "${table.name}" is read-only`);
    return table;
  }

  private assertWritable() {
    if (!this.writable) throw new Error("Database writes are only allowed in mutations");
    // SQLite rolls the whole transaction back on some errors (SQLITE_FULL); a write after that would commit on its own.
    if (!this.conn.inTransaction) {
      throw new Error("This mutation's transaction was rolled back by an earlier error (e.g. DATABASE_FULL); it cannot write any more");
    }
  }

  private validate(table: TableInfo, value: unknown): string {
    return this.validated(table, value).data;
  }

  private validated(table: TableInfo, value: unknown): { data: string; value: Record<string, unknown> } {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ValidationError(`Document for "${table.name}" must be an object`);
    }
    for (const key of Object.keys(value)) {
      if (key.startsWith("_")) throw new ValidationError(`System field "${key}" cannot be written`);
    }
    if (!table.validator) return { data: JSON.stringify(value), value: value as Record<string, unknown> };
    const result = table.validator.safeParse(value);
    if (!result.success) {
      throw new ValidationError(`Invalid document for "${table.name}":\n${z.prettifyError(result.error)}`, result.error.issues);
    }
    return { data: JSON.stringify(result.data), value: result.data };
  }

  private load(table: TableInfo, id: string): Document | null {
    const row = this.conn
      .query(`SELECT _id, _creationTime, data FROM ${quoteIdent(table.name)} WHERE _id = ?`)
      .get(id) as DocumentRow | null;
    if (!row) return null;
    this.loadedIds.add(id);
    return rowToDoc(row);
  }

  private unique<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      const message = (err as Error).message ?? "";
      if (message.includes("UNIQUE constraint failed")) {
        throw new IncibaseError({ code: "UNIQUE_VIOLATION", message: "A document with the same unique index value exists" });
      }
      if (isDatabaseFull(err)) throw databaseFullError();
      throw err;
    }
  }

  async get(tableOrId: string, maybeId?: string): Promise<Document | null> {
    const id = maybeId ?? tableOrId;
    const table = this.store.tableOfId(id);
    if (!table || (maybeId !== undefined && table.name !== tableOrId)) return null;
    this.track({ kind: "doc", table: table.name, id });
    return this.load(table, id);
  }

  query(table: string) {
    return new QueryBuilder(this, this.tableNamed(table));
  }

  normalizeId(table: string, id: string): string | null {
    return this.store.tableOfId(id)?.name === table ? id : null;
  }

  async insert(tableName: string, value: unknown): Promise<string> {
    this.assertWritable();
    const table = this.tableNamed(tableName);
    if (table.system) throw new Error(`System table "${tableName}" is read-only`);
    const { data, value: parsed } = this.validated(table, value);
    const id = this.insertRaw(table, data);
    syncFiles(this, table, id, null, parsed);
    return id;
  }

  async patch(id: string, value: Record<string, unknown>): Promise<void> {
    this.assertWritable();
    const table = this.writableTable(id);
    const current = this.load(table, id);
    if (!current) throw new IncibaseError({ code: "NOT_FOUND", message: `Document "${id}" not found` });
    if (typeof value !== "object" || value === null) throw new ValidationError("patch value must be an object");
    const { _id, _creationTime, ...fields } = current;
    for (const [key, v] of Object.entries(value)) {
      if (key === "_id" || key === "_creationTime") {
        if (v !== undefined && v !== current[key]) throw new ValidationError(`System field "${key}" cannot be changed`);
        continue;
      }
      if (v === undefined) delete fields[key];
      else fields[key] = v;
    }
    const { data, value: parsed } = this.validated(table, fields);
    this.updateRaw(table, id, data);
    syncFiles(this, table, id, current, parsed);
  }

  async replace(id: string, value: Record<string, unknown>): Promise<void> {
    this.assertWritable();
    const table = this.writableTable(id);
    const current = this.load(table, id);
    if (!current) throw new IncibaseError({ code: "NOT_FOUND", message: `Document "${id}" not found` });
    const { _id, _creationTime, ...fields } = value ?? {};
    const { data, value: parsed } = this.validated(table, fields);
    this.updateRaw(table, id, data);
    syncFiles(this, table, id, current, parsed);
  }

  async delete(id: string): Promise<void> {
    this.assertWritable();
    const table = this.writableTable(id);
    const current = this.load(table, id);
    this.deleteRaw(table, id);
    syncFiles(this, table, id, current, null);
  }

  // Unvalidated writes, used by the engine (system tables, admin tools).

  insertRaw(table: TableInfo, data: string, id = this.store.newId(table)): string {
    this.assertWritable();
    const creationTime = this.store.nextCreationTime();
    this.unique(() =>
      this.conn
        .query(`INSERT INTO ${quoteIdent(table.name)} (_id, _creationTime, data) VALUES (?, ?, ?)`)
        .run(id, creationTime, data),
    );
    this.changes.push({ table: table.name, id, before: null, after: rowToDoc({ _id: id, _creationTime: creationTime, data }) });
    return id;
  }

  updateRaw(table: TableInfo, id: string, data: string) {
    this.assertWritable();
    const before = this.load(table, id);
    this.unique(() => this.conn.query(`UPDATE ${quoteIdent(table.name)} SET data = ? WHERE _id = ?`).run(data, id));
    if (before) {
      const after = rowToDoc({ _id: id, _creationTime: before._creationTime, data });
      this.changes.push({ table: table.name, id, before, after });
    }
  }

  deleteRaw(table: TableInfo, id: string) {
    this.assertWritable();
    const before = this.load(table, id);
    const result = this.conn.query(`DELETE FROM ${quoteIdent(table.name)} WHERE _id = ?`).run(id);
    if (result.changes === 0) throw new IncibaseError({ code: "NOT_FOUND", message: `Document "${id}" not found` });
    this.changes.push({ table: table.name, id, before, after: null });
  }

  systemTable(name: string): TableInfo {
    return this.tableNamed(name);
  }

  /** The object handed to function code as `ctx.db`. */
  reader() {
    return {
      get: this.get.bind(this),
      query: this.query.bind(this),
      normalizeId: this.normalizeId.bind(this),
    };
  }

  writer() {
    return {
      ...this.reader(),
      insert: this.insert.bind(this),
      patch: this.patch.bind(this),
      replace: this.replace.bind(this),
      delete: this.delete.bind(this),
    };
  }
}
