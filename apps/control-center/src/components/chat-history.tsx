import type {
  ThreadExecutionRecord,
  ThreadExecutionState,
  ThreadGatewaySnapshot,
} from "@himawari-agent/gateway-contracts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { executionItems, isNarration, isTerminalRun } from "../execution-view.js";
import type { RunSummary } from "../execution-view.js";
import { executionTimeline, timelineDuration } from "../execution-timeline.js";
import { turnSources, turnUsage } from "../turn-summary.js";
import { AnswerActions, AnswerSources, LineIcon, useCopied } from "./answer-footer.js";
import type { ContentPreviewValue } from "./content-preview.js";
import { ExecutionProcess } from "./execution-process.js";
import type { MessageId } from "../i18n/message-ids.js";
import { AssistantMarkdown } from "./assistant-markdown.js";
import { HimawariBrand } from "./brand.js";
import { ActionButton } from "./primitives.js";

type Detail = Extract<ThreadGatewaySnapshot, { type: "thread.detail_snapshot" }>;
type Message = (id: MessageId, values?: Record<string, string | number | boolean | Date>) => string;
export function ChatHistory({
  detail,
  contentByRef,
  execution,
  executionStates,
  executionStateAvailable,
  connection,
  message,
  onFork,
  onCleanup,
  onPreview,
  renderApproval,
  renderMemory,
}: {
  readonly detail: Detail;
  readonly contentByRef: Readonly<Record<string, string>>;
  readonly execution: Readonly<Record<string, readonly ThreadExecutionRecord[]>>;
  readonly executionStates?: Readonly<Record<string, ThreadExecutionState>> | undefined;
  readonly executionStateAvailable?: boolean | undefined;
  readonly connection: string;
  readonly message: Message;
  readonly renderApproval: (runId: string, records: readonly ThreadExecutionRecord[]) => ReactNode;
  readonly renderMemory?: ((ownerRefs: readonly string[]) => ReactNode) | undefined;
  readonly onPreview?: ((preview: ContentPreviewValue) => void) | undefined;
  readonly onCleanup?: ((run: RunSummary) => void) | undefined;
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
        {[...groups].map(([key, group]) => {
          const records = group.run ? (execution[group.run.runId] ?? []) : [];
          const actualModel = records.findLast(
            (item) => item.kind === "message" && item.name,
          )?.name;
          const agentMessages = group.messages.filter((item) => item.role === "agent");
          const items = executionItems(records);
          const partialItem = items
            .filter((item) => item.kind === "message" && !isNarration(item, items))
            .at(-1);
          const partial = partialItem?.text;
          return (
            <div className="chat-turn" key={key}>
              {group.messages
                .filter((item) => item.role !== "agent")
                .map((item) =>
                  item.role === "owner" ? (
                    <div className="owner-turn" key={item.messageId}>
                      <article className="thread-message thread-message-owner">
                        <pre className="thread-message-content">
                          {contentByRef[item.contentRef] ?? "…"}
                        </pre>
                      </article>
                      <OwnerMessageMeta
                        text={contentByRef[item.contentRef] ?? ""}
                        committedAt={item.committedAt}
                        received={records.some(
                          (record) => record.kind === "status" && record.phase === "started",
                        )}
                        message={message}
                      />
                    </div>
                  ) : (
                    <article
                      key={item.messageId}
                      className={`thread-message thread-message-${item.role}`}
                    >
                      <pre className="thread-message-content">
                        {contentByRef[item.contentRef] ?? "…"}
                      </pre>
                    </article>
                  ),
                )}
              {group.run || agentMessages.length ? (
                <article className="thread-message thread-message-agent">
                  <header>
                    <HimawariBrand busy={!!group.run && !isTerminalRun(group.run)} />
                    <strong>Himawari</strong>
                  </header>
                  {group.run ? (
                    <ExecutionProcess
                      onPreview={onPreview}
                      run={group.run}
                      records={records}
                      state={executionStates?.[group.run.runId]}
                      stateAvailable={executionStateAvailable}
                      connection={connection}
                      message={message}
                    />
                  ) : (
                    <p>{message("chat.noProcess")}</p>
                  )}
                  {group.run?.status === "awaiting_approval"
                    ? renderApproval(group.run.runId, records)
                    : null}
                  {agentMessages.length ? (
                    agentMessages.map((item) => (
                      <AssistantMarkdown
                        key={item.messageId}
                        text={contentByRef[item.contentRef] ?? (partial || "…")}
                      />
                    ))
                  ) : partial ? (
                    <>
                      <p className="partial-status">
                        {message(
                          partialItem?.phase === "completed" &&
                            group.run &&
                            isTerminalRun(group.run)
                            ? "chat.phase.completed"
                            : group.run?.status === "cancelled"
                              ? "chat.phase.stopped"
                              : group.run && isTerminalRun(group.run)
                                ? "chat.recordUnavailable"
                                : "chat.phase.updated",
                        )}
                      </p>
                      <AssistantMarkdown text={partial} />
                    </>
                  ) : null}
                  {agentMessages.length && (!group.run || isTerminalRun(group.run)) ? (
                    <AnswerActions
                      text={agentMessages
                        .map((item) => contentByRef[item.contentRef] ?? "")
                        .join("\n\n")}
                      model={actualModel}
                      duration={(() => {
                        if (!group.run) return undefined;
                        const total = executionTimeline(
                          records,
                          group.run,
                          Date.parse(group.run.updatedAt),
                        )?.total;
                        return total === undefined ? undefined : timelineDuration(total);
                      })()}
                      committedAt={agentMessages.at(-1)?.committedAt}
                      usage={turnUsage(records)}
                      onFork={(() => {
                        const last = agentMessages.findLast((item) => item.turnId);
                        return last
                          ? () => onFork(last.turnId as string, last.sequence)
                          : undefined;
                      })()}
                      message={message}
                    />
                  ) : null}
                  <AnswerSources sources={turnSources(records)} message={message} />
                  {renderMemory?.(
                    group.messages
                      .filter((item) => item.role === "owner")
                      .map((item) => item.contentRef),
                  )}
                  <div className="message-actions">
                    {onCleanup &&
                    group.run &&
                    (executionStateAvailable
                      ? executionStates?.[group.run.runId]?.availableActions.includes(
                          "retry_cleanup",
                        )
                      : ["failed", "cancelled"].includes(group.run.status)) ? (
                      <ActionButton
                        variant="quiet"
                        onClick={() => group.run && onCleanup(group.run)}
                      >
                        {message("chat.retryCleanup")}
                      </ActionButton>
                    ) : null}
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

function OwnerMessageMeta({
  text,
  committedAt,
  received,
  message,
}: {
  readonly text: string;
  readonly committedAt: string;
  readonly received: boolean;
  readonly message: Message;
}) {
  const [copied, copy] = useCopied();
  const status = message(received ? "message.status.received" : "message.status.sent");
  return (
    <div className="owner-meta">
      <button
        type="button"
        className="owner-copy"
        aria-label={message("message.copy")}
        title={message("message.copy")}
        onClick={() => copy(text)}
      >
        <LineIcon name={copied ? "check" : "copy"} />
      </button>
      <span>{message("answer.at", { at: new Date(committedAt) })}</span>
      <span className="owner-status" role="img" aria-label={status} title={status}>
        <svg
          className={`owner-tick ${received ? "is-received" : "is-sent"}`}
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            d={received ? "M1.5 12.5l4.5 4.5L15.5 7.5M10 16l1 1 9.5-9.5" : "M5 12.5l4.5 4.5L19 7.5"}
          />
        </svg>
      </span>
    </div>
  );
}
