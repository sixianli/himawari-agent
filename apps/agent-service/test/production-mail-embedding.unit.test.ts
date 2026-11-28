import { describe, expect, it } from "vitest";
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

  it("[P4-5][I-129] uses the classification the caller names and refuses passwords and keys", async () => {
    const { memory, embed } = build();
    const context = {
      deadlineAt: LATER,
      signal: new AbortController().signal,
      dataClassification: "restricted" as const,
      costMicros: 0,
    };
    await expect(memory.embedForMailCheck(context, async () => embed())).rejects.toThrow(
      "EMBEDDING_REQUEST_OUTSIDE_POLICY",
    );
    expect(context.costMicros).toBe(0);
  });

  it("still refuses to embed outside a run, a projection job or a Gmail check", async () => {
    const { embed } = build();
    await expect(embed()).rejects.toThrow();
  });

  it("[P3-6] embeds a conversation summary at its own classification, so health content is embedded and only passwords and keys are refused", async () => {
    const { memory, embed } = build();
    const signal = new AbortController().signal;
    const privateContext = {
      deadlineAt: LATER,
      signal,
      dataClassification: "private" as const,
      costMicros: 0,
    };
    await memory.embedForMailCheck(privateContext, async () => embed());
    expect(privateContext.costMicros).toBeGreaterThan(0);
    const sensitiveContext = {
      deadlineAt: LATER,
      signal,
      dataClassification: "sensitive" as const,
      costMicros: 0,
    };
    await memory.embedForMailCheck(sensitiveContext, async () => embed());
    expect(sensitiveContext.costMicros).toBeGreaterThan(0);
    const restrictedContext = {
      deadlineAt: LATER,
      signal,
      dataClassification: "restricted" as const,
      costMicros: 0,
    };
    await expect(
      memory.embedForMailCheck(restrictedContext, async () => embed()),
    ).rejects.toThrow();
    expect(restrictedContext.costMicros).toBe(0);
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

describe("[P5-1] embedding for an external MCP read", () => {
  it("embeds without a conversation run and charges the cost to the read", async () => {
    const { memory, embed } = build();
    const context = { deadlineAt: LATER, signal: new AbortController().signal, costMicros: 0 };
    await memory.embedForExternalRead(context, async () => {
      await embed();
    });
    expect(context.costMicros).toBeGreaterThan(0);
  });

  it("refuses once the caller has gone away", async () => {
    const { memory, embed } = build();
    const controller = new AbortController();
    controller.abort();
    const context = { deadlineAt: LATER, signal: controller.signal, costMicros: 0 };
    await expect(memory.embedForExternalRead(context, async () => embed())).rejects.toThrow();
    expect(context.costMicros).toBe(0);
  });
});
