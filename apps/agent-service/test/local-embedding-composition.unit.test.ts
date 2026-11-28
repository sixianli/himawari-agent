import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EMBEDDING_PROFILES,
  embeddingIdentity,
  embeddingIdentityFor,
  JINA_V5_SMALL_INT8_PROFILE,
  type ProductConfiguration,
  type ProductMemoryRecord,
} from "@himawari-agent/application";
import {
  LOCAL_ONNX_MANIFEST_SCHEMA,
  loadOnnxRuntimeModel,
  localOnnxArtifactDirectory,
  parseProductConfiguration,
} from "@himawari-agent/platform-node";
import { inMemoryMemoryIndex, testModelEgress } from "@himawari-agent/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProductionMemoryCompositionFromConfiguration } from "../src/production-memory-composition.js";
import { embeddingAdmissionDescriptor } from "../src/production-run-memory.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const FIXTURE = path.join(repositoryRoot, "test/fixtures/local-onnx-embedding");
const MODEL = JINA_V5_SMALL_INT8_PROFILE.model;

let stateRoot: string;

beforeEach(async () => {
  stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-local-embedding-composition-"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(stateRoot, { recursive: true, force: true });
});

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

async function installFixture(): Promise<string> {
  const staging = path.join(stateRoot, "staging");
  await mkdir(staging, { recursive: true });
  const files: Record<string, string> = {};
  for (const name of ["model.onnx", "tokenizer.json", "tokenizer_config.json"]) {
    await copyFile(path.join(FIXTURE, name), path.join(staging, name));
    files[name] = sha256(await readFile(path.join(staging, name)));
  }
  const manifest = `${JSON.stringify({
    schema: LOCAL_ONNX_MANIFEST_SCHEMA,
    model: MODEL,
    dimensions: 1024,
    files,
  })}\n`;
  await writeFile(path.join(staging, "manifest.json"), manifest);
  const artifactSha256 = sha256(manifest);
  const directory = localOnnxArtifactDirectory(stateRoot, MODEL, artifactSha256);
  await mkdir(path.dirname(directory), { recursive: true });
  await rename(staging, directory);
  return artifactSha256;
}

function configuration(
  embedding: Record<string, unknown>,
  minimumSimilarity?: number,
): ProductConfiguration {
  const dimensions = embedding["dimensions"] as number;
  return parseProductConfiguration(
    {
      schemaVersion: "himawari.configuration.v1",
      deploymentId: "deployment-local-embedding",
      ownerId: "owner-local-embedding",
      agentId: "agent-local-embedding",
      stateRoot,
      runtimeDirectory: `${stateRoot}/runtime`,
      cacheDirectory: `${stateRoot}/cache`,
      publicOrigin: "http://127.0.0.1",
      publicMode: false,
      modelDescriptors: [
        {
          ref: "model-primary",
          role: "primary",
          provider: "vercel-ai-gateway",
          model: "deepseek/deepseek-v4.1-flash",
          version: "catalog-2026-10-06",
          priority: 1,
          name: "DeepSeek V4.1 Flash",
          api: "openai-completions",
          reasoning: false,
          input: ["text"],
          capabilities: ["text", "tool_calling", "structured_outputs"],
          cost: { input: 0.3, output: 2.4, cacheRead: 0.3, cacheWrite: 0.3 },
          contextWindow: 1_048_576,
          maxTokens: 32768,
          providerRouting: { order: ["runware", "deepinfra", "morph"], sort: "cost" },
          disclosure: "external_remote",
          secretRef: "vercel-ai-gateway-api-key",
        },
        {
          ref: "model-embedding",
          role: "embedding",
          version: "fixture-1",
          capabilities: ["embedding"],
          ...embedding,
        },
      ],
      memory: {
        adapter: "himawari-sqlite",
        version: "3.3.1",
        storagePath: `${stateRoot}/data/memory`,
        dimensions,
        ...(minimumSimilarity === undefined ? {} : { minimumSimilarity }),
      },
      repositoryAllowlistRefs: [],
      secretReferences: [
        {
          ref: "vercel-ai-gateway-api-key",
          version: "v1",
          purpose: "model-provider-auth",
          scope: "model",
        },
      ],
      concurrency: { totalRuns: 1, foregroundReserved: 1, perCategory: {} },
      deadlines: { runMs: 1000, workerRequestMs: 1000, providerRequestMs: 1000 },
    },
    "2026-11-11T00:00:00.000Z",
  );
}

const localEmbedding = (artifactSha256: string) => ({
  provider: "local-onnx",
  model: MODEL,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  dimensions: 1024,
  disclosure: "local_only",
  secretRef: null,
  artifactSha256,
});

const gatewayEmbedding = {
  provider: "vercel-ai-gateway",
  model: "alibaba/qwen3-embedding-8b",
  cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0 },
  dimensions: 4096,
  disclosure: "external_remote",
  secretRef: "vercel-ai-gateway-api-key",
};

const secretSource = {
  kind: "macos-keychain" as const,
  productionSuitable: true,
  resolve: async () => "fixture-provider-value",
};

function memory(config: ProductConfiguration, id: string): ProductMemoryRecord {
  return {
    id: id as never,
    ownerId: config.ownerId,
    agentId: config.agentId,
    revision: 1,
    status: "active",
    contentRef: `memory-content:${id}`,
    dataClassification: "private",
    sourceThreadId: null,
    sourceRefs: [`source-${id}`],
    inference: false,
    confidencePermille: 1000,
    policyVersion: "memory-capture:v2",
    providerRecordId: null,
    lastUsedAt: null,
    updatedAt: "2026-11-11T00:00:00.000Z",
  } as never;
}

describe("local ONNX memory embedding", () => {
  it("[P3-1] finds a Memory by vector with the network cut off, and the model only sees redacted text", async () => {
    const network = vi.fn(async () => {
      throw new Error("NETWORK_CUT_OFF");
    });
    vi.stubGlobal("fetch", network);
    const artifactSha256 = await installFixture();
    const config = configuration(localEmbedding(artifactSha256), 0.01);
    const seen: string[] = [];
    const composition = await createProductionMemoryCompositionFromConfiguration({
      egress: testModelEgress(),
      configuration: config,
      secretSource,
      index: inMemoryMemoryIndex(),
      onVectorFailure: (error) => {
        throw error;
      },
      localLoader: async (input) => {
        const model = await loadOnnxRuntimeModel(input);
        return {
          ...model,
          tokenize: (text) => {
            seen.push(text);
            return model.tokenize(text);
          },
        };
      },
    });
    composition.bindEmbeddingBoundary((_request, send) => send(), 1000);
    expect(composition.identity).toBe(
      embeddingIdentity(config.modelDescriptors.find(({ role }) => role === "embedding") as never),
    );
    await composition.localRuntime?.start();
    expect(composition.localRuntime?.state).toBe("ready");
    await composition.projection.upsert({
      memory: memory(config, "memory-card"),
      content: "主人的网银密码：Qz7mWx42Lp",
    });
    const hits = await composition.projection.search({
      ownerId: config.ownerId,
      agentId: config.agentId,
      query: "晚饭推荐",
      limit: 3,
    });
    expect(hits.map(({ productMemoryId }) => productMemoryId)).toEqual(["memory-card"]);
    expect(network).not.toHaveBeenCalled();
    expect(seen[0]).toMatch(/^Document: 主人的网银密码：\[密码#[a-z]{8}\]$/u);
    expect(seen[1]).toBe("Query: 晚饭推荐");
    expect(seen.join("\n")).not.toContain("Qz7mWx42Lp");
    expect(embeddingAdmissionDescriptor(config).estimatedCostMicros).toBe(0);
    await composition.close();
  });

  it("[P3-1] REVERSE: the network embedding model finds nothing by vector under the same cut-off", async () => {
    const failures: unknown[] = [];
    const config = configuration(gatewayEmbedding, 0.01);
    const composition = await createProductionMemoryCompositionFromConfiguration({
      egress: testModelEgress(),
      configuration: config,
      secretSource,
      index: inMemoryMemoryIndex(),
      fetch: async () => {
        throw new Error("NETWORK_CUT_OFF");
      },
      onVectorFailure: (error) => failures.push(error),
    });
    composition.bindEmbeddingBoundary((_request, send) => send(), 1000);
    expect(composition.localRuntime).toBeNull();
    await expect(
      composition.projection.upsert({
        memory: memory(config, "memory-card"),
        content: "主人的网银密码：Qz7mWx42Lp",
      }),
    ).rejects.toThrow("NETWORK_CUT_OFF");
    const hits = await composition.projection.search({
      ownerId: config.ownerId,
      agentId: config.agentId,
      query: "晚饭推荐",
      limit: 3,
    });
    expect(hits).toEqual([]);
    expect(failures).toHaveLength(1);
  });

  it("[P3-2] a search cancelled while embedding leaves no retrieval-degrade record, a real failure still does", async () => {
    const failures: unknown[] = [];
    const config = configuration(gatewayEmbedding, 0.01);
    const composition = await createProductionMemoryCompositionFromConfiguration({
      egress: testModelEgress(),
      configuration: config,
      secretSource,
      index: inMemoryMemoryIndex(),
      onVectorFailure: (error) => failures.push(error),
    });
    let cancelled = true;
    composition.bindEmbeddingBoundary(
      () => {
        throw new Error(cancelled ? "RUN_CANCELLED" : "PROVIDER_DOWN");
      },
      1000,
      () => cancelled,
    );
    const search = () =>
      composition.projection.search({
        ownerId: config.ownerId,
        agentId: config.agentId,
        query: "晚饭推荐",
        limit: 3,
      });
    await search();
    expect(failures).toEqual([]);
    cancelled = false;
    await search();
    expect(failures).toEqual([expect.objectContaining({ message: "PROVIDER_DOWN" })]);
  });

  it("[P3-1] falls back to keyword search while the local model is still loading", async () => {
    const artifactSha256 = await installFixture();
    const config = configuration(localEmbedding(artifactSha256));
    const failures: unknown[] = [];
    const composition = await createProductionMemoryCompositionFromConfiguration({
      egress: testModelEgress(),
      configuration: config,
      secretSource,
      index: inMemoryMemoryIndex(),
      onVectorFailure: (error) => failures.push(error),
    });
    composition.bindEmbeddingBoundary(() => {
      throw new Error("BOUNDARY_MUST_NOT_RUN");
    }, 1000);
    expect(composition.localRuntime?.state).toBe("idle");
    expect(composition.projection.minimumSimilarity).toBe(
      JINA_V5_SMALL_INT8_PROFILE.chatMinimumSimilarity,
    );
    await composition.projection.search({
      ownerId: config.ownerId,
      agentId: config.agentId,
      query: "晚饭推荐",
      limit: 3,
    });
    expect(failures).toEqual([expect.objectContaining({ message: "EMBEDDING_LOCAL_NOT_READY" })]);
    await composition.close();
  });

  it("[P3-1] every embedding profile passes configuration, composition and admission alike", async () => {
    for (const profile of EMBEDDING_PROFILES) {
      const local = profile.provider === "local-onnx";
      const config = configuration(
        local
          ? {
              ...localEmbedding("c".repeat(64)),
              model: profile.model,
              dimensions: profile.dimensions[0],
            }
          : gatewayEmbedding,
      );
      const composition = await createProductionMemoryCompositionFromConfiguration({
        egress: testModelEgress(),
        configuration: config,
        secretSource,
        index: inMemoryMemoryIndex(),
        onVectorFailure: () => {},
      });
      expect(composition.profile).toBe(profile);
      expect(composition.projection.minimumSimilarity).toBe(profile.chatMinimumSimilarity);
      expect(composition.identity.startsWith(`${profile.model}#`)).toBe(true);
      expect(embeddingAdmissionDescriptor(config).provider).toBe(profile.provider);
      await composition.close();
    }
  });
});

describe("embedding identity", () => {
  const base = {
    provider: "local-onnx",
    model: MODEL,
    dimensions: 1024,
    artifactSha256: "d".repeat(64),
  };

  it("[P3-1] changes when the model files, the prefixes or the redaction rules change", () => {
    const identity = embeddingIdentity(base);
    expect(embeddingIdentity({ ...base })).toBe(identity);
    expect(embeddingIdentity({ ...base, artifactSha256: "e".repeat(64) })).not.toBe(identity);
    expect(embeddingIdentity(base, 1)).not.toBe(identity);
    const changedPrefix = {
      ...JINA_V5_SMALL_INT8_PROFILE,
      document: JINA_V5_SMALL_INT8_PROFILE.query,
    };
    expect(embeddingIdentityFor(JINA_V5_SMALL_INT8_PROFILE, base)).toBe(identity);
    expect(embeddingIdentityFor(changedPrefix, base)).not.toBe(identity);
    expect(
      embeddingIdentityFor({ ...JINA_V5_SMALL_INT8_PROFILE, pooling: "sentence_embedding" }, base),
    ).not.toBe(identity);
  });
});
