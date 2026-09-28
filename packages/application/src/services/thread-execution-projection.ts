import { createAgentId, createOwnerId, createRunId, createThreadId } from "@himawari-agent/domain";
import type { ThreadExecutionRecord } from "@himawari-agent/gateway-contracts";
import { ApplicationPortError, PORT_ERROR_CODES } from "../ports/common.js";
import type {
  PayloadProtectorPort,
  PayloadStorePort,
  TraceEvent,
  TraceStorePort,
} from "../ports/observability.js";
import type { SandboxExecutionRunInventory } from "../ports/sandbox-execution-journal.js";
import type { ThreadRepositoryPort } from "../ports/threads.js";
import { threadCommandFingerprint } from "./thread-command-service.js";
import { readThreadExecutionResources } from "./thread-execution-resources.js";
import { projectThreadExecutionState } from "./thread-execution-state.js";
import { redactTracePayload } from "./trace-redaction.js";

const SAFE_TOOL_REASON_CODES = new Set([
  "SANDBOX_TOOL_RESULT_LOST",
  "WORKER_ADMISSION_CONFLICT",
  "WORKER_AUTHORIZATION_DENIED",
  "WORKER_AUTHORITY_UNAVAILABLE",
  "WORKER_ADMISSION_RESOURCE_MISSING",
  "WORKER_ADMISSION_ALREADY_RECORDED",
  "WORKER_OPERATION_UNAVAILABLE",
  "WORKER_ADMISSION_UNAVAILABLE",
  "WORKER_DEADLINE_EXCEEDED",
  "WORKER_RESOURCE_CEILING_CHANGED",
  "DIRECTORY_TARGET_CHANGED",
  "FILE_VERSION_CONFLICT",
  "SANDBOX_COMMAND_EFFECT_UNVERIFIED",
  "SANDBOX_STRICT_MODE_UNAVAILABLE",
]);

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
function identifier(value: unknown, fallback: string, prefix = "tool"): string {
  return typeof value === "string" && value.length > 0
    ? `${prefix}:${threadCommandFingerprint({ value })
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

interface ThreadExecutionResourceReader {
  readonly readInventory: (input: {
    ownerId: string;
    agentId: string;
    runId: string;
  }) => Promise<SandboxExecutionRunInventory>;
  readonly now: () => string;
  readonly digest: (bytes: Uint8Array) => string;
}

/** Owner-scoped presentation of existing durable observations, never arbitrary Trace JSON. */
export class ThreadExecutionProjection {
  private readonly dependencies: {
    readonly threads: ThreadRepositoryPort;
    readonly trace: TraceStorePort;
    readonly payloads: (ownerId: string, agentId: string) => PayloadStorePort;
    readonly protector: PayloadProtectorPort;
    readonly resources?: ThreadExecutionResourceReader;
  };
  constructor(dependencies: {
    readonly threads: ThreadRepositoryPort;
    readonly trace: TraceStorePort;
    readonly payloads: (ownerId: string, agentId: string) => PayloadStorePort;
    readonly protector: PayloadProtectorPort;
    readonly resources?: ThreadExecutionResourceReader;
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
      if (
        !event.eventType.startsWith("runtime.") &&
        !["memory.query", "memory.candidates", "memory.selection", "context.formed"].includes(
          event.eventType,
        )
      )
        continue;
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
      // Host-authored review observations carry no model text or protected input.
      // Keep them as updated markers: they are not Run start/end timing boundaries.
      if (
        event.actorId === "automatic-review-control-plane" &&
        event.payloadRef === null &&
        event.causationId &&
        ["started", "approved", "denied", "human", "alternative"].some(
          (stage) => event.eventType === `runtime.authorization_review.${stage}`,
        )
      ) {
        records.push({
          ...base,
          itemId: identifier(event.causationId, event.id, "review"),
          phase: "updated",
        });
        continue;
      }
      try {
        const envelope = object(await this.readPayload(event, event.payloadRef));
        if (
          [
            "memory.query",
            "memory.candidates",
            "memory.selection",
            "context.formed",
            "runtime.turn_started",
          ].includes(event.eventType)
        ) {
          // Expose stage occurrence only, not private memory text or model context.
          records.push({ ...base, phase: "updated" });
        } else if (event.eventType === "runtime.message" && envelope["role"] === "assistant") {
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
          const content = Array.isArray(message["content"]) ? message["content"] : [];
          if (envelope["phase"] === "ended") {
            for (const [index, part] of content.entries()) {
              const call = object(part);
              if (call["type"] !== "toolCall" || typeof call["id"] !== "string") continue;
              records.push({
                ...base,
                id: `${event.id}:call:${index}`,
                itemId: identifier(call["id"], event.id),
                kind: "tool",
                phase: "updated",
                name: text(call["name"]),
                input: text(JSON.stringify(redactTracePayload(call["arguments"] ?? {}), null, 2)),
              });
            }
          }
          const boundary = object(message["thinkingBoundary"]);
          if (
            ["started", "ended"].includes(String(boundary["phase"])) &&
            Number.isSafeInteger(boundary["contentIndex"])
          ) {
            records.push({
              ...base,
              id: `${event.id}:thinking`,
              itemId: `thinking:${threadCommandFingerprint({
                runId,
                timestamp: message["timestamp"],
                index: boundary["contentIndex"],
              })
                .replace(/[^a-zA-Z0-9]/g, "")
                .slice(-64)}`,
              phase: "updated",
              name: `runtime.thinking.${String(boundary["phase"])}`,
            });
          }
          const activity = object(content.at(-1))["type"];
          if (["thinking", "text", "toolCall"].includes(String(activity))) {
            records.push({
              ...base,
              id: `${event.id}:activity`,
              phase: "updated",
              name: `runtime.activity.${String(activity)}`,
              // Report the observed activity only. Raw reasoning and signatures
              // remain in the protected payload, outside the display projection.
              text: content.some((part) => object(part)["type"] === "thinking")
                ? "thinking_observed"
                : "",
            });
          }
        } else if (
          event.eventType === "runtime.tool_intent" ||
          event.eventType === "runtime.tool_result"
        ) {
          const tool = object(await this.readPayload(event, envelope["payloadRef"]));
          const ended = event.eventType === "runtime.tool_result";
          const result = object(tool["result"]);
          // Older Pi captures can report isError=false for a resolved product
          // failure. Retained product error evidence must not become success.
          const details = object(result["details"]);
          const productError = text(details["errorCode"]);
          const productOutcome = text(details["productOutcome"]);
          const dispatchState = text(details["dispatchState"]);
          const legacyNotDispatched = [
            "WORKER_ADMISSION_CONFLICT",
            "WORKER_NOT_DISPATCHED",
            "RUNTIME_TOOL_CHECKPOINT_FAILED",
            "FILE_VERSION_CONFLICT",
          ].includes(productError);
          const notDispatched =
            dispatchState === "not_sent" || (dispatchState === "" && legacyNotDispatched);
          const unresolved =
            productOutcome === "result_unknown" ||
            (productOutcome === "succeeded" && notDispatched) ||
            (legacyNotDispatched && ["possibly_sent", "accepted"].includes(dispatchState)) ||
            (details["dispatchState"] !== undefined &&
              !["not_sent", "possibly_sent", "accepted"].includes(dispatchState)) ||
            ["RUNTIME_TOOL_EXECUTION_UNRESOLVED", "WORKER_RESULT_RECONCILIATION_REQUIRED"].includes(
              productError,
            );
          // Unknown or contradictory effects outrank an admission code. A missing
          // Pi error flag never turns a retained product failure into success.
          const failed =
            tool["isError"] === true ||
            productOutcome === "failed" ||
            notDispatched ||
            unresolved ||
            !!productError;
          const lifecycle = !ended
            ? "preparing"
            : unresolved
              ? "unresolved"
              : notDispatched
                ? "not_dispatched"
                : null;
          if (lifecycle)
            records.push({
              ...base,
              id: `${event.id}:outcome`,
              itemId: identifier(tool["toolCallId"], event.id),
              kind: "status",
              phase: "updated",
              name: `runtime.tool_outcome.${lifecycle}`,
            });
          if (ended && productOutcome === "failed" && SAFE_TOOL_REASON_CODES.has(productError))
            records.push({
              ...base,
              id: `${event.id}:reason`,
              itemId: identifier(tool["toolCallId"], event.id),
              kind: "status",
              phase: "updated",
              name: `runtime.tool_reason.${productError}`,
            });
          const timing = object(details["executionTiming"]);
          const start = text(timing["startedAt"]),
            end = text(timing["endedAt"]);
          if (
            ended &&
            Number.isFinite(Date.parse(start)) &&
            Number.isFinite(Date.parse(end)) &&
            Date.parse(end) >= Date.parse(start)
          ) {
            for (const [phase, at] of [
              ["started", start],
              ["ended", end],
            ] as const)
              records.push({
                ...base,
                id: `${event.id}:execution:${phase}`,
                itemId: identifier(tool["toolCallId"], event.id),
                phase: "updated",
                name: `runtime.tool_execution.${phase}`,
                occurredAt: at,
              });
          }
          records.push({
            ...base,
            itemId: identifier(tool["toolCallId"], event.id),
            kind: "tool",
            text: text(redactTracePayload(text(tool["description"]))),
            phase: ended ? (failed ? "failed" : "completed") : "started",
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
                      "CONTEXT_MEMORY_UNAVAILABLE",
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

  async readState(input: {
    ownerId: string;
    agentId: string;
    threadId: string;
    runId: string;
    canCancelRun: boolean;
  }) {
    const ownerId = createOwnerId(input.ownerId),
      agentId = createAgentId(input.agentId),
      threadId = createThreadId(input.threadId),
      runId = createRunId(input.runId);
    const before = (await this.dependencies.threads.listRuns(ownerId, agentId, threadId)).find(
      (run) => run.runId === runId,
    );
    if (!before)
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "THREAD_EXECUTION_NOT_FOUND");
    const resourceReader = this.dependencies.resources;
    const inventory = await resourceReader?.readInventory({ ownerId, agentId, runId });
    const resourceRevision = inventory ? threadCommandFingerprint(inventory) : null;
    const records: ThreadExecutionRecord[] = [];
    let afterSequence = 0;
    // Never return an aggregate of only the last page or a silently truncated history.
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const page = await this.read({ ...input, afterSequence, limit: 1000 });
      records.push(...page.records);
      if (page.nextSequence === null) {
        const resources =
          inventory && resourceReader
            ? await readThreadExecutionResources({
                ownerId,
                agentId,
                threadId,
                runId,
                inventory,
                now: resourceReader.now(),
                payloads: this.dependencies.payloads(ownerId, agentId),
                protector: this.dependencies.protector,
                digest: resourceReader.digest,
                itemId: (toolCallId) => identifier(toolCallId, toolCallId),
              })
            : undefined;
        if (
          resourceReader &&
          threadCommandFingerprint(
            await resourceReader.readInventory({ ownerId, agentId, runId }),
          ) !== resourceRevision
        )
          throw new ApplicationPortError(
            PORT_ERROR_CODES.NOT_AUTHORITATIVE,
            "THREAD_EXECUTION_RESOURCES_CHANGED_DURING_READ",
          );
        const after = (await this.dependencies.threads.listRuns(ownerId, agentId, threadId)).find(
          (run) => run.runId === runId,
        );
        if (!after || after.revision !== before.revision)
          throw new ApplicationPortError(
            PORT_ERROR_CODES.NOT_AUTHORITATIVE,
            "THREAD_EXECUTION_CHANGED_DURING_READ",
          );
        return projectThreadExecutionState(after, records, input.canCancelRun, resources);
      }
      if (page.nextSequence <= afterSequence)
        throw new ApplicationPortError(
          PORT_ERROR_CODES.NOT_AUTHORITATIVE,
          "THREAD_EXECUTION_PAGE_NOT_ADVANCING",
        );
      afterSequence = page.nextSequence;
    }
    throw new ApplicationPortError(
      PORT_ERROR_CODES.NOT_AUTHORITATIVE,
      "THREAD_EXECUTION_HISTORY_LIMIT",
    );
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
