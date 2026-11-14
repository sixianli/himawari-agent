（说明：本轮已达到工具调用上限，以下结论都基于此前读到的代码；未运行任何检查命令，未读到的部分标为「未核实」。）

## 侧重检查

- **错误路径**：`reject` 对非法编号、无表行、已拒绝、已采纳、已过期分别处理（`production-owner-rules.ts:940-959`），`confirm` 对 rejected/expired 提前报错（`874-923`），control 层把 `OwnerRuleError` 映射成 `NOT_FOUND`/`INVALID_OPERATION`（`production-memory-control.ts:1272-1306`）。核对通过。
- **不可信输入**：`proposalId` 两端都用 `^rule-proposal:[0-9a-f]{32}$`（`production-owner-rules.ts:58`、`sqlite-owner-rule-proposal-operations.ts:14`）；`summary` 由 `validRuleSummary` 拒绝 `Cc/Cf/Zl/Zp/Surrogate`（`rule-types.ts:248-255`）；`quote`/`trials` 在列表出口经 `singleLine`（去 C0/DEL）与 Bidi 过滤（`production-memory-control.ts:543-560`）。没有发现可注入到规则编号/存储键的路径。
- **安全/显示欺骗**：列表 `summary` 不经过 `clip`，但 `validRuleSummary` 已拒绝 Bidi/Cf，实际不可利用；作者“列表文字去掉 Bidi_Control”是略宽的说法。
- **资源耗尽**：待采纳上限 20 生效；超限时先写载荷再删（`create` 的 `drop`）；拒绝/过期依据只在 `#sweep` 里按 `this.#limit()` 批量清（见问题 2）。未发现可无限增长“待采纳载荷”的路径；已采纳/已拒绝表行与已采纳载荷会长期保留。
- **不可撤销操作**：`reject` 会硬删依据载荷（`deletePayload` 是真 `DELETE`，`sqlite-durable-operations.ts:1828-1835`），`listProposals` 的 `#sweep` 也会在“读列表”时删过期/已拒绝依据。符合需求，但没有二次确认；这是设计选择。
- **规则/文档一致性**：`docs/architecture-v0.1.md:420` 的“读的一方不会遇到依据缺失的空档”“不会出现上限比列表长”与代码不完全一致（见问题 1、3）。单列主键 + 编号哈希含 owner/agent（`production-owner-rules.ts:780-789`）成立，与第 3 轮的说法一致。

## 按严重度排列的问题

### 【中】待采纳提议的依据引用会出现悬空：刷新分支不修复缺失载荷，且 `#sweep` 可能删掉刚被重新打开的行还在用的引用
- 位置：`apps/agent-service/src/production-owner-rules.ts:802-839`、`928-937`；`packages/persistence-sqlite/src/sqlite-owner-rule-proposal-operations.ts:112-129`
- 问题（读代码证实）：
  1. 确定性路径：`create` 对“仍待采纳但载荷已丢失”的行，`kept` 判为 `null`，于是写到新引用 `evidenceRef`；但 `propose` 的刷新分支是
     ```
     evidence_ref = coalesce(evidence_ref, ?)
     ```
     （`sqlite-owner-rule-proposal-operations.ts:115-116`）。旧 `evidence_ref` 非空（只是载荷没了）时，`coalesce` 仍保留旧值。随后 `create` 的收尾看到
     ```
     if (stored && stored.evidenceRef !== evidenceRef) await drop();
     ```
     （`production-owner-rules.ts:836-837`）把刚写的新载荷删掉。结果：行仍是待采纳、引用仍指向不存在的载荷，列表显示“没有记录”，`confirm` 走 `#readProposal(row.evidenceRef)` 失败抛 `RULE_NOT_FOUND`（`911-915`）。
  2. 并发路径：`create` 先读到待采纳且载荷存在 → `kept = 旧引用 R`，不写新载荷；随后同一提议被另一个请求 `reject` 或到期，`#sweep` 用
     ```
     const gone = await payloads.delete(evidenceRef)...
     if (gone) await store.clearEvidence(...)
     ```
     （`production-owner-rules.ts:931-936`）先删载荷再按状态清引用。而 `create` 的 `propose` 若此时看到行已非 pending，会走重开分支并用 `input.evidenceRef = R` 写回（`sqlite-...:141-158`）；R 已被删/将被删，行变成“待采纳 + 悬空引用”。同理，仅“到期被列表调用清理”也能触发。
- 影响：该提议失去原话/试算/回放依据，且无法采纳（只能拒绝）。不是提权，但属于不可逆的数据丢失与坏路径。
- 建议：
  - 刷新分支改成 `evidence_ref = ?`（调用方在“待采纳但载荷缺失”时传入新引用），或在 `create` 里对“pending 且载荷缺失”直接把旧引用当作要重写的目标、把载荷写回旧引用；
  - `#sweep` 改成“先 `clearEvidence`（它已带 `status IN ('rejected','expired') AND evidence_ref = ?` 条件），成功后再删载荷”，或删前重新按当前状态/引用校验。这样即使并发重开，也不会删掉仍在用的依据；
  - 或者更简单：每次 `propose` 都写新引用并在刷新/重开两个分支都用 `evidence_ref = ?`，成功后再删旧载荷。
- 未覆盖：没有测试覆盖“待采纳但载荷缺失后再提议”的修复，以及“拒绝/到期与再次提议并发”。

### 【低】清理依据的批量大小复用了“待采纳上限”，配置越小清得越慢
- 位置：`apps/agent-service/src/production-owner-rules.ts:928-930`；`sqlite-owner-rule-proposal-operations.ts:252-267`
- 问题（读代码证实）：`#sweep` 调 `settledEvidence({ limit: this.#limit() })`，而 `#limit()` 是待采纳上限。测试里存在 `proposalLimit: 1` 的用法；在这种配置下每次拒绝/读列表最多清 1 条过期/已拒绝依据，积压会长期保留加密原话。
- 推测（未实测）：已拒绝/过期行按需求永久保留，而 `settledEvidence` 的查询条件含 `status IN (...) AND evidence_ref IS NOT NULL` 并按 `decided_at` 排序；随着行数增长，每次读列表/拒绝都要扫这些索引项。当前索引 `(owner_id, agent_id, status, proposed_at, id)` 不含 `decided_at`，可能逐渐变慢。
- 建议：清理批量用一个独立常量（如 200）而不是待采纳上限；考虑加只覆盖 `evidence_ref IS NOT NULL` 的 partial index 或按 `decided_at` 的索引。

### 【低】上限 >200、过期天数 ≤0 时，列表响应与契约/文档可能不一致
- 位置：`apps/agent-service/src/production-owner-rules.ts:856-862`；`sqlite-owner-rule-proposal-operations.ts:101-106`、`197`、`256`；`docs/architecture-v0.1.md:420`
- 问题（读代码证实）：`#limit()` 不再截断到 200；`listPending` 把 limit 夹到 200，但 `listProposals` 返回的是未夹断的 `this.#limit()`。所以 `{proposalLimit: 201}` 时：写提议被存储层拒绝（`101-106`），但读列表仍会回 `limit: 201`，UI 显示“上限 201”而列表最多 200，正是文档说“不会出现”的情况。同理 `proposalTtlDays <= 0` 会让 `expiresAfterDays` 为 0/负，而契约是 `integer(1)`（`contracts-v2.ts` 的 `memoryRuleProposalsSnapshotSchema`），整个读列表会被校验拒绝。
- 可达性：生产构造 `ProductionOwnerRuleWriter` 的两处都没有传 `proposalLimit`/`proposalTtlDays`（`production-http-composition.ts:1108`、`service-main.ts:1490`），目前只有测试/选项能触发，属「未核实是否会在生产出现」。
- 建议：`#limit()` 至少在返回给界面处显式夹到存储上限，或在构造/配置处校验 `1 <= limit <= 200`、`ttlDays >= 1`；文档措辞与实现对齐。

### 【低】已采纳提议的依据载荷从不清理
- 位置：`apps/agent-service/src/production-owner-rules.ts:925-938`（只选 `rejected`/`expired`）、`964-970`（列表时把待采纳标成已采纳）
- 问题（读代码证实）：`#sweep` 只清已拒绝/已过期；`#settle` 自动采纳的提议、以及主人确认的提议，其加密依据（原话、参数、试算、回放）会无限期保留。表行保留可解释（支持撤销后重新采纳），载荷是否必须保留值得再确认。
- 建议：若“已采纳再采纳”只依赖表行与规则参数，可在规则被撤销或一定时间后清已采纳载荷；若确需保留，在文档里写清。

### 【低/推测】列表读时的 `#settle` 按“所有非 retired 规则”匹配，未再确认规则可执行
- 位置：`apps/agent-service/src/production-owner-rules.ts:964-970`；`packages/application/src/rules/rule-book.ts:14-15`
- 说明：`needs_review` 按 `ruleIsEnforced` 算生效，所以主要场景没问题；但若存在参数坏掉/类型不可执行的旧规则（`enforceableOwnerRule` 返回 `undefined`），`#settle` 仍会因参数相同把待采纳提议标成已采纳、从界面消失。读代码只能确认“未检查 enforceable”，实际是否有这种存量行未核实。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会（读代码证实）。本次改动没有动提示词/工具定义：全量 diff 里 `packages/prompt-catalog`、提示相关文件无改动（只 `service-main.ts` 多传一个 `proposals` 依赖）；`ownerRuleToolDescriptors` 原样（`production-owner-rules.ts:159-219`）。新增/变化的值（`trials`、`replay`、`generatedAt`、提议列表）都只在 `rule_set` 工具结果或 `memory.ruleProposals.read` 查询响应里，属于末尾追加或界面读取，不进入系统提示/工具定义/历史/遮盖。`#settle`/`#sweep` 也不改写提示或历史。因此“只在末尾追加、每轮会变的值在最后一条消息”的约束仍然成立。是否实际跑过 `check:prompt-prefix`：未核实。

**2. 同一段文字会不会在不同请求里变成不同字节？**
对模型可见内容：不会（读代码证实）。`proposalId` 用 `canonicalJson` 固定键顺序（`production-owner-rules.ts:408-419`、`780-789`），列表顺序固定按 `proposed_at, id`（`sqlite-...:200-205`），回放数字读取存储值不重算（`977-994`）。需要区分的是内部值：依据载荷用 `JSON.stringify({...proposal, trials, replay})`，`params` 保留调用方键序，`evidenceRef` 还带 `randomUUID()`（`791`、`809`），所以同一内容两次请求可能写出不同的内部载荷字节/引用。它们不进模型请求、也不在网关契约里（`memoryRuleProposalsSnapshotSchema` 没有 `evidenceRef`），不影响 KV 前缀。UI 快照里的 `generatedAt` 是每轮时间，也只在查询响应里。遮盖逻辑未改，确定性依赖输入本身，没有新增“依赖后文”的遮盖。

**3. 有没有对应自动检查，反向用例真的会失败？**
大部分有（读代码证实）：新增的大集成用例覆盖了 Bidi 过滤（去掉 `\u202e` 才通过）、坏依据字段（`trials:"not-a-list"`/`replay:{days:"many"}` 被降级为空）、拒绝/过期后依据被删与 `payloadCount` 断言、`proposalLimit: 201` 被存储层拒绝、整理失败不影响采纳等；去掉对应实现这些断言会失败，属于真实反向用例。缺口：没有覆盖“待采纳但载荷缺失后再提议”的修复，也没有覆盖“拒绝/到期与再次提议并发”导致的悬空引用；也没有对“列表返回的 `limit` 与存储夹断值一致”的用例。提示词未变，所以不需要新增 prompt-prefix 用例（实际门槛未运行）。

**4. 每个新产生/修改的值，使用它的地方都能接受吗？**
逐项核对（读代码证实）：
- `evidenceRef = rule-proposal:<32 hex>:<16 hex>`（63 字符）：`owner_rule_proposals.evidence_ref` CHECK 允许 1–256（`0095_owner_rule_proposals.sql:9`）；`payloads.ref` 无长度 CHECK；HTTP 读 payload 的引用正则允许 `:` 且 ≤128（`http-gateway-server.ts:1329-1331`）；使用方只有 `#writeText`/`#readProposal`/`payloads.delete`/`settledEvidence`/`clearEvidence`，均按字符串相等匹配，能接受。没有网关契约字段暴露它。
- `proposalId`（46 字符）：`PROPOSAL_ID_PATTERN`（`production-owner-rules.ts:58`、`sqlite-...:14`）与 `machineString`（≤128）都接受。
- `limit`/`expiresAfterDays`：契约是 `integer(1)`（无上限），所以 201 能通过；但会出现问题 3 的“上限 201/列表夹到 200”和 `ttlDays<=0` 时整个读列表校验失败。生产未接这两个选项（未核实实际可达）。
- `origin`：`owner_said`/`inferred` 与契约枚举、i18n 分支一致。
- `summary`：写入前经 `validRuleSummary`（≤200、拒绝 Cf/Cc 等），列表出口再 `slice(0,200)`，能过 `boundedString(200)`。
- `quote`/`trials.from`/`trials.subject`：出口先 `singleLine`（C0/DEL→空格）再按 500/200 截断，能过 `boundedString`；没有与 I-73 类似“产生端接受、消费端校验拒绝”的新发现。唯一小瑕疵是 `clip` 用 `.slice` 可能把代理对截成半个代理，但 JSON 序列化可处理，不导致校验失败。

## 未核实项
- 未运行 typecheck/lint/integration/prompt-prefix 等任何命令；作者列出的“已通过”清单我无法独立确认。
- 生产是否可能配置 `proposalLimit`/`proposalTtlDays`（当前构造点未传，标注为不可达但没有查全部配置入口）。
- `#settle` 匹配不可执行规则的实际存量风险。
- 并发是否被上层按 agent 串行化（若是，问题 1 的并发路径会降级；代码层面未找到串行保证）。
