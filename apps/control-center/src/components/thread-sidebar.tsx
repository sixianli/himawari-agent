import type { ThreadGatewaySnapshot } from "@himawari-agent/gateway-contracts";
import { controlCenterHref, routeForSurface, type ControlCenterRouteState } from "../app/router.js";
import { useControlCenterIntl } from "../i18n/runtime.js";
import { ActionButton, AppLink, SemanticList } from "./index.js";
import { SidebarIcon } from "./sidebar-icon.js";

type Thread = Extract<
  ThreadGatewaySnapshot,
  { type: "thread.detail_snapshot" }
>["payload"]["thread"];

export interface ThreadSidebarProps {
  readonly threads: readonly Thread[];
  readonly contentByRef: Readonly<Record<string, string>>;
  readonly loading: boolean;
  readonly searchText: string;
  readonly route: ControlCenterRouteState;
  readonly selectedThreadId: string | null;
  readonly onSearchTextChange: (text: string) => void;
  readonly onSearch: () => void;
  readonly onCreate: () => void;
  readonly onRefresh: () => void;
  readonly onNavigate: (route: ControlCenterRouteState) => void;
}

export function ThreadSidebar({
  threads,
  contentByRef,
  loading,
  searchText,
  route,
  selectedThreadId,
  onSearchTextChange,
  onSearch,
  onCreate,
  onRefresh,
  onNavigate,
}: ThreadSidebarProps) {
  const { message } = useControlCenterIntl();
  const pinned = threads
    .filter((thread) => thread.pinOrder !== null)
    .sort((a, b) => (a.pinOrder ?? 0) - (b.pinOrder ?? 0));
  const recent = threads.filter((thread) => thread.pinOrder === null);
  const renderThread = (thread: Thread) => {
    const title = (thread.titleRef && contentByRef[thread.titleRef]) || message("chat.untitled");
    return (
      <AppLink
        current={thread.threadId === selectedThreadId}
        href={controlCenterHref({ ...route, objectId: thread.threadId, view: "content" })}
        title={title}
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
          onNavigate({ ...route, objectId: thread.threadId, view: "content" });
        }}
      >
        <span>{title}</span>
      </AppLink>
    );
  };
  return (
    <div className="thread-list-controls">
      <div className="thread-sidebar-actions">
        <ActionButton onClick={onCreate} variant="quiet">
          <SidebarIcon name="compose" />
          {message("threads.new")}
        </ActionButton>
        <details className="thread-search-disclosure">
          <summary>
            <SidebarIcon name="search" />
            {message("threads.search")}
          </summary>
          <form
            className="thread-search"
            onSubmit={(event) => {
              event.preventDefault();
              onSearch();
            }}
          >
            <input
              aria-label={message("threads.search")}
              placeholder={message("threads.searchPlaceholder")}
              type="search"
              value={searchText}
              onChange={(event) => onSearchTextChange(event.target.value)}
            />
            <ActionButton
              aria-label={message("threads.search")}
              disabled={!searchText.trim()}
              type="submit"
              variant="quiet"
            >
              <SidebarIcon name="search" />
            </ActionButton>
          </form>
        </details>
        <AppLink
          href="/approvals"
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
            onNavigate(routeForSurface("approvals", { view: "content" }));
          }}
        >
          <SidebarIcon name="approvals" />
          {message("nav.approvals")}
        </AppLink>
      </div>
      <div className="thread-sidebar-records">
        <div className="thread-collection-heading">
          <select
            aria-label={message("threads.filter")}
            value={route.status ?? "active"}
            onChange={(event) =>
              onNavigate({
                ...route,
                status: event.target.value === "active" ? null : event.target.value,
                afterCursor: null,
              })
            }
          >
            <option value="active">{message("threads.filterActive")}</option>
            <option value="archived">{message("threads.filterArchived")}</option>
            <option value="all">{message("threads.filterAll")}</option>
          </select>
          <ActionButton onClick={onRefresh} aria-label={message("common.refresh")} variant="quiet">
            <SidebarIcon name="refresh" />
          </ActionButton>
        </div>
        {pinned.length > 0 ? (
          <details className="thread-group" open>
            <summary>{message("chat.pinned")}</summary>
            <SemanticList
              empty={null}
              items={pinned}
              getId={(thread) => thread.threadId}
              label={message("chat.pinned")}
              renderItem={renderThread}
            />
          </details>
        ) : null}
        <details className="thread-group" open>
          <summary>{message("threads.recent")}</summary>
          <SemanticList
            empty={loading ? message("state.loading") : message("common.noRecords")}
            items={recent}
            getId={(thread) => thread.threadId}
            label={message("threads.recent")}
            renderItem={renderThread}
          />
        </details>
      </div>
    </div>
  );
}
