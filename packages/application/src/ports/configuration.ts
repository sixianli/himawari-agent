import type { AgentId, DeploymentId, OwnerId } from "@himawari-agent/domain";
import type { DataClassification } from "./common.js";
import type { ModelProviderRouting } from "./intelligence.js";

export interface SecretReferenceDescriptor {
  readonly ref: string;
  readonly version: string;
  readonly purpose: string;
  readonly scope: string;
}

/**
 * Provider pricing in USD per million input/output tokens (or the provider's
 * equivalent unit for an embedding request). Keeping this shape in the
 * product configuration lets the budget and disclosure policy see the exact
 * selected identity without importing the Pi runtime package.
 */
export interface ModelCostDescriptor {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

interface ConfiguredModelDescriptorBase {
  readonly ref: string;
  readonly provider: string;
  readonly model: string;
  readonly version: string;
  readonly allowedDataClassifications: readonly DataClassification[];
  readonly disclosure: "local_only" | "trusted_remote" | "external_remote";
  readonly secretRef: string | null;
  readonly capabilities: readonly string[];
  readonly cost: ModelCostDescriptor;
  readonly providerRouting?: ModelProviderRouting;
}

export interface ConfiguredGenerationModelDescriptor extends ConfiguredModelDescriptorBase {
  readonly role: "primary" | "fallback";
  readonly priority: number;
  readonly name: string;
  readonly api: "openai-completions";
  readonly reasoning: boolean;
  readonly input: readonly ("text" | "image")[];
  readonly contextWindow: number;
  readonly maxTokens: number;
}

export interface ConfiguredEmbeddingModelDescriptor extends ConfiguredModelDescriptorBase {
  readonly role: "embedding";
  readonly dimensions: number;
}

export type ConfiguredModelDescriptor =
  | ConfiguredGenerationModelDescriptor
  | ConfiguredEmbeddingModelDescriptor;

export interface ConfiguredMemoryDescriptor {
  readonly adapter: "mem0-oss";
  readonly version: string;
  readonly storagePath: string;
  readonly dimensions: number;
}

export interface BudgetConfiguration {
  readonly globalCostMicros: number;
  readonly perRunCostMicros: number;
  readonly perClassificationCostMicros: Readonly<Record<DataClassification, number>>;
}

export interface ConcurrencyConfiguration {
  readonly totalRuns: number;
  readonly foregroundReserved: number;
  readonly perCategory: Readonly<Record<string, number>>;
}

export interface DeadlineConfiguration {
  readonly runMs: number;
  readonly workerRequestMs: number;
  readonly providerRequestMs: number;
}

export interface HttpConfiguration {
  readonly listenHost: string;
  readonly listenPort: number;
  readonly staticRoot: string;
  readonly sessionCookieName: string;
  readonly maximumBodyBytes: number;
  readonly maximumStaticAssetBytes: number;
  readonly heartbeatMilliseconds: number;
}

export interface RecentAuthenticationConfiguration {
  readonly maximumAgeMilliseconds: number;
  readonly clockSkewMilliseconds: number;
}

export interface IdentityBootstrapConfiguration {
  readonly enabled: boolean;
  readonly expiresAt: string;
  readonly tokenSecretRef: string | null;
}

export interface IdentityCsrfConfiguration {
  readonly keySecretRef: string;
  readonly ttlMilliseconds: number;
}

export interface IdentityConfiguration {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string;
  readonly jwksCacheMilliseconds: number;
  readonly jwksTimeoutMilliseconds: number;
  readonly jwksMaximumBodyBytes: number;
  readonly clockToleranceSeconds: number;
  readonly identityLookupTimeoutMilliseconds: number;
  readonly identityLookupMaximumBodyBytes: number;
  readonly recentAuthentication: RecentAuthenticationConfiguration;
  readonly bootstrap: IdentityBootstrapConfiguration;
  readonly csrf: IdentityCsrfConfiguration;
}

export interface CapabilityDeploymentConfiguration {
  readonly snapshotPath: string;
  readonly sha256: string;
}

/** Host-owned, versioned instructions; never supplied by a browser message. */
export interface RunPolicyConfiguration {
  readonly version: string;
  readonly systemInstruction: string;
  readonly memoryLimit: number;
  readonly maxSelectedMemories: number;
  readonly maxMemoryClassification: DataClassification;
}

export interface ProductConfiguration {
  readonly schemaVersion: string;
  readonly deploymentId: DeploymentId;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly stateRoot: string;
  readonly runtimeDirectory: string;
  readonly cacheDirectory: string;
  readonly publicOrigin: string;
  readonly publicMode: boolean;
  readonly runPolicy?: RunPolicyConfiguration;
  /** Present only when a verified capability deployment snapshot is configured. */
  readonly capabilityDeployment?: CapabilityDeploymentConfiguration;
  /** Present only for a configured public HTTP composition. */
  readonly http?: HttpConfiguration;
  /** Present only for a configured public identity composition. */
  readonly identity?: IdentityConfiguration;
  readonly modelDescriptors: readonly ConfiguredModelDescriptor[];
  readonly memory: ConfiguredMemoryDescriptor;
  readonly repositoryAllowlistRefs: readonly string[];
  readonly secretReferences: readonly SecretReferenceDescriptor[];
  readonly budgets: BudgetConfiguration;
  readonly concurrency: ConcurrencyConfiguration;
  readonly deadlines: DeadlineConfiguration;
  readonly loadedAt: string;
}

export interface ConfigurationPort {
  load(): Promise<ProductConfiguration>;
}
