import { evaluateDurableSchedule, stableOccurrenceIdentity } from "@himawari-agent/application";
import { createJobId } from "@himawari-agent/domain";
import { describe, expect, it } from "vitest";

describe("durable background schedule evaluation", () => {
  it("coalesces old interval occurrences and skips periodic misfires outside grace", () => {
    expect(
      evaluateDurableSchedule(
        {
          kind: "interval",
          anchorAt: "2026-08-27T00:00:00.000Z",
          intervalMs: 60_000,
          misfireGraceMs: 5_000,
        },
        { now: "2026-08-27T00:10:30.000Z", lastScheduledAt: null },
      ),
    ).toEqual({
      outcome: "skipped",
      scheduledAt: null,
      nextAt: "2026-08-27T00:11:00.000Z",
      localDate: null,
      skippedCount: 11,
    });
  });

  it("marks a late one-shot occurrence MISSED instead of replaying it", () => {
    expect(
      evaluateDurableSchedule(
        {
          kind: "one_shot",
          at: "2026-08-27T00:00:00.000Z",
          misfireGraceMs: 5_000,
        },
        { now: "2026-08-27T00:00:06.000Z", lastScheduledAt: null },
      ),
    ).toMatchObject({ outcome: "missed", nextAt: null });
  });

  it("skips a nonexistent DST wall time in an IANA timezone", () => {
    expect(
      evaluateDurableSchedule(
        {
          kind: "daily",
          timeZone: "America/New_York",
          hour: 2,
          minute: 30,
          misfireGraceMs: 3_600_000,
        },
        {
          now: "2026-03-08T08:00:00.000Z",
          lastScheduledAt: "2026-03-07T07:30:00.000Z",
        },
      ),
    ).toEqual({
      outcome: "future",
      scheduledAt: null,
      nextAt: "2026-03-09T06:30:00.000Z",
      localDate: null,
      skippedCount: 0,
    });
  });

  it("executes a repeated DST wall time only once", () => {
    const schedule = {
      kind: "daily" as const,
      timeZone: "America/New_York",
      hour: 1,
      minute: 30,
      misfireGraceMs: 7_200_000,
    };
    const first = evaluateDurableSchedule(schedule, {
      now: "2026-11-01T07:00:00.000Z",
      lastScheduledAt: "2026-10-31T05:30:00.000Z",
    });
    expect(first).toMatchObject({
      outcome: "due",
      scheduledAt: "2026-11-01T05:30:00.000Z",
      localDate: "2026-11-01",
    });
    expect(
      evaluateDurableSchedule(schedule, {
        now: "2026-11-01T07:00:00.000Z",
        lastScheduledAt: first.scheduledAt,
      }),
    ).toMatchObject({
      outcome: "future",
      nextAt: "2026-11-02T06:30:00.000Z",
    });
  });

  it("derives stable occurrence identities from the job and provider identity", () => {
    expect(stableOccurrenceIdentity(createJobId("job-monitor"), "delivery-42")).toBe(
      "job-monitor:delivery-42",
    );
  });
});
