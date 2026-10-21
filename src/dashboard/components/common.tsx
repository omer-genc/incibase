import { useState, type ReactNode } from "react";
import { AlertCircleIcon, CheckIcon, CopyIcon, InboxIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { FunctionType, LogType } from "@/lib/api";
import { cn } from "@/lib/utils";

export function PageHeader({ title, description, children }: { title: ReactNode; description?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

/** Bordered section with a compact header row; lighter than Card for dashboard panels. */
export function Panel({ title, action, children, className }: { title: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("overflow-hidden rounded-xl border bg-card shadow-xs", className)}>
      <div className="flex min-h-11 items-center justify-between gap-2 border-b px-4 py-2">
        <h3 className="text-sm font-medium">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export function EmptyState({ title, description, icon, children }: { title: string; description?: ReactNode; icon?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <div className="mb-1 rounded-full bg-muted p-3 text-muted-foreground [&_svg]:size-5">{icon ?? <InboxIcon />}</div>
      <p className="font-medium">{title}</p>
      {description && <p className="max-w-sm text-sm text-muted-foreground">{description}</p>}
      {children}
    </div>
  );
}

export function ErrorAlert({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className={cn("flex gap-2.5 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive", className)}>
      <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
      <pre className="min-w-0 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">{message}</pre>
    </div>
  );
}

export function CopyButton({ value, label = "Copy", className }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      toast.error("Clipboard not available");
    }
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className={cn("size-7 text-muted-foreground", className)} onClick={copy} aria-label={label}>
          {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : label}</TooltipContent>
    </Tooltip>
  );
}

const TYPE_STYLES: Record<LogType, string> = {
  query: "text-query bg-query/10",
  mutation: "text-mutation bg-mutation/10",
  action: "text-action bg-action/10",
  http: "text-muted-foreground bg-muted",
  cron: "text-muted-foreground bg-muted",
  scheduled: "text-muted-foreground bg-muted",
};

export function TypeBadge({ type, short }: { type: FunctionType | LogType; short?: boolean }) {
  return (
    <span
      className={cn("inline-flex h-5 shrink-0 items-center justify-center rounded px-1.5 font-mono text-[11px] font-semibold", short && "w-5 px-0", TYPE_STYLES[type])}
      title={type}
    >
      {short ? type[0]!.toUpperCase() : type}
    </span>
  );
}

export function StatusDot({ ok, className }: { ok: boolean; className?: string }) {
  return <span className={cn("inline-block size-2 shrink-0 rounded-full", ok ? "bg-success" : "bg-destructive", className)} />;
}

export function TableSkeleton({ rows = 6, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="divide-y">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-4 px-3 py-3">
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} className="h-4 flex-1" style={{ maxWidth: c === 0 ? 120 : undefined }} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{children}</kbd>;
}

export const MOD_KEY = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
