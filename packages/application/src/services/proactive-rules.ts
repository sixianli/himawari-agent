import type {
  ProactiveConfidence,
  ProactiveQuietPeriod,
  ProactiveResult,
  ProactiveSourceItem,
} from "../ports/proactive-checks.js";

export const PROACTIVE_PUBLIC_DOMAIN_SUFFIXES = Object.freeze(["go.jp", "lg.jp", "ac.jp", "ed.jp"]);

const MONEY_WORDS =
  /收费|扣款|入账|付款|退款|账单|缴费|汇款|转账|还款|发票|請求|引落|引き落とし|振込|振り込み|入金|返金|支払|料金|決済|ご利用代金|\b(?:invoice|payment|refund|billing|bill|charged?|receipt|statement)\b/iu;

export function senderDomain(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

export function isImportantSender(address: string, senders: readonly string[]): boolean {
  const lower = address.toLowerCase();
  const domain = senderDomain(lower);
  return senders.some((entry) => {
    const wanted = entry.trim().toLowerCase().replace(/^@/u, "");
    if (!wanted) return false;
    if (wanted.includes("@")) return lower === wanted;
    return domain === wanted || domain.endsWith(`.${wanted}`);
  });
}

export function hitsFloor(item: ProactiveSourceItem, senders: readonly string[]): boolean {
  const domain = senderDomain(item.fromAddress);
  return (
    isImportantSender(item.fromAddress, senders) ||
    PROACTIVE_PUBLIC_DOMAIN_SUFFIXES.some(
      (suffix) => domain === suffix || domain.endsWith(`.${suffix}`),
    ) ||
    MONEY_WORDS.test(`${item.subject}\n${item.snippet}`)
  );
}

export function applyFloor(
  result: ProactiveResult,
  confidence: ProactiveConfidence,
  floor: boolean,
): { readonly result: ProactiveResult; readonly raised: boolean } {
  if (!floor || result === "act") return { result, raised: false };
  if (confidence === "unsure" || result === "check")
    return { result: "check", raised: result !== "check" };
  if (result === "ignore") return { result: "know", raised: true };
  return { result, raised: false };
}

interface ZonedParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly weekday: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function zonedParts(at: string, timeZone: string): ZonedParts {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
      hourCycle: "h23",
    })
      .formatToParts(new Date(at))
      .map(({ type, value }) => [type, value]),
  );
  return {
    year: Number(parts["year"]),
    month: Number(parts["month"]),
    day: Number(parts["day"]),
    hour: Number(parts["hour"]),
    minute: Number(parts["minute"]),
    weekday: WEEKDAYS[parts["weekday"] ?? ""] ?? 0,
  };
}

export function zonedTime(
  date: { readonly year: number; readonly month: number; readonly day: number },
  minutes: number,
  timeZone: string,
): string {
  const wall = Date.UTC(date.year, date.month - 1, date.day, 0, minutes);
  let guess = wall;
  for (let step = 0; step < 3; step++) {
    const local = zonedParts(new Date(guess).toISOString(), timeZone);
    const shown = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
    guess += wall - shown;
  }
  return new Date(guess).toISOString();
}

export function startOfZonedDay(at: string, timeZone: string): string {
  return zonedTime(zonedParts(at, timeZone), 0, timeZone);
}

function clockMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

function shiftDays(
  date: { readonly year: number; readonly month: number; readonly day: number },
  days: number,
) {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

export function quietUntil(
  at: string,
  periods: readonly ProactiveQuietPeriod[],
  timeZone: string,
): string | null {
  let latest: string | null = null;
  let cursor = at;
  for (let hop = 0; hop < 8; hop++) {
    const local = zonedParts(cursor, timeZone);
    const now = local.hour * 60 + local.minute;
    let end: string | null = null;
    for (const period of periods) {
      const start = clockMinutes(period.start);
      const stop = clockMinutes(period.end);
      const today = period.days.includes(local.weekday);
      const yesterday = period.days.includes((local.weekday + 6) % 7);
      let candidate: string | null = null;
      if (start < stop && today && now >= start && now < stop)
        candidate = zonedTime(local, stop, timeZone);
      else if (start > stop && today && now >= start)
        candidate = zonedTime(shiftDays(local, 1), stop, timeZone);
      else if (start > stop && yesterday && now < stop)
        candidate = zonedTime(local, stop, timeZone);
      if (candidate && (end === null || candidate > end)) end = candidate;
    }
    if (end === null || end <= cursor) break;
    latest = end;
    cursor = end;
  }
  return latest;
}
