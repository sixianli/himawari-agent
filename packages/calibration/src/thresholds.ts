import { type Proportion, proportion, WILSON_Z, wilsonInterval } from "./index.ts";

export const THRESHOLD_CATEGORIES = [
  "identity",
  "preference",
  "relationship",
  "goal",
  "project",
  "rule",
  "health",
  "finance",
  "event",
  "other",
] as const;
export type ThresholdCategory = (typeof THRESHOLD_CATEGORIES)[number];

export interface ThresholdGate {
  readonly key: string;
  readonly decisionKind: string;
  readonly label: string;
  readonly scoreField: "confidencePermille";
  readonly scoreMax: number;
  readonly gatedReasons: readonly string[];
  readonly ambiguousReasons: readonly string[];
  readonly positiveOutcomes: readonly string[];
  readonly defaultThreshold: number;
  readonly byCategory: Readonly<Partial<Record<ThresholdCategory, number>>>;
}

export const MEMORY_AUTO_COMMIT_GATE: ThresholdGate = Object.freeze({
  key: "memory_candidate.auto_commit",
  decisionKind: "memory_candidate",
  label: "记忆候选自动存入",
  scoreField: "confidencePermille",
  scoreMax: 1000,
  gatedReasons: Object.freeze(["auto_committed", "confidence_below_threshold"]),
  ambiguousReasons: Object.freeze(["kept_tentative"]),
  positiveOutcomes: Object.freeze(["kept"]),
  defaultThreshold: 850,
  byCategory: Object.freeze({}),
});

export const MEMORY_TENTATIVE_CONFIRM_GATE: ThresholdGate = Object.freeze({
  key: "memory_candidate.confirm_tentative",
  decisionKind: "memory_candidate",
  label: "待确认记忆转正",
  scoreField: "confidencePermille",
  scoreMax: 1000,
  gatedReasons: Object.freeze(["tentative_confirmed", "confirm_below_threshold"]),
  ambiguousReasons: Object.freeze([]),
  positiveOutcomes: Object.freeze(["kept"]),
  defaultThreshold: 850,
  byCategory: Object.freeze({}),
});

export const MEMORY_PERCEPTION_COMMIT_GATE: ThresholdGate = Object.freeze({
  key: "memory_candidate.perception_commit",
  decisionKind: "memory_candidate",
  label: "感知直接存入",
  scoreField: "confidencePermille",
  scoreMax: 1000,
  gatedReasons: Object.freeze(["perception_committed", "perception_below_threshold"]),
  ambiguousReasons: Object.freeze(["perception_kept_tentative", "perception_sensitive_tentative"]),
  positiveOutcomes: Object.freeze(["kept"]),
  defaultThreshold: 850,
  byCategory: Object.freeze({}),
});

export const THRESHOLD_GATES: readonly ThresholdGate[] = Object.freeze([
  MEMORY_AUTO_COMMIT_GATE,
  MEMORY_TENTATIVE_CONFIRM_GATE,
  MEMORY_PERCEPTION_COMMIT_GATE,
]);

export function thresholdFor(gate: ThresholdGate, category: string | null): number {
  if (category !== null && Object.hasOwn(gate.byCategory, category))
    return gate.byCategory[category as ThresholdCategory] ?? gate.defaultThreshold;
  return gate.defaultThreshold;
}

export const DEFAULT_INTERVAL_WIDTH_LIMIT = 0.1;
export const DEFAULT_MISS_COST_RATIOS: readonly number[] = Object.freeze([1, 2, 5]);

export function worstCaseIntervalWidth(samples: number, z = WILSON_Z): number {
  let widest = 0;
  for (const successes of [Math.floor(samples / 2), Math.ceil(samples / 2)]) {
    const interval = wilsonInterval(successes, samples, z);
    if (interval !== null) widest = Math.max(widest, interval.high - interval.low);
  }
  return widest;
}

export function requiredSamples(widthLimit = DEFAULT_INTERVAL_WIDTH_LIMIT, z = WILSON_Z): number {
  if (!(widthLimit > 0 && widthLimit < 1))
    throw new RangeError("THRESHOLD_WIDTH_LIMIT：区间宽度上限必须在 0 和 1 之间");
  let high = 1;
  while (worstCaseIntervalWidth(high, z) > widthLimit) high *= 2;
  let low = Math.max(1, Math.floor(high / 2));
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (worstCaseIntervalWidth(middle, z) > widthLimit) low = middle + 1;
    else high = middle;
  }
  return low;
}

export interface ThresholdDecisionRow {
  readonly id: string;
  readonly kind: string;
  readonly outcome: string | null;
  readonly reasonCode: string;
  readonly ownerRating: string | null;
  readonly category: string | null;
  readonly score: number | null;
  readonly decidedAt: string;
}

export type ThresholdTruth = "shouldAct" | "shouldNot";

export interface ThresholdSample {
  readonly id: string;
  readonly category: string | null;
  readonly score: number;
  readonly outcome: string;
  readonly rating: string;
  readonly truth: ThresholdTruth;
  readonly acted: boolean;
  readonly currentThreshold: number;
}

export function sampleTruth(
  gate: ThresholdGate,
  outcome: string,
  rating: string,
): ThresholdTruth | null {
  const acted = gate.positiveOutcomes.includes(outcome);
  if (rating === "useful") return acted ? "shouldAct" : "shouldNot";
  if (acted && rating === "unneeded") return "shouldNot";
  if (!acted && rating === "missed") return "shouldAct";
  return null;
}

export interface GateSampleSet {
  readonly samples: readonly ThresholdSample[];
  readonly unrated: number;
  readonly notGated: number;
  readonly ambiguous: number;
  readonly ambiguousRatings: Readonly<Record<string, number>>;
  readonly missingScore: number;
  readonly mismatchedRating: number;
}

export function gateSamples(
  gate: ThresholdGate,
  rows: readonly ThresholdDecisionRow[],
): GateSampleSet {
  const samples: ThresholdSample[] = [];
  let unrated = 0;
  let notGated = 0;
  const ambiguousRatings: Record<string, number> = {};
  let missingScore = 0;
  let mismatchedRating = 0;
  for (const row of rows) {
    if (row.kind !== gate.decisionKind) continue;
    const isAmbiguous = gate.ambiguousReasons.includes(row.reasonCode);
    if (!isAmbiguous && !gate.gatedReasons.includes(row.reasonCode)) {
      notGated += 1;
      continue;
    }
    if (row.ownerRating === null) {
      unrated += 1;
      continue;
    }
    if (isAmbiguous) {
      ambiguousRatings[row.ownerRating] = (ambiguousRatings[row.ownerRating] ?? 0) + 1;
      continue;
    }
    if (
      row.score === null ||
      !Number.isFinite(row.score) ||
      row.score < 0 ||
      row.score > gate.scoreMax ||
      row.outcome === null
    ) {
      missingScore += 1;
      continue;
    }
    const truth = sampleTruth(gate, row.outcome, row.ownerRating);
    if (truth === null) {
      mismatchedRating += 1;
      continue;
    }
    samples.push({
      id: row.id,
      category: row.category,
      score: row.score,
      outcome: row.outcome,
      rating: row.ownerRating,
      truth,
      acted: gate.positiveOutcomes.includes(row.outcome),
      currentThreshold: thresholdFor(gate, row.category),
    });
  }
  return {
    samples,
    unrated,
    notGated,
    ambiguous: Object.values(ambiguousRatings).reduce((total, count) => total + count, 0),
    ambiguousRatings,
    missingScore,
    mismatchedRating,
  };
}

export interface CurvePoint {
  readonly threshold: number;
  readonly disturbances: number;
  readonly misses: number;
  readonly disturbanceRate: Proportion;
  readonly missRate: Proportion;
}

export function thresholdCandidates(
  samples: readonly ThresholdSample[],
  scoreMax: number,
  current: number,
): number[] {
  const values = new Set<number>([0, scoreMax + 1, current]);
  for (const sample of samples) {
    values.add(sample.score);
    values.add(Math.min(sample.score + 1, scoreMax + 1));
    values.add(sample.currentThreshold);
  }
  return [...values].sort((left, right) => left - right);
}

function countPoint(
  samples: readonly ThresholdSample[],
  threshold: number,
  minimumSamples: number,
  thresholdOf: (sample: ThresholdSample) => number,
): CurvePoint {
  let disturbances = 0;
  let misses = 0;
  for (const sample of samples) {
    const acts = sample.score >= thresholdOf(sample);
    if (acts && sample.truth === "shouldNot") disturbances += 1;
    if (!acts && sample.truth === "shouldAct") misses += 1;
  }
  return {
    threshold,
    disturbances,
    misses,
    disturbanceRate: proportion(disturbances, samples.length, minimumSamples),
    missRate: proportion(misses, samples.length, minimumSamples),
  };
}

export type PinnedThreshold = (sample: ThresholdSample) => number | null;

const NOTHING_PINNED: PinnedThreshold = () => null;

export function curvePoint(
  samples: readonly ThresholdSample[],
  threshold: number,
  minimumSamples: number,
  pinned: PinnedThreshold = NOTHING_PINNED,
): CurvePoint {
  return countPoint(samples, threshold, minimumSamples, (sample) => pinned(sample) ?? threshold);
}

export function livePoint(
  samples: readonly ThresholdSample[],
  current: number,
  minimumSamples: number,
): CurvePoint {
  return countPoint(samples, current, minimumSamples, (sample) => sample.currentThreshold);
}

export type ReplayChange =
  | "usefulSilenced"
  | "unneededBlocked"
  | "missedCaught"
  | "usefulSilenceBroken"
  | "unneededAdded"
  | "missedDropped";

export interface ReplayFlip {
  readonly id: string;
  readonly score: number;
  readonly outcome: string;
  readonly rating: string;
  readonly before: boolean;
  readonly after: boolean;
  readonly change: ReplayChange;
  readonly correctAfter: boolean;
}

function replayChange(sample: ThresholdSample, after: boolean): ReplayChange {
  if (sample.rating === "missed") return after ? "missedCaught" : "missedDropped";
  if (sample.rating === "unneeded") return after ? "unneededAdded" : "unneededBlocked";
  return after ? "usefulSilenceBroken" : "usefulSilenced";
}

export function replay(
  samples: readonly ThresholdSample[],
  threshold: number,
  pinned: PinnedThreshold = NOTHING_PINNED,
): readonly ReplayFlip[] {
  return samples.flatMap((sample) => {
    const before = sample.acted;
    const after = sample.score >= (pinned(sample) ?? threshold);
    if (before === after) return [];
    return [
      {
        id: sample.id,
        score: sample.score,
        outcome: sample.outcome,
        rating: sample.rating,
        before,
        after,
        change: replayChange(sample, after),
        correctAfter: after === (sample.truth === "shouldAct"),
      },
    ];
  });
}

export interface ThresholdSuggestion {
  readonly missCostRatio: number;
  readonly threshold: number;
  readonly point: CurvePoint;
  readonly cost: number;
  readonly flips: readonly ReplayFlip[];
}

export function suggestThreshold(
  samples: readonly ThresholdSample[],
  candidates: readonly number[],
  current: number,
  missCostRatio: number,
  minimumSamples: number,
  pinned: PinnedThreshold = NOTHING_PINNED,
): ThresholdSuggestion {
  if (!(Number.isFinite(missCostRatio) && missCostRatio > 0))
    throw new RangeError("THRESHOLD_MISS_COST：漏报代价比值必须是正数");
  let best: { point: CurvePoint; cost: number } | null = null;
  for (const threshold of candidates) {
    const point = curvePoint(samples, threshold, minimumSamples, pinned);
    const cost = point.disturbances + missCostRatio * point.misses;
    if (
      best === null ||
      cost < best.cost ||
      (cost === best.cost &&
        Math.abs(threshold - current) < Math.abs(best.point.threshold - current))
    )
      best = { point, cost };
  }
  if (best === null) throw new RangeError("THRESHOLD_NO_CANDIDATES：没有可选的门槛值");
  return {
    missCostRatio,
    threshold: best.point.threshold,
    point: best.point,
    cost: best.cost,
    flips: replay(samples, best.point.threshold, pinned),
  };
}

export interface SegmentAnalysis {
  readonly segment: string | null;
  readonly current: number;
  readonly mixedCurrent: boolean;
  readonly samples: number;
  readonly adjustable: number;
  readonly required: number;
  readonly enough: boolean;
  readonly currentPoint: CurvePoint;
  readonly curve: readonly CurvePoint[];
  readonly table: readonly CurvePoint[];
  readonly suggestions: readonly ThresholdSuggestion[];
}

export interface GateAnalysis {
  readonly gate: ThresholdGate;
  readonly unrated: number;
  readonly notGated: number;
  readonly ambiguous: number;
  readonly ambiguousRatings: Readonly<Record<string, number>>;
  readonly missingScore: number;
  readonly mismatchedRating: number;
  readonly overall: SegmentAnalysis;
  readonly categories: readonly SegmentAnalysis[];
}

function analyzeSegment(
  gate: ThresholdGate,
  segment: string | null,
  samples: readonly ThresholdSample[],
  current: number,
  required: number,
  missCostRatios: readonly number[],
  pinned: PinnedThreshold,
): SegmentAnalysis {
  const adjustable = samples.filter((sample) => pinned(sample) === null).length;
  const enough = adjustable >= required;
  const candidates = thresholdCandidates(samples, gate.scoreMax, current);
  const curve = candidates.map((threshold) => curvePoint(samples, threshold, required, pinned));
  const suggestions = enough
    ? missCostRatios.map((ratio) =>
        suggestThreshold(samples, candidates, current, ratio, required, pinned),
      )
    : [];
  const step = Math.max(1, Math.round(gate.scoreMax / 20));
  const shown = new Set<number>([current, ...suggestions.map((item) => item.threshold)]);
  for (let value = 0; value <= gate.scoreMax; value += step) shown.add(value);
  return {
    segment,
    current,
    mixedCurrent: samples.some((sample) => sample.currentThreshold !== current),
    samples: samples.length,
    adjustable,
    required,
    enough,
    currentPoint: livePoint(samples, current, required),
    curve,
    table: [...shown]
      .sort((left, right) => left - right)
      .map((threshold) => curvePoint(samples, threshold, required, pinned)),
    suggestions,
  };
}

export function analyzeGate(
  gate: ThresholdGate,
  rows: readonly ThresholdDecisionRow[],
  {
    required = requiredSamples(),
    missCostRatios = DEFAULT_MISS_COST_RATIOS,
  }: { readonly required?: number; readonly missCostRatios?: readonly number[] } = {},
): GateAnalysis {
  const set = gateSamples(gate, rows);
  const overall = analyzeSegment(
    gate,
    null,
    set.samples,
    gate.defaultThreshold,
    required,
    missCostRatios,
    (sample) =>
      sample.category !== null && Object.hasOwn(gate.byCategory, sample.category)
        ? sample.currentThreshold
        : null,
  );
  const categories = (Object.keys(gate.byCategory) as ThresholdCategory[]).sort().map((category) =>
    analyzeSegment(
      gate,
      category,
      set.samples.filter((sample) => sample.category === category),
      thresholdFor(gate, category),
      required,
      missCostRatios,
      NOTHING_PINNED,
    ),
  );
  return {
    gate,
    unrated: set.unrated,
    notGated: set.notGated,
    ambiguous: set.ambiguous,
    ambiguousRatings: set.ambiguousRatings,
    missingScore: set.missingScore,
    mismatchedRating: set.mismatchedRating,
    overall,
    categories,
  };
}

export interface UngatedKind {
  readonly kind: string;
  readonly total: number;
  readonly rated: number;
}

export function ungatedKinds(
  counts: readonly UngatedKind[],
  gates: readonly ThresholdGate[] = THRESHOLD_GATES,
): readonly UngatedKind[] {
  const gated = new Set(gates.map((gate) => gate.decisionKind));
  return counts
    .filter((entry) => !gated.has(entry.kind))
    .sort((left, right) => left.kind.localeCompare(right.kind));
}

export function thresholdRowsSql(kindCount: number): string {
  if (!Number.isInteger(kindCount) || kindCount < 1)
    throw new RangeError("THRESHOLD_KINDS：至少要有一个登记了门槛的决策类别");
  const placeholders = Array.from({ length: kindCount }, () => "?").join(", ");
  return `SELECT id, kind, COALESCE(outcome, verdict) AS outcome, reason_code AS reasonCode,
      owner_rating AS ownerRating, category, confidence_permille AS score, checked_at AS decidedAt
    FROM decision_ledger
    WHERE owner_id = ? AND agent_id = ? AND checked_at >= ? AND checked_at < ?
      AND kind IN (${placeholders})
    ORDER BY checked_at, id`;
}

export const THRESHOLD_SQL = Object.freeze({
  kindCounts: `SELECT kind, count(*) AS total,
      sum(CASE WHEN owner_rating IS NULL THEN 0 ELSE 1 END) AS rated
    FROM decision_ledger
    WHERE owner_id = ? AND agent_id = ? AND checked_at >= ? AND checked_at < ?
    GROUP BY kind ORDER BY kind`,
});

const RATING_NAMES: Readonly<Record<string, string>> = Object.freeze({
  useful: "有用",
  unneeded: "不需要",
  missed: "漏了",
});

const CHANGE_LABELS: Readonly<Record<ReplayChange, string>> = Object.freeze({
  usefulSilenced: "已评「有用」的会变成沉默",
  unneededBlocked: "已评「不需要」的会被挡住",
  missedCaught: "已评「漏了」的会被补上",
  usefulSilenceBroken: "已评「有用」的沉默会变成开口",
  unneededAdded: "已评「不需要」的会被放进来",
  missedDropped: "已评「漏了」的仍会漏（原来开口，改后沉默）",
});

const CHANGE_ORDER: readonly ReplayChange[] = [
  "usefulSilenced",
  "unneededBlocked",
  "missedCaught",
  "usefulSilenceBroken",
  "unneededAdded",
  "missedDropped",
];

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function formatRate(rate: Proportion): string {
  if (rate.value === null || rate.low === null || rate.high === null)
    return `${rate.successes}/${rate.samples}`;
  return `${percent(rate.value)}（${rate.successes}/${rate.samples}，95% 区间 ${percent(rate.low)}–${percent(rate.high)}）`;
}

function segmentLines(segment: SegmentAnalysis): string[] {
  const title = segment.segment === null ? "全部分类" : `分类 ${segment.segment}`;
  const current = segment.mixedCurrent
    ? `默认门槛 ${segment.current}；下面的门槛值只替换没有单独覆盖的分类，有覆盖的分类保持各自的门槛`
    : `现在的门槛 ${segment.current}`;
  const lines = [`### ${title}（${current}）`, ""];
  if (!segment.enough) {
    lines.push(
      `样本不足：已评价、由这个门槛决定的有 ${segment.adjustable} 条，需要至少 ${segment.required} 条，不给建议值。`,
      "",
    );
    return lines;
  }
  lines.push(
    `已评价样本 ${segment.samples} 条（需要至少 ${segment.required} 条）。现在的门槛下：误扰 ${formatRate(segment.currentPoint.disturbanceRate)}，漏报 ${formatRate(segment.currentPoint.missRate)}。`,
    "",
    "| 门槛 | 误扰 | 漏报 |",
    "| --- | --- | --- |",
  );
  for (const point of segment.table)
    lines.push(
      `| ${point.threshold} | ${formatRate(point.disturbanceRate)} | ${formatRate(point.missRate)} |`,
    );
  lines.push("");
  const sameThreshold = new Map<number, ThresholdSuggestion[]>();
  for (const suggestion of segment.suggestions)
    sameThreshold.set(suggestion.threshold, [
      ...(sameThreshold.get(suggestion.threshold) ?? []),
      suggestion,
    ]);
  for (const group of sameThreshold.values()) {
    const suggestion = group[0];
    if (suggestion === undefined) continue;
    const ratios = group.map((item) => item.missCostRatio).join("、");
    lines.push(
      `**漏一条按多扰 ${ratios} 次算：建议门槛 ${suggestion.threshold}**（现在 ${segment.current}）。误扰 ${formatRate(suggestion.point.disturbanceRate)}，漏报 ${formatRate(suggestion.point.missRate)}。`,
    );
    if (suggestion.flips.length === 0) {
      lines.push("", "按这个门槛重跑过去的记录：没有任何一条已评价的决策会改变结果。", "");
      continue;
    }
    lines.push("", `按这个门槛重跑过去的记录，${suggestion.flips.length} 条会改变结果：`);
    for (const change of CHANGE_ORDER) {
      const flips = suggestion.flips.filter((flip) => flip.change === change);
      if (flips.length === 0) continue;
      lines.push(
        `- ${CHANGE_LABELS[change]}（${flips.length} 条）：${flips.map((flip) => `${flip.id}（分数 ${flip.score}）`).join("、")}`,
      );
    }
    lines.push("");
  }
  return lines;
}

export function thresholdReport({
  window,
  scope,
  analyses,
  ungated,
  required,
  widthLimit,
}: {
  readonly window: { readonly label: string } | null;
  readonly scope: { readonly ownerId: string; readonly agentId: string };
  readonly analyses: readonly GateAnalysis[];
  readonly ungated: readonly UngatedKind[];
  readonly required: number;
  readonly widthLimit: number;
}): string {
  const lines = [
    "# 门槛建议值",
    "",
    `范围：${scope.ownerId}/${scope.agentId}，${window === null ? "全部决策记录" : window.label}。`,
    `样本门槛：至少 ${required} 条已评价决策，这是让任意比例的 95% 区间宽度都不超过 ${percent(widthLimit)} 所需的最少条数（Wilson 区间）。`,
    "误扰 = 按这个门槛会开口、但你评为不该开口的条数；漏报 = 按这个门槛会沉默、但你评为该开口的条数；两者都除以纳入统计的已评价条数（已评价、由门槛决定、有分数、评价和结果对得上；低于门槛但暂存的不算）。",
    "这里只给建议，不会改任何门槛。",
    "",
  ];
  for (const analysis of analyses) {
    lines.push(`## ${analysis.gate.label}（${analysis.gate.key}）`, "");
    const skipped = [
      analysis.unrated > 0 ? `未评价 ${analysis.unrated} 条` : null,
      analysis.notGated > 0 ? `不由这个门槛决定 ${analysis.notGated} 条` : null,
      analysis.ambiguous > 0
        ? `已评价的低于门槛但暂存 ${analysis.ambiguous} 条（${Object.entries(
            analysis.ambiguousRatings,
          )
            .sort(([left], [right]) => (left < right ? -1 : 1))
            .map(([rating, count]) => `评「${RATING_NAMES[rating] ?? rating}」${count} 条`)
            .join("、")}；评价只说明该不该留下，说明不了该不该直接存入）`
        : null,
      analysis.missingScore > 0 ? `没有分数 ${analysis.missingScore} 条` : null,
      analysis.mismatchedRating > 0 ? `评价和结果对不上 ${analysis.mismatchedRating} 条` : null,
    ].filter((item): item is string => item !== null);
    if (skipped.length > 0) lines.push(`没有计入：${skipped.join("，")}。`, "");
    lines.push(...segmentLines(analysis.overall));
    for (const category of analysis.categories) lines.push(...segmentLines(category));
  }
  if (ungated.length > 0) {
    lines.push("## 没有分数门槛的决策类别", "");
    for (const entry of ungated)
      lines.push(
        `- ${entry.kind}：共 ${entry.total} 条，已评价 ${entry.rated} 条。这类决策没有记录分数，画不出门槛曲线。`,
      );
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
