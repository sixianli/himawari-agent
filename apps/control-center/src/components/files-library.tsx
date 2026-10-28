import { useEffect, useRef, useState } from "react";
import { type DeliveredFile, FILE_KIND_LABELS, fileSize } from "../delivered-files.js";
import type { MessageId } from "../i18n/message-ids.js";
import type { RegisteredFile, RegisteredFileKind } from "../registered-files.js";
import { LineIcon } from "./answer-footer.js";
import { DeliveredFileRow } from "./delivered-file.js";
import { ActionButton } from "./primitives.js";
import { recentGroups } from "./thread-sidebar.js";

type Message = (id: MessageId, values?: Record<string, string | number | boolean | Date>) => string;

export type LibraryCategory = "all" | "documents" | "tables" | "web" | "images" | "code";

export const LIBRARY_CATEGORIES: readonly (readonly [
  LibraryCategory,
  MessageId,
  readonly RegisteredFileKind[],
])[] = [
  ["all", "library.all", []],
  ["documents", "library.documents", ["document", "pdf"]],
  ["tables", "library.tables", ["data"]],
  ["web", "library.web", ["web"]],
  ["images", "library.images", ["image"]],
  ["code", "library.code", ["code"]],
];

const PAGE = 100;

export interface LibraryQuery {
  readonly kind?: RegisteredFileKind;
  readonly search?: string;
  readonly before?: string | null;
  readonly limit?: number;
}

export function latestFiles(items: readonly RegisteredFile[]): readonly RegisteredFile[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.threadId}\u0000${item.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function libraryFile(file: RegisteredFile): DeliveredFile {
  return {
    key: file.id,
    name: file.path,
    path: file.path,
    kind: file.kind,
    runId: file.runId,
    turn: file.turn,
    source: file.source,
    command: undefined,
    versions: file.version,
    registered: file,
    trace: undefined,
  };
}

export function libraryTime(at: string, now: Date, message: Message): string {
  const date = new Date(at);
  return date.toDateString() === now.toDateString()
    ? message("more.time", { at: date })
    : message("library.date", { at: date });
}

export function FilesLibrary({
  list,
  threadTitle,
  openKey,
  onOpen,
  onBack,
  message,
}: {
  readonly list: (query: LibraryQuery) => Promise<{
    readonly items: readonly RegisteredFile[];
    readonly nextCursor: string | null;
  }>;
  readonly threadTitle: (threadId: string) => string | undefined;
  readonly openKey: string | undefined;
  readonly onOpen: (file: DeliveredFile) => void;
  readonly onBack: (() => void) | undefined;
  readonly message: Message;
}) {
  const [category, setCategory] = useState<LibraryCategory>("all");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<readonly RegisteredFile[]>();
  const [cursor, setCursor] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const sequence = useRef(0);
  const listRef = useRef(list);
  listRef.current = list;
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  const kinds = LIBRARY_CATEGORIES.find(([id]) => id === category)?.[2] ?? [];
  const kindKey = kinds.join(",");
  useEffect(() => {
    void attempt;
    const current = ++sequence.current;
    setFailed(false);
    setLoading(true);
    const selected = kindKey ? (kindKey.split(",") as RegisteredFileKind[]) : [undefined];
    Promise.all(
      selected.map((kind) =>
        listRef.current({ ...(kind ? { kind } : {}), search: query, limit: PAGE }),
      ),
    ).then(
      (pages) => {
        if (current !== sequence.current) return;
        setLoading(false);
        setItems(
          pages
            .flatMap((page) => page.items)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        );
        setCursor(selected.length === 1 ? (pages[0]?.nextCursor ?? null) : null);
      },
      () => {
        if (current !== sequence.current) return;
        setLoading(false);
        setFailed(true);
      },
    );
  }, [kindKey, query, attempt]);
  const loadMore = () => {
    if (!cursor) return;
    const current = sequence.current;
    void listRef
      .current({
        ...(kinds[0] ? { kind: kinds[0] } : {}),
        search: query,
        before: cursor,
        limit: PAGE,
      })
      .then((page) => {
        if (current !== sequence.current) return;
        setItems((prior) => [...(prior ?? []), ...page.items]);
        setCursor(page.nextCursor);
      })
      .catch(() => current === sequence.current && setFailed(true));
  };
  const files = latestFiles(items ?? []);
  const now = new Date();
  const groups = recentGroups(
    files.map((file) => ({ ...file, updatedAt: file.createdAt })),
    now,
  );
  return (
    <section className="files-library" aria-label={message("library.title")} aria-busy={loading}>
      <header className="files-library-head">
        {onBack ? (
          <ActionButton variant="quiet" aria-label={message("common.back")} onClick={onBack}>
            <LineIcon name="back" />
          </ActionButton>
        ) : null}
        <h1>{message("library.title")}</h1>
        {items ? (
          <span className="files-library-count">
            {message("library.count", { count: files.length })}
          </span>
        ) : null}
      </header>
      <div className="files-library-body">
        <label className="files-library-search">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="6" />
            <path d="M20 20l-4.5-4.5" />
          </svg>
          <input
            type="search"
            value={search}
            placeholder={message("library.search")}
            aria-label={message("library.search")}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <fieldset className="files-library-chips">
          <legend className="sr-only">{message("library.title")}</legend>
          {LIBRARY_CATEGORIES.map(([id, label]) => (
            <button
              type="button"
              key={id}
              aria-pressed={category === id}
              onClick={() => setCategory(id)}
            >
              {message(label)}
            </button>
          ))}
        </fieldset>
        {failed ? (
          <p className="files-library-note">
            {message("library.loadFailed")}{" "}
            <button type="button" className="preview-retry" onClick={() => setAttempt(attempt + 1)}>
              {message("loading.retry")}
            </button>
          </p>
        ) : !items ? (
          <div className="files-library-skeleton" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
        ) : !files.length ? (
          <p className="files-library-note">
            {message(query || category !== "all" ? "library.noMatch" : "library.empty")}
          </p>
        ) : (
          groups.map(([label, group]) => (
            <section key={label}>
              <h2 className="more-section">{message(label)}</h2>
              {group.map((file) => {
                const title = threadTitle(file.threadId);
                return (
                  <DeliveredFileRow
                    key={file.id}
                    className="more-row files-library-row"
                    file={libraryFile(file)}
                    open={file.id === openKey}
                    onOpen={() => onOpen(libraryFile(file))}
                    message={message}
                    subtitle={[
                      message(FILE_KIND_LABELS[file.kind]),
                      fileSize(file.sizeBytes),
                      title
                        ? message("files.from", { title, turn: file.turn })
                        : message("files.fromPlain", { turn: file.turn }),
                    ].join(" · ")}
                    trailing={libraryTime(file.createdAt, now, message)}
                  />
                );
              })}
            </section>
          ))
        )}
        {cursor && !failed ? (
          <ActionButton variant="quiet" onClick={loadMore}>
            {message("review.loadMore")}
          </ActionButton>
        ) : null}
      </div>
    </section>
  );
}
