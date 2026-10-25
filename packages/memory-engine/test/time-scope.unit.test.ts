import { describe, expect, it } from "vitest";
import { parseTimeScope } from "../src/time-scope.ts";

const now = "2026-10-25T03:00:00.000Z";

describe("time scope parsing", () => {
  it.each([
    ["上周三我和谁吃饭了", "2026-10-13T15:00:00.000Z", "2026-10-14T14:59:59.999Z"],
    ["去年三月我在做什么", "2025-02-28T15:00:00.000Z", "2025-03-31T14:59:59.999Z"],
    ["2025年5月去了哪里", "2025-04-30T15:00:00.000Z", "2025-05-31T14:59:59.999Z"],
    ["10月3日我去哪了", "2026-10-02T15:00:00.000Z", "2026-10-03T14:59:59.999Z"],
    ["上个月忙什么", "2026-08-31T15:00:00.000Z", "2026-09-30T14:59:59.999Z"],
    ["三天前聊了什么", "2026-10-21T15:00:00.000Z", "2026-10-22T14:59:59.999Z"],
    ["昨天聊了什么", "2026-10-23T15:00:00.000Z", "2026-10-24T14:59:59.999Z"],
    ["两个月前在忙什么", "2026-07-31T15:00:00.000Z", "2026-08-31T14:59:59.999Z"],
    ["十二月有什么安排", "2025-11-30T15:00:00.000Z", "2025-12-31T14:59:59.999Z"],
  ])("resolves %s in the Owner's time zone", (query, from, to) => {
    expect(parseTimeScope(query, now, "Asia/Tokyo")).toMatchObject({
      includeHistory: true,
      from,
      to,
    });
  });

  it("looks ahead without history for a future window", () => {
    expect(parseTimeScope("下周要去哪", now, "Asia/Tokyo")).toMatchObject({
      includeHistory: false,
      from: "2026-10-25T15:00:00.000Z",
      to: "2026-11-01T14:59:59.999Z",
    });
  });

  it("keeps ended facts for a window that has already begun", () => {
    expect(parseTimeScope("这个月初我去首尔干什么", now, "Asia/Tokyo")).toMatchObject({
      includeHistory: true,
      from: "2026-09-30T15:00:00.000Z",
      to: "2026-10-31T14:59:59.999Z",
    });
    expect(parseTimeScope("今年夏天我早上做什么运动", now, "Asia/Tokyo")).toMatchObject({
      includeHistory: true,
    });
  });

  it("asks for history without a window when the Owner says 以前", () => {
    expect(parseTimeScope("我以前用什么手机？", now, "Asia/Tokyo")).toEqual({
      includeHistory: true,
      from: null,
      to: null,
      matched: ["以前"],
    });
  });

  it("returns nothing for a question about the present", () => {
    expect(parseTimeScope("我现在多重？", now, "Asia/Tokyo")).toBeNull();
    expect(parseTimeScope("我在大阪吗？", now, "Asia/Tokyo")).toBeNull();
    expect(parseTimeScope("我一个月存多少钱", now, "Asia/Tokyo")).toBeNull();
  });
});
