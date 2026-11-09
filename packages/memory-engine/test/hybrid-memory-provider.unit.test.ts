import type {
  MemoryIndexDocument,
  MemoryIndexStorePort,
  ProductMemoryRecord,
} from "@himawari-agent/application";
import type { AgentId, MemoryId, OwnerId } from "@himawari-agent/domain";
import { describe, expect, it, vi } from "vitest";
import { type Embedder, GatewayEmbedder, normalizedVector } from "../src/embedding.ts";
import { HybridMemoryProvider, memoryIndexRecordId } from "../src/hybrid-memory-provider.ts";
import { testModelEgress } from "./helpers/model-egress.js";

const ownerId = "owner-01" as OwnerId;
const agentId = "agent-01" as AgentId;
const now = "2026-10-25T00:00:00.000Z";

function memory(overrides: Partial<ProductMemoryRecord> = {}): ProductMemoryRecord {
  return {
    id: "memory-01" as MemoryId,
    ownerId,
    agentId,
    revision: 2,
    status: "active",
    contentRef: "memory-content:01",
    dataClassification: "private",
    sourceThreadId: null,
    sourceRefs: ["source-01"],
    inference: false,
    confidencePermille: 900,
    policyVersion: "memory-capture:v2",
    providerRecordId: null,
    lastUsedAt: null,
    updatedAt: now,
    attributes: {
      category: "identity",
      importancePermille: 800,
      entities: ["杭州"],
      validFrom: null,
      validTo: null,
      supersededBy: null,
      evidenceVerified: true,
    },
    ...overrides,
  };
}

function index() {
  const upserts: MemoryIndexDocument[] = [];
  const port: MemoryIndexStorePort = {
    upsert: vi.fn(async (document) => {
      upserts.push(document);
    }),
    delete: vi.fn(async () => {}),
    clearScope: vi.fn(async () => {}),
    search: vi.fn(async () => ({
      vector: [],
      lexical: [
        {
          memoryId: "memory-01" as MemoryId,
          revision: 2,
          importancePermille: 800,
          confidencePermille: 900,
          updatedAt: now,
          lastUsedAt: null,
          signal: 3,
          startsAt: now,
          endsAt: null,
          current: true,
        },
      ],
      entity: [],
      vectorEngine: "none" as const,
    })),
    listUnindexed: vi.fn(async () => []),
  };
  return { port, upserts };
}

function embedder(fail = false): Embedder {
  return {
    model: "fixture-embedding",
    dimensions: 3,
    embed: vi.fn(async () => {
      if (fail) throw new Error("EMBEDDING_DOWN");
      return normalizedVector([1, 2, 2]);
    }),
  };
}

describe("hybrid Memory provider", () => {
  it("indexes terms and a normalized embedding for a private Memory", async () => {
    const { port, upserts } = index();
    const provider = new HybridMemoryProvider({
      index: port,
      embedder: embedder(),
      embeddableClassifications: ["public", "private"],
      now: () => now,
    });
    const recordId = await provider.upsert({ memory: memory(), content: "主人住在杭州市" });
    expect(recordId).toBe(memoryIndexRecordId("memory-01" as MemoryId));
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.terms).toEqual(expect.arrayContaining(["杭州市", "杭州", "主人", "住在"]));
    expect(upserts[0]?.revision).toBe(2);
    expect(Array.from(upserts[0]?.embedding?.vector ?? [])).toEqual([
      expect.closeTo(1 / 3),
      expect.closeTo(2 / 3),
      expect.closeTo(2 / 3),
    ]);
  });

  it("[RULE-memory-visible] indexes sensitive Memory words after masking and drops words that look like secrets", async () => {
    const { port, upserts } = index();
    const provider = new HybridMemoryProvider({
      index: port,
      embedder: embedder(),
      embeddableClassifications: ["public", "private", "sensitive"],
      now: () => now,
    });
    await provider.upsert({
      memory: memory({ dataClassification: "sensitive" }),
      content:
        "主人对青霉素过敏，Wi-Fi 密码：sunflower，客人来了就告诉他 sunflower；网银密码是 hunter22，忘了就翻 hunter22 那页；hunter33 是新密码；纸条上写着 x9Kq2mVb7Lp4Wz 和 abcd-efgh-ijkl-mnop-qrst-uvwx，手机号 13800138000，2026-11-09 复诊",
    });
    const terms = upserts[0]?.terms ?? [];
    expect(terms).toEqual(expect.arrayContaining(["青霉素", "过敏", "纸条", "2026"]));
    expect(terms.join(" ")).not.toMatch(
      /sunflower|hunter|x9kq2mvb7lp4wz|abcd|efgh|uvwx|13800138000/u,
    );
    expect(upserts[0]?.embedding).not.toBeNull();
  });

  it("keeps restricted Memory out of the full-text index", async () => {
    const { port, upserts } = index();
    const provider = new HybridMemoryProvider({
      index: port,
      embedder: embedder(),
      embeddableClassifications: ["public", "private", "sensitive"],
      now: () => now,
    });
    await provider.upsert({
      memory: memory({ dataClassification: "restricted" }),
      content: "主人对青霉素过敏",
    });
    expect(upserts[0]?.terms).toEqual([]);
    expect(upserts[0]?.embedding).toBeNull();
  });

  it("writes the lexical index before reporting an embedding failure", async () => {
    const { port, upserts } = index();
    const provider = new HybridMemoryProvider({
      index: port,
      embedder: embedder(true),
      embeddableClassifications: ["private"],
      now: () => now,
    });
    await expect(provider.upsert({ memory: memory(), content: "主人喜欢蓝色" })).rejects.toThrow(
      "EMBEDDING_DOWN",
    );
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.embedding).toBeNull();
  });

  it("falls back to full-text and entity recall when the query embedding fails", async () => {
    const { port } = index();
    const onVectorFailure = vi.fn();
    const provider = new HybridMemoryProvider({
      index: port,
      embedder: embedder(true),
      embeddableClassifications: ["private"],
      now: () => now,
      onVectorFailure,
    });
    const hits = await provider.search({ ownerId, agentId, query: "我住在哪里", limit: 3 });
    expect(onVectorFailure).toHaveBeenCalledOnce();
    expect(onVectorFailure).toHaveBeenCalledWith(expect.anything(), { ownerId, agentId });
    expect(port.search).toHaveBeenCalledWith(
      expect.objectContaining({ embedding: null, terms: ["住在"], queryText: "我住在哪里" }),
    );
    expect(hits).toEqual([
      {
        providerRecordId: "memory-index:memory-01",
        productMemoryId: "memory-01",
        score: expect.any(Number),
      },
    ]);
  });

  it("ignores legacy Mem0 provider records on delete", async () => {
    const { port } = index();
    const provider = new HybridMemoryProvider({
      index: port,
      embedder: null,
      embeddableClassifications: [],
      now: () => now,
    });
    await provider.delete("0f9a-legacy-mem0-id");
    await provider.delete("memory-index:memory-01");
    expect(port.delete).toHaveBeenCalledExactlyOnceWith("memory-01");
  });
});

describe("Gateway embedder", () => {
  it("redacts sensitive values before the text leaves for the embedding provider", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: "fixture-embedding",
            data: [{ index: 0, embedding: [3, 0, 4] }],
            usage: { prompt_tokens: 1, total_tokens: 1 },
          }),
        ),
    );
    const client = new GatewayEmbedder({
      egress: testModelEgress(),
      baseUrl: "https://gateway.invalid/v1",
      model: "fixture-embedding",
      dimensions: 3,
      apiKey: async () => "fixture-value",
      fetch,
    });
    client.bindBoundary((_request, send) => send({ timeoutMs: 50 }), 1000);
    await client.embed("验证码 482910，卡号 4111 1111 1111 1111，订单 20261101123456，山田太郎");
    const sent = JSON.parse(
      String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    );
    expect(sent.input).toMatch(
      /^验证码 \[验证码#[a-z]{8}\]，卡号 \[银行卡 尾号1111#[a-z]{8}\]，订单 20261101123456，山田太郎$/u,
    );
  });

  it("refuses to call the provider before a governed boundary is bound", async () => {
    const fetch = vi.fn();
    const client = new GatewayEmbedder({
      egress: testModelEgress(),
      baseUrl: "https://gateway.invalid/v1",
      model: "fixture-embedding",
      dimensions: 3,
      apiKey: async () => "fixture-value",
      fetch,
    });
    await expect(client.embed("你好")).rejects.toThrow("EMBEDDING_BOUNDARY_REQUIRED");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends model, input and dimensions through the boundary and normalizes the vector", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: "fixture-embedding",
            data: [{ index: 0, embedding: [3, 0, 4] }],
            usage: { prompt_tokens: 1, total_tokens: 1 },
          }),
        ),
    );
    const client = new GatewayEmbedder({
      egress: testModelEgress(),
      baseUrl: "https://gateway.invalid/v1/",
      model: "fixture-embedding",
      dimensions: 3,
      apiKey: async () => "fixture-value",
      fetch,
    });
    const boundary = vi.fn((_request, send) => send({ timeoutMs: 50 }));
    client.bindBoundary(boundary, 1000);
    expect(Array.from(await client.embed("你好"))).toEqual([
      expect.closeTo(0.6),
      0,
      expect.closeTo(0.8),
    ]);
    expect(boundary).toHaveBeenCalledWith(
      { model: "fixture-embedding", input: "你好", dimensions: 3 },
      expect.any(Function),
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://gateway.invalid/v1/embeddings",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("asks for base64 vectors and hands the boundary the decoded float32 values", async () => {
    const values = Float32Array.from([3, 0, 4]);
    const encoded = Buffer.from(values.buffer).toString("base64");
    const bodies: unknown[] = [];
    const client = new GatewayEmbedder({
      egress: testModelEgress(),
      baseUrl: "https://gateway.invalid/v1",
      model: "fixture-embedding",
      dimensions: 3,
      apiKey: async () => "fixture-value",
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            model: "fixture-embedding",
            data: [{ index: 0, embedding: encoded }],
            usage: { prompt_tokens: 1, total_tokens: 1 },
          }),
        );
      },
    });
    const seen: unknown[] = [];
    client.bindBoundary(async (_request, send) => {
      const response = await send();
      seen.push(response.data[0]?.embedding);
      return response;
    }, 1000);
    expect(Array.from(await client.embed("你好"))).toEqual([
      expect.closeTo(0.6),
      0,
      expect.closeTo(0.8),
    ]);
    expect(bodies).toEqual([
      { model: "fixture-embedding", input: "你好", dimensions: 3, encoding_format: "base64" },
    ]);
    expect(seen).toEqual([[3, 0, 4]]);
  });

  it("rejects a base64 vector whose length does not match the dimensions", async () => {
    const client = new GatewayEmbedder({
      egress: testModelEgress(),
      baseUrl: "https://gateway.invalid/v1",
      model: "fixture-embedding",
      dimensions: 3,
      apiKey: async () => "fixture-value",
      fetch: async () =>
        new Response(
          JSON.stringify({
            model: "fixture-embedding",
            data: [
              {
                index: 0,
                embedding: Buffer.from(Float32Array.from([1, 2]).buffer).toString("base64"),
              },
            ],
            usage: { prompt_tokens: 1, total_tokens: 1 },
          }),
        ),
    });
    client.bindBoundary((_request, send) => send(), 1000);
    await expect(client.embed("你好")).rejects.toThrow("EMBEDDING_VECTOR_INVALID");
  });

  it("reports a provider HTTP failure", async () => {
    const client = new GatewayEmbedder({
      egress: testModelEgress(),
      baseUrl: "https://gateway.invalid/v1",
      model: "fixture-embedding",
      dimensions: 3,
      apiKey: async () => "fixture-value",
      fetch: async () => new Response("{}", { status: 503 }),
    });
    client.bindBoundary((_request, send) => send(), 1000);
    await expect(client.embed("你好")).rejects.toThrow("EMBEDDING_HTTP_FAILURE");
  });

  it("keeps the gateway's refusal reason when a budget rejects the request", async () => {
    const client = new GatewayEmbedder({
      egress: testModelEgress(),
      baseUrl: "https://gateway.invalid/v1",
      model: "fixture-embedding",
      dimensions: 3,
      apiKey: async () => "fixture-value",
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              message: "User budget exceeded. Current spend: $3.16, limit: $3.00.",
              type: "quota_for_entity_exceeded",
            },
          }),
          { status: 402 },
        ),
    });
    client.bindBoundary((_request, send) => send(), 1000);
    await expect(client.embed("你好")).rejects.toMatchObject({
      message: "EMBEDDING_HTTP_FAILURE",
      details: {
        status: "402",
        gatewayErrorType: "quota_for_entity_exceeded",
        gatewayErrorMessage: "User budget exceeded. Current spend: $3.16, limit: $3.00.",
      },
    });
  });
});
