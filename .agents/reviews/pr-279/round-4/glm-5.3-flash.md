# 复核报告（PR 279 第 4 轮：合并 main → fe2a7a5）

## 结论提要

核对 `dd47078..fe2a7a5`（合并带进来的全部 68 个文件）：内容与 origin/main 的 PR #270（CI 搬 OVH VPS）逐文件对应，全部是 CI/运维脚本、CI 策略、文档、测试字符串和 `.agents/` 记账；**没有改任何业务代码，作者说法属实**。分支侧（7b549e3..fe2a7a5 的回放功能）在合并中未被触动。迁移号 0079、三份迁移合同测试的期望号、导出/接线、schema-catalog 均一致，没有冲突或碰坏。发现的问题集中在回放功能本身的接线与细节（下面按严重度排列）。

## 问题列表

**1.〔中〕proactive.replay.start 没有任何生产可达的发送方，结果也无读取消息类型**
- 文件：apps/agent-service/src/production-proactive.ts:48,546-556；packages/gateway-contracts/src/contracts-v2.ts:44,609-618,2276；apps/control-center（无匹配）
- 证据（读代码证实）：命令类型已注册进网关契约、被 `ProductionProactive.execute` 处理、并广播进 `installedGatewayV2Operations`（production-http-composition.ts:664）；但 `apps/control-center` 全文 grep "replay" 只有 `replayed`（幂等状态）字样，没有任何 UI 发送该命令；`readRun`/`listResults` 只在 `durable-adapters.ts:1084-1097`、测试和 service 内部出现，契约里没有对应的 read/snapshot 消息类型。schema-catalog.ts 自己写明 "deleting a single run is not exposed to the owner yet"，但“开始回放”同样未暴露。
- 建议：要么下轮接 UI（含一个 replay run 读回类型），要么在本轮说明这是分阶段交付；否则“用户发起回放”这条普通流程在生产上不存在。

**2.〔中低〕整轮回放没有总时限，最多可占用唯一 running 槽很久**
- 文件：packages/application/src/services/proactive-replay-service.ts:210,222-228,289-311
- 证据（读代码证实）：每封邮件判定各自拿到完整 `perCheckMs` 截止（每个 item 新建一个 `ProactiveMailCheckService`，deadline = 当前钟 + perCheckMs），列表/读取每次也是独立 `AbortSignal.timeout(perCheckMs)`。`mailLimit` 上限 2000、每轮唯一 running 索引锁住 (owner, agent)（0079 SQL 唯一索引）。整轮只有 `budgetMicros`、连续 3 次失败或 `stop()`（仅服务停机时触发）能结束。
- 建议：加整轮 wall deadline 或按预算/时长上限终止。

**3.〔低〕上限常量四处硬编码，三处没有合同测试兜底**
- 文件：packages/gateway-contracts/src/contracts-v2.ts:609-618（`integer(1, 2000)`、`integer(1, 5_000_000)`）vs packages/application/src/ports/proactive-replays.ts:32-34 vs packages/persistence-sqlite/src/migrations/0079_proactive_replays.sql:9-10 vs sqlite-proactive-replay-operations.ts（后者引用 port 常量，一致）
- 证据（读代码证实）：本次核对四处数值一致；集成测试只反向覆盖 service 端 2001/5_000_001 被拒（proactive-replay.test.ts:348-360），没有测试钉住 contracts、port、SQL 三边同时改的漂移。注意 gateway-contracts 不能 import application，无法直接复用常量。
- 建议：在合同测试里用字面量同时断言三边相等。

**4.〔低〕三个错误恢复分支没有任何测试覆盖**
- 文件：sqlite-proactive-replay-operations.ts:207-211,219-227；proactive-replay-service.ts:268-271
- 证据（读代码证实）：`markListed`/`recordResult` 的 UPDATE 带 `status='running'` 条件，运行已结束时静默不写入；`recordResult` 返回 `false` 时 service `#execute` 释放封存文字后**直接 return，不 finishRun**（此时 run 已被别处 finish,可接受但无断言）；`ON CONFLICT DO NOTHING` 后抛 `PROACTIVE_REPLAY_DUPLICATE_RESULT` 的路径无用例。反向用例（先 finishRun 再 recordResult）缺失。
- 建议：补三个小用例钉住这些静默路径的预期行为。

**5.〔低〕PROACTIVE_OPERATION_NOT_INSTALLED 抛裸 Error**
- 文件：apps/agent-service/src/production-proactive.ts:548
- 证据（读代码证实）：其他 case 都用 `ApplicationPortError` + 错误码；这里 `throw new Error(...)`。（推测：HTTP 层对未分类错误可能映射为普通 500，未经核实到映射点。）
- 建议：改成与其他分支一致的 `ApplicationPortError`。

**6.〔低〕Gmail 404 的邮件被静默跳过**
- 文件：packages/platform-node/src/gmail-source.ts（history.read 内 `const item = message ? gmailItem(message) : undefined`）
- 证据（读代码证实）：list 出来、读取前被删除/移动到不返回 404 状态的邮件直接消失，`listed` 计数与实际判定数不符且无 reason_code。对审计型功能（回放评估历史判断）这类静默缺口值得留意。
- 建议：跳过时至少在结果里记一条 `skipped/READ_message`。

**7.〔低，侧重：文档〕docs 下没有这个功能对应的设计记录**
- 证据（读代码证实）：对 `回放|replay` grep docs 未命中与「历史邮件回放」相关的 ADR/计划/Backlog（命中的都是语义无关的旧文档）。本仓库惯例（document-governance）要求新设计决策留 ADR。（推测：可能计划在下轮补，未经核实。）

## 侧重检查（走过的一条普通流程 + 未覆盖路径）

流程：Owner 打开控制中心 → 发起历史邮件回放。
1. 前端：**断**（问题 1）。`proactive.replay.start` 只在契约、`execute`、集成测试三处出现，控制中心无调用。
2. （假设有调用方）HTTP 网关 → `gatewayV2MessageSchema`（contracts-v2.ts:2276 注册）→ `installedGatewayV2Operations` 广播（production-http-composition.ts:659-669）→ `production-approval-gateway.ts:251` 的安装清单（未核实 HTTP 服务器内部调用 execute 的确切行）。
3. `ProductionProactive.execute`（owner/scope 校验）→ `ProactiveReplayService.start`（时间/上界校验、已连接校验、唯一 running 槽，服务侧全部有测试）。
4. `#execute`：取 token → `history.list`（分页、limit、去重，gmail-source 单测覆盖正向+未授权+失败）→ 分块 read → 区间过滤 → 逐封 `#judge`（隔离 store、asOf=receivedAt、无 memories、不报告遮盖，integration 测试逐条断言）→ `recordResult`（judged/cost 累计 + SQL CHECK）→ 释放 model payload → FAIL/预算/完成三类收尾（测试覆盖）。删除/清空/断开源 释放封存文字（sqlite-proactive-operations.ts:419-424,453-458 + 测试）。
   - 未覆盖路径：`stored === false` 分支、`markListed`/`recordResult` 对非 running 的静默（问题 4）；`service-main.ts` 的生产装配（`createGmailHistoryReader`、`onReplay` 诊断日志）没有进程级用例；`ProductionProactive.start()/stop()` 对 replay 的 `interruptStale()/cancel()` 的组合只在 service 层单独测过（test:379-399,473-487 用的是 `ProactiveReplayService` 直调）。
5. 结果读取：生产无入口（问题 1）。

## 必答问题逐条回答

1. **会不会改变模型已见过的请求开头？不会。** （读代码证实）合并进来的 main 改动全是 CI/运维/文档/测试；唯一业务测试改动是断言字符串英→中（test/integration/production-http-composition-process.test.ts）。分支侧对 `ProactiveMailCheckService` 只加 `asOf`：未传时 `startedAt = clockAt`，与旧行为逐值相同；`deadlineAt` 改用 `clockAt` 计算后生产路径数值不变；`durationMs` 用 `trace.clockAt`，生产路径结果不变（proactive-mail-check-service.ts:400-403,1007）。回放请求是全新的一次性判定请求，轮间变化的值（时间 now、批次邮件）都在同一条 user 消息里、且 `MAIL_JUDGMENT_NOW` 渲染在提示末尾（proactive-mail-check-service.ts:266-272）；面具/遮盖结果不进入回放请求（onMasked 未装配，test:571-572 断言）。仍然满足“只在末尾追加、变化的值在最后一条消息”。
2. **同一段文字会不会变成不同字节？不会新增这种风险。** （读代码证实）回放提示里的时间值 = `item.receivedAt`（#judge `asOf`,service:306）固定不变；“今天”由它派生（proactivePrompt:259-265）；遮盖是纯函数、正文窗口只依赖固定的 bodyLimit（proactive-mail-check-service.ts:222-249）；回放不传 memory，无回忆内容参与。`judgedAt`、runId、cost 等变化值只落库/作为 resultRef，不进请求。production 定时检查路径和以前一样每次用 `clock.now()`，无变化。
3. **有没有对应的自动检查、反向用例会不会失败？大部分有。** 迁移：三份迁移合同测试期望全部升到 79（CURRENT_SCHEMA_SEQUENCE、appliedSequences、minimum_writer），`scripts/check-audit-schema-range.mjs:16-27` 是一个会拦“审计脚本落后于最新迁移”的自动门槛。契约：v2 round-trip 逐类型校验（compatibilityMessages 经 governanceMessages 包含新类型，fixture.ts:1021-1037），未知类型/非法载荷反向用例仍在。服务/SQL：15 个用例覆盖非法区间、超限、重复 running、停止时序、删除释放遮盖文字等。main 侧 CI 搬迁的反向用例（混写标签、未暂停 macOS、错时限、残留 hermes-home、缺 Chromium）在 policy.test.mjs/ci-runner-scripts.test.mjs 里都会 throw。缺口见问题 2、4、6（三个静默分支无用例）。
4. **每个新值两端校验都能接受吗？逐值核过，除下述小项外可以。** `proactive.replay.start`：schema `integer(1,2000)/(1,5_000_000)` = 服务校验(148-157) = port 校验(sqlite 168-173) = SQL CHECK(0079:9-10)，一致；`reasonCode ≤64`、枚举 outcome/status、bool↔int、`message_id/thread_id ≤256` 两端一致（validResult 57-77 vs 0079 SQL CHECK）。`content_ref REFERENCES payloads(ref) ON DELETE RESTRICT`：先删引用行再释放封存文字（978/1 0079 FK 与 sqlite:100-110,327-342 对齐），与 schema-catalog 描述、clearRecords/removeSource 级联实现一致。唯一 running 索引与 `startRun`/`interruptStale` 语义一致（有测试）。遗留小项：上限常量三处硬编码无自动钉子（问题 3）；“结果快照”没有对应的读取消息类型，schema-catalog 只按表描述（问题 1）。`resultRef = proactive-replay:${runId}` 目前只有测试解析；按 ADR 幂等键重放原结果由通用 command_results 层承担（文档说法，未逐行核实到执行点，标「未核实」）。
