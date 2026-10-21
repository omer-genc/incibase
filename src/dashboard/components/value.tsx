import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ID_PATTERN } from "@/lib/api";
import { compactJson, formatDateTime, formatRelative, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";

/** One-line rendering of a field value for tables. */
export function ValueCell({ value, now }: { value: unknown; now?: number }) {
  if (value === undefined) return <span className="text-muted-foreground/60">—</span>;
  if (value === null) return <span className="font-mono text-xs text-muted-foreground italic">null</span>;
  if (typeof value === "boolean") {
    return <span className={cn("font-mono text-xs", value ? "text-success" : "text-muted-foreground")}>{String(value)}</span>;
  }
  if (typeof value === "number") return <span className="font-mono text-xs tabular-nums">{value.toLocaleString()}</span>;
  if (typeof value === "string") {
    if (ID_PATTERN.test(value)) return <IdText id={value} />;
    if (value === "") return <span className="text-xs text-muted-foreground italic">empty</span>;
    return (
      <span className="block truncate" title={value.length > 40 ? value : undefined}>
        {value}
      </span>
    );
  }
  return (
    <span className="block truncate font-mono text-xs text-muted-foreground" title={JSON.stringify(value, null, 2)}>
      {compactJson(value, 60)}
    </span>
  );
}

export function IdText({ id, full }: { id: string; full?: boolean }) {
  if (full) return <span className="font-mono text-xs break-all">{id}</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-default font-mono text-xs">{shortId(id)}</span>
      </TooltipTrigger>
      <TooltipContent className="font-mono">{id}</TooltipContent>
    </Tooltip>
  );
}

export function TimeText({ ms, now }: { ms: number; now?: number }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-default whitespace-nowrap text-muted-foreground">{formatRelative(ms, now)}</span>
      </TooltipTrigger>
      <TooltipContent>{formatDateTime(ms)}</TooltipContent>
    </Tooltip>
  );
}
