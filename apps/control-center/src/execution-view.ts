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

const authorizationReviewLabels = {
  "runtime.authorization_review.started": "review.authorizationStarted",
  "runtime.authorization_review.approved": "review.authorizationApproved",
  "runtime.authorization_review.denied": "review.authorizationDenied",
  "runtime.authorization_review.human": "review.authorizationHuman",
  "runtime.authorization_review.alternative": "review.authorizationAlternative",
} as const satisfies Readonly<Record<string, MessageId>>;

/** Only persisted host observations, with no inferred end time or human approval. */
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

/** Connection health is distinct from execution progress; an old observation is not a heartbeat. */
export function executionActivity(
  records: readonly ThreadExecutionRecord[],
  run: RunSummary,
  connection: string,
  now: number,
) {
  const ordered = [...records].sort((a, b) => a.sequence - b.sequence);
  const last = ordered.at(-1);
  const activity = ordered.findLast((record) => record.name.startsWith("runtime.activity."));
  const tool = executionItems(records).findLast(
    (record) => record.kind === "tool" && record.phase === "started",
  );
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
    age,
    stale: !isTerminalRun(run) && run.status !== "awaiting_approval" && age >= 15000,
  };
}

/** Backend outcome markers remain separate from transport/Pi invocation phases. */
export function executionToolPhase(
  item: ThreadExecutionRecord,
  records: readonly ThreadExecutionRecord[],
  run: RunSummary,
): MessageId | undefined {
  const marker = [...records]
    .filter(
      (record) => record.itemId === item.itemId && record.name.startsWith("runtime.tool_outcome."),
    )
    .sort((a, b) => a.sequence - b.sequence)
    .at(-1);
  if (!marker || marker.sequence < item.sequence) return undefined;
  switch (marker.name) {
    case "runtime.tool_outcome.not_dispatched":
      return "chat.phase.notDispatched";
    case "runtime.tool_outcome.unresolved":
      return "chat.phase.unresolved";
    case "runtime.tool_outcome.preparing":
      // The Run has ended, but no tool result establishes whether it started or
      // changed a file. Keep that uncertainty without a perpetual active phase.
      return isTerminalRun(run) ? "chat.phase.unresolved" : "chat.phase.preparing";
    default:
      return undefined;
  }
}

/** A delta notification can be replayed; snapshots have stable event and item identities. */
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

/** The displayed tool/message duration excludes the Run's recorded approval waits. */
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

/** Time is derived only from recorded execution boundaries, excluding approval waits. */
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

/** Only durable, public stage markers; never synthesize reasoning or infer successful steps. */
export const executionStageLabels: Readonly<Record<string, MessageId>> = {
  "memory.query": "chat.stage.memoryQuery",
  "memory.candidates": "chat.stage.memoryCandidates",
  "memory.selection": "chat.stage.memorySelection",
  "context.formed": "chat.stage.context",
  "runtime.turn_started": "chat.stage.model",
  "runtime.suspended": "chat.phase.waiting",
};
export function executionStages(records: readonly ThreadExecutionRecord[]) {
  return [...new Map(records.map((record) => [record.id, record])).values()]
    .filter((record) => record.kind === "status" && executionStageLabels[record.name])
    .sort((a, b) => a.sequence - b.sequence);
}

/** Never treat request/transport timestamps as host execution time. */
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

/** Provider thinking-stream boundaries contain no private reasoning text. */
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
  // Older histories only attest that thinking was observed; they do not provide duration.
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

/** Localization only: all phase decisions belong to the backend projection. */
export function executionStateLabel(
  phase: ThreadExecutionState["displayPhase"],
  reasonCode?: string,
): MessageId {
  const reasonLabels: Readonly<Record<string, MessageId>> = {
    RESOURCE_STOP_IN_PROGRESS: "chat.resource.stopping",
    RESOURCE_CHECK_IN_PROGRESS: "chat.resource.verifying",
    RESOURCE_QUEUE_WAITING: "chat.resource.queued",
    RESOURCE_EXECUTION_OBSERVED: "chat.resource.executing",
    RESOURCE_STOP_NOT_STRICTLY_CONFIRMED: "chat.resource.stopNotStrictlyConfirmed",
    RUN_STOPPED_NOT_STRICTLY_CONFIRMED: "chat.resource.stopNotStrictlyConfirmed",
    EXECUTION_RECORD_DELETED: "chat.resource.recordDeleted",
    WORKER_ADMISSION_CONFLICT: "chat.reason.admissionConflict",
    WORKER_AUTHORIZATION_DENIED: "chat.reason.authorizationDenied",
    WORKER_AUTHORITY_UNAVAILABLE: "chat.reason.authorityUnavailable",
    WORKER_ADMISSION_RESOURCE_MISSING: "chat.reason.admissionResourceMissing",
    WORKER_ADMISSION_ALREADY_RECORDED: "chat.reason.admissionAlreadyRecorded",
    WORKER_OPERATION_UNAVAILABLE: "chat.reason.operationUnavailable",
    WORKER_ADMISSION_UNAVAILABLE: "chat.reason.admissionUnavailable",
    WORKER_DEADLINE_EXCEEDED: "chat.reason.deadlineExceeded",
    WORKER_RESOURCE_CEILING_CHANGED: "chat.reason.resourceCeilingChanged",
    DIRECTORY_TARGET_CHANGED: "chat.reason.directoryTargetChanged",
    FILE_VERSION_CONFLICT: "chat.reason.fileVersionConflict",
    SANDBOX_COMMAND_EFFECT_UNVERIFIED: "chat.reason.commandEffectUnverified",
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

/** Give the owner a safe follow-up based only on durable execution facts. */
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
    return state.effectSummary.some((effect) => effect.outcome === "succeeded")
      ? "chat.nextAction.partial"
      : "chat.nextAction.failed";
  return undefined;
}
