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

/** A delta notification can be replayed; snapshots have stable event and item identities. */
export function executionItems(records: readonly ThreadExecutionRecord[]) {
  const items = new Map<
    string,
    ThreadExecutionRecord & { startedAt: string | null; endedAt: string | null }
  >();
  for (const record of [...new Map(records.map((item) => [item.id, item])).values()].sort(
    (a, b) => a.sequence - b.sequence,
  )) {
    if (record.kind === "status") continue;
    const previous = items.get(record.itemId);
    items.set(record.itemId, {
      ...record,
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
  return [...items.values()];
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
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
