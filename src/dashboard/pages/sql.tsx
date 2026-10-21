import { useState } from "react";
import { ChevronDownIcon, Loader2Icon, PlayIcon, TableIcon } from "lucide-react";
import { EmptyState, ErrorAlert, Kbd, MOD_KEY, PageHeader } from "@/components/common";
import { ValueCell } from "@/components/value";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { admin, type AppInfo } from "@/lib/api";
import { formatDuration, plural } from "@/lib/format";
import { useStoredState } from "@/lib/hooks";

export function SqlPage({ app }: { app: AppInfo }) {
  const firstTable = Object.keys(app.tables).find((t) => !app.tables[t]!.system) ?? "_users";
  const [query, setQuery] = useStoredState("incibase:sql", `SELECT _id, data FROM "${firstTable}" ORDER BY _creationTime DESC LIMIT 20`);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ rows: Record<string, unknown>[]; truncated: boolean; ms: number } | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const examples = [
    { label: "Latest documents", sql: `SELECT _id, _creationTime, data FROM "${firstTable}" ORDER BY _creationTime DESC LIMIT 20` },
    { label: "Read a JSON field", sql: `SELECT _id, json_extract(data, '$.${Object.keys(app.tables[firstTable]?.documentSchema?.properties ?? { field: 1 })[0]}') AS value FROM "${firstTable}" LIMIT 20` },
    { label: "Documents per table", sql: Object.keys(app.tables).map((t) => `SELECT '${t}' AS "table", COUNT(*) AS documents FROM "${t}"`).join("\nUNION ALL ") },
    { label: "Indexes", sql: `SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL` },
    { label: "Users", sql: `SELECT _id, json_extract(data, '$.email') AS email, datetime(_creationTime / 1000, 'unixepoch') AS created FROM _users` },
  ];

  const run = async () => {
    if (!query.trim()) return;
    setRunning(true);
    setError(null);
    const started = performance.now();
    try {
      const r = await admin<{ rows: Record<string, unknown>[]; truncated: boolean }>("admin_sql", { query });
      setResult({ ...r, ms: performance.now() - started });
    } catch (err) {
      setError(err as Error);
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  const columns = result?.rows.length ? Object.keys(result.rows[0]!) : [];

  return (
    <>
      <PageHeader title="SQL" description="Read-only queries against the SQLite database. Documents keep their fields as JSON in the data column." />
      <Card className="mb-4 gap-0 py-0">
        <CardContent className="space-y-3 p-3">
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void run();
              }
            }}
            rows={Math.max(4, Math.min(16, query.split("\n").length + 1))}
            spellCheck={false}
            className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs leading-relaxed outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={run} disabled={running || !query.trim()}>
              {running ? <Loader2Icon className="animate-spin" /> : <PlayIcon />} Run
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">
                  Examples <ChevronDownIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel>Insert an example</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {examples.map((ex) => (
                  <DropdownMenuItem key={ex.label} onSelect={() => setQuery(ex.sql)}>
                    {ex.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <span className="text-xs text-muted-foreground">
              <Kbd>{MOD_KEY}</Kbd> <Kbd>Enter</Kbd> to run · <code className="font-mono">json_extract(data, '$.field')</code> reads a field
            </span>
          </div>
        </CardContent>
      </Card>

      {error && <ErrorAlert error={error} />}
      {result && (
        <>
          <p className="mb-2 text-xs text-muted-foreground">
            {plural(result.rows.length, "row")}
            {result.truncated && " (first 1000 shown)"} · {formatDuration(result.ms)}
          </p>
          <div className="overflow-hidden rounded-xl border bg-card">
            {result.rows.length === 0 ? (
              <EmptyState icon={<TableIcon />} title="No rows" />
            ) : (
              <Table className="text-[13px]">
                <TableHeader className="bg-muted/50">
                  <TableRow className="hover:bg-transparent">
                    {columns.map((c) => (
                      <TableHead key={c} className="h-9 font-mono text-xs">
                        {c}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.rows.map((row, i) => (
                    <TableRow key={i}>
                      {columns.map((c) => (
                        <TableCell key={c} className="max-w-80 py-2">
                          <ValueCell value={row[c]} />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </>
      )}
    </>
  );
}
