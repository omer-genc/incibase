import { z } from "zod";
import type { RegisteredFunction } from "../api.ts";

export type JsonSchema = Record<string, unknown>;

export function toJsonSchema(schema: z.ZodType, io: "input" | "output" = "output"): JsonSchema {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, { io, unrepresentable: "any" }) as JsonSchema;
  return rest;
}

const argsCache = new WeakMap<object, z.ZodType>();

/** The function's args as one Zod schema (an empty object when it declares none). */
export function argsSchemaOf(fn: RegisteredFunction): z.ZodType {
  let schema = argsCache.get(fn);
  if (!schema) {
    const args = fn.args;
    schema = !args ? z.object({}) : args instanceof z.ZodType ? args : z.object(args as Record<string, z.ZodType>);
    argsCache.set(fn, schema);
  }
  return schema;
}
