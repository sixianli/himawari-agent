# P3-5 线程方案 v2 审核报告

## 逐条核对方案前提（先说结论：6 条前提全部属实，1 条未核实）

| 前提 | 核对结果 |
| --- | --- |
| 1. 失败只审计+抛出 | ✓ `production-memory-capture.ts:855-857`、`:677` 与原话一致 |
| 2. 重试只认 `AI_GATEWAY_TOOL_CALL_UNSUPPORTED` | ✓ `production-model-composition.ts:633`；`generateTitle`（:647）和 `auxiliaryMemoryGeneration`（`production-run-composition.ts:561`，捕获/episode/整理共用）都走它 |
| 3. 准入要执行租约、同 slot 重放冲突 | ✓ `production-run-composition.ts:197`；`model-invocation-admission-service.ts:423-446` 的 identity 绑定 logicalSlot |
| 4. outcome 有数据库 CHECK | ✓ `0069_decision_ledger.sql:48-55` |
| 5. 网页未知 outcome 显示“待批准”、校准只认 discarded | ✓ `proactive-reminders.tsx:331-336`、`packages/calibration/src/index.ts:262-265` |
| 6. generationId 由 runId 派生 | ✓ `production-memory-capture.ts:784` |
| 7. 迁移号 | main 目前到 `0086_rule_book.sql`，与“0087 给 P2-2”一致；PR 366 是否已合未核实 |

---

## 证实的问题（严重度从高到低）

### 1.【高】“删消息/删对话即行消失（FK 级联）”与真实删除机制不符，按方案写的测试会测一条生产中不存在的路径
**证据**：全仓库 grep 不到任何 `DELETE FROM thread_messages`；治理删除对话时删 `runs`、`triggers`、`threads` 和 payload，**不删消息行**：
`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:783-789`
```
database.prepare("DELETE FROM runs WHERE thread_id = ?").run(objectId);
...
database.prepare("DELETE FROM threads WHERE id = ?").run(objectId);
```
（:751-756 只把 messageIds 收进 objectRefs 用于清 payload，不删行。）
**后果**：`ON DELETE CASCADE` 在生产中几乎永不触发。行真正消失靠的是 D 步：`readRunExecutionSource`（`sqlite-thread-operations.ts:1530-1534` 要求 thread `status='open'`）返回 undefined → `source_gone` 删行。结果碰巧对，机制描述错；E 列的“删消息后行级联消失”如果测试里直接 `DELETE` 消息行，就是假通过。
**建议**：B 改为“级联只作兜底，主路径是补做时读不到来源 → source_gone”；测试走真实治理删除 API（删对话/删 run），断言行经 `source_gone` 消失。

### 2.【高】重试/补做的 invocationId 和 purpose 有两个方案没列的使用端
**证据**：
- `service-main.ts:1986` `invocationId: \`${purpose}:${request.runId}\``——方案写的 `memory-capture:<runId>:retry` 按现有接线构造不出来（purpose 是唯一旋钮，会变成 `memory-capture-retry:<runId>`），要改接线或改方案里的 id 格式。
- `packages/application/src/ports/model-usage.ts:3-12` `MODEL_USAGE_PURPOSES` 是封闭清单，`:58-63` 不在清单里的 purpose 记成 `"other"`。新 purpose 不登记，重试/补做的模型花费全部落进 "other"，`cache-hit-report --by turn` 和用量分类就错了。
**建议**：方案明确最终字符串；若引新 purpose，同步加进 `MODEL_USAGE_PURPOSES`；若只换 invocationId，给 `generate` 接口加一个参数并把接线的调用点（`production-run-composition.ts:515`）一起改。

### 3.【中】每日评价对新 outcome 的处理点没列全
**证据**：`packages/application/src/services/daily-review.ts:204-207` `ledgerGroup` 把非 discarded/kept 的 memory_candidate 归 `"other"` 组；`:212-216` `ledgerActed` 把 capture_failed 当“已行动”；`:220-227` `reviewedMemoryIds` 会拿 `subjectRef`（= generationId，不是 memory id）去读记忆文本，读不到就显示空白。
**建议**：方案 C 点名这三个函数；capture_failed 条目没有可展示的记忆文本，要定展示内容（错误码/去向，方案说了“错误码进审计和日志”，但没有进 decision record 本身，网页拿不到）——建议把 `last_error_code` 放进 decision record 的 `counts` 或新字段，否则网页标签“这轮没记成”下面没东西可看。

### 4.【中】“start() 拿到准入后补做”的调度点和真实 promise 语义不符
**证据**：`start()` 返回的 promise 在 `permit.markStarted()` 即“模型调用开始”时就被 resolve（`production-run-composition.ts:577-579` 回调 `onAdmitted()`），不等捕获完成；`production-titled-runtime.ts:41-49` 正是在这个 promise 上接 episodes/consolidation。
**后果**：若补做接在同一个 promise 上，补做会和本轮捕获的尾部（写记忆、写决策）并发；若想等捕获完成，现有 `start()` 没有这个钩子。
**建议**：补做放进 `#capture` 完成之后的内部串行路径（同 owner 同时只允许一个补做），并在方案里写明；这也是“每轮最多 1 条”天然的执行点。

### 5.【中】测试没有反向用例，且漏了 `check:real-admission` 的登记义务
**证据**：仓库每道门槛都要求“改前失败、改后通过”（`docs/incidents-and-gates.md` 规则和 I-66/I-63 条目均如此）；方案 E 只列正向场景。另外 `scripts/check-real-admission-tests.mjs:47-53` 会扫描任何同时出现 `ModelInvocationAdmission*` 和 `.begin(` 的 src 文件，:79-83 未登记即报错——若补做逻辑放新文件直接触达 admission，`npm run check` 会被这一步拦下。
**建议**：E 补反向用例清单（去掉同轮重试、去掉入队、去掉补做、把 capture_failed 改回 discarded 时各哪条测试失败）；把新文件登记进 `REAL_ADMISSION_TESTS` 或复用 `ProductionMemoryCapture` 现有入口。

### 6.【低】重建 decision_ledger 时引用子表比 0069 时代多三张
**证据**：引用 decision_ledger 的表现有六处：`0070_decision_ledger_payloads.sql`、`0080_decision_signals.sql:5`、`0081_proactive_push_backoff.sql:16`、0069 里的 `source_insights`、`proactive_processed_messages`、`muse_reference_entries`。方案“照 0069 的做法”没有列全。
**建议**：迁移清单列全六处，契约测试对每处跑 `foreign_key_check` 并抽一行验证引用仍指到原 id。

### 7.【低】source_gone 的语义与端口实际行为有偏差：归档对话也会被判“原消息已删”
**证据**：`sqlite-thread-operations.ts:1530-1534` 要求 thread `status='open' AND archived_at IS NULL`。
**建议**：要么接受并在方案/文档写明“归档也视为来源不在”，要么补做前区分归档（归档可以保留行等主人回来）。

### 8.【低】待补队列无上限、无 TTL
主人暂停（跳过、保留）或主人长期不发消息时行永远留着；恢复后每轮只补 1 条。Sidekiq 的 dead set 也永久保留，这点不算违背业界，但建议把“暂停时是否保留、保留多久”列为 Andy 的决定项，并给补做加“积压超过 N 条时每轮多条”的排空上限。

### 9.【低】I-63 根因门槛仍缺，方案只字未提谁来关
**证据**：`docs/incidents-and-gates.md` I-63 状态“缺门槛”（“根因门槛待补：查清路由后，加‘辅助调用不应收到工具调用’的检查”）。本方案的 A 是第二次缓解，I-63 的关闭条件没有着落。
**建议**：在“需要 Andy 定”里加一条：本块合入后 I-63 是否改判、根因门槛归谁。

### 10.【低·顺手项】辅助调用的费用账户硬编码
`production-run-composition.ts:567` `gate.begin({ ...input, budgetAccount: "thread-title" })`——记忆捕获/episode/整理的花费全记在"thread-title"账户。本方案会增加这类调用次数，归因误差放大，建议本次一并修。

---

## 推测（未完全证实）

- 方案 A 说“复用同一份遮盖表”要求连 `externalTag()` 的 tag 函数也只取一次（`production-memory-capture.ts:830` 每次尝试都会取）；tag 在同一 run 内应当确定，但未逐行核实其实现。实现时明确“一次取、两处用”。
- `relevantMemoryIds` 来自 `recalled` Map（`production-run-composition.ts:503`、`:228`），按 runId 记忆化，重试时取值一致——从代码看成立，未跑测试证实。

## 侧重检查（测试覆盖 / 文档一致 / 普通流程走查）

**走查流程**：主人在网页发消息 → run → `production-titled-runtime.ts:38-49` 在第一条 assistant 事件上触发 `titles.start` 和 `memoryCapture.start` → `#capture` 读 source/payload/消息/记忆 → `auxiliaryMemoryGeneration`（`production-run-composition.ts:552-560`，admission + 预算）→ `generateTextOnce` → `parseMemoryCandidates` → `automatic-memory-service` 写记忆 + decision ledger（`automatic-memory-service.ts:526`，id = `generationId:ordinal:outcome:reasonCode`）。
**无测试覆盖的路径（改动前就存在）**：捕获失败的完整路径（今天只到 `onFailure` 写 `memory-capture.failed` 日志）；`production-titled-runtime.ts:41-49` 的后台链编排本身；purpose→usage 归类接线。方案 E 补上了主要路径，但第 4、5 条指出的调度点和接线的测试缺口仍在。
**文档一致性**：`.claude/rules/prompt-prefix.md` 和 kv-cache-guide 不需要改（方案不触碰对话请求）；方案没列“交付时更新 incidents-and-gates.md 的 I-63 条目、登记新门槛”这一步，建议补上。

## 必答问题

1. **不会改变模型已见过的请求开头。**记忆捕获是后台单发调用（prompt-prefix 规则第六节第 15-17 条），方案不触碰对话的系统提示、工具定义、历史和遮盖；同轮重试复用同一份提示词字节与遮盖表，是新的 side call 而非改写已发内容；补做按当前状态重建提示词也是全新调用。每轮变化的值仍只在对话请求的最后一条消息里——本方案没动那条组装路径，`check:prompt-prefix` 继续覆盖。
2. **同轮重试不会**（复用同一字节+遮盖表）；**补做不存在“同段文字变字节”问题**，因为每次都是新调用：提示词所依赖的排序都已固定（`sqlite-memory-book-operations.ts:249` 的 `ORDER BY category, count DESC, sub_category`；`production-memory-capture.ts:781` people 按 updatedAt、`:51-59` 稳定排序）。建议 E 把这三处排序依据写进断言，防以后有人去掉排序。
3. **有对应的自动检查**（E 列的集成测试 + `check:memory-capture-retry` 进 `check:steps`，与 `check:memory-relevance` 的先例一致；`npm run check` 现在确实不跑集成测试，已核实 package.json:27）。**但反向用例没写**，且漏了 `check:real-admission` 登记义务（见问题 5）——按仓库门槛惯例这两点必须补，否则不算落了门槛。
4. **有两个使用端没核对到**：invocationId/purpose 的构造点（`service-main.ts:1986`）和 `MODEL_USAGE_PURPOSES` 白名单（见问题 2）；capture_failed 的消费端漏了 daily-review.ts 三处（见问题 3）；FK 级联的产生端判断错误（见问题 1）。其余值（generationId 不变、迁移 CHECK 双端同改、网页/校准/数据导出的 outcome 均为自由文本 `boundedString(64)`/`text(1,64)` 不会拒收）核对无误。

## 如果由我来定

保留 A/C/D/E 骨架（“重试一次 + 持久化队列 + 死信”对标 Sidekiq/SQS DLQ 是对的；capture_failed 用新 outcome + 重建表我也同意——0069:48-55 的 CHECK 证实 v1 草稿“不用重建表”确实错了）。改四处：
1. **B**：消失机制以 source_gone 为主路径、FK 为兜底，测试按治理删除写；
2. **C**：消费端清单补全（daily-review 三函数 + 展示文本来源、`MODEL_USAGE_PURPOSES`、`check:real-admission` 登记、decision_ledger 六处子表引用）；
3. **D**：调度点改为捕获完成后内部串行，补做与本轮捕获互斥，归档对话的处理明确化；
4. **E**：补“改前红、改后绿”的反向用例声明；“需要 Andy 定”加 I-63 根因门槛归属和队列 TTL 两项。
