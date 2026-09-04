import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ApprovalRequest,
  CapabilityInvocationAuthority,
  CapabilityRegistryRecord,
  ExecutionTransportPort,
  GovernedCapabilityExecutionHandle,
  GrantRecord,
  PayloadRecord,
} from "@himawari-agent/application";
import {
  ApplicationPortError,
  PORT_ERROR_CODES,
  type PortErrorCode,
  WorkerDelegationService,
} from "@himawari-agent/application";
import {
  createAgentId,
  createAuthorityLeaseId,
  createDeploymentId,
  createIdempotencyKey,
  createOwnerId,
  createRunId,
} from "@himawari-agent/domain";
import {
  EXECUTION_V2_SCHEMA_VERSION,
  type ExecutionV2Event,
  type ExecutionV2Request,
  type ExecutionV2Response,
  executionV2MessageSchema,
} from "@himawari-agent/execution-contracts";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteCapabilityInvocationOperations,
  SqliteGovernedDeletionAdapter,
  SqliteProductStateRepository,
  SqliteRunPayloadArtifactOperations,
} from "@himawari-agent/persistence-sqlite";
import { describe, expect, it } from "vitest";

const OWNER_ID = createOwnerId("owner-capability-invocation");
const AGENT_ID = createAgentId("agent-capability-invocation");
const OTHER_OWNER_ID = createOwnerId("owner-other-capability-invocation");
const OTHER_AGENT_ID = createAgentId("agent-other-capability-invocation");
const RUN_ID = createRunId("run-capability-invocation");
const T0 = "2026-09-04T00:00:00.000Z";
const T1 = "2026-09-04T00:00:01.000Z";
const T2 = "2026-09-04T00:05:00.000Z";

const SERVICE_AUTHORITY: CapabilityInvocationAuthority = {
  product: {
    deploymentId: createDeploymentId("deployment-capability-invocation"),
    authorityEpoch: 1,
    fencingToken: 1,
  },
  lease: {
    leaseId: createAuthorityLeaseId("lease-capability-invocation"),
    fencingToken: 1,
  },
  agentServiceInstanceId: "agent-service-instance-capability-invocation",
  agentServiceBootId: "agent-service-boot-capability-invocation",
  workerInstanceId: "worker-instance-capability-invocation",
  workerBootId: "worker-boot-capability-invocation",
};

class RecordingServiceTransport implements ExecutionTransportPort {
  readonly requests: ExecutionV2Request[] = [];

  async request(message: ExecutionV2Request): Promise<ExecutionV2Response | null> {
    this.requests.push(message);
    if (message.type !== "work.delegate") return null;
    return executionV2MessageSchema.parse({
      schemaVersion: EXECUTION_V2_SCHEMA_VERSION,
      kind: "response",
      type: "work.delegate.accepted",
      messageId: "service-worker-delegate-accepted",
      correlationId: message.correlationId,
      causationId: message.messageId,
      dataClassification: message.dataClassification,
      risk: message.risk,
      authorizationRef: message.authorizationRef,
      scope: message.scope,
      payload: {
        handleRef: message.payload.handle.ref,
        workerBootId: SERVICE_AUTHORITY.workerBootId,
        acceptedAt: T1,
      },
    }) as Extract<ExecutionV2Response, { type: "work.delegate.accepted" }>;
  }

  async *events(_afterCursor: string | null): AsyncIterable<ExecutionV2Event> {}
}

function serviceRequest(): Extract<ExecutionV2Request, { type: "work.execute" }> {
  return executionV2MessageSchema.parse({
    schemaVersion: EXECUTION_V2_SCHEMA_VERSION,
    kind: "request",
    type: "work.execute",
    messageId: "invocation-service-capability-invocation",
    correlationId: "correlation-service-capability-invocation",
    causationId: "run-admitted-capability-invocation",
    dataClassification: "private",
    risk: "low",
    authorizationRef: null,
    scope: {
      deploymentId: "deployment-capability-invocation",
      authorityEpoch: 1,
      fencingToken: 1,
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      workerRunId: "worker-run-capability-invocation",
    },
    idempotencyKey: "idempotency-service-capability-invocation",
    payload: {
      capabilityId: "capability-invocation",
      capabilityVersion: "1.0.0",
      operation: "read",
      inputRef: "payload-input-capability-invocation",
      capabilityHandleRef: "handle-capability-invocation",
      delegatedContextRefs: ["payload-context-capability-invocation"],
      secretRefs: [],
      resourceCeiling: {
        maxWallTimeMs: 1000,
        maxCpuTimeMs: 1000,
        maxMemoryBytes: 1_000_000,
        maxOutputBytes: 4096,
        maxProgressEvents: 10,
      },
      requestedAt: T0,
      deadlineAt: T2,
    },
  }) as Extract<ExecutionV2Request, { type: "work.execute" }>;
}

async function openRepository(): Promise<{
  readonly repository: SqliteProductStateRepository;
  readonly stateRoot: string;
}> {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-sqlite-capability-invocation-"));
  const databasePath = path.join(stateRoot, "product.sqlite");
  const database = openQualifiedDatabase(databasePath);
  applyMigrations(database, await loadBundledMigrations());
  database
    .prepare("INSERT INTO owners (id, revision) VALUES (?, 0), (?, 0)")
    .run(OWNER_ID, OTHER_OWNER_ID);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0), (?, ?, 0)")
    .run(AGENT_ID, OWNER_ID, OTHER_AGENT_ID, OTHER_OWNER_ID);
  database
    .prepare(
      `INSERT INTO deployments (
        id, owner_id, agent_id, revision, status, authority_epoch, fencing_token
      ) VALUES ('deployment-capability-invocation', ?, ?, 0, 'active', 1, 1)`,
    )
    .run(OWNER_ID, AGENT_ID);
  database
    .prepare(
      `INSERT INTO authority_leases (
        id, owner_id, agent_id, deployment_id, holder_id, authority_epoch,
        fencing_token, acquired_at, expires_at
      ) VALUES (?, ?, ?, 'deployment-capability-invocation', 'holder-capability-invocation',
        1, 1, ?, '2999-12-31T23:59:59.999Z')`,
    )
    .run(createAuthorityLeaseId("lease-capability-invocation"), OWNER_ID, AGENT_ID, T0);
  database
    .prepare(
      `INSERT INTO threads (
        id, owner_id, agent_id, revision, status, created_at, updated_at
      ) VALUES ('thread-capability-invocation', ?, ?, 0, 'open', ?, ?)`,
    )
    .run(OWNER_ID, AGENT_ID, T0, T0);
  database
    .prepare(
      `INSERT INTO payloads (
        ref, owner_id, agent_id, classification, storage_kind, ciphertext,
        content_digest, encryption_algorithm, key_ref, lifecycle_state, created_at, content_type
      ) VALUES ('payload-capability-invocation-trigger', ?, ?, 'private', 'sqlite_blob', X'00',
        'sha256:capability-invocation-trigger', 'fixture', 'fixture-key', 'active', ?,
        'application/octet-stream')`,
    )
    .run(OWNER_ID, AGENT_ID, T0);
  database
    .prepare(
      `INSERT INTO triggers (
        id, owner_id, agent_id, thread_id, idempotency_key, source_type,
        source_id, payload_ref, source_proof_ref, occurred_at
      ) VALUES ('trigger-capability-invocation', ?, ?, 'thread-capability-invocation',
        'trigger-capability-invocation', 'user_message', 'fixture-source',
        'payload-capability-invocation-trigger', 'fixture-proof', ?)`,
    )
    .run(OWNER_ID, AGENT_ID, T0);
  database
    .prepare(
      `INSERT INTO runs (
        id, owner_id, agent_id, thread_id, session_id, trigger_id, revision,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, 'thread-capability-invocation', 'session-capability-invocation',
        'trigger-capability-invocation', 0, 'running', ?, ?)`,
    )
    .run(RUN_ID, OWNER_ID, AGENT_ID, T0, T0);
  database.close();
  const repository = await SqliteProductStateRepository.open({
    stateRoot,
    minimumFreeBytes: 0,
    now: () => T1,
  });
  return { repository, stateRoot };
}

function capability(): CapabilityRegistryRecord {
  return {
    ref: "capability-invocation",
    revision: 1,
    lifecycle: "active",
    declaration: {
      ref: "capability-invocation",
      displayName: "Capability invocation test",
      version: "1.0.0",
      source: { type: "builtin", locator: "builtin:capability-invocation" },
      integrity: `sha256:${"a".repeat(64)}`,
      operations: ["read"],
      permissionRefs: [],
      isolation: "worker",
    },
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

function handle(): GovernedCapabilityExecutionHandle {
  return {
    handleVersion: "capability-handle.v2",
    ref: "handle-capability-invocation",
    revision: 1,
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    runId: RUN_ID,
    authorityFence: 1,
    capabilityRef: "capability-invocation",
    capabilityVersion: "1.0.0",
    authorization: { type: "policy", ref: "policy-capability-invocation" },
    authorizationRef: "policy-capability-invocation",
    operations: ["read"],
    operation: "read",
    inputRefs: ["payload-input-capability-invocation"],
    delegatedContextRefs: ["payload-context-capability-invocation"],
    secretRefs: [],
    maxDataClassification: "private",
    maxUses: 2,
    uses: 0,
    maxTotalCostMicros: 0,
    spentCostMicros: 0,
    idempotencyKeys: [],
    issuedAt: T0,
    expiresAt: T2,
    revokedAt: null,
    workerEndedAt: null,
  };
}

function grantApproval(): ApprovalRequest {
  return {
    id: "approval-capability-invocation-grant",
    revision: 1,
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    runId: RUN_ID,
    intentId: "intent-capability-invocation-grant",
    intentSnapshot: {
      id: "intent-capability-invocation-grant",
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      capabilityRef: "capability-invocation",
      operation: "read",
      resourceRef: "resource-capability-invocation",
      dataClassification: "private",
      sideEffect: "none",
      estimatedCostMicros: 0,
      frequency: { count: 1, intervalMs: null },
      idempotencyKey: createIdempotencyKey("intent-capability-invocation-grant"),
      reversible: true,
      requestedAt: T0,
    },
    semanticSnapshotHash: "hash-capability-invocation-grant",
    status: "pending",
    deliveryState: "deliverable",
    requestedAt: T0,
    expiresAt: T2,
    decidedAt: null,
    grantId: null,
  };
}

function grant(): GrantRecord {
  return {
    id: "grant-capability-invocation",
    revision: 1,
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    kind: "one_time",
    scope: {
      capabilityRef: "capability-invocation",
      operations: ["read"],
      exactResourceRef: null,
      resourcePrefixes: [],
      maxDataClassification: "private",
      sideEffects: ["none"],
      maxCostMicrosPerUse: 0,
      maxFrequency: { count: 1, intervalMs: null },
    },
    intentFingerprint: "fingerprint-capability-invocation-grant",
    sourceApprovalRequestId: "approval-capability-invocation-grant",
    validFrom: T0,
    expiresAt: T2,
    maxUses: 1,
    uses: 0,
    maxTotalCostMicros: 0,
    spentCostMicros: 0,
    revokedAt: null,
    revocationReasonCode: null,
  };
}

function grantHandle(): GovernedCapabilityExecutionHandle {
  return {
    ...handle(),
    ref: "handle-capability-invocation-grant",
    authorization: { type: "grant", ref: "grant-capability-invocation" },
    authorizationRef: "grant-capability-invocation",
    maxUses: 2,
  };
}

function invocation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    receiptRef: "receipt-capability-invocation",
    handleRef: "handle-capability-invocation",
    invocationId: "invocation-capability-invocation",
    requestScope: {
      deploymentId: "deployment-capability-invocation",
      authorityEpoch: 1,
      fencingToken: 1,
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      workerRunId: "worker-run-capability-invocation",
    },
    capabilityRef: "capability-invocation",
    capabilityVersion: "1.0.0",
    authorizationRef: "policy-capability-invocation",
    idempotencyKey: "capability-invocation-idempotency",
    operation: "read",
    inputRef: "payload-input-capability-invocation",
    delegatedContextRefs: ["payload-context-capability-invocation"],
    secretRefs: [],
    dataClassification: "private",
    resourceCeiling: {
      maxWallTimeMs: 1000,
      maxCpuTimeMs: 1000,
      maxMemoryBytes: 1_000_000,
      maxOutputBytes: 4096,
      maxProgressEvents: 10,
    },
    requestedAt: T0,
    deadlineAt: T2,
    authority: {
      product: {
        deploymentId: "deployment-capability-invocation",
        authorityEpoch: 1,
        fencingToken: 1,
      },
      lease: { leaseId: "lease-capability-invocation", fencingToken: 1 },
      agentServiceInstanceId: "agent-service-instance-capability-invocation",
      agentServiceBootId: "agent-service-boot-capability-invocation",
      workerInstanceId: "worker-instance-capability-invocation",
      workerBootId: "worker-boot-capability-invocation",
    },
    consumedAt: T1,
    ...overrides,
  };
}

function readInvocation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const authorityOverrides = overrides["authority"] as Record<string, unknown> | undefined;
  return {
    handleRef: "handle-capability-invocation",
    invocationId: "invocation-capability-invocation",
    ...overrides,
    authority: {
      product: {
        deploymentId: "deployment-capability-invocation",
        authorityEpoch: 1,
        fencingToken: 1,
      },
      lease: { leaseId: "lease-capability-invocation", fencingToken: 1 },
      agentServiceInstanceId: "agent-service-instance-capability-invocation",
      agentServiceBootId: "agent-service-boot-capability-invocation",
      workerInstanceId: "worker-instance-capability-invocation",
      workerBootId: "worker-boot-capability-invocation",
      ...authorityOverrides,
    },
    now: T1,
  };
}

function outputPayload(
  ref = "payload-capability-invocation-output",
  contentDigest = "sha256:capability-invocation-output",
  ciphertext = new Uint8Array([0x21, 0x22]),
): PayloadRecord {
  return {
    ref,
    dataClassification: "private",
    contentType: "text/plain",
    ciphertext,
    encryption: { algorithm: "fixture", keyRef: "fixture-key" },
    contentDigest,
    createdAt: T1,
  };
}

function outputObservation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    handleRef: "handle-capability-invocation",
    invocationId: "invocation-capability-invocation",
    authority: {
      product: {
        deploymentId: "deployment-capability-invocation",
        authorityEpoch: 1,
        fencingToken: 1,
      },
      lease: { leaseId: "lease-capability-invocation", fencingToken: 1 },
      agentServiceInstanceId: "agent-service-instance-capability-invocation",
      agentServiceBootId: "agent-service-boot-capability-invocation",
      workerInstanceId: "worker-instance-capability-invocation",
      workerBootId: "worker-boot-capability-invocation",
    },
    now: T1,
    payload: outputPayload(),
    plaintextByteLength: 2,
    ...overrides,
  };
}

function operationsForDatabase(
  database: ReturnType<typeof openQualifiedDatabase>,
): SqliteCapabilityInvocationOperations {
  const fail = (
    code: string,
    message: string,
    details?: Readonly<Record<string, string>>,
  ): never => {
    throw new ApplicationPortError(code as PortErrorCode, message, details);
  };
  const artifacts = new SqliteRunPayloadArtifactOperations(database, fail, () => undefined);
  return new SqliteCapabilityInvocationOperations(database, fail, () => undefined, artifacts);
}

async function openOperations(resource: {
  readonly repository: SqliteProductStateRepository;
  readonly stateRoot: string;
}): Promise<{
  readonly database: ReturnType<typeof openQualifiedDatabase>;
  readonly operations: SqliteCapabilityInvocationOperations;
}> {
  await resource.repository.close();
  const database = openQualifiedDatabase(path.join(resource.stateRoot, "product.sqlite"));
  const operations = operationsForDatabase(database);
  return { database, operations };
}

function callOperation(
  operations: SqliteCapabilityInvocationOperations,
  operation: string,
  payload: unknown,
): Promise<unknown> {
  return Promise.resolve().then(() => operations.execute(operation, payload));
}

async function seed(
  repository: SqliteProductStateRepository,
): Promise<GovernedCapabilityExecutionHandle> {
  const capabilities = repository.capabilityStore(OWNER_ID, AGENT_ID);
  await capabilities.create(capability());
  const value = handle();
  await capabilities.createExecutionHandle(value);
  return value;
}

describe("SQLite capability invocation authority", () => {
  it("replays an equivalent receipt and rejects same-key semantic changes", async () => {
    const resource = await openRepository();
    let database: ReturnType<typeof openQualifiedDatabase> | undefined;
    try {
      await seed(resource.repository);
      const opened = await openOperations(resource);
      database = opened.database;
      const first = opened.operations.execute("capabilityInvocation.consume", {
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        input: invocation(),
      });
      expect(first).toMatchObject({
        replayed: false,
        receipt: {
          receiptVersion: "capability-invocation.v1",
          invocationId: "invocation-capability-invocation",
          handleRevision: 2,
        },
      });
      await expect(
        Promise.resolve(
          callOperation(opened.operations, "capabilityInvocation.consume", {
            ownerId: OWNER_ID,
            agentId: AGENT_ID,
            input: invocation({ consumedAt: T2 }),
          }),
        ),
      ).resolves.toMatchObject({ replayed: true });
      await expect(
        Promise.resolve(
          callOperation(opened.operations, "capabilityInvocation.consume", {
            ownerId: OWNER_ID,
            agentId: AGENT_ID,
            input: invocation({ inputRef: "payload-input-mutated", consumedAt: T2 }),
          }),
        ),
      ).rejects.toMatchObject({ code: PORT_ERROR_CODES.CONFLICT });
      await expect(
        Promise.resolve(
          callOperation(opened.operations, "capabilityInvocation.consume", {
            ownerId: OWNER_ID,
            agentId: AGENT_ID,
            input: invocation({ operation: "write", consumedAt: T2 }),
          }),
        ),
      ).rejects.toMatchObject({ code: PORT_ERROR_CODES.CONFLICT });
      expect(
        database
          .prepare(
            "SELECT json_extract(record_json, '$.uses') FROM capability_handles WHERE id = ?",
          )
          .pluck()
          .get("handle-capability-invocation"),
      ).toBe(1);
    } finally {
      database?.close();
      await resource.repository.close();
      await rm(resource.stateRoot, { recursive: true });
    }
  });

  it("does not recount a consumed Grant, blocks revoked reads, and only replays the receipt", async () => {
    const resource = await openRepository();
    let database: ReturnType<typeof openQualifiedDatabase> | undefined;
    try {
      const capabilities = resource.repository.capabilityStore(OWNER_ID, AGENT_ID);
      await capabilities.create(capability());
      const grantValue = grant();
      const approvalValue = grantApproval();
      const authorization = resource.repository.authorizationStore();
      await authorization.createApproval(approvalValue);
      await authorization.resolveApproval({
        approvalRequestId: approvalValue.id,
        expectedRevision: 1,
        semanticSnapshotHash: approvalValue.semanticSnapshotHash,
        resolution: "approved",
        decidedAt: T1,
        grant: grantValue,
      });
      await expect(
        authorization.consumeGrant({
          grantId: grantValue.id,
          expectedRevision: 1,
          costMicros: 0,
          consumedAt: T1,
          usageId: "usage-capability-invocation-grant",
          operation: "read",
        }),
      ).resolves.toMatchObject({ uses: 1, revision: 2 });
      const grantHandleValue = grantHandle();
      await capabilities.createExecutionHandle(grantHandleValue);

      const opened = await openOperations(resource);
      database = opened.database;
      let operations = opened.operations;
      const grantInvocation = invocation({
        receiptRef: "receipt-capability-invocation-grant",
        handleRef: grantHandleValue.ref,
        invocationId: "invocation-capability-invocation-grant",
        authorizationRef: grantValue.id,
        idempotencyKey: "capability-invocation-grant-idempotency",
      });
      await expect(
        callOperation(operations, "capabilityInvocation.consume", {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          input: grantInvocation,
        }),
      ).resolves.toMatchObject({ replayed: false, receipt: { handleRevision: 2 } });
      await expect(
        callOperation(operations, "capabilityInvocation.read", {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          input: readInvocation({
            handleRef: grantHandleValue.ref,
            invocationId: "invocation-capability-invocation-grant",
          }),
        }),
      ).resolves.toMatchObject({ invocationId: "invocation-capability-invocation-grant" });
      expect(
        database
          .prepare("SELECT json_extract(record_json, '$.uses') FROM grants WHERE id = ?")
          .pluck()
          .get(grantValue.id),
      ).toBe(1);

      database.close();
      database = undefined;
      const reopened = await SqliteProductStateRepository.open({
        stateRoot: resource.stateRoot,
        minimumFreeBytes: 0,
        now: () => T1,
      });
      await reopened.authorizationStore().revokeGrant(grantValue.id, T1, "test_grant_revoked", 2);
      await reopened.close();
      database = openQualifiedDatabase(path.join(resource.stateRoot, "product.sqlite"));
      operations = operationsForDatabase(database);

      await expect(
        callOperation(operations, "capabilityInvocation.consume", {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          input: { ...grantInvocation, consumedAt: T2 },
        }),
      ).resolves.toMatchObject({ replayed: true });
      await expect(
        callOperation(operations, "capabilityInvocation.consume", {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          input: {
            ...grantInvocation,
            receiptRef: "receipt-capability-invocation-grant-new",
            invocationId: "invocation-capability-invocation-grant-new",
            idempotencyKey: "capability-invocation-grant-idempotency-new",
            consumedAt: T1,
          },
        }),
      ).rejects.toMatchObject({ code: PORT_ERROR_CODES.HANDLE_REVOKED });
      await expect(
        callOperation(operations, "capabilityInvocation.read", {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          input: readInvocation({
            handleRef: grantHandleValue.ref,
            invocationId: "invocation-capability-invocation-grant",
          }),
        }),
      ).rejects.toMatchObject({ code: PORT_ERROR_CODES.HANDLE_REVOKED });
      expect(
        database
          .prepare("SELECT json_extract(record_json, '$.uses') FROM grants WHERE id = ?")
          .pluck()
          .get(grantValue.id),
      ).toBe(1);
    } finally {
      database?.close();
      await resource.repository.close();
      await rm(resource.stateRoot, { recursive: true });
    }
  });

  it("rejects a first invalid semantic consume without recording its key", async () => {
    const resource = await openRepository();
    let database: ReturnType<typeof openQualifiedDatabase> | undefined;
    try {
      await seed(resource.repository);
      const opened = await openOperations(resource);
      database = opened.database;
      const invalid = invocation({
        receiptRef: "receipt-capability-invocation-invalid",
        invocationId: "invocation-capability-invocation-invalid",
        idempotencyKey: "capability-invocation-invalid-first",
        operation: "write",
      });
      await expect(
        Promise.resolve(
          callOperation(opened.operations, "capabilityInvocation.consume", {
            ownerId: OWNER_ID,
            agentId: AGENT_ID,
            input: invalid,
          }),
        ),
      ).rejects.toMatchObject({ code: PORT_ERROR_CODES.NOT_AUTHORITATIVE });
      await expect(
        Promise.resolve(
          callOperation(opened.operations, "capabilityInvocation.consume", {
            ownerId: OWNER_ID,
            agentId: AGENT_ID,
            input: { ...invalid, operation: "read" },
          }),
        ),
      ).resolves.toMatchObject({ replayed: false, receipt: { handleRevision: 2 } });
      expect(
        database
          .prepare(
            "SELECT json_extract(record_json, '$.uses') FROM capability_handles WHERE id = ?",
          )
          .pluck()
          .get("handle-capability-invocation"),
      ).toBe(1);
    } finally {
      database?.close();
      await resource.repository.close();
      await rm(resource.stateRoot, { recursive: true });
    }
  });

  it("rejects the retired unscoped consume path without changing the Handle", async () => {
    const resource = await openRepository();
    let database: ReturnType<typeof openQualifiedDatabase> | undefined;
    try {
      await seed(resource.repository);
      const capabilities = resource.repository.capabilityStore(OTHER_OWNER_ID, OTHER_AGENT_ID);
      const consumeHandle = capabilities.consumeExecutionHandle;
      if (!consumeHandle) throw new Error("governed capability store is incomplete");
      await expect(
        consumeHandle({
          handleRef: "handle-capability-invocation",
          expectedRevision: 1,
          authorityFence: 1,
          operation: "read",
          inputRef: "payload-input-capability-invocation",
          delegatedContextRefs: ["payload-context-capability-invocation"],
          secretRefs: [],
          dataClassification: "private",
          costMicros: 0,
          idempotencyKey: "capability-invocation-cross-scope",
          consumedAt: T1,
        }),
      ).rejects.toMatchObject({ code: PORT_ERROR_CODES.NOT_AUTHORITATIVE });
      await expect(
        resource.repository
          .capabilityStore(OWNER_ID, AGENT_ID)
          .getExecutionHandle("handle-capability-invocation"),
      ).resolves.toMatchObject({ uses: 0 });
    } finally {
      database?.close();
      await resource.repository.close();
      await rm(resource.stateRoot, { recursive: true });
    }
  });

  it("rejects a new receipt consume outside its scoped adapter", async () => {
    const resource = await openRepository();
    let database: ReturnType<typeof openQualifiedDatabase> | undefined;
    try {
      await seed(resource.repository);
      const opened = await openOperations(resource);
      database = opened.database;
      const crossScope = invocation({
        receiptRef: "receipt-capability-invocation-cross-scope",
        invocationId: "invocation-capability-invocation-cross-scope",
        idempotencyKey: "capability-invocation-cross-scope-receipt",
        requestScope: {
          deploymentId: "deployment-capability-invocation",
          authorityEpoch: 1,
          fencingToken: 1,
          ownerId: OTHER_OWNER_ID,
          agentId: OTHER_AGENT_ID,
          runId: RUN_ID,
          workerRunId: "worker-run-capability-invocation",
        },
      });
      await expect(
        callOperation(opened.operations, "capabilityInvocation.consume", {
          ownerId: OTHER_OWNER_ID,
          agentId: OTHER_AGENT_ID,
          input: crossScope,
        }),
      ).rejects.toMatchObject({ code: PORT_ERROR_CODES.NOT_AUTHORITATIVE });
      expect(
        database
          .prepare(
            "SELECT json_extract(record_json, '$.uses') FROM capability_handles WHERE id = ?",
          )
          .pluck()
          .get("handle-capability-invocation"),
      ).toBe(0);
    } finally {
      database?.close();
      await resource.repository.close();
      await rm(resource.stateRoot, { recursive: true });
    }
  });

  it("rejects stale authority before consuming a new Capability Handle", async () => {
    const resource = await openRepository();
    let database: ReturnType<typeof openQualifiedDatabase> | undefined;
    try {
      await seed(resource.repository);
      const opened = await openOperations(resource);
      database = opened.database;
      const stale = invocation({
        receiptRef: "receipt-capability-invocation-stale-fence",
        invocationId: "invocation-capability-invocation-stale-fence",
        idempotencyKey: "capability-invocation-stale-fence",
        requestScope: {
          deploymentId: "deployment-capability-invocation",
          authorityEpoch: 2,
          fencingToken: 2,
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          runId: RUN_ID,
          workerRunId: "worker-run-capability-invocation",
        },
        authority: {
          product: {
            deploymentId: "deployment-capability-invocation",
            authorityEpoch: 2,
            fencingToken: 2,
          },
          lease: { leaseId: "lease-capability-invocation", fencingToken: 2 },
          agentServiceInstanceId: "agent-service-instance-capability-invocation",
          agentServiceBootId: "agent-service-boot-capability-invocation",
          workerInstanceId: "worker-instance-capability-invocation",
          workerBootId: "worker-boot-capability-invocation",
        },
      });
      await expect(
        callOperation(opened.operations, "capabilityInvocation.consume", {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          input: stale,
        }),
      ).rejects.toMatchObject({ code: PORT_ERROR_CODES.NOT_AUTHORITATIVE });
      expect(
        database
          .prepare(
            "SELECT json_extract(record_json, '$.uses') FROM capability_handles WHERE id = ?",
          )
          .pluck()
          .get("handle-capability-invocation"),
      ).toBe(0);
    } finally {
      database?.close();
      await resource.repository.close();
      await rm(resource.stateRoot, { recursive: true });
    }
  });

  it("requires the frozen Agent and Worker attempt plus a live lease on read", async () => {
    const resource = await openRepository();
    let database: ReturnType<typeof openQualifiedDatabase> | undefined;
    try {
      await seed(resource.repository);
      const opened = await openOperations(resource);
      database = opened.database;
      await expect(
        callOperation(opened.operations, "capabilityInvocation.consume", {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          input: invocation(),
        }),
      ).resolves.toMatchObject({ replayed: false });
      const read = (authority: Record<string, unknown>) =>
        callOperation(opened.operations, "capabilityInvocation.read", {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          input: readInvocation({ authority }),
        });
      await expect(
        read({ agentServiceInstanceId: "agent-service-instance-other" }),
      ).rejects.toMatchObject({ code: PORT_ERROR_CODES.NOT_AUTHORITATIVE });
      await expect(read({ agentServiceBootId: "agent-service-boot-other" })).rejects.toMatchObject({
        code: PORT_ERROR_CODES.NOT_AUTHORITATIVE,
      });
      await expect(read({ workerInstanceId: "worker-instance-other" })).rejects.toMatchObject({
        code: PORT_ERROR_CODES.NOT_AUTHORITATIVE,
      });
      await expect(read({ workerBootId: "worker-boot-other" })).rejects.toMatchObject({
        code: PORT_ERROR_CODES.NOT_AUTHORITATIVE,
      });
      await expect(
        read({ lease: { leaseId: "lease-capability-invocation", fencingToken: 99 } }),
      ).rejects.toMatchObject({ code: PORT_ERROR_CODES.NOT_AUTHORITATIVE });
      await expect(
        callOperation(opened.operations, "capabilityInvocation.read", {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          input: readInvocation(),
        }),
      ).resolves.toMatchObject({ invocationId: "invocation-capability-invocation" });
      database
        .prepare(
          "UPDATE deployments SET revision = 1, authority_epoch = 2, fencing_token = 2 WHERE id = ?",
        )
        .run("deployment-capability-invocation");
      database
        .prepare("UPDATE authority_leases SET released_at = ? WHERE id = ?")
        .run(T1, "lease-capability-invocation");
      database
        .prepare(
          `INSERT INTO authority_leases (
            id, owner_id, agent_id, deployment_id, holder_id, authority_epoch,
            fencing_token, acquired_at, expires_at
          ) VALUES ('lease-capability-invocation-rotated', ?, ?,
            'deployment-capability-invocation', 'holder-capability-invocation-rotated',
            2, 2, ?, '2999-12-31T23:59:59.999Z')`,
        )
        .run(OWNER_ID, AGENT_ID, T1);
      await expect(
        callOperation(opened.operations, "capabilityInvocation.read", {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          input: readInvocation({
            authority: {
              product: {
                deploymentId: "deployment-capability-invocation",
                authorityEpoch: 2,
                fencingToken: 2,
              },
              lease: { leaseId: "lease-capability-invocation-rotated", fencingToken: 2 },
            },
          }),
        }),
      ).rejects.toMatchObject({ code: PORT_ERROR_CODES.NOT_AUTHORITATIVE });
      expect(
        database
          .prepare(
            "SELECT json_extract(record_json, '$.uses') FROM capability_handles WHERE id = ?",
          )
          .pluck()
          .get("handle-capability-invocation"),
      ).toBe(1);
    } finally {
      database?.close();
      await resource.repository.close();
      await rm(resource.stateRoot, { recursive: true });
    }
  });

  it("replays a completed service dispatch after deadline and Handle revocation", async () => {
    const resource = await openRepository();
    let now = T1;
    try {
      await seed(resource.repository);
      const transport = new RecordingServiceTransport();
      let nextId = 0;
      const service = new WorkerDelegationService({
        invocations: resource.repository.capabilityInvocationReceiptPort(OWNER_ID, AGENT_ID),
        invocationAuthority: () => SERVICE_AUTHORITY,
        transport,
        now: () => now,
        nextId: (scope) => `${scope}-service-${++nextId}`,
      });
      const request = serviceRequest();
      await service.dispatch(request);
      expect(transport.requests.map(({ type }) => type)).toEqual(["work.delegate", "work.execute"]);
      await resource.repository
        .capabilityStore(OWNER_ID, AGENT_ID)
        .revokeExecutionHandle(request.payload.capabilityHandleRef, T1);
      now = T2;
      await service.dispatch(request);
      expect(transport.requests.map(({ type }) => type)).toEqual(["work.delegate", "work.execute"]);
    } finally {
      await resource.repository.close();
      await rm(resource.stateRoot, { recursive: true });
    }
  });

  it("does not read an old receipt after Run or capability authority leaves execution", async () => {
    const resource = await openRepository();
    let database: ReturnType<typeof openQualifiedDatabase> | undefined;
    try {
      await seed(resource.repository);
      const opened = await openOperations(resource);
      database = opened.database;
      await expect(
        callOperation(opened.operations, "capabilityInvocation.consume", {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          input: invocation(),
        }),
      ).resolves.toMatchObject({ replayed: false });
      const read = () =>
        callOperation(opened.operations, "capabilityInvocation.read", {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          input: readInvocation(),
        });
      database
        .prepare("UPDATE runs SET status = 'completed', revision = 1, updated_at = ? WHERE id = ?")
        .run(T1, RUN_ID);
      await expect(read()).rejects.toMatchObject({ code: PORT_ERROR_CODES.HANDLE_REVOKED });
      database
        .prepare("UPDATE runs SET status = 'running', revision = 2, updated_at = ? WHERE id = ?")
        .run(T1, RUN_ID);
      const capabilityRow = database
        .prepare("SELECT record_json AS recordJson FROM capability_declarations WHERE id = ?")
        .get("capability-invocation") as { readonly recordJson: string };
      const revokedCapability = {
        ...(JSON.parse(capabilityRow.recordJson) as CapabilityRegistryRecord),
        revision: 2,
        lifecycle: "revoked" as const,
        updatedAt: T1,
      };
      database
        .prepare(
          "UPDATE capability_declarations SET revision = 2, status = 'disabled', record_json = ? WHERE id = ?",
        )
        .run(JSON.stringify(revokedCapability), "capability-invocation");
      await expect(read()).rejects.toMatchObject({ code: PORT_ERROR_CODES.HANDLE_REVOKED });
      const versionDrift = {
        ...revokedCapability,
        revision: 3,
        lifecycle: "active" as const,
        declaration: { ...revokedCapability.declaration, version: "2.0.0" },
        updatedAt: T1,
      };
      database
        .prepare(
          "UPDATE capability_declarations SET revision = 3, version = '2.0.0', status = 'active', record_json = ? WHERE id = ?",
        )
        .run(JSON.stringify(versionDrift), "capability-invocation");
      await expect(read()).rejects.toMatchObject({ code: PORT_ERROR_CODES.HANDLE_REVOKED });
    } finally {
      database?.close();
      await resource.repository.close();
      await rm(resource.stateRoot, { recursive: true });
    }
  });

  it("records a late output observation after the Run becomes terminal", async () => {
    const resource = await openRepository();
    let database: ReturnType<typeof openQualifiedDatabase> | undefined;
    try {
      await seed(resource.repository);
      const opened = await openOperations(resource);
      database = opened.database;
      await expect(
        callOperation(opened.operations, "capabilityInvocation.consume", {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          input: invocation(),
        }),
      ).resolves.toMatchObject({ replayed: false });
      database
        .prepare(
          "UPDATE runs SET status = 'completed', revision = revision + 1, updated_at = ? WHERE id = ?",
        )
        .run(T1, RUN_ID);

      await expect(
        callOperation(opened.operations, "capabilityInvocationResult.observeOutput", {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          input: outputObservation(),
        }),
      ).resolves.toMatchObject({
        replayed: false,
        artifact: {
          runId: RUN_ID,
          purpose: "worker_result",
          operationKey: "capability-output:invocation-capability-invocation",
        },
      });
      expect(
        database
          .prepare(
            "SELECT COUNT(*) FROM run_payload_artifacts WHERE run_id = ? AND purpose = 'worker_result'",
          )
          .pluck()
          .get(RUN_ID),
      ).toBe(1);
    } finally {
      database?.close();
      await resource.repository.close();
      await rm(resource.stateRoot, { recursive: true });
    }
  });

  it("replays equivalent output bytes and rejects a conflicting observation", async () => {
    const resource = await openRepository();
    let database: ReturnType<typeof openQualifiedDatabase> | undefined;
    try {
      await seed(resource.repository);
      const opened = await openOperations(resource);
      database = opened.database;
      await expect(
        callOperation(opened.operations, "capabilityInvocation.consume", {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          input: invocation(),
        }),
      ).resolves.toMatchObject({ replayed: false });

      const first = await callOperation(
        opened.operations,
        "capabilityInvocationResult.observeOutput",
        {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          input: outputObservation(),
        },
      );
      expect(first).toMatchObject({
        replayed: false,
        ref: "payload-capability-invocation-output",
      });
      await expect(
        callOperation(opened.operations, "capabilityInvocationResult.observeOutput", {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          input: outputObservation({
            now: T2,
            payload: outputPayload(
              "payload-capability-invocation-output-retry",
              "sha256:capability-invocation-output",
              new Uint8Array([0x31, 0x32]),
            ),
          }),
        }),
      ).resolves.toMatchObject({
        replayed: true,
        ref: "payload-capability-invocation-output",
      });
      await expect(
        callOperation(opened.operations, "capabilityInvocationResult.observeOutput", {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          input: outputObservation({
            payload: outputPayload(
              "payload-capability-invocation-output-conflict",
              "sha256:capability-invocation-output-conflict",
            ),
          }),
        }),
      ).rejects.toMatchObject({ code: "PORT_CONFLICT" });

      await expect(
        callOperation(opened.operations, "capabilityInvocationResult.lookupFrozen", {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          input: readInvocation({ now: T2 }),
        }),
      ).resolves.toMatchObject({ invocationId: "invocation-capability-invocation" });
      await expect(
        callOperation(opened.operations, "capabilityInvocationResult.lookupOutput", {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          input: readInvocation({ now: T2 }),
        }),
      ).resolves.toMatchObject({
        payloadRef: "payload-capability-invocation-output",
        operationKey: "capability-output:invocation-capability-invocation",
      });
      expect(
        database
          .prepare(
            "SELECT COUNT(*) FROM payloads WHERE ref LIKE 'payload-capability-invocation-output%'",
          )
          .pluck()
          .get(),
      ).toBe(1);
    } finally {
      database?.close();
      await resource.repository.close();
      await rm(resource.stateRoot, { recursive: true });
    }
  });

  it("rejects old attempt identities and a legal rotated lease without writing output", async () => {
    const resource = await openRepository();
    let database: ReturnType<typeof openQualifiedDatabase> | undefined;
    try {
      await seed(resource.repository);
      const opened = await openOperations(resource);
      database = opened.database;
      await expect(
        callOperation(opened.operations, "capabilityInvocation.consume", {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          input: invocation(),
        }),
      ).resolves.toMatchObject({ replayed: false });
      await expect(
        callOperation(opened.operations, "capabilityInvocationResult.observeOutput", {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          input: outputObservation({
            authority: {
              ...SERVICE_AUTHORITY,
              workerBootId: "worker-boot-capability-invocation-old",
            },
          }),
        }),
      ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });

      database
        .prepare(
          "UPDATE deployments SET revision = 1, authority_epoch = 2, fencing_token = 2 WHERE id = ?",
        )
        .run("deployment-capability-invocation");
      database
        .prepare("UPDATE authority_leases SET released_at = ? WHERE id = ?")
        .run(T1, "lease-capability-invocation");
      database
        .prepare(
          `INSERT INTO authority_leases (
            id, owner_id, agent_id, deployment_id, holder_id, authority_epoch,
            fencing_token, acquired_at, expires_at
          ) VALUES ('lease-capability-invocation-rotated-result', ?, ?,
            'deployment-capability-invocation', 'holder-capability-invocation-rotated-result',
            2, 2, ?, '2999-12-31T23:59:59.999Z')`,
        )
        .run(OWNER_ID, AGENT_ID, T1);
      await expect(
        callOperation(opened.operations, "capabilityInvocationResult.observeOutput", {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          input: outputObservation({
            authority: {
              ...SERVICE_AUTHORITY,
              product: {
                ...SERVICE_AUTHORITY.product,
                authorityEpoch: 2,
                fencingToken: 2,
              },
              lease: {
                leaseId: "lease-capability-invocation-rotated-result",
                fencingToken: 2,
              },
            },
          }),
        }),
      ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
      expect(
        database
          .prepare("SELECT COUNT(*) FROM run_payload_artifacts WHERE purpose = 'worker_result'")
          .pluck()
          .get(),
      ).toBe(0);
      expect(
        database
          .prepare(
            "SELECT COUNT(*) FROM payloads WHERE ref = 'payload-capability-invocation-output'",
          )
          .pluck()
          .get(),
      ).toBe(0);
    } finally {
      database?.close();
      await resource.repository.close();
      await rm(resource.stateRoot, { recursive: true });
    }
  });

  it("rolls back a protected output when the artifact receipt insert fails", async () => {
    const resource = await openRepository();
    let database: ReturnType<typeof openQualifiedDatabase> | undefined;
    try {
      await seed(resource.repository);
      const opened = await openOperations(resource);
      database = opened.database;
      await expect(
        callOperation(opened.operations, "capabilityInvocation.consume", {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          input: invocation(),
        }),
      ).resolves.toMatchObject({ replayed: false });
      database.exec(`
        CREATE TRIGGER test_capability_invocation_observation_abort
        BEFORE INSERT ON run_payload_artifacts
        BEGIN SELECT RAISE(ABORT, 'test observation receipt failure'); END;
      `);

      await expect(
        callOperation(opened.operations, "capabilityInvocationResult.observeOutput", {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          input: outputObservation(),
        }),
      ).rejects.toThrow("test observation receipt failure");
      expect(
        database
          .prepare(
            "SELECT COUNT(*) FROM payloads WHERE ref = 'payload-capability-invocation-output'",
          )
          .pluck()
          .get(),
      ).toBe(0);
      expect(
        database
          .prepare("SELECT COUNT(*) FROM run_payload_artifacts WHERE purpose = 'worker_result'")
          .pluck()
          .get(),
      ).toBe(0);
      expect(
        database
          .prepare(
            "SELECT json_extract(record_json, '$.uses') FROM capability_handles WHERE id = ?",
          )
          .pluck()
          .get("handle-capability-invocation"),
      ).toBe(1);
      expect(database.prepare("SELECT status FROM runs WHERE id = ?").pluck().get(RUN_ID)).toBe(
        "running",
      );
    } finally {
      database?.close();
      await resource.repository.close();
      await rm(resource.stateRoot, { recursive: true });
    }
  });

  it("rejects output observations outside the frozen classification, media, or byte ceiling", async () => {
    const resource = await openRepository();
    let database: ReturnType<typeof openQualifiedDatabase> | undefined;
    try {
      await seed(resource.repository);
      const opened = await openOperations(resource);
      database = opened.database;
      await expect(
        callOperation(opened.operations, "capabilityInvocation.consume", {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          input: invocation(),
        }),
      ).resolves.toMatchObject({ replayed: false });
      await expect(
        callOperation(opened.operations, "capabilityInvocationResult.observeOutput", {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          input: outputObservation({
            payload: { ...outputPayload(), dataClassification: "public" },
          }),
        }),
      ).rejects.toMatchObject({ code: "PORT_INVALID_OPERATION" });
      await expect(
        callOperation(opened.operations, "capabilityInvocationResult.observeOutput", {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          input: outputObservation({
            payload: { ...outputPayload(), contentType: "not-a-media-type" },
          }),
        }),
      ).rejects.toMatchObject({ code: "PORT_INVALID_OPERATION" });
      await expect(
        callOperation(opened.operations, "capabilityInvocationResult.observeOutput", {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          input: outputObservation({ plaintextByteLength: 4097 }),
        }),
      ).rejects.toMatchObject({ code: "PORT_INVALID_OPERATION" });
      expect(
        database
          .prepare("SELECT COUNT(*) FROM run_payload_artifacts WHERE purpose = 'worker_result'")
          .pluck()
          .get(),
      ).toBe(0);
      expect(
        database
          .prepare(
            "SELECT COUNT(*) FROM payloads WHERE ref = 'payload-capability-invocation-output'",
          )
          .pluck()
          .get(),
      ).toBe(0);
    } finally {
      database?.close();
      await resource.repository.close();
      await rm(resource.stateRoot, { recursive: true });
    }
  });

  it("requires the invocation observation writer to run inside a transaction", async () => {
    const resource = await openRepository();
    let database: ReturnType<typeof openQualifiedDatabase> | undefined;
    try {
      const opened = await openOperations(resource);
      database = opened.database;
      const writer = new SqliteRunPayloadArtifactOperations(
        database,
        (code: string, message: string, details?: Readonly<Record<string, string>>): never => {
          throw new ApplicationPortError(code as PortErrorCode, message, details);
        },
        () => undefined,
      );
      let error: unknown;
      try {
        writer.commitInvocationObservationWithinTransaction({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          runId: RUN_ID,
          invocationId: "invocation-capability-invocation",
          authority: {
            product: SERVICE_AUTHORITY.product,
            lease: SERVICE_AUTHORITY.lease,
          },
          now: T1,
          payload: outputPayload(),
        });
      } catch (candidate) {
        error = candidate;
      }
      expect(error).toMatchObject({ code: "PORT_INVALID_OPERATION" });
    } finally {
      database?.close();
      await resource.repository.close();
      await rm(resource.stateRoot, { recursive: true });
    }
  });

  it("removes the receipt, observation, and protected output when the Run is deleted", async () => {
    const resource = await openRepository();
    let database: ReturnType<typeof openQualifiedDatabase> | undefined;
    try {
      await seed(resource.repository);
      const opened = await openOperations(resource);
      database = opened.database;
      await expect(
        callOperation(opened.operations, "capabilityInvocation.consume", {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          input: invocation(),
        }),
      ).resolves.toMatchObject({ replayed: false });
      await expect(
        callOperation(opened.operations, "capabilityInvocationResult.observeOutput", {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          input: outputObservation(),
        }),
      ).resolves.toMatchObject({ replayed: false });
      database.close();
      database = undefined;
      await resource.repository.close();
      await mkdir(path.join(resource.stateRoot, "data"), { recursive: true });
      await rename(
        path.join(resource.stateRoot, "product.sqlite"),
        path.join(resource.stateRoot, "data", "product.sqlite"),
      );
      const deletion = new SqliteGovernedDeletionAdapter({
        stateRoot: resource.stateRoot,
        databasePath: path.join(resource.stateRoot, "data", "product.sqlite"),
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        now: () => T1,
      });
      await deletion.deleteImmediately({ objectType: "run", objectId: RUN_ID });
      const after = openQualifiedDatabase(path.join(resource.stateRoot, "data", "product.sqlite"));
      try {
        expect(
          after
            .prepare("SELECT COUNT(*) FROM capability_invocation_receipts WHERE run_id = ?")
            .pluck()
            .get(RUN_ID),
        ).toBe(0);
        expect(
          after
            .prepare("SELECT COUNT(*) FROM run_payload_artifacts WHERE run_id = ?")
            .pluck()
            .get(RUN_ID),
        ).toBe(0);
        expect(
          after
            .prepare(
              "SELECT COUNT(*) FROM payloads WHERE ref = 'payload-capability-invocation-output'",
            )
            .pluck()
            .get(),
        ).toBe(0);
        const afterOperations = operationsForDatabase(after);
        await expect(
          callOperation(afterOperations, "capabilityInvocationResult.lookupFrozen", {
            ownerId: OWNER_ID,
            agentId: AGENT_ID,
            input: readInvocation(),
          }),
        ).resolves.toBeUndefined();
        await expect(
          callOperation(afterOperations, "capabilityInvocationResult.observeOutput", {
            ownerId: OWNER_ID,
            agentId: AGENT_ID,
            input: outputObservation(),
          }),
        ).rejects.toMatchObject({ code: "PORT_NOT_FOUND" });
      } finally {
        after.close();
      }
    } finally {
      database?.close();
      await resource.repository.close();
      await rm(resource.stateRoot, { recursive: true });
    }
  });
});
