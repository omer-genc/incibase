// What a command does when it cannot write its output (src/engine/output.ts):
// a reader that went away (`incibase logs shop/prod | head`) ends it quietly
// with exit 0 and stops the child it streams from; any other write error is
// a failure. Each case runs in a child process behind a real pipe.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
let dir: string;
let fixture: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "incibase-output-"));
  fixture = join(dir, "fixture.ts");
  writeFileSync(
    fixture,
    `import { guardOutput } from ${JSON.stringify(join(SRC, "engine", "output.ts"))};
import { processIO } from ${JSON.stringify(join(SRC, "host", "commands.ts"))};
guardOutput();
const [mode, arg] = process.argv.slice(2);
if (mode === "exec") {
  // What logs does with journalctl: each line of the child's output to stdout, as it comes.
  const r = await processIO.exec(["/bin/sh", "-c", arg!], (line) => processIO.out(line));
  process.stderr.write(\`exec returned \${r.code}\\n\`);
} else {
  process.stdout.emit("error", Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC", syscall: "write" }));
  await Bun.sleep(2000);
  process.stderr.write("still running\\n");
}
`,
  );
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a reader that goes away ends the command with exit 0, no stack trace, and stops the child", async () => {
  const pidFile = join(dir, "child.pid");
  const status = join(dir, "status");
  const errFile = join(dir, "stderr");
  // Like journalctl -f: a line, a pause (head has exited by then), two more, then quiet for a long time.
  const child = `echo $$ > ${quote(pidFile)}; echo one; sleep 0.5; echo two; echo three; exec sleep 30`;
  const pipeline = `{ ${quote(process.execPath)} ${quote(fixture)} exec ${quote(child)}; echo $? > ${quote(status)}; } 2> ${quote(errFile)} | head -n 1`;
  const proc = Bun.spawn(["/bin/sh", "-c", pipeline], { stdout: "pipe", stderr: "pipe" });
  const pid = async () => Number((await Bun.file(pidFile).text().catch(() => "")).trim()) || null;
  try {
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out).toBe("one\n");
    expect(readFileSync(errFile, "utf8")).toBe("");
    expect(readFileSync(status, "utf8").trim()).toBe("0");
    const child = (await pid())!;
    const deadline = Date.now() + 5000;
    while (alive(child) && Date.now() < deadline) await Bun.sleep(50);
    expect(alive(child)).toBe(false);
  } finally {
    // A failing run leaves nothing behind.
    proc.kill();
    const child = await pid();
    if (child && alive(child)) process.kill(child);
  }
}, 15_000);

test("any other write error on stdout is a failure, said on stderr", async () => {
  const proc = Bun.spawn([process.execPath, fixture, "enospc"], { stdout: "pipe", stderr: "pipe" });
  const [, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(code).toBe(1);
  expect(err).toBe("incibase: cannot write to stdout: ENOSPC: no space left on device, write\n");
}, 15_000);
