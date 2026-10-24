// The owner's commands end to end on a real machine, as root, through the
// CLI only (`incibase host|project|branch|release|env|service-key|status|
// logs …`): host init with a self-signed certificate and nginx on its own
// port, a runtime, project create with prod and dev, a release for each
// (prod's from stdin), the branch over https, an admin who can reach the
// admin socket, service-key create/revoke, env set --restart, status, logs,
// and branch delete with --confirm.
//
// Skipped unless INCIBASE_TEST_HOST=1 on Linux as root with nginx; needs
// INCIBASE_TEST_BINARY (bun scripts/build-binary.ts). Uses its own host
// root (INCIBASE_TEST_HOST_ROOT, default /var/lib/incibase-cli-test), uid
// base (INCIBASE_TEST_UID_BASE, default 74000), unit prefix, groups, nginx
// file names and port (INCIBASE_TEST_HTTPS_PORT, default 18543), and
// removes everything it created. With INCIBASE_TEST_TUNNEL_DIR set it
// writes ready.json there once dev runs and waits (up to 10 minutes) for a
// file named done, so `incibase tunnel` can be tried from another machine.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { VERSION } from "../src/engine/version.ts";
import { DEFAULT_ROOT, HostLayout } from "../src/host/layout.ts";
import { nginxFiles, NGINX_SERVICE } from "../src/host/nginx.ts";
import { Registry } from "../src/host/registry.ts";
import { LinuxSystem } from "../src/host/system.ts";

const enabled = process.env.INCIBASE_TEST_HOST === "1" && process.platform === "linux" && process.getuid?.() === 0 && existsSync("/usr/sbin/nginx");
const ROOT = process.env.INCIBASE_TEST_HOST_ROOT ?? "/var/lib/incibase-cli-test";
const UID_BASE = Number(process.env.INCIBASE_TEST_UID_BASE ?? 74000);
const PORT = Number(process.env.INCIBASE_TEST_HTTPS_PORT ?? 18543);
const BINARY = process.env.INCIBASE_TEST_BINARY ?? "";
const TUNNEL_DIR = process.env.INCIBASE_TEST_TUNNEL_DIR ?? "";
const MARKER = ".incibase-test-root";
// No hyphens: systemd puts a-b.slice under a.slice, so incibase-x.slice would count against the owner's incibase.slice.
const LABEL = basename(ROOT).replace(/[^a-z0-9]/g, "").slice(0, 24);
const LAYOUT = {
  unitPrefix: LABEL,
  groups: { proxy: `${LABEL}-proxy`, admin: `${LABEL}-admin` },
  runtimeRoot: `/usr/local/lib/${LABEL}`,
  systemdDir: "/etc/systemd/system",
  cliLink: `/usr/local/lib/${LABEL}-bin/incibase`,
};
const ADMIN_USER = `${LABEL}-adm`.slice(0, 32);
const WORK = `/tmp/${LABEL}-work`;
const DOMAIN = "incibase.omergenc.net";
const PROD_HOST = `prod--shop.${DOMAIN}`;
const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const SLOW = 300_000;

const sys = new LinuxSystem();
const files = nginxFiles(new HostLayout({ root: ROOT, ...LAYOUT }));

function run(command: string[], options: { ok?: number[]; stdin?: Buffer } = {}) {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe", stdin: options.stdin ?? "ignore" });
  const code = result.exitCode ?? -1;
  if (!(options.ok ?? [0]).includes(code)) throw new Error(`${command.join(" ")} exited ${code}: ${result.stderr.toString()}${result.stdout.toString()}`);
  return { code, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

/** `incibase <args> --root ROOT`, as an owner would type it. */
function incibase(args: string[], options: { ok?: number[]; stdin?: Buffer } = {}) {
  const result = run([process.execPath, CLI, ...args, "--root", ROOT], options);
  for (const line of `${result.stdout}${result.stderr}`.trim().split("\n")) if (line) console.log(`  | ${line}`);
  return result;
}

function cleanup() {
  const prefix = LAYOUT.unitPrefix;
  const units = run(["systemctl", "list-units", "--all", "--plain", "--no-legend", `${prefix}-*`]).stdout
    .split("\n")
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((u): u is string => !!u && u.startsWith(`${prefix}-`));
  for (const unit of [...units.filter((u) => u.endsWith(".timer")), ...units.filter((u) => !u.endsWith(".timer")), `${prefix}.slice`]) {
    run(["systemctl", "stop", unit], { ok: [0, 1, 5] });
    run(["systemctl", "reset-failed", unit], { ok: [0, 1, 5] });
  }
  for (const dir of [LAYOUT.systemdDir, join(LAYOUT.systemdDir, "multi-user.target.wants"), join(LAYOUT.systemdDir, "timers.target.wants")]) {
    for (const name of existsSync(dir) ? readdirSync(dir) : []) {
      if (name.startsWith(`${prefix}-`) || name === `${prefix}.slice`) rmSync(join(dir, name), { recursive: true, force: true });
    }
  }
  const hadNginx = existsSync(files.conf) || existsSync(files.dropIn);
  rmSync(files.conf, { force: true });
  rmSync(files.dropIn, { force: true });
  const dropInDir = join(LAYOUT.systemdDir, `${NGINX_SERVICE}.d`);
  if (existsSync(dropInDir) && readdirSync(dropInDir).length === 0) rmSync(dropInDir, { recursive: true });
  run(["systemctl", "daemon-reload"]);
  if (hadNginx) run(["systemctl", "restart", NGINX_SERVICE]);
  rmSync(files.accessLog, { force: true });
  rmSync(files.errorLog, { force: true });
  if (existsSync(join(ROOT, "control", "registry.db"))) {
    const registry = Registry.open(new HostLayout({ root: ROOT, ...LAYOUT }));
    for (const branch of registry.listBranches()) {
      for (const pid of sys.processesOf(branch.os_uid)) process.kill(pid, "SIGKILL");
      const user = sys.getpwnam(`ib-${branch.id}`);
      if (user && user.uid === branch.os_uid) sys.userdel(user.name);
      const group = sys.getgrnam(`ib-${branch.id}`);
      if (group && group.gid === branch.os_uid) sys.groupdel(group.name);
    }
    registry.close();
  }
  const admin = sys.getpwnam(ADMIN_USER);
  if (admin) {
    // An SSH session of the tunnel try may linger.
    run(["loginctl", "terminate-user", ADMIN_USER], { ok: [0, 1] });
    for (let i = 0; i < 50 && sys.processesOf(admin.uid).length; i++) {
      for (const pid of sys.processesOf(admin.uid)) process.kill(pid, "SIGKILL");
      Bun.sleepSync(100);
    }
    run(["userdel", "--", ADMIN_USER]);
  }
  if (sys.getgrnam(ADMIN_USER)) run(["groupdel", "--", ADMIN_USER]);
  for (const group of [LAYOUT.groups.proxy, LAYOUT.groups.admin]) if (sys.getgrnam(group)) sys.groupdel(group);
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(LAYOUT.runtimeRoot, { recursive: true, force: true });
  rmSync(`/usr/local/lib/${LABEL}-bin`, { recursive: true, force: true });
  rmSync(WORK, { recursive: true, force: true });
}

/** The example app bundled as `nobody` with the standalone binary (root never runs app code). */
function bundleExample(name: string): string {
  const dir = join(WORK, name);
  cpSync(join(import.meta.dir, "..", "example"), dir, { recursive: true });
  run(["chown", "-R", "nobody:nogroup", dir]);
  run(["setpriv", "--reuid=nobody", "--regid=nogroup", "--clear-groups", "--", "env", `HOME=${dir}`, join(WORK, "incibase"), "bundle", "--dir", join(dir, "incibase"), "--out", join(dir, "app.ib")]);
  return join(dir, "app.ib");
}

/** curl over https to the front door, as a client on the internet would (the certificate is ours). */
function https(host: string, path: string) {
  const r = run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--cacert", join(WORK, "tls.crt"), "--resolve", `${host}:${PORT}:127.0.0.1`, `https://${host}:${PORT}${path}`], { ok: [0, 7, 35, 60] });
  return r.stdout.trim();
}

/** GET /api/health on an admin socket as `user` with its groups. */
function adminHealthAs(user: string, socket: string) {
  const script = `const r = await fetch("http://localhost/api/health", { unix: ${JSON.stringify(socket)} }).catch((e) => ({ status: String(e.code ?? e.message) })); console.log(r.status);`;
  return run(["setpriv", `--reuid=${user}`, `--regid=${user}`, "--init-groups", "--", process.execPath, "-e", script], { ok: [0, 1] }).stdout.trim();
}

describe.skipIf(!enabled)("the owner's CLI on a real host", () => {
  beforeAll(() => {
    if (ROOT === DEFAULT_ROOT) throw new Error(`Refusing to test on ${DEFAULT_ROOT}`);
    if (!BINARY || !existsSync(BINARY)) throw new Error("Set INCIBASE_TEST_BINARY to a standalone incibase for this machine (bun scripts/build-binary.ts)");
    if (existsSync(ROOT) && !existsSync(join(ROOT, MARKER))) throw new Error(`${ROOT} exists and is not a test root; remove it or pick another INCIBASE_TEST_HOST_ROOT`);
    cleanup();
    mkdirSync(ROOT, { mode: 0o755 });
    writeFileSync(join(ROOT, MARKER), "");
    mkdirSync(WORK, { mode: 0o755 });
    cpSync(BINARY, join(WORK, "incibase"));
    chmodSync(join(WORK, "incibase"), 0o755);
    mkdirSync(`/usr/local/lib/${LABEL}-bin`);
    run(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", join(WORK, "tls.key"), "-out", join(WORK, "tls.crt"), "-days", "30", "-subj", `/CN=*.${DOMAIN}`, "-addext", `subjectAltName=DNS:*.${DOMAIN},DNS:${DOMAIN}`]);
  });

  afterAll(() => {
    if (enabled) cleanup();
  });

  test("init, runtime, project, releases, keys, env, status, logs, delete", async () => {
    // Usage errors and help need no host.
    expect(incibase(["branch", "create", "shop"], { ok: [2] }).stderr).toContain("Expected <project>/<branch>");
    expect(incibase(["branch", "set", "shop/dev", "--memory", "lots"], { ok: [2] }).stderr).toContain("--memory: Invalid size");
    // Before host init, and at a mistyped root, commands refuse and create no registry.
    expect(incibase(["status"], { ok: [1] }).stderr).toContain(`No incibase host at ${ROOT}: run sudo incibase host init`);
    expect(existsSync(join(ROOT, "control"))).toBe(false);
    const typo = join(ROOT, "typo");
    expect(run([process.execPath, CLI, "project", "create", "shop", "--branches", "", "--root", typo], { ok: [1] }).stderr).toContain(`No incibase host at ${typo}`);
    expect(existsSync(typo)).toBe(false);

    const init = incibase([
      "host", "init",
      "--domain", DOMAIN,
      "--timezone", "Europe/Istanbul",
      "--tls-cert", join(WORK, "tls.crt"),
      "--tls-key", join(WORK, "tls.key"),
      "--https-port", String(PORT),
      "--uid-base", String(UID_BASE),
      "--slice-memory", "2G",
      "--no-check-timer",
      "--layout", JSON.stringify(LAYOUT),
    ]);
    expect(init.stdout).toContain(`${ROOT} is set up for ${DOMAIN}`);
    expect(init.stdout).toMatch(/front door: certificate \S+, nginx (reload|restart|start)/);
    const sha = new Bun.CryptoHasher("sha256").update(readFileSync(BINARY)).digest("hex");
    expect(incibase(["host", "install-runtime", "--version", VERSION, BINARY, "--sha256", sha]).stdout).toContain(`Installed runtime ${VERSION}`);

    const created = incibase(["project", "create", "shop", "--branches", "prod,dev"]);
    expect(created.stdout).toContain(`shop/prod                prod    https://${PROD_HOST}`);
    expect(JSON.parse(incibase(["project", "list", "--json"]).stdout)).toMatchObject([{ slug: "shop", branches: ["dev", "prod"] }]);

    // dev from a file, prod (with its preflight) from stdin.
    const dev = incibase(["release", "add", "shop/dev", bundleExample("v1")]);
    expect(dev.stdout).toMatch(/Release 1 of shop\/dev is live/);
    const prod = incibase(["release", "add", "shop/prod", "-"], { stdin: readFileSync(bundleExample("v2")) });
    expect(prod.stdout).toMatch(/Release 1 of shop\/prod is live/);
    expect(JSON.parse(incibase(["release", "list", "shop/prod", "--json"]).stdout)[0]).toMatchObject({ seq: 1, status: "live", origin: "cli:stdin", preflight: 1 });

    // The front door serves both; an unknown branch is 404.
    expect(https(`dev--shop.${DOMAIN}`, "/api/health")).toBe("200");
    expect(https(PROD_HOST, "/api/health")).toBe("200");
    expect(https(`nope--shop.${DOMAIN}`, "/api/health")).toBe("404");

    // An admin's account reaches the admin socket; another account does not.
    run(["useradd", "--no-create-home", "--shell", "/bin/sh", "--", ADMIN_USER]);
    expect(incibase(["host", "add-admin", ADMIN_USER]).stdout).toContain(`Added ${ADMIN_USER} to ${LAYOUT.groups.admin}`);
    expect(incibase(["host", "add-admin", "www-data"], { ok: [2] }).stderr).toContain("not a login account");
    const devSocket = `${ROOT}/admin/dev--shop.sock`;
    expect(adminHealthAs(ADMIN_USER, devSocket)).toBe("200");
    expect(adminHealthAs("nobody", devSocket)).not.toBe("200");
    expect(run(["setpriv", `--reuid=${ADMIN_USER}`, `--regid=${ADMIN_USER}`, "--init-groups", "--", "cat", `${ROOT}/admin/index.json`]).stdout).toContain('"shop/dev"');

    // A service key is shown once, listed without its secret, and revoked with a confirmed reload.
    const key = incibase(["service-key", "create", "shop/dev", "--label", "ci", "--scopes", "internal"]).stdout.trim();
    expect(key).toMatch(/^ik_svc_k[0-9a-z]{9}_/);
    const id = /^ik_svc_(k[0-9a-z]{9})_/.exec(key)![1]!;
    expect(incibase(["service-key", "list", "shop/dev"]).stdout).toMatch(new RegExp(`^${id}\\s+ci\\s+internal`, "m"));
    expect(incibase(["service-key", "revoke", "shop/dev", id]).stdout).toBe(`Revoked ${id}; the branch no longer accepts it\n`);

    // env set restarts only when asked; status shows the new generation.
    const before = JSON.parse(incibase(["status", "shop/dev", "--json"]).stdout).branches[0].generation;
    expect(incibase(["env", "set", "shop/dev", "GREETING=merhaba"]).stdout).toContain("applies at the next start");
    expect(JSON.parse(incibase(["status", "shop/dev", "--json"]).stdout).branches[0].generation).toBe(before);
    expect(incibase(["env", "set", "shop/dev", "GREETING=merhaba dunya", "--restart"]).stdout).toMatch(/restart: healthy after/);
    const after = JSON.parse(incibase(["status", "shop/dev", "--json"]).stdout).branches[0];
    expect(after.generation).not.toBe(before);
    expect(after.actual).toMatchObject({ activeState: "active", subState: "running" });
    expect(incibase(["env", "list", "shop/dev"]).stdout).toMatch(/^GREETING\s+app$/m);

    const status = incibase(["status"]).stdout.split("\n");
    expect(status[0]).toMatch(/^BRANCH\s+KIND\s+DESIRED\s+ACTUAL\s+RELEASE\s+GENERATION\s+MEMORY\s+URL$/);
    expect(status.find((l) => l.startsWith("shop/dev"))).toMatch(/^shop\/dev\s+dev\s+running\s+active\/running\s+1 live\s+1\.\S+\s+[\d.]+[KMG]\/256M\s+https:\/\/dev--shop/);
    expect(status.find((l) => l.startsWith("shop/prod"))).toMatch(/^shop\/prod\s+prod\s+running\s+active\/running\s+1 live/);
    expect(incibase(["host", "status"]).stdout).toContain(`front door  https port ${PORT}, trust proxy none, certificate installed`);

    // logs: the branch's JSON lines from the journal.
    const logs = incibase(["logs", "shop/dev", "--lines", "200"]);
    expect(logs.stdout).toContain('"ev":"ready"');
    expect(incibase(["logs", "shop/dev", "--errors", "--since", "1 hour ago"]).code).toBe(0);
    // What the tenant logs reaches root's terminal without its control characters.
    const unit = JSON.parse(incibase(["branch", "info", "shop/dev", "--json"]).stdout).id as string;
    run(["logger", "--journald"], { stdin: Buffer.from(`MESSAGE=before\u001b]0;PWNED\u0007\u001b[2Jafter\tend\nOBJECT_SYSTEMD_UNIT=${LAYOUT.unitPrefix}-branch@${unit}.service\n`) });
    let escaped = "";
    for (let i = 0; i < 50 && !escaped.includes("before"); i++, await Bun.sleep(100)) escaped = incibase(["logs", "shop/dev", "--lines", "20"]).stdout;
    expect(escaped).toContain("before?]0;PWNED??[2Jafter\tend");
    expect(escaped).not.toMatch(/[\u001b\u0007]/);
    // A --since journalctl cannot read is a usage error, also with --errors (whose "no match" is exit 1 too).
    expect(incibase(["logs", "shop/dev", "--since", "abc"], { ok: [2] }).stderr).toContain('--since: journalctl cannot read "abc"');
    expect(incibase(["logs", "shop/dev", "--errors", "--since", "abc"], { ok: [2] }).code).toBe(2);

    if (TUNNEL_DIR) {
      writeFileSync(join(TUNNEL_DIR, "ready.json"), JSON.stringify({ root: ROOT, user: ADMIN_USER, branch: "shop/dev" }));
      const deadline = Date.now() + 10 * 60_000;
      while (!existsSync(join(TUNNEL_DIR, "done")) && Date.now() < deadline) await Bun.sleep(500);
      rmSync(join(TUNNEL_DIR, "ready.json"), { force: true });
    }

    // Deletes: prod needs its hostname.
    expect(incibase(["branch", "delete", "shop/dev"]).stdout).toBe("Deleted shop/dev\n");
    expect(incibase(["branch", "delete", "shop/prod"], { ok: [1] }).stderr).toContain(`confirm with its hostname ${PROD_HOST}`);
    expect(incibase(["branch", "delete", "shop/prod", "--confirm", PROD_HOST]).stdout).toContain("its data stays in");
    expect(https(PROD_HOST, "/api/health")).toBe("404");
    expect(incibase(["project", "delete", "shop"]).stdout).toBe("Deleted project shop\n");
    expect(incibase(["status"]).stdout).toStartWith("No branches");
  }, SLOW);
});
