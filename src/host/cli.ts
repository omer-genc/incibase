// `incibase host …`, as root on the VPS. A thin entry for now (step 12 adds
// the real commands): `host op <name> [json]` calls one owner operation with
// JSON input and prints its JSON result, and `host _job` is what a transient
// release, rollback or upgrade unit runs.
import { parseArgs } from "node:util";
import { DEFAULT_ROOT, type LayoutOptions } from "./layout.ts";
import { openHost } from "./context.ts";
import { OpError, OPS } from "./ops.ts";
import { runJob } from "./release.ts";
import { RUNTIME_COMMANDS, RUNTIME_USAGE, runtimeCli } from "./runtime-cli.ts";

const USAGE = `Usage (as root):
  incibase host op <name> [<json input>] [--root <dir>] [--layout <json>]
      Runs an owner operation: ${Object.keys(OPS).join(", ")}
  incibase host _job --root <dir> <release|rollback|upgrade> <branch id> <n> [args]
      Internal: what a transient job unit runs.
${RUNTIME_USAGE}`;

export async function hostCli(argv: string[]): Promise<void> {
  // These parse their own flags.
  if (argv[0] !== undefined && RUNTIME_COMMANDS.has(argv[0])) return runtimeCli(argv);
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { root: { type: "string" }, layout: { type: "string" }, help: { type: "boolean", short: "h", default: false } },
  });
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }
  const root = values.root ?? process.env.INCIBASE_HOST_ROOT ?? DEFAULT_ROOT;
  try {
    if (command === "_job") {
      const ctx = openHost({ root });
      try {
        await runJob(ctx, rest);
      } finally {
        ctx.registry.close();
      }
      return;
    }
    if (command === "op") {
      const [name, json] = rest;
      if (!name || !(name in OPS)) throw new OpError("INVALID", `Unknown operation ${JSON.stringify(name)}\n${USAGE}`);
      const layout = values.layout === undefined ? undefined : (JSON.parse(values.layout) as Omit<LayoutOptions, "root">);
      const ctx = openHost({ root, layout });
      try {
        const op = OPS[name as keyof typeof OPS] as (ctx: unknown, input: unknown) => Promise<unknown>;
        const result = await op(ctx, json === undefined ? {} : JSON.parse(json));
        console.log(JSON.stringify(result, null, 2));
      } finally {
        ctx.registry.close();
      }
      return;
    }
    throw new OpError("INVALID", `Unknown host command ${JSON.stringify(command)}\n${USAGE}`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(err instanceof OpError && err.code === "INVALID" ? 64 : 1);
  }
}
