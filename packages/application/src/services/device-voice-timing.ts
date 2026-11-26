import type { RunId } from "@himawari-agent/domain";
import { ApplicationPortError, PORT_ERROR_CODES } from "../ports/common.js";

import type {
  PayloadProtectorPort,
  PayloadStorePort,
  TraceStorePort,
} from "../ports/observability.js";
import { DEVICE_VOICE_TIMING_EVENT } from "./thread-execution-projection.js";

export interface DeviceVoiceTimingInput {
  readonly messageId: string;
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
  readonly firstTextEmittedAt?: (runId: string) => string | null;
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
              messageId: input.messageId,
              emittedAt: dependencies.firstTextEmittedAt?.(input.runId) ?? null,
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

export interface DeviceVoiceTimingItem {
  readonly messageId: string;
  readonly saidAt: string;
  readonly firstTextAt: string;
  readonly firstSoundAt: string | null;
  readonly emittedAt: string | null;
}

const MAXIMUM_VOICE_TIMING_ITEMS = 50;

export function deviceVoiceTimingLister(dependencies: {
  readonly ownerId: string;
  readonly agentId: string;
  readonly trace: TraceStorePort;
  readonly payloads: Pick<PayloadStorePort, "get">;
  readonly protector: PayloadProtectorPort;
}) {
  const instant = (value: unknown): value is string =>
    typeof value === "string" && !Number.isNaN(Date.parse(value));
  return async (limit: number): Promise<readonly DeviceVoiceTimingItem[]> => {
    const events = await dependencies.trace.readRecentByType({
      ownerId: dependencies.ownerId as never,
      agentId: dependencies.agentId as never,
      eventType: DEVICE_VOICE_TIMING_EVENT,
      limit: Math.min(Math.max(limit, 1), MAXIMUM_VOICE_TIMING_ITEMS),
    });
    const items: DeviceVoiceTimingItem[] = [];
    for (const event of events) {
      if (event.payloadRef === null) continue;
      const payload = await dependencies.payloads.get(event.payloadRef);
      if (!payload || payload.contentType !== "application/json") continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            await dependencies.protector.unprotect({
              ownerId: event.ownerId,
              agentId: event.agentId,
              payload,
            }),
          ),
        );
      } catch {
        continue;
      }
      const { messageId, saidAt, firstTextAt, firstSoundAt, emittedAt } = record;
      if (typeof messageId !== "string" || !instant(saidAt) || !instant(firstTextAt)) continue;
      items.push({
        messageId,
        saidAt,
        firstTextAt,
        firstSoundAt: instant(firstSoundAt) ? firstSoundAt : null,
        emittedAt: instant(emittedAt) ? emittedAt : null,
      });
    }
    return items.sort((left, right) => right.saidAt.localeCompare(left.saidAt));
  };
}
