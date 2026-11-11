## 一、方案依赖的前提（读代码/来源证实的，与推测分开）

### 已验证

**P1. 主对话请求必须只追加；辅助调用是另一条请求，不能改写主对话开头。**
来源：`.claude/rules/prompt-prefix.md:27-28`、`:35`、`:41`。原话：
- “固定的在前，会变的在后。顺序是：工具定义 → 系统提示 → 历史 → 最后一条用户消息。”
- “每轮都会变的内容只放在最后一条用户消息里。”
- “已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。”
- “系统提示和工具按对话冻结”。

**P2. 记忆捕获是“固定指令 + 本轮 JSON 数据”的独立辅助调用，不是主对话历史。**
来源：`apps/agent-service/src/production-memory-capture.ts:169-194`、`:822-835`。`memoryCapturePrompt` 先返回 `MEMORY_CAPTURE.text`，再拼接 `JSON.stringify({ existingMemories, existingSubCategories, knownPeople, previousAssistantMessage, messageSentAt, ownerTimeZone, ownerMessage })`；`#capture()` 在第一条助手消息出现时被调用。
这和规则里的后台调用要求一致：`.claude/rules/prompt-prefix.md:67` 原话：“后台调用也是固定的在前、会变的在后……先放固定的指令，再放这次的数据，最后放当前时间这类每次都变的值。”

**P3. 模型调用必须绑定当前活着的运行和执行租约；已结束的运行不能申请准入。**
来源：`apps/agent-service/src/production-run-composition.ts:196-214`、`packages/application/src/services/model-invocation-admission-service.ts:393-452`、`:514-528`、`packages/platform-node/src/trusted-model-provider.ts:137-153`。
关键原话/代码：admission 构造时绑定 `runId` 和 `executionLease`；`begin()` 先 `#assertActive()`，再 `dispatch.assertHeld({ runId, expectedLeaseRevision, executionLeaseId })`；`TrustedModelProviderAdapter` 还要求 `gate.context.runId === request.runId`。
因此“补做”不能拿旧运行的请求直接再发，必须用下一轮活运行的 `RuntimeRequest`/租约重新准入。

**P4. 同轮重试必须换一个 admission 逻辑槽位；现在的首次调用槽位是 `${purpose}:${runId}`。**
来源：`apps/agent-service/src/service-main.ts:1981-1992`（`invocationId: \`${purpose}:${request.runId}\``）、`packages/platform-node/src/trusted-model-provider.ts:175-186`（`logicalSlot: request.invocationId`）、`packages/application/src/services/model-invocation-admission-service.ts:425-446`（同一 `logicalSlot` 再次 `begin` 只能 replay/冲突，不能当新调用）。
所以：同轮重试、以及下一轮补做，都必须生成不同的 `invocationId`，否则第二次调用会被准入层当成重复身份，抛 `CONFLICT`/“requires reconciliation”。

**P5. 统一出口已经有一层只针对 `AI_GATEWAY_TOOL_CALL_UNSUPPORTED` 的重试。**
来源：`apps/agent-service/src/production-model-composition.ts:624-639`。原代码：
```ts
try {
  return await generateTextOnce(...);
} catch (error) {
  if (!(error instanceof Error) || error.message !== "AI_GATEWAY_TOOL_CALL_UNSUPPORTED")
    throw error;
  return generateTextOnce(..., { ...text, invocationId: `${text.invocationId}:retry` });
}
```
如果捕获层再无条件重试，I-63 这种错误可能变成最多 4 次调用（共享层 2 次 × 捕获层 2 次）。设计里必须明确重试由哪一层负责。

**P6. 决策记录的 `outcome` 不只由代码校验，数据库 0069 也有 CHECK；材料里“outcome 只在代码里校验”与代码不符。**
来源：`packages/application/src/ports/decision-ledger.ts:42-48`（`DECISION_OUTCOMES.memory_candidate = ["kept", "discarded", "pending_approval"]`）；`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:49-96`（`validateLedgerWrite` 用 `DECISION_OUTCOMES` 校验）；`packages/persistence-sqlite/src/migrations/0069_decision_ledger.sql:48-55`，原 SQL：
```sql
CHECK (
  kind = 'proactive' OR
  (kind = 'memory_candidate' AND outcome IN ('kept', 'discarded', 'pending_approval')) OR
  ...
)
```
所以只改 `DECISION_OUTCOMES` 不够；新增 `retry_succeeded`/`pending_retry` 时，第一条插入就会在 SQLite 层失败。这正是 I-73 提醒的“两端都要核对”。

**P7. 迁移在事务里执行，且连接强制 `foreign_keys=ON`；重建被外键引用的 `decision_ledger` 不能直接 DROP。**
来源：`packages/persistence-sqlite/src/migration-engine.ts:930-943`（每个迁移在 `database.transaction(...).immediate()` 中执行）、`:998-1003`（`openQualifiedDatabase` 设置 `foreign_keys = ON`）。
`decision_ledger` 至少被 `source_insights`、`proactive_processed_messages`、`muse_reference_entries`（0069:89/105/135）、`decision_ledger_payloads`（0070:2）、`decision_signals`（0080:5）、`proactive_push_backoff`（0081:16）引用。直接重建/删除父表会触发子表外键动作，必须先设计重建方案并用迁移契约测试验证。

**P8. 记忆 id、生成 id、ledger id 已经是确定性的，重放可以做到幂等。**
来源：`production-memory-capture.ts:784` `generationId = memory-capture:${runId}`；`:588-589` `memory:${generation}:${ordinal}`；`packages/application/src/services/automatic-memory-service.ts:87-89` ledger id 用 `sha256(generation:ordinal:outcome:reasonCode)`；`packages/application/src/services/durable-memory-service.ts:121-143` 对相同 `create` proposal 返回已有记录。
注意：多候选、审批、部分提交后的重放是否全部幂等，仍需逐路径核实（标记为“未逐一核实”）。

**P9. 当前失败路径只写审计和日志，不写决策记录。**
来源：`production-memory-capture.ts:855-857`（catch 里 `audit("extraction_failed"); throw error;`）；`start()` 在 `:676-678` 用 `.catch(this.options.onFailure)` 吞掉；`service-main.ts:2003-2008` 只写 `memory-capture.failed` 日志。
所以本改动确实需要新增两条决策记录路径。

**P10. 捕获入口在第一条助手消息出现时启动，补做也应在这个时机接入，才能保证运行还活着。**
来源：`apps/agent-service/src/production-titled-runtime.ts:38-55`；`memoryCapture.start(request)` 在 `runtime.message`/`role === "assistant"` 时触发，并在 `runtime.completed` 等事件前等待 admission。
补做如果放到运行结束后、或独立定时器里，会拿不到活运行租约，违反 P3。

**P11. 捕获开头会检查 `capturePaused`；补做也不能绕过。**
来源：`production-memory-capture.ts:708-712`。补做时若主人已暂停，应保留待补队列而不是丢弃。

**P12. 业界一手来源对“重试 + 幂等 + 前缀缓存”的对应做法。**
- Anthropic Prompt caching：缓存按请求开头逐字节前缀匹配，前缀变了就从变化处重算。<https://platform.claude.com/docs/en/build-with-claude/prompt-caching>
- OpenAI Prompt caching：命中要求相同前缀；缓存按前缀匹配。<https://developers.openai.com/api/docs/guides/prompt-caching>
- DeepSeek KV cache：按前缀命中，前缀不同则后续重算。<https://api-docs.deepseek.com/guides/kv_cache>
- Stripe 幂等键：重试同一操作时用幂等键避免重复副作用。<https://docs.stripe.com/api/idempotent_requests>
- Temporal 重试策略：活动可配置重试；副作用操作应保证幂等。<https://docs.temporal.io/encyclopedia/retry-policies>
- SQLite `legacy_alter_table`：控制 `ALTER TABLE RENAME` 是否改写子表外键引用。<https://www.sqlite.org/pragma.html#pragma_legacy_alter_table>
- SQLite 外键：删除父表时会执行隐式 DELETE 并触发外键动作，所以父表重建要先处理子表。<https://www.sqlite.org/foreignkeys.html>

### 推测/未核实

- `PORT_CONFLICT`（10-30）在抽取阶段的确切抛出位置：材料说未查，我也未查到，标记 **未核实**。
- `PRAGMA legacy_alter_table` 能否在 `database.transaction()` 内部安全切换：按 SQLite 文档它属于连接级 pragma，但当前迁移引擎的事务/执行方式需要实际跑迁移契约测试确认，标记 **未核实**。
- 新增 `memory_capture_pending` 表是否必须进入数据导出/导入：现有导出只显式覆盖记忆相关表（`data-export/snapshot.ts`、`import.ts:56-65`），脚本 `check:data-export` 是否强制覆盖所有含 `owner_id` 的表 **未核实**。
- `RunId` 的最大长度是否一定能让 `subjectRef = memory-capture:${runId}` 落在 256 字符内：实现时应显式校验，标记 **未核实**。

---

## 二、方案本身

### 2.1 数据模型

新增一张待补队列表，例如 `memory_capture_pending`，不把整段提示词或用户原文复制进表里。建议字段：

- `id`：确定性 id，例如 `memory-capture-pending:${sourceRunId}`；
- `owner_id`、`agent_id`、`thread_id`；
- `source_run_id`：原运行；
- `source_message_id`：原用户消息 id，外键到 `thread_messages(id) ON DELETE CASCADE`，用户删消息/删线程时队列自动消失；
- `source_ref`、`source_classification`、`source_sequence`；
- `generation_id`：原 `memory-capture:${sourceRunId}`，保证补做后的记忆 id 不变；
- `policy_version`、`model_descriptor_ref`（仅记录原值）；
- `relevant_ids_json`：原轮选中的记忆 id 列表，补做时只保留仍 active 的；
- `sent_at`、`time_zone`：原消息时间与提醒时区；`sent_at` 也可从消息行读取，但显式存更方便测试；
- `status`：`pending` / `claimed`；
- `attempt_count`、`last_error_code`；
- `claimed_by_run_id`、`claim_expires_at`；
- `created_at`、`updated_at`。

唯一键建议 `(owner_id, agent_id, source_run_id)`，防止同一轮重复入队。索引 `(owner_id, agent_id, thread_id, status, created_at)` 支持按线程取最旧待补项。

**不存完整提示词**。理由：
- 补做时如果直接复用原提示词，模型看不到这期间新增/取代的记忆，可能产生重复或过期记忆；用当前记忆状态重建更符合“下一轮补做”。
- 不复制敏感原文，只引用原 `source_ref`/`source_message_id`；删消息即级联删除待补项。
- 重建时把列表排序固定，仍能做到“同一当前状态 → 同一提示词字节”。

### 2.2 当前轮捕获 + 同轮重试

把 `#capture()` 中的模型调用和解析收成一个 `#attempt(request, prepared, slot)`：

1. 组装提示词、`externalTag`、`placeholderTable` 等。提示词本身不变，仍复用 `packages/prompt-catalog` 里的 `MEMORY_CAPTURE`，不新增/修改提示词文字，因此不需要新的 catalog 条目。
2. 首次调用 `generate`，`invocationId` 用一个新的“捕获尝试槽位”，例如 `memory-capture:${runId}:attempt:1`。
3. 若失败：
   - 对 `AI_GATEWAY_TOOL_CALL_UNSUPPORTED`，要么让共享出口继续负责、捕获层不再重试；要么给捕获调用关闭共享层的 I-63 重试，由捕获层统一重试一次。二选一，不能两层都重试。建议后者：在 `generateText` 增加一个仅对 memory-capture 生效的“内层不重试”选项，捕获层统一重试，避免最多 4 次调用。
   - 其它错误（响应 JSON 无效、响应不完整、超时、端口冲突等）同轮重试一次，`invocationId` 用 `memory-capture:${runId}:attempt:2`。
4. 重试成功：
   - 照常走 `parseMemoryCandidates` 和 `AutomaticMemoryService.processCommittedRun`；
   - 写一条 `memory_candidate` / `retry_succeeded` 决策记录；
   - 不写待补队列。
5. 重试仍失败：
   - 写待补队列（包含 P8 的 generation id、原 source/message、classification、relevant ids、sentAt/timeZone）；
   - 写一条 `memory_candidate` / `pending_retry` 决策记录；
   - 写现有 `extraction_failed` 审计和 `memory-capture.failed` 日志；
   - 抛出，由 `start()` 的 `.catch(onFailure)` 处理。

**不把尝试次数、失败码、时间写进提示词**。重试应尽量发送相同内容；如果将来要告诉模型“这是补做”，只能放在固定指令之后的 JSON 尾部，并登记 `packages/prompt-catalog`。

### 2.3 下一轮补做

在 `ProductionMemoryCapture.start(request)` 里，当前轮捕获启动后，再启动“最多一条待补项”的补做：

- 只在当前轮是正常线程运行、且 `capturePaused` 为 false 时执行；
- 用 `ownerId`/`agentId`/`threadId` 原子 claim 最旧的一条 `pending`；claim 过期时间用时钟计算，避免进程崩溃后永久占用；
- 用**当前请求**的 `runId`、`executionLease`、`systemInstructionRef`、`correlationId` 做准入；用 `pending.thread_id` 作为 egress 的线程上下文；
- 读取 `pending.source_run_id` 的 `RunExecutionSource`，校验 `payloadRef`、`threadId`、classification 与队列一致；
- 读取原用户消息原文、原消息前后的历史消息、当前 active 记忆、当前 `subCategories`/`people`；
- 重新渲染 `memoryCapturePrompt`。为确保确定性：
  - `existing` 按 `id` 排序；
  - `subCategories` 的 category 键和值都排序；
  - `knownPeople` 先按 `updatedAt` 降序，再按 `id` 升序打破平局；
  - JSON 键顺序固定，不依赖数据库返回顺序；
- 用**新的 invocation 槽位**调用统一出口，例如 `memory-capture:${currentRunId}:pending:${pendingId}`，避免和当前轮自己的捕获槽位冲突；
- 解析、保存时使用原 `generationId`、原 `sourceRef`、原 `sourceClassification`、原 `source_run_id`；`modelDescriptorRef`/`policyVersion` 可用当前值（因为提示词是当前版本），也可按拍板结果保留原值；
- 成功后写 `retry_succeeded` 决策记录，删除待补行；失败则 `attempt_count += 1`，状态回到 `pending`，保留到下一轮；
- **补做本身不再做同轮第二次重试**，避免每轮为一条旧记忆花两次模型调用；它是上一次失败的“再试一次”，不是当前轮的首次捕获。若 Andy 要求字面意义上的“每次捕获都重试”，则另算成本。

调度上建议：当前轮捕获先开始；当前轮模型调用获准后再发补做，避免两条同前缀请求同时发出（规则第 17 条，`.claude/rules/prompt-prefix.md:70`）。如果补做在本轮结束前没拿到准入，就保留待补行，不丢。

### 2.4 决策记录

新 outcome 建议：

- `retry_succeeded`：首次失败、同轮重试成功；或待补项在后续运行补做成功。
- `pending_retry`：重试也失败，已进入待补队列。

对应 `reasonCode` 建议：

- `capture_retry_succeeded`
- `capture_queued_for_retry`
- `capture_pending_replayed`
- 如加最大尝试次数：`capture_retry_exhausted`

记录字段：

- `kind: "memory_candidate"`；
- `subjectRef: generationId`（`memory-capture:<sourceRunId>`），不要伪装成 memory id；
- `inputs: { memoryIds: [], ruleIds: [] }`；不要沿用 `discard()` 里把 reasonCode 塞进 `ruleIds` 的写法（P2-7 正在修这个问题）；
- `contentRef`: 可留空；若希望主人在每日评价里看到原话，可填 `sourceRef`，但必须走现有可见性检查；
- `costMicros: 0`（当前 `generate` 不返回 usage；若要真实费用需扩展返回值）；
- `durationMs`: 实测；
- `category`/`confidencePermille`/`inferred`: 这类“重试事件”没有候选，填 null。

**关键**：新增 outcome 不能只改代码，必须同时更新 0069 的 DB CHECK（见 P6）。迁移建议：

- 新迁移号从 main 最新取，当前 main 到 0086，且约束说别的线程占用到 0089，所以很可能从 0090 起；开工前必须再按 main 复核，不能写死。
- 同一个迁移里创建 `memory_capture_pending`，并重建 `decision_ledger` 的 outcome CHECK。
- 重建父表两种方式：
  1. 事务内 `PRAGMA legacy_alter_table=ON` → `ALTER TABLE decision_ledger RENAME TO decision_ledger_old` → 建新表 → 复制 → `DROP TABLE decision_ledger_old` → 重建索引 → `legacy_alter_table=OFF`。先写迁移契约测试验证子表外键仍指向新表、级联删除仍生效；若当前 SQLite/事务不接受该 pragma，退回方式 2。
  2. 按 0069 的做法，重建所有引用 `decision_ledger` 的子表（`source_insights`、`proactive_processed_messages`、`muse_reference_entries`、`decision_ledger_payloads`、`decision_signals`、`proactive_push_backoff`）及其索引/触发器，再替换父表。工作量大但最保守。
- 不论哪种，迁移契约测试必须检查 `foreign_key_check` 为空、原有 ledger 行数/评分不丢、子表行仍在、删除父行仍按原规则级联/置空。

### 2.5 必须同步改的使用方

| 值 | 产生处 | 使用/校验处 | 结论 |
|---|---|---|---|
| 新 outcome `retry_succeeded`/`pending_retry` | `ProductionMemoryCapture` 写 ledger | `DECISION_OUTCOMES`、`validateLedgerWrite`、0069 DB CHECK | 三处都要改，否则插入失败 |
| 同上 | 同上 | 控制中心 `reviewTag`（`proactive-reminders.tsx:324-344`） | 现在不认识的 outcome 会落到“待批准”；必须加分支和 `dailyReview.tag.*` 三语文案、`message-ids.ts` |
| 同上 | 同上 | `daily-review.ts:201-236` | `ledgerGroup`/`ledgerActed`/`reviewedMemoryIds`/`textHidden` 会把事件当 kept 处理或显示“不显示原文”；要显式映射 |
| 同上 | 同上 | `calibration`（`packages/calibration/src/index.ts:259-270`） | 现在非 kept/discarded 会归入 `memory_pending`；要么新增 `memory_retry` 组并更新 gateway 枚举/周报文案，要么明确归入现有组并改标签 |
| 同上 | 同上 | `packages/gateway-contracts/src/contracts-v2.ts` | `proactiveReviewItem.outcome` 是 `machineString`，能过；`calibrationGroupSchema` 若新增组要改 |
| ledger id / subjectRef / reasonCode | 捕获层 | `validateLedgerWrite`（id 1-128、subjectRef 1-256、reasonCode 1-64）、DB 同长度 CHECK | 用确定性哈希/截断，不要直接拼超长错误信息 |
| 待补表 `status`/`id`/`payload` | 新 repository | 新迁移 CHECK、claim/complete 代码 | 只使用 `pending`/`claimed`（或加 `failed_terminal`），两端一致 |
| 新 invocationId 槽位 | `service-main.ts` 的 `generate` 包装 | `model_invocation_identities` 的唯一 `(owner, agent, run, logical_slot, sequence)`、`invocation_id` 唯一、usage observations | 槽位必须每轮每次尝试唯一；不能和当前轮捕获共用 |
| 迁移号 | 新迁移文件/`migration-engine.ts` 清单 | `assertWritableSchema`、`LATEST_MIGRATION_SEQUENCE`、数据导出 migrationSequence | 必须连续、按 main 最新取号 |
| 待补表是否导出 | 新表 | `check:data-export`、`data-export/snapshot.ts`/`import.ts` | 我倾向不导出（临时敏感工作项）；但要核实脚本是否允许遗漏 |
| 新 UI message id | 控制中心 | `check:locale`、三语资源、`message-ids.ts` | 必须同时补齐 |

### 2.6 测试

放在 `test/integration/production-memory-capture.test.ts`（已有 `generate` 队列和 SQLite fixture，见 `:240-249`）：

1. `[P3-5]` 首次 `generate` 抛错、第二次返回合法 JSON：调用 2 次，记忆保存，ledger 有 `retry_succeeded`，待补表为空。
2. `[P3-5]` 首次返回非法 JSON、第二次合法：同样保存，证明重试覆盖“模型调用成功但解析失败”。
3. `[P3-5]` 两次都失败：调用 2 次，待补表 1 行，ledger 有 `pending_retry`，审计有 `extraction_failed`，没有记忆。
4. `[P3-5]` 第一次失败、第二次成功后，下一轮启动：待补项被补做，记忆 id 仍是 `memory:memory-capture:<原 runId>:<ordinal>`，待补行删除，ledger 有 `retry_succeeded`/`capture_pending_replayed`。
5. `[P3-5]` 暂停 `capturePaused` 时下一轮不补做，待补行保留。
6. `[P3-5]` 下一轮补做拿不到 admission 时待补行保留，不丢失。
7. `[P3-5]` 同一待补项重复启动/重复补做不产生第二条记忆、不重复写 ledger（幂等）。
8. `[P3-5]` 补做和当前轮同时存在时，两者的 `invocationId` 不同；用假 admission 捕获 logical slot，断言不会冲突。
9. `[P3-5]` 原用户消息被删除/线程删除时，待补行级联消失，不会复活记忆。
10. 迁移契约测试：新 outcome 能插入，旧非法 outcome 仍抛错；重建后子表外键/级联不丢。
11. 控制中心：新 outcome 显示新标签，不显示“待批准”；三语文案齐全。
12. `daily-review`/`calibration`：新 outcome 的分组、文案、评分选项有测试。

反向用例必须真的会失败：
- 删掉同轮重试 → 用例 1/2 失败；
- 删掉待补入队 → 用例 3/5/6 失败；
- 删掉 ledger append → 用例 1/3/4 的 ledger 断言失败；
- 补做复用当前轮 `invocationId` → 用例 8 抛 admission 冲突；
- 新 outcome 只改代码不改 0069 → 迁移契约/插入测试失败；
- UI 保留“未知 outcome → 待批准”分支 → 用例 11 失败；
- 重建提示词时不排序 → 同一状态两次渲染字节不同的断言失败（建议加这条）。

进入检查：
- 目前 `npm run check` 不跑 integration（`package.json:26-27`；`scripts/run-all-checks.mjs` 只跑 `check:steps`），`npm run test` 走 `scripts/ci/local.mjs --check coverage`（`package.json:77`）。
- 建议新增 `check:memory-capture-retry`（只跑上述 integration 文件和迁移契约）并加入 `check:steps`，同时确保 `test:integration`/CI 覆盖；这样才符合“进 npm run check / 测试套件”。另外 `check:prompt-prefix`、`check:prompt-catalog`、`check:locale`、`check:data-export` 必须继续通过。

---

## 三、考虑过但不选的做法及原因

1. **只加 `DECISION_OUTCOMES`，不加迁移。**
   不选：0069 的 DB CHECK 会拒绝新 outcome（P6），第一条记录就失败。

2. **不加新 outcome，用 `kept`/`pending_approval` + 新 `reasonCode`。**
   不选：能避开 `decision_ledger` 重建，但语义会混。`pending_retry` 用 `pending_approval` 会在现有 UI/校准里显示成“待批准/待确认”，`retry_succeeded` 用 `kept` 会和真正的候选 kept 重复计数；虽然可以再给 review API 加 `reasonCode` 来区分，但这是把二级状态塞进一级字段，后续消费者很容易再踩一次 I-73。
   如果 Andy 认为迁移风险过高，这是可接受的降级方案，但必须同时改 review item 契约和所有按 outcome 分组的消费者。

3. **待补队列复用 `decision_ledger` 本身。**
   不选：ledger 是决策记录，不是可 claim 的工作队列；把 claim、attempt、last_error 塞进 `inputs` 会让“主人可评价的记录”和“可执行任务”耦合，且 ledger 追加/不可变语义会被破坏。单独建表更清楚。

4. **补做用定时器/后台 worker，而不是下一轮运行。**
   不选：P3 要求活运行租约；定时器拿不到当前运行的 `executionLease`，会被准入拒绝。独立 worker 若要自己造运行，会违反“模型调用必须经当前运行准入”的约束。

5. **持久化完整渲染后的提示词。**
   不选：虽然重试字节最稳定，但补做时模型看不到这期间新增/取代的记忆，容易产生重复或过期记忆；还多复制一份敏感原文。改为持久化原消息/来源标识，补做时用当前状态重建并排序。
   代价是补做提示词和原轮不完全相同。我认为这是可接受且更正确的：补做的是“这轮用户消息”，不是“冻结当时的记忆列表”。

6. **新增一个 `kind`（如 `memory_capture`）。**
   不选：0069 对 kind 也有 CHECK，且 kind 的消费者更多（gateway、UI、校准、导出），重建面更大；用 `memory_candidate` 下的新 outcome 更小。

7. **补做时也做同轮二次重试。**
   不选（当前建议）：补做本身就是一次重试；每轮再重试两次会让反复失败的记忆持续烧钱。若 Andy 要求严格“每次捕获失败都同轮重试一次”，再改。

---

## 四、风险与反例

### 已验证的风险

- **费用翻倍**：每轮首次捕获失败最多多一次模型调用；待补项每轮最多再一条。必须限制“每轮最多补做 1 条”，并考虑最大尝试次数/退避。
- **I-63 双层重试**：如果不动共享层，I-63 可能变成 4 次调用（P5）。必须明确由捕获层或共享层单方负责。
- **DB CHECK 漏改**：新 outcome 会在插入时失败，且可能直到生产才暴露；迁移契约测试必须先跑。
- **迁移重建父表**：直接 DROP `decision_ledger` 会触发子表外键动作（P7）；必须按 2.4 的方式并在测试里做 `foreign_key_check` 和级联验证。
- **UI 误显示**：不加分支时 `pending_retry`/`retry_succeeded` 会显示成“待批准”或“不显示原文”（`proactive-reminders.tsx:331-336`、`daily-review.ts:322-323`）。
- **补做队列泄露敏感内容**：只存 id/引用，不复制原文；`source_message_id` 级联删除；如果主人在待补期间删线程/消息，队列应一起消失。
- **补做时源消息已删**：应丢弃待补项而不是用缓存的旧内容复活记忆。

### 推测/需要实测

- `PRAGMA legacy_alter_table` 在当前迁移事务中的行为：需实测；失败则退回重建子表。
- 多候选、审批、部分提交后的补做幂等性：`create` 的 sameProposal 分支已验证，其他路径未逐一核实。
- `check:data-export` 是否要求新表必须导出：未核实。
- 新 outcome 在周报/校准里的展示位置：取决于是否新增 `memory_retry` 组，需产品拍板。

### 反例

- 如果补做时用原提示词快照，而原提示词里包含一个已经被取代的 memory id，补做模型返回 `update` 该 id，`applyProposal` 可能因 memory 不再 active 而失败，待补项永远补不上。因此我选择重建当前状态。
- 如果补做和当前轮捕获同时用 `memory-capture:${currentRunId}`，admission 会认为是重复逻辑槽位，第二次调用直接冲突。必须带 `pending:${pendingId}` 或 `attempt:2`。
- 如果待补项只按 owner/agent 处理而不按线程，A 对话的旧消息可能在 B 对话的下一轮被补做；功能上记忆是 owner 级，但用户会意外。建议至少默认按 `thread_id` 取；是否允许跨线程补做由 Andy 定。
- 如果新 outcome 只更新控制中心标签，不更新 `daily-review`/`calibration`，每日评价可能把 queued 记录当“待批准”或“已存”，校准统计失真。

---

## 五、需要人拍板的取舍

1. **新 outcome + 重建 `decision_ledger`，还是用现有 outcome + `reasonCode`？**
   我推荐前者（语义清楚），代价是一个需要小心验证的父表重建迁移；后者能避开重建，但 UI/校准/API 都要按 `reasonCode` 做二级分派，且语义更绕。

2. **重试策略**：所有捕获失败都同轮重试一次，还是把 `DISCLOSURE_DENIED`、`ADMISSION_UNAVAILABLE`、失去执行权这类“重试无用/预检失败”排除？
   我倾向“预检失败也重试一次（不产生模型费用），但 I-63 只由一层重试”；若更看重费用，可排除明确不可恢复的 disclosure denied。

3. **补做范围**：只补当前线程的最旧一条，还是按 owner/agent 跨线程补？每轮最多补几条？
   我建议默认按线程、每轮 1 条；跨线程需 Andy 明确同意。

4. **补做失败上限**：无限保留 + 每轮尝试，还是最多 N 次后标 `failed_terminal` 并写 `discarded`/`retry_exhausted`？
   考虑花钱敏感，我建议有上限（如 3 次）并留可见记录；但验收标准没写上限，需要拍板。

5. **补做时用当前 prompt/当前记忆状态，还是原快照？**
   我推荐当前状态重建；如果 Andy 要求“这一轮必须按当时上下文补”，才改为快照，并接受重复/过期记忆风险。

6. **待补项是否显示原用户消息文本供评分？**
   可以填 `contentRef = sourceRef` 让每日评价显示原话，但要确认可见性/敏感分级；否则只显示标签。

7. **迁移号与协调**：按 main 最新取号，当前 main 0086、预留到 0089，预计 0090；必须和“同一时间只允许一个改表结构的块”协调，开工前再确认。

---

## 六、逐条回答必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**主对话：不会。** 系统提示、工具定义、历史消息、遮盖结果都不动；补做只是另一次辅助模型调用，不向主对话历史插入任何消息，也不改最后一条用户消息。依据：`.claude/rules/prompt-prefix.md:27-28`、`:35`、`:41`；`production-titled-runtime.ts:38-55` 只在收到助手消息时启动后台任务，没有改写 `runtime.run` 的事件流。

**辅助调用：不会把旧请求“改开头”，因为每次都是新的独立请求。** 捕获提示词仍以固定的 `MEMORY_CAPTURE.text` 开头，后面跟本轮 JSON；重试在同一轮内发送同一份提示词（仅 `invocationId` 变化，`invocationId` 不在提示词里）。待补项在下一轮重新渲染，仍是“固定指令 → 本轮 JSON”，没有在旧提示词前面插东西。

**“发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？”**
对主对话：是，没改。对辅助调用：固定指令在前，`existingMemories`、`previousAssistantMessage`、`messageSentAt`、`ownerTimeZone`、`ownerMessage` 都在末尾 JSON 里；我们不把尝试次数、失败码、队列时间写进提示词，避免新的每轮变化值进入前缀。依据：`.claude/rules/prompt-prefix.md:67`；`production-memory-capture.ts:177-193`。

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

**不会新增“依赖后文/时间/无序集合”的遮法。**
- 新加的 ledger 字段、待补表字段、`invocationId` 都不进模型提示词，不参与遮盖。
- 重试使用同一份提示词；待补补做时重建提示词，但固定前缀不变，变的只是末尾当前状态数据。
- 为避免同一状态渲染出不同字节，重建时必须固定顺序：`existing` 按 id、`subCategories` 键和值排序、`people` 按 `updatedAt` 再按 `id` 打破平局；JSON 键顺序固定，不依赖 DB 返回顺序。依据：`.claude/rules/prompt-prefix.md:51` 原话：“同样的内容，每次都要序列化成同样的字节。JSON 的键顺序、工具的顺序、列表的顺序……都要固定，不能依赖对象遍历顺序或数据库返回顺序。”

**一个仍需注意的例外**：同一段原文在“入队时”和“补做时”重新经过出口遮盖，如果遮盖密钥、规则集或 `TRUSTED_PROMPT_TEXTS` 清单在这期间变了，遮出的字节可能不同。这和规则第 11 条对“改提示词文字/老对话”的说明同类（`.claude/rules/prompt-prefix.md:53`）。它不是主对话前缀，影响的是辅助调用；若要求严格字节一致，应在发布提示词/遮盖规则前清空待补队列，或接受这一例外。
**结论**：当前设计不引入新的非确定性；若选择“补做时重建提示词”，必须把排序写进代码和测试。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有，见 2.6。关键是：
- 同轮重试成功、解析失败重试、两次失败入队、下一轮补做、暂停、admission 不可用、重复补做幂等、消息删除级联、invocationId 唯一；
- `decision_ledger` 新 outcome 的 DB 插入与旧非法 outcome 拒绝；
- UI 新标签、`daily-review`/`calibration` 分组；
- 反向用例逐一对应：删重试、删入队、删 ledger、复用 invocationId、只改代码不改 DB CHECK、保留 UI 未知 outcome 回退、提示词不排序。
并建议把相关 integration/迁移测试加进 `check:steps` 或确保 `npm run test` 的 integration 覆盖，否则 `npm run check` 本身不会跑到这些用例（`package.json:26-27`、`:77`）。

### 4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？

逐项核对见 2.5。最关键的三个“两端”：

- **新 outcome**：产生于捕获层；`DECISION_OUTCOMES` 接受、`validateLedgerWrite` 接受、**0069 DB CHECK 目前不接受**，必须迁移；UI `reviewTag` 目前会把不认识的 outcome 当“待批准”，必须加分支；`daily-review`/`calibration` 目前按 kept/discarded 二分，必须显式映射。
- **新 `invocationId`**：产生于 `service-main.ts` 的 capture 包装；`model_invocation_identities` 要求 `(owner, agent, run, logical_slot, sequence)` 唯一且 `invocation_id` 唯一，`TrustedModelProviderAdapter` 还要求 `gate.context.runId === request.runId`。所以补做必须用“当前运行 + 唯一槽位”，不能复用旧运行的请求，也不能和当前轮捕获共用槽位。
- **待补表字段**：`status`/`id`/外键长度/时间格式都必须在迁移 CHECK 和 repository 写入两端一致；`source_message_id` 级联删除、`source_ref` 仍可解密、`payload_ref` 若存在则要能随删除清理。新表是否进入数据导出尚未核实，必须查 `check:data-export`。

特别提醒：材料里“outcome 只在代码里校验”不成立；0069:48-55 的 DB CHECK 就是反例。按 I-73 的要求，不能只核对 `DECISION_OUTCOMES`，还要核对 SQLite CHECK、控制中心、daily-review、calibration、gateway 枚举/导出格式。
