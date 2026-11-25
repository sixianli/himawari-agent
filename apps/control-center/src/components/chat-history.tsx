import type {
  ThreadExecutionRecord,
  ThreadExecutionState,
  ThreadGatewaySnapshot,
} from "@himawari-agent/gateway-contracts";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { BackgroundCommandView } from "../background-commands.js";
import type { DeliveredFile } from "../delivered-files.js";
import { formatBytes, splitDraft } from "../draft-attachments.js";
import type { RunSummary } from "../execution-view.js";
import { executionItems, isAnsweredRun, isNarration, isTerminalRun } from "../execution-view.js";
import type { MessageId } from "../i18n/message-ids.js";
import { takeMessageFocus } from "../message-focus.js";
import { turnSources } from "../turn-summary.js";
import { AnswerActions, AnswerSources, LineIcon, useCopied } from "./answer-footer.js";
import { AssistantMarkdown } from "./assistant-markdown.js";
import { AttachmentThumb } from "./attachment-thumb.js";
import { HimawariBrand } from "./brand.js";
import type { ContentPreviewValue } from "./content-preview.js";
import { DeliveredFileCards } from "./delivered-file.js";
import { ExecutionProcess } from "./execution-process.js";
import { Glyph } from "./glyphs.js";
import { BackgroundCommandLine, BackgroundReportLine } from "./more-panel.js";
import { ActionButton } from "./primitives.js";

type Detail = Extract<ThreadGatewaySnapshot, { type: "thread.detail_snapshot" }>;
export interface OutgoingMessage {
  readonly key: string;
  readonly content: string;
  readonly failed: boolean;
}
type Message = (id: MessageId, values?: Record<string, string | number | boolean | Date>) => string;
export interface LiveAnswerText {
  readonly itemId: string;
  readonly text: string;
}

function livePartial(
  run: RunSummary,
  items: ReturnType<typeof executionItems>,
  partialItem: ReturnType<typeof executionItems>[number] | undefined,
  live: LiveAnswerText | undefined,
): string | undefined {
  const recorded = partialItem?.text;
  if (!live || isTerminalRun(run)) return recorded;
  const known = items.find((item) => item.itemId === live.itemId);
  if (known && (known !== partialItem || isNarration(known, items))) return recorded;
  return live.text.length > (recorded?.length ?? 0) ? live.text : recorded;
}

export function ChatHistory({
  detail,
  contentByRef,
  execution,
  liveTexts = {},
  executionStates,
  executionStateAvailable,
  connection,
  message,
  onCleanup,
  backgroundCommands = [],
  stoppingRunIds = [],
  onOpenCommand,
  onPreview,
  onOpenFile,
  onMoreFiles,
  filesByRun = {},
  previewKey,
  readImage,
  renderApproval,
  renderMemory,
  renderToolCard,
  outgoing,
  onRetry,
  inherited,
}: {
  readonly detail: Detail | undefined;
  readonly inherited?: InheritedConversation | undefined;
  readonly outgoing?: OutgoingMessage | null | undefined;
  readonly onRetry?: (() => void) | undefined;
  readonly contentByRef: Readonly<Record<string, string>>;
  readonly execution: Readonly<Record<string, readonly ThreadExecutionRecord[]>>;
  readonly liveTexts?: Readonly<Record<string, LiveAnswerText>> | undefined;
  readonly executionStates?: Readonly<Record<string, ThreadExecutionState>> | undefined;
  readonly executionStateAvailable?: boolean | undefined;
  readonly connection: string;
  readonly message: Message;
  readonly renderApproval: (runId: string, records: readonly ThreadExecutionRecord[]) => ReactNode;
  readonly renderMemory?: ((ownerRefs: readonly string[]) => ReactNode) | undefined;
  readonly renderToolCard?: ((name: string, output: string) => ReactNode) | undefined;
  readonly onPreview?: ((preview: ContentPreviewValue) => void) | undefined;
  readonly onOpenFile?: ((file: DeliveredFile) => void) | undefined;
  readonly onMoreFiles?: (() => void) | undefined;
  readonly filesByRun?: Readonly<Record<string, readonly DeliveredFile[]>> | undefined;
  readonly previewKey?: string | undefined;
  readonly readImage?: ((ref: string) => Promise<string>) | undefined;
  readonly onCleanup?: ((run: RunSummary) => Promise<unknown>) | undefined;
  readonly backgroundCommands?: readonly BackgroundCommandView[] | undefined;
  readonly stoppingRunIds?: readonly string[] | undefined;
  readonly onOpenCommand?: ((key: string | null) => void) | undefined;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  useEffect(() => {
    void contentByRef;
    void execution;
    void liveTexts;
    if (following.current && scrollRef.current)
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [contentByRef, execution, liveTexts]);
  const focusThreadId = detail?.payload.thread.threadId;
  const focusMessages = detail?.payload.messages;
  useEffect(() => {
    void contentByRef;
    if (!focusThreadId || !focusMessages) return;
    const request = takeMessageFocus(focusThreadId);
    if (!request) return;
    const target = [
      ...(scrollRef.current?.querySelectorAll<HTMLElement>("[data-message-id]") ?? []),
    ].find((element) => element.dataset["messageId"] === request.messageId);
    if (!target) return;
    following.current = false;
    setShowLatest(true);
    target.scrollIntoView?.({ block: "center" });
    target.dataset["focused"] = "true";
    window.setTimeout(() => delete target.dataset["focused"], 2600);
  }, [contentByRef, focusThreadId, focusMessages]);
  const outgoingKey = outgoing?.key;
  useEffect(() => {
    if (!outgoingKey || !scrollRef.current) return;
    following.current = true;
    setShowLatest(false);
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [outgoingKey]);
  const messages = detail?.payload.messages ?? [];
  const runs = detail?.payload.runs ?? [];
  const groups = new Map<
    string,
    { messages: Detail["payload"]["messages"][number][]; run: RunSummary | undefined }
  >();
  for (const item of messages) {
    const key = item.runId ?? item.turnId ?? item.messageId;
    const group = groups.get(key) ?? {
      messages: [],
      run: runs.find((run) => run.runId === item.runId),
    };
    group.messages.push(item);
    groups.set(key, group);
  }
  for (const run of runs)
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
        {inherited ? (
          <InheritedHistory
            inherited={inherited}
            contentByRef={contentByRef}
            readImage={readImage}
            message={message}
          />
        ) : null}
        {[...groups].map(([key, group]) => {
          const records = group.run ? (execution[group.run.runId] ?? []) : [];
          const agentMessages = group.messages.filter((item) => item.role === "agent");
          const items = executionItems(records);
          const partialItem = items
            .filter((item) => item.kind === "message" && !isNarration(item, items))
            .at(-1);
          const partial = group.run
            ? livePartial(group.run, items, partialItem, liveTexts[group.run.runId])
            : partialItem?.text;
          return (
            <div className="chat-turn" key={key} data-run-id={group.run?.runId}>
              {group.messages
                .filter((item) => item.role !== "agent")
                .map((item) =>
                  item.role === "owner" ? (
                    <div
                      className="owner-turn"
                      key={item.messageId}
                      data-message-id={item.messageId}
                    >
                      <OwnerMessage content={contentByRef[item.contentRef]} readImage={readImage} />
                      <OwnerMessageMeta
                        text={ownerCopyText(contentByRef[item.contentRef])}
                        committedAt={item.committedAt}
                        received={records.some(
                          (record) => record.kind === "status" && record.phase === "started",
                        )}
                        message={message}
                      />
                    </div>
                  ) : item.role === "system" ? (
                    <BackgroundReportLine
                      key={item.messageId}
                      commands={backgroundCommands.filter(
                        (command) => item.runId && command.noticeRunId === item.runId,
                      )}
                      committedAt={item.committedAt}
                      onOpen={
                        onOpenCommand
                          ? () => {
                              const reported = backgroundCommands.filter(
                                (command) => item.runId && command.noticeRunId === item.runId,
                              );
                              onOpenCommand(
                                reported.length === 1 ? (reported[0]?.key ?? null) : null,
                              );
                            }
                          : undefined
                      }
                      message={message}
                    />
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
                    <HimawariBrand busy={!!group.run && !isAnsweredRun(group.run)} />
                    <strong>Himawari</strong>
                  </header>
                  {group.run ? (
                    <ExecutionProcess
                      onPreview={onPreview}
                      renderToolCard={renderToolCard}
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
                  {backgroundCommands
                    .filter((command) => command.runId === group.run?.runId)
                    .map((command) => (
                      <BackgroundCommandLine
                        key={command.key}
                        command={command}
                        stopping={stoppingRunIds.includes(command.runId)}
                        onOpen={onOpenCommand ? () => onOpenCommand(command.key) : undefined}
                        message={message}
                      />
                    ))}
                  {agentMessages.length && (!group.run || isAnsweredRun(group.run)) ? (
                    <AnswerActions
                      text={agentMessages
                        .map((item) => contentByRef[item.contentRef] ?? "")
                        .join("\n\n")}
                      committedAt={agentMessages.at(-1)?.committedAt}
                      message={message}
                    />
                  ) : null}
                  <AnswerSources sources={turnSources(records)} message={message} />
                  {group.run && onOpenFile ? (
                    <DeliveredFileCards
                      files={(filesByRun[group.run.runId] ?? []).filter(
                        (file) => file.source !== "upload",
                      )}
                      openKey={previewKey}
                      onOpen={onOpenFile}
                      onMore={onMoreFiles}
                      message={message}
                    />
                  ) : null}
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
                      <CleanupButton run={group.run} onCleanup={onCleanup} message={message} />
                    ) : null}
                  </div>
                </article>
              ) : null}
            </div>
          );
        })}
        {outgoing ? (
          <div className="chat-turn chat-turn-outgoing">
            <div className="owner-turn">
              <OwnerMessage content={outgoing.content} readImage={readImage} />
              <OutgoingMessageMeta failed={outgoing.failed} onRetry={onRetry} message={message} />
            </div>
            {outgoing.failed ? null : (
              <article className="thread-message thread-message-agent">
                <header>
                  <HimawariBrand busy />
                  <strong>Himawari</strong>
                </header>
              </article>
            )}
          </div>
        ) : null}
      </section>
      {showLatest ? (
        <button
          type="button"
          className="chat-latest"
          aria-label={message("chat.latest")}
          title={message("chat.latest")}
          onClick={() => {
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
            following.current = true;
            setShowLatest(false);
          }}
        >
          <LineIcon name="arrowDown" />
        </button>
      ) : null}
    </>
  );
}

export interface InheritedConversation {
  readonly title: string;
  readonly messages: Detail["payload"]["messages"];
  readonly available: boolean;
  readonly onOpenSource: () => void;
}

function InheritedHistory({
  inherited,
  contentByRef,
  readImage,
  message,
}: {
  readonly inherited: InheritedConversation;
  readonly contentByRef: Readonly<Record<string, string>>;
  readonly readImage?: ((ref: string) => Promise<string>) | undefined;
  readonly message: Message;
}) {
  const turn = inherited.messages.filter((item) => item.role === "owner").length;
  return (
    <>
      <div className="fork-origin">
        <LineIcon name="fork" />
        <span className="fork-origin-text">
          {inherited.available
            ? message("fork.banner", { title: inherited.title, turn })
            : message("fork.bannerMissing")}
        </span>
        {inherited.available ? (
          <button type="button" className="fork-origin-open" onClick={inherited.onOpenSource}>
            {message("fork.openSource")}
          </button>
        ) : null}
      </div>
      {inherited.messages.length ? (
        <>
          <section className="fork-inherited" aria-label={message("fork.inheritedLabel")}>
            {inherited.messages.map((item) =>
              item.role === "owner" ? (
                <div className="owner-turn" key={item.messageId}>
                  <OwnerMessage content={contentByRef[item.contentRef]} readImage={readImage} />
                </div>
              ) : item.role === "agent" ? (
                <article key={item.messageId} className="thread-message thread-message-agent">
                  <AssistantMarkdown text={contentByRef[item.contentRef] ?? "…"} />
                </article>
              ) : null,
            )}
          </section>
          <p className="fork-divider">{message("fork.divider")}</p>
        </>
      ) : null}
    </>
  );
}

const ownerCopyText = (content: string | undefined) =>
  content === undefined ? "" : splitDraft(content).text || content;

function OwnerMessage({
  content,
  readImage,
}: {
  readonly content: string | undefined;
  readonly readImage?: ((ref: string) => Promise<string>) | undefined;
}) {
  const { text, files } = content === undefined ? { text: "…", files: [] } : splitDraft(content);
  const images = files.filter((file) => file.kind === "image");
  const others = files.filter((file) => file.kind !== "image");
  return (
    <article className="thread-message thread-message-owner">
      {images.length ? (
        <ul className="message-images">
          {images.map((file, index) => (
            <li key={`${index}:${file.ref}`} title={`${file.name} · ${formatBytes(file.bytes)}`}>
              <AttachmentThumb imageRef={file.ref} name={file.name} readImage={readImage} />
            </li>
          ))}
        </ul>
      ) : null}
      {text ? <pre className="thread-message-content">{text}</pre> : null}
      {others.length ? (
        <ul className="message-files">
          {others.map((file, index) => (
            <li key={`${index}:${file.name}`}>
              <LineIcon name="file" />
              <span className="attachment-name">{file.name}</span>
              <small>{formatBytes(file.bytes)}</small>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

function OutgoingMessageMeta({
  failed,
  onRetry,
  message,
}: {
  readonly failed: boolean;
  readonly onRetry?: (() => void) | undefined;
  readonly message: Message;
}) {
  return failed ? (
    <div className="owner-meta owner-meta-failed" role="alert">
      <span>{message("message.status.failed")}</span>
      {onRetry ? (
        <button type="button" className="owner-retry" onClick={onRetry}>
          {message("message.retry")}
        </button>
      ) : null}
    </div>
  ) : (
    <div className="owner-meta">
      <output className="owner-status" aria-label={message("message.status.sending")}>
        <Glyph className="owner-tick is-sending" name="clock" />
        <span>{message("message.status.sending")}</span>
      </output>
    </div>
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
        <Glyph
          className={`owner-tick ${received ? "is-received" : "is-sent"}`}
          name={received ? "checkTwice" : "check"}
        />
      </span>
    </div>
  );
}

function CleanupButton({
  run,
  onCleanup,
  message,
}: {
  readonly run: RunSummary;
  readonly onCleanup: (run: RunSummary) => Promise<unknown>;
  readonly message: (id: MessageId) => string;
}) {
  const [phase, setPhase] = useState<"idle" | "checking" | "checked">("idle");
  return (
    <>
      <ActionButton
        variant="quiet"
        disabled={phase === "checking"}
        onClick={async () => {
          setPhase("checking");
          try {
            setPhase((await onCleanup(run)) === undefined ? "idle" : "checked");
          } catch {
            setPhase("idle");
          }
        }}
      >
        {message(phase === "checking" ? "chat.retryCleanupChecking" : "chat.retryCleanup")}
      </ActionButton>
      {phase === "checked" ? (
        <output className="execution-next-action">
          {message("chat.retryCleanupStillUnconfirmed")}
        </output>
      ) : null}
    </>
  );
}
