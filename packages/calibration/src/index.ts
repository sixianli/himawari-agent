import type { PrereviewWeekSummary } from "./prereview.ts";

export const HISTORY_SCHEMA = "himawari-calibration-week.v4";
export const READABLE_HISTORY_SCHEMAS: readonly string[] = Object.freeze([
  "himawari-calibration-week.v3",
  HISTORY_SCHEMA,
]);
export const DEFAULT_MINIMUM_SAMPLES = 5;
export const WILSON_Z = 1.96;
export const HIMAWARI_ATTENTION_OUTCOMES: readonly string[] = Object.freeze([
  "act",
  "know",
  "check",
]);
export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

export const CALIBRATION_RATINGS = ["useful", "unneeded", "missed"] as const;
export type CalibrationRating = (typeof CALIBRATION_RATINGS)[number];

export const CALIBRATION_GROUPS = [
  "proactive_pushed",
  "proactive_silent",
  "memory_skipped",
  "memory_kept",
  "consolidation",
  "memory_pending",
  "context_truncation",
  "retrieval_degrade",
  "external_read",
  "rule_review",
  "memory_capture_failed",
] as const;
export type CalibrationGroup = (typeof CALIBRATION_GROUPS)[number];

export const MAIN_CALIBRATION_GROUPS: readonly CalibrationGroup[] = Object.freeze([
  "proactive_pushed",
  "proactive_silent",
  "memory_skipped",
  "memory_kept",
  "consolidation",
]);

export const APPLICABLE_RATINGS: Readonly<Record<CalibrationGroup, readonly CalibrationRating[]>> =
  {
    proactive_pushed: ["useful", "unneeded"],
    proactive_silent: ["useful", "missed"],
    memory_skipped: ["useful", "missed"],
    memory_kept: ["useful", "unneeded"],
    consolidation: ["useful", "unneeded"],
    memory_pending: ["useful", "unneeded"],
    context_truncation: ["useful", "unneeded"],
    retrieval_degrade: ["useful", "unneeded"],
    external_read: ["useful", "unneeded"],
    rule_review: ["useful", "unneeded"],
    memory_capture_failed: ["useful", "missed"],
  };

const GROUP_LABELS: Readonly<Record<CalibrationGroup, string>> = {
  proactive_pushed: "读完邮件提醒了你",
  proactive_silent: "读完邮件没提醒",
  memory_skipped: "系统没存下的记忆",
  memory_kept: "已存的记忆",
  consolidation: "整理记忆",
  memory_pending: "待你确认的记忆",
  context_truncation: "回答时没带上的旧内容",
  retrieval_degrade: "记忆搜索没生效",
  external_read: "外部程序读取记忆",
  rule_review: "硬规则待重审",
  memory_capture_failed: "记忆抽取失败",
};

const RATING_LABELS: Readonly<
  Record<CalibrationGroup, Partial<Readonly<Record<CalibrationRating, string>>>>
> = {
  proactive_pushed: { useful: "提醒得对", unneeded: "不该提醒" },
  proactive_silent: { useful: "不提醒是对的", missed: "该提醒没提醒" },
  memory_skipped: { useful: "不存是对的", missed: "该存没存" },
  memory_kept: { useful: "存对了", unneeded: "不该存" },
  consolidation: { useful: "整理得对", unneeded: "不该整理" },
  memory_pending: { useful: "做对了", unneeded: "不该做" },
  context_truncation: { useful: "做对了", unneeded: "不该做" },
  retrieval_degrade: { useful: "做对了", unneeded: "不该做" },
  external_read: { useful: "做对了", unneeded: "不该做" },
  rule_review: { useful: "做对了", unneeded: "不该做" },
  memory_capture_failed: { useful: "没漏掉什么", missed: "漏了该记的" },
};

export interface Proportion {
  readonly successes: number;
  readonly samples: number;
  readonly enough: boolean;
  readonly value: number | null;
  readonly low: number | null;
  readonly high: number | null;
}

export interface CalibrationWindow {
  readonly start: string;
  readonly end: string;
  readonly days: number;
  readonly label: string;
  readonly startDate: string;
  readonly endDate: string;
}

export interface CalibrationDecisionRow {
  readonly kind: string;
  readonly outcome: string | null;
  readonly ownerRating: CalibrationRating | null;
  readonly delivered: boolean;
}

export interface MuseEntryRow {
  readonly museReminded: boolean;
  readonly timingOk: boolean | null;
  readonly contentOk: boolean | null;
  readonly pairedMessageId: string | null;
}

export interface MailJudgment {
  readonly outcome: string;
  readonly ownerRating: CalibrationRating | null;
}

export const IMPLICIT_SIGNALS = ["opened", "undone", "replied"] as const;
export type ImplicitSignal = (typeof IMPLICIT_SIGNALS)[number];

export interface ImplicitSignalRow {
  readonly decisionId: string;
  readonly signal: ImplicitSignal;
  readonly delayMs: number;
  readonly pushed: boolean;
}

export interface CalibrationRows {
  readonly decisions: readonly CalibrationDecisionRow[];
  readonly entries: readonly MuseEntryRow[];
  readonly mailJudgments: ReadonlyMap<string, MailJudgment>;
  readonly signals: readonly ImplicitSignalRow[];
}

export interface ImplicitSignalSummary {
  readonly signal: ImplicitSignal;
  readonly decisions: number;
  readonly events: number;
  readonly medianDelayMs: number | null;
  readonly rate: Proportion;
}

export interface ImplicitSummary {
  readonly pushedDecisions: number;
  readonly signals: readonly ImplicitSignalSummary[];
  readonly otherDecisionEvents: number;
}

export interface GroupSummary {
  readonly group: CalibrationGroup;
  readonly total: number;
  readonly rated: number;
  readonly useful: number;
  readonly unneeded: number;
  readonly missed: number;
  readonly applicable: readonly CalibrationRating[];
  readonly rates: Readonly<Record<CalibrationRating, Proportion | null>>;
}

export interface MuseSummary {
  readonly entries: number;
  readonly reminded: number;
  readonly silent: number;
  readonly timing: Proportion;
  readonly content: Proportion;
  readonly pairing: Proportion;
  readonly unpaired: number;
  readonly pairedMails: number;
  readonly buckets: {
    readonly both: number;
    readonly museOnly: number;
    readonly himawariOnly: number;
    readonly bothSilent: number;
    readonly noHimawariRecord: number;
  };
  readonly himawariRatingsOnPairedMails: {
    readonly useful: number;
    readonly unneeded: number;
    readonly missed: number;
    readonly unrated: number;
  };
}

export function wilsonInterval(
  successes: number,
  samples: number,
  z = WILSON_Z,
): { readonly low: number; readonly high: number } | null {
  if (!Number.isInteger(samples) || samples <= 0) return null;
  const share = successes / samples;
  const z2 = z * z;
  const denominator = 1 + z2 / samples;
  const center = (share + z2 / (2 * samples)) / denominator;
  const half =
    (z * Math.sqrt((share * (1 - share)) / samples + z2 / (4 * samples * samples))) / denominator;
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

export function proportion(
  successes: number,
  samples: number,
  minimumSamples = DEFAULT_MINIMUM_SAMPLES,
): Proportion {
  const interval = wilsonInterval(successes, samples);
  const enough = samples >= minimumSamples && interval !== null;
  return {
    successes,
    samples,
    enough,
    value: enough ? successes / samples : null,
    low: enough && interval ? interval.low : null,
    high: enough && interval ? interval.high : null,
  };
}

export function formatProportion(result: Proportion): string {
  if (!result.enough || result.value === null || result.low === null || result.high === null)
    return `样本不足（${result.samples} 条）`;
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
  return `${percent(result.value)}（${result.successes}/${result.samples}，95% 区间 ${percent(result.low)}–${percent(result.high)}）`;
}

export function jstDate(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
}

export function jstDayStart(day: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day))
    throw new RangeError("CALIBRATION_WINDOW_END：日期要写成 YYYY-MM-DD（日本时间）");
  const parsed = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== day)
    throw new RangeError("CALIBRATION_WINDOW_END：日期无效");
  return parsed - JST_OFFSET_MS;
}

export function addDays(day: string, days: number): string {
  return jstDate(jstDayStart(day) + days * DAY_MS);
}

export function resolveWindow({
  end,
  days = 7,
  now = new Date(),
}: {
  readonly end?: string | null;
  readonly days?: number;
  readonly now?: Date;
} = {}): CalibrationWindow {
  if (!Number.isInteger(days) || days < 1 || days > 366)
    throw new RangeError("CALIBRATION_WINDOW_DAYS：天数必须是 1 到 366 的整数");
  const endMs =
    end === undefined || end === null
      ? Math.floor((now.getTime() + JST_OFFSET_MS) / DAY_MS) * DAY_MS - JST_OFFSET_MS
      : jstDayStart(end);
  const startMs = endMs - days * DAY_MS;
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    days,
    label: `${jstDate(startMs)} 至 ${jstDate(endMs - 1)}（日本时间）`,
    startDate: jstDate(startMs),
    endDate: jstDate(endMs),
  };
}

export function calibrationGroup(row: CalibrationDecisionRow): CalibrationGroup | null {
  if (row.kind === "rule_review" && row.outcome?.startsWith("owner_")) return null;
  if (row.kind === "proactive")
    return row.outcome === "silent" ? "proactive_silent" : "proactive_pushed";
  if (row.kind === "memory_candidate") {
    if (row.outcome === "discarded") return "memory_skipped";
    if (
      row.outcome === "capture_retrying" ||
      row.outcome === "capture_queued" ||
      row.outcome === "capture_gave_up"
    )
      return "memory_capture_failed";
    if (row.outcome === "kept") return "memory_kept";
    return "memory_pending";
  }
  return (CALIBRATION_GROUPS as readonly string[]).includes(row.kind)
    ? (row.kind as CalibrationGroup)
    : null;
}

export function groupLabel(group: CalibrationGroup): string {
  return GROUP_LABELS[group];
}

export function ratingLabel(group: CalibrationGroup, rating: CalibrationRating): string | null {
  return RATING_LABELS[group][rating] ?? null;
}

export function summarizeDecisions(
  rows: readonly CalibrationDecisionRow[],
  minimumSamples = DEFAULT_MINIMUM_SAMPLES,
): readonly GroupSummary[] {
  const grouped = new Map<CalibrationGroup, CalibrationDecisionRow[]>();
  for (const row of rows) {
    const group = calibrationGroup(row);
    if (group === null) continue;
    grouped.set(group, [...(grouped.get(group) ?? []), row]);
  }
  return CALIBRATION_GROUPS.filter((group) => grouped.has(group)).map((group) => {
    const ofGroup = grouped.get(group) ?? [];
    const rated = ofGroup.filter((row) => row.ownerRating !== null);
    const count = (rating: CalibrationRating) =>
      rated.filter((row) => row.ownerRating === rating).length;
    const applicable = APPLICABLE_RATINGS[group];
    const rate = (rating: CalibrationRating) =>
      applicable.includes(rating) ? proportion(count(rating), rated.length, minimumSamples) : null;
    return {
      group,
      total: ofGroup.length,
      rated: rated.length,
      useful: count("useful"),
      unneeded: count("unneeded"),
      missed: count("missed"),
      applicable,
      rates: { useful: rate("useful"), unneeded: rate("unneeded"), missed: rate("missed") },
    };
  });
}

export function pairEntriesByMail(
  entries: readonly MuseEntryRow[],
): ReadonlyMap<string, MuseEntryRow> {
  const byMail = new Map<string, MuseEntryRow>();
  for (const entry of entries) {
    if (entry.pairedMessageId === null) continue;
    const key = entry.pairedMessageId;
    const previous = byMail.get(key);
    if (previous === undefined || (entry.museReminded && !previous.museReminded))
      byMail.set(key, entry);
  }
  return byMail;
}

export type MailComparisonBucket = "both" | "museOnly" | "himawariOnly" | "bothSilent";

export function mailComparisonBucket(
  entry: MuseEntryRow,
  judgment: MailJudgment,
): MailComparisonBucket {
  const attention = HIMAWARI_ATTENTION_OUTCOMES.includes(judgment.outcome);
  if (entry.museReminded) return attention ? "both" : "museOnly";
  return attention ? "himawariOnly" : "bothSilent";
}

export function summarizeMuse(
  entries: readonly MuseEntryRow[],
  mailJudgments: ReadonlyMap<string, MailJudgment>,
  minimumSamples = DEFAULT_MINIMUM_SAMPLES,
): MuseSummary {
  const reminded = entries.filter((entry) => entry.museReminded);
  const paired = entries.filter((entry) => entry.pairedMessageId !== null);
  const byMail = pairEntriesByMail(entries);
  const buckets = { both: 0, museOnly: 0, himawariOnly: 0, bothSilent: 0, noHimawariRecord: 0 };
  const ratings = { useful: 0, unneeded: 0, missed: 0, unrated: 0 };
  for (const [messageId, entry] of byMail) {
    const judgment = mailJudgments.get(messageId);
    if (judgment === undefined) {
      buckets.noHimawariRecord += 1;
      continue;
    }
    buckets[mailComparisonBucket(entry, judgment)] += 1;
    if (judgment.ownerRating === null) ratings.unrated += 1;
    else ratings[judgment.ownerRating] += 1;
  }
  return {
    entries: entries.length,
    reminded: reminded.length,
    silent: entries.length - reminded.length,
    timing: proportion(
      reminded.filter((entry) => entry.timingOk === true).length,
      reminded.length,
      minimumSamples,
    ),
    content: proportion(
      reminded.filter((entry) => entry.contentOk === true).length,
      reminded.length,
      minimumSamples,
    ),
    pairing: proportion(paired.length, entries.length, minimumSamples),
    unpaired: entries.length - paired.length,
    pairedMails: byMail.size,
    buckets,
    himawariRatingsOnPairedMails: ratings,
  };
}

export type GapLineName = "hitRate" | "disturbanceRate";
export type GapDirection = "museHigher" | "himawariHigher" | "none";
export type GapVerdict = "insufficient" | "inconclusive" | "decided";

export interface GapSide {
  readonly reminded: number;
  readonly samples: number;
  readonly rate: Proportion;
}

export interface GapLine {
  readonly line: GapLineName;
  readonly mails: number;
  readonly muse: GapSide;
  readonly himawari: GapSide;
  readonly difference: number | null;
  readonly low: number | null;
  readonly high: number | null;
  readonly verdict: GapVerdict;
  readonly direction: GapDirection;
}

export interface GapSummary {
  readonly pairedMails: number;
  readonly ratedMails: number;
  readonly unratedMails: number;
  readonly lines: readonly [GapLine, GapLine];
}

export function mailTruth(judgment: MailJudgment): "shouldRemind" | "shouldNot" | null {
  const attention = HIMAWARI_ATTENTION_OUTCOMES.includes(judgment.outcome);
  if (attention && judgment.ownerRating === "useful") return "shouldRemind";
  if (attention && judgment.ownerRating === "unneeded") return "shouldNot";
  if (!attention && judgment.ownerRating === "missed") return "shouldRemind";
  if (!attention && judgment.ownerRating === "useful") return "shouldNot";
  return null;
}

export function pairedDifferenceInterval(
  both: number,
  museOnly: number,
  himawariOnly: number,
  neither: number,
): { readonly difference: number; readonly low: number; readonly high: number } | null {
  const n = both + museOnly + himawariOnly + neither;
  if (n <= 0) return null;
  const museRate = (both + museOnly) / n;
  const himawariRate = (both + himawariOnly) / n;
  const museInterval = wilsonInterval(both + museOnly, n);
  const himawariInterval = wilsonInterval(both + himawariOnly, n);
  if (museInterval === null || himawariInterval === null) return null;
  const a = both;
  const b = museOnly;
  const c = himawariOnly;
  const d = neither;
  const product = (a + b) * (c + d) * (a + c) * (b + d);
  const e = a * d - b * c;
  const corrected = e > n / 2 ? e - n / 2 : e >= 0 ? 0 : e;
  const phi = product === 0 ? 0 : corrected / Math.sqrt(product);
  const difference = museRate - himawariRate;
  const lowSpan = Math.sqrt(
    Math.max(
      0,
      (museRate - museInterval.low) ** 2 +
        (himawariInterval.high - himawariRate) ** 2 -
        2 * phi * (museRate - museInterval.low) * (himawariInterval.high - himawariRate),
    ),
  );
  const highSpan = Math.sqrt(
    Math.max(
      0,
      (museInterval.high - museRate) ** 2 +
        (himawariRate - himawariInterval.low) ** 2 -
        2 * phi * (museInterval.high - museRate) * (himawariRate - himawariInterval.low),
    ),
  );
  return {
    difference,
    low: Math.max(-1, difference - lowSpan),
    high: Math.min(1, difference + highSpan),
  };
}

function gapLine(
  line: GapLineName,
  mails: readonly { readonly museReminded: boolean; readonly himawariReminded: boolean }[],
  minimumSamples: number,
): GapLine {
  const both = mails.filter((mail) => mail.museReminded && mail.himawariReminded).length;
  const museOnly = mails.filter((mail) => mail.museReminded && !mail.himawariReminded).length;
  const himawariOnly = mails.filter((mail) => !mail.museReminded && mail.himawariReminded).length;
  const neither = mails.length - both - museOnly - himawariOnly;
  const side = (reminded: number): GapSide => ({
    reminded,
    samples: mails.length,
    rate: proportion(reminded, mails.length, minimumSamples),
  });
  const interval = pairedDifferenceInterval(both, museOnly, himawariOnly, neither);
  const enough = mails.length >= minimumSamples && interval !== null;
  const decided = enough && (interval.low > 0 || interval.high < 0);
  return {
    line,
    mails: mails.length,
    muse: side(both + museOnly),
    himawari: side(both + himawariOnly),
    difference: enough ? interval.difference : null,
    low: enough ? interval.low : null,
    high: enough ? interval.high : null,
    verdict: !enough ? "insufficient" : decided ? "decided" : "inconclusive",
    direction: decided ? (interval.difference > 0 ? "museHigher" : "himawariHigher") : "none",
  };
}

export function summarizeGap(
  entries: readonly MuseEntryRow[],
  mailJudgments: ReadonlyMap<string, MailJudgment>,
  minimumSamples = DEFAULT_MINIMUM_SAMPLES,
): GapSummary {
  const shouldRemind: { museReminded: boolean; himawariReminded: boolean }[] = [];
  const shouldNot: { museReminded: boolean; himawariReminded: boolean }[] = [];
  let paired = 0;
  for (const [messageId, entry] of pairEntriesByMail(entries)) {
    const judgment = mailJudgments.get(messageId);
    if (judgment === undefined) continue;
    paired += 1;
    const truth = mailTruth(judgment);
    if (truth === null) continue;
    const mail = {
      museReminded: entry.museReminded,
      himawariReminded: HIMAWARI_ATTENTION_OUTCOMES.includes(judgment.outcome),
    };
    (truth === "shouldRemind" ? shouldRemind : shouldNot).push(mail);
  }
  const rated = shouldRemind.length + shouldNot.length;
  return {
    pairedMails: paired,
    ratedMails: rated,
    unratedMails: paired - rated,
    lines: [
      gapLine("hitRate", shouldRemind, minimumSamples),
      gapLine("disturbanceRate", shouldNot, minimumSamples),
    ],
  };
}

export const GAP_ATTRIBUTIONS = [
  "notRemembered",
  "notRetrieved",
  "wrongJudgment",
  "notReadFully",
] as const;
export type GapAttribution = (typeof GAP_ATTRIBUTIONS)[number];

export interface GapAttributionInput {
  readonly relatedRead: string | null;
  readonly memoryRecall: string | null;
  readonly memoryHitsForMail: number;
}

export function attributeGap(input: GapAttributionInput): GapAttribution {
  if (input.relatedRead === "partial" || input.relatedRead === "failed") return "notReadFully";
  if (
    input.memoryRecall === "off" ||
    input.memoryRecall === "partial" ||
    input.memoryRecall === "failed"
  )
    return "notRetrieved";
  if (input.memoryRecall === "ok" && input.memoryHitsForMail === 0) return "notRemembered";
  return "wrongJudgment";
}

export const GAP_ATTRIBUTION_LABELS: Readonly<Record<GapAttribution, string>> = Object.freeze({
  notRemembered: "没记住",
  notRetrieved: "没取到",
  wrongJudgment: "判断错",
  notReadFully: "没读全",
});

export function isGapCase(entry: MuseEntryRow, judgment: MailJudgment): boolean {
  if (!entry.museReminded) return false;
  if (HIMAWARI_ATTENTION_OUTCOMES.includes(judgment.outcome)) return false;
  return (entry.timingOk === true && entry.contentOk === true) || judgment.ownerRating === "missed";
}

export function summarizeImplicit(
  decisions: readonly CalibrationDecisionRow[],
  signals: readonly ImplicitSignalRow[],
  minimumSamples = DEFAULT_MINIMUM_SAMPLES,
): ImplicitSummary {
  const pushedDecisions = decisions.filter(
    (row) =>
      row.kind === "proactive" &&
      row.delivered &&
      (row.outcome === "pushed" || row.outcome === "deferred"),
  ).length;
  const median = (values: readonly number[]): number | null => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
      ? (sorted[middle] as number)
      : Math.round(((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2);
  };
  return {
    pushedDecisions,
    signals: IMPLICIT_SIGNALS.map((signal) => {
      const ofKind = signals.filter((row) => row.pushed && row.signal === signal);
      const first = new Map<string, number>();
      for (const row of ofKind)
        if (!first.has(row.decisionId)) first.set(row.decisionId, row.delayMs);
      return {
        signal,
        decisions: first.size,
        events: ofKind.length,
        medianDelayMs: median([...first.values()]),
        rate: proportion(first.size, pushedDecisions, minimumSamples),
      };
    }),
    otherDecisionEvents: signals.filter((row) => !row.pushed).length,
  };
}

export const IMPLICIT_SIGNAL_LABELS: Readonly<Record<ImplicitSignal, string>> = Object.freeze({
  opened: "点开了推送",
  undone: "点了完成或不再提醒后又撤销",
  replied: "邮件串里你回复了",
});

export function formatDelay(delayMs: number | null): string {
  if (delayMs === null) return "无";
  const minutes = delayMs / 60_000;
  if (minutes < 1) return "不到 1 分钟";
  if (minutes < 120) return `${Math.round(minutes)} 分钟`;
  const hours = minutes / 60;
  return hours < 48 ? `${hours.toFixed(1)} 小时` : `${(hours / 24).toFixed(1)} 天`;
}

export interface CalibrationStatement {
  get(...parameters: unknown[]): unknown;
  all(...parameters: unknown[]): unknown[];
}

export interface CalibrationDatabase {
  prepare(sql: string): CalibrationStatement;
}

const ISO_PATTERN = "????-??-??T??:??:??.???Z";

export const EXTERNAL_PROPOSAL_REASON_PATTERN = "mcp!_proposal!_%";

export const CALIBRATION_MAIL_SOURCE = "gmail";

export const CALIBRATION_SQL = Object.freeze({
  badDecisionTimes: `SELECT count(*) AS n FROM decision_ledger WHERE checked_at NOT GLOB '${ISO_PATTERN}'`,
  badMuseTimes: `SELECT count(*) AS n FROM muse_reference_entries WHERE muse_at NOT GLOB '${ISO_PATTERN}'`,
  decisions: `SELECT decision.kind AS kind, COALESCE(decision.outcome, decision.verdict) AS outcome,
      decision.owner_rating AS ownerRating,
      CASE WHEN EXISTS (
        SELECT 1 FROM web_push_feedback sent
        WHERE sent.owner_id = decision.owner_id AND sent.agent_id = decision.agent_id
          AND sent.source_key = decision.push_source_key
      ) THEN 1 ELSE 0 END AS delivered
    FROM decision_ledger decision
    WHERE decision.owner_id = ? AND decision.agent_id = ?
      AND decision.checked_at >= ? AND decision.checked_at < ?
      AND NOT (decision.kind = 'memory_candidate'
        AND COALESCE(decision.reason_code, '') LIKE '${EXTERNAL_PROPOSAL_REASON_PATTERN}' ESCAPE '!')
    ORDER BY decision.checked_at, decision.id`,
  museEntries: `SELECT muse_reminded AS museReminded, timing_ok AS timingOk,
      content_ok AS contentOk, paired_message_id AS pairedMessageId
    FROM muse_reference_entries
    WHERE owner_id = ? AND agent_id = ? AND muse_at >= ? AND muse_at < ?
    ORDER BY muse_at, id`,
  signals: `SELECT signal.decision_id AS decisionId, signal.signal AS signal,
      signal.delay_ms AS delayMs,
      CASE WHEN decision.kind = 'proactive' AND decision.verdict IN ('pushed', 'deferred')
        AND EXISTS (
        SELECT 1 FROM web_push_feedback sent
        WHERE sent.owner_id = decision.owner_id AND sent.agent_id = decision.agent_id
          AND sent.source_key = decision.push_source_key
      ) THEN 1 ELSE 0 END AS pushed
    FROM decision_signals signal
    JOIN decision_ledger decision ON decision.id = signal.decision_id
    WHERE decision.owner_id = ? AND decision.agent_id = ?
      AND decision.checked_at >= ? AND decision.checked_at < ?
    ORDER BY signal.occurred_at, signal.id`,
  mailJudgment: `SELECT outcome, owner_rating AS ownerRating FROM proactive_processed_messages
    WHERE owner_id = ? AND agent_id = ? AND source = '${CALIBRATION_MAIL_SOURCE}' AND message_id = ?`,
});

export function assertTimestampFormat(database: CalibrationDatabase): void {
  const count = (sql: string) => (database.prepare(sql).get() as { n: number }).n;
  const bad = count(CALIBRATION_SQL.badDecisionTimes) + count(CALIBRATION_SQL.badMuseTimes);
  if (bad > 0)
    throw new Error(
      `CALIBRATION_TIMESTAMP_FORMAT：有 ${bad} 条记录的时间不是 UTC 毫秒加 Z 的格式，按时间窗口统计会错，不出报告。`,
    );
}

export function readCalibrationRows(
  database: CalibrationDatabase,
  {
    ownerId,
    agentId,
    start,
    end,
  }: {
    readonly ownerId: string;
    readonly agentId: string;
    readonly start: string;
    readonly end: string;
  },
): CalibrationRows {
  assertTimestampFormat(database);
  const decisions = (
    database.prepare(CALIBRATION_SQL.decisions).all(ownerId, agentId, start, end) as (Omit<
      CalibrationDecisionRow,
      "delivered"
    > & {
      delivered: number;
    })[]
  ).map((row) => ({ ...row, delivered: row.delivered === 1 }));
  const entries = (
    database.prepare(CALIBRATION_SQL.museEntries).all(ownerId, agentId, start, end) as {
      museReminded: number;
      timingOk: number | null;
      contentOk: number | null;
      pairedMessageId: string | null;
    }[]
  ).map((row) => ({
    museReminded: row.museReminded === 1,
    timingOk: row.timingOk === null ? null : row.timingOk === 1,
    contentOk: row.contentOk === null ? null : row.contentOk === 1,
    pairedMessageId: row.pairedMessageId,
  }));
  const signals = (
    database.prepare(CALIBRATION_SQL.signals).all(ownerId, agentId, start, end) as {
      decisionId: string;
      signal: ImplicitSignal;
      delayMs: number;
      pushed: number;
    }[]
  ).map((row) => ({ ...row, pushed: row.pushed === 1 }));
  const mailJudgments = new Map<string, MailJudgment>();
  const lookup = database.prepare(CALIBRATION_SQL.mailJudgment);
  for (const messageId of new Set(
    entries.map((entry) => entry.pairedMessageId).filter((id): id is string => id !== null),
  )) {
    const row = lookup.get(ownerId, agentId, messageId) as MailJudgment | undefined;
    if (row !== undefined) mailJudgments.set(messageId, row);
  }
  return { decisions, entries, mailJudgments, signals };
}

export interface HistoryRecord {
  readonly schema: string;
  readonly recordedAt: string;
  readonly commit: string;
  readonly ownerId: string;
  readonly agentId: string;
  readonly window: {
    readonly start: string;
    readonly end: string;
    readonly days: number;
    readonly label: string;
  };
  readonly minimumSamples: number;
  readonly groups: readonly {
    readonly group: CalibrationGroup;
    readonly total: number;
    readonly rated: number;
    readonly useful: number;
    readonly unneeded: number;
    readonly missed: number;
  }[];
  readonly muse: {
    readonly entries: number;
    readonly reminded: number;
    readonly timingOk: number;
    readonly contentOk: number;
    readonly paired: number;
    readonly buckets: MuseSummary["buckets"];
  };
  readonly implicit: {
    readonly pushedDecisions: number;
    readonly otherDecisionEvents: number;
    readonly signals: readonly {
      readonly signal: ImplicitSignal;
      readonly decisions: number;
      readonly events: number;
      readonly medianDelayMs: number | null;
    }[];
  };
  readonly prereview?: {
    readonly modelRef: string | null;
    readonly promptId: string | null;
    readonly groups: readonly {
      readonly group: CalibrationGroup;
      readonly prereviewed: number;
      readonly unsure: number;
      readonly paired: number;
      readonly agreed: number;
    }[];
  };
}

const GAP_LINE_LABELS: Readonly<Record<GapLineName, string>> = Object.freeze({
  hitRate: "命中率（该提醒的邮件里，这一方提醒了的占比）",
  disturbanceRate: "多余提醒率（不该提醒的邮件里，这一方提醒了的占比）",
});

export function formatSignedPercent(value: number): string {
  const percent = (value * 100).toFixed(1);
  return value > 0 ? `+${percent}%` : `${percent}%`;
}

export function gapReportLines(gap: GapSummary, minimumSamples: number): string[] {
  const lines: string[] = ["## Muse 差距线", ""];
  lines.push(
    `配对到 Himawari 判断的邮件 ${gap.pairedMails} 封，其中你评过的 ${gap.ratedMails} 封进差距线，没评过的 ${gap.unratedMails} 封只进案例清单。“该提醒/不该提醒”只按你对 Himawari 判断的评价定：提醒了且评“做对了”、没提醒且评“该做没做”算该提醒；提醒了且评“不该做”、没提醒且评“做对了”算不该提醒。差 = Muse − Himawari，区间是同一批邮件的配对差 95% 区间。`,
    "",
  );
  for (const line of gap.lines) {
    const label = GAP_LINE_LABELS[line.line];
    if (line.verdict === "insufficient") {
      lines.push(
        `- ${label}：样本不足（配对且评过的邮件 ${line.mails} 封，少于 ${minimumSamples} 封），只看下面的案例，不下结论。`,
      );
      continue;
    }
    const diff =
      line.difference === null || line.low === null || line.high === null
        ? ""
        : `；差 ${formatSignedPercent(line.difference)}（区间 ${formatSignedPercent(line.low)} 至 ${formatSignedPercent(line.high)}）`;
    const conclusion =
      line.verdict === "inconclusive"
        ? "区间跨 0，分不出差别。"
        : line.direction === "museHigher"
          ? "Muse 的这个比例更高。"
          : "Himawari 的这个比例更高。";
    lines.push(
      `- ${label}：Muse ${formatProportion(line.muse.rate)}；Himawari ${formatProportion(line.himawari.rate)}${diff}。${conclusion}`,
    );
  }
  lines.push(
    "",
    "局限：评价只覆盖你愿意评的邮件，样本偏向你记过 Muse 条目且评过的邮件；记忆不和 Muse 比。",
    "",
  );
  return lines;
}

export function buildReport({
  window,
  scope,
  decisions,
  muse,
  implicit,
  minimumSamples,
  previous,
  gap,
  sections = [],
}: {
  readonly window: CalibrationWindow;
  readonly scope: { readonly ownerId: string; readonly agentId: string };
  readonly decisions: readonly GroupSummary[];
  readonly muse: MuseSummary;
  readonly implicit: ImplicitSummary;
  readonly minimumSamples: number;
  readonly previous?: HistoryRecord | undefined;
  readonly gap?: GapSummary | undefined;
  readonly sections?: readonly string[];
}): string {
  const lines: string[] = [];
  lines.push(`# 校准周报：${window.label}`, "");
  lines.push(
    `统计范围：这一周内做出的决策里，你评过的那部分。每一类只列它可能出现的情况，例如“系统没存下的记忆”只会是“不存是对的”或“该存没存”；比例 = 这种情况的条数 ÷ 你评过的条数（只代表你评过的样本）。评过的少于 ${minimumSamples} 条的不出百分比，写「样本不足」。区间是 95% Wilson 区间。`,
    "",
  );
  lines.push("## 按决策类型", "");
  if (decisions.length === 0) lines.push("这一周没有决策记录。", "");
  else {
    lines.push("| 决策类型 | 决策条数 | 你评过的条数 | 比例 |", "| --- | --- | --- | --- |");
    for (const row of decisions) {
      const shares = row.applicable
        .map((rating) => {
          const rate = row.rates[rating];
          return rate ? `${ratingLabel(row.group, rating)} ${formatProportion(rate)}` : null;
        })
        .filter((text): text is string => text !== null);
      const cell = row.rated < minimumSamples ? `样本不足（${row.rated} 条）` : shares.join("；");
      lines.push(`| ${groupLabel(row.group)} | ${row.total} | ${row.rated} | ${cell} |`);
    }
    lines.push("");
  }
  lines.push("## Muse 对照", "");
  if (muse.entries === 0) lines.push("样本不足：这一周没有 Muse 对照条目。", "");
  else {
    lines.push(
      `- Muse 对照条目共 ${muse.entries} 条：Muse 提醒了 ${muse.reminded} 条，没提醒 ${muse.silent} 条。`,
      `- Muse 提醒的时机对的占比：${formatProportion(muse.timing)}`,
      `- Muse 提醒的内容对的占比：${formatProportion(muse.content)}`,
      `- 配对率（条目里写明了对应邮件的占比）：${formatProportion(muse.pairing)}；没写明对应邮件的 ${muse.unpaired} 条不进下面的逐封比较。`,
      `- 逐封比较（同一封邮件，共 ${muse.pairedMails} 封）：两边都提醒 ${muse.buckets.both} 封；只有 Muse 提醒 ${muse.buckets.museOnly} 封；只有 Himawari 提醒 ${muse.buckets.himawariOnly} 封；两边都没提醒 ${muse.buckets.bothSilent} 封；Himawari 没有这封邮件的记录（含邮件编号写错）${muse.buckets.noHimawariRecord} 封。`,
      `- 你对这些邮件里 Himawari 判断的评价：做对了 ${muse.himawariRatingsOnPairedMails.useful}，不该做 ${muse.himawariRatingsOnPairedMails.unneeded}，该做没做 ${muse.himawariRatingsOnPairedMails.missed}，未评 ${muse.himawariRatingsOnPairedMails.unrated}。`,
      "- 局限：只有你记过 Muse 条目的邮件才进逐封比较；Himawari 提醒过、你没记 Muse 条目的邮件不在里面，两边都没提醒又没人记的邮件也没有记录，所以样本偏向有提醒的一侧。时机对和内容对的占比按条目计，不按邮件去重。",
      "",
    );
  }
  if (gap !== undefined) lines.push(...gapReportLines(gap, minimumSamples));
  lines.push("## 观察信号（不是打分）", "");
  lines.push(
    "这一节记不需要你动手评价就能看到的事：提醒有没有被点开、完成或静音后有没有撤销、邮件串里你有没有回复。它们是弱信号，不当作你的评价，不和上面的打分比例混在一起算，也不会用来自动改任何门槛。分母是这一周推送过提醒的决策。",
    "",
  );
  if (implicit.pushedDecisions === 0) {
    lines.push("这一周没有推送过提醒的决策。", "");
    if (implicit.otherDecisionEvents > 0)
      lines.push(`另有 ${implicit.otherDecisionEvents} 条信号落在没有推送的决策上。`, "");
  } else {
    lines.push(
      `这一周推送过提醒的决策 ${implicit.pushedDecisions} 条。`,
      "",
      "| 信号 | 出现过的决策 | 占比 | 事件条数 | 首次发生的中位间隔 |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const row of implicit.signals)
      lines.push(
        `| ${IMPLICIT_SIGNAL_LABELS[row.signal]} | ${row.decisions} | ${formatProportion(row.rate)} | ${row.events} | ${formatDelay(row.medianDelayMs)} |`,
      );
    lines.push("");
    if (implicit.otherDecisionEvents > 0)
      lines.push(
        `另有 ${implicit.otherDecisionEvents} 条信号落在没有推送的决策上，不进上面的比例。`,
        "",
      );
  }
  lines.push(...sections);
  lines.push("## 与上一周对比", "");
  if (!previous) lines.push("没有更早的记录可比。", "");
  else {
    lines.push(`上一条记录：${previous.window.label}（提交 ${previous.commit}）。`, "");
    for (const row of decisions) {
      const before = previous.groups.find((entry) => entry.group === row.group);
      const show = (rate: Proportion | null) =>
        rate?.enough && rate.value !== null ? `${(rate.value * 100).toFixed(1)}%` : "样本不足";
      const beforeRate = before
        ? proportion(before.useful, before.rated, previous.minimumSamples ?? minimumSamples)
        : null;
      lines.push(
        `- ${groupLabel(row.group)} ${ratingLabel(row.group, "useful")}：${beforeRate ? show(beforeRate) : "无记录"} → ${show(row.rates.useful)}`,
      );
    }
    lines.push("", "只有两周的 95% 区间不重叠，才能说比例真的变了；区间重叠只是波动。", "");
  }
  lines.push(`范围：所有者 ${scope.ownerId}，智能体 ${scope.agentId}。`, "");
  return lines.join("\n");
}

export function historyRecord({
  window,
  scope,
  decisions,
  muse,
  implicit,
  minimumSamples,
  commit,
  recordedAt,
  prereview,
}: {
  readonly window: CalibrationWindow;
  readonly scope: { readonly ownerId: string; readonly agentId: string };
  readonly decisions: readonly GroupSummary[];
  readonly muse: MuseSummary;
  readonly implicit: ImplicitSummary;
  readonly minimumSamples: number;
  readonly commit: string;
  readonly recordedAt: string;
  readonly prereview?: PrereviewWeekSummary;
}): HistoryRecord {
  return {
    schema: HISTORY_SCHEMA,
    recordedAt,
    commit,
    ownerId: scope.ownerId,
    agentId: scope.agentId,
    window: { start: window.start, end: window.end, days: window.days, label: window.label },
    minimumSamples,
    groups: decisions.map(({ group, total, rated, useful, unneeded, missed }) => ({
      group,
      total,
      rated,
      useful,
      unneeded,
      missed,
    })),
    muse: {
      entries: muse.entries,
      reminded: muse.reminded,
      timingOk: muse.timing.successes,
      contentOk: muse.content.successes,
      paired: muse.entries - muse.unpaired,
      buckets: muse.buckets,
    },
    implicit: {
      pushedDecisions: implicit.pushedDecisions,
      otherDecisionEvents: implicit.otherDecisionEvents,
      signals: implicit.signals.map(({ signal, decisions: count, events, medianDelayMs }) => ({
        signal,
        decisions: count,
        events,
        medianDelayMs,
      })),
    },
    prereview: {
      modelRef: prereview?.version?.modelRef ?? null,
      promptId: prereview?.version?.promptId ?? null,
      groups: (prereview?.groups ?? []).map(
        ({ group, prereviewed, unsure, paired, agreement }) => ({
          group,
          prereviewed,
          unsure,
          paired,
          agreed: agreement.successes,
        }),
      ),
    },
  };
}

export function sameMeasurement(left: HistoryRecord, right: HistoryRecord): boolean {
  return (
    left.ownerId === right.ownerId &&
    left.agentId === right.agentId &&
    left.window.start === right.window.start &&
    left.window.end === right.window.end &&
    left.minimumSamples === right.minimumSamples &&
    JSON.stringify(left.groups) === JSON.stringify(right.groups) &&
    JSON.stringify(left.muse) === JSON.stringify(right.muse) &&
    JSON.stringify(left.implicit) === JSON.stringify(right.implicit) &&
    JSON.stringify(left.prereview ?? null) === JSON.stringify(right.prereview ?? null)
  );
}
export * from "./thresholds.ts";
