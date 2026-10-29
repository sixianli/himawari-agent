import { useEffect, useRef, useState } from "react";
import type { BackgroundCommandState, BackgroundCommandView } from "../background-commands.js";
import type { DeliveredFile, DeliveredFileGroup } from "../delivered-files.js";
import type { MessageId } from "../i18n/message-ids.js";
import { DeliveredFileRow } from "./delivered-file.js";

type Message = (id: MessageId, values?: Record<string, string | number | boolean | Date>) => string;

export type MoreTab = "files" | "commands";

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

const startedIn = (command: BackgroundCommandView, message: Message) =>
  command.turnTitle
    ? message("more.job.turn", { turn: command.turn, title: command.turnTitle })
    : message("more.job.turnPlain", { turn: command.turn });

function Glyph({ path, size = 18 }: { readonly path: string; readonly size?: number }) {
  return (
    <svg
      className="more-glyph"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

const CLOSE_PATH = "M6 6l12 12M18 6L6 18";
const BACK_PATH = "M15 6l-6 6 6 6";

function StateMark({ state }: { readonly state: BackgroundCommandState }) {
  if (state === "running") return <span className="more-spin" aria-hidden="true" />;
  return (
    <span className={`more-mark is-${state}`}>
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        aria-hidden="true"
      >
        {state === "completed" ? (
          <path d="M5 12l5 5 9-10" strokeWidth="2.2" />
        ) : state === "stopped" ? (
          <rect x="6" y="6" width="12" height="12" rx="1.5" strokeWidth="2" />
        ) : (
          <>
            <circle cx="12" cy="12" r="9" strokeWidth="2" />
            <path d="M12 7v6M12 16.5v.5" strokeWidth="2" />
          </>
        )}
      </svg>
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
    <button
      type="button"
      className={open ? "more-button is-open" : "more-button"}
      aria-label={
        running ? message("more.buttonRunning", { count: running }) : message("more.label")
      }
      title={message("more.button")}
      aria-expanded={open}
      onClick={onClick}
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        aria-hidden="true"
      >
        <path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" />
      </svg>
      {running ? (
        <span className="more-count" aria-hidden="true">
          {running}
        </span>
      ) : null}
    </button>
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
  const text = (prefix: "more.report" | "more.reportShort") =>
    commands.length > 1
      ? message("more.report.many", { count: commands.length, at })
      : only && only.state !== "running"
        ? message(stateMessage(prefix, only.state), {
            command: commandLabel(only, message),
            duration: commandDuration(ranFor(only, Date.now()), message),
            at,
          })
        : message("more.report.unknown", { at });
  return (
    <button type="button" className="background-report" onClick={onOpen} disabled={!onOpen}>
      <span className="background-report-rule" aria-hidden="true" />
      <span className="background-report-text is-long">{text("more.report")}</span>
      <span className="background-report-text is-short">{text("more.reportShort")}</span>
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
  readonly fileGroups: readonly DeliveredFileGroup[];
  readonly stoppingRunIds: readonly string[];
  readonly openFileKey: string | undefined;
  readonly onTab: (tab: MoreTab) => void;
  readonly onCommand: (key: string | null) => void;
  readonly onStop: ((command: BackgroundCommandView) => void) | undefined;
  readonly onReport: (command: BackgroundCommandView) => void;
  readonly onOpenFile: (file: DeliveredFile) => void;
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
  const changedBy = (command: BackgroundCommandView) =>
    fileGroups.flatMap((group) =>
      group.files.filter((file) => file.registered?.commandKey === command.key),
    );
  const now = useNow(running.length > 0);
  useEffect(() => {
    const trigger = document.activeElement;
    panel.current?.focus();
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  const stopping = (command: BackgroundCommandView) =>
    command.state === "running" && stoppingRunIds.includes(command.runId);
  const stopButton = (command: BackgroundCommandView) =>
    command.state === "running" && onStop && !stopping(command) ? (
      <button type="button" className="more-stop" onClick={() => onStop(command)}>
        {message("chat.stop")}
      </button>
    ) : null;
  const reportButton = (command: BackgroundCommandView, className: string) =>
    command.state !== "running" && command.noticeRunId ? (
      <button type="button" className={className} onClick={() => onReport(command)}>
        {message("more.report")}
      </button>
    ) : null;
  const iconButton = (label: MessageId, path: string, onClick: () => void) => (
    <button type="button" className="more-icon" aria-label={message(label)} onClick={onClick}>
      <Glyph path={path} />
    </button>
  );
  const facts = (command: BackgroundCommandView) => {
    const rows: [MessageId, string][] = [
      [
        "more.detail.status",
        message(
          command.state === "running"
            ? "more.state.running"
            : stateMessage("more.state", command.state),
        ),
      ],
      ["more.detail.start", message("more.time", { at: new Date(command.startedAt) })],
    ];
    if (command.state === "running") {
      rows.push(["more.detail.elapsed", commandDuration(ranFor(command, now), message)]);
      rows.push([
        "more.detail.deadline",
        message("more.time", { at: new Date(command.deadlineAt) }),
      ]);
    } else if (command.state !== "interrupted")
      rows.push(["more.detail.duration", commandDuration(ranFor(command, now), message)]);
    rows.push(["more.detail.turn", startedIn(command, message)]);
    return rows;
  };
  const row = (command: BackgroundCommandView) => (
    <li className="more-job" key={command.key}>
      <button type="button" className="more-row" onClick={() => onCommand(command.key)}>
        <StateMark state={command.state} />
        <span className="more-row-text">
          <code className="more-row-name">{commandLabel(command, message)}</code>
          <small>
            {command.state === "running"
              ? stopping(command)
                ? message("more.stopping")
                : message("more.job.running", {
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
            <small>{startedIn(command, message)}</small>
          ) : command.state !== "interrupted" ? (
            <small>
              {changedBy(command).length
                ? message("more.changed", { count: changedBy(command).length })
                : message("more.noChange")}
            </small>
          ) : null}
        </span>
      </button>
      {stopButton(command)}
      {reportButton(command, "more-link")}
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
        aria-label={message("more.button")}
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
              {iconButton("common.back", BACK_PATH, () => onCommand(null))}
              <code className="more-title" title={detail.label}>
                {commandLabel(detail, message)}
              </code>
              {stopButton(detail)}
              {reportButton(detail, "more-action")}
              {iconButton("common.close", CLOSE_PATH, onClose)}
            </header>
            <div className="more-body">
              <dl className="more-facts">
                {facts(detail).map(([label, value]) => (
                  <div className="more-fact" key={label}>
                    <dt>{message(label)}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              <h3 className="more-section">{message("more.detail.files")}</h3>
              {changedBy(detail).length ? (
                <div>
                  {changedBy(detail).map((file) => (
                    <DeliveredFileRow
                      key={file.key}
                      file={file}
                      open={file.key === openFileKey}
                      onOpen={() => onOpenFile(file)}
                      message={message}
                    />
                  ))}
                </div>
              ) : (
                <p className="more-note">
                  {message(detail.state === "running" ? "more.filesLater" : "more.noChange")}
                </p>
              )}
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
              {iconButton("common.close", CLOSE_PATH, onClose)}
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
                      <h3 className="more-section">
                        {group.command
                          ? message("files.group.command", {
                              turn: group.turn,
                              command: group.command,
                            })
                          : group.title
                            ? message("more.files.group", { turn: group.turn, title: group.title })
                            : message("more.turn", { turn: group.turn })}
                      </h3>
                      {group.files.map((file) => (
                        <DeliveredFileRow
                          key={file.key}
                          file={file}
                          open={file.key === openFileKey}
                          onOpen={() => onOpenFile(file)}
                          message={message}
                        />
                      ))}
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
