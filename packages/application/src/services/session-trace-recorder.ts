import type { AgentId, OwnerId, RunId, SessionId, ThreadId, TurnId } from "@himawari-agent/domain";
import type {
  AuditLedgerPort,
  AuditRecord,
  PayloadProtectorPort,
  PayloadStorePort,
  TraceEvent,
  TraceStorePort,
} from "../ports/observability.js";
import type { ClockPort, IdGeneratorPort } from "../ports/system.js";
import type {
  CausationId,
  CorrelationId,
  DataClassification,
  PayloadRef,
  TraceEventId,
} from "../ports/common.js";
import { redactTracePayload } from "./trace-redaction.js";

export interface SessionTraceRecorderDependencies {
  readonly trace: TraceStorePort;
  readonly payloads: PayloadStorePort;
  readonly protector: PayloadProtectorPort;
  readonly audit: AuditLedgerPort;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
}

export interface TraceAuditInput {
  readonly action: string;
  readonly outcome: AuditRecord["outcome"];
}

export interface RecordTraceInput {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly threadId: ThreadId | null;
  readonly runId: RunId;
  readonly turnId: TurnId | null;
  readonly parentEventId: TraceEventId | null;
  readonly causationId: CausationId | null;
  readonly correlationId: CorrelationId;
  readonly actorId: string;
  readonly dataClassification: DataClassification;
  readonly eventType: string;
  readonly occurredAt?: string;
  readonly payload?: unknown;
  readonly sensitiveLiterals?: readonly string[];
  readonly audit?: TraceAuditInput;
}

export interface RecordTraceResult {
  readonly event: TraceEvent;
  readonly payloadRef: PayloadRef | null;
}

export class SessionTraceRecorder {
  private readonly dependencies: SessionTraceRecorderDependencies;

  constructor(dependencies: SessionTraceRecorderDependencies) {
    this.dependencies = dependencies;
  }

  async record(input: RecordTraceInput): Promise<RecordTraceResult> {
    let payloadRef: PayloadRef | null = null;
    let eventType = input.eventType;
    let audit = input.audit;

    if (Object.hasOwn(input, "payload")) {
      let redacted: ReturnType<typeof redactTracePayload> | undefined;
      try {
        redacted = redactTracePayload(input.payload, input.sensitiveLiterals);
      } catch {
        eventType = "trace.redaction_failed";
        audit = { action: "trace.redaction_failed", outcome: "failed" };
      }

      if (redacted !== undefined) {
        try {
          const now = this.dependencies.clock.now();
          const ref = this.dependencies.ids.next("payload");
          const protectedPayload = await this.dependencies.protector.protect({
            ref,
            dataClassification: input.dataClassification,
            contentType: "application/json",
            plaintext: new TextEncoder().encode(JSON.stringify(redacted)),
            createdAt: now,
          });
          await this.dependencies.payloads.put(protectedPayload);
          payloadRef = ref;
        } catch {
          eventType = "trace.payload_write_failed";
          audit = { action: "trace.payload_write_failed", outcome: "failed" };
        }
      }
    }

    const previous = await this.dependencies.trace.readRun(input.runId, 0, Number.MAX_SAFE_INTEGER);
    const now = this.dependencies.clock.now();
    const event: TraceEvent = Object.freeze({
      id: this.dependencies.ids.next("trace"),
      schemaVersion: "trace.v1",
      ownerId: input.ownerId,
      agentId: input.agentId,
      sessionId: input.sessionId,
      threadId: input.threadId,
      runId: input.runId,
      turnId: input.turnId,
      parentEventId: input.parentEventId,
      causationId: input.causationId,
      correlationId: input.correlationId,
      sequence: previous.length + 1,
      occurredAt: input.occurredAt ?? now,
      recordedAt: now,
      actorId: input.actorId,
      dataClassification: input.dataClassification,
      eventType,
      payloadRef,
    });
    await this.dependencies.trace.append(event);

    if (audit) {
      await this.dependencies.audit.append({
        id: this.dependencies.ids.next("audit"),
        ownerId: input.ownerId,
        agentId: input.agentId,
        action: audit.action,
        targetRef: input.runId,
        outcome: audit.outcome,
        occurredAt: now,
      });
    }

    return Object.freeze({ event, payloadRef });
  }
}
