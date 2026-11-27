import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SECOND = 1000;
const LIST_CAP = 1000;

export function percentile(values, fraction) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

function seconds(from, to) {
  if (!from || !to) return null;
  return (Date.parse(to) - Date.parse(from)) / SECOND;
}

export function machineOf(job) {
  const labels = (job.labels ?? []).join(",");
  if (/macos/u.test(labels)) return "mac";
  if (/ubuntu/u.test(labels)) return "linux";
  if (labels === "") return "unknown";
  return "other";
}

export function hadRunner(job) {
  return Boolean(job.runner_id) && job.runner_id !== 0 && Boolean(job.started_at);
}

export function markCopiedJobs(jobs) {
  const seen = new Map();
  const ordered = [...jobs].sort((a, b) => (a.run_attempt ?? 1) - (b.run_attempt ?? 1));
  for (const job of ordered) {
    job.copied = false;
    if (!hadRunner(job) || !job.completed_at) continue;
    const key = [job.run_id, job.name, job.runner_id, job.started_at, job.completed_at].join("|");
    if (seen.has(key)) job.copied = true;
    else seen.set(key, job);
  }
  return jobs;
}

export function realJobs(jobs) {
  return jobs.filter(
    (job) => hadRunner(job) && !job.copied && job.status === "completed" && job.completed_at,
  );
}

export function classifySteps(steps, runSteps) {
  const names = new Set(runSteps);
  const timed = (steps ?? []).map((step) => ({
    name: step.name,
    seconds: Math.max(0, seconds(step.started_at, step.completed_at) ?? 0),
  }));
  const indices = timed.flatMap((step, index) => (names.has(step.name) ? [index] : []));
  const result = { setup: 0, run: 0, wrapup: 0, unclassified: 0 };
  if (indices.length === 0) {
    for (const step of timed) result.unclassified += step.seconds;
    return result;
  }
  const first = indices[0];
  const last = indices[indices.length - 1];
  timed.forEach((step, index) => {
    if (index < first) result.setup += step.seconds;
    else if (index <= last) result.run += step.seconds;
    else result.wrapup += step.seconds;
  });
  return result;
}

export function attemptsOf(jobs) {
  const attempts = new Map();
  for (const job of jobs) {
    const key = `${job.run_id}#${job.run_attempt ?? 1}`;
    if (!attempts.has(key)) attempts.set(key, []);
    attempts.get(key).push(job);
  }
  return attempts;
}

export function criticalPath(gateJob, jobs, start) {
  const slackMs = 5 * SECOND;
  let running = 0;
  let waiting = 0;
  const names = [];
  let current = gateJob;
  for (;;) {
    names.push(current.name);
    const started = current.started_at ?? current.completed_at;
    waiting += Math.max(0, seconds(current.created_at, started));
    running += Math.max(0, seconds(started, current.completed_at));
    const created = Date.parse(current.created_at);
    const before = jobs.filter(
      (job) =>
        job !== current &&
        !names.includes(job.name) &&
        Date.parse(job.completed_at) <= created + slackMs,
    );
    if (before.length === 0) {
      waiting += Math.max(0, seconds(start, current.created_at));
      break;
    }
    const previous = before.reduce((latest, job) =>
      Date.parse(job.completed_at) > Date.parse(latest.completed_at) ? job : latest,
    );
    waiting += Math.max(0, seconds(previous.completed_at, current.created_at));
    current = previous;
  }
  return { running, waiting, jobs: names.reverse() };
}

export function gateTimings(runs, jobs, gate) {
  const byRun = new Map(runs.map((run) => [run.id, run]));
  const results = [];
  for (const [key, attemptJobs] of attemptsOf(jobs)) {
    const run = byRun.get(attemptJobs[0].run_id);
    if (!run || run.name !== gate.workflow || run.event !== gate.event) continue;
    const gateJob = attemptJobs.find(
      (job) => job.name === gate.job && job.status === "completed" && job.completed_at,
    );
    if (!gateJob) continue;
    const others = realJobs(attemptJobs).filter((job) => job !== gateJob);
    if (gate.job !== "ci/required" && !hadRunner(gateJob)) continue;
    if (others.length === 0 && gate.job === "ci/required") continue;
    const attempt = attemptJobs[0].run_attempt ?? 1;
    const start =
      attempt === 1 ? run.created_at : attemptJobs.map((job) => job.created_at).sort()[0];
    const end = gateJob.completed_at;
    const total = seconds(start, end);
    const path = criticalPath(gateJob, realJobs(attemptJobs), start);
    results.push({
      attempt: key,
      runId: run.id,
      conclusion: gateJob.conclusion,
      totalSeconds: total,
      runningSeconds: path.running,
      waitingSeconds: path.waiting,
      path: path.jobs,
    });
  }
  return results;
}

export function concurrencyTimeline(jobs, since, until, bucketMinutes) {
  const bucketMs = bucketMinutes * 60 * SECOND;
  const start = Date.parse(since);
  const end = Date.parse(until);
  const buckets = [];
  for (let at = start; at < end; at += bucketMs) {
    buckets.push({
      start: new Date(at).toISOString(),
      mac: 0,
      linux: 0,
      total: 0,
    });
  }
  const events = [];
  for (const job of realJobs(jobs)) {
    const machine = machineOf(job);
    if (machine !== "mac" && machine !== "linux") continue;
    events.push([Date.parse(job.started_at), 1, machine]);
    events.push([Date.parse(job.completed_at), -1, machine]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const live = { mac: 0, linux: 0 };
  const touch = (from, to) => {
    if (to <= from) return;
    const first = Math.max(0, Math.floor((from - start) / bucketMs));
    const last = Math.min(buckets.length - 1, Math.floor((to - 1 - start) / bucketMs));
    for (let index = first; index <= last; index += 1) {
      const bucket = buckets[index];
      bucket.mac = Math.max(bucket.mac, live.mac);
      bucket.linux = Math.max(bucket.linux, live.linux);
      bucket.total = Math.max(bucket.total, live.mac + live.linux);
    }
  };
  let previous = start;
  for (const [at, delta, machine] of events) {
    touch(Math.max(previous, start), Math.min(at, end));
    live[machine] += delta;
    previous = Math.max(previous, at);
  }
  return buckets;
}

export function machineSeconds(job) {
  return Math.max(0, seconds(job.started_at, job.completed_at) ?? 0);
}

export function cancelledMachineTime(runs, jobs) {
  const byRun = new Map(runs.map((run) => [run.id, run]));
  const result = {};
  for (const job of realJobs(jobs)) {
    const machine = machineOf(job);
    result[machine] ??= { total: 0, jobCancelled: 0, runCancelled: 0 };
    const spent = machineSeconds(job);
    result[machine].total += spent;
    if (job.conclusion === "cancelled") result[machine].jobCancelled += spent;
    const run = byRun.get(job.run_id);
    if (run?.conclusion === "cancelled" && (job.run_attempt ?? 1) === (run.run_attempt ?? 1)) {
      result[machine].runCancelled += spent;
    }
  }
  return result;
}

export function runsPerMergedPr(prs, runs, since, until) {
  const from = Date.parse(since);
  const to = Date.parse(until);
  const merged = prs.filter(
    (pr) =>
      pr.merged_at &&
      Date.parse(pr.merged_at) >= from &&
      Date.parse(pr.merged_at) < to &&
      Date.parse(pr.created_at) >= from,
  );
  return merged.map((pr) => {
    const own = runs.filter(
      (run) =>
        run.event === "pull_request" &&
        run.head_branch === pr.head?.ref &&
        Date.parse(run.created_at) >= Date.parse(pr.created_at) &&
        Date.parse(run.created_at) <= Date.parse(pr.merged_at),
    );
    const byWorkflow = {};
    for (const run of own) byWorkflow[run.name] = (byWorkflow[run.name] ?? 0) + 1;
    return { number: pr.number, runs: own.length, byWorkflow };
  });
}

export function rerunPasses(runs, jobs) {
  const byRun = new Map(runs.map((run) => [run.id, run]));
  const perRun = new Map();
  for (const job of jobs) {
    if (!perRun.has(job.run_id)) perRun.set(job.run_id, []);
    perRun.get(job.run_id).push(job);
  }
  const runLevel = [];
  const jobLevel = new Map();
  for (const [runId, runJobs] of perRun) {
    const run = byRun.get(runId);
    if (!run) continue;
    const attempts = [...new Set(runJobs.map((job) => job.run_attempt ?? 1))].sort((a, b) => a - b);
    if (attempts.length < 2) continue;
    const failedIn = (attempt) =>
      runJobs.some(
        (job) => (job.run_attempt ?? 1) === attempt && !job.copied && job.conclusion === "failure",
      );
    const firstFailed = attempts.find(failedIn);
    const lastAttempt = attempts[attempts.length - 1];
    if (firstFailed !== undefined && run.conclusion === "success" && lastAttempt > firstFailed) {
      runLevel.push({
        runId,
        workflow: run.name,
        sha: run.head_sha,
        attempts: lastAttempt,
      });
    }
    const names = new Set(runJobs.map((job) => job.name));
    for (const name of names) {
      const same = runJobs.filter((job) => job.name === name && !job.copied);
      const failure = same.find((job) => job.conclusion === "failure");
      if (!failure) continue;
      const later = same.find(
        (job) =>
          job.conclusion === "success" && (job.run_attempt ?? 1) > (failure.run_attempt ?? 1),
      );
      if (!later) continue;
      const key = `${run.name} / ${name}`;
      jobLevel.set(key, (jobLevel.get(key) ?? 0) + 1);
    }
  }
  return {
    runLevel,
    jobLevel: Object.fromEntries([...jobLevel].sort((a, b) => b[1] - a[1])),
  };
}

function stats(values) {
  return {
    n: values.length,
    p50: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    sum: values.reduce((total, value) => total + value, 0),
  };
}

export function analyze(raw, config, options) {
  const { since, until, bucketMinutes = 10 } = options;
  const runs = raw.runs;
  const jobs = markCopiedJobs(raw.jobs.map((job) => ({ ...job })));
  const byRun = new Map(runs.map((run) => [run.id, run]));
  const workflowOf = (job) => byRun.get(job.run_id)?.name ?? job.workflow_name ?? "?";
  const real = realJobs(jobs);

  const gates = config.gates.map((gate) => {
    const timings = gateTimings(runs, jobs, gate);
    const ok = timings.filter((timing) => timing.conclusion === "success");
    return {
      ...gate,
      attempts: timings.length,
      success: {
        total: stats(ok.map((t) => t.totalSeconds)),
        running: stats(ok.map((t) => t.runningSeconds)),
        waiting: stats(ok.map((t) => t.waitingSeconds)),
      },
      all: {
        total: stats(timings.map((t) => t.totalSeconds)),
        running: stats(timings.map((t) => t.runningSeconds)),
        waiting: stats(timings.map((t) => t.waitingSeconds)),
      },
    };
  });

  const jobGroups = new Map();
  for (const job of real) {
    const key = [workflowOf(job), job.name, machineOf(job), job.conclusion].join("\u0000");
    if (!jobGroups.has(key)) jobGroups.set(key, []);
    jobGroups.get(key).push(job);
  }
  const perJob = [...jobGroups].map(([key, group]) => {
    const [workflow, name, machine, conclusion] = key.split("\u0000");
    return {
      workflow,
      name,
      machine,
      conclusion,
      queue: stats(group.map((job) => seconds(job.created_at, job.started_at))),
      run: stats(group.map(machineSeconds)),
    };
  });
  perJob.sort((a, b) => a.workflow.localeCompare(b.workflow) || a.name.localeCompare(b.name));

  const neverStarted = new Map();
  for (const job of jobs) {
    if (hadRunner(job) || job.status !== "completed" || job.conclusion !== "cancelled") continue;
    const key = [workflowOf(job), job.name, machineOf(job)].join("\u0000");
    if (!neverStarted.has(key)) neverStarted.set(key, []);
    neverStarted.get(key).push(seconds(job.created_at, job.completed_at));
  }
  const notStarted = [...neverStarted].map(([key, waits]) => {
    const [workflow, name, machine] = key.split("\u0000");
    return { workflow, name, machine, wait: stats(waits) };
  });

  const phases = {};
  const phaseByJob = new Map();
  const unclassifiedJobs = new Map();
  for (const job of real.filter((candidate) => candidate.conclusion === "success")) {
    const machine = machineOf(job);
    const split = classifySteps(job.steps, config.runSteps);
    phases[machine] ??= {
      setup: 0,
      run: 0,
      wrapup: 0,
      unclassified: 0,
      jobs: 0,
    };
    for (const part of ["setup", "run", "wrapup", "unclassified"])
      phases[machine][part] += split[part];
    phases[machine].jobs += 1;
    if (split.unclassified > 0) {
      const key = `${workflowOf(job)} / ${job.name}`;
      unclassifiedJobs.set(key, (unclassifiedJobs.get(key) ?? 0) + 1);
    }
    const key = `${workflowOf(job)}\u0000${job.name}\u0000${machine}`;
    if (!phaseByJob.has(key)) phaseByJob.set(key, { setup: [], run: [], wrapup: [] });
    const entry = phaseByJob.get(key);
    entry.setup.push(split.setup);
    entry.run.push(split.run);
    entry.wrapup.push(split.wrapup);
  }
  const phasesPerJob = [...phaseByJob].map(([key, entry]) => {
    const [workflow, name, machine] = key.split("\u0000");
    return {
      workflow,
      name,
      machine,
      n: entry.setup.length,
      setupP50: percentile(entry.setup, 0.5),
      runP50: percentile(entry.run, 0.5),
      wrapupP50: percentile(entry.wrapup, 0.5),
    };
  });

  const timeline = concurrencyTimeline(jobs, since, until, bucketMinutes);
  const peak = (field) => Math.max(0, ...timeline.map((bucket) => bucket[field]));
  const atPeak = (field) =>
    peak(field) === 0 ? 0 : timeline.filter((bucket) => bucket[field] === peak(field)).length;
  const prs = runsPerMergedPr(raw.prs, runs, since, until);
  const rerun = rerunPasses(runs, jobs);

  return {
    window: { since, until, bucketMinutes },
    fetchedAt: raw.meta?.fetchedAt ?? null,
    counts: {
      runs: runs.length,
      jobRecords: jobs.length,
      realJobs: real.length,
      copiedJobs: jobs.filter((job) => job.copied).length,
      unfinishedJobs: jobs.filter((job) => job.status !== "completed").length,
      skippedJobs: jobs.filter((job) => job.conclusion === "skipped").length,
    },
    gates,
    perJob,
    notStarted,
    phases,
    phasesPerJob,
    unclassifiedJobs: Object.fromEntries(unclassifiedJobs),
    cancelled: cancelledMachineTime(runs, jobs),
    concurrency: {
      peakMac: peak("mac"),
      peakLinux: peak("linux"),
      peakTotal: peak("total"),
      bucketsAtPeakMac: atPeak("mac"),
      bucketsAtPeakTotal: atPeak("total"),
      buckets: timeline.length,
    },
    timeline,
    mergedPrs: {
      count: prs.length,
      runsPerPr: stats(prs.map((pr) => pr.runs)),
      ciRunsPerPr: stats(prs.map((pr) => pr.byWorkflow.CI ?? 0)),
      top: [...prs].sort((a, b) => b.runs - a.runs).slice(0, 5),
    },
    rerun: {
      runsPassedAfterFailure: rerun.runLevel.length,
      byWorkflow: rerun.runLevel.reduce((acc, item) => {
        acc[item.workflow] = (acc[item.workflow] ?? 0) + 1;
        return acc;
      }, {}),
      jobs: rerun.jobLevel,
    },
  };
}

const minutes = (value) => (value === null || value === undefined ? "—" : (value / 60).toFixed(1));
const hours = (value) => (value / 3600).toFixed(1);
const share = (part, whole) => (whole > 0 ? `${((100 * part) / whole).toFixed(1)}%` : "—");

export function renderReport(summary) {
  const lines = [];
  const add = (line = "") => lines.push(line);
  add(`# GitHub Actions 运行统计`);
  add();
  add(
    `窗口：${summary.window.since} 到 ${summary.window.until}（UTC，按运行创建时间）。取数时间：${summary.fetchedAt ?? "未知"}。`,
  );
  add(
    `只读：只调用 GitHub 的读取接口，不重跑、不取消任何运行。口径写在 scripts/ci/actions-stats.mjs（各节标题下也有一句说明），检查步骤名单在 ci/actions-stats.json。`,
  );
  add();
  const c = summary.counts;
  add(
    `运行 ${c.runs} 次；job 记录 ${c.jobRecords} 条，其中真正分到机器并结束的 ${c.realJobs} 条，重跑时原样复制的 ${c.copiedJobs} 条（不计），跳过的 ${c.skippedJobs} 条，取数时还没结束的 ${c.unfinishedJobs} 条（不计）。`,
  );
  add();
  add(`## 1. 合并门槛时长`);
  add();
  add(
    `总时长 = 运行（重跑时是这一轮第一个 job）创建到门槛 job 结束；沿关键路径（从门槛 job 往回，每一步找它被放进队列前最后结束的那个 job）把各 job 的运行时间加起来是纯运行，把排队时间和运行开始前在并发组里等的时间加起来是等机器，两者相加等于总时长。单位分钟。`,
  );
  add();
  add(`| 门槛 | 范围 | n | 总 P50 | 总 P90 | 纯运行 P50 | 纯运行 P90 | 等机器 P50 | 等机器 P90 |`);
  add(`|---|---|---|---|---|---|---|---|---|`);
  for (const gate of summary.gates) {
    for (const [label, part] of [
      ["成功", gate.success],
      ["全部", gate.all],
    ]) {
      add(
        `| ${gate.workflow} ${gate.event} → ${gate.job} | ${label} | ${part.total.n} | ${minutes(part.total.p50)} | ${minutes(part.total.p90)} | ${minutes(part.running.p50)} | ${minutes(part.running.p90)} | ${minutes(part.waiting.p50)} | ${minutes(part.waiting.p90)} |`,
      );
    }
  }
  add();
  add(`## 2. 各作业的排队和运行时长`);
  add();
  add(`排队 = job 创建到开始；运行 = 开始到结束。只算分到机器的 job。单位分钟。`);
  add();
  add(`| 工作流 | job | 机器 | 结论 | n | 排队 P50 | 排队 P90 | 运行 P50 | 运行 P90 |`);
  add(`|---|---|---|---|---|---|---|---|---|`);
  for (const row of summary.perJob) {
    add(
      `| ${row.workflow} | ${row.name} | ${row.machine} | ${row.conclusion} | ${row.queue.n} | ${minutes(row.queue.p50)} | ${minutes(row.queue.p90)} | ${minutes(row.run.p50)} | ${minutes(row.run.p90)} |`,
    );
  }
  add();
  add(`### 没分到机器就被取消的 job`);
  add();
  add(`| 工作流 | job | 机器 | 个数 | 等待 P50 | 等待 P90 |`);
  add(`|---|---|---|---|---|---|`);
  for (const row of summary.notStarted) {
    add(
      `| ${row.workflow} | ${row.name} | ${row.machine} | ${row.wait.n} | ${minutes(row.wait.p50)} | ${minutes(row.wait.p90)} |`,
    );
  }
  add();
  add(`## 3. 装环境、执行检查、收尾的时间占比`);
  add();
  add(
    `只看成功的 job。执行检查 = 从 ci/actions-stats.json 里列的第一个检查步骤到最后一个；之前（含装依赖、装浏览器）算装环境，之后算收尾。一个检查步骤都没有的 job 记为未分类。`,
  );
  add();
  add(`| 机器 | job 数 | 装环境 | 执行检查 | 收尾 | 未分类 | 装环境占比 | 执行占比 | 收尾占比 |`);
  add(`|---|---|---|---|---|---|---|---|---|`);
  for (const [machine, phase] of Object.entries(summary.phases)) {
    const whole = phase.setup + phase.run + phase.wrapup + phase.unclassified;
    add(
      `| ${machine} | ${phase.jobs} | ${hours(phase.setup)} 小时 | ${hours(phase.run)} 小时 | ${hours(phase.wrapup)} 小时 | ${hours(phase.unclassified)} 小时 | ${share(phase.setup, whole)} | ${share(phase.run, whole)} | ${share(phase.wrapup, whole)} |`,
    );
  }
  add();
  add(`| 工作流 | job | 机器 | n | 装环境 P50 | 执行 P50 | 收尾 P50 |`);
  add(`|---|---|---|---|---|---|---|`);
  for (const row of summary.phasesPerJob) {
    add(
      `| ${row.workflow} | ${row.name} | ${row.machine} | ${row.n} | ${minutes(row.setupP50)} | ${minutes(row.runP50)} | ${minutes(row.wrapupP50)} |`,
    );
  }
  const unclassified = Object.entries(summary.unclassifiedJobs);
  if (unclassified.length > 0) {
    add();
    add(
      `未分类的 job（步骤名不在 ci/actions-stats.json 的 runSteps 里）：${unclassified.map(([name, count]) => `${name} ×${count}`).join("；")}`,
    );
  }
  add();
  add(`## 4. 被取消运行消耗的机器时间`);
  add();
  add(`| 机器 | 总机器时间 | job 自己被取消 | 占比 | 所在运行最终被取消 | 占比 |`);
  add(`|---|---|---|---|---|---|`);
  for (const [machine, part] of Object.entries(summary.cancelled)) {
    add(
      `| ${machine} | ${hours(part.total)} 小时 | ${hours(part.jobCancelled)} 小时 | ${share(part.jobCancelled, part.total)} | ${hours(part.runCancelled)} 小时 | ${share(part.runCancelled, part.total)} |`,
    );
  }
  add();
  add(`## 5. 并发`);
  add();
  const cc = summary.concurrency;
  add(
    `${summary.window.bucketMinutes} 分钟一段，共 ${cc.buckets} 段。Mac 同时在跑最多 ${cc.peakMac} 个，有 ${cc.bucketsAtPeakMac} 段达到这个数；Linux 最多 ${cc.peakLinux} 个；合计最多 ${cc.peakTotal} 个，有 ${cc.bucketsAtPeakTotal} 段达到。每段明细见 timeline.csv。`,
  );
  add();
  add(`## 6. 每合并一个 PR 触发的运行次数`);
  add();
  const merged = summary.mergedPrs;
  add(
    `只算在窗口内创建并合并的 PR（${merged.count} 个），按分支名和 PR 存在的时间段匹配 pull_request 运行。`,
  );
  add();
  add(
    `- 全部工作流：平均 ${merged.count ? (merged.runsPerPr.sum / merged.count).toFixed(1) : "—"} 次，P50 ${merged.runsPerPr.p50 ?? "—"}，P90 ${merged.runsPerPr.p90 ?? "—"}`,
  );
  add(
    `- 只算 CI：平均 ${merged.count ? (merged.ciRunsPerPr.sum / merged.count).toFixed(1) : "—"} 次，P50 ${merged.ciRunsPerPr.p50 ?? "—"}，P90 ${merged.ciRunsPerPr.p90 ?? "—"}`,
  );
  add(`- 最多的：${merged.top.map((pr) => `#${pr.number} ${pr.runs} 次`).join("，") || "—"}`);
  add();
  add(`## 7. 同一提交失败后重跑通过`);
  add();
  add(
    `同一次运行里先有一轮出现失败的 job、后来某一轮整体成功，记一次。共 ${summary.rerun.runsPassedAfterFailure} 次：${
      Object.entries(summary.rerun.byWorkflow)
        .map(([name, count]) => `${name} ${count}`)
        .join("，") || "无"
    }。`,
  );
  add();
  add(`| job（先失败后在同一运行的重跑里成功） | 次数 |`);
  add(`|---|---|`);
  for (const [name, count] of Object.entries(summary.rerun.jobs)) add(`| ${name} | ${count} |`);
  add();
  return `${lines.join("\n")}\n`;
}

export function compareSummaries(before, after) {
  const rows = [];
  const row = (label, a, b, format = (value) => value) =>
    rows.push(
      `| ${label} | ${a === null || a === undefined ? "—" : format(a)} | ${b === null || b === undefined ? "—" : format(b)} |`,
    );
  for (const gate of after.gates) {
    const old = before.gates.find(
      (item) => item.workflow === gate.workflow && item.job === gate.job,
    );
    row(
      `${gate.job} 成功总时长 P50（分）`,
      old?.success.total.p50,
      gate.success.total.p50,
      minutes,
    );
    row(
      `${gate.job} 成功总时长 P90（分）`,
      old?.success.total.p90,
      gate.success.total.p90,
      minutes,
    );
    row(
      `${gate.job} 纯运行 P50（分）`,
      old?.success.running.p50,
      gate.success.running.p50,
      minutes,
    );
    row(
      `${gate.job} 等机器 P50（分）`,
      old?.success.waiting.p50,
      gate.success.waiting.p50,
      minutes,
    );
    row(
      `${gate.job} 等机器 P90（分）`,
      old?.success.waiting.p90,
      gate.success.waiting.p90,
      minutes,
    );
  }
  for (const machine of ["linux", "mac"]) {
    const a = before.phases[machine];
    const b = after.phases[machine];
    const setupShare = (phase) =>
      phase ? phase.setup / (phase.setup + phase.run + phase.wrapup + phase.unclassified) : null;
    row(
      `${machine} 装环境占比`,
      setupShare(a),
      setupShare(b),
      (value) => `${(100 * value).toFixed(1)}%`,
    );
    const cancelShare = (summary) => {
      const part = summary.cancelled[machine];
      return part && part.total > 0 ? part.runCancelled / part.total : null;
    };
    row(
      `${machine} 被取消运行的机器时间占比`,
      cancelShare(before),
      cancelShare(after),
      (value) => `${(100 * value).toFixed(1)}%`,
    );
  }
  row(
    `每合并 PR 平均运行次数`,
    before.mergedPrs.count ? before.mergedPrs.runsPerPr.sum / before.mergedPrs.count : null,
    after.mergedPrs.count ? after.mergedPrs.runsPerPr.sum / after.mergedPrs.count : null,
    (value) => value.toFixed(1),
  );
  row(
    `失败后重跑通过的运行数`,
    before.rerun.runsPassedAfterFailure,
    after.rerun.runsPassedAfterFailure,
  );
  row(
    `Mac 顶到峰值的时段数`,
    before.concurrency.bucketsAtPeakMac,
    after.concurrency.bucketsAtPeakMac,
  );
  return [
    `# 前后对比`,
    ``,
    `前：${before.window.since} 到 ${before.window.until}；后：${after.window.since} 到 ${after.window.until}`,
    ``,
    `| 指标 | 前 | 后 |`,
    `|---|---|---|`,
    ...rows,
    ``,
  ].join("\n");
}

function toCsv(rows) {
  if (rows.length === 0) return "";
  const columns = Object.keys(rows[0]);
  const cell = (value) => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return `${[columns.join(","), ...rows.map((row) => columns.map((column) => cell(row[column])).join(","))].join("\n")}\n`;
}

async function githubGet(endpoint) {
  const { stdout } = await execFileAsync("gh", ["api", "-X", "GET", endpoint], {
    maxBuffer: 256 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function pool(items, size, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await worker(items[index]);
      }
    }),
  );
  return results;
}

async function listRuns(repo, from, to) {
  const range = `${new Date(from).toISOString()}..${new Date(to - 1).toISOString()}`;
  const first = await githubGet(`repos/${repo}/actions/runs?per_page=100&created=${range}`);
  if (first.total_count >= LIST_CAP && to - from > 60 * SECOND) {
    const middle = from + Math.floor((to - from) / 2);
    return [...(await listRuns(repo, from, middle)), ...(await listRuns(repo, middle, to))];
  }
  const runs = [...first.workflow_runs];
  const pages = Math.ceil(first.total_count / 100);
  for (let page = 2; page <= pages; page += 1) {
    const next = await githubGet(
      `repos/${repo}/actions/runs?per_page=100&page=${page}&created=${range}`,
    );
    runs.push(...next.workflow_runs);
  }
  return runs;
}

async function listJobs(repo, runId) {
  const jobs = [];
  for (let page = 1; ; page += 1) {
    const body = await githubGet(
      `repos/${repo}/actions/runs/${runId}/jobs?filter=all&per_page=100&page=${page}`,
    );
    jobs.push(...body.jobs);
    if (jobs.length >= body.total_count || body.jobs.length === 0) break;
  }
  return jobs;
}

async function listMergedPrs(repo, since) {
  const prs = [];
  for (let page = 1; ; page += 1) {
    const body = await githubGet(
      `repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`,
    );
    prs.push(...body.filter((pr) => pr.merged_at));
    if (body.length < 100 || Date.parse(body[body.length - 1].updated_at) < Date.parse(since))
      break;
  }
  return prs.map((pr) => ({
    number: pr.number,
    created_at: pr.created_at,
    merged_at: pr.merged_at,
    head: { ref: pr.head?.ref },
  }));
}

const RUN_FIELDS = [
  "id",
  "name",
  "event",
  "status",
  "conclusion",
  "head_branch",
  "head_sha",
  "run_attempt",
  "created_at",
  "run_started_at",
  "updated_at",
];
const JOB_FIELDS = [
  "id",
  "run_id",
  "run_attempt",
  "name",
  "workflow_name",
  "status",
  "conclusion",
  "created_at",
  "started_at",
  "completed_at",
  "labels",
  "runner_id",
  "runner_name",
];

export async function fetchRaw(repo, since, until) {
  const runs = (await listRuns(repo, Date.parse(since), Date.parse(until))).map((run) =>
    Object.fromEntries(RUN_FIELDS.map((field) => [field, run[field] ?? null])),
  );
  const unique = [...new Map(runs.map((run) => [run.id, run])).values()];
  const jobLists = await pool(unique, 8, (run) => listJobs(repo, run.id));
  const jobs = jobLists.flat().map((job) => ({
    ...Object.fromEntries(JOB_FIELDS.map((field) => [field, job[field] ?? null])),
    steps: (job.steps ?? []).map((step) => ({
      name: step.name,
      conclusion: step.conclusion,
      started_at: step.started_at,
      completed_at: step.completed_at,
    })),
  }));
  const prs = await listMergedPrs(repo, since);
  return {
    meta: { repo, since, until, fetchedAt: new Date().toISOString() },
    runs: unique,
    jobs,
    prs,
  };
}

function parseArgs(argv) {
  const options = { bucketMinutes: 10, config: "ci/actions-stats.json" };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--since") options.since = value;
    else if (key === "--until") options.until = value;
    else if (key === "--hours") options.hours = Number(value);
    else if (key === "--out") options.out = value;
    else if (key === "--raw") options.raw = value;
    else if (key === "--compare") options.compare = value;
    else if (key === "--repo") options.repo = value;
    else if (key === "--bucket-minutes") options.bucketMinutes = Number(value);
    else if (key === "--config") options.config = value;
    else throw new Error(`ACTIONS_STATS_UNKNOWN_ARGUMENT ${key}`);
    index += 1;
  }
  if (!options.out) throw new Error("ACTIONS_STATS_OUT_REQUIRED --out <目录>");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = JSON.parse(readFileSync(options.config, "utf8"));
  let raw;
  if (options.raw) {
    raw = JSON.parse(readFileSync(options.raw, "utf8"));
    options.since ??= raw.meta.since;
    options.until ??= raw.meta.until;
  } else {
    options.until ??= new Date().toISOString();
    options.since ??= new Date(
      Date.parse(options.until) - (options.hours ?? 72) * 3600 * SECOND,
    ).toISOString();
    const repo = options.repo ?? process.env.GITHUB_REPOSITORY ?? "sixianli/himawari-agent";
    raw = await fetchRaw(repo, options.since, options.until);
  }
  mkdirSync(options.out, { recursive: true });
  if (!options.raw) writeFileSync(path.join(options.out, "raw.json"), JSON.stringify(raw));
  const summary = analyze(raw, config, options);
  const { timeline, ...compact } = summary;
  writeFileSync(path.join(options.out, "summary.json"), `${JSON.stringify(compact, null, 2)}\n`);
  writeFileSync(path.join(options.out, "timeline.csv"), toCsv(timeline));
  writeFileSync(path.join(options.out, "report.md"), renderReport(summary));
  if (options.compare) {
    const before = JSON.parse(readFileSync(options.compare, "utf8"));
    writeFileSync(path.join(options.out, "compare.md"), compareSummaries(before, compact));
  }
  process.stderr.write(
    `ACTIONS_STATS_WRITTEN ${options.out} runs=${summary.counts.runs} jobs=${summary.counts.jobRecords}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`ACTIONS_STATS_FAILED ${error.message}\n`);
    process.exit(1);
  });
}
