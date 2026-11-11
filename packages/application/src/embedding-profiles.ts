import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import {
  MEMORY_EMBEDDING_DOCUMENT_GEMMA,
  MEMORY_EMBEDDING_DOCUMENT_JINA,
  MEMORY_EMBEDDING_QUERY_GEMMA,
  MEMORY_EMBEDDING_QUERY_JINA,
  MEMORY_EMBEDDING_QUERY_QWEN3,
  type PromptEntry,
  renderPrompt,
} from "@himawari-agent/prompt-catalog";
import { EGRESS_RULESET_CURRENT } from "@himawari-agent/sensitive-capture";
import type { ConfiguredEmbeddingModelDescriptor } from "./ports/configuration.js";

export const LOCAL_ONNX_EMBEDDING_PROVIDER = "local-onnx" as const;
export const EMBEDDING_PRIORITY_HEADER = "x-himawari-embedding-priority" as const;
export type EmbeddingPriority = "interactive" | "background";
export const GATEWAY_EMBEDDING_PROVIDER = "vercel-ai-gateway" as const;

export type EmbeddingProfileProvider =
  | typeof LOCAL_ONNX_EMBEDDING_PROVIDER
  | typeof GATEWAY_EMBEDDING_PROVIDER;

export interface EmbeddingArtifactSource {
  readonly repository: string;
  readonly revision: string;
  readonly file: string;
  readonly externalData: readonly string[];
  readonly quantization: "dynamic-int8-per-channel" | "none";
}

export interface EmbeddingProfile {
  readonly model: string;
  readonly provider: EmbeddingProfileProvider;
  readonly dimensions: readonly number[];
  readonly pooling: "last_token" | "sentence_embedding";
  readonly query: PromptEntry;
  readonly document: PromptEntry | null;
  readonly chatMinimumSimilarity: number;
  readonly proactiveMinimumSimilarity: number;
  readonly license: string;
  readonly source: EmbeddingArtifactSource | null;
}

export const QWEN3_EMBEDDING_8B_PROFILE: EmbeddingProfile = Object.freeze({
  model: "alibaba/qwen3-embedding-8b",
  provider: GATEWAY_EMBEDDING_PROVIDER,
  dimensions: Object.freeze([4096, 1024]),
  pooling: "last_token",
  query: MEMORY_EMBEDDING_QUERY_QWEN3,
  document: null,
  chatMinimumSimilarity: 0.6,
  proactiveMinimumSimilarity: 0.45,
  license: "Apache-2.0",
  source: null,
});

export const JINA_V5_SMALL_INT8_PROFILE: EmbeddingProfile = Object.freeze({
  model: "jina-embeddings-v5-text-small-retrieval-int8",
  provider: LOCAL_ONNX_EMBEDDING_PROVIDER,
  dimensions: Object.freeze([1024]),
  pooling: "last_token",
  query: MEMORY_EMBEDDING_QUERY_JINA,
  document: MEMORY_EMBEDDING_DOCUMENT_JINA,
  chatMinimumSimilarity: 0.3,
  proactiveMinimumSimilarity: 0.2,
  license: "CC-BY-NC-4.0",
  source: Object.freeze({
    repository: "jinaai/jina-embeddings-v5-text-small-retrieval",
    revision: "6856e76bb72982e58de0620458a4e8b3614da340",
    file: "onnx/model.onnx",
    externalData: Object.freeze(["onnx/model.onnx_data"]),
    quantization: "dynamic-int8-per-channel",
  }),
});

export const QWEN3_EMBEDDING_0_6B_INT8_PROFILE: EmbeddingProfile = Object.freeze({
  model: "qwen3-embedding-0.6b-int8",
  provider: LOCAL_ONNX_EMBEDDING_PROVIDER,
  dimensions: Object.freeze([1024]),
  pooling: "last_token",
  query: MEMORY_EMBEDDING_QUERY_QWEN3,
  document: null,
  chatMinimumSimilarity: 0.52,
  proactiveMinimumSimilarity: 0.47,
  license: "Apache-2.0",
  source: Object.freeze({
    repository: "onnx-community/Qwen3-Embedding-0.6B-ONNX",
    revision: "c25a394dd583836952667c12f008335071b3f43d",
    file: "onnx/model_quantized.onnx",
    externalData: Object.freeze([]),
    quantization: "none",
  }),
});

export const EMBEDDINGGEMMA_2_PROFILE: EmbeddingProfile = Object.freeze({
  model: "embeddinggemma-2-fp32",
  provider: LOCAL_ONNX_EMBEDDING_PROVIDER,
  dimensions: Object.freeze([768]),
  pooling: "sentence_embedding",
  query: MEMORY_EMBEDDING_QUERY_GEMMA,
  document: MEMORY_EMBEDDING_DOCUMENT_GEMMA,
  chatMinimumSimilarity: 0.78,
  proactiveMinimumSimilarity: 0.74,
  license: "Apache-2.0",
  source: Object.freeze({
    repository: "onnx-community/embeddinggemma-2-ONNX",
    revision: "daa72c51243991dfcaf9f9137d2c573d8f7790c0",
    file: "onnx/model.onnx",
    externalData: Object.freeze(["onnx/model.onnx_data"]),
    quantization: "none",
  }),
});

export const EMBEDDING_PROFILES: readonly EmbeddingProfile[] = Object.freeze([
  JINA_V5_SMALL_INT8_PROFILE,
  QWEN3_EMBEDDING_0_6B_INT8_PROFILE,
  EMBEDDINGGEMMA_2_PROFILE,
  QWEN3_EMBEDDING_8B_PROFILE,
]);

export function findEmbeddingProfile(
  provider: string,
  model: string,
): EmbeddingProfile | undefined {
  return EMBEDDING_PROFILES.find(
    (profile) => profile.provider === provider && profile.model === model,
  );
}

export function embeddingProfileFor(
  descriptor: Pick<ConfiguredEmbeddingModelDescriptor, "provider" | "model" | "dimensions">,
): EmbeddingProfile {
  const profile = findEmbeddingProfile(descriptor.provider, descriptor.model);
  if (!profile) throw new TypeError("EMBEDDING_PROFILE_UNKNOWN");
  if (!profile.dimensions.includes(descriptor.dimensions))
    throw new TypeError("EMBEDDING_PROFILE_DIMENSIONS_UNSUPPORTED");
  return profile;
}

export function embeddingQueryText(profile: EmbeddingProfile, query: string): string {
  return renderPrompt(profile.query, { query });
}

export function embeddingDocumentText(profile: EmbeddingProfile, text: string): string {
  return profile.document === null ? text : renderPrompt(profile.document, { text });
}

function recipe(profile: EmbeddingProfile, dimensions: number): string {
  const segments = (entry: PromptEntry | null) =>
    entry === null
      ? null
      : entry.segments.map((segment) =>
          segment.kind === "text" ? ["text", segment.text] : ["slot", segment.name],
        );
  return JSON.stringify([
    profile.provider,
    profile.model,
    dimensions,
    profile.pooling,
    segments(profile.query),
    segments(profile.document),
  ]);
}

export function embeddingIdentityFor(
  profile: EmbeddingProfile,
  descriptor: Pick<ConfiguredEmbeddingModelDescriptor, "dimensions" | "artifactSha256">,
  redactionRuleset: number = EGRESS_RULESET_CURRENT,
): string {
  const digest = bytesToHex(
    sha256(
      utf8ToBytes(
        JSON.stringify([
          recipe(profile, descriptor.dimensions),
          descriptor.artifactSha256 ?? null,
          redactionRuleset,
        ]),
      ),
    ),
  ).slice(0, 16);
  return `${profile.model}#${digest}`;
}

export function embeddingIdentity(
  descriptor: Pick<
    ConfiguredEmbeddingModelDescriptor,
    "provider" | "model" | "dimensions" | "artifactSha256"
  >,
  redactionRuleset: number = EGRESS_RULESET_CURRENT,
): string {
  return embeddingIdentityFor(embeddingProfileFor(descriptor), descriptor, redactionRuleset);
}
