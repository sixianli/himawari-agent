import type { AgentId, OwnerId, RunId } from "@himawari-agent/domain";
import {
  ApplicationPortError,
  type AutonomyScope,
  PORT_ERROR_CODES,
  type DataClassification,
  type Delegation,
  type DelegationHandleLifecyclePort,
  type DelegationProposalPort,
  type DelegationStatePort,
  type JsonObject,
  type PayloadRef,
  type WorkerResultReaderPort,
  type WorkerRunPort,
} from "../ports/index.js";
import type { ClockPort, IdGeneratorPort } from "../ports/system.js";
import type { WorkerResultService } from "./worker-result-service.js";
import {
  delegationIsTerminal,
  ownsDelegationClaim,
  settleDelegationHandles,
  updateDelegation,
} from "./delegation-transitions.js";

function subset(requested: readonly string[], allowed: readonly string[]): boolean {
  const authority = new Set(allowed);
  return requested.every((value) => authority.has(value));
}

export class DelegationService {
  readonly #dependencies: {
    readonly state: DelegationStatePort;
    readonly worker: WorkerRunPort;
    readonly resultReader: WorkerResultReaderPort;
    readonly results: WorkerResultService;
    readonly handles: DelegationHandleLifecyclePort;
    readonly proposals: DelegationProposalPort;
    readonly clock: ClockPort;
    readonly ids: IdGeneratorPort;
  };

  constructor(dependencies: {
    readonly state: DelegationStatePort;
    readonly worker: WorkerRunPort;
    readonly resultReader: WorkerResultReaderPort;
    readonly results: WorkerResultService;
    readonly handles: DelegationHandleLifecyclePort;
    readonly proposals: DelegationProposalPort;
    readonly clock: ClockPort;
    readonly ids: IdGeneratorPort;
  }) {
    this.#dependencies = dependencies;
  }

  async create(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly parentRunId: RunId;
    readonly traceRef: string;
    readonly subtaskRef: PayloadRef;
    readonly outputSchema: JsonObject;
    readonly requestedContextRefs: readonly PayloadRef[];
    readonly requestedCapabilityHandleRefs: readonly string[];
    readonly requestedModelRefs: readonly string[];
    readonly selectedModelRef: string;
    readonly parentContextRefs: readonly PayloadRef[];
    readonly ownerGrantedContextRefs: readonly PayloadRef[];
    readonly parentCapabilityHandleRefs: readonly string[];
    readonly ownerGrantedCapabilityHandleRefs: readonly string[];
    readonly parentModelRefs: readonly string[];
    readonly ownerGrantedModelRefs: readonly string[];
    readonly requestedRecipientRef: string | null;
    readonly dataClassification: DataClassification;
    readonly maximumDurationMs: number;
    readonly requestedCostMicros: number;
    readonly parentCostMicros: number;
    readonly ownerGrantedCostMicros: number;
    readonly maximumProgressEvents: number;
    readonly deadlineAt: string;
    readonly depth: number;
  }): Promise<
    | { readonly outcome: "created"; readonly delegation: Delegation }
    | { readonly outcome: "proposal_required"; readonly proposalRef: PayloadRef }
  > {
    if (
      input.depth !== 1 ||
      !input.requestedModelRefs.includes(input.selectedModelRef) ||
      input.deadlineAt <= this.#dependencies.clock.now() ||
      input.maximumDurationMs < 1 ||
      input.maximumProgressEvents < 1 ||
      input.requestedCostMicros < 0
    )
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Worker delegation is recursive, expired, or unbounded",
      );
    const authorized =
      subset(input.requestedContextRefs, input.parentContextRefs) &&
      subset(input.requestedContextRefs, input.ownerGrantedContextRefs) &&
      subset(input.requestedCapabilityHandleRefs, input.parentCapabilityHandleRefs) &&
      subset(input.requestedCapabilityHandleRefs, input.ownerGrantedCapabilityHandleRefs) &&
      subset(input.requestedModelRefs, input.parentModelRefs) &&
      subset(input.requestedModelRefs, input.ownerGrantedModelRefs) &&
      input.requestedCostMicros <= input.parentCostMicros &&
      input.requestedCostMicros <= input.ownerGrantedCostMicros &&
      input.requestedRecipientRef === null;
    if (!authorized) {
      const proposalRef = await this.#dependencies.proposals.protectScopeExpansion({
        ownerId: input.ownerId,
        agentId: input.agentId,
        parentRunId: input.parentRunId,
        requestedContextRefs: input.requestedContextRefs,
        requestedCapabilityHandleRefs: input.requestedCapabilityHandleRefs,
        requestedModelRefs: input.requestedModelRefs,
        requestedCostMicros: input.requestedCostMicros,
        requestedRecipientRef: input.requestedRecipientRef,
      });
      return Object.freeze({ outcome: "proposal_required", proposalRef });
    }
    const now = this.#dependencies.clock.now();
    const id = this.#dependencies.ids.next("delegation");
    const delegation: Delegation = Object.freeze({
      id,
      revision: 1,
      ownerId: input.ownerId,
      agentId: input.agentId,
      parentRunId: input.parentRunId,
      traceRef: input.traceRef,
      workerRunId: this.#dependencies.ids.next("worker-run"),
      subtaskRef: input.subtaskRef,
      outputSchema: Object.freeze({ ...input.outputSchema }),
      contextRefs: Object.freeze([...input.requestedContextRefs]),
      capabilityHandleRefs: Object.freeze([...input.requestedCapabilityHandleRefs]),
      allowedModelRefs: Object.freeze([...input.requestedModelRefs]),
      selectedModelRef: input.selectedModelRef,
      dataClassification: input.dataClassification,
      budget: Object.freeze({
        maximumDurationMs: input.maximumDurationMs,
        maximumCostMicros: input.requestedCostMicros,
        maximumProgressEvents: input.maximumProgressEvents,
      }),
      progressEventsObserved: 0,
      progressReceipts: [],
      executionGeneration: 0,
      executionClaim: null,
      pendingResultRef: null,
      handlesEndedAt: null,
      workerCancelledAt: null,
      deadlineAt: input.deadlineAt,
      depth: 1,
      status: "created",
      proposalRef: null,
      failureReasonCode: null,
      workerResult: null,
      createdAt: now,
      updatedAt: now,
    });
    return Object.freeze({
      outcome: "created",
      delegation: await this.#dependencies.state.create(delegation),
    });
  }

  async execute(scope: AutonomyScope, delegationId: string): Promise<Delegation> {
    const claimId = this.#dependencies.ids.next("delegation-attempt");
    let active = await updateDelegation(
      this.#dependencies.state,
      scope,
      delegationId,
      (current) => {
        const now = this.#dependencies.clock.now();
        if (
          delegationIsTerminal(current) ||
          (current.executionClaim && current.executionClaim.leaseUntil > now)
        )
          return current;
        if (current.deadlineAt <= now)
          return this.#terminal(current, "cancelled", "DEADLINE_EXPIRED");
        return {
          ...current,
          status: current.pendingResultRef ? "validating" : "running",
          executionGeneration: current.executionGeneration + 1,
          executionClaim: {
            id: claimId,
            leaseUntil: new Date(
              Math.min(
                Date.parse(current.deadlineAt),
                Date.parse(now) + current.budget.maximumDurationMs,
              ),
            ).toISOString(),
          },
          updatedAt: now,
        };
      },
    );
    if (!ownsDelegationClaim(active, claimId, this.#dependencies.clock.now()))
      return this.#settleTerminal(active);
    try {
      if (active.pendingResultRef) return await this.#validatePending(active);
      for await (const event of this.#dependencies.worker.run({
        workerRunId: active.workerRunId,
        idempotencyKey: active.id,
        ownerId: active.ownerId,
        agentId: active.agentId,
        parentRunId: active.parentRunId,
        taskRef: active.subtaskRef,
        delegatedContextRefs: active.contextRefs,
        capabilityHandleRefs: active.capabilityHandleRefs,
        secretRefs: [],
        selectedModelRef: active.selectedModelRef,
        allowedModelRefs: active.allowedModelRefs,
        outputSchema: active.outputSchema,
        dataClassification: active.dataClassification,
        budget: {
          maxDurationMs: active.budget.maximumDurationMs,
          maxCostMicros: active.budget.maximumCostMicros,
          maxProgressEvents: active.budget.maximumProgressEvents,
        },
        deadlineAt: active.deadlineAt,
      })) {
        if (event.workerRunId !== active.workerRunId)
          throw new ApplicationPortError(
            PORT_ERROR_CODES.PROVIDER_FAILURE,
            "Worker emitted an event for another run",
          );
        active = await this.#updateClaim(active, claimId, (current) => {
          if (event.type === "worker.progress") {
            if (!Number.isSafeInteger(event.sequence) || event.sequence < 1)
              return this.#terminal(current, "failed", "WORKER_PROGRESS_SEQUENCE_INVALID");
            const fingerprint = JSON.stringify(event);
            const previous = current.progressReceipts.find(
              ({ sequence }) => sequence === event.sequence,
            );
            if (previous)
              return previous.fingerprint === fingerprint
                ? current
                : this.#terminal(current, "failed", "WORKER_PROGRESS_REPLAY_CONFLICT");
            if (current.progressEventsObserved >= current.budget.maximumProgressEvents)
              return this.#terminal(current, "cancelled", "PROGRESS_BUDGET_EXCEEDED");
            return {
              ...current,
              progressEventsObserved: current.progressEventsObserved + 1,
              progressReceipts: [
                ...current.progressReceipts,
                { sequence: event.sequence, fingerprint },
              ],
              updatedAt: this.#dependencies.clock.now(),
            };
          }
          if (event.type === "worker.completed")
            return {
              ...current,
              status: "validating",
              pendingResultRef: event.resultRef,
              updatedAt: this.#dependencies.clock.now(),
            };
          if (event.type === "worker.cancelled")
            return this.#terminal(current, "cancelled", event.reasonCode);
          return this.#terminal(
            current,
            "failed",
            event.type === "worker.failed" ? event.errorCode : "RESULT_UNKNOWN",
          );
        });
        if (!ownsDelegationClaim(active, claimId, this.#dependencies.clock.now()))
          return this.#settleTerminal(active);
        if (active.pendingResultRef) return await this.#validatePending(active);
      }
      active = await this.#updateClaim(active, claimId, (current) =>
        this.#terminal(current, "failed", "WORKER_TERMINATED_WITHOUT_RESULT"),
      );
      return this.#settleTerminal(active);
    } catch (error) {
      await this.#updateClaim(active, claimId, (current) => ({ ...current, executionClaim: null }));
      if (error instanceof ApplicationPortError) throw error;
      throw new ApplicationPortError(PORT_ERROR_CODES.PROVIDER_FAILURE, "Worker process failed");
    }
  }

  async cancel(
    scope: AutonomyScope,
    delegationId: string,
    reasonCode: string,
  ): Promise<Delegation> {
    const cancelled = await updateDelegation(
      this.#dependencies.state,
      scope,
      delegationId,
      (current) =>
        delegationIsTerminal(current) ? current : this.#terminal(current, "cancelled", reasonCode),
    );
    return this.#settleTerminal(cancelled);
  }

  async #validatePending(delegation: Delegation): Promise<Delegation> {
    if (!delegation.pendingResultRef) throw new TypeError("Delegation has no pending result");
    const result = await this.#dependencies.resultReader.read(delegation.pendingResultRef);
    return this.#dependencies.results.validateAndCommit(delegation, result);
  }

  #terminal(current: Delegation, status: "failed" | "cancelled", reasonCode: string): Delegation {
    return {
      ...current,
      status,
      failureReasonCode: reasonCode,
      workerResult: null,
      executionClaim: null,
      updatedAt: this.#dependencies.clock.now(),
    };
  }

  #updateClaim(
    delegation: Delegation,
    claimId: string,
    update: (current: Delegation) => Delegation,
  ): Promise<Delegation> {
    return updateDelegation(this.#dependencies.state, delegation, delegation.id, (current) => {
      const now = this.#dependencies.clock.now();
      if (delegationIsTerminal(current) || current.executionClaim?.id !== claimId) return current;
      if (current.executionClaim.leaseUntil <= now) return current;
      if (current.deadlineAt <= now)
        return this.#terminal(current, "cancelled", "DEADLINE_EXPIRED");
      return update(current);
    });
  }

  async #settleTerminal(delegation: Delegation): Promise<Delegation> {
    if (!delegationIsTerminal(delegation)) return delegation;
    let current = await settleDelegationHandles(
      this.#dependencies.state,
      this.#dependencies.handles,
      delegation,
    );
    if (current.status === "cancelled" && current.workerCancelledAt === null) {
      await this.#dependencies.worker.cancel(
        current.workerRunId,
        current.failureReasonCode ?? "CANCELLED",
      );
      current = await updateDelegation(this.#dependencies.state, current, current.id, (latest) =>
        latest.workerCancelledAt !== null
          ? latest
          : { ...latest, workerCancelledAt: latest.updatedAt },
      );
    }
    return current;
  }
}
