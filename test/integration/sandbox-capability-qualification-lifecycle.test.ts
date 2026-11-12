import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CapabilityLifecycleService } from "@himawari-agent/application";
import { SANDBOX_RUNTIME_VERSION } from "@himawari-agent/execution-contracts";
import { loadCapabilityDeploymentSnapshot } from "@himawari-agent/platform-node";
import { InMemoryCapabilityRegistryStore, ManualClock } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";

type Json = Record<string, unknown>;

const PLATFORM = process.platform === "darwin" ? "darwin" : "linux";
const HOST = "host:qualification-lifecycle";
const REF = "sandbox-qualification-lifecycle";
const RUNNER = "c".repeat(64);
const NOW = "2026-11-12T00:00:00.000Z";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function entry(): Json {
  const digest = `sha256:${RUNNER}`;
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
    version: "1.0.0",
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
        runnerDigest: RUNNER,
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
        capabilityVersion: "1.0.0",
        artifactDigest: digest,
        hostId: HOST,
        profileRef: "host-readonly.v1",
        runtimeRoot,
        runtimeDigest: "d".repeat(64),
        executable: { path: executable, sha256: "a".repeat(64) },
        runner: { path: runnerPath, sha256: RUNNER },
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

async function loadSnapshot(change?: (value: Json) => void) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "himawari-qualify-lifecycle-")));
  roots.push(root);
  const capability = entry();
  change?.(capability);
  const bytes = Buffer.from(
    JSON.stringify({ schemaVersion: "capability-deployment.v1", capabilities: [capability] }),
  );
  const snapshotPath = path.join(root, "capabilities.json");
  await writeFile(snapshotPath, bytes, { mode: 0o600 });
  return loadCapabilityDeploymentSnapshot({
    snapshotPath,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    now: () => NOW,
  });
}

function lifecycleFor(deployment: Awaited<ReturnType<typeof loadSnapshot>>) {
  const clock = new ManualClock(NOW);
  const store = new InMemoryCapabilityRegistryStore();
  const lifecycle = new CapabilityLifecycleService({
    store,
    clock,
    artifacts: {
      verify: async (candidate) => ({
        verificationVersion: "capability-artifact-verification.v1",
        artifactDigest: candidate.integrity,
        signatureStatus: candidate.artifact.signatureStatus,
        signerRef: candidate.artifact.signerRef,
        verified: true,
        reasonCodes: [],
        verifiedAt: NOW,
      }),
    },
    runtime: {
      qualify: async (candidate) => {
        const found = deployment.snapshot.capabilities.find(
          (item) => item.manifest.ref === candidate.ref,
        );
        if (!found) throw new Error("capability missing from snapshot");
        return found.qualification;
      },
    },
  });
  return lifecycle;
}

async function approveInstall(lifecycle: CapabilityLifecycleService, manifest: never) {
  await lifecycle.discover(manifest);
  await lifecycle.reviewRequired(REF);
  await lifecycle.recordSourceReview(REF, { reviewer: "owner:lifecycle", reviewedAt: NOW });
  await lifecycle.approveInstallation(REF, "approval-install-lifecycle");
}

describe("sandbox capability qualification through the lifecycle service", () => {
  it("activates a capability whose sandbox evidence honestly reports no kernel resource ceiling", async () => {
    const deployment = await loadSnapshot();
    const [manifest] = deployment.manifests;
    if (!manifest) throw new Error("snapshot has no capability");
    expect(deployment.snapshot.capabilities[0]?.qualification.enforcement.resourceCeilings).toBe(
      false,
    );
    const lifecycle = lifecycleFor(deployment);
    await approveInstall(lifecycle, manifest as never);
    const active = await lifecycle.activate(REF);
    expect(active.lifecycle).toBe("active");
    expect(active.runtimeQualification?.sandbox?.resourceMode).toBe("observe_and_stop");
  });

  it("rejects sandbox evidence when a filesystem, network, process or secret control is not enforced", async () => {
    for (const control of ["filesystem", "network", "processes", "secrets"] as const) {
      const deployment = await loadSnapshot();
      const [manifest] = deployment.manifests;
      if (!manifest) throw new Error("snapshot has no capability");
      const lifecycle = lifecycleFor({
        ...deployment,
        snapshot: {
          ...deployment.snapshot,
          capabilities: deployment.snapshot.capabilities.map((item) => ({
            ...item,
            qualification: {
              ...item.qualification,
              enforcement: { ...item.qualification.enforcement, [control]: false },
            },
          })),
        },
      });
      await approveInstall(lifecycle, manifest as never);
      await expect(lifecycle.activate(REF)).rejects.toThrow("runtime qualification failed");
    }
  });

  it("rejects a sandbox qualification that claims a kernel resource ceiling the evidence does not give", async () => {
    const deployment = await loadSnapshot();
    const [manifest] = deployment.manifests;
    if (!manifest) throw new Error("snapshot has no capability");
    const lifecycle = lifecycleFor({
      ...deployment,
      snapshot: {
        ...deployment.snapshot,
        capabilities: deployment.snapshot.capabilities.map((item) => ({
          ...item,
          qualification: {
            ...item.qualification,
            enforcement: { ...item.qualification.enforcement, resourceCeilings: true },
          },
        })),
      },
    });
    await approveInstall(lifecycle, manifest as never);
    await expect(lifecycle.activate(REF)).rejects.toThrow("runtime qualification failed");
  });
});
