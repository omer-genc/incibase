import { useEffect, useMemo, useState } from "react";
import { FunctionSquareIcon, Loader2Icon, LockIcon, PlayIcon, SearchIcon, SparklesIcon } from "lucide-react";
import { CopyButton, EmptyState, ErrorAlert, Kbd, MOD_KEY, PageHeader, TypeBadge } from "@/components/common";
import { JsonEditor, JsonView, parseObject } from "@/components/json";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { admin, type AppInfo, type Doc, type FunctionInfo, type Page } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { useAsync } from "@/lib/hooks";
import { constraints, describeSchema, sample } from "@/lib/schema";
import { cn } from "@/lib/utils";

export function FunctionsPage({ app, path, navigate }: { app: AppInfo; path?: string; navigate: (path: string, options?: { replace?: boolean }) => void }) {
  const [search, setSearch] = useState("");
  const modules = useMemo(() => {
    const q = search.trim().toLowerCase();
    const groups = new Map<string, FunctionInfo[]>();
    for (const f of [...app.functions].sort((a, b) => a.path.localeCompare(b.path))) {
      if (q && !f.path.toLowerCase().includes(q) && !f.description?.toLowerCase().includes(q)) continue;
      const mod = f.path.split(":")[0]!;
      groups.set(mod, [...(groups.get(mod) ?? []), f]);
    }
    return [...groups.entries()];
  }, [app, search]);

  const current = app.functions.find((f) => f.path === path) ?? modules[0]?.[1][0];

  useEffect(() => {
    if (current && current.path !== path) navigate(`functions/${current.path}`, { replace: true });
  }, [current, path, navigate]);

  if (app.functions.length === 0) {
    return (
      <>
        <PageHeader title="Functions" />
        <div className="rounded-xl border bg-card">
          <EmptyState
            icon={<FunctionSquareIcon />}
            title="No functions yet"
            description="Export a query, mutation or action from a file in your incibase/ folder."
          />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Functions" description="Inspect arguments and run any function, including internal ones." />
      <div className="grid items-start gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <div className="lg:hidden">
          <Select value={current?.path} onValueChange={(v) => navigate(`functions/${v}`)}>
            <SelectTrigger className="w-full font-mono text-sm">
              <SelectValue placeholder="Choose a function" />
            </SelectTrigger>
            <SelectContent>
              {modules.map(([mod, fns]) => (
                <SelectGroup key={mod}>
                  <SelectLabel className="font-mono">{mod}</SelectLabel>
                  {fns.map((f) => (
                    <SelectItem key={f.path} value={f.path} className="font-mono">
                      <TypeBadge type={f.type} short /> {f.path.split(":")[1]}
                      {f.visibility === "internal" && <LockIcon className="size-3 text-muted-foreground" />}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="hidden space-y-2 lg:sticky lg:top-0 lg:block">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search functions" className="h-8 pl-8 text-sm" />
          </div>
          <nav className="max-h-[calc(100vh-12rem)] overflow-y-auto rounded-xl border bg-card p-1.5">
            {modules.length === 0 && <p className="px-2 py-3 text-center text-xs text-muted-foreground">No matches</p>}
            {modules.map(([mod, fns]) => (
              <div key={mod} className="mb-1">
                <div className="truncate px-2 pt-2 pb-1 font-mono text-[11px] text-muted-foreground">{mod}</div>
                {fns.map((f) => (
                  <a
                    key={f.path}
                    href={`#/functions/${encodeURIComponent(f.path)}`}
                    aria-current={f.path === current?.path ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent",
                      f.path === current?.path && "bg-accent font-medium",
                    )}
                  >
                    <TypeBadge type={f.type} short />
                    <span className="min-w-0 flex-1 truncate">{f.path.split(":")[1]}</span>
                    {f.visibility === "internal" && <LockIcon className="size-3 text-muted-foreground" aria-label="internal" />}
                  </a>
                ))}
              </div>
            ))}
          </nav>
        </div>
        {current && <FunctionDetail key={current.path} fn={current} />}
      </div>
    </>
  );
}

function FunctionDetail({ fn }: { fn: FunctionInfo }) {
  const storageKey = `incibase:args:${fn.path}`;
  const [text, setText] = useState(() => {
    try {
      return sessionStorage.getItem(storageKey) ?? JSON.stringify(sample(fn.args) ?? {}, null, 2);
    } catch {
      return JSON.stringify(sample(fn.args) ?? {}, null, 2);
    }
  });
  const [asUser, setAsUser] = useState("__admin__");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; value?: unknown; error?: string; ms: number; at: number } | null>(null);
  const users = useAsync(() => admin<Page<Doc>>("admin_list_documents", { table: "_users", order: "asc", limit: 100 }), []);

  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, text);
    } catch {}
  }, [storageKey, text]);

  const args = Object.entries(fn.args.properties ?? {});
  const valid = useMemo(() => {
    try {
      parseObject(text);
      return true;
    } catch {
      return false;
    }
  }, [text]);

  const run = async () => {
    let parsed: Record<string, unknown>;
    try {
      parsed = parseObject(text);
    } catch (err) {
      return setResult({ ok: false, error: (err as Error).message, ms: 0, at: Date.now() });
    }
    setRunning(true);
    const started = performance.now();
    try {
      const value = await admin("admin_run_function", { path: fn.path, args: parsed, ...(asUser !== "__admin__" ? { asUser } : {}) });
      setResult({ ok: true, value, ms: performance.now() - started, at: Date.now() });
    } catch (err) {
      setResult({ ok: false, error: (err as Error).message, ms: performance.now() - started, at: Date.now() });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="min-w-0 space-y-4">
      <Card className="gap-3">
        <CardHeader className="gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <TypeBadge type={fn.type} />
            <CardTitle className="min-w-0 truncate font-mono text-base">{fn.path}</CardTitle>
            <CopyButton value={fn.path} label="Copy path" />
            <div className="ml-auto flex flex-wrap gap-1.5">
              {fn.visibility === "internal" ? (
                <Badge variant="outline">
                  <LockIcon /> internal
                </Badge>
              ) : (
                <Badge variant="outline">public</Badge>
              )}
              {fn.mcpTool && (
                <Badge variant="secondary">
                  <SparklesIcon /> MCP · {fn.mcpTool}
                </Badge>
              )}
            </div>
          </div>
          {fn.description && <p className="text-sm text-muted-foreground">{fn.description}</p>}
        </CardHeader>
        <CardContent>
          {args.length === 0 ? (
            <p className="text-sm text-muted-foreground">Takes no arguments.</p>
          ) : (
            <div className="overflow-hidden rounded-lg border">
              <Table className="text-[13px]">
                <TableHeader className="bg-muted/50">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="h-8">Argument</TableHead>
                    <TableHead className="h-8">Type</TableHead>
                    <TableHead className="h-8">Notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {args.map(([name, schema]) => {
                    const required = fn.args.required?.includes(name);
                    return (
                      <TableRow key={name} className="hover:bg-transparent">
                        <TableCell className="py-2 font-mono text-xs">
                          {name}
                          {!required && <span className="text-muted-foreground">?</span>}
                        </TableCell>
                        <TableCell className="py-2 font-mono text-xs whitespace-normal text-muted-foreground">{describeSchema(schema)}</TableCell>
                        <TableCell className="py-2 text-xs whitespace-normal text-muted-foreground">
                          {[required ? "required" : "optional", ...constraints(schema)].join(" · ")}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
          {fn.returns && (
            <p className="mt-3 text-xs text-muted-foreground">
              Returns <code className="font-mono">{describeSchema(fn.returns)}</code>
            </p>
          )}
        </CardContent>
      </Card>

      <Card className="gap-3">
        <CardHeader>
          <CardTitle className="text-sm">Run</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <JsonEditor value={text} onChange={setText} onSubmit={run} minRows={5} />
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-56 flex-1 space-y-1.5 sm:max-w-80">
              <Label className="text-xs text-muted-foreground">Run as</Label>
              <Select value={asUser} onValueChange={setAsUser}>
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__admin__">Admin (no user)</SelectItem>
                  {users.data?.page.map((u) => (
                    <SelectItem key={u._id} value={u._id}>
                      {String(u.email)}
                      {u.name ? ` · ${String(u.name)}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={run} disabled={running || !valid} className="ml-auto">
              {running ? <Loader2Icon className="animate-spin" /> : <PlayIcon />}
              Run {fn.type}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            <Kbd>{MOD_KEY}</Kbd> <Kbd>Enter</Kbd> to run. Arguments are kept for this tab.
          </p>
        </CardContent>
      </Card>

      {result && (
        <Card className="gap-3">
          <CardHeader className="flex flex-row items-center gap-2">
            <CardTitle className="text-sm">Result</CardTitle>
            <Badge variant={result.ok ? "secondary" : "destructive"} className={result.ok ? "text-success" : undefined}>
              {result.ok ? "success" : "error"}
            </Badge>
            {result.ms > 0 && <span className="text-xs text-muted-foreground">{formatDuration(result.ms)}</span>}
            {result.ok && <CopyButton value={JSON.stringify(result.value, null, 2)} label="Copy result" className="ml-auto" />}
          </CardHeader>
          <CardContent>{result.ok ? <JsonView value={result.value} className="max-h-[32rem]" /> : <ErrorAlert error={result.error} />}</CardContent>
        </Card>
      )}
    </div>
  );
}
