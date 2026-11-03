import { addDays, DAY_MS, jstDate, jstDayStart } from "@himawari-agent/calibration";
import type {
  ObservationCheck,
  ObservationCheckItem,
  ObservationDayFacts,
  ObservationDayStatus,
  ObservationDayWindow,
  ObservationEvent,
  ObservationStart,
} from "../ports/ledger-observation.js";

export const OBSERVATION_DAYS = 7;
export const HOUR_MS = 60 * 60 * 1000;
export const CHECK_DELAY_MS = HOUR_MS;
export const STUCK_RUN_MS = 12 * HOUR_MS;
export const MAX_INTERVAL_MS = HOUR_MS;
export const GAP_SLACK_MS = 10 * 60 * 1000;
export const MAX_MISSING_HOURS = 1;

export type ObservationCellStatus = ObservationDayStatus | "no_check" | "upcoming";

export interface ProactiveSchedule {
  readonly configured: boolean;
  readonly intervalMs: number;
  readonly perCheckMs: number;
}

export function dayWindow(day: string): ObservationDayWindow {
  const start = jstDayStart(day);
  return {
    day,
    start: new Date(start).toISOString(),
    end: new Date(start + DAY_MS).toISOString(),
  };
}

export function jstToday(now: string): string {
  return jstDate(Date.parse(now));
}

export function earliestStartDay(firstBootAt: string): string {
  return addDays(jstToday(firstBootAt), 1);
}

interface SourceState {
  proactiveEnabled: boolean;
  sourceStatus: string;
  capturePaused: boolean;
}

function applyEvent(state: SourceState, event: ObservationEvent): SourceState {
  switch (event.kind) {
    case "state_snapshot":
      return {
        proactiveEnabled: event.detail["proactiveEnabled"] === true,
        sourceStatus: String(event.detail["sourceStatus"] ?? "disconnected"),
        capturePaused: event.detail["capturePaused"] === true,
      };
    case "proactive_enabled":
      return { ...state, proactiveEnabled: true };
    case "proactive_disabled":
      return { ...state, proactiveEnabled: false };
    case "source_connected":
      return { ...state, sourceStatus: "connected" };
    case "source_needs_reconnect":
      return { ...state, sourceStatus: "needs_reconnect" };
    case "source_disconnected":
      return { ...state, sourceStatus: "disconnected" };
    case "memory_capture_paused":
      return { ...state, capturePaused: true };
    case "memory_capture_resumed":
      return { ...state, capturePaused: false };
    default:
      return state;
  }
}

function item(
  code: string,
  status: ObservationCheckItem["status"],
  reason: string,
  facts: ObservationCheckItem["facts"] = {},
): ObservationCheckItem {
  return { code, status, reason, facts };
}

function serviceRunning(
  window: ObservationDayWindow,
  hours: readonly string[],
): ObservationCheckItem {
  const present = new Set(hours);
  const start = Date.parse(window.start);
  const missing: number[] = [];
  for (let index = 0; index < 24; index += 1)
    if (!present.has(new Date(start + index * HOUR_MS).toISOString())) missing.push(index);
  let longest = 0;
  let run = 0;
  for (let index = 0; index < 24; index += 1) {
    run = missing.includes(index) ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  const facts = { missingHours: missing.length, longestGapHours: longest };
  if (missing.length > MAX_MISSING_HOURS)
    return item("service_running", "fail", "hours_missing", facts);
  return item(
    "service_running",
    "pass",
    missing.length === 0 ? "all_hours" : "one_hour_missing",
    facts,
  );
}

function proactiveWriting(
  window: ObservationDayWindow,
  facts: ObservationDayFacts,
  schedule: ProactiveSchedule,
): ObservationCheckItem {
  if (!schedule.configured) return item("proactive_writing", "blocked", "not_configured");
  if (schedule.intervalMs > MAX_INTERVAL_MS)
    return item("proactive_writing", "blocked", "interval_too_long", {
      intervalMinutes: Math.round(schedule.intervalMs / 60_000),
    });
  let state: SourceState = {
    proactiveEnabled: facts.proactiveEnabled,
    sourceStatus: facts.sourceStatus,
    capturePaused: facts.capturePaused,
  };
  const before = facts.events.filter(({ occurredAt }) => occurredAt < window.start);
  const during = facts.events.filter(
    ({ occurredAt }) => occurredAt >= window.start && occurredAt < window.end,
  );
  if (before.length > 0 || during.length > 0) {
    state = { proactiveEnabled: false, sourceStatus: "disconnected", capturePaused: false };
    for (const event of before) state = applyEvent(state, event);
  }
  const offAt: string[] = [];
  if (!state.proactiveEnabled || state.sourceStatus !== "connected") offAt.push(window.start);
  for (const event of during) {
    state = applyEvent(state, event);
    if (!state.proactiveEnabled || state.sourceStatus !== "connected") offAt.push(event.occurredAt);
  }
  if (offAt.length > 0)
    return item(
      "proactive_writing",
      "blocked",
      state.proactiveEnabled ? "source_not_connected" : "switched_off",
      { since: offAt[0] ?? null, rows: facts.proactiveTimes.length },
    );
  const points = [
    Date.parse(window.start),
    ...facts.proactiveTimes.map((time) => Date.parse(time)),
    Date.parse(window.end),
  ];
  let longest = 0;
  for (let index = 1; index < points.length; index += 1)
    longest = Math.max(longest, (points[index] as number) - (points[index - 1] as number));
  const limit = 2 * Math.max(schedule.intervalMs, schedule.perCheckMs) + GAP_SLACK_MS;
  const details = {
    rows: facts.proactiveTimes.length,
    longestGapMinutes: Math.round(longest / 60_000),
    limitMinutes: Math.round(limit / 60_000),
  };
  return longest > limit
    ? item("proactive_writing", "fail", "gap_too_long", details)
    : item("proactive_writing", "pass", "on_time", details);
}

function consolidation(
  window: ObservationDayWindow,
  facts: ObservationDayFacts,
  now: string,
): ObservationCheckItem {
  const failedEvent = facts.events.find(
    (event) => event.kind === "consolidation_failed" && event.detail["day"] === window.day,
  );
  const failed = facts.consolidationRuns.find(({ status }) => status === "failed");
  if (failed || failedEvent)
    return item("consolidation_recorded", "fail", "run_failed", {
      errorCode: failedEvent ? (failedEvent.detail["errorCode"] ?? null) : null,
    });
  const running = facts.consolidationRuns.find(({ status }) => status === "running");
  if (running)
    return Date.parse(now) - Date.parse(running.startedAt) > STUCK_RUN_MS
      ? item("consolidation_recorded", "fail", "run_stuck", { startedAt: running.startedAt })
      : item("consolidation_recorded", "pending", "run_in_progress", {
          startedAt: running.startedAt,
        });
  const completed = facts.consolidationRuns.filter(({ status }) => status === "completed");
  if (completed.length === 0) return item("consolidation_recorded", "not_applicable", "no_run");
  const changes = completed.reduce((sum, run) => sum + run.changeCount, 0);
  const rows = completed.reduce((sum, run) => sum + run.ledgerRows, 0);
  return changes === rows
    ? item("consolidation_recorded", "pass", "rows_match", { changes, rows })
    : item("consolidation_recorded", "fail", "rows_mismatch", { changes, rows });
}

export interface EarlierDayCounts {
  readonly day: string;
  readonly checkedAt: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly now: Readonly<Record<string, number>>;
}

function rowsKept(
  earlier: readonly EarlierDayCounts[],
  events: readonly ObservationEvent[],
): ObservationCheckItem {
  let cleared = 0;
  for (const previous of earlier)
    for (const [kind, before] of Object.entries(previous.counts)) {
      const after = previous.now[kind] ?? 0;
      if (after >= before) continue;
      const explained =
        kind === "proactive" &&
        events.some(
          (event) =>
            event.kind === "proactive_records_cleared" && event.occurredAt > previous.checkedAt,
        );
      if (!explained)
        return item("rows_kept", "fail", "rows_missing", {
          day: previous.day,
          kind,
          before,
          after,
        });
      cleared += before - after;
    }
  return cleared > 0
    ? item("rows_kept", "pass", "cleared_by_owner", { clearedRows: cleared })
    : item("rows_kept", "pass", "nothing_missing", { checkedDays: earlier.length });
}

function timeFormat(facts: ObservationDayFacts): ObservationCheckItem {
  return facts.malformedTimes > 0
    ? item("time_format", "fail", "malformed", { rows: facts.malformedTimes })
    : item("time_format", "pass", "well_formed");
}

export function dayStatus(items: readonly ObservationCheckItem[]): ObservationDayStatus {
  if (items.some(({ status }) => status === "fail")) return "fail";
  if (items.some(({ status }) => status === "pending")) return "pending";
  if (items.some(({ status }) => status === "blocked")) return "blocked";
  return "pass";
}

export function evaluateObservationDay(input: {
  readonly window: ObservationDayWindow;
  readonly facts: ObservationDayFacts;
  readonly schedule: ProactiveSchedule;
  readonly earlier: readonly EarlierDayCounts[];
  readonly now: string;
}): {
  readonly status: ObservationDayStatus;
  readonly checks: readonly ObservationCheckItem[];
  readonly counts: Readonly<Record<string, number>>;
} {
  const checks = [
    serviceRunning(input.window, input.facts.heartbeatHours),
    proactiveWriting(input.window, input.facts, input.schedule),
    consolidation(input.window, input.facts, input.now),
    rowsKept(input.earlier, input.facts.events),
    timeFormat(input.facts),
  ];
  return { status: dayStatus(checks), checks, counts: input.facts.counts };
}

export function latestByDay(
  checks: readonly ObservationCheck[],
): ReadonlyMap<string, ObservationCheck> {
  const latest = new Map<string, ObservationCheck>();
  for (const check of checks) {
    const previous = latest.get(check.day);
    if (!previous || previous.checkedAt <= check.checkedAt) latest.set(check.day, check);
  }
  return latest;
}

export function daysDue(input: {
  readonly start: ObservationStart;
  readonly checks: readonly ObservationCheck[];
  readonly now: string;
}): readonly string[] {
  const latest = latestByDay(input.checks);
  const due: string[] = [];
  const nowMs = Date.parse(input.now);
  for (
    let day = input.start.startDay;
    jstDayStart(day) + DAY_MS + CHECK_DELAY_MS <= nowMs;
    day = addDays(day, 1)
  ) {
    const previous = latest.get(day);
    if (!previous || previous.status === "pending") due.push(day);
  }
  return due;
}

export interface ObservationCell {
  readonly day: string;
  readonly status: ObservationCellStatus;
  readonly check: ObservationCheck | null;
}

export interface ObservationSummary {
  readonly startDay: string;
  readonly firstReportDay: string;
  readonly cells: readonly ObservationCell[];
  readonly passStreak: number;
  readonly streakSince: string | null;
  readonly accepted: boolean;
}

export function summarizeObservation(input: {
  readonly start: ObservationStart;
  readonly checks: readonly ObservationCheck[];
  readonly now: string;
}): ObservationSummary {
  const latest = latestByDay(input.checks);
  const nowMs = Date.parse(input.now);
  const cellFor = (day: string): ObservationCell => {
    const check = latest.get(day) ?? null;
    if (check) return { day, status: check.status, check };
    const ended = jstDayStart(day) + DAY_MS + CHECK_DELAY_MS <= nowMs;
    return { day, status: ended ? "no_check" : "upcoming", check: null };
  };
  const cells = Array.from({ length: OBSERVATION_DAYS }, (_, index) =>
    cellFor(addDays(input.start.startDay, index)),
  );
  let streak = 0;
  let since: string | null = null;
  for (
    let day = input.start.startDay;
    jstDayStart(day) + DAY_MS + CHECK_DELAY_MS <= nowMs;
    day = addDays(day, 1)
  ) {
    const status = cellFor(day).status;
    if (status === "pass") {
      if (streak === 0) since = day;
      streak += 1;
    } else if (status !== "pending") {
      streak = 0;
      since = null;
    }
  }
  const firstReportDay = addDays(input.start.startDay, OBSERVATION_DAYS);
  return {
    startDay: input.start.startDay,
    firstReportDay,
    cells,
    passStreak: streak,
    streakSince: since,
    accepted: streak >= OBSERVATION_DAYS && nowMs >= jstDayStart(firstReportDay),
  };
}
