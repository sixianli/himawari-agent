import type { MemoryIndexDocument } from "@himawari-agent/application";
import type { AgentId, MemoryId, OwnerId } from "@himawari-agent/domain";
import { describe, expect, it } from "vitest";
import { inMemoryMemoryIndex } from "../src/in-memory/memory-index.ts";

const ownerId = "owner" as OwnerId;
const agentId = "agent" as AgentId;

const document = (id: string, vector: readonly number[], terms: readonly string[]) =>
  ({
    memoryId: id as MemoryId,
    ownerId,
    agentId,
    revision: 1,
    terms,
    embedding: { model: "m", dimensions: vector.length, vector: new Float32Array(vector) },
    indexedAt: "2026-11-11T00:00:00.000Z",
  }) as MemoryIndexDocument;

describe("in-memory memory index", () => {
  it("scores by cosine similarity, not by the raw dot product, and skips vectors of another size", async () => {
    const index = inMemoryMemoryIndex();
    await index.upsert(document("long", [3, 4], ["杭州"]));
    await index.upsert(document("wide", [1, 0, 0], ["杭州"]));
    const result = await index.search({
      ownerId,
      agentId,
      embedding: { model: "m", dimensions: 2, vector: new Float32Array([6, 8]) },
      terms: ["杭州"],
      queryText: "杭州",
      limit: 5,
      minimumSimilarity: 0.5,
      now: "2026-11-11T00:00:00.000Z",
    });
    expect(result.vector.map(({ memoryId, signal }) => [memoryId, signal])).toEqual([
      ["long", expect.closeTo(1, 6)],
    ]);
    const lexical = new Map(result.lexical.map((found) => [found.memoryId, found.similarity]));
    expect(lexical.get("long" as MemoryId)).toBeCloseTo(1, 6);
    expect(lexical.has("wide" as MemoryId)).toBe(true);
    expect(lexical.get("wide" as MemoryId)).toBeUndefined();
  });
});
