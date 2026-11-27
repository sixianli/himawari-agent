import { describe, expect, it } from "vitest";
import {
  analyze,
  classifySteps,
  compareSummaries,
  concurrencyTimeline,
  gateTimings,
  markCopiedJobs,
  percentile,
  renderReport,
  rerunPasses,
  runsPerMergedPr,
} from "../../scripts/ci/actions-stats.mjs";

const at = (minute) => new Date(Date.UTC(2026, 10, 27, 0, minute)).toISOString();

function job(overrides) {
  return {
    run_id: 1,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    runner_id: 7,
    labels: ["ubuntu-24.04"],
    steps: [],
    ...overrides,
  };
}

describe("CI 运行统计的口径", () => {
  it("分位数用最近秩法，空样本给空", () => {
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 0.9)).toBe(5);
    expect(percentile([], 0.5)).toBeNull();
  });

  it("依赖安装在第一个检查步骤之前，算装环境不算收尾", () => {
    const steps = [
      { name: "Set up job", started_at: at(0), completed_at: at(1) },
      {
        name: "隔离安装依赖及 SQLite 探针",
        started_at: at(1),
        completed_at: at(3),
      },
      { name: "执行共享检查", started_at: at(3), completed_at: at(10) },
      { name: "核验公开输出白名单", started_at: at(10), completed_at: at(11) },
    ];
    expect(classifySteps(steps, ["执行共享检查"])).toEqual({
      setup: 180,
      run: 420,
      wrapup: 60,
      unclassified: 0,
    });
  });

  it("一个检查步骤都认不出的 job 记为未分类，不硬塞进某一类", () => {
    const steps = [{ name: "新步骤", started_at: at(0), completed_at: at(2) }];
    expect(classifySteps(steps, ["执行共享检查"]).unclassified).toBe(120);
  });

  it("重跑时原样复制进新一轮的 job 不重复计", () => {
    const original = job({
      id: 1,
      name: "static",
      started_at: at(0),
      completed_at: at(5),
      created_at: at(0),
    });
    const copy = { ...original, id: 2, run_attempt: 2 };
    const rerun = job({
      id: 3,
      name: "tests",
      run_attempt: 2,
      started_at: at(10),
      completed_at: at(20),
      created_at: at(9),
    });
    const jobs = markCopiedJobs([copy, original, rerun]);
    expect(jobs.find((item) => item.id === 2).copied).toBe(true);
    expect(jobs.find((item) => item.id === 1).copied).toBe(false);
    expect(jobs.find((item) => item.id === 3).copied).toBe(false);
  });

  it("门槛总时长拆成纯运行和等机器，两者相加等于总时长", () => {
    const runs = [
      {
        id: 1,
        name: "CI",
        event: "pull_request",
        created_at: at(0),
        conclusion: "success",
        run_attempt: 1,
      },
    ];
    const jobs = markCopiedJobs([
      job({
        name: "policy",
        created_at: at(0),
        started_at: at(1),
        completed_at: at(3),
      }),
      job({
        name: "tests",
        created_at: at(3),
        started_at: at(8),
        completed_at: at(20),
      }),
      job({
        name: "ci/required",
        created_at: at(20),
        started_at: at(21),
        completed_at: at(22),
      }),
    ]);
    const [timing] = gateTimings(runs, jobs, {
      workflow: "CI",
      event: "pull_request",
      job: "ci/required",
    });
    expect(timing.totalSeconds).toBe(22 * 60);
    expect(timing.runningSeconds).toBe(15 * 60);
    expect(timing.waitingSeconds).toBe(7 * 60);
  });

  it("关键路径上的作业排队算等机器，即使别的作业同时在跑", () => {
    const runs = [
      {
        id: 1,
        name: "CI",
        event: "pull_request",
        created_at: at(0),
        conclusion: "success",
        run_attempt: 1,
      },
    ];
    const jobs = markCopiedJobs([
      job({
        name: "policy",
        created_at: at(0),
        started_at: at(0),
        completed_at: at(3),
      }),
      job({
        name: "static",
        created_at: at(3),
        started_at: at(3),
        completed_at: at(30),
      }),
      job({
        name: "tests",
        created_at: at(3),
        started_at: at(17),
        completed_at: at(40),
      }),
      job({
        name: "ci/required",
        created_at: at(40),
        started_at: at(40),
        completed_at: at(41),
      }),
    ]);
    const [timing] = gateTimings(runs, jobs, {
      workflow: "CI",
      event: "pull_request",
      job: "ci/required",
    });
    expect(timing.path).toEqual(["policy", "tests", "ci/required"]);
    expect(timing.waitingSeconds).toBe(14 * 60);
    expect(timing.runningSeconds).toBe(27 * 60);
  });

  it("草稿运行（只有 ci/required 自己判失败）不算进门槛时长", () => {
    const runs = [
      {
        id: 1,
        name: "CI",
        event: "pull_request",
        created_at: at(0),
        conclusion: "failure",
        run_attempt: 1,
      },
    ];
    const jobs = markCopiedJobs([
      job({
        name: "ci/required",
        conclusion: "failure",
        created_at: at(0),
        started_at: at(0),
        completed_at: at(1),
      }),
      job({
        name: "tests",
        conclusion: "skipped",
        runner_id: 0,
        started_at: null,
        created_at: at(0),
        completed_at: at(0),
      }),
    ]);
    expect(
      gateTimings(runs, jobs, {
        workflow: "CI",
        event: "pull_request",
        job: "ci/required",
      }),
    ).toEqual([]);
  });

  it("并发时间线分 Mac 和 Linux，每段取最高值", () => {
    const jobs = markCopiedJobs([
      job({
        id: 1,
        started_at: at(0),
        completed_at: at(15),
        labels: ["macos-26"],
      }),
      job({
        id: 2,
        started_at: at(5),
        completed_at: at(8),
        labels: ["macos-26"],
      }),
      job({ id: 3, started_at: at(12), completed_at: at(25) }),
    ]);
    const buckets = concurrencyTimeline(jobs, at(0), at(30), 10);
    expect(buckets.map((bucket) => [bucket.mac, bucket.linux, bucket.total])).toEqual([
      [2, 0, 2],
      [1, 1, 2],
      [0, 1, 1],
    ]);
  });

  it("每个合并的 PR 只数它存在期间、它分支上的 pull_request 运行", () => {
    const prs = [{ number: 9, created_at: at(0), merged_at: at(30), head: { ref: "b" } }];
    const runs = [
      {
        id: 1,
        name: "CI",
        event: "pull_request",
        head_branch: "b",
        created_at: at(1),
      },
      {
        id: 2,
        name: "Apple",
        event: "pull_request",
        head_branch: "b",
        created_at: at(2),
      },
      {
        id: 3,
        name: "CI",
        event: "pull_request",
        head_branch: "b",
        created_at: at(40),
      },
      { id: 4, name: "CI", event: "push", head_branch: "b", created_at: at(3) },
      {
        id: 5,
        name: "CI",
        event: "pull_request",
        head_branch: "c",
        created_at: at(3),
      },
    ];
    expect(runsPerMergedPr(prs, runs, at(0), at(60))).toEqual([
      { number: 9, runs: 2, byWorkflow: { CI: 1, Apple: 1 } },
    ]);
  });

  it("同一运行先失败、重跑后成功的记为一次，并记下是哪个 job", () => {
    const runs = [
      {
        id: 1,
        name: "CI",
        conclusion: "success",
        run_attempt: 2,
        head_sha: "s",
      },
    ];
    const jobs = markCopiedJobs([
      job({
        name: "tests / integration-1",
        conclusion: "failure",
        started_at: at(0),
        completed_at: at(5),
      }),
      job({
        name: "tests / integration-1",
        run_attempt: 2,
        started_at: at(6),
        completed_at: at(9),
      }),
    ]);
    const result = rerunPasses(runs, jobs);
    expect(result.runLevel).toHaveLength(1);
    expect(result.jobLevel).toEqual({ "CI / tests / integration-1": 1 });
  });

  it("只出现一轮、或重跑后仍失败的运行不算", () => {
    const runs = [
      {
        id: 1,
        name: "CI",
        conclusion: "failure",
        run_attempt: 2,
        head_sha: "s",
      },
    ];
    const jobs = markCopiedJobs([
      job({
        name: "x",
        conclusion: "failure",
        started_at: at(0),
        completed_at: at(5),
      }),
      job({
        name: "x",
        run_attempt: 2,
        conclusion: "failure",
        started_at: at(6),
        completed_at: at(9),
      }),
    ]);
    expect(rerunPasses(runs, jobs).runLevel).toHaveLength(0);
  });

  it("整份报告和前后对比能从同一份原始数据生成", () => {
    const raw = {
      meta: { fetchedAt: at(60) },
      runs: [
        {
          id: 1,
          name: "CI",
          event: "pull_request",
          created_at: at(0),
          conclusion: "cancelled",
          run_attempt: 1,
          head_branch: "b",
        },
      ],
      jobs: [
        job({
          name: "tests",
          created_at: at(0),
          started_at: at(1),
          completed_at: at(4),
          conclusion: "cancelled",
        }),
        job({
          name: "ci/required",
          created_at: at(4),
          started_at: at(4),
          completed_at: at(5),
          conclusion: "failure",
        }),
      ],
      prs: [],
    };
    const config = {
      gates: [{ workflow: "CI", event: "pull_request", job: "ci/required" }],
      runSteps: [],
    };
    const summary = analyze(raw, config, {
      since: at(0),
      until: at(60),
      bucketMinutes: 10,
    });
    expect(summary.cancelled.linux.runCancelled).toBe(4 * 60);
    expect(summary.gates[0].all.total.n).toBe(1);
    expect(renderReport(summary)).toContain("## 7. 同一提交失败后重跑通过");
    const { timeline, ...compact } = summary;
    expect(timeline).toHaveLength(6);
    expect(summary.concurrency.bucketsAtPeakMac).toBe(0);
    expect(compareSummaries(compact, compact)).toContain(
      "| linux 被取消运行的机器时间占比 | 100.0% | 100.0% |",
    );
  });
});
