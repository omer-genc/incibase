// Builds what the npm package ships besides src/ (which the Bun-only CLI and
// engine run from directly):
//   1. dist/lib/*.js    — the library entry points as plain ESM, so Node,
//                         Vite, Next.js and Metro can import them,
//   2. dist/lib/*.d.ts  — their declarations,
//   3. dist/lib/dashboard.html — the prebuilt admin dashboard, since the
//                         package does not carry src/dashboard or Tailwind.
//
// Usage: bun scripts/build-package.ts
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const outdir = join(root, "dist", "lib");
const entries = ["index", "server", "client", "react"];

rmSync(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: entries.map((n) => join(root, "src", `${n}.ts`)),
  outdir,
  target: "browser",
  format: "esm",
  splitting: true,
  sourcemap: "linked",
  external: ["zod", "react", "react/jsx-runtime"],
  naming: { entry: "[name].[ext]", chunk: "chunk-[hash].[ext]" },
});
if (!result.success) throw new AggregateError(result.logs, "library bundle failed");

const tsc = Bun.spawnSync(["bun", "x", "tsc", "-p", "tsconfig.build.json"], { cwd: root, stdout: "inherit", stderr: "inherit" });
if (tsc.exitCode !== 0) throw new Error("declaration emit failed");

// tsc keeps the `.ts` specifiers used in src; published declarations point at
// the emitted `.js` siblings instead.
for (const file of readdirSync(outdir).filter((f) => f.endsWith(".d.ts"))) {
  const path = join(outdir, file);
  const text = await Bun.file(path).text();
  await Bun.write(path, text.replace(/((?:from|import)\s*\(?\s*["']\.{1,2}\/[^"']*?)\.ts(["'])/g, "$1.js$2"));
}

const { buildDashboardHtml } = await import("../src/engine/dashboard.ts");
writeFileSync(join(outdir, "dashboard.html"), await buildDashboardHtml());

console.log(`built ${readdirSync(outdir).length} files into dist/lib`);
