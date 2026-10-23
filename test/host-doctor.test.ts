// `host doctor` on a fake host: the machine (commands, /sys, the journal,
// sshd, the sandbox probe) comes from hooks, so every verdict is checked
// here; test/host-check-linux.test.ts runs it on the real thing.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { formatDoctor, readProbe, runDoctor, type CommandResult, type DoctorContext, type DoctorHooks, type SandboxProbe } from "../src/host/doctor.ts";
import type { FileInfo } from "../src/host/system.ts";
import * as ops from "../src/host/ops.ts";
import { closeOpsHosts, fakeBundle, fakeOpsHost, type OpsTestHost } from "./host-helpers.ts";

afterEach(closeOpsHosts);

const dir: FileInfo = { type: "dir", uid: 0, gid: 0, mode: 0o755, size: 0, mtimeMs: 0 };
const file: FileInfo = { ...dir, type: "file", mode: 0o644 };
const ok = (stdout: string): CommandResult => ({ exitCode: 0, stdout, stderr: "" });

const effective = (all = true): SandboxProbe => ({
  ran: true,
  directives: {
    SocketBindDeny: { effective: all, detail: "listening on 0.0.0.0: error EPERM" },
    ProtectProc: { effective: all, detail: "root's /proc/1 is hidden" },
    IPAddressDeny: { effective: true, detail: "connecting to 127.0.0.1: timeout" },
    ProtectSystem: { effective: true, detail: "writing /var/tmp: error EROFS" },
  },
});

/** A healthy Ubuntu 24.04 VM, as the hooks show it; `patch` changes what one command says. */
function machine(patch: Record<string, CommandResult | null> = {}, rest: Partial<DoctorHooks> = {}): Partial<DoctorHooks> {
  const commands: Record<string, CommandResult | null> = {
    "systemctl --version": ok("systemd 255 (255.4-1ubuntu8)\n+PAM +AUDIT\n"),
    "systemd-detect-virt --container": { exitCode: 1, stdout: "none\n", stderr: "" },
    "nginx -t": { exitCode: 0, stdout: "", stderr: "nginx: configuration file /etc/nginx/nginx.conf test is successful\n" },
    "sshd -T": ok("port 22\nallowstreamlocalforwarding yes\ndisableforwarding no\n"),
    "timedatectl show --property=Timezone --property=NTPSynchronized": ok("Timezone=Europe/Istanbul\nNTPSynchronized=yes\n"),
    ...patch,
  };
  return {
    command: (argv) => {
      const key = argv.join(" ");
      if (!(key in commands)) throw new Error(`unexpected command ${key}`);
      return commands[key]!;
    },
    file: (path) => (path === "/sys/fs/cgroup/cgroup.controllers" ? file : path === "/var/log/journal" ? dir : null),
    readText: () => null,
    diskUsage: () => ({ usedPercent: 30, availableBytes: 70 * 1024 ** 3 }),
    sandboxProbe: async () => effective(),
    ...rest,
  };
}

async function doctorHost(): Promise<OpsTestHost & DoctorContext> {
  const host = await fakeOpsHost();
  host.sys.users.set("www-data", { name: "www-data", uid: 33, gid: 33, gecos: "", home: "/var/www", shell: "/usr/sbin/nologin" });
  host.sys.groups.get(host.layout.groups.proxy)!.members.push("www-data");
  await ops.createProject(host, { slug: "shop", branches: ["dev"] });
  await ops.setSetting(host, { key: "alert_webhook", value: "https://ntfy.sh/incibase-test" });
  return host;
}

const verdicts = (report: Awaited<ReturnType<typeof runDoctor>>) => Object.fromEntries(report.checks.map((c) => [c.name, c.status]));
const detail = (report: Awaited<ReturnType<typeof runDoctor>>, name: string) => report.checks.find((c) => c.name === name)?.detail;

describe("host doctor", () => {
  test("a well set up VM is all OK", async () => {
    const host = await doctorHost();
    host.doctor = machine();
    const report = await runDoctor(host);
    expect(report.checks.filter((c) => c.status !== "OK")).toEqual([]);
    expect(report.ok).toBe(true);
    expect(verdicts(report)).toEqual({
      systemd: "OK",
      "cgroup v2": "OK",
      virtualization: "OK",
      "sandbox SocketBindDeny": "OK",
      "sandbox ProtectProc": "OK",
      "sandbox IPAddressDeny": "OK",
      "sandbox ProtectSystem": "OK",
      nginx: "OK",
      "proxy group": "OK",
      "host tree": "OK",
      registry: "OK",
      "env files": "OK",
      "branch shop/dev": "OK",
      journald: "OK",
      sshd: "OK",
      time: "OK",
      disk: "OK",
      "check timer": "OK",
      alerts: "OK",
    });
    expect(detail(report, "alerts")).toBe("alerts go to ntfy.sh");
    expect(formatDoctor(report)).toContain("OK   systemd: systemd 255");
  });

  test("in a container, sandbox directives that do not take effect are WARN; on a VM they FAIL", async () => {
    const host = await doctorHost();
    host.doctor = machine({ "systemd-detect-virt --container": ok("lxc\n") }, { sandboxProbe: async () => effective(false) });
    const inContainer = await runDoctor(host);
    expect(verdicts(inContainer)).toMatchObject({
      virtualization: "WARN",
      "sandbox SocketBindDeny": "WARN",
      "sandbox ProtectProc": "WARN",
      "sandbox IPAddressDeny": "OK",
      "sandbox ProtectSystem": "OK",
    });
    expect(detail(inContainer, "sandbox ProtectProc")).toBe("not effective in this container (lxc): root's /proc/1 is hidden");
    expect(inContainer.ok).toBe(true);
    host.doctor = machine({}, { sandboxProbe: async () => effective(false) });
    const onVm = await runDoctor(host);
    expect(verdicts(onVm)).toMatchObject({ "sandbox SocketBindDeny": "FAIL", "sandbox ProtectProc": "FAIL" });
    expect(onVm.ok).toBe(false);
    host.doctor = machine({}, { sandboxProbe: async () => ({ ran: false, reason: "no runtime is installed" }) });
    expect(verdicts(await runDoctor(host))).toMatchObject({ "sandbox probe": "WARN" });
  });

  test("old systemd, cgroup v1, a broken nginx config, www-data missing from the proxy group and sshd without forwarding FAIL", async () => {
    const host = await doctorHost();
    host.sys.groups.get(host.layout.groups.proxy)!.members.length = 0;
    host.doctor = machine(
      {
        "systemctl --version": ok("systemd 249 (249.11-0ubuntu3)\n"),
        "nginx -t": { exitCode: 1, stdout: "", stderr: 'nginx: [emerg] unknown directive "x" in /etc/nginx/conf.d/incibase.conf:3\nnginx: configuration file /etc/nginx/nginx.conf test failed\n' },
        "sshd -T": ok("allowstreamlocalforwarding no\ndisableforwarding no\n"),
      },
      { file: () => null },
    );
    const report = await runDoctor(host);
    expect(verdicts(report)).toMatchObject({ systemd: "FAIL", "cgroup v2": "FAIL", nginx: "FAIL", "proxy group": "FAIL", sshd: "FAIL", journald: "WARN" });
    expect(detail(report, "systemd")).toBe("systemd 249; incibase needs 252 or newer");
    expect(detail(report, "nginx")).toBe("nginx -t: nginx: configuration file /etc/nginx/nginx.conf test failed");
    expect(detail(report, "proxy group")).toContain(`usermod -aG ${host.layout.groups.proxy} www-data`);
    expect(report.ok).toBe(false);
    host.doctor = machine({ "sshd -T": ok("allowstreamlocalforwarding yes\ndisableforwarding yes\n"), "nginx -t": null });
    const again = await runDoctor(host);
    expect(detail(again, "sshd")).toContain("DisableForwarding yes");
    expect(detail(again, "nginx")).toBe("nginx is not installed");
    host.doctor = machine({ "sshd -T": null });
    expect(verdicts(await runDoctor(host))).toMatchObject({ sshd: "WARN" });
  });

  test("wrong owners and modes of the registry, env files and branch directories, and missing sockets of a running branch FAIL", async () => {
    const host = await doctorHost();
    host.doctor = machine();
    const dev = host.registry.findBranch("shop", "dev")!;
    host.sys.own(host.layout.registry, 0, 0, 0o644);
    chmodSync(host.layout.registry, 0o644);
    host.sys.own(host.layout.branch(dev.id).envFile, 0, 0, 0o640);
    host.sys.own(host.layout.branch(dev.id).data, 0, 0, 0o755);
    writeFileSync(`${host.layout.envDir}/stray.env`, "X=1\n");
    host.sys.own(`${host.layout.envDir}/stray.env`, 1000, 1000, 0o644);
    const report = await runDoctor(host);
    expect(verdicts(report)).toMatchObject({ registry: "FAIL", "env files": "FAIL", "branch shop/dev": "FAIL" });
    expect(detail(report, "registry")).toBe(`${host.layout.registry}: 0:0 mode 644, expected 0:0 600`);
    expect(detail(report, "env files")).toContain(`${host.layout.envDir}/stray.env: 1000:1000 mode 644`);
    expect(detail(report, "branch shop/dev")).toContain(`${host.layout.branch(dev.id).data}: owner 0:0, expected ${dev.os_uid}:${dev.os_uid}`);
    // Running, it must have both sockets (the fake process makes none).
    await ops.addRelease(host, { project: "shop", branch: "dev", file: fakeBundle(host.dir, "v1") });
    const running = await runDoctor(host);
    expect(detail(running, "branch shop/dev")).toContain(`${host.layout.branch(dev.id).httpSock}: missing although the branch runs`);
    // A regular file in a socket's place is not a socket.
    writeFileSync(host.layout.branch(dev.id).adminSock, "");
    host.sys.own(host.layout.branch(dev.id).adminSock, dev.os_uid, host.sys.getgrnam(host.layout.groups.admin)!.gid, 0o770);
    expect(detail(await runDoctor(host), "branch shop/dev")).toContain(`${host.layout.branch(dev.id).adminSock}: a file`);
  });

  test("a full disk, a volatile journal, an unsynchronized clock, a stopped timer and no webhook", async () => {
    const host = await doctorHost();
    await ops.setSetting(host, { key: "alert_webhook", value: null });
    host.driver.stop(host.layout.units.checkTimer);
    host.doctor = machine(
      { "timedatectl show --property=Timezone --property=NTPSynchronized": ok("Timezone=Etc/UTC\nNTPSynchronized=no\n") },
      { diskUsage: () => ({ usedPercent: 96, availableBytes: 2 * 1024 ** 3 }), file: (p) => (p.startsWith("/sys") ? file : null) },
    );
    const report = await runDoctor(host);
    expect(verdicts(report)).toMatchObject({ disk: "FAIL", journald: "WARN", time: "WARN", "check timer": "WARN", alerts: "WARN" });
    expect(detail(report, "time")).toBe("branches use Europe/Istanbul, the machine Etc/UTC; the clock is not NTP-synchronized");
    expect(detail(report, "disk")).toBe(`4% free (2.0 GiB) on the file system of ${host.layout.root}`);
    // journald.conf can make it persistent too.
    host.doctor = machine({}, { file: (p) => (p.startsWith("/sys") ? file : null), readText: () => "[Journal]\nStorage=persistent\n" });
    expect(verdicts(await runDoctor(host)).journald).toBe("OK");
  });

  test("the op runs it; the probe's output is read strictly", async () => {
    const host = await doctorHost();
    host.doctor = machine();
    expect((await ops.OPS.doctor(host, {})).ok).toBe(true);
    await expect(ops.doctor(host, { x: 1 } as never)).rejects.toMatchObject({ code: "INVALID" });
    expect(readProbe('noise\nPROBE {"bind":"error EPERM","proc":"hidden","write":"error EROFS","connect":"timeout"}\n')).toEqual(effective());
    const open = readProbe('PROBE {"bind":"bound","proc":"visible","write":"written","connect":"open"}');
    expect(open.ran && Object.values(open.directives).map((d) => d.effective)).toEqual([false, false, false, false]);
    expect(readProbe("")).toEqual({ ran: false, reason: "the probe printed nothing" });
    expect(readProbe("PROBE {")).toEqual({ ran: false, reason: "the probe printed something unreadable" });
  });
});
