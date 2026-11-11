import type { CalibrationGroup, CalibrationRating } from "@himawari-agent/calibration";
import type { PrereviewRating } from "@himawari-agent/calibration/prereview";
import type { DataClassification } from "./common.js";
import type { ProactiveScope } from "./proactive-checks.js";

export type PrereviewSubjectRef =
  | { readonly source: "ledger"; readonly id: string }
  | { readonly source: "mail"; readonly id: string };

export interface PrereviewAttempt {
  readonly id: string;
  readonly subject: PrereviewSubjectRef;
  readonly group: CalibrationGroup;
  readonly category: string | null;
  readonly modelRef: string;
  readonly promptId: string;
  readonly textDigest: string;
  readonly dataClassification: DataClassification;
  readonly costMicros: number;
  readonly durationMs: number;
  readonly createdAt: string;
}

export interface PrereviewRecord extends PrereviewAttempt {
  readonly rating: PrereviewRating;
  readonly confidencePermille: number;
  readonly historyConflict: boolean;
}

export interface PrereviewFailure extends PrereviewAttempt {
  readonly failureCode: string;
}

export interface PrereviewDone {
  readonly subject: PrereviewSubjectRef;
  readonly group: CalibrationGroup;
  readonly rating: PrereviewRating;
  readonly confidencePermille: number;
  readonly historyConflict: boolean;
  readonly textDigest: string;
}

export interface PrereviewPairRecord {
  readonly group: CalibrationGroup;
  readonly rating: PrereviewRating;
  readonly confidencePermille: number;
  readonly historyConflict: boolean;
  readonly ownerRating: CalibrationRating | null;
}

export interface PrereviewVersion {
  readonly modelRef: string;
  readonly promptId: string;
}

export interface ReviewPrereviewStorePort {
  listDone(
    input: ProactiveScope &
      PrereviewVersion & {
        readonly subjects: readonly PrereviewSubjectRef[];
      },
  ): Promise<readonly PrereviewDone[]>;
  listRecentFailures(
    input: ProactiveScope &
      PrereviewVersion & {
        readonly subjects: readonly PrereviewSubjectRef[];
        readonly since: string;
      },
  ): Promise<readonly PrereviewSubjectRef[]>;
  countSince(input: ProactiveScope & { readonly since: string }): Promise<{
    readonly attempts: number;
    readonly costMicros: number;
  }>;
  ownerHistory(
    input: ProactiveScope & {
      readonly group: CalibrationGroup;
      readonly category: string | null;
      readonly since: string;
    },
  ): Promise<readonly CalibrationRating[]>;
  listPairs(
    input: ProactiveScope & PrereviewVersion & { readonly since: string },
  ): Promise<readonly PrereviewPairRecord[]>;
  record(input: ProactiveScope & PrereviewRecord): Promise<void>;
  recordFailure(input: ProactiveScope & PrereviewFailure): Promise<void>;
}
