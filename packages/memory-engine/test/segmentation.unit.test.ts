import { describe, expect, it } from "vitest";
import { indexTerms, queryTerms, segmentWords } from "../src/segmentation.ts";

describe("Chinese memory segmentation", () => {
  it("splits Chinese text into words with Intl.Segmenter", () => {
    expect(segmentWords("主人对青霉素过敏，下个月要搬到杭州")).toEqual([
      "主人",
      "对",
      "青霉素",
      "过敏",
      "下个月",
      "要",
      "搬到",
      "杭州",
    ]);
  });

  it("adds Han bigrams for longer words so city names match with or without 市", () => {
    expect(indexTerms("主人住在杭州市")).toEqual(["主人", "住在", "杭州市", "杭州", "州市"]);
    expect(queryTerms("杭州")).toEqual(["杭州"]);
  });

  it("drops stopwords and the owner placeholder from queries", () => {
    expect(queryTerms("我女儿今年多大了？")).toEqual(["女儿", "今年", "多大"]);
    expect(queryTerms("主人是谁")).toEqual([]);
  });

  it("lowercases Latin words and normalizes full-width characters", () => {
    expect(queryTerms("ＨＥＲＭＥＳ 测试机")).toEqual(["hermes", "测试", "机"]);
  });
});
