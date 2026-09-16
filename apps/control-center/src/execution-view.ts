import type {
  ThreadExecutionRecord,
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
  const label: MessageId =
    connection !== "connected" && !isTerminalRun(run)
      ? "chat.disconnected"
      : run.status === "reconciling_external_result"
        ? "chat.phase.unresolved"
        : run.status === "awaiting_approval"
          ? "runs.status.awaitingApproval"
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
      return "chat.phase.preparing";
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
