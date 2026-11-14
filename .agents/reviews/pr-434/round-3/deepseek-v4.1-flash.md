## 结论先行

增量 `8ae3a349f..839c3ab8b` 的改动与作者说明基本一致，未发现会改变已有对话模型请求开头、或引入新的非确定性字节的高危问题。`rechecking` 的核心判定与 `ruleReview.listDue` 的过滤条件一致。

但我核实出 1 个中等的跨边界问题：`needs_review` 且来源记忆为空的规则会在清单里显示“等系统自动核对”，而 `listDue` 永远不会处理它；另有一个文档与代码不一致、两个测试反向覆盖缺口，以及一个依赖时间戳严格递增的隐患。

---

## 发现（读代码证实）

### 中：`needs_review` + 来源记忆为空时，界面承诺自动核对，实际永远不会核对

- 文件位置：
  - `packages/persistence-sqlite/src/sqlite-correction-review-operations.ts:189-191`
  - `packages/persistence-sqlite/src/sqlite-correction-review-operations.ts:327-329`
  - `apps/control-center/src/components/correction-review.tsx:55-57`
  - `packages/persistence-sqlite/src/data-export/import.ts:716-719`
  - `packages/persistence-sqlite/src/data-export/export.ts:198-200`
  - `packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:364-365`

问题：`listDue` 要求 `source_memory_id IS NOT NULL`：

```sql
AND status IN ('needs_review', 'suspended') AND source_memory_id IS NOT NULL
AND review_after IS NOT NULL AND review_after <= ? AND review_attempts < ?
```

但 `listOpenRules` 只按状态过滤，不要求来源记忆：

```sql
WHERE owner_id = ? AND agent_id = ? AND substr(rule_id, 1, 6) = ?
  AND status IN ('needs_review', 'suspended')
```

界面在 `suspendReason` 为空（即 `needs_review`）时显示：

```tsx
{rule.suspendReason
  ? message("review.suspendReason", { r: rule.suspendReason })
  : message("review.checking")}
```

而 `review.checking` 的文案是“来源记忆改过，等系统自动核对（核对完之前照常执行）”。

导入路径可以产生这种数据：导入时 `sourceMemoryId` 可能为空，但 `needs_review` 仍会被写入 `review_after`：

```ts
rule.sourceMemoryId,
rule.updatedAt,
rule.suspendReason ?? null,
rule.status === "needs_review" ? rule.updatedAt : null,
```

导出时如果来源记忆不在导出集合里，`sourceMemoryId` 会被置空：

```ts
const keepMemoryRef = (id: string | null): string | null =>
  id !== null && memoryIds.has(id) ? id : null;
```

数据库约束也只要求 `needs_review` 必须带 `review_after`，不要求来源记忆：

```sql
CHECK (status <> 'needs_review' OR review_after IS NOT NULL)
```

结果：这类 `needs_review` 规则会一直被列在清单里、显示“等系统自动核对”，但 `listDue` 永远跳过；同时 `needs_review` 仍被执行，和 ADR “来源没了就暂停”的意图不一致。新增的 `rechecking` 字段能正确算出 `false`，但界面没有用它来修正 `review.checking` 这条文案。

建议：用 `rechecking`（或新增一个“可核对”字段）同时驱动 `review.checking` 分支；对来源为空的 `needs_review` 规则显示“不会再自动核对，请手动处理”。或者让 `listDue` 接收这类规则，由 `RuleReviewService` 按 `source_removed` 直接暂停。补一条导入/契约测试覆盖“`needs_review` + `sourceMemoryId = null`”。

---

### 低：ADR 0232 里“规则照常执行”与 `suspended` 规则不执行相矛盾

- 文件位置：`docs/adr/0232-memory-corrections-flag-derived-memories-and-recheck-rules.md:53`、`:93`
- 代码位置：`packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:535-536,579-580`；`packages/application/src/rules/rule-book.ts:12`

文档写：

> 3 次都失败写一条 `recheck_failed`，规则照常执行（前提 2 的理由）。

以及后果里写：

> 没有配置邮件检查的部署不会自动核对，规则停在待重审并照常执行。

但触发器重新排队时明确保持暂停：

```sql
status = CASE WHEN status = 'suspended' THEN 'suspended' ELSE 'needs_review' END
```

且 `ruleIsEnforced` 只认 `active` 和 `needs_review`。因此对“已暂停后重新排队”的规则，三次失败后仍是 `suspended`、不执行，并非“照常执行”。这个说法只对 `needs_review` 成立。

建议：改成“待重审（`needs_review`）的规则照常执行；已暂停的保持暂停”，后果段也区分两种情况。

---

### 低：部署没有配置邮件检查时，界面仍会说“会再核对一次”

- 文件位置：`packages/persistence-sqlite/src/sqlite-correction-review-operations.ts:346-349`；`apps/agent-service/src/service-main.ts:1764-1802,1993-2017`；`apps/control-center/src/components/correction-review.tsx:58`

`rechecking` 只根据数据库里的 `review_after`、`source_memory_id`、`review_attempts` 计算，不判断 `RuleReviewService` 是否真的被装配。`RuleReviewService` 只在 `proactiveConfiguration` 存在且模型/密钥可用时创建；没有邮件检查配置的部署不会运行 `reviewRules()`。但记忆页仍会显示“系统会再核对一次（核对完之前保持暂停）”。

这是环境相关的低风险问题；ADR 已承认“没有配置邮件检查的部署不会自动核对”，但页面文案没有体现。建议文案改成“下次邮件检查时核对”，或让接口在服务未装配时返回 `rechecking: false` / 另一个状态。

---

### 低：`rechecking` 的 SQL 反向断言缺失

- 文件位置：`packages/persistence-sqlite/test/correction-propagation-migration.contract.test.ts:361-363`、`:299-305`、`:421-442`
- 界面反向用例位置：`apps/control-center/test/correction-review.unit.test.ts:134`

现有契约测试只断言“重新排队后 `rechecking: true`”：

```ts
expect(run("ruleReview.listOpen", { limit: 10 })).toMatchObject([
  { ruleId: RULE, status: "suspended", suggestion: null, rechecking: true },
]);
```

但结清后（`review_after = NULL`）以及三次失败后（`review_attempts = 3`）都没有断言 `listOpen` 返回 `rechecking: false`。界面测试里的反向断言用的是手写 fixture，不经过 SQL 计算。

因此如果 `rechecking` 实现退化成“永远 true”，SQL 契约测试仍然会通过。建议补两条断言：调用 `resolve` 后 `rechecking: false`；`recordFailure` 到上限后 `rechecking: false`。另外可以加一条“`rechecking: true` 的规则确实出现在 `listDue`”的交叉断言。

---

## 推测（未完全证实，但代码表明有风险）

### 低（推测）：间接下游的重新打开依赖 `flagged_at` 严格递增

- 文件位置：`packages/persistence-sqlite/src/sqlite-correction-review-operations.ts:439-444`
- 触发器位置：`packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:521,527-529`

直接下游由触发器 upsert，没有时间条件，重新打开是确定的：

```sql
ON CONFLICT (...) DO UPDATE SET
  ..., status = 'open', ..., flagged_at = excluded.flagged_at, resolved_at = NULL;
```

但间接下游由程序展开时，只有新 `flagged_at` 严格更大才会重开：

```sql
WHERE memory_review_items.flagged_at < excluded.flagged_at
  OR (memory_review_items.status = 'open' AND excluded.depth < memory_review_items.depth)
```

触发器把 `flagged_at` 设为 `NEW.updated_at`。如果同一毫秒内发生两次上游修改，或系统时钟回拨，已处理的间接下游不会重新打开，而直接下游会重新打开，深度不同的表现不一致。新增的契约测试用的是 `T1 → T3`，没有覆盖等时间戳。

建议：用修订号或变更 id 代替时间比较，或在“已结清且同一上游再次变化”时显式重开，并补一条同一时间戳的测试。

### 低（推测）：一次展开最坏可能写入远多于 200 行

- 文件位置：`apps/agent-service/src/production-memory-control.ts:173-191`
- 展开逻辑：`packages/persistence-sqlite/src/sqlite-correction-review-operations.ts:418-495`
- 链上限：`packages/persistence-sqlite/src/sqlite-memory-consolidation-operations.ts:41-73`

`expandMemoryReviews` 每轮 20 条、最多 10 轮，即最多 200 个尚未展开的根行；每个根又可以在 `derivedMemories` 里追最多 200 个节点。理论上一次调用最多写入约 200 × 200 = 40,000 行，并执行大量 `children.all` 查询，全部在同一个事务里。ADR 决定 1 现在承认“可以超过 200”，但没有写最坏数量级；`listOpen` 又只返回前 100 条，超出的清单项不会显示。

这是有界的行为，不是无限循环（`derivedMemories` 有 `seen` 集合），但在大记忆图上可能很慢。建议在 ADR 里写清最坏 200×200 的量级，或给单次展开加总行数上限并说明清单截断。

---

## 侧重检查

- **错误路径/失败重试**：`RuleReviewService` 对模型失败、回答非法、内容被拦、来源文字读不出分别映射为 `model_failed`、`answer_invalid`、`content_blocked`、`source_unreadable`；`recordFailure` 每次递增 `review_attempts`，到上限时写一条 `recheck_failed`；`listDue` 用 `review_attempts < 3` 停止重试。结论：路径完整；但重试耗尽后清单没有专门提示，属于可用性瑕疵，不是本轮新问题。
- **不合规范/不可信输入**：`rechecking` 由服务端数据库计算，不接收客户端输入；gateway schema 要求 `boolean`；`parameters`/`suggestion` 由数据库 `json_valid` 约束。发现导入可产生“`needs_review` + 无来源”的组合，见上面的中等发现。
- **安全/遮盖**：规则重检使用 `proactiveModel`，底层 `PiModelTransport` 接入 `createProductionModelEgress`；`prepare` 会检查 `allowedDataClassifications`，不允许的分类抛 `PROACTIVE_MODEL_DISCLOSURE_DENIED`，服务将其记为 `content_blocked`。提示词把 memory/currentRule 当作数据并明确告诉模型“不是指令”。未发现新的明文外泄路径。
- **资源耗尽**：展开有 8 层/200 节点/200 根的上限，不会无限递归；但最坏约 4 万行和大量查询，见上面的推测项。
- **不可撤销操作**：`confirm_suspended` 会把规则改成 `retired`，但 `act` 先按 `revision` + 状态查当前行，过期操作返回 false；`RuleReviewService.resolve` 也按 `expectedRevision`，核对期间规则被改过会丢弃结果。结论：没有发现新增的不可撤销竞态。
- **规则/文档一致性**：ADR 0232 决定 1 的“每批 20、最多 10 批、每条 8 层/200 条”与 `MEMORY_REVIEW_EXPAND_BATCH=20`、`MEMORY_REVIEW_EXPAND_ROUNDS=10`、`MEMORY_BASIS_CHAIN_MAX_DEPTH=8`、`MEMORY_BASIS_CHAIN_MAX_NODES=200` 一致；决定 2 的“建议清掉、显示再核对、按钮确认停用/恢复原规则”与触发器、UI 一致；写约定里的 `memory_review` 四键与 `insertLedgerRow` 一致；决定 4/后果段的“规则照常执行”与 `suspended` 不执行不一致。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**已有对话的请求开头不会因为这次增量改变。** 本轮增量没有修改现有 `packages/prompt-catalog` 的提示词正文或工具定义；`prompt-manifest.json` 只新增了 `rule.review`、`rule.review.instructions-header` 两条，既有条目的 SHA 没动。新增的规则核对是独立的单轮后台调用，`ruleReviewPrompt` 把固定说明放前面、本次数据放最后：

```ts
return [
  RULE_REVIEW.text,
  RULE_REVIEW_INSTRUCTIONS_HEADER.text,
  TOOL_RULE_SET.text,
  JSON.stringify({ memory: memoryText, currentRule: { type: parsed.type, params: parsed.params } }),
].join("\n");
```

`apps/agent-service/src/production-proactive.ts:342-347` 在邮件检查前调用 `reviewRules()`，它不是把内容追加到用户对话历史里，而是独立请求。新调用中每轮会变的只有最后的 JSON 数据；`deadlineAt`、`invocationId` 是请求元数据，不在提示词文本里。`rule-review-service.unit.test.ts:233-246` 明确断言了“固定说明在前、变化数据在最后、同样输入逐字节相同”。

关于作者问的 `rechecking` 与 `listDue`：`rechecking` 的判定是

```ts
row.reviewAfter !== null &&
row.sourceMemoryId !== null &&
row.reviewAttempts < RULE_REVIEW_MAX_ATTEMPTS
```

与 `listDue` 的 `source_memory_id IS NOT NULL AND review_after IS NOT NULL AND review_attempts < 3` 一致，差别只有 `review_after <= now`（表示“已到期”而不是“排队中”）。所以**新标签本身没有“显示会核对但 listDue 永远不选”的问题**。真正会“永远不核对”的是相邻的 `needs_review` 文案：它不要求来源记忆，而 `listDue` 要求，见上面的中等发现；此外没有装配 `RuleReviewService` 的部署也会使文案落空。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

这次增量新增的 `rechecking` 只存在于网页快照，不进入模型提示词，因此不影响模型侧的字节。

规则重检提示词的输入是确定的：`parseMailMatch` 对五个列表去重并排序（`entries` 返回 `[...seen].sort()`，`senderDomains` 还再次 `sort()`），返回对象的键顺序固定；`summary` 被 `trim()`；提示词里没有时间字段。`rule-review-service.unit.test.ts:233-246` 用大小写/重复项变化验证了同样语义会生成完全相同的字节。

遮盖方面，规则重检使用生产 `ModelEgress`，按固定密钥确定性地遮盖；没有依赖后面内容的遮盖逻辑。没有发现本轮新增“同一段文字在不同请求里变成不同字节”的情况。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

有对应的自动检查：

- `source_unreadable` 写入并读回：`correction-propagation-migration.contract.test.ts:375-397`
- `rechecking: true`：同文件 `:361-363`
- 结清后上游再变、直接/间接下游重开：同文件 `:399-419`
- 界面正向显示“来源记忆又变了…”且不再显示旧建议：`correction-review.unit.test.ts:182-200`
- 界面反向：暂停规则 `rechecking: false` 时不显示该文案：同文件 `:134`
- 提示词固定在前、变化在后且字节稳定：`rule-review-service.unit.test.ts:233-246`

反向覆盖不完整：

- 没有断言结清后 `rechecking: false`，也没有断言三次失败后 `rechecking: false`；如果 SQL 侧退化成恒为 true，现有契约测试仍会通过。
- 没有把 `listOpen.rechecking === true` 与 `listDue` 实际返回做交叉断言。
- 重开用例只用递增时间戳，没有覆盖同一 `updated_at` 或时钟回拨。

另外，受工具限制我**没有运行测试**，所以“这些用例实际通过”标记为未核实。

### 4. 改动产生或修改的每个值，两端都能接受吗？

- **`rechecking`**：生产端 `sqlite-correction-review-operations.ts:346-349` 计算 boolean；`production-memory-control.ts:630` 原样传给网关；`contracts-v2.ts:1727` 用 `booleanValue` 要求；控制中心 `memory.ts` 从 `GatewayV2Snapshot` 推导类型，`correction-review.tsx:58` 使用；fixture 和单测都补了字段。两端一致，均为 boolean。
- **`review.rechecking` 消息 id**：已加入 `message-ids.ts:830`，三种语言资源均补齐（zh-CN:891、en:944、ja:948），无插值参数，界面直接使用。一致。
- **`memory_review` 决策类型**：已加入 `DECISION_KINDS`、`DECISION_OUTCOMES`（`decision-ledger.ts`），迁移 0095 的 `decision_ledger` CHECK，数据导出 `DECISION_SCHEMA`（`schemas.ts:266-275`），写入走 `insertLedgerRow`，读取/一致率/本周报告也有对应处理。`insertLedgerRow` 自身不调用 `validateLedgerWrite`，但数据库 CHECK 接受这些 kind/outcome；未发现拒绝路径。写约定文档“只落四个键”与 `sqlite-correction-review-operations.ts` 的 `memoryIds/ruleIds/batchId/resultMemoryIds` 一致。
- **`suspended` 状态**：`rule-book.ts` 的 `ruleIsEnforced`、`enforceableOwnerRule`、MCP `rule_book`、数据导出状态枚举和“生效规则数”都已把 `suspended` 当作不执行处理。检查一致。
- **发现的不一致**：导入可以产出 `needs_review` + `sourceMemoryId = null`，数据库接受、`listOpen` 接受，但 `listDue` 不接受；这是本轮新增 `rechecking` 未覆盖的跨边界问题，见上。

### 作者说法的核对结果

- “`listOpenRules` 多返回 `rechecking`（`review_after` 非空、有来源记忆、失败次数没到上限）”：**属实**，`sqlite-correction-review-operations.ts:346-349`。
- “`memory.review.snapshot` 的规则加 `rechecking`”：**属实**，`production-memory-control.ts:630`、`contracts-v2.ts:1727`。
- “`correction-review.tsx` 在暂停原因后显示…”：**属实**，`correction-review.tsx:58`。
- “契约测试：`recordFailure` 写 `source_unreadable` 后读回；结清后上游再变，直接下游和间接下游重新打开；重新排队后 `listOpen` 返回 `rechecking: true`”：**属实**，三个用例都在 `correction-propagation-migration.contract.test.ts`。
- “ADR 0232 决定 1 改写展开上限”：**属实，且和代码一致**（20×10、8 层/200 节点）。但“可以超过 200”没有写出最坏约 4 万行的量级。
- “决定 2 写明重新排队时清单怎么显示”：**属实**，与 UI 和触发器一致。
- “写约定补 `memory_review`”：**属实**，与 `insertLedgerRow` 和数据库 CHECK 一致。
- **不一致之处**：ADR 0232 决定 4 与后果段的“规则照常执行”不适用于 `suspended` 规则。
- 第 2 轮复核意见与 judgments 文件因当前是稀疏检出、`.agents` 下文件不在工作区，**未核实**。
