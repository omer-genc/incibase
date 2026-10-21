import type { RegisteredFunction } from "../api.ts";
import type { Engine } from "./engine.ts";
import { argsSchemaOf, toJsonSchema, type JsonSchema } from "./jsonschema.ts";
import { quoteIdent } from "./store.ts";

export interface FunctionDescription {
  path: string;
  type: RegisteredFunction["type"];
  visibility: RegisteredFunction["visibility"];
  description?: string;
  args: JsonSchema;
  returns?: JsonSchema;
  mcpTool?: string;
}

export interface AppDescription {
  tables: Record<
    string,
    {
      system: boolean;
      documentSchema?: JsonSchema;
      indexes: { name: string; fields: string[]; unique: boolean }[];
      documentCount?: number;
    }
  >;
  functions: FunctionDescription[];
}

export function mcpToolName(path: string, fn: RegisteredFunction): string {
  const custom = typeof fn.mcp === "object" ? fn.mcp.name : undefined;
  return custom ?? path.replace(/[/:]/g, "_");
}

export function describeFunctions(engine: Engine): FunctionDescription[] {
  return [...engine.functions.entries()].map(([path, fn]) => ({
    path,
    type: fn.type,
    visibility: fn.visibility,
    ...(fn.description ? { description: fn.description } : {}),
    args: toJsonSchema(argsSchemaOf(fn), "input"),
    ...(fn.returns ? { returns: toJsonSchema(fn.returns, "output") } : {}),
    ...(fn.mcp && fn.visibility === "public" ? { mcpTool: mcpToolName(path, fn) } : {}),
  }));
}

export function describeApp(engine: Engine, options: { counts?: boolean } = {}): AppDescription {
  const tables: AppDescription["tables"] = {};
  for (const table of engine.store.tables.values()) {
    tables[table.name] = {
      system: table.system,
      ...(table.validator ? { documentSchema: toJsonSchema(table.validator) } : {}),
      indexes: table.indexes.map((i) => ({ name: i.name, fields: i.fields, unique: i.unique })),
      ...(options.counts
        ? {
            documentCount: (
              engine.store.write.query(`SELECT COUNT(*) AS n FROM ${quoteIdent(table.name)}`).get() as { n: number }
            ).n,
          }
        : {}),
    };
  }
  return { tables, functions: describeFunctions(engine) };
}
