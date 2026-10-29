import type { ThreadExecutionRecord } from "@himawari-agent/gateway-contracts";
import { isTerminalRun, type RunSummary } from "./execution-view.js";

export type TimelineCategory = "you" | "tool" | "model" | "prep";
export type TimelineStepKind = "memory" | "context" | "think" | "write" | "you" | "tool";
export type TimelineSegmentKind = "wait" | "reason" | "output" | "queue" | "run";

export interface TimelineSegment {
  readonly kind: TimelineSegmentKind;
  readonly start: number;
  readonly end: number;
}

export interface TimelineStep {
  readonly id: string;
  readonly sequence: number;
  readonly kind: TimelineStepKind;
  readonly category: TimelineCategory;
  readonly start: number;
  readonly end: number;
  readonly running: boolean;
  readonly parallel: boolean;
  readonly segments: readonly TimelineSegment[];
  readonly itemId?: string;
  readonly count?: number;
  readonly characters?: number;
}

export interface ExecutionTimeline {
  readonly total: number;
  readonly categories: Readonly<Record<TimelineCategory, number>>;
  readonly steps: readonly TimelineStep[];
  readonly longest: string | null;
}

const categoryOrder: readonly TimelineCategory[] = ["you", "tool", "model", "prep"];
const categoryOf: Readonly<Record<TimelineStepKind, TimelineCategory>> = {
  memory: "prep",
  context: "prep",
  think: "model",
  write: "model",
  you: "you",
  tool: "tool",
};
const hiddenModelStep = 50;

interface ModelCall {
  readonly id: string;
  readonly sequence: number;
  readonly start: number;
  endSequence?: number;
  end?: number;
  messageId?: string;
  text: string;
  toolCalls: boolean;
  firstText?: number;
  textStart?: number;
  toolCallStart?: number;
  firstActivity?: number;
  readonly reasoning: { start: number; end?: number }[];
}

export function timelineDuration(milliseconds: number): string {
  const tenths = Math.round(Math.max(0, milliseconds) / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
  const seconds = Math.round(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export function executionTimeline(
  records: readonly ThreadExecutionRecord[],
  run: RunSummary,
  now: number,
): ExecutionTimeline | null {
  const origin = Date.parse(run.createdAt);
  const ordered = [...new Map(records.map((record) => [record.id, record])).values()].sort(
    (a, b) => a.sequence - b.sequence,
  );
  if (
    !Number.isFinite(origin) ||
    !ordered.some(
      (record) =>
        record.name === "memory.query" || (record.kind === "status" && record.phase === "started"),
    )
  )
    return null;
  const terminal = isTerminalRun(run);
  const total = Math.max(0, (terminal ? Date.parse(run.updatedAt) : now) - origin);
  const time = (record: ThreadExecutionRecord) =>
    Math.min(total, Math.max(0, Date.parse(record.occurredAt) - origin));
  const lastTime = ordered.length ? time(ordered[ordered.length - 1] as ThreadExecutionRecord) : 0;
  const openEnd = terminal ? lastTime : total;

  const steps: TimelineStep[] = [];
  const calls: ModelCall[] = [];
  let call: ModelCall | undefined;
  let memoryStart: number | undefined;
  let selectionEnd: number | undefined;
  let waitingSince: { id: string; sequence: number; start: number } | undefined;
  const toolStarts = new Map<string, { at: number; sequence: number }>();
  const toolExecutions = new Map<string, { start?: number; end?: number }>();

  const closeWait = (end: number) => {
    if (!waitingSince) return;
    steps.push(
      step("you", waitingSince.id, waitingSince.sequence, waitingSince.start, end, false, []),
    );
    waitingSince = undefined;
  };
  const openCall = (record: ThreadExecutionRecord) => {
    call = {
      id: record.id,
      sequence: record.sequence,
      start: time(record),
      text: "",
      toolCalls: false,
      reasoning: [],
    };
    calls.push(call);
  };

  for (const record of ordered) {
    const at = time(record);
    if (record.name === "memory.query") memoryStart ??= at;
    else if (record.name === "memory.selection" && record.phase === "completed") {
      const count = Number(record.text) || 0;
      if (count > 0)
        steps.push({
          ...step("memory", record.id, record.sequence, memoryStart ?? at, at, false, []),
          count,
        });
      selectionEnd = at;
    } else if (
      record.name === "context.formed" &&
      record.phase === "completed" &&
      (Number(record.text) || 0) > 0
    ) {
      steps.push({
        ...step(
          "context",
          record.id,
          record.sequence,
          selectionEnd ?? memoryStart ?? at,
          at,
          false,
          [],
        ),
        count: Number(record.text) || 0,
      });
    } else if (record.kind === "status" && record.phase === "waiting") {
      closeWait(at);
      waitingSince = { id: record.id, sequence: record.sequence, start: at };
    } else if (record.kind === "status" && record.phase === "started") {
      closeWait(at);
      if (!call || call.end !== undefined) openCall(record);
    } else if (record.name === "runtime.turn_started") {
      closeWait(at);
      if (!call || call.end !== undefined || call.messageId) openCall(record);
    } else if (
      record.kind === "status" &&
      ["completed", "failed", "stopped"].includes(record.phase)
    )
      closeWait(at);
    else if (call && call.end === undefined) {
      if (record.name === "runtime.thinking.started") {
        call.reasoning.push({ start: at });
        call.firstActivity ??= at;
      } else if (record.name === "runtime.thinking.ended") {
        const open = call.reasoning.findLast((segment) => segment.end === undefined);
        if (open) open.end = at;
      } else if (record.name === "runtime.text.started") {
        call.textStart ??= at;
        call.firstActivity ??= at;
      } else if (record.name === "runtime.tool_call.started") {
        call.toolCallStart ??= at;
        call.firstActivity ??= at;
      } else if (record.kind === "message") {
        call.messageId = record.itemId;
        if (record.text.trim()) {
          call.firstText ??= at;
          call.firstActivity ??= at;
          call.text = record.text;
        }
        if (["completed", "failed", "stopped"].includes(record.phase)) {
          call.end = at;
          call.endSequence = record.sequence;
          call.toolCalls = ordered.some((other) => other.id.startsWith(`${record.id}:call:`));
        }
      }
    }
    if (record.kind === "tool" && record.phase === "started")
      toolStarts.set(record.itemId, { at, sequence: record.sequence });
    else if (record.name === "runtime.tool_execution.started")
      toolExecutions.set(record.itemId, { ...toolExecutions.get(record.itemId), start: at });
    else if (record.name === "runtime.tool_execution.ended")
      toolExecutions.set(record.itemId, { ...toolExecutions.get(record.itemId), end: at });
    else if (record.kind === "tool" && ["completed", "failed", "stopped"].includes(record.phase)) {
      const started = toolStarts.get(record.itemId);
      if (started === undefined) continue;
      toolStarts.delete(record.itemId);
      steps.push(toolStep(record.itemId, record.id, started.sequence, started.at, at));
    }
  }
  if (waitingSince) {
    steps.push(
      step(
        "you",
        waitingSince.id,
        waitingSince.sequence,
        waitingSince.start,
        openEnd,
        !terminal,
        [],
      ),
    );
    waitingSince = undefined;
  }
  for (const [itemId, started] of toolStarts)
    if (
      !terminal &&
      !calls.some((item) => item.start > started.at) &&
      !steps.some((item) => item.kind === "you" && item.start >= started.at)
    )
      steps.push(toolStep(itemId, `${itemId}:running`, started.sequence, started.at, total, true));
  for (const item of calls) steps.push(...modelSteps(item));

  const sorted = steps
    .filter((item) => item.end >= item.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const categories = categoryTotals(sorted, total);
  const visible = sorted
    .filter((item) => item.category !== "model" || item.end - item.start >= hiddenModelStep)
    .map((item, index, list) => ({
      ...item,
      parallel:
        item.kind === "tool" &&
        list.slice(0, index).some((other) => other.kind === "tool" && other.end > item.start),
    }));
  const longest = visible.reduce<TimelineStep | undefined>(
    (best, item) => (!best || item.end - item.start > best.end - best.start ? item : best),
    undefined,
  );
  return { total, categories, steps: visible, longest: longest?.id ?? null };

  function step(
    kind: TimelineStepKind,
    id: string,
    sequence: number,
    start: number,
    end: number,
    running: boolean,
    segments: TimelineSegment[],
  ): TimelineStep {
    return {
      id,
      sequence,
      kind,
      category: categoryOf[kind],
      start,
      end,
      running,
      parallel: false,
      segments,
    };
  }

  function toolStep(
    itemId: string,
    id: string,
    sequence: number,
    start: number,
    end: number,
    running = false,
  ): TimelineStep {
    const execution = toolExecutions.get(itemId);
    const segments: TimelineSegment[] = [];
    if (execution?.start !== undefined && execution.start >= start) {
      segments.push({ kind: "queue", start, end: execution.start });
      segments.push({ kind: "run", start: execution.start, end: execution.end ?? end });
    }
    return { ...step("tool", id, sequence, start, end, running, segments), itemId };
  }

  function modelSteps(item: ModelCall): TimelineStep[] {
    const running = item.end === undefined && !terminal;
    const end = item.end ?? openEnd;
    const answer = !item.toolCalls && !!item.text.trim();
    const outputStart = answer
      ? (item.textStart ?? item.firstText)
      : (item.toolCallStart ?? item.textStart ?? item.firstText);
    const thinkEnd = answer && outputStart !== undefined ? outputStart : end;
    const segments: TimelineSegment[] = [];
    let cursor = item.start;
    for (const reasoning of item.reasoning) {
      const reasonEnd = Math.min(reasoning.end ?? thinkEnd, thinkEnd);
      if (reasoning.start > cursor)
        segments.push({ kind: "wait", start: cursor, end: reasoning.start });
      segments.push({ kind: "reason", start: reasoning.start, end: reasonEnd });
      cursor = reasonEnd;
    }
    if (!answer && outputStart !== undefined && outputStart >= cursor) {
      if (outputStart > cursor) segments.push({ kind: "wait", start: cursor, end: outputStart });
      segments.push({ kind: "output", start: outputStart, end });
    } else if (thinkEnd > cursor) segments.push({ kind: "wait", start: cursor, end: thinkEnd });
    const think = {
      ...step(
        "think",
        item.id,
        item.sequence,
        item.start,
        thinkEnd,
        running && thinkEnd === end,
        segments,
      ),
      ...(item.messageId ? { itemId: item.messageId } : {}),
    };
    if (!answer || outputStart === undefined) return [think];
    return [
      think,
      {
        ...step(
          "write",
          `${item.id}:write`,
          item.endSequence ?? item.sequence,
          outputStart,
          end,
          running,
          [{ kind: "output", start: outputStart, end }],
        ),
        ...(item.messageId ? { itemId: item.messageId } : {}),
        characters: [...item.text].length,
      },
    ];
  }
}

function categoryTotals(
  steps: readonly TimelineStep[],
  total: number,
): Record<TimelineCategory, number> {
  const totals: Record<TimelineCategory, number> = { you: 0, tool: 0, model: 0, prep: 0 };
  const edges = [...new Set([0, total, ...steps.flatMap((item) => [item.start, item.end])])]
    .filter((edge) => edge >= 0 && edge <= total)
    .sort((a, b) => a - b);
  for (let index = 1; index < edges.length; index++) {
    const from = edges[index - 1] as number;
    const to = edges[index] as number;
    const covering = new Set(
      steps.filter((item) => item.start <= from && item.end >= to).map((item) => item.category),
    );
    const category = categoryOrder.find((candidate) => covering.has(candidate)) ?? "prep";
    totals[category] += to - from;
  }
  return totals;
}
