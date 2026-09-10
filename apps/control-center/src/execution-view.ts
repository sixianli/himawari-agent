import type {
  ThreadExecutionRecord,
  ThreadGatewaySnapshot,
} from "@himawari-agent/gateway-contracts";

export type RunSummary = Extract<
  ThreadGatewaySnapshot,
  { type: "thread.detail_snapshot" }
>["payload"]["runs"][number];
export const isTerminalRun = (run: RunSummary) =>
  ["completed", "failed", "cancelled"].includes(run.status);

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
      endedAt: ["completed", "failed"].includes(record.phase) ? record.occurredAt : null,
    });
  }
  return [...items.values()];
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
