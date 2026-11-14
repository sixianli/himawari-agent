# 复核结论

## 一、读代码证实的问题

### 1. 严重度：中 — `rule_undo` 把本轮新增的 `revision`、`sourceMemoryId` 原样送给模型，与“只从 `rule_list` 去掉”的说法不一致

**文件:行**：`apps/agent-service/src/production-owner-rules.ts:786-795`、`:822`

**问题**：作者说“`rule_list` 给模型的结果去掉 revision 和 sourceMemoryId”，`rule_list` 确实去掉了；但 `rule_undo` 工具返回的是 `this.#writer.undo()` 的完整 `ListedOwnerRule`，而该接口本轮新增了这两个字段，于是它们仍会进入模型可见的 tool result。`rule_list` 和 `rule_undo` 对同一批字段的处理不一致，且这是本轮新引入的模型可见变化。

**证据**：
```ts
// production-owner-rules.ts:786-795
return Object.freeze({
  ruleId,
  type,
  summary,
  status: "retired",
  enforced: false,
  updatedAt: this.#options.clock.now(),
  revision: latest.revision,          // 本轮新增
  sourceMemoryId: latest.sourceMemoryId, // 本轮新增
});
```
```ts
// production-owner-rules.ts:822
return { undone: await this.#writer.undo(ruleId) };
```
对照 `rule_list` 的剥离逻辑：
```ts
// production-owner-rules.ts:811-816
const rules = await this.#writer.list();
return {
  rules: rules.map(
    ({ revision: _revision, sourceMemoryId: _sourceMemoryId, ...rule }) => rule,
  ),
};
```
`rule_undo` 是 `ownerRuleToolDescriptors()` 注册的模型工具（`:196-207`），返回值由 `#ownerRule` 原样写入 `runtime-tool-output`（`production-runtime-tools.ts:609-623`），因此模型会看到这两个字段。

**建议**：在 `rule_undo` 的返回处也做同样的剥离，例如复用 `#publicRule()` 之类的投影函数；并补一条断言 `rule_undo` 结果键集合的反向用例。

---

### 2. 严重度：中 — `memory.rules.snapshot` 新增必填字段，但没有版本协商，新旧服务端/客户端混跑会整页解析失败

**文件:行**：`packages/gateway-contracts/src/contracts-v2.ts:1615-1631`、`packages/gateway-contracts/src/validation.ts:174-183`、`apps/control-center/src/gateway-client.ts:268-271`、`apps/control-center/src/memory.ts:107-111`

**问题**：契约的 `object()` 既拒绝未知字段，又要求所有字段都必须存在。新增的 `quote`、`changes`、`lastUsed` 都是必填键。新客户端 + 旧服务端会因“missing required field”失败；旧客户端 + 新服务端会因“unknown field”失败。失败发生在客户端解析响应时，`useMemory` 的 `.catch` 只会把 `failed` 置真，规则列表无法更新。作者已说明“新旧客户端混跑不改”，但这确实是本次契约改动的直接后果，不能当作无影响。

**证据**：
```ts
// contracts-v2.ts:1626-1630
quote: nullable(boundedString(500)),
changes: integer(0),
lastUsed: nullable(
  object({ at: timestamp, kind: machineString, decisionId: machineString }),
),
```
```ts
// validation.ts:174-183
for (const key of Object.keys(record)) {
  if (!expectedKeySet.has(key)) fail(`${path}.${key}`, "unknown field");
}
...
if (!Object.hasOwn(record, key)) fail(`${path}.${key}`, "missing required field");
```
```ts
// gateway-client.ts:268-271
function parsedResponseBody(value: unknown): GatewayV2Snapshot {
  const parsed = gatewayV2MessageSchema.parse(value);
```
```ts
// memory.ts:107-111
if (result.type !== "memory.rules.snapshot") throw new Error("RULES_INVALID");
...
.catch(() => { if (!disposed) setFailed(true); });
```

**建议**：要么在同一次发布中强制服务端与控制中心一起升级；要么把新字段做成可选（需要给 `object()` 增加 optional 支持），或新增/升级 snapshot 类型，由 `installedGatewayV2Operations` 之外再按字段版本协商。若确定不处理，建议至少加一条跨版本契约测试，明确这是已知且可接受的破坏。

---

### 3. 严重度：低 — `lastUsed.decisionId` / `lastUsed.at` 直接沿用账本值，没有按网关契约重新校验；数据导入路径允许不合规值（I-73 同类）

**文件:行**：`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:791-810`、`packages/gateway-contracts/src/contracts-v2.ts:1629`、`packages/persistence-sqlite/src/data-export/schemas.ts:48`、`:189`、`:200`、`packages/persistence-sqlite/src/data-export/import.ts:554-566`

**问题**：`lastRuleUses` 把 `decision_ledger.id` 和 `checked_at` 直接作为 `decisionId` 和 `at` 返回；契约要求 `decisionId` 是 `machineString`（1-128，只允许 `[A-Za-z0-9._:-]`），`at` 是规范 UTC 毫秒时间。正常主动检查的 id 由 `productionIds()` 生成 `proactive-decision:<uuid>`，能过；但数据导入的 schema 对账本 `id` 只要求 `text(1,128)`，对 `checkedAt` 只要求长度 20-40，导入时又直接写入（`import.ts:554-566`）。因此一条从导入数据来的主动决定就可以让整个 `memory.rules.snapshot` 在客户端校验失败，进而规则页不可用。这正是 I-73 的教训：只在一端认。

**证据**：
```ts
// sqlite-decision-ledger-operations.ts:791-810
SELECT id, kind, checked_at AS decidedAt FROM decision_ledger
...
found.push(Object.freeze({
  ruleId,
  decisionId: row.id,
  kind: row.kind as RuleLastUse["kind"],
  decidedAt: row.decidedAt,
}));
```
```ts
// data-export/schemas.ts:48
const timestamp: JsonSchema = { type: "string", minLength: 20, maxLength: 40 };
// data-export/schemas.ts:189,200
id: text(1, 128),
checkedAt: timestamp,
```
```ts
// data-export/import.ts:554-560
decision.run(
  item.id,
  ownerId,
  agentId,
  item.kind,
  item.scenario,
  item.checkedAt,
```
另外 `validateDecision`（`sqlite-proactive-operations.ts:612-630`）没有检查 `decision.id`。

**建议**：在 `lastRuleUses` 返回前用与网关契约相同的规则过滤/校验 `decisionId` 与 `decidedAt`（不合格时把 `lastUsed` 置 null），或把契约的 `decisionId` 放宽为 `boundedString`，并加一条“导入/损坏账本下规则快照仍能解析”的测试。若导入路径本应更严格，也应同时收紧 `DECISION_SCHEMA`。

---

### 4. 严重度：低 — 规则数超过 64 时 `memory.rules.read` 会直接抛错，整个规则列表不可用

**文件:行**：`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:783-789`、`apps/agent-service/src/production-memory-control.ts:524-525`

**问题**：`#rules` 把全部未退休规则的 id 一次性交给 `lastRuleUses`，而 `lastRuleUses` 在 `ruleIds.length > 64` 时 `fail("PORT_INVALID_OPERATION")`。正常创建路径每人最多 32 条生效规则（`ACTIVE_RULE_LIMIT = 32`），所以正常不会触发；但数据导入的规则没有数量上限，`sqlite-owner-rule-operations.ts:11` 的 `MAX_LISTED = 200` 也表明读取端考虑过更多规则。只要库里有 65 条以上 `owner:` 规则，规则页就整个查询失败。

**证据**：
```ts
// sqlite-decision-ledger-operations.ts:783-789
if (
  !Array.isArray(input.ruleIds) ||
  input.ruleIds.length > 64 ||
  ...
)
  this.fail("PORT_INVALID_OPERATION", "Ledger rule ids are invalid");
```
```ts
// production-memory-control.ts:524-525
const listed = (await control.list()).filter((rule) => rule.status !== "retired");
const lastUsed = await this.#ruleLastUsed(new Set(listed.map(({ ruleId }) => ruleId)));
```
```ts
// sqlite-owner-rule-operations.ts:11
const MAX_LISTED = 200;
```

**建议**：按 64 条分批查询后合并，或改成一条 SQL 用 `json_each` 遍历规则 id 数组，避免把“读取上限”当成“写入校验”直接抛错；同时给 `#rules` 加一条超过 64 条规则的测试。

---

### 5. 严重度：低 — `changes` 的“修改次数”定义不直，包含状态翻转和来源记忆变更，作者已列为不改

**文件:行**：`apps/agent-service/src/production-memory-control.ts:537`、`packages/persistence-sqlite/src/sqlite-owner-rule-operations.ts:180`、`packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql:357-360`、`.claude/rules/owner-standing-rules.md:33`

**问题**：`changes = revision - 1`。`revision` 不只在规则内容变化时增加：`setStatus` 的撤销/确认会增加一次（`revision = revision + 1`），来源记忆被编辑/归档导致 `needs_review` 时触发器也会增加一次。界面上如果把它显示成“修改次数”，主人会看到“规则说明从未变过，但改动次数已经 3 次”。Andy 的长期规则要求界面上的每个数字有可验证的定义，作者也明确说这条不改，因此这里只记录为待 Andy 定的语义问题。

**证据**：
```ts
// production-memory-control.ts:537
changes: Math.max(0, rule.revision - 1),
```
```ts
// sqlite-owner-rule-operations.ts:180
`UPDATE rule_book_rules SET status = ?, revision = revision + 1, updated_at = ?
```
```sql
-- 0087_rule_book_memory_link.sql:357-360
UPDATE rule_book_rules SET status = 'needs_review', revision = revision + 1,
  updated_at = NEW.updated_at
...
```

**建议**：要么改名为“版本数/改动次数”并写清包含哪些变化；要么单独统计规则参数/说明的变更次数；要么按主人的长期规则不显示这个数字。

---

### 6. 严重度：低 — 新增快照字段没有从真实生产者过网关契约的自动检查；反向用例只覆盖了三处修复

**文件:行**：`test/integration/production-memory-capture.test.ts:1894-1903`、对照 `:630-640`、`packages/gateway-contracts/test/gateway-v2.fixture.ts:781-796`

**问题**：测试里的 `listed()` 直接返回 `context.control.query()` 的对象，没有像 `gatewayOverview` 那样把快照交给 `gatewayV2MessageSchema.parse`。因此新增的 `quote`、`changes`、`lastUsed` 只在手写 fixture 里过了契约，真实生产者与契约之间没有端到端校验。上文第 3 条的 `decisionId`/`at` 问题、以及未来 `quote` 长度口径变化，都不会被现有测试拦住。

**证据**：
```ts
// production-memory-capture.test.ts:1894-1903
const listed = async () => {
  const snapshot = await context.control.query({...});
  if (snapshot.type !== "memory.rules.snapshot") throw new Error("snapshot");
  return snapshot.payload.rules;
};
```
对照：
```ts
// production-memory-capture.test.ts:630-640
const gatewayOverview = async (control) => {
  ...
  return gatewayV2MessageSchema.parse({
    ...snapshotEnvelope,
    kind: "snapshot",
    type: "memory.overview.snapshot",
    payload,
  }).payload;
};
```

**建议**：把 `listed()` 也包一层 `gatewayV2MessageSchema.parse`；并补上第 3、4 条的边界用例。当前三处修复本身的反向用例是有效的（见问题 3 的回答）。

---

## 二、推测 / 未核实

1. **`singleLine` 只处理 `<0x20` 和 `0x7f`，不处理 U+0085、U+2028、U+2029。**
   证据：`production-memory-control.ts:114-122` 只把 `code < 0x20 || code === 0x7f` 换成空格；`validation.ts:96-99` 同样只拒绝这些码点。因此“原话含换行不再让快照解析失败”对 `\n` 成立，但 Unicode 行分隔符会原样保留，`singleLine` 的命名与行为不完全一致。契约不会因此失败，是否影响渲染需看前端。未找到会使用这些字符的测试。

2. **新字段目前没有前端消费方。**
   `OwnerRulesSection`（`apps/control-center/src/components/rule-receipt.tsx:190-215`）只渲染 `type/status/summary`，没有读取 `quote/changes/lastUsed`。如果本 PR 的目标包含网页上的“规则详情”，那么功能只到 API 层；如果 UI 是后续 PR，则不算缺陷。未核实产品范围。

3. **敏感原话的展示口径。**
   ADR 0213 写明带密码/证件号/银行卡号的原话按 `sensitive` 保存，但新的 `memory.rules.snapshot` 条目没有 `dataClassification` 字段，`#ruleQuote` 直接返回解密后的原文。当前前端未渲染，暂时没有实际影响；若后续直接显示，可能绕过记忆页对敏感记忆的标记方式。未核实前端计划。

4. **性能。**
   `#ruleLastUsed` 对每条规则各执行一次 `ORDER BY ... LIMIT 1`，`#rules` 再对每条规则读取并解密来源记忆。正常上限 32 条，作者已说明性能问题留给 Andy。未做基准，无法判断实际影响。

---

## 三、侧重检查

我按“错误路径、不合规范/不可信输入、安全、资源耗尽、不可撤销操作、规则/文档与代码一致”逐项看了：

- **错误路径**：`#ruleQuote` 对缺失记录、非本 owner、payload 缺失/非 `text/plain`、UTF-8 解码失败都返回 `null`（`production-memory-control.ts:487-496`），不会让整页失败；`state.read` 本身的数据库异常没有兜底，会向上抛。
- **不可信输入**：规则 id 走参数化 SQL，无注入；`ruleIds` 有长度和类型校验；但导入路径的账本 `id`、`checked_at` 校验宽松（见问题 3）。
- **范围/安全**：`state.read` 只按 id 读、只校验 owner；由于 `memory_records.id` 是全局主键，且 payload 读取按 owner/agent scope，未见跨 agent 泄漏（`0001_initial_product_schema.sql:393-408`）。`sourceMemoryId` 会通过 `rule_undo` 进入模型，但 `rule_set` 本来就返回 `memoryId`，不是新的秘密边界。
- **资源耗尽**：正常规则数 ≤32；超过 64 会让 `memory.rules.read` 直接失败（见问题 4）。每规则一次 SQL + 一次解密，未做压测。
- **不可撤销操作**：撤销仍先归档来源记忆、再停用规则，行为未变；本次新增的读取路径不写库。
- **规则/文档一致性**：`.claude/rules/prompt-prefix.md` 与本次改动无冲突；`.claude/rules/owner-standing-rules.md:33` 对界面数字的定义要求与 `changes` 的定义有张力（见问题 5）。ADR 0213 的“原话按 sensitive 保存”与新增快照无分类字段值得后续确认（见推测 3）。

---

## 四、必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会改变已发出的系统提示、工具定义和历史前缀。** 依据与核对：

- 系统提示、工具描述本轮没有改动；`ownerRuleToolDescriptors()` 的工具名和参数结构未变。
- `rule_list` 的模型可见结果在剥离 `revision`/`sourceMemoryId` 后，键集合和顺序恢复到本功能之前（`ruleId,type,summary,status,enforced,updatedAt`），不会改写已存历史。
- `quote/changes/lastUsed` 只出现在 `memory.rules.snapshot`（`production-memory-control.ts:542-547`），这是控制中心网关响应，不是模型上下文；`memory.rules.read` 只被控制中心和测试使用。
- **但** `rule_undo` 的新调用会拿到新增的 `revision`/`sourceMemoryId`，这是新追加的 tool result，不违反“只在末尾追加”，但和作者“从给模型的结果里去掉”的目标不一致（见问题 1）。
- 每轮会变的 `lastUsed.at`、`generatedAt` 留在网关快照里，没有进入系统提示、工具定义或最后一条用户消息之外的位置；模型输入仍是只在末尾追加。

结论：**仍然只追加，没有改变已见开头；但 `rule_undo` 的 tool result 出现未预期的字段。**

### 2. 会不会让同一段文字在不同请求里变成不同字节？

- 对模型请求：不会。新增字段不在模型上下文；`rule_list` 输出已恢复原形状。
- 对网关快照：`generatedAt` 和 `lastUsed.at` 按设计随请求/新决策变化；`quote/changes` 对同一数据库状态是确定的。规则顺序来自 `ORDER BY updated_at DESC, rule_id`，`lastRuleUses` 顺序来自输入顺序 + `ORDER BY checked_at DESC, id DESC`，没有无序集合或前后文相关遮盖。
- `singleLine` 是确定的字符串变换，不依赖请求上下文。若来源记忆被编辑，`quote` 会变，但那是数据变化，不是同一内容的非确定序列化。

### 3. 有没有对应的自动检查，反向用例真的会失败？

三处修复都有有效反向用例：

- **quote 过 `singleLine`**：`test/integration/production-memory-capture.test.ts:2178-2183` 创建含 `\n` 的原话并断言详情为单行；去掉 `singleLine` 会得到带换行的原话，断言失败。
- **lastUsed 只算 `proactive`**：`test/integration/decision-ledger.test.ts` 新用例把 `rule_review` 放在 `proactive` 之后（11:00 > 08:00），期望仍返回 08:00 的主动决定；`test/integration/production-memory-capture.test.ts:1911-1928` 又断言只有重审记录时 `lastUsed` 为 null。去掉 `kind = 'proactive'` 两处都会失败。
- **rule_list 去掉字段**：`test/integration/production-memory-capture.test.ts:2172-2177` 断言 `revision` 和 `sourceMemoryId` 不在键里；去掉剥离逻辑会失败。

缺口：

- 没有 `rule_undo` 字段剥离的反向用例，因此问题 1 不会被发现。
- 没有把真实生产者快照交给 `gatewayV2MessageSchema.parse` 的测试，问题 3、4 不在自动检查范围内。
- 契约 fixture 只验证手写 fixture（`packages/gateway-contracts/test/gateway-v2.contract.test.ts:34-43`），不验证真实 `#rules` 输出。

### 4. 每个产生或修改的值，使用它的两端都能接受吗？

逐个核对如下：

| 值 | 产生处 | 使用处 / 校验 | 结论 |
|---|---|---|---|
| `quote` | `#ruleQuote`，`production-memory-control.ts:487-496`：非空、无 `<0x20/0x7f`、`length <= 500`（UTF-16） | 契约 `nullable(boundedString(500))`（`contracts-v2.ts:1626`），`boundedString` 同样按 `input.length` 检查且拒绝控制字符（`validation.ts:89-106`） | 一致；U+2028/2029 等 Unicode 分隔符两边都不拒绝，见推测 1 |
| `changes` | `Math.max(0, rule.revision - 1)`，`production-memory-control.ts:537`；revision 由建规则=1、`setStatus` +1、0087 触发器 +1 产生 | 契约 `integer(0)`（`contracts-v2.ts:1627`） | 数值两端接受；语义见问题 5 |
| `lastUsed.at` | `decision_ledger.checked_at`，`sqlite-decision-ledger-operations.ts:791-810` | 契约 `timestamp`（`contracts-v2.ts:1629`），要求 `new Date(x).toISOString()===x`（`validation.ts:115-125`） | 正常写入路径一致；导入/损坏数据可能不一致，见问题 3 |
| `lastUsed.kind` | SQL 固定 `kind = 'proactive'` | 契约 `machineString` | 一致 |
| `lastUsed.decisionId` | `decision_ledger.id` | 契约 `machineString`（1-128，含字符集限制） | 正常生成一致；导入数据 `id` 只校验长度 1-128，可能不一致，见问题 3 |
| `revision` | `ListedOwnerRule`（`:239`），来自 owner rule 行 | `#rules` 只用来算 `changes`；`rule_list` 已剥离；`rule_undo` 未剥离 | **两端不一致**，见问题 1 |
| `sourceMemoryId` | 同上（`:240`） | `#ruleQuote` 使用；`rule_list` 已剥离；`rule_undo` 未剥离 | **两端不一致**，见问题 1 |
| `lastRuleUses` 新端口方法 | `DecisionLedgerPort`（`decision-ledger.ts:348-350`）、`durable-adapters.ts:1093`、`sqlite-decision-ledger-operations.ts:305-306` | 只有 `#ruleLastUsed` 调用；适配器/端口实现齐全 | 一致 |
| `memory.rules.snapshot` 新必填字段 | `#rules` 总是给出 `quote/changes/lastUsed` | 新客户端契约接受；旧客户端/旧服务端不兼容 | 同版本一致，混跑不一致，见问题 2 |
| 配置键/清单项 | 无新增；`memory.rules.read` 已在 `installedGatewayV2Operations` 中 | 无新增清单需要同步 | 一致 |

**作者说法核对汇总**：

- “quote 过 `singleLine`，含换行不再让快照解析失败” — **成立**（对 `\n`/`\r`；Unicode 行分隔符见推测 1）。
- “lastUsed 只统计 `kind=proactive` 的决定，测试改用真实 proactive 决定并加重审不覆盖的反向用例” — **成立**。
- “`rule_list` 给模型的结果去掉 `revision` 和 `sourceMemoryId`” — 对 `rule_list` **成立**；但 `rule_undo` 仍会把这两个字段送给模型，整体目标未完全达成。
- “其余意见（性能、changes 的定义、新旧客户端混跑）不改” — 与代码现状一致；这三项仍是实际风险，尤其新旧混跑会让规则页解析失败。
