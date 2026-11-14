import type { MailAmount, MoneyState } from "../rules/amount.js";
import { RULE_IDS, type RuleRecord } from "../rules/rule-book.js";
import { mailItemFacts } from "../rules/rule-book.js";
import { RuleJudge } from "../rules/rule-judge.js";
import { ruleRef } from "../rules/rule-ref.js";
import type {
  ProactiveConfidence,
  ProactivePriority,
  ProactiveQuietPeriod,
  ProactiveResult,
} from "../ports/proactive-checks.js";
import type { ProactiveMail } from "../ports/proactive-sources.js";

const JUDGE = new RuleJudge();

export function senderDomain(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

export const FLOOR_RULE_IDS = Object.freeze({
  importantSender: RULE_IDS.importantSender,
  publicDomain: RULE_IDS.publicDomain,
  moneyWords: RULE_IDS.moneyWords,
} as const);

export type FloorRuleId = (typeof FLOOR_RULE_IDS)[keyof typeof FLOOR_RULE_IDS];

export function floorHitIds(
  item: ProactiveMail,
  rules: readonly RuleRecord[],
  money: MoneyState = "unknown",
): readonly FloorRuleId[] {
  return JUDGE.decide("mail_item", mailItemFacts(item, undefined, money), rules)
    .hits.filter(({ outcome }) => outcome === "raise_floor")
    .map(({ id }) => id as FloorRuleId);
}

function outcomeHits(
  item: ProactiveMail,
  rules: readonly RuleRecord[],
  wanted: "require_notify" | "require_whole_thread",
): readonly string[] {
  const hits = JUDGE.decide("mail_item", mailItemFacts(item), rules)
    .hits.filter(({ outcome }) => outcome === wanted)
    .map(({ id, revision }) => ruleRef(id, revision));
  return [...new Set(hits)].sort().slice(0, 16);
}

export function wholeThreadHitIds(
  item: ProactiveMail,
  rules: readonly RuleRecord[],
): readonly string[] {
  return outcomeHits(item, rules, "require_whole_thread");
}

export function mustNotifyHitIds(
  item: ProactiveMail,
  rules: readonly RuleRecord[],
): readonly string[] {
  return outcomeHits(item, rules, "require_notify");
}

export function suppressPushHits(
  item: ProactiveMail,
  amount: MailAmount,
  rules: readonly RuleRecord[],
): readonly string[] {
  const hits = JUDGE.decide("mail_item", mailItemFacts(item, amount), rules)
    .hits.filter(({ outcome }) => outcome === "suppress_push")
    .map(({ id, revision }) => ruleRef(id, revision));
  return [...new Set(hits)].sort().slice(0, 16);
}

export function quietHitRefs(
  at: string,
  rules: readonly RuleRecord[],
  timeZone: string,
): readonly string[] {
  const local = zonedParts(at, timeZone);
  const decision = JUDGE.decide(
    "mail_delivery",
    {
      local_minutes: local.hour * 60 + local.minute,
      local_weekday: local.weekday,
      local_previous_weekday: (local.weekday + 6) % 7,
    },
    rules,
  );
  return decision.hits
    .filter(({ outcome }) => outcome === "defer_to_quiet_hours")
    .map(({ id, revision }) => ruleRef(id, revision));
}

export function quietEnd(
  at: string,
  rules: readonly RuleRecord[],
  periods: readonly ProactiveQuietPeriod[],
  timeZone: string,
): string | null {
  if (quietHitRefs(at, rules, timeZone).length === 0) return null;
  return quietUntil(at, periods, timeZone);
}

export function floorHitRefs(
  floorHits: Readonly<Record<string, readonly string[]>>,
  rules: readonly RuleRecord[],
): readonly string[] {
  const refs = new Set<string>();
  for (const id of new Set(Object.values(floorHits).flat())) {
    const rule = rules.find(
      (candidate) => candidate.id === id && candidate.outcome === "raise_floor",
    );
    refs.add(rule ? ruleRef(rule.id, rule.revision) : id);
  }
  return [...refs];
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

export function isReminderWorthy(
  result: ProactiveResult,
  priority: ProactivePriority | null,
  floor: boolean,
): boolean {
  if (result === "act") return priority !== "low" || floor;
  if (result === "check") return true;
  if (result === "know") return floor;
  return false;
}

export function keepOffReminderPage(
  result: ProactiveResult,
  priority: ProactivePriority | null,
  floor: boolean,
  confidence: ProactiveConfidence,
): { readonly result: ProactiveResult; readonly demoted: boolean } {
  const lowAct = result === "act" && priority === "low";
  if (!lowAct && isReminderWorthy(result, priority, floor)) return { result, demoted: false };
  if (result === "ignore") return { result, demoted: false };
  if (!floor) return { result: "ignore", demoted: true };
  return { result: confidence === "unsure" ? "check" : "know", demoted: true };
}

export function fromAddressOf(from: string): string {
  const match = /<([^<>]+)>/u.exec(from);
  return (match?.[1] ?? from).trim();
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

const ZONED_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  const known = ZONED_FORMATTERS.get(timeZone);
  if (known) return known;
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hourCycle: "h23",
  });
  if (ZONED_FORMATTERS.size < 64) ZONED_FORMATTERS.set(timeZone, created);
  return created;
}

export function zonedParts(at: string, timeZone: string): ZonedParts {
  const parts = Object.fromEntries(
    zonedFormatter(timeZone)
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

export function startOfNextZonedDay(at: string, timeZone: string): string {
  return zonedTime(shiftDays(zonedParts(at, timeZone), 1), 0, timeZone);
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
