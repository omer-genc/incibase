#!/usr/bin/env bun
import { watch, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildApp, IS_COMPILED } from "./engine/build.ts";
import { codegen, writeIfChanged } from "./engine/codegen.ts";
import { setEmbeddedDashboard } from "./engine/dashboard.ts";
import { describeApp } from "./engine/describe.ts";
import { embeddedRuntime } from "./engine/embedded.ts";
import { Engine, type AppDefinition } from "./engine/engine.ts";
import { startServer } from "./engine/http.ts";
import { loadAppFromDir } from "./engine/loader.ts";
import { MigrationError } from "./engine/migrate.ts";
import { Store } from "./engine/store.ts";
import { VERSION } from "./engine/version.ts";

const HELP = `incibase ${VERSION} — Zod-typed backend in one binary

Usage: incibase <command> [options]

Commands:
  dev         Run with hot reload and type generation
  serve       Run the server (default for built apps)
  codegen     Generate <dir>/_generated types
  build       Compile the app into a single executable
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
  --no-dashboard    Do not serve the admin dashboard at /_/
  --allow-field-removal
                    Let a migration delete the stored data of fields removed
                    from the schema (serve, dev); otherwise it is refused
`;

interface CliOptions {
  embedded?: AppDefinition;
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
      "no-dashboard": { type: "boolean", default: false },
      "allow-field-removal": { type: "boolean", default: false },
      dev: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  return { values, command: positionals[0] };
}

export async function runCli(argv: string[], options: CliOptions = {}) {
  const { values, command: given } = parse(argv);
  if (values.version) return console.log(VERSION);
  const command = given ?? (options.embedded ? "serve" : undefined);
  if (options.dashboardHtml) setEmbeddedDashboard(options.dashboardHtml);
  else if (embeddedRuntime["dashboard.html"]) setEmbeddedDashboard(await Bun.file(embeddedRuntime["dashboard.html"]).text());
  if (values.help || !command) return console.log(HELP);

  if (options.embedded && !["serve", "start", "admin-key"].includes(command)) {
    console.error(`"${command}" is not available in a built app. Use: serve, admin-key`);
    process.exit(1);
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
    case "init":
      return init(values.dir);
    case "admin-key": {
      const db = join(values.data, "data.db");
      if (!existsSync(db)) {
        console.error(`No database at ${db}; start the server once first.`);
        process.exit(1);
      }
      const store = new Store(db);
      console.log(process.env.INCIBASE_ADMIN_KEY ?? store.getMeta("admin_key"));
      store.close();
      return;
    }
    default:
      console.error(`Unknown command "${command}"\n`);
      console.log(HELP);
      process.exit(1);
  }
}

type Values = ReturnType<typeof parse>["values"];

async function serve(values: Values, embedded?: AppDefinition) {
  const dev = values.dev;
  const port = Number(values.port ?? process.env.PORT ?? 3210);
  const publicUrl = (values.url ?? process.env.INCIBASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, "");

  let engine: Engine;
  try {
    const app = embedded ?? (await loadAppFromDir(values.dir));
    engine = new Engine(app, { dataDir: values.data, dev, publicUrl, allowFieldRemoval: values["allow-field-removal"] });
  } catch (err) {
    if (err instanceof MigrationError) {
      console.error(`\x1b[31m${err.message}\x1b[0m\nFix the schema (or the data) and save again.`);
    } else {
      console.error(err);
    }
    process.exit(1);
  }

  if (dev && !embedded) {
    writeIfChanged(join(values.dir, "_generated", "schema.json"), JSON.stringify(describeApp(engine), null, 2) + "\n");
  }
  const m = engine.migration;
  for (const t of m.createdTables) console.log(`+ table ${t}`);
  for (const i of m.addedIndexes) console.log(`+ index ${i}`);
  for (const i of m.droppedIndexes) console.log(`- index ${i}`);
  for (const t of m.deactivatedTables) console.log(`- table ${t} (removed from schema; data kept)`);
  for (const f of m.removedFields) console.log(`- field ${f.table}.${f.field} (data deleted from ${f.documents} document(s))`);
  if (m.rewrittenDocuments) console.log(`~ ${m.rewrittenDocuments} document(s) updated to the new schema`);

  engine.start();
  const dashboard = !values["no-dashboard"];
  const server = startServer(engine, { port, hostname: values.host ?? (dev ? "localhost" : "0.0.0.0"), dashboard });

  const mcpUrl = `${publicUrl}/mcp`;
  const tableCount = [...engine.store.tables.values()].filter((t) => !t.system).length;
  if (process.env.INCIBASE_RESTART) {
    // Dev restarts after a file change: one line instead of the full banner.
    console.log(`\x1b[32mready\x1b[0m ${engine.functions.size} function(s), ${tableCount} table(s)`);
  } else {
    console.log(`
\x1b[1mincibase ${VERSION}\x1b[0m${dev ? " (dev)" : ""}  ${engine.functions.size} function(s), ${tableCount} table(s)
  API       ${publicUrl}/api${dashboard ? `\n  Dashboard ${publicUrl}/_/` : ""}
  Realtime  ${publicUrl.replace(/^http/, "ws")}/api/ws
  MCP       ${mcpUrl}
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

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    server.stop(true);
    await engine.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
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
  const childArgs = ["serve", "--dev", ...argv.filter((a) => a !== "dev")];
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let restarting: Promise<void> | null = null;

  let restarts = 0;
  const start = () => {
    const { changed } = codegen(dir);
    if (changed.length) console.log(`\x1b[2mgenerated ${changed.join(", ")}\x1b[0m`);
    child = Bun.spawn([...selfCommand(), ...childArgs], {
      stdio: ["inherit", "inherit", "inherit"],
      env: { ...process.env, ...(restarts++ ? { INCIBASE_RESTART: "1" } : {}) },
    });
    const current = child;
    void current.exited.then((code) => {
      if (child === current && code !== 0 && code !== null) console.log("\x1b[33mServer stopped; waiting for changes...\x1b[0m");
    });
  };

  const restart = async () => {
    const old = child;
    child = null;
    if (old) {
      old.kill("SIGTERM");
      await old.exited;
    }
    start();
  };

  let timer: Timer | null = null;
  watch(dir, { recursive: true }, (_event, filename) => {
    const name = String(filename ?? "");
    if (name.startsWith("_generated") || name.split(/[\\/]/).some((s) => s.startsWith("."))) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      console.log(`\x1b[2m${relative(process.cwd(), join(dir, name))} changed, restarting\x1b[0m`);
      restarting = (restarting ?? Promise.resolve()).then(restart);
    }, 120);
  });

  const stop = async () => {
    const current = child;
    child = null;
    if (current) {
      current.kill("SIGTERM");
      await current.exited;
    }
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  start();
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
