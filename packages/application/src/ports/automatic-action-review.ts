import type { RunId } from "@himawari-agent/domain";
import type { PayloadRef } from "./common.js";
import type { GovernedActionIntent } from "./authorization.js";
import type { RunExecutionLeaseClaim } from "./run-dispatch.js";

/** Protected input is assembled by the host from the Owner's delegated disclosure scope. */
export interface AutomaticReviewRequest {
  readonly schemaVersion: "automatic-review.v1";
  readonly reviewId: string;
  readonly runId: RunId;
  readonly inputRef: PayloadRef;
  readonly intentFingerprint: string;
  readonly policyVersion: string;
  readonly configurationVersion: string;
  readonly modelRef: string;
  readonly deadlineAt: string;
  readonly approvalExpiresAt: string;
}

interface ReviewDecisionIdentity {
  readonly schemaVersion: "automatic-review.v1";
  readonly reviewId: string;
  readonly intentFingerprint: string;
  readonly policyVersion: string;
  readonly configurationVersion: string;
  readonly modelRef: string;
  readonly reasonCode: string;
  /**
   * Calibrated confidence reported by the reviewer, when it provides one. It is not
   * authority: `AutomaticActionReviewService` routes a below-threshold approval to
   * human confirmation instead of committing it.
   */
  readonly confidence?: number;
}
/** No decision contains a Grant, command, resource scope, or execution handle. */
export type AutomaticReviewDecision = ReviewDecisionIdentity &
  (
    | { readonly decision: "approve" | "deny" | "human" }
    | { readonly decision: "alternative"; readonly suggestion: string }
  );

/** Model output is always untrusted, including when the transport claims structured output. */
export interface AutomaticActionReviewerPort {
  review(request: AutomaticReviewRequest, signal: AbortSignal): Promise<unknown>;
}

/** Initial delegation is exact-intent only. No model output may widen this list. */
export interface AutomaticReviewDelegation {
  readonly kind: "automatic-review.v1";
  readonly enabled: boolean;
  readonly configurationVersion: string;
  readonly modelRef: string;
  readonly policyVersion: string;
  readonly intentFingerprints: readonly string[];
  readonly expiresAt: string;
}

export interface AutomaticReviewStart {
  readonly request: AutomaticReviewRequest;
  readonly intent: GovernedActionIntent;
  readonly delegation: { readonly key: string; readonly revision: number };
  readonly executionLease: RunExecutionLeaseClaim;
  readonly startedAt: string;
}

export interface AutomaticReviewRecord extends AutomaticReviewStart {
  readonly status: "pending" | "finished";
  readonly result: null | {
    readonly decision: AutomaticReviewDecision["decision"];
    readonly reasonCode: string;
    /** Reported confidence is retained even when the effective decision is human. */
    readonly confidence?: number;
    /** Scoped protected payload holding the untrusted suggestion text, when one exists. */
    readonly suggestionRef: string | null;
    readonly outputRef: PayloadRef;
    readonly completedAt: string;
    readonly approvalRequestId: string | null;
  };
}

export interface AutomaticReviewFinish {
  readonly reviewId: string;
  readonly decision: AutomaticReviewDecision;
  readonly outputRef: PayloadRef;
  readonly executionLease: RunExecutionLeaseClaim;
  readonly completedAt: string;
}

/** Every mutation is conditional on current delegation, Run lease and deadline.
 * Claim never allocates a file claim, Grant, Handle or execution receipt.
 * Completion and the bounded Approval/Grant commit share one transaction. */
export interface AutomaticReviewStorePort {
  readDelegation(input: {
    readonly ownerId: string;
    readonly agentId: string;
    readonly key: string;
  }): Promise<{ readonly revision: number; readonly value: AutomaticReviewDelegation } | undefined>;
  claim(
    input: AutomaticReviewStart,
  ): Promise<{ readonly record: AutomaticReviewRecord; readonly claimed: boolean } | undefined>;
  finish(input: AutomaticReviewFinish): Promise<AutomaticReviewRecord>;
  get(reviewId: string): Promise<AutomaticReviewRecord | undefined>;
}
