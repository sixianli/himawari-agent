# 复核报告（PR 279 第 3 轮增量，ded1e61f）

## 侧重检查

巡视流程：主人发起 `proactive.replay.start` → gateway 合约校验（contracts-v2.ts，from/to=timestamp、mailLimit≤2000、budget≤5e6）→ `ProductionProactive.execute`（production-proactive.ts:546）→ `ProactiveReplayService.start` → `startRun`（SQLite）→ `#execute` → `createGmailHistoryReader.list/read`（生产网络路径）→ 新的 `Date.parse` 范围过滤（proactive-replay-service.ts:230-234）→ `#judge` → `recordResult` → `onReplay` 诊断日志（service-main.ts 增量）。

结论：该流程主干有集成测试（test/integration/proactive-replay.test.ts，含新用例）和 gmail-source 单测（上一轮已加）覆盖；**没有测试覆盖的路径**是增量改动本身的「范围外邮件被 Date.parse 过滤排除」分支——测试里的 4 封邮件全部在范围内（proactive-replay.test.ts:57-62，均在 2025-11），被过滤排除的情形从未被断言。另外 `start()` 与 `cancel()` 的竞态窗口（见下）也无测试。这与第 2 轮「测试覆盖细节按可以更好不改」的处理一致，但既然这次改动恰好就是过滤逻辑，该缺口值得点名。

## 发现的问题（按严重度从高到低）

**1. 低 · proactive-replay-service.ts:120-126, 141-145 · 取消标记永久锁存，“一律拒绝”只对生产成立**
- 证据（读代码证实）：`#cancelled` 只在 `cancel()` 置 true（:124），无任何重置处（全仓 grep 仅 4 处 `#cancelled`，即 ：109,:124,:141,:236）。生产中该 service 实例随 `ProductionProactive` 只建一次（production-proactive.ts:191-211），唯一调用 `cancel()` 的是 `stop()`（:222-227），只在关停生命周期被调用（service-main.ts:614 lifecycle）。所以“服务停止后 start 一律被拒”在生产成立，但 INSTANCE 级语义是“cancel 过一次，这个实例永远不能再 start”。
- 建议：如果想支持“取消本次、再起新回放”，需在 `cancel()` 完成且 `#active` 已结束后重置；若维持现状，作者说法里应写明是“关停后”，避免将来有人把 `cancel()` 用在运行中途。

**2. 低 · proactive-replay-service.ts:141-183 · cancel 与 start 仍有竞态，作者“一律拒绝”的说法不完全成立**
- 证据（读代码证实）：`start()` 在同步段检查 `#cancelled`（:141），随后 `await store.readConnection`（:162）`await replays.startRun`（:169）两个暂停点；`cancel()` 在此期间调用，该次 start 仍会启动成功。
- 推测+读代码：新 run 会在处理第一封邮件时被打断（:236 `if (this.#cancelled)`），但若范围内没有邮件，会以 `finished/COMPLETED` 正常结束，违反“服务停止后一律拒绝”的字面承诺。旧代码同样有此竞态，增量未引入新错误，只是说法过强。
- 建议：低优先；可在 `startRun` 前再查一次 `#cancelled`。

**3. 低 · test/integration/proactive-replay.test.ts:216 · 作者描述与代码不符：gate 挡在“列出”而非“读取”**
- 证据（读代码证实）：`gate` 在 `history.list` 内（`async list(input) { await options.gate; ... }`），不是 `history.read`。“回放卡在读取时 cancel”应作“卡在列出时”。不影响测试有效性，仅描述偏差。

**4. 低 · proactive-replay-service.ts:230-234 · Date.parse 过滤无排除方向的用例，且对 NaN 静默排除**
- 证据（读代码证实）：过滤依赖 `Date.parse(receivedAt)`；生产端 `receivedAt` 恒为 `new Date(...).toISOString()`（gmail-source.ts:198），绝不为 NaN，所以本次改动安全；但测试 fake 的 `receivedAt` 无格式约束（proactive-replay.test.ts:46），且没有任何用例传入范围外邮件验证排除。若将来 `instant()`（:63-66）被放宽，NaN 会让邮件静默落选而无测试报警。
- 建议：给新测试补一封范围外邮件，同时断言它不在 `judged` 结果里（顺带覆盖第 2 轮遗留的“listed 含范围外邮件”计数）。

（无中/高严重度发现。）

## 必答问题逐条回答

**Q1 会不会改变模型已见过的请求开头？** 不会（读代码证实）。增量只动了服务控制流（新增 ：141-145 的拒绝检查、删除清标记行、范围过滤）和测试 fixture；未触碰系统提示、工具定义、历史、遮盖的组装（proactive-mail-check-service.ts 增量为零）。回放对每封邮件是独立的 `ProactiveMailCheckService` 运行，消息组只有“固定指令→该邮件数据→asOf”，无历史累积、无追加问题。被 STOPPING/ALREADY_RUNNING 拒绝的 start 根本不产生模型调用；`Date.parse` 过滤只决定哪些邮件进入判定，不改变任何已发送内容的字节；`judged/listed` 只进 DB 和诊断日志。每轮会变的值仍只在判定请求尾部（asOf=item.receivedAt），增量未新增此类值。

**Q2 会不会让同一段文字变成不同字节？** 不会（读代码证实）。新增的输出只有常量错误码字符串和按 run 的诊断日志；`Date.parse` 仅运行期择优，输入恒为 canonical ISO（gmail-source.ts:198），结果确定；无新时间字段、无新无序集合、无前文依赖的遮盖。

**Q3 有没有自动检查、反向用例会不会失败？** 有：test/integration/proactive-replay.test.ts:575-598。反向推演（代码路径推演，非运行——工具受限不能跑测试）：把 `this.#cancelled = false;` 恢复到原位置（:165 附近，即 connection 检查后、startRun 前）并移除 STOPPING 检查，则第三次 start 先清标记再撞 ALREADY_RUNNING → `message:"PROACTIVE_REPLAY_STOPPING"` 断言失败；打开 gate 后运行不会被 ：236 打断、会判定邮件 → `status:"interrupted"`、`judged:0` 两条断言也失败。所以新测试确实能证明修复。反向验证结论为推演，标注。

**Q4 每个新值两端都要能接受？** 逐值核对（读代码证实）：
- `PROACTIVE_REPLAY_STOPPING`（service:31,144）：消费方为测试的 `rejects.toMatchObject`；gateway 合约不对 `ApplicationPortError` 的 message 做白名单（contracts-v2 无该枚举），传播路径与既有 `ALREADY_RUNNING` 完全相同；顶层码 `PORT_ERROR_CODES.CONFLICT` 存在（ports/common.ts:21）。通过。
- `Date.parse(request.from/to)`：入口端 `instant()`（:146-149）保证精确 ISO；契约端 `timestamp` 校验（contracts-v2）双向一致。
- `mailLimit/budgetMicros`：合约 `integer(1,2000)`、`integer(1,5e6)` 与 `PROACTIVE_REPLAY_MAIL_LIMIT=2000`、`PROACTIVE_REPLAY_BUDGET_LIMIT_MICROS=5_000_000`（proactive-replays.ts:19-20）一致。通过。
- `judged`（测试与 service-main 诊断使用）：DB 列 `NOT NULL DEFAULT 0`（0079_proactive_replays.sql:13），readRun 映射（sqlite-proactive-replay-operations.ts:28），recordResult 递增（:222）。一致。
- `gate`（测试 option）：仅测试内部使用。

未核实：docs/incidents-and-gates.md 中 I-73/I-78 原文、gateway 侧给 owner 展示错误码的最终 UI 文案（未读到展示端代码；但码的传播路径已核实）。
