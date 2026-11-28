import { describe, expect, it } from "vitest";
import {
  alreadyClaimed,
  claimComment,
  failedJobs,
  marker,
  scopes,
} from "../../scripts/ci/main-claim.mjs";
import {
  findGreenBase,
  findLastRanBase,
  greenBase,
  isGreen,
} from "../../scripts/ci/main-green.mjs";

const job = (name, conclusion) => ({ name, conclusion });
const prefixes = ["apple/iphone", "apple/scroll"];

describe("main 上检查失败时找人认领", () => {
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
    const audits = ["apple/iphone-accessibility-build", "apple/iphone-accessibility"];
    expect(
      isGreen(
        all.map((item) => (item.name.endsWith("1/3") ? job(item.name, "cancelled") : item)),
        audits,
      ),
    ).toBe(false);
    expect(isGreen(all, audits)).toBe(false);
    expect(isGreen([...all, job("apple/iphone-accessibility-build", "success")], audits)).toBe(
      true,
    );
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

  it("推送上的苹果检查不把凌晨审计算进去：审计被跳过也算通过", () => {
    expect(
      isGreen(
        [
          job("apple/iphone", "success"),
          job("apple/iphone-accessibility-build", "skipped"),
          job("apple/iphone-accessibility", "skipped"),
          job("apple/scroll", "success"),
        ],
        prefixes,
      ),
    ).toBe(true);
  });

  it("凌晨审计从上次真的跑过审计的定时运行算起，跳过和取消的不算", async () => {
    const runs = [
      { id: 9, head_sha: "c".repeat(40), created_at: "2026-11-29T18:00:00Z" },
      { id: 8, head_sha: "b".repeat(40), created_at: "2026-11-28T18:00:00Z" },
      { id: 7, head_sha: "a".repeat(40), created_at: "2026-11-27T18:00:00Z" },
    ];
    const jobs = {
      9: [job("apple/iphone-accessibility-build", "skipped")],
      8: [job("apple/iphone-accessibility-build", "failure")],
      7: [job("apple/iphone-accessibility-build", "success")],
    };
    const lookup = (runId) =>
      findLastRanBase({
        repo: "o/r",
        workflow: "apple.yml",
        job: "apple/iphone-accessibility-build",
        event: "schedule",
        runId,
        getJson: async (endpoint) => {
          expect(endpoint).toContain("branch=main&event=schedule&status=completed");
          return { workflow_runs: runs };
        },
        getPages: async (endpoint, pick) =>
          pick({ jobs: jobs[Number(endpoint.match(/runs\/(\d+)\/jobs/u)[1])] }),
      });
    expect(await lookup("10")).toBe("b".repeat(40));
    jobs[8] = [job("apple/iphone-accessibility-build", "cancelled")];
    expect(await lookup("10")).toBe("a".repeat(40));
    jobs[7] = [];
    expect(await lookup("10")).toBeNull();
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
        [...prefixes, "apple/iphone-accessibility"],
      ),
    ).toEqual(["apple/iphone-accessibility 0/3", "apple/scroll"]);
    expect(failedJobs([job("apple/iphone-accessibility 0/3", "failure")], prefixes)).toEqual([]);
  });

  it("留言带本次运行的标记，同一次运行不在同一个 PR 上留两次", () => {
    const body = claimComment({
      scope: "apple",
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
      scope: "apple",
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

  it("真联网测试失败时请区间里所有 PR 认领，并说明外网变了怎么处理", () => {
    expect(scopes.any.owns(["docs/x.md"])).toBe(true);
    expect(scopes.apple.owns(["docs/x.md"])).toBe(false);
    expect(scopes.apple.owns(["clients/apple/App/Sources/X.swift"])).toBe(true);
    const body = claimComment({
      scope: "any",
      workflow: "real-sites.yml",
      failed: ["real-sites/run"],
      head: "d".repeat(40),
      base: "a".repeat(40),
      runUrl: "u",
      runId: "7",
      pulls: [770],
    });
    expect(body).toContain("合进 main 的PR：#770");
    expect(body).toContain("不加重试");
    expect(body).not.toContain("登记表");
  });

  it("按时间从新往旧逐个取运行的作业，找到上一次全部通过就停", async () => {
    const runs = [
      { id: 9, head_sha: "c".repeat(40), created_at: "2026-11-27T03:00:00Z" },
      { id: 8, head_sha: "b".repeat(40), created_at: "2026-11-27T02:00:00Z" },
      { id: 7, head_sha: "a".repeat(40), created_at: "2026-11-27T01:00:00Z" },
    ];
    const jobs = {
      9: [job("apple/iphone", "failure"), job("apple/scroll", "success")],
      8: [job("apple/iphone", "success"), job("apple/scroll", "success")],
      7: [job("apple/iphone", "success"), job("apple/scroll", "success")],
    };
    const fetched = [];
    const base = await findGreenBase({
      repo: "o/r",
      workflow: "apple.yml",
      prefixes,
      runId: "10",
      getJson: async (endpoint) => {
        expect(endpoint).toContain("branch=main&event=push&status=completed");
        return { workflow_runs: runs };
      },
      getPages: async (endpoint, pick) => {
        const id = Number(endpoint.match(/runs\/(\d+)\/jobs/u)[1]);
        fetched.push(id);
        return pick({ jobs: jobs[id] });
      },
    });
    expect(base).toBe("b".repeat(40));
    expect(fetched).toEqual([9, 8]);
  });
});
