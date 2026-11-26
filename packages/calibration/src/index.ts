import type { PrereviewWeekSummary } from "./prereview.ts";

export const HISTORY_SCHEMA = "himawari-calibration-week.v5";
export const READABLE_HISTORY_SCHEMAS: readonly string[] = Object.freeze([
  "himawari-calibration-week.v3",
  "himawari-calibration-week.v4",
  HISTORY_SCHEMA,
]);
export const DEFAULT_MINIMUM_SAMPLES = 5;
export const WILSON_Z = 1.96;
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
});

export function assertTimestampFormat(database: CalibrationDatabase): void {
  const count = (sql: string) => (database.prepare(sql).get() as { n: number }).n;
  const bad = count(CALIBRATION_SQL.badDecisionTimes);
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
  const signals = (
    database.prepare(CALIBRATION_SQL.signals).all(ownerId, agentId, start, end) as {
      decisionId: string;
      signal: ImplicitSignal;
      delayMs: number;
      pushed: number;
    }[]
  ).map((row) => ({ ...row, pushed: row.pushed === 1 }));
  return { decisions, signals };
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

export function buildReport({
  window,
  scope,
  decisions,
  implicit,
  minimumSamples,
  previous,
  sections = [],
}: {
  readonly window: CalibrationWindow;
  readonly scope: { readonly ownerId: string; readonly agentId: string };
  readonly decisions: readonly GroupSummary[];
  readonly implicit: ImplicitSummary;
  readonly minimumSamples: number;
  readonly previous?: HistoryRecord | undefined;
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
  implicit,
  minimumSamples,
  commit,
  recordedAt,
  prereview,
}: {
  readonly window: CalibrationWindow;
  readonly scope: { readonly ownerId: string; readonly agentId: string };
  readonly decisions: readonly GroupSummary[];
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
    JSON.stringify(left.implicit) === JSON.stringify(right.implicit) &&
    JSON.stringify(left.prereview ?? null) === JSON.stringify(right.prereview ?? null)
  );
}
export * from "./thresholds.ts";
