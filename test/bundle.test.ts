import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bundleApp, summarizeApp } from "../src/engine/bundle.ts";
import { ConfigError, DefinitionError, ExitCode } from "../src/engine/exit-codes.ts";
import { loadAppFromDir } from "../src/engine/loader.ts";
import {
  envNamesOf,
  manifestLine,
  MAX_MANIFEST_BYTES,
  readManifest,
  sha256Hex,
  verifyBundle,
  type BundleManifest,
} from "../src/engine/manifest.ts";
import { VERSION } from "../src/engine/version.ts";
import { EXAMPLE_DIR, tempDir } from "./helpers.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
/** A standalone binary built with scripts/build-binary.ts; the tests that need one are skipped without it. */
const BINARY = process.env.INCIBASE_TEST_BINARY;

const dirs: string[] = [];
const procs: ReturnType<typeof Bun.spawn>[] = [];

afterEach(async () => {
  for (const p of procs.splice(0)) {
    p.kill("SIGKILL");
    await p.exited;
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dir() {
  const d = tempDir();
  dirs.push(d);
  return d;
}

/** A project dir holding `files` (paths relative to it) and the app dir `app/` inside it. */
function project(files: Record<string, string>) {
  const root = dir();
  for (const [name, text] of Object.entries(files)) {
    const file = join(root, name);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
  }
  return { root, source: join(root, "app"), out: join(root, "app.ib"), data: join(root, "data") };
}

function childEnv(extra: Record<string, string> = {}) {
  const { INCIBASE_ADMIN_KEY: _k, INCIBASE_LOG_FORMAT: _f, INCIBASE_LOG_CALLS: _c, ...env } = process.env;
  return { ...env, ...extra };
}

/** Runs a CLI command to completion. */
async function run(args: string[], { bin, env }: { bin?: string; env?: Record<string, string> } = {}) {
  const proc = Bun.spawn([...(bin ? [bin] : [process.execPath, CLI]), ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv({ INCIBASE_RESTART: "1", ...env }),
    timeout: 30_000,
    killSignal: "SIGKILL",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

/** Starts `serve --bundle` with json logs and returns the address it listens on. */
async function serveBundle(
  bundle: string,
  data: string,
  { bin, env, extra = [], cwd }: { bin?: string; env?: Record<string, string>; extra?: string[]; cwd?: string } = {},
) {
  const args = ["serve", "--bundle", bundle, "--data", data, "--port", "0", "--host", "127.0.0.1", "--log-format", "json", ...extra];
  const proc = Bun.spawn([...(bin ? [bin] : [process.execPath, CLI]), ...args], { stdout: "pipe", stderr: "pipe", env: childEnv(env), cwd });
  procs.push(proc);
  const out = { stdout: "", stderr: "" };
  for (const name of ["stdout", "stderr"] as const) {
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of proc[name] as ReadableStream<Uint8Array>) out[name] += decoder.decode(chunk, { stream: true });
    })();
  }
  for (const end = Date.now() + 15_000; ; await Bun.sleep(25)) {
    const ready = out.stdout
      .split("\n")
      .filter((l) => l.includes(`"ev":"ready"`))
      .map((l) => JSON.parse(l) as { listen: string })[0];
    if (ready) return { url: ready.listen, out };
    if (proc.exitCode !== null || Date.now() > end) throw new Error(`serve --bundle did not start:\n${out.stdout}\n${out.stderr}`);
  }
}

async function call(url: string, kind: "query" | "mutation" | "action", path: string, args: unknown = {}, token?: string) {
  const res = await fetch(`${url}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ path, args }),
  });
  const body = (await res.json()) as { value?: unknown; error?: unknown };
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(body)}`);
  return body.value;
}

async function signUp(url: string): Promise<string> {
  const res = await fetch(`${url}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "ada@example.com", password: "correct horse battery" }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

/** Exercises the example app behind `url`: an http route, a mutation and the query that sees it. */
async function exerciseExample(url: string) {
  const token = await signUp(url);
  expect(await call(url, "query", "channels:list")).toEqual([]);
  const id = await call(url, "mutation", "channels:create", { name: "general" }, token);
  expect(typeof id).toBe("string");
  const channels = (await call(url, "query", "channels:list")) as { _id: string; name: string }[];
  expect(channels.map((c) => [c._id, c.name])).toEqual([[id as string, "general"]]);
  const hello = await fetch(`${url}/hello?name=bundle`);
  expect(await hello.json()).toEqual({ hello: "bundle", channels: 1 });
}

/** A file with a valid manifest line for `body`, which may be any text. */
function handMadeBundle(file: string, body: string, manifest: Partial<BundleManifest> = {}) {
  const full: BundleManifest = {
    format: 1,
    incibaseVersion: VERSION,
    sha256: sha256Hex(body),
    createdAt: new Date().toISOString(),
    app: { functions: [], tables: {}, crons: [], http: [] },
    envNames: [],
    ...manifest,
  };
  writeFileSync(file, `${manifestLine(full)}\n${body}`);
  return full;
}

/** An app that imports a CommonJS npm package from the project's node_modules. */
function npmProject() {
  return project({
    "node_modules/tinydep/package.json": JSON.stringify({ name: "tinydep", version: "1.0.0", main: "index.js" }),
    "node_modules/tinydep/index.js": `exports.shout = (s) => s.toUpperCase() + "!";\nexports.home = process.env.TINYDEP_HOME;\n`,
    "app/schema.ts": `import { defineSchema, defineTable, z } from "incibase/server";\nexport default defineSchema({ notes: defineTable({ body: z.string() }) });\n`,
    "app/notes.ts": [
      `import { z } from "zod";`,
      `import { shout } from "tinydep";`,
      `import { mutation, query } from "./_generated/server";`,
      `export const loud = query({ description: "Shouts; a */ in here must not end the manifest comment", args: { s: z.string() }, handler: async (_ctx, { s }) => shout(s) });`,
      `export const add = mutation({ args: { body: z.string() }, handler: async (ctx, { body }) => ctx.db.insert("notes", { body: shout(body) }) });`,
      `export const all = query({ handler: async (ctx) => (await ctx.db.query("notes").collect()).map((n) => n.body) });`,
      `export const env = query({ handler: async () => [process.env.GREETING ?? null, Bun.env["API_TOKEN"] ?? null, import.meta.env.OTHER ?? null] });`,
      ``,
    ].join("\n"),
    "app/crons.ts": `import { cronJobs } from "incibase/server";\nimport { api } from "./_generated/api";\nconst crons = cronJobs();\ncrons.cron("every5", "*/5 * * * *", api.notes.all);\nexport default crons;\n`,
  });
}

/** Calls the npm app behind `url`, started with GREETING=merhaba. */
async function exerciseNpm(url: string) {
  expect(await call(url, "query", "notes:loud", { s: "hey" })).toBe("HEY!");
  await call(url, "mutation", "notes:add", { body: "quiet" });
  expect(await call(url, "query", "notes:all")).toEqual(["QUIET!"]);
  expect(await call(url, "query", "notes:env")).toEqual(["merhaba", null, null]);
}

/** A copy of the example app, so bundling it does not touch the repository. */
function exampleCopy() {
  const root = dir();
  const source = join(root, "incibase");
  cpSync(EXAMPLE_DIR, source, { recursive: true });
  return { root, source, out: join(root, "app.ib"), data: join(root, "data") };
}

describe("incibase bundle", () => {
  test("bundles the example into one file whose manifest describes the app", async () => {
    const { source, out } = exampleCopy();
    const manifest = await bundleApp({ dir: source, out });
    const text = readFileSync(out, "utf8");
    const [first, ...rest] = text.split("\n");
    expect(first).toBe(manifestLine(manifest));
    expect(manifest.sha256).toBe(sha256Hex(rest.join("\n")));
    expect(manifest.format).toBe(1);
    expect(manifest.incibaseVersion).toBe(VERSION);
    expect(Date.parse(manifest.createdAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(readManifest(out)).toEqual(manifest);

    // The same description serve's registration produces from the source dir.
    expect(manifest.app).toEqual(summarizeApp(await loadAppFromDir(EXAMPLE_DIR)));
    const fns = Object.fromEntries(manifest.app.functions.map((f) => [f.path, f]));
    expect(fns["channels:list"]).toEqual({ path: "channels:list", type: "query", visibility: "public", description: "All channels, alphabetically." });
    expect(fns["channels:create"]).toEqual({ path: "channels:create", type: "mutation", visibility: "public" });
    expect(fns["messages:bumpCount"]?.visibility).toBe("internal");
    expect(fns["files:storeText"]?.type).toBe("action");
    expect(manifest.app.tables.channels?.indexes).toEqual([{ name: "by_name", fields: ["name"], unique: true }]);
    expect(manifest.app.crons).toEqual([{ name: "heartbeat", schedule: { kind: "interval", ms: 3_600_000 }, path: "messages:bumpCount" }]);
    expect(manifest.app.http).toEqual([{ method: "GET", path: "/hello" }]);

    // incibase and zod stay imports for the loading process to provide; nothing else does.
    const imports = [...text.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(new Set(imports)).toEqual(new Set(["incibase", "incibase/server"]));

    const check = await run(["bundle", "--check", "--out", out]);
    expect(check.code).toBe(0);
    expect(check.stdout).toContain(`is valid: incibase ${VERSION}, ${manifest.app.functions.length} function(s), 5 table(s)`);
  }, 30_000);

  test("serve --bundle runs the bundled app: queries, mutations and http routes", async () => {
    const { root, source, out, data } = exampleCopy();
    const bundled = await run(["bundle", "--dir", source, "--out", out]);
    expect(bundled.code).toBe(0);
    expect(bundled.stdout).toContain(`Bundled ${out}`);
    // Not the source: the bundle alone is enough.
    rmSync(source, { recursive: true, force: true });
    const { url } = await serveBundle(out, data);
    expect(existsSync(join(root, "incibase"))).toBe(false);
    await exerciseExample(url);
  }, 30_000);

  test("npm dependencies are inlined, and the bundle runs without node_modules", async () => {
    const p = npmProject();
    const manifest = await bundleApp({ dir: p.source, out: p.out });
    expect(manifest.envNames).toEqual(["API_TOKEN", "GREETING", "OTHER", "TINYDEP_HOME"]);
    expect(manifest.app.functions.find((f) => f.path === "notes:loud")?.description).toContain("a */ in here");
    expect(manifest.app.crons[0]?.schedule).toEqual({ kind: "cron", expression: "*/5 * * * *" });
    expect(readManifest(p.out)).toEqual(manifest);
    const text = readFileSync(p.out, "utf8");
    expect(text).toContain(`toUpperCase() + "!"`);
    expect(text).not.toContain(`from "tinydep"`);
    expect(text).not.toContain(`require("tinydep")`);
    expect(text).toContain(`from "zod"`);

    rmSync(join(p.root, "node_modules"), { recursive: true, force: true });
    rmSync(p.source, { recursive: true, force: true });
    const { url } = await serveBundle(p.out, p.data, { env: { GREETING: "merhaba" } });
    await exerciseNpm(url);
  }, 30_000);

  test("a native .node addon is refused, from the app or from a dependency", async () => {
    const direct = project({
      "app/addon.node": "not really a native addon",
      "app/native.ts": `import addon from "./addon.node";\nexport const x = addon;\n`,
    });
    const err = await bundleApp({ dir: direct.source, out: direct.out }).catch((e) => e);
    expect(err).toBeInstanceOf(DefinitionError);
    expect(err.message).toContain("Native addons cannot be bundled: ./addon.node");
    expect(existsSync(direct.out)).toBe(false);

    const dep = project({
      "node_modules/nativedep/package.json": JSON.stringify({ name: "nativedep", main: "index.js" }),
      "node_modules/nativedep/index.js": `module.exports = require("./build/Release/binding.node");\n`,
      "node_modules/nativedep/build/Release/binding.node": "binary",
      "app/native.ts": `import binding from "nativedep";\nexport const x = binding;\n`,
    });
    const cli = await run(["bundle", "--dir", dep.source, "--out", dep.out]);
    expect(cli.code).toBe(ExitCode.DEFINITION);
    expect(cli.stderr).toContain("Native addons cannot be bundled: ./build/Release/binding.node");
    expect(existsSync(dep.out)).toBe(false);
  }, 30_000);

  test("a native addon behind a bare import or a computed require path is refused", async () => {
    // A package whose main is the addon itself.
    const main = project({
      "node_modules/napidep/package.json": JSON.stringify({ name: "napidep", main: "addon.node" }),
      "node_modules/napidep/addon.node": "binary",
      "app/a.ts": `import addon from "napidep";\nexport const x = addon;\n`,
    });
    const err = await bundleApp({ dir: main.source, out: main.out }).catch((e) => e);
    expect(err).toBeInstanceOf(DefinitionError);
    expect(err.message).toMatch(/^Native addons cannot be bundled: .*node_modules\/napidep\/addon\.node$/);
    expect(existsSync(main.out)).toBe(false);

    // node-gyp-build / bindings: the path is computed, so only the package's files tell.
    const gyp = project({
      "node_modules/gypdep/package.json": JSON.stringify({ name: "gypdep", main: "index.js" }),
      "node_modules/gypdep/index.js": `const path = require("path");\nmodule.exports = require(path.join(__dirname, "build", "Release", "gyp.node"));\n`,
      "node_modules/gypdep/build/Release/gyp.node": "binary",
      "app/a.ts": `import gyp from "gypdep";\nexport const x = gyp;\n`,
    });
    const cli = await run(["bundle", "--dir", gyp.source, "--out", gyp.out]);
    expect(cli.code).toBe(ExitCode.DEFINITION);
    expect(cli.stderr).toMatch(/Native addons cannot be bundled: .*node_modules\/gypdep ships build\/Release\/gyp\.node/);
    expect(existsSync(gyp.out)).toBe(false);

    // A scoped package that ships prebuilds/ (node-gyp-build) and nothing else.
    const prebuilt = project({
      "node_modules/@acme/fast/package.json": JSON.stringify({ name: "@acme/fast", main: "index.js" }),
      "node_modules/@acme/fast/index.js": `module.exports = require("node-gyp-build")(__dirname);\n`,
      "node_modules/@acme/fast/prebuilds/README": "addons go here",
      "node_modules/node-gyp-build/package.json": JSON.stringify({ name: "node-gyp-build", main: "index.js" }),
      "node_modules/node-gyp-build/index.js": `module.exports = (dir) => require(dir + "/prebuilds/x.node");\n`,
      "app/a.ts": `import fast from "@acme/fast";\nexport const x = fast;\n`,
    });
    const scoped = await bundleApp({ dir: prebuilt.source, out: prebuilt.out }).catch((e) => e);
    expect(scoped).toBeInstanceOf(DefinitionError);
    expect(scoped.message).toMatch(/node_modules\/@acme\/fast ships prebuilds/);
  }, 30_000);

  test("a build with more than one output file is refused", async () => {
    const p = project({
      "app/logo.png": "\x89PNG not really",
      "app/assets.ts": `import logo from "./logo.png";\nexport const path = logo;\n`,
    });
    const err = await bundleApp({ dir: p.source, out: p.out }).catch((e) => e);
    expect(err).toBeInstanceOf(DefinitionError);
    expect(err.message).toMatch(/The bundle must be one file, but the build produced 2: .*logo.*\.png/);
    expect(existsSync(p.out)).toBe(false);
  });

  test("framework subpaths the runtime does not provide are refused", async () => {
    const p = project({ "app/mini.ts": `import { z } from "zod/mini";\nexport const s = z.string();\n` });
    const err = await bundleApp({ dir: p.source, out: p.out }).catch((e) => e);
    expect(err).toBeInstanceOf(DefinitionError);
    expect(err.message).toContain(`"zod/mini"`);
  });

  test("an app that incibase rejects fails to bundle with the definition error", async () => {
    const p = project({
      "app/crons.ts": `import { cronJobs } from "incibase/server";\nimport { internal } from "./_generated/api";\nconst c = cronJobs();\nc.interval("x", { hours: 1 }, (internal as any).nope.missing);\nexport default c;\n`,
    });
    const cli = await run(["bundle", "--dir", p.source, "--out", p.out]);
    expect(cli.code).toBe(ExitCode.DEFINITION);
    expect(cli.stderr).toContain(`Cron "x" points to unknown function "nope:missing"`);
    const missing = await run(["bundle", "--dir", join(p.root, "nope"), "--out", p.out]);
    expect(missing.code).toBe(ExitCode.CONFIG);
    expect(missing.stderr).toContain("No app directory");
    expect(existsSync(p.out)).toBe(false);

    const unresolved = project({ "app/broken.ts": `import { gone } from "./nowhere";\nexport const x = gone;\n` });
    const err = await bundleApp({ dir: unresolved.source, out: unresolved.out }).catch((e) => e);
    expect(err).toBeInstanceOf(DefinitionError);
    expect(err.message).toMatch(/Bundling failed:\n.*broken\.ts:1:\d+: Could not resolve: "\.\/nowhere"/);
  }, 30_000);

  test("bundle runs the same checks as serve: function names and schema tables", async () => {
    const badName = project({
      "app/m.ts": `import { query } from "incibase/server";\nconst q = query({ handler: async () => 1 });\nexport { q as "bad-name" };\n`,
    });
    const cli = await run(["bundle", "--dir", badName.source, "--out", badName.out]);
    expect(cli.code).toBe(ExitCode.DEFINITION);
    expect(cli.stderr).toContain(`Invalid function name "bad-name" in m`);
    expect(existsSync(badName.out)).toBe(false);
    const served = await run(["serve", "--dir", badName.source, "--data", badName.data, "--port", "0", "--host", "127.0.0.1"]);
    expect(served.code).toBe(ExitCode.DEFINITION);
    expect(served.stderr).toContain(`Invalid function name "bad-name" in m`);

    const rawTable = project({
      "app/schema.ts": `import { defineSchema, z } from "incibase/server";\nexport default defineSchema({ t: { body: z.string() } as any });\n`,
    });
    const err = await bundleApp({ dir: rawTable.source, out: rawTable.out }).catch((e) => e);
    expect(err).toBeInstanceOf(DefinitionError);
    expect(err.message).toBe(`Table "t" in the schema must be defineTable({...})`);
    expect(existsSync(rawTable.out)).toBe(false);
  }, 30_000);

  test("bundling the same source twice gives the same bytes, with no temporary paths in them", async () => {
    const { source, root } = exampleCopy();
    const a = await bundleApp({ dir: source, out: join(root, "a.ib") });
    const b = await bundleApp({ dir: source, out: join(root, "b.ib") });
    expect(b.sha256).toBe(a.sha256);
    const text = readFileSync(join(root, "a.ib"), "utf8");
    // The build names its entry in a comment: a fixed path, not a fresh temporary dir.
    expect(text).not.toContain("incibase-bundle-");
    expect(text).toContain("_generated/bundle-entry.ts\n");
    // The fixed entry file does not stay behind.
    expect(existsSync(join(source, "_generated", "bundle-entry.ts"))).toBe(false);
  }, 30_000);

  test("__dirname and __filename fixed to the build machine's paths are warned about", async () => {
    const p = project({
      "node_modules/wheredep/package.json": JSON.stringify({ name: "wheredep", main: "index.js" }),
      "node_modules/wheredep/index.js": `exports.where = __dirname;\n`,
      "app/m.ts": `import { query } from "incibase/server";\nimport { where } from "wheredep";\nexport const w = query({ handler: async () => where });\n`,
    });
    const cli = await run(["bundle", "--dir", p.source, "--out", p.out]);
    expect(cli.code).toBe(0);
    expect(cli.stderr).toContain("the bundle fixes __dirname = ");
    expect(cli.stderr).toContain("wheredep");
    const plain = project({ "app/m.ts": `export const n = 1;\n` });
    const quiet = await run(["bundle", "--dir", plain.source, "--out", plain.out]);
    expect(quiet.code).toBe(0);
    expect(quiet.stderr).not.toContain("the bundle fixes");
  }, 30_000);

  test("a manifest longer than serve accepts is refused when bundling", async () => {
    const p = project({
      "app/m.ts": `import { query } from "incibase/server";\nexport const big = query({ description: "x".repeat(${MAX_MANIFEST_BYTES}), handler: async () => 1 });\n`,
    });
    const err = await bundleApp({ dir: p.source, out: p.out }).catch((e) => e);
    expect(err).toBeInstanceOf(DefinitionError);
    expect(err.message).toContain(`longer than ${MAX_MANIFEST_BYTES} bytes`);
    expect(existsSync(p.out)).toBe(false);
  }, 30_000);

  test("a timer the app starts on import does not keep the bundle command running", async () => {
    const p = project({ "app/ticker.ts": `setInterval(() => {}, 1000);\nexport const n = 1;\n` });
    const cli = await run(["bundle", "--dir", p.source, "--out", p.out]);
    expect(cli.code).toBe(0);
    expect(readManifest(p.out).app.functions).toEqual([]);
  }, 30_000);
});

describe("bundle verification", () => {
  test("a tampered bundle is refused by --check and by serve --bundle", async () => {
    const { source, out, data } = exampleCopy();
    const manifest = await bundleApp({ dir: source, out });
    const text = readFileSync(out, "utf8");
    const newline = text.indexOf("\n");
    const body = text.slice(newline + 1);
    expect(body).toContain(`"All channels, alphabetically."`);
    writeFileSync(out, text.slice(0, newline + 1) + body.replace(`"All channels, alphabetically."`, `"All channels, alphabeticallY."`));

    expect(() => verifyBundle(out)).toThrow(ConfigError);
    expect(() => verifyBundle(out)).toThrow(`sha256 mismatch (manifest ${manifest.sha256}`);
    // The manifest line itself is still fine: readManifest does not hash.
    expect(readManifest(out)).toEqual(manifest);

    const check = await run(["bundle", "--check", "--out", out]);
    expect(check.code).toBe(ExitCode.CONFIG);
    expect(check.stderr).toContain("sha256 mismatch");
    const serve = await run(["serve", "--bundle", out, "--data", data, "--port", "0", "--host", "127.0.0.1"]);
    expect(serve.code).toBe(ExitCode.CONFIG);
    expect(serve.stderr).toContain("sha256 mismatch");
    expect(existsSync(data)).toBe(false);

    // A tampered manifest (the hash edited to match) fails the same way.
    writeFileSync(out, text.replace(manifest.sha256, sha256Hex("something else")));
    expect(() => verifyBundle(out)).toThrow("sha256 mismatch");
  }, 30_000);

  test("readManifest and --check never execute the bundle", async () => {
    const root = dir();
    const marker = join(root, "ran.txt");
    const file = join(root, "evil.ib");
    const manifest = handMadeBundle(
      file,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\nthrow new Error("top level ran");\n`,
    );
    expect(readManifest(file)).toEqual(manifest);
    expect(verifyBundle(file).manifest).toEqual(manifest);
    const check = await run(["bundle", "--check", "--out", file]);
    expect(check.code).toBe(0);
    expect(existsSync(marker)).toBe(false);

    // The control: loading it does run it.
    const serve = await run(["serve", "--bundle", file, "--data", join(root, "data"), "--port", "0", "--host", "127.0.0.1"]);
    expect(serve.code).toBe(ExitCode.CRASH);
    expect(serve.stderr).toContain("top level ran");
    expect(existsSync(marker)).toBe(true);
  }, 30_000);

  test("a bundle of any file name loads, the framework imports resolving to the server's copy", async () => {
    const root = dir();
    const file = join(root, "app.mjs");
    handMadeBundle(
      file,
      `import { query } from "incibase/server";\nexport const schema = undefined;\nexport const modules = { m: { which: query({ handler: async () => "verified" }) } };\n`,
    );
    const { url } = await serveBundle(file, join(root, "data"));
    expect(await call(url, "query", "m:which")).toBe("verified");
  }, 30_000);

  test("readManifest refuses what is not a valid manifest line", () => {
    const root = dir();
    const file = join(root, "x.ib");
    const refused = (text: string | Uint8Array, message: string) => {
      writeFileSync(file, text);
      expect(() => readManifest(file)).toThrow(ConfigError);
      expect(() => readManifest(file)).toThrow(message);
      expect(() => verifyBundle(file)).toThrow(message);
    };
    refused(`export const modules = {};\n`, "is not an incibase bundle: its first line is not an incibase-manifest comment");
    refused(``, "is not an incibase bundle: its first line is not an incibase-manifest comment");
    refused(`/*! incibase-manifest {nope */\nx\n`, "the manifest is not valid JSON");
    const good = handMadeBundle(file, "export {};\n");
    const line = (m: unknown) => `/*! incibase-manifest ${JSON.stringify(m)} */\nexport {};\n`;
    refused(line({ ...good, format: 2 }), "invalid manifest at format");
    refused(line({ ...good, sha256: "abc" }), "invalid manifest at sha256");
    refused(line({ ...good, envNames: ["OK", "not ok"] }), "invalid manifest at envNames.1");
    refused(line({ ...good, app: { functions: [{ path: "a:b", type: "cron", visibility: "public" }], tables: {}, crons: [], http: [] } }), "invalid manifest at app.functions.0.type");
    refused(manifestLine(good), "no module after the manifest line");
    refused(new Uint8Array([0xff, 0xfe, 0x0a, 0x41]), "it is not UTF-8 text");
    refused("/*! incibase-manifest " + " ".repeat(MAX_MANIFEST_BYTES + 10), `the manifest line is longer than ${MAX_MANIFEST_BYTES} bytes`);
    expect(() => readManifest(join(root, "missing.ib"))).toThrow(ConfigError);
  });

  test("readManifest and verifyBundle agree on the longest manifest line", () => {
    const root = dir();
    const file = join(root, "x.ib");
    const body = "export {};\n";
    // A manifest whose line is exactly `bytes` long: each "x" of the description adds one byte.
    const padded = (bytes: number) => {
      const manifest = handMadeBundle(file, body);
      const fn = { path: "a:b", type: "query" as const, visibility: "public" as const, description: "" };
      manifest.app.functions = [fn];
      fn.description = "x".repeat(bytes - Buffer.byteLength(manifestLine(manifest)));
      const line = manifestLine(manifest);
      expect(Buffer.byteLength(line)).toBe(bytes);
      writeFileSync(file, `${line}\n${body}`);
      return manifest;
    };
    const atLimit = padded(MAX_MANIFEST_BYTES);
    expect(readManifest(file)).toEqual(atLimit);
    expect(verifyBundle(file).manifest).toEqual(atLimit);
    for (const bytes of [MAX_MANIFEST_BYTES + 1, MAX_MANIFEST_BYTES + 1000]) {
      padded(bytes);
      expect(() => readManifest(file)).toThrow(`the manifest line is longer than ${MAX_MANIFEST_BYTES} bytes`);
      expect(() => verifyBundle(file)).toThrow(`the manifest line is longer than ${MAX_MANIFEST_BYTES} bytes`);
    }
  });

  test("the manifest line survives */ in strings", () => {
    const root = dir();
    const file = join(root, "a.ib");
    const manifest = handMadeBundle(file, "export {};\n", {
      app: { functions: [{ path: "a:b", type: "query", visibility: "public", description: "x */ y /* z" }], tables: {}, crons: [], http: [] },
    });
    expect(readFileSync(file, "utf8").split("\n")[0]!.indexOf("*/")).toBe(readFileSync(file, "utf8").split("\n")[0]!.length - 2);
    expect(readManifest(file)).toEqual(manifest);
  });

  test("envNamesOf finds the env var names code reads", () => {
    const code = `process.env.A; process.env["B_1"]; Bun.env.C; Bun.env['D']; import.meta.env.E; process.env?.F; process.env?.["G"]; process.env[name]; process.env["not ok"]; myprocess.env.H; process.envX.I`;
    expect(envNamesOf(code)).toEqual(["A", "B_1", "C", "D", "E", "F", "G"]);
  });
});

describe("serve --bundle flags", () => {
  test("--bundle and --dir are mutually exclusive, and --bundle is for serve only", async () => {
    const root = dir();
    const both = await run(["serve", "--bundle", join(root, "app.ib"), "--dir", root, "--data", join(root, "data")]);
    expect(both.code).toBe(ExitCode.CONFIG);
    expect(both.stderr).toContain("Pass either --bundle or --dir, not both");
    const dev = await run(["dev", "--bundle", join(root, "app.ib")]);
    expect(dev.code).toBe(ExitCode.CONFIG);
    expect(dev.stderr).toContain("--bundle is for serve, not dev");
    const missing = await run(["serve", "--bundle", join(root, "missing.ib"), "--data", join(root, "data"), "--log-format", "json"]);
    expect(missing.code).toBe(ExitCode.CONFIG);
    const fatal = JSON.parse(missing.stdout.trim().split("\n").at(-1)!);
    expect(fatal).toMatchObject({ ev: "fatal", exitCode: ExitCode.CONFIG });
    expect(fatal.msg).toContain("Cannot read bundle");
    expect(existsSync(join(root, "data"))).toBe(false);
  }, 30_000);

  test("serve --dev --bundle runs without a source dir and writes nothing into one", async () => {
    const { root, source, out, data } = exampleCopy();
    await bundleApp({ dir: source, out });
    const generated = join(source, "_generated", "schema.json");
    rmSync(generated, { force: true });
    // From the project root, where the default --dir (incibase) is the source the bundle came from.
    const { url } = await serveBundle(out, data, { extra: ["--dev"], cwd: root });
    await exerciseExample(url);
    expect(existsSync(generated)).toBe(false);
    // And from a dir with no incibase/ in it.
    const elsewhere = dir();
    const other = await serveBundle(out, join(elsewhere, "data"), { extra: ["--dev"], cwd: elsewhere });
    expect(await call(other.url, "query", "channels:list")).toEqual([]);
    expect(existsSync(join(elsewhere, "incibase"))).toBe(false);
  }, 30_000);
});

describe.skipIf(!BINARY)("standalone binary (INCIBASE_TEST_BINARY)", () => {
  test("bundles and serves the example with no Bun or node_modules involved", async () => {
    const { source, out, data } = exampleCopy();
    const bundled = await run(["bundle", "--dir", source, "--out", out], { bin: BINARY });
    expect(bundled.code).toBe(0);
    expect((await run(["bundle", "--check", "--out", out], { bin: BINARY })).code).toBe(0);
    rmSync(source, { recursive: true, force: true });
    const { url } = await serveBundle(out, data, { bin: BINARY });
    await exerciseExample(url);
  }, 60_000);

  test("inlines npm dependencies when bundling", async () => {
    const p = npmProject();
    const bundled = await run(["bundle", "--dir", p.source, "--out", p.out], { bin: BINARY });
    expect(bundled.code).toBe(0);
    rmSync(join(p.root, "node_modules"), { recursive: true, force: true });
    const { url } = await serveBundle(p.out, p.data, { bin: BINARY, env: { GREETING: "merhaba" } });
    await exerciseNpm(url);
  }, 60_000);

  test("serves a bundle made with bun, and refuses a tampered one", async () => {
    const { source, out, data } = exampleCopy();
    await bundleApp({ dir: source, out });
    const { url } = await serveBundle(out, data, { bin: BINARY });
    await exerciseExample(url);
    writeFileSync(out, readFileSync(out, "utf8").replace("general", "generaL") + "\n// tampered\n");
    const serve = await run(["serve", "--bundle", out, "--data", join(data, "..", "data2"), "--port", "0"], { bin: BINARY });
    expect(serve.code).toBe(ExitCode.CONFIG);
    expect(serve.stderr).toContain("sha256 mismatch");
  }, 60_000);
});
