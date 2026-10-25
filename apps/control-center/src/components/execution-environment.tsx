import type { ThreadExecutionEnvironment } from "@himawari-agent/gateway-contracts";
import { useEffect, useRef, useState } from "react";
import type { MessageId } from "../i18n/message-ids.js";

type Message = (id: MessageId, values?: Record<string, string | number>) => string;

export function ExecutionEnvironmentLine({
  environment,
  failed,
  threadTitle,
  onOpen,
  onOpenThread,
  message,
}: {
  readonly environment: ThreadExecutionEnvironment | undefined;
  readonly failed: boolean;
  readonly threadTitle: (threadId: string) => string | undefined;
  readonly onOpen: () => void;
  readonly onOpenThread: (threadId: string) => void;
  readonly message: Message;
}) {
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => {
      if (root.current && !event.composedPath().includes(root.current)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      toggle.current?.focus();
    };
    document.addEventListener("click", dismiss);
    document.addEventListener("focusin", dismiss);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("click", dismiss);
      document.removeEventListener("focusin", dismiss);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);
  if (!environment && !failed) return null;
  const mode = environment
    ? message(`chat.environment.mode.${environment.mode}` as MessageId)
    : message("chat.environment.title");
  const programs = environment?.programs ?? [];
  return (
    <div className="environment-line" ref={root}>
      <button
        ref={toggle}
        type="button"
        aria-expanded={open}
        onClick={() => {
          if (!open) onOpen();
          setOpen(!open);
        }}
      >
        {environment
          ? `${mode} · ${
              programs.length
                ? message("chat.environment.running", { count: programs.length })
                : message("chat.environment.idle")
            }`
          : mode}
        <span aria-hidden="true">⌄</span>
      </button>
      {open ? (
        <div
          className="environment-panel"
          role="dialog"
          aria-label={message("chat.environment.title")}
        >
          {environment ? (
            <>
              <section>
                <h3>{message("chat.environment.currentMode")}</h3>
                <p className="environment-mode">{mode}</p>
                <p>
                  {message(
                    environment.mode === "strict"
                      ? "chat.environment.strictMeaning"
                      : "chat.environment.srtMeaning",
                  )}
                </p>
                <p>{message("chat.environment.fixed")}</p>
              </section>
              <section>
                <h3>{message("chat.environment.programs")}</h3>
                {programs.length ? (
                  <ul>
                    {programs.map((program, index) => {
                      const title = program.threadId ? threadTitle(program.threadId) : undefined;
                      return (
                        <li key={`${program.threadId}:${program.startedAt}:${index}`}>
                          <span>
                            <code>{program.toolName}</code>
                            <small>
                              {message(`chat.environment.kind.${program.kind}` as MessageId)} ·{" "}
                              {message("chat.environment.startedAt", {
                                time: new Date(program.startedAt).toLocaleTimeString([], {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                }),
                              })}
                            </small>
                          </span>
                          {program.threadId && title !== undefined ? (
                            <button
                              type="button"
                              aria-label={message("chat.environment.openThread", { title })}
                              onClick={() => {
                                setOpen(false);
                                onOpenThread(program.threadId ?? "");
                              }}
                            >
                              {title} ›
                            </button>
                          ) : (
                            <small>{message("chat.environment.otherThread")}</small>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p>{message("chat.environment.noPrograms")}</p>
                )}
              </section>
              <section>
                {environment.mode === "strict" ? (
                  <>
                    <h3>{message("chat.environment.unavailable")}</h3>
                    {environment.unavailableTools.length ? (
                      <ul>
                        {environment.unavailableTools.map((tool) => (
                          <li key={tool.toolName}>
                            <code>{tool.toolName}</code>
                            <small>
                              {message(`chat.environment.reason.${tool.reasonCode}` as MessageId)}
                            </small>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <p>{message("chat.environment.strictNote")}</p>
                  </>
                ) : (
                  <>
                    <h3>{message("chat.environment.toolAvailability")}</h3>
                    <p>{message("chat.environment.noneUnavailable")}</p>
                  </>
                )}
              </section>
            </>
          ) : (
            <p role="alert">{message("chat.environment.readFailed")}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
