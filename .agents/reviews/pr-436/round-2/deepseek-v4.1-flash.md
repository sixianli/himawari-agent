## 结论（按严重度）

### 【中高】就地改写已提交的迁移 0095，已有库会在启动时因 digest 不符而失败【证实】
- 位置：`packages/persistence-sqlite/src/migrations/0095_owner_rule_proposals.sql:1-2,19-21`，`packages/persistence-sqlite/src/migration-engine.ts:798-804,873-887,980-983`
- 问题：第 2 轮把 0095 从 `id TEXT PRIMARY KEY` 改成 `id TEXT NOT NULL` + `PRIMARY KEY (owner_id, agent_id, id)`。迁移引擎把 SQL 文本摘要写进 `schema_migration_ledger`，下次启动会逐字节比对：
  - `const actualDigest = sha256(migration.sql); if (actualDigest !== migration.digest) throw ...`
  - `definition.digest !== record.digest` → `DIGEST_MISMATCH`
  - `applyMigrations` 一开头就 `validateDefinitions` + `validateLedger`。
  任何已经跑过上一轮 `c53274cd` 的 0095 的库（上一轮复核容器、共享开发库、持久化 CI 缓存）都会直接启动失败，而不是平滑升级。
- 建议：0095 保持原样，新增 0096 用“建新表→复制→删旧表→改名→重建索引”的方式改主键；如果要撤销原文件，也必须在合并前确认所有已有库都能通过 0096 升级，并补一条“旧 0095 + 新迁移”的升级测试。

### 【中】“已采纳且同参数规则仍在生效不新建待采纳”只在 proposalId 完全相同时成立，文档与代码不一致【证实】
- 位置：`apps/agent-service/src/production-owner-rules.ts:698-707,715-720`，文档 `docs/architecture-v0.1.md:420`
- 问题：proposalId 的哈希包含 `normalized.summary` 和 `quote`；而检查已采纳规则是否仍在生效，只在 `existing?.status === "accepted"`（即同一 proposalId 已有表行）时做。模型只要换一句 summary 或换一句原话，proposalId 就变了，`existing` 为空，于是即使同参数规则已经生效，也会插入一条新的待采纳记录。文档写的是“同参数规则仍在生效的不再新建待采纳”，实际是“同参数且同说明同原话且已有表行时”。
- 证据：
  ```ts
  const proposalId = `rule-proposal:${hash(canonicalJson([
    this.#scope().ownerId, this.#scope().agentId, normalized.type,
    normalized.params, normalized.summary, quote,
  ]))...}`;
  ...
  const existing = await store.read({ ...scope, proposalId, now });
  if (existing?.status === "accepted") {
    const live = await this.#options.rules.list(...);
    if (live.some((row) => sameRule(row.parameters, normalized.type, normalized.params)))
      return this.#activate(proposal, replayed);
  }
  ```
- 影响：已生效规则会反复出现在待采纳列表，占满 pending 名额；采纳后也只是 `reconfirm` 已有规则，新的 summary 永远不会生效。现有测试 `inferred("moj.go.jp")` 两次内容完全相同，覆盖不到这个反向用例。
- 建议：在 `existing` 为空时也先按 `type+params` 查一遍 live rules，命中就直接按已有规则回执；或者给“规则身份”单独算一个只含 `type+params` 的稳定键，待采纳去重和生效检查都用它。

### 【中低】再次提议“已采纳但规则已撤销”的提议时，列表已满或写表失败会先删掉旧载荷，旧回执卡无法恢复规则【证实】
- 位置：`apps/agent-service/src/production-owner-rules.ts:716-748,819-823`
- 问题：
  ```ts
  if (existing?.status !== "pending") await payloads.delete(proposalId as never);
  ...
  if (outcome === "limit_reached") {
    await drop();                    // 新载荷删掉
    throw new OwnerRuleError("RULE_PROPOSALS_FULL", ...);
  }
  ```
  accepted 行也满足 `status !== "pending"`。撤销规则后，模型再次提议同一内容、但待采纳已满时：旧的 accepted 载荷先被删，新载荷又被 `drop()` 删，表行仍指向已删除的载荷。此时文档承诺的“撤销后点旧回执卡恢复规则”会在 `confirm` 里走：
  ```ts
  const stored = await this.#readProposal(proposalId);
  if (!stored) { await release(); throw new OwnerRuleError("RULE_NOT_FOUND"); }
  ```
  变成 `RULE_NOT_FOUND`。
- 建议：accepted 行的旧载荷不要先删；先保留旧记录，成功 `propose` 后再替换，或在 `drop()` 里把旧载荷原样恢复。更稳妥的是让载荷不可变，另用 `evidence_ref` 指向新版本。

### 【低】拒绝的竞态分支会把 pending 误报成 EXPIRED；并发两次确认可能重复激活【部分证实／部分推测】
- 位置：`apps/agent-service/src/production-owner-rules.ts:833-845,786-806,825-826`
- 证实：`reject` 输掉 `decide` 后只读一次行，`pending` 不在处理分支里，直接落到：
  ```ts
  if (row.status === "accepted") throw ...ACCEPTED;
  throw new OwnerRuleError("RULE_PROPOSAL_EXPIRED");
  ```
  如果另一路 `confirm` 认领后失败又 `release` 回 pending，拒绝方会误报“已过期”。
- 推测：两个并发 `confirm` 中只有一个 `won=true`，另一个仍会继续执行 `#activate`（第 825 行），两边可能同时写同一 `memoryId`。`rules.create` 的 `replayed` 能兜住规则，但 `memory.applyProposal` 的并发去重行为我没有核实。
- 建议：输掉 `decide` 后按实际状态重试或返回可重试冲突，不要一律 EXPIRED；确认路径要么必须先认领成功，要么对同一 proposalId 做进程内/数据库串行化。

### 【低】过期/已拒绝的提议行和对应加密载荷没有清理路径，可随时间无限增长【证实】
- 位置：`packages/persistence-sqlite/src/sqlite-owner-rule-proposal-operations.ts:70-77,92-171,212-241`，全仓库 grep 未发现 `DELETE FROM owner_rule_proposals`；`production-owner-rules.ts` 只会在再次提议时删旧载荷。
- 问题：pending 上限只限制 `status='pending'`。过期后 pending 配额释放，模型可以继续产生新行；每次拒绝也会留下行和载荷。长期看表、载荷都可无限增长。
- 建议：给 expired/rejected 行设保留期（并同步删 `rule-proposal:` 载荷）；如果“已拒绝再提议要保留拒绝次数”必须永久保留，就改成 tombstone（proposalId + reject_count），不要把完整证据永久留着。

### 【低】证据载荷反序列化不校验，且 `confirm` 与 `listProposals` 使用的引用不一致【证实】
- 位置：`apps/agent-service/src/production-owner-rules.ts:772-780,819,856-858`
- 问题：`#readProposal` 直接 `JSON.parse(text) as Proposal`，没有校验字段类型；`listProposals` 用 `row.evidenceRef` 读，`confirm` 却固定用 `proposalId` 读。当前 `propose` 总是传 `evidenceRef=proposalId`，所以没爆；一旦表行或历史数据出现 `evidence_ref != id`，列表和采纳会读到不同的东西，损坏的 `quote`/`trials` 还可能让 `clip()`/`.slice()` 抛错。
- 建议：`#readProposal` 做最小结构校验；`confirm` 统一用 `row.evidenceRef`（回退到 proposalId），并在写入端强制两者相等。

---

## 侧重检查

- 错误路径：我查了 `confirm` 对 rejected/expired/accepted/无表行/缺载荷，`reject` 对 accepted/expired/缺行，未知 action，激活失败后的 `release`。主要问题是上面的 D（竞态误报）和 C（失败时载荷被删）。
- 不可信输入：`proposalId` 两端都有 `^rule-proposal:[0-9a-f]{32}$`；`confirm/reject` 都用 writer 的 owner/agent scope；MCP 的 quote 受 500 字限制；`params/summary` 由 `parseOwnerRuleParameters` 校验。薄弱点是证据 JSON 只做类型断言（F）。没有发现新的越权读/写其它 owner/agent 提议的路径。
- 安全：第 2 轮的 `agentId` 进哈希 + `(owner_id, agent_id, id)` 主键修掉了一个真实问题——`payloads.ref` 是全局主键，两个 agent 同内容会争同一 ref；现在两端都带 agent，方向正确。MCP 的无表行采纳仍依赖加密载荷的 scope 校验，未发现绕过。
- 资源耗尽：pending 上限生效；但 expired/rejected 的长期增长没有上限或清理（E），失败/崩溃时也可能留下孤立 `rule-proposal:` 载荷。
- 不可撤销操作：`reject`/`undo` 都可再提议或再确认恢复；真正的不可逆点是 C 里“先删旧证据载荷”，失败后不会恢复。
- 规则/文档/代码一致性：迁移不可变约定被破坏（A）；文档“同参数规则仍在生效不再新建待采纳”与代码不符（B）；“待采纳再次提议更新来源标记”的路径没有真正被测试覆盖（见问题 3）。
- 数据导出：`data-export/snapshot.ts`/`import.ts` 只处理 `rule_book_rules`，没有 `owner_rule_proposals` 或其载荷引用。如果“工作区导出应保留待采纳提议”是需求，这是一个遗漏；材料里没有明确要求，标“未核实需求”。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。`ownerRuleToolDescriptors` 本次没有改（diff 未触及 `rule_set/rule_list/rule_undo` 的定义），`packages/prompt-catalog` 也没有改；新增的只是 SQLite 表、网关查询 `memory.ruleProposals.read` 和控制中心 UI。发给模型的内容仍然只在末尾追加，`rule_set` 的工具结果字段也没有变化。每轮变化的值（`generatedAt`、`clock.now()`、`expiresAt`）只出现在控制中心快照/数据库里，没有进入系统提示、工具定义或历史。**未运行** `check:prompt-prefix`，以上是读 diff 和调用链得出的结论。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   对发往模型的内容不会。`proposalId` 用 `canonicalJson`（递归排序键）并对 `parseOwnerRuleParameters` 已排序的数组做哈希，不含时间；待采纳列表按 `proposed_at, id` 固定排序；证据载荷不进入模型请求。需要注意：控制中心快照里的 `generatedAt` 每次请求都不同，`expires_at/origin/thread_id` 也会随再次提议变化——它们目前只给界面，不进入提示词；如果以后把这份快照塞进模型上下文，就会破坏“同一段文字同样字节”。

3. **有没有对应的自动检查，反向用例真的会失败？**
   有：集成测试覆盖了列表、采纳、拒绝、上限、过期、并发采纳/拒绝、MCP 不进列表、两个 agent 隔离、满额时载荷回滚；控制中心单测覆盖列表/依据/拒绝按钮和无提议时的空渲染；网关 fixture 覆盖新查询和快照；迁移契约测试覆盖新表。反向断言是具体的（例如“拒绝后确认必须抛 RULE_PROPOSAL_REJECTED”“满额后 payload refs 不变”“只有一路 fulfilled”），删掉对应实现会失败。**未运行测试**，无法确认作者所列的 typecheck/lint/integration 是否真通过。
   覆盖缺口（读测试证实）：
   - `test/integration/production-memory-capture.test.ts:2562-2571` 想测“来源标记更新”，但第二次 `set` 用了不同的 quote，proposalId 不同，实际生成的是两条提议，`sqlite-owner-rule-proposal-operations.ts:107-108` 的 pending 刷新 origin 路径没有被覆盖。
   - 没有“表里的 threadId 覆盖载荷里旧 threadId”的正向用例；`2574-2584` 只测了 thread_id 为 NULL 的情况。
   - 没有“同参数、不同 summary/quote 的已生效规则不再新建待采纳”的反向用例（对应问题 B）。
   - 没有“旧 0095 已应用后升级到新 0095”的迁移测试（对应问题 A）。

4. **改动产生/修改的每个值，使用它的地方都能接受吗？**
   - `proposalId`：产生处是 32 位小写十六进制，`PROPOSAL_ID_PATTERN`（production）/`PROPOSAL_ID`（SQLite）/网关 `machineString`（允许 `:`、`-`、128 字以内）/DB `length(id) BETWEEN 1 AND 128` 全部接受。
   - `origin`：只产生 `owner_said`/`inferred`；SQLite CHECK、网关枚举、i18n select 都接受。
   - 新动作 `reject`：`OWNER_RULE_ACTIONS`、控制中心 `OwnerRuleAction`、`ProductionMemoryControl` 分支、i18n 状态文本都接受；未知动作在网关 schema 和 control 两层都会报错。
   - 新查询 `memory.ruleProposals.read`：`GATEWAY_V2_MESSAGE_TYPES`、schema、`schemasByType`、`PRODUCTION_MEMORY_OPERATIONS`、control-center 的 `installedGatewayV2Operations` 判断、fixture 都齐了。
   - `limit/expiresAfterDays/pendingCount/refusedBefore`：网关 `integer` 和 UI 都接受；唯一小坑是若把 `proposalLimit` 配成 0，响应 `limit: 0` 会被网关 `integer(1)` 拒绝，默认值 20 不会触发。
   - 新主键 `(owner_id, agent_id, id)`：所有查询都带 owner+agent，没有发现只按 id 全局读取的消费方；`payloads.ref` 是全局主键，正确性依赖哈希里的 owner+agent（这次已加）。
   - 数据导出：`owner_rule_proposals` 没有进入 `data-export/snapshot.ts`/`import.ts` 的目标表，工作区导出会静默丢掉待采纳提议及其证据；这是消费端缺口，但是否算需求未核实。
