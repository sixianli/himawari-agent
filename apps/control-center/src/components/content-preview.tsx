import { lexer } from "marked";
import { useEffect, useRef, useState } from "react";
import { parseDelimited } from "../delimited-text.js";
import type { MessageId } from "../i18n/message-ids.js";
import { useControlCenterIntl } from "../i18n/runtime.js";
import { type DiffLine, fileExtension, type PreviewKind, type TurnFile } from "../turn-files.js";
import { LineIcon, useCopied } from "./answer-footer.js";
import { AssistantMarkdown } from "./assistant-markdown.js";
import { ActionButton } from "./primitives.js";

export interface ContentPreviewValue {
  readonly title: string;
  readonly text: string;
  readonly key?: string;
  readonly path?: string;
  readonly kind?: PreviewKind;
  readonly diff?: readonly DiffLine[];
  readonly missing?: boolean;
}

export const previewOfFile = (file: TurnFile): ContentPreviewValue => ({
  key: file.key,
  title: file.name,
  path: file.path,
  kind: file.kind,
  text: file.content ?? "",
  diff: file.diff,
  missing: file.content === undefined,
});

type View = "preview" | "raw" | "diff";

const PREVIEW_LABELS: Readonly<Partial<Record<PreviewKind, MessageId>>> = {
  markdown: "preview.reader",
  csv: "preview.table",
};

function viewsOf(value: ContentPreviewValue): readonly View[] {
  const views: View[] = [];
  if (!value.missing && value.kind && PREVIEW_LABELS[value.kind]) views.push("preview");
  if (!value.missing) views.push("raw");
  if (value.diff?.length) views.push("diff");
  return views;
}

function SourceLines({ text }: { readonly text: string }) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return (
    <pre className="preview-source">
      {lines.map((line, index) => (
        <span className="preview-line" key={`${index}:${line}`}>
          {line || " "}
        </span>
      ))}
    </pre>
  );
}

function DiffLines({ lines }: { readonly lines: readonly DiffLine[] }) {
  return (
    <pre className="preview-source preview-diff">
      {lines.map((line, index) => (
        <span
          className={`preview-line ${line.sign === "+" ? "is-added" : line.sign === "-" ? "is-removed" : ""}`}
          data-sign={line.sign}
          key={`${index}:${line.sign}${line.text}`}
        >
          {line.text || " "}
        </span>
      ))}
    </pre>
  );
}

const NUMBER = /^-?[\d,]*\.?\d+%?$/;
const numeric = (cell: string) => NUMBER.test(cell.trim());
const numberOf = (cell: string) => Number(cell.trim().replace(/[,%]/g, ""));

function CsvTable({
  text,
  delimiter,
  message,
}: {
  readonly text: string;
  readonly delimiter: string;
  readonly message: (id: MessageId) => string;
}) {
  const [header = [], ...cells] = parseDelimited(text, delimiter);
  const rows = cells.map((values, index) => ({
    id: `row-${index + 1}`,
    number: index + 1,
    values,
  }));
  const width = Math.max(header.length, ...cells.map((row) => row.length));
  const columns = Array.from({ length: width }, (_, position) => {
    const values = cells.map((row) => row[position] ?? "").filter((cell) => cell.trim());
    const isNumber = values.length > 0 && values.every(numeric);
    const percent = values.some((cell) => cell.trim().endsWith("%"));
    return {
      id: `column-${position + 1}`,
      position,
      title: header[position] ?? "",
      className: isNumber ? "is-number" : undefined,
      total:
        isNumber && !percent && values.length > 1
          ? values.reduce((sum, cell) => sum + numberOf(cell), 0)
          : undefined,
    };
  });
  const hasTotal = columns.some((column) => column.total !== undefined);
  return (
    <div className="preview-grid">
      <table>
        <thead>
          <tr>
            <th className="row-number" />
            {columns.map((column) => (
              <th key={column.id} className={column.className}>
                {column.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="row-number">{row.number}</td>
              {columns.map((column) => (
                <td key={column.id} className={column.className}>
                  {row.values[column.position] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {hasTotal ? (
          <tfoot>
            <tr>
              <td className="row-number">{message("preview.total")}</td>
              {columns.map((column) => (
                <td key={column.id} className={column.className}>
                  {column.total?.toLocaleString(undefined, { maximumFractionDigits: 2 }) ?? ""}
                </td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}

function MarkdownReader({ text, label }: { readonly text: string; readonly label: string }) {
  const article = useRef<HTMLElement>(null);
  const headings = lexer(text, { gfm: true })
    .filter((token) => token.type === "heading" && token.depth === 2)
    .map((token) => ("text" in token ? String(token.text) : ""));
  return (
    <div className="preview-reader">
      {headings.length > 1 ? (
        <nav className="preview-toc" aria-label={label}>
          {headings.map((heading, index) => (
            <button
              type="button"
              key={`${index}:${heading}`}
              onClick={() =>
                article.current
                  ?.querySelectorAll("h2")
                  [index]?.scrollIntoView({ behavior: "smooth", block: "start" })
              }
            >
              {heading}
            </button>
          ))}
        </nav>
      ) : null}
      <article className="file-reader" ref={article}>
        <AssistantMarkdown text={text} />
      </article>
    </div>
  );
}

export function ContentPreview({
  value,
  onBack,
  onClose,
}: {
  value: ContentPreviewValue;
  onBack?: (() => void) | undefined;
  onClose: () => void;
}) {
  const { message } = useControlCenterIntl();
  const panel = useRef<HTMLElement>(null);
  const views = viewsOf(value);
  const [view, setView] = useState<View>(views[0] ?? "raw");
  const [wide, setWide] = useState(false);
  const [copied, copy] = useCopied();
  useEffect(() => {
    const trigger = document.activeElement;
    panel.current?.focus();
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  const current = views.includes(view) ? view : (views[0] ?? "raw");
  const kind = value.kind ?? "text";
  const copyText =
    current === "diff"
      ? (value.diff ?? []).map((line) => `${line.sign}${line.text}`).join("\n")
      : value.text;
  const labels: Readonly<Record<View, MessageId>> = {
    preview: PREVIEW_LABELS[kind] ?? "preview.raw",
    raw: kind === "markdown" || kind === "csv" ? "preview.raw" : "preview.source",
    diff: "preview.diff",
  };
  return (
    <aside
      className={wide ? "content-preview is-wide" : "content-preview"}
      ref={panel}
      tabIndex={-1}
      aria-label={value.title}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header>
        {onBack ? (
          <ActionButton variant="quiet" aria-label={message("common.back")} onClick={onBack}>
            <LineIcon name="back" />
          </ActionButton>
        ) : (
          <span className="preview-icon">
            <LineIcon name="file" />
          </span>
        )}
        <span className="preview-title">
          <strong>{value.title}</strong>
          {value.path && value.path !== value.title ? <small>{value.path}</small> : null}
        </span>
        {views.length > 1 ? (
          <fieldset className="preview-tabs">
            <legend className="sr-only">{message("preview.views")}</legend>
            {views.map((item) => (
              <button
                type="button"
                key={item}
                aria-pressed={current === item}
                onClick={() => setView(item)}
              >
                {message(labels[item])}
              </button>
            ))}
          </fieldset>
        ) : null}
        <ActionButton
          className="preview-widen"
          variant="quiet"
          aria-label={message(wide ? "preview.narrow" : "preview.widen")}
          title={message(wide ? "preview.narrow" : "preview.widen")}
          aria-pressed={wide}
          onClick={() => setWide(!wide)}
        >
          <LineIcon name="widen" />
        </ActionButton>
        {value.missing && !value.diff?.length ? null : (
          <ActionButton
            variant="quiet"
            aria-label={message("preview.copy")}
            title={message("preview.copy")}
            onClick={() => copy(copyText)}
          >
            <LineIcon name={copied ? "check" : "copy"} />
          </ActionButton>
        )}
        <ActionButton variant="quiet" aria-label={message("common.close")} onClick={onClose}>
          ×
        </ActionButton>
      </header>
      {value.missing ? (
        <p className="preview-notice">
          {message(value.diff?.length ? "preview.editOnly" : "preview.missing")}
        </p>
      ) : null}
      {kind === "html" && current === "raw" ? (
        <p className="preview-notice">{message("preview.htmlLater")}</p>
      ) : null}
      <div className="preview-body">
        {current === "diff" ? (
          <DiffLines lines={value.diff ?? []} />
        ) : current === "preview" && kind === "markdown" ? (
          <MarkdownReader text={value.text} label={message("preview.contents")} />
        ) : current === "preview" && kind === "csv" ? (
          <CsvTable
            text={value.text}
            delimiter={fileExtension(value.title) === "tsv" ? "\t" : ","}
            message={message}
          />
        ) : value.missing ? null : kind === "text" && !value.path ? (
          <pre className="preview-plain">{value.text}</pre>
        ) : (
          <SourceLines text={value.text} />
        )}
      </div>
    </aside>
  );
}
