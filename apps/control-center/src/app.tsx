import type { GatewayV2Event, GatewayV2Snapshot } from "@himawari-agent/gateway-contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ControlCenterBrowserStorage } from "./browser-storage.js";
import {
  GatewayClient,
  type MutationStatus,
  loadRuntimeConfiguration,
  safeBrowserLog,
} from "./gateway-client.js";
import { commandMessage, queryMessage } from "./messages.js";
import { SseStateSynchronizer } from "./sse-synchronizer.js";

const pages = [
  ["threads", "对话"],
  ["approvals", "审批"],
  ["tasks", "后台任务"],
  ["inbox", "收件箱"],
  ["memory", "记忆"],
  ["trace", "追踪"],
  ["identity", "会话与设备"],
  ["health", "健康状态"],
] as const;

type Page = (typeof pages)[number][0];

function statusText(status: MutationStatus | null): string {
  switch (status) {
    case "pending":
      return "正在提交，尚未接纳";
    case "accepted":
      return "已接纳";
    case "replayed":
      return "已接纳（幂等重放）";
    case "rejected":
      return "已拒绝";
    case "expired":
      return "已过期";
    default:
      return "尚无变更";
  }
}

function queryForPage(
  page: Page,
  configuration: Awaited<ReturnType<typeof loadRuntimeConfiguration>>,
) {
  switch (page) {
    case "threads":
      return queryMessage(configuration, "thread.list", { afterCursor: null, limit: 100 });
    case "approvals":
      return queryMessage(configuration, "approval.list", {
        status: "pending",
        afterCursor: null,
        limit: 100,
      });
    case "tasks":
      return queryMessage(configuration, "task.list", {
        status: null,
        afterCursor: null,
        limit: 100,
      });
    case "inbox":
      return queryMessage(configuration, "inbox.list", {
        unreadOnly: false,
        afterCursor: null,
        limit: 100,
      });
    case "memory":
      return queryMessage(configuration, "memory.search", {
        queryRef: "query:recent",
        status: null,
        limit: 100,
      });
    case "trace":
      return queryMessage(configuration, "trace.timeline", {
        threadId: null,
        runId: null,
        afterSequence: 0,
        limit: 200,
      });
    case "identity":
      return queryMessage(configuration, "identity.sessions", {
        includeRevoked: true,
        afterCursor: null,
        limit: 100,
      });
    case "health":
      return queryMessage(configuration, "health.status", { includeDependencies: true });
  }
}

export function ControlCenterApp() {
  const storage = useMemo(() => new ControlCenterBrowserStorage(window.localStorage), []);
  const [configuration, setConfiguration] = useState<
    Awaited<ReturnType<typeof loadRuntimeConfiguration>> | undefined
  >();
  const [client, setClient] = useState<GatewayClient | undefined>();
  const [page, setPage] = useState<Page>("threads");
  const [snapshot, setSnapshot] = useState<GatewayV2Snapshot | undefined>();
  const [events, setEvents] = useState<readonly GatewayV2Event[]>([]);
  const [connection, setConnection] = useState<"connecting" | "connected" | "offline">(
    "connecting",
  );
  const [requestError, setRequestError] = useState<string | null>(null);
  const [mutationStatus, setMutationStatus] = useState<MutationStatus | null>(null);
  const [threadId, setThreadId] = useState("thread-main");
  const [draft, setDraft] = useState(() => storage.readDraft("thread-main"));
  const [targetRef, setTargetRef] = useState("");
  const [memoryCorrection, setMemoryCorrection] = useState("");

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
      log: (entry) => {
        window.dispatchEvent(new CustomEvent("himawari:safe-log", { detail: entry }));
      },
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
    setRequestError(null);
    try {
      setSnapshot(await client.query(queryForPage(page, configuration)));
    } catch (error) {
      const message = error instanceof Error ? error.message : "CONTROL_CENTER_REQUEST_REJECTED";
      setRequestError(message);
    }
  }, [client, configuration, page]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runMutation = useCallback(
    async (operation: () => Promise<{ readonly status: MutationStatus }>) => {
      setMutationStatus("pending");
      setRequestError(null);
      try {
        const result = await operation();
        setMutationStatus(result.status);
        await refresh();
      } catch (error) {
        const message = error instanceof Error ? error.message : "CONTROL_CENTER_REQUEST_REJECTED";
        setMutationStatus(message.includes("EXPIRED") ? "expired" : "rejected");
        setRequestError(message);
      }
    },
    [refresh],
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

  const performAction = async (
    action: "approve" | "deny" | "pause" | "resume" | "correct" | "archive" | "delete" | "revoke",
  ) => {
    if (!client || !configuration || !targetRef) return;
    if (action === "correct" && !memoryCorrection.trim()) return;
    await runMutation(async () => {
      switch (action) {
        case "approve":
        case "deny":
          return client.mutate(
            commandMessage(
              configuration,
              "approval.respond",
              {
                approvalRequestId: targetRef,
                decision: action === "approve" ? "approved" : "denied",
                semanticSnapshotHash: "sha256:confirmed",
                editedPayloadRef: null,
              },
              { risk: "high", authorizationRef: "authorization:recent-owner" },
            ),
          );
        case "pause":
        case "resume":
          return client.mutate(
            commandMessage(configuration, "task.set_state", {
              jobId: targetRef,
              action,
              reasonCode: "owner_control_center",
            }),
          );
        case "correct":
        case "archive":
        case "delete": {
          const contentRef =
            action === "correct" ? await client.protectText(memoryCorrection, "private") : null;
          const result = await client.mutate(
            commandMessage(configuration, "memory.mutate", {
              memoryId: targetRef,
              action,
              expectedRevision: 0,
              contentRef,
            }),
          );
          if (action === "correct") setMemoryCorrection("");
          return result;
        }
        case "revoke":
          return client.mutate(
            commandMessage(
              configuration,
              "session.revoke",
              {
                sessionId: targetRef,
                deviceId: "device:selected",
                recentAuthenticationRef: "recent:required",
                reasonCode: "owner_revoked",
              },
              { risk: "high", authorizationRef: "authorization:recent-owner" },
            ),
          );
      }
    });
  };

  const cancelRun = async () => {
    if (!client || !configuration || !targetRef) return;
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
        payload: { runId: targetRef, reasonCode: "owner_cancelled" },
      }),
    );
  };

  const itemRefs =
    snapshot?.kind === "snapshot" && snapshot.type === "collection.snapshot"
      ? snapshot.payload.itemRefs
      : [];

  return (
    <div className="app-shell" data-density={storage.readPreferences().density}>
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <header className="topbar">
        <div>
          <p className="eyebrow">HIMAWARI AGENT</p>
          <h1>控制中心</h1>
        </div>
        <output className={`connection connection-${connection}`} aria-live="polite">
          <span aria-hidden="true">●</span>{" "}
          {connection === "connected"
            ? "实时连接"
            : connection === "connecting"
              ? "连接中"
              : "离线，正在恢复"}
        </output>
      </header>
      <nav aria-label="控制中心功能" className="primary-nav">
        {pages.map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-current={page === value ? "page" : undefined}
            onClick={() => setPage(value)}
          >
            {label}
          </button>
        ))}
      </nav>
      <main id="main-content" tabIndex={-1}>
        <section className="panel" aria-labelledby="page-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">持久产品状态</p>
              <h2 id="page-title">{pages.find(([value]) => value === page)?.[1]}</h2>
            </div>
            <button type="button" onClick={() => void refresh()}>
              刷新
            </button>
          </div>

          {requestError ? (
            <div className="notice notice-error" role="alert">
              <strong>当前不可用</strong>
              <span>{requestError}</span>
            </div>
          ) : null}

          <p className="mutation-status" aria-live="polite">
            命令状态：{statusText(mutationStatus)}
          </p>

          {page === "threads" ? (
            <div className="journey-grid">
              <form
                className="composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitDraft();
                }}
              >
                <label htmlFor="thread-id">Thread ID</label>
                <input
                  id="thread-id"
                  value={threadId}
                  onChange={(event) => {
                    storage.saveDraft(threadId, draft);
                    setThreadId(event.target.value);
                    setDraft(storage.readDraft(event.target.value));
                  }}
                />
                <label htmlFor="message-draft">消息草稿</label>
                <textarea
                  id="message-draft"
                  rows={6}
                  value={draft}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    storage.saveDraft(threadId, event.target.value);
                  }}
                />
                <div className="actions">
                  <button type="submit" disabled={!draft.trim()}>
                    发送并启动 Run
                  </button>
                  <button type="button" className="secondary" onClick={() => void cancelRun()}>
                    取消指定 Run
                  </button>
                </div>
              </form>
              <div>
                <h3>实时 Run 事件</h3>
                <ol className="event-list" aria-live="polite">
                  {events.slice(-10).map((event) => (
                    <li key={event.payload.cursor}>
                      <strong>{event.payload.eventType}</strong>
                      <span>{event.payload.cursor}</span>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          ) : null}

          {page === "tasks" ? (
            <div className="notice">
              <strong>Repository monitor</strong>
              <span>Repository 变更通过持久后台任务进入同一列表与授权管线。</span>
            </div>
          ) : null}

          <label htmlFor="target-ref">所选记录引用</label>
          <input
            id="target-ref"
            value={targetRef}
            onChange={(event) => setTargetRef(event.target.value)}
            placeholder="从下方复制一个引用"
          />

          <ul className="reference-list" aria-label="当前记录">
            {itemRefs.length > 0 ? (
              itemRefs.map((reference) => (
                <li key={reference}>
                  <code>{reference}</code>
                </li>
              ))
            ) : (
              <li>暂无记录</li>
            )}
          </ul>

          <div className="actions page-actions">
            {page === "approvals" ? (
              <>
                <button type="button" onClick={() => void performAction("approve")}>
                  批准
                </button>
                <button type="button" className="danger" onClick={() => void performAction("deny")}>
                  拒绝
                </button>
              </>
            ) : null}
            {page === "tasks" ? (
              <>
                <button type="button" onClick={() => void performAction("pause")}>
                  暂停
                </button>
                <button type="button" onClick={() => void performAction("resume")}>
                  恢复
                </button>
              </>
            ) : null}
            {page === "memory" ? (
              <>
                <label htmlFor="memory-correction">更正后的记忆内容</label>
                <textarea
                  id="memory-correction"
                  rows={4}
                  value={memoryCorrection}
                  onChange={(event) => setMemoryCorrection(event.target.value)}
                />
                <button
                  type="button"
                  disabled={!memoryCorrection.trim()}
                  onClick={() => void performAction("correct")}
                >
                  更正
                </button>
                <button type="button" onClick={() => void performAction("archive")}>
                  归档
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => void performAction("delete")}
                >
                  删除
                </button>
              </>
            ) : null}
            {page === "identity" ? (
              <button type="button" className="danger" onClick={() => void performAction("revoke")}>
                撤销会话
              </button>
            ) : null}
          </div>

          {snapshot?.type === "health.snapshot" ? (
            <dl className="health-grid">
              <div>
                <dt>服务</dt>
                <dd>{snapshot.payload.live ? "存活" : "不可用"}</dd>
              </div>
              <div>
                <dt>接纳</dt>
                <dd>{snapshot.payload.ready ? "就绪" : "停止接纳"}</dd>
              </div>
              <div>
                <dt>状态</dt>
                <dd>{snapshot.payload.status}</dd>
              </div>
              <div>
                <dt>主机</dt>
                <dd>{snapshot.payload.activeHost}</dd>
              </div>
            </dl>
          ) : null}
        </section>
      </main>
      <footer>
        <span>浏览器只保存草稿、界面偏好与最后 cursor。</span>
        <span>{safeBrowserLog("CONTROL_CENTER_RENDERED").code}</span>
      </footer>
    </div>
  );
}
