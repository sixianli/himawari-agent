import { createHash } from "node:crypto";
import type {
  AuthorityFence,
  ModelBudgetLimits,
  ModelInvocationIdentity,
  ModelInvocationIdentityBeginInput,
  ModelInvocationIdentityBeginResult,
  ModelInvocationIdentitySettlementInput,
  ModelInvocationIdentityStartedInput,
  ModelInvocationIdentityStatus,
  ModelInvocationIdentityTransitionInput,
  ModelInvocationIdentityUnknownInput,
  ModelInvocationPricing,
  ModelInvocationSource,
  ProductAuthorityFence,
  RunExecutionLeaseClaim,
} from "@himawari-agent/application";
import {
  createAgentId,
  createAuthorityLeaseId,
  createDeploymentId,
  createOwnerId,
  createRunExecutionLeaseId,
  createRunId,
} from "@himawari-agent/domain";
import type Database from "better-sqlite3";
import type {
  SqliteModelBudgetOperations,
  SqliteModelBudgetScope,
} from "./sqlite-model-budget-operations.ts";
import { SqliteRunDispatchOperations } from "./sqlite-run-dispatch-operations.ts";

const CLASSIFICATIONS = ["public", "private", "sensitive", "restricted"] as const;
const SOURCES = ["model-port", "agent-stream"] as const;
const STATUSES = ["reserved", "started", "unknown", "settled", "released"] as const;
const UNKNOWN_REASONS = [
  "provider_unresolved",
  "transport_unresolved",
  "cancel_unresolved",
] as const;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const MAX_TEXT = 512;

type Failure = (code: string, message: string, details?: Readonly<Record<string, string>>) => never;

interface IdentityRow {
  readonly ownerId: string;
  readonly agentId: string;
  readonly runId: string;
  readonly logicalSlot: string;
  readonly sequence: number;
  readonly invocationId: string;
  readonly modelRef: string;
  readonly provider: string;
  readonly model: string;
  readonly modelVersion: string | null;
  readonly dataClassification: (typeof CLASSIFICATIONS)[number];
  readonly source: (typeof SOURCES)[number];
  readonly ordinal: number;
  readonly pricingInput: number;
  readonly pricingOutput: number;
  readonly pricingCacheRead: number;
  readonly pricingCacheWrite: number;
  readonly pricingFingerprint: string;
  readonly estimatedCostMicros: number;
  readonly budgetAccountId: string;
  readonly budgetOperationKey: string;
  readonly authorityLeaseId: string;
  readonly authorityDeploymentId: string;
  readonly authorityEpoch: number;
  readonly authorityFencingToken: number;
  readonly executionLeaseId: string;
  readonly executionExpectedLeaseRevision: number;
  readonly executionAuthorityLeaseId: string;
  readonly executionAuthorityFencingToken: number;
  readonly executionDeploymentId: string;
  readonly executionAuthorityEpoch: number;
  readonly executionFencingToken: number;
  readonly executionConsumerId: string;
  readonly status: (typeof STATUSES)[number];
  readonly reservedAt: string;
  readonly startedAt: string | null;
  readonly observedAt: string | null;
  readonly settledAt: string | null;
  readonly releasedAt: string | null;
  readonly actualCostMicros: number | null;
  readonly reasonCode: (typeof UNKNOWN_REASONS)[number] | null;
}

interface ParsedEnvelope {
  readonly scope: SqliteModelBudgetScope;
  readonly input: Record<string, unknown>;
}

interface ParsedBeginInput extends ModelInvocationIdentityBeginInput {
  readonly executionLease: RunExecutionLeaseClaim;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function text(value: unknown, name: string, maximum = MAX_TEXT): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new TypeError(`${name} must be a nonempty bounded string`);
  }
  return value;
}

function machineText(value: unknown, name: string, maximum = 128): string {
  const result = text(value, name, maximum);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) {
    throw new TypeError(`${name} must be a machine identifier`);
  }
  return result;
}

function safeInteger(value: unknown, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < minimum) {
    throw new TypeError(`${name} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number`);
  }
  return value;
}

function instant(value: unknown, name: string): string {
  const result = text(value, name, 64);
  const parsed = new Date(result);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== result) {
    throw new TypeError(`${name} must be a canonical ISO timestamp`);
  }
  return result;
}

function optionalInstant(value: unknown, name: string): string | null {
  return value === null || value === undefined ? null : instant(value, name);
}

function isAfter(value: string, boundary: string): boolean {
  const parsedValue = Date.parse(value);
  const parsedBoundary = Date.parse(boundary);
  return (
    Number.isFinite(parsedValue) && Number.isFinite(parsedBoundary) && parsedValue > parsedBoundary
  );
}

function classification(value: unknown, name: string): (typeof CLASSIFICATIONS)[number] {
  const result = text(value, name, 16);
  if (!CLASSIFICATIONS.includes(result as (typeof CLASSIFICATIONS)[number])) {
    throw new TypeError(`${name} is not a supported data classification`);
  }
  return result as (typeof CLASSIFICATIONS)[number];
}

function source(value: unknown, name: string): ModelInvocationSource {
  const result = text(value, name, 32);
  if (!SOURCES.includes(result as ModelInvocationSource)) {
    throw new TypeError(`${name} is not a supported model invocation source`);
  }
  return result as ModelInvocationSource;
}

function unknownReason(
  value: unknown,
  name: string,
): ModelInvocationIdentityUnknownInput["reasonCode"] {
  const result = text(value, name, 32);
  if (!UNKNOWN_REASONS.includes(result as ModelInvocationIdentityUnknownInput["reasonCode"])) {
    throw new TypeError(`${name} is not a supported unknown reason`);
  }
  return result as ModelInvocationIdentityUnknownInput["reasonCode"];
}

function pricing(value: unknown, name: string): ModelInvocationPricing {
  const row = record(value, name);
  return Object.freeze({
    input: finiteNumber(row["input"], `${name}.input`),
    output: finiteNumber(row["output"], `${name}.output`),
    cacheRead: finiteNumber(row["cacheRead"], `${name}.cacheRead`),
    cacheWrite: finiteNumber(row["cacheWrite"], `${name}.cacheWrite`),
  });
}

function limits(value: unknown): ModelBudgetLimits {
  const row = record(value, "limits");
  const classes = record(row["perClassificationCostMicros"], "limits.perClassificationCostMicros");
  return Object.freeze({
    accountCostMicros: safeInteger(row["accountCostMicros"], "limits.accountCostMicros"),
    globalCostMicros: safeInteger(row["globalCostMicros"], "limits.globalCostMicros"),
    perClassificationCostMicros: Object.freeze({
      public: safeInteger(classes["public"], "limits.perClassificationCostMicros.public"),
      private: safeInteger(classes["private"], "limits.perClassificationCostMicros.private"),
      sensitive: safeInteger(classes["sensitive"], "limits.perClassificationCostMicros.sensitive"),
      restricted: safeInteger(
        classes["restricted"],
        "limits.perClassificationCostMicros.restricted",
      ),
    }),
  });
}

function parseAuthority(value: unknown): ProductAuthorityFence {
  const row = record(value, "authority");
  return Object.freeze({
    deploymentId: createDeploymentId(machineText(row["deploymentId"], "authority.deploymentId")),
    authorityEpoch: safeInteger(row["authorityEpoch"], "authority.authorityEpoch", 1),
    fencingToken: safeInteger(row["fencingToken"], "authority.fencingToken", 1),
  });
}

function parseAuthorityLease(value: unknown): AuthorityFence {
  const row = record(value, "authorityLease");
  return Object.freeze({
    leaseId: createAuthorityLeaseId(machineText(row["leaseId"], "authorityLease.leaseId")),
    fencingToken: safeInteger(row["fencingToken"], "authorityLease.fencingToken", 1),
  });
}

function parseExecutionLease(value: unknown): RunExecutionLeaseClaim {
  const row = record(value, "executionLease");
  return Object.freeze({
    executionLeaseId: createRunExecutionLeaseId(
      machineText(row["executionLeaseId"], "executionLease.executionLeaseId"),
    ),
    expectedLeaseRevision: safeInteger(
      row["expectedLeaseRevision"],
      "executionLease.expectedLeaseRevision",
    ),
    authorityLeaseId: createAuthorityLeaseId(
      machineText(row["authorityLeaseId"], "executionLease.authorityLeaseId"),
    ),
    authorityFencingToken: safeInteger(
      row["authorityFencingToken"],
      "executionLease.authorityFencingToken",
      1,
    ),
    deploymentId: createDeploymentId(
      machineText(row["deploymentId"], "executionLease.deploymentId"),
    ),
    authorityEpoch: safeInteger(row["authorityEpoch"], "executionLease.authorityEpoch", 1),
    fencingToken: safeInteger(row["fencingToken"], "executionLease.fencingToken", 1),
    consumerId: machineText(row["consumerId"], "executionLease.consumerId"),
  });
}

function parseScope(payload: unknown): SqliteModelBudgetScope {
  const value = record(payload, "model invocation request");
  const scope = record(value["scope"], "scope");
  return {
    ownerId: createOwnerId(machineText(scope["ownerId"], "ownerId")),
    agentId: createAgentId(machineText(scope["agentId"], "agentId")),
    authority: parseAuthority(scope["authority"]),
    authorityLease: parseAuthorityLease(scope["authorityLease"]),
  };
}

function parseEnvelope(payload: unknown): ParsedEnvelope {
  const value = record(payload, "model invocation request");
  return { scope: parseScope(payload), input: record(value["input"], "input") };
}

function parseBegin(input: Record<string, unknown>): ParsedBeginInput {
  const modelVersion = input["modelVersion"];
  const parsedModelVersion =
    modelVersion === null || modelVersion === undefined ? null : text(modelVersion, "modelVersion");
  return {
    runId: createRunId(machineText(input["runId"], "runId")),
    modelRef: text(input["modelRef"], "modelRef"),
    provider: text(input["provider"], "provider"),
    model: text(input["model"], "model"),
    modelVersion: parsedModelVersion,
    dataClassification: classification(input["dataClassification"], "dataClassification"),
    logicalSlot: text(input["logicalSlot"], "logicalSlot"),
    source: source(input["source"], "source"),
    ordinal: safeInteger(input["ordinal"], "ordinal", 1),
    estimatedCostMicros: safeInteger(input["estimatedCostMicros"], "estimatedCostMicros"),
    pricing: pricing(input["pricing"], "pricing"),
    executionLease: parseExecutionLease(input["executionLease"]),
    authority: parseAuthority(input["authority"]),
    authorityLease: parseAuthorityLease(input["authorityLease"]),
    limits: limits(input["limits"]),
    reservedAt: instant(input["reservedAt"], "reservedAt"),
  };
}

function parseTransition(input: Record<string, unknown>): ModelInvocationIdentityTransitionInput {
  return {
    runId: createRunId(machineText(input["runId"], "runId")),
    invocationId: text(input["invocationId"], "invocationId"),
    budgetOperationKey: text(input["budgetOperationKey"], "budgetOperationKey"),
    executionLease: parseExecutionLease(input["executionLease"]),
    at: instant(input["at"], "at"),
  };
}

function parseStarted(input: Record<string, unknown>): ModelInvocationIdentityStartedInput {
  return parseTransition(input);
}

function parseSettlement(input: Record<string, unknown>): ModelInvocationIdentitySettlementInput {
  return {
    ...parseTransition(input),
    actualCostMicros: safeInteger(input["actualCostMicros"], "actualCostMicros"),
  };
}

function parseUnknown(input: Record<string, unknown>): ModelInvocationIdentityUnknownInput {
  return {
    ...parseTransition(input),
    reasonCode: unknownReason(input["reasonCode"], "reasonCode"),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function pricingFingerprint(value: ModelInvocationPricing): string {
  return `sha256:${sha256(
    JSON.stringify([value.input, value.output, value.cacheRead, value.cacheWrite]),
  )}`;
}

function generatedInvocationId(runId: string, logicalSlot: string, sequence: number): string {
  return `model-invocation:${runId}:${sha256(logicalSlot).slice(0, 32)}:${sequence}`;
}

function budgetOperationKey(invocationId: string): string {
  return `model-invocation:${invocationId}`;
}

function samePricing(left: IdentityRow, right: ModelInvocationPricing): boolean {
  return (
    left.pricingInput === right.input &&
    left.pricingOutput === right.output &&
    left.pricingCacheRead === right.cacheRead &&
    left.pricingCacheWrite === right.cacheWrite
  );
}

function sameExecutionLease(left: IdentityRow, right: RunExecutionLeaseClaim): boolean {
  return (
    left.executionLeaseId === right.executionLeaseId &&
    left.executionExpectedLeaseRevision === right.expectedLeaseRevision &&
    left.executionAuthorityLeaseId === right.authorityLeaseId &&
    left.executionAuthorityFencingToken === right.authorityFencingToken &&
    left.executionDeploymentId === right.deploymentId &&
    left.executionAuthorityEpoch === right.authorityEpoch &&
    left.executionFencingToken === right.fencingToken &&
    left.executionConsumerId === right.consumerId
  );
}

function sameFrozenSemantics(row: IdentityRow, input: ParsedBeginInput): boolean {
  return (
    row.runId === input.runId &&
    row.logicalSlot === input.logicalSlot &&
    row.modelRef === input.modelRef &&
    row.provider === input.provider &&
    row.model === input.model &&
    row.modelVersion === input.modelVersion &&
    row.dataClassification === input.dataClassification &&
    row.source === input.source &&
    row.ordinal === input.ordinal &&
    samePricing(row, input.pricing) &&
    row.pricingFingerprint === pricingFingerprint(input.pricing) &&
    row.estimatedCostMicros === input.estimatedCostMicros
  );
}

function sameAuthority(left: ProductAuthorityFence, right: ProductAuthorityFence): boolean {
  return (
    left.deploymentId === right.deploymentId &&
    left.authorityEpoch === right.authorityEpoch &&
    left.fencingToken === right.fencingToken
  );
}

function sameAuthorityLease(left: AuthorityFence, right: AuthorityFence): boolean {
  return left.leaseId === right.leaseId && left.fencingToken === right.fencingToken;
}

export class SqliteModelInvocationOperations {
  private readonly database: Database.Database;
  private readonly fail: Failure;
  private readonly assertDiskHeadroom: () => void;
  private readonly budget: SqliteModelBudgetOperations;

  constructor(
    database: Database.Database,
    fail: Failure,
    assertDiskHeadroom: () => void,
    budget: SqliteModelBudgetOperations,
  ) {
    this.database = database;
    this.fail = fail;
    this.assertDiskHeadroom = assertDiskHeadroom;
    this.budget = budget;
  }

  execute(operation: string, payload: unknown): unknown {
    try {
      const envelope = parseEnvelope(payload);
      switch (operation) {
        case "modelInvocation.begin":
          return this.beginSync(envelope);
        case "modelInvocation.markStarted":
          return this.markStartedSync(envelope);
        case "modelInvocation.releaseReserved":
          return this.releaseReservedSync(envelope);
        case "modelInvocation.settle":
          return this.settleSync(envelope);
        case "modelInvocation.markUnknown":
          return this.markUnknownSync(envelope);
        case "modelInvocation.read":
          return this.readSync(envelope);
        default:
          return this.fail("PORT_INVALID_OPERATION", "Unknown model invocation operation");
      }
    } catch (error) {
      if (error instanceof TypeError) return this.fail("PORT_INVALID_OPERATION", error.message);
      throw error;
    }
  }

  private beginSync(envelope: ParsedEnvelope): ModelInvocationIdentityBeginResult {
    const input = parseBegin(envelope.input);
    this.assertDiskHeadroom();
    return this.budget.runImmediateTransaction(() =>
      this.beginWithinTransaction(envelope.scope, input),
    );
  }

  private beginWithinTransaction(
    scope: SqliteModelBudgetScope,
    input: ParsedBeginInput,
  ): ModelInvocationIdentityBeginResult {
    this.assertBeginScope(scope, input);
    this.assertHeldExecutionLease(scope, input.runId, input.executionLease, input.reservedAt);
    const latest = this.readLatest(scope, input.runId, input.logicalSlot);
    if (latest && !sameFrozenSemantics(latest, input)) {
      return {
        disposition: "blocked",
        reasonCode: "MODEL_INVOCATION_IDENTITY_CONFLICT",
        details: { runId: String(input.runId), logicalSlot: input.logicalSlot },
      };
    }
    if (latest && latest.status !== "released") {
      return {
        disposition: "replay",
        identity: this.toIdentity(latest),
        reasonCode: "MODEL_INVOCATION_RECONCILIATION_REQUIRED",
      };
    }
    const sequence = latest === undefined ? 1 : nextSequence(latest.sequence, this.fail);
    const invocationId = generatedInvocationId(String(input.runId), input.logicalSlot, sequence);
    const operationKey = budgetOperationKey(invocationId);
    const allocation = this.budget.reserveWithinTransaction(scope, {
      parent: {
        kind: "run",
        runId: input.runId,
        executionLease: input.executionLease,
      },
      operationKey,
      modelRef: input.modelRef,
      dataClassification: input.dataClassification,
      estimatedCostMicros: input.estimatedCostMicros,
      limits: input.limits,
      reservedAt: input.reservedAt,
    });
    if (allocation.replayed) {
      return {
        disposition: "blocked",
        reasonCode: "MODEL_INVOCATION_RECONCILIATION_REQUIRED",
        details: {
          runId: String(input.runId),
          logicalSlot: input.logicalSlot,
          budgetOperationKey: operationKey,
        },
      };
    }
    if (
      allocation.allocation.status !== "reserved" ||
      allocation.allocation.operationKey !== operationKey ||
      allocation.allocation.modelRef !== input.modelRef ||
      allocation.allocation.dataClassification !== input.dataClassification ||
      allocation.allocation.estimatedCostMicros !== input.estimatedCostMicros
    ) {
      return this.fail(
        "PORT_NOT_AUTHORITATIVE",
        "Model budget returned an incompatible allocation",
      );
    }
    this.database
      .prepare(
        `INSERT INTO model_invocation_identities (
          owner_id, agent_id, run_id, logical_slot, sequence, invocation_id,
          model_ref, provider, model, model_version, data_classification, source, ordinal,
          pricing_input, pricing_output, pricing_cache_read, pricing_cache_write,
          pricing_fingerprint, estimated_cost_micros, budget_account_id, budget_operation_key,
          authority_lease_id, authority_deployment_id, authority_epoch, authority_fencing_token,
          execution_lease_id, execution_expected_lease_revision, execution_authority_lease_id,
          execution_authority_fencing_token, execution_deployment_id, execution_authority_epoch,
          execution_fencing_token, execution_consumer_id, status, reserved_at,
          started_at, observed_at, settled_at, released_at, actual_cost_micros, reason_code
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, NULL, NULL, NULL, NULL, NULL, NULL)`,
      )
      .run(
        scope.ownerId,
        scope.agentId,
        input.runId,
        input.logicalSlot,
        sequence,
        invocationId,
        input.modelRef,
        input.provider,
        input.model,
        input.modelVersion,
        input.dataClassification,
        input.source,
        input.ordinal,
        input.pricing.input,
        input.pricing.output,
        input.pricing.cacheRead,
        input.pricing.cacheWrite,
        pricingFingerprint(input.pricing),
        input.estimatedCostMicros,
        allocation.allocation.accountId,
        operationKey,
        input.authorityLease.leaseId,
        input.authority.deploymentId,
        input.authority.authorityEpoch,
        input.authority.fencingToken,
        input.executionLease.executionLeaseId,
        input.executionLease.expectedLeaseRevision,
        input.executionLease.authorityLeaseId,
        input.executionLease.authorityFencingToken,
        input.executionLease.deploymentId,
        input.executionLease.authorityEpoch,
        input.executionLease.fencingToken,
        input.executionLease.consumerId,
        input.reservedAt,
      );
    const created = this.readRowByInvocation(input.runId, invocationId, scope);
    if (!created)
      return this.fail("PORT_INVALID_OPERATION", "Model invocation identity could not be read");
    return { disposition: "fresh", identity: this.toIdentity(created) };
  }

  private markStartedSync(envelope: ParsedEnvelope): ModelInvocationIdentity {
    const input = parseStarted(envelope.input);
    this.assertDiskHeadroom();
    return this.budget.runImmediateTransaction(() =>
      this.markStartedWithinTransaction(envelope.scope, input),
    );
  }

  private markStartedWithinTransaction(
    scope: SqliteModelBudgetScope,
    input: ModelInvocationIdentityStartedInput,
  ): ModelInvocationIdentity {
    this.assertHeldExecutionLease(scope, input.runId, input.executionLease, input.at);
    const row = this.requireRow(scope, input.runId, input.invocationId, input.budgetOperationKey);
    this.assertExecutionLease(row, input.executionLease);
    if (row.status === "started") return this.toIdentity(row);
    if (row.status !== "reserved") {
      return this.fail("PORT_CONFLICT", "Model invocation identity cannot be started");
    }
    this.budget.markStartedWithinTransaction(scope, {
      parent: { kind: "run", runId: input.runId, executionLease: input.executionLease },
      operationKey: input.budgetOperationKey,
      startedAt: input.at,
    });
    this.database
      .prepare(
        `UPDATE model_invocation_identities
         SET status = 'started', started_at = ?
         WHERE owner_id = ? AND agent_id = ? AND run_id = ? AND invocation_id = ?
           AND status = 'reserved'`,
      )
      .run(input.at, scope.ownerId, scope.agentId, input.runId, input.invocationId);
    const updated = this.readRowByInvocation(input.runId, input.invocationId, scope);
    if (!updated) return this.fail("PORT_INVALID_OPERATION", "Started identity could not be read");
    return this.toIdentity(updated);
  }

  private releaseReservedSync(envelope: ParsedEnvelope): ModelInvocationIdentity {
    const input = parseTransition(envelope.input);
    this.assertDiskHeadroom();
    return this.budget.runImmediateTransaction(() =>
      this.releaseReservedWithinTransaction(envelope.scope, input),
    );
  }

  private releaseReservedWithinTransaction(
    scope: SqliteModelBudgetScope,
    input: ModelInvocationIdentityTransitionInput,
  ): ModelInvocationIdentity {
    this.assertCurrentAuthority(scope, input.at);
    const row = this.requireRow(scope, input.runId, input.invocationId, input.budgetOperationKey);
    this.assertExecutionLease(row, input.executionLease);
    if (row.status === "released") return this.toIdentity(row);
    if (row.status !== "reserved") {
      return this.fail("PORT_CONFLICT", "Only a reserved model invocation can be released");
    }
    this.budget.releaseReservedWithinTransaction(scope, {
      parent: { kind: "run", runId: input.runId },
      operationKey: input.budgetOperationKey,
      releasedAt: input.at,
    });
    this.database
      .prepare(
        `UPDATE model_invocation_identities
         SET status = 'released', released_at = ?
         WHERE owner_id = ? AND agent_id = ? AND run_id = ? AND invocation_id = ?
           AND status = 'reserved'`,
      )
      .run(input.at, scope.ownerId, scope.agentId, input.runId, input.invocationId);
    const updated = this.readRowByInvocation(input.runId, input.invocationId, scope);
    if (!updated) return this.fail("PORT_INVALID_OPERATION", "Released identity could not be read");
    return this.toIdentity(updated);
  }

  private settleSync(envelope: ParsedEnvelope): ModelInvocationIdentity {
    const input = parseSettlement(envelope.input);
    this.assertDiskHeadroom();
    return this.budget.runImmediateTransaction(() =>
      this.settleWithinTransaction(envelope.scope, input),
    );
  }

  private settleWithinTransaction(
    scope: SqliteModelBudgetScope,
    input: ModelInvocationIdentitySettlementInput,
  ): ModelInvocationIdentity {
    this.assertCurrentAuthority(scope, input.at);
    const row = this.requireRow(scope, input.runId, input.invocationId, input.budgetOperationKey);
    this.assertExecutionLease(row, input.executionLease);
    if (row.status !== "started" && row.status !== "unknown" && row.status !== "settled") {
      return this.fail("PORT_CONFLICT", "Only started or unknown model invocations can settle");
    }
    const result = this.budget.settleWithinTransaction(scope, {
      parent: { kind: "run", runId: input.runId },
      operationKey: input.budgetOperationKey,
      actualCostMicros: input.actualCostMicros,
      settledAt: input.at,
    });
    if (result.replayed) return this.toIdentity(row);
    this.database
      .prepare(
        `UPDATE model_invocation_identities
         SET status = 'settled', actual_cost_micros = ?, settled_at = ?, reason_code = NULL
         WHERE owner_id = ? AND agent_id = ? AND run_id = ? AND invocation_id = ?
           AND status IN ('started', 'unknown')`,
      )
      .run(
        input.actualCostMicros,
        input.at,
        scope.ownerId,
        scope.agentId,
        input.runId,
        input.invocationId,
      );
    const updated = this.readRowByInvocation(input.runId, input.invocationId, scope);
    if (!updated) return this.fail("PORT_INVALID_OPERATION", "Settled identity could not be read");
    return this.toIdentity(updated);
  }

  private markUnknownSync(envelope: ParsedEnvelope): ModelInvocationIdentity {
    const input = parseUnknown(envelope.input);
    this.assertDiskHeadroom();
    return this.budget.runImmediateTransaction(() =>
      this.markUnknownWithinTransaction(envelope.scope, input),
    );
  }

  private markUnknownWithinTransaction(
    scope: SqliteModelBudgetScope,
    input: ModelInvocationIdentityUnknownInput,
  ): ModelInvocationIdentity {
    this.assertCurrentAuthority(scope, input.at);
    const row = this.requireRow(scope, input.runId, input.invocationId, input.budgetOperationKey);
    this.assertExecutionLease(row, input.executionLease);
    if (row.status === "unknown") {
      if (row.reasonCode !== input.reasonCode) {
        return this.fail("PORT_CONFLICT", "Unknown model invocation reason is immutable");
      }
      this.budget.markUnknownWithinTransaction(scope, {
        parent: { kind: "run", runId: input.runId },
        operationKey: input.budgetOperationKey,
        observedAt: input.at,
        reasonCode: input.reasonCode,
      });
      return this.toIdentity(row);
    }
    if (row.status !== "started") {
      return this.fail("PORT_CONFLICT", "Only a started model invocation can become unknown");
    }
    this.budget.markUnknownWithinTransaction(scope, {
      parent: { kind: "run", runId: input.runId },
      operationKey: input.budgetOperationKey,
      observedAt: input.at,
      reasonCode: input.reasonCode,
    });
    this.database
      .prepare(
        `UPDATE model_invocation_identities
         SET status = 'unknown', observed_at = ?, reason_code = ?
         WHERE owner_id = ? AND agent_id = ? AND run_id = ? AND invocation_id = ?
           AND status = 'started'`,
      )
      .run(
        input.at,
        input.reasonCode,
        scope.ownerId,
        scope.agentId,
        input.runId,
        input.invocationId,
      );
    const updated = this.readRowByInvocation(input.runId, input.invocationId, scope);
    if (!updated) return this.fail("PORT_INVALID_OPERATION", "Unknown identity could not be read");
    return this.toIdentity(updated);
  }

  private readSync(envelope: ParsedEnvelope): ModelInvocationIdentity | undefined {
    const runId = createRunId(machineText(envelope.input["runId"], "runId"));
    const invocationId = text(envelope.input["invocationId"], "invocationId");
    const row = this.readRowByInvocation(runId, invocationId, envelope.scope);
    return row ? this.toIdentity(row) : undefined;
  }

  private assertBeginScope(scope: SqliteModelBudgetScope, input: ParsedBeginInput): void {
    if (
      !sameAuthority(scope.authority, input.authority) ||
      !sameAuthorityLease(scope.authorityLease, input.authorityLease) ||
      !sameAuthority(scope.authority, {
        deploymentId: input.executionLease.deploymentId,
        authorityEpoch: input.executionLease.authorityEpoch,
        fencingToken: input.executionLease.fencingToken,
      }) ||
      !sameAuthorityLease(scope.authorityLease, {
        leaseId: input.executionLease.authorityLeaseId,
        fencingToken: input.executionLease.authorityFencingToken,
      }) ||
      input.executionLease.fencingToken !== input.executionLease.authorityFencingToken
    ) {
      this.fail("PORT_NOT_AUTHORITATIVE", "Model invocation authority is inconsistent");
    }
  }

  private assertHeldExecutionLease(
    scope: SqliteModelBudgetScope,
    runId: ModelInvocationIdentity["runId"],
    claim: RunExecutionLeaseClaim,
    at: string,
  ): void {
    const guard = new SqliteRunDispatchOperations(
      this.database,
      {
        ownerId: scope.ownerId,
        agentId: scope.agentId,
        authority: scope.authority,
        authorityLease: scope.authorityLease,
        consumerId: claim.consumerId,
      },
      this.fail,
    );
    guard.assertHeldInTransaction({
      runId,
      expectedLeaseRevision: claim.expectedLeaseRevision,
      executionLeaseId: claim.executionLeaseId,
      at,
    });
    const run = this.database
      .prepare("SELECT status FROM runs WHERE id = ? AND owner_id = ? AND agent_id = ?")
      .get(runId, scope.ownerId, scope.agentId) as { readonly status: string } | undefined;
    if (!run || !["accepted", "building_context", "running"].includes(run.status)) {
      this.fail("PORT_CONFLICT", "Run is not execution-eligible for a model invocation");
    }
  }

  private assertCurrentAuthority(scope: SqliteModelBudgetScope, at: string): void {
    const value = this.database
      .prepare(
        `SELECT l.deployment_id AS deploymentId, l.authority_epoch AS authorityEpoch,
          l.fencing_token AS fencingToken, l.expires_at AS expiresAt, l.released_at AS releasedAt,
          d.status, d.authority_epoch AS deploymentEpoch,
          d.fencing_token AS deploymentToken
         FROM authority_leases l
         JOIN deployments d ON d.id = l.deployment_id
           AND d.owner_id = l.owner_id AND d.agent_id = l.agent_id
         WHERE l.id = ? AND l.owner_id = ? AND l.agent_id = ?`,
      )
      .get(scope.authorityLease.leaseId, scope.ownerId, scope.agentId);
    if (value === undefined) {
      this.fail("PORT_NOT_AUTHORITATIVE", "Authority lease is outside the model invocation scope");
    }
    const row = record(value, "authority row");
    const deploymentId = text(row["deploymentId"], "deploymentId", 128);
    const authorityEpoch = safeInteger(row["authorityEpoch"], "authorityEpoch", 1);
    const fencingToken = safeInteger(row["fencingToken"], "fencingToken", 1);
    const deploymentEpoch = safeInteger(row["deploymentEpoch"], "deploymentEpoch", 1);
    const deploymentToken = safeInteger(row["deploymentToken"], "deploymentToken", 1);
    const expiresAt = instant(row["expiresAt"], "expiresAt");
    const releasedAt = row["releasedAt"];
    if (
      row["status"] !== "active" ||
      releasedAt !== null ||
      !isAfter(expiresAt, at) ||
      deploymentId !== scope.authority.deploymentId ||
      authorityEpoch !== scope.authority.authorityEpoch ||
      authorityEpoch !== deploymentEpoch ||
      fencingToken !== scope.authority.fencingToken ||
      fencingToken !== scope.authorityLease.fencingToken ||
      deploymentToken !== scope.authority.fencingToken
    ) {
      this.fail("PORT_NOT_AUTHORITATIVE", "Current product authority is stale or expired");
    }
  }

  private assertExecutionLease(row: IdentityRow, claim: RunExecutionLeaseClaim): void {
    if (!sameExecutionLease(row, claim)) {
      this.fail(
        "PORT_NOT_AUTHORITATIVE",
        "Model invocation execution lease is not the frozen claim",
      );
    }
  }

  private requireRow(
    scope: SqliteModelBudgetScope,
    runId: ModelInvocationIdentity["runId"],
    invocationId: string,
    operationKey: string,
  ): IdentityRow {
    const row = this.readRowByInvocation(runId, invocationId, scope);
    if (!row) return this.fail("PORT_NOT_FOUND", "Model invocation identity was not found");
    if (row.budgetOperationKey !== operationKey) {
      return this.fail("PORT_CONFLICT", "Model invocation budget identity is inconsistent");
    }
    return row;
  }

  private readLatest(
    scope: SqliteModelBudgetScope,
    runId: ModelInvocationIdentity["runId"],
    logicalSlot: string,
  ): IdentityRow | undefined {
    const value = this.database
      .prepare(
        `SELECT * FROM model_invocation_identities
         WHERE owner_id = ? AND agent_id = ? AND run_id = ? AND logical_slot = ?
         ORDER BY sequence DESC LIMIT 1`,
      )
      .get(scope.ownerId, scope.agentId, runId, logicalSlot);
    return value === undefined ? undefined : this.parseRow(value);
  }

  private readRowByInvocation(
    runId: ModelInvocationIdentity["runId"],
    invocationId: string,
    scope: SqliteModelBudgetScope,
  ): IdentityRow | undefined {
    const value = this.database
      .prepare(
        `SELECT * FROM model_invocation_identities
         WHERE owner_id = ? AND agent_id = ? AND run_id = ? AND invocation_id = ?`,
      )
      .get(scope.ownerId, scope.agentId, runId, invocationId);
    return value === undefined ? undefined : this.parseRow(value);
  }

  private parseRow(value: unknown): IdentityRow {
    const row = record(value, "model invocation row");
    const status = text(row["status"], "status", 16);
    if (!STATUSES.includes(status as (typeof STATUSES)[number])) {
      return this.fail("PORT_INVALID_OPERATION", "Model invocation status is invalid");
    }
    const reasonValue = row["reason_code"];
    const reasonCode =
      reasonValue === null || reasonValue === undefined
        ? null
        : unknownReason(reasonValue, "reason_code");
    return {
      ownerId: text(row["owner_id"], "owner_id", 128),
      agentId: text(row["agent_id"], "agent_id", 128),
      runId: text(row["run_id"], "run_id", 128),
      logicalSlot: text(row["logical_slot"], "logical_slot"),
      sequence: safeInteger(row["sequence"], "sequence", 1),
      invocationId: text(row["invocation_id"], "invocation_id"),
      modelRef: text(row["model_ref"], "model_ref"),
      provider: text(row["provider"], "provider"),
      model: text(row["model"], "model"),
      modelVersion:
        row["model_version"] === null ? null : text(row["model_version"], "model_version"),
      dataClassification: classification(row["data_classification"], "data_classification"),
      source: source(row["source"], "source"),
      ordinal: safeInteger(row["ordinal"], "ordinal", 1),
      pricingInput: finiteNumber(row["pricing_input"], "pricing_input"),
      pricingOutput: finiteNumber(row["pricing_output"], "pricing_output"),
      pricingCacheRead: finiteNumber(row["pricing_cache_read"], "pricing_cache_read"),
      pricingCacheWrite: finiteNumber(row["pricing_cache_write"], "pricing_cache_write"),
      pricingFingerprint: text(row["pricing_fingerprint"], "pricing_fingerprint", 128),
      estimatedCostMicros: safeInteger(row["estimated_cost_micros"], "estimated_cost_micros"),
      budgetAccountId: text(row["budget_account_id"], "budget_account_id"),
      budgetOperationKey: text(row["budget_operation_key"], "budget_operation_key"),
      authorityLeaseId: text(row["authority_lease_id"], "authority_lease_id", 128),
      authorityDeploymentId: text(row["authority_deployment_id"], "authority_deployment_id", 128),
      authorityEpoch: safeInteger(row["authority_epoch"], "authority_epoch", 1),
      authorityFencingToken: safeInteger(
        row["authority_fencing_token"],
        "authority_fencing_token",
        1,
      ),
      executionLeaseId: text(row["execution_lease_id"], "execution_lease_id", 128),
      executionExpectedLeaseRevision: safeInteger(
        row["execution_expected_lease_revision"],
        "execution_expected_lease_revision",
      ),
      executionAuthorityLeaseId: text(
        row["execution_authority_lease_id"],
        "execution_authority_lease_id",
        128,
      ),
      executionAuthorityFencingToken: safeInteger(
        row["execution_authority_fencing_token"],
        "execution_authority_fencing_token",
        1,
      ),
      executionDeploymentId: text(row["execution_deployment_id"], "execution_deployment_id", 128),
      executionAuthorityEpoch: safeInteger(
        row["execution_authority_epoch"],
        "execution_authority_epoch",
        1,
      ),
      executionFencingToken: safeInteger(
        row["execution_fencing_token"],
        "execution_fencing_token",
        1,
      ),
      executionConsumerId: text(row["execution_consumer_id"], "execution_consumer_id", 128),
      status: status as (typeof STATUSES)[number],
      reservedAt: instant(row["reserved_at"], "reserved_at"),
      startedAt: optionalInstant(row["started_at"], "started_at"),
      observedAt: optionalInstant(row["observed_at"], "observed_at"),
      settledAt: optionalInstant(row["settled_at"], "settled_at"),
      releasedAt: optionalInstant(row["released_at"], "released_at"),
      actualCostMicros:
        row["actual_cost_micros"] === null
          ? null
          : safeInteger(row["actual_cost_micros"], "actual_cost_micros"),
      reasonCode,
    };
  }

  private toIdentity(row: IdentityRow): ModelInvocationIdentity {
    return Object.freeze({
      ownerId: createOwnerId(row.ownerId),
      agentId: createAgentId(row.agentId),
      runId: createRunId(row.runId),
      logicalSlot: row.logicalSlot,
      sequence: row.sequence,
      invocationId: row.invocationId,
      modelRef: row.modelRef,
      provider: row.provider,
      model: row.model,
      modelVersion: row.modelVersion,
      dataClassification: row.dataClassification,
      source: row.source,
      ordinal: row.ordinal,
      pricing: Object.freeze({
        input: row.pricingInput,
        output: row.pricingOutput,
        cacheRead: row.pricingCacheRead,
        cacheWrite: row.pricingCacheWrite,
      }),
      pricingFingerprint: row.pricingFingerprint,
      estimatedCostMicros: row.estimatedCostMicros,
      budgetAccountId: row.budgetAccountId,
      budgetOperationKey: row.budgetOperationKey,
      authority: Object.freeze({
        deploymentId: createDeploymentId(row.authorityDeploymentId),
        authorityEpoch: row.authorityEpoch,
        fencingToken: row.authorityFencingToken,
      }),
      authorityLease: Object.freeze({
        leaseId: createAuthorityLeaseId(row.authorityLeaseId),
        fencingToken: row.authorityFencingToken,
      }),
      executionLease: Object.freeze({
        executionLeaseId: createRunExecutionLeaseId(row.executionLeaseId),
        expectedLeaseRevision: row.executionExpectedLeaseRevision,
        authorityLeaseId: createAuthorityLeaseId(row.executionAuthorityLeaseId),
        authorityFencingToken: row.executionAuthorityFencingToken,
        deploymentId: createDeploymentId(row.executionDeploymentId),
        authorityEpoch: row.executionAuthorityEpoch,
        fencingToken: row.executionFencingToken,
        consumerId: row.executionConsumerId,
      }),
      status: row.status as ModelInvocationIdentityStatus,
      reservedAt: row.reservedAt,
      startedAt: row.startedAt,
      observedAt: row.observedAt,
      settledAt: row.settledAt,
      releasedAt: row.releasedAt,
      actualCostMicros: row.actualCostMicros,
      reasonCode: row.reasonCode,
    });
  }
}

function nextSequence(sequence: number, fail: Failure): number {
  if (sequence >= MAX_SAFE_INTEGER) {
    return fail(
      "PORT_INVALID_OPERATION",
      "Model invocation sequence exceeds the safe integer limit",
    );
  }
  return sequence + 1;
}
