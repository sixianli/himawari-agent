import type { AgentId, OwnerId, RunId, SessionId, TurnId } from "@himawari-agent/domain";
import type { CorrelationId, DataClassification, JsonObject, PayloadRef } from "./common.js";

export interface MemoryRecord {
  readonly id: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly contentRef: PayloadRef;
  readonly sourceRef: string;
  readonly searchTerms: readonly string[];
  readonly dataClassification: DataClassification;
  readonly updatedAt: string;
}

export interface MemoryCandidate extends MemoryRecord {
  readonly score: number;
}

export interface MemorySearchRequest {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly queryRef: PayloadRef;
  readonly queryTerms: readonly string[];
  readonly limit: number;
}

export interface MemoryWriteProposal {
  readonly id: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly contentRef: PayloadRef;
  readonly sourceRef: string;
  readonly searchTerms: readonly string[];
  readonly dataClassification: DataClassification;
  readonly proposedAt: string;
}

export interface MemoryCorrection {
  readonly memoryId: string;
  readonly contentRef: PayloadRef;
  readonly sourceRef: string;
  readonly searchTerms: readonly string[];
  readonly correctedAt: string;
}

export interface MemoryPort {
  search(request: MemorySearchRequest): Promise<readonly MemoryCandidate[]>;
  proposeWrite(proposal: MemoryWriteProposal): Promise<void>;
  listWriteProposals(agentId: AgentId): Promise<readonly MemoryWriteProposal[]>;
  commitWrite(proposalId: string, memoryId: string, committedAt: string): Promise<MemoryRecord>;
  correct(correction: MemoryCorrection): Promise<MemoryRecord>;
  delete(memoryId: string): Promise<boolean>;
}

export interface ModelDescriptor {
  readonly ref: string;
  readonly provider: string;
  readonly model: string;
  readonly version: string;
  readonly routingClass: ModelRoutingClass;
  readonly priority: number;
  readonly disclosure: ModelDisclosure;
  readonly capabilities: readonly string[];
  readonly allowedDataClassifications: readonly DataClassification[];
  readonly secretRequirement: ModelSecretRequirement | null;
}

export type ModelRoutingClass = "primary" | "specialist" | "local" | "fallback";

export type ModelDisclosure = "local_only" | "trusted_remote" | "external_remote";

export interface ModelSecretRequirement {
  readonly secretRef: string;
  readonly secretVersion: string;
  readonly purpose: string;
}

export interface ModelInvocationRequest {
  readonly invocationId: string;
  readonly runId: RunId;
  readonly modelRef: string;
  readonly inputRef: PayloadRef;
  readonly dataClassification: DataClassification;
  readonly allowedDisclosureRef: string;
  readonly secretHandleRefs: readonly string[];
  readonly correlationId: CorrelationId;
}

export type ModelInvocationEvent =
  | {
      readonly type: "model.started";
      readonly invocationId: string;
      readonly occurredAt: string;
    }
  | {
      readonly type: "model.output";
      readonly invocationId: string;
      readonly sequence: number;
      readonly payloadRef: PayloadRef;
      readonly occurredAt: string;
    }
  | {
      readonly type: "model.completed";
      readonly invocationId: string;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly costMicros: number;
      readonly latencyMs: number;
      readonly occurredAt: string;
    }
  | {
      readonly type: "model.failed";
      readonly invocationId: string;
      readonly errorCode: string;
      readonly retryable: boolean;
      readonly latencyMs: number;
      readonly occurredAt: string;
    };

export interface ModelPort {
  listAvailable(): Promise<readonly ModelDescriptor[]>;
  invoke(request: ModelInvocationRequest): AsyncIterable<ModelInvocationEvent>;
}

export interface RuntimeRequest {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly modelRef: string;
  readonly systemInstructionRef: PayloadRef;
  readonly messageRefs: readonly PayloadRef[];
  readonly capabilityHandleRefs: readonly string[];
  readonly budget: JsonObject;
  readonly correlationId: CorrelationId;
}

export type RuntimeEvent =
  | {
      readonly type: "runtime.model_started" | "runtime.completed";
      readonly runId: RunId;
      readonly occurredAt: string;
    }
  | {
      readonly type: "runtime.model_output";
      readonly runId: RunId;
      readonly sequence: number;
      readonly payloadRef: PayloadRef;
      readonly occurredAt: string;
    }
  | {
      readonly type: "runtime.tool_intent" | "runtime.tool_result";
      readonly runId: RunId;
      readonly capabilityRef: string;
      readonly payloadRef: PayloadRef;
      readonly occurredAt: string;
    }
  | {
      readonly type: "runtime.turn_completed";
      readonly runId: RunId;
      readonly turnId: TurnId;
      readonly occurredAt: string;
    }
  | {
      readonly type: "runtime.failed";
      readonly runId: RunId;
      readonly errorCode: string;
      readonly occurredAt: string;
    };

export interface AgentRuntimePort {
  run(request: RuntimeRequest): AsyncIterable<RuntimeEvent>;
  cancel(runId: RunId): Promise<void>;
}
