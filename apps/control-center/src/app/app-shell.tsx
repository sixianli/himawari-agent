import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { ControlCenterPreferences, ControlCenterUiLocale } from "../browser-storage.js";
import { SettingsDialog } from "../components/settings-dialog.js";
import { SidebarIcon } from "../components/sidebar-icon.js";
import { HimawariBrand } from "../components/brand.js";
import { ActionButton, AppLink } from "../components/index.js";
import { useControlCenterIntl } from "../i18n/runtime.js";
import { type ControlCenterRouteState, routeForSurface } from "./router.js";

export interface ControlCenterShellProps {
  readonly builtInIdentity?: boolean;
  readonly healthDependenciesAvailable?: boolean;
  readonly installedGatewayV2Operations?: readonly string[];
  readonly connection: "connecting" | "connected" | "offline" | null;
  readonly content: ReactNode;
  readonly details: ReactNode;
  readonly settingsTools?: ReactNode;
  readonly settingsData?: ReactNode;
  readonly list: ReactNode;
  readonly locale: ControlCenterUiLocale;
  readonly onLocaleChange: (locale: ControlCenterUiLocale) => void;
  readonly onNavigate: (state: ControlCenterRouteState) => void;
  readonly onPreferencesChange: (preferences: ControlCenterPreferences) => void;
  readonly pageTitle: ReactNode;
  readonly preferences: ControlCenterPreferences;
  readonly route: ControlCenterRouteState;
}

function shouldHandleNavigation(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

export function ControlCenterShell({
  content,
  connection,
  details,
  settingsTools,
  settingsData,
  list,
  locale,
  onLocaleChange,
  onNavigate,
  onPreferencesChange,
  pageTitle,
  preferences,
  route,
}: ControlCenterShellProps) {
  const { message } = useControlCenterIntl();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const collapseRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLButtonElement>(null);
  const sidebarFocusRequested = useRef(false);
  useEffect(() => {
    if (!sidebarFocusRequested.current) return;
    sidebarFocusRequested.current = false;
    (sidebarCollapsed ? restoreRef : collapseRef).current?.focus();
  }, [sidebarCollapsed]);
  const toggleSidebar = (collapsed: boolean) => {
    sidebarFocusRequested.current = true;
    setSidebarCollapsed(collapsed);
  };
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    void route.objectId;
    setSettingsOpen(false);
  }, [route.objectId]);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const routeFocusKey = `${route.surfaceId}:${route.objectId ?? ""}:${route.view}`;
  useEffect(() => {
    if (routeFocusKey) {
      headingRef.current?.focus({ preventScroll: true });
    }
  }, [routeFocusKey]);
  const updateView = (view: ControlCenterRouteState["view"]) => onNavigate({ ...route, view });

  return (
    <div
      className="app-shell"
      data-connection={connection ?? "connecting"}
      data-density={preferences.density}
      data-sidebar-collapsed={sidebarCollapsed}
      data-mobile-view={route.view}
      data-details-open={route.surfaceId !== "threads" && route.view === "details"}
      data-surface={route.surfaceId}
      style={{ "--detail-pane-percent": `${preferences.detailPanePercent}%` } as CSSProperties}
    >
      <AppLink className="skip-link" href="#main-content">
        {message("app.skipToMain")}
      </AppLink>
      <aside className="sidebar" aria-label={message("nav.label")}>
        <div className="brand-heading">
          <a
            className="brand-link"
            href="/threads"
            onClick={(event) => {
              if (!shouldHandleNavigation(event)) return;
              event.preventDefault();
              onNavigate(routeForSurface("threads", { view: "content" }));
            }}
          >
            <HimawariBrand wordmark />
          </a>
          <ActionButton
            className="desktop-sidebar-toggle"
            ref={collapseRef}
            variant="quiet"
            aria-label={message("layout.hideList")}
            aria-expanded={!sidebarCollapsed}
            onClick={() => toggleSidebar(true)}
          >
            <SidebarIcon name="panel" />
          </ActionButton>
        </div>
        <section className="list-pane" aria-label={message("common.currentRecords")}>
          {list}
        </section>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <ActionButton
            className="desktop-sidebar-restore"
            ref={restoreRef}
            variant="quiet"
            aria-label={message("layout.showList")}
            aria-expanded={!sidebarCollapsed}
            onClick={() => toggleSidebar(false)}
          >
            <SidebarIcon name="panel" />
          </ActionButton>
          <ActionButton
            className="mobile-sidebar-toggle"
            aria-label={message("layout.showList")}
            aria-expanded={route.view === "list"}
            onClick={() => updateView(route.view === "list" ? "content" : "list")}
            variant="quiet"
          >
            <SidebarIcon name="panel" />
          </ActionButton>
          <div className="page-heading">
            <h1 id="page-title" ref={headingRef} tabIndex={-1}>
              {pageTitle}
            </h1>
          </div>
          <div className="topbar-controls">
            <ActionButton
              aria-label={message("settings.title")}
              variant="quiet"
              onClick={() => setSettingsOpen(true)}
            >
              <SidebarIcon name="settings" />
            </ActionButton>
          </div>
        </header>
        <main className="workspace-layout" id="main-content">
          <section aria-labelledby="page-title" className="content-pane">
            {content}
          </section>
          {route.surfaceId === "threads" ? (
            details
          ) : route.view === "details" ? (
            <aside className="details-pane">{details}</aside>
          ) : null}
        </main>
      </div>
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        locale={locale}
        onLocaleChange={onLocaleChange}
        preferences={preferences}
        onPreferencesChange={onPreferencesChange}
        tools={settingsTools}
        data={settingsData}
      />
    </div>
  );
}
