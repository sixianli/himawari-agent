import { useEffect, useRef, useState } from "react";
import type { MessageId } from "../i18n/message-ids.js";
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
  back: "m15 6-6 6 6 6",
  stop: "M7 7h10v10H7z",
  alert: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4.5v6m0 3.5v.5",
  panel: "M3.5 4.5h17v15h-17zM14.5 4.5v15",
  external: "M13.5 4.5h6v6M19.5 4.5l-8 8M17.5 13.5v6h-13v-13h6",
  download: "M12 4.5v10M7.5 10.5l4.5 4.5 4.5-4.5M5 19.5h14",
  expand: "M14.5 4.5h5v5M19.5 4.5l-5.5 5.5M9.5 19.5h-5v-5M4.5 19.5l5.5-5.5",
  collapse: "M19.5 4.5 14 10M14 5.5V10h4.5M4.5 19.5 10 14M10 18.5V14H5.5",
  close: "M6.5 6.5l11 11M17.5 6.5l-11 11",
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
