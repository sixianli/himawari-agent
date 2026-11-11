export const DEMO_MAILBOX_TOKEN_PREFIX = "demo-inbox:v1:";

export function isDemoMailboxToken(token: string): boolean {
  return token.startsWith(DEMO_MAILBOX_TOKEN_PREFIX);
}
