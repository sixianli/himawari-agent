import type { MemoryTimeScope } from "@himawari-agent/application";

const DAY_MS = 86_400_000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

function offsetMs(instant: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
      .formatToParts(new Date(instant))
      .map(({ type, value }) => [type, Number(value)]),
  );
  const local = new Date(0);
  local.setUTCFullYear(parts["year"] ?? 1970, (parts["month"] ?? 1) - 1, parts["day"] ?? 1);
  local.setUTCHours(parts["hour"] ?? 0, parts["minute"] ?? 0, parts["second"] ?? 0);
  return local.getTime() - Math.floor(instant / 1000) * 1000;
}

function calendarDay(day: string): number | null {
  const match = DATE.exec(day);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const parsed = new Date(0);
  parsed.setUTCFullYear(year, month - 1, date);
  const instant = parsed.getTime();
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === date
    ? instant
    : null;
}

function localDate(instant: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));
}

function startOfLocalDay(utcMidnight: number, timeZone: string): number {
  const before = utcMidnight - offsetMs(utcMidnight, timeZone);
  const after = utcMidnight - offsetMs(before, timeZone);
  const day = new Date(utcMidnight).toISOString().slice(0, 10);
  const onTheDay = [before, after].filter((instant) => localDate(instant, timeZone) === day);
  return onTheDay.length > 0 ? Math.min(...onTheDay) : after;
}

export function localDayStart(day: string, timeZone = "UTC"): string | null {
  const instant = calendarDay(day);
  return instant === null ? null : new Date(startOfLocalDay(instant, timeZone)).toISOString();
}

export function requestedTimeScope(
  input: {
    readonly from?: string | undefined;
    readonly to?: string | undefined;
    readonly includeHistory: boolean;
  },
  timeZone: string,
): MemoryTimeScope {
  if (input.from === undefined && input.to === undefined)
    return Object.freeze({ includeHistory: input.includeHistory, from: null, to: null });
  const from = calendarDay(input.from ?? input.to ?? "");
  const to = calendarDay(input.to ?? input.from ?? "");
  if (from === null || to === null || from > to) throw new RangeError("MEMORY_TIME_SCOPE_INVALID");
  return Object.freeze({
    includeHistory: true,
    from: new Date(startOfLocalDay(from, timeZone)).toISOString(),
    to: new Date(startOfLocalDay(to + DAY_MS, timeZone) - 1).toISOString(),
  });
}
