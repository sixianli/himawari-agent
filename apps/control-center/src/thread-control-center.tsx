import { ContentPreview, type ContentPreviewValue } from "./components/content-preview.js";
import { ArchivedConversations } from "./components/archived-conversations.js";
import type {
  ThreadExecutionEnvironment,
  ThreadExecutionRecord,
  ThreadExecutionState,
  ThreadGatewayRequestResult,
  ThreadGatewaySnapshot,
} from "@himawari-agent/gateway-contracts";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { ControlCenterRouteState } from "./app/router.js";
import type { ControlCenterBrowserStorage, PendingThreadMutation } from "./browser-storage.js";
import { ChatComposer } from "./components/chat-composer.js";
import { ExecutionEnvironmentLine } from "./components/execution-environment.js";
import { ThreadLoadFeedback, ThreadLoadingSkeleton } from "./components/thread-load-feedback.js";
import { ThreadSidebar } from "./components/thread-sidebar.js";
import { ChatHistory } from "./components/chat-history.js";
import { ActionButton, Banner, Field, ModalDialog, StatusRegion } from "./components/index.js";
import type {
  ControlCenterRuntimeConfiguration,
  GatewayClient,
  MutationStatus,
} from "./gateway-client.js";
import type { MessageId } from "./i18n/message-ids.js";
import { threadCommandMessage, threadQueryMessage } from "./messages.js";

import { listPendingRunApprovals } from "./run-approval.js";
import { RunApprovalCard } from "./components/run-approval-card.js";

type ThreadCollectionSnapshot = Extract<
  ThreadGatewaySnapshot,
  { type: "thread.collection_snapshot" | "thread.search_snapshot" }
>;
type ThreadDetailSnapshot = Extract<ThreadGatewaySnapshot, { type: "thread.detail_snapshot" }>;
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
  readonly settingsData: ReactNode;
  readonly list: ReactNode;
  readonly refresh: () => Promise<void>;
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
  const [showOffline, setShowOffline] = useState(false);
  useEffect(() => {
    if (connection !== "offline") {
      setShowOffline(false);
      return;
    }
    const timer = window.setTimeout(() => setShowOffline(true), 1500);
    return () => window.clearTimeout(timer);
  }, [connection]);
  const [preview, setPreview] = useState<ContentPreviewValue | null>(null);
  const [pendingThreadIds, setPendingThreadIds] = useState<readonly string[]>([]);
  const [environment, setEnvironment] = useState<ThreadExecutionEnvironment>();
  const [environmentFailed, setEnvironmentFailed] = useState(false);
  const listPages = useRef(1);
  const [collection, setCollection] = useState<ThreadCollectionSnapshot>();
  const [searchResults, setSearchResults] = useState<ThreadCollectionSnapshot>();
  const [detail, setDetail] = useState<ThreadDetailSnapshot>();
  const [contentByRef, setContentByRef] = useState<Readonly<Record<string, string>>>({});
  const [draft, setDraft] = useState("");
  const [execution, setExecution] = useState<
    Readonly<Record<string, readonly ThreadExecutionRecord[]>>
  >({});
  const [executionStates, setExecutionStates] = useState<
    Readonly<Record<string, ThreadExecutionState>>
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
  const payloadEpoch = useRef(0);
  const payloadCache = useRef<Record<string, string>>({});
  const executionCache = useRef<Record<string, ThreadExecutionRecord[]>>({});
  const [renameTitle, setRenameTitle] = useState("");
  const [renameTarget, setRenameTarget] = useState<ThreadSummary | null>(null);
  const submissionLock = useRef(false);
  const [searchText, setSearchText] = useState("");
  const searchController = useRef<AbortController | null>(null);
  const searchSequence = useRef(0);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  useEffect(() => {
    void client;
    return () => {
      searchSequence.current++;
      searchController.current?.abort();
    };
  }, [client]);
  const [loading, setLoading] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [readScope, setReadScope] = useState<"list" | "conversation" | "search">("list");
  const [readAttempt, setReadAttempt] = useState(0);
  const readController = useRef<AbortController | null>(null);
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
    setPreview(null);
    setDraft(storage.readDraft(selectedThreadId ?? "new"));
    setConflict(null);
    setMutationStatus(null);
  }, [selectedThreadId, storage]);
  useEffect(() => {
    void client;
    setContentByRef({});
    setExecution({});
    setExecutionStates({});
    return () => {
      refreshSequence.current++;
      payloadEpoch.current++;
      payloadCache.current = {};
      executionCache.current = {};
    };
  }, [client]);

  useEffect(() => {
    void client;
    void selectedThreadId;
    void route.status;
    void route.afterCursor;
    void active;
    setReadFailed(false);
    return () => {
      readController.current?.abort();
      readController.current = null;
      refreshing.current = false;
      refreshAgain.current = false;
      refreshSequence.current++;
    };
  }, [client, selectedThreadId, route.status, route.afterCursor, active]);

  const loadPayloads = useCallback(
    async (refs: readonly string[]) => {
      if (!client) return;
      const unique = [...new Set(refs)].filter((ref) => payloadCache.current[ref] === undefined);
      const epoch = payloadEpoch.current;
      const entries = await Promise.all(
        unique.map(async (ref) => {
          try {
            return [ref, (await client.readText(ref)).content] as const;
          } catch {
            return [ref, message("common.unknown")] as const;
          }
        }),
      );
      if (epoch !== payloadEpoch.current) return;
      Object.assign(payloadCache.current, Object.fromEntries(entries));
      setContentByRef({ ...payloadCache.current });
    },
    [client, message],
  );

  const loadEnvironment = useCallback(async () => {
    if (!client || !configuration?.executionEnvironmentAvailable) return;
    try {
      const snapshot = await client.queryThread(
        threadQueryMessage(configuration, "thread.execution_environment", {}),
      );
      if (snapshot.type !== "thread.execution_environment_snapshot")
        throw new Error("THREAD_EXECUTION_ENVIRONMENT_INVALID");
      setEnvironment(snapshot.payload.environment);
      setEnvironmentFailed(false);
    } catch {
      setEnvironmentFailed(true);
    }
  }, [client, configuration]);

  const refresh = useCallback(
    async (force = false) => {
      if (!active || !client || !configuration) return;
      if (refreshing.current && !force) {
        refreshAgain.current = true;
        return;
      }
      if (force) {
        refreshAgain.current = false;
        if (refreshTimer.current !== undefined) {
          window.clearTimeout(refreshTimer.current);
          refreshTimer.current = undefined;
        }
      }
      readController.current?.abort();
      const controller = new AbortController();
      readController.current = controller;
      refreshing.current = true;
      const sequence = ++refreshSequence.current;
      setLoading(true);
      setReadFailed(false);
      setReadScope("list");
      setReadAttempt(sequence);
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
          controller.signal,
        );
        if (sequence !== refreshSequence.current || list.type !== "thread.collection_snapshot") {
          return;
        }
        let expandedList = list;
        const seenCursors = new Set<string>();
        for (let page = 1; page < listPages.current && expandedList.payload.nextCursor; page++) {
          const cursor = expandedList.payload.nextCursor;
          if (seenCursors.has(cursor)) throw new Error("THREAD_LIST_CURSOR_REPEATED");
          seenCursors.add(cursor);
          const next = await client.queryThread(
            threadQueryMessage(configuration, "thread.list", {
              statuses,
              pinnedOnly: false,
              afterCursor: cursor,
              limit: 100,
            }),
            controller.signal,
          );
          if (sequence !== refreshSequence.current) return;
          if (next.type !== "thread.collection_snapshot") throw new Error("THREAD_LIST_INVALID");
          if (next.payload.nextCursor === cursor) throw new Error("THREAD_LIST_CURSOR_REPEATED");
          expandedList = {
            ...next,
            payload: {
              ...next.payload,
              threads: [
                ...new Map(
                  [...expandedList.payload.threads, ...next.payload.threads].map((thread) => [
                    thread.threadId,
                    thread,
                  ]),
                ).values(),
              ],
            },
          };
        }
        setCollection(expandedList);
        void loadEnvironment();
        if (configuration.installedGatewayV2Operations?.includes("approval.list")) {
          void listPendingRunApprovals(client, configuration)
            .then((approvals) => {
              if (sequence === refreshSequence.current)
                setPendingThreadIds([
                  ...new Set(approvals.map((approval) => approval.payload.intent.threadId)),
                ]);
            })
            .catch(() => {
              /* Preserve the last verified state while reconnecting. */
            });
        }
        void loadPayloads(
          expandedList.payload.threads.flatMap((thread) =>
            thread.titleRef ? [thread.titleRef] : [],
          ),
        );
        if (!selectedThreadId) {
          setDetail(undefined);
          return;
        }
        setReadScope("conversation");
        let current = await client.queryThread(
          threadQueryMessage(configuration, "thread.detail", {
            threadId: selectedThreadId,
            afterSequence: 0,
            limit: 1000,
          }),
          controller.signal,
        );
        if (sequence !== refreshSequence.current || current.type !== "thread.detail_snapshot")
          return;
        const pages = [...current.payload.messages];
        while (current.payload.nextSequence !== null) {
          const page = await client.queryThread(
            threadQueryMessage(configuration, "thread.detail", {
              threadId: selectedThreadId,
              afterSequence: current.payload.nextSequence,
              limit: 1000,
            }),
          );
          if (sequence !== refreshSequence.current || page.type !== "thread.detail_snapshot")
            return;
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
        void loadPayloads([
          ...(current.payload.thread.titleRef ? [current.payload.thread.titleRef] : []),
          ...current.payload.messages.map(({ contentRef }) => contentRef),
        ]);
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
                  controller.signal,
                );
                if (
                  sequence !== refreshSequence.current ||
                  page.type !== "thread.execution_snapshot"
                )
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
        if (configuration.executionStateAvailable) {
          const states = await Promise.all(
            current.payload.runs.map(async (run) => {
              const result = await client.queryThread(
                threadQueryMessage(configuration, "thread.execution_state", {
                  threadId: selectedThreadId,
                  runId: run.runId,
                }),
                controller.signal,
              );
              if (
                result.type !== "thread.execution_state_snapshot" ||
                result.payload.threadId !== selectedThreadId ||
                result.payload.runId !== run.runId
              )
                throw new Error("EXECUTION_STATE_SCOPE_MISMATCH");
              if (result.payload.state.runRevision < run.revision)
                throw new Error("EXECUTION_STATE_REVISION_MISMATCH");
              if (result.payload.state.runRevision > run.revision) return null;
              return [run.runId, result.payload.state] as const;
            }),
          );
          if (sequence !== refreshSequence.current) return;
          if (states.some((state) => state === null)) {
            refreshAgain.current = true;
            return;
          }
          setExecutionStates(Object.fromEntries(states.filter((state) => state !== null)));
        }
      } catch (caught) {
        if (controller.signal.aborted || sequence !== refreshSequence.current) return;
        const status =
          caught && typeof caught === "object" && "status" in caught
            ? (caught as { readonly status?: unknown }).status
            : null;
        if (status === 401) onUnauthorized();
        setReadFailed(true);
      } finally {
        if (readController.current === controller) {
          readController.current = null;
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
      }
    },
    [
      active,
      client,
      configuration,
      loadEnvironment,
      loadPayloads,
      onUnauthorized,
      route.afterCursor,
      route.status,
      selectedThreadId,
    ],
  );

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

  useEffect(() => {
    if (
      !active ||
      !selectedThreadId ||
      !configuration?.executionStateAvailable ||
      connection !== "connected" ||
      !detail?.payload.runs.length
    )
      return;
    // Journal changes and expired observation windows need not create a Thread
    // event. Re-read authoritative state while this conversation is visible;
    // transport heartbeats and local elapsed time never manufacture progress.
    let stopped = false;
    let timer: number;
    const check = async () => {
      if (document.visibilityState === "visible") await refreshLatest.current();
      if (!stopped)
        timer = window.setTimeout(() => {
          void check();
        }, 2000);
    };
    timer = window.setTimeout(() => {
      void check();
    }, 2000);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [
    active,
    selectedThreadId,
    configuration?.executionStateAvailable,
    connection,
    detail?.payload.runs.length,
  ]);

  const programCount = environment?.programs.length ?? 0;
  useEffect(() => {
    if (!active || connection !== "connected" || !programCount) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadEnvironment();
    }, 15000);
    return () => window.clearInterval(timer);
  }, [active, connection, programCount, loadEnvironment]);

  const settleMutation = useCallback(
    async (
      identity: PendingThreadMutation,
      result: ThreadGatewayRequestResult,
      intent: ThreadIntent | null,
      origin: string | null,
    ) => {
      storage.clearPendingThreadMutation(identity.operationKey);
      if (origin !== selectedIdRef.current) {
        void refreshLatest.current();
        return;
      }
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
      void refreshLatest.current();
    },
    [storage],
  );

  const performIntent = useCallback(
    async (intent: ThreadIntent, expectedRevision?: number, target?: ThreadSummary) => {
      if (
        !client ||
        !configuration ||
        (!target && (!detail || detail.payload.thread.threadId !== selectedIdRef.current)) ||
        connection === "offline"
      )
        return;
      const origin = selectedIdRef.current;
      const thread = target ?? detail?.payload.thread;
      if (!thread) return;
      const pendingSubmission =
        intent.kind === "submit" ? storage.readPendingThreadSubmission(thread.threadId) : null;
      if (pendingSubmission)
        intent = {
          kind: "submit",
          content: pendingSubmission.content,
          ...(pendingSubmission.selection ? { selection: pendingSubmission.selection } : {}),
        };
      const revision = pendingSubmission?.revision ?? expectedRevision ?? thread.revision;
      if (intent.kind === "submit" && !pendingSubmission)
        storage.savePendingThreadSubmission({
          threadId: thread.threadId,
          revision,
          content: intent.content,
          ...(intent.selection ? { selection: intent.selection } : {}),
        });
      const commandType =
        intent.kind === "submit"
          ? intent.selection
            ? "thread.message.submit_configured"
            : "thread.message.submit"
          : intent.kind === "stop"
            ? "thread.run.cancel"
            : `thread.${intent.kind}`;
      const identity = mutationIdentity(storage, {
        operationKey: operationKey(
          intent.kind,
          thread.threadId,
          intent.kind === "stop" ? intent.runId : intent.kind === "submit" ? "pending" : revision,
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
          | "thread.fork";
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
                detail?.payload.runs.find((run) => run.runId === intent.runId)?.revision ??
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
            type = `thread.${intent.kind}`;
            payload = {
              threadId: thread.threadId,
              expectedRevision: revision,
              reasonCode: "owner_requested",
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
              policyRefs: [],
              resultRef,
            };
            break;
        }
        const result = await client.mutateThread(
          threadCommandMessage(configuration, type, payload, identity.idempotencyKey),
        );
        if (intent.kind === "submit" && result.kind === "result") {
          if (storage.readDraft(thread.threadId) === intent.content) {
            storage.saveDraft(thread.threadId, "");
            if (selectedIdRef.current === thread.threadId) setDraft("");
          }
        }
        if (intent.kind === "fork" && result.kind === "result") {
          navigate({ ...route, objectId: result.payload.threadId, view: "content" });
        }
        if (intent.kind === "submit") storage.clearPendingThreadSubmission(thread.threadId);
        await settleMutation(identity, result, intent, origin);
        return result;
      } catch (caught) {
        if (origin !== selectedIdRef.current) return;
        setMutationStatus("rejected");
        setError(caught instanceof Error ? caught.message : "CONTROL_CENTER_REQUEST_REJECTED");
      }
    },
    [client, configuration, connection, detail, navigate, route, settleMutation, storage],
  );

  const createThread = () => {
    refreshSequence.current++;
    readController.current?.abort();
    navigate({ ...route, objectId: null, status: null, afterCursor: null, view: "content" });
    setDetail(undefined);
    setDraft(storage.readDraft("new"));
    setError(null);
    requestAnimationFrame(() =>
      document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus(),
    );
  };

  const submitDraft = async () => {
    if (
      submissionLock.current ||
      !client ||
      !configuration ||
      (!draft.trim() &&
        !storage.readPendingThreadSubmission(
          selectedIdRef.current ??
            storage.readPendingThreadMutation("new-draft-create")?.threadId ??
            "new",
        ))
    )
      return;
    submissionLock.current = true;
    const origin = selectedIdRef.current;
    const pendingNew = !origin ? storage.readPendingThreadMutation("new-draft-create") : null;
    const pendingSubmission = storage.readPendingThreadSubmission(
      origin ?? pendingNew?.threadId ?? "new",
    );
    const content = pendingSubmission?.content ?? draft;
    const selection =
      pendingSubmission?.selection ??
      (selectedModel
        ? { modelRef: selectedModel.ref, thinkingLevel: selectedThinking }
        : undefined);
    setMutationStatus("pending");
    try {
      let target = detail?.payload.thread;
      if (!origin) {
        const existing = storage.readPendingThreadMutation("new-draft-create");
        const identity = mutationIdentity(storage, {
          operationKey: "new-draft-create",
          commandType: "thread.create",
          threadId: existing?.threadId ?? `thread:${crypto.randomUUID()}`,
        });
        const resultRef = await client.protectText(
          "thread-action:create",
          "private",
          `payload-create:${identity.threadId.slice(-36)}`,
        );
        const result = await client.mutateThread(
          threadCommandMessage(
            configuration,
            "thread.create",
            { threadId: identity.threadId, answerLocale: "zh-CN", resultRef },
            identity.idempotencyKey,
          ),
        );
        if (result.kind !== "result") throw new Error("CONTROL_CENTER_REQUEST_REJECTED");
        const snapshot = await client.queryThread(
          threadQueryMessage(configuration, "thread.detail", {
            threadId: result.payload.threadId,
            afterSequence: 0,
            limit: 1,
          }),
        );
        if (snapshot.type !== "thread.detail_snapshot")
          throw new Error("CONTROL_CENTER_RESPONSE_INVALID");
        target = snapshot.payload.thread;
      }
      if (!target) return;
      const result = await performIntent(
        { kind: "submit", content, ...(selection ? { selection } : {}) },
        undefined,
        target,
      );
      if (result?.kind === "result" && !origin) {
        storage.clearPendingThreadMutation("new-draft-create");
        if (storage.readDraft("new") === content) storage.saveDraft("new", "");
        if (selectedIdRef.current === origin) {
          const remaining = storage.readDraft("new");
          if (remaining) {
            storage.saveDraft(target.threadId, remaining);
            storage.saveDraft("new", "");
          }
          navigate({ ...route, objectId: target.threadId, view: "content" });
        }
      }
    } catch (caught) {
      if (origin !== selectedIdRef.current) return;
      setMutationStatus("rejected");
      setError(caught instanceof Error ? caught.message : "CONTROL_CENTER_REQUEST_REJECTED");
    } finally {
      submissionLock.current = false;
    }
  };

  const search = async () => {
    if (!client || !configuration || !searchText.trim()) return;
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    const sequence = ++searchSequence.current;
    setSearchLoading(true);
    setSearchFailed(false);
    try {
      const prepared = await client.prepareThreadSearch(searchText);
      if (controller.signal.aborted || sequence !== searchSequence.current) return;
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
        controller.signal,
      );
      if (controller.signal.aborted || sequence !== searchSequence.current) return;
      if (result.type !== "thread.search_snapshot") {
        throw new Error("CONTROL_CENTER_RESPONSE_INVALID");
      }
      setSearchResults(result);
      void loadPayloads(
        result.payload.threads.flatMap((thread) => (thread.titleRef ? [thread.titleRef] : [])),
      );
    } catch (caught) {
      if (controller.signal.aborted || sequence !== searchSequence.current) return;
      if (caught && typeof caught === "object" && "status" in caught && caught.status === 401)
        onUnauthorized();
      setSearchFailed(true);
    } finally {
      if (searchController.current === controller) {
        searchController.current = null;
        setSearchLoading(false);
      }
    }
  };

  const currentExecutionStates = Object.fromEntries(
    (detail?.payload.runs ?? []).flatMap((run) => {
      const state = executionStates[run.runId];
      return state?.runRevision === run.revision ? [[run.runId, state]] : [];
    }),
  );
  const canStop = (run: { runId: string; status: string }) =>
    configuration?.executionStateAvailable
      ? currentExecutionStates[run.runId]?.availableActions.includes("stop") === true
      : !["completed", "failed", "cancelled"].includes(run.status);
  const projectedPendingThreadIds =
    detail &&
    configuration?.executionStateAvailable &&
    detail.payload.runs.every((run) => currentExecutionStates[run.runId])
      ? [
          ...pendingThreadIds.filter((id) => id !== detail.payload.thread.threadId),
          ...(Object.values(currentExecutionStates).some((state) => state.needsAttention)
            ? [detail.payload.thread.threadId]
            : []),
        ]
      : pendingThreadIds;

  const threadItems = collection?.payload.threads ?? [];
  const selectedSummary =
    detail?.payload.thread ?? threadItems.find(({ threadId }) => threadId === selectedThreadId);

  const feedbackInConversation =
    selectedThreadId !== null && (readScope === "conversation" || !detail);

  const list = (
    <ThreadSidebar
      threads={threadItems}
      onLoadMore={
        collection?.payload.nextCursor
          ? () => {
              if (!loading) {
                listPages.current++;
                void refresh(true);
              }
            }
          : undefined
      }
      searchResults={searchResults?.payload.threads ?? []}
      pendingThreadIds={projectedPendingThreadIds}
      runningThreadIds={(environment?.programs ?? []).flatMap((program) =>
        program.threadId ? [program.threadId] : [],
      )}
      contentByRef={contentByRef}
      loading={loading}
      hasLoaded={collection !== undefined}
      feedback={
        readScope !== "conversation" && !feedbackInConversation ? (
          <ThreadLoadFeedback
            pending={loading}
            failed={readFailed}
            scope={readScope}
            attempt={readAttempt}
            onRetry={() => void (readScope === "search" ? search() : refresh(true))}
          />
        ) : null
      }
      searchFeedback={
        <ThreadLoadFeedback
          pending={searchLoading}
          failed={searchFailed}
          scope="search"
          attempt={searchSequence.current}
          onRetry={() => void search()}
        />
      }
      searchText={searchText}
      route={route}
      selectedThreadId={selectedThreadId}
      onSearchTextChange={setSearchText}
      onSearch={() => void search()}
      onCreate={() => void createThread()}
      onRefresh={() => void refresh(true)}
      onRename={(thread) => {
        setRenameTarget(thread);
        setRenameTitle(thread.titleRef ? (contentByRef[thread.titleRef] ?? "") : "");
      }}
      onPin={(thread) =>
        void performIntent(
          { kind: "pin", pinOrder: thread.pinOrder === null ? 0 : null },
          undefined,
          thread,
        )
      }
      onArchive={(thread) => {
        if (projectedPendingThreadIds.includes(thread.threadId)) {
          setError(message("review.archivePending"));
          return;
        }
        void performIntent(
          { kind: thread.status === "archived" ? "restore" : "archive" },
          undefined,
          thread,
        );
      }}
      onNavigate={navigate}
    />
  );

  const feedback = (
    <>
      <StatusRegion className="sr-only">
        {message("mutation.label")}: {message(mutationMessageId(mutationStatus))}
      </StatusRegion>
      {error ? (
        <Banner title={message("error.currentUnavailable")} tone="danger">
          <code>{error}</code>
        </Banner>
      ) : null}
      {showOffline ? (
        <Banner title={message("state.offline")} tone="warning">
          <p>{message("review.disconnected")}</p>
          {detail?.payload.runs.some(
            (run) => !["completed", "failed", "cancelled"].includes(run.status),
          ) ? (
            <p>{message("review.progressUnknown")}</p>
          ) : null}
        </Banner>
      ) : null}
      {feedbackInConversation ? (
        <ThreadLoadFeedback
          pending={loading}
          failed={readFailed}
          scope="conversation"
          attempt={readAttempt}
          onRetry={() => void refresh(true)}
        />
      ) : null}
      {conflict ? (
        <Banner title={message("threads.conflictTitle")} tone="warning">
          <p>{message("threads.conflictDescription")}</p>
          <p>{message("threads.conflictDescription")}</p>
          <ActionButton
            disabled={!conflict.latest || connection === "offline"}
            onClick={() =>
              void performIntent(
                conflict.intent,
                conflict.latest?.revision ?? undefined,
                conflict.latest ?? undefined,
              )
            }
          >
            {message("threads.reapply")}
          </ActionButton>
        </Banner>
      ) : null}
    </>
  );

  const pendingCreation = !selectedThreadId
    ? storage.readPendingThreadMutation("new-draft-create")
    : null;
  const unresolvedSubmission = storage.readPendingThreadSubmission(
    selectedThreadId ?? pendingCreation?.threadId ?? "new",
  );

  const content = (
    <div className="thread-workarea">
      <div className="thread-content">
        {feedback}
        {!detail && selectedThreadId ? (
          <ThreadLoadingSkeleton scope="conversation" />
        ) : !detail ? (
          <div className="thread-welcome">
            <h2>{message("chat.welcome")}</h2>
            <p>{message("chat.welcomeHint")}</p>
          </div>
        ) : (
          <>
            <ChatHistory
              key={detail.payload.thread.threadId}
              detail={detail}
              contentByRef={contentByRef}
              execution={execution}
              executionStates={currentExecutionStates}
              executionStateAvailable={configuration?.executionStateAvailable}
              onPreview={setPreview}
              connection={connection}
              renderApproval={(runId, records) =>
                client && configuration ? (
                  <RunApprovalCard
                    onPreview={setPreview}
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
              onCleanup={
                configuration?.canCancelRun
                  ? (run) =>
                      void performIntent({ kind: "stop", runId: run.runId, revision: run.revision })
                  : undefined
              }
              onFork={(turnId, sequence) =>
                void performIntent({
                  kind: "fork",
                  sourceTurnId: turnId,
                  sourceWatermark: sequence,
                })
              }
            />
          </>
        )}
        <ChatComposer
          key={`composer:${selectedThreadId ?? "new"}`}
          draft={draft}
          onDraft={(value) => {
            setDraft(value);
            storage.saveDraft(selectedThreadId ?? "new", value);
          }}
          onSubmit={() => void submitDraft()}
          retryPending={Boolean(unresolvedSubmission)}
          connected={Boolean(client && configuration) && connection !== "offline"}
          pending={mutationStatus === "pending"}
          model={configuration?.primaryModel?.model}
          models={availableModels}
          modelRef={selectedModel?.ref ?? ""}
          thinkingLevel={selectedThinking}
          onModelChange={setModelRef}
          onThinkingChange={setThinkingLevel}
          onStop={
            configuration?.canCancelRun && (detail?.payload.runs ?? []).some((run) => canStop(run))
              ? () => {
                  const run = (detail?.payload.runs ?? []).find((item) => canStop(item));
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
          environment={
            configuration?.executionEnvironmentAvailable ? (
              <ExecutionEnvironmentLine
                environment={environment}
                failed={environmentFailed}
                threadTitle={(threadId) => {
                  const thread = [...threadItems, ...(searchResults?.payload.threads ?? [])].find(
                    (item) => item.threadId === threadId,
                  );
                  if (!thread) return undefined;
                  return (
                    (thread.titleRef && contentByRef[thread.titleRef]) || message("chat.untitled")
                  );
                }}
                onOpen={() => void loadEnvironment()}
                onOpenThread={(threadId) =>
                  navigate({ ...route, objectId: threadId, status: null, view: "content" })
                }
                message={message}
              />
            ) : null
          }
          canSend={
            Boolean(unresolvedSubmission) ||
            ((!detail || detail.payload.thread.status === "active") &&
              !(detail?.payload.runs ?? []).some(
                (run) => !["completed", "failed", "cancelled"].includes(run.status),
              ))
          }
        />
        {!client || !configuration ? (
          <output className="composer-readiness">{message("review.preparing")}</output>
        ) : null}
      </div>
      {preview ? <ContentPreview value={preview} onClose={() => setPreview(null)} /> : null}
    </div>
  );

  const details = (
    <ModalDialog
      open={renameTarget !== null}
      title={message("threads.rename")}
      closeLabel={message("common.close")}
      onClose={() => setRenameTarget(null)}
    >
      <Field label={message("review.conversationName")}>
        <input value={renameTitle} onChange={(event) => setRenameTitle(event.target.value)} />
      </Field>
      <ActionButton
        disabled={!renameTitle.trim()}
        onClick={async () => {
          if (!renameTarget) return;
          const result = await performIntent(
            { kind: "rename", title: renameTitle },
            undefined,
            renameTarget,
          );
          if (result) setRenameTarget(null);
        }}
      >
        {message("review.save")}
      </ActionButton>
    </ModalDialog>
  );

  return Object.freeze({
    content,
    settingsData: (
      <ArchivedConversations
        client={client}
        configuration={configuration}
        onRestore={async (thread) => {
          const result = await performIntent({ kind: "restore" }, undefined, thread);
          if (result?.kind !== "result") throw new Error("RESTORE_FAILED");
        }}
        onOpen={(thread) =>
          navigate({ ...route, objectId: thread.threadId, status: null, view: "content" })
        }
      />
    ),
    details,
    list,
    refresh,
    title: selectedSummary?.titleRef
      ? (contentByRef[selectedSummary.titleRef] ?? message("chat.untitled"))
      : message("chat.untitled"),
  });
}
