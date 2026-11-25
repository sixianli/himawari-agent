---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-11"
covers: "apps/control-center/test/proactive-interactions.unit.test.ts, packages/application/src/services/daily-review.ts, packages/application/test/daily-review.unit.test.ts, packages/memory-engine/src/consolidation.ts, packages/persistence-sqlite/test/memory-checkup-migration.contract.test.ts, packages/platform-node/src/strict-configuration.ts, test/integration/memory-checkup.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0218：每周记忆体检放进每天打分，确认、删除、合并都能撤销，并且共用每天的名额

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [和 P3-8 的分工](#p3-8)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

任务块 P4-6（Andy 2026-10-31 写，2026-11-11 同意变更清单）。记忆库里会积累四类可疑的记忆：互相矛盾的两条、很久没用过的、系统把握不大的、来源原话已经找不到的。块里要求每周把这四类列出来，给“确认 / 删除 / 合并”三个按钮，复用「每天打分」页，不另开一页；三种操作都要能撤销；一次处理受每天打分的预算约束。依据产品愿景里“记忆可靠性”优先于“主动性与效率”：可疑的记忆要让主人看见、能改，改错了能退回。

动手前对着代码核对的现状（main aa1b0b0）：

- 每天打分的名额是 `reviewCapacity(预算秒数, 每条秒数)`（`packages/application/src/services/daily-review.ts`），缺省 120 秒、每条 5 秒，即每天 24 条（`packages/platform-node/src/strict-configuration.ts` 的 `reviewBudgetSeconds`、`reviewSecondsPerItem`）。服务端原来只用名额限制“显示几条”，打分命令本身不查名额。
- 记忆被检索用到时更新 `last_used_at`（`sqlite-memory-operations.ts` 的 `markUsed`）。
- 自动存入的门槛是置信度 850，低于它的存成「待确认」（`automatic-memory-service.ts`）。
- “来源已不可查”的判断来自 [ADR 0186](0186-memory-jumps-to-the-owners-original-message.md)，原来只写在网页的 `memory-source.ts` 里。
- 整理记忆判成冲突时直接作废旧条（`packages/memory-engine/src/consolidation.ts`），所以库里没有“等人处理的矛盾对”。

<a id="decision"></a>

## 决定

1. **周清单**：每周第一次读每天打分时，按主人的时区从周一 0 点算起生成本周清单，存进新表 `memory_checkup_items`，同一周内不变。四类的定义（只看使用中、没被取代的记忆）：
   - 两条说法不一样（`conflict`）：P3-8 留下的“待确认的新条 + 照常生效的旧条”（见下一节）。
   - N 天没用过（`unused`）：最后一次被用到的时间早于 N 天前；从没被用到的按记录时间算，没有记录时间的按最后修改时间算。N 是配置项 `runPolicy.proactive.reviewMemoryUnusedDays`（7 到 3650，缺省 90），网页上的标签直接显示这个数。
   - 系统把握不大（`low_confidence`）：置信度低于这条记忆所属类别的自动存入门槛（复用 `autoCommitThreshold`，和自动存入、整理时判冲突用同一套按类别的门槛）。
   - 来源已不可查（`source_unavailable`）：和记忆页同一个函数 `memorySourceState`（含“外部提议”一类，挪到 `@himawari-agent/gateway-contracts`，网页和服务端共用一份）判成 `unavailable` 的；来源引用按记忆页同样的长度上限（`MEMORY_SOURCE_REF_MAX_LENGTH`）过滤后再判。
2. **挑选顺序和条数**：四类轮流各取一条，一条记忆只出现一次（矛盾对的两条都算出现过）。每周最多放“每天打分的名额”那么多条（缺省 24 条，约 2 分钟）。本周一条都没挑出来时，服务进程记住这一周，不再每次读都重新扫描。过去 12 周里主人点过“没问题”的记忆不再因为非矛盾的原因进清单；撤销过的不算。
3. **放在哪**：周清单的每一条是每天打分抽样里的一个新组 `memory_checkup`，和其他组轮流抽样、共用同一个名额。网页按服务端给的顺序把体检条目和要打分的条目放在同一个列表里分页（每页 6 条，整个区域不超过一屏，`npm run check:layout` 检查），体检条目带原因标签和自己的按钮，“这一页都没问题”只给这一页要打分的条目打分；不另开页面，不显示统计面板。
4. **三种操作**（网关命令 `proactive.review.checkup`）：
   - 确认：待确认的记忆转正；其他记忆只记下“看过、没问题”，不改记忆本身。撤销：转正的改回待确认。
   - 删除：移到回收站。撤销：从回收站恢复。
   - 合并（只对矛盾对）：主人选留哪条，另一条归档并标“被它取代”，留下的若是待确认就同时转正。不改文字、不调模型。撤销：归档的那条恢复成原来的状态和“被谁取代”，留下的那条恢复待确认。
   - 处理前的状态存在同一行（`before_state`），撤销按它还原；撤销后这一条回到未处理，可以重新选。
   - 先占行、后改记忆：先用 `action IS NULL` 条件把这一行改成已处理并写下 `before_state`，成功了才改记忆；同时点两次只有一次能占到。改记忆出错时按撤销的办法退回并清掉占位，再把错误报出去；退回也出错时报 `MEMORY_CHECKUP_RESTORE_FAILED`（冲突），不再报原来的错误，这一行保持已处理，主人可以点“撤销”接着退回。占行后进程崩溃也是这样：这一行显示已处理，点“撤销”回到未处理。
   - 撤销只退回“还是本次处理后样子”的部分：删除的那条还在回收站才恢复，归档的那条还是“被留下那条取代”才恢复，转正的那条还是使用中且已转正才改回待确认（合并时留下的那条单独判断，不看归档的那条是否已恢复）；已被别处改过的部分不动，这一行照样回到未处理。这样撤销中途出错后再点一次能接着做完，不会卡在“已处理但撤销不了”。已知限制：判断只看状态，不看修订号，所以删除后主人在记忆页恢复、又删除，再在体检里点撤销，会恢复后一次删除；按钮写的就是“撤销删除”，结果不丢数据，可以再删。
   - 已知限制：P3-8 撤销 `hold` 要求新条的修订号没变；体检里处理过（包括处理后又撤销）的新条修订号已变，P3-8 那边的撤销会被拒绝（`MEMORY_CHANGED_AFTER_CONSOLIDATION`）。体检本身的撤销不受影响。
   - 本周早些天处理过、没撤销的体检条目，网页每天都继续显示（带“撤销”），不占当天名额，所以隔天也能撤销。
5. **每天的名额**：服务端只接受“今天抽样里显示了的”体检条目的操作，否则拒绝（`PROACTIVE_REVIEW_BUDGET_USED`）；生成本周清单出错时，操作命令直接报这个错误，不误报成名额用完（读页面时出错则记日志、体检组为空）。今天处理过的条目仍占今天的名额，所以一天最多处理名额那么多条；撤销不退还名额。打分命令拒绝体检条目的键；新条已转正的矛盾对不进清单。
  - `packages/application/test/daily-review.unit.test.ts` 的 `[P4-6]` 用例：本周清单里已有的矛盾对，它的 `hold` 决策记录不进“整理记忆”组，没排进清单的照常进；隔天仍显示已处理的体检条目、不占名额；文字按 UTF-16 长度截断。
6. **页面上的数字**：只有“N 天没用过”里的 N，它就是配置值，定义见第 1 条。

<a id="p3-8"></a>

## 和 P3-8 的分工

P3-8 把整理时判成冲突的情况改成“新条待确认、旧条照常、记一条 `hold` 整理改动和决策记录”。本块不另做矛盾检测，只读这些 `hold` 对：`memory_consolidation_changes` 里 `action = 'hold'` 的行，`memory_id` 是新条，`related_memory_id` 是旧条；服务端用 P3-8 的 `listHeldPairs` 带 `openOnly` 读出没撤销过的对（新的在前）；新条已不是待确认的、新条或旧条已不是使用中的都跳过。矛盾对里的两条不再因为其他原因单独进清单，这样第二对以后的新条（本来就是待确认、置信度低）不会被“系统把握不大”先占掉。周清单生成后，新条在别处被确认了，这一对的确认、删除、合并都以 `MEMORY_CHECKUP_STALE` 拒绝。为了不让同一对在打分页出现两次，本周体检清单里已经有的矛盾对，它的 `hold` 决策记录不再进“整理记忆”组（按两条记忆正好是同一对来认，只共享其中一条的另一对照常出现）；清单生成失败或这一对没排进本周清单时，`hold` 决策记录照常出现在“整理记忆”组。

<a id="options"></a>

## 放弃的做法

- **把操作记进决策记录或记忆历史**：两张表的种类都被 CHECK 约束锁死（`0069_decision_ledger.sql`、`0065_memory_history.sql`），加种类要重建表；而且撤销需要处理前的状态，放在体检表里最直接。
- **另开一个“记忆体检”页面或统计面板**：任务块和设计基线都不要。
- **合并时让模型把两条写成一条**：要调模型、要花钱，结果还要再确认；本块只做“留一条、另一条被它取代”。
- **合并时把被归档那条的来源引用并到留下的那条**：现有的 `revise` 只改状态和属性，改来源引用要新写一条存储路径；被取代的那条仍保留在历史里，来源可以从那里查到。
- **数据导出带上体检表**：体检表是一周内的处理状态，和记忆提醒一样不进导出。

<a id="consequences"></a>

## 后果

- 门槛（会自动拦下的测试）：
  - `test/integration/memory-checkup.test.ts`（真实 SQLite，worker 和 direct 两种执行方式）：四类各一条进清单，能跳到原话的、提醒创建的、最近用过且置信度高的都不进；同一周两次读到同一份清单，下一周重新生成；确认、删除、合并落库后撤销都回到原样，合并只接受这一对里的记忆；点过“没问题”的下周不再出现，撤销过的仍出现；每天名额为 3 时第 4 条被拒，撤销后仍被拒，第二天能处理；打分命令拒绝体检条目的键。
  - `packages/persistence-sqlite/test/memory-checkup-migration.contract.test.ts`：同一周同一条记忆只能一行，处理动作、处理时间和处理前状态必须同时有或同时没有，非矛盾的行不能带配对记忆，配对记忆删掉后置空。
  - `apps/control-center/test/proactive-interactions.unit.test.ts` 的 `[P4-6]` 用例：体检组在每天打分区里显示原因、新旧两条、按钮和撤销；“这一页都没问题”不带体检条目。
- 新表的迁移按改表排队放行，用 `0090_memory_checkup.sql`。

<a id="references"></a>

## 关联文档

- [ADR 0186：记忆详情能跳到原话，找不到的显示“来源已不可查”](0186-memory-jumps-to-the-owners-original-message.md)
- [ADR 0182：记录主动提醒的隐式信号](0182-record-proactive-implicit-signals.md)
- [产品愿景](../product-vision.md)

[返回目录](#contents)
