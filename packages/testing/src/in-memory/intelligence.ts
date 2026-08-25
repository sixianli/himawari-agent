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
    return [...this.records.values()]
      .filter((record) => record.ownerId === request.ownerId && record.agentId === request.agentId)
      .slice(0, request.limit)
      .map((record, index) => frozenCopy({ ...record, score: 1 / (index + 1) }));
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

  constructor(
    descriptors: readonly ModelDescriptor[] = [],
    events: readonly ModelInvocationEvent[] = [],
  ) {
    this.descriptors = frozenCopy([...descriptors]);
    this.events = frozenCopy([...events]);
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
    for (const event of this.events) yield frozenCopy(event);
  }
}

export class ScriptedAgentRuntime implements AgentRuntimePort {
  private readonly events: readonly RuntimeEvent[];
  private readonly cancelled = new Set<RunId>();
  private readonly now: () => string;

  constructor(now: () => string, events: readonly RuntimeEvent[] = []) {
    this.events = frozenCopy([...events]);
    this.now = now;
  }

  async *run(request: RuntimeRequest): AsyncIterable<RuntimeEvent> {
    if (this.cancelled.has(request.runId)) {
      yield frozenCopy({
        type: "runtime.failed" as const,
        runId: request.runId,
        errorCode: "RUNTIME_CANCELLED",
        occurredAt: this.now(),
      });
      return;
    }
    for (const event of this.events) yield frozenCopy(event);
  }

  async cancel(runId: RunId): Promise<void> {
    this.cancelled.add(runId);
  }
}
