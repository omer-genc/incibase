// The nginx front door on a real machine, as root: a self-signed wildcard
// certificate for *.incibase.omergenc.net, a real branch from the owner
// operations serving the example app, and curl over https with --resolve.
// It checks the design's [I] nginx claims (sections 3.2 A/B and 5.4): host
// routing through hosts/<label>, 404 for unknown labels, no handshake for
// unknown SNI, the path blocks, X-Forwarded-For overwritten, Set-Cookie
// Domain= emptied, 503-unprocessed only when the socket refused the
// connection (an upstream that accepts and closes stays 502), WebSocket
// upgrades, a 50 MB streamed upload, rate limits (per IPv6 /64 too, with
// readable 429 and 413 answers), logs no branch user can read, no query
// strings in any log, and certificate rotation. Known gaps are asserted as
// they are, so a change in nginx shows up here.
//
// Skipped unless INCIBASE_TEST_HOST=1 on Linux as root with nginx installed;
// needs INCIBASE_TEST_BINARY (bun scripts/build-binary.ts). Uses its own host
// root (INCIBASE_TEST_HOST_ROOT, default /var/lib/incibase-nginx-test), uid
// base (INCIBASE_TEST_UID_BASE, default 73000), unit prefix, groups, runtime
// root, CLI link, nginx file names and port (INCIBASE_TEST_HTTPS_PORT,
// default 18443), and removes everything it created, nginx's files included.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, chownSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:tls";
import { basename, join } from "node:path";
import { VERSION } from "../src/engine/version.ts";
import { openHost, type OpsContext } from "../src/host/context.ts";
import { DEFAULT_ROOT, HostLayout } from "../src/host/layout.ts";
import { nginxFiles, NGINX_SERVICE } from "../src/host/nginx.ts";
import * as ops from "../src/host/ops.ts";
import { Registry } from "../src/host/registry.ts";
import { LinuxSystem } from "../src/host/system.ts";

const enabled = process.env.INCIBASE_TEST_HOST === "1" && process.platform === "linux" && process.getuid?.() === 0 && existsSync("/usr/sbin/nginx");
const ROOT = process.env.INCIBASE_TEST_HOST_ROOT ?? "/var/lib/incibase-nginx-test";
const UID_BASE = Number(process.env.INCIBASE_TEST_UID_BASE ?? 73000);
const PORT = Number(process.env.INCIBASE_TEST_HTTPS_PORT ?? 18443);
const BINARY = process.env.INCIBASE_TEST_BINARY ?? "";
const REQUIRE_SANDBOX = process.env.INCIBASE_TEST_REQUIRE_SANDBOX === "1";
const MARKER = ".incibase-test-root";
const LABEL = basename(ROOT).slice(0, 24);
const WORK = `/tmp/${LABEL}-work`;
const LAYOUT = {
  unitPrefix: LABEL,
  groups: { proxy: `${LABEL}-proxy`, admin: `${LABEL}-admin` },
  runtimeRoot: `/usr/local/lib/${LABEL}`,
  systemdDir: "/etc/systemd/system",
  // What the check service runs, never the machine's own /usr/local/bin/incibase (nothing links it here).
  cliLink: `${WORK}/bin/incibase`,
};
const DOMAIN = "incibase.omergenc.net";
const DEV = `dev--shop.${DOMAIN}`;
const SLOW = 240_000;
/** Source addresses for the /64 test: two in one /64, one in the next (documentation range). */
const V6_ADDRS = ["2001:db8:11f:2::a", "2001:db8:11f:2:ffff::b", "2001:db8:11f:3::a"];

const sys = new LinuxSystem();
let ctx: OpsContext;
const files = nginxFiles(new HostLayout({ root: ROOT, ...LAYOUT }));

function run(command: string[], options: { ok?: number[]; stdin?: Buffer } = {}) {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe", stdin: options.stdin ?? "ignore" });
  const code = result.exitCode ?? -1;
  if (!(options.ok ?? [0]).includes(code)) throw new Error(`${command.join(" ")} exited ${code}: ${result.stderr.toString()}${result.stdout.toString()}`);
  return { code, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

/** Removes every unit, user, group, directory and nginx file this test host made, and gives nginx its config back. */
function cleanup() {
  const prefix = LAYOUT.unitPrefix;
  const units = run(["systemctl", "list-units", "--all", "--plain", "--no-legend", `${prefix}-*`]).stdout
    .split("\n")
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((u): u is string => !!u && u.startsWith(`${prefix}-`));
  for (const unit of [...units, `${prefix}.slice`]) {
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
  // A restart, not a reload: the master's OOMScoreAdjust goes back too.
  if (hadNginx) run(["systemctl", "restart", NGINX_SERVICE]);
  rmSync(files.accessLog, { force: true });
  rmSync(files.errorLog, { force: true });
  for (const addr of V6_ADDRS) run(["ip", "-6", "addr", "del", `${addr}/128`, "dev", "lo"], { ok: [0, 2] });
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
  // groupdel also takes www-data out of the proxy group.
  for (const group of [LAYOUT.groups.proxy, LAYOUT.groups.admin]) if (sys.getgrnam(group)) sys.groupdel(group);
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(LAYOUT.runtimeRoot, { recursive: true, force: true });
  rmSync(WORK, { recursive: true, force: true });
}

/** A self-signed certificate for *.<domain>, as Cloudflare's Origin CA would issue (recipe A). */
function makeCert(name: string) {
  const cert = join(WORK, `${name}.crt`);
  const key = join(WORK, `${name}.key`);
  run(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", key, "-out", cert, "-days", "30", "-subj", `/CN=*.${DOMAIN}`, "-addext", `subjectAltName=DNS:*.${DOMAIN},DNS:${DOMAIN}`]);
  return { cert, key };
}

const fingerprint = (cert: string) => run(["openssl", "x509", "-noout", "-fingerprint", "-sha256", "-in", cert]).stdout.trim();

/** The certificate nginx shows for `servername`. */
function servedFingerprint(servername: string) {
  const shown = run(["openssl", "s_client", "-connect", `127.0.0.1:${PORT}`, "-servername", servername], { stdin: Buffer.from("") }).stdout;
  return run(["openssl", "x509", "-noout", "-fingerprint", "-sha256"], { stdin: Buffer.from(shown) }).stdout.trim();
}

/** The example app with /echo: it returns the request headers it saw and sets cookies with Domain=. */
function bundleApp(name: string): string {
  const dir = join(WORK, name);
  cpSync(join(import.meta.dir, "..", "example"), dir, { recursive: true });
  const http = join(dir, "incibase", "http.ts");
  const text = readFileSync(http, "utf8");
  writeFileSync(
    http,
    text.replace(
      "export default http;",
      `http.route({
  path: "/echo",
  method: "GET",
  handler: httpAction(async (_ctx, req) => {
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => (headers[key] = value));
    const res = Response.json({ headers });
    res.headers.append("set-cookie", "sid=1; Domain=evil.example; Path=/; HttpOnly");
    res.headers.append("set-cookie", "pref=2; Path=/; Domain=.${DOMAIN}; Secure");
    res.headers.append("set-cookie", "c6=1; Path=/;\\tDomain=${DOMAIN}");
    res.headers.append("set-cookie", "c8=1; Path=/; Domain\\t=${DOMAIN}");
    return res;
  }),
});

export default http;`,
    ),
  );
  run(["chown", "-R", "nobody:nogroup", dir]);
  run(["setpriv", "--reuid=nobody", "--regid=nogroup", "--clear-groups", "--", "env", `HOME=${dir}`, join(WORK, "incibase"), "bundle", "--dir", join(dir, "incibase"), "--out", join(dir, "app.ib")]);
  return join(dir, "app.ib");
}

interface CurlResult {
  /** curl's own exit code: 35 is a failed TLS handshake. */
  exit: number;
  status: number;
  headers: Record<string, string[]>;
  body: string;
}

let n = 0;
interface CurlOptions {
  cacert?: boolean;
  /** Where the name resolves to (default 127.0.0.1); `[::1]` for IPv6. */
  to?: string;
}
const CURL_EXITS = [0, 7, 22, 35, 52, 56];

function curlCommand(host: string, path: string, args: string[], { cacert = true, to = "127.0.0.1" }: CurlOptions) {
  const out = join(WORK, `curl-${++n}`);
  const command = [
    "curl",
    "-sS",
    "--max-time",
    "60",
    "-D",
    `${out}.h`,
    "-o",
    `${out}.b`,
    ...(cacert ? ["--cacert", join(WORK, "ca.crt")] : ["-k"]),
    "--resolve",
    `${host}:${PORT}:${to}`,
    ...args,
    `https://${host}:${PORT}${path}`,
  ];
  return { command, out };
}

/** curl over https to 127.0.0.1 with --resolve, trusting the test CA; the last header block counts (after a 100). */
function curl(host: string, path: string, args: string[] = [], options: CurlOptions = {}): CurlResult {
  const { command, out } = curlCommand(host, path, args, options);
  return curlResult(out, run(command, { ok: CURL_EXITS }).code);
}

/** curl in the background, so the test can watch nginx meanwhile. */
async function curlAsync(host: string, path: string, args: string[] = [], options: CurlOptions = {}): Promise<CurlResult> {
  const { command, out } = curlCommand(host, path, args, options);
  const child = Bun.spawn(command, { stdout: "ignore", stderr: "pipe" });
  const code = await child.exited;
  if (!CURL_EXITS.includes(code)) throw new Error(`${command.join(" ")} exited ${code}: ${await new Response(child.stderr).text()}`);
  return curlResult(out, code);
}

function curlResult(out: string, exit: number): CurlResult {
  const raw = existsSync(`${out}.h`) ? readFileSync(`${out}.h`, "utf8") : "";
  const blocks = raw.split(/\r\n\r\n/).filter((b) => b.trim());
  const last = blocks.at(-1) ?? "";
  const [statusLine = "", ...lines] = last.split("\r\n");
  const headers: Record<string, string[]> = {};
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon > 0) (headers[line.slice(0, colon).trim().toLowerCase()] ??= []).push(line.slice(colon + 1).trim());
  }
  const body = existsSync(`${out}.b`) ? readFileSync(`${out}.b`, "utf8") : "";
  rmSync(`${out}.h`, { force: true });
  rmSync(`${out}.b`, { force: true });
  return { exit, status: Number(/^HTTP\/[\d.]+ (\d{3})/.exec(statusLine)?.[1] ?? 0), headers, body };
}

const header = (r: CurlResult, name: string) => r.headers[name]?.[0];

/** Files nginx's workers hold open under its client body temp path: a request body spooled to disk (unlinked at once). */
function spooledBodies(): string[] {
  const held: string[] = [];
  for (const pid of run(["pgrep", "-u", "www-data", "-x", "nginx"], { ok: [0, 1] }).stdout.split("\n").filter(Boolean)) {
    let fds: string[] = [];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const target = readlinkSync(`/proc/${pid}/fd/${fd}`);
        if (target.startsWith("/var/lib/nginx/body/")) held.push(target);
      } catch {}
    }
  }
  return held;
}

/** Runs `request` and samples spooledBodies() until it ends. */
async function watchSpooling(request: Promise<CurlResult>) {
  let done = false;
  const seen = new Set<string>();
  const result = request.finally(() => (done = true));
  while (!done) {
    for (const path of spooledBodies()) seen.add(path);
    await Bun.sleep(25);
  }
  return { res: await result, spooled: [...seen] };
}

/** The access log lines (JSON) whose request id or path matches, newest last. */
function accessLog(match: (line: Record<string, string | number>) => boolean) {
  return readFileSync(files.accessLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, string | number>)
    .filter(match);
}

/** A WebSocket upgrade through nginx, then one message each way (raw frames over node:tls). */
function webSocketRoundTrip(host: string): Promise<{ status: string; frames: string[] }> {
  return new Promise((resolve, reject) => {
    const frames: string[] = [];
    let status = "";
    let buf = Buffer.alloc(0);
    const socket = connect({ host: "127.0.0.1", port: PORT, servername: host, ca: readFileSync(join(WORK, "ca.crt")), ALPNProtocols: ["http/1.1"] }, () => {
      socket.write(
        `GET /api/ws HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`no WebSocket answer (status ${JSON.stringify(status)}, frames ${JSON.stringify(frames)})`));
    }, 10_000);
    const done = () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ status, frames });
    };
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (!status) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        status = buf.subarray(0, buf.indexOf("\r\n")).toString();
        buf = buf.subarray(end + 4);
        if (!status.includes(" 101 ")) return done();
        // A masked text frame with "{}": the server answers it with a BAD_MESSAGE error frame.
        const payload = Buffer.from("{}");
        const mask = Buffer.from([1, 2, 3, 4]);
        socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!))]));
      }
      while (buf.length >= 2) {
        const opcode = buf[0]! & 0x0f;
        let length = buf[1]! & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buf.length < 4) return;
          length = buf.readUInt16BE(2);
          offset = 4;
        }
        if (buf.length < offset + length) return;
        const data = buf.subarray(offset, offset + length).toString();
        buf = buf.subarray(offset + length);
        if (opcode === 1) frames.push(data);
        if (data.includes("BAD_MESSAGE")) return done();
      }
    });
  });
}

describe.skipIf(!enabled)("the nginx front door", () => {
  const findings: string[] = [];
  const note = (line: string) => {
    findings.push(line);
    console.log(`  > ${line}`);
  };

  beforeAll(async () => {
    if (ROOT === DEFAULT_ROOT) throw new Error(`Refusing to test on ${DEFAULT_ROOT}`);
    if (!BINARY || !existsSync(BINARY)) throw new Error("Set INCIBASE_TEST_BINARY to a standalone incibase for this machine (bun scripts/build-binary.ts)");
    if (existsSync(ROOT) && !existsSync(join(ROOT, MARKER))) throw new Error(`${ROOT} exists and is not a test root`);
    cleanup();
    mkdirSync(ROOT, { mode: 0o755 });
    writeFileSync(join(ROOT, MARKER), "");
    mkdirSync(WORK, { mode: 0o755 });
    cpSync(BINARY, join(WORK, "incibase"));
    chmodSync(join(WORK, "incibase"), 0o755);
    const first = makeCert("first");
    cpSync(first.cert, join(WORK, "ca.crt"));
    ctx = openHost({ root: ROOT, layout: LAYOUT });
    ctx.actor = "root:test";
    ctx.log = (line) => console.log(`  | ${line}`);
    const init = await ops.initHost(ctx, {
      domain: DOMAIN,
      timezone: "Europe/Istanbul",
      uidBase: UID_BASE,
      sliceMemoryMax: 2 * 1024 ** 3,
      tlsCert: first.cert,
      tlsKey: first.key,
      httpsPort: PORT,
    });
    expect(init.frontDoor?.nginx).toMatchObject({ changed: true, groupAdded: true, dropInChanged: true });
    await ops.installRuntime(ctx, { binary: BINARY, version: VERSION, sha256: new Bun.CryptoHasher("sha256").update(readFileSync(BINARY)).digest("hex") });
    await ops.createProject(ctx, { slug: "shop", branches: ["dev"] });
    const { release } = await ops.addRelease(ctx, { project: "shop", branch: "dev", file: bundleApp("v1") });
    expect(release.status).toBe("live");
  }, SLOW);

  afterAll(() => {
    ctx?.registry.close();
    if (findings.length) console.log(`\nnginx findings:\n${findings.map((f) => `  - ${f}`).join("\n")}`);
    if (enabled) cleanup();
  });

  test("the rendered files, www-data in the proxy group, the drop-in; nothing changed means no reload", async () => {
    expect(statSync(files.conf)).toMatchObject({ uid: 0 });
    expect(statSync(files.conf).mode & 0o777).toBe(0o644);
    const tls = join(ROOT, "tls");
    expect(statSync(tls).mode & 0o777).toBe(0o700);
    const key = ctx.registry.getSetting("tls_key")!;
    expect({ uid: statSync(key).uid, mode: statSync(key).mode & 0o777 }).toEqual({ uid: 0, mode: 0o600 });
    // The host's logs as logrotate makes them, never nginx's root 0644.
    const www = sys.getpwnam("www-data")!;
    const adm = sys.getgrnam("adm")!;
    for (const path of [files.accessLog, files.errorLog]) {
      const st = statSync(path);
      expect({ path, uid: st.uid, gid: st.gid, mode: st.mode & 0o777 }).toEqual({ path, uid: www.uid, gid: adm.gid, mode: 0o640 });
    }
    const proxy = sys.getgrnam(LAYOUT.groups.proxy)!;
    expect(proxy.members).toContain("www-data");
    // The workers got the group with the reload, without a restart of nginx.
    const workers = run(["pgrep", "-u", "www-data", "-x", "nginx"]).stdout.split("\n").filter(Boolean);
    expect(workers.length).toBeGreaterThan(0);
    for (const pid of workers) expect(/^Groups:\s*(.*)$/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))![1]!.split(/\s+/)).toContain(String(proxy.gid));
    const shown = run(["systemctl", "show", "--property", "OOMScoreAdjust,MemoryMin,MainPID", NGINX_SERVICE]).stdout;
    expect(shown).toContain("OOMScoreAdjust=-900");
    expect(shown).toContain("MemoryMin=67108864");
    const master = Number(/MainPID=(\d+)/.exec(shown)![1]);
    const adj = readFileSync(`/proc/${master}/oom_score_adj`, "utf8").trim();
    note(`nginx master oom_score_adj after the drop-in and a restart: ${adj}`);
    if (REQUIRE_SANDBOX) expect(adj).toBe("-900");

    const before = run(["pgrep", "-u", "www-data", "-x", "nginx"]).stdout;
    expect(await ops.renderNginx(ctx)).toMatchObject({ changed: false, groupAdded: false, dropInChanged: false, action: null });
    expect((await ops.render(ctx)).nginx).toMatchObject({ changed: false, action: null });
    expect(run(["pgrep", "-u", "www-data", "-x", "nginx"]).stdout).toBe(before);
  }, SLOW);

  test("a known label reaches its branch; an unknown label is 404; unknown or no SNI gets no handshake", () => {
    const health = curl(DEV, "/api/health");
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({ ok: true, generation: ctx.registry.findBranch("shop", "dev")!.generation });
    const unknown = curl(`nope--shop.${DOMAIN}`, "/api/health");
    expect(unknown.status).toBe(404);
    expect(JSON.parse(unknown.body)).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } });
    for (const host of ["other.example.net", DOMAIN, `deploy.${DOMAIN}`]) {
      const refused = curl(host, "/", [], { cacert: false });
      expect({ host, exit: refused.exit }).toEqual({ host, exit: 35 });
    }
    // No SNI at all (an IP address).
    const bare = run(["curl", "-sS", "-k", "--max-time", "10", `https://127.0.0.1:${PORT}/`], { ok: [35] });
    note(`unknown SNI and no SNI: curl exit 35 (${bare.stderr.trim().split("\n")[0]})`);
    // SNI for the branch with another Host: the default server closes it (444).
    const mismatch = curl(DEV, "/api/health", ["-H", "Host: other.example.net", "--http1.1"]);
    expect(mismatch.status).toBe(0);
  });

  test("/_/, /api/admin and /api/schema end at nginx with 404, also when encoded", async () => {
    const key = (await ops.adminKey(ctx, { project: "shop", branch: "dev" })).key;
    for (const path of ["/_", "/_/", "/_/index.html", "/api/admin/admin_overview", "/api/schema", "/%5F/", "/api//admin/x"]) {
      const res = curl(DEV, path, ["-H", `authorization: Bearer ${key}`, "--path-as-is"]);
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
    }
    const blocked = accessLog((l) => l.status === 404 && typeof l.path === "string" && /^\/(_|api\/admin|api\/schema)/.test(l.path as string));
    expect(blocked.length).toBeGreaterThanOrEqual(7);
    // Answered by nginx: no upstream.
    const upstreams = new Set(blocked.map((l) => l.upstream));
    note(`blocked paths in the access log: upstream ${JSON.stringify([...upstreams])}, paths ${JSON.stringify(blocked.map((l) => l.path))}`);
    for (const value of upstreams) expect(["", "-"]).toContain(value as string);
    // /_foo is not the dashboard: it reaches the branch (its HTTP actions decide).
    expect(curl(DEV, "/_foo").status).toBe(404);
    expect(accessLog((l) => l.path === "/_foo").at(-1)!.upstream).toBe("404");
  });

  test("the branch sees nginx's view of the client, a fresh request id and no client forwarding headers; cookies lose Domain", () => {
    const res = curl(DEV, "/echo?secret=token", [
      "-H",
      "X-Forwarded-For: 6.6.6.6",
      "-H",
      "X-Real-IP: 6.6.6.6",
      "-H",
      "Forwarded: for=6.6.6.6;proto=http",
      "-H",
      "X-Forwarded-Host: evil.example",
      "-H",
      "X-Forwarded-Proto: http",
      "-H",
      "CF-Connecting-IP: 6.6.6.6",
      "-H",
      "x-request-id: chosen-by-client",
    ]);
    expect(res.status).toBe(200);
    const seen = JSON.parse(res.body).headers as Record<string, string>;
    expect(seen["x-forwarded-for"]).toBe("127.0.0.1");
    expect(seen["x-forwarded-proto"]).toBe("https");
    expect(seen.host).toBe(DEV);
    for (const name of ["x-real-ip", "forwarded", "x-forwarded-host", "cf-connecting-ip"]) expect({ name, value: seen[name] }).toEqual({ name, value: undefined });
    expect(seen["x-request-id"]).toMatch(/^[0-9a-f]{32}$/);
    note(`what the app saw: ${JSON.stringify({ xff: seen["x-forwarded-for"], proto: seen["x-forwarded-proto"], rid: seen["x-request-id"], connection: seen.connection })}`);
    const cookies = res.headers["set-cookie"] ?? [];
    expect(cookies.length).toBe(4);
    const [sid, pref, tabBefore, tabAfter] = cookies;
    for (const cookie of [sid, pref]) expect(cookie).toMatch(/; Domain=(;|$)/);
    // Known gap (design 3.2 A): nginx leaves a tab before or after "Domain" alone, and browsers trim it
    // (RFC 6265 5.2). If this starts failing, nginx changed: update the design's note.
    expect(tabBefore).toBe(`c6=1; Path=/;\tDomain=${DOMAIN}`);
    expect(tabAfter).toBe(`c8=1; Path=/; Domain\t=${DOMAIN}`);
    note(`Set-Cookie after nginx: ${JSON.stringify(cookies)}`);
    // The log has the path without its query string.
    const line = accessLog((l) => l.path === "/echo").at(-1)!;
    expect(line).toMatchObject({ status: 200, label: "dev--shop", ip: "127.0.0.1", rid: seen["x-request-id"] });
    expect(readFileSync(files.accessLog, "utf8")).not.toContain("secret=token");
  });

  test("no branch user can read nginx's logs: not by their mode, and the sandbox hides the directory", () => {
    expect(curl(DEV, "/api/health").status).toBe(200);
    const branch = ctx.registry.findBranch("shop", "dev")!;
    const as = ["setpriv", `--reuid=${branch.os_uid}`, `--regid=${branch.os_uid}`, "--clear-groups", "--"];
    for (const path of [files.accessLog, files.errorLog]) {
      const denied = run([...as, "cat", path], { ok: [1] });
      expect(denied.stderr).toContain("Permission denied");
    }
    // Inside the running branch's mount namespace /var/log/nginx is an empty, inaccessible directory.
    const pid = run(["systemctl", "show", "--property", "MainPID", "--value", ctx.layout.units.branch(branch.id)]).stdout.trim();
    expect(Number(pid)).toBeGreaterThan(0);
    const inside = run(["nsenter", "-t", pid, "-m", "--", "ls", "-A", "/var/log/nginx"], { ok: [0, 2] });
    expect(inside.stdout.trim()).toBe("");
    // Outside, it has the logs.
    expect(readdirSync("/var/log/nginx")).toContain(basename(files.accessLog));
    note(`branch uid on the logs: Permission denied; /var/log/nginx inside the branch: ${JSON.stringify(inside.stdout.trim() || inside.stderr.trim())}`);
  });

  test("trust_proxy=cloudflare loads, and CF-Connecting-IP from outside Cloudflare's ranges is not believed", async () => {
    expect((await ops.setFrontDoor(ctx, { trustProxy: "cloudflare" })).nginx).toMatchObject({ changed: true, action: "reload" });
    expect(readFileSync(files.conf, "utf8")).toContain("real_ip_header CF-Connecting-IP;");
    await Bun.sleep(300);
    const res = curl(DEV, "/echo", ["-H", "CF-Connecting-IP: 6.6.6.6"]);
    const seen = JSON.parse(res.body).headers as Record<string, string>;
    expect(seen["x-forwarded-for"]).toBe("127.0.0.1");
    expect(seen["cf-connecting-ip"]).toBeUndefined();
    expect((await ops.setFrontDoor(ctx, { trustProxy: "none" })).nginx).toMatchObject({ changed: true, action: "reload" });
  });

  test("a stopped branch: 503 with x-incibase-unprocessed, Retry-After and CORS; OPTIONS 204; no query string in any log", async () => {
    await ops.stop(ctx, { project: "shop", branch: "dev" });
    const globalErrors = "/var/log/nginx/error.log";
    const globalBefore = existsSync(globalErrors) ? statSync(globalErrors).size : 0;
    const upload = curl(DEV, "/api/storage/upload?token=REVIEWSECRET123&visibility=public", ["-X", "POST", "--data", "x"]);
    expect(upload.status).toBe(503);
    const globalNew = existsSync(globalErrors) ? readFileSync(globalErrors, "utf8").slice(globalBefore) : "";
    // The failed connect is logged at [crit] with the request line; the server's error_log is at alert.
    expect(globalNew).not.toContain("REVIEWSECRET123");
    expect(readFileSync(files.errorLog, "utf8")).not.toContain("REVIEWSECRET123");
    expect(readFileSync(files.accessLog, "utf8")).not.toContain("REVIEWSECRET123");
    expect(accessLog((l) => l.path === "/api/storage/upload").at(-1)).toMatchObject({ status: 503, connect: "-" });
    const res = curl(DEV, "/api/mutation", ["-X", "POST", "-H", "origin: https://app.example.com", "-H", "content-type: application/json", "--data", "{}"]);
    expect(res.status).toBe(503);
    expect(header(res, "x-incibase-unprocessed")).toBe("1");
    expect(header(res, "retry-after")).toBe("1");
    expect(header(res, "access-control-allow-origin")).toBe("*");
    expect(header(res, "access-control-expose-headers")).toContain("x-incibase-unprocessed");
    expect(JSON.parse(res.body).error.code).toBe("BRANCH_UNAVAILABLE");
    const preflight = curl(DEV, "/api/mutation", [
      "-X",
      "OPTIONS",
      "-H",
      "origin: https://app.example.com",
      "-H",
      "access-control-request-method: POST",
      "-H",
      "access-control-request-headers: authorization, content-type",
    ]);
    expect(preflight.status).toBe(204);
    expect(header(preflight, "access-control-allow-origin")).toBe("*");
    expect(header(preflight, "access-control-allow-headers")).toContain("authorization");
    expect(header(preflight, "access-control-allow-methods")).toContain("POST");
    expect(header(preflight, "x-incibase-unprocessed")).toBe("1");
    const logged = accessLog((l) => l.path === "/api/mutation" && l.status === 503).at(-1)!;
    note(`stopped branch: status ${logged.status}, upstream "${logged.upstream}", connect "${logged.connect}"`);
    expect(logged.connect).toBe("-");
    const started = await ops.start(ctx, { project: "shop", branch: "dev" });
    expect(started.gate.ok).toBe(true);
    expect(curl(DEV, "/api/health").status).toBe(200);
  }, SLOW);

  test("an upstream that accepts and closes early stays 502, without x-incibase-unprocessed", async () => {
    const proxyGid = sys.getgrnam(LAYOUT.groups.proxy)!.gid;
    const dir = join(ROOT, "early-close");
    mkdirSync(dir, { mode: 0o750 });
    chownSync(dir, 0, proxyGid);
    chmodSync(dir, 0o750);
    const socket = join(dir, "http.sock");
    // In its own process: curl runs synchronously here, so this one could not accept meanwhile.
    const listener = Bun.spawn(
      [process.execPath, "-e", `Bun.listen({ unix: ${JSON.stringify(socket)}, socket: { open: (s) => void s.end(), data: () => {} } }); setInterval(() => {}, 1000);`],
      { stdout: "ignore", stderr: "inherit" },
    );
    for (let i = 0; i < 100 && !existsSync(socket); i++) await Bun.sleep(50);
    chownSync(socket, 0, proxyGid);
    chmodSync(socket, 0o770);
    const link = join(ROOT, "hosts", "early--close");
    symlinkSync("../early-close", link);
    try {
      const res = curl(`early--close.${DOMAIN}`, "/api/health", ["-H", "origin: https://app.example.com"]);
      expect(res.status).toBe(502);
      // The design's @ib_down had these on the 502 too: an `if` block inherits the location's add_header.
      expect(header(res, "x-incibase-unprocessed")).toBeUndefined();
      expect(header(res, "retry-after")).toBeUndefined();
      expect(header(res, "access-control-allow-origin")).toBe("*");
      const logged = accessLog((l) => l.label === "early--close").at(-1)!;
      note(`accept-then-close upstream: status ${logged.status}, upstream "${logged.upstream}", connect "${logged.connect}"`);
      expect(logged.connect).not.toBe("-");

      // The process dies (a crash, a restart) and leaves its socket file: ECONNREFUSED is a connect failure, so 503.
      listener.kill("SIGKILL");
      await listener.exited;
      expect(existsSync(socket)).toBe(true);
      const refused = curl(`early--close.${DOMAIN}`, "/api/health");
      expect(refused.status).toBe(503);
      expect(header(refused, "x-incibase-unprocessed")).toBe("1");
      const stale = accessLog((l) => l.label === "early--close").at(-1)!;
      note(`stale socket file, nobody listening: status ${stale.status}, upstream "${stale.upstream}", connect "${stale.connect}"`);
    } finally {
      listener.kill("SIGKILL");
      await listener.exited;
      unlinkSync(link);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the WebSocket upgrade works through nginx, both ways", async () => {
    const { status, frames } = await webSocketRoundTrip(DEV);
    expect(status).toMatch(/^HTTP\/1\.1 101/);
    expect(frames.some((f) => f.includes("BAD_MESSAGE"))).toBe(true);
    note(`WebSocket through nginx: ${status}, frames ${JSON.stringify(frames.map((f) => f.slice(0, 80)))}`);
  });

  test("a 50 MB upload streams to the branch; other paths keep the 2 MB limit", async () => {
    const { key } = await ops.serviceKeyCreate(ctx, { project: "shop", branch: "dev", label: "uploader", scopes: ["upload"] });
    const file = join(WORK, "50mb.bin");
    writeFileSync(file, Buffer.alloc(50 * 1024 * 1024, 7));
    // The control: a 1.5 MB body to a buffered path is spooled to nginx's client body temp file meanwhile.
    const medium = join(WORK, "1500k.json");
    writeFileSync(medium, JSON.stringify({ path: "messages:bumpCount", args: { key: "x".repeat(1500 * 1024) } }));
    const control = await watchSpooling(curlAsync(DEV, "/api/mutation", ["-X", "POST", "-H", "content-type: application/json", "--limit-rate", "600K", "--data-binary", `@${medium}`]));
    expect(control.spooled.length).toBeGreaterThan(0);
    const started = performance.now();
    // Slowed down (about 2.5 s), so a spooled body would be seen.
    const { res, spooled } = await watchSpooling(
      curlAsync(DEV, "/api/storage/upload", ["-X", "POST", "-H", `authorization: Bearer ${key}`, "-H", "content-type: application/octet-stream", "--limit-rate", "20M", "--data-binary", `@${file}`]),
    );
    const ms = Math.round(performance.now() - started);
    expect(res.status).toBe(200);
    const { storageId } = JSON.parse(res.body);
    expect(typeof storageId).toBe("string");
    // With proxy_request_buffering off nginx never spools the body to a temp file.
    expect(spooled).toEqual([]);
    note(`50 MB upload through nginx: 200 in ${ms} ms, no client body temp file (the 1.5 MB control to /api/mutation was spooled: ${control.spooled[0]})`);
    const big = join(WORK, "3mb.json");
    writeFileSync(big, JSON.stringify({ path: "messages:bumpCount", args: { key: "x".repeat(3 * 1024 * 1024) } }));
    const tooBig = curl(DEV, "/api/mutation", ["-X", "POST", "-H", "origin: https://app.example.com", "-H", "content-type: application/json", "--data-binary", `@${big}`]);
    expect(tooBig.status).toBe(413);
    // nginx's own 413 in serve's shape, readable by a browser.
    expect(header(tooBig, "content-type")).toBe("application/json");
    expect(header(tooBig, "access-control-allow-origin")).toBe("*");
    expect(JSON.parse(tooBig.body).error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(header(tooBig, "x-request-id")).toMatch(/^[0-9a-f]{32}$/);
  }, SLOW);

  const signIn = (options: CurlOptions = {}, extra: string[] = []) =>
    curl(DEV, "/api/auth/signin", ["-X", "POST", "-H", "origin: https://app.example.com", "-H", "content-type: application/json", "--data", '{"email":"x@example.com","password":"wrong password"}', ...extra], options);
  const preflight = (options: CurlOptions = {}, extra: string[] = []) =>
    curl(DEV, "/api/auth/signin", ["-X", "OPTIONS", "-H", "origin: https://app.example.com", "-H", "access-control-request-method: POST", "-H", "access-control-request-headers: content-type", ...extra], options);

  test("sign-in is rate limited per client address, with a 429 a browser can read; preflights are not counted", () => {
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      // A browser's preflight before each: none of them uses up the budget.
      expect(preflight().status).not.toBe(429);
      statuses.push(signIn().status);
    }
    note(`10 sign-ins in a row, each after a preflight: ${statuses.join(" ")}`);
    expect(statuses.slice(0, 6).every((s) => s !== 429)).toBe(true);
    expect(statuses.slice(6)).toEqual([429, 429, 429, 429]);
    const limited = signIn();
    expect(limited.status).toBe(429);
    expect(header(limited, "content-type")).toBe("application/json");
    expect(header(limited, "access-control-allow-origin")).toBe("*");
    expect(header(limited, "access-control-expose-headers")).toContain("retry-after");
    expect(header(limited, "retry-after")).toBe("6");
    expect(JSON.parse(limited.body).error.code).toBe("RATE_LIMITED");
    // Still the branch's own preflight answer, not nginx's.
    const after = preflight();
    expect(after.status).toBe(204);
    expect(header(after, "access-control-max-age")).toBe("86400");
  });

  test("an IPv6 client is counted by its /64: rotating addresses in it buys no fresh sign-in budget", () => {
    for (const addr of V6_ADDRS) run(["ip", "-6", "addr", "add", `${addr}/128`, "dev", "lo", "nodad"]);
    const [a, b, other] = V6_ADDRS as [string, string, string];
    const statuses: string[] = [];
    for (let i = 0; i < 4; i++) {
      for (const addr of [a, b]) statuses.push(`${addr}:${signIn({ to: "[::1]" }, ["--interface", addr]).status}`);
    }
    note(`sign-ins alternating between two addresses of one /64: ${statuses.map((s) => s.split(":").pop()).join(" ")}`);
    expect(statuses.filter((s) => !s.endsWith(":429")).length).toBe(6);
    const logged = accessLog((l) => l.path === "/api/auth/signin" && l.ip === b);
    expect(logged.length).toBe(4);
    // The next /64 has its own budget.
    expect(signIn({ to: "[::1]" }, ["--interface", other]).status).not.toBe(429);
    for (const addr of V6_ADDRS) run(["ip", "-6", "addr", "del", `${addr}/128`, "dev", "lo"]);
  });

  test("certificate rotation: copy, nginx -t, reload; the new certificate is served and the old pair removed", async () => {
    const old = { cert: ctx.registry.getSetting("tls_cert")!, key: ctx.registry.getSetting("tls_key")! };
    expect(servedFingerprint(DEV)).toBe(fingerprint(old.cert));
    const second = makeCert("second");
    const workersBefore = run(["pgrep", "-u", "www-data", "-x", "nginx"]).stdout;
    const result = await ops.setTls(ctx, second);
    expect(result.nginx).toMatchObject({ changed: true, action: "reload" });
    const deadline = Date.now() + 10_000;
    while (servedFingerprint(DEV) !== fingerprint(second.cert) && Date.now() < deadline) await Bun.sleep(100);
    expect(servedFingerprint(DEV)).toBe(fingerprint(second.cert));
    expect(existsSync(old.cert) || existsSync(old.key)).toBe(false);
    expect(run(["pgrep", "-u", "www-data", "-x", "nginx"]).stdout).not.toBe(workersBefore);
    cpSync(second.cert, join(WORK, "ca.crt"));
    expect(curl(DEV, "/api/health").status).toBe(200);
  }, SLOW);

  test("a config the rest of nginx rejects is never served: the previous file and setting stay", async () => {
    const text = readFileSync(files.conf, "utf8");
    // Port 80 already has Ubuntu's default_server.
    const err = await ops.setFrontDoor(ctx, { httpsPort: 80 }).then(() => null, (e) => e);
    expect(err?.code).toBe("FAILED");
    note(`port 80 refused: ${String(err?.message).split("\n").find((l) => l.includes("[emerg]")) ?? err?.message}`);
    expect(readFileSync(files.conf, "utf8")).toBe(text);
    expect(ctx.registry.getSetting("https_port")).toBe(String(PORT));
    expect(run(["nginx", "-t", "-q"]).code).toBe(0);
    expect(curl(DEV, "/api/health").status).toBe(200);
  });
});
