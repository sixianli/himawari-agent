import type {
  AutomaticActionReviewPort,
  AutomaticReviewOutcome,
  GovernedActionIntent,
} from "../ports/authorization.js";
import type {
  AutomaticActionReviewerPort,
  AutomaticReviewDecision,
  AutomaticReviewRecord,
  AutomaticReviewRequest,
  AutomaticReviewStorePort,
} from "../ports/automatic-action-review.js";
import type { RunExecutionLeaseClaim } from "../ports/run-dispatch.js";
import type { ClockPort, IdGeneratorPort } from "../ports/system.js";
import { actionIntentFingerprint } from "./action-intent-snapshot.js";
import { freezeGovernedActionIntent } from "./action-policy-service.js";
import {
  automaticReviewDelegationCovers,
  parseAutomaticReviewDecision,
} from "./automatic-action-review-contract.js";

export interface AutomaticActionReviewDependencies {
  readonly maximumWaitMs: number;
  readonly configurationVersion: string;
  readonly modelRef: string;
  readonly delegationKey: string;
  readonly store: AutomaticReviewStorePort;
  readonly reviewer: AutomaticActionReviewerPort;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
  readonly executionLease: (
    runId: GovernedActionIntent["runId"],
  ) => Promise<RunExecutionLeaseClaim>;
  /** Uses the existing protected Payload and disclosure boundary; never reads files here. */
  readonly prepareInput: (
    intent: GovernedActionIntent,
    request: Omit<AutomaticReviewRequest, "inputRef">,
    signal: AbortSignal,
  ) => Promise<string>;
  readonly saveOutput: (
    request: AutomaticReviewRequest,
    decision: AutomaticReviewDecision,
    signal: AbortSignal,
  ) => Promise<string>;
}

/** Disabled unless explicitly composed. It has no tool, Worker or file-execution port. */
export class AutomaticActionReviewService implements AutomaticActionReviewPort {
  readonly maximumWaitMs: number;
  private readonly dependencies: AutomaticActionReviewDependencies;
  constructor(dependencies: AutomaticActionReviewDependencies) {
    this.dependencies = dependencies;
    this.maximumWaitMs = dependencies.maximumWaitMs;
    if (
      !Number.isSafeInteger(this.maximumWaitMs) ||
      this.maximumWaitMs < 1 ||
      this.maximumWaitMs > 300_000
    )
      throw new Error("AUTOMATIC_REVIEW_CONFIGURATION_INVALID");
  }

  async review(
    input: Parameters<AutomaticActionReviewPort["review"]>[0],
    signal: AbortSignal,
  ): Promise<AutomaticReviewOutcome | undefined> {
    const d = this.dependencies;
    const intent = freezeGovernedActionIntent(input.intent);
    const deadlineAt = new Date(
      Math.min(Date.parse(input.deadlineAt), Date.parse(d.clock.now()) + this.maximumWaitMs),
    ).toISOString();
    const current = () =>
      !signal.aborted && d.clock.now() < deadlineAt && d.clock.now() < intent.expiresAt;
    // Critical actions still require recent Owner authentication through the human path.
    if (!current() || intent.finalRisk === "CRITICAL" || intent.credentialOrAccessChange)
      return undefined;
    const identity = {
      configurationVersion: d.configurationVersion,
      modelRef: d.modelRef,
      policyVersion: input.policyVersion,
      intentFingerprint: actionIntentFingerprint(intent),
      deadlineAt,
      approvalExpiresAt: input.approvalExpiresAt,
    };
    const delegated = await d.store.readDelegation({
      ownerId: intent.ownerId,
      agentId: intent.agentId,
      key: d.delegationKey,
    });
    if (
      !delegated ||
      !current() ||
      !automaticReviewDelegationCovers(delegated.value, identity, d.clock.now())
    )
      return undefined;
    const envelope = Object.freeze({
      ...identity,
      schemaVersion: "automatic-review.v1" as const,
      reviewId: d.ids.next("automatic-review"),
      runId: intent.runId,
    });
    const inputRef = await d.prepareInput(intent, envelope, signal);
    if (!current()) return undefined;
    const request: AutomaticReviewRequest = Object.freeze({ ...envelope, inputRef });
    const executionLease = await d.executionLease(intent.runId);
    if (!current()) return undefined;
    const claim = await d.store.claim({
      request,
      intent,
      delegation: { key: d.delegationKey, revision: delegated.revision },
      executionLease,
      startedAt: d.clock.now(),
    });
    if (!claim || !current()) return undefined;
    // A repeated request reuses the first durable record; its committed decision still
    // applies, but the authority is the stored Grant, never this return value.
    if (!claim.claimed) return this.#outcome(claim.record);
    const decision = parseAutomaticReviewDecision(
      request,
      await d.reviewer.review(request, signal),
    );
    if (!current()) return undefined;
    const outputRef = await d.saveOutput(request, decision, signal);
    const latestLease = await d.executionLease(intent.runId);
    if (!current()) return undefined;
    return this.#outcome(
      await d.store.finish({
        reviewId: request.reviewId,
        decision,
        outputRef,
        executionLease: latestLease,
        completedAt: d.clock.now(),
      }),
    );
  }

  #outcome(record: AutomaticReviewRecord): AutomaticReviewOutcome | undefined {
    const result = record.result;
    if (!result) return undefined;
    if (result.decision === "approve" || result.decision === "deny" || result.decision === "human")
      return Object.freeze({ decision: result.decision });
    return Object.freeze({
      decision: "alternative",
      reasonCode: result.reasonCode,
      suggestionRef: result.suggestionRef,
    });
  }
}

export {
  automaticReviewDelegationCovers,
  parseAutomaticReviewDecision,
} from "./automatic-action-review-contract.js";
