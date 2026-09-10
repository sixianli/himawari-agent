import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { useEffect, useRef } from "react";
import type { ControlCenterPreferences, ControlCenterUiLocale } from "../browser-storage.js";
import { AppearancePicker } from "../components/appearance-picker.js";
import { HimawariBrand } from "../components/brand.js";
import { ActionButton, AppLink, StatusRegion } from "../components/index.js";
import type { MessageId } from "../i18n/message-ids.js";
import { UI_LOCALES, useControlCenterIntl } from "../i18n/runtime.js";
import {
  CONTROL_CENTER_SURFACE_INVENTORY,
  isSurfaceInstalled,
} from "./control-center-inventory.js";
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
  readonly builtInIdentity?: boolean;
  readonly healthDependenciesAvailable?: boolean;
  readonly installedGatewayV2Operations?: readonly string[];
  readonly connection: "connecting" | "connected" | "offline" | null;
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
  builtInIdentity = false,
  healthDependenciesAvailable = false,
  installedGatewayV2Operations = [],
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
      data-details-open={route.view === "details"}
      data-surface={route.surfaceId}
      style={{ "--detail-pane-percent": `${preferences.detailPanePercent}%` } as CSSProperties}
    >
      <AppLink className="skip-link" href="#main-content">
        {message("app.skipToMain")}
      </AppLink>
      <aside className="sidebar" aria-label={message("nav.label")}>
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
        <section className="list-pane" aria-label={message("common.currentRecords")}>
          {list}
        </section>
        <nav aria-label={message("nav.label")} className="primary-nav">
          {CONTROL_CENTER_SURFACE_INVENTORY.map((surface) => {
            const state = routeForSurface(surface.id, { view: "content" });
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
                {!(builtInIdentity && surface.id === "sessions-devices") &&
                !isSurfaceInstalled(
                  surface,
                  installedGatewayV2Operations,
                  healthDependenciesAvailable,
                ) ? (
                  <small> · {message("surface.notInstalled.label")}</small>
                ) : null}
              </AppLink>
            );
          })}
        </nav>
        <label className="locale-control">
          <span className="visually-hidden">{message("locale.label")}</span>
          <select
            aria-label={message("locale.label")}
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
      </aside>
      <div className="workspace">
        <header className="topbar">
          <ActionButton
            className="mobile-sidebar-toggle"
            aria-label={message("layout.showList")}
            aria-expanded={route.view === "list"}
            onClick={() => updateView(route.view === "list" ? "content" : "list")}
            variant="quiet"
          >
            ☰
          </ActionButton>
          <div className="page-heading">
            <p className="eyebrow">Himawari / {message("app.title")}</p>
            <h1 id="page-title" ref={headingRef} tabIndex={-1}>
              {pageTitle}
            </h1>
          </div>
          <div className="topbar-controls">
            {connection ? (
              <StatusRegion className={`connection connection-${connection}`}>
                <span aria-hidden="true">●</span>
                <span className="connection-label">
                  {message(
                    connection === "connected"
                      ? "connection.connected"
                      : connection === "connecting"
                        ? "connection.connecting"
                        : "connection.offline",
                  )}
                </span>
              </StatusRegion>
            ) : null}
            <AppearancePicker preferences={preferences} onChange={onPreferencesChange} />
            <ActionButton
              aria-label={message("layout.showDetails")}
              aria-pressed={route.view === "details"}
              onClick={() => updateView(route.view === "details" ? "content" : "details")}
              variant="quiet"
            >
              ◫
            </ActionButton>
          </div>
        </header>
        <main className="workspace-layout" id="main-content">
          <section aria-labelledby="page-title" className="content-pane">
            {content}
          </section>
          <aside
            aria-label={message("common.details")}
            className="details-pane"
            hidden={route.view !== "details"}
          >
            <div className="panel-heading">
              <h2>{message("common.details")}</h2>
              <ActionButton
                aria-label={message("common.close")}
                onClick={() => updateView("content")}
                variant="quiet"
              >
                ×
              </ActionButton>
            </div>
            {details}
            <details className="interface-details">
              <summary>{message("layout.label")}</summary>
              <label>
                {message("layout.detailWidth")}
                <input
                  max="40"
                  min="18"
                  type="range"
                  value={preferences.detailPanePercent}
                  onChange={(event) =>
                    onPreferencesChange({
                      ...preferences,
                      detailPanePercent: Number(event.target.value),
                    })
                  }
                />
              </label>
              <p>{message("app.privacyBoundary")}</p>
              <code>CONTROL_CENTER_RENDERED</code>
            </details>
          </aside>
        </main>
      </div>
    </div>
  );
}
