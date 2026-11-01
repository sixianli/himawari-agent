import { randomUUID } from "node:crypto";
import type {
  ApplicationServiceIdentityFactory,
  ClockPort,
  CoordinatedRunResult,
  ExecuteCoordinatedRunInput,
  ExecutionInterruptionResult,
  RunCoordinator,
  RunDispatchCandidate,
  RunDispatchPort,
  RunExecutionLease,
  RunExecutionLeaseId,
  RunReconciliationCandidate,
} from "@himawari-agent/application";
import {
  ApplicationPortError,
  claimFromRunExecutionLease,
  createApplicationServiceIdentityFactory,
  PORT_ERROR_CODES,
  RunExecutionInterruptedError,
} from "@himawari-agent/application";
import type { PreparedToolResultRecovery } from "./production-tool-result-recovery.js";
import type { ProductionAuthorityLifecycle } from "./production-authority-lifecycle.js";
import { isGlobalServiceFailure } from "./production-record-failure.js";

export const PRODUCTION_RUN_DISPATCH_ERROR_CODES = Object.freeze({
  CONFIGURATION_INVALID: "PRODUCTION_RUN_DISPATCH_CONFIGURATION_INVALID",
  INPUT_SCOPE_MISMATCH: "PRODUCTION_RUN_DISPATCH_INPUT_SCOPE_MISMATCH",
  NON_TERMINAL_RESULT: "PRODUCTION_RUN_DISPATCH_NON_TERMINAL_RESULT",
  UNKNOWN_RESULT: "PRODUCTION_RUN_DISPATCH_UNKNOWN_RESULT",
} as const);

export type ProductionRunDispatchErrorCode =
  (typeof PRODUCTION_RUN_DISPATCH_ERROR_CODES)[keyof typeof PRODUCTION_RUN_DISPATCH_ERROR_CODES];

export class ProductionRunDispatchError extends Error {
  readonly code: ProductionRunDispatchErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(
    code: ProductionRunDispatchErrorCode,
    message: string,
    details: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "ProductionRunDispatchError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export class ProductionRunUnknownResultError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string) {
    super(reasonCode);
    this.name = "ProductionRunUnknownResultError";
    this.reasonCode = reasonCode;
  }
}

export interface ProductionRunDispatchInput {
  readonly candidate: RunDispatchCandidate;
  readonly lease: RunExecutionLease;
}

export interface ProductionRunReconciliationInput {
  readonly candidate: RunReconciliationCandidate;
  readonly reasonCode: string;
  readonly executionInterruption?: ExecutionInterruptionResult;
  readonly executionLease?: RunExecutionLease;
}

export type ProductionRunExecutionResult =
  | { readonly kind: "settled"; readonly result: CoordinatedRunResult }
  | { readonly kind: "unknown"; readonly reasonCode: string };

export type ProductionRunInputFactory = (
  input: ProductionRunDispatchInput,
) => Promise<ExecuteCoordinatedRunInput>;

export type ProductionRunReconciler = (input: ProductionRunReconciliationInput) => Promise<void>;

export interface ProductionRunDispatcherOptions {
  readonly authority: Pick<ProductionAuthorityLifecycle, "assertActive" | "isAccepting">;
  readonly dispatch: RunDispatchPort;
  readonly coordinator: Pick<
    RunCoordinator,
    "execute" | "recoverCompleted" | "interruptExecution"
  > &
    Partial<Pick<RunCoordinator, "resumeToolResult">>;
  readonly prepareToolResultRecovery?: (
    candidate: RunDispatchCandidate,
  ) => Promise<PreparedToolResultRecovery | undefined>;
  readonly input: ProductionRunInputFactory;
  readonly reconcile: ProductionRunReconciler;
  readonly clock: ClockPort;
  readonly executionLeaseDurationMs: number;
  readonly executionLeaseRenewalIntervalMs?: number;
  readonly maximumRunsPerPump: number;
  readonly onCapacityFreed?: () => void;
  readonly instanceId?: string;
  readonly identity?: ApplicationServiceIdentityFactory;
  readonly nextExecutionLeaseId?: (input: {
    readonly candidate: RunDispatchCandidate;
    readonly expectedLeaseRevision: number;
  }) => RunExecutionLeaseId;
  readonly background?: {
    adopt(lease: RunExecutionLease): void;
    recover(): Promise<number>;
  };
}

export interface ProductionRunDispatchPumpResult {
  readonly checkedAt: string;
  readonly reconciled: number;
  readonly claimed: number;
  readonly settled: number;
  readonly unknown: number;
  readonly conflicts: number;
}

interface ExecutionOutcome {
  readonly settled: number;
  readonly unknown: number;
  readonly conflicts: number;
}

interface ClaimedBatch {
  readonly checkedAt: string;
  readonly reconciled: number;
  readonly claimed: number;
  readonly conflicts: number;
  readonly launched: readonly Promise<ExecutionOutcome>[];
}

export interface ProductionRunDispatchDrainResult {
  readonly drained: boolean;
  readonly inFlight: number;
}

type BoundProductionRunDispatcherOptions = Omit<ProductionRunDispatcherOptions, "identity"> & {
  readonly identity: ApplicationServiceIdentityFactory;
};

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ProductionRunDispatchError(
      PRODUCTION_RUN_DISPATCH_ERROR_CODES.CONFIGURATION_INVALID,
      `${field} must be a positive safe integer`,
      { field, value: String(value) },
    );
  }
  return value;
}

function expiresAt(now: string, durationMs: number): string {
  const timestamp = Date.parse(now);
  if (!Number.isFinite(timestamp)) {
    throw new ProductionRunDispatchError(
      PRODUCTION_RUN_DISPATCH_ERROR_CODES.CONFIGURATION_INVALID,
      "Dispatch clock must return an ISO timestamp",
      { now },
    );
  }
  return new Date(timestamp + durationMs).toISOString();
}

function isPortError(error: unknown, code: string): boolean {
  return error instanceof ApplicationPortError && error.code === code;
}

function terminal(status: CoordinatedRunResult["run"]["run"]["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function sameLeaseIdentity(left: RunExecutionLease, right: RunExecutionLease): boolean {
  return (
    left.ownerId === right.ownerId &&
    left.agentId === right.agentId &&
    left.runId === right.runId &&
    left.authorityLeaseId === right.authorityLeaseId &&
    left.deploymentId === right.deploymentId &&
    left.authorityEpoch === right.authorityEpoch &&
    left.fencingToken === right.fencingToken &&
    left.consumerId === right.consumerId &&
    left.executionLeaseId === right.executionLeaseId &&
    left.revision === right.revision
  );
}

function defaultExecutionLeaseId(
  identity: ApplicationServiceIdentityFactory,
  instanceId: string,
  candidate: RunDispatchCandidate,
  expectedLeaseRevision: number,
): RunExecutionLeaseId {
  return identity.createExecutionLeaseId({
    instanceId,
    runId: candidate.runId,
    expectedLeaseRevision,
  });
}

export class ProductionRunDispatcher {
  readonly #options: BoundProductionRunDispatcherOptions;
  #accepting = true;
  #inFlight = new Set<Promise<unknown>>();
  #pumpInFlight: Promise<ProductionRunDispatchPumpResult> | undefined;
  #fillInFlight: Promise<ProductionRunDispatchPumpResult> | undefined;
  #executing = new Set<Promise<ExecutionOutcome>>();
  #executionFailure: unknown;
  #claimChain: Promise<void> = Promise.resolve();
  #recoverInFlight: Promise<number> | undefined;
  #reconciliationAfterRunId: RunReconciliationCandidate["runId"] | undefined;
  #reconciliationThroughRunId: RunReconciliationCandidate["runId"] | undefined;

  constructor(options: ProductionRunDispatcherOptions) {
    this.#options = Object.freeze({
      ...options,
      executionLeaseDurationMs: positiveInteger(
        options.executionLeaseDurationMs,
        "executionLeaseDurationMs",
      ),
      executionLeaseRenewalIntervalMs: positiveInteger(
        options.executionLeaseRenewalIntervalMs ??
          Math.max(1, Math.floor(options.executionLeaseDurationMs / 2)),
        "executionLeaseRenewalIntervalMs",
      ),
      maximumRunsPerPump: positiveInteger(options.maximumRunsPerPump, "maximumRunsPerPump"),
      instanceId: options.instanceId ?? `agent-service:${randomUUID()}`,
      identity: options.identity ?? createApplicationServiceIdentityFactory(),
    });
    if (
      this.#options.executionLeaseRenewalIntervalMs &&
      this.#options.executionLeaseRenewalIntervalMs >= this.#options.executionLeaseDurationMs
    ) {
      throw new ProductionRunDispatchError(
        PRODUCTION_RUN_DISPATCH_ERROR_CODES.CONFIGURATION_INVALID,
        "Execution lease renewal must occur before the lease expires",
        {
          executionLeaseDurationMs: String(this.#options.executionLeaseDurationMs),
          executionLeaseRenewalIntervalMs: String(this.#options.executionLeaseRenewalIntervalMs),
        },
      );
    }
  }

  stopAccepting(): void {
    this.#accepting = false;
  }

  isAccepting(): boolean {
    return this.#accepting && this.#options.authority.isAccepting();
  }

  pump(limit = this.#options.maximumRunsPerPump): Promise<ProductionRunDispatchPumpResult> {
    if (this.#pumpInFlight) return this.#pumpInFlight;
    const operation = this.pumpInternal(limit);
    this.#pumpInFlight = operation;
    this.#inFlight.add(operation);
    const clear = () => {
      if (this.#pumpInFlight === operation) this.#pumpInFlight = undefined;
      this.#inFlight.delete(operation);
    };
    void operation.then(clear, clear);
    return operation;
  }

  recover(limit = this.#options.maximumRunsPerPump): Promise<number> {
    if (this.#recoverInFlight) return this.#recoverInFlight;
    const operation = this.recoverInternal(limit);
    this.#recoverInFlight = operation;
    this.#inFlight.add(operation);
    const clear = () => {
      if (this.#recoverInFlight === operation) this.#recoverInFlight = undefined;
      this.#inFlight.delete(operation);
    };
    void operation.then(clear, clear);
    return operation;
  }

  private async recoverInternal(limit: number): Promise<number> {
    positiveInteger(limit, "limit");
    if (!this.isAccepting()) return 0;
    await this.#options.authority.assertActive();
    let reconciled = 0;
    const readPage = () =>
      this.#options.dispatch.listReconciliationRequired({
        now: this.#options.clock.now(),
        limit,
        ...(this.#reconciliationAfterRunId ? { afterRunId: this.#reconciliationAfterRunId } : {}),
        ...(this.#reconciliationThroughRunId
          ? { throughRunId: this.#reconciliationThroughRunId }
          : {}),
      });
    let reconciliation = await readPage();
    if (reconciliation.length === 0 && this.#reconciliationAfterRunId) {
      this.#reconciliationAfterRunId = undefined;
      this.#reconciliationThroughRunId = undefined;
      reconciliation = await readPage();
    }
    for (const candidate of reconciliation) {
      if (!this.isAccepting()) break;
      try {
        await this.#options.reconcile({
          candidate,
          reasonCode: "PERSISTED_EXECUTION_RECONCILIATION_REQUIRED",
        });
      } catch (error) {
        if (isGlobalServiceFailure(error)) throw error;
        await this.recordRecordFailure(candidate, "RUN_RECONCILIATION_FAILED");
      }
      if (candidate.scanUpperBoundRunId) {
        this.#reconciliationThroughRunId ??= candidate.scanUpperBoundRunId;
        this.#reconciliationAfterRunId = candidate.runId;
      }
      reconciled += 1;
    }

    return reconciled;
  }

  private async recordRecordFailure(
    candidate: RunReconciliationCandidate,
    reasonCode: string,
  ): Promise<void> {
    await this.#options.reconcile({ candidate, reasonCode });
  }

  private async prepareRecovery(
    candidate: RunDispatchCandidate,
  ): Promise<PreparedToolResultRecovery | undefined> {
    if (!this.#options.prepareToolResultRecovery) return undefined;
    try {
      return await this.#options.prepareToolResultRecovery(candidate);
    } catch (error) {
      if (isGlobalServiceFailure(error)) throw error;
      await this.recordRecordFailure(
        { ...candidate, action: "reconcile" },
        "TOOL_RESULT_RECOVERY_FAILED",
      );
      throw error;
    }
  }

  async drain(timeoutMs: number): Promise<ProductionRunDispatchDrainResult> {
    positiveInteger(timeoutMs, "timeoutMs");
    this.#accepting = false;
    const operations = [...this.#inFlight];
    if (operations.length === 0) return { drained: true, inFlight: 0 };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
      timeout.unref?.();
    });
    const completed = Promise.allSettled(operations).then(() => true as const);
    const drained = await Promise.race([completed, deadline]);
    if (timeout) clearTimeout(timeout);
    return { drained, inFlight: this.#inFlight.size };
  }

  private async pumpInternal(limit: number): Promise<ProductionRunDispatchPumpResult> {
    const filled = await this.claimAndLaunch(limit, false);
    const outcomes = await Promise.all(filled.launched);
    let settled = 0;
    let unknown = 0;
    let conflicts = filled.conflicts;
    for (const outcome of outcomes) {
      settled += outcome.settled;
      unknown += outcome.unknown;
      conflicts += outcome.conflicts;
    }
    return Object.freeze({
      checkedAt: filled.checkedAt,
      reconciled: filled.reconciled,
      claimed: filled.claimed,
      settled,
      unknown,
      conflicts,
    });
  }

  fill(limit = this.#options.maximumRunsPerPump): Promise<ProductionRunDispatchPumpResult> {
    if (this.#fillInFlight) return this.#fillInFlight;
    const operation = this.fillInternal(limit);
    this.#fillInFlight = operation;
    this.#inFlight.add(operation);
    const clear = () => {
      if (this.#fillInFlight === operation) this.#fillInFlight = undefined;
      this.#inFlight.delete(operation);
    };
    void operation.then(clear, clear);
    return operation;
  }

  private async fillInternal(limit: number): Promise<ProductionRunDispatchPumpResult> {
    if (this.#executionFailure !== undefined) {
      const failure = this.#executionFailure;
      this.#executionFailure = undefined;
      throw failure;
    }
    const filled = await this.claimAndLaunch(limit, true);
    return Object.freeze({
      checkedAt: filled.checkedAt,
      reconciled: filled.reconciled,
      claimed: filled.claimed,
      settled: 0,
      unknown: 0,
      conflicts: filled.conflicts,
    });
  }

  private claimAndLaunch(limit: number, detached: boolean): Promise<ClaimedBatch> {
    const batch = this.#claimChain.then(() => this.claimAndLaunchInternal(limit, detached));
    this.#claimChain = batch.then(
      () => undefined,
      () => undefined,
    );
    return batch;
  }

  private launchExecution(
    candidate: RunDispatchCandidate,
    recovery: PreparedToolResultRecovery | undefined,
    lease: RunExecutionLease,
    detached: boolean,
  ): Promise<ExecutionOutcome> {
    const task = this.executeClaimed(candidate, recovery, lease);
    this.#executing.add(task);
    this.#inFlight.add(task);
    const finish = () => {
      this.#executing.delete(task);
      this.#inFlight.delete(task);
      this.#options.onCapacityFreed?.();
    };
    if (detached) {
      task.then(finish, (error: unknown) => {
        this.#executionFailure ??= error;
        finish();
      });
    } else {
      task.then(finish, finish);
    }
    return task;
  }

  private async claimAndLaunchInternal(limit: number, detached: boolean): Promise<ClaimedBatch> {
    const checkedAt = this.#options.clock.now();
    positiveInteger(limit, "limit");
    const empty = (reconciled: number): ClaimedBatch => ({
      checkedAt,
      reconciled,
      claimed: 0,
      conflicts: 0,
      launched: [],
    });
    if (!this.isAccepting()) return empty(0);
    await this.#options.authority.assertActive();

    const reconciled = await this.recover(limit);
    await this.#options.background?.recover();

    if (!this.isAccepting()) return empty(reconciled);
    const freeSlots = limit - this.#executing.size;
    if (freeSlots <= 0) return empty(reconciled);
    const candidates = await this.#options.dispatch.listClaimable({
      now: this.#options.clock.now(),
      limit: freeSlots,
    });
    let claimed = 0;
    let conflicts = 0;
    const launched: Promise<ExecutionOutcome>[] = [];
    for (const candidate of candidates) {
      if (!this.isAccepting()) break;
      let recovery: PreparedToolResultRecovery | undefined;
      if (candidate.action === "resume_tool_result") {
        try {
          recovery = await this.prepareRecovery(candidate);
        } catch (error) {
          if (isGlobalServiceFailure(error)) throw error;
          continue;
        }
      }
      if (
        candidate.action === "resume_tool_result" &&
        (!recovery || !this.#options.coordinator.resumeToolResult)
      )
        continue;
      const leaseId =
        this.#options.nextExecutionLeaseId?.({
          candidate,
          expectedLeaseRevision: candidate.leaseRevision,
        }) ??
        defaultExecutionLeaseId(
          this.#options.identity,
          this.#options.instanceId ?? "agent-service",
          candidate,
          candidate.leaseRevision,
        );
      let lease: RunExecutionLease;
      try {
        const claimedAt = this.#options.clock.now();
        lease = await this.#options.dispatch.claim({
          ...(recovery ? { toolResultRecovery: recovery.claim } : {}),
          runId: candidate.runId,
          expectedRunRevision: candidate.runRevision,
          expectedLeaseRevision: candidate.leaseRevision,
          executionLeaseId: leaseId,
          claimedAt,
          expiresAt: expiresAt(claimedAt, this.#options.executionLeaseDurationMs),
        });
      } catch (error) {
        if (isPortError(error, PORT_ERROR_CODES.CONFLICT)) {
          conflicts += 1;
          continue;
        }
        throw error;
      }
      claimed += 1;
      launched.push(this.launchExecution(candidate, recovery, lease, detached));
    }
    return { checkedAt, reconciled, claimed, conflicts, launched };
  }

  private async executeClaimed(
    candidate: RunDispatchCandidate,
    recovery: PreparedToolResultRecovery | undefined,
    lease: RunExecutionLease,
  ): Promise<ExecutionOutcome> {
    const outcome = { settled: 0, unknown: 0, conflicts: 0 };
    const claim = claimFromRunExecutionLease(lease);
    const renewal = this.startLeaseRenewal(lease, () =>
      this.#options.coordinator.interruptExecution({
        runId: lease.runId,
        executionLeaseId: lease.executionLeaseId,
        reasonCode: "EXECUTION_LEASE_RENEWAL_FAILED",
      }),
    );
    let reconciliationAttempted = false;
    const reconcileLeaseFailure = async (reasonCode = "EXECUTION_LEASE_RENEWAL_FAILED") => {
      await renewal.stop();
      reconciliationAttempted = true;
      await this.reconcileUnknown(
        candidate,
        reasonCode,
        renewal.interruptionResult(),
        renewal.currentLease(),
      );
      await this.releaseBestEffort(renewal.currentLease());
      outcome.unknown += 1;
    };
    try {
      const input = await this.#options.input({ candidate, lease });
      if (!this.isAccepting()) {
        await reconcileLeaseFailure("SERVICE_STOPPING");
        return outcome;
      }
      if (renewal.failure()) {
        await reconcileLeaseFailure();
        return outcome;
      }
      const canonicalInput = this.bindInput(
        recovery
          ? {
              ...input,
              runtime: {
                ...input.runtime,
                continuationRef: recovery.binding.continuationRef,
                knownToolResult: recovery.binding,
              },
            }
          : input,
        candidate,
        claim,
      );
      if (renewal.failure()) {
        await reconcileLeaseFailure();
        return outcome;
      }
      let result: CoordinatedRunResult;
      try {
        result =
          recovery && this.#options.coordinator.resumeToolResult
            ? await this.#options.coordinator.resumeToolResult(canonicalInput)
            : candidate.action === "deliver_completed"
              ? await this.#options.coordinator.recoverCompleted(canonicalInput)
              : await this.#options.coordinator.execute(canonicalInput);
      } catch (error) {
        await renewal.stop();
        if (renewal.failure()) {
          await reconcileLeaseFailure();
          return outcome;
        }
        if (error instanceof RunExecutionInterruptedError) {
          await reconcileLeaseFailure(error.reasonCode);
          return outcome;
        }
        if (error instanceof ProductionRunUnknownResultError) {
          reconciliationAttempted = true;
          await this.reconcileUnknown(
            candidate,
            error.reasonCode,
            undefined,
            renewal.currentLease(),
          );
          await this.releaseBestEffort(renewal.currentLease());
          outcome.unknown += 1;
          return outcome;
        }
        throw error;
      }
      await renewal.stop();
      if (renewal.failure()) {
        await reconcileLeaseFailure();
        return outcome;
      }
      if (result.parked && this.#options.background) {
        this.#options.background.adopt(renewal.currentLease());
        outcome.settled += 1;
        return outcome;
      }
      if (result.run.run.status === "reconciling_external_result") {
        reconciliationAttempted = true;
        await this.reconcileUnknown(
          candidate,
          "COORDINATOR_RECONCILIATION_REQUIRED",
          undefined,
          renewal.currentLease(),
        );
        await this.releaseBestEffort(renewal.currentLease());
        outcome.unknown += 1;
        return outcome;
      }
      if (!terminal(result.run.run.status) && result.run.run.status !== "awaiting_approval") {
        throw new ProductionRunDispatchError(
          PRODUCTION_RUN_DISPATCH_ERROR_CODES.NON_TERMINAL_RESULT,
          "Run Coordinator returned before reaching a terminal or reconciliation state",
          { runId: candidate.runId, status: result.run.run.status },
        );
      }
      await this.releaseBestEffort(renewal.currentLease());
      outcome.settled += 1;
    } catch (error) {
      await renewal.stop();
      if (reconciliationAttempted) throw error;
      if (renewal.failure()) {
        await reconcileLeaseFailure();
        return outcome;
      }
      if (
        candidate.action === "deliver_completed" &&
        isPortError(error, PORT_ERROR_CODES.CONFLICT)
      ) {
        await this.releaseBestEffort(renewal.currentLease());
        outcome.conflicts += 1;
        return outcome;
      }
      await this.reconcileUnknown(
        candidate,
        candidate.action === "deliver_completed"
          ? "RUN_COMPLETION_DELIVERY_REJECTED"
          : "RUN_EXECUTION_FAILED_WITHOUT_RESULT",
        undefined,
        renewal.currentLease(),
      );
      await this.releaseBestEffort(renewal.currentLease());
      if (isGlobalServiceFailure(error)) throw error;
      outcome.unknown += 1;
    }
    return outcome;
  }

  private startLeaseRenewal(
    initial: RunExecutionLease,
    interruptExecution: () => Promise<ExecutionInterruptionResult | undefined>,
  ) {
    let current = initial;
    let failure: unknown;
    let stopped = false;
    let running: Promise<void> | undefined;
    let interruption: Promise<ExecutionInterruptionResult | undefined> | undefined;
    let interruptionResult: ExecutionInterruptionResult | undefined;
    const interval = setInterval(() => {
      if (stopped || running || failure) return;
      running = (async () => {
        await this.#options.authority.assertActive();
        const renewedAt = this.#options.clock.now();
        const renewed = await this.#options.dispatch.renew({
          runId: current.runId,
          expectedLeaseRevision: current.revision,
          executionLeaseId: current.executionLeaseId,
          renewedAt,
          expiresAt: expiresAt(renewedAt, this.#options.executionLeaseDurationMs),
        });
        if (renewed.releasedAt !== null || !sameLeaseIdentity(renewed, current)) {
          throw new ProductionRunDispatchError(
            PRODUCTION_RUN_DISPATCH_ERROR_CODES.UNKNOWN_RESULT,
            "Execution lease renewal returned a different lease identity",
            { runId: current.runId },
          );
        }
        current = renewed;
      })()
        .catch((error: unknown) => {
          failure = error;
          interruption = Promise.resolve()
            .then(interruptExecution)
            .then((result) => {
              interruptionResult = result;
              return result;
            });
        })
        .finally(() => {
          running = undefined;
        });
    }, this.#options.executionLeaseRenewalIntervalMs);
    interval.unref?.();
    return {
      currentLease: () => current,
      failure: () => failure,
      interruptionResult: () => interruptionResult,
      stop: async () => {
        stopped = true;
        clearInterval(interval);
        if (running) await running;
        if (interruption) await interruption;
      },
    };
  }

  private bindInput(
    input: ExecuteCoordinatedRunInput,
    candidate: RunDispatchCandidate,
    claim: ReturnType<typeof claimFromRunExecutionLease>,
  ): ExecuteCoordinatedRunInput {
    if (
      input.ownerId !== candidate.ownerId ||
      input.agentId !== candidate.agentId ||
      input.runId !== candidate.runId ||
      input.authority.leaseId !== claim.authorityLeaseId ||
      input.authority.fencingToken !== claim.authorityFencingToken
    ) {
      throw new ProductionRunDispatchError(
        PRODUCTION_RUN_DISPATCH_ERROR_CODES.INPUT_SCOPE_MISMATCH,
        "Run input factory returned a scope different from the claimed Run",
        { runId: candidate.runId },
      );
    }
    if (
      input.executionLease.executionLeaseId !== claim.executionLeaseId ||
      input.executionLease.expectedLeaseRevision !== claim.expectedLeaseRevision ||
      input.executionLease.authorityLeaseId !== claim.authorityLeaseId ||
      input.executionLease.authorityFencingToken !== claim.authorityFencingToken ||
      input.executionLease.deploymentId !== claim.deploymentId ||
      input.executionLease.authorityEpoch !== claim.authorityEpoch ||
      input.executionLease.fencingToken !== claim.fencingToken ||
      input.executionLease.consumerId !== claim.consumerId
    ) {
      throw new ProductionRunDispatchError(
        PRODUCTION_RUN_DISPATCH_ERROR_CODES.INPUT_SCOPE_MISMATCH,
        "Run input factory returned a different execution lease",
        { runId: candidate.runId },
      );
    }
    return Object.freeze({ ...input, executionLease: claim });
  }

  private async reconcileUnknown(
    candidate: RunDispatchCandidate,
    reasonCode: string,
    executionInterruption?: ExecutionInterruptionResult,
    executionLease?: RunExecutionLease,
  ): Promise<void> {
    await this.#options.reconcile({
      candidate: { ...candidate, action: "reconcile" },
      reasonCode,
      ...(executionInterruption ? { executionInterruption } : {}),
      ...(executionLease ? { executionLease } : {}),
    });
  }

  private async releaseBestEffort(lease: RunExecutionLease): Promise<void> {
    try {
      await this.#options.dispatch.release({
        runId: lease.runId,
        expectedLeaseRevision: lease.revision,
        executionLeaseId: lease.executionLeaseId,
        releasedAt: this.#options.clock.now(),
      });
    } catch (error) {
      if (
        !isPortError(error, PORT_ERROR_CODES.CONFLICT) &&
        !isPortError(error, PORT_ERROR_CODES.NOT_AUTHORITATIVE)
      )
        throw error;
    }
  }
}

export function createProductionRunDispatcher(
  options: ProductionRunDispatcherOptions,
): ProductionRunDispatcher {
  return new ProductionRunDispatcher(options);
}
