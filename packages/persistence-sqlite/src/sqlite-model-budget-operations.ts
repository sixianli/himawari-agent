import type {
  BackgroundAdmissionLimits,
  BackgroundOccurrenceSettlement,
  ModelBudgetAccount,
  ModelBudgetAccountParent,
  ModelBudgetActiveParent,
  ModelBudgetAllocation,
  ModelBudgetFinalizeInput,
  ModelBudgetLimits,
  ModelBudgetMarkStartedInput,
  ModelBudgetOperationResult,
  ModelBudgetReadInput,
  ModelBudgetReleaseReservedInput,
  ModelBudgetReserveInput,
  ModelBudgetSettlementInput,
  ModelBudgetSnapshot,
  ModelBudgetUnknownInput,
  RunExecutionLeaseClaim,
} from "@himawari-agent/application";
import {
  type BackgroundOccurrence,
  createAgentId,
  createAuthorityLeaseId,
  createDeploymentId,
  createOccurrenceId,
  createOwnerId,
  createRunExecutionLeaseId,
  createRunId,
  type ProductAuthorityFence,
} from "@himawari-agent/domain";
import type Database from "better-sqlite3";
import { SqliteRunDispatchOperations } from "./sqlite-run-dispatch-operations.ts";

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const CLASSIFICATIONS = ["public", "private", "sensitive", "restricted"] as const;
type ModelClassification = (typeof CLASSIFICATIONS)[number];
type Failure = (code: string, message: string, details?: Readonly<Record<string, string>>) => never;

export interface SqliteModelBudgetScope {
  readonly ownerId: ReturnType<typeof createOwnerId>;
  readonly agentId: ReturnType<typeof createAgentId>;
  readonly authority: ProductAuthorityFence;
  readonly authorityLease: {
    readonly leaseId: ReturnType<typeof createAuthorityLeaseId>;
    readonly fencingToken: number;
  };
}

type Scope = SqliteModelBudgetScope;

interface AccountRow {
  readonly ownerId: string;
  readonly agentId: string;
  readonly accountId: string;
  readonly parentKind: "run" | "occurrence" | "memory-projection";
  readonly projectionJobId: string | null;
  readonly runId: string | null;
  readonly occurrenceId: string | null;
  readonly dataClassification: ModelClassification;
  readonly reservedCostMicros: number;
  readonly spentCostMicros: number;
  readonly status: "active" | "reconcile_required" | "over_budget";
  readonly revision: number;
}

interface AllocationRow {
  readonly ownerId: string;
  readonly agentId: string;
  readonly accountId: string;
  readonly operationKey: string;
  readonly modelRef: string;
  readonly dataClassification: ModelClassification;
  readonly estimatedCostMicros: number;
  readonly actualCostMicros: number | null;
  readonly status: "reserved" | "started" | "unknown" | "settled" | "released";
  readonly reservedAt: string;
  readonly startedAt: string | null;
  readonly observedAt: string | null;
  readonly settledAt: string | null;
  readonly reasonCode: "provider_unresolved" | "transport_unresolved" | "cancel_unresolved" | null;
}

interface ParsedEnvelope {
  readonly scope: Scope;
  readonly input: Record<string, unknown>;
}

interface ParsedRunParent {
  readonly kind: "run";
  readonly runId: ReturnType<typeof createRunId>;
  readonly executionLease: RunExecutionLeaseClaim;
}

interface ParsedOccurrenceParent {
  readonly kind: "occurrence";
  readonly occurrenceId: ReturnType<typeof createOccurrenceId>;
  readonly expectedRevision: number;
  readonly workLeaseId: string;
  readonly workLeaseHolderId: string;
}

type ParsedParent =
  | ParsedRunParent
  | ParsedOccurrenceParent
  | Extract<ModelBudgetActiveParent, { kind: "memory-projection" }>;
type AccountParent = ModelBudgetAccountParent;

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function text(value: unknown, name: string, maximum = 512): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new TypeError(`${name} must be a nonempty bounded string`);
  }
  return value;
}

function machineText(value: unknown, name: string): string {
  const result = text(value, name, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result)) {
    throw new TypeError(`${name} must be a machine identifier`);
  }
  return result;
}

function safeInteger(value: unknown, name: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function instant(value: unknown, name: string): string {
  const result = text(value, name, 64);
  const parsed = new Date(result);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== result) {
    throw new TypeError(`${name} must be an ISO timestamp`);
  }
  return result;
}

function classification(value: unknown, name: string): ModelClassification {
  const result = text(value, name, 16);
  if (!CLASSIFICATIONS.includes(result as ModelClassification)) {
    throw new TypeError(`${name} is not a supported data classification`);
  }
  return result as ModelClassification;
}

function optionalText(value: unknown, name: string): string | null {
  return value === null || value === undefined ? null : text(value, name);
}

function addCost(left: number, right: number, name: string, fail: Failure): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || right < 0 || left < 0) {
    return fail("PORT_INVALID_OPERATION", `${name} must be a nonnegative safe integer`);
  }
  if (left > MAX_SAFE_INTEGER - right) {
    return fail("PORT_INVALID_OPERATION", `${name} addition exceeds the safe integer limit`);
  }
  return left + right;
}

function subtractCost(left: number, right: number, name: string, fail: Failure): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left < 0 || right < 0) {
    return fail("PORT_INVALID_OPERATION", `${name} must be a nonnegative safe integer`);
  }
  if (right > left) return fail("PORT_CONFLICT", `${name} reservation is inconsistent`);
  return left - right;
}

function classificationRank(value: ModelClassification): number {
  return CLASSIFICATIONS.indexOf(value);
}

export class SqliteModelBudgetOperations {
  private readonly database: Database.Database;
  private readonly fail: Failure;
  private readonly assertDiskHeadroom: () => void;

  constructor(database: Database.Database, fail: Failure, assertDiskHeadroom: () => void) {
    this.database = database;
    this.fail = fail;
    this.assertDiskHeadroom = assertDiskHeadroom;
  }

  runImmediateTransaction<TResult>(operation: () => TResult): TResult {
    this.assertDiskHeadroom();
    return this.database.transaction(operation).immediate();
  }

  execute(operation: string, payload: unknown): unknown {
    try {
      const envelope = this.parseEnvelope(payload);
      switch (operation) {
        case "modelBudget.read":
          return this.readSync(envelope);
        case "modelBudget.reserve":
          return this.reserveSync(envelope);
        case "modelBudget.markStarted":
          return this.markStartedSync(envelope);
        case "modelBudget.settle":
          return this.settleSync(envelope);
        case "modelBudget.markUnknown":
          return this.markUnknownSync(envelope);
        case "modelBudget.releaseReserved":
          return this.releaseReservedSync(envelope);
        case "modelBudget.finalize":
          return this.finalizeSync(envelope);
        default:
          return this.fail("PORT_INVALID_OPERATION", "Unknown model budget operation");
      }
    } catch (error) {
      if (error instanceof TypeError) return this.fail("PORT_INVALID_OPERATION", error.message);
      throw error;
    }
  }

  ensureOccurrenceAccountWithinTransaction(input: {
    readonly occurrence: BackgroundOccurrence;
  }): AccountRow {
    this.requireTransaction("Budget occurrence account creation");
    const parent: AccountParent = {
      kind: "occurrence",
      occurrenceId: createOccurrenceId(input.occurrence.id),
    };
    return this.ensureAccount(
      input.occurrence.ownerId,
      input.occurrence.agentId,
      parent,
      input.occurrence.dataClassification,
    );
  }

  assertNoRunBudgetAccountWithinTransaction(input: {
    readonly ownerId: string;
    readonly agentId: string;
    readonly runId: string;
  }): void {
    this.requireTransaction("Budget Run parent ownership check");
    const row = this.database
      .prepare(
        `SELECT 1 FROM model_budget_accounts
         WHERE owner_id = ? AND agent_id = ? AND run_id = ? LIMIT 1`,
      )
      .get(input.ownerId, input.agentId, input.runId);
    if (row !== undefined) {
      this.fail(
        "PORT_CONFLICT",
        "A Run already owns a model budget account and cannot admit a background occurrence",
      );
    }
  }

  assertNoBackgroundOccurrenceParentWithinTransaction(input: {
    readonly ownerId: string;
    readonly agentId: string;
    readonly runId: string;
  }): void {
    this.requireTransaction("Budget background parent ownership check");
    const row = this.database
      .prepare(
        `SELECT 1 FROM job_occurrences
         WHERE owner_id = ? AND agent_id = ? AND run_id = ? LIMIT 1`,
      )
      .get(input.ownerId, input.agentId, input.runId);
    if (row !== undefined) {
      this.fail(
        "PORT_CONFLICT",
        "A Run is already owned by a background occurrence and cannot create a Run budget account",
      );
    }
  }

  reserveOccurrenceWithinTransaction(input: {
    readonly occurrence: BackgroundOccurrence;
    readonly limits: BackgroundAdmissionLimits;
  }): {
    readonly reservedCostMicros: number;
    readonly spentCostMicros: number;
    readonly reasonCode:
      | "GLOBAL_BUDGET_EXHAUSTED"
      | "CLASSIFICATION_BUDGET_EXHAUSTED"
      | "RUN_BUDGET_EXCEEDED"
      | null;
  } {
    this.requireTransaction("Budget occurrence reservation");
    const account = this.ensureOccurrenceAccountWithinTransaction({ occurrence: input.occurrence });
    const limits = this.parseLegacyLimits(input.limits);
    if (account.status === "reconcile_required") {
      return {
        reservedCostMicros: account.reservedCostMicros,
        spentCostMicros: account.spentCostMicros,
        reasonCode: "RUN_BUDGET_EXCEEDED",
      };
    }
    if (account.status === "over_budget") {
      return {
        reservedCostMicros: account.reservedCostMicros,
        spentCostMicros: account.spentCostMicros,
        reasonCode: "RUN_BUDGET_EXCEEDED",
      };
    }
    const nextTotal = addCost(
      addCost(account.reservedCostMicros, account.spentCostMicros, "Run budget", this.fail),
      input.occurrence.estimatedCostMicros,
      "Run budget",
      this.fail,
    );
    if (nextTotal > limits.accountCostMicros) {
      return {
        reservedCostMicros: account.reservedCostMicros,
        spentCostMicros: account.spentCostMicros,
        reasonCode: "RUN_BUDGET_EXCEEDED",
      };
    }
    const usage = this.readUsage(input.occurrence.ownerId, input.occurrence.agentId);
    const globalNext = addCost(
      usage.global,
      input.occurrence.estimatedCostMicros,
      "Global budget",
      this.fail,
    );
    if (globalNext > limits.globalCostMicros) {
      return {
        reservedCostMicros: account.reservedCostMicros,
        spentCostMicros: account.spentCostMicros,
        reasonCode: "GLOBAL_BUDGET_EXHAUSTED",
      };
    }
    const occurrenceClassification = input.occurrence.dataClassification as ModelClassification;
    const classificationLimit = limits.perClassificationCostMicros[occurrenceClassification];
    const classificationNext = addCost(
      usage.byClassification[occurrenceClassification],
      input.occurrence.estimatedCostMicros,
      "Classification budget",
      this.fail,
    );
    if (classificationNext > classificationLimit) {
      return {
        reservedCostMicros: account.reservedCostMicros,
        spentCostMicros: account.spentCostMicros,
        reasonCode: "CLASSIFICATION_BUDGET_EXHAUSTED",
      };
    }
    const reserved = addCost(
      account.reservedCostMicros,
      input.occurrence.estimatedCostMicros,
      "Reserved budget",
      this.fail,
    );
    this.updateAccount(account, reserved, account.spentCostMicros, "active");
    return {
      reservedCostMicros: reserved,
      spentCostMicros: account.spentCostMicros,
      reasonCode: null,
    };
  }

  settleOccurrenceWithinTransaction(input: {
    readonly occurrence: BackgroundOccurrence;
    readonly settlement: BackgroundOccurrenceSettlement;
  }): {
    readonly reservedCostMicros: number;
    readonly spentCostMicros: number;
  } {
    this.requireTransaction("Budget occurrence settlement");
    const account = this.ensureOccurrenceAccountWithinTransaction({ occurrence: input.occurrence });
    const children = this.childAllocationState(
      account.accountId,
      input.occurrence.ownerId,
      input.occurrence.agentId,
    );
    if (
      children.open ||
      children.unknown ||
      (children.settled && input.settlement.spentCostMicros !== 0)
    ) {
      return this.fail(
        "PORT_CONFLICT",
        "Occurrence settlement cannot rewrite or release child model allocation facts",
      );
    }
    if (input.settlement.outcome === "external_result_unknown") {
      this.updateAccount(
        account,
        account.reservedCostMicros,
        account.spentCostMicros,
        "reconcile_required",
      );
      return {
        reservedCostMicros: account.reservedCostMicros,
        spentCostMicros: account.spentCostMicros,
      };
    }
    const reserved = 0;
    const spent = addCost(
      account.spentCostMicros,
      input.settlement.spentCostMicros,
      "Spent budget",
      this.fail,
    );
    const overBudget =
      account.status === "over_budget" ||
      input.settlement.spentCostMicros > input.occurrence.reservedCostMicros;
    this.updateAccount(account, reserved, spent, overBudget ? "over_budget" : "active");
    return { reservedCostMicros: reserved, spentCostMicros: spent };
  }

  hasOpenChildAllocationsWithinTransaction(input: {
    readonly ownerId: string;
    readonly agentId: string;
    readonly accountId: string;
  }): boolean {
    this.requireTransaction("Budget child allocation check");
    return this.childAllocationState(input.accountId, input.ownerId, input.agentId).open;
  }

  occurrenceRequiresReconciliationWithinTransaction(input: {
    readonly ownerId: string;
    readonly agentId: string;
    readonly occurrenceId: string;
  }): boolean {
    this.requireTransaction("Budget occurrence reconciliation check");
    const row = this.database
      .prepare(
        `SELECT 1 FROM model_budget_accounts
         WHERE owner_id = ? AND agent_id = ? AND occurrence_id = ?
           AND status = 'reconcile_required' LIMIT 1`,
      )
      .get(input.ownerId, input.agentId, input.occurrenceId);
    return row !== undefined;
  }

  private parseEnvelope(payload: unknown): ParsedEnvelope {
    const value = record(payload, "model budget request");
    const scopeValue = record(value["scope"], "scope");
    const authorityValue = record(scopeValue["authority"], "authority");
    const leaseValue = record(scopeValue["authorityLease"], "authorityLease");
    const scope: Scope = {
      ownerId: createOwnerId(machineText(scopeValue["ownerId"], "ownerId")),
      agentId: createAgentId(machineText(scopeValue["agentId"], "agentId")),
      authority: {
        deploymentId: createDeploymentId(
          machineText(authorityValue["deploymentId"], "deploymentId"),
        ),
        authorityEpoch: safeInteger(authorityValue["authorityEpoch"], "authorityEpoch", 1),
        fencingToken: safeInteger(authorityValue["fencingToken"], "fencingToken", 1),
      },
      authorityLease: {
        leaseId: createAuthorityLeaseId(machineText(leaseValue["leaseId"], "leaseId")),
        fencingToken: safeInteger(leaseValue["fencingToken"], "lease.fencingToken", 1),
      },
    };
    return { scope, input: record(value["input"], "model budget input") };
  }

  private readSync(envelope: ParsedEnvelope): ModelBudgetSnapshot | undefined {
    const input = this.parseRead(envelope.input);
    const parent = input.parent;
    const account = this.readAccount(
      envelope.scope.ownerId,
      envelope.scope.agentId,
      accountId(parent),
    );
    if (!account) return undefined;
    this.assertAccountParent(account, parent);
    const rows = this.database
      .prepare(
        `SELECT owner_id AS ownerId, agent_id AS agentId, account_id AS accountId,
          operation_key AS operationKey, model_ref AS modelRef,
          data_classification AS dataClassification,
          estimated_cost_micros AS estimatedCostMicros,
          actual_cost_micros AS actualCostMicros, status, reserved_at AS reservedAt,
          started_at AS startedAt, observed_at AS observedAt, settled_at AS settledAt,
          reason_code AS reasonCode
         FROM model_budget_allocations
         WHERE owner_id = ? AND agent_id = ? AND account_id = ?
           AND (? IS NULL OR operation_key > ?)
         ORDER BY operation_key
         LIMIT ?`,
      )
      .all(
        envelope.scope.ownerId,
        envelope.scope.agentId,
        account.accountId,
        input.afterOperationKey,
        input.afterOperationKey,
        input.limit + 1,
      );
    const hasMore = rows.length > input.limit;
    const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
    const allocations = pageRows.map((row) => this.toAllocation(this.parseAllocation(row)));
    return Object.freeze({
      account: this.toAccount(account),
      allocations: Object.freeze(allocations),
      nextOperationKey: hasMore
        ? (allocations[allocations.length - 1]?.operationKey ?? null)
        : null,
    });
  }

  private reserveSync(envelope: ParsedEnvelope): ModelBudgetOperationResult {
    const input = this.parseReserve(envelope.input);
    return this.runImmediateTransaction(() => this.reserveWithinTransaction(envelope.scope, input));
  }

  reserveWithinTransaction(
    scope: SqliteModelBudgetScope,
    input: ModelBudgetReserveInput,
  ): ModelBudgetOperationResult {
    this.requireTransaction("Model budget reservation");
    this.assertCurrentAuthority(scope, input.reservedAt);
    if (input.parent.kind === "memory-projection")
      this.assertParent(scope, input.parent, input.reservedAt, true);
    const id = accountId(input.parent);
    const existingAccount = this.readAccount(scope.ownerId, scope.agentId, id);
    const existing = this.readAllocation(scope.ownerId, scope.agentId, id, input.operationKey);
    if (existing) {
      if (
        existing.modelRef !== input.modelRef ||
        existing.dataClassification !== input.dataClassification ||
        existing.estimatedCostMicros !== input.estimatedCostMicros
      ) {
        return this.fail(
          "PORT_CONFLICT",
          "Model budget operation identity has conflicting semantics",
        );
      }
      if (!existingAccount)
        return this.fail("PORT_INVALID_OPERATION", "Budget allocation has no parent account");
      this.assertAccountParent(existingAccount, input.parent);
      return this.result(existingAccount, existing, true);
    }
    this.assertParent(scope, input.parent, input.reservedAt, true);
    if (input.parent.kind === "run") {
      this.assertNoBackgroundOccurrenceParentWithinTransaction({
        ownerId: scope.ownerId,
        agentId: scope.agentId,
        runId: input.parent.runId,
      });
      this.assertRunClassification(scope, input.parent.runId, input.dataClassification);
    }
    if (
      input.parent.kind === "memory-projection" &&
      this.projectionJob(scope, input.parent.jobId).dataClassification !== input.dataClassification
    )
      this.fail("PORT_NOT_AUTHORITATIVE", "Memory projection classification mismatch");
    if (!existingAccount && input.parent.kind === "occurrence") {
      return this.fail(
        "PORT_NOT_FOUND",
        "Occurrence budget account must be admitted before model allocation",
      );
    }
    const account =
      existingAccount ??
      this.insertAccount(scope.ownerId, scope.agentId, input.parent, input.dataClassification);
    this.assertAccountClassification(account, input.dataClassification);
    if (account.status !== "active") {
      return this.fail("PORT_CONFLICT", "Budget account is not available for a new allocation");
    }
    const limits = input.limits;
    const accountTotal = addCost(
      account.reservedCostMicros,
      account.spentCostMicros,
      "Account budget",
      this.fail,
    );
    let nextReserved: number;
    if (input.parent.kind === "occurrence") {
      const outstanding = this.outstandingChildReservation(
        scope.ownerId,
        scope.agentId,
        account.accountId,
      );
      const available = subtractCost(
        account.reservedCostMicros,
        outstanding,
        "Occurrence budget",
        this.fail,
      );
      if (input.estimatedCostMicros > available) {
        return this.fail("PORT_CONFLICT", "Occurrence budget reservation is exhausted");
      }
      nextReserved = account.reservedCostMicros;
    } else {
      if (
        addCost(accountTotal, input.estimatedCostMicros, "Account budget", this.fail) >
        limits.accountCostMicros
      ) {
        return this.fail("PORT_CONFLICT", "Run budget limit is exhausted");
      }
      const usage = this.readUsage(scope.ownerId, scope.agentId);
      if (
        addCost(usage.global, input.estimatedCostMicros, "Global budget", this.fail) >
        limits.globalCostMicros
      ) {
        return this.fail("PORT_CONFLICT", "Global model budget is exhausted");
      }
      if (
        addCost(
          usage.byClassification[input.dataClassification],
          input.estimatedCostMicros,
          "Classification budget",
          this.fail,
        ) > limits.perClassificationCostMicros[input.dataClassification]
      ) {
        return this.fail("PORT_CONFLICT", "Classification model budget is exhausted");
      }
      nextReserved = addCost(
        account.reservedCostMicros,
        input.estimatedCostMicros,
        "Reserved budget",
        this.fail,
      );
    }
    this.database
      .prepare(
        `INSERT INTO model_budget_allocations (
            owner_id, agent_id, account_id, operation_key, model_ref,
            data_classification, estimated_cost_micros, actual_cost_micros,
            status, reserved_at, started_at, observed_at, settled_at, reason_code
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'reserved', ?, NULL, NULL, NULL, NULL)`,
      )
      .run(
        scope.ownerId,
        scope.agentId,
        account.accountId,
        input.operationKey,
        input.modelRef,
        input.dataClassification,
        input.estimatedCostMicros,
        input.reservedAt,
      );
    const updated = this.updateAccount(account, nextReserved, account.spentCostMicros, "active");
    const allocation = this.readAllocation(
      scope.ownerId,
      scope.agentId,
      account.accountId,
      input.operationKey,
    );
    if (!allocation)
      return this.fail("PORT_INVALID_OPERATION", "Budget allocation could not be read");
    return this.result(updated, allocation, false);
  }

  private markStartedSync(envelope: ParsedEnvelope): ModelBudgetOperationResult {
    const input = this.parseMarkStarted(envelope.input);
    return this.runImmediateTransaction(() =>
      this.markStartedWithinTransaction(envelope.scope, input),
    );
  }

  markStartedWithinTransaction(
    scope: SqliteModelBudgetScope,
    input: ModelBudgetMarkStartedInput,
  ): ModelBudgetOperationResult {
    this.requireTransaction("Model budget start");
    this.assertCurrentAuthority(scope, input.startedAt);
    const parent = input.parent;
    if (parent.kind === "memory-projection")
      this.assertParent(scope, parent, input.startedAt, true);
    const id = accountId(parent);
    const account = this.readAccount(scope.ownerId, scope.agentId, id);
    const allocation = this.readAllocation(scope.ownerId, scope.agentId, id, input.operationKey);
    if (!account || !allocation)
      return this.fail("PORT_NOT_FOUND", "Model budget allocation was not found");
    this.assertAccountParent(account, parent);
    if (allocation.status === "started") return this.result(account, allocation, true);
    if (allocation.status !== "reserved") {
      return this.fail("PORT_CONFLICT", "Model budget allocation cannot be started");
    }
    this.assertParent(scope, parent, input.startedAt, true);
    if (account.status !== "active")
      return this.fail("PORT_CONFLICT", "Budget account is not active");
    this.database
      .prepare(
        `UPDATE model_budget_allocations SET status = 'started', started_at = ?
           WHERE owner_id = ? AND agent_id = ? AND account_id = ? AND operation_key = ?
             AND status = 'reserved'`,
      )
      .run(input.startedAt, scope.ownerId, scope.agentId, id, input.operationKey);
    const updated = this.readAllocation(scope.ownerId, scope.agentId, id, input.operationKey);
    if (!updated)
      return this.fail("PORT_INVALID_OPERATION", "Started budget allocation could not be read");
    return this.result(account, updated, false);
  }

  private settleSync(envelope: ParsedEnvelope): ModelBudgetOperationResult {
    const input = this.parseSettlement(envelope.input);
    return this.runImmediateTransaction(() => this.settleWithinTransaction(envelope.scope, input));
  }

  settleWithinTransaction(
    scope: SqliteModelBudgetScope,
    input: ModelBudgetSettlementInput,
  ): ModelBudgetOperationResult {
    this.requireTransaction("Model budget settlement");
    this.assertCurrentAuthority(scope, input.settledAt);
    const id = accountId(input.parent);
    const account = this.readAccount(scope.ownerId, scope.agentId, id);
    const allocation = this.readAllocation(scope.ownerId, scope.agentId, id, input.operationKey);
    if (!account || !allocation)
      return this.fail("PORT_NOT_FOUND", "Model budget allocation was not found");
    this.assertAccountParent(account, input.parent);
    if (allocation.status === "settled") {
      if (allocation.actualCostMicros !== input.actualCostMicros) {
        return this.fail("PORT_CONFLICT", "Settled model budget cost is immutable");
      }
      return this.result(account, allocation, true);
    }
    if (allocation.status !== "started" && allocation.status !== "unknown") {
      return this.fail("PORT_CONFLICT", "Only started or unknown allocations can be settled");
    }
    this.assertAccountParentScope(scope, input.parent);
    const reserved = subtractCost(
      account.reservedCostMicros,
      allocation.estimatedCostMicros,
      "Reserved budget",
      this.fail,
    );
    const spent = addCost(
      account.spentCostMicros,
      input.actualCostMicros,
      "Spent budget",
      this.fail,
    );
    const status =
      account.status === "over_budget"
        ? "over_budget"
        : input.actualCostMicros > allocation.estimatedCostMicros
          ? "over_budget"
          : this.remainingUnknown(id, scope, input.operationKey)
            ? "reconcile_required"
            : "active";
    const updatedAccount = this.updateAccount(account, reserved, spent, status);
    this.database
      .prepare(
        `UPDATE model_budget_allocations
           SET status = 'settled', actual_cost_micros = ?, settled_at = ?, reason_code = NULL
           WHERE owner_id = ? AND agent_id = ? AND account_id = ? AND operation_key = ?
             AND status IN ('reserved', 'started', 'unknown')`,
      )
      .run(
        input.actualCostMicros,
        input.settledAt,
        scope.ownerId,
        scope.agentId,
        id,
        input.operationKey,
      );
    const updated = this.readAllocation(scope.ownerId, scope.agentId, id, input.operationKey);
    if (!updated)
      return this.fail("PORT_INVALID_OPERATION", "Settled budget allocation could not be read");
    return this.result(updatedAccount, updated, false);
  }

  private markUnknownSync(envelope: ParsedEnvelope): ModelBudgetOperationResult {
    const input = this.parseUnknown(envelope.input);
    return this.runImmediateTransaction(() =>
      this.markUnknownWithinTransaction(envelope.scope, input),
    );
  }

  markUnknownWithinTransaction(
    scope: SqliteModelBudgetScope,
    input: ModelBudgetUnknownInput,
  ): ModelBudgetOperationResult {
    this.requireTransaction("Model budget unknown observation");
    this.assertCurrentAuthority(scope, input.observedAt);
    const id = accountId(input.parent);
    const account = this.readAccount(scope.ownerId, scope.agentId, id);
    const allocation = this.readAllocation(scope.ownerId, scope.agentId, id, input.operationKey);
    if (!account || !allocation)
      return this.fail("PORT_NOT_FOUND", "Model budget allocation was not found");
    this.assertAccountParent(account, input.parent);
    if (allocation.status === "unknown") {
      if (allocation.reasonCode !== input.reasonCode) {
        return this.fail("PORT_CONFLICT", "Unknown model budget reason is immutable");
      }
      return this.result(account, allocation, true);
    }
    if (allocation.status !== "started") {
      return this.fail("PORT_CONFLICT", "Only started allocations can become unknown");
    }
    this.assertAccountParentScope(scope, input.parent);
    const updatedAccount = this.updateAccount(
      account,
      account.reservedCostMicros,
      account.spentCostMicros,
      account.status === "over_budget" ? "over_budget" : "reconcile_required",
    );
    this.database
      .prepare(
        `UPDATE model_budget_allocations
           SET status = 'unknown', observed_at = ?, reason_code = ?
           WHERE owner_id = ? AND agent_id = ? AND account_id = ? AND operation_key = ?
             AND status = 'started'`,
      )
      .run(
        input.observedAt,
        input.reasonCode,
        scope.ownerId,
        scope.agentId,
        id,
        input.operationKey,
      );
    const updated = this.readAllocation(scope.ownerId, scope.agentId, id, input.operationKey);
    if (!updated)
      return this.fail("PORT_INVALID_OPERATION", "Unknown budget allocation could not be read");
    return this.result(updatedAccount, updated, false);
  }

  private releaseReservedSync(envelope: ParsedEnvelope): ModelBudgetOperationResult {
    const input = this.parseReleaseReserved(envelope.input);
    return this.runImmediateTransaction(() =>
      this.releaseReservedWithinTransaction(envelope.scope, input),
    );
  }

  releaseReservedWithinTransaction(
    scope: SqliteModelBudgetScope,
    input: ModelBudgetReleaseReservedInput,
  ): ModelBudgetOperationResult {
    this.requireTransaction("Model budget reservation release");
    this.assertCurrentAuthority(scope, input.releasedAt);
    const id = accountId(input.parent);
    const account = this.readAccount(scope.ownerId, scope.agentId, id);
    const allocation = this.readAllocation(scope.ownerId, scope.agentId, id, input.operationKey);
    if (!account || !allocation)
      return this.fail("PORT_NOT_FOUND", "Model budget allocation was not found");
    this.assertAccountParent(account, input.parent);
    if (allocation.status === "released") return this.result(account, allocation, true);
    if (allocation.status !== "reserved")
      return this.fail("PORT_CONFLICT", "Only reserved model budget allocations can be released");
    this.assertAccountParentScope(scope, input.parent);
    const reserved = subtractCost(
      account.reservedCostMicros,
      allocation.estimatedCostMicros,
      "Reserved budget",
      this.fail,
    );
    const updatedAccount = this.updateAccount(
      account,
      reserved,
      account.spentCostMicros,
      account.status,
    );
    this.database
      .prepare(
        `UPDATE model_budget_allocations
           SET status = 'released', reason_code = NULL
           WHERE owner_id = ? AND agent_id = ? AND account_id = ? AND operation_key = ?
             AND status = 'reserved'`,
      )
      .run(scope.ownerId, scope.agentId, id, input.operationKey);
    const updated = this.readAllocation(scope.ownerId, scope.agentId, id, input.operationKey);
    if (!updated)
      return this.fail("PORT_INVALID_OPERATION", "Released budget allocation could not be read");
    return this.result(updatedAccount, updated, false);
  }

  private finalizeSync(envelope: ParsedEnvelope): ModelBudgetAccount {
    const input = this.parseFinalize(envelope.input);
    this.assertDiskHeadroom();
    const transaction = this.database.transaction(() => {
      this.assertCurrentAuthority(envelope.scope, input.finalizedAt);
      this.assertAccountParentScope(envelope.scope, input.parent);
      const run = this.database
        .prepare("SELECT status FROM runs WHERE id = ? AND owner_id = ? AND agent_id = ?")
        .get(input.parent.runId, envelope.scope.ownerId, envelope.scope.agentId) as
        | { readonly status: string }
        | undefined;
      if (!run || !["completed", "failed", "cancelled"].includes(run.status)) {
        return this.fail(
          "PORT_CONFLICT",
          "A model budget account can finalize only after Run termination",
        );
      }
      const id = accountId(input.parent);
      const existing = this.readAccount(envelope.scope.ownerId, envelope.scope.agentId, id);
      if (!existing) {
        this.assertNoBackgroundOccurrenceParentWithinTransaction({
          ownerId: envelope.scope.ownerId,
          agentId: envelope.scope.agentId,
          runId: input.parent.runId,
        });
      }
      const account =
        existing ??
        this.insertAccount(
          envelope.scope.ownerId,
          envelope.scope.agentId,
          input.parent,
          this.runClassification(envelope.scope, input.parent.runId),
        );
      this.assertAccountParent(account, input.parent);
      this.database
        .prepare(
          `UPDATE model_budget_allocations
           SET status = 'released'
           WHERE owner_id = ? AND agent_id = ? AND account_id = ? AND status = 'reserved'`,
        )
        .run(envelope.scope.ownerId, envelope.scope.agentId, account.accountId);
      const outstanding = this.outstandingChildReservation(
        envelope.scope.ownerId,
        envelope.scope.agentId,
        account.accountId,
      );
      if (outstanding > account.reservedCostMicros) {
        return this.fail(
          "PORT_CONFLICT",
          "Budget account reservation is below open child allocations",
        );
      }
      const childState = this.childAllocationState(
        account.accountId,
        envelope.scope.ownerId,
        envelope.scope.agentId,
      );
      const status =
        account.status === "over_budget"
          ? "over_budget"
          : childState.open || childState.unknown
            ? "reconcile_required"
            : "active";
      const updated = this.updateAccount(account, outstanding, account.spentCostMicros, status);
      return this.toAccount(updated);
    });
    return transaction.immediate();
  }

  private parseRead(input: Record<string, unknown>): ModelBudgetReadInput {
    const limit = safeInteger(input["limit"], "limit", 1);
    if (limit > 1000) throw new TypeError("limit must be <= 1000");
    return {
      parent: this.parseAccountParent(input["parent"]),
      limit,
      afterOperationKey: optionalText(input["afterOperationKey"], "afterOperationKey"),
    };
  }

  private parseAccountParent(value: unknown): ModelBudgetAccountParent {
    const row = record(value, "parent");
    if (row["kind"] === "run") {
      return {
        kind: "run",
        runId: createRunId(machineText(row["runId"], "runId")),
      };
    }
    if (row["kind"] === "occurrence") {
      return {
        kind: "occurrence",
        occurrenceId: createOccurrenceId(machineText(row["occurrenceId"], "occurrenceId")),
      };
    }
    if (row["kind"] === "memory-projection")
      return { kind: "memory-projection", jobId: text(row["jobId"], "jobId") };
    throw new TypeError("parent kind is invalid");
  }

  private parseParent(value: unknown): ModelBudgetActiveParent {
    const row = record(value, "parent");
    if (row["kind"] === "run") {
      const claim = record(row["executionLease"], "executionLease");
      return {
        kind: "run",
        runId: createRunId(machineText(row["runId"], "runId")),
        executionLease: {
          executionLeaseId: createRunExecutionLeaseId(
            machineText(claim["executionLeaseId"], "executionLeaseId"),
          ),
          expectedLeaseRevision: safeInteger(
            claim["expectedLeaseRevision"],
            "expectedLeaseRevision",
          ),
          authorityLeaseId: createAuthorityLeaseId(
            machineText(claim["authorityLeaseId"], "authorityLeaseId"),
          ),
          authorityFencingToken: safeInteger(
            claim["authorityFencingToken"],
            "authorityFencingToken",
            1,
          ),
          deploymentId: createDeploymentId(machineText(claim["deploymentId"], "deploymentId")),
          authorityEpoch: safeInteger(claim["authorityEpoch"], "authorityEpoch", 1),
          fencingToken: safeInteger(claim["fencingToken"], "fencingToken", 1),
          consumerId: machineText(claim["consumerId"], "consumerId"),
        },
      };
    }
    if (row["kind"] === "occurrence") {
      return {
        kind: "occurrence",
        occurrenceId: createOccurrenceId(machineText(row["occurrenceId"], "occurrenceId")),
        expectedRevision: safeInteger(row["expectedRevision"], "expectedRevision"),
        workLeaseId: machineText(row["workLeaseId"], "workLeaseId"),
        workLeaseHolderId: machineText(row["workLeaseHolderId"], "workLeaseHolderId"),
      };
    }
    if (row["kind"] === "memory-projection")
      return {
        kind: "memory-projection",
        jobId: text(row["jobId"], "jobId"),
        claimedBy: text(row["claimedBy"], "claimedBy"),
        attemptCount: safeInteger(row["attemptCount"], "attemptCount", 1),
      };
    throw new TypeError("parent kind is invalid");
  }

  private parseReserve(
    input: Record<string, unknown>,
  ): ModelBudgetReserveInput & { parent: ParsedParent } {
    const limits = record(input["limits"], "limits");
    const classLimits = record(
      limits["perClassificationCostMicros"],
      "perClassificationCostMicros",
    );
    return {
      parent: this.parseParent(input["parent"]),
      operationKey: text(input["operationKey"], "operationKey"),
      modelRef: text(input["modelRef"], "modelRef", 256),
      dataClassification: classification(input["dataClassification"], "dataClassification"),
      estimatedCostMicros: safeInteger(input["estimatedCostMicros"], "estimatedCostMicros"),
      limits: {
        accountCostMicros: safeInteger(limits["accountCostMicros"], "accountCostMicros"),
        globalCostMicros: safeInteger(limits["globalCostMicros"], "globalCostMicros"),
        perClassificationCostMicros: {
          public: safeInteger(classLimits["public"], "perClassificationCostMicros.public"),
          private: safeInteger(classLimits["private"], "perClassificationCostMicros.private"),
          sensitive: safeInteger(classLimits["sensitive"], "perClassificationCostMicros.sensitive"),
          restricted: safeInteger(
            classLimits["restricted"],
            "perClassificationCostMicros.restricted",
          ),
        },
      },
      reservedAt: instant(input["reservedAt"], "reservedAt"),
    };
  }

  private parseMarkStarted(
    input: Record<string, unknown>,
  ): ModelBudgetMarkStartedInput & { parent: ParsedParent } {
    return {
      parent: this.parseParent(input["parent"]),
      operationKey: text(input["operationKey"], "operationKey"),
      startedAt: instant(input["startedAt"], "startedAt"),
    };
  }

  private parseSettlement(
    input: Record<string, unknown>,
  ): ModelBudgetSettlementInput & { parent: AccountParent } {
    return {
      parent: this.parseAccountParent(input["parent"]),
      operationKey: text(input["operationKey"], "operationKey"),
      actualCostMicros: safeInteger(input["actualCostMicros"], "actualCostMicros"),
      settledAt: instant(input["settledAt"], "settledAt"),
    };
  }

  private parseUnknown(
    input: Record<string, unknown>,
  ): ModelBudgetUnknownInput & { parent: AccountParent } {
    const reasonCode = text(input["reasonCode"], "reasonCode", 32);
    if (
      !(["provider_unresolved", "transport_unresolved", "cancel_unresolved"] as const).includes(
        reasonCode as never,
      )
    ) {
      throw new TypeError("reasonCode is invalid");
    }
    return {
      parent: this.parseAccountParent(input["parent"]),
      operationKey: text(input["operationKey"], "operationKey"),
      observedAt: instant(input["observedAt"], "observedAt"),
      reasonCode: reasonCode as ModelBudgetUnknownInput["reasonCode"],
    };
  }

  private parseReleaseReserved(
    input: Record<string, unknown>,
  ): ModelBudgetReleaseReservedInput & { parent: AccountParent } {
    return {
      parent: this.parseAccountParent(input["parent"]),
      operationKey: text(input["operationKey"], "operationKey"),
      releasedAt: instant(input["releasedAt"], "releasedAt"),
    };
  }

  private parseFinalize(input: Record<string, unknown>): ModelBudgetFinalizeInput {
    const parent = this.parseAccountParent(input["parent"]);
    if (parent.kind !== "run") throw new TypeError("Budget finalization requires a Run parent");
    return {
      parent,
      finalizedAt: instant(input["finalizedAt"], "finalizedAt"),
    };
  }

  private parseLegacyLimits(input: BackgroundAdmissionLimits): ModelBudgetLimits {
    return {
      accountCostMicros: safeInteger(input.perRunCostMicros, "perRunCostMicros"),
      globalCostMicros: safeInteger(input.globalCostMicros, "globalCostMicros"),
      perClassificationCostMicros: {
        public: safeInteger(input.perClassificationCostMicros.public, "public budget"),
        private: safeInteger(input.perClassificationCostMicros.private, "private budget"),
        sensitive: safeInteger(input.perClassificationCostMicros.sensitive, "sensitive budget"),
        restricted: safeInteger(input.perClassificationCostMicros.restricted, "restricted budget"),
      },
    };
  }

  private assertParent(
    scope: Scope,
    parent: ParsedParent,
    at: string,
    requireActive: boolean,
  ): void {
    if (parent.kind === "run") {
      if (
        parent.executionLease.authorityLeaseId !== scope.authorityLease.leaseId ||
        parent.executionLease.authorityFencingToken !== scope.authority.fencingToken ||
        parent.executionLease.deploymentId !== scope.authority.deploymentId ||
        parent.executionLease.authorityEpoch !== scope.authority.authorityEpoch ||
        parent.executionLease.fencingToken !== scope.authority.fencingToken
      ) {
        this.fail("PORT_NOT_AUTHORITATIVE", "Run execution claim is outside the current authority");
      }
      const run = this.database
        .prepare("SELECT status FROM runs WHERE id = ? AND owner_id = ? AND agent_id = ?")
        .get(parent.runId, scope.ownerId, scope.agentId) as { readonly status: string } | undefined;
      if (!run) this.fail("PORT_NOT_AUTHORITATIVE", "Run is outside the budget scope");
      if (requireActive) {
        const guard = new SqliteRunDispatchOperations(
          this.database,
          {
            ownerId: scope.ownerId,
            agentId: scope.agentId,
            authority: scope.authority,
            authorityLease: scope.authorityLease,
            consumerId: parent.executionLease.consumerId,
          },
          this.fail,
        );
        guard.assertHeldInTransaction({
          runId: parent.runId,
          expectedLeaseRevision: parent.executionLease.expectedLeaseRevision,
          executionLeaseId: parent.executionLease.executionLeaseId,
          at,
        });
        if (!["accepted", "building_context", "running"].includes(run.status)) {
          this.fail("PORT_CONFLICT", "Run is not execution-eligible for a new model allocation");
        }
      }
      return;
    }
    if (parent.kind === "memory-projection") {
      const job = this.projectionJob(scope, parent.jobId);
      if (
        requireActive &&
        (job.status !== "claimed" ||
          job.claimedBy !== parent.claimedBy ||
          job.attemptCount !== parent.attemptCount ||
          !job.claimExpiresAt ||
          !isAfter(job.claimExpiresAt, at) ||
          job.memoryStatus !== "active" ||
          job.memoryRevision !== job.currentRevision)
      )
        this.fail("PORT_CONFLICT", "Memory projection execution lease is not held");
      return;
    }
    const occurrence = this.database
      .prepare(
        `SELECT revision, status, work_lease_id AS workLeaseId,
          work_lease_holder_id AS workLeaseHolderId, work_lease_expires_at AS workLeaseExpiresAt
         FROM job_occurrences WHERE id = ? AND owner_id = ? AND agent_id = ?`,
      )
      .get(parent.occurrenceId, scope.ownerId, scope.agentId) as
      | {
          readonly revision: number;
          readonly status: string;
          readonly workLeaseId: string | null;
          readonly workLeaseHolderId: string | null;
          readonly workLeaseExpiresAt: string | null;
        }
      | undefined;
    if (!occurrence) this.fail("PORT_NOT_AUTHORITATIVE", "Occurrence is outside the budget scope");
    if (requireActive) {
      if (
        occurrence.revision !== parent.expectedRevision ||
        occurrence.status !== "running" ||
        occurrence.workLeaseId !== parent.workLeaseId ||
        occurrence.workLeaseHolderId !== parent.workLeaseHolderId ||
        occurrence.workLeaseExpiresAt === null ||
        !isAfter(occurrence.workLeaseExpiresAt, at)
      ) {
        this.fail("PORT_CONFLICT", "Occurrence execution lease is not held");
      }
    }
  }

  private projectionJob(scope: Scope, jobId: string) {
    const row = this.database
      .prepare(`SELECT j.status, j.claimed_by AS claimedBy,
      j.attempt_count AS attemptCount, j.claim_expires_at AS claimExpiresAt,
      j.memory_revision AS memoryRevision, m.revision AS currentRevision,
      m.status AS memoryStatus, m.classification AS dataClassification
      FROM memory_projection_jobs j JOIN memory_records m ON m.id = j.memory_id
      WHERE j.id = ? AND m.owner_id = ? AND m.agent_id = ?`)
      .get(jobId, scope.ownerId, scope.agentId) as
      | {
          status: string;
          claimedBy: string | null;
          attemptCount: number;
          claimExpiresAt: string | null;
          memoryRevision: number;
          currentRevision: number;
          memoryStatus: string;
          dataClassification: ModelClassification;
        }
      | undefined;
    if (!row)
      return this.fail("PORT_NOT_AUTHORITATIVE", "Memory projection is outside the budget scope");
    return row;
  }

  private assertAccountParentScope(scope: Scope, parent: AccountParent): void {
    if (parent.kind === "memory-projection") {
      this.projectionJob(scope, parent.jobId);
      return;
    }
    if (parent.kind === "run") {
      const row = this.database
        .prepare("SELECT 1 FROM runs WHERE id = ? AND owner_id = ? AND agent_id = ?")
        .get(parent.runId, scope.ownerId, scope.agentId);
      if (!row) this.fail("PORT_NOT_AUTHORITATIVE", "Run is outside the budget scope");
      return;
    }
    const row = this.database
      .prepare("SELECT 1 FROM job_occurrences WHERE id = ? AND owner_id = ? AND agent_id = ?")
      .get(parent.occurrenceId, scope.ownerId, scope.agentId);
    if (!row) this.fail("PORT_NOT_AUTHORITATIVE", "Occurrence is outside the budget scope");
  }

  private assertCurrentAuthority(scope: Scope, at: string): void {
    const row = this.database
      .prepare(
        `SELECT l.deployment_id AS deploymentId, l.authority_epoch AS authorityEpoch,
          l.fencing_token AS fencingToken, l.expires_at AS expiresAt, l.released_at AS releasedAt,
          d.status, d.authority_epoch AS deploymentEpoch, d.fencing_token AS deploymentToken
         FROM authority_leases l
         JOIN deployments d ON d.id = l.deployment_id
           AND d.owner_id = l.owner_id AND d.agent_id = l.agent_id
         WHERE l.id = ? AND l.owner_id = ? AND l.agent_id = ?`,
      )
      .get(scope.authorityLease.leaseId, scope.ownerId, scope.agentId) as
      | {
          readonly deploymentId: string;
          readonly authorityEpoch: number;
          readonly fencingToken: number;
          readonly expiresAt: string;
          readonly releasedAt: string | null;
          readonly status: string;
          readonly deploymentEpoch: number;
          readonly deploymentToken: number;
        }
      | undefined;
    if (
      !row ||
      row.status !== "active" ||
      row.releasedAt !== null ||
      !isAfter(row.expiresAt, at) ||
      row.deploymentId !== scope.authority.deploymentId ||
      row.authorityEpoch !== scope.authority.authorityEpoch ||
      row.authorityEpoch !== row.deploymentEpoch ||
      row.fencingToken !== scope.authority.fencingToken ||
      row.fencingToken !== scope.authorityLease.fencingToken ||
      row.deploymentToken !== scope.authority.fencingToken
    ) {
      this.fail("PORT_NOT_AUTHORITATIVE", "Current product authority is stale or expired");
    }
  }

  private ensureAccount(
    ownerId: string,
    agentId: string,
    parent: AccountParent,
    dataClassification: ModelClassification,
  ): AccountRow {
    const id = accountId(parent);
    const existing = this.readAccount(ownerId, agentId, id);
    if (existing) {
      this.assertAccountParent(existing, parent);
      this.assertAccountClassification(existing, dataClassification);
      return existing;
    }
    return this.insertAccount(ownerId, agentId, parent, dataClassification);
  }

  private insertAccount(
    ownerId: string,
    agentId: string,
    parent: AccountParent,
    dataClassification: ModelClassification,
  ): AccountRow {
    const id = accountId(parent);
    this.database
      .prepare(
        `INSERT INTO model_budget_accounts (
          owner_id, agent_id, account_id, parent_kind, run_id, occurrence_id, projection_job_id,
          data_classification, reserved_cost_micros, spent_cost_micros, status, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'active', 0)`,
      )
      .run(
        ownerId,
        agentId,
        id,
        parent.kind,
        parent.kind === "run" ? parent.runId : null,
        parent.kind === "occurrence" ? parent.occurrenceId : null,
        parent.kind === "memory-projection" ? parent.jobId : null,
        dataClassification,
      );
    const account = this.readAccount(ownerId, agentId, id);
    if (!account) return this.fail("PORT_INVALID_OPERATION", "Budget account could not be read");
    return account;
  }

  private updateAccount(
    account: AccountRow,
    reservedCostMicros: number,
    spentCostMicros: number,
    status: AccountRow["status"],
  ): AccountRow {
    addCost(reservedCostMicros, spentCostMicros, "Budget account total", this.fail);
    const revision = addCost(account.revision, 1, "Budget account revision", this.fail);
    this.database
      .prepare(
        `UPDATE model_budget_accounts
         SET reserved_cost_micros = ?, spent_cost_micros = ?, status = ?, revision = ?
         WHERE owner_id = ? AND agent_id = ? AND account_id = ? AND revision = ?`,
      )
      .run(
        reservedCostMicros,
        spentCostMicros,
        status,
        revision,
        account.ownerId,
        account.agentId,
        account.accountId,
        account.revision,
      );
    const updated = this.readAccount(account.ownerId, account.agentId, account.accountId);
    if (!updated)
      return this.fail("PORT_INVALID_OPERATION", "Budget account update could not be read");
    return updated;
  }

  private readAccount(
    ownerId: string,
    agentId: string,
    accountIdValue: string,
  ): AccountRow | undefined {
    const value = this.database
      .prepare(
        `SELECT owner_id AS ownerId, agent_id AS agentId, account_id AS accountId,
          parent_kind AS parentKind, run_id AS runId, occurrence_id AS occurrenceId, projection_job_id AS projectionJobId,
          data_classification AS dataClassification,
          reserved_cost_micros AS reservedCostMicros,
          spent_cost_micros AS spentCostMicros, status, revision
         FROM model_budget_accounts WHERE owner_id = ? AND agent_id = ? AND account_id = ?`,
      )
      .get(ownerId, agentId, accountIdValue);
    if (value === undefined) return undefined;
    const row = record(value, "budget account row");
    const parentKind = text(row["parentKind"], "parentKind", 32);
    if (parentKind !== "run" && parentKind !== "occurrence" && parentKind !== "memory-projection") {
      return this.fail("PORT_INVALID_OPERATION", "Budget account parent kind is invalid");
    }
    const status = text(row["status"], "status", 32);
    if (status !== "active" && status !== "reconcile_required" && status !== "over_budget") {
      return this.fail("PORT_INVALID_OPERATION", "Budget account status is invalid");
    }
    return {
      ownerId: text(row["ownerId"], "ownerId", 128),
      agentId: text(row["agentId"], "agentId", 128),
      accountId: text(row["accountId"], "accountId"),
      parentKind,
      runId: optionalText(row["runId"], "runId"),
      occurrenceId: optionalText(row["occurrenceId"], "occurrenceId"),
      projectionJobId: optionalText(row["projectionJobId"], "projectionJobId"),
      dataClassification: classification(row["dataClassification"], "dataClassification"),
      reservedCostMicros: safeInteger(row["reservedCostMicros"], "reservedCostMicros"),
      spentCostMicros: safeInteger(row["spentCostMicros"], "spentCostMicros"),
      status,
      revision: safeInteger(row["revision"], "revision"),
    };
  }

  private readAllocation(
    ownerId: string,
    agentId: string,
    accountIdValue: string,
    operationKey: string,
  ): AllocationRow | undefined {
    const value = this.database
      .prepare(
        `SELECT owner_id AS ownerId, agent_id AS agentId, account_id AS accountId,
          operation_key AS operationKey, model_ref AS modelRef,
          data_classification AS dataClassification,
          estimated_cost_micros AS estimatedCostMicros,
          actual_cost_micros AS actualCostMicros, status, reserved_at AS reservedAt,
          started_at AS startedAt, observed_at AS observedAt, settled_at AS settledAt,
          reason_code AS reasonCode
         FROM model_budget_allocations
         WHERE owner_id = ? AND agent_id = ? AND account_id = ? AND operation_key = ?`,
      )
      .get(ownerId, agentId, accountIdValue, operationKey);
    return value === undefined ? undefined : this.parseAllocation(value);
  }

  private parseAllocation(value: unknown): AllocationRow {
    const row = record(value, "budget allocation row");
    const status = text(row["status"], "status", 16);
    if (
      status !== "reserved" &&
      status !== "started" &&
      status !== "unknown" &&
      status !== "settled" &&
      status !== "released"
    ) {
      return this.fail("PORT_INVALID_OPERATION", "Budget allocation status is invalid");
    }
    const reason = optionalText(row["reasonCode"], "reasonCode");
    if (
      reason !== null &&
      reason !== "provider_unresolved" &&
      reason !== "transport_unresolved" &&
      reason !== "cancel_unresolved"
    ) {
      return this.fail("PORT_INVALID_OPERATION", "Budget allocation reason is invalid");
    }
    return {
      ownerId: text(row["ownerId"], "ownerId", 128),
      agentId: text(row["agentId"], "agentId", 128),
      accountId: text(row["accountId"], "accountId"),
      operationKey: text(row["operationKey"], "operationKey"),
      modelRef: text(row["modelRef"], "modelRef", 256),
      dataClassification: classification(row["dataClassification"], "dataClassification"),
      estimatedCostMicros: safeInteger(row["estimatedCostMicros"], "estimatedCostMicros"),
      actualCostMicros:
        row["actualCostMicros"] === null
          ? null
          : safeInteger(row["actualCostMicros"], "actualCostMicros"),
      status,
      reservedAt: instant(row["reservedAt"], "reservedAt"),
      startedAt: row["startedAt"] === null ? null : instant(row["startedAt"], "startedAt"),
      observedAt: row["observedAt"] === null ? null : instant(row["observedAt"], "observedAt"),
      settledAt: row["settledAt"] === null ? null : instant(row["settledAt"], "settledAt"),
      reasonCode: reason as AllocationRow["reasonCode"],
    };
  }

  private readUsage(
    ownerId: string,
    agentId: string,
  ): {
    readonly global: number;
    readonly byClassification: Record<ModelClassification, number>;
  } {
    const result: Record<ModelClassification, number> = {
      public: 0,
      private: 0,
      sensitive: 0,
      restricted: 0,
    };
    let global = 0;
    const rows = this.database
      .prepare(
        `SELECT data_classification AS dataClassification,
          reserved_cost_micros AS reservedCostMicros,
          spent_cost_micros AS spentCostMicros
         FROM model_budget_accounts WHERE owner_id = ? AND agent_id = ?`,
      )
      .all(ownerId, agentId);
    for (const value of rows) {
      const row = record(value, "budget usage row");
      const kind = classification(row["dataClassification"], "dataClassification");
      const total = addCost(
        safeInteger(row["reservedCostMicros"], "reservedCostMicros"),
        safeInteger(row["spentCostMicros"], "spentCostMicros"),
        "Budget usage",
        this.fail,
      );
      global = addCost(global, total, "Global budget usage", this.fail);
      result[kind] = addCost(result[kind], total, "Classification budget usage", this.fail);
    }
    return { global, byClassification: result };
  }

  private childAllocationState(
    accountIdValue: string,
    ownerId: string,
    agentId: string,
  ): {
    readonly open: boolean;
    readonly unknown: boolean;
    readonly settled: boolean;
  } {
    const rows = this.database
      .prepare(
        `SELECT status FROM model_budget_allocations
         WHERE owner_id = ? AND agent_id = ? AND account_id = ?`,
      )
      .all(ownerId, agentId, accountIdValue) as Array<{ readonly status: string }>;
    return {
      open: rows.some(({ status }) => status === "reserved" || status === "started"),
      unknown: rows.some(({ status }) => status === "unknown"),
      settled: rows.some(({ status }) => status === "settled"),
    };
  }

  private remainingUnknown(
    accountIdValue: string,
    scope: Scope,
    excludedOperationKey?: string,
  ): boolean {
    const row = this.database
      .prepare(
        `SELECT 1 FROM model_budget_allocations
         WHERE owner_id = ? AND agent_id = ? AND account_id = ? AND status = 'unknown'
           AND (? IS NULL OR operation_key <> ?) LIMIT 1`,
      )
      .get(
        scope.ownerId,
        scope.agentId,
        accountIdValue,
        excludedOperationKey ?? null,
        excludedOperationKey ?? null,
      );
    return row !== undefined;
  }

  private outstandingChildReservation(
    ownerId: string,
    agentId: string,
    accountIdValue: string,
  ): number {
    let total = 0;
    const rows = this.database
      .prepare(
        `SELECT estimated_cost_micros AS estimatedCostMicros
         FROM model_budget_allocations
         WHERE owner_id = ? AND agent_id = ? AND account_id = ?
           AND status IN ('reserved', 'started', 'unknown')`,
      )
      .all(ownerId, agentId, accountIdValue);
    for (const value of rows) {
      const row = record(value, "budget allocation reservation row");
      total = addCost(
        total,
        safeInteger(row["estimatedCostMicros"], "estimatedCostMicros"),
        "Open budget reservation",
        this.fail,
      );
    }
    return total;
  }

  private runClassification(
    scope: Scope,
    runId: ReturnType<typeof createRunId>,
  ): ModelClassification {
    const row = this.database
      .prepare(
        `SELECT p.classification AS classification
         FROM runs r
         JOIN triggers t ON t.id = r.trigger_id
           AND t.owner_id = r.owner_id AND t.agent_id = r.agent_id
         JOIN payloads p ON p.ref = t.payload_ref
           AND p.owner_id = t.owner_id AND p.agent_id = t.agent_id
         WHERE r.id = ? AND r.owner_id = ? AND r.agent_id = ?`,
      )
      .get(runId, scope.ownerId, scope.agentId) as { readonly classification: string } | undefined;
    if (!row)
      return this.fail(
        "PORT_NOT_AUTHORITATIVE",
        "Run trigger payload classification is unavailable",
      );
    return classification(row.classification, "run trigger classification");
  }

  private assertRunClassification(
    scope: Scope,
    runId: ReturnType<typeof createRunId>,
    requested: ModelClassification,
  ): void {
    const minimum = this.runClassification(scope, runId);
    if (classificationRank(requested) < classificationRank(minimum)) {
      this.fail(
        "PORT_NOT_AUTHORITATIVE",
        "Model allocation classification is below Run input classification",
      );
    }
  }

  private assertAccountParent(account: AccountRow, parent: AccountParent): void {
    if (
      (parent.kind === "memory-projection" &&
        (account.parentKind !== parent.kind ||
          account.projectionJobId !== parent.jobId ||
          account.runId !== null ||
          account.occurrenceId !== null)) ||
      (parent.kind === "run" &&
        (account.parentKind !== "run" ||
          account.runId !== parent.runId ||
          account.occurrenceId !== null)) ||
      (parent.kind === "occurrence" &&
        (account.parentKind !== "occurrence" ||
          account.occurrenceId !== parent.occurrenceId ||
          account.runId !== null))
    ) {
      this.fail("PORT_CONFLICT", "Budget account parent identity is inconsistent");
    }
  }

  private assertAccountClassification(
    account: AccountRow,
    dataClassification: ModelClassification,
  ): void {
    if (account.dataClassification !== dataClassification) {
      this.fail("PORT_CONFLICT", "Budget account classification is immutable");
    }
  }

  private result(
    account: AccountRow,
    allocation: AllocationRow,
    replayed: boolean,
  ): ModelBudgetOperationResult {
    return {
      account: this.toAccount(account),
      allocation: this.toAllocation(allocation),
      replayed,
    };
  }

  private toAccount(row: AccountRow): ModelBudgetAccount {
    return {
      ownerId: createOwnerId(row.ownerId),
      agentId: createAgentId(row.agentId),
      accountId: row.accountId,
      parent:
        row.parentKind === "memory-projection"
          ? {
              kind: "memory-projection",
              jobId: row.projectionJobId ?? this.invalidRow("projection_job_id"),
            }
          : row.parentKind === "run"
            ? { kind: "run", runId: createRunId(row.runId ?? this.invalidRow("run_id")) }
            : {
                kind: "occurrence",
                occurrenceId: createOccurrenceId(
                  row.occurrenceId ?? this.invalidRow("occurrence_id"),
                ),
              },
      dataClassification: row.dataClassification,
      reservedCostMicros: row.reservedCostMicros,
      spentCostMicros: row.spentCostMicros,
      status: row.status,
      revision: row.revision,
    };
  }

  private toAllocation(row: AllocationRow): ModelBudgetAllocation {
    return {
      ownerId: createOwnerId(row.ownerId),
      agentId: createAgentId(row.agentId),
      accountId: row.accountId,
      operationKey: row.operationKey,
      modelRef: row.modelRef,
      dataClassification: row.dataClassification,
      estimatedCostMicros: row.estimatedCostMicros,
      actualCostMicros: row.actualCostMicros,
      status: row.status,
      reservedAt: row.reservedAt,
      startedAt: row.startedAt,
      observedAt: row.observedAt,
      settledAt: row.settledAt,
      reasonCode: row.reasonCode,
    };
  }

  private requireTransaction(operation: string): void {
    if (!this.database.inTransaction) {
      this.fail("PORT_INVALID_OPERATION", `${operation} requires an active SQLite transaction`);
    }
  }

  private invalidRow(field: string): never {
    throw new TypeError(`Budget row is missing ${field}`);
  }
}

function accountId(parent: ParsedParent | AccountParent): string {
  return parent.kind === "memory-projection"
    ? `memory-projection:${parent.jobId}`
    : parent.kind === "run"
      ? `run:${parent.runId}`
      : `occurrence:${parent.occurrenceId}`;
}

function isAfter(value: string, boundary: string): boolean {
  const parsedValue = Date.parse(value);
  const parsedBoundary = Date.parse(boundary);
  return (
    Number.isFinite(parsedValue) && Number.isFinite(parsedBoundary) && parsedValue > parsedBoundary
  );
}
