import type {
  ThreadExecutionRecord,
  ThreadGatewaySnapshot,
} from "@himawari-agent/gateway-contracts";
import { useEffect, useRef, useState } from "react";
import {
  duration,
  executionFailureMessage,
  executionItems,
  executionItemWorkTime,
  executionTime,
  isTerminalRun,
  type RunSummary,
} from "../execution-view.js";
import type { MessageId } from "../i18n/message-ids.js";
import { HimawariBrand } from "./brand.js";
import { ActionButton } from "./primitives.js";

type Detail = Extract<ThreadGatewaySnapshot, { type: "thread.detail_snapshot" }>;
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
function TurnProcess({
  run,
  records,
  message,
  connection,
}: {
  run: RunSummary;
  records: readonly ThreadExecutionRecord[];
  message: Message;
  connection: string;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (isTerminalRun(run) || connection !== "connected") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [run, connection]);
  const items = executionItems(records);
  const time = executionTime(records, run, now);
  const current = items.findLast((item) => item.kind === "tool" && item.phase === "started");
  return (
    <details className="turn-process">
      <summary>
        <span className={`run-indicator run-${run.status}`} />
        {message("chat.process")} · {message(statusId(run))}
        {current && !isTerminalRun(run) ? ` · ${current.name}` : ""}
        <span className="process-time">{time.known ? duration(time.work) : ""}</span>
      </summary>
      <div className="turn-process-body">
        {run.status === "failed" ? (
          <output>{message(executionFailureMessage(records))}</output>
        ) : null}
        <p>{message("chat.noThinking")}</p>
        {time.known ? (
          <p className="process-timing">
            {message("chat.workTime", { time: duration(time.work) })} ·{" "}
            {message("chat.waitTime", { time: duration(time.wait) })}
            {connection !== "connected" && !isTerminalRun(run)
              ? ` · ${message("chat.disconnected")}`
              : ""}
          </p>
        ) : (
          <p>{message("chat.unknownTime")}</p>
        )}
        {records
          .filter(
            (item) =>
              item.kind === "status" &&
              item.phase === "started" &&
              item.name !== "runtime.model_started",
          )
          .slice(-1)
          .map((item) => (
            <p key={item.id}>
              {message("chat.actualModel")}: {item.name} {item.text}
            </p>
          ))}
        {!items.length ? (
          <p>{message("chat.noProcess")}</p>
        ) : (
          items.map((item) => (
            <details key={item.itemId} className={`tool-record tool-${item.phase}`}>
              <summary>
                {item.kind === "tool" ? item.name : message("chat.output")} ·{" "}
                {message(
                  isTerminalRun(run) && item.phase === "started"
                    ? "chat.recordUnavailable"
                    : (`chat.phase.${item.phase}` as MessageId),
                )}{" "}
                {item.endedAt && item.startedAt
                  ? duration(executionItemWorkTime(item, records) ?? 0)
                  : ""}
              </summary>
              {item.startedAt ? (
                <time dateTime={item.startedAt}>{new Date(item.startedAt).toLocaleString()}</time>
              ) : (
                <p>{message("chat.unknownTime")}</p>
              )}
              {item.kind === "tool" ? (
                <>
                  {item.text ? <p>{item.text}</p> : null}
                  <h4>{message("chat.input")}</h4>
                  <pre>{item.input || message("chat.notProvided")}</pre>
                  <h4>{message("chat.output")}</h4>
                  <pre>{item.output || message("chat.notProvided")}</pre>
                </>
              ) : (
                <pre>{item.text || message("chat.notProvided")}</pre>
              )}
            </details>
          ))
        )}
        {records.some((item) => item.phase === "unavailable") ? (
          <output>{message("chat.recordUnavailable")}</output>
        ) : null}
      </div>
    </details>
  );
}
export function ChatHistory({
  detail,
  contentByRef,
  execution,
  connection,
  message,
  onFork,
  onApproval,
}: {
  readonly detail: Detail;
  readonly contentByRef: Readonly<Record<string, string>>;
  readonly execution: Readonly<Record<string, readonly ThreadExecutionRecord[]>>;
  readonly connection: string;
  readonly message: Message;
  readonly onApproval: (runId: string) => void;
  readonly onFork: (turnId: string, sequence: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  useEffect(() => {
    void contentByRef;
    void execution;
    if (following.current && scrollRef.current)
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [contentByRef, execution]);
  const groups = new Map<
    string,
    { messages: Detail["payload"]["messages"][number][]; run: RunSummary | undefined }
  >();
  for (const item of detail.payload.messages) {
    const key = item.runId ?? item.turnId ?? item.messageId;
    const group = groups.get(key) ?? {
      messages: [],
      run: detail.payload.runs.find((run) => run.runId === item.runId),
    };
    group.messages.push(item);
    groups.set(key, group);
  }
  for (const run of detail.payload.runs)
    if (![...groups.values()].some((group) => group.run?.runId === run.runId))
      groups.set(run.runId, { messages: [], run });
  return (
    <>
      <section
        className="chat-scroll"
        ref={scrollRef}
        aria-label={message("threads.messages")}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable history must support keyboard scrolling.
        tabIndex={0}
        onScroll={() => {
          const el = scrollRef.current;
          if (!el) return;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
          setShowLatest(!following.current);
        }}
      >
        {!groups.size ? <p className="chat-empty">{message("threads.messagesEmpty")}</p> : null}
        {[...groups].map(([key, group], index) => {
          const records = group.run ? (execution[group.run.runId] ?? []) : [];
          const agentMessages = group.messages.filter((item) => item.role === "agent");
          const partial = executionItems(records)
            .filter((item) => item.kind === "message")
            .at(-1)?.text;
          return (
            <div className="chat-turn" key={key}>
              {group.messages
                .filter((item) => item.role !== "agent")
                .map((item) => (
                  <article
                    key={item.messageId}
                    className={`thread-message thread-message-${item.role}`}
                  >
                    <pre className="thread-message-content">
                      {contentByRef[item.contentRef] ?? "…"}
                    </pre>
                  </article>
                ))}
              {group.run || agentMessages.length ? (
                <article className="thread-message thread-message-agent">
                  <header>
                    <HimawariBrand />
                    <strong>Himawari</strong>
                    <span>{message("chat.turn", { number: index + 1 })}</span>
                  </header>
                  {group.run ? (
                    <TurnProcess
                      run={group.run}
                      records={records}
                      connection={connection}
                      message={message}
                    />
                  ) : (
                    <p>{message("chat.noProcess")}</p>
                  )}
                  {group.run?.status === "awaiting_approval" ? (
                    <div className="approval-inline">
                      <span>{message("runs.status.awaitingApproval")}</span>
                      <ActionButton
                        variant="secondary"
                        onClick={() => {
                          if (group.run) onApproval(group.run.runId);
                        }}
                      >
                        {message("nav.approvals")}
                      </ActionButton>
                    </div>
                  ) : null}
                  {agentMessages.length ? (
                    agentMessages.map((item) => (
                      <pre key={item.messageId} className="thread-message-content">
                        {contentByRef[item.contentRef] ?? "…"}
                      </pre>
                    ))
                  ) : partial ? (
                    <pre className="thread-message-content">{partial}</pre>
                  ) : null}
                  <div className="message-actions">
                    {agentMessages.map((item) =>
                      item.turnId ? (
                        <ActionButton
                          key={item.messageId}
                          onClick={() => onFork(item.turnId as string, item.sequence)}
                          variant="quiet"
                        >
                          {message("threads.fork")}
                        </ActionButton>
                      ) : null,
                    )}
                  </div>
                </article>
              ) : null}
            </div>
          );
        })}
      </section>
      {showLatest ? (
        <ActionButton
          className="chat-latest"
          variant="secondary"
          onClick={() => {
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
            following.current = true;
            setShowLatest(false);
          }}
        >
          ↓ {message("chat.latest")}
        </ActionButton>
      ) : null}
    </>
  );
}
