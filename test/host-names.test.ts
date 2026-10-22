import { describe, expect, test } from "bun:test";
import { HostLayout } from "../src/host/layout.ts";
import {
  branchLabel,
  branchUser,
  checkBranchId,
  checkBranchKind,
  checkBranchName,
  checkDomain,
  checkEnvName,
  checkLabel,
  checkProjectSlug,
  checkTimezone,
  defaultKind,
  defaultLimits,
  defaultProtected,
  MAX_BRANCH_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_PROJECT_LENGTH,
  NameError,
  newBranchId,
  parseBranchRef,
} from "../src/host/names.ts";

describe("project and branch names", () => {
  test("accepts lowercase slugs that start with a letter", () => {
    for (const name of ["shop", "my-shop", "a1", "shop2-eu-west", "x".repeat(MAX_PROJECT_LENGTH)]) expect(checkProjectSlug(name)).toBe(name);
    for (const name of ["prod", "dev", "p", "feature-42", "x".repeat(MAX_BRANCH_LENGTH)]) expect(checkBranchName(name)).toBe(name);
  });

  test("refuses anything else", () => {
    const bad = ["", "Shop", "1shop", "-shop", "shop-", "my--shop", "sh_op", "sh.op", "shop/prod", "şop", "shop ", " shop", "a\nb"];
    for (const name of bad) {
      expect(() => checkProjectSlug(name)).toThrow(NameError);
      expect(() => checkBranchName(name)).toThrow(NameError);
    }
    expect(() => checkProjectSlug(42)).toThrow(NameError);
    expect(() => checkProjectSlug("a")).toThrow(/2 to 30/);
    expect(() => checkProjectSlug("x".repeat(MAX_PROJECT_LENGTH + 1))).toThrow(NameError);
    expect(() => checkBranchName("x".repeat(MAX_BRANCH_LENGTH + 1))).toThrow(NameError);
  });

  test("refuses reserved names, underscores and punycode", () => {
    for (const name of ["deploy", "console", "admin", "api", "www", "mail"]) {
      expect(() => checkProjectSlug(name)).toThrow(/reserved/);
      expect(() => checkBranchName(name)).toThrow(/reserved/);
    }
    expect(() => checkProjectSlug("_dmarc")).toThrow(/reserved/);
    expect(() => checkBranchName("_x")).toThrow(/reserved/);
    expect(() => checkProjectSlug("xn--80ak6aa92e")).toThrow(/punycode/);
    // Names that only contain a reserved word are fine.
    expect(checkProjectSlug("api-gateway")).toBe("api-gateway");
  });

  test("the label is one DNS label of at most 63 characters, split by the only --", () => {
    expect(branchLabel("shop", "prod")).toBe("prod--shop");
    const longest = branchLabel("p".repeat(MAX_PROJECT_LENGTH), "b".repeat(MAX_BRANCH_LENGTH));
    expect(longest.length).toBeLessThanOrEqual(MAX_LABEL_LENGTH);
    expect(longest.split("--")).toHaveLength(2);
    expect(() => branchLabel("shop", "my--branch")).toThrow(NameError);
    expect(checkLabel("prod--shop")).toBe("prod--shop");
    for (const bad of ["prod-shop", "prod---shop", "--shop", "prod--", "a--b--c", "../x--y", `${"a".repeat(40)}--${"b".repeat(30)}`]) {
      expect(() => checkLabel(bad)).toThrow(NameError);
    }
  });

  test("project/branch references", () => {
    expect(parseBranchRef("shop/prod")).toEqual({ project: "shop", branch: "prod" });
    for (const bad of ["shop", "shop/prod/x", "/prod", "shop/", "Shop/prod", "../etc/passwd"]) expect(() => parseBranchRef(bad)).toThrow(NameError);
  });

  test("kinds, protection and default limits", () => {
    expect(defaultKind("prod")).toBe("prod");
    expect(defaultKind("dev")).toBe("dev");
    expect(defaultKind("feature-1")).toBe("preview");
    expect(defaultProtected("prod")).toBe(true);
    expect(defaultProtected("dev")).toBe(false);
    expect(defaultProtected("preview")).toBe(false);
    expect(defaultLimits("prod").memoryMax).toBe(512 * 1024 * 1024);
    expect(defaultLimits("dev").memoryMax).toBe(256 * 1024 * 1024);
    expect(checkBranchKind("preview")).toBe("preview");
    expect(() => checkBranchKind("production")).toThrow(NameError);
  });
});

describe("branch ids", () => {
  test("are random, not derived from names, and valid user, unit and path names", () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newBranchId()));
    expect(ids.size).toBe(2000);
    for (const id of ids) {
      expect(checkBranchId(id)).toBe(id);
      expect(branchUser(id)).toMatch(/^ib-b[0-9a-z]{7}$/);
    }
  });

  test("use the low bits of each random byte", () => {
    expect(newBranchId(() => new Uint8Array([0, 31, 32, 255, 10, 20, 30]))).toBe("b0z0zamy");
  });

  test("refuse anything that could escape a path or name", () => {
    for (const bad of ["", "b123", "b1234567x", "../b1234", "B1234567", "b123456i", "b12345 7"]) expect(() => checkBranchId(bad)).toThrow(NameError);
    expect(() => branchUser("../root")).toThrow(NameError);
  });
});

describe("other names", () => {
  test("env names", () => {
    expect(checkEnvName("STRIPE_KEY")).toBe("STRIPE_KEY");
    for (const bad of ["", "1X", "A-B", "A B", "A=B", "A\nB"]) expect(() => checkEnvName(bad)).toThrow(NameError);
  });

  test("domains", () => {
    expect(checkDomain("incibase.omergenc.net")).toBe("incibase.omergenc.net");
    for (const bad of ["localhost", "Incibase.net", "-a.net", "a..net", "a.net.", "a_b.net", "*.a.net"]) expect(() => checkDomain(bad)).toThrow(NameError);
  });

  test("time zones", () => {
    expect(checkTimezone("Europe/Istanbul")).toBe("Europe/Istanbul");
    expect(checkTimezone("UTC")).toBe("UTC");
    expect(() => checkTimezone("Mars/Olympus")).toThrow(NameError);
    expect(() => checkTimezone("UTC\nX=1")).toThrow(NameError);
  });
});

describe("layout", () => {
  test("derives every path from the root, with owners and modes", () => {
    const layout = new HostLayout({ root: "/srv/ib" });
    expect(layout.registry).toBe("/srv/ib/control/registry.db");
    expect(layout.lock).toBe("/srv/ib/control/LOCK");
    const tree = Object.fromEntries(layout.hostTree().map((s) => [s.path, s]));
    expect(tree["/srv/ib"]).toMatchObject({ owner: "root", group: "root", mode: 0o755 });
    expect(tree["/srv/ib/control"]).toMatchObject({ owner: "root", group: "root", mode: 0o700 });
    expect(tree["/srv/ib/admin"]).toMatchObject({ owner: "root", group: "incibase-admin", mode: 0o750 });
    expect(tree["/srv/ib/hosts"]).toMatchObject({ owner: "root", group: "incibase-proxy", mode: 0o750 });
    expect(tree["/srv/ib/branches"]).toMatchObject({ owner: "root", group: "root", mode: 0o711 });
    expect(tree["/srv/ib/trash"]).toMatchObject({ mode: 0o700 });

    const b = layout.branch("b7k2m9q4");
    expect(b.envFile).toBe("/srv/ib/control/env/b7k2m9q4.env");
    expect(b.httpSock).toBe("/srv/ib/branches/b7k2m9q4/run/http/http.sock");
    const branch = Object.fromEntries(layout.branchTree("b7k2m9q4").map((s) => [s.path.replace(b.dir, "<b>"), s]));
    expect(branch["<b>"]).toMatchObject({ owner: "root", group: "root", mode: 0o711 });
    expect(branch["<b>/data"]).toMatchObject({ owner: "branch", group: "branch", mode: 0o700 });
    expect(branch["<b>/releases"]).toMatchObject({ owner: "root", group: "branch", mode: 0o750 });
    expect(branch["<b>/preflight"]).toMatchObject({ owner: "branch", mode: 0o700 });
    expect(branch["<b>/run/http"]).toMatchObject({ owner: "branch", group: "incibase-proxy", mode: 0o2750 });
    expect(branch["<b>/run/admin"]).toMatchObject({ owner: "branch", group: "incibase-admin", mode: 0o2750 });

    expect(layout.branchLinks("b7k2m9q4", "prod--shop")).toEqual([
      { path: "/srv/ib/hosts/prod--shop", target: "../branches/b7k2m9q4/run/http" },
      { path: "/srv/ib/admin/prod--shop.sock", target: "../branches/b7k2m9q4/run/admin/admin.sock" },
    ]);
    // A Unix socket path must fit sun_path (108 bytes) with the default root.
    expect(new HostLayout().branch("b7k2m9q4").adminSock.length).toBeLessThan(100);
  });

  test("checks the root, groups and every name that reaches a path", () => {
    for (const root of ["relative", "/", "/srv/ib/", "/srv/../etc", "/srv/i b"]) expect(() => new HostLayout({ root })).toThrow(NameError);
    expect(() => new HostLayout({ groups: { proxy: "x", admin: "x" } })).toThrow(NameError);
    expect(() => new HostLayout({ groups: { proxy: "-x", admin: "y" } })).toThrow(NameError);
    const layout = new HostLayout({ root: "/srv/ib", groups: { proxy: "t-proxy", admin: "t-admin" } });
    expect(layout.hostTree().find((s) => s.path === "/srv/ib/hosts")!.group).toBe("t-proxy");
    expect(() => layout.branch("../../etc")).toThrow(NameError);
    expect(() => layout.hostLink("../control")).toThrow(NameError);
    expect(layout.contains("/srv/ib/branches/x")).toBe(true);
    expect(layout.contains("/srv/ib/../etc")).toBe(false);
    expect(layout.contains("/srv/ibx")).toBe(false);
  });
});
