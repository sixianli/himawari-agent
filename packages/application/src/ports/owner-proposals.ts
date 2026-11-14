import type { OwnerRuleScope } from "./owner-rules.js";

export type OwnerProposalStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "expired"
  | "superseded"
  | "withdrawn";
export type OwnerProposalOrigin = "owner_said" | "inferred" | "external_agent" | "external_content";
export type OwnerProposalExecutionStatus =
  | "not_started"
  | "running"
  | "executed_unverified"
  | "succeeded"
  | "failed"
  | "unknown"
  | "undone";

export interface StoredOwnerProposal {
  readonly proposalId: string;
  readonly type: string;
  readonly summary: string;
  readonly effect: string;
  readonly origin: OwnerProposalOrigin;
  readonly threadId: string | null;
  readonly sourceRef: string | null;
  readonly sourceVersion: string | null;
  readonly version: number;
  readonly fingerprint: string;
  readonly evidenceRef: string | null;
  readonly status: OwnerProposalStatus;
  readonly proposedAt: string;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
  readonly proposedCount: number;
  readonly rejectCount: number;
  readonly lastRejectedAt: string | null;
  readonly execStatus: OwnerProposalExecutionStatus;
  readonly leaseId: string | null;
  readonly leaseExpiresAt: string | null;
  readonly attempts: number;
  readonly requiresFullRead: boolean;
  readonly requiresPresence: boolean;
  readonly executedAt: string | null;
  readonly executionRef: string | null;
}

export interface OwnerProposalVersion {
  readonly version: number;
  readonly fingerprint: string;
}

export type OwnerProposalOutcome =
  | "created"
  | "reopened"
  | "refreshed"
  | "limit_reached"
  | "closed";

export interface OwnerProposalStorePort {
  propose(
    input: OwnerRuleScope & {
      readonly proposalId: string;
      readonly type: string;
      readonly summary: string;
      readonly effect: string;
      readonly origin: OwnerProposalOrigin;
      readonly threadId: string | null;
      readonly sourceRef: string | null;
      readonly sourceVersion: string | null;
      readonly fingerprint: string;
      readonly evidenceRef: string | null;
      readonly requiresFullRead?: boolean;
      readonly requiresPresence?: boolean;
      readonly now: string;
      readonly expiresAt: string;
      readonly pendingLimit: number;
    },
  ): Promise<OwnerProposalOutcome>;
  read(
    input: OwnerRuleScope & { readonly proposalId: string; readonly now: string },
  ): Promise<StoredOwnerProposal | undefined>;
  listPending(input: OwnerRuleScope & { readonly now: string; readonly limit: number }): Promise<{
    readonly proposals: readonly StoredOwnerProposal[];
    readonly pendingCount: number;
  }>;
  decide(
    input: OwnerRuleScope & {
      readonly proposalId: string;
      readonly from: OwnerProposalStatus;
      readonly to: Exclude<OwnerProposalStatus, "expired">;
      readonly expected?: OwnerProposalVersion;
      readonly now: string;
    },
  ): Promise<StoredOwnerProposal | undefined>;
  claim(
    input: OwnerRuleScope & {
      readonly proposalId: string;
      readonly expected: OwnerProposalVersion;
      readonly leaseId: string;
      readonly leaseExpiresAt: string;
      readonly now: string;
    },
  ): Promise<StoredOwnerProposal | undefined>;
  moveExecution(
    input: OwnerRuleScope & {
      readonly proposalId: string;
      readonly from: OwnerProposalExecutionStatus;
      readonly to: OwnerProposalExecutionStatus;
      readonly leaseId: string | null;
      readonly executionRef?: string | null;
      readonly now: string;
    },
  ): Promise<StoredOwnerProposal | undefined>;
  listExpiredLeases(
    input: OwnerRuleScope & { readonly now: string; readonly limit: number },
  ): Promise<readonly StoredOwnerProposal[]>;
  settledEvidence(
    input: OwnerRuleScope & { readonly now: string; readonly limit: number },
  ): Promise<readonly { readonly proposalId: string; readonly evidenceRef: string }[]>;
  clearEvidence(
    input: OwnerRuleScope & { readonly proposalId: string; readonly evidenceRef: string },
  ): Promise<boolean>;
}
