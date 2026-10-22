import { z } from "zod";
import type { IndexDefinition, SchemaDefinition } from "../schema.ts";
import { collectHeldIds, storageFieldsOf, WRAPPERS } from "./files.ts";
import { EXIT_CODE, ExitCode } from "./exit-codes.ts";
import { toJsonSchema } from "./jsonschema.ts";
import { logEvent } from "./log.ts";
import { FIRST_USER_TABLE_NUMBER, quoteIdent, type DocumentRow, type Store } from "./store.ts";

/** A stored field the new schema no longer has. */
export interface RemovedField {
  table: string;
  /** Dotted path; `[]` stands for array items and `*` for record values, e.g. `items[].sku`, `prices.*.old`. */
  field: string;
  /** Documents that hold a value for it. */
  documents: number;
}

export interface MigrationOptions {
  /** Let the migration delete stored fields the schema no longer has; otherwise it is refused. */
  allowFieldRemoval?: boolean;
  /** Documents re-validated per page (default PAGE_SIZE); only tests change it. */
  pageSize?: number;
}

/** Documents a re-validation holds in memory at once: it reads each table in pages of this many. */
export const PAGE_SIZE = 5000;

export interface MigrationReport {
  createdTables: string[];
  deactivatedTables: string[];
  addedIndexes: string[];
  droppedIndexes: string[];
  /** Documents rewritten because the new schema changed their stored form (defaults, removed fields). */
  rewrittenDocuments: number;
  /** Fields whose stored data was deleted (only with `allowFieldRemoval`). */
  removedFields: RemovedField[];
}

type Problem = { table: string; id: string; message: string };

const LISTED = 20;
/** Problems a refused migration keeps in full; the rest are only counted, so a table of invalid documents cannot exhaust memory. */
const KEPT_PROBLEMS = 1000;

function describeProblems(problems: Problem[], removedFields: RemovedField[], problemCount = problems.length) {
  const parts: string[] = [];
  if (problemCount) {
    parts.push(
      `Schema does not match ${problemCount} existing document(s):\n` +
        problems
          .slice(0, LISTED)
          .map((p) => `  ${p.table} ${p.id}: ${p.message.replaceAll("\n", "\n    ")}`)
          .join("\n") +
        (problemCount > LISTED ? `\n  ...and ${problemCount - LISTED} more` : ""),
    );
  }
  if (removedFields.length) {
    parts.push(
      `Schema would delete stored data from ${removedFields.length} field(s):\n` +
        removedFields
          .slice(0, LISTED)
          .map((f) => `  ${f.table}.${f.field}: ${f.documents} document(s)`)
          .join("\n") +
        (removedFields.length > LISTED ? `\n  ...and ${removedFields.length - LISTED} more` : "") +
        `\nKeep the field(s) in the schema (e.g. with .optional()), or start with --allow-field-removal` +
        ` (EngineOptions.allowFieldRemoval) to delete this data.`,
    );
  }
  return parts.join("\n");
}

export class MigrationError extends Error {
  readonly [EXIT_CODE] = ExitCode.MIGRATION_REFUSED;

  constructor(
    /** The first KEPT_PROBLEMS documents that no longer validate. */
    readonly problems: Problem[],
    readonly removedFields: RemovedField[] = [],
    message?: string,
    /** How many documents no longer validate, `problems` and the ones past it. */
    readonly problemCount = problems.length,
  ) {
    super(message ?? describeProblems(problems, removedFields, problemCount));
    this.name = "MigrationError";
  }
}

interface TableRow {
  name: string;
  number: number;
  json_schema: string | null;
  indexes: string;
  active: number;
}

/**
 * Brings the database in line with the schema, in one transaction:
 * creates tables, syncs indexes and, when a table's validator changed,
 * re-validates every document (rewriting those whose parsed form differs),
 * a page of documents at a time so memory stays bounded on large tables.
 * A migration that changed something logs `migration_committed` once it has
 * committed: the host keeps a release whose migration committed.
 * Throws MigrationError, leaving the database untouched, when any document no
 * longer validates, when a rewrite would delete stored fields (unless
 * `allowFieldRemoval`), or when no schema was loaded but tables exist.
 * Tables removed from the schema keep their data. Pending files a re-validated
 * document holds stop being pending, so cleanup keeps them even when the field
 * is no longer an `id("_storage")`.
 */
export function migrate(store: Store, schema: SchemaDefinition | undefined, options: MigrationOptions = {}): MigrationReport {
  const report: MigrationReport = {
    createdTables: [],
    deactivatedTables: [],
    addedIndexes: [],
    droppedIndexes: [],
    rewrittenDocuments: 0,
    removedFields: [],
  };
  const db = store.write;
  const tables = schema?.tables ?? {};

  const run = db.transaction(() => {
    const existing = new Map(
      (db.query(`SELECT * FROM _incibase_tables`).all() as TableRow[]).map((r) => [r.name, r]),
    );
    if (!schema) {
      // A missing schema file would otherwise read as "every table removed".
      const active = [...existing.values()].filter((r) => r.active).map((r) => r.name);
      if (active.length) {
        throw new MigrationError(
          [],
          [],
          `No schema was loaded, but the database has ${active.length} table(s): ${active.join(", ")}.\n` +
            `Add the schema (schema.ts with \`export default defineSchema({...})\`); to remove every table on purpose, export defineSchema({}).`,
        );
      }
    }
    let nextNumber = Math.max(FIRST_USER_TABLE_NUMBER - 1, ...[...existing.values()].map((r) => r.number)) + 1;
    const problems: Problem[] = [];
    const problemCount = { value: 0 };
    const removedFields: RemovedField[] = [];
    let pendingFiles: Set<string> | undefined;

    for (const [name, def] of Object.entries(tables)) {
      // Both sides: a transform's output is unrepresentable (`{}`), so a change
      // inside a transformed field shows only in the input schema.
      const fingerprint = JSON.stringify({ output: toJsonSchema(def.validator), input: toJsonSchema(def.validator, "input") });
      const indexes = [...def.indexes];
      const row = existing.get(name);
      let number: number;

      if (!row) {
        number = nextNumber++;
        store.createDocumentTable(name);
        db.query(`INSERT INTO _incibase_tables (name, number, json_schema, indexes, active) VALUES (?, ?, ?, '[]', 1)`).run(
          name,
          number,
          fingerprint,
        );
        report.createdTables.push(name);
      } else {
        number = row.number;
        if (row.json_schema !== fingerprint || !row.active) {
          pendingFiles ??= new Set(
            (db.query(`SELECT _id FROM _storage WHERE json_extract(data, '$.pending') = 1`).all() as { _id: string }[]).map((r) => r._id),
          );
          const removed = new Map<string, number>();
          report.rewrittenDocuments += revalidate(store, name, def.validator, { problems, problemCount, removed, pendingFiles }, options.pageSize ?? PAGE_SIZE);
          for (const [field, documents] of removed) removedFields.push({ table: name, field, documents });
        }
      }

      const oldIndexes: IndexDefinition[] = row ? JSON.parse(row.indexes) : [];
      for (const old of oldIndexes) {
        const next = indexes.find((i) => i.name === old.name);
        if (!next || !sameIndex(old, next)) {
          store.dropIndex(name, old.name);
          report.droppedIndexes.push(`${name}.${old.name}`);
        }
      }
      for (const index of indexes) {
        const old = oldIndexes.find((i) => i.name === index.name);
        if (!old || !sameIndex(old, index)) {
          try {
            store.createIndex(name, index);
          } catch (err) {
            // Existing data the index cannot hold (e.g. duplicates for a unique one): refused like any mismatch.
            throw new MigrationError([], [], `Cannot create index ${name}.${index.name}: ${(err as Error).message}`);
          }
          report.addedIndexes.push(`${name}.${index.name}`);
        }
      }

      db.query(`UPDATE _incibase_tables SET json_schema = ?, indexes = ?, active = 1 WHERE name = ?`).run(
        fingerprint,
        JSON.stringify(indexes),
        name,
      );
      store.register({ name, number, system: false, validator: def.validator, indexes, storageFields: storageFieldsOf(def.validator) });
    }

    for (const row of existing.values()) {
      if (row.active && !(row.name in tables)) {
        db.query(`UPDATE _incibase_tables SET active = 0 WHERE name = ?`).run(row.name);
        store.unregister(row.name);
        report.deactivatedTables.push(row.name);
      }
    }

    const refusedFields = options.allowFieldRemoval ? [] : removedFields;
    if (problemCount.value || refusedFields.length) {
      throw new MigrationError(problems, refusedFields, undefined, problemCount.value);
    }
    report.removedFields = removedFields;
  });

  run.immediate();
  const changed = [report.createdTables, report.deactivatedTables, report.addedIndexes, report.droppedIndexes, report.removedFields];
  if (changed.some((l) => l.length) || report.rewrittenDocuments) logEvent("info", { ev: "migration_committed", ...report });
  return report;
}

function sameIndex(a: IndexDefinition, b: IndexDefinition) {
  return a.unique === b.unique && a.fields.join("\0") === b.fields.join("\0");
}

/** What re-validating the tables found so far. */
interface Findings {
  /** Documents that no longer validate: the first KEPT_PROBLEMS of them. */
  problems: Problem[];
  /** How many documents no longer validate. */
  problemCount: { value: number };
  /** Stored keys a rewrite would drop, as documents per field. */
  removed: Map<string, number>;
  pendingFiles: Set<string>;
}

/**
 * Re-parses every document and rewrites those whose stored form changed,
 * reading `pageSize` documents at a time in `_id` order. The pages are keyset
 * pages read inside the migration's transaction, so a rewrite (which keeps
 * the `_id`) never moves a document into a page still to come.
 * Stored keys the rewrite would drop are counted per field in `removed`.
 * (Values a `.catch()` replaces are rewritten without being counted.)
 * Pending files a document holds (from `pendingFiles`) are marked not pending
 * and dropped from the set: the new schema may no longer say they are file ids.
 */
function revalidate(
  store: Store,
  table: string,
  validator: z.ZodObject<any, any>,
  { problems, problemCount, removed, pendingFiles }: Findings,
  pageSize: number,
): number {
  let rewritten = 0;
  const held = new Set<string>();
  const update = store.write.query(`UPDATE ${quoteIdent(table)} SET data = ? WHERE _id = ?`);
  const page = store.write.query(`SELECT _id, _creationTime, data FROM ${quoteIdent(table)} WHERE _id > ? ORDER BY _id LIMIT ?`);
  let after = "";
  while (true) {
    const rows = page.all(after, pageSize) as DocumentRow[];
    for (const row of rows) {
      const stored = JSON.parse(row.data);
      if (pendingFiles.size) collectHeldIds(stored, pendingFiles, held);
      const result = validator.safeParse(stored);
      if (!result.success) {
        if (problemCount.value++ < KEPT_PROBLEMS) problems.push({ table, id: row._id, message: z.prettifyError(result.error) });
        continue;
      }
      const data = JSON.stringify(result.data);
      if (data !== row.data) {
        const fields = new Set<string>();
        droppedKeys(JSON.parse(row.data), JSON.parse(data), validator, "", fields);
        for (const field of fields) removed.set(field, (removed.get(field) ?? 0) + 1);
        update.run(data, row._id);
        rewritten++;
      }
    }
    if (rows.length < pageSize) break;
    after = rows[rows.length - 1]!._id;
  }
  const release = store.write.query(`UPDATE _storage SET data = json_remove(data, '$.pending', '$.detachedAt') WHERE _id = ?`);
  for (const fileId of held) {
    release.run(fileId);
    pendingFiles.delete(fileId);
  }
  return rewritten;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Adds the path of every key `stored` has and `next` lacks, nested objects and
 * array items included. `node` is the validator of `stored` when known: keys of
 * a record are one field (`prices.*.old`), not one field per key.
 */
function droppedKeys(stored: unknown, next: unknown, node: z.ZodType | undefined, path: string, out: Set<string>) {
  if (Array.isArray(stored)) {
    if (Array.isArray(next)) stored.forEach((item, i) => droppedKeys(item, next[i], childOf(node, i).node, `${path}[]`, out));
    return;
  }
  if (!isObject(stored) || !isObject(next)) return;
  for (const [key, value] of Object.entries(stored)) {
    const { node: child, dynamic } = childOf(node, key);
    const name = dynamic ? "*" : key;
    const at = path ? `${path}.${name}` : name;
    if (Object.hasOwn(next, key)) droppedKeys(value, next[key], child, at, out);
    else out.add(at);
  }
}

/** The definition that parses a value of `node`, past optional, default, lazy, pipes and the like. */
function defOf(node: z.ZodType | undefined): any {
  for (let depth = 0; node && depth < 64; depth++) {
    const def = (node as any)._zod.def;
    if (WRAPPERS.has(def.type)) node = def.innerType;
    else if (def.type === "lazy") node = def.getter();
    else if (def.type === "pipe") node = def.out._zod.def.type === "transform" ? def.in : def.out;
    else return def;
  }
  return undefined;
}

/** The validator of `key` (an index for arrays) in a value of `node`; `dynamic` for record keys. */
function childOf(node: z.ZodType | undefined, key: string | number): { node?: z.ZodType; dynamic?: boolean } {
  const def = defOf(node);
  if (typeof key === "number") {
    if (def?.type === "array") return { node: def.element };
    if (def?.type === "tuple") return { node: def.items[key] ?? def.rest };
  } else {
    if (def?.type === "object") return Object.hasOwn(def.shape, key) ? { node: def.shape[key] } : { node: def.catchall, dynamic: !!def.catchall };
    if (def?.type === "record") return { node: def.valueType, dynamic: true };
  }
  const options = def?.type === "union" ? def.options : def?.type === "intersection" ? [def.left, def.right] : [];
  for (const option of options) {
    const child = childOf(option, key);
    if (child.node) return child;
  }
  return {};
}
