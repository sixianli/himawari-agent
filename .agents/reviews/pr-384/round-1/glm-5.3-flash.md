## 侧重检查：从一条普通使用流程走一遍

流程：主人某天说「我搬家到北区了」→ 记忆抽取存为正式记忆（置信度 ≥850，`automatic-memory-service.ts:203`）→ 次日后台整理任务触发 `MemoryConsolidationService.run()`（`packages/memory-engine/src/consolidation.ts:202`）→ 分组、调模型、解析（`parse`，consolidation.ts:134-183，接受 `replace`）→ 判 `replace` 且条件齐备则 `#supersede` 旧条（consolidation.ts:369-381），否则对较新一条 `#revise(hold)` 加 `tentative: true` 并记 `hold` 变更与决策记录（consolidation.ts:382-388）→ `insertConsolidationWrite` 落库并写 ledger（`sqlite-memory-consolidation-operations.ts:36-112`）→ 记忆页 tidyUps 显示 `hold`（`memory-page.tsx:1770-1781`）→ 「去确认」滚到确认区，tentative 记忆出现在 guesses（memory-page.tsx:651-653）→ `memory.confirm` → `DurableMemoryService.confirm` 只把 `tentative` 置回 false（`durable-memory-service.ts:306-326`），旧条不动。撤走的是 `undo`（consolidation.ts:450-451）。

- 已覆盖：服务+落库+撤销+确认+决策记录（`test/integration/memory-consolidation.test.ts` 两个 P3-8 用例，含 4 种情形：取代、情境差异、低置信度取代、模型把 keep 标成旧条）；每日预算（`daily-review.unit.test.ts` 30 条 hold 只出 10 条）；提示词渲染（golden 文件 + manifest 双向检查）；迁移（`consolidation-hold-migration.contract.test.ts`：数据保全、触发器不可变、外键、接受 hold、拒绝未知 action 的反向用例）。
- 未覆盖（读代码证实）：控制中心 UI 对 `hold` 的渲染无用例（`memory-interactions.unit.test.ts:1099` 的 tidyUps fixture 只有 `merge`；`gateway-v2.fixture.ts:578` 同）；「确认后再次整理」的无测试；`production-http-composition.ts:1027` 那个 `readText: () => undefined` 的整理实例（该实例永远发不出模型请求，与本次改动无关，但意味着这条组合路径上 hold/supersede 逻辑不会被执行）。

## 发现的问题（按严重度）

**1. 中低 | packages/memory-engine/src/consolidation.ts:238-242、250；packages/application/src/services/durable-memory-service.ts:306-326 | 主人的「两条都留」决定不被记住，同一对记忆可以反复进待确认，甚至次日被自动作废**（行为读代码证实，是否算问题属设计判断）
- 证实：整理只把 `tentative !== true` 的记忆列入可审范围（consolidation.ts:250），held 的新条待确认期间不会被再整理；但 `confirm`/`undo` 只是 `revise` 一个属性、revision +1，不产生任何整理改动或决策记录；下一轮 `ownChanges` 只取上一次整理的 changes（consolidation.ts:238-242），确认后的记忆 revision 已变，会再次成为 fresh。若模型再判 `conflict`，会再次 hold（主人每天都要再点一次确认）；若模型改判 `replace` 且置信度 ≥850，`milk-old` 这类旧条会被自动作废——与 Andy「两条都留」的选择相悖。
- 推测部分：模型是否反复改判无法从代码断定；单次确认行为本身符合验收。
- 建议：确认（或撤销）hold 时落一条决策记录/历史标记，整理时据此跳过该对。

**2. 低 | apps/agent-service/src/service-main.ts:1465-1520；apps/agent-service/src/production-http-composition.ts:1027-1038 | 两个生产构造点都没传 `gates`，置信度门槛靠 `DEFAULT_CAPTURE_GATES` 兜底**
- 证据：`MemoryConsolidationServiceOptions.gates` 是可选（consolidation.ts:73），`autoCommitThreshold` 无 gates 时回落 `DEFAULT_CAPTURE_GATES`（automatic-memory-service.ts:59-64）；两个生产构造点均未传。目前抽取也用默认（apps 下无任何 `gates:` 传参），`MEMORY_AUTO_COMMIT_GATE` 是静态常量（thresholds.ts:30-41），所以现在两端一致，ADR 第 6 条「读同一份登记」当前成立；但将来 capture 门槛改为按配置注入时，整理会静默留在默认值。
- 建议：构造时与抽取共用同一来源传入，或在此注明回落即登记表。

**3. 低 | apps/control-center/test/memory-interactions.unit.test.ts:1099；packages/gateway-contracts/test/gateway-v2.fixture.ts:578 | UI 和网关契约层对 `hold` 无用例**
- 证据：三语 i18n 都加了 `hold`（en.ts:754/1099、ja.ts:761/1100、zh-CN.ts:711/1035），`memory-page.tsx:1780` 把 hold 并入 confirm，但两处 fixture 的 tidyUps 都只有 `merge`；契约 schema 放宽了枚举却无 hold 样本验证。i18n message-ids 校验机制存在（`message-ids.ts`），标签走 select 分支的 `other` 兜底，无功能缺口。
- 建议：给两处 fixture 各加一条 hold 样本。

**4. 低 | packages/persistence-sqlite/test/consolidation-hold-migration.contract.test.ts:22-28 | 迁移保全测试只断言了 5 张表**
- 证据：`TABLES` 只含 decision_ledger、decision_signals、memory_consolidation_runs、memory_consolidation_changes、memory_consolidation_change_basis；0089 同样重建的另外 5 张表（source_insights、proactive_processed_messages、decision_ledger_payloads、proactive_push_backoff、muse_reference_entries）的数据保全和索引/触发器未被此测试断言（「未核实」0088 当初是否有等价测试）。我逐行比对了 0089 与 0088 的这七张表 SQL：除 `decision_ledger` 的 CHECK 加 `hold` 外逐字相同，`memory_consolidation_changes`/`change_basis` 与 0054/0084 原定义一致（仅 action 加 hold），索引、触发器无遗漏。
- 建议：把这 5 张表也放进 `TABLES`。

**5. 信息 | .claude/rules/prompt-prefix.md:53 | 提示词文字变更会改固定文字清单（I-78 机制）**
- 证据：规则 53 写明改提示词文字后「老对话里冻结的旧文字不再在清单里，按外来内容检查」。本次改的 `memory.consolidation`/`.format` 只用于后台整理调用（`usedBy` 只有 consolidation.ts），不进对话冻结头；新文字无数字类敏感样式，实际无影响。已留意，无需行动。

作者各说法核对结果：提示词加 `replace`、重定义 `conflict` ✓（prompt-catalog/src/memory.ts）；supersede 三条件（`replace`、keep 严格更晚、置信度 ≥`autoCommitThreshold`）✓（consolidation.ts:367-375）；其余设 `tentative: true` + hold 记录（memory_id=新、related=旧、outcome `hold`、reason `consolidation_hold`）✓（consolidation.ts:382、511；sqlite-memory-consolidation-operations.ts:92-111，与 ADR 0220 第 3 条完全一致）；撤销置回 false ✓（consolidation.ts:450-451）；迁移 0089 与 0088 逐字一致（除 CHECK 加 hold）✓；枚举四处（导出 schema、网关契约 ×3、决策端口、i18n ×3、审计脚本版本号）✓；「不写代码注释」✓。

## 必答问题

1. **不会改变模型已见过的请求开头。** 证实：本次改的只有 `memory.consolidation`/`memory.consolidation.format` 两条后台提示词（usedBy 仅 consolidation.ts）和 golden 文件；对话的系统提示、工具定义、历史、遮盖逻辑零改动。整理是每次独立的一次性后台调用（规则 15），不存在会延续的请求历史，「已经发给过模型的内容」不涉及；golden 测试（prompt-rendering-golden.unit.test.ts:173-191）把渲染结果逐字节钉住，manifest 哈希有 PROMPT_MANIFEST_STALE 反向用例。每轮变化的值（日期、记忆文本）本就在调用数据区，本次未触碰该结构。
2. **不会。** 证实：新值 `hold` 的所有序列化都是确定的——change id 是 `${consolidationId}:c${n}`，ledger `inputs.memoryIds` 固定 [新，旧]、`resultMemoryIds` [新]（consolidation.ts:506-511），prompt 行序由排序后的数组生成（consolidation.ts:259、303）。不依赖对象遍历序或数据库返回序；无新增时间戳类字段进模型请求。唯一非确定点（每日打分的 hash 采样）是既有机制，未被本次改动触碰。
3. **有，且反向用例真实存在。** 证实：迁移（unknown action 被拒，contract test:172-176）、manifest（STALE 反向用例，prompt-catalog.unit.test.ts:370-381）、golden（缺文件报错，:93-97）、集成（4 种判定情形+撤销+确认+确认后撤销被拒）、每日预算（30 条 hold 只显示 capacity 条）。缺口见问题 3（UI/网关 fixture 无 hold 样本）。
4. **逐个核对过，当前都能接受。** `replace`：仅出现在 parse→Decision 内部，不落库；`hold`：产生于 consolidation.ts:382，消费端逐一核对——sqlite `ACTIONS` ✓、0089 两处 CHECK ✓（迁移前旧库 CHECK 不含 hold，但迁移先于新代码写入，且 `insertConsolidationWrite` 在 run 状态检查之外依赖 DB CHECK 拒绝，0089 属 expand 相、先应用）、decision-ledger 端口 ✓、网关契约 3 处 ✓、导出 schema ✓、i18n 3 语 ✓、daily-review 走通用 consolidation 分支 ✓、tidyUps 透传 ✓。`reasonCode: consolidation_hold` 满足 1-64 长度 ✓。审计脚本 `SUPPORTED_SCHEMA_MAX=89` 与迁移目录一致且有 I-46 门槛检查兜底 ✓。遗留风险即问题 2（gates 未显式传入）。
