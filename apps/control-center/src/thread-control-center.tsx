import type {
  ThreadExecutionRecord,
  ThreadGatewayRequestResult,
  ThreadGatewaySnapshot,
} from "@himawari-agent/gateway-contracts";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { ControlCenterRouteState } from "./app/router.js";
import type { ControlCenterBrowserStorage, PendingThreadMutation } from "./browser-storage.js";
import { ChatComposer } from "./components/chat-composer.js";
import { ChatHistory } from "./components/chat-history.js";
import {
  ActionButton,
  AppLink,
  Banner,
  Field,
  SemanticList,
  StatusRegion,
} from "./components/index.js";
import type {
  ControlCenterRuntimeConfiguration,
  GatewayClient,
  MutationStatus,
} from "./gateway-client.js";
import type { MessageId } from "./i18n/message-ids.js";
import { threadCommandMessage, threadQueryMessage } from "./messages.js";
import { SearchAuthorizationControl } from "./components/search-authorization-control.js";
import { RunApprovalCard } from "./components/run-approval-card.js";

type ThreadCollectionSnapshot = Extract<
  ThreadGatewaySnapshot,
  { type: "thread.collection_snapshot" | "thread.search_snapshot" }
>;
type ThreadDetailSnapshot = Extract<ThreadGatewaySnapshot, { type: "thread.detail_snapshot" }>;
type ThreadCheckpointSnapshot = Extract<
  ThreadGatewaySnapshot,
  { type: "thread.checkpoint_snapshot" }
>;
type ThreadDeletionImpactSnapshot = Extract<
  ThreadGatewaySnapshot,
  { type: "thread.deletion_impact_snapshot" }
>;
type ThreadSummary = ThreadDetailSnapshot["payload"]["thread"];

type ThreadIntent =
  | {
      readonly kind: "submit";
      readonly content: string;
      readonly selection?: { modelRef: string; thinkingLevel: string };
    }
  | { readonly kind: "stop"; readonly runId: string; readonly revision: number }
  | { readonly kind: "rename"; readonly title: string }
  | { readonly kind: "pin"; readonly pinOrder: number | null }
  | { readonly kind: "archive" }
  | { readonly kind: "restore" }
  | { readonly kind: "trash" }
  | { readonly kind: "locale"; readonly answerLocale: "zh-CN" | "en" | "ja" }
  | {
      readonly kind: "fork";
      readonly sourceTurnId: string;
      readonly sourceWatermark: number;
    };

interface ConflictState {
  readonly intent: ThreadIntent;
  readonly latest: ThreadSummary | null;
}

export interface ThreadControlCenterOptions {
  readonly active: boolean;
  readonly client: GatewayClient | undefined;
  readonly configuration: ControlCenterRuntimeConfiguration | undefined;
  readonly connection: "connecting" | "connected" | "offline";
  readonly message: (
    id: MessageId,
    values?: Record<string, string | number | boolean | Date>,
  ) => string;
  readonly navigate: (route: ControlCenterRouteState) => void;
  readonly refreshSignal: number;
  readonly route: ControlCenterRouteState;
  readonly storage: ControlCenterBrowserStorage;
  readonly onUnauthorized: () => void;
}

export interface ThreadControlCenterModel {
  readonly title: string;
  readonly content: ReactNode;
  readonly details: ReactNode;
  readonly list: ReactNode;
  readonly refresh: () => Promise<void>;
}

function threadStatusMessageId(status: ThreadSummary["status"]): MessageId {
  switch (status) {
    case "active":
      return "threads.status.active";
    case "archived":
      return "threads.status.archived";
    case "trashed":
      return "threads.status.trashed";
    case "deletion_pending":
      return "threads.status.deletionPending";
    case "deleted_verified":
      return "threads.status.deletedVerified";
  }
}

function runStatusMessageId(
  status: ThreadDetailSnapshot["payload"]["runs"][number]["status"],
): MessageId {
  switch (status) {
    case "accepted":
      return "runs.status.accepted";
    case "building_context":
      return "runs.status.buildingContext";
    case "running":
      return "runs.status.running";
    case "awaiting_approval":
      return "runs.status.awaitingApproval";
    case "reconciling_external_result":
      return "runs.status.reconcilingExternalResult";
    case "completed":
      return "runs.status.completed";
    case "failed":
      return "runs.status.failed";
    case "cancelled":
      return "runs.status.cancelled";
  }
}

function mutationMessageId(status: MutationStatus | null): MessageId {
  return status ? (`mutation.${status}` as MessageId) : "mutation.none";
}

function operationKey(kind: string, threadId: string, revision: number | string): string {
  return `op:${kind}:${revision}:${threadId.slice(-32)}`.slice(0, 128);
}

function mutationIdentity(
  storage: ControlCenterBrowserStorage,
  input: {
    readonly operationKey: string;
    readonly commandType: string;
    readonly threadId: string;
  },
): PendingThreadMutation {
  const existing = storage.readPendingThreadMutation(input.operationKey);
  if (existing) return existing;
  const created = Object.freeze({
    ...input,
    idempotencyKey: `idempotency:${crypto.randomUUID()}`,
  });
  storage.savePendingThreadMutation(created);
  return created;
}

export function useThreadControlCenter(
  options: ThreadControlCenterOptions,
): ThreadControlCenterModel {
  const {
    active,
    client,
    configuration,
    connection,
    message,
    navigate,
    onUnauthorized,
    refreshSignal,
    route,
    storage,
  } = options;
  const [collection, setCollection] = useState<ThreadCollectionSnapshot>();
  const [detail, setDetail] = useState<ThreadDetailSnapshot>();
  const [checkpoint, setCheckpoint] = useState<ThreadCheckpointSnapshot>();
  const [deletionImpact, setDeletionImpact] = useState<ThreadDeletionImpactSnapshot>();
  const [contentByRef, setContentByRef] = useState<Readonly<Record<string, string>>>({});
  const [draft, setDraft] = useState("");
  const [execution, setExecution] = useState<
    Readonly<Record<string, readonly ThreadExecutionRecord[]>>
  >({});
  const [modelRef, setModelRef] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState("off");
  const availableModels = configuration?.availableModels ?? [];
  const selectedModel =
    availableModels.find((item) => item.ref === modelRef) ??
    availableModels.find((item) => item.ref === configuration?.primaryModelRef) ??
    availableModels[0];
  const selectedThinking = selectedModel?.thinkingLevels.includes(thinkingLevel)
    ? thinkingLevel
    : (selectedModel?.thinkingLevels[0] ?? "off");
  const payloadCache = useRef<Record<string, string>>({});
  const executionCache = useRef<Record<string, ThreadExecutionRecord[]>>({});
  const [renameTitle, setRenameTitle] = useState("");
  const [searchText, setSearchText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mutationStatus, setMutationStatus] = useState<MutationStatus | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const refreshSequence = useRef(0);
  const refreshing = useRef(false);
  const refreshAgain = useRef(false);
  const refreshLatest = useRef<() => Promise<void>>(async () => {});
  const refreshTimer = useRef<number | undefined>(undefined);
  const selectedThreadId = route.objectId ?? null;
  const selectedIdRef = useRef(selectedThreadId);
  selectedIdRef.current = selectedThreadId;
  useEffect(() => {
    refreshSequence.current++;
    setDetail(undefined);
    setDraft(selectedThreadId ? storage.readDraft(selectedThreadId) : "");
    setConflict(null);
    setMutationStatus(null);
  }, [selectedThreadId, storage]);
  useEffect(() => {
    void client;
    setContentByRef({});
    setExecution({});
    return () => {
      refreshSequence.current++;
      payloadCache.current = {};
      executionCache.current = {};
    };
  }, [client]);

  const loadPayloads = useCallback(
    async (refs: readonly string[]) => {
      if (!client) return;
      const unique = [...new Set(refs)].filter((ref) => payloadCache.current[ref] === undefined);
      const sequence = refreshSequence.current;
      const entries = await Promise.all(
        unique.map(async (ref) => {
          try {
            return [ref, (await client.readText(ref)).content] as const;
          } catch {
            return [ref, message("common.unknown")] as const;
          }
        }),
      );
      if (sequence !== refreshSequence.current) return;
      Object.assign(payloadCache.current, Object.fromEntries(entries));
      setContentByRef({ ...payloadCache.current });
    },
    [client, message],
  );

  const refresh = useCallback(async () => {
    if (!active || !client || !configuration) return;
    if (refreshing.current) {
      refreshAgain.current = true;
      return;
    }
    refreshing.current = true;
    const sequence = ++refreshSequence.current;
    setLoading(true);
    setError(null);
    try {
      const statuses =
        route.status === "archived"
          ? (["archived"] as const)
          : route.status === "all"
            ? (["active", "archived"] as const)
            : (["active"] as const);
      const list = await client.queryThread(
        threadQueryMessage(configuration, "thread.list", {
          statuses,
          pinnedOnly: false,
          afterCursor: route.afterCursor,
          limit: 100,
        }),
      );
      if (sequence !== refreshSequence.current || list.type !== "thread.collection_snapshot") {
        return;
      }
      setCollection(list);
      void loadPayloads(
        list.payload.threads.flatMap((thread) => (thread.titleRef ? [thread.titleRef] : [])),
      );
      if (!selectedThreadId) {
        setDetail(undefined);
        return;
      }
      let current = await client.queryThread(
        threadQueryMessage(configuration, "thread.detail", {
          threadId: selectedThreadId,
          afterSequence: 0,
          limit: 1000,
        }),
      );
      if (sequence !== refreshSequence.current || current.type !== "thread.detail_snapshot") return;
      const pages = [...current.payload.messages];
      while (current.payload.nextSequence !== null) {
        const page = await client.queryThread(
          threadQueryMessage(configuration, "thread.detail", {
            threadId: selectedThreadId,
            afterSequence: current.payload.nextSequence,
            limit: 1000,
          }),
        );
        if (sequence !== refreshSequence.current || page.type !== "thread.detail_snapshot") return;
        if (
          page.payload.nextSequence !== null &&
          page.payload.nextSequence <= (current.payload.nextSequence ?? 0)
        )
          throw new Error("THREAD_PAGE_NOT_ADVANCING");
        pages.push(...page.payload.messages);
        current = page;
      }
      current = {
        ...current,
        payload: {
          ...current.payload,
          messages: [...new Map(pages.map((item) => [item.messageId, item])).values()].sort(
            (a, b) => a.sequence - b.sequence,
          ),
        },
      };
      setDetail(current);
      if (configuration.executionPresentationAvailable) {
        await Promise.all(
          current.payload.runs.map(async (run) => {
            const cached = executionCache.current[run.runId] ?? [];
            let afterSequence = cached.at(-1)?.sequence ?? 0;
            const records = [...cached];
            for (;;) {
              const page = await client.queryThread(
                threadQueryMessage(configuration, "thread.execution", {
                  threadId: selectedThreadId,
                  runId: run.runId,
                  afterSequence,
                  limit: 200,
                }),
              );
              if (sequence !== refreshSequence.current || page.type !== "thread.execution_snapshot")
                return;
              records.push(...page.payload.records);
              if (page.payload.nextSequence === null) break;
              if (page.payload.nextSequence <= afterSequence)
                throw new Error("EXECUTION_PAGE_NOT_ADVANCING");
              afterSequence = page.payload.nextSequence;
            }
            executionCache.current[run.runId] = [
              ...new Map(records.map((item) => [item.id, item])).values(),
            ].sort((a, b) => a.sequence - b.sequence);
          }),
        );
        if (sequence !== refreshSequence.current) return;
        setExecution({ ...executionCache.current });
      }
      void loadPayloads([
        ...(current.payload.thread.titleRef ? [current.payload.thread.titleRef] : []),
        ...current.payload.messages.map(({ contentRef }) => contentRef),
      ]);
    } catch (caught) {
      const status =
        caught && typeof caught === "object" && "status" in caught
          ? (caught as { readonly status?: unknown }).status
          : null;
      if (status === 401) onUnauthorized();
      setError(caught instanceof Error ? caught.message : "CONTROL_CENTER_REQUEST_REJECTED");
    } finally {
      refreshing.current = false;
      if (sequence === refreshSequence.current) setLoading(false);
      if (refreshAgain.current) {
        refreshAgain.current = false;
        refreshTimer.current = window.setTimeout(() => {
          refreshTimer.current = undefined;
          void refreshLatest.current();
        }, 80);
      }
    }
  }, [
    active,
    client,
    configuration,
    loadPayloads,
    onUnauthorized,
    route.afterCursor,
    route.status,
    selectedThreadId,
  ]);

  refreshLatest.current = refresh;
  useEffect(() => {
    void refresh;
    void refreshSignal;
    if (refreshTimer.current === undefined)
      refreshTimer.current = window.setTimeout(() => {
        refreshTimer.current = undefined;
        void refreshLatest.current();
      }, 80);
  }, [refresh, refreshSignal]);
  useEffect(
    () => () => {
      if (refreshTimer.current !== undefined) window.clearTimeout(refreshTimer.current);
    },
    [],
  );

  const settleMutation = useCallback(
    async (
      identity: PendingThreadMutation,
      result: ThreadGatewayRequestResult,
      intent: ThreadIntent | null,
    ) => {
      storage.clearPendingThreadMutation(identity.operationKey);
      if (result.kind === "conflict") {
        setMutationStatus("rejected");
        if (intent) {
          setConflict({ intent, latest: result.payload.latest });
        } else {
          setConflict(null);
          setError(result.payload.reasonCode);
        }
      } else if (result.kind === "result") {
        setMutationStatus(result.payload.replayed ? "replayed" : "accepted");
        setConflict(null);
      }
      await refresh();
    },
    [refresh, storage],
  );

  const performIntent = useCallback(
    async (intent: ThreadIntent, expectedRevision?: number) => {
      if (
        !client ||
        !configuration ||
        !detail ||
        detail.payload.thread.threadId !== selectedIdRef.current ||
        connection !== "connected"
      )
        return;
      const thread = detail.payload.thread;
      const revision = expectedRevision ?? thread.revision;
      const commandType =
        intent.kind === "submit"
          ? intent.selection
            ? "thread.message.submit_configured"
            : "thread.message.submit"
          : intent.kind === "stop"
            ? "thread.run.cancel"
            : intent.kind === "locale"
              ? "thread.set_answer_locale"
              : `thread.${intent.kind}`;
      const identity = mutationIdentity(storage, {
        operationKey: operationKey(
          intent.kind,
          thread.threadId,
          intent.kind === "stop" ? intent.runId : revision,
        ),
        commandType,
        threadId: thread.threadId,
      });
      setMutationStatus("pending");
      setError(null);
      try {
        const stableSuffix = identity.idempotencyKey.split(":").at(-1) ?? crypto.randomUUID();
        const resultRef = await client.protectText(
          `thread-action:${intent.kind}`,
          "private",
          `payload-result:${stableSuffix}`,
        );
        let payload: unknown;
        let type:
          | "thread.message.submit"
          | "thread.message.submit_configured"
          | "thread.run.cancel"
          | "thread.rename"
          | "thread.pin"
          | "thread.archive"
          | "thread.restore"
          | "thread.fork"
          | "thread.set_answer_locale"
          | "thread.trash";
        switch (intent.kind) {
          case "submit": {
            if (!configuration.sessionId)
              throw new Error("CONTROL_CENTER_REAUTHENTICATION_REQUIRED");
            const contentRef = await client.protectText(
              intent.content,
              "private",
              `payload-content:${stableSuffix}`,
            );
            type = intent.selection ? "thread.message.submit_configured" : "thread.message.submit";
            payload = {
              ...(intent.selection ?? {}),
              threadId: thread.threadId,
              expectedRevision: revision,
              messageId: `message:${stableSuffix}`,
              turnId: `turn:${stableSuffix}`,
              runId: `run:${stableSuffix}`,
              sessionId: configuration.sessionId,
              contentRef,
              sourceProofRef: `browser:${configuration.actorId}`.slice(0, 128),
              dataClassification: "private",
              occurredAt: new Date().toISOString(),
              resultRef,
            };
            break;
          }
          case "stop":
            type = "thread.run.cancel";
            payload = {
              threadId: thread.threadId,
              runId: intent.runId,
              expectedRunRevision:
                detail.payload.runs.find((run) => run.runId === intent.runId)?.revision ??
                intent.revision,
              resultRef,
            };
            break;
          case "rename": {
            const titleRef = await client.protectText(
              intent.title,
              "private",
              `payload-title:${stableSuffix}`,
            );
            type = "thread.rename";
            payload = {
              threadId: thread.threadId,
              expectedRevision: revision,
              titleRef,
              titleSource: "owner",
              resultRef,
            };
            break;
          }
          case "pin":
            type = "thread.pin";
            payload = {
              threadId: thread.threadId,
              expectedRevision: revision,
              pinOrder: intent.pinOrder,
              resultRef,
            };
            break;
          case "archive":
          case "restore":
          case "trash":
            type = `thread.${intent.kind}`;
            payload = {
              threadId: thread.threadId,
              expectedRevision: revision,
              reasonCode: "owner_requested",
              resultRef,
            };
            break;
          case "locale":
            type = "thread.set_answer_locale";
            payload = {
              threadId: thread.threadId,
              expectedRevision: revision,
              answerLocale: intent.answerLocale,
              resultRef,
            };
            break;
          case "fork":
            type = "thread.fork";
            payload = {
              sourceThreadId: thread.threadId,
              sourceTurnId: intent.sourceTurnId,
              sourceWatermark: intent.sourceWatermark,
              targetThreadId: `thread-fork:${stableSuffix}`,
              summaryRefs: [],
              policyRefs: [`answer-locale:${thread.answerLocale}`],
              resultRef,
            };
            break;
        }
        const result = await client.mutateThread(
          threadCommandMessage(configuration, type, payload, identity.idempotencyKey),
        );
        if (intent.kind === "submit" && result.kind === "result") {
          storage.saveDraft(thread.threadId, "");
          if (selectedIdRef.current === thread.threadId) setDraft("");
        }
        if (intent.kind === "fork" && result.kind === "result") {
          navigate({ ...route, objectId: result.payload.threadId, view: "content" });
        }
        await settleMutation(identity, result, intent);
      } catch (caught) {
        setMutationStatus("rejected");
        setError(caught instanceof Error ? caught.message : "CONTROL_CENTER_REQUEST_REJECTED");
      }
    },
    [client, configuration, connection, detail, navigate, route, settleMutation, storage],
  );

  const createThread = async () => {
    if (!client || !configuration || connection !== "connected") return;
    const threadId = `thread:${crypto.randomUUID()}`;
    const identity = mutationIdentity(storage, {
      operationKey: operationKey("create", threadId, "new"),
      commandType: "thread.create",
      threadId,
    });
    setMutationStatus("pending");
    try {
      const suffix = identity.idempotencyKey.split(":").at(-1) ?? crypto.randomUUID();
      const resultRef = await client.protectText(
        "thread-action:create",
        "private",
        `payload-result:${suffix}`,
      );
      const result = await client.mutateThread(
        threadCommandMessage(
          configuration,
          "thread.create",
          { threadId, answerLocale: "zh-CN", resultRef },
          identity.idempotencyKey,
        ),
      );
      await settleMutation(identity, result, null);
      if (result.kind === "result") {
        navigate({ ...route, objectId: result.payload.threadId, view: "content" });
      }
    } catch (caught) {
      setMutationStatus("rejected");
      setError(caught instanceof Error ? caught.message : "CONTROL_CENTER_REQUEST_REJECTED");
    }
  };

  const search = async () => {
    if (!client || !configuration || !searchText.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const prepared = await client.prepareThreadSearch(searchText);
      const result = await client.queryThread(
        threadQueryMessage(configuration, "thread.search", {
          queryRef: prepared.queryRef,
          tokenRefs: prepared.tokenRefs,
          projectionVersion: prepared.projectionVersion,
          statuses: ["active", "archived"],
          jobStatuses: [],
          updatedAfter: null,
          updatedBefore: null,
          afterCursor: null,
          limit: 100,
        }),
      );
      if (result.type !== "thread.search_snapshot") {
        throw new Error("CONTROL_CENTER_RESPONSE_INVALID");
      }
      setCollection(result);
      void loadPayloads(
        result.payload.threads.flatMap((thread) => (thread.titleRef ? [thread.titleRef] : [])),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "CONTROL_CENTER_REQUEST_REJECTED");
    } finally {
      setLoading(false);
    }
  };

  const inspectCheckpoint = async () => {
    if (!client || !configuration || !detail) return;
    const result = await client.queryThread(
      threadQueryMessage(configuration, "thread.checkpoint", {
        threadId: detail.payload.thread.threadId,
        sourceWatermark: null,
      }),
    );
    if (result.type === "thread.checkpoint_snapshot") setCheckpoint(result);
  };

  const inspectDeletion = async () => {
    if (!client || !configuration || !detail) return;
    const result = await client.queryThread(
      threadQueryMessage(configuration, "thread.deletion_impact", {
        threadId: detail.payload.thread.threadId,
      }),
    );
    if (result.type === "thread.deletion_impact_snapshot") setDeletionImpact(result);
  };

  const resolveTask = async (
    task: ThreadDeletionImpactSnapshot["payload"]["associatedTasks"][number],
    action: "pause" | "cancel" | "rebind",
  ) => {
    if (!client || !configuration || !detail) return;
    const thread = detail.payload.thread;
    const identity = mutationIdentity(storage, {
      operationKey: operationKey(`${action}:${task.taskId}`, thread.threadId, task.revision),
      commandType: "thread.task.resolve",
      threadId: thread.threadId,
    });
    const suffix = identity.idempotencyKey.split(":").at(-1) ?? crypto.randomUUID();
    try {
      const resultRef = await client.protectText(
        `thread-task:${action}`,
        "private",
        `payload-result:${suffix}`,
      );
      const targetThread =
        action === "rebind"
          ? collection?.payload.threads.find(({ threadId }) => threadId !== thread.threadId)
          : undefined;
      if (action === "rebind" && !targetThread) return;
      const result = await client.mutateThread(
        threadCommandMessage(
          configuration,
          "thread.task.resolve",
          {
            threadId: thread.threadId,
            taskId: task.taskId,
            expectedTaskRevision: task.revision,
            action,
            targetThreadId: targetThread?.threadId ?? null,
            reasonCode: "owner_resolved_deletion_dependency",
            resultRef,
          },
          identity.idempotencyKey,
        ),
      );
      await settleMutation(identity, result, null);
      await inspectDeletion();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "CONTROL_CENTER_REQUEST_REJECTED");
    }
  };

  const threadItems = collection?.payload.threads ?? [];
  const selectedSummary =
    detail?.payload.thread ?? threadItems.find(({ threadId }) => threadId === selectedThreadId);

  const list = (
    <div className="thread-list-controls">
      <div className="actions">
        <ActionButton onClick={() => void createThread()}>{message("threads.new")}</ActionButton>
        <ActionButton onClick={() => void refresh()} variant="secondary">
          {message("common.refresh")}
        </ActionButton>
      </div>
      <form
        className="thread-search"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <Field label={message("threads.search")}>
          <input
            placeholder={message("threads.searchPlaceholder")}
            type="search"
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
          />
        </Field>
        <ActionButton disabled={!searchText.trim()} type="submit" variant="secondary">
          {message("threads.search")}
        </ActionButton>
      </form>
      <fieldset className="filter-group">
        <legend>{message("threads.filter")}</legend>
        {(
          [
            [null, "threads.filterActive"],
            ["archived", "threads.filterArchived"],
            ["all", "threads.filterAll"],
          ] as const
        ).map(([status, label]) => (
          <ActionButton
            key={label}
            onClick={() => navigate({ ...route, status, afterCursor: null })}
            variant={
              route.status === status || (!route.status && status === null)
                ? "primary"
                : "secondary"
            }
          >
            {message(label)}
          </ActionButton>
        ))}
      </fieldset>
      <p>{message("objects.count", { count: threadItems.length })}</p>
      <SemanticList
        empty={loading ? message("state.loading") : message("common.noRecords")}
        getId={(thread) => thread.threadId}
        items={threadItems}
        label={message("common.currentRecords")}
        renderItem={(thread) => (
          <AppLink
            current={thread.threadId === selectedThreadId}
            href={`#${encodeURIComponent(thread.threadId)}`}
            onClick={(event) => {
              event.preventDefault();
              navigate({ ...route, objectId: thread.threadId, view: "content" });
            }}
          >
            <span>
              {thread.titleRef
                ? (contentByRef[thread.titleRef] ?? message("chat.untitled"))
                : message("chat.untitled")}
            </span>
            <small>
              {thread.pinOrder !== null
                ? message("chat.pinned")
                : new Date(thread.updatedAt).toLocaleDateString()}
            </small>
          </AppLink>
        )}
      />
    </div>
  );

  const content = (
    <div className="thread-content">
      <StatusRegion className="sr-only">
        {message("mutation.label")}: {message(mutationMessageId(mutationStatus))}
      </StatusRegion>
      {error ? (
        <Banner title={message("error.currentUnavailable")} tone="danger">
          <code>{error}</code>
        </Banner>
      ) : null}
      {connection === "offline" ? (
        <Banner title={message("state.offline")} tone="warning">
          <code>CONTROL_CENTER_OFFLINE</code>
        </Banner>
      ) : null}
      {loading ? <StatusRegion>{message("state.loading")}</StatusRegion> : null}
      {conflict ? (
        <Banner title={message("threads.conflictTitle")} tone="warning">
          <p>{message("threads.conflictDescription")}</p>
          <p>
            {message("threads.latestRevision")}: {conflict.latest?.revision ?? "—"}
          </p>
          <ActionButton
            disabled={!conflict.latest || connection !== "connected"}
            onClick={() =>
              void performIntent(conflict.intent, conflict.latest?.revision ?? undefined)
            }
          >
            {message("threads.reapply")}
          </ActionButton>
        </Banner>
      ) : null}
      {!detail ? (
        <p>{loading ? message("state.loading") : message("common.select")}</p>
      ) : (
        <>
          <ChatHistory
            key={detail.payload.thread.threadId}
            detail={detail}
            contentByRef={contentByRef}
            execution={execution}
            connection={connection}
            renderApproval={(runId, records) =>
              client && configuration ? (
                <RunApprovalCard
                  runId={runId}
                  records={records}
                  client={client}
                  configuration={configuration}
                  storage={storage}
                  connection={connection}
                  refreshSignal={refreshSignal}
                  message={message}
                  onSettled={refresh}
                  onUnauthorized={onUnauthorized}
                />
              ) : null
            }
            message={message}
            onFork={(turnId, sequence) =>
              void performIntent({ kind: "fork", sourceTurnId: turnId, sourceWatermark: sequence })
            }
          />
          <ChatComposer
            searchControl={
              client &&
              configuration?.installedGatewayV2Operations?.includes("search.authorization.set") ? (
                <SearchAuthorizationControl
                  client={client}
                  configuration={configuration}
                  storage={storage}
                  connected={connection === "connected"}
                  refreshSignal={refreshSignal}
                  message={message}
                />
              ) : null
            }
            key={`composer:${detail.payload.thread.threadId}`}
            draft={draft}
            onDraft={(value) => {
              setDraft(value);
              storage.saveDraft(detail.payload.thread.threadId, value);
            }}
            onSubmit={() =>
              void performIntent({
                kind: "submit",
                content: draft,
                ...(selectedModel
                  ? { selection: { modelRef: selectedModel.ref, thinkingLevel: selectedThinking } }
                  : {}),
              })
            }
            connected={connection === "connected"}
            pending={mutationStatus === "pending"}
            model={configuration?.primaryModel?.model}
            models={availableModels}
            modelRef={selectedModel?.ref ?? ""}
            thinkingLevel={selectedThinking}
            onModelChange={setModelRef}
            onThinkingChange={setThinkingLevel}
            onStop={
              configuration?.canCancelRun &&
              detail.payload.runs.some(
                (run) => !["completed", "failed", "cancelled"].includes(run.status),
              )
                ? () => {
                    const run = detail.payload.runs.find(
                      (item) => !["completed", "failed", "cancelled"].includes(item.status),
                    );
                    if (run)
                      void performIntent({
                        kind: "stop",
                        runId: run.runId,
                        revision: run.revision,
                      });
                  }
                : undefined
            }
            message={message}
            canSend={
              detail.payload.thread.status === "active" &&
              !detail.payload.runs.some(
                (run) => !["completed", "failed", "cancelled"].includes(run.status),
              )
            }
          />
        </>
      )}
    </div>
  );

  const details = selectedSummary ? (
    <div className="thread-details">
      {detail ? (
        <Field label={message("threads.answerLocale")}>
          <select
            value={detail.payload.thread.answerLocale}
            onChange={(event) =>
              void performIntent({
                kind: "locale",
                answerLocale: event.target.value as "zh-CN" | "en" | "ja",
              })
            }
          >
            <option value="zh-CN">简体中文</option>
            <option value="en">English</option>
            <option value="ja">日本語</option>
          </select>
        </Field>
      ) : null}
      <p>{message("threads.rawContentNotice")}</p>
      <dl>
        <div>
          <dt>Thread ID</dt>
          <dd>
            <code>{selectedSummary.threadId}</code>
          </dd>
        </div>
        <div>
          <dt>{message("common.status")}</dt>
          <dd>{message(threadStatusMessageId(selectedSummary.status))}</dd>
        </div>
        <div>
          <dt>{message("threads.revision")}</dt>
          <dd>{selectedSummary.revision}</dd>
        </div>
      </dl>
      {detail ? (
        <>
          <Field label={message("threads.rename")}>
            <input value={renameTitle} onChange={(event) => setRenameTitle(event.target.value)} />
          </Field>
          <div className="actions action-grid">
            <ActionButton
              disabled={!renameTitle.trim() || connection !== "connected"}
              onClick={() => void performIntent({ kind: "rename", title: renameTitle })}
              variant="secondary"
            >
              {message("threads.rename")}
            </ActionButton>
            <ActionButton
              onClick={() =>
                void performIntent({
                  kind: "pin",
                  pinOrder: detail.payload.thread.pinOrder === null ? 0 : null,
                })
              }
              variant="secondary"
            >
              {message(detail.payload.thread.pinOrder === null ? "threads.pin" : "threads.unpin")}
            </ActionButton>
            <ActionButton
              onClick={() =>
                void performIntent({
                  kind: detail.payload.thread.status === "archived" ? "restore" : "archive",
                })
              }
              variant="secondary"
            >
              {message(
                detail.payload.thread.status === "archived" ? "threads.restore" : "threads.archive",
              )}
            </ActionButton>
            <ActionButton onClick={() => void inspectCheckpoint()} variant="secondary">
              {message("threads.checkpoint")}
            </ActionButton>
            <ActionButton onClick={() => void inspectDeletion()} variant="secondary">
              {message("threads.inspectDeletion")}
            </ActionButton>
            <ActionButton
              disabled={!deletionImpact?.payload.deletionAllowed}
              onClick={() => void performIntent({ kind: "trash" })}
              variant="danger"
            >
              {message("threads.trash")}
            </ActionButton>
          </div>
          <section aria-labelledby="thread-runs-title">
            <h2 id="thread-runs-title">{message("threads.runStatus")}</h2>
            <SemanticList
              empty={message("common.noRecords")}
              getId={(run) => run.runId}
              items={detail.payload.runs}
              label={message("threads.runStatus")}
              renderItem={(run) => (
                <span>
                  <code>{run.runId}</code> {message(runStatusMessageId(run.status))}
                  {configuration?.canCancelRun && ["cancelled", "failed"].includes(run.status) ? (
                    <ActionButton
                      variant="secondary"
                      disabled={connection !== "connected" || mutationStatus === "pending"}
                      onClick={() =>
                        void performIntent({
                          kind: "stop",
                          runId: run.runId,
                          revision: run.revision,
                        })
                      }
                    >
                      {message("chat.retryCleanup")}
                    </ActionButton>
                  ) : null}
                  {run.status === "awaiting_approval" ? (
                    <ActionButton
                      variant="secondary"
                      onClick={() =>
                        document
                          .getElementById(`approval-${run.runId}`)
                          ?.scrollIntoView({ block: "center" })
                      }
                    >
                      {message("nav.approvals")}
                    </ActionButton>
                  ) : null}
                </span>
              )}
            />
          </section>
          <section aria-labelledby="checkpoint-title">
            <h3 id="checkpoint-title">{message("checkpoints.status")}</h3>
            <p>{checkpoint?.payload.status ?? message("checkpoints.none")}</p>
            {checkpoint?.payload.summaryRef ? <code>{checkpoint.payload.summaryRef}</code> : null}
          </section>
          {deletionImpact ? (
            <section aria-labelledby="deletion-impact-title">
              <h3 id="deletion-impact-title">{message("deletion.activeTasks")}</h3>
              <p>
                {message(
                  deletionImpact.payload.deletionAllowed ? "deletion.allowed" : "deletion.blocked",
                )}
              </p>
              <SemanticList
                empty={message("common.noRecords")}
                getId={(task) => task.taskId}
                items={deletionImpact.payload.associatedTasks}
                label={message("deletion.activeTasks")}
                renderItem={(task) => (
                  <div>
                    <code>{task.taskId}</code>
                    {task.status === "active" ? (
                      <div className="actions">
                        <ActionButton
                          onClick={() => void resolveTask(task, "pause")}
                          variant="secondary"
                        >
                          {message("deletion.pauseTask")}
                        </ActionButton>
                        <ActionButton
                          onClick={() => void resolveTask(task, "cancel")}
                          variant="secondary"
                        >
                          {message("deletion.cancelTask")}
                        </ActionButton>
                        <ActionButton
                          disabled={
                            !threadItems.some(
                              ({ threadId }) => threadId !== selectedSummary.threadId,
                            )
                          }
                          onClick={() => void resolveTask(task, "rebind")}
                          variant="secondary"
                        >
                          {message("deletion.rebindTask")}
                        </ActionButton>
                      </div>
                    ) : null}
                  </div>
                )}
              />
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  ) : (
    <p>{message("common.select")}</p>
  );

  return Object.freeze({
    content,
    details,
    list,
    refresh,
    title: selectedSummary?.titleRef
      ? (contentByRef[selectedSummary.titleRef] ?? message("chat.untitled"))
      : message("chat.untitled"),
  });
}
