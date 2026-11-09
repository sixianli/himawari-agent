改用 Read 工具读文件内容。
# P1-3 决策记录完整依据链 · 代码复核

对比基准 6f4f541... → 92dfb36（commit be8f6d62 读取端 + 92dfb36a 前端/文档）。

## 侧重检查（先列，因为答案在流程里）

我按「普通使用流程」从入口走到结束：

1. 入口：设置页 → `ProactiveAppsSettings` → 决策记录日志「依据」按钮出现条件是 `proactive.readChain` 非空（apps/control-center/src/components/proactive-reminders.tsx:634-643）；`readChain` 由 `installedGatewayV2Operations` 是否含 `decision.chain.read` 决定（apps/control-center/src/proactive.ts:98-99、197-206）。
2. 服务端安装：`PRODUCTION_MEMORY_OPERATIONS` 加入了新操作（apps/agent-service/src/production-memory-control.ts:49），同一名单同时喂给 approval gateway 的 `installedOperations`（production-approval-gateway.ts:252）和 `/api` 侧浏览器的 `installedGatewayV2Operations`（production-http-composition.ts:664），两处一致。
3. 路由：`decision.chain.*` 前缀分派给 memoryControl（production-approval-gateway.ts:104-106）；`ProductionMemoryControl#decisionChain`（production-memory-control.ts:436-500）组装依赖后交给 `readDecisionChain`。
4. 数据访问：`ledger.read` 按 owner+agent+id 限定（sqlite-decision-ledger-operations.ts:318-323）；`readMany` 同样按 owner/agent 限定（sqlite-memory-operations.ts:551）。
5. 出口：快照 schema 校验（测试里真实快照 `gatewayV2MessageSchema.parse`，test/integration/decision-chain.test.ts:249）、HTTP 错误映射 NOT_FOUND→404（packages/platform-node/src/http-gateway-server.ts:883-893）、客户端错误转成带 `status` 的 Error（gateway-client.ts:319-331）、`decisionChainGone` 两个判定都吻合（proactive.ts:330-334）。

流程结论：
- **已覆盖**：前端交互（按钮/缺项/gone/未安装不显示按钮）、后端读链全部业务分支、契约 round-trip、敏感隐藏泄漏用例。
- **未覆盖**：production-approval-gateway.ts:104-106 这一行前缀分派——集成测试直调 `control.query`（decision-chain.test.ts:247），浏览器测试走的是 e2e stub 服务器（test/integration/decision-chain-browser.test.ts:61-70，fake 的 `decisionChainFixture`，不经过真实网关）。若有人改坏 `decision.chain.` 前缀路由或从 `PRODUCTION_MEMORY_OPERATIONS` 漏掉，现有自动检查不一定会红（详见必答问题 3）。
- **文档一致性**：ADR 0193、写入约定、ADR 0106 第 4 条与症状一致处见下面发现 1（有一处不符）。

## 发现（按严重度从高到低）

**1. 严重度：中｜文档与代码不一致（本 PR 新增的约定 vs 现有写入路径）**
- 位置：docs/execution/specs/2026-11-09-decision-record-write-convention.md:38；packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:115-120；packages/application/src/services/automatic-memory-service.ts:570-573。
- 问题：「必须写的字段」表说 `usedMemoryIds`、`tentativeMemoryIds`、`memoryByMail` 由「用到记忆的所有种类」必须写，但通用落盘路径 `insertLedgerRow` 只会把 `memoryIds、ruleIds、batchId、resultMemoryIds` 四个键写进 `inputs` 列，其余字段在入库前就被丢掉；唯一的非 proactive 追加方 `automatic-memory-service` 也只传 `{memoryIds, ruleIds:[reasonCode]}`。proactive 类型走的是另一条完整写路径（sqlite-proactive-operations.ts:665-684），键与读取端完全对应，无问题。
- 证据：insertLedgerRow 的 `JSON.stringify({...})` 只列四个键（115-120 行）；spec 表第 38 行写「`memoryIds`、`memoryByMail`、`usedMemoryIds`、`tentativeMemoryIds` | 用到记忆的所有种类 | …不得只写数量」。
- 后果（读代码证实）：`memory_candidate` / `consolidation` 记录的 `usedMemoryIds` 键不存在 → 读取端该记忆 `usedByModel:false`（production-decision-chain.ts:227），界面永远不会出现「模型用到了」，也不显示「无记录」（无逐项的 not_recorded 状态）；抽屉把「写入方没写」和「模型确实没用」混为一谈。ADR 0193 第 61 行「老记录缺的字段显示无记录，不回填」在逐项粒度上没有兑现。
-（属于推测的部分：这只是显示语义缺口，不是数据错误；影响程度取决于 Andy 对 memory_candidate 链上「是否用到」的在意程度。）
- 建议：要么在 spec 表格里把这条现状写明白（generic append 只落四键、这两个种类的 usedMemoryIds 属「无记录」），要么让 `insertLedgerRow` 落盘完整 `DecisionInputs`（键存在性аракșteja保留，谨慎增量）。

**2. 严重度：低｜码点截断 vs UTF-16 长度校验不一致（继承自 overview 的既有模式，但本 PR 的快照分支也会踩到）**
- 位置：apps/agent-service/src/production-memory-control.ts:99-107（`singleLine` 按码点 `.slice(0, 2000)`）；packages/gateway-contracts/src/validation.ts:78-95（`boundedString` 用 `.length > maximum`，即 UTF-16 单元）；contracts-v2.ts:1050/1054/1058（`boundedString(2000)`）；apps/control-center/src/gateway-client.ts:268-272（响应在浏览器端再 parse 一遍）。
- 问题：正文含非 BMP 字符（emoji、许多汉字之外的扩展字）超过约 1000 个时，`singleLine` 保出来的字符串 UTF-16 长度可达 4000，`boundedString(2000)` 会判非法。服务端发出去后，浏览器端 `gatewayV2MessageSchema.parse` 抛错 → 抽屉显示「读取失败」。
- 证据：读到上述四段代码本身。memory 正文是否真可能超过 1000 个非 BMP 字符**未核实**（包括写入侧有没有正文长度上限）。
- 这是既有 overview 契约的同一模式，不算本 PR 引入；但 decision.chain 快照复制了它，且集成测试的文本都是短文，反向用例不存在。
- 建议：`singleLine` 改按 UTF-16 截断，或 `boundedString` 按码点计，二者取一，并加一条长 emoji 正文的用例。

**3. 严重度：低｜网关层分派没有直接测试**
- 位置：apps/agent-service/src/production-approval-gateway.ts:104-106。
- 问题：如「侧重检查」所述，三个测试层都没有经过真实的 `AgentGatewayV2Service` 分派 decision.chain.read。stub 服务器（test/e2e/fixtures/control-center-browser-server.mjs:1220-1225）是手写的假路由，它测不出真实网关漏配。
- 证据：decision-chain.test.ts:247（直调 `control.query`）；decision-chain-browser.test.ts:61（spawn 的 fixture 是 .mjs 假服务器）。
- 建议：在 `test/integration/production-http-composition-process.test.ts`（或同等真实服务测试）加一条经 POST `/api/gateway/v2/queries` 的用例，顺带把 404 行为也覆盖到。

**4. 严重度：低｜类型绕行 `as never`**
- 位置：apps/agent-service/src/production-decision-chain.ts:85-88（`ownerId as never`、`agentId as never`）、production-memory-control.ts:487-488（`readMany` 的 scope cast）。
- 问题：`DecisionLedgerScope` 要求品牌类型 `OwnerId/AgentId`，这里用 `as never` 绕过；运行时值来自单租户部署配置且 coincidentally 与其他已验证路径同源，读到代码为止没有发现实际风险。
- 建议：加一个受约束的转换（断言函数或经 `createOwnerId` 之类的校验），让编译器守住。

## 作者说法核对（读代码证实 / 推测）

| 说法 | 结论 |
| --- | --- |
| 不改发给模型的任何内容 | 证实：diff 未触及 prompt-catalog、runtime-pi、历史存储、工具定义；`decisION_RULE_CATALOG` 只被读取端引用（全仓 grep 仅 6 处，全在读取端+测试） |
| 只读已存记录、不重算、不加迁移 | 证实：新迁移文件 0 个；读链全部来自 `ledger.read`、`state.readMany`、`readBasisChain` |
| 复用 readBasisChain | 证实：production-decision-chain.ts:147-168 递归遍历 |
| 敏感记忆正文类字段不得返回 | 证实：三层把关——`views` 条目 `text/quote` 按当前记录可见性置 null（production-decision-chain.ts:218-247），`texts()` 按记录自身 `reviewMemoryVisible`（=仅 public/private 可见，daily-review.ts:135-137）置 null 并给 hidden 标——`basis` 节点正文双闸（228-230）；测试还断言序列化结果不含哨兵文本（decision-chain.test.ts:537-539）。`refs/threadId/messageId/importBatchId` 这类标识符即使隐藏也返回，属于标识符非正文，符合约束原文 |
| NOT_FOUND 关抽屉并提示 | 证实：production-decision-chain.ts:84 → http-gateway-server 404 → gateway-client Error(message=code, status=404) → decisionChainGone 两者都认 → drawer 走 onGone；单测与浏览器测试都断言 `decision-chain` 元素消失+提示出现 |
| 键不存在「无记录」、键存在且为空「这次没有」（靠 inputFields 区分） | 证实：readOne 取存储 JSON 的键排序（sqlite:325），`sectionState/readState` 以键存在性为准（production-decision-chain.ts:60-70）；用例 454-498（`inputs='{}'` 全 not_recorded）与 476-498（「这次没有」）都存在 |
| 「已知不是本 PR 引入：ADR 0191 有两份同号文件」 | 证实：glob 命中 `0191-record-…` 与 `0191-draft-…` 两份 |

纯推测部分已在发现 1、2 内标出。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？** 不会。全部改动是只读查询链、控制中心 UI、契约注册、纯测试和文档；没有一条代码会组装或修改发往模型的内容。「只在末尾追加、变化值在最后一条消息里」的前置结构本 PR 没有触碰；`check:prompt-prefix` 门存在且未被触碰。读代码证实。

**2. 会不会让同一段文字在不同请求里变成不同字节？** 就「发给模型的内容」而言：不适用（没有新内容进请求）。就本快照自身而言：顺序全部固定（`sortedUnique`、`Object.keys(...).sort()`、SQL `ORDER BY`），`floorMailCounts` 求和与遍历顺序无关，同库态下输出确定。会随时间变的值（评价/评价时间→`rating`/`ratedAt`，记忆 `updatedAt`→`changedSinceDecision`，记忆现内容）是「读当前状态」的语义本身，只出现在 UI 快照里，不进模型请求。发现 2 的 astral 截断不是「同一请求两次算出不同结果」类问题，它是确定性错误（同样的文本同样地坏）。读代码证实。

**3. 有没有对应自动检查、反向用例会不会真失败？** 有，且分层：
- `packages/gateway-contracts/test/gateway-v2.contract.test.ts:34-46` 对 `GATEWAY_V2_MESSAGE_TYPES` 全集（新两型经 governanceMessages 纳入，gateway-v2.fixture.ts:1025）做 parse+serialize round-trip；若名单与 schema 脱节必红（证实）。
- `test/integration/decision-chain.test.ts:519-543` 是反向泄漏用例：构造敏感记忆并断言序列化不含哨兵；若把关被移除，SENTINEL 会漏进 snapshot，用例失败（证实）。
- `decision-rule-catalog.unit.test.ts:17-29` 反向用例（未知 id、原型名、reason code）会失败（证实）。
- `check:operations`（gate 存在，package.json:32；反向用例见 ADR 0192 第 88 行）：新操作有后端实现/前端调用/真实测试引用（证实三者都有），但**反向覆盖不了**发现 3 的网关路由错配——若有人删掉 production-approval-gateway.ts:104 的前缀判断，`decision.chain.read` 仍在名单和实现里，检查不会报红（这是我对脚本的读法判断，脚本本身未逐行读——标「部分推测」）。
- 发现 1 的 spec「必须写字段」与发现 2 的 astral 用例当前均无自动检查（证实）。

**4. 每个产生/修改的值，使用点两端都能接受吗？** 逐个核对：
- `decision.chain.read`/`decision.chain.snapshot`：产生（contracts-v2.ts:62-65/2152-2153）→ 使用（生产安装名单×2、approval gateway 前缀分派、浏览器可用性判断 proactive.ts:98、fixture、三语 i18n）全部一致；fixture round-trip 兜底。
- `DecisionRecordRead.inputFields`：产生（sqlite:325，存储 JSON 键排序）→ 使用（readDecisionChain `sectionState/readState`）——proactive 写入的键（sqlite-proactive-operations.ts:665-684）与读取端引用的字段名逐一对应；generic append 只落四键的例外如实落为 not_recorded（但「模型用到了」语义缺口见发现 1）。
- `DECISION_RULE_CATALOG`：产地 proactive-rules.ts:44-59（键即 `FLOOR_RULE_IDS` 值，测试断言两集合相等）；唯一使用者是读取端；未登记 id → origin/document 为 null → 界面「未登记的规则」（zh-CN.ts:980），不猜；「依据文档 ADR 0106 第 4 条」我读了 ADR 0106，第 45 行正是地板规则，引用属实。
- 快照 schema 新枚举/字段：被 fixture（gateway-v2.fixture.ts:377-443）和真实快照 parse（decision-chain.test.ts:249）双向校验；`machineString` 的 decisionId 与既有 `proactive.review.read` 同约束。
- i18n 新 id：message-ids.ts 补了样值，zh/ja/en 三语全量补齐（grep 证实），`check:locale` 门在。
结论：除发现 1 的写入约定与通用落盘不一致外，两端校验均闭合。
