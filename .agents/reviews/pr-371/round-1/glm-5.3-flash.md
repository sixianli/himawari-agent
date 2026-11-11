# 复核报告：P4-6 每周记忆体检（36ee0d2b vs aa1b0b0）

## 发现的问题（按严重度从高到低）

### 【中】1. `act()` 跨两个存储非原子，半途失败会让条目永久卡死、记忆被改却无法撤销
- 文件:行：`packages/application/src/services/memory-checkup.ts:238-273`
- 问题：`act()` 先改记忆（`memory.trash` / `memory.revise` / `memory.confirm`），**之后**才写 `store.recordAction`。两次写入分属两个独立存储操作，中间失败（磁盘余量断言、DB 报错、进程崩溃）会产生：记忆已被 trash/archived，但条目仍 pending 且没有 `before_state`。此后：重新操作会因 `#live()` 拒绝（`MEMORY_CHECKUP_STALE`，memory-checkup.ts:212-215，`live` 要求 status==="active" 且无 supersededBy）；撤销因 `action===null` 拒绝（memory-checkup.ts:281-282 附近）。条目永远卡在 pending，记忆被删却无 undo 路径。
- 证据：
  - memory-checkup.ts:238 `await this.#options.memory.trash(subject.id, ...)` → 266 `const recorded = await this.#options.store.recordAction({...})` → 272 `if (!recorded) refuse(...)`；
  - `packages/persistence-sqlite/src/sqlite-memory-checkup-operations.ts` 的 `recordAction` 先 `this.assertDiskHeadroom()` 再 UPDATE——这就是一个真实的半途失败点。
- 建议：把「记忆写入 + recordAction」放进同一事务（两个操作都走 `SqliteDurableOperations.context`，可以合并为一个 durable 操作），或先写 `before_state` 占位再改记忆并在失败时补偿。作者把这条路径列为“请看”，但代码里没有任何缓解；ADR 0218 也没提。

### 【中】2. 服务端三条防护在本提交内没有任何自动检查；反向用例缺位
- 文件:行：`apps/agent-service/src/production-proactive.ts:546-568`、`packages/gateway-contracts/src/contracts-v2.ts:608-621`、`packages/gateway-contracts/test/gateway-v2.contract.test.ts:110-175`
- 问题（读代码证实）：
  - 预算检查（:560 `const shown = (await this.review()).items.some(...)` → `PROACTIVE_REVIEW_BUDGET_USED`）没有已提交的测试。`test/integration/proactive-production.test.ts` 本次只加了一行配置字段；ADR 声称覆盖它的 `test/integration/memory-checkup.test.ts` 未提交。
  - `proactive.review.rate` 拒绝 checkup 键（:512）同样只在未提交的集成测试里有覆盖；网页单元测试只测了“前端不发”，不测“服务端拒”。
  - 合同层“merge 必须带 keep”的交叉校验（contracts-v2.ts 中 `(payload.action === "merge") !== (payload.keep !== null)` 抛错）只有正向 fixture（gateway-v2.fixture.ts 新增 `action:"merge", keep:"memory-02"`）；`gateway-v2.contract.test.ts` 的 rejects 列表（110-175 行）没有任何 checkup 反向用例，删掉该校验不会有测试失败。
- 建议：迁移放行时务必把这三条的反向用例一起带上；合同交叉校验的反向用例不依赖迁移，现在就能加。

### 【低】3. ADR 与代码不一致：「从没被用到的按记录时间算」
- 文件:行：`packages/application/src/services/memory-checkup.ts:59-60` vs `docs/adr/0218-weekly-memory-checkup-in-daily-rating.md` 决定第 1 条
- 问题：代码是 `record.lastUsedAt ?? record.recordedAt ?? record.updatedAt`，多一层 `updatedAt` 兜底；ADR 只写 recordedAt。记忆 overview 里 `recordedAt` 可为空（production-memory-control.ts:437 `memory.recordedAt ?? memory.updatedAt`），所以兜底真实存在。
- 建议：改 ADR 措辞即可，行为本身无害。

### 【低】4. 撤销在“记忆已被别处动过”时永久拒绝，记录无法回到未处理
- 文件:行：`packages/application/src/services/memory-checkup.ts:285,296,301-305`
- 问题（读代码证实）：undo confirm 分支走 `#live()`（要求 active 且未被取代）；undo delete 要求 `status==="trashed"`；undo merge 要求 `status==="archived" && supersededBy===keepId`。若用户确认后又把该记忆归档/取代，或从回收站页手动恢复了它，undo 永远 `MEMORY_CHECKUP_STALE`——条目停在“已处理”，界面上（当天展示时）只有“撤销”按钮且永远失败。推测影响面小，但属于“撤销时记忆已被别处改过”这一作者点名路径的现状：只防错、不降级。
- 建议：可接受；若要改进，可在 STALE 时允许直接清空记录（action/before 已无还原意义）。

### 【低】5. UI 假定条目的 `memoryId` 是矛盾对里“新”的一条（推测/未核实）
- 文件:行：`apps/control-center/src/components/proactive-reminders.tsx:410-414`（"新：/旧："标签）、ADR 0218「P3-8 分工」节
- 问题：`pairs: async () => []`（service-main.ts:1595），矛盾对来源要等 P3-8。当前无法核实将来 `memory_id` 一定是新条、`related_memory_id` 一定是旧条，只与 ADR 的计划一致。界面上“替换/删掉新的”按钮的方向完全依赖这个未落地的约定。
- 建议：P3-8 合并时补一条断言测试。

## 作者说法逐条核对（均为读代码证实，除标注外）

- 「预算规则（只收今天展示项、其余 PROACTIVE_REVIEW_BUDGET_USED；撤销总允许、不退名额；今天已处理的仍占名额）」：属实。production-proactive.ts:556（undo 在 shown 检查之前，直接放行）、:560-565；selectDailyReview 的 eligible 规则保留今天已处理条目（daily-review.ts:96-98）。
- 「确认：84 天静默、不提置信度、tentative 走 memory.confirm」：属实。`MEMORY_CHECKUP_CONFIRM_QUIET_DAYS = 84`，静默集只过滤非矛盾队列（memory-checkup.ts:112-116）；`confirm` 仅把 `tentative` 置 false，不动置信度（durable-memory-service.ts:266-286）。
- 「删除进回收站、撤销用 recover」：属实（memory-checkup.ts:238 / 296-298；trash→`deactivate("trashed")`，recover 要求 trashed/archived）。
- 「合并：keep 限这一对、drop 改 archived+supersededBy+validTo=now、keep tentative 则转正、撤销按 before 还原」：属实（memory-checkup.ts:243-263；undo 299-321）。`revise` 是属性合并不是整体替换（durable-memory-service.ts:317-323），所以撤销只回写 `supersededBy/validTo/tentative` 不会抹掉其它属性——这点我专门核过。
- 「合并不搬来源引用」：与 ADR 0218「放弃的做法」一致，代码确实未搬。
- 「rate 拒绝体检键；『这一页都没问题』不含体检条目」：属实（production-proactive.ts:512；proactive-reminders.tsx `unrated` 过滤；单测 [P4-6] 断言 ratings 不含 checkup 键）。
- 「memorySourceState 搬迁、control-center 重导出、行为不变」：属实。新旧逻辑逐行相同，重导出（apps/control-center/src/memory-source.ts:4），调用方（memory-page.tsx:27）不受影响；`REMINDER_SOURCE_PREFIX` 的集成测试已改读新文件。
- 「预留表结构与 CHECK 约束」：迁移未提交，无法核对表本身；但已提交的 `sqlite-memory-checkup-operations.ts` SQL 与声明的语义一致（recordAction 要求 `action IS NULL`、recordUndo 要求 `action IS NOT NULL`、createWeek 事务内查重）。SQL 本身未发现错误；`related_memory_id IS NULL OR reason='conflict'`、UNIQUE 等约束在应用层有对应校验（createWeek 校验 reason/related 配对并逐条验 owner 归属），最终以迁移落地为准。

## 侧重检查

走的普通流程：网页打开每天打分 → `proactive.review.read` → `ProductionProactive.review()`（production-proactive.ts:309-330）→ `checkup.week()`（listWeek→listActive→findSourceMessageIds→pickMemoryCheckup→createWeek）→ `readDailyReview`/`selectDailyReview` 抽样（checkup 作为一个组，round-robin 共用名额，daily-review.ts:29-35、114-125）→ snapshot（含 `checkup`/`memoryUnusedDays` 新字段）→ UI 分页渲染 CheckupRow → 点击 → `proactive.review.checkup` → 合同校验 → undo 直通 / act 先查 shown → 改记忆 → recordAction。

- 有已提交测试的环节：配置解析（startup-configuration.unit.test.ts，含 6/3651 反向用例，反向真的会失败）、合同正反向解析（正向 fixture + 既有 rejects 机制，但无 checkup 反向用例，见问题 2）、UI 渲染与命令映射（[P4-6] 用例）。
- 无已提交测试的环节：`MemoryCheckupService` 全部（挑选、act、undo、并发）、`SqliteMemoryCheckupOperations` 全部 SQL、`checkupWeekStart`、`pickMemoryCheckup`、production-proactive 的 checkup 分支（预算/undo）。这些都在未提交的测试文件里，与作者披露一致，但意味着本提交里这段核心逻辑零覆盖。
- 文档一致性：ADR/词汇表/i18n 三语资源与代码一致；仅问题 3 的一处措辞不符。`npm run check:layout` 约束通过「体检+打分同列表每页 6 条」满足，单测断言了行数 ≤6。

## 必答问题

1. **是否改变模型已见过的请求开头？** 否。改动面全部在 gateway/UI/存储：对话请求的系统提示、工具定义、历史消息、遮盖结果均未触碰（production-memory-control.ts 的改动只是把 `earliestSourceMessage` 逻辑抽成 `findSourceMessageIds`，我逐行核对过：refsByThread 仍由同一 `records` 构建、循环内 `sourceMessageIds.get(memory.id) ?? null` 与原 `earliestSourceMessage(memory, sourceMessages)` 等价，输出不变）。`automatic-memory-service.ts` 只是常量提取（850 值不变）。发给模型的内容仍只追加，本条不引入每轮变化的前缀。`proactive.review.snapshot` 是发给网页的消息，不是模型请求；新增字段均为追加式。
2. **同一段文字是否会在不同请求里变成不同字节？** 未发现新引入的不稳定性：`pickMemoryCheckup` 四个队列都有确定性排序（lastUse/confidence 后按 id 决胜），conflict 队列当前恒空；`quiet` 是 Set 只做成员判断不迭代；`listWeek` 按 rowid 排序；抽样按 `seed|dayStart|key` 哈希，同日稳定；遮盖逻辑未触碰。带时间的字段（handledAt/now）都是数据值而非被遮盖文本。
3. **改动有没有对应的自动检查、反向用例会不会真的失败？** 部分有：配置边界反向用例（6、3651）会失败；合同 merge↔keep 交叉校验、服务端预算拒绝、rate 拒绝 checkup 键这三条防护在本提交内都没有反向用例（问题 2）——现在删掉这些防护，已提交的测试不会红。作者声称“预算限制（有测试）”只有等未提交文件落地才成立。
4. **每个新值的两端核对**：`proactive.review.checkup` 消息类型（UI 发送 proactive.ts:247 ↔ contracts-v2.ts 注册 :44/:2223 ↔ e2e 白名单）✓；`reviewMemoryUnusedDays`（strict-configuration.ts:1045，默认 90、7–3650，严格键列表 ↔ 配置接口 :231 ↔ service-main/production-proactive 消费 ↔ `integer(1)` 合同）✓；`DEFAULT_AUTOMATIC_CONFIDENCE_PERMILLE=850`（生产者与两个消费者同值）✓；`memorySourceState` 搬迁（逻辑逐行相同、全部调用方走重导出、集成测试路径已更新）✓；`checkup:` 键前缀（产生 daily-review.ts `reviewKey` ↔ 解析 parseReviewKey 三前缀 ↔ rate 拒绝 ↔ checkup 分支接受）✓；`memory_checkup` 组/`checkup` kind（DEFAULT_GROUPS ↔ 合同枚举 ↔ UI 渲染）✓；`before` 的 JSON 序列化（JSON.stringify ↔ JSON.parse，合同无此字段、仅入库）✓。未发现两端校验不匹配；唯一缺口是问题 2 的测试缺位，以及未提交的表约束只能以迁移落地为准（未核实）。

**总体**：作者的说法与代码高度一致，未发现虚报；最需要跟进的是问题 1 的非原子写入和问题 2 的防护测试缺位（后者与迁移一起补即可，前者建议在补迁移前先定补偿方案）。
