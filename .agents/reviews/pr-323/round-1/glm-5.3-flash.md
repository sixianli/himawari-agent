# 复核结论（PR 323 / P1-2，407e1b5d）

## 发现的问题（按严重度从高到低）

**1. 低 · apps/agent-service/src/production-approval-gateway.ts:103-119 —— `memory.basis.read` 没有从网关入口到存储的端到端测试**
证据：全仓库 `test/` 目录 grep `memory.basis` 无结果；唯一的读取测试 `apps/agent-service/test/production-memory-basis.unit.test.ts:94` 直接调 `control.query(read("insight"))`，绕过了 approval-gateway 的前缀路由（`query.type.startsWith("memory.")`）和 `PRODUCTION_MEMORY_OPERATIONS` 的对外通告。路由、通告和 scope 隔离都靠代码正确，没有自动检查兜底。
建议：补一条走真实网关装配的集成用例（可参照 `test/integration/production-http-composition-process.test.ts` 的做法）。

**2. 低 · packages/persistence-sqlite/src/sqlite-memory-consolidation-operations.ts:261-309 —— `readBasisChain` 只有深度上限（8），没有节点总数上限**
证据：`MEMORY_BASIS_CHAIN_MAX_DEPTH = 8`（行 39），walk 对每个节点的全部 parents 递归；一次 reflect 的依据可达 200 条（`insertConsolidationWrite` 允许 `basis.length <= 200`，行 46-47），扇出大时树是指数级的。网关侧 `BASIS_NODES_SHOWN = 200`（production-memory-control.ts:41）只截断输出，截断发生在整棵树算完之后。
建议：给 walk 加节点预算，超了就置 `truncated`。属推测风险：现有数据里 merge/supersede/archive 依据只有 1–2 条，reflect 通常几条，实际不太可能触发。

**3. 低 · docs/adr/0143-decision-ledger-for-model-gate-decisions.md:42、77 —— 文档与代码已不一致**
证据：0143 第 42 行写「账本行随 `recordChange` 在同一个事务里写入」，第 77 行写「之后才写 `recordChange`；这两步不在同一个事务里」。本次 PR 已删除 `recordChange`（端口、适配器、实现全删），并把账本行并进 `saveWithProjection` 事务（sqlite-memory-operations.ts:676-678）。ADR 0191 未声明 supersede 0143，0143 也未更新。
建议：在 0143 加一段「已被 0191 更新」的说明，或直接修订那两处。

**4. 低 · packages/persistence-sqlite/src/migrations/0084_memory_consolidation_basis.sql:9-21 —— 回填的兜底分支依赖「账本行要么找不到、要么记全」**
证据：第 2、3 条 INSERT 的兜底条件是 `NOT EXISTS (... WHERE b.change_id = c.id)`（整体无依据行才退回变更表两列）。若某条老变更的账本行存在且 join 命中，但 `inputs.memoryIds` 里漏了 `c.memory_id`（例如账本行本身不完整），兜底不触发，这条变更的依据链永久缺源头，且没有任何标记。
建议（推测性）：属于脏数据防御；可在审计脚本里加一条「非 reflect 变更的依据里必须含 memory_id」的核对。

**5. 信息 · packages/memory-engine/src/consolidation.ts:495-501 —— 失败后的 `#writeFailedAfterStaging` 判定分支实际不可达**
证据：`revise` 成功路径上回调先跑、事务一并提交，出错则整体回滚；「记忆版本已变但抛了 ApplicationPortError」或「回调已跑但版本没变」在单事务下都不可能出现，该分支只是防御。作者说法（「版本没变则视为整理事务内失败」向上抛）与代码一致，但没有测试能走到这个分支。

## 作者说法核对结果

以下说法均**读代码证实**：
- `saveWithProjection` 本就在 `.transaction(...).immediate()` 里存记忆、排任务、写账本（sqlite-memory-operations.ts:672-681），本次在其中追加变更行和依据行；`save()` 开头的 `assertDiskHeadroom()`（sqlite-memory-operations.ts:689）保留，旧 `recordChange` 里的磁盘余量检查没有丢。
- 迁移 0084 存在（migration-engine.ts sequence 84, phase "expand"），回填三条路径（按账本 memoryIds、退回 memory_id/related_memory_id、reflect 退回 related_memory_id）与描述一致，且有契约测试 `memory-consolidation-basis-migration.contract.test.ts:108-110` 逐条断言。
- 引擎改动（变更编号与版本前置计算、回调取版本、`ApplicationPortError` 处理）与描述一致。
- `readBasisChain` 按名下范围过滤（SQL 带 `owner_id = ? AND agent_id = ?`，行 278-280），跨 owner 查询返回裸节点——decision-ledger.test.ts:889-893 有断言。
- 「不新增模型调用、不改发给模型的请求」：diff 只触及写入/读取路径和网关读契约，未触及任何提示组装或模型调用点。
- 测试清单与 ADR 0191 所列一致（我逐一确认了存在及断言内容）。
- 「网关契约新增操作和控制端一致」：`memory.basis.read/snapshot` 已进 `GATEWAY_V2_MESSAGE_TYPES`、`schemasByType`、fixture，并被 `PRODUCTION_MEMORY_OPERATIONS` 通告（production-approval-gateway.ts:251、production-http-composition.ts:664）；控制端目前只用 `memory.overview.read`（control-center/src/memory.ts:70），ADR 已写明网页尚无依据链界面——一致。

## 侧重检查（流程走查）

我走了一条最普通的流程：**每日整理一次合并动作，从引擎入口到可查询**。
1. 调度触发 `MemoryConsolidationService` → `begin` 建 run → `#applyChange` 计算 changeId/createdAt → `DurableMemoryService.revise` → `saveWithProjection` 单事务（save + projection job + 账本 + 变更行 + 依据行）→ `finish`。**已覆盖**：memory-consolidation.test.ts（worker/direct 两模式，四类动作全部断言依据列表），decision-ledger.test.ts `[P1-2]`（原子性反例：依据含不存在记忆时拒绝、记忆保持版本 1、无变更行无账本行；成功后三者齐全）。
2. 反向用例是否真会失败：**推理证实成立、未实际执行**（我无权跑测试）。依据行 FK 违反发生在事务内（sqlite-memory-operations.ts:677-678），回滚则记忆停留在版本 1；若去掉事务，save 已提交、依据行才抛错，测试对 `revision: 1` 的断言（decision-ledger.test.ts:852-856）必然失败。FK 强制开启有保障（migration-engine.ts:986、sqlite-worker.ts:120）。
3. 读取流程：网关查询 → approval-gateway 按 `memory.` 前缀路由 → `ProductionMemoryControl.query` → `store.readBasisChain` → 快照过 `gatewayV2MessageSchema.parse`。**缺口**：第 1 段路由和第 2 段通告无集成测试（见问题 1）；store 的链读取、扁平化、200 截断、未安装拒绝、契约校验均有单测覆盖。

## 必答问题逐条回答

**1. 会不会改变模型已经见过的请求开头？** 不会。读代码证实：diff 未触及任何提示组装、工具定义、历史存储或遮盖代码；`createdAt` 从存后改为存前计算只影响变更记录元数据，不进任何模型请求；`reflect` 的提示仍由改动前的逻辑组装。发给模型的内容仍只在末尾追加，每轮会变的值仍在最后一条消息——本次改动根本没有碰模型请求路径。

**2. 会不会让同一段文字在不同请求里变成不同字节？** 不会。依据列表来自 `[...new Set(...)]`（保留插入序）、SQL 读回按 `ORDER BY position`、链节点按固定 BFS 序、链头用 `ORDER BY created_at DESC, id DESC` 固定平局；回填按 `json_each` 顺序。快照含时间字段但那是数据不是模型输入。没有任何依赖前后文的遮盖或无序集合进入模型可见内容。

**3. 有没有对应的自动检查、反向用例是否真会失败？** 有四层：迁移契约测试、`[P1-2]` 原子性用例（含 FK 违规反例）、整合流程断言、网关单测（含超限/未安装反例）。反向用例按事务+FK 机制推理必然失败，但我未能实际运行验证（环境不允许）。缺口是网关入口到存储的端到端路由无测试（问题 1）。

**4. 产生的每个值，两端都核对了吗？** 逐一核对通过：迁移号 84（migration-engine、schema-catalog、三个契约测试、workspace-lifecycle-audit.mjs 六处一致）；新表名在 schema-catalog 有登记且与 SQL/实现/测试一致；端口方法 `readBasis`/`readBasisChain` 在端口定义、适配器、dispatch case、控制端调用四处对齐；`recordChange` 删除后全仓库仅剩两处 ADR 文档引用（问题 3，文档未跟上）；网关新消息类型在类型清单、schema、fixture、通告清单四处对齐，控制端不受影响；`memoryId` 用 `machineString`（允许 `:`，长度 ≤128），与实际记忆 id 形态兼容。未发现两端校验不一致之处。
