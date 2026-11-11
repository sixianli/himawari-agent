import type { MemoryIndexCandidate, MemoryIndexSearchResult } from "@himawari-agent/application";
import type { MemoryId } from "@himawari-agent/domain";
import { DEFAULT_RELEVANCE_TUNING, fuseCandidates } from "@himawari-agent/memory-engine";
import { describe, expect, it } from "vitest";
import candidates from "../../../evals/memory-retrieval/candidates-qwen3-embedding-8b.json" with {
  type: "json",
};
import evalDataset from "../../../evals/memory-retrieval/dataset.json" with { type: "json" };

type Row = readonly [string, number] | readonly [string, number, number];

interface Fixture {
  readonly minimumSimilarity: number;
  readonly memories: Record<string, Omit<MemoryIndexCandidate, "memoryId" | "revision" | "signal">>;
  readonly queries: Record<
    string,
    { readonly vector: Row[]; readonly lexical: Row[]; readonly entity: Row[] }
  >;
}

interface Dataset {
  readonly today: string;
  readonly queries: readonly { readonly text: string; readonly expected: readonly string[] }[];
}

const fixture = candidates as unknown as Fixture;
const dataset = evalDataset as unknown as Dataset;
const SELECTED_LIMIT = 5;

function result(text: string): MemoryIndexSearchResult {
  const recorded = fixture.queries[text];
  if (!recorded) throw new Error(`fixture is missing ${text}`);
  const candidate = ([memoryId, signal, similarity]: Row): MemoryIndexCandidate => {
    const memory = fixture.memories[memoryId];
    if (!memory) throw new Error(`fixture is missing memory ${memoryId}`);
    return {
      ...memory,
      memoryId: memoryId as MemoryId,
      revision: 1,
      signal,
      ...(similarity === undefined ? {} : { similarity }),
    };
  };
  return {
    vector: recorded.vector.map(candidate),
    lexical: recorded.lexical.map(candidate),
    entity: recorded.entity.map(candidate),
    vectorEngine: "sqlite-vec",
  };
}

function measure(cutoff: boolean) {
  let expected = 0;
  let found = 0;
  let returned = 0;
  let correct = 0;
  let unrelatedQueriesWithMemory = 0;
  let unrelatedMemories = 0;
  for (const query of dataset.queries) {
    const hits = fuseCandidates(result(query.text), {
      now: dataset.today,
      limit: SELECTED_LIMIT,
      ...(cutoff
        ? {
            cutoff: {
              minimumScore: fixture.minimumSimilarity - DEFAULT_RELEVANCE_TUNING.cutoffMargin,
              keywordWeight: DEFAULT_RELEVANCE_TUNING.keywordWeight,
              entityWeight: DEFAULT_RELEVANCE_TUNING.entityWeight,
            },
          }
        : {}),
    }).map(({ memoryId }) => memoryId as string);
    if (query.expected.length === 0) {
      if (hits.length > 0) unrelatedQueriesWithMemory += 1;
      unrelatedMemories += hits.length;
      continue;
    }
    expected += query.expected.length;
    found += query.expected.filter((id) => hits.includes(id)).length;
    returned += hits.length;
    correct += hits.filter((id) => query.expected.includes(id)).length;
  }
  return {
    recall: found / expected,
    precision: correct / returned,
    unrelatedQueriesWithMemory,
    unrelatedMemories,
  };
}

describe("[P3-3] relevance cutoff on the recorded retrieval evaluation", () => {
  it("raises precision and loses at most 2 points of recall@5 with the default tuning", () => {
    const before = measure(false);
    const after = measure(true);
    expect(after.precision).toBeGreaterThan(before.precision);
    expect(before.recall - after.recall).toBeLessThanOrEqual(0.02);
    expect(after.unrelatedQueriesWithMemory).toBeLessThanOrEqual(before.unrelatedQueriesWithMemory);
    expect(after.unrelatedMemories).toBeLessThanOrEqual(before.unrelatedMemories);
  });

  it("REVERSE: a cutoff at the vector floor with no keyword or entity bonus loses far more recall", () => {
    let expected = 0;
    let found = 0;
    for (const query of dataset.queries) {
      if (query.expected.length === 0) continue;
      const hits = fuseCandidates(result(query.text), {
        now: dataset.today,
        limit: SELECTED_LIMIT,
        cutoff: { minimumScore: fixture.minimumSimilarity, keywordWeight: 0, entityWeight: 0 },
      }).map(({ memoryId }) => memoryId as string);
      expected += query.expected.length;
      found += query.expected.filter((id) => hits.includes(id)).length;
    }
    expect(measure(false).recall - found / expected).toBeGreaterThan(0.02);
  });
});
