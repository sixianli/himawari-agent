import {
  APPLICABLE_RATINGS,
  type CalibrationDatabase,
  type CalibrationGroup,
  type CalibrationRating,
  formatProportion,
  groupLabel,
  MAIN_CALIBRATION_GROUPS,
  type Proportion,
  proportion,
  ratingLabel,
  wilsonInterval,
} from "./index.ts";

export const PREREVIEW_RATINGS = ["useful", "unneeded", "missed", "unsure"] as const;
export type PrereviewRating = (typeof PREREVIEW_RATINGS)[number];

export const PREREVIEW_GROUPS: readonly CalibrationGroup[] = MAIN_CALIBRATION_GROUPS;

export const DEFAULT_PREREVIEW_CONFIDENCE_PERMILLE = 800;
export const DEFAULT_PREREVIEW_AGREEMENT_PERMILLE = 900;
export const DEFAULT_PREREVIEW_AUDIT_PERMILLE = 200;
export const DEFAULT_PREREVIEW_HISTORY_DAYS = 28;
export const DEFAULT_PREREVIEW_HISTORY_MINIMUM = 20;

export function isPrereviewGroup(group: CalibrationGroup | null): group is CalibrationGroup {
  return group !== null && PREREVIEW_GROUPS.includes(group);
}

export function prereviewOptions(group: CalibrationGroup): readonly PrereviewRating[] {
  return [...APPLICABLE_RATINGS[group], "unsure"];
}

export function acceptsPrereview(
  group: CalibrationGroup,
  rating: string,
): rating is PrereviewRating {
  return (prereviewOptions(group) as readonly string[]).includes(rating);
}

export interface PrereviewPair {
  readonly group: CalibrationGroup;
  readonly model: PrereviewRating;
  readonly confidencePermille: number;
  readonly historyConflict: boolean;
  readonly owner: CalibrationRating | null;
}

export function wouldHide(
  pair: Pick<PrereviewPair, "model" | "confidencePermille" | "historyConflict">,
  confidencePermille: number,
): boolean {
  return (
    pair.model === "useful" &&
    pair.confidencePermille >= confidencePermille &&
    !pair.historyConflict
  );
}

export function historyConflict(
  model: PrereviewRating,
  history: readonly CalibrationRating[],
  minimum: number,
): boolean {
  if (model !== "useful" || history.length < minimum) return false;
  const counts = new Map<CalibrationRating, number>();
  for (const rating of history) counts.set(rating, (counts.get(rating) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1]);
  const [first, second] = ranked;
  if (first === undefined || (second !== undefined && second[1] === first[1])) return false;
  return first[0] !== "useful";
}

export interface PrereviewConfusion {
  readonly model: CalibrationRating;
  readonly owner: CalibrationRating;
  readonly count: number;
}

export interface PrereviewGroupAgreement {
  readonly group: CalibrationGroup;
  readonly prereviewed: number;
  readonly unsure: number;
  readonly paired: number;
  readonly agreement: Proportion;
  readonly kappa: number | null;
  readonly balancedAccuracy: number | null;
  readonly ownerUseful: Proportion;
  readonly confusion: readonly PrereviewConfusion[];
  readonly hidden: Proportion;
  readonly gate: PrereviewGate;
}

export type PrereviewGateReason =
  | "open"
  | "insufficient"
  | "below_threshold"
  | "not_above_baseline";

export interface PrereviewGate {
  readonly open: boolean;
  readonly reason: PrereviewGateReason;
  readonly requiredAgreement: number | null;
}

export interface PrereviewGateOptions {
  readonly agreementPermille: number;
  readonly confidencePermille: number;
}

function cohenKappa(
  pairs: readonly { readonly model: CalibrationRating; readonly owner: CalibrationRating }[],
  labels: readonly CalibrationRating[],
): number | null {
  const total = pairs.length;
  if (total === 0) return null;
  const observed = pairs.filter((pair) => pair.model === pair.owner).length / total;
  const expected = labels.reduce((sum, label) => {
    const modelShare = pairs.filter((pair) => pair.model === label).length / total;
    const ownerShare = pairs.filter((pair) => pair.owner === label).length / total;
    return sum + modelShare * ownerShare;
  }, 0);
  if (expected >= 1) return null;
  return (observed - expected) / (1 - expected);
}

function balancedAccuracy(
  pairs: readonly { readonly model: CalibrationRating; readonly owner: CalibrationRating }[],
  labels: readonly CalibrationRating[],
): number | null {
  const recalls = labels.flatMap((label) => {
    const ofLabel = pairs.filter((pair) => pair.owner === label);
    return ofLabel.length === 0
      ? []
      : [ofLabel.filter((pair) => pair.model === label).length / ofLabel.length];
  });
  if (recalls.length < labels.length) return null;
  return recalls.reduce((sum, recall) => sum + recall, 0) / recalls.length;
}

export function minimumAgreementToPass(samples: number, agreementPermille: number): number | null {
  const threshold = agreementPermille / 1000;
  for (let successes = 0; successes <= samples; successes += 1) {
    const interval = wilsonInterval(successes, samples);
    if (interval !== null && interval.low >= threshold) return successes / samples;
  }
  return null;
}

export function prereviewGate(
  hidden: Proportion,
  ownerUseful: Proportion,
  agreementPermille: number,
): PrereviewGate {
  const requiredAgreement = minimumAgreementToPass(hidden.samples, agreementPermille);
  if (hidden.samples === 0 || hidden.low === null)
    return { open: false, reason: "insufficient", requiredAgreement };
  if (hidden.low < agreementPermille / 1000)
    return {
      open: false,
      reason: requiredAgreement === null ? "insufficient" : "below_threshold",
      requiredAgreement,
    };
  if (ownerUseful.high === null || hidden.low <= ownerUseful.high)
    return { open: false, reason: "not_above_baseline", requiredAgreement };
  return { open: true, reason: "open", requiredAgreement };
}

export function summarizePrereviewAgreement(
  pairs: readonly PrereviewPair[],
  options: PrereviewGateOptions,
): readonly PrereviewGroupAgreement[] {
  return PREREVIEW_GROUPS.map((group) => {
    const labels = APPLICABLE_RATINGS[group];
    const ofGroup = pairs.filter((pair) => pair.group === group);
    const decided = ofGroup.flatMap((pair) =>
      pair.model !== "unsure" &&
      pair.owner !== null &&
      labels.includes(pair.model) &&
      labels.includes(pair.owner)
        ? [{ model: pair.model, owner: pair.owner }]
        : [],
    );
    const rated = ofGroup.filter((pair) => pair.owner !== null && labels.includes(pair.owner));
    const hiddenRated = rated.filter((pair) => wouldHide(pair, options.confidencePermille));
    const hidden = proportion(
      hiddenRated.filter((pair) => pair.owner === "useful").length,
      hiddenRated.length,
      1,
    );
    const ownerUseful = proportion(
      rated.filter((pair) => pair.owner === "useful").length,
      rated.length,
      1,
    );
    return {
      group,
      prereviewed: ofGroup.length,
      unsure: ofGroup.filter((pair) => pair.model === "unsure").length,
      paired: decided.length,
      agreement: proportion(
        decided.filter((pair) => pair.model === pair.owner).length,
        decided.length,
      ),
      kappa: cohenKappa(decided, labels),
      balancedAccuracy: balancedAccuracy(decided, labels),
      ownerUseful,
      confusion: labels.flatMap((model) =>
        labels.map((owner) => ({
          model,
          owner,
          count: decided.filter((pair) => pair.model === model && pair.owner === owner).length,
        })),
      ),
      hidden,
      gate: prereviewGate(hidden, ownerUseful, options.agreementPermille),
    };
  });
}

export interface PrereviewWeekRow extends PrereviewPair {
  readonly modelRef: string;
  readonly promptId: string;
  readonly createdAt: string;
}

export const PREREVIEW_WEEK_SQL = `SELECT p.calibration_group AS "group", p.rating AS model,
    p.confidence_permille AS confidencePermille, p.history_conflict AS historyConflict,
    CASE WHEN p.decision_id IS NOT NULL THEN d.owner_rating
      ELSE COALESCE(m.owner_rating, CASE WHEN m.reviewed_at IS NOT NULL THEN 'useful' END) END
      AS owner,
    p.model_ref AS modelRef, p.prompt_id AS promptId, p.created_at AS createdAt
  FROM decision_prereviews p
  LEFT JOIN decision_ledger d ON d.id = p.decision_id
  LEFT JOIN proactive_processed_messages m
    ON m.owner_id = p.owner_id AND m.agent_id = p.agent_id
    AND m.source = p.mail_source AND m.message_id = p.message_id
  WHERE p.owner_id = ? AND p.agent_id = ? AND p.status = 'done'
    AND COALESCE(d.checked_at, m.processed_at) >= ? AND COALESCE(d.checked_at, m.processed_at) < ?
  ORDER BY p.created_at, p.id`;

export function readPrereviewWeek(
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
): readonly PrereviewWeekRow[] {
  const exists = database
    .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get("decision_prereviews") as { n: number };
  if (exists.n === 0) return [];
  return (
    database.prepare(PREREVIEW_WEEK_SQL).all(ownerId, agentId, start, end) as (Omit<
      PrereviewWeekRow,
      "historyConflict"
    > & { historyConflict: number })[]
  ).map((row) => ({ ...row, historyConflict: row.historyConflict === 1 }));
}

export interface PrereviewWeekSummary {
  readonly version: { readonly modelRef: string; readonly promptId: string } | null;
  readonly otherVersions: number;
  readonly options: PrereviewGateOptions;
  readonly groups: readonly PrereviewGroupAgreement[];
}

export function summarizePrereviewWeek(
  rows: readonly PrereviewWeekRow[],
  options: PrereviewGateOptions,
): PrereviewWeekSummary {
  const latest = rows.reduce<PrereviewWeekRow | undefined>(
    (found, row) => (found === undefined || row.createdAt >= found.createdAt ? row : found),
    undefined,
  );
  const current = latest
    ? rows.filter((row) => row.modelRef === latest.modelRef && row.promptId === latest.promptId)
    : [];
  return {
    version: latest ? { modelRef: latest.modelRef, promptId: latest.promptId } : null,
    otherVersions: rows.length - current.length,
    options,
    groups: summarizePrereviewAgreement(current, options),
  };
}

const GATE_TEXT: Readonly<Record<PrereviewGateReason, string>> = {
  open: "已达标",
  insufficient: "对数不够",
  below_threshold: "没达到门槛",
  not_above_baseline: "没比照着你的习惯猜更准",
};

function percent(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

export function prereviewReportLines(summary: PrereviewWeekSummary): string[] {
  const lines: string[] = ["## 模型预评一致率", ""];
  lines.push(
    `每天打分的条目，Himawari 先让模型按同样的选项（加一个“拿不准”）评一遍，单独存放，不写进你的评价。这里按你的评价算两边意见一致的比例。只算这一周内做出的决策、模型这一版提示词的预评；“拿不准”不进分母，单独列条数。一致率区间是 95% Wilson 区间；kappa 是扣掉碰巧一致之后的一致程度（0 是和瞎猜一样，1 是完全一致）；均衡准确率是两种评价各自猜对的比例取平均。减量门槛：模型评“有用”、把握度不低于 ${summary.options.confidencePermille / 10}%、又不和你的历史评价相反的那部分，你也评“有用”的比例，95% 区间下限要不低于 ${summary.options.agreementPermille / 10}%，还要高于你在这一组评“有用”比例的上限。`,
    "",
  );
  if (summary.version === null) {
    lines.push("这一周没有模型预评。", "");
    return lines;
  }
  if (summary.otherVersions > 0)
    lines.push(
      `另有 ${summary.otherVersions} 条是旧版提示词或别的模型做的预评，不进下面的统计。`,
      "",
    );
  lines.push(
    "| 决策类型 | 预评条数 | 拿不准 | 你也评过的 | 一致率 | kappa | 均衡准确率 | 会被藏起来的那部分里你评有用 | 减量门槛 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const row of summary.groups) {
    const required =
      row.gate.requiredAgreement === null
        ? `至少要 ${minimumPairsToPass(summary.options.agreementPermille)} 对全对`
        : `这么多对至少要 ${percent(row.gate.requiredAgreement)}`;
    lines.push(
      `| ${groupLabel(row.group)} | ${row.prereviewed} | ${row.unsure} | ${row.paired} | ${formatProportion(row.agreement)} | ${row.kappa === null ? "—" : row.kappa.toFixed(2)} | ${percent(row.balancedAccuracy)} | ${formatProportion(row.hidden)} | ${GATE_TEXT[row.gate.reason]}（${required}） |`,
    );
  }
  lines.push("");
  const confusion = summary.groups.filter((row) => row.paired > 0);
  if (confusion.length > 0) {
    lines.push("对照表（行是模型的评价，列是你的评价）：", "");
    for (const row of confusion) {
      const labels = APPLICABLE_RATINGS[row.group];
      lines.push(
        `- ${groupLabel(row.group)}：${labels
          .flatMap((model) =>
            labels.map(
              (owner) =>
                `模型“${ratingLabel(row.group, model) ?? model}”/你“${ratingLabel(row.group, owner) ?? owner}” ${row.confusion.find((cell) => cell.model === model && cell.owner === owner)?.count ?? 0}`,
            ),
          )
          .join("；")}`,
      );
    }
    lines.push("");
  }
  return lines;
}

export function minimumPairsToPass(agreementPermille: number): number {
  for (let samples = 1; samples <= 10_000; samples += 1)
    if (minimumAgreementToPass(samples, agreementPermille) !== null) return samples;
  return Number.POSITIVE_INFINITY;
}
