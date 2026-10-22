// Admin operations shared by the MCP admin tools and the dashboard's
// `/api/admin/:tool` endpoint. Callers must already have checked the admin key.
import { z } from "zod";
import { isIncibaseError } from "../errors.ts";
import { runAdminSql, SQL_MAX_ROWS, SQL_TIMEOUT_MS } from "./adminsql.ts";
import { ValidationError } from "./database.ts";
import { describeApp } from "./describe.ts";
import { logEvent } from "./log.ts";
import { visibilityOf } from "./storage.ts";
import type { Engine } from "./engine.ts";
import { VERSION } from "./version.ts";

export interface AdminTool {
  description: string;
  input: z.ZodObject<any>;
  readOnly: boolean;
  run: (args: any) => Promise<unknown>;
}

/**
 * Checks `args` against the tool's input and runs it, logging the call in
 * json mode (the tool's name and outcome, never its arguments: they can hold
 * SQL, documents or keys). An admin_sql call carries a hash of its query
 * instead, to tell calls apart.
 */
export async function invokeAdminTool(name: string, tool: AdminTool, args: unknown, via: "http" | "mcp"): Promise<unknown> {
  const started = performance.now();
  const query = name === "admin_sql" ? (args as { query?: unknown } | null)?.query : undefined;
  const sql = typeof query === "string" ? { sql: new Bun.CryptoHasher("sha256").update(query).digest("hex").slice(0, 16) } : {};
  try {
    const parsed = tool.input.safeParse(args);
    if (!parsed.success) throw new ValidationError(`Invalid arguments:\n${z.prettifyError(parsed.error)}`, parsed.error.issues);
    const value = await tool.run(parsed.data);
    logEvent("info", { ev: "admin", tool: name, via, ok: true, ms: Math.round(performance.now() - started), ...sql });
    return value;
  } catch (err) {
    logEvent("warn", { ev: "admin", tool: name, via, ok: false, ms: Math.round(performance.now() - started), ...sql, ...failureOf(name, err) });
    throw err;
  }
}

/**
 * What the log keeps of a failed admin call; the full message goes only to
 * the admin. An IncibaseError's message is its JSON payload, so it is logged
 * by its code, and admin_sql errors quote the query (`no such column: ...`).
 */
function failureOf(tool: string, err: unknown): { code?: string; error?: string } {
  if (isIncibaseError(err)) {
    const code = (err.data as { code?: unknown } | null)?.code;
    return typeof code === "string" ? { code } : {};
  }
  if (tool === "admin_sql") return {};
  return { error: (err as Error)?.message?.split("\n")[0] ?? String(err) };
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
      description: `Run one read-only SQL query (SELECT, WITH or EXPLAIN) against the SQLite database. Documents live in tables named after the schema tables with columns _id, _creationTime, data (JSON; use json_extract). Returns at most ${SQL_MAX_ROWS} rows and stops after ${SQL_TIMEOUT_MS / 1000}s; _incibase_meta, _passwords and _sessions cannot be read.`,
      input: z.object({ query: z.string(), params: z.array(z.union([z.string(), z.number(), z.null()])).default([]) }),
      readOnly: true,
      run: async (a) => runAdminSql(engine.store.path, a.query, a.params),
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
    // _users is read-only to the document tools above; these change it on purpose.
    admin_delete_user: {
      description:
        "Delete a user (_users id) with their password and sessions; open connections are signed out. Documents in app tables and stored files that reference the user are NOT deleted: clean those up separately.",
      input: z.object({ id: z.string() }),
      readOnly: false,
      run: async (a) => {
        await engine.auth.deleteUser(a.id);
        return { deleted: a.id };
      },
    },
    admin_set_user_disabled: {
      description:
        "Disable or re-enable a user (_users id). A disabled user cannot sign in, and all their sessions are revoked, signing out open connections. Returns the user.",
      input: z.object({ id: z.string(), disabled: z.boolean() }),
      readOnly: false,
      run: async (a) => {
        await engine.auth.setDisabled(a.id, a.disabled);
        return (await engine.readTx((s) => s.get("_users", a.id))).result;
      },
    },
    admin_revoke_sessions: {
      description: "Sign a user (_users id) out everywhere: deletes all their sessions and signs out open connections. Returns how many were revoked.",
      input: z.object({ id: z.string() }),
      readOnly: false,
      run: async (a) => ({ revoked: await engine.auth.revokeAll(a.id) }),
    },
  };
}
