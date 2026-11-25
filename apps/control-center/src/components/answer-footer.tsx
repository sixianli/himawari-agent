import { useEffect, useState } from "react";
import type { MessageId } from "../i18n/message-ids.js";
import type { TurnSource } from "../turn-summary.js";
import { Glyph, type GlyphName } from "./glyphs.js";

type Message = (id: MessageId, values?: Record<string, string | number | boolean | Date>) => string;

const icons = {
  copy: "copy",
  check: "check",
  fork: "fork",
  chevron: "chevron",
  file: "file",
  widen: "widen",
  image: "image",
  terminal: "terminal",
  back: "back",
  stop: "stop",
  alert: "alert",
  panel: "panel",
  external: "external",
  arrowDown: "arrowDown",
  download: "download",
  expand: "expand",
  collapse: "collapse",
  close: "close",
  info: "info",
  bell: "bell",
  mail: "mail",
  globe: "globe",
} satisfies Record<string, GlyphName>;

export function LineIcon({ name }: { readonly name: keyof typeof icons }) {
  return <Glyph className="line-icon" name={icons[name]} />;
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
  message,
}: {
  readonly text: string;
  readonly committedAt: string | undefined;
  readonly message: Message;
}) {
  const [copied, copy] = useCopied();
  return (
    <div className="answer-actions">
      <button
        type="button"
        className="answer-action icon-only"
        data-tip={message("answer.copyHint")}
        aria-label={message(copied ? "answer.copied" : "answer.copy")}
        onClick={() => copy(text)}
      >
        <LineIcon name={copied ? "check" : "copy"} />
      </button>
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
