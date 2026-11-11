# P3-2 复核报告（83d50b79 对比 aa1b0b0b）

## 侧重检查（测试覆盖、文档一致性、普通流程走查）

**走查的流程**：主人发消息 → HTTP submit → `ProductionRunDispatcher.claim` → `RunCoordinator.executeAttempt` → `ContextFormationService.form`（每轮恰好一次 `memory.search`，context-formation-service.ts:236）→ `production-run-memory.ts` 的 `search`（scope.run 包住请求，344-366 行）→ `DurableMemoryService.search`（durable-memory-service.ts:367-428）→ `HybridMemoryProvider.search`（embed 失败 → 调一次 `onVectorFailure` → 以 `embedding = null` 继续关键词+实体查索引，hybrid-memory-provider.ts:139-168）→ 候选按 score、id 确定性排序（context-formation-service.ts:250-252）→ 上下文信封 → Pi → 对话模型调用。每条路径我都读到了对应代码。

**测试覆盖结论**：
- 覆盖到的：新的 `[P3-2]` 集成用例三种失败模式（断网/不报费用/402），断言 run 完成、请求末条消息带关键词记忆、有降级记录、嵌入已结清、账户 active、402 时有带状态码的 `memory.embedding_failed` 日志；反向用例（第一轮嵌入正常时 `degradeRows()` 为空，test:1788）。单元测试改成：query 模式按预估结清（inputTokens 16384）、projection 模式仍 markUnknown、取消保持 unknown、截止时间已过则结清（production-model-composition.unit.test.ts:1714-1781）。
- 没覆盖到的（读代码证实的）：① `embedOnce` catch 里 `permit.settle` 自身抛错的情形（无任何测试）；② 取消时 `markUnknown` 自身抛错的情形；③ recall 工具（走 `embedWithin`，production-memory-recall.ts:54-58）的嵌入失败在按预估结清新行为下的表现，单元夹具只有 query/projection 两种模式，没有 recall 模式；④ 一轮写多条降级记录检测不到（见发现 4）。

**文档与代码一致性**：ADR 0216、ADR 0109 补注、I-11 均已核对；发现 1、5、6 三处不一致，见下。

---

## 发现（按严重度从高到低）

**1.（中）作者的说法有误：改动前 recall 工具的嵌入失败同样会让整轮失败，不是「照常继续」；且按预估结清的代码范围比 ADR 写的「聊天路径」宽**
- 文件：docs/adr/0216-chat-memory-lookup-falls-back-to-keywords.md:27-31、50；apps/agent-service/src/production-memory-recall.ts:54-58；apps/agent-service/src/production-run-memory.ts:279
- 问题：ADR 背景和作者说法称「Gmail 检查和回忆工具都照常继续，只有聊天路径整轮失败」。读代码证实：recall 工具的嵌入走 `embedWithin` 进入与聊天搜索同一个 run 作用域的 `embedOnce`；在旧代码里，recall 嵌入发出后失败（非 3 秒超时）同样走 `markUnknown("transport_unresolved")` → `model_budget_accounts` 状态变 `reconcile_required`（sqlite-model-budget-operations.ts:684-689）→ 后续对话模型调用被预算拒绝，整轮照样失败。检索层的关键词退回和降级记录对 recall 确实早已存在（service-main.ts:1242 复用同一 HybridMemoryProvider），但「预算账户被锁、整轮失败」这一点 recall 和聊天是同病。相应地，新代码的结清条件 `runEmbedding = !projection && !mail`（production-run-memory.ts:279）覆盖**所有** run 内嵌入（聊天搜索 + recall 工具），而 ADR 决定 2 只写「聊天路径的嵌入请求……按预估上限结清」。实现是对的去掉了这层失败，但文档把范围写窄了。
- 证据：`production-memory-recall.ts:54-58`（`embedWithin` 选项声明）；`production-run-memory.ts:279`（`const runEmbedding = !projection && !mail;`）；`sqlite-model-budget-operations.ts:688`（markUnknown 后账户 `"reconcile_required"`）。
- 建议：改 ADR 0216 决定 2 的措辞为「run 内所有嵌入（聊天找记忆、recall 工具）」，并在前提 3 里如实写明 recall 路径改动前也会因 `reconcile_required` 失败整轮。

**2.（中低）catch 里的按预估 settle 自身抛错时会吞掉原始错误，且预留预算悬挂——无测试覆盖**
- 文件：apps/agent-service/src/production-run-memory.ts:286-292；packages/persistence-sqlite/src/sqlite-model-invocation-operations.ts:655-657
- 问题：作者问的「permit.settle 自身抛错、执行租约丢失」场景读代码证实存在：持久层 settle 前会 `assertCurrentAuthority` + `assertExecutionLease`（sqlite-model-invocation-operations.ts:655-657）。若租约已丢/权限已换/盘水位不足，catch 里的 `await permit.settle({...预估})` 抛错并**替换**原始嵌入错误向上抛；随后 hybrid 层照样捕获、写降级记录、继续关键词搜索（hybrid-memory-provider.ts:150-152 捕获所有错误），run 得以完成，但该笔嵌入 allocation 停在 `started`、账户的预留额度（reservedCostMicros）无人释放，也没有兜底的 `markUnknown` 或 `releaseReserved` 尝试。这**不是本次改动的回归**（改动前 `markUnknown` 在同样条件下也抛同样的错、同样悬挂），但「错误被替换 + 悬挂预留」这一组合此前没有任何测试，本次改到了这段逻辑也没补。
- 证据：`production-run-memory.ts:286-292`（catch 中直接 `await permit.settle(...)`，无 try 包裹、无兜底）；`sqlite-model-invocation-operations.ts:657`（`this.assertExecutionLease(row, input.executionLease);`）。
- 建议：给 catch 里的 settle/markUnknown 各包一层兜底（失败时至少尝试 releaseReserved 并保留原始错误），或至少补一条「settle 抛错时原始错误仍向上抛、run 不崩」的单元用例。

**3.（低）「请求发出后失败才结清」与实现不符：markStarted 之后、请求未必真的发出，也按预估记账**
- 文件：apps/agent-service/src/production-run-memory.ts:246-247、257、273-274
- 问题：读代码证实：`started = true` 在 `send` 之前置位（246-247 行）；若 `send` 在本地就失败（例如密钥解析失败、出口层校验错误，请求根本没离开进程），catch 同样按预估上限结清——为没发出的请求记了钱。另外 273 行在响应**已经收到**、用量已经算出后若截止时间已过会先抛 `EMBEDDING_DEADLINE_EXCEEDED`，catch 再按预估结清，把真实用量丢掉按上限多记。金额极小，且 ADR 后果一节已承认「可能比实际多记一点钱」，故仅低危，但 ADR 决定 2「嵌入请求发出后失败」的措辞与实现不一致。
- 证据：`production-run-memory.ts:246-247`（`await permit.markStarted(); started = true;` 先于 257 行 `response = await send(...)`）。
- 建议：把 ADR 措辞改为「已开始（markStarted 之后）的失败按预估结清」，与代码一致；或把 273 行改为在抛错前用已有 `usage` 结清。

**4.（低）`[P3-2]` 用例名为「writes one retrieval fallback record」，但断言检测不到多条记录**
- 文件：test/integration/production-http-composition-process.test.ts:1821-1829
- 问题：读代码证实：`new Set(degradeRows().map(row => JSON.stringify(row)))` 会把**内容完全相同的多行**去重成一个元素，因此若一轮写出两条同内容的降级记录，断言仍然通过；`degradeRows()` 又是全表查询。作者问「会不会一轮写多条」——机制上一轮一次 `memory.search` 只调一次 `onVectorFailure`（hybrid-memory-provider.ts:150-152），3 秒超时重试发生在同一次 embed 调用内部，不重复记录；但运行被中断、checkpoint 尚未保存到 `context_formed` 就重试时 `context.form` 会重跑、再记一条（读代码推断，未构造复现）。
- 证据：test:1822 `new Set(degradeRows().map((row) => JSON.stringify(row)))`。
- 建议：把断言改成先 poll 到恰好 1 条再比对内容，或至少保留原始行数不做 Set 去重。

**5.（低）ADR 0216 部分取代 ADR 0109，却没按仓库惯例写 `amends:` 元数据**
- 文件：docs/adr/0216-chat-memory-lookup-falls-back-to-keywords.md:3-9
- 问题：读代码证实：仓库 33 份部分修正型 ADR 都带 `amends:` 字段（如 ADR 0031 明确写了「整份 supersede 用 supersedes、部分修正用 amends」的约定），ADR 0216 的 frontmatter 只有 `supersedes: ""`，正文虽互相链接、0109 也补了后续注记，但元数据缺了这一项。
- 证据：0109/0216 两份文件 frontmatter 与 ADR 0031 第 139 行的约定说明。
- 建议：给 0216 补 `amends: "docs/adr/0109-paid-eval-runs-need-cost-cap-and-preflight.md"`。

**6.（低）I-11 引用的测试与 engineering-casebook 的表述部分过时**
- 文件：docs/incidents-and-gates.md:50；docs/engineering-casebook.md:3199
- 问题：读代码证实：I-11 里「（测试 …`apps/control-center/test/execution-view.unit.test.ts`…）」一句描述的是旧门槛，该测试本次已删掉 `CONTEXT_MEMORY_QUOTA_EXCEEDED → quotaExceeded` 的断言（execution-view.unit.test.ts 改后只对 `CONTEXT_MEMORY_UNAVAILABLE` 断言通用失败文案），引用已不成立，虽然后面补的句子说明了删除。另外 engineering-casebook.md:3199 仍把「402 单独记成 `CONTEXT_MEMORY_QUOTA_EXCEEDED`，网页用三语告诉主人是额度用完了」当作现状描述，本次未更新。
- 证据：git diff 中 execution-view.unit.test.ts 的删改；casebook:3199 原文。
- 建议：I-11 那句测试引用改为只指 402 日志检查（`[P3-2]` 用例）与 `PI_MODEL_QUOTA_EXCEEDED` 相关测试；casebook 补一条后续注记。

**7.（信息）删除的 RunCoordinator 分支原本就没有直接测试；删除安全**
- 文件：packages/application/src/services/run-coordinator.ts:470-489
- 问题：读代码证实：全仓 grep 无任何测试引用这两个失败码；该分支只捕获 `PROVIDER_FAILURE` + 这两条 message 的错误，而生产代码里已无任何产生方（grep 全仓仅剩文档、一条 legacy 记录的展示测试和历史证据 README）。分支删除后，`context.form` 的其他错误路径与改动前完全相同（原来对非这两码的错误也是直接向上抛，executeOwned 只有 try/finally，最终由 `ProductionRunDispatcher.executeClaimed` 的 catch 以 `RUN_EXECUTION_FAILED_WITHOUT_RESULT` 走 reconcile，production-run-dispatcher.ts:644-670），进程不会崩溃、run 不会卡死。
- 证据：grep 结果；run-coordinator.ts:215-221（try/finally 无 catch）；dispatcher 659-669。
- 建议：无需动作；可在 ADR 验证一节注明「该分支此前无测试，删除以 grep + 全量测试兜底」。

---

## 「读代码证实的」与「推测」的区分

- **证实**：发现 1-7 引用的代码行为（search 不再抛错、catch 结清条件、markUnknown 的预算后果、持久层 settle 校验、测试断言原文、文档原文、全仓无残留引用）。
- **推测（未构造复现/未运行）**：① 中断恢复重跑 `context.form` 会写第二条降级记录；② 悬挂的 `started` 预留在 run 正常完成后是否/如何被清理——我在持久层和协调器里没有找到针对该情形的释放路径，**未核实**；③ 新旧代码下测试的实际通过/失败是按断言矛盾性推理的，未实际执行；④ `npm run check` 的文档校验是否强制 `amends:` 字段，**未核实**。

## 必答问题逐条回答

1. **会不会改变模型已见过的请求开头？** 不会。改动只动了失败路径和记账，没碰任何请求组装代码；降级记录写进 `decision_ledger`（给 Andy 评价用），不进模型请求。新路径下关键词找到的记忆作为「本轮选中的记忆」按既有机制进入该轮最后一条用户消息（规则 §一.2 明文允许），此前失败的轮次根本没发过请求，不存在「改写已发内容」。逐字节比对的 `[PR-A]/[PR-B]` 用例和 `check:prompt-prefix` 未被本次改动触碰。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会。新增值里进请求的只有「本轮选中的记忆」，排序是确定性的（score、id）；降级记录的 `ledger:${randomUUID()}` 和时间戳只存在于决策记录表；结清金额是常量 16384×单价；`failure: quota_exceeded/unavailable` 只进日志。遮盖逻辑未被触碰。
3. **有没有自动检查、反向用例会不会失败？** 有：`[P3-2]` 集成用例（三模式 + 反向空检查）、单元测试（结清/unknown/取消/截止四个分支）、execution-view 测试。按断言与旧行为的直接矛盾推理，反向用例在旧代码上都会失败（run 状态 failed 对 completed、markUnknown 对 settle）；但未实际运行，**未核实**。缺口见发现 2、4。
4. **每个产生/修改的值两端都能接受吗？** 逐个核对过：删除的 `CONTEXT_MEMORY_*` 常量——生产者（production-run-memory、run-coordinator、thread-execution-projection、execution-view、i18n、MESSAGE_IDS、测试）全部同步删除，grep 无残留；新字符串 `quota_exceeded/unavailable` 只作日志字段，无结构化消费方；新导出 `retrievalDegradeRecorder` 的签名与 service-main.ts:359 和测试夹具两处调用一致；`retrieval_degrade`/`degraded`/`vector_search_unavailable` 在端口校验（decision-ledger.ts:34、46）、网关契约、i18n、校准、网页组件中均为既有合法值，且 decision-ledger.test.ts:924 已有用例真写通过。`@himawari-agent/application` 是公开包，删除导出对仓库外消费者的影响**未核实**。
