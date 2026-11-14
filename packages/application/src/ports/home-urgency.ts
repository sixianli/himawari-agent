import type { DataClassification } from "./common.js";
import type { ProactiveScope } from "./proactive-checks.js";

export const HOME_URGENCY_SCORE_MAX = 1000;
export const HOME_URGENCY_LABEL_STORE_MAX = 64;
export const HOME_URGENCY_ITEMS_PER_READ = 2_000;

export interface HomeUrgencyItemRef {
  readonly itemKey: string;
  readonly textDigest: string;
}

export interface HomeUrgencyAttempt extends HomeUrgencyItemRef {
  readonly id: string;
  readonly invocationId: string;
  readonly approvalRequestId: string | null;
  readonly modelRef: string;
  readonly promptId: string;
  readonly dataClassification: Exclude<DataClassification, "restricted">;
  readonly costMicros: number;
  readonly durationMs: number;
  readonly createdAt: string;
}

export interface HomeUrgencyRecord extends HomeUrgencyAttempt {
  readonly score: number;
  readonly sentenceRef: string | null;
  readonly affirmLabel: string | null;
  readonly copyLocale: string | null;
}

export interface HomeUrgencyFailure extends HomeUrgencyAttempt {
  readonly failureCode: string;
}

export interface HomeUrgencyScore extends HomeUrgencyItemRef {
  readonly score: number;
  readonly approvalRequestId: string | null;
  readonly sentenceRef: string | null;
  readonly affirmLabel: string | null;
  readonly copyLocale: string | null;
}

export interface HomeUrgencyStorePort {
  listScores(
    input: ProactiveScope & { readonly items: readonly HomeUrgencyItemRef[] },
  ): Promise<readonly HomeUrgencyScore[]>;
  listRecentFailures(
    input: ProactiveScope & {
      readonly items: readonly HomeUrgencyItemRef[];
      readonly since: string;
    },
  ): Promise<readonly HomeUrgencyItemRef[]>;
  countSince(input: ProactiveScope & { readonly since: string }): Promise<{
    readonly calls: number;
    readonly costMicros: number;
  }>;
  recordCall(
    input: ProactiveScope & {
      readonly records: readonly HomeUrgencyRecord[];
      readonly failures: readonly HomeUrgencyFailure[];
    },
  ): Promise<void>;
}
