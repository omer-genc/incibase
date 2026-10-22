import { z } from "zod";
import type { IndexDefinition, SchemaDefinition } from "../schema.ts";
import { storageFieldsOf } from "./files.ts";
import { toJsonSchema } from "./jsonschema.ts";
import { FIRST_USER_TABLE_NUMBER, quoteIdent, type DocumentRow, type Store } from "./store.ts";

/** A stored field the new schema no longer has. */
export interface RemovedField {
  table: string;
  /** Dotted path; `[]` stands for array items, e.g. `items[].sku`. */
  field: string;
  /** Documents that hold a value for it. */
  documents: number;
}

export interface MigrationOptions {
  /** Let the migration delete stored fields the schema no longer has; otherwise it is refused. */
  allowFieldRemoval?: boolean;
}

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

function describeProblems(problems: Problem[], removedFields: RemovedField[]) {
  const parts: string[] = [];
  if (problems.length) {
    parts.push(
      `Schema does not match ${problems.length} existing document(s):\n` +
        problems
          .slice(0, 20)
          .map((p) => `  ${p.table} ${p.id}: ${p.message.replaceAll("\n", "\n    ")}`)
          .join("\n"),
    );
  }
  if (removedFields.length) {
    parts.push(
      `Schema would delete stored data from ${removedFields.length} field(s):\n` +
        removedFields.map((f) => `  ${f.table}.${f.field}: ${f.documents} document(s)`).join("\n") +
        `\nKeep the field(s) in the schema (e.g. with .optional()), or start with --allow-field-removal` +
        ` (EngineOptions.allowFieldRemoval) to delete this data.`,
    );
  }
  return parts.join("\n");
}

export class MigrationError extends Error {
  constructor(
    readonly problems: Problem[],
    readonly removedFields: RemovedField[] = [],
    message = describeProblems(problems, removedFields),
  ) {
    super(message);
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
 * re-validates every document (rewriting those whose parsed form differs).
 * Throws MigrationError, leaving the database untouched, when any document no
 * longer validates, when a rewrite would delete stored fields (unless
 * `allowFieldRemoval`), or when no schema was loaded but tables exist.
 * Tables removed from the schema keep their data.
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
    const removedFields: RemovedField[] = [];

    for (const [name, def] of Object.entries(tables)) {
      const jsonSchema = JSON.stringify(toJsonSchema(def.validator));
      const indexes = [...def.indexes];
      const row = existing.get(name);
      let number: number;

      if (!row) {
        number = nextNumber++;
        store.createDocumentTable(name);
        db.query(`INSERT INTO _incibase_tables (name, number, json_schema, indexes, active) VALUES (?, ?, ?, '[]', 1)`).run(
          name,
          number,
          jsonSchema,
        );
        report.createdTables.push(name);
      } else {
        number = row.number;
        if (row.json_schema !== jsonSchema || !row.active) {
          const removed = new Map<string, number>();
          report.rewrittenDocuments += revalidate(store, name, def.validator, problems, removed);
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
            throw new Error(`Cannot create index ${name}.${index.name}: ${(err as Error).message}`);
          }
          report.addedIndexes.push(`${name}.${index.name}`);
        }
      }

      db.query(`UPDATE _incibase_tables SET json_schema = ?, indexes = ?, active = 1 WHERE name = ?`).run(
        jsonSchema,
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
    if (problems.length || refusedFields.length) throw new MigrationError(problems, refusedFields);
    report.removedFields = removedFields;
  });

  run.immediate();
  return report;
}

function sameIndex(a: IndexDefinition, b: IndexDefinition) {
  return a.unique === b.unique && a.fields.join("\0") === b.fields.join("\0");
}

/**
 * Re-parses every document and rewrites those whose stored form changed.
 * Stored keys the rewrite would drop are counted per field in `removed`.
 * (Values a `.catch()` replaces are rewritten without being counted.)
 */
function revalidate(
  store: Store,
  table: string,
  validator: z.ZodObject<any, any>,
  problems: Problem[],
  removed: Map<string, number>,
): number {
  let rewritten = 0;
  const update = store.write.query(`UPDATE ${quoteIdent(table)} SET data = ? WHERE _id = ?`);
  const rows = store.write.query(`SELECT _id, _creationTime, data FROM ${quoteIdent(table)}`).all() as DocumentRow[];
  for (const row of rows) {
    const result = validator.safeParse(JSON.parse(row.data));
    if (!result.success) {
      problems.push({ table, id: row._id, message: z.prettifyError(result.error) });
      continue;
    }
    const data = JSON.stringify(result.data);
    if (data !== row.data) {
      const fields = new Set<string>();
      droppedKeys(JSON.parse(row.data), JSON.parse(data), "", fields);
      for (const field of fields) removed.set(field, (removed.get(field) ?? 0) + 1);
      update.run(data, row._id);
      rewritten++;
    }
  }
  return rewritten;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Adds the path of every key `stored` has and `next` lacks, nested objects and array items included. */
function droppedKeys(stored: unknown, next: unknown, path: string, out: Set<string>) {
  if (Array.isArray(stored)) {
    if (Array.isArray(next)) stored.forEach((item, i) => droppedKeys(item, next[i], `${path}[]`, out));
    return;
  }
  if (!isObject(stored) || !isObject(next)) return;
  for (const [key, value] of Object.entries(stored)) {
    const child = path ? `${path}.${key}` : key;
    if (Object.hasOwn(next, key)) droppedKeys(value, next[key], child, out);
    else out.add(child);
  }
}
