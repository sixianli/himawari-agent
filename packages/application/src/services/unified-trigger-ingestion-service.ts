import type { AgentId, OwnerId, ThreadId } from "@himawari-agent/domain";
import {
  admitTriggerCommandSchema,
  type AdmitTriggerCommand,
} from "@himawari-agent/gateway-contracts";
import type {
  DataClassification,
  PayloadRef,
  TriggerAdmissionPort,
  TriggerAdmissionResult,
} from "../ports/index.js";

export type UnifiedTriggerSource = "user_message" | "schedule" | "external_event";
export type UnifiedTriggerActorType =
  | "owner"
  | "client"
  | "scheduler"
  | "external_adapter"
  | "system";

export interface UnifiedTriggerInput {
  readonly messageId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly idempotencyKey: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly actorType: UnifiedTriggerActorType;
  readonly actorId: string;
  readonly dataClassification: DataClassification;
  readonly triggerId: string;
  readonly sourceType: UnifiedTriggerSource;
  readonly sourceId: string;
  readonly occurredAt: string;
  readonly threadId: ThreadId | null;
  readonly payloadRef: PayloadRef;
  readonly sourceProofRef: string;
}

export interface UnifiedTriggerPort {
  ingest(input: UnifiedTriggerInput): Promise<TriggerAdmissionResult>;
}

export class UnifiedTriggerIngestionService implements UnifiedTriggerPort {
  private readonly admission: TriggerAdmissionPort;

  constructor(admission: TriggerAdmissionPort) {
    this.admission = admission;
  }

  normalize(input: UnifiedTriggerInput): AdmitTriggerCommand {
    return admitTriggerCommandSchema.parse({
      schemaVersion: "gateway.v1",
      kind: "command",
      type: "trigger.admit",
      messageId: input.messageId,
      correlationId: input.correlationId,
      causationId: input.causationId,
      dataClassification: input.dataClassification,
      scope: { ownerId: input.ownerId, agentId: input.agentId },
      actor: { actorType: input.actorType, actorId: input.actorId },
      idempotencyKey: input.idempotencyKey,
      payload: {
        triggerId: input.triggerId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        occurredAt: input.occurredAt,
        threadId: input.threadId,
        payloadRef: input.payloadRef,
        sourceProofRef: input.sourceProofRef,
      },
    });
  }

  async ingest(input: UnifiedTriggerInput): Promise<TriggerAdmissionResult> {
    return this.admission.admit(this.normalize(input));
  }
}
