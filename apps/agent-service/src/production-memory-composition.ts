import type {
  ConfiguredEmbeddingModelDescriptor,
  ConfiguredGenerationModelDescriptor,
  ProductConfiguration,
} from "@himawari-agent/application";
import {
  createOpenRouterMem0ProjectionAdapter,
  type Mem0Loader,
  type Mem0ProjectionAdapter,
} from "@himawari-agent/memory-mem0";
import {
  assertProductionSecretSource,
  type HostProviderSecretSource,
} from "@himawari-agent/platform-node";
import {
  resolveConfiguredSecretRequirement,
  resolveConfiguredModelDescriptorSet,
  type ProductionEmbeddingModelDescriptor,
} from "./production-model-composition.js";

export interface ProductionMemoryCompositionOptions {
  readonly configuration: ProductConfiguration;
  readonly secretSource: HostProviderSecretSource;
  readonly load?: Mem0Loader;
}

export interface ProductionMemoryComposition {
  readonly descriptor: ProductionEmbeddingModelDescriptor;
  readonly projection: Mem0ProjectionAdapter;
  close(): Promise<void>;
}

function primaryDescriptor(
  configuration: ProductConfiguration,
): ConfiguredGenerationModelDescriptor {
  const descriptor = configuration.modelDescriptors.find(({ role }) => role === "primary");
  if (!descriptor || descriptor.role !== "primary") {
    throw new Error("MEM0_PRIMARY_DESCRIPTOR_MISSING");
  }
  return descriptor;
}

function embeddingDescriptor(
  configuration: ProductConfiguration,
): ConfiguredEmbeddingModelDescriptor {
  const descriptor = configuration.modelDescriptors.find(({ role }) => role === "embedding");
  if (!descriptor || descriptor.role !== "embedding") {
    throw new Error("MEM0_EMBEDDING_DESCRIPTOR_MISSING");
  }
  return descriptor;
}

/**
 * Build the production Mem0 projection from the same strict model identity
 * that the Pi composition consumes for generation. Mem0 owns the
 * OpenAI-compatible embedding implementation; this adapter only translates
 * product descriptors and resolves the already-declared host secret.
 */
export async function createProductionMemoryCompositionFromConfiguration(
  options: ProductionMemoryCompositionOptions,
): Promise<ProductionMemoryComposition> {
  assertProductionSecretSource(options.secretSource);
  const primary = primaryDescriptor(options.configuration);
  const embedding = embeddingDescriptor(options.configuration);
  const primarySecret = resolveConfiguredSecretRequirement(
    options.configuration,
    primary.secretRef,
  );
  const embeddingSecret = resolveConfiguredSecretRequirement(
    options.configuration,
    embedding.secretRef,
  );
  if (!primarySecret || !embeddingSecret) {
    throw new Error("MEM0_PROVIDER_SECRET_REQUIRED");
  }

  const descriptor = resolveConfiguredModelDescriptorSet(options.configuration).embedding;
  const projection = await createOpenRouterMem0ProjectionAdapter({
    stateRoot: options.configuration.stateRoot,
    memory: options.configuration.memory,
    llm: primary,
    embedding,
    llmSecret: primarySecret,
    embeddingSecret,
    secretSource: options.secretSource,
    ...(options.load === undefined ? {} : { load: options.load }),
  });
  return Object.freeze({
    descriptor,
    projection,
    close: () => projection.close(),
  });
}
