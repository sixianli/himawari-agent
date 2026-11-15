### 1. 中 — `broken` 只认 `status === null`，复核脚本自身异常退出会被当成“未复核”而把 PR 移出队列

- 文件:行：`scripts/ci/merge-queue.mjs:359`；`scripts/model-review/opencode-review.mjs:3402-3407`、`3714-3717`
- 问题：新逻辑依赖 `review.broken` 来识别“子进程没有正常退出”，但 `reviewChecker` 只把 `status === null` 视为 broken。`--assert-reviewed` 模式的正常业务失败码是 5，而顶层未捕获异常是 2（模块加载失败还会是 1），这两种都不是 `null`，会落到 `!review.ok` 分支被当作“复核没有覆盖最新提交”处理——即移除 `merge-queue` 标签、加 `merge-queue-failed`、留言。也就是说，配置/IO/git 等脚本自身异常仍会误伤 PR，与本轮“异常时只计数、不误伤”的目标相反。
- 证据（读代码证实）：
  - `merge-queue.mjs:358-359`：`const output = ...; return { ok: result.status === 0, broken: result.status === null, output };`
  - `opencode-review.mjs:3405-3406`：`if ((result.problems.length > 0 && !result.overridden) || result.lowFixRefused) process.exitCode = 5;`
  - `opencode-review.mjs:3714-3716`：`main().catch((error) => { console.error(error.message); process.exitCode = 2; });`
  - `merge-queue.mjs:534-537`：`if (!review.ok) return { eject: \`合并前的模型复核没有覆盖最新提交：...\` }`
- 推测：实际运行中 exit 2/1 的概率不高（`review-models.json` 等由 main 上的 CI 校验），但一旦发生就是不可逆的移出操作；这与本轮新增计数器想解决的问题属于同一类。
- 建议：明确业务退出码白名单，例如 `broken = status === null || (status !== 0 && status !== 5)`，把 5 保留为“未覆盖”、其他一律 broken；并在 `processQueue` 级加一条用例（`checkReview` 返回非零异常码）断言只加 `reviewBroken` 而不 eject。

### 2. 中 — 遇到 broken 立即 `return`，丢掉同一轮已就绪的 PR，属于吞吐回退

- 文件:行：`scripts/ci/merge-queue.mjs:531`、`scripts/ci/merge-queue.mjs:567`
- 问题：旧代码在 broken 时是 `break`，若此前已收集到 ready 的 PR 仍会继续建候选；新代码 `if (verdict.halt) return;` 无条件退出。结果是：按顺序检查时，排在 broken PR 之前、已经复核通过的 PR 也一个都不建候选。一个后位 PR 的一次瞬时 broken 就浪费整轮（下一次触发可能是 10 分钟后的定时），连续 3 轮还会整队停下。
- 证据（读代码证实）：`merge-queue.mjs:522-531` 中 broken 分支返回 `{ halt: true }`；`merge-queue.mjs:562-568` 中 `if (verdict.halt) return;` 位于 `repo.buildCandidate` 之前。对照 diff 的旧代码：`- return { skip: true, halt: true };` 与 `- if (verdict.halt) break;`，旧逻辑在 `ready.length > 0` 时会继续到 `buildCandidate`。
- 推测：作者把“这一轮不建候选”写进 ADR，是有意为之；但从代码后果看，防止“丢掉待测分组”只需在 `ready.length === 0 && fromGroup` 时直接返回，不需要牺牲已就绪 PR 的进度。
- 建议：broken 时若 `ready.length > 0` 仍用这些 ready 建候选（`fromGroup` 保持不变，`groups` 不删），然后返回；只有 `ready` 为空时才完全跳过本轮。这样既不改待测分组，也不制造头阻塞。

### 3. 低 — 全局 `reviewBroken` 无法归因到具体 PR，一个坏 PR 会阻塞并最终停掉整个队列

- 文件:行：`scripts/ci/merge-queue.mjs:525-533`、`527-530`
- 问题：计数器是全局的，且任何其他 PR 的正常复核都会把它清零。因此“连续 3 轮”既不能区分“机器/脚本坏了”与“某个 PR 的内容让复核脚本崩溃”，又会出现：A PR 连续 broken 两次，中间 B PR 正常复核一次就清零；反过来，A 自己的问题会在第 3 轮把整队停下。停队原因只记最近一次 PR 编号。
- 证据（读代码证实）：`const reviewBroken = state.reviewBroken + 1; ... if (reviewBroken >= undecidedLimit) stop(...)`；正常退出路径 `state = { ...state, reviewBroken: 0 };`。
- 推测：用一个全局计数来实现“机器坏了”检测，是刻意简化；对单个 PR 特有的崩溃（如超大/畸形 ledger）会表现为全队停摆而不是只处理该 PR。
- 建议：按 PR 编号记录 broken 次数，达到阈值后只把该 PR 移出/跳过并继续其他 PR；或至少把计数与“同一 PR”绑定，避免跨 PR 清零/阻塞。

### 4. 低 — 新增必填字段但不升 `version`，缺字段的旧 `state.json` 会被硬拒

- 文件:行：`scripts/ci/merge-queue.mjs:36`、`54-57`、`183-185`
- 问题：`emptyState` 加入了 `reviewBroken`，`validateState` 又把它当作必填非负整数。`loadState` 对已存在的 `state.json` 直接 `validateState(JSON.parse(text))`，因此任何缺少该字段的旧状态都会抛 `MQ_STATE_REVIEW_BROKEN`，`processQueue` 中断、工作流以未捕获错误退出，队列不会自动恢复为 0。
- 证据（读代码证实）：`return { version: 1, ..., reviewBroken: 0 };`；`assert(Number.isSafeInteger(value.reviewBroken) && value.reviewBroken >= 0, "MQ_STATE_REVIEW_BROKEN");`；`loadState` 中 `return { state: validateState(JSON.parse(text)), parent };`
- 推测/未核实：作者称远端没有 `merge-queue-state` 分支（本轮无法运行 `git ls-remote` 核实）；若属实，生产上暂时没有旧状态，风险主要来自回滚、手工建分支或将来复用旧状态。
- 建议：把 `reviewBroken` 当可选字段处理（`value.reviewBroken ?? 0` 后再校验），或把 `version` 升到 2 并写迁移逻辑；比仅依赖“远端没有旧分支”更稳。

### 5. 低 — 测试标题与“整轮不建候选”的新行为不一致

- 文件:行：`test/tooling/merge-queue.test.mjs:506`
- 问题：用例名仍是“这一轮跳过 PR，不移出，也不再检查后面的 PR”，但新行为是 `halt` 后立即 `return`、整轮不建候选；ADR 的验证清单已改成“这一轮不建候选”，测试标题没同步，容易让后续维护者误读。
- 证据（读代码证实）：`it("复核检查本身卡住或被杀时这一轮跳过 PR，不移出，也不再检查后面的 PR", ...)`；实现为 `return { halt: true };` 与 `if (verdict.halt) return;`。
- 建议：把标题改为“这一轮不建候选且不再检查后面的 PR”，与 ADR 措辞对齐。

**侧重检查**

- 错误路径：查了 `review.broken` 的判定（`status === null`）、超时/被杀/ENOENT 路径（都是 null，会正确计 broken）、`withWorktree`/`mergeBase` 抛异常路径（会整轮抛错，不计入 `reviewBroken`），以及 `--assert-reviewed` 的退出码 5 与顶层 2（见意见 1）。结论：非零异常退出没有被覆盖。
- 不可信输入：PR 内容只作 git 数据；`review.output` 只取首行切片 200 字符写入日志、state 和 step summary，没有拼接进 shell 命令；`reviewBroken` 是本地计数，不来自外部。未见新的注入面。
- 安全/敏感信息：没有新增网络调用或凭据；新增写入公开 `merge-queue-state` 分支和 step summary 的内容是计数、`#PR` 编号和复核子进程输出首行，理论上可能包含路径等本地信息，但未见密钥。结论：风险低。
- 资源耗尽：`spawnSync` 已有 5 分钟超时与 16MB `maxBuffer`；新增逻辑最多重复 3 轮，无新增无界循环；计数为安全整数，不会溢出。
- 不可撤销操作：`eject` 会移除标签、加 `merge-queue-failed`、留言；意见 1 的误判会触发它。`stop` 只写状态、不动 PR，可恢复。
- 规则/文档一致性：ADR 0268 的三处改动（状态字段、broken 行为、验证清单）与代码基本一致；`stop` 时“不动待测分组”成立（`return` 在 `groups.slice(1)` 之前）；测试标题未同步（意见 5）。旧状态问题见意见 4，远端分支是否存在未核实。

**必答问题**

1. 不会改变模型已经见过的请求开头。合并队列的复核检查执行的是 `opencode-review.mjs --assert-reviewed`（`merge-queue.mjs:344-356`），它只读 PR 头提交里的复核 ledger 并做本地断言，不调用模型、不构造系统提示/工具定义/历史消息。`reviewBroken` 只写入独立的 `merge-queue-state` 分支的 `state.json`，不进入 PR 工作树，也不进入任何发给模型的内容。本改动没有新增任何“每轮变化且位于最后一条消息之外”的值，与“只追加”规则无冲突。
2. 不会。新增的是一个确定性整数计数；`state.json` 用 `JSON.stringify(state, null, 2)` 序列化，没有 `Set`/无序集合参与该值。唯一新增的每轮不同值是既有 `stopped.at` 时间戳，它只存在于 state 文件，不进模型请求；因此不会让同一段 PR 文本在不同请求里变成不同字节。
3. 有自动检查，但覆盖不完整。新增/修改用例覆盖了 broken+1、连续 3 轮 stop、正常退出清零、broken 轮不改分组、超时 `undecided=2`；在旧代码上至少 `test/tooling/merge-queue.test.mjs:519` 与 `:540` 两处 `reviewBroken` 断言会失败（与作者所说“2 条失败”一致，理由可读代码推断，未实际运行）。缺口：没有用真实 `reviewChecker` 的非零异常退出（exit 1/2）走 `processQueue`，也没有覆盖“broken 前已有 ready 时整轮不建候选”的场景，所以意见 1、2 不会被现有测试发现。
4. 产生端：`emptyState` 初始 0、`readiness` broken 时加一、正常复核后清零、`resume` 时清零。使用端：`validateState`、`saveState`/`loadState`、测试、ADR、step summary（只读 candidate/groups/stopped，不读它）。两端都接受非负整数，没有类型或范围冲突。唯一“不能接受”的是缺少该字段的旧 `state.json`（见意见 4）。本轮未新增其他标识/配置键/清单项，未发现新的产生端-使用端不匹配；旧状态分支是否存在未核实。
