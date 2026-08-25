import type {
  AuditLedgerPort,
  AuditRecord,
  DeletionTarget,
  PayloadRecord,
  PayloadProtectionRequest,
  PayloadProtectorPort,
  PayloadStorePort,
  SessionDeletionRecord,
  SessionDeletionStatePort,
  SessionDeletionTargetPort,
  TraceEvent,
  TraceStorePort,
} from "@himawari-agent/application";
import { PORT_ERROR_CODES, ApplicationPortError } from "@himawari-agent/application";
import type { AgentId, RunId, SessionId } from "@himawari-agent/domain";
import { type FailureScheduler, NO_FAILURES } from "../deterministic.js";
import { frozenCopy } from "./helpers.js";

export class InMemoryTraceStore implements TraceStorePort {
  private readonly records = new Map<string, TraceEvent>();
  private readonly failures: FailureScheduler;

  constructor(failures: FailureScheduler = NO_FAILURES) {
    this.failures = failures;
  }

  async append(event: TraceEvent): Promise<void> {
    this.failures.checkpoint("trace.append");
    if (this.records.has(event.id)) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.DUPLICATE,
        `Trace event ${event.id} already exists`,
        { eventId: event.id },
      );
    }
    const runEvents = [...this.records.values()]
      .filter(({ runId }) => runId === event.runId)
      .sort((left, right) => left.sequence - right.sequence);
    const expectedSequence = runEvents.length + 1;
    if (event.sequence !== expectedSequence) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        `Trace event ${event.id} expected Run-local sequence ${expectedSequence}`,
        {
          eventId: event.id,
          expectedSequence: String(expectedSequence),
          sequence: String(event.sequence),
        },
      );
    }
    const first = runEvents[0];
    if (
      first &&
      (first.ownerId !== event.ownerId ||
        first.agentId !== event.agentId ||
        first.sessionId !== event.sessionId ||
        first.threadId !== event.threadId ||
        first.correlationId !== event.correlationId)
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        `Trace event ${event.id} does not match the existing Run scope`,
        { eventId: event.id, runId: event.runId },
      );
    }
    if (event.parentEventId !== null) {
      const parent = this.records.get(event.parentEventId);
      if (!parent || parent.runId !== event.runId) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          `Trace parent ${event.parentEventId} is not in Run ${event.runId}`,
          { eventId: event.id, parentEventId: event.parentEventId, runId: event.runId },
        );
      }
    }
    if (event.causationId !== null) {
      const cause = this.records.get(event.causationId);
      if (cause && (cause.runId !== event.runId || cause.correlationId !== event.correlationId)) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          `Trace cause ${event.causationId} is outside the correlated Run`,
          { causationId: event.causationId, eventId: event.id },
        );
      }
    }
    this.records.set(event.id, frozenCopy(event));
  }

  async readRun(
    runId: RunId,
    afterSequence: number,
    limit: number,
  ): Promise<readonly TraceEvent[]> {
    return [...this.records.values()]
      .filter((event) => event.runId === runId && event.sequence > afterSequence)
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, limit)
      .map(frozenCopy);
  }

  async readSession(
    sessionId: SessionId,
    afterRecordedAt: string | null,
    limit: number,
  ): Promise<readonly TraceEvent[]> {
    return [...this.records.values()]
      .filter(
        (event) =>
          event.sessionId === sessionId &&
          (afterRecordedAt === null || event.recordedAt > afterRecordedAt),
      )
      .sort(
        (left, right) =>
          left.recordedAt.localeCompare(right.recordedAt) || left.id.localeCompare(right.id),
      )
      .slice(0, limit)
      .map(frozenCopy);
  }
}

export class InMemoryPayloadStore implements PayloadStorePort {
  private readonly records = new Map<string, PayloadRecord>();
  private readonly failures: FailureScheduler;

  constructor(failures: FailureScheduler = NO_FAILURES) {
    this.failures = failures;
  }

  async put(payload: PayloadRecord): Promise<void> {
    this.failures.checkpoint("payload.put");
    if (this.records.has(payload.ref)) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.DUPLICATE,
        `Payload ${payload.ref} already exists`,
        { payloadRef: payload.ref },
      );
    }
    this.records.set(
      payload.ref,
      frozenCopy({ ...payload, ciphertext: new Uint8Array(payload.ciphertext) }),
    );
  }

  async get(ref: string): Promise<PayloadRecord | undefined> {
    const record = this.records.get(ref);
    return record
      ? frozenCopy({ ...record, ciphertext: new Uint8Array(record.ciphertext) })
      : undefined;
  }

  async delete(ref: string): Promise<boolean> {
    this.failures.checkpoint("payload.delete");
    return this.records.delete(ref);
  }
}

function checksum(bytes: Uint8Array): string {
  let hash = 2_166_136_261;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16_777_619);
  }
  return `test-fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export class DeterministicPayloadProtector implements PayloadProtectorPort {
  private static readonly MASK = 0xa5;

  async protect(request: PayloadProtectionRequest): Promise<PayloadRecord> {
    const ciphertext = request.plaintext.map((byte) => byte ^ DeterministicPayloadProtector.MASK);
    return frozenCopy({
      ref: request.ref,
      dataClassification: request.dataClassification,
      contentType: request.contentType,
      ciphertext,
      encryption: { algorithm: "test-xor-v1", keyRef: "test-payload-key" },
      contentDigest: checksum(request.plaintext),
      createdAt: request.createdAt,
    });
  }

  async revealForTest(record: PayloadRecord): Promise<unknown> {
    if (record.encryption.algorithm !== "test-xor-v1") {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        `Unsupported test payload algorithm ${record.encryption.algorithm}`,
      );
    }
    const plaintext = record.ciphertext.map((byte) => byte ^ DeterministicPayloadProtector.MASK);
    return JSON.parse(new TextDecoder().decode(plaintext));
  }
}

export class InMemoryAuditLedger implements AuditLedgerPort {
  private readonly records: AuditRecord[] = [];
  private readonly failures: FailureScheduler;

  constructor(failures: FailureScheduler = NO_FAILURES) {
    this.failures = failures;
  }

  async append(record: AuditRecord): Promise<void> {
    this.failures.checkpoint("audit.append");
    if (this.records.some(({ id }) => id === record.id)) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.DUPLICATE,
        `Audit record ${record.id} already exists`,
        { auditId: record.id },
      );
    }
    this.records.push(frozenCopy(record));
  }

  async listByAgent(agentId: AgentId, afterId: string | null): Promise<readonly AuditRecord[]> {
    const scoped = this.records.filter((record) => record.agentId === agentId);
    const start = afterId === null ? 0 : scoped.findIndex(({ id }) => id === afterId) + 1;
    return scoped.slice(start).map(frozenCopy);
  }
}

export class InMemorySessionDeletionState implements SessionDeletionStatePort {
  private readonly records = new Map<string, SessionDeletionRecord>();
  private readonly failures: FailureScheduler;

  constructor(failures: FailureScheduler = NO_FAILURES) {
    this.failures = failures;
  }

  async create(record: SessionDeletionRecord): Promise<SessionDeletionRecord> {
    this.failures.checkpoint("deletion.state.create");
    if (this.records.has(record.id)) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.DUPLICATE,
        `Session deletion ${record.id} already exists`,
        { deletionId: record.id },
      );
    }
    this.records.set(record.id, frozenCopy(record));
    return frozenCopy(record);
  }

  async get(deletionId: string): Promise<SessionDeletionRecord | undefined> {
    const record = this.records.get(deletionId);
    return record ? frozenCopy(record) : undefined;
  }

  async save(
    record: SessionDeletionRecord,
    expectedRevision: number,
  ): Promise<SessionDeletionRecord> {
    this.failures.checkpoint("deletion.state.save");
    const current = this.records.get(record.id);
    if (!current) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        `Session deletion ${record.id} not found`,
        { deletionId: record.id },
      );
    }
    if (current.revision !== expectedRevision || record.revision !== expectedRevision + 1) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        `Session deletion ${record.id} has a stale revision`,
        {
          actualRevision: String(current.revision),
          expectedRevision: String(expectedRevision),
        },
      );
    }
    this.records.set(record.id, frozenCopy(record));
    return frozenCopy(record);
  }
}

export class InMemoryDeletionTarget implements SessionDeletionTargetPort {
  readonly target: DeletionTarget;
  private readonly sessions = new Set<SessionId>();
  private readonly failures: FailureScheduler;

  constructor(target: string, failures: FailureScheduler = NO_FAILURES) {
    if (!(["payload", "search", "cache", "archive"] as const).includes(target as DeletionTarget)) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        `Unknown deletion target ${target}`,
      );
    }
    this.target = target as DeletionTarget;
    this.failures = failures;
  }

  seed(sessionId: SessionId): void {
    this.sessions.add(sessionId);
  }

  async deleteSession(sessionId: SessionId): Promise<void> {
    this.failures.checkpoint(`deletion.${this.target}.delete`);
    this.sessions.delete(sessionId);
  }

  async verifySessionDeleted(sessionId: SessionId): Promise<boolean> {
    this.failures.checkpoint(`deletion.${this.target}.verify`);
    return !this.sessions.has(sessionId);
  }
}
