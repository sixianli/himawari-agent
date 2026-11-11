import { mkdtemp, readFile, rm } from "node:fs/promises";
import { instructedQuery, QWEN3_MEMORY_QUERY_INSTRUCTION } from "@himawari-agent/memory-engine";
import { parseProductConfiguration } from "@himawari-agent/platform-node";
import {
  admissionCostForConfiguredPiModel,
  ConfiguredPiModelBindingPort,
  type ConfiguredPiModelDescriptor,
} from "@himawari-agent/runtime-pi";
import { inMemoryMemoryIndex } from "@himawari-agent/testing";
import { testTemporaryRoot } from "@himawari-agent/testing/temporary-root";
import { describe, expect, it, vi } from "vitest";
import { createProductionMemoryCompositionFromConfiguration } from "../src/production-memory-composition.js";
import { resolveConfiguredModelDescriptorSet } from "../src/production-model-composition.js";
import { embeddingAdmissionDescriptor } from "../src/production-run-memory.js";
import { testModelEgress } from "@himawari-agent/testing";

const fixture = new URL("../../../test/integration/fixtures/file-summary/", import.meta.url);

async function configuration() {
  return parseProductConfiguration(
    JSON.parse(await readFile(new URL("configuration.json", fixture), "utf8")),
    "2026-09-07T00:00:00.000Z",
  );
}

describe("file summary qualification configuration", () => {
  it("accepts routing references without granting authority and rejects expanded route fields", async () => {
    const raw = JSON.parse(await readFile(new URL("configuration.json", fixture), "utf8"));
    const fileRead = {
      hostId: "mac:test",
      workerInstanceId: "worker:test",
      grantId: "directory:test",
      capabilityRef: "file:test",
      capabilityVersion: "1.0.0",
      maximumBytes: 4096,
    };
    raw.runPolicy.fileRead = fileRead;
    expect(parseProductConfiguration(raw, "2026-09-07T00:00:00.000Z").runPolicy?.fileRead).toEqual(
      fileRead,
    );
    for (const changed of [
      { ...fileRead, approved: true },
      { ...fileRead, maximumBytes: 49153 },
      { ...fileRead, maximumBytes: 0 },
    ]) {
      raw.runPolicy.fileRead = changed;
      expect(() => parseProductConfiguration(raw, "2026-09-07T00:00:00.000Z")).toThrow();
    }
  });

  it("registers the configured generation models in real Pi without resolving credentials", async () => {
    const config = await configuration();
    const descriptors = resolveConfiguredModelDescriptorSet(config);
    const generation = descriptors.generation.filter(
      (descriptor): descriptor is ConfiguredPiModelDescriptor =>
        descriptor.api === "openai-completions",
    );
    const resolve = vi.fn(async () => {
      throw new Error("offline preparation must not read a provider credential");
    });
    const bindings = new ConfiguredPiModelBindingPort({
      descriptors: generation,
      secretSource: { productionSuitable: true, resolve },
    });
    try {
      for (const descriptor of generation) {
        const binding = await bindings.resolve(descriptor.ref);
        expect(binding.model.id).toBe(descriptor.model);
        expect(binding.model.baseUrl).toBe("https://ai-gateway.vercel.sh/v1");
        expect(binding.model.maxTokens).toBe(2048);
      }
      expect(resolve).not.toHaveBeenCalled();
    } finally {
      await bindings.close();
    }
  });

  it("prices generation and embedding reservations for usage accounting", async () => {
    const config = await configuration();
    const descriptors = resolveConfiguredModelDescriptorSet(config);
    const generationDescriptors = descriptors.generation.filter(
      (descriptor): descriptor is ConfiguredPiModelDescriptor =>
        descriptor.api === "openai-completions",
    );
    const embedding = embeddingAdmissionDescriptor(config);
    const generation = Math.max(
      ...generationDescriptors.map(
        (descriptor) => admissionCostForConfiguredPiModel(descriptor).estimatedCostMicros,
      ),
    );
    expect(embedding.estimatedCostMicros).toBeGreaterThan(0);
    expect(generation).toBeGreaterThan(0);
    expect("budgets" in config).toBe(false);
    expect(embedding.secretRequirement).toEqual(descriptors.generation[0]?.secretRequirement);
    expect(descriptors.embedding.dimensions).toBe(config.memory.dimensions);
    expect(config.memory.storagePath.startsWith(`${config.stateRoot}/`)).toBe(true);
    expect(config.runPolicy?.retiredKeys).toBeUndefined();
  });

  it("rejects a vector dimension mismatch before model composition", async () => {
    const config = await configuration();
    expect(() =>
      resolveConfiguredModelDescriptorSet({
        ...config,
        memory: { ...config.memory, dimensions: 1024 },
      }),
    ).toThrow("MODEL_EMBEDDING_DIMENSIONS_MISMATCH");
  });

  it("passes the candidate embedding identity and dimensions through the production memory engine", async () => {
    const config = await configuration();
    const stateRoot = await mkdtemp(`${testTemporaryRoot()}/hma-config-`);
    const resolve = vi.fn(async () => "offline-fixture-provider-value");
    const requests: { url: string; authorized: boolean; body: unknown }[] = [];
    try {
      const memory = await createProductionMemoryCompositionFromConfiguration({
        onVectorFailure: () => {},
        egress: testModelEgress(),
        configuration: {
          ...config,
          stateRoot,
          memory: { ...config.memory, storagePath: `${stateRoot}/data/memory` },
        },
        secretSource: { kind: "macos-keychain", productionSuitable: true, resolve },
        index: inMemoryMemoryIndex(),
        fetch: async (input, init) => {
          requests.push({
            url: String(input),
            authorized:
              new Headers(init?.headers).get("authorization") ===
              ["Bearer", "offline-fixture-provider-value"].join(" "),
            body: JSON.parse(String(init?.body)),
          });
          return new Response(
            JSON.stringify({
              model: "alibaba/qwen3-embedding-8b",
              data: [{ index: 0, embedding: Array.from({ length: 4096 }, () => 1) }],
              usage: { prompt_tokens: 1, total_tokens: 1 },
            }),
          );
        },
      });
      memory.bindEmbeddingBoundary((_request, send) => send(), 1000);
      await memory.projection.search({
        ownerId: config.ownerId,
        agentId: config.agentId,
        query: "图书角",
        limit: 1,
      });
      expect(requests).toEqual([
        {
          url: "https://ai-gateway.vercel.sh/v1/embeddings",
          authorized: true,
          body: {
            model: "alibaba/qwen3-embedding-8b",
            input: instructedQuery(QWEN3_MEMORY_QUERY_INSTRUCTION, "图书角"),
            dimensions: 4096,
            encoding_format: "base64",
          },
        },
      ]);
      expect(resolve).toHaveBeenCalledExactlyOnceWith("vercel-ai-gateway-api-key", "v1");
      await memory.close();
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("keeps the answer facts in the file and out of the system instruction", async () => {
    const config = await configuration();
    const content = await readFile(new URL("project-brief.txt", fixture), "utf8");
    expect(Buffer.byteLength(content)).toBeLessThan(4096);
    for (const fact of ["向日葵-海盐-4827", "37", "25", "12", "不采购新书"]) {
      expect(content).toContain(fact);
      expect(config.runPolicy?.systemInstruction).not.toContain(fact);
    }
  });
});
