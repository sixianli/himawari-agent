import type { AgentId, OwnerId, RunId, SessionId, ThreadId, TurnId } from "@himawari-agent/domain";
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
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly threadId: ThreadId | null;
  readonly modelRef: string;
  readonly systemInstructionRef: PayloadRef;
  readonly messageRefs: readonly PayloadRef[];
  readonly capabilityHandleRefs: readonly string[];
  readonly budget: JsonObject;
  readonly correlationId: CorrelationId;
  readonly dataClassification: DataClassification;
}

export type RuntimeEvent =
  | {
      readonly type: "runtime.model_started" | "runtime.completed";
      readonly runId: RunId;
      readonly occurredAt: string;
    }
  | {
      readonly type: "runtime.turn_started";
      readonly runId: RunId;
      readonly turnIndex: number;
      readonly occurredAt: string;
    }
  | {
      readonly type: "runtime.message";
      readonly runId: RunId;
      readonly phase: "started" | "updated" | "ended";
      readonly role: string;
      readonly sequence: number;
      readonly payloadRef: PayloadRef;
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
      readonly type: "runtime.provider_observation";
      readonly runId: RunId;
      readonly phase: "request" | "response";
      readonly payloadRef: PayloadRef;
      readonly occurredAt: string;
    }
  | {
      readonly type: "runtime.compaction_proposed";
      readonly runId: RunId;
      readonly proposalRef: PayloadRef;
      readonly occurredAt: string;
    }
  | {
      readonly type: "runtime.cancelled";
      readonly runId: RunId;
      readonly reasonCode: string;
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

export interface RuntimeProjectionCapture {
  readonly runId: RunId;
  readonly kind:
    | "message"
    | "tool_intent"
    | "tool_result"
    | "provider_request"
    | "provider_response";
  readonly value: unknown;
  readonly dataClassification: DataClassification;
  readonly sensitiveLiterals?: readonly string[];
}

export interface RuntimeCompactionProposal {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly summary: string;
  readonly firstKeptEntryId: string;
  readonly tokensBefore: number;
  readonly dataClassification: DataClassification;
}

/**
 * Product-owned projection boundary used by runtime adapters. Implementations
 * resolve product references for one Run and capture redacted observations back
 * as product Payload references. Pi Session data never implements this port.
 */
export interface RuntimeProjectionPort {
  resolveText(runId: RunId, payloadRef: PayloadRef): Promise<string>;
  capture(input: RuntimeProjectionCapture): Promise<PayloadRef>;
  proposeCompaction(input: RuntimeCompactionProposal): Promise<PayloadRef>;
}

export interface RuntimeToolDescriptor {
  readonly capabilityRef: string;
  readonly capabilityHandleRef: string;
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObject;
}

export interface RuntimeToolInvocation {
  readonly runId: RunId;
  readonly toolCallId: string;
  readonly capabilityRef: string;
  readonly capabilityHandleRef: string;
  readonly arguments: JsonObject;
  readonly dataClassification: DataClassification;
}

export interface RuntimeToolPreflightDecision {
  readonly allowed: boolean;
  readonly permissionDecisionRef: string;
  readonly reasonCode: string;
}

export interface RuntimeToolExecutionResult {
  readonly outcome: "succeeded" | "failed" | "result_unknown";
  readonly resultRef: PayloadRef | null;
  readonly errorCode: string | null;
  readonly externalActionId: string | null;
  readonly modelContent: string;
}

/**
 * Final product enforcement boundary for tools exposed to an Agent Runtime.
 * Implementations must make completed external actions idempotent by
 * `runId + toolCallId`.
 */
export interface RuntimeToolPort {
  listAuthorized(
    runId: RunId,
    capabilityHandleRefs: readonly string[],
  ): Promise<readonly RuntimeToolDescriptor[]>;
  preflight(invocation: RuntimeToolInvocation): Promise<RuntimeToolPreflightDecision>;
  execute(invocation: RuntimeToolInvocation): Promise<RuntimeToolExecutionResult>;
}
