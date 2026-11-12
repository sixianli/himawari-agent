import { rm } from "node:fs/promises";
import {
  type DemoLocale,
  DEMO_LOCALES,
  demoMailScript,
  demoMemories,
} from "@himawari-agent/domain";
import {
  buildDemoPack,
  DATA_EXPORT_ERROR_CODES,
  DataExportError,
  demoMemoryId,
  importPortableExport,
  LATEST_MIGRATION_SEQUENCE,
  parsePortable,
  readPortableDirectory,
  writePortableDirectory,
} from "@himawari-agent/persistence-sqlite";
import {
  createDataExportTextPolicy,
  createDemoGoogleOAuth,
  createGoogleOAuth,
  GoogleUnauthorizedError,
  createDemoMailReader,
  demoMailboxToken,
} from "@himawari-agent/platform-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDataCommand } from "../../apps/admin-cli/src/data-command.ts";
import { openSide, type Side } from "./data-export-fixture.ts";

const NOW = "2026-11-10T00:00:00.000Z";
const ANCHOR = "2026-11-10T01:00:00.000Z";
const HOUR = 3_600_000;
const sides: Side[] = [];
const decoder = new TextDecoder();
const JAPANESE = /[぀-ヿ一-鿿]/u;

afterEach(async () => {
  vi.restoreAllMocks();
  for (const side of sides.splice(0)) {
    side.database.close();
    await rm(side.directory, { recursive: true, force: true });
  }
});

async function target(suffix: string): Promise<Side> {
  const created = await openSide(suffix);
  sides.push(created);
  return created;
}

function importInto(side: Side, files: ReturnType<typeof buildDemoPack>["files"]) {
  return importPortableExport(files, {
    database: side.database,
    scope: { ownerId: side.ownerId, agentId: side.agentId },
    migrationSequence: side.migrationSequence,
    protector: side.protector,
    now: () => NOW,
  });
}

function texts(files: ReturnType<typeof buildDemoPack>["files"]): string {
  return [...files.values()].map((bytes) => decoder.decode(bytes)).join("\n");
}

describe("[P6-demo] demo memory pack", () => {
  for (const locale of DEMO_LOCALES) {
    it(`[P6-demo] the ${locale} pack passes the portable-format checks and imports into an empty database`, async () => {
      const { files, manifest } = buildDemoPack({
        locale,
        migrationSequence: LATEST_MIGRATION_SEQUENCE,
        now: () => NOW,
      });
      const parsed = parsePortable(files, LATEST_MIGRATION_SEQUENCE);
      expect(parsed.memories).toHaveLength(demoMemories(locale).length);
      expect(parsed.people).toHaveLength(3);
      expect(manifest.counts.markdownMemories).toBeGreaterThan(5);

      const side = await target(`pack-${locale}`);
      const report = await importInto(side, files);
      expect(report.imported.memories).toBe(parsed.memories.length);
      expect(report.skipped).toEqual({
        memoriesWithoutOriginal: 0,
        historyEventsWithoutOriginal: 0,
        decisionTextsWithoutOriginal: 0,
        rulesWithoutOriginal: 0,
        externalProposalsWithoutOriginal: 0,
        evidenceNotImported: false,
      });
      const count = (sql: string) => side.database.prepare(sql).pluck().get() as number;
      expect(count("SELECT COUNT(*) FROM memory_records")).toBe(parsed.memories.length);
      expect(count("SELECT COUNT(*) FROM memory_people")).toBe(3);
      expect(count("SELECT COUNT(*) FROM memory_records WHERE status = 'archived'")).toBe(1);
      expect(
        count("SELECT COUNT(*) FROM memory_records WHERE tentative = 1 AND inference = 1"),
      ).toBe(1);
      expect(
        count("SELECT COUNT(*) FROM memory_profile_pins WHERE pinned = 1"),
      ).toBeGreaterThanOrEqual(2);
      expect(
        side.database
          .prepare("SELECT superseded_by FROM memory_records WHERE id = ?")
          .pluck()
          .get(demoMemoryId(locale, "gym-old")),
      ).toBe(demoMemoryId(locale, "gym"));
    });

    it(`[P6-demo] the ${locale} pack refuses a second import into a database that already has memories`, async () => {
      const pack = buildDemoPack({
        locale,
        migrationSequence: LATEST_MIGRATION_SEQUENCE,
        now: () => NOW,
      });
      const side = await target(`twice-${locale}`);
      await importInto(side, pack.files);
      await expect(importInto(side, pack.files)).rejects.toMatchObject({
        code: DATA_EXPORT_ERROR_CODES.TARGET_NOT_EMPTY,
      });
    });

    it(`[P6-demo] [reverse] the ${locale} pack holds nothing that looks like a secret, a real address or the other language`, () => {
      const { files } = buildDemoPack({
        locale,
        migrationSequence: LATEST_MIGRATION_SEQUENCE,
        now: () => NOW,
      });
      const policy = createDataExportTextPolicy();
      const all = [
        ...demoMemories(locale).flatMap((memory) => [
          memory.text,
          ...memory.updates.map(({ text }) => text),
        ]),
        ...demoMailScript(locale, ANCHOR).flatMap((mail) => [mail.subject, mail.body]),
      ];
      for (const text of all) expect(policy.hasSecret(text)).toBe(false);
      const addresses = [
        ...texts(files).matchAll(/[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/gu),
        ...demoMailScript(locale, ANCHOR).flatMap((mail) => [
          mail.fromAddress.match(/@(.+)$/u) as RegExpMatchArray,
          ...mail.participants.map((address) => address.match(/@(.+)$/u) as RegExpMatchArray),
        ]),
      ];
      for (const match of addresses) expect(match[1]).toMatch(/\.example$/u);
      const memoryText = [...files]
        .filter(([path]) => path === "data/memories.jsonl" || path === "data/people.jsonl")
        .map(([, bytes]) => decoder.decode(bytes))
        .join("\n");
      const mailText = demoMailScript(locale, ANCHOR)
        .map((mail) => `${mail.subject}\n${mail.body}`)
        .join("\n");
      expect(JAPANESE.test(memoryText)).toBe(locale === "ja");
      expect(JAPANESE.test(mailText)).toBe(locale === "ja");
    });
  }

  it("[P6-demo] [reverse] a locale that is not offered is rejected without writing anything", () => {
    for (const locale of ["zh-CN", "", "JA", "../ja"])
      expect(() =>
        buildDemoPack({ locale, migrationSequence: LATEST_MIGRATION_SEQUENCE, now: () => NOW }),
      ).toThrow(DataExportError);
  });

  it("[P6-demo] gives the same bytes for the same moment and different dates for a different moment", () => {
    const build = (now: string) =>
      buildDemoPack({ locale: "en", migrationSequence: LATEST_MIGRATION_SEQUENCE, now: () => now });
    expect(texts(build(NOW).files)).toBe(texts(build(NOW).files));
    expect(texts(build("2026-12-01T00:00:00.000Z").files)).not.toBe(texts(build(NOW).files));
  });

  it("[P6-demo] the admin command writes a pack that the existing import command accepts", async () => {
    const side = await target("cli");
    const out = `${side.directory}/pack`;
    const lines: string[] = [];
    const result = (await runDataCommand(
      ["data", "demo-pack", "--locale", "ja", "--out", out],
      { write: (chunk: string) => lines.push(chunk) } as unknown as NodeJS.WritableStream,
      () => NOW,
    )) as { counts: { memories: number } };
    expect(result.counts.memories).toBe(demoMemories("ja").length);
    const files = await readPortableDirectory(out);
    expect((await importInto(side, files)).imported.memories).toBe(result.counts.memories);
    await expect(
      runDataCommand(["data", "demo-pack", "--locale", "fr", "--out", `${out}-2`], process.stdout),
    ).rejects.toBeInstanceOf(DataExportError);
    await expect(
      runDataCommand(["data", "demo-pack", "--locale", "ja"], process.stdout),
    ).rejects.toThrow("ADMIN_DATA_ARGUMENT_INVALID");
    await expect(writePortableDirectory(out, files)).rejects.toMatchObject({
      code: DATA_EXPORT_ERROR_CODES.TARGET_NOT_EMPTY,
    });
  });
});

describe("[P6-demo] fake inbox", () => {
  const fetchOnce = async (
    locale: DemoLocale,
    nowMs: number,
    cursor: string | null,
    seen: ReadonlySet<string> = new Set(),
  ) => {
    const reader = createDemoMailReader({ now: () => new Date(nowMs).toISOString() });
    return reader.fetch({
      token: demoMailboxToken(locale, ANCHOR),
      cursor,
      since: new Date(Date.parse(ANCHOR) - 72 * HOUR).toISOString(),
      signal: new AbortController().signal,
      unseen: async (ids) => ids.filter((id) => !seen.has(id)),
    });
  };

  it("[P6-demo] hands out mail only after its arrival time, once, and never mail from before the connection", async () => {
    const anchorMs = Date.parse(ANCHOR);
    const first = await fetchOnce("ja", anchorMs, null);
    if (first.kind !== "items") throw new Error("expected items");
    expect(first.items).toEqual([]);

    const second = await fetchOnce("ja", anchorMs + 40 * 60_000, first.cursor);
    if (second.kind !== "items") throw new Error("expected items");
    expect(second.items.map(({ messageId }) => messageId)).toEqual([
      "demo-ja-mockups",
      "demo-ja-delivery",
    ]);
    expect(second.items.every(({ receivedAt }) => Date.parse(receivedAt) >= anchorMs)).toBe(true);

    const third = await fetchOnce("ja", anchorMs + 40 * 60_000, second.cursor);
    if (third.kind !== "items") throw new Error("expected items");
    expect(third.items).toEqual([]);

    const withoutCursor = await fetchOnce(
      "ja",
      anchorMs + 40 * 60_000,
      null,
      new Set(["demo-ja-mockups"]),
    );
    if (withoutCursor.kind !== "items") throw new Error("expected items");
    expect(withoutCursor.items.map(({ messageId }) => messageId)).toEqual(["demo-ja-delivery"]);
  });

  it("[P6-demo] [reverse] mail dated after now is not visible and a token that is not a demo token is refused", async () => {
    const anchorMs = Date.parse(ANCHOR);
    const early = await fetchOnce("en", anchorMs + HOUR, null);
    if (early.kind !== "items") throw new Error("expected items");
    expect(early.items.map(({ messageId }) => messageId)).not.toContain("demo-en-feedback");
    expect(early.items.map(({ messageId }) => messageId)).not.toContain("demo-en-dinner");

    const reader = createDemoMailReader({ now: () => ANCHOR });
    for (const token of [
      "",
      "refresh-token-from-google",
      "demo-inbox:v1:fr:2026-11-10T01:00:00.000Z",
    ])
      expect(
        await reader.fetch({
          token,
          cursor: null,
          since: ANCHOR,
          signal: new AbortController().signal,
          unseen: async (ids) => ids,
        }),
      ).toEqual({ kind: "unauthorized" });
  });

  it("[P6-demo] over seven days every scripted mail arrives exactly once and has a sender at a reserved domain", async () => {
    const anchorMs = Date.parse(ANCHOR);
    for (const locale of DEMO_LOCALES) {
      const everything = await fetchOnce(locale, anchorMs + 7 * 24 * HOUR, null);
      if (everything.kind !== "items") throw new Error("expected items");
      const script = demoMailScript(locale, ANCHOR).filter((mail) => mail.offsetMinutes >= 0);
      expect(everything.items).toHaveLength(script.length);
      expect(new Set(everything.items.map(({ messageId }) => messageId)).size).toBe(script.length);
      for (const item of everything.items) {
        expect(item.fromAddress).toMatch(/\.example$/u);
        expect(item.link.startsWith("https://himawari.example/")).toBe(true);
      }
    }
  });

  it("[P6-demo] finds the earlier thread and the earlier mail that shares an order number, including mail from before the connection", async () => {
    const reader = createDemoMailReader({
      now: () => new Date(Date.parse(ANCHOR) + HOUR).toISOString(),
    });
    const fetched = await fetchOnce("en", Date.parse(ANCHOR) + HOUR, null);
    if (fetched.kind !== "items") throw new Error("expected items");
    const delivery = fetched.items.find(({ messageId }) => messageId === "demo-en-delivery");
    const mockups = fetched.items.find(({ messageId }) => messageId === "demo-en-mockups");
    if (!delivery || !mockups || !reader.related) throw new Error("expected mail");
    const related = await reader.related({
      token: demoMailboxToken("en", ANCHOR),
      items: [delivery, mockups],
      limits: { perMail: 6, requestsPerCheck: 300, wholeThreadPerMail: 50 },
      signal: new AbortController().signal,
    });
    expect(related.failed.size).toBe(0);
    expect(related.byMail.get(delivery.messageId)?.map(({ messageId }) => messageId)).toEqual([
      "demo-en-order",
    ]);
    expect(related.byMail.get(mockups.messageId)?.map(({ messageId }) => messageId)).toEqual([
      "demo-en-review-moved",
      "demo-en-review-ok",
    ]);
  });

  it("[P6-demo] [reverse] never touches the network, and its fake sign-in cannot be completed or revoked at Google", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await fetchOnce("ja", Date.parse(ANCHOR) + 24 * HOUR, null);
    const oauth = createDemoGoogleOAuth();
    expect(oauth.authorizationUrl("state")).toBe("/?settings=apps&gmail=demo");
    await expect(oauth.exchange("code")).rejects.toThrow("DEMO_MAILBOX_NO_OAUTH");
    expect(await oauth.revoke("token")).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("[P6-demo] review round 1 fixes", () => {
  it("[P6-demo] [reverse] the real Google sign-in refuses a fake-inbox token without any request", async () => {
    const spy = vi.fn();
    const oauth = createGoogleOAuth({
      clientId: "client-1",
      clientSecret: "secret",
      redirectUri: "https://himawari.example/cb",
      fetch: spy as never,
    });
    await expect(oauth.accessToken(demoMailboxToken("ja", ANCHOR))).rejects.toBeInstanceOf(
      GoogleUnauthorizedError,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("[P6-demo] writes dates as calendar days in the instance time zone, across a daylight-saving change", () => {
    const anchor = "2026-11-01T08:00:00.000Z";
    const invoice = (zone: string) =>
      demoMailScript("en", anchor, zone).find(({ key }) => key === "invoice")?.body ?? "";
    expect(invoice("America/Los_Angeles")).toContain("Payment due: Nov 6");
    expect(invoice("Asia/Tokyo")).toContain("Payment due: Nov 6");
    expect(invoice("Pacific/Kiritimati")).toContain("Payment due: Nov 7");
    const reader = createDemoMailReader({ now: () => anchor, timeZone: "Pacific/Kiritimati" });
    expect(reader.source).toBe("gmail");
  });
});
