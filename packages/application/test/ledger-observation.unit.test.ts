import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import { describe, expect, it } from "vitest";
import type {
  ObservationCheck,
  ObservationDayFacts,
  ObservationEvent,
  ObservationStart,
} from "../src/ports/ledger-observation.js";
import {
  daysDue,
  dayWindow,
  earliestStartDay,
  evaluateObservationDay,
  type ProactiveSchedule,
  summarizeObservation,
} from "../src/services/ledger-observation.js";

const scope = { ownerId: createOwnerId("owner-o"), agentId: createAgentId("agent-o") };
const DAY = "2026-11-06";
const WINDOW = dayWindow(DAY);
const AFTER = "2026-11-06T16:30:00.000Z";
const SCHEDULE: ProactiveSchedule = { configured: true, intervalMs: 900_000, perCheckMs: 300_000 };

function hours(skip: readonly number[] = []): string[] {
  const start = Date.parse(WINDOW.start);
  return Array.from({ length: 24 }, (_, index) => index)
    .filter((index) => !skip.includes(index))
    .map((index) => new Date(start + index * 3_600_000).toISOString());
}

function everyQuarter(from = 0, to = 96): string[] {
  const start = Date.parse(WINDOW.start);
  return Array.from({ length: to - from }, (_, index) =>
    new Date(start + (from + index) * 900_000 + 60_000).toISOString(),
  );
}

function event(
  kind: ObservationEvent["kind"],
  occurredAt: string,
  detail: ObservationEvent["detail"] = {},
): ObservationEvent {
  return { id: `${kind}-${occurredAt}`, ...scope, kind, occurredAt, detail };
}

const SNAPSHOT = event("state_snapshot", "2026-11-04T00:00:00.000Z", {
  proactiveEnabled: true,
  sourceStatus: "connected",
  capturePaused: false,
});

function facts(overrides: Partial<ObservationDayFacts> = {}): ObservationDayFacts {
  return {
    heartbeatHours: hours(),
    proactiveTimes: everyQuarter(),
    counts: { proactive: 96 },
    malformedTimes: 0,
    consolidationRuns: [],
    events: [SNAPSHOT],
    proactiveEnabled: true,
    sourceStatus: "connected",
    capturePaused: false,
    ...overrides,
  };
}

function evaluate(
  overrides: Partial<ObservationDayFacts> = {},
  options: Partial<Parameters<typeof evaluateObservationDay>[0]> = {},
) {
  return evaluateObservationDay({
    window: WINDOW,
    facts: facts(overrides),
    schedule: SCHEDULE,
    earlier: [],
    now: AFTER,
    ...options,
  });
}

const byCode = (result: ReturnType<typeof evaluate>, code: string) =>
  result.checks.find((item) => item.code === code);

describe("[P0-8] daily decision record check", () => {
  it("passes a normal day with every hour seen and Gmail checks on time", () => {
    const result = evaluate();
    expect(result.status).toBe("pass");
    expect(result.checks.map(({ code, status }) => [code, status])).toEqual([
      ["service_running", "pass"],
      ["proactive_writing", "pass"],
      ["consolidation_recorded", "not_applicable"],
      ["rows_kept", "pass"],
      ["time_format", "pass"],
    ]);
  });

  it("fails when the service was not running for three hours", () => {
    const result = evaluate({
      heartbeatHours: hours([2, 3, 4]),
      proactiveTimes: [...everyQuarter(0, 8), ...everyQuarter(20)],
    });
    expect(result.status).toBe("fail");
    expect(byCode(result, "service_running")).toMatchObject({
      status: "fail",
      reason: "hours_missing",
      facts: { missingHours: 3, longestGapHours: 3 },
    });
    expect(byCode(result, "proactive_writing")).toMatchObject({
      status: "fail",
      reason: "gap_too_long",
    });
  });

  it("allows one missing hour for a restart", () => {
    expect(byCode(evaluate({ heartbeatHours: hours([5]) }), "service_running")).toMatchObject({
      status: "pass",
      reason: "one_hour_missing",
    });
  });

  it("marks the day blocked, not passed, when Gmail was switched off during the day", () => {
    const result = evaluate({
      proactiveTimes: everyQuarter(0, 40),
      events: [SNAPSHOT, event("proactive_disabled", "2026-11-06T01:00:00.000Z")],
      proactiveEnabled: false,
    });
    expect(result.status).toBe("blocked");
    expect(byCode(result, "proactive_writing")).toMatchObject({
      status: "blocked",
      reason: "switched_off",
      facts: { since: "2026-11-06T01:00:00.000Z" },
    });
  });

  it("marks the day blocked when Gmail needs reconnecting and when proactive is not configured", () => {
    expect(
      byCode(
        evaluate({
          proactiveTimes: [],
          events: [SNAPSHOT, event("source_needs_reconnect", "2026-11-05T10:00:00.000Z")],
        }),
        "proactive_writing",
      ),
    ).toMatchObject({ status: "blocked", reason: "source_not_connected" });
    expect(
      byCode(evaluate({}, { schedule: { ...SCHEDULE, configured: false } }), "proactive_writing"),
    ).toMatchObject({ status: "blocked", reason: "not_configured" });
  });

  it("fails when the tidy-up changed three memories but only two decision records were written", () => {
    const result = evaluate({
      consolidationRuns: [
        {
          id: "run-1",
          day: DAY,
          status: "completed",
          changeCount: 3,
          startedAt: "2026-11-06T02:00:00.000Z",
          ledgerRows: 2,
        },
      ],
    });
    expect(byCode(result, "consolidation_recorded")).toMatchObject({
      status: "fail",
      reason: "rows_mismatch",
      facts: { changes: 3, rows: 2 },
    });
  });

  it("fails on a tidy-up that failed without leaving a run row", () => {
    const result = evaluate({
      events: [
        SNAPSHOT,
        event("consolidation_failed", "2026-11-06T03:00:00.000Z", {
          day: DAY,
          errorCode: "MODEL_TIMEOUT",
          runId: "run-1",
        }),
      ],
    });
    expect(byCode(result, "consolidation_recorded")).toMatchObject({
      status: "fail",
      reason: "run_failed",
      facts: { errorCode: "MODEL_TIMEOUT" },
    });
  });

  it("waits for a tidy-up still running after midnight and fails one stuck for more than 12 hours", () => {
    const running = {
      id: "run-1",
      day: DAY,
      status: "running" as const,
      changeCount: 0,
      startedAt: "2026-11-06T14:50:00.000Z",
      ledgerRows: 0,
    };
    const waiting = evaluate({ consolidationRuns: [running] });
    expect(waiting.status).toBe("pending");
    expect(byCode(waiting, "consolidation_recorded")?.reason).toBe("run_in_progress");
    const stuck = evaluate({ consolidationRuns: [running] }, { now: "2026-11-07T03:00:00.000Z" });
    expect(byCode(stuck, "consolidation_recorded")).toMatchObject({
      status: "fail",
      reason: "run_stuck",
    });
  });

  it("fails when rows of an earlier checked day disappeared without a clear action", () => {
    const earlier = [
      {
        day: "2026-11-05",
        checkedAt: "2026-11-05T16:30:00.000Z",
        counts: { proactive: 96, memory_candidate: 4 },
        now: { proactive: 96, memory_candidate: 1 },
      },
    ];
    expect(byCode(evaluate({}, { earlier }), "rows_kept")).toMatchObject({
      status: "fail",
      reason: "rows_missing",
      facts: { day: "2026-11-05", kind: "memory_candidate", before: 4, after: 1 },
    });
  });

  it("accepts fewer Gmail rows on an earlier day when the owner cleared Gmail records afterwards", () => {
    const earlier = [
      {
        day: "2026-11-05",
        checkedAt: "2026-11-05T16:30:00.000Z",
        counts: { proactive: 96 },
        now: {},
      },
    ];
    const cleared = evaluate(
      {
        events: [
          SNAPSHOT,
          event("proactive_records_cleared", "2026-11-06T05:00:00.000Z", { rows: 120 }),
        ],
      },
      { earlier },
    );
    expect(byCode(cleared, "rows_kept")).toMatchObject({
      status: "pass",
      reason: "cleared_by_owner",
      facts: { clearedRows: 96 },
    });
    const clearedBefore = evaluate(
      {
        events: [
          SNAPSHOT,
          event("proactive_records_cleared", "2026-11-05T05:00:00.000Z", { rows: 10 }),
        ],
      },
      { earlier },
    );
    expect(byCode(clearedBefore, "rows_kept")?.status).toBe("fail");
  });

  it("fails on decision record times in the wrong format", () => {
    expect(byCode(evaluate({ malformedTimes: 2 }), "time_format")?.status).toBe("fail");
  });
});

describe("[P0-8] observation schedule and summary", () => {
  const start: ObservationStart = {
    ...scope,
    startDay: "2026-11-06",
    setAt: "2026-11-05T03:00:00.000Z",
    serviceRevision: "41a6ce3",
    firstBootAt: "2026-11-05T01:00:00.000Z",
  };
  const check = (day: string, status: ObservationCheck["status"], checkedAt?: string) =>
    ({
      id: `check-${day}-${status}`,
      ...scope,
      day,
      checkedAt: checkedAt ?? dayWindow(day).end.replace(":00:00.000Z", ":30:00.000Z"),
      serviceRevision: "41a6ce3",
      status,
      checks: [],
      counts: {},
    }) satisfies ObservationCheck;

  it("picks the earliest start day as the day after the new version first started", () => {
    expect(earliestStartDay("2026-11-05T01:00:00.000Z")).toBe("2026-11-06");
    expect(earliestStartDay("2026-11-05T14:59:59.999Z")).toBe("2026-11-06");
    expect(earliestStartDay("2026-11-05T15:00:00.000Z")).toBe("2026-11-07");
  });

  it("checks a day only after it ended plus an hour, and rechecks pending days", () => {
    expect(daysDue({ start, checks: [], now: "2026-11-06T15:59:59.000Z" })).toEqual([]);
    expect(daysDue({ start, checks: [], now: "2026-11-06T16:00:00.000Z" })).toEqual(["2026-11-06"]);
    expect(
      daysDue({
        start,
        checks: [check("2026-11-06", "pass"), check("2026-11-07", "pending")],
        now: "2026-11-08T17:00:00.000Z",
      }),
    ).toEqual(["2026-11-07", "2026-11-08"]);
  });

  it("shows no check for an ended day without a result and counts a pass streak that restarts after a failure", () => {
    const checks = [
      check("2026-11-06", "pass"),
      check("2026-11-07", "pass"),
      check("2026-11-08", "fail"),
      check("2026-11-09", "pass"),
      check("2026-11-11", "pass"),
    ];
    const summary = summarizeObservation({ start, checks, now: "2026-11-12T03:00:00.000Z" });
    expect(summary.cells.map(({ day, status }) => [day, status])).toEqual([
      ["2026-11-06", "pass"],
      ["2026-11-07", "pass"],
      ["2026-11-08", "fail"],
      ["2026-11-09", "pass"],
      ["2026-11-10", "no_check"],
      ["2026-11-11", "pass"],
      ["2026-11-12", "upcoming"],
    ]);
    expect(summary).toMatchObject({
      firstReportDay: "2026-11-13",
      passStreak: 1,
      streakSince: "2026-11-11",
      accepted: false,
    });
  });

  it("is accepted only after seven passing days in a row and the first report day", () => {
    const days = ["06", "07", "08", "09", "10", "11", "12"].map((d) =>
      check(`2026-11-${d}`, "pass"),
    );
    expect(
      summarizeObservation({ start, checks: days, now: "2026-11-13T03:00:00.000Z" }),
    ).toMatchObject({ passStreak: 7, streakSince: "2026-11-06", accepted: true });
    expect(
      summarizeObservation({
        start,
        checks: [...days.slice(0, 6), check("2026-11-12", "blocked")],
        now: "2026-11-13T03:00:00.000Z",
      }),
    ).toMatchObject({ passStreak: 0, accepted: false });
  });
});
