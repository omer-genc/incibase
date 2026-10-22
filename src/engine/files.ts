// Record-bound files: `file()` fields attach a stored file to one document.
// Attaching checks the writer may use the file; detaching (replacing the value
// or deleting the document) marks the file for cleanup. Writing a file's id to
// a plain `id("_storage")` field clears its pending flag, so cleanup keeps it.
import { z } from "zod";
import { IncibaseError } from "../errors.ts";
import { FILE_META_KEY, ID_TABLE_META_KEY, type FileFieldOptions } from "../values.ts";
import type { DbSession } from "./database.ts";
import type { Identity } from "./engine.ts";
import type { Document } from "./store.ts";

/**
 * A field holding `_storage` ids. `path` uses "*" for array items / record
 * values and ends in "*key" for ids used as record keys.
 */
export interface StorageField {
  path: string[];
  /** Options of a `file()` field; null for a plain `id("_storage")` reference. */
  file: FileFieldOptions | null;
}

export const WRAPPERS = new Set(["optional", "nullable", "default", "prefault", "readonly", "nonoptional", "catch"]);

const RECORD_KEY = "*key";

export function storageFieldsOf(schema: z.ZodType): StorageField[] {
  const out: StorageField[] = [];
  const seen = new Set<string>();
  const lazies = new Set<z.ZodType>(); // a recursive schema is followed one level deep
  const add = (path: string[], file: FileFieldOptions | null) => {
    const key = path.join(".");
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ path, file });
    }
  };
  const walk = (node: z.ZodType, path: string[]) => {
    const meta = z.globalRegistry.get(node) as Record<string, unknown> | undefined;
    if (meta?.[FILE_META_KEY]) return add(path, meta[FILE_META_KEY] as FileFieldOptions);
    if (meta?.[ID_TABLE_META_KEY] === "_storage") return add(path, null);
    const def = (node as any)._zod.def;
    if (def.type === "record") {
      // Ids used as record keys count as plain references (file() keys too).
      const keyMeta = z.globalRegistry.get(def.keyType) as Record<string, unknown> | undefined;
      if (keyMeta?.[ID_TABLE_META_KEY] === "_storage") add([...path, RECORD_KEY], null);
    }
    if (WRAPPERS.has(def.type)) walk(def.innerType, path);
    else if (def.type === "array") walk(def.element, [...path, "*"]);
    else if (def.type === "record") walk(def.valueType, [...path, "*"]);
    else if (def.type === "tuple") {
      def.items.forEach((item: z.ZodType, i: number) => walk(item, [...path, String(i)]));
      if (def.rest) walk(def.rest, [...path, "*"]);
    } else if (def.type === "object") for (const [key, child] of Object.entries(def.shape)) walk(child as z.ZodType, [...path, key]);
    else if (def.type === "union") for (const option of def.options) walk(option, path);
    else if (def.type === "intersection") for (const side of [def.left, def.right]) walk(side, path);
    else if (def.type === "pipe") for (const side of [def.in, def.out]) walk(side, path);
    else if (def.type === "lazy" && !lazies.has(node)) {
      lazies.add(node);
      walk(def.getter(), path);
      lazies.delete(node);
    }
  };
  walk(schema, []);
  return out;
}

/** Every `_storage` id stored at `path` in `doc`. */
export function idsAt(doc: unknown, path: string[]): string[] {
  if (path.length === 0) return typeof doc === "string" ? [doc] : [];
  if (typeof doc !== "object" || doc === null) return [];
  const [head, ...rest] = path;
  if (head === RECORD_KEY) return Object.keys(doc);
  if (head === "*") return Object.values(doc).flatMap((v) => idsAt(v, rest));
  return idsAt((doc as Record<string, unknown>)[head!], rest);
}

/** Adds each of `candidates` that `value` holds anywhere, as a string value or as an object key. */
export function collectHeldIds(value: unknown, candidates: Set<string>, found: Set<string>) {
  if (typeof value === "string") {
    if (candidates.has(value)) found.add(value);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      if (candidates.has(key)) found.add(key);
      collectHeldIds(child, candidates, found);
    }
  }
}

export function contentTypeMatches(type: string | undefined, patterns: string[]): boolean {
  if (!type) return false;
  const t = type.split(";")[0]!.trim().toLowerCase();
  return patterns.some((p) => {
    const pattern = p.trim().toLowerCase();
    return pattern.endsWith("/*") ? t.startsWith(pattern.slice(0, -1)) : t === pattern;
  });
}

interface StorageData {
  contentType?: string;
  size: number;
  ownerId?: string;
  anonymous?: boolean;
  /** The service key that uploaded the file without a signed URL. */
  serviceKeyId?: string;
  visibility?: string;
  attachedTo?: { table: string; id: string; field: string };
  pending?: boolean;
  detachedAt?: number;
  [key: string]: unknown;
}

function loadFile(session: DbSession, fileId: string): StorageData {
  const row = session.conn.query(`SELECT data FROM _storage WHERE _id = ?`).get(fileId) as { data: string } | null;
  if (!row) throw new IncibaseError({ code: "NOT_FOUND", message: `File "${fileId}" not found` });
  return JSON.parse(row.data);
}

/**
 * Who may put a file into a document: its owner, admins and system code;
 * anyone for anonymous uploads; the service key that uploaded it without a
 * signed URL. Other files without an owner (admin and system uploads) stay
 * with admins and system code.
 */
function mayAttach(file: StorageData, identity: Identity | undefined): boolean {
  if (!identity || identity.admin || identity.system) return true;
  if (file.ownerId) return file.ownerId === identity.userId;
  return !!file.anonymous || (!!file.serviceKeyId && file.serviceKeyId === identity.service?.keyId);
}

function attach(session: DbSession, fileId: string, target: { table: string; id: string; field: string }, options: FileFieldOptions) {
  const file = loadFile(session, fileId);
  if (file.attachedTo && file.attachedTo.id !== target.id) {
    throw new IncibaseError({
      code: "FILE_IN_USE",
      message: `File "${fileId}" already belongs to another document; upload a new file or copy it`,
    });
  }
  if (!mayAttach(file, session.identity)) {
    throw new IncibaseError({ code: "FORBIDDEN", message: "You can only use files you uploaded" });
  }
  if (options.maxBytes !== undefined && file.size > options.maxBytes) {
    throw new IncibaseError({ code: "FILE_TOO_LARGE", message: `${target.field} accepts files up to ${options.maxBytes} bytes` });
  }
  if (options.contentTypes && !contentTypeMatches(file.contentType, options.contentTypes)) {
    throw new IncibaseError({
      code: "UNSUPPORTED_FILE_TYPE",
      message: `${target.field} accepts ${options.contentTypes.join(", ")}, not ${file.contentType ?? "unknown type"}`,
    });
  }
  const { pending, detachedAt, ...rest } = file;
  session.updateRaw(
    session.systemTable("_storage"),
    fileId,
    JSON.stringify({ ...rest, attachedTo: target, visibility: options.private ? "private" : "public" }),
  );
}

function detach(session: DbSession, fileId: string, docId: string) {
  const row = session.conn.query(`SELECT data FROM _storage WHERE _id = ?`).get(fileId) as { data: string } | null;
  if (!row) return;
  const file: StorageData = JSON.parse(row.data);
  if (file.attachedTo?.id !== docId) return;
  const { attachedTo, ...rest } = file;
  session.updateRaw(session.systemTable("_storage"), fileId, JSON.stringify({ ...rest, pending: true, detachedAt: Date.now() }));
}

/** A file put into a plain `id("_storage")` field is no longer pending, so cleanup leaves it alone. */
function markReferenced(session: DbSession, fileId: string) {
  const row = session.conn.query(`SELECT data FROM _storage WHERE _id = ?`).get(fileId) as { data: string } | null;
  if (!row) return;
  const file: StorageData = JSON.parse(row.data);
  if (!file.pending) return;
  const { pending, detachedAt, ...rest } = file;
  session.updateRaw(session.systemTable("_storage"), fileId, JSON.stringify(rest));
}

/** Attaches newly referenced files and detaches dropped ones for a write to `docId`. */
export function syncFiles(
  session: DbSession,
  table: { name: string; storageFields?: StorageField[] },
  docId: string,
  before: Document | null,
  after: Record<string, unknown> | null,
) {
  for (const field of table.storageFields ?? []) {
    const old = new Set(before ? idsAt(before, field.path) : []);
    const next = new Set(after ? idsAt(after, field.path) : []);
    if (!field.file) {
      for (const fileId of next) if (!old.has(fileId)) markReferenced(session, fileId);
      continue;
    }
    const name = field.path.filter((p) => p !== "*").join(".");
    for (const fileId of next) if (!old.has(fileId)) attach(session, fileId, { table: table.name, id: docId, field: name }, field.file);
    for (const fileId of old) if (!next.has(fileId)) detach(session, fileId, docId);
  }
}
