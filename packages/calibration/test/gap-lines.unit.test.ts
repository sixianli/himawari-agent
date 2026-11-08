import { describe, expect, it } from "vitest";
import {
  attributeGap,
  isGapCase,
  type MailJudgment,
  type MuseEntryRow,
  mailTruth,
  pairedDifferenceInterval,
  summarizeGap,
} from "../src/index.js";

const entry = (
  mail: string,
  reminded: boolean,
  extra: Partial<MuseEntryRow> = {},
): MuseEntryRow => ({
  museReminded: reminded,
  timingOk: reminded ? true : null,
  contentOk: reminded ? true : null,
  pairedMessageId: mail,
  ...extra,
});

function world(
  rows: readonly (readonly [boolean, string, MailJudgment["ownerRating"]])[],
): [MuseEntryRow[], Map<string, MailJudgment>] {
  const entries: MuseEntryRow[] = [];
  const judgments = new Map<string, MailJudgment>();
  rows.forEach(([museReminded, outcome, ownerRating], index) => {
    entries.push(entry(`m${index}`, museReminded));
    judgments.set(`m${index}`, { outcome, ownerRating });
  });
  return [entries, judgments];
}

describe("[PA-4] 差距线", () => {
  it("真值只取主人的评价，未评的邮件不进差距线", () => {
    expect(mailTruth({ outcome: "act", ownerRating: "useful" })).toBe("shouldRemind");
    expect(mailTruth({ outcome: "act", ownerRating: "unneeded" })).toBe("shouldNot");
    expect(mailTruth({ outcome: "ignore", ownerRating: "missed" })).toBe("shouldRemind");
    expect(mailTruth({ outcome: "ignore", ownerRating: "useful" })).toBe("shouldNot");
    expect(mailTruth({ outcome: "act", ownerRating: null })).toBeNull();
  });

  it("样本不足时不下结论", () => {
    const [entries, judgments] = world([
      [true, "ignore", "missed"],
      [true, "act", "useful"],
    ]);
    const gap = summarizeGap(entries, judgments, 5);
    expect(gap.lines[0].verdict).toBe("insufficient");
    expect(gap.lines[0].direction).toBe("none");
    expect(gap.lines[0].difference).toBeNull();
    expect(gap.lines[0].mails).toBe(2);
  });

  it("样本够且区间不含 0 时给出方向，命中率和多余提醒率分别算", () => {
    const rows: (readonly [boolean, string, MailJudgment["ownerRating"]])[] = [];
    for (let index = 0; index < 20; index += 1) rows.push([true, "ignore", "missed"]);
    for (let index = 0; index < 20; index += 1) rows.push([false, "ignore", "useful"]);
    const [entries, judgments] = world(rows);
    const gap = summarizeGap(entries, judgments, 5);
    expect(gap.lines[0].muse.reminded).toBe(20);
    expect(gap.lines[0].himawari.reminded).toBe(0);
    expect(gap.lines[0].verdict).toBe("decided");
    expect(gap.lines[0].direction).toBe("museHigher");
    expect(gap.lines[0].low as number).toBeGreaterThan(0);
    expect(gap.lines[1].muse.reminded).toBe(0);
    expect(gap.lines[1].direction).toBe("none");
  });

  it("两边一样好时区间跨 0，不下结论", () => {
    const rows: (readonly [boolean, string, MailJudgment["ownerRating"]])[] = [];
    for (let index = 0; index < 6; index += 1) rows.push([true, "act", "useful"]);
    for (let index = 0; index < 6; index += 1) rows.push([false, "ignore", "missed"]);
    const [entries, judgments] = world(rows);
    const line = summarizeGap(entries, judgments, 5).lines[0];
    expect(line.verdict).toBe("inconclusive");
    expect(line.direction).toBe("none");
  });

  it("没有 Himawari 记录或未配对的条目不进样本", () => {
    const entries = [entry("m1", true), entry("m2", true, { pairedMessageId: null })];
    const gap = summarizeGap(entries, new Map(), 5);
    expect(gap.pairedMails).toBe(0);
    expect(gap.ratedMails).toBe(0);
  });

  it("配对差区间在无差异时包含 0，在完全相反时不含 0", () => {
    const same = pairedDifferenceInterval(10, 0, 0, 10);
    expect(same?.difference).toBe(0);
    expect(same?.low as number).toBeLessThanOrEqual(0);
    expect(same?.high as number).toBeGreaterThanOrEqual(0);
    const apart = pairedDifferenceInterval(0, 20, 0, 0);
    expect(apart?.low as number).toBeGreaterThan(0);
    expect(pairedDifferenceInterval(0, 0, 0, 0)).toBeNull();
  });
});

describe("[PA-4] 案例入选和归因", () => {
  it("只有 Muse 提醒、Himawari 没提醒，且 Muse 时机内容都对或主人评该做没做，才入选", () => {
    const silent: MailJudgment = { outcome: "ignore", ownerRating: null };
    expect(isGapCase(entry("a", true), silent)).toBe(true);
    expect(isGapCase(entry("a", true, { contentOk: false }), silent)).toBe(false);
    expect(
      isGapCase(entry("a", true, { contentOk: false }), {
        outcome: "ignore",
        ownerRating: "missed",
      }),
    ).toBe(true);
    expect(isGapCase(entry("a", false), silent)).toBe(false);
    expect(isGapCase(entry("a", true), { outcome: "act", ownerRating: "useful" })).toBe(false);
  });

  it("配对差区间在两种方只在一方有提醒（负相关）时仍包住差值", () => {
    const opposite = pairedDifferenceInterval(1, 9, 9, 1);
    expect(opposite).not.toBeNull();
    if (opposite === null) return;
    expect(opposite.low).toBeLessThanOrEqual(opposite.difference);
    expect(opposite.high).toBeGreaterThanOrEqual(opposite.difference);
    expect(opposite.high - opposite.low).toBeGreaterThan(0);
  });

  it("配对差区间在强正相关（修正分支 e 大于 n/2）时给出有限且包住差值的区间", () => {
    const strong = pairedDifferenceInterval(20, 2, 1, 20);
    expect(strong).not.toBeNull();
    if (strong === null) return;
    expect(Number.isFinite(strong.low) && Number.isFinite(strong.high)).toBe(true);
    expect(strong.low).toBeLessThanOrEqual(strong.difference);
    expect(strong.high).toBeGreaterThanOrEqual(strong.difference);
    expect(strong.high - strong.low).toBeLessThan(0.25);
  });

  it("归因顺序：没读全 > 没取到 > 没记住 > 判断错", () => {
    const base = { relatedRead: "ok", memoryRecall: "ok", memoryHitsForMail: 2 };
    expect(attributeGap({ ...base, relatedRead: "partial" })).toBe("notReadFully");
    expect(attributeGap({ ...base, relatedRead: "failed", memoryRecall: "failed" })).toBe(
      "notReadFully",
    );
    expect(attributeGap({ ...base, memoryRecall: "failed" })).toBe("notRetrieved");
    expect(attributeGap({ ...base, memoryRecall: "off" })).toBe("notRetrieved");
    expect(attributeGap({ ...base, memoryHitsForMail: 0 })).toBe("notRemembered");
    expect(attributeGap(base)).toBe("wrongJudgment");
    expect(attributeGap({ relatedRead: null, memoryRecall: null, memoryHitsForMail: 0 })).toBe(
      "wrongJudgment",
    );
  });
});
