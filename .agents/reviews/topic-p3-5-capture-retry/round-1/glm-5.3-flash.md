# P3-5 记忆捕获重试与补做：独立方案

## 一、方案依赖的前提

**读代码或来源证实的：**

1. 捕获失败现状：`#capture()` 的 try 块（`apps/agent-service/src/production-memory-capture.ts:820-858`）里 `audit("extraction_failed")` 后重新抛出，`start()` 用 `.catch(this.options.onFailure)` 吞掉（同文件 676-681），`onFailure` 只写 `memory-capture.failed` 日志（`service-main.ts:2003-2008`）。失败后该轮记忆确实无人补做。
2. 请求形态是后台调用：“固定指令在前、本次数据 JSON 在最后”（`memoryCapturePrompt`，`production-memory-capture.ts:177-194`；规则依据 `.claude/rules/prompt-prefix.md:67` 第 15 条）。提示词正文来自 `MEMORY_CAPTURE.text`（prompt-catalog），会变的值（`messageSentAt`、`ownerMessage`、`existingMemories`）全在末尾 JSON 里。
3. 已有一层重试且只认一个错误码：`generateText` 仅当错误信息等于 `AI_GATEWAY_TOOL_CALL_UNSUPPORTED` 时以 `${invocationId}:retry` 重调一次（`production-model-composition.ts:624-640`）。该层由标题、记忆捕获、episode、整理共用。
4. 准入绑定“当前活运行”：`admission` 先 `authority.assertActive()`，再用**传入 request 的 runId 和 executionLease** 建 `ModelInvocationAdmissionService`（`production-run-composition.ts:196-214`）；服务内部把调用身份记在 `context.runId` 名下并校验 identity 与 lease 一致（`model-invocation-admission-service.ts:393-446`）。已结束的运行过不了 `assertActive`（`production-run-composition.ts:378-390`）。→ **补做必须挂在下一次活运行上准入，但身份标识可以继续用原 runId 派生**（generationId 与 request.runId 在代码里是两个独立字段，`production-memory-capture.ts:784-796`）。
5. 决策账本约束：`decision_ledger` 的 **outcome 在数据库层也有 CHECK**，memory_candidate 限定 `kept/discarded/pending_approval`（`0069_decision_ledger.sql:48-55`）——材料里“outcome 只在代码里校验”与迁移文件不符。新增 outcome 或新增 kind 都要重建表（`source_insights`、`proactive_processed_messages`、`muse_reference_entries` 三处外键引用它）。daily-review 对 `discarded` 有现成路径（`daily-review.ts:204-216`），网页把 discarded 显示为“已跳过记忆”标签（`proactive-reminders.tsx:331-336`）。账本 id 是 `sha256(派生键)` 的确定性 id（`automatic-memory-service.ts:87-89`）。现有 `discard()` 把 reasonCode 塞进 `inputs.ruleIds`（`automatic-memory-service.ts:572`），而 P2-7 要求 ruleIds 只指真实规则——新代码不应沿用这个 hack。
6. 补做所需事实都可持久重建：消息正文经 `payloadRef`+protector 读取（`production-memory-capture.ts:691-701`），owner 消息的 sequence/committedAt/分类都在 thread 与 source 记录里；generationId、memory id（`memory:${generationId}:${ordinal}`）、checkpoint jobId（`checkpoint:memory-capture:${runId}`）全部由原 runId 确定性派生（`production-memory-capture.ts:784,866`）。
7. 捕获提示词的排序是确定性的：`confirmedFirstByRecency`（54-58 行）、people 按 updatedAt 降序（780-783 行）、JSON 键序为字面量固定顺序。

**推测（未核实，开工前要验证）：**

- `PORT_CONFLICT` 在抽取阶段的确切抛出点与是否瞬时（材料自承未查）。
- `memory_generations.request` 对重复 jobId、`DecisionLedgerPort.append` 对重复确定性 id 的行为（推测为 PK 幂等或冲突，需测试确认）。
- `scripts/run-all-checks.mjs` 如何收编 `test/integration` 用例（`package.json:26` 只见入口）。
- invocationId 端口对长度/后缀层数的校验上限。

## 二、方案

**A. 同轮重试一次（捕获层，改动集中在 `production-memory-capture.ts`）**

- 把 try 块（820-854 行：assertActive → 组提示词 → externalTag → generate → parse）包成 attempt 循环，最多 2 次尝试。可重试错误用白名单函数判定：`MEMORY_CAPTURE_RESPONSE_INVALID`、`MEMORY_CAPTURE_RESPONSE_INCOMPLETE`、`AI_GATEWAY_TOOL_CALL_UNSUPPORTED`、`PORT_CONFLICT`（若查实为瞬时）。不可重试：`MEMORY_CAPTURE_DISCLOSURE_DENIED`（确定性拒绝，重试无用）、`assertActive` 抛的运行结束类错误、`MEMORY_CAPTURE_ADMISSION_UNAVAILABLE`。
- 重试**复用同一 prompt 字节和同一 externalTag/placeholder 表**（不重组提示词、不重读 DB），只有 invocationId 变：给 `service-main.ts:1986` 的 generate 回调加可选 attempt 参数，派生 `memory-capture:${runId}:retry1`（仿 `production-model-composition.ts:637` 的 `:retry` 先例）。与内层网关重试叠加时自然成为 `…:retry1:retry`，仍唯一。
- 重试前再 `assertActive` 一次：运行已结束就不烧钱重试，直接走 C/D。
- 不改提示词文字 → 无需在 prompt-catalog 登记，也不触发对话冻结提示词的换新。

**B. 重试也失败 → 持久化待补队列（新迁移表）**

- 新迁移（按 main 最新取号，材料称其他线程占到 0089，即从 0090 起）：`memory_capture_deferrals`，主键 = generationId（`memory-capture:${runId}`，天然幂等）；字段：owner/agent/thread/run id、source payloadRef 与分类、owner 消息 id/sequence/committedAt、deferred_at、attempt_count、last_error_code、next_attempt_at。不复制消息正文，仍走 payload+protector（不绕 `packages/sensitive-capture`）。
- 触发：`ProductionMemoryCapture.start(request)`（660-684 行）在调度本轮捕获后异步排水本 owner/agent 的到期行（上限如每轮 2 条、attempt_count < 3、按 next_attempt_at 退避）。补做时：
  - 重新检查 `capturePaused`、thread 与 owner 消息仍存在（不在则删行并按 C 写决策记录）；
  - **准入与模型调用一律用当前活运行的 request**（当前 runId + 当前 lease），身份标识（generationId、checkpoint jobId、memory id、ledger id）保持原 runId 派生 → 幂等可重入；
  - 补做内部复用 A 的一次重试；成功删行；失败 attempt_count+1；超限删行并按 C 终局。

**C. 决策记录（复用现有枚举，不重建 decision_ledger）**

- 终局失败（不可重试错误、补做超限、数据源消失）：写 `kind="memory_candidate"`、`outcome="discarded"`、`reason_code="capture_failed"`（或 `capture_source_missing`），`subjectRef = memory-capture:${runId}`，`inputs.ruleIds = []`。id 用 `ledgerId("memory-capture:${runId}:capture_failed")` 确定性派生。该值组合在 DB CHECK、`DECISION_OUTCOMES`、daily-review（进 memory_skipped 组、可评 missed）、网页标签四处现成兼容，零迁移、零 UI 改动。
- 重试成功：正常走 `AutomaticMemoryService` 的 kept 记录（照常保存），队列无残留。
- 审计保留现状：首败、重试败各写一条 `extraction_failed`。

**D. 测试（进 `npm run check`）**，放 `test/integration/production-memory-capture.test.ts`：

- 首败重试成功 → 记忆照常保存、无队列行、模型桩记录到第二次调用（反向：删掉重试逻辑此用例必失败）；两次都败 → 队列行存在且字段正确；下一轮补做成功 → 记忆保存、队列行删除、模型桩断言调用挂在**新 runId** 准入；补做超限 → 决策记录出现且 reason_code 正确、行删除；补做时 capturePaused → 不补做；`DISCLOSURE_DENIED` → 不重试不进队列、直接决策记录；用已结束运行身份申请补做准入 → 必须被拒（反向）。

## 三、考虑过但不选

- **给 generateText 加通用重试**：该层被标题/episode/整理共用，改动外溢、费用不可控（违反花钱敏感约束），且它已承担 I-63 缓解职责。重试语义属于捕获策略，放捕获层。
- **新增 outcome（如 `capture_failed`）或新增 kind**：都要重建 decision_ledger（0069:48-55 的 CHECK + 三张外键表），还要改 `DECISION_OUTCOMES` 和网页标签（`proactive-reminders.tsx:331` 会把未知 outcome 显示成“待批准”，误导）；`discarded` 语义足够诚实（这轮记忆确实没存上）。
- **进队列那一刻就写决策记录**：补做成功后同一轮会出现“已丢弃 + 已保留”两条记录，污染 daily-review 校准；改为终局（放弃）时写，补做成功只留正常 kept 记录。
- **队列放内存**：服务重启即丢，验收的“下一次运行补做”不成立。
- **补做时重放原 run 的 recalled 记忆快照**：原 run 的 `recalled` 映射（`production-run-composition.ts:228-247`）已随运行消失，重建代价高收益低；补做按当前 DB 状态组提示词即可，parse 的 existingIds 兜底 merge/unchanged。

## 四、风险与反例

- **费用叠加**：极端一轮 = 首试 + 捕获重试 + 内层网关重试 = 最多 4 次调用（每次可能带内层重试）。缓解：白名单限定错误码、每轮补做限 2 条、attempt 上限 3。需要 Andy 认可上限。
- **重复写风险**：同一 generationId 并发两次 `processCommittedRun`（补做与残留在途的首试重叠）→ 依赖 ledger/生成 job 的 PK 幂等（推测未核实）。缓解：排水串行逐条 await；`#captured`/`#pending` 集合防同 run 重入。
- **反例（必须防）**：`DISCLOSURE_DENIED` 的轮次若进队列，会每轮烧一次必败调用——已排除。
- **补做在运行中途失去执行权**：assertActive 失败 → attempt+1 下轮再试，不会死循环。

## 五、需要人拍板的取舍

1. 决策记录时机：终局写（本方案）还是进队列即写（验收字面更宽的读法）。
2. 重试/补做费用上限：每轮捕获调用总上限、每轮补做条数、attempt 上限、退避间隔。
3. outcome 复用 `discarded`（零迁移）还是扩枚举（重建表 + 新 UI 标签，语义更精确）。
4. `PORT_CONFLICT` 是否列入可重试白名单（先查清抛出点）。

## 六、必答问题

**1. 是否改变模型已见过的请求开头？** 否。主对话请求完全不动（不新增消息、不改历史、不换系统提示/工具）。捕获是独立后台调用，天然“固定在前、会变的在后”：`MEMORY_CAPTURE.text` 固定开头，会变值全在末尾 JSON 的唯一一条消息里（证实：`production-memory-capture.ts:177-194`）。同轮重试发逐字节相同的 prompt（复用快照与 externalTag 表）；补做是**新请求**，此前从未发过，不违反只追加（依据 `.claude/rules/prompt-prefix.md:35` 第 4、15 条）。每轮会变的值都在最后一条消息里，成立。

**2. 是否产生“同段文字不同字节”？** 否。提示词 JSON 键序字面量固定、people/existing 排序确定性、`messageSentAt` 取自已提交消息的 committedAt（持久不变）；无 `Date.now()`/随机数进提示词（证实，前提 7）。重试字节一致。补做的快照差异属于新请求。时间戳只出现在账本/审计字段，不进模型请求。ledger id 的 sha256 输入不含时间，确定性成立。

**3. 有无自动检查、反向用例会否真失败？** 会新增：调用计数断言的重试成功用例（去掉重试即失败）、队列行存在性断言（去掉入队即失败）、补做准入挂新 run 的断言（用旧 lease 必被拒的反向用例）。现有反向用例先例见 `test/integration/production-memory-capture.test.ts` 与 prompt-prefix 的 `[I-66]` 反例（`.claude/rules/prompt-prefix.md:74`）。未核实：`run-all-checks.mjs` 的收编机制，需确认新用例确实进 `npm run check`。

**4. 每个产生/使用值的两端核对：**
- `memory_capture_deferrals` 行：产生=新迁移+失败路径；使用=排水、日志；两端校验随迁移新增（取号 0090+）。
- invocationId `memory-capture:${runId}:retryN`：产生=`service-main.ts:1986`（改）；使用=准入 identity 校验（`model-invocation-admission-service.ts:425-446` 只比对 lease/model 等，不校验后缀）与 `:retry` 叠加（`production-model-composition.ts:637` 有先例）。长度上限未核实。
- `outcome="discarded"+reason_code="capture_failed"`：产生=终局路径；使用=0069 CHECK（枚举内，通过）、daily-review（`daily-review.ts:204-216`，进 skipped 组、可评价，通过）、网页标签（`proactive-reminders.tsx:331-336`，通过）、`inputs.ruleIds=[]`（符合 P2-7 方向，且未沿用 `automatic-memory-service.ts:572` 的 reasonCode-塞-ruleIds 旧 hack）。
- memory id / generationId / checkpoint jobId：派生式不变，两端（`applyProposal`、`generations.request`、账本 id 派生）照旧；重复 id 的幂等行为未核实，需测试覆盖。
