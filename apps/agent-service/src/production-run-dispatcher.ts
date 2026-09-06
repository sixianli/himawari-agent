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
import type { ProductionAuthorityLifecycle } from "./production-authority-lifecycle.js";

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
  readonly coordinator: Pick<RunCoordinator, "execute" | "interruptExecution">;
  readonly input: ProductionRunInputFactory;
  readonly reconcile: ProductionRunReconciler;
  readonly clock: ClockPort;
  readonly executionLeaseDurationMs: number;
  /** Defaults to half of executionLeaseDurationMs. */
  readonly executionLeaseRenewalIntervalMs?: number;
  readonly maximumRunsPerPump: number;
  readonly instanceId?: string;
  readonly identity?: ApplicationServiceIdentityFactory;
  readonly nextExecutionLeaseId?: (input: {
    readonly candidate: RunDispatchCandidate;
    readonly expectedLeaseRevision: number;
  }) => RunExecutionLeaseId;
}

export interface ProductionRunDispatchPumpResult {
  readonly checkedAt: string;
  readonly reconciled: number;
  readonly claimed: number;
  readonly settled: number;
  readonly unknown: number;
  readonly conflicts: number;
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
    const checkedAt = this.#options.clock.now();
    positiveInteger(limit, "limit");
    if (!this.isAccepting()) {
      return Object.freeze({
        checkedAt,
        reconciled: 0,
        claimed: 0,
        settled: 0,
        unknown: 0,
        conflicts: 0,
      });
    }
    await this.#options.authority.assertActive();

    let reconciled = 0;
    const reconciliation = await this.#options.dispatch.listReconciliationRequired({
      now: this.#options.clock.now(),
      limit,
    });
    for (const candidate of reconciliation) {
      if (!this.isAccepting()) break;
      await this.#options.reconcile({
        candidate,
        reasonCode: "PERSISTED_EXECUTION_RECONCILIATION_REQUIRED",
      });
      reconciled += 1;
    }

    if (!this.isAccepting()) {
      return Object.freeze({
        checkedAt,
        reconciled,
        claimed: 0,
        settled: 0,
        unknown: 0,
        conflicts: 0,
      });
    }
    const candidates = await this.#options.dispatch.listClaimable({
      now: this.#options.clock.now(),
      limit,
    });
    let claimed = 0;
    let settled = 0;
    let unknown = 0;
    let conflicts = 0;
    for (const candidate of candidates) {
      if (!this.isAccepting()) break;
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
        unknown += 1;
      };
      try {
        const input = await this.#options.input({ candidate, lease });
        if (renewal.failure()) {
          await reconcileLeaseFailure();
          continue;
        }
        const canonicalInput = this.bindInput(input, candidate, claim);
        if (renewal.failure()) {
          await reconcileLeaseFailure();
          continue;
        }
        let result: CoordinatedRunResult;
        try {
          result = await this.#options.coordinator.execute(canonicalInput);
        } catch (error) {
          await renewal.stop();
          if (renewal.failure()) {
            await reconcileLeaseFailure();
            continue;
          }
          if (error instanceof RunExecutionInterruptedError) {
            await reconcileLeaseFailure(error.reasonCode);
            continue;
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
            unknown += 1;
            continue;
          }
          throw error;
        }
        await renewal.stop();
        if (renewal.failure()) {
          await reconcileLeaseFailure();
          continue;
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
          unknown += 1;
          continue;
        }
        if (!terminal(result.run.run.status)) {
          throw new ProductionRunDispatchError(
            PRODUCTION_RUN_DISPATCH_ERROR_CODES.NON_TERMINAL_RESULT,
            "Run Coordinator returned before reaching a terminal or reconciliation state",
            { runId: candidate.runId, status: result.run.run.status },
          );
        }
        await this.releaseBestEffort(renewal.currentLease());
        settled += 1;
      } catch (error) {
        await renewal.stop();
        if (reconciliationAttempted) throw error;
        if (renewal.failure()) {
          await reconcileLeaseFailure();
          continue;
        }
        // Persist uncertainty before surfacing the failure. Merely expiring the
        // lease would redispatch accepted Runs whose input factory keeps failing.
        await this.reconcileUnknown(
          candidate,
          "RUN_EXECUTION_FAILED_WITHOUT_RESULT",
          undefined,
          renewal.currentLease(),
        );
        await this.releaseBestEffort(renewal.currentLease());
        throw error;
      }
    }
    return Object.freeze({ checkedAt, reconciled, claimed, settled, unknown, conflicts });
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
