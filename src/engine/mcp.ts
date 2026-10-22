// Model Context Protocol over Streamable HTTP (stateless, JSON responses).
// Public functions marked `mcp: true` become tools for any caller; admin-key
// callers also get tools to inspect and edit data.
import { adminTools, invokeAdminTool } from "./admin.ts";
import { mcpToolName } from "./describe.ts";
import { toErrorPayload, type Engine, type Identity } from "./engine.ts";
import { argsSchemaOf, toJsonSchema, type JsonSchema } from "./jsonschema.ts";
import type { Surface } from "./surface.ts";
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

function toolsFor(engine: Engine, identity: Identity, surface: Surface): Map<string, Tool> {
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
    for (const [name, def] of Object.entries(adminTools(engine, { surface }))) {
      tools.set(name, {
        name,
        description: def.description,
        inputSchema: objectSchema(toJsonSchema(def.input, "input")),
        annotations: { readOnlyHint: def.readOnly, destructiveHint: !def.readOnly },
        run: (args) => invokeAdminTool(name, def, args, "mcp"),
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

async function handleMessage(engine: Engine, identity: Identity, msg: JsonRpcRequest, surface: Surface) {
  const isRequest = msg?.id !== undefined && msg?.id !== null;
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
        tools: [...toolsFor(engine, identity, surface).values()].map(({ run, ...tool }) => tool),
      });
    case "tools/call": {
      const tool = toolsFor(engine, identity, surface).get(msg.params?.name);
      if (!tool) return rpcError(msg.id, -32602, `Unknown tool "${msg.params?.name}"`);
      try {
        const value = (await tool.run(msg.params?.arguments ?? {})) ?? null;
        const plainObject = typeof value === "object" && value !== null && !Array.isArray(value);
        return rpcResult(msg.id, {
          content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
          ...(plainObject ? { structuredContent: value } : {}),
        });
      } catch (err) {
        // Internal errors carry messages and stack traces; callers see them only in dev. Admins also
        // get the message (not the stack) in production, so a bad admin_sql query or table name can
        // be corrected.
        const dev = !!engine.options.dev;
        const { status, error } = toErrorPayload(err, dev);
        const message = status === 500 && identity.admin && !dev ? String(err) : error.message;
        return rpcResult(msg.id, { content: [{ type: "text", text: `${error.code}: ${message}` }], isError: true });
      }
    }
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

/**
 * `readBody` reads the POST body; the HTTP server passes one that enforces its
 * size limit. `surface` is the listener's, which admin_overview reports.
 */
export async function handleMcp(engine: Engine, req: Request, readBody = () => req.text(), surface: Surface = "combined"): Promise<Response> {
  if (req.method === "GET") return new Response("SSE stream not supported; POST JSON-RPC messages", { status: 405, headers: { allow: "POST" } });
  if (req.method === "DELETE") return new Response(null, { status: 204 });

  const identity = engine.auth.identifyRequest(req);
  const header = req.headers.get("authorization");
  if (header && !identity.admin && !identity.userId && !identity.service) {
    return Response.json(rpcError(null, -32001, "Invalid or expired token"), { status: 401 });
  }

  const text = await readBody();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json(rpcError(null, -32700, "Parse error"), { status: 400 });
  }

  const messages = Array.isArray(body) ? body : [body];
  const responses = (await Promise.all(messages.map((m) => handleMessage(engine, identity, m as JsonRpcRequest, surface)))).filter(
    (r) => r !== null,
  );
  if (responses.length === 0) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? responses : responses[0]);
}
