import type {
  ThreadExecutionRecord,
  ThreadExecutionState,
  ThreadGatewaySnapshot,
} from "@himawari-agent/gateway-contracts";
import type { MessageId } from "./i18n/message-ids.js";

export function executionFailureMessage(records: readonly ThreadExecutionRecord[]): MessageId {
  const failure = [...records]
    .filter((item) => item.kind === "status" && item.name === "runtime.failed")
    .sort((a, b) => a.sequence - b.sequence)
    .at(-1);
  switch (failure?.text) {
    case "PI_MODEL_RATE_LIMITED":
      return "chat.error.rateLimited";
    case "PI_MODEL_AUTH_FAILED":
      return "chat.error.authFailed";
    case "PI_MODEL_UNAVAILABLE":
      return "chat.error.unavailable";
    case "PI_MODEL_QUOTA_EXCEEDED":
      return "chat.error.quotaExceeded";
    case "PI_CONTEXT_WINDOW_EXHAUSTED":
      return "chat.error.contextWindowExhausted";
    default:
      return "chat.error.failed";
  }
}

export type RunSummary = Extract<
  ThreadGatewaySnapshot,
  { type: "thread.detail_snapshot" }
>["payload"]["runs"][number];
export const isTerminalRun = (run: RunSummary) =>
  ["completed", "failed", "cancelled"].includes(run.status);
export const isAnsweredRun = (run: RunSummary) => isTerminalRun(run) || Boolean(run.background);

const authorizationReviewLabels = {
  "runtime.authorization_review.started": "review.authorizationStarted",
  "runtime.authorization_review.approved": "review.authorizationApproved",
  "runtime.authorization_review.denied": "review.authorizationDenied",
  "runtime.authorization_review.human": "review.authorizationHuman",
  "runtime.authorization_review.alternative": "review.authorizationAlternative",
} as const satisfies Readonly<Record<string, MessageId>>;
export function authorizationReviewSteps(records: readonly ThreadExecutionRecord[]) {
  const groups = new Map<
    string,
    { first: ThreadExecutionRecord; start?: ThreadExecutionRecord; end?: ThreadExecutionRecord }
  >();
  for (const record of [...new Map(records.map((record) => [record.id, record])).values()].sort(
    (a, b) => a.sequence - b.sequence,
  )) {
    if (
      record.kind !== "status" ||
      record.phase !== "updated" ||
      !Object.hasOwn(authorizationReviewLabels, record.name)
    )
      continue;
    const group = groups.get(record.itemId) ?? { first: record };
    if (record.name === "runtime.authorization_review.started") group.start ??= record;
    else group.end ??= record;
    groups.set(record.itemId, group);
  }
  return [...groups.entries()].map(([itemId, { first, start, end }]) => {
    const name = (end ?? start ?? first).name as keyof typeof authorizationReviewLabels;
    const elapsed =
      start && end && end.sequence > start.sequence
        ? Date.parse(end.occurredAt) - Date.parse(start.occurredAt)
        : NaN;
    return {
      id: first.id,
      itemId,
      sequence: first.sequence,
      outcome: name.slice("runtime.authorization_review.".length),
      label: authorizationReviewLabels[name],
      elapsed: Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null,
    };
  });
}
export function executionActivity(
  records: readonly ThreadExecutionRecord[],
  run: RunSummary,
  connection: string,
  now: number,
) {
  const ordered = [...records].sort((a, b) => a.sequence - b.sequence);
  const last = ordered.at(-1);
  const activity = ordered.findLast((record) => record.name.startsWith("runtime.activity."));
  const items = executionItems(records);
  const tool = items.findLast((record) => record.kind === "tool" && record.phase === "started");
  const writing = toolCallWriting(records, items);
  const age = Math.max(0, now - Date.parse(last?.occurredAt ?? run.updatedAt));
  const review = authorizationReviewSteps(records).at(-1);
  const reviewing =
    !isTerminalRun(run) &&
    review?.outcome === "started" &&
    !ordered.some(
      (record) =>
        record.sequence > review.sequence &&
        [
          "runtime.model_started",
          "runtime.suspended",
          "runtime.completed",
          "runtime.failed",
          "runtime.cancelled",
          "runtime.result_unknown",
        ].includes(record.name),
    );
  const label: MessageId =
    connection !== "connected" && !isTerminalRun(run)
      ? "chat.disconnected"
      : run.status === "reconciling_external_result"
        ? "chat.phase.unresolved"
        : run.status === "awaiting_approval"
          ? "runs.status.awaitingApproval"
          : reviewing
            ? "review.authorizationChecking"
            : tool
              ? "chat.activity.tool"
              : writing && writing.sequence >= (activity?.sequence ?? 0)
                ? "chat.activity.writing"
                : activity?.name === "runtime.activity.thinking"
                  ? "chat.activity.thinking"
                  : activity?.name === "runtime.activity.text"
                    ? "chat.activity.output"
                    : activity?.name === "runtime.activity.toolCall"
                      ? "chat.activity.preparingTool"
                      : "chat.activity.waitingModel";
  return {
    label,
    tool: tool?.name ?? "",
    writing: label === "chat.activity.writing" ? writing : undefined,
    age,
    stale: !isTerminalRun(run) && run.status !== "awaiting_approval" && age >= 15000,
  };
}
export function toolCallWriting(
  records: readonly ThreadExecutionRecord[],
  items: ReturnType<typeof executionItems> = executionItems(records),
) {
  const latest = new Map<string, ThreadExecutionRecord>();
  for (const record of records)
    if (
      record.name === "runtime.tool_call.writing" &&
      (latest.get(record.itemId)?.sequence ?? 0) < record.sequence
    )
      latest.set(record.itemId, record);
  const open = [...latest.values()]
    .filter((record) => {
      const item = items.find((other) => other.itemId === record.itemId);
      return !item || (item.phase === "updated" && item.sequence <= record.sequence);
    })
    .sort((a, b) => a.sequence - b.sequence)
    .at(-1);
  if (!open) return undefined;
  const lines = Number(open.text);
  return Number.isSafeInteger(lines) && lines > 0
    ? { itemId: open.itemId, sequence: open.sequence, lines }
    : undefined;
}

export function executionToolPhase(
  item: ThreadExecutionRecord,
  records: readonly ThreadExecutionRecord[],
  run: RunSummary,
): MessageId | undefined {
  const reason = [...records]
    .filter(
      (record) => record.itemId === item.itemId && record.name.startsWith("runtime.tool_reason."),
    )
    .sort((a, b) => a.sequence - b.sequence)
    .at(-1);
  const marker = [...records]
    .filter(
      (record) => record.itemId === item.itemId && record.name.startsWith("runtime.tool_outcome."),
    )
    .sort((a, b) => a.sequence - b.sequence)
    .at(-1);
  switch (marker && marker.sequence >= item.sequence ? marker.name : undefined) {
    case "runtime.tool_outcome.not_dispatched":
      return "chat.phase.notDispatched";
    case "runtime.tool_outcome.unresolved":
      return "chat.phase.unresolved";
    case "runtime.tool_outcome.preparing":
      return isTerminalRun(run) ? "chat.phase.unresolved" : "chat.phase.preparing";
    default:
      return item.phase === "failed" && reason && reason.sequence >= item.sequence
        ? executionStateLabel("failed", reason.name.slice("runtime.tool_reason.".length))
        : undefined;
  }
}
export function executionItems(records: readonly ThreadExecutionRecord[]) {
  const items = new Map<
    string,
    ThreadExecutionRecord & {
      firstSequence: number;
      requestedAt: string | null;
      startedAt: string | null;
      endedAt: string | null;
    }
  >();
  for (const record of [...new Map(records.map((item) => [item.id, item])).values()].sort(
    (a, b) => a.sequence - b.sequence,
  )) {
    if (record.kind === "status") continue;
    const previous = items.get(record.itemId);
    items.set(record.itemId, {
      ...record,
      firstSequence: previous?.firstSequence ?? record.sequence,
      requestedAt:
        previous?.requestedAt ??
        (record.kind === "tool" && record.phase === "updated" ? record.occurredAt : null),
      input: record.input || previous?.input || "",
      activity: record.activity || previous?.activity || "",
      activityIcon: record.activityIcon || previous?.activityIcon || "",
      text: record.text || previous?.text || "",
      startedAt:
        previous?.startedAt ??
        (record.phase === "started" || record.kind === "message" ? record.occurredAt : null),
      endedAt:
        previous?.endedAt ??
        (["completed", "failed", "stopped"].includes(record.phase) ? record.occurredAt : null),
    });
  }
  return [...items.values()].filter(
    (item) =>
      item.kind !== "message" ||
      item.text.trim() ||
      ["failed", "stopped", "unavailable"].includes(item.phase),
  );
}

export function isNarration(
  item: { kind: string; firstSequence: number },
  items: readonly { kind: string; firstSequence: number }[],
) {
  return (
    item.kind === "message" &&
    items.some((other) => other.kind === "tool" && other.firstSequence >= item.firstSequence)
  );
}
export function executionItemWorkTime(
  item: { startedAt: string | null; endedAt: string | null },
  records: readonly ThreadExecutionRecord[],
): number | null {
  if (!item.startedAt || !item.endedAt) return null;
  const start = Date.parse(item.startedAt),
    end = Date.parse(item.endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  let waitingSince: number | undefined;
  let wait = 0;
  const overlap = (from: number, to: number) =>
    Math.max(0, Math.min(end, to) - Math.max(start, from));
  for (const record of [...new Map(records.map((record) => [record.id, record])).values()].sort(
    (a, b) => a.sequence - b.sequence,
  )) {
    if (
      record.kind !== "status" ||
      !["started", "waiting", "completed", "failed", "stopped"].includes(record.phase)
    )
      continue;
    const at = Date.parse(record.occurredAt);
    if (!Number.isFinite(at)) continue;
    if (waitingSince !== undefined) wait += overlap(waitingSince, at);
    waitingSince = record.phase === "waiting" ? at : undefined;
  }
  if (waitingSince !== undefined) wait += overlap(waitingSince, end);
  return Math.max(0, end - start - wait);
}
export function executionTime(
  records: readonly ThreadExecutionRecord[],
  run: RunSummary,
  now: number,
) {
  let work = 0,
    wait = 0;
  let start: number | undefined;
  let mode: "work" | "wait" = "work";
  for (const event of [...new Map(records.map((item) => [item.id, item])).values()].sort(
    (a, b) => a.sequence - b.sequence,
  )) {
    if (
      event.kind !== "status" ||
      !["started", "waiting", "completed", "failed", "stopped"].includes(event.phase)
    )
      continue;
    const at = Date.parse(event.occurredAt);
    if (!Number.isFinite(at)) continue;
    if (start !== undefined) {
      if (mode === "work") work += Math.max(0, at - start);
      else wait += Math.max(0, at - start);
    }
    mode = event.phase === "waiting" ? "wait" : "work";
    start = ["completed", "failed", "stopped"].includes(event.phase) ? undefined : at;
  }
  if (start !== undefined) {
    const end = isTerminalRun(run) ? Date.parse(run.updatedAt) : now;
    if (mode === "work") work += Math.max(0, end - start);
    else wait += Math.max(0, end - start);
  }
  return {
    work,
    wait,
    known: records.some((item) => item.kind === "status" && item.phase === "started"),
  };
}
export function duration(milliseconds: number): string {
  if (milliseconds > 0 && milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  const seconds = Math.round(Math.max(0, milliseconds) / 100) / 10;
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}
export function recordedInterval(
  records: readonly ThreadExecutionRecord[],
  itemId: string,
  prefix: string,
): number | null {
  const events = records.filter((record) => record.itemId === itemId);
  const start = events.find((record) => record.name === `${prefix}.started`);
  const end = events.find((record) => record.name === `${prefix}.ended`);
  if (!start || !end) return null;
  const elapsed = Date.parse(end.occurredAt) - Date.parse(start.occurredAt);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}
export function thinkingSteps(records: readonly ThreadExecutionRecord[]) {
  const boundaries = [
    ...new Map(
      records
        .filter((record) => record.name === "runtime.thinking.started")
        .map((record) => [record.itemId, record]),
    ).values(),
  ];
  if (boundaries.length)
    return boundaries.map((record) => ({
      ...record,
      elapsed: recordedInterval(records, record.itemId, "runtime.thinking"),
    }));
  const observations = records.filter((record) => record.name === "runtime.activity.thinking");
  return observations
    .filter(
      (record, index) =>
        index === 0 ||
        records.some(
          (other) =>
            other.sequence > (observations[index - 1]?.sequence ?? 0) &&
            other.sequence < record.sequence &&
            (other.kind === "tool" || other.name === "runtime.activity.text"),
        ),
    )
    .map((record) => ({ ...record, elapsed: null }));
}
export function executionStateLabel(
  phase: ThreadExecutionState["displayPhase"],
  reasonCode?: string,
): MessageId {
  const reasonLabels: Readonly<Record<string, MessageId>> = {
    RUN_BUILDING_CONTEXT: "chat.activity.buildingContext",
    RESOURCE_STOP_IN_PROGRESS: "chat.resource.stopping",
    RESOURCE_CHECK_IN_PROGRESS: "chat.resource.verifying",
    RESOURCE_QUEUE_WAITING: "chat.resource.queued",
    RESOURCE_EXECUTION_OBSERVED: "chat.resource.executing",
    RESOURCE_STOP_NOT_STRICTLY_CONFIRMED: "chat.resource.stopNotStrictlyConfirmed",
    RUN_STOPPED_NOT_STRICTLY_CONFIRMED: "chat.resource.stopNotStrictlyConfirmed",
    EXECUTION_RECORD_DELETED: "chat.resource.recordDeleted",
    RESOURCE_OBSERVATION_EXPIRED: "chat.resource.noReport",
    WORKER_ADMISSION_CONFLICT: "chat.reason.admissionConflict",
    WORKER_AUTHORIZATION_DENIED: "chat.reason.authorizationDenied",
    WORKER_AUTHORITY_UNAVAILABLE: "chat.reason.authorityUnavailable",
    WORKER_ADMISSION_RESOURCE_MISSING: "chat.reason.admissionResourceMissing",
    WORKER_ADMISSION_ALREADY_RECORDED: "chat.reason.admissionAlreadyRecorded",
    WORKER_OPERATION_UNAVAILABLE: "chat.reason.operationUnavailable",
    WORKER_ADMISSION_UNAVAILABLE: "chat.reason.admissionUnavailable",
    WORKER_DEADLINE_EXCEEDED: "chat.reason.deadlineExceeded",
    RUN_EXECUTION_DEADLINE_EXCEEDED: "chat.reason.runDeadlineExceeded",
    RUNTIME_TOOL_RESULT_UNKNOWN: "chat.reason.toolResultUnknown",
    SANDBOX_CPU_TIME_LIMIT: "chat.reason.toolCpuTimeLimit",
    SANDBOX_MEMORY_LIMIT: "chat.reason.toolMemoryLimit",
    SANDBOX_RESOURCE_LIMIT: "chat.reason.toolResourceLimit",
    SANDBOX_OUTPUT_LIMIT: "chat.reason.toolOutputLimit",
    SANDBOX_TOOL_DEADLINE_EXCEEDED: "chat.reason.toolDeadlineExceeded",
    SANDBOX_TOOL_NOT_STARTED: "chat.reason.toolNotStarted",
    WORKER_RESOURCE_CEILING_CHANGED: "chat.reason.resourceCeilingChanged",
    DIRECTORY_TARGET_CHANGED: "chat.reason.directoryTargetChanged",
    FILE_VERSION_CONFLICT: "chat.reason.fileVersionConflict",
    FILE_WRITE_NOT_STARTED: "chat.reason.fileWriteNotStarted",
    SANDBOX_COMMAND_EFFECT_UNVERIFIED: "chat.reason.commandEffectUnverified",
    SANDBOX_WRITE_EFFECT_UNVERIFIED: "chat.reason.writeEffectUnverified",
    SANDBOX_STRICT_MODE_UNAVAILABLE: "chat.reason.strictModeUnavailable",
  };
  return (
    (reasonCode && Object.hasOwn(reasonLabels, reasonCode)
      ? reasonLabels[reasonCode]
      : undefined) ??
    ({
      preparing: "chat.phase.preparing",
      awaiting_approval: "runs.status.awaitingApproval",
      reviewing: "review.authorizationChecking",
      model_waiting: "chat.activity.waitingModel",
      model_thinking: "chat.activity.thinking",
      model_output: "chat.activity.output",
      completed: "chat.phase.completed",
      failed: "chat.phase.failed",
      stopped: "chat.phase.stopped",
      unresolved: "chat.phase.unresolved",
      not_dispatched: "chat.phase.notDispatched",
    }[phase] as MessageId)
  );
}

export function executionWaitReason(
  state: ThreadExecutionState,
  run: RunSummary,
  items: readonly Pick<ThreadExecutionRecord, "itemId" | "kind" | "name">[],
): { id: MessageId; tool: string } | undefined {
  if (state.displayPhase !== "unresolved") return undefined;
  const operation = state.operations.find((operation) => operation.displayPhase === "unresolved");
  const tool = items.find((item) => item.kind === "tool" && item.itemId === operation?.itemId);
  if (!tool) return undefined;
  return {
    id: isTerminalRun(run) ? "chat.waiting.afterTurn" : "chat.waiting.tool",
    tool: tool.name,
  };
}
export function executionNextAction(state: ThreadExecutionState): MessageId | undefined {
  if (state.displayPhase === "unresolved") {
    if (state.availableActions.includes("retry_cleanup")) return "chat.nextAction.retryCleanup";
    if (state.availableActions.includes("stop")) return "chat.nextAction.stop";
    return "chat.nextAction.unresolved";
  }
  if (state.displayPhase === "not_dispatched") return "chat.nextAction.notDispatched";
  if (state.reasonCode === "RUN_STOPPED_NOT_STRICTLY_CONFIRMED")
    return "chat.nextAction.stopNotStrictlyConfirmed";
  if (
    state.displayPhase === "stopped" &&
    state.effectSummary.some(
      (effect) => effect.outcome === "succeeded" || effect.outcome === "failed",
    )
  )
    return "chat.nextAction.stoppedWithResults";
  if (state.displayPhase === "failed")
    return state.effectSummary.length === 0
      ? "chat.nextAction.failedBeforeAnyOperation"
      : state.effectSummary.some((effect) => effect.outcome === "succeeded")
        ? "chat.nextAction.partial"
        : "chat.nextAction.failed";
  return undefined;
}
export function endedAwaitingApproval(
  item: Pick<ThreadExecutionRecord, "itemId" | "kind" | "output"> & { firstSequence: number },
  records: readonly ThreadExecutionRecord[],
  run: RunSummary,
): boolean {
  if (!isTerminalRun(run) || item.kind !== "tool" || item.output) return false;
  if (recordedInterval(records, item.itemId, "runtime.tool_execution") !== null) return false;
  const later = [...new Map(records.map((record) => [record.id, record])).values()]
    .filter((record) => record.sequence > item.firstSequence)
    .sort((a, b) => a.sequence - b.sequence);
  const suspended = later.findLastIndex(
    (record) => record.kind === "status" && record.phase === "waiting",
  );
  return (
    suspended >= 0 &&
    later
      .slice(suspended + 1)
      .every(
        (record) =>
          record.kind === "status" &&
          record.phase !== "started" &&
          !["runtime.tool_intent", "runtime.tool_result"].includes(record.name),
      )
  );
}
