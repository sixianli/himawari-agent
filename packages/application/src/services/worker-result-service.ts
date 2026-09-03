import {
  ApplicationPortError,
  PORT_ERROR_CODES,
  type Delegation,
  type DelegationHandleLifecyclePort,
  type DelegationStatePort,
  type WorkerResult,
  type WorkerResultVerificationPort,
} from "../ports/index.js";
import type { ClockPort } from "../ports/system.js";
import {
  delegationIsTerminal,
  ownsDelegationClaim,
  settleDelegationHandles,
  updateDelegation,
} from "./delegation-transitions.js";

export class WorkerResultService {
  readonly #dependencies: {
    readonly state: DelegationStatePort;
    readonly verifier: WorkerResultVerificationPort;
    readonly handles: DelegationHandleLifecyclePort;
    readonly clock: ClockPort;
  };

  constructor(dependencies: {
    readonly state: DelegationStatePort;
    readonly verifier: WorkerResultVerificationPort;
    readonly handles: DelegationHandleLifecyclePort;
    readonly clock: ClockPort;
  }) {
    this.#dependencies = dependencies;
  }

  async validateAndCommit(delegation: Delegation, result: WorkerResult): Promise<Delegation> {
    const latest = await this.#dependencies.state.read(delegation, delegation.id);
    if (!latest)
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "Delegation disappeared");
    if (delegationIsTerminal(latest)) return this.#settle(latest);
    const claimId = delegation.executionClaim?.id;
    if (!claimId || !ownsDelegationClaim(latest, claimId, this.#dependencies.clock.now()))
      return latest;
    if (latest.status !== "validating")
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Delegation has not reserved a result for validation",
      );
    let reason: string | null = null;
    if (
      result.workerRunId !== latest.workerRunId ||
      result.costMicros < 0 ||
      result.durationMs < 0 ||
      result.costMicros > latest.budget.maximumCostMicros ||
      result.durationMs > latest.budget.maximumDurationMs ||
      result.dataClassification !== latest.dataClassification ||
      result.actualModelRef !== latest.selectedModelRef ||
      !latest.allowedModelRefs.includes(result.actualModelRef)
    )
      reason = "WORKER_RESULT_SCOPE_INVALID";
    else {
      const verification = await this.#dependencies.verifier.verify({ delegation: latest, result });
      if (
        !verification.valid ||
        verification.conflictRefs.length > 0 ||
        verification.invalidCitationRefs.length > 0
      )
        reason = verification.reasonCode ?? "WORKER_RESULT_VERIFICATION_FAILED";
    }
    const terminal = await updateDelegation(
      this.#dependencies.state,
      latest,
      latest.id,
      (current) => {
        if (
          !ownsDelegationClaim(current, claimId, this.#dependencies.clock.now()) ||
          current.status !== "validating"
        )
          return current;
        return {
          ...current,
          status: reason ? "failed" : "completed",
          failureReasonCode: reason,
          workerResult: reason ? null : Object.freeze({ ...result }),
          executionClaim: null,
          updatedAt: this.#dependencies.clock.now(),
        };
      },
    );
    return this.#settle(terminal);
  }

  #settle(delegation: Delegation): Promise<Delegation> {
    return settleDelegationHandles(
      this.#dependencies.state,
      this.#dependencies.handles,
      delegation,
    );
  }
}
