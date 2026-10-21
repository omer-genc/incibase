import { z } from "zod";
import type { IndexDefinition, SchemaDefinition } from "../schema.ts";
import { toJsonSchema } from "./jsonschema.ts";
import { FIRST_USER_TABLE_NUMBER, quoteIdent, type DocumentRow, type Store } from "./store.ts";

export interface MigrationReport {
  createdTables: string[];
  deactivatedTables: string[];
  addedIndexes: string[];
  droppedIndexes: string[];
  /** Documents rewritten because the new schema changed their stored form (defaults, stripped keys). */
  rewrittenDocuments: number;
}

export class MigrationError extends Error {
  constructor(readonly problems: { table: string; id: string; message: string }[]) {
    super(
      `Schema does not match ${problems.length} existing document(s):\n` +
        problems
          .slice(0, 20)
          .map((p) => `  ${p.table} ${p.id}: ${p.message.replaceAll("\n", "\n    ")}`)
          .join("\n"),
    );
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
 * longer validates. Tables removed from the schema keep their data.
 */
export function migrate(store: Store, schema: SchemaDefinition | undefined): MigrationReport {
  const report: MigrationReport = {
    createdTables: [],
    deactivatedTables: [],
    addedIndexes: [],
    droppedIndexes: [],
    rewrittenDocuments: 0,
  };
  const db = store.write;
  const tables = schema?.tables ?? {};

  const run = db.transaction(() => {
    const existing = new Map(
      (db.query(`SELECT * FROM _incibase_tables`).all() as TableRow[]).map((r) => [r.name, r]),
    );
    let nextNumber = Math.max(FIRST_USER_TABLE_NUMBER - 1, ...[...existing.values()].map((r) => r.number)) + 1;
    const problems: { table: string; id: string; message: string }[] = [];

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
          report.rewrittenDocuments += revalidate(store, name, def.validator, problems);
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
      store.register({ name, number, system: false, validator: def.validator, indexes });
    }

    for (const row of existing.values()) {
      if (row.active && !(row.name in tables)) {
        db.query(`UPDATE _incibase_tables SET active = 0 WHERE name = ?`).run(row.name);
        store.unregister(row.name);
        report.deactivatedTables.push(row.name);
      }
    }

    if (problems.length) throw new MigrationError(problems);
  });

  run.immediate();
  return report;
}

function sameIndex(a: IndexDefinition, b: IndexDefinition) {
  return a.unique === b.unique && a.fields.join("\0") === b.fields.join("\0");
}

function revalidate(
  store: Store,
  table: string,
  validator: z.ZodObject<any, any>,
  problems: { table: string; id: string; message: string }[],
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
      update.run(data, row._id);
      rewritten++;
    }
  }
  return rewritten;
}
