import type { MemoryDates } from "./memory-dates.js";
import type { AgentId, OwnerId, RunId, SessionId, ThreadId, TurnId } from "@himawari-agent/domain";
import type { CorrelationId, DataClassification, JsonObject, PayloadRef } from "./common.js";
import type { ProductContextBlockKind } from "./context-projection.js";
import type { RunExecutionLeaseClaim } from "./run-dispatch.js";

export type { ProductContextEnvelopeV1 } from "./context-projection.js";

export interface MemoryRecord {
  readonly id: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly contentRef: PayloadRef;
  readonly sourceRef: string;
  readonly searchTerms: readonly string[];
  readonly dataClassification: DataClassification;
  readonly updatedAt: string;
  readonly dates?: MemoryDates;
}

export interface MemoryCandidate extends MemoryRecord {
  readonly score: number;
}

export interface MemorySearchRequest {
  readonly signal?: AbortSignal;
  readonly deadlineAt?: string;
  readonly runId?: RunId;
  readonly executionLease?: RunExecutionLeaseClaim;
  readonly dataClassification?: DataClassification;
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
  readonly providerRouting?: ModelProviderRouting;
}

export type ModelRoutingClass = "primary" | "specialist" | "local" | "fallback";

export type ModelDisclosure = "local_only" | "trusted_remote" | "external_remote";

export interface ModelSecretRequirement {
  readonly secretRef: string;
  readonly secretVersion: string;
  readonly purpose: string;
}

export interface ModelProviderRouting {
  readonly order: readonly string[];
  readonly sort: "cost";
}

export interface ModelInvocationRequest {
  readonly signal?: AbortSignal;
  readonly invocationId: string;
  readonly runId: RunId;
  readonly modelRef: string;
  readonly inputRef: PayloadRef;
  readonly dataClassification: DataClassification;
  readonly allowedDisclosureRef: string;
  readonly secretHandleRefs: readonly string[];
  readonly correlationId: CorrelationId;
}

export interface ModelProviderObservation {
  readonly provider: string | null;
  readonly model: string | null;
  readonly generationId: string | null;
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
      readonly cacheReadTokens?: number;
      readonly cacheWriteTokens?: number;
      readonly cacheReported?: boolean;
      readonly costMicros: number;
      readonly latencyMs: number;
      readonly providerObservation?: ModelProviderObservation;
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

export interface RuntimeKnownToolResult {
  readonly capabilityRef: string;
  readonly jobId: string;
  readonly invocationId: string;
  readonly continuationRef: PayloadRef;
  readonly toolCallId: string;
}

export interface RuntimeRequest {
  readonly knownToolResult?: RuntimeKnownToolResult;
  readonly thinkingLevel?: import("./run-execution-source.js").RunThinkingLevel;
  readonly continuationRef?: PayloadRef;
  readonly executionDeadlineAt?: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly runId: RunId;
  readonly executionLease: RunExecutionLeaseClaim;
  readonly sessionId: SessionId;
  readonly threadId: ThreadId | null;
  readonly modelRef: string;
  readonly systemInstructionRef: PayloadRef;
  readonly contextEnvelopeRef: PayloadRef;
  readonly workerResultRefs: readonly RuntimeWorkerResultReference[];
  readonly capabilityHandleRefs: readonly string[];
  readonly budget: JsonObject;
  readonly correlationId: CorrelationId;
  readonly dataClassification: DataClassification;
}

export interface RuntimeWorkerResultReference {
  readonly workerRunId: string;
  readonly resultRef: PayloadRef;
}

export type RuntimeSuccessfulOutput =
  | { readonly kind: "assistant-answer"; readonly contentRef: PayloadRef }
  | { readonly kind: "no-answer" };

export type RuntimeEvent =
  | {
      readonly type: "runtime.suspended";
      readonly runId: RunId;
      readonly continuationRef: PayloadRef;
      readonly approval: RuntimeApprovalWait;
      readonly occurredAt: string;
    }
  | {
      readonly type: "runtime.result_unknown";
      readonly runId: RunId;
      readonly toolCallId: string;
      readonly capabilityRef: string;
      readonly externalActionId: string | null;
      readonly occurredAt: string;
    }
  | {
      readonly type: "runtime.model_started";
      readonly modelRef?: string;
      readonly thinkingLevel?: string;
      readonly runId: RunId;
      readonly occurredAt: string;
    }
  | {
      readonly type: "runtime.completed";
      readonly runId: RunId;
      readonly occurredAt: string;
      readonly output: RuntimeSuccessfulOutput;
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

export type RuntimeProjectionContent =
  | {
      readonly type: "text";
      readonly text: string;
    }
  | {
      readonly type: "tool_call";
      readonly id: string;
      readonly name: string;
      readonly arguments: JsonObject;
    };

export type RuntimeProjectionMessage =
  | {
      readonly id: string;
      readonly role: "user" | "assistant";
      readonly content: readonly RuntimeProjectionContent[];
      readonly occurredAt: string;
      readonly stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
    }
  | {
      readonly id: string;
      readonly role: "tool_result";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly content: readonly Extract<RuntimeProjectionContent, { readonly type: "text" }>[];
      readonly isError: boolean;
      readonly occurredAt: string;
    };

export interface RuntimeProjectionCompaction {
  readonly summary: string;
  readonly firstKeptMessageId: string;
  readonly tokensBefore: number;
}

export interface RuntimeProjectionContext {
  readonly nativeHistory?: import("./runtime-history.js").RuntimeHistoryState;
  readonly coveredRunIds?: readonly RunId[];
  readonly interruptedRunId?: RunId;
  readonly history: readonly RuntimeProjectionMessage[];
  readonly prompt: {
    readonly id: string;
    readonly content: string;
    readonly occurredAt: string;
    readonly images?: readonly RuntimeProjectionImage[];
  };
  readonly contextBlocks: readonly RuntimeProjectionContextBlock[];
  readonly compaction?: RuntimeProjectionCompaction;
}

export interface RuntimeProjectionImage {
  readonly mimeType: string;
  readonly data: string;
}

export interface RuntimeProjectionContextBlock {
  readonly authority: "non-authoritative";
  readonly kind: ProductContextBlockKind | "system-history" | "worker-result";
  readonly ref: string;
  readonly content: string;
  readonly sourceRef?: string;
  readonly dataClassification: DataClassification;
  readonly productRole?: "system";
  readonly dates?: MemoryDates;
}

export type RuntimeProjectionRequest = Pick<
  RuntimeRequest,
  | "ownerId"
  | "agentId"
  | "runId"
  | "sessionId"
  | "threadId"
  | "systemInstructionRef"
  | "contextEnvelopeRef"
  | "workerResultRefs"
  | "dataClassification"
>;

export interface RuntimeProjection extends RuntimeProjectionContext {
  readonly systemInstruction: string;
  readonly answerLocaleRef?: string;
  readonly contentClassification?: DataClassification;
  readonly ownerAttachments?: number;
}

export interface RuntimeProjectionPort {
  captureHistory?(
    input: Parameters<import("./runtime-history.js").RuntimeHistoryPort["save"]>[0],
  ): Promise<import("./runtime-history.js").RuntimeHistoryReference>;
  resolveProjection(input: RuntimeProjectionRequest): Promise<RuntimeProjection>;
  capture(input: RuntimeProjectionCapture): Promise<PayloadRef>;
  captureFinalAnswer(input: {
    readonly runId: RunId;
    readonly text: string;
    readonly dataClassification: DataClassification;
  }): Promise<PayloadRef>;
  proposeCompaction(input: RuntimeCompactionProposal): Promise<PayloadRef>;
}

export type RuntimeToolDescriptor =
  | RuntimeCustomToolDescriptor
  | RuntimeBuiltinReadDescriptor
  | RuntimeBuiltinCodingDescriptor;

export interface RuntimeBuiltinCodingDescriptor {
  readonly definition: "builtin-coding";
  readonly name: "read" | "write" | "edit" | "bash" | "find" | "grep" | "ls";
  readonly capabilityRef: string;
  readonly capabilityHandleRef: string | null;
  readonly executionMode?: "parallel";
}

export interface RuntimeBuiltinReadDescriptor {
  readonly definition: "builtin-read";
  readonly name: "read";
  readonly capabilityRef: string;
  readonly capabilityHandleRef: null;
}

export interface RuntimeCustomToolDescriptor {
  readonly definition?: never;
  readonly capabilityRef: string;
  readonly capabilityHandleRef: string | null;
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObject;
  readonly executionMode?: "parallel";
  readonly handleBound?: true;
}

export interface RuntimeToolInvocation {
  readonly fileConflictOf?: string;
  readonly context?: Pick<
    RuntimeRequest,
    "threadId" | "modelRef" | "executionLease" | "continuationRef"
  >;
  readonly executionDeadlineAt?: string;
  readonly runId: RunId;
  readonly toolCallId: string;
  readonly capabilityRef: string;
  readonly capabilityHandleRef: string | null;
  readonly arguments: JsonObject;
  readonly dataClassification: DataClassification;
}

export interface RuntimeToolPreflightDecision {
  readonly allowed: boolean;
  readonly permissionDecisionRef: string;
  readonly reasonCode: string;
}

export interface RuntimeApprovalWait {
  readonly approvalRequestId: string;
  readonly semanticSnapshotHash: string;
  readonly expiresAt: string;
}

export interface RuntimeContinuationPort {
  save(request: RuntimeRequest, value: unknown): Promise<PayloadRef>;
  load(request: RuntimeRequest, ref: PayloadRef): Promise<unknown>;
}

export interface RuntimeToolSettledResult {
  readonly dispatchState?: "not_sent" | "possibly_sent" | "accepted";
  readonly executionTiming?: { readonly startedAt: string; readonly endedAt: string };
  readonly outcome: "succeeded" | "failed" | "result_unknown";
  readonly resultRef: PayloadRef | null;
  readonly errorCode: string | null;
  readonly externalActionId: string | null;
  readonly modelContent: string;
  readonly contentClassification?: DataClassification;
  readonly refused?: true;
}

export interface RuntimeToolSuspendedResult {
  readonly outcome: "awaiting_approval";
  readonly approval: RuntimeApprovalWait;
  readonly resultRef: null;
  readonly errorCode: null;
  readonly externalActionId: null;
  readonly modelContent: "";
}

export type RuntimeToolExecutionResult = RuntimeToolSettledResult | RuntimeToolSuspendedResult;

export interface RuntimeBackgroundCommandNotice {
  readonly taskRef: string;
  readonly modelContent: string;
}

export interface RuntimeToolPort {
  subscribeBackground?(
    runId: RunId,
    listener: (notice: RuntimeBackgroundCommandNotice) => boolean,
  ): () => void;
  recoverResult?(
    invocation: RuntimeToolInvocation,
    recovery: RuntimeKnownToolResult,
  ): Promise<RuntimeToolSettledResult>;
  listAuthorized(
    runId: RunId,
    capabilityHandleRefs: readonly string[],
  ): Promise<readonly RuntimeToolDescriptor[]>;
  preflight(invocation: RuntimeToolInvocation): Promise<RuntimeToolPreflightDecision>;
  execute(
    invocation: RuntimeToolInvocation,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RuntimeToolExecutionResult>;
}
