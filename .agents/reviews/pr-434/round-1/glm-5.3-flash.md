# 复核报告：P4-1/P4-3 记忆改正传播（4778b1c）

## 侧重检查（先读的流程）

走查了最普通的一条流程：**Andy 改一条记忆 → 打开记忆页看待重审清单 → 后台查邮件前自动核对规则 → Andy 采用建议 → 周报一致率**。

- Andy 保存修改（`memory.edit` 的 correct）：`apps/agent-service/src/production-memory-control.ts:1517` 调 `#resolveMemoryReview`（结清该记忆的旧标记、计认可），随后 `UPDATE memory_records` 触发 `memory_change_flags_downstream`，标直接下游 + 把指向它的规则改成待重审。
- 清单：`memory.review.read`（production-memory-control.ts）先 `expandMemoryReviews`（10 轮 × 20 条）再 `listOpen`，正文读不出 200 字截断。
- 后台核对：`ProductionProactive.tick` 先 `reviewRules()` 再跑邮件检查（production-proactive.ts:341-346）；`RuleReviewService` 每次最多 3 条，修订号不符丢弃结果。
- 采纳：`memory.review.respond`（adopt + expectedRevision），修订号过期抛 `PORT_CONFLICT`（integration 测试 2411-2418 断言）。
- 一致率：`agreement` 查询 + 周报 `correction` 卡。

**这段流程有测试覆盖**：integration `[P4-1]` 全流程（production-memory-capture.test.ts:2305-2440）、迁移触发器 contract test（correction-propagation-migration.contract.test.ts）、服务单测（rule-review-service.unit.test.ts）、失败不阻断查邮件（proactive-production.test.ts:1016-1040）、UI 卡片含“不足 5 条”反向用例（weekly-report.unit.test.ts:1172-1204）。

**走查发现、没有测试覆盖的路径**：① 来源记忆正文读不出（`RULE_REVIEW_MEMORY_UNREADABLE`）；② 清单快照里正文读不出的条目被丢弃；③ 已标记记忆删除后再“恢复”；④ 导出/导入含 suspended 规则。详见下面问题清单。

---

## 问题清单（严重度从高到低）

**1. 中｜apps/agent-service/src/service-main.ts（readMemoryText，约 2003-2009 行）＋ packages/application/src/services/rule-review-service.ts:104-109**
问题：来源记忆 payload 读不出时（`readReviewText` 返回 undefined 抛 `RULE_REVIEW_MEMORY_UNREADABLE`），异常直接冲出 `#review`，不写 `recordFailure`、不计数、不写 `recheck_failed`。规则每次查邮件都被重试，且因 `review_after` 永不更新而永远排在 due 列表最前（sqlite-correction-review-operations.ts:186 `ORDER BY review_after`），每次占用 3 条限额中的一席。
证据（读代码证实）：service-main.ts `if (text === undefined) throw new Error("RULE_REVIEW_MEMORY_UNREADABLE")`；rule-review-service.ts:104-109 的 catch 只处理 `RuleTypeError`，其余 `throw error`；production-proactive.ts `reviewRules` 捕获后仅记 `onFailure`，规则状态不动。单测的 `readMemoryText` 永不抛错（rule-review-service.unit.test.ts:121），此路径无反向用例。
这与作者说法/ADR“模型调用失败最多重试 3 次（间隔 1 小时）后记 recheck_failed”不符——模型调用失败确实如此，但“记忆读不出”这条失败完全绕开该机制。
建议：把读取失败也归入 `recordFailure`（复用 `model_failed` 或加原因），让它走 3 次上限和 `recheck_failed` 记录。

**2. 中（偏低）｜packages/persistence-sqlite/src/data-export/export.ts:477-512、import.ts:697-720、rules.ts、schemas.ts**
问题：数据导出/导入对 `suspended` 的全部改动没有测试。全测试目录 grep `suspended`，data-export 相关测试一条都没有（data-export-rules.test.ts 无 suspended 匹配）。
证据（读代码证实）：export 新增 `suspendReason` 导出、建议值丢弃计数 `droppedRuleSuggestions`、`openMemoryReviews` 计数；import 新增 `suspend_reason, review_after` 两列，suspended 导入后 `review_after` 为 NULL（后台核对不再排队，规则停在暂停等主人点按钮——行为符合 ADR 0232 决定 8，但无用例锁定）；`assertRuleHistory` 新增“暂停原因和状态对不上”的反向检查也无用例。
建议：给导出/导入补一条 suspended 规则用例（含 suspendReason、建议值不导出、导入后 review_after 为 NULL）。

**3. 低｜apps/agent-service/src/production-memory-control.ts `#review`（新增代码段内）**
问题：清单快照里正文读不出的待重审记忆被直接跳过（`textOf` 失败得空串 → `continue`），但 `agreement.openMemories` 仍统计它。清单和周报“还在待处理”的数字会对不上，且该条目永远无法从清单上点掉。
证据（读代码证实）：`const text = singleLine(await this.readText(record.contentRef).catch(() => "")); return text ? … : null;` 之后 `if (!text) continue;`；而 agreement 的 `openMemories = COUNT(DISTINCT memory_id) … status='open'` 照算。无测试。
建议：读不出时显示占位文本（如“正文读不出”），或从 openMemories 里排除。

**4. 低｜packages/persistence-sqlite/src/sqlite-correction-review-operations.ts:522-529**
问题：一条记忆同时有“系统标记行”和“owner_reported 行”（不同上游）时，`resolveMemory` 一次把该记忆全部 open 行结清，`counted = rows.some(reason !== 'owner_reported')` 为真，整条决策按 `system_flagged` 计入一致率——漏标那一行进了分母/分子，与 ADR 0232“漏标单独计数，不进一致率的分母”在边缘上不一致。
证据（读代码证实）：resolve 的 UPDATE 不区分 reason；counted 逻辑如上。推测：需要“同一条记忆、两个不同上游、一个是漏标”才会触发，实际罕见。
建议：`counted` 按“存在系统标记行”计没问题，但可把漏标行从该次决策中拆开，或在 ADR 里写明这种合并口径。

**5. 低｜apps/agent-service/src/production-memory-control.ts:1551-1554**
问题：`recover`（从回收站恢复）不结清/不重开该记忆的待重审标记。删除时以 `owner_edited` 结清并计为认可，之后恢复原记忆，清单里不再出现这条。
证据（读代码证实）：diff 只在 correct/confirm/restore_version/delete 后加了 `#resolveMemoryReview`，recover 分支没有。ADR 0232 未写明恢复已删记忆的口径（它只写了“恢复旧版本”算认可、“记忆从回收站恢复”会触发上游标记）。推测影响：仅清单显示与计数，规则侧不受影响（恢复本身会触发规则重排队）。
建议：在 ADR 里补一句口径，或让 recover 重新打开该记忆自己的标记。

**6. 低｜packages/persistence-sqlite/src/sqlite-correction-review-operations.ts:429-434**
问题：expand 的 upsert 冲突分支不比较 depth，直接 `depth = excluded.depth, via_memory_id = excluded.via_memory_id`。同一 (记忆， 上游) 既有触发器写的直接下游行（depth 1、via NULL），又被更浅的根经更深的链路展开命中时，会覆盖成 depth 2＋经由中间记忆。
证据（读代码证实）：`WHERE … flagged_at < excluded.flagged_at OR status = 'open'` 只挡时间/已结清，不挡 depth。推测影响：仅 UI 显示的“深度/经由”可能偏大，不漏标不重标。
建议：冲突更新时取 `min(depth)`。

**7. 低（文档）｜docs/adr/0232…md:76 ↔ apps/control-center/src/i18n/resources/zh-CN.ts:1367**
问题：ADR“业界怎么做”说一致率“附样本数和 Wilson 区间”，周报 `correction` 卡实际只显示 `{pct}（{k}/{n}）`（`weekly.ratio`），无区间。与周报其他比例卡一致，属 ADR 表述过宽。
建议：把 ADR 那句改成“沿用周报其他比例的显示方式”。

---

## 必答问题逐条

**1. 会不会改变模型已经见过的请求开头？** 不会。改动未触及对话请求组装的任何路径（系统提示、工具定义、历史、遮盖的代码在本次 diff 里没有变化；ADR 0232 后果一节也明确规则暂停不改 ADR 0211 那条给模型看的软偏好文字，另行出方案）。新增的唯一模型调用是后台规则核对：固定段（RULE_REVIEW.text、INSTRUCTIONS_HEADER、TOOL_RULE_SET）在前，最后一条是 `JSON.stringify({memory, currentRule})`（rule-review-service.ts:52-63），无时间字段，符合 prompt-prefix.md 第 15 条“后台调用固定在前、会变的在后”。有逐字节单测（rule-review-service.unit.test.ts:211-224）且提示词已登记 manifest（`rule.review`、`rule.review.instructions-header`）。

**2. 同一段文字会不会在不同请求里变成不同字节？** 读代码证实的部分：不会。提示末段的对象字面量键序固定；`currentRule.params` 两边都过 `parseOwnerRuleParameters` 归一化（两条单测证明大小写、顺序、重复值归一后逐字节相同）；没有新增依赖前后文的遮盖逻辑，遮盖本身未改。未核实的细节：`parseOwnerRuleParameters` 归一化的完整实现（rule-types.ts 未逐行读），仅由上述单测佐证。

**3. 有没有对应的自动检查、反向用例会不会失败？** 有，且多数反向用例真实存在：触发器不标无关字段/已撤销的 reflect（contract test:179-200）、修订号过期 `resolve(1)` 返回 false（:281）、3 次失败后不再排队且规则照常执行（:323-344）、服务层模型失败/坏 JSON/泄露拒绝→不暂停只记 failure（unit test:195-209）、integration 里过期 expectedRevision 被拒（:2411-2418）、核对失败不阻断查邮件（proactive-production.test.ts:1016-1040）、UI“不足 5 条不出比例”（weekly-report.unit.test.ts:1172）。缺口：问题 1、2、3、5 的路径没有反向用例。

**4. 一致率计数是否符合 ADR 0232？** 基本符合（读代码逐条核对）：认可=owner_adopted/owner_confirmed（规则，仅 `from_suspended`）＋owner_edited（记忆的改/删/恢复旧版本，production-memory-control.ts:1517/1538/1548）；不认可=owner_restored＋owner_dismissed；规则还在 needs_review 时点的“看过没问题”走 restore、reason=`from_needs_review`，不进分母（contract test:346-360 断言 handled=0）；漏标 `owner_reported` 单独计数不进分母；`proportion` 用 `DEFAULT_MINIMUM_SAMPLES=5`。唯一边缘不一致见问题 4。

**5. 网关输入是否都校验了归属和存在？** 是。schema 层 machineString/枚举/nullable integer（contracts-v2.ts:1689-1719）；行为层：dismiss 只结清 scope 内 `memory_review_items` 的行，0 行抛 `MEMORY_REVIEW_NOT_FOUND`；规则动作校验 rule_id 格式（`^owner:[A-Za-z0-9_-]{1,58}$`）、expectedRevision 非空（否则 `RULE_REVIEW_REVISION_REQUIRED`）、状态必须是 needs_review/suspended、修订号必须相等（否则 `PORT_CONFLICT`）；reportMissed 校验两条记忆都在本 owner/agent 下存在且不自指。所有查询都带 configuration 的 ownerId/agentId，无法操作别人的记忆或规则。

**6. 迁移是否丢数据/约束/索引；“未导出”清单是否正确？** 没发现丢失。0095 沿用 0089/0091 的 keep-table 重建模式，全部引用 decision_ledger 的子表按依赖顺序先删后建，`rule_book_history` 的不可变触发器显式重建，0087 两个旧触发器显式删除，`source_memory`/`review_after` 索引重建，`review_after` 是 0095 新增列并用 `CASE WHEN status='needs_review'` 回填（不依赖旧列）。contract test 验证了旧数据搬运、`foreign_key_check` 为空、预评审触发器仍在（:397-414）。“未导出”清单两条新条目与实际行为一致：只丢 `suggestion`（`suspend_reason` 照导出、`memory_review_items` 不导出且计数正确）。缺口仅是问题 2 的测试缺失。

**7. ADR 0232、案例 92 和代码是否一致？** 核对过的要点全部相符：触发器只标直接下游＋程序展开 8 层/200 条/记截断（derivedMemories 的 maxDepth 和 200 节点上限、UI `review.truncated` 文案）；暂停必带原因、只有 parameters_changed 带建议（DB CHECK + resolve 校验）；暂停不执行的四处消费方（ruleIsEnforced、enforceableOwnerRule、MCP `rule_book` 的 enforced 标志、导出 enforcedRuleCount）都已改且有单测；失败 3 次写 `recheck_failed` 且规则照常执行；Andy 自己点的结果不进每日回顾（sqlite-decision-ledger-operations.ts 新增过滤）和校准（calibrationGroup 对 `owner_*` 返回 null，有单测）；案例 92 说的三个方案讨论发现（WITH 不能用于触发器、删除前写入、恢复也触发）与实现一致。不一致只有问题 7（Wilson 区间表述）和问题 5（recover 口径未写明）；另外作者说法里“模型调用失败重试 3 次后记 recheck_failed”对“记忆读不出”这条失败不成立（问题 1）。

**未核实**：`parseOwnerRuleParameters` 的归一化实现细节；e2e fixture（control-center-browser-server.mjs）的具体改动；`migration-engine.contract.test.ts` 的 58 行改动内容。
