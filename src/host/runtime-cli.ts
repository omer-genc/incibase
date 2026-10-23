// `incibase host install-runtime | use-cli | runtimes | gc`, as root. Each
// parses its own flags and calls one op in runtime.ts, printing its JSON
// result like `host op` does.
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { openHost } from "./context.ts";
import { DEFAULT_ROOT } from "./layout.ts";
import { OpError } from "./ops.ts";
import { gc, installRuntime, listRuntimes, useCli, type RuntimeContext } from "./runtime.ts";

export const RUNTIME_USAGE = `  incibase host install-runtime --version <x.y.z> [<binary> (--sums <SHA256SUMS> | --sha256 <hex>)] [--skip-version-check]
      Installs a runtime: the local <binary> checked against its SHA256SUMS entry or sha256,
      or, without one, incibase-linux-<arch> downloaded from the GitHub release v<x.y.z>
      and checked against that release's SHA256SUMS.
  incibase host use-cli <version> [--replace]
      Points /usr/local/bin/incibase at an installed runtime.
  incibase host runtimes
      The installed runtimes and the branches that pin them.
  incibase host gc [--older-than <days>]
      Removes trash older than <days> (7) and the runtimes nothing uses.`;

export const RUNTIME_COMMANDS = new Set(["install-runtime", "use-cli", "runtimes", "gc"]);

export async function runtimeCli(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        root: { type: "string" },
        version: { type: "string" },
        sums: { type: "string" },
        sha256: { type: "string" },
        "skip-version-check": { type: "boolean", default: false },
        replace: { type: "boolean", default: false },
        "older-than": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
    if (values.help) return console.log(`Usage (as root):\n${RUNTIME_USAGE}`);
    const ctx: RuntimeContext = openHost({ root: values.root ?? process.env.INCIBASE_HOST_ROOT ?? DEFAULT_ROOT });
    try {
      let result: unknown;
      if (command === "install-runtime") {
        if (positionals.length > 1) throw new OpError("INVALID", `install-runtime takes one binary\n${RUNTIME_USAGE}`);
        result = await installRuntime(ctx, {
          version: values.version ?? "",
          ...(positionals[0] === undefined ? {} : { binary: resolve(positionals[0]) }),
          ...(values.sums === undefined ? {} : { sums: resolve(values.sums) }),
          ...(values.sha256 === undefined ? {} : { sha256: values.sha256 }),
          skipVersionCheck: values["skip-version-check"],
        });
      } else if (command === "use-cli") {
        if (positionals.length !== 1) throw new OpError("INVALID", `use-cli takes one version\n${RUNTIME_USAGE}`);
        result = await useCli(ctx, { version: positionals[0]!, replace: values.replace });
      } else if (command === "runtimes") {
        result = await listRuntimes(ctx);
      } else {
        const days = values["older-than"];
        if (days !== undefined && !/^\d{1,4}$/.test(days)) throw new OpError("INVALID", `--older-than takes a number of days, got ${JSON.stringify(days)}`);
        result = await gc(ctx, days === undefined ? {} : { olderThanDays: Number(days) });
      }
      console.log(JSON.stringify(result, null, 2));
    } finally {
      ctx.registry.close();
    }
  } catch (err) {
    console.error((err as Error).message);
    const usage = err instanceof TypeError && (err as { code?: string }).code?.startsWith("ERR_PARSE_ARGS");
    process.exit(usage || (err instanceof OpError && err.code === "INVALID") ? 64 : 1);
  }
}
