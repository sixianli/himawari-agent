export interface EvalMemoryExpectation {
  readonly keyFacts: readonly (readonly string[])[];
  readonly decision: "create" | "update" | "supersede" | "unchanged";
  readonly classification: string;
  readonly category: string | null;
  readonly dueAtPrefix: string | null;
  readonly existingMemoryId: string | null;
}

export interface EvalItem {
  readonly id: string;
  readonly lang: string;
  readonly group: string;
  readonly message: string;
  readonly previousAssistantMessage: string | null;
  readonly existingMemories: readonly {
    readonly id: string;
    readonly text: string;
    readonly stance: string | null;
  }[];
  readonly sentAt: string;
  readonly expect: {
    readonly remember: boolean;
    readonly memories: readonly EvalMemoryExpectation[];
    readonly forbiddenText?: readonly string[];
  };
}

export interface EvalDataset {
  readonly version: number;
  readonly items: readonly EvalItem[];
}

export interface EvalCandidate {
  readonly text: string;
  readonly decision: string;
  readonly classification: string;
  readonly category?: string;
  readonly dueAt?: string | null;
  readonly existingMemoryId?: string | null;
}

export interface EvalResult {
  readonly id: string;
  readonly candidates: readonly EvalCandidate[];
}

export interface EvalScore {
  readonly items: readonly Record<string, unknown>[];
  readonly positives: number;
  readonly negatives: number;
  readonly recall: number | null;
  readonly memoryRecall: number | null;
  readonly embeddedRecall: number | null;
  readonly falseMemoryRate: number | null;
  readonly secretLeaks: number;
  readonly sensitiveDowngrades: number;
  readonly decisionAccuracy: number | null;
  readonly classificationAccuracy: number | null;
  readonly dueAtAccuracy: number | null;
  readonly extraCandidates: number;
}

export function scoreItem(
  item: EvalItem,
  candidates: readonly EvalCandidate[],
): Record<string, unknown>;
export function scoreRun(dataset: EvalDataset, results: readonly EvalResult[]): EvalScore;
export function scoreStable(
  dataset: EvalDataset,
  runs: readonly (readonly EvalResult[])[],
): { readonly runs: readonly EvalScore[]; readonly passAll: number | null };
export function validateDataset(dataset: EvalDataset): string[];
