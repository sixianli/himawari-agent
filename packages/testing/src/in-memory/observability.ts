import type {
  AuditLedgerPort,
  AuditRecord,
  PayloadRecord,
  PayloadStorePort,
  TraceEvent,
  TraceStorePort,
} from "@himawari-agent/application";
import { PORT_ERROR_CODES, ApplicationPortError } from "@himawari-agent/application";
import type { AgentId, RunId } from "@himawari-agent/domain";
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
    this.records.set(payload.ref, frozenCopy({ ...payload, bytes: new Uint8Array(payload.bytes) }));
  }

  async get(ref: string): Promise<PayloadRecord | undefined> {
    const record = this.records.get(ref);
    return record ? frozenCopy({ ...record, bytes: new Uint8Array(record.bytes) }) : undefined;
  }

  async delete(ref: string): Promise<boolean> {
    this.failures.checkpoint("payload.delete");
    return this.records.delete(ref);
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
