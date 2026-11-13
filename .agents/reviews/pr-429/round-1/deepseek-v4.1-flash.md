## 发现

### 1. 高（读代码证实）`quote` 可能含换行/控制字符，违反网关契约，导致整份规则列表无法解析

- 位置：`apps/agent-service/src/production-memory-control.ts:487-496`、`apps/agent-service/src/production-owner-rules.ts:603`、`packages/gateway-contracts/src/contracts-v2.ts:1626`
- 问题：规则原话在创建时只拒绝代理对，不拒绝换行和 C0 控制字符；`#ruleQuote` 又原样取回这段文本，没有经过已有的 `singleLine`/契约校验。契约的 `boundedString(500)` 明确拒绝 `code < 0x20`，所以一条多行原话会让整个 `memory.rules.snapshot` 解析失败，而不只是该字段为空。
- 证据：

```ts
// production-owner-rules.ts:603
if (quote.length === 0 || quote.length > QUOTE_LIMIT || /\p{Surrogate}/u.test(quote))
  throw new OwnerRuleError("RULE_INPUT_INVALID", "quote");

// production-owner-rules.ts:522
text: `${proposal.quote}\n${parsed.summary}`,

// production-memory-control.ts:492-495
const suffix = `\n${summary}`;
if (text === null || !text.endsWith(suffix)) return null;
const quote = text.slice(0, text.length - suffix.length);
return quote.length > 0 && Array.from(quote).length <= 500 ? quote : null;
```

```ts
// packages/gateway-contracts/src/validation.ts:96-99
[...input].some((character) => {
  const code = character.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
})

// packages/gateway-contracts/src/contracts-v2.ts:1626
quote: nullable(boundedString(500)),
```

现有同类字段都会先过 `singleLine`（`production-memory-control.ts:114-122`，并在 `:575`、`:613` 使用），这次新增路径绕过了它。控制中心客户端会严格解析响应（`apps/control-center/src/gateway-client.ts:268-271`），因此会整页规则加载失败。

- 建议：在 `#ruleQuote` 返回前复用 `singleLine`，或显式拒绝/清理控制字符并返回 `null`；长度校验放在清理之后，且与契约的计数方式一致。增加反向用例：原话含 `\n` 时，快照必须能通过 `gatewayV2MessageSchema.parse`，或者 `quote` 为 `null`。

### 2. 中（读代码证实）`lastUsed` 会把“待重审”记录当成“最近一次使用”

- 位置：`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:791-798`
- 问题：查询匹配任何 `inputs.ruleIds` 中含该规则的决定，没有区分决定类型。生产环境里，源记忆被编辑/删除时，SQLite 触发器会写入 `kind = 'rule_review'`、`ruleIds = [rule_id]` 的记录；这不是“使用规则”，而是“规则待重审”。真正使用规则的是 `proactive` 决定（规则引用带 `@revision`）。因此规则一旦被重审，`lastUsed` 会变成重审时间，甚至从未使用过的规则也会显示“最近使用”。
- 证据：

```sql
-- sqlite-decision-ledger-operations.ts:791-798
SELECT id, kind, checked_at AS decidedAt FROM decision_ledger
WHERE owner_id = ? AND agent_id = ? AND json_array_length(inputs, '$.ruleIds') > 0
  AND EXISTS (
    SELECT 1 FROM json_each(decision_ledger.inputs, '$.ruleIds') AS ref
    WHERE ref.value = ? OR substr(ref.value, 1, length(?) + 1) = ? || '@'
  )
ORDER BY checked_at DESC, id DESC LIMIT 1
```

```sql
-- migrations/0087_rule_book_memory_link.sql:339-352
SELECT 'rule-review:' || lower(hex(randomblob(12))), owner_id, agent_id, 'rule_review',
  NEW.updated_at, '{}', 'needs_review', ...
  rule_id,
  json_object('memoryIds', json_array(OLD.id), 'ruleIds', json_array(rule_id),
    'batchId', NULL, 'resultMemoryIds', json_array()),
```

真正使用规则的路径是 `proactive-rules.ts:44/69/90/112` 的 `ruleRef(id, revision)`，即带版本号。新增测试却伪造了 `kind: "rule_review"`、`reasonCode: "rule_used"`：

```ts
// test/integration/production-memory-capture.test.ts:1910-1924
kind: "rule_review",
decidedAt: "2026-11-11T08:00:00.000Z",
outcome: "needs_review",
reasonCode: "rule_used",
...
inputs: { memoryIds: [], ruleIds: [`${created["ruleId"]}@1`] },
```

`rule_used` 全仓库只出现在这一处测试，生产不会产生这种记录；测试因此把“重审即使用”的错误固化了。

- 建议：按产品语义改成只统计 `kind = 'proactive'`（或其他真正的使用类型），至少排除 `rule_review`；测试改用真实的 proactive 决定，并增加“编辑源记忆后 `lastUsed` 不变”以及“从未使用的规则在重审后仍为 `null`”的反向用例。如果产品确实想统计“最近一次被重审/引用”，则应改字段名和作者说明，不能叫 `lastUsed`。

### 3. 低（推测）`changes` 会把自动重审和重新确认也算进“修改次数”

- 位置：`apps/agent-service/src/production-memory-control.ts:537`
- 问题：`changes = Math.max(0, rule.revision - 1)` 与作者说法一致，但 `revision` 不只因主人修改规则内容而增加：源记忆编辑/删除的触发器会 `revision = revision + 1`（`migrations/0087_rule_book_memory_link.sql:357`、`:398`），`setStatus`（重新确认、撤销）也会 `revision = revision + 1`（`sqlite-owner-rule-operations.ts:180`）。如果界面文案“修改次数”指主人对规则的修改，这个数会偏大。
- 建议：明确该字段的产品定义。若只统计主人修改，改用规则历史中 `change_reason` 对应的次数；若确实要显示“版本号减一”，则界面文案应改。

### 4. 低（推测）严格对象契约使新旧客户端不能混跑

- 位置：`packages/gateway-contracts/src/validation.ts:174-176`、`contracts-v2.ts:1618-1631`
- 问题：契约对象拒绝未知字段。旧版 iOS/网页用旧 schema 解析新服务端响应时，新增的 `quote`、`changes`、`lastUsed` 会被判为 `unknown field`。如果服务端先于客户端发布，旧客户端会整体解析失败。
- 建议：确认客户端与服务端发布顺序或版本协商；若无法保证同版本发布，需要兼容策略或契约版本升级。

### 5. 低（推测）每条规则一次账本查询，账本大时可能变慢

- 位置：`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:790-812`
- 问题：`lastRuleUses` 对去重后的每个规则各执行一次 SQL，每次都要对 `inputs` 做 JSON 扫描；`#rules` 最多传入 32 个规则。对从未使用过的规则，查询会一直扫描到索引末尾。另有最多 32 次记忆载荷解密。页面的每 5 分钟刷新会重复这些工作。
- 建议：合并成一条带 `ruleIds IN (...)` 的查询，按规则分组取最新；或先按 `kind` 缩小范围，再评估索引。此项为性能推测，未实际压测。

## 侧重检查

- 错误路径：`#ruleQuote` 对 `readText` 做了 `catch`，但 `this.options.state.read` 未捕获；如果该端口在缺失/异常记录上抛错，会让整份规则列表失败。是否抛错未核实。
- 不合规范/不可信输入：`quote` 的多行文本是主要问题；`lastRuleUses` 对新输入做了数组、长度、类型校验，SQL 全部参数化，无法注入。数据库对 `inputs` 有 `json_valid` 约束，不存在畸形 JSON 路径。
- 安全：查询按 `ownerId`/`agentId` 隔离；`quote` 只返回主人自己的记忆文本，没有新增日志输出。`#ruleQuote` 只校验 `ownerId`、不校验 `agentId`，但 `sourceMemoryId` 来自同一 owner+agent 的规则行，未发现可达的跨 agent 读取路径。
- 资源耗尽：见发现 5，属推测风险。
- 不可撤销操作：本次没有新增写命令、迁移或删除操作，未发现不可撤销变更。
- 规则/文档一致：已读 `.claude/rules/prompt-prefix.md`；本改动未进入模型请求路径。作者“只加字段、不改表、不发模型、不加命令”基本成立；“lastUsed 是最近一次使用”与代码不一致，见发现 2。测试“297 项通过”未运行核实（工具限制），只能检查测试内容。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 依据：`memory.rules.read` 只由 `production-memory-control.ts:714` 的网关查询分支处理；模型提示里的主人规则来自 `service-main.ts:2294-2299` 的 `ownerRuleStore.list`，再由 `production-mcp-read.ts:1262-1273` 取 `StoredOwnerRule` 生成摘要，不读取新增的 `quote`/`changes`/`lastUsed`。本改动既不追加模型消息，也不修改系统提示、工具定义、历史或遮盖结果；所有新增动态值都在网页/iOS 快照里，不在最后一条消息或任何模型输入里。前提是以后不要把 `memory.rules.read` 的输出接入提示。

2. **对模型输入没有影响，因此不会让模型请求的同一段文字变成不同字节。** 同一规则快照的 `lastUsed` 会随时间变化，`quote` 也可能随源记忆编辑而变化，但这些字段只出现在网关响应里；规则顺序仍来自 `control.list()`，`lastUsed` 按规则 ID 查 Map，SQL 用 `checked_at DESC, id DESC LIMIT 1` 固定并列时的选择，未引入影响提示的无序集合或遮盖变化。

3. **自动检查不充分，反向用例没有覆盖这次新增的关键风险。** 新增了账本精确匹配/版本匹配/前缀不混淆/owner 隔离的测试，以及 production-memory-capture 的正向断言；但没有测试含换行的 `quote` 是否通过契约、没有测试 `quote` 为 `null` 的分支、没有测试 `lastRuleUses` 的非法输入上限，也没有测试真正的 `proactive` 使用记录是否会被 `rule_review` 重审记录抢占。更关键的是，新测试用生产不会产生的 `rule_review` + `rule_used` 记录模拟“使用”，所以发现 2 的行为不会被反向用例暴露。测试通过情况我未运行核实。

4. **逐个值核对：**
   - `quote`：产生于 `production-memory-control.ts:487-496`，消费端是 `contracts-v2.ts:1626` 的 `boundedString(500)`。两端对控制字符校验不一致，见发现 1；长度计数实现用 `Array.from`，契约用 `input.length`，正常创建路径因 `QUOTE_LIMIT` 用 `.length` 校验而通常安全，但记忆被编辑后仍有潜在不一致。
   - `changes`：产生于 `production-memory-control.ts:537`，消费端是 `integer(0)`，类型和最小值兼容；语义上的“修改次数”是否包含自动重审/重新确认需确认，见发现 3。
   - `lastUsed.at`：来自 `decision_ledger.checked_at`，写入校验为规范 UTC 时间（`sqlite-decision-ledger-operations.ts:66`），消费端 `timestamp` 可接受。
   - `lastUsed.kind`：数据库 `kind` 有 CHECK 枚举（migration 0087:21-26），消费端 `machineString` 可接受。
   - `lastUsed.decisionId`：写入端只校验长度 1-128（migration 0087:18），消费端要求 `machineString`；正常生成器产生的 ID 满足，但导入的异常 ID 可能不满足。这是既有假设，不是本改动独有。
   - `revision`、`sourceMemoryId`：新增在内部 `ListedOwnerRule`，消费端只有 `#rules` 和测试；`sourceMemoryId` 的 `null` 已在 `#ruleQuote` 处理，类型检查通过。
   - 新端口 `lastRuleUses`：已同时加入 `durable-adapters.ts` 和 SQLite 操作 switch，worker/direct 测试覆盖；未发现遗漏的适配器实现。
   - 契约新增字段是严格对象的必需字段，旧客户端兼容性需确认，见发现 4。
