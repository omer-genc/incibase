#!/usr/bin/env bun
import { watch, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildApp, IS_COMPILED } from "./engine/build.ts";
import { bundleApp, loadAppFromBundle } from "./engine/bundle.ts";
import { codegen, writeIfChanged } from "./engine/codegen.ts";
import { setEmbeddedDashboard } from "./engine/dashboard.ts";
import { describeApp } from "./engine/describe.ts";
import { drain, parseDrainTimeout, stopSignals } from "./engine/drain.ts";
import { embeddedRuntime } from "./engine/embedded.ts";
import { Engine, type AppDefinition } from "./engine/engine.ts";
import { ConfigError, DefinitionError, describeExit, exitCodeOf, ExitCode } from "./engine/exit-codes.ts";
import { listenError, maxJsonBytesFromEnv } from "./engine/http.ts";
import { checkListenFlags, startListeners, type Listeners } from "./engine/listeners.ts";
import { loadAppFromDir, schemaOf } from "./engine/loader.ts";
import { verifyBundle } from "./engine/manifest.ts";
import { color, isJson, logEvent, parseLogFormat, setLogFormat, stripQuery } from "./engine/log.ts";
import { MigrationError } from "./engine/migrate.ts";
import { finishMigrateOnly } from "./engine/preflight.ts";
import { handleReloads, serviceKeysFromEnv, type ReloadTarget } from "./engine/service-keys.ts";
import { checkHostedSecrets, corsOriginsFromEnv } from "./engine/surface.ts";
import { DataDirLockedError, readMeta } from "./engine/store.ts";
import { parseTimeouts, type Timeouts } from "./engine/timeouts.ts";
import { VERSION } from "./engine/version.ts";

const HELP = `incibase ${VERSION} — Zod-typed backend in one binary

Usage: incibase <command> [options]

Commands:
  dev         Run with hot reload and type generation
  serve       Run the server (default for built apps)
  codegen     Generate <dir>/_generated types
  build       Compile the app into a single executable
  bundle      Bundle the app into one release file (app.ib); runs its top-level code once
  init        Create a starter <dir>
  admin-key   Print the admin key

Options:
  --dir <path>      Backend source directory (default: incibase)
  --data <path>     Data directory (default: incibase_data)
  --port <n>        HTTP port (default: $PORT or 3210)
  --host <name>     Hostname to bind (default: 0.0.0.0 for serve, localhost for dev)
  --url <url>       Public base URL (default: http://localhost:<port>)
  --outfile <path>  Output for build (default: ./app)
  --target <t>      Build target, e.g. bun-linux-x64 (default: this machine)
  --out <path>      Output for bundle (default: app.ib)
  --check           bundle: verify the bundle at --out without running it
  --bundle <file>   serve: load the app from a bundle instead of --dir
  --no-dashboard    Do not serve the admin dashboard at /_/
  --socket <path>   Listen on this unix socket instead of --port/--host,
                    behind a proxy (serve; needs --url)
  --admin-socket <path>
                    Serve the dashboard and admin API only on this unix
                    socket, for localhost names (an SSH tunnel); the main
                    listener then refuses the admin key. Needs
                    INCIBASE_ADMIN_KEY and INCIBASE_STORAGE_SECRET (serve)
  --log-format <f>  text (default) or json: one JSON object per line on
                    stdout (serve, dev; default: $INCIBASE_LOG_FORMAT)
  --allow-field-removal
                    Let a migration delete the stored data of fields removed
                    from the schema (serve, dev); otherwise it is refused.
                    dev drops it once a server has started
  --timeouts <spec> Deadlines per call type, e.g.
                    query=10s,mutation=10s,action=120s,http=120s (units ms,
                    s, m). A call past its deadline is rolled back and gets
                    504 FUNCTION_TIMEOUT (serve, dev; default:
                    $INCIBASE_TIMEOUTS, otherwise none)
  --drain-timeout <s>
                    On SIGTERM or SIGINT, how long to wait for running calls
                    and jobs before cutting them (rolled back); seconds or a
                    duration such as 500ms. A second signal cuts at once
                    (serve, dev; default: 10, dev 1)
  --migrate-only    serve: start as usual, migrate the database, then exit 0
                    without listening (a preflight on a copy of the data)
`;

/** The app a built binary carries. */
export interface EmbeddedApp {
  /** The schema file's path in the app dir, for messages. */
  schemaFile?: string;
  /** Imports the app's modules, so one that throws on import fails `serve` with its exit code. */
  load: () => Promise<{ schema?: Record<string, unknown>; modules: AppDefinition["modules"] }>;
}

interface CliOptions {
  embedded?: EmbeddedApp;
  /** Pre-built dashboard HTML (built apps carry it). */
  dashboardHtml?: string;
}

function parse(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dir: { type: "string", default: "incibase" },
      data: { type: "string", default: "incibase_data" },
      port: { type: "string" },
      host: { type: "string" },
      url: { type: "string" },
      outfile: { type: "string", default: "./app" },
      target: { type: "string" },
      out: { type: "string", default: "app.ib" },
      check: { type: "boolean", default: false },
      bundle: { type: "string" },
      "no-dashboard": { type: "boolean", default: false },
      socket: { type: "string" },
      "admin-socket": { type: "string" },
      "log-format": { type: "string" },
      "allow-field-removal": { type: "boolean", default: false },
      timeouts: { type: "string" },
      "drain-timeout": { type: "string" },
      "migrate-only": { type: "boolean", default: false },
      dev: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  return { values, command: positionals[0] };
}

/** The log format `argv` asks for when it does not parse, so a bad flag still fails in the right format. */
function requestedLogFormat(argv: string[]): string | undefined {
  let format = process.env.INCIBASE_LOG_FORMAT;
  for (const [i, arg] of argv.entries()) {
    if (arg === "--") break;
    if (arg === "--log-format") format = argv[i + 1];
    else if (arg.startsWith("--log-format=")) format = arg.slice("--log-format=".length);
  }
  return format;
}

export async function runCli(argv: string[], options: CliOptions = {}) {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (err) {
    if (requestedLogFormat(argv) === "json") {
      setLogFormat("json");
      logEvent("error", { ev: "fatal", msg: (err as Error).message, exitCode: ExitCode.CONFIG, reason: describeExit(ExitCode.CONFIG) });
    } else {
      console.error(`${(err as Error).message}\n`);
      console.log(HELP);
    }
    process.exit(ExitCode.CONFIG);
  }
  const { values, command: given } = parsed;
  if (values.version) return console.log(VERSION);
  const command = given ?? (options.embedded ? "serve" : undefined);
  if (options.dashboardHtml) setEmbeddedDashboard(options.dashboardHtml);
  else if (embeddedRuntime["dashboard.html"]) setEmbeddedDashboard(await Bun.file(embeddedRuntime["dashboard.html"]).text());
  if (values.help || !command) return console.log(HELP);

  if (options.embedded && !["serve", "start", "admin-key"].includes(command)) {
    console.error(`"${command}" is not available in a built app. Use: serve, admin-key`);
    process.exit(ExitCode.CONFIG);
  }

  if (["serve", "start", "dev"].includes(command)) {
    try {
      setLogFormat(parseLogFormat(values["log-format"]));
    } catch (err) {
      exitOnStartError(err);
    }
  }

  if (values.bundle !== undefined) {
    // --dir has a default, so only the flag itself tells that both were asked for.
    const dirGiven = argv.some((a) => a === "--dir" || a.startsWith("--dir="));
    const conflict = !["serve", "start"].includes(command)
      ? `--bundle is for serve, not ${command}`
      : options.embedded
        ? "--bundle cannot be used with a built app"
        : dirGiven
          ? "Pass either --bundle or --dir, not both"
          : null;
    if (conflict) exitOnStartError(new ConfigError(conflict));
  }
  if (values["migrate-only"] && !["serve", "start"].includes(command)) {
    exitOnStartError(new ConfigError(`--migrate-only is for serve, not ${command}`));
  }

  switch (command) {
    case "serve":
    case "start":
      return serve(values, options.embedded);
    case "dev":
      return dev(argv, values);
    case "codegen": {
      const { changed } = codegen(values.dir);
      return console.log(changed.length ? `Generated ${changed.join(", ")}` : "Types are up to date");
    }
    case "build":
      codegen(values.dir);
      console.log(`Building ${values.outfile} ...`);
      await buildApp({ dir: values.dir, outfile: values.outfile, target: values.target });
      return console.log(`Built ${values.outfile}. Run it with: ${values.outfile} --port 3210`);
    case "bundle":
      return bundle(values);
    case "init":
      return init(values.dir);
    case "admin-key": {
      const db = join(values.data, "data.db");
      if (!existsSync(db)) {
        console.error(`No database at ${db}; start the server once first.`);
        process.exit(1);
      }
      // Read-only and without the data dir lock: works while the server runs, and never changes the database.
      const key = process.env.INCIBASE_ADMIN_KEY ?? readMeta(db, "admin_key");
      if (!key) {
        console.error(`No admin key in ${db}; start the server once first.`);
        process.exit(1);
      }
      console.log(key);
      return;
    }
    default:
      console.error(`Unknown command "${command}"\n`);
      console.log(HELP);
      process.exit(ExitCode.CONFIG);
  }
}

type Values = ReturnType<typeof parse>["values"];

/**
 * Reports why the server could not start and exits with the code for that
 * kind of failure (see exit-codes.ts), so a supervisor restarts only the ones
 * a restart can fix.
 */
function exitOnStartError(err: unknown): never {
  const code = exitCodeOf(err);
  const message = (err as Error)?.message ?? String(err);
  if (err instanceof MigrationError) {
    fatal(err, code, [`${color.red(message)}\nFix the schema (or the data) and save again.`]);
  } else if (err instanceof DataDirLockedError || err instanceof ConfigError || (err as { code?: string })?.code === "EADDRINUSE") {
    fatal(err, code, [color.red(message)]);
  } else if (err instanceof DefinitionError) {
    // The stack is incibase's own, except for the frame in the app that made the definition.
    const frame = err.stack
      ?.split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("at ") && line.includes("/") && !line.includes(import.meta.dir));
    fatal(err, code, [`${color.red(message)}${frame ? `\n  ${frame}` : ""}`], { at: frame?.slice(3) });
  } else {
    fatal(err, code, [err], { stack: (err as Error)?.stack });
  }
  process.exit(code);
}

/** A start failure: `text` in text mode, one `fatal` line naming the exit code in json mode. */
function fatal(err: unknown, exitCode: number, text: unknown[], fields: Record<string, unknown> = {}) {
  const message = (err as Error)?.message ?? String(err);
  logEvent("error", { ev: "fatal", msg: message, exitCode, reason: describeExit(exitCode), ...fields }, text);
}

function portOf(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError(`Invalid port "${value}": use 0 to 65535`);
  return port;
}

async function loadEmbedded(embedded: EmbeddedApp): Promise<AppDefinition> {
  const { schema, modules } = await embedded.load();
  return { schema: schema ? schemaOf(schema, embedded.schemaFile ?? "schema.ts") : undefined, modules };
}

async function serve(values: Values, embedded?: EmbeddedApp) {
  // First of all: SIGHUP (a reload) would otherwise end a process that is still starting.
  const reload: ReloadTarget = {};
  if (values["admin-socket"] !== undefined || process.env.INCIBASE_SERVICE_KEYS_FILE) handleReloads(reload);
  const dev = values.dev;
  let port: number;
  let publicUrl: string;
  let engine: Engine;
  let timeouts: Timeouts;
  let drainMs: number;
  try {
    port = portOf(values.port ?? process.env.PORT ?? "3210");
    timeouts = parseTimeouts(values.timeouts);
    drainMs = parseDrainTimeout(values["drain-timeout"], dev);
    publicUrl = (values.url ?? process.env.INCIBASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, "");
    checkListenFlags({
      socket: values.socket,
      adminSocket: values["admin-socket"],
      port: values.port,
      host: values.host,
      url: values.url ?? process.env.INCIBASE_URL,
    });
    // startServer reads these too, but only after the database has migrated.
    corsOriginsFromEnv();
    maxJsonBytesFromEnv();
    if (!embedded && values.bundle === undefined && !statSync(values.dir, { throwIfNoEntry: false })?.isDirectory()) {
      throw new ConfigError(`No app directory ${values.dir}: pass --dir, or create one with: incibase init`);
    }
    if (values["admin-socket"] !== undefined) checkHostedSecrets(join(values.data, "data.db"));
    reload.keys = serviceKeysFromEnv();
    const app = embedded
      ? await loadEmbedded(embedded)
      : values.bundle !== undefined
        ? (await loadAppFromBundle(values.bundle)).app
        : await loadAppFromDir(values.dir);
    engine = new Engine(app, {
      dataDir: values.data,
      dev,
      publicUrl,
      allowFieldRemoval: values["allow-field-removal"],
      timeouts,
      serviceKeys: reload.keys,
    });
    reload.realtime = engine.realtime;
  } catch (err) {
    exitOnStartError(err);
  }

  // A bundle has no source dir to describe.
  if (dev && !embedded && values.bundle === undefined) {
    writeIfChanged(join(values.dir, "_generated", "schema.json"), JSON.stringify(describeApp(engine), null, 2) + "\n");
  }
  const m = engine.migration;
  if (isJson()) {
    const changed = [m.createdTables, m.addedIndexes, m.droppedIndexes, m.deactivatedTables, m.removedFields].some((l) => l.length);
    if (changed || m.rewrittenDocuments) {
      logEvent("info", {
        ev: "migration",
        createdTables: m.createdTables,
        addedIndexes: m.addedIndexes,
        droppedIndexes: m.droppedIndexes,
        deactivatedTables: m.deactivatedTables,
        removedFields: m.removedFields,
        rewrittenDocuments: m.rewrittenDocuments,
      });
    }
  } else {
    for (const t of m.createdTables) console.log(`+ table ${t}`);
    for (const i of m.addedIndexes) console.log(`+ index ${i}`);
    for (const i of m.droppedIndexes) console.log(`- index ${i}`);
    for (const t of m.deactivatedTables) console.log(`- table ${t} (removed from schema; data kept)`);
    for (const f of m.removedFields) console.log(`- field ${f.table}.${f.field} (data deleted from ${f.documents} document(s))`);
    if (m.rewrittenDocuments) console.log(`~ ${m.rewrittenDocuments} document(s) updated to the new schema`);
  }
  if (values["migrate-only"]) return finishMigrateOnly(engine);

  engine.start();
  const dashboard = !values["no-dashboard"];
  const hostname = values.host ?? (dev ? "localhost" : "0.0.0.0");
  let server: Listeners;
  try {
    server = await startListeners(engine, { port, hostname, dashboard, socket: values.socket, adminSocket: values["admin-socket"] });
  } catch (err) {
    await engine.stop().catch(() => {});
    // An address in use may clear up (exit 75); a host that does not resolve or a port this user may not bind will not.
    exitOnStartError(await listenError(err, hostname, port));
  }
  // Only once serving: a startup error must still exit instead of leaving a process that serves nothing.
  installCrashHandlers();

  const mcpUrl = `${publicUrl}/mcp`;
  const tableCount = [...engine.store.tables.values()].filter((t) => !t.system).length;
  if (isJson()) {
    // Never the admin key: json lines end up in a journal other people can read.
    logEvent("info", {
      ev: "ready",
      url: stripQuery(publicUrl),
      listen: server.listen,
      ...(server.admin ? { admin: values["admin-socket"] } : {}),
      version: VERSION,
      dev,
      functions: engine.functions.size,
      tables: tableCount,
      dashboard,
      data: resolve(values.data),
      ...(Object.keys(timeouts).length ? { timeouts } : {}),
      ...(process.env.INCIBASE_RESTART ? { restart: true } : {}),
    });
  } else if (process.env.INCIBASE_RESTART) {
    // Dev restarts after a file change: one line instead of the full banner.
    console.log(`${color.green("ready")} ${engine.functions.size} function(s), ${tableCount} table(s)`);
  } else {
    console.log(`
${color.bold(`incibase ${VERSION}`)}${dev ? " (dev)" : ""}  ${engine.functions.size} function(s), ${tableCount} table(s)
  API       ${publicUrl}/api${dashboard && !server.admin ? `\n  Dashboard ${publicUrl}/_/` : ""}
  Realtime  ${publicUrl.replace(/^http/, "ws")}/api/ws
  MCP       ${mcpUrl}${values.socket ? `\n  Socket    ${values.socket}` : ""}${server.admin ? `\n  Admin     ${values["admin-socket"]} (admin API, MCP admin tools${dashboard ? ", dashboard at /_/" : ""})` : ""}
  Data      ${resolve(values.data)}`);
    if (dev) {
      console.log(`  Admin key ${engine.adminKey}

  Add to Claude Code:
    claude mcp add --transport http incibase ${mcpUrl} --header "Authorization: Bearer ${engine.adminKey}"
`);
    } else {
      console.log(`  Admin key: run "${IS_COMPILED ? process.execPath : "incibase"} admin-key --data ${values.data}"\n`);
    }
  }

  const nextSignal = stopSignals();
  let forceDrain = () => {};
  const forced = new Promise<void>((resolve) => (forceDrain = resolve));
  const shutdown = async (signal: string) => {
    const next = nextSignal();
    // The same Ctrl-C twice (from the terminal and from a wrapper such as `bun run`): one stop.
    if (next === "repeat") return;
    // A second signal: stop waiting for the drain.
    if (next === "force") return forceDrain();
    // A failure here must still exit: the crash handlers would otherwise keep the process up.
    let code = 0;
    try {
      await drain(engine, server, { signal, timeoutMs: drainMs, force: forced });
      logEvent("info", { ev: "stopping", signal });
      await engine.stop();
      logEvent("info", { ev: "stopped" });
    } catch (err) {
      logEvent("error", { ev: "shutdown_failed", err }, ["[incibase] shutdown failed:", err]);
      code = 1;
    }
    process.exit(code);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

/**
 * Logs errors that escape every handler and keeps serving, for `serve` and the
 * server process of `dev`. Bun exits on them by default, so one deployed
 * function that forgets an `await` (say on ctx.runMutation) would take every
 * client down, and nothing restarts the server. Carrying on is safe: all state
 * is in SQLite, and a write that failed was rolled back with its transaction.
 */
export function installCrashHandlers() {
  process.on("unhandledRejection", (reason) => {
    const text = ["[incibase] unhandled promise rejection (a missing await?); still serving:", reason];
    logEvent("error", { ev: "unhandled_rejection", msg: "a missing await?", err: reason }, text);
  });
  process.on("uncaughtException", (err, origin) => {
    logEvent("error", { ev: "uncaught", origin, err }, [`[incibase] uncaught exception (${origin}); still serving:`, err]);
  });
}

function selfCommand(): string[] {
  return IS_COMPILED ? [process.execPath] : [process.execPath, Bun.main];
}

async function dev(argv: string[], values: Values) {
  const dir = resolve(values.dir);
  if (!existsSync(dir)) {
    console.error(`No ${values.dir}/ directory. Create one with: incibase init`);
    process.exit(1);
  }
  const childArgs = ["serve", "--dev", ...argv.filter((a) => a !== "dev" && a !== "--allow-field-removal")];
  // Only for the removal the developer started with: once a server has run
  // with it, a restart (e.g. a half-edited schema.ts) is refused again.
  let allowFieldRemoval = values["allow-field-removal"];
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let restarting: Promise<void> | null = null;
  /** Set once dev stops: the server it was running then, if any. */
  let stopping: ReturnType<typeof Bun.spawn> | null | undefined;

  let restarts = 0;
  const start = () => {
    const { changed } = codegen(dir);
    if (changed.length) logEvent("info", { ev: "codegen", files: changed }, [color.dim(`generated ${changed.join(", ")}`)]);
    child = Bun.spawn([...selfCommand(), ...childArgs, ...(allowFieldRemoval ? ["--allow-field-removal"] : [])], {
      stdio: ["inherit", "inherit", "inherit"],
      env: { ...process.env, ...(restarts++ ? { INCIBASE_RESTART: "1" } : {}) },
    });
    const current = child;
    void current.exited.then((code) => {
      if (child === current && code !== 0 && code !== null) {
        const msg = `Server stopped (${describeExit(code)}); waiting for changes...`;
        logEvent("info", { ev: "server_stopped", exitCode: code, reason: describeExit(code), msg }, [color.yellow(msg)]);
      }
    });
  };

  const restart = async () => {
    if (stopping !== undefined) return;
    const old = child;
    child = null;
    if (old) {
      // Still running means it migrated (or stops before committing); a refused one has exited.
      if (old.exitCode === null && allowFieldRemoval) {
        allowFieldRemoval = false;
        const msg = "--allow-field-removal applied to the first start only";
        logEvent("info", { ev: "notice", msg }, [color.dim(msg)]);
      }
      old.kill("SIGTERM");
      await old.exited;
    }
    // Stopped meanwhile: no new server.
    if (stopping === undefined) start();
  };

  let timer: Timer | null = null;
  watch(dir, { recursive: true }, (_event, filename) => {
    const name = String(filename ?? "");
    if (stopping !== undefined) return;
    if (name.startsWith("_generated") || name.split(/[\\/]/).some((s) => s.startsWith("."))) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const file = relative(process.cwd(), join(dir, name));
      logEvent("info", { ev: "restarting", file }, [color.dim(`${file} changed, restarting`)]);
      restarting = (restarting ?? Promise.resolve()).then(restart);
    }, 120);
  });

  const nextSignal = stopSignals();
  const stop = async (signal: NodeJS.Signals) => {
    const next = nextSignal();
    // The same Ctrl-C twice (from the terminal and from a wrapper such as `bun run`): one stop.
    if (next === "repeat") return;
    // A second signal is passed on: it cuts the server's drain short.
    if (next === "force") return void stopping?.kill("SIGTERM");
    if (timer) clearTimeout(timer);
    const current = (stopping = child);
    child = null;
    if (current) {
      // Passed on at once. When Ctrl-C reached the server too (one process group), it takes this one as a repeat.
      current.kill(signal);
      await current.exited;
    }
    // A restart under way stops its old server and starts none.
    await restarting;
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  start();
}

/** `incibase bundle`: writes the release bundle, or with --check verifies one without running it. */
async function bundle(values: Values) {
  try {
    if (values.check) {
      const { manifest } = verifyBundle(values.out);
      const { functions, tables } = manifest.app;
      console.log(
        `${values.out} is valid: incibase ${manifest.incibaseVersion}, ${functions.length} function(s), ` +
          `${Object.keys(tables).length} table(s), sha256 ${manifest.sha256}`,
      );
      return;
    }
    const manifest = await bundleApp({ dir: values.dir, out: values.out });
    const size = (Bun.file(values.out).size / 1024).toFixed(1);
    console.log(
      `Bundled ${values.out} (${size} KB): ${manifest.app.functions.length} function(s), ${Object.keys(manifest.app.tables).length} table(s)` +
        (manifest.envNames.length ? `\n  Reads env: ${manifest.envNames.join(", ")}` : ""),
    );
    // The app's top-level code ran to describe it; a timer it started must not keep this command running.
    process.exit(0);
  } catch (err) {
    console.error(color.red((err as Error)?.message ?? String(err)));
    process.exit(exitCodeOf(err));
  }
}

const STARTER_SCHEMA = `import { defineSchema, defineTable, id, z } from "incibase/server";

export default defineSchema({
  messages: defineTable({
    author: id("_users"),
    body: z.string().min(1).max(2000),
  }).index("by_author", ["author"]),
});
`;

const STARTER_MESSAGES = `import { z } from "incibase/server";
import { mutation, query } from "./_generated/server";

export const list = query({
  description: "Latest messages, newest first.",
  args: { limit: z.number().int().min(1).max(100).default(20) },
  mcp: true,
  handler: async (ctx, { limit }) => {
    return ctx.db.query("messages").order("desc").take(limit);
  },
});

export const send = mutation({
  args: { body: z.string().min(1) },
  handler: async (ctx, { body }) => {
    const user = await ctx.auth.requireUser();
    return ctx.db.insert("messages", { author: user._id, body });
  },
});
`;

function init(dirArg: string) {
  const dir = resolve(dirArg);
  if (existsSync(join(dir, "schema.ts"))) {
    console.error(`${dirArg}/schema.ts already exists`);
    process.exit(1);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "schema.ts"), STARTER_SCHEMA);
  writeFileSync(join(dir, "messages.ts"), STARTER_MESSAGES);
  codegen(dir);
  console.log(`Created ${dirArg}/schema.ts and ${dirArg}/messages.ts.
For editor types: bun add incibase zod
Then run: incibase dev`);
}

if (import.meta.main) {
  await runCli(process.argv.slice(2));
}
