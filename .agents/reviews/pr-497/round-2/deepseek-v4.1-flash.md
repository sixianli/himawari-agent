本轮范围：先看了 `git diff 6461b73..dfc7fc7` 的文件面，再逐行核 `git diff 63bb4f2..dfc7fc7` 的增量（`ci.yml` 并发组、`check-policy.mjs`、`policy.test.mjs`、`merge-queue.mjs`、`test-scope.mjs`、`main-evidence.mjs`、四个测试文件、ADR 0268），并沿着增量跟到了 `advance/drop/failCandidate/stop/start`、`reviewChecker`、`addLabel`、`candidateBranches` 的调用端，以及 `scope`、并发组、`--no-renames`、标签、超时参数的产生端和使用端。没有修改任何文件，也没有运行测试。

未核实：`.agents/reviews/pr-497/round-1/judgments.md` 无法读取（沙盒拒绝了 records-path），第 1 轮判定细节只能按作者转述理解；GitHub 侧 `ci/required` 同名多检查运行的取舍、job 级 timeout/cancel 的 run conclusion 语义未联网核实。

### 1. 中：未判定的候选 CI 会无上限重建并重跑完整 CI

文件:行：`scripts/ci/merge-queue.mjs:465-470`、`scripts/ci/merge-queue.mjs:375-379`、`scripts/ci/merge-queue.mjs:575-576`、`scripts/ci/merge-queue.mjs:522-558`；`.github/workflows/merge-queue.yml:2-5`

问题：新逻辑只有“运行结论和 `ci/required` 都是 failure”才拆半或移出；其余一律 `drop`。`drop` 之后同一次 `processQueue` 会立刻 `start()`，状态里没有重试计数、退避或停止条件，于是会马上重建同一批候选并重新 `dispatch` 完整 CI。若 `requiredJobConclusion` 持久返回 `null`（例如 `ci/required` 被改名或缺失、返回的 jobs 不唯一、API 暂时不一致），每次候选 CI 完成都会经 `workflow_run` 再触发一轮队列、再起一轮完整 CI，永不停止，也不给 PR 任何反馈。

证据（读代码证实）：
```js
const required = await github.requiredJobConclusion(run);
if (run.conclusion === "success" && required === "success")
  return mergeCandidate(state.candidate, run, main);
if (run.conclusion === "failure" && required === "failure")
  return failCandidate(state.candidate, run);
return drop(`ci-not-judged run=${run.conclusion} required=${required}`);
```
```js
const drop = (reason) => {
  log(`MQ_DROP ${state.candidate.branch} ${reason}`);
  repo.deleteBranch(state.candidate.branch);
  state = { ...state, candidate: null };
};
```
```js
if (state.candidate) await advance();
if (!state.candidate && !state.stopped) await start();
```
工作流又在每次 CI 完成时触发队列：`workflow_run: workflows: [CI] types: [completed]`。

建议：在 state 里记“同一候选/同一 PR 集合连续未判定次数”，超过阈值就 `stop` 并留言；`required` 为 `null` 时先短等待/重查，区分“作业还没落库”和“根本没有”；至少加退避，不要同轮立刻重建。

推测：“required 会持续为 null”的具体诱因未在真实仓库验证；已证实的部分是“无上限、drop 后同轮重建”。

### 2. 低：复核超时被当作“复核未覆盖”直接移出队列

文件:行：`scripts/ci/merge-queue.mjs:321-339`、`scripts/ci/merge-queue.mjs:489-493`

问题：`spawnSync` 的 `timeout` 触发后 `status` 不是 0，`reviewChecker` 返回 `{ ok: false }`；`readiness` 对任何 `!review.ok` 都 `eject`（摘 `merge-queue`、加 `merge-queue-failed`、留言），文案还断言“复核没有覆盖最新提交”。超时或复核脚本临时出错不等于“未复核”，而 `eject` 需要人工重新加标签，属于不应由瞬时错误触发的动作。好的一面是 `--assert-reviewed` 本身很快，5 分钟超时只在病态情况下命中。

证据：
```js
{ encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout },
...
return { ok: result.status === 0, output };
```
```js
const review = checkReview(number, head, main);
if (!review.ok)
  return {
    eject: `合并前的模型复核没有覆盖最新提交：...`,
  };
```

建议：区分超时/脚本错误和真正的 `REVIEW_MISSING`；前者返回 `skip`（保持排队，下轮重试）或只丢候选，并在评论里写明失败类型。

### 3. 低：`addLabel` 把所有 422 当“标签已存在”，会掩盖真正的创建失败

文件:行：`scripts/ci/merge-queue.mjs:308-311`

问题：`POST /labels` 的 422 被无条件放过。422 还可能表示名称非法等校验失败；代码不读响应体，无法区分。之后 `POST /issues/{n}/labels` 若再次 422 会抛出更难定位的错误，极端情况下队列以为标签已建好，实际上只是跳过了创建。

证据：
```js
async addLabel(number, label) {
  await call("POST", "/labels", { name: label, color: "b60205" }, { allow: [422] });
  await call("POST", `/issues/${number}/labels`, { labels: [label] });
},
```

建议：只对 `errors[].code === "already_exists"` 的 422 放过，其余 422 继续抛出；或先查标签是否存在再创建。

推测：422 还用于其他校验失败这一点未联网核实；无条件放过 422 是代码事实。

### 4. 低：ADR 决定段与新的判定规则不一致，“CI 本身出错不怪 PR”范围偏窄

文件:行：`docs/adr/0268-merge-queue-and-related-tests-on-prs.md:74`、`docs/adr/0268-merge-queue-and-related-tests-on-prs.md:103`；`scripts/ci/merge-queue.mjs:466-470`

问题：决定段第 74 行仍写“候选失败”就移出/拆半，没有任何限定；后果段第 103 行才说只有“运行结论和 `ci/required` 都是 failure”才算 PR 的错。两处放一起容易让实现者按第 74 行处理。另外第 103 行把“超时”一律算 CI 的问题，但 job 级超时通常会把该 job 记成 failure，`ci/required` 也会失败，代码仍会按 PR 的错拆半/移出；`ci/required` 因入口检查 `CI_CANCELLED` 失败时也可能得到 failure/failure。作者“CI 本身出错不怪 PR”的说法只能覆盖 run 级非 failure/failure 的情形。

证据：
```md
3. 候选失败：只有一个 PR 时把它移出队列（...）；多于一个时拆成前后两半...
```
```md
- 候选的完整 CI 只有在运行结论和 `ci/required` 都是 failure 时才算 PR 的错（拆半或移出）；启动失败、超时、`ci/required` 被跳过或没有结论都当作 CI 本身的问题...
```
```js
if (run.conclusion === "failure" && required === "failure")
  return failCandidate(state.candidate, run);
return drop(...);
```

建议：第 74 行加上“只有 failure+failure”的限定；第 103 行把“超时”限定为 run 级 `timed_out`，并说明 job 级 timeout 或 `CI_CANCELLED` 导致 required failure 时仍会被当成 PR 的错，或者让代码区分 required 的失败原因。

推测：GitHub 把 job 级 timeout/部分取消记为 failure 而非 run 级 cancelled/timed_out，这一点未联网核实。

### 5. 低：`start` 无条件删除远端所有 `mq/*`，范围宽且失败静默

文件:行：`scripts/ci/merge-queue.mjs:150-154`、`scripts/ci/merge-queue.mjs:497-501`、`scripts/ci/merge-queue.mjs:156-157`

问题：每次没有候选（即使随后直接 idle）都会列出并删除全部 `mq/*` 远端分支，`deleteBranch` 又 `allowFail: true`，失败只静默。ADR 只写了候选分支名为 `mq/<运行号>-<尝试次数>`，没有声明 `mq/` 命名空间专属于队列；若有人或别的工具使用 `mq/` 下的分支，会被不可逆删除。清理本身是第 1 轮要的，但范围和失败处理值得收紧。

证据：
```js
candidateBranches: () =>
  run(["ls-remote", "--heads", remote, `refs/heads/${candidatePrefix}*`])
    .split("\n").filter(Boolean)
    .map((line) => line.split("\t")[1].slice("refs/heads/".length)),
...
for (const branch of repo.candidateBranches()) {
  log(`MQ_ORPHAN ${branch}`);
  repo.deleteBranch(branch);
}
```

建议：在 ADR/说明里声明 `mq/` 所有权；删除失败时记日志并考虑失败；或只在确实要创建新候选时清理，使用更专有的前缀。

### 6. 低：改名反向用例依赖 git 默认 rename 检测开启，环境关掉时旧代码也会通过

文件:行：`test/tooling/test-scope.test.mjs:163-190`、`test/tooling/merge-queue.test.mjs:318-326`

问题：这两个反向用例要证明“旧实现没加 `--no-renames` 时会漏掉旧路径”，前提是 git 的 `diff.renames` 默认为 true。如果 runner 的全局/仓库配置把重命名检测关掉，旧实现也会输出新旧两个路径，新用例在旧代码上就不会失败（假阴性）。这不影响新实现的正确性，但削弱了反向用例的保证。

建议：在临时仓库里显式 `git config diff.renames true` 后再提交改名，确保测的是“旧代码缺 `--no-renames`”而不是环境默认值；merge-queue 的改名用例同样处理。

## 侧重检查

- 错误路径：`advance` 的未判定分支、`drop`/`failCandidate`/`stop` 的分支删除、`reviewChecker` 超时、`addLabel` 的 422、`candidateBranches`/`deleteBranch`、`changedFiles` 失败。结论见意见 1、2、3、5；`changedFiles` 失败会抛 `CI_TEST_SCOPE_DIFF_FAILED`，没有静默退回。
- 不可信输入：远端分支名来自 `ls-remote`，经数组参数传给 `spawnSync("git", args)`，不经过 shell；状态里有 `validateState` 的 `mq/` 前缀、40 位 SHA、正整数校验；`repository` 有正则校验；标签名是常量。未发现注入路径。
- 安全：`merge-queue.yml` 只在 main 检出上跑，不执行 PR 代码；`checkout` 保留凭据是为了推 `mq/*` 和状态分支；创建标签用的是 `issues: write`，与工作流权限一致。`--no-renames` 让“把受保护文件改名移出保护目录”也能被 `touchesProtected` 拦住，没有发现改名绕过。
- 资源耗尽：意见 1 是主要风险；复核有 5 分钟超时（脚本收到 SIGTERM 后最多再加 30 秒 grace，`STOP_GRACE_MS=30000`），候选另有 3 小时超时。
- 不可撤销操作：意见 2 的超时移出、意见 5 的全量 `mq/*` 删除；`stop` 删除候选分支是作者明确要的，评论和运行链接仍保留。
- 规则/文档一致性：`delivery-mode.md:27`、`owner-standing-rules.md:43` 与“加标签即合并、受保护文件走手动合并”基本一致；`delivery-mode.md` 说“失败的 PR 会被移出”，对多 PR 候选实际上是先拆半重测、只有最终落到单个 PR 才移出，属于概述性简化。ADR 的具体不一致见意见 4。
- 并发组的两端：`ci.yml:24` 产生的字符串、`check-policy.mjs:503-515` 的期望值、`policy.test.mjs:194-203` 的 fixture 三处一致。副作用是同一 PR 转正式后会同时存在草稿 run 的失败 `ci/required` 和正式 run 的检查；`merge-queue` 的 `requiredCheck` 按 `head_sha` 过滤后取最大 id，能接受正式 run，但 GitHub 分支保护对同名多检查的取舍未联网核实。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？**
不会改变产品模型（Himawari 对话）的请求开头。本次增量只改 CI 工作流、策略校验、合并队列脚本、测试、ADR 和复核记录；没有触碰系统提示、工具定义、历史消息、出口遮盖或请求组装代码，因此“只追加”和“会变的值放最后一条消息”这两条性质不受本次改动影响。这里没有代码路径把新增的 `createdAt`、分支列表、标签、超时等值写入请求头；`createdAt` 也是先前就存在于状态的字段。唯一会变的是“代码复核工具自己的模型调用”会因为 PR diff 里多了第 1 轮记录而不同，但那是复核的一次独立调用，不是 Himawari 对话已发内容的前缀。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**
不会（就模型请求而言）。新增的值都不进入模型内容：`reviewTimeoutMs`、标签颜色、`candidateBranches` 的 `ls-remote` 顺序、候选分支名、`scope` 字段都不在提示组装路径里。状态保存仍是固定键顺序的 `JSON.stringify(state, null, 2)`，没有新增时间字段或无序集合。`ls-remote` 的返回顺序即使变化，也只影响删除顺序，不会序列化进模型请求。

**3. 反向用例在旧代码上真的会失败吗？**
按旧实现逐条推演会失败：策略测试里“去掉 draft/ready 段”的 mutation 在旧 `check-policy` 的 4 段期望下会通过，因此 `toThrow` 失败；`test-scope` 的改名用例在旧 `changedFiles` 下只会得到新路径，两个断言都失败；`merge-queue` 的改名用例、`it.each` 四个未判定分支、孤儿分支清理、`addLabel` 先建标签、复核超时、`stop` 删除候选分支，在旧实现上都会失败。把新增/改写的 merge-queue、policy、test-scope 用例按“11 条”计算是说得通的（我数出的新增 `it`/`it.each` 行加上两条被改写的断言恰好 11 条）。另外 `main-evidence.test` 新增的 `scope="partial"` 断言在旧实现（只拒绝 `"related"`）上也会失败；如果把它算进去就是 12 条，所以“11 条”应是指不含这一条的口径。精确条数无法在这里运行测试核实；两个改名反向用例还依赖 `diff.renames` 默认开启（见意见 6）。

**4. 改动产生或修改的每个值，每个使用端都能接受吗？**
- 并发组新段：产生端 `ci.yml:24`，使用端 `check-policy.mjs:503-515` 和 `policy.test.mjs:194-203` 都已同步，GitHub 侧接受字符串表达式；三处一致。
- `--no-renames`：两个 `changedFiles` 产生端都加了；使用端 `touchesProtected` 和 `classifyChanges` 都能处理新旧两个路径，没有只接受单一路径的假设。
- `reviewTimeoutMs`/`timeout`：默认值和 `spawnSync` 选项、测试传参两端一致。
- `candidateBranches`：返回的 `mq/...` 与 `deleteBranch` 的 `:refs/heads/` 拼接、`validateState` 的 `mq/` 前缀校验一致；不会碰到 `merge-queue-state`。
- 标签：`addLabel` 的创建端使用常量名和合法颜色，工作流有 `issues: write`；GitHub 接受 `{name,color}` 和 `{labels:[...]}`，测试覆盖了 422 已存在路径；风险是 422 放得过宽（意见 3）。
- `scope`：产生端 `aggregate.mjs` 只写 `"full"`/`"related"`，schema 允许 `"full"`/`"related"`（可选）；使用端 `main-evidence.mjs:221` 接受缺省或 `"full"`、拒绝 `"related"` 和未知值，两端相容；缺省值只对应本 PR 之前没有 `scope` 的旧结果，那些结果本来就是全量。
- 失败判定值：使用 GitHub 的 `run.conclusion` 和 job conclusion；正常 full CI 成功是 success/success，真实测试失败是 failure/failure，拆分/移出逻辑两端相容；未判定状态没有上限（意见 1）。
- 文档值：ADR 的后果段已补三条；决定段第 74 行没有同步，见意见 4。
