import { describe, expect, it } from "vitest";
import { localDayStart, requestedTimeScope } from "../src/time-scope.ts";

describe("[T6] time scope the model asked for", () => {
  it("turns the model's local dates into a whole-day window in the owner's time zone", () => {
    expect(
      requestedTimeScope(
        { from: "2026-09-10", to: "2026-09-20", includeHistory: false },
        "Asia/Tokyo",
      ),
    ).toEqual({
      includeHistory: true,
      from: "2026-09-09T15:00:00.000Z",
      to: "2026-09-20T14:59:59.999Z",
    });
    expect(requestedTimeScope({ from: "2026-10-23", includeHistory: false }, "Asia/Tokyo")).toEqual(
      {
        includeHistory: true,
        from: "2026-10-22T15:00:00.000Z",
        to: "2026-10-23T14:59:59.999Z",
      },
    );
  });

  it("does not guess a window when the model gave no dates", () => {
    expect(requestedTimeScope({ includeHistory: true }, "Asia/Tokyo")).toEqual({
      includeHistory: true,
      from: null,
      to: null,
    });
    expect(requestedTimeScope({ includeHistory: false }, "Asia/Tokyo")).toEqual({
      includeHistory: false,
      from: null,
      to: null,
    });
  });

  it.each([
    [{ from: "2026-13-40" }],
    [{ from: "2026-02-30", to: "2026-03-02" }],
    [{ to: "2026-04-31" }],
    [{ from: "2026-10-20", to: "2026-10-10" }],
  ])(
    "refuses a date that is not on the calendar or a window that ends before it starts: %j",
    (dates) => {
      expect(() => requestedTimeScope({ ...dates, includeHistory: false }, "Asia/Tokyo")).toThrow(
        "MEMORY_TIME_SCOPE_INVALID",
      );
    },
  );

  it("finds the start of a local day and refuses impossible days", () => {
    expect(localDayStart("2026-10-25", "Asia/Tokyo")).toBe("2026-10-24T15:00:00.000Z");
    expect(localDayStart("2028-02-29", "UTC")).toBe("2028-02-29T00:00:00.000Z");
    expect(localDayStart("2026-02-29", "UTC")).toBeNull();
    expect(localDayStart("2026-13-01", "UTC")).toBeNull();
  });
});
