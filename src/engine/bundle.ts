// Release bundles (`app.ib`): the app's modules and its npm dependencies in
// one ESM file, with incibase and zod left as imports that resolve to the
// framework copy of the process that loads it (see installModuleAliases).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type { BunPlugin } from "bun";
import { codegen } from "./codegen.ts";
import { checkDefinitions, type AppDefinition } from "./engine.ts";
import { ConfigError, DefinitionError } from "./exit-codes.ts";
import { discoverModules, installModuleAliases, schemaOf } from "./loader.ts";
import { logEvent } from "./log.ts";
import {
  appSummarySchema,
  envNamesOf,
  manifestLine,
  manifestSchema,
  MAX_MANIFEST_BYTES,
  sha256Hex,
  verifyBundle,
  type AppSummary,
  type BundleManifest,
} from "./manifest.ts";
import { VERSION } from "./version.ts";

/** The imports installModuleAliases serves; everything else is inlined. */
const FRAMEWORK_MODULES = new Set(["incibase", "incibase/server", "incibase/client", "zod", "zod/v4"]);

/**
 * Leaves the framework imports to the loading process, refuses framework
 * subpaths it would not serve and native addons, which one file cannot carry:
 * `.node` files the build would load, and packages that ship one for code
 * that loads it from a computed path (node-gyp-build, bindings).
 */
function bundlePlugin(nativeImports: string[], nativePackages: string[]): BunPlugin {
  const packages = new Set<string>();
  return {
    name: "incibase-bundle",
    setup(build) {
      build.onResolve({ filter: /^(incibase|zod)(\/.*)?$/ }, (args) => {
        if (FRAMEWORK_MODULES.has(args.path)) return { path: args.path, external: true };
        throw new DefinitionError(
          `"${args.path}" (imported by ${args.importer}) cannot be bundled: server code can import ${[...FRAMEWORK_MODULES].join(", ")}`,
        );
      });
      build.onResolve({ filter: /\.node$/ }, (args) => {
        nativeImports.push(`${args.path} (imported by ${args.importer})`);
        return { path: args.path, external: true };
      });
      // A package whose main is a .node file resolves to it under a bare name.
      build.onLoad({ filter: /\.node$/ }, (args) => {
        nativeImports.push(displayPath(args.path));
        return { contents: "export default undefined;", loader: "js" };
      });
      // Returning nothing leaves the file to the default loader.
      build.onLoad({ filter: /[\\/]node_modules[\\/]/ }, (args) => {
        const root = packageRoot(args.path);
        if (!root || packages.has(root)) return undefined;
        packages.add(root);
        const addon = nativeAddonOf(root);
        if (addon) nativePackages.push(`${displayPath(root)} ships ${addon}`);
        return undefined;
      });
    },
  };
}

/** `path` relative to the working directory when it is under it, else as it is. */
function displayPath(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel && !rel.startsWith("..") ? rel : path;
}

/** The package directory of a file under node_modules (`.../node_modules/@scope/pkg`), or null. */
function packageRoot(file: string): string | null {
  const parts = file.split(/[\\/]/);
  const at = parts.lastIndexOf("node_modules");
  if (at === -1 || at + 1 >= parts.length - 1) return null;
  return parts.slice(0, at + (parts[at + 1]!.startsWith("@") ? 3 : 2)).join("/");
}

/** What marks `root` as a package with a native addon: a .node file, binding.gyp or prebuilds/; null otherwise. */
function nativeAddonOf(root: string): string | null {
  for (const marker of ["binding.gyp", "prebuilds"]) if (existsSync(join(root, marker))) return marker;
  // Breadth first and bounded, skipping nested packages: addons sit near the package root.
  let level = [""];
  for (let depth = 0; depth < 5 && level.length; depth++) {
    const next: string[] = [];
    for (const rel of level) {
      let entries: Dirent[];
      try {
        entries = readdirSync(join(root, rel), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const path = rel ? `${rel}/${e.name}` : e.name;
        if (e.isFile() && e.name.endsWith(".node")) return path;
        if (e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith(".")) next.push(path);
      }
    }
    level = next.slice(0, 1000);
  }
  return null;
}

/** The entry module: `schema` (the schema file's namespace) and `modules` (module path → namespace). */
function entrySource(dir: string): string {
  const { modules, schemaFile, skipped } = discoverModules(dir);
  for (const file of skipped) {
    const reason = `module paths may only use letters, digits and "_"`;
    logEvent("warn", { ev: "module_skipped", path: file, msg: reason }, [`[incibase] skipping ${file}: ${reason}`]);
  }
  return [
    schemaFile ? `import * as schema from ${JSON.stringify(schemaFile)};` : `const schema = undefined;`,
    ...modules.map((m, i) => `import * as m${i} from ${JSON.stringify(m.absolutePath)};`),
    `export { schema };`,
    `export const modules = {`,
    ...modules.map((m, i) => `  ${JSON.stringify(m.modulePath)}: m${i},`),
    `};`,
    ``,
  ].join("\n");
}

export interface BundleOptions {
  dir: string;
  out: string;
  minify?: boolean;
}

/**
 * Bundles the app in `dir` into `out` (after codegen), with the manifest as its first line.
 * The bundle is loaded once to describe the app, so the app's top-level code
 * runs here, as it does under `incibase dev`.
 */
export async function bundleApp(options: BundleOptions): Promise<BundleManifest> {
  const dir = resolve(options.dir);
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new ConfigError(`No app directory ${options.dir}: pass --dir, or create one with: incibase init`);
  }
  codegen(dir);
  const work = mkdtempSync(join(tmpdir(), "incibase-bundle-"));
  // At a fixed path (codegen's directory, which discovery skips): the build names it in a comment.
  const entry = join(dir, "_generated", "bundle-entry.ts");
  try {
    writeFileSync(entry, entrySource(dir));
    const nativeImports: string[] = [];
    const nativePackages: string[] = [];
    let result: Awaited<ReturnType<typeof Bun.build>>;
    try {
      result = await Bun.build({
        entrypoints: [entry],
        target: "bun",
        format: "esm",
        minify: options.minify ?? false,
        plugins: [bundlePlugin(nativeImports, nativePackages)],
      });
    } catch (err) {
      // A plugin's DefinitionError comes back wrapped in the build's logs.
      throw bundleError(err);
    }
    if (nativeImports.length || nativePackages.length) {
      throw new DefinitionError(`Native addons cannot be bundled: ${[...nativeImports, ...nativePackages].join(", ")}`);
    }
    if (!result.success) throw bundleError(new AggregateError(result.logs));
    const outputs = result.outputs.map((o) => relative(work, o.path) || o.path);
    if (result.outputs.length !== 1 || result.outputs[0]!.kind !== "entry-point") {
      throw new DefinitionError(
        `The bundle must be one file, but the build produced ${result.outputs.length}: ${outputs.join(", ")}. ` +
          `Import assets as text (with { type: "text" }) or read them at runtime instead.`,
      );
    }
    const body = await result.outputs[0]!.text();
    warnBuildPaths(body);
    const app = await describeBundle(work, body);
    const manifest: BundleManifest = {
      format: 1,
      incibaseVersion: VERSION,
      sha256: sha256Hex(body),
      createdAt: new Date().toISOString(),
      app,
      envNames: envNamesOf(body),
    };
    // What serve and root would refuse to read is refused here, not written.
    const valid = manifestSchema.safeParse(manifest);
    if (!valid.success) {
      const issue = valid.error.issues[0]!;
      throw new DefinitionError(`The bundle's manifest would be refused at ${issue.path.join(".")}: ${issue.message}`);
    }
    const line = manifestLine(manifest);
    if (Buffer.byteLength(line) > MAX_MANIFEST_BYTES) {
      throw new DefinitionError(`The bundle's manifest would be longer than ${MAX_MANIFEST_BYTES} bytes, which serve refuses`);
    }
    const out = resolve(options.out);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${line}\n${body}`);
    return manifest;
  } finally {
    rmSync(entry, { force: true });
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Warns about `__dirname`/`__filename`, which the build fixes to this
 * machine's paths: they do not exist where the bundle is served.
 */
function warnBuildPaths(body: string) {
  const paths = new Set<string>();
  for (const m of body.matchAll(/\b(__dirname|__filename) = ("(?:[^"\\\n]|\\.)*")/g)) {
    paths.add(`${m[1]} = ${displayPath(JSON.parse(m[2]!) as string)}`);
  }
  if (!paths.size) return;
  const msg = `the bundle fixes ${[...paths].join(", ")} to this machine's paths; code that reads files through them will not find them where the bundle is served`;
  logEvent("warn", { ev: "bundle_build_paths", paths: [...paths], msg }, [`[incibase] ${msg}`]);
}

/** A DefinitionError thrown by the plugin as itself; any other build failure as a DefinitionError with the logs. */
function bundleError(err: unknown): Error {
  const errors: unknown[] = err instanceof AggregateError ? err.errors : [err];
  const definition = errors.find((e) => e instanceof DefinitionError);
  if (definition) return definition as DefinitionError;
  const messages = errors.map((e) => {
    const { message, position } = e as { message?: string; position?: { file: string; line: number; column: number } | null };
    const at = position?.file ? `${relative(process.cwd(), position.file)}:${position.line}:${position.column}: ` : "";
    return `  ${at}${message ?? String(e)}`;
  });
  return new DefinitionError(`Bundling failed:\n${messages.join("\n")}`);
}

/** Imports `body` (written to a file of its own, as a real path is unique per load) and describes the app. */
async function describeBundle(work: string, body: string): Promise<AppSummary> {
  installModuleAliases();
  const file = join(work, "describe.mjs");
  writeFileSync(file, body);
  return summarizeApp(appOf(await import(file), "the bundle"));
}

/** The app a bundle module exports; DefinitionError when it is not shaped like one. */
function appOf(ns: Record<string, unknown>, file: string): AppDefinition {
  const modules = ns.modules;
  if (!modules || typeof modules !== "object") throw new DefinitionError(`${file} does not export the app's modules`);
  const schema = ns.schema as Record<string, unknown> | undefined;
  return { schema: schema ? schemaOf(schema, `${file} (schema)`) : undefined, modules: modules as AppDefinition["modules"] };
}

/** What `describeApp` reports, from the definitions alone; runs the checks serve runs before migrating. */
export function summarizeApp(app: AppDefinition): AppSummary {
  const { functions, crons, http } = checkDefinitions(app);
  const tables: AppSummary["tables"] = {};
  for (const [name, table] of Object.entries(app.schema?.tables ?? {})) {
    tables[name] = { indexes: table.indexes.map((i) => ({ name: i.name, fields: [...i.fields], unique: i.unique })) };
  }
  return {
    functions: [...functions].map(([path, fn]) => ({
      path,
      type: fn.type,
      visibility: fn.visibility,
      ...(fn.description ? { description: fn.description } : {}),
    })),
    tables,
    crons: (crons?.jobs ?? []).map((j) => ({ name: j.name, schedule: j.schedule, path: j.path })),
    http: (http?.routes ?? []).map((r) => ({ method: r.method, ...(r.path ? { path: r.path } : { pathPrefix: r.pathPrefix }) })),
  };
}

/** Sources of verified bundles by real path, until the loader hook below serves them. */
const verifiedSources = new Map<string, string>();
/** Paths that have a loader hook. */
const hooked = new Set<string>();

/**
 * Loads the app from a bundle: checks its sha256, then imports the very text
 * that was hashed (served from memory by a loader hook, so the file changing
 * after the check cannot swap the code) with the framework aliased.
 */
export async function loadAppFromBundle(file: string): Promise<{ app: AppDefinition; manifest: BundleManifest }> {
  let path: string;
  try {
    // The path Bun's resolver hands the hook (e.g. /private/var/... for /var/... on macOS).
    path = realpathSync(file);
  } catch (err) {
    throw new ConfigError(`Cannot read bundle ${file}: ${(err as Error).message}`);
  }
  const { manifest, source } = verifyBundle(path);
  if (manifest.incibaseVersion !== VERSION) {
    const msg = `${file} was bundled with incibase ${manifest.incibaseVersion}; this is ${VERSION}`;
    logEvent("warn", { ev: "bundle_version_mismatch", bundle: manifest.incibaseVersion, version: VERSION, msg }, [`[incibase] ${msg}`]);
  }
  installModuleAliases();
  if (!hooked.has(path)) {
    hooked.add(path);
    // One hook per file, matching its exact path, so a bundle of any name is served from memory.
    Bun.plugin({
      name: `incibase-bundle:${path}`,
      setup(build) {
        build.onLoad({ filter: new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&")}$`) }, () => {
          const contents = verifiedSources.get(path);
          if (contents === undefined) throw new ConfigError(`${path} was not verified before loading`);
          verifiedSources.delete(path);
          return { contents, loader: "js" };
        });
      },
    });
  }
  verifiedSources.set(path, source);
  const ns = await import(path);
  // Still there: Bun did not ask the hook, so what it imported was not the verified text.
  if (verifiedSources.delete(path)) throw new ConfigError(`${file} was not loaded through the verified-bundle hook`);
  const app = appOf(ns, file);
  checkManifestDescribes(manifest, app, source.slice(source.indexOf("\n") + 1), file);
  return { app, manifest };
}

/**
 * Refuses (ConfigError, exit 64) a manifest that does not describe the app
 * the bundle defines, so the manifest a host keeps after a passing preflight
 * is true to the release: its functions, tables, crons, routes and env names.
 */
function checkManifestDescribes(manifest: BundleManifest, app: AppDefinition, body: string, file: string) {
  // Through the schema, so both sides have the same key order and no undefined keys.
  const parsed = appSummarySchema.safeParse(JSON.parse(JSON.stringify(summarizeApp(app))));
  const actual: Record<string, unknown> = parsed.success ? parsed.data : {};
  const differ = (["functions", "tables", "crons", "http"] as const).filter(
    (part) => JSON.stringify(actual[part]) !== JSON.stringify(manifest.app[part]),
  );
  if (JSON.stringify(envNamesOf(body)) !== JSON.stringify(manifest.envNames)) differ.push("envNames" as never);
  if (differ.length) {
    throw new ConfigError(
      `${file}: its manifest does not describe the app it defines (${differ.join(", ")} differ). ` +
        `The bundle was edited, or the app's definitions depend on the environment; bundle it again.`,
    );
  }
}
