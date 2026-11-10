## 侧重检查

- 错误路径：`writeSettings` 的校验顺序（先校验、后事务）和 9 段被拒路径；OAuth 首次连接时 `readSettings`→`writeSettings` 的自动回写路径。
- 不可信/异常输入：静默时段数量、时钟格式、重复星期、孤立代理项、发件人长度/数量；网关契约与存储两端的校验。
- 资源耗尽：8 段上限对生成 CEL 表达式的影响；读取路径是否重新限制。
- 不可撤销操作：ADR 0209 所述 0086 迁移不可逆；迁移引擎的快照要求。
- 文档一致性：ADR 0184 的规则 id/表名、ADR 0209 的迁移后果和回退说法。
- 结论：没有发现会改变模型请求开头或破坏模型输入字节确定性的问题；主要风险是“旧数据/读取路径没有同步限制”和“重新激活语义只覆盖了参数改变的情况”。

## 发现

### 1. 中（条件性）：降低写入上限没有处理已经存在的 >8 段数据

- 文件: `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:267`、`packages/persistence-sqlite/src/migrations/0086_rule_book.sql:33-38`、`packages/gateway-contracts/src/contracts-v2.ts:347`
- 问题: 新的 `> 8` 校验只挡住新的写入。迁移 0086 仍然把旧 `proactive_settings.quiet_hours` 原样复制进规则手册，`readSettings` 仍然把 `periods` 原样读出，而网关契约最多只接受 8 段。如果库里已经有 9–14 段，总览快照仍然会整页解析失败；更直接的是，OAuth 首次连接会先读设置再自动回写，这时新的上限会让连接直接失败。
- 证据（读代码证实）:
  - `sqlite-proactive-operations.ts:267`：`input.quietHours.length > 8 ||`
  - `0086_rule_book.sql:36-38`：`SELECT owner_id, agent_id, 'quiet_hours', 1, json_object('periods', json(quiet_hours)), 'active', ... FROM proactive_settings;`（没有截断或校验）
  - `sqlite-proactive-operations.ts:244-248`：`quiet ? (JSON.parse(quiet.parameters) as { periods: ... }).periods : DEFAULT_QUIET_HOURS`（读取不做上限检查）
  - `contracts-v2.ts:347`：`if (periods.length > 8) throw new ContractValidationError(path, "expected at most 8 periods");`
  - `apps/agent-service/src/production-proactive.ts:283-286`：`if (!existing) { const settings = await store.readSettings(scope); await store.writeSettings({ ...scope, ...settings, enabled: true, now }); }`
- 推测/前提：我在仓库里没有找到通过生产网关写入 >8 段的路径；网关从引入主动检查起就是 8 段上限（`git blame` 显示 `contracts-v2.ts:347` 来自 `54906f17`），控制中心也是 `MAXIMUM_PERIODS = 8`。因此这条只在“直接写库、测试数据或异常旧数据”下成立，不是网关正常写入造成的问题。
- 建议: 在 `readSettings` 或迁移后的规范化步骤里处理已有的 >8 段（拒绝、截断并记录，或新增迁移修正）；至少补一个“库里已有 9 段时总览读取/OAuth 连接”的用例。若确认不存在这类旧数据，请在 PR 说明里写明“只防新写入，不修旧数据”。

### 2. 中（条件性，面向第 4 步）：重新激活语义与读取路径不一致

- 文件: `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:232-248`、`341-350`；`test/integration/rule-book-store.test.ts:121-151`
- 问题: `readSettings` 只返回 `status = 'active'` 的规则；规则被退休后，读出来的是默认静默时段/空发件人。新的 upsert 又会在参数变化时强制 `status = 'active'`。未来规则页一旦把规则置为退休，之后任何从总览发起的保存（哪怕只是切换启用开关，UI 会用默认值拼出设置）都会因为“参数变了”而把该规则重新激活，并可能用默认值覆盖原来的退休参数。现有新增测试只用原始 SQL 把规则改成 `retired`，随后立即用变化后的参数保存，没有覆盖“读取后再保存”的路径。
- 证据（读代码证实）:
  - `sqlite-proactive-operations.ts:232-234`：`SELECT rule_id AS ruleId, revision, parameters FROM rule_book_rules WHERE ... AND status = 'active'`
  - `sqlite-proactive-operations.ts:341`：`if (current && current.parameters === parameters) return;`
  - `sqlite-proactive-operations.ts:348-350`：`DO UPDATE SET revision = excluded.revision, parameters = excluded.parameters, status = 'active', ...`
  - `apps/control-center/src/proactive.ts:255-260` 和 `apps/control-center/src/components/proactive-settings.tsx:56-60,77`：保存时用 `overview` 的默认/当前可见值拼设置
- 建议: 明确“保存即恢复”还是“只有参数变化才恢复”。如果是前者，early return 要同时检查 `current.status === "active"`；如果是后者，测试名和 PR 说明应改成“参数变化时恢复”，并补一个参数完全相同但状态为 `retired` 的用例。还要决定退休规则的原参数从哪里读回，避免用默认值覆盖。

### 3. 低：作者第二条说法与代码机制不一致（行为结论基本成立）

- 文件: `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:300-312`、`341`
- 问题: 作者说“`writeRule` 只在参数改变时才被调用（读写之间用修订号比较）”。代码实际是每次 `writeSettings` 都无条件调用两次 `writeRule`，由 `writeRule` 自己查询后比较 `current.parameters === parameters`，不是比较修订号。结论“未改变的退休规则保持退休”成立，但实现机制说错了。
- 证据（读代码证实）:
  - `sqlite-proactive-operations.ts:300`、`312`：两次无条件 `this.writeRule(...)`
  - `sqlite-proactive-operations.ts:341`：`if (current && current.parameters === parameters) return;`
- 建议: 修正作者说明，避免后续维护者以为存在修订号比较或“不调用”优化。

## 作者说法的逐条核对

- “网关从来不允许超过 8 段静默时段，所以存储上限降到 8 不会拒绝任何通过网关写入过的数据。”——成立：`contracts-v2.ts:347` 上限为 8（`git blame` 显示来自主动检查的初始提交 `54906f17`），控制中心也是 8（`proactive-settings.tsx:24`）。但这条只覆盖“通过网关写入过”的数据，不覆盖直接写库或迁移复制出来的异常数据。
- “`writeRule` 只在参数改变时才被调用（读写之间用修订号比较），所以未改变的退休规则保持退休是原有行为。”——部分不成立：`writeRule` 每次都会调用，比较的是参数 JSON 字符串，不是修订号；“未改变保持退休”的行为本身成立。

## 读代码证实的 / 推测

**读代码证实的**

- 新上限 8 只存在于 `writeSettings`（`sqlite-proactive-operations.ts:267`）；迁移 0086 和 `readSettings` 没有对应上限。
- `writeRule` 的 early return 只在 `current.parameters === parameters` 时发生（`:341`），所以未改变参数的退休规则不会恢复。
- 历史行固定写 `active`（`:355-358`），新的 upsert 也写 `active`（`:348-350`），两者现在一致。
- 迁移 0086 的历史表有 `ON DELETE CASCADE`（`0086_rule_book.sql:14-15`）和“父行存在时禁止删除”的触发器（`:28-31`）；新增测试删除 Agent 后断言历史为 0，和已有的 `ledger_observation` 级联模式一致。
- 规则 id `floor_important_sender` 与 `packages/application/src/rules/rule-book.ts:25-30`、迁移 0086 一致；ADR 0184 的表述与代码一致。
- 新增测试分别位于 `integration`、`contracts` 项目；`rule-registry.unit.test.ts` 由 `check:rule-registry` 执行，属于自动检查。

**推测或未核实**

- 现有数据库是否真的存在 9–14 段静默时段：未找到生产写入路径，只能由直接写库、测试数据或异常历史造成。
- ADR 0209 说“回退脚本沿用这一条”：迁移引擎确实要求已有 schema 有快照（`migration-engine.ts:928`），但 `rollback-remote.py:148-153` 实际使用的是恢复点 `S3_COPY51`，不是迁移引擎的 `VerifiedMigrationSnapshot`；两者是否就是同一份“迁移前快照”，我没有继续核实。
- 我没有运行测试（工具限制），下面关于“反向用例会失败”的判断来自读代码推理，不是执行结果。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   就本改动而言，不会。diff 没有触碰系统提示、工具定义、历史消息、遮盖或 prompt-catalog；规则手册只用于主动检查的确定性求值（`proactive-overview.ts:124-125`、`proactive-mail-check-service.ts:606-607`、`807`），没有进入模型提示。因此“发给模型的内容仍然只在末尾追加、每轮变化的值仍在最后一条消息”这一性质没有被本改动破坏；本改动也没有新增需要放进最后一条消息的每轮变化值。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   不会由本改动引入。新增的 `status = 'active'` 是固定字面量，8 是固定上限；`writeSettings` 还按 `days` 排序（`sqlite-proactive-operations.ts:305`）。不过，`quietHours` 的周期顺序和 `importantSenders` 的顺序仍按调用方输入原样序列化（`:303-316`），同样的集合换顺序会产生不同的参数字节和修订号——这是现有行为，且这些参数不进入模型请求。将来若把规则内容发给模型，需要先把周期和发件人顺序规范化。

3. **有没有对应的自动检查？反向用例真的会失败吗？**
   有：
   - `test/integration/rule-book-store.test.ts:121-151`：去掉 `status = 'active'` 后，第二次保存会留下 `retired`，`DISTINCT status` 不等于 `["active"]`，会失败。
   - 同文件 `:153-172`：把上限改回 14 后，9 段会写入成功，`rejects.toThrow()` 会失败。
   - `packages/persistence-sqlite/test/rule-book-migration.contract.test.ts:147-153`：级联删除或触发器不对时，`DELETE FROM agents` 会抛错或历史计数不为 0，会失败。
   - `rule-registry.unit.test.ts:90` 改为 8 段，由 `check:rule-registry` 执行，保证最大合法设置仍能编译。
   缺口：没有“参数完全相同但规则已退休”的用例；没有“库里已有 9 段时读取/总览/OAuth 连接”的用例；文档改动没有自动校验其事实准确性。

4. **改动产生/修改的每个值，两端都能接受吗？**
   - 静默时段上限 8：生产端是 `writeSettings`；消费端有 `readSettings`→`proactive-overview`→网关 overview 契约（`contracts-v2.ts:347` 最多 8）和 settings 命令契约（`:498` 同样 8）。正常新的写入两端一致；但迁移复制和读取路径没有重新校验，这是上面发现 1 的缺口。
   - `status = 'active'`：生产端是 `writeRule` 的 upsert 和历史插入；消费端有 `rule_book_rules.status` 的 CHECK（`0086_rule_book.sql:7`）、`rule_book_history.status` 的 CHECK（`:19`）、`readSettings` 的 `status = 'active'` 过滤（`sqlite-proactive-operations.ts:233`）、`RuleStatus = "active" | "retired"`（`rule-book.ts:6`）和裁判忽略 retired（`rule-judge`/测试 `:168`）。两端都能接受。
   - 测试里的 `status = 'retired'`：DB CHECK 接受（`0086_rule_book.sql:7`）。
   - 规则 id `floor_important_sender`、表名 `rule_book_rules`/`rule_book_history`：迁移、`RULE_IDS`、ADR 0184 三处一致。
   - 历史随 Agent 删除：`ON DELETE CASCADE`（`0086_rule_book.sql:14-15`）加触发器条件（`:28-31`），新增测试验证了直接删除 Agent 的路径；未覆盖生产是否有其他删除 Agent 的专用流程（目前搜索到的都是测试直接 SQL）。
