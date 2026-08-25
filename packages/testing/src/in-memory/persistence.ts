import type {
  CompareAndSetStateInput,
  ReliableEvent,
  ReliableEventPort,
  ReliableEventRecord,
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
    this.failures.checkpoint("reliableEvents.markPublished");
    const current = this.records.get(eventId);
    if (!current) {
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, `Event ${eventId} not found`, {
        eventId,
      });
    }
    const record = frozenCopy({ ...current, publishedAt });
    this.records.set(eventId, record);
    return frozenCopy(record);
  }
}
