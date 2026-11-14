import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const queueLabel = "merge-queue";
export const failedLabel = "merge-queue-failed";
export const stateBranch = "merge-queue-state";
export const candidatePrefix = "mq/";
export const protectedPaths = [".github", "ci", "scripts/ci"];
export const batchLimit = 5;
export const runGraceMs = 15 * 60_000;
export const candidateTimeoutMs = 3 * 3600_000;
export const requiredJobName = "ci/required";
export const reviewTimeoutMs = 5 * 60_000;
export const undecidedLimit = 3;
const workflowFile = "ci.yml";
const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const shaPattern = /^[a-f0-9]{40}$/u;
const botIdentity = {
  GIT_AUTHOR_NAME: "himawari-merge-queue",
  GIT_AUTHOR_EMAIL: "merge-queue@users.noreply.github.com",
  GIT_COMMITTER_NAME: "himawari-merge-queue",
  GIT_COMMITTER_EMAIL: "merge-queue@users.noreply.github.com",
};

function assert(condition, code) {
  if (!condition) throw new Error(code);
}

const isSha = (value) => typeof value === "string" && shaPattern.test(value);
const isPositive = (value) => Number.isSafeInteger(value) && value > 0;

export function emptyState() {
  return { version: 1, stopped: null, candidate: null, groups: [], undecided: 0 };
}

export function validateState(value) {
  assert(value && typeof value === "object" && value.version === 1, "MQ_STATE_VERSION");
  assert(
    value.stopped === null ||
      (typeof value.stopped?.reason === "string" && typeof value.stopped?.at === "string"),
    "MQ_STATE_STOPPED",
  );
  assert(
    Array.isArray(value.groups) &&
      value.groups.every(
        (group) => Array.isArray(group) && group.length > 0 && group.every(isPositive),
      ),
    "MQ_STATE_GROUPS",
  );
  assert(Number.isSafeInteger(value.undecided) && value.undecided >= 0, "MQ_STATE_UNDECIDED");
  const candidate = value.candidate;
  if (candidate !== null) {
    assert(
      candidate &&
        typeof candidate.branch === "string" &&
        candidate.branch.startsWith(candidatePrefix) &&
        isSha(candidate.sha) &&
        isSha(candidate.base) &&
        typeof candidate.createdAt === "string" &&
        typeof candidate.fromGroup === "boolean" &&
        (candidate.runId === null || isPositive(candidate.runId)) &&
        Array.isArray(candidate.prs) &&
        candidate.prs.length > 0 &&
        candidate.prs.every((pr) => isPositive(pr.number) && isSha(pr.head) && isSha(pr.tree)),
      "MQ_STATE_CANDIDATE",
    );
  }
  return value;
}

export function touchesProtected(files) {
  return files.filter((file) =>
    protectedPaths.some((prefix) => file === prefix || file.startsWith(`${prefix}/`)),
  );
}

export function splitGroups(numbers, rest) {
  const middle = Math.ceil(numbers.length / 2);
  return [numbers.slice(0, middle), numbers.slice(middle), ...rest];
}

export function createRepo({ cwd, remote = "origin", env = process.env }) {
  const run = (args, { allowFail = false, input, dir = cwd } = {}) => {
    const result = spawnSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      input,
      env: { ...env, ...botIdentity, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 64 * 1024 * 1024,
    });
    if (allowFail) return result;
    if (result.status !== 0)
      throw new Error(`MQ_GIT_FAILED git ${args[0]} ${String(result.stderr).trim().slice(0, 400)}`);
    return result.stdout.trim();
  };
  const fetchRef = (source, target) => {
    run(["fetch", "--quiet", "--no-tags", remote, `+${source}:${target}`]);
    return run(["rev-parse", target]);
  };
  return {
    fetchMain: () => fetchRef("refs/heads/main", "refs/mq/main"),
    fetchPull: (number) => fetchRef(`refs/pull/${number}/head`, `refs/mq/pull/${number}`),
    deliveryMode: () => run(["show", "refs/mq/main:DELIVERY_MODE"]).trim(),
    changedFiles: (base, head) =>
      run(["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`])
        .split("\0")
        .filter(Boolean),
    mergeBase: (a, b) => run(["merge-base", a, b]),
    tree: (commit) => run(["rev-parse", `${commit}^{tree}`]),
    parents: (commit) => run(["show", "-s", "--format=%P", commit]).split(" ").filter(Boolean),
    buildCandidate(base, prs) {
      const dir = mkdtempSync(path.join(tmpdir(), "mq-candidate-"));
      try {
        run(["worktree", "add", "--quiet", "--detach", dir, base]);
        const merged = [];
        const conflicts = [];
        for (const pr of prs) {
          const attempt = run(
            [
              "merge",
              "--no-ff",
              "--no-edit",
              "-m",
              `merge-queue: #${pr.number} ${pr.head}`,
              pr.head,
            ],
            { allowFail: true, dir },
          );
          if (attempt.status !== 0) {
            run(["merge", "--abort"], { allowFail: true, dir });
            run(["reset", "--hard", "--quiet", "HEAD"], { dir });
            conflicts.push(pr.number);
            continue;
          }
          const sha = run(["rev-parse", "HEAD"], { dir });
          merged.push({
            number: pr.number,
            head: pr.head,
            tree: run(["rev-parse", "HEAD^{tree}"], { dir }),
            sha,
          });
        }
        return { sha: run(["rev-parse", "HEAD"], { dir }), merged, conflicts };
      } finally {
        run(["worktree", "remove", "--force", dir], { allowFail: true });
        rmSync(dir, { recursive: true, force: true });
      }
    },
    candidateBranches: () =>
      run(["ls-remote", "--heads", remote, `refs/heads/${candidatePrefix}*`])
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("\t")[1].slice("refs/heads/".length)),
    pushBranch: (sha, branch) => run(["push", "--quiet", remote, `${sha}:refs/heads/${branch}`]),
    deleteBranch: (branch) =>
      run(["push", "--quiet", remote, `:refs/heads/${branch}`], { allowFail: true }),
    withWorktree(commit, action) {
      const dir = mkdtempSync(path.join(tmpdir(), "mq-review-"));
      try {
        run(["worktree", "add", "--quiet", "--detach", dir, commit]);
        return action(dir);
      } finally {
        run(["worktree", "remove", "--force", dir], { allowFail: true });
        rmSync(dir, { recursive: true, force: true });
      }
    },
    loadState() {
      const fetched = run(
        ["fetch", "--quiet", "--no-tags", remote, `+refs/heads/${stateBranch}:refs/mq/state`],
        { allowFail: true },
      );
      if (fetched.status !== 0) {
        assert(/couldn't find remote ref/u.test(fetched.stderr), "MQ_STATE_FETCH");
        return { state: emptyState(), parent: null };
      }
      const parent = run(["rev-parse", "refs/mq/state"]);
      const text = run(["show", "refs/mq/state:state.json"]);
      return { state: validateState(JSON.parse(text)), parent };
    },
    saveState(state, parent) {
      validateState(state);
      const blob = run(["hash-object", "-w", "--stdin"], {
        input: `${JSON.stringify(state, null, 2)}\n`,
      });
      const tree = run(["mktree"], { input: `100644 blob ${blob}\tstate.json\n` });
      const commit = run([
        "commit-tree",
        tree,
        ...(parent ? ["-p", parent] : []),
        "-m",
        "merge-queue state",
      ]);
      run(["push", "--quiet", remote, `${commit}:refs/heads/${stateBranch}`]);
      return commit;
    },
  };
}

function labelExists(body) {
  try {
    return (JSON.parse(body).errors ?? []).some((entry) => entry?.code === "already_exists");
  } catch {
    return false;
  }
}

export function createGithub({ token, repository, request = fetch, sleep }) {
  assert(token, "MQ_TOKEN_REQUIRED");
  assert(/^[\w.-]+\/[\w.-]+$/u.test(repository ?? ""), "MQ_REPOSITORY_REQUIRED");
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const call = async (method, route, body, { allow = [] } = {}) => {
    const response = await request(`https://api.github.com/repos/${repository}${route}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (allow.includes(response.status)) return { status: response.status, data: null };
    const text = await response.text();
    if (!response.ok)
      throw Object.assign(
        new Error(`MQ_GITHUB_${response.status} ${method} ${route} ${text.slice(0, 300)}`),
        { status: response.status, body: text },
      );
    return { status: response.status, data: text ? JSON.parse(text) : null };
  };
  const get = async (route) => (await call("GET", route)).data;
  return {
    repository,
    async listQueued() {
      const items = await get(
        `/issues?state=open&labels=${encodeURIComponent(queueLabel)}&per_page=100`,
      );
      return items.filter((item) => item.pull_request).map((item) => item.number);
    },
    pull: (number) => get(`/pulls/${number}`),
    async labeledAt(number) {
      let latest = null;
      for (let page = 1; page <= 10; page += 1) {
        const events = await get(`/issues/${number}/timeline?per_page=100&page=${page}`);
        for (const event of events)
          if (event.event === "labeled" && event.label?.name === queueLabel)
            latest = event.created_at;
        if (events.length < 100) break;
      }
      return latest;
    },
    async requiredCheck(sha) {
      const data = await get(
        `/commits/${sha}/check-runs?check_name=${encodeURIComponent(requiredJobName)}&per_page=100`,
      );
      const runs = (data.check_runs ?? []).filter(
        (run) => run.name === requiredJobName && run.head_sha === sha,
      );
      if (runs.length === 0) return { state: "missing" };
      const latest = runs.reduce((a, b) => (b.id > a.id ? b : a));
      if (latest.status !== "completed") return { state: "pending", url: latest.html_url };
      return {
        state: latest.conclusion === "success" ? "success" : "failure",
        url: latest.html_url,
      };
    },
    async dispatch(branch, baseSha) {
      await call("POST", `/actions/workflows/${workflowFile}/dispatches`, {
        ref: branch,
        inputs: { base_sha: baseSha },
      });
    },
    async findRun(branch, sha) {
      const data = await get(
        `/actions/workflows/${workflowFile}/runs?event=workflow_dispatch&branch=${encodeURIComponent(branch)}&per_page=20`,
      );
      const runs = (data.workflow_runs ?? []).filter(
        (run) =>
          run.head_branch === branch &&
          run.head_sha === sha &&
          run.event === "workflow_dispatch" &&
          run.path === `.github/workflows/${workflowFile}` &&
          run.repository?.full_name === repository,
      );
      if (runs.length === 0) return null;
      const run = runs.reduce((a, b) => (b.id > a.id ? b : a));
      return {
        id: run.id,
        attempt: run.run_attempt,
        status: run.status,
        conclusion: run.conclusion,
        url: run.html_url,
      };
    },
    async requiredJobConclusion(run) {
      const data = await get(`/actions/runs/${run.id}/attempts/${run.attempt}/jobs?per_page=100`);
      const jobs = (data.jobs ?? []).filter((job) => job.name === requiredJobName);
      return jobs.length === 1 && jobs[0].status === "completed" ? jobs[0].conclusion : null;
    },
    cancel: (runId) => call("POST", `/actions/runs/${runId}/cancel`, undefined, { allow: [409] }),
    async merge(number, sha) {
      for (let attempt = 1; ; attempt += 1) {
        const result = await call(
          "PUT",
          `/pulls/${number}/merge`,
          { merge_method: "merge", sha },
          { allow: [405, 409] },
        );
        if (result.status === 200) return { merged: true };
        if (attempt >= 4) return { merged: false, status: result.status };
        await wait(5000 * attempt);
      }
    },
    removeLabel: (number, label) =>
      call("DELETE", `/issues/${number}/labels/${encodeURIComponent(label)}`, undefined, {
        allow: [404],
      }),
    async addLabel(number, label) {
      try {
        await call("POST", "/labels", { name: label, color: "b60205" });
      } catch (error) {
        if (!(error.status === 422 && labelExists(error.body))) throw error;
      }
      await call("POST", `/issues/${number}/labels`, { labels: [label] });
    },
    comment: (number, body) => call("POST", `/issues/${number}/comments`, { body }),
  };
}

export function reviewChecker({
  repo,
  script = path.join(scriptRoot, "scripts/model-review/opencode-review.mjs"),
  timeout = reviewTimeoutMs,
}) {
  return (number, head, main) =>
    repo.withWorktree(head, (dir) => {
      const result = spawnSync(
        process.execPath,
        [
          script,
          "--assert-reviewed",
          "--pr",
          String(number),
          "--repo",
          dir,
          "--main-ref",
          repo.mergeBase(main, head),
        ],
        { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout },
      );
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
      return { ok: result.status === 0, broken: result.status === null, output };
    });
}

function livePrProblem(pr, repository, head) {
  if (pr.state !== "open") return "closed";
  if (pr.draft) return "draft";
  if (pr.base?.ref !== "main" || pr.base?.repo?.full_name !== repository) return "base";
  if (pr.head?.repo?.full_name !== repository) return "fork";
  if (head && pr.head?.sha !== head) return "head-moved";
  if (!(pr.labels ?? []).some((label) => label.name === queueLabel)) return "unlabeled";
  return null;
}

export async function processQueue({
  github,
  repo,
  checkReview,
  runTag,
  resume = false,
  now = () => Date.now(),
  log = () => {},
}) {
  const loaded = repo.loadState();
  const original = JSON.stringify(loaded.state);
  let state = loaded.state;
  const at = () => new Date(now()).toISOString();

  const eject = async (number, reason) => {
    log(`MQ_EJECT #${number} ${reason.split("\n")[0]}`);
    await github.removeLabel(number, queueLabel);
    await github.addLabel(number, failedLabel);
    await github.comment(
      number,
      `合并队列把这个 PR 移出了队列：${reason}\n\n修好后重新加 \`${queueLabel}\` 标签即可重新排队。`,
    );
  };
  const drop = (reason) => {
    log(`MQ_DROP ${state.candidate.branch} ${reason}`);
    repo.deleteBranch(state.candidate.branch);
    state = { ...state, candidate: null };
  };
  const stop = (reason) => {
    log(`MQ_STOP ${reason}`);
    if (state.candidate) repo.deleteBranch(state.candidate.branch);
    state = { ...state, stopped: { reason, at: at() } };
  };
  const undecidedDrop = (reason) => {
    const undecided = state.undecided + 1;
    drop(reason);
    state = { ...state, undecided };
    if (undecided >= undecidedLimit)
      stop(
        `候选的完整 CI 连续 ${undecided} 次没有给出成功或失败的结论（最近一次：${reason}），像是 CI 本身出了问题`,
      );
  };
  const remainingGroups = (candidate) =>
    candidate.fromGroup ? state.groups.slice(1) : state.groups;

  const mergeCandidate = async (candidate, run, main) => {
    if (main !== candidate.base) return drop("main-moved");
    for (const pr of candidate.prs) {
      const problem = livePrProblem(await github.pull(pr.number), github.repository, pr.head);
      if (problem) return drop(`pr-${problem} #${pr.number}`);
    }
    let expected = candidate.base;
    const merged = [];
    for (const pr of candidate.prs) {
      const current = repo.fetchMain();
      if (current !== expected) return drop(`main-moved-during-merge after ${merged.join(",")}`);
      const result = await github.merge(pr.number, pr.head);
      if (!result.merged) return drop(`merge-refused #${pr.number} status=${result.status}`);
      const after = repo.fetchMain();
      const parents = repo.parents(after);
      if (
        parents.length !== 2 ||
        parents[0] !== expected ||
        parents[1] !== pr.head ||
        repo.tree(after) !== pr.tree
      ) {
        stop(`main ${after} 和候选 ${candidate.sha} 里 #${pr.number} 合入后的树不一致`);
        await github.comment(
          pr.number,
          `合并队列已合入这个 PR，但 main ${after} 的内容和完整 CI 测过的候选不一致，队列已停下，等人工检查。完整 CI：${run.url}`,
        );
        state = { ...state, candidate: null };
        return;
      }
      merged.push(pr.number);
      log(`MQ_MERGED #${pr.number} main=${after}`);
      await github.removeLabel(pr.number, queueLabel);
      await github.comment(
        pr.number,
        `合并队列已合入 main（${after}）。这次合入的内容和完整 CI 测过的候选 ${candidate.sha} 一致：${run.url}`,
      );
      expected = after;
    }
    repo.deleteBranch(candidate.branch);
    state = { ...state, candidate: null, groups: remainingGroups(candidate) };
  };

  const failCandidate = async (candidate, run) => {
    repo.deleteBranch(candidate.branch);
    const rest = remainingGroups(candidate);
    if (candidate.prs.length === 1) {
      await eject(candidate.prs[0].number, `它和当前 main 合在一起后完整 CI 没过：${run.url}`);
      state = { ...state, candidate: null, groups: rest };
      return;
    }
    const numbers = candidate.prs.map((pr) => pr.number);
    log(`MQ_SPLIT ${numbers.join(",")}`);
    state = { ...state, candidate: null, groups: splitGroups(numbers, rest) };
  };

  const advance = async () => {
    const candidate = state.candidate;
    const main = repo.fetchMain();
    const run = await github.findRun(candidate.branch, candidate.sha);
    if (!run) {
      if (now() - Date.parse(candidate.createdAt) > runGraceMs) undecidedDrop("run-missing");
      else log(`MQ_WAIT_RUN ${candidate.branch}`);
      return;
    }
    state = { ...state, candidate: { ...candidate, runId: run.id } };
    if (run.status !== "completed") {
      if (main !== candidate.base) {
        await github.cancel(run.id);
        return drop("main-moved");
      }
      if (now() - Date.parse(candidate.createdAt) > candidateTimeoutMs) {
        await github.cancel(run.id);
        return undecidedDrop(`timeout ${run.url}`);
      }
      log(`MQ_WAIT_RUN ${candidate.branch} ${run.url}`);
      return;
    }
    const required = await github.requiredJobConclusion(run);
    const passed = run.conclusion === "success" && required === "success";
    const failed = run.conclusion === "failure" && required === "failure";
    if (!passed && !failed)
      return undecidedDrop(`ci-not-judged run=${run.conclusion} required=${required} ${run.url}`);
    state = { ...state, undecided: 0 };
    if (passed) return mergeCandidate(state.candidate, run, main);
    return failCandidate(state.candidate, run);
  };

  const readiness = async (number, main) => {
    const pr = await github.pull(number);
    const problem = livePrProblem(pr, github.repository);
    if (problem === "closed" || problem === "unlabeled") return { skip: true };
    if (problem) return { eject: `PR 状态不满足排队条件（${problem}）` };
    const head = repo.fetchPull(number);
    if (head !== pr.head.sha) return { skip: true };
    const protectedFiles = touchesProtected(repo.changedFiles(main, head));
    if (protectedFiles.length > 0)
      return {
        eject: `它改了 CI 自身的文件（${protectedFiles.slice(0, 5).join("、")}），候选的完整 CI 会用到这些改动，不能自己证明自己；请按原流程等 PR 上的 CI 和 main 确认后手动合并。`,
      };
    const check = await github.requiredCheck(head);
    if (check.state === "pending" || check.state === "missing") return { skip: true };
    if (check.state !== "success")
      return { eject: `PR 最新提交上的 ci/required 没过：${check.url}` };
    const review = checkReview(number, head, main);
    if (review.broken) {
      const first = (review.output.split("\n")[0] ?? "").slice(0, 200);
      log(`MQ_REVIEW_CHECK_BROKEN #${number} ${first}`);
      return { skip: true, halt: true };
    }
    if (!review.ok)
      return {
        eject: `合并前的模型复核没有覆盖最新提交：\n\n\`\`\`\n${review.output.slice(0, 1500)}\n\`\`\``,
      };
    return { ready: { number, head } };
  };

  const start = async () => {
    const main = repo.fetchMain();
    const queued = await github.listQueued();
    const queuedSet = new Set(queued);
    const groups = state.groups
      .map((group) => group.filter((n) => queuedSet.has(n)))
      .filter((g) => g.length);
    state = { ...state, groups };
    let order;
    let fromGroup = false;
    if (groups.length > 0) {
      order = groups[0];
      fromGroup = true;
    } else {
      const stamped = [];
      for (const number of queued)
        stamped.push({ number, at: (await github.labeledAt(number)) ?? "" });
      stamped.sort((a, b) => a.at.localeCompare(b.at) || a.number - b.number);
      order = stamped.map((entry) => entry.number);
    }
    const ready = [];
    for (const number of order) {
      if (ready.length >= batchLimit) break;
      const verdict = await readiness(number, main);
      if (verdict.eject) await eject(number, verdict.eject);
      if (verdict.ready) ready.push(verdict.ready);
      if (verdict.halt) break;
    }
    if (ready.length === 0) {
      if (fromGroup) state = { ...state, groups: groups.slice(1) };
      log("MQ_IDLE");
      return;
    }
    const built = repo.buildCandidate(main, ready);
    for (const number of built.conflicts)
      await eject(
        number,
        "它和 main 或队列里排在它前面的 PR 有冲突。请把 main 合进来、解决冲突后再加标签。",
      );
    if (built.merged.length === 0) {
      if (fromGroup) state = { ...state, groups: groups.slice(1) };
      return;
    }
    for (const orphan of repo.candidateBranches()) {
      log(`MQ_ORPHAN ${orphan}`);
      repo.deleteBranch(orphan);
    }
    const branch = `${candidatePrefix}${runTag}`;
    repo.pushBranch(built.sha, branch);
    await github.dispatch(branch, main);
    state = {
      ...state,
      candidate: {
        branch,
        sha: built.sha,
        base: main,
        prs: built.merged.map(({ number, head, tree }) => ({ number, head, tree })),
        createdAt: at(),
        runId: null,
        fromGroup,
      },
    };
    log(`MQ_CANDIDATE ${branch} ${built.sha} prs=${built.merged.map((pr) => pr.number).join(",")}`);
  };

  if (state.stopped && resume) {
    log(`MQ_RESUMED ${state.stopped.reason}`);
    state = { ...state, stopped: null, undecided: 0 };
  }
  if (state.stopped) {
    log(`MQ_STOPPED ${state.stopped.reason}`);
    return state;
  }
  repo.fetchMain();
  const mode = repo.deliveryMode();
  if (mode !== "fast") {
    log(`MQ_MODE_UNSUPPORTED ${mode}`);
    return state;
  }
  if (state.candidate) await advance();
  if (!state.candidate && !state.stopped) await start();
  if (JSON.stringify(state) !== original) repo.saveState(state, loaded.parent);
  return state;
}

export async function main({ env = process.env, cwd = process.cwd() } = {}) {
  assert(env.GITHUB_ACTIONS === "true", "MQ_ACTIONS_REQUIRED");
  assert(
    /^\d+$/u.test(env.GITHUB_RUN_ID ?? "") && /^\d+$/u.test(env.GITHUB_RUN_ATTEMPT ?? ""),
    "MQ_RUN_ID",
  );
  const repo = createRepo({ cwd, env });
  const github = createGithub({
    token: env.HIMAWARI_CI_GITHUB_TOKEN,
    repository: env.GITHUB_REPOSITORY,
  });
  const lines = [];
  const state = await processQueue({
    github,
    repo,
    checkReview: reviewChecker({ repo }),
    runTag: `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
    resume: env.GITHUB_EVENT_NAME === "workflow_dispatch" && env.MQ_RESUME === "true",
    log: (line) => {
      lines.push(line);
      process.stdout.write(`${line}\n`);
    },
  });
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      [
        "### 合并队列",
        "",
        ...lines.map((line) => `- \`${line.replace(/`/gu, "'")}\``),
        "",
        `候选：${state.candidate?.branch ?? "无"}；待测分组：${JSON.stringify(state.groups)}；停止：${state.stopped?.reason ?? "否"}`,
        "",
      ].join("\n"),
    );
  return state;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
