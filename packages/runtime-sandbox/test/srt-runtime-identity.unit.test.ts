import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { SANDBOX_RUNTIME_VERSION } from "@himawari-agent/execution-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  readSrtRuntimeIdentity,
  requireLockedSrtRuntime,
  SRT_SECCOMP_HELPER_SHA256,
  type SrtRuntimeIdentity,
  srtRuntimeIdentityValue,
  srtRuntimeText,
} from "../src/srt-runtime-identity.ts";

const installed = path.dirname(
  createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime/package.json"),
);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixturePackage(version: string, helperMode: number | null) {
  const root = await mkdtemp(path.join(tmpdir(), "srt-identity-"));
  roots.push(root);
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "@anthropic-ai/sandbox-runtime", version }),
  );
  if (helperMode !== null) {
    await mkdir(path.join(root, "vendor/seccomp/x64"), { recursive: true });
    const helper = path.join(root, "vendor/seccomp/x64/apply-seccomp");
    await copyFile(path.join(installed, "vendor/seccomp/x64/apply-seccomp"), helper);
    await chmod(helper, helperMode);
  }
  return root;
}

const locked: SrtRuntimeIdentity = {
  packageName: "@anthropic-ai/sandbox-runtime",
  version: SANDBOX_RUNTIME_VERSION,
  helper: {
    path: "/runtime/vendor/seccomp/x64/apply-seccomp",
    realPath: "/runtime/vendor/seccomp/x64/apply-seccomp",
    regularFile: true,
    executable: true,
    sha256: SRT_SECCOMP_HELPER_SHA256.x64,
  },
  bwrapVersion: "bubblewrap 0.6.1",
};

describe("locked SRT runtime identity", () => {
  it.each(["x64", "arm64"] as const)(
    "pins the %s seccomp helper shipped in the installed SRT package",
    async (arch) => {
      const bytes = await readFile(path.join(installed, "vendor/seccomp", arch, "apply-seccomp"));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        SRT_SECCOMP_HELPER_SHA256[arch],
      );
    },
  );

  it("reads the installed package as the locked version with its executable helper", async () => {
    const identity = await readSrtRuntimeIdentity(installed, "linux", "x64");
    expect(identity).toMatchObject({
      packageName: "@anthropic-ai/sandbox-runtime",
      version: SANDBOX_RUNTIME_VERSION,
      helper: { regularFile: true, executable: true, sha256: SRT_SECCOMP_HELPER_SHA256.x64 },
    });
    expect(requireLockedSrtRuntime(identity, SANDBOX_RUNTIME_VERSION, "linux", "x64")).toEqual({
      helperPath: identity.helper?.path,
    });
    expect(srtRuntimeIdentityValue(JSON.parse(JSON.stringify(identity)))).toEqual(identity);
  });

  it("refuses an installed package whose version differs from the locked one", async () => {
    const identity = await readSrtRuntimeIdentity(
      await fixturePackage("0.0.75", 0o755),
      "linux",
      "x64",
    );
    expect(identity.version).toBe("0.0.75");
    expect(() =>
      requireLockedSrtRuntime(identity, SANDBOX_RUNTIME_VERSION, "linux", "x64"),
    ).toThrow("JOB_HOST_SRT_VERSION_MISMATCH");
  });

  it("finds no helper in a package that ships none, and refuses it", async () => {
    const identity = await readSrtRuntimeIdentity(
      await fixturePackage(SANDBOX_RUNTIME_VERSION, null),
      "linux",
      "x64",
    );
    expect(identity.helper).toMatchObject({ regularFile: false, executable: false, sha256: null });
    expect(() =>
      requireLockedSrtRuntime(identity, SANDBOX_RUNTIME_VERSION, "linux", "x64"),
    ).toThrow("JOB_HOST_SECCOMP_HELPER_UNAVAILABLE");
  });

  it("refuses a helper without the execute bit", async () => {
    const identity = await readSrtRuntimeIdentity(
      await fixturePackage(SANDBOX_RUNTIME_VERSION, 0o644),
      "linux",
      "x64",
    );
    expect(identity.helper).toMatchObject({ regularFile: true, executable: false });
    expect(() =>
      requireLockedSrtRuntime(identity, SANDBOX_RUNTIME_VERSION, "linux", "x64"),
    ).toThrow("JOB_HOST_SECCOMP_HELPER_UNAVAILABLE");
  });

  it("refuses a helper that is a link to another file", async () => {
    const root = await fixturePackage(SANDBOX_RUNTIME_VERSION, 0o755);
    const helper = path.join(root, "vendor/seccomp/x64/apply-seccomp");
    await rm(helper);
    await symlink(path.join(installed, "vendor/seccomp/x64/apply-seccomp"), helper);
    const identity = await readSrtRuntimeIdentity(root, "linux", "x64");
    expect(identity.helper?.realPath).not.toBe(identity.helper?.path);
    expect(() =>
      requireLockedSrtRuntime(identity, SANDBOX_RUNTIME_VERSION, "linux", "x64"),
    ).toThrow("JOB_HOST_SECCOMP_HELPER_UNAVAILABLE");
  });

  it.each([
    ["another package", { packageName: "sandbox-runtime-fork" }, "JOB_HOST_SRT_VERSION_MISMATCH"],
    ["an unreadable version", { version: null }, "JOB_HOST_SRT_VERSION_MISMATCH"],
    [
      "helper bytes from another release",
      {
        helper: {
          ...locked.helper,
          sha256: "64fa7514fa7199584b836159885e59b9ce3684fb8fef7e13de49965b23f54f6b",
        },
      },
      "JOB_HOST_SECCOMP_HELPER_UNAVAILABLE",
    ],
    ["no helper", { helper: null }, "JOB_HOST_SECCOMP_HELPER_UNAVAILABLE"],
  ] as const)("refuses %s", (_label, change, code) => {
    expect(() =>
      requireLockedSrtRuntime(
        { ...locked, ...change } as SrtRuntimeIdentity,
        SANDBOX_RUNTIME_VERSION,
        "linux",
        "x64",
      ),
    ).toThrow(code);
  });

  it("refuses an architecture SRT ships no helper for", () => {
    expect(() => requireLockedSrtRuntime(locked, SANDBOX_RUNTIME_VERSION, "linux", "ia32")).toThrow(
      "JOB_HOST_SECCOMP_HELPER_UNAVAILABLE",
    );
  });

  it("needs no helper on Darwin but still checks the version", () => {
    expect(
      requireLockedSrtRuntime(
        { ...locked, helper: null },
        SANDBOX_RUNTIME_VERSION,
        "darwin",
        "arm64",
      ),
    ).toEqual({ helperPath: null });
    expect(() =>
      requireLockedSrtRuntime(
        { ...locked, version: "0.0.75" },
        SANDBOX_RUNTIME_VERSION,
        "darwin",
        "arm64",
      ),
    ).toThrow("JOB_HOST_SRT_VERSION_MISMATCH");
  });

  it("describes the runtime with its SRT and bubblewrap versions", () => {
    expect(srtRuntimeText(locked)).toBe(`srt ${SANDBOX_RUNTIME_VERSION}; bwrap bubblewrap 0.6.1`);
    expect(srtRuntimeText({ ...locked, version: null, bwrapVersion: null })).toBe(
      "srt unknown; bwrap unknown",
    );
  });

  it.each([
    null,
    [],
    { ...locked, extra: true },
    { ...locked, helper: { ...locked.helper, executable: "yes" } },
    { ...locked, version: 81 },
  ])("rejects a malformed identity from the SDK thread: %j", (value) => {
    expect(srtRuntimeIdentityValue(value)).toBeNull();
  });
});
