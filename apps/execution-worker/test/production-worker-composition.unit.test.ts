import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProductConfiguration } from "@himawari-agent/application";
import type { ResourceCeiling } from "@himawari-agent/execution-contracts";
import {
  CAPABILITY_DEPLOYMENT_ERROR_CODES,
  type ExecutionUdsCredential,
} from "@himawari-agent/platform-node";
import { createV02Fixture } from "@himawari-agent/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProductionWorkerComposition,
  PRODUCTION_WORKER_COMPOSITION_ERROR_CODES,
} from "../src/index.js";

const NOW = "2026-09-05T00:00:00.000Z";
const ENDPOINT_DIGEST = `sha256:${"a".repeat(64)}`;
const CREDENTIAL: ExecutionUdsCredential = Object.freeze({
  tokenRef: "worker-credential",
  tokenValue: "0123456789abcdef0123456789abcdef",
});
const CEILING: ResourceCeiling = Object.freeze({
  maxWallTimeMs: 10_000,
  maxCpuTimeMs: 10_000,
  maxMemoryBytes: 64 * 1024 * 1024,
  maxOutputBytes: 16_384,
  maxProgressEvents: 32,
});
const roots: string[] = [];
const FIXTURE_SCOPE = createV02Fixture().scope;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function endpointEntry(qualificationOverrides: Record<string, unknown> = {}) {
  return {
    manifest: {
      manifestVersion: "capability.v2",
      ref: "fixture-endpoint",
      displayName: "Fixture endpoint",
      version: "1.0.0",
      source: { type: "remote_api", locator: "endpoint:fixture" },
      sourceIdentity: "publisher:fixture",
      integrity: ENDPOINT_DIGEST,
      artifact: {
        digest: ENDPOINT_DIGEST,
        signatureStatus: "not_applicable",
        signerRef: null,
        rollbackArtifactRef: null,
      },
      operations: ["invoke"],
      permissionRefs: [],
      isolation: "remote",
      scopes: {
        dataClassifications: ["public"],
        network: [],
        filesystem: [],
        secrets: [],
      },
      cost: { currency: "USD", maxMicrosPerInvocation: 100 },
      health: { status: "healthy", checkedAt: NOW },
      reviewedBy: null,
      reviewedAt: null,
      contractCompatibility: ["capability-conformance.v1"],
      runtime: {
        kind: "remote_api",
        endpointIdentity: "endpoint:fixture",
        protectedReferenceOnly: true,
      },
    },
    qualification: {
      qualificationVersion: "capability-runtime-qualification.v1",
      platform: "linux",
      runtimeIdentity: "node-fetch:endpoint:fixture",
      productionSuitable: true,
      artifactDigest: ENDPOINT_DIGEST,
      enforcement: {
        filesystem: true,
        network: true,
        processes: true,
        secrets: true,
        resourceCeilings: true,
        termination: true,
      },
      reasonCodes: [],
      checkedAt: NOW,
      ...qualificationOverrides,
    },
    binding: {
      kind: "endpoint",
      value: {
        endpointIdentity: "endpoint:fixture",
        artifactDigest: ENDPOINT_DIGEST,
        url: "https://capability.example.test",
        allowedMethods: ["POST"],
        operations: { invoke: { method: "POST", path: "/invoke", secretHeaders: {} } },
        productionSuitable: true,
        allowLoopbackQualification: false,
      },
    },
  };
}

function processEntry() {
  const entry = endpointEntry();
  return {
    ...entry,
    manifest: {
      ...entry.manifest,
      ref: "fixture-process",
      source: { type: "program", locator: "artifact:fixture-process:1.0.0" },
      sourceIdentity: "publisher:fixture",
      integrity: `sha256:${"b".repeat(64)}`,
      artifact: {
        digest: `sha256:${"b".repeat(64)}`,
        signatureStatus: "verified",
        signerRef: "signer:fixture",
        rollbackArtifactRef: null,
      },
      operations: ["execute"],
      isolation: "sandbox",
      runtime: {
        kind: "program",
        argv: ["/bin/fixture"],
        environmentKeys: [],
        workdirRef: "workspace:fixture",
        stdin: "protected_payload",
        stdout: "protected_payload",
        subprocesses: [],
        network: [],
        filesystem: ["workspace:fixture"],
      },
      scopes: {
        dataClassifications: ["public"],
        network: [],
        filesystem: ["workspace:fixture"],
        secrets: [],
      },
    },
    qualification: {
      ...entry.qualification,
      artifactDigest: `sha256:${"b".repeat(64)}`,
      runtimeIdentity: "linux-bubblewrap-0.11.2+prlimit",
    },
    binding: {
      kind: "process" as const,
      value: {
        capabilityRef: "fixture-process",
        capabilityVersion: "1.0.0",
        artifactDigest: `sha256:${"b".repeat(64)}`,
        runtimeRoot: "/opt/himawari/capabilities/fixture-process/1.0.0/root",
        command: "/bin/fixture",
        workdirRef: "workspace:fixture",
        sandboxWorkdir: "/workspace",
        environment: {},
        availableExecutables: ["/bin/fixture"],
        resourceLimitExecutable: {
          sandboxPath: "/bin/prlimit",
          sha256: `sha256:${"c".repeat(64)}`,
        },
        filesystem: [
          {
            scopeRef: "workspace:fixture",
            hostPath: "/var/lib/himawari/workspace",
            sandboxPath: "/workspace",
            access: "read_write" as const,
          },
        ],
        maximumResourceCeiling: CEILING,
        mcpServerIdentity: null,
        mcpServerName: null,
        mcpServerVersion: null,
        mcpOperationMap: {},
      },
    },
  };
}

async function snapshot(
  root: string,
  capabilities: readonly unknown[] = [endpointEntry()],
): Promise<{ readonly snapshotPath: string; readonly sha256: string }> {
  const snapshotPath = path.join(root, "runtime", "capability-deployment.json");
  await mkdir(path.dirname(snapshotPath), { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(
    JSON.stringify({ schemaVersion: "capability-deployment.v1", capabilities }),
    "utf8",
  );
  await writeFile(snapshotPath, bytes, { mode: 0o600 });
  return Object.freeze({
    snapshotPath,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  });
}

function configuration(
  root: string,
  deployment: { readonly snapshotPath: string; readonly sha256: string } | undefined,
): ProductConfiguration {
  const base: ProductConfiguration = {
    schemaVersion: "himawari.configuration.v1",
    deploymentId: FIXTURE_SCOPE.authority.deploymentId,
    ownerId: FIXTURE_SCOPE.ownerId,
    agentId: FIXTURE_SCOPE.agentId,
    stateRoot: root,
    runtimeDirectory: path.join(root, "runtime"),
    cacheDirectory: path.join(root, "cache"),
    publicOrigin: "http://127.0.0.1",
    publicMode: false,
    modelDescriptors: [],
    memory: {
      adapter: "mem0-oss" as const,
      version: "fixture",
      storagePath: path.join(root, "data", "memory"),
      dimensions: 1,
    },
    repositoryAllowlistRefs: [],
    secretReferences: [],
    budgets: {
      globalCostMicros: 0,
      perRunCostMicros: 0,
      perClassificationCostMicros: { public: 0, private: 0, sensitive: 0, restricted: 0 },
    },
    concurrency: { totalRuns: 1, foregroundReserved: 0, perCategory: {} },
    deadlines: { runMs: 10_000, workerRequestMs: 1_000, providerRequestMs: 1_000 },
    loadedAt: NOW,
  };
  return Object.freeze(
    deployment === undefined ? base : { ...base, capabilityDeployment: deployment },
  );
}

describe("production Worker composition", () => {
  it("requires a signed deployment and keeps readiness closed until Agent UDS handshakes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "himawari-worker-composition-"));
    roots.push(root);
    const deployment = await snapshot(root);
    const composition = await createProductionWorkerComposition({
      configuration: configuration(root, deployment),
      credential: CREDENTIAL,
      authority: { authorityEpoch: 2, fencingToken: 3 },
      agentServiceBootId: "agent-service-boot:composition",
      platform: "linux",
      clock: { now: () => NOW },
      nextId: (scope) => `${scope}:composition`,
      admissionSocketPath: path.join(root, "runtime", "missing-admission.sock"),
      payloadSocketPath: path.join(root, "runtime", "missing-payload.sock"),
    });

    expect(composition.deployment.manifests).toHaveLength(1);
    expect(composition.readiness()).toEqual({
      live: true,
      ready: false,
      reasonCodes: [PRODUCTION_WORKER_COMPOSITION_ERROR_CODES.AGENT_SERVICES_UNAVAILABLE],
    });
    await expect(composition.connectAgentServices()).rejects.toMatchObject({
      code: PRODUCTION_WORKER_COMPOSITION_ERROR_CODES.AGENT_SERVICES_UNAVAILABLE,
    });
    expect(composition.readiness().ready).toBe(false);
    const disconnectPayload = vi.spyOn(composition.payloads, "disconnect");
    const disconnectAdmission = vi.spyOn(composition.admission, "disconnect");
    const shutdown = composition.worker.shutdown.bind(composition.worker);
    vi.spyOn(composition.worker, "shutdown").mockImplementation(async () => {
      expect(disconnectPayload).not.toHaveBeenCalled();
      expect(disconnectAdmission).not.toHaveBeenCalled();
      await shutdown();
    });
    await composition.close();
    expect(disconnectPayload).toHaveBeenCalledOnce();
    expect(disconnectAdmission).toHaveBeenCalledOnce();
    expect(composition.readiness()).toEqual({
      live: false,
      ready: false,
      reasonCodes: [PRODUCTION_WORKER_COMPOSITION_ERROR_CODES.SHUTDOWN],
    });
  });

  it("rejects missing deployment and static qualification drift before creating a Worker", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "himawari-worker-composition-errors-"));
    roots.push(root);
    await expect(
      createProductionWorkerComposition({
        configuration: configuration(root, undefined),
        credential: CREDENTIAL,
        authority: { authorityEpoch: 2, fencingToken: 3 },
        agentServiceBootId: "agent-service-boot:composition",
        platform: "linux",
        clock: { now: () => NOW },
      }),
    ).rejects.toMatchObject({
      code: PRODUCTION_WORKER_COMPOSITION_ERROR_CODES.CAPABILITY_DEPLOYMENT_REQUIRED,
    });

    const deployment = await snapshot(root, [
      endpointEntry({ runtimeIdentity: "fixture-qualifier:v1" }),
    ]);
    await expect(
      createProductionWorkerComposition({
        configuration: configuration(root, deployment),
        credential: CREDENTIAL,
        authority: { authorityEpoch: 2, fencingToken: 3 },
        agentServiceBootId: "agent-service-boot:composition",
        platform: "linux",
        clock: { now: () => NOW },
      }),
    ).rejects.toMatchObject({
      code: PRODUCTION_WORKER_COMPOSITION_ERROR_CODES.QUALIFICATION_MISMATCH,
    });
  });

  it("requires host isolation for every Linux process capability", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "himawari-worker-composition-process-"));
    roots.push(root);
    const deployment = await snapshot(root, [processEntry()]);
    await expect(
      createProductionWorkerComposition({
        configuration: configuration(root, deployment),
        credential: CREDENTIAL,
        authority: { authorityEpoch: 2, fencingToken: 3 },
        agentServiceBootId: "agent-service-boot:composition",
        platform: "linux",
        clock: { now: () => NOW },
      }),
    ).rejects.toMatchObject({
      code: PRODUCTION_WORKER_COMPOSITION_ERROR_CODES.HOST_ISOLATION_BINDING_REQUIRED,
    });
  });

  it("checks an SRT program host without requiring a legacy process binding", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "himawari-worker-composition-srt-"));
    roots.push(root);
    const entry = processEntry();
    const deployment = await snapshot(root, [
      {
        ...entry,
        binding: {
          kind: "sandbox",
          value: {
            schemaVersion: "sandbox-host-binding.v1",
            capabilityRef: entry.manifest.ref,
            capabilityVersion: entry.manifest.version,
            artifactDigest: entry.manifest.integrity,
            hostId: "host:fixture",
            profileRef: "host-readonly.v1",
            runtimeRoot: "/opt/runtime",
            runtimeDigest: "d".repeat(64),
            executable: { path: "/usr/bin/node", sha256: "a".repeat(64) },
            runner: { path: "/opt/runtime/runner.js", sha256: "e".repeat(64) },
            privateRoot: "/var/private-jobs",
            roots: [
              {
                canonicalRootId: "root:fixture",
                canonicalPath: "/work/project",
                device: "1",
                inode: "2",
              },
            ],
            readOnlyToolchainPaths: ["/usr/bin"],
            protectedPaths: [],
            allowedDomains: [],
            maximumResourceCeiling: CEILING,
          },
        },
        qualification: {
          ...entry.qualification,
          runtimeIdentity: "srt:0.0.75",
          enforcement: { ...entry.qualification.enforcement, resourceCeilings: false },
          sandbox: {
            schemaVersion: "sandbox-runtime-qualification.v1",
            qualificationRef: "qualification:fixture",
            hostId: "host:fixture",
            profileRef: "host-readonly.v1",
            srtVersion: "0.0.75",
            platform: "linux",
            architecture: "x64",
            osRelease: "deliberately-unqualified-kernel",
            runtimeDigest: "d".repeat(64),
            runnerDigest: "e".repeat(64),
            evidenceDigest: "f".repeat(64),
            resourceMode: "observe_and_stop",
            terminationMode: "verified_tree",
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
              "task_tree_termination",
              "worker_crash_cleanup",
            ],
            limitations: [],
          },
        },
      },
    ]);
    // The real host verifier must still reject the deliberately mismatched host.
    await expect(
      createProductionWorkerComposition({
        configuration: configuration(root, deployment),
        credential: CREDENTIAL,
        authority: { authorityEpoch: 2, fencingToken: 3 },
        agentServiceBootId: "agent-service-boot:composition",
        platform: "linux",
        clock: { now: () => NOW },
      }),
    ).rejects.toThrow("SANDBOX_HOST_QUALIFICATION_CHANGED");
  });

  it("does not turn an empty signed registry into a ready Worker", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "himawari-worker-composition-empty-"));
    roots.push(root);
    const deployment = await snapshot(root, []);
    await expect(
      createProductionWorkerComposition({
        configuration: configuration(root, deployment),
        credential: CREDENTIAL,
        authority: { authorityEpoch: 2, fencingToken: 3 },
        agentServiceBootId: "agent-service-boot:composition",
        platform: "linux",
        clock: { now: () => NOW },
      }),
    ).rejects.toMatchObject({ code: CAPABILITY_DEPLOYMENT_ERROR_CODES.EMPTY });
  });
});
