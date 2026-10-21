import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import * as zodNs from "zod";
import * as clientNs from "../client.ts";
import * as indexNs from "../index.ts";
import type { SchemaDefinition } from "../schema.ts";
import * as serverNs from "../server.ts";
import type { AppDefinition } from "./engine.ts";

const MODULE_SEGMENT = /^[A-Za-z0-9_]+$/;
const SCHEMA_FILES = ["schema.ts", "schema.js", "schema.mts", "schema.mjs"];

let aliasesInstalled = false;

/**
 * Points `incibase`, `incibase/*` and `zod` imports in user code at the copies
 * loaded in this process, so there is one Zod instance and the standalone
 * binary needs no node_modules.
 */
export function installModuleAliases() {
  if (aliasesInstalled) return;
  aliasesInstalled = true;
  const modules: Record<string, object> = {
    incibase: indexNs,
    "incibase/server": serverNs,
    "incibase/client": clientNs,
    zod: zodNs,
    "zod/v4": zodNs,
  };
  Bun.plugin({
    name: "incibase-module-aliases",
    setup(build) {
      for (const [specifier, ns] of Object.entries(modules)) {
        build.module(specifier, () => ({ exports: { ...ns }, loader: "object" }));
      }
    },
  });
}

export interface ModuleFile {
  /** `"chat/messages"` */
  modulePath: string;
  absolutePath: string;
}

/** Function modules in `dir`: every source file except schema, `_generated`, tests and dotfiles. */
export function discoverModules(dir: string): { modules: ModuleFile[]; schemaFile: string | null; skipped: string[] } {
  const root = resolve(dir);
  const modules: ModuleFile[] = [];
  const skipped: string[] = [];
  const glob = new Bun.Glob("**/*.{ts,tsx,js,mjs,mts}");
  for (const file of glob.scanSync({ cwd: root, onlyFiles: true })) {
    const rel = file.split(sep).join("/");
    if (rel.startsWith("_generated/") || rel.split("/").some((s) => s.startsWith("."))) continue;
    if (/\.(test|spec)\.[^.]+$/.test(rel) || rel.endsWith(".d.ts")) continue;
    if (SCHEMA_FILES.includes(rel)) continue;
    const modulePath = rel.replace(/\.[^.]+$/, "");
    if (!modulePath.split("/").every((s) => MODULE_SEGMENT.test(s))) {
      skipped.push(rel);
      continue;
    }
    modules.push({ modulePath, absolutePath: join(root, file) });
  }
  modules.sort((a, b) => a.modulePath.localeCompare(b.modulePath));
  const schemaFile = SCHEMA_FILES.map((f) => join(root, f)).find((f) => existsSync(f)) ?? null;
  return { modules, schemaFile, skipped };
}

export async function loadAppFromDir(dir: string): Promise<AppDefinition> {
  installModuleAliases();
  const { modules, schemaFile, skipped } = discoverModules(dir);
  for (const file of skipped) {
    console.warn(`[incibase] skipping ${relative(process.cwd(), join(dir, file))}: module paths may only use letters, digits and "_"`);
  }
  let schema: SchemaDefinition | undefined;
  if (schemaFile) {
    const ns = await import(schemaFile);
    schema = ns.default;
    if ((schema as { __incibase?: string } | undefined)?.__incibase !== "schema") {
      throw new Error(`${schemaFile} must \`export default defineSchema({...})\``);
    }
  }
  const loaded: AppDefinition["modules"] = {};
  for (const m of modules) loaded[m.modulePath] = await import(m.absolutePath);
  return { schema, modules: loaded };
}
