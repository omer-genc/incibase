import type { ReactNode } from "react";
import { ActivityIcon, AlertTriangleIcon, ChevronRightIcon, ClockIcon, FunctionSquareIcon, RadioIcon } from "lucide-react";
import { CopyButton, EmptyState, ErrorAlert, PageHeader, Panel, StatusDot, TypeBadge } from "@/components/common";
import { TimeText } from "@/components/value";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { admin, getAdminKey, type LogEntry, type Overview as OverviewData } from "@/lib/api";
import { mcpCommand } from "@/lib/branch";
import { formatSpan, plural } from "@/lib/format";
import { useAsync, useNow } from "@/lib/hooks";

export function Overview({ navigate }: { navigate: (path: string) => void }) {
  const overview = useAsync(() => admin<OverviewData>("admin_overview"), [], { pollMs: 5000 });
  const errors = useAsync(() => admin<LogEntry[]>("admin_logs", { limit: 5, errorsOnly: true }), [], { pollMs: 5000 });
  const now = useNow(5000);
  const data = overview.data;

  if (!data) {
    return (
      <>
        <PageHeader title="Overview" />
        {overview.error ? (
          <ErrorAlert error={overview.error} />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-28" />
            ))}
          </div>
        )}
      </>
    );
  }

  const userTables = Object.entries(data.tables).filter(([, t]) => !t.system);
  const systemTables = Object.entries(data.tables).filter(([, t]) => t.system);
  const totalFunctions = data.functions.query + data.functions.mutation + data.functions.action;
  const mcp = mcpCommand(location.origin, getAdminKey());

  return (
    <>
      <PageHeader
        title="Overview"
        description={
          <>
            incibase v{data.version} · started <TimeText ms={data.startedAt} now={now} />
          </>
        }
      >
        {data.branch?.label && <Badge variant={data.branch.kind === "prod" ? "destructive" : "outline"}>{data.branch.label}</Badge>}
        {data.dev && <Badge variant="secondary">dev</Badge>}
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat icon={<ClockIcon />} label="Uptime" value={formatSpan(now - data.startedAt)} />
        <Stat
          icon={<FunctionSquareIcon />}
          label="Functions"
          value={totalFunctions}
          hint={[plural(data.functions.query, "query", "queries"), plural(data.functions.mutation, "mutation"), plural(data.functions.action, "action")].join(" · ")}
          onClick={() => navigate("functions")}
        />
        <Stat icon={<RadioIcon />} label="Live subscriptions" value={data.subscriptions} hint="Shared realtime queries" />
        <Stat
          icon={<AlertTriangleIcon />}
          label="Recent errors"
          value={data.recentErrors}
          hint={`of the last ${plural(data.recentCalls, "call")}`}
          tone={data.recentErrors > 0 ? "error" : undefined}
          onClick={() => navigate("logs")}
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel title="Tables">
          <div>
            {userTables.length === 0 && (
              <p className="px-4 py-3 text-sm text-muted-foreground">No tables yet. Define them in schema.ts.</p>
            )}
            {[...userTables, ...systemTables].map(([name, t]) => (
              <button
                key={name}
                onClick={() => navigate(`data/${name}`)}
                className="flex w-full items-center gap-2 border-b px-4 py-2.5 text-left text-sm last:border-0 hover:bg-accent/60"
              >
                <span className={t.system ? "text-muted-foreground" : "font-medium"}>{name}</span>
                {t.system && <Badge variant="outline" className="text-[10px]">system</Badge>}
                <span className="ml-auto font-mono text-xs text-muted-foreground tabular-nums">{t.documentCount.toLocaleString()}</span>
                <ChevronRightIcon className="size-4 text-muted-foreground/60" />
              </button>
            ))}
          </div>
        </Panel>

        <Panel
          title="Recent errors"
          action={
            <button onClick={() => navigate("logs")} className="text-xs text-muted-foreground hover:text-foreground">
              All logs →
            </button>
          }
        >
          <div>
            {errors.data?.length ? (
              errors.data.map((e, i) => (
                <div key={`${e.time}-${i}`} className="flex items-start gap-3 border-b px-4 py-2.5 text-sm last:border-0">
                  <TypeBadge type={e.type} short />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-xs">{e.path}</div>
                    <div className="truncate text-xs text-destructive" title={e.error}>
                      {e.error}
                    </div>
                  </div>
                  <span className="text-xs">
                    <TimeText ms={e.time} now={now} />
                  </span>
                </div>
              ))
            ) : (
              <EmptyState icon={<ActivityIcon />} title="No errors" description="Function errors since the server started show up here." />
            )}
          </div>
        </Panel>

        <Panel title="Endpoints">
          <div className="space-y-0.5 px-4 py-3">
            <Endpoint label="HTTP API" value={`${data.publicUrl}/api`} />
            <Endpoint label="Realtime" value={`${data.publicUrl.replace(/^http/, "ws")}/api/ws`} />
            <Endpoint
              label="MCP"
              value={`${data.publicUrl}/mcp`}
              hint={`${plural(data.functions.mcpTools, "app tool")}${data.surface === "admin" ? "; admin tools through this tunnel (below)" : " + admin tools"}`}
            />
            <div className="pt-3">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Add to Claude Code</span>
                <CopyButton value={mcp} label="Copy command (includes admin key)" />
              </div>
              <pre className="overflow-x-auto rounded-md bg-muted/60 p-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {mcp.replace(/Bearer [^"]+/, "Bearer ik_admin_••••••")}
              </pre>
            </div>
          </div>
        </Panel>

        <Panel title="Schedules & routes">
          <div className="space-y-4 px-4 py-3 text-sm">
            <div>
              <div className="mb-1.5 text-xs font-medium text-muted-foreground">Cron jobs</div>
              {data.crons.length === 0 ? (
                <p className="text-muted-foreground">None. Add them in crons.ts.</p>
              ) : (
                data.crons.map((c) => (
                  <div key={c.name} className="flex flex-wrap items-center gap-x-2 py-1">
                    <StatusDot ok />
                    <span className="font-medium">{c.name}</span>
                    <Badge variant="secondary" className="font-mono text-[11px]">
                      {c.schedule.kind === "interval" ? `every ${formatSpan(c.schedule.ms)}` : c.schedule.expression}
                    </Badge>
                    <span className="font-mono text-xs text-muted-foreground">→ {c.path}</span>
                  </div>
                ))
              )}
            </div>
            <div>
              <div className="mb-1.5 text-xs font-medium text-muted-foreground">HTTP routes</div>
              {data.httpRoutes.length === 0 ? (
                <p className="text-muted-foreground">None. Add them in http.ts.</p>
              ) : (
                data.httpRoutes.map((r) => (
                  <div key={`${r.method} ${r.path}`} className="flex items-center gap-2 py-1">
                    <Badge variant="outline" className="w-14 justify-center font-mono text-[11px]">
                      {r.method}
                    </Badge>
                    <span className="font-mono text-xs">{r.path}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </Panel>
      </div>
      <p className="mt-6 text-center text-xs text-muted-foreground">Refreshes every 5 seconds</p>
    </>
  );
}

function Stat({
  icon,
  label,
  value,
  hint,
  tone,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: "error";
  onClick?: () => void;
}) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      onClick={onClick}
      className="flex flex-col gap-1 rounded-xl border bg-card p-4 text-left shadow-xs transition-colors enabled:hover:bg-accent/50 [button&]:cursor-pointer"
    >
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground [&_svg]:size-3.5">
        {icon}
        {label}
      </div>
      <div className={tone === "error" ? "text-2xl font-semibold tabular-nums text-destructive" : "text-2xl font-semibold tabular-nums"}>{value}</div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </Comp>
  );
}

function Endpoint({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-center gap-3 py-1">
      <span className="w-20 shrink-0 text-xs text-muted-foreground">{label}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-xs" title={value}>
          {value}
        </div>
        {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
      </div>
      <CopyButton value={value} />
    </div>
  );
}
