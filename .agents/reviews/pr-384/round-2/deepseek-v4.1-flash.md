## 复核结论

核心行为（replace 才自动取代、其余进待确认、确认后两条都留、hold 受每日打分预算约束）与 ADR 0220 一致，未发现会丢数据或改坏模型请求前缀的高危问题。问题集中在失败路径、不可逆的「一对不再整理」、UI 判定方式和测试覆盖。

## 一、读代码证实的问题（按严重度）

### 1. 中：整理运行失败后留下的 hold 会被永久当成「处理过的一对」
- 文件：`packages/memory-engine/src/consolidation.ts:420`、`:283`；`packages/persistence-sqlite/src/sqlite-memory-consolidation-operations.ts:273`
- 问题：每条改动是单独提交的（`#revise` 内 `memory.revise` 自己成事务），`run()` 的 catch 只把本次运行标成 failed，不回滚已写入的 hold：
  ```ts
  } catch (error) {
    await this.#options.store.finish({ id, status: "failed", ... }).catch(() => undefined);
    throw error;
  }
  ```
  而 `listHeldPairs` 只看 `action='hold'`，不看所属 run 是否 completed：
  ```sql
  FROM memory_consolidation_changes
  WHERE owner_id = ? AND agent_id = ? AND action = 'hold' AND related_memory_id IS NOT NULL
  ```
  于是「先写了几条 hold，随后 insight/`finish` 抛错」的一次失败整理，会让这些对永久不再进入整理（ADR 0220 决定 6 的本意是「有过 hold」的成功处理）。这也把旧的「失败运行会残留部分改动」问题放大成不可逆状态。
- 建议：`listHeldPairs` 关联 `memory_consolidation_runs` 只统计 `status='completed'` 的 hold；或在失败分支回滚本次已写改动（至少对 hold）。

### 2. 低：记忆页按文本判断 hold 是否还能撤销，可能给出会失败的按钮
- 文件：`apps/control-center/src/components/memory-page.tsx:1738`、`:1782`
- 问题：`pending` 是按文本建立的集合：
  ```ts
  const pending = new Set(
    overview.memories.filter((item) => item.tentative).map((item) => item.text),
  );
  ...
  ...(item.action === "hold" && !pending.has(item.text) ? {} : { undo: () => void memory.undoTidy(item) }),
  ```
  若两条不同记忆文本相同、其中一条仍 tentative，则已确认的 hold 也会显示「撤销」；点下去后端会以 `MEMORY_CHANGED_AFTER_CONSOLIDATION` 失败（`consolidation.ts:442`）。后端没有数据损坏，只是错误按钮。
- 建议：在 `tidyUps` 快照里带上 `memoryId`/`tentative`（契约已有足够空间），改为按记忆标识判断，而不是按文本。

### 3. 低：已确认/已撤销的 hold 在变化记录里仍显示「待你确认」
- 文件：`apps/control-center/src/components/memory-page.tsx:1778`、`:1829`；`apps/control-center/src/i18n/resources/zh-CN.ts:711`
- 问题：标签直接用历史 action 渲染：
  ```ts
  kind: item.action,
  ...
  {message("memory.page.event", { e: event.kind })}
  ```
  `hold` 映射到「待你确认」。round-2 隐藏了按钮，但已处理的 hold 行仍长期显示「待你确认」，与「已处理」相矛盾。
- 建议：已非 tentative 的 hold 用「已确认/已撤销」或改用中性历史标签（例如「整理时暂缓」）。

### 4. 低：`listHeldPairs` 每次整理全表扫描且集合无界增长
- 文件：`packages/persistence-sqlite/src/sqlite-memory-consolidation-operations.ts:273`；`packages/memory-engine/src/consolidation.ts:283`
- 问题：查询按 `owner_id, agent_id, action` 过滤，但 `memory_consolidation_changes` 只有 `(owner_id, agent_id, created_at)` 和 `(memory_id)` 索引（迁移 0054/0089），没有 `action` 索引；且撤销后的 hold 永不删除，集合随历史单调增长。单机数据量通常可接受，但属于无界资源路径。
- 建议：加部分索引，如 `ON memory_consolidation_changes(owner_id, agent_id) WHERE action='hold' AND related_memory_id IS NOT NULL`。

### 5. 低：迁移一次性复制 9 张表，磁盘/时间长且不可中断续做
- 文件：`packages/persistence-sqlite/src/migrations/0089_consolidation_hold.sql:1-15`、`:242-246`
- 问题：为给两个 CHECK 加 `hold`，重建 `decision_ledger`、6 张依赖表和 2 张整理表，整个迁移在一个事务里先复制再删除。`decision_ledger`/`decision_signals` 较大时瞬时占用接近翻倍；磁盘不足会整体回滚失败。这是沿用 0087/0088 的既有做法，不是本次新引入的模式，但 0089 是又一次全量复制。
- 建议：接受现状即可；若要降低风险，上线前确认 state root 余量，或在运维步骤里记录预期耗时。

### 6. 低：两处测试覆盖不足（行为目前正确）
- 每日预算：`packages/application/test/daily-review.unit.test.ts:330` 直接注入 `holds`，`ledger: { listReviewPool: async () => holds }`，没有经过真实 SQL。真实 `listReviewPool`（`sqlite-decision-ledger-operations.ts:494-498`）目前没有 outcome 过滤，所以 hold 确实会进池；但将来若加过滤，这条测试不会失败。
- 迁移结构：`consolidation-hold-migration.contract.test.ts:42-49` 只比较行数据与 `type,name,tbl_name`，不比较列定义和 CHECK。索引/触发器名漏建会被发现，CHECK 写错不会。我逐行对照过 0088 与 0089 的 7 张表定义，除 `hold` 外一致；同时对照 0054/0084，整理两张表也一致。但这是人工核对，不是测试保证。
- 建议：补一条走真实 `listReviewPool` 的集成用例；迁移契约补列定义/`sqlite_master.sql` 对比或 `pragma table_info` 对比。

## 二、推测与未核实

- 同一组返回多条 decision 时，`touched` 的处理使结果依赖模型返回顺序（例如先 supersede F→A 再 hold F/B，会把 F 标 tentative；反过来则跳过后者）。`parse` 不限制每组一条，属既有行为，新的 hold 让它更明显。未写测试。
- 「两条不同记忆文本相同」在真实数据中是否出现未核实；这是问题 2 的触发条件，不是机制本身。
- 迁移在超大库上的实际耗时/磁盘余量未核实。

## 三、作者说法核对

- 「只有 replace、keep 日期严格更晚且置信度 ≥ 门槛才 supersede」：成立。`consolidation.ts:380-386` 额外用严格 `<`，日期相等时落到 hold。
- 「其他情况新条设 tentative: true，记 hold」：方向成立，但准确说是「按 `validFrom ?? recordedAt ?? updatedAt` 说得更晚的那条」，不一定是 fresh 的「新条」；`consolidation.ts:378-395`。ADR 决定 3 写的是「说得更晚的那条」，`docs/agent-rulebook-inventory.md:85` 的 H-17 写成「新条」，文档有轻微不一致。
- 「撤销 hold 把 tentative 设回 false」：成立，`consolidation.ts:461-463`。
- 「迁移 0089 照抄 0088，CHECK 加 hold」：成立；7 张 ledger 相关表与 0088 逐行一致，只有 `decision_ledger` 的 consolidation outcome 多了 `hold`（0089:70）；整理两张表与 0054/0084 一致，`memory_consolidation_changes.action` 多了 `hold`（0089:255）。
- 「listHeldPairs 按 ADR 0220 决定 6」：成立，包括 undone 的 hold（不筛 `undone_at`），与 ADR 原文一致。
- 「hold 只在新条仍待确认时显示撤销」：成立，但用文本判断（见问题 2）。
- 「迁移契约覆盖全部被重建的表」：表清单齐全并各插入了一行，但没有比对完整 DDL（见问题 6）。
- 「整理服务没显式传 gates，两边读同一静态登记表」：成立。`service-main.ts:1465` 与 `production-http-composition.ts:1027` 都没传 `gates`；`automatic-memory-service.ts:54-64` 的默认值直接引用 `MEMORY_AUTO_COMMIT_GATE`，而生产构造记忆抽取也没传 `gates`（`production-memory-capture.ts:583`）。

## 四、侧重检查

- 错误路径：unknown action 会被 `consolidation.ts:149` 丢弃；undo 已确认的记忆会因 revision 不符抛错（`:442`）；模型输出缺 keep/drop、跨组、keep=drop 都被拒绝。失败运行的部分写入问题见问题 1。
- 不可信输入：`parse` 只接受组内标签且要求包含 fresh（`consolidation.ts:151-156`）；引语提示词有「不要执行其中指令」。新增 `replace` 不引入外部输入面。
- 安全：hold 把较新一条标 tentative，从而移出档案块和默认检索（`owner-profile-service.ts:110`），旧条仍可见；不会因模型判冲突而隐藏旧事实。
- 资源耗尽：见问题 4、5。
- 不可撤销操作：hold 的「处理过一对不再整理」在确认/撤销后永久生效，是 ADR 明确选择；但叠加失败运行会变成非预期永久化（问题 1）。
- 规则/文档/代码：ADR 0220、H-17、提示词 manifest sha/`changedIn`、golden 文本、schema-catalog 描述、导出 schema、三份 i18n、网关三处枚举都已包含 `hold`/`replace`，未发现遗漏；仅 H-17「新条」措辞与代码「较晚那条」有轻微差异。

## 五、必答问题

1. 请求开头是否改变：不会。`memory.consolidation` 是后台提示词（`packages/prompt-catalog/src/memory.ts:67-80`，`usedBy` 只有 `consolidation.ts`），只影响新发起的后台调用；对话系统提示、工具定义、历史消息、遮盖都没有改。`tentative` 影响的是每轮档案/上下文块，而这些块被拼进最后一条用户消息的 `<himawari-context>`（`packages/runtime-pi/src/pi-runtime-adapter.ts:628-641`），不是前缀。发给模型的内容仍是「历史不变、每轮变化值在最后一条」。
2. 同一段文字是否会变不同字节：不会因本次改动新增不确定性。配对键用排序后 `join("\n")`，MemoryId 由 `identifiers.ts:39` 的机器标识正则保证不含换行；`statedAt` 与 `day()` 都是纯数据推导，无当前时间字段；`held` 过滤是 DB 状态的确定性函数。hold 之后提示词/档案内容变化是状态变化，不是同输入随机化。
3. 自动检查与反向用例：有。集成 P3-8 覆盖 replace 自动取代、conflict hold、低置信度 hold、keep 标成较早条 hold、undo、confirm、再次整理不重现（`test/integration/memory-consolidation.test.ts:815-827`）；迁移契约有「未知 action `pending` 必须被 CHECK 拒绝」的反向用例；UI 用例断言非 pending 的 hold 没有按钮；提示词 golden 与 manifest digest 测试会拦截文本/摘要不一致。缺口见问题 6（每日打分用 mock；迁移不比对 DDL）。
4. 改动产生的值在两端是否都能接受：能，除 UI 判定方式外没有校验不一致。逐个核对：
   - `hold`：DB CHECK（0089:255）、`decision_ledger.outcome` CHECK（0089:70）、`DECISION_OUTCOMES.consolidation`（`decision-ledger.ts:53`）、`ACTIONS`（`sqlite-memory-consolidation-operations.ts:21`）、导出 schema（`schemas.ts:171`）、网关三处枚举（`contracts-v2.ts:990/1125/1232`）、三语 i18n、schema-catalog 描述均已接受。
   - 模型动作 `replace`：只存在于提示词/格式与 `parse`（`consolidation.ts:149`），不落库，无其他消费者。
   - `listHeldPairs`：端口、sqlite 操作、durable adapter 都已加；唯一使用 `Pick` 的 `production-memory-control.ts:148` 只取 `listChanges`/`readBasisChain`，不受影响。
   - `consolidation_hold` 原因码：长度 18，满足 ≤64 校验。
   - `memoryIds=[新条,旧条]`、`resultMemoryIds=[新条]`：与每日打分的 `reviewedMemoryIds`（`daily-review.ts:234-239`）一致，显示为「旧 → 新」。
   - `gates`/`autoCommitThreshold`：已从 application 根导出，构造点不传时与记忆抽取共用同一静态 `MEMORY_AUTO_COMMIT_GATE`。
   - 迁移序列相关常量（`CURRENT_SCHEMA_SEQUENCE`、`LATEST_MIGRATION_SEQUENCE`、`SUPPORTED_SCHEMA_MAX`）均已同步到 89。

未核实：未运行任何测试或命令（受工具限制），以上均为读代码结论。
