import type { AgentId, DeploymentId, OwnerId } from "@himawari-agent/domain";
import type { DataClassification } from "./common.js";
import type { ModelProviderRouting } from "./intelligence.js";

export interface SecretReferenceDescriptor {
  readonly ref: string;
  readonly version: string;
  readonly purpose: string;
  readonly scope: string;
}

export interface ConfiguredModelDescriptor {
  readonly ref: string;
  readonly role: "primary" | "fallback" | "embedding";
  readonly provider: string;
  readonly model: string;
  readonly version: string;
  readonly allowedDataClassifications: readonly DataClassification[];
  readonly disclosure: "local_only" | "trusted_remote" | "external_remote";
  readonly secretRef: string | null;
  readonly providerRouting?: ModelProviderRouting;
}

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
