import type {
  ThreadExecutionRecord,
  ThreadExecutionState,
} from "@himawari-agent/gateway-contracts";
import { useEffect, useState } from "react";
import {
  type ExecutionTimeline,
  executionTimeline,
  type TimelineStep,
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
import { exitCodeOf, toolCommand, toolStepSummary } from "../step-summary.js";
import { formatTokens, type TurnUsage, turnUsage, webStepSites } from "../turn-summary.js";
import { AssistantMarkdown } from "./assistant-markdown.js";
import type { ContentPreviewValue } from "./content-preview.js";
import { Glyph } from "./glyphs.js";
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
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activityEnded, connection]);
  const items = executionItems(records);
  const timeline = executionTimeline(records, run, now);
  const rows = groupWebRows(processRows(records, items, timeline));
  const expanded = expandedChoice ?? false;
  const stepLabel = (step: TimelineStep) => {
    if (step.kind === "tool") {
      const tool = items.find((item) => item.itemId === step.itemId);
      return message(tool ? toolStepSummary(tool.name, tool.input).id : "step.other");
    }
    return message(stepLabels[step.kind]);
  };
  const activity = executionActivity(records, run, connection, now);
  const reviewing =
    !activityEnded &&
    (state
      ? state.displayPhase === "reviewing"
      : activity.label === "review.authorizationChecking");
  const lastStartedReview = reviewing
    ? rows.findLast((row) => row.type === "review" && row.review.outcome === "started")
    : undefined;
  const runningReviewId =
    lastStartedReview?.type === "review" ? lastStartedReview.review.id : undefined;
  const lastOpenThinking = activityEnded
    ? undefined
    : rows.findLast((row) => row.type === "thinking" && row.stage.elapsed === null);
  const runningThinkingId =
    lastOpenThinking?.type === "thinking" ? lastOpenThinking.stage.id : undefined;
  const observationAge = state ? Math.max(0, now - Date.parse(state.lastObservedAt)) : activity.age;
  const stale = stateAvailable
    ? !!state &&
      state.displayPhase !== "unresolved" &&
      state.availableActions.includes("stop") &&
      observationAge >= 15000
    : activity.stale;
  const stateLabel = state
    ? executionStateLabel(state.displayPhase, state.reasonCode)
    : stateAvailable && isTerminalRun(run)
      ? "chat.recordUnavailable"
      : undefined;
  const writing =
    activity.writing && (!state || state.displayPhase.startsWith("model_"))
      ? activity.writing
      : undefined;
  const writingItem = writing && items.find((item) => item.itemId === writing.itemId);
  const writingSummary = writingItem && toolStepSummary(writingItem.name, writingItem.input);
  const nextAction = state ? executionNextAction(state) : undefined;
  const activeTool = items.findLast((item) => item.kind === "tool" && item.phase === "started");
  const activeSummary =
    !stateLabel && activity.label === "chat.activity.tool" && activeTool
      ? toolStepSummary(activeTool.name, activeTool.input)
      : undefined;
  const waitReason = state ? executionWaitReason(state, run, items) : undefined;
  const queuedFor = Math.max(0, now - Date.parse(run.createdAt));
  const queued =
    run.status === "accepted" &&
    records.length === 0 &&
    Number.isFinite(queuedFor) &&
    queuedFor >= QUEUED_DISPLAY_AFTER_MILLISECONDS;
  const runningStep = timeline?.steps.findLast((step) => step.running);
  const runningTool =
    runningStep?.kind === "tool"
      ? items.find((item) => item.itemId === runningStep.itemId)
      : undefined;
  const liveStep =
    run.status === "awaiting_approval"
      ? message("runs.status.awaitingApproval")
      : run.status === "reconciling_external_result"
        ? message(stateLabel ?? "chat.phase.unresolved")
        : runningReviewId
          ? message("review.authorizationChecking")
          : writing && writingSummary
            ? message("chat.activity.writing", {
                step: message(writingSummary.id),
                lines: writing.lines,
              })
            : runningStep
              ? message("step.active", {
                  step: runningTool
                    ? message(
                        liveToolLabel(toolStepSummary(runningTool.name, runningTool.input).id),
                      )
                    : runningStep.kind === "tool"
                      ? message("step.other")
                      : message(stepLabels[runningStep.kind]),
                })
              : activeSummary
                ? message("step.active", { step: message(liveToolLabel(activeSummary.id)) })
                : message(queued ? "chat.queued" : (stateLabel ?? activity.label), {
                    tool: activity.tool,
                  });
  const liveElapsed = timeline ? timeline.total : queuedFor;
  return (
    <>
      {!activityEnded &&
      (queued || (waitReason && !queued) || (state && connection !== "connected") || stale) ? (
        <div className="turn-activity">
          {queued ? <p>{message("chat.queuedWait")}</p> : null}
          {waitReason && !queued ? (
            <p className="turn-wait-reason">{message(waitReason.id, { tool: waitReason.tool })}</p>
          ) : null}
          {state && connection !== "connected" ? (
            <small>{message("chat.disconnected")}</small>
          ) : null}
          {stale && !queued ? <p>{message("chat.progressDelayed")}</p> : null}
        </div>
      ) : null}
      {run.status === "failed" ? (
        <p role="alert">{message(executionFailureMessage(records))}</p>
      ) : null}
      {nextAction ? <output className="execution-next-action">{message(nextAction)}</output> : null}
      {!activityEnded ? <output className="sr-only">{liveStep}</output> : null}
      <details
        className="turn-process"
        open={expanded}
        onToggle={(event) => {
          if (event.currentTarget.open !== expanded) setExpandedChoice(event.currentTarget.open);
        }}
      >
        <summary>
          {!activityEnded ? (
            <span className="process-live">
              <span className="process-live-step">{liveStep}</span>
              <span className="process-live-time">{elapsedText(liveElapsed, message)}</span>
            </span>
          ) : (
            <>
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
            </>
          )}
          <RowChevron />
        </summary>
        <ol className="execution-chain" aria-label={message("chat.process")}>
          {rows.map((row) => {
            if (row.type === "web") {
              const sites = [
                ...new Set(
                  row.items.flatMap((item) => webStepSites(item.name, item.input, item.output)),
                ),
              ];
              const start = Math.min(...row.steps.map((step) => step.start));
              const end = Math.max(...row.steps.map((step) => step.end));
              return (
                <li
                  key={row.steps[0]?.id ?? row.sequence}
                  className={`execution-step timeline-row web-row${
                    row.steps.some((step) => step.running) ? " is-running" : ""
                  }`}
                >
                  <div className="timeline-record is-static">
                    <span className="row-icon">
                      <ToolIcon name="web_search" glyph="web" />
                    </span>
                    <span className="row-main">
                      <span className="step-summary">{message("step.search")}</span>
                      {sites.length ? (
                        <span className="step-preview">
                          {sites.slice(0, 2).join(" · ")}
                          {sites.length > 2 ? ` +${sites.length - 2}` : ""}
                        </span>
                      ) : null}
                    </span>
                    <span className="row-duration">{elapsedText(end - start, message)}</span>
                    <span className="row-chevron" />
                  </div>
                </li>
              );
            }
            if (row.type === "review")
              return (
                <li
                  className={`execution-stage authorization-review${
                    runningReviewId === row.review.id ? " is-running" : ""
                  }`}
                  key={row.review.id}
                >
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
                <li
                  className={`execution-stage${
                    runningThinkingId === row.stage.id ? " is-running" : ""
                  }`}
                  key={row.stage.id}
                >
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
                  <span className="row-duration">
                    {elapsedText(step.end - step.start, message)}
                  </span>
                </>
              );
              return (
                <li
                  key={step.id}
                  className={`execution-step timeline-row${step.running ? " is-running" : ""}`}
                >
                  <div className="timeline-record is-static">
                    {head}
                    <span className="row-chevron" />
                  </div>
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
                : writing?.itemId === item.itemId
                  ? "chat.phase.writing"
                  : !isTerminalRun(run) &&
                      item.kind === "tool" &&
                      item.phase === "updated" &&
                      operation?.reasonCode === "TOOL_START_UNCONFIRMED"
                    ? "chat.phase.queued"
                    : ((operation
                        ? executionStateLabel(operation.displayPhase, operation.reasonCode)
                        : stateAvailable && (state || isTerminalRun(run))
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
            const command = item.kind === "tool" ? toolCommand(item.input) : "";
            const exitCode = item.output ? exitCodeOf(item.output) : null;
            const outcome =
              item.phase === "failed" ||
              (retainedEffect && retainedEffect !== "chat.phase.completed")
                ? "failed"
                : phase === "chat.phase.completed" || retainedEffect === "chat.phase.completed"
                  ? "ok"
                  : "pending";
            const elapsed = step
              ? null
              : operation
                ? operation.executionMilliseconds
                : recordedInterval(records, item.itemId, "runtime.tool_execution");
            const status = (
              <span className="step-status" title={message("review.workerTiming")}>
                {retainedEffect ? `${message(retainedEffect)} · ` : ""}
                {message(phase, { lines: writing?.lines ?? 0 })}
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
                      {step && phase === "chat.phase.completed" && !retainedEffect ? null : status}
                    </span>
                    {step ? (
                      <span className="row-duration">
                        {elapsedText(step.end - step.start, message)}
                      </span>
                    ) : null}
                    <RowChevron />
                  </summary>
                  <div className="step-detail">
                    {item.kind === "tool" ? (
                      <>
                        <div className="step-result">
                          {outcome === "pending" ? null : (
                            <p className={`step-outcome is-${outcome}`}>
                              <Glyph name={outcome === "ok" ? "check" : "close"} size={14} />
                              {outcome === "ok"
                                ? message("step.outcome.ok")
                                : `${message("step.outcome.failed")}${
                                    exitCode !== null
                                      ? ` · ${message("step.outcome.exitCode", { code: exitCode })}`
                                      : ""
                                  }`}
                            </p>
                          )}
                          {item.output && onPreview ? (
                            <button
                              type="button"
                              className="step-link"
                              onClick={() =>
                                onPreview({ title: command || item.name, text: item.output })
                              }
                            >
                              {message("step.viewOutput")}
                            </button>
                          ) : null}
                        </div>
                        <details className="step-technical">
                          <summary>
                            {message(command ? "step.commandDetails" : "step.technical")}
                            <RowChevron />
                          </summary>
                          {command ? <pre className="step-command">{command}</pre> : null}
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
                            <pre>{item.output}</pre>
                          ) : (
                            <p className="step-empty">
                              {message(
                                incomplete && !isTerminalRun(run)
                                  ? "chat.waitingToolResult"
                                  : "chat.resultUnavailable",
                              )}
                            </p>
                          )}
                        </details>
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
  | {
      type: "web";
      sequence: number;
      steps: readonly TimelineStep[];
      items: readonly ExecutionItem[];
    }
  | { type: "thinking"; sequence: number; stage: ReturnType<typeof thinkingSteps>[number] };

const QUEUED_DISPLAY_AFTER_MILLISECONDS = 3000;

const stepGlyphs: Readonly<Record<TimelineStep["kind"], ToolGlyph>> = {
  think: "thinking",
  write: "answer",
  you: "you",
  tool: "unknown",
};
const stepLabels: Readonly<Record<Exclude<TimelineStep["kind"], "tool">, MessageId>> = {
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
const liveLabels: Readonly<Partial<Record<MessageId, MessageId>>> = {
  "step.fetch": "step.search",
};
function liveToolLabel(id: MessageId): MessageId {
  return liveLabels[id] ?? id;
}

export function elapsedText(milliseconds: number, message: Message): string {
  const total = milliseconds > 0 ? Math.max(1, Math.round(milliseconds / 1000)) : 0;
  return total < 60
    ? message("more.duration.seconds", { seconds: total })
    : message("more.duration.minutes", { minutes: Math.floor(total / 60), seconds: total % 60 });
}

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

const WEB_TOOLS = new Set(["web_search", "web_fetch"]);

function groupWebRows(rows: readonly ProcessRow[]): ProcessRow[] {
  const grouped: ProcessRow[] = [];
  for (const row of rows) {
    const web = row.type === "step" && row.step && row.item && WEB_TOOLS.has(row.item.name);
    const last = grouped.at(-1);
    if (web && row.type === "step" && row.step && row.item) {
      if (last?.type === "web") {
        grouped[grouped.length - 1] = {
          ...last,
          steps: [...last.steps, row.step],
          items: [...last.items, row.item],
        };
      } else {
        grouped.push({ type: "web", sequence: row.sequence, steps: [row.step], items: [row.item] });
      }
      continue;
    }
    grouped.push(row);
  }
  return grouped;
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
  const time = elapsedText(timeline.total, message);
  const [first, second] = [...counts]
    .sort((a, b) => b[1] - a[1] || didOrder.indexOf(a[0]) - didOrder.indexOf(b[0]))
    .map(([kind, count]) => message(didLabels[kind], { count }));
  if (!first) return message("process.took", { time });
  const actions = second ? message("process.didBoth", { first, second }) : first;
  return message("process.headline", { actions, time });
}

function RowChevron() {
  return <Glyph className="row-chevron" name="chevron" />;
}

function TokenLine({ usage, message }: { usage: TurnUsage | undefined; message: Message }) {
  if (!usage) return null;
  const hit = usage.input > 0 ? Math.round((usage.cacheRead / usage.input) * 100) : 0;
  return (
    <p className="process-tokens">
      {usage.models.length ? (
        <>
          <span>{message("process.answeredBy")}</span>
          <b>{usage.models.join(" / ")}</b>
          <span aria-hidden="true">·</span>
        </>
      ) : null}
      <span>{message("process.tokens")}</span>
      <b>{formatTokens(usage.total)}</b>
      <span aria-hidden="true">·</span>
      <span className="process-cache" title={message("process.cacheHitHint")}>
        {message("process.cacheHit", { percent: hit })}
      </span>
    </p>
  );
}
