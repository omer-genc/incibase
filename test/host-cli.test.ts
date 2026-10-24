// The owner's commands (design section 7) on a fake host, in process:
// argument parsing, table and --json output, usage errors (exit 2), the
// root requirement, release from stdin, env import, admin-key's two
// meanings, logs, help; and `incibase tunnel` against a fake ssh on PATH.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { manifestLine, sha256Hex, type BundleManifest } from "../src/engine/manifest.ts";
import { VERSION } from "../src/engine/version.ts";
import { hostedAdminKey } from "../src/cli.ts";
import { formatBytes, parseEnvImport, processIO, runCommand, table, type CommandIO } from "../src/host/commands.ts";
import type { OpsContext } from "../src/host/context.ts";
import type { DoctorContext } from "../src/host/doctor.ts";
import { HostLayout } from "../src/host/layout.ts";
import { Registry } from "../src/host/registry.ts";
import { indexEntry } from "../src/host/tunnel.ts";
import * as ops from "../src/host/ops.ts";
import { SystemdDriver } from "../src/host/systemd.ts";
import { closeOpsHosts, fakeBundle, fakeOpsHost, type OpsTestHost } from "./host-helpers.ts";

afterEach(closeOpsHosts);

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const PROD_HOST = "prod--shop.incibase.example.net";

interface Session {
  host: OpsTestHost;
  out: string[];
  err: string[];
  execs: string[][];
  opened: string[];
  /** Runs `incibase <argv>`; its exit code. */
  run(...argv: string[]): Promise<number>;
  stdin: Uint8Array;
  root: boolean;
  execCode: number;
  /** What the command `exec` runs prints: stdout lines and stderr. */
  execOutput: string[];
  execStderr: string;
  /** Whether each open was allowed to create a host. */
  creates: boolean[];
  /** What open gives for these roots; `host` for any other. */
  contexts: Record<string, OpsContext>;
  /** Output of the last run only. */
  last(): { out: string; err: string };
}

async function session(): Promise<Session> {
  const host = await fakeOpsHost();
  let mark = { out: 0, err: 0 };
  const s: Session = {
    host,
    out: [],
    err: [],
    execs: [],
    opened: [],
    stdin: new Uint8Array(),
    root: true,
    execCode: 0,
    execOutput: [],
    execStderr: "",
    creates: [],
    contexts: {},
    async run(...argv) {
      mark = { out: s.out.length, err: s.err.length };
      return runCommand(argv, io);
    },
    last: () => ({ out: s.out.slice(mark.out).join("\n"), err: s.err.slice(mark.err).join("\n") }),
  };
  const io: CommandIO = {
    out: (line) => void s.out.push(line),
    err: (line) => void s.err.push(line),
    async readStdin(max) {
      if (s.stdin.byteLength > max) throw new ops.OpError("INVALID", "stdin is too large");
      return s.stdin;
    },
    isRoot: () => s.root,
    open({ root, create }) {
      s.opened.push(root);
      s.creates.push(create === true);
      return { ctx: s.contexts[root] ?? host, close() {} };
    },
    async exec(argv, line) {
      s.execs.push(argv);
      for (const text of s.execOutput) line(text);
      return { code: s.execCode, stderr: s.execStderr };
    },
    env: {},
  };
  return s;
}

async function shop(): Promise<Session> {
  const s = await session();
  expect(await s.run("project", "create", "shop")).toBe(0);
  return s;
}

/** A bundle whose manifest says it reads these env names. */
function bundleReading(dir: string, name: string, envNames: string[]): string {
  const body = `export default ${JSON.stringify(name)};\n`;
  const manifest: BundleManifest = {
    format: 1,
    incibaseVersion: VERSION,
    sha256: sha256Hex(body),
    createdAt: new Date().toISOString(),
    app: { functions: [], tables: {}, crons: [], http: [] },
    envNames,
  };
  const path = join(dir, `${name}.ib`);
  writeFileSync(path, `${manifestLine(manifest)}\n${body}`);
  return path;
}

const json = (s: Session) => JSON.parse(s.last().out);

describe("help and usage", () => {
  test("host --help lists every host command and op; per-command help lists its flags", async () => {
    const s = await session();
    expect(await s.run("host", "--help")).toBe(0);
    const help = s.last().out;
    for (const c of ["init", "add-admin", "render", "status", "doctor", "check", "gc", "install-runtime", "use-cli", "runtimes", "set", "tls", "op <name>"]) {
      expect(help).toContain(`incibase host ${c}`);
    }
    expect(await s.run("branch", "create", "--help")).toBe(0);
    expect(s.last().out).toContain("Usage: sudo incibase branch create <project>/<branch> [flags]");
    for (const f of ["--kind <prod|dev|preview>", "--protected", "--runtime <x.y.z>", "--root <dir>", "--json"]) expect(s.last().out).toContain(f);
    expect(await s.run("release", "add", "-h")).toBe(0);
    expect(s.last().out).toContain("--no-preflight");
    // No ssh -t with stdin redirected: ssh allocates no terminal then, so sudo cannot ask for a password.
    expect(s.last().out).toContain("scp app.ib vps: && ssh -t vps sudo incibase release add shop/prod app.ib");
    expect(s.last().out).toContain("needs passwordless sudo");
    expect(s.last().out).toContain("  ssh vps sudo incibase release add shop/prod - < app.ib");
    expect(s.last().out).not.toContain("ssh -t vps sudo incibase release add shop/prod - <");
    expect(await s.run("env", "set", "--help")).toBe(0);
    expect(s.last().out).toContain("For secrets use env import <project>/<branch> - (stdin)");
    expect(await s.run("branch")).toBe(0);
    expect(s.last().out).toContain("incibase branch upgrade <project>/<branch>");
    // Help needs neither root nor a host.
    s.root = false;
    expect(await s.run("logs", "--help")).toBe(0);
    expect(s.opened).toEqual([]);
  });

  test("usage errors exit 2 before root or the host are looked at", async () => {
    const s = await session();
    s.root = false;
    const cases: [string[], RegExp][] = [
      [["branch", "create", "shop/dev", "--bogus"], /Unknown option '--bogus'/],
      [["branch", "create"], /branch create takes <project>\/<branch>/],
      [["branch", "create", "shop"], /Expected <project>\/<branch>/],
      [["branch", "create", "Shop/dev"], /lowercase/],
      [["branch", "start", "shop/dev", "extra"], /unexpected "extra"/],
      [["branch", "frobnicate", "shop/dev"], /unknown command "branch frobnicate"/],
      [["release", "add", "shop/dev"], /release add takes/],
      [["service-key", "revoke", "shop/dev"], /takes <project>\/<branch> <id>/],
      [["host", "add-admin"], /takes <unix user>/],
      // Checks of the flags and arguments alone also come before root and the host.
      [["host", "init"], /--domain is required/],
      [["host", "init", "--domain", "x.example.net", "--https-port", "http"], /--https-port takes a whole number/],
      [["host", "init", "--domain", "x.example.net", "--layout", "{"], /--layout takes a JSON object/],
      [["host", "gc", "--older-than", "soon"], /--older-than takes/],
      [["host", "set", "colour", "blue"], /Unknown setting "colour"/],
      [["host", "set", "https_port", "0"], /--https_port takes/],
      [["host", "tls", "--cert", "c.pem"], /--cert and --key are required/],
      [["project", "create", "Shop"], /lowercase/],
      [["branch", "list", "Shop"], /lowercase/],
      [["branch", "create", "shop/dev", "--kind", "staging"], /--kind takes/],
      [["branch", "set", "shop/dev"], /Nothing to change/],
      [["branch", "set", "shop/dev", "--memory", "lots"], /--memory: Invalid size/],
      [["branch", "upgrade", "shop/dev"], /--runtime is required/],
      [["release", "add", "shop/dev", "app.ib", "--preflight", "--no-preflight"], /not both/],
      [["release", "rollback", "shop/dev", "--to", "last"], /--to takes/],
      [["env", "set", "shop/dev", "NOVALUE"], /Expected NAME=VALUE/],
      [["service-key", "create", "shop/dev"], /--label is required/],
      [["service-key", "revoke", "shop/dev", "../etc"], /not a service key id/],
      [["status", "Shop"], /lowercase/],
      [["logs", "shop/dev", "--lines", "0"], /--lines takes/],
    ];
    for (const [argv, message] of cases) {
      expect({ argv, code: await s.run(...argv) }).toEqual({ argv, code: 2 });
      expect(s.last().err).toMatch(message);
    }
    expect(s.opened).toEqual([]);
  });

  test("usage errors found by the op or a value check are exit 2 as well; --json prints them as JSON", async () => {
    const s = await shop();
    expect(await s.run("branch", "set", "shop/dev", "--memory", "lots")).toBe(2);
    expect(s.last().err).toContain("--memory: Invalid size");
    expect(await s.run("branch", "set", "shop/dev")).toBe(2);
    expect(s.last().err).toContain("Nothing to change");
    expect(await s.run("branch", "set", "shop/dev", "--memory", "1M")).toBe(2);
    expect(s.last().err).toContain("memoryMax");
    expect(await s.run("branch", "set", "shop/dev", "--timeouts", "query=forever")).toBe(2);
    expect(await s.run("logs", "shop/dev", "--lines", "-3")).toBe(2);
    expect(await s.run("host", "init")).toBe(2);
    expect(s.last().err).toContain("--domain is required");
    expect(await s.run("service-key", "create", "shop/dev", "--json")).toBe(2);
    expect(JSON.parse(s.last().err)).toEqual({ error: { code: "USAGE", message: "--label is required" } });
    expect(await s.run("service-key", "create", "shop/dev", "--label", "x", "--scopes", "root", "--json")).toBe(2);
    expect(JSON.parse(s.last().err).error.code).toBe("INVALID");
  });

  test("every host command needs root and says so; it exits 1 without opening the host", async () => {
    const s = await session();
    s.root = false;
    for (const argv of [["status"], ["host", "status"], ["project", "list"], ["branch", "info", "shop/dev"], ["admin-key", "shop/dev"], ["logs", "shop/dev", "-f"]]) {
      expect(await s.run(...argv)).toBe(1);
      expect(s.last().err).toContain(`runs on the server as root: sudo incibase ${argv[0]}`);
    }
    expect(s.opened).toEqual([]);
  });

  test("--root picks the host root, then $INCIBASE_HOST_ROOT, then the default", async () => {
    const s = await session();
    await s.run("project", "list", "--root", "/srv/other");
    await s.run("project", "list");
    expect(s.opened).toEqual(["/srv/other", "/var/lib/incibase"]);
  });

  test("only host init may set up a host; any other command refuses a root that has none", async () => {
    const s = await session();
    expect(await s.run("host", "init", "--domain", "incibase.example.net")).toBe(0);
    await s.run("status");
    expect(s.creates).toEqual([true, false]);
    // The real open: a mistyped --root is refused before a registry is created there.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "incibase-noroot-")));
    try {
      expect(() => processIO.open({ root: join(dir, "typo") })).toThrow(`No incibase host at ${join(dir, "typo")}: run sudo incibase host init`);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("host", () => {
  test("init (again, same layout) prints what it set up; --json the op's result", async () => {
    const s = await session();
    expect(await s.run("host", "init", "--domain", "incibase.example.net", "--timezone", "Europe/Istanbul")).toBe(0);
    expect(s.last().out).toContain("is set up for incibase.example.net");
    expect(s.last().out).toContain("front door: not configured yet");
    expect(await s.run("host", "init", "--domain", "incibase.example.net", "--json")).toBe(0);
    expect(json(s)).toMatchObject({ domain: "incibase.example.net", layout: { unitPrefix: "incibase" } });
    expect(await s.run("host", "init", "--domain", "Bad_Domain")).toBe(2);
    expect(await s.run("host", "init", "--domain", "incibase.example.net", "--trust-proxy", "akamai")).toBe(2);
    expect(await s.run("host", "init", "--domain", "incibase.example.net", "--layout", "{nope")).toBe(2);
  });

  test("init of a second root with this host's layout is refused, exit 1: one machine, one host", async () => {
    const s = await session();
    const { layout: first } = s.host;
    const layout = new HostLayout({ root: join(s.host.dir, "second"), runtimeRoot: first.runtimeRoot, systemdDir: first.systemdDir, cliLink: first.cliLink });
    const registry = Registry.open(layout);
    s.contexts[layout.root] = { ...s.host, layout, registry };
    try {
      expect(await s.run("host", "init", "--domain", "incibase.example.net", "--root", layout.root)).toBe(1);
      expect(s.last().err).toStartWith(`incibase host init: This machine already has the incibase host at ${first.root}: one machine runs one host`);
      expect(await s.run("host", "init", "--domain", "incibase.example.net", "--root", layout.root, "--json")).toBe(1);
      expect(JSON.parse(s.last().err)).toMatchObject({ error: { code: "CONFLICT" } });
      expect(registry.getSetting("layout")).toBeNull();
      // The host itself inits again.
      expect(await s.run("host", "init", "--domain", "incibase.example.net")).toBe(0);
    } finally {
      registry.close();
    }
  });

  test("init names the next step while the CLI link, which the check timer runs, leads to no installed runtime", async () => {
    const s = await session();
    const link = s.host.layout.cliLink;
    const download = "/home/omer/incibase-linux-x64";
    s.host.self = [download];
    expect(await s.run("host", "init", "--domain", "incibase.example.net")).toBe(0);
    // Next goes through this host's link (not the machine's own incibase), with --root unless it is the default.
    expect(s.last().out).toEndWith(`  check timer: every 30 s, runs ${link} (runtime ${VERSION})\nNext: sudo ${link} host add-admin <you>, then sudo ${link} project create <slug>`);
    const other = "/var/lib/incibase-ck";
    expect(await s.run("host", "init", "--domain", "incibase.example.net", "--root", other)).toBe(0);
    expect(s.last().out).toEndWith(`Next: sudo ${link} host add-admin <you> --root ${other}, then sudo ${link} project create <slug> --root ${other}`);
    // The first init, from a download: no link yet, the runtime not installed (its file gone).
    const installed = s.host.layout.runtimeBinary(VERSION);
    s.host.sys.remove(link);
    renameSync(installed, `${installed}.away`);
    expect(await s.run("host", "init", "--domain", "incibase.example.net")).toBe(0);
    expect(s.last().out).toContain(
      `  check timer: waits for ${link} (host use-cli), skipping every run until then\n` +
        `Next: sudo ${download} host install-runtime ${download} --version ${VERSION} --sums SHA256SUMS, then sudo ${download} host use-cli ${VERSION}`,
    );
    expect(await s.run("host", "init", "--domain", "incibase.example.net", "--root", other)).toBe(0);
    expect(s.last().out).toEndWith(
      `Next: sudo ${download} host install-runtime ${download} --version ${VERSION} --sums SHA256SUMS --root ${other}, then sudo ${download} host use-cli ${VERSION} --root ${other}`,
    );
    renameSync(`${installed}.away`, installed);
    // Installed but someone else's: install-runtime of the same bytes would leave it so, and use-cli refuses it.
    s.host.sys.own(installed, 1000, 1000);
    expect(await s.run("host", "init", "--domain", "incibase.example.net")).toBe(0);
    expect(s.last().out).toContain(
      `Next: make ${installed}, ${s.host.layout.runtimeDir(VERSION)} and ${s.host.layout.runtimeRoot} root's and writable by root alone ` +
        `(chown root:root ${installed}; chmod go-w ${installed}, and the same for the two directories), then sudo ${download} host use-cli ${VERSION}`,
    );
    // Installed: only use-cli is left; a file in the link's place needs --replace.
    s.host.sys.own(installed, 0, 0);
    writeFileSync(link, "#!/bin/sh\n", { mode: 0o755 });
    expect(await s.run("host", "init", "--domain", "incibase.example.net")).toBe(0);
    expect(s.last().out).toContain(`  check timer: runs ${link}, which is a file, not a link to an installed runtime\nNext: sudo ${download} host use-cli ${VERSION} --replace`);
    // What use-cli cannot put right (it would make the same link again): Next is the fix itself.
    const binary = s.host.layout.runtimeBinary(VERSION);
    s.host.sys.remove(link);
    s.host.sys.symlink(binary, link);
    s.host.sys.own(binary, 1000, 1000);
    expect(await s.run("host", "init", "--domain", "incibase.example.net")).toBe(0);
    expect(s.last().out).toContain(
      `  check timer: runs ${link}, which points at ${binary}, a runtime in ${s.host.layout.runtimeRoot} that someone other than root can change\n` +
        `Next: make ${binary}, ${s.host.layout.runtimeDir(VERSION)} and ${s.host.layout.runtimeRoot} root's and writable by root alone`,
    );
    s.host.sys.own(binary, 0, 0);
    s.host.sys.remove(link);
    // The link's directory not there yet (a custom layout): root creates it first.
    const dir = dirname(link);
    rmSync(dir, { recursive: true });
    expect(await s.run("host", "init", "--domain", "incibase.example.net")).toBe(0);
    expect(s.last().out).toContain(`  check timer: waits for ${link} (host use-cli), skipping every run until then\nNext: sudo install -d -m 0755 ${dir}, then sudo ${download} host use-cli ${VERSION}`);
    s.host.sys.mkdir(dir, 0o755);
    expect(await s.run("host", "init", "--domain", "incibase.example.net", "--no-check-timer")).toBe(0);
    expect(s.last().out).toContain(`  check timer: off\nNext: sudo ${download} host use-cli ${VERSION}`);
    // A host in use, run again: once the link runs the check, nothing is next.
    s.host.sys.symlink(s.host.layout.runtimeBinary(VERSION), link);
    await ops.createProject(s.host, { slug: "shop", branches: [] });
    expect(await s.run("host", "init", "--domain", "incibase.example.net")).toBe(0);
    expect(s.last().out).toEndWith("  check timer: off");
    expect(s.last().out).not.toContain("Next:");
  });

  test("add-admin adds login accounts to the admin group, once; never system accounts", async () => {
    const s = await session();
    const sys = s.host.sys;
    sys.users.set("omer", { name: "omer", uid: 1000, gid: 1000, gecos: "", home: "/home/omer", shell: "/bin/bash" });
    sys.users.set("www-data", { name: "www-data", uid: 33, gid: 33, gecos: "", home: "/var/www", shell: "/usr/sbin/nologin" });
    expect(await s.run("host", "add-admin", "omer")).toBe(0);
    expect(s.last().out).toBe("Added omer to incibase-admin; it applies to their next SSH login");
    expect(sys.groups.get("incibase-admin")!.members).toEqual(["omer"]);
    expect(await s.run("host", "add-admin", "omer", "--json")).toBe(0);
    expect(json(s)).toEqual({ user: "omer", group: "incibase-admin", added: false });
    expect(await s.run("host", "add-admin", "www-data")).toBe(2);
    expect(s.last().err).toContain("not a login account");
    expect(await s.run("host", "add-admin", "nobody-here")).toBe(1);
    expect(s.last().err).toContain("No user nobody-here");
    expect(await s.run("host", "add-admin", "-rf")).toBe(2);
    // A branch's own user is a system account, so it is refused too.
    await ops.createProject(s.host, { slug: "shop", branches: ["dev"] });
    const dev = s.host.registry.findBranch("shop", "dev")!;
    expect(await s.run("host", "add-admin", `ib-${dev.id}`)).toBe(2);
    expect(sys.groups.get("incibase-admin")!.members).toEqual(["omer"]);
    // Two that ran and the missing user (bad input is not audited).
    expect(s.host.registry.listAudit().filter((a) => a.action === "host.add_admin").map((a) => a.ok)).toEqual([1, 1, 0]);
  });

  test("status, render, runtimes, gc and set", async () => {
    const s = await shop();
    expect(await s.run("host", "status")).toBe(0);
    const text = s.last().out;
    expect(text).toContain("domain      incibase.example.net  (time zone Europe/Istanbul)");
    expect(text).toContain("front door  https port 443, trust proxy none, certificate none");
    expect(text).toContain(`runtimes    ${VERSION} (cli)`.replace(" (cli)", ""));
    expect(text).toContain("branches    2 in 1 project(s)");
    expect(text).toContain("alerts: none firing");
    expect(await s.run("host", "status", "--json")).toBe(0);
    expect(json(s)).toMatchObject({ domain: "incibase.example.net", branches: { total: 2 }, alertWebhook: null });

    expect(await s.run("host", "render")).toBe(0);
    expect(s.last().out).toContain("rendered 2 branch(es)");

    expect(await s.run("host", "runtimes")).toBe(0);
    expect(s.last().out.split("\n")[0]).toMatch(/^VERSION\s+SHA256\s+CLI\s+FILE\s+PINNED BY$/);
    expect(s.last().out).toContain("shop/dev, shop/prod");

    expect(await s.run("host", "gc", "--older-than", "3")).toBe(0);
    expect(s.last().out).toContain("trash: nothing to remove");
    expect(await s.run("host", "gc", "--older-than", "soon")).toBe(2);

    expect(await s.run("host", "set", "alert_webhook", "https://ntfy.sh/incibase-test")).toBe(0);
    expect(s.last().out).toBe("alert_webhook set (ntfy.sh)");
    expect(await s.run("host", "set", "alert_webhook", "http://ntfy.sh/x")).toBe(2);
    expect(await s.run("host", "set", "colour", "blue")).toBe(2);
    expect(await s.run("host", "set", "trust_proxy", "akamai")).toBe(2);
    expect(await s.run("host", "set", "alert_webhook", "")).toBe(0);
    expect(s.last().out).toBe("alert_webhook removed");
  });

  test("host set alert_webhook - reads the URL from stdin: one line, trimmed, checked like an argument", async () => {
    const s = await session();
    const stdin = (text: string) => void (s.stdin = new TextEncoder().encode(text));
    stdin("  https://ntfy.sh/incibase-Xk3q9  \r\n\n");
    expect(await s.run("host", "set", "alert_webhook", "-")).toBe(0);
    expect(s.last().out).toBe("alert_webhook set (ntfy.sh)");
    expect(s.host.registry.getSetting("alert_webhook")).toBe("https://ntfy.sh/incibase-Xk3q9");
    // Every refusal leaves the saved URL as it was, and none repeats what stdin held.
    for (const [text, said] of [
      ["", "stdin is empty"],
      [" \n\n", "stdin is empty"],
      ["https://ntfy.sh/a\nhttps://ntfy.sh/b\n", "more than one line"],
      ["http://ntfy.sh/incibase-plain\n", "must be an https URL"],
      ["https://ntfy.sh/incibase a\n", "without spaces"],
    ] as const) {
      stdin(text);
      expect(await s.run("host", "set", "alert_webhook", "-")).toBe(2);
      expect(s.last().err).toContain(said);
      expect(s.last().err).not.toContain("incibase-plain");
      expect(s.host.registry.getSetting("alert_webhook")).toBe("https://ntfy.sh/incibase-Xk3q9");
    }
    s.stdin = new Uint8Array([0x68, 0xff, 0x0a]);
    expect(await s.run("host", "set", "alert_webhook", "-")).toBe(2);
    expect(s.last().err).toContain("not UTF-8");
    // The size cap is the command's, before anything is decoded.
    stdin(`https://ntfy.sh/${"x".repeat(5000)}\n`);
    expect(await s.run("host", "set", "alert_webhook", "-")).toBe(2);
    expect(s.last().err).toContain("stdin is too large");
    // '' still removes it; - is never taken as the value.
    expect(await s.run("host", "set", "alert_webhook", "")).toBe(0);
    expect(s.host.registry.getSetting("alert_webhook")).toBeNull();
    expect(await s.run("host", "set", "alert_webhook", "--help")).toBe(0);
    expect(s.last().out).toContain("the URL is read from stdin");
  });

  test("install-runtime and use-cli", async () => {
    const s = await session();
    const binary = join(s.host.dir, "incibase-bin");
    const sha = sha256Hex(readFileSync(binary));
    expect(await s.run("host", "install-runtime", "--version", VERSION, binary, "--sha256", sha)).toBe(0);
    expect(s.last().out).toBe(`Already installed: runtime ${VERSION} at ${s.host.layout.runtimeBinary(VERSION)} (sha256 ${sha.slice(0, 16)}...)`);
    expect(await s.run("host", "install-runtime", "--version", VERSION, binary, "--sha256", "0".repeat(64))).toBe(1);
    expect(await s.run("host", "install-runtime", binary, "extra")).toBe(2);
    expect(await s.run("host", "use-cli", VERSION)).toBe(0);
    expect(s.last().out).toBe(`${s.host.layout.cliLink} now runs ${VERSION}`);
  });

  test("doctor prints OK/WARN/FAIL and exits 1 when something fails", async () => {
    const s = await session();
    (s.host as DoctorContext).doctor = {
      command: () => null,
      file: () => null,
      readText: () => null,
      diskUsage: () => ({ usedPercent: 10, availableBytes: 50 * 1024 ** 3 }),
      sandboxProbe: async () => ({ ran: false, reason: "not in this test" }),
    };
    expect(await s.run("host", "doctor")).toBe(1);
    expect(s.last().out).toMatch(/^FAIL systemd: /m);
    expect(await s.run("host", "doctor", "--json")).toBe(1);
    expect(json(s).ok).toBe(false);
  });
});

describe("projects and branches", () => {
  test("project create, list and delete; a deleted project can be created again", async () => {
    const s = await session();
    expect(await s.run("project", "list")).toBe(0);
    expect(s.last().out).toContain("No projects yet");
    expect(s.last().out).toBe(`No projects yet: sudo ${s.host.layout.cliLink} project create <slug>`);
    expect(await s.run("project", "create", "shop", "--branches", "prod,dev", "--name", "The shop")).toBe(0);
    expect(s.last().out).toContain("Created project shop:");
    expect(s.last().out).toContain("shop/prod                prod    https://prod--shop.incibase.example.net");
    expect(s.last().out).toEndWith(`Next: incibase bundle --out app.ib, copy it here, then sudo ${s.host.layout.cliLink} release add shop/prod app.ib`);
    expect(await s.run("project", "create", "shop")).toBe(1);
    expect(s.last().err).toBe("incibase project create: Project shop already exists");
    expect(await s.run("project", "create", "empty", "--branches", "", "--json")).toBe(0);
    expect(json(s)).toMatchObject({ project: { slug: "empty", name: "empty" }, branches: [] });
    expect(await s.run("project", "list")).toBe(0);
    const lines = s.last().out.split("\n");
    expect(lines[0]).toMatch(/^PROJECT\s+NAME\s+CREATED\s+BRANCHES$/);
    expect(lines[1]).toMatch(/^empty\s+empty\s+\S+ \S+\s+-$/);
    expect(lines[2]).toMatch(/^shop\s+The shop\s+\S+ \S+\s+dev, prod$/);

    expect(await s.run("project", "delete", "shop")).toBe(1);
    expect(s.last().err).toContain("still has branches (shop/dev, shop/prod)");
    expect(await s.run("branch", "delete", "shop/dev")).toBe(0);
    expect(await s.run("branch", "delete", "shop/prod")).toBe(1);
    expect(s.last().err).toContain(`confirm with its hostname ${PROD_HOST}`);
    expect(await s.run("branch", "delete", "shop/prod", "--confirm", PROD_HOST)).toBe(0);
    expect(s.last().out).toBe(`Deleted shop/prod; its data stays in ${s.host.layout.trash} for 7 days`);
    expect(await s.run("project", "delete", "shop")).toBe(0);
    expect(await s.run("project", "delete", "shop")).toBe(1);
    expect(s.last().err).toContain("No project shop");
    expect(await s.run("project", "list", "--json")).toBe(0);
    expect(json(s).map((p: { slug: string }) => p.slug)).toEqual(["empty"]);
    expect(await s.run("branch", "create", "shop/dev")).toBe(1);
    expect(s.last().err).toContain("No project shop: create it first");
    expect(await s.run("project", "create", "shop", "--branches", "dev")).toBe(0);
    expect(s.host.registry.findBranch("shop", "dev")!.phase).toBe("ready");
  });

  test("branch create, list, info, set, stop, start, restart and upgrade", async () => {
    const s = await shop();
    expect(await s.run("branch", "create", "shop/feature-x", "--json")).toBe(0);
    expect(json(s)).toMatchObject({ name: "feature-x", kind: "preview", protected: 0 });
    expect(await s.run("branch", "create", "shop/demo", "--kind", "prod", "--unprotected")).toBe(0);
    expect(s.last().out).toBe("Created shop/demo (prod): https://demo--shop.incibase.example.net");
    expect(await s.run("branch", "create", "shop/x", "--kind", "staging")).toBe(2);
    expect(await s.run("branch", "create", "shop/x", "--runtime", "9.9.9")).toBe(1);

    expect(await s.run("branch", "list", "shop")).toBe(0);
    const list = s.last().out.split("\n");
    expect(list[0]).toMatch(/^BRANCH\s+KIND\s+PROTECTED\s+DESIRED\s+ACTUAL\s+RELEASE\s+RUNTIME$/);
    expect(list.find((l) => l.startsWith("shop/prod"))).toMatch(/^shop\/prod\s+prod\s+yes\s+stopped\s+inactive\/dead\s+-\s+/);

    // No release yet: nothing to start.
    expect(await s.run("branch", "start", "shop/dev")).toBe(1);
    expect(s.last().err).toContain("has no release to run: add one first");
    expect(await s.run("release", "add", "shop/dev", fakeBundle(s.host.dir, "one"))).toBe(0);

    expect(await s.run("branch", "info", "shop/dev")).toBe(0);
    const info = s.last().out;
    expect(info).toContain("shop/dev  dev  https://dev--shop.incibase.example.net");
    expect(info).toContain("desired running, actual active/running");
    expect(info).toMatch(/release {3}1 \(live\), generation 1\.\S+, runtime /);
    expect(info).toContain("of 256M (high 230M), cpu 100%, tasks 256");
    expect(info).toMatch(/tunnel {4}port 71\d\d, .*\/admin\/dev--shop\.sock/);
    expect(await s.run("branch", "info", "shop/dev", "--json")).toBe(0);
    expect(json(s)).toMatchObject({ ref: "shop/dev", protected: false, adminSocket: `${s.host.layout.admin}/dev--shop.sock`, env: expect.arrayContaining(["INCIBASE_ADMIN_KEY"]) });

    expect(await s.run("branch", "set", "shop/dev", "--memory", "300M", "--cpu", "50", "--drain-timeout", "5s", "--preflight", "on")).toBe(0);
    expect(s.last().out).toBe("Changed shop/dev: memory 300M, cpu 50%, tasks 256\napplies at the next start (pass --restart to restart now)");
    expect(JSON.parse(s.host.registry.findBranch("shop", "dev")!.config_json)).toEqual({ drainMs: 5000, preflight: true });
    expect(await s.run("branch", "set", "shop/dev", "--tasks", "512", "--restart")).toBe(0);
    expect(s.last().out).toMatch(/restart: healthy after \d+\.\d s$/);
    expect(await s.run("branch", "set", "shop/prod", "--protected", "off")).toBe(1);
    expect(s.last().err).toContain(`confirm with its hostname ${PROD_HOST}`);

    expect(await s.run("branch", "stop", "shop/dev")).toBe(0);
    expect(s.last().out).toBe("Stopped shop/dev; start it with incibase branch start");
    expect(s.host.driver.isActive(s.host.layout.units.branch(s.host.registry.findBranch("shop", "dev")!.id))).toBe(false);
    expect(await s.run("branch", "start", "shop/dev")).toBe(0);
    expect(s.last().out).toMatch(/^shop\/dev start: healthy after/);
    expect(await s.run("branch", "restart", "shop/dev", "--json")).toBe(0);
    expect(json(s).gate.ok).toBe(true);
    expect(await s.run("branch", "stop", "shop/prod")).toBe(1);
    expect(await s.run("branch", "stop", "shop/prod", "--confirm", PROD_HOST)).toBe(0);

    expect(await s.run("branch", "upgrade", "shop/dev")).toBe(2);
    expect(await s.run("branch", "upgrade", "shop/dev", "--runtime", "9.9.9")).toBe(1);
    expect(s.last().err).toContain("9.9.9");
    expect(await s.run("branch", "upgrade", "shop/dev", "--runtime", VERSION)).toBe(0);
    expect(s.last().out).toBe(`shop/dev runs runtime ${VERSION}`);
  });

  test("a failed gate exits 1", async () => {
    const s = await shop();
    expect(await s.run("release", "add", "shop/dev", fakeBundle(s.host.dir, "one"))).toBe(0);
    s.host.driver.behavior = () => ({ exit: 1 });
    expect(await s.run("branch", "restart", "shop/dev")).toBe(1);
    expect(s.last().out).toContain("restart FAILED");
  });
});

describe("releases", () => {
  test("add from a file and from stdin follows the job; list and rollback", async () => {
    const s = await shop();
    expect(await s.run("release", "add", "shop/dev", fakeBundle(s.host.dir, "one"))).toBe(0);
    const { out } = s.last();
    expect(out).toMatch(/Release 1 of shop\/dev is live \(generation 1\.\S+\)$/);
    // The job's progress lines came first.
    expect(out.split("\n").length).toBeGreaterThan(1);

    s.stdin = readFileSync(fakeBundle(s.host.dir, "two"));
    expect(await s.run("release", "add", "shop/dev", "-", "--json")).toBe(0);
    const result = json(s);
    expect(result.release).toMatchObject({ seq: 2, status: "live", origin: "cli:stdin" });
    expect(result.release.manifest_json).toBeUndefined();
    // Under --json the progress went to stderr, and stdout is just the JSON.
    expect(s.last().err).not.toBe("");

    s.stdin = new Uint8Array();
    expect(await s.run("release", "add", "shop/dev", "-")).toBe(2);
    expect(s.last().err).toContain("stdin is empty");
    s.stdin = new TextEncoder().encode("not a bundle\n");
    expect(await s.run("release", "add", "shop/dev", "-")).toBe(1);
    expect(await s.run("release", "add", "shop/dev", join(s.host.dir, "missing.ib"))).toBe(1);
    expect(s.last().err).toContain("is not a file");

    expect(await s.run("release", "list", "shop/dev")).toBe(0);
    const rows = s.last().out.split("\n");
    expect(rows[0]).toMatch(/^SEQ\s+STATUS\s+CREATED\s+SHA256\s+SIZE\s+ORIGIN\s+ERROR$/);
    expect(rows[1]).toMatch(/^2\*\s+live\s+.*cli:stdin$/);
    expect(rows[2]).toMatch(/^1\s+superseded\s+/);

    expect(await s.run("release", "rollback", "shop/dev")).toBe(0);
    expect(s.last().out).toMatch(/shop\/dev runs release 1$/);
    expect(s.host.registry.findBranch("shop", "dev")!.release_seq).toBe(1);
    expect(await s.run("release", "rollback", "shop/dev", "--to", "1")).toBe(1);
    expect(s.last().err).toContain("already runs release 1");
    expect(await s.run("release", "rollback", "shop/dev", "--to", "2", "--restore")).toBe(1);
    expect(s.last().err).toContain("No snapshot pre-1");
    expect(await s.run("release", "rollback", "shop/dev", "--to", "zero")).toBe(2);
    expect(await s.run("release", "rollback", "shop/dev", "--snapshot", "../etc")).toBe(2);
  });

  test("a release that fails exits 1 with its error", async () => {
    const s = await shop();
    s.host.driver.behavior = () => ({ exit: 78 });
    expect(await s.run("release", "add", "shop/dev", fakeBundle(s.host.dir, "bad"))).toBe(1);
    expect(s.last().out).toMatch(/Release 1 of shop\/dev is failed: /);
  });
});

describe("env", () => {
  test("parseEnvImport: comments, export, quotes, inline comments; names and newlines are checked", () => {
    const text = [
      "# a comment",
      "",
      "PLAIN=value with spaces   # trailing comment",
      "export EXPORTED=1",
      'DOUBLE="a \\"quoted\\" \\\\ value # not a comment"',
      "SINGLE='literal \\n $HOME'",
      "EMPTY=",
      "HASH=a#b",
      "EQ=x=y",
      "TAB=\"a\tb\"",
      "WINDOWS=crlf\r",
      "PLAIN=last wins",
    ].join("\n");
    expect(parseEnvImport(text)).toEqual({
      PLAIN: "last wins",
      EXPORTED: "1",
      DOUBLE: 'a "quoted" \\ value # not a comment',
      SINGLE: "literal \\n $HOME",
      EMPTY: "",
      HASH: "a#b",
      EQ: "x=y",
      TAB: "a\tb",
      WINDOWS: "crlf",
    });
    const bad: [string, RegExp][] = [
      ["1BAD=x", /line 1: invalid variable name "1BAD"/],
      ["OK=1\nBAD-NAME=x", /line 2: invalid variable name "BAD-NAME"/],
      ["NOEQUALS", /line 1: expected NAME=VALUE/],
      ['PEM="-----BEGIN\nabc\n-----END"', /line 1: PEM: the closing " is missing; values cannot span lines/],
      ["PEM='a\nb'", /line 1: PEM: the closing ' is missing/],
      ['NL="a\\nb"', /line 1: NL: values cannot span lines/],
      ['X="a" junk', /unexpected text after the closing quote/],
      ["# only comments\n\n", /No variables/],
    ];
    for (const [input, message] of bad) expect(() => parseEnvImport(input)).toThrow(message);
  });

  test("set, list, unset and import; restarts only with --restart; import warns about the release's missing names", async () => {
    const s = await shop();
    expect(await s.run("release", "add", "shop/dev", bundleReading(s.host.dir, "reads", ["STRIPE_KEY", "A", "SENTRY_DSN"]))).toBe(0);
    expect(s.last().err).toBe("warning: the release reads A, SENTRY_DSN, STRIPE_KEY, not set on this branch");
    const restarts = () => s.host.driver.calls.filter((c) => c.startsWith("restart")).length;
    const before = restarts();

    expect(await s.run("env", "set", "shop/dev", "A=1", "B=x=y")).toBe(0);
    expect(s.last().out).toBe("Set A, B on shop/dev\napplies at the next start (pass --restart to restart now)");
    expect(restarts()).toBe(before);
    expect(await s.run("env", "set", "shop/dev", "A")).toBe(2);
    expect(await s.run("env", "set", "shop/dev", "PATH=/tmp")).toBe(2);
    expect(s.last().err).toContain("set by the host");
    expect(await s.run("env", "set", "shop/dev", "A=line1\nline2")).toBe(2);
    expect(s.last().err).toContain("must not contain newlines");

    expect(await s.run("env", "list", "shop/dev")).toBe(0);
    expect(s.last().out).toMatch(/^NAME\s+SET BY\n/);
    expect(s.last().out).toMatch(/^A\s+app$/m);
    expect(s.last().out).toMatch(/^INCIBASE_ADMIN_KEY\s+host$/m);
    expect(s.last().out).not.toContain("x=y");
    expect(await s.run("env", "list", "shop/dev", "--show")).toBe(0);
    expect(s.last().out).toMatch(/^B\s+app\s+x=y$/m);
    expect(s.last().out).toMatch(/^INCIBASE_ADMIN_KEY\s+host\s+\(hidden\)$/m);

    const file = join(s.host.dir, ".env");
    writeFileSync(file, "# from the old host\nSTRIPE_KEY='sk_test_123'\nexport C=\"three\"\n");
    expect(await s.run("env", "import", "shop/dev", file)).toBe(0);
    expect(s.last().out).toBe("Imported 2 variable(s) into shop/dev: STRIPE_KEY, C\napplies at the next start (pass --restart to restart now)");
    expect(s.last().err).toBe("warning: the release reads SENTRY_DSN, not set on this branch");
    expect(restarts()).toBe(before);
    const dev = s.host.registry.findBranch("shop", "dev")!;
    expect(s.host.registry.getEnv(dev.id, "STRIPE_KEY")!.value).toBe("sk_test_123");

    s.stdin = new TextEncoder().encode("SENTRY_DSN=https://x@sentry.example/1\n");
    expect(await s.run("env", "import", "shop/dev", "-", "--restart", "--json")).toBe(0);
    expect(json(s)).toMatchObject({ names: ["SENTRY_DSN"], missing: [], restarted: { ok: true } });
    expect(restarts()).toBe(before + 1);
    s.stdin = new TextEncoder().encode("GOOD=1\nBAD NAME=2\n");
    expect(await s.run("env", "import", "shop/dev", "-")).toBe(2);
    expect(s.last().err).toContain('line 2: invalid variable name "BAD NAME"');
    expect(s.host.registry.getEnv(dev.id, "GOOD")).toBeNull();
    expect(await s.run("env", "import", "shop/dev", join(s.host.dir, "nope.env"))).toBe(1);

    expect(await s.run("env", "unset", "shop/dev", "A", "NOT_SET", "--restart")).toBe(0);
    expect(s.last().out).toMatch(/^Removed A from shop\/dev\nrestart: healthy after/);
    expect(s.last().err).toBe("warning: the release reads A, not set on this branch");
    expect(await s.run("env", "unset", "shop/dev", "NOT_SET")).toBe(0);
    expect(s.last().out).toBe("None of them was set");
  });
});

describe("keys", () => {
  test("admin-key prints only the key, so $(ssh host sudo incibase admin-key p/b) works; --rotate restarts", async () => {
    const s = await shop();
    expect(await s.run("admin-key", "shop/dev")).toBe(0);
    const key = s.last().out;
    expect(key).toMatch(/^ik_admin_[A-Za-z0-9_-]+$/);
    expect(s.last().err).toBe("");
    expect(await s.run("admin-key", "shop/dev", "--rotate")).toBe(0);
    expect(s.last().out).not.toBe(key);
    expect(s.last().err).toBe("rotated; the branch reads it at its next start");
    expect(await s.run("admin-key", "shop/dev", "--data", "/tmp/x")).toBe(2);
    expect(s.last().err).toContain("not both");
    expect(await s.run("admin-key", "shop/nope")).toBe(1);
  });

  test("admin-key: <project>/<branch> is a hosted branch's, otherwise the local app's from --data", () => {
    expect(hostedAdminKey(["shop/prod"])).toBe(true);
    expect(hostedAdminKey(["shop/prod", "--rotate"])).toBe(true);
    expect(hostedAdminKey([])).toBe(false);
    expect(hostedAdminKey(["--data", "./a/b"])).toBe(false);
    expect(hostedAdminKey(["--data=./a/b"])).toBe(false);
    expect(hostedAdminKey(["incibase_data"])).toBe(false);
    // Flags may come first, as with every hosted command; values of --data and --root are not the <project>/<branch>.
    expect(hostedAdminKey(["--rotate", "shop/prod"])).toBe(true);
    expect(hostedAdminKey(["--root", "/var/lib/x", "shop/prod"])).toBe(true);
    expect(hostedAdminKey(["--root=/var/lib/x", "shop/prod"])).toBe(true);
    expect(hostedAdminKey(["--json", "shop/prod"])).toBe(true);
    expect(hostedAdminKey(["--root", "/var/lib/x"])).toBe(true);
    expect(hostedAdminKey(["--data", "./a/b", "--dir", "src/x"])).toBe(false);
    expect(hostedAdminKey(["--data", "./a/b", "shop/prod"])).toBe(true);
    expect(hostedAdminKey(["--data", "x", "--rotate"])).toBe(true);
    expect(hostedAdminKey(["--", "shop/prod"])).toBe(true);
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "incibase-cli-")));
    try {
      const run = (...args: string[]) => Bun.spawnSync([process.execPath, CLI, ...args], { stdout: "pipe", stderr: "pipe", cwd: dir, env: { ...process.env, INCIBASE_ADMIN_KEY: "" } });
      // The app-level command, as before: a data dir without a database.
      const local = run("admin-key", "--data", join(dir, "data"));
      expect(local.exitCode).toBe(1);
      expect(local.stderr.toString()).toContain(`No database at ${join(dir, "data", "data.db")}`);
      // The hosted one wants root on the server.
      const hosted = run("admin-key", "shop/prod");
      expect(hosted.exitCode).toBe(1);
      expect(hosted.stderr.toString()).toContain("runs on the server as root: sudo incibase admin-key");
      expect(run("admin-key", "shop/prod", "--data", "x").exitCode).toBe(2);
      for (const args of [["--rotate", "shop/prod"], ["--root", "/var/lib/x", "shop/prod"], ["--json", "shop/prod"]]) {
        const r = run("admin-key", ...args);
        expect({ args, code: r.exitCode }).toEqual({ args, code: 1 });
        expect(r.stderr.toString()).toContain("runs on the server as root: sudo incibase admin-key");
      }
      // Hosted-only flags without a <project>/<branch>, or with --data: usage errors of the hosted command, not the app's help.
      for (const args of [["--root", "/var/lib/x"], ["--data", "x", "--rotate"], ["--data", "x", "shop/prod"]]) {
        const r = run("admin-key", ...args);
        expect({ args, code: r.exitCode }).toEqual({ args, code: 2 });
        expect(r.stdout.toString()).not.toContain("Commands:");
      }
      // Hosted commands are routed, and the app's help still lists both.
      expect(run("status", "--bogus").exitCode).toBe(2);
      expect(run("--help").stdout.toString()).toContain("admin-key <project>/<branch>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("service-key create prints the key once on stdout; list never shows it; revoke checks the branch", async () => {
    const s = await shop();
    expect(await s.run("service-key", "create", "shop/dev", "--label", "ci server", "--scopes", "internal,upload")).toBe(0);
    const key = s.last().out;
    expect(key).toMatch(/^ik_svc_k[0-9a-z]{9}_/);
    const id = /^ik_svc_(k[0-9a-z]{9})_/.exec(key)![1]!;
    expect(s.last().err).toContain(`Created service key ${id} for shop/dev; store it now, it is not shown again`);
    expect(await s.run("service-key", "create", "shop/prod", "--label", "other", "--json")).toBe(0);
    const { id: otherId, key: otherKey } = json(s) as { id: string; key: string };
    expect(otherKey.startsWith(`ik_svc_${otherId}_`)).toBe(true);

    expect(await s.run("service-key", "list", "shop/dev")).toBe(0);
    const list = s.last().out;
    expect(list).toMatch(new RegExp(`^${id}\\s+ci server\\s+internal,upload\\s+\\S+ \\S+\\s+-$`, "m"));
    expect(list).not.toContain(key);
    expect(await s.run("service-key", "list", "shop/dev", "--json")).toBe(0);
    expect(JSON.stringify(json(s))).not.toContain("sha256");

    expect(await s.run("service-key", "revoke", "shop/dev", otherId)).toBe(1);
    expect(s.last().err).toContain(`No service key ${otherId} on shop/dev`);
    expect(await s.run("service-key", "revoke", "shop/dev", "../etc")).toBe(2);
    expect(await s.run("service-key", "revoke", "shop/dev", id)).toBe(0);
    expect(s.last().out).toBe(`Revoked ${id}; the branch is not running`);
    expect(await s.run("service-key", "revoke", "shop/dev", id)).toBe(1);
    expect(s.last().err).toContain("already revoked");
  });
});

describe("status and logs", () => {
  test("status: every branch's desired and actual state, release, generation, memory; and the alerts", async () => {
    const s = await shop();
    expect(await s.run("release", "add", "shop/dev", fakeBundle(s.host.dir, "one"))).toBe(0);
    await s.host.registry.withLock(() => s.host.registry.raiseAlert("branch:test", "something is off", 1_800_000_000_000));
    expect(await s.run("status")).toBe(0);
    const lines = s.last().out.split("\n");
    expect(lines[0]).toMatch(/^BRANCH\s+KIND\s+DESIRED\s+ACTUAL\s+RELEASE\s+GENERATION\s+MEMORY\s+URL$/);
    expect(lines[1]).toMatch(/^shop\/dev\s+dev\s+running\s+active\/running\s+1 live\s+1\.\S+\s+\S+\/256M\s+https:\/\/dev--shop\.incibase\.example\.net$/);
    expect(lines[2]).toMatch(/^shop\/prod\s+prod\s+stopped\s+inactive\/dead\s+-\s+-\s+-\/512M\s+https:\/\/prod--shop/);
    expect(lines.slice(3)).toEqual(["alerts:", "  FIRING branch:test: something is off (since 2027-01-15 08:00Z)"]);
    expect(await s.run("status", "shop/dev", "--json")).toBe(0);
    expect(json(s)).toMatchObject({ branches: [{ ref: "shop/dev", desired: "running", release: 1, actual: { activeState: "active" } }], alerts: [{ key: "branch:test" }] });
    expect(await s.run("status", "shop/nope")).toBe(1);
    expect(await s.run("status", "Shop")).toBe(2);
  });

  test("logs runs journalctl on this terminal with the flags given", async () => {
    const s = await shop();
    const unit = s.host.layout.units.branch(s.host.registry.findBranch("shop", "dev")!.id);
    expect(await s.run("logs", "shop/dev", "-f", "--errors", "--since", "1 hour ago", "--lines", "50")).toBe(0);
    expect(s.execs.at(-1)).toEqual(["journalctl", "--unit", unit, "--lines", "50", "--since", "1 hour ago", "--grep", '"level":"error"', "--follow"]);
    expect(await s.run("logs", "shop/dev", "--json")).toBe(0);
    expect(s.execs.at(-1)).toEqual(["journalctl", "--unit", unit, "--output", "json"]);
    expect(s.last().out).toBe("");
    // journalctl --grep exits 1, silently, when nothing matched; anything else failing is passed on.
    s.execCode = 1;
    expect(await s.run("logs", "shop/dev", "--errors")).toBe(0);
    expect(await s.run("logs", "shop/dev")).toBe(1);
    expect(await s.run("logs", "shop/dev", "--since", "$(reboot)")).toBe(2);
    // A --since journalctl cannot read is a usage error, with --errors too; not "no matches".
    s.execStderr = "Failed to parse timestamp: abc\n";
    for (const extra of [[], ["--errors"]]) {
      expect(await s.run("logs", "shop/dev", "--since", "abc", ...extra)).toBe(2);
      expect(s.last().err).toContain('--since: journalctl cannot read "abc"');
    }
    s.execStderr = "Failed to open journal: \u001b[2Jno space\n";
    expect(await s.run("logs", "shop/dev", "--errors")).toBe(1);
    expect(s.last().err).toBe("Failed to open journal: ?[2Jno space");
  });

  test("logs prints the tenant's lines without control characters, so escape sequences never reach root's terminal", async () => {
    const s = await shop();
    s.execOutput = ["before\u001b]0;PWNED\u0007\u001b[2Jafter", "tab\there\rcr", "\u009b31mC1"];
    expect(await s.run("logs", "shop/dev", "-f")).toBe(0);
    expect(s.last().out.split("\n")).toEqual(["before?]0;PWNED??[2Jafter", "tab\there?cr", "?31mC1"]);
    expect(s.last().out).not.toMatch(/[\u001b\u0007\u009b\r]/);
  });

  test("processIO.exec reads the child's stdout line by line (never inherited) and hands back its code and stderr", async () => {
    const lines: string[] = [];
    const r = await processIO.exec(["/bin/sh", "-c", "printf 'one\\033[2J\\ntwo'; printf 'oops\\n' >&2; exit 3"], (line) => lines.push(line));
    expect(lines).toEqual(["one\u001b[2J", "two"]);
    expect(r).toEqual({ code: 3, stderr: "oops\n" });
    // A line longer than 64 KiB is split, not held.
    const long: string[] = [];
    await processIO.exec(["/bin/sh", "-c", "head -c 70000 /dev/zero | tr '\\0' a"], (line) => long.push(line));
    expect(long.map((l) => l.length)).toEqual([65536, 70000 - 65536]);
  });

  test("the systemd driver's journalctl command for logs --errors", () => {
    expect(new SystemdDriver().journalCommand({ unit: "incibase-branch@b0000000.service", grep: ops.ERROR_LINES, since: "1 hour ago", follow: true })).toEqual([
      "journalctl", "--unit", "incibase-branch@b0000000.service", "--output", "cat", "--no-pager", "--since", "1 hour ago", "--grep", '"level":"error"', "--follow",
    ]);
  });

  test("table pads columns and cleans control characters; formatBytes", () => {
    expect(table(["A", "BB"], [["x\u001b[31m", "y"], ["long one", null]])).toEqual(["A         BB", "x?[31m    y", "long one  -"]);
    expect([formatBytes(null), formatBytes(512), formatBytes(2048), formatBytes(256 * 1024 * 1024), formatBytes(1.5 * 1024 ** 3)]).toEqual(["-", "512B", "2K", "256M", "1.5G"]);
  });
});

// ---- tunnel --------------------------------------------------------------------------------

const FAKE_SSH = `#!${process.execPath}
// Plays ssh: "cat <index>" prints $FAKE_SSH_INDEX; "-N -L 127.0.0.1:<port>:<socket>" serves /api/health on that port.
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const log = (entry) => appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify(entry) + "\\n");
log(args);
const mode = process.env.FAKE_SSH_MODE ?? "ok";
if (!args.includes("-N")) {
  if (mode === "denied") { process.stderr.write("cat: /var/lib/incibase/admin/index.json: Permission denied\\n"); process.exit(1); }
  process.stdout.write(readFileSync(process.env.FAKE_SSH_INDEX));
  process.exit(0);
}
if (mode === "refused") { process.stderr.write("channel_setup_fwd_listener_tcpip: cannot listen to port\\n"); process.exit(255); }
const port = Number(args[args.indexOf("-L") + 1].split(":")[1]);
let server = null;
process.on("SIGTERM", () => { log("SIGTERM"); server?.stop(true); process.exit(0); });
await Bun.sleep(Number(process.env.FAKE_SSH_DELAY ?? 0));
server = Bun.serve({ hostname: "127.0.0.1", port, fetch: (req) => new URL(req.url).pathname === "/api/health" ? Response.json({ ok: true }) : new Response("dashboard") });
log("listening");
setInterval(() => {}, 1000);
`;

interface Tunnel {
  dir: string;
  port: number;
  log(): unknown[];
  spawn(args: string[], env?: Record<string, string>): ReturnType<typeof Bun.spawn>;
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = server.port!;
  server.stop(true);
  return port;
}

const tunnels: string[] = [];
afterEach(() => {
  for (const dir of tunnels.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function tunnelSetup(): Promise<Tunnel> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "incibase-tunnel-")));
  tunnels.push(dir);
  writeFileSync(join(dir, "ssh"), FAKE_SSH, { mode: 0o755 });
  const port = await freePort();
  writeFileSync(join(dir, "index.json"), JSON.stringify({ "shop/dev": { label: "dev--shop", socket: "dev--shop.sock", port, kind: "dev", url: null } }));
  return {
    dir,
    port,
    log: () => {
      try {
        return readFileSync(join(dir, "log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
    spawn: (args, env = {}) =>
      Bun.spawn([process.execPath, CLI, "tunnel", ...args], {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_SSH_LOG: join(dir, "log"), FAKE_SSH_INDEX: join(dir, "index.json"), ...env },
      }),
  };
}

/** Reads `stream` until `marker` shows up. */
async function readUntil(stream: ReadableStream<Uint8Array>, marker: string, timeoutMs = 15_000): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  while (!text.includes(marker)) {
    if (Date.now() > deadline) throw new Error(`no ${JSON.stringify(marker)} in ${JSON.stringify(text)}`);
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  reader.releaseLock();
  return text;
}

describe("tunnel", () => {
  test("reads the index over ssh, forwards the branch's port to its socket, waits for /api/health, and closes ssh on Ctrl-C", async () => {
    const t = await tunnelSetup();
    const proc = t.spawn(["shop/dev", "--ssh", "omer@vps.example.net"], { FAKE_SSH_DELAY: "700" });
    const out = await readUntil(proc.stdout as ReadableStream<Uint8Array>, "Ctrl-C closes the tunnel.");
    const base = `http://127.0.0.1:${t.port}`;
    expect(out).toContain(`shop/dev is reachable at ${base}`);
    expect(out).toContain(`Dashboard  ${base}/_/`);
    expect(out).toContain(`MCP        claude mcp add --transport http incibase-dev--shop ${base}/mcp --header "Authorization: Bearer $(ssh omer@vps.example.net sudo incibase admin-key shop/dev)"`);
    expect(out).toContain("Admin key  ssh omer@vps.example.net sudo incibase admin-key shop/dev");
    expect(await (await fetch(`${base}/api/health`)).json()).toEqual({ ok: true });
    // Both without a ControlMaster from ~/.ssh/config: a mux client's -N -L would leave the forward in a master that outlives Ctrl-C.
    const noMux = ["-o", "ControlMaster=no", "-o", "ControlPath=none"];
    expect(t.log().slice(0, 2)).toEqual([
      [...noMux, "-o", "ConnectTimeout=15", "--", "omer@vps.example.net", "cat", "/var/lib/incibase/admin/index.json"],
      [...noMux, "-N", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30", "-L", `127.0.0.1:${t.port}:/var/lib/incibase/admin/dev--shop.sock`, "--", "omer@vps.example.net"],
    ]);
    proc.kill("SIGINT");
    expect(await proc.exited).toBe(0);
    expect(t.log()).toContain("SIGTERM");
    await expect(fetch(`${base}/api/health`)).rejects.toThrow();
  }, 30_000);

  test("--local-port, --root and --json", async () => {
    const t = await tunnelSetup();
    const port = await freePort();
    const config = join(t.dir, "ssh_config");
    writeFileSync(config, "Host vps\n  User omer\n");
    const proc = t.spawn(["shop/dev", "--ssh", "vps", "--local-port", String(port), "--root", "/srv/incibase", "--ssh-config", config, "--json"]);
    const line = JSON.parse((await readUntil(proc.stdout as ReadableStream<Uint8Array>, "}\n")).trim());
    expect(line).toMatchObject({ branch: "shop/dev", port, socket: "/srv/incibase/admin/dev--shop.sock", dashboard: `http://127.0.0.1:${port}/_/`, adminKeyCommand: `ssh -F ${config} vps sudo incibase admin-key shop/dev --root /srv/incibase` });
    expect(t.log()[0]).toEqual(["-F", config, "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ConnectTimeout=15", "--", "vps", "cat", "/srv/incibase/admin/index.json"]);
    expect((t.log()[1] as string[]).slice(0, 7)).toEqual(["-F", config, "-o", "ControlMaster=no", "-o", "ControlPath=none", "-N"]);
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(0);
  }, 30_000);

  test("refuses bad arguments without running ssh, and reports what the server says", async () => {
    const t = await tunnelSetup();
    const run = async (args: string[], env: Record<string, string> = {}) => {
      const proc = t.spawn(args, env);
      const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr as ReadableStream).text()]);
      return { code, err };
    };
    for (const args of [
      ["shop/dev"],
      ["shop/dev", "--ssh", "-oProxyCommand=touch /tmp/x"],
      ["shop/dev", "--ssh", "a b"],
      ["shop", "--ssh", "vps"],
      ["shop/dev", "--ssh", "vps", "--root", "/srv/$(id)"],
      ["shop/dev", "--ssh", "vps", "--root", "relative"],
      ["shop/dev", "--ssh", "vps", "--local-port", "80"],
      ["shop/dev", "--ssh", "vps", "--bogus"],
      ["shop/dev", "--ssh", "vps", "--ssh-config", "/nonexistent/config"],
    ]) {
      expect({ args, code: (await run(args)).code }).toEqual({ args, code: 2 });
    }
    expect(t.log()).toEqual([]);

    const missing = await run(["shop/prod", "--ssh", "vps"]);
    expect(missing).toMatchObject({ code: 1, err: expect.stringContaining("No ready branch shop/prod on the server") });
    const denied = await run(["shop/dev", "--ssh", "vps"], { FAKE_SSH_MODE: "denied" });
    expect(denied.code).toBe(1);
    expect(denied.err).toContain("Permission denied. Make your account an admin there: sudo incibase host add-admin <you>");
    const refused = await run(["shop/dev", "--ssh", "vps"], { FAKE_SSH_MODE: "refused" });
    expect(refused).toMatchObject({ code: 1, err: expect.stringContaining("ssh exited 255 before the tunnel was up") });
    writeFileSync(join(t.dir, "index.json"), JSON.stringify({ "shop/dev": { label: "x", socket: "../../etc/shadow", port: t.port } }));
    expect((await run(["shop/dev", "--ssh", "vps"])).err).toContain("invalid socket name");

    // The port is taken: nothing is started.
    writeFileSync(join(t.dir, "index.json"), JSON.stringify({ "shop/dev": { label: "dev--shop", socket: "dev--shop.sock", port: t.port } }));
    const squatter = Bun.serve({ port: t.port, hostname: "127.0.0.1", fetch: () => new Response("other") });
    try {
      expect((await run(["shop/dev", "--ssh", "vps"])).err).toContain(`127.0.0.1:${t.port} is in use`);
    } finally {
      squatter.stop(true);
    }
  }, 60_000);

  test("gives up when the branch does not answer in --timeout, and stops ssh", async () => {
    const t = await tunnelSetup();
    const proc = t.spawn(["shop/dev", "--ssh", "vps", "--timeout", "1"], { FAKE_SSH_DELAY: "5000" });
    const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr as ReadableStream).text()]);
    expect(code).toBe(1);
    expect(err).toContain("did not answer /api/health through the tunnel in 1 s");
    expect(t.log()).toContain("SIGTERM");
  }, 30_000);

  test("indexEntry checks what the server's index says", () => {
    expect(indexEntry(JSON.stringify({ "a/b": { label: "b--a", socket: "b--a.sock", port: 7101 } }), "a/b")).toEqual({ label: "b--a", socket: "b--a.sock", port: 7101 });
    expect(() => indexEntry("nope", "a/b")).toThrow("not JSON");
    expect(() => indexEntry(JSON.stringify({ "a/b": { socket: "b--a.sock", port: 0 } }), "a/b")).toThrow("invalid port");
  });
});
