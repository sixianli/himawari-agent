import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { useEffect, useRef } from "react";
import type { ControlCenterPreferences, ControlCenterUiLocale } from "../browser-storage.js";
import { ActionButton, AppLink, StatusRegion } from "../components/index.js";
import type { MessageId } from "../i18n/message-ids.js";
import { UI_LOCALES, useControlCenterIntl } from "../i18n/runtime.js";
import { CONTROL_CENTER_SURFACE_INVENTORY } from "./control-center-inventory.js";
import { type ControlCenterRouteState, controlCenterHref, routeForSurface } from "./router.js";

const navMessageIds: Readonly<
  Record<(typeof CONTROL_CENTER_SURFACE_INVENTORY)[number]["id"], MessageId>
> = {
  approvals: "nav.approvals",
  "authorizations-grants": "nav.authorizationsGrants",
  "capabilities-adapters": "nav.capabilitiesAdapters",
  "health-deployment": "nav.healthDeployment",
  "host-workspaces": "nav.hostWorkspaces",
  improvements: "nav.improvements",
  "inbox-digest": "nav.inboxDigest",
  memory: "nav.memory",
  reflection: "nav.reflection",
  "sessions-devices": "nav.sessionsDevices",
  settings: "nav.settings",
  tasks: "nav.tasks",
  threads: "nav.threads",
  trace: "nav.trace",
  suggestions: "nav.suggestions",
  workers: "nav.workers",
};

export interface ControlCenterShellProps {
  readonly connection: "connecting" | "connected" | "offline";
  readonly content: ReactNode;
  readonly details: ReactNode;
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
  connection,
  content,
  details,
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
  const headingRef = useRef<HTMLHeadingElement>(null);
  const routeFocusKey = `${route.surfaceId}:${route.objectId ?? ""}:${route.view}`;
  useEffect(() => {
    if (routeFocusKey) headingRef.current?.focus();
  }, [routeFocusKey]);
  const updateView = (view: ControlCenterRouteState["view"]) => onNavigate({ ...route, view });

  return (
    <div
      className="app-shell"
      data-density={preferences.density}
      data-mobile-view={route.view}
      style={
        {
          "--detail-pane-percent": `${preferences.detailPanePercent}%`,
          "--list-pane-percent": `${preferences.listPanePercent}%`,
        } as CSSProperties
      }
    >
      <AppLink className="skip-link" href="#main-content">
        {message("app.skipToMain")}
      </AppLink>
      <header className="topbar">
        <div>
          <p className="eyebrow">{message("app.eyebrow")}</p>
          <h1>{message("app.title")}</h1>
        </div>
        <div className="topbar-controls">
          <label className="locale-control">
            <span>{message("locale.label")}</span>
            <select
              onChange={(event) => onLocaleChange(event.target.value as ControlCenterUiLocale)}
              value={locale}
            >
              {UI_LOCALES.map((value) => (
                <option key={value} value={value}>
                  {message(
                    value === "zh-CN" ? "locale.zhCN" : value === "ja" ? "locale.ja" : "locale.en",
                  )}
                </option>
              ))}
            </select>
          </label>
          <StatusRegion className={`connection connection-${connection}`}>
            <span aria-hidden="true">●</span>{" "}
            {message(
              connection === "connected"
                ? "connection.connected"
                : connection === "connecting"
                  ? "connection.connecting"
                  : "connection.offline",
            )}
          </StatusRegion>
        </div>
      </header>
      <nav aria-label={message("nav.label")} className="primary-nav">
        {CONTROL_CENTER_SURFACE_INVENTORY.map((surface) => {
          const state = routeForSurface(surface.id);
          return (
            <AppLink
              current={route.surfaceId === surface.id}
              href={controlCenterHref(state)}
              key={surface.id}
              onClick={(event) => {
                if (!shouldHandleNavigation(event)) return;
                event.preventDefault();
                onNavigate(state);
              }}
            >
              {message(navMessageIds[surface.id])}
            </AppLink>
          );
        })}
      </nav>

      <section aria-label={message("layout.label")} className="layout-controls">
        <label>
          <span>{message("layout.listWidth")}</span>
          <input
            max="40"
            min="18"
            onChange={(event) =>
              onPreferencesChange({
                ...preferences,
                listPanePercent: Number(event.target.value),
              })
            }
            type="range"
            value={preferences.listPanePercent}
          />
        </label>
        <label>
          <span>{message("layout.detailWidth")}</span>
          <input
            max="40"
            min="18"
            onChange={(event) =>
              onPreferencesChange({
                ...preferences,
                detailPanePercent: Number(event.target.value),
              })
            }
            type="range"
            value={preferences.detailPanePercent}
          />
        </label>
      </section>

      <nav aria-label={message("layout.label")} className="mobile-view-switcher">
        <ActionButton
          aria-pressed={route.view === "list"}
          onClick={() => updateView("list")}
          variant="quiet"
        >
          {message("layout.showList")}
        </ActionButton>
        <ActionButton
          aria-pressed={route.view === "content"}
          onClick={() => updateView("content")}
          variant="quiet"
        >
          {message("layout.showContent")}
        </ActionButton>
        <ActionButton
          aria-pressed={route.view === "details"}
          onClick={() => updateView("details")}
          variant="quiet"
        >
          {message("layout.showDetails")}
        </ActionButton>
      </nav>

      <main className="workspace-layout" id="main-content">
        <aside aria-label={message("common.currentRecords")} className="list-pane">
          {list}
        </aside>
        <section aria-labelledby="page-title" className="content-pane">
          <h2 id="page-title" ref={headingRef} tabIndex={-1}>
            {pageTitle}
          </h2>
          {content}
        </section>
        <aside aria-label={message("common.details")} className="details-pane">
          {details}
        </aside>
      </main>
      <footer>
        <span>{message("app.privacyBoundary")}</span>
        <code>CONTROL_CENTER_RENDERED</code>
      </footer>
    </div>
  );
}
