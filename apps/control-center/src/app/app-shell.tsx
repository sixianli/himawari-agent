import type { MouseEvent, ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ControlCenterPreferences, ControlCenterUiLocale } from "../browser-storage.js";
import { HimawariBrand } from "../components/brand.js";
import { ActionButton, AppLink } from "../components/index.js";
import { OPEN_NOTIFICATION_SETTINGS } from "../components/memory-panel.js";
import { SettingsDialog } from "../components/settings-dialog.js";
import { SidebarIcon } from "../components/sidebar-icon.js";
import { useControlCenterIntl } from "../i18n/runtime.js";
import { OPEN_SETTINGS, settingsTabOf } from "../proactive.js";
import { type ControlCenterRouteState, routeForSurface } from "./router.js";

export interface ControlCenterShellProps {
  readonly builtInIdentity?: boolean;
  readonly healthDependenciesAvailable?: boolean;
  readonly installedGatewayV2Operations?: readonly string[];
  readonly connection: "connecting" | "connected" | "offline" | null;
  readonly content: ReactNode;
  readonly details: ReactNode;
  readonly topbarStart?: ReactNode;
  readonly topbarActions?: ReactNode;
  readonly settingsTools?: ReactNode;
  readonly settingsData?: ReactNode;
  readonly settingsNotifications?: ReactNode;
  readonly settingsPersonalization?: ReactNode;
  readonly settingsAccount?: ReactNode;
  readonly list: ReactNode;
  readonly locale: ControlCenterUiLocale;
  readonly onLocaleChange: (locale: ControlCenterUiLocale) => void;
  readonly onNavigate: (state: ControlCenterRouteState, replace?: boolean) => void;
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
  topbarStart,
  topbarActions,
  settingsTools,
  settingsData,
  settingsNotifications,
  settingsPersonalization,
  settingsAccount,
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
  const settingsOpen = route.page === "settings";
  const settingsTab = ["personalization", "notifications", "tools", "data"].includes(
    route.pageTab ?? "",
  )
    ? (route.pageTab as string)
    : "general";
  const routeRef = useRef(route);
  routeRef.current = route;
  const showSettings = useCallback(
    (tab: string | null, replace = false) =>
      onNavigate({ ...routeRef.current, page: "settings", pageTab: tab }, replace),
    [onNavigate],
  );
  useEffect(() => {
    const openNotifications = () => showSettings("notifications");
    const openTab = (event: Event) => showSettings(settingsTabOf(event));
    window.addEventListener(OPEN_NOTIFICATION_SETTINGS, openNotifications);
    window.addEventListener(OPEN_SETTINGS, openTab);
    return () => {
      window.removeEventListener(OPEN_NOTIFICATION_SETTINGS, openNotifications);
      window.removeEventListener(OPEN_SETTINGS, openTab);
    };
  }, [showSettings]);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const routeFocusKey = `${route.surfaceId}:${route.objectId ?? ""}:${route.view}`;
  useLayoutEffect(() => {
    if (routeFocusKey) {
      headingRef.current?.focus({ preventScroll: true });
    }
  }, [routeFocusKey]);
  const updateView = (view: ControlCenterRouteState["view"]) => onNavigate({ ...route, view });
  const openSettings = () => showSettings(null);

  return (
    <div
      className="app-shell"
      data-connection={connection ?? "connecting"}
      data-sidebar-collapsed={sidebarCollapsed}
      data-mobile-view={route.view}
      data-details-open={route.surfaceId !== "threads" && route.view === "details"}
      data-surface={route.surfaceId}
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
        <div className="sidebar-footer">
          <ActionButton className="sidebar-settings" variant="quiet" onClick={openSettings}>
            <SidebarIcon name="settings" />
            {message("settings.title")}
          </ActionButton>
        </div>
      </aside>
      <button
        type="button"
        className="sidebar-scrim"
        aria-hidden="true"
        tabIndex={-1}
        onClick={() => updateView("content")}
      />
      <div className="workspace">
        <header className="topbar">
          <div className="topbar-start">
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
            {topbarStart}
          </div>
          <div className="page-heading">
            <h1 id="page-title" ref={headingRef} tabIndex={-1}>
              {pageTitle}
            </h1>
          </div>
          <div className="topbar-controls">
            {topbarActions}
            <ActionButton
              className="topbar-settings"
              aria-label={message("settings.title")}
              variant="quiet"
              onClick={openSettings}
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
        onClose={() => onNavigate({ ...route, page: null, pageTab: null })}
        onTabChange={(tab) => showSettings(tab === "general" ? null : tab, true)}
        locale={locale}
        onLocaleChange={onLocaleChange}
        preferences={preferences}
        onPreferencesChange={onPreferencesChange}
        tools={settingsTools}
        data={settingsData}
        notifications={settingsNotifications}
        personalization={settingsPersonalization}
        account={settingsAccount}
        initialTab={settingsTab}
      />
    </div>
  );
}
