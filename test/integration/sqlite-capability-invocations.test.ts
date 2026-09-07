import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ApprovalRequest,
  CapabilityInvocationAuthority,
  CapabilityRegistryRecord,
  ExecutionTransportPort,
  FrozenCapabilityInvocationReceipt,
  GovernedCapabilityExecutionHandle,
  GrantRecord,
  PayloadRecord,
  SandboxExecutionPlan,
  SandboxJobReceipt,
} from "@himawari-agent/application";
import {
  ApplicationPortError,
  CapabilityHandleService,
  type CapabilityManifest,
  PORT_ERROR_CODES,
  type PortErrorCode,
  type RuntimeToolInvocation,
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
import { ProductionRuntimeTools } from "../../apps/agent-service/src/production-runtime-tools.js";
import { createProductionWorkerParentBindingRegistry } from "../../apps/agent-service/src/production-worker-parent-binding-registry.js";

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
  it("routes capability result operations through the public Repository", async () => {
    const resource = await openRepository();
    try {
      await seed(resource.repository);
      const request = serviceRequest();
      const service = new WorkerDelegationService({
        invocations: resource.repository.capabilityInvocationReceiptPort(OWNER_ID, AGENT_ID),
        invocationAuthority: () => SERVICE_AUTHORITY,
        now: () => T1,
        nextId: (scope) => `${scope}:result-routing`,
        transport: new RecordingServiceTransport(),
      });
      await service.dispatch(request);
      const results = resource.repository.capabilityInvocationResultPort(OWNER_ID, AGENT_ID);
      const lookup = {
        handleRef: request.payload.capabilityHandleRef,
        invocationId: request.messageId,
        authority: SERVICE_AUTHORITY,
        now: T1,
      };
      expect(await results.lookupFrozen(lookup)).toMatchObject({ invocationId: request.messageId });
      expect(await results.lookupOutput(lookup)).toBeUndefined();
      expect(
        await results.observeOutput({
          ...lookup,
          payload: outputPayload(),
          plaintextByteLength: 2,
        }),
      ).toMatchObject({ replayed: false });
      expect(await results.lookupOutput(lookup)).toMatchObject({ payloadRef: outputPayload().ref });
      expect(
        await results.observeOutput({
          ...lookup,
          payload: outputPayload(),
          plaintextByteLength: 2,
        }),
      ).toMatchObject({ replayed: true });
    } finally {
      await resource.repository.close();
      await rm(resource.stateRoot, { recursive: true });
    }
  });

  it("scopes directory state reads to both Owner and Agent", async () => {
    const resource = await openRepository();
    try {
      const database = openQualifiedDatabase(path.join(resource.stateRoot, "product.sqlite"));
      try {
        database
          .prepare(
            "INSERT INTO product_state_records (key, owner_id, agent_id, revision, value_json, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
          )
          .run(
            "host-workspace:directory-grant:test",
            OWNER_ID,
            AGENT_ID,
            JSON.stringify({ id: "test" }),
            T1,
          );
      } finally {
        database.close();
      }
      const key = "host-workspace:directory-grant:test";
      expect(await resource.repository.readScopedState(OWNER_ID, AGENT_ID, key)).toMatchObject({
        revision: 1,
        value: { id: "test" },
      });
      expect(
        await resource.repository.readScopedState(OTHER_OWNER_ID, AGENT_ID, key),
      ).toBeUndefined();
      expect(
        await resource.repository.readScopedState(OWNER_ID, OTHER_AGENT_ID, key),
      ).toBeUndefined();
    } finally {
      await resource.repository.close();
      await rm(resource.stateRoot, { recursive: true });
    }
  });

  it("persists both dynamically issued file phases across a database reopen", async () => {
    const resource = await openRepository();
    let repository = resource.repository;
    let sequence = 0;
    const clock = { now: () => T1 };
    const ids = { next: (scope: string) => `${scope}:${++sequence}` };
    const manifest: CapabilityManifest = {
      ...capability().declaration,
      manifestVersion: "capability.v2",
      operations: ["inspect", "read", "disclose"],
      sourceIdentity: "test",
      artifact: {
        digest: "test",
        signatureStatus: "not_applicable",
        signerRef: null,
        rollbackArtifactRef: null,
      },
      scopes: {
        dataClassifications: ["private"],
        network: [],
        filesystem: ["/fixture"],
        secrets: [],
      },
      cost: { currency: "USD", maxMicrosPerInvocation: 0 },
      health: { status: "healthy", checkedAt: T0 },
      reviewedBy: null,
      reviewedAt: null,
      contractCompatibility: ["host-file.v1"],
      runtime: {
        kind: "program",
        argv: ["fixture"],
        environmentKeys: [],
        workdirRef: "fixture",
        stdin: "protected_payload",
        stdout: "protected_payload",
        subprocesses: [],
        network: [],
        filesystem: ["/fixture"],
      },
    };
    const peer = { ...SERVICE_AUTHORITY.product, ...SERVICE_AUTHORITY };
    const parents = createProductionWorkerParentBindingRegistry({ trustedPeerBinding: () => peer });
    const requests: Extract<ExecutionV2Request, { type: "work.execute" }>[] = [];
    const grant = {
      id: "directory:fixture",
      revision: 1,
      hostId: "host:fixture",
      canonicalRootId: "1:2",
      displayPath: "/fixture",
      operations: ["read"] as const,
      dataClassification: "private" as const,
      disclosure: "model" as const,
      pathPolicy: "same_filesystem_no_links" as const,
      mountPolicy: "fixed_device" as const,
      authorizationRef: "directory:approval",
      expiresAt: T2,
      revokedAt: null,
    };
    const target = {
      hostId: grant.hostId,
      grantId: grant.id,
      grantRevision: 1,
      canonicalRootId: grant.canonicalRootId,
      authorizationRef: grant.authorizationRef,
      requestedPath: "note.txt",
      relativePath: "note.txt",
      maximumBytes: 1000,
      observedAt: T1,
      identity: {
        canonicalPath: "/fixture/note.txt",
        device: "1",
        inode: "3",
        mode: 0o100600,
        linkCount: 1,
        sizeBytes: 7,
        modifiedAtMillis: 0,
      },
    };
    const call: RuntimeToolInvocation = {
      runId: RUN_ID,
      toolCallId: "dynamic-file",
      capabilityRef: "host.file.read",
      capabilityHandleRef: null,
      arguments: { path: "note.txt" },
      dataClassification: "private",
      executionDeadlineAt: T2,
      context: {
        threadId: "thread-capability-invocation" as NonNullable<
          NonNullable<RuntimeToolInvocation["context"]>["threadId"]
        >,
        modelRef: "model:test",
        executionLease: {
          executionLeaseId: "execution:fixture" as NonNullable<
            RuntimeToolInvocation["context"]
          >["executionLease"]["executionLeaseId"],
          expectedLeaseRevision: 1,
          authorityLeaseId: SERVICE_AUTHORITY.lease.leaseId,
          authorityFencingToken: 1,
          ...SERVICE_AUTHORITY.product,
          consumerId: "consumer:fixture",
        },
      },
    };
    const create = () => {
      const capabilities = repository.capabilityStore(OWNER_ID, AGENT_ID);
      const handles = new CapabilityHandleService({ store: capabilities, clock, ids });
      const results = repository.capabilityInvocationResultPort(OWNER_ID, AGENT_ID);
      return new ProductionRuntimeTools({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        capabilities,
        clock,
        ids,
        authority: () => SERVICE_AUTHORITY,
        peer: () => peer,
        parents: parents.writer,
        assertRunActive: async () => {},
        invocations: repository.capabilityInvocationReceiptPort(OWNER_ID, AGENT_ID),
        results,
        payloads: repository.payloadStore(OWNER_ID, AGENT_ID),
        artifacts: repository.runPayloadArtifactPort(OWNER_ID, AGENT_ID, SERVICE_AUTHORITY),
        ceiling: serviceRequest().payload.resourceCeiling,
        protector: {
          protect: async (input) => ({
            ...input,
            ciphertext: input.plaintext,
            encryption: { algorithm: "fixture", keyRef: "fixture-key" },
            contentDigest: createHash("sha256").update(input.plaintext).digest("hex"),
          }),
          unprotect: async ({ payload }) => payload.ciphertext,
        },
        fileRead: {
          binding: async () => ({
            revision: 1,
            hostId: grant.hostId,
            workerInstanceId: peer.workerInstanceId,
            grant,
            capabilityRef: manifest.ref,
            capabilityVersion: manifest.version,
            maximumBytes: 1000,
            threadId: "thread-capability-invocation",
            modelRef: "model:test",
            modelIdentity: "model:test:fixed",
          }),
          issue: (input) => handles.issue(input),
          // This test isolates SQLite durability. Policy/approval semantics are tested with ActionPolicyService separately.
          authorize: async (intent) => ({
            decision: "ALLOW",
            basis: { type: "policy", ref: "policy:fixture" },
            executionScope: {
              capabilityRef: manifest.ref,
              operations: [intent.operation],
              exactResourceRef: intent.resourceRef,
              resourcePrefixes: [],
              maxDataClassification: "private",
              sideEffects: ["none"],
              maxCostMicrosPerUse: 0,
              maxFrequency: { count: 1, intervalMs: null },
            },
          }),
        },
        transport: {
          request: async (message) => {
            if (message.type === "work.delegate")
              return {
                ...message,
                kind: "response",
                type: "work.delegate.accepted",
                messageId: ids.next("accepted"),
                causationId: message.messageId,
                payload: {
                  handleRef: message.payload.handle.ref,
                  workerBootId: peer.workerBootId,
                  acceptedAt: T1,
                },
              };
            if (message.type === "work.execute") requests.push(message);
            return null;
          },
          async *events() {
            const request = requests.at(-1);
            if (!request) return;
            const input = await repository
              .payloadStore(OWNER_ID, AGENT_ID)
              .get(request.payload.inputRef);
            if (!input) throw new Error("test input missing");
            expect(JSON.parse(new TextDecoder().decode(input.ciphertext))).toMatchObject({
              phase: request.payload.operation,
            });
            const bytes = new TextEncoder().encode(
              request.payload.operation === "inspect"
                ? JSON.stringify(target)
                : "fixture file result",
            );
            const payload = outputPayload(
              ids.next("phase-output"),
              createHash("sha256").update(bytes).digest("hex"),
              bytes,
            );
            await results.observeOutput({
              handleRef: request.payload.capabilityHandleRef,
              invocationId: request.messageId,
              authority: SERVICE_AUTHORITY,
              now: T1,
              payload,
              plaintextByteLength: bytes.length,
            });
            yield {
              ...request,
              kind: "event" as const,
              type: "work.result" as const,
              messageId: ids.next("result"),
              causationId: request.messageId,
              payload: {
                requestId: request.messageId,
                cursor: String(requests.length),
                sequence: requests.length,
                completedAt: T1,
                outcome: "succeeded" as const,
                outputRef: payload.ref,
                errorCode: null,
                externalActionId: null,
              },
            };
          },
        },
      });
    };
    try {
      await repository
        .capabilityStore(OWNER_ID, AGENT_ID)
        .create({ ...capability(), declaration: manifest });
      const first = create();
      await first.listAuthorized(RUN_ID, []);
      const result = await first.execute(call);
      expect(result).toMatchObject({ outcome: "succeeded", modelContent: "fixture file result" });
      await repository.close();
      repository = await SqliteProductStateRepository.open({
        stateRoot: resource.stateRoot,
        minimumFreeBytes: 0,
        now: () => T1,
      });
      const restarted = create();
      await restarted.listAuthorized(RUN_ID, []);
      expect(await restarted.execute(call)).toEqual(result);
      expect(requests.map(({ payload }) => payload.operation)).toEqual(["inspect", "read"]);
      for (const { payload } of requests)
        expect(
          await repository
            .capabilityStore(OWNER_ID, AGENT_ID)
            .getExecutionHandle(payload.capabilityHandleRef),
        ).toMatchObject({
          maxUses: 1,
          uses: 1,
          operation: payload.operation,
          inputRefs: [payload.inputRef],
        });
    } finally {
      await repository.close();
      await rm(resource.stateRoot, { recursive: true });
    }
  });

  it("lists only current Run handles with active capability authority", async () => {
    const resource = await openRepository();
    try {
      const value = await seed(resource.repository);
      const store = resource.repository.capabilityStore(OWNER_ID, AGENT_ID);
      if (!store.listRunExecutionHandles) throw new Error("HANDLE_LIST_UNAVAILABLE");
      expect(await store.listRunExecutionHandles(RUN_ID, T1)).toEqual([value]);
      expect(await store.listRunExecutionHandles(RUN_ID, T2)).toEqual([]);
      let record = capability();
      for (const lifecycle of ["update_proposed", "update_approved", "disabled"] as const) {
        record = await store.save(
          { ...record, revision: record.revision + 1, lifecycle },
          record.revision,
        );
        expect(await store.listRunExecutionHandles(RUN_ID, T1)).toEqual(
          lifecycle === "disabled" ? [] : [value],
        );
      }
    } finally {
      await resource.repository.close();
      await rm(resource.stateRoot, { recursive: true });
    }
  });

  it("persists runtime tool intent and failed Worker result without redispatch on restart", async () => {
    const resource = await openRepository();
    try {
      await seed(resource.repository);
      const transport = new RecordingServiceTransport();
      const peer = { ...SERVICE_AUTHORITY.product, ...SERVICE_AUTHORITY };
      const parents = createProductionWorkerParentBindingRegistry({
        trustedPeerBinding: () => peer,
      });
      const registry = resource.repository.capabilityStore(OWNER_ID, AGENT_ID);
      const artifacts = resource.repository.runPayloadArtifactPort(
        OWNER_ID,
        AGENT_ID,
        SERVICE_AUTHORITY,
      );
      let sequence = 0;
      const create = () =>
        new ProductionRuntimeTools({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          capabilities: registry,
          invocations: resource.repository.capabilityInvocationReceiptPort(OWNER_ID, AGENT_ID),
          results: resource.repository.capabilityInvocationResultPort(OWNER_ID, AGENT_ID),
          authority: () => SERVICE_AUTHORITY,
          peer: () => peer,
          parents: parents.writer,
          assertRunActive: async () => {},
          artifacts,
          payloads: resource.repository.payloadStore(OWNER_ID, AGENT_ID),
          protector: {
            protect: async (input) => ({
              ...input,
              ciphertext: input.plaintext,
              encryption: { algorithm: "fixture", keyRef: "fixture-key" },
              contentDigest: createHash("sha256").update(input.plaintext).digest("hex"),
            }),
            unprotect: async ({ payload }) => payload.ciphertext,
          },
          clock: { now: () => T1 },
          ids: { next: (scope) => `${scope}:${++sequence}` },
          ceiling: serviceRequest().payload.resourceCeiling,
          transport: {
            request: (message) => transport.request(message),
            async *events() {
              const request = transport.requests.find((message) => message.type === "work.execute");
              if (!request) return;
              yield {
                ...request,
                kind: "event" as const,
                type: "work.result" as const,
                messageId: "runtime-failed-result",
                causationId: request.messageId,
                payload: {
                  requestId: request.messageId,
                  cursor: "1",
                  sequence: 1,
                  completedAt: T1,
                  outcome: "failed" as const,
                  outputRef: null,
                  errorCode: "TEST_FAILURE",
                  externalActionId: null,
                },
              };
            },
          },
        });
      const call = {
        runId: RUN_ID,
        toolCallId: "runtime-call",
        capabilityRef: handle().capabilityRef,
        capabilityHandleRef: handle().ref,
        arguments: { inputRef: handle().inputRefs[0] ?? "missing" },
        dataClassification: "private" as const,
      };
      const first = create();
      await first.listAuthorized(RUN_ID, [call.capabilityHandleRef]);
      expect(await first.execute(call)).toMatchObject({
        outcome: "failed",
        errorCode: "TEST_FAILURE",
      });
      const restarted = create();
      await restarted.listAuthorized(RUN_ID, [call.capabilityHandleRef]);
      expect(await restarted.execute(call)).toMatchObject({
        outcome: "failed",
        errorCode: "TEST_FAILURE",
      });
      expect(transport.requests.map((message) => message.type)).toEqual([
        "work.delegate",
        "work.execute",
      ]);
      expect(
        (await registry.getExecutionHandle(
          call.capabilityHandleRef,
        )) as GovernedCapabilityExecutionHandle,
      ).toMatchObject({ uses: 1 });
    } finally {
      await resource.repository.close();
      await rm(resource.stateRoot, { recursive: true });
    }
  });

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

async function openSandboxJournal() {
  const resource = await openRepository();
  await seed(resource.repository);
  const { database, operations } = await openOperations(resource);
  const consumed = operations.execute("capabilityInvocation.consume", {
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    input: invocation(),
  }) as { receipt: FrozenCapabilityInvocationReceipt };
  database
    .prepare(`INSERT INTO run_execution_leases (owner_id, agent_id, run_id, revision, authority_lease_id,
    deployment_id, authority_epoch, fencing_token, consumer_id, execution_lease_id, claimed_at, initial_expires_at, expires_at)
    VALUES (?, ?, ?, 1, ?, ?, 1, 1, 'sandbox-consumer', 'sandbox-lease', ?, ?, ?)`)
    .run(
      OWNER_ID,
      AGENT_ID,
      RUN_ID,
      SERVICE_AUTHORITY.lease.leaseId,
      SERVICE_AUTHORITY.product.deploymentId,
      T0,
      T2,
      T2,
    );
  const receipt = consumed.receipt;
  const plan: SandboxExecutionPlan = {
    schemaVersion: "sandbox-execution.v1",
    identity: {
      jobId: "sandbox-job",
      attemptId: "sandbox-attempt",
      receiptRef: receipt.receiptRef,
      invocationId: receipt.invocationId,
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      threadId: "thread-capability-invocation",
      hostId: "sandbox-host",
      toolCallId: "sandbox-tool",
    },
    handleRef: receipt.handleRef,
    inputRef: receipt.inputRef,
    operation: receipt.operation,
    capabilityRef: receipt.capabilityRef,
    capabilityVersion: receipt.capabilityVersion,
    semanticFingerprint: receipt.semanticFingerprint,
    authorizationRef: receipt.authorizationRef,
    modelRef: "model-fixture",
    requestedAt: T1,
    originalDeadlineAt: T2,
    effectiveDeadlineAt: T2,
    resourceCeiling: receipt.resourceCeiling,
    executionLease: {
      executionLeaseId: "sandbox-lease",
      expectedLeaseRevision: 1,
      authorityLeaseId: SERVICE_AUTHORITY.lease.leaseId,
      authorityFencingToken: 1,
      deploymentId: SERVICE_AUTHORITY.product.deploymentId,
      authorityEpoch: 1,
      fencingToken: 1,
      consumerId: "sandbox-consumer",
    },
    binding: {
      scopeRef: "scope-fixture",
      scopeDigest: "a".repeat(64),
      profileRef: "profile-fixture",
      runtimeDigest: "b".repeat(64),
      runnerDigest: "c".repeat(64),
      qualificationRef: "qualification-fixture",
      requiredGuarantees: ["filesystem"],
    },
  };
  const prepared: SandboxJobReceipt = {
    schemaVersion: "sandbox-execution.v1",
    identity: plan.identity,
    sequence: 1,
    state: "prepared",
    policyDigest: "d".repeat(64),
    occurredAt: T1,
    outcome: "pending",
    cleanup: "pending",
    effect: "not_started",
    outputRef: null,
    outputDigest: null,
    reasonCode: null,
  };
  const call = (operation: string, input: unknown) =>
    operations.execute(`capabilityInvocation.sandbox${operation}`, {
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      input,
    });
  const append = (observation: SandboxJobReceipt, now = T1) =>
    call("Append", { observation, authority: SERVICE_AUTHORITY, now });
  const prepare = () =>
    call("Prepare", { plan, observation: prepared, authority: SERVICE_AUTHORITY, now: T1 });
  const close = async () => {
    if (database.open) database.close();
    await rm(resource.stateRoot, { recursive: true, force: true });
  };
  return { resource, database, plan, prepared, call, append, prepare, close };
}

describe("durable sandbox invocation journal", () => {
  it("persists a single start intent across reopen and rejects another start", async () => {
    const fixture = await openSandboxJournal();
    try {
      expect(fixture.prepare()).toMatchObject({ applied: true });
      const starting = { ...fixture.prepared, sequence: 2, state: "starting" as const };
      expect(fixture.append(starting)).toMatchObject({ applied: true });
      expect(fixture.append(starting)).toMatchObject({ applied: false });
      expect(() => fixture.append({ ...starting, sequence: 3 })).toThrow("only one start intent");
      fixture.database.close();
      const reopened = await SqliteProductStateRepository.open({
        stateRoot: fixture.resource.stateRoot,
        minimumFreeBytes: 0,
        now: () => T1,
      });
      try {
        expect(
          await reopened.sandboxJobJournal(OWNER_ID, AGENT_ID).read(fixture.plan.identity),
        ).toMatchObject({ observation: { state: "starting", sequence: 2 } });
        expect(
          await reopened
            .sandboxJobJournal(OWNER_ID, AGENT_ID)
            .append({ observation: starting, authority: SERVICE_AUTHORITY, now: T1 }),
        ).toMatchObject({ applied: false });
      } finally {
        await reopened.close();
      }
    } finally {
      await fixture.close();
    }
  });

  it.each(["lease", "handle", "run"])(
    "rejects start after %s authority changes without appending",
    async (kind) => {
      const fixture = await openSandboxJournal();
      try {
        fixture.prepare();
        if (kind === "lease")
          fixture.database.prepare("UPDATE run_execution_leases SET revision = revision + 1").run();
        if (kind === "handle")
          fixture.database
            .prepare(
              "UPDATE capability_handles SET record_json = json_set(record_json, '$.revokedAt', ?)",
            )
            .run(T1);
        if (kind === "run") fixture.database.prepare("UPDATE runs SET status = 'cancelled'").run();
        expect(() =>
          fixture.append({ ...fixture.prepared, sequence: 2, state: "starting" }),
        ).toThrow();
        expect(fixture.call("Read", fixture.plan.identity)).toMatchObject({
          observation: { sequence: 1 },
        });
        expect(
          fixture.database.prepare("SELECT count(*) AS count FROM sandbox_job_observations").get(),
        ).toEqual({ count: 1 });
      } finally {
        await fixture.close();
      }
    },
  );

  it("records cleanup after deadline while forbidding a new execution", async () => {
    const fixture = await openSandboxJournal();
    try {
      fixture.prepare();
      expect(() =>
        fixture.append({ ...fixture.prepared, sequence: 2, state: "starting", occurredAt: T2 }, T2),
      ).toThrow();
      const stopping = {
        ...fixture.prepared,
        sequence: 2,
        state: "stopping" as const,
        occurredAt: T2,
      };
      expect(fixture.append(stopping, T2)).toMatchObject({ applied: true });
      const unknown = {
        ...stopping,
        sequence: 3,
        state: "reconciling" as const,
        effect: "unknown" as const,
        cleanup: "unknown" as const,
        outcome: "unknown" as const,
        reasonCode: "worker_lost",
      };
      expect(fixture.append(unknown, T2)).toMatchObject({ applied: true });
      expect(() => fixture.append({ ...unknown, sequence: 4, state: "starting" }, T2)).toThrow();
    } finally {
      await fixture.close();
    }
  });

  it("removes job metadata and history with its owning Run", async () => {
    const fixture = await openSandboxJournal();
    try {
      fixture.prepare();
      fixture.append({ ...fixture.prepared, sequence: 2, state: "starting" });
      fixture.database.prepare("DELETE FROM runs WHERE id = ?").run(RUN_ID);
      expect(fixture.database.prepare("SELECT count(*) AS count FROM sandbox_jobs").get()).toEqual({
        count: 0,
      });
      expect(
        fixture.database.prepare("SELECT count(*) AS count FROM sandbox_job_observations").get(),
      ).toEqual({ count: 0 });
      expect(fixture.database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("does not prepare an invocation that already has a legacy durable result", async () => {
    const fixture = await openSandboxJournal();
    try {
      operationsForDatabase(fixture.database).execute("capabilityInvocationResult.observeOutput", {
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        input: outputObservation(),
      });
      expect(() => fixture.prepare()).toThrow("already has a durable output");
      expect(fixture.call("Read", fixture.plan.identity)).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });

  it("rolls back the latest sequence if observation persistence fails", async () => {
    const fixture = await openSandboxJournal();
    try {
      fixture.prepare();
      fixture.database.exec(
        "CREATE TEMP TRIGGER fail_sandbox_observation BEFORE INSERT ON sandbox_job_observations BEGIN SELECT RAISE(ABORT, 'synthetic journal failure'); END;",
      );
      expect(() => fixture.append({ ...fixture.prepared, sequence: 2, state: "starting" })).toThrow(
        "synthetic journal failure",
      );
      expect(fixture.call("Read", fixture.plan.identity)).toMatchObject({
        observation: { sequence: 1, state: "prepared" },
      });
    } finally {
      await fixture.close();
    }
  });

  it("requires protected output persistence before completion and forbids restarting a completed job", async () => {
    const fixture = await openSandboxJournal();
    try {
      fixture.prepare();
      fixture.append({ ...fixture.prepared, sequence: 2, state: "starting" });
      fixture.append({ ...fixture.prepared, sequence: 3, state: "running" });
      fixture.append({ ...fixture.prepared, sequence: 4, state: "stopping" });
      const completed: SandboxJobReceipt = {
        ...fixture.prepared,
        sequence: 5,
        state: "completed",
        outcome: "succeeded",
        effect: "confirmed",
        cleanup: "confirmed",
        outputRef: "payload-sandbox-output",
        outputDigest: "f".repeat(64),
      };
      expect(() => fixture.append(completed)).toThrow("not durably bound");
      operationsForDatabase(fixture.database).execute("capabilityInvocationResult.observeOutput", {
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        input: outputObservation({
          payload: outputPayload(completed.outputRef as string, `sha256:${completed.outputDigest}`),
        }),
      });
      expect(fixture.call("ListPending", { afterJobId: null, limit: 10 })).toHaveLength(1);
      expect(fixture.append(completed)).toMatchObject({ applied: true });
      expect(fixture.call("ListPending", { afterJobId: null, limit: 10 })).toEqual([]);
      expect(() => fixture.append({ ...completed, sequence: 6, state: "starting" })).toThrow();
    } finally {
      await fixture.close();
    }
  });

  it("rejects plan replacement, a second attempt, policy replacement and foreign reads", async () => {
    const fixture = await openSandboxJournal();
    try {
      fixture.prepare();
      expect(() =>
        fixture.call("Prepare", {
          plan: { ...fixture.plan, inputRef: "replaced" },
          observation: fixture.prepared,
          authority: SERVICE_AUTHORITY,
          now: T1,
        }),
      ).toThrow();
      const identity = {
        ...fixture.plan.identity,
        jobId: "another-job",
        attemptId: "another-attempt",
      };
      expect(() =>
        fixture.call("Prepare", {
          plan: { ...fixture.plan, identity },
          observation: { ...fixture.prepared, identity },
          authority: SERVICE_AUTHORITY,
          now: T1,
        }),
      ).toThrow("already owns");
      expect(() =>
        fixture.append({
          ...fixture.prepared,
          sequence: 2,
          state: "starting",
          policyDigest: "e".repeat(64),
        }),
      ).toThrow();
      expect(() =>
        fixture.call("Read", { ...fixture.plan.identity, ownerId: OTHER_OWNER_ID }),
      ).toThrow();
    } finally {
      await fixture.close();
    }
  });
});
