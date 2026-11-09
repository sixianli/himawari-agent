import type { MemoryEpisode, MemoryEpisodeStorePort } from "@himawari-agent/application";
import { createAgentId, createOwnerId, createThreadId } from "@himawari-agent/domain";
import { describe, expect, it } from "vitest";
import { MemoryEpisodeService } from "../src/episodes.ts";

const OWNER_ID = createOwnerId("owner-episode-backfill");
const AGENT_ID = createAgentId("agent-episode-backfill");

function episode(id: string, dataClassification: MemoryEpisode["dataClassification"]) {
  return {
    id,
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    threadId: createThreadId("thread-episode-backfill"),
    day: "2026-11-08",
    source: "thread",
    contentRef: `payload-${id}`,
    dataClassification,
    firstSequence: 1,
    lastSequence: 2,
    startedAt: "2026-11-08T01:00:00.000Z",
    endedAt: "2026-11-08T02:00:00.000Z",
    createdAt: "2026-11-08T03:00:00.000Z",
  } as unknown as MemoryEpisode;
}

describe("[RULE-memory-visible] episode embedding backfill", () => {
  it("embeds each summary under its own classification and never embeds a restricted one", async () => {
    const attached: string[] = [];
    const embedded: string[] = [];
    const store = {
      listUnembedded: async () => [
        episode("ep-health", "sensitive"),
        episode("ep-coffee", "private"),
        episode("ep-secret", "restricted"),
      ],
      attachEmbedding: async ({ episodeId }: { episodeId: string }) => {
        attached.push(episodeId);
      },
    } as unknown as MemoryEpisodeStorePort;
    const service = new MemoryEpisodeService({
      store,
      threads: { listMessages: async () => [] } as never,
      readText: async ({ ref }) => `text of ${ref}`,
      storeText: async () => undefined,
      embedder: {
        model: "fixture-embedder",
        dimensions: 2,
        embed: async (text: string) => {
          embedded.push(text);
          return new Float32Array([1, 0]);
        },
      },
      now: () => "2026-11-09T00:00:00.000Z",
    });
    const scopes: string[] = [];
    const count = await service.backfillEmbeddings({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      limit: 5,
      within: (dataClassification, operation) => {
        scopes.push(dataClassification);
        return operation();
      },
    });
    expect(count).toBe(2);
    expect(scopes).toEqual(["sensitive", "private"]);
    expect(attached).toEqual(["ep-health", "ep-coffee"]);
    expect(embedded.some((text) => text.includes("ep-secret"))).toBe(false);
  });
});
