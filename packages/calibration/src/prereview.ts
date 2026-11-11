import {
  APPLICABLE_RATINGS,
  type CalibrationGroup,
  type CalibrationRating,
  MAIN_CALIBRATION_GROUPS,
  type Proportion,
  proportion,
  wilsonInterval,
} from "./index.js";

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
