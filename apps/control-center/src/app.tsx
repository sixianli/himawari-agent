import type { GatewayV2Query, GatewayV2Snapshot } from "@himawari-agent/gateway-contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ControlCenterShell } from "./app/app-shell.js";
import {
  CONTROL_CENTER_SURFACE_INVENTORY,
  type ControlCenterSurfaceInventoryEntry,
} from "./app/control-center-inventory.js";
import {
  type ControlCenterRouteState,
  routeForSurface,
  useControlCenterRouter,
} from "./app/router.js";
import {
  ControlCenterBrowserStorage,
  THREAD_CURSOR_STORAGE_KEY,
  type ControlCenterPreferences,
  type ControlCenterUiLocale,
} from "./browser-storage.js";
import {
  ActionButton,
  AppLink,
  Banner,
  RiskIndicator,
  SemanticList,
  StatusRegion,
  Tabs,
} from "./components/index.js";
import { GatewayClient, loadRuntimeConfiguration, type MutationStatus } from "./gateway-client.js";
import type { MessageId } from "./i18n/message-ids.js";
import {
  bootstrapLoadingLabel,
  ControlCenterIntlProvider,
  useControlCenterIntl,
} from "./i18n/runtime.js";
import { queryMessage } from "./messages.js";
import { SseStateSynchronizer } from "./sse-synchronizer.js";
import { useThreadControlCenter } from "./thread-control-center.js";
import { ThreadSseSynchronizer } from "./thread-sse-synchronizer.js";
import { useGovernanceControlCenter } from "./governance-control-center.js";

type SurfaceId = (typeof CONTROL_CENTER_SURFACE_INVENTORY)[number]["id"];
type RuntimeConfiguration = Awaited<ReturnType<typeof loadRuntimeConfiguration>>;

const titleIds: Readonly<Record<SurfaceId, MessageId>> = {
  approvals: "approvals.title",
  "authorizations-grants": "authorizations.title",
  "capabilities-adapters": "capabilities.title",
  "health-deployment": "health.title",
  "inbox-digest": "inbox.title",
  memory: "memory.title",
  "sessions-devices": "sessions.title",
  settings: "settings.title",
  tasks: "tasks.title",
  threads: "threads.title",
  trace: "trace.title",
};

function statusMessageId(status: MutationStatus | null): MessageId {
  switch (status) {
    case "pending":
      return "mutation.pending";
    case "accepted":
      return "mutation.accepted";
    case "replayed":
      return "mutation.replayed";
    case "rejected":
      return "mutation.rejected";
    case "expired":
      return "mutation.expired";
    default:
      return "mutation.none";
  }
}

function queryForSurface(
  surfaceId: SurfaceId,
  configuration: RuntimeConfiguration,
  route: ControlCenterRouteState,
): GatewayV2Query | null {
  switch (surfaceId) {
    case "threads":
      return null;
    case "approvals":
      return null;
    case "tasks":
      return queryMessage(configuration, "task.list", {
        status: ["active", "paused", "revoked"].includes(route.status ?? "") ? route.status : null,
        afterCursor: route.afterCursor,
        limit: 100,
      });
    case "inbox-digest":
      return queryMessage(configuration, "inbox.list", {
        unreadOnly: route.status === "unread",
        afterCursor: route.afterCursor,
        limit: 100,
      });
    case "memory":
      return queryMessage(configuration, "memory.search", {
        queryRef: "query:recent",
        status: ["active", "archived", "trashed"].includes(route.status ?? "")
          ? route.status
          : null,
        limit: 100,
      });
    case "trace":
      return queryMessage(configuration, "trace.timeline", {
        threadId: null,
        runId: null,
        afterSequence: 0,
        limit: 200,
      });
    case "sessions-devices":
      return queryMessage(configuration, "identity.sessions", {
        includeRevoked: true,
        afterCursor: route.afterCursor,
        limit: 100,
      });
    case "health-deployment":
      return queryMessage(configuration, "health.status", { includeDependencies: true });
    case "capabilities-adapters":
    case "authorizations-grants":
    case "settings":
      return null;
  }
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
  const [client, setClient] = useState<GatewayClient>();
  const [snapshot, setSnapshot] = useState<GatewayV2Snapshot>();
  const [gatewayRefreshSignal, setGatewayRefreshSignal] = useState(0);
  const [threadRefreshSignal, setThreadRefreshSignal] = useState(0);
  const [connection, setConnection] = useState<"connecting" | "connected" | "offline">(
    "connecting",
  );
  const [loading, setLoading] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [mutationStatus, setMutationStatus] = useState<MutationStatus | null>(null);
  const [selectedRef, setSelectedRef] = useState(route.objectId ?? "");
  const [settingsTab, setSettingsTab] = useState("language");

  useEffect(() => {
    setSelectedRef(route.objectId ?? "");
  }, [route]);

  useEffect(() => {
    let active = true;
    void loadRuntimeConfiguration(window.fetch.bind(window))
      .then((loaded) => {
        if (!active) return;
        setConfiguration(loaded);
        setClient(
          new GatewayClient({
            fetch: window.fetch.bind(window),
            csrfToken: () => loaded.csrfToken,
          }),
        );
      })
      .catch((error: Error) => {
        if (active) setRequestError(error.message);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!configuration) return;
    const synchronizer = new SseStateSynchronizer({
      storage,
      createEventSource: (url) => new EventSource(url, { withCredentials: true }),
      onEvent: () => setGatewayRefreshSignal((current) => current + 1),
      onConnectionState: setConnection,
      log: (entry) => window.dispatchEvent(new CustomEvent("himawari:safe-log", { detail: entry })),
    });
    synchronizer.start();
    const reconnect = () => synchronizer.reconnectNow();
    window.addEventListener("online", reconnect);
    document.addEventListener("visibilitychange", reconnect);
    return () => {
      window.removeEventListener("online", reconnect);
      document.removeEventListener("visibilitychange", reconnect);
      synchronizer.stop();
    };
  }, [configuration, storage]);

  useEffect(() => {
    if (!configuration) return;
    const synchronizer = new ThreadSseSynchronizer({
      configuration,
      storage,
      createEventSource: (url) => new EventSource(url, { withCredentials: true }),
      onCommittedEvent: () => setThreadRefreshSignal((current) => current + 1),
      onSnapshotRequired: () => setThreadRefreshSignal((current) => current + 1),
      log: (entry) => window.dispatchEvent(new CustomEvent("himawari:safe-log", { detail: entry })),
    });
    synchronizer.start();
    const reconnect = () => synchronizer.reconnectNow();
    const synchronizeTab = (event: StorageEvent) => {
      if (event.key === THREAD_CURSOR_STORAGE_KEY) {
        setThreadRefreshSignal((current) => current + 1);
      }
    };
    window.addEventListener("online", reconnect);
    window.addEventListener("storage", synchronizeTab);
    document.addEventListener("visibilitychange", reconnect);
    return () => {
      window.removeEventListener("online", reconnect);
      window.removeEventListener("storage", synchronizeTab);
      document.removeEventListener("visibilitychange", reconnect);
      synchronizer.stop();
    };
  }, [configuration, storage]);

  const clearPrivateViewState = useCallback(() => {
    setSnapshot(undefined);
    setSelectedRef("");
    setMutationStatus(null);
    setRequestError("CONTROL_CENTER_REAUTHENTICATION_REQUIRED");
  }, []);

  const refresh = useCallback(async () => {
    if (!client || !configuration) return;
    const query = queryForSurface(route.surfaceId, configuration, route);
    setRequestError(null);
    setSnapshot(undefined);
    if (!query) return;
    setLoading(true);
    try {
      setSnapshot(await client.query(query));
    } catch (error) {
      const status =
        error && typeof error === "object" && "status" in error
          ? (error as { readonly status?: unknown }).status
          : null;
      if (status === 401) {
        clearPrivateViewState();
      } else {
        setRequestError(error instanceof Error ? error.message : "CONTROL_CENTER_REQUEST_REJECTED");
      }
    } finally {
      setLoading(false);
    }
  }, [clearPrivateViewState, client, configuration, route]);

  useEffect(() => {
    void gatewayRefreshSignal;
    void refresh();
  }, [gatewayRefreshSignal, refresh]);

  const threadModel = useThreadControlCenter({
    active: route.surfaceId === "threads",
    client,
    configuration,
    connection,
    message,
    navigate,
    refreshSignal: threadRefreshSignal,
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
    active: governanceSurface,
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

  const itemRefs =
    snapshot?.kind === "snapshot" && snapshot.type === "collection.snapshot"
      ? snapshot.payload.itemRefs
      : [];

  const selectReference = (reference: string) => {
    setSelectedRef(reference);
    navigate({ ...route, objectId: reference, view: "details" });
  };

  const genericList = (
    <>
      <p>{message("objects.count", { count: itemRefs.length })}</p>
      <SemanticList
        empty={loading ? message("state.loading") : message("common.noRecords")}
        getId={(reference) => reference}
        items={itemRefs}
        label={message("common.currentRecords")}
        renderItem={(reference) => (
          <AppLink
            current={reference === selectedRef}
            href={`#${encodeURIComponent(reference)}`}
            onClick={(event) => {
              event.preventDefault();
              selectReference(reference);
            }}
          >
            <code>{reference}</code>
          </AppLink>
        )}
      />
    </>
  );

  const genericDetails = (
    <div className="object-details">
      <dl>
        <div>
          <dt>{message("common.selectedRecord")}</dt>
          <dd>
            <code>{selectedRef || "—"}</code>
          </dd>
        </div>
        <div>
          <dt>{message("common.status")}</dt>
          <dd>{surface.contractStatus}</dd>
        </div>
        <div>
          <dt>{message("common.source")}</dt>
          <dd>
            <code>{surface.sourceSpec}</code>
          </dd>
        </div>
      </dl>
      {surface.blockers.length > 0 ? (
        <ul>
          {surface.blockers.map((blocker) => (
            <li key={blocker}>
              <code>{blocker}</code>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );

  const blockedNotice =
    surface.integrationPolicy === "allowed" ? null : (
      <Banner title={message("surface.blocked.title")} tone="warning">
        <p>{message("surface.blocked.description", { count: surface.blockers.length })}</p>
        <RiskIndicator label={message("common.blocked")} level="medium" />
      </Banner>
    );

  const genericContent = (
    <>
      <div className="panel-heading">
        <p className="eyebrow">{message("common.status")}</p>
        <ActionButton onClick={() => void refresh()} variant="secondary">
          {message("common.refresh")}
        </ActionButton>
      </div>
      {match.kind === "not_found" ? (
        <Banner title={message("state.error")} tone="danger">
          <code>CONTROL_CENTER_ROUTE_NOT_FOUND:{match.pathname}</code>
        </Banner>
      ) : null}
      {requestError ? (
        <Banner title={message("error.currentUnavailable")} tone="danger">
          <code>{requestError}</code>
        </Banner>
      ) : null}
      {connection === "offline" ? (
        <Banner title={message("state.offline")} tone="warning">
          <code>CONTROL_CENTER_OFFLINE</code>
        </Banner>
      ) : null}
      {blockedNotice}
      <StatusRegion className="mutation-status">
        {message("mutation.label")}: {message(statusMessageId(mutationStatus))}
      </StatusRegion>

      {route.surfaceId === "tasks" ? (
        <section aria-labelledby="github-disclosure-title" className="disclosure-preview">
          <h3 id="github-disclosure-title">{message("tasks.disclosureTitle")}</h3>
          <p>{message("tasks.disclosureDescription")}</p>
          <dl className="health-grid">
            <div>
              <dt>{message("tasks.primaryProvider")}</dt>
              <dd>{configuration?.primaryModel?.provider ?? message("common.notConfigured")}</dd>
            </div>
            <div>
              <dt>{message("tasks.primaryModelVersion")}</dt>
              <dd>
                {configuration?.primaryModel
                  ? `${configuration.primaryModel.model} / ${configuration.primaryModel.version}`
                  : message("common.notConfigured")}
              </dd>
            </div>
            <div>
              <dt>{message("tasks.repositoryScope")}</dt>
              <dd>
                {configuration?.repositoryAllowlistRefs?.join(", ") ||
                  message("common.notConfigured")}
              </dd>
            </div>
            <div>
              <dt>{message("tasks.classifications")}</dt>
              <dd>
                {configuration?.disclosedDataClassifications?.join(", ") ||
                  message("common.notConfigured")}
              </dd>
            </div>
          </dl>
        </section>
      ) : null}

      {route.surfaceId === "settings" ? (
        <Tabs
          activeId={settingsTab}
          label={message("settings.tabsLabel")}
          onChange={setSettingsTab}
          tabs={[
            {
              id: "language",
              label: message("settings.language"),
              panel: <p>{message("settings.languageHelp")}</p>,
            },
            {
              id: "models",
              label: message("settings.modelsBudgets"),
              panel: <p>{message("settings.contractPending")}</p>,
            },
            {
              id: "attention",
              label: message("settings.attentionDigest"),
              panel: <p>{message("settings.contractPending")}</p>,
            },
            {
              id: "integrations",
              label: message("settings.integrations"),
              panel: <p>{message("settings.contractPending")}</p>,
            },
          ]}
        />
      ) : null}

      {snapshot?.type === "health.snapshot" ? (
        <dl className="health-grid">
          <div>
            <dt>{message("health.service")}</dt>
            <dd>{message(snapshot.payload.live ? "health.live" : "health.unavailable")}</dd>
          </div>
          <div>
            <dt>{message("health.admission")}</dt>
            <dd>{message(snapshot.payload.ready ? "health.ready" : "health.notReady")}</dd>
          </div>
          <div>
            <dt>{message("health.state")}</dt>
            <dd>{snapshot.payload.status}</dd>
          </div>
          <div>
            <dt>{message("health.host")}</dt>
            <dd>{snapshot.payload.activeHost}</dd>
          </div>
        </dl>
      ) : null}
    </>
  );

  return (
    <ControlCenterShell
      connection={connection}
      content={
        route.surfaceId === "threads"
          ? threadModel.content
          : governanceSurface
            ? governanceModel.content
            : genericContent
      }
      details={
        route.surfaceId === "threads"
          ? threadModel.details
          : governanceSurface
            ? governanceModel.details
            : genericDetails
      }
      list={
        route.surfaceId === "threads"
          ? threadModel.list
          : governanceSurface
            ? governanceModel.list
            : genericList
      }
      locale={locale}
      onLocaleChange={onLocaleChange}
      onNavigate={navigate}
      onPreferencesChange={onPreferencesChange}
      pageTitle={message(titleIds[route.surfaceId])}
      preferences={preferences}
      route={route}
    />
  );
}
