import { flatMailReader } from "@himawari-agent/application";
import { describe, expect, it } from "vitest";
import {
  CALENDAR_READONLY_SCOPE,
  createGmailReader,
  createGoogleOAuth,
  GMAIL_READONLY_SCOPE,
  gmailItem,
  readGmailAccount,
  senderAddress,
} from "../src/gmail-source.ts";

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: string;
  readonly authorization: string | null;
}

function fakeGoogle(routes: (url: URL, call: Call) => Response | undefined) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const call = {
      url,
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? init.body : "",
      authorization: new Headers(init.headers).get("authorization"),
    };
    calls.push(call);
    return routes(new URL(url), call) ?? new Response("{}", { status: 500 });
  };
  return { calls, fetch };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

const message = (id: string, labels: string[], from = "Bank <info@smbc.co.jp>") => ({
  id,
  threadId: `t-${id}`,
  labelIds: labels,
  snippet: `snippet ${id}`,
  internalDate: String(Date.parse("2026-11-04T00:00:00.000Z") + Number(id.replace(/\D/gu, ""))),
  payload: {
    mimeType: "text/plain",
    headers: [
      { name: "From", value: from },
      { name: "Subject", value: `subject ${id}` },
    ],
    body: { size: 10, data: Buffer.from(`body ${id}`).toString("base64url") },
  },
});

function google(options: { history?: number; grant?: "ok" | "invalid" } = {}) {
  return fakeGoogle((url, call) => {
    if (url.href === "https://oauth2.googleapis.com/token") {
      if (options.grant === "invalid") return json({ error: "invalid_grant" }, 400);
      expect(call.body).toContain("grant_type=refresh_token");
      return json({ access_token: "access-1", expires_in: 3600 });
    }
    if (call.authorization !== "Bearer access-1") return json({}, 401);
    if (url.pathname.endsWith("/history")) {
      if (options.history === 404) return json({ error: { code: 404 } }, 404);
      return json({
        history: [
          { messagesAdded: [{ message: { id: "m1" } }, { message: { id: "m2" } }] },
          { messagesAdded: [{ message: { id: "m1" } }] },
        ],
        historyId: "900",
      });
    }
    if (url.pathname.endsWith("/profile")) return json({ historyId: "777" });
    if (url.pathname.endsWith("/messages") && !url.pathname.includes("/messages/"))
      return json({ messages: [{ id: "m1" }, { id: "m3" }] });
    const id = url.pathname.split("/").at(-1) ?? "";
    if (id === "m1") return json(message("m1", ["INBOX", "CATEGORY_UPDATES"]));
    if (id === "m2") return json(message("m2", ["SENT"], "Andy <andy@example.com>"));
    if (id === "m3") return json(message("m3", ["INBOX", "CATEGORY_PROMOTIONS"]));
    return undefined;
  });
}

const oauth = (fetch: (url: string, init: RequestInit) => Promise<Response>) =>
  createGoogleOAuth({
    clientId: "client-1",
    clientSecret: "secret-1",
    redirectUri: "https://himawari.example/api/proactive/v1/google/callback",
    fetch,
  });

const input = (cursor: string | null, unseen = async (ids: readonly string[]) => ids) => ({
  token: "refresh-1",
  cursor,
  since: "2026-11-01T01:00:00.000Z",
  signal: new AbortController().signal,
  unseen,
});

describe("[PG-11] Gmail read-only source", () => {
  it("[PG-11] reads only new messages from history, skips already judged ids and moves the cursor", async () => {
    const fake = google();
    const reader = flatMailReader(
      createGmailReader({ oauth: oauth(fake.fetch), fetch: fake.fetch }),
    );
    const result = await reader.fetch(input("500", async (ids) => ids.filter((id) => id !== "m9")));
    expect(result).toMatchObject({ kind: "items", cursor: "900" });
    if (result.kind !== "items") throw new Error("expected items");
    expect(result.items.map(({ messageId, sentByOwner }) => ({ messageId, sentByOwner }))).toEqual([
      { messageId: "m1", sentByOwner: false },
      { messageId: "m2", sentByOwner: true },
    ]);
    expect(result.items[0]).toMatchObject({
      fromAddress: "info@smbc.co.jp",
      categories: ["updates"],
      link: "https://mail.google.com/mail/u/0/#all/t-m1",
    });
    const reads = fake.calls.filter(({ url }) => url.includes("/messages/"));
    expect(reads).toHaveLength(2);
    expect(reads.every(({ url }) => url.includes("format=full"))).toBe(true);
    expect(result.items.map(({ body, bodyUnavailable }) => ({ body, bodyUnavailable }))).toEqual([
      { body: "body m1", bodyUnavailable: false },
      { body: "body m2", bodyUnavailable: false },
    ]);
  });

  it("[PG-11] falls back to the last three days when the history id is too old", async () => {
    const fake = google({ history: 404 });
    const reader = flatMailReader(
      createGmailReader({ oauth: oauth(fake.fetch), fetch: fake.fetch }),
    );
    const result = await reader.fetch(input("1"));
    expect(result).toMatchObject({ kind: "items", cursor: "777" });
    const list = fake.calls.find(({ url }) => /\/messages\?/u.test(url));
    expect(new URL(list?.url ?? "https://x").searchParams.get("q")).toBe(
      `after:${Date.parse("2026-11-01T01:00:00.000Z") / 1000}`,
    );
    if (result.kind !== "items") throw new Error("expected items");
    expect(result.items.map(({ messageId, categories }) => [messageId, categories])).toEqual([
      ["m1", ["updates"]],
      ["m3", ["promotions"]],
    ]);
  });

  it("[PG-11] reports a revoked refresh token as unauthorized", async () => {
    const fake = google({ grant: "invalid" });
    const reader = flatMailReader(
      createGmailReader({ oauth: oauth(fake.fetch), fetch: fake.fetch }),
    );
    expect(await reader.fetch(input("500"))).toEqual({ kind: "unauthorized" });
  });

  it("[PG-11] asks for offline read-only access and revokes the token", async () => {
    const fake = fakeGoogle((url) =>
      url.pathname === "/revoke"
        ? json({})
        : json({
            refresh_token: "refresh-new",
            access_token: "access-new",
            scope: `${GMAIL_READONLY_SCOPE} ${CALENDAR_READONLY_SCOPE}`,
          }),
    );
    const client = oauth(fake.fetch);
    const url = new URL(client.authorizationUrl("state-1"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "client-1",
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      state: "state-1",
      scope: `${GMAIL_READONLY_SCOPE} ${CALENDAR_READONLY_SCOPE}`,
    });
    expect(await client.exchange("code-1")).toMatchObject({
      refreshToken: "refresh-new",
      accessToken: "access-new",
    });
    expect(fake.calls[0]?.body).toContain("grant_type=authorization_code");
    expect(await client.revoke("refresh-new")).toBe(true);
    expect(fake.calls[1]).toMatchObject({ url: "https://oauth2.googleapis.com/revoke" });
  });

  it("[P6-demo] [reverse] the real OAuth client never sends a fake inbox token to Google", async () => {
    const fake = fakeGoogle(() => json({}));
    const client = oauth(fake.fetch);
    expect(await client.revoke("demo-inbox:v1:ja:2026-11-04T01:00:00.000Z")).toBe(true);
    expect(fake.calls).toEqual([]);
    expect(await client.revoke("refresh-real")).toBe(true);
    expect(fake.calls).toHaveLength(1);
  });

  it("[PG-10] never calls the Calendar API or any Gmail write endpoint", async () => {
    const fake = google();
    const reader = flatMailReader(
      createGmailReader({ oauth: oauth(fake.fetch), fetch: fake.fetch }),
    );
    await reader.fetch(input("500"));
    await reader.fetch(input(null));
    expect(fake.calls.length).toBeGreaterThan(0);
    for (const call of fake.calls) {
      expect(call.url).not.toContain("calendar");
      if (call.url.startsWith("https://gmail.googleapis.com/")) expect(call.method).toBe("GET");
    }
  });

  it("[PG-11] reads the connected account address from the Gmail profile", async () => {
    const fake = fakeGoogle((url, call) =>
      url.pathname.endsWith("/profile") && call.authorization === "Bearer access-new"
        ? json({ emailAddress: "Andy@Example.com", historyId: "1" })
        : json({}, 401),
    );
    expect(await readGmailAccount({ accessToken: "access-new", fetch: fake.fetch })).toBe(
      "andy@example.com",
    );
    await expect(readGmailAccount({ accessToken: "wrong", fetch: fake.fetch })).rejects.toThrow(
      "GOOGLE_UNAUTHORIZED",
    );
  });

  it("[PG-11] drops drafts and archived mail and parses sender addresses", () => {
    expect(gmailItem(message("m5", ["DRAFT", "SENT"]))).toBeUndefined();
    expect(gmailItem(message("m6", ["CATEGORY_UPDATES"]))).toBeUndefined();
    expect(senderAddress('"区役所" <Info@City.Shinjuku.LG.JP>')).toBe("info@city.shinjuku.lg.jp");
    expect(senderAddress("plain@example.com")).toBe("plain@example.com");
  });
});
