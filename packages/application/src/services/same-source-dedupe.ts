const SHORT_TEXT_CHARACTERS = 8;
const NEAR_DUPLICATE_DICE = 0.9;

function normalized(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\p{Z}\s]/gu, "");
}

const NUMBER_RUN =
  /[+\-\u2212]?\p{Nd}+|[〇零一二两三四五六七八九十百千万亿壹贰叁肆伍陆柒捌玖拾佰仟]+/gu;

function numberRuns(text: string): string {
  return (text.normalize("NFKC").match(NUMBER_RUN) ?? []).join(",");
}

function trigrams(text: string): Map<string, number> {
  const characters = [...text];
  const counts = new Map<string, number>();
  for (let index = 0; index + 3 <= characters.length; index += 1) {
    const gram = characters.slice(index, index + 3).join("");
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

export function nearDuplicateText(left: string, right: string): boolean {
  if (numberRuns(left) !== numberRuns(right)) return false;
  const a = normalized(left);
  const b = normalized(right);
  if (a === b) return true;
  if ([...a].length < SHORT_TEXT_CHARACTERS || [...b].length < SHORT_TEXT_CHARACTERS) return false;
  const leftGrams = trigrams(a);
  const rightGrams = trigrams(b);
  let shared = 0;
  let total = 0;
  for (const [gram, count] of leftGrams) {
    shared += Math.min(count, rightGrams.get(gram) ?? 0);
    total += count;
  }
  for (const count of rightGrams.values()) total += count;
  return total > 0 && (2 * shared) / total >= NEAR_DUPLICATE_DICE;
}

export interface SameSourceCandidate {
  readonly id: string;
  readonly sourceRefs: readonly string[];
  readonly contentRef: string;
}

export async function dropSameSourceDuplicates<T extends SameSourceCandidate>(
  ranked: readonly T[],
  limit: number,
  readText: (contentRef: string) => Promise<string>,
): Promise<readonly T[]> {
  const texts = new Map<string, Promise<string | null>>();
  const text = (contentRef: string) => {
    let found = texts.get(contentRef);
    if (!found) {
      found = readText(contentRef).catch(() => null);
      texts.set(contentRef, found);
    }
    return found;
  };
  const kept: T[] = [];
  for (const candidate of ranked) {
    if (kept.length >= limit) break;
    const sources = new Set(candidate.sourceRefs);
    let duplicate = false;
    for (const earlier of kept) {
      if (!earlier.sourceRefs.some((source) => sources.has(source))) continue;
      const [left, right] = await Promise.all([
        text(earlier.contentRef),
        text(candidate.contentRef),
      ]);
      if (left !== null && right !== null && nearDuplicateText(left, right)) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) kept.push(candidate);
  }
  return kept;
}
