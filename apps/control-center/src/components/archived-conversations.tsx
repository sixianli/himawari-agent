import { useEffect, useRef, useState } from "react";
import type { ThreadGatewaySnapshot } from "@himawari-agent/gateway-contracts";
import type { ControlCenterRuntimeConfiguration, GatewayClient } from "../gateway-client.js";
import { threadQueryMessage } from "../messages.js";
import { useControlCenterIntl } from "../i18n/runtime.js";
import { ActionButton } from "./primitives.js";
type Thread = Extract<
  ThreadGatewaySnapshot,
  { type: "thread.detail_snapshot" }
>["payload"]["thread"];
export function ArchivedConversations({
  client,
  configuration,
  onRestore,
  onOpen,
}: {
  client: GatewayClient | undefined;
  configuration: ControlCenterRuntimeConfiguration | undefined;
  onRestore: (thread: Thread) => Promise<unknown>;
  onOpen: (thread: Thread) => void;
}) {
  const { message } = useControlCenterIntl();
  const [items, setItems] = useState<{ thread: Thread; title: string }[]>([]),
    [revision, setRevision] = useState(0),
    [error, setError] = useState(false),
    [loading, setLoading] = useState(true);
  const restoring = useRef(false);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!expanded) return;
    let active = true;
    void revision;
    setLoading(true);
    setError(false);
    if (!client || !configuration) {
      setLoading(false);
      setError(true);
    }
    if (client && configuration)
      void (async () => {
        const all: Thread[] = [];
        const seen = new Set<string>();
        let afterCursor: string | null = null;
        do {
          const result = await client.queryThread(
            threadQueryMessage(configuration, "thread.list", {
              statuses: ["archived"],
              pinnedOnly: false,
              afterCursor,
              limit: 100,
            }),
          );
          if (result.type !== "thread.collection_snapshot") throw new Error("INVALID_COLLECTION");
          all.push(...result.payload.threads);
          afterCursor = result.payload.nextCursor;
          if (afterCursor && seen.has(afterCursor)) throw new Error("ARCHIVE_CURSOR_REPEATED");
          if (afterCursor) seen.add(afterCursor);
        } while (afterCursor);
        const rows = await Promise.all(
          all.map(async (thread) => ({
            thread,
            title: thread.titleRef
              ? (await client.readText(thread.titleRef)).content
              : message("chat.untitled"),
          })),
        );
        if (active) setItems(rows);
      })()
        .catch(() => {
          if (active) setError(true);
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    return () => {
      active = false;
    };
  }, [client, configuration, expanded, revision, message]);
  return (
    <section>
      <h3>{message(expanded ? "review.archives" : "review.settings.data")}</h3>
      {expanded ? (
        <ActionButton variant="quiet" onClick={() => setExpanded(false)}>
          {message("common.back")}
        </ActionButton>
      ) : (
        <div className="setting-row">
          <span>
            {message("review.archives")}
            <small className="setting-description">{message("review.archiveDescription")}</small>
          </span>
          <ActionButton
            variant="secondary"
            aria-label={message("review.archives")}
            onClick={() => setExpanded(true)}
          >
            {message("review.manageArchives")}
          </ActionButton>
        </div>
      )}
      {expanded ? (
        <>
          {error ? (
            <p role="alert">
              {message("error.currentUnavailable")}
              <ActionButton onClick={() => setRevision((v) => v + 1)}>
                {message("common.refresh")}
              </ActionButton>
            </p>
          ) : loading ? (
            <output>{message("review.loading")}</output>
          ) : !items.length ? (
            <p>{message("common.noRecords")}</p>
          ) : (
            <ul className="archived-conversations">
              {items.map(({ thread, title }) => (
                <li key={thread.threadId}>
                  <ActionButton variant="quiet" onClick={() => onOpen(thread)}>
                    {title}
                  </ActionButton>
                  <ActionButton
                    variant="secondary"
                    disabled={busy}
                    onClick={async () => {
                      if (restoring.current) return;
                      restoring.current = true;
                      setBusy(true);
                      try {
                        await onRestore(thread);
                        setRevision((v) => v + 1);
                      } catch {
                        setError(true);
                      } finally {
                        restoring.current = false;
                        setBusy(false);
                      }
                    }}
                  >
                    {message("threads.restore")}
                  </ActionButton>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </section>
  );
}
