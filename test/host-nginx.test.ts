// The nginx front door (design sections 3.2 A/B, 5.4) on a fake host: the
// rendered config, input checks, TLS install and rotation, and that a config
// nginx rejects never replaces the one it serves. The behaviour against a
// real nginx is in host-nginx-linux.test.ts.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostLayout } from "../src/host/layout.ts";
import {
  checkCertificate,
  checkNginxPath,
  CLIENT_KEY_MAP,
  CLOUDFLARE_RANGES,
  nginxConfig,
  nginxDropIn,
  nginxFiles,
  NGINX_SERVICE,
  type NginxControl,
} from "../src/host/nginx.ts";
import * as ops from "../src/host/ops.ts";
import type { FakeSystem } from "../src/host/fake-system.ts";
import { closeOpsHosts, fakeOpsHost, type OpsTestHost } from "./host-helpers.ts";

afterEach(closeOpsHosts);

const DOMAIN = "incibase.example.net";
let certs = "";

/** A self-signed certificate (openssl), as recipe A's Origin CA one would be: a wildcard for the domain. */
function makeCert(name: string, names = `DNS:*.${DOMAIN},DNS:${DOMAIN}`, days = 30) {
  const cert = join(certs, `${name}.crt`);
  const key = join(certs, `${name}.key`);
  const result = Bun.spawnSync(
    ["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", key, "-out", cert, "-days", String(days), "-subj", `/CN=${name}`, "-addext", `subjectAltName=${names}`],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return { cert, key };
}

beforeAll(() => {
  certs = mkdtempSync(join(tmpdir(), "incibase-certs-"));
});
afterAll(() => rmSync(certs, { recursive: true, force: true }));

/** Plays nginx: `test` reads the harness or main config and what it includes; `reject` decides. */
class FakeNginx implements NginxControl {
  readonly tests: { config: string; text: string }[] = [];
  reject: (config: string, text: string) => string | null = () => null;
  constructor(
    private readonly sys: FakeSystem,
    private readonly confDir: string,
  ) {}

  test(config: string) {
    const main = readFileSync(config, "utf8");
    const included = [...main.matchAll(/^\s*include (\S+);$/gm)].map((m) => readFileSync(m[1]!, "utf8"));
    // The main config includes conf.d/*.conf as nginx's does.
    if (!included.length) for (const name of readdirSync(this.confDir).filter((n) => n.endsWith(".conf"))) included.push(readFileSync(join(this.confDir, name), "utf8"));
    const text = included.join("\n");
    this.tests.push({ config, text });
    const why = this.reject(config, text);
    return why ? { ok: false, output: why } : { ok: true, output: "" };
  }

  addToGroup(user: string, group: string) {
    this.sys.groups.get(group)!.members.push(user);
  }
}

interface NginxHost extends OpsTestHost {
  fake: FakeNginx;
  conf: string;
}

/** A fake ops host with nginx installed: conf.d, a main config and nginx.service under its temp dir. */
async function nginxHost(): Promise<NginxHost> {
  const host = (await fakeOpsHost()) as NginxHost;
  const confDir = join(host.dir, "nginx", "conf.d");
  mkdirSync(confDir, { recursive: true });
  const mainConfig = join(host.dir, "nginx", "nginx.conf");
  writeFileSync(mainConfig, "# includes conf.d/*.conf\n");
  writeFileSync(host.layout.unitFile(NGINX_SERVICE), "[Service]\nExecStart=/usr/sbin/nginx\n");
  host.fake = new FakeNginx(host.sys, confDir);
  // What the nginx package and Ubuntu bring: the worker user and logrotate's group.
  host.sys.groups.set("www-data", { name: "www-data", gid: 33, members: [] });
  host.sys.users.set("www-data", { name: "www-data", uid: 33, gid: 33, gecos: "www-data", home: "/var/www", shell: "/usr/sbin/nologin" });
  host.sys.groups.set("adm", { name: "adm", gid: 4, members: [] });
  mkdirSync(join(host.dir, "log"));
  host.nginx = { confDir, mainConfig, logDir: join(host.dir, "log"), control: host.fake };
  host.conf = join(confDir, "incibase.conf");
  host.driver.calls.length = 0;
  return host;
}

/** IPv6 text as nginx 1.24 prints $remote_addr (ngx_inet6_ntop): the longest run of two or more zero hextets is "::". */
function ntop(groups: number[]): string {
  const bytes = groups.flatMap((g) => [g >> 8, g & 0xff]);
  let zero = -1;
  let last = -1;
  let max = 1;
  let n = 0;
  for (let i = 0; i < 16; i += 2) {
    if (bytes[i] || bytes[i + 1]) {
      if (max < n) [zero, max] = [last, n];
      n = 0;
      continue;
    }
    if (n++ === 0) last = i;
  }
  if (max < n) [zero, max] = [last, n];
  let out = "";
  let end = 16;
  if (zero === 0) {
    if ((max === 5 && bytes[10] === 0xff && bytes[11] === 0xff) || max === 6 || (max === 7 && bytes[14] !== 0 && bytes[15] !== 1)) end = 12;
    out += ":";
  }
  for (let i = 0; i < end; i += 2) {
    if (i === zero) {
      out += ":";
      i += (max - 1) * 2;
      continue;
    }
    out += ((bytes[i]! << 8) | bytes[i + 1]!).toString(16);
    if (i < 14) out += ":";
  }
  if (end === 12) out += bytes.slice(12).join(".");
  return out;
}

const settings = (host: OpsTestHost) => ({ cert: host.registry.getSetting("tls_cert"), key: host.registry.getSetting("tls_key") });
const nginxCalls = (host: OpsTestHost) => host.driver.calls.filter((c) => c.includes("nginx") || c === "daemon-reload");

describe("the rendered config", () => {
  const layout = new HostLayout();
  const files = nginxFiles(layout);
  const input = {
    layout,
    files,
    domain: "incibase.omergenc.net",
    port: 443,
    trustProxy: "none" as const,
    cert: "/var/lib/incibase/tls/0123456789abcdef.crt",
    key: "/var/lib/incibase/tls/0123456789abcdef.key",
  };

  test("routes every <branch>--<project> label through hosts/, with no line per branch", () => {
    expect(nginxConfig(input)).toBe(`# Rendered by incibase from control/registry.db; changes here are overwritten.
# host root: /var/lib/incibase
# The front door of the incibase host at /var/lib/incibase: https://<branch>--<project>.incibase.omergenc.net
# goes to /var/lib/incibase/hosts/<branch>--<project>/http.sock. Nothing here is per branch: the hosts/ links route.

map $http_upgrade $incibase_connection {
    default upgrade;
    "" close;
}
# Clients are counted per IPv4 address and per IPv6 /64.
map $remote_addr $incibase_client {
    default $binary_remote_addr;
    "~^([0-9a-f]+:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+):" $1;
    "~^::(?:[0-9a-f]+(?::[0-9a-f]+){0,3})?$" 0:0:0:0;
    "~^([0-9a-f]+)::(?:[0-9a-f]+(?::[0-9a-f]+){0,3})?$" $1:0:0:0;
    "~^([0-9a-f]+:[0-9a-f]+)::(?:[0-9a-f]+(?::[0-9a-f]+){0,3})?$" $1:0:0;
    "~^([0-9a-f]+:[0-9a-f]+:[0-9a-f]+)::(?:[0-9a-f]+(?::[0-9a-f]+){0,3})?$" $1:0;
    "~^::([0-9a-f]+)(?::[0-9a-f]+){4}$" 0:0:0:$1;
    "~^([0-9a-f]+)::([0-9a-f]+)(?::[0-9a-f]+){4}$" $1:0:0:$2;
    "~^::([0-9a-f]+:[0-9a-f]+)(?::[0-9a-f]+){4}$" 0:0:$1;
}
# Preflights do not use up the sign-in budget: a browser sends one before each sign-in.
map $request_method $incibase_auth_client {
    OPTIONS "";
    default $incibase_client;
}
map $uri $incibase_retry_after {
    ~^/api/auth/ 6;
    default 1;
}
limit_req_zone $incibase_client zone=incibase_ip:20m rate=50r/s;
limit_req_zone $incibase_auth_client zone=incibase_auth:10m rate=10r/m;
limit_conn_zone $incibase_client zone=incibase_ip_conn:10m;
limit_conn_zone $ib_label zone=incibase_branch_conn:10m;
# No query strings ($uri, not $request_uri): they can carry upload tokens and signed URLs.
log_format incibase_json escape=json '{"t":"$time_iso8601","label":"$ib_label","method":"$request_method","path":"$uri",'
    '"status":$status,"bytes":$body_bytes_sent,"s":$request_time,"upstream":"$upstream_status",'
    '"connect":"$upstream_connect_time","ip":"$remote_addr","rid":"$request_id"}';

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name "~^(?<ib_label>[a-z0-9]+(?:-[a-z0-9]+)*--[a-z0-9]+(?:-[a-z0-9]+)*)\\.incibase\\.omergenc\\.net$";

    ssl_certificate /var/lib/incibase/tls/0123456789abcdef.crt;
    ssl_certificate_key /var/lib/incibase/tls/0123456789abcdef.key;
    ssl_protocols TLSv1.2 TLSv1.3;

    access_log /var/log/nginx/incibase.access.log incibase_json;
    # nginx's own errors name the whole request line, query string included (upload tokens), for every
    # failed connect; those failures are in the access log already (status, upstream, connect), without it.
    error_log /var/log/nginx/incibase.error.log alert;
    default_type application/json;

    set $ib /var/lib/incibase/hosts/$ib_label;
    if (!-d $ib) {
        return 404 '{"error":{"code":"NOT_FOUND","message":"Not found"}}';
    }

    limit_req zone=incibase_ip burst=100 nodelay;
    limit_req_status 429;
    limit_conn incibase_ip_conn 200;
    limit_conn incibase_branch_conn 5000;
    limit_conn_status 429;
    client_max_body_size 2m;

    # One request per connection to the branch (no keepalive), WebSocket upgrades passed on.
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $incibase_connection;
    # What the branch sees of the client is what nginx saw, never what the client claims.
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Forwarded "";
    proxy_set_header X-Real-IP "";
    proxy_set_header X-Forwarded-Host "";
    proxy_set_header X-Forwarded-Port "";
    proxy_set_header X-Forwarded-Prefix "";
    proxy_set_header X-Forwarded-Server "";
    proxy_set_header X-Forwarded-Scheme "";
    proxy_set_header X-Forwarded-Ssl "";
    proxy_set_header X-Client-IP "";
    proxy_set_header True-Client-IP "";
    proxy_set_header CF-Connecting-IP "";
    proxy_set_header x-request-id $request_id;
    # Best effort, not isolation: "; Domain=x" becomes an empty Domain=, which browsers ignore (RFC 6265 5.2.3),
    # but nginx leaves a tab before or after "Domain" alone and never sees document.cookie. Branches share
    # the parent domain (and are same-site) until it is on the Public Suffix List (design 3.2 A).
    proxy_cookie_domain ~.+ "";
    # A branch's response cannot make nginx serve something else.
    proxy_ignore_headers X-Accel-Redirect X-Accel-Expires X-Accel-Limit-Rate X-Accel-Charset;
    proxy_connect_timeout 5s;
    proxy_send_timeout 135s;
    proxy_read_timeout 135s;
    error_page 502 = @ib_down;
    # What nginx refuses itself, readable by a browser and in serve's error shape.
    error_page 429 = @ib_limited;
    error_page 413 = @ib_too_large;

    location ~ ^/(?:_|api/admin|api/schema)(?:/|$) {
        return 404 '{"error":{"code":"NOT_FOUND","message":"Not found"}}';
    }
    location ~ ^/api/auth/(?:signin|signup|password)$ {
        limit_req zone=incibase_auth burst=5 nodelay;
        limit_req zone=incibase_ip burst=100 nodelay;
        proxy_pass http://unix:$ib/http.sock:;
    }
    location = /api/ws {
        proxy_read_timeout 130s;
        proxy_send_timeout 130s;
        proxy_pass http://unix:$ib/http.sock:;
    }
    location = /api/storage/upload {
        client_max_body_size 101m;
        proxy_request_buffering off;
        proxy_pass http://unix:$ib/http.sock:;
    }
    location / {
        proxy_pass http://unix:$ib/http.sock:;
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
        add_header Access-Control-Allow-Headers "authorization, content-type, x-incibase-as-user, x-request-id, mcp-protocol-version, mcp-session-id" always;
        add_header Access-Control-Expose-Headers "x-request-id, x-incibase-unprocessed, retry-after" always;
        add_header Retry-After 1 always;
        add_header x-incibase-unprocessed 1 always;
        add_header x-request-id $request_id always;
        if ($request_method = OPTIONS) {
            return 204;
        }
        return 503 '{"error":{"code":"BRANCH_UNAVAILABLE","message":"The branch is restarting; send the request again"}}';
    }
    # limit_req or limit_conn. A limited preflight is let through, so the browser can read the 429 of the request itself.
    location @ib_limited {
        add_header Access-Control-Allow-Origin * always;
        add_header Access-Control-Allow-Methods "GET, POST, PUT, PATCH, DELETE, OPTIONS" always;
        add_header Access-Control-Allow-Headers "authorization, content-type, x-incibase-as-user, x-request-id, mcp-protocol-version, mcp-session-id" always;
        add_header Access-Control-Expose-Headers "x-request-id, x-incibase-unprocessed, retry-after" always;
        add_header Retry-After $incibase_retry_after always;
        add_header x-request-id $request_id always;
        if ($request_method = OPTIONS) {
            return 204;
        }
        return 429 '{"error":{"code":"RATE_LIMITED","message":"Too many requests; send it again after Retry-After seconds"}}';
    }
    location @ib_too_large {
        add_header Access-Control-Allow-Origin * always;
        add_header Access-Control-Expose-Headers "x-request-id, x-incibase-unprocessed, retry-after" always;
        add_header x-request-id $request_id always;
        return 413 '{"error":{"code":"PAYLOAD_TOO_LARGE","message":"The request body is larger than this path accepts"}}';
    }
}

# Any other name (or none) on this port: no certificate is shown at all.
server {
    listen 443 ssl http2 default_server;
    listen [::]:443 ssl http2 default_server;
    ssl_reject_handshake on;
    access_log off;
    return 444;
}
`);
  });

  test("trust_proxy=cloudflare takes the client address from CF-Connecting-IP, only from Cloudflare's ranges", () => {
    const plain = nginxConfig(input);
    const cf = nginxConfig({ ...input, trustProxy: "cloudflare" });
    const added = cf.split("\n").filter((line) => !plain.split("\n").includes(line));
    expect(added.filter((l) => l.includes("set_real_ip_from"))).toEqual(CLOUDFLARE_RANGES.map((r) => `    set_real_ip_from ${r};`));
    expect(added).toContain("    real_ip_header CF-Connecting-IP;");
    expect(CLOUDFLARE_RANGES).toContain("173.245.48.0/20");
    expect(CLOUDFLARE_RANGES).toContain("2606:4700::/32");
    // Whatever the client sends as CF-Connecting-IP never reaches the branch.
    expect(cf).toContain('proxy_set_header CF-Connecting-IP "";');
    expect(plain).not.toContain("real_ip");
  });

  test("another host prefix, root and port get their own names, so two hosts can share one nginx on different ports", () => {
    const other = new HostLayout({ root: "/var/lib/incibase-n11", unitPrefix: "incibase-n11" });
    const text = nginxConfig({ ...input, layout: other, files: nginxFiles(other), port: 18443, cert: "/var/lib/incibase-n11/tls/a.crt", key: "/var/lib/incibase-n11/tls/a.key" });
    expect(nginxFiles(other).conf).toBe("/etc/nginx/conf.d/incibase-n11.conf");
    expect(nginxFiles(other).dropIn).toBe("/etc/systemd/system/nginx.service.d/50-incibase-n11.conf");
    for (const name of ["zone=incibase_n11_ip:", "zone=incibase_n11_auth:", "zone=incibase_n11_ip_conn:", "zone=incibase_n11_branch_conn:", "$incibase_n11_connection {", "log_format incibase_n11_json"]) {
      expect(text).toContain(name);
    }
    expect(text).toContain("set $ib /var/lib/incibase-n11/hosts/$ib_label;");
    expect(text).toContain("    listen 18443 ssl http2;\n    listen [::]:18443 ssl http2;");
    expect(text).toContain("    listen 18443 ssl http2 default_server;");
    expect(text).toContain("access_log /var/log/nginx/incibase-n11.access.log incibase_n11_json;");
    expect(text).toContain("error_log /var/log/nginx/incibase-n11.error.log alert;");
    for (const name of ["$incibase_n11_client {", "$incibase_n11_auth_client {", "limit_req_zone $incibase_n11_client ", "limit_req_zone $incibase_n11_auth_client ", "Retry-After $incibase_n11_retry_after"]) {
      expect(text).toContain(name);
    }
    expect(text).not.toContain("listen 443");
    // Each host has the default server of its own port: on one port the second fails nginx -t ("a duplicate default server").
    expect(text.match(/default_server/g)?.length).toBe(2);
  });

  test("the server name matches exactly the labels branchLabel makes, under this domain only", () => {
    const re = new RegExp(/server_name "~(.*)";/.exec(nginxConfig(input))![1]!.replace("(?<ib_label>", "(?<label>"));
    expect(re.exec("prod--shop.incibase.omergenc.net")?.groups?.label).toBe("prod--shop");
    expect(re.exec("feature-x--my-shop.incibase.omergenc.net")?.groups?.label).toBe("feature-x--my-shop");
    for (const host of ["shop.incibase.omergenc.net", "a.b--c.incibase.omergenc.net", "prod--shop.incibase.omergenc.net.evil.net", "prod--shop.incibasexomergenc.net", "../x--y.incibase.omergenc.net", "a---b.incibase.omergenc.net", "incibase.omergenc.net"]) {
      expect(re.test(host)).toBe(false);
    }
  });

  test("clients are counted per IPv4 address and per IPv6 /64, whatever compression nginx prints", () => {
    const text = nginxConfig(input);
    const block = /map \$remote_addr \$incibase_client \{\n([\s\S]*?)\n\}/.exec(text)![1]!;
    const rules = [...block.matchAll(/^ {4}"~(.*)" (\S+);$/gm)].map((m) => [new RegExp(m[1]!), m[2]!] as const);
    expect(rules.length).toBe(CLIENT_KEY_MAP.length);
    expect(block).toContain("default $binary_remote_addr;");
    /** What the map gives for an address as nginx prints it; null is the default ($binary_remote_addr). */
    const key = (addr: string) => {
      for (const [re, value] of rules) {
        const m = re.exec(addr);
        if (m) return value.replace(/\$(\d)/g, (_, i) => m[Number(i)]!);
      }
      return null;
    };
    const rand = (n: number) => Math.floor(Math.random() * n);
    for (let i = 0; i < 20_000; i++) {
      // Many zero hextets, so every place and length of "::" comes up.
      const groups = Array.from({ length: 8 }, () => (rand(2) ? 0 : rand(3) ? rand(0x10000) : rand(16)));
      const text = ntop(groups);
      const expected = text.includes(".") ? null : groups.slice(0, 4).map((g) => g.toString(16)).join(":");
      expect({ text, key: key(text) }).toEqual({ text, key: expected });
    }
    // Two addresses of one /64, written differently by nginx, share a key; the next /64 does not.
    expect(key("2001:db8::5")).toBe("2001:db8:0:0");
    expect(key("2001:db8:0:0:1::")).toBe("2001:db8:0:0");
    expect(key("2001:db8:1:2::a")).toBe(key("2001:db8:1:2:ffff:ffff:ffff:ffff"));
    expect(key("2001:db8:1:3::a")).toBe("2001:db8:1:3");
    expect(key("203.0.113.7")).toBeNull();
    expect(key("::ffff:203.0.113.7")).toBeNull();
    // Preflights are not counted against sign-ins.
    expect(text).toContain('map $request_method $incibase_auth_client {\n    OPTIONS "";\n    default $incibase_client;\n}');
  });

  test("the nginx drop-in keeps the front door alive under memory pressure", () => {
    expect(nginxDropIn(new HostLayout())).toBe(
      "# Rendered by incibase from control/registry.db; changes here are overwritten.\n# host root: /var/lib/incibase\n[Service]\nOOMScoreAdjust=-900\nMemoryMin=64M\n",
    );
  });

  test("nothing that nginx would read as syntax reaches the file", () => {
    for (const bad of ["/var/lib/a b", "/var/lib/a;b", "/var/lib/$x", "/var/lib/a{", "/var/lib/a#b", 'x/"y', "relative/path", "/var/lib/../etc"]) {
      expect(() => checkNginxPath(bad)).toThrow(/Refusing/);
    }
    expect(() => nginxConfig({ ...input, cert: "/x;y" })).toThrow(/Refusing/);
    expect(() => nginxConfig({ ...input, domain: "Evil.COM;" })).toThrow(/Invalid domain/);
    expect(() => nginxConfig({ ...input, port: 0 })).toThrow(/port/);
    expect(() => nginxFiles(layout, { confDir: "/etc/nginx/conf.d;" })).toThrow(/Refusing/);
    expect(() => nginxFiles(layout, { user: "-o" })).toThrow(/Invalid user/);
    // The layout allows characters nginx does not: they are caught here.
    expect(() => nginxConfig({ ...input, layout: new HostLayout({ root: "/var/lib/inci$base" }) })).toThrow(/Refusing/);
  });
});

describe("certificates", () => {
  test("must be a matching, current pair covering *.<domain>", () => {
    const good = makeCert("good");
    const other = makeCert("other");
    const pem = (p: string) => readFileSync(p, "utf8");
    const info = checkCertificate(pem(good.cert), pem(good.key), DOMAIN);
    expect(info.subjectAltName).toContain(`*.${DOMAIN}`);
    expect(() => checkCertificate(pem(good.cert), pem(other.key), DOMAIN)).toThrow(/does not belong/);
    expect(() => checkCertificate(pem(good.cert), pem(good.key), "incibase.other.net")).toThrow(/does not cover \*\.incibase\.other\.net/);
    expect(() => checkCertificate(pem(good.cert), pem(good.key), DOMAIN, Date.now() + 60 * 86_400_000)).toThrow(/expired/);
    expect(() => checkCertificate("hello", pem(good.key), DOMAIN)).toThrow(/not a PEM certificate/);
    expect(() => checkCertificate(pem(good.cert), "hello", DOMAIN)).toThrow(/not a PEM private key/);
    const single = makeCert("single", `DNS:prod--shop.${DOMAIN}`);
    expect(() => checkCertificate(pem(single.cert), pem(single.key), DOMAIN)).toThrow(/does not cover/);
  });
});

describe("the front door on a host", () => {
  test("host init with a certificate: copies it root-only, writes the config, adds www-data to the proxy group and starts nginx", async () => {
    const host = await nginxHost();
    const pair = makeCert("init");
    const result = await ops.initHost(host, { domain: DOMAIN, tlsCert: pair.cert, tlsKey: pair.key, httpsPort: 8443 });
    expect(result.frontDoor?.certificate?.subjectAltName).toContain(`*.${DOMAIN}`);
    const { cert, key } = settings(host);
    const tls = join(host.layout.root, "tls");
    expect(cert).toMatch(new RegExp(`^${tls}/[0-9a-f]{16}\\.crt$`));
    expect(host.sys.lstat(tls)).toMatchObject({ type: "dir", uid: 0, gid: 0, mode: 0o700 });
    expect(host.sys.lstat(key!)).toMatchObject({ type: "file", uid: 0, gid: 0, mode: 0o600 });
    expect(host.sys.lstat(cert!)).toMatchObject({ type: "file", uid: 0, mode: 0o644 });
    expect(readFileSync(key!, "utf8")).toBe(readFileSync(pair.key, "utf8"));

    const text = readFileSync(host.conf, "utf8");
    expect(text).toContain(`ssl_certificate ${cert};`);
    expect(text).toContain(`ssl_certificate_key ${key};`);
    expect(text).toContain("listen 8443 ssl http2;");
    expect(text).toContain(`set $ib ${host.layout.hosts}/$ib_label;`);
    expect(host.sys.lstat(host.conf)).toMatchObject({ uid: 0, gid: 0, mode: 0o644 });
    expect(host.sys.getgrnam(host.layout.groups.proxy)!.members).toEqual(["www-data"]);
    expect(readFileSync(join(host.layout.systemdDir, "nginx.service.d", "50-incibase.conf"), "utf8")).toBe(nginxDropIn(host.layout));
    // Tested alone (the harness), then with the rest of nginx's config, before nginx was told.
    expect(host.fake.tests.map((t) => (t.config.endsWith("harness.conf") ? "candidate" : "whole"))).toEqual(["candidate", "candidate", "whole"]);
    expect(host.fake.tests.every((t) => t.text.includes(`ssl_certificate ${cert};`))).toBe(true);
    expect(existsSync(join(host.layout.control, "nginx", "harness.conf"))).toBe(false);
    expect(nginxCalls(host)).toEqual(["daemon-reload", `start ${NGINX_SERVICE}`]);
    expect(host.registry.listAudit().filter((a) => a.action.startsWith("nginx.")).map((a) => [a.action, a.ok])).toEqual([
      ["nginx.set", 1],
      ["nginx.tls", 1],
      ["nginx.render", 1],
    ]);
    // No key material in the audit log.
    expect(JSON.stringify(host.registry.listAudit())).not.toContain("PRIVATE KEY");

    // Nothing changed: nothing written, nginx left alone.
    host.driver.calls.length = 0;
    const tests = host.fake.tests.length;
    const again = await ops.renderNginx(host);
    expect(again).toMatchObject({ changed: false, groupAdded: false, dropInChanged: false, action: null });
    expect(host.fake.tests.length).toBe(tests);
    expect(nginxCalls(host)).toEqual([]);
    // host render renders it too.
    const report = await ops.render(host);
    expect(report.nginx).toMatchObject({ changed: false, action: null });
  });

  test("the host's logs are www-data:adm 0640 before nginx first opens them, and repaired when they drift", async () => {
    const host = await nginxHost();
    const files = nginxFiles(host.layout, host.nginx);
    expect(files.errorLog).toBe(join(host.dir, "log", "incibase.error.log"));
    const seen: unknown[] = [];
    host.fake.reject = () => {
      seen.push([files.accessLog, files.errorLog].map((p) => host.sys.lstat(p)));
      return null;
    };
    const pair = makeCert("logs");
    await ops.initHost(host, { domain: DOMAIN, tlsCert: pair.cert, tlsKey: pair.key });
    const owner = { type: "file", uid: 33, gid: 4, mode: 0o640 };
    // Already so for the very first nginx -t (which would create them root 0644).
    expect(seen[0]).toEqual([expect.objectContaining(owner), expect.objectContaining(owner)]);
    for (const path of [files.accessLog, files.errorLog]) expect(host.sys.lstat(path)).toMatchObject(owner);
    const text = readFileSync(host.conf, "utf8");
    expect(text).toContain(`access_log ${files.accessLog} incibase_json;`);
    expect(text).toContain(`error_log ${files.errorLog} alert;`);

    // A log nginx made itself (root 0644) is repaired on the next render, its lines kept, nginx left alone.
    writeFileSync(files.accessLog, '{"status":200}\n');
    host.sys.chown(files.accessLog, 0, 0);
    host.sys.chmod(files.accessLog, 0o644);
    host.sys.chmod(files.errorLog, 0o604);
    host.driver.calls.length = 0;
    expect(await ops.renderNginx(host)).toMatchObject({ changed: false, action: null });
    for (const path of [files.accessLog, files.errorLog]) expect(host.sys.lstat(path)).toMatchObject(owner);
    expect(readFileSync(files.accessLog, "utf8")).toBe('{"status":200}\n');
    expect(nginxCalls(host)).toEqual([]);

    // Something else in its place is not followed.
    rmSync(files.errorLog);
    symlinkSync("/etc/shadow", files.errorLog);
    await expect(ops.renderNginx(host)).rejects.toMatchObject({ code: "FAILED", message: expect.stringMatching(/not a regular file/) });
    rmSync(files.errorLog);
    // Without the user nginx runs as there is no owner to give them.
    host.sys.users.delete("www-data");
    await expect(ops.renderNginx(host)).rejects.toMatchObject({ code: "FAILED", message: expect.stringMatching(/www-data nginx runs as does not exist/) });
  });

  test("a rotation installs the new pair, reloads nginx, then removes the old one", async () => {
    const host = await nginxHost();
    const first = makeCert("first");
    await ops.initHost(host, { domain: DOMAIN, tlsCert: first.cert, tlsKey: first.key });
    const before = settings(host);
    host.driver.calls.length = 0;
    const second = makeCert("second");
    const result = await ops.setTls(host, { cert: second.cert, key: second.key });
    const after = settings(host);
    expect(after.cert).not.toBe(before.cert);
    expect(readFileSync(host.conf, "utf8")).toContain(`ssl_certificate ${after.cert};`);
    expect(result.nginx).toMatchObject({ changed: true, action: "reload" });
    expect(nginxCalls(host)).toEqual([`reload ${NGINX_SERVICE}`]);
    expect(result.removed.sort()).toEqual([before.cert!, before.key!].map((p) => p.split("/").pop()!).sort());
    expect(readdirSync(join(host.layout.root, "tls")).sort()).toEqual([after.cert!, after.key!].map((p) => p.split("/").pop()!).sort());
    // The same pair again is no change.
    host.driver.calls.length = 0;
    expect((await ops.setTls(host, { cert: second.cert, key: second.key })).nginx).toMatchObject({ changed: false, action: null });
    expect(nginxCalls(host)).toEqual([]);
  });

  test("a drop-in that differs only in comments (one rendered before owner records) is rewritten without restarting nginx", async () => {
    const host = await nginxHost();
    const pair = makeCert("first");
    await ops.initHost(host, { domain: DOMAIN, tlsCert: pair.cert, tlsKey: pair.key });
    const dropIn = join(host.layout.systemdDir, "nginx.service.d", "50-incibase.conf");
    const rendered = readFileSync(dropIn, "utf8");
    const older = rendered.replace(`# host root: ${host.layout.root}\n`, "");
    expect(older).not.toBe(rendered);
    writeFileSync(dropIn, older);
    host.driver.calls.length = 0;
    expect(await ops.renderNginx(host)).toMatchObject({ changed: false, dropInChanged: true, action: null });
    expect(readFileSync(dropIn, "utf8")).toBe(rendered);
    expect(nginxCalls(host)).toEqual(["daemon-reload"]);
    // A changed setting does: OOMScoreAdjust applies when the master starts.
    writeFileSync(dropIn, rendered.replace("MemoryMin=64M", "MemoryMin=32M"));
    host.driver.calls.length = 0;
    expect(await ops.renderNginx(host)).toMatchObject({ dropInChanged: true, action: "restart" });
    expect(nginxCalls(host)).toEqual(["daemon-reload", `restart ${NGINX_SERVICE}`]);
  });

  test("a certificate nginx rejects changes nothing: old config, old pair, no reload; the refusal is audited", async () => {
    const host = await nginxHost();
    const first = makeCert("keep");
    await ops.initHost(host, { domain: DOMAIN, tlsCert: first.cert, tlsKey: first.key });
    const before = settings(host);
    const text = readFileSync(host.conf, "utf8");
    host.driver.calls.length = 0;
    host.fake.reject = (config) => (config.endsWith("harness.conf") ? 'nginx: [emerg] cannot load certificate: PEM_read_bio_X509_AUX() failed' : null);
    const next = makeCert("rejected");
    const err = await ops.setTls(host, { cert: next.cert, key: next.key }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(ops.OpError);
    expect(err.code).toBe("FAILED");
    expect(err.message).toMatch(/cannot load certificate/);
    expect(settings(host)).toEqual(before);
    expect(readFileSync(host.conf, "utf8")).toBe(text);
    expect(readdirSync(join(host.layout.root, "tls")).sort()).toEqual([before.cert!, before.key!].map((p) => p.split("/").pop()!).sort());
    expect(nginxCalls(host)).toEqual([]);
    expect(host.registry.listAudit().at(-1)).toMatchObject({ action: "nginx.tls", ok: 0 });
  });

  test("a config that fails with the rest of nginx's puts the previous file back and the registry with it", async () => {
    const host = await nginxHost();
    const pair = makeCert("whole");
    await ops.initHost(host, { domain: DOMAIN, tlsCert: pair.cert, tlsKey: pair.key });
    const text = readFileSync(host.conf, "utf8");
    host.driver.calls.length = 0;
    // Another site already has the default server on 80.
    host.fake.reject = (config, conf) => (!config.endsWith("harness.conf") && conf.includes("listen 80 ") ? 'nginx: [emerg] a duplicate default server for 0.0.0.0:80' : null);
    const err = await ops.setFrontDoor(host, { httpsPort: 80 }).then(() => null, (e) => e);
    expect(err?.code).toBe("FAILED");
    expect(err.message).toMatch(/previous file is back[\s\S]*duplicate default server/);
    expect(readFileSync(host.conf, "utf8")).toBe(text);
    expect(host.registry.getSetting("https_port")).toBeNull();
    expect(nginxCalls(host)).toEqual([]);
    // host render reports the failure and leaves nginx as it was.
    host.fake.reject = () => "nginx: [emerg] something else broke";
    writeFileSync(host.conf, "# edited by hand\n");
    const report = await ops.render(host);
    expect(report.nginx).toMatchObject({ error: expect.stringMatching(/something else broke/) });
    expect(readFileSync(host.conf, "utf8")).toBe("# edited by hand\n");
    expect(host.registry.listAudit().at(-1)).toMatchObject({ action: "host.render", ok: 0 });
  });

  test("trust_proxy and the port re-render; without a certificate nothing is rendered yet", async () => {
    const host = await nginxHost();
    const skipped = await ops.setFrontDoor(host, { trustProxy: "cloudflare" });
    expect(skipped.nginx.skipped).toMatch(/TLS certificate/);
    expect(existsSync(host.conf)).toBe(false);
    expect((await ops.render(host)).nginx).toMatchObject({ skipped: expect.stringMatching(/TLS/) });
    const pair = makeCert("cf");
    await ops.setTls(host, pair);
    expect(readFileSync(host.conf, "utf8")).toContain("real_ip_header CF-Connecting-IP;");
    host.driver.calls.length = 0;
    expect((await ops.setFrontDoor(host, { trustProxy: "none" })).nginx).toMatchObject({ changed: true, action: "reload" });
    expect(readFileSync(host.conf, "utf8")).not.toContain("real_ip_header");
  });

  test("inputs are checked first and bad ones are not audited", async () => {
    const host = await nginxHost();
    const pair = makeCert("inputs");
    const garbage = join(certs, "garbage.pem");
    writeFileSync(garbage, "not a certificate\n");
    const cases: [Promise<unknown>, string, RegExp][] = [
      [ops.setFrontDoor(host, { trustProxy: "everyone" as never }), "INVALID", /trustProxy/],
      [ops.setFrontDoor(host, { httpsPort: 70000 }), "INVALID", /httpsPort/],
      [ops.setFrontDoor(host, { extra: 1 } as never), "INVALID", /Unrecognized key/],
      [ops.setTls(host, { cert: pair.cert } as never), "INVALID", /key/],
      [ops.setTls(host, { cert: join(certs, "missing.crt"), key: pair.key }), "INVALID", /is not a file/],
      [ops.setTls(host, { cert: "relative.crt", key: pair.key }), "INVALID", /absolute path/],
      [ops.setTls(host, { cert: garbage, key: pair.key }), "INVALID", /not a PEM certificate/],
      [ops.setTls(host, { cert: pair.cert, key: makeCert("mismatch").key }), "INVALID", /does not belong/],
      [ops.initHost(host, { domain: DOMAIN, tlsCert: pair.cert }), "INVALID", /go together/],
    ];
    for (const [promise, code, message] of cases) {
      const err = await promise.then(() => null, (e) => e);
      expect(err).toBeInstanceOf(ops.OpError);
      expect(err.code).toBe(code);
      expect(err.message).toMatch(message);
    }
    expect(host.registry.listAudit().filter((a) => !a.ok)).toEqual([]);
    expect(settings(host)).toEqual({ cert: null, key: null });
    expect(existsSync(join(host.layout.root, "tls"))).toBe(false);
  });

  test("a host without nginx installed is told so", async () => {
    const host = await nginxHost();
    rmSync(host.layout.unitFile(NGINX_SERVICE));
    await ops.setFrontDoor(host, { httpsPort: 443 });
    await host.registry.withLock(() => host.registry.tx(() => {
      host.registry.setSetting("tls_cert", "/x/a.crt");
      host.registry.setSetting("tls_key", "/x/a.key");
    }));
    await expect(ops.renderNginx(host)).rejects.toMatchObject({ code: "FAILED", message: expect.stringMatching(/apt install nginx/) });
  });
});
