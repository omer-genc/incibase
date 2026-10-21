import type { JsonSchema } from "./api";

/** A starting value for a schema: defaults, else empty values for required fields. */
export function sample(schema: JsonSchema | undefined, includeOptional = false): unknown {
  if (!schema) return null;
  if (schema.default !== undefined) return schema.default;
  if (schema.const !== undefined) return schema.const;
  if (schema.enum?.length) return schema.enum[0];
  if (schema.anyOf?.length) return sample(schema.anyOf.find((s) => s.type !== "null") ?? schema.anyOf[0]);
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;
  switch (type) {
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(schema.properties ?? {})) {
        if (includeOptional || schema.required?.includes(k)) out[k] = sample(v);
      }
      return out;
    }
    case "array":
      return [];
    case "string":
      return "";
    case "number":
    case "integer":
      return schema.minimum ?? 0;
    case "boolean":
      return false;
    default:
      return null;
  }
}

/** Table an id field points to, looking through optional/nullable wrappers. */
export function refTable(schema: JsonSchema | undefined): string | undefined {
  if (!schema) return undefined;
  if (schema["x-incibase-table"]) return schema["x-incibase-table"];
  for (const s of schema.anyOf ?? []) {
    const t = refTable(s);
    if (t) return t;
  }
  return undefined;
}

/** Compact TypeScript-like description of a schema. */
export function describeSchema(schema: JsonSchema | undefined): string {
  if (!schema) return "unknown";
  const table = schema["x-incibase-table"];
  if (table) return `Id<"${table}">`;
  if (schema.anyOf) return schema.anyOf.map(describeSchema).join(" | ");
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  const type = Array.isArray(schema.type) ? schema.type.join(" | ") : (schema.type ?? "any");
  if (type === "array") {
    const inner = describeSchema(schema.items);
    return inner.includes("|") ? `(${inner})[]` : `${inner}[]`;
  }
  if (type === "object") {
    const keys = Object.keys(schema.properties ?? {});
    return keys.length ? `{ ${keys.join(", ")} }` : "object";
  }
  if (type === "integer") return "number (int)";
  return type;
}

/** Validation hints shown next to a type, e.g. "1–2000 chars". */
export function constraints(schema: JsonSchema | undefined): string[] {
  if (!schema) return [];
  const out: string[] = [];
  if (schema.minLength !== undefined || schema.maxLength !== undefined) {
    out.push(`${schema.minLength ?? 0}–${schema.maxLength ?? "∞"} chars`);
  }
  if (schema.minimum !== undefined || schema.maximum !== undefined) {
    out.push(`${schema.minimum ?? "−∞"}…${schema.maximum ?? "∞"}`);
  }
  if (schema.format && schema.format !== "incibase-id") out.push(schema.format);
  if (schema.default !== undefined) out.push(`default ${JSON.stringify(schema.default)}`);
  return out;
}
