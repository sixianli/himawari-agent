import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExecutionWorkerEvent, ProductConfiguration } from "@himawari-agent/application";
import type { ExecuteWorkRequest, ResourceCeiling } from "@himawari-agent/execution-contracts";
import {
  CAPABILITY_DEPLOYMENT_ERROR_CODES,
  ExecutionAdmissionUdsServer,
  type ExecutionUdsCredential,
  PayloadUdsServer,
} from "@himawari-agent/platform-node";
import { createV02Fixture } from "@himawari-agent/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { udsFaultProxy } from "@himawari-agent/testing";
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

function composedInvocation(
  composition: Awaited<ReturnType<typeof createProductionWorkerComposition>>,
  id = "composition",
) {
  const deadline = "2026-09-05T00:00:10.000Z";
  composition.delegations.accept({
    handleVersion: "capability-handle.v2",
    ref: `handle:${id}`,
    revision: 1,
    authorityFence: 3,
    ownerId: FIXTURE_SCOPE.ownerId,
    agentId: FIXTURE_SCOPE.agentId,
    runId: FIXTURE_SCOPE.runId,
    capabilityRef: "fixture-endpoint",
    capabilityVersion: "1.0.0",
    authorizationType: "grant",
    authorizationRef: "grant:composition",
    operations: ["invoke"],
    inputRefs: ["payload:composition-input"],
    delegatedContextRefs: [],
    secretRefs: [],
    maxDataClassification: "public",
    issuedAt: NOW,
    expiresAt: deadline,
    revokedAt: null,
    operation: "invoke",
    maxUses: 1,
    uses: 0,
    maxTotalCostMicros: 100,
    spentCostMicros: 0,
    idempotencyKeys: [],
    workerEndedAt: null,
  });
  const request: ExecuteWorkRequest = {
    schemaVersion: "execution.v1",
    kind: "request",
    type: "work.execute",
    messageId: `invocation:${id}`,
    correlationId: `invocation:${id}`,
    causationId: "delegation:composition",
    dataClassification: "public",
    scope: {
      ownerId: FIXTURE_SCOPE.ownerId,
      agentId: FIXTURE_SCOPE.agentId,
      runId: FIXTURE_SCOPE.runId,
      workerRunId: "worker-run:composition",
    },
    idempotencyKey: `invocation:${id}`,
    payload: {
      capabilityId: "fixture-endpoint",
      capabilityVersion: "1.0.0",
      operation: "invoke",
      inputRef: "payload:composition-input",
      capabilityHandleRef: `handle:${id}`,
      delegatedContextRefs: [],
      secretRefs: [],
      requestedAt: NOW,
      deadlineAt: deadline,
    },
  };
  return request;
}

describe("production Worker composition", () => {
  it.each(["next-call", "readiness", "rejected", "closed", "shutdown-cleanup"] as const)(
    "runs the next invocation in the same Worker after a non-preparation Payload disconnect: %s",
    async (mode) => {
      const root = await mkdtemp("/tmp/h-f-worker-");
      roots.push(root);
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("{}"));
      const composition = await createProductionWorkerComposition({
        configuration: configuration(root, await snapshot(root)),
        credential: CREDENTIAL,
        authority: { authorityEpoch: 2, fencingToken: 3 },
        agentServiceBootId: "agent-service-boot:composition",
        platform: "linux",
        clock: { now: () => NOW },
        fetch,
        payloadSocketPath: path.join(root, "runtime", "proxy.sock"),
      });
      let sequence = 0;
      const peer = composition.peerBinding;
      const payloads = new PayloadUdsServer({
        runtimeDirectory: path.join(root, "runtime"),
        credential: CREDENTIAL,
        agentServiceInstanceId: peer.agentServiceInstanceId,
        agentServiceBootId: peer.agentServiceBootId,
        allowedWorkerIdentities: [
          { workerInstanceId: peer.workerInstanceId, workerBootId: peer.workerBootId },
        ],
        authorityEpoch: peer.authorityEpoch,
        fencingToken: peer.fencingToken,
        maximumBodyBytes: 65536,
        maximumPayloadBytes: 16384,
        requestTimeoutMs: 1000,
        handler: {
          validateInvocation: async () => {},
          readInput: async () => Buffer.from("{}"),
          writeOutput: async (message) => ({
            outputRef: `output:${message.payload.invocationId}`,
            replayed: false,
          }),
        },
      });
      const admission = new ExecutionAdmissionUdsServer({
        runtimeDirectory: path.join(root, "runtime"),
        credential: CREDENTIAL,
        trustedPeerBinding: () => peer,
        maximumBodyBytes: 65536,
        requestTimeoutMs: 1000,
        now: () => NOW,
        nextId: () => `admission:${++sequence}`,
        handler: {
          admit: async () => {
            throw new Error("Unexpected subtask admission");
          },
        },
      });
      await payloads.start();
      await admission.start();
      const proxy = await udsFaultProxy(
        path.join(root, "runtime", "proxy.sock"),
        payloads.socketPath,
      );
      try {
        await composition.connectAgentServices();
        const boot = composition.peerBinding.workerBootId;
        proxy.dropNext("/payload/v1/output/write");
        const run = async (id: string) => {
          const events: ExecutionWorkerEvent[] = [];
          for await (const event of composition.service.execute(
            composedInvocation(composition, id),
            CEILING,
          ))
            events.push(event);
          return events;
        };
        await expect(run("first")).resolves.toMatchObject([
          { type: "work.result", payload: { outcome: "result_unknown", outputRef: null } },
        ]);
        if (mode !== "next-call") proxy.blockHandshakes(mode === "rejected");
        expect.soft(composition.readiness().ready).toBe(false);
        if (mode !== "next-call") {
          await vi.waitFor(() =>
            expect(proxy.requests.filter((p) => p.endsWith("/handshake"))).toHaveLength(2),
          );
          const recovery = composition.connectAgentServices().then(
            () => "connected",
            (error: unknown) => error,
          );
          expect(composition.readiness().ready).toBe(false);
          expect(composition.readiness().ready).toBe(false);
          let closing: Promise<unknown> | undefined;
          if (mode === "shutdown-cleanup") {
            const disconnect = vi.spyOn(composition.payloads, "disconnect");
            const shutdown = composition.worker.shutdown.bind(composition.worker);
            vi.spyOn(composition.worker, "shutdown").mockImplementationOnce(async () => {
              expect(composition.readiness()).toMatchObject({ live: false, ready: false });
              const identity = { handleRef: "handle:first", invocationId: "invocation:first" };
              await composition.payloads.assertCurrent(identity);
              expect(disconnect).not.toHaveBeenCalled();
              await composition.payloads.assertCurrent(identity);
              await shutdown();
            });
            closing = composition.close().then(
              () => null,
              (error: unknown) => error,
            );
          }
          if (mode === "closed") await composition.close();
          proxy.releaseHandshakes();
          const recovered = await recovery;
          if (mode === "closed" || mode === "shutdown-cleanup") {
            if (closing) await expect(closing).resolves.toBeNull();
            expect(recovered).toMatchObject({
              code: PRODUCTION_WORKER_COMPOSITION_ERROR_CODES.SHUTDOWN,
            });
            expect(composition.readiness()).toMatchObject({ live: false, ready: false });
            expect(composition.payloads.isReady()).toBe(false);
            expect(composition.admission.isReady()).toBe(false);
            expect(fetch).toHaveBeenCalledOnce();
            expect(proxy.requests.filter((p) => p === "/payload/v1/output/write")).toHaveLength(1);
            return;
          }
          if (mode === "rejected") {
            expect(recovered).toMatchObject({
              code: PRODUCTION_WORKER_COMPOSITION_ERROR_CODES.AGENT_SERVICES_UNAVAILABLE,
            });
            expect(composition.payloads.isReady()).toBe(false);
            expect(composition.admission.isReady()).toBe(false);
            proxy.blockHandshakes();
            proxy.releaseHandshakes();
          } else expect(recovered).toBe("connected");
          await vi.waitFor(() => expect(composition.readiness().ready).toBe(true));
          expect(proxy.requests.filter((p) => p.endsWith("/handshake"))).toHaveLength(
            mode === "rejected" ? 3 : 2,
          );
        }
        await expect(run("second")).resolves.toMatchObject([
          {
            type: "work.result",
            payload: { outcome: "succeeded", outputRef: "output:invocation:second" },
          },
        ]);
        expect(composition.peerBinding.workerBootId).toBe(boot);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(proxy.requests.filter((p) => p === "/payload/v1/output/write")).toHaveLength(2);
        await composition.connectAgentServices();
        expect(composition.readiness().ready).toBe(true);
      } finally {
        await composition.close();
        await proxy.close();
        await admission.stop();
        await payloads.stop();
      }
    },
  );

  it.each(["active", "revoked"])(
    "checks admitted delegated authority through production composition: %s",
    async (mode) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "himawari-worker-authority-"));
      roots.push(root);
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("{}"));
      const composition = await createProductionWorkerComposition({
        configuration: configuration(root, await snapshot(root)),
        credential: CREDENTIAL,
        authority: { authorityEpoch: 2, fencingToken: 3 },
        agentServiceBootId: "agent-service-boot:composition",
        platform: "linux",
        clock: { now: () => NOW },
        fetch,
      });
      const authority = vi.spyOn(composition.payloads, "assertCurrent").mockResolvedValue();
      vi.spyOn(composition.payloads, "readInput").mockResolvedValue(new TextEncoder().encode("{}"));
      vi.spyOn(composition.payloads, "writeOutput").mockResolvedValue("payload:composition-output");
      const request = composedInvocation(composition);
      try {
        const events: ExecutionWorkerEvent[] = [];
        const execute = async () => {
          for await (const event of composition.service.execute(request, CEILING))
            events.push(event);
        };
        if (mode === "revoked") {
          authority.mockRejectedValue(new Error("Agent denied invocation"));
          await expect(execute()).rejects.toThrow("Agent denied invocation");
          expect(fetch).not.toHaveBeenCalled();
          expect(
            await composition.delegations.getExecutionHandle("handle:composition"),
          ).toMatchObject({ uses: 0 });
          return;
        }
        await execute();
        expect(events).toMatchObject([
          {
            type: "work.result",
            payload: {
              outcome: "succeeded",
              outputRef: "payload:composition-output",
            },
          },
        ]);
        expect(fetch).toHaveBeenCalledOnce();
        expect(authority).toHaveBeenCalledWith({
          handleRef: "handle:composition",
          invocationId: "invocation:composition",
        });
        expect(
          await composition.delegations.getExecutionHandle("handle:composition"),
        ).toMatchObject({
          uses: 1,
        });
      } finally {
        await composition.close();
      }
    },
  );

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
