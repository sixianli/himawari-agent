import type {
  CalibrationDecisionRow,
  ImplicitSignalRow,
  MailJudgment,
  MuseEntryRow,
} from "@himawari-agent/calibration";
import type { PrereviewWeekRow } from "@himawari-agent/calibration/prereview";
import type { AgentId, OwnerId } from "@himawari-agent/domain";
import type { RuleBookVersion } from "../rules/rule-ref.js";
import type { ProactiveScope } from "./proactive-checks.js";

export interface CalibrationRowsSnapshot {
  readonly decisions: readonly CalibrationDecisionRow[];
  readonly entries: readonly MuseEntryRow[];
  readonly mailJudgments: readonly (readonly [string, MailJudgment])[];
  readonly signals: readonly ImplicitSignalRow[];
  readonly prereviews: readonly PrereviewWeekRow[];
}

export const DECISION_SIGNALS = ["opened", "undone", "replied"] as const;

export type DecisionSignalKind = (typeof DECISION_SIGNALS)[number];

export interface DecisionSignalEntry {
  readonly decisionId: string;
  readonly signal: DecisionSignalKind;
  readonly occurredAt: string;
  readonly delayMs: number;
  readonly detail: Readonly<Record<string, string | number | boolean>>;
}

export const DECISION_KINDS = [
  "proactive",
  "memory_candidate",
  "consolidation",
  "context_truncation",
  "retrieval_degrade",
  "external_read",
  "rule_review",
  "web_push",
  "memory_review",
  "limit_change",
  "delivery_timing",
  "proposal",
  "device_action",
] as const;

export type DecisionKind = (typeof DECISION_KINDS)[number];

export type LedgerWriteKind = Exclude<DecisionKind, "proactive">;

export const DECISION_OUTCOMES = {
  memory_candidate: [
    "kept",
    "discarded",
    "pending_approval",
    "capture_retrying",
    "capture_queued",
    "capture_gave_up",
  ],
  consolidation: ["merge", "supersede", "archive", "reflect", "hold"],
  context_truncation: ["truncated"],
  retrieval_degrade: ["degraded"],
  external_read: ["read"],
  rule_review: [
    "needs_review",
    "suspended",
    "cleared",
    "recheck_failed",
    "owner_adopted",
    "owner_confirmed",
    "owner_restored",
  ],
  web_push: ["deferred"],
  memory_review: ["flagged", "owner_edited", "owner_dismissed", "owner_reported_missed"],
  limit_change: ["changed"],
  delivery_timing: ["delivered", "deferred", "deadline_reached", "shown_in_app"],
  proposal: [
    "proposed",
    "blocked",
    "accepted",
    "dismissed",
    "expired",
    "executed",
    "failed",
    "undone",
    "not_proposed",
    "superseded",
    "told",
  ],
  device_action: [
    "waiting_owner",
    "queued",
    "delivered",
    "succeeded",
    "failed",
    "result_unknown",
    "expired",
    "rejected",
    "policy_changed",
  ],
} as const satisfies Record<LedgerWriteKind, readonly string[]>;

export const EXTERNAL_PROPOSAL_REASON_PREFIX = "mcp_proposal_";

export const EXTERNAL_PROPOSAL_REASON_CODES = {
  kept: `${EXTERNAL_PROPOSAL_REASON_PREFIX}kept`,
  declined: `${EXTERNAL_PROPOSAL_REASON_PREFIX}declined`,
  pending: `${EXTERNAL_PROPOSAL_REASON_PREFIX}pending`,
  superseded: `${EXTERNAL_PROPOSAL_REASON_PREFIX}superseded`,
} as const;

export const MEMORY_CAPTURE_FAILURE_OUTCOMES = [
  "capture_retrying",
  "capture_queued",
  "capture_gave_up",
] as const;

export type MemoryCaptureFailureOutcome = (typeof MEMORY_CAPTURE_FAILURE_OUTCOMES)[number];

export function isMemoryCaptureFailure(outcome: string | null): boolean {
  return (MEMORY_CAPTURE_FAILURE_OUTCOMES as readonly (string | null)[]).includes(outcome);
}

export type DecisionOutcome = (typeof DECISION_OUTCOMES)[LedgerWriteKind][number];

export const DECISION_RATINGS = ["useful", "unneeded", "missed"] as const;

export type DecisionRating = (typeof DECISION_RATINGS)[number];

export const DECISION_CATEGORIES = [
  "identity",
  "preference",
  "relationship",
  "goal",
  "project",
  "rule",
  "health",
  "finance",
  "event",
  "other",
] as const;

export type DecisionCategory = (typeof DECISION_CATEGORIES)[number];

export interface DecisionInputs {
  readonly memoryIds: readonly string[];
  readonly ruleIds: readonly string[];
  readonly batchId?: string | null;
  readonly resultMemoryIds?: readonly string[];
  readonly sourceIds?: readonly string[];
  readonly floorHits?: Readonly<Record<string, readonly string[]>>;
  readonly ruleHits?: Readonly<Record<string, readonly string[]>>;
  readonly memoryInjected?: boolean;
  readonly usedMemoryIds?: readonly string[];
  readonly tentativeMemoryIds?: readonly string[];
  readonly memoryByMail?: Readonly<Record<string, readonly string[]>>;
  readonly memoryRecall?: "off" | "ok" | "partial" | "failed";
  readonly relatedByMail?: Readonly<Record<string, readonly string[]>>;
  readonly relatedRead?: "off" | "ok" | "partial" | "failed";
  readonly relatedStats?: {
    readonly requests: number;
    readonly messages: number;
    readonly characters: number;
    readonly durationMs: number;
  };
  readonly relatedFailedSteps?: readonly string[];
  readonly summaryInjected?: boolean;
  readonly summaryIds?: readonly string[];
  readonly summaryDays?: readonly string[];
  readonly summaryCharacters?: number;
  readonly summaryRead?: "off" | "ok" | "partial" | "failed";
  readonly summaryGenerated?: number;
  readonly profileBudget?: ProfileBudget | null;
  readonly limitChange?: LimitChangeInput | null;
}

export interface LimitChangeInput {
  readonly key: string;
  readonly from: number | null;
  readonly to: number | null;
}

export const LIMIT_CHANGE_REASON_CODE = "limit_changed_by_owner";

export interface ProfileBudget {
  readonly limit: number;
  readonly used: number;
  readonly pinned: number;
}

export const PROFILE_BUDGET_EXCEEDED = "profile_budget_exceeded";
export const PROFILE_PINNED_OVER_BUDGET = "profile_pinned_over_budget";
export const PROFILE_TRUNCATION_REASONS = [
  PROFILE_BUDGET_EXCEEDED,
  PROFILE_PINNED_OVER_BUDGET,
] as const;

export interface DecisionLedgerWrite {
  readonly id: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly kind: LedgerWriteKind;
  readonly decidedAt: string;
  readonly outcome: string;
  readonly reasonCode: string;
  readonly subjectRef: string | null;
  readonly inputs: DecisionInputs;
  readonly reasonRef: string | null;
  readonly contentRef: string | null;
  readonly costMicros: number;
  readonly durationMs: number;
  readonly category?: DecisionCategory | null;
  readonly confidencePermille?: number | null;
  readonly inferred?: boolean | null;
}

export interface DecisionLedgerEntry {
  readonly id: string;
  readonly kind: DecisionKind;
  readonly decidedAt: string;
  readonly outcome: string;
  readonly reasonCode: string;
  readonly subjectRef: string | null;
  readonly inputs: Required<DecisionInputs>;
  readonly reasonRef: string | null;
  readonly contentRef: string | null;
  readonly costMicros: number;
  readonly durationMs: number;
  readonly ownerRating: DecisionRating | null;
  readonly ratedAt: string | null;
  readonly category: DecisionCategory | null;
  readonly confidencePermille: number | null;
  readonly inferred: boolean | null;
}

export interface DecisionRecordRead {
  readonly entry: DecisionLedgerEntry;
  readonly inputFields: readonly string[];
  readonly ruleVersions?: Readonly<Record<string, RuleBookVersion>>;
}

interface MuseReferenceBase {
  readonly id: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly museAt: string;
  readonly noteRef: string | null;
  readonly intakeItemKey?: string | null;
  readonly pairedMessageId?: string | null;
  readonly recordedAt: string;
}

export interface MuseRemindedWrite extends MuseReferenceBase {
  readonly museReminded: true;
  readonly timingOk: boolean;
  readonly contentOk: boolean;
  readonly contentRef: string | null;
  readonly pairedDecisionId: string | null;
}

export interface MuseSilentWrite extends MuseReferenceBase {
  readonly museReminded: false;
  readonly pairedDecisionId: string | null;
}

export type MuseReferenceWrite = MuseRemindedWrite | MuseSilentWrite;

export interface MuseReferenceEntry {
  readonly id: string;
  readonly museAt: string;
  readonly museReminded: boolean;
  readonly timingOk: boolean | null;
  readonly contentOk: boolean | null;
  readonly contentRef: string | null;
  readonly noteRef: string | null;
  readonly pairedDecisionId: string | null;
  readonly intakeItemKey: string | null;
  readonly pairedMessageId: string | null;
  readonly recordedAt: string;
}

export interface GapCandidate {
  readonly entryId: string;
  readonly museAt: string;
  readonly timingOk: boolean | null;
  readonly contentOk: boolean | null;
  readonly pairedMessageId: string;
  readonly museTitleRef: string | null;
  readonly museTextRef: string | null;
  readonly museContentRef: string | null;
  readonly museTextWithheld: boolean;
  readonly decisionId: string;
  readonly outcome: string;
  readonly ownerRating: DecisionRating | null;
  readonly reasonCode: string;
  readonly reasonRef: string | null;
  readonly decidedAt: string;
  readonly relatedRead: string | null;
  readonly memoryRecall: string | null;
  readonly memoryHitsForMail: number;
  readonly relatedMessagesForMail: number;
}

export const MAIL_TRACE_MUSE_LIMIT = 20;

export interface MailTraceProcessed {
  readonly decisionId: string;
  readonly threadId: string;
  readonly outcome: string;
  readonly skipReason: string | null;
  readonly ownerRating: DecisionRating | null;
  readonly processedAt: string;
}

export interface MailTraceMuseEntry {
  readonly entryId: string;
  readonly museAt: string;
  readonly museReminded: boolean;
  readonly timingOk: boolean | null;
  readonly contentOk: boolean | null;
  readonly kind: string | null;
  readonly state: string | null;
  readonly titleRef: string | null;
  readonly textRef: string | null;
  readonly contentRef: string | null;
  readonly textWithheld: boolean;
}

export interface MailTrace {
  readonly processed: MailTraceProcessed | null;
  readonly museEntries: readonly MailTraceMuseEntry[];
}

export interface RuleLastUse {
  readonly ruleId: string;
  readonly decisionId: string;
  readonly kind: DecisionKind;
  readonly decidedAt: string;
}

export interface DecisionLedgerScope {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
}

export interface DecisionLedgerPort {
  append(write: DecisionLedgerWrite): Promise<void>;
  appendIfChanged(input: {
    readonly write: DecisionLedgerWrite;
    readonly reasonCodes: readonly string[];
  }): Promise<boolean>;
  list(
    input: DecisionLedgerScope & {
      readonly kind?: DecisionKind;
      readonly since: string;
      readonly limit: number;
    },
  ): Promise<readonly DecisionLedgerEntry[]>;
  read(
    input: DecisionLedgerScope & { readonly decisionId: string },
  ): Promise<DecisionRecordRead | undefined>;
  rate(
    input: DecisionLedgerScope & {
      readonly decisionId: string;
      readonly rating: DecisionRating | null;
      readonly now: string;
    },
  ): Promise<boolean>;
  listReviewPool(
    input: DecisionLedgerScope & {
      readonly since: string;
      readonly ratedSince: string;
      readonly limit: number;
    },
  ): Promise<readonly DecisionLedgerEntry[]>;
  rateMany(
    input: DecisionLedgerScope & {
      readonly ratings: readonly {
        readonly decisionId: string;
        readonly rating: DecisionRating | null;
      }[];
      readonly now: string;
    },
  ): Promise<number>;
  listSignals(
    input: DecisionLedgerScope & { readonly decisionIds: readonly string[] },
  ): Promise<readonly DecisionSignalEntry[]>;
  recordMuse(write: MuseReferenceWrite): Promise<void>;
  readCalibrationRows(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly start: string;
    readonly end: string;
  }): Promise<CalibrationRowsSnapshot>;
  listMuse(
    input: DecisionLedgerScope & { readonly since: string; readonly limit: number },
  ): Promise<readonly MuseReferenceEntry[]>;
  lastRuleUses(
    input: DecisionLedgerScope & { readonly ruleIds: readonly string[] },
  ): Promise<readonly RuleLastUse[]>;
  readMailTrace(input: DecisionLedgerScope & { readonly messageId: string }): Promise<MailTrace>;
  readGapCandidates(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly start: string;
    readonly end: string;
  }): Promise<readonly GapCandidate[]>;
}

export interface GapCaseMarkRow {
  readonly caseId: string;
  readonly snapshotRef: string;
  readonly markedAt: string;
}

export interface GapCaseMarkPort {
  mark(
    input: ProactiveScope & {
      readonly caseId: string;
      readonly snapshotRef: string;
      readonly at: string;
    },
  ): Promise<boolean>;
  unmark(input: ProactiveScope & { readonly caseId: string }): Promise<string | null>;
  list(input: ProactiveScope): Promise<readonly GapCaseMarkRow[]>;
}
