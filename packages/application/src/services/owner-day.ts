import { startOfZonedDay } from "./proactive-rules.js";

const NEXT_DAY_PROBE_MS = 30 * 3_600_000;

export function ownerLocalDay(at: string | number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(at));
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")}`;
}

export interface OwnerDayBounds {
  readonly day: string;
  readonly start: string;
  readonly end: string;
}

export function ownerDayBounds(at: string, timeZone: string): OwnerDayBounds {
  const start = startOfZonedDay(at, timeZone);
  const end = startOfZonedDay(
    new Date(Date.parse(start) + NEXT_DAY_PROBE_MS).toISOString(),
    timeZone,
  );
  return Object.freeze({ day: ownerLocalDay(start, timeZone), start, end });
}
