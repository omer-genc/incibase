// Admin operations shared by the MCP admin tools and the dashboard's
// `/api/admin/:tool` endpoint. Callers must already have checked the admin key.
import { z } from "zod";
import { describeApp } from "./describe.ts";
import { visibilityOf } from "./storage.ts";
import type { Engine } from "./engine.ts";
import { VERSION } from "./version.ts";

export interface AdminTool {
  description: string;
  input: z.ZodObject<any>;
  readOnly: boolean;
  run: (args: any) => Promise<unknown>;
}

const rangeOp = z.object({
  field: z.string(),
  op: z.enum(["eq", "gt", "gte", "lt", "lte"]),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
});

export function adminTools(engine: Engine): Record<string, AdminTool> {
  return {
    admin_overview: {
      description: "Server status: version, uptime, document counts per table, function counts, live subscriptions and recent errors.",
      input: z.object({}),
      readOnly: true,
      run: async () => {
        const app = describeApp(engine, { counts: true });
        const recent = engine.logs.slice(-500);
        return {
          version: VERSION,
          dev: !!engine.options.dev,
          startedAt: engine.startedAt,
          uptimeMs: Date.now() - engine.startedAt,
          publicUrl: engine.options.publicUrl,
          tables: Object.fromEntries(Object.entries(app.tables).map(([name, t]) => [name, { system: t.system, documentCount: t.documentCount }])),
          functions: {
            query: app.functions.filter((f) => f.type === "query").length,
            mutation: app.functions.filter((f) => f.type === "mutation").length,
            action: app.functions.filter((f) => f.type === "action").length,
            mcpTools: app.functions.filter((f) => f.mcpTool).length,
          },
          subscriptions: engine.realtime.subscriptionCount,
          crons: engine.crons?.jobs.map((j) => ({ name: j.name, path: j.path, schedule: j.schedule })) ?? [],
          httpRoutes: engine.http?.routes.map((r) => ({ method: r.method, path: r.path ?? r.pathPrefix! })) ?? [],
          recentCalls: recent.length,
          recentErrors: recent.filter((l) => !l.ok).length,
        };
      },
    },
    admin_schema: {
      description: "Describe the backend: tables (document JSON Schema, indexes, document counts) and functions (type, visibility, args JSON Schema).",
      input: z.object({}),
      readOnly: true,
      run: async () => describeApp(engine, { counts: true }),
    },
    admin_list_documents: {
      description:
        "List documents of a table. Optionally use an index with range conditions (eq on leading fields, then one range), equality `where` filters, order and cursor pagination.",
      input: z.object({
        table: z.string(),
        index: z.string().optional().describe("Index name, e.g. by_creation_time or a schema index"),
        range: z.array(rangeOp).optional().describe("Index range conditions in index field order"),
        where: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
        order: z.enum(["asc", "desc"]).default("desc"),
        limit: z.number().int().min(1).max(500).default(50),
        cursor: z.string().nullable().default(null),
      }),
      readOnly: true,
      run: async (a) =>
        (
          await engine.readTx(async (s) => {
            let q = s.query(a.table);
            if (a.index) {
              q = q.withIndex(a.index, (b) => {
                for (const r of a.range ?? []) b[r.op as "eq"](r.field, r.value);
                return b;
              });
            }
            if (a.where) q = q.where(a.where);
            return q.order(a.order).paginate({ cursor: a.cursor, numItems: a.limit });
          })
        ).result,
    },
    admin_get_document: {
      description: "Get one document by id (any table, including _users, _storage, _scheduled). Returns { table, document } or null.",
      input: z.object({ id: z.string() }),
      readOnly: true,
      run: async (a) => {
        const document = (await engine.readTx((s) => s.get(a.id))).result;
        return document ? { table: engine.store.tableOfId(a.id)!.name, document } : null;
      },
    },
    admin_insert_document: {
      description: "Insert a document into a table. It is validated against the table schema. Returns the new id.",
      input: z.object({ table: z.string(), document: z.record(z.string(), z.unknown()) }),
      readOnly: false,
      run: async (a) => ({ id: await engine.writeTx((s) => s.insert(a.table, a.document)) }),
    },
    admin_patch_document: {
      description: "Shallow-merge fields into a document. Set a field to null to store null; omit it to keep it.",
      input: z.object({ id: z.string(), fields: z.record(z.string(), z.unknown()) }),
      readOnly: false,
      run: async (a) => {
        await engine.writeTx((s) => s.patch(a.id, a.fields));
        return (await engine.readTx((s) => s.get(a.id))).result;
      },
    },
    admin_replace_document: {
      description: "Replace all fields of a document (system fields are kept). Fields left out are removed.",
      input: z.object({ id: z.string(), document: z.record(z.string(), z.unknown()) }),
      readOnly: false,
      run: async (a) => {
        await engine.writeTx((s) => s.replace(a.id, a.document));
        return (await engine.readTx((s) => s.get(a.id))).result;
      },
    },
    admin_delete_document: {
      description: "Delete a document by id.",
      input: z.object({ id: z.string() }),
      readOnly: false,
      run: async (a) => {
        await engine.writeTx((s) => s.delete(a.id));
        return { deleted: a.id };
      },
    },
    admin_file_url: {
      description: "Download URL for a stored file (_storage id). Private files get a signed URL valid for expiresIn seconds.",
      input: z.object({ id: z.string(), expiresIn: z.number().positive().max(7 * 24 * 3600).default(3600) }),
      readOnly: true,
      run: async (a) => {
        const doc = (await engine.readTx((s) => s.get("_storage", a.id))).result;
        if (!doc) throw new Error(`File "${a.id}" not found`);
        return { url: engine.storage.urlFor(doc, { expiresIn: a.expiresIn }), visibility: visibilityOf(doc) };
      },
    },
    admin_set_file_visibility: {
      description: "Make a stored file public (plain URL works) or private (only signed, expiring URLs work).",
      input: z.object({ id: z.string(), visibility: z.enum(["public", "private"]) }),
      readOnly: false,
      run: async (a) => {
        await engine.writeTx((s) => engine.storage.setVisibilityIn(s, a.id, a.visibility));
        return (await engine.readTx((s) => s.get("_storage", a.id))).result;
      },
    },
    admin_run_function: {
      description: "Run any function (public or internal) by path, e.g. \"messages:send\". Optionally act as a user id.",
      input: z.object({
        path: z.string(),
        args: z.record(z.string(), z.unknown()).default({}),
        asUser: z.string().optional().describe("_users id to run as"),
      }),
      readOnly: false,
      run: async (a) =>
        engine.call(a.path, a.args, { userId: a.asUser ?? null, admin: true }, { allowInternal: true }),
    },
    admin_sql: {
      description: "Run a read-only SQL query against the SQLite database. Documents live in tables named after the schema tables with columns _id, _creationTime, data (JSON; use json_extract).",
      input: z.object({ query: z.string(), params: z.array(z.union([z.string(), z.number(), z.null()])).default([]) }),
      readOnly: true,
      run: async (a) => {
        const rows = (await engine.readTx((s) => s.conn.query(a.query).all(...a.params) as unknown[])).result;
        return { rows: rows.slice(0, 1000), truncated: rows.length > 1000 };
      },
    },
    admin_logs: {
      description: "Recent function executions (newest first) with duration and errors.",
      input: z.object({
        limit: z.number().int().min(1).max(1000).default(50),
        path: z.string().optional(),
        type: z.enum(["query", "mutation", "action", "http", "cron", "scheduled"]).optional(),
        errorsOnly: z.boolean().default(false),
      }),
      readOnly: true,
      run: async (a) =>
        engine.logs
          .filter((l) => (!a.path || l.path.includes(a.path)) && (!a.type || l.type === a.type) && (!a.errorsOnly || !l.ok))
          .slice(-a.limit)
          .reverse(),
    },
    admin_create_user: {
      description: "Create an email/password user. Returns the user and a session token.",
      input: z.object({ email: z.string(), password: z.string(), name: z.string().optional() }),
      readOnly: false,
      run: async (a) => engine.auth.signUp(a),
    },
  };
}
