import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  ArrowLeftIcon,
  DatabaseIcon,
  ExternalLinkIcon,
  FilterIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { CopyButton, EmptyState, ErrorAlert, PageHeader, TableSkeleton } from "@/components/common";
import { useConfirm } from "@/components/confirm";
import { JsonEditor, JsonView, parseObject } from "@/components/json";
import { IdText, TimeText, ValueCell } from "@/components/value";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { admin, ID_PATTERN, type AppInfo, type Doc, type Page, type TableInfo } from "@/lib/api";
import { formatDateTime, plural } from "@/lib/format";
import { useNow, useStoredState } from "@/lib/hooks";
import { describeSchema, refTable, sample } from "@/lib/schema";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 50;
const MAX_COLUMNS = 10;

export function DataPage({
  app,
  table,
  navigate,
  reloadApp,
}: {
  app: AppInfo;
  table?: string;
  navigate: (path: string, options?: { replace?: boolean }) => void;
  reloadApp: () => Promise<void>;
}) {
  const names = Object.keys(app.tables);
  const userTables = names.filter((n) => !app.tables[n]!.system);
  const systemTables = names.filter((n) => app.tables[n]!.system);
  const current = table && app.tables[table] ? table : (userTables[0] ?? systemTables[0]);

  useEffect(() => {
    if (current && current !== table) navigate(`data/${current}`, { replace: true });
  }, [current, table, navigate]);

  return (
    <>
      <PageHeader title="Data" description="Browse and edit documents. Writes are validated against the schema." />
      <div className="grid items-start gap-4 lg:grid-cols-[13rem_minmax(0,1fr)]">
        {/* Table picker: a list on wide screens, a select otherwise. */}
        <div className="lg:hidden">
          <Select value={current} onValueChange={(v) => navigate(`data/${v}`)}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Choose a table" />
            </SelectTrigger>
            <SelectContent>
              {userTables.length > 0 && (
                <SelectGroup>
                  <SelectLabel>Tables</SelectLabel>
                  {userTables.map((n) => (
                    <SelectItem key={n} value={n}>
                      {n} ({app.tables[n]!.documentCount ?? 0})
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
              <SelectGroup>
                <SelectLabel>System</SelectLabel>
                {systemTables.map((n) => (
                  <SelectItem key={n} value={n}>
                    {n} ({app.tables[n]!.documentCount ?? 0})
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <nav className="hidden rounded-xl border bg-card p-1.5 lg:block">
          <TableGroup label="Tables" names={userTables} app={app} current={current} />
          {userTables.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">No tables in schema.ts yet.</p>}
          <TableGroup label="System" names={systemTables} app={app} current={current} />
        </nav>

        {current && <Documents key={current} table={current} info={app.tables[current]!} app={app} reloadApp={reloadApp} />}
      </div>
    </>
  );
}

function TableGroup({ label, names, app, current }: { label: string; names: string[]; app: AppInfo; current?: string }) {
  if (names.length === 0) return null;
  return (
    <div className="mb-1">
      <div className="px-2 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</div>
      {names.map((n) => (
        <a
          key={n}
          href={`#/data/${n}`}
          aria-current={n === current ? "page" : undefined}
          className={cn(
            "flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent",
            n === current && "bg-accent font-medium",
          )}
        >
          <span className="truncate">{n}</span>
          <span className="font-mono text-xs text-muted-foreground tabular-nums">{(app.tables[n]!.documentCount ?? 0).toLocaleString()}</span>
        </a>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Document list

function parseFilter(text: string): { where?: Record<string, unknown>; invalid: boolean } {
  if (!text.trim()) return { invalid: false };
  const m = text.match(/^\s*([A-Za-z][\w.]*)\s*={1,2}\s*(.+?)\s*$/);
  if (!m) return { invalid: true };
  let value: unknown = m[2]!;
  try {
    value = JSON.parse(m[2]!);
  } catch {
    value = m[2]!.replace(/^["']|["']$/g, "");
  }
  if (typeof value === "object" && value !== null) return { invalid: true };
  return { where: { [m[1]!]: value }, invalid: false };
}

function Documents({ table, info, app, reloadApp }: { table: string; info: TableInfo; app: AppInfo; reloadApp: () => Promise<void> }) {
  const [order, setOrder] = useStoredState<"asc" | "desc">("incibase:data-order", "desc");
  const [filterText, setFilterText] = useState("");
  const [appliedFilter, setAppliedFilter] = useState("");
  const [live, setLive] = useState(false);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [done, setDone] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [selected, setSelected] = useState<Doc | null>(null);
  const [creating, setCreating] = useState(false);
  const request = useRef(0);
  const shown = useRef(0);
  shown.current = docs.length;
  const now = useNow();

  const { where, invalid } = useMemo(() => parseFilter(appliedFilter), [appliedFilter]);

  const load = useCallback(
    async (mode: "reset" | "refresh" | "more", from: string | null = null) => {
      const id = ++request.current;
      if (mode === "reset") {
        setDocs([]);
        setLoading(true);
      }
      if (mode === "more") setLoading(true);
      try {
        const page = await admin<Page<Doc>>("admin_list_documents", {
          table,
          order,
          // A refresh reloads as many documents as are shown so the list keeps its length.
          limit: mode === "more" ? PAGE_SIZE : Math.min(500, Math.max(PAGE_SIZE, mode === "refresh" ? shown.current : 0)),
          cursor: mode === "more" ? from : null,
          ...(where ? { where } : {}),
        });
        if (id !== request.current) return;
        setDocs((d) => (mode === "more" ? [...d, ...page.page] : page.page));
        setCursor(page.continueCursor);
        setDone(page.isDone);
        setError(null);
      } catch (err) {
        if (id === request.current) setError(err as Error);
      } finally {
        if (id === request.current) setLoading(false);
      }
    },
    [table, order, where],
  );

  useEffect(() => {
    if (!invalid) void load("reset");
  }, [load, invalid]);

  useEffect(() => {
    if (!live || invalid) return;
    const timer = setInterval(() => document.visibilityState === "visible" && void load("refresh"), 2000);
    return () => clearInterval(timer);
  }, [live, invalid, load]);

  const refresh = () => {
    void load("refresh");
    void reloadApp();
  };

  const columns = useMemo(() => {
    const keys = new Set(Object.keys(info.documentSchema?.properties ?? {}));
    for (const d of docs.slice(0, 100)) for (const k of Object.keys(d)) if (!k.startsWith("_")) keys.add(k);
    return [...keys].slice(0, MAX_COLUMNS);
  }, [info, docs]);

  const total = info.documentCount ?? 0;
  const canCreate = !info.system || table === "_users";

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-auto flex min-w-0 items-baseline gap-2">
          <h2 className="truncate font-semibold">{table}</h2>
          <span className="text-sm text-muted-foreground">{plural(total, "document")}</span>
          {info.system && <Badge variant="outline">read-only</Badge>}
        </div>
        <form
          className="relative w-full sm:w-auto"
          onSubmit={(e) => {
            e.preventDefault();
            setAppliedFilter(filterText);
          }}
        >
          <FilterIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            onBlur={() => setAppliedFilter(filterText)}
            placeholder='field = "value"'
            aria-invalid={parseFilter(filterText).invalid}
            className="h-8 w-full pr-7 pl-8 font-mono text-xs sm:w-52"
          />
          {filterText && (
            <button
              type="button"
              onClick={() => {
                setFilterText("");
                setAppliedFilter("");
              }}
              className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear filter"
            >
              <XIcon className="size-3.5" />
            </button>
          )}
        </form>
        <Select value={order} onValueChange={(v) => setOrder(v as "asc" | "desc")}>
          <SelectTrigger size="sm" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="desc">Newest first</SelectItem>
            <SelectItem value="asc">Oldest first</SelectItem>
          </SelectContent>
        </Select>
        <Tooltip>
          <TooltipTrigger asChild>
            <label className="flex h-8 cursor-pointer items-center gap-2 rounded-md border px-2.5 text-xs">
              <Switch checked={live} onCheckedChange={setLive} className="scale-90" />
              Live
            </label>
          </TooltipTrigger>
          <TooltipContent>Refresh every 2 seconds</TooltipContent>
        </Tooltip>
        <Button variant="outline" size="sm" onClick={refresh} aria-label="Refresh">
          <RefreshCwIcon className={cn(loading && "animate-spin")} />
        </Button>
        {canCreate && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <PlusIcon /> {table === "_users" ? "New user" : "Add"}
          </Button>
        )}
      </div>

      {invalid && (
        <p className="text-xs text-destructive">
          Filter must look like <code className="font-mono">field = value</code>, e.g. <code className="font-mono">pinned = true</code> or{" "}
          <code className="font-mono">name = "general"</code>.
        </p>
      )}
      {error && <ErrorAlert error={error} />}

      <div className="overflow-hidden rounded-xl border bg-card">
        {loading && docs.length === 0 ? (
          <TableSkeleton cols={Math.min(columns.length + 2, 6)} />
        ) : docs.length === 0 ? (
          <EmptyState
            icon={<DatabaseIcon />}
            title={where ? "No matching documents" : "No documents yet"}
            description={where ? "Try another filter." : canCreate ? "Add one here or insert from a mutation." : undefined}
          />
        ) : (
          <Table className="text-[13px]">
            <TableHeader className="bg-muted/50">
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-9 w-32">_id</TableHead>
                {columns.map((c) => (
                  <TableHead key={c} className="h-9 max-w-64">
                    {c}
                  </TableHead>
                ))}
                <TableHead className="h-9 w-32">_creationTime</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {docs.map((d) => (
                <TableRow
                  key={d._id}
                  tabIndex={0}
                  data-state={selected?._id === d._id ? "selected" : undefined}
                  onClick={() => setSelected(d)}
                  onKeyDown={(e) => e.key === "Enter" && setSelected(d)}
                  className="cursor-pointer focus-visible:bg-accent focus-visible:outline-none"
                >
                  <TableCell className="py-2">
                    <IdText id={d._id} />
                  </TableCell>
                  {columns.map((c) => (
                    <TableCell key={c} className="max-w-64 py-2">
                      <ValueCell value={d[c]} />
                    </TableCell>
                  ))}
                  <TableCell className="py-2">
                    <TimeText ms={d._creationTime} now={now} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {docs.length > 0 && (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            Showing {docs.length.toLocaleString()}
            {!where && ` of ${total.toLocaleString()}`}
          </span>
          {!done && (
            <Button variant="outline" size="sm" onClick={() => void load("more", cursor)} disabled={loading}>
              {loading && <Loader2Icon className="animate-spin" />} Load more
            </Button>
          )}
        </div>
      )}

      <DocumentSheet
        app={app}
        table={table}
        doc={selected}
        onClose={() => setSelected(null)}
        onChanged={refresh}
      />
      <Sheet open={creating} onOpenChange={setCreating}>
        <SheetContent className="w-full gap-0 sm:max-w-xl">
          {creating &&
            (table === "_users" ? (
              <NewUserForm onCreated={refresh} />
            ) : (
              <NewDocumentForm table={table} info={info} onCreated={() => (setCreating(false), refresh())} />
            ))}
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Document details

interface StackEntry {
  table: string;
  doc: Doc | null;
  missing?: boolean;
}

function DocumentSheet({ app, table, doc, onClose, onChanged }: { app: AppInfo; table: string; doc: Doc | null; onClose: () => void; onChanged: () => void }) {
  const [stack, setStack] = useState<StackEntry[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<Error | null>(null);
  const confirm = useConfirm();

  // Opening a row: show it immediately, then fetch the latest version.
  useEffect(() => {
    setEditing(null);
    setSaveError(null);
    if (!doc) return setStack([]);
    setStack([{ table, doc }]);
    void admin<{ table: string; document: Doc } | null>("admin_get_document", { id: doc._id }).then(
      (fresh) => setStack((s) => (s.length === 1 && s[0]!.doc?._id === doc._id ? [{ table, doc: fresh?.document ?? null, missing: !fresh }] : s)),
      () => {},
    );
  }, [doc, table]);

  const top = stack.at(-1);
  const current = top?.doc ?? null;
  const info = top ? app.tables[top.table] : undefined;
  const editable = !!current && !!info && !info.system;

  const openRef = async (id: string) => {
    try {
      const target = await admin<{ table: string; document: Doc } | null>("admin_get_document", { id });
      if (!target) return toast.error("Referenced document not found", { description: id });
      setEditing(null);
      setStack((s) => [...s, { table: target.table, doc: target.document }]);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const editingValid = useMemo(() => {
    if (editing === null) return false;
    try {
      parseObject(editing);
      return true;
    } catch {
      return false;
    }
  }, [editing]);

  const save = async () => {
    if (!current || editing === null || !editingValid) return;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await admin<Doc>("admin_replace_document", { id: current._id, document: parseObject(editing) });
      setStack((s) => [...s.slice(0, -1), { table: top!.table, doc: saved }]);
      setEditing(null);
      toast.success("Document saved");
      onChanged();
    } catch (err) {
      setSaveError(err as Error);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!current) return;
    const ok = await confirm({
      title: "Delete this document?",
      description: (
        <>
          <span className="font-mono text-xs">{current._id}</span> will be permanently removed from <b>{top!.table}</b>. This cannot be undone.
        </>
      ),
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try {
      await admin("admin_delete_document", { id: current._id });
      toast.success("Document deleted");
      onChanged();
      if (stack.length > 1) setStack((s) => s.slice(0, -1));
      else onClose();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const properties = info?.documentSchema?.properties ?? {};

  return (
    <Sheet open={!!doc} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 sm:max-w-xl" onOpenAutoFocus={(e) => e.preventDefault()}>
        <SheetHeader className="border-b pr-12">
          <div className="flex items-center gap-2">
            {stack.length > 1 && (
              <Button variant="ghost" size="icon" className="-ml-2 size-7" onClick={() => (setEditing(null), setStack((s) => s.slice(0, -1)))} aria-label="Back">
                <ArrowLeftIcon />
              </Button>
            )}
            <Badge variant="secondary">{top?.table}</Badge>
            <SheetTitle className="min-w-0 truncate font-mono text-sm">{current?._id ?? doc?._id}</SheetTitle>
            {current && <CopyButton value={current._id} label="Copy id" />}
          </div>
          <SheetDescription>{current ? `Created ${formatDateTime(current._creationTime)}` : "Document"}</SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {top?.missing || (!current && top) ? (
            <EmptyState title="Document no longer exists" description="It was deleted after the list was loaded." />
          ) : editing !== null ? (
            <div className="space-y-3">
              <JsonEditor value={editing} onChange={setEditing} onSubmit={save} minRows={14} autoFocus />
              <p className="text-xs text-muted-foreground">Replaces all fields. Fields you remove are deleted; system fields are kept.</p>
              {saveError && <ErrorAlert error={saveError} />}
            </div>
          ) : current ? (
            <Tabs defaultValue="fields">
              <TabsList>
                <TabsTrigger value="fields">Fields</TabsTrigger>
                <TabsTrigger value="json">JSON</TabsTrigger>
              </TabsList>
              <TabsContent value="fields" className="mt-3">
                <dl className="divide-y rounded-lg border">
                  {Object.entries(current)
                    .filter(([k]) => k !== "_id" && k !== "_creationTime")
                    .map(([key, value]) => (
                      <div key={key} className="grid gap-1 px-3 py-2.5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-3">
                        <dt className="min-w-0">
                          <div className="truncate font-mono text-xs font-medium">{key}</div>
                          {properties[key] && <div className="truncate text-[11px] text-muted-foreground">{describeSchema(properties[key])}</div>}
                        </dt>
                        <dd className="min-w-0 text-sm">
                          <FieldValue value={value} refTo={refTable(properties[key])} onOpen={openRef} />
                        </dd>
                      </div>
                    ))}
                </dl>
                {top?.table === "_storage" && <StoragePreview doc={current} />}
              </TabsContent>
              <TabsContent value="json" className="mt-3">
                <JsonView value={current} />
              </TabsContent>
            </Tabs>
          ) : null}
        </div>

        {editable && (
          <SheetFooter className="flex-row justify-end border-t">
            {editing !== null ? (
              <>
                <Button variant="outline" onClick={() => setEditing(null)} disabled={saving}>
                  Cancel
                </Button>
                <Button onClick={save} disabled={saving || !editingValid}>
                  {saving && <Loader2Icon className="animate-spin" />} Save
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" className="text-destructive hover:text-destructive" onClick={remove}>
                  <Trash2Icon /> Delete
                </Button>
                <Button
                  onClick={() => {
                    const { _id, _creationTime, ...fields } = current!;
                    setSaveError(null);
                    setEditing(JSON.stringify(fields, null, 2));
                  }}
                >
                  <PencilIcon /> Edit
                </Button>
              </>
            )}
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}

function FieldValue({ value, refTo, onOpen }: { value: unknown; refTo?: string; onOpen: (id: string) => void }): ReactNode {
  if (typeof value === "string" && ID_PATTERN.test(value)) {
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        <button onClick={() => onOpen(value)} className="font-mono text-xs break-all text-query underline decoration-query/40 underline-offset-2 hover:decoration-query">
          {value}
        </button>
        {refTo && <Badge variant="outline" className="text-[10px]">{refTo}</Badge>}
      </span>
    );
  }
  if (typeof value === "object" && value !== null) return <JsonView value={value} className="max-h-72" />;
  if (typeof value === "string" && value !== "") return <span className="break-words whitespace-pre-wrap">{value}</span>;
  return <ValueCell value={value} />;
}

function StoragePreview({ doc }: { doc: Doc }) {
  const url = `/api/storage/${doc._id}`;
  const type = typeof doc.contentType === "string" ? doc.contentType : "";
  return (
    <div className="mt-4 space-y-3">
      {type.startsWith("image/") && <img src={url} alt="" className="max-h-72 rounded-lg border object-contain" />}
      <Button variant="outline" size="sm" asChild>
        <a href={url} target="_blank" rel="noreferrer">
          <ExternalLinkIcon /> Open file
        </a>
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create

function NewDocumentForm({ table, info, onCreated }: { table: string; info: TableInfo; onCreated: () => void }) {
  const [text, setText] = useState(() => JSON.stringify(sample(info.documentSchema) ?? {}, null, 2));
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  const valid = useMemo(() => {
    try {
      parseObject(text);
      return true;
    } catch {
      return false;
    }
  }, [text]);

  const create = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const { id } = await admin<{ id: string }>("admin_insert_document", { table, document: parseObject(text) });
      toast.success("Document created", { description: id });
      onCreated();
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SheetHeader className="border-b">
        <SheetTitle>New document</SheetTitle>
        <SheetDescription>
          Insert into <b>{table}</b>. Required fields are pre-filled; the document is validated against the schema.
        </SheetDescription>
      </SheetHeader>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        <JsonEditor value={text} onChange={setText} onSubmit={create} minRows={12} autoFocus />
        {error && <ErrorAlert error={error} />}
      </div>
      <SheetFooter className="flex-row justify-end border-t">
        <Button onClick={create} disabled={busy || !valid}>
          {busy && <Loader2Icon className="animate-spin" />} Create
        </Button>
      </SheetFooter>
    </>
  );
}

function NewUserForm({ onCreated }: { onCreated: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ token: string; user: Doc } | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await admin<{ token: string; user: Doc }>("admin_create_user", { email, password, ...(name.trim() ? { name: name.trim() } : {}) });
      setResult(r);
      toast.success("User created");
      onCreated();
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SheetHeader className="border-b">
        <SheetTitle>New user</SheetTitle>
        <SheetDescription>Creates an email/password account and a session token you can test with.</SheetDescription>
      </SheetHeader>
      {result ? (
        <div className="space-y-4 p-4 text-sm">
          <p>
            Created <b>{String(result.user.email)}</b> (<span className="font-mono text-xs">{result.user._id}</span>).
          </p>
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <Label>Session token</Label>
              <CopyButton value={result.token} label="Copy token" />
            </div>
            <pre className="overflow-x-auto rounded-md bg-muted/60 p-2.5 font-mono text-xs">{result.token}</pre>
            <p className="mt-1.5 text-xs text-muted-foreground">
              Send it as <code className="font-mono">Authorization: Bearer …</code> to call functions as this user.
            </p>
          </div>
        </div>
      ) : (
        <form onSubmit={create} className="flex min-h-0 flex-1 flex-col">
          <div className="space-y-4 p-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
              <p className="text-xs text-muted-foreground">At least 8 characters.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="name">
                Name <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            {error && <ErrorAlert error={error} />}
          </div>
          <SheetFooter className="mt-auto flex-row justify-end border-t">
            <Button type="submit" disabled={busy}>
              {busy && <Loader2Icon className="animate-spin" />} Create user
            </Button>
          </SheetFooter>
        </form>
      )}
    </>
  );
}
