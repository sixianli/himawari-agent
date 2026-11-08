export interface MessageFocusRequest {
  readonly threadId: string;
  readonly messageId: string;
}

const REQUEST_LIFETIME_MS = 10_000;

let pending: (MessageFocusRequest & { readonly at: number }) | null = null;

export function requestMessageFocus(threadId: string, messageId: string) {
  pending = { threadId, messageId, at: Date.now() };
}

export function pendingMessageFocus(): MessageFocusRequest | null {
  if (pending && Date.now() - pending.at > REQUEST_LIFETIME_MS) pending = null;
  return pending;
}

export function clearMessageFocus() {
  pending = null;
}
