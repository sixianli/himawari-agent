## 侧重检查

- **错误路径**：`ContextFormationService` 对 `appendIfChanged` 的失败一律 `.catch(() => undefined)`（`packages/application/src/services/context-formation-service.ts:346-370`）；测试只覆盖了“抛错仍能形成上下文”（`test/integration/decision-ledger.test.ts:1279-1295`）。结论：写记录失败不会影响对话，但也不会留下任何可观测痕迹。
- **不合规范/不可信输入**：`appendIfChanged` 校验 `reasonCodes` 长度为 1–16、每项 1–64 字符且包含 `write.reasonCode`；`profileBudget` 校验为安全整数且 `limit >= 1`、`pinned <= used`（`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:70-82,319-331`）；`memoryIds` 最多 200 个（`sqlite-decision-ledger-operations.ts:29,40-47`，`context-formation-service.ts:359`）。SQL 全部参数化。基本合格。
- **安全/隐私**：记录只写记忆编号，不写正文（`context-formation-service.ts:358-362`；测试 `decision-ledger.test.ts:1197` 用 `JSON.stringify` 断言不含正文）。导出/导入的 `DECISION_SCHEMA.inputs` 是通用 object（`packages/persistence-sqlite/src/data-export/schemas.ts:208`），`profileBudget` 不会被导出层拒绝。结论：没有把记忆正文复制进决策记录。
- **资源耗尽**：置顶没有硬上限，置顶过多会让每轮最后一条消息无限增长；ADR 已把它列为有意接受的取舍（`docs/adr/0214-record-profile-truncation-and-keep-pinned-memories.md` 后果一节）。`queued` 最多记 200 个编号，防住了记录本身膨胀。
- **不可撤销操作**：本改动只追加决策记录，没有删除/覆盖路径。
- **规则文件、说明文档与代码一致性**：核对了 `.claude/rules/prompt-prefix.md`、ADR 0214、`docs/agent-rulebook-inventory.md` M-3、写入约定文档。大部分一致；发现两处表述/实现不完全一致，见下面发现 1、2。

## 发现（按严重度）

### 低 1：去重范围写成“按主人”，代码实际按“主人 + agent”（已证实）
- 文件：`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:335-340`；`docs/adr/0214-record-profile-truncation-and-keep-pinned-memories.md:55`
- 证据：
  ```sql
  WHERE owner_id = ? AND agent_id = ? AND kind = ?
    AND reason_code IN (SELECT value FROM json_each(?))
  ```
  ADR 写的是“去重按主人算，不按对话算”。
- 问题：同一 owner 下有两个 agent 时，同一组编号会各写一条，与“按主人算”不一致。若档案本来就是按 owner+agent 选出的，代码可能才是对的，但文档和作者说法需要改。
- 建议：明确去重粒度。若要按主人，去掉 `agent_id` 条件；若按 agent，把 ADR 和作者说明改成“同一主人同一 agent”，并补一个双 agent 用例。

### 低 2：“同一组只记一次”实际是“与最近一条记录相同才不记”（已证实，是否算缺陷取决于验收解释）
- 文件：`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:343-348`；`test/integration/decision-ledger.test.ts:1265-1273`
- 证据：
  ```ts
  if (latest?.reasonCode === write.reasonCode) {
    const before = ...memoryIds;
    const now = write.inputs.memoryIds;
    if (before?.length === now.length && new Set([...before, ...now]).size === now.length)
      return false;
  }
  ```
  测试明确期望 `A → B → A` 时最后一条 A 再写一次（`ledger-c` 返回 `true`）。
- 问题：验收第 2 条“同一组条目又被挤掉时，不再多记一条”可以理解成“只要这组以前记过就不记”；当前实现只在它是最近一条记录时不记。ADR 的“放弃的做法”只写了“中间隔了没超字数的轮次”这个特例，没有说明 A→B→A 会重记。
- 建议：把验收解释写死。若要求全局去重，应改为用稳定的去重键（见下）；若接受“最近一条”语义，在 ADR 里补一句 A→B→A 的例子，避免下次复核再争。

### 低 3：截断记录写失败完全静默，且会吞掉配置/校验错误（已证实）
- 文件：`packages/application/src/services/context-formation-service.ts:346-370`
- 证据：
  ```ts
  await this.dependencies.ledger
    .appendIfChanged({ ... })
    .catch(() => undefined);
  ```
- 问题：ADR 允许“写入失败不影响对话”，但这里是所有错误一律吞掉，包括 `profileBudget.limit=0` 这类配置错误、磁盘检查失败、SQLite busy。结果是“档案超出字数就会有记录”在故障时静默不成立，事后无法区分“没超字数”和“写失败”。
- 建议：至少写一条 trace/日志（不要记录记忆正文），或者只吞数据库/磁盘错误，把 `PORT_INVALID_OPERATION` 这类编程/配置错误暴露出来。

### 低 4：`characterBudget = 0` 时生产出的 `profileBudget.limit` 无法通过后端校验（已证实逻辑；该配置是否会被真实使用未核实）
- 文件：`packages/application/src/services/owner-profile-service.ts:191`；`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:70-82`
- 证据：
  ```ts
  const limit = this.#options.characterBudget ?? OWNER_PROFILE_CHARACTER_BUDGET;
  ...
  budget.limit < 1   // 后端拒绝
  ```
- 问题：如果配置为 0（或未来允许 0 表示“完全不带档案”），`appendIfChanged` 会以 `PORT_INVALID_OPERATION` 失败，然后被上面的 `.catch` 吞掉，导致永远没有截断记录。
- 建议：在 `OwnerProfileService` 构造时校验 `characterBudget >= 1`，或者让后端明确接受 `limit = 0` 并用测试固定这一行为。

### 提示：性能与覆盖（推测/未实测）
- `appendIfChanged` 每轮按 `owner_id/agent_id/kind/reason_code` 过滤后 `ORDER BY rowid DESC`，现有索引只有 `(owner_id, agent_id, kind, checked_at)`（`packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql:79`）。决策记录会持续增长，这一查询可能随 owner 的记录数变慢。建议加 `(owner_id, agent_id, kind, reason_code, rowid)` 一类的索引，或改用稳定去重键，避免每轮倒序扫描。
- 未覆盖：超过 200 条编号时的去重、并发/多进程同时 `appendIfChanged`、导出再导入后 `rowid` 顺序变化。ADR 已承认后两项的取舍，但没有自动用例；我未运行测试，无法确认这些场景的实际行为。

## 必答问题

1. **不会改变模型已经见过的请求开头。**
   - 档案块最终由 `turnPrompt()` 组装到最后一条用户消息里：`packages/runtime-pi/src/pi-runtime-adapter.ts:623-641`，然后通过 `session.prompt(turn, ...)` 追加：`pi-runtime-adapter.ts:1890-1895`。
   - 历史里的旧 context block 会被跳过：`packages/runtime-pi/src/pi-native-history.ts:65-66` 明确不把旧的 `himawari.context.block` 放进历史。
   - 本次改动只改变 `#select` 选中的档案条目，也就是最后一条消息的内容；系统提示、工具定义、历史消息、遮盖结果都没有被改写。发给模型的内容仍是“只在末尾追加”，每轮变化的档案/时间仍在最后一条消息里。

2. **没有发现会新引入“同一段文字在不同请求里变成不同字节”的路径。**
   - 档案条目顺序由固定分类顺序、置顶优先、重要度、`id.localeCompare` 决定（`owner-profile-service.ts:121-124,192-216,239-243`）；置顶集合只用于成员判断。
   - `usage.queued` 写入记录前会排序（`context-formation-service.ts:359`）。
   - 新记录的 `decidedAt`/`runId` 会变，但这些只进入 decision ledger，不进入发给模型的内容。记忆日期文案只依赖记忆自身日期和固定时区，不依赖请求前后文（`packages/application/src/ports/memory-dates.ts:49-58`）。
   - 注意：`localeCompare` 和日期文案是既有代码，不是本次改动引入；跨不同 ICU/locale 的字节一致性我未核实。

3. **有自动检查，反向用例从断言上看会失败；我没有实际运行测试。**
   - 正向、去重、集合变化、置顶超限、写失败、未超限反向：`test/integration/decision-ledger.test.ts:1156-1295`，并且 `describe.each(["worker", "direct"])` 两种执行方式都跑。
   - 单元：`packages/application/test/owner-profile-service.unit.test.ts:443-506`。
   - 页面提示：`apps/control-center/test/memory-interactions.unit.test.ts:493-509`（`pinned` 为 0/100/2000 时断言不显示，2001 时断言显示）。
   - 浏览器：`test/integration/memory-source-browser.test.ts:153-172`（正向提示、反向不提示）。
   - 反向有效性：若把 `context-formation-service.ts:344` 的条件改成“总是写”，`decision-ledger.test.ts` 的反向用例会因为 `profileRows(list)` 非空而失败；若把页面提示改成无条件渲染，`memory-interactions` 的 0/100/2000 断言会失败。
   - 缺口：>200 条、并发、配置 `limit=0`、导入后 rowid 变化没有自动用例。

4. **逐项核对新值/字段：**
   - `profile_budget_exceeded` / `profile_pinned_over_budget`：数据库只校验 `reason_code` 为 1–64 字符（`migrations/0087...sql:35`），能接受；`daily-review.ts:201-210` 把所有 `context_truncation` 归入 `other`，不占每日预算；UI 只按 `kind` 显示，不枚举原因码。**通过。**
   - `profileBudget: {limit, used, pinned}`：生产者 `context-formation-service.ts:361`；校验 `sqlite-decision-ledger-operations.ts:70-82` 要求 `kind=context_truncation`、整数、`limit>=1`、`pinned<=used`，正常生产值满足；入库 `insertLedgerRow` 保留该键（`:130-136`）；读取 `entryFromRow` 还原（`:228`）；导出 schema 是通用 object（`data-export/schemas.ts:208`），导入原样写回。**除 `limit=0` 边界外通过。**
   - `usage.pinned`：产生于 `owner-profile-service.ts:245-250`；使用于 `production-memory-control.ts:702-707`、`memory-page.tsx:1284-1291`、网关契约 `contracts-v2.ts:1244-1249`。仓库内所有 `profileUsage` 生产者和测试夹具都已补 `pinned`；**通过**。仓库外/旧持久化快照未核实。
   - `appendIfChanged` 操作名：`durable-adapters.ts:1022` 发出，`sqlite-decision-ledger-operations.ts:252-253` 接收；worker 按 `decisionLedger.` 前缀分发（`sqlite-durable-operations.ts:567-568`），没有白名单需要登记。**通过。**
   - 新 i18n 键 `memory.page.carry.pinnedOver`：已加入 `MESSAGE_IDS`、`MESSAGE_SAMPLE_VALUES` 和 en/ja/zh-CN 三份资源；**通过。**
   - 文档/作者说法与代码不一致的两点：去重粒度（发现 1）、“同一组只记一次”的最近一条语义（发现 2）。

**总体结论**：未发现高或中严重度的功能性缺陷；核心要求（置顶不挤掉、超限写记录、同组去重、反向不写、页面提示、档案位置不动）在代码和测试上都能对上。主要风险是几处低严重度的文档/语义不一致、写失败完全静默，以及 `characterBudget=0` 这类边界没有测试。
