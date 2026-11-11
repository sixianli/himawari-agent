## 总体判断

方向对：抽取失败需要“有限重试 + 持久化待补 + 可见记录”，这与 SQS 死信队列的“超过 `maxReceiveCount` 再进 DLQ”思路一致。但方案里有几处会直接影响数据不丢、可见性是否真实、以及迁移安全，建议先改再动手。

方案对 `0069_decision_ledger.sql` 的 CHECK 判断是对的：`outcome` 确实被 `0069:48-55` 限制为 `kept/discarded/pending_approval`，不能只改代码。

---

# 已证实的问题（按严重度从高到低）

## 1. [高] 首次失败到入队之间崩溃，会永久丢失这次捕获

**问题：** A 先同轮重试，B 只在重试再失败后才写 `memory_capture_backlog`。如果进程在第一次失败后、重试或写 backlog 之前退出，这次捕获既不在队列里，也没有持久记录，只会留下一条日志/审计；`start()` 的 `#captured` 是内存集合，重启即丢。

**证据：**
- 当前抽取阶段失败路径：`apps/agent-service/src/production-memory-capture.ts:820-858`，`catch` 里只 `audit("extraction_failed")` 后 `throw`。
- `start()` 只把错误交给 `onFailure`：`production-memory-capture.ts:676-681`。
- 方案 B 写的是“再失败 → 持久化待补队列”，即入队发生在重试之后。

**建议：**
第一次抽取失败就先把 backlog 行写入（状态 `pending`），再决定是否同轮重试；重试成功则删除该行，重试失败则更新 `attempts/last_error_code`。这样任何时刻崩溃都能从队列恢复。加一个“第一次失败后进程终止、新实例启动仍能补做”的测试。

---

## 2. [高] 补做候选可能选中“本轮刚入队”的行，导致一轮内 3 次调用甚至提前 gave_up

**问题：** D 说“`start()` 本轮捕获拿到准入后，取本 owner/agent 最旧的一条待补项补做”。如果当前捕获第二次失败后刚写入一行，而队列里没有更旧的行，这一行就是“最旧的一条”，会在同一轮被补做。于是同一轮变成：首次调用 + 同轮重试 + 补做，共 3 次；补做失败再计一次，可能在本轮就走到 `gave_up`，违背“每轮最多 1 条补做”和“补做不再同轮二次重试”的意图。

**证据：**
- `start()` 每次运行只处理一个 run：`production-memory-capture.ts:660-683`。
- 方案 B 在重试失败后入队；D 又说同轮取最旧补做，未排除 `source_run_id = 本轮 runId`。
- 当前测试 fixture 也只按 `runId` 生成一次 capture：`test/integration/production-memory-capture.test.ts:202-249`。

**建议：**
补做选择必须在当前捕获开始前完成，或显式排除 `source_run_id = 当前 runId` / 当前 `generationId`；补做应在当前捕获结束后串行执行。测试要断言：只失败一次的那个 run，模型调用次数不超过 2；补做只发生在后续 run。

---

## 3. [高] 为新增 `capture_failed` 重建 `decision_ledger`，风险和收益不匹配，且后续迁移的引用比 0069 更多

**问题：** `0069` 的 CHECK 确实需要改，但“重建整张 `decision_ledger`”不是低成本迁移。后面已有多个迁移引用它，且 0069 自己的子表也不止一个。方案说“照 0069 的做法处理引用它的子表”，但 0069 当时是新建表并复制；后续结构更复杂，若漏掉任何一个子表/索引/触发器，会丢评分、丢信号或让外键悬空。

**证据：**
- 0069 的 CHECK：`packages/persistence-sqlite/src/migrations/0069_decision_ledger.sql:48-55`。
- 0069 子表：`source_insights.decision_id`（`0069:89`）、`proactive_processed_messages.decision_id`（`0069:105`）、`muse_reference_entries.paired_decision_id`（`0069:135`）。
- 后续引用：`0070_decision_ledger_payloads.sql:2`、`0080_decision_signals.sql:5`（还有 `0080:17-28` 的索引和触发器）、`0081_proactive_push_backoff.sql:16`、`0084_memory_consolidation_basis.sql:15`。
- 方案 C 只提到“查 foreign_key_check、行数和评分不丢”，没提信号、payload 关联、push backoff、触发器和索引。

**建议：**
优先**不重建**。两个更稳的替代方案：
1. 沿用 `discarded` + 新 `reasonCode`（如 `capture_retrying/capture_queued/capture_gave_up/capture_source_gone`），在网页和校准里按 `reasonCode` 映射成“这轮没记成”，代码和 DB CHECK 都不用动。
2. 新增独立的 `memory_capture_failures` 表作为失败生命周期来源，决策记录只在终态写一条 `discarded`/`reasonCode`，不要为一个 UI 标签改核心账本。

如果 Andy 坚持新 outcome，则迁移必须逐一覆盖上述子表、索引、触发器和 0080 的历史回填逻辑，并用迁移契约测试验证评分、信号、payload、backoff、行数、外键和触发器全部保留。不要只测 `foreign_key_check`。

---

## 4. [高] `source_gone` 与 `source_message_id ON DELETE CASCADE` 互相矛盾

**问题：** 方案 B 把 `source_message_id` 设为 `thread_messages ON DELETE CASCADE`，删对话/删消息时队列行直接消失；D 又说“补做时原消息/对话不在 → 删行 + `source_gone`”。在现有删除路径下，行已经被级联删掉，补做逻辑根本看不到它，`source_gone` 分支不可达。测试 E 同时要求“删消息后行级联消失”和“source_gone”，这两个目标只能选一个。

**证据：**
- `thread_messages.thread_id REFERENCES threads(id) ON DELETE CASCADE`：`packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:88-100`。
- 永久删除对话会先删 runs、再删 threads：`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:781-789`，`thread_messages` 随之级联删除。
- 现有代码没有“单独删除一条 thread_message”的路径（搜索结果里只有删除 thread/search projection），所以按当前路径 `source_gone` 基本不可达。

**建议：**
二选一：
- 保留 CASCADE，接受“删对话即静默放弃待补”，不写 `source_gone`，并在文档和测试里明确；
- 改成 `ON DELETE SET NULL`（`source_message_id` 可空），补做时发现为空再写 `source_gone`；或者用删除触发器在级联前写一条终态记录。

不要同时承诺“级联消失”和“source_gone”。

---

## 5. [高] `retrying` 记录和成功记录会同时存在，新标签“这轮没记成”同样误导

**问题：** C 要求“每次失败一条”，第一次失败写 `capture_failed/reasonCode=retrying`，同轮重试成功后又照常写 `kept/discarded/pending_approval`。这样一次最终成功的记忆会在每日评价里出现两条：一条“这轮没记成”，一条“已存/已跳过”。这正是方案自己用来反对“沿用 discarded”的理由，换成新 outcome 并没有消除，只是换了个标签。

**证据：**
- 方案 C：“每次失败一条”“成功（同轮重试成功或补做成功）照常写 kept/discarded/pending_approval”。
- 当前网页对未知 outcome 的映射：`apps/control-center/src/components/proactive-reminders.tsx:331-336`，非 `discarded`/`kept` 的 `memory_candidate` 会落到“待批准”。
- 每日评价当前把非 `discarded`/`kept` 的候选归到 `other`：`packages/application/src/services/daily-review.ts:201-216`；`ledgerActed` 还会把它当“已行动”（`daily-review.ts:212-215`）。

**建议：**
`retrying` 只写审计/日志和 backlog 状态，不写决策记录；决策记录只写**终态**：`queued`、`gave_up`、`source_gone`，或成功后的 `kept/discarded/pending_approval`。如果确实要保留重试轨迹，把它放在 backlog 的 `attempts` 或单独的 `memory_capture_attempts` 表，不要混进用户每天打分的同一组。

---

## 6. [中] 重试分类过宽：默认重试“其余所有错误”会把确定性失败也重试

**问题：** A 只排除 `DISCLOSURE_DENIED`、`ADMISSION_UNAVAILABLE`、`MODEL_UNAVAILABLE`、失去执行权、暂停，其余全重试。但 `AI_GATEWAY_OUTPUT_TRUNCATED` 在 transport 里明确是 `retryable=false`，同 prompt、同 `maxOutputTokens` 重试很可能再次截断；`RESPONSE_INVALID` 也可能是提示词或模型输出格式的确定性问题。`AI_GATEWAY_TOOL_CALL_UNSUPPORTED` 也被标记为不可重试，方案却把它列为可重试。

**证据：**
- `packages/runtime-pi/src/pi-model-transport.ts:451-464`：工具调用和输出截断都以 `retryable=false` 发出 `failed`。
- 现有 `generateText` 只对 `AI_GATEWAY_TOOL_CALL_UNSUPPORTED` 重试一次：`apps/agent-service/src/production-model-composition.ts:624-639`。
- 方案 A：“其余（含 RESPONSE_INVALID、RESPONSE_INCOMPLETE、TOOL_CALL_UNSUPPORTED、PORT_CONFLICT、超时）都重试”。

**建议：**
改成**可重试白名单**，并优先使用 transport 的 `retryable` 标记/稳定错误码：
- 可重试：网络超时、5xx、明确的临时端口/租约错误。
- 不重试：输出截断（应调整 `maxOutputTokens` 或提示词）、解析失败（除非有证据说明是随机输出）、披露拒绝、模型不可用、准入不可用、失去执行权、暂停。
- 如果 I-63 的 `TOOL_CALL_UNSUPPORTED` 要保留为一次显式重试，请单独列出并配指标，不要用“其余都重试”兜底。

---

## 7. [中] 现有 `generate` 接口无法按方案指定 `invocationId`，也无法关闭内层重试

**问题：** 方案 A/D 要求 `memory-capture:<runId>:retry`、`memory-capture:<当前 runId>:backlog`，但生产接线里的 invocationId 是由 `service-main` 用 `purpose + request.runId` 拼出来的，`ProductionMemoryCaptureOptions.generate` 也只接收 `(request, prompt, onAdmitted)`，没有传入 invocationId 或“禁用内层重试”的参数。不改接口，补做和重试会拿到和当前捕获相同的 invocationId，直接命中方案自己说的“同一 logical slot 再 begin 会被当重放/冲突”。

**证据：**
- `apps/agent-service/src/service-main.ts:1981-1992`：`invocationId: ${purpose}:${request.runId}`。
- `apps/agent-service/src/production-run-composition.ts:552-587`：`generate` 接口只透传 request/prompt/gate，没有 invocationId 覆盖。
- `production-memory-capture.ts:640-644`：`generate` 的签名没有选项参数。
- 内层重试会在 `text.invocationId` 后追加 `:retry`：`production-model-composition.ts:635-638`，与方案的 `:retry` 命名会冲突。

**建议：**
把 `generate` 扩成显式接收 `{ invocationId, retry: "none" | "tool-call-once" }`，由调用方决定；或者让 memory capture 自己生成完整 invocationId 并透传给 `auxiliaryMemoryGeneration`。测试要断言：同轮两次调用 invocationId 不同；补做与当前捕获不同；关闭内层重试后总调用次数符合预期。

---

## 8. [中] 新 outcome / 新分组的消费方没有列全，且每日评价和校准是两套不同的分组

**问题：** 方案 C 只写到网页标签、每日评价/校准分组和 gateway 契约。实际至少这些地方都要改，漏一个就会出现“新记录显示成待批准”“周报里显示成外部读取记忆”“每日评价里根本不出现”等问题。

**证据与缺口：**
- 决策 outcome 的代码校验：`packages/application/src/ports/decision-ledger.ts:42-50`。
- 数据库 CHECK：`0069:48-55`。
- 网页 review 标签：`apps/control-center/src/components/proactive-reminders.tsx:331-336`。
- 每日评价的独立 `DailyReviewGroup` 和默认队列：`packages/application/src/services/daily-review.ts:15-28`；`DEFAULT_GROUPS` 没有新组时，新组不会被 `queues` 选中（`daily-review.ts:98-107`），只会被算进 `notSampled`，用户看不到。
- 每日评价的文本/行动映射：`daily-review.ts:201-216`、`:220-236`。其中 `reviewedMemoryIds` 对非 `discarded` 的 `memory_candidate` 把 `subjectRef` 当 memory id；方案 C 的 `subjectRef = generationId` 会被拿去 `readMemory(generationId)`，结果文本为空、显示“正文不显示”。
- 校准分组：`packages/calibration/src/index.ts:15-25`、`:36-46`、`:48-58`、`:60-72`、`:259-270`。
- gateway 校准分组枚举：`packages/gateway-contracts/src/contracts-v2.ts:756-766`。
- 每日评价标签：`apps/control-center/src/i18n/resources/zh-CN.ts:946-955`、`en.ts:1006-1015`、`ja.ts:1007-1016`；消息 ID 清单 `apps/control-center/src/i18n/message-ids.ts:885-894`。
- 周报分组文案：`zh-CN.ts:1242-1247`、`en.ts:1342-1347`、`ja.ts:1331-1336` 的 `weekly.group` select。新组若不补，会落到 `other`，显示成“外部程序读取记忆”。

**建议：**
把 outcome/reasonCode → 展示组、评分项、标签的映射集中到一个共享函数（例如 calibration 或 application 的单一映射），然后补：
- `DECISION_OUTCOMES` 与 DB CHECK；
- `DailyReviewGroup`、`DEFAULT_GROUPS`、`ledgerGroup`、`ledgerActed`、`reviewedMemoryIds`；
- `CALIBRATION_GROUPS`、`APPLICABLE`、`GROUP_LABELS`、`RATING_LABELS`、`calibrationGroup`；
- gateway 的 `calibrationGroupSchema`；
- 三个语言的 `dailyReview.tag.*`、`weekly.group`、`weekly.groupInfo`，以及 `message-ids.ts`；
- `proactive-reminders.tsx` 的 `reviewTag`。

注意：gateway 的 `proactiveReviewItem.outcome` 是 `machineString`（`contracts-v2.ts:539-543`），不需要为 outcome 改契约；真正需要改的是校准分组枚举。方案里“gateway 契约同步”说法太笼统，容易漏。

---

## 9. [中] 补做无法可靠读取“原消息”和“原上一条助手消息”，当前端口不够

**问题：** 现有 `#capture` 只从 `listMessages(watermark - 50, 50)` 里找 owner 消息和上一条助手消息（`production-memory-capture.ts:717-742`）。补做的是旧消息，可能早已不在最近 50 条窗口里；`ProductionMemoryCaptureOptions.threads` 也只声明了 `read` 和 `listMessages`（`:623`）。要按 `source_message_id` 补做，必须新增读取能力。

**证据：**
- `ThreadRepositoryPort` 已有 `readCommittedMessagesByIds`：`packages/application/src/ports/threads.ts:316-318`，但 memory capture 的 `threads` 类型只 Pick 了 `read | listMessages`（`production-memory-capture.ts:623`）。
- 当前 `#capture` 按 watermark 窗口找消息：`production-memory-capture.ts:717-727`。
- 方案 D 没有提到读取原 `owner.committedAt`、上一条 assistant 消息、原消息 classification 的端口。

**建议：**
`threads` 增加 `readCommittedMessagesByIds`，按 `ownerId/agentId/threadId/messageId` 精确读原消息；再按原 `sequence` 找前一条 assistant 消息。补做时用**原消息的 classification**，不要用当前 run 的；同时验证当前模型 descriptor 允许该 classification。

---

## 10. [中] 补做没有检查对话是否已进入 trash/deletion 状态

**问题：** 现有 `threads.read` 返回的 thread 有 `status`（`0001:81` 含 `trashed`、`deletion_pending`、`deleted_verified`），但 `#capture` 没有检查状态。永久删除会级联删消息，但“移到回收站”只改 status，消息还在。方案 D 只写了“原消息/对话不在”，没有写“对话已 trashed”。如果补做在用户把对话丢进回收站后运行，仍可能把旧内容重新写成记忆。

**证据：**
- thread 状态定义：`packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:81`。
- 当前捕获只 `threads.read` 后直接使用，没有 status 检查：`production-memory-capture.ts:715-716`。
- 方案 B 的 `ON DELETE CASCADE` 只覆盖永久删除，不覆盖 trash。

**建议：**
补做前检查 thread status 必须为 `open`；`trashed/deletion_pending/deleted_verified` 都视为 `source_gone`（或直接删除行，按产品决定）。加测试：thread 移到 trash 后，下一轮不补做。

---

## 11. [中] 队列没有上限、退避、原子领取和真正的“死信”，资源耗尽与并发问题未解决

**问题：** 方案 B 的 backlog 只有 `attempts/last_error_code/created_at/updated_at`，没有：
- 每 owner/agent 的行数上限；
- `next_attempt_at`/退避；
- 原子 claim（两个并发 run 可能同时取到同一条）；
- 终态保留（`gave_up` 直接删行，用户没有手动重试入口，不是真正的 DLQ）。

这会让“持久化待补”在长期失败或大量失败时无限增长，或者连续几条用户消息就把 3 次补做耗尽。

**证据：**
- 方案 D：“每轮最多 1 条”“第 3 次补做失败 → 删行 + gave_up”。
- AWS SQS DLQ 的一手说明：“Amazon SQS supports dead-letter queues (DLQs), which source queues can target for messages that are not processed successfully.” 并建议 `maxReceiveCount` 足够大、DLQ 保留期长于源队列：https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html
- Sidekiq 的 retry/dead set 类比合理，但本次 GitHub wiki 返回 403，未能用一手页面核对，标为未核实。

**建议：**
backlog 增加 `status`（`pending/processing/gave_up`）、`next_attempt_at`、`claimed_by/claim_expires_at`、`terminal_at`；按 `(owner_id, agent_id, status, next_attempt_at, created_at)` 建索引；用 `UPDATE ... WHERE status='pending' AND next_attempt_at<=now() RETURNING` 原子领取；按 owner/agent 限制最大行数；`gave_up` 保留终态行并提供手动重试/清理，而不是直接删。加并发测试：两个 run 同时补做只有一条成功领取。

---

## 12. [中] 自动检查不足，且新增脚本不加进 `check:steps` 就不会被 `npm run check` 执行

**问题：** E 只列了正向场景，没有说反向用例怎么失败；并且 `npm run check` 读取的是 `package.json` 的 `check:steps`，只新增 `check:memory-capture-retry` 脚本而不加入 `check:steps`，实际不会执行。

**证据：**
- `package.json:26-27`：`check` 调 `node scripts/run-all-checks.mjs`；`check:steps` 是一长串 `npm run ...`。
- `scripts/run-all-checks.mjs:32`：从 `check:steps` 解析步骤名。
- 方案 E 没有列出“撤掉某段实现后测试必须失败”的 mutation 用例。

**建议：**
把 `check:memory-capture-retry` 加进 `check:steps`，并至少覆盖这些反向用例：
- 去掉同轮重试 → 首次失败重试成功用例失败；
- 重试复用同一个 invocationId → 准入冲突用例失败；
- 不关闭 `generateText` 内层重试 → 调用次数用例失败；
- 第二次失败不写 backlog → 下一轮补做用例失败；
- 补做选中当前 run 刚入队的行 → 同轮调用次数超过 2，用例失败；
- 允许不可重试错误重试 → 调用次数/错误用例失败；
- 迁移漏掉子表/信号/评分 → 迁移契约失败；
- 补做读其他 owner/agent 的消息 → 安全用例失败；
- 同轮重试的 prompt 字节或 placeholder 表变化 → 字节比较用例失败。

---

## 13. [低/脆弱] 列表顺序和遮盖表的确定性依赖隐含条件

**问题：** `confirmedFirstByRecency` 只按 `tentative` 和 `updatedAt` 排序，没有 `id` 作为最后的 tie-breaker（`production-memory-capture.ts:51-59`）。目前底层 `listActive` 是 `ORDER BY id`（`sqlite-memory-operations.ts:942-953`），JS 排序又是稳定的，所以今天大概率确定；但方案把“列表排序已固定”当成前提，却没有在比较器里固定兜底，也没有测试相同 `updatedAt` 的情况。补做如果换一种读取路径，顺序就可能变。

同轮重试方面，当前 `externalTag()` 在 try 内每次调用（`production-memory-capture.ts:830`），`placeholderTable(prompt, tag, ...)` 也在 try 内计算（`:836-839`）。方案说“复用同一份提示词字节和遮盖表”，但实现如果只是循环调用 `#capture`，会重新取 tag、重新建表，同一段文字会遮成不同字节。

**证据：**
- 规则第 10、11 条要求列表顺序和遮盖字节确定：`.claude/rules/prompt-prefix.md:51-54`。
- `confirmedFirstByRecency`：`production-memory-capture.ts:51-59`。
- tag/table 在 try 内：`production-memory-capture.ts:830-839`。

**建议：**
给 `confirmedFirstByRecency` 补 `id.localeCompare` 兜底；在 prompt 构造处显式排序 `subCategories` 和 `people`；同轮重试把 `prompt/tag/table` 作为局部变量只计算一次，测试断言两次请求的 prompt 字节和 placeholder 完全一致。补做重建 prompt 时，若 key 轮换导致同一段旧文字遮成不同字节，要在日志/文档里说明这是有意为之，不是 bug。

---

## 14. [低] 决策记录 id、`last_error_code` 和 attempts 的边界值没有按现有约束核对

**问题：** 方案说“id 由 generationId + 第几次尝试确定性派生”，但 `decision_ledger.id` 有 `length(id) BETWEEN 1 AND 128`（`0069:2`），`validateLedgerWrite` 也限制 1-128（`sqlite-decision-ledger-operations.ts:57`）。直接用原始 generationId 拼 attempt，长度和字符都不可控。`last_error_code` 如果直接存 provider 的 `error.message`，可能包含响应体、请求 ID 或敏感内容，也没有长度限制。

**证据：**
- id/ reasonCode 校验：`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:49-63`。
- 现有安全做法是哈希：`packages/application/src/services/automatic-memory-service.ts:87-89`。
- `insertLedgerRow` 对 id 冲突是 `ON CONFLICT (id) DO NOTHING`（`sqlite-decision-ledger-operations.ts:98-107`），如果误用同一 id 更新 reason，会被静默忽略。

**建议：**
沿用 `ledgerId(...)` 或同样长度的 sha256 前缀，不要直接拼原始字符串；`last_error_code` 用 `stableErrorCode`/固定枚举并加 `length BETWEEN 1 AND 64` CHECK；`attempts` 加 `BETWEEN 0 AND 3` CHECK；如果同一 attempt 可能从 `retrying` 变成 `queued`，不要用同一个 id 指望覆盖（现在不会更新）。

---

## 15. [低] 数据导出、policy 版本和文档没有跟上

**问题：**
- 新表 `memory_capture_backlog` 不在数据导出快照里（`packages/persistence-sqlite/src/data-export/snapshot.ts:8-28` 没有它），备份/恢复后待补工作会丢。若这是有意的，需要写明；若数据导出要求完整产品状态，应加入。
- `MEMORY_CAPTURE_POLICY_VERSION = "memory-capture:v5"`（`production-memory-capture.ts:47`）。如果补做会按当前记忆状态重建提示词、改变抽取行为，应考虑是否 bump policy version，或至少在新记录里写清 `policy_version`/`attempt`。
- 方案说“不改提示词文字、系统提示、敏感规则”是对的；但应在 ADR/规则里写清：后台调用不是跨尝试“只追加”，同轮重试必须复用字节，补做重建数据段是有意的。`.claude/rules/prompt-prefix.md:67` 只要求固定在前、会变的在后，不要求后台调用跨尝试逐字节相同。

**建议：**
明确数据导出是否包含 backlog；policy version 是否变化；新增 ADR 记录“重试/待补/失败记录”的生命周期，并和 `.claude/rules/prompt-prefix.md` 第六节对齐。

---

# 推测 / 未核实

- **Sidekiq 的 retry/dead set 具体行为**：本次 GitHub wiki 返回 403，未能用一手页面核对；AWS SQS DLQ 文档可作为“有限接收次数后进死信队列”的一手依据。
- **ChatGPT/Claude 记忆写入失败对用户不可见**：方案没有给一手来源，无法核实；不要把它当作设计依据。
- **迁移号 0087-0089**：当前仓库最新迁移是 `0086_rule_book.sql`，`0087` 给 P2-2、`0088/0089` 预留的说法在当前检出中看不到，需等 P2-2 合并后按 main 重新确认。
- **补做时 trashed thread 是否会被处理**：代码层面没有 status 检查，但补做实现尚未存在，属于“按现有结构很可能发生”，标为推测；建议直接用测试锁定。
- **同一轮自选 backlog**：取决于 D 的实现顺序，方案文字有歧义；按字面“本轮捕获拿到准入后取最旧”存在自选风险，标为方案歧义而非已发生 bug。

---

# 侧重检查

我按错误路径、不可信输入、安全、资源耗尽、不可撤销操作、规则/文档一致性逐项看了：

- **错误路径：** 抽取的 generate/parse 失败已有审计（`production-memory-capture.ts:820-858`）；但重试/入队之间的崩溃窗口、backlog 写入失败、ledger 写入失败、补做时消息/线程不存在、暂停、失去执行权，方案都没有给出明确的状态转换。最严重的是首次失败未持久化就崩溃。
- **不合规范/不可信输入：** 模型输出已由 `parseMemoryCandidates` 校验；风险主要在 `last_error_code` 不能直接存 provider 原文、补做读取旧消息必须按 owner/agent/thread 限定、不能拿 `generationId` 当 memory id 去读正文（`daily-review.ts:224-226`）。
- **安全：** 补做跨线程读取旧消息，必须验证 `ownerId/agentId/threadId/messageId` 四元组；补做应使用原消息 classification 并确认当前模型允许该分类；trashed thread 不应继续补做；`source_message_id` 外键和 owner/agent 外键都要有，避免跨租户或残留。
- **资源耗尽：** 当前方案没有队列上限、退避、原子领取、终态保留；每轮至少一次当前捕获，可能再加一次补做，重试还会增加模型调用；`budgetAccount: "thread-title"`（`production-run-composition.ts:567`）会让重试消耗标题预算。建议加 `next_attempt_at`、claim、行数上限和独立预算/指标。
- **不可撤销操作：** `gave_up` 直接删行（方案 D）之后没有手动重试入口；删除对话会级联删 backlog（方案 B），这两者都是不可撤销的放弃。要么保留终态行，要么在 UI/文档明确“删对话即放弃待补”。
- **规则/文档/代码一致性：** 主对话请求没有改系统提示/工具/历史，符合 `.claude/rules/prompt-prefix.md:35` 的只追加；后台调用 `memoryCapturePrompt` 是固定指令在前、数据在后，符合 `:67`。但方案把“补做按当前记忆状态重建”说成“列表排序已固定”，比较器本身没有 id tie-breaker，且没有把同轮重试的 tag/table 复用写成测试。决策记录重建、gateway 校准枚举、i18n、message-ids、daily review 分组之间也还没有形成单一映射。

---

# 如果由我来定，我会这样改

1. **持久化优先：** 第一次抽取失败就写 backlog（`pending`），不要等重试失败；重试成功删除，失败更新。backlog 是唯一事实来源，审计/日志只是辅助。
2. **不做同轮“自补做”：** 补做只从**本轮开始前**已存在的行里选，排除当前 `source_run_id/generationId`，并且在本轮捕获结束后串行执行。
3. **不改 `decision_ledger` 表结构：** 用 `discarded` + 新 `reasonCode` 表示终态失败，网页/校准按 reasonCode 映射；或者单独建 `memory_capture_failures` 表。只有终态写决策记录，`retrying` 不进用户每天打分的池子。
4. **重试白名单化：** 只重试临时错误；输出截断不重试，改为调整输出上限或提示词；工具调用错误如果保留为 I-63 缓解，单独列一条并配指标。
5. **接口显式化：** `generate` 接受 `invocationId` 和 `retry` 策略；同轮重试复用 prompt/tag/table，补做用当前 run 的 lease 但用原消息的 classification/source。
6. **补做安全边界：** 加 `readCommittedMessagesByIds`；检查 thread status、owner/agent/thread/message 归属、暂停、原消息存在；跨线程补做必须走原消息的 classification 和模型披露校验。
7. **队列工程化：** `status/next_attempt_at/claimed_by/claim_expires_at/terminal_at`、原子领取、索引、每 owner/agent 上限、终态保留和手动重试；加并发、退避、崩溃恢复测试。
8. **消费方一次改全：** 用共享映射统一 `capture_failed`/`memory_capture_failed` 到每日评价、校准、周报、网页标签；补 gateway 校准枚举、三语文案、`message-ids.ts`。
9. **门槛：** `check:memory-capture-retry` 加进 `package.json` 的 `check:steps`，并带 mutation 反向用例；迁移契约覆盖 0069 子表、0070、0080（含触发器和索引）、0081、0084。

---

# 必答问题

## 1. 会不会改变模型已经见过的请求开头？

**不会（按当前方案的正确实现）。** 这个改动只新增辅助模型调用和数据库/队列写入，不改主对话的系统提示、工具定义、历史消息或遮盖规则；主请求仍然是“固定内容在前、末尾追加当轮内容”，符合 `.claude/rules/prompt-prefix.md:35`。`memoryCapturePrompt` 也是固定指令 `MEMORY_CAPTURE.text` 在前，`existingMemories`、`previousAssistantMessage`、`messageSentAt`、`ownerMessage` 在后（`production-memory-capture.ts:177-193`），符合 `:67` 的后台调用顺序。补做重建的是**新的辅助请求**，不是修改已发给模型的对话前缀；只要不把记忆写进系统提示/工具定义，下一轮变化的记忆仍只出现在最后一条用户消息里。

需要守住的前提：同轮重试必须复用同一份 `prompt/tag/table`；补做不要为了“复用前缀”去改已经发过的对话历史。方案 A 的“复用同一份提示词字节和遮盖表”是正确方向，但当前代码在 try 内重新取 tag/建表（`:830-839`），实现时要显式缓存。

## 2. 会不会让同一段文字在不同请求里变成不同字节？

**同轮重试：不应该，也必须用测试锁住。** 方案 A 说了复用提示词和遮盖表，这是对的；如果实现成重新调用 `externalTag()` 或重新读记忆列表，同一段文字就会变成不同 placeholder。补做是**新的后台请求**，它按当前记忆状态重建数据段，本来就会和原请求不同；这不是违反“已发内容只追加”，但必须在 ADR/文档里写明。补做内部只要当前状态相同，列表应确定：`listActive` 是 `ORDER BY id`（`sqlite-memory-operations.ts:942-953`），`listSubCategories` 也有固定排序（`sqlite-memory-book-operations.ts:244-251`），但 `confirmedFirstByRecency` 缺少 id 兜底（`production-memory-capture.ts:51-59`），建议补上并测试相同 `updatedAt`。另外，遮盖 key 轮换会让同一段文字遮成不同字节，这是已知的缓存失效场景，补做应记录/说明，不要假装不变。

## 3. 有没有对应的自动检查，反向用例真的会失败？

**目前没有；方案 E 也不够。** 现有 `npm run check` 不跑集成测试，新增脚本必须加进 `package.json:27` 的 `check:steps`，否则 `scripts/run-all-checks.mjs:32` 不会执行它。方案列的正向场景还不能证明反向会失败；至少要加第 12 节列出的 mutation 用例：去掉重试、复用同一 invocationId、不关闭内层重试、不写 backlog、允许不可重试错误、同轮自选 backlog、迁移漏子表、跨 owner 读取、prompt/placeholder 字节变化。迁移契约还要覆盖 0069 子表、0070、0080 触发器和索引、0081、0084，而不只是 `foreign_key_check` 和行数。

## 4. 每个新值的使用方都能接受吗？

**不能，方案列得不够全。** 需要逐个核对：

- `capture_failed`：代码 `DECISION_OUTCOMES`（`decision-ledger.ts:42-50`）和 DB CHECK（`0069:48-55`）必须同时改；`validateLedgerWrite` 用的是代码列表（`sqlite-decision-ledger-operations.ts:55-56`），与 DB 是两道独立校验，缺一就会插入失败。
- `memory_capture_failed` 分组：`daily-review.ts:15-28` 的 `DailyReviewGroup` 和 `DEFAULT_GROUPS`、`ledgerGroup`、`ledgerActed`、`reviewedMemoryIds`；`calibration/src/index.ts:15-25、36-46、48-58、60-72、259-270`；`contracts-v2.ts:756-766` 的 gateway 枚举；三语 `weekly.group`/`weekly.groupInfo` 和 `dailyReview.tag.*`；`message-ids.ts:885-894`；`proactive-reminders.tsx:331-336`。漏掉任何一处，新记录会显示成“待批准”“外部程序读取记忆”或干脆不出现。
- `memory_capture_backlog`：迁移文件要进 `loadBundledMigrations`；`generation_id` 主键、owner/agent/thread 外键、`source_message_id` 的 CASCADE 语义要和 `source_gone` 一致；`attempts`、`last_error_code` 要有长度/范围 CHECK；`source_run_id/source_message_id` 的读取必须按 owner/agent/thread 限定；数据导出是否包含它要明确。
- `invocationId`：`service-main.ts:1981-1992` 目前只按 `purpose + request.runId` 生成，`ProductionMemoryCaptureOptions.generate`（`production-memory-capture.ts:640-644`）没有覆盖参数；不扩接口，`:retry`/`:backlog` 根本传不进去，和 `model-invocation-admission-service.ts:425-446` 的 identity 校验会冲突。
- `subjectRef = generationId`：`decision-ledger` 的 `subjectRef` 允许 1-256，能放下；但每日评价的 `reviewedMemoryIds`（`daily-review.ts:220-236`）会把它当 memory id 去读正文，必须按失败记录单独处理，不能沿用 `kept/discarded` 的路径。
