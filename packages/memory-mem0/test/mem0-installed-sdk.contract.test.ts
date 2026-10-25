import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createAgentId,
  createMemoryId,
  createOwnerId,
  createThreadId,
} from "@himawari-agent/domain";
import type { ProductMemoryRecord } from "@himawari-agent/application";
import BetterSqlite3 from "better-sqlite3";
import { expect, it } from "vitest";
import { Mem0ProjectionAdapter } from "../src/index.ts";

it("[R2-L5] preserves product records and isolates entity vectors across the Mem0 upgrade", async () => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "mem0-sdk-"));
  const retained = path.resolve(".ci-output/r2-l5-mem0", path.basename(stateRoot));
  mkdirSync(retained, { recursive: true });
  const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      model: string;
      input: string | string[];
      dimensions: number;
    };
    requests.push(body);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        model: body.model,
        data: inputs.map((input, index) => {
          const digest = createHash("sha256").update(input).digest();
          return {
            index,
            embedding: Array.from({ length: body.dimensions }, (_, part) => {
              const value = digest[part];
              if (value === undefined) throw new Error("FIXTURE_DIMENSIONS_UNSUPPORTED");
              return value / 255;
            }),
          };
        }),
        usage: { prompt_tokens: inputs.length * 3, total_tokens: inputs.length * 3 },
        providerMetadata: {
          gateway: {
            generationId: `embedding-${requests.length}`,
            routing: { finalProvider: "deepinfra" },
            cost: "0.00001337",
          },
        },
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("PROVIDER_ADDRESS_MISSING");
  const baseURL = `http://127.0.0.1:${address.port}/v1`;
  const configuration = {
    stateRoot,
    version: "v1.1" as const,
    llm: {
      provider: "openai" as const,
      config: { apiKey: "loopback", baseURL, model: "deepseek/deepseek-v4.1-flash" },
    },
    embedder: {
      provider: "openai" as const,
      config: {
        apiKey: "loopback",
        baseURL,
        model: "alibaba/qwen3-embedding-8b",
        embeddingDims: 12,
      },
    },
    vectorStore: {
      provider: "memory" as const,
      config: {
        collectionName: "product-memories",
        dimension: 12,
        dbPath: path.join(stateRoot, "vectors.sqlite"),
      },
    },
    historyStore: {
      provider: "sqlite" as const,
      config: { historyDbPath: path.join(stateRoot, "history.sqlite") },
    },
    customInstructions: "只投影已有产品记忆。",
  };
  const ownerId = createOwnerId("owner-sdk-upgrade");
  const agentId = createAgentId("agent-sdk-upgrade");
  const memory: ProductMemoryRecord = {
    id: createMemoryId("memory-sdk-upgrade"),
    ownerId,
    agentId,
    revision: 1,
    status: "active",
    contentRef: "payload-sdk-upgrade",
    dataClassification: "private",
    sourceThreadId: createThreadId("thread-sdk-upgrade"),
    sourceRefs: ["source-sdk-upgrade"],
    inference: false,
    confidencePermille: 1000,
    policyVersion: "memory-policy-v1",
    providerRecordId: null,
    lastUsedAt: null,
    updatedAt: "2026-10-06T00:00:00.000Z",
  };
  const readVectors = (filename: string) => {
    if (!existsSync(filename)) return [];
    const database = new BetterSqlite3(filename, { readonly: true, fileMustExist: true });
    try {
      return database.prepare("SELECT id, payload FROM vectors ORDER BY id").all() as {
        id: string;
        payload: string;
      }[];
    } finally {
      database.close();
    }
  };
  const adapters: Mem0ProjectionAdapter[] = [];
  try {
    const projection = await Mem0ProjectionAdapter.create({ configuration });
    adapters.push(projection);
    projection.bindEmbeddingBoundary((_request, send) => send(), 1000);
    expect(requests).toHaveLength(0);
    const providerId = await projection.upsert({ memory, content: "original fact" });
    const otherId = await projection.upsert({
      memory: { ...memory, id: createMemoryId("memory-sdk-other") },
      content: "unrelated fact",
    });
    expect(
      await projection.upsert({
        memory: { ...memory, revision: 2, providerRecordId: providerId },
        content: "Alice Johnson works at Acme Corporation in Berlin.",
      }),
    ).toBe(providerId);
    const rows = readVectors(configuration.vectorStore.config.dbPath);
    expect(rows.map(({ id }) => id).sort()).toEqual([providerId, otherId].sort());
    const entities = readVectors(path.join(stateRoot, "entities.sqlite"));
    expect(entities.length).toBeGreaterThan(0);
    expect(
      entities.every(({ payload }) => JSON.parse(payload).product_memory_id === undefined),
    ).toBe(true);
    const restarted = await Mem0ProjectionAdapter.create({ configuration });
    adapters.push(restarted);
    restarted.bindEmbeddingBoundary((_request, send) => send(), 1000);
    expect(await restarted.search({ ownerId, agentId, query: "Alice Johnson", limit: 10 })).toEqual(
      expect.arrayContaining([
        { providerRecordId: providerId, productMemoryId: memory.id, score: expect.any(Number) },
      ]),
    );
    await restarted.delete(providerId);
    await restarted.delete(providerId);
    expect(readVectors(configuration.vectorStore.config.dbPath).map(({ id }) => id)).toEqual([
      otherId,
    ]);
    expect(readVectors(path.join(stateRoot, "entities.sqlite"))).toEqual([]);
    const history = new BetterSqlite3(configuration.historyStore.config.historyDbPath, {
      readonly: true,
    });
    try {
      expect(
        history.prepare("SELECT * FROM memory_history WHERE memory_id = ?").all(providerId),
      ).toEqual([]);
      expect(
        history.prepare("SELECT * FROM memory_history WHERE memory_id = ?").all(otherId),
      ).toHaveLength(1);
    } finally {
      history.close();
    }
  } finally {
    writeFileSync(path.join(retained, "provider-requests.json"), JSON.stringify(requests, null, 2));
    writeFileSync(
      path.join(retained, "vector-readbacks.json"),
      JSON.stringify(
        {
          primary: readVectors(configuration.vectorStore.config.dbPath),
          entities: readVectors(path.join(stateRoot, "entities.sqlite")),
        },
        null,
        2,
      ),
    );
    await Promise.all(adapters.map((adapter) => adapter.close()));
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(stateRoot, { recursive: true, force: true });
  }
});
