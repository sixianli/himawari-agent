import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ControlCenterShell } from "./app/app-shell.js";
import {
  CONTROL_CENTER_SURFACE_INVENTORY,
  type ControlCenterSurfaceInventoryEntry,
  isSurfaceInstalled,
} from "./app/control-center-inventory.js";
import { routeForSurface, useControlCenterRouter } from "./app/router.js";
import { type BrowserEntry, recoverBrowserEntry } from "./browser-entry.js";
import {
  ControlCenterBrowserStorage,
  type ControlCenterPreferences,
  type ControlCenterUiLocale,
  THREAD_CURSOR_STORAGE_KEY,
} from "./browser-storage.js";
import { DeviceSettings } from "./components/device-settings.js";
import { AccountDevices, AccountLogin, accountRequest } from "./components/account-login.js";
import { BrowserEntryScreen } from "./components/browser-entry-screen.js";
import { ActionButton, Banner } from "./components/index.js";
import { McpConnectionsSettings } from "./components/mcp-connections-settings.js";
import {
  focusedMemoryIds,
  MemoryReminders,
  MemoryTurnNote,
  OPEN_MEMORY_PAGE,
} from "./components/memory-panel.js";
import { MuseDataSettings } from "./components/muse-reference.js";
import { NotificationSettings } from "./components/notification-settings.js";
import { AutoMemorySetting } from "./components/personalization-settings.js";
import {
  ProactiveAppsSettings,
  ProactiveDataSettings,
  ProactiveNotificationSettings,
} from "./components/proactive-settings.js";
import { RuleReceiptCard } from "./components/rule-receipt.js";
import { SearchAuthorizationControl } from "./components/search-authorization-control.js";
import {
  SensitiveInterceptionsEntry,
  SensitiveInterceptionsPage,
} from "./components/sensitive-interceptions.js";
import { SignOutSetting } from "./components/sign-out-setting.js";
import {
  GatewayClient,
  loadRuntimeConfiguration,
  refreshRuntimeConfiguration,
} from "./gateway-client.js";
import { useGovernanceControlCenter } from "./governance-control-center.js";
import { HealthControlCenter } from "./health-control-center.js";
import type { MessageId } from "./i18n/message-ids.js";
import {
  bootstrapLoadingLabel,
  ControlCenterIntlProvider,
  useControlCenterIntl,
} from "./i18n/runtime.js";
import { mcpConnectionsInstalled } from "./mcp-connections.js";
import { useMemory } from "./memory.js";
import { requestMessageFocus } from "./message-focus.js";
import { useMuse } from "./muse.js";
import { useOwnerPreferenceSync } from "./owner-preferences.js";
import { resumedAfterLongAbsence } from "./page-resume.js";
import {
  OPEN_REMINDERS_PAGE,
  openRemindersPage,
  openSettings,
  proactiveDueCount,
  readLaunchIntent,
  reminderFocusOf,
  useProactive,
} from "./proactive.js";
import { useSensitiveInterceptions } from "./sensitive-interceptions.js";
import { SseStateSynchronizer } from "./sse-synchronizer.js";
import { type SidePage, useThreadControlCenter } from "./thread-control-center.js";
import { ThreadSseSynchronizer } from "./thread-sse-synchronizer.js";
import { reportPushFeedback, startPresenceHeartbeat } from "./web-push.js";

const MemoryPage = lazy(() =>
  import("./components/memory-page.js").then((module) => ({ default: module.MemoryPage })),
);
const RemindersPage = lazy(() =>
  import("./components/memory-page.js").then((module) => ({ default: module.RemindersPage })),
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

function PageNotFound({
  message,
  onHome,
}: {
  readonly message: (id: MessageId) => string;
  readonly onHome: () => void;
}) {
  return (
    <Banner title={message("surface.notFound.title")} tone="warning">
      <p>{message("surface.notFound.description")}</p>
      <ActionButton onClick={onHome}>{message("surface.notFound.action")}</ActionButton>
    </Banner>
  );
}

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
  const [launch] = useState(() => readLaunchIntent(window.location, window.history));
  const { match, navigate } = useControlCenterRouter();
  const goHome = useCallback(
    () => navigate(routeForSurface("threads", { view: "content" })),
    [navigate],
  );
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
      if (document.visibilityState === "visible")
        synchronizer.reconnectNow(resumedAfterLongAbsence());
    };
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    document.addEventListener("visibilitychange", reconnect);
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) synchronizer.reconnectNow(true);
    };
    window.addEventListener("pageshow", restored);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      document.removeEventListener("visibilitychange", reconnect);
      window.removeEventListener("pageshow", restored);
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
      if (document.visibilityState !== "visible") return;
      synchronizer.reconnectNow(resumedAfterLongAbsence());
      threadEventQueue.current.push(null);
      setThreadEventSignal((current) => current + 1);
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
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) synchronizer.reconnectNow(true);
    };
    window.addEventListener("pageshow", restored);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      window.removeEventListener("storage", synchronizeTab);
      document.removeEventListener("visibilitychange", reconnect);
      window.removeEventListener("pageshow", restored);
      synchronizer.stop();
    };
  }, [configuration, storage, clearPrivateViewState]);

  const [memoryFocus, setMemoryFocus] = useState<readonly string[]>([]);
  useEffect(() => {
    const focus = (event: Event) => setMemoryFocus(focusedMemoryIds(event));
    window.addEventListener(OPEN_MEMORY_PAGE, focus);
    return () => window.removeEventListener(OPEN_MEMORY_PAGE, focus);
  }, []);
  const memory = useMemory({
    client,
    configuration,
    connected: connection !== "offline",
    refreshSignal: gatewayRefreshSignal + threadRefreshSignal,
  });
  const proactive = useProactive({
    client,
    configuration,
    connected: connection !== "offline",
    refreshSignal: gatewayRefreshSignal + threadRefreshSignal,
  });
  const muse = useMuse({
    client,
    configuration,
    connected: connection !== "offline",
    refreshSignal: gatewayRefreshSignal + threadRefreshSignal,
  });
  const settingsOpen = route.page === "settings";
  const [sensitiveOpen, setSensitiveOpen] = useState(false);
  useEffect(() => {
    if (!settingsOpen) setSensitiveOpen(false);
  }, [settingsOpen]);
  const sensitive = useSensitiveInterceptions({
    client,
    configuration,
    connected: connection !== "offline",
    active: settingsOpen,
  });
  const ownerPreferences = useOwnerPreferenceSync({
    client,
    configuration,
    connected: connection !== "offline",
    storage,
    preferences,
    locale,
    onPreferencesChange,
    onLocaleChange,
  });
  const [reminderFocus, setReminderFocus] = useState<string | null>(null);
  useEffect(() => {
    const focus = (event: Event) => setReminderFocus(reminderFocusOf(event));
    window.addEventListener(OPEN_REMINDERS_PAGE, focus);
    return () => window.removeEventListener(OPEN_REMINDERS_PAGE, focus);
  }, []);
  const threadModel = useThreadControlCenter({
    ...(memory
      ? {
          renderMemory: (ownerRefs: readonly string[]) => (
            <MemoryTurnNote ownerRefs={ownerRefs} memory={memory} message={message} />
          ),
          renderToolCard: (name: string, output: string) =>
            name === "rule_set" ? (
              <RuleReceiptCard output={output} memory={memory} message={message} />
            ) : null,
          remindersDue:
            (memory.overview?.reminders.length ?? 0) +
            proactiveDueCount(proactive?.overview ?? null, new Date()),
          renderPage: (page: SidePage) => (
            <Suspense fallback={null}>
              {page === "memory" ? (
                <MemoryPage
                  memory={memory}
                  message={message}
                  focus={memoryFocus}
                  onOpenThread={(threadId, messageId) => {
                    if (messageId) requestMessageFocus(threadId, messageId);
                    navigate(routeForSurface("threads", { objectId: threadId, view: "content" }));
                  }}
                />
              ) : (
                <RemindersPage
                  memory={memory}
                  proactive={proactive}
                  muse={muse}
                  focus={reminderFocus}
                  locale={locale}
                  message={message}
                  onOpenThread={(threadId) =>
                    navigate(routeForSurface("threads", { objectId: threadId, view: "content" }))
                  }
                />
              )}
            </Suspense>
          ),
        }
      : {}),
    active: route.surfaceId === "threads" && match.kind === "matched",
    ownerName: preferences.name,
    modelChoice: preferences.modelRef
      ? { modelRef: preferences.modelRef, thinkingLevel: preferences.thinkingLevel ?? "" }
      : undefined,
    onModelChoiceChange: ownerPreferences.changeModelChoice,
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
  const launchReminder = launch.reminder;
  const launchSettings = launch.settings;
  const memoryReady = memory !== null;
  const proactiveReady = proactive !== null;
  useEffect(() => {
    if (launchReminder && memoryReady) openRemindersPage(launchReminder);
  }, [launchReminder, memoryReady]);
  useEffect(() => {
    if (launchSettings && proactiveReady) openSettings(launchSettings);
  }, [launchSettings, proactiveReady]);
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
  const pushFeedbackInstalled =
    configuration?.installedGatewayV2Operations?.includes("push.feedback.record") ?? false;
  useEffect(() => {
    if (!client || !configuration || !pushFeedbackInstalled) return;
    const report = () =>
      void reportPushFeedback({
        client,
        configuration,
        location: window.location,
        history: window.history,
        caches: typeof caches === "undefined" ? undefined : caches,
        now: () => new Date(),
      }).catch(() => undefined);
    const onVisibility = () => {
      if (document.visibilityState === "visible") report();
    };
    report();
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [client, configuration, pushFeedbackInstalled]);
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

  const threadsShown = route.surfaceId === "threads" && match.kind === "matched";
  if (!configuration && entry?.kind !== "built-in-login")
    return <BrowserEntryScreen entry={entry} onRetry={retryEntry} onVerifyEmail={verifyEmail} />;

  return (
    <ControlCenterShell
      settingsPersonalization={
        memory ? <AutoMemorySetting memory={memory} message={message} /> : undefined
      }
      settingsAccount={
        configuration && identityMethod === "built-in" ? (
          <SignOutSetting csrfToken={configuration.csrfToken} onSignedOut={clearPrivateViewState} />
        ) : undefined
      }
      settingsData={
        sensitive && sensitiveOpen ? (
          <SensitiveInterceptionsPage
            model={sensitive}
            message={message}
            threadTitle={threadModel.threadTitle}
            onBack={() => setSensitiveOpen(false)}
            onOpenThread={(threadId) =>
              navigate(routeForSurface("threads", { objectId: threadId, view: "content" }))
            }
          />
        ) : (
          <>
            {threadModel.settingsData}
            {sensitive ? (
              <SensitiveInterceptionsEntry
                model={sensitive}
                message={message}
                onOpen={() => setSensitiveOpen(true)}
              />
            ) : null}
            {proactive ? <ProactiveDataSettings proactive={proactive} message={message} /> : null}
            {muse ? <MuseDataSettings muse={muse} message={message} /> : null}
          </>
        )
      }
      settingsAgents={
        client && configuration && mcpConnectionsInstalled(configuration) ? (
          <McpConnectionsSettings
            client={client}
            configuration={configuration}
            connected={threadConnection !== "offline"}
            message={message}
          />
        ) : undefined
      }
      settingsDevices={
        configuration?.installedDeviceApi ? (
          <DeviceSettings csrfToken={configuration.csrfToken} message={message} />
        ) : undefined
      }
      settingsNotifications={
        (client && configuration?.installedGatewayV2Operations?.includes("push.status.read")) ||
        proactive ? (
          <>
            {client && configuration?.installedGatewayV2Operations?.includes("push.status.read") ? (
              <NotificationSettings
                client={client}
                configuration={configuration}
                locale={locale}
                connected={threadConnection !== "offline"}
                message={message}
              />
            ) : null}
            {proactive ? (
              <ProactiveNotificationSettings
                proactive={proactive}
                locale={locale}
                message={message}
              />
            ) : null}
          </>
        ) : undefined
      }
      settingsTools={
        (client &&
          configuration?.installedGatewayV2Operations?.includes("search.authorization.set")) ||
        proactive ? (
          <>
            {client &&
            configuration?.installedGatewayV2Operations?.includes("search.authorization.set") ? (
              <SearchAuthorizationControl
                client={client}
                configuration={configuration}
                storage={storage}
                connected={threadConnection !== "offline"}
                refreshSignal={gatewayRefreshSignal}
                message={message}
              />
            ) : null}
            {proactive ? (
              <ProactiveAppsSettings
                proactive={proactive}
                message={message}
                outcome={launch.gmail}
                locale={locale}
                onOpenThread={(threadId, messageId) => {
                  if (messageId) requestMessageFocus(threadId, messageId);
                  navigate(routeForSurface("threads", { objectId: threadId, view: "content" }));
                }}
              />
            ) : null}
          </>
        ) : (
          <p>{message("common.notConfigured")}</p>
        )
      }
      builtInIdentity={identityMethod === "built-in" && Boolean(configuration)}
      healthDependenciesAvailable={configuration?.healthDependenciesAvailable ?? false}
      installedGatewayV2Operations={configuration?.installedGatewayV2Operations ?? []}
      connection={configuration ? (threadsShown ? threadConnection : connection) : null}
      content={
        !configuration && entry?.kind === "built-in-login" ? (
          <AccountLogin onComplete={retryEntry} />
        ) : configuration && nativeDevices ? (
          <AccountDevices
            csrfToken={configuration.csrfToken}
            onSignedOut={clearPrivateViewState}
            onReauthenticated={() => setBootstrapRevision((value) => value + 1)}
          />
        ) : configuration && match.kind === "not_found" ? (
          <PageNotFound message={message} onHome={goHome} />
        ) : configuration && !surfaceInstalled ? (
          <PageNotFound message={message} onHome={goHome} />
        ) : route.surfaceId === "health-deployment" && client ? (
          <HealthControlCenter client={client} onUnauthorized={clearPrivateViewState} />
        ) : threadsShown ? (
          <>
            {memory ? <MemoryReminders memory={memory} message={message} /> : null}
            {threadModel.content}
          </>
        ) : governanceSurface ? (
          governanceModel.content
        ) : (
          <PageNotFound message={message} onHome={goHome} />
        )
      }
      details={
        !configuration || !surfaceInstalled || route.surfaceId === "health-deployment"
          ? null
          : threadsShown
            ? threadModel.details
            : governanceSurface
              ? governanceModel.details
              : null
      }
      topbarStart={threadsShown ? threadModel.start : null}
      topbarActions={threadsShown ? threadModel.actions : null}
      list={governanceSurface ? governanceModel.list : threadModel.list}
      locale={locale}
      onLocaleChange={ownerPreferences.changeLocale}
      onNavigate={navigate}
      onPreferencesChange={ownerPreferences.changePreferences}
      pageTitle={threadsShown ? threadModel.title : message(titleIds[route.surfaceId])}
      preferences={preferences}
      route={route}
    />
  );
}
