export interface MessageFocusRequest {
  readonly threadId: string;
  readonly messageId: string;
}

let pending: MessageFocusRequest | null = null;

export function requestMessageFocus(threadId: string, messageId: string) {
  pending = { threadId, messageId };
  window.dispatchEvent(new Event(MESSAGE_FOCUS_EVENT));
}

export const MESSAGE_FOCUS_EVENT = "himawari:message-focus";

export function pendingMessageFocus(): MessageFocusRequest | null {
  return pending;
}

export function clearMessageFocus() {
  pending = null;
}
