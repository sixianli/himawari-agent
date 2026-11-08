export interface MessageFocusRequest {
  readonly threadId: string;
  readonly messageId: string;
}

const MISMATCH_LIFETIME_MS = 10_000;

let pending: (MessageFocusRequest & { mismatchSince: number | null }) | null = null;

export function requestMessageFocus(threadId: string, messageId: string) {
  pending = { threadId, messageId, mismatchSince: null };
}

export function takeMessageFocus(readyThreadId: string): MessageFocusRequest | null {
  if (!pending) return null;
  if (pending.threadId === readyThreadId) {
    const request = { threadId: pending.threadId, messageId: pending.messageId };
    pending = null;
    return request;
  }
  const now = Date.now();
  if (pending.mismatchSince === null) pending.mismatchSince = now;
  else if (now - pending.mismatchSince > MISMATCH_LIFETIME_MS) pending = null;
  return null;
}

export function hasPendingMessageFocus(): boolean {
  return pending !== null;
}

export function clearMessageFocus() {
  pending = null;
}
