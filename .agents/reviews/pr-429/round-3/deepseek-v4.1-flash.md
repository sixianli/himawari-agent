## 结论摘要

增量（`ead95246..bd87de35`）确实修掉了上一轮指出的 `rule_undo` 泄漏和 `lastUsed` 未分批、未过契约的问题；模型可见的工具结果字段集合与 PR 前一致，规则快照只供网页使用，不进入模型请求。主要遗留问题：`decisionId` 的过滤规则与网关 `machineString` 不一致（I-73 同类问题），`quote` 绕过了记忆页的可见性/状态检查，以及新增的 `quote`/`changes`/`lastUsed` 在网页端没有任何消费者。

## 读代码证实的问题

### 1. 中：`lastUsed.decisionId` 的过滤规则比网关契约宽，坏 id 会让整个规则快照解析失败

文件：`apps/agent-service/src/production-memory-control.ts:517`

问题：作者说“过滤不合契约的决定编号”，但这里的正则并不等于网关的 `machineString`：它允许首字符是 `.`、`_`、`:`、`-`，也允许单字符标点。这样做出来的 `lastUsed.decisionId` 能通过本地过滤，却过不了网关契约。

证据：

```ts
// production-memory-control.ts:517
if (/^[A-Za-z0-9._:-]{1,128}$/u.test(use.decisionId))
```

```ts
// packages/gateway-contracts/src/validation.ts:51-55
typeof input !== "string" ||
input.length > 128 ||
!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(input)
```

```ts
// packages/gateway-contracts/src/contracts-v2.ts:1628-1630
lastUsed: nullable(
  object({ at: timestamp, kind: machineString, decisionId: machineString }),
),
```

而 `decision_ledger.id` 本身只校验长度，不校验字符集：`migrations/0089_consolidation_hold.sql:18` 是 `CHECK (length(id) BETWEEN 1 AND 128)`；数据导入的 `DECISION_SCHEMA.id` 也是 `text(1, 128)`（`data-export/schemas.ts:189`）。也就是说生产内部生成的 `proactive-decision:<uuid>` 目前安全，但导入/历史数据里的 `.legacy`、`-1` 这类 id 会通过上面的过滤，然后被控制台的 `gatewayV2MessageSchema.parse` 拒绝，表现是整页规则读取失败（`apps/control-center/src/memory.ts:103-112` 的 catch 设 `failed`）。

建议：直接复用 `machineString`（失败就跳过该条），或改成与契约完全相同的 `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u`；同时补一条反向用例：塞入 `.bad`/`-1` 作为 `decisionId`，要求快照仍能过契约，且该 `lastUsed` 被丢弃。

### 2. 中低（需产品确认）：`quote` 绕过了记忆页的可见性/状态检查

文件：`apps/agent-service/src/production-memory-control.ts:487-495`

问题：`#ruleQuote` 只检查了 `ownerId`，没有检查 `agentId`、记忆状态，也没有用 `reviewMemoryVisible`。而记忆总览对 `trashed`/`deletion_pending`/`deleted_verified` 是隐藏正文的。规则来源记忆被删除/放进回收站时，迁移里的触发器只把规则改成 `needs_review`（仍出现在规则列表），不会清掉 `source_memory_id`，于是规则页仍会把回收站里记忆的原话显示出来。

证据：

```ts
// production-memory-control.ts:489-495
const record = await this.options.state.read(sourceMemoryId as MemoryId);
if (!record || record.ownerId !== this.options.configuration.ownerId) return null;
const text = await this.readText(record.contentRef).catch(() => null);
...
return quote.length > 0 && quote.length <= 500 ? quote : null;
```

```ts
// production-memory-control.ts:693-707（记忆总览的可见性规则）
if (record.status === "deletion_pending" || record.status === "deleted_verified" ||
    record.status === "trashed") {
  texts.set(record.id, { text: null, hidden: false });
  continue;
}
if (!reviewMemoryVisible(record.dataClassification)) { ... }
```

```sql
-- migrations/0087_rule_book_memory_link.sql:301-312
CREATE TRIGGER memory_rule_needs_review AFTER UPDATE ON memory_records
...
OR (NEW.status IS NOT OLD.status
  AND NEW.status IN ('archived', 'trashed', 'deletion_pending', 'deleted_verified'))
...
UPDATE rule_book_rules SET status = 'needs_review', ...
```

`read` 本身没有按状态过滤（`packages/persistence-sqlite/src/sqlite-memory-operations.ts:580-585`）。回收站里的记忆正文通常还在，因此这条路径可读；`deleted_verified` 是否还能读到取决于 payload 是否已清，未核实。

建议：按记忆总览同样的规则处理（至少拒绝 `trashed`/`deletion_pending`/`deleted_verified`，并考虑 `reviewMemoryVisible`），或者在 ADR/测试里明确“规则重审时允许展示已删除原话”这一产品决定；补一条“来源记忆进回收站后 quote 为 null（或规则不再展示）”的用例。

### 3. 低：新增的 `quote`/`changes`/`lastUsed` 在网页端没有消费者

文件：`apps/control-center/src/components/rule-receipt.tsx:190-215`

问题：作者的目标是“规则详情带原话、修改次数和最近一次使用”，但控制台唯一渲染规则列表的 `OwnerRulesSection` 仍只显示 `type`、`status`、`summary`、`enforced` 和按钮；`RuleReceiptCard` 也只显示 `summary`/试算/回放。整个 `apps/control-center/src` 没有引用规则的 `quote`、`changes`、`lastUsed`（grep 到的 `quote`/`lastUsed` 属于记忆页和决策链，不是规则）。测试里的 `rule()` 只是把这些字段补进 helper，没有任何渲染断言。

证据：

```tsx
// rule-receipt.tsx:190-197
{memory.rules.map((rule) => (
  <section ... key={rule.ruleId} ...>
    <span ...>{message("rules.type", { t: rule.type })}</span>
    ...
    <p className="memory-text">{rule.summary}</p>
```

```ts
// apps/control-center/src/memory.ts:17-20
export type OwnerRule = Extract<GatewayV2Snapshot, { type: "memory.rules.snapshot" }>["payload"]["rules"][number];
```

这不是运行时错误，但意味着“字段已加、功能未落地”。如果本 PR 只想先加网关字段，建议在说明/ADR 里写清后续消费者；否则应补 UI 和 UI 测试。

### 4. 低：`undo()` 返回的 `revision`/`updatedAt` 是改动前的旧值

文件：`apps/agent-service/src/production-owner-rules.ts:773-795`

问题：`undo()` 用 `latest.revision` 作为返回的 `revision`，但紧接着的 `setStatus` 会把 revision 加一，并且 `updatedAt` 又单独取了一次 `clock.now()`，不是 `setStatus` 返回的 `changed.updatedAt`。当前这个值被 `modelVisibleRule` 去掉，也没有别处使用，所以只是潜在问题；一旦后续有人拿 `undo().revision` 做 `expectedRevision` 或展示“修改次数”，就会是错的。

证据：

```ts
const latest = await this.#options.rules.read({ ...this.#scope(), ruleId });
...
const changed = await this.#options.rules.setStatus({
  ...this.#scope(),
  ruleId,
  status: "retired",
  expectedRevision: latest.revision,
  ...
});
...
return Object.freeze({
  ruleId, type, summary, status: "retired", enforced: false,
  updatedAt: this.#options.clock.now(),
  revision: latest.revision,
  sourceMemoryId: latest.sourceMemoryId,
});
```

```ts
// sqlite-owner-rule-operations.ts:180-181
`UPDATE rule_book_rules SET status = ?, revision = revision + 1, updated_at = ? ...`
```

建议：使用 `setStatus` 返回的 `changed`（`revision`/`updatedAt`）构造返回值；如果规则本来就是 retired，再退回 `latest`。

## 推测 / 未核实

- **`:ruleLastUsed` 的查询成本**：`lastRuleUses` 对每个规则执行一次带 `json_each` 的关联子查询（`sqlite-decision-ledger-operations.ts:790-813`），虽然 `decision_ledger_time_index` 可按 `(owner, agent, kind, checked_at)` 倒序扫描，但长期未使用的规则仍可能扫完整个人的历史。导入数据允许 200 条规则（`RULE_SCHEMA.ruleId` 上限 64、`ownerRule.list` 上限 200），而应用内创建的上限是 32，所以“最多 32 条”的假设对导入数据不成立。没有基准数据，未量化。
- **新旧客户端混跑**：`object()` 会拒绝未知字段（`validation.ts:173-176`），而新字段是必填项。新网页配旧服务端会因缺 `quote/changes/lastUsed` 解析失败；旧网页配新服务端会因多出字段失败。作者说本轮不改混跑问题，这是已接受风险，但代码里没有版本降级或字段可选化，未核实是否有部署侧规避。
- **文档一致性**：`docs/adr/0213-owner-sentence-becomes-a-standing-rule.md:63` 只写了新增 `memory.rules.read`/`memory.rule.respond`，没有记录新字段；仓库里也没有 `quote`/`changes`/`lastUsed` 的规则接口说明。若项目要求接口变更同步文档，这里缺一块；未核实文档规范是否强制。

## 侧重检查

- **I-73 式两端校验**：逐项对了 `decisionId` 的生产端（`decision_ledger.id` 仅长度）和消费端（`machineString`），发现过滤正则与契约不一致，见问题 1。`quote`/`changes`/`lastUsed.at`/`lastUsed.kind` 的两端也核了：`quote` 用 `boundedString(500)`，`changes` 用 `integer(0)`，`at` 来自已校验的 `checked_at`，正常值都能过。
- **不可信/非法输入**：`lastRuleUses` 校验了数组、最多 64 个、每个 1-128 字符；SQL 全部用绑定参数，没有字符串拼接或 `LIKE` 通配符注入。但空数组、重复 id 只是被容忍/去重，没有专门测试；坏字符集的 id 会通过消费者正则，见问题 1。
- **错误路径**：`#ruleQuote` 对 `readText` 有 `.catch(() => null)`，但 `state.read` 本身没有保护；单条记忆读取异常会让整个规则查询失败。这是新增的失败面，暂未列入高严重度，因为状态读取通常是本地 SQLite。
- **隐私/不可逆操作**：本改动是只读；但 `quote` 可能把回收站记忆的正文带回规则页，见问题 2。未发现新增删除/撤销类写操作。
- **资源耗尽**：批量 64 只解决端口上限，不减少总查询数；每条规则仍是一次独立 SQL 扫描，见“推测”。`Promise.all` 最多并发 32（应用内）或 200（导入），上限受列表限制，未发现无界循环。
- **规则文件/代码一致性**：`prompt-prefix.md` 要求的“只追加、会变的值只放最后”没有在本改动中涉及模型请求，见必答问题 1；文档缺口见上述“推测”。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

不会。依据：

- 模型可见的规则工具结果没有净变化。`modelVisibleRule` 把 `ListedOwnerRule` 新增的 `revision`/`sourceMemoryId` 去掉（`production-owner-rules.ts:799-803`），`rule.list`/`rule.undo` 的输出字段集合和顺序回到 PR 基线（`12ce0d0a`）的 6 个字段；文字、工具定义都没有改。
- 新增的 `quote`/`changes`/`lastUsed` 只出现在 `memory.rules.snapshot`，该快照只被控制台的 `useMemory` 读取（`apps/control-center/src/memory.ts:103-112`），`query()` 的分发也只在网页控制面（`production-approval-gateway.ts:108-128`），没有进入系统提示、工具定义或历史消息。
- 因此发给模型的内容仍然只在末尾追加工具结果；本改动没有把任何每轮变化的值塞进系统提示或历史开头。若将来把该快照放进提示词，`lastUsed`/`generatedAt` 就会违反“会变的值只能放最后一条消息”的规则，需要当时再按 `prompt-prefix.md` 处理。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

对模型请求不会。依据：

- 工具结果键序固定：`modelVisibleRule` 的对象剩余展开保持原插入顺序，去掉的两个字段原本在末尾，所以和 PR 前逐字节顺序一致。
- 规则列表顺序来自 `ownerRule.list` 的 `ORDER BY updated_at DESC, rule_id`，有确定次序；`lastRuleUses` 也有 `ORDER BY checked_at DESC, id DESC` 兜底；`#rules` 的 `Promise.all` 保持数组顺序。
- `quote` 只取决于该规则来源记忆的当前文字和 summary，不使用后续消息或其它请求的内容；`singleLine` 是确定变换。
- 唯一会随请求变化的是网页快照里的 `lastUsed` 和既有的 `generatedAt`，它们不进模型请求；如果以后进模型请求，就会违反此条。

### 3. 有没有对应的自动检查，反向用例真的会失败吗？

有检查，但覆盖不完整。未运行测试（工具限制只允许读和 git 命令），以下按代码判断：

- 会失败的反向：
  - `modelVisibleRule` 去掉后，`production-memory-capture.test.ts:2171-2191` 的 `not.toContain("revision")`/`not.toContain("sourceMemoryId")` 会失败。
  - 网关契约去掉新字段后，`gateway-v2.fixture.ts:781-800` 的 round-trip 会因未知字段失败；生产 #rules 少字段时 `production-memory-capture.test.ts:1902-1903` 的 `gatewayV2MessageSchema.parse` 会失败。
  - `lastRuleUses` 去掉 `kind='proactive'` 后，`decision-ledger.test.ts:431-526` 和集成测试里 09:00 的 `rule_review` 会顶掉 08:00 的 `proactive`，用例会失败。
  - 多行 quote 不去 `singleLine` 时，`production-memory-capture.test.ts:2185` 的 `toBe("... 以后必须通知我")` 会失败。
- 不会失败的反向：
  - `decisionId` 过滤没有反向用例；把 `.bad`/`-1` 塞进账本，现有测试仍全绿，因为过滤和契约的差异没被测到（问题 1）。
  - 分批 64 没有 >64 规则的用例；当前应用内上限 32，删除分批逻辑测试也不会失败。
  - `quote` 在来源记忆被回收站/删除后的行为没有用例。
  - `changes` 在重新确认、来源记忆自动转 `needs_review` 后是否应计数没有断言。
- 另有一个测试宽松点：`production-memory-capture.test.ts:1902` 先剥掉测试 envelope 多带的 `idempotencyKey` 再解析，解析的不是生产实际发出的完整对象；生产查询本身不带该字段，所以不构成产品问题，但测试强度略低。

### 4. 改动产生/修改的每个值，使用它的地方都能接受吗？

逐项核对：

- **`ListedOwnerRule.revision` / `sourceMemoryId`**：生产端是 `list()`、`reconfirm()`、`undo()`（`production-owner-rules.ts:685-737, 766-795`）；消费端是 `#rules` 和 `modelVisibleRule`。`#rules` 能接受（`revision` 用于 `changes`，`sourceMemoryId` 用于 quote）；模型侧已投影掉。注意 `undo()` 返回的 `revision` 是旧值，见问题 4。
- **`quote`**：生产端 `#ruleQuote`（`production-memory-control.ts:487-496`）；消费端网关 `boundedString(500)`（`contracts-v2.ts:1626`）能接受正常值；网页端目前完全不消费（问题 3）。同时生产端没有检查记忆状态/分类，见问题 2。
- **`changes`**：生产端 `Math.max(0, rule.revision - 1)`（`production-memory-control.ts:544`）；消费端 `integer(0)` 能接受。语义上 `revision` 也会被触发器（来源记忆变更）和 `reconfirm` 增加，因此“改动次数”包含自动转重审和重新确认；作者说定义未变，但如果 UI 文案叫“变过 N 次”，需要确认这个口径。
- **`lastUsed.at` / `kind` / `decisionId`**：生产端 SQL 返回 `checked_at`、硬编码的 `proactive`、`decision_ledger.id`（`sqlite-decision-ledger-operations.ts:791-813`）；消费端契约要求 `timestamp`、`machineString`、`machineString`。`at`/`kind` 正常；`decisionId` 的本地过滤比 `machineString` 宽，见问题 1。跨 owner 已有测试（`decision-ledger.test.ts:515-525`）。
- **`DecisionLedgerPort.lastRuleUses`**：SQLite 实现（`sqlite-decision-ledger-operations.ts:783-815`）、durable 适配（`durable-adapters.ts:1093`）、操作分发（`sqlite-decision-ledger-operations.ts:305-306`）三处都已接上；调用端 `#ruleLastUsed` 按 64 分批，端口也拒绝 >64 和长度不在 1-128 的 id，两端一致。缺口只在 `decisionId` 的字符集，以及导入数据（`decision_ledger.id` 只有长度约束）可以把不合 `machineString` 的 id 带进来。
- **网关契约新增必填字段**：控制台类型自动接受；但严格解析器会拒绝未知字段和缺失字段，因此新旧版本不能混跑。作者说本轮不改，这是已接受风险，但代码本身没有兼容层（见“推测”）。
