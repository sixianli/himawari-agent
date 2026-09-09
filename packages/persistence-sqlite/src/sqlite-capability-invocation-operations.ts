import { createHash } from "node:crypto";
import type {
  CapabilityInvocationAuthority,
  CapabilityInvocationConsumeResult,
  CapabilityRegistryRecord,
  CapabilityResourceCeiling,
  CapabilitySecretReference,
  ConsumeCapabilityInvocationInput,
  DataClassification,
  FrozenCapabilityInvocationReceipt,
  GovernedCapabilityExecutionHandle,
  ObserveCapabilityInvocationOutputInput,
  ReadCapabilityInvocationInput,
  RunPayloadArtifact,
  RunPayloadArtifactCommitResult,
  SandboxJobAdmissionResult,
  SandboxJobRecord,
} from "@himawari-agent/application";
import { createAuthorityLeaseId, createDeploymentId } from "@himawari-agent/domain";
import {
  ContractValidationError,
  type SandboxExecutionPlan,
  type SandboxJobIdentity,
  sandboxExecutionPlanSchema,
  sandboxJobIdentitySchema,
  sandboxJobReceiptSchema,
  validateSandboxJobObservation,
} from "@himawari-agent/execution-contracts";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";
import type {
  SqliteCapabilityInvocationObservationInput,
  SqliteRunPayloadArtifactOperations,
} from "./sqlite-run-payload-artifact-operations.ts";
import {
  capabilityInvocationOutputOperationKey,
  parseRunPayloadArtifactPayload,
} from "./sqlite-run-payload-artifact-operations.ts";

import { SqliteSandboxExecutionOperations } from "./sqlite-sandbox-execution-operations.ts";

type ConsumeInput = ConsumeCapabilityInvocationInput;
type ReadInput = ReadCapabilityInvocationInput;
type ObserveInput = ObserveCapabilityInvocationOutputInput;
type FrozenReceipt = FrozenCapabilityInvocationReceipt;
type ConsumeResult = CapabilityInvocationConsumeResult;
type AuthorityInput = CapabilityInvocationAuthority;
type RequestScopeInput = ConsumeInput["requestScope"];
type ResultArtifact = RunPayloadArtifact;
type ResultArtifactCommit = RunPayloadArtifactCommitResult;

interface ScopedOperationInput {
  readonly ownerId: string;
  readonly agentId: string;
  readonly input: unknown;
}

interface ReceiptRow {
  readonly recordJson: string;
}

interface HandleRow extends ReceiptRow {
  readonly handleStatus: string;
  readonly handleExpiresAt: string;
  readonly handleRevokedAt: string | null;
  readonly capabilityStatus: string;
  readonly capabilityJson: string;
  readonly runStatus: string;
}

interface GrantRow {
  readonly recordJson: string | null;
  readonly ownerId: string;
  readonly agentId: string;
}

interface GrantInvocationInput {
  readonly operation: string;
  readonly dataClassification: DataClassification;
  readonly deadlineAt: string;
  readonly consumedAt: string;
}

const CLASSIFICATION_RANK = Object.freeze({ public: 0, private: 1, sensitive: 2, restricted: 3 });
const CAPABILITY_LIFECYCLES_WITH_AUTHORITY = new Set([
  "active",
  "update_proposed",
  "update_approved",
]);
const ALLOWED_AUTHORITY_KEYS = new Set([
  "product",
  "lease",
  "agentServiceInstanceId",
  "agentServiceBootId",
  "workerInstanceId",
  "workerBootId",
]);
const ALLOWED_PRODUCT_KEYS = new Set(["deploymentId", "authorityEpoch", "fencingToken"]);
const ALLOWED_LEASE_KEYS = new Set(["leaseId", "fencingToken"]);
const ALLOWED_SCOPE_KEYS = new Set([
  "deploymentId",
  "authorityEpoch",
  "fencingToken",
  "ownerId",
  "agentId",
  "runId",
  "workerRunId",
]);
const ALLOWED_RESOURCE_KEYS = new Set([
  "maxWallTimeMs",
  "maxCpuTimeMs",
  "maxMemoryBytes",
  "maxOutputBytes",
  "maxProgressEvents",
]);
const ALLOWED_SECRET_KEYS = new Set(["secretRef", "secretVersion", "purpose"]);
const ALLOWED_RESULT_CONTENT_TYPE =
  /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+\/[A-Za-z0-9!#$%&'*+\-.^_`|~]+(?:;[ \t]*[A-Za-z0-9!#$%&'*+\-.^_`|~]+=[A-Za-z0-9!#$%&'*+\-.^_`|~]+)*$/;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label}.${key} is not supported`);
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be non-empty text`);
  }
  return value;
}

function dateText(value: unknown, label: string): string {
  const result = text(value, label);
  if (!Number.isFinite(Date.parse(result))) throw new TypeError(`${label} must be an ISO time`);
  return result;
}

function timestamp(value: string, label: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new TypeError(`${label} must be an ISO time`);
  return result;
}

function safeInteger(value: unknown, label: string, minimum = 1): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${label} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  return safeInteger(value, label, 0);
}

function list(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function classification(value: unknown, label: string): DataClassification {
  if (
    value !== "public" &&
    value !== "private" &&
    value !== "sensitive" &&
    value !== "restricted"
  ) {
    throw new TypeError(`${label} is not a supported data classification`);
  }
  return value;
}

function stringList(value: unknown, label: string): readonly string[] {
  const values = list(value, label).map((candidate, index) =>
    text(candidate, `${label}[${index}]`),
  );
  if (new Set(values).size !== values.length) throw new TypeError(`${label} contains duplicates`);
  return values;
}

function secretList(value: unknown, label: string): readonly CapabilitySecretReference[] {
  const values = list(value, label).map((candidate, index) => {
    const input = record(candidate, `${label}[${index}]`);
    assertKeys(input, ALLOWED_SECRET_KEYS, `${label}[${index}]`);
    return Object.freeze({
      secretRef: text(input["secretRef"], `${label}[${index}].secretRef`),
      secretVersion: text(input["secretVersion"], `${label}[${index}].secretVersion`),
      purpose: text(input["purpose"], `${label}[${index}].purpose`),
    });
  });
  const identities = values.map(
    ({ secretRef, secretVersion, purpose }) => `${secretRef}\u0000${secretVersion}\u0000${purpose}`,
  );
  if (new Set(identities).size !== identities.length) {
    throw new TypeError(`${label} contains duplicate secret identities`);
  }
  return Object.freeze(values);
}

function resourceCeiling(value: unknown): CapabilityResourceCeiling {
  const input = record(value, "resourceCeiling");
  assertKeys(input, ALLOWED_RESOURCE_KEYS, "resourceCeiling");
  return Object.freeze({
    maxWallTimeMs: safeInteger(input["maxWallTimeMs"], "resourceCeiling.maxWallTimeMs"),
    maxCpuTimeMs: safeInteger(input["maxCpuTimeMs"], "resourceCeiling.maxCpuTimeMs"),
    maxMemoryBytes: safeInteger(input["maxMemoryBytes"], "resourceCeiling.maxMemoryBytes"),
    maxOutputBytes: safeInteger(input["maxOutputBytes"], "resourceCeiling.maxOutputBytes"),
    maxProgressEvents: safeInteger(input["maxProgressEvents"], "resourceCeiling.maxProgressEvents"),
  });
}

function authority(value: unknown): AuthorityInput {
  const input = record(value, "authority");
  assertKeys(input, ALLOWED_AUTHORITY_KEYS, "authority");
  const product = record(input["product"], "authority.product");
  assertKeys(product, ALLOWED_PRODUCT_KEYS, "authority.product");
  const lease = record(input["lease"], "authority.lease");
  assertKeys(lease, ALLOWED_LEASE_KEYS, "authority.lease");
  return Object.freeze({
    product: Object.freeze({
      deploymentId: createDeploymentId(
        text(product["deploymentId"], "authority.product.deploymentId"),
      ),
      authorityEpoch: safeInteger(product["authorityEpoch"], "authority.product.authorityEpoch"),
      fencingToken: safeInteger(product["fencingToken"], "authority.product.fencingToken"),
    }),
    lease: Object.freeze({
      leaseId: createAuthorityLeaseId(text(lease["leaseId"], "authority.lease.leaseId")),
      fencingToken: safeInteger(lease["fencingToken"], "authority.lease.fencingToken"),
    }),
    agentServiceInstanceId: text(
      input["agentServiceInstanceId"],
      "authority.agentServiceInstanceId",
    ),
    agentServiceBootId: text(input["agentServiceBootId"], "authority.agentServiceBootId"),
    workerInstanceId: text(input["workerInstanceId"], "authority.workerInstanceId"),
    workerBootId: text(input["workerBootId"], "authority.workerBootId"),
  });
}

function requestScope(value: unknown): RequestScopeInput {
  const input = record(value, "requestScope");
  assertKeys(input, ALLOWED_SCOPE_KEYS, "requestScope");
  return Object.freeze({
    deploymentId: text(input["deploymentId"], "requestScope.deploymentId"),
    authorityEpoch: safeInteger(input["authorityEpoch"], "requestScope.authorityEpoch"),
    fencingToken: safeInteger(input["fencingToken"], "requestScope.fencingToken"),
    ownerId: text(input["ownerId"], "requestScope.ownerId"),
    agentId: text(input["agentId"], "requestScope.agentId"),
    runId: text(input["runId"], "requestScope.runId"),
    workerRunId: text(input["workerRunId"], "requestScope.workerRunId"),
  });
}

function authorizationRef(value: unknown): string | null {
  return value === null ? null : text(value, "authorizationRef");
}

function parseConsume(value: unknown): ConsumeInput {
  const input = record(value, "Capability invocation consume");
  assertKeys(
    input,
    new Set([
      "receiptRef",
      "handleRef",
      "invocationId",
      "requestScope",
      "capabilityRef",
      "capabilityVersion",
      "authorizationRef",
      "idempotencyKey",
      "operation",
      "inputRef",
      "delegatedContextRefs",
      "secretRefs",
      "dataClassification",
      "resourceCeiling",
      "requestedAt",
      "deadlineAt",
      "authority",
      "consumedAt",
    ]),
    "consume",
  );
  const requestedAt = dateText(input["requestedAt"], "requestedAt");
  const deadlineAt = dateText(input["deadlineAt"], "deadlineAt");
  const consumedAt = dateText(input["consumedAt"], "consumedAt");
  if (timestamp(deadlineAt, "deadlineAt") <= timestamp(requestedAt, "requestedAt")) {
    throw new TypeError("deadlineAt must be later than requestedAt");
  }
  return Object.freeze({
    receiptRef: text(input["receiptRef"], "receiptRef"),
    handleRef: text(input["handleRef"], "handleRef"),
    invocationId: text(input["invocationId"], "invocationId"),
    requestScope: requestScope(input["requestScope"]),
    capabilityRef: text(input["capabilityRef"], "capabilityRef"),
    capabilityVersion: text(input["capabilityVersion"], "capabilityVersion"),
    authorizationRef: authorizationRef(input["authorizationRef"]),
    idempotencyKey: text(input["idempotencyKey"], "idempotencyKey"),
    operation: text(input["operation"], "operation"),
    inputRef: text(input["inputRef"], "inputRef"),
    delegatedContextRefs: stringList(input["delegatedContextRefs"], "delegatedContextRefs"),
    secretRefs: secretList(input["secretRefs"], "secretRefs"),
    dataClassification: classification(input["dataClassification"], "dataClassification"),
    resourceCeiling: resourceCeiling(input["resourceCeiling"]),
    requestedAt,
    deadlineAt,
    authority: authority(input["authority"]),
    consumedAt,
  });
}

function parseRead(value: unknown): ReadInput {
  const input = record(value, "Capability invocation read");
  assertKeys(input, new Set(["handleRef", "invocationId", "authority", "now"]), "read");
  return Object.freeze({
    handleRef: text(input["handleRef"], "handleRef"),
    invocationId: text(input["invocationId"], "invocationId"),
    authority: authority(input["authority"]),
    now: dateText(input["now"], "now"),
  });
}

function parseObserve(value: unknown): ObserveInput {
  const input = record(value, "Capability invocation output observation");
  assertKeys(
    input,
    new Set(["handleRef", "invocationId", "authority", "now", "payload", "plaintextByteLength"]),
    "output observation",
  );
  return Object.freeze({
    handleRef: text(input["handleRef"], "handleRef"),
    invocationId: text(input["invocationId"], "invocationId"),
    authority: authority(input["authority"]),
    now: dateText(input["now"], "now"),
    payload: parseRunPayloadArtifactPayload(input["payload"]),
    plaintextByteLength: nonNegativeSafeInteger(
      input["plaintextByteLength"],
      "plaintextByteLength",
    ),
  });
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

function fingerprint(input: {
  readonly ownerId: string;
  readonly agentId: string;
  readonly runId: string;
  readonly handleRef: string;
  readonly invocationId: string;
  readonly workerRunId: string;
  readonly capabilityRef: string;
  readonly capabilityVersion: string;
  readonly authorizationRef: string;
  readonly operation: string;
  readonly inputRef: string;
  readonly delegatedContextRefs: readonly string[];
  readonly secretRefs: readonly CapabilitySecretReference[];
  readonly dataClassification: DataClassification;
  readonly resourceCeiling: CapabilityResourceCeiling;
  readonly requestedAt: string;
  readonly deadlineAt: string;
}): string {
  return `sha256:${createHash("sha256")
    .update(
      canonical({
        ownerId: input.ownerId,
        agentId: input.agentId,
        runId: input.runId,
        handleRef: input.handleRef,
        invocationId: input.invocationId,
        workerRunId: input.workerRunId,
        capabilityRef: input.capabilityRef,
        capabilityVersion: input.capabilityVersion,
        authorizationRef: input.authorizationRef,
        operation: input.operation,
        inputRef: input.inputRef,
        delegatedContextRefs: [...input.delegatedContextRefs],
        secretRefs: input.secretRefs.map((secret) => ({ ...secret })),
        dataClassification: input.dataClassification,
        resourceCeiling: { ...input.resourceCeiling },
        requestedAt: input.requestedAt,
        deadlineAt: input.deadlineAt,
      }),
    )
    .digest("hex")}`;
}

function receiptFromRow(row: ReceiptRow): FrozenReceipt {
  try {
    const parsed = JSON.parse(row.recordJson) as FrozenReceipt;
    if (parsed.receiptVersion !== "capability-invocation.v1") {
      throw new TypeError("unsupported capability invocation receipt version");
    }
    return parsed;
  } catch {
    throw new TypeError("Capability invocation receipt is not valid JSON");
  }
}

function equalSecrets(
  left: readonly CapabilitySecretReference[],
  right: readonly CapabilitySecretReference[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (value, index) =>
        value.secretRef === right[index]?.secretRef &&
        value.secretVersion === right[index]?.secretVersion &&
        value.purpose === right[index]?.purpose,
    )
  );
}

function equalAuthority(left: AuthorityInput, right: AuthorityInput): boolean {
  return (
    left.product.deploymentId === right.product.deploymentId &&
    left.product.authorityEpoch === right.product.authorityEpoch &&
    left.product.fencingToken === right.product.fencingToken &&
    left.lease.leaseId === right.lease.leaseId &&
    left.lease.fencingToken === right.lease.fencingToken &&
    left.agentServiceInstanceId === right.agentServiceInstanceId &&
    left.agentServiceBootId === right.agentServiceBootId &&
    left.workerInstanceId === right.workerInstanceId &&
    left.workerBootId === right.workerBootId
  );
}

function capabilityRecord(row: HandleRow): CapabilityRegistryRecord {
  try {
    return JSON.parse(row.capabilityJson) as CapabilityRegistryRecord;
  } catch {
    throw new TypeError("Capability declaration record is not valid JSON");
  }
}

function handleRecord(row: HandleRow): GovernedCapabilityExecutionHandle {
  try {
    return JSON.parse(row.recordJson) as GovernedCapabilityExecutionHandle;
  } catch {
    throw new TypeError("Capability Handle record is not valid JSON");
  }
}

function grantRecord(row: GrantRow): Record<string, unknown> {
  if (row.recordJson === null) throw new TypeError("Grant record is unavailable");
  try {
    return record(JSON.parse(row.recordJson), "Grant record");
  } catch {
    throw new TypeError("Grant record is not valid JSON");
  }
}

export class SqliteCapabilityInvocationOperations {
  private readonly sandboxExecutions: SqliteSandboxExecutionOperations;
  private readonly database: Database.Database;
  private readonly fail: SqliteApplicationFailure;
  private readonly assertDiskHeadroom: () => void;
  private readonly runPayloadArtifacts: SqliteRunPayloadArtifactOperations | undefined;

  constructor(
    database: Database.Database,
    fail: SqliteApplicationFailure,
    assertDiskHeadroom: () => void,
    runPayloadArtifacts?: SqliteRunPayloadArtifactOperations,
  ) {
    this.database = database;
    this.fail = fail;
    this.assertDiskHeadroom = assertDiskHeadroom;
    this.runPayloadArtifacts = runPayloadArtifacts;
    this.sandboxExecutions = new SqliteSandboxExecutionOperations(database, fail, {
      disk: assertDiskHeadroom,
      consume: (value, owner, agent) => this.consume(parseConsume(value), owner, agent),
      authority: (value, owner, agent, now) =>
        this.assertAuthority(authority(value), owner, agent, now),
      live: (plan, value, now) => this.assertSandboxLive(plan, authority(value), now),
    });
  }

  execute(operation: string, value: unknown): unknown {
    try {
      const scoped = this.scopedInput(value);
      if (operation.startsWith("capabilityInvocation.sandboxV2.")) {
        return this.sandboxExecutions.execute(
          operation.slice("capabilityInvocation.sandboxV2.".length),
          scoped.input,
          scoped.ownerId,
          scoped.agentId,
        );
      }
      if (operation === "capabilityInvocation.sandboxPrepare") {
        return this.fail("PORT_INVALID_OPERATION", "Sandbox preparation requires atomic admission");
      }
      if (operation.startsWith("capabilityInvocation.sandbox")) {
        return this.sandboxOperation(operation, scoped.input, scoped.ownerId, scoped.agentId);
      }
      if (operation === "capabilityInvocation.consume") {
        return this.consume(parseConsume(scoped.input), scoped.ownerId, scoped.agentId);
      }
      if (operation === "capabilityInvocation.read") {
        return this.read(parseRead(scoped.input), scoped.ownerId, scoped.agentId);
      }
      if (operation === "capabilityInvocationResult.lookupFrozen") {
        return this.lookupFrozen(parseRead(scoped.input), scoped.ownerId, scoped.agentId);
      }
      if (operation === "capabilityInvocationResult.lookupOutput") {
        return this.lookupOutput(parseRead(scoped.input), scoped.ownerId, scoped.agentId);
      }
      if (operation === "capabilityInvocationResult.observeOutput") {
        return this.observeOutput(parseObserve(scoped.input), scoped.ownerId, scoped.agentId);
      }
    } catch (error) {
      if (error instanceof TypeError || error instanceof ContractValidationError) {
        return this.fail("PORT_INVALID_OPERATION", error.message);
      }
      throw error;
    }
    return this.fail("PORT_INVALID_OPERATION", "Unknown Capability invocation operation");
  }

  private sandboxRead(
    identity: SandboxJobIdentity,
    ownerId: string,
    agentId: string,
  ): SandboxJobRecord | undefined {
    if (identity.ownerId !== ownerId || identity.agentId !== agentId) {
      return this.fail("PORT_NOT_AUTHORITATIVE", "Sandbox job scope mismatch");
    }
    const row = this.database
      .prepare(
        "SELECT plan_json AS planJson, observation_json AS observationJson FROM sandbox_jobs WHERE job_id = ? AND owner_id = ? AND agent_id = ?",
      )
      .get(identity.jobId, ownerId, agentId) as
      | { planJson: string; observationJson: string }
      | undefined;
    if (!row) return undefined;
    const plan = sandboxExecutionPlanSchema.parse(JSON.parse(row.planJson));
    if (JSON.stringify(plan.identity) !== JSON.stringify(identity)) {
      return this.fail("PORT_CONFLICT", "Sandbox job identity was replaced");
    }
    return { plan, observation: sandboxJobReceiptSchema.parse(JSON.parse(row.observationJson)) };
  }

  private assertSandboxLive(
    plan:
      | SandboxExecutionPlan
      | import("@himawari-agent/execution-contracts").SandboxExecutionPlanV2,
    authority: AuthorityInput,
    now: string,
  ): void {
    const other = this.database
      .prepare(
        `SELECT 1 FROM sandbox_workspace_occupancy WHERE host_id=? AND released_at IS NULL AND job_id != ? LIMIT 1`,
      )
      .get(plan.identity.hostId, plan.identity.jobId);
    if (plan.schemaVersion === "sandbox-execution.v1" && other)
      this.fail("PORT_CONFLICT", "Host has unresolved v2 workspace occupancy");
    const receipt = this.read(
      { handleRef: plan.handleRef, invocationId: plan.identity.invocationId, authority, now },
      plan.identity.ownerId,
      plan.identity.agentId,
    );
    if (
      !receipt ||
      receipt.receiptRef !== plan.identity.receiptRef ||
      receipt.runId !== plan.identity.runId ||
      receipt.inputRef !== plan.inputRef ||
      receipt.operation !== plan.operation ||
      receipt.capabilityRef !== plan.capabilityRef ||
      receipt.capabilityVersion !== plan.capabilityVersion ||
      receipt.semanticFingerprint !== plan.semanticFingerprint ||
      receipt.authorizationRef !== plan.authorizationRef ||
      timestamp(plan.requestedAt, "plan.requestedAt") <
        timestamp(receipt.requestedAt, "receipt.requestedAt") ||
      timestamp(plan.effectiveDeadlineAt, "plan.deadline") >
        timestamp(receipt.deadlineAt, "receipt.deadline") ||
      timestamp(plan.effectiveDeadlineAt, "plan.deadline") >
        timestamp(receipt.effectiveExpiresAt, "receipt.expiresAt") ||
      now >= plan.effectiveDeadlineAt ||
      now < plan.requestedAt ||
      Object.entries(plan.resourceCeiling).some(
        ([key, value]) =>
          value > receipt.resourceCeiling[key as keyof typeof receipt.resourceCeiling],
      )
    ) {
      this.fail("PORT_NOT_AUTHORITATIVE", "Sandbox job exceeds its consumed invocation");
    }
    const lease = plan.executionLease;
    if (
      lease.authorityLeaseId !== authority.lease.leaseId ||
      lease.authorityFencingToken !== authority.lease.fencingToken ||
      lease.deploymentId !== authority.product.deploymentId ||
      lease.authorityEpoch !== authority.product.authorityEpoch ||
      lease.fencingToken !== authority.product.fencingToken
    ) {
      this.fail("PORT_NOT_AUTHORITATIVE", "Sandbox job authority mismatch");
    }
    const current = this.database
      .prepare(`SELECT l.revision FROM run_execution_leases l
      JOIN runs r ON r.id = l.run_id AND r.owner_id = l.owner_id AND r.agent_id = l.agent_id
      WHERE l.owner_id = ? AND l.agent_id = ? AND l.run_id = ? AND l.execution_lease_id = ?
      AND l.revision = ? AND l.authority_lease_id = ? AND l.deployment_id = ?
      AND l.authority_epoch = ? AND l.fencing_token = ? AND l.consumer_id = ?
      AND l.released_at IS NULL AND l.expires_at > ? AND l.claimed_at <= ? AND r.status = 'running' AND r.thread_id IS ?`)
      .get(
        plan.identity.ownerId,
        plan.identity.agentId,
        plan.identity.runId,
        lease.executionLeaseId,
        lease.expectedLeaseRevision,
        lease.authorityLeaseId,
        lease.deploymentId,
        lease.authorityEpoch,
        lease.fencingToken,
        lease.consumerId,
        now,
        now,
        plan.identity.threadId,
      );
    if (!current) this.fail("PORT_NOT_AUTHORITATIVE", "Sandbox Run lease is not current");
  }

  private sandboxOperation(
    operation: string,
    value: unknown,
    ownerId: string,
    agentId: string,
  ):
    | SandboxJobAdmissionResult
    | readonly SandboxJobRecord[]
    | SandboxJobRecord
    | { record: SandboxJobRecord; applied: boolean }
    | undefined {
    if (operation === "capabilityInvocation.sandboxAdmit") {
      const input = record(value, "sandbox admission");
      assertKeys(input, new Set(["invocation", "plan", "observation"]), "sandbox admission");
      const invocation = parseConsume(input["invocation"]);
      const candidate = record(input["plan"], "sandbox plan candidate");
      if ("semanticFingerprint" in candidate)
        return this.fail(
          "PORT_INVALID_OPERATION",
          "Sandbox fingerprint must be derived from admission",
        );
      const observation = sandboxJobReceiptSchema.parse(input["observation"]);
      return this.database
        .transaction(() => {
          const consumed = this.consume(invocation, ownerId, agentId);
          const plan = sandboxExecutionPlanSchema.parse({
            ...candidate,
            semanticFingerprint: consumed.receipt.semanticFingerprint,
          });
          if (
            plan.identity.receiptRef !== consumed.receipt.receiptRef ||
            plan.identity.invocationId !== consumed.receipt.invocationId ||
            plan.handleRef !== consumed.receipt.handleRef
          )
            return this.fail("PORT_CONFLICT", "Sandbox plan belongs to another invocation receipt");
          if (consumed.replayed && !this.sandboxRead(plan.identity, ownerId, agentId))
            return this.fail(
              "PORT_CONFLICT",
              "Consumed invocation has no sandbox journal; execution is unknown",
            );
          const prepared = this.sandboxOperation(
            "capabilityInvocation.sandboxPrepare",
            {
              plan,
              observation,
              authority: invocation.authority,
              now: invocation.consumedAt,
            },
            ownerId,
            agentId,
          ) as { record: SandboxJobRecord; applied: boolean };
          return { ...prepared, receipt: consumed.receipt };
        })
        .immediate();
    }
    if (operation === "capabilityInvocation.sandboxListPending") {
      const input = record(value, "sandbox pending query");
      assertKeys(input, new Set(["afterJobId", "limit"]), "sandbox pending query");
      const limit = safeInteger(input["limit"], "limit");
      if (limit > 100)
        return this.fail("PORT_INVALID_OPERATION", "Sandbox pending page exceeds 100 jobs");
      const after = input["afterJobId"] === null ? "" : text(input["afterJobId"], "afterJobId");
      const rows = this.database
        .prepare(`SELECT plan_json AS planJson, observation_json AS observationJson
        FROM sandbox_jobs WHERE owner_id = ? AND agent_id = ? AND job_id > ?
        AND json_extract(observation_json, '$.state') NOT IN ('completed', 'failed') ORDER BY job_id LIMIT ?`)
        .all(ownerId, agentId, after, limit) as { planJson: string; observationJson: string }[];
      return rows.map((row) => ({
        plan: sandboxExecutionPlanSchema.parse(JSON.parse(row.planJson)),
        observation: sandboxJobReceiptSchema.parse(JSON.parse(row.observationJson)),
      }));
    }
    if (operation === "capabilityInvocation.sandboxByInvocation") {
      const input = record(value, "sandbox invocation query");
      assertKeys(input, new Set(["runId", "invocationId"]), "sandbox invocation query");
      const row = this.database
        .prepare(
          "SELECT plan_json AS planJson FROM sandbox_jobs WHERE owner_id = ? AND agent_id = ? AND run_id = ? AND invocation_id = ?",
        )
        .get(
          ownerId,
          agentId,
          text(input["runId"], "runId"),
          text(input["invocationId"], "invocationId"),
        ) as { planJson: string } | undefined;
      if (!row) return undefined;
      const plan = sandboxExecutionPlanSchema.parse(JSON.parse(row.planJson));
      return this.sandboxRead(plan.identity, ownerId, agentId);
    }
    if (operation === "capabilityInvocation.sandboxRead") {
      return this.sandboxRead(sandboxJobIdentitySchema.parse(value), ownerId, agentId);
    }
    if (
      operation !== "capabilityInvocation.sandboxPrepare" &&
      operation !== "capabilityInvocation.sandboxAppend"
    ) {
      return this.fail("PORT_INVALID_OPERATION", "Unknown sandbox journal operation");
    }
    const input = record(value, "sandbox journal");
    const preparing = operation === "capabilityInvocation.sandboxPrepare";
    assertKeys(
      input,
      new Set(
        preparing
          ? ["plan", "observation", "authority", "now"]
          : ["observation", "authority", "now"],
      ),
      "sandbox journal",
    );
    const observation = sandboxJobReceiptSchema.parse(input["observation"]);
    const parsedAuthority = authority(input["authority"]);
    const now = dateText(input["now"], "now");
    if (new Date(now).toISOString() !== now || observation.occurredAt > now) {
      return this.fail("PORT_INVALID_OPERATION", "Sandbox observation time is invalid");
    }
    const proposedPlan = preparing ? sandboxExecutionPlanSchema.parse(input["plan"]) : undefined;
    this.assertDiskHeadroom();
    return this.database
      .transaction(() => {
        this.assertAuthority(parsedAuthority, ownerId, agentId, now);
        const previous = this.sandboxRead(observation.identity, ownerId, agentId);
        const plan = proposedPlan ?? previous?.plan;
        if (!plan) return this.fail("PORT_NOT_FOUND", "Sandbox job is not prepared");
        if (observation.outputRef !== null) {
          const output = this.database
            .prepare(`SELECT a.payload_ref FROM run_payload_artifacts a
            JOIN payloads p ON p.ref = a.payload_ref AND p.owner_id = a.owner_id AND p.agent_id = a.agent_id
            WHERE a.owner_id = ? AND a.agent_id = ? AND a.run_id = ? AND a.purpose = 'worker_result'
            AND a.operation_key = ? AND a.payload_ref = ? AND a.content_digest = ? AND p.lifecycle_state = 'active'`)
            .get(
              ownerId,
              agentId,
              plan.identity.runId,
              capabilityInvocationOutputOperationKey(plan.identity.invocationId),
              observation.outputRef,
              `sha256:${observation.outputDigest}`,
            );
          if (!output)
            return this.fail(
              "PORT_CONFLICT",
              "Sandbox output is not durably bound to this invocation",
            );
        }
        if (preparing) {
          validateSandboxJobObservation(plan, observation);
          if (previous) {
            if (JSON.stringify(previous.plan) !== JSON.stringify(plan))
              return this.fail("PORT_CONFLICT", "Sandbox plan changed on replay");
            const initial = this.database
              .prepare(
                "SELECT observation_json AS json FROM sandbox_job_observations WHERE job_id = ? AND sequence = 1",
              )
              .get(plan.identity.jobId) as { json: string };
            if (initial.json !== JSON.stringify(observation))
              return this.fail("PORT_CONFLICT", "Sandbox preparation changed on replay");
            return { record: previous, applied: false };
          }
          this.assertSandboxLive(plan, parsedAuthority, now);
          const historicalOutput = this.database
            .prepare(
              "SELECT 1 FROM run_payload_artifacts WHERE owner_id = ? AND agent_id = ? AND run_id = ? AND purpose = 'worker_result' AND operation_key = ?",
            )
            .get(
              ownerId,
              agentId,
              plan.identity.runId,
              capabilityInvocationOutputOperationKey(plan.identity.invocationId),
            );
          if (historicalOutput)
            return this.fail("PORT_CONFLICT", "Invocation already has a durable output");
          const collision = this.database
            .prepare(
              "SELECT job_id FROM sandbox_jobs WHERE job_id = ? OR receipt_ref = ? OR attempt_id = ? OR (owner_id = ? AND agent_id = ? AND run_id = ? AND invocation_id = ?)",
            )
            .get(
              plan.identity.jobId,
              plan.identity.receiptRef,
              plan.identity.attemptId,
              ownerId,
              agentId,
              plan.identity.runId,
              plan.identity.invocationId,
            );
          if (collision)
            return this.fail("PORT_CONFLICT", "Invocation already owns a sandbox attempt");
          this.database
            .prepare(
              `INSERT INTO sandbox_jobs (job_id, attempt_id, receipt_ref, owner_id, agent_id, run_id, invocation_id, sequence, plan_json, observation_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              plan.identity.jobId,
              plan.identity.attemptId,
              plan.identity.receiptRef,
              ownerId,
              agentId,
              plan.identity.runId,
              plan.identity.invocationId,
              observation.sequence,
              JSON.stringify(plan),
              JSON.stringify(observation),
            );
        } else {
          if (!previous) return this.fail("PORT_NOT_FOUND", "Sandbox job is not prepared");
          if (observation.sequence <= previous.observation.sequence) {
            const old = this.database
              .prepare(
                "SELECT observation_json AS json FROM sandbox_job_observations WHERE job_id = ? AND sequence = ?",
              )
              .get(plan.identity.jobId, observation.sequence) as { json: string } | undefined;
            if (old?.json !== JSON.stringify(observation))
              return this.fail("PORT_CONFLICT", "Sandbox observation replay differs");
            return { record: previous, applied: false };
          }
          validateSandboxJobObservation(plan, observation, previous.observation);
          if (observation.state === "starting" && previous.observation.state !== "prepared") {
            return this.fail("PORT_CONFLICT", "A sandbox attempt can record only one start intent");
          }
          if (["starting", "running"].includes(observation.state)) {
            this.assertSandboxLive(plan, parsedAuthority, now);
          }
          const update = this.database
            .prepare(
              "UPDATE sandbox_jobs SET sequence = ?, observation_json = ? WHERE job_id = ? AND sequence = ?",
            )
            .run(
              observation.sequence,
              JSON.stringify(observation),
              plan.identity.jobId,
              previous.observation.sequence,
            );
          if (update.changes !== 1)
            return this.fail("PORT_CONFLICT", "Sandbox observation sequence changed");
        }
        this.database
          .prepare(
            "INSERT INTO sandbox_job_observations (job_id, sequence, observation_json) VALUES (?, ?, ?)",
          )
          .run(plan.identity.jobId, observation.sequence, JSON.stringify(observation));
        return { record: { plan, observation }, applied: true };
      })
      .immediate();
  }

  private scopedInput(value: unknown): ScopedOperationInput {
    const input = record(value, "Capability invocation operation");
    assertKeys(input, new Set(["ownerId", "agentId", "input"]), "Capability invocation operation");
    return {
      ownerId: text(input["ownerId"], "ownerId"),
      agentId: text(input["agentId"], "agentId"),
      input: input["input"],
    };
  }

  private consume(input: ConsumeInput, ownerId: string, agentId: string): ConsumeResult {
    this.assertDiskHeadroom();
    return this.database
      .transaction(() => {
        this.assertRequestScope(input, ownerId, agentId);

        const byKey = this.readReceiptByKey(ownerId, agentId, input.idempotencyKey);
        if (byKey) return this.replayOrConflict(byKey, input);
        const byInvocation = this.readReceiptByInvocation(
          ownerId,
          agentId,
          input.requestScope.runId,
          input.invocationId,
        );
        if (byInvocation) {
          return this.fail(
            "PORT_CONFLICT",
            "Capability invocation identity is already bound to another idempotency key",
            { invocationId: input.invocationId },
          );
        }

        const row = this.readHandle(input.handleRef);
        if (!row)
          return this.fail("PORT_NOT_FOUND", `Capability handle ${input.handleRef} not found`);
        const current = this.assertLiveInvocationAuthority(row, input);
        if (current.idempotencyKeys.includes(input.idempotencyKey)) {
          return this.fail(
            "PORT_CONFLICT",
            "Capability Handle has a historical consume without a durable invocation receipt",
            { handleRef: input.handleRef },
          );
        }

        this.assertGrant(current, input);
        const effectiveExpiresAt =
          timestamp(current.expiresAt, "handle.expiresAt") <=
          timestamp(input.deadlineAt, "deadlineAt")
            ? current.expiresAt
            : input.deadlineAt;
        const authorizationRef = current.authorizationRef;
        const semanticFingerprint = fingerprint({
          ownerId,
          agentId,
          runId: current.runId,
          handleRef: current.ref,
          invocationId: input.invocationId,
          workerRunId: input.requestScope.workerRunId,
          capabilityRef: current.capabilityRef,
          capabilityVersion: current.capabilityVersion,
          authorizationRef,
          operation: input.operation,
          inputRef: input.inputRef,
          delegatedContextRefs: input.delegatedContextRefs,
          secretRefs: input.secretRefs,
          dataClassification: input.dataClassification,
          resourceCeiling: input.resourceCeiling,
          requestedAt: input.requestedAt,
          deadlineAt: input.deadlineAt,
        });
        const receipt: FrozenReceipt = Object.freeze({
          receiptVersion: "capability-invocation.v1",
          receiptRef: input.receiptRef,
          ownerId: current.ownerId,
          agentId: current.agentId,
          runId: current.runId,
          handleRef: current.ref,
          handleRevision: current.revision + 1,
          invocationId: input.invocationId,
          workerRunId: input.requestScope.workerRunId,
          idempotencyKey: input.idempotencyKey,
          capabilityRef: current.capabilityRef,
          capabilityVersion: current.capabilityVersion,
          authorization: Object.freeze({ ...current.authorization }),
          authorizationRef,
          operation: input.operation,
          inputRef: input.inputRef,
          delegatedContextRefs: Object.freeze([...input.delegatedContextRefs]),
          secretRefs: Object.freeze(input.secretRefs.map((secret) => Object.freeze({ ...secret }))),
          dataClassification: input.dataClassification,
          resourceCeiling: Object.freeze({ ...input.resourceCeiling }),
          requestedAt: input.requestedAt,
          deadlineAt: input.deadlineAt,
          effectiveExpiresAt,
          authority: input.authority,
          semanticFingerprint,
          consumedAt: input.consumedAt,
        });
        const consumed: GovernedCapabilityExecutionHandle = {
          ...current,
          revision: current.revision + 1,
          uses: current.uses + 1,
          spentCostMicros: current.spentCostMicros,
          idempotencyKeys: [...current.idempotencyKeys, input.idempotencyKey],
        };
        const handleUpdate = this.database
          .prepare(
            `UPDATE capability_handles
             SET status = ?, expires_at = ?, revoked_at = ?, record_json = ?
             WHERE id = ? AND run_id = ?`,
          )
          .run(
            consumed.uses >= consumed.maxUses ? "consumed" : "active",
            consumed.expiresAt,
            consumed.revokedAt,
            JSON.stringify(consumed),
            consumed.ref,
            consumed.runId,
          );
        if (handleUpdate.changes !== 1) {
          return this.fail("PORT_CONFLICT", "Capability Handle changed during invocation consume", {
            handleRef: input.handleRef,
          });
        }
        try {
          this.database
            .prepare(
              `INSERT INTO capability_invocation_receipts (
                receipt_ref, owner_id, agent_id, run_id, handle_ref, invocation_id,
                worker_run_id, idempotency_key, capability_ref, capability_version,
                authorization_type, authorization_ref, operation, input_ref,
                delegated_context_refs_json, secret_refs_json, data_classification,
                resource_ceiling_json, requested_at, deadline_at, effective_expires_at,
                deployment_id, authority_epoch, fencing_token, lease_id,
                lease_fencing_token, agent_service_instance_id, agent_service_boot_id,
                worker_instance_id, worker_boot_id, semantic_fingerprint, consumed_at,
                record_json
              ) VALUES (${Array.from({ length: 33 }, () => "?").join(", ")})`,
            )
            .run(
              receipt.receiptRef,
              receipt.ownerId,
              receipt.agentId,
              receipt.runId,
              receipt.handleRef,
              receipt.invocationId,
              receipt.workerRunId,
              receipt.idempotencyKey,
              receipt.capabilityRef,
              receipt.capabilityVersion,
              receipt.authorization.type,
              receipt.authorizationRef,
              receipt.operation,
              receipt.inputRef,
              JSON.stringify(receipt.delegatedContextRefs),
              JSON.stringify(receipt.secretRefs),
              receipt.dataClassification,
              JSON.stringify(receipt.resourceCeiling),
              receipt.requestedAt,
              receipt.deadlineAt,
              receipt.effectiveExpiresAt,
              receipt.authority.product.deploymentId,
              receipt.authority.product.authorityEpoch,
              receipt.authority.product.fencingToken,
              receipt.authority.lease.leaseId,
              receipt.authority.lease.fencingToken,
              receipt.authority.agentServiceInstanceId,
              receipt.authority.agentServiceBootId,
              receipt.authority.workerInstanceId,
              receipt.authority.workerBootId,
              receipt.semanticFingerprint,
              receipt.consumedAt,
              JSON.stringify(receipt),
            );
        } catch (error) {
          if (String((error as { readonly code?: unknown }).code).startsWith("SQLITE_CONSTRAINT")) {
            return this.fail(
              "PORT_CONFLICT",
              "Capability invocation receipt identity conflicts with an existing receipt",
              { invocationId: input.invocationId, idempotencyKey: input.idempotencyKey },
            );
          }
          throw error;
        }
        return { replayed: false, receipt };
      })
      .immediate();
  }

  private read(input: ReadInput, ownerId: string, agentId: string): FrozenReceipt | undefined {
    const row = this.readReceiptByInvocationScope(
      ownerId,
      agentId,
      input.handleRef,
      input.invocationId,
    );
    if (!row) return undefined;
    const receipt = receiptFromRow(row);
    this.assertReceiptIdentity(receipt, input, ownerId, agentId);
    this.assertAuthority(input.authority, ownerId, agentId, input.now);
    if (
      timestamp(input.now, "now") >= timestamp(receipt.effectiveExpiresAt, "effectiveExpiresAt")
    ) {
      return this.fail("PORT_HANDLE_REVOKED", "Capability invocation receipt has expired");
    }
    const handleRow = this.readHandle(receipt.handleRef);
    if (!handleRow)
      return this.fail("PORT_NOT_FOUND", `Capability handle ${receipt.handleRef} not found`);
    const current = handleRecord(handleRow);
    const capability = capabilityRecord(handleRow);
    if (
      handleRow.runStatus !== "running" ||
      !CAPABILITY_LIFECYCLES_WITH_AUTHORITY.has(handleRow.capabilityStatus) ||
      current.ownerId !== receipt.ownerId ||
      current.agentId !== receipt.agentId ||
      current.runId !== receipt.runId ||
      current.capabilityRef !== receipt.capabilityRef ||
      current.capabilityVersion !== receipt.capabilityVersion ||
      capability.ref !== receipt.capabilityRef ||
      capability.declaration.version !== receipt.capabilityVersion ||
      !capability.declaration.operations.includes(receipt.operation) ||
      current.revokedAt !== null ||
      current.workerEndedAt !== null ||
      timestamp(input.now, "now") >= timestamp(current.expiresAt, "handle.expiresAt")
    ) {
      return this.fail("PORT_HANDLE_REVOKED", "Capability Handle is no longer readable");
    }
    this.assertGrant(current, {
      operation: receipt.operation,
      dataClassification: receipt.dataClassification,
      deadlineAt: receipt.deadlineAt,
      consumedAt: input.now,
    });
    return receipt;
  }

  private lookupFrozen(
    input: ReadInput,
    ownerId: string,
    agentId: string,
  ): FrozenReceipt | undefined {
    const row = this.readReceiptByInvocationScope(
      ownerId,
      agentId,
      input.handleRef,
      input.invocationId,
    );
    if (!row) return undefined;
    const receipt = receiptFromRow(row);
    this.assertReceiptIdentity(receipt, input, ownerId, agentId);
    this.assertAuthority(input.authority, ownerId, agentId, input.now);
    this.assertRunExists(receipt, ownerId, agentId);
    return receipt;
  }

  private lookupOutput(
    input: ReadInput,
    ownerId: string,
    agentId: string,
  ): ResultArtifact | undefined {
    const receipt = this.lookupFrozen(input, ownerId, agentId);
    if (!receipt) return undefined;
    const writer = this.requireRunPayloadArtifacts();
    const result = writer.execute("runPayloadArtifact.lookup", {
      ownerId,
      agentId,
      runId: receipt.runId,
      purpose: "worker_result",
      operationKey: capabilityInvocationOutputOperationKey(receipt.invocationId),
      authority: {
        product: input.authority.product,
        leaseId: input.authority.lease.leaseId,
        leaseFencingToken: input.authority.lease.fencingToken,
      },
      now: input.now,
    });
    return result as ResultArtifact | undefined;
  }

  private observeOutput(
    input: ObserveInput,
    ownerId: string,
    agentId: string,
  ): ResultArtifactCommit {
    const writer = this.requireRunPayloadArtifacts();
    this.assertDiskHeadroom();
    return this.database
      .transaction(() => {
        const row = this.readReceiptByInvocationScope(
          ownerId,
          agentId,
          input.handleRef,
          input.invocationId,
        );
        if (!row) {
          return this.fail(
            "PORT_NOT_FOUND",
            "Capability invocation receipt is not available for output observation",
            { invocationId: input.invocationId },
          );
        }
        const receipt = receiptFromRow(row);
        this.assertReceiptIdentity(receipt, input, ownerId, agentId);
        this.assertAuthority(input.authority, ownerId, agentId, input.now);
        this.assertRunExists(receipt, ownerId, agentId);
        this.assertOutputObservation(input, receipt);
        const authority: SqliteCapabilityInvocationObservationInput["authority"] = {
          product: input.authority.product,
          lease: input.authority.lease,
        };
        return writer.commitInvocationObservationWithinTransaction({
          ownerId: receipt.ownerId,
          agentId: receipt.agentId,
          runId: receipt.runId,
          invocationId: receipt.invocationId,
          authority,
          now: input.now,
          payload: input.payload,
        });
      })
      .immediate();
  }

  private requireRunPayloadArtifacts(): SqliteRunPayloadArtifactOperations {
    if (!this.runPayloadArtifacts) {
      return this.fail(
        "PORT_INVALID_OPERATION",
        "Capability invocation result operations require the Run Payload artifact writer",
      );
    }
    return this.runPayloadArtifacts;
  }

  private assertReceiptIdentity(
    receipt: FrozenReceipt,
    input: ReadInput,
    ownerId: string,
    agentId: string,
  ): void {
    if (receipt.ownerId !== ownerId || receipt.agentId !== agentId) {
      this.fail("PORT_NOT_AUTHORITATIVE", "Capability invocation is outside the adapter scope");
    }
    if (
      receipt.handleRef !== input.handleRef ||
      receipt.invocationId !== input.invocationId ||
      !equalAuthority(receipt.authority, input.authority)
    ) {
      this.fail(
        "PORT_NOT_AUTHORITATIVE",
        "Capability invocation belongs to another Agent or Worker attempt",
      );
    }
  }

  private assertRunExists(receipt: FrozenReceipt, ownerId: string, agentId: string): void {
    const row = this.database
      .prepare(
        `SELECT 1 FROM runs
         WHERE id = ? AND owner_id = ? AND agent_id = ?`,
      )
      .get(receipt.runId, ownerId, agentId);
    if (!row) {
      this.fail("PORT_INVALID_OPERATION", "Capability invocation Run is no longer available", {
        runId: receipt.runId,
      });
    }
  }

  private assertOutputObservation(input: ObserveInput, receipt: FrozenReceipt): void {
    if (input.payload.dataClassification !== receipt.dataClassification) {
      this.fail(
        "PORT_INVALID_OPERATION",
        "Capability invocation output classification does not match its receipt",
        { invocationId: receipt.invocationId },
      );
    }
    if (!ALLOWED_RESULT_CONTENT_TYPE.test(input.payload.contentType)) {
      this.fail(
        "PORT_INVALID_OPERATION",
        "Capability invocation output content type is not supported",
        { invocationId: receipt.invocationId },
      );
    }
    if (input.plaintextByteLength > receipt.resourceCeiling.maxOutputBytes) {
      this.fail(
        "PORT_INVALID_OPERATION",
        "Capability invocation output exceeds its frozen resource ceiling",
        { invocationId: receipt.invocationId },
      );
    }
  }

  private assertRequestScope(input: ConsumeInput, ownerId: string, agentId: string): void {
    const scope = input.requestScope;
    if (
      scope.ownerId !== ownerId ||
      scope.agentId !== agentId ||
      scope.deploymentId !== input.authority.product.deploymentId ||
      scope.authorityEpoch !== input.authority.product.authorityEpoch ||
      scope.fencingToken !== input.authority.product.fencingToken
    ) {
      this.fail("PORT_NOT_AUTHORITATIVE", "work.execute scope is not bound to current authority");
    }
  }

  private readHandle(handleRef: string): HandleRow | undefined {
    const row = this.database
      .prepare(
        `SELECT h.record_json AS recordJson, h.status AS handleStatus,
           h.expires_at AS handleExpiresAt, h.revoked_at AS handleRevokedAt,
           c.status AS capabilityStatus, c.record_json AS capabilityJson,
           r.status AS runStatus
         FROM capability_handles h
         JOIN capability_declarations c ON c.id = h.capability_id
         JOIN runs r ON r.id = h.run_id
         WHERE h.id = ? AND c.owner_id = r.owner_id AND c.agent_id = r.agent_id`,
      )
      .get(handleRef) as HandleRow | undefined;
    return row;
  }

  private assertLiveInvocationAuthority(
    row: HandleRow,
    input: ConsumeInput,
  ): GovernedCapabilityExecutionHandle {
    const current = handleRecord(row);
    const capability = capabilityRecord(row);
    const scope = input.requestScope;
    if (
      current.handleVersion !== "capability-handle.v2" ||
      current.ref !== input.handleRef ||
      current.ownerId !== scope.ownerId ||
      current.agentId !== scope.agentId ||
      current.runId !== scope.runId ||
      current.capabilityRef !== input.capabilityRef ||
      current.capabilityVersion !== input.capabilityVersion ||
      (input.authorizationRef !== null && input.authorizationRef !== current.authorizationRef) ||
      current.authorityFence !== input.authority.product.fencingToken ||
      current.operation !== input.operation ||
      !current.operations.includes(input.operation) ||
      !current.inputRefs.includes(input.inputRef) ||
      !input.delegatedContextRefs.every((ref) => current.delegatedContextRefs.includes(ref)) ||
      !equalSecrets(
        input.secretRefs,
        input.secretRefs.filter((secret) =>
          current.secretRefs.some(
            (allowed) =>
              allowed.secretRef === secret.secretRef &&
              allowed.secretVersion === secret.secretVersion &&
              allowed.purpose === secret.purpose,
          ),
        ),
      ) ||
      CLASSIFICATION_RANK[input.dataClassification] >
        CLASSIFICATION_RANK[current.maxDataClassification] ||
      timestamp(input.requestedAt, "requestedAt") <
        timestamp(current.issuedAt, "handle.issuedAt") ||
      timestamp(input.deadlineAt, "deadlineAt") >
        timestamp(current.expiresAt, "handle.expiresAt") ||
      timestamp(input.consumedAt, "consumedAt") >=
        timestamp(current.expiresAt, "handle.expiresAt") ||
      timestamp(input.consumedAt, "consumedAt") < timestamp(input.requestedAt, "requestedAt") ||
      timestamp(input.consumedAt, "consumedAt") >= timestamp(input.deadlineAt, "deadlineAt") ||
      row.handleStatus !== "active" ||
      row.handleExpiresAt !== current.expiresAt ||
      row.handleRevokedAt !== current.revokedAt ||
      current.revokedAt !== null ||
      current.workerEndedAt !== null ||
      current.uses >= current.maxUses ||
      current.spentCostMicros > current.maxTotalCostMicros ||
      row.runStatus !== "running" ||
      !CAPABILITY_LIFECYCLES_WITH_AUTHORITY.has(capability.lifecycle) ||
      capability.ref !== current.capabilityRef ||
      capability.declaration.version !== current.capabilityVersion ||
      !capability.declaration.operations.includes(input.operation)
    ) {
      return this.fail(
        "PORT_NOT_AUTHORITATIVE",
        `Capability invocation ${input.invocationId} exceeds its durable authority`,
      );
    }
    this.assertAuthority(input.authority, scope.ownerId, scope.agentId, input.consumedAt);
    return current;
  }

  private assertAuthority(
    authorityInput: AuthorityInput,
    ownerId: string,
    agentId: string,
    now: string,
  ): void {
    const row = this.database
      .prepare(
        `SELECT l.authority_epoch AS leaseEpoch, l.fencing_token AS leaseFence,
           l.expires_at AS leaseExpiresAt, l.released_at AS releasedAt,
           d.id AS deploymentId, d.status AS deploymentStatus,
           d.authority_epoch AS deploymentEpoch, d.fencing_token AS deploymentFence
         FROM authority_leases l
         JOIN deployments d ON d.id = l.deployment_id
           AND d.owner_id = l.owner_id AND d.agent_id = l.agent_id
         WHERE l.id = ? AND l.owner_id = ? AND l.agent_id = ?`,
      )
      .get(authorityInput.lease.leaseId, ownerId, agentId) as
      | {
          readonly leaseEpoch: number;
          readonly leaseFence: number;
          readonly leaseExpiresAt: string;
          readonly releasedAt: string | null;
          readonly deploymentId: string;
          readonly deploymentStatus: string;
          readonly deploymentEpoch: number;
          readonly deploymentFence: number;
        }
      | undefined;
    if (
      !row ||
      row.deploymentStatus !== "active" ||
      row.releasedAt !== null ||
      timestamp(row.leaseExpiresAt, "lease.expiresAt") <= timestamp(now, "now") ||
      row.deploymentId !== authorityInput.product.deploymentId ||
      row.leaseEpoch !== authorityInput.product.authorityEpoch ||
      row.deploymentEpoch !== authorityInput.product.authorityEpoch ||
      row.deploymentFence !== authorityInput.product.fencingToken ||
      row.leaseFence !== authorityInput.lease.fencingToken ||
      row.leaseFence !== authorityInput.product.fencingToken
    ) {
      this.fail("PORT_NOT_AUTHORITATIVE", "Capability invocation authority is not current");
    }
  }

  private assertGrant(
    current: GovernedCapabilityExecutionHandle,
    input: GrantInvocationInput,
  ): void {
    if (current.authorization.type !== "grant") return;
    const grant = this.database
      .prepare(
        `SELECT record_json AS recordJson, owner_id AS ownerId, agent_id AS agentId
         FROM grants WHERE id = ?`,
      )
      .get(current.authorization.ref) as GrantRow | undefined;
    if (!grant || grant.ownerId !== current.ownerId || grant.agentId !== current.agentId) {
      this.fail("PORT_HANDLE_REVOKED", "Capability Handle Grant is no longer available");
      return;
    }
    const grantRecordValue = grantRecord(grant);
    const scope = grantRecordValue["scope"];
    const grantScope = record(scope, "Grant scope");
    const revokedAt = grantRecordValue["revokedAt"];
    const validFrom = text(grantRecordValue["validFrom"], "Grant validFrom");
    const expiresAt = text(grantRecordValue["expiresAt"], "Grant expiresAt");
    const grantOwnerId = text(grantRecordValue["ownerId"], "Grant ownerId");
    const grantAgentId = text(grantRecordValue["agentId"], "Grant agentId");
    const operations = list(grantScope["operations"], "Grant scope operations");
    const grantCapabilityRef = text(grantScope["capabilityRef"], "Grant scope capabilityRef");
    const grantMaxClassification = classification(
      grantScope["maxDataClassification"],
      "Grant scope maxDataClassification",
    );
    if (
      grantOwnerId !== current.ownerId ||
      grantAgentId !== current.agentId ||
      revokedAt !== null ||
      timestamp(input.consumedAt, "consumedAt") < timestamp(validFrom, "Grant.validFrom") ||
      timestamp(input.consumedAt, "consumedAt") >= timestamp(expiresAt, "Grant.expiresAt") ||
      grantCapabilityRef !== current.capabilityRef ||
      !operations.every((operation) => typeof operation === "string") ||
      !operations.includes(input.operation) ||
      CLASSIFICATION_RANK[input.dataClassification] > CLASSIFICATION_RANK[grantMaxClassification] ||
      timestamp(input.deadlineAt, "deadlineAt") > timestamp(expiresAt, "Grant.expiresAt")
    ) {
      this.fail("PORT_HANDLE_REVOKED", "Capability Handle Grant no longer covers invocation");
      return;
    }
  }

  private readReceiptByKey(
    ownerId: string,
    agentId: string,
    idempotencyKey: string,
  ): ReceiptRow | undefined {
    return this.database
      .prepare(
        `SELECT record_json AS recordJson
         FROM capability_invocation_receipts
         WHERE owner_id = ? AND agent_id = ? AND idempotency_key = ?`,
      )
      .get(ownerId, agentId, idempotencyKey) as ReceiptRow | undefined;
  }

  private readReceiptByInvocation(
    ownerId: string,
    agentId: string,
    runId: string,
    invocationId: string,
  ): ReceiptRow | undefined {
    return this.database
      .prepare(
        `SELECT record_json AS recordJson
         FROM capability_invocation_receipts
         WHERE owner_id = ? AND agent_id = ? AND run_id = ? AND invocation_id = ?`,
      )
      .get(ownerId, agentId, runId, invocationId) as ReceiptRow | undefined;
  }

  private readReceiptByInvocationScope(
    ownerId: string,
    agentId: string,
    handleRef: string,
    invocationId: string,
  ): ReceiptRow | undefined {
    return this.database
      .prepare(
        `SELECT record_json AS recordJson
         FROM capability_invocation_receipts
         WHERE owner_id = ? AND agent_id = ? AND handle_ref = ? AND invocation_id = ?`,
      )
      .get(ownerId, agentId, handleRef, invocationId) as ReceiptRow | undefined;
  }

  private replayOrConflict(row: ReceiptRow, input: ConsumeInput): ConsumeResult {
    const receipt = receiptFromRow(row);
    const requestedAuthorizationRef = input.authorizationRef ?? receipt.authorizationRef;
    const candidateFingerprint = fingerprint({
      ownerId: input.requestScope.ownerId,
      agentId: input.requestScope.agentId,
      runId: input.requestScope.runId,
      handleRef: input.handleRef,
      invocationId: input.invocationId,
      workerRunId: input.requestScope.workerRunId,
      capabilityRef: input.capabilityRef,
      capabilityVersion: input.capabilityVersion,
      authorizationRef: requestedAuthorizationRef,
      operation: input.operation,
      inputRef: input.inputRef,
      delegatedContextRefs: input.delegatedContextRefs,
      secretRefs: input.secretRefs,
      dataClassification: input.dataClassification,
      resourceCeiling: input.resourceCeiling,
      requestedAt: input.requestedAt,
      deadlineAt: input.deadlineAt,
    });
    if (receipt.semanticFingerprint !== candidateFingerprint) {
      return this.fail(
        "PORT_CONFLICT",
        "Capability invocation idempotency key conflicts with a different request",
        { idempotencyKey: input.idempotencyKey },
      );
    }
    return { replayed: true, receipt };
  }
}
