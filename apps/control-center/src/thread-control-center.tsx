import type {
  ThreadExecutionEnvironment,
  ThreadExecutionRecord,
  ThreadExecutionState,
  ThreadGatewayRequestResult,
  ThreadGatewaySnapshot,
} from "@himawari-agent/gateway-contracts";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ControlCenterRouteState } from "./app/router.js";
import {
  type BackgroundCommandView,
  backgroundCommands,
  backgroundPayloadRefs,
  runningBackgroundCommands,
  turnTitles,
} from "./background-commands.js";
import type { ControlCenterBrowserStorage, PendingThreadMutation } from "./browser-storage.js";
import { ArchivedConversations } from "./components/archived-conversations.js";
import { SunflowerMark } from "./components/brand.js";
import { ChatComposer } from "./components/chat-composer.js";
import {
  ChatHistory,
  type InheritedConversation,
  type LiveAnswerText,
} from "./components/chat-history.js";
import {
  ContentPreview,
  type ContentPreviewValue,
  type FilePreviewAccess,
  previewOfDelivered,
} from "./components/content-preview.js";
import { ExecutionEnvironmentLine } from "./components/execution-environment.js";
import { FilesLibrary } from "./components/files-library.js";
import { ActionButton, Banner, StatusRegion } from "./components/index.js";
import { OPEN_MEMORY_PAGE } from "./components/memory-panel.js";
import { defaultThinkingLevel } from "./components/model-picker.js";
import { MoreButton, MorePanel, type MoreTab } from "./components/more-panel.js";
import { RunApprovalCard } from "./components/run-approval-card.js";
import { ThreadLoadFeedback, ThreadLoadingSkeleton } from "./components/thread-load-feedback.js";
import { ThreadSidebar } from "./components/thread-sidebar.js";
import { type DeliveredFile, deliveredFileGroups } from "./delivered-files.js";
import { isAnsweredRun, isTerminalRun, type RunSummary } from "./execution-view.js";
import type {
  ControlCenterRuntimeConfiguration,
  GatewayClient,
  MutationStatus,
} from "./gateway-client.js";
import type { MessageId } from "./i18n/message-ids.js";
import { threadCommandMessage, threadQueryMessage } from "./messages.js";
import { OPEN_REMINDERS_PAGE } from "./proactive.js";

import type { RegisteredFile } from "./registered-files.js";
import { listPendingRunApprovals } from "./run-approval.js";
import { ThreadExecutionSynchronizer } from "./thread-execution-synchronizer.js";

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
  | { readonly kind: "trash" };

interface InheritedMessages {
  readonly forkThreadId: string;
  readonly sourceThreadId: string;
  readonly titleRef: string | null;
  readonly messages: ThreadDetailSnapshot["payload"]["messages"];
  readonly available: boolean;
}

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
  readonly navigate: (route: ControlCenterRouteState, replace?: boolean) => void;
  readonly refreshSignal: number;
  readonly threadEventSignal?: number;
  readonly threadEvents?: { readonly current: (string | null)[] };
  readonly route: ControlCenterRouteState;
  readonly storage: ControlCenterBrowserStorage;
  readonly onUnauthorized: () => void;
  readonly renderMemory?: (ownerRefs: readonly string[]) => ReactNode;
  readonly renderToolCard?: (name: string, output: string) => ReactNode;
  readonly renderPage?: (page: SidePage) => ReactNode;
  readonly remindersDue?: number;
  readonly ownerName?: string | undefined;
  readonly modelChoice?: ModelChoice | undefined;
  readonly onModelChoiceChange?: (choice: ModelChoice) => void;
}

export interface ModelChoice {
  readonly modelRef: string;
  readonly thinkingLevel: string;
}

export type SidePage = "memory" | "reminders";
type WorkPage = SidePage | "files" | null;

export interface ThreadControlCenterModel {
  readonly title: string;
  readonly content: ReactNode;
  readonly details: ReactNode;
  readonly actions: ReactNode;
  readonly start: ReactNode;
  readonly settingsData: ReactNode;
  readonly threadTitle: (threadId: string) => string | undefined;
  readonly list: ReactNode;
  readonly refresh: () => Promise<void>;
}

export function greetingOf(now: Date): MessageId {
  const hour = now.getHours();
  return hour >= 5 && hour < 12
    ? "chat.greetMorning"
    : hour >= 12 && hour < 18
      ? "chat.greetAfternoon"
      : "chat.greetEvening";
}
const payloadConcurrency = 6;
const payloadFlushMilliseconds = 40;

const welcomeLines: readonly MessageId[] = [
  "chat.welcome.here",
  "chat.welcome.hand",
  "chat.welcome.remember",
  "chat.welcome.stuck",
];
export function welcomeLinesOf(now: Date): readonly MessageId[] {
  const hour = now.getHours();
  return hour >= 5 && hour < 11
    ? [...welcomeLines, "chat.welcome.morning"]
    : hour >= 22 || hour < 5
      ? [...welcomeLines, "chat.welcome.late"]
      : welcomeLines;
}
function ThreadWelcome({
  name,
  message,
}: {
  readonly name: string | undefined;
  readonly message: (id: MessageId, values?: Record<string, string>) => string;
}) {
  const [now] = useState(() => new Date());
  const [line] = useState(() => {
    const lines = welcomeLinesOf(now);
    return lines[Math.floor(Math.random() * lines.length)] as MessageId;
  });
  const greeting = message(greetingOf(now));
  return (
    <div className="thread-welcome">
      <span className="welcome-mark">
        <SunflowerMark growing />
      </span>
      <h2>{name ? message("chat.greetNamed", { greeting, name }) : greeting}</h2>
      <p>{message(line)}</p>
    </div>
  );
}
function mutationMessageId(status: MutationStatus | null): MessageId {
  return status ? (`mutation.${status}` as MessageId) : "mutation.none";
}

function operationKey(kind: string, threadId: string, revision: number | string): string {
  return `op:${kind}:${revision}:${threadId.slice(-32)}`.slice(0, 128);
}

interface OutgoingSubmission {
  readonly origin: string | null;
  readonly threadId: string | null;
  readonly messageId: string | null;
  readonly content: string;
  readonly at: string;
  readonly failed: boolean;
}

function submittedMessageId(idempotencyKey: string): string {
  return `message:${idempotencyKey.split(":").at(-1) ?? ""}`;
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
    navigate: navigateRoute,
    onUnauthorized,
    refreshSignal,
    threadEventSignal = 0,
    threadEvents,
    route,
    storage,
    renderPage,
    remindersDue = 0,
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
  const navigate = useCallback(
    (state: ControlCenterRouteState) => navigateRoute({ ...state, page: null, pageTab: null }),
    [navigateRoute],
  );
  const page: WorkPage = route.page === "settings" ? null : route.page;
  const routeRef = useRef(route);
  routeRef.current = route;
  const setPage = useCallback(
    (next: WorkPage) =>
      navigateRoute({ ...routeRef.current, page: next, pageTab: null, view: "content" }),
    [navigateRoute],
  );
  const library = page === "files";
  useEffect(() => {
    const open = () => setPage("memory");
    const openReminders = () => setPage("reminders");
    window.addEventListener(OPEN_MEMORY_PAGE, open);
    window.addEventListener(OPEN_REMINDERS_PAGE, openReminders);
    return () => {
      window.removeEventListener(OPEN_MEMORY_PAGE, open);
      window.removeEventListener(OPEN_REMINDERS_PAGE, openReminders);
    };
  }, [setPage]);
  const [registered, setRegistered] = useState<readonly RegisteredFile[]>();
  const pendingTurn = useRef<string | null>(null);
  const [more, setMore] = useState<{
    readonly open: boolean;
    readonly tab: MoreTab;
    readonly command: string | null;
  }>({ open: false, tab: "files", command: null });
  const [stoppingRunIds, setStoppingRunIds] = useState<readonly string[]>([]);
  const [pendingThreadIds, setPendingThreadIds] = useState<readonly string[]>([]);
  const [environment, setEnvironment] = useState<ThreadExecutionEnvironment>();
  const listPages = useRef(1);
  const [collection, setCollection] = useState<ThreadCollectionSnapshot>();
  const [searchResults, setSearchResults] = useState<ThreadCollectionSnapshot>();
  const [detail, setDetail] = useState<ThreadDetailSnapshot>();
  const [inherited, setInherited] = useState<InheritedMessages>();
  const inheritedCache = useRef<Record<string, InheritedMessages>>({});
  const [contentByRef, setContentByRef] = useState<Readonly<Record<string, string>>>({});
  const [draft, setDraft] = useState("");
  const [outgoing, setOutgoing] = useState<OutgoingSubmission | null>(null);
  const [execution, setExecution] = useState<
    Readonly<Record<string, readonly ThreadExecutionRecord[]>>
  >({});
  const [executionStates, setExecutionStates] = useState<
    Readonly<Record<string, ThreadExecutionState>>
  >({});
  const [liveTexts, setLiveTexts] = useState<Readonly<Record<string, LiveAnswerText>>>({});
  const liveBuffer = useRef<Record<string, LiveAnswerText>>({});
  const liveFrame = useRef<number | undefined>(undefined);
  const executionEpoch = useRef(0);
  const modelRef = options.modelChoice?.modelRef ?? "";
  const thinkingLevel = options.modelChoice?.thinkingLevel ?? "";
  const availableModels = configuration?.availableModels ?? [];
  const selectedModel =
    availableModels.find((item) => item.ref === modelRef) ??
    availableModels.find((item) => item.ref === configuration?.primaryModelRef) ??
    availableModels[0];
  const selectedThinking = selectedModel?.thinkingLevels.includes(thinkingLevel)
    ? thinkingLevel
    : defaultThinkingLevel(selectedModel?.thinkingLevels ?? []);
  const payloadEpoch = useRef(0);
  const payloadCache = useRef<Record<string, string>>({});
  const executionCache = useRef<Record<string, ThreadExecutionRecord[]>>({});
  const [renameTitle, setRenameTitle] = useState("");
  const [renameInitial, setRenameInitial] = useState("");
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
  const [readInBackground, setReadInBackground] = useState(false);
  const readFailures = useRef(0);
  const readController = useRef<AbortController | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mutationStatus, setMutationStatus] = useState<MutationStatus | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const refreshSequence = useRef(0);
  const refreshing = useRef(false);
  const refreshAgain = useRef(false);
  const refreshLatest = useRef<(force?: boolean, full?: boolean) => Promise<void>>(async () => {});
  const fullRefreshRequested = useRef(true);
  const eventThreadIds = useRef(new Set<string | null>());
  const detailRef = useRef<ThreadDetailSnapshot | undefined>(undefined);
  const refreshTimer = useRef<number | undefined>(undefined);
  const selectedThreadId = route.objectId ?? null;
  const [mainThreadId, setMainThreadId] = useState<string | null>(null);
  const [mainLookupSettled, setMainLookupSettled] = useState(false);
  useEffect(() => {
    if (!active || !client || !configuration) return;
    setMainLookupSettled(false);
    const controller = new AbortController();
    let disposed = false;
    const deadline = window.setTimeout(
      () => controller.abort(READ_DEADLINE_EXCEEDED),
      READ_DEADLINE_MILLISECONDS,
    );
    client
      .queryThread(threadQueryMessage(configuration, "thread.main", {}), controller.signal)
      .then((snapshot) => {
        if (!disposed && snapshot.type === "thread.main_snapshot")
          setMainThreadId(snapshot.payload.thread.threadId);
      })
      .catch((caught: unknown) => {
        if ((caught as { readonly status?: unknown } | null)?.status === 401) onUnauthorized();
      })
      .finally(() => {
        window.clearTimeout(deadline);
        if (!disposed) setMainLookupSettled(true);
      });
    return () => {
      disposed = true;
      window.clearTimeout(deadline);
      controller.abort();
    };
  }, [active, client, configuration, onUnauthorized]);
  const openingMain =
    !selectedThreadId &&
    !page &&
    !route.status &&
    Boolean(client && configuration) &&
    (!mainLookupSettled || mainThreadId !== null);
  useEffect(() => {
    if (!mainThreadId || selectedThreadId || route.page || route.status) return;
    navigate({
      ...route,
      objectId: mainThreadId,
      status: null,
      afterCursor: null,
      view: "content",
    });
  }, [mainThreadId, selectedThreadId, route, navigate]);
  const selectedIdRef = useRef(selectedThreadId);
  selectedIdRef.current = selectedThreadId;
  const shownThreadId = useRef<string | null>(null);
  const shownDetailThreadId = detail?.payload.thread.threadId ?? null;
  shownThreadId.current = shownDetailThreadId;
  detailRef.current = detail;
  useEffect(() => {
    refreshSequence.current++;
    executionEpoch.current++;
    liveBuffer.current = {};
    setLiveTexts({});
    setDetail(undefined);
    setPreview(null);
    setRegistered(undefined);
    setMore((current) => ({ ...current, open: false, command: null }));
    setStoppingRunIds([]);
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
      executionEpoch.current++;
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
    readFailures.current = 0;
    setReadFailed(false);
    setReadInBackground(false);
    return () => {
      readController.current?.abort();
      readController.current = null;
      refreshing.current = false;
      refreshAgain.current = false;
      refreshSequence.current++;
      executionEpoch.current++;
    };
  }, [client, selectedThreadId, route.status, route.afterCursor, active]);

  const loadPayloads = useCallback(
    async (refs: readonly string[]) => {
      if (!client) return;
      const pending = [...new Set(refs)].filter((ref) => payloadCache.current[ref] === undefined);
      const epoch = payloadEpoch.current;
      let flushTimer: ReturnType<typeof setTimeout> | undefined;
      const flush = () => {
        flushTimer = undefined;
        if (epoch === payloadEpoch.current) setContentByRef({ ...payloadCache.current });
      };
      const worker = async () => {
        for (let ref = pending.shift(); ref !== undefined; ref = pending.shift()) {
          let content: string;
          try {
            content = (await client.readText(ref)).content;
          } catch {
            content = message("common.unknown");
          }
          if (epoch !== payloadEpoch.current) return;
          payloadCache.current[ref] = content;
          flushTimer ??= setTimeout(flush, payloadFlushMilliseconds);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(payloadConcurrency, pending.length) }, worker),
      );
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer);
        flush();
      }
    },
    [client, message],
  );

  const loadInherited = useCallback(
    async (thread: ThreadSummary) => {
      const { threadId, sourceThreadId, sourceWatermark } = thread;
      if (!client || !configuration || !sourceThreadId || sourceWatermark === null) return;
      const cached = inheritedCache.current[threadId];
      if (cached) {
        setInherited(cached);
        return;
      }
      let value: InheritedMessages;
      try {
        const messages: ThreadDetailSnapshot["payload"]["messages"][number][] = [];
        let titleRef: string | null = null;
        let afterSequence = 0;
        for (;;) {
          const page = await client.queryThread(
            threadQueryMessage(configuration, "thread.detail", {
              threadId: sourceThreadId,
              afterSequence,
              limit: 1000,
            }),
          );
          if (page.type !== "thread.detail_snapshot") throw new Error("THREAD_SOURCE_UNAVAILABLE");
          titleRef = page.payload.thread.titleRef;
          messages.push(
            ...page.payload.messages.filter((item) => item.sequence <= sourceWatermark),
          );
          const next = page.payload.nextSequence;
          if (next === null || next >= sourceWatermark || next <= afterSequence) break;
          afterSequence = next;
        }
        value = { forkThreadId: threadId, sourceThreadId, titleRef, messages, available: true };
        void loadPayloads([
          ...(titleRef ? [titleRef] : []),
          ...messages.map(({ contentRef }) => contentRef),
        ]);
      } catch {
        value = {
          forkThreadId: threadId,
          sourceThreadId,
          titleRef: null,
          messages: [],
          available: false,
        };
      }
      inheritedCache.current[threadId] = value;
      if (selectedIdRef.current === threadId) setInherited(value);
    },
    [client, configuration, loadPayloads],
  );

  const readImage = useMemo(
    () => (client ? (ref: string) => client.readImage(ref) : undefined),
    [client],
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
    } catch {}
  }, [client, configuration]);

  const scheduleRefresh = useCallback((threadId?: string | null, delay = 80) => {
    if (threadId !== undefined) eventThreadIds.current.add(threadId);
    refreshTimer.current ??= window.setTimeout(() => {
      refreshTimer.current = undefined;
      void refreshLatest.current(false, false);
    }, delay);
  }, []);

  const refresh = useCallback(
    async (force = false, full = true) => {
      if (!active || !client || !configuration) return;
      if (full) fullRefreshRequested.current = true;
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
      const deadline = window.setTimeout(
        () => controller.abort(READ_DEADLINE_EXCEEDED),
        READ_DEADLINE_MILLISECONDS,
      );
      refreshing.current = true;
      const sequence = ++refreshSequence.current;
      const background = selectedThreadId !== null && shownThreadId.current === selectedThreadId;
      const previousDetail =
        background && !fullRefreshRequested.current ? detailRef.current : undefined;
      const eventThreads = new Set(eventThreadIds.current);
      fullRefreshRequested.current = false;
      eventThreadIds.current.clear();
      let conversationShown = background;
      let phase: "list" | "conversation" = "list";
      let retryDelay: number | null = null;
      const succeeded = () => {
        readFailures.current = 0;
        setReadFailed(false);
      };
      setLoading(true);
      setReadInBackground(background);
      if (!background) {
        setReadFailed(false);
        setReadScope("list");
      }
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
            .catch(() => undefined);
        }
        void loadPayloads(
          expandedList.payload.threads.flatMap((thread) =>
            thread.titleRef ? [thread.titleRef] : [],
          ),
        );
        if (!selectedThreadId) {
          setDetail(undefined);
          succeeded();
          return;
        }
        if (previousDetail && !eventThreads.has(selectedThreadId) && !eventThreads.has(null)) {
          succeeded();
          return;
        }
        phase = "conversation";
        if (!background) setReadScope("conversation");
        const knownMessages = previousDetail?.payload.messages ?? [];
        let current = await client.queryThread(
          threadQueryMessage(configuration, "thread.detail", {
            threadId: selectedThreadId,
            afterSequence: knownMessages.at(-1)?.sequence ?? 0,
            limit: 1000,
          }),
          controller.signal,
        );
        if (sequence !== refreshSequence.current || current.type !== "thread.detail_snapshot")
          return;
        const pages = [...knownMessages, ...current.payload.messages];
        while (current.payload.nextSequence !== null) {
          const page = await client.queryThread(
            threadQueryMessage(configuration, "thread.detail", {
              threadId: selectedThreadId,
              afterSequence: current.payload.nextSequence,
              limit: 1000,
            }),
            controller.signal,
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
        void loadInherited(current.payload.thread);
        conversationShown = true;
        setReadInBackground(true);
        void loadPayloads([
          ...(current.payload.thread.titleRef ? [current.payload.thread.titleRef] : []),
          ...current.payload.messages.map(({ contentRef }) => contentRef).reverse(),
          ...backgroundPayloadRefs(current.payload.runs),
        ]);
        const changedRuns = current.payload.runs.filter(
          (run) =>
            previousDetail?.payload.runs.find((item) => item.runId === run.runId)?.revision !==
            run.revision,
        );
        await readRunExecution(
          client,
          configuration,
          selectedThreadId,
          changedRuns,
          executionCache.current,
          () => sequence === refreshSequence.current,
          setExecution,
          setExecutionStates,
          controller.signal,
        );
        if (sequence !== refreshSequence.current) return;
        succeeded();
      } catch (caught) {
        if (
          (controller.signal.aborted && controller.signal.reason !== READ_DEADLINE_EXCEEDED) ||
          sequence !== refreshSequence.current
        )
          return;
        if ((caught as { readonly status?: unknown } | null)?.status === 401) onUnauthorized();
        fullRefreshRequested.current = true;
        readFailures.current++;
        if (!conversationShown) setReadFailed(true);
        else {
          retryDelay = Math.min(8_000, 1_000 * 2 ** (readFailures.current - 1));
          if (readFailures.current >= 3) {
            setReadScope(phase);
            setReadFailed(true);
          }
        }
      } finally {
        window.clearTimeout(deadline);
        if (readController.current === controller) {
          readController.current = null;
          refreshing.current = false;
          if (sequence === refreshSequence.current) setLoading(false);
          if (refreshAgain.current) {
            refreshAgain.current = false;
            scheduleRefresh();
          } else if (retryDelay !== null) scheduleRefresh(undefined, retryDelay);
        }
      }
    },
    [
      active,
      client,
      configuration,
      loadEnvironment,
      loadInherited,
      loadPayloads,
      onUnauthorized,
      route.afterCursor,
      route.status,
      scheduleRefresh,
      selectedThreadId,
    ],
  );

  refreshLatest.current = refresh;
  useEffect(() => {
    void refresh;
    void refreshSignal;
    fullRefreshRequested.current = true;
    scheduleRefresh();
  }, [refresh, refreshSignal, scheduleRefresh]);
  useEffect(() => {
    if (!threadEventSignal) return;
    for (const threadId of threadEvents?.current.splice(0) ?? [null]) scheduleRefresh(threadId);
  }, [threadEventSignal, threadEvents, scheduleRefresh]);
  useEffect(
    () => () => {
      if (refreshTimer.current !== undefined) window.clearTimeout(refreshTimer.current);
    },
    [],
  );

  const executionRuns = useRef(new Set<string>());
  const executionTimer = useRef<number | undefined>(undefined);
  const executionReading = useRef(false);
  const executionStateReading = useRef(false);
  const executionStateRuns = useRef(new Map<string, { runId: string; revision: number }>());
  const refreshExecutionLatest = useRef(async () => {});
  const scheduleExecution = useCallback((runIds: readonly string[]) => {
    for (const runId of runIds) executionRuns.current.add(runId);
    executionTimer.current ??= window.setTimeout(() => {
      executionTimer.current = undefined;
      void refreshExecutionLatest.current();
    }, 80);
  }, []);
  refreshExecutionLatest.current = async () => {
    const shown = detailRef.current;
    if (
      !active ||
      !client ||
      !configuration ||
      !selectedThreadId ||
      shown?.payload.thread.threadId !== selectedThreadId
    )
      return;
    if (executionReading.current) return scheduleExecution([]);
    const runs = shown.payload.runs.filter((run) => executionRuns.current.has(run.runId));
    executionRuns.current.clear();
    if (!runs.length) return;
    const epoch = executionEpoch.current;
    executionReading.current = true;
    const controller = new AbortController();
    const deadline = window.setTimeout(
      () => controller.abort(READ_DEADLINE_EXCEEDED),
      READ_DEADLINE_MILLISECONDS,
    );
    try {
      await readRunRecords(
        client,
        configuration,
        selectedThreadId,
        runs,
        executionCache.current,
        () => epoch === executionEpoch.current,
        setExecution,
        controller.signal,
      );
      if (epoch !== executionEpoch.current) return scheduleExecution(runs.map((run) => run.runId));
    } catch {
      if (epoch !== executionEpoch.current) return scheduleExecution(runs.map((run) => run.runId));
      fullRefreshRequested.current = true;
      scheduleRefresh();
      return;
    } finally {
      window.clearTimeout(deadline);
      executionReading.current = false;
    }
    for (const run of runs) executionStateRuns.current.set(run.runId, run);
    if (executionStateReading.current) return;
    executionStateReading.current = true;
    try {
      while (executionStateRuns.current.size) {
        const stateRuns = [...executionStateRuns.current.values()];
        executionStateRuns.current.clear();
        const stateController = new AbortController();
        const stateDeadline = window.setTimeout(
          () => stateController.abort(READ_DEADLINE_EXCEEDED),
          READ_DEADLINE_MILLISECONDS,
        );
        try {
          await readRunStates(
            client,
            configuration,
            selectedThreadId,
            stateRuns,
            () => epoch === executionEpoch.current,
            setExecutionStates,
            stateController.signal,
          );
        } finally {
          window.clearTimeout(stateDeadline);
        }
      }
    } catch {
      executionStateRuns.current.clear();
      if (epoch !== executionEpoch.current) return;
      fullRefreshRequested.current = true;
      scheduleRefresh();
    } finally {
      executionStateReading.current = false;
    }
  };
  useEffect(
    () => () => {
      if (executionTimer.current !== undefined) window.clearTimeout(executionTimer.current);
    },
    [],
  );

  const offline = connection === "offline";
  const executionLive =
    detail?.payload.runs.some(
      (run) => !isTerminalRun(run) || executionStates[run.runId]?.displayPhase === "unresolved",
    ) ?? false;
  useEffect(() => {
    if (
      !active ||
      !configuration?.executionEventsAvailable ||
      !selectedThreadId ||
      shownDetailThreadId !== selectedThreadId ||
      offline ||
      !executionLive
    )
      return;
    const synchronizer = new ThreadExecutionSynchronizer({
      configuration,
      threadId: selectedThreadId,
      onConnected: () =>
        scheduleExecution(detailRef.current?.payload.runs.map((run) => run.runId) ?? []),
      onChanged: (event) => {
        const run = detailRef.current?.payload.runs.find((item) => item.runId === event.runId);
        if (!run || run.revision < event.runRevision) scheduleRefresh(selectedThreadId);
        if (run) scheduleExecution([run.runId]);
      },
      onText: (event) => {
        const prior = liveBuffer.current[event.runId];
        const base = prior?.itemId === event.itemId ? prior.text : "";
        if (event.offset > base.length) {
          scheduleExecution([event.runId]);
          return;
        }
        liveBuffer.current[event.runId] = {
          itemId: event.itemId,
          text: base.slice(0, event.offset) + event.text,
        };
        liveFrame.current ??= window.requestAnimationFrame(() => {
          liveFrame.current = undefined;
          setLiveTexts({ ...liveBuffer.current });
        });
      },
      onUnauthorized,
    });
    synchronizer.start();
    return () => {
      synchronizer.stop();
      if (liveFrame.current !== undefined) window.cancelAnimationFrame(liveFrame.current);
      liveFrame.current = undefined;
    };
  }, [
    active,
    configuration,
    executionLive,
    offline,
    onUnauthorized,
    scheduleExecution,
    scheduleRefresh,
    selectedThreadId,
    shownDetailThreadId,
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
        if (intent.kind === "submit") {
          if (!configuration.sessionId) throw new Error("CONTROL_CENTER_REAUTHENTICATION_REQUIRED");
          const messageId = submittedMessageId(identity.idempotencyKey);
          setOutgoing((current) =>
            current ? { ...current, threadId: thread.threadId, messageId } : current,
          );
        }
        const contentRefRequest =
          intent.kind === "submit"
            ? client.protectText(intent.content, "private", `payload-content:${stableSuffix}`)
            : null;
        contentRefRequest?.catch(() => undefined);
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
          | "thread.trash";
        switch (intent.kind) {
          case "submit": {
            const contentRef = await contentRefRequest;
            if (!contentRef || !configuration.sessionId)
              throw new Error("CONTROL_CENTER_REAUTHENTICATION_REQUIRED");
            payloadCache.current[contentRef] = intent.content;
            setContentByRef((current) => ({ ...current, [contentRef]: intent.content }));
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
          case "trash":
            type = `thread.${intent.kind}`;
            payload = {
              threadId: thread.threadId,
              expectedRevision: revision,
              reasonCode: "owner_requested",
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
        if (intent.kind === "submit") storage.clearPendingThreadSubmission(thread.threadId);
        await settleMutation(identity, result, intent, origin);
        return result;
      } catch (caught) {
        if (origin !== selectedIdRef.current) return;
        setMutationStatus("rejected");
        setError(caught instanceof Error ? caught.message : "CONTROL_CENTER_REQUEST_REJECTED");
      }
    },
    [client, configuration, connection, detail, settleMutation, storage],
  );

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
    const draftKey = origin ?? "new";
    setOutgoing({
      origin,
      threadId: origin ?? pendingNew?.threadId ?? null,
      messageId: null,
      content,
      at: new Date().toISOString(),
      failed: false,
    });
    if (!pendingSubmission) {
      setDraft("");
      if (origin) storage.saveDraft(draftKey, "");
    }
    const settleOutgoing = (threadId: string | null) => {
      if (threadId && storage.readPendingThreadSubmission(threadId)) {
        setOutgoing((current) => (current ? { ...current, failed: true } : current));
        return;
      }
      setOutgoing(null);
      const stored = storage.readDraft(draftKey);
      if (!stored) storage.saveDraft(draftKey, content);
      if (selectedIdRef.current === origin && (!stored || stored === content)) setDraft(content);
    };
    const selection =
      pendingSubmission?.selection ??
      (selectedModel
        ? { modelRef: selectedModel.ref, thinkingLevel: selectedThinking }
        : undefined);
    try {
      let target =
        origin && detail?.payload.thread.threadId === origin ? detail.payload.thread : undefined;
      if (!origin) {
        setMutationStatus("pending");
        const controller = new AbortController();
        const deadline = window.setTimeout(
          () => controller.abort(READ_DEADLINE_EXCEEDED),
          READ_DEADLINE_MILLISECONDS,
        );
        const snapshot = await client
          .queryThread(threadQueryMessage(configuration, "thread.main", {}), controller.signal)
          .finally(() => window.clearTimeout(deadline));
        if (snapshot.type !== "thread.main_snapshot")
          throw new Error("CONTROL_CENTER_RESPONSE_INVALID");
        target = snapshot.payload.thread;
        setMainThreadId(target.threadId);
      }
      if (!target) {
        settleOutgoing(null);
        return;
      }
      const result = await performIntent(
        { kind: "submit", content, ...(selection ? { selection } : {}) },
        undefined,
        target,
      );
      if (result?.kind !== "result") settleOutgoing(target.threadId);
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
      settleOutgoing(null);
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
      if ((caught as { readonly status?: unknown } | null)?.status === 401) onUnauthorized();
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
      return state && state.runRevision >= run.revision ? [[run.runId, state]] : [];
    }),
  );
  const canStop = (run: RunSummary) =>
    configuration?.executionStateAvailable
      ? currentExecutionStates[run.runId]?.availableActions.includes("stop") === true
      : !["completed", "failed", "cancelled"].includes(run.status) && !run.background;
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
  const renameThread = (thread: ThreadSummary) => {
    setRenameTarget(thread);
    const current = thread.titleRef ? (contentByRef[thread.titleRef] ?? "") : "";
    setRenameTitle(current);
    setRenameInitial(current);
  };
  const pinThread = (thread: ThreadSummary) =>
    void performIntent(
      { kind: "pin", pinOrder: thread.pinOrder === null ? 0 : null },
      undefined,
      thread,
    );
  const archiveThread = (thread: ThreadSummary) => {
    if (projectedPendingThreadIds.includes(thread.threadId)) {
      setError(message("review.archivePending"));
      return;
    }
    void performIntent(
      { kind: thread.status === "archived" ? "restore" : "archive" },
      undefined,
      thread,
    );
  };
  const renameChanged = Boolean(renameTitle.trim()) && renameTitle.trim() !== renameInitial.trim();
  const renameSaving = useRef(false);
  const saveRename = async () => {
    const target = renameTarget;
    if (!target || !renameChanged || renameSaving.current) return;
    renameSaving.current = true;
    try {
      const result = await performIntent({ kind: "rename", title: renameTitle }, undefined, target);
      if (result)
        setRenameTarget((current) => (current?.threadId === target.threadId ? null : current));
    } finally {
      renameSaving.current = false;
    }
  };
  const [deleteTarget, setDeleteTarget] = useState<ThreadSummary | null>(null);
  const requestDelete = (thread: ThreadSummary) => {
    if (projectedPendingThreadIds.includes(thread.threadId)) {
      setError(message("review.deletePending"));
      return;
    }
    setDeleteTarget(thread);
  };
  const confirmDelete = async () => {
    const target = deleteTarget;
    if (!target) return;
    setDeleteTarget(null);
    const result = await performIntent({ kind: "trash" }, undefined, target);
    if (result?.kind === "result" && selectedIdRef.current === target.threadId)
      navigate({ ...route, objectId: null, status: null, afterCursor: null, view: "content" });
  };
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
            pending={loading && !readInBackground}
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
      mainThreadId={mainThreadId}
      onOpenFiles={configuration?.filesAvailable ? () => openLibrary() : undefined}
      onOpenMemory={renderPage ? () => openSidePage("memory") : undefined}
      onOpenReminders={renderPage ? () => openSidePage("reminders") : undefined}
      openPage={page}
      remindersDue={remindersDue}
      onRefresh={() => void refresh(true)}
      onRename={renameThread}
      onPin={pinThread}
      onArchive={archiveThread}
      onDelete={requestDelete}
      renamingThreadId={renameTarget?.threadId ?? null}
      renameValue={renameTitle}
      renameChanged={renameChanged}
      onRenameValueChange={setRenameTitle}
      onRenameCommit={() => void saveRename()}
      onRenameCancel={() => setRenameTarget(null)}
      deletingThreadId={deleteTarget?.threadId ?? null}
      onDeleteConfirm={() => void confirmDelete()}
      onDeleteCancel={() => setDeleteTarget(null)}
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
          pending={loading && !readInBackground}
          failed={readFailed}
          scope="conversation"
          attempt={readAttempt}
          onRetry={() => void refresh(true)}
        />
      ) : null}
      {conflict ? (
        <Banner title={message("threads.conflictTitle")} tone="warning">
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
  const committedMessageIds = useMemo(
    () => new Set(detail?.payload.messages.map((item) => item.messageId) ?? []),
    [detail],
  );
  useEffect(() => {
    if (outgoing?.messageId && committedMessageIds.has(outgoing.messageId)) setOutgoing(null);
  }, [committedMessageIds, outgoing]);
  const unresolvedMessageId = (() => {
    if (!unresolvedSubmission) return null;
    const identity = storage.readPendingThreadMutation(
      operationKey("submit", unresolvedSubmission.threadId, "pending"),
    );
    return identity ? submittedMessageId(identity.idempotencyKey) : null;
  })();
  const shownOutgoing =
    outgoing &&
    (outgoing.origin === selectedThreadId || outgoing.threadId === selectedThreadId) &&
    !(outgoing.messageId && committedMessageIds.has(outgoing.messageId))
      ? { key: outgoing.at, content: outgoing.content, failed: outgoing.failed }
      : unresolvedSubmission &&
          detail &&
          mutationStatus !== "pending" &&
          !(unresolvedMessageId && committedMessageIds.has(unresolvedMessageId))
        ? {
            key: unresolvedSubmission.threadId,
            content: unresolvedSubmission.content,
            failed: true,
          }
        : null;

  const titles = useMemo(
    () => (detail ? turnTitles(detail.payload.messages, contentByRef) : {}),
    [detail, contentByRef],
  );
  const commands = useMemo(
    () => (detail ? backgroundCommands(detail.payload.runs, contentByRef, titles) : []),
    [detail, contentByRef, titles],
  );
  const runningCommands = runningBackgroundCommands(commands);
  const filesThreadId = configuration?.filesAvailable ? shownDetailThreadId : null;
  const filesSignal = (detail?.payload.runs ?? [])
    .map((run) => `${run.runId}:${run.revision}:${run.status}`)
    .join(",");
  useEffect(() => {
    void filesSignal;
    if (!client || !filesThreadId) return;
    let current = true;
    void (async () => {
      const items: RegisteredFile[] = [];
      let before: string | null = null;
      do {
        const page = await client.listFiles({ threadId: filesThreadId, before, limit: 200 });
        items.push(...page.items);
        before = page.nextCursor;
      } while (before && current);
      if (current) setRegistered(items);
    })().catch(() => undefined);
    return () => {
      current = false;
    };
  }, [client, filesThreadId, filesSignal]);
  const fileGroups = useMemo(
    () =>
      deliveredFileGroups({
        runs: detail?.payload.runs ?? [],
        execution,
        registered,
        commands,
        titles,
      }),
    [detail, execution, registered, commands, titles],
  );
  const filesByRun = useMemo(
    () => Object.fromEntries(fileGroups.map((group) => [group.runId, group.files])),
    [fileGroups],
  );
  const hasMore = commands.length > 0 || fileGroups.length > 0;
  const fileAccess = useMemo<FilePreviewAccess | undefined>(
    () =>
      client
        ? {
            text: (fileId) => client.fileText(fileId),
            bytes: (fileId) => client.fileBytes(fileId),
            versions: (fileId) => client.fileVersions(fileId),
            previewUrl: configuration?.filePreviewAvailable
              ? (fileId) => client.filePreviewUrl(fileId)
              : undefined,
          }
        : undefined,
    [client, configuration?.filePreviewAvailable],
  );
  const flashTurn = useCallback((runId: string) => {
    const turn = [...document.querySelectorAll<HTMLElement>(".chat-turn[data-run-id]")].find(
      (element) => element.dataset["runId"] === runId,
    );
    if (!turn) return false;
    turn.scrollIntoView({ block: "center", behavior: "smooth" });
    turn.classList.remove("is-flash");
    turn.classList.add("is-flash");
    window.setTimeout(() => turn.classList.remove("is-flash"), 1800);
    return true;
  }, []);
  useEffect(() => {
    void detail;
    const runId = pendingTurn.current;
    if (runId && flashTurn(runId)) pendingTurn.current = null;
  }, [detail, flashTurn]);
  const threadTitle = (threadId: string) => {
    const thread = [...threadItems, ...(searchResults?.payload.threads ?? [])].find(
      (item) => item.threadId === threadId,
    );
    if (!thread) return undefined;
    return (thread.titleRef && contentByRef[thread.titleRef]) || undefined;
  };
  const openFile = (file: DeliveredFile) => {
    const title = detail ? threadTitle(detail.payload.thread.threadId) : undefined;
    setPreview((current) =>
      current?.key === file.key
        ? null
        : previewOfDelivered(file, {
            label: title
              ? message("files.from", { title, turn: file.turn })
              : message("files.fromPlain", { turn: file.turn }),
            onOpen: () => {
              if (window.matchMedia?.("(max-width: 760px)").matches) setPreview(null);
              flashTurn(file.runId);
            },
          }),
    );
  };
  const openLibraryFile = (file: DeliveredFile) => {
    const threadId = file.registered?.threadId;
    const title = threadId ? threadTitle(threadId) : undefined;
    setPreview((current) =>
      current?.key === file.key
        ? null
        : previewOfDelivered(file, {
            label: title
              ? message("files.from", { title, turn: file.turn })
              : message("files.fromPlain", { turn: file.turn }),
            onOpen: () => {
              if (!threadId) return;
              pendingTurn.current = file.runId;
              setPreview(null);
              if (threadId === selectedThreadId) {
                if (flashTurn(file.runId)) pendingTurn.current = null;
              } else navigate({ ...route, objectId: threadId, status: null, view: "content" });
            },
          }),
    );
  };
  const openSidePage = (next: SidePage) => {
    setPreview(null);
    closeMore();
    setPage(next);
  };
  const openLibrary = () => {
    setPreview(null);
    closeMore();
    setPage("files");
  };
  useEffect(() => {
    setStoppingRunIds((current) => {
      const next = current.filter((runId) =>
        commands.some((command) => command.runId === runId && command.state === "running"),
      );
      return next.length === current.length ? current : next;
    });
  }, [commands]);
  const openMore = (tab?: MoreTab, command: string | null = null) => {
    setPreview(null);
    setMore((current) => ({
      open: true,
      tab: tab ?? (runningBackgroundCommands(commands).length ? "commands" : current.tab),
      command,
    }));
  };
  const closeMore = () => setMore((current) => ({ ...current, open: false, command: null }));
  const stopCommand = (command: BackgroundCommandView) => {
    setStoppingRunIds((current) =>
      current.includes(command.runId) ? current : [...current, command.runId],
    );
    void performIntent({
      kind: "stop",
      runId: command.run.runId,
      revision: command.run.revision,
    }).then((result) => {
      if (!result)
        setStoppingRunIds((current) => current.filter((runId) => runId !== command.runId));
    });
  };
  const showReport = (command: BackgroundCommandView) => {
    if (!command.noticeRunId) return;
    if (window.matchMedia?.("(max-width: 760px)").matches) closeMore();
    else setMore((current) => ({ ...current, command: null }));
    flashTurn(command.noticeRunId);
  };
  const openThread = detail && !page ? (selectedSummary ?? detail.payload.thread) : undefined;
  const actions = openThread ? (
    <>
      {hasMore ? (
        <MoreButton
          running={runningCommands.length}
          open={more.open && !preview}
          onClick={() => (more.open && !preview ? closeMore() : openMore())}
          message={message}
        />
      ) : null}
    </>
  ) : null;
  const start = null;

  const forkedThread = detail?.payload.thread.sourceThreadId ? detail.payload.thread : undefined;
  const shownInherited: InheritedConversation | undefined =
    forkedThread && inherited?.forkThreadId === forkedThread.threadId
      ? {
          title:
            (inherited.titleRef && contentByRef[inherited.titleRef]) ||
            threadTitle(inherited.sourceThreadId) ||
            message("chat.untitled"),
          messages: inherited.messages,
          available: inherited.available,
          onOpenSource: () =>
            navigate({ ...route, objectId: inherited.sourceThreadId, view: "content" }),
        }
      : undefined;

  const content = (
    <div className="thread-workarea">
      {(page === "memory" || page === "reminders") && renderPage ? (
        <div className="side-page">{renderPage(page)}</div>
      ) : library && client && configuration?.filesAvailable ? (
        <FilesLibrary
          list={(query) => client.listFiles(query)}
          threadTitle={threadTitle}
          openKey={preview?.key}
          onOpen={openLibraryFile}
          message={message}
        />
      ) : (
        <div className="thread-content">
          {feedback}
          {openingMain || (!detail && selectedThreadId && !shownOutgoing) ? (
            <ThreadLoadingSkeleton scope="conversation" />
          ) : (!detail ||
              (!detail.payload.messages.length && !detail.payload.runs.length && !forkedThread)) &&
            !shownOutgoing ? (
            <ThreadWelcome name={options.ownerName} message={message} />
          ) : (
            <>
              <ChatHistory
                key={detail?.payload.thread.threadId ?? selectedThreadId ?? "new"}
                detail={detail}
                inherited={shownInherited}
                outgoing={shownOutgoing}
                onRetry={() => void submitDraft()}
                contentByRef={contentByRef}
                execution={execution}
                liveTexts={liveTexts}
                executionStates={currentExecutionStates}
                executionStateAvailable={configuration?.executionStateAvailable}
                onPreview={(value) => {
                  closeMore();
                  setPreview((current) => (value.key && current?.key === value.key ? null : value));
                }}
                previewKey={preview?.key}
                filesByRun={filesByRun}
                onOpenFile={(file) => {
                  closeMore();
                  openFile(file);
                }}
                onMoreFiles={() => openMore("files")}
                readImage={readImage}
                connection={connection}
                renderMemory={options.renderMemory}
                renderToolCard={options.renderToolCard}
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
                        performIntent({
                          kind: "stop",
                          runId: run.runId,
                          revision: run.revision,
                        })
                    : undefined
                }
                backgroundCommands={commands}
                stoppingRunIds={stoppingRunIds}
                onOpenCommand={(key) => openMore("commands", key)}
              />
            </>
          )}
          {openingMain ? null : (
            <ChatComposer
              key={`composer:${selectedThreadId ?? "new"}`}
              fresh={!selectedThreadId}
              onUpload={
                client
                  ? (content, as) =>
                      as === "image"
                        ? client.protectImage(content, "private")
                        : client.protectAttachment(content, "private")
                  : undefined
              }
              readImage={readImage}
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
              onModelChange={(ref) =>
                options.onModelChoiceChange?.({
                  modelRef: ref,
                  thinkingLevel: defaultThinkingLevel(
                    availableModels.find((item) => item.ref === ref)?.thinkingLevels ?? [],
                  ),
                })
              }
              onThinkingChange={(level) =>
                options.onModelChoiceChange?.({
                  modelRef: selectedModel?.ref ?? modelRef,
                  thinkingLevel: level,
                })
              }
              onStop={
                configuration?.canCancelRun &&
                (detail?.payload.runs ?? []).some((run) => canStop(run))
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
                    threadTitle={threadTitle}
                    onOpen={() => void loadEnvironment()}
                    onOpenThread={(threadId) =>
                      navigate({ ...route, objectId: threadId, status: null, view: "content" })
                    }
                    message={message}
                  />
                ) : null
              }
              canSend={
                !(shownOutgoing && !shownOutgoing.failed) &&
                (!selectedThreadId || detail?.payload.thread.threadId === selectedThreadId) &&
                (Boolean(unresolvedSubmission) ||
                  ((!detail || detail.payload.thread.status === "active") &&
                    !(detail?.payload.runs ?? []).some((run) => !isAnsweredRun(run))))
              }
            />
          )}
          {!client || !configuration ? (
            <output className="composer-readiness">{message("review.preparing")}</output>
          ) : null}
        </div>
      )}
      {preview ? (
        <ContentPreview
          key={preview.key ?? preview.title}
          value={preview}
          access={fileAccess}
          onBack={more.open && hasMore && !page ? () => setPreview(null) : undefined}
          onClose={() => {
            setPreview(null);
            closeMore();
          }}
        />
      ) : more.open && hasMore && !page ? (
        <MorePanel
          tab={more.tab}
          commandKey={more.command}
          commands={commands}
          fileGroups={fileGroups}
          stoppingRunIds={stoppingRunIds}
          openFileKey={undefined}
          onTab={(tab) => setMore((current) => ({ ...current, tab, command: null }))}
          onCommand={(command) => setMore((current) => ({ ...current, tab: "commands", command }))}
          onStop={configuration?.canCancelRun ? stopCommand : undefined}
          onReport={showReport}
          onOpenFile={openFile}
          onClose={closeMore}
          message={message}
        />
      ) : null}
    </div>
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
    details: null,
    threadTitle,
    actions,
    start,
    list,
    refresh,
    title: page
      ? message(
          page === "files" ? "library.title" : page === "memory" ? "nav.memory" : "nav.reminders",
        )
      : selectedSummary?.titleRef
        ? (contentByRef[selectedSummary.titleRef] ?? message("chat.untitled"))
        : selectedThreadId !== null && selectedThreadId === mainThreadId
          ? message("chat.main")
          : message("chat.untitled"),
  });
}

const READ_DEADLINE_MILLISECONDS = 15_000;
const READ_DEADLINE_EXCEEDED = new Error("THREAD_READ_DEADLINE_EXCEEDED");

async function readRunExecution(
  client: GatewayClient,
  configuration: ControlCenterRuntimeConfiguration,
  threadId: string,
  runs: readonly { readonly runId: string; readonly revision: number }[],
  cache: Record<string, ThreadExecutionRecord[]>,
  current: () => boolean,
  setExecution: (value: Record<string, ThreadExecutionRecord[]>) => void,
  setStates: (
    update: (prior: Record<string, ThreadExecutionState>) => Record<string, ThreadExecutionState>,
  ) => void,
  signal?: AbortSignal,
): Promise<void> {
  await readRunRecords(client, configuration, threadId, runs, cache, current, setExecution, signal);
  if (!current()) return;
  await readRunStates(client, configuration, threadId, runs, current, setStates, signal);
}

async function readRunRecords(
  client: GatewayClient,
  configuration: ControlCenterRuntimeConfiguration,
  threadId: string,
  runs: readonly { readonly runId: string; readonly revision: number }[],
  cache: Record<string, ThreadExecutionRecord[]>,
  current: () => boolean,
  setExecution: (value: Record<string, ThreadExecutionRecord[]>) => void,
  signal?: AbortSignal,
): Promise<void> {
  const records = configuration.executionPresentationAvailable
    ? await Promise.all(
        runs.map(async (run) => {
          const merged = [...(cache[run.runId] ?? [])];
          let afterSequence = merged.at(-1)?.sequence ?? 0;
          for (;;) {
            const page = await client.queryThread(
              threadQueryMessage(configuration, "thread.execution", {
                threadId,
                runId: run.runId,
                afterSequence,
                limit: 200,
              }),
              signal,
            );
            if (page.type !== "thread.execution_snapshot")
              throw new Error("EXECUTION_SCOPE_MISMATCH");
            merged.push(...page.payload.records);
            if (page.payload.nextSequence === null) break;
            if (page.payload.nextSequence <= afterSequence)
              throw new Error("EXECUTION_PAGE_NOT_ADVANCING");
            afterSequence = page.payload.nextSequence;
          }
          return [
            run.runId,
            [...new Map(merged.map((item) => [item.id, item])).values()].sort(
              (a, b) => a.sequence - b.sequence,
            ),
          ] as const;
        }),
      )
    : null;
  if (!current()) return;
  if (records) {
    Object.assign(cache, Object.fromEntries(records));
    setExecution({ ...cache });
  }
}

async function readRunStates(
  client: GatewayClient,
  configuration: ControlCenterRuntimeConfiguration,
  threadId: string,
  runs: readonly { readonly runId: string; readonly revision: number }[],
  current: () => boolean,
  setStates: (
    update: (prior: Record<string, ThreadExecutionState>) => Record<string, ThreadExecutionState>,
  ) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!configuration.executionStateAvailable) return;
  const states = await Promise.all(
    runs.map(async (run) => {
      const result = await client.queryThread(
        threadQueryMessage(configuration, "thread.execution_state", {
          threadId,
          runId: run.runId,
        }),
        signal,
      );
      if (
        result.type !== "thread.execution_state_snapshot" ||
        result.payload.threadId !== threadId ||
        result.payload.runId !== run.runId
      )
        throw new Error("EXECUTION_STATE_SCOPE_MISMATCH");
      if (result.payload.state.runRevision < run.revision)
        throw new Error("EXECUTION_STATE_REVISION_MISMATCH");
      return [run.runId, result.payload.state] as const;
    }),
  );
  if (current()) setStates((prior) => ({ ...prior, ...Object.fromEntries(states) }));
}
