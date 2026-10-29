import { useEffect, useState } from "react";
import type { MessageId } from "../i18n/message-ids.js";
import type { TurnSource } from "../turn-summary.js";

type Message = (id: MessageId, values?: Record<string, string | number | boolean | Date>) => string;

const icons = {
  copy: "M9 9h10.5v10.5H9zM5.5 15H4.5V4.5H15v1",
  check: "m5 12.5 4.5 4.5L19 7.5",
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
  arrowDown: "M12 5v14M6.5 13.5 12 19l5.5-5.5",
  download: "M12 4.5v10M7.5 10.5l4.5 4.5 4.5-4.5M5 19.5h14",
  expand: "M14.5 4.5h5v5M19.5 4.5l-5.5 5.5M9.5 19.5h-5v-5M4.5 19.5l5.5-5.5",
  collapse: "M19.5 4.5 14 10M14 5.5V10h4.5M4.5 19.5 10 14M10 18.5V14H5.5",
  close: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  bell: "M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15l1.5-2ZM10 20.5h4",
  mail: "M3.5 5.5h17v13h-17zM4 7l8 6 8-6",
  globe:
    "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM3.5 12h17M12 3.5c2.4 2.4 3.5 5.2 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.2-3.5-8.5s1.1-6.1 3.5-8.5Z",
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
  committedAt,
  onFork,
  message,
}: {
  readonly text: string;
  readonly committedAt: string | undefined;
  readonly onFork: (() => void) | undefined;
  readonly message: Message;
}) {
  const [copied, copy] = useCopied();
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
        <button
          type="button"
          className="answer-action icon-only"
          title={message("answer.forkHint")}
          aria-label={message("answer.fork")}
          onClick={onFork}
        >
          <LineIcon name="fork" />
        </button>
      ) : null}
      {committedAt ? (
        <time className="answer-time" dateTime={committedAt}>
          {message("answer.at", { at: new Date(committedAt) })}
        </time>
      ) : null}
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
  const sites = [...new Set(sources.map((source) => source.site))];
  return (
    <div className="answer-sources">
      <button
        type="button"
        className="sources-toggle"
        aria-expanded={open}
        aria-label={message("answer.sources", { count: sources.length })}
        onClick={() => setOpen(!open)}
      >
        <LineIcon name="globe" />
        <span className="source-sites">{sites.slice(0, 2).join(" · ")}</span>
        {sites.length > 2 ? <span className="source-more">+{sites.length - 2}</span> : null}
        <LineIcon name="chevron" />
      </button>
      {open ? (
        <ul className="source-list">
          {sources.map((source) => (
            <li key={source.url}>
              <a href={source.url} title={source.url} target="_blank" rel="noopener noreferrer">
                <span className="source-title">{source.title}</span>
                <small>{source.site}</small>
                <LineIcon name="external" />
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
