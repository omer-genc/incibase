import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { WandSparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

/** Pretty-printed, syntax-coloured JSON. */
export function JsonView({ value, className }: { value: unknown; className?: string }) {
  const nodes = useMemo(() => {
    const text = JSON.stringify(value, null, 2) ?? "undefined";
    const out: ReactNode[] = [];
    let last = 0;
    for (const m of text.matchAll(TOKEN)) {
      if (m.index! > last) out.push(text.slice(last, m.index));
      if (m[1] && m[2]) out.push(<span key={m.index} className="text-json-key">{m[1]}</span>, m[2]);
      else if (m[1]) out.push(<span key={m.index} className="text-json-string">{m[1]}</span>);
      else if (m[3]) out.push(<span key={m.index} className="text-mutation">{m[3]}</span>);
      else out.push(<span key={m.index} className="text-json-number">{m[4]}</span>);
      last = m.index! + m[0].length;
    }
    out.push(text.slice(last));
    return out;
  }, [value]);
  return (
    <pre className={cn("overflow-auto rounded-md bg-muted/60 p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap", className)}>
      {nodes}
    </pre>
  );
}

export function parseObject(text: string): Record<string, unknown> {
  const value = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected a JSON object { … }");
  return value;
}

/** Textarea for a JSON object with live validation, Format, Tab indent and ⌘/Ctrl+Enter submit. */
export function JsonEditor({
  value,
  onChange,
  onSubmit,
  minRows = 8,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  minRows?: number;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!value.trim()) return setError(null);
    try {
      parseObject(value);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [value]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (!error) onSubmit?.();
    } else if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart: start, selectionEnd: end } = el;
      onChange(`${value.slice(0, start)}  ${value.slice(end)}`);
      requestAnimationFrame(() => el.setSelectionRange(start + 2, start + 2));
    }
  };

  const format = () => {
    try {
      onChange(JSON.stringify(parseObject(value), null, 2));
    } catch {}
  };

  const rows = Math.max(minRows, Math.min(28, value.split("\n").length + 1));

  return (
    <div className="space-y-1.5">
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        rows={rows}
        spellCheck={false}
        autoFocus={autoFocus}
        aria-invalid={!!error}
        className={cn(
          "block w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs leading-relaxed shadow-xs outline-none",
          "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30",
          "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        )}
      />
      <div className="flex items-start justify-between gap-3">
        <p className={cn("min-w-0 font-mono text-xs", error ? "text-destructive" : "text-muted-foreground")}>{error ?? "Valid JSON"}</p>
        <Button type="button" variant="ghost" size="sm" onClick={format} disabled={!!error} className="h-6 shrink-0 px-2 text-xs text-muted-foreground">
          <WandSparklesIcon /> Format
        </Button>
      </div>
    </div>
  );
}
