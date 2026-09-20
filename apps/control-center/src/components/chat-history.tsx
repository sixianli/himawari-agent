import type {
  ThreadExecutionRecord,
  ThreadExecutionState,
  ThreadGatewaySnapshot,
} from "@himawari-agent/gateway-contracts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { executionItems, isTerminalRun } from "../execution-view.js";
import type { RunSummary } from "../execution-view.js";
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
}: {
  readonly detail: Detail;
  readonly contentByRef: Readonly<Record<string, string>>;
  readonly execution: Readonly<Record<string, readonly ThreadExecutionRecord[]>>;
  readonly executionStates?: Readonly<Record<string, ThreadExecutionState>> | undefined;
  readonly executionStateAvailable?: boolean | undefined;
  readonly connection: string;
  readonly message: Message;
  readonly renderApproval: (runId: string, records: readonly ThreadExecutionRecord[]) => ReactNode;
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
        {[...groups].map(([key, group], index) => {
          const records = group.run ? (execution[group.run.runId] ?? []) : [];
          const actualModel = records.findLast(
            (item) => item.kind === "message" && item.name,
          )?.name;
          const agentMessages = group.messages.filter((item) => item.role === "agent");
          const partialItem = executionItems(records)
            .filter((item) => item.kind === "message")
            .at(-1);
          const partial = partialItem?.text;
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
                    {actualModel ? <span className="turn-model">{actualModel}</span> : null}
                    <span className="turn-number">
                      {message("chat.turn", { number: index + 1 })}
                    </span>
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
                        text={contentByRef[item.contentRef] ?? "…"}
                      />
                    ))
                  ) : partial ? (
                    <>
                      <p className="partial-status">
                        {message(
                          partialItem?.phase === "completed"
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
