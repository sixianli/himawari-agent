import type {
  ThreadGatewayRequestResult,
  ThreadGatewaySnapshot,
} from "@himawari-agent/gateway-contracts";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { ControlCenterRouteState } from "./app/router.js";
import type { ControlCenterBrowserStorage, PendingThreadMutation } from "./browser-storage.js";
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
type ThreadMessage = ThreadDetailSnapshot["payload"]["messages"][number];

type ThreadIntent =
  | { readonly kind: "submit"; readonly content: string }
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

function messageLabel(message: ThreadMessage): string {
  return `${message.role} #${message.sequence}`;
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
  const [renameTitle, setRenameTitle] = useState("");
  const [searchText, setSearchText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mutationStatus, setMutationStatus] = useState<MutationStatus | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const refreshSequence = useRef(0);
  const selectedThreadId = route.objectId ?? null;

  const loadPayloads = useCallback(
    async (refs: readonly string[]) => {
      if (!client) return;
      const unique = [...new Set(refs)];
      const entries = await Promise.all(
        unique.map(async (ref) => {
          try {
            return [ref, (await client.readText(ref)).content] as const;
          } catch {
            return [ref, message("common.unknown")] as const;
          }
        }),
      );
      setContentByRef((current) => Object.freeze({ ...current, ...Object.fromEntries(entries) }));
    },
    [client, message],
  );

  const refresh = useCallback(async () => {
    if (!active || !client || !configuration) return;
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
      const current = await client.queryThread(
        threadQueryMessage(configuration, "thread.detail", {
          threadId: selectedThreadId,
          afterSequence: 0,
          limit: 1000,
        }),
      );
      if (sequence !== refreshSequence.current || current.type !== "thread.detail_snapshot") return;
      setDetail(current);
      setDraft(storage.readDraft(selectedThreadId));
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
      if (sequence === refreshSequence.current) setLoading(false);
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
    storage,
  ]);

  useEffect(() => {
    void refreshSignal;
    void refresh();
  }, [refresh, refreshSignal]);

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
      if (!client || !configuration || !detail || connection !== "connected") return;
      const thread = detail.payload.thread;
      const revision = expectedRevision ?? thread.revision;
      const commandType =
        intent.kind === "submit"
          ? "thread.message.submit"
          : intent.kind === "locale"
            ? "thread.set_answer_locale"
            : `thread.${intent.kind}`;
      const identity = mutationIdentity(storage, {
        operationKey: operationKey(intent.kind, thread.threadId, revision),
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
          | "thread.rename"
          | "thread.pin"
          | "thread.archive"
          | "thread.restore"
          | "thread.fork"
          | "thread.set_answer_locale"
          | "thread.trash";
        switch (intent.kind) {
          case "submit": {
            const contentRef = await client.protectText(
              intent.content,
              "private",
              `payload-content:${stableSuffix}`,
            );
            type = "thread.message.submit";
            payload = {
              threadId: thread.threadId,
              expectedRevision: revision,
              messageId: `message:${stableSuffix}`,
              turnId: `turn:${stableSuffix}`,
              runId: `run:${stableSuffix}`,
              sessionId: `session:${configuration.actorId}`.slice(0, 128),
              contentRef,
              sourceProofRef: `browser:${configuration.actorId}`.slice(0, 128),
              dataClassification: "private",
              occurredAt: new Date().toISOString(),
              resultRef,
            };
            break;
          }
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
          setDraft("");
        }
        if (intent.kind === "fork" && result.kind === "result") {
          navigate({ ...route, objectId: result.payload.threadId, view: "details" });
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
        navigate({ ...route, objectId: result.payload.threadId, view: "details" });
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
              navigate({ ...route, objectId: thread.threadId, view: "details" });
            }}
          >
            <span>
              {thread.titleRef
                ? (contentByRef[thread.titleRef] ?? thread.threadId)
                : thread.threadId}
            </span>
            <small>
              {message(threadStatusMessageId(thread.status))} · r{thread.revision}
            </small>
          </AppLink>
        )}
      />
    </div>
  );

  const content = (
    <div className="thread-content">
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
      <StatusRegion className="mutation-status">
        {message("mutation.label")}: {message(mutationMessageId(mutationStatus))}
      </StatusRegion>
      {!detail ? (
        <p>{loading ? message("state.loading") : message("common.select")}</p>
      ) : (
        <>
          <header className="thread-heading">
            <div>
              <h2>
                {detail.payload.thread.titleRef
                  ? (contentByRef[detail.payload.thread.titleRef] ?? detail.payload.thread.threadId)
                  : detail.payload.thread.threadId}
              </h2>
              <p>
                {message("threads.revision")}: {detail.payload.thread.revision}
              </p>
            </div>
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
          </header>
          <Banner title={message("threads.rawContentNotice")} tone="info">
            <ActionButton disabled variant="secondary">
              {message("threads.translate")}
            </ActionButton>
          </Banner>
          <section aria-labelledby="thread-messages-title">
            <h3 id="thread-messages-title">{message("threads.messages")}</h3>
            <SemanticList
              empty={message("threads.messagesEmpty")}
              getId={(item) => item.messageId}
              items={detail.payload.messages}
              label={message("threads.messages")}
              renderItem={(item) => (
                <article className={`thread-message thread-message-${item.role}`}>
                  <header>
                    <strong>{messageLabel(item)}</strong>
                    <time dateTime={item.committedAt}>{item.committedAt}</time>
                  </header>
                  <pre className="thread-message-content">
                    {contentByRef[item.contentRef] ?? "…"}
                  </pre>
                  <div className="message-actions">
                    <code>{item.dataClassification}</code>
                    {item.turnId ? (
                      <ActionButton
                        onClick={() =>
                          void performIntent({
                            kind: "fork",
                            sourceTurnId: item.turnId as string,
                            sourceWatermark: item.sequence,
                          })
                        }
                        variant="secondary"
                      >
                        {message("threads.fork")}
                      </ActionButton>
                    ) : null}
                  </div>
                </article>
              )}
            />
          </section>
          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              if (draft.trim()) void performIntent({ kind: "submit", content: draft });
            }}
          >
            <Field label={message("threads.draft")}>
              <textarea
                rows={7}
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  storage.saveDraft(detail.payload.thread.threadId, event.target.value);
                }}
              />
            </Field>
            <ActionButton
              disabled={!draft.trim() || connection !== "connected"}
              pending={mutationStatus === "pending"}
              type="submit"
            >
              {message("threads.send")}
            </ActionButton>
          </form>
        </>
      )}
    </div>
  );

  const details = selectedSummary ? (
    <div className="thread-details">
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

  return Object.freeze({ content, details, list, refresh });
}
