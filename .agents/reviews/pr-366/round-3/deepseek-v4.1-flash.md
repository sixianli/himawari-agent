## 总体结论

以 `aa1b0b0..7952130` 的 PR 366 净改动为准，没有发现高、中严重度问题。合并 `main` 时 `rule-judge.ts` 的两侧行为都保住了：状态判断和金额判断同时存在（`packages/application/src/rules/rule-judge.ts:32-33`）。抽屉在非 `rule_review` 记录上的输出没有变化，新文案键三语齐全。另发现几条低严重度的测试覆盖和文案一致性问题，均不影响当前行为。

## 发现（按严重度从高到低）

### 1. 低：永久删除触发器写入的数据库当前时间没有自动检查格式

- 文件：`packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql:380,389,399`；`packages/persistence-sqlite/test/rule-memory-review.contract.test.ts:397-405`
- 问题：新增的永久删除路径用 `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` 生成 `changed_at`、`checked_at`、`updated_at`。新合同测试只断言 reason、revision 和历史条数，没有断言这三个时间字符串符合 `????-??-??T??:??:??.???Z`。如果以后有人改错格式（例如用 `%S.%f` 或 `%f` 单独拼接），要等到周报调用 `assertTimestampFormat` 才会暴露，本 PR 的测试接不住。
- 证据：
  - SQL：`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`（0087 第 380、389、399 行）。
  - 测试只查：`SELECT reason_code FROM decision_ledger WHERE kind = 'rule_review'`，并断言 `["memory_removed"]`；没有读 `checked_at`。
  - `packages/calibration/src/index.ts:631` 的 `badDecisionTimes` 要求 `GLOB '????-??-??T??:??:??.???Z'`，但该测试不跑校准。
- 建议：在永久删除用例里直接断言 `checked_at` 匹配 `????-??-??T??:??:??.???Z`，或在删除后调用 `assertTimestampFormat(database)`；更稳的是再加一条经 `sqlite-governed-deletion.ts` 真正永久删除、再读周报/校准备份的集成用例。

### 2. 低：`rule_review` 的导出/导入没有往返用例

- 文件：`packages/persistence-sqlite/src/data-export/schemas.ts:190-198`；`test/integration/data-export-fixture.ts:280-287`
- 问题：导出模式加上了 `rule_review`，但导出夹具的 `kinds` 数组只到 `external_read`，没有 `rule_review` 行。因此新类型能否完整导出、再导入、通过校验，没有端到端证据；若导入端对结果值有隐含假设，不会被发现。
- 证据：夹具 `kinds` 最后一项是 `["d-read", "external_read", null, null, "read", "owner_asked"]`；没有 `rule_review`/`needs_review`。
- 建议：加一条 `["d-rule-review", "rule_review", null, null, "needs_review", "memory_edited"]` 的导出并断言导入后逐字段一致。

### 3. 低（推测，前置条件未发生）：非 floor 规则的 `rule_review` 在抽屉里显示为“未登记的规则”

- 文件：`apps/agent-service/src/production-decision-chain.ts:107-112`；`packages/application/src/services/proactive-rules.ts:34-53`
- 问题：`rule_review` 现在会列出规则，但 `DECISION_RULE_CATALOG` 只登记了三条 `floor_*` 规则。`quiet_hours` 也是规则手册里的规则，若第 4 步把它和规则记忆连起来，抽屉会得到 `origin: null`、`document: null`，中文界面显示“未登记的规则”，规则描述也只显示原始 id。
- 证据：`decisionRuleDefinition` 对不在 `DECISION_RULE_CATALOG` 的 id 返回 `undefined`；`decision-chain-drawer.tsx:170` 用 `rule.origin ?? "unknown"` 调 `decision.chain.origin`，该文案的 `other` 分支是“未登记的规则”。
- 说明：现在 `source_memory_id` 全为空（ADR 0211 决定 1），所以当前不会出现，属于第 4 步的风险。
- 建议：从规则注册表（而不是 floor-only 目录）派生 origin/document，或至少给 `quiet_hours` 补一条目录项。

### 4. 低：删除触发器“去掉 status 过滤会失败”的表述不够精确

- 文件：`packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql:363-371,381-383,395-397,398-401`；测试 `packages/persistence-sqlite/test/rule-memory-review.contract.test.ts:388-407`
- 问题：删除触发器的 `WHEN` 外层有一个 `EXISTS (... status='active')`，触发器体里的三条语句又各自带 `AND status = 'active'`。如果只删掉外层 `WHEN` 里的状态条件而保留三条语句里的条件，规则已是 `needs_review` 时触发器体的 SELECT/INSERT/UPDATE 仍然什么都不做，新用例不会失败。真正让反向用例失败的是三条语句里的状态条件。
- 证据：外层 `WHEN` 第 367-371 行；触发器体第 383、397、401 行的 `AND status = 'active'`。
- 建议：把提交说明或测试注释明确成“去掉触发器体内的三处 `status = 'active'` 会失败”；或者删掉外层冗余的 status 条件并保留体内条件，让“唯一的过滤点”更清楚。

## 侧重检查

- **不可撤销操作/迁移**：`0087` 先 `CREATE TABLE ..._keep AS SELECT *`，再按“先删六张子表、再删父表，重建后灌回”的顺序执行（`0087:1-15,84-237,239-260`）。核对了 `decision_ledger` 的全部入向引用，确实是六张子表（`source_insights`、`proactive_processed_messages`、`decision_ledger_payloads`、`decision_signals`、`proactive_push_backoff`、`muse_reference_entries`），没有第七张。新表定义与 0069/0070/0073/0076/0080/0081 的最终 schema 对照，列、默认值和 `ON DELETE` 动作一致；合同测试也知道比较重建前后这些表的全部数据和索引/触发器名字。未执行测试，结论来自读代码。
- **错误路径/级联删除**：删除触发器只在 owner 和 agent 仍存在时动作（`0087:363-371`），删除 owner/agent 的级联路径不会留下 rule/ledger 行；对应测试在 `rule-memory-review.contract.test.ts:409-454`。级联时即使触发器先插入，随后也由外键级联删除。
- **不可信输入/序列化**：新 `rule_review` 的 `subject_ref` 来自 `rule_id`（≤64），触发器生成的 id 为 `rule-review:` + 24 位十六进制（36 字符），都落在 `decision_ledger` 的 1..128 和 gateway 的 `machineString` 范围内；`inputs` 只写 `memoryIds`、`ruleIds`、`batchId`、`resultMemoryIds`，读端 `entryFromRow` 对缺省字段有兜底。随机 id 和数据库当前时间只进决策记录，不进模型提示。
- **资源耗尽**：规则类的编辑/删除在规则第一次进入 `needs_review` 后不会重复写行（更新触发器要求 `status='active'`，删除触发器体内也要求 `status='active'`）；owner 重新保存设置把规则恢复 `active` 后才会再次触发。删除 owner/agent 时的触发器写入会随后被级联删除，不留下持续增长的数据。
- **规则/文档与代码一致**：ADR 0211 第 57 行写的“删除触发器用数据库当前时间”“已是 `needs_review` 不重复触发”“抽屉列在‘待重审的规则’下、不显示命中邮件数”与代码一致。ADR 第 90 行说的两处“哪些状态要执行”（`ruleIsEnforced` 和 `status IN ('active','needs_review')`）分别在 `rule-book.ts:9-11` 与 `sqlite-proactive-operations.ts:230-233`，一致。`docs/execution/specs/2026-11-09-decision-record-write-convention.md` 对 `rule_review` 的 inputs 描述也与触发器实际写入一致。

## 读代码证实的与推测的

**读代码证实的**

- `production-decision-chain.ts:96-97` 对 `rule_review` 打开 rules 区；`118-126` 对非 proactive 返回 `mails: null`。
- `decision-chain-drawer.tsx:137-139` 只在 `kind === "rule_review"` 时换标题；`176-182` 只在 `chain.mails` 非空时显示“命中 N 封邮件”。服务端只有 proactive 的 `mails` 非空，而 rules 只可能出现在 proactive 或 rule_review，所以非 rule_review 的显示未变。
- `calibration-group-copy.test.ts:26-35` 用 `DECISION_KINDS` 循环检查 `decision.chain.kind` 和 `weekly.check.rowsMissing`；三语文案都含 `rule_review {…}`。
- `message-ids.ts:921` 注册了 `decision.chain.reviewRules`，en/ja/zh 三份资源都有该键；`i18n-runtime.unit.test.ts:63-67` 会要求三语键集合与 `MESSAGE_IDS` 完全一致。
- 合并结果 `rule-judge.ts:32-33` 同时保留 `!ruleIsEnforced(rule.status)` 和 `usesAmountFields(rule) && facts["amount_state"] !== "known"`，没有丢任何一方。
- `sqlite-proactive-operations.ts:230-233` 读设置时接受 `needs_review`；`352-362` 的历史写入改为从当前规则行复制 `status`/`source_memory_id`，保留来源链接。

**推测/未核实**

- 第 3 条关于 `quiet_hours` 的显示问题，要等第 4 步真正写入 `source_memory_id` 才会出现；当前没有行触发。
- 我没有运行任何测试或变异验证；关于“反向用例会失败”的判断来自读测试逻辑，未实际执行。
- SQLite 在删除触发器的三条子语句里对 `'now'` 是否逐字节相同，未用测试核实；即便相差毫秒，也只影响历史时间与规则时间的严格相等，不影响功能。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**

不会。`aa1b0b0..HEAD` 的 PR 366 净改动没有 `packages/prompt-catalog`、`packages/runtime-pi` 或提示组装文件，只有规则手册、决策记录、抽屉、i18n 和迁移。没有新增模型输入字段、没有改系统提示/工具定义/历史/遮盖。所需规则仍然只在代码里执行，不进入提示。依据：`.claude/rules/prompt-prefix.md:27-35` 要求固定在前、会变的只在最后一条用户消息；本 PR 没有新增发送给模型的内容，因此也不存在把每轮变化值放进前部的问题。

需要说明一个基准差异：`b562209..HEAD` 里包含合并进来的 PR 365，它确实在 `packages/prompt-catalog/src/mail.ts:32` 追加了一行金额说明。但这一改动已经在对比基准 `aa1b0b0` 的主线上，不属于 PR 366 的净改动；而且它是固定提示文字，对所有请求字节一致，不是带时间或依赖前后文的值。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**

不会。本 PR 新增的随机/时间值只有两处：触发器生成的 `rule-review:` 随机 id 和数据库 `strftime('now')`；它们只写进 `decision_ledger`/`rule_book_history`，不进入模型请求。新状态的判定和 UI 文案也不影响模型输入。PR 365 那行固定提示是常量，每次请求相同。没有发现依赖对象遍历顺序、数据库返回顺序或前后文遮盖的新列表/JSON。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**

大部分有：

- 删除路径不重复标记：`rule-memory-review.contract.test.ts:388-407`；把触发器体内三处 `AND status='active'` 去掉后，会多写一条 revision 3 历史和一条 ledger，`toHaveLength(2)`/`["memory_removed"]` 会失败。注意只去掉外层 `WHEN` 的 status 条件不会失败（见发现 4）。
- 服务端列出 `rule_review` 规则：`test/integration/decision-chain.test.ts:599-632`；去掉 `production-decision-chain.ts:97` 的 `|| entry.kind === "rule_review"` 后，`chain.rules.state` 会变成 `not_applicable`、`items` 为空，用例失败。
- 抽屉标题与不显示邮件数：`apps/control-center/test/proactive-interactions.unit.test.ts:1090-1108`；恢复旧标题或去掉 `chain.mails` 判断后，`toContain("待重审的规则")`/`not.toContain("封邮件")` 会失败。
- 三语文案：`test/integration/calibration-group-copy.test.ts:26-35`；删掉任一语言的 `rule_review {` 分支会失败。
- 合并行为：`rule-registry.unit.test.ts` 和 `owner-profile-service.unit.test.ts` 中两条 P2-2 用例都补了金额事实字段，`rule-judge.ts` 两个条件同时存在。

没有自动检查的两处：永久删除触发器的 `checked_at` 格式（发现 1）和 `rule_review` 的导出/导入往返（发现 2）。另外我没有实际运行测试或变异验证。

**4. 产生/修改的每个值，使用它的地方都能接受吗？**

逐个核对如下：

- `rule_review` 类型：产生于 0087 触发器（`0087:339,388`）和 `DecisionLedgerPort.append`（`validateLedgerWrite` 允许）。使用方：`decision_ledger` 检查约束（`0087:21-26,64-72`）、`DECISION_KINDS`/`DECISION_OUTCOMES`（`decision-ledger.ts:29-50`）、`list` 的 kind 校验（`sqlite-decision-ledger-operations.ts:305`）、导出模式（`data-export/schemas.ts:190-198`）、gateway 契约（`contracts-v2.ts:530-539,763-767,1018-1023`）、校准（`calibration/src/index.ts:15-26,37-48,263-273`）、三语 i18n 和 UI 映射（`proactive-reminders.tsx:324-355`）。全部接受。
- `needs_review` 状态：产生于两个触发器；使用方 `ruleIsEnforced`（`rule-book.ts:9-11`）、读设置 SQL（`sqlite-proactive-operations.ts:233`）、规则表和历史的 CHECK（`0087:245,271`）。都接受；生产路径读设置后会由 `ruleBookFor` 重新构造为 `active` 记录，而执行判定对两种状态等价。
- `source_memory_id`、`change_reason`：只由迁移/触发器/`writeRule` 历史复制写入，DB 允许 NULL 或规定长度，读端没有更严格的校验会拒绝它们。
- `checked_at`/`changed_at`/`updated_at` 的 `strftime` 值：格式为 24 字符 UTC 毫秒，和 `validTime`、校准 `GLOB`、观察模块的 24 字符检查一致；但缺少自动断言（发现 1）。
- 随机 id：36 字符，符合 1..128；gateway `machineString` 允许 `-` 和 `:`；review key `ledger:rule-review:…` 的 `parseReviewKey` 只按第一个 `ledger:` 前缀切分，能取回完整 id。
- `decision.chain.reviewRules` 键：`message-ids.ts:921` 注册，en/ja/zh 都有，抽屉在 `decision-chain-drawer.tsx:137-139` 使用，`i18n-runtime` 保证三语键集合一致。全部接受。
