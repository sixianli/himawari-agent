import type {
  ProactiveFetchResult,
  ProactiveSourceItem,
  ProactiveSourceReader,
} from "@himawari-agent/application";
import {
  type DemoLocale,
  DEMO_OWNER_ADDRESS,
  type DemoMail,
  demoMailScript,
  isDemoLocale,
} from "@himawari-agent/domain";
import { DEMO_MAILBOX_TOKEN_PREFIX } from "./demo-mailbox-token.js";
import { findRelatedMail, normalizeSubject } from "./gmail-related.js";
import type { GoogleOAuth } from "./gmail-source.js";

export const DEMO_MAILBOX_ACCOUNT = DEMO_OWNER_ADDRESS;
export const DEMO_MAILBOX_SETTINGS_RETURN = "/?settings=apps&gmail=demo";
const SNIPPET_CHARACTERS = 200;

export function demoMailboxToken(locale: DemoLocale, anchor: string): string {
  return `${DEMO_MAILBOX_TOKEN_PREFIX}${locale}:${anchor}`;
}

function parseToken(
  token: string,
): { readonly locale: DemoLocale; readonly anchor: string; readonly anchorMs: number } | undefined {
  if (!token.startsWith(DEMO_MAILBOX_TOKEN_PREFIX)) return undefined;
  const rest = token.slice(DEMO_MAILBOX_TOKEN_PREFIX.length);
  const separator = rest.indexOf(":");
  const locale = rest.slice(0, separator);
  const anchor = rest.slice(separator + 1);
  const anchorMs = Date.parse(anchor);
  if (separator < 0 || !isDemoLocale(locale) || !Number.isFinite(anchorMs)) return undefined;
  return { locale, anchor, anchorMs };
}

function sourceItem(locale: DemoLocale, anchorMs: number, mail: DemoMail): ProactiveSourceItem {
  const threadId = `demo-${locale}-thread-${mail.threadKey}`;
  return Object.freeze({
    source: "gmail" as const,
    messageId: `demo-${locale}-${mail.key}`,
    threadId,
    from: `${mail.fromName} <${mail.fromAddress}>`,
    fromAddress: mail.fromAddress,
    subject: mail.subject,
    snippet: mail.body.replace(/\s+/gu, " ").trim().slice(0, SNIPPET_CHARACTERS),
    link: `https://himawari.example/demo-inbox/${encodeURIComponent(threadId)}`,
    receivedAt: new Date(anchorMs + mail.offsetMinutes * 60_000).toISOString(),
    categories: Object.freeze([...mail.categories]),
    sentByOwner: mail.sentByOwner,
    body: mail.body,
    bodyTruncated: false,
    bodyUnavailable: false,
    attachments: Object.freeze([]),
    participants: Object.freeze([...mail.participants]),
  });
}

function arrived(
  token: string,
  nowMs: number,
  timeZone: string | undefined,
): { readonly anchorMs: number; readonly items: readonly ProactiveSourceItem[] } | undefined {
  const parsed = parseToken(token);
  if (!parsed) return undefined;
  return {
    anchorMs: parsed.anchorMs,
    items: demoMailScript(parsed.locale, parsed.anchor, timeZone)
      .map((mail) => sourceItem(parsed.locale, parsed.anchorMs, mail))
      .filter((item) => Date.parse(item.receivedAt) <= nowMs)
      .sort((left, right) => left.receivedAt.localeCompare(right.receivedAt)),
  };
}

function matches(item: ProactiveSourceItem, query: string): boolean {
  const quoted = /"([^"]+)"/u.exec(query)?.[1];
  if (quoted === undefined) return false;
  if (query.startsWith("subject:")) return normalizeSubject(item.subject) === quoted.toLowerCase();
  return `${item.subject}\n${item.body ?? ""}`.toUpperCase().includes(quoted.toUpperCase());
}

export function createDemoMailReader(options: {
  readonly now: () => string;
  readonly timeZone?: string;
}): ProactiveSourceReader {
  return Object.freeze<ProactiveSourceReader>({
    source: "gmail",
    async related({ token, items, limits, wholeThread, references, signal }) {
      const pool = arrived(token, Date.parse(options.now()), options.timeZone)?.items ?? [];
      return findRelatedMail({
        items,
        limits,
        ...(wholeThread ? { wholeThread } : {}),
        ...(references ? { references } : {}),
        signal,
        transport: {
          async thread(threadId) {
            return pool.filter((item) => item.threadId === threadId);
          },
          async search(query, maxResults) {
            return pool
              .filter((item) => matches(item, query))
              .slice(0, maxResults)
              .map(({ messageId }) => messageId);
          },
          async message(id) {
            return pool.find(({ messageId }) => messageId === id);
          },
        },
      });
    },
    async fetch({ token, cursor, since, signal, unseen }): Promise<ProactiveFetchResult> {
      if (signal.aborted) return { kind: "failed", step: "timeout" };
      const nowMs = Date.parse(options.now());
      const mailbox = arrived(token, nowMs, options.timeZone);
      if (!mailbox) return { kind: "unauthorized" };
      const cursorMs = cursor === null ? Number.NaN : Date.parse(cursor);
      const lowerMs = Number.isFinite(cursorMs) ? cursorMs : Date.parse(since);
      const fresh = mailbox.items.filter((item) => {
        const receivedMs = Date.parse(item.receivedAt);
        if (receivedMs < mailbox.anchorMs) return false;
        return Number.isFinite(cursorMs) ? receivedMs > lowerMs : receivedMs >= lowerMs;
      });
      const wanted = new Set(await unseen(fresh.map(({ messageId }) => messageId)));
      return {
        kind: "items",
        items: fresh.filter(({ messageId }) => wanted.has(messageId)),
        cursor: new Date(nowMs).toISOString(),
      };
    },
  });
}

export function createDemoGoogleOAuth(): GoogleOAuth {
  return Object.freeze<GoogleOAuth>({
    authorizationUrl: () => DEMO_MAILBOX_SETTINGS_RETURN,
    async exchange() {
      throw new Error("DEMO_MAILBOX_NO_OAUTH");
    },
    async accessToken() {
      return "demo-access";
    },
    async revoke() {
      return true;
    },
  });
}
