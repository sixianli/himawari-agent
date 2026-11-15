import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CapabilityManifest, CapabilityRegistryRecord } from "@himawari-agent/application";
import { createDeploymentId, createDeviceId } from "@himawari-agent/domain";
import { gatewayV2MessageSchema } from "@himawari-agent/gateway-contracts";
import {
  clearWorkerQualifiedDeployment,
  initializeStateRoot,
  readWorkerQualifiedDeployment,
  writeWorkerQualifiedDeployment,
} from "@himawari-agent/platform-node";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { createProductionApprovalGateway } from "../../apps/agent-service/src/production-approval-gateway.ts";
import { createProductionCapabilityLifecycle } from "../../apps/agent-service/src/production-capability-lifecycle.ts";
import {
  CAPABILITY_REACTIVATION_REASONS,
  createProductionCapabilityReactivationVerifier,
} from "../../apps/agent-service/src/production-capability-reactivation.ts";
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

const CAPABILITY_REF = "capability-invocation";
const DIGEST = `sha256:${"d".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"9".repeat(64)}`;
const DEPLOYMENT_ID = createDeploymentId("deployment-capability-invocation");
const WORKER_INSTANCE = `execution-worker:${DEPLOYMENT_ID}`;
const WORKER_BOOT = "worker-boot:current";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

function manifest(integrity = DIGEST, version = "1.0.0"): CapabilityManifest {
  return {
    manifestVersion: "capability.v2",
    ref: CAPABILITY_REF,
    displayName: "Production capability",
    version,
    source: { type: "remote_api", locator: "endpoint:production-capability" },
    sourceIdentity: "publisher:fixture",
    integrity,
    artifact: {
      digest: integrity,
      signatureStatus: "not_applicable",
      signerRef: null,
      rollbackArtifactRef: null,
    },
    operations: ["invoke"],
    permissionRefs: [],
    isolation: "remote",
    scopes: { dataClassifications: ["public"], network: [], filesystem: [], secrets: [] },
    cost: { currency: "USD", maxMicrosPerInvocation: 100 },
    health: { status: "healthy", checkedAt: T0 },
    reviewedBy: OWNER_ID,
    reviewedAt: T0,
    contractCompatibility: ["capability-conformance.v1"],
    runtime: {
      kind: "remote_api",
      endpointIdentity: "endpoint:production-capability",
      protectedReferenceOnly: true,
    },
  };
}

function record(declaration: CapabilityManifest): CapabilityRegistryRecord {
  return {
    ref: CAPABILITY_REF,
    revision: 1,
    lifecycle: "active",
    declaration,
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

async function fixture(
  options: {
    readonly recordIntegrity?: string;
    readonly recordVersion?: string;
    readonly withDeployment?: boolean;
    readonly published?:
      | "none"
      | {
          readonly workerBootId?: string;
          readonly workerInstanceId?: string;
          readonly deploymentId?: string;
          readonly digest?: string;
        };
    readonly withVerifier?: boolean;
  } = {},
) {
  const resource = await openRepository(true);
  cleanups.push(async () => {
    await resource.repository.close();
    await rm(resource.stateRoot, { recursive: true, force: true });
  });
  const { repository } = resource;
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "himawari-reactivation-"));
  cleanups.push(() => rm(stateRoot, { recursive: true, force: true }));
  await chmod(stateRoot, 0o700);
  const layout = await initializeStateRoot(stateRoot);
  const bytes = Buffer.from(
    JSON.stringify({
      schemaVersion: "capability-deployment.v1",
      capabilities: [{ manifest: manifest() }],
    }),
  );
  const snapshotPath = path.join(stateRoot, "deployment.json");
  await writeFile(snapshotPath, bytes, { mode: 0o600 });
  const capabilityDeployment = {
    snapshotPath,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
  if (options.published !== "none") {
    await writeWorkerQualifiedDeployment(layout, {
      workerInstanceId: options.published?.workerInstanceId ?? WORKER_INSTANCE,
      workerBootId: options.published?.workerBootId ?? WORKER_BOOT,
      deploymentId: createDeploymentId(options.published?.deploymentId ?? DEPLOYMENT_ID),
      snapshotDigest: options.published?.digest ?? capabilityDeployment.sha256,
    });
  }
  let peerBootId = WORKER_BOOT;
  const clock = { now: () => T1 };
  const capabilities = repository.capabilityStore(OWNER_ID, AGENT_ID);
  await capabilities.create(record(manifest(options.recordIntegrity, options.recordVersion)));
  await capabilities.createExecutionHandle({ ...handle(), capabilityRef: CAPABILITY_REF });
  const seed = new Database(path.join(resource.stateRoot, "product.sqlite"));
  seed
    .prepare(
      `INSERT INTO payloads (
        ref, owner_id, agent_id, classification, storage_kind, ciphertext,
        content_digest, encryption_algorithm, key_ref, lifecycle_state, created_at, content_type
      ) VALUES ('payload-schedule-01', ?, ?, 'private', 'sqlite_blob', X'00', 'sha256:schedule',
        'fixture', 'fixture-key', 'active', ?, 'application/octet-stream')`,
    )
    .run(OWNER_ID, AGENT_ID, T0);
  seed.close();
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
  const reactivation =
    (options.withVerifier ?? true)
      ? createProductionCapabilityReactivationVerifier({
          configuration: {
            ...((options.withDeployment ?? true) ? { capabilityDeployment } : {}),
            deploymentId: DEPLOYMENT_ID,
          },
          layout,
          trustedPeerBinding: () => ({
            workerInstanceId: WORKER_INSTANCE,
            workerBootId: peerBootId,
          }),
        })
      : undefined;
  const capabilityLifecycle = createProductionCapabilityLifecycle({
    configuration: { ownerId: OWNER_ID, agentId: AGENT_ID },
    repository,
    clock,
    ...(reactivation ? { reactivation } : {}),
  });
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
    ...(reactivation ? { capabilityReactivation: reactivation } : {}),
  });
  const authentication = {
    ownerId: OWNER_ID,
    subjectId: OWNER_ID,
    deviceId: createDeviceId("device-capability"),
    authenticatedAt: T1,
    authenticationRef: "session:device-capability",
  };
  const message = (kind: "query" | "command", type: string, payload: unknown, key?: string) =>
    gatewayV2MessageSchema.parse({
      schemaVersion: "gateway.v2",
      kind,
      type,
      messageId: `message:${type}:${key ?? "q"}`,
      correlationId: "capability-reactivation",
      causationId: null,
      dataClassification: "private",
      risk: "high",
      authorizationRef: "owner-session",
      scope: { ownerId: OWNER_ID, agentId: AGENT_ID },
      authority: SERVICE_AUTHORITY.product,
      actor: { actorType: "owner", actorId: OWNER_ID },
      ...(kind === "command" ? { idempotencyKey: key } : {}),
      payload,
    }) as Parameters<typeof gateway.request>[1];
  await gateway.request(
    authentication,
    message(
      "command",
      "capability.disable",
      {
        capabilityRef: CAPABILITY_REF,
        expectedRevision: 1,
        reasonCode: "owner_disabled",
        recentAuthenticationRef: authentication.authenticationRef,
      },
      "disable-first",
    ),
  );
  const reactivate = (key: string, overrides: { ref?: string | null; revision?: number } = {}) =>
    gateway.request(
      authentication,
      message(
        "command",
        "capability.reactivate",
        {
          capabilityRef: CAPABILITY_REF,
          expectedRevision: overrides.revision ?? 2,
          reasonCode: "owner_reactivated",
          recentAuthenticationRef:
            overrides.ref === undefined ? authentication.authenticationRef : overrides.ref,
        },
        key,
      ),
    );
  const stillDisabled = async () =>
    expect(await capabilities.get(CAPABILITY_REF)).toMatchObject({
      lifecycle: "disabled",
      revision: 2,
    });
  return {
    resource,
    layout,
    snapshotPath,
    capabilityDeployment,
    capabilities,
    capabilityLifecycle,
    gateway,
    authentication,
    message,
    reactivate,
    stillDisabled,
    reactivationWired: reactivation !== undefined,
    restartWorker: (bootId: string) => {
      peerBootId = bootId;
    },
  };
}

const refusedWith = (reason: string) => ({
  code: "PORT_NOT_AUTHORITATIVE",
  details: expect.objectContaining({ reasons: reason }),
});

it("refuses reactivation without matching recent authentication and leaves the capability disabled", async () => {
  const f = await fixture();
  await expect(f.reactivate("no-auth", { ref: null })).rejects.toThrow("RECENT_AUTH_REQUIRED");
  await expect(f.reactivate("other-auth", { ref: "session:other" })).rejects.toThrow(
    "RECENT_AUTH_REQUIRED",
  );
  await f.stillDisabled();
  const receipts = f.resource.repository.governanceMutationReceiptStore();
  await expect(receipts.get(OWNER_ID, AGENT_ID, "no-auth")).resolves.toBeUndefined();
  await expect(receipts.get(OWNER_ID, AGENT_ID, "other-auth")).resolves.toBeUndefined();
});

it("refuses to reactivate a capability that is already active", async () => {
  const f = await fixture();
  await f.reactivate("first");
  await expect(f.reactivate("again", { revision: 3 })).rejects.toMatchObject({
    code: "PORT_INVALID_OPERATION",
  });
  expect(await f.capabilities.get(CAPABILITY_REF)).toMatchObject({
    lifecycle: "active",
    revision: 3,
  });
});

it("refuses when the capability's version is not the one in the snapshot", async () => {
  const f = await fixture({ recordVersion: "1.0.1" });
  await expect(f.reactivate("other-version")).rejects.toMatchObject(
    refusedWith("capability_not_in_deployment_snapshot"),
  );
  await f.stillDisabled();
});

it("wires no reactivation check when no deployment snapshot is configured", async () => {
  const f = await fixture({ withDeployment: false });
  expect(f.reactivationWired).toBe(false);
  await expect(f.reactivate("no-deployment")).rejects.toMatchObject({
    code: "PORT_OPERATION_NOT_INSTALLED",
  });
  await f.stillDisabled();
});

it("rejects a reactivation for a stale revision", async () => {
  const f = await fixture();
  await expect(f.reactivate("stale", { revision: 1 })).rejects.toMatchObject({
    code: "PORT_CONFLICT",
  });
  await f.stillDisabled();
});

it("refuses when the sealed snapshot file no longer matches the configured digest", async () => {
  const f = await fixture();
  await writeFile(f.snapshotPath, "{}", { mode: 0o600 });
  await expect(f.reactivate("changed")).rejects.toMatchObject(
    refusedWith("capability_deployment_snapshot_digest_mismatch"),
  );
  await f.stillDisabled();
});

it("refuses when the snapshot file cannot be read safely", async () => {
  const f = await fixture();
  await rm(f.snapshotPath);
  await expect(f.reactivate("missing")).rejects.toMatchObject(
    refusedWith("capability_deployment_snapshot_unreadable"),
  );
  await f.stillDisabled();
});

it("refuses when the capability's artifact digest is not the one in the snapshot", async () => {
  const f = await fixture({ recordIntegrity: OTHER_DIGEST });
  await expect(f.reactivate("not-member")).rejects.toMatchObject(
    refusedWith("capability_not_in_deployment_snapshot"),
  );
  await f.stillDisabled();
});

it("refuses when the worker published no record after its startup checks", async () => {
  const f = await fixture({ published: "none" });
  await expect(f.reactivate("unpublished")).rejects.toMatchObject(
    refusedWith(CAPABILITY_REACTIVATION_REASONS.WORKER_NOT_QUALIFIED),
  );
  await f.stillDisabled();
});

it("refuses when the published record is not safely readable", async () => {
  const f = await fixture();
  await chmod(path.join(f.layout.runtime, "execution-worker.qualified.json"), 0o644);
  await expect(f.reactivate("unsafe")).rejects.toMatchObject(
    refusedWith(CAPABILITY_REACTIVATION_REASONS.WORKER_NOT_QUALIFIED),
  );
  await f.stillDisabled();
});

it("refuses a record published by an earlier worker boot", async () => {
  const f = await fixture();
  f.restartWorker("worker-boot:restarted");
  await expect(f.reactivate("old-boot")).rejects.toMatchObject(
    refusedWith(CAPABILITY_REACTIVATION_REASONS.WORKER_BOOT_MISMATCH),
  );
  await f.stillDisabled();
});

it.each([{ workerInstanceId: "execution-worker:other" }, { deploymentId: "deployment-other" }])(
  "refuses a record published for another worker or deployment (%o)",
  async (published) => {
    const f = await fixture({ published });
    await expect(f.reactivate("other-peer")).rejects.toMatchObject(
      refusedWith(CAPABILITY_REACTIVATION_REASONS.WORKER_BOOT_MISMATCH),
    );
    await f.stillDisabled();
  },
);

it("refuses a published record larger than the runtime record limit", async () => {
  const f = await fixture();
  const file = path.join(f.layout.runtime, "execution-worker.qualified.json");
  const record = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  await writeFile(file, `${JSON.stringify(record)}${" ".repeat(16_384)}`, { mode: 0o600 });
  await expect(f.reactivate("oversized")).rejects.toMatchObject(
    refusedWith(CAPABILITY_REACTIVATION_REASONS.WORKER_NOT_QUALIFIED),
  );
  await f.stillDisabled();
  await writeFile(file, JSON.stringify(record), { mode: 0o600 });
  await f.reactivate("right-size");
  expect(await f.capabilities.get(CAPABILITY_REF)).toMatchObject({ lifecycle: "active" });
});

it("refuses when the worker admitted a different snapshot", async () => {
  const f = await fixture({ published: { digest: OTHER_DIGEST } });
  await expect(f.reactivate("other-snapshot")).rejects.toMatchObject(
    refusedWith(CAPABILITY_REACTIVATION_REASONS.WORKER_SNAPSHOT_MISMATCH),
  );
  await f.stillDisabled();
});

it("refuses and is not installed when no reactivation check is wired", async () => {
  const f = await fixture({ withVerifier: false });
  await expect(f.reactivate("unwired")).rejects.toMatchObject({
    code: "PORT_OPERATION_NOT_INSTALLED",
  });
  await f.stillDisabled();
});

it("still refuses to activate a disabled capability directly", async () => {
  const f = await fixture();
  await expect(f.capabilityLifecycle.activate(CAPABILITY_REF)).rejects.toMatchObject({
    code: "PORT_INVALID_OPERATION",
  });
  await f.stillDisabled();
});

it("reactivates without restoring handles or scheduled jobs and replays idempotently", async () => {
  const f = await fixture();
  await f.reactivate("ok");
  expect(await f.capabilities.get(CAPABILITY_REF)).toMatchObject({
    lifecycle: "active",
    revision: 3,
    lastInvalidation: { lifecycle: "disabled", cancelledScheduledJobs: 2 },
  });
  await expect(f.capabilities.getExecutionHandle(handle().ref)).resolves.toMatchObject({
    revokedAt: T1,
  });
  const database = new Database(path.join(f.resource.stateRoot, "product.sqlite"), {
    readonly: true,
  });
  const statuses = database
    .prepare(
      "SELECT status FROM scheduled_jobs WHERE json_extract(record_json, '$.capabilityRef') = ?",
    )
    .all(CAPABILITY_REF) as Array<{ status: string }>;
  const audits = database
    .prepare("SELECT COUNT(*) AS count FROM audit_records WHERE action = 'capability.reactivate'")
    .get() as { count: number };
  database.close();
  expect(statuses).toHaveLength(2);
  expect(statuses.every(({ status }) => status === "revoked")).toBe(true);
  expect(audits.count).toBe(1);
  const list = await f.gateway.request(
    f.authentication,
    f.message("query", "capability.list", { lifecycle: "active", afterCursor: null, limit: 50 }),
  );
  expect(JSON.stringify(list)).toContain(CAPABILITY_REF);
  expect(JSON.stringify(await f.reactivate("ok"))).toContain("revision-3");
  expect(await f.capabilities.get(CAPABILITY_REF)).toMatchObject({ revision: 3 });
});

it("publishes, reads back and clears the worker's qualified deployment record", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "himawari-qualified-"));
  cleanups.push(() => rm(stateRoot, { recursive: true, force: true }));
  await chmod(stateRoot, 0o700);
  const layout = await initializeStateRoot(stateRoot);
  await expect(readWorkerQualifiedDeployment(layout)).rejects.toMatchObject({
    code: "STATE_ROOT_BOOT_BINDING_INVALID",
  });
  await expect(
    writeWorkerQualifiedDeployment(layout, {
      workerInstanceId: WORKER_INSTANCE,
      workerBootId: WORKER_BOOT,
      deploymentId: DEPLOYMENT_ID,
      snapshotDigest: "not-a-digest",
    }),
  ).rejects.toMatchObject({ code: "STATE_ROOT_BOOT_BINDING_INVALID" });
  await writeWorkerQualifiedDeployment(layout, {
    workerInstanceId: WORKER_INSTANCE,
    workerBootId: WORKER_BOOT,
    deploymentId: DEPLOYMENT_ID,
    snapshotDigest: DIGEST,
  });
  await expect(readWorkerQualifiedDeployment(layout)).resolves.toEqual({
    schemaVersion: 1,
    workerInstanceId: WORKER_INSTANCE,
    workerBootId: WORKER_BOOT,
    deploymentId: DEPLOYMENT_ID,
    snapshotDigest: DIGEST,
  });
  await clearWorkerQualifiedDeployment(layout);
  await expect(readWorkerQualifiedDeployment(layout)).rejects.toMatchObject({
    code: "STATE_ROOT_BOOT_BINDING_INVALID",
  });
});
