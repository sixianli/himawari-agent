import { lexer } from "marked";
import { useEffect, useRef, useState } from "react";
import { parseDelimited } from "../delimited-text.js";
import type { DeliveredFile } from "../delivered-files.js";
import { fileContentUrl } from "../gateway-client.js";
import { useLocaleFormat } from "../i18n/locale-format.js";
import type { MessageId } from "../i18n/message-ids.js";
import { useControlCenterIntl } from "../i18n/runtime.js";
import type { RegisteredFile } from "../registered-files.js";
import { type DiffLine, fileExtension, type PreviewKind, previewKind } from "../turn-files.js";
import { LineIcon, useCopied } from "./answer-footer.js";
import { AssistantMarkdown } from "./assistant-markdown.js";
import { fileFacts, fileSourceText } from "./delivered-file.js";

export const FILE_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;

export interface FilePreviewAccess {
  readonly text: (fileId: string) => Promise<string>;
  readonly versions: (fileId: string) => Promise<readonly RegisteredFile[]>;
  readonly previewUrl: ((fileId: string) => Promise<string>) | undefined;
}

export interface DeliveredPreview {
  readonly file: DeliveredFile;
  readonly source: { readonly label: string; readonly onOpen: () => void } | undefined;
}

export interface ContentPreviewValue {
  readonly title: string;
  readonly text: string;
  readonly key?: string;
  readonly path?: string;
  readonly kind?: PreviewKind;
  readonly diff?: readonly DiffLine[];
  readonly missing?: boolean;
  readonly delivered?: DeliveredPreview;
}

export const previewOfDelivered = (
  file: DeliveredFile,
  source?: DeliveredPreview["source"],
): ContentPreviewValue => ({
  key: file.key,
  title: file.name,
  path: file.path,
  kind: previewKind(file.name),
  text: file.trace?.content ?? "",
  diff: file.trace?.diff ?? [],
  missing: !file.registered && file.trace?.content === undefined,
  delivered: { file, source },
});

const TEXT_MEDIA = /^(text\/|application\/(json|x-ndjson|xml|yaml))/;

type Body =
  | { readonly kind: "text" }
  | { readonly kind: "image"; readonly url: string }
  | { readonly kind: "pdf"; readonly url: string }
  | { readonly kind: "web" }
  | { readonly kind: "notice"; readonly id: MessageId };

function bodyOf(file: RegisteredFile, previewAvailable: boolean): Body {
  if (!file.stored) return { kind: "notice", id: "preview.notStored" };
  if (file.kind === "image" && file.mediaType !== "image/svg+xml")
    return { kind: "image", url: fileContentUrl(file.id) };
  if (file.kind === "pdf") return { kind: "pdf", url: fileContentUrl(file.id) };
  if (file.mediaType === "text/html" || file.mediaType === "image/svg+xml")
    return previewAvailable ? { kind: "web" } : { kind: "notice", id: "preview.webUnavailable" };
  if (!TEXT_MEDIA.test(file.mediaType) && file.kind !== "code")
    return { kind: "notice", id: "preview.unsupported" };
  if (file.sizeBytes > FILE_TEXT_PREVIEW_BYTES) return { kind: "notice", id: "preview.tooLarge" };
  return { kind: "text" };
}

function openInNewTab(load: () => Promise<string>) {
  const opened = window.open("about:blank", "_blank");
  if (!opened) return;
  opened.opener = null;
  void load().then(
    (url) => opened.location.replace(url),
    () => opened.close(),
  );
}

type View = "preview" | "raw" | "diff";

const PREVIEW_LABELS: Readonly<Partial<Record<PreviewKind, MessageId>>> = {
  markdown: "preview.reader",
  csv: "preview.table",
};

function viewsOf(
  value: ContentPreviewValue,
  body: Body | undefined,
  diff: boolean,
): readonly View[] {
  if (body && body.kind !== "text") return body.kind === "notice" && diff ? ["diff"] : [];
  const views: View[] = [];
  if (!value.missing && value.kind && PREVIEW_LABELS[value.kind]) views.push("preview");
  if (!value.missing) views.push("raw");
  if (diff && value.diff?.length) views.push("diff");
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
  const format = useLocaleFormat();
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
                  {column.total === undefined
                    ? ""
                    : format.number(column.total, { maximumFractionDigits: 2 })}
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

function useDeliveredContent(
  selected: RegisteredFile | undefined,
  body: Body | undefined,
  access: FilePreviewAccess | undefined,
) {
  const [state, setState] = useState<{
    readonly id: string;
    readonly text?: string;
    readonly url?: string;
    readonly failed?: boolean;
  }>();
  const [attempt, setAttempt] = useState(0);
  const id = selected?.id;
  const kind = body?.kind;
  useEffect(() => {
    void attempt;
    if (!id || !access || (kind !== "text" && kind !== "web")) return;
    let current = true;
    setState({ id });
    const load =
      kind === "text"
        ? access.text(id).then((text) => ({ id, text }))
        : (access.previewUrl?.(id) ?? Promise.reject(new Error("PREVIEW_UNAVAILABLE"))).then(
            (url) => ({ id, url }),
          );
    load.then(
      (next) => current && setState(next),
      () => current && setState({ id, failed: true }),
    );
    return () => {
      current = false;
    };
  }, [id, kind, access, attempt]);
  return {
    loaded: state?.id === id ? state : undefined,
    retry: () => setAttempt((value) => value + 1),
  };
}

export function ContentPreview({
  value,
  access,
  onBack,
  onClose,
}: {
  value: ContentPreviewValue;
  access?: FilePreviewAccess | undefined;
  onBack?: (() => void) | undefined;
  onClose: () => void;
}) {
  const { message } = useControlCenterIntl();
  const panel = useRef<HTMLElement>(null);
  const delivered = value.delivered;
  const latest = delivered?.file.registered;
  const [versions, setVersions] = useState<readonly RegisteredFile[]>();
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [selectedId, setSelectedId] = useState(latest?.id);
  const selected = versions?.find((item) => item.id === selectedId) ?? latest;
  const body = selected ? bodyOf(selected, Boolean(access?.previewUrl)) : undefined;
  const { loaded, retry } = useDeliveredContent(selected, body, access);
  const showsTrace = !latest || selected?.id === latest.id;
  const shown: ContentPreviewValue =
    body?.kind === "text" && loaded?.text !== undefined
      ? { ...value, text: loaded.text, missing: false }
      : body?.kind === "text"
        ? { ...value, missing: true }
        : value;
  const views = viewsOf(shown, body, showsTrace);
  const [view, setView] = useState<View>();
  const [wide, setWide] = useState(false);
  const [copied, copy] = useCopied();
  useEffect(() => {
    const trigger = document.activeElement;
    panel.current?.focus();
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  const latestId = latest?.id;
  const versionCount = delivered?.file.versions ?? 1;
  useEffect(() => {
    if (!latestId || !access || versionCount < 2) return;
    let current = true;
    access.versions(latestId).then(
      (items) => current && setVersions([...items].sort((a, b) => b.version - a.version)),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [latestId, access, versionCount]);
  const current = view && views.includes(view) ? view : (views[0] ?? "raw");
  const kind = shown.kind ?? "text";
  const copyText =
    current === "diff"
      ? (shown.diff ?? []).map((line) => `${line.sign}${line.text}`).join("\n")
      : shown.text;
  const labels: Readonly<Record<View, MessageId>> = {
    preview: PREVIEW_LABELS[kind] ?? "preview.raw",
    raw: kind === "markdown" || kind === "csv" ? "preview.raw" : "preview.source",
    diff: "preview.diff",
  };
  const textReady = !body || (body.kind === "text" && loaded?.text !== undefined);
  const loading = body && (body.kind === "text" || body.kind === "web") && !loaded?.failed;
  const pending =
    loading && (body.kind === "text" ? loaded?.text === undefined : loaded?.url === undefined);
  const versionLabel = (item: RegisteredFile) =>
    [
      message("files.version", { version: item.version }),
      delivered
        ? fileSourceText({ ...delivered.file, source: item.source, turn: item.turn }, message)
        : "",
      message("more.time", { at: new Date(item.createdAt) }),
      item.id === latest?.id ? message("preview.versionCurrent") : "",
    ]
      .filter(Boolean)
      .join(" · ");
  const fileActions = (labelled: boolean) => (
    <>
      {selected && body?.kind === "web" ? (
        <button
          type="button"
          className={labelled ? "preview-action" : "preview-action preview-tool"}
          aria-label={labelled ? undefined : message("preview.openTab")}
          data-tip={labelled ? undefined : message("preview.openTab")}
          onClick={() => {
            const preview = access?.previewUrl;
            if (preview) openInNewTab(() => preview(selected.id));
          }}
        >
          <LineIcon name="external" />
          {labelled ? message("preview.openTab") : null}
        </button>
      ) : null}
      {selected?.stored ? (
        <a
          className={labelled ? "preview-action" : "preview-action preview-tool"}
          href={fileContentUrl(selected.id, true)}
          download
          aria-label={labelled ? undefined : message("preview.download")}
          data-tip={labelled ? undefined : message("preview.download")}
        >
          <LineIcon name="download" />
          {labelled ? message("preview.download") : null}
        </a>
      ) : null}
    </>
  );
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
          <button
            type="button"
            className="preview-tool"
            aria-label={message("common.back")}
            data-tip={message("common.back")}
            onClick={onBack}
          >
            <LineIcon name="back" />
          </button>
        ) : (
          <span className="preview-icon">
            <LineIcon name="file" />
          </span>
        )}
        <span className="preview-title">
          <strong>{value.title}</strong>
          {!delivered && value.path && value.path !== value.title ? (
            <small>{value.path}</small>
          ) : null}
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
        {fileActions(false)}
        <button
          type="button"
          className="preview-action preview-tool preview-widen"
          aria-label={message(wide ? "preview.narrow" : "preview.widen")}
          data-tip={message(wide ? "preview.narrow" : "preview.widen")}
          aria-pressed={wide}
          onClick={() => setWide(!wide)}
        >
          <LineIcon name={wide ? "collapse" : "expand"} />
        </button>
        {(shown.missing && !shown.diff?.length) || !textReady ? null : (
          <button
            type="button"
            className="preview-tool"
            aria-label={message("preview.copy")}
            data-tip={message("preview.copy")}
            onClick={() => copy(copyText)}
          >
            <LineIcon name={copied ? "check" : "copy"} />
          </button>
        )}
        <button
          type="button"
          className="preview-tool"
          aria-label={message("common.close")}
          data-tip={message("common.close")}
          onClick={onClose}
        >
          <LineIcon name="close" />
        </button>
      </header>
      {delivered ? (
        <div className="preview-meta">
          {selected?.stored ? (
            <span className="preview-meta-actions">{fileActions(true)}</span>
          ) : null}
          <span>
            {fileFacts(
              selected
                ? {
                    ...delivered.file,
                    registered: selected,
                    source: selected.source,
                    turn: selected.turn,
                  }
                : delivered.file,
              message,
              { source: true, time: true },
            )}
          </span>
          {latest && versionCount > 1 ? (
            <button
              type="button"
              className="preview-versions"
              aria-expanded={versionsOpen}
              onClick={() => setVersionsOpen(!versionsOpen)}
            >
              {message("preview.versionOf", {
                version: selected?.version ?? latest.version,
                count: versionCount,
              })}
              <LineIcon name="chevron" />
            </button>
          ) : null}
          {versionsOpen && versions ? (
            <ul className="preview-version-list" aria-label={message("preview.versions")}>
              {versions.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    aria-pressed={item.id === selected?.id}
                    onClick={() => {
                      setSelectedId(item.id);
                      setVersionsOpen(false);
                    }}
                  >
                    {versionLabel(item)}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {delivered.source ? (
            <button type="button" className="preview-source-link" onClick={delivered.source.onOpen}>
              {delivered.source.label} →
            </button>
          ) : null}
        </div>
      ) : null}
      {selected?.overlapped ? (
        <p className="preview-notice">{message("preview.overlapped")}</p>
      ) : null}
      {body?.kind === "notice" ? <p className="preview-notice">{message(body.id)}</p> : null}
      {loaded?.failed ? (
        <p className="preview-notice">
          {message("preview.loadFailed")}{" "}
          <button type="button" className="preview-retry" onClick={retry}>
            {message("loading.retry")}
          </button>
        </p>
      ) : null}
      {!body && shown.missing ? (
        <p className="preview-notice">
          {message(shown.diff?.length ? "preview.editOnly" : "preview.missing")}
        </p>
      ) : null}
      {!body && kind === "html" && current === "raw" ? (
        <p className="preview-notice">{message("preview.htmlLater")}</p>
      ) : null}
      {current === "diff" && delivered && views.length ? (
        <p className="preview-notice">{message("preview.diffNote")}</p>
      ) : null}
      <div className="preview-body">
        {pending ? (
          <p className="preview-loading">{message("preview.loading")}</p>
        ) : current === "diff" && views.length ? (
          <DiffLines lines={shown.diff ?? []} />
        ) : body?.kind === "image" ? (
          <div className="preview-media">
            <img src={body.url} alt={value.title} />
          </div>
        ) : body?.kind === "pdf" ? (
          <iframe className="preview-frame is-pdf" src={body.url} title={value.title} />
        ) : body?.kind === "web" ? (
          loaded?.url ? (
            <div className="preview-isolated">
              <p className="preview-isolated-bar">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M5 11h14v9H5zM8 11V8a4 4 0 0 1 8 0v3" />
                </svg>
                {message("preview.isolated")}
              </p>
              <iframe
                className="preview-frame"
                src={loaded.url}
                title={value.title}
                sandbox="allow-scripts allow-modals allow-popups allow-downloads"
                referrerPolicy="no-referrer"
              />
            </div>
          ) : null
        ) : body?.kind === "notice" ? null : current === "preview" && kind === "markdown" ? (
          <MarkdownReader text={shown.text} label={message("preview.contents")} />
        ) : current === "preview" && kind === "csv" ? (
          <CsvTable
            text={shown.text}
            delimiter={fileExtension(value.title) === "tsv" ? "\t" : ","}
            message={message}
          />
        ) : shown.missing ? null : kind === "text" && !shown.path ? (
          <pre className="preview-plain">{shown.text}</pre>
        ) : (
          <SourceLines text={shown.text} />
        )}
      </div>
    </aside>
  );
}
