import { useState } from "react";
import { BracesIcon, KeyRoundIcon } from "lucide-react";
import { PageHeader } from "@/components/common";
import { JsonView } from "@/components/json";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AppInfo, TableInfo } from "@/lib/api";
import { plural } from "@/lib/format";
import { constraints, describeSchema, refTable } from "@/lib/schema";

export function SchemaPage({ app }: { app: AppInfo }) {
  const [jsonFor, setJsonFor] = useState<string | null>(null);
  const entries = Object.entries(app.tables);
  const user = entries.filter(([, t]) => !t.system);
  const system = entries.filter(([, t]) => t.system);

  return (
    <>
      <PageHeader title="Schema" description="Tables from schema.ts with their fields and indexes. Every table also has _id and _creationTime." />
      <div className="space-y-4">
        {user.map(([name, t]) => (
          <TableCard key={name} name={name} info={t} onJson={() => setJsonFor(name)} />
        ))}
        {user.length === 0 && <p className="text-sm text-muted-foreground">No tables yet. Define them in incibase/schema.ts.</p>}
        <h2 className="pt-4 text-sm font-medium text-muted-foreground">System tables</h2>
        <div className="grid gap-4 lg:grid-cols-3">
          {system.map(([name, t]) => (
            <Card key={name} className="gap-2">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  {name}
                  <span className="font-normal text-muted-foreground">{plural(t.documentCount ?? 0, "doc")}</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-1.5">
                {t.indexes.map((i) => (
                  <IndexBadge key={i.name} index={i} />
                ))}
                {t.indexes.length === 0 && <span className="text-xs text-muted-foreground">by_creation_time only</span>}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
      <Dialog open={!!jsonFor} onOpenChange={(open) => !open && setJsonFor(null)}>
        <DialogContent className="max-h-[85vh] overflow-hidden sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{jsonFor} · JSON Schema</DialogTitle>
            <DialogDescription>Generated from the Zod validator.</DialogDescription>
          </DialogHeader>
          {jsonFor && <JsonView value={app.tables[jsonFor]?.documentSchema} className="max-h-[60vh]" />}
        </DialogContent>
      </Dialog>
    </>
  );
}

function IndexBadge({ index }: { index: TableInfo["indexes"][number] }) {
  return (
    <Badge variant="secondary" className="font-mono text-[11px] font-normal">
      {index.unique && <KeyRoundIcon />}
      {index.name}({index.fields.join(", ")})
    </Badge>
  );
}

function TableCard({ name, info, onJson }: { name: string; info: TableInfo; onJson: () => void }) {
  const properties = Object.entries(info.documentSchema?.properties ?? {});
  return (
    <Card className="gap-3">
      <CardHeader className="flex flex-row flex-wrap items-center gap-2">
        <CardTitle className="text-base">
          <a href={`#/data/${name}`} className="hover:underline">
            {name}
          </a>
        </CardTitle>
        <span className="text-sm text-muted-foreground">{plural(info.documentCount ?? 0, "document")}</span>
        <Button variant="ghost" size="sm" className="ml-auto h-7 text-xs" onClick={onJson}>
          <BracesIcon /> JSON Schema
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="overflow-hidden rounded-lg border">
          <Table className="text-[13px]">
            <TableHeader className="bg-muted/50">
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-8 w-48">Field</TableHead>
                <TableHead className="h-8">Type</TableHead>
                <TableHead className="h-8">Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {properties.map(([field, schema]) => {
                const required = info.documentSchema?.required?.includes(field);
                const ref = refTable(schema);
                return (
                  <TableRow key={field} className="hover:bg-transparent">
                    <TableCell className="py-2 font-mono text-xs">
                      {field}
                      {!required && <span className="text-muted-foreground">?</span>}
                    </TableCell>
                    <TableCell className="py-2 font-mono text-xs whitespace-normal text-muted-foreground">
                      {ref ? (
                        <a href={`#/data/${ref}`} className="text-primary hover:underline">
                          {describeSchema(schema)}
                        </a>
                      ) : (
                        describeSchema(schema)
                      )}
                    </TableCell>
                    <TableCell className="py-2 text-xs whitespace-normal text-muted-foreground">
                      {[required ? "required" : "optional", ...constraints(schema)].join(" · ")}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-muted-foreground">Indexes</span>
          <Badge variant="outline" className="font-mono text-[11px] font-normal">
            by_creation_time
          </Badge>
          {info.indexes.map((i) => (
            <IndexBadge key={i.name} index={i} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
