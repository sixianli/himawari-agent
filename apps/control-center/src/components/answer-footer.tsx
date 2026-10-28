import { useEffect, useRef, useState } from "react";
import type { MessageId } from "../i18n/message-ids.js";
import { fileExtension, lineCount, type TurnFile } from "../turn-files.js";
import { formatCost, formatTokens, type TurnSource, type TurnUsage } from "../turn-summary.js";

type Message = (id: MessageId, values?: Record<string, string | number | boolean | Date>) => string;

const icons = {
  copy: "M9 9h10.5v10.5H9zM5.5 15H4.5V4.5H15v1",
  check: "m5 12.5 4.5 4.5L19 7.5",
  more: "M6 12h.01M12 12h.01M18 12h.01",
  fork: "M6 3v12m0 0a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm12-9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 0c0 6-12 3-12 9",
  chevron: "m9 6 6 6-6 6",
  file: "M14 3H6.5v18h11V6.5L14 3Zm0 0v3.5h3.5",
  widen: "M4 5h16v14H4zM14 5v14",
  image: "M4 5h16v14H4zM4 16l4.5-4.5L13 16m-1.5-1.5 2.5-2.5 6 6M15.5 9h.01",
  terminal: "M3 5h18v14H3zM7 10l3 2-3 2M12 14h5",
};

export function LineIcon({ name }: { readonly name: keyof typeof icons }) {
  return (
    <svg className="line-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={icons[name]} />
    </svg>
  );
}

export function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  return [
    copied,
    (text: string) => {
      void navigator.clipboard
        ?.writeText(text)
        .then(() => setCopied(true))
        .catch(() => setCopied(false));
    },
  ];
}

export function AnswerActions({
  text,
  duration,
  committedAt,
  usage,
  onFork,
  message,
}: {
  readonly text: string;
  readonly duration: string | undefined;
  readonly committedAt: string | undefined;
  readonly usage: TurnUsage | undefined;
  readonly onFork: (() => void) | undefined;
  readonly message: Message;
}) {
  const [copied, copy] = useCopied();
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: Event) => {
      if (menuRef.current && !event.composedPath().includes(menuRef.current)) setMenu(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(false);
    };
    document.addEventListener("click", dismiss);
    document.addEventListener("focusin", dismiss);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("click", dismiss);
      document.removeEventListener("focusin", dismiss);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menu]);
  const meta = [
    duration,
    committedAt ? message("answer.at", { at: new Date(committedAt) }) : undefined,
  ].filter(Boolean);
  return (
    <div className="answer-actions">
      <button
        type="button"
        className="answer-action icon-only"
        title={message("answer.copyHint")}
        aria-label={message(copied ? "answer.copied" : "answer.copy")}
        onClick={() => copy(text)}
      >
        <LineIcon name={copied ? "check" : "copy"} />
      </button>
      {onFork ? (
        <span className="answer-more" ref={menuRef}>
          <button
            type="button"
            className="answer-action icon-only"
            aria-label={message("answer.more")}
            title={message("answer.more")}
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            <LineIcon name="more" />
          </button>
          {menu ? (
            <span className="answer-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  onFork();
                }}
              >
                <LineIcon name="fork" />
                <span>
                  {message("answer.fork")}
                  <small>{message("answer.forkHint")}</small>
                </span>
              </button>
            </span>
          ) : null}
        </span>
      ) : null}
      <span className="answer-meta">
        {meta.join(" · ")}
        {usage ? (
          <>
            {meta.length ? " · " : ""}
            <span
              className="answer-tokens"
              title={message("answer.tokenDetail", {
                input: usage.input.toLocaleString(),
                cached: usage.cached.toLocaleString(),
                output: usage.output.toLocaleString(),
                cost: formatCost(usage.costUsd),
              })}
            >
              {message("answer.tokens", { count: formatTokens(usage.total) })}
            </span>
          </>
        ) : null}
      </span>
    </div>
  );
}

export function AnswerSources({
  sources,
  message,
}: {
  readonly sources: readonly TurnSource[];
  readonly message: Message;
}) {
  const [open, setOpen] = useState(false);
  if (!sources.length) return null;
  return (
    <div className="answer-sources">
      <button
        type="button"
        className="sources-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="source-sites" aria-hidden="true">
          {sources.slice(0, 4).map((source) => (
            <i key={source.url}>{source.site.slice(0, 1).toUpperCase()}</i>
          ))}
        </span>
        {message("answer.sources", { count: sources.length })}
        <LineIcon name="chevron" />
      </button>
      {open ? (
        <ul className="source-list">
          {sources.map((source) => (
            <li key={source.url}>
              <a href={source.url} target="_blank" rel="noopener noreferrer">
                <i aria-hidden="true">{source.site.slice(0, 1).toUpperCase()}</i>
                <span className="source-title">{source.title}</span>
                <small>{source.site}</small>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const KIND_LABELS: Readonly<Record<TurnFile["kind"], MessageId>> = {
  markdown: "files.kind.markdown",
  csv: "files.kind.csv",
  html: "files.kind.html",
  code: "files.kind.code",
  text: "files.kind.text",
};

export function AnswerFiles({
  files,
  openKey,
  onOpen,
  message,
}: {
  readonly files: readonly TurnFile[];
  readonly openKey: string | undefined;
  readonly onOpen: (file: TurnFile) => void;
  readonly message: Message;
}) {
  if (!files.length) return null;
  return (
    <ul className="answer-files" aria-label={message("files.label")}>
      {files.map((file) => {
        const open = file.key === openKey;
        const badge = fileExtension(file.name).slice(0, 4).toUpperCase() || "TXT";
        return (
          <li key={file.key}>
            <button
              type="button"
              className="file-card"
              aria-pressed={open}
              title={file.path}
              onClick={() => onOpen(file)}
            >
              <span className="file-tile" aria-hidden="true">
                <LineIcon name="file" />
                <small>{badge}</small>
              </span>
              <span className="file-main">
                <span className="file-name">{file.name}</span>
                <span className="file-meta">
                  {message(KIND_LABELS[file.kind])}
                  {file.content !== undefined
                    ? ` · ${message("files.lines", { count: lineCount(file.content) })}`
                    : null}
                  {file.diff.length ? (
                    <>
                      {" · "}
                      <span className="is-added">+{file.added}</span>{" "}
                      <span className="is-removed">−{file.removed}</span>
                    </>
                  ) : null}
                </span>
              </span>
              <span className="file-open">
                {message(open ? "files.opened" : "files.open")}
                <LineIcon name="chevron" />
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
