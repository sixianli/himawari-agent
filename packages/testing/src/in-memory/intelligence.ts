import type {
  AgentRuntimePort,
  MemoryCandidate,
  MemoryCorrection,
  MemoryPort,
  MemoryRecord,
  MemorySearchRequest,
  MemoryWriteProposal,
  ModelDescriptor,
  ModelInvocationEvent,
  ModelInvocationRequest,
  ModelPort,
  RuntimeEvent,
  RuntimeRequest,
  RuntimeToolDescriptor,
  RuntimeToolExecutionResult,
  RuntimeToolInvocation,
  RuntimeToolPort,
  RuntimeToolPreflightDecision,
} from "@himawari-agent/application";
import { PORT_ERROR_CODES, ApplicationPortError } from "@himawari-agent/application";
import type { AgentId, RunId } from "@himawari-agent/domain";
import type { FailureScheduler } from "../deterministic.js";
import { NO_FAILURES } from "../deterministic.js";
import { frozenCopy, valuesEqual } from "./helpers.js";

export class InMemoryMemoryPort implements MemoryPort {
  private readonly proposals = new Map<string, MemoryWriteProposal>();
  private readonly records = new Map<string, MemoryRecord>();
  private readonly failures: FailureScheduler;

  constructor(failures: FailureScheduler = NO_FAILURES) {
    this.failures = failures;
  }

  async search(request: MemorySearchRequest): Promise<readonly MemoryCandidate[]> {
    const queryTerms = new Set(request.queryTerms.map((term) => term.trim().toLowerCase()));
    return [...this.records.values()]
      .filter((record) => record.ownerId === request.ownerId && record.agentId === request.agentId)
      .map((record) => {
        const matches = record.searchTerms.filter((term) =>
          queryTerms.has(term.trim().toLowerCase()),
        ).length;
        return { record, matches };
      })
      .filter(({ matches }) => matches > 0)
      .sort(
        (left, right) =>
          right.matches - left.matches || left.record.id.localeCompare(right.record.id),
      )
      .slice(0, request.limit)
      .map(({ record, matches }) =>
        frozenCopy({
          ...record,
          score: matches / Math.max(1, queryTerms.size),
        }),
      );
  }

  async proposeWrite(proposal: MemoryWriteProposal): Promise<void> {
    this.failures.checkpoint("memory.proposeWrite");
    const existing = this.proposals.get(proposal.id);
    if (existing && !valuesEqual(existing, proposal)) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        `Memory proposal ${proposal.id} already exists with different content`,
        { proposalId: proposal.id },
      );
    }
    this.proposals.set(proposal.id, frozenCopy(proposal));
  }

  async listWriteProposals(agentId: AgentId): Promise<readonly MemoryWriteProposal[]> {
    return [...this.proposals.values()]
      .filter((proposal) => proposal.agentId === agentId)
      .map(frozenCopy);
  }

  async commitWrite(
    proposalId: string,
    memoryId: string,
    committedAt: string,
  ): Promise<MemoryRecord> {
    this.failures.checkpoint("memory.commitWrite");
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        `Memory proposal ${proposalId} not found`,
        { proposalId },
      );
    }
    if (this.records.has(memoryId)) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.DUPLICATE,
        `Memory ${memoryId} already exists`,
        { memoryId },
      );
    }
    const record = frozenCopy({
      id: memoryId,
      ownerId: proposal.ownerId,
      agentId: proposal.agentId,
      contentRef: proposal.contentRef,
      sourceRef: proposal.sourceRef,
      searchTerms: proposal.searchTerms,
      dataClassification: proposal.dataClassification,
      updatedAt: committedAt,
    });
    this.records.set(memoryId, record);
    this.proposals.delete(proposalId);
    return frozenCopy(record);
  }

  async correct(correction: MemoryCorrection): Promise<MemoryRecord> {
    this.failures.checkpoint("memory.correct");
    const current = this.records.get(correction.memoryId);
    if (!current) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        `Memory ${correction.memoryId} not found`,
        { memoryId: correction.memoryId },
      );
    }
    const corrected = frozenCopy({
      ...current,
      contentRef: correction.contentRef,
      sourceRef: correction.sourceRef,
      searchTerms: correction.searchTerms,
      updatedAt: correction.correctedAt,
    });
    this.records.set(correction.memoryId, corrected);
    return frozenCopy(corrected);
  }

  async delete(memoryId: string): Promise<boolean> {
    this.failures.checkpoint("memory.delete");
    return this.records.delete(memoryId);
  }
}

export class ScriptedModelPort implements ModelPort {
  private readonly descriptors: readonly ModelDescriptor[];
  private readonly events: readonly ModelInvocationEvent[];
  private readonly eventsByModel: Readonly<Record<string, readonly ModelInvocationEvent[]>>;
  private readonly requests: ModelInvocationRequest[] = [];

  constructor(
    descriptors: readonly ModelDescriptor[] = [],
    events: readonly ModelInvocationEvent[] = [],
    eventsByModel: Readonly<Record<string, readonly ModelInvocationEvent[]>> = {},
  ) {
    this.descriptors = frozenCopy([...descriptors]);
    this.events = frozenCopy([...events]);
    this.eventsByModel = frozenCopy(eventsByModel);
  }

  async listAvailable(): Promise<readonly ModelDescriptor[]> {
    return frozenCopy([...this.descriptors]);
  }

  async *invoke(request: ModelInvocationRequest): AsyncIterable<ModelInvocationEvent> {
    if (!this.descriptors.some(({ ref }) => ref === request.modelRef)) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        `Model ${request.modelRef} not found`,
        { modelRef: request.modelRef },
      );
    }
    this.requests.push(frozenCopy(request));
    const events = this.eventsByModel[request.modelRef] ?? this.events;
    for (const event of events) {
      yield frozenCopy({ ...event, invocationId: request.invocationId });
    }
  }

  observedRequests(): readonly ModelInvocationRequest[] {
    return this.requests.map(frozenCopy);
  }
}

export class ScriptedAgentRuntime implements AgentRuntimePort {
  private readonly events: readonly RuntimeEvent[];
  private readonly cancelled = new Set<RunId>();
  private readonly now: () => string;
  private readonly requests: RuntimeRequest[] = [];

  constructor(now: () => string, events: readonly RuntimeEvent[] = []) {
    this.events = frozenCopy([...events]);
    this.now = now;
  }

  async *run(request: RuntimeRequest): AsyncIterable<RuntimeEvent> {
    this.requests.push(frozenCopy(request));
    if (this.cancelled.has(request.runId)) {
      yield frozenCopy({
        type: "runtime.cancelled" as const,
        runId: request.runId,
        reasonCode: "RUNTIME_CANCELLED",
        occurredAt: this.now(),
      });
      return;
    }
    for (const event of this.events) yield frozenCopy(event);
  }

  async cancel(runId: RunId): Promise<void> {
    this.cancelled.add(runId);
  }

  observedRequests(): readonly RuntimeRequest[] {
    return this.requests.map(frozenCopy);
  }
}

export class IdempotentRuntimeToolPort implements RuntimeToolPort {
  private readonly descriptors: readonly RuntimeToolDescriptor[];
  private readonly decision: RuntimeToolPreflightDecision;
  private readonly execution: RuntimeToolExecutionResult;
  private readonly executions = new Map<string, RuntimeToolExecutionResult>();
  private executionAttempts = 0;

  constructor(
    input: {
      readonly descriptors?: readonly RuntimeToolDescriptor[];
      readonly decision?: RuntimeToolPreflightDecision;
      readonly execution?: RuntimeToolExecutionResult;
    } = {},
  ) {
    this.descriptors = frozenCopy([...(input.descriptors ?? [])]);
    this.decision = frozenCopy(
      input.decision ?? {
        allowed: true,
        permissionDecisionRef: "permission-runtime-tool-default",
        reasonCode: "authorized",
      },
    );
    this.execution = frozenCopy(
      input.execution ?? {
        outcome: "succeeded",
        resultRef: "payload-runtime-tool-result",
        errorCode: null,
        externalActionId: null,
        modelContent: "Tool completed",
      },
    );
  }

  async listAuthorized(
    _runId: RunId,
    capabilityHandleRefs: readonly string[],
  ): Promise<readonly RuntimeToolDescriptor[]> {
    const handles = new Set(capabilityHandleRefs);
    return this.descriptors
      .filter(({ capabilityHandleRef }) => handles.has(capabilityHandleRef))
      .map(frozenCopy);
  }

  async preflight(invocation: RuntimeToolInvocation): Promise<RuntimeToolPreflightDecision> {
    const descriptor = this.descriptors.find(
      ({ capabilityRef, capabilityHandleRef }) =>
        capabilityRef === invocation.capabilityRef &&
        capabilityHandleRef === invocation.capabilityHandleRef,
    );
    if (!descriptor) {
      return frozenCopy({
        allowed: false,
        permissionDecisionRef: "permission-runtime-tool-missing",
        reasonCode: "not_authorized",
      });
    }
    return frozenCopy(this.decision);
  }

  async execute(invocation: RuntimeToolInvocation): Promise<RuntimeToolExecutionResult> {
    const key = `${invocation.runId}:${invocation.toolCallId}`;
    const existing = this.executions.get(key);
    if (existing) return frozenCopy(existing);
    this.executionAttempts += 1;
    const stored = frozenCopy(this.execution);
    this.executions.set(key, stored);
    return frozenCopy(stored);
  }

  underlyingExecutionCount(): number {
    return this.executionAttempts;
  }
}
