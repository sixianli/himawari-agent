import { SearchAuthorizationControl } from "./components/search-authorization-control.js";
import { NotificationSettings } from "./components/notification-settings.js";
import { AccountLogin, AccountDevices, accountRequest } from "./components/account-login.js";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ControlCenterShell } from "./app/app-shell.js";
import {
  CONTROL_CENTER_SURFACE_INVENTORY,
  type ControlCenterSurfaceInventoryEntry,
  isSurfaceInstalled,
} from "./app/control-center-inventory.js";
import { routeForSurface, useControlCenterRouter } from "./app/router.js";
import {
  ControlCenterBrowserStorage,
  type ControlCenterPreferences,
  type ControlCenterUiLocale,
  THREAD_CURSOR_STORAGE_KEY,
} from "./browser-storage.js";
import { Banner } from "./components/index.js";
import { BrowserEntryScreen } from "./components/browser-entry-screen.js";
import { type BrowserEntry, recoverBrowserEntry } from "./browser-entry.js";
import {
  GatewayClient,
  loadRuntimeConfiguration,
  refreshRuntimeConfiguration,
} from "./gateway-client.js";
import { useGovernanceControlCenter } from "./governance-control-center.js";
import { HealthControlCenter } from "./health-control-center.js";
import { useMemory } from "./memory.js";
import { MemoryReminders, MemoryTurnNote } from "./components/memory-panel.js";
import type { MessageId } from "./i18n/message-ids.js";
import {
  bootstrapLoadingLabel,
  ControlCenterIntlProvider,
  useControlCenterIntl,
} from "./i18n/runtime.js";
import { SseStateSynchronizer } from "./sse-synchronizer.js";
import { useThreadControlCenter } from "./thread-control-center.js";
import { ThreadSseSynchronizer } from "./thread-sse-synchronizer.js";
import { startPresenceHeartbeat } from "./web-push.js";

const MemorySettings = lazy(() =>
  import("./components/memory-page.js").then((module) => ({ default: module.MemorySettings })),
);

type SurfaceId = (typeof CONTROL_CENTER_SURFACE_INVENTORY)[number]["id"];
type RuntimeConfiguration = Awaited<ReturnType<typeof loadRuntimeConfiguration>>;

const titleIds: Readonly<Record<SurfaceId, MessageId>> = {
  approvals: "approvals.title",
  "authorizations-grants": "authorizations.title",
  "capabilities-adapters": "capabilities.title",
  "health-deployment": "health.title",
  "host-workspaces": "hostWorkspaces.title",
  improvements: "improvements.title",
  "inbox-digest": "inbox.title",
  memory: "memory.title",
  reflection: "reflection.title",
  "sessions-devices": "sessions.title",
  settings: "settings.title",
  tasks: "tasks.title",
  threads: "threads.title",
  trace: "trace.title",
  suggestions: "suggestions.title",
  workers: "workers.title",
};

function surfaceInventory(surfaceId: SurfaceId): ControlCenterSurfaceInventoryEntry {
  const surface = CONTROL_CENTER_SURFACE_INVENTORY.find((candidate) => candidate.id === surfaceId);
  if (!surface) throw new Error("CONTROL_CENTER_SURFACE_INVALID");
  return surface;
}

export function ControlCenterApp() {
  const storage = useMemo(() => new ControlCenterBrowserStorage(window.localStorage), []);
  const [locale, setLocale] = useState<ControlCenterUiLocale>(() =>
    storage.readLocale(navigator.languages),
  );
  const [preferences, setPreferences] = useState<ControlCenterPreferences>(() =>
    storage.readPreferences(),
  );
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: light)");
    const applyTheme = () =>
      document.documentElement.setAttribute(
        "data-theme",
        preferences.theme === "system" ? (media?.matches ? "light" : "dark") : preferences.theme,
      );
    applyTheme();
    media?.addEventListener("change", applyTheme);
    document.documentElement.setAttribute("data-accent", preferences.accent ?? "violet");
    return () => media?.removeEventListener("change", applyTheme);
  }, [preferences]);
  const updateLocale = (next: ControlCenterUiLocale) => {
    storage.saveLocale(next);
    setLocale(next);
  };
  const updatePreferences = (next: ControlCenterPreferences) => {
    storage.savePreferences(next);
    setPreferences(next);
  };
  return (
    <ControlCenterIntlProvider loadingLabel={bootstrapLoadingLabel(locale)} locale={locale}>
      <LocalizedControlCenterApp
        locale={locale}
        onLocaleChange={updateLocale}
        onPreferencesChange={updatePreferences}
        preferences={preferences}
        storage={storage}
      />
    </ControlCenterIntlProvider>
  );
}

interface LocalizedControlCenterAppProps {
  readonly locale: ControlCenterUiLocale;
  readonly onLocaleChange: (locale: ControlCenterUiLocale) => void;
  readonly onPreferencesChange: (preferences: ControlCenterPreferences) => void;
  readonly preferences: ControlCenterPreferences;
  readonly storage: ControlCenterBrowserStorage;
}

function LocalizedControlCenterApp({
  locale,
  onLocaleChange,
  onPreferencesChange,
  preferences,
  storage,
}: LocalizedControlCenterAppProps) {
  const { message } = useControlCenterIntl();
  const { match, navigate } = useControlCenterRouter();
  const route =
    match.kind === "matched" ? match.state : routeForSurface("threads", { view: "content" });
  const surface = surfaceInventory(route.surfaceId);
  const [configuration, setConfiguration] = useState<RuntimeConfiguration>();
  const [identityMethod, setIdentityMethod] = useState<"built-in" | "cloudflare-access" | null>(
    null,
  );
  const nativeDevices = identityMethod === "built-in" && route.surfaceId === "sessions-devices";
  const surfaceInstalled =
    configuration !== undefined &&
    (nativeDevices ||
      isSurfaceInstalled(
        surface,
        configuration.installedGatewayV2Operations ?? [],
        configuration.healthDependenciesAvailable,
      ));
  const [entry, setEntry] = useState<BrowserEntry | null>(null);
  const sessionExchanged = useRef(false);
  const deviceLabel = useRef("");
  deviceLabel.current = message("authentication.deviceLabel");
  const [bootstrapRevision, setBootstrapRevision] = useState(0);
  const [client, setClient] = useState<GatewayClient>();
  const [gatewayRefreshSignal, setGatewayRefreshSignal] = useState(0);
  const [threadRefreshSignal, setThreadRefreshSignal] = useState(0);
  const [threadEventSignal, setThreadEventSignal] = useState(0);
  const threadEventQueue = useRef<(string | null)[]>([]);
  const [connection, setConnection] = useState<"connecting" | "connected" | "offline">(
    "connecting",
  );
  const [threadConnection, setThreadConnection] = useState<"connecting" | "connected" | "offline">(
    "connecting",
  );
  useEffect(() => {
    void bootstrapRevision;
    let active = true;
    let checkingAuthority = false;
    void loadRuntimeConfiguration(window.fetch.bind(window))
      .then((loaded) => {
        if (!active) return;
        sessionExchanged.current = false;
        setEntry(null);
        setConfiguration(loaded);
        setClient(
          new GatewayClient({
            fetch: window.fetch.bind(window),
            csrfToken: () => loaded.csrfToken,
            refreshCsrfToken: async () => {
              if (!active) throw new Error("CONTROL_CENTER_CLIENT_DISPOSED");
              const fresh = await refreshRuntimeConfiguration(window.fetch.bind(window), loaded);
              if (!active) throw new Error("CONTROL_CENTER_CLIENT_DISPOSED");
              setConfiguration((current) =>
                current ? { ...current, csrfToken: fresh.csrfToken } : current,
              );
              return fresh.csrfToken;
            },
            onAuthorityRejected: () => {
              if (checkingAuthority) return;
              checkingAuthority = true;
              void refreshRuntimeConfiguration(window.fetch.bind(window), loaded)
                .then(
                  () => undefined,
                  (error: Error) => {
                    if (active && error.message === "CONTROL_CENTER_AUTHENTICATION_SCOPE_CHANGED")
                      setBootstrapRevision((revision) => revision + 1);
                  },
                )
                .finally(() => {
                  checkingAuthority = false;
                });
            },
          }),
        );
      })
      .catch(async (failure: unknown) => {
        const exchanged = sessionExchanged.current;
        const next = await recoverBrowserEntry({
          fetch: window.fetch.bind(window),
          deviceLabel: deviceLabel.current,
          failure,
          exchanged,
        });
        if (!active) return;
        if (next.kind === "reload") {
          sessionExchanged.current = true;
          setBootstrapRevision((revision) => revision + 1);
          return;
        }
        if (next.kind === "built-in-login") setIdentityMethod("built-in");
        setEntry(next);
      });
    return () => {
      active = false;
    };
  }, [bootstrapRevision]);

  useEffect(() => {
    let active = true;
    void accountRequest("method")
      .then((value) => {
        if (!active || !value || typeof value !== "object" || !("method" in value)) return;
        if (value.method === "built-in" || value.method === "cloudflare-access")
          setIdentityMethod(value.method);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const retryEntry = useCallback(() => {
    sessionExchanged.current = false;
    setEntry(null);
    setBootstrapRevision((revision) => revision + 1);
  }, []);
  const verifyEmail = useCallback(() => window.location.reload(), []);

  const clearPrivateViewState = useCallback(() => {
    setConfiguration(undefined);
    setClient(undefined);
    setEntry(null);
    setBootstrapRevision((revision) => revision + 1);
  }, []);

  useEffect(() => {
    if (!configuration) return;
    const synchronizer = new SseStateSynchronizer({
      storage,
      onEvent: () => setGatewayRefreshSignal((current) => current + 1),
      onSnapshotRequired: () => setGatewayRefreshSignal((current) => current + 1),
      onConnectionState: setConnection,
      onUnauthorized: clearPrivateViewState,
    });
    synchronizer.start();
    const online = () => synchronizer.setNetworkOnline(true);
    const offline = () => synchronizer.setNetworkOnline(false);
    const reconnect = () => {
      if (document.visibilityState === "visible") synchronizer.reconnectNow();
    };
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    document.addEventListener("visibilitychange", reconnect);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      document.removeEventListener("visibilitychange", reconnect);
      synchronizer.stop();
    };
  }, [configuration, storage, clearPrivateViewState]);

  useEffect(() => {
    if (!configuration) return;
    const synchronizer = new ThreadSseSynchronizer({
      configuration,
      storage,
      onCommittedEvent: (threadId) => {
        threadEventQueue.current.push(threadId);
        setThreadEventSignal((current) => current + 1);
      },
      onSnapshotRequired: () => setThreadRefreshSignal((current) => current + 1),
      onConnectionState: setThreadConnection,
      onUnauthorized: clearPrivateViewState,
    });
    synchronizer.start();
    const online = () => synchronizer.setNetworkOnline(true);
    const offline = () => synchronizer.setNetworkOnline(false);
    const reconnect = () => {
      if (document.visibilityState === "visible") synchronizer.reconnectNow();
    };
    const synchronizeTab = (event: StorageEvent) => {
      if (event.key === THREAD_CURSOR_STORAGE_KEY) {
        threadEventQueue.current.push(null);
        setThreadEventSignal((current) => current + 1);
      }
    };
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    window.addEventListener("storage", synchronizeTab);
    document.addEventListener("visibilitychange", reconnect);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      window.removeEventListener("storage", synchronizeTab);
      document.removeEventListener("visibilitychange", reconnect);
      synchronizer.stop();
    };
  }, [configuration, storage, clearPrivateViewState]);

  const memory = useMemory({
    client,
    configuration,
    connected: connection !== "offline",
    refreshSignal: gatewayRefreshSignal + threadRefreshSignal,
  });
  const threadModel = useThreadControlCenter({
    ...(memory
      ? {
          renderMemory: (ownerRefs: readonly string[]) => (
            <MemoryTurnNote ownerRefs={ownerRefs} memory={memory} message={message} />
          ),
        }
      : {}),
    active: route.surfaceId === "threads",
    client,
    configuration,
    connection: threadConnection,
    message,
    navigate,
    refreshSignal: threadRefreshSignal + gatewayRefreshSignal,
    threadEventSignal,
    threadEvents: threadEventQueue,
    route,
    storage,
    onUnauthorized: clearPrivateViewState,
  });
  const presenceInstalled =
    configuration?.installedGatewayV2Operations?.includes("presence.heartbeat") ?? false;
  useEffect(() => {
    if (!client || !configuration || !presenceInstalled) return;
    return startPresenceHeartbeat({
      client,
      configuration,
      document,
      setInterval: (handler, ms) => window.setInterval(handler, ms),
      clearInterval: (handle) => window.clearInterval(handle as number),
    });
  }, [client, configuration, presenceInstalled]);
  const governanceSurface = [
    "approvals",
    "capabilities-adapters",
    "authorizations-grants",
  ].includes(route.surfaceId);
  const governanceModel = useGovernanceControlCenter({
    active: governanceSurface && surfaceInstalled,
    client,
    configuration,
    connection,
    message,
    navigate,
    refreshSignal: gatewayRefreshSignal,
    route,
    storage,
    onUnauthorized: clearPrivateViewState,
  });

  if (!configuration && entry?.kind !== "built-in-login")
    return <BrowserEntryScreen entry={entry} onRetry={retryEntry} onVerifyEmail={verifyEmail} />;

  return (
    <ControlCenterShell
      settingsData={threadModel.settingsData}
      settingsMemory={
        memory ? (
          <Suspense fallback={<p>{message("state.loading")}</p>}>
            <MemorySettings
              memory={memory}
              message={message}
              onOpenThread={(threadId) =>
                navigate(routeForSurface("threads", { objectId: threadId, view: "content" }))
              }
            />
          </Suspense>
        ) : undefined
      }
      settingsNotifications={
        client && configuration?.installedGatewayV2Operations?.includes("push.status.read") ? (
          <NotificationSettings
            client={client}
            configuration={configuration}
            locale={locale}
            connected={threadConnection !== "offline"}
            message={message}
          />
        ) : undefined
      }
      settingsTools={
        client &&
        configuration?.installedGatewayV2Operations?.includes("search.authorization.set") ? (
          <SearchAuthorizationControl
            client={client}
            configuration={configuration}
            storage={storage}
            connected={threadConnection !== "offline"}
            refreshSignal={gatewayRefreshSignal}
            message={message}
          />
        ) : (
          <p>{message("common.notConfigured")}</p>
        )
      }
      builtInIdentity={identityMethod === "built-in" && Boolean(configuration)}
      healthDependenciesAvailable={configuration?.healthDependenciesAvailable ?? false}
      installedGatewayV2Operations={configuration?.installedGatewayV2Operations ?? []}
      connection={
        configuration ? (route.surfaceId === "threads" ? threadConnection : connection) : null
      }
      content={
        !configuration && entry?.kind === "built-in-login" ? (
          <AccountLogin onComplete={retryEntry} />
        ) : configuration && nativeDevices ? (
          <AccountDevices
            csrfToken={configuration.csrfToken}
            onSignedOut={clearPrivateViewState}
            onReauthenticated={() => setBootstrapRevision((value) => value + 1)}
          />
        ) : configuration && !surfaceInstalled ? (
          <Banner title={message("surface.notInstalled.title")} tone="warning">
            <p>{message("surface.notInstalled.description")}</p>
          </Banner>
        ) : route.surfaceId === "health-deployment" && client ? (
          <HealthControlCenter client={client} onUnauthorized={clearPrivateViewState} />
        ) : route.surfaceId === "threads" ? (
          <>
            {memory ? <MemoryReminders memory={memory} message={message} /> : null}
            {threadModel.content}
          </>
        ) : governanceSurface ? (
          governanceModel.content
        ) : (
          <Banner title={message("surface.notInstalled.title")} tone="warning">
            <p>{message("surface.notInstalled.description")}</p>
          </Banner>
        )
      }
      details={
        !configuration || !surfaceInstalled || route.surfaceId === "health-deployment"
          ? null
          : route.surfaceId === "threads"
            ? threadModel.details
            : governanceSurface
              ? governanceModel.details
              : null
      }
      list={governanceSurface ? governanceModel.list : threadModel.list}
      locale={locale}
      onLocaleChange={onLocaleChange}
      onNavigate={navigate}
      onPreferencesChange={onPreferencesChange}
      pageTitle={
        route.surfaceId === "threads" ? threadModel.title : message(titleIds[route.surfaceId])
      }
      preferences={preferences}
      route={route}
    />
  );
}
