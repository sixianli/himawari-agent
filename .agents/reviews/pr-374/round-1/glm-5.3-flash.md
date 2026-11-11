# 复核报告：P2-5（f7c79dd）

## 发现的问题（按严重度从高到低）

**1.（低）`test/../sqlite-decision-ledger-operations.ts:334-338` — 去重前先截到 200 条，超出部分既不入记录也可能造成误判**
证据：`packages/application/src/services/context-formation-service.ts:359` 写入时 `memoryIds: [...usage.queued].sort().slice(0, 200)`；去重比较的就是这个截断后的数组（sqlite-decision-ledger-operations.ts:334-338 的 `before?.length === now.length && new Set(...)`）。若被挤掉条目超过 200，第 200 条之后的编号永远不会被记录；且两个实际不同的被挤集合只要前 200 个编号相同就会被当成“没变”而不写记录。这是新代码引入的路径（旧的 `selection_limit_reached` 记录也有同样的截断，但它不去重，不受影响）。
建议：在记录里附一个总数（如 `queuedTotal`），或至少在 ADR 里写明这条截断。

**2.（低）`context-formation-service.ts:346-370` — 写入失败与校验失败都被静默吞掉，无测试覆盖**
证据：`.appendIfChanged({...}).catch(() => undefined)`。ADR 0214 决定 3 写明“写入失败时……忽略”，这是有意取舍；但 `appendIfChanged` 内部 `this.fail("PORT_INVALID_OPERATION", ...)`（sqlite-decision-ledger-operations.ts:323、329-332）抛出的校验失败同样被吞，程序 bug 不会留下任何痕迹，也没有测试注入失败路径。
建议：至少区分“写入失败可忽略”与“校验失败应记日志”；补一条失败注入用例。

**3.（低）`sqlite-decision-ledger-operations.ts:325-331` — “最新一条”的排序依赖 `checked_at DESC, id DESC`，`id` 是否单调未核实**
证据：`ORDER BY checked_at DESC, id DESC`。`checked_at` 是合法 ISO 串（validateLedgerWrite 第 61 行强制），字典序即时间序，没问题；但 `id` 来自 `ids.next("ledger")`，我没核实它的单调性。若同一时刻出现两条原因码相同、编号集合不同的记录，取哪条不定，可能错误地判“没变”而少记一条（推测，未证实发生条件）。
建议：确认 `ids.next` 生成单调 id，或改用 rowid 排序。

**4.（低，符合验收但需知晓）去重命中时不更新记录里的字数**
证据：`appendIfChanged` 只比较 `reasonCode` 和 `memoryIds`（sqlite-decision-ledger-operations.ts:333-338），不比较 `profileBudget`。同一组被挤掉、但 `used/pinned` 已变化时（例如置顶字数变了恰好 queued 集合不变），旧记录里的字数保持第一次的值。这与主人定的验收（“只看编号集合”）一致，不算违背，但查因时看到的字数可能不是当轮的。

**5.（低）`test/integration/context-formation.test.ts:71-76` — 该文件的 ledger stub 把 `appendIfChanged` 实现成“总是写”**
证据：`appendIfChanged: async ({ write }) => { await ledger.append(write); return true; }`。即 context-formation 自身的集成测试不经过去重逻辑（去重由 decision-ledger.test.ts 的真实 SQLite 用例覆盖）。这不是错误，但意味着“同轮先写 `selection_limit_reached`、再写 profile 记录”的叠加行为只有 decision-ledger.test.ts 一个文件覆盖 worker/direct 两种模式。

## 作者说法逐条核对（读代码证实的，全部一致）

- “`#select` 先把置顶条目的字数全部预留，再按原顺序分给非置顶条目” —— 一致（owner-profile-service.ts:217-233：`pinnedUsed` 先算，`remaining = limit - pinnedUsed`，`fit(ruleLines)` 先于 `fit(factLines)`，置顶条目在 `fit` 里无条件通过）。
- “`compose()` 返回 `usage {limit, used, pinned, queued}`” —— 一致（owner-profile-service.ts:245-250、352-356）。
- “`queued` 非空或 `pinned > limit` 时调用 `appendIfChanged`” —— 一致（context-formation-service.ts:341-345）。
- “原因码 `profile_budget_exceeded` / `profile_pinned_over_budget`” —— 一致（context-formation-service.ts:355-356，常量在 decision-ledger.ts）。
- “`appendIfChanged` 在一个事务里取同一主人、同一类型、原因码在集合内的最新一条；原因码和编号集合相同就不写” —— 一致（sqlite-decision-ledger-operations.ts:325-340，事务 + owner_id/agent_id/kind/reason_code 过滤 + 集合比较）。
- “去重以数据库为准，重启不重复；间隔无超字轮次后同组再挤掉不重记，取舍写在 ADR 0214‘放弃的做法’” —— 一致（ADR 0214「放弃的做法」第三条原文存在，语义与代码相符）。
- “记忆页 `pinned > limit` 显示提示；网关契约 `profileUsage` 加 `pinned`” —— 一致（memory-page.tsx:1284-1291；contracts-v2.ts:1247）。
- 约束核对：“`context_truncation` 归入折叠 `other` 组、不占每日预算” —— 一致（daily-review.ts:201-210 `context_truncation` 落到 `other`；daily-review.ts:98 `other` 不进每日预算的 `defaults`）。“档案块位置不动” —— diff 未触碰任何请求组装/位置代码。

## 侧重检查（普通使用流程走查）

流程：主人发消息 → run → `ContextFormationService.form`：

1. `profile.compose` → `#select`（读 pin、listActive、分类上限、当前有效性过滤）→ 块构建。**有覆盖**：owner-profile-service.unit.test.ts（含 3 条 `[P2-5]` 正反用例，反向“全部放得下则 queued 为空”会卡住旧实现——旧代码会把置顶条目挤掉，用例确实失败）。
2. 新增的截断记录 `appendIfChanged` → SQLite。**有覆盖**：decision-ledger.test.ts 三条 `[P2-5]`，worker/direct 双模式，含正向、下一轮同组不重记、集合变化重记、置顶超限只记一条、反向（预算内零记录）。
3. envelope 组装 → 模型请求。**有覆盖**：`npm run check:prompt-prefix`（prompt-prefix.compat.test.ts 的 fixture 含 owner-profile 块）；本次 diff 未改动这些路径。运行结果本身**未核实**（本复核不能执行命令）。
4. 记忆页提示。**有覆盖**：memory-source-browser.test.ts 两条 Playwright 用例（`pinned: 2150` 显示提示 / 反向无提示），e2e fixture 服务器同步加了 `pinned` 字段。
5. **无覆盖的路径**：`appendIfChanged` 失败/校验失败被吞（见问题 2）；queued 超 200 截断（问题 1）；`pinned > limit` 且无非置顶候选（queued 为空、memoryIds 为空数组）的边界无显式用例；`ids.next` id 的单调性未核实。
6. 文档与代码一致性：ADR 0214、agent-rulebook-inventory M-3 均已更新，引用的函数名（`#select`、`OWNER_PROFILE_CHARACTER_BUDGET`、`context-formation-service.ts 写记录`）与代码相符；M-3 引用的旧测试名"stays within the character budget"仍存在且已同步 `pinned` 期望。三语言文案、MESSAGE_IDS、样例值、三处测试 fixture（memory-interactions、release-walkthrough、gateway-v2.fixture）全部补齐。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？—— 不会。** 依据：diff 只动了 `#select` 的选取算法和决策记录写入，未触碰请求组装；档案块仍只通过 `profile.blocks` 进 envelope，envelope 里 profile 只序列化 `kind/ref/payloadRef/dataClassification` 四个字段（context-formation-service.ts:629），trace 里也只取这四个（453 行），新增的 `usage` 不会进入发给模型的内容；截断记录写的是决策账本，不是模型可见内容。档案块本来就在最后一条用户消息里（规则第 2 条、prompt-prefix.compat.test.ts 的 fixture 印证），每轮变化的值仍在最后一条消息。`npm run check:prompt-prefix` 门槛仍然适用；该检查的实际运行结果未核实。

**2. 会不会让同一段文字在不同请求里变成不同字节？—— 不会。** 档案条目顺序由固定的 `PROFILE_SECTIONS` 顺序 + 既有的 `ownerFirst`/重要度/`id.localeCompare` 比较器决定，新逻辑只是把置顶提前预留，遍历顺序仍确定；`queued`/记录里的 `memoryIds` 都经 `.sort()`；去重比较与集合内元素顺序无关。记录里的 `used/pinned/limit` 是数字，不进模型内容。`localeCompare` 依赖 ICU 属既有行为，非本次引入。

**3. 有没有对应的自动检查，反向用例会不会真的失败？—— 有，且反向用例对旧实现确实会失败。** 单元层：`[P2-5] never drops a pinned memory...`（旧代码置顶会被规则挤掉，用例失败）、反向“全部放得下 queued 为空”；集成层：decision-ledger.test.ts 旧实现（每轮无条件 append）会让“下一轮同一组不再记”和反向“零记录”失败；浏览器层反向 `toHaveCount(0)`。缺口见问题 1、2、5。

**4. 每个产生/使用的值两端都核过了吗？—— 都核过，两端校验匹配。** 逐项：`OwnerProfileUsage.pinned`（产生：owner-profile-service.ts:248；使用：production-memory-control.ts:704 → contracts-v2.ts:1247 `integer(0)` 校验 → memory-page.tsx:1284 比较，类型上 `OwnerProfileUsage.pinned` 必填，所有 fixture 已同步）；两个原因码（产生：context-formation-service.ts:355-356；校验：validateLedgerWrite 第 57 行 `text(1,64)` + appendIfChanged 的 `reasonCodes` 集合校验；账本表 reason_code 无 CHECK，自由文字，符合“不改表结构”）；`profileBudget`（校验新增于 validateLedgerWrite 第 70-82 行，且数学上 `used = pinned + fit 通过的非置顶字数 ≥ pinned`，`pinned > used` 不可能由本服务产生；读取侧 entryFromRow 有对应反序列化）；`appendIfChanged` 端口方法（声明 → durable-adapters 注册 → operations switch → 测试 stub，四处齐备）。这正是 I-73 教训要求的“两端都看”，本次两端一致，未发现漏配。
