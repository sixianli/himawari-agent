import type { MemoryTimeScope } from "@himawari-agent/application";

const DAY_MS = 86_400_000;
const DIGITS: Readonly<Record<string, number>> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};
const NUMBER = "[0-9]+|[零〇一二两三四五六七八九十]+";
const HISTORY =
  /以前|之前|原来|过去|曾经|当初|当时|那时|那会|从前|早先|以往|上一个|上一部|上一台|前一个|旧的|老的|换.{0,6}之前|before|used to|previous/iu;
const WEEKDAYS: Readonly<Record<string, number>> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 7,
  天: 7,
};

export interface ParsedTimeScope extends MemoryTimeScope {
  readonly matched: readonly string[];
}

function chineseNumber(text: string): number | null {
  if (/^[0-9]+$/u.test(text)) return Number(text);
  if (text === "十") return 10;
  const tens = text.indexOf("十");
  if (tens >= 0) {
    const high = tens === 0 ? 1 : DIGITS[text.slice(0, tens)];
    const low = tens === text.length - 1 ? 0 : DIGITS[text.slice(tens + 1)];
    return high === undefined || low === undefined ? null : high * 10 + low;
  }
  let value = 0;
  for (const character of text) {
    const digit = DIGITS[character];
    if (digit === undefined) return null;
    value = value * 10 + digit;
  }
  return value;
}

function localParts(instant: number, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      weekday: "short",
    })
      .formatToParts(new Date(instant))
      .map(({ type, value }) => [type, value]),
  );
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts["weekday"] ?? "");
  return {
    year: Number(parts["year"]),
    month: Number(parts["month"]),
    day: Number(parts["day"]),
    weekday: weekday + 1,
  };
}

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
  const local = Date.UTC(
    parts["year"] ?? 1970,
    (parts["month"] ?? 1) - 1,
    parts["day"] ?? 1,
    parts["hour"] ?? 0,
    parts["minute"] ?? 0,
    parts["second"] ?? 0,
  );
  return local - Math.floor(instant / 1000) * 1000;
}

function startOfLocalDay(year: number, month: number, day: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day);
  return guess - offsetMs(guess - offsetMs(guess, timeZone), timeZone);
}

function range(
  start: { year: number; month: number; day: number },
  days: number,
  timeZone: string,
): readonly [number, number] {
  const from = startOfLocalDay(start.year, start.month, start.day, timeZone);
  const endDate = new Date(Date.UTC(start.year, start.month - 1, start.day + days));
  const to = startOfLocalDay(
    endDate.getUTCFullYear(),
    endDate.getUTCMonth() + 1,
    endDate.getUTCDate(),
    timeZone,
  );
  return [from, to - 1];
}

function shiftDays(
  date: { year: number; month: number; day: number },
  days: number,
): { year: number; month: number; day: number } {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function monthRange(year: number, month: number, timeZone: string): readonly [number, number] {
  const normalized = new Date(Date.UTC(year, month - 1, 1));
  const days = new Date(
    Date.UTC(normalized.getUTCFullYear(), normalized.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return range(
    { year: normalized.getUTCFullYear(), month: normalized.getUTCMonth() + 1, day: 1 },
    days,
    timeZone,
  );
}

function yearRange(year: number, timeZone: string): readonly [number, number] {
  const from = startOfLocalDay(year, 1, 1, timeZone);
  const to = startOfLocalDay(year + 1, 1, 1, timeZone);
  return [from, to - 1];
}

export function parseTimeScope(
  query: string,
  now: string,
  timeZone = "UTC",
): ParsedTimeScope | null {
  const text = query.normalize("NFKC");
  const instant = Date.parse(now);
  if (!Number.isFinite(instant)) return null;
  const today = localParts(instant, timeZone);
  const matched: string[] = [];
  let window: readonly [number, number] | null = null;
  const take = (
    pattern: RegExp,
    resolve: (match: RegExpMatchArray) => readonly [number, number] | null,
  ) => {
    if (window) return;
    const match = text.match(pattern);
    if (!match) return;
    const resolved = resolve(match);
    if (!resolved) return;
    window = resolved;
    matched.push(match[0]);
  };
  take(
    new RegExp(`((?:19|20)[0-9]{2})\\s*年\\s*(${NUMBER})\\s*月\\s*(${NUMBER})\\s*[日号]`, "u"),
    (m) => {
      const month = chineseNumber(m[2] ?? "");
      const day = chineseNumber(m[3] ?? "");
      return month && day ? range({ year: Number(m[1]), month, day }, 1, timeZone) : null;
    },
  );
  take(new RegExp(`((?:19|20)[0-9]{2})\\s*年\\s*(${NUMBER})\\s*月`, "u"), (m) => {
    const month = chineseNumber(m[2] ?? "");
    return month && month <= 12 ? monthRange(Number(m[1]), month, timeZone) : null;
  });
  take(/((?:19|20)[0-9]{2})-([01]?[0-9])-([0-3]?[0-9])/u, (m) =>
    range({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }, 1, timeZone),
  );
  take(/((?:19|20)[0-9]{2})\s*年/u, (m) => yearRange(Number(m[1]), timeZone));
  take(
    new RegExp(`(去年|前年|今年|明年)\\s*(${NUMBER})\\s*月(?:\\s*(${NUMBER})\\s*[日号])?`, "u"),
    (m) => {
      const offset = { 前年: -2, 去年: -1, 今年: 0, 明年: 1 }[m[1] as "去年"];
      const month = chineseNumber(m[2] ?? "");
      if (!month || month > 12) return null;
      const day = m[3] ? chineseNumber(m[3]) : null;
      return day
        ? range({ year: today.year + offset, month, day }, 1, timeZone)
        : monthRange(today.year + offset, month, timeZone);
    },
  );
  take(
    new RegExp(
      `(?<![0-9零〇一二两三四五六七八九十个])(${NUMBER})\\s*月\\s*(${NUMBER})\\s*[日号]`,
      "u",
    ),
    (m) => {
      const month = chineseNumber(m[1] ?? "");
      const day = chineseNumber(m[2] ?? "");
      if (!month || !day || month > 12) return null;
      const candidate = range({ year: today.year, month, day }, 1, timeZone);
      return candidate[0] > instant + 7 * DAY_MS
        ? range({ year: today.year - 1, month, day }, 1, timeZone)
        : candidate;
    },
  );
  take(
    new RegExp(
      `(?<![0-9零〇一二两三四五六七八九十个上下这本])(${NUMBER})\\s*月(?!份?[0-9零〇一二两三四五六七八九十])`,
      "u",
    ),
    (m) => {
      const month = chineseNumber(m[1] ?? "");
      if (!month || month > 12) return null;
      return month > today.month + 1
        ? monthRange(today.year - 1, month, timeZone)
        : monthRange(today.year, month, timeZone);
    },
  );
  take(/前天/u, () => range(shiftDays(today, -2), 1, timeZone));
  take(/昨天|昨晚|昨日/u, () => range(shiftDays(today, -1), 1, timeZone));
  take(/今天|今晚|今早|今日/u, () => range(today, 1, timeZone));
  take(/明天|明晚|明早/u, () => range(shiftDays(today, 1), 1, timeZone));
  take(/后天/u, () => range(shiftDays(today, 2), 1, timeZone));
  take(new RegExp(`(${NUMBER})\\s*天(?:以前|之前|前)`, "u"), (m) => {
    const days = chineseNumber(m[1] ?? "");
    return days === null ? null : range(shiftDays(today, -days), 1, timeZone);
  });
  take(/(上上|上|这|本|下)\s*(?:个)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/u, (m) => {
    const weeks = { 上上: -2, 上: -1, 这: 0, 本: 0, 下: 1 }[m[1] as "上"];
    const weekday = WEEKDAYS[m[2] ?? ""] ?? 1;
    return range(shiftDays(today, weeks * 7 + weekday - today.weekday), 1, timeZone);
  });
  take(/(上上|上|这|本|下)\s*(?:个)?\s*(?:周|星期|礼拜)/u, (m) => {
    const weeks = { 上上: -2, 上: -1, 这: 0, 本: 0, 下: 1 }[m[1] as "上"];
    return range(shiftDays(today, weeks * 7 + 1 - today.weekday), 7, timeZone);
  });
  take(new RegExp(`(${NUMBER})\\s*(?:个)?\\s*(?:周|星期|礼拜)(?:以前|之前|前)`, "u"), (m) => {
    const weeks = chineseNumber(m[1] ?? "");
    return weeks === null
      ? null
      : range(shiftDays(today, -weeks * 7 + 1 - today.weekday), 7, timeZone);
  });
  take(/(上上|上|这|本|下)\s*(?:个)?\s*月/u, (m) => {
    const months = { 上上: -2, 上: -1, 这: 0, 本: 0, 下: 1 }[m[1] as "上"];
    return monthRange(today.year, today.month + months, timeZone);
  });
  take(new RegExp(`(${NUMBER})\\s*个\\s*月(?:以前|之前|前)`, "u"), (m) => {
    const months = chineseNumber(m[1] ?? "");
    return months === null ? null : monthRange(today.year, today.month - months, timeZone);
  });
  take(/前年/u, () => yearRange(today.year - 2, timeZone));
  take(/去年/u, () => yearRange(today.year - 1, timeZone));
  take(/今年/u, () => yearRange(today.year, timeZone));
  take(/明年/u, () => yearRange(today.year + 1, timeZone));
  take(/yesterday/iu, () => range(shiftDays(today, -1), 1, timeZone));
  take(/last week/iu, () => range(shiftDays(today, -6 - today.weekday), 7, timeZone));
  take(/last month/iu, () => monthRange(today.year, today.month - 1, timeZone));
  take(/last year/iu, () => yearRange(today.year - 1, timeZone));
  const history = HISTORY.exec(text);
  if (history) matched.push(history[0]);
  const resolved = window as readonly [number, number] | null;
  if (!resolved && !history) return null;
  return Object.freeze({
    includeHistory: history !== null || (resolved !== null && resolved[0] < instant),
    from: resolved ? new Date(resolved[0]).toISOString() : null,
    to: resolved ? new Date(resolved[1]).toISOString() : null,
    matched: Object.freeze(matched),
  });
}

export function localDayStart(day: string, timeZone = "UTC"): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(day);
  if (!match) return null;
  const instant = startOfLocalDay(Number(match[1]), Number(match[2]), Number(match[3]), timeZone);
  return Number.isFinite(instant) ? new Date(instant).toISOString() : null;
}
