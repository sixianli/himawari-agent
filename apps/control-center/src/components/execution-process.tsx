import type { ContentPreviewValue } from "./content-preview.js";
import { ActionButton } from "./primitives.js";
import { ToolIcon } from "./tool-icon.js";
import type { ThreadExecutionRecord } from "@himawari-agent/gateway-contracts";
import { useEffect, useState } from "react";
import {
  duration,
  executionActivity,
  executionFailureMessage,
  executionItems,
  recordedInterval,
  thinkingSteps,
  executionTime,
  isTerminalRun,
  type RunSummary,
} from "../execution-view.js";
import type { MessageId } from "../i18n/message-ids.js";
import { AssistantMarkdown } from "./assistant-markdown.js";

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
function preview(input: string) {
  try {
    const value = JSON.parse(input);
    for (const key of ["query", "queryText", "search_query", "path", "command", "url"])
      if (typeof value?.[key] === "string") return value[key] as string;
  } catch {
    /* Truncated or legacy input remains available in the detail. */
  }
  return "";
}
function RecordedTime({ at }: { at: string }) {
  return (
    <time dateTime={at} title={new Date(at).toLocaleString()}>
      {new Date(at).toLocaleTimeString()}
    </time>
  );
}
export function ExecutionProcess({
  run,
  records,
  message,
  connection,
  onPreview,
}: {
  onPreview?: ((preview: ContentPreviewValue) => void) | undefined;
  run: RunSummary;
  records: readonly ThreadExecutionRecord[];
  message: Message;
  connection: string;
}) {
  const [now, setNow] = useState(Date.now());
  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    if (isTerminalRun(run) || connection !== "connected") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [run, connection]);
  const items = executionItems(records);
  const thinking = thinkingSteps(records);
  const steps = [
    ...items
      .filter((item) => item.kind === "tool")
      .map((item) => ({ sequence: item.firstSequence, item, stage: null })),
    ...thinking.map((stage) => ({ sequence: stage.sequence, item: null, stage })),
  ].sort((a, b) => a.sequence - b.sequence);
  const time = executionTime(records, run, now);
  const activity = executionActivity(records, run, connection, now);
  return (
    <>
      {!isTerminalRun(run) ? (
        <div className="turn-activity">
          <span className={`run-indicator run-${run.status}`} />
          <output>
            <strong>{message(activity.label, { tool: activity.tool })}</strong>
          </output>
          {time.known ? (
            <span>{message("chat.workTime", { time: duration(time.work) })}</span>
          ) : null}
          <small>{message("chat.lastActivity", { time: duration(activity.age) })}</small>
          {activity.stale ? <p>{message("chat.progressDelayed")}</p> : null}
        </div>
      ) : null}
      {run.status === "failed" ? (
        <p role="alert">{message(executionFailureMessage(records))}</p>
      ) : null}
      <details
        className="turn-process"
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary>
          <span className="process-chevron" aria-hidden="true">
            ›
          </span>
          <span>
            {message("review.thinkingCount", { count: thinking.length })} ·{" "}
            {message("chat.toolCount", {
              count: items.filter((item) => item.kind === "tool").length,
            })}
          </span>
          <span className={`process-result run-text-${run.status}`}>
            {message(statusId(run))}
            {time.known ? ` · ${duration(time.work)}` : ""}
          </span>
        </summary>
        <ol className="execution-chain" aria-label={message("chat.process")}>
          {steps.map(({ item, stage }) => {
            if (stage)
              return (
                <li className="execution-stage" key={stage.id}>
                  <span className="step-marker" aria-hidden="true" />
                  <ToolIcon name="" thinking />
                  <span>{message("review.thinkingObserved")}</span>
                  <span className="step-status" title={message("review.thinkingTiming")}>
                    {stage.elapsed === null ? message("chat.unknownTime") : duration(stage.elapsed)}
                  </span>
                </li>
              );
            if (!item) return null;
            const incomplete = ["started", "updated"].includes(item.phase);
            const phase: MessageId =
              isTerminalRun(run) && incomplete
                ? run.status === "cancelled" && item.kind === "message"
                  ? "chat.phase.stopped"
                  : "chat.recordUnavailable"
                : item.kind === "tool" && item.phase === "updated"
                  ? "chat.callRequested"
                  : (`chat.phase.${item.phase}` as MessageId);
            const elapsed = recordedInterval(records, item.itemId, "runtime.tool_execution");
            const hint = item.kind === "tool" ? item.text || preview(item.input) : item.text;
            return (
              <li key={item.itemId} className={`execution-step tool-${item.phase}`}>
                <span className="step-marker" aria-hidden="true" />
                <details className="tool-record">
                  <summary>
                    <ToolIcon name={item.name} />
                    <span className="step-name">
                      {item.kind === "tool" ? item.name : message("chat.responseText")}
                    </span>
                    {hint ? <span className="step-preview">{hint}</span> : null}
                    <span className="step-status" title={message("review.workerTiming")}>
                      {message(phase)}
                      {` · ${elapsed !== null ? duration(elapsed) : message("chat.unknownTime")}`}
                    </span>
                  </summary>
                  <div className="step-detail">
                    {item.kind === "tool" ? (
                      <>
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
        {!steps.length ? <p>{message("chat.noProcess")}</p> : null}
        {records.some((item) => item.phase === "unavailable") ? (
          <output>{message("chat.recordUnavailable")}</output>
        ) : null}
        {time.known && time.wait > 0 ? (
          <p className="process-wait">{message("chat.waitTime", { time: duration(time.wait) })}</p>
        ) : null}
      </details>
    </>
  );
}
