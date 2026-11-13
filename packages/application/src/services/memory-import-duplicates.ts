import type { ImportDuplicateConfiguration } from "../ports/configuration.js";

export const IMPORT_DUPLICATE_NONE = "none";
export const IMPORT_DUPLICATE_CANDIDATE_NAME_PREFIX = "c";

export type ImportDuplicateVerdict = "same" | "unsure" | "different" | "skipped";

export interface ImportDuplicateAnswer {
  readonly matchKey: string | null;
  readonly probabilityPermille: number;
}

export class ImportDuplicateDecisionFailure extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "ImportDuplicateDecisionFailure";
    this.code = code;
  }
}

export interface ImportDuplicateDecisionPort {
  decide(input: {
    readonly existing: readonly { readonly key: string; readonly text: string }[];
    readonly candidates: readonly { readonly text: string }[];
    readonly signal: AbortSignal;
  }): Promise<readonly (ImportDuplicateAnswer | undefined)[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function failure(code: string): never {
  throw new ImportDuplicateDecisionFailure(code);
}

export function importDuplicateCandidateName(index: number): string {
  return `${IMPORT_DUPLICATE_CANDIDATE_NAME_PREFIX}${index}`;
}

function permille(probability: unknown): number {
  if (
    typeof probability !== "number" ||
    !Number.isFinite(probability) ||
    probability < 0 ||
    probability > 1
  )
    return failure("IMPORT_DUPLICATE_ANSWER_INVALID");
  return Math.round(probability * 1000);
}

function answerFor(value: unknown, name: string, keys: ReadonlySet<string>): ImportDuplicateAnswer {
  if (!isRecord(value) || value["name"] !== name || value["type"] !== "choice")
    return failure("IMPORT_DUPLICATE_ANSWER_INVALID");
  const options = value["probabilities"];
  if (Array.isArray(options)) {
    let best: ImportDuplicateAnswer = { matchKey: null, probabilityPermille: 0 };
    for (const option of options as readonly unknown[]) {
      if (!isRecord(option) || typeof option["value"] !== "string")
        return failure("IMPORT_DUPLICATE_ANSWER_INVALID");
      const probability = permille(option["probability"]);
      if (option["value"] === IMPORT_DUPLICATE_NONE) continue;
      if (!keys.has(option["value"])) return failure("IMPORT_DUPLICATE_ANSWER_INVALID");
      if (probability > best.probabilityPermille)
        best = { matchKey: option["value"], probabilityPermille: probability };
    }
    return best;
  }
  const choice = value["choice"];
  if (typeof choice !== "string") return failure("IMPORT_DUPLICATE_ANSWER_INVALID");
  if (choice === IMPORT_DUPLICATE_NONE) return { matchKey: null, probabilityPermille: 0 };
  if (!keys.has(choice)) return failure("IMPORT_DUPLICATE_ANSWER_INVALID");
  return { matchKey: choice, probabilityPermille: permille(value["confidence"]) };
}

export function parseImportDuplicateAnswers(
  body: unknown,
  model: string,
  candidateCount: number,
  existingKeys: readonly string[],
): readonly (ImportDuplicateAnswer | undefined)[] {
  if (!isRecord(body) || body["model"] !== model) return failure("IMPORT_DUPLICATE_MODEL_MISMATCH");
  const answers = body["answers"];
  if (!Array.isArray(answers) || answers.length !== candidateCount)
    return failure("IMPORT_DUPLICATE_ANSWER_COUNT");
  const keys = new Set(existingKeys);
  return (answers as readonly unknown[]).map((answer, index) => {
    if (isRecord(answer) && answer["type"] === "refusal") return undefined;
    return answerFor(answer, importDuplicateCandidateName(index), keys);
  });
}

export function importDuplicateVerdict(
  answer: ImportDuplicateAnswer | undefined,
  thresholds: Pick<ImportDuplicateConfiguration, "yesAtLeastPermille" | "noAtMostPermille">,
): ImportDuplicateVerdict {
  if (answer === undefined) return "skipped";
  if (answer.matchKey === null) return "different";
  if (answer.probabilityPermille >= thresholds.yesAtLeastPermille) return "same";
  if (answer.probabilityPermille > thresholds.noAtMostPermille) return "unsure";
  return "different";
}
