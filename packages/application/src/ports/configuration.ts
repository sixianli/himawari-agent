import type { AgentId, DeploymentId, OwnerId } from "@himawari-agent/domain";
import type { DataClassification } from "./common.js";

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
}

export interface ProductConfiguration {
  readonly schemaVersion: string;
  readonly deploymentId: DeploymentId;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly stateRoot: string;
  readonly runtimeDirectory: string;
  readonly publicOrigin: string;
  readonly publicMode: boolean;
  readonly modelDescriptors: readonly ConfiguredModelDescriptor[];
  readonly memoryDescriptorRef: string;
  readonly repositoryAllowlistRefs: readonly string[];
  readonly secretReferences: readonly SecretReferenceDescriptor[];
  readonly loadedAt: string;
}

export interface ConfigurationPort {
  load(): Promise<ProductConfiguration>;
}
