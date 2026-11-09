import { createHash } from "node:crypto";
import type { GapCandidate, ProactiveScope, ProactiveSealPort } from "@himawari-agent/application";
import {
  attributeGap,
  type GapAttribution,
  isGapCase,
  type MuseEntryRow,
} from "@himawari-agent/calibration";

export const GAP_CASE_LIMIT = 50;
const TEXT_LIMIT = 500;
const TITLE_LIMIT = 300;

export interface GapCase {
  readonly id: string;
  readonly museAt: string;
  readonly museTitle: string | null;
  readonly museText: string | null;
  readonly museTextWithheld: boolean;
  readonly himawariOutcome: string;
  readonly himawariReasonCode: string;
  readonly himawariReason: string | null;
  readonly ownerRating: GapCandidate["ownerRating"];
  readonly attribution: GapAttribution;
  readonly memoryHits: number;
  readonly relatedMessages: number;
  readonly decidedAt: string;
}

function clean(text: string, limit: number): string {
  let kept = "";
  for (const character of text.replace(/\p{Cc}+/gu, " ").trim()) {
    if (kept.length + character.length > limit) break;
    kept += character;
  }
  return kept;
}

export function gapCaseId(pairedMessageId: string): string {
  return `gap_${createHash("sha256").update(pairedMessageId).digest("hex").slice(0, 20)}`;
}

export async function buildGapCases(options: {
  readonly scope: ProactiveScope;
  readonly candidates: readonly GapCandidate[];
  readonly seal: ProactiveSealPort | undefined;
}): Promise<readonly GapCase[]> {
  const firstPerMail = new Map<string, GapCandidate>();
  for (const candidate of options.candidates)
    if (!firstPerMail.has(candidate.pairedMessageId))
      firstPerMail.set(candidate.pairedMessageId, candidate);
  const selected = [...firstPerMail.values()]
    .filter((candidate) => {
      const entry: MuseEntryRow = {
        museReminded: true,
        timingOk: candidate.timingOk,
        contentOk: candidate.contentOk,
        pairedMessageId: candidate.pairedMessageId,
      };
      return isGapCase(entry, { outcome: candidate.outcome, ownerRating: candidate.ownerRating });
    })
    .slice(0, GAP_CASE_LIMIT);
  const open = async (ref: string | null, limit: number) => {
    if (ref === null || options.seal === undefined) return null;
    try {
      const text = await options.seal.open({ ...options.scope, ref });
      return text === undefined ? null : clean(text, limit) || null;
    } catch {
      return null;
    }
  };
  return Promise.all(
    selected.map(async (candidate): Promise<GapCase> => {
      const withheld = candidate.museTextWithheld;
      return {
        id: gapCaseId(candidate.pairedMessageId),
        museAt: candidate.museAt,
        museTitle: withheld ? null : await open(candidate.museTitleRef, TITLE_LIMIT),
        museText: withheld
          ? null
          : await open(candidate.museTextRef ?? candidate.museContentRef, TEXT_LIMIT),
        museTextWithheld: withheld,
        himawariOutcome: candidate.outcome,
        himawariReasonCode: candidate.reasonCode,
        himawariReason: await open(candidate.reasonRef, TEXT_LIMIT),
        ownerRating: candidate.ownerRating,
        attribution: attributeGap({
          relatedRead: candidate.relatedRead,
          memoryRecall: candidate.memoryRecall,
          memoryHitsForMail: candidate.memoryHitsForMail,
        }),
        memoryHits: candidate.memoryHitsForMail,
        relatedMessages: candidate.relatedMessagesForMail,
        decidedAt: candidate.decidedAt,
      };
    }),
  );
}
