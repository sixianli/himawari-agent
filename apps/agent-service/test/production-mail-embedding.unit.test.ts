import { describe, expect, it } from "vitest";
import { createProactiveMemoryRecall } from "../src/production-proactive-memory.ts";
import { createProductionRunMemory } from "../src/production-run-memory.ts";

const OWNER_ID = "owner-mail-embedding" as never;
const AGENT_ID = "agent-mail-embedding" as never;
const NOW = "2026-11-01T00:00:00.000Z";
const LATER = "2026-11-01T00:03:00.000Z";

const configuration = {
  ownerId: OWNER_ID,
  agentId: AGENT_ID,
  deadlines: { providerRequestMs: 30_000 },
  memory: { dimensions: 4 },
  secretReferences: [],
  modelDescriptors: [
    {
      ref: "model-embedding",
      role: "embedding",
      provider: "vercel-ai-gateway",
      model: "alibaba/qwen3-embedding-8b",
      version: "catalog-2026-10-06",
      capabilities: ["embedding"],
      cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0 },
      allowedDataClassifications: ["private"],
      disclosure: "trusted_remote",
      secretRef: "vercel-ai-gateway-api-key",
    },
  ],
} as never;

function response() {
  return {
    data: [{ index: 0, embedding: [0.1, 0.2, 0.3, 0.4] }],
    model: "alibaba/qwen3-embedding-8b",
    providerMetadata: {
      gateway: { cost: "0.00000019", generationId: "g", routing: { finalProvider: "deepinfra" } },
    },
    usage: { prompt_tokens: 8, total_tokens: 8 },
  };
}

function build() {
  let boundary: ((request: never, send: never) => Promise<unknown>) | undefined;
  const memory = createProductionRunMemory({
    configuration,
    projection: {
      bindEmbeddingBoundary: (value: never) => {
        boundary = value;
      },
    },
    payloads: { get: async () => undefined },
    memory: { search: async () => [] },
    admission: async () => undefined,
    budget: {} as never,
    assertActive: async () => {},
    now: () => NOW,
  });
  const embed = () =>
    boundary?.(
      { model: "alibaba/qwen3-embedding-8b", input: "和牛烤肉馆", dimensions: 4 } as never,
      (async () => response()) as never,
    );
  return { memory, embed };
}

describe("embedding for the Gmail check", () => {
  it("embeds without a conversation run and charges the cost to the check", async () => {
    const { memory, embed } = build();
    const context = { deadlineAt: LATER, signal: new AbortController().signal, costMicros: 0 };
    await memory.embedForMailCheck(context, async () => {
      await embed();
      await embed();
    });
    expect(context.costMicros).toBeGreaterThan(0);
  });

  it("still refuses to embed outside a run, a projection job or a Gmail check", async () => {
    const { embed } = build();
    await expect(embed()).rejects.toThrow();
  });

  it("refuses once the check has been aborted", async () => {
    const { memory, embed } = build();
    const controller = new AbortController();
    controller.abort();
    const context = { deadlineAt: LATER, signal: controller.signal, costMicros: 0 };
    await expect(memory.embedForMailCheck(context, async () => embed())).rejects.toThrow();
    expect(context.costMicros).toBe(0);
  });
});

describe("recall for the Gmail check", () => {
  const found = (id: string, score: number) => ({ memory: { id, contentRef: `ref-${id}` }, score });
  const recallWith = (
    search: (input: Record<string, unknown>) => Promise<unknown>,
    active: { now: number; peak: number },
  ) =>
    createProactiveMemoryRecall({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      memory: {
        search: async (input: Record<string, unknown>) => {
          active.now += 1;
          active.peak = Math.max(active.peak, active.now);
          try {
            return await search(input);
          } finally {
            active.now -= 1;
          }
        },
      } as never,
      content: { readText: async (ref: string) => `text of ${ref}` },
      embedForMailCheck: (_context, operation) => operation(),
      minimumSimilarity: 0.45,
      hitsPerMail: 3,
      concurrency: 4,
    });

  it("[PA-2] searches with tentative memories included and marks only the tentative hits", async () => {
    const active = { now: 0, peak: 0 };
    const seen: Record<string, unknown>[] = [];
    const recall = recallWith(async (input) => {
      seen.push(input);
      return [
        found("m1", 0.7),
        {
          memory: { id: "m2", contentRef: "ref-m2", attributes: { tentative: true } },
          score: 0.6,
        },
        {
          memory: { id: "m3", contentRef: "ref-m3", attributes: { tentative: false } },
          score: 0.5,
        },
      ];
    }, active);
    const result = await recall.recall({
      queries: [{ messageId: "mail-1", query: "q" }],
      deadlineAt: LATER,
      signal: new AbortController().signal,
    });
    expect(seen[0]).toMatchObject({ includeTentative: true });
    expect(result.hits.get("mail-1")).toEqual([
      { id: "m1", text: "text of ref-m1", score: 0.7 },
      { id: "m2", text: "text of ref-m2", score: 0.6, tentative: true },
      { id: "m3", text: "text of ref-m3", score: 0.5 },
    ]);
  });

  it("searches read-only with the check's threshold, without rules, and runs at most four at a time", async () => {
    const active = { now: 0, peak: 0 };
    const seen: Record<string, unknown>[] = [];
    const recall = recallWith(async (input) => {
      seen.push(input);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return [found("m1", 0.7)];
    }, active);
    const queries = Array.from({ length: 10 }, (_, index) => ({
      messageId: `mail-${index}`,
      query: `q${index}`,
    }));
    const result = await recall.recall({
      queries,
      deadlineAt: LATER,
      signal: new AbortController().signal,
    });
    expect(active.peak).toBeLessThanOrEqual(4);
    expect(seen).toHaveLength(10);
    for (const input of seen)
      expect(input).toMatchObject({
        recordUse: false,
        minimumSimilarity: 0.45,
        excludeCategories: ["rule"],
        policy: { limit: 3, allowedClassifications: ["public", "private"] },
      });
    expect(result.hits.get("mail-3")).toEqual([{ id: "m1", text: "text of ref-m1", score: 0.7 }]);
    expect(result.failedQueries).toBe(0);
  });

  it("counts failed searches and leaves mails with no related memory out", async () => {
    const active = { now: 0, peak: 0 };
    const recall = recallWith(async (input) => {
      if (input["queryText"] === "boom") throw new Error("EMBEDDING_DOWN");
      return input["queryText"] === "none" ? [] : [found("m1", 0.6)];
    }, active);
    const result = await recall.recall({
      queries: [
        { messageId: "a", query: "boom" },
        { messageId: "b", query: "none" },
        { messageId: "c", query: "ok" },
      ],
      deadlineAt: LATER,
      signal: new AbortController().signal,
    });
    expect(result.failedQueries).toBe(1);
    expect([...result.hits.keys()]).toEqual(["c"]);
  });
});
