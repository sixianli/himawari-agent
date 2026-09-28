import type {
  ThreadExecutionRecord,
  ThreadExecutionState,
} from "@himawari-agent/gateway-contracts";
import type { ThreadRunSummaryRecord } from "../ports/threads.js";
import { threadCommandFingerprint } from "./thread-command-service.js";
import type {
  ThreadExecutionResources,
  ThreadResourcePhase,
} from "./thread-execution-resources.js";

// Keep the v3 wire enum readable by already installed clients. Detailed resource
// facts travel through its existing reasonCode; old clients stay conservative.
function resourceDisplayPhase(phase: ThreadResourcePhase): ThreadExecutionState["displayPhase"] {
  return ["queued", "preparing", "executing"].includes(phase) ? "preparing" : "unresolved";
}

type Interval = readonly [number, number];
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

/** Only complete persisted intervals qualify. Parallel intervals contribute their union. */
function intervals(records: readonly ThreadExecutionRecord[], prefix: string): Interval[] {
  const starts = new Map<string, ThreadExecutionRecord>();
  const result: Interval[] = [];
  for (const record of records) {
    if (!record.name.startsWith(prefix)) continue;
    if (record.name === `${prefix}started`) {
      starts.set(record.itemId, record);
      continue;
    }
    const start = starts.get(record.itemId);
    if (!start) continue;
    starts.delete(record.itemId);
    const from = Date.parse(start.occurredAt),
      to = Date.parse(record.occurredAt);
    if (
      record.sequence >= start.sequence &&
      Number.isFinite(from) &&
      Number.isFinite(to) &&
      to >= from
    )
      result.push([from, to]);
  }
  return result;
}
function unionDuration(values: readonly Interval[]): number | null {
  if (!values.length) return null;
  let total = 0,
    end = -Infinity;
  for (const [from, to] of [...values].sort((a, b) => a[0] - b[0])) {
    total += Math.max(0, to - Math.max(end, from));
    end = Math.max(end, to);
  }
  return total;
}

/** One owner-scoped backend conclusion. No browser state, elapsed wall time or dispatch inference. */
export function projectThreadExecutionState(
  run: ThreadRunSummaryRecord,
  input: readonly ThreadExecutionRecord[],
  canCancelRun: boolean,
  resources?: ThreadExecutionResources,
): ThreadExecutionState {
  const records = [...new Map(input.map((record) => [record.id, record])).values()].sort(
    (a, b) => a.sequence - b.sequence,
  );
  const terminal = ["completed", "failed", "cancelled"].includes(run.status);
  const groups = new Map<string, ThreadExecutionRecord[]>();
  for (const record of records) {
    const group = groups.get(record.itemId) ?? [];
    group.push(record);
    groups.set(record.itemId, group);
  }
  const operations: ThreadExecutionState["operations"][number][] = [];
  const effectSummary: ThreadExecutionState["effectSummary"][number][] = [];
  for (const [itemId, group] of groups) {
    const tool = group.findLast(
      (record) =>
        record.kind === "tool" ||
        (record.phase === "unavailable" &&
          ["runtime.tool_intent", "runtime.tool_result"].includes(record.name)),
    );
    if (!tool) continue;
    const marker = group.findLast((record) => record.name.startsWith("runtime.tool_outcome."));
    const reason = group.findLast((record) => record.name.startsWith("runtime.tool_reason."));
    const toolReasonCode =
      reason && reason.sequence >= tool.sequence
        ? reason.name.slice("runtime.tool_reason.".length)
        : "";
    const outcome = marker && marker.sequence >= tool.sequence ? marker.name : "";
    const phase =
      tool.phase === "unavailable" || outcome === "runtime.tool_outcome.unresolved"
        ? "unresolved"
        : outcome === "runtime.tool_outcome.not_dispatched"
          ? "not_dispatched"
          : tool.phase === "completed"
            ? "completed"
            : tool.phase === "failed"
              ? "failed"
              : terminal
                ? "unresolved"
                : "preparing";
    operations.push({
      itemId,
      displayPhase: phase,
      reasonCode:
        phase === "unresolved"
          ? "TOOL_RESULT_UNCONFIRMED"
          : phase === "not_dispatched"
            ? SAFE_TOOL_REASON_CODES.has(toolReasonCode)
              ? toolReasonCode
              : "TOOL_NOT_DISPATCHED"
            : phase === "completed"
              ? "TOOL_SUCCEEDED"
              : phase === "failed"
                ? SAFE_TOOL_REASON_CODES.has(toolReasonCode)
                  ? toolReasonCode
                  : "TOOL_FAILED"
                : "TOOL_START_UNCONFIRMED",
      lastObservedAt: tool.occurredAt,
      executionMilliseconds: unionDuration(intervals(group, "runtime.tool_execution.")),
    });
    effectSummary.push({
      itemId,
      outcome:
        phase === "completed"
          ? "succeeded"
          : phase === "failed"
            ? "failed"
            : phase === "unresolved"
              ? "unknown"
              : phase === "not_dispatched"
                ? "not_dispatched"
                : "pending",
    });
  }
  const review = records.findLast((record) =>
    record.name.startsWith("runtime.authorization_review."),
  );
  const activity = records.findLast((record) => record.name.startsWith("runtime.activity."));
  const reviewing =
    review?.name === "runtime.authorization_review.started" &&
    !records.some(
      (record) =>
        record.sequence > review.sequence &&
        [
          "runtime.suspended",
          "runtime.completed",
          "runtime.failed",
          "runtime.cancelled",
          "runtime.result_unknown",
        ].includes(record.name),
    );
  let displayPhase: ThreadExecutionState["displayPhase"] =
    operations.some((operation) => operation.displayPhase === "unresolved") ||
    run.status === "reconciling_external_result" ||
    run.status === "cancelled"
      ? "unresolved"
      : terminal
        ? run.status === "completed"
          ? "completed"
          : "failed"
        : run.status === "awaiting_approval"
          ? "awaiting_approval"
          : reviewing
            ? "reviewing"
            : operations.some((operation) => operation.displayPhase === "preparing")
              ? "preparing"
              : activity?.name === "runtime.activity.thinking"
                ? "model_thinking"
                : activity?.name === "runtime.activity.text"
                  ? "model_output"
                  : run.status === "accepted" || run.status === "building_context"
                    ? "preparing"
                    : "model_waiting";
  const resourceResultUnconfirmed =
    resources?.unresolvedResultItemIds.some(
      (itemId) =>
        !effectSummary.some(
          (effect) => effect.itemId === itemId && ["succeeded", "failed"].includes(effect.outcome),
        ),
    ) ?? false;
  if (resources) {
    for (const operation of operations) {
      const resource = resources.operations.find((item) => item.itemId === operation.itemId);
      if (!resource || resource.phase === "not_dispatched") continue;
      const index = operations.indexOf(operation);
      if (resource.phase === "released" || resource.phase === "record_deleted") {
        if (
          resource.reasonCode !== "RESOURCE_RELEASE_CONFIRMED" &&
          operation.displayPhase !== "not_dispatched"
        )
          operations[index] = { ...operation, reasonCode: resource.reasonCode };
        continue;
      }
      const phase = resourceDisplayPhase(resource.phase);
      operations[index] = {
        ...operation,
        displayPhase: operation.displayPhase === "not_dispatched" ? "unresolved" : phase,
        reasonCode:
          operation.displayPhase === "not_dispatched"
            ? "RESOURCE_STATE_UNCONFIRMED"
            : resource.reasonCode,
        lastObservedAt:
          resource.lastObservedAt && resource.lastObservedAt > operation.lastObservedAt
            ? resource.lastObservedAt
            : operation.lastObservedAt,
      };
    }
    const unknownResult =
      resourceResultUnconfirmed || effectSummary.some((effect) => effect.outcome === "unknown");
    if (resources.phase) {
      displayPhase = ["stopping", "verifying", "unresolved"].includes(resources.phase)
        ? "unresolved"
        : terminal || unknownResult
          ? "unresolved"
          : resourceDisplayPhase(resources.phase);
    } else if (terminal && unknownResult) {
      displayPhase = "unresolved";
    } else if (
      run.status === "cancelled" &&
      !resources.pendingResources &&
      resources.operations.length > 0 &&
      resources.operations.every((operation) => operation.phase === "not_dispatched") &&
      effectSummary.length > 0 &&
      effectSummary.every((effect) => effect.outcome === "not_dispatched")
    ) {
      displayPhase = "not_dispatched";
    } else if (run.status === "cancelled" && resources.allReleased && !unknownResult) {
      displayPhase = "stopped";
    }
  }
  const availableActions: ThreadExecutionState["availableActions"][number][] = [];
  if (!terminal && canCancelRun) availableActions.push("stop");
  if (
    canCancelRun &&
    ["failed", "cancelled"].includes(run.status) &&
    !resources?.allReleased &&
    displayPhase !== "not_dispatched" &&
    !["stopping", "verifying"].includes(resources?.phase ?? "")
  )
    availableActions.push("retry_cleanup");
  if (run.status === "awaiting_approval") availableActions.push("review_approval");
  const state = {
    runRevision: run.revision,
    lastObservedAt: records.reduce(
      (at, record) => (Date.parse(record.occurredAt) > Date.parse(at) ? record.occurredAt : at),
      resources?.lastObservedAt && resources.lastObservedAt > run.updatedAt
        ? resources.lastObservedAt
        : run.updatedAt,
    ),
    displayPhase,
    reasonCode: resources?.phase
      ? displayPhase === "unresolved" &&
        ["queued", "preparing", "executing"].includes(resources.phase)
        ? "RESOURCE_STATE_UNCONFIRMED"
        : resources.reasonCode
      : resourceResultUnconfirmed
        ? "EXECUTION_RESULT_UNCONFIRMED"
        : displayPhase === "not_dispatched"
          ? "RUN_CANCELLED_BEFORE_DISPATCH"
          : displayPhase === "stopped"
            ? resources?.operations.some(
                (operation) => operation.reasonCode === "RESOURCE_STOP_NOT_STRICTLY_CONFIRMED",
              )
              ? "RUN_STOPPED_NOT_STRICTLY_CONFIRMED"
              : "RUN_CANCELLED_RESOURCES_RELEASED"
            : run.status === "cancelled"
              ? "RUN_CANCELLED_RESOURCE_STATE_UNCONFIRMED"
              : displayPhase === "unresolved"
                ? "EXECUTION_RESULT_UNCONFIRMED"
                : displayPhase === "preparing" &&
                    run.status === "building_context" &&
                    operations.length === 0
                  ? "RUN_BUILDING_CONTEXT"
                  : `EXECUTION_${displayPhase.toUpperCase()}`,
    availableActions,
    needsAttention: availableActions.includes("review_approval"),
    timing: {
      reviewMilliseconds: unionDuration(intervals(records, "runtime.authorization_review.")),
      executionMilliseconds: unionDuration(intervals(records, "runtime.tool_execution.")),
    },
    effectSummary,
    operations,
  };
  return {
    ...state,
    revision: threadCommandFingerprint({
      ...state,
      ...(resources ? { resourceRevision: resources.revision } : {}),
    }),
  };
}
