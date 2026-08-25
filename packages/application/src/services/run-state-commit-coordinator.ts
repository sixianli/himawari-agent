import {
  RUN_STATUSES,
  type AgentId,
  type IdempotencyKey,
  type OwnerId,
  type Run,
  type RunId,
  type RunStatus,
  createAgentId,
  createOwnerId,
  createRunId,
  createSessionId,
  createThreadId,
  createTriggerId,
  transitionRun,
} from "@himawari-agent/domain";
import {
  PORT_ERROR_CODES,
  ApplicationPortError,
  type AuthorityFence,
  type ClockPort,
  type CommandResultLookup,
  type CommitStateAndEventsResult,
  type JsonObject,
  type ProductStateRepositoryPort,
  type StateRecord,
} from "../ports/index.js";

interface AgentStateCommandContext {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly idempotencyKey: IdempotencyKey;
  readonly commandFingerprint: string;
  readonly authority: AuthorityFence;
  readonly payloadRef: string;
}

export interface AdmitRunStateInput extends Omit<AgentStateCommandContext, "ownerId" | "agentId"> {
  readonly run: Run;
}

export interface TransitionRunStateInput extends AgentStateCommandContext {
  readonly runId: RunId;
  readonly expectedRevision: number;
  readonly nextStatus: RunStatus;
}

export interface StoredRun {
  readonly run: Run;
  readonly revision: number;
}

function runStateKey(runId: RunId): string {
  return `run:${runId}`;
}

function serializedRun(run: Run): JsonObject {
  return {
    id: run.id,
    ownerId: run.ownerId,
    agentId: run.agentId,
    sessionId: run.sessionId,
    triggerId: run.triggerId,
    ...(run.threadId ? { threadId: run.threadId } : {}),
    status: run.status,
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      `Stored Run field ${field} must be a string`,
      { field },
    );
  }
  return value;
}

function readField(value: JsonObject, field: string): unknown {
  return value[field];
}

function deserializeRun(record: StateRecord): Run {
  const value = record.value;
  const status = requiredString(readField(value, "status"), "status");
  if (!(RUN_STATUSES as readonly string[]).includes(status)) {
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      `Stored Run has unsupported status ${status}`,
      { key: record.key, status },
    );
  }

  const threadId = readField(value, "threadId");
  if (threadId !== undefined && typeof threadId !== "string") {
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      "Stored Run field threadId must be a string when present",
      { key: record.key },
    );
  }

  return Object.freeze({
    id: createRunId(requiredString(readField(value, "id"), "id")),
    ownerId: createOwnerId(requiredString(readField(value, "ownerId"), "ownerId")),
    agentId: createAgentId(requiredString(readField(value, "agentId"), "agentId")),
    sessionId: createSessionId(requiredString(readField(value, "sessionId"), "sessionId")),
    triggerId: createTriggerId(requiredString(readField(value, "triggerId"), "triggerId")),
    ...(threadId ? { threadId: createThreadId(threadId) } : {}),
    status: status as RunStatus,
  });
}

export class RunStateCommitCoordinator {
  private readonly repository: ProductStateRepositoryPort;
  private readonly clock: ClockPort;

  constructor(repository: ProductStateRepositoryPort, clock: ClockPort) {
    this.repository = repository;
    this.clock = clock;
  }

  lookupCommand(lookup: CommandResultLookup) {
    return this.repository.findCommandResult(lookup);
  }

  async readRun(runId: RunId): Promise<StoredRun | undefined> {
    const state = await this.repository.read(runStateKey(runId));
    if (!state) return undefined;
    return Object.freeze({ run: deserializeRun(state), revision: state.revision });
  }

  async admitRun(input: AdmitRunStateInput): Promise<CommitStateAndEventsResult> {
    if (input.run.status !== "accepted") {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "A newly admitted Run must be in accepted state",
        { runId: input.run.id, status: input.run.status },
      );
    }

    return this.commit({
      ownerId: input.run.ownerId,
      agentId: input.run.agentId,
      idempotencyKey: input.idempotencyKey,
      commandType: "run.admit",
      commandFingerprint: input.commandFingerprint,
      authority: input.authority,
      state: {
        key: runStateKey(input.run.id),
        expectedRevision: null,
        value: serializedRun(input.run),
      },
      eventTopic: "run.accepted",
      payloadRef: input.payloadRef,
      resultRef: runStateKey(input.run.id),
    });
  }

  async transitionRun(input: TransitionRunStateInput): Promise<CommitStateAndEventsResult> {
    const replayed = await this.replay(input, "run.transition");
    if (replayed) return replayed;

    const stored = await this.readRun(input.runId);
    if (!stored) {
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, `Run ${input.runId} not found`, {
        runId: input.runId,
      });
    }
    if (stored.run.ownerId !== input.ownerId || stored.run.agentId !== input.agentId) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Run command scope does not match stored Run ownership",
        { runId: input.runId },
      );
    }

    const nextRun = transitionRun(stored.run, input.nextStatus);
    return this.commit({
      ...input,
      commandType: "run.transition",
      state: {
        key: runStateKey(input.runId),
        expectedRevision: input.expectedRevision,
        value: serializedRun(nextRun),
      },
      eventTopic: `run.${input.nextStatus}`,
      resultRef: runStateKey(input.runId),
    });
  }

  private async replay(
    input: Pick<
      AgentStateCommandContext,
      "ownerId" | "agentId" | "idempotencyKey" | "commandFingerprint"
    >,
    commandType: string,
  ): Promise<CommitStateAndEventsResult | undefined> {
    const existingCommit = await this.repository.findCommandCommit(input);
    if (!existingCommit) return undefined;
    const existing = existingCommit.commandResult;
    if (
      existing.commandType !== commandType ||
      existing.commandFingerprint !== input.commandFingerprint
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        `Idempotency key ${input.idempotencyKey} was already used by another command`,
        { idempotencyKey: input.idempotencyKey },
      );
    }
    return Object.freeze({ ...existingCommit, replayed: true });
  }

  private async commit(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly idempotencyKey: IdempotencyKey;
    readonly commandType: string;
    readonly commandFingerprint: string;
    readonly authority: AuthorityFence;
    readonly state: {
      readonly key: string;
      readonly expectedRevision: number | null;
      readonly value: JsonObject;
    };
    readonly eventTopic: string;
    readonly payloadRef: string;
    readonly resultRef: string;
  }): Promise<CommitStateAndEventsResult> {
    const replayed = await this.replay(input, input.commandType);
    if (replayed) return replayed;

    const occurredAt = this.clock.now();
    return this.repository.commitStateAndEvents({
      command: {
        ownerId: input.ownerId,
        agentId: input.agentId,
        idempotencyKey: input.idempotencyKey,
        commandType: input.commandType,
        commandFingerprint: input.commandFingerprint,
        authority: input.authority,
      },
      state: input.state,
      events: [
        {
          id: `event:${input.idempotencyKey}`,
          idempotencyKey: input.idempotencyKey,
          topic: input.eventTopic,
          payloadRef: input.payloadRef,
          occurredAt,
        },
      ],
      resultRef: input.resultRef,
      committedAt: occurredAt,
    });
  }
}
