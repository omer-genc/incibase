// Model Context Protocol over Streamable HTTP (stateless, JSON responses).
// Public functions marked `mcp: true` become tools for any caller; admin-key
// callers also get tools to inspect and edit data.
import { z } from "zod";
import { describeApp, mcpToolName } from "./describe.ts";
import { toErrorPayload, type Engine, type Identity } from "./engine.ts";
import { argsSchemaOf, toJsonSchema, type JsonSchema } from "./jsonschema.ts";
import { VERSION } from "./version.ts";

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, any>;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

const rangeOp = z.object({
  field: z.string(),
  op: z.enum(["eq", "gt", "gte", "lt", "lte"]),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
});

function adminTools(engine: Engine): Record<string, { description: string; input: z.ZodObject<any>; readOnly: boolean; run: (args: any) => Promise<unknown> }> {
  return {
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
      description: "Get one document by id (any table, including _users, _storage, _scheduled).",
      input: z.object({ id: z.string() }),
      readOnly: true,
      run: async (a) => (await engine.readTx((s) => s.get(a.id))).result,
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
    admin_delete_document: {
      description: "Delete a document by id.",
      input: z.object({ id: z.string() }),
      readOnly: false,
      run: async (a) => {
        await engine.writeTx((s) => s.delete(a.id));
        return { deleted: a.id };
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
        errorsOnly: z.boolean().default(false),
      }),
      readOnly: true,
      run: async (a) =>
        engine.logs
          .filter((l) => (!a.path || l.path.includes(a.path)) && (!a.errorsOnly || !l.ok))
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

function toolsFor(engine: Engine, identity: Identity): Map<string, Tool> {
  const tools = new Map<string, Tool>();
  for (const [path, fn] of engine.functions) {
    if (!fn.mcp || fn.visibility !== "public") continue;
    const name = mcpToolName(path, fn);
    const custom = typeof fn.mcp === "object" ? fn.mcp.description : undefined;
    tools.set(name, {
      name,
      description: custom ?? fn.description ?? `Runs the ${fn.type} "${path}".`,
      inputSchema: objectSchema(toJsonSchema(argsSchemaOf(fn), "input")),
      annotations: { readOnlyHint: fn.type === "query" },
      run: (args) => engine.call(path, args, identity, { expectType: fn.type }),
    });
  }
  if (identity.admin) {
    for (const [name, def] of Object.entries(adminTools(engine))) {
      tools.set(name, {
        name,
        description: def.description,
        inputSchema: objectSchema(toJsonSchema(def.input, "input")),
        annotations: { readOnlyHint: def.readOnly, destructiveHint: !def.readOnly },
        run: async (args) => {
          const parsed = def.input.safeParse(args);
          if (!parsed.success) throw new Error(`Invalid arguments:\n${z.prettifyError(parsed.error)}`);
          return def.run(parsed.data);
        },
      });
    }
  }
  return tools;
}

function objectSchema(schema: JsonSchema): JsonSchema {
  return schema.type === "object" ? schema : { type: "object", properties: {}, ...schema };
}

function rpcResult(id: JsonRpcRequest["id"], result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function handleMessage(engine: Engine, identity: Identity, msg: JsonRpcRequest) {
  const isRequest = msg.id !== undefined && msg.id !== null;
  if (msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg?.id, -32600, "Invalid request");
  }
  if (!isRequest) return null; // notifications (initialized, cancelled, ...) need no response

  switch (msg.method) {
    case "initialize": {
      const requested = msg.params?.protocolVersion;
      return rpcResult(msg.id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "incibase", version: VERSION },
        instructions: identity.admin
          ? "incibase backend (admin). Start with admin_schema to see tables and functions."
          : "incibase backend. Tools call the app's backend functions.",
      });
    }
    case "ping":
      return rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, {
        tools: [...toolsFor(engine, identity).values()].map(({ run, ...tool }) => tool),
      });
    case "tools/call": {
      const tool = toolsFor(engine, identity).get(msg.params?.name);
      if (!tool) return rpcError(msg.id, -32602, `Unknown tool "${msg.params?.name}"`);
      try {
        const value = (await tool.run(msg.params?.arguments ?? {})) ?? null;
        const plainObject = typeof value === "object" && value !== null && !Array.isArray(value);
        return rpcResult(msg.id, {
          content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
          ...(plainObject ? { structuredContent: value } : {}),
        });
      } catch (err) {
        const { error } = toErrorPayload(err, true);
        return rpcResult(msg.id, { content: [{ type: "text", text: `${error.code}: ${error.message}` }], isError: true });
      }
    }
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

export async function handleMcp(engine: Engine, req: Request): Promise<Response> {
  if (req.method === "GET") return new Response("SSE stream not supported; POST JSON-RPC messages", { status: 405, headers: { allow: "POST" } });
  if (req.method === "DELETE") return new Response(null, { status: 204 });

  const identity = engine.auth.identifyRequest(req);
  const header = req.headers.get("authorization");
  if (header && !identity.admin && !identity.userId) {
    return Response.json(rpcError(null, -32001, "Invalid or expired token"), { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(rpcError(null, -32700, "Parse error"), { status: 400 });
  }

  const messages = Array.isArray(body) ? body : [body];
  const responses = (await Promise.all(messages.map((m) => handleMessage(engine, identity, m as JsonRpcRequest)))).filter(
    (r) => r !== null,
  );
  if (responses.length === 0) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? responses : responses[0]);
}
