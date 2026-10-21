/// <reference lib="dom" />
// incibase admin dashboard. Talks to `/api/admin/:tool` with the admin key.
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

// ---------------------------------------------------------------------------
// API

const KEY_STORAGE = "incibase:admin-key";
const ID_PATTERN = /^[0-9a-hjkmnp-tv-z]{28}$/;

type Json = any;

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function getKey() {
  try {
    return localStorage.getItem(KEY_STORAGE);
  } catch {
    return null;
  }
}

function setKey(key: string | null) {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {}
}

async function admin<T = Json>(tool: string, args: Record<string, unknown> = {}, key = getKey()): Promise<T> {
  const res = await fetch(`/api/admin/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key ?? ""}` },
    body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(body?.error?.message ?? `HTTP ${res.status}`, res.status);
  return body.value as T;
}

// ---------------------------------------------------------------------------
// Types returned by the admin tools

interface TableInfo {
  system: boolean;
  documentSchema?: JsonSchema;
  indexes: { name: string; fields: string[]; unique: boolean }[];
  documentCount?: number;
}

interface FunctionInfo {
  path: string;
  type: "query" | "mutation" | "action";
  visibility: "public" | "internal";
  description?: string;
  args: JsonSchema;
  returns?: JsonSchema;
  mcpTool?: string;
}

interface AppInfo {
  tables: Record<string, TableInfo>;
  functions: FunctionInfo[];
}

interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  default?: unknown;
  enum?: unknown[];
  const?: unknown;
  description?: string;
  "x-incibase-table"?: string;
  [key: string]: unknown;
}

interface LogEntry {
  time: number;
  type: string;
  path: string;
  durationMs: number;
  ok: boolean;
  error?: string;
  userId?: string | null;
}

// ---------------------------------------------------------------------------
// Helpers

function useHashRoute(): [string[], (path: string) => void] {
  const read = () => (location.hash.replace(/^#\/?/, "") || "overview").split("/").map(decodeURIComponent);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    addEventListener("hashchange", onChange);
    return () => removeEventListener("hashchange", onChange);
  }, []);
  return [route, (path) => (location.hash = `#/${path}`)];
}

function useAsync<T>(fn: () => Promise<T>, deps: unknown[], pollMs?: number) {
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true });
  const run = useCallback(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    fn().then(
      (data) => !cancelled && setState({ data, loading: false }),
      (error) => !cancelled && setState((s) => ({ ...s, error, loading: false })),
    );
    return () => void (cancelled = true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    const cancel = run();
    if (!pollMs) return cancel;
    const timer = setInterval(run, pollMs);
    return () => {
      cancel();
      clearInterval(timer);
    };
  }, [run, pollMs]);
  return { ...state, reload: run };
}

function formatDuration(ms: number) {
  if (ms < 1) return `${ms.toFixed(2)}ms`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatUptime(ms: number) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function formatTime(ms: number) {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString() : d.toLocaleString();
}

function shortId(id: string) {
  return `${id.slice(0, 6)}…${id.slice(-5)}`;
}

function preview(value: unknown): ReactNode {
  if (value === undefined) return <span className="null">—</span>;
  if (value === null) return <span className="null">null</span>;
  if (typeof value === "string") return ID_PATTERN.test(value) ? <span title={value}>{shortId(value)}</span> : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** A starting value for a JSON Schema: defaults, else empty values for required fields. */
function sample(schema: JsonSchema | undefined, includeOptional = false): unknown {
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
      return 0;
    case "boolean":
      return false;
    case "null":
      return null;
    default:
      return null;
  }
}

function parseJson(text: string): Record<string, unknown> {
  const value = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value;
}

function withoutSystemFields(doc: Record<string, unknown>) {
  const { _id, _creationTime, ...rest } = doc;
  return rest;
}

// ---------------------------------------------------------------------------
// Toasts

type Toast = { id: number; text: string; error?: boolean };
let pushToast: (text: string, error?: boolean) => void = () => {};

function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => {
    let next = 1;
    pushToast = (text, error) => {
      const id = next++;
      setToasts((t) => [...t, { id, text, error }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), error ? 6000 : 2500);
    };
  }, []);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.error ? "error" : ""}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

const notifyError = (err: unknown) => pushToast((err as Error)?.message ?? String(err), true);

// ---------------------------------------------------------------------------
// Login

function Login({ onLogin }: { onLogin: () => void }) {
  const [key, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await admin("admin_overview", {}, key.trim());
      setKey(key.trim());
      onLogin();
    } catch (err) {
      setError((err as ApiError).status === 403 ? "That is not the admin key." : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <div className="brand" style={{ padding: 0 }}>
          <span className="brand-dot" /> incibase
        </div>
        <div className="muted">
          Enter the admin key. <code>incibase dev</code> prints it on start; otherwise run <code>incibase admin-key</code>.
        </div>
        <input
          className="input mono"
          type="password"
          autoFocus
          placeholder="ik_admin_…"
          value={key}
          onChange={(e) => setValue(e.target.value)}
        />
        {error && <div className="error-box">{error}</div>}
        <button className="btn primary" disabled={busy || !key.trim()}>
          {busy ? "Checking…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview

function Overview({ go }: { go: (path: string) => void }) {
  const { data, error } = useAsync(() => admin("admin_overview"), [], 5000);
  if (error) return <div className="error-box">{error.message}</div>;
  if (!data) return <div className="muted">Loading…</div>;
  const tables = Object.entries(data.tables as Record<string, { system: boolean; documentCount: number }>);
  return (
    <>
      <h1 className="page-title">
        Overview {data.dev && <span className="badge accent">dev</span>}
      </h1>
      <div className="grid" style={{ marginBottom: 14 }}>
        <Stat label="Uptime" value={formatUptime(data.uptimeMs)} hint={`v${data.version}`} />
        <Stat label="Functions" value={data.functions.query + data.functions.mutation + data.functions.action} hint={[plural(data.functions.query, "query", "queries"), plural(data.functions.mutation, "mutation"), plural(data.functions.action, "action")].join(" · ")} />
        <Stat label="Live subscriptions" value={data.subscriptions} hint="Shared WebSocket queries" />
        <Stat
          label="Recent errors"
          value={data.recentErrors}
          hint={`of the last ${data.recentCalls} calls`}
          onClick={() => go("logs")}
        />
      </div>
      <div className="grid">
        <div className="card">
          <h3>Tables</h3>
          <table>
            <tbody>
              {tables.map(([name, t]) => (
                <tr key={name} onClick={() => go(`data/${name}`)}>
                  <td>
                    {name} {t.system && <span className="badge">system</span>}
                  </td>
                  <td className="count" style={{ textAlign: "right" }}>
                    {t.documentCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card">
          <h3>Endpoints</h3>
          <dl className="kv">
            <dt>API</dt>
            <dd className="mono">{data.publicUrl}/api</dd>
            <dt>Realtime</dt>
            <dd className="mono">{String(data.publicUrl).replace(/^http/, "ws")}/api/ws</dd>
            <dt>MCP</dt>
            <dd className="mono">{data.publicUrl}/mcp</dd>
            <dt>MCP tools</dt>
            <dd>{data.functions.mcpTools} app tool(s) + admin tools</dd>
          </dl>
        </div>
        {data.crons.length > 0 && (
          <div className="card">
            <h3>Cron jobs</h3>
            <dl className="kv">
              {data.crons.map((c: any) => (
                <Fragmented key={c.name}>
                  <dt>{c.name}</dt>
                  <dd className="mono">
                    {c.schedule.kind === "interval" ? `every ${formatUptime(c.schedule.ms)}` : c.schedule.expression} → {c.path}
                  </dd>
                </Fragmented>
              ))}
            </dl>
          </div>
        )}
        {data.httpRoutes.length > 0 && (
          <div className="card">
            <h3>HTTP routes</h3>
            {data.httpRoutes.map((r: any) => (
              <div key={`${r.method} ${r.path}`} className="mono">
                <span className="badge">{r.method}</span> {r.path}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function Fragmented({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

function Stat({ label, value, hint, onClick }: { label: string; value: ReactNode; hint?: string; onClick?: () => void }) {
  return (
    <div className="card" onClick={onClick} style={onClick ? { cursor: "pointer" } : undefined}>
      <div className="stat-label">{label}</div>
      <div className="stat">{value}</div>
      {hint && <div className="stat-label">{hint}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Data browser

function Data({ app, table, go, reloadApp }: { app: AppInfo; table?: string; go: (p: string) => void; reloadApp: () => void }) {
  const names = Object.keys(app.tables);
  const user = names.filter((n) => !app.tables[n]!.system);
  const system = names.filter((n) => app.tables[n]!.system);
  const current = table && app.tables[table] ? table : user[0] ?? system[0];

  useEffect(() => {
    if (current && current !== table) go(`data/${current}`);
  }, [current, table]);

  return (
    <>
      <h1 className="page-title">Data</h1>
      <div className="split">
        <div className="list">
          {user.length > 0 && <div className="list-section">Tables</div>}
          {user.map((n) => (
            <TableLink key={n} name={n} info={app.tables[n]!} active={n === current} go={go} />
          ))}
          <div className="list-section">System</div>
          {system.map((n) => (
            <TableLink key={n} name={n} info={app.tables[n]!} active={n === current} go={go} />
          ))}
        </div>
        {current ? (
          <Documents key={current} table={current} info={app.tables[current]!} app={app} onChange={reloadApp} />
        ) : (
          <div className="empty">No tables yet. Add one to schema.ts.</div>
        )}
      </div>
    </>
  );
}

function TableLink({ name, info, active, go }: { name: string; info: TableInfo; active: boolean; go: (p: string) => void }) {
  return (
    <button className={`list-item ${active ? "active" : ""}`} onClick={() => go(`data/${name}`)}>
      <span>{name}</span>
      <span className="count">{info.documentCount}</span>
    </button>
  );
}

type Doc = Record<string, unknown> & { _id: string; _creationTime: number };

function Documents({ table, info, app, onChange }: { table: string; info: TableInfo; app: AppInfo; onChange: () => void }) {
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [filter, setFilter] = useState("");
  const [auto, setAuto] = useState(false);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [done, setDone] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Doc | null>(null);
  const [creating, setCreating] = useState(false);
  const pageSize = 50;

  const where = useMemo(() => {
    const m = filter.match(/^\s*([A-Za-z][\w.]*)\s*=\s*(.+?)\s*$/);
    if (!m) return undefined;
    let value: unknown = m[2]!;
    try {
      value = JSON.parse(m[2]!);
    } catch {}
    return { [m[1]!]: value as string };
  }, [filter]);

  const load = useCallback(
    async (more: boolean) => {
      setLoading(true);
      try {
        const page = await admin("admin_list_documents", {
          table,
          order,
          // A refresh reloads as many documents as are shown, so the list keeps its length.
          limit: more ? pageSize : Math.min(500, Math.max(pageSize, docs.length)),
          cursor: more ? cursor : null,
          ...(where ? { where } : {}),
        });
        setDocs((d) => (more ? [...d, ...page.page] : page.page));
        setCursor(page.continueCursor);
        setDone(page.isDone);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [table, order, where, cursor],
  );

  // Reload from the start whenever the query changes.
  useEffect(() => {
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, order, where]);

  useEffect(() => {
    if (!auto) return;
    const timer = setInterval(() => void load(false), 2000);
    return () => clearInterval(timer);
  }, [auto, load]);

  const columns = useMemo(() => {
    const fromSchema = Object.keys(info.documentSchema?.properties ?? {});
    const fromDocs = new Set<string>();
    for (const d of docs.slice(0, 50)) for (const k of Object.keys(d)) if (!k.startsWith("_")) fromDocs.add(k);
    return [...new Set([...fromSchema, ...fromDocs])].slice(0, 8);
  }, [info, docs]);

  const refresh = () => {
    void load(false);
    onChange();
  };

  return (
    <div style={{ minWidth: 0 }}>
      <div className="toolbar">
        <strong>{table}</strong>
        <span className="count">{info.documentCount} documents</span>
        <span className="spacer" />
        <input
          className="input mono"
          style={{ width: 200 }}
          placeholder='field = "value"'
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          title="Equality filter, e.g. pinned = true"
        />
        <select className="input" value={order} onChange={(e) => setOrder(e.target.value as "asc" | "desc")}>
          <option value="desc">Newest first</option>
          <option value="asc">Oldest first</option>
        </select>
        <label className="check">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Live
        </label>
        <button className="btn" onClick={refresh} disabled={loading}>
          Refresh
        </button>
        {(!info.system || table === "_users") && (
          <button className="btn primary" onClick={() => setCreating(true)}>
            {table === "_users" ? "New user" : "New document"}
          </button>
        )}
      </div>
      {error && <div className="error-box" style={{ marginBottom: 12 }}>{error}</div>}
      <div className="table-wrap">
        {docs.length === 0 && !loading ? (
          <div className="empty">{where ? "No documents match." : "No documents yet."}</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>_id</th>
                {columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
                <th>_creationTime</th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d._id} className={selected?._id === d._id ? "selected" : ""} onClick={() => setSelected(d)}>
                  <td className="mono" title={d._id}>
                    {shortId(d._id)}
                  </td>
                  {columns.map((c) => (
                    <td key={c} className={typeof d[c] === "string" && ID_PATTERN.test(d[c] as string) ? "mono" : ""}>
                      {preview(d[c])}
                    </td>
                  ))}
                  <td className="muted">{formatTime(d._creationTime)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {!done && (
        <div style={{ marginTop: 10 }}>
          <button className="btn" onClick={() => void load(true)} disabled={loading}>
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
      {selected && (
        <DocumentDrawer
          key={selected._id}
          doc={selected}
          table={table}
          info={info}
          app={app}
          onClose={() => setSelected(null)}
          onSaved={(doc) => {
            setSelected(doc);
            refresh();
          }}
          onDeleted={() => {
            setSelected(null);
            refresh();
          }}
        />
      )}
      {creating &&
        (table === "_users" ? (
          <NewUserDrawer onClose={() => setCreating(false)} onCreated={refresh} />
        ) : (
          <NewDocumentDrawer table={table} info={info} onClose={() => setCreating(false)} onCreated={refresh} />
        ))}
    </div>
  );
}

function Drawer({ title, onClose, children, actions }: { title: ReactNode; onClose: () => void; children: ReactNode; actions?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="drawer" role="dialog">
      <div className="drawer-head">
        <strong style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{title}</strong>
        <span className="spacer" />
        {actions}
        <button className="btn small" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="drawer-body">{children}</div>
    </div>
  );
}

function DocumentDrawer({
  doc: initial,
  table,
  info,
  app,
  onClose,
  onSaved,
  onDeleted,
}: {
  doc: Doc;
  table: string;
  info: TableInfo;
  app: AppInfo;
  onClose: () => void;
  onSaved: (doc: Doc) => void;
  onDeleted: () => void;
}) {
  const [stack, setStack] = useState<{ table: string; document: Doc }[]>([{ table, document: initial }]);
  const { table: docTable, document: doc } = stack.at(-1)!;
  const editable = stack.length === 1 && !info.system;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openRef = async (id: string) => {
    try {
      const target = await admin("admin_get_document", { id });
      if (target) setStack((s) => [...s, target]);
      else pushToast("Document not found", true);
    } catch (err) {
      notifyError(err);
    }
  };

  const startEdit = () => {
    setText(JSON.stringify(withoutSystemFields(doc), null, 2));
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    setBusy(true);
    try {
      const saved = await admin("admin_replace_document", { id: doc._id, document: parseJson(text) });
      pushToast("Saved");
      setEditing(false);
      onSaved(saved);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete ${doc._id}?`)) return;
    try {
      await admin("admin_delete_document", { id: doc._id });
      pushToast("Deleted");
      onDeleted();
    } catch (err) {
      notifyError(err);
    }
  };

  const properties = (stack.length === 1 ? info : app.tables[docTable])?.documentSchema?.properties ?? {};

  return (
    <Drawer
      title={
        <>
          {stack.length > 1 && (
            <button className="btn small" onClick={() => setStack((s) => s.slice(0, -1))} style={{ marginRight: 8 }}>
              ←
            </button>
          )}
          <span className="badge">{docTable}</span> <span className="mono">{doc._id}</span>
        </>
      }
      onClose={onClose}
      actions={
        editable &&
        !editing && (
          <>
            <button className="btn small" onClick={startEdit}>
              Edit
            </button>
            <button className="btn small danger" onClick={remove}>
              Delete
            </button>
          </>
        )
      }
    >
      {editing ? (
        <>
          <textarea className="textarea" style={{ minHeight: 320 }} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
          {error && <div className="error-box">{error}</div>}
          <div className="toolbar">
            <button className="btn primary" onClick={save} disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button className="btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <span className="muted">Fields left out are removed. Validated against the schema.</span>
          </div>
        </>
      ) : (
        <>
          <dl className="kv">
            <dt>_creationTime</dt>
            <dd>
              {formatTime(doc._creationTime)} <span className="muted mono">{doc._creationTime}</span>
            </dd>
            {Object.entries(withoutSystemFields(doc)).map(([k, v]) => {
              const refTable = properties[k]?.["x-incibase-table"] ?? refTableOf(properties[k]);
              const isRef = typeof v === "string" && ID_PATTERN.test(v);
              return (
                <Fragmented key={k}>
                  <dt>{k}</dt>
                  <dd className={isRef ? "mono" : ""}>
                    {isRef ? (
                      <a href="#" onClick={(e) => (e.preventDefault(), void openRef(v as string))}>
                        {v as string}
                      </a>
                    ) : typeof v === "object" && v !== null ? (
                      <pre className="json">{JSON.stringify(v, null, 2)}</pre>
                    ) : (
                      preview(v)
                    )}
                    {isRef && refTable && <span className="badge" style={{ marginLeft: 6 }}>{refTable}</span>}
                  </dd>
                </Fragmented>
              );
            })}
          </dl>
          {docTable === "_storage" && (
            <a className="btn" href={`/api/storage/${doc._id}`} target="_blank" rel="noreferrer" style={{ alignSelf: "start" }}>
              Open file
            </a>
          )}
          <details>
            <summary className="muted" style={{ cursor: "pointer" }}>
              JSON
            </summary>
            <pre className="json" style={{ marginTop: 8 }}>
              {JSON.stringify(doc, null, 2)}
            </pre>
          </details>
        </>
      )}
    </Drawer>
  );
}

function refTableOf(schema: JsonSchema | undefined): string | undefined {
  return schema?.anyOf?.map((s) => s["x-incibase-table"]).find(Boolean) as string | undefined;
}

function NewDocumentDrawer({ table, info, onClose, onCreated }: { table: string; info: TableInfo; onClose: () => void; onCreated: () => void }) {
  const [text, setText] = useState(() => JSON.stringify(sample(info.documentSchema) ?? {}, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const { id } = await admin("admin_insert_document", { table, document: parseJson(text) });
      pushToast(`Created ${id}`);
      onCreated();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer title={`New document in ${table}`} onClose={onClose}>
      <textarea className="textarea" style={{ minHeight: 300 }} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      {error && <div className="error-box">{error}</div>}
      <div className="toolbar">
        <button className="btn primary" onClick={create} disabled={busy}>
          {busy ? "Creating…" : "Create"}
        </button>
        <span className="muted">Validated against the table schema.</span>
      </div>
    </Drawer>
  );
}

function NewUserDrawer({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const result = await admin("admin_create_user", { email, password, ...(name ? { name } : {}) });
      setToken(result.token);
      setError(null);
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Drawer title="New user" onClose={onClose}>
      {token ? (
        <>
          <div>User created. A session token for testing:</div>
          <pre className="json">{token}</pre>
        </>
      ) : (
        <form onSubmit={create} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <input className="input" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input className="input" placeholder="password (8+ chars)" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <input className="input" placeholder="name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
          {error && <div className="error-box">{error}</div>}
          <button className="btn primary" style={{ alignSelf: "start" }}>
            Create user
          </button>
        </form>
      )}
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Functions

function Functions({ app, path, go }: { app: AppInfo; path?: string; go: (p: string) => void }) {
  const [search, setSearch] = useState("");
  const modules = useMemo(() => {
    const groups = new Map<string, FunctionInfo[]>();
    for (const f of app.functions) {
      if (search && !f.path.toLowerCase().includes(search.toLowerCase())) continue;
      const mod = f.path.split(":")[0]!;
      groups.set(mod, [...(groups.get(mod) ?? []), f]);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [app, search]);
  const current = app.functions.find((f) => f.path === path) ?? app.functions[0];

  return (
    <>
      <h1 className="page-title">Functions</h1>
      <div className="split">
        <div className="list">
          <input className="input" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} style={{ margin: 4 }} />
          {modules.map(([mod, fns]) => (
            <div key={mod}>
              <div className="list-section">{mod}</div>
              {fns.map((f) => (
                <button key={f.path} className={`list-item ${f.path === current?.path ? "active" : ""}`} onClick={() => go(`functions/${f.path}`)}>
                  <span>{f.path.split(":")[1]}</span>
                  <span className={`badge ${f.type}`}>{f.type[0]!.toUpperCase()}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
        {current ? <FunctionRunner key={current.path} fn={current} /> : <div className="empty">No functions yet.</div>}
      </div>
    </>
  );
}

function FunctionRunner({ fn }: { fn: FunctionInfo }) {
  const [text, setText] = useState(() => JSON.stringify(sample(fn.args) ?? {}, null, 2));
  const [asUser, setAsUser] = useState("");
  const [result, setResult] = useState<{ value?: unknown; error?: string; ms: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const properties = Object.entries(fn.args.properties ?? {});

  const run = async () => {
    setBusy(true);
    const started = performance.now();
    try {
      const value = await admin("admin_run_function", { path: fn.path, args: parseJson(text), ...(asUser ? { asUser } : {}) });
      setResult({ value, ms: performance.now() - started });
    } catch (err) {
      setResult({ error: (err as Error).message, ms: performance.now() - started });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
      <div className="card">
        <div className="toolbar" style={{ marginBottom: 6 }}>
          <strong className="mono">{fn.path}</strong>
          <span className={`badge ${fn.type}`}>{fn.type}</span>
          {fn.visibility === "internal" && <span className="badge">internal</span>}
          {fn.mcpTool && <span className="badge accent">MCP: {fn.mcpTool}</span>}
        </div>
        {fn.description && <div className="muted">{fn.description}</div>}
        {properties.length > 0 && (
          <dl className="kv" style={{ marginTop: 10 }}>
            {properties.map(([name, schema]) => (
              <Fragmented key={name}>
                <dt className="mono">
                  {name}
                  {fn.args.required?.includes(name) ? "" : "?"}
                </dt>
                <dd className="mono muted">{describeSchema(schema)}</dd>
              </Fragmented>
            ))}
          </dl>
        )}
      </div>
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h3>Run</h3>
        <textarea
          className="textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && void run()}
          spellCheck={false}
        />
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <button className="btn primary" onClick={run} disabled={busy}>
            {busy ? "Running…" : `Run ${fn.type}`}
          </button>
          <input className="input mono" style={{ width: 300 }} placeholder="act as user id (optional)" value={asUser} onChange={(e) => setAsUser(e.target.value.trim())} />
          <span className="muted">⌘/Ctrl + Enter</span>
        </div>
      </div>
      {result && (
        <div className="card">
          <div className="toolbar">
            <h3 style={{ margin: 0 }}>Result</h3>
            <span className={`badge ${result.error ? "err" : "ok"}`}>{result.error ? "error" : "ok"}</span>
            <span className="muted">{formatDuration(result.ms)}</span>
          </div>
          {result.error ? <div className="error-box">{result.error}</div> : <pre className="json">{JSON.stringify(result.value, null, 2)}</pre>}
        </div>
      )}
    </div>
  );
}

function describeSchema(schema: JsonSchema): string {
  if (schema["x-incibase-table"]) return `Id<"${schema["x-incibase-table"]}">`;
  if (schema.anyOf) return schema.anyOf.map(describeSchema).join(" | ");
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  const type = Array.isArray(schema.type) ? schema.type.join(" | ") : (schema.type ?? "any");
  const extra = schema.default !== undefined ? ` = ${JSON.stringify(schema.default)}` : "";
  if (type === "array") return `${describeSchema(schema.items ?? {})}[]${extra}`;
  if (type === "object" && schema.properties) return `{ ${Object.keys(schema.properties).join(", ")} }${extra}`;
  return `${type}${extra}`;
}

// ---------------------------------------------------------------------------
// Logs

function Logs() {
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [path, setPath] = useState("");
  const [live, setLive] = useState(true);
  const { data, error, reload } = useAsync<LogEntry[]>(
    () => admin("admin_logs", { limit: 300, errorsOnly, ...(path ? { path } : {}) }),
    [errorsOnly, path],
    live ? 2000 : undefined,
  );
  return (
    <>
      <h1 className="page-title">Logs</h1>
      <div className="toolbar">
        <input className="input" placeholder="Filter by path" value={path} onChange={(e) => setPath(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} /> Errors only
        </label>
        <label className="check">
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Live
        </label>
        <span className="spacer" />
        <button className="btn" onClick={reload}>
          Refresh
        </button>
      </div>
      {error && <div className="error-box">{error.message}</div>}
      <div className="table-wrap">
        {data && data.length === 0 ? (
          <div className="empty">No function calls yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Type</th>
                <th>Function</th>
                <th style={{ textAlign: "right" }}>Duration</th>
                <th>Status</th>
                <th>User</th>
              </tr>
            </thead>
            <tbody>
              {data?.map((l, i) => (
                <tr key={`${l.time}-${i}`} style={{ cursor: "default" }}>
                  <td className="muted">{formatTime(l.time)}</td>
                  <td>
                    <span className={`badge ${l.type}`}>{l.type}</span>
                  </td>
                  <td className="mono">{l.path}</td>
                  <td className="count" style={{ textAlign: "right" }}>
                    {formatDuration(l.durationMs)}
                  </td>
                  <td style={{ whiteSpace: "normal" }}>
                    {l.ok ? <span className="badge ok">ok</span> : <span className="badge err" title={l.error}>{l.error ?? "error"}</span>}
                  </td>
                  <td className="mono muted">{l.userId ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// SQL

function Sql() {
  const [query, setQuery] = useState("SELECT name, number, active FROM _incibase_tables");
  const [result, setResult] = useState<{ rows: Record<string, unknown>[]; truncated: boolean; ms: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    const started = performance.now();
    try {
      const r = await admin("admin_sql", { query });
      setResult({ ...r, ms: performance.now() - started });
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const columns = result?.rows[0] ? Object.keys(result.rows[0]) : [];
  return (
    <>
      <h1 className="page-title">SQL</h1>
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 14 }}>
        <textarea
          className="textarea"
          style={{ minHeight: 110 }}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && void run()}
          spellCheck={false}
        />
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <button className="btn primary" onClick={run} disabled={busy}>
            {busy ? "Running…" : "Run"}
          </button>
          <span className="muted">
            Read-only. Documents live in <code>data</code> (JSON): <code>json_extract(data, '$.field')</code>. ⌘/Ctrl + Enter
          </span>
        </div>
      </div>
      {error && <div className="error-box">{error}</div>}
      {result && (
        <>
          <div className="muted" style={{ marginBottom: 8 }}>
            {result.rows.length} row(s){result.truncated ? " (truncated to 1000)" : ""} · {formatDuration(result.ms)}
          </div>
          <div className="table-wrap">
            {result.rows.length === 0 ? (
              <div className="empty">No rows.</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    {columns.map((c) => (
                      <th key={c}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, i) => (
                    <tr key={i} style={{ cursor: "default" }}>
                      {columns.map((c) => (
                        <td key={c} className="mono" title={String(row[c])}>
                          {preview(row[c])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Schema

function Schema({ app }: { app: AppInfo }) {
  return (
    <>
      <h1 className="page-title">Schema</h1>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {Object.entries(app.tables).map(([name, t]) => (
          <div key={name} className="card">
            <div className="toolbar">
              <strong>{name}</strong>
              {t.system && <span className="badge">system</span>}
              <span className="count">{t.documentCount} documents</span>
            </div>
            {t.documentSchema?.properties && (
              <dl className="kv" style={{ marginBottom: 10 }}>
                {Object.entries(t.documentSchema.properties).map(([field, schema]) => (
                  <Fragmented key={field}>
                    <dt className="mono">
                      {field}
                      {t.documentSchema!.required?.includes(field) ? "" : "?"}
                    </dt>
                    <dd className="mono muted">{describeSchema(schema)}</dd>
                  </Fragmented>
                ))}
              </dl>
            )}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <span className="badge mono">by_creation_time</span>
              {t.indexes.map((i) => (
                <span key={i.name} className="badge accent mono" title={i.fields.join(", ")}>
                  {i.name}({i.fields.join(", ")}){i.unique ? " unique" : ""}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Shell

const PAGES = [
  ["overview", "Overview"],
  ["data", "Data"],
  ["functions", "Functions"],
  ["logs", "Logs"],
  ["sql", "SQL"],
  ["schema", "Schema"],
] as const;

function App() {
  const [authed, setAuthed] = useState(() => !!getKey());
  const [route, go] = useHashRoute();
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const loading = useRef(false);

  const reloadApp = useCallback(() => {
    if (loading.current) return;
    loading.current = true;
    admin<AppInfo>("admin_schema")
      .then(setAppInfo, (err: ApiError) => {
        if (err.status === 403 || err.status === 401) {
          setKey(null);
          setAuthed(false);
        } else setError(err);
      })
      .finally(() => (loading.current = false));
  }, []);

  useEffect(() => {
    if (authed) reloadApp();
  }, [authed, reloadApp]);

  if (!authed) return <Login onLogin={() => setAuthed(true)} />;

  const [page, ...rest] = route;
  const logout = () => {
    setKey(null);
    setAuthed(false);
    setAppInfo(null);
  };

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">
          <span className="brand-dot" /> incibase
        </div>
        {PAGES.map(([id, label]) => (
          <a key={id} href={`#/${id}`} className={`nav-link ${page === id ? "active" : ""}`}>
            {label}
          </a>
        ))}
        <div className="sidebar-footer">
          <span>{location.host}</span>
          <a href="#" onClick={(e) => (e.preventDefault(), logout())}>
            Sign out
          </a>
        </div>
      </nav>
      <main className="main">
        {error && <div className="error-box">{error.message}</div>}
        {page === "overview" && <Overview go={go} />}
        {page !== "overview" && !appInfo && !error && <div className="muted">Loading…</div>}
        {appInfo && page === "data" && <Data app={appInfo} table={rest[0]} go={go} reloadApp={reloadApp} />}
        {appInfo && page === "functions" && <Functions app={appInfo} path={rest.join("/") || undefined} go={go} />}
        {page === "logs" && <Logs />}
        {page === "sql" && <Sql />}
        {appInfo && page === "schema" && <Schema app={appInfo} />}
      </main>
      <Toasts />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
