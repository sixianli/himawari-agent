import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileSandboxPolicy, type SandboxPolicyInput } from "../src/policy.js";

describe("SRT candidate policy compilation", () => {
  let root: string;
  let input: SandboxPolicyInput;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "himawari-srt-policy-")));
    for (const name of ["workspace", "private", "toolchain"]) await mkdir(path.join(root, name));
    input = {
      workspace: path.join(root, "workspace"),
      writable: true,
      privateDirectory: path.join(root, "private"),
      readOnlyToolchainPaths: [path.join(root, "toolchain")],
      protectedPaths: [path.join(root, "workspace", ".env")],
      allowedDomains: [],
    };
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("denies outside reads, shared SRT scratch writes, and network expansion", async () => {
    const result = await compileSandboxPolicy(input);
    const policy = JSON.parse(result.policyJson);
    expect(policy.filesystem.denyRead).toEqual(["/", ...input.protectedPaths]);
    expect(policy.filesystem.allowWrite).toEqual([input.privateDirectory, input.workspace].sort());
    expect(policy.filesystem.denyWrite).toContain("/private/tmp/claude");
    expect(policy.filesystem.denyWrite).toContain(input.protectedPaths[0]);
    expect(policy.network).toMatchObject({
      allowedDomains: [],
      strictAllowlist: true,
      allowAllUnixSockets: false,
      allowLocalBinding: false,
    });
    expect(policy.allowAppleEvents).toBe(false);
    expect(result.policyDigest).toBe(createHash("sha256").update(result.policyJson).digest("hex"));
  });

  it("keeps read-only workspaces out of write permissions", async () => {
    const result = await compileSandboxPolicy({ ...input, writable: false });
    expect(JSON.parse(result.policyJson).filesystem.allowWrite).toEqual([input.privateDirectory]);
  });

  it("freezes input before asynchronous filesystem resolution", async () => {
    const domains = ["example.com"];
    const mutable = { ...input, allowedDomains: domains };
    const pending = compileSandboxPolicy(mutable);
    domains.push("attacker.example");
    mutable.writable = false;
    const policy = JSON.parse((await pending).policyJson);
    expect(policy.network.allowedDomains).toEqual(["example.com"]);
    expect(policy.filesystem.allowWrite).toContain(input.workspace);
  });

  it("rejects secret exceptions, shared private roots and workspace toolchains", async () => {
    await expect(
      compileSandboxPolicy({ ...input, protectedPaths: [input.workspace] }),
    ).rejects.toThrow("PROTECTED_PATH_REOPENED");
    await expect(
      compileSandboxPolicy({ ...input, privateDirectory: input.workspace }),
    ).rejects.toThrow("PRIVATE_DIRECTORY_OVERLAP");
    await expect(
      compileSandboxPolicy({ ...input, readOnlyToolchainPaths: [input.workspace] }),
    ).rejects.toThrow("TOOLCHAIN_OVERLAP");
  });

  it("rejects noncanonical directories and symlinks", async () => {
    const link = path.join(root, "link");
    await symlink(input.workspace, link);
    await expect(compileSandboxPolicy({ ...input, workspace: link })).rejects.toThrow(
      "PATH_NOT_CANONICAL",
    );
    await expect(
      compileSandboxPolicy({ ...input, workspace: `${input.workspace}/../workspace` }),
    ).rejects.toThrow("PATH_INVALID");
  });

  it("rejects a protected path that resolves through a symlink", async () => {
    await symlink(input.privateDirectory, path.join(input.workspace, "secret-link"));
    await expect(
      compileSandboxPolicy({
        ...input,
        protectedPaths: [path.join(input.workspace, "secret-link", "missing.txt")],
      }),
    ).rejects.toThrow("PATH_NOT_CANONICAL");
  });

  it.each([
    "*.example.com",
    "https://example.com",
    "user:password@example.com",
    "example.com:443",
    "127.0.0.1",
    "localhost",
  ])("rejects unreviewed domain syntax %s", async (domain) => {
    await expect(compileSandboxPolicy({ ...input, allowedDomains: [domain] })).rejects.toThrow(
      "DOMAIN_INVALID",
    );
  });

  it("rejects raw SDK overrides instead of dropping unknown keys", async () => {
    await expect(
      compileSandboxPolicy(Object.assign({}, input, { enableWeakerNestedSandbox: true })),
    ).rejects.toThrow("INPUT_INVALID");
  });
});
