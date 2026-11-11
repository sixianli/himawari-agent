import { describe, expect, it } from "vitest";
import { dropSameSourceDuplicates, nearDuplicateText } from "../src/services/same-source-dedupe.ts";

describe("near-duplicate text", () => {
  it("treats wording that differs only in punctuation, width and case as the same", () => {
    expect(nearDuplicateText("主人的妻子叫苏晴。", "主人的妻子叫苏晴")).toBe(true);
    expect(nearDuplicateText("Owner likes Green tea!", "owner likes green tea")).toBe(true);
  });

  it("treats two different facts from one sentence as different", () => {
    expect(nearDuplicateText("主人的妻子叫苏晴", "主人的女儿叫小禾")).toBe(false);
  });

  it("never merges texts whose numbers differ, however long and similar", () => {
    const long =
      "主人每周三晚上去健身房锻炼一个小时，主要练力量和有氧，结束后会喝一杯蛋白粉，已经坚持了很久。".repeat(
        6,
      );
    expect(nearDuplicateText(`${long}会员卡号 1234`, `${long}会员卡号 1235`)).toBe(false);
    expect(nearDuplicateText(`${long}会员卡号 1234`, `${long}会员卡号 1234。`)).toBe(true);
  });

  it("never merges texts whose sign or Chinese numerals differ", () => {
    const long =
      "主人在招商银行的储蓄账户里记了一笔这个月的家庭开销，备注是给父母买的体检套餐".repeat(4);
    expect(nearDuplicateText(`${long}余额 -500 元`, `${long}余额 500 元`)).toBe(false);
    expect(nearDuplicateText(`${long}，买了两份`, `${long}，买了三份`)).toBe(false);
    expect(nearDuplicateText(`${long}，买了两份`, `${long}，买了两份。`)).toBe(true);
    expect(nearDuplicateText(`${long}余额-三百元`, `${long}余额三百元`)).toBe(false);
    expect(nearDuplicateText(`${long}余额-500 元`, `${long}余额 - 500 元`)).toBe(true);
  });

  it("does not call slightly different texts near duplicates when they fall below 0.9", () => {
    expect(nearDuplicateText("主人周末常去图书馆看书和写作", "主人周末常去咖啡馆看书和画画")).toBe(
      false,
    );
  });
});

describe("same-source duplicate removal", () => {
  const texts = new Map([
    ["wife-a", "主人的妻子叫苏晴。"],
    ["wife-b", "主人的妻子叫苏晴"],
    ["daughter", "主人的女儿叫小禾"],
    ["other", "主人住在大阪"],
  ]);
  const readText = async (ref: string) => {
    const text = texts.get(ref);
    if (text === undefined) throw new Error("MISSING");
    return text;
  };
  const item = (id: string, sourceRefs: readonly string[], contentRef = id) => ({
    id,
    sourceRefs,
    contentRef,
  });

  it("keeps the first of two near-identical memories from the same source and refills the slot", async () => {
    const kept = await dropSameSourceDuplicates(
      [
        item("wife-a", ["m1"]),
        item("wife-b", ["m1"]),
        item("daughter", ["m1"]),
        item("other", ["m2"]),
      ],
      3,
      readText,
    );
    expect(kept.map(({ id }) => id)).toEqual(["wife-a", "daughter", "other"]);
  });

  it("keeps identical text from different sources", async () => {
    const kept = await dropSameSourceDuplicates(
      [item("wife-a", ["m1"]), item("wife-b", ["m2"])],
      5,
      readText,
    );
    expect(kept.map(({ id }) => id)).toEqual(["wife-a", "wife-b"]);
  });

  it("keeps both when one text cannot be read", async () => {
    const kept = await dropSameSourceDuplicates(
      [item("wife-a", ["m1"]), item("missing", ["m1"])],
      5,
      readText,
    );
    expect(kept.map(({ id }) => id)).toEqual(["wife-a", "missing"]);
  });

  it("does not read any text when no two candidates share a source", async () => {
    let reads = 0;
    await dropSameSourceDuplicates(
      [item("wife-a", ["m1"]), item("daughter", ["m2"])],
      5,
      async (ref) => {
        reads += 1;
        return readText(ref);
      },
    );
    expect(reads).toBe(0);
  });
});
