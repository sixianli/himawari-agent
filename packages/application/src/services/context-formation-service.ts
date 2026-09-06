import type {
  AgentId,
  AnswerLocale,
  MessageId,
  OwnerId,
  ProductThreadMessage,
  RunId,
  SessionId,
  ThreadId,
} from "@himawari-agent/domain";
import { createMessageId } from "@himawari-agent/domain";
import type {
  CorrelationId,
  DataClassification,
  PayloadRef,
  TraceEventId,
} from "../ports/common.js";
import {
  contextArtifactOperationKey,
  type ProductContextBlock,
  type ProductContextEnvelopeV1,
  type ProductContextMessageRole,
} from "../ports/context-projection.js";
import type { ThreadDistillationStatePort, ThreadSummaryRecord } from "../ports/conversation.js";
import type { MemoryCandidate, MemoryPort } from "../ports/intelligence.js";
import type { PayloadProtectorPort, PayloadStorePort } from "../ports/observability.js";
import type { RunPayloadArtifactPort } from "../ports/run-payload-artifacts.js";
import type { ClockPort, IdGeneratorPort } from "../ports/system.js";
import type { ThreadContextSnapshot, ThreadRepositoryPort } from "../ports/threads.js";
import type { SessionTraceRecorder } from "./session-trace-recorder.js";

const CLASSIFICATION_RANK = Object.freeze({ public: 0, private: 1, sensitive: 2, restricted: 3 });

export type ContextTriggerSource = "user_message" | "schedule" | "external_event";

export interface ContextThreadMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "system" | "tool";
  readonly payloadRef: PayloadRef;
  readonly occurredAt: string;
  readonly sourceRef?: string;
  readonly dataClassification?: DataClassification;
  readonly relevanceScore?: number;
  readonly sequence?: number;
}

export interface ContextPolicySummary {
  readonly ref: string;
  readonly payloadRef: PayloadRef;
}

export interface ContextCapabilitySummary {
  readonly ref: string;
  readonly version: string;
  readonly summaryRef: PayloadRef;
  readonly authorizationRef: string | null;
}

export interface ContextFormationRequest {
  readonly signal?: AbortSignal;
  readonly deadlineAt?: string;
  readonly executionLease?: import("../ports/run-dispatch.js").RunExecutionLeaseClaim;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly threadId: ThreadId | null;
  readonly runId: RunId;
  readonly trigger: {
    readonly id: string;
    readonly sourceType: ContextTriggerSource;
    readonly payloadRef: PayloadRef;
    readonly occurredAt: string;
  };
  readonly threadMessages: readonly ContextThreadMessage[];
  readonly policies: readonly ContextPolicySummary[];
  readonly answerLocalePolicy?: ContextPolicySummary & { readonly locale: AnswerLocale };
  readonly historyCandidates?: readonly ContextThreadMessage[];
  readonly sourceWatermark: number | null;
  readonly policyVersion: string;
  readonly maxThreadMessages?: number;
  readonly memoryQueryRef: PayloadRef;
  readonly memoryQueryTerms: readonly string[];
  readonly memoryLimit: number;
  readonly maxSelectedMemories: number;
  readonly maxMemoryClassification: DataClassification;
  readonly capabilities: readonly ContextCapabilitySummary[];
  readonly correlationId: CorrelationId;
  readonly causationId: string;
  readonly parentEventId: TraceEventId | null;
  readonly actorId: string;
  readonly dataClassification: DataClassification;
}

export interface SelectedMemory extends MemoryCandidate {
  readonly reasonCode: "relevant_and_classification_allowed";
}

export interface FormedContext {
  readonly triggerSourceType: ContextTriggerSource;
  readonly candidates: readonly MemoryCandidate[];
  readonly selected: readonly SelectedMemory[];
  readonly injectedContentRefs: readonly PayloadRef[];
  readonly contextEnvelopeRef: PayloadRef;
  readonly envelope: ProductContextEnvelopeV1;
  readonly traceEventIds: readonly TraceEventId[];
  readonly answerLocale: AnswerLocale | null;
}

export interface ContextFormationServiceDependencies {
  readonly memory: Pick<MemoryPort, "search">;
  readonly trace: SessionTraceRecorder;
  readonly artifacts: RunPayloadArtifactPort;
  readonly payloads: Pick<PayloadStorePort, "get">;
  readonly protector: PayloadProtectorPort;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
  readonly threads?: Pick<ThreadRepositoryPort, "readContextSnapshot">;
  readonly threadSummaries?: Pick<ThreadDistillationStatePort, "latestSummary">;
}

export interface ContextFormationPort {
  form(request: ContextFormationRequest): Promise<FormedContext>;
}

export class ContextFormationService implements ContextFormationPort {
  private readonly dependencies: ContextFormationServiceDependencies;

  constructor(dependencies: ContextFormationServiceDependencies) {
    this.dependencies = dependencies;
  }

  async form(request: ContextFormationRequest): Promise<FormedContext> {
    const existing = await this.readExistingEnvelope(request);
    if (existing) return this.replayedContext(request, existing);
    const snapshot = await this.readSnapshot(request);
    const sourceMessages = snapshot
      ? snapshot.messages.map((message) => contextMessageFromProductMessage(message))
      : request.threadMessages;
    const sourceWatermark = snapshot ? snapshot.sourceWatermark : request.sourceWatermark;
    if (
      snapshot &&
      request.sourceWatermark !== null &&
      request.sourceWatermark !== sourceWatermark
    ) {
      throw new Error("CONTEXT_SOURCE_WATERMARK_CONFLICT");
    }
    const latestSummary =
      request.threadId && this.dependencies.threadSummaries
        ? await this.dependencies.threadSummaries.latestSummary(request.threadId)
        : undefined;
    const allowedSummary =
      latestSummary &&
      (snapshot === undefined ||
        (sourceWatermark !== null &&
          latestSummary.sourceWatermark <= sourceWatermark &&
          latestSummary.sourceEndSequence <= sourceWatermark)) &&
      CLASSIFICATION_RANK[latestSummary.dataClassification] <=
        CLASSIFICATION_RANK[request.maxMemoryClassification]
        ? latestSummary
        : undefined;
    const historyCandidates = snapshot
      ? sourceMessages
      : (request.historyCandidates ?? sourceMessages);
    const eligibleHistory = [...historyCandidates]
      .filter(
        ({ id, payloadRef }) =>
          id !== request.trigger.id && payloadRef !== request.trigger.payloadRef,
      )
      .filter(
        ({ dataClassification = request.dataClassification }) =>
          CLASSIFICATION_RANK[dataClassification] <=
          CLASSIFICATION_RANK[request.maxMemoryClassification],
      );
    const historyLimit = request.maxThreadMessages ?? eligibleHistory.length;
    if (!Number.isSafeInteger(historyLimit) || historyLimit < 0) {
      throw new Error("CONTEXT_HISTORY_LIMIT_INVALID");
    }
    const selectedHistory = snapshot
      ? eligibleHistory.slice(Math.max(0, eligibleHistory.length - historyLimit))
      : eligibleHistory
          .sort(
            (left, right) =>
              (right.relevanceScore ?? 0) - (left.relevanceScore ?? 0) ||
              left.occurredAt.localeCompare(right.occurredAt) ||
              left.id.localeCompare(right.id),
          )
          .slice(0, historyLimit)
          .sort(
            (left, right) =>
              left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id),
          );
    const query = await this.dependencies.trace.record({
      ...this.traceScope(request),
      parentEventId: request.parentEventId,
      causationId: request.causationId,
      eventType: "memory.query",
      payload: {
        queryRef: request.memoryQueryRef,
        queryTerms: request.memoryQueryTerms,
        limit: request.memoryLimit,
        triggerId: request.trigger.id,
        triggerSourceType: request.trigger.sourceType,
      },
    });

    const candidates = [
      ...(await this.dependencies.memory.search({
        runId: request.runId,
        ...(request.executionLease ? { executionLease: request.executionLease } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
        ...(request.deadlineAt ? { deadlineAt: request.deadlineAt } : {}),
        dataClassification: request.dataClassification,
        ownerId: request.ownerId,
        agentId: request.agentId,
        queryRef: request.memoryQueryRef,
        queryTerms: request.memoryQueryTerms,
        limit: request.memoryLimit,
      })),
    ].sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
    const candidateTrace = await this.dependencies.trace.record({
      ...this.traceScope(request),
      parentEventId: query.event.id,
      causationId: query.event.id,
      eventType: "memory.candidates",
      payload: {
        candidates: candidates.map((candidate) => ({
          id: candidate.id,
          contentRef: candidate.contentRef,
          sourceRef: candidate.sourceRef,
          searchTerms: candidate.searchTerms,
          dataClassification: candidate.dataClassification,
          score: candidate.score,
          updatedAt: candidate.updatedAt,
        })),
      },
    });

    const allowed = candidates.filter(
      (candidate) =>
        CLASSIFICATION_RANK[candidate.dataClassification] <=
          CLASSIFICATION_RANK[request.maxMemoryClassification] &&
        CLASSIFICATION_RANK[candidate.dataClassification] <=
          CLASSIFICATION_RANK[request.dataClassification],
    );
    const selected: readonly SelectedMemory[] = allowed
      .slice(0, request.maxSelectedMemories)
      .map((candidate) => ({
        ...candidate,
        reasonCode: "relevant_and_classification_allowed" as const,
      }));
    const selectedIds = new Set(selected.map(({ id }) => id));
    const selectionTrace = await this.dependencies.trace.record({
      ...this.traceScope(request),
      parentEventId: candidateTrace.event.id,
      causationId: candidateTrace.event.id,
      eventType: "memory.selection",
      payload: {
        selected: selected.map(({ id, contentRef, sourceRef, score, reasonCode }) => ({
          id,
          contentRef,
          sourceRef,
          score,
          reasonCode,
        })),
        excluded: candidates
          .filter(({ id }) => !selectedIds.has(id))
          .map((candidate) => ({
            id: candidate.id,
            reasonCode:
              CLASSIFICATION_RANK[candidate.dataClassification] >
              Math.min(
                CLASSIFICATION_RANK[request.maxMemoryClassification],
                CLASSIFICATION_RANK[request.dataClassification],
              )
                ? "classification_exceeds_context"
                : "selection_limit_reached",
          })),
      },
    });

    const injectedContentRefs = Object.freeze([
      ...(allowedSummary ? [allowedSummary.contentRef] : []),
      ...selectedHistory.map(({ payloadRef }) => payloadRef),
      request.trigger.payloadRef,
      ...request.policies.map(({ payloadRef }) => payloadRef),
      ...(request.answerLocalePolicy ? [request.answerLocalePolicy.payloadRef] : []),
      ...selected.map(({ contentRef }) => contentRef),
      ...request.capabilities.map(({ summaryRef }) => summaryRef),
    ]);
    const envelope = this.createEnvelope({
      request,
      sourceWatermark,
      selectedHistory,
      allowedSummary,
      selected,
    });
    const contextPayloadRef = this.dependencies.ids.next("payload");
    const protectedContext = await this.dependencies.protector.protect({
      ownerId: request.ownerId,
      agentId: request.agentId,
      ref: contextPayloadRef,
      dataClassification: request.dataClassification,
      contentType: "application/json",
      plaintext: new TextEncoder().encode(JSON.stringify(envelope)),
      createdAt: this.dependencies.clock.now(),
    });
    const contextReceipt = await this.dependencies.artifacts.commit({
      runId: request.runId,
      purpose: "context",
      operationKey: contextArtifactOperationKey(request.runId),
      payload: protectedContext,
    });
    const finalTrace = await this.dependencies.trace.record({
      ...this.traceScope(request),
      parentEventId: selectionTrace.event.id,
      causationId: selectionTrace.event.id,
      eventType: "context.formed",
      payload: {
        threadSummary: allowedSummary
          ? {
              id: allowedSummary.id,
              contentRef: allowedSummary.contentRef,
              sourceStartSequence: allowedSummary.sourceStartSequence,
              sourceEndSequence: allowedSummary.sourceEndSequence,
              sourceWatermark: allowedSummary.sourceWatermark,
              policyVersion: allowedSummary.policyVersion,
              modelDescriptorRef: allowedSummary.modelDescriptorRef,
            }
          : null,
        threadHistory: {
          candidates: historyCandidates.map(({ id, payloadRef, sourceRef, relevanceScore }) => ({
            id,
            payloadRef,
            sourceRef: sourceRef ?? id,
            relevanceScore: relevanceScore ?? 0,
          })),
          selected: selectedHistory.map(({ id, payloadRef, sourceRef }) => ({
            id,
            payloadRef,
            sourceRef: sourceRef ?? id,
          })),
          excluded: historyCandidates
            .filter((candidate) => !selectedHistory.some(({ id }) => id === candidate.id))
            .map(({ id, sourceRef, dataClassification = request.dataClassification }) => ({
              id,
              sourceRef: sourceRef ?? id,
              reasonCode:
                CLASSIFICATION_RANK[dataClassification] >
                CLASSIFICATION_RANK[request.maxMemoryClassification]
                  ? "classification_exceeds_context"
                  : "history_selection_limit_reached",
            })),
        },
        trigger: request.trigger,
        policies: request.policies,
        answerLocalePolicy: request.answerLocalePolicy ?? null,
        selectedMemories: selected.map(({ id, contentRef, sourceRef }) => ({
          id,
          contentRef,
          sourceRef,
        })),
        capabilities: request.capabilities,
        injectedContentRefs,
        contextEnvelopeRef: contextReceipt.ref,
        schemaVersion: envelope.schemaVersion,
        policyVersion: envelope.policyVersion,
        sourceWatermark: envelope.sourceWatermark,
      },
    });

    return Object.freeze({
      triggerSourceType: request.trigger.sourceType,
      candidates: Object.freeze(candidates),
      selected: Object.freeze(selected),
      injectedContentRefs,
      contextEnvelopeRef: contextReceipt.ref,
      envelope,
      traceEventIds: Object.freeze([
        query.event.id,
        candidateTrace.event.id,
        selectionTrace.event.id,
        finalTrace.event.id,
      ]),
      answerLocale: request.answerLocalePolicy?.locale ?? null,
    });
  }

  private async readSnapshot(
    request: ContextFormationRequest,
  ): Promise<ThreadContextSnapshot | undefined> {
    if (!request.threadId || !this.dependencies.threads) return undefined;
    const snapshot = await this.dependencies.threads.readContextSnapshot({
      ownerId: request.ownerId,
      agentId: request.agentId,
      threadId: request.threadId,
      runId: request.runId,
      afterSequence: 0,
      limit: 1000,
    });
    if (!snapshot) throw new Error("CONTEXT_THREAD_SNAPSHOT_UNAVAILABLE");
    return snapshot;
  }

  private async readExistingEnvelope(request: ContextFormationRequest): Promise<
    | {
        readonly ref: PayloadRef;
        readonly envelope: ProductContextEnvelopeV1;
      }
    | undefined
  > {
    const artifact = await this.dependencies.artifacts.lookup({
      runId: request.runId,
      purpose: "context",
      operationKey: contextArtifactOperationKey(request.runId),
    });
    if (!artifact) return undefined;
    if (
      artifact.ownerId !== request.ownerId ||
      artifact.agentId !== request.agentId ||
      artifact.contentType !== "application/json"
    ) {
      throw new Error("CONTEXT_ARTIFACT_SCOPE_CONFLICT");
    }
    const payload = await this.dependencies.payloads.get(artifact.payloadRef);
    if (
      !payload ||
      payload.ref !== artifact.payloadRef ||
      payload.contentDigest !== artifact.contentDigest ||
      payload.contentType !== artifact.contentType ||
      payload.dataClassification !== artifact.dataClassification
    ) {
      throw new Error("CONTEXT_ARTIFACT_PAYLOAD_UNAVAILABLE");
    }
    const plaintext = await this.dependencies.protector.unprotect({
      ownerId: request.ownerId,
      agentId: request.agentId,
      payload,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
    } catch {
      throw new Error("CONTEXT_ARTIFACT_INVALID_JSON");
    }
    if (!isProductContextEnvelopeV1(parsed)) {
      throw new Error("CONTEXT_ARTIFACT_INVALID_ENVELOPE");
    }
    if (
      parsed.ownerId !== request.ownerId ||
      parsed.agentId !== request.agentId ||
      parsed.sessionId !== request.sessionId ||
      parsed.threadId !== request.threadId ||
      parsed.runId !== request.runId ||
      parsed.prompt.id !== request.trigger.id ||
      parsed.prompt.sourceType !== request.trigger.sourceType ||
      parsed.prompt.payloadRef !== request.trigger.payloadRef ||
      parsed.prompt.occurredAt !== request.trigger.occurredAt ||
      parsed.policyVersion !== request.policyVersion
    ) {
      throw new Error("CONTEXT_ARTIFACT_REQUEST_CONFLICT");
    }
    if (request.sourceWatermark !== null && parsed.sourceWatermark !== request.sourceWatermark) {
      throw new Error("CONTEXT_SOURCE_WATERMARK_CONFLICT");
    }
    return { ref: artifact.payloadRef, envelope: parsed };
  }

  private replayedContext(
    request: ContextFormationRequest,
    existing: { readonly ref: PayloadRef; readonly envelope: ProductContextEnvelopeV1 },
  ): FormedContext {
    const refs = new Set<PayloadRef>();
    const add = (ref: PayloadRef) => {
      refs.add(ref);
    };
    for (const block of existing.envelope.contextBlocks) add(block.payloadRef);
    for (const message of existing.envelope.history) add(message.contentRef);
    add(existing.envelope.prompt.payloadRef);
    for (const policy of existing.envelope.systemPolicyRefs) add(policy.payloadRef);
    return Object.freeze({
      triggerSourceType: request.trigger.sourceType,
      candidates: Object.freeze([]),
      selected: Object.freeze([]),
      injectedContentRefs: Object.freeze([...refs]),
      contextEnvelopeRef: existing.ref,
      envelope: existing.envelope,
      traceEventIds: Object.freeze([]),
      answerLocale: request.answerLocalePolicy?.locale ?? null,
    });
  }

  private createEnvelope(input: {
    readonly request: ContextFormationRequest;
    readonly sourceWatermark: number | null;
    readonly selectedHistory: readonly ContextThreadMessage[];
    readonly allowedSummary: ThreadSummaryRecord | undefined;
    readonly selected: readonly SelectedMemory[];
  }): ProductContextEnvelopeV1 {
    const { request, selectedHistory, allowedSummary, selected } = input;
    const history = selectedHistory.map((message) => ({
      messageId: messageId(message.id),
      role: productRole(message.role),
      contentRef: message.payloadRef,
      occurredAt: message.occurredAt,
      dataClassification: message.dataClassification ?? request.dataClassification,
    }));
    const systemPolicyRefs = [
      ...request.policies.map(({ ref, payloadRef }) => ({
        ref,
        payloadRef,
        kind: "policy" as const,
      })),
      ...(request.answerLocalePolicy
        ? [
            {
              ref: request.answerLocalePolicy.ref,
              payloadRef: request.answerLocalePolicy.payloadRef,
              kind: "answer-locale" as const,
            },
          ]
        : []),
    ];
    const contextBlocks: ProductContextBlock[] = [
      ...(allowedSummary
        ? [
            {
              kind: "thread-summary" as const,
              ref: allowedSummary.id,
              payloadRef: allowedSummary.contentRef,
              sourceRef: allowedSummary.id,
              dataClassification: allowedSummary.dataClassification,
            },
          ]
        : []),
      ...selected.map(({ id, contentRef, sourceRef, dataClassification }) => ({
        kind: "memory" as const,
        ref: id,
        payloadRef: contentRef,
        sourceRef,
        dataClassification,
      })),
      ...request.capabilities.map(({ ref, summaryRef }) => ({
        kind: "capability-summary" as const,
        ref,
        payloadRef: summaryRef,
        dataClassification: request.dataClassification,
      })),
    ];
    return Object.freeze({
      schemaVersion: "context.v1",
      ownerId: request.ownerId,
      agentId: request.agentId,
      sessionId: request.sessionId,
      threadId: request.threadId,
      runId: request.runId,
      formedAt: this.dependencies.clock.now(),
      sourceWatermark: input.sourceWatermark,
      policyVersion: request.policyVersion,
      history: Object.freeze(history),
      prompt: Object.freeze({
        id: request.trigger.id,
        sourceType: request.trigger.sourceType,
        payloadRef: request.trigger.payloadRef,
        occurredAt: request.trigger.occurredAt,
      }),
      systemPolicyRefs: Object.freeze(systemPolicyRefs),
      contextBlocks: Object.freeze(contextBlocks),
    });
  }

  private traceScope(request: ContextFormationRequest) {
    return {
      ownerId: request.ownerId,
      agentId: request.agentId,
      sessionId: request.sessionId,
      threadId: request.threadId,
      runId: request.runId,
      turnId: null,
      correlationId: request.correlationId,
      actorId: request.actorId,
      dataClassification: request.dataClassification,
    };
  }
}

function contextMessageFromProductMessage(message: ProductThreadMessage): ContextThreadMessage {
  return Object.freeze({
    id: message.id,
    role: message.role === "owner" ? "user" : message.role === "agent" ? "assistant" : "system",
    payloadRef: message.contentRef,
    occurredAt: message.committedAt,
    sourceRef: message.id,
    sequence: message.sequence,
    dataClassification: message.dataClassification,
  });
}

function messageId(value: string): MessageId {
  return createMessageId(value);
}

function productRole(role: ContextThreadMessage["role"]): ProductContextMessageRole {
  if (role === "user") return "owner";
  if (role === "assistant") return "agent";
  if (role === "system") return "system";
  throw new Error("CONTEXT_UNSUPPORTED_MESSAGE_ROLE");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isDataClassification(value: unknown): value is DataClassification {
  return (
    value === "public" || value === "private" || value === "sensitive" || value === "restricted"
  );
}

function isProductContextEnvelopeV1(value: unknown): value is ProductContextEnvelopeV1 {
  if (!isRecord(value)) return false;
  if (
    value["schemaVersion"] !== "context.v1" ||
    !isNonEmptyText(value["ownerId"]) ||
    !isNonEmptyText(value["agentId"]) ||
    !isNonEmptyText(value["sessionId"]) ||
    !(value["threadId"] === null || isNonEmptyText(value["threadId"])) ||
    !isNonEmptyText(value["runId"]) ||
    !isNonEmptyText(value["formedAt"]) ||
    !(
      value["sourceWatermark"] === null ||
      (typeof value["sourceWatermark"] === "number" &&
        Number.isSafeInteger(value["sourceWatermark"]) &&
        value["sourceWatermark"] >= 0)
    ) ||
    !isNonEmptyText(value["policyVersion"]) ||
    !Array.isArray(value["history"]) ||
    !isRecord(value["prompt"]) ||
    !Array.isArray(value["systemPolicyRefs"]) ||
    !Array.isArray(value["contextBlocks"])
  ) {
    return false;
  }
  const prompt = value["prompt"];
  if (
    !isNonEmptyText(prompt["id"]) ||
    !(
      prompt["sourceType"] === "user_message" ||
      prompt["sourceType"] === "schedule" ||
      prompt["sourceType"] === "external_event"
    ) ||
    !isNonEmptyText(prompt["payloadRef"]) ||
    !isNonEmptyText(prompt["occurredAt"])
  ) {
    return false;
  }
  return (
    value["history"].every((item: unknown) => {
      if (!isRecord(item)) return false;
      return (
        isNonEmptyText(item["messageId"]) &&
        (item["role"] === "owner" || item["role"] === "agent" || item["role"] === "system") &&
        isNonEmptyText(item["contentRef"]) &&
        isNonEmptyText(item["occurredAt"]) &&
        isDataClassification(item["dataClassification"])
      );
    }) &&
    value["systemPolicyRefs"].every((item: unknown) => {
      if (!isRecord(item)) return false;
      return (
        isNonEmptyText(item["ref"]) &&
        isNonEmptyText(item["payloadRef"]) &&
        (item["kind"] === "policy" || item["kind"] === "answer-locale")
      );
    }) &&
    value["contextBlocks"].every((item: unknown) => {
      if (!isRecord(item)) return false;
      return (
        (item["kind"] === "thread-summary" ||
          item["kind"] === "memory" ||
          item["kind"] === "capability-summary") &&
        isNonEmptyText(item["ref"]) &&
        isNonEmptyText(item["payloadRef"]) &&
        (item["sourceRef"] === undefined || isNonEmptyText(item["sourceRef"])) &&
        isDataClassification(item["dataClassification"])
      );
    })
  );
}
