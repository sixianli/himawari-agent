import { useEffect, useRef, useState } from "react";
import type { BackgroundCommandState, BackgroundCommandView } from "../background-commands.js";
import type { MessageId } from "../i18n/message-ids.js";
import type { TurnFile } from "../turn-files.js";
import { AnswerFiles, LineIcon } from "./answer-footer.js";
import { ActionButton } from "./primitives.js";

type Message = (id: MessageId, values?: Record<string, string | number | boolean | Date>) => string;

export type MoreTab = "files" | "commands";

export interface MoreFileGroup {
  readonly runId: string;
  readonly turn: number;
  readonly files: readonly TurnFile[];
}

const STATE_KEYS: Readonly<Record<BackgroundCommandState, string>> = {
  running: "running",
  completed: "completed",
  failed: "failed",
  stopped: "stopped",
  timed_out: "timedOut",
  interrupted: "interrupted",
};

const stateMessage = (prefix: string, state: BackgroundCommandState) =>
  `${prefix}.${STATE_KEYS[state]}` as MessageId;

export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

export function commandDuration(milliseconds: number, message: Message): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes
    ? message("more.duration.minutes", { minutes, seconds })
    : message("more.duration.seconds", { seconds });
}

export const commandLabel = (command: BackgroundCommandView, message: Message) =>
  command.label?.split("\n")[0]?.trim() || message("more.commandFallback");

const ranFor = (command: BackgroundCommandView, now: number) =>
  (command.endedAt ? Date.parse(command.endedAt) : now) - Date.parse(command.startedAt);

function StateMark({ state }: { readonly state: BackgroundCommandState }) {
  if (state === "running") return <span className="more-spin" aria-hidden="true" />;
  return (
    <span className={`more-mark is-${state}`} aria-hidden="true">
      <LineIcon name={state === "completed" ? "check" : state === "stopped" ? "stop" : "alert"} />
    </span>
  );
}

export function MoreButton({
  running,
  open,
  onClick,
  message,
}: {
  readonly running: number;
  readonly open: boolean;
  readonly onClick: () => void;
  readonly message: Message;
}) {
  return (
    <ActionButton
      className="more-button"
      variant="quiet"
      aria-label={
        running ? message("more.buttonRunning", { count: running }) : message("more.button")
      }
      title={message("more.button")}
      aria-expanded={open}
      onClick={onClick}
    >
      <LineIcon name="panel" />
      {running ? (
        <span className="more-count" aria-hidden="true">
          {running}
        </span>
      ) : null}
    </ActionButton>
  );
}

export function BackgroundCommandLine({
  command,
  stopping,
  onOpen,
  message,
}: {
  readonly command: BackgroundCommandView;
  readonly stopping: boolean;
  readonly onOpen: (() => void) | undefined;
  readonly message: Message;
}) {
  const now = useNow(command.state === "running");
  const name = commandLabel(command, message);
  const text =
    command.state === "running"
      ? stopping
        ? message("more.line.stopping", { command: name })
        : message("more.line.running", {
            command: name,
            elapsed: commandDuration(ranFor(command, now), message),
          })
      : message(stateMessage("more.line", command.state), { command: name });
  return (
    <button type="button" className="background-line" onClick={onOpen} disabled={!onOpen}>
      <StateMark state={command.state} />
      <span>{text}</span>
    </button>
  );
}

export function BackgroundReportLine({
  commands,
  committedAt,
  onOpen,
  message,
}: {
  readonly commands: readonly BackgroundCommandView[];
  readonly committedAt: string;
  readonly onOpen: (() => void) | undefined;
  readonly message: Message;
}) {
  const at = new Date(committedAt);
  const [only] = commands;
  const text =
    commands.length > 1
      ? message("more.report.many", { count: commands.length, at })
      : only && only.state !== "running"
        ? message(stateMessage("more.report", only.state), {
            command: commandLabel(only, message),
            duration: commandDuration(ranFor(only, Date.now()), message),
            at,
          })
        : message("more.report.unknown", { at });
  return (
    <button type="button" className="background-report" onClick={onOpen} disabled={!onOpen}>
      <span className="background-report-rule" aria-hidden="true" />
      <span className="background-report-text">{text}</span>
      <span className="background-report-rule" aria-hidden="true" />
    </button>
  );
}

export function MorePanel({
  tab,
  commandKey,
  commands,
  fileGroups,
  stoppingRunIds,
  openFileKey,
  onTab,
  onCommand,
  onStop,
  onReport,
  onOpenFile,
  onClose,
  message,
}: {
  readonly tab: MoreTab;
  readonly commandKey: string | null;
  readonly commands: readonly BackgroundCommandView[];
  readonly fileGroups: readonly MoreFileGroup[];
  readonly stoppingRunIds: readonly string[];
  readonly openFileKey: string | undefined;
  readonly onTab: (tab: MoreTab) => void;
  readonly onCommand: (key: string | null) => void;
  readonly onStop: ((command: BackgroundCommandView) => void) | undefined;
  readonly onReport: (command: BackgroundCommandView) => void;
  readonly onOpenFile: (file: TurnFile) => void;
  readonly onClose: () => void;
  readonly message: Message;
}) {
  const panel = useRef<HTMLElement>(null);
  const [full, setFull] = useState(false);
  const running = commands.filter((command) => command.state === "running");
  const finished = commands
    .filter((command) => command.state !== "running")
    .sort((a, b) => Date.parse(b.endedAt ?? "") - Date.parse(a.endedAt ?? ""));
  const fileCount = fileGroups.reduce((sum, group) => sum + group.files.length, 0);
  const tabs: readonly { id: MoreTab; label: MessageId; count: number }[] = [
    ...(fileCount
      ? [{ id: "files" as const, label: "more.tab.files" as const, count: fileCount }]
      : []),
    ...(commands.length
      ? [{ id: "commands" as const, label: "more.tab.commands" as const, count: commands.length }]
      : []),
  ];
  const current = tabs.some((item) => item.id === tab) ? tab : (tabs[0]?.id ?? "commands");
  const detail = commandKey ? commands.find((command) => command.key === commandKey) : undefined;
  const now = useNow(running.length > 0);
  useEffect(() => {
    const trigger = document.activeElement;
    panel.current?.focus();
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  const stopping = (command: BackgroundCommandView) => stoppingRunIds.includes(command.runId);
  const stopButton = (command: BackgroundCommandView) =>
    command.state === "running" && onStop ? (
      <button
        type="button"
        className="more-stop"
        disabled={stopping(command)}
        onClick={() => onStop(command)}
      >
        {message(stopping(command) ? "more.stopping" : "chat.stop")}
      </button>
    ) : null;
  const reportButton = (command: BackgroundCommandView) =>
    command.state !== "running" && command.noticeRunId ? (
      <button type="button" className="more-link" onClick={() => onReport(command)}>
        {message("more.report")}
      </button>
    ) : null;
  const closeButton = (
    <ActionButton
      className="more-close"
      variant="quiet"
      aria-label={message("common.close")}
      onClick={onClose}
    >
      ×
    </ActionButton>
  );
  const row = (command: BackgroundCommandView) => (
    <li className="more-job" key={command.key}>
      <button type="button" className="more-row" onClick={() => onCommand(command.key)}>
        <StateMark state={command.state} />
        <span className="more-row-text">
          <code className="more-row-name">{commandLabel(command, message)}</code>
          <small>
            {command.state === "running"
              ? message("more.job.running", {
                  elapsed: commandDuration(ranFor(command, now), message),
                  deadline: new Date(command.deadlineAt),
                })
              : command.state === "interrupted"
                ? message("more.job.interrupted", { at: new Date(command.endedAt ?? "") })
                : message(stateMessage("more.job", command.state), {
                    duration: commandDuration(ranFor(command, now), message),
                    at: new Date(command.endedAt ?? ""),
                  })}
          </small>
          {command.state === "running" ? (
            <small>{message("more.job.turn", { turn: command.turn })}</small>
          ) : null}
        </span>
      </button>
      {stopButton(command)}
      {reportButton(command)}
    </li>
  );
  return (
    <>
      <button
        type="button"
        className="more-scrim"
        tabIndex={-1}
        aria-label={message("common.close")}
        onClick={onClose}
      />
      <aside
        className={full ? "more-panel is-full" : "more-panel"}
        ref={panel}
        tabIndex={-1}
        aria-label={message("more.label")}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <button
          type="button"
          className="more-grabber"
          aria-label={message(full ? "more.sheet.collapse" : "more.sheet.expand")}
          onClick={() => setFull(!full)}
        >
          <span className="more-grabber-bar" />
        </button>
        {detail ? (
          <>
            <header className="more-header">
              <ActionButton
                variant="quiet"
                aria-label={message("common.back")}
                onClick={() => onCommand(null)}
              >
                <LineIcon name="back" />
              </ActionButton>
              <code className="more-title" title={detail.label}>
                {commandLabel(detail, message)}
              </code>
              {stopButton(detail)}
              {reportButton(detail)}
              {closeButton}
            </header>
            <div className="more-body">
              <dl className="more-facts">
                <dt>{message("more.detail.status")}</dt>
                <dd>
                  {stopping(detail) && detail.state === "running"
                    ? message("more.stopping")
                    : message(stateMessage("more.state", detail.state))}
                </dd>
                <dt>{message("more.detail.start")}</dt>
                <dd>{message("more.time", { at: new Date(detail.startedAt) })}</dd>
                <dt>
                  {message(
                    detail.state === "running" ? "more.detail.elapsed" : "more.detail.duration",
                  )}
                </dt>
                <dd>{commandDuration(ranFor(detail, now), message)}</dd>
                {detail.state === "running" ? (
                  <>
                    <dt>{message("more.detail.deadline")}</dt>
                    <dd>{message("more.time", { at: new Date(detail.deadlineAt) })}</dd>
                  </>
                ) : null}
                <dt>{message("more.detail.turn")}</dt>
                <dd>{message("more.turn", { turn: detail.turn })}</dd>
              </dl>
              <h3 className="more-section">{message("more.detail.output")}</h3>
              {detail.state === "interrupted" ? (
                <p className="more-note">{message("more.detail.interrupted")}</p>
              ) : detail.state === "running" ? (
                <p className="more-note">{message("more.detail.outputLater")}</p>
              ) : detail.outputPending ? (
                <p className="more-note">{message("more.detail.outputLoading")}</p>
              ) : detail.output ? (
                <pre className="more-output">{detail.output}</pre>
              ) : (
                <p className="more-note">{message("more.detail.outputNone")}</p>
              )}
            </div>
          </>
        ) : (
          <>
            <header className="more-header">
              <div className="more-tabs" role="tablist">
                {tabs.map((item) => (
                  <button
                    type="button"
                    role="tab"
                    key={item.id}
                    className="more-tab"
                    aria-selected={current === item.id}
                    onClick={() => onTab(item.id)}
                  >
                    {message(item.label)}
                    <span className="more-tab-count">{item.count}</span>
                  </button>
                ))}
              </div>
              {closeButton}
            </header>
            <div className="more-body" role="tabpanel">
              {current === "files" ? (
                <>
                  {running.length ? (
                    <button type="button" className="more-hint" onClick={() => onTab("commands")}>
                      <span className="more-spin" aria-hidden="true" />
                      <span>{message("more.runningHint", { count: running.length })}</span>
                    </button>
                  ) : null}
                  {fileGroups.map((group) => (
                    <section key={group.runId}>
                      <h3 className="more-section">{message("more.turn", { turn: group.turn })}</h3>
                      <AnswerFiles
                        files={group.files}
                        openKey={openFileKey}
                        onOpen={onOpenFile}
                        message={message}
                      />
                    </section>
                  ))}
                </>
              ) : (
                <>
                  {running.length ? (
                    <section>
                      <h3 className="more-section">{message("more.section.running")}</h3>
                      <ul className="more-jobs">{running.map(row)}</ul>
                    </section>
                  ) : null}
                  {finished.length ? (
                    <section>
                      <h3 className="more-section">{message("more.section.finished")}</h3>
                      <ul className="more-jobs">{finished.map(row)}</ul>
                    </section>
                  ) : null}
                </>
              )}
            </div>
          </>
        )}
      </aside>
    </>
  );
}
