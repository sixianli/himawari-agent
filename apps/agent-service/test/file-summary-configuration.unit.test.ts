import { mkdtemp, readFile, rm } from "node:fs/promises";
import { parseProductConfiguration } from "@himawari-agent/platform-node";
import {
  admissionCostForConfiguredPiModel,
  ConfiguredPiModelBindingPort,
} from "@himawari-agent/runtime-pi";
import { describe, expect, it, vi } from "vitest";
import { createProductionMemoryCompositionFromConfiguration } from "../src/production-memory-composition.js";
import { resolveConfiguredModelDescriptorSet } from "../src/production-model-composition.js";
import { embeddingAdmissionDescriptor } from "../src/production-run-memory.js";

const fixture = new URL("../../../test/integration/fixtures/file-summary/", import.meta.url);

async function configuration() {
  return parseProductConfiguration(
    JSON.parse(await readFile(new URL("configuration.json", fixture), "utf8")),
    "2026-09-07T00:00:00.000Z",
  );
}

describe("file summary qualification configuration", () => {
  it("registers the configured generation models in real Pi without resolving credentials", async () => {
    const config = await configuration();
    const descriptors = resolveConfiguredModelDescriptorSet(config);
    const resolve = vi.fn(async () => {
      throw new Error("offline preparation must not read a provider credential");
    });
    const bindings = new ConfiguredPiModelBindingPort({
      descriptors: descriptors.generation,
      secretSource: { productionSuitable: true, resolve },
    });
    try {
      for (const descriptor of descriptors.generation) {
        const binding = await bindings.resolve(descriptor.ref);
        expect(binding.model.id).toBe(descriptor.model);
        expect(binding.model.baseUrl).toBe("https://openrouter.ai/api/v1");
        expect(binding.model.maxTokens).toBe(2048);
      }
      expect(resolve).not.toHaveBeenCalled();
    } finally {
      await bindings.close();
    }
  });

  it("fits two generation reservations and embedding within the proposed shared budget", async () => {
    const config = await configuration();
    const descriptors = resolveConfiguredModelDescriptorSet(config);
    const embedding = embeddingAdmissionDescriptor(config);
    const generation = Math.max(
      ...descriptors.generation.map(
        (descriptor) => admissionCostForConfiguredPiModel(descriptor).estimatedCostMicros,
      ),
    );
    expect(embedding.estimatedCostMicros).toBeGreaterThan(0);
    expect(2 * generation + embedding.estimatedCostMicros).toBeLessThan(
      config.budgets.perRunCostMicros,
    );
    expect(config.budgets.perRunCostMicros).toBeLessThanOrEqual(config.budgets.globalCostMicros);
    expect(embedding.secretRequirement).toEqual(descriptors.generation[0]?.secretRequirement);
    expect(descriptors.embedding.dimensions).toBe(config.memory.dimensions);
    expect(config.memory.storagePath.startsWith(`${config.stateRoot}/`)).toBe(true);
    expect(config.runPolicy?.maxMemoryClassification).toBe("public");
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

  it("passes the candidate embedding identity and dimensions through the production Mem0 adapter", async () => {
    const config = await configuration();
    const stateRoot = await mkdtemp("/tmp/hma-config-");
    const constructed = vi.fn();
    const close = vi.fn();
    const resolve = vi.fn(async () => "offline-fixture-provider-value");
    for (const name of ["MEM0_DIR", "MEM0_TELEMETRY", "MEM0_TELEMETRY_SAMPLE_RATE"]) {
      vi.stubEnv(name, process.env[name]);
    }
    try {
      const memory = await createProductionMemoryCompositionFromConfiguration({
        configuration: {
          ...config,
          stateRoot,
          memory: { ...config.memory, storagePath: `${stateRoot}/data/memory` },
        },
        secretSource: { kind: "macos-keychain", productionSuitable: true, resolve },
        load: async () => ({
          Memory: class {
            constructor(input: unknown) {
              constructed(input);
            }
            close = close;
          } as never,
        }),
      });
      try {
        expect(constructed).toHaveBeenCalledWith(
          expect.objectContaining({
            embedder: {
              provider: "openai",
              config: {
                apiKey: expect.any(String),
                baseURL: "https://openrouter.ai/api/v1",
                model: "qwen/qwen3-embedding-8b",
                embeddingDims: 4096,
              },
            },
            vectorStore: expect.objectContaining({
              config: expect.objectContaining({ dimension: 4096 }),
            }),
          }),
        );
        expect(resolve).toHaveBeenCalledExactlyOnceWith("openrouter-api-key", "v1");
      } finally {
        await memory.close();
      }
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllEnvs();
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
