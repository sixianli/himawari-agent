import { isDemoLocale } from "@himawari-agent/domain";

export const DEMO_MAILBOX_TOKEN_PREFIX = "demo-inbox:v1:";

export function demoMailboxTokenLocale(token: string): string | undefined {
  if (!isDemoMailboxToken(token)) return undefined;
  const rest = token.slice(DEMO_MAILBOX_TOKEN_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator < 0) return undefined;
  const locale = rest.slice(0, separator);
  if (!isDemoLocale(locale) || !Number.isFinite(Date.parse(rest.slice(separator + 1))))
    return undefined;
  return locale;
}

export function isDemoMailboxToken(token: string): boolean {
  return token.startsWith(DEMO_MAILBOX_TOKEN_PREFIX);
}
