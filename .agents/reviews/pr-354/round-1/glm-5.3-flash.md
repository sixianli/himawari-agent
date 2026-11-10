Bash 只允许 git 命令，改用 read/grep 读文件。
node_modules 不存在，Pi 锁定版本源码读本仓库无法核实。先读仓库内的关键代码。
# PR 354 第 1 轮代码复核（独立复核者）

先说环境限制：本检出里 `node_modules` 不存在（glob 找不到 `@earendil-works/pi-coding-agent` 的任何文件），Pi 1.5.0 的 dist 源码、`docs/sdk.md`、`docs/extensions.md` 都无法亲自读取；Bash 只允许 git 命令，无法跑测试。凡依赖这些的结论都标了「未核实」。

## 发现（按严重度从高到低）

**1. 中 · docs/pi-development-guide.md:351 · D5 行「官方写法」列与 ADR 0204/代码矛盾**
- 问题：该行「位置」列已写明“读历史和工具已在 2026-11-10 改成 `session.messages`、`session.getToolDefinition`”，但同一行「官方写法」列仍写“`continue`、`hasQueuedMessages` 和**读工具的执行方式（executionMode）在 `docs/sdk.md` 里没有会话层接口，需要另查”。
- 证据：偏离表该行（读到的原文如上）对比 `docs/adr/0204-handle-pi-deviations-d2-d3-d5.md` 前提 3（“官方的会话接口能按名字取工具定义”）和决定 2（"判断工具能否并行改成 `session.getToolDefinition(name)?.executionMode`"）。照偏离表这句，新写法仍然是“未定走向、需要另查”的偏离，照表的规则（“批准前，新代码不得照抄”）它就不该被本次提交采用。
- 建议：把「官方写法」列补上 `session.getToolDefinition`（1.5.0）并删掉“需要另查”里关于 executionMode 的半句。

**2. 中 · docs/adr/0204…md:37–41 · 三条 Pi 源码前提在本检出无法核实（未核实，非证实有错）**
- 前提 2（`agent-session.js:1248` 的 `get messages`）、前提 3（`agent-session.js:1123` 的 `getToolDefinition`、`tool-definition-wrapper.js:11`）、业界一节引用的 `docs/sdk.md` 第 40 行——`node_modules/@earendil-works/pi-coding-agent` 不存在，我读不到。行为等价目前只由“行为锁”测试间接支撑（见必答 3），没有任何测试直接断言两取法恒等。
- 建议：在装有 1.5.0 的主机上，用 `node -e` 把 `session.messages` 的 getter、`getToolDefinition` 的实现和 `tool-definition-wrapper.js:11` 打印出贴进 ADR，或本轮复核材料附 pi pack 的 tarball 路径以便离线核对。

**3. 低 · packages/runtime-pi/test/tool-batch-state.unit.test.ts:56 · “未注册的工具调用”分支无专门用例**
- `getToolDefinition` 对 `"read"` 以外的名字返回 `undefined`（第 57 行），而夹具里两段 toolCall 的名字都是 `"read"`，所以 capture 时"call.name 查不到定义 → parallel 不置 true"这条路径没有任何测试走到；compat 测试也只有 parallel/sequential 两个方向。
- 推测：旧行为（`agent.state.tools.find` 找不到）同样返回 false，两者在该分支等价，风险不大；但如果 Pi 的 `getToolDefinition` 与 `agent.state.tools` 覆盖面不一致，正是在这一分支会露馅。
- 建议：加一条用例：助手消息里出现一个未注册工具名，断言 `capturePiToolBatch` 不置 `parallel` 且仍能通过校验。

**4. 低 · packages/runtime-pi/test/model-accounting.unit.test.ts:178、runtime-event-contract.unit.test.ts:110 · 这两个假会话没有 `messages`（未核实运行，但从代码看如此）**
- 它们的 `createSession` 返回的对象只有 `agent/subscribe/prompt/waitForIdle/abort/dispose`。我核对过它们各自投影都没有 `captureHistory`（model-accounting:148–158；runtime-event-contract:100–105）且不触发 `compaction_end willRetry`、不含 builtin-coding 的 write/edit，所以当前不路过本次改的行；但一旦这些测试将来触及历史捕获或压缩补发，会以 `TypeError` 而不是断言失败的形式炸掉。
- 建议：给这两个 fixture 也补一个 `get messages()`，代价很小。

**5. 信息 · 复核简报与代码有小出入（读代码证实）**
- 简报说“三个测试文件的假会话同步加 `messages`、`getToolDefinition`”。实际：`pi-runtime-adapter.compat.test.ts` 只加了 `get messages`（419–424 行）；`tool-batch-state.unit.test.ts` 加了 `messages` 和 `getToolDefinition`（55–57 行）；`pi-tool-batch-continuation.compat.test.ts` 用的是真 Pi 会话，没有"假会话"，改动只是把断言读法从 `second.agent.state.messages` 换成 `second.messages`（107、172 行）。

**6. 信息 · fakeSessionFactory 的 `get messages` 只复刻了前提 2（pi-runtime-adapter.compat.test.ts:422–423）**
- 它返回 `this.agent.state.messages`，所以假会话测试永远无法发现"`session.messages` 与 `agent.state.messages` 不等"这类上游偏差；这类偏差只能靠走真 Pi 的 compat 测试间接兜底（continuation、durable、file-conflict 那几条走的是真 Pi）。

## 侧重检查（流程走查与覆盖结论）

走查最普通的一条流程（读代码证实）：用户消息 → 投影 → `PiAgentRuntimeAdapter.run` → `createAgentSession`（`noTools: "all"`，`tools: descriptors.map(({name}) => name)`，全部 descriptor 同时进 `customTools`，pi-runtime-adapter.ts:1560–1562）→ 模型流出 → 每次 `message_end`/`compaction_end` 捕获历史（1679–1691，走 `session.messages`）→ 工具执行前先 `reconciliation.checkpoint` → `capturePiToolBatch(active, …)`（1536，走 `session.messages` + `getToolDefinition`）→ 等审批时 `suspend` 存快照 → 新 run 用 `piToolBatchSessionManager`（1519）重建 → `restorePiToolBatch`（1618）回放 → 会话结束。另一条分支：write/edit 工具执行前用 `previousFileConflict` 读会话历史（2006–2012）。

覆盖结论：上述每一处改动的读取点都有对应测试——历史捕获/“按发送的原样存”在 pi-runtime-adapter.compat（2815 等）和 `check:prompt-prefix`；压缩后补发运行环境说明有 `it.each([true,false])`（1611–1676，假会话）；批捕获/回放有真 Pi 的 compat 两条（NL-1 与 sequential 续跑）加适配器层审批续跑用例（2736、3093）；文件冲突链有 3949 专门用例。`model-accounting`、`runtime-event-contract` 这条盲点见发现 4。

## 必答问题逐条

**1. 会不会改变模型已经见过的请求开头？**
不会（依据读到的代码 + 前提未核实）。六处改动全是“读”：历史捕获写的是产品库（1682–1688），压缩补发说明的追加时机与内容逻辑未改（1700–1705，只是换了等价读法），文件冲突检查是纯内存判断（2006–2012），capture/restore 只影响续跑校验不组装请求。请求开头仍由未动的 D1 `streamFunction`（1621–1650）组装，仍然只追加；每轮变化的值（steer 里的 `timestamp: Date.now()`，1705）本来就在追加消息里且本次未改。前提“getter 返回同一数组”未在本环境核实，但有真 Pi 行为锁测试兜底。

**2. 会不会让同一段文字变成不同字节？**
不会（读代码证实）。`runsInParallel` 的结果在 capture 时算一次存进快照，restore 时（159 行）重新算并要求与快照一致，否则 `PI_CONTINUATION_PARALLEL_BATCH_INVALID` 抛错而不是悄悄变字节；两次计算查的都是同一会话的同一注册表（会话间工具集合由同一 `descriptors` 列表重建），没有引入时间、无序集合或前后文依赖。

**3. 有没有自动检查、反向用例会不会失败？**
有（读代码证实，未在本机运行）：`check:pi-compat`（package.json:67）跑 pi-compat 项目 = `packages/runtime-pi/**/*.compat.test.ts`（ci/policy.json:187–188），而该项目也在 `scripts/ci/check-policy.mjs:35` 的必备集合里；`check:prompt-prefix`（package.json:55，scripts/check-prompt-prefix.mjs:9–24）带 [I-66] 反向用例。本次的正向锁是 NL-1（`getToolDefinition` 语义一变，`parallel: true` 断言或恢复时的 PARALLEL_BATCH_INVALID 会失败）和 sequential 续跑用例；反向锁是 tool-batch-state 的 `PI_CONTINUATION_PREFIX_INVALID` 用例（103–105 行）。注意：反向用例覆盖的是"前缀校验必须拒绝"，没有人造出“Pi getter 与 state 不等”的反向用例（见发现 2、6）。

**4. 每个新值的两端校验都接受吗？**
逐个核过（读代码证实，Pi 端实现未核实）：`messages` getter——生产点 adapter 1680/1701/2009 与 capture（继续 35 行），全部传真 Pi 会话（`created.session` 存进 `#activeSessions`，1652），测试假体已补；`getToolDefinition`——只在 `runsInParallel`（75/159），custom 与 builtin-coding 工具同走 `customTools` 注册，真实 Pi compat 证明按名能取到带 `executionMode` 的定义；`parallel? true`——capture 产生、checkedBatch（118 行 completedResults 长度）和 restore（159 行）消费，两端一致；`BatchSession` 类型收窄——两个调用点（1536、1618）都传全量 AgentSession，测试假体同批改。未发现一端校验拒绝另一端产出的地方。
