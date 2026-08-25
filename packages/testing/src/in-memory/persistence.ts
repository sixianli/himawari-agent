import type {
  AuthorityLeasePort,
  CommandResultLookup,
  CommandResultRecord,
  CommitStateAndEventsInput,
  CommitStateAndEventsResult,
  CompareAndSetStateInput,
  ProductStateRepositoryPort,
  ReliableEvent,
  ReliableEventDelivery,
  ReliableEventPort,
  ReliableEventRecord,
  ReliableEventSinkPort,
  StateRecord,
  StateStorePort,
} from "@himawari-agent/application";
import { PORT_ERROR_CODES, ApplicationPortError } from "@himawari-agent/application";
import { type FailureScheduler, NO_FAILURES } from "../deterministic.js";
import { frozenCopy, valuesEqual } from "./helpers.js";

export class InMemoryStateStore implements StateStorePort {
  private readonly records = new Map<string, StateRecord>();
  private readonly failures: FailureScheduler;

  constructor(failures: FailureScheduler = NO_FAILURES) {
    this.failures = failures;
  }

  async read(key: string): Promise<StateRecord | undefined> {
    const record = this.records.get(key);
    return record ? frozenCopy(record) : undefined;
  }

  async compareAndSet(input: CompareAndSetStateInput): Promise<StateRecord> {
    this.failures.checkpoint("state.compareAndSet");
    const current = this.records.get(input.key);
    const currentRevision = current?.revision ?? null;
    if (currentRevision !== input.expectedRevision) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        `State revision conflict for ${input.key}`,
        {
          key: input.key,
          expectedRevision: String(input.expectedRevision),
          currentRevision: String(currentRevision),
        },
      );
    }

    const record = frozenCopy({
      key: input.key,
      revision: (current?.revision ?? 0) + 1,
      value: input.value,
    });
    this.records.set(input.key, record);
    return frozenCopy(record);
  }
}

export class InMemoryReliableEventPort implements ReliableEventPort {
  private readonly records = new Map<string, ReliableEventRecord>();
  private readonly failures: FailureScheduler;

  constructor(failures: FailureScheduler = NO_FAILURES) {
    this.failures = failures;
  }

  async append(event: ReliableEvent): Promise<ReliableEventRecord> {
    this.failures.checkpoint("reliableEvents.append");
    const existing = this.records.get(event.id);
    if (existing) {
      if (valuesEqual({ ...existing, publishedAt: null }, { ...event, publishedAt: null })) {
        return frozenCopy(existing);
      }
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        `Reliable event ${event.id} already exists with different content`,
        { eventId: event.id },
      );
    }

    const record = frozenCopy({ ...event, publishedAt: null });
    this.records.set(event.id, record);
    return frozenCopy(record);
  }

  async listPending(limit: number): Promise<readonly ReliableEventRecord[]> {
    return [...this.records.values()]
      .filter(({ publishedAt }) => publishedAt === null)
      .slice(0, limit)
      .map(frozenCopy);
  }

  async markPublished(eventId: string, publishedAt: string): Promise<ReliableEventRecord> {
    const current = this.records.get(eventId);
    if (!current) {
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, `Event ${eventId} not found`, {
        eventId,
      });
    }
    if (current.publishedAt !== null) return frozenCopy(current);
    this.failures.checkpoint("reliableEvents.markPublished");
    const record = frozenCopy({ ...current, publishedAt });
    this.records.set(eventId, record);
    return frozenCopy(record);
  }
}

function commandKey(lookup: CommandResultLookup): string {
  return JSON.stringify([lookup.ownerId, lookup.agentId, lookup.idempotencyKey]);
}

export class InMemoryProductStateRepository implements ProductStateRepositoryPort {
  private readonly states = new Map<string, StateRecord>();
  private readonly events = new Map<string, ReliableEventRecord>();
  private readonly commandCommits = new Map<string, CommitStateAndEventsResult>();
  private readonly authority: AuthorityLeasePort;
  private readonly failures: FailureScheduler;

  constructor(authority: AuthorityLeasePort, failures: FailureScheduler = NO_FAILURES) {
    this.authority = authority;
    this.failures = failures;
  }

  async read(key: string): Promise<StateRecord | undefined> {
    const record = this.states.get(key);
    return record ? frozenCopy(record) : undefined;
  }

  async compareAndSet(input: CompareAndSetStateInput): Promise<StateRecord> {
    this.failures.checkpoint("state.compareAndSet");
    const current = this.states.get(input.key);
    this.assertRevision(input, current);
    const record = frozenCopy({
      key: input.key,
      revision: (current?.revision ?? 0) + 1,
      value: input.value,
    });
    this.states.set(input.key, record);
    return frozenCopy(record);
  }

  async append(event: ReliableEvent): Promise<ReliableEventRecord> {
    this.failures.checkpoint("reliableEvents.append");
    const existing = this.events.get(event.id);
    if (existing) {
      if (valuesEqual({ ...existing, publishedAt: null }, { ...event, publishedAt: null })) {
        return frozenCopy(existing);
      }
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        `Reliable event ${event.id} already exists with different content`,
        { eventId: event.id },
      );
    }
    const record = frozenCopy({ ...event, publishedAt: null });
    this.events.set(event.id, record);
    return frozenCopy(record);
  }

  async listPending(limit: number): Promise<readonly ReliableEventRecord[]> {
    return [...this.events.values()]
      .filter(({ publishedAt }) => publishedAt === null)
      .slice(0, limit)
      .map(frozenCopy);
  }

  async markPublished(eventId: string, publishedAt: string): Promise<ReliableEventRecord> {
    const current = this.events.get(eventId);
    if (!current) {
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, `Event ${eventId} not found`, {
        eventId,
      });
    }
    if (current.publishedAt !== null) return frozenCopy(current);
    this.failures.checkpoint("reliableEvents.markPublished");
    const record = frozenCopy({ ...current, publishedAt });
    this.events.set(eventId, record);
    return frozenCopy(record);
  }

  async findCommandResult(lookup: CommandResultLookup): Promise<CommandResultRecord | undefined> {
    const result = this.commandCommits.get(commandKey(lookup))?.commandResult;
    return result ? frozenCopy(result) : undefined;
  }

  async findCommandCommit(
    lookup: CommandResultLookup,
  ): Promise<CommitStateAndEventsResult | undefined> {
    const result = this.commandCommits.get(commandKey(lookup));
    return result ? frozenCopy(result) : undefined;
  }

  async commitStateAndEvents(
    input: CommitStateAndEventsInput,
  ): Promise<CommitStateAndEventsResult> {
    const key = commandKey(input.command);
    const existingCommit = this.replayExistingCommit(key, input);
    if (existingCommit) return existingCommit;

    await this.assertAuthority(input);
    const concurrentCommit = this.replayExistingCommit(key, input);
    if (concurrentCommit) return concurrentCommit;
    const current = this.states.get(input.state.key);
    this.assertRevision(input.state, current);
    this.assertEventsCanAppend(input);
    this.failures.checkpoint("productState.commit.before");

    const state = frozenCopy({
      key: input.state.key,
      revision: (current?.revision ?? 0) + 1,
      value: input.state.value,
    });
    const events = input.events.map((event) =>
      frozenCopy({ ...event, publishedAt: null } satisfies ReliableEventRecord),
    );
    const commandResult = frozenCopy({
      ownerId: input.command.ownerId,
      agentId: input.command.agentId,
      idempotencyKey: input.command.idempotencyKey,
      commandType: input.command.commandType,
      commandFingerprint: input.command.commandFingerprint,
      resultRef: input.resultRef,
      stateKey: state.key,
      stateRevision: state.revision,
      committedAt: input.committedAt,
    } satisfies CommandResultRecord);
    const commit = frozenCopy({
      state,
      events,
      commandResult,
      replayed: false,
    } satisfies CommitStateAndEventsResult);

    this.states.set(state.key, state);
    for (const event of events) this.events.set(event.id, event);
    this.commandCommits.set(key, commit);
    return frozenCopy(commit);
  }

  private assertRevision(input: CompareAndSetStateInput, current: StateRecord | undefined): void {
    const currentRevision = current?.revision ?? null;
    if (currentRevision !== input.expectedRevision) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        `State revision conflict for ${input.key}`,
        {
          key: input.key,
          expectedRevision: String(input.expectedRevision),
          currentRevision: String(currentRevision),
        },
      );
    }
  }

  private replayExistingCommit(
    key: string,
    input: CommitStateAndEventsInput,
  ): CommitStateAndEventsResult | undefined {
    const existingCommit = this.commandCommits.get(key);
    if (!existingCommit) return undefined;
    const existing = existingCommit.commandResult;
    if (
      existing.commandType === input.command.commandType &&
      existing.commandFingerprint === input.command.commandFingerprint
    ) {
      return frozenCopy({ ...existingCommit, replayed: true });
    }
    throw new ApplicationPortError(
      PORT_ERROR_CODES.CONFLICT,
      `Idempotency key ${input.command.idempotencyKey} was already used by another command`,
      { idempotencyKey: input.command.idempotencyKey },
    );
  }

  private async assertAuthority(input: CommitStateAndEventsInput): Promise<void> {
    const current = await this.authority.current(input.command.agentId);
    if (
      !current ||
      current.lease.ownerId !== input.command.ownerId ||
      current.lease.id !== input.command.authority.leaseId ||
      current.fencingToken !== input.command.authority.fencingToken
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        `Command does not hold the current authority fence for Agent ${input.command.agentId}`,
        {
          agentId: input.command.agentId,
          leaseId: input.command.authority.leaseId,
          fencingToken: String(input.command.authority.fencingToken),
        },
      );
    }
  }

  private assertEventsCanAppend(input: CommitStateAndEventsInput): void {
    const inputIds = new Set<string>();
    for (const event of input.events) {
      if (event.idempotencyKey !== input.command.idempotencyKey) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          "Reliable events in a product-state commit must share the command idempotency key",
          { eventId: event.id },
        );
      }
      if (inputIds.has(event.id) || this.events.has(event.id)) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.CONFLICT,
          `Reliable event ${event.id} already exists`,
          { eventId: event.id },
        );
      }
      inputIds.add(event.id);
    }
  }
}

export class InMemoryReliableEventSink implements ReliableEventSinkPort {
  private readonly events = new Map<string, ReliableEventRecord>();
  private readonly attempts = new Map<string, number>();
  private readonly failures: FailureScheduler;

  constructor(failures: FailureScheduler = NO_FAILURES) {
    this.failures = failures;
  }

  async publish(event: ReliableEventRecord): Promise<ReliableEventDelivery> {
    this.failures.checkpoint("reliableEventSink.publish");
    this.attempts.set(event.id, (this.attempts.get(event.id) ?? 0) + 1);
    const existing = this.events.get(event.id);
    if (existing) {
      if (!valuesEqual(existing, event)) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.CONFLICT,
          `Reliable event ${event.id} was redelivered with different content`,
          { eventId: event.id },
        );
      }
      return Object.freeze({ eventId: event.id, outcome: "duplicate" });
    }
    this.events.set(event.id, frozenCopy(event));
    return Object.freeze({ eventId: event.id, outcome: "published" });
  }

  deliveredEvents(): readonly ReliableEventRecord[] {
    return [...this.events.values()].map(frozenCopy);
  }

  attemptsFor(eventId: string): number {
    return this.attempts.get(eventId) ?? 0;
  }
}
