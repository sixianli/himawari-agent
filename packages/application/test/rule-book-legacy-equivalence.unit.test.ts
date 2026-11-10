import { describe, expect, it } from "vitest";
import type { ProactiveQuietPeriod, ProactiveSourceItem } from "../src/ports/proactive-checks.js";
import { ruleBookFor } from "../src/rules/rule-book.js";
import { floorHitIds, quietEnd, quietUntil } from "../src/services/proactive-rules.js";

const LEGACY_MONEY_WORDS =
  /收费|扣款|入账|付款|退款|账单|缴费|汇款|转账|还款|发票|請求|引落|引き落とし|振込|振り込み|入金|返金|支払|料金|決済|ご利用代金|\b(?:invoice|payment|refund|billing|bill|charged?|receipt|statement)\b/iu;
const LEGACY_PUBLIC_SUFFIXES = ["go.jp", "lg.jp", "ac.jp", "ed.jp"];

function legacyDomain(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

function legacyImportantSender(address: string, senders: readonly string[]): boolean {
  const lower = address.toLowerCase();
  const domain = legacyDomain(lower);
  return senders.some((entry) => {
    const wanted = entry.trim().toLowerCase().replace(/^@/u, "");
    if (!wanted) return false;
    if (wanted.includes("@")) return lower === wanted;
    return domain === wanted || domain.endsWith(`.${wanted}`);
  });
}

function legacyFloorHitIds(item: ProactiveSourceItem, senders: readonly string[]): string[] {
  const domain = legacyDomain(item.fromAddress);
  const hits: string[] = [];
  if (legacyImportantSender(item.fromAddress, senders)) hits.push("floor_important_sender");
  if (LEGACY_PUBLIC_SUFFIXES.some((suffix) => domain === suffix || domain.endsWith(`.${suffix}`)))
    hits.push("floor_public_domain");
  if (LEGACY_MONEY_WORDS.test(`${item.subject}\n${item.snippet}`)) hits.push("floor_money_words");
  return hits;
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const ADDRESSES = [
  "boss@corp.example.com",
  "Boss@Corp.Example.com",
  "someone@city.tokyo.lg.jp",
  "a@go.jp",
  "a@ago.jp",
  "a@x.ac.jp",
  "a@ed.jp.evil.com",
  "a@example.com",
  "a@sub.example.com",
  "a@notexample.com",
  "no-at-sign",
  "a@b@example.com",
  "@example.com",
  "",
];
const SENDERS = [
  "example.com",
  "@example.com",
  " EXAMPLE.com ",
  "boss@corp.example.com",
  "a@go.jp",
  "",
  "   ",
  "@",
  "corp.example.com",
  "jp",
  "evil.com",
];
const FRAGMENTS = [
  "Invoice",
  "INVOICE #12",
  "invoices",
  "billing",
  "billingual",
  "bill",
  "bills",
  "unbilled",
  "charge",
  "charged",
  "charges",
  "receipt",
  "Receipts",
  "statement",
  "statements",
  "payment",
  "payments",
  "refund",
  "refunded",
  "_payment_",
  "payment_id",
  "支払いのお知らせ",
  "ご利用代金のお知らせ",
  "引き落とし",
  "引落",
  "振込完了",
  "本月账单",
  "发票已开",
  "Lunch on Friday",
  "see you there",
  "ſtatement",
  "ſtatements",
  "Kill",
  "İnvoice",
  "invoice-2026",
  "bill.",
  "(refund)",
  "",
  "\n",
];

function pick<T>(values: readonly T[], next: () => number): T {
  return values[Math.floor(next() * values.length)] as T;
}

describe("rule book against the pre-rule-book implementation", () => {
  it("[HR-1] gives the same floor hits, in the same order, as the old hard-coded checks on 20000 random mails", () => {
    const next = random(20261110);
    for (let index = 0; index < 20_000; index++) {
      const senders = Array.from({ length: Math.floor(next() * 4) }, () => pick(SENDERS, next));
      const subject = Array.from({ length: Math.floor(next() * 3) }, () =>
        pick(FRAGMENTS, next),
      ).join(pick([" ", "", "　", "-"], next));
      const snippet = Array.from({ length: Math.floor(next() * 3) }, () =>
        pick(FRAGMENTS, next),
      ).join(" ");
      const item = {
        fromAddress: pick(ADDRESSES, next),
        subject,
        snippet,
      } as ProactiveSourceItem;
      const rules = ruleBookFor({
        quietHours: [],
        quietHoursRevision: 1,
        importantSenders: senders,
        importantSendersRevision: 1,
      });
      expect(floorHitIds(item, rules), JSON.stringify({ item, senders })).toEqual(
        legacyFloorHitIds(item, senders),
      );
    }
  });

  it("[HR-1] has no floor hit when the old checks have none, for a mail that matches nothing", () => {
    const rules = ruleBookFor({
      quietHours: [],
      quietHoursRevision: 1,
      importantSenders: [],
      importantSendersRevision: 1,
    });
    const item = {
      fromAddress: "friend@example.com",
      subject: "Lunch on Friday",
      snippet: "see you there",
    } as ProactiveSourceItem;
    expect(floorHitIds(item, rules)).toEqual([]);
  });

  const PERIOD_SETS: readonly (readonly ProactiveQuietPeriod[])[] = [
    [{ days: [0, 1, 2, 3, 4, 5, 6], start: "23:00", end: "07:00" }],
    [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:30" }],
    [{ days: [5, 6], start: "22:15", end: "06:45" }],
    [
      { days: [0, 1, 2, 3, 4, 5, 6], start: "23:00", end: "07:00" },
      { days: [0, 1, 2, 3, 4, 5, 6], start: "07:00", end: "08:00" },
    ],
    [
      { days: [2], start: "12:00", end: "13:00" },
      { days: [2], start: "13:00", end: "14:00" },
      { days: [3], start: "00:00", end: "02:00" },
    ],
    [],
  ];

  for (const timeZone of ["Asia/Tokyo", "America/New_York", "Europe/London"]) {
    it(`[HR-1] decides and ends quiet hours exactly as the old calculation in ${timeZone}, every 29 minutes over three weeks, across daylight-saving changes`, () => {
      const start = Date.parse("2026-03-01T00:00:00.000Z");
      for (const periods of PERIOD_SETS) {
        const rules = ruleBookFor({
          quietHours: periods,
          quietHoursRevision: 1,
          importantSenders: [],
          importantSendersRevision: 1,
        });
        for (let minute = 0; minute < 21 * 24 * 60; minute += 29) {
          const at = new Date(start + minute * 60_000 + 17_000).toISOString();
          expect(quietEnd(at, rules, periods, timeZone), `${timeZone} ${at}`).toBe(
            quietUntil(at, periods, timeZone),
          );
        }
      }
    }, 60_000);
  }
});
