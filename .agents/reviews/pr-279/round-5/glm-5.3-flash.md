# 复核报告（PR 279 第 5 轮增量，190afa4 对比 e38538c；全 PR 对比基准 7b549e3）

增量实际内容（已核对提交序列）：
- `fe2a7a5` 合并 origin/main（PR 270，CI 搬 OVH VPS）：全部是 CI/运维脚本、GitHub 工作流、policy、runbook/ADR、相应测试字符串与 `.agents` 记录。
- `190afa4` 新增整轮回放 6 小时时限 + 1 个集成用例 + 第 4 轮审查记录。

## 发现的问题（按严重度排列）

本增量没有发现中高严重度的错误。以下是低严重度与观察项：

**[低] packages/application/src/services/proactive-replay-service.ts:35,220,240-241 — 时限检查只挂在逐封邮件循环里，`history.list` 和每段的 `history.read` 之前不检查**
- 证据（读代码证实）：240-241 行的检查位于 `for (const item of inRange)` 内；`history.list`（212-214 行）和每块 `history.read`（224-230 行）之前没有任何总时限检查。这两步各自的超时只由 `AbortSignal.timeout(perCheckMs)`（211、228 行）按真实时间兜底。
- 影响：极端情况下（网络挂起、单封判断接近 perCheckMs），时刻"`now - runStartedAt`」只在判断一封前被采样一次，总的停止点可能滞后于 6 小时约一个 perCheckMs + 一封判断的时长。这是可接受的设计取舍，与 BUDGET_REACHED 的停下语义一致。
- 建议：无需必改；若想更准，把同样的检查提到外层 chunk 循环头一行即可。

**[低] test/integration/proactive-replay.test.ts:623 — 测试硬编码 7 小时，不引用 `PROACTIVE_REPLAY_MAX_RUN_MS`**
- 证据（读代码证实）：623 行 `h.clock.advance(7 * 60 * 60_000)`；常量在 proactive-replay-service.ts:35 定义并由 :240 使用，测试未导入。
- 影响：并非失效风险——分析表明常量调大后该用例仍然失败：常量在 7–14 小时之间时 judged 会是 2、14–21 小时是 3、超过 21 小时则跑完 4 封得到 `COMPLETED`/judged 4，与断言 `judged: 1`（:643）或 `TIME_LIMIT`（:642）不匹配。但绑定是间接的，改动常量时要靠注意才能理解用例仍生效。
- 建议（可选）：改用 `advance(PROACTIVE_REPLAY_MAX_RUN_MS + 3_600_000)` 之类直接绑定常量。

**[观察·证实] 第 4 轮 DeepSeek 审查文件是空记录**
- 证据：`git show 190afa4 --stat` 显示 `.agents/reviews/pr-279/round-4/deepseek-v4.1-flash.md` 为 1 字节（blob `8b13789`，即一个换行）。与作者说法「DeepSeek 服务报错，脚本替补 GLM」一致，不算错误。

**[未核实] 第 4 轮审查记录内容（judgments.md、verdicts.jsonl、glm-5.3-flash.md）**
- 这个复核环境拒绝读 `.claude/rules/prompt-prefix.md` 同样受管控的 `.records` 类路径（尝试 `git show` `judgments.md` 被拒绝 `REVIEW_GIT_REFUSED records-path`，工作目录里这些文件也不存在），所以第 4 轮「哪些意见判为不成立」的逐条判断内容无法核对。作者对第 4 轮其余意见的处置理由，本轮没有新证据支持重提。

## 侧重检查

走的流程（最普通的一条）：主人从网关发起回放——
1. 命令契约：`proactive.replay.start`（packages/gateway-contracts/src/contracts-v2.ts:608）。
2. 应用命令：apps/agent-service/src/production-proactive.ts:546-556 → `ProactiveReplayService.start`（校验在 proactive-replay-service.ts:147-162）。
3. 执行：`#execute`（list→markListed→逐封 judge→recordResult→finishRun，200-282 行）。
4. 完成上报：`onReplay` 诊断事件（apps/agent-service/src/service-main.ts:1569-1578）。
5. 存储：packages/persistence-sqlite/src/sqlite-proactive-replay-operations.ts:201-274。

结论：
- 步骤 1-2 由既有端到端用例覆盖（test/integration/proactive-replay.test.ts:547-573，经 `gatewayV2MessageSchema.parse` 真实命令走 `production-proactive.execute`）；步骤 5 由 SQLite 合同执行 fixture 覆盖（同文件 `useSqliteContractExecution`）；新时长分支由本次新增用例（612-645 行）覆盖。
- **没有测试覆盖的路径**：新用例没有同时走网关命令路径与被暂停的模型（新 slow service 直接构造，不经 `production-proactive`）；`control-center` 目前完全没有回放运行的界面或 reasonCode 枚举（grep 全无 replay run UI），与作者「标注界面另开 PR」的说法一致——现状是 reasonCode 只落库和进诊断日志。
- 文档一致性：合并后文档闭环正确——旧 runbook 归档到 docs/archive/runbooks/2026-11-07-hermes-self-hosted-runner-runbook.md，新 runbook docs/runbooks/ci-vps-runner-runbook.md 与 ADR 0176（docs/adr/0176-ci-on-ovh-vps.md:71，声明标签只在 `scripts/ci/contracts.mjs` 的 `linuxRunnerLabel` 与 `runners.sh` 的 `RUNNER_LABEL` 两处定义）互相印证；实际读到 contracts.mjs:7 `export const linuxRunnerLabel = "ci-vps"`、runners.sh:3 `RUNNER_LABEL=ci-vps`、policy.schema.json:64 枚举 `["ci-vps","macos-15"]`、ci.yml 全部 `runs-on: ci-vps`（388-496 行），四处一致。
- 测试改字符串（「Do not claim overall task success」→「不要说整个任务已经成功」，test/integration/production-http-composition-process.test.ts:1974,1998-1999,2011）是合并带来的修正：生产文本本来就已是中文（packages/prompt-catalog/src/runtime.ts:88，来自 a701d91，且 a701d91 在 PR 分支基线 `git log 7b549e3 -- packages/prompt-catalog/src/runtime.ts` 中可达），测试断言方向改成与生产一致，方向正确。

## 必答问题逐条回答

**1. 会不会改变模型已经见过的请求开头？**
不会。增量唯一的生产代码是 proactive-replay-service.ts 三个新增点（:35 常量、:220 `runStartedAt`、:240-241 检查）。它只在判断下一封邮件**之前**提前 `finish`，不组装、不修改任何发往模型的消息；`runStartedAt` 只用于内部比较，从不进入任何请求。回放的每封判断请求仍由 `ProactiveMailCheckService` 原有路径生成，逐请求的会变值（`judgedAt` 等）都在结果记录里，不进模型请求。合并的 diff 里也没有生产请求组装代码，只有测试字符串。结论：发给模型的内容仍然只在末尾追加，本轮变化的值都在最后一条消息里，请求开头不变。（读代码证实：#judge→service.run() 的构造未变，proactive-replay-service.ts:284-320。）

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会。新增值：`PROACTIVE_REPLAY_MAX_RUN_MS` 是固定常量；`runStartedAt` 是时钟值但只用于比较，不序列化；`"TIME_LIMIT"` 是常量字符串。没有新增依赖前后文的遮盖、没有新的时间字段进消息、没有新集合。（推测部分：出口遮盖等既有确定性机制未在改动范围内，未重新审计。）

**3. 有没有对应的自动检查，反向用例会不会真的失败？**
有：test/integration/proactive-replay.test.ts:612-645。反向分析（读代码证实，非运行）：去掉 :240-241 的检查后，4 封邮件（fixture `MAILS`，57-62 行）会全部判断并 `recordResult`（judged 每行 +1，sqlite-proactive-replay-operations.ts:218-226），最终 `COMPLETED`/judged 4，与断言 `judged: 1`、`TIME_LIMIT` 至少一处不匹配，用例必失败。测试注入方式（`prepare` 内 `advance` 7 小时）不会误伤第 1 封：mail-check 服务里的 per-check 期限只在调用模型**前**检查（proactive-mail-check-service.ts:538，`stop = "capped"`），判断后的停止只依赖真实的 `AbortSignal.timeout`（:406），所以第 1 封照常判完。作者声称已试过去掉检查会失败，与代码分析一致（未亲见运行记录）。

**4. 每个新值的产生端和使用端都核对了吗？**
逐一核对（读代码证实）：
- `PROACTIVE_REPLAY_MAX_RUN_MS`：产 :35，用 :240（全仓 grep 仅此一处使用；测试不引用它——见上面低严重度条目）。无外部消费端需校验。
- `runStartedAt`：产 :220，用 :240，纯局部。`Date.parse` 对 ISO 时钟（生产与 `ManualClock`，packages/testing/src/deterministic.ts:15-24）均有效。
- `"TIME_LIMIT"`：产 :241 → `finishRun` 消费端校验（proactive-replays.ts:77-84 口径 `status` 枚举 + `reasonCode: string`；sqlite 端 :257-267 `normalText(input.reasonCode, 64)`："TIME_LIMIT" 长度合法）→ 读回 `runColumns`（:27 `reason_code AS reasonCode`，:79-81 直透）→ 诊断日志（service-main.ts:1574 自由字符串）。网关契约（contracts-v2.ts:628 及多处）reasonCode 均为不枚举的 `machineString`；control-center 尚无回放 UI 枚举。无任何一端会拒绝它。
- 合并产出的值：`ci-vps`/`ci-vps-1`/`ci-vps-2`/主机名 `ci-vps` 在 contracts、runners.sh、policy.json、policy.schema.json、workflows、test 三方一致（见上方证据行）；旧路径 `scripts/operations/hermes-runner/` 完全消失，仅 archive 文档与 ADR 0176 按计划引用历史（属于有意保留），无悬空引用影响运行。

最后提示一个我无法核实的点：第 4 轮审查线程的内容（judgments.md 等）此环境读不出来，其中「判为不成立」的理由我不能背书，作者或后续轮次如有新证据可再核对。
