// The standalone binary reads neither bunfig.toml nor .env from its cwd:
// `sudo incibase …` keeps the cwd (often the login user's home), so a
// planted preload would run as root and a planted .env would steer it
// (INCIBASE_HOST_ROOT, INCIBASE_LOG_FORMAT, ...).
//
// Skipped unless INCIBASE_TEST_BINARY names a standalone incibase for this
// machine (bun scripts/build-binary.ts). Needs no root.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BINARY = process.env.INCIBASE_TEST_BINARY ?? "";

describe.skipIf(!BINARY)("the standalone binary's cwd", () => {
  let dir = "";
  beforeAll(() => {
    if (!existsSync(BINARY)) throw new Error(`${BINARY} does not exist (bun scripts/build-binary.ts)`);
    dir = mkdtempSync(join(tmpdir(), "incibase-autoload-"));
    writeFileSync(join(dir, "bunfig.toml"), `preload = ["./pre.ts"]\n`);
    writeFileSync(join(dir, "pre.ts"), `require("node:fs").writeFileSync(${JSON.stringify(join(dir, "PRELOAD_RAN"))}, "1");\n`);
    writeFileSync(join(dir, ".env"), "INCIBASE_LOG_FORMAT=json\n");
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("runs no bunfig.toml preload and loads no .env", () => {
    // A bad flag fails in the log format the environment asks for: JSON only if the .env was loaded.
    const run = Bun.spawnSync([resolve(BINARY), "serve", "--no-such-flag"], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = run.stdout.toString() + run.stderr.toString();
    expect(run.exitCode).toBe(64);
    expect(output).toContain("no-such-flag");
    expect(output).not.toContain(`"level":"error"`);
    expect(existsSync(join(dir, "PRELOAD_RAN"))).toBe(false);
  });
});
