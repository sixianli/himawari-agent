import type { OwnerRuleScope } from "./owner-rules.js";

export type OwnerRuleProposalStatus = "pending" | "accepted" | "rejected" | "expired";
export type OwnerRuleProposalOrigin = "owner_said" | "inferred";

export interface StoredOwnerRuleProposal {
  readonly proposalId: string;
  readonly ruleType: string;
  readonly summary: string;
  readonly origin: OwnerRuleProposalOrigin;
  readonly threadId: string | null;
  readonly evidenceRef: string | null;
  readonly status: OwnerRuleProposalStatus;
  readonly proposedAt: string;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
  readonly proposedCount: number;
  readonly rejectCount: number;
  readonly lastRejectedAt: string | null;
}

export const OWNER_RULE_PROPOSALS_LISTED_MAX = 200;

export type OwnerRuleProposalOutcome = "created" | "reopened" | "refreshed" | "limit_reached";

export interface OwnerRuleProposalStorePort {
  propose(
    input: OwnerRuleScope & {
      readonly proposalId: string;
      readonly ruleType: string;
      readonly summary: string;
      readonly origin: OwnerRuleProposalOrigin;
      readonly threadId: string | null;
      readonly evidenceRef: string | null;
      readonly now: string;
      readonly expiresAt: string;
      readonly pendingLimit: number;
    },
  ): Promise<OwnerRuleProposalOutcome>;
  read(
    input: OwnerRuleScope & { readonly proposalId: string; readonly now: string },
  ): Promise<StoredOwnerRuleProposal | undefined>;
  listPending(input: OwnerRuleScope & { readonly now: string; readonly limit: number }): Promise<{
    readonly proposals: readonly StoredOwnerRuleProposal[];
    readonly pendingCount: number;
  }>;
  decide(
    input: OwnerRuleScope & {
      readonly proposalId: string;
      readonly from: OwnerRuleProposalStatus;
      readonly to: Exclude<OwnerRuleProposalStatus, "expired">;
      readonly now: string;
    },
  ): Promise<StoredOwnerRuleProposal | undefined>;
  settledEvidence(
    input: OwnerRuleScope & { readonly now: string; readonly limit: number },
  ): Promise<readonly { readonly proposalId: string; readonly evidenceRef: string }[]>;
  clearEvidence(
    input: OwnerRuleScope & { readonly proposalId: string; readonly evidenceRef: string },
  ): Promise<boolean>;
}
