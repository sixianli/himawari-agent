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

  it("starts every daylight-saving switch day of 2026 at its first local moment, in every time zone", () => {
    const dateIn = (timeZone: string) => {
      const format = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      return (instant: number) => format.format(new Date(instant));
    };
    const offsetIn = (timeZone: string) => {
      const format = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" });
      return (instant: number) =>
        format.formatToParts(new Date(instant)).find(({ type }) => type === "timeZoneName")?.value;
    };
    const wrong: string[] = [];
    let switchDays = 0;
    for (const timeZone of Intl.supportedValuesOf("timeZone")) {
      const offset = offsetIn(timeZone);
      const months = Array.from({ length: 13 }, (_, month) => offset(Date.UTC(2026, month, 1)));
      if (months.every((value) => value === months[0])) continue;
      const date = dateIn(timeZone);
      for (let noon = Date.UTC(2026, 0, 1, 12); noon < Date.UTC(2027, 0, 1); noon += 86_400_000) {
        if (offset(noon - 86_400_000) === offset(noon + 86_400_000)) continue;
        for (const shift of [-1, 0, 1]) {
          const day = new Date(noon + shift * 86_400_000).toISOString().slice(0, 10);
          switchDays += 1;
          const start = Date.parse(localDayStart(day, timeZone) ?? "");
          if (date(start) !== day || date(start - 1) === day) wrong.push(`${timeZone} ${day}`);
        }
      }
    }
    expect(switchDays).toBeGreaterThan(300);
    expect(wrong).toEqual([]);
  }, 60_000);

  it("finds the start of a local day and refuses impossible days", () => {
    expect(localDayStart("2026-10-25", "Asia/Tokyo")).toBe("2026-10-24T15:00:00.000Z");
    expect(localDayStart("2028-02-29", "UTC")).toBe("2028-02-29T00:00:00.000Z");
    expect(localDayStart("2026-02-29", "UTC")).toBeNull();
    expect(localDayStart("2026-09-06", "America/Santiago")).toBe("2026-09-06T04:00:00.000Z");
    expect(localDayStart("2026-04-05", "America/Santiago")).toBe("2026-04-05T04:00:00.000Z");
    expect(localDayStart("2026-03-29", "Asia/Beirut")).toBe("2026-03-28T22:00:00.000Z");
    expect(localDayStart("2026-03-08", "America/New_York")).toBe("2026-03-08T05:00:00.000Z");
    expect(localDayStart("2026-13-01", "UTC")).toBeNull();
    expect(localDayStart("0099-01-01", "UTC")).toBe("0099-01-01T00:00:00.000Z");
    expect(localDayStart("0099-02-29", "UTC")).toBeNull();
  });
});
