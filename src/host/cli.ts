// `incibase host …`, as root on the VPS. The owner's commands are in
// commands.ts; this entry adds the two that speak JSON: `host op <name>
// [json]` calls one owner operation with JSON input and prints its JSON
// result, and `host _job` is what a transient release, rollback or upgrade
// unit runs.
import { parseArgs } from "node:util";
import { DEFAULT_ROOT, type LayoutOptions } from "./layout.ts";
import { openHost } from "./context.ts";
import { OpError, OPS } from "./ops.ts";
import { runJob } from "./release.ts";
import { EXIT, groupHelp, runCommand } from "./commands.ts";

/** `incibase host <argv>`; exits with the command's code. */
export async function hostCli(argv: string[]): Promise<void> {
  if (argv[0] !== "op" && argv[0] !== "_job") process.exit(await runCommand(["host", ...argv]));
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        root: { type: "string" },
        layout: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
    const [command, ...rest] = positionals;
    if (values.help) return console.log(groupHelp("host"));
    const root = values.root ?? process.env.INCIBASE_HOST_ROOT ?? DEFAULT_ROOT;
    if (command === "_job") {
      const ctx = openHost({ root });
      try {
        await runJob(ctx, rest);
      } finally {
        ctx.registry.close();
      }
      return;
    }
    const [name, json] = rest;
    if (!name || !(name in OPS)) throw new OpError("INVALID", `Unknown operation ${JSON.stringify(name)}; one of: ${Object.keys(OPS).join(", ")}`);
    let input: unknown = {};
    let layout: Omit<LayoutOptions, "root"> | undefined;
    try {
      if (json !== undefined) input = JSON.parse(json);
      if (values.layout !== undefined) layout = JSON.parse(values.layout) as Omit<LayoutOptions, "root">;
    } catch (err) {
      throw new OpError("INVALID", `Invalid JSON: ${(err as Error).message}`);
    }
    const ctx = openHost({ root, layout });
    try {
      const op = OPS[name as keyof typeof OPS] as (ctx: unknown, input: unknown) => Promise<unknown>;
      console.log(JSON.stringify(await op(ctx, input), null, 2));
    } finally {
      ctx.registry.close();
    }
  } catch (err) {
    console.error((err as Error).message);
    const usage = (err instanceof OpError && err.code === "INVALID") || (err instanceof TypeError && String((err as { code?: string }).code).startsWith("ERR_PARSE_ARGS"));
    process.exit(usage ? EXIT.USAGE : EXIT.FAILED);
  }
}
