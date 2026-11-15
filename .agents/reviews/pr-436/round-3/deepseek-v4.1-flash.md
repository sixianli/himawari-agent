## 侧重检查

我按本次额外侧重先查了这些路径，结论如下：

- **错误路径与不可信输入（已读代码）**：`proposalId` 在 `confirm`/`reject` 里先用 `PROPOSAL_ID_PATTERN`（`production-owner-rules.ts:787,838`）校验，存储层又用同一正则（`sqlite-owner-rule-proposal-operations.ts:40`），网关 `target` 用 `machineString`（`contracts-v2.ts:1693-1698`）；未知 action 由 `memory.rule.respond` 明确报错（`production-memory-control.ts:1292-1295`），集成测试覆盖（`production-memory-capture.test.ts:2319-2326`）。这一条两端一致。
- **不可撤销/并发**：`reject` 只更新状态、不写规则和记忆；`confirm`/`reject` 通过 `pending -> accepted/rejected` 的 CAS 互斥，测试见 `production-memory-capture.test.ts:2351-2382`。`confirm` 失败时会把已认领的 `accepted` 退回 `pending`（`production-owner-rules.ts:811-834`）。
- **资源与数据保留（发现缺口）**：已采纳/已拒绝/已过期行不会删除，证据载荷也不删除；`expire` 只改状态（`sqlite-owner-rule-proposal-operations.ts:71-79`），上限只统计 pending（`:124-126`）。见问题 6。
- **迁移不可逆性（发现风险）**：迁移内容在分支内被改回；若某个持久库已应用 3354 版本的 0095，会因 ledger digest 不符拒绝启动（`migration-engine.ts:873-886`）。见问题 3。
- **文档/规则与代码一致性（发现不一致）**：`docs/architecture-v0.1.md:420` 仍写“先写载荷再写表”，但已有行的代码是“先写表、删旧载荷、再写新依据”（`production-owner-rules.ts:733-737`）。见问题 1。
- **数据导出（发现缺口）**：新表没有进入 portable export/import 的清单（`data-export/snapshot.ts:28-37`、`import.ts:78-91`）。见问题 4。
- **模型请求开头/字节确定性**：本次 diff 没有触碰 `packages/prompt-catalog` 或请求组装；下面必答问题 1、2 详述。

测试没有运行（本轮工具限制只能读和 git），以下“反向用例是否会失败”均按代码路径推断，未实测。

---

## 发现的问题（按严重度）

### 1. 中：已有提议重新打开时先删旧证据，再写新证据；写失败会留下“待采纳但无依据”的坏行

**文件:行**：`apps/agent-service/src/production-owner-rules.ts:733-737`

**读代码证实**：已有行分支是：

```ts
if (existing) {
  if ((await propose()) === "limit_reached") ...
  if (existing.status !== "pending") await payloads.delete(proposalId as never);
  await this.#writeText(proposalId, evidence);
}
```

`propose()` 已经把行从 rejected/expired/accepted 重置为 pending（`sqlite-owner-rule-proposal-operations.ts:129-150`），随后删除旧载荷（`736`），再调用 `#writeText`。而 `#writeText` 只有在 `payloads.put` 成功后才返回，`put`/`protect` 抛错时整次调用失败（`production-owner-rules.ts:447-462`）。此时数据库里是 pending 行，`evidence_ref` 仍指向刚被删除的载荷。

后果：`listProposals` 会显示该提议但 `quote/trials/replay` 全是空（`production-owner-rules.ts:862-878`）；`confirm` 读不到载荷，会退回 pending 并报 `RULE_NOT_FOUND`（`:823-827`），直到过期或再次提议才可能恢复。新建行分支反而有 `drop()` 清理（`:738-751`），已有行分支没有对应回滚。

**建议**：先写新证据再改表（可用新的 evidence ref 后再原子切换，或增加可覆盖的 `put`），或在写失败时把行恢复为原状态并保留旧载荷；同时补一条“写载荷失败”的测试。

### 2. 中：规则已通过其他路径生效后，旧 pending 提议仍留在列表里并占用上限

**文件:行**：`apps/agent-service/src/production-owner-rules.ts:691-692,715-717`

**读代码证实**：`create` 在“主人说过且是常设句”时直接 `#activate`，完全不读提议表：

```ts
if (ownerSaid && isStandingQuote(quote)) return this.#activate(proposal, replayed);
```

对普通模型提议，第 3 轮新增的“已有生效规则”检查也只回执，不处理已存在的 pending 行：

```ts
const live = await this.#options.rules.list({ ...scope, includeRetired: false });
if (live.some((row) => sameRule(row.parameters, normalized.type, normalized.params)))
  return this.#activate(proposal, replayed);
```

`listPending` 只按 `status = 'pending'` 列出（`sqlite-owner-rule-proposal-operations.ts:193-197`），不会判断同参数规则是否已生效。

可复现路径：模型先推断出提议 P（pending）→ 主人自己说了一句常设规则，`#activate` 创建了同参数规则 → P 仍是 pending；之后同一内容再提议，也只会走到 live 检查直接回执，P 不会消失。P 会占用 20 条上限直到 30 天过期。另一种路径是：P 与 Q 参数相同、说明/原话不同，Q 被采纳后 P 仍 pending。

**建议**：命中 live 规则或直接激活时，查询同 agent 的 pending 提议（按 `type + params` 比较证据里的参数），把匹配项标为 accepted/superseded，或在 `listProposals` 中过滤掉同参数已有生效规则的项；补对应反向测试。

### 3. 中/低：迁移 0095 内容被回退；已应用分支旧版本的数据库会启动失败

**文件:行**：`packages/persistence-sqlite/src/migrations/0095_owner_rule_proposals.sql:2`、`packages/persistence-sqlite/src/migration-engine.ts:873-886`

**读代码证实**：本轮把主键从 `PRIMARY KEY (owner_id, agent_id, id)` 改回单列 `id TEXT PRIMARY KEY`。迁移引擎在打开数据库时逐条比较 ledger 里的 `digest`：

```ts
definition.name !== record.name ||
definition.phase !== record.phase ||
definition.digest !== record.digest
  ? throw new SqliteMigrationError(SQLITE_MIGRATION_ERROR_CODES.DIGEST_MISMATCH, ...)
```

所以任何已经跑过 3354 版本 0095 的持久库，升级到本提交都会拒绝启动。本地 git 历史显示 0095 只出现在 `2ad82e6f`、`3354f76e`、`bf386aaf`，在基准 `0d989adb` 不存在，这与作者“0095 从未进过 main”的本地证据一致；**但是否有任何开发/预发库实际应用过 3354 的 0095，我未核实**。

**建议**：如果确认没有这类库，可保留回退并在提交说明/运维记录里写清楚需要重建开发库；否则应保留复合主键，或新增 0096 做表重建，而不是修改已提交的 0095。另建议补一个门禁：同一 PR 内迁移文件内容变化要显式提示。

### 4. 低/中：新表没有进入数据导出/导入清单，待采纳提议和依据会静默丢失

**文件:行**：`packages/persistence-sqlite/src/data-export/snapshot.ts:28-37`、`packages/persistence-sqlite/src/data-export/import.ts:78-91`

**读代码证实**：导出快照明确列出 `rules`、`ruleHistory`、`externalProposals` 等，但没有 `ownerRuleProposals`；导入的 `EMPTY_TARGET_TABLES` 也没有 `owner_rule_proposals`。证据载荷只有在被上述行引用时才会进入 `refs`（`snapshot.ts:241-261`），因此提议的证据也不会导出。

后果：导出/导入后待采纳提议全部丢失；作者列的“数据导出检查通过”并不能覆盖这张新表。是否“有意不导出”需要产品决定，但目前文档和清单没有写。

**建议**：把 `owner_rule_proposals` 和其 `evidence_ref` 载荷纳入 portable 格式、manifest 计数和导入的 `EMPTY_TARGET_TABLES`，或在文档里明确“待采纳提议不随导出迁移”的理由。

### 5. 低：`limit` 返回未截断，但列表最多 200 条，配置大于 200 时两端不一致

**文件:行**：`apps/agent-service/src/production-owner-rules.ts:855-861`、`packages/persistence-sqlite/src/sqlite-owner-rule-proposal-operations.ts:188`

**读代码证实**：`listProposals` 把 `this.#limit()` 原样传给 store，并原样返回给界面；store 却把查询上限截到 `MAX_LISTED = 200`：

```ts
const limit = Math.min(Math.max(1, Math.trunc(input.limit)), MAX_LISTED);
```

如果 `proposalLimit` 配成 500，`pendingCount` 可以是 500、`limit` 返回 500，但 `proposals` 最多 200 条，界面没有“还有更多”的提示。默认 20 时不会触发。

**建议**：把 `#limit()` 也夹到 200，或在响应里增加 `truncated`/实际返回上限，保证返回值和列表长度一致。

### 6. 低：已决定/已过期的行和加密证据永久保留，pending 上限不约束历史增长

**文件:行**：`packages/persistence-sqlite/src/sqlite-owner-rule-proposal-operations.ts:71-79,124-126`

**读代码证实**：`expire` 只把状态改为 expired；`propose` 的 pending 计数只统计 `status = 'pending'`；没有任何删除 `owner_rule_proposals` 行或 `rule-proposal:*` 载荷的代码。每次“提议→拒绝”都会新增一行和一份加密证据，且长期保留。

**影响（推测）**：正常使用量下 SQLite 行很小，但证据载荷包含原话/试算，长期可能累积；这不是远程可触发的资源耗尽，但没有保留策略。

**建议**：在 accepted/rejected/expired 后删除证据载荷（再次提议会重写），或增加按时间的清理任务；若决定保留，在 schema-catalog/文档里写明保留策略。

### 7. 低：证据载荷只做 JSON.parse，未校验字段形状，坏载荷会让整个列表查询失败

**文件:行**：`apps/agent-service/src/production-owner-rules.ts:776-784,862-878`、`apps/agent-service/src/production-memory-control.ts:543-568`

**读代码证实**：`#readProposal` 只 `JSON.parse`；`listProposals` 直接使用 `evidence?.trials ?? []`、`evidence?.replay ?? null`；control 层随后调用 `proposal.trials.slice(0, 10)`（`production-memory-control.ts:552`）。若某个旧/损坏载荷把 `trials` 写成非数组，`slice` 抛 TypeError，整个 `memory.ruleProposals.read` 失败，而不是跳过这一条。现有测试只覆盖“字段缺失”的旧载荷（`production-memory-capture.test.ts:2442-2484`），没有覆盖“字段类型错误”。

**建议**：像 `parseRuleReceipt` 一样逐字段做类型收窄/丢弃，或对单条证据读取失败只降级为空证据，不影响整个列表。

### 8. 低（安全/展示）：提议里的原话和试算文字可以带双向控制符

**文件:行**：`apps/agent-service/src/production-owner-rules.ts:655`、`apps/agent-service/src/production-memory-control.ts:118-126`、`packages/gateway-contracts/src/validation.ts:89-105`

**读代码证实**：`quote` 校验只拒绝长度和孤立代理项：

```ts
if (quote.length === 0 || quote.length > QUOTE_LIMIT || /\p{Surrogate}/u.test(quote))
```

`singleLine` 只把 `<0x20` 和 `0x7f` 替换为空格；网关 `boundedString` 也只拒绝这两类。因此 `U+202E`（RLO）、零宽字符等 `Cf` 字符可以从模型原话或邮件主题进入控制中心“看依据”区域。React 文本节点会转义 HTML，**不是 XSS**；但可以伪造显示顺序/内容（推测的实际影响取决于浏览器渲染）。

**建议**：证据文字统一去掉/拒绝 `\p{Cf}\p{Cs}` 和 C1 控制符，或在界面用 bidi isolate 包裹。

---

## 作者说法的核对

- **“迁移 0095 还原为首次提交的内容（主键仍是单列 id）”**：证实。`git show 2ad82e6f:...0095...` 与当前文件一致；`git show 3354f76e:...` 是复合主键。
- **“跨 agent 区分靠提议编号哈希里的 agentId”**：证实。哈希输入包含 `this.#scope().agentId`（`production-owner-rules.ts:698-707`），并且有跨 agent 测试（`production-memory-capture.test.ts:2640-2661`）。
- **“创建提议时先查同参数的生效规则，有就按已有规则回执，不新建待采纳”**：对 `listed !== false` 成立（`:715-717`）；MCP 的 `listed:false` 故意跳过（`production-mcp-rule-writer.ts:71-84`）。但没有清理已有 pending，见问题 2。
- **“已存在的行先写表成功再删旧载荷”**：字面上成立，但紧接着删除旧载荷、再写新证据，写失败无回滚，见问题 1；且文档 `docs/architecture-v0.1.md:420` 仍写“先写载荷再写表”，与已有行代码不一致。
- **“拒绝读到仍是待采纳时重试一次”**：证实（`production-owner-rules.ts:842-848`）。没有确定性的反向测试专门覆盖这个重试分支。
- **“0095 从未进过 main”**：本地 git 证据支持（0095 只在三个分支提交出现，基准提交没有）；远端 main 我未联网核实。
- **“新增三条反向测试”**：本轮 diff 实际新增两个 `it` 块（“does not queue…”“lets an adopted card…”），另外修改了原 origin 测试。“lets an adopted card…” 走的是 `confirm`，而 `confirm` 在 3354 与 bf 之间没有改动，所以它不能作为本轮增量的反向用例。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。** 本次 diff 没有改 `packages/prompt-catalog`，`rule_set` 工具描述和参数结构仍原样（`production-owner-rules.ts:169-198`）；新加的 `memory.ruleProposals.read/snapshot` 是控制面消息，不进入模型请求。每轮会变的值（提议列表、`generatedAt`，`production-memory-control.ts:576`）只出现在控制面响应里。`rule_set` 的**工具结果**会因“已有生效规则”从 `proposed` 变成 `active`，但这只是当前轮新追加的尾部内容，不改系统提示、工具定义或历史，符合“只在末尾追加”。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**模型可见内容：不会。** 本次改动没有引入时间、遮盖或排序到模型请求开头。控制面响应里 `generatedAt` 每次不同是刻意的（测试也把它排除后比较字节，`production-memory-capture.test.ts:2251-2254`）；提议证据在产生时写入、读取时不重算（`production-owner-rules.ts:862-878`）。`proposalId` 使用固定键序的 `canonicalJson`（`:367-378,698-707`），并有参数顺序测试（`:2442-2460`）。

需要知道的例外/边界：已有行重新提议会按设计重写证据（`:733-737`），字节会变；坏证据载荷未做形状校验，可能让整个列表失败（问题 7）。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

**部分有。** “已有生效规则不再新建待采纳”有反向测试（`production-memory-capture.test.ts:2586-2606`），删掉 live 检查会失败；origin 刷新测试（`:2545-2584`）覆盖来源标记。但：
- `reject` 的重试分支（`production-owner-rules.ts:842-848`）没有确定性测试；并发测试（`:2351-2382`）是概率性的，不能保证命中该分支。
- 已有行“删旧载荷→写新载荷失败”的路径没有测试（问题 1）。
- 迁移 0095 的回退没有测试去比较历史 digest；fresh-apply 的迁移契约测试不会发现这个问题。
- “lets an adopted card be adopted again…”（`:2608-2626`）在 3354 上也会通过，不是本轮增量的反向门禁。

### 4. 每个新值的使用端都能接受吗？

逐项核对结果：

| 值 | 产生处 | 使用处/校验 | 结论 |
|---|---|---|---|
| `proposalId` | `production-owner-rules.ts:698-707` | 同文件正则 `:787,838`；SQL 正则与单列主键 `sqlite-...:40`、`0095:2`；网关 `machineString`（`validation.ts:49-59`）；UI 作为 `target` | 接受；`rule-proposal:`+32 hex 共 46 字符，字符集和长度都合法 |
| `origin` | `production-owner-rules.ts:725` | SQL CHECK（`0095:7`）、网关 `enumeration`（`contracts-v2.ts:1664`）、i18n select | 接受 |
| `status` | store `decide`/`propose` | SQL CHECK、端口类型、UI | 接受 |
| `evidence_ref` | `production-owner-rules.ts:727` | SQL 长度 1–256、`#readProposal` | 接受 |
| `proposedAt/expiresAt/decidedAt/lastRejectedAt` | clock + `toISOString` | SQL GLOB、store `valid()` | 接受 |
| `replay/trials` | 提议时写入 | 网关 `integer/boolean/nullable` | 正常数据接受；坏旧载荷未校验，见问题 7 |
| `limit/expiresAfterDays` | `#limit()/#ttlDays()` | 网关 `integer(1)`、UI | 默认值接受；>200 时与列表截断不一致，见问题 5 |
| `memory.ruleProposals.read/snapshot` | contracts、PRODUCTION_MEMORY_OPERATIONS、control dispatch、UI availability | 契约、fixture、control、memory.ts | 一致 |
| 新表 `owner_rule_proposals` | 迁移 0095、schema-catalog、migration-engine、审计 schema 上限 | 数据导出/导入清单 | **不一致**：导出/导入未包含，见问题 4 |

**总结**：改动的核心路径（编号、状态、来源、时间、网关契约）两端校验是齐的；真正需要修的是问题 1（错误路径数据损坏）、问题 2（列表真相）、问题 3（迁移回退风险），以及问题 4（导出清单缺项）。
