import { flatMailReader, type ProactiveMail } from "@himawari-agent/application";
import { describe, expect, it } from "vitest";
import {
  counterparts,
  findRelatedMail,
  type GmailRelatedTransport,
  normalizeSubject,
} from "../src/gmail-related.ts";
import { createGmailReader, gmailItem } from "../src/gmail-source.ts";

function item(id: string, overrides: Partial<ProactiveMail> = {}): ProactiveMail {
  return {
    source: "gmail",
    messageId: id,
    threadId: `t-${id}`,
    from: "Shop <shop@example.com>",
    fromAddress: "shop@example.com",
    subject: "ご注文について",
    snippet: "",
    link: "",
    receivedAt: "2026-11-01T00:00:00.000Z",
    categories: [],
    sentByOwner: false,
    body: null,
    bodyTruncated: false,
    bodyUnavailable: false,
    attachments: [],
    participants: ["shop@example.com", "andy@example.com"],
    ...overrides,
  };
}

const limits = { perMail: 6, requestsPerCheck: 100, wholeThreadPerMail: 50 };

function mailbox(
  mails: readonly ProactiveMail[],
  hooks: { onRequest?: () => void; failThread?: boolean } = {},
): GmailRelatedTransport {
  return {
    async thread(threadId) {
      hooks.onRequest?.();
      if (hooks.failThread) throw new Error("THREAD_DOWN");
      return mails.filter((mail) => mail.threadId === threadId);
    },
    async search(query) {
      hooks.onRequest?.();
      const needle = (/"([^"]+)"/u.exec(query)?.[1] ?? "").toLowerCase();
      return mails
        .filter((mail) => `${mail.subject}\n${mail.body ?? ""}`.toLowerCase().includes(needle))
        .map(({ messageId }) => messageId);
    },
    async message(id) {
      hooks.onRequest?.();
      return mails.find(({ messageId }) => messageId === id);
    },
  };
}

describe("[PA-1] finding the earlier mails about the same matter", () => {
  it("strips reply and forward prefixes in the languages the owner uses", () => {
    expect(normalizeSubject("Re: RE：Fwd: 注文のご確認")).toBe("注文のご確認");
    expect(normalizeSubject("回复：转发：  Your   Order")).toBe("your order");
    expect(normalizeSubject("返信: 予約のお知らせ")).toBe("予約のお知らせ");
  });

  it("uses the other side as the counterpart for the owner's own mail", () => {
    expect(counterparts(item("a"))).toEqual(["shop@example.com"]);
    expect(
      counterparts(
        item("b", {
          sentByOwner: true,
          fromAddress: "andy@example.com",
          participants: ["andy@example.com", "shop@example.com"],
        }),
      ),
    ).toEqual(["shop@example.com"]);
  });

  it("joins the same thread, the same subject with the same people, and the same order number", async () => {
    const current = item("now", {
      subject: "お客様のご注文について",
      body: "注文番号 250-1234567-8901234 の件",
    });
    const sameThread = item("in-thread", { threadId: "t-now", subject: "別の題" });
    const sameSubject = item("by-subject", {
      subject: "Re: お客様のご注文について",
      receivedAt: "2026-10-30T00:00:00.000Z",
    });
    const sameOrder = item("by-order", {
      subject: "返金のご案内",
      body: "ご注文 250-1234567-8901234 の返金",
      from: "Other <other@example.org>",
      fromAddress: "other@example.org",
      participants: ["other@example.org"],
      receivedAt: "2026-10-29T00:00:00.000Z",
    });
    const sameSubjectStranger = item("stranger", {
      subject: "お客様のご注文について",
      from: "X <x@example.net>",
      fromAddress: "x@example.net",
      participants: ["x@example.net"],
    });
    const unrelated = item("unrelated", {
      subject: "新商品",
      receivedAt: "2026-10-01T00:00:00.000Z",
    });
    const result = await findRelatedMail({
      items: [current],
      references: new Map([["now", ["250-1234567-8901234"]]]),
      limits,
      signal: new AbortController().signal,
      transport: mailbox([
        current,
        sameThread,
        sameSubject,
        sameOrder,
        sameSubjectStranger,
        unrelated,
      ]),
    });
    expect(result.byMail.get("now")?.map(({ messageId }) => messageId)).toEqual([
      "by-order",
      "by-subject",
      "in-thread",
    ]);
    expect(result.failed.size).toBe(0);
  });

  it("only joins mail that arrived strictly before the new mail, never a newer one from the same thread", async () => {
    const earlier = item("a", { threadId: "t-x", receivedAt: "2026-11-01T00:00:00.000Z" });
    const later = item("b", { threadId: "t-x", receivedAt: "2026-11-02T00:00:00.000Z" });
    const result = await findRelatedMail({
      items: [earlier, later],
      limits,
      signal: new AbortController().signal,
      transport: mailbox([earlier, later]),
    });
    expect(result.byMail.get("a")).toEqual([]);
    expect(result.byMail.get("b")?.map(({ messageId }) => messageId)).toEqual(["a"]);
  });

  it("does not join a mail that only contains the number inside a longer one", async () => {
    const current = item("now", { body: "注文番号 12345678 の件" });
    const longer = item("longer", { subject: "別件", body: "参照 912345678901 です" });
    const exact = item("exact", { subject: "別件2", body: "ご注文 12345678 を発送" });
    const result = await findRelatedMail({
      items: [current],
      references: new Map([["now", ["12345678"]]]),
      limits,
      signal: new AbortController().signal,
      transport: mailbox([current, longer, exact]),
    });
    expect(result.byMail.get("now")?.map(({ messageId }) => messageId)).toEqual(["exact"]);
    const dashed = item("dashed", { subject: "別件3", body: "ご注文 12345678-の件" });
    const again = await findRelatedMail({
      items: [current],
      references: new Map([["now", ["12345678"]]]),
      limits,
      signal: new AbortController().signal,
      transport: mailbox([current, dashed]),
    });
    expect(again.byMail.get("now")?.map(({ messageId }) => messageId)).toEqual(["dashed"]);
  });

  it("does not trust a search hit that does not really contain the number", async () => {
    const current = item("now", { body: "注文番号 250-1234567-8901234" });
    const fuzzy = item("fuzzy", { subject: "無関係", body: "250 1234567 8901234" });
    const transport: GmailRelatedTransport = {
      ...mailbox([current, fuzzy]),
      async search() {
        return ["fuzzy"];
      },
    };
    const result = await findRelatedMail({
      items: [current],
      references: new Map([["now", ["250-1234567-8901234"]]]),
      limits,
      signal: new AbortController().signal,
      transport,
    });
    expect(result.byMail.get("now")).toEqual([]);
  });

  it("keeps only the newest mails when there are more than the limit", async () => {
    const thread = Array.from({ length: 9 }, (_, index) =>
      item(`old-${index}`, {
        threadId: "t-now",
        receivedAt: `2026-10-0${index + 1}T00:00:00.000Z`,
      }),
    );
    const result = await findRelatedMail({
      items: [item("now")],
      limits: { perMail: 3, requestsPerCheck: 100, wholeThreadPerMail: 50 },
      signal: new AbortController().signal,
      transport: mailbox([item("now"), ...thread]),
    });
    expect(result.byMail.get("now")?.map(({ messageId }) => messageId)).toEqual([
      "old-6",
      "old-7",
      "old-8",
    ]);
  });

  it("[P2-3] reads the whole thread, later replies included, for a mail an owner rule names", async () => {
    const thread = Array.from({ length: 9 }, (_, index) =>
      item(`old-${index}`, {
        threadId: "t-now",
        receivedAt: `2026-10-0${index + 1}T00:00:00.000Z`,
      }),
    );
    const later = item("later", { threadId: "t-now", receivedAt: "2026-11-02T00:00:00.000Z" });
    const junk = item("junk", { threadId: "t-now", categories: ["spam"] });
    const run = (wholeThreadPerMail: number) =>
      findRelatedMail({
        items: [item("now")],
        limits: { perMail: 3, requestsPerCheck: 100, wholeThreadPerMail },
        wholeThread: new Set(["now"]),
        signal: new AbortController().signal,
        transport: mailbox([item("now"), ...thread, later, junk]),
      });
    const full = await run(50);
    expect(full.byMail.get("now")?.map(({ messageId }) => messageId)).toEqual([
      ...thread.map(({ messageId }) => messageId),
      "later",
    ]);
    expect(full.wholeThread?.get("now")).toEqual({
      messageIds: [...thread.map(({ messageId }) => messageId), "later"],
      complete: true,
    });
    const cut = await run(4);
    expect(cut.wholeThread?.get("now")?.complete).toBe(false);
    expect(cut.byMail.get("now")?.map(({ messageId }) => messageId)).toEqual([
      "old-6",
      "old-7",
      "old-8",
      "later",
    ]);
  });

  it("[P2-3] REVERSE: reports the thread incomplete when the thread lookup fails, and leaves other mails at the usual limit", async () => {
    const now = item("now");
    const down = await findRelatedMail({
      items: [now],
      limits,
      wholeThread: new Set(["now"]),
      signal: new AbortController().signal,
      transport: mailbox([now], { failThread: true }),
    });
    expect(down.wholeThread?.get("now")?.complete).not.toBe(true);
    const gone = await findRelatedMail({
      items: [now],
      limits,
      wholeThread: new Set(["now"]),
      signal: new AbortController().signal,
      transport: { ...mailbox([now]), thread: async () => undefined },
    });
    expect(gone.wholeThread?.get("now")?.complete).toBe(false);
    const other = await findRelatedMail({
      items: [item("now")],
      limits: { perMail: 2, requestsPerCheck: 100, wholeThreadPerMail: 50 },
      wholeThread: new Set(["elsewhere"]),
      signal: new AbortController().signal,
      transport: mailbox([
        item("now"),
        item("a", { threadId: "t-now", receivedAt: "2026-10-01T00:00:00.000Z" }),
        item("b", { threadId: "t-now", receivedAt: "2026-10-02T00:00:00.000Z" }),
        item("c", { threadId: "t-now", receivedAt: "2026-10-03T00:00:00.000Z" }),
      ]),
    });
    expect(other.byMail.get("now")?.map(({ messageId }) => messageId)).toEqual(["b", "c"]);
    expect(other.wholeThread?.size).toBe(0);
  });

  it("marks the mail failed and keeps going when one lookup throws or the budget runs out", async () => {
    const now = item("now");
    const next = item("next", { threadId: "t-next" });
    const down = await findRelatedMail({
      items: [now],
      limits,
      signal: new AbortController().signal,
      transport: mailbox([now], { failThread: true }),
    });
    expect(down.failed.get("now")).toBe("thread");
    const tight = await findRelatedMail({
      items: [now, next],
      limits: { perMail: 6, requestsPerCheck: 1, wholeThreadPerMail: 50 },
      signal: new AbortController().signal,
      transport: mailbox([now, next]),
    });
    expect(tight.failed.get("next")).toBe("budget");
    expect(tight.requests).toBe(1);
  });

  it("marks every remaining mail failed with timeout when the check is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await findRelatedMail({
      items: [item("a"), item("b")],
      limits,
      signal: controller.signal,
      transport: mailbox([]),
    });
    expect([...result.failed.entries()]).toEqual([
      ["a", "timeout"],
      ["b", "timeout"],
    ]);
  });
});

describe("[PA-1] Gmail wiring", () => {
  const raw = (id: string, labels: string[], subject: string, to = "andy@example.com") => ({
    id,
    threadId: "t-1",
    labelIds: labels,
    snippet: "",
    internalDate: String(Date.parse("2026-10-30T00:00:00.000Z")),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "Shop <shop@example.com>" },
        { name: "To", value: to },
        { name: "Subject", value: subject },
      ],
      body: { size: 4, data: Buffer.from("body").toString("base64url") },
    },
  });

  it("collects the people on a mail and, for history, accepts archived mail but not spam or trash", () => {
    const archived = raw("a", [], "x");
    expect(gmailItem(archived)).toBeUndefined();
    expect(gmailItem(archived, { history: true })?.participants).toEqual([
      "shop@example.com",
      "andy@example.com",
    ]);
    expect(gmailItem(raw("b", ["TRASH"], "x"), { history: true })).toBeUndefined();
    expect(gmailItem(raw("c", ["SPAM"], "x"), { history: true })).toBeUndefined();
    expect(gmailItem(raw("d", ["DRAFT"], "x"), { history: true })).toBeUndefined();
  });

  it("reads the thread with the read-only token and returns archived mail from it", async () => {
    const urls: string[] = [];
    const fetch = async (url: string, init: RequestInit) => {
      urls.push(url);
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer access-1");
      const path = new URL(url).pathname;
      if (path.includes("/threads/"))
        return new Response(
          JSON.stringify({
            messages: [raw("old", [], "返金について"), raw("new", ["INBOX"], "Re: 返金について")],
          }),
          { status: 200 },
        );
      return new Response(JSON.stringify({}), { status: 200 });
    };
    const reader = flatMailReader(
      createGmailReader({
        oauth: { accessToken: async () => "access-1" },
        fetch,
      }),
    );
    const current = item("new", { threadId: "t-1", subject: "Re: 返金について" });
    const result = await reader.related?.({
      token: "refresh",
      items: [current],
      limits,
      signal: new AbortController().signal,
    });
    expect(result?.byMail.get("new")?.map(({ messageId }) => messageId)).toEqual(["old"]);
    expect(urls[0]).toContain("/threads/t-1?format=full");
    expect(urls.every((url) => !/(modify|send|delete)/u.test(url))).toBe(true);
  });
});
