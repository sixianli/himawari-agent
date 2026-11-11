以下结论来自读代码和 `git diff`，没有运行测试。

## 读代码证实的发现

### 1. 高：物理删除记忆时触发器不会触发，硬规则会漏掉“待重审”

- 文件:行：`packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql:301`；`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:885`
- 问题：新触发器只建在 `AFTER UPDATE ON memory_records` 上。但治理删除在永久删除记忆时直接执行 `DELETE FROM memory_records`。只要记忆没有 `provider_record_id` 且状态不是 `deletion_pending`，`deleteImmediately` 就跳过状态更新，直接走 `#deleteCore` 物理删除。此时关联规则仍是 `active`，不会写历史，也不会写 `rule_review` 决策记录。
- 证据：
  - `0087_rule_book_memory_link.sql:301`：`CREATE TRIGGER memory_rule_needs_review AFTER UPDATE ON memory_records`
  - `sqlite-governed-deletion.ts:515`：`if (memory && (memory.providerRecordId || memory.status === "deletion_pending")) {`
  - `sqlite-governed-deletion.ts:549-557`：不满足上述条件时直接进入事务并调用 `this.#deleteCore(...)`
  - `sqlite-governed-deletion.ts:885`：`database.prepare("DELETE FROM memory_records WHERE id = ?").run(objectId);`
  - 已有测试确实会永久删除一条非 `deletion_pending` 的记忆：`test/integration/sqlite-governed-deletion.test.ts:516-518`。
- 影响：违反本 PR 的“记忆被删除时标待重审并留决策记录”（ADR 0211 决定 3），而且是不可撤销的永久删除路径。
- 建议：增加 `AFTER DELETE ON memory_records` 的触发器，或在治理删除物理删除前先做一次状态更新让现有触发器触发。若加 DELETE 触发器，必须同时处理 Owner/Agent 级联删除，避免与 `rule_book_history_no_delete` 冲突，并补一条“永久删除已关联规则记忆”的集成测试。

### 2. 中：保存相同设置不会把 `needs_review` 清回 `active`，与 ADR 说法不一致

- 文件:行：`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:341`
- 问题：ADR 0211 和作者说法是“主人在设置页重新保存这条规则，就回到 `active`”。但 `writeRule` 在参数完全相同时直接返回，不会执行后面的 `status = 'active'` 更新。主人只是重新保存、没有改值时，规则会一直停在 `needs_review`。
- 证据：
  - `sqlite-proactive-operations.ts:341`：`if (current && current.parameters === parameters) return;`
  - `sqlite-proactive-operations.ts:348-350`：只有参数不同时才执行 `status = 'active'`
  - 新测试只覆盖了修改参数的情况：`test/integration/rule-memory-review.test.ts` 的用例把 `["bank.example"]` 改成 `["bank.example", "tax.example"]`，没有覆盖“原样重存”。
- 建议：当前行存在且状态为 `needs_review` 时不要提前返回，至少更新状态、追加历史；补一条“参数不变但重新保存”的测试。

### 3. 中：`rule_review` 已加入校准分组，但周报的组名文案没有加，用户会看到错误标签

- 文件:行：`apps/control-center/src/i18n/resources/zh-CN.ts:1242-1243`、`en.ts:1342-1343`、`ja.ts:1331-1332`；使用处 `apps/control-center/src/components/weekly-report.tsx:842`
- 问题：本 PR 把 `rule_review` 加进了 `CALIBRATION_GROUPS`（`packages/calibration/src/index.ts:25`），周报用 `message("weekly.group", { g: group })` 显示组名。但三语的 `weekly.group` select 都没有 `rule_review` 分支，会落到 `other`；而 `other` 在现有文案里是“外部程序读取记忆”。因此 `rule_review` 在周报里会被误显示成“外部程序读取记忆”。`weekly.groupInfo` 同样会把 `rule_review` 说成“Himawari 每 15 分钟读一次新邮件”。
- 证据：
  - 中文 `zh-CN.ts:1243`：`... retrieval_degrade {记忆搜索没生效} other {外部程序读取记忆}}`
  - 英文 `en.ts:1343`：`... retrieval_degrade {Memory search did not work} other {Memory read by an outside program}}`
  - 日文 `ja.ts:1332`：`... retrieval_degrade {記憶検索が働かなかった} other {外部プログラムによる記憶の読み取り}}`
  - `weekly-report.tsx:842`：`title: message("weekly.group", { g: group })`
- 影响：作者称“三语界面同步加上这个类型”，但这不是事实；新增分组会显示错误含义。
- 建议：三语 `weekly.group` 增加 `rule_review {硬规则待重审 / Hard rule review / ハードルールの再確認}`；`weekly.groupInfo` 也补对应说明。最好加一个“每个校准分组都有文案”的测试。

### 4. 低：迁移数据保全测试没有覆盖全部被重建的子表

- 文件:行：`packages/persistence-sqlite/test/rule-memory-review.contract.test.ts:55-66`、`:138-146`
- 问题：迁移 0087 重建了 `source_insights`、`proactive_processed_messages`、`decision_ledger_payloads`、`decision_signals`、`proactive_push_backoff`、`muse_reference_entries` 六张子表，但测试只插入了 `decision_signals` 和 `proactive_push_backoff`，只验证了 `decision_ledger`、`decision_signals`、`proactive_push_backoff`、规则表和规则历史。其余四张子表即使复制列漏了、数据丢了，这组测试也不会失败。
- 证据：
  - 种子数据只有 `decision_ledger`、`decision_signals`、`proactive_push_backoff`（`rule-memory-review.contract.test.ts:49-66`）。
  - 断言只查了 `decision_ledger`、`decision_signals`、`proactive_push_backoff`（同文件 `:138-146`），没有 `source_insights`、`proactive_processed_messages`、`decision_ledger_payloads`、`muse_reference_entries`。
- 我逐列对照了 0069/0070/0073/0076/0080/0081 与 0087：新表定义包含了后来 `ALTER TABLE` 加上的 `push_class`、`received_at`、`paired_message_id`，索引和触发器也重建了，目前看不出字段缺失。但测试没有证明这一点。
- 建议：六张子表各插入一行并断言迁移后仍在，同时验证关键索引/触发器（尤其 `decision_signals_no_update/no_delete`）仍生效。

### 5. 低：`schema-catalog` 对 `decision_ledger` 的说明没有加入 `rule_review`

- 文件:行：`packages/persistence-sqlite/src/schema-catalog.ts:823`
- 问题：说明文字仍在枚举旧的六种决策类型，没有 `rule_review`。这不是运行时校验问题，但属于规则/说明文档与代码不一致。
- 证据：`"one row per model gate decision (proactive check, memory candidate, consolidation change, context truncation, retrieval degrade, external read): ..."`
- 建议：补上 `rule review`，或改成不逐个枚举类型。

## 推测

- 如果直接增加 `AFTER DELETE` 触发器而不处理 Owner/Agent 级联删除，可能与现有 `rule_book_history_no_delete` 的 `WHEN EXISTS ... agents/owners` 逻辑相互影响，导致删除 Owner 失败。需要专门设计并测试。
- 触发器只看 `content_ref` 是否变化。如果同一段文字被重新封装成新的 payload ref，会被当成“记忆被改”而标待重审；这是否可接受需要确认。
- 一条记忆如果关联很多条规则，一次记忆更新会在同一事务里写入多条历史和决策记录。规则数量目前很少，但代码没有上限。

## 侧重检查

- 永久删除/不可撤销路径：查了 `deleteImmediately`、`#deleteCore`、`purgeExpiredTrash`、admin CLI 的删除入口。发现第 1 条高严重度问题：永久删除绕过 `AFTER UPDATE` 触发器。
- 不合规/不可信输入：触发器写入 `rule_id`、`memory id`、`changed_at`、`reason_code` 都受表约束或长度限制；`decision_ledger.inputs` 用 `json_object/json_array` 生成，不含正文。未发现注入问题。`checked_at` 直接取 `NEW.updated_at`，数据库层没有格式校验，但服务层通常生成规范时间。
- 资源耗尽：触发器每个被更新记忆最多为每条已关联且 `active` 的规则写一条历史和一条决策记录，没有循环放大；迁移会临时复制多张表，磁盘占用翻倍，但这是迁移固有代价。
- 安全：`rule_review` 决策记录只带记忆编号和规则编号，不带记忆正文；规则手册本身不导出。未发现新增正文泄露。
- 文档/规则一致性：ADR 0211 与代码在“重新保存回到 active”上不一致（第 2 条）；周报文案缺 `rule_review`（第 3 条）；`schema-catalog` 说明未更新（第 5 条）。发给模型的内容未改动，`check:prompt-prefix` 不受影响。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。本次 diff 没有改系统提示、工具定义、历史、遮盖或 prompt 组装代码；改动集中在 SQLite、触发器、决策记录枚举、校准、导出和 UI 文案。发给模型的内容仍然只追加，没有把每轮会变的值放进开头。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会影响模型请求。新引入的随机值只有 `decision_ledger.id`（`'rule-review:' || hex(randomblob(12))`），只写入数据库，不进请求；触发器里的 JSON 数组顺序也是固定的。迁移里的随机 ID 同样不涉及请求序列化。
3. **有没有自动检查，反向用例会不会真的失败？** 有，而且多数反向用例是真的：`decision-ledger-migration.contract.test.ts` 会因缺少 `rule_review` 检查约束而失败；`rule-memory-review.contract.test.ts` 在触发器缺失时规则会仍是 `active`，会失败；真实 `DurableMemoryService` 集成测试覆盖了修改、取代、归档、回收、删除、重分类和反向场景。缺口是：永久删除路径没有测试（第 1 条）、原样重存清标记没有测试（第 2 条）、周报文案没有测试（第 3 条）、迁移测试没有覆盖全部子表（第 4 条）。
4. **每个值的使用方都能接受吗？**
   - `needs_review` 状态：迁移/触发器产生，`READSettings` 的 SQL、`ruleIsEnforced`、历史表、测试都接受；但 `writeRule` 原样重存时不会清回 `active`（第 2 条）。
   - `source_memory_id`：迁移和测试产生，长度 1..128，索引和历史复制使用；当前生产代码还没有写入它的路径（符合“第 4 步才填”）。
   - `rule_review` / `needs_review` 决策：触发器、决策记录端口、数据库 CHECK、三处 gateway 契约、校准、导出 schema、两处 i18n 都已覆盖；遗漏了 `weekly.group` 组名文案（第 3 条）。
   - `change_reason`：只由触发器产生、只在规则历史中使用，没有枚举约束，长度也足够。
   - 迁移重建的六张子表：我逐列对照了历史定义，列、索引、触发器、外键目前看是完整的；但自动测试只验证了其中三张表，其余四张属于“代码看对了、测试未覆盖”。
