import {
  UnifiedTriggerIngestionService,
  type TriggerAdmissionPort,
} from "@himawari-agent/application";
import { createAgentId, createOwnerId, createThreadId } from "@himawari-agent/domain";
import type { AdmitTriggerCommand } from "@himawari-agent/gateway-contracts";
import { describe, expect, it } from "vitest";

class RecordingAdmissionPort implements TriggerAdmissionPort {
  readonly commands: AdmitTriggerCommand[] = [];

  async admit(command: AdmitTriggerCommand) {
    this.commands.push(command);
    return { resultRef: `run:${command.payload.triggerId}`, replayed: false };
  }
}

describe("Task 14 unified Trigger contract", () => {
  it.each([
    ["user_message", "owner"],
    ["schedule", "scheduler"],
    ["external_event", "external_adapter"],
  ] as const)(
    "normalizes %s through the same trigger.admit envelope",
    async (sourceType, actorType) => {
      const admission = new RecordingAdmissionPort();
      const service = new UnifiedTriggerIngestionService(admission);
      const result = await service.ingest({
        messageId: `message-${sourceType}`,
        correlationId: `correlation-${sourceType}`,
        causationId: null,
        idempotencyKey: `command-${sourceType}`,
        ownerId: createOwnerId("owner-trigger-contract"),
        agentId: createAgentId("agent-trigger-contract"),
        actorType,
        actorId: `actor-${sourceType}`,
        dataClassification: "private",
        triggerId: `trigger-${sourceType}`,
        sourceType,
        sourceId: `source-${sourceType}`,
        occurredAt: "2026-08-25T00:00:00.000Z",
        threadId: createThreadId("thread-trigger-contract"),
        payloadRef: `payload-${sourceType}`,
        sourceProofRef: `proof-${sourceType}`,
      });

      expect(result).toEqual({ resultRef: `run:trigger-${sourceType}`, replayed: false });
      expect(Object.keys(admission.commands[0] ?? {}).sort()).toEqual([
        "actor",
        "causationId",
        "correlationId",
        "dataClassification",
        "idempotencyKey",
        "kind",
        "messageId",
        "payload",
        "schemaVersion",
        "scope",
        "type",
      ]);
      expect(admission.commands[0]).toMatchObject({
        schemaVersion: "gateway.v1",
        kind: "command",
        type: "trigger.admit",
        actor: { actorType },
        payload: { sourceType },
      });
    },
  );
});
