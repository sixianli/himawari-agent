import type {
  ThreadExecutionRecord,
  ThreadExecutionState,
} from "@himawari-agent/gateway-contracts";
import type { ThreadRunSummaryRecord } from "../ports/threads.js";
import { threadCommandFingerprint } from "./thread-command-service.js";

type Interval = readonly [number, number];

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
            ? "TOOL_NOT_DISPATCHED"
            : phase === "completed"
              ? "TOOL_SUCCEEDED"
              : phase === "failed"
                ? "TOOL_FAILED"
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
  const displayPhase: ThreadExecutionState["displayPhase"] =
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
  const availableActions: ThreadExecutionState["availableActions"][number][] = [];
  if (!terminal && canCancelRun) availableActions.push("stop");
  if (canCancelRun && ["failed", "cancelled"].includes(run.status))
    availableActions.push("retry_cleanup");
  if (run.status === "awaiting_approval") availableActions.push("review_approval");
  const state = {
    runRevision: run.revision,
    lastObservedAt: records.reduce(
      (at, record) => (Date.parse(record.occurredAt) > Date.parse(at) ? record.occurredAt : at),
      run.updatedAt,
    ),
    displayPhase,
    reasonCode:
      run.status === "cancelled"
        ? "RUN_CANCELLED_RESOURCE_STATE_UNCONFIRMED"
        : displayPhase === "unresolved"
          ? "EXECUTION_RESULT_UNCONFIRMED"
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
  return { ...state, revision: threadCommandFingerprint(state) };
}
