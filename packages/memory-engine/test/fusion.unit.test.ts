import type { MemoryIndexCandidate } from "@himawari-agent/application";
import type { MemoryId } from "@himawari-agent/domain";
import { describe, expect, it } from "vitest";
import { fuseCandidates } from "../src/fusion.ts";

const now = "2026-10-25T00:00:00.000Z";

function candidate(
  id: string,
  overrides: Partial<MemoryIndexCandidate> = {},
): MemoryIndexCandidate {
  return {
    memoryId: id as MemoryId,
    revision: 1,
    importancePermille: 500,
    confidencePermille: 500,
    updatedAt: now,
    lastUsedAt: null,
    signal: 1,
    startsAt: now,
    endsAt: null,
    current: true,
    ...overrides,
  };
}

describe("reciprocal rank fusion", () => {
  it("ranks a memory found by several signals above one found by a single signal", () => {
    const hits = fuseCandidates(
      {
        vector: [candidate("a"), candidate("b")],
        lexical: [candidate("b")],
        entity: [candidate("b")],
        vectorEngine: "sqlite-vec",
      },
      { now, limit: 5 },
    );
    expect(hits.map(({ memoryId }) => memoryId)).toEqual(["b", "a"]);
    expect(hits[0]?.sources).toEqual(["vector", "lexical", "entity"]);
  });

  it("breaks rank ties with importance and recency", () => {
    const hits = fuseCandidates(
      {
        vector: [],
        lexical: [
          candidate("old", { updatedAt: "2025-01-01T00:00:00.000Z", importancePermille: 500 }),
        ],
        entity: [candidate("new", { importancePermille: 900 })],
        vectorEngine: "none",
      },
      { now, limit: 5 },
    );
    expect(hits.map(({ memoryId }) => memoryId)).toEqual(["new", "old"]);
  });

  it("limits the number of fused hits", () => {
    const hits = fuseCandidates(
      {
        vector: [candidate("a"), candidate("b"), candidate("c")],
        lexical: [],
        entity: [],
        vectorEngine: "javascript",
      },
      { now, limit: 2 },
    );
    expect(hits).toHaveLength(2);
  });

  it("boosts a memory whose validity overlaps the asked time window", () => {
    const hits = fuseCandidates(
      {
        vector: [
          candidate("tokyo", { startsAt: "2026-05-01T00:00:00.000Z" }),
          candidate("osaka", {
            startsAt: "2025-01-01T00:00:00.000Z",
            endsAt: "2025-12-31T00:00:00.000Z",
            current: false,
          }),
        ],
        lexical: [],
        entity: [],
        vectorEngine: "javascript",
      },
      {
        now,
        limit: 2,
        scope: {
          includeHistory: true,
          from: "2025-03-01T00:00:00.000Z",
          to: "2025-03-31T23:59:59.999Z",
        },
      },
    );
    expect(hits.map(({ memoryId }) => memoryId)).toEqual(["osaka", "tokyo"]);
  });
});
