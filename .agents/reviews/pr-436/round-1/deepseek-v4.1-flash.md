## 读代码证实的问题

### 1. 中 — proposalId 不含 agentId，但表主键是全局唯一：同一 owner 下第二个 agent 提同样内容会插入失败

- 文件:行：`apps/agent-service/src/production-owner-rules.ts:698-706`、`packages/persistence-sqlite/src/migrations/0095_owner_rule_proposals.sql:2`、`packages/persistence-sqlite/src/sqlite-owner-rule-proposal-operations.ts:84-89,145-163`
- 问题：提议编号只哈希了 ownerId、type、params、summary、quote，没有 agentId；而表的主键是单列 `id TEXT PRIMARY KEY`，查询却按 `(owner_id, agent_id, id)` 过滤。同一 owner 的两个 agent 若提出相同内容，proposalId 相同，第二个 agent 的 `fetch` 查不到行后走 `INSERT`，撞主键；这不是 `OwnerRuleError`，会以底层持久化错误冒出去。
- 证据：

  ```ts
  const proposalId = `rule-proposal:${hash(
    canonicalJson([
      this.#scope().ownerId,
      normalized.type,
      ...
  ```

  ```sql
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  ```

  ```ts
  `SELECT ${columns} FROM owner_rule_proposals WHERE owner_id = ? AND agent_id = ? AND id = ?`
  ```

- 建议：把 `agentId` 放进哈希，或把主键改成 `(owner_id, agent_id, id)`（与 `rule_book_rules` 的 `PRIMARY KEY (owner_id, agent_id, rule_id)` 一致）。这正是 I-73 那类“产生端和使用端校验不一致”。

### 2. 中 — 先写表、后写加密载荷；载荷写失败或进程中断会留下无法采纳的 pending 行并占名额

- 文件:行：`apps/agent-service/src/production-owner-rules.ts:708-725,447-463,795-799,831-842`
- 问题：`propose()` 先把行落库，随后才 `#writeText(proposalId, ...)`。若载荷写入抛错或进程在这两步之间退出，表里留下 pending 行，但 payload 不存在。列表会把它显示成“没有依据”，confirm 读不到 payload，`release()` 又把它退回 pending，于是用户永远无法采纳，直到 30 天过期，期间一直占用待采纳名额。
- 证据：

  ```ts
  const outcome = await this.#options.proposals.propose({...});
  ...
  await this.#writeText(proposalId, JSON.stringify({ ...proposal, trials, replay: replayed }));
  ```

  ```ts
  const proposal = await this.#readProposal(proposalId);
  if (!proposal) {
    await release();
    throw new OwnerRuleError("RULE_NOT_FOUND");
  }
  ```

- 建议：先写 payload 再写表；或把 propose 和写 payload 放进同一可补偿流程，写 payload 失败时删除刚插入的行。列表也应把“无 evidence 且无 payload”的行当异常处理，而不是继续提供“生效”按钮。

### 3. 中低 — 载荷只写一次，旧提议重提或再次提议时试算例子/回放不会刷新，界面与模型回执可能不一致

- 文件:行：`apps/agent-service/src/production-owner-rules.ts:449,725,801,831-842`
- 问题：`#writeText` 只在 ref 不存在时写入。升级前留下的旧 `rule-proposal:` 载荷没有 `trials`/`replay`；同一内容再次提议时（甚至新插入表行时）也会复用旧载荷，导致：
  - 列表显示的 `trials`/`replay` 为空或来自上一次提议；
  - 本次 `create` 返回给模型的回执里有新算出的 trials/replay，界面却看不到；
  - 与作者说法“依据是提议产生那一刻存下的……”在新表行的 `proposed_at` 已被重置时并不一致。
- 证据：

  ```ts
  if (!(await this.#options.payloads.get(ref)))
    await this.#options.payloads.put(...)
  ```

  ```ts
  await this.#writeText(proposalId, JSON.stringify({ ...proposal, trials, replay: replayed }));
  ```

- 建议：对 `rule-proposal:` 载荷做删除后重写或版本化（例如 `proposalId:revision`），否则明确把“依据永远是第一次提议时”的语义写进文档，并让 `proposedAt` 也保持第一次的时间。

### 4. 中低 — 源对话删除后 confirm 仍用载荷里的旧 threadId，写记忆可能因外键失败

- 文件:行：`packages/persistence-sqlite/src/migrations/0095_owner_rule_proposals.sql:8`、`apps/agent-service/src/production-owner-rules.ts:571-576,801`、`packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:401`
- 问题：表里的 `thread_id` 在对话删除时变成 NULL，但加密载荷里的 `proposal.threadId` 仍是旧值。confirm 走 `#activate(proposal, ...)`，`#writeMemory` 用 `sourceThreadId: proposal.threadId` 插入 `memory_records`；该列有 `REFERENCES threads(id)`，旧对话已删除时会外键失败，提议只能拒绝、不能采纳。
- 证据：

  ```sql
  thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
  ```

  ```ts
  const memoryId = await this.#writeMemory({
    key: proposal.key,
    text: `${proposal.quote}\n${parsed.summary}`,
    category: "rule",
    threadId: proposal.threadId,
  });
  ```

- 建议：confirm 使用表行里的 `threadId`（已被置 NULL）或先校验对话仍存在；载荷里的 threadId 只作展示依据，不作为写入依据。

### 5. 低 — 已拒绝/已过期行和加密载荷没有清理路径，pending 上限不限制累积

- 文件:行：`packages/persistence-sqlite/src/sqlite-owner-rule-proposal-operations.ts:64-77,145-163`、`packages/persistence-sqlite/src/migrations/0095_owner_rule_proposals.sql`
- 问题：`expire` 只改状态，不删除行；reject 也只改状态；全仓库没有 `DELETE FROM owner_rule_proposals`。因此每次不同内容的提议都会永久留下一条行和一份含原话的加密载荷；20 条上限只约束 pending，不约束历史累积。既占空间，也长期保留主人可能已经拒绝的原话。
- 证据：`expire` 只执行 `UPDATE ... SET status = 'expired'`，`propose` 只会 `INSERT`/`UPDATE`，没有删除。
- 建议：明确保留期（例如已拒绝保留 N 天用于拒绝次数，已过期清理载荷），或至少加清理任务；否则资源/隐私上会无限增长。

### 6. 低 — `revision()` 不含待采纳规则提议，控制中心可能最多 5 分钟才看到新提议

- 文件:行：`apps/agent-service/src/production-memory-control.ts:364-418`、`apps/control-center/src/memory.ts:34,158`
- 问题：网关的 `snapshot_required` 用 `revision()` 判断状态变化，但 `revision()` 的数组里没有 `owner_rule_proposals` 的 pending 信息。新提议不会触发 SSE 刷新，控制中心只能靠 5 分钟轮询出现。
- 建议：把 pending 提议的 `[proposalId, proposedAt]`（或数量+最新时间）加入 `revision()`。

### 7. 低 — 自动检查总体充分，但这几类反向用例缺失或测错了对象

- 文件:行：`test/integration/production-memory-capture.test.ts:2410,2424`
- 问题：
  - 限制用例用 `proposalLimit: 2` 的 writer 创建，却通过默认 writer 的 control 查询，并断言 `full.limit === 20`。这只能证明“列表用自己的 writer 的上限”，没有验证“执行限制的值和返回给界面的值一致”。
  - 没有跨 agent 同内容提议的用例（会暴露问题 1）。
  - 没有“propose 成功但 payload 写失败”的用例（会暴露问题 2）。
  - 没有“旧版无 trials/replay 的载荷被重新提议后仍缺依据”的用例（会暴露问题 3）。
- 证据：

  ```ts
  const small = new ProductionOwnerRuleTools(
    context.ruleWriterWith({ proposalLimit: 2, proposalTtlDays: 3 }),
  );
  ...
  expect(full.limit).toBe(20);
  ```

- 建议：用同一个 writer 创建和查询，断言返回的 limit/TTL 与创建端一致；补跨 agent、载荷写失败、旧载荷重提三类反向用例。

### 8. 低 — 数据导出/导入未包含新表（未核实是否为本次要求）

- 文件:行：`packages/persistence-sqlite/src/data-export/snapshot.ts`、`packages/persistence-sqlite/src/data-export/import.ts:78-91`
- 问题：导出快照读取 `rule_book_rules`，但没有 `owner_rule_proposals`；导入的 `EMPTY_TARGET_TABLES` 和可导入表清单里也没有它。若“导出再导入后待采纳提议还在”属于预期，这就是缺口；若不要求导出临时提议，也应显式记录。
- 建议：确认产品预期；若需保留，补导出/导入和反向断言；若不需要，在文档/表目录里写明“不导出”。

## 推测（未完全核实）

- 问题 1 是否会在生产触发，取决于同一 owner 是否会出现第二个 agent。表结构、端口和 scope 都允许，代码也没有断言单 agent，因此是潜在缺陷；如果产品保证一人一 agent，则当前不会触发。
- 问题 4 的具体错误码未核实：取决于 worker 把 SQLite 外键错误包装成哪种错误；但从 `memory_records` 的外键和 `#writeMemory` 的调用看，失败路径成立。
- `listProposals`/`listPending` 虽然是 query，却会执行 `expire` 的 UPDATE，并走 `context.write`。目前组合用的是可写主库所以没问题；若未来把控制中心查询路由到只读副本，这个查询会失败。

## 侧重检查

- 错误路径：查了无表行（外部/旧提议）、非法 proposalId、已拒绝再采纳、已采纳再拒绝、过期、载荷缺失、并发 confirm/reject、源对话删除；发现 2、4。
- 不合规范/不可信输入：proposalId 正则、quote/summary 长度与不可见字符、params 由规则类型解析、DB CHECK、契约 boundedString/timestamp；未发现新的注入或越界读取。`#readProposal` 只 parse 不校验结构，损坏载荷会导致“没有依据”或列表字段异常，但都是本 agent scope 内。
- 安全：payload 和表查询都按 ownerId+agentId 隔离，未发现跨 owner/agent 读取；列表把原话解密给已认证的主人界面，符合现有分级。问题 1 是同 owner 多 agent 的写冲突，不是读泄漏。
- 资源耗尽：pending 有 20 条上限和 30 天过期，但历史行/载荷不清理（问题 5）；外部 agent 走 `listed:false` 不进列表，符合说明。
- 不可撤销操作：reject 只改状态、可通过再次提议恢复；confirm 写规则+记忆仍可 undo，符合预期。
- 规则/文档/代码一致性：`.claude/rules/prompt-prefix.md` 的工具/提示词未被改动；`docs/architecture-v0.1.md` 新增段落与代码大体一致，但它写“提议编号是类型、参数、说明和原话的哈希”，漏了 ownerId，也没提 agentId；它说“同样内容再次提议会把状态重置为待采纳”，而代码对“已经是 pending”的情况只延长过期时间、不重置 `proposed_at`。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。改动没有动 `packages/prompt-catalog` 的 `rule_set` 定义或提示词，也没有增删模型工具；`PRODUCTION_MEMORY_OPERATIONS` 只进入控制中心/网关的安装清单，不是模型请求内容。新增的 proposalId、状态、过期日、拒绝次数只出现在控制中心查询响应和工具调用结果里；工具结果按规则是追加在末尾。每轮会变的 `generatedAt` 只在 `memory.ruleProposals.snapshot` 里，不进模型请求头。因此仍满足“只在末尾追加、会变的值在最后一条消息/末尾工具结果”。

2. **同一段文字会不会在不同请求里变成不同字节？**
   对模型请求：不会。proposalId 用 `canonicalJson` 固定了对象键顺序，params 又由 `parseOwnerRuleParameters` 去重并排序，所以同内容得到同 id；回放/试算在提议时存下、读时不重算。对新的控制中心快照：`generatedAt` 每次不同；同一内容再次提议会重置 `expiresAt`（pending 时只延长过期、不重置 `proposedAt`），reopen 时 `origin`/`threadId` 也可能变化。这些都不是模型请求内容，但调用方不能假设快照逐字节稳定。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   有，而且覆盖较广：`test/integration/production-memory-capture.test.ts` 覆盖列出/采纳/拒绝/不写规则/不写记忆/已拒绝再采纳/已采纳再拒绝/并发只一个生效/过期/上限/参数键顺序/无依据；`mcp-write.test.ts` 覆盖外部 agent 不进列表；control-center 单测覆盖展示和“无提议不显示”的反向用例。`check:operations` 也会要求新 query 同时有后端、前端调用和测试，缺一即失败。但如问题 7 所述，跨 agent 冲突、载荷写失败、旧载荷重提、返回 limit 与执行 limit 一致这几类没有真正会失败的反向用例。

4. **改动产生或修改的每个值，两端都能接受吗？**
   - `proposalId`：产生端是 46 字符 `rule-proposal:`+32 位小写十六进制，agent 的 confirm/reject 正则和 SQLite 的正则一致，网关 `machineString` 接受冒号，前端 key 也接受；**但 DB 主键是全局 `id`，哈希却没有 agentId，跨 agent 会撞主键**（问题 1）。
   - `origin`：只产生 `owner_said`/`inferred`，DB CHECK、契约 enumeration、前端 select 三端一致。
   - `rule_type`：来自 `parseOwnerRuleParameters` 的固定规则类型，DB 1–64、契约 64、控制中心 `slice(0,64)` 一致。
   - `summary`：生产端经 `validRuleSummary` 保证 1–200 且无控制字符，DB 允许 1–400，契约/控制中心 200，均能接受。
   - `proposedAt`/`expiresAt`：用 `toISOString()` 产生，DB GLOB 和契约 `timestamp` 都要求同样的规范 UTC 毫秒格式。
   - `status`：pending/accepted/rejected/expired 与 decide 的迁移、CHECK 约束、confirm/reject 分支一致。
   - `evidenceRef`：等于 proposalId，长度 46，满足 DB 的 1–256；但载荷不存在时会被当作“空依据”，见问题 2/3。
   - `reject` 动作：已加入契约枚举、前端 `OwnerRuleAction`、控制中心 switch、SQLite `decide`；未知动作会报错，两端一致。
   - `limit`/`expiresAfterDays`/`pendingCount`/`refusedBefore`：都是非负整数，契约 `integer(0/1)` 可接受；默认值来自常量并随响应返回，没有在前端写死。
