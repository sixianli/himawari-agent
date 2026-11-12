import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CapabilityLifecycleService,
  type CapabilityRuntimeQualification,
} from "@himawari-agent/application";
import { SANDBOX_RUNTIME_VERSION } from "@himawari-agent/execution-contracts";
import { loadCapabilityDeploymentSnapshot } from "@himawari-agent/platform-node";
import { InMemoryCapabilityRegistryStore, ManualClock } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";

type Json = Record<string, unknown>;

const PLATFORM = process.platform === "darwin" ? "darwin" : "linux";
const HOST = "host:qualification-lifecycle";
const REF = "sandbox-qualification-lifecycle";
const RUNNER = "c".repeat(64);
const NEXT_RUNNER = "e".repeat(64);
const NOW = "2026-11-12T00:00:00.000Z";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function entry(version: string, runner: string): Json {
  const digest = `sha256:${runner}`;
  const runtimeRoot = "/opt/himawari/releases/first/capabilities";
  const executable = `${runtimeRoot}/node/bin/node`;
  const runnerPath = `${runtimeRoot}/runners/${REF}.mjs`;
  const ceiling = {
    maxWallTimeMs: 10_000,
    maxCpuTimeMs: 10_000,
    maxMemoryBytes: 64 * 1024 * 1024,
    maxOutputBytes: 16_384,
    maxProgressEvents: 32,
  };
  const manifest: Json = {
    manifestVersion: "capability.v2",
    ref: REF,
    displayName: "Sandbox qualification lifecycle",
    version,
    source: { type: "program", locator: `artifact:${REF}` },
    sourceIdentity: "publisher:himawari",
    integrity: digest,
    artifact: {
      digest,
      signatureStatus: "verified",
      signerRef: "signer:host-qualification",
      rollbackArtifactRef: null,
    },
    operations: ["execute"],
    permissionRefs: [],
    isolation: "sandbox",
    scopes: {
      dataClassifications: ["private"],
      network: [],
      filesystem: ["workspace:lifecycle"],
      secrets: [],
    },
    cost: { currency: "USD", maxMicrosPerInvocation: 0 },
    health: { status: "healthy", checkedAt: NOW },
    reviewedBy: "owner:lifecycle",
    reviewedAt: NOW,
    contractCompatibility: ["capability-conformance.v1"],
    runtime: {
      kind: "program",
      argv: [executable, runnerPath, HOST, "worker-lifecycle"],
      environmentKeys: [],
      workdirRef: "workspace:lifecycle",
      stdin: "protected_payload",
      stdout: "protected_payload",
      subprocesses: [],
      network: [],
      filesystem: ["workspace:lifecycle"],
    },
  };
  return {
    manifest,
    qualification: {
      qualificationVersion: "capability-runtime-qualification.v1",
      platform: PLATFORM,
      runtimeIdentity: `srt:${SANDBOX_RUNTIME_VERSION}`,
      productionSuitable: true,
      artifactDigest: digest,
      enforcement: {
        filesystem: true,
        network: true,
        processes: true,
        secrets: true,
        resourceCeilings: false,
        termination: PLATFORM === "linux",
      },
      reasonCodes: [],
      checkedAt: NOW,
      sandbox: {
        schemaVersion: "sandbox-runtime-qualification.v1",
        qualificationRef: "qualification:lifecycle",
        hostId: HOST,
        profileRef: "host-readonly.v1",
        srtVersion: SANDBOX_RUNTIME_VERSION,
        platform: PLATFORM,
        architecture: PLATFORM === "darwin" ? "arm64" : "x64",
        osRelease: "27.0.0",
        runtimeDigest: "d".repeat(64),
        runnerDigest: runner,
        evidenceDigest: "f".repeat(64),
        resourceMode: "observe_and_stop",
        terminationMode: PLATFORM === "darwin" ? "best_effort" : "verified_tree",
        guarantees: [
          "filesystem_default_deny",
          "network_allowlist",
          "clean_environment",
          "bounded_output",
          "wall_clock_stop",
          "resource_observation",
          "durable_start_admission",
          "unknown_quarantine",
          "restart_reconciliation",
          ...(PLATFORM === "darwin"
            ? ["best_effort_stop"]
            : ["task_tree_termination", "worker_crash_cleanup"]),
        ],
        limitations: PLATFORM === "darwin" ? ["detached_descendants_may_survive_stop"] : [],
      },
    },
    binding: {
      kind: "sandbox",
      value: {
        schemaVersion: "sandbox-host-binding.v1",
        capabilityRef: REF,
        capabilityVersion: version,
        artifactDigest: digest,
        hostId: HOST,
        profileRef: "host-readonly.v1",
        runtimeRoot,
        runtimeDigest: "d".repeat(64),
        executable: { path: executable, sha256: "a".repeat(64) },
        runner: { path: runnerPath, sha256: runner },
        privateRoot: "/var/private-jobs",
        roots: [
          {
            canonicalRootId: "root:lifecycle",
            canonicalPath: "/work/project",
            device: "1",
            inode: "2",
          },
        ],
        readOnlyToolchainPaths: ["/usr/bin"],
        protectedPaths: [],
        allowedDomains: [],
        maximumResourceCeiling: ceiling,
      },
    },
  };
}

async function loadSnapshot(version = "1.0.0", runner = RUNNER) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "himawari-qualify-lifecycle-")));
  roots.push(root);
  const bytes = Buffer.from(
    JSON.stringify({
      schemaVersion: "capability-deployment.v1",
      capabilities: [entry(version, runner)],
    }),
  );
  const snapshotPath = path.join(root, "capabilities.json");
  await writeFile(snapshotPath, bytes, { mode: 0o600 });
  const deployment = await loadCapabilityDeploymentSnapshot({
    snapshotPath,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    now: () => NOW,
  });
  const [capability] = deployment.snapshot.capabilities;
  if (!capability) throw new Error("snapshot has no capability");
  return capability;
}

type Loaded = Awaited<ReturnType<typeof loadSnapshot>>;
type Change = (qualification: CapabilityRuntimeQualification) => CapabilityRuntimeQualification;

function lifecycleFor(loaded: readonly Loaded[], change: Change = (value) => value) {
  return new CapabilityLifecycleService({
    store: new InMemoryCapabilityRegistryStore(),
    clock: new ManualClock(NOW),
    artifacts: {
      verify: async (candidate) => {
        const known = loaded.some((item) => item.manifest.integrity === candidate.integrity);
        return {
          verificationVersion: "capability-artifact-verification.v1",
          artifactDigest: candidate.integrity,
          signatureStatus: candidate.artifact.signatureStatus,
          signerRef: candidate.artifact.signerRef,
          verified: known,
          reasonCodes: known ? [] : ["CAPABILITY_ARTIFACT_DIGEST_MISMATCH"],
          verifiedAt: NOW,
        };
      },
    },
    runtime: {
      qualify: async (candidate) => {
        const found = loaded.find((item) => item.manifest.integrity === candidate.integrity);
        if (!found) throw new Error("capability missing from snapshot");
        return change(found.qualification);
      },
    },
  });
}

async function approveInstall(lifecycle: CapabilityLifecycleService, loaded: Loaded) {
  await lifecycle.discover(loaded.manifest);
  await lifecycle.reviewRequired(REF);
  await lifecycle.recordSourceReview(REF, { reviewer: "owner:lifecycle", reviewedAt: NOW });
  await lifecycle.approveInstallation(REF, "approval-install-lifecycle");
}

async function rejected(change: Change, manifest: Partial<Loaded["manifest"]> = {}) {
  const snapshot = await loadSnapshot();
  const loaded = { ...snapshot, manifest: { ...snapshot.manifest, ...manifest } };
  const lifecycle = lifecycleFor([loaded], change);
  await approveInstall(lifecycle, loaded);
  await expect(lifecycle.activate(REF)).rejects.toThrow("runtime qualification failed");
}

describe("sandbox capability qualification through the lifecycle service", () => {
  it("activates a capability whose sandbox evidence honestly reports no kernel resource ceiling", async () => {
    const loaded = await loadSnapshot();
    expect(loaded.qualification.enforcement.resourceCeilings).toBe(false);
    const lifecycle = lifecycleFor([loaded]);
    await approveInstall(lifecycle, loaded);
    const active = await lifecycle.activate(REF);
    expect(active.lifecycle).toBe("active");
    expect(active.runtimeQualification?.sandbox?.resourceMode).toBe("observe_and_stop");
  });

  it("activates an approved update and rolls it back with sandbox evidence", async () => {
    const first = await loadSnapshot();
    const next = await loadSnapshot("1.0.1", NEXT_RUNNER);
    const lifecycle = lifecycleFor([first, next]);
    await approveInstall(lifecycle, first);
    await lifecycle.activate(REF);
    const proposed = await lifecycle.proposeUpdate(REF, next.manifest, {
      policyRef: "owner-policy-update",
      allowAutomaticCompatibleUpdates: true,
    });
    if (proposed.lifecycle === "update_proposed")
      await lifecycle.approveUpdate(REF, "approval-update-lifecycle");
    const updated = await lifecycle.activateUpdate(REF);
    expect(updated).toMatchObject({
      lifecycle: "active",
      declaration: { version: "1.0.1" },
      runtimeQualification: { artifactDigest: next.manifest.integrity },
    });
    const rolledBack = await lifecycle.rollback(REF);
    expect(rolledBack).toMatchObject({
      lifecycle: "active",
      declaration: { version: "1.0.0" },
      runtimeQualification: { artifactDigest: first.manifest.integrity },
    });
  });

  it("refuses an update whose sandbox qualification claims a kernel resource ceiling", async () => {
    const first = await loadSnapshot();
    const next = await loadSnapshot("1.0.1", NEXT_RUNNER);
    const lifecycle = lifecycleFor([first, next], (value) =>
      value.artifactDigest === next.manifest.integrity
        ? { ...value, enforcement: { ...value.enforcement, resourceCeilings: true } }
        : value,
    );
    await approveInstall(lifecycle, first);
    await lifecycle.activate(REF);
    const proposed = await lifecycle.proposeUpdate(REF, next.manifest, {
      policyRef: "owner-policy-update",
      allowAutomaticCompatibleUpdates: true,
    });
    if (proposed.lifecycle === "update_proposed")
      await lifecycle.approveUpdate(REF, "approval-update-lifecycle");
    await expect(lifecycle.activateUpdate(REF)).rejects.toThrow("runtime qualification failed");
  });

  it.each(["filesystem", "network", "processes", "secrets"] as const)(
    "rejects sandbox evidence when %s is not enforced",
    async (control) => {
      await rejected((value) => ({
        ...value,
        enforcement: { ...value.enforcement, [control]: false },
      }));
    },
  );

  it("rejects a sandbox qualification that claims a kernel resource ceiling the evidence does not give", async () => {
    await rejected((value) => ({
      ...value,
      enforcement: { ...value.enforcement, resourceCeilings: true },
    }));
  });

  it("rejects a sandbox qualification whose termination claim contradicts its evidence", async () => {
    await rejected((value) => ({
      ...value,
      enforcement: { ...value.enforcement, termination: !value.enforcement.termination },
    }));
  });

  it("rejects sandbox evidence for another platform or another runtime identity", async () => {
    await rejected((value) => ({
      ...value,
      platform: value.platform === "linux" ? "darwin" : "linux",
    }));
    await rejected((value) => ({
      ...value,
      runtimeIdentity: `srt:${SANDBOX_RUNTIME_VERSION}-other`,
    }));
  });

  it("rejects sandbox evidence that the sandbox qualification contract does not accept", async () => {
    await rejected((value) => {
      if (!value.sandbox) throw new Error("snapshot has no sandbox evidence");
      return { ...value, sandbox: { ...value.sandbox, guarantees: [] } };
    });
  });

  it("rejects a null sandbox field and sandbox evidence on a manifest that is not a program", async () => {
    await rejected((value) => ({
      ...value,
      sandbox: null as never,
      enforcement: { ...value.enforcement, resourceCeilings: true, termination: true },
    }));
    const mcp = { kind: "mcp", serverIdentity: "mcp:lifecycle", transport: "stdio:v1" } as const;
    await rejected((value) => value, {
      source: { type: "mcp", locator: `mcp:${REF}` },
      runtime: { ...mcp, mappedResources: ["tool:echo"] },
    });
  });

  it("still requires every control when a qualification carries no sandbox evidence", async () => {
    await rejected(({ sandbox: _sandbox, ...value }) => value);
    const loaded = await loadSnapshot();
    const lifecycle = lifecycleFor([loaded], ({ sandbox: _sandbox, ...value }) => ({
      ...value,
      enforcement: { ...value.enforcement, resourceCeilings: true, termination: true },
    }));
    await approveInstall(lifecycle, loaded);
    await expect(lifecycle.activate(REF)).resolves.toMatchObject({ lifecycle: "active" });
  });
});
