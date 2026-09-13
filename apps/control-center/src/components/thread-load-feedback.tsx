import { useEffect, useState } from "react";
import { useControlCenterIntl } from "../i18n/runtime.js";
import { ActionButton } from "./index.js";

export function ThreadLoadingSkeleton({ scope }: { readonly scope: "list" | "conversation" }) {
  const { message } = useControlCenterIntl();
  return (
    <output className="thread-loading-skeleton" data-scope={scope}>
      <span className="sr-only">
        {message(scope === "list" ? "loading.list" : "loading.conversation")}
      </span>
      <span aria-hidden="true">
        <span className="thread-loading-bar" />
        <span className="thread-loading-bar" />
        <span className="thread-loading-bar" />
      </span>
    </output>
  );
}

export function ThreadLoadFeedback({
  pending,
  failed,
  scope,
  attempt,
  onRetry,
}: {
  readonly pending: boolean;
  readonly failed: boolean;
  readonly scope: "list" | "conversation" | "search";
  readonly attempt: number;
  readonly onRetry: () => void;
}) {
  const { message } = useControlCenterIntl();
  const [slowAttempt, setSlowAttempt] = useState<number | null>(null);
  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => setSlowAttempt(attempt), 3_000);
    return () => window.clearTimeout(timer);
  }, [pending, attempt]);
  if (!failed && !(pending && slowAttempt === attempt)) return null;
  const labels = {
    list: { slow: "loading.slowList", failed: "loading.failedList" },
    conversation: { slow: "loading.slowConversation", failed: "loading.failedConversation" },
    search: { slow: "loading.slowSearch", failed: "loading.failedSearch" },
  } as const;
  return (
    <output className="thread-load-feedback">
      <span className="thread-load-message">
        {message(labels[scope][failed ? "failed" : "slow"])}
      </span>
      <ActionButton variant="quiet" onClick={onRetry}>
        {message("loading.retry")}
      </ActionButton>
    </output>
  );
}
