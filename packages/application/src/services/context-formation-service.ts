import type { AgentId, OwnerId, RunId, SessionId, ThreadId } from "@himawari-agent/domain";
import type { MemoryCandidate, MemoryPort } from "../ports/intelligence.js";
import type {
  CorrelationId,
  DataClassification,
  PayloadRef,
  TraceEventId,
} from "../ports/common.js";
import type { SessionTraceRecorder } from "./session-trace-recorder.js";

const CLASSIFICATION_RANK = Object.freeze({ public: 0, private: 1, sensitive: 2, restricted: 3 });

export type ContextTriggerSource = "user_message" | "schedule" | "external_event";

export interface ContextThreadMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "system" | "tool";
  readonly payloadRef: PayloadRef;
  readonly occurredAt: string;
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
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly threadId: ThreadId | null;
  readonly runId: RunId;
  readonly trigger: {
    readonly id: string;
    readonly sourceType: ContextTriggerSource;
    readonly payloadRef: PayloadRef;
  };
  readonly threadMessages: readonly ContextThreadMessage[];
  readonly policies: readonly ContextPolicySummary[];
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
  readonly finalContextRef: PayloadRef;
  readonly traceEventIds: readonly TraceEventId[];
}

export interface ContextFormationServiceDependencies {
  readonly memory: Pick<MemoryPort, "search">;
  readonly trace: SessionTraceRecorder;
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
        CLASSIFICATION_RANK[request.maxMemoryClassification],
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
              CLASSIFICATION_RANK[request.maxMemoryClassification]
                ? "classification_exceeds_context"
                : "selection_limit_reached",
          })),
      },
    });

    const injectedContentRefs = Object.freeze([
      ...request.threadMessages.map(({ payloadRef }) => payloadRef),
      request.trigger.payloadRef,
      ...request.policies.map(({ payloadRef }) => payloadRef),
      ...selected.map(({ contentRef }) => contentRef),
      ...request.capabilities.map(({ summaryRef }) => summaryRef),
    ]);
    const finalTrace = await this.dependencies.trace.record({
      ...this.traceScope(request),
      parentEventId: selectionTrace.event.id,
      causationId: selectionTrace.event.id,
      eventType: "context.formed",
      payload: {
        threadMessages: request.threadMessages,
        trigger: request.trigger,
        policies: request.policies,
        selectedMemories: selected.map(({ id, contentRef, sourceRef }) => ({
          id,
          contentRef,
          sourceRef,
        })),
        capabilities: request.capabilities,
        injectedContentRefs,
      },
    });
    if (finalTrace.payloadRef === null) {
      throw new Error("Context formation requires a protected final payload");
    }

    return Object.freeze({
      triggerSourceType: request.trigger.sourceType,
      candidates: Object.freeze(candidates),
      selected: Object.freeze(selected),
      injectedContentRefs,
      finalContextRef: finalTrace.payloadRef,
      traceEventIds: Object.freeze([
        query.event.id,
        candidateTrace.event.id,
        selectionTrace.event.id,
        finalTrace.event.id,
      ]),
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
