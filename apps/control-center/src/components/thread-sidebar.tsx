import { useState, type ReactNode } from "react";
import type { ThreadGatewaySnapshot } from "@himawari-agent/gateway-contracts";
import { controlCenterHref, type ControlCenterRouteState } from "../app/router.js";
import { useControlCenterIntl } from "../i18n/runtime.js";
import { ActionButton, AppLink, ActionMenu, ModalDialog } from "./index.js";
import { SidebarIcon } from "./sidebar-icon.js";
import { ThreadLoadingSkeleton } from "./thread-load-feedback.js";
type Thread = Extract<
  ThreadGatewaySnapshot,
  { type: "thread.detail_snapshot" }
>["payload"]["thread"];
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
  readonly onCreate: () => void;
  readonly onRefresh: () => void;
  readonly onNavigate: (route: ControlCenterRouteState) => void;
  readonly onRename?: (thread: Thread) => void;
  readonly onPin?: (thread: Thread) => void;
  readonly onArchive?: (thread: Thread) => void;
  readonly pendingThreadIds?: readonly string[];
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
  onCreate,
  onLoadMore,
  onNavigate,
  onRename,
  onPin,
  onArchive,
  pendingThreadIds = [],
}: ThreadSidebarProps) {
  const { message } = useControlCenterIntl();
  const [searchOpen, setSearchOpen] = useState(false);
  const title = (thread: Thread) =>
    (thread.titleRef && contentByRef[thread.titleRef]) || message("chat.untitled");
  const list = threads.filter((thread) => thread.status === "active");
  const pinned = list
    .filter((thread) => thread.pinOrder !== null)
    .sort((a, b) => (a.pinOrder ?? 0) - (b.pinOrder ?? 0));
  const recent = list
    .filter((thread) => thread.pinOrder === null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const link = (thread: Thread) => (
    <AppLink
      current={thread.threadId === selectedThreadId}
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
        setSearchOpen(false);
        onNavigate({ ...route, objectId: thread.threadId, status: null, view: "content" });
      }}
    >
      {pendingThreadIds.includes(thread.threadId) ? (
        <span
          className="thread-attention"
          role="img"
          aria-label={message("review.needsAttention")}
        />
      ) : (
        <span className="thread-dot-space" />
      )}
      <span>{title(thread)}</span>
    </AppLink>
  );
  const row = (thread: Thread) => (
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
            <span aria-hidden="true">⋯</span>
            <span className="sr-only">{message("review.conversationActions")}</span>
          </>
        }
        items={[
          {
            id: "rename",
            label: (
              <>
                <SidebarIcon name="compose" />
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
            label: (
              <>
                <SidebarIcon name="archive" />
                {message("threads.archive")}
              </>
            ),
            onSelect: () => onArchive?.(thread),
          },
        ]}
      />
    </li>
  );
  return (
    <div className="thread-list-controls">
      <nav className="thread-sidebar-actions" aria-label={message("nav.threads")}>
        <ActionButton onClick={onCreate} variant="quiet">
          <SidebarIcon name="compose" />
          {message("threads.new")}
        </ActionButton>
        <ActionButton onClick={() => setSearchOpen(true)} variant="quiet">
          <SidebarIcon name="search" />
          {message("threads.search")}
        </ActionButton>
      </nav>
      <div
        className="thread-sidebar-records"
        aria-busy={loading}
        onScroll={(event) => {
          const el = event.currentTarget;
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) onLoadMore?.();
        }}
      >
        {feedback}
        {!hasLoaded ? <ThreadLoadingSkeleton scope="list" /> : null}
        {pinned.length ? (
          <section className="thread-group">
            <h2>{message("chat.pinned")}</h2>
            <ul>{pinned.map(row)}</ul>
          </section>
        ) : null}
        <section className="thread-group">
          <h2>{message("threads.recent")}</h2>
          <ul>{recent.map(row)}</ul>
        </section>
        {onLoadMore ? (
          <ActionButton variant="quiet" disabled={loading} onClick={onLoadMore}>
            {message("review.loadMore")}
          </ActionButton>
        ) : null}
      </div>
      {searchOpen ? (
        <ModalDialog
          open={searchOpen}
          title={message("threads.search")}
          closeLabel={message("common.close")}
          onClose={() => setSearchOpen(false)}
        >
          <form
            className="thread-search"
            onSubmit={(event) => {
              event.preventDefault();
              onSearch();
            }}
          >
            <input
              type="search"
              autoComplete="off"
              aria-label={message("threads.search")}
              placeholder={message("threads.searchPlaceholder")}
              value={searchText}
              onChange={(event) => onSearchTextChange(event.target.value)}
            />
            <ActionButton type="submit" disabled={!searchText.trim()}>
              {message("threads.search")}
            </ActionButton>
          </form>
          {searchFeedback}
          <ul className="thread-search-results">
            {searchResults.map((thread) => (
              <li key={thread.threadId}>
                {link(thread)}
                {thread.status === "archived" ? (
                  <small>{message("threads.status.archived")}</small>
                ) : null}
              </li>
            ))}
          </ul>
        </ModalDialog>
      ) : null}
    </div>
  );
}
