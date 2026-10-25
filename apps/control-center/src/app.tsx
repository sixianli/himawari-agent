import { SearchAuthorizationControl } from "./components/search-authorization-control.js";
import { AccountLogin, AccountDevices, accountRequest } from "./components/account-login.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { ActionButton, Banner } from "./components/index.js";
import {
  createBrowserSession,
  GatewayClient,
  loadRuntimeConfiguration,
  refreshRuntimeConfiguration,
} from "./gateway-client.js";
import { useGovernanceControlCenter } from "./governance-control-center.js";
import { HealthControlCenter } from "./health-control-center.js";
import { useMemory } from "./memory.js";
import { MemoryReminders, MemorySettings, MemoryTurnNote } from "./components/memory-panel.js";
import type { MessageId } from "./i18n/message-ids.js";
import {
  bootstrapLoadingLabel,
  ControlCenterIntlProvider,
  useControlCenterIntl,
} from "./i18n/runtime.js";
import { SseStateSynchronizer } from "./sse-synchronizer.js";
import { useThreadControlCenter } from "./thread-control-center.js";
import { ThreadSseSynchronizer } from "./thread-sse-synchronizer.js";

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
  const [authenticationRequired, setAuthenticationRequired] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
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
  const [requestError, setRequestError] = useState<string | null>(null);

  useEffect(() => {
    void bootstrapRevision;
    let active = true;
    void loadRuntimeConfiguration(window.fetch.bind(window))
      .then((loaded) => {
        if (!active) return;
        setAuthenticationRequired(false);
        setRequestError(null);
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
          }),
        );
      })
      .catch((error: Error) => {
        if (active) {
          setRequestError(error.message);
          const status = "status" in error ? error.status : undefined;
          setAuthenticationRequired(status === 401 || status === 403);
        }
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

  const signIn = async () => {
    if (signingIn) return;
    setSigningIn(true);
    try {
      await createBrowserSession(window.fetch.bind(window), message("authentication.deviceLabel"));
      setBootstrapRevision((revision) => revision + 1);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "CONTROL_CENTER_REQUEST_REJECTED");
    } finally {
      setSigningIn(false);
    }
  };

  const clearPrivateViewState = useCallback(() => {
    setRequestError("CONTROL_CENTER_REAUTHENTICATION_REQUIRED");
    setAuthenticationRequired(true);
    setConfiguration(undefined);
    setClient(undefined);
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

  return (
    <ControlCenterShell
      settingsData={threadModel.settingsData}
      settingsMemory={
        memory ? (
          <MemorySettings
            memory={memory}
            message={message}
            onOpenThread={(threadId) =>
              navigate(routeForSurface("threads", { objectId: threadId, view: "content" }))
            }
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
        !configuration && authenticationRequired && identityMethod === "built-in" ? (
          <AccountLogin onComplete={() => setBootstrapRevision((value) => value + 1)} />
        ) : !configuration && requestError ? (
          <>
            <Banner
              title={message(
                authenticationRequired ? "authentication.required" : "error.currentUnavailable",
              )}
              tone="warning"
            >
              {authenticationRequired ? (
                <ActionButton disabled={signingIn} onClick={() => void signIn()}>
                  {message("authentication.signIn")}
                </ActionButton>
              ) : (
                <ActionButton onClick={() => setBootstrapRevision((value) => value + 1)}>
                  {message("loading.retry")}
                </ActionButton>
              )}
              <code>{requestError}</code>
            </Banner>
            {!authenticationRequired && route.surfaceId === "threads" ? threadModel.content : null}
          </>
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
