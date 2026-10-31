import type { AgentId, OwnerId } from "@himawari-agent/domain";

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

export interface DecisionInputs {
  readonly memoryIds: readonly string[];
  readonly ruleIds: readonly string[];
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
}

export interface DecisionLedgerEntry {
  readonly id: string;
  readonly kind: DecisionKind;
  readonly decidedAt: string;
  readonly outcome: string;
  readonly reasonCode: string;
  readonly subjectRef: string | null;
  readonly inputs: DecisionInputs;
  readonly reasonRef: string | null;
  readonly contentRef: string | null;
  readonly costMicros: number;
  readonly durationMs: number;
  readonly ownerRating: DecisionRating | null;
  readonly ratedAt: string | null;
}

export interface MuseReferenceWrite {
  readonly id: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly museAt: string;
  readonly timingOk: boolean;
  readonly contentOk: boolean;
  readonly contentRef: string;
  readonly noteRef: string | null;
  readonly pairedDecisionId: string | null;
  readonly recordedAt: string;
}

export interface MuseReferenceEntry {
  readonly id: string;
  readonly museAt: string;
  readonly timingOk: boolean;
  readonly contentOk: boolean;
  readonly contentRef: string;
  readonly noteRef: string | null;
  readonly pairedDecisionId: string | null;
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
  recordMuse(write: MuseReferenceWrite): Promise<void>;
  listMuse(
    input: DecisionLedgerScope & { readonly since: string; readonly limit: number },
  ): Promise<readonly MuseReferenceEntry[]>;
}
