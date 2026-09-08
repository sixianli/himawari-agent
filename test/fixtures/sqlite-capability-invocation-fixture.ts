import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ApprovalRequest,
  CapabilityInvocationAuthority,
  CapabilityRegistryRecord,
  FrozenCapabilityInvocationReceipt,
  GovernedCapabilityExecutionHandle,
  GrantRecord,
  HostDirectoryGrant,
  PayloadRecord,
  SandboxExecutionPlan,
  SandboxJobReceipt,
} from "@himawari-agent/application";
import { ApplicationPortError, type PortErrorCode } from "@himawari-agent/application";
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
  type ExecutionV2Request,
  executionV2MessageSchema,
} from "@himawari-agent/execution-contracts";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteCapabilityInvocationOperations,
  SqliteProductStateRepository,
  SqliteRunPayloadArtifactOperations,
} from "@himawari-agent/persistence-sqlite";
import {
  EnvelopePayloadProtector,
  InMemoryDevelopmentSecretSource,
} from "@himawari-agent/platform-node";

export const OWNER_ID = createOwnerId("owner-capability-invocation");

export const AGENT_ID = createAgentId("agent-capability-invocation");

export const OTHER_OWNER_ID = createOwnerId("owner-other-capability-invocation");

export const OTHER_AGENT_ID = createAgentId("agent-other-capability-invocation");

export const RUN_ID = createRunId("run-capability-invocation");

export const LIVE_SANDBOX = process.env["HIMAWARI_LIVE_SANDBOX_PROBE"] === "1";

export const probeTime = Date.now();

export const T0 = LIVE_SANDBOX
  ? new Date(probeTime - 1000).toISOString()
  : "2026-09-04T00:00:00.000Z";

export const T1 = LIVE_SANDBOX ? new Date(probeTime).toISOString() : "2026-09-04T00:00:01.000Z";

export const T2 = LIVE_SANDBOX
  ? new Date(probeTime + 300000).toISOString()
  : "2026-09-04T00:05:00.000Z";

export const SERVICE_AUTHORITY: CapabilityInvocationAuthority = {
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

export function serviceRequest(): Extract<ExecutionV2Request, { type: "work.execute" }> {
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
        maxWallTimeMs: LIVE_SANDBOX ? 30000 : 1000,
        maxCpuTimeMs: LIVE_SANDBOX ? 10000 : 1000,
        maxMemoryBytes: LIVE_SANDBOX ? 268435456 : 1_000_000,
        maxOutputBytes: 4096,
        maxProgressEvents: 10,
      },
      requestedAt: T0,
      deadlineAt: T2,
    },
  }) as Extract<ExecutionV2Request, { type: "work.execute" }>;
}

export async function openRepository(): Promise<{
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

export function capability(): CapabilityRegistryRecord {
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

export function handle(): GovernedCapabilityExecutionHandle {
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

export function grantApproval(): ApprovalRequest {
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

export function grant(): GrantRecord {
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

export function grantHandle(): GovernedCapabilityExecutionHandle {
  return {
    ...handle(),
    ref: "handle-capability-invocation-grant",
    authorization: { type: "grant", ref: "grant-capability-invocation" },
    authorizationRef: "grant-capability-invocation",
    maxUses: 2,
  };
}

export function invocation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
      maxWallTimeMs: LIVE_SANDBOX ? 30000 : 1000,
      maxCpuTimeMs: LIVE_SANDBOX ? 10000 : 1000,
      maxMemoryBytes: LIVE_SANDBOX ? 268435456 : 1_000_000,
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

export function readInvocation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

export function outputPayload(
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

export function outputObservation(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
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

export function operationsForDatabase(
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

export async function openOperations(resource: {
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

export function callOperation(
  operations: SqliteCapabilityInvocationOperations,
  operation: string,
  payload: unknown,
): Promise<unknown> {
  return Promise.resolve().then(() => operations.execute(operation, payload));
}

export async function seed(
  repository: SqliteProductStateRepository,
): Promise<GovernedCapabilityExecutionHandle> {
  const capabilities = repository.capabilityStore(OWNER_ID, AGENT_ID);
  await capabilities.create(capability());
  const value = handle();
  await capabilities.createExecutionHandle(value);
  return value;
}

export async function openSandboxJournal(legacy = false) {
  const resource = await openRepository();
  await seed(resource.repository);
  const { database, operations } = await openOperations(resource);
  database.exec("SAVEPOINT preview_receipt");
  const consumed = operations.execute("capabilityInvocation.consume", {
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    input: invocation(),
  }) as { receipt: FrozenCapabilityInvocationReceipt };
  if (!legacy) database.exec("ROLLBACK TO preview_receipt");
  database.exec("RELEASE preview_receipt");
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
  const scope = {
    schemaVersion: "sandbox-scope.v1",
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    threadId: "thread-capability-invocation",
    runId: RUN_ID,
    toolCallId: "sandbox-tool",
    parentToolCallId: "parent-tool",
    parentRequestId: "run-admitted-capability-invocation",
    hostId: "sandbox-host",
    handleRef: receipt.handleRef,
    inputRef: receipt.inputRef,
    operation: receipt.operation,
    authorizationRef: receipt.authorizationRef,
    modelRef: "model-fixture",
    profileRef: "profile-fixture",
    directoryGrant: {
      ref: "grant-fixture",
      revision: 1,
      canonicalRootId: "root-fixture",
      authorizationRef: "directory-authorization",
      operations: ["read"],
    },
    networkAuthorizationRef: null,
    expiresAt: T2,
  };
  const directoryGrant: HostDirectoryGrant = {
    id: "grant-fixture",
    revision: 1,
    hostId: "sandbox-host",
    canonicalRootId: "root-fixture",
    displayPath: "/synthetic-workspace",
    operations: ["read"],
    dataClassification: "private",
    disclosure: "worker",
    pathPolicy: "same_filesystem_no_links",
    mountPolicy: "fixed_device",
    authorizationRef: "directory-authorization",
    expiresAt: T2,
    revokedAt: null,
  };
  const files = { readGrant: async () => directoryGrant };
  const protector = new EnvelopePayloadProtector({
    keys: new InMemoryDevelopmentSecretSource({ "scope-test@v1": new Uint8Array(32).fill(42) }),
    activeKey: { keyRef: "scope-test", kekVersion: "v1", dekVersion: "dek-v1" },
  });
  const scopePayload = await protector.protect({
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    ref: "scope-fixture",
    dataClassification: "private",
    contentType: "application/json",
    plaintext: new TextEncoder().encode(JSON.stringify(scope)),
    createdAt: T1,
  });
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
      scopeDigest: scopePayload.contentDigest.slice(7),
      profileRef: "profile-fixture",
      runtimeDigest: "b".repeat(64),
      runnerDigest: "c".repeat(64),
      qualificationRef: "qualification-fixture",
      requiredGuarantees: ["filesystem"],
    },
  };
  const prepared = {
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
  } satisfies SandboxJobReceipt;
  const call = (operation: string, input: unknown) => {
    if (operation === "Prepare") {
      const preparedInput = input as { plan: SandboxExecutionPlan; observation: SandboxJobReceipt };
      const { semanticFingerprint: _fingerprint, ...candidate } = preparedInput.plan;
      return operations.execute("capabilityInvocation.sandboxAdmit", {
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        input: {
          invocation: invocation(),
          plan: candidate,
          observation: preparedInput.observation,
        },
      });
    }
    return operations.execute(`capabilityInvocation.sandbox${operation}`, {
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      input,
    });
  };
  const append = (observation: SandboxJobReceipt, now = T1) =>
    call("Append", { observation, authority: SERVICE_AUTHORITY, now });
  const prepare = () =>
    call("Prepare", { plan, observation: prepared, authority: SERVICE_AUTHORITY, now: T1 });
  const close = async () => {
    if (database.open) database.close();
    await rm(resource.stateRoot, { recursive: true, force: true });
  };
  return {
    resource,
    database,
    plan,
    prepared,
    call,
    append,
    prepare,
    close,
    scope,
    scopePayload,
    protector,
    directoryGrant,
    files,
  };
}
