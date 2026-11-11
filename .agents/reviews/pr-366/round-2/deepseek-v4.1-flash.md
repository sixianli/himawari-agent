## 侧重检查

我按你点名的路径逐项读了代码，结论如下：

- **先删记忆、再删 Agent/Owner**：删除记忆由 `0087_rule_book_memory_link.sql:363-402` 的 `BEFORE DELETE` 触发器处理；之后删 Agent/Owner 时，`rule_book_history_no_delete` 的 `EXISTS agents/owners` 守卫会放行（`0087:296-299`），现有契约测试 `rule-memory-review.contract.test.ts:388-408` 覆盖了这个顺序。
- **直接删 Agent/Owner、连带级联删记忆**：删除触发器用 `EXISTS agents` + `EXISTS owners` 守住（`0087:365-366`），级联时父行已不在，不会写规则历史/决策记录；`rule-memory-review.contract.test.ts:410-432` 验证了删除不被阻塞、最终无残留。
- **记忆被“先改后删”**：UPDATE 触发器和 DELETE 触发器都只处理 `status='active'` 的规则（`0087:307-310`、`367-371`），不会重复标记。但 DELETE 路径的“已经是 `needs_review` 不重复”没有反向用例（见下面问题 1）。
- **输入/安全**：触发器里的 `rule_id`、`memory_id` 都在数据库内；`inputs` 用 `json_object/json_array` 构造，没有字符串拼接注入；`rule_review` 的 `id` 是 `'rule-review:' + lower(hex(randomblob(12)))`，长度 36，满足 `decision_ledger.id` 的 1–128 限制。
- **资源耗尽**：一次记忆删除最多按“指向它的 active 规则数”写历史/决策，数量受规则手册规模约束；`rule_book_rules` 有 `source_memory_id` 索引（`0087:251-252`），不会每行全表扫描。
- **不可逆操作**：迁移 0087 重建 `decision_ledger` 和六张子表，不可逆；ADR 0211 已写明要从迁移前快照恢复，代码没有新增用户侧不可撤销操作。
- **文档一致性**：ADR 0211、ADR 0143、决策记录写法约定、schema-catalog、三语文案基本一致；唯一明显遗漏是 `rule_review` 的 `ruleIds` 在“依据”抽屉里不展示（见问题 3）。

## 发现（按严重度）

### 低 1：DELETE 触发器的“已 `needs_review` 不重复标记”没有反向用例

- **文件:行**：`packages/persistence-sqlite/test/rule-memory-review.contract.test.ts:359-386`
- **问题**：新增的永久删除测试只覆盖“规则原本 active”的路径；“规则已经是 `needs_review` 时再永久删除记忆不应再写一条历史/决策”这一条只被 UPDATE 路径的 `once` 用例覆盖（同文件 `:329-357`），DELETE 路径没有。
- **证据**：
  - 删除测试只执行一次删除并断言 `revision: 2`：
    ```ts
    // :370-374
    database.prepare("DELETE FROM memory_records WHERE id = 'm-rule'").run();
    expect(rule(database, "r-edit")).toMatchObject({
      revision: 2,
      status: "needs_review",
      memoryId: "m-rule",
    });
    ```
  - `once` 用例走的是 UPDATE：
    ```ts
    // :333-342
    "UPDATE memory_records SET status = 'trashed', revision = 2, updated_at = ? WHERE id = 'm-rule'",
    "UPDATE memory_records SET content_ref = 'payload-b', revision = 3, updated_at = ? WHERE id = 'm-rule'",
    ```
  - 触发器本身有 `status = 'active'` 过滤：
    ```sql
    -- 0087:367-371
    AND EXISTS (
      SELECT 1 FROM rule_book_rules
      WHERE source_memory_id = OLD.id AND owner_id = OLD.owner_id AND agent_id = OLD.agent_id
        AND status = 'active'
    )
    ```
- **影响**：如果把 DELETE 触发器里的 `AND status = 'active'` 删掉，现有测试仍会通过；之后会出现重复历史、重复决策记录，甚至规则 revision 继续增加。
- **建议**：增加一条：先用 UPDATE 把规则标成 `needs_review`（revision 2），再 `DELETE FROM memory_records`，断言 revision 仍为 2、`rule_review` 决策仍只有 1 条、历史只有 2 行。

### 低 2：`rule_review` 的 `ruleIds` 在“依据”抽屉里不可见

- **文件:行**：`apps/agent-service/src/production-decision-chain.ts:96-115`
- **问题**：触发器把待重审的规则写进了 `decision_ledger.inputs.ruleIds` 和 `subject_ref`，但 `production-decision-chain` 只在 `kind === "proactive"` 时把 `inputs.ruleIds` 映射成 `rules.items`；`rule_review` 会得到 `rules: { state: "not_applicable", items: [] }`。
- **证据**：
  ```ts
  // :96
  const proactive = entry.kind === "proactive";
  // :102-115
  const rules: ChainPayload["rules"] = proactive
    ? {
        state: sectionState(fields, "ruleIds", inputs.ruleIds),
        items: sortedUnique(inputs.ruleIds).map((ruleId) => { ... }),
      }
    : { state: "not_applicable", items: [] };
  ```
  触发器写入：
  ```sql
  -- 0087:386-395
  json_object('memoryIds', json_array(OLD.id), 'ruleIds', json_array(rule_id),
    'batchId', NULL, 'resultMemoryIds', json_array())
  ```
- **影响**：决策记录里明明有规则编号，但用户在“依据”抽屉里看不到是哪条硬规则待重审；这不是 schema 拒绝，而是消费端忽略了这个值。
- **建议**：让 `rule_review` 也把 `inputs.ruleIds` 渲染到 `rules` 区域，或至少在抽屉里显示 `subject_ref` 并链接到后续的规则页；加一条决策链界面测试。

### 低 3：删除触发器用数据库 `'now'`，与 UPDATE 触发器用 `NEW.updated_at` 不一致

- **文件:行**：`packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql:380,389,399`
- **问题**：同一条规则因记忆变更而标待重审时，UPDATE 路径的 `changed_at`、`checked_at`、`updated_at` 用应用写进 `memory_records.updated_at` 的时间（`NEW.updated_at`，`:331,340,358`）；DELETE 路径改用 SQLite 的实时 `'now'`。两条路径的时间来源不同。
- **证据**：
  ```sql
  -- UPDATE 路径
  NEW.updated_at
  -- DELETE 路径
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ```
- **影响**：不影响模型请求，也不影响 SQL 对时间格式的校验（格式仍然是 24 字符 UTC）；但测试无法用固定时钟断言删除路径时间，且如果数据库时钟与应用注入时钟偏差，历史和周报窗口会按不同时间判断。
- **建议**：如果业务上“删除时间就是现在”是刻意设计，建议在 ADR 里写明；否则优先使用 `OLD.updated_at`（或由删除事务显式传入统一时间）。并补一条时间断言。

### 低 4：周报文案反向检查只覆盖了 `weekly.group` / `weekly.groupInfo`

- **文件:行**：`test/integration/calibration-group-copy.test.ts:14-21`
- **问题**：本轮实际修改了三种按 `kind` 分支的文案：`weekly.group`、`weekly.check.rowsMissing`（`en.ts:1318`）、`decision.chain.kind`（`en.ts:1045`）。新测试只检查 `weekly.group` 和 `weekly.groupInfo`，后两者缺少对应的“每个分组都有显式分支”反向检查。
- **证据**：
  ```ts
  // calibration-group-copy.test.ts:15-20
  const select = messages["weekly.group"];
  for (const group of CALIBRATION_GROUPS) {
    if (group === "external_read") continue;
    expect(select, group).toContain(` ${group} {`);
  }
  expect(messages["weekly.groupInfo"]).toContain(" rule_review {");
  ```
- **影响**：以后若在 `weekly.check.rowsMissing` 或 `decision.chain.kind` 里漏掉某个分支，测试不会失败。
- **建议**：把检查参数化到所有按 `kind`/`g` 分支的文案键，至少加入 `weekly.check.rowsMissing` 和 `decision.chain.kind`。

## 作者说法核对

- “永久删除绕过标记” → 已用 `BEFORE DELETE` 触发器补上；代码确认 `0087:363-402`，测试确认 `rule-memory-review.contract.test.ts:359-386`。
- “ADR 写明只有改了值才清除，原样保存不算” → `writeRule` 在参数相同的时候提前返回（`sqlite-proactive-operations.ts:341`），ADR 0211 也写明了；集成测试覆盖了“只改开关、规则仍待重审”（`rule-memory-review.test.ts:310-334`）。
- “周报三语补 `rule_review`” → 文案确实补了；但自动检查只覆盖 `weekly.group`/`weekly.groupInfo`（见问题 4）。
- “每日评分卡片加标签和说明” → `proactive-reminders.tsx:343-344,353` 已加，单测 `proactive-interactions.unit.test.ts:595-603` 覆盖。
- “迁移测试补子表数据、schema-catalog、写法规约、ADR 0143” → `dumpLedgerTables` 和 seed 数据已补（`rule-memory-review.contract.test.ts:24-48,75-130`），文档也已更新。
- “SQLite 工作线程不能导入应用层常量” → 代码确实有两处状态清单：`rule-book.ts:8-10` 的 `ruleIsEnforced` 和 `sqlite-proactive-operations.ts:232-234` 的 `status IN ('active','needs_review')`；作者说法与代码一致，但这是两份规则，只能靠测试保证一致。
- “不改发给模型的任何内容” → 本轮改动集中在 SQL、数据库触发器、契约、校准、导出、UI 文案和测试；没有改提示词目录或请求组装代码。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。这个改动没有修改系统提示、工具定义、历史消息或提示词目录；规则状态变化只落在 `rule_book_rules`，`readSettings` 只是把 `needs_review` 也读出来，随后 `ruleBookFor` 仍然把规则构造成 `status: "active"`（`rule-book.ts:269-277`），实际执行行为对现有规则不变。模型请求仍然只在末尾追加，没有新增每轮变化的值进入请求头。**未运行 `check:prompt-prefix`**（工具限制），这是基于代码阅读的结论。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   不会影响模型请求。新触发器确实会产生不确定值：`randomblob(12)` 生成的决策 id、数据库 `'now'` 生成的时间；但它们只写进 `decision_ledger` / `rule_book_history`，不进入模型输入。若以后把这些字段注入提示词，就会违反确定性要求；当前没有这样的路径。

3. **有没有对应的自动检查，反向用例真的会失败？**
   有：
   - `check:rule-registry` 包含 `rule-registry.unit.test.ts`，覆盖 `needs_review` 仍然执行、`retired` 不执行（`:181-189`）。
   - `decision-ledger-migration.contract.test.ts` 覆盖 `rule_review`/`needs_review` 的 CHECK 约束（`:161-163`）。
   - `rule-memory-review.contract.test.ts` 覆盖 UPDATE 触发器、迁移保数据、DELETE 触发器、Agent/Owner 级联。
   - `test/integration/rule-memory-review.test.ts` 覆盖经服务的修改、归档、删除、取代和“设置页原样保存不清除”。
   - `proactive-interactions.unit.test.ts` 覆盖界面标签和说明句。
   - `calibration-group-copy.test.ts` 覆盖三语 `weekly.group`/`weekly.groupInfo` 的 `rule_review` 分支。
   反向用例里，改记忆/归档/取代/删除、非规则记忆、未关联规则、已待重审不重复、原样保存不清除都有覆盖；但 DELETE 路径的“已待重审不重复”没有反向用例（问题 1），其他按 `kind` 分支的文案也没有反向用例（问题 4）。另外，这些新测试属于 `contracts` / `integration` / `browser` 项目，`npm run check` 的 `check:steps` 并没有直接列出它们；如果只跑 `npm run check`，只有 `check:rule-registry` 等少数检查会覆盖本轮逻辑。是否在 CI 里另跑 `npm test`，未核实。

4. **每个新值的使用端都能接受吗？**
   逐个核对如下：
   - `rule_review` kind + `needs_review` outcome：SQL CHECK 已允许（`0087:21-25,64-74`）；`DECISION_KINDS` / `DECISION_OUTCOMES` 已加（`decision-ledger.ts:29-50`）；`validateLedgerWrite` 会接受（`sqlite-decision-ledger-operations.ts:49-95`）；数据导出 schema 已加（`data-export/schemas.ts:190-198`）；gateway 的 review、calibration、decision-chain 三个枚举已加（`contracts-v2.ts:530-537,757-767,1016-1024`）；校准分组、标签、评级已加（`calibration/src/index.ts:15-76`）；三语文案和 message-ids 已加。**接受。**
   - `needs_review` 规则状态：`rule_book_rules` / `rule_book_history` 的 CHECK 已加（`0087:245,262`）；`readSettings` 的 SQL 已加（`sqlite-proactive-operations.ts:232-234`）；`RuleStatus` / `ruleIsEnforced` 已加（`rule-book.ts:6-10`）；`writeRule` 重新保存时会把状态写回 `active`（`:345-352`）。**接受。**
   - `source_memory_id`：规则表和历史表新增列；触发器读取并回写历史，`writeRule` 的 upsert 不覆盖它，因此改设置后链接保留；无外键，删除记忆后保留悬空编号是设计选择。**接受，但这是有意不做 FK 的。**
   - 触发器直接写 `decision_ledger` 绕过了 `insertLedgerRow`，但我对照了两端：id 长度、reason_code、subject_ref、inputs 的四个键、cost/duration、outcome 都满足表约束和 `validateLedgerWrite` 的同类规则。**接受。**
   - `rule_review` 的 `ruleIds`：数据库/契约接受；唯一不消费它的使用端是决策链抽屉（问题 2）。**接受但展示缺失。**
   - `change_reason`：`memory_removed` / `memory_edited` / `memory_superseded` / `memory_reclassified` 均不超过历史列 1–64 的限制；没有界面消费端。**接受。**
   - 迁移序号 87：`migration-engine.ts:683-688`、迁移引擎测试、`workspace-lifecycle-audit.mjs` 的 `SUPPORTED_SCHEMA_MAX` 都已更新。**接受。**

## 总结

未发现高或中严重度缺陷。`needs_review` 照常执行、硬删除触发器、级联守卫、迁移保留数据和三语 UI 分支这几条主要诉求在代码上是闭合的；需要补的主要是 DELETE 路径“已待重审不重复”的反向测试，以及 `rule_review` 的规则编号在决策链里的展示。
