import type { AgentId, OwnerId, RunId, SessionId, ThreadId, TurnId } from "@himawari-agent/domain";
import type {
  CausationId,
  CorrelationId,
  DataClassification,
  PayloadRef,
  TraceEventId,
} from "../ports/common.js";
import { ApplicationPortError, PORT_ERROR_CODES } from "../ports/common.js";
import type {
  AuditLedgerPort,
  AuditRecord,
  PayloadProtectorPort,
  TraceEvent,
  TraceStorePort,
} from "../ports/observability.js";
import type { RunPayloadArtifactPort } from "../ports/run-payload-artifacts.js";
import type { ClockPort, IdGeneratorPort } from "../ports/system.js";
import { redactTracePayload } from "./trace-redaction.js";

export interface SessionTraceRecorderDependencies {
  readonly trace: TraceStorePort;
  readonly artifacts: RunPayloadArtifactPort;
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
    const lastSequence = await this.lastSequence(input.runId);
    const now = this.dependencies.clock.now();
    let eventId: TraceEventId | null = null;
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
          const ref = this.dependencies.ids.next("payload");
          const protectedPayload = await this.dependencies.protector.protect({
            ownerId: input.ownerId,
            agentId: input.agentId,
            ref,
            dataClassification: input.dataClassification,
            contentType: "application/json",
            plaintext: new TextEncoder().encode(JSON.stringify(redacted)),
            createdAt: now,
          });
          eventId = this.dependencies.ids.next("trace");
          const receipt = await this.dependencies.artifacts.commit({
            runId: input.runId,
            purpose: "trace",
            operationKey: eventId,
            payload: protectedPayload,
          });
          payloadRef = receipt.ref;
        } catch {
          eventType = "trace.payload_write_failed";
          audit = { action: "trace.payload_write_failed", outcome: "failed" };
        }
      }
    }

    eventId ??= this.dependencies.ids.next("trace");

    const event: TraceEvent = Object.freeze({
      id: eventId,
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
      sequence: lastSequence + 1,
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

  private async lastSequence(runId: RunId): Promise<number> {
    const pageSize = 1000;
    let afterSequence = 0;
    while (true) {
      const page = await this.dependencies.trace.readRun(runId, afterSequence, pageSize);
      for (const event of page) {
        if (!Number.isSafeInteger(event.sequence) || event.sequence <= afterSequence) {
          throw new ApplicationPortError(
            PORT_ERROR_CODES.INVALID_OPERATION,
            "Trace page does not advance its sequence",
          );
        }
        afterSequence = event.sequence;
      }
      if (afterSequence === Number.MAX_SAFE_INTEGER) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          "Trace sequence is exhausted",
        );
      }
      if (page.length < pageSize) return afterSequence;
    }
  }
}
