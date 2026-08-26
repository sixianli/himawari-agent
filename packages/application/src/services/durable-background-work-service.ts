import type {
  AgentId,
  BackgroundOccurrence,
  JobId,
  OccurrenceId,
  OwnerId,
  ProductAuthorityFence,
  RunId,
  ThreadId,
} from "@himawari-agent/domain";
import {
  PORT_ERROR_CODES,
  ApplicationPortError,
  type BackgroundAdmissionLimits,
  type BackgroundAdmissionResult,
  type BackgroundOccurrenceSettlement,
  type BackgroundWorkStatePort,
  type DataClassification,
  type PayloadRef,
} from "../ports/index.js";
import type { UnifiedTriggerPort } from "./unified-trigger-ingestion-service.js";

export type DurableSchedule =
  | {
      readonly kind: "interval";
      readonly anchorAt: string;
      readonly intervalMs: number;
      readonly misfireGraceMs: number;
    }
  | {
      readonly kind: "one_shot";
      readonly at: string;
      readonly misfireGraceMs: number;
    }
  | {
      readonly kind: "daily";
      readonly timeZone: string;
      readonly hour: number;
      readonly minute: number;
      readonly misfireGraceMs: number;
    };

export interface ScheduleEvaluation {
  readonly outcome: "future" | "due" | "skipped" | "missed";
  readonly scheduledAt: string | null;
  readonly nextAt: string | null;
  readonly localDate: string | null;
  readonly skippedCount: number;
}

export interface DurableBackgroundDispatch {
  readonly occurrence: BackgroundOccurrence;
  readonly runId: RunId;
  readonly limits: BackgroundAdmissionLimits;
  readonly trigger: {
    readonly messageId: string;
    readonly correlationId: string;
    readonly causationId: string | null;
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly actorType: "owner" | "client" | "scheduler" | "external_adapter" | "system";
    readonly actorId: string;
    readonly dataClassification: DataClassification;
    readonly triggerId: string;
    readonly sourceType: "user_message" | "schedule" | "external_event";
    readonly sourceId: string;
    readonly occurredAt: string;
    readonly threadId: ThreadId | null;
    readonly payloadRef: PayloadRef;
    readonly sourceProofRef: string;
  };
}

export interface DurableBackgroundDispatchResult extends BackgroundAdmissionResult {
  readonly triggerResultRef: string | null;
  readonly replayed: boolean;
}

export interface DurableBackgroundWorkServiceDependencies {
  readonly state: BackgroundWorkStatePort;
  readonly triggers: UnifiedTriggerPort;
}

function canonicalTimestamp(value: string, field: string): number {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      `${field} must be a canonical ISO timestamp`,
      { field },
    );
  }
  return parsed.valueOf();
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      `${field} must be a non-negative safe integer`,
      { field, value: String(value) },
    );
  }
}

function requiredDatePart(
  parts: readonly Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string {
  const part = parts.find((candidate) => candidate.type === type);
  if (!part) throw new Error(`Intl formatter did not produce ${type}`);
  return part.value;
}

function localParts(formatter: Intl.DateTimeFormat, at: number) {
  const parts = formatter.formatToParts(new Date(at));
  return {
    date: `${requiredDatePart(parts, "year")}-${requiredDatePart(parts, "month")}-${requiredDatePart(parts, "day")}`,
    hour: Number(requiredDatePart(parts, "hour")),
    minute: Number(requiredDatePart(parts, "minute")),
  };
}

function dailyCandidates(
  schedule: Extract<DurableSchedule, { kind: "daily" }>,
  startAt: number,
  endAt: number,
  excludedLocalDate: string | null,
): readonly { readonly at: number; readonly localDate: string }[] {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: schedule.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      `Schedule timezone ${schedule.timeZone} is not a supported IANA timezone`,
      { timeZone: schedule.timeZone },
    );
  }
  const firstMinute = Math.ceil(startAt / 60_000) * 60_000;
  const seenDates = new Set<string>(excludedLocalDate ? [excludedLocalDate] : []);
  const candidates: Array<{ readonly at: number; readonly localDate: string }> = [];
  for (let at = firstMinute; at <= endAt; at += 60_000) {
    const local = localParts(formatter, at);
    if (
      local.hour === schedule.hour &&
      local.minute === schedule.minute &&
      !seenDates.has(local.date)
    ) {
      seenDates.add(local.date);
      candidates.push({ at, localDate: local.date });
    }
  }
  return candidates;
}

/**
 * Evaluate one durable schedule tick. Periodic misfires are coalesced and old
 * occurrences are skipped; a one-shot misfire becomes terminal MISSED. Daily
 * schedules are resolved through Intl's IANA database. A nonexistent DST wall
 * time therefore has no candidate, while a repeated wall time is deduplicated
 * by local calendar date and runs only at its first occurrence.
 */
export function evaluateDurableSchedule(
  schedule: DurableSchedule,
  input: { readonly now: string; readonly lastScheduledAt: string | null },
): ScheduleEvaluation {
  const now = canonicalTimestamp(input.now, "now");
  const last =
    input.lastScheduledAt === null
      ? null
      : canonicalTimestamp(input.lastScheduledAt, "lastScheduledAt");
  assertNonNegativeInteger(schedule.misfireGraceMs, "misfireGraceMs");

  if (schedule.kind === "one_shot") {
    const at = canonicalTimestamp(schedule.at, "schedule.at");
    if (last !== null && last >= at) {
      return {
        outcome: "future",
        scheduledAt: null,
        nextAt: null,
        localDate: null,
        skippedCount: 0,
      };
    }
    if (now < at) {
      return {
        outcome: "future",
        scheduledAt: null,
        nextAt: new Date(at).toISOString(),
        localDate: null,
        skippedCount: 0,
      };
    }
    return {
      outcome: now - at <= schedule.misfireGraceMs ? "due" : "missed",
      scheduledAt: new Date(at).toISOString(),
      nextAt: null,
      localDate: null,
      skippedCount: 0,
    };
  }

  if (schedule.kind === "interval") {
    const anchor = canonicalTimestamp(schedule.anchorAt, "schedule.anchorAt");
    if (!Number.isSafeInteger(schedule.intervalMs) || schedule.intervalMs <= 0) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "intervalMs must be a positive safe integer",
      );
    }
    const first = last === null ? anchor : last + schedule.intervalMs;
    if (now < first) {
      return {
        outcome: "future",
        scheduledAt: null,
        nextAt: new Date(first).toISOString(),
        localDate: null,
        skippedCount: 0,
      };
    }
    const elapsed = Math.floor((now - first) / schedule.intervalMs);
    const latest = first + elapsed * schedule.intervalMs;
    const due = now - latest <= schedule.misfireGraceMs;
    return {
      outcome: due ? "due" : "skipped",
      scheduledAt: due ? new Date(latest).toISOString() : null,
      nextAt: new Date(latest + schedule.intervalMs).toISOString(),
      localDate: null,
      skippedCount: elapsed + (due ? 0 : 1),
    };
  }

  if (
    !Number.isSafeInteger(schedule.hour) ||
    schedule.hour < 0 ||
    schedule.hour > 23 ||
    !Number.isSafeInteger(schedule.minute) ||
    schedule.minute < 0 ||
    schedule.minute > 59
  ) {
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      "Daily schedule hour and minute are invalid",
    );
  }
  const start = Math.max((last ?? now - 4 * 86_400_000) + 1, now - 4 * 86_400_000);
  const lastLocalDate =
    last === null
      ? null
      : (dailyCandidates(schedule, last, last, null).at(0)?.localDate ??
        (() => {
          const formatter = new Intl.DateTimeFormat("en-CA", {
            timeZone: schedule.timeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          });
          const parts = formatter.formatToParts(new Date(last));
          return `${requiredDatePart(parts, "year")}-${requiredDatePart(parts, "month")}-${requiredDatePart(parts, "day")}`;
        })());
  const candidates = dailyCandidates(schedule, start, now + 4 * 86_400_000, lastLocalDate).filter(
    ({ at }) => last === null || at > last,
  );
  const elapsed = candidates.filter(({ at }) => at <= now);
  const future = candidates.find(({ at }) => at > now) ?? null;
  if (elapsed.length === 0) {
    return {
      outcome: "future",
      scheduledAt: null,
      nextAt: future ? new Date(future.at).toISOString() : null,
      localDate: null,
      skippedCount: 0,
    };
  }
  const latest = elapsed.at(-1);
  if (!latest) throw new Error("Daily schedule candidate disappeared");
  const due = now - latest.at <= schedule.misfireGraceMs;
  return {
    outcome: due ? "due" : "skipped",
    scheduledAt: due ? new Date(latest.at).toISOString() : null,
    nextAt: future ? new Date(future.at).toISOString() : null,
    localDate: due ? latest.localDate : null,
    skippedCount: elapsed.length - (due ? 1 : 0),
  };
}

function sameOccurrence(left: BackgroundOccurrence, right: BackgroundOccurrence): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class DurableBackgroundWorkService {
  private readonly dependencies: DurableBackgroundWorkServiceDependencies;

  constructor(dependencies: DurableBackgroundWorkServiceDependencies) {
    this.dependencies = dependencies;
  }

  async dispatch(input: DurableBackgroundDispatch): Promise<DurableBackgroundDispatchResult> {
    let occurrence: BackgroundOccurrence;
    try {
      occurrence = await this.dependencies.state.createOccurrence(input.occurrence);
    } catch (error) {
      const existing = await this.dependencies.state.readOccurrence(input.occurrence.id);
      if (!existing || !sameOccurrence(existing, input.occurrence)) throw error;
      occurrence = existing;
    }
    const admitted = await this.dependencies.triggers.ingest({
      ...input.trigger,
      idempotencyKey: `background:${occurrence.stableKey}`,
    });
    const reservation = await this.dependencies.state.reserveAdmission({
      occurrenceId: occurrence.id,
      expectedRevision: occurrence.revision,
      runId: input.runId,
      authority: occurrence.authority,
      limits: input.limits,
      admittedAt: input.trigger.occurredAt,
    });
    return {
      ...reservation,
      triggerResultRef: admitted.resultRef,
      replayed: admitted.replayed || reservation.outcome === "duplicate",
    };
  }

  claim(input: {
    readonly occurrenceId: OccurrenceId;
    readonly expectedRevision: number;
    readonly authority: ProductAuthorityFence;
    readonly leaseId: string;
    readonly holderId: string;
    readonly claimedAt: string;
    readonly expiresAt: string;
  }): Promise<BackgroundOccurrence> {
    return this.dependencies.state.claimOccurrence(input);
  }

  settle(input: BackgroundOccurrenceSettlement): Promise<BackgroundOccurrence> {
    return this.dependencies.state.settleOccurrence(input);
  }

  recover(ownerId: OwnerId, agentId: AgentId, now: string, limit = 100) {
    canonicalTimestamp(now, "now");
    return this.dependencies.state.listRecoverable(ownerId, agentId, now, limit);
  }
}

export function stableOccurrenceIdentity(jobId: JobId, providerIdentity: string): string {
  if (providerIdentity.length === 0 || providerIdentity.length > 256) {
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      "Provider occurrence identity must contain between 1 and 256 characters",
    );
  }
  return `${jobId}:${providerIdentity}`;
}
