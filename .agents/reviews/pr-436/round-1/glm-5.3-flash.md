# PR 436 复核报告（c53274cd vs 0d989adb）

## 侧重检查（先查了测试覆盖、文档一致性和一条端到端流程）

**走过的流程**：模型调 `rule_set` → `ProductionOwnerRuleTools` → `ProductionOwnerRuleWriter.create`（production-owner-rules.ts:691-737）→ `proposals.propose`（sqlite-owner-rule-proposal-operations.ts:92-162）写表行 + `#writeText` 写加密载荷 → 回执进模型可见的工具结果；主人侧：控制中心 `useMemory` 用 `installedGatewayV2Operations` 门控发 `memory.ruleProposals.read`（apps/control-center/src/memory.ts:99,135）→ `PRODUCTION_MEMORY_OPERATIONS` 含该操作（production-memory-control.ts:68），经 production-http-composition.ts:680-683 公布 → `#ruleProposals`（production-memory-control.ts:533-576）→ `listProposals` 逐行解密载荷 → 卡片渲染 → `memory.rule.respond` 的 confirm/reject → `ProductionMemoryControl` 分发（production-memory-control.ts:1277-1295）→ `writer.confirm/reject` 用 `decide` 互斥认领（production-owner-rules.ts:758-820）→ `#activate` 写规则。

**结论**：主流程各段都有测试（真实 SQLite 的 [A-1] 六个用例、契约 fixture、迁移契约测试、UI 单测）。没有测试覆盖的代码路径（读代码证实）：
1. 真实 HTTP 网关把 `memory.ruleProposals.read` 路由到 `ProductionMemoryControl` 的 dispatch 段——全仓库没有任何 e2e/浏览器用例引用 `ruleProposals`（grep 证实），集成测试是直接 new `ProductionMemoryControl`。
2. 两处生产接线（service-main.ts:1490、production-http-composition.ts:1108）只有 mock 键名单（service-orchestration.unit.test.ts:733）覆盖。
3. `confirm` 里 `release()` 失败被吞（production-owner-rules.ts:793 `.catch(() => undefined)`）与“载荷缺失时认领后退回”分支。
4. `propose` 的 "refreshed"/"reopened" 对 `origin` 的行为差异（见下）。

## 按严重度排列的问题

**低 1**：apps/agent-service/src/production-owner-rules.ts:698-706 — 提议编号哈希从 `JSON.stringify` 改为 `canonicalJson`，但旧库里已存在的 pending 行不会迁移。同一内容升级后再提，新 id 可能对不上旧行 → 同一内容出现两条待采纳（一条旧行、一条新行）。（读代码证实：git diff 中的旧实现与现行实现；两条都确认/都拒绝均无害，因为 `#activate` 幂等，危害是列表重复。）建议：accept 即可，或在 CHANGELOG/文档标注一次性重复的可能。

**低 2**：packages/persistence-sqlite/src/sqlite-owner-rule-proposal-operations.ts:104-112 — "refreshed" 分支只更新 `expires_at`、`proposed_count`，不更新 `origin`/`thread_id`。同一提议先以“推断”入列，后来主人原话再提（非 standing quote，走 owner_said 提议路径），列表仍显示“Himawari 推断的”。（读代码证实；“reopened” 分支反而会更新 origin:121-141，两条路径不一致。）建议：refresh 分支同样写 `origin = ?`。

**低 3**：sqlite-owner-rule-proposal-operations.ts:121-141 — 对已 `accepted`（规则已生效）的提议再次 propose 会无条件把状态重置回 `pending`，列表会重新出现一条规则其实已在生效的“待采纳”卡片；再点确认走幂等激活，无数据损坏，但易误导。文档（architecture-v0.1.md:420）只写了“同样内容再次提议重置为待采纳”，没区分 accepted 分支。（读代码证实。）建议：accepted 分支直接返回 "refreshed" 语义或跳过，不退回 pending。

**低 4**：apps/agent-service/src/production-owner-rules.ts:783-794 — 认领后退回失败被 `.catch(() => undefined)` 吞掉，行停在 `accepted`；此后主人点“不要”永远报 `RULE_PROPOSAL_ACCEPTED`（reject:818），虽然规则并没写成。可经再次确认（幂等路径）恢复。（读代码证实，测试未覆盖此分支。）

**信息 1**：production-owner-rules.ts:691 — `ownerSaid` 求值顺序改变：现在对非 standing quote 也会执行一次 `#ownerSaid`（原来 `isStandingQuote` 短路跳过）。纯读、行为等价，只是每次 create 多最多 200 条消息的扫描。（读代码证实：改动前后条件 `ownerSaid && isStandingQuote` 等价。）

**信息 2**：production-memory-control.ts 的 `#ruleProposals` 对每行串行 `#readProposal` 解密，上限 20 行时每次列表要 20 次 unprotect——成本可接受但值得知道。（读代码证实。）

**信息 3**：反向用例中“未知动作报错”一条（integration 测试 `action: "forget"`）判别力弱：旧代码把它当 `undo` 也会以 `RULE_NOT_FOUND` 之类抛错；其余反向用例（race 只赢一个、`RULE_PROPOSALS_FULL`、`RULE_PROPOSAL_EXPIRED`、`RULE_PROPOSAL_REJECTED`、`RULE_PROPOSAL_ACCEPTED`、键序同 id）判别力强，撤掉新代码必然失败。（推测+读代码：旧代码 diff 中 else 分支即 `undo(target)`。）

## 作者说法核对（读代码证实）

- 「旧版把 confirm/reconfirm 以外动作当撤销」——属实（旧 diff 中 `: (await control.undo(target)).ruleId`）。
- 「认领 pending→accepted，失败退回 pending」「对 accepted 再采纳幂等」「无表行提议走载荷路径、不能拒绝」「同样内容重置待采纳保留拒绝次数」「键序固定进哈希」「上限/过期随响应返回」「MCP `listed:false` 不进表、当场可采纳」——全部与代码一致（各处行号见上）。
- 「本容器已通过 typecheck/lint/…」——**未核实**（本环境不能运行命令）；计划/任务文件路径在仓库外——**未核实**。
- 文档：architecture-v0.1.md:420 新段落逐句与代码一致；i18n 三语资源、`MESSAGE_IDS`、schema-catalog、审计脚本 95、迁移契约测试同步更新，无脱节。

## 必答问题逐条

1. **不会改变模型见过的请求开头。** diff 未触碰任何系统提示、工具定义、提示词目录、遮盖文件；`rule_set` 返回给模型的 receipt 字段与改前完全相同（trials/replay 值相同，只是提出来复用）；唯一新增的模型可见行为是 `RULE_PROPOSALS_FULL` 错误路径，它只出现在新状态（待采纳满 20 条）且属于末尾追加的工具结果。新表/新快照/新 UI 全部走控制中心通道，不进模型请求。`check:prompt-prefix` 未在本环境运行（未核实），但没有模型面文件被改。
2. **不会。** 哈希输入改用 `canonicalJson`（排序键、滤 undefined，production-owner-rules.ts:367-377），同内容同字节，且有键序反向测试；列表快照顺序固定（`ORDER BY proposed_at, id`）；载荷证据只在首次提议写入（`#writeText` 见 ref 即跳过，:447-459），确认时读存档不重算（:801）。每请求变化的只有响应里的 `generatedAt` 与每次 create 重算的 replay/试算——后者只进末尾追加的工具结果，符合“每轮会变的值在最后一条消息”。
3. **有，且反向用例基本真会失败。** test/integration/production-memory-capture.test.ts `[A-1]` 六个用例（真实 SQLite、无替身，直接查表断言 rules/memories 计数不变）覆盖列出/采纳/拒绝/竞态/上限/过期/键序/无证据旧行；契约 fixture、迁移契约测试、UI 单测（含“不要”按钮和拒绝回执文案）齐全。唯一弱判别是“未知动作”一例（见信息 3）。测试运行结果未核实。
4. **逐值核对通过。** `proposalId`（`rule-proposal:`+32hex，46 字符）过 `machineString`（validation.ts:49-60，允许 `:`）与 sqlite `PROPOSAL_ID` 校验一致；`origin`/`status` 枚举在端口类型、DB CHECK（0095 迁移）、契约 enumeration、i18n select 四端一致；`summary`/`rule_type` 长度有安全余量（DB 400/64 vs 代码 200/固定类型名）；时间戳 `valid()` 要求 toISOString 精确回环，与 DB GLOB 格式匹配；`limit`/`expiresAfterDays` 从 `#limit()`/`#ttlDays()` 产生、契约要求 ≥1、UI 直接显示响应值不写死；迁移 95 的登记、目录、审计脚本、契约测试四处同步；`memory.ruleProposals.read/snapshot` 同时进了消息类型表、schemasByType、`PRODUCTION_MEMORY_OPERATIONS`、UI 门控，满足 check:operations 的“后端+调用方+测试”三要素。
