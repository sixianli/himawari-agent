## 结论

本轮提交 `bff30232` **确实只改了格式**：`git show --stat bff30232` 只有 `test/integration/rule-memory-review.test.ts` 一个文件，`1 insertion(+), 4 deletions(-)`；唯一改动把同一次调用从多行折成一行，参数、参数顺序、调用次数都没变。未发现中、高或低严重度缺陷。

```diff
-      await memory.applyProposal(
-        { decision: "unchanged", memoryId: RULE_MEMORY },
-        GENERATION_ID,
-      );
+      await memory.applyProposal({ decision: "unchanged", memoryId: RULE_MEMORY }, GENERATION_ID);
```

`67bae097..bff30232` 范围内另有 `dee3da04` 的 `.agents/reviews/pr-366/usage.jsonl` 二进制记账变化，不是代码，也不是 `bff30232` 引入的。

## 发现（按严重度）

### 未发现需要修复的问题

本轮没有可报告的代码缺陷。

### 观察 1（信息，非缺陷）：增量范围包含记账文件

- 严重度：信息
- 文件：`.agents/reviews/pr-366/usage.jsonl`
- 问题：`67bae097..bff30232` 的增量不只有格式提交，还包含 `dee3da04` 的复核记账。
- 证据：`git show --stat dee3da04` 显示 `1 file changed, 0 insertions(+), 0 deletions(-)`，仅 `usage.jsonl | Bin 3222 -> 3581 bytes`；`git show --stat bff30232` 不包含该文件。
- 建议：无需处理；与作者“按规则记账”的说法一致。

### 观察 2（信息，非缺陷）：迁移 0087 的一次性复制与不可逆性

- 严重度：信息
- 文件：`packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql:1-7`、`:231-237`
- 问题：迁移在一个事务里把 7 张表 `CREATE TABLE ..._keep AS SELECT *` 后删除重建，没有磁盘余量检查；`decision_ledger` 在生产上可能较大。
- 证据：

```sql
CREATE TABLE decision_ledger_keep AS SELECT * FROM decision_ledger;
CREATE TABLE source_insights_keep AS SELECT * FROM source_insights;
...
DROP TABLE decision_ledger_keep;
```

- 建议：这不是本轮格式提交引入的；ADR 0211 已写明迁移不可逆、回退依赖迁移前快照，且 0069 有同样先例。若要更稳，发布前按库大小预留磁盘空间，或给迁移加 headroom 检查。
- 性质：复制行为和不可逆性已读代码证实；“大库可能耗尽磁盘”是推测，取决于生产数据量。

## 读代码证实的 / 推测的

**读代码证实：**

1. `bff30232` 的差异只有上述一处分行变化，语义等价。
2. 新值 `rule_review` 的消费者均已同步：
   - `packages/application/src/ports/decision-ledger.ts:36`、`:49`
   - `packages/calibration/src/index.ts:25`
   - `packages/gateway-contracts/src/contracts-v2.ts:537`、`:767`、`:1023`
   - `packages/persistence-sqlite/src/data-export/schemas.ts:197`
   - `packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql:24`、`:71`
   - 三语 i18n、`production-decision-chain.ts:97`、`decision-chain-drawer.tsx:138`、`proactive-reminders.tsx:343`
3. 新状态 `needs_review` 的消费端：
   - `packages/application/src/rules/rule-book.ts:9-11` 的 `ruleIsEnforced`
   - `packages/application/src/rules/rule-judge.ts:32`
   - `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:233` 的 `status IN ('active', 'needs_review')`
4. 更新触发器写入的时间取自 `NEW.updated_at`，该值在 `packages/persistence-sqlite/src/sqlite-memory-operations.ts:600` 有 `validIsoTimestamp` 校验；删除触发器用 `strftime('%Y-%m-%dT%H:%M:%fZ','now')`，是 24 字符 UTC 毫秒格式。
5. 迁移测试会比对重建前后 7 张表的行、索引和触发器名称；`rule-book-migration.contract.test.ts` 还检查历史表的更新/删除不可变性。

**推测 / 未核实：**

1. 我没有运行测试（工具限制只允许读文件和指定 git 命令），所以“反向用例真的会失败”是按断言内容推断，不是执行结果。
2. 第 3 轮复核记录的具体判定内容未核实：相关文件不在 sparse checkout 中，`git show` 对 `.agents/reviews` 路径被拒绝。
3. 生产数据库大小未知，迁移复制 7 张表是否会造成磁盘压力无法从代码确定。

## 侧重检查

- **错误路径**：更新触发器只在 `OLD.category = 'rule'` 且规则为 `active` 时动作；已待重审的规则不会重复写历史或决策记录，有专门用例覆盖。删除触发器仅在 Agent 和 Owner 仍存在时动作，避免级联删除被阻断；删除 Agent/Owner 的用例也覆盖了。
- **不合规范或不可信输入**：记忆更新时间在持久层有 `validIsoTimestamp` 校验；迁移触发器写入的 `inputs` 用 `json_object` 生成，长度受 `rule_id` 64、`memory id` 等既有约束限制；决策记录的 `id` 由 `randomblob(12)` 生成，长度在 1..128 内。
- **安全**：没有引入秘密、密钥或外部输入拼接；触发器写入的是规则编号和记忆编号，不写正文；随机 ID 不可预测。
- **资源耗尽**：唯一值得留意的是 0087 一次性复制多张表，见“观察 2”；未发现新增长期循环或无限写入路径。
- **不可撤销操作**：迁移 0087 不可逆，ADR 0211 已写明回退要从迁移前快照恢复；代码中没有自动回滚机制，符合现有迁移模式。
- **规则文件、说明文档与代码一致性**：ADR 0211、`docs/agent-rulebook-inventory.md`、决策记录约定与代码一致：待重审规则照常执行、记忆改动触发标记、删除触发器用数据库当前时间、决策抽屉显示“待重审的规则”、三语界面均列出 `rule_review`。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本 PR 没有改系统提示、工具定义、历史消息、遮盖逻辑或提示词目录；改动集中在规则执行判断、SQLite 表/触发器、决策记录契约、控制中心展示和测试。`rule-judge.ts:32` 改变的是“是否执行某条硬规则”，不是发给模型的字节。仍符合 `.claude/rules/prompt-prefix.md` 的“只追加、变化值只在最后一条消息”要求。

2. **同一段文字会不会在不同请求里变成不同字节？**
   模型请求不会。新增的唯一非确定性是决策记录 `id` 的 `randomblob(12)` 和删除触发器的 `strftime('now')`，它们只落在 `decision_ledger` 的审计/展示数据里，不进入模型请求。没有新增依赖前后文的遮盖、带时间的提示字段或无序集合进入提示词。

3. **有没有对应自动检查，反向用例是否真的会失败？**
   本轮格式提交由 `npm run format:check`（biome，`lineWidth: 100`）覆盖，没有行为变化，不需要反向用例。功能部分有：迁移测试、触发器集成测试、`calibration-group-copy` 遍历所有 `DECISION_KINDS`/`CALIBRATION_GROUPS`、`decision-ledger-migration` 验证 `rule_review` 可用且其他 outcome 被拒。按断言看，删掉触发器条件或 i18n 分支会失败；但我没有实际运行测试，这一点是读代码推断。

4. **改动产生或修改的每个值，每个使用它的地方都能接受吗？**
   已逐个核对：`rule_review` 同时存在于应用层 `DECISION_KINDS`/`DECISION_OUTCOMES`、校准组、网关三处枚举、导出模式、SQLite CHECK 和迁移触发器；`needs_review` 同时被 `ruleIsEnforced`、读设置 SQL 和规则历史 CHECK 接受；`source_memory_id`、`change_reason` 只由迁移和触发器写入，当前没有其他生产代码读取或校验它们。`MAIN_CALIBRATION_GROUPS` 不包含 `rule_review`，但它是周报主组展示的子集，不是校验白名单，其他组会走“其他组”渲染，因此不构成两端不一致。
