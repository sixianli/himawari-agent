# PR 323（P1-2）独立复核

> 说明：我只能读代码 + 用 `git diff/log/show/blame/status`，无法运行测试，也无法读取 `.agents/reviews/pr-323/round-1/*`（git 拒绝访问该记录路径）。所以下面「测试会不会真的失败」是基于对代码的推导，不是跑出来的结论，已单独标注。改动范围已按 `git diff 24fab91..cee9de65` 与 `407e1b5..cee9de65` 核对。

## 侧重检查（错误路径 / 不可信输入 / 安全 / 资源 / 不可逆 / 文档一致）

- **不可信输入**：`memory.basis.read` 的 `memoryId`、快照里的 `changeId/decisionRecordId` 都走 `machineString`（`packages/gateway-contracts/src/validation.ts:49-59`）；SQL 全部参数化，`IN (${placeholders})` 只拼占位符（`sqlite-memory-consolidation-operations.ts:53-58`）。未发现注入。
- **越权读**：`#basisChain` 用配置里的 owner/agent 调 `readBasisChain`，忽略请求自带 `scope`（`production-memory-control.ts:287-292`）。`GovernanceGatewayV2ReadModel.query` 对非 governance 查询不做 `#assertScope` 就 delegate（`governance-gateway-adapter.ts:210-212`），但 memory 读始终按配置租户返回，**不会跨租户泄漏**；这与既有 `memory.overview.read` 一致，属既有行为。
- **错误路径**：依据行先校验 run 正在运行、依据记忆存在且同 Owner/Agent，否则 `fail`（`:47-60`），在事务内抛错会回滚记忆（`sqlite-memory-operations.ts:672-681`）。`#revise` 只在「内存版本已变」时跳过，否则上抛（`consolidation.ts:493-510`）。
- **资源**：`readBasisChain` 有深度 8、节点 200 的截断，网关再硬截 200（`sqlite-memory-consolidation-operations.ts:19-20,282-330`；`production-memory-control.ts:293-313`）。注意持久层的 `nodes` 只统计「有整理改动的节点」，纯依据叶子不计入，所以持久层仍可能返回 >200 个节点，真正兜底的是网关（见发现 5）。
- **不可逆操作**：迁移 0084 只新建表 + `INSERT OR IGNORE` 回填，无删除/改写；FK 级联清理。推断正文 payload 在事务外先写、回滚可能留孤儿（ADR 第 64 行已写明），未新增更危险的操作。
- **安全/清单一致性**：新表已登记 `schema-catalog.ts:645-651`，迁移 84 已登记 `migration-engine.ts`，`LATEST/SUPPORTED_SCHEMA_MAX` 及迁移契约测试同步到 84；`recordChange` 端口方法删除后无残留调用方（全仓仅 ADR 提到）。
- **文档一致**：ADR 0143 已指向 0191；但 ADR 0191 有两处与代码/测试不完全一致（见发现 6、8）。

---

## 发现（按严重度）

### 1. 中：一条记忆有多次整理改动时，依据链只沿「最近一次」，会丢掉更早的推断依据
- 文件:行：`packages/persistence-sqlite/src/sqlite-memory-consolidation-operations.ts:290-295`
- 问题：查询固定只取一条 `ORDER BY created_at DESC, id DESC LIMIT 1` 的改动。若一条推断产生的记忆之后又被合并/作废（`memory_id` 变成它），读到的是后一次改动，`parents = readBasis(change.id).filter(id !== memoryId)` 只为 0 或「新记忆」，**最早那次 reflect 的全部基础记忆不再出现在链里**。这直接削弱「给一条整理产生的记忆，返回完整依据链」。
- 证据（亲读）：
  ```ts
  `${changeSelect} WHERE owner_id = ? AND agent_id = ? AND memory_id = ?
  AND undone_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1`
  ...
  const parents = this.readBasis(change.id).filter((id) => id !== memoryId);
  ```
  ADR 只写了「只沿最近一次未撤销的改动」（`docs/adr/0191...md:63`），未说明会丢掉更早的推断依据；现有测试也只覆盖「一条记忆一次改动」（`test/integration/decision-ledger.test.ts:873-890`）。
- 建议：对同一条记忆遍历全部未撤销改动，或对「由 reflect 产生、后来被 merge/supersede」的记忆优先沿 reflect 那条；并补一条多改动链的用例。

### 2. 中：依据记忆被治理删除后链路静默变短，`complete` 仍为真
- 文件:行：`packages/persistence-sqlite/src/migrations/0084_memory_consolidation_basis.sql:1-7`；`apps/agent-service/src/production-memory-control.ts:313`
- 问题：`memory_id ... REFERENCES memory_records(id) ON DELETE CASCADE` 会在依据记忆删除时直接删掉依据行；`readBasisChain` 读不到它，网关只在 `truncated` 时把 `complete` 置假，所以读到的是一棵「看起来完整」的残缺链。ADR 第 41 行确实把它列为「可以更好，未做」，但需求是「完整依据链」，消费方无法区分「这是源头」还是「来源被删了」。
- 证据（亲读）：
  ```sql
  memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  ```
  ```ts
  if (nodes.some(({ truncated }) => truncated)) complete = false;
  ```
- 建议：决策记录 `inputs.memoryIds` 不随记忆删除（无 FK），可用它和依据行做差集，缺失时把 `complete` 置假或返回「来源已删除」标记；若坚持不做，至少在协议/ADR 里明确 `complete=true` 不代表依据未被治理删除。

### 3. 低：`applyProposal` 接受整理写入参数，但 update 分支静默丢弃
- 文件:行：`packages/application/src/services/durable-memory-service.ts:99-103,176-202`
- 问题：`applyProposal(..., consolidation?)` 只在 `decision === "create"` 分支把它传给 `saveWithProjection`；`update` 分支的 `saveWithProjection(... ledger)` 没有第 7 个参数。当前唯一调用方 `#reflect` 走 `create`，所以现在不出错；但这是新增 API 的隐性陷阱：以后有人对 update 传回调，会以为已记录，实际什么都没写。
- 证据（亲读）：create 分支 `historyNote("created", proposal), ledger, consolidation`；update 分支只到 `historyNote("updated", proposal), ledger`。
- 建议：update 分支也透传 `consolidation`，或在参数与 `decision !== "create"` 同时出现时显式 `fail`。

### 4. 低：`#writeFailedAfterStaging` 的判定有时间窗，且没有任何测试覆盖
- 文件:行：`packages/memory-engine/src/consolidation.ts:493-510`
- 问题：失败后重新 `state.read` 再和内存里的旧 `revision` 比较。如果失败回滚后、这次读之前另一个写入者刚好改了该记忆，就会被误判为「记忆已变、只需跳过」，从而吞掉一次真实的整理写失败。窗口很窄，但语义上存在。
- 证据（亲读）：
  ```ts
  if (error instanceof ApplicationPortError &&
      !(await this.#writeFailedAfterStaging(memory, recorded))) return undefined;
  ```
  ```ts
  return (await this.#options.state.read(memory.id))?.revision === memory.revision;
  ```
  现有 `[P1-2]` 反向用例直接调 `DurableMemoryService.revise/applyProposal`（`test/integration/decision-ledger.test.ts:826-869`），**没有**覆盖引擎这层 skip/rethrow 分支。
- 建议：补一个让引擎在事务内写失败、且版本未变时必须上抛的用例；如需彻底消除竞态，可在失败异常里带上是否为 staging 后失败的明确标记，而不是二次读。

### 5. 低：「节点上限下推到持久层」不完全准确，且持久层截断没有测试
- 文件:行：`packages/persistence-sqlite/src/sqlite-memory-consolidation-operations.ts:316-320`；`apps/agent-service/src/production-memory-control.ts:296-313`
- 问题：`nodes` 只对「有整理改动的节点」自增，纯依据叶子（`!change` 提前返回）不计入，所以持久层可能返回 >200 个节点；真正的 200 节点上限还是网关。单元测试里的「超限」是假 store 直接构造 `truncated`（`production-memory-basis.unit.test.ts:116-146`），没有测真实持久层的深度/节点截断。
- 证据（亲读）：`nodes += 1` 在 `if (!change) return ...` 之后；`truncated` 用 `nodes + parents.length > MAX_NODES`。
- 建议：要么把叶子也计入节点数，要么把文档改成「持久层限制改动节点数，网关限制返回节点数」，并补持久层截断的反向用例。

### 6. 低：ADR 说「两层推断的完整链」，实际用例是 reflect → merge
- 文件:行：`docs/adr/0191-record-the-whole-basis-chain-of-a-memory-tidy-up.md:57`；`test/integration/decision-ledger.test.ts:873-890`
- 问题：文档称 `[P1-2]` 能读出「两层推断的完整链」，但测试构造的是 insight(reflect) → memory-b(merge) → memory-a(leaf)，只有一层推断 + 一层合并，`memory-consolidation.test.ts` 的 reflect 链也是直接指向两条叶子。没有用例证明「两层推断」。
- 建议：改文档措辞，或补真正的两层 reflect 链用例。

### 7. 低：整理改动编号可超过网关 `machineString` 的 128 字符（既有风险，新接口再次暴露）
- 文件:行：`packages/memory-engine/src/consolidation.ts:595-597`；`packages/gateway-contracts/src/validation.ts:49-57`；`packages/gateway-contracts/src/contracts-v2.ts:1010,1064`
- 问题：`changeId = "memory-consolidation:" + agentId + ":" + day + ":cN"`。`agentId` 本身允许到 128 字符（`identifiers.ts:39`），于是 `changeId` 可达 160+ 字符，而网关的 `changeId` 字段是 `machineString`（≤128）。这会让 `memory.basis.snapshot`（以及既有 `memory.overview.snapshot`）在该 Agent 上过不了契约校验，`memory.tidy.undo` 同样受影响。作者已承认是既有风险；但本轮新接口又把同一个值带到 `changeId`。
- 建议：给 `changeId` 用固定长度摘要、或在生成时限制 agentId/编号长度；至少补一条「长 agentId」的契约用例。

### 8. 低：回填不校验依据记忆的 Owner/Agent，写入路径校验
- 文件:行：`packages/persistence-sqlite/src/migrations/0084_memory_consolidation_basis.sql:14-21`；`packages/persistence-sqlite/src/sqlite-memory-consolidation-operations.ts:53-60`
- 问题：新写入会在 SQL 里核对依据记忆属于同一 `owner_id/agent_id`，但迁移回填只核对 `memory_records` 里存在同 id（`WHERE EXISTS (...)`），没有 owner/agent 约束。正常数据不会出问题，但这与 ADR 第 65 行「依据记忆必须属于同一个 Owner 和 Agent」的表述不完全一致。
- 建议：回填时 join `memory_records` 并加上 `m.owner_id = c.owner_id AND m.agent_id = c.agent_id`。

---

## 「读代码证实」与「推测」分开

**读代码证实（直接看到实现/测试）**
- `saveWithProjection` 内 `save → proposeJob → ledger → insertConsolidationWrite` 全部在同一个 `.immediate()` 事务（`sqlite-memory-operations.ts:672-681`）；`insertConsolidationWrite` 确实写变更行、依据行、`change_count`、决策记录（`sqlite-memory-consolidation-operations.ts:61-111`）。
- 依据记忆 Owner/Agent 校验、决策记录 `memoryIds` 由 `basis` 派生（同上 `:53-60,101-106`）。
- 迁移 0084 的回填 SQL、回退顺序、FK/索引，以及 schemaCatalog/迁移引擎登记。
- 网关 `memory.basis.read` / `memory.basis.snapshot` 契约、fixture、`PRODUCTION_MEMORY_OPERATIONS` 均已补齐；`complete` 在 200 上限或任一 `truncated` 时为假（`production-memory-control.ts:296-313`）。
- 测试内容：`[P1-2]` 反向用例确实断言「依据不存在的记忆 → 记忆保持原版本、无变更行、无决策记录」，成功后再写成功（`decision-ledger.test.ts:838-872`）。
- 本次 diff 没有改任何 prompt/工具定义/历史/遮盖相关文件；`consolidationPrompt` 未被改动。

**推测 / 由代码推出但未运行验证**
- 发现 1、2 的「链变短」是读逻辑推出的结果，没有现成测试覆盖。
- 发现 4 的 TOCTOU 是理论竞态，未构造复现。
- 发现 7 的 128 字符超限是长度算术，只有当 `agentId` 较长时才触发。
- 测试是否真的能通过、反向用例是否真的会失败：**未核实（无法运行测试）**。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？发给模型的内容是否仍只在末尾追加、每轮变化的值是否都在最后一条消息？
**不会。** 本次改动文件只在持久层、网关契约、控制端、测试和文档；没有改动 `packages/prompt-catalog`、上下文组装、工具定义、历史存储或遮盖逻辑。整理提示 `consolidationPrompt`（`memory-engine/src/consolidation.ts:118-134`）没有变化，也不新增模型调用。新增的只有一次 `state.read`（错误路径）和数据库读写，均不进入模型请求。因此仍满足「已发内容只追加」（`.claude/rules/prompt-prefix.md` 第 4 条）。

### 2. 会不会让同一段文字在不同请求里变成不同字节？
**对模型请求不会。** 这次新增/修改的值（`change.id`、`basis.position`、`basis.memory_id`、`ledgerId`、`inputs.memoryIds`）只写数据库和网关快照，不进入模型请求。就新增数据本身看，顺序也是确定的：依据行按数组顺序写、读按 `position` 排；merge/supersede 固定为 `[被改记忆, 相关记忆]`；没有带时间的字段被放进模型输入。唯一非确定来源是 reflect 的 `insight.basis` 顺序来自模型输出，但那是写入顺序、不是请求字节，且同一输出下稳定。

### 3. 有没有自动检查？反向用例是否真的会失败？
有检查（从代码看）：
- `test/integration/decision-ledger.test.ts:838-872`：依据写不存在记忆时要求拒绝，且记忆版本不变、无变更行/依据行/决策行；这条如果去掉事务（或在事务外吞掉依据写入错误）会失败。
- `test/integration/memory-consolidation.test.ts:437-454`：四类动作的依据、reflect 链与决策记录一致。
- `packages/persistence-sqlite/test/memory-consolidation-basis-migration.contract.test.ts`：回填与回退。
- `apps/agent-service/test/production-memory-basis.unit.test.ts`：范围、扁平化、超限、未安装拒绝。
- `packages/gateway-contracts/test/gateway-v2.contract.test.ts` 会要求每个 `GATEWAY_V2_MESSAGE_TYPES` 都有 fixture，新类型已补。

缺口：引擎 `#writeFailedAfterStaging` 的 skip/rethrow、持久层深度/节点截断、跨 Owner 依据拒绝、同一条记忆多次改动的链，都**没有**反向用例。实际是否通过：**未核实（不能运行测试）**。

### 4. 每个产生/修改的值，使用它的地方都能接受吗？
逐个核对结果：
- `change.id`：数据库 `memory_consolidation_changes.id`（无长度约束）可接受；`memory_consolidation_change_basis.change_id` FK 可接受；`consolidationLedgerId()` 只做 sha256 取 40 位（47 字符）可接受；网关 `changeId`/`memory.tidy.undo changeId` 是 `machineString`（≤128）——**长 agentId 时不可接受**（发现 7，既有风险）。
- `basis.position`：写入是非负整数，读取 `ORDER BY position`，可接受。
- `basis.memory_id`：FK 到 `memory_records(id)`，网关 `basisMemoryIds` 为 `machineString`，记忆 id 由 `createMemoryId` 限制 128 字符，可接受。
- `decisionRecordId`：`ledger:` + 40 hex = 47 字符，满足 `decision_ledger.id` 的 1–128 限制和网关 `machineString`，可接受；但决策记录被清除后该 id 可能指向不存在行，ADR 已注明。
- `inputs.memoryIds` / `resultMemoryIds`：由 `basis`/调用方派生，通过既有决策记录端口和测试消费，可接受。
- `memory.basis.read` / `memory.basis.snapshot`：在 `GATEWAY_V2_MESSAGE_TYPES`、schema、fixture、`PRODUCTION_MEMORY_OPERATIONS` 四处一致，可接受。
- 迁移号 84 / schemaCatalog 条目：迁移引擎、`CURRENT_SCHEMA_SEQUENCE`、`SUPPORTED_SCHEMA_MAX`、表清单测试均同步，可接受。
- `MemoryConsolidationWrite`：由 `DurableMemoryService` 生成、`SqliteMemoryOperations.saveWithProjection` 消费，`change.memoryId/afterRevision` 与保存记录一致才放行；`applyProposal` 的 update 分支不收它（发现 3，目前无调用方）。
- 删除的 `recordChange`：全仓无残留调用，可接受。

**总体结论**：未发现高危正确性问题；核心的「改记忆 + 变更行 + 依据行 + 决策记录同事务」在代码上成立，主写入路径有合理的反向用例。主要遗留是「完整依据链」在两处不完整（同一条记忆多次改动、依据被治理删除），以及若干测试与文档口径需要补齐。
