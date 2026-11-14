本轮查的范围：`git diff dfc7fc7ffba928eca95ddf8df3d2d311fab7e946..55af4340f2b83c58f283858ec02fd2c5460cbd05`，以及增量直接影响的 `scripts/ci/merge-queue.mjs`、`test/tooling/merge-queue.test.mjs`、`test/tooling/test-scope.test.mjs`、ADR 0268 和 `.github/workflows/merge-queue.yml`；为核对反向用例，只读了 `dfc7fc7ff` 中对应的旧实现作对比。`.agents/reviews` 下的记录被工具拒绝访问，未核对；我也没有运行测试的权限。

**读代码证实的问题**

### 1. 中：复核 broken 改为跳过后没有每轮预算，可能让队列作业反复撞上 30 分钟超时
- 文件:行：`scripts/ci/merge-queue.mjs:502-506`、`scripts/ci/merge-queue.mjs:534-540`、`scripts/ci/merge-queue.mjs:228`、`.github/workflows/merge-queue.yml`（`timeout-minutes: 30`）
- 问题：`broken` 不再移出，但 `start` 的循环会对每个排队 PR 各跑一次最长 5 分钟的复核；broken 不计入 `ready`，所以最多可以串行等到 `listQueued` 的 100 个 PR，远超作业 30 分钟超时。作业被杀时 `saveState` 还没执行，队列状态不前进，下一次定时运行从头再来。
- 证据：
  ```js
  const review = checkReview(number, head, main);
  if (review.broken) {
    log(`MQ_REVIEW_CHECK_BROKEN #${number} ${review.output.split("\n")[0] ?? ""}`);
    return { skip: true };
  }
  ```
  ```js
  for (const number of order) {
    if (ready.length >= batchLimit) break;
    const verdict = await readiness(number, main);
  ```
  `reviewTimeoutMs = 5 * 60_000`（第 16 行），`listQueued` 是 `per_page=100`（第 228 行），`saveState` 只在函数末尾（第 594 行）。另外 `review.output.split("\n")[0]` 对首行长度没有上限，16MB 输出可能把步骤摘要撑爆。
- 建议：给本轮 broken 设总量预算（例如遇到第一个 broken 就停止本轮继续扫 review，或累计次数到上限后保存状态并停止），并截断日志首行。这样既保留“不移出”，也不会让作业反复超时。

### 2. 中：成功结论但候选被 drop 时 `undecided` 不清零，可能在第 2 次无结论后就误停
- 文件:行：`scripts/ci/merge-queue.mjs:381-385`、`scripts/ci/merge-queue.mjs:394-406`、`scripts/ci/merge-queue.mjs:433`
- 问题：`drop()` 只清 `candidate`，不清 `undecided`；只有完整合并成功、判 PR 失败和 resume 才清零。完整 CI 已经给出 success 结论、但因 main 移动/PR 被关闭/合并接口拒绝而 drop 时，旧的 `undecided` 会保留，下一次再遇到无结论就提前达到 3 次，不符合 ADR“连续 3 次”的语义。
- 证据：
  ```js
  if (main !== candidate.base) return drop("main-moved");
  for (const pr of candidate.prs) {
    const problem = livePrProblem(await github.pull(pr.number), github.repository, pr.head);
    if (problem) return drop(`pr-${problem} #${pr.number}`);
  }
  ```
  这些路径走 `drop()`，而 `drop` 是：
  ```js
  const drop = (reason) => {
    ...
    state = { ...state, candidate: null };
  };
  ```
  只有合并循环全部结束后才 `state = { ...state, candidate: null, groups: remainingGroups(candidate), undecided: 0 }`（第 433 行）。
- 建议：在 CI 结论已经判定为 success 或 failure 时统一清零，而不是只在“全部合完”时清零；补一条 `undecided → success 但 main-moved → 两次 undecided` 不应 stop 的用例。

### 3. 中：`run-missing` 和候选 3 小时超时不计入 `undecided`，仍可无限重跑
- 文件:行：`scripts/ci/merge-queue.mjs:454-456`、`scripts/ci/merge-queue.mjs:465-467`、`scripts/ci/merge-queue.mjs:477-483`
- 问题：作者说法“候选 CI 没有成功或失败结论时丢掉候选并加一”并不成立。找不到运行时、候选运行超过 3 小时时都会丢候选重建，但这两条路径不增加 `undecided`。如果 dispatch 一直不产生运行，队列大约每 15 到 20 分钟就重建一次，永不停止；这与本次改动“不无限重跑”的目的相矛盾。
- 证据：
  ```js
  if (!run) {
    if (now() - Date.parse(candidate.createdAt) > runGraceMs) drop("run-missing");
  ```
  ```js
  if (now() - Date.parse(candidate.createdAt) > candidateTimeoutMs) {
    await github.cancel(run.id);
    return drop("timeout");
  }
  ```
  只有“运行已结束但没给出结论”的分支才执行 `const undecided = state.undecided + 1`（第 477 行）。
- 建议：把 `run-missing` 和 `timeout` 这两个 CI 侧原因也纳入同一计数（`main-moved` 等明确非 CI 原因不纳入），或至少在 ADR 写明不计入并另设重跑上限；补对应测试。

### 4. 低：新增必填 `undecided` 但状态版本仍是 1，旧 `state.json` 会被直接拒绝
- 文件:行：`scripts/ci/merge-queue.mjs:35-53`、`scripts/ci/merge-queue.mjs:181`
- 问题：`emptyState()` 新增 `undecided: 0`，`validateState` 要求它必须是安全非负整数；但 state 版本仍是 1，也没有对旧状态补默认值。任何不包含该字段的旧 `state.json` 都会让 `loadState` 抛 `MQ_STATE_UNDECIDED`，`main` 每次运行直接退出，队列停住。
- 证据：
  ```js
  assert(Number.isSafeInteger(value.undecided) && value.undecided >= 0, "MQ_STATE_UNDECIDED");
  ```
  ```js
  return { state: validateState(JSON.parse(text)), parent };
  ```
- 建议：在 `loadState` 读取后对 `undefined` 默认成 0，或升版本并写迁移；补一条“旧状态下加载成功且按 0 计数”的用例。生产首次上线时状态分支很可能不存在（推测），所以当前实际触发概率低，但这是状态格式的兼容性缺口。

### 5. 低：ADR 的状态字段清单、验证清单与新行为不一致，broken 的条件也写得比代码窄
- 文件:行：`docs/adr/0268-merge-queue-and-related-tests-on-prs.md:70`、`:103`、`:111`；`scripts/ci/merge-queue.mjs:344`
- 问题：ADR 第 70 行列 state 内容时漏了 `undecided`；第 111 行验证清单没有新增的“连续 3 次停止”“broken 跳过”“非 already_exists 422 报错”用例；第 103 行只说“复核检查本身卡住（5 分钟超时）”，而代码把任何 `result.status === null`（被杀、spawn 失败、maxBuffer 超限）都当作 broken 跳过。
- 证据：
  ```js
  return { ok: result.status === 0, broken: result.status === null, output };
  ```
  ADR 第 70 行只写到“当前候选……、待测分组、是否已停下”，第 103 行只写到“5 分钟超时”。
- 建议：补上 state 的 `undecided` 字段说明、验证清单的三类新用例，并把 broken 的判定条件写准（或把实现收窄为只认 timeout）。

### 6. 低：清理 `mq/*` 分支挪位的改动没有反向用例
- 文件:行：`test/tooling/merge-queue.test.mjs:491-498`、`scripts/ci/merge-queue.mjs:556-559`
- 问题：现有 orphan 测试只覆盖“有候选要推时删除 orphan”，这个用例在旧代码（`start` 开头清理）和新代码上都通过，不能证明本次“只在真正推新候选前清理”的行为。若以后有人把清理挪回开头，测试不会红。
- 证据：测试只断言有候选时 `branches` 等于 `[state.candidate.branch]`；旧代码在 `start` 开头清理同样满足。新代码清理位置：
  ```js
  for (const orphan of repo.candidateBranches()) {
    log(`MQ_ORPHAN ${orphan}`);
    repo.deleteBranch(orphan);
  }
  const branch = `${candidatePrefix}${runTag}`;
  repo.pushBranch(built.sha, branch);
  ```
- 建议：补一条“存在 orphan 但本轮没有可建候选（无就绪 PR 或全部冲突）时 orphan 应保留”的用例，和现有用例一起锁住清理位置。

**推测**

### 7. 低：`addLabel` 以错误文本前 300 字节匹配 `"already_exists"`，可能误判合法 422
- 文件:行：`scripts/ci/merge-queue.mjs:219-220`、`scripts/ci/merge-queue.mjs:310-316`
- 问题：`call` 只把响应体前 300 字节放进错误消息，新代码再用正则从这个截断后的消息里找 `"already_exists"`。如果 GitHub 调整错误 JSON 的键顺序、增加长字段，使 `already_exists` 落在 300 字节之外，已存在标签会被当成致命 422，整轮队列中止。按 GitHub 目前的短错误体大概率不会触发，故列为推测。
- 证据：
  ```js
  throw new Error(`MQ_GITHUB_${response.status} ${method} ${route} ${text.slice(0, 300)}`);
  ```
  ```js
  if (!/^MQ_GITHUB_422 [\s\S]*"already_exists"/u.test(error.message)) throw error;
  ```
- 建议：让 `call` 在失败时保留并解析 JSON，按 `errors[].code === "already_exists"` 判断，不依赖错误字符串和 300 字节截断；补一个错误体较长或键顺序不同的用例。

**侧重检查**

- 错误路径：查了状态加载、`run-missing`、候选 3 小时超时、CI 未判定、复核 timeout/被杀、`addLabel` 非 already_exists 422、合并前 drop、`eject` 失败。发现第 1、2、3、4 条；`addLabel` 的 fail-closed 方向正确，但存在第 7 条的文本匹配脆弱性。`eject` 抛错会中止整轮且不保存 state，这是旧有路径，本次 `addLabel` 变严会让非 already_exists 422 更容易触发它，未单独列为新缺陷。
- 不可信输入：`run.url`、review 输出、GitHub 错误体都会进日志/摘要/state；`run.url` 由 GitHub 产生，review 输出首行没有长度上限（已在第 1 条提到）；PR 内容只作为 git 数据，不变。
- 安全：没有新增密钥或权限；写入仍限于标签、评论、state 分支和 `mq/*` 分支。`mq/*` 被声明为队列专用，清理范围没有扩大。
- 资源耗尽：第 1 条是主要问题；`listQueued` 的 100 个 PR 与 5 分钟复核超时相乘可超过工作流 30 分钟上限。
- 不可撤销操作：`eject` 的标签和评论、`merge`、删除 `mq/*` 的行为本身未变；清理位置变化只会让 orphan 分支留得更久，未发现新的大范围误删。
- 规则/文档一致性：第 5 条；`.agents` 里的第 2 轮判定和 claims 记录无法读取，未核实。

**必答问题**

1. **会不会改变模型已经见过的请求开头？** 不会。本轮改动是 CI 队列脚本、测试和 ADR，没有碰系统提示、工具定义、历史消息或遮盖逻辑；`reviewChecker` 只是多返回一个 `broken`，传给复核脚本的参数不变，且 `--assert-reviewed` 是只读检查，不发起模型调用。发给模型的内容仍然只在末尾追加，每轮会变的值仍在最后一条消息里。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。新增的 `undecided` 是整数，写在 state JSON 里，不进入模型请求；`createdAt`、`stopped.at`、`run.url` 本来就是事件相关的队列状态，不是模型提示的一部分。列表顺序和序列化方式没有新增不确定性。
3. **有没有对应的自动检查，反向用例真的会失败吗？** 有，且据我读新旧两版代码，旧代码上会失败的是 5 个用例：新增的“连续 3 次停止”、新增的“broken 跳过”、改过的“非 already_exists 422 报错”、`validateState` 新增的 `undecided:-1` 断言、`reviewChecker` 新增的 `broken:true` 断言。覆盖缺口是：成功但 drop 时清零、`run-missing`/`timeout` 计数、旧状态缺字段、`mq/*` 清理位置，这四项没有能锁住新行为的反向用例。两处 `git config diff.renames true` 对被测代码没有影响，因为两个 `changedFiles` 都显式用了 `--no-renames`；它们不解释“5 条失败”，但也不造成新问题。
4. **新值 `undecided`、`broken` 的产生端和使用端都接受吗？** `broken`：产生端 `reviewChecker`，唯一使用端 `readiness`，测试里不带 `broken` 的旧式返回值是 `undefined`（falsy），兼容；可接受，但判定范围比 ADR 写的宽。`undecided`：产生端是 `emptyState`/`advance`，使用端是 `validateState`（加载和保存）、测试和状态持久化，类型本身两端一致；但旧状态缺字段会被拒绝，且 `drop` 的两条路径和成功结论路径的计数语义不完整，所以并非所有产生/使用路径都满足设计意图。
