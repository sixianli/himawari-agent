import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BenchmarkSample, QuestionOutcome } from "./datasets.ts";
import type { StoreStatistics } from "./store.ts";

export type StoreLine = StoreStatistics & { readonly id: string; readonly benchmark: string };
export interface EarlierRound {
  readonly spentUsd: number;
  readonly outcomes: readonly QuestionOutcome[];
  readonly stores: readonly StoreLine[];
}

async function readLines<T>(file: string): Promise<T[]> {
  const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

export async function readEarlierRound(output: string): Promise<EarlierRound> {
  const progress = await readFile(path.join(output, "progress.json"), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  const spentUsd = progress === null ? 0 : Number(JSON.parse(progress).spentUsd);
  if (!Number.isFinite(spentUsd) || spentUsd < 0) throw new Error("BENCH_PROGRESS_INVALID");
  return {
    spentUsd,
    outcomes: await readLines<QuestionOutcome>(path.join(output, "outcomes.jsonl")),
    stores: await readLines<StoreLine>(path.join(output, "stores.jsonl")),
  };
}

export function finishedSamples(
  samples: readonly BenchmarkSample[],
  earlier: EarlierRound,
  fullContext: boolean,
): Set<string> {
  const arms: QuestionOutcome["arm"][] = fullContext ? ["memory", "full-context"] : ["memory"];
  const answered = new Set(
    earlier.outcomes.map(
      (outcome) => `${outcome.sampleId}\u0000${outcome.questionId}\u0000${outcome.arm}`,
    ),
  );
  const storeIds = new Set(earlier.stores.map(({ id }) => id));
  return new Set(
    samples
      .filter(
        (sample) =>
          sample.stores.every(({ id }) => storeIds.has(id)) &&
          sample.questions.every((question) =>
            arms.every((arm) => answered.has(`${sample.id}\u0000${question.id}\u0000${arm}`)),
          ),
      )
      .map(({ id }) => id),
  );
}
