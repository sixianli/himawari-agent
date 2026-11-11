import type { MailAmount } from "../rules/amount.js";
import { RULE_IDS, type RuleRecord } from "../rules/rule-book.js";
import { mailItemFacts } from "../rules/rule-book.js";
import { RuleJudge } from "../rules/rule-judge.js";
import type {
  ProactiveConfidence,
  ProactivePriority,
  ProactiveQuietPeriod,
  ProactiveResult,
  ProactiveSourceItem,
} from "../ports/proactive-checks.js";

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

export type DecisionRuleOrigin = "owner_setting" | "built_in";

export interface DecisionRuleDefinition {
  readonly origin: DecisionRuleOrigin;
  readonly document: string;
}

export const DECISION_RULE_CATALOG: Readonly<Record<FloorRuleId, DecisionRuleDefinition>> =
  Object.freeze({
    [FLOOR_RULE_IDS.importantSender]: Object.freeze({
      origin: "owner_setting",
      document: "ADR 0106 第 4 条",
    }),
    [FLOOR_RULE_IDS.publicDomain]: Object.freeze({
      origin: "built_in",
      document: "ADR 0106 第 4 条",
    }),
    [FLOOR_RULE_IDS.moneyWords]: Object.freeze({
      origin: "built_in",
      document: "ADR 0106 第 4 条",
    }),
  });

export function decisionRuleDefinition(ruleId: string): DecisionRuleDefinition | undefined {
  return Object.hasOwn(DECISION_RULE_CATALOG, ruleId)
    ? DECISION_RULE_CATALOG[ruleId as FloorRuleId]
    : undefined;
}

export function floorHitIds(
  item: ProactiveSourceItem,
  rules: readonly RuleRecord[],
): readonly FloorRuleId[] {
  return JUDGE.decide("mail_item", mailItemFacts(item), rules)
    .hits.filter(({ outcome }) => outcome === "raise_floor")
    .map(({ id }) => id as FloorRuleId);
}

export function suppressPushHits(
  item: ProactiveSourceItem,
  amount: MailAmount,
  rules: readonly RuleRecord[],
): readonly string[] {
  const hits = JUDGE.decide("mail_item", mailItemFacts(item, amount), rules)
    .hits.filter(({ outcome }) => outcome === "suppress_push")
    .map(({ id, revision }) => `${id}@${revision}`.slice(0, 256));
  return [...new Set(hits)].sort().slice(0, 16);
}

export function quietEnd(
  at: string,
  rules: readonly RuleRecord[],
  periods: readonly ProactiveQuietPeriod[],
  timeZone: string,
): string | null {
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
  if (!decision.hits.some(({ outcome }) => outcome === "defer_to_quiet_hours")) return null;
  return quietUntil(at, periods, timeZone);
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
