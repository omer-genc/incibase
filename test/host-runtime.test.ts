// Runtimes on a fake host: installs checked against SHA256SUMS (a local HTTP
// server stands in for GitHub), the CLI link, branch pins and gc.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// runtime.ts first: its import cycle with ops.ts must work from either side.
import { MAX_RUNTIME_BYTES, parseSums, releasesBase, RUNTIME_OWNER_FILE, runtimeAsset, STALE_STAGED_MS, type RuntimeContext } from "../src/host/runtime.ts";
import { sha256Hex } from "../src/engine/manifest.ts";
import { VERSION } from "../src/engine/version.ts";
import { HostLayout } from "../src/host/layout.ts";
import * as ops from "../src/host/ops.ts";
import { closeOpsHosts, fakeBundle, fakeOpsHost, type OpsTestHost } from "./host-helpers.ts";

const servers: { stop(force?: boolean): void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
  closeOpsHosts();
});

/** A runtime that answers `--version` with `says`; `pad` makes builds of one version differ. */
const script = (says: string, pad = "") => `#!/bin/sh\necho ${says}\n# ${pad}\n`;

function file(host: OpsTestHost, name: string, content: string): string {
  const path = join(host.dir, name);
  writeFileSync(path, content, { mode: 0o755 });
  return path;
}

const sumsLine = (content: string, name: string) => `${sha256Hex(content)}  ${name}\n`;

/** GitHub's release downloads: `v<version>/<asset>` from `files`; every request path is recorded. */
function releases(files: Record<string, string>) {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      requests.push(path);
      const body = files[path];
      return body === undefined ? new Response("Not Found", { status: 404 }) : new Response(body, { headers: { "content-type": "application/octet-stream" } });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, requests };
}

/** A host with the current runtime installed and no CLI link yet: these tests make and move it. */
async function hostWith(url?: string): Promise<OpsTestHost & RuntimeContext> {
  const host = (await fakeOpsHost({ cli: false })) as OpsTestHost & RuntimeContext;
  if (url) host.releasesUrl = url;
  return host;
}

const ASSET = runtimeAsset();

/** Nothing half-done left in the runtime root: no staged files, no empty version directories; it is this host's. */
function noLeftovers(host: OpsTestHost) {
  expect(readFileSync(join(host.layout.runtimeRoot, RUNTIME_OWNER_FILE), "utf8")).toBe(`${host.layout.root}\n`);
  for (const name of readdirSync(host.layout.runtimeRoot)) {
    if (name === RUNTIME_OWNER_FILE) continue;
    const entries = readdirSync(join(host.layout.runtimeRoot, name));
    expect({ name, entries }).toEqual({ name, entries: ["incibase"] });
  }
}

const installed = (host: OpsTestHost) => host.registry.listRuntimes().map((r) => r.version);
const failures = (host: OpsTestHost, action: string) => host.registry.listAudit().filter((a) => a.action === action && a.ok === 0);

describe("names", () => {
  test("the release asset for each architecture", () => {
    expect(runtimeAsset("x64")).toBe("incibase-linux-x64");
    expect(runtimeAsset("arm64")).toBe("incibase-linux-arm64");
    for (const arch of ["ia32", "arm", "riscv64", "toString", ""]) expect(() => runtimeAsset(arch)).toThrow(/No incibase runtime is published/);
    // The names scripts/build-binary.ts gives the release workflow's Linux targets.
    const workflow = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "release.yml"), "utf8");
    for (const arch of ["x64", "arm64"]) expect(workflow).toContain(`--target bun-linux-${arch}`);
  });

  test("the release workflow publishes SHA256SUMS next to the binaries", () => {
    const workflow = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "release.yml"), "utf8");
    expect(workflow).toContain("sha256sum incibase-* > SHA256SUMS");
    expect(workflow).toMatch(/gh release create "\$GITHUB_REF_NAME" dist\/incibase-\* dist\/SHA256SUMS /);
  });

  test("the releases URL is https, or http on loopback", () => {
    expect(releasesBase()).toBe("https://github.com/omer-genc/incibase/releases/download");
    expect(releasesBase("http://127.0.0.1:8080/x/")).toBe("http://127.0.0.1:8080/x");
    expect(releasesBase("http://localhost:1")).toBe("http://localhost:1");
    for (const bad of ["http://example.com/r", "ftp://127.0.0.1/", "https://u:p@example.com/", "https://example.com/?a=1", "not a url"]) {
      expect(() => releasesBase(bad)).toThrow();
    }
  });

  test("SHA256SUMS as sha256sum writes it", () => {
    const a = "a".repeat(64);
    const b = "B".repeat(64);
    const sums = parseSums(`${a}  incibase-linux-x64\n${b} *incibase-linux-arm64\r\n\n${a}  ./incibase-linux-x64\n`);
    expect([...sums]).toEqual([
      ["incibase-linux-x64", a],
      ["incibase-linux-arm64", "b".repeat(64)],
    ]);
    expect(() => parseSums(`${a}  x\n${b}  x\n`)).toThrow(/twice/);
    expect(() => parseSums(`${a} x\n`)).toThrow(/line 1/);
    expect(() => parseSums(`${a.slice(1)}  x\n`)).toThrow(/line 1/);
    expect(() => parseSums(`${a}  ../x\n`)).toThrow(/line 1/);
    expect(() => parseSums(`<html>Not Found</html>`)).toThrow(/line 1/);
  });

  test("parses what this machine's sha256 tool writes", async () => {
    const dir = (await fakeOpsHost()).dir;
    writeFileSync(join(dir, "incibase-linux-x64"), "binary bytes");
    const tool = Bun.which("sha256sum") ? ["sha256sum"] : ["shasum", "-a", "256"];
    const out = Bun.spawnSync([...tool, "incibase-linux-x64"], { cwd: dir }).stdout.toString();
    expect(parseSums(out).get("incibase-linux-x64")).toBe(sha256Hex("binary bytes"));
  });
});

describe("install from a release", () => {
  test("downloads the asset and SHA256SUMS, checks it, installs it root 0755", async () => {
    const bin = script("0.4.0");
    const gh = releases({ "/v0.4.0/SHA256SUMS": sumsLine(bin, ASSET) + sumsLine("other", "incibase-darwin-arm64"), [`/v0.4.0/${ASSET}`]: bin });
    const host = await hostWith(gh.url);
    const result = await ops.installRuntime(host, { version: "0.4.0" });
    const path = host.layout.runtimeBinary("0.4.0");
    expect(result).toEqual({ version: "0.4.0", path, sha256: sha256Hex(bin), installed: true, source: `${gh.url}/v0.4.0/${ASSET}` });
    // SHA256SUMS first: nothing is downloaded that could not be checked.
    expect(gh.requests).toEqual(["/v0.4.0/SHA256SUMS", `/v0.4.0/${ASSET}`]);
    expect(readFileSync(path, "utf8")).toBe(bin);
    expect(host.sys.lstat(path)).toMatchObject({ type: "file", uid: 0, gid: 0, mode: 0o755 });
    expect(host.sys.lstat(host.layout.runtimeDir("0.4.0"))).toMatchObject({ type: "dir", uid: 0, gid: 0, mode: 0o755 });
    expect(host.sys.lstat(host.layout.runtimeRoot)).toMatchObject({ uid: 0, gid: 0, mode: 0o755 });
    expect(host.registry.getRuntime("0.4.0")).toMatchObject({ sha256: sha256Hex(bin), bytes: bin.length, reported: "0.4.0", source: result.source });
    expect(host.registry.listAudit().at(-1)).toMatchObject({ action: "runtime.install", ok: 1 });
    noLeftovers(host);
  });

  test("a wrong checksum is refused and nothing is kept", async () => {
    const host = await hostWith();
    const ran = join(host.dir, "ran");
    const bin = `#!/bin/sh\ntouch ${ran}\necho 0.4.0\n`;
    const gh = releases({ "/v0.4.0/SHA256SUMS": sumsLine("the real one", ASSET), [`/v0.4.0/${ASSET}`]: bin });
    host.releasesUrl = gh.url;
    await expect(ops.installRuntime(host, { version: "0.4.0" })).rejects.toMatchObject({ code: "FAILED", message: expect.stringContaining(`has sha256 ${sha256Hex(bin)}`) });
    expect(installed(host)).toEqual([VERSION]);
    expect(host.sys.lstat(host.layout.runtimeDir("0.4.0"))).toBeNull();
    noLeftovers(host);
    expect(failures(host, "runtime.install")).toHaveLength(1);
    // Never run: an unverified binary is not even asked its version.
    expect(existsSync(ran)).toBe(false);
  });

  test("a SHA256SUMS without the asset is refused before the binary is downloaded", async () => {
    const bin = script("0.4.0");
    const gh = releases({ "/v0.4.0/SHA256SUMS": sumsLine(bin, "incibase-windows-x64.exe"), [`/v0.4.0/${ASSET}`]: bin });
    const host = await hostWith(gh.url);
    await expect(ops.installRuntime(host, { version: "0.4.0" })).rejects.toMatchObject({ code: "NOT_FOUND", message: expect.stringContaining(`no entry for ${ASSET}`) });
    expect(gh.requests).toEqual(["/v0.4.0/SHA256SUMS"]);
    expect(installed(host)).toEqual([VERSION]);
    noLeftovers(host);
  });

  test("a release without SHA256SUMS, or without the binary (404)", async () => {
    const bin = script("0.4.0");
    const gh = releases({ [`/v0.4.0/${ASSET}`]: bin, "/v0.5.0/SHA256SUMS": sumsLine(bin, ASSET) });
    const host = await hostWith(gh.url);
    await expect(ops.installRuntime(host, { version: "0.4.0" })).rejects.toMatchObject({ code: "NOT_FOUND", message: expect.stringContaining("/v0.4.0/SHA256SUMS does not exist (404)") });
    expect(gh.requests).toEqual(["/v0.4.0/SHA256SUMS"]);
    await expect(ops.installRuntime(host, { version: "0.5.0" })).rejects.toMatchObject({ code: "NOT_FOUND", message: expect.stringContaining(`/v0.5.0/${ASSET} does not exist (404)`) });
    await expect(ops.installRuntime(host, { version: "9.9.9" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(installed(host)).toEqual([VERSION]);
    noLeftovers(host);
  });

  test("a download that breaks off is refused and its partial file removed", async () => {
    const bin = script("0.4.0", "x".repeat(4000));
    const sums = sumsLine(bin, ASSET);
    // A raw server: SHA256SUMS whole, the binary cut off after 1000 of its bytes.
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket, data) {
          const path = /^GET (\S+)/.exec(data.toString())?.[1] ?? "";
          const body = path.endsWith("/SHA256SUMS") ? sums : bin.slice(0, 1000);
          const length = path.endsWith("/SHA256SUMS") ? sums.length : bin.length;
          socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${length}\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n\r\n${body}`);
          socket.end();
        },
      },
    });
    servers.push(server);
    const host = await hostWith(`http://127.0.0.1:${server.port}`);
    await expect(ops.installRuntime(host, { version: "0.4.0" })).rejects.toMatchObject({ code: "FAILED", message: expect.stringMatching(/broke off|ended after 1000 of/) });
    expect(installed(host)).toEqual([VERSION]);
    expect(host.sys.lstat(host.layout.runtimeDir("0.4.0"))).toBeNull();
    noLeftovers(host);
  });

  test("a binary larger than a runtime can be is refused from its Content-Length", async () => {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket, data) {
          const sums = /SHA256SUMS/.test(data.toString());
          const body = sums ? sumsLine("x", ASSET) : "";
          socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${sums ? body.length : MAX_RUNTIME_BYTES + 1}\r\nConnection: close\r\n\r\n${body}`);
          // The binary's connection stays open: the refusal comes from the header, not from the body.
          if (sums) socket.end();
        },
      },
    });
    servers.push(server);
    const host = await hostWith(`http://127.0.0.1:${server.port}`);
    await expect(ops.installRuntime(host, { version: "0.4.0" })).rejects.toThrow(/more than the \d+ a runtime may be/);
    noLeftovers(host);
  });

  test("a binary that is not the version it was published as is refused", async () => {
    const bin = script("0.3.9");
    const gh = releases({ "/v0.4.0/SHA256SUMS": sumsLine(bin, ASSET), [`/v0.4.0/${ASSET}`]: bin });
    const host = await hostWith(gh.url);
    await expect(ops.installRuntime(host, { version: "0.4.0" })).rejects.toThrow(/says it is "0.3.9", not 0.4.0/);
    expect(installed(host)).toEqual([VERSION]);
    noLeftovers(host);
  });

  test("every redirect hop is checked, not only the last one", async () => {
    const bin = script("0.4.0");
    const sums = sumsLine(bin, ASSET);
    const requests: string[] = [];
    // On every interface, so that 0.0.0.0 (not loopback) reaches it too.
    const server = Bun.serve({
      hostname: "0.0.0.0",
      port: 0,
      fetch(req): Response {
        const url = new URL(req.url);
        requests.push(`${url.hostname} ${url.pathname}`);
        const [, kind, name] = url.pathname.split("/") as [string, string, string];
        const to = (where: string) => new Response(null, { status: 302, headers: { location: where } });
        // https -> http://<anywhere> -> https://<attacker>, with loopback standing in for https.
        if (kind === "v0.4.0") return to(`http://0.0.0.0:${server.port}/hop/${name}`);
        if (kind === "hop") return to(`http://127.0.0.1:${server.port}/real/${name}`);
        if (kind === "real") return new Response(name === "SHA256SUMS" ? sums : bin);
        if (kind === "v0.6.0") return to(`/v0.6.0/${name}`); // forever
        if (kind === "v0.7.0") return new Response(null, { status: 302 }); // no Location
        return new Response("Not Found", { status: 404 });
      },
    });
    servers.push(server);
    const host = await hostWith(`http://127.0.0.1:${server.port}`);
    await expect(ops.installRuntime(host, { version: "0.4.0" })).rejects.toMatchObject({ code: "FAILED", message: expect.stringContaining(`redirected to http://0.0.0.0:${server.port}, which is not https`) });
    // Refused at the hop itself: nothing was asked of 0.0.0.0.
    expect(requests).toEqual(["127.0.0.1 /v0.4.0/SHA256SUMS"]);
    await expect(ops.installRuntime(host, { version: "0.6.0" })).rejects.toThrow(/redirected more than 5 times/);
    await expect(ops.installRuntime(host, { version: "0.7.0" })).rejects.toMatchObject({ code: "FAILED", message: expect.stringContaining("answered 302 without a Location") });
    expect(installed(host)).toEqual([VERSION]);

    // Loopback all the way (http only because the download started on loopback): followed.
    const bin5 = script("0.5.0");
    const sums5 = sumsLine(bin5, ASSET);
    const gh = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req): Response {
        const path = new URL(req.url).pathname;
        if (path.startsWith("/v0.5.0/")) return new Response(null, { status: 302, headers: { location: `/store${path}` } });
        if (path.startsWith("/store/")) return new Response(null, { status: 307, headers: { location: `http://localhost:${gh.port}/final${path}` } });
        return new Response(path.endsWith("SHA256SUMS") ? sums5 : bin5);
      },
    });
    servers.push(gh);
    host.releasesUrl = `http://127.0.0.1:${gh.port}`;
    expect(await ops.installRuntime(host, { version: "0.5.0" })).toMatchObject({ installed: true, sha256: sha256Hex(bin5) });
    noLeftovers(host);
  });

  test("again: no download, nothing changes", async () => {
    const bin = script("0.4.0");
    const gh = releases({ "/v0.4.0/SHA256SUMS": sumsLine(bin, ASSET), [`/v0.4.0/${ASSET}`]: bin });
    const host = await hostWith(gh.url);
    await ops.installRuntime(host, { version: "0.4.0" });
    const before = statSync(host.layout.runtimeBinary("0.4.0"));
    const changes = host.sys.changeCount;
    expect(await ops.installRuntime(host, { version: "0.4.0" })).toMatchObject({ installed: false, sha256: sha256Hex(bin) });
    expect(gh.requests).toHaveLength(2);
    expect(host.sys.changeCount).toBe(changes);
    expect(statSync(host.layout.runtimeBinary("0.4.0")).ino).toBe(before.ino);
    expect(host.registry.listAudit().at(-1)).toMatchObject({ action: "runtime.install", ok: 1, detail_json: expect.stringContaining('"unchanged":true') });
  });
});

describe("install from a local file", () => {
  test("with SHA256SUMS: the entry for its file name must match", async () => {
    const host = await hostWith();
    const bin = file(host, "incibase-linux-x64", script("0.4.0"));
    const sums = file(host, "SHA256SUMS", sumsLine(script("0.4.0"), "incibase-linux-x64") + sumsLine("other", "incibase-linux-arm64"));
    expect(await ops.installRuntime(host, { version: "0.4.0", binary: bin, sums })).toMatchObject({ installed: true, source: `file:${bin}` });
    expect(readFileSync(host.layout.runtimeBinary("0.4.0"), "utf8")).toBe(script("0.4.0"));

    const other = file(host, "incibase-0.5.0", script("0.5.0"));
    await expect(ops.installRuntime(host, { version: "0.5.0", binary: other, sums })).rejects.toMatchObject({ code: "NOT_FOUND", message: expect.stringContaining("no entry for incibase-0.5.0") });
    const wrong = file(host, "SHA256SUMS.wrong", sumsLine("not it", "incibase-0.5.0"));
    await expect(ops.installRuntime(host, { version: "0.5.0", binary: other, sums: wrong })).rejects.toMatchObject({ code: "FAILED" });
    expect(installed(host)).toEqual([VERSION, "0.4.0"]);
    noLeftovers(host);
  });

  test("with an explicit sha256", async () => {
    const host = await hostWith();
    const bin = file(host, "incibase", script("0.4.0"));
    await expect(ops.installRuntime(host, { version: "0.4.0", binary: bin, sha256: sha256Hex("something else") })).rejects.toMatchObject({ code: "FAILED" });
    expect(host.sys.lstat(host.layout.runtimeDir("0.4.0"))).toBeNull();
    expect(await ops.installRuntime(host, { version: "0.4.0", binary: bin, sha256: sha256Hex(script("0.4.0")).toUpperCase() })).toMatchObject({ installed: true });
    noLeftovers(host);
  });

  test("needs exactly one checksum, absolute paths and a valid version", async () => {
    const host = await hostWith();
    const bin = file(host, "incibase", script("0.4.0"));
    const sums = file(host, "SHA256SUMS", sumsLine(script("0.4.0"), "incibase"));
    const sha256 = sha256Hex(script("0.4.0"));
    for (const input of [
      { version: "0.4.0", binary: bin },
      { version: "0.4.0", binary: bin, sha256, sums },
      { version: "0.4.0", sums },
      { version: "0.4.0", sha256 },
      { version: "0.4.0", binary: "incibase", sha256 },
      { version: "0.4.0", binary: bin, sha256: "abc" },
      { version: "../0.4.0", binary: bin, sha256 },
      { version: "0.4.0", binary: bin, sha256, extra: 1 },
    ]) {
      await expect(ops.installRuntime(host, input as never)).rejects.toMatchObject({ code: "INVALID" });
    }
    await expect(ops.installRuntime(host, { version: "0.4.0", binary: join(host.dir, "missing"), sha256 })).rejects.toMatchObject({ code: "INVALID" });
    expect(installed(host)).toEqual([VERSION]);
  });

  test("never other bytes under an installed version; a damaged file is put back", async () => {
    const host = await hostWith();
    const bin = file(host, "a", script("0.4.0"));
    await ops.installRuntime(host, { version: "0.4.0", binary: bin, sha256: sha256Hex(script("0.4.0")) });
    const rebuilt = file(host, "b", script("0.4.0", "rebuilt"));
    await expect(ops.installRuntime(host, { version: "0.4.0", binary: rebuilt, sha256: sha256Hex(script("0.4.0", "rebuilt")) })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(readFileSync(host.layout.runtimeBinary("0.4.0"), "utf8")).toBe(script("0.4.0"));
    // Damaged on disk: the recorded bytes go back, other ones still do not.
    writeFileSync(host.layout.runtimeBinary("0.4.0"), "garbage");
    await expect(ops.installRuntime(host, { version: "0.4.0", binary: rebuilt, sha256: sha256Hex(script("0.4.0", "rebuilt")) })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await ops.installRuntime(host, { version: "0.4.0", binary: bin, sha256: sha256Hex(script("0.4.0")) })).toMatchObject({ installed: true });
    expect(readFileSync(host.layout.runtimeBinary("0.4.0"), "utf8")).toBe(script("0.4.0"));
  });

  test("a runtime on disk without a record is never replaced by other bytes, and is recorded given its own", async () => {
    const host = await hostWith();
    const path = host.layout.runtimeBinary("5.0.0");
    mkdirSync(host.layout.runtimeDir("5.0.0"));
    // Copied there by hand, or installed before runtimes were recorded.
    writeFileSync(path, script("5.0.0", "A"), { mode: 0o755 });
    const other = file(host, "b", script("5.0.0", "B"));
    await expect(ops.installRuntime(host, { version: "5.0.0", binary: other, sha256: sha256Hex(script("5.0.0", "B")) })).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining(`unrecorded, with sha256 ${sha256Hex(script("5.0.0", "A"))}`),
    });
    expect(readFileSync(path, "utf8")).toBe(script("5.0.0", "A"));
    expect(host.registry.getRuntime("5.0.0")).toBeNull();
    // Nor from a release: refused before the binary is downloaded.
    const gh = releases({ "/v5.0.0/SHA256SUMS": sumsLine(script("5.0.0", "B"), ASSET), [`/v5.0.0/${ASSET}`]: script("5.0.0", "B") });
    host.releasesUrl = gh.url;
    await expect(ops.installRuntime(host, { version: "5.0.0" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(gh.requests).toEqual(["/v5.0.0/SHA256SUMS"]);
    expect(readFileSync(path, "utf8")).toBe(script("5.0.0", "A"));
    // gc leaves it alone, and says so.
    expect(await ops.gcRuntimes(host)).toMatchObject({ removed: [VERSION], unrecorded: ["5.0.0"], swept: [] });
    expect(readFileSync(path, "utf8")).toBe(script("5.0.0", "A"));

    // Its own bytes: recorded (and put back root 0755).
    const same = file(host, "a", script("5.0.0", "A"));
    expect(await ops.installRuntime(host, { version: "5.0.0", binary: same, sha256: sha256Hex(script("5.0.0", "A")) })).toMatchObject({ installed: true });
    expect(host.registry.getRuntime("5.0.0")).toMatchObject({ sha256: sha256Hex(script("5.0.0", "A")) });
    expect(host.sys.lstat(path)).toMatchObject({ type: "file", uid: 0, mode: 0o755 });
    expect((await ops.gcRuntimes(host, { dryRun: true })).unrecorded).toEqual([]);
    noLeftovers(host);

    // Something else than a file there is not a runtime either.
    mkdirSync(host.layout.runtimeBinary("5.1.0"), { recursive: true });
    const bin = file(host, "c", script("5.1.0"));
    await expect(ops.installRuntime(host, { version: "5.1.0", binary: bin, sha256: sha256Hex(script("5.1.0")) })).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("(a dir)"),
    });
  });

  test("atomic: the binary appears by one rename, after its checks", async () => {
    const host = await hostWith();
    const bin = file(host, "incibase", script("0.4.0"));
    const from = host.sys.log.length;
    await ops.installRuntime(host, { version: "0.4.0", binary: bin, sha256: sha256Hex(script("0.4.0")) });
    const path = host.layout.runtimeBinary("0.4.0");
    const touching = host.sys.log.slice(from).filter((l) => l.includes(path));
    expect(touching).toHaveLength(1);
    expect(touching[0]).toMatch(new RegExp(`^rename ${host.layout.runtimeDir("0.4.0")}/\\.incibase-[0-9a-f]{16}\\.partial ${path}$`));
    const staged = touching[0]!.split(" ")[1]!;
    const log = host.sys.log.slice(from);
    // Copied root-only, made 0755 only after the checksum matched.
    expect(log.indexOf(`copy ${bin} ${staged}`)).toBeLessThan(log.indexOf(`chmod ${staged} 755`));

    // A crash just before the rename: nothing installed, nothing recorded; a later install succeeds.
    const crashed = await hostWith();
    const bin2 = file(crashed, "incibase", script("0.4.0"));
    crashed.sys.crashAt = crashed.sys.changeCount + log.indexOf(touching[0]!); // the same changes as above, up to the rename
    await expect(ops.installRuntime(crashed, { version: "0.4.0", binary: bin2, sha256: sha256Hex(script("0.4.0")) })).rejects.toThrow(/simulated crash before rename/);
    crashed.sys.crashAt = null;
    expect(crashed.sys.lstat(crashed.layout.runtimeBinary("0.4.0"))).toBeNull();
    expect(crashed.registry.getRuntime("0.4.0")).toBeNull();
    expect(await ops.installRuntime(crashed, { version: "0.4.0", binary: bin2, sha256: sha256Hex(script("0.4.0")) })).toMatchObject({ installed: true });
    noLeftovers(crashed);
  });

  test("skipVersionCheck installs one build under another version string, and records what it said", async () => {
    const host = await hostWith();
    const bin = file(host, "incibase", script(VERSION));
    const sha256 = sha256Hex(script(VERSION));
    await expect(ops.installRuntime(host, { version: "0.9.0-test", binary: bin, sha256 })).rejects.toThrow(/says it is/);
    expect(await ops.installRuntime(host, { version: "0.9.0-test", binary: bin, sha256, skipVersionCheck: true })).toMatchObject({ installed: true });
    expect(host.registry.getRuntime("0.9.0-test")).toMatchObject({ reported: VERSION });
    // It must still run.
    const broken = file(host, "broken", "#!/bin/sh\nexit 3\n");
    await expect(ops.installRuntime(host, { version: "0.9.1", binary: broken, sha256: sha256Hex("#!/bin/sh\nexit 3\n"), skipVersionCheck: true })).rejects.toThrow(/says it is/);
    noLeftovers(host);
  });
});

/** Installs a fake runtime `version` from a local file. */
async function withRuntime(host: OpsTestHost, version: string) {
  const bin = file(host, `incibase-${version}`, script(version));
  await ops.installRuntime(host, { version, binary: bin, sha256: sha256Hex(script(version)) });
}

describe("the CLI link", () => {
  test("points at an installed runtime, atomically, and refuses what is not a link", async () => {
    const host = await hostWith();
    const link = host.layout.cliLink;
    await expect(ops.useCli(host, { version: "0.4.0" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await withRuntime(host, "0.4.0");
    expect(await ops.useCli(host, { version: "0.4.0" })).toMatchObject({ version: "0.4.0", link, target: host.layout.runtimeBinary("0.4.0"), previous: null });
    expect(host.sys.readlink(link)).toBe(host.layout.runtimeBinary("0.4.0"));
    expect(Bun.spawnSync([link, "--version"]).stdout.toString().trim()).toBe("0.4.0");
    expect(host.registry.getSetting("cli_version")).toBe("0.4.0");
    expect((await ops.listRuntimes(host)).cli).toBe("0.4.0");
    expect(await ops.useCli(host, { version: VERSION })).toMatchObject({ previous: host.layout.runtimeBinary("0.4.0") });
    expect((await ops.listRuntimes(host)).cli).toBe(VERSION);

    host.sys.remove(link);
    writeFileSync(link, "a binary copied here by hand");
    await expect(ops.useCli(host, { version: "0.4.0" })).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("pass replace") });
    expect(readFileSync(link, "utf8")).toBe("a binary copied here by hand");
    await ops.useCli(host, { version: "0.4.0", replace: true });
    expect(host.sys.readlink(link)).toBe(host.layout.runtimeBinary("0.4.0"));

    host.sys.remove(link);
    mkdirSync(link);
    await expect(ops.useCli(host, { version: "0.4.0", replace: true })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(ops.useCli(host, { version: "0.4.0; rm" })).rejects.toMatchObject({ code: "INVALID" });
  });

  test("the layout keeps it, and a default one is not saved", () => {
    expect(new HostLayout({ root: "/var/lib/x" }).cliLink).toBe("/usr/local/bin/incibase");
    expect(new HostLayout({ root: "/var/lib/x" }).saved()).not.toHaveProperty("cliLink");
    expect(new HostLayout({ root: "/var/lib/x", cliLink: "/opt/bin/incibase" }).saved()).toMatchObject({ cliLink: "/opt/bin/incibase" });
    expect(() => new HostLayout({ root: "/var/lib/x", cliLink: "bin/incibase" })).toThrow(/absolute/);
  });
});

describe("branch pins and gc", () => {
  async function shop() {
    const host = await hostWith();
    await ops.createProject(host, { slug: "shop", branches: ["prod", "dev"] });
    for (const b of ["prod", "dev"]) await ops.addRelease(host, { project: "shop", branch: b, file: fakeBundle(host.dir, `v1-${b}`) });
    return host;
  }
  const pin = (host: OpsTestHost, name: string) => host.registry.findBranch("shop", name)!.runtime_version;

  test("pins only installed runtimes", async () => {
    const host = await shop();
    await expect(ops.upgradeBranch(host, { project: "shop", branch: "dev", runtimeVersion: "0.4.0" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(ops.createBranch(host, { project: "shop", name: "preview", runtimeVersion: "0.4.0" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Recorded but its file gone is not installed either.
    await withRuntime(host, "0.4.0");
    host.sys.remove(host.layout.runtimeBinary("0.4.0"));
    await expect(ops.upgradeBranch(host, { project: "shop", branch: "dev", runtimeVersion: "0.4.0" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(pin(host, "dev")).toBe(VERSION);
  });

  test("gc removes the runtimes no branch pins, never the CLI's, and the pins move through the gate", async () => {
    const host = await shop();
    for (const v of ["0.4.0", "0.5.0", "0.6.0"]) await withRuntime(host, v);
    await ops.useCli(host, { version: "0.5.0" });
    expect(await ops.upgradeBranch(host, { project: "shop", branch: "dev", runtimeVersion: "0.4.0" })).toMatchObject({ ok: true });
    expect(pin(host, "dev")).toBe("0.4.0");
    expect(readFileSync(host.layout.dropIn(host.layout.units.branch(host.registry.findBranch("shop", "dev")!.id)), "utf8")).toContain(
      `${host.layout.runtimeRoot}/0.4.0/incibase serve`,
    );

    const listed = await ops.listRuntimes(host);
    expect(listed.runtimes.map((r) => [r.version, r.pinnedBy, r.cli, r.present])).toEqual([
      [VERSION, ["shop/prod"], false, true],
      ["0.4.0", ["shop/dev"], false, true],
      ["0.5.0", [], true, true],
      ["0.6.0", [], false, true],
    ]);

    expect(await ops.gcRuntimes(host, { dryRun: true })).toMatchObject({ removed: ["0.6.0"], dryRun: true });
    expect(installed(host)).toContain("0.6.0");
    const result = await ops.gcRuntimes(host);
    expect(result.removed).toEqual(["0.6.0"]);
    expect(result.kept).toEqual([
      { version: VERSION, by: ["shop/prod"] },
      { version: "0.4.0", by: ["shop/dev"] },
      { version: "0.5.0", by: [host.layout.cliLink] },
    ]);
    expect(host.sys.lstat(host.layout.runtimeDir("0.6.0"))).toBeNull();
    expect(installed(host)).toEqual([VERSION, "0.4.0", "0.5.0"]);
    expect(host.registry.listAudit().at(-1)).toMatchObject({ action: "runtime.gc", ok: 1 });
    await expect(ops.upgradeBranch(host, { project: "shop", branch: "dev", runtimeVersion: "0.6.0" })).rejects.toMatchObject({ code: "NOT_FOUND" });

    // A failed upgrade reverts the pin, so gc keeps what the branch still runs.
    host.driver.behavior = (run) => (run.runtime === "0.5.0" && run.kind === "branch" ? { exit: 64 } : {});
    expect(await ops.upgradeBranch(host, { project: "shop", branch: "prod", runtimeVersion: "0.5.0" })).toMatchObject({ ok: false });
    expect(pin(host, "prod")).toBe(VERSION);
    host.driver.behavior = () => ({});
    expect(await ops.upgradeBranch(host, { project: "shop", branch: "prod", runtimeVersion: "0.4.0" })).toMatchObject({ ok: true });
    await ops.useCli(host, { version: "0.4.0" });
    // `host gc`: trash, then the runtimes.
    expect(await ops.gc(host)).toMatchObject({ trash: [], runtimes: { removed: [VERSION, "0.5.0"] } });
    expect(installed(host)).toEqual(["0.4.0"]);
    noLeftovers(host);
  });

  test("keeps everything while a branch is being upgraded, and the runtime this process runs from", async () => {
    const host = await shop();
    await withRuntime(host, "0.4.0");
    await withRuntime(host, "0.5.0");
    const dev = host.registry.findBranch("shop", "dev")!;
    await host.registry.withLock(() => host.registry.claimBusy(dev.id, host.layout.units.job("upgrade", dev.id, 1), 1));
    expect(await ops.gcRuntimes(host)).toMatchObject({ removed: [], skipped: "upgrading shop/dev" });
    expect(installed(host)).toEqual([VERSION, "0.4.0", "0.5.0"]);
    await host.registry.withLock(() => host.registry.releaseBusy(dev.id, host.layout.units.job("upgrade", dev.id, 1), 2));

    host.self = [host.layout.runtimeBinary("0.5.0"), "host"];
    const result = await ops.gcRuntimes(host);
    expect(result.removed).toEqual(["0.4.0"]);
    expect(result.kept).toContainEqual({ version: "0.5.0", by: ["this process"] });
  });

  test("a deleted branch's pin no longer counts", async () => {
    const host = await shop();
    await withRuntime(host, "0.4.0");
    await ops.createBranch(host, { project: "shop", name: "preview", runtimeVersion: "0.4.0" });
    expect((await ops.gcRuntimes(host)).removed).toEqual([]);
    await ops.deleteBranch(host, { project: "shop", branch: "preview" });
    expect((await ops.gcRuntimes(host)).removed).toEqual(["0.4.0"]);
  });
});

describe("what killed installs leave", () => {
  /** A file an install staged and never finished (killed midway), last touched `ageMs` ago. */
  function staged(host: OpsTestHost, version: string, ageMs: number, hex = "d2427740a93ce360"): string {
    const dir = host.layout.runtimeDir(version);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `.incibase-${hex}.partial`);
    writeFileSync(path, "1 MiB of a binary that never finished", { mode: 0o700 });
    const at = new Date(Date.now() - ageMs);
    utimesSync(path, at, at);
    utimesSync(dir, at, at);
    return path;
  }
  const OLD = STALE_STAGED_MS + 60_000;

  test("an install of the version sweeps its stale staged files, never one still in progress", async () => {
    const host = await hostWith();
    const stale = staged(host, "0.3.2-st", OLD);
    const tmp = join(host.layout.runtimeDir("0.3.2-st"), "..incibase-00000000000000aa.partial.tmp"); // a copy killed midway
    writeFileSync(tmp, "half a copy");
    utimesSync(tmp, new Date(Date.now() - OLD), new Date(Date.now() - OLD));
    const fresh = staged(host, "0.3.2-st", 60_000, "00000000000000ff"); // another install, still downloading
    const bin = file(host, "incibase", script("0.3.2-st"));
    expect(await ops.installRuntime(host, { version: "0.3.2-st", binary: bin, sha256: sha256Hex(script("0.3.2-st")) })).toMatchObject({ installed: true });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(tmp)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(readdirSync(host.layout.runtimeDir("0.3.2-st")).sort()).toEqual([".incibase-00000000000000ff.partial", "incibase"]);
  });

  test("gc sweeps stale staged files, and version directories without a record that held only those", async () => {
    const host = await hostWith();
    await withRuntime(host, "0.4.0");
    await ops.useCli(host, { version: "0.4.0" });
    const inInstalled = staged(host, "0.4.0", OLD);
    const orphan = staged(host, "0.3.2-st", OLD);
    const busy = staged(host, "0.3.3", 60_000);
    mkdirSync(host.layout.runtimeDir("0.3.4")); // made a moment ago by an install that has not staged yet
    const idleEmpty = host.layout.runtimeDir("0.3.5");
    mkdirSync(idleEmpty);
    utimesSync(idleEmpty, new Date(Date.now() - OLD), new Date(Date.now() - OLD));
    const notOurs = join(host.layout.runtimeRoot, "notes");
    mkdirSync(notOurs);
    writeFileSync(join(notOurs, ".incibase-d2427740a93ce360.partial"), "not in a version directory");

    const dry = await ops.gcRuntimes(host, { dryRun: true });
    expect(dry).toMatchObject({ removed: [VERSION], swept: [], unrecorded: [] });
    expect(existsSync(orphan)).toBe(true);

    const result = await ops.gcRuntimes(host);
    expect(result.removed).toEqual([VERSION]);
    expect([...result.swept].sort()).toEqual([inInstalled, orphan, host.layout.runtimeDir("0.3.2-st"), idleEmpty].sort());
    for (const gone of [inInstalled, host.layout.runtimeDir("0.3.2-st"), idleEmpty]) expect(existsSync(gone)).toBe(false);
    for (const kept of [busy, host.layout.runtimeDir("0.3.4"), join(notOurs, ".incibase-d2427740a93ce360.partial"), host.layout.runtimeBinary("0.4.0")]) {
      expect(existsSync(kept)).toBe(true);
    }
    expect(JSON.parse(host.registry.listAudit().at(-1)!.detail_json!)).toMatchObject({ swept: result.swept });
    // Nothing left to sweep.
    expect((await ops.gcRuntimes(host)).swept).toEqual([]);
  });
});

describe("the runtime root is one host's", () => {
  test("installs claim it; installs and gc refuse one another host claimed", async () => {
    const host = await hostWith();
    const marker = join(host.layout.runtimeRoot, RUNTIME_OWNER_FILE);
    expect(readFileSync(marker, "utf8")).toBe(`${host.layout.root}\n`);
    await withRuntime(host, "0.4.0");

    // Another host's registry records these runtimes: this one's pins say nothing about its branches.
    writeFileSync(marker, "/var/lib/incibase-other\n");
    const gh = releases({});
    host.releasesUrl = gh.url;
    const local = file(host, "b", script("0.5.0"));
    for (const attempt of [
      () => ops.installRuntime(host, { version: "0.5.0" }),
      () => ops.installRuntime(host, { version: "0.5.0", binary: local, sha256: sha256Hex(script("0.5.0")) }),
      () => ops.gcRuntimes(host),
      () => ops.gc(host),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("/var/lib/incibase-other") });
    }
    expect(gh.requests).toEqual([]);
    expect(installed(host)).toEqual([VERSION, "0.4.0"]);
    expect(existsSync(host.layout.runtimeBinary("0.4.0"))).toBe(true);
    expect(existsSync(host.layout.runtimeDir("0.5.0"))).toBe(false);

    host.sys.remove(marker);
    mkdirSync(marker);
    await expect(ops.gcRuntimes(host)).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("(a dir)") });

    // That host is gone: with the marker removed, the next install claims the root again.
    host.sys.remove(marker);
    expect((await ops.gcRuntimes(host)).removed).toEqual([VERSION, "0.4.0"]);
    expect(existsSync(marker)).toBe(false);
    await withRuntime(host, "0.5.0");
    noLeftovers(host);
  });
});

describe("the CLI", () => {
  const cli = (...args: string[]) => Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "host", ...args], { stdout: "pipe", stderr: "pipe" });

  test("help and bad flags", () => {
    const help = cli("install-runtime", "--help");
    expect(help.exitCode).toBe(0);
    expect(help.stdout.toString()).toContain("--sums <SHA256SUMS>");
    expect(cli("--help").stdout.toString()).toContain("incibase host use-cli <version>");
    // A usage error exits 2, as every host command does (step 12).
    const bad = cli("gc", "--bogus");
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr.toString()).toContain("--bogus");
  });
});
