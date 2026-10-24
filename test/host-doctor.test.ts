// `host doctor` on a fake host: the machine (commands, /sys, the journal,
// sshd, the sandbox probe) comes from hooks, so every verdict is checked
// here; test/host-check-linux.test.ts runs it on the real thing. The default
// machine is what an Ubuntu 24.04 VM shows, systemd built without the BPF
// framework included.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { VERSION } from "../src/engine/version.ts";
import { runCheck, type CheckContext } from "../src/host/check.ts";
import {
  ALERT_DELIVERY_GRACE_MS,
  CHECK_STALE_MS,
  formatDoctor,
  journalStorage,
  readProbe,
  runDoctor,
  systemdFeature,
  type CommandResult,
  type DoctorContext,
  type DoctorHooks,
  type SandboxProbe,
} from "../src/host/doctor.ts";
import type { FileInfo } from "../src/host/system.ts";
import * as ops from "../src/host/ops.ts";
import { closeOpsHosts, fakeBundle, fakeOpsHost, type OpsTestHost } from "./host-helpers.ts";

afterEach(closeOpsHosts);

const dir: FileInfo = { type: "dir", uid: 0, gid: 0, mode: 0o755, size: 0, mtimeMs: 0 };
const file: FileInfo = { ...dir, type: "file", mode: 0o644 };
const ok = (stdout: string): CommandResult => ({ exitCode: 0, stdout, stderr: "" });

/** What the probe finds; on Ubuntu 24.04 (`-BPF_FRAMEWORK`) SocketBindDeny does nothing, even on a VM. */
const effective = (all = true, bind = all): SandboxProbe => ({
  ran: true,
  directives: {
    SocketBindDeny: { effective: bind, detail: bind ? "listening on 0.0.0.0: error EPERM" : "listening on 0.0.0.0: bound" },
    ProtectProc: { effective: all, detail: "root's /proc/1 is hidden" },
    IPAddressDeny: { effective: true, detail: "connecting to 127.0.0.1: timeout" },
    ProtectSystem: { effective: true, detail: "writing /var/tmp: error EROFS" },
  },
});

const MACHINE_ID = "1464c04e104a46fd83dcdf3790e3a865";
/** `systemctl --version` of Ubuntu 24.04 (noble, amd64 and arm64 alike). */
const UBUNTU_SYSTEMD =
  "systemd 255 (255.4-1ubuntu8.18)\n+PAM +AUDIT +SELINUX +APPARMOR +IMA +SMACK +SECCOMP +GCRYPT -GNUTLS +OPENSSL +ACL +BLKID +CURL +ELFUTILS +FIDO2 +IDN2 -IDN +IPTC +KMOD +LIBCRYPTSETUP +LIBFDISK +PCRE2 -PWQUALITY +P11KIT +QRENCODE +TPM2 +BZIP2 +LZ4 +XZ +ZLIB +ZSTD -BPF_FRAMEWORK -XKBCOMMON +UTMP +SYSVINIT default-hierarchy=unified\n";
const BPF_SYSTEMD = UBUNTU_SYSTEMD.replace("-BPF_FRAMEWORK", "+BPF_FRAMEWORK");
/** `systemd-analyze cat-config systemd/journald.conf` of Ubuntu 24.04: every Storage= commented out (auto). */
const UBUNTU_JOURNALD = "# /etc/systemd/journald.conf\n[Journal]\n#Storage=auto\n#Compress=yes\n\n# /usr/lib/systemd/journald.conf.d/syslog.conf\n[Journal]\nForwardToSyslog=yes\n";

/** A healthy Ubuntu 24.04 VM, as the hooks show it; `patch` changes what one command says. */
function machine(patch: Record<string, CommandResult | null> = {}, rest: Partial<DoctorHooks> = {}): Partial<DoctorHooks> {
  const commands: Record<string, CommandResult | null> = {
    "systemctl --version": ok(UBUNTU_SYSTEMD),
    "systemd-analyze cat-config systemd/journald.conf": ok(UBUNTU_JOURNALD),
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
    file: (path) => (path === "/sys/fs/cgroup/cgroup.controllers" ? file : path === "/var/log/journal" || path === `/var/log/journal/${MACHINE_ID}` ? dir : null),
    readText: (path) => (path === "/etc/machine-id" ? `${MACHINE_ID}\n` : null),
    diskUsage: () => ({ usedPercent: 30, availableBytes: 70 * 1024 ** 3 }),
    sandboxProbe: async () => effective(true, false),
    ...rest,
  };
}

type DoctorHost = OpsTestHost & DoctorContext & CheckContext & { clock: { t: number } };

/** A host with shop/dev, an ntfy webhook, a clock that only moves when told, and one completed check. */
async function doctorHost(): Promise<DoctorHost> {
  const host = (await fakeOpsHost()) as DoctorHost;
  host.sys.users.set("www-data", { name: "www-data", uid: 33, gid: 33, gecos: "", home: "/var/www", shell: "/usr/sbin/nologin" });
  host.sys.groups.get(host.layout.groups.proxy)!.members.push("www-data");
  await ops.createProject(host, { slug: "shop", branches: ["dev"] });
  await ops.setSetting(host, { key: "alert_webhook", value: "https://ntfy.sh/incibase-test" });
  host.clock = { t: 1_900_000_000_000 };
  host.now = () => host.clock.t;
  host.diskUsage = () => ({ usedPercent: 30, availableBytes: 70 * 1024 ** 3 });
  await runCheck(host);
  host.clock.t += 10_000;
  return host;
}

const verdicts = (report: Awaited<ReturnType<typeof runDoctor>>) => Object.fromEntries(report.checks.map((c) => [c.name, c.status]));
const detail = (report: Awaited<ReturnType<typeof runDoctor>>, name: string) => report.checks.find((c) => c.name === name)?.detail;

describe("host doctor", () => {
  test("a well set up Ubuntu 24.04 VM passes; SocketBindDeny, which its systemd cannot apply, is the one WARN", async () => {
    const host = await doctorHost();
    host.doctor = machine();
    const report = await runDoctor(host);
    expect(report.checks.filter((c) => c.status !== "OK").map((c) => c.name)).toEqual(["sandbox SocketBindDeny"]);
    expect(detail(report, "sandbox SocketBindDeny")).toBe(
      "unsupported by this systemd build (-BPF_FRAMEWORK): a branch can listen on TCP; IPAddressDeny keeps local and private peers out, so the firewall must keep every port but 22, 80 and 443 closed: listening on 0.0.0.0: bound",
    );
    expect(report.ok).toBe(true);
    expect(verdicts(report)).toEqual({
      systemd: "OK",
      "cgroup v2": "OK",
      virtualization: "OK",
      "sandbox SocketBindDeny": "WARN",
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
      "cli link": "OK",
      "check timer": "OK",
      alerts: "OK",
    });
    expect(detail(report, "cli link")).toBe(`${host.layout.cliLink} runs the installed runtime ${VERSION}`);
    expect(detail(report, "alerts")).toBe("alerts go to ntfy.sh");
    expect(detail(report, "check timer")).toBe("incibase-check.timer runs the check every 30 s; the last one completed 10 s ago");
    expect(detail(report, "journald")).toBe("persistent storage (Storage=auto, /var/log/journal)");
    expect(formatDoctor(report)).toContain("OK   systemd: systemd 255");
    // With the BPF framework, SocketBindDeny works and is OK like the rest.
    host.doctor = machine({ "systemctl --version": ok(BPF_SYSTEMD) }, { sandboxProbe: async () => effective() });
    const strict = await runDoctor(host);
    expect(strict.checks.filter((c) => c.status !== "OK")).toEqual([]);
  });

  test("systemdFeature reads systemctl --version's feature line", () => {
    expect(systemdFeature(UBUNTU_SYSTEMD, "BPF_FRAMEWORK")).toBe(false);
    expect(systemdFeature(BPF_SYSTEMD, "BPF_FRAMEWORK")).toBe(true);
    expect(systemdFeature(UBUNTU_SYSTEMD, "SECCOMP")).toBe(true);
    expect(systemdFeature("systemd 249 (249.11-0ubuntu3)\n", "BPF_FRAMEWORK")).toBeNull();
    expect(systemdFeature("+BPF_FRAMEWORKX", "BPF_FRAMEWORK")).toBeNull();
  });

  test("in a container, sandbox directives that do not take effect are WARN; on a VM they FAIL", async () => {
    const host = await doctorHost();
    host.doctor = machine({ "systemctl --version": ok(BPF_SYSTEMD), "systemd-detect-virt --container": ok("lxc\n") }, { sandboxProbe: async () => effective(false) });
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
    host.doctor = machine({ "systemctl --version": ok(BPF_SYSTEMD) }, { sandboxProbe: async () => effective(false) });
    const onVm = await runDoctor(host);
    expect(verdicts(onVm)).toMatchObject({ "sandbox SocketBindDeny": "FAIL", "sandbox ProtectProc": "FAIL" });
    expect(onVm.ok).toBe(false);
    // Without the BPF framework SocketBindDeny is the build's doing, in a container as on a VM; the rest still FAIL on a VM.
    host.doctor = machine({ "systemd-detect-virt --container": ok("lxc\n") }, { sandboxProbe: async () => effective(false) });
    const orbstack = await runDoctor(host);
    expect(detail(orbstack, "sandbox SocketBindDeny")).toStartWith("unsupported by this systemd build (-BPF_FRAMEWORK)");
    expect(detail(orbstack, "sandbox SocketBindDeny")).not.toContain("container");
    host.doctor = machine({}, { sandboxProbe: async () => effective(false) });
    expect(verdicts(await runDoctor(host))).toMatchObject({ "sandbox SocketBindDeny": "WARN", "sandbox ProtectProc": "FAIL" });
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
    // journald.conf can make it persistent too (read directly when systemd-analyze cannot show it).
    host.doctor = machine(
      { "systemd-analyze cat-config systemd/journald.conf": null },
      { file: (p) => (p.startsWith("/sys") ? file : null), readText: () => "[Journal]\nStorage=persistent\n" },
    );
    expect(verdicts(await runDoctor(host)).journald).toBe("OK");
  });

  test("journald: Storage=volatile or none wins over /var/log/journal, drop-ins included; a journal not written yet is a WARN", async () => {
    const host = await doctorHost();
    const config = (text: string) => machine({ "systemd-analyze cat-config systemd/journald.conf": ok(text) });
    host.doctor = config("# /etc/systemd/journald.conf\n[Journal]\nStorage=volatile\n");
    const volatile = await runDoctor(host);
    expect(verdicts(volatile).journald).toBe("WARN");
    expect(detail(volatile, "journald")).toBe("Storage=volatile: branch logs are lost at reboot (set Storage=persistent in /etc/systemd/journald.conf.d/)");
    // The last one wins: a drop-in after journald.conf, in either direction.
    host.doctor = config(`${UBUNTU_JOURNALD}\n# /etc/systemd/journald.conf.d/50-ram.conf\n[Journal]\nStorage=none\n`);
    expect(detail(await runDoctor(host), "journald")).toStartWith("Storage=none:");
    host.doctor = config("# /etc/systemd/journald.conf\n[Journal]\nStorage=volatile\n\n# /etc/systemd/journald.conf.d/keep.conf\n[Journal]\nStorage=persistent\n");
    expect(verdicts(await runDoctor(host)).journald).toBe("OK");
    // Only [Journal] counts; an empty assignment resets to auto.
    expect(journalStorage("[Other]\nStorage=volatile\n")).toBe("auto");
    expect(journalStorage("[Journal]\nStorage=volatile\n[Journal]\nStorage=\n")).toBe("auto");
    expect(journalStorage("[Journal]\n  Storage = Persistent \n")).toBe("persistent");
    // The directory is there, but nothing was written for this machine yet.
    host.doctor = machine({}, { file: (p) => (p === "/var/log/journal" || p.startsWith("/sys") ? (p === "/var/log/journal" ? dir : file) : null) });
    expect(detail(await runDoctor(host), "journald")).toBe(`Storage=auto, but journald has not written to /var/log/journal/${MACHINE_ID} yet (journalctl --flush)`);
  });

  test("check timer: a failed check service or no completed check for 2 minutes FAILs, though the timer runs", async () => {
    const host = await doctorHost();
    host.doctor = machine();
    const { checkService } = host.layout.units;
    expect(verdicts(await runDoctor(host))["check timer"]).toBe("OK");
    // Every run fails (a removed binary, a registry lock that times out): systemd marks the oneshot failed.
    const units = (host.driver as unknown as { units: Map<string, { status: Record<string, unknown> }> }).units;
    host.driver.start(checkService);
    units.get(checkService)!.status = { ...units.get(checkService)!.status, activeState: "failed", subState: "failed", result: "exit-code" };
    const failed = await runDoctor(host);
    expect(verdicts(failed)["check timer"]).toBe("FAIL");
    expect(detail(failed, "check timer")).toBe(`the last run of ${checkService} failed (exit-code): nothing kills a stalled branch or raises alerts (journalctl -u ${checkService})`);
    expect(failed.ok).toBe(false);
    // Not failed, but nothing completed for a while (a hang, a unit that never runs).
    units.get(checkService)!.status = { ...units.get(checkService)!.status, activeState: "inactive", subState: "dead", result: "success" };
    host.clock.t += CHECK_STALE_MS;
    const stale = await runDoctor(host);
    expect(verdicts(stale)["check timer"]).toBe("FAIL");
    expect(detail(stale, "check timer")).toBe(`the last check completed 130 s ago: ${checkService} does not complete (journalctl -u ${checkService})`);
    await runCheck(host);
    expect(verdicts(await runDoctor(host))["check timer"]).toBe("OK");
    // A timer that runs but has not completed a check yet.
    rmSync(host.layout.checkState);
    expect(detail(await runDoctor(host), "check timer")).toBe("incibase-check.timer runs, but no check has completed yet");
  });

  test("cli link: the check service runs it, so one that is missing (every run skipped) or leads anywhere but an installed runtime FAILs", async () => {
    const host = await doctorHost();
    host.doctor = machine();
    const link = host.layout.cliLink;
    const { checkService } = host.layout.units;
    // Before host use-cli, systemd skips each run (ConditionFileIsExecutable): nothing fails, nothing is checked either.
    host.sys.remove(link);
    const missing = await runDoctor(host);
    expect(verdicts(missing)).toMatchObject({ "cli link": "FAIL", "check timer": "FAIL" });
    expect(detail(missing, "cli link")).toBe(`${link} does not exist: point it at an installed runtime (host use-cli ${VERSION}); until then the check timer skips every run`);
    expect(detail(missing, "check timer")).toBe(`every run of ${checkService} is skipped: ${link} does not exist (see cli link)`);
    expect(missing.ok).toBe(false);
    // No runtime at all: install one first.
    const binary = host.layout.runtimeBinary(VERSION);
    host.sys.own(binary, 0, 0, 0o775);
    expect(detail(await runDoctor(host), "cli link")).toBe(`${link} does not exist: install a runtime and point it there (host install-runtime, then host use-cli <version>); until then the check timer skips every run`);
    host.sys.own(binary, 0, 0, 0o755);
    // With the timer off nothing runs it later: a WARN.
    await host.registry.withLock(() => host.registry.setSetting("check_timer", "off"));
    expect(verdicts(await runDoctor(host))["cli link"]).toBe("WARN");
    expect(detail(await runDoctor(host), "cli link")).toBe(`${link} does not exist: point it at an installed runtime (host use-cli ${VERSION})`);
    await host.registry.withLock(() => host.registry.setSetting("check_timer", "on"));
    // A link to nothing is skipped as well (path conditions follow links), and so is a directory.
    symlinkSync(join(host.dir, "gone"), link);
    expect(detail(await runDoctor(host), "check timer")).toBe(`every run of ${checkService} is skipped: ${link} points at ${join(host.dir, "gone")}, which does not exist (see cli link)`);
    host.sys.remove(link);
    host.sys.mkdir(link, 0o755);
    expect(verdicts(await runDoctor(host))).toMatchObject({ "cli link": "FAIL", "check timer": "FAIL" });
    expect(detail(await runDoctor(host), "check timer")).toBe(`every run of ${checkService} is skipped: ${link} is a dir, not a link to an installed runtime (see cli link)`);
    // A file in its place (a download copied there) is what root runs: the check does run, the link FAILs.
    host.sys.remove(link);
    writeFileSync(link, "#!/bin/sh\n", { mode: 0o755 });
    const file = await runDoctor(host);
    expect(verdicts(file)).toMatchObject({ "cli link": "FAIL", "check timer": "OK" });
    expect(detail(file, "cli link")).toBe(
      `${link} is a file, not a link to an installed runtime, and root runs it (the check timer, sudo incibase): point it at an installed runtime (host use-cli ${VERSION} --replace)`,
    );
    // What systemd's ConditionFileIsExecutable skips (stat(), every link followed): no executable regular file at the end.
    const skips = async (what: string, problem: string) => {
      const report = await runDoctor(host);
      expect(verdicts(report), what).toMatchObject({ "cli link": "FAIL", "check timer": "FAIL" });
      expect(detail(report, "check timer"), what).toBe(`every run of ${checkService} is skipped: ${link} ${problem} (see cli link)`);
    };
    chmodSync(link, 0o644);
    await skips("a file no one can execute", "is a file no one can execute, not a link to an installed runtime");
    host.sys.remove(link);
    const inner = join(host.dir, "inner");
    symlinkSync(join(host.dir, "gone"), inner);
    symlinkSync(inner, link);
    await skips("a link to a link to nothing", `points at ${inner}, which leads to ${join(host.dir, "gone")}, where there is nothing`);
    host.sys.remove(link);
    symlinkSync(host.layout.runtimeDir(VERSION), link);
    await skips("a link to a directory", `points at ${host.layout.runtimeDir(VERSION)}, which is a dir`);
    host.sys.remove(link);
    const plain = join(host.dir, "plain");
    writeFileSync(plain, "", { mode: 0o644 });
    symlinkSync(plain, link);
    await skips("a link to a file no one can execute", `points at ${plain}, which is a file no one can execute`);
    // A link to a file someone else may own: the binary install-runtime copied from.
    host.sys.remove(link);
    symlinkSync(join(host.dir, "incibase-bin"), link);
    expect(detail(await runDoctor(host), "cli link")).toBe(
      `${link} points at ${join(host.dir, "incibase-bin")}, not at a runtime installed in ${host.layout.runtimeRoot} that only root can write, and root runs it (the check timer, sudo incibase): point it at an installed runtime (host use-cli ${VERSION})`,
    );
    // An installed runtime someone else can write is no better, and use-cli would only link it again: its files are the fix.
    await ops.useCli(host, { version: VERSION });
    host.sys.own(binary, 1000, 1000, 0o755);
    const runtime = await runDoctor(host);
    expect(verdicts(runtime)["cli link"]).toBe("FAIL");
    expect(detail(runtime, "cli link")).toBe(
      `${link} points at ${binary}, a runtime in ${host.layout.runtimeRoot} that someone other than root can change, and root runs it (the check timer, sudo incibase): ` +
        `make ${binary}, ${host.layout.runtimeDir(VERSION)} and ${host.layout.runtimeRoot} root's and writable by root alone (chown root:root ${binary}; chmod go-w ${binary}, and the same for the two directories), ` +
        "or point it at another installed runtime (host use-cli <version>)",
    );
    host.sys.own(binary, 0, 0, 0o755);
    // Nor is a link others can replace: its directory, or any directory above it, someone else can change.
    const dir = dirname(link);
    const dirFix = (path: string) => `make ${path} root's and writable by root alone (chown root:root ${path}; chmod go-w ${path}), or give the host a CLI link in a directory only root can write`;
    host.sys.own(dir, 1000, 1000);
    expect(detail(await runDoctor(host), "cli link")).toBe(
      `${link} is in ${dir}, which someone other than root can change (${dir} belongs to uid 1000, not root), and root runs it (the check timer, sudo incibase): ${dirFix(dir)}`,
    );
    host.sys.own(dir, 0, 0, 0o775);
    expect(detail(await runDoctor(host), "cli link")).toStartWith(`${link} is in ${dir}, which someone other than root can change (${dir} is writable by someone other than root), and root runs it`);
    host.sys.own(dir, 0, 0, 0o755);
    // A user's grandparent: they rename the parent away and put their own incibase in its place.
    host.sys.own(host.dir, 1000, 1000);
    expect(detail(await runDoctor(host), "cli link")).toBe(
      `${link} is in ${dir}, which someone other than root can change (${host.dir} belongs to uid 1000, not root), and root runs it (the check timer, sudo incibase): ${dirFix(host.dir)}`,
    );
    host.sys.own(host.dir, 0, 0);
    expect(verdicts(await runDoctor(host))).toMatchObject({ "cli link": "OK", "check timer": "OK" });
  });

  test("check timer: a check unit other than this incibase renders (an older one ran the binary host init ran from) FAILs until host render", async () => {
    const host = await doctorHost();
    host.doctor = machine();
    const unit = host.layout.unitFile(host.layout.units.checkService);
    const rendered = readFileSync(unit, "utf8");
    host.sys.writeFile(unit, rendered.replace(/^ExecStart=\S+/m, "ExecStart=/home/omer/incibase-linux-x64"), { uid: 0, gid: 0, mode: 0o644 });
    const stale = await runDoctor(host);
    expect(verdicts(stale)["check timer"]).toBe("FAIL");
    expect(detail(stale, "check timer")).toBe(`${unit} is not what this incibase renders (it runs /home/omer/incibase-linux-x64 host check --root ${host.layout.root}): incibase host render writes it`);
    host.sys.remove(unit);
    expect(detail(await runDoctor(host), "check timer")).toBe(`${unit} is missing: incibase host render writes it`);
    await ops.render(host);
    expect(readFileSync(unit, "utf8")).toBe(rendered);
    expect(verdicts(await runDoctor(host))["check timer"]).toBe("OK");
  });

  test("alerts: a failing delivery is a WARN; alerts waiting more than 5 minutes for the webhook FAIL", async () => {
    const host = await doctorHost();
    host.doctor = machine();
    const hook = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("no", { status: 500 }) });
    try {
      // The op takes https only; a local stand-in is written directly.
      await host.registry.withLock(() => host.registry.setSetting("alert_webhook", `http://127.0.0.1:${hook.port}/incibase-topic-secret`));
      // A job's alert (the check itself neither raises nor resolves it).
      const key = `release:${host.registry.findBranch("shop", "dev")!.id}`;
      await host.registry.withLock(() => host.registry.raiseAlert(key, "release 2 failed its gate", host.clock.t));
      expect((await runCheck(host)).notifications.error).toBe(`${key}: HTTP 500`);
      host.clock.t += 30_000;
      const warn = await runDoctor(host);
      expect(verdicts(warn).alerts).toBe("WARN");
      expect(detail(warn, "alerts")).toBe(`alerts go to 127.0.0.1:${hook.port}, but the last delivery 30 s ago failed: ${key}: HTTP 500`);
      host.clock.t += ALERT_DELIVERY_GRACE_MS;
      await runCheck(host);
      const fail = await runDoctor(host);
      expect(verdicts(fail).alerts).toBe("FAIL");
      expect(detail(fail, "alerts")).toBe(`1 alert(s) waiting to reach 127.0.0.1:${hook.port}, the oldest since 330 s ago; the last delivery failed: ${key}: HTTP 500 (${key})`);
      expect(JSON.stringify(fail)).not.toContain("incibase-topic-secret");
      expect(fail.ok).toBe(false);
    } finally {
      hook.stop(true);
    }
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
