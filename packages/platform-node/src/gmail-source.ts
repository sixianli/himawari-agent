import {
  type FlatMailFetchResult,
  GMAIL_SOURCE,
  mailReader,
  type ProactiveMail,
  type ProactiveMailReader,
  ProactiveSourceUnauthorizedError,
} from "@himawari-agent/application";
import { extractGmailBody, type GmailPart } from "./gmail-body.js";

export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const CALENDAR_READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
export const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

const REQUEST_TIMEOUT_MS = 20_000;
const HISTORY_PAGES = 10;
const LIST_PAGES = 5;
const MESSAGE_LIMIT = 300;
const PARALLEL_READS = 5;
const UNSEEN_CHUNK = 500;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  CATEGORY_PROMOTIONS: "promotions",
  CATEGORY_SOCIAL: "social",
  CATEGORY_FORUMS: "forums",
  CATEGORY_UPDATES: "updates",
  SPAM: "spam",
};

export class GoogleUnauthorizedError extends ProactiveSourceUnauthorizedError {
  constructor() {
    super("GOOGLE_UNAUTHORIZED");
  }
}

export class GoogleRequestError extends Error {
  readonly step: string;
  readonly status: number;
  constructor(step: string, status: number) {
    super(`GOOGLE_${step.toUpperCase()}_${status}`);
    this.step = step;
    this.status = status;
  }
}

export interface GoogleOAuthOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly fetch?: Fetch;
}

export interface GoogleOAuth {
  authorizationUrl(state: string): string;
  exchange(code: string): Promise<{
    readonly refreshToken: string;
    readonly accessToken: string;
    readonly scopes: string[];
  }>;
  accessToken(refreshToken: string, signal?: AbortSignal): Promise<string>;
  revoke(token: string): Promise<boolean>;
}

function withTimeout(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function createGoogleOAuth(options: GoogleOAuthOptions): GoogleOAuth {
  const send = options.fetch ?? ((url, init) => fetch(url, init));
  const token = async (body: readonly [string, string][], step: string, signal?: AbortSignal) => {
    const response = await send(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams([
        ["client_id", options.clientId],
        ["client_secret", options.clientSecret],
        ...body,
      ]).toString(),
      signal: withTimeout(signal),
    });
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.status === 400 && json["error"] === "invalid_grant")
      throw new GoogleUnauthorizedError();
    if (response.status === 401) throw new GoogleUnauthorizedError();
    if (!response.ok) throw new GoogleRequestError(step, response.status);
    return json;
  };
  return Object.freeze<GoogleOAuth>({
    authorizationUrl(state) {
      const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
      url.search = new URLSearchParams({
        client_id: options.clientId,
        redirect_uri: options.redirectUri,
        response_type: "code",
        scope: `${GMAIL_READONLY_SCOPE} ${CALENDAR_READONLY_SCOPE}`,
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "false",
        state,
      }).toString();
      return url.toString();
    },
    async exchange(code) {
      const json = await token(
        [
          ["code", code],
          ["grant_type", "authorization_code"],
          ["redirect_uri", options.redirectUri],
        ],
        "exchange",
      );
      const refreshToken = json["refresh_token"];
      const accessToken = json["access_token"];
      const scopes = typeof json["scope"] === "string" ? json["scope"].split(" ") : [];
      if (
        typeof refreshToken !== "string" ||
        refreshToken.length === 0 ||
        typeof accessToken !== "string" ||
        accessToken.length === 0
      )
        throw new GoogleRequestError("exchange", 200);
      if (!scopes.includes(GMAIL_READONLY_SCOPE)) throw new GoogleRequestError("scope", 200);
      return { refreshToken, accessToken, scopes };
    },
    async accessToken(refreshToken, signal) {
      const json = await token(
        [
          ["refresh_token", refreshToken],
          ["grant_type", "refresh_token"],
        ],
        "token",
        signal,
      );
      const access = json["access_token"];
      if (typeof access !== "string" || access.length === 0)
        throw new GoogleRequestError("token", 200);
      return access;
    },
    async revoke(value) {
      const response = await send(GOOGLE_REVOKE_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: value }).toString(),
        signal: withTimeout(undefined),
      });
      return response.ok || response.status === 400;
    },
  });
}

function header(
  headers: readonly { readonly name?: string; readonly value?: string }[] | undefined,
  name: string,
): string {
  return (
    headers?.find((entry) => entry.name?.toLowerCase() === name.toLowerCase())?.value ?? ""
  ).trim();
}

export function senderAddress(from: string): string {
  const bracket = /<([^<>\s]+@[^<>\s]+)>/u.exec(from);
  if (bracket?.[1]) return bracket[1].toLowerCase();
  const bare = /([^\s<>"']+@[^\s<>"']+)/u.exec(from);
  return (bare?.[1] ?? "").toLowerCase();
}

interface GmailMessage {
  readonly id?: string;
  readonly threadId?: string;
  readonly labelIds?: readonly string[];
  readonly snippet?: string;
  readonly internalDate?: string;
  readonly payload?: GmailPart;
}

const ADDRESS = /[^\s<>"',;()]+@[^\s<>"',;()]+/gu;

function participantsOf(headers: GmailPart["headers"]): readonly string[] {
  const found = new Set<string>();
  for (const name of ["From", "To", "Cc"])
    for (const match of header(headers, name).matchAll(ADDRESS)) found.add(match[0].toLowerCase());
  return Object.freeze([...found].slice(0, 50));
}

export function gmailItem(
  message: GmailMessage,
  options: { readonly history?: boolean } = {},
): ProactiveMail | undefined {
  const labels = message.labelIds ?? [];
  if (!message.id || !message.threadId) return undefined;
  if (labels.includes("DRAFT") || labels.includes("CHAT")) return undefined;
  if (options.history) {
    if (labels.includes("TRASH") || labels.includes("SPAM")) return undefined;
  } else if (!labels.includes("INBOX") && !labels.includes("SENT")) return undefined;
  const received = Number(message.internalDate);
  const from = header(message.payload?.headers, "From");
  const body = extractGmailBody(message.payload);
  return Object.freeze({
    source: GMAIL_SOURCE.name,
    messageId: message.id,
    threadId: message.threadId,
    from: from.slice(0, 320),
    fromAddress: senderAddress(from),
    subject: header(message.payload?.headers, "Subject").slice(0, 500),
    snippet: (message.snippet ?? "").slice(0, 500),
    link: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(message.threadId)}`,
    receivedAt: new Date(Number.isFinite(received) ? received : 0).toISOString(),
    categories: Object.freeze(
      labels.flatMap((label) => (CATEGORY_LABELS[label] ? [CATEGORY_LABELS[label]] : [])),
    ),
    sentByOwner: labels.includes("SENT"),
    body: body.text,
    bodyTruncated: body.truncated,
    bodyUnavailable: body.unavailable,
    attachments: body.attachments,
    participants: participantsOf(message.payload?.headers),
  });
}

export async function readGmailAccount(input: {
  readonly accessToken: string;
  readonly fetch?: Fetch;
}): Promise<string> {
  const send = input.fetch ?? ((url, init) => fetch(url, init));
  const response = await send(`${GMAIL_API}/profile`, {
    method: "GET",
    headers: { authorization: `Bearer ${input.accessToken}`, accept: "application/json" },
    signal: withTimeout(undefined),
  });
  if (response.status === 401 || response.status === 403) throw new GoogleUnauthorizedError();
  if (!response.ok) throw new GoogleRequestError("profile", response.status);
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const email = json["emailAddress"];
  if (typeof email !== "string" || !email.includes("@") || email.length > 320)
    throw new GoogleRequestError("profile", 200);
  return email.toLowerCase();
}

export function createGmailReader(options: {
  readonly oauth: Pick<GoogleOAuth, "accessToken">;
  readonly fetch?: Fetch;
}): ProactiveMailReader {
  const send = options.fetch ?? ((url, init) => fetch(url, init));
  return mailReader({
    source: GMAIL_SOURCE.name,
    async thread({ token, threadId, signal }) {
      const access = await options.oauth.accessToken(token, signal);
      const response = await send(
        `${GMAIL_API}/threads/${encodeURIComponent(threadId)}?format=full`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${access}`, accept: "application/json" },
          signal: withTimeout(signal),
        },
      );
      if (response.status === 404) return undefined;
      if (response.status === 401) throw new GoogleUnauthorizedError();
      if (!response.ok) throw new GoogleRequestError("thread", response.status);
      const thread = (await response.json()) as { messages?: GmailMessage[] };
      return (thread.messages ?? []).flatMap((message) => {
        const item = gmailItem(message, { history: true });
        return item ? [item] : [];
      });
    },
    async search({ token, query, limit, signal }) {
      const access = await options.oauth.accessToken(token, signal);
      const get = async <T>(step: string, url: string): Promise<T | undefined> => {
        const response = await send(url, {
          method: "GET",
          headers: { authorization: `Bearer ${access}`, accept: "application/json" },
          signal: withTimeout(signal),
        });
        if (response.status === 404) return undefined;
        if (response.status === 401) throw new GoogleUnauthorizedError();
        if (!response.ok) throw new GoogleRequestError(step, response.status);
        return (await response.json()) as T;
      };
      const listed = await get<{ messages?: { id?: string }[] }>(
        "search",
        `${GMAIL_API}/messages?${new URLSearchParams({ q: query, maxResults: String(limit) })}`,
      );
      const ids = (listed?.messages ?? []).flatMap(({ id }) => (id ? [id] : []));
      const messages: (GmailMessage | undefined)[] = [];
      for (let start = 0; start < ids.length; start += PARALLEL_READS) {
        messages.push(
          ...(await Promise.all(
            ids.slice(start, start + PARALLEL_READS).map((id) =>
              get<GmailMessage>(
                "message",
                `${GMAIL_API}/messages/${encodeURIComponent(id)}?${new URLSearchParams([
                  ["format", "metadata"],
                  ["metadataHeaders", "From"],
                  ["metadataHeaders", "To"],
                  ["metadataHeaders", "Cc"],
                  ["metadataHeaders", "Subject"],
                ])}`,
              ),
            ),
          )),
        );
      }
      return messages.flatMap((message) => {
        const item = message ? gmailItem(message, { history: true }) : undefined;
        return item ? [item] : [];
      });
    },
    async fetch({ token, cursor, since, signal, unseen }): Promise<FlatMailFetchResult> {
      let access: string;
      try {
        access = await options.oauth.accessToken(token, signal);
      } catch (error) {
        if (error instanceof GoogleUnauthorizedError) return { kind: "unauthorized" };
        return { kind: "failed", step: "token" };
      }
      const get = async <T>(step: string, url: string): Promise<T | undefined> => {
        const response = await send(url, {
          method: "GET",
          headers: {
            authorization: `Bearer ${access}`,
            accept: "application/json",
          },
          signal: withTimeout(signal),
        });
        if (response.status === 401 || response.status === 403) throw new GoogleUnauthorizedError();
        if (response.status === 404) return undefined;
        if (!response.ok) throw new GoogleRequestError(step, response.status);
        return (await response.json()) as T;
      };
      try {
        let ids: string[] | undefined;
        let next: string | null = null;
        if (cursor) {
          ids = [];
          let pageToken: string | undefined;
          for (let page = 0; page < HISTORY_PAGES; page++) {
            const query = new URLSearchParams({
              startHistoryId: cursor,
              historyTypes: "messageAdded",
              maxResults: "500",
              ...(pageToken ? { pageToken } : {}),
            });
            const history = await get<{
              history?: { messagesAdded?: { message?: { id?: string } }[] }[];
              historyId?: string;
              nextPageToken?: string;
            }>("history", `${GMAIL_API}/history?${query}`);
            if (!history) {
              ids = undefined;
              break;
            }
            for (const record of history.history ?? [])
              for (const added of record.messagesAdded ?? [])
                if (added.message?.id) ids.push(added.message.id);
            next = history.historyId ?? next;
            pageToken = history.nextPageToken;
            if (!pageToken) break;
          }
        }
        if (!ids) {
          const profile = await get<{ historyId?: string }>("profile", `${GMAIL_API}/profile`);
          next = profile?.historyId ?? null;
          ids = [];
          let pageToken: string | undefined;
          for (let page = 0; page < LIST_PAGES; page++) {
            const query = new URLSearchParams({
              q: `after:${Math.floor(Date.parse(since) / 1_000)}`,
              maxResults: "100",
              ...(pageToken ? { pageToken } : {}),
            });
            const listed = await get<{ messages?: { id?: string }[]; nextPageToken?: string }>(
              "list",
              `${GMAIL_API}/messages?${query}`,
            );
            for (const message of listed?.messages ?? []) if (message.id) ids.push(message.id);
            pageToken = listed?.nextPageToken;
            if (!pageToken) break;
          }
        }
        const distinct = [...new Set(ids)];
        const wanted: string[] = [];
        for (let start = 0; start < distinct.length; start += UNSEEN_CHUNK)
          wanted.push(...(await unseen(distinct.slice(start, start + UNSEEN_CHUNK))));
        const items: ProactiveMail[] = [];
        const queue = wanted.slice(0, MESSAGE_LIMIT);
        while (queue.length > 0) {
          const batch = queue.splice(0, PARALLEL_READS);
          const messages = await Promise.all(
            batch.map((id) =>
              get<GmailMessage>(
                "message",
                `${GMAIL_API}/messages/${encodeURIComponent(id)}?format=full`,
              ),
            ),
          );
          for (const message of messages) {
            const item = message ? gmailItem(message) : undefined;
            if (item) items.push(item);
          }
        }
        items.sort((left, right) => left.receivedAt.localeCompare(right.receivedAt));
        return {
          kind: "items",
          items,
          cursor: wanted.length > MESSAGE_LIMIT ? null : next,
        };
      } catch (error) {
        if (error instanceof GoogleUnauthorizedError) return { kind: "unauthorized" };
        if (error instanceof GoogleRequestError) return { kind: "failed", step: error.step };
        return { kind: "failed", step: signal.aborted ? "timeout" : "network" };
      }
    },
  });
}
