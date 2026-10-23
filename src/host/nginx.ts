// The front door (design sections 3.2 A/B, 5.4 and 9): one nginx file,
// `/etc/nginx/conf.d/<prefix>.conf`, with no line per branch. A request for
// `https://<branch>--<project>.<domain>` is proxied to
// `<root>/hosts/<branch>--<project>/http.sock`, the link provisioning keeps,
// so creating or deleting a branch never touches nginx. The file is rendered
// from the registry's settings (domain, trust_proxy, TLS paths, port):
//
//   - it is tested on its own with `nginx -t` (a small main config that
//     includes only the candidate) before it replaces anything,
//   - then swapped in atomically and the whole configuration tested again;
//     a failure puts the previous file back, so nginx never reloads a bad one,
//   - nginx reloads only when the file (or www-data's groups) changed.
//
// TLS (recipe A: a Cloudflare Origin CA wildcard certificate) is copied into
// `<root>/tls/` (root 0700; the key 0600) under names derived from the pair's
// sha256, so a rotation writes new files, renders, reloads and only then
// removes the old pair: nginx never sees half a rotation.
//
// Also rendered: `nginx.service.d/50-<prefix>.conf` (OOMScoreAdjust=-900,
// MemoryMin=64M: the front door outlives the branches under memory pressure),
// and www-data joins the proxy group, which is what lets it traverse hosts/
// and connect to http.sock (both 0750/0770 to that group).
import { X509Certificate, createPrivateKey } from "node:crypto";
import { join } from "node:path";
import type { OpsContext } from "./context.ts";
import type { HostLayout } from "./layout.ts";
import { checkDomain } from "./names.ts";
import { currentActor, type Registry } from "./registry.ts";
import { removeIfPresent, writeIfChanged } from "./render.ts";
import { checkAccountName, SystemCommandError } from "./system.ts";

export const NGINX_SERVICE = "nginx.service";
export const TRUST_PROXY = ["none", "cloudflare"] as const;
export type TrustProxy = (typeof TRUST_PROXY)[number];
export const DEFAULT_HTTPS_PORT = 443;

/**
 * Cloudflare's published edge ranges (https://www.cloudflare.com/ips-v4 and
 * ips-v6, fetched 2026-10-23). With trust_proxy=cloudflare nginx takes the
 * client address from CF-Connecting-IP only when the peer is in one of
 * them. The list changes rarely; a later `host doctor` / update command
 * compares it with the published one (step 13).
 */
export const CLOUDFLARE_RANGES_CHECKED = "2026-10-23";
export const CLOUDFLARE_RANGES: readonly string[] = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
];

/** Request headers a client could use to pose as someone else (or as a proxy); never passed to a branch. */
export const STRIPPED_HEADERS: readonly string[] = [
  "Forwarded",
  "X-Real-IP",
  "X-Forwarded-Host",
  "X-Forwarded-Port",
  "X-Forwarded-Prefix",
  "X-Forwarded-Server",
  "X-Forwarded-Scheme",
  "X-Forwarded-Ssl",
  "X-Client-IP",
  "True-Client-IP",
  "CF-Connecting-IP",
];

/** Why a front-door change was refused: INVALID input, or nginx FAILED it (ops map it to OpError). */
export class FrontDoorError extends Error {
  constructor(
    readonly code: "INVALID" | "FAILED",
    message: string,
  ) {
    super(message);
    this.name = "FrontDoorError";
  }
}

/** What the host asks of nginx itself; LinuxNginx on a machine, a fake in tests. */
export interface NginxControl {
  /** `nginx -t -q -c <config>`; never throws for a bad config or a missing nginx. */
  test(config: string): { ok: boolean; output: string };
  /** Adds `user` to the supplementary `group` (`usermod --append --groups`). */
  addToGroup(user: string, group: string): void;
}

/** Where nginx keeps things on this machine; the defaults are Ubuntu's. */
export interface NginxOptions {
  confDir?: string;
  mainConfig?: string;
  logDir?: string;
  /** The user nginx's workers run as. */
  user?: string;
  control?: NginxControl;
}

export const DEFAULT_NGINX = {
  confDir: "/etc/nginx/conf.d",
  mainConfig: "/etc/nginx/nginx.conf",
  logDir: "/var/log/nginx",
  user: "www-data",
} as const;

const ENV = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" };

export class LinuxNginx implements NginxControl {
  test(config: string) {
    let result;
    try {
      result = Bun.spawnSync(["nginx", "-t", "-q", "-c", checkNginxPath(config)], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: ENV });
    } catch (err) {
      return { ok: false, output: `nginx could not run (${(err as Error).message}); install it with apt install nginx` };
    }
    return { ok: result.exitCode === 0, output: `${result.stderr.toString()}${result.stdout.toString()}`.trim() };
  }

  addToGroup(user: string, group: string) {
    const command = ["usermod", "--append", "--groups", checkAccountName(group), "--", checkAccountName(user)];
    const result = Bun.spawnSync(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: ENV });
    if (result.exitCode !== 0) throw new SystemCommandError(command, result.exitCode, result.stderr.toString());
  }
}

/** Paths that go into nginx's config: no spaces, quotes, `;`, `{`, `$` or `#` that nginx would read as syntax. */
const NGINX_PATH = /^\/[A-Za-z0-9._/-]+$/;

export function checkNginxPath(path: string): string {
  if (!NGINX_PATH.test(path) || path.split("/").some((part) => part === "..")) {
    throw new FrontDoorError("INVALID", `Refusing to write ${JSON.stringify(path)} into an nginx config`);
  }
  return path;
}

export function checkTrustProxy(value: unknown): TrustProxy {
  if (!TRUST_PROXY.includes(value as TrustProxy)) {
    throw new FrontDoorError("INVALID", `trust_proxy must be one of ${TRUST_PROXY.join(", ")}, got ${JSON.stringify(value)}`);
  }
  return value as TrustProxy;
}

export function checkPort(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new FrontDoorError("INVALID", `The HTTPS port must be an integer from 1 to 65535, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** The nginx and systemd files of this host's front door. */
export interface NginxFiles {
  /** `<confDir>/<prefix>.conf`. */
  conf: string;
  mainConfig: string;
  /** `<systemdDir>/nginx.service.d/50-<prefix>.conf`. */
  dropIn: string;
  accessLog: string;
  /** `<root>/tls`, root 0700. */
  tlsDir: string;
  /** Where candidates are tested, under control/ (root 0700). */
  testDir: string;
  /** What names (zones, the map variable, the log format) start with: unique per host, as nginx's are global. */
  stem: string;
  user: string;
}

export function nginxFiles(layout: HostLayout, options: NginxOptions = {}): NginxFiles {
  const prefix = layout.units.prefix;
  const confDir = checkNginxPath(options.confDir ?? DEFAULT_NGINX.confDir);
  const logDir = checkNginxPath(options.logDir ?? DEFAULT_NGINX.logDir);
  return {
    conf: join(confDir, `${prefix}.conf`),
    mainConfig: checkNginxPath(options.mainConfig ?? DEFAULT_NGINX.mainConfig),
    dropIn: join(layout.systemdDir, `${NGINX_SERVICE}.d`, `50-${prefix}.conf`),
    accessLog: join(logDir, `${prefix}.access.log`),
    tlsDir: join(layout.root, "tls"),
    testDir: join(layout.control, "nginx"),
    stem: prefix.replaceAll("-", "_"),
    user: checkAccountName(options.user ?? DEFAULT_NGINX.user),
  };
}

// ---- the config ------------------------------------------------------------------

export interface NginxConfigInput {
  layout: HostLayout;
  files: Pick<NginxFiles, "accessLog" | "stem">;
  domain: string;
  port: number;
  trustProxy: TrustProxy;
  cert: string;
  key: string;
}

const HEADER = "# Rendered by incibase from control/registry.db; changes here are overwritten.\n";
const NOT_FOUND = `'{"error":{"code":"NOT_FOUND","message":"Not found"}}'`;
const UNAVAILABLE = `'{"error":{"code":"BRANCH_UNAVAILABLE","message":"The branch is restarting; send the request again"}}'`;
/** The CORS headers serve itself sends (src/engine/http.ts), so a browser can read the 503 during a restart. */
const CORS_ALLOW_HEADERS = "authorization, content-type, x-incibase-as-user, x-request-id, mcp-protocol-version, mcp-session-id";
const CORS_EXPOSE_HEADERS = "x-request-id, x-incibase-unprocessed, retry-after";
/** A label branchLabel makes: two slugs joined by "--" (neither has "--" of its own). */
const LABEL_PATTERN = "[a-z0-9]+(?:-[a-z0-9]+)*--[a-z0-9]+(?:-[a-z0-9]+)*";

/** `/etc/nginx/conf.d/<prefix>.conf`: the same text for every branch the host will ever have. */
export function nginxConfig(input: NginxConfigInput): string {
  const { layout, files, port } = input;
  const s = files.stem;
  const domain = checkDomain(input.domain).replaceAll(".", "\\.");
  const hosts = checkNginxPath(layout.hosts);
  const upstream = "proxy_pass http://unix:$ib/http.sock:;";
  // nginx 1.24 (Ubuntu 24.04) has no `http2 on;` (1.25.1+); the listen parameter works on both.
  const listen = (extra = "") => [`    listen ${checkPort(port)} ssl http2${extra};`, `    listen [::]:${port} ssl http2${extra};`].join("\n");
  const realIp =
    input.trustProxy === "cloudflare"
      ? `\n    # Cloudflare (recipe A): the client address comes from CF-Connecting-IP, only from Cloudflare's ranges (${CLOUDFLARE_RANGES_CHECKED}).\n` +
        CLOUDFLARE_RANGES.map((range) => `    set_real_ip_from ${range};`).join("\n") +
        "\n    real_ip_header CF-Connecting-IP;\n"
      : "";
  return `${HEADER}# The front door of the incibase host at ${checkNginxPath(layout.root)}: https://<branch>--<project>.${input.domain}
# goes to ${hosts}/<branch>--<project>/http.sock. Nothing here is per branch: the hosts/ links route.

map $http_upgrade $${s}_connection {
    default upgrade;
    "" close;
}
limit_req_zone $binary_remote_addr zone=${s}_ip:20m rate=50r/s;
limit_req_zone $binary_remote_addr zone=${s}_auth:10m rate=10r/m;
limit_conn_zone $binary_remote_addr zone=${s}_ip_conn:10m;
limit_conn_zone $ib_label zone=${s}_branch_conn:10m;
# No query strings ($uri, not $request_uri): they can carry upload tokens and signed URLs.
log_format ${s}_json escape=json '{"t":"$time_iso8601","label":"$ib_label","method":"$request_method","path":"$uri",'
    '"status":$status,"bytes":$body_bytes_sent,"s":$request_time,"upstream":"$upstream_status",'
    '"connect":"$upstream_connect_time","ip":"$remote_addr","rid":"$request_id"}';

server {
${listen()}
    server_name "~^(?<ib_label>${LABEL_PATTERN})\\.${domain}$";

    ssl_certificate ${checkNginxPath(input.cert)};
    ssl_certificate_key ${checkNginxPath(input.key)};
    ssl_protocols TLSv1.2 TLSv1.3;
${realIp}
    access_log ${checkNginxPath(files.accessLog)} ${s}_json;
    default_type application/json;

    set $ib ${hosts}/$ib_label;
    if (!-d $ib) {
        return 404 ${NOT_FOUND};
    }

    limit_req zone=${s}_ip burst=100 nodelay;
    limit_req_status 429;
    limit_conn ${s}_ip_conn 200;
    limit_conn ${s}_branch_conn 5000;
    limit_conn_status 429;
    client_max_body_size 2m;

    # One request per connection to the branch (no keepalive), WebSocket upgrades passed on.
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $${s}_connection;
    # What the branch sees of the client is what nginx saw, never what the client claims.
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
${STRIPPED_HEADERS.map((name) => `    proxy_set_header ${name} "";`).join("\n")}
    proxy_set_header x-request-id $request_id;
    # Cookies stay on their branch's hostname: an empty Domain= is ignored by browsers (RFC 6265 5.2.3).
    proxy_cookie_domain ~.+ "";
    # A branch's response cannot make nginx serve something else.
    proxy_ignore_headers X-Accel-Redirect X-Accel-Expires X-Accel-Limit-Rate X-Accel-Charset;
    proxy_connect_timeout 5s;
    proxy_send_timeout 135s;
    proxy_read_timeout 135s;
    error_page 502 = @ib_down;

    location ~ ^/(?:_|api/admin|api/schema)(?:/|$) {
        return 404 ${NOT_FOUND};
    }
    location ~ ^/api/auth/(?:signin|signup|password)$ {
        limit_req zone=${s}_auth burst=5 nodelay;
        limit_req zone=${s}_ip burst=100 nodelay;
        ${upstream}
    }
    location = /api/ws {
        proxy_read_timeout 130s;
        proxy_send_timeout 130s;
        ${upstream}
    }
    location = /api/storage/upload {
        client_max_body_size 101m;
        proxy_request_buffering off;
        ${upstream}
    }
    location / {
        ${upstream}
    }

    # The branch's socket refused the connection (restart, stop): nothing reached it, so the client may send it again.
    # Any other 502 (the branch accepted and then failed) stays a 502.
    location @ib_down {
        if ($upstream_connect_time != "-") {
            # Its own add_header: an if block inherits the ones below otherwise, and this 502 must not say unprocessed.
            add_header Access-Control-Allow-Origin * always;
            return 502;
        }
        add_header Access-Control-Allow-Origin * always;
        add_header Access-Control-Allow-Methods "GET, POST, PUT, PATCH, DELETE, OPTIONS" always;
        add_header Access-Control-Allow-Headers "${CORS_ALLOW_HEADERS}" always;
        add_header Access-Control-Expose-Headers "${CORS_EXPOSE_HEADERS}" always;
        add_header Retry-After 1 always;
        add_header x-incibase-unprocessed 1 always;
        add_header x-request-id $request_id always;
        if ($request_method = OPTIONS) {
            return 204;
        }
        return 503 ${UNAVAILABLE};
    }
}

# Any other name (or none) on this port: no certificate is shown at all.
server {
${listen(" default_server")}
    ssl_reject_handshake on;
    access_log off;
    return 444;
}
`;
}

/** `nginx.service.d/50-<prefix>.conf`: under memory pressure the kernel kills branches before the front door. */
export function nginxDropIn(): string {
  return `${HEADER}[Service]
OOMScoreAdjust=-900
MemoryMin=64M
`;
}

/** A main config that loads only `candidate`, for `nginx -t` before the candidate replaces anything. */
export function testHarness(candidate: string): string {
  return `${HEADER}# Tests one candidate front door on its own: nginx -t -c <this file>.
error_log stderr;
events {}
http {
    include ${checkNginxPath(candidate)};
}
`;
}

// ---- settings ----------------------------------------------------------------------

export interface FrontDoorSettings {
  domain: string;
  port: number;
  trustProxy: TrustProxy;
  cert: string;
  key: string;
}

/** The front door's settings, checked; `missing` names what `host init` still needs. */
export function frontDoorSettings(registry: Registry): FrontDoorSettings | { missing: string } {
  const domain = registry.getSetting("domain");
  if (!domain) return { missing: "a domain (host init --domain)" };
  const cert = registry.getSetting("tls_cert");
  const key = registry.getSetting("tls_key");
  if (!cert || !key) return { missing: "a TLS certificate (host init --tls-cert … --tls-key …)" };
  const port = registry.getSetting("https_port");
  return {
    domain: checkDomain(domain),
    port: port === null ? DEFAULT_HTTPS_PORT : checkPort(Number(port)),
    trustProxy: checkTrustProxy(registry.getSetting("trust_proxy") ?? "none"),
    cert: checkNginxPath(cert),
    key: checkNginxPath(key),
  };
}

// ---- rendering ---------------------------------------------------------------------

export interface NginxReport {
  /** Why nothing was rendered, when the host lacks a setting. */
  skipped?: string;
  conf?: string;
  /** The config file changed. */
  changed: boolean;
  /** The worker user was added to the proxy group. */
  groupAdded: boolean;
  dropInChanged: boolean;
  /** What nginx was asked to do: reload (config or groups), restart (the drop-in), start (it was stopped), or nothing. */
  action: "reload" | "restart" | "start" | null;
}

const control = (ctx: OpsContext) => ctx.nginx?.control ?? new LinuxNginx();
const filesOf = (ctx: OpsContext) => nginxFiles(ctx.layout, ctx.nginx);
const actor = (ctx: OpsContext) => ctx.actor ?? currentActor();
const now = (ctx: OpsContext) => (ctx.now ?? Date.now)();
const ROOT_ONLY_DIR = 0o700;

function ensureRootDir(ctx: OpsContext, path: string, mode: number) {
  const info = ctx.sys.lstat(path);
  if (info && info.type !== "dir") throw new FrontDoorError("FAILED", `${path} exists and is not a directory`);
  if (!info) ctx.sys.mkdir(path, mode);
  const after = ctx.sys.lstat(path)!;
  if (after.uid !== 0 || after.gid !== 0) ctx.sys.chown(path, 0, 0);
  if (ctx.sys.lstat(path)!.mode !== mode) ctx.sys.chmod(path, mode);
}

/** `nginx -t` on `content` alone, in a harness under control/; throws FAILED with nginx's words. */
function testCandidate(ctx: OpsContext, files: NginxFiles, content: string) {
  ensureRootDir(ctx, files.testDir, ROOT_ONLY_DIR);
  const candidate = join(files.testDir, "candidate.conf");
  const harness = join(files.testDir, "harness.conf");
  const owner = { uid: 0, gid: 0, mode: 0o600 };
  try {
    ctx.sys.writeFile(candidate, content, owner);
    ctx.sys.writeFile(harness, testHarness(candidate), owner);
    const result = control(ctx).test(harness);
    if (!result.ok) throw new FrontDoorError("FAILED", `nginx rejected the new front door; nothing was changed:\n${result.output}`);
  } finally {
    removeIfPresent(ctx, candidate);
    removeIfPresent(ctx, harness);
  }
}

/**
 * Renders the front door from the registry and makes nginx serve it. Safe
 * to run any time: nothing is written, and nginx is not touched, when
 * nothing changed. Needs nginx installed (its unit loaded).
 */
export async function renderNginx(ctx: OpsContext): Promise<NginxReport> {
  return ctx.registry.withLock(() => {
    const report: NginxReport = { changed: false, groupAdded: false, dropInChanged: false, action: null };
    const settings = frontDoorSettings(ctx.registry);
    if ("missing" in settings) return { ...report, skipped: `the host has no ${settings.missing}` };
    const files = filesOf(ctx);
    report.conf = files.conf;
    if (ctx.driver.show(NGINX_SERVICE).loadState === "not-found") {
      throw new FrontDoorError("FAILED", `${NGINX_SERVICE} is not installed: apt install nginx, then incibase host render`);
    }
    const content = nginxConfig({ layout: ctx.layout, files, ...settings });

    const proxy = ctx.layout.groups.proxy;
    const group = ctx.sys.getgrnam(proxy);
    if (!group) throw new FrontDoorError("FAILED", `The group ${proxy} does not exist: run incibase host init first`);
    if (!group.members.includes(files.user)) {
      control(ctx).addToGroup(files.user, proxy);
      report.groupAdded = true;
    }

    const current = ctx.sys.lstat(files.conf)?.type === "file" ? ctx.sys.readFile(files.conf) : null;
    const confOwner = { uid: 0, gid: 0, mode: 0o644 };
    const confInfo = ctx.sys.lstat(files.conf);
    if (current !== content || confInfo?.uid !== 0 || confInfo.mode !== confOwner.mode) {
      if (current !== content) testCandidate(ctx, files, content);
      ctx.sys.writeFile(files.conf, content, confOwner);
      // With the rest of nginx's config: another site may clash (a second default_server, a zone name).
      const whole = control(ctx).test(files.mainConfig);
      if (!whole.ok) {
        if (current === null) removeIfPresent(ctx, files.conf);
        else ctx.sys.writeFile(files.conf, current, confOwner);
        throw new FrontDoorError("FAILED", `nginx's whole configuration fails with the new front door; the previous file is back:\n${whole.output}`);
      }
      report.changed = current !== content;
    }

    const dropInDir = files.dropIn.slice(0, files.dropIn.lastIndexOf("/"));
    if (!ctx.sys.lstat(dropInDir)) ctx.sys.mkdir(dropInDir, 0o755);
    report.dropInChanged = writeIfChanged(ctx, files.dropIn, nginxDropIn(), { uid: 0, gid: 0, mode: 0o644 });

    if (report.dropInChanged) ctx.driver.daemonReload();
    const active = ctx.driver.isActive(NGINX_SERVICE);
    if (!active) {
      ctx.driver.start(NGINX_SERVICE);
      report.action = "start";
    } else if (report.dropInChanged) {
      // OOMScoreAdjust applies when the master starts; a reload keeps the old one.
      ctx.driver.restart(NGINX_SERVICE);
      report.action = "restart";
    } else if (report.changed || report.groupAdded) {
      // New workers come from the master with the new config and initgroups() again (the proxy group).
      ctx.driver.reload(NGINX_SERVICE);
      report.action = "reload";
    }
    if (report.changed || report.groupAdded || report.dropInChanged) {
      ctx.registry.audit(
        { actor: actor(ctx), action: "nginx.render", detail: { conf: files.conf, changed: report.changed, groupAdded: report.groupAdded, action: report.action }, ok: true },
        now(ctx),
      );
    }
    return report;
  });
}

// ---- TLS -------------------------------------------------------------------------------

const MAX_PEM_BYTES = 64 * 1024;
const TLS_FILE = /^[0-9a-f]{16}\.(?:crt|key)$/;

export interface CertificateInfo {
  subject: string;
  subjectAltName: string | null;
  notAfter: string;
  fingerprint256: string;
}

function readPem(ctx: OpsContext, path: string, what: string): string {
  if (!path.startsWith("/") || path.includes("\0")) throw new FrontDoorError("INVALID", `The ${what} must be an absolute path, got ${JSON.stringify(path)}`);
  const info = ctx.sys.lstat(path);
  if (!info || (info.type !== "file" && info.type !== "symlink")) throw new FrontDoorError("INVALID", `The ${what} ${path} is not a file`);
  const text = ctx.sys.readFile(path);
  if (text === null) throw new FrontDoorError("INVALID", `The ${what} ${path} is not a file`);
  if (text.length > MAX_PEM_BYTES || !/^[\x09\x0a\x0d\x20-\x7e]*$/.test(text)) throw new FrontDoorError("INVALID", `The ${what} ${path} is not a PEM file`);
  return text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * Checks a certificate and key pair: PEM, matching, not expired, and
 * covering every branch hostname (`*.<domain>`).
 */
export function checkCertificate(certPem: string, keyPem: string, domain: string, at = Date.now()): CertificateInfo {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certPem);
  } catch {
    throw new FrontDoorError("INVALID", "The certificate is not a PEM certificate");
  }
  let key;
  try {
    key = createPrivateKey(keyPem);
  } catch {
    throw new FrontDoorError("INVALID", "The key is not a PEM private key");
  }
  if (!cert.checkPrivateKey(key)) throw new FrontDoorError("INVALID", "The key does not belong to the certificate");
  if (cert.validToDate.getTime() <= at) throw new FrontDoorError("INVALID", `The certificate expired on ${cert.validTo}`);
  if (cert.validFromDate.getTime() > at) throw new FrontDoorError("INVALID", `The certificate is not valid before ${cert.validFrom}`);
  // A branch hostname has one label under the domain; a wildcard *.<domain> covers them all.
  if (!cert.checkHost(`x--y.${checkDomain(domain)}`)) {
    throw new FrontDoorError("INVALID", `The certificate does not cover *.${domain} (it names ${cert.subjectAltName ?? cert.subject})`);
  }
  return { subject: cert.subject, subjectAltName: cert.subjectAltName ?? null, notAfter: cert.validToDate.toISOString(), fingerprint256: cert.fingerprint256 };
}

/**
 * Installs a certificate and key (recipe A, also a rotation): checked, copied
 * to `<root>/tls/` (key 0600), tested with nginx before the registry points
 * at them, then rendered and reloaded; the previous pair is removed after.
 * A failure before the commit removes the new copies and leaves everything
 * as it was.
 */
export async function setTls(ctx: OpsContext, input: { cert: string; key: string }) {
  const domain = ctx.registry.getSetting("domain");
  if (!domain) throw new FrontDoorError("INVALID", "The host has no domain: set it with host init --domain first");
  const certPem = readPem(ctx, input.cert, "certificate");
  const keyPem = readPem(ctx, input.key, "key");
  // Validity is about the real clock, whatever ctx.now says.
  const info = checkCertificate(certPem, keyPem, domain);
  const files = filesOf(ctx);
  const id = new Bun.CryptoHasher("sha256").update(certPem).update("\0").update(keyPem).digest("hex").slice(0, 16);
  const cert = join(files.tlsDir, `${id}.crt`);
  const key = join(files.tlsDir, `${id}.key`);
  await ctx.registry.withLock(() => {
    const before = { cert: ctx.registry.getSetting("tls_cert"), key: ctx.registry.getSetting("tls_key") };
    const fresh = before.cert !== cert;
    ensureRootDir(ctx, files.tlsDir, ROOT_ONLY_DIR);
    writeIfChanged(ctx, cert, certPem, { uid: 0, gid: 0, mode: 0o644 });
    writeIfChanged(ctx, key, keyPem, { uid: 0, gid: 0, mode: 0o600 });
    try {
      const port = checkPort(Number(ctx.registry.getSetting("https_port") ?? DEFAULT_HTTPS_PORT));
      const trustProxy = checkTrustProxy(ctx.registry.getSetting("trust_proxy") ?? "none");
      testCandidate(ctx, files, nginxConfig({ layout: ctx.layout, files, domain, port, trustProxy, cert, key }));
    } catch (err) {
      if (fresh) {
        removeIfPresent(ctx, cert);
        removeIfPresent(ctx, key);
      }
      throw err;
    }
    ctx.registry.tx(() => {
      ctx.registry.setSetting("tls_cert", cert);
      ctx.registry.setSetting("tls_key", key);
      ctx.registry.audit({ actor: actor(ctx), action: "nginx.tls", detail: { ...info, cert, rotated: before.cert !== null && fresh }, ok: true }, now(ctx));
    });
  });
  const report = await renderNginx(ctx);
  // nginx now serves the new pair: the old copies can go.
  const removed = await ctx.registry.withLock(() => {
    const gone: string[] = [];
    for (const name of ctx.sys.readdir(files.tlsDir)) {
      const path = join(files.tlsDir, name);
      if (!TLS_FILE.test(name) || path === cert || path === key) continue;
      removeIfPresent(ctx, path);
      gone.push(name);
    }
    return gone;
  });
  return { certificate: info, cert, key, removed, nginx: report };
}

/** Changes how the front door trusts a proxy in front of it, or its port, and renders it. */
export async function setFrontDoor(ctx: OpsContext, input: { trustProxy?: TrustProxy; httpsPort?: number }) {
  const trustProxy = input.trustProxy === undefined ? undefined : checkTrustProxy(input.trustProxy);
  const port = input.httpsPort === undefined ? undefined : checkPort(input.httpsPort);
  const previous = await ctx.registry.withLock(() => {
    const before = { trustProxy: ctx.registry.getSetting("trust_proxy"), httpsPort: ctx.registry.getSetting("https_port") };
    ctx.registry.tx(() => {
      if (trustProxy !== undefined) ctx.registry.setSetting("trust_proxy", trustProxy);
      if (port !== undefined) ctx.registry.setSetting("https_port", String(port));
      ctx.registry.audit({ actor: actor(ctx), action: "nginx.set", detail: { trustProxy, httpsPort: port }, ok: true }, now(ctx));
    });
    return before;
  });
  try {
    return { nginx: await renderNginx(ctx) };
  } catch (err) {
    // nginx kept the old file; the registry goes back to what it serves.
    await ctx.registry.withLock(() =>
      ctx.registry.tx(() => {
        const put = (key: string, value: string | null) =>
          value === null ? ctx.registry.db.run(`DELETE FROM settings WHERE key = ?`, [key]) : ctx.registry.setSetting(key, value);
        if (trustProxy !== undefined) put("trust_proxy", previous.trustProxy);
        if (port !== undefined) put("https_port", previous.httpsPort);
      }),
    );
    throw err;
  }
}

export interface FrontDoorInit {
  tlsCert?: string;
  tlsKey?: string;
  trustProxy?: TrustProxy;
  httpsPort?: number;
}

/** The front-door part of `host init`: its settings, then the certificate (which renders and reloads nginx). */
export async function initFrontDoor(ctx: OpsContext, input: FrontDoorInit) {
  if ((input.tlsCert === undefined) !== (input.tlsKey === undefined)) throw new FrontDoorError("INVALID", "--tls-cert and --tls-key go together");
  let nginx: NginxReport | null = null;
  if (input.trustProxy !== undefined || input.httpsPort !== undefined) {
    nginx = (await setFrontDoor(ctx, { trustProxy: input.trustProxy, httpsPort: input.httpsPort })).nginx;
  }
  if (input.tlsCert !== undefined && input.tlsKey !== undefined) {
    const tls = await setTls(ctx, { cert: input.tlsCert, key: input.tlsKey });
    return { certificate: tls.certificate, nginx: tls.nginx };
  }
  return nginx ? { certificate: null, nginx } : null;
}
