import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CapabilityManifest, CapabilityRegistryRecord } from "@himawari-agent/application";
import { createDeviceId } from "@himawari-agent/domain";
import { SANDBOX_RUNTIME_VERSION } from "@himawari-agent/execution-contracts";
import { gatewayV2MessageSchema } from "@himawari-agent/gateway-contracts";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { createProductionApprovalGateway } from "../../apps/agent-service/src/production-approval-gateway.ts";
import { createProductionCapabilityLifecycle } from "../../apps/agent-service/src/production-capability-lifecycle.ts";
import {
  AGENT_ID,
  handle,
  OWNER_ID,
  openRepository,
  SERVICE_AUTHORITY,
  T0,
  T1,
  T2,
} from "../fixtures/sqlite-capability-invocation-fixture.ts";

const HASH = `sha256:${"c".repeat(64)}`;
const CAPABILITY_REF = "capability-invocation";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

function manifest(): CapabilityManifest {
  return {
    manifestVersion: "capability.v2",
    ref: CAPABILITY_REF,
    displayName: "Production capability",
    version: "1.0.0",
    source: { type: "tool", locator: "tool:production-capability:1.0.0" },
    sourceIdentity: "tool:trusted-publisher",
    integrity: HASH,
    artifact: {
      digest: HASH,
      signatureStatus: "not_applicable",
      signerRef: null,
      rollbackArtifactRef: null,
    },
    operations: ["read"],
    permissionRefs: [],
    scopes: { dataClassifications: ["private"], network: [], filesystem: [], secrets: [] },
    isolation: "worker",
    cost: { currency: "USD", maxMicrosPerInvocation: 0 },
    health: { status: "healthy", checkedAt: T0 },
    reviewedBy: OWNER_ID,
    reviewedAt: T0,
    contractCompatibility: ["capability-conformance.v1"],
    runtime: { kind: "pi_tool", piBuiltinDefinition: "read" },
  };
}

function record(): CapabilityRegistryRecord {
  return {
    ref: CAPABILITY_REF,
    revision: 1,
    lifecycle: "active",
    declaration: manifest(),
    pendingDeclaration: null,
    permissionExpansion: false,
    runtimeQualification: null,
    pendingUpdateAssessment: null,
    rollbackDeclaration: null,
    rollbackQualification: null,
    lastVersionTransition: null,
    approvalRefs: [],
    discoveredAt: T0,
    updatedAt: T0,
  };
}

type Json = Record<string, unknown>;
type DeploymentKind = "matching" | "digest-mismatch" | "unqualified";

const PLATFORM = process.platform === "darwin" ? "darwin" : "linux";
const HOST = "host:reactivate-fixture";
const PROFILE = "host-readonly.v1";
const RUNTIME_DIGEST = "d".repeat(64);
const RUNNER_DIGEST = "c".repeat(64);
const RUNTIME_ROOT = "/opt/himawari/releases/reactivate/capabilities";

function programManifest(integrityHex: string): Json {
  const digest = `sha256:${integrityHex}`;
  return {
    manifestVersion: "capability.v2",
    ref: CAPABILITY_REF,
    displayName: "Reactivation fixture",
    version: "1.0.0",
    source: { type: "program", locator: "artifact:reactivate-fixture" },
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
      filesystem: ["workspace:reactivate"],
      secrets: [],
    },
    cost: { currency: "USD", maxMicrosPerInvocation: 0 },
    health: { status: "healthy", checkedAt: T1 },
    reviewedBy: OWNER_ID,
    reviewedAt: T1,
    contractCompatibility: ["capability-conformance.v1"],
    runtime: {
      kind: "program",
      argv: [`${RUNTIME_ROOT}/node/bin/node`, `${RUNTIME_ROOT}/runners/r.mjs`, HOST, "reactivate"],
      environmentKeys: [],
      workdirRef: "workspace:reactivate",
      stdin: "protected_payload",
      stdout: "protected_payload",
      subprocesses: [],
      network: [],
      filesystem: ["workspace:reactivate"],
    },
  };
}

function deploymentEntry(manifest: Json, suitable: boolean): Json {
  const executable = `${RUNTIME_ROOT}/node/bin/node`;
  const runnerPath = `${RUNTIME_ROOT}/runners/r.mjs`;
  return {
    manifest,
    qualification: {
      qualificationVersion: "capability-runtime-qualification.v1",
      platform: PLATFORM,
      runtimeIdentity: `srt:${SANDBOX_RUNTIME_VERSION}`,
      productionSuitable: suitable,
      artifactDigest: manifest["integrity"],
      enforcement: {
        filesystem: true,
        network: true,
        processes: true,
        secrets: true,
        resourceCeilings: false,
        termination: PLATFORM === "linux",
      },
      reasonCodes: suitable ? [] : ["fixture_not_suitable"],
      checkedAt: T1,
      sandbox: {
        schemaVersion: "sandbox-runtime-qualification.v1",
        qualificationRef: "qualification:reactivate",
        hostId: HOST,
        profileRef: PROFILE,
        srtVersion: SANDBOX_RUNTIME_VERSION,
        platform: PLATFORM,
        architecture: PLATFORM === "darwin" ? "arm64" : "x64",
        osRelease: "27.0.0",
        runtimeDigest: RUNTIME_DIGEST,
        runnerDigest: RUNNER_DIGEST,
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
        capabilityRef: CAPABILITY_REF,
        capabilityVersion: manifest["version"],
        artifactDigest: manifest["integrity"],
        hostId: HOST,
        profileRef: PROFILE,
        runtimeRoot: RUNTIME_ROOT,
        runtimeDigest: RUNTIME_DIGEST,
        executable: { path: executable, sha256: "a".repeat(64) },
        runner: { path: runnerPath, sha256: RUNNER_DIGEST },
        privateRoot: "/var/private-jobs",
        roots: [
          {
            canonicalRootId: "root:reactivate",
            canonicalPath: "/work/project",
            device: "1",
            inode: "2",
          },
        ],
        readOnlyToolchainPaths: ["/usr/bin"],
        protectedPaths: [],
        allowedDomains: [],
        maximumResourceCeiling: {
          maxWallTimeMs: 10_000,
          maxCpuTimeMs: 10_000,
          maxMemoryBytes: 64 * 1024 * 1024,
          maxOutputBytes: 16_384,
          maxProgressEvents: 32,
        },
      },
    },
  };
}

async function writeDeployment(kind: DeploymentKind) {
  const root = await mkdtemp(path.join(tmpdir(), "himawari-reactivate-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from(
    JSON.stringify({
      schemaVersion: "capability-deployment.v1",
      capabilities: [deploymentEntry(programManifest(RUNNER_DIGEST), kind !== "unqualified")],
    }),
  );
  const snapshotPath = path.join(root, "snapshot.json");
  await writeFile(snapshotPath, bytes, { mode: 0o600 });
  await chmod(snapshotPath, 0o600);
  return {
    snapshotPath,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

async function fixture(deployment?: DeploymentKind) {
  const deployed = deployment ? await writeDeployment(deployment) : undefined;
  const resource = await openRepository(true);
  cleanups.push(async () => {
    await resource.repository.close();
    await rm(resource.stateRoot, { recursive: true, force: true });
  });
  const { repository } = resource;
  let nowValue = T1;
  const clock = { now: () => nowValue };
  const capabilityLifecycle = createProductionCapabilityLifecycle({
    configuration: {
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      ...(deployed ? { capabilityDeployment: deployed } : {}),
    },
    repository,
    clock,
  });
  const capabilities = repository.capabilityStore(OWNER_ID, AGENT_ID);
  await capabilities.create(
    deployment
      ? {
          ...record(),
          declaration: programManifest(
            deployment === "digest-mismatch" ? "9".repeat(64) : RUNNER_DIGEST,
          ) as unknown as CapabilityManifest,
        }
      : record(),
  );
  await capabilities.createExecutionHandle({ ...handle(), capabilityRef: CAPABILITY_REF });
  const seedDatabase = new Database(path.join(resource.stateRoot, "product.sqlite"));
  seedDatabase
    .prepare(
      `INSERT INTO payloads (
        ref, owner_id, agent_id, classification, storage_kind, ciphertext,
        content_digest, encryption_algorithm, key_ref, lifecycle_state, created_at, content_type
      ) VALUES ('payload-schedule-01', ?, ?, 'private', 'sqlite_blob', X'00', 'sha256:schedule',
        'fixture', 'fixture-key', 'active', ?, 'application/octet-stream')`,
    )
    .run(OWNER_ID, AGENT_ID, T0);
  seedDatabase.close();
  const scheduler = repository.scheduler();
  for (const id of ["job-a", "job-b"]) {
    await scheduler.upsert(
      {
        id,
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        threadId: null,
        payloadRef: "payload-schedule-01",
        sourceProofRef: "source-proof",
        dataClassification: "private",
        authorizationRef: "policy-capability-invocation",
        taskScopeRef: "task-scope",
        capabilityRef: CAPABILITY_REF,
        operation: "read",
        resourceRef: "resource",
        sideEffect: "none",
        estimatedCostMicros: 10,
        intervalMs: 60_000,
        minimumIntervalMs: 60_000,
        expiresAt: T2,
        revokedAt: null,
        nextRunAt: T1,
        occurrence: 0,
        status: "active",
      },
      null,
    );
  }
  const gateway = createProductionApprovalGateway({
    configuration: { ownerId: OWNER_ID, agentId: AGENT_ID },
    repository,
    authority: () => SERVICE_AUTHORITY.product,
    clock,
    access: { authorize: async () => ({ allowed: true, reasonCode: "TEST_OWNER" }) },
    recentAuthentication: {
      assertRecentAuthentication: async ({ authentication, expectedAuthenticationRef }) => {
        if (expectedAuthenticationRef !== authentication.authenticationRef)
          throw new Error("RECENT_AUTH_REQUIRED");
        return {
          source: "provider_step_up",
          externalSubjectRef: "fixture-owner",
          ownerId: OWNER_ID,
          deviceId: createDeviceId(authentication.deviceId),
          authenticationRef: authentication.authenticationRef,
          authenticatedAt: T1,
          expiresAt: T2,
        };
      },
    },
    capabilityLifecycle,
  });
  const authentication = {
    ownerId: OWNER_ID,
    subjectId: OWNER_ID,
    deviceId: createDeviceId("device-capability"),
    authenticatedAt: T1,
    authenticationRef: "session:device-capability",
  };
  const message = (kind: "query" | "command", type: string, payload: unknown, key?: string) => {
    const parsed = gatewayV2MessageSchema.parse({
      schemaVersion: "gateway.v2",
      kind,
      type,
      messageId: `message:${type}:${key ?? "q"}`,
      correlationId: "capability-gateway",
      causationId: null,
      dataClassification: "private",
      risk: "high",
      authorizationRef: "owner-session",
      scope: { ownerId: OWNER_ID, agentId: AGENT_ID },
      authority: SERVICE_AUTHORITY.product,
      actor: { actorType: "owner", actorId: OWNER_ID },
      ...(kind === "command" ? { idempotencyKey: key } : {}),
      payload,
    });
    return parsed as Parameters<typeof gateway.request>[1];
  };
  return {
    repository,
    stateRoot: resource.stateRoot,
    setNow: (value: string) => {
      nowValue = value;
    },
    deployed,
    capabilities,
    capabilityLifecycle,
    gateway,
    authentication,
    message,
  };
}

it("lists and shows a capability from the real store", async () => {
  const f = await fixture();
  const list = await f.gateway.request(
    f.authentication,
    f.message("query", "capability.list", { lifecycle: null, afterCursor: null, limit: 50 }),
  );
  expect(JSON.stringify(list)).toContain(CAPABILITY_REF);
  const detail = await f.gateway.request(
    f.authentication,
    f.message("query", "capability.detail", { capabilityRef: CAPABILITY_REF }),
  );
  expect(detail).toMatchObject({
    type: "capability.snapshot",
    payload: {
      lifecycle: "active",
      rollbackAvailable: false,
      lastInvalidation: null,
      dependencyTaskRefs: ["job-a", "job-b"],
    },
  });
});

it("refuses disable without recent authentication, then disables and reports the cancelled jobs", async () => {
  const f = await fixture();
  const disable = (recentAuthenticationRef: string | null, key: string) =>
    f.message(
      "command",
      "capability.disable",
      {
        capabilityRef: CAPABILITY_REF,
        expectedRevision: 1,
        reasonCode: "owner_disabled",
        recentAuthenticationRef,
      },
      key,
    );
  await expect(f.gateway.request(f.authentication, disable(null, "disable-none"))).rejects.toThrow(
    "RECENT_AUTH_REQUIRED",
  );
  expect(await f.capabilities.get(CAPABILITY_REF)).toMatchObject({
    lifecycle: "active",
    revision: 1,
  });
  await f.gateway.request(
    f.authentication,
    disable(f.authentication.authenticationRef, "disable-ok"),
  );
  expect(await f.capabilities.get(CAPABILITY_REF)).toMatchObject({
    lifecycle: "disabled",
    lastInvalidation: { lifecycle: "disabled", cancelledScheduledJobs: 2 },
  });
  await expect(f.capabilities.getExecutionHandle(handle().ref)).resolves.toMatchObject({
    revokedAt: T1,
  });
  const detail = await f.gateway.request(
    f.authentication,
    f.message("query", "capability.detail", { capabilityRef: CAPABILITY_REF }),
  );
  expect(detail).toMatchObject({
    payload: { lifecycle: "disabled", lastInvalidation: { cancelledScheduledJobs: 2 } },
  });
});

it("refuses rollback when there is no previous version", async () => {
  const f = await fixture();
  await expect(
    f.gateway.request(
      f.authentication,
      f.message(
        "command",
        "capability.rollback",
        {
          capabilityRef: CAPABILITY_REF,
          expectedRevision: 1,
          reasonCode: "owner_rollback",
          recentAuthenticationRef: f.authentication.authenticationRef,
        },
        "rollback-none",
      ),
    ),
  ).rejects.toBeDefined();
  expect(await f.capabilities.get(CAPABILITY_REF)).toMatchObject({
    lifecycle: "active",
    revision: 1,
  });
});

async function disabledFixture(deployment: DeploymentKind) {
  const f = await fixture(deployment);
  await f.gateway.request(
    f.authentication,
    f.message(
      "command",
      "capability.disable",
      {
        capabilityRef: CAPABILITY_REF,
        expectedRevision: 1,
        reasonCode: "owner_disabled",
        recentAuthenticationRef: f.authentication.authenticationRef,
      },
      "disable-first",
    ),
  );
  const reactivate = (
    recentAuthenticationRef: string | null,
    key: string,
    expectedRevision = 2,
  ) =>
    f.message(
      "command",
      "capability.reactivate",
      {
        capabilityRef: CAPABILITY_REF,
        expectedRevision,
        reasonCode: "owner_reactivated",
        recentAuthenticationRef,
      },
      key,
    );
  return { ...f, reactivate };
}

it("refuses reactivation without recent authentication and leaves the capability disabled", async () => {
  const f = await disabledFixture("matching");
  await expect(
    f.gateway.request(f.authentication, f.reactivate(null, "reactivate-none")),
  ).rejects.toThrow("RECENT_AUTH_REQUIRED");
  await expect(
    f.gateway.request(f.authentication, f.reactivate("session:other", "reactivate-other")),
  ).rejects.toThrow("RECENT_AUTH_REQUIRED");
  expect(await f.capabilities.get(CAPABILITY_REF)).toMatchObject({
    lifecycle: "disabled",
    revision: 2,
  });
});

it("keeps the capability disabled when the installed artifact digest does not match", async () => {
  const f = await disabledFixture("digest-mismatch");
  await expect(
    f.gateway.request(
      f.authentication,
      f.reactivate(f.authentication.authenticationRef, "reactivate-digest"),
    ),
  ).rejects.toBeDefined();
  expect(await f.capabilities.get(CAPABILITY_REF)).toMatchObject({
    lifecycle: "disabled",
    revision: 2,
  });
});

it("keeps the capability disabled when the runtime qualification fails", async () => {
  const f = await disabledFixture("unqualified");
  await expect(
    f.gateway.request(
      f.authentication,
      f.reactivate(f.authentication.authenticationRef, "reactivate-unqualified"),
    ),
  ).rejects.toBeDefined();
  expect(await f.capabilities.get(CAPABILITY_REF)).toMatchObject({
    lifecycle: "disabled",
    revision: 2,
  });
});

it("rejects a reactivation for a stale revision", async () => {
  const f = await disabledFixture("matching");
  await expect(
    f.gateway.request(
      f.authentication,
      f.reactivate(f.authentication.authenticationRef, "reactivate-stale", 1),
    ),
  ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
  expect(await f.capabilities.get(CAPABILITY_REF)).toMatchObject({ lifecycle: "disabled" });
});

it("still refuses to activate a disabled capability directly", async () => {
  const f = await disabledFixture("matching");
  await expect(f.capabilityLifecycle.activate(CAPABILITY_REF)).rejects.toBeDefined();
  expect(await f.capabilities.get(CAPABILITY_REF)).toMatchObject({ lifecycle: "disabled" });
});

it("reactivates a disabled capability without restoring handles or scheduled jobs", async () => {
  const f = await disabledFixture("matching");
  await f.gateway.request(
    f.authentication,
    f.reactivate(f.authentication.authenticationRef, "reactivate-ok"),
  );
  expect(await f.capabilities.get(CAPABILITY_REF)).toMatchObject({
    lifecycle: "active",
    revision: 3,
    lastInvalidation: { lifecycle: "disabled", cancelledScheduledJobs: 2 },
  });
  await expect(f.capabilities.getExecutionHandle(handle().ref)).resolves.toMatchObject({
    revokedAt: T1,
  });
  const database = new Database(path.join(f.stateRoot, "product.sqlite"), { readonly: true });
  const statuses = database
    .prepare("SELECT status FROM scheduled_jobs WHERE json_extract(record_json, '$.capabilityRef') = ?")
    .all(CAPABILITY_REF) as Array<{ status: string }>;
  database.close();
  expect(statuses).toHaveLength(2);
  expect(statuses.every(({ status }) => status === "revoked")).toBe(true);
  const list = await f.gateway.request(
    f.authentication,
    f.message("query", "capability.list", { lifecycle: "active", afterCursor: null, limit: 50 }),
  );
  expect(JSON.stringify(list)).toContain(CAPABILITY_REF);
  await expect(f.capabilityLifecycle.authorizedManifests()).resolves.toHaveLength(1);
  const replay = await f.gateway.request(
    f.authentication,
    f.reactivate(f.authentication.authenticationRef, "reactivate-ok"),
  );
  expect(JSON.stringify(replay)).toContain("revision-3");
});

it("reactivates long after startup because the snapshot admitted at startup is reused", async () => {
  const f = await disabledFixture("matching");
  f.setNow("2026-09-05T00:00:00.000Z");
  await f.gateway.request(
    f.authentication,
    f.reactivate(f.authentication.authenticationRef, "reactivate-later"),
  );
  expect(await f.capabilities.get(CAPABILITY_REF)).toMatchObject({ lifecycle: "active" });
});

it("keeps the capability disabled when the installed snapshot changed after startup", async () => {
  const f = await disabledFixture("matching");
  await writeFile(f.deployed?.snapshotPath ?? "", "{}", { mode: 0o600 });
  await expect(
    f.gateway.request(
      f.authentication,
      f.reactivate(f.authentication.authenticationRef, "reactivate-changed"),
    ),
  ).rejects.toBeDefined();
  expect(await f.capabilities.get(CAPABILITY_REF)).toMatchObject({
    lifecycle: "disabled",
    revision: 2,
  });
});
