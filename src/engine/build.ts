import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { BunPlugin } from "bun";
import { buildDashboardHtml } from "./dashboard.ts";
import { embeddedRuntime } from "./embedded.ts";
import { discoverModules } from "./loader.ts";
import { VERSION } from "./version.ts";

export const IS_COMPILED = import.meta.path.includes("$bunfs") || import.meta.path.includes("~BUN");

type FrameworkModule = "index" | "server" | "client" | "cli" | "zod" | "dashboard";

/** Absolute paths of the framework entry points to bundle user apps against. */
async function frameworkPaths(): Promise<Record<FrameworkModule, string>> {
  if (!IS_COMPILED) {
    const src = resolve(import.meta.dir, "..");
    return {
      index: join(src, "index.ts"),
      server: join(src, "server.ts"),
      client: join(src, "client.ts"),
      cli: join(src, "cli.ts"),
      zod: Bun.resolveSync("zod", src),
      dashboard: "",
    };
  }
  // Standalone binary: unpack the embedded runtime bundle, once per content hash.
  if (!embeddedRuntime["cli.js"]) throw new Error("This binary was built without the embedded runtime");
  const files = await Promise.all(
    Object.entries(embeddedRuntime).map(async ([name, path]) => [name, await Bun.file(path).bytes()] as const),
  );
  const hash = Bun.hash(files.map(([name, bytes]) => `${name}:${Bun.hash(bytes)}`).join("|")).toString(36);
  const dir = join(tmpdir(), `incibase-runtime-${VERSION}-${hash}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of files) {
    const target = join(dir, name);
    if (!(await Bun.file(target).exists())) await Bun.write(target, bytes);
  }
  return {
    index: join(dir, "index.js"),
    server: join(dir, "server.js"),
    client: join(dir, "client.js"),
    cli: join(dir, "cli.js"),
    zod: join(dir, "zod.js"),
    dashboard: join(dir, "dashboard.html"),
  };
}

function aliasPlugin(paths: Record<FrameworkModule, string>): BunPlugin {
  const map: Record<string, string> = {
    incibase: paths.index,
    "incibase/server": paths.server,
    "incibase/client": paths.client,
    zod: paths.zod,
    "zod/v4": paths.zod,
  };
  return {
    name: "incibase-aliases",
    setup(build) {
      build.onResolve({ filter: /^(incibase(\/(server|client))?|zod(\/v4)?)$/ }, (args) => ({ path: map[args.path]! }));
    },
  };
}

function isCrossTarget(target: string | undefined): boolean {
  if (!target) return false;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return !target.startsWith(`bun-${process.platform}-${arch}`);
}

/**
 * A standalone binary cannot be the base of another compiled executable on
 * the same platform (Bun 1.4 fails with "Error writing standalone module
 * graph: InvalidObject" once the embedded graph passes ~16 KB), so host builds
 * from the standalone binary use an installed `bun` instead. Cross-platform
 * targets are unaffected because Bun downloads a clean runtime for them.
 */
function cleanBunExecutable(): string {
  const bun = Bun.which("bun");
  if (!bun) {
    throw new Error(
      "Building for this platform from the standalone binary needs `bun` on PATH (https://bun.sh). " +
        "Alternatively pass --target for another platform, e.g. --target bun-linux-x64.",
    );
  }
  return bun;
}

export interface BuildOptions {
  dir: string;
  outfile: string;
  /** Bun compile target, e.g. `bun-linux-x64`. Defaults to the current platform. */
  target?: string;
  minify?: boolean;
}

/** Compiles the app in `dir` together with the framework into one executable. */
export async function buildApp(options: BuildOptions): Promise<void> {
  const dir = resolve(options.dir);
  const { modules, schemaFile, skipped } = discoverModules(dir);
  if (skipped.length) console.warn(`[incibase] skipping: ${skipped.join(", ")}`);
  const paths = await frameworkPaths();

  const work = join(tmpdir(), `incibase-build-${process.pid}-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  const entry = join(work, "entry.ts");
  const dashboard = join(work, "dashboard.html");
  writeFileSync(dashboard, paths.dashboard ? await Bun.file(paths.dashboard).text() : await buildDashboardHtml());
  // Dynamic imports, so an app module that throws on import fails `serve` with its exit code
  // instead of killing the process before the CLI runs.
  writeFileSync(
    entry,
    [
      `import { runCli } from ${JSON.stringify(paths.cli)};`,
      `import dashboardHtml from "./dashboard.html" with { type: "text" };`,
      `await runCli(process.argv.slice(2), {`,
      `  embedded: {`,
      ...(schemaFile ? [`    schemaFile: ${JSON.stringify(relative(dir, schemaFile))},`] : []),
      `    load: async () => ({`,
      ...(schemaFile ? [`      schema: await import(${JSON.stringify(schemaFile)}),`] : []),
      `      modules: {`,
      ...modules.map((m) => `        ${JSON.stringify(m.modulePath)}: await import(${JSON.stringify(m.absolutePath)}),`),
      `      },`,
      `    }),`,
      `  },`,
      `  dashboardHtml,`,
      `});`,
      ``,
    ].join("\n"),
  );

  try {
    const result = await Bun.build({
      entrypoints: [entry],
      compile: {
        outfile: resolve(options.outfile),
        ...(options.target ? { target: options.target as any } : {}),
        ...(IS_COMPILED && !isCrossTarget(options.target) ? { executablePath: cleanBunExecutable() } : {}),
      },
      minify: options.minify ?? true,
      plugins: [aliasPlugin(paths)],
    });
    if (!result.success) {
      throw new Error(`Build failed:\n${result.logs.map(String).join("\n")}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
