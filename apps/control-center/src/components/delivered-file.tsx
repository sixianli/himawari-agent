import { type DeliveredFile, FILE_KIND_LABELS, fileBadge, fileSize } from "../delivered-files.js";
import type { MessageId } from "../i18n/message-ids.js";
import { lineCount } from "../turn-files.js";

type Message = (id: MessageId, values?: Record<string, string | number | boolean | Date>) => string;

export const ANSWER_FILE_CARDS = 3;

export function fileSizeText(file: DeliveredFile, message: Message): string | undefined {
  if (file.registered) return fileSize(file.registered.sizeBytes);
  if (!file.trace) return undefined;
  if (file.trace.diff.length) return `+${file.trace.added} −${file.trace.removed}`;
  return file.trace.content === undefined
    ? undefined
    : message("files.lines", { count: lineCount(file.trace.content) });
}

export function fileSourceText(file: DeliveredFile, message: Message): string {
  if (file.source === "bash")
    return file.command
      ? message("files.byCommand", { command: file.command })
      : message("files.byCommandPlain");
  return message(
    file.source === "upload"
      ? "more.file.uploaded"
      : file.source === "write"
        ? "more.file.written"
        : "more.file.edited",
    { turn: file.turn },
  );
}

export function fileFacts(
  file: DeliveredFile,
  message: Message,
  parts: { readonly version?: boolean; readonly source?: boolean; readonly time?: boolean },
): string {
  const facts = [message(FILE_KIND_LABELS[file.kind])];
  const size = fileSizeText(file, message);
  if (size) facts.push(size);
  if (parts.version && file.registered && file.versions > 1)
    facts.push(message("files.version", { version: file.registered.version }));
  if (parts.source) facts.push(fileSourceText(file, message));
  if (parts.time && file.registered)
    facts.push(message("more.time", { at: new Date(file.registered.createdAt) }));
  return facts.join(" · ");
}

export function FileBadge({ name }: { readonly name: string }) {
  return (
    <span className="delivered-badge" aria-hidden="true">
      {fileBadge(name)}
    </span>
  );
}

export function DeliveredFileCards({
  files,
  openKey,
  onOpen,
  onMore,
  message,
}: {
  readonly files: readonly DeliveredFile[];
  readonly openKey: string | undefined;
  readonly onOpen: (file: DeliveredFile) => void;
  readonly onMore: (() => void) | undefined;
  readonly message: Message;
}) {
  if (!files.length) return null;
  const shown = onMore ? files.slice(0, ANSWER_FILE_CARDS) : files;
  const hidden = files.length - shown.length;
  return (
    <ul className="answer-files" aria-label={message("files.label")}>
      {shown.map((file) => {
        const open = file.key === openKey;
        const facts = fileFacts(file, message, {});
        return (
          <li key={file.key}>
            <button
              type="button"
              className="file-card"
              aria-pressed={open}
              title={file.path}
              onClick={() => onOpen(file)}
            >
              <FileBadge name={file.name} />
              <span className="file-main">
                <span className="file-name">{file.name}</span>
                <span className="file-meta">
                  {open ? `${facts} · ${message("files.opened")}` : facts}
                </span>
              </span>
            </button>
          </li>
        );
      })}
      {hidden > 0 && onMore ? (
        <li>
          <button type="button" className="file-more" onClick={onMore}>
            {message("files.more", { count: hidden })}
          </button>
        </li>
      ) : null}
    </ul>
  );
}

export function DeliveredFileRow({
  file,
  open,
  onOpen,
  message,
  className = "more-row",
  subtitle,
  trailing,
}: {
  readonly file: DeliveredFile;
  readonly open: boolean;
  readonly onOpen: () => void;
  readonly message: Message;
  readonly className?: string;
  readonly subtitle?: string;
  readonly trailing?: string;
}) {
  return (
    <button
      type="button"
      className={open ? `${className} is-open` : className}
      title={file.path}
      aria-pressed={open}
      onClick={onOpen}
    >
      <FileBadge name={file.name} />
      <span className="more-row-text">
        <span className="more-row-name">{file.name}</span>
        <small>
          {subtitle ?? fileFacts(file, message, { version: true, source: true, time: true })}
        </small>
      </span>
      {trailing ? <span className="delivered-time">{trailing}</span> : null}
    </button>
  );
}
