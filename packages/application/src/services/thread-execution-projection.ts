import { createAgentId, createOwnerId, createRunId, createThreadId } from "@himawari-agent/domain";
import type { ThreadExecutionRecord } from "@himawari-agent/gateway-contracts";
import { ApplicationPortError, PORT_ERROR_CODES } from "../ports/common.js";
import type {
  PayloadProtectorPort,
  PayloadStorePort,
  TraceEvent,
  TraceStorePort,
} from "../ports/observability.js";
import type { ThreadRepositoryPort } from "../ports/threads.js";
import { threadCommandFingerprint } from "./thread-command-service.js";
import { redactTracePayload } from "./trace-redaction.js";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown): string {
  return typeof value === "string"
    ? value.length > 65536
      ? `${value.slice(0, 65500)}\n[… truncated]`
      : value
    : "";
}
function identifier(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0
    ? `tool:${threadCommandFingerprint({ value })
        .replace(/[^a-zA-Z0-9]/g, "")
        .slice(-64)}`
    : fallback;
}
function visibleText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  // Reasoning blocks, signatures, images and provider metadata are never display text.
  return text(
    value
      .flatMap((item) => {
        const block = object(item);
        return block["type"] === "text" ? [text(block["text"])] : [];
      })
      .join("\n"),
  );
}

/** Owner-scoped presentation of existing durable observations, never arbitrary Trace JSON. */
export class ThreadExecutionProjection {
  private readonly dependencies: {
    readonly threads: ThreadRepositoryPort;
    readonly trace: TraceStorePort;
    readonly payloads: (ownerId: string, agentId: string) => PayloadStorePort;
    readonly protector: PayloadProtectorPort;
  };
  constructor(dependencies: {
    readonly threads: ThreadRepositoryPort;
    readonly trace: TraceStorePort;
    readonly payloads: (ownerId: string, agentId: string) => PayloadStorePort;
    readonly protector: PayloadProtectorPort;
  }) {
    this.dependencies = dependencies;
  }

  async read(input: {
    ownerId: string;
    agentId: string;
    threadId: string;
    runId: string;
    afterSequence: number;
    limit: number;
  }) {
    const ownerId = createOwnerId(input.ownerId),
      agentId = createAgentId(input.agentId),
      threadId = createThreadId(input.threadId),
      runId = createRunId(input.runId);
    const thread = await this.dependencies.threads.read(ownerId, agentId, threadId);
    const runs = await this.dependencies.threads.listRuns(ownerId, agentId, threadId);
    if (
      !thread ||
      !["active", "archived"].includes(thread.status) ||
      !runs.some((run) => run.runId === runId)
    )
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "THREAD_EXECUTION_NOT_FOUND");
    const events = await this.dependencies.trace.readRun(runId, input.afterSequence, input.limit);
    const records: ThreadExecutionRecord[] = [];
    for (const event of events) {
      if (
        event.ownerId !== ownerId ||
        event.agentId !== agentId ||
        event.threadId !== threadId ||
        event.runId !== runId
      )
        throw new ApplicationPortError(
          PORT_ERROR_CODES.NOT_AUTHORITATIVE,
          "THREAD_EXECUTION_SCOPE_MISMATCH",
        );
      if (!event.eventType.startsWith("runtime.")) continue;
      const base = {
        id: event.id,
        sequence: event.sequence,
        itemId: event.id,
        kind: "status" as const,
        phase: "unavailable" as const,
        name: event.eventType,
        text: "",
        input: "",
        output: "",
        occurredAt: event.occurredAt,
      };
      try {
        const envelope = object(await this.readPayload(event, event.payloadRef));
        if (event.eventType === "runtime.message" && envelope["role"] === "assistant") {
          const message = object(await this.readPayload(event, envelope["payloadRef"]));
          records.push({
            ...base,
            itemId: `message:${threadCommandFingerprint({
              runId,
              timestamp: message["timestamp"] ?? "current",
            })
              .replace(/[^a-zA-Z0-9]/g, "")
              .slice(-64)}`,
            kind: "message",
            phase:
              envelope["phase"] !== "ended"
                ? "updated"
                : message["stopReason"] === "error"
                  ? "failed"
                  : message["stopReason"] === "aborted"
                    ? "stopped"
                    : "completed",
            name: text(message["model"]),
            text: text(redactTracePayload(visibleText(message["content"]))),
          });
        } else if (
          event.eventType === "runtime.tool_intent" ||
          event.eventType === "runtime.tool_result"
        ) {
          const tool = object(await this.readPayload(event, envelope["payloadRef"]));
          const ended = event.eventType === "runtime.tool_result";
          const result = object(tool["result"]);
          // Older Pi captures can report isError=false for a resolved product
          // failure. Retained product error evidence must not become success.
          const productError = text(object(result["details"])["errorCode"]);
          records.push({
            ...base,
            itemId: identifier(tool["toolCallId"], event.id),
            kind: "tool",
            text: text(redactTracePayload(text(tool["description"]))),
            phase: ended
              ? tool["isError"] === true || productError
                ? "failed"
                : "completed"
              : "started",
            name: text(tool["toolName"]) || text(envelope["capabilityRef"]),
            input: ended
              ? ""
              : text(JSON.stringify(redactTracePayload(tool["arguments"] ?? {}), null, 2)),
            output: ended ? text(redactTracePayload(visibleText(result["content"]))) : "",
          });
        } else if (
          [
            "runtime.model_started",
            "runtime.suspended",
            "runtime.completed",
            "runtime.failed",
            "runtime.cancelled",
            "runtime.result_unknown",
          ].includes(event.eventType)
        ) {
          const phase =
            event.eventType === "runtime.model_started"
              ? "started"
              : event.eventType === "runtime.suspended"
                ? "waiting"
                : event.eventType === "runtime.completed"
                  ? "completed"
                  : event.eventType === "runtime.cancelled"
                    ? "stopped"
                    : "failed";
          records.push({
            ...base,
            phase,
            ...(phase === "started"
              ? {
                  name: text(envelope["modelRef"]) || base.name,
                  text: text(envelope["thinkingLevel"]),
                }
              : event.eventType === "runtime.failed"
                ? {
                    text: [
                      "PI_MODEL_RATE_LIMITED",
                      "PI_MODEL_AUTH_FAILED",
                      "PI_MODEL_UNAVAILABLE",
                    ].includes(text(envelope["errorCode"]))
                      ? text(envelope["errorCode"])
                      : "RUNTIME_EXECUTION_FAILED",
                  }
                : {}),
          });
        }
      } catch {
        // Preserve the event identity without disclosing raw errors or claiming empty success.
        records.push(base);
      }
    }
    return {
      records,
      nextSequence: events.length === input.limit ? (events.at(-1)?.sequence ?? null) : null,
    };
  }

  private async readPayload(event: TraceEvent, ref: unknown): Promise<unknown> {
    if (typeof ref !== "string") throw new Error("DISPLAY_PAYLOAD_UNAVAILABLE");
    const payload = await this.dependencies.payloads(event.ownerId, event.agentId).get(ref);
    if (
      !payload ||
      payload.contentType !== "application/json" ||
      payload.dataClassification !== event.dataClassification
    )
      throw new Error("DISPLAY_PAYLOAD_UNAVAILABLE");
    const bytes = await this.dependencies.protector.unprotect({
      ownerId: event.ownerId,
      agentId: event.agentId,
      payload,
    });
    if (bytes.byteLength > 1024 * 1024) throw new Error("DISPLAY_PAYLOAD_TOO_LARGE");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }
}
