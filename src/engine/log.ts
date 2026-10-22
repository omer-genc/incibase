// What the server prints. "text" is for people at a terminal; "json" writes
// one object per line on stdout for a supervisor (journald) to collect, and
// turns the app's own console output into lines of the same shape.
import { AsyncLocalStorage } from "node:async_hooks";
import { format as utilFormat, inspect as utilInspect } from "node:util";
import { ConfigError } from "./exit-codes.ts";

export type LogFormat = "text" | "json";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEvent {
  /** What happened, e.g. `"ready"` or `"call"`. */
  ev: string;
  msg?: string;
  /** An error to log with its message and stack. */
  err?: unknown;
  [field: string]: unknown;
}

/** Calls slower than this are logged in json mode. */
export const SLOW_CALL_MS = 1000;

// Captured before json mode wraps console, so log lines never come back as console events.
const write = console.log.bind(console);

let current: LogFormat = "text";

/** console.* arguments as one string, like console.log prints them. */
const formatArgs = (args: unknown[]) => utilFormat(...(args as [unknown, ...unknown[]]));

const counts = new Map<string, number>();
const timers = new Map<string, number>();
const consoleEvent = (level: LogLevel, msg: string, fields: Record<string, unknown> = {}) => emitLine(level, { ev: "console", msg, ...fields });
const elapsed = (label: string) => `${label}: ${(performance.now() - timers.get(label)!).toFixed(3)}ms`;

/**
 * What each console method does in json mode: one line, never raw text (which
 * a collector reading stdout as JSON lines would choke on). Group nesting is
 * dropped. process.stdout.write is not covered and still writes raw text.
 */
const JSON_CONSOLE: Record<string, (...args: any[]) => void> = {
  debug: (...args) => consoleEvent("debug", formatArgs(args)),
  log: (...args) => consoleEvent("info", formatArgs(args)),
  info: (...args) => consoleEvent("info", formatArgs(args)),
  warn: (...args) => consoleEvent("warn", formatArgs(args)),
  error: (...args) => consoleEvent("error", formatArgs(args)),
  table: (...args) => consoleEvent("info", formatArgs(args)),
  dir: (value, options) => consoleEvent("info", utilInspect(value, options)),
  dirxml: (...args) => consoleEvent("info", formatArgs(args)),
  trace: (...args) => {
    const msg = formatArgs(args);
    consoleEvent("debug", msg, { stack: `Trace${msg ? `: ${msg}` : ""}\n${new Error().stack?.split("\n").slice(2).join("\n")}` });
  },
  assert: (condition, ...args) => {
    if (!condition) consoleEvent("error", `Assertion failed${args.length ? `: ${formatArgs(args)}` : ""}`);
  },
  count: (label = "default") => {
    const n = (counts.get(String(label)) ?? 0) + 1;
    counts.set(String(label), n);
    consoleEvent("info", `${label}: ${n}`);
  },
  countReset: (label = "default") => void counts.delete(String(label)),
  time: (label = "default") => void timers.set(String(label), performance.now()),
  timeLog: (label = "default", ...args) => {
    if (timers.has(String(label))) consoleEvent("info", [elapsed(String(label)), ...(args.length ? [formatArgs(args)] : [])].join(" "));
  },
  timeEnd: (label = "default") => {
    if (!timers.has(String(label))) return;
    consoleEvent("info", elapsed(String(label)));
    timers.delete(String(label));
  },
  group: (...args) => void (args.length && consoleEvent("info", formatArgs(args))),
  groupCollapsed: (...args) => void (args.length && consoleEvent("info", formatArgs(args))),
  groupEnd: () => {},
};
const originalConsole = Object.fromEntries(Object.keys(JSON_CONSOLE).map((m) => [m, (console as any)[m]]));

/** `--log-format`, falling back to `INCIBASE_LOG_FORMAT`; ConfigError for anything else. */
export function parseLogFormat(value: string | undefined): LogFormat {
  const format = value ?? process.env.INCIBASE_LOG_FORMAT ?? "text";
  if (format === "text" || format === "pretty") return "text";
  if (format === "json") return "json";
  throw new ConfigError(`Invalid log format "${format}": use text or json`);
}

/** Switches the process's log format; json also routes console.* through the logger. */
export function setLogFormat(format: LogFormat) {
  current = format;
  for (const [method, json] of Object.entries(JSON_CONSOLE)) (console as any)[method] = format === "json" ? json : originalConsole[method];
}

export function logFormat(): LogFormat {
  return current;
}

export const isJson = () => current === "json";

// ---------------------------------------------------------------------------
// Request ids

const context = new AsyncLocalStorage<{ rid: string }>();

/** The id of the request, job or rerun this code runs for, if any. */
export function currentRid(): string | undefined {
  return context.getStore()?.rid;
}

/** Runs `fn` with `rid` as the request id of everything it logs. */
export function withRid<T>(rid: string, fn: () => T): T {
  return context.run({ rid }, fn);
}

export function newRid(): string {
  return crypto.randomUUID();
}

/** A client's `x-request-id`, if it is usable as one (printable ASCII, at most 128 characters); else a new id. */
export function ridFrom(header: string | null | undefined): string {
  const rid = header?.replace(/[^\x21-\x7e]/g, "").slice(0, 128);
  return rid || newRid();
}

// ---------------------------------------------------------------------------
// Output

/** `url` without its query string and fragment, which can carry tokens and signatures. */
export function stripQuery(url: string): string {
  return url.replace(/[?#].*$/s, "");
}

const noColor = () => !!process.env.NO_COLOR;
const paint = (code: string) => (text: string) => (noColor() ? text : `\x1b[${code}m${text}\x1b[0m`);

/** ANSI styles for text output; plain when `NO_COLOR` is set. */
export const color = { bold: paint("1"), dim: paint("2"), red: paint("31"), green: paint("32"), yellow: paint("33") };

/**
 * Logs one event. In json mode it is a line with the event's fields; in text
 * mode `text` (console arguments, as before json existed) is printed, and an
 * event without it prints nothing.
 */
export function logEvent(level: LogLevel, event: LogEvent, text?: unknown[]) {
  if (current === "json") return emitLine(level, event);
  if (!text) return;
  // Looked up on each call, not captured, so tests can still silence console.error.
  if (level === "error") console.error(...text);
  else if (level === "warn") console.warn(...text);
  else console.log(...text);
}

/** Errors already logged with their stack, so the layers they pass through do not log them again. */
const logged = new WeakSet<object>();

export function markLogged(err: unknown) {
  if (typeof err === "object" && err !== null) logged.add(err);
}

export function wasLogged(err: unknown): boolean {
  return typeof err === "object" && err !== null && logged.has(err);
}

function emitLine(level: LogLevel, { ev, msg, err, ...fields }: LogEvent) {
  const line: Record<string, unknown> = { t: new Date().toISOString(), level, ev };
  if (msg !== undefined) line.msg = msg;
  const rid = currentRid();
  if (rid !== undefined) line.rid = rid;
  Object.assign(line, fields);
  if (err !== undefined) {
    line.error = err instanceof Error ? err.message : formatArgs([err]);
    if (err instanceof Error && err.stack) line.stack = err.stack;
  }
  let json: string;
  try {
    json = JSON.stringify(line, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
  } catch {
    // A cyclic field: keep the line, lose the detail.
    json = JSON.stringify({ t: line.t, level, ev, msg: formatArgs([fields]) });
  }
  write(json);
}
