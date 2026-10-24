// The owner's commands on the server (design section 7): `incibase host …`,
// `project`, `branch`, `release`, `env`, `admin-key <p>/<b>`,
// `service-key`, `status` and `logs`, each a thin layer over one or two ops
// in ops.ts. Every command takes --root and --json (the op's result as JSON
// on stdout), prints one-line errors and exits 0 (done), 1 (failed or
// refused) or 2 (usage: an unknown flag, a bad name or value). They run as
// root; `incibase tunnel` (tunnel.ts), on the owner's laptop, does not.
//
// Everything the commands touch outside the ops comes through CommandIO,
// so tests run them in-process against a fake host.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseDrainTimeout } from "../engine/drain.ts";
import { parseTimeouts } from "../engine/timeouts.ts";
import { VERSION } from "../engine/version.ts";
import { MiB, parseSize, resolveLimits, type BranchConfig, type BranchLimits } from "./config.ts";
import { openHost, type OpsContext } from "./context.ts";
import { ALERT_WEBHOOK } from "./alerts.ts";
import { formatDoctor } from "./doctor.ts";
import { printable } from "./driver.ts";
import { DEFAULT_ROOT, HostLayout, type LayoutOptions } from "./layout.ts";
import { BRANCH_KINDS, branchRef, checkProjectSlug, NameError, parseBranchRef } from "./names.ts";
import { TRUST_PROXY } from "./nginx.ts";
import * as ops from "./ops.ts";
import { OpError } from "./ops.ts";
import type { AlertRow, BranchRow, ReleaseRow } from "./registry.ts";
import { MAX_BUNDLE_BYTES, type GateResult } from "./release.ts";
import { cliLinkRuntime, trustedRuntimes } from "./render.ts";

/** A command line that cannot mean anything: exit 2 with the command's usage. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export const EXIT = { OK: 0, FAILED: 1, USAGE: 2 } as const;

export interface OpenedHost {
  ctx: OpsContext;
  close(): void;
}

export interface CommandIO {
  out(line: string): void;
  err(line: string): void;
  /** All of stdin, for `release add … -` and `env import … -`; throws past `maxBytes`. */
  readStdin(maxBytes: number): Promise<Uint8Array>;
  isRoot(): boolean;
  /** The host at `root`; only `host init` (`create`) may open one that is not set up yet. */
  open(options: { root: string; layout?: Omit<LayoutOptions, "root">; create?: boolean }): OpenedHost;
  /**
   * Runs a command (journalctl for `logs`): each line of its stdout goes to
   * `line` as it comes, raw; its exit code and stderr come back.
   */
  exec(argv: string[], line: (text: string) => void): Promise<{ code: number; stderr: string }>;
  env: Record<string, string | undefined>;
}

/** The longest line `exec` hands on; a longer one is split. */
const MAX_LINE = 64 * 1024;
const MAX_STDERR = 64 * 1024;

/** The real machine: stdout/stderr, openHost and a child whose output is read here. */
export const processIO: CommandIO = {
  out: (line) => void process.stdout.write(`${line}\n`),
  err: (line) => void process.stderr.write(`${line}\n`),
  async readStdin(maxBytes) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of Bun.stdin.stream()) {
      total += chunk.byteLength;
      if (total > maxBytes) throw new OpError("INVALID", `stdin is larger than ${Math.floor(maxBytes / MiB)} MiB`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  },
  isRoot: () => process.getuid?.() === 0,
  open({ create, ...options }) {
    // Registry.open creates a registry where there is none: a mistyped --root would become an empty host.
    if (!create && !existsSync(new HostLayout({ root: options.root }).registry)) throw notSetUp(options.root);
    const ctx = openHost(options);
    if (!create && ctx.registry.savedLayout() === null) {
      ctx.registry.close();
      throw notSetUp(options.root);
    }
    return { ctx, close: () => ctx.registry.close() };
  },
  async exec(argv, line) {
    // Ctrl-C on `logs -f` reaches journalctl too (one process group); this process waits for it to end.
    const ignore = () => {};
    process.on("SIGINT", ignore);
    try {
      // Its output is the tenant's, so it never reaches the terminal unread (escape sequences): see logs.
      const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C.UTF-8", SYSTEMD_COLORS: "0" } });
      const stderr = (async () => {
        let text = "";
        for await (const chunk of child.stderr.pipeThrough(new TextDecoderStream())) if (text.length < MAX_STDERR) text += chunk;
        return text.slice(0, MAX_STDERR);
      })();
      let rest = "";
      for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
        rest += chunk;
        let nl: number;
        while ((nl = rest.indexOf("\n")) >= 0 || rest.length > MAX_LINE) {
          const end = nl >= 0 && nl <= MAX_LINE ? nl : MAX_LINE;
          line(rest.slice(0, end));
          rest = rest.slice(end === nl ? end + 1 : end);
        }
      }
      if (rest) line(rest);
      return { code: await child.exited, stderr: await stderr };
    } finally {
      process.off("SIGINT", ignore);
    }
  },
  env: process.env,
};

const notSetUp = (root: string) => new OpError("FAILED", `No incibase host at ${root}: run sudo incibase host init --domain <domain> there first, or pass the right --root`);

// ---- command table -------------------------------------------------------------------

interface Flag {
  type: "string" | "boolean";
  short?: string;
  /** The value's placeholder in help, e.g. `<n>`. */
  value?: string;
  help: string;
  multiple?: boolean;
}

type Values = Record<string, string | boolean | string[] | undefined>;

interface Call {
  ctx: OpsContext;
  values: Values;
  args: string[];
  io: CommandIO;
  json: boolean;
  root: string;
}

interface Outcome {
  /** What --json prints. */
  json: unknown;
  /** What is printed otherwise; stdout. */
  text?: string[];
  /** Notes for people (stderr), in both modes. */
  notes?: string[];
  /** False: the command ran but what it asked for did not happen (exit 1). */
  ok?: boolean;
}

interface Spec {
  /** e.g. ["branch", "create"]. */
  path: string[];
  /** Positional arguments for help, e.g. `<project>/<branch>`. */
  args: string;
  summary: string;
  /** How many positionals: [min, max]. */
  positionals: [number, number];
  /** Whether the first positional is `<project>/<branch>` (checked before anything else). */
  ref?: boolean;
  flags?: Record<string, Flag>;
  /** Longer help after the flags. */
  details?: string;
  /** Not given a host (tunnel); default false. */
  local?: boolean;
  /** Layout options for `host init`. */
  layout?: (values: Values) => Omit<LayoutOptions, "root"> | undefined;
  /** What can be checked from the command line alone; runs before root and the host are looked at. */
  check?(values: Values, args: string[]): void;
  run(call: Call): Promise<Outcome>;
}

const COMMON: Record<string, Flag> = {
  root: { type: "string", value: "<dir>", help: `The host root (default $INCIBASE_HOST_ROOT or ${DEFAULT_ROOT})` },
  json: { type: "boolean", help: "Print the result as JSON (progress and notes go to stderr)" },
  help: { type: "boolean", short: "h", help: "This help" },
};

const CONFIRM: Flag = { type: "string", value: "<hostname>", help: "A protected (or, for delete, production) branch's hostname, e.g. prod--shop.example.net" };
const RESTART: Flag = { type: "boolean", help: "Restart now (with the health gate) so the change takes effect; otherwise at the next start" };

// ---- helpers -----------------------------------------------------------------------

const target = (args: string[]) => parseBranchRef(args[0]!);
const str = (v: Values, name: string) => v[name] as string | undefined;
const bool = (v: Values, name: string) => v[name] === true;

function int(name: string, text: string | undefined, min: number, max: number): number | undefined {
  if (text === undefined) return undefined;
  if (!/^\d{1,10}$/.test(text) || Number(text) < min || Number(text) > max) throw new UsageError(`--${name} takes a whole number from ${min} to ${max}, got ${JSON.stringify(text)}`);
  return Number(text);
}

function size(name: string, text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  try {
    return parseSize(text);
  } catch (err) {
    throw new UsageError(`--${name}: ${(err as Error).message}`);
  }
}

function onOff(name: string, text: string | undefined): boolean | undefined {
  if (text === undefined) return undefined;
  if (text === "on" || text === "true") return true;
  if (text === "off" || text === "false") return false;
  throw new UsageError(`--${name} takes on or off, got ${JSON.stringify(text)}`);
}

/** Text from the registry or a process, safe for root's terminal. */
const clean = (value: unknown) => printable(value === null || value === undefined ? "-" : String(value), 300);

/** Columns padded to their widest cell; the last one is not padded. */
export function table(header: string[], rows: unknown[][]): string[] {
  const cells = [header, ...rows.map((r) => r.map(clean))];
  const widths = header.map((_, i) => Math.max(...cells.map((r) => r[i]!.length)));
  return cells.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join("  ").trimEnd());
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  if (n >= 1024 * MiB) return `${(n / (1024 * MiB)).toFixed(n % (1024 * MiB) === 0 ? 0 : 1)}G`;
  if (n >= MiB) return `${(n / MiB).toFixed(n % MiB === 0 ? 0 : 1)}M`;
  if (n >= 1024) return `${Math.round(n / 1024)}K`;
  return `${n}B`;
}

const formatTime = (ms: number | null) => (ms === null ? "-" : new Date(ms).toISOString().slice(0, 16).replace("T", " ") + "Z");

function gateText(gate: GateResult | null, what = "restart"): string {
  if (!gate) return "";
  if (gate.ok) return `${what}: healthy after ${(gate.ms / 1000).toFixed(1)} s`;
  const unit = gate.status;
  return `${what} FAILED: ${gate.reason === "timeout" ? "not healthy in time" : "the unit stopped"} (${unit.activeState}/${unit.subState}, ${unit.result}); see incibase logs`;
}

/** A release row for output: without its manifest, which is long. */
function releaseOut(r: ReleaseRow) {
  const { manifest_json: _m, ...rest } = r;
  return rest;
}

/** The env names the branch's current release reads and the branch does not set. */
function missingEnv(ctx: OpsContext, branch: BranchRow): string[] {
  if (branch.release_seq === null) return [];
  const release = ctx.registry.getRelease(branch.id, branch.release_seq);
  if (!release) return [];
  let names: unknown;
  try {
    names = (JSON.parse(release.manifest_json) as { envNames?: unknown }).envNames;
  } catch {
    return [];
  }
  if (!Array.isArray(names)) return [];
  const set = new Set(ctx.registry.listEnv(branch.id).map((e) => e.name));
  return names.filter((n): n is string => typeof n === "string" && !set.has(n)).sort();
}

const missingNote = (names: string[]) => (names.length ? [`warning: the release reads ${names.map(clean).join(", ")}, not set on this branch`] : []);

function branchOf(ctx: OpsContext, args: string[]): BranchRow {
  const t = target(args);
  const branch = ctx.registry.findBranch(t.project, t.branch);
  if (!branch) throw new OpError("NOT_FOUND", `No branch ${branchRef(t.project, t.branch)}`);
  return branch;
}

/** `KEY=VALUE` arguments of `env set`. */
function assignments(args: string[]): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const arg of args) {
    const eq = arg.indexOf("=");
    if (eq <= 0) throw new UsageError(`Expected NAME=VALUE, got ${JSON.stringify(arg.length > 40 ? `${arg.slice(0, 40)}...` : arg)}`);
    vars[arg.slice(0, eq)] = arg.slice(eq + 1);
  }
  return vars;
}

const ENV_LINE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MULTILINE = "values cannot span lines; encode multi-line values, e.g. in base64";

/**
 * `env import`: KEY=VALUE lines as a .env file has them. Blank lines and
 * `#` comments are skipped, `export ` is allowed before a name, values may
 * be in double quotes (with \" and \\) or single quotes (literal), and an
 * unquoted value ends at ` #`. A value that would hold a newline (an open
 * quote, or \n in double quotes) is refused, as env set refuses it. The
 * last of a repeated name wins.
 */
export function parseEnvImport(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const lines = text.split("\n");
  for (const [i, raw] of lines.entries()) {
    const at = `line ${i + 1}`;
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const body = trimmed.startsWith("export ") ? trimmed.slice(7).trimStart() : trimmed;
    const eq = body.indexOf("=");
    if (eq < 0) throw new OpError("INVALID", `${at}: expected NAME=VALUE`);
    const name = body.slice(0, eq).trimEnd();
    if (!ENV_LINE_NAME.test(name)) throw new OpError("INVALID", `${at}: invalid variable name ${JSON.stringify(name.slice(0, 40))}`);
    const rest = body.slice(eq + 1).trimStart();
    let value: string;
    let after: string;
    if (rest.startsWith('"')) {
      value = "";
      let j = 1;
      for (; j < rest.length && rest[j] !== '"'; j++) {
        if (rest[j] === "\\" && j + 1 < rest.length) {
          const next = rest[++j]!;
          if (next === "n" || next === "r") throw new OpError("INVALID", `${at}: ${name}: ${MULTILINE}`);
          value += next === '"' || next === "\\" || next === "$" ? next : `\\${next}`;
        } else value += rest[j];
      }
      if (j >= rest.length) throw new OpError("INVALID", `${at}: ${name}: the closing " is missing; ${MULTILINE}`);
      after = rest.slice(j + 1);
    } else if (rest.startsWith("'")) {
      const end = rest.indexOf("'", 1);
      if (end < 0) throw new OpError("INVALID", `${at}: ${name}: the closing ' is missing; ${MULTILINE}`);
      value = rest.slice(1, end);
      after = rest.slice(end + 1);
    } else {
      const comment = rest.search(/\s#/);
      value = (comment < 0 ? rest : rest.slice(0, comment)).trimEnd();
      after = "";
    }
    if (after.trim() && !after.trim().startsWith("#")) throw new OpError("INVALID", `${at}: ${name}: unexpected text after the closing quote`);
    vars[name] = value;
  }
  if (!Object.keys(vars).length) throw new OpError("INVALID", "No variables to import");
  return vars;
}

/** stdin ("-") or a file, as bytes; at most `max`. */
async function input(io: CommandIO, path: string, max: number): Promise<Uint8Array> {
  if (path === "-") return io.readStdin(max);
  const file = Bun.file(resolve(path));
  if (!(await file.exists())) throw new OpError("NOT_FOUND", `No file ${path}`);
  if (file.size > max) throw new OpError("INVALID", `${path} is larger than ${Math.floor(max / MiB)} MiB`);
  return new Uint8Array(await file.arrayBuffer());
}

function alertLines(alerts: AlertRow[]): string[] {
  if (!alerts.length) return ["alerts: none firing"];
  return ["alerts:", ...alerts.map((a) => `  FIRING ${clean(a.key)}: ${clean(a.message)} (since ${formatTime(a.since)})`)];
}

// ---- host ------------------------------------------------------------------------------

/** `host init`'s flags as initHost's input. */
function initInput(values: Values) {
  const domain = str(values, "domain");
  if (!domain) throw new UsageError("--domain is required");
  const cert = str(values, "tls-cert");
  const key = str(values, "tls-key");
  const trust = str(values, "trust-proxy");
  if (trust !== undefined && !(TRUST_PROXY as readonly string[]).includes(trust)) throw new UsageError(`--trust-proxy takes ${TRUST_PROXY.join(" or ")}`);
  return {
    domain,
    ...(str(values, "timezone") !== undefined ? { timezone: str(values, "timezone") } : {}),
    ...(cert !== undefined ? { tlsCert: resolve(cert) } : {}),
    ...(key !== undefined ? { tlsKey: resolve(key) } : {}),
    ...(trust !== undefined ? { trustProxy: trust as (typeof TRUST_PROXY)[number] } : {}),
    ...(values["https-port"] !== undefined ? { httpsPort: int("https-port", str(values, "https-port"), 1, 65535) } : {}),
    ...(values["uid-base"] !== undefined ? { uidBase: int("uid-base", str(values, "uid-base"), 0, 99_999) } : {}),
    ...(values["tunnel-port-base"] !== undefined ? { tunnelPortBase: int("tunnel-port-base", str(values, "tunnel-port-base"), 1024, 65_000) } : {}),
    ...(values["slice-memory"] !== undefined ? { sliceMemoryMax: size("slice-memory", str(values, "slice-memory")) } : {}),
    ...(bool(values, "no-check-timer") ? { checkTimer: false } : {}),
  };
}

/**
 * `host init`'s check timer line and next step. The check service runs the
 * CLI link, which the first init (from a download) cannot have made yet:
 * until it leads to an installed runtime, the next step is install-runtime
 * and use-cli, with this binary as the owner ran it.
 */
function initNext(ctx: OpsContext): string[] {
  const link = ctx.layout.cliLink;
  const cli = cliLinkRuntime(ctx);
  const off = ctx.registry.getSetting("check_timer") === "off";
  if (cli.ok) {
    return [`  check timer: ${off ? "off" : `every 30 s, runs ${link} (runtime ${cli.version})`}`, "Next: sudo incibase host add-admin <you>, then sudo incibase project create <slug>"];
  }
  const me = ctx.self.join(" ");
  const binary = ctx.self.length === 1 ? ctx.self[0]! : "<incibase-linux-arch>";
  const steps = trustedRuntimes(ctx).includes(VERSION) ? [] : [`sudo ${me} host install-runtime ${binary} --version ${VERSION} --sums SHA256SUMS`];
  steps.push(`sudo ${me} host use-cli ${VERSION}${ctx.sys.lstat(link)?.type === "file" ? " --replace" : ""}`);
  return [
    `  check timer: ${off ? "off" : cli.skipped ? `waits for ${link} (host use-cli), skipping every run until then` : `runs ${link}, which ${cli.problem}`}`,
    `Next: ${steps.join(", then ")}`,
  ];
}

/** `host set <key> <value>`, checked: which setting, and its value. */
function hostSetting(args: string[], values: Values): { key: "alert_webhook"; value: string | null } | { key: "trust_proxy"; value: (typeof TRUST_PROXY)[number] } | { key: "https_port"; value: number } {
  const [key, value] = args as [string, string];
  if (key === "alert_webhook") return { key, value: value || null };
  if (bool(values, "test")) throw new UsageError("--test is for alert_webhook");
  if (key === "trust_proxy") {
    if (!(TRUST_PROXY as readonly string[]).includes(value)) throw new UsageError(`trust_proxy takes ${TRUST_PROXY.join(" or ")}`);
    return { key, value: value as (typeof TRUST_PROXY)[number] };
  }
  if (key === "https_port") return { key, value: int("https_port", value, 1, 65535)! };
  throw new UsageError(`Unknown setting ${JSON.stringify(key)}: use alert_webhook, trust_proxy or https_port`);
}

/** `branch set`'s flags: the limits, settings and protection to change. */
function branchChanges(values: Values): { limits: Partial<BranchLimits>; config: BranchConfig; protect: boolean | undefined } {
  const limits: Partial<BranchLimits> = {};
  const set = <K extends keyof BranchLimits>(k: K, v: BranchLimits[K] | undefined) => v !== undefined && (limits[k] = v);
  set("memoryMax", size("memory", str(values, "memory")));
  set("memoryHigh", size("memory-high", str(values, "memory-high")));
  set("cpuQuota", int("cpu", str(values, "cpu"), 1, 100_000));
  set("tasksMax", int("tasks", str(values, "tasks"), 16, 65_536));
  set("maxDbBytes", size("max-db", str(values, "max-db")));
  set("maxStorageBytes", size("max-storage", str(values, "max-storage")));
  set("maxUploadBytes", size("max-upload", str(values, "max-upload")));
  const config: BranchConfig = {};
  try {
    if (values.timeouts !== undefined) config.timeouts = parseTimeouts(str(values, "timeouts")!);
    if (values["drain-timeout"] !== undefined) config.drainMs = parseDrainTimeout(str(values, "drain-timeout")!);
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const preflight = onOff("preflight", str(values, "preflight"));
  if (preflight !== undefined) config.preflight = preflight;
  const protect = onOff("protected", str(values, "protected"));
  if (!Object.keys(limits).length && !Object.keys(config).length && protect === undefined) throw new UsageError("Nothing to change: pass a limit, a setting or --protected");
  return { limits, config, protect };
}

const SERVICE_KEY_ID = /^k[0-9a-z]{9}$/;

const RUNTIME_DETAILS = `Installs a runtime: the local <binary> checked against its SHA256SUMS entry or sha256,
or, without one, incibase-linux-<arch> downloaded from the GitHub release v<x.y.z>
and checked against that release's SHA256SUMS.`;

const SPECS: Spec[] = [
  {
    path: ["host", "init"],
    args: "",
    summary: "Set up this machine: registry, groups, slice, units, check timer and (with a certificate) the nginx front door; safe to run again",
    positionals: [0, 0],
    flags: {
      domain: { type: "string", value: "<domain>", help: "Branches are served at https://<branch>--<project>.<domain> (required)" },
      timezone: { type: "string", value: "<zone>", help: "IANA time zone for crons, e.g. Europe/Istanbul" },
      "tls-cert": { type: "string", value: "<file>", help: "PEM certificate for *.<domain> (e.g. Cloudflare Origin CA)" },
      "tls-key": { type: "string", value: "<file>", help: "Its private key" },
      "trust-proxy": { type: "string", value: "<none|cloudflare>", help: "Take the client address from a proxy in front (default none)" },
      "https-port": { type: "string", value: "<n>", help: "The port nginx serves HTTPS on (default 443)" },
      "uid-base": { type: "string", value: "<n>", help: "The first branch uid (default 70000; only before the first branch)" },
      "tunnel-port-base": { type: "string", value: "<n>", help: "The first laptop port for incibase tunnel (default 7101)" },
      "slice-memory": { type: "string", value: "<size>", help: "MemoryMax of all branches together (default: the machine's memory less 1G)" },
      "no-check-timer": { type: "boolean", help: "Do not run host check every 30 s" },
      layout: { type: "string", value: "<json>", help: "Unit prefix, groups and directories of a second host on one machine (tests)" },
    },
    layout(values) {
      const text = str(values, "layout");
      if (text === undefined) return undefined;
      try {
        return JSON.parse(text) as Omit<LayoutOptions, "root">;
      } catch {
        throw new UsageError("--layout takes a JSON object");
      }
    },
    check: (values) => void initInput(values),
    async run({ ctx, values, root }) {
      const result = await ops.initHost(ctx, initInput(values));
      const front = result.frontDoor;
      return {
        json: result,
        text: [
          `${root} is set up for ${result.domain}`,
          `  units ${result.layout.unitPrefix}-*, groups ${result.layout.groups.admin} and ${result.layout.groups.proxy}`,
          front
            ? `  front door: ${front.certificate ? `certificate ${clean((front.certificate as { sha256?: string }).sha256 ?? "installed")}, ` : ""}nginx ${front.nginx.skipped ? `skipped (${clean(front.nginx.skipped)})` : (front.nginx.action ?? "unchanged")}`
            : "  front door: not configured yet (pass --tls-cert and --tls-key)",
          ...initNext(ctx),
        ],
      };
    },
  },
  {
    path: ["host", "add-admin"],
    args: "<unix user>",
    summary: "Let a person's login account use incibase tunnel (the admin group)",
    positionals: [1, 1],
    async run({ ctx, args, json: _json }) {
      const result = await ops.addAdmin(ctx, { user: args[0]! });
      return {
        json: result,
        text: [result.added ? `Added ${result.user} to ${result.group}; it applies to their next SSH login` : `${result.user} is already in ${result.group}`],
      };
    },
  },
  {
    path: ["host", "render"],
    args: "",
    summary: "Render every derived file again, finish or undo half-done work and free branches whose job is gone",
    positionals: [0, 0],
    async run({ ctx }) {
      const r = await ops.render(ctx);
      const nginx = "error" in r.nginx ? `FAILED: ${clean(r.nginx.error)}` : r.nginx.skipped ? `skipped (${clean(r.nginx.skipped)})` : (r.nginx.action ?? "unchanged");
      return {
        json: r,
        ok: r.failed.length === 0 && !("error" in r.nginx),
        text: [
          `rendered ${r.rendered.length} branch(es); provisioned ${r.provisioned.length}, rolled back ${r.rolledBack.length}, deleted ${r.deleted.length}, freed ${r.interrupted.length}`,
          ...r.failed.map((f) => `FAILED ${f.id}: ${clean(f.error)}`),
          `nginx: ${nginx}`,
        ],
      };
    },
  },
  {
    path: ["host", "status"],
    args: "",
    summary: "The host's settings, runtimes, branch counts and firing alerts",
    positionals: [0, 0],
    async run({ ctx, root }) {
      const s = (key: string) => ctx.registry.getSetting(key);
      const { runtimes, cli } = await ops.listRuntimes(ctx);
      const branches = ctx.registry.listBranches({ phase: ["provisioning", "ready", "deleting"] });
      const alerts = ctx.registry.listAlerts("firing");
      const result = {
        root,
        domain: s("domain"),
        timezone: s("timezone"),
        layout: ctx.layout.saved(),
        frontDoor: { httpsPort: Number(s("https_port") ?? 443), trustProxy: s("trust_proxy") ?? "none", certificate: s("tls_cert") !== null },
        checkTimer: s("check_timer") ?? "on",
        alertWebhook: s(ALERT_WEBHOOK) ? new URL(s(ALERT_WEBHOOK)!).host : null,
        cli,
        runtimes: runtimes.map((r) => ({ version: r.version, pinnedBy: r.pinnedBy.length, present: r.present })),
        projects: ctx.registry.listProjects().length,
        branches: { total: branches.length, running: branches.filter((b) => b.desired_state === "running").length, busy: branches.filter((b) => b.busy_unit).length },
        alerts,
      };
      return {
        json: result,
        text: [
          `root        ${root}`,
          `domain      ${clean(result.domain)}  (time zone ${clean(result.timezone)})`,
          `front door  https port ${result.frontDoor.httpsPort}, trust proxy ${clean(result.frontDoor.trustProxy)}, certificate ${result.frontDoor.certificate ? "installed" : "none"}`,
          `check       timer ${clean(result.checkTimer)}, alerts to ${clean(result.alertWebhook ?? "nowhere (host set alert_webhook)")}`,
          `runtimes    ${runtimes.map((r) => `${r.version}${r.version === cli ? " (cli)" : ""}`).join(", ") || "none"}`,
          `branches    ${result.branches.total} in ${result.projects} project(s), ${result.branches.running} meant to run, ${result.branches.busy} busy`,
          ...alertLines(alerts),
        ],
      };
    },
  },
  {
    path: ["host", "doctor"],
    args: "",
    summary: "OK/WARN/FAIL for everything the host relies on; exits 1 when something fails",
    positionals: [0, 0],
    async run({ ctx }) {
      const report = await ops.doctor(ctx);
      return { json: report, ok: report.ok, text: [formatDoctor(report)] };
    },
  },
  {
    path: ["host", "check"],
    args: "",
    summary: "One health check of every running branch, the disk and the alerts (the check timer runs it every 30 s)",
    positionals: [0, 0],
    async run({ ctx }) {
      const report = await ops.check(ctx);
      const text: string[] = [];
      if (report.skipped) text.push(`skipped    ${clean(report.skipped)}`);
      else {
        for (const b of report.branches) text.push(`${b.outcome.padEnd(10)} ${b.ref}: ${clean(b.detail)}`);
        if (report.disk) text.push(`disk       ${report.disk.usedPercent}% used, ${(report.disk.availableBytes / 1024 ** 3).toFixed(1)} GiB free`);
        const n = report.notifications;
        text.push(`alerts     ${n.unconfigured ? "no alert_webhook set" : `${n.sent} sent`}${n.error ? `; delivery stopped: ${clean(n.error)}` : ""}`);
      }
      return { json: report, text };
    },
  },
  {
    path: ["host", "gc"],
    args: "",
    summary: "Remove trash older than --older-than days (7) and the runtimes nothing uses",
    positionals: [0, 0],
    flags: { "older-than": { type: "string", value: "<days>", help: "Trash older than this many days (default 7)" } },
    check: (values) => void int("older-than", str(values, "older-than"), 0, 3650),
    async run({ ctx, values }) {
      const days = int("older-than", str(values, "older-than"), 0, 3650);
      const r = await ops.gc(ctx, days === undefined ? {} : { olderThanDays: days });
      return {
        json: r,
        text: [
          `trash: ${r.trash.length ? r.trash.join(", ") : "nothing to remove"}`,
          `runtimes: ${r.runtimes.removed.length ? `removed ${r.runtimes.removed.join(", ")}` : "nothing to remove"}${r.runtimes.skipped ? ` (${clean(r.runtimes.skipped)})` : ""}`,
          ...(r.runtimes.unrecorded.length ? [`unrecorded runtime dirs left alone: ${r.runtimes.unrecorded.join(", ")}`] : []),
        ],
      };
    },
  },
  {
    path: ["host", "install-runtime"],
    args: "[<binary>]",
    summary: "Install a runtime version, checked against its SHA256SUMS",
    positionals: [0, 1],
    flags: {
      version: { type: "string", value: "<x.y.z>", help: "The version to install (required)" },
      sums: { type: "string", value: "<SHA256SUMS>", help: "The release's SHA256SUMS, for a local <binary>" },
      sha256: { type: "string", value: "<hex>", help: "Or the binary's sha256" },
      "skip-version-check": { type: "boolean", help: "Install under --version even if the binary reports another" },
    },
    details: RUNTIME_DETAILS,
    async run({ ctx, values, args }) {
      const r = await ops.installRuntime(ctx, {
        version: str(values, "version") ?? "",
        ...(args[0] === undefined ? {} : { binary: resolve(args[0]) }),
        ...(values.sums === undefined ? {} : { sums: resolve(str(values, "sums")!) }),
        ...(values.sha256 === undefined ? {} : { sha256: str(values, "sha256") }),
        skipVersionCheck: bool(values, "skip-version-check"),
      });
      return { json: r, text: [`${r.installed ? "Installed" : "Already installed:"} runtime ${r.version} at ${r.path} (sha256 ${r.sha256.slice(0, 16)}...)`] };
    },
  },
  {
    path: ["host", "use-cli"],
    args: "<version>",
    summary: "Point /usr/local/bin/incibase, which the check timer runs, at an installed runtime",
    positionals: [1, 1],
    flags: { replace: { type: "boolean", help: "Replace a file that is not a link (an incibase copied there by hand)" } },
    async run({ ctx, values, args }) {
      const r = await ops.useCli(ctx, { version: args[0]!, replace: bool(values, "replace") });
      return { json: r, text: [`${ctx.layout.cliLink} now runs ${args[0]}`] };
    },
  },
  {
    path: ["host", "runtimes"],
    args: "",
    summary: "The installed runtimes and the branches that pin them",
    positionals: [0, 0],
    async run({ ctx }) {
      const r = await ops.listRuntimes(ctx);
      return {
        json: r,
        text: table(
          ["VERSION", "SHA256", "CLI", "FILE", "PINNED BY"],
          r.runtimes.map((x) => [x.version, `${x.sha256.slice(0, 16)}...`, x.cli ? "yes" : "", x.present ? "ok" : "MISSING", x.pinnedBy.join(", ") || "-"]),
        ),
      };
    },
  },
  {
    path: ["host", "set"],
    args: "<key> <value>",
    summary: "Change a host setting: alert_webhook <https url|''>, trust_proxy <none|cloudflare>, https_port <n>",
    positionals: [2, 2],
    flags: { test: { type: "boolean", help: "alert_webhook: send a test notification" } },
    details: "alert_webhook is where alerts go, e.g. an ntfy.sh topic; '' removes it.",
    check: (values, args) => void hostSetting(args, values),
    async run({ ctx, values, args }) {
      const setting = hostSetting(args, values);
      if (setting.key === "alert_webhook") {
        const r = await ops.setSetting(ctx, { key: setting.key, value: setting.value, test: bool(values, "test") });
        return { json: r, text: [r.set ? `alert_webhook set (${clean(r.host)})${r.tested ? "; the test notification was sent" : ""}` : "alert_webhook removed"] };
      }
      if (setting.key === "trust_proxy") {
        const r = await ops.setFrontDoor(ctx, { trustProxy: setting.value });
        return { json: r, text: [`trust_proxy is ${setting.value}`] };
      }
      const r = await ops.setFrontDoor(ctx, { httpsPort: setting.value });
      return { json: r, text: [`nginx serves HTTPS on port ${setting.value}`] };
    },
  },
  {
    path: ["host", "tls"],
    args: "",
    summary: "Install or rotate the front door's certificate (tested with nginx -t, then nginx reloads)",
    positionals: [0, 0],
    flags: {
      cert: { type: "string", value: "<file>", help: "PEM certificate for *.<domain> (required)" },
      key: { type: "string", value: "<file>", help: "Its private key (required)" },
    },
    check(values) {
      if (!str(values, "cert") || !str(values, "key")) throw new UsageError("--cert and --key are required");
    },
    async run({ ctx, values }) {
      const cert = str(values, "cert");
      const key = str(values, "key");
      if (!cert || !key) throw new UsageError("--cert and --key are required");
      const r = await ops.setTls(ctx, { cert: resolve(cert), key: resolve(key) });
      return { json: r, text: [`certificate installed; nginx ${r.nginx.skipped ? `skipped (${clean(r.nginx.skipped)})` : (r.nginx.action ?? "unchanged")}`] };
    },
  },

  // ---- projects ----------------------------------------------------------------------

  {
    path: ["project", "create"],
    args: "<slug>",
    summary: "Create a project with its branches (default prod and dev)",
    positionals: [1, 1],
    flags: {
      branches: { type: "string", value: "<a,b>", help: "Branches to create with it (default prod,dev; '' for none)" },
      name: { type: "string", value: "<text>", help: "A display name (default the slug)" },
    },
    check: (_values, args) => void checkProjectSlug(args[0]),
    async run({ ctx, values, args }) {
      const list = str(values, "branches");
      const branches = list === undefined ? undefined : list.split(",").map((b) => b.trim()).filter(Boolean);
      const r = await ops.createProject(ctx, { slug: checkProjectSlug(args[0]), ...(str(values, "name") ? { name: str(values, "name") } : {}), ...(branches ? { branches } : {}) });
      const domain = ctx.registry.getSetting("domain");
      return {
        json: r,
        text: [
          `Created project ${r.project.slug}${r.branches.length ? ":" : " (no branches)"}`,
          ...r.branches.map((b) => `  ${branchRef(b.project, b.name).padEnd(24)} ${b.kind.padEnd(7)} ${domain ? `https://${b.label}.${domain}` : b.label}`),
          ...(r.branches.length ? [`Next: incibase bundle --out app.ib, copy it here, then sudo incibase release add ${branchRef(r.project.slug, r.branches[0]!.name)} app.ib`] : []),
        ],
      };
    },
  },
  {
    path: ["project", "list"],
    args: "",
    summary: "The projects and their branches",
    positionals: [0, 0],
    async run({ ctx }) {
      const r = await ops.listProjects(ctx);
      return { json: r, text: r.length ? table(["PROJECT", "NAME", "CREATED", "BRANCHES"], r.map((p) => [p.slug, p.name, formatTime(p.created_at), p.branches.join(", ") || "-"])) : ["No projects yet: sudo incibase project create <slug>"] };
    },
  },
  {
    path: ["project", "delete"],
    args: "<slug>",
    summary: "Delete a project that has no branches left (delete them first with branch delete)",
    positionals: [1, 1],
    async run({ ctx, args }) {
      const r = await ops.deleteProject(ctx, { slug: args[0]! });
      return { json: r, text: [`Deleted project ${r.slug}`] };
    },
  },

  // ---- branches ----------------------------------------------------------------------

  {
    path: ["branch", "create"],
    args: "<project>/<branch>",
    summary: "Create a branch: its user, directories, units and hostname",
    positionals: [1, 1],
    ref: true,
    flags: {
      kind: { type: "string", value: `<${BRANCH_KINDS.join("|")}>`, help: "Default: prod for prod, dev for dev, otherwise preview" },
      protected: { type: "boolean", help: "Stopping or deleting it needs --confirm (default for prod)" },
      unprotected: { type: "boolean", help: "Not protected, even as prod" },
      runtime: { type: "string", value: "<x.y.z>", help: "Pin an installed runtime (default this incibase's version)" },
    },
    check(values) {
      if (bool(values, "protected") && bool(values, "unprotected")) throw new UsageError("Pass --protected or --unprotected, not both");
      const kind = str(values, "kind");
      if (kind !== undefined && !(BRANCH_KINDS as readonly string[]).includes(kind)) throw new UsageError(`--kind takes ${BRANCH_KINDS.join(", ")}`);
    },
    async run({ ctx, values, args }) {
      const t = target(args);
      const kind = str(values, "kind");
      const b = await ops.createBranch(ctx, {
        project: t.project,
        name: t.branch,
        ...(kind ? { kind: kind as (typeof BRANCH_KINDS)[number] } : {}),
        ...(bool(values, "protected") ? { protected: true } : bool(values, "unprotected") ? { protected: false } : {}),
        ...(str(values, "runtime") ? { runtimeVersion: str(values, "runtime") } : {}),
      });
      const domain = ctx.registry.getSetting("domain");
      return { json: b, text: [`Created ${branchRef(b.project, b.name)} (${b.kind}${b.protected ? ", protected" : ""}): ${domain ? `https://${b.label}.${domain}` : b.label}`] };
    },
  },
  {
    path: ["branch", "list"],
    args: "[<project>]",
    summary: "The branches, with what they should and do run",
    positionals: [0, 1],
    check: (_values, args) => void (args[0] === undefined || checkProjectSlug(args[0])),
    async run({ ctx, args }) {
      const r = await ops.status(ctx, args[0] === undefined ? {} : { project: checkProjectSlug(args[0]) });
      return {
        json: r.branches,
        text: r.branches.length
          ? table(
              ["BRANCH", "KIND", "PROTECTED", "DESIRED", "ACTUAL", "RELEASE", "RUNTIME"],
              r.branches.map((b) => {
                const row = ctx.registry.getBranch(b.id)!;
                return [b.ref, b.kind, row.protected ? "yes" : "no", b.desired, `${b.actual.activeState}/${b.actual.subState}`, b.release === null ? "-" : `${b.release} ${b.releaseStatus}`, b.runtime];
              }),
            )
          : ["No branches"],
      };
    },
  },
  {
    path: ["branch", "info"],
    args: "<project>/<branch>",
    summary: "Everything about one branch: state, limits, releases, env names, service keys, paths",
    positionals: [1, 1],
    ref: true,
    async run({ ctx, args }) {
      const t = target(args);
      const { branches } = await ops.status(ctx, { project: t.project, branch: t.branch });
      const s = branches[0]!;
      const row = ctx.registry.getBranch(s.id)!;
      const releases = await ops.listReleases(ctx, t);
      const env = await ops.envList(ctx, t);
      const keys = (await ops.serviceKeyList(ctx, t)).filter((k) => k.revoked_at === null);
      const paths = ctx.layout.branch(s.id);
      const result = {
        ...s,
        protected: row.protected === 1,
        user: `ib-${s.id}`,
        uid: row.os_uid,
        tunnelPort: row.tunnel_port,
        adminSocket: `${ctx.layout.admin}/${s.label}.sock`,
        data: paths.data,
        releases: releases.slice(0, 5),
        env: env.map((e) => e.name),
        serviceKeys: keys.map((k) => ({ id: k.id, label: k.label, scopes: k.scopes })),
        missingEnv: missingEnv(ctx, row),
      };
      const l = s.limits;
      return {
        json: result,
        notes: missingNote(result.missingEnv),
        text: [
          `${s.ref}  ${s.kind}${result.protected ? ", protected" : ""}  ${clean(s.url ?? s.label)}`,
          `  state     desired ${s.desired}, actual ${s.actual.activeState}/${s.actual.subState}${s.actual.nRestarts ? `, ${s.actual.nRestarts} restart(s)` : ""}${s.busy ? `, busy (${s.busy})` : ""}`,
          `  release   ${s.release === null ? "none" : `${s.release} (${s.releaseStatus})`}, generation ${clean(s.generation)}, runtime ${s.runtime}`,
          `  memory    ${formatBytes(s.actual.memoryCurrent)} of ${formatBytes(l.memoryMax)} (high ${formatBytes(l.memoryHigh)}), cpu ${l.cpuQuota}%, tasks ${l.tasksMax}`,
          `  user      ${result.user} (uid ${result.uid}), data ${result.data}`,
          `  tunnel    port ${result.tunnelPort}, ${result.adminSocket}`,
          `  env       ${result.env.join(", ") || "-"}`,
          `  keys      ${result.serviceKeys.map((k) => `${k.id} ${clean(k.label)} [${k.scopes.join(",")}]`).join("; ") || "-"}`,
          `  releases  ${releases.slice(0, 5).map((r) => `${r.seq} ${r.status}${r.current ? "*" : ""}`).join(", ") || "-"}`,
        ],
      };
    },
  },
  {
    path: ["branch", "set"],
    args: "<project>/<branch>",
    summary: "Change a branch's limits, settings or protection",
    positionals: [1, 1],
    ref: true,
    flags: {
      memory: { type: "string", value: "<size>", help: "MemoryMax, e.g. 512M (MemoryHigh follows at 90 %)" },
      "memory-high": { type: "string", value: "<size>", help: "MemoryHigh" },
      cpu: { type: "string", value: "<percent>", help: "CPUQuota, 100 = one core" },
      tasks: { type: "string", value: "<n>", help: "TasksMax" },
      "max-db": { type: "string", value: "<size>", help: "Largest database" },
      "max-storage": { type: "string", value: "<size>", help: "Most stored file bytes" },
      "max-upload": { type: "string", value: "<size>", help: "Largest upload" },
      timeouts: { type: "string", value: "<spec>", help: "Deadlines, e.g. query=10s,mutation=10s,action=120s,http=120s" },
      "drain-timeout": { type: "string", value: "<duration>", help: "How long a stop waits for running calls, e.g. 10s" },
      preflight: { type: "string", value: "<on|off>", help: "Run a preflight before each release (default on for prod)" },
      protected: { type: "string", value: "<on|off>", help: "Protection; turning it off needs --confirm" },
      confirm: CONFIRM,
      restart: RESTART,
    },
    check: (values) => void branchChanges(values),
    async run({ ctx, values, args }) {
      const t = target(args);
      const { limits, config, protect } = branchChanges(values);
      const r = await ops.setBranch(ctx, {
        ...t,
        ...(Object.keys(limits).length ? { limits } : {}),
        ...(Object.keys(config).length ? { config } : {}),
        ...(protect !== undefined ? { protected: protect } : {}),
        ...(str(values, "confirm") !== undefined ? { confirm: str(values, "confirm") } : {}),
        restart: bool(values, "restart"),
      });
      const l = resolveLimits(JSON.parse(r.branch.limits_json));
      return {
        json: r,
        ok: r.restarted ? r.restarted.ok : true,
        text: [
          `Changed ${branchRef(r.branch.project, r.branch.name)}: memory ${formatBytes(l.memoryMax)}, cpu ${l.cpuQuota}%, tasks ${l.tasksMax}${r.branch.protected ? ", protected" : ""}`,
          r.restarted ? gateText(r.restarted) : bool(values, "restart") ? "no release to restart yet" : "applies at the next start (pass --restart to restart now)",
        ],
      };
    },
  },
  ...(["start", "restart"] as const).map(
    (name): Spec => ({
      path: ["branch", name],
      args: "<project>/<branch>",
      summary: name === "start" ? "Start the branch's release (and at every boot) and wait until it is healthy" : "Restart with a new generation (drain, start) and wait until it is healthy",
      positionals: [1, 1],
      ref: true,
      async run({ ctx, args }) {
        const t = target(args);
        const r = name === "start" ? await ops.start(ctx, t) : await ops.restart(ctx, t);
        return { json: r, ok: r.gate.ok, text: [`${branchRef(t.project, t.branch)} ${gateText(r.gate, name)}`] };
      },
    }),
  ),
  {
    path: ["branch", "stop"],
    args: "<project>/<branch>",
    summary: "Stop the branch and keep it stopped, also across reboots",
    positionals: [1, 1],
    ref: true,
    flags: { confirm: CONFIRM },
    async run({ ctx, values, args }) {
      const t = target(args);
      const r = await ops.stop(ctx, { ...t, ...(str(values, "confirm") !== undefined ? { confirm: str(values, "confirm") } : {}) });
      return { json: r, text: [`Stopped ${branchRef(t.project, t.branch)}; start it with incibase branch start`] };
    },
  },
  {
    path: ["branch", "delete"],
    args: "<project>/<branch>",
    summary: "Delete a branch: units, user, files (a prod branch's data is kept in trash for 7 days)",
    positionals: [1, 1],
    ref: true,
    flags: { confirm: CONFIRM },
    details: "Protected and production branches need --confirm with their hostname.",
    async run({ ctx, values, args }) {
      const t = target(args);
      const r = await ops.deleteBranch(ctx, { ...t, ...(str(values, "confirm") !== undefined ? { confirm: str(values, "confirm") } : {}) });
      return { json: r, text: [`Deleted ${branchRef(t.project, t.branch)}${r.kind === "prod" ? `; its data stays in ${ctx.layout.trash} for 7 days` : ""}`] };
    },
  },
  {
    path: ["branch", "upgrade"],
    args: "<project>/<branch>",
    summary: "Pin another installed runtime: snapshot, preflight, restart and the gate; reverted when it fails",
    positionals: [1, 1],
    ref: true,
    flags: { runtime: { type: "string", value: "<x.y.z>", help: "The installed runtime to run (required; see host runtimes)" } },
    check(values) {
      if (!str(values, "runtime")) throw new UsageError("--runtime is required");
    },
    async run({ ctx, values, args }) {
      const t = target(args);
      const runtime = str(values, "runtime");
      if (!runtime) throw new UsageError("--runtime is required");
      const r = await ops.upgradeBranch(ctx, { ...t, runtimeVersion: runtime });
      return {
        json: r,
        ok: r.ok,
        text: [r.ok ? `${branchRef(t.project, t.branch)} runs runtime ${r.branch.runtime_version}` : `Upgrade of ${branchRef(t.project, t.branch)} to ${runtime} FAILED; it stays on ${r.branch.runtime_version} (see incibase logs)`],
      };
    },
  },

  // ---- releases ----------------------------------------------------------------------

  {
    path: ["release", "add"],
    args: "<project>/<branch> <app.ib|->",
    summary: "Release a bundle (incibase bundle --out app.ib; - reads it from stdin) and follow its job",
    positionals: [2, 2],
    ref: true,
    flags: {
      "allow-field-removal": { type: "boolean", help: "Let the migration delete the data of fields removed from the schema" },
      "no-preflight": { type: "boolean", help: "Skip the preflight on a copy of the data" },
      preflight: { type: "boolean", help: "Run a preflight even where it is off by default (dev, preview)" },
    },
    details:
      "From your laptop, copy the bundle and release it:\n" +
      "  scp app.ib vps: && ssh -t vps sudo incibase release add shop/prod app.ib\n" +
      "or stream it (needs passwordless sudo: with stdin redirected, ssh gives sudo no terminal to ask on):\n" +
      "  ssh vps sudo incibase release add shop/prod - < app.ib",
    check(values) {
      if (bool(values, "preflight") && bool(values, "no-preflight")) throw new UsageError("Pass --preflight or --no-preflight, not both");
    },
    async run({ ctx, values, args, io }) {
      const t = target(args);
      if (bool(values, "preflight") && bool(values, "no-preflight")) throw new UsageError("Pass --preflight or --no-preflight, not both");
      const preflight = bool(values, "preflight") ? true : bool(values, "no-preflight") ? false : undefined;
      let file = args[1]!;
      let temp: string | null = null;
      if (file === "-") {
        const bytes = await io.readStdin(MAX_BUNDLE_BYTES);
        if (!bytes.byteLength) throw new OpError("INVALID", "stdin is empty: pipe the bundle in, e.g. < app.ib");
        temp = mkdtempSync(join(tmpdir(), "incibase-release-"));
        file = join(temp, "app.ib");
        writeFileSync(file, bytes, { mode: 0o600 });
      } else file = resolve(file);
      try {
        const r = await ops.addRelease(ctx, { ...t, file, allowFieldRemoval: bool(values, "allow-field-removal"), ...(preflight !== undefined ? { preflight } : {}), ...(temp ? { origin: "cli:stdin" } : {}) });
        const ok = r.release.status === "live";
        return {
          json: { ...r, release: releaseOut(r.release) },
          ok,
          notes: ok ? missingNote(missingEnv(ctx, r.branch)) : [],
          text: [
            ok
              ? `Release ${r.release.seq} of ${branchRef(t.project, t.branch)} is live (generation ${clean(r.release.generation)})`
              : `Release ${r.release.seq} of ${branchRef(t.project, t.branch)} is ${r.release.status}: ${clean(r.release.error)}`,
          ],
        };
      } finally {
        if (temp) rmSync(temp, { recursive: true, force: true });
      }
    },
  },
  {
    path: ["release", "list"],
    args: "<project>/<branch>",
    summary: "The branch's releases, newest first; * is the one it runs",
    positionals: [1, 1],
    ref: true,
    async run({ ctx, args }) {
      const r = await ops.listReleases(ctx, target(args));
      return {
        json: r,
        text: r.length
          ? table(
              ["SEQ", "STATUS", "CREATED", "SHA256", "SIZE", "ORIGIN", "ERROR"],
              r.map((x) => [`${x.seq}${x.current ? "*" : ""}`, x.status, formatTime(x.created_at), x.sha256.slice(0, 12), formatBytes(x.bytes), x.origin, x.error ?? ""]),
            )
          : ["No releases yet"],
      };
    },
  },
  {
    path: ["release", "rollback"],
    args: "<project>/<branch>",
    summary: "Go back to an earlier release (default the last good one before the current)",
    positionals: [1, 1],
    ref: true,
    flags: {
      to: { type: "string", value: "<seq>", help: "The release to run" },
      restore: { type: "boolean", help: "Also put back the snapshot taken before the current release (writes since are lost)" },
      snapshot: { type: "string", value: "<name>", help: "Put back this snapshot instead, e.g. pre-7" },
      confirm: CONFIRM,
    },
    check: (values) => void int("to", str(values, "to"), 1, 1_000_000_000),
    async run({ ctx, values, args }) {
      const t = target(args);
      const to = int("to", str(values, "to"), 1, 1_000_000_000);
      let restore = str(values, "snapshot");
      if (restore === undefined && bool(values, "restore")) {
        const branch = branchOf(ctx, args);
        if (branch.release_seq === null) throw new OpError("NOT_FOUND", `${branchRef(t.project, t.branch)} has no release, so no snapshot before one`);
        restore = `pre-${branch.release_seq}`;
      }
      const r = await ops.rollback(ctx, { ...t, ...(to !== undefined ? { to } : {}), ...(restore ? { restore } : {}), ...(str(values, "confirm") !== undefined ? { confirm: str(values, "confirm") } : {}) });
      return {
        json: r,
        ok: r.ok,
        text: [r.ok ? `${branchRef(t.project, t.branch)} runs release ${r.to}${restore ? ` with the data of ${restore}` : ""}` : `Rollback of ${branchRef(t.project, t.branch)} to ${r.to} FAILED (see the lines above and incibase logs)`],
      };
    },
  },

  // ---- env ---------------------------------------------------------------------------

  {
    path: ["env", "list"],
    args: "<project>/<branch>",
    summary: "The branch's variables (host ones are set by incibase)",
    positionals: [1, 1],
    ref: true,
    flags: { show: { type: "boolean", help: "Also print the values of the app's variables (audited)" } },
    async run({ ctx, values, args }) {
      const show = bool(values, "show");
      const r = await ops.envList(ctx, { ...target(args), show });
      const rows = show ? r.map((e) => ({ ...e, value: e.system ? undefined : e.value })) : r;
      return {
        json: rows,
        notes: missingNote(missingEnv(ctx, branchOf(ctx, args))),
        text: table(show ? ["NAME", "SET BY", "VALUE"] : ["NAME", "SET BY"], rows.map((e) => [e.name, e.system ? "host" : "app", ...(show ? [e.system ? "(hidden)" : (e.value ?? "")] : [])])),
      };
    },
  },
  {
    path: ["env", "set"],
    args: "<project>/<branch> NAME=VALUE...",
    summary: "Set app variables; they reach the branch at its next start (--restart for now)",
    positionals: [2, 201],
    ref: true,
    flags: { restart: RESTART, "shared-s3-credentials": { type: "boolean", help: "Allow an S3_ACCESS_KEY_ID another branch uses" } },
    details:
      "Values may not contain newlines; encode multi-line values (PEM keys), e.g. in base64.\n" +
      "For secrets use env import <project>/<branch> - (stdin), e.g. ssh vps sudo incibase env import shop/prod - < prod.env:\n" +
      "a value on this command line is in sudo's log (auth.log, the journal) and in ps for every account.",
    check: (_values, args) => void assignments(args.slice(1)),
    async run({ ctx, values, args }) {
      const t = target(args);
      const r = await ops.envSet(ctx, { ...t, vars: assignments(args.slice(1)), restart: bool(values, "restart"), sharedS3Credentials: bool(values, "shared-s3-credentials") });
      return {
        json: r,
        ok: r.restarted ? r.restarted.ok : true,
        text: [`Set ${r.names.join(", ")} on ${branchRef(t.project, t.branch)}`, r.restarted ? gateText(r.restarted) : "applies at the next start (pass --restart to restart now)"],
      };
    },
  },
  {
    path: ["env", "unset"],
    args: "<project>/<branch> NAME...",
    summary: "Remove app variables",
    positionals: [2, 201],
    ref: true,
    flags: { restart: RESTART },
    async run({ ctx, values, args }) {
      const t = target(args);
      const r = await ops.envUnset(ctx, { ...t, names: args.slice(1), restart: bool(values, "restart") });
      return {
        json: r,
        ok: r.restarted ? r.restarted.ok : true,
        notes: missingNote(missingEnv(ctx, branchOf(ctx, args))),
        text: [r.removed.length ? `Removed ${r.removed.join(", ")} from ${branchRef(t.project, t.branch)}` : "None of them was set", r.restarted ? gateText(r.restarted) : r.removed.length ? "applies at the next start (pass --restart to restart now)" : ""].filter(Boolean),
      };
    },
  },
  {
    path: ["env", "import"],
    args: "<project>/<branch> <file|->",
    summary: "Set the variables of a .env file (KEY=VALUE lines; - reads stdin)",
    positionals: [2, 2],
    ref: true,
    flags: { restart: RESTART, "shared-s3-credentials": { type: "boolean", help: "Allow an S3_ACCESS_KEY_ID another branch uses" } },
    details: "Blank lines and # comments are skipped; values may be quoted. Multi-line values are refused.",
    async run({ ctx, values, args, io }) {
      const t = target(args);
      const bytes = await input(io, args[1]!, 1024 * 1024);
      const vars = parseEnvImport(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
      const r = await ops.envSet(ctx, { ...t, vars, restart: bool(values, "restart"), sharedS3Credentials: bool(values, "shared-s3-credentials") });
      return {
        json: { ...r, missing: missingEnv(ctx, branchOf(ctx, args)) },
        ok: r.restarted ? r.restarted.ok : true,
        notes: missingNote(missingEnv(ctx, branchOf(ctx, args))),
        text: [`Imported ${r.names.length} variable(s) into ${branchRef(t.project, t.branch)}: ${r.names.join(", ")}`, r.restarted ? gateText(r.restarted) : "applies at the next start (pass --restart to restart now)"],
      };
    },
  },

  // ---- keys --------------------------------------------------------------------------

  {
    path: ["admin-key"],
    args: "<project>/<branch>",
    summary: "Print a hosted branch's admin key (for the dashboard and MCP over incibase tunnel)",
    positionals: [1, 1],
    ref: true,
    flags: { rotate: { type: "boolean", help: "Make a new key and restart the branch (ends admin sessions)" } },
    details:
      "From your laptop: ssh <host> sudo incibase admin-key shop/prod\n" +
      "incibase admin-key --data <dir> (no <project>/<branch>) still prints a local app's key.",
    async run({ ctx, values, args }) {
      const r = await ops.adminKey(ctx, { ...target(args), rotate: bool(values, "rotate") });
      return {
        json: r,
        ok: r.restarted ? r.restarted.ok : true,
        text: [r.key],
        notes: bool(values, "rotate") ? [r.restarted ? gateText(r.restarted) : "rotated; the branch reads it at its next start"] : [],
      };
    },
  },
  {
    path: ["service-key", "create"],
    args: "<project>/<branch>",
    summary: "A key your servers call one branch with; printed once, only its sha256 is kept",
    positionals: [1, 1],
    ref: true,
    flags: {
      label: { type: "string", value: "<text>", help: "What it is for (required)" },
      scopes: { type: "string", value: "<a,b>", help: "internal, impersonate, upload (default internal)" },
    },
    check(values) {
      if (!str(values, "label")) throw new UsageError("--label is required");
    },
    async run({ ctx, values, args }) {
      const t = target(args);
      const label = str(values, "label");
      if (!label) throw new UsageError("--label is required");
      const scopes = str(values, "scopes")?.split(",").map((s) => s.trim()).filter(Boolean);
      const r = await ops.serviceKeyCreate(ctx, { ...t, label, ...(scopes ? { scopes: scopes as ("internal" | "impersonate" | "upload")[] } : {}) });
      return {
        json: r,
        text: [r.key],
        notes: [
          `Created service key ${r.id} for ${branchRef(t.project, t.branch)}; store it now, it is not shown again`,
          ...(r.reloaded === false ? ["warning: the branch did not confirm it reloaded its keys; restart it: incibase branch restart"] : []),
        ],
      };
    },
  },
  {
    path: ["service-key", "list"],
    args: "<project>/<branch>",
    summary: "The branch's service keys (never the keys themselves)",
    positionals: [1, 1],
    ref: true,
    async run({ ctx, args }) {
      const r = await ops.serviceKeyList(ctx, target(args));
      return {
        json: r,
        text: r.length ? table(["ID", "LABEL", "SCOPES", "CREATED", "REVOKED"], r.map((k) => [k.id, k.label, k.scopes.join(","), formatTime(k.created_at), formatTime(k.revoked_at)])) : ["No service keys"],
      };
    },
  },
  {
    path: ["service-key", "revoke"],
    args: "<project>/<branch> <id>",
    summary: "Revoke a service key; the branch reloads its keys at once",
    positionals: [2, 2],
    ref: true,
    check(_values, args) {
      if (!SERVICE_KEY_ID.test(args[1]!)) throw new OpError("INVALID", `${JSON.stringify(args[1])} is not a service key id such as k3fq9a1c7e`);
    },
    async run({ ctx, args }) {
      const t = target(args);
      const id = args[1]!;
      const keys = await ops.serviceKeyList(ctx, t);
      if (!SERVICE_KEY_ID.test(id)) throw new OpError("INVALID", `${JSON.stringify(id)} is not a service key id such as k3fq9a1c7e`);
      if (!keys.some((k) => k.id === id)) throw new OpError("NOT_FOUND", `No service key ${id} on ${branchRef(t.project, t.branch)}`);
      const r = await ops.serviceKeyRevoke(ctx, { id });
      return {
        json: r,
        ok: r.reloaded !== false,
        text: [
          r.reloaded === false
            ? `Revoked ${id}, but the branch did not confirm it reloaded its keys: restart it (incibase branch restart ${branchRef(t.project, t.branch)})`
            : `Revoked ${id}${r.reloaded ? "; the branch no longer accepts it" : "; the branch is not running"}`,
        ],
      };
    },
  },

  // ---- status and logs -----------------------------------------------------------------

  {
    path: ["status"],
    args: "[<project>[/<branch>]]",
    summary: "Every branch: desired vs actual state, release, generation, memory; and the firing alerts",
    positionals: [0, 1],
    check: (_values, args) => void (args[0] === undefined || (args[0].includes("/") ? target(args) : checkProjectSlug(args[0]))),
    async run({ ctx, args }) {
      const filter = args[0] === undefined ? {} : args[0].includes("/") ? target(args) : { project: checkProjectSlug(args[0]) };
      const r = await ops.status(ctx, filter);
      return {
        json: r,
        text: [
          ...(r.branches.length
            ? table(
                ["BRANCH", "KIND", "DESIRED", "ACTUAL", "RELEASE", "GENERATION", "MEMORY", "URL"],
                r.branches.map((b) => [
                  b.busy ? `${b.ref} (busy)` : b.ref,
                  b.kind,
                  b.desired,
                  `${b.actual.activeState}/${b.actual.subState}`,
                  b.release === null ? "-" : `${b.release} ${b.releaseStatus}`,
                  b.generation ?? "-",
                  `${formatBytes(b.actual.memoryCurrent)}/${formatBytes(b.limits.memoryMax)}`,
                  b.url ?? b.label,
                ]),
              )
            : ["No branches"]),
          ...alertLines(r.alerts),
        ],
      };
    },
  },
  {
    path: ["logs"],
    args: "<project>/<branch>",
    summary: "The branch's log from the journal",
    positionals: [1, 1],
    ref: true,
    flags: {
      follow: { type: "boolean", short: "f", help: "Keep printing new lines" },
      errors: { type: "boolean", help: "Only error lines" },
      since: { type: "string", value: "<time>", help: 'From this time, e.g. "1 hour ago", 2026-10-23 12:00, today' },
      lines: { type: "string", value: "<n>", help: "The last n lines" },
    },
    details: "--json prints the journal entries as JSON (journalctl --output json).",
    check: (values) => void int("lines", str(values, "lines"), 1, 100_000),
    async run({ ctx, values, args, io, json }) {
      const lines = int("lines", str(values, "lines"), 1, 100_000);
      const since = str(values, "since");
      const r = await ops.logs(ctx, {
        ...target(args),
        follow: bool(values, "follow"),
        errors: bool(values, "errors"),
        json,
        ...(lines !== undefined ? { lines } : {}),
        ...(since !== undefined ? { since } : {}),
      });
      // The lines are the tenant's: printed without control characters (escape sequences
      // that would retitle, clear or write the clipboard of root's terminal); tabs stay.
      const { code, stderr } = await io.exec(r.command, (line) => io.out(printable(line, MAX_LINE)));
      const said = stderr.trim();
      if (since !== undefined && /Failed to parse timestamp/.test(said)) throw new UsageError(`--since: journalctl cannot read ${JSON.stringify(since)}; e.g. "1 hour ago", "2026-10-23 12:00", today`);
      for (const line of said ? said.split("\n") : []) io.err(printable(line, 1000));
      // journalctl --grep exits 1, silently, when nothing matched; any other failure says why on stderr.
      return { json: undefined, ok: code === 0 || (code === 1 && bool(values, "errors") && !said) };
    },
  },
];

/** Groups and their one-line descriptions, for help. */
const GROUPS: Record<string, string> = {
  host: "The machine: init, admins, render, status, doctor, check, gc, runtimes, settings",
  project: "Projects: create, list, delete",
  branch: "Branches: create, list, info, set, start, stop, restart, delete, upgrade",
  release: "Releases: add, list, rollback",
  env: "A branch's variables: list, set, unset, import",
  "service-key": "Keys for your servers: create, list, revoke",
};

const flagsOf = (spec: Spec) => ({ ...(spec.flags ?? {}), ...COMMON });

function usageLine(spec: Spec): string {
  const flags = Object.entries(spec.flags ?? {}).map(([name, f]) => `[--${name}${f.value ? ` ${f.value}` : ""}]`);
  return `incibase ${spec.path.join(" ")}${spec.args ? ` ${spec.args}` : ""}${flags.length ? ` ${flags.join(" ")}` : ""}`;
}

export function commandHelp(spec: Spec): string {
  const lines = [`Usage: ${spec.local ? "" : "sudo "}incibase ${spec.path.join(" ")}${spec.args ? ` ${spec.args}` : ""} [flags]`, "", spec.summary, "", "Flags:"];
  for (const [name, f] of Object.entries(flagsOf(spec))) {
    const left = `  ${f.short ? `-${f.short}, ` : ""}--${name}${f.value ? ` ${f.value}` : ""}`;
    lines.push(left.length < 30 ? `${left.padEnd(30)}${f.help}` : `${left}\n${" ".repeat(30)}${f.help}`);
  }
  if (spec.details) lines.push("", spec.details);
  return lines.join("\n");
}

/** `incibase host --help`, `incibase branch --help`, or every group. */
export function groupHelp(group?: string): string {
  const specs = SPECS.filter((s) => (group ? s.path[0] === group : true));
  const lines = [group ? `Usage (on the server, as root): sudo incibase ${group} <command> ...` : "Hosting commands (on the server, as root):", ""];
  for (const s of specs) lines.push(`  ${usageLine(s)}`, `      ${s.summary}`);
  if (group === "host") {
    lines.push(`  incibase host op <name> [<json input>] [--root <dir>] [--layout <json>]`, `      Runs an owner operation with JSON input: ${Object.keys(ops.OPS).join(", ")}`);
  }
  lines.push("", "Every command takes --root <dir>, --json and --help; exit codes: 0 done, 1 failed, 2 usage.");
  if (!group) lines.push("On your laptop: incibase tunnel <project>/<branch> --ssh <user@host> (see incibase tunnel --help).");
  return lines.join("\n");
}

export const COMMAND_NAMES = new Set(SPECS.map((s) => s.path[0]!));

function findSpec(argv: string[]): { spec: Spec; rest: string[] } | null {
  for (const spec of SPECS) {
    if (spec.path.every((p, i) => argv[i] === p)) return { spec, rest: argv.slice(spec.path.length) };
  }
  return null;
}

/** Whether `err` is the caller's mistake (exit 2) rather than a failure. */
function isUsage(err: unknown): boolean {
  if (err instanceof UsageError || err instanceof NameError) return true;
  if (err instanceof OpError) return err.code === "INVALID";
  return err instanceof TypeError && String((err as { code?: string }).code ?? "").startsWith("ERR_PARSE_ARGS");
}

/**
 * Runs one command line (`argv` without "incibase", e.g. ["branch",
 * "create", "shop/dev"]) and returns its exit code.
 */
export async function runCommand(argv: string[], io: CommandIO = processIO): Promise<number> {
  const json = argv.includes("--json");
  const found = findSpec(argv);
  if (!found) {
    const group = argv[0] && argv[0] in GROUPS ? argv[0] : undefined;
    const sub = group ? argv[1] : argv[0];
    if (sub === undefined || sub === "--help" || sub === "-h" || sub === "help") {
      io.out(groupHelp(group));
      return EXIT.OK;
    }
    io.err(`incibase: unknown command ${JSON.stringify([group, sub].filter(Boolean).join(" "))}`);
    io.err(groupHelp(group));
    return EXIT.USAGE;
  }
  const { spec, rest } = found;
  let opened: OpenedHost | null = null;
  try {
    if (spec.path[0] === "admin-key" && rest.some((a) => a === "--data" || a.startsWith("--data="))) {
      throw new UsageError("Pass either <project>/<branch> (a hosted branch, as root) or --data <dir> (a local app), not both");
    }
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, strict: true, options: flagsOf(spec) as never });
    const v = values as Values;
    if (v.help) {
      io.out(commandHelp(spec));
      return EXIT.OK;
    }
    const [min, max] = spec.positionals;
    if (positionals.length < min || positionals.length > max) {
      throw new UsageError(`${spec.path.join(" ")} takes ${spec.args || "no arguments"}${positionals.length > max ? `; unexpected ${JSON.stringify(positionals[max])}` : ""}`);
    }
    if (spec.ref) parseBranchRef(positionals[0]!);
    // The command line alone first: a usage error is exit 2 whoever runs it, and touches no host.
    spec.check?.(v, positionals);
    const layout = spec.layout?.(v);
    const root = (v.root as string | undefined) ?? io.env.INCIBASE_HOST_ROOT ?? DEFAULT_ROOT;
    if (!spec.local && !io.isRoot()) {
      throw new OpError("FAILED", `incibase ${spec.path.join(" ")} runs on the server as root: sudo incibase ${spec.path.join(" ")} ...`);
    }
    opened = io.open({ root, layout, create: spec.path.join(" ") === "host init" });
    const ctx = opened.ctx;
    // Progress (release jobs, gates): stdout for people, stderr under --json.
    ctx.log = json ? io.err : io.out;
    const outcome = await spec.run({ ctx, values: v, args: positionals, io, json, root });
    if (outcome.json !== undefined) {
      if (json) io.out(JSON.stringify(outcome.json, null, 2));
      else for (const line of outcome.text ?? []) io.out(line);
    }
    for (const note of outcome.notes ?? []) io.err(note);
    return outcome.ok === false ? EXIT.FAILED : EXIT.OK;
  } catch (err) {
    const usage = isUsage(err);
    const message = printable((err as Error)?.message ?? String(err), 1000);
    const code = err instanceof OpError ? err.code : usage ? "USAGE" : "FAILED";
    if (json) io.err(JSON.stringify({ error: { code, message } }));
    else io.err(`incibase ${spec.path.join(" ")}: ${message}`);
    if (usage && !json && (err instanceof UsageError || err instanceof TypeError)) io.err(`Usage: ${usageLine(spec)}  (see --help)`);
    return usage ? EXIT.USAGE : EXIT.FAILED;
  } finally {
    opened?.close();
  }
}
