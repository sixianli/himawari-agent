import type {
  GatewayV2Event,
  GatewayV2Query,
  GatewayV2Snapshot,
} from "@himawari-agent/gateway-contracts";
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
  type ControlCenterPreferences,
  type ControlCenterUiLocale,
} from "./browser-storage.js";
import {
  ActionButton,
  AppLink,
  Banner,
  Field,
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
import { commandMessage, queryMessage } from "./messages.js";
import { SseStateSynchronizer } from "./sse-synchronizer.js";

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
      return queryMessage(configuration, "thread.list", {
        afterCursor: route.afterCursor,
        limit: 100,
      });
    case "approvals":
      return queryMessage(configuration, "approval.list", {
        status: ["pending", "approved", "denied", "expired"].includes(route.status ?? "")
          ? route.status
          : "pending",
        afterCursor: route.afterCursor,
        limit: 100,
      });
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
  const [events, setEvents] = useState<readonly GatewayV2Event[]>([]);
  const [connection, setConnection] = useState<"connecting" | "connected" | "offline">(
    "connecting",
  );
  const [loading, setLoading] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [mutationStatus, setMutationStatus] = useState<MutationStatus | null>(null);
  const [selectedRef, setSelectedRef] = useState(route.objectId ?? "");
  const initialThreadId =
    route.surfaceId === "threads" && route.objectId ? route.objectId : "thread-main";
  const [threadId, setThreadId] = useState(initialThreadId);
  const [draft, setDraft] = useState(() => storage.readDraft(initialThreadId));
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
      onEvent: (event) => setEvents((current) => [...current.slice(-199), event]),
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
        setEvents([]);
        setSelectedRef("");
        setMutationStatus(null);
        setRequestError("CONTROL_CENTER_REAUTHENTICATION_REQUIRED");
      } else {
        setRequestError(error instanceof Error ? error.message : "CONTROL_CENTER_REQUEST_REJECTED");
      }
    } finally {
      setLoading(false);
    }
  }, [client, configuration, route]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runMutation = useCallback(
    async (operation: () => Promise<{ readonly status: MutationStatus }>) => {
      if (connection !== "connected") {
        setMutationStatus("rejected");
        setRequestError("CONTROL_CENTER_OFFLINE_COMMAND_REJECTED");
        return;
      }
      setMutationStatus("pending");
      setRequestError(null);
      try {
        const result = await operation();
        setMutationStatus(result.status);
        await refresh();
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "CONTROL_CENTER_REQUEST_REJECTED";
        setMutationStatus(errorMessage.includes("EXPIRED") ? "expired" : "rejected");
        setRequestError(errorMessage);
      }
    },
    [connection, refresh],
  );

  const submitDraft = async () => {
    if (!client || !configuration || !draft.trim()) return;
    await runMutation(async () => {
      const contentRef = await client.protectText(draft, "private");
      const result = await client.mutate(
        commandMessage(configuration, "thread.message.submit", {
          threadId,
          messageId: `client:${crypto.randomUUID()}`,
          contentRef,
          clientCreatedAt: new Date().toISOString(),
        }),
      );
      storage.saveDraft(threadId, "");
      setDraft("");
      return result;
    });
  };

  const cancelRun = async () => {
    if (!client || !configuration || !selectedRef) return;
    await runMutation(() =>
      client.mutateV1({
        schemaVersion: "gateway.v1",
        kind: "command",
        type: "run.cancel",
        messageId: `message:${crypto.randomUUID()}`,
        correlationId: `correlation:${crypto.randomUUID()}`,
        causationId: null,
        dataClassification: "private",
        scope: { ownerId: configuration.ownerId, agentId: configuration.agentId },
        actor: { actorType: "owner", actorId: configuration.actorId },
        idempotencyKey: `idempotency:${crypto.randomUUID()}`,
        payload: { runId: selectedRef, reasonCode: "owner_cancelled" },
      }),
    );
  };

  const itemRefs =
    snapshot?.kind === "snapshot" && snapshot.type === "collection.snapshot"
      ? snapshot.payload.itemRefs
      : [];

  const selectReference = (reference: string) => {
    setSelectedRef(reference);
    navigate({ ...route, objectId: reference, view: "details" });
  };

  const list = (
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

  const details = (
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

  const content = (
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

      {route.surfaceId === "threads" ? (
        <section className="thread-workspace">
          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              void submitDraft();
            }}
          >
            <Field hint={message("threads.idHint")} label={message("threads.id")}>
              <input
                value={threadId}
                onChange={(event) => {
                  storage.saveDraft(threadId, draft);
                  setThreadId(event.target.value);
                  setDraft(storage.readDraft(event.target.value));
                }}
              />
            </Field>
            <Field label={message("threads.draft")}>
              <textarea
                rows={7}
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  storage.saveDraft(threadId, event.target.value);
                }}
              />
            </Field>
            <div className="actions">
              <ActionButton
                disabled={!draft.trim() || connection !== "connected"}
                pending={mutationStatus === "pending"}
                type="submit"
              >
                {message("threads.send")}
              </ActionButton>
              <ActionButton
                disabled={!selectedRef || connection !== "connected"}
                onClick={() => void cancelRun()}
                variant="secondary"
              >
                {message("threads.cancelRun")}
              </ActionButton>
            </div>
          </form>
          <section aria-labelledby="run-events-title">
            <h3 id="run-events-title">{message("threads.events")}</h3>
            <SemanticList
              empty={message("threads.eventsEmpty")}
              getId={(event) => event.payload.cursor}
              items={events.slice(-10)}
              label={message("threads.events")}
              renderItem={(event) => (
                <span className="event-row">
                  <strong>{event.payload.eventType}</strong>
                  <code>{event.payload.cursor}</code>
                </span>
              )}
            />
          </section>
        </section>
      ) : null}

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
      content={content}
      details={details}
      list={list}
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
