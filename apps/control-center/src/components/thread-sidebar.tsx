import type { ThreadGatewaySnapshot } from "@himawari-agent/gateway-contracts";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { type ControlCenterRouteState, controlCenterHref } from "../app/router.js";
import { useControlCenterIntl } from "../i18n/runtime.js";
import { LineIcon } from "./answer-footer.js";
import { Glyph } from "./glyphs.js";
import { ActionButton, ActionMenu, AppLink } from "./index.js";
import { SidebarIcon } from "./sidebar-icon.js";
import { ThreadLoadingSkeleton } from "./thread-load-feedback.js";

type Thread = Extract<
  ThreadGatewaySnapshot,
  { type: "thread.detail_snapshot" }
>["payload"]["thread"];
type RecentGroup = "threads.today" | "threads.yesterday" | "threads.earlier";

const dayStart = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

export function recentGroups<T extends { readonly updatedAt: string }>(
  threads: readonly T[],
  now = new Date(),
): readonly (readonly [RecentGroup, readonly T[]])[] {
  const today = dayStart(now);
  const yesterday = dayStart(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const groups: Record<RecentGroup, T[]> = {
    "threads.today": [],
    "threads.yesterday": [],
    "threads.earlier": [],
  };
  for (const thread of threads) {
    const at = Date.parse(thread.updatedAt);
    groups[
      at >= today ? "threads.today" : at >= yesterday ? "threads.yesterday" : "threads.earlier"
    ].push(thread);
  }
  return (Object.entries(groups) as [RecentGroup, T[]][]).filter(([, items]) => items.length);
}

export interface ThreadSidebarProps {
  readonly threads: readonly Thread[];
  readonly searchResults?: readonly Thread[];
  readonly contentByRef: Readonly<Record<string, string>>;
  readonly loading: boolean;
  readonly hasLoaded: boolean;
  readonly feedback?: ReactNode;
  readonly searchFeedback?: ReactNode;
  readonly searchText: string;
  readonly route: ControlCenterRouteState;
  readonly selectedThreadId: string | null;
  readonly onSearchTextChange: (text: string) => void;
  readonly onSearch: () => void;
  readonly onLoadMore?: (() => void) | undefined;
  readonly mainThreadId?: string | null;
  readonly onRefresh: () => void;
  readonly onNavigate: (route: ControlCenterRouteState) => void;
  readonly onRename?: (thread: Thread) => void;
  readonly onPin?: (thread: Thread) => void;
  readonly onArchive?: (thread: Thread) => void;
  readonly onDelete?: (thread: Thread) => void;
  readonly renamingThreadId?: string | null;
  readonly renameValue?: string;
  readonly renameChanged?: boolean;
  readonly onRenameValueChange?: (value: string) => void;
  readonly onRenameCommit?: () => void;
  readonly onRenameCancel?: () => void;
  readonly deletingThreadId?: string | null;
  readonly onDeleteConfirm?: () => void;
  readonly onDeleteCancel?: () => void;
  readonly onOpenFiles?: (() => void) | undefined;
  readonly onOpenMemory?: (() => void) | undefined;
  readonly onOpenReminders?: (() => void) | undefined;
  readonly openPage?: "files" | "memory" | "reminders" | null;
  readonly remindersDue?: number;
  readonly pendingThreadIds?: readonly string[];
  readonly runningThreadIds?: readonly string[];
}
export function ThreadSidebar({
  threads,
  searchResults = [],
  contentByRef,
  loading,
  hasLoaded,
  feedback,
  searchFeedback,
  searchText,
  route,
  selectedThreadId,
  onSearchTextChange,
  onSearch,
  mainThreadId,
  onLoadMore,
  onNavigate,
  onRename,
  onPin,
  onArchive,
  onDelete,
  renamingThreadId = null,
  renameValue = "",
  renameChanged = false,
  onRenameValueChange,
  onRenameCommit,
  onRenameCancel,
  deletingThreadId = null,
  onDeleteConfirm,
  onDeleteCancel,
  onOpenFiles,
  onOpenMemory,
  onOpenReminders,
  openPage = null,
  remindersDue = 0,
  pendingThreadIds = [],
  runningThreadIds = [],
}: ThreadSidebarProps) {
  const { message } = useControlCenterIntl();
  const [searched, setSearched] = useState(false);
  const renameEnded = useRef(false);
  const endRename = (commit: boolean) => {
    if (renameEnded.current) return;
    renameEnded.current = true;
    if (commit && renameChanged) onRenameCommit?.();
    else onRenameCancel?.();
  };
  const startRename = useCallback((node: HTMLInputElement | null) => {
    if (!node) return;
    renameEnded.current = false;
    node.focus();
  }, []);
  const filesOpen = openPage !== null;
  const title = (thread: Thread) =>
    thread.threadId === mainThreadId
      ? message("chat.main")
      : (thread.titleRef && contentByRef[thread.titleRef]) || message("chat.untitled");
  const list = threads.filter(
    (thread) =>
      thread.status === "active" &&
      thread.threadId !== mainThreadId &&
      (thread.messageWatermark > 0 ||
        thread.sourceThreadId !== null ||
        thread.threadId === selectedThreadId),
  );
  const pinned = list
    .filter((thread) => thread.pinOrder !== null)
    .sort((a, b) => (a.pinOrder ?? 0) - (b.pinOrder ?? 0));
  const recent = list
    .filter((thread) => thread.pinOrder === null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const link = (thread: Thread) => (
    <AppLink
      current={!filesOpen && thread.threadId === selectedThreadId}
      href={controlCenterHref({
        ...route,
        objectId: thread.threadId,
        status: null,
        view: "content",
      })}
      title={title(thread)}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        onNavigate({ ...route, objectId: thread.threadId, status: null, view: "content" });
      }}
    >
      {pendingThreadIds.includes(thread.threadId) ? (
        <span
          className="thread-attention"
          role="img"
          aria-label={message("review.needsAttention")}
        />
      ) : runningThreadIds.includes(thread.threadId) ? (
        <span
          className="thread-running"
          role="img"
          aria-label={message("chat.environment.threadRunning")}
        />
      ) : (
        <span className="thread-dot-space" />
      )}
      {thread.sourceThreadId ? (
        <span className="thread-fork-mark" role="img" aria-label={message("fork.mark")}>
          <LineIcon name="fork" />
        </span>
      ) : null}
      <span>{title(thread)}</span>
    </AppLink>
  );
  const row = (thread: Thread) =>
    renamingThreadId === thread.threadId ? (
      <li className="thread-row thread-row-editing" key={thread.threadId}>
        <input
          className="thread-rename-input"
          ref={startRename}
          aria-label={message("review.conversationName")}
          value={renameValue}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => onRenameValueChange?.(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              endRename(true);
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              endRename(false);
            }
          }}
          onBlur={() => endRename(true)}
        />
      </li>
    ) : deletingThreadId === thread.threadId ? (
      <li
        className="thread-row thread-row-confirming"
        key={thread.threadId}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onDeleteCancel?.();
          }
        }}
      >
        <span className="thread-confirm-text">{message("threads.deleteTitle")}</span>
        <ActionButton
          variant="secondary"
          className="thread-confirm-button"
          data-autofocus
          autoFocus
          onClick={onDeleteCancel}
        >
          {message("governed.cancel")}
        </ActionButton>
        <ActionButton variant="danger" className="thread-confirm-button" onClick={onDeleteConfirm}>
          {message("threads.delete")}
        </ActionButton>
      </li>
    ) : (
      <li
        className="thread-row"
        data-pinned={thread.pinOrder !== null}
        key={thread.threadId}
        onContextMenu={(event) => {
          event.preventDefault();
          event.currentTarget.querySelector<HTMLButtonElement>(".action-menu > button")?.click();
        }}
      >
        {link(thread)}
        <ActionMenu
          label={
            <>
              <Glyph name="more" size={18} />
              <span className="sr-only">{message("review.conversationActions")}</span>
            </>
          }
          items={[
            {
              id: "rename",
              label: (
                <>
                  <SidebarIcon name="rename" />
                  {message("threads.rename")}
                </>
              ),
              onSelect: () => onRename?.(thread),
            },
            {
              id: "pin",
              label: (
                <>
                  <SidebarIcon name="pin" />
                  {message(thread.pinOrder === null ? "threads.pin" : "threads.unpin")}
                </>
              ),
              onSelect: () => onPin?.(thread),
            },
            {
              id: "archive",
              separated: true,
              label: (
                <>
                  <SidebarIcon name="archive" />
                  {message("threads.archive")}
                </>
              ),
              onSelect: () => onArchive?.(thread),
            },
            {
              id: "delete",
              danger: true,
              label: (
                <>
                  <SidebarIcon name="trash" />
                  {message("threads.delete")}
                </>
              ),
              onSelect: () => onDelete?.(thread),
            },
          ]}
        />
      </li>
    );
  return (
    <div className="thread-list-controls">
      <nav className="thread-sidebar-actions" aria-label={message("nav.threads")}>
        {mainThreadId ? (
          <AppLink
            className="thread-sidebar-main"
            current={!filesOpen && selectedThreadId === mainThreadId}
            href={controlCenterHref({
              ...route,
              objectId: mainThreadId,
              status: null,
              view: "content",
            })}
            onClick={(event) => {
              if (
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              onNavigate({ ...route, objectId: mainThreadId, status: null, view: "content" });
            }}
          >
            <SidebarIcon name="compose" />
            {message("chat.main")}
            {pendingThreadIds.includes(mainThreadId) ? (
              <span
                className="thread-attention"
                role="img"
                aria-label={message("review.needsAttention")}
              />
            ) : runningThreadIds.includes(mainThreadId) ? (
              <span
                className="thread-running"
                role="img"
                aria-label={message("chat.environment.threadRunning")}
              />
            ) : null}
          </AppLink>
        ) : null}
        <search className="thread-search-landmark">
          <form
            className="thread-search"
            onSubmit={(event) => {
              event.preventDefault();
              if (!searchText.trim()) return;
              setSearched(true);
              onSearch();
            }}
          >
            <SidebarIcon name="search" />
            <input
              type="search"
              autoComplete="off"
              enterKeyHint="search"
              aria-label={message("threads.search")}
              placeholder={message("threads.search")}
              value={searchText}
              onChange={(event) => {
                onSearchTextChange(event.target.value);
                if (!event.target.value.trim()) setSearched(false);
              }}
            />
          </form>
        </search>
        {onOpenMemory ? (
          <ActionButton onClick={onOpenMemory} variant="quiet" aria-pressed={openPage === "memory"}>
            <SidebarIcon name="memory" />
            {message("nav.memory")}
          </ActionButton>
        ) : null}
        {onOpenReminders ? (
          <ActionButton
            onClick={onOpenReminders}
            variant="quiet"
            aria-pressed={openPage === "reminders"}
          >
            <SidebarIcon name="reminders" />
            {message("nav.reminders")}
            {remindersDue ? (
              <span
                className="nav-dot"
                role="img"
                aria-label={message("reminders.due", { count: remindersDue })}
              />
            ) : null}
          </ActionButton>
        ) : null}
        {onOpenFiles ? (
          <ActionButton onClick={onOpenFiles} variant="quiet" aria-pressed={openPage === "files"}>
            <SidebarIcon name="files" />
            {message("library.title")}
          </ActionButton>
        ) : null}
      </nav>
      <div
        className="thread-sidebar-records"
        aria-busy={loading}
        onScroll={(event) => {
          const el = event.currentTarget;
          if (!searched && el.scrollHeight - el.scrollTop - el.clientHeight < 80) onLoadMore?.();
        }}
      >
        {searched ? (
          <>
            {searchFeedback}
            <ul className="semantic-list thread-search-results">
              {searchResults.map((thread) => (
                <li key={thread.threadId}>
                  {link(thread)}
                  {thread.status === "archived" ? (
                    <small>{message("threads.status.archived")}</small>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            {feedback}
            {!hasLoaded ? <ThreadLoadingSkeleton scope="list" /> : null}
            {pinned.length ? (
              <section className="thread-group">
                <h2>{message("chat.pinned")}</h2>
                <ul>{pinned.map(row)}</ul>
              </section>
            ) : null}
            {recentGroups(recent).map(([id, items]) => (
              <section className="thread-group" key={id}>
                <h2>{message(id)}</h2>
                <ul>{items.map(row)}</ul>
              </section>
            ))}
          </>
        )}
        {onLoadMore && !searched ? (
          <ActionButton variant="quiet" disabled={loading} onClick={onLoadMore}>
            {message("review.loadMore")}
          </ActionButton>
        ) : null}
      </div>
    </div>
  );
}
