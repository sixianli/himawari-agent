import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { CommandProfile, PayloadRef } from "@himawari-agent/application";
import { afterEach, describe, expect, it } from "vitest";
import {
  AppleContainerCommandLaunchProvider,
  LinuxBubblewrapCommandLaunchProvider,
  QualifiedCandidateWorkspace,
} from "../src/index.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function git(root: string, args: readonly string[]) {
  return execFile("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      // biome-ignore lint/complexity/useLiteralKeys: Node env has an index signature.
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      LC_ALL: "C",
    },
  });
}

async function gitBuffer(root: string, args: readonly string[]) {
  return execFile("git", ["-C", root, ...args], {
    encoding: "buffer",
    env: {
      // biome-ignore lint/complexity/useLiteralKeys: Node env has an index signature.
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      LC_ALL: "C",
    },
  });
}

async function fixture(
  qualified = true,
  validationEffect?: (workspaceRef: string) => Promise<void>,
  baseFiles: Readonly<Record<string, string>> = {},
) {
  const repository = await mkdtemp(path.join(tmpdir(), "himawari-candidate-base-"));
  const candidateRoot = await mkdtemp(path.join(tmpdir(), "himawari-candidate-root-"));
  roots.push(repository, candidateRoot);
  await git(repository, ["init", "-q"]);
  await git(repository, ["config", "user.name", "Fixture Owner"]);
  await git(repository, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(path.join(repository, "allowed.txt"), "base\n");
  await writeFile(path.join(repository, "protected.txt"), "protected\n");
  for (const [filename, body] of Object.entries(baseFiles)) {
    await mkdir(path.dirname(path.join(repository, filename)), { recursive: true });
    await writeFile(path.join(repository, filename), body);
  }
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-q", "-m", "base"]);
  const revision = (await git(repository, ["rev-parse", "HEAD"])).stdout.trim();
  const archive = (await gitBuffer(repository, ["archive", "--format=tar", revision])).stdout;
  const payloads = new Map<string, Uint8Array>();
  const protectedPayloads = new Map<string, Uint8Array>();
  const adapter = new QualifiedCandidateWorkspace({
    baseRepository: repository,
    candidateRoot,
    sandbox: {
      execute: async ({ profile }) => {
        await validationEffect?.(profile.workdir);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
          outputLimitExceeded: false,
          wallTimeMs: 1,
          fileObservationRefs: ["files:fixture"],
          networkObservationRefs: ["command-network:none:enforced"],
          redactionApplied: true,
          cancellationReconciled: true,
          sandboxRuntimeIdentity: "apple-container:1.2.0:fixture",
          resourceCeilingEnforced: true,
        };
      },
    },
    qualification: async () => ({
      qualified,
      platform: "macos",
      runtimeIdentity: "apple-container:1.2.0:fixture",
      evidenceRefs: ["evidence:fixture"],
      reasonCodes: qualified ? [] : ["ISOLATION_UNAVAILABLE"],
    }),
    readPayload: async (ref) => {
      const value = payloads.get(ref);
      if (!value) throw new Error("payload missing");
      return value;
    },
    protectPayload: async (bytes) => {
      const ref = `payload:protected:${protectedPayloads.size + 1}` as PayloadRef;
      protectedPayloads.set(ref, bytes);
      return ref;
    },
    compareRunner: async ({ inputSetDigest }) => ({
      inputSetDigest,
      baseResultRef: "payload:base",
      candidateResultRef: "payload:candidate",
      qualityDeltaPermille: 1,
      performanceDeltaPermille: 0,
      resourceDeltaPermille: 0,
      regressionRefs: [],
    }),
  });
  return {
    adapter,
    repository,
    candidateRoot,
    revision,
    baseDigest: sha256(new Uint8Array(archive)),
    payloads,
    protectedPayloads,
  };
}

function candidateProfile(workspaceRef: string): CommandProfile {
  return {
    id: "candidate-driver-profile",
    revision: 1,
    workspaceId: workspaceRef,
    argvPattern: ["node", "--check", "src/a.ts"],
    workdir: workspaceRef,
    environmentNames: [],
    fileScopes: [workspaceRef],
    network: "none",
    timeoutMs: 1_000,
    maxOutputBytes: 1_024,
    resources: { maxCpuTimeMs: 1_000, maxMemoryBytes: 64 * 1024 * 1024, maxProcesses: 2 },
    sandboxTier: "isolated-high-risk",
    sandboxRuntimeIdentity: "fixture-only",
    scriptDigest: null,
    scriptSource: null,
    authorizationRef: "authorization:candidate",
    expiresAt: "2026-10-01T00:00:00.000Z",
    revokedAt: null,
  };
}

describe("QualifiedCandidateWorkspace", () => {
  it("removes crash-left manager scratch before completing disposal and preserves the tombstone", async () => {
    const f = await fixture();
    const workspaceRef = await f.adapter.create({
      candidateId: "candidate-crash-scratch",
      baseRevision: f.revision,
      baseDigest: f.baseDigest,
      allowedPaths: ["allowed.txt"],
      spaceBudgetBytes: 4 * 1024 * 1024,
    });
    const manager = path.dirname(workspaceRef);
    const scratch = async () => {
      await mkdir(path.join(manager, ".artifact-AAAAAA", "tree"), { recursive: true });
      await writeFile(
        path.join(manager, ".artifact-AAAAAA", "tree", "source.ts"),
        "copied sensitive source",
      );

      await mkdir(path.join(manager, ".patch-BBBBBB"));
      await writeFile(path.join(manager, ".patch-BBBBBB", "input.patch"), "private patch");
      await writeFile(
        path.join(manager, ".manifest-01234567-89ab-4cde-8f01-234567890abc"),
        "partial manifest",
      );
      await writeFile(path.join(manager, "base.tar"), "private base archive");
    };
    await scratch();
    await writeFile(path.join(manager, "unrecognized-owner-note"), "keep");
    await f.adapter.dispose(workspaceRef);
    expect((await readdir(manager)).sort()).toEqual(["manifest.json", "unrecognized-owner-note"]);
    expect(JSON.parse(await readFile(path.join(manager, "manifest.json"), "utf8"))).toMatchObject({
      lifecycle: "disposed",
    });
    // A legacy completed record can still carry crash residue; repeat disposal must inspect it.
    await scratch();
    await f.adapter.dispose(workspaceRef);
    expect((await readdir(manager)).sort()).toEqual(["manifest.json", "unrecognized-owner-note"]);
  });

  it("accepts directory scopes and builds Linux/Apple launch mounts for only the absolute source root using fixture probes", async () => {
    const f = await fixture(true, undefined, {
      "src/a.ts": "base\n",
      "src-other/a.ts": "protected\n",
    });
    const workspaceRef = await f.adapter.create({
      candidateId: "candidate-provider",
      baseRevision: f.revision,
      baseDigest: f.baseDigest,
      allowedPaths: ["src/"],
      spaceBudgetBytes: 4 * 1024 * 1024,
    });
    const patch = (filename: string, before: string) =>
      new TextEncoder().encode(
        `diff --git a/${filename} b/${filename}\n--- a/${filename}\n+++ b/${filename}\n@@ -1 +1 @@\n-${before}\n+candidate\n`,
      );
    f.payloads.set("payload:directory", patch("src/a.ts", "base"));
    const changed = await f.adapter.patch({
      workspaceRef,
      patchRef: "payload:directory",
      expectedBaseDigest: f.baseDigest,
      allowedPaths: ["src"],
    });
    expect(changed.changedPaths).toEqual(["src/a.ts"]);
    f.payloads.set("payload:sibling", patch("src-other/a.ts", "protected"));
    await expect(
      f.adapter.patch({
        workspaceRef,
        patchRef: "payload:sibling",
        expectedBaseDigest: f.baseDigest,
        allowedPaths: ["src"],
      }),
    ).rejects.toThrow("SCOPE_ESCAPE");
    const profile = candidateProfile(workspaceRef);
    expect(await f.adapter.validate({ workspaceRef, profiles: [profile] })).toEqual([
      expect.objectContaining({ outcome: "passed" }),
    ]);
    await expect(
      f.adapter.validate({
        workspaceRef,
        profiles: [{ ...profile, fileScopes: [path.dirname(workspaceRef)] }],
      }),
    ).rejects.toThrow("PROFILE_SCOPE_INVALID");

    const driverRoot = await mkdtemp(path.join(tmpdir(), "candidate-driver-fixtures-"));
    roots.push(driverRoot);
    const runtimeRoot = path.join(driverRoot, "runtime");
    await mkdir(runtimeRoot, { mode: 0o700 });
    const bwrapPath = path.join(driverRoot, "bwrap");
    const prlimitPath = path.join(driverRoot, "prlimit");
    const containerPath = path.join(driverRoot, "container");
    for (const executable of [bwrapPath, prlimitPath, containerPath]) {
      await writeFile(executable, "fixture driver");
      await chmod(executable, 0o700);
    }
    // Real providers validate real source paths. Probe responses are fixtures; no sandbox is launched or qualified on this host.
    const linux = new LinuxBubblewrapCommandLaunchProvider({
      bindings: new Map([
        [
          workspaceRef,
          {
            workspaceId: workspaceRef,
            hostRoot: workspaceRef,
            runtimeRoot,
            sandboxPath: "/workspace",
            executablePaths: { node: "/usr/bin/node" },
            runtimeDigest: `sha256:${"1".repeat(64)}`,
          },
        ],
      ]),
      observe: async () => [],
      bwrapPath,
      prlimitPath,
      platform: "linux",
      run: async (command, args) => ({
        stdout:
          args[0] === "--version"
            ? command === bwrapPath
              ? "bubblewrap 0.11.2"
              : "prlimit 2.38"
            : "",
        stderr: "",
      }),
    });
    const apple = new AppleContainerCommandLaunchProvider({
      bindings: new Map([
        [
          workspaceRef,
          {
            workspaceId: workspaceRef,
            hostRoot: workspaceRef,
            imageRef: `fixture@sha256:${"1".repeat(64)}`,
            containerPath: "/workspace",
            guestPrlimitPath: "/usr/bin/prlimit",
            probeShellPath: "/bin/sh",
          },
        ],
      ]),
      observe: async () => [],
      containerPath,
      platform: "darwin",
      arch: "arm64",
      run: async (_command, args) => ({ stdout: args[1] === "version" ? "1.2.0" : "", stderr: "" }),
    });
    const linuxLaunch = await linux.createLaunch({
      profile,
      argv: profile.argvPattern,
      environment: {},
    });
    const appleLaunch = await apple.createLaunch({
      profile,
      argv: profile.argvPattern,
      environment: {},
    });
    expect(
      linuxLaunch.args.slice(
        linuxLaunch.args.indexOf("--bind"),
        linuxLaunch.args.indexOf("--bind") + 3,
      ),
    ).toEqual(["--bind", workspaceRef, "/workspace"]);
    expect(appleLaunch.args).toContain(`type=bind,source=${workspaceRef},target=/workspace`);
    for (const launch of [linuxLaunch, appleLaunch])
      expect(launch.args).not.toContain(path.dirname(workspaceRef));
    expect(await readdir(path.dirname(workspaceRef))).toEqual(["manifest.json", "source"]);
  });

  it("keeps control files outside source and preserves same-named base files", async () => {
    const f = await fixture(true, undefined, {
      ".candidate.patch": "legitimate source patch\n",
      ".candidate-artifact.tar": "legitimate source artifact\n",
    });
    const workspaceRef = await f.adapter.create({
      candidateId: "candidate-control",
      baseRevision: f.revision,
      baseDigest: f.baseDigest,
      allowedPaths: ["allowed.txt"],
      spaceBudgetBytes: 4 * 1024 * 1024,
    });
    await expect(readFile(path.join(workspaceRef, ".himawari-candidate.json"))).rejects.toThrow();
    const artifact = await f.adapter.packageArtifact({
      workspaceRef,
      expiresAt: "2026-09-01T00:00:00.000Z",
      spaceBudgetBytes: 4 * 1024 * 1024,
    });
    const artifactPath = path.join(f.candidateRoot, "fixture-output.tar");
    await writeFile(
      artifactPath,
      f.protectedPayloads.get(artifact.artifactRef) ?? new Uint8Array(),
    );
    const names = (await execFile("tar", ["-tf", artifactPath])).stdout;
    expect(names).toContain("./.candidate.patch");
    expect(names).toContain("./.candidate-artifact.tar");
    expect(names).not.toContain("manifest.json");
    expect(await readFile(path.join(workspaceRef, ".candidate.patch"), "utf8")).toBe(
      "legitimate source patch\n",
    );
    expect(await readFile(path.join(workspaceRef, ".candidate-artifact.tar"), "utf8")).toBe(
      "legitimate source artifact\n",
    );
  });

  it("does not trust a forged source control file and inventories it as an out-of-scope addition", async () => {
    const f = await fixture();
    const workspaceRef = await f.adapter.create({
      candidateId: "candidate-forgery",
      baseRevision: f.revision,
      baseDigest: f.baseDigest,
      allowedPaths: ["allowed.txt"],
      spaceBudgetBytes: 4 * 1024 * 1024,
    });
    await writeFile(
      path.join(workspaceRef, ".himawari-candidate.json"),
      JSON.stringify({ allowedPaths: ["protected.txt"] }),
    );
    await expect(
      f.adapter.packageArtifact({
        workspaceRef,
        expiresAt: "2026-10-01T00:00:00.000Z",
        spaceBudgetBytes: 4 * 1024 * 1024,
      }),
    ).rejects.toThrow("SCOPE");
    expect(f.protectedPayloads.size).toBe(0);
  });

  it("rejects out-of-scope mode changes before publishing an artifact", async () => {
    const f = await fixture();
    const workspaceRef = await f.adapter.create({
      candidateId: "candidate-mode",
      baseRevision: f.revision,
      baseDigest: f.baseDigest,
      allowedPaths: ["allowed.txt"],
      spaceBudgetBytes: 4 * 1024 * 1024,
    });
    await chmod(path.join(workspaceRef, "protected.txt"), 0o755);
    await expect(
      f.adapter.packageArtifact({
        workspaceRef,
        expiresAt: "2026-09-01T00:00:00.000Z",
        spaceBudgetBytes: 4 * 1024 * 1024,
      }),
    ).rejects.toThrow("SCOPE");
    expect(f.protectedPayloads.size).toBe(0);
  });

  it("disposes quarantined resources using the original stable workspace reference", async () => {
    const f = await fixture();
    const workspaceRef = await f.adapter.create({
      candidateId: "candidate-quarantine",
      baseRevision: f.revision,
      baseDigest: f.baseDigest,
      allowedPaths: ["allowed.txt"],
      spaceBudgetBytes: 4 * 1024 * 1024,
    });
    await f.adapter.quarantine(workspaceRef, "fixture-failure");
    await expect(f.adapter.dispose(workspaceRef)).resolves.toBeUndefined();
    await expect(f.adapter.dispose(workspaceRef)).resolves.toBeUndefined();
  });

  it("creates from an exact base, confines the patch, validates and packages without touching base", async () => {
    const f = await fixture();
    const workspaceRef = await f.adapter.create({
      candidateId: "candidate-01",
      baseRevision: f.revision,
      baseDigest: f.baseDigest,
      allowedPaths: ["allowed.txt"],
      spaceBudgetBytes: 4 * 1024 * 1024,
    });
    f.payloads.set(
      "payload:patch",
      new TextEncoder().encode(
        "diff --git a/allowed.txt b/allowed.txt\nindex df967b9..09025f9 100644\n--- a/allowed.txt\n+++ b/allowed.txt\n@@ -1 +1 @@\n-base\n+candidate\n",
      ),
    );
    const patched = await f.adapter.patch({
      workspaceRef,
      patchRef: "payload:patch",
      expectedBaseDigest: f.baseDigest,
      allowedPaths: ["allowed.txt"],
    });
    expect(patched.changedPaths).toEqual(["allowed.txt"]);
    expect(await readFile(path.join(workspaceRef, "allowed.txt"), "utf8")).toBe("candidate\n");
    const profile: CommandProfile = {
      id: "candidate-profile",
      revision: 1,
      workspaceId: workspaceRef,
      argvPattern: ["npm", "test"],
      workdir: workspaceRef,
      environmentNames: [],
      fileScopes: [workspaceRef],
      network: "none",
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      resources: { maxCpuTimeMs: 1_000, maxMemoryBytes: 64 * 1024 * 1024, maxProcesses: 2 },
      sandboxTier: "isolated-high-risk",
      sandboxRuntimeIdentity: "apple-container:1.2.0:fixture",
      scriptDigest: null,
      scriptSource: null,
      authorizationRef: "authorization:candidate",
      expiresAt: "2026-09-01T00:00:00.000Z",
      revokedAt: null,
    };
    expect(await f.adapter.validate({ workspaceRef, profiles: [profile] })).toEqual([
      expect.objectContaining({ profileId: profile.id, outcome: "passed" }),
    ]);
    const artifact = await f.adapter.packageArtifact({
      workspaceRef,
      expiresAt: "2026-09-01T00:00:00.000Z",
      spaceBudgetBytes: 4 * 1024 * 1024,
    });
    expect(artifact.artifactDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(f.protectedPayloads.get(artifact.artifactRef)?.byteLength).toBeGreaterThan(0);
    expect(await readFile(path.join(f.repository, "allowed.txt"), "utf8")).toBe("base\n");
  });

  it("blocks unavailable isolation, base drift and patch scope escape", async () => {
    const unavailable = await fixture(false);
    await expect(
      unavailable.adapter.create({
        candidateId: "candidate-blocked",
        baseRevision: unavailable.revision,
        baseDigest: unavailable.baseDigest,
        allowedPaths: ["allowed.txt"],
        spaceBudgetBytes: 4 * 1024 * 1024,
      }),
    ).rejects.toThrow("CANDIDATE_ISOLATION_NOT_QUALIFIED");

    const f = await fixture();
    await expect(
      f.adapter.create({
        candidateId: "candidate-drift",
        baseRevision: f.revision,
        baseDigest: `sha256:${"0".repeat(64)}`,
        allowedPaths: ["allowed.txt"],
        spaceBudgetBytes: 4 * 1024 * 1024,
      }),
    ).rejects.toThrow("CANDIDATE_BASE_DIGEST_CHANGED");
    const workspaceRef = await f.adapter.create({
      candidateId: "candidate-scope",
      baseRevision: f.revision,
      baseDigest: f.baseDigest,
      allowedPaths: ["allowed.txt"],
      spaceBudgetBytes: 4 * 1024 * 1024,
    });
    f.payloads.set(
      "payload:escape",
      new TextEncoder().encode(
        "diff --git a/protected.txt b/protected.txt\nindex 3af2c85..90d3f5b 100644\n--- a/protected.txt\n+++ b/protected.txt\n@@ -1 +1 @@\n-protected\n+escaped\n",
      ),
    );
    await expect(
      f.adapter.patch({
        workspaceRef,
        patchRef: "payload:escape",
        expectedBaseDigest: f.baseDigest,
        allowedPaths: ["allowed.txt"],
      }),
    ).rejects.toThrow("CANDIDATE_PATCH_SCOPE_ESCAPE");
    expect(await readFile(path.join(workspaceRef, "protected.txt"), "utf8")).toBe("protected\n");
  });

  it("marks validation failed when a command mutates files outside the frozen candidate scope", async () => {
    const f = await fixture(true, async (workspaceRef) => {
      await writeFile(path.join(workspaceRef, "protected.txt"), "validation escape\n");
    });
    const workspaceRef = await f.adapter.create({
      candidateId: "candidate-validation-scope",
      baseRevision: f.revision,
      baseDigest: f.baseDigest,
      allowedPaths: ["allowed.txt"],
      spaceBudgetBytes: 4 * 1024 * 1024,
    });
    const profile: CommandProfile = {
      id: "candidate-profile-scope",
      revision: 1,
      workspaceId: workspaceRef,
      argvPattern: ["npm", "test"],
      workdir: workspaceRef,
      environmentNames: [],
      fileScopes: [workspaceRef],
      network: "none",
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      resources: { maxCpuTimeMs: 1_000, maxMemoryBytes: 64 * 1024 * 1024, maxProcesses: 2 },
      sandboxTier: "isolated-high-risk",
      sandboxRuntimeIdentity: "apple-container:1.2.0:fixture",
      scriptDigest: null,
      scriptSource: null,
      authorizationRef: "authorization:candidate",
      expiresAt: "2026-09-01T00:00:00.000Z",
      revokedAt: null,
    };
    expect(await f.adapter.validate({ workspaceRef, profiles: [profile] })).toEqual([
      expect.objectContaining({ profileId: profile.id, outcome: "failed" }),
    ]);
  });
});
