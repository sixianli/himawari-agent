export const DEMO_MAILBOX_TOKEN_PREFIX = "demo-inbox:v1:";

export function demoMailboxTokenLocale(token: string): string | undefined {
  if (!isDemoMailboxToken(token)) return undefined;
  return token.slice(DEMO_MAILBOX_TOKEN_PREFIX.length).split(":", 1)[0];
}

export function isDemoMailboxToken(token: string): boolean {
  return token.startsWith(DEMO_MAILBOX_TOKEN_PREFIX);
}
