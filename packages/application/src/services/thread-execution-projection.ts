import {
  createAgentId,
  createMemoryId,
  createOwnerId,
  createRunId,
  createThreadId,
} from "@himawari-agent/domain";
import { processStepText, type ThreadExecutionRecord } from "@himawari-agent/gateway-contracts";
import {
  PROCESS_ACTIVITY_FALLBACK_ICON,
  PROCESS_ACTIVITY_ICONS,
  PROCESS_ACTIVITY_MAX_LENGTH,
  TOOL_ACTIVITY_ICON_PARAMETER_NAME,
  TOOL_ACTIVITY_PARAMETER_NAME,
} from "@himawari-agent/prompt-catalog";
import {
  ApplicationPortError,
  type DataClassification,
  PORT_ERROR_CODES,
} from "../ports/common.js";
import type { ProductMemoryStatePort } from "../ports/memory-projection.js";
import type {
  PayloadProtectorPort,
  PayloadStorePort,
  TraceEvent,
  TraceStorePort,
} from "../ports/observability.js";
import type { RunCheckpointStore } from "../ports/run-checkpoints.js";
import type { SandboxExecutionRunInventory } from "../ports/sandbox-execution-journal.js";
import type { ThreadRepositoryPort } from "../ports/threads.js";
import { threadCommandFingerprint } from "./thread-command-service.js";
import {
  nextThreadExecutionResourceChangeAt,
  readThreadExecutionResources,
} from "./thread-execution-resources.js";
import { projectThreadExecutionState, SAFE_TOOL_REASON_CODES } from "./thread-execution-state.js";

const CLASSIFICATION_RANK: Readonly<Record<DataClassification, number>> = {
  public: 0,
  private: 1,
  sensitive: 2,
  restricted: 3,
};

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
function oneLine(value: string): string {
  return value
    .replace(/[\p{Cc}\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function toolActivity(
  value: unknown,
  toolName: string,
  locale: string,
): {
  readonly input: string;
  readonly activity: string;
  readonly activityIcon: string;
} {
  const {
    [TOOL_ACTIVITY_PARAMETER_NAME]: rawActivity,
    [TOOL_ACTIVITY_ICON_PARAMETER_NAME]: rawIcon,
    ...rest
  } = object(value);
  const activity =
    (typeof rawActivity === "string"
      ? [...oneLine(rawActivity)].slice(0, PROCESS_ACTIVITY_MAX_LENGTH).join("")
      : "") || processStepText(toolName, locale);
  const icon = typeof rawIcon === "string" ? rawIcon.trim() : "";
  return {
    input: text(
      JSON.stringify(
        value && typeof value === "object" && !Array.isArray(value) ? rest : (value ?? {}),
        null,
        2,
      ),
    ),
    activity,
    activityIcon: (PROCESS_ACTIVITY_ICONS as readonly string[]).includes(icon)
      ? icon
      : PROCESS_ACTIVITY_FALLBACK_ICON,
  };
}

export const DEVICE_VOICE_TIMING_EVENT = "device.voice_timing";

export function executionToolItemId(toolCallId: string): string {
  return identifier(toolCallId, toolCallId);
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
  return text(
    value
      .flatMap((item) => {
        const block = object(item);
        return block["type"] === "text" ? [text(block["text"])] : [];
      })
      .join("\n"),
  );
}

export function executionMessageItemId(runId: string, timestamp: unknown): string {
  return `message:${threadCommandFingerprint({ runId, timestamp: timestamp ?? "current" })
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(-64)}`;
}

function isExecutionChangedDuringRead(error: unknown): boolean {
  return (
    error instanceof ApplicationPortError &&
    (error.message === "THREAD_EXECUTION_CHANGED_DURING_READ" ||
      error.message === "THREAD_EXECUTION_RESOURCES_CHANGED_DURING_READ")
  );
}

export interface ThreadExecutionObservation {
  readonly traceSequence: number;
  readonly checkpointRevision: string | null;
  readonly resourceRevision: string | null;
  readonly resourcesPending: boolean;
  readonly nextChangeAt: string | null;
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

const STATE_RECORD_CACHE_RUNS = 200;

export class ThreadExecutionProjection {
  private readonly stateRecords = new Map<
    string,
    { readonly sequence: number; readonly records: readonly ThreadExecutionRecord[] }
  >();
  private readonly dependencies: {
    readonly threads: ThreadRepositoryPort;
    readonly trace: TraceStorePort;
    readonly payloads: (ownerId: string, agentId: string) => PayloadStorePort;
    readonly protector: PayloadProtectorPort;
    readonly resources?: ThreadExecutionResourceReader;
    readonly checkpoints?: Pick<RunCheckpointStore, "read">;
    readonly memories?: Pick<ProductMemoryStatePort, "readMany">;
  };
  constructor(dependencies: {
    readonly threads: ThreadRepositoryPort;
    readonly trace: TraceStorePort;
    readonly payloads: (ownerId: string, agentId: string) => PayloadStorePort;
    readonly protector: PayloadProtectorPort;
    readonly resources?: ThreadExecutionResourceReader;
    readonly checkpoints?: Pick<RunCheckpointStore, "read">;
    readonly memories?: Pick<ProductMemoryStatePort, "readMany">;
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
        ![
          "memory.query",
          "memory.candidates",
          "memory.selection",
          "context.formed",
          DEVICE_VOICE_TIMING_EVENT,
        ].includes(event.eventType)
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
        activity: "",
        activityIcon: "",
        occurredAt: event.occurredAt,
      };
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
        const broughtMemories =
          event.eventType === "memory.selection"
            ? envelope["selected"]
            : event.eventType === "context.formed"
              ? envelope["ownerProfile"]
              : undefined;
        if (Array.isArray(broughtMemories)) {
          const memoryIds = broughtMemories.flatMap((item) => {
            const entry = object(item);
            const ids = event.eventType === "memory.selection" ? [entry["id"]] : entry["memoryIds"];
            return Array.isArray(ids)
              ? ids.filter((id): id is string => typeof id === "string" && id.length > 0)
              : [];
          });
          records.push({
            ...base,
            phase: "completed",
            text: String(memoryIds.length),
            output: await this.memoryLines(event, memoryIds),
          });
        } else if (event.eventType === DEVICE_VOICE_TIMING_EVENT) {
          records.push({ ...base, phase: "updated", text: JSON.stringify(envelope) });
        } else if (
          [
            "memory.query",
            "memory.candidates",
            "memory.selection",
            "context.formed",
            "runtime.turn_started",
          ].includes(event.eventType)
        ) {
          records.push({ ...base, phase: "updated" });
        } else if (event.eventType === "runtime.message" && envelope["role"] === "assistant") {
          const message = object(await this.readPayload(event, envelope["payloadRef"]));
          records.push({
            ...base,
            itemId: executionMessageItemId(runId, message["timestamp"]),
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
            text: text(visibleText(message["content"])),
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
                ...toolActivity(call["arguments"], text(call["name"]), thread.answerLocale),
              });
            }
          } else {
            for (const [index, part] of content.entries()) {
              const call = object(part);
              const streaming = object(call["streaming"]);
              if (
                call["type"] !== "toolCall" ||
                typeof call["id"] !== "string" ||
                !Number.isSafeInteger(streaming["lines"])
              )
                continue;
              const itemId = identifier(call["id"], event.id);
              records.push({
                ...base,
                id: `${event.id}:call:${index}`,
                itemId,
                kind: "tool",
                phase: "updated",
                name: text(call["name"]),
                ...toolActivity(call["arguments"], text(call["name"]), thread.answerLocale),
              });
              records.push({
                ...base,
                id: `${event.id}:writing:${index}`,
                itemId,
                kind: "status",
                phase: "updated",
                name: "runtime.tool_call.writing",
                text: String(streaming["lines"]),
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
          const output = object(message["outputBoundary"]);
          if (
            ["text", "toolCall"].includes(String(output["kind"])) &&
            Number.isSafeInteger(output["contentIndex"])
          ) {
            records.push({
              ...base,
              id: `${event.id}:output`,
              itemId: `output:${threadCommandFingerprint({
                runId,
                timestamp: message["timestamp"],
                index: output["contentIndex"],
              })
                .replace(/[^a-zA-Z0-9]/g, "")
                .slice(-64)}`,
              phase: "updated",
              name:
                output["kind"] === "text" ? "runtime.text.started" : "runtime.tool_call.started",
            });
          }
          const usage = object(message["usage"]);
          if (envelope["phase"] === "ended" && Object.keys(usage).length) {
            const count = (value: unknown) =>
              Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
            const cost = Number(object(usage["cost"])["total"]);
            records.push({
              ...base,
              id: `${event.id}:usage`,
              phase: "updated",
              name: "runtime.usage",
              text: JSON.stringify({
                input: count(usage["input"]),
                output: count(usage["output"]),
                cacheRead: count(usage["cacheRead"]),
                cacheWrite: count(usage["cacheWrite"]),
                reasoning: count(usage["reasoning"]),
                ...(typeof message["servedModel"] === "string" &&
                message["servedModel"].length <= 160
                  ? { servedModel: message["servedModel"] }
                  : {}),
                costUsd: Number.isFinite(cost) && cost >= 0 ? cost : 0,
              }),
            });
          }
          const activity = object(content.at(-1))["type"];
          if (["thinking", "text", "toolCall"].includes(String(activity))) {
            records.push({
              ...base,
              id: `${event.id}:activity`,
              phase: "updated",
              name: `runtime.activity.${String(activity)}`,
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
            text: text(tool["description"]),
            phase: ended ? (failed ? "failed" : "completed") : "started",
            name: text(tool["toolName"]) || text(envelope["capabilityRef"]),
            ...(ended
              ? {}
              : toolActivity(
                  tool["arguments"],
                  text(tool["toolName"]) || text(envelope["capabilityRef"]),
                  thread.answerLocale,
                )),
            output: ended ? text(visibleText(result["content"])) : "",
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
                      "PI_MODEL_QUOTA_EXCEEDED",
                      "PI_CONTEXT_WINDOW_EXHAUSTED",
                    ].includes(text(envelope["errorCode"]))
                      ? text(envelope["errorCode"])
                      : "RUNTIME_EXECUTION_FAILED",
                  }
                : {}),
          });
        }
      } catch {
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
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await this.readConsistentState(input);
      } catch (error) {
        if (attempt === 3 || !isExecutionChangedDuringRead(error)) throw error;
      }
    }
    throw new ApplicationPortError(
      PORT_ERROR_CODES.NOT_AUTHORITATIVE,
      "THREAD_EXECUTION_CHANGED_DURING_READ",
    );
  }

  async observeRun(input: {
    ownerId: string;
    agentId: string;
    threadId: string;
    runId: string;
    afterSequence: number;
    known: { readonly resourceRevision: string | null; readonly resourcesPending: boolean } | null;
  }): Promise<ThreadExecutionObservation> {
    const ownerId = createOwnerId(input.ownerId),
      agentId = createAgentId(input.agentId),
      threadId = createThreadId(input.threadId),
      runId = createRunId(input.runId);
    let traceSequence = input.afterSequence;
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const events = await this.dependencies.trace.readRun(runId, traceSequence, 1000);
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
        if (event.sequence <= traceSequence)
          throw new ApplicationPortError(
            PORT_ERROR_CODES.NOT_AUTHORITATIVE,
            "THREAD_EXECUTION_PAGE_NOT_ADVANCING",
          );
        traceSequence = event.sequence;
      }
      if (events.length < 1000) break;
    }
    const checkpoint = await this.dependencies.checkpoints?.read(runId);
    const checkpointRevision = checkpoint ? threadCommandFingerprint(checkpoint) : null;
    const resourceReader = this.dependencies.resources;
    if (!resourceReader)
      return {
        traceSequence,
        checkpointRevision,
        resourceRevision: null,
        resourcesPending: false,
        nextChangeAt: null,
      };
    const inventory = await resourceReader.readInventory({ ownerId, agentId, runId });
    const resourceRevision = threadCommandFingerprint(inventory);
    const now = resourceReader.now();
    const resourcesPending =
      input.known && input.known.resourceRevision === resourceRevision
        ? input.known.resourcesPending
        : (
            await readThreadExecutionResources({
              ownerId,
              agentId,
              threadId,
              runId,
              inventory,
              now,
              payloads: this.dependencies.payloads(ownerId, agentId),
              protector: this.dependencies.protector,
              digest: resourceReader.digest,
              itemId: (toolCallId) => identifier(toolCallId, toolCallId),
            })
          ).pendingResources;
    return {
      traceSequence,
      checkpointRevision,
      resourceRevision,
      resourcesPending,
      nextChangeAt: nextThreadExecutionResourceChangeAt(inventory, now),
    };
  }

  private async readConsistentState(input: {
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
    const cacheKey = JSON.stringify([ownerId, agentId, threadId, runId]);
    const cached = this.stateRecords.get(cacheKey);
    const records: ThreadExecutionRecord[] = [...(cached?.records ?? [])];
    let afterSequence = cached?.sequence ?? 0;
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
        const checkpoint = await this.dependencies.checkpoints?.read(runId);
        const after = (await this.dependencies.threads.listRuns(ownerId, agentId, threadId)).find(
          (run) => run.runId === runId,
        );
        if (!after || after.revision !== before.revision)
          throw new ApplicationPortError(
            PORT_ERROR_CODES.NOT_AUTHORITATIVE,
            "THREAD_EXECUTION_CHANGED_DURING_READ",
          );
        this.rememberStateRecords(cacheKey, records);
        return projectThreadExecutionState(
          after,
          records,
          input.canCancelRun,
          resources,
          checkpoint?.checkpoint,
          inventory?.sandboxResourcesAbsent === true,
        );
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

  private rememberStateRecords(key: string, records: readonly ThreadExecutionRecord[]) {
    const unreadable = records.find((record) => record.phase === "unavailable")?.sequence;
    const settled = records
      .filter((record) => unreadable === undefined || record.sequence < unreadable)
      .map((record) => ({
        ...record,
        text: "",
        input: "",
        output: "",
        activity: "",
        activityIcon: "",
      }));
    this.stateRecords.delete(key);
    const sequence = settled.at(-1)?.sequence;
    if (sequence === undefined) return;
    this.stateRecords.set(key, { sequence, records: settled });
    for (const oldest of this.stateRecords.keys()) {
      if (this.stateRecords.size <= STATE_RECORD_CACHE_RUNS) break;
      this.stateRecords.delete(oldest);
    }
  }

  private async memoryLines(event: TraceEvent, memoryIds: readonly string[]): Promise<string> {
    const memories = this.dependencies.memories;
    if (!memories || memoryIds.length === 0) return "";
    const ceiling = CLASSIFICATION_RANK[event.dataClassification];
    const found = new Map(
      (
        await memories.readMany({
          ownerId: event.ownerId,
          agentId: event.agentId,
          memoryIds: memoryIds.map(createMemoryId),
        })
      ).map((memory) => [memory.id as string, memory]),
    );
    const payloads = this.dependencies.payloads(event.ownerId, event.agentId);
    const lines: string[] = [];
    for (const memoryId of memoryIds) {
      const memory = found.get(memoryId);
      if (
        !memory ||
        !["active", "archived"].includes(memory.status) ||
        CLASSIFICATION_RANK[memory.dataClassification] > ceiling
      )
        continue;
      const payload = await payloads.get(memory.contentRef);
      if (
        !payload?.contentType.startsWith("text/") ||
        CLASSIFICATION_RANK[payload.dataClassification] > ceiling
      )
        continue;
      const content = new TextDecoder()
        .decode(
          await this.dependencies.protector.unprotect({
            ownerId: event.ownerId,
            agentId: event.agentId,
            payload,
          }),
        )
        .replace(/\s+/gu, " ")
        .trim();
      if (content) lines.push(`- ${content}`);
    }
    return text(lines.join("\n"));
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
