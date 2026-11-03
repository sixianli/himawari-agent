import type { AgentId, OwnerId } from "@himawari-agent/domain";

export const OBSERVATION_EVENT_KINDS = [
  "state_snapshot",
  "proactive_enabled",
  "proactive_disabled",
  "source_connected",
  "source_needs_reconnect",
  "source_disconnected",
  "memory_capture_paused",
  "memory_capture_resumed",
  "proactive_records_cleared",
  "consolidation_failed",
] as const;

export type ObservationEventKind = (typeof OBSERVATION_EVENT_KINDS)[number];

export const OBSERVATION_DAY_STATUSES = ["pass", "fail", "blocked", "pending"] as const;

export type ObservationDayStatus = (typeof OBSERVATION_DAY_STATUSES)[number];

export const OBSERVATION_ITEM_STATUSES = [
  "pass",
  "fail",
  "blocked",
  "pending",
  "not_applicable",
] as const;

export type ObservationItemStatus = (typeof OBSERVATION_ITEM_STATUSES)[number];

export type ObservationFact = string | number | boolean | null;

export interface ObservationScope {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
}

export interface ObservationStart extends ObservationScope {
  readonly startDay: string;
  readonly setAt: string;
  readonly serviceRevision: string;
  readonly firstBootAt: string;
}

export interface ObservationCheckItem {
  readonly code: string;
  readonly status: ObservationItemStatus;
  readonly reason: string;
  readonly facts: Readonly<Record<string, ObservationFact>>;
}

export interface ObservationCheck extends ObservationScope {
  readonly id: string;
  readonly day: string;
  readonly checkedAt: string;
  readonly serviceRevision: string;
  readonly status: ObservationDayStatus;
  readonly checks: readonly ObservationCheckItem[];
  readonly counts: Readonly<Record<string, number>>;
}

export interface ObservationEvent extends ObservationScope {
  readonly id: string;
  readonly kind: ObservationEventKind;
  readonly occurredAt: string;
  readonly detail: Readonly<Record<string, ObservationFact>>;
}

export interface ObservationConsolidationRun {
  readonly id: string;
  readonly day: string;
  readonly status: "running" | "completed" | "failed";
  readonly changeCount: number;
  readonly startedAt: string;
  readonly ledgerRows: number;
}

export interface ObservationDayFacts {
  readonly heartbeatHours: readonly string[];
  readonly proactiveTimes: readonly string[];
  readonly counts: Readonly<Record<string, number>>;
  readonly malformedTimes: number;
  readonly consolidationRuns: readonly ObservationConsolidationRun[];
  readonly events: readonly ObservationEvent[];
  readonly proactiveEnabled: boolean;
  readonly sourceStatus: "connected" | "needs_reconnect" | "disconnected";
  readonly capturePaused: boolean;
}

export interface ObservationDayWindow {
  readonly day: string;
  readonly start: string;
  readonly end: string;
}

export interface LedgerObservationPort {
  readStart(input: ObservationScope): Promise<ObservationStart | null>;
  setStart(start: ObservationStart): Promise<void>;
  beat(
    input: ObservationScope & { readonly at: string; readonly serviceRevision: string },
  ): Promise<void>;
  firstHeartbeat(input: ObservationScope): Promise<string | null>;
  ensureSnapshot(input: ObservationScope & { readonly at: string }): Promise<void>;
  readDayFacts(input: ObservationScope & ObservationDayWindow): Promise<ObservationDayFacts>;
  countDays(
    input: ObservationScope & { readonly days: readonly ObservationDayWindow[] },
  ): Promise<Readonly<Record<string, Readonly<Record<string, number>>>>>;
  appendCheck(check: ObservationCheck): Promise<void>;
  listChecks(input: ObservationScope): Promise<readonly ObservationCheck[]>;
  listEvents(
    input: ObservationScope & { readonly since: string },
  ): Promise<readonly ObservationEvent[]>;
}
