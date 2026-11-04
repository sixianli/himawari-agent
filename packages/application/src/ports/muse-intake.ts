import type { AgentId, OwnerId } from "@himawari-agent/domain";

export const MUSE_INTAKE_KINDS = ["proactive", "scheduled"] as const;
export type MuseIntakeKind = (typeof MUSE_INTAKE_KINDS)[number];

export const MUSE_INTAKE_STATES = {
  proactive: ["delivered", "suppressed"],
  scheduled: ["succeeded", "failed"],
} as const satisfies Record<MuseIntakeKind, readonly string[]>;

export type MuseIntakeState = (typeof MUSE_INTAKE_STATES)[MuseIntakeKind][number];

export const MUSE_INTAKE_DECISIONS = ["send", "skip", "defer"] as const;
export const MUSE_INTAKE_PRIORITIES = ["regular", "high"] as const;
export const MUSE_INTAKE_COUNTED_SOURCES = ["system_record", "chat_record", "derived"] as const;
export const MUSE_INTAKE_SOURCES = [
  ...MUSE_INTAKE_COUNTED_SOURCES,
  "worker_report",
  "run_log_record",
  "memory_record",
  "written_after",
  "unknown",
] as const;
export type MuseIntakeSource = (typeof MUSE_INTAKE_SOURCES)[number];

export function museSourceCounts(source: string | undefined): boolean {
  return (MUSE_INTAKE_COUNTED_SOURCES as readonly string[]).includes(source ?? "");
}

export const MUSE_INTAKE_SENDER = "muse";
export const MUSE_CHANNEL_STALE_MS = 9_000_000;
export const MUSE_CHANNEL_DOWN_MS = 10_800_000;

export interface MuseIntakeScope {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
}

export interface MuseIntakeItemWrite {
  readonly kind: MuseIntakeKind;
  readonly naturalKey: string;
  readonly state: MuseIntakeState;
  readonly reasonCode: string | null;
  readonly decision: (typeof MUSE_INTAKE_DECISIONS)[number] | null;
  readonly reasonEnum: string | null;
  readonly priority: (typeof MUSE_INTAKE_PRIORITIES)[number] | null;
  readonly occurredAt: string;
  readonly scheduledFor: string | null;
  readonly startedAt: string | null;
  readonly preparedAt: string | null;
  readonly handoffAcceptedAt: string | null;
  readonly eventAt: string | null;
  readonly titleRef: string | null;
  readonly textRef: string | null;
  readonly textWithheld: boolean;
  readonly options: readonly string[];
  readonly sources: Readonly<Record<string, MuseIntakeSource>>;
  readonly contentDigest: string;
}

export interface MuseIntakeBatchWrite extends MuseIntakeScope {
  readonly batchId: string;
  readonly senderId: string;
  readonly batchSeq: number;
  readonly sentAt: string;
  readonly receivedAt: string;
  readonly rejectedCount: number;
  readonly droppedFieldCount: number;
  readonly items: readonly MuseIntakeItemWrite[];
}

export type MuseIntakeBatchOutcome =
  | {
      readonly status: "accepted";
      readonly accepted: number;
      readonly duplicate: number;
      readonly conflict: number;
      readonly gap: boolean;
      readonly expectedNextSeq: number;
      readonly unusedRefs: readonly string[];
    }
  | {
      readonly status: "replay";
      readonly expectedNextSeq: number;
      readonly unusedRefs: readonly string[];
    }
  | {
      readonly status: "paused";
      readonly expectedNextSeq: number;
      readonly unusedRefs: readonly string[];
    };

export interface MuseIntakeItem {
  readonly kind: MuseIntakeKind;
  readonly naturalKey: string;
  readonly intakeItemKey: string;
  readonly state: MuseIntakeState;
  readonly reasonCode: string | null;
  readonly decision: string | null;
  readonly reasonEnum: string | null;
  readonly priority: string | null;
  readonly occurredAt: string;
  readonly scheduledFor: string | null;
  readonly eventAt: string | null;
  readonly titleRef: string | null;
  readonly textRef: string | null;
  readonly textWithheld: boolean;
  readonly options: readonly string[];
  readonly sources: Readonly<Record<string, MuseIntakeSource>>;
  readonly receivedAt: string;
  readonly timingOk: boolean | null;
  readonly contentOk: boolean | null;
  readonly ratedAt: string | null;
}

export type MuseChannelState = "never" | "ok" | "stale" | "down" | "paused";

export interface MuseChannelStatus {
  readonly state: MuseChannelState;
  readonly lastBatchAt: string | null;
  readonly lastSeq: number;
  readonly gapCount: number;
  readonly paused: boolean;
  readonly outageStartedAt: string | null;
  readonly outageNotifiedAt: string | null;
}

export interface MuseIntakePort {
  ingestBatch(write: MuseIntakeBatchWrite): Promise<MuseIntakeBatchOutcome>;
  listItems(
    input: MuseIntakeScope & {
      readonly since: string;
      readonly limit: number;
      readonly unratedOnly?: boolean;
    },
  ): Promise<readonly MuseIntakeItem[]>;
  channelStatus(input: MuseIntakeScope & { readonly now: string }): Promise<MuseChannelStatus>;
  checkChannel(
    input: MuseIntakeScope & { readonly now: string },
  ): Promise<MuseChannelStatus & { readonly notify: boolean }>;
  setPaused(input: MuseIntakeScope & { readonly paused: boolean }): Promise<void>;
  rate(
    input: MuseIntakeScope & {
      readonly kind: MuseIntakeKind;
      readonly naturalKey: string;
      readonly timingOk: boolean | null;
      readonly contentOk: boolean | null;
      readonly entryId: string;
      readonly now: string;
    },
  ): Promise<boolean>;
  clearAll(input: MuseIntakeScope): Promise<{ readonly refs: readonly string[] }>;
}

export function museIntakeItemKey(kind: MuseIntakeKind, naturalKey: string): string {
  return `${kind}:${naturalKey}`;
}
