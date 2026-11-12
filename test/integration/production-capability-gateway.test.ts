import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type CapabilityManifest,
  type CapabilityRegistryRecord,
  type CapabilityRuntimeQualification,
  PORT_ERROR_CODES,
} from "@himawari-agent/application";
import { createDeviceId } from "@himawari-agent/domain";
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

const ENDPOINT_DIGEST = `sha256:${"d".repeat(64)}`;

function endpointManifest(version: string): CapabilityManifest {
  return {
    manifestVersion: "capability.v2",
    ref: CAPABILITY_REF,
    displayName: "Production capability",
    version,
    source: { type: "remote_api", locator: "endpoint:production-capability" },
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
    scopes: { dataClassifications: ["public"], network: [], filesystem: [], secrets: [] },
    cost: { currency: "USD", maxMicrosPerInvocation: 100 },
    health: { status: "healthy", checkedAt: T0 },
    reviewedBy: null,
    reviewedAt: null,
    contractCompatibility: ["capability-conformance.v1"],
    runtime: {
      kind: "remote_api",
      endpointIdentity: "endpoint:production-capability",
      protectedReferenceOnly: true,
    },
  };
}

function qualificationFor(checkedAt: string): CapabilityRuntimeQualification {
  return {
    qualificationVersion: "capability-runtime-qualification.v1",
    platform: process.platform === "darwin" ? "darwin" : "linux",
    runtimeIdentity: "fixture-endpoint-qualifier:v1",
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
    checkedAt,
  };
}

async function writeDeployment(options: {
  readonly versions: readonly string[];
  readonly digest?: string;
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "himawari-capability-gateway-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const snapshotPath = path.join(root, "deployment.json");
  const bytes = Buffer.from(
    JSON.stringify({
      schemaVersion: "capability-deployment.v1",
      capabilities: options.versions.map((version) => ({
        manifest: endpointManifest(version),
        qualification: qualificationFor(T0),
        binding: {
          kind: "endpoint",
          value: {
            endpointIdentity: "endpoint:production-capability",
            artifactDigest: ENDPOINT_DIGEST,
            url: "https://capability.example.test",
            allowedMethods: ["POST"],
            operations: { invoke: { method: "POST", path: "/invoke", secretHeaders: {} } },
            productionSuitable: true,
            allowLoopbackQualification: false,
          },
        },
      })),
    }),
    "utf8",
  );
  await writeFile(snapshotPath, bytes, { mode: 0o600 });
  return {
    snapshotPath,
    sha256: options.digest ?? `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

async function withPreviousVersion(f: Awaited<ReturnType<typeof fixture>>, version: string) {
  await f.capabilities.save(
    {
      ...record(),
      rollbackDeclaration: endpointManifest(version),
      rollbackQualification: qualificationFor(T0),
      runtimeQualification: qualificationFor(T0),
      revision: 2,
    },
    1,
  );
}

const rollbackMessage = (
  f: Awaited<ReturnType<typeof fixture>>,
  key: string,
  recentAuthenticationRef: string | null,
) =>
  f.message(
    "command",
    "capability.rollback",
    {
      capabilityRef: CAPABILITY_REF,
      expectedRevision: 2,
      reasonCode: "owner_rollback",
      recentAuthenticationRef,
    },
    key,
  );

async function fixture(deployment?: {
  readonly versions: readonly string[];
  readonly digest?: string;
}) {
  const resource = await openRepository(true);
  cleanups.push(async () => {
    await resource.repository.close();
    await rm(resource.stateRoot, { recursive: true, force: true });
  });
  const { repository } = resource;
  const clock = { now: () => T1 };
  const capabilities = repository.capabilityStore(OWNER_ID, AGENT_ID);
  await capabilities.create(record());
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
  const capabilityDeployment = deployment ? await writeDeployment(deployment) : undefined;
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
    capabilityLifecycle: createProductionCapabilityLifecycle({
      configuration: {
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        ...(capabilityDeployment ? { capabilityDeployment } : {}),
      },
      repository,
      clock,
    }),
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
  return { repository, capabilities, gateway, authentication, message };
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
    payload: {
      lifecycle: "disabled",
      lastInvalidation: { cancelledScheduledJobs: 2 },
      dependencyTaskRefs: [],
    },
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

it("refuses rollback when the previous version is not in the deployment snapshot and says why", async () => {
  const f = await fixture();
  const previous = { ...manifest(), version: "0.9.0" };
  await f.capabilities.save(
    {
      ...record(),
      rollbackDeclaration: previous,
      runtimeQualification: {
        qualificationVersion: "capability-runtime-qualification.v1",
        platform: "linux",
        runtimeIdentity: "fixture",
        productionSuitable: true,
        artifactDigest: HASH,
        enforcement: {
          filesystem: true,
          network: true,
          processes: true,
          secrets: true,
          resourceCeilings: true,
          termination: true,
        },
        reasonCodes: [],
        checkedAt: T0,
      },
      revision: 2,
    },
    1,
  );
  await expect(
    f.gateway.request(
      f.authentication,
      f.message(
        "command",
        "capability.rollback",
        {
          capabilityRef: CAPABILITY_REF,
          expectedRevision: 2,
          reasonCode: "owner_rollback",
          recentAuthenticationRef: f.authentication.authenticationRef,
        },
        "rollback-not-in-snapshot",
      ),
    ),
  ).rejects.toMatchObject({
    code: PORT_ERROR_CODES.NOT_AUTHORITATIVE,
    details: { reasons: "capability_deployment_not_configured" },
  });
  expect(await f.capabilities.get(CAPABILITY_REF)).toMatchObject({
    lifecycle: "active",
    revision: 2,
  });
});

it("rolls back to the previous version when the deployment snapshot carries it", async () => {
  const f = await fixture({ versions: ["0.9.0"] });
  await withPreviousVersion(f, "0.9.0");
  await f.gateway.request(
    f.authentication,
    rollbackMessage(f, "rollback-ok", f.authentication.authenticationRef),
  );
  expect(await f.capabilities.get(CAPABILITY_REF)).toMatchObject({
    lifecycle: "active",
    revision: 3,
    declaration: { version: "0.9.0" },
    rollbackDeclaration: null,
    lastVersionTransition: { fromVersion: "1.0.0", toVersion: "0.9.0", outcome: "rolled_back" },
  });
  await expect(f.capabilities.getExecutionHandle(handle().ref)).resolves.toMatchObject({
    revokedAt: T1,
  });
});

it("refuses rollback and names the reason when the snapshot lacks the previous version", async () => {
  const f = await fixture({ versions: ["2.0.0"] });
  await withPreviousVersion(f, "0.9.0");
  await expect(
    f.gateway.request(
      f.authentication,
      rollbackMessage(f, "rollback-missing", f.authentication.authenticationRef),
    ),
  ).rejects.toMatchObject({
    code: PORT_ERROR_CODES.NOT_AUTHORITATIVE,
    details: { reasons: "capability_not_in_deployment_snapshot" },
  });
  expect(await f.capabilities.get(CAPABILITY_REF)).toMatchObject({ revision: 2 });
});

it("refuses rollback and names the reason when the snapshot cannot be read", async () => {
  const f = await fixture({ versions: ["0.9.0"], digest: `sha256:${"1".repeat(64)}` });
  await withPreviousVersion(f, "0.9.0");
  await expect(
    f.gateway.request(
      f.authentication,
      rollbackMessage(f, "rollback-unreadable", f.authentication.authenticationRef),
    ),
  ).rejects.toMatchObject({
    code: PORT_ERROR_CODES.NOT_AUTHORITATIVE,
    details: { reasons: "capability_deployment_snapshot_unreadable" },
  });
  expect(await f.capabilities.get(CAPABILITY_REF)).toMatchObject({ revision: 2 });
});

it("refuses rollback without matching recent authentication and leaves state unchanged", async () => {
  const f = await fixture({ versions: ["0.9.0"] });
  await withPreviousVersion(f, "0.9.0");
  for (const ref of [null, "session:another-device"]) {
    await expect(
      f.gateway.request(f.authentication, rollbackMessage(f, `rollback-auth-${ref}`, ref)),
    ).rejects.toThrow("RECENT_AUTH_REQUIRED");
    expect(await f.capabilities.get(CAPABILITY_REF)).toMatchObject({
      revision: 2,
      declaration: { version: "1.0.0" },
    });
  }
});
