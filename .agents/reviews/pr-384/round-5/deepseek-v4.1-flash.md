（已达到本轮工具步数上限，以下结论只基于已读过的代码与文档；未读到/未运行的地方标「未核实」。）

## 结论

未发现会丢数据、绕过校验或破坏请求只追加的高危问题。最值得处理的是一个会让既有提醒静默失效的行为回归，以及两处说明与实现不完全一致。

### 1. 中：`hold` 把已有提醒的记忆改成 tentative 后，提醒会静默停止触发

- 文件: `packages/memory-engine/src/consolidation.ts:386-388`
- 问题: hold 分支对「说得更晚的那条」设置 `attributes: { tentative: true }`。而提醒查询明确排除 tentative 记忆。ADR 0220「后果」写的“已有提醒的记忆被改成待确认后，提醒不撤销”容易被读成提醒仍会正常响；实际是提醒行还在，但从待办和推送查询里消失，若主人一直不确认就一直不响。ADR 0179 说“待确认记忆不触发提醒”，原本只影响新建的低分候选（它们本来就不会登记提醒），现在第一次把已登记提醒的正式记忆变成待确认，产生了新的组合。
- 证据:
  - `consolidation.ts:386-388`：`const change = await this.#revise(id, "hold", newer.memory, older.memory.id, { attributes: { tentative: true } });`
  - `packages/persistence-sqlite/src/sqlite-memory-reminder-operations.ts:11-12`：`const liveMemory = ... m.status = 'active' AND m.superseded_by IS NULL AND m.tentative = 0`
  - 同文件 `:124`、`:141`：`listDue`/`listUpcoming` 都把 `liveMemory` 拼进查询。
  - `apps/agent-service/src/production-memory-control.ts:361-368`、`:724`、`:750` 的到期/即将到期提醒都通过这两个查询读取；`production-web-push.ts` 的推送也走 `store.listDue`。
- 建议: 明确选择其一并在 ADR 写清、加测试：(a) 提醒查询不再因 `tentative` 排除（低分候选本来就不登记提醒，风险需评估）；(b) hold 时遇到已有提醒就保留提醒，或额外记录/提示；(c) 若接受暂停，ADR 改成“提醒行保留但暂停发送，确认后恢复”，并补一条集成用例证明确认后提醒重新出现。

### 2. 低：文档说“不再整理/不再放进同一组”，实现只保证“不再互相当邻居”

- 文件: `docs/agent-rulebook-inventory.md:88`（H-19），`docs/adr/0220-consolidation-conflicts-wait-for-the-owner.md`「决定 6」
- 问题: 库存表 H-19 写“有过 `hold` 的一对以后不再整理”，但代码只把这一对从彼此的候选中排除；它们仍可能一起作为第三条新记忆的邻居出现在同一组。ADR 决定 6 自己已写明这个例外，库存表和作者第 2 轮流述过于绝对。
- 证据:
  - `consolidation.ts:283-287` 用 `listHeldPairs` 填充 `paired`；`:303`、`:327` 只在给某条记忆找邻居时跳过这一对。
  - `consolidation.ts:149-156` 的 parse 要求 keep/drop 至少一方是本组 fresh，因此“这一对单独给出的判断”确实不会执行。
  - 集成测试 `test/integration/memory-consolidation.test.ts` 新用例甚至断言 `milk-new`、`milk-old` 和 `milk-weekend` 同组（`together`）。
- 建议: 把 H-19 改为“这一对不再互相作为整理对象；仍可能一起作为第三条新记忆的邻居出现，但只执行涉及新记忆的判断”。代码本身与 ADR 一致，不需要改逻辑。

### 3. 低：`listHeldPairs` 每次整理读取全部历史 hold 行，无上限

- 文件: `packages/persistence-sqlite/src/sqlite-memory-consolidation-operations.ts:265-281`
- 问题: 查询覆盖 owner/agent 下所有 `action='hold'` 的变更，带 `ORDER BY id`，没有 limit，也没有按 `undone_at` 或时间裁剪。每天整理都跑一次。当前 hold 每天最多约 20 条，短期无碍，但属于会随库龄增长的资源路径。
- 证据: 查询为 `SELECT memory_id, related_memory_id FROM memory_consolidation_changes WHERE owner_id = ? AND agent_id = ? AND action = 'hold' AND related_memory_id IS NOT NULL ORDER BY id`，调用点在 `consolidation.ts:283-287`。
- 建议: 至少去掉无意义的 `ORDER BY`（调用方只建 Set），或加时间窗口/上限；若坚持“永久不再整理”，需在 ADR 写明表增长预期。

### 4. 低：网关契约给 `hold` 加了枚举，但没有对应的 fixture/反向用例

- 文件: `packages/gateway-contracts/src/contracts-v2.ts:990-993`、`:1127-1130`、`:1234-1240`
- 问题: 三处 `action` 枚举都加了 `hold`，`memoryOverview.tidyUps` 还新增了必填 `memoryId`；fixture 只更新了一个 `merge` 项，没有 `hold` 项，也没有“旧 action 仍通过、未知 action 被拒”的契约反向用例。i18n 三种语言和 `memoryId` 的生产/消费两端已对齐。
- 证据: 生产端 `apps/agent-service/src/production-memory-control.ts:670-675` 已输出 `memoryId`；消费端 `apps/control-center/src/components/memory-page.tsx:1739-1741`、`:1782`、`:1787-1791` 使用 `item.memoryId`；fixture `packages/gateway-contracts/test/gateway-v2.fixture.ts:578-...` 只有 `action: "merge"`。
- 建议: 增加一个 `hold` 的 overview/basis/decision-chain fixture，补一条未知 action 被拒的契约用例。

## 读代码证实的

- 迁移 0089 确实是「照抄 0088 的 decision_ledger 及六个依赖表重建块，再加 hold CHECK」，并额外重建 `memory_consolidation_changes` / `memory_consolidation_change_basis`：索引和 `decision_signals` 两个触发器都在 `0089_consolidation_hold.sql` 中重建（`:78-82`、`:109-113`、`:135-136`、`:149`、`:168-177`、`:225-229`、`:265-268`、`:281-282`）。没有 0088 之后的其它迁移再改这些表，因此没有漏掉的索引/触发器。
- 迁移契约测试用 `sqlite_master` 比对整张表定义，并把 `, 'hold'` 归一化后再比，能发现除 hold CHECK 外的任何结构差异；同时比对各表全量行、反向插入未知 action 会触发 CHECK（`consolidation-hold-migration.contract.test.ts:37-55`、`:185-230`）。
- `hold` 在端口类型、`DECISION_OUTCOMES`、SQLite `ACTIONS`、DB CHECK、导出 schema、网关三处枚举、三种语言里都加了；`memoryId` 在生产端产生、在记忆页消费；`MemoryConsolidationStorePort.listHeldPairs` 在 durable adapter 和操作分发里都接上了。
- parse 会拒绝跨组、keep=drop、以及本组 fresh 之外的判断（`consolidation.ts:149-156`），模型无法用它直接删除记忆。
- 自动作废旧条的条件与作者说法一致：`replace` + keep 是时间更晚的一方 + 严格更晚 + 置信度达到 `autoCommitThreshold`（`consolidation.ts:371-380`）；其余（`conflict`、低置信度、keep 填成较早的）走 hold。
- 撤销 hold 只把 `tentative` 设回 false，不动旧条；确认走 `memory.confirm`，同样不动旧条（`consolidation.ts:454-455`、`durable-memory-service.ts:306-325`）。
- 每日复盘通过真实 `listReviewPool` 能看到 hold，且 `readDailyReview` 的容量限制同样作用于它；单元测试用 30 条 hold、capacity=10 覆盖（`packages/application/test/daily-review.unit.test.ts` 新增 `[P3-8]` 段）。
- 记忆页的「撤销/去确认」已按 `memoryId` 判断是否仍在待确认，而不是按文本匹配；测试故意放了同文本但非 tentative 的记忆来验证（`memory-interactions.unit.test.ts:1207-1262`）。
- 提示词 golden 与 manifest 都改了：`memory.consolidation` 拆成 `replace`/`conflict`，格式串加 `replace`（`apps/agent-service/test/__prompt_golden__/memory.consolidation.txt`、`packages/prompt-catalog/src/memory.ts:68-122`）。

## 推测/未核实

- 未运行测试、未计算 sha256，因此 prompt manifest 的两个新哈希是否正确、整套测试是否全绿，未核实。
- 「校准周报改的是同一个门槛」只核对了运行时默认值确实共用 `MEMORY_AUTO_COMMIT_GATE`（`DEFAULT_CAPTURE_GATES` 与 `autoCommitThreshold`），周报写回机制未核实。
- 提醒回归影响面取决于生产中「有提醒的记忆」是否会被做成 hold；代码上完全可能，具体生产数据未核实。

## 侧重检查

- 错误路径: `listHeldPairs` 失败会让整次整理进入 failed（在 `run` 的 try 内），不会误改记忆；`#revise` 使用 expectedRevision，与用户确认/编辑并发时冲突失败，不会覆盖。
- 不可信输入: 模型输出只在组内成员中取 keep/drop，并要求至少一方是 fresh；hold 只会加 tentative，不会删除或作废旧条，安全性可接受。
- 不可撤销操作: hold 可撤销；撤销后再确认会因 revision 变化被拒（测试覆盖 `MEMORY_CHANGED_AFTER_CONSOLIDATION`），符合现有整理语义。
- 资源耗尽: 单次整理 fresh≤20、邻居≤3，hold 每天有上限；唯一增长点是上文 `listHeldPairs` 全量读取。
- 规则/文档一致: 迁移、网关、i18n、导出 schema 对齐；不一致点是第 1 条的提醒后果和第 2 条“同一组”的绝对表述。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会改变任何对话的已发开头。整理记忆是后台单次调用：固定指令 + 本次数据放在同一条用户消息里，系统提示、工具定义、历史都没有被改；`MEMORY_CONSOLIDATION` 的 `usedBy` 只有 `consolidation.ts`，不在会话历史里。提示词文字改动只影响之后的整理调用。需要注意规则文件第 11 条的遮挡白名单：改提示词文字会改变「固定文字」清单，但旧整理提示词不会出现在任何对话历史中，所以不会让老对话的字节变化。结论：对会话而言仍是只在末尾追加；对后台调用而言固定在前、动态数据在后，末尾是固定格式说明，没有把动态值放到最后。

2. **同一段文字会不会在不同请求里变成不同字节？**
   这个改动没有引入时间字段、随机值或无序遍历。`listHeldPairs` 虽然 `ORDER BY id`，但只用于建 Set；配对键会排序；fresh 和邻居都有确定排序；`statedAt` 只读记忆自身属性。新增的 hold 分支是确定的。未发现新引入的非确定性；搜索结果的顺序是否稳定属于既有问题，未核实。

3. **有没有对应自动检查，反向用例会失败吗？**
   有。迁移契约测试反向拒绝未知 action、比对全表结构/数据；集成测试覆盖自动取代、情境差异 hold、低置信度 hold、keep=N 较早条时 hold、确认/撤销后不再整理；每日复盘有 capacity 反向断言；记忆页有「同文本但非 tentative 不给撤销」的反向用例。缺的是提醒相关用例和网关 `hold` fixture。若把 hold 行为改回旧逻辑，现有集成用例会失败（例如期望 `["supersede","home-old"]`、`["hold","milk-new"]` 的断言）。

4. **改动产生/修改的每个值，每个使用点都能接受吗？**
   `hold`：端口、决策账本、SQLite CHECK、导出 schema、网关三处枚举、三种语言的 label 都接受，已核对。`memoryId`（tidyUps）：生产端写入、契约必填、记忆页消费、fixture 更新，接受。`listHeldPairs`：应用端口、durable adapter、SQLite 操作分发、运行期调用全部接上。`autoCommitThreshold`：从 application 导出，整理服务与抽取共用同一静态门槛，接受。`replace`：提示词、golden、parse、迁移 CHECK 无冲突。唯一没有“接受”的是提醒查询：它把 hold 写入的 `tentative=true` 当成不可提醒状态，见第 1 条。

**总体建议**: 合入前至少先对第 1 条做决定（补行为或改 ADR+测试）；第 2 条改文档措辞即可；第 3、4 条可作为后续低项。
