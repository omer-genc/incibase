// Calls `/api/admin/:tool` with the admin key kept in localStorage.

export const ID_PATTERN = /^[0-9a-hjkmnp-tv-z]{28}$/;
const KEY_STORAGE = "incibase:admin-key";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export function getAdminKey(): string | null {
  try {
    return localStorage.getItem(KEY_STORAGE);
  } catch {
    return null;
  }
}

export function setAdminKey(key: string | null) {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {}
}

const unauthorizedListeners = new Set<() => void>();

/** Called when the server rejects the stored key (e.g. a different project now runs on this port). */
export function onUnauthorized(listener: () => void) {
  unauthorizedListeners.add(listener);
  return () => void unauthorizedListeners.delete(listener);
}

export async function admin<T = any>(tool: string, args: Record<string, unknown> = {}, key = getAdminKey()): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/admin/${tool}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key ?? ""}` },
      body: JSON.stringify(args),
    });
  } catch {
    throw new ApiError("Cannot reach the server", 0, "NETWORK");
  }
  const body = (await res.json().catch(() => null)) as { value?: T; error?: { code?: string; message?: string } } | null;
  if (!res.ok) {
    const err = new ApiError(body?.error?.message ?? `HTTP ${res.status}`, res.status, body?.error?.code);
    if (res.status === 401 || res.status === 403) for (const l of unauthorizedListeners) l();
    throw err;
  }
  return body?.value as T;
}

export async function health(): Promise<{ ok: boolean; version: string; startedAt: number }> {
  const res = await fetch("/api/health", { cache: "no-store" });
  if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status);
  return res.json();
}

// ---------------------------------------------------------------------------
// Shapes returned by the admin tools

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  default?: unknown;
  enum?: unknown[];
  const?: unknown;
  description?: string;
  format?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  "x-incibase-table"?: string;
  [key: string]: unknown;
}

export interface TableInfo {
  system: boolean;
  documentSchema?: JsonSchema;
  indexes: { name: string; fields: string[]; unique: boolean }[];
  documentCount?: number;
}

export type FunctionType = "query" | "mutation" | "action";

export interface FunctionInfo {
  path: string;
  type: FunctionType;
  visibility: "public" | "internal";
  description?: string;
  args: JsonSchema;
  returns?: JsonSchema;
  mcpTool?: string;
}

export interface AppInfo {
  tables: Record<string, TableInfo>;
  functions: FunctionInfo[];
}

export interface Overview {
  version: string;
  dev: boolean;
  startedAt: number;
  uptimeMs: number;
  publicUrl: string;
  tables: Record<string, { system: boolean; documentCount: number }>;
  functions: { query: number; mutation: number; action: number; mcpTools: number };
  subscriptions: number;
  crons: { name: string; path: string; schedule: { kind: "interval"; ms: number } | { kind: "cron"; expression: string; tz?: string } }[];
  httpRoutes: { method: string; path: string }[];
  recentCalls: number;
  recentErrors: number;
}

export type LogType = FunctionType | "http" | "cron" | "scheduled";

export interface LogEntry {
  time: number;
  type: LogType;
  path: string;
  durationMs: number;
  ok: boolean;
  error?: string;
  userId?: string | null;
}

export type Doc = Record<string, unknown> & { _id: string; _creationTime: number };

export interface Page<T> {
  page: T[];
  continueCursor: string;
  isDone: boolean;
}
