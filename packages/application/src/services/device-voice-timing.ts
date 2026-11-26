import type { RunId } from "@himawari-agent/domain";
import { ApplicationPortError, PORT_ERROR_CODES } from "../ports/common.js";

import type {
  PayloadProtectorPort,
  PayloadStorePort,
  TraceStorePort,
} from "../ports/observability.js";
import { DEVICE_VOICE_TIMING_EVENT } from "./thread-execution-projection.js";

export interface DeviceVoiceTimingInput {
  readonly runId: string;
  readonly saidAt: string;
  readonly firstTextAt: string;
  readonly firstSoundAt: string | null;
}

export function deviceVoiceTimingRecorder(dependencies: {
  readonly ownerId: string;
  readonly agentId: string;
  readonly trace: TraceStorePort;
  readonly payloads: Pick<PayloadStorePort, "put">;
  readonly protector: PayloadProtectorPort;
  readonly now: () => string;
}) {
  const ignoreDuplicate = (error: unknown) => {
    if (!(error instanceof ApplicationPortError) || error.code !== PORT_ERROR_CODES.DUPLICATE)
      throw error;
  };
  return async (input: DeviceVoiceTimingInput): Promise<"recorded" | "unknown_run"> => {
    const [first] = await dependencies.trace.readRun(input.runId as RunId, 0, 1);
    if (!first || first.ownerId !== dependencies.ownerId || first.agentId !== dependencies.agentId)
      return "unknown_run";
    const now = dependencies.now();
    const payloadRef = `payload:voice-timing:${input.runId}`;
    try {
      await dependencies.payloads.put(
        await dependencies.protector.protect({
          ownerId: first.ownerId,
          agentId: first.agentId,
          ref: payloadRef,
          dataClassification: "private",
          contentType: "application/json",
          plaintext: new TextEncoder().encode(
            JSON.stringify({
              saidAt: input.saidAt,
              firstTextAt: input.firstTextAt,
              firstSoundAt: input.firstSoundAt,
            }),
          ),
          createdAt: now,
        }),
      );
    } catch (error) {
      ignoreDuplicate(error);
    }
    try {
      await dependencies.trace.appendNext({
        id: `trace:voice-timing:${input.runId}`,
        schemaVersion: first.schemaVersion,
        ownerId: first.ownerId,
        agentId: first.agentId,
        sessionId: first.sessionId,
        threadId: first.threadId,
        runId: first.runId,
        turnId: null,
        parentEventId: null,
        causationId: null,
        correlationId: first.correlationId,
        occurredAt: now,
        recordedAt: now,
        actorId: "paired-device",
        dataClassification: "private",
        eventType: DEVICE_VOICE_TIMING_EVENT,
        payloadRef,
      });
    } catch (error) {
      ignoreDuplicate(error);
    }
    return "recorded";
  };
}
