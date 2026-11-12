import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  OPTIONAL_TOOLCHAIN_PATHS,
  resolveReadOnlyToolchainPaths,
} from "../src/read-only-toolchain.mjs";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "read-only-toolchain-"));
  roots.push(root);
  await mkdir(path.join(root, "usr/lib"), { recursive: true });
  await mkdir(path.join(root, "usr/bin"), { recursive: true });
  await symlink("usr/lib", path.join(root, "lib"));
  await symlink("usr/bin", path.join(root, "bin"));
  return root;
}

describe("read-only toolchain paths", () => {
  it("treats only /lib64 as optional", () => {
    expect(OPTIONAL_TOOLCHAIN_PATHS).toEqual(["/lib64"]);
  });

  it("drops an optional entry whose own path is absent and keeps the others in order", async () => {
    const root = await fixture();
    const at = (name: string) => path.join(root, name);
    const result = await resolveReadOnlyToolchainPaths([at("usr/bin"), at("optional"), at("lib")], {
      optional: [at("optional")],
    });
    expect(result).toEqual([await realpath(at("usr/bin")), await realpath(at("usr/lib"))]);
  });

  it("resolves an optional entry that exists, so x86 hosts keep their /lib64 entry", async () => {
    const root = await fixture();
    await symlink("usr/lib", path.join(root, "optional"));
    const real = await import("node:fs/promises").then((fs) =>
      fs.realpath(path.join(root, "usr/lib")),
    );
    const result = await resolveReadOnlyToolchainPaths(
      [path.join(root, "lib"), path.join(root, "optional")],
      { optional: [path.join(root, "optional")], dedupe: false },
    );
    expect(result).toEqual([real, real]);
    expect(
      await resolveReadOnlyToolchainPaths([path.join(root, "lib"), path.join(root, "optional")], {
        optional: [path.join(root, "optional")],
      }),
    ).toEqual([real]);
  });

  it("fails on a required entry that is missing", async () => {
    const root = await fixture();
    await expect(
      resolveReadOnlyToolchainPaths([path.join(root, "usr/missing")], { optional: [] }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails on an optional entry that is a dangling symlink", async () => {
    const root = await fixture();
    const link = path.join(root, "optional");
    await symlink("usr/gone", link);
    await expect(resolveReadOnlyToolchainPaths([link], { optional: [link] })).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });

  it("fails on an optional entry whose lstat is refused instead of skipping it", async () => {
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    await expect(
      resolveReadOnlyToolchainPaths(["/lib64"], {
        io: {
          lstat: async () => {
            throw denied;
          },
          realpath: async (value: string) => value,
        },
      }),
    ).rejects.toBe(denied);
  });

  it("does not treat a required entry as optional because it is spelled like one", async () => {
    await expect(
      resolveReadOnlyToolchainPaths(["/definitely/not/here/lib64"], { optional: ["/lib64"] }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns the real path of the default optional entry only when this host has it", async () => {
    const present = await lstat("/lib64").then(
      () => true,
      (error) => {
        if (error?.code === "ENOENT") return false;
        throw error;
      },
    );
    const usrLib = await realpath("/usr/lib");
    const expected = present ? [usrLib, await realpath("/lib64")] : [usrLib];
    const result = await resolveReadOnlyToolchainPaths(["/usr/lib", "/lib64"], { dedupe: false });
    expect(result).toEqual(expected);
  });

  it("is used by the four changed fixtures", async () => {
    const callers = [
      "test/fixtures/product-path-harness.ts",
      "test/fixtures/mac-sandbox-deployment.ts",
      "test/integration/prepared-file-runner.test.ts",
      "test/integration/sandbox-preparation-control.test.ts",
    ];
    for (const caller of callers) {
      const source = await readFile(path.resolve(import.meta.dirname, "../../..", caller), "utf8");
      expect(source, caller).toContain("@himawari-agent/testing/read-only-toolchain");
      expect(source, caller).toContain("resolveReadOnlyToolchainPaths(");
    }
  });
});
