import type {
  CalibrationDecisionRow,
  MailJudgment,
  MuseEntryRow,
} from "@himawari-agent/calibration";
import type { AgentId, OwnerId } from "@himawari-agent/domain";

export interface CalibrationRowsSnapshot {
  readonly decisions: readonly CalibrationDecisionRow[];
  readonly entries: readonly MuseEntryRow[];
  readonly mailJudgments: readonly (readonly [string, MailJudgment])[];
}

export const DECISION_KINDS = [
  "proactive",
  "memory_candidate",
  "consolidation",
  "context_truncation",
  "retrieval_degrade",
  "external_read",
] as const;

export type DecisionKind = (typeof DECISION_KINDS)[number];

export type LedgerWriteKind = Exclude<DecisionKind, "proactive">;

export const DECISION_OUTCOMES = {
  memory_candidate: ["kept", "discarded", "pending_approval"],
  consolidation: ["merge", "supersede", "archive", "reflect"],
  context_truncation: ["truncated"],
  retrieval_degrade: ["degraded"],
  external_read: ["read"],
} as const satisfies Record<LedgerWriteKind, readonly string[]>;

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
  readonly memoryInjected?: boolean;
  readonly usedMemoryIds?: readonly string[];
  readonly tentativeMemoryIds?: readonly string[];
  readonly memoryByMail?: Readonly<Record<string, readonly string[]>>;
  readonly memoryRecall?: "off" | "ok" | "partial" | "failed";
}

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

export interface DecisionLedgerScope {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
}

export interface DecisionLedgerPort {
  append(write: DecisionLedgerWrite): Promise<void>;
  list(
    input: DecisionLedgerScope & {
      readonly kind?: DecisionKind;
      readonly since: string;
      readonly limit: number;
    },
  ): Promise<readonly DecisionLedgerEntry[]>;
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
}
