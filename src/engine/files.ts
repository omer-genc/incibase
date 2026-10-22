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

/** A field holding `_storage` ids. `path` uses "*" for array items / record values. */
export interface StorageField {
  path: string[];
  /** Options of a `file()` field; null for a plain `id("_storage")` reference. */
  file: FileFieldOptions | null;
}

const WRAPPERS = new Set(["optional", "nullable", "default", "prefault", "readonly", "nonoptional", "catch"]);

export function storageFieldsOf(schema: z.ZodType): StorageField[] {
  const out: StorageField[] = [];
  const seen = new Set<string>();
  const walk = (node: z.ZodType, path: string[]) => {
    const meta = z.globalRegistry.get(node) as Record<string, unknown> | undefined;
    const add = (file: FileFieldOptions | null) => {
      const key = path.join(".");
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ path, file });
      }
    };
    if (meta?.[FILE_META_KEY]) return add(meta[FILE_META_KEY] as FileFieldOptions);
    if (meta?.[ID_TABLE_META_KEY] === "_storage") return add(null);
    const def = (node as any)._zod.def;
    if (WRAPPERS.has(def.type)) walk(def.innerType, path);
    else if (def.type === "array") walk(def.element, [...path, "*"]);
    else if (def.type === "record") walk(def.valueType, [...path, "*"]);
    else if (def.type === "object") for (const [key, child] of Object.entries(def.shape)) walk(child as z.ZodType, [...path, key]);
    else if (def.type === "union") for (const option of def.options) walk(option, path);
    else if (def.type === "pipe") walk(def.in, path);
  };
  walk(schema, []);
  return out;
}

/** Every `_storage` id stored at `path` in `doc`. */
export function idsAt(doc: unknown, path: string[]): string[] {
  if (path.length === 0) return typeof doc === "string" ? [doc] : [];
  if (typeof doc !== "object" || doc === null) return [];
  const [head, ...rest] = path;
  if (head === "*") return Object.values(doc).flatMap((v) => idsAt(v, rest));
  return idsAt((doc as Record<string, unknown>)[head!], rest);
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

/** Who may put a file into a document: its owner, admins and system code; anyone for anonymous uploads. */
function mayAttach(file: StorageData, identity: Identity | undefined): boolean {
  if (!identity || identity.admin || identity.system) return true;
  if (file.ownerId) return file.ownerId === identity.userId;
  return !!file.anonymous;
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
