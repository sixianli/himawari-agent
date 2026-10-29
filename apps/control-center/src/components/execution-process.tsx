import type {
  ThreadExecutionRecord,
  ThreadExecutionState,
} from "@himawari-agent/gateway-contracts";
import { useEffect, useState } from "react";
import {
  type ExecutionTimeline,
  executionTimeline,
  type TimelineStep,
  timelineDuration,
} from "../execution-timeline.js";
import {
  authorizationReviewSteps,
  duration,
  endedAwaitingApproval,
  executionActivity,
  executionFailureMessage,
  executionItems,
  executionNextAction,
  executionStateLabel,
  executionTime,
  executionToolPhase,
  executionWaitReason,
  isAnsweredRun,
  isNarration,
  isTerminalRun,
  type RunSummary,
  recordedInterval,
  thinkingSteps,
} from "../execution-view.js";
import { useLocaleFormat } from "../i18n/locale-format.js";
import type { MessageId } from "../i18n/message-ids.js";
import { toolStepSummary } from "../step-summary.js";
import { formatTokens, type TurnUsage, turnUsage } from "../turn-summary.js";
import { AssistantMarkdown } from "./assistant-markdown.js";
import type { ContentPreviewValue } from "./content-preview.js";
import { ActionButton } from "./primitives.js";
import { type ToolGlyph, ToolIcon } from "./tool-icon.js";

type Message = (id: MessageId, values?: Record<string, string | number | boolean | Date>) => string;
function statusId(run: RunSummary): MessageId {
  const key =
    {
      building_context: "buildingContext",
      awaiting_approval: "awaitingApproval",
      reconciling_external_result: "reconcilingExternalResult",
    }[run.status as "building_context" | "awaiting_approval" | "reconciling_external_result"] ??
    run.status;
  return `runs.status.${key}` as MessageId;
}
function RecordedTime({ at }: { at: string }) {
  const format = useLocaleFormat();
  return (
    <time dateTime={at} title={format.full(at)}>
      {format.clock(at)}
    </time>
  );
}
export function ExecutionProcess({
  run,
  records,
  state,
  stateAvailable,
  message,
  connection,
  onPreview,
}: {
  onPreview?: ((preview: ContentPreviewValue) => void) | undefined;
  run: RunSummary;
  records: readonly ThreadExecutionRecord[];
  state?: ThreadExecutionState | undefined;
  stateAvailable?: boolean | undefined;
  message: Message;
  connection: string;
}) {
  const [now, setNow] = useState(Date.now());
  const [expandedChoice, setExpandedChoice] = useState<boolean | null>(null);
  const stateEnded = ["completed", "failed", "stopped", "not_dispatched"].includes(
    state?.displayPhase ?? "",
  );
  const activityEnded = (isAnsweredRun(run) || stateEnded) && state?.displayPhase !== "unresolved";
  useEffect(() => {
    if (activityEnded || connection !== "connected") return;
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [activityEnded, connection]);
  const items = executionItems(records);
  const timeline = executionTimeline(records, run, now);
  const rows = processRows(records, items, timeline);
  const expanded = expandedChoice ?? !activityEnded;
  const stepLabel = (step: TimelineStep) => {
    if (step.kind === "tool") {
      const tool = items.find((item) => item.itemId === step.itemId);
      return message(tool ? toolStepSummary(tool.name, tool.input).id : "step.other");
    }
    return step.count === undefined
      ? message(stepLabels[step.kind])
      : message(stepLabels[step.kind], { count: step.count });
  };
  const time = executionTime(records, run, now);
  const activity = executionActivity(records, run, connection, now);
  const measuredTime = stateAvailable
    ? (state?.timing.executionMilliseconds ?? null)
    : time.known
      ? time.work
      : null;
  const measuredTimeLabel = stateAvailable ? "chat.executionTime" : "chat.workTime";
  const observationAge = state ? Math.max(0, now - Date.parse(state.lastObservedAt)) : activity.age;
  const stale = stateAvailable
    ? !!state &&
      state.displayPhase !== "unresolved" &&
      state.availableActions.includes("stop") &&
      observationAge >= 15000
    : activity.stale;
  const stateLabel = state
    ? executionStateLabel(state.displayPhase, state.reasonCode)
    : stateAvailable
      ? "chat.recordUnavailable"
      : undefined;
  const nextAction = state ? executionNextAction(state) : undefined;
  const activeTool = items.findLast((item) => item.kind === "tool" && item.phase === "started");
  const activeSummary =
    !stateLabel && activity.label === "chat.activity.tool" && activeTool
      ? toolStepSummary(activeTool.name, activeTool.input)
      : undefined;
  const waitReason = state ? executionWaitReason(state, run, items) : undefined;
  return (
    <>
      {!activityEnded ? (
        <div className="turn-activity">
          {(
            state
              ? state.displayPhase !== "unresolved"
              : !stateAvailable && run.status !== "reconciling_external_result"
          ) ? (
            <span className={`run-indicator run-${run.status}`} />
          ) : null}
          <output>
            <strong>
              {activeSummary
                ? message("step.active", { step: message(activeSummary.id) })
                : message(stateLabel ?? activity.label, { tool: activity.tool })}
            </strong>
          </output>
          {waitReason ? (
            <p className="turn-wait-reason">{message(waitReason.id, { tool: waitReason.tool })}</p>
          ) : null}
          {state && connection !== "connected" ? (
            <small>{message("chat.disconnected")}</small>
          ) : null}
          {measuredTime !== null ? (
            <span>{message(measuredTimeLabel, { time: duration(measuredTime) })}</span>
          ) : null}
          <small>{message("chat.lastActivity", { time: duration(observationAge) })}</small>
          {stale ? <p>{message("chat.progressDelayed")}</p> : null}
        </div>
      ) : null}
      {run.status === "failed" ? (
        <p role="alert">{message(executionFailureMessage(records))}</p>
      ) : null}
      {nextAction ? <output className="execution-next-action">{message(nextAction)}</output> : null}
      <details
        className="turn-process"
        open={expanded}
        onToggle={(event) => {
          if (event.currentTarget.open !== expanded) setExpandedChoice(event.currentTarget.open);
        }}
      >
        <summary>
          {timeline ? (
            <span className="process-took">{processHeadline(timeline, items, message)}</span>
          ) : null}
          <span
            className={`process-result run-text-${state?.displayPhase ?? run.status}${
              timeline && (state?.displayPhase ?? run.status) === "completed" ? " is-quiet" : ""
            }`}
          >
            {message(stateLabel ?? statusId(run))}
          </span>
          <RowChevron />
        </summary>
        <ol className="execution-chain" aria-label={message("chat.process")}>
          {rows.map((row) => {
            if (row.type === "review")
              return (
                <li className="execution-stage authorization-review" key={row.review.id}>
                  <span className="row-icon">
                    <ToolIcon name="" glyph="review" />
                  </span>
                  <span>{message(row.review.label)}</span>
                  {row.review.elapsed === null ? null : (
                    <span className="step-status" title={message("review.authorizationTiming")}>
                      {duration(row.review.elapsed)}
                    </span>
                  )}
                </li>
              );
            if (row.type === "note")
              return (
                <li className="execution-stage execution-note" key={row.note.itemId}>
                  <span className="row-icon">
                    <ToolIcon name="" glyph="note" />
                  </span>
                  <span>{row.note.text}</span>
                </li>
              );
            if (row.type === "thinking")
              return (
                <li className="execution-stage" key={row.stage.id}>
                  <span className="row-icon">
                    <ToolIcon name="" glyph="thinking" />
                  </span>
                  <span>
                    {row.stage.elapsed === null
                      ? message("step.thinking")
                      : message("step.thinkingFor", { time: duration(row.stage.elapsed) })}
                  </span>
                </li>
              );
            const step = row.step;
            const item = row.item;
            if (step && !item) {
              const memory = step.kind === "memory" || step.kind === "context";
              const detailRecord = memory ? records.find((record) => record.id === step.id) : null;
              const quote =
                step.kind === "think" && step.itemId
                  ? items.find(
                      (candidate) =>
                        candidate.itemId === step.itemId &&
                        candidate.kind === "message" &&
                        isNarration(candidate, items),
                    )?.text
                  : undefined;
              const head = (
                <>
                  <span className="row-icon">
                    <ToolIcon name="" glyph={stepGlyphs[step.kind]} />
                  </span>
                  <span className="row-main">
                    <span className="step-summary">{stepLabel(step)}</span>
                    {step.kind === "write" && step.characters !== undefined ? (
                      <span className="step-preview">
                        {message("process.characters", { count: step.characters })}
                      </span>
                    ) : null}
                  </span>
                  <TimelineBar step={step} total={timeline?.total ?? 0} />
                  <span className="row-duration">{timelineDuration(step.end - step.start)}</span>
                </>
              );
              return (
                <li
                  key={step.id}
                  className={`execution-step timeline-row${step.running ? " is-running" : ""}`}
                >
                  {detailRecord?.output ? (
                    <details className="timeline-record memory-record">
                      <summary>
                        {head}
                        <RowChevron />
                      </summary>
                      <div className="step-detail">
                        <pre>{detailRecord.output}</pre>
                      </div>
                    </details>
                  ) : (
                    <div className="timeline-record is-static">
                      {head}
                      <span className="row-chevron" />
                    </div>
                  )}
                  {quote?.trim() ? (
                    <p className="row-quote">
                      <q>{quote.trim()}</q>
                    </p>
                  ) : null}
                </li>
              );
            }
            if (!item) return null;
            const operation = state?.operations.find(
              (operation) => operation.itemId === item.itemId,
            );
            const incomplete = ["started", "updated"].includes(item.phase);
            const phase: MessageId = endedAwaitingApproval(item, records, run)
              ? "chat.phase.expiredAwaitingApproval"
              : run.status === "awaiting_approval" && incomplete
                ? "runs.status.awaitingApproval"
                : !isTerminalRun(run) &&
                    item.kind === "tool" &&
                    item.phase === "updated" &&
                    operation?.reasonCode === "TOOL_START_UNCONFIRMED"
                  ? "chat.phase.queued"
                  : ((operation
                      ? executionStateLabel(operation.displayPhase, operation.reasonCode)
                      : stateAvailable
                        ? "chat.recordUnavailable"
                        : undefined) ??
                    executionToolPhase(item, records, run) ??
                    (isTerminalRun(run) && incomplete
                      ? run.status === "cancelled" && item.kind === "message"
                        ? "chat.phase.stopped"
                        : "chat.recordUnavailable"
                      : item.kind === "tool" && item.phase === "updated"
                        ? "chat.callRequested"
                        : (`chat.phase.${item.phase}` as MessageId)));
            const summary = toolStepSummary(item.name, item.input);
            const effect = state?.effectSummary.find((effect) => effect.itemId === item.itemId);
            const retainedEffect: MessageId | undefined = operation?.reasonCode.startsWith(
              "RESOURCE_",
            )
              ? effect?.outcome === "succeeded"
                ? "chat.phase.completed"
                : effect?.outcome === "failed"
                  ? (executionToolPhase(item, records, run) ?? "chat.phase.failed")
                  : undefined
              : undefined;
            const elapsed = step
              ? null
              : operation
                ? operation.executionMilliseconds
                : recordedInterval(records, item.itemId, "runtime.tool_execution");
            const status = (
              <span className="step-status" title={message("review.workerTiming")}>
                {retainedEffect ? `${message(retainedEffect)} · ` : ""}
                {message(phase)}
                {elapsed !== null ? ` · ${duration(elapsed)}` : ""}
              </span>
            );
            return (
              <li
                key={item.itemId}
                className={`execution-step timeline-row tool-${operation?.displayPhase ?? item.phase}${
                  step?.running ? " is-running" : ""
                }`}
              >
                <details className="tool-record">
                  <summary>
                    <span className="row-icon">
                      <ToolIcon name={item.name} />
                    </span>
                    <span className="row-main">
                      <span className="step-summary">
                        {item.kind === "tool" ? message(summary.id) : message("chat.responseText")}
                      </span>
                      {item.kind === "tool" && summary.target ? (
                        <span className="step-preview">{summary.target}</span>
                      ) : null}
                      {step?.parallel ? (
                        <span className="row-tag">{message("process.parallel")}</span>
                      ) : null}
                      {step && phase === "chat.phase.completed" && !retainedEffect ? null : status}
                    </span>
                    {step ? <TimelineBar step={step} total={timeline?.total ?? 0} /> : null}
                    {step ? (
                      <span className="row-duration">
                        {timelineDuration(step.end - step.start)}
                      </span>
                    ) : null}
                    <RowChevron />
                  </summary>
                  <div className="step-detail">
                    {step && phase === "chat.phase.completed" && !retainedEffect ? status : null}
                    {item.kind === "tool" ? (
                      <>
                        <p className="step-tool">
                          <span className="step-name">{item.name}</span>
                        </p>
                        <ol className="call-lifecycle" aria-label={message("chat.callLifecycle")}>
                          {item.requestedAt ? (
                            <li>
                              {message("chat.callRequested")}
                              <RecordedTime at={item.requestedAt} />
                            </li>
                          ) : null}
                          {item.startedAt ? (
                            <li>
                              {message("chat.callProcessing")}
                              <RecordedTime at={item.startedAt} />
                            </li>
                          ) : null}
                          {item.endedAt ? (
                            <li>
                              {message(
                                item.phase === "failed" ? "chat.callFailed" : "chat.callReturned",
                              )}
                              <RecordedTime at={item.endedAt} />
                            </li>
                          ) : null}
                        </ol>
                        {item.text ? <p className="tool-description">{item.text}</p> : null}
                        <h4>{message("chat.requestArguments")}</h4>
                        <pre>{item.input || message("chat.argumentsUnavailable")}</pre>
                        <h4>{message("chat.toolResult")}</h4>
                        {item.output ? (
                          <>
                            <pre>{item.output}</pre>
                            {onPreview ? (
                              <ActionButton
                                variant="quiet"
                                onClick={() => onPreview({ title: item.name, text: item.output })}
                              >
                                {message("review.preview")}
                              </ActionButton>
                            ) : null}
                          </>
                        ) : (
                          <p className="step-empty">
                            {message(
                              incomplete && !isTerminalRun(run)
                                ? "chat.waitingToolResult"
                                : "chat.resultUnavailable",
                            )}
                          </p>
                        )}
                      </>
                    ) : (
                      <>
                        {item.startedAt ? <RecordedTime at={item.startedAt} /> : null}
                        {item.text ? (
                          <AssistantMarkdown text={item.text} />
                        ) : (
                          <p>{message("chat.responseUnavailable")}</p>
                        )}
                      </>
                    )}
                  </div>
                </details>
              </li>
            );
          })}
        </ol>
        {!rows.length ? <p>{message("chat.noProcess")}</p> : null}
        {records.some((item) => item.phase === "unavailable") ? (
          <output>{message("chat.recordUnavailable")}</output>
        ) : null}
        {activityEnded ? <TokenLine usage={turnUsage(records)} message={message} /> : null}
      </details>
    </>
  );
}

type ExecutionItem = ReturnType<typeof executionItems>[number];
type ProcessRow =
  | { type: "step"; sequence: number; step?: TimelineStep; item?: ExecutionItem | undefined }
  | {
      type: "review";
      sequence: number;
      review: ReturnType<typeof authorizationReviewSteps>[number];
    }
  | { type: "note"; sequence: number; note: ExecutionItem }
  | { type: "thinking"; sequence: number; stage: ReturnType<typeof thinkingSteps>[number] };

const stepGlyphs: Readonly<Record<TimelineStep["kind"], ToolGlyph>> = {
  memory: "memory",
  context: "memory",
  think: "thinking",
  write: "answer",
  you: "you",
  tool: "unknown",
};
const stepLabels: Readonly<Record<Exclude<TimelineStep["kind"], "tool">, MessageId>> = {
  memory: "step.memoryFound",
  context: "step.memoryProfile",
  think: "step.thinking",
  write: "process.step.write",
  you: "process.step.you",
};
const didOrder = ["search", "fetch", "command", "read", "change", "recall", "other"] as const;
type DidKind = (typeof didOrder)[number];
const didLabels: Readonly<Record<DidKind, MessageId>> = {
  search: "process.did.search",
  fetch: "process.did.fetch",
  command: "process.did.command",
  read: "process.did.read",
  change: "process.did.change",
  recall: "process.did.recall",
  other: "process.did.other",
};
const didKinds: Readonly<Partial<Record<MessageId, DidKind>>> = {
  "step.search": "search",
  "step.fetch": "fetch",
  "step.command": "command",
  "step.read": "read",
  "step.write": "change",
  "step.edit": "change",
  "step.recall": "recall",
};
const percent = (part: number, whole: number) =>
  `${whole > 0 ? Math.min(100, Math.max(0, (part / whole) * 100)) : 0}%`;

function processRows(
  records: readonly ThreadExecutionRecord[],
  items: readonly ExecutionItem[],
  timeline: ExecutionTimeline | null,
): ProcessRow[] {
  const tools = items.filter((item) => item.kind === "tool");
  const reviews = authorizationReviewSteps(records).map(
    (review): ProcessRow => ({ type: "review", sequence: review.sequence, review }),
  );
  if (!timeline)
    return [
      ...tools.map((item): ProcessRow => ({ type: "step", sequence: item.firstSequence, item })),
      ...items
        .filter((item) => isNarration(item, items) && item.text.trim())
        .map((note): ProcessRow => ({ type: "note", sequence: note.firstSequence, note })),
      ...thinkingSteps(records).map(
        (stage): ProcessRow => ({ type: "thinking", sequence: stage.sequence, stage }),
      ),
      ...reviews,
    ].sort((a, b) => a.sequence - b.sequence);
  const timed = new Set(
    timeline.steps.flatMap((step) => (step.kind === "tool" && step.itemId ? [step.itemId] : [])),
  );
  return [
    ...timeline.steps.map(
      (step): ProcessRow => ({
        type: "step",
        sequence: step.sequence,
        step,
        ...(step.kind === "tool"
          ? { item: tools.find((item) => item.itemId === step.itemId) }
          : {}),
      }),
    ),
    ...tools
      .filter((item) => !timed.has(item.itemId))
      .map((item): ProcessRow => ({ type: "step", sequence: item.firstSequence, item })),
    ...reviews,
  ].sort((a, b) => a.sequence - b.sequence);
}

function processHeadline(
  timeline: ExecutionTimeline,
  items: readonly ExecutionItem[],
  message: Message,
): string {
  const counts = new Map<DidKind, number>();
  for (const step of timeline.steps) {
    if (step.kind !== "tool") continue;
    const tool = items.find((item) => item.itemId === step.itemId);
    const kind = (tool && didKinds[toolStepSummary(tool.name, tool.input).id]) ?? "other";
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const time = timelineDuration(timeline.total);
  const [first, second] = [...counts]
    .sort((a, b) => b[1] - a[1] || didOrder.indexOf(a[0]) - didOrder.indexOf(b[0]))
    .map(([kind, count]) => message(didLabels[kind], { count }));
  if (!first) return message("process.took", { time });
  const actions = second ? message("process.didBoth", { first, second }) : first;
  return message("process.headline", { actions, time });
}

function RowChevron() {
  return (
    <svg className="row-chevron" viewBox="0 0 24 24" aria-hidden="true">
      <path d="m9.5 6 6 6-6 6" />
    </svg>
  );
}

function TimelineBar({ step, total }: { step: TimelineStep; total: number }) {
  const length = step.end - step.start;
  const segments = step.segments.length
    ? step.segments
    : [{ kind: "run" as const, start: step.start, end: step.end }];
  return (
    <span className="timeline-track" aria-hidden="true">
      <span
        className={`timeline-bar category-${step.category}`}
        style={{ left: percent(step.start, total), width: percent(length, total) }}
      >
        {segments.map((segment) => (
          <i
            key={`${segment.kind}-${segment.start}`}
            className={`segment-${segment.kind}`}
            style={{ width: percent(segment.end - segment.start, length) }}
          />
        ))}
      </span>
    </span>
  );
}

function TokenLine({ usage, message }: { usage: TurnUsage | undefined; message: Message }) {
  if (!usage) return null;
  const hit = usage.input > 0 ? Math.round((usage.cacheRead / usage.input) * 100) : 0;
  return (
    <p className="process-tokens">
      <span>{message("process.tokens")}</span>
      <b>{formatTokens(usage.total)}</b>
      <span aria-hidden="true">·</span>
      <span className="process-cache" title={message("process.cacheHitHint")}>
        {message("process.cacheHit", { percent: hit })}
      </span>
    </p>
  );
}
