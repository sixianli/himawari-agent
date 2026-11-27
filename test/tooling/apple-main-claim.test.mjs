import { describe, expect, it } from "vitest";
import {
  alreadyClaimed,
  claimComment,
  failedJobs,
  greenBase,
  isGreen,
  marker,
} from "../../scripts/ci/apple-main-claim.mjs";

const job = (name, conclusion) => ({ name, conclusion });
const prefixes = ["apple/iphone", "apple/scroll"];

describe("main 上苹果检查失败时找人认领", () => {
  it("只有每一类作业都真的跑过且全部成功才算通过，跳过的不算", () => {
    const all = [
      job("apple/changes", "success"),
      job("apple/iphone", "success"),
      job("apple/iphone-accessibility 0/3", "success"),
      job("apple/iphone-accessibility 1/3", "success"),
      job("apple/scroll", "success"),
    ];
    expect(isGreen(all, prefixes)).toBe(true);
    expect(
      isGreen(
        [
          job("apple/changes", "success"),
          job("apple/iphone", "skipped"),
          job("apple/scroll", "skipped"),
        ],
        prefixes,
      ),
    ).toBe(false);
    expect(isGreen([job("apple/changes", "success")], prefixes)).toBe(false);
    expect(
      isGreen(
        all.map((item) => (item.name.endsWith("1/3") ? job(item.name, "cancelled") : item)),
        prefixes,
      ),
    ).toBe(false);
  });

  it("从最近往前找上一次通过的提交，跳过本次运行和没跑 Mac 作业的运行", () => {
    const runs = [
      { id: 9, head_sha: "c".repeat(40), created_at: "2026-11-27T03:00:00Z" },
      { id: 8, head_sha: "b".repeat(40), created_at: "2026-11-27T02:00:00Z" },
      { id: 7, head_sha: "a".repeat(40), created_at: "2026-11-27T01:00:00Z" },
    ];
    const green = [job("apple/iphone", "success"), job("apple/scroll", "success")];
    const jobs = new Map([
      [9, green],
      [8, [job("apple/iphone", "skipped"), job("apple/scroll", "skipped")]],
      [7, green],
    ]);
    expect(greenBase(runs, jobs, prefixes, 9)).toBe("a".repeat(40));
    expect(greenBase(runs, jobs, prefixes, 10)).toBe("c".repeat(40));
    expect(greenBase(runs.slice(0, 2), jobs, prefixes, 9)).toBeNull();
  });

  it("只把失败或超时的被看作业列为失败，取消和其他工作流的作业不算", () => {
    expect(
      failedJobs(
        [
          job("apple/changes", "success"),
          job("apple/iphone", "success"),
          job("apple/iphone-accessibility 0/3", "failure"),
          job("apple/scroll", "timed_out"),
          job("apple/claim", "failure"),
          job("apple/iphone-accessibility 2/3", "cancelled"),
        ],
        prefixes,
      ),
    ).toEqual(["apple/iphone-accessibility 0/3", "apple/scroll"]);
  });

  it("留言带本次运行的标记，同一次运行不在同一个 PR 上留两次", () => {
    const body = claimComment({
      workflow: "apple.yml",
      failed: ["apple/iphone-accessibility 0/3"],
      head: "d".repeat(40),
      base: "a".repeat(40),
      runUrl: "https://github.com/o/r/actions/runs/42",
      runId: "42",
      pulls: [700, 745],
    });
    expect(body.startsWith(marker("42"))).toBe(true);
    expect(body).toContain("#700、#745");
    expect(body).toContain("aaaaaaaaa");
    expect(body).toContain("https://github.com/o/r/actions/runs/42");
    expect(body).toContain("不调高登记表的数");
    expect(alreadyClaimed([{ body: "别的留言" }, { body }], "42")).toBe(true);
    expect(alreadyClaimed([{ body }], "43")).toBe(false);
  });

  it("找不到上一次通过时说明只列了这个提交的 PR", () => {
    const body = claimComment({
      workflow: "testflight.yml",
      failed: ["testflight/upload"],
      head: "d".repeat(40),
      base: null,
      runUrl: "u",
      runId: "1",
      pulls: [],
    });
    expect(body).toContain("找不到这些作业全部通过的一次");
  });
});
