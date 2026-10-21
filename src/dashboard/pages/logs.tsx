import { useState } from "react";
import { ScrollTextIcon, SearchIcon } from "lucide-react";
import { EmptyState, ErrorAlert, PageHeader, StatusDot, TableSkeleton, TypeBadge } from "@/components/common";
import { IdText, TimeText } from "@/components/value";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { admin, type LogEntry } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { useAsync, useNow } from "@/lib/hooks";
import { cn } from "@/lib/utils";

const TYPES = ["all", "query", "mutation", "action", "http", "scheduled", "cron"] as const;

export function LogsPage() {
  const [path, setPath] = useState("");
  const [type, setType] = useState<(typeof TYPES)[number]>("all");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [live, setLive] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const now = useNow(5000);
  const logs = useAsync(
    () => admin<LogEntry[]>("admin_logs", { limit: 500, errorsOnly, ...(path.trim() ? { path: path.trim() } : {}), ...(type !== "all" ? { type } : {}) }),
    [path, type, errorsOnly],
    { pollMs: live ? 2000 : undefined },
  );

  return (
    <>
      <PageHeader title="Logs" description="Function calls since the server started (latest 1000 kept in memory)." />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="Filter by function" className="h-8 w-56 pl-8 text-sm" />
        </div>
        <Select value={type} onValueChange={(v) => setType(v as (typeof TYPES)[number])}>
          <SelectTrigger size="sm" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {t === "all" ? "All types" : t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex h-8 cursor-pointer items-center gap-2 rounded-md border px-2.5 text-xs">
          <Switch checked={errorsOnly} onCheckedChange={setErrorsOnly} className="scale-90" /> Errors only
        </label>
        <label className="flex h-8 cursor-pointer items-center gap-2 rounded-md border px-2.5 text-xs">
          <Switch checked={live} onCheckedChange={setLive} className="scale-90" /> Live
        </label>
        {logs.data && <span className="ml-auto text-xs text-muted-foreground">{logs.data.length} entries</span>}
      </div>
      {logs.error && <ErrorAlert error={logs.error} className="mb-3" />}
      <div className="overflow-hidden rounded-xl border bg-card">
        {!logs.data ? (
          <TableSkeleton cols={5} />
        ) : logs.data.length === 0 ? (
          <EmptyState
            icon={<ScrollTextIcon />}
            title={errorsOnly || path || type !== "all" ? "Nothing matches" : "No calls yet"}
            description="Calls from clients, the dashboard, schedules and HTTP routes appear here."
          />
        ) : (
          <Table className="text-[13px]">
            <TableHeader className="bg-muted/50">
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-9 w-8" />
                <TableHead className="h-9 w-28">Time</TableHead>
                <TableHead className="h-9 w-24">Type</TableHead>
                <TableHead className="h-9">Function</TableHead>
                <TableHead className="h-9 w-24 text-right">Duration</TableHead>
                <TableHead className="h-9 w-32">User</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.data.map((l, i) => {
                const key = `${l.time}-${l.path}-${i}`;
                const open = expanded === key;
                return (
                  <TableRow
                    key={key}
                    onClick={() => l.error && setExpanded(open ? null : key)}
                    className={cn(l.error && "cursor-pointer", !l.ok && "bg-destructive/[0.03]")}
                  >
                    <TableCell className="py-2">
                      <StatusDot ok={l.ok} />
                    </TableCell>
                    <TableCell className="py-2">
                      <TimeText ms={l.time} now={now} />
                    </TableCell>
                    <TableCell className="py-2">
                      <TypeBadge type={l.type} />
                    </TableCell>
                    <TableCell className="max-w-0 py-2">
                      <div className="truncate font-mono text-xs">{l.path}</div>
                      {l.error && (
                        <div className={cn("mt-0.5 text-xs text-destructive", open ? "break-words whitespace-pre-wrap" : "truncate")}>{l.error}</div>
                      )}
                    </TableCell>
                    <TableCell className={cn("py-2 text-right font-mono text-xs tabular-nums", l.durationMs > 200 ? "text-warning" : "text-muted-foreground")}>
                      {formatDuration(l.durationMs)}
                    </TableCell>
                    <TableCell className="py-2 text-muted-foreground">{l.userId ? <IdText id={l.userId} /> : <span className="text-xs">—</span>}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </>
  );
}
