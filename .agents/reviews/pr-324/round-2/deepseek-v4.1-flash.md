说明：只读代码、未运行测试（当前环境只能读文件和做只读 git 操作）。以下结论中「已证实」均为我亲自读到的代码，「推测」另行标注。

## 一、问题（按严重度）

### 1. 高：敏感事件段的后补嵌入会以 private 分类发给嵌入模型，绕过可见性准入
- 文件:行：`apps/agent-service/src/production-memory-episodes.ts:77`、`packages/memory-engine/src/episodes.ts:268-300`、`packages/memory-engine/src/episodes.ts:186-207`、`apps/agent-service/src/production-run-memory.ts:121-140`
- 问题：本 PR 让事件段可能出现 sensitive 摘要（`summarize` 存 `segment.dataClassification`），但 `backfillEmbeddings` 仍用「当前运行」的 private 分类去嵌入任意未嵌入的 episode。敏感摘要文本会以 private 分类通过 `descriptor.allowedDataClassifications.includes(classification)`，发给只允许 private 的嵌入模型。
- 证据：
  - `episodes.ts:205` `dataClassification: segment.dataClassification`（摘要可能 sensitive）。
  - `production-memory-episodes.ts:77` `#within(request, "memory-episode-backfill", ...)` 用的是运行请求；同文件 `:92-93` 真正摘要时才 `const scoped = { ...request, dataClassification: segment.dataClassification }`。
  - `episodes.ts:284-296` 直接 `readText(episode.contentRef)` 后 `embedder.embed(...)`，没有按 episode 分类。
  - `production-run-memory.ts:121-124` `classification = context?.dataClassification ?? ...`，`:130-140` 只校验 `descriptor.allowedDataClassifications.includes(classification)`；private 作用域下 private-only 模型会放行。
  - `sqlite-memory-operations.ts:1394-1405` 的 `listUnembedded` 只按 `memory_episode_terms` 关联筛选，sensitive episode 有 terms，会被选中。
- 影响：首次敏感摘要嵌入若因模型只允许 private 而失败，下一次运行的 backfill 会以 private 身份成功发送敏感摘要，形成真实的授权绕过，而非「只是没打标签」。
- 建议：`backfillEmbeddings` 逐条按 `episode.dataClassification` 走 `embedWithin`；或在当前 PR 直接跳过高于运行分类的 episode（fail closed）。作者说「留给下个 PR」，但本 PR 已经让 sensitive episode 存在，建议现在就堵住。

### 2. 中：Gmail 检查的判断结果（派生自敏感记忆）仍以 private 封存
- 文件:行：`packages/application/src/services/proactive-mail-check-service.ts:1072-1076`、`:877-889`、`:1287-1295`，`packages/application/src/services/proactive-seal.ts:20`
- 问题：模型调用本身已按 `highestClassification("private", promptMemories...)` 标为 sensitive，但模型输出里的 `judgement.reason/todo` 被写进 insight 的 `summary/reason` 后，`#seal` 仍硬编码 private。派生文本没有继承来源最高分级，和 ADR 0192 第 4 条「派生内容取来源的最高分级」不一致。
- 证据：
  - `:1072-1076` `const dataClassification = highestClassification("private", promptMemories.map(...)); const authority = await model.prepare({..., dataClassification});`
  - `:882-883` `summary: ... judgement.todo, reason: judgement.reason`。
  - `:1287-1295` `contentRef: await this.#seal(trace, { summary: insight.summary, reason: insight.reason, ... })`。
  - `proactive-seal.ts:20` `dataClassification: "private"`。
- 影响：可能含敏感内容的判断理由被当作 private 存储，后续按 private 导出/复审/推送时会低估分级。当前代码里没看到该文本再次进入模型的路径，所以定中。
- 建议：给 `ProactiveSealPort.seal` 增加 classification 参数，把本轮判断的 `dataClassification` 传入；或至少在 insight 写入时按最高记忆分级封存。

### 3. 中低：`highestClassification` 对未知/缺失分级静默降级为低值（失败开放）
- 文件:行：`packages/application/src/services/model-visibility.ts:32-37`，`packages/application/src/ports/proactive-checks.ts:170-173`，`apps/agent-service/src/production-proactive-memory.ts:60-63`
- 问题：`RANK[value]` 对未知值是 `undefined`，比较恒为 false，因此缺失/非法的 `dataClassification` 会保留较低的 `highest`。`ProactiveMemoryHit.dataClassification` 只在类型层必填，运行时没有校验，proactive 路径据此算准入分级。
- 证据：
  - `model-visibility.ts:34-36` `for (const value of values) if (RANK[value] > RANK[highest]) highest = value;`
  - `production-proactive-memory.ts:60-63` 直接 `dataClassification: memory.dataClassification`，未校验。
  - `proactive-mail-check-service.ts:1072-1075` 用它计算发送分级。
  - 对比聊天路径：`pi-runtime-adapter.ts:1168` `if (!isModelVisible(classification)) throw ...`，那里是失败关闭的。
- 影响：若某个 recall 实现或历史数据返回缺失分类，提示词里的敏感文本会以 private 发出。数据库 schema 大概率能约束，所以标「推测」成分较大。
- 建议：`highestClassification` 遇未知值时抛错或断言；`ProactiveMemoryHit`/`EpisodeSegment` 的构造边界加运行时校验。

### 4. 中低：`#ownerScoped` 信任工具返回的 `contentClassification`，可能把结果载荷降级存储
- 文件:行：`apps/agent-service/src/production-runtime-tools.ts:674-705`
- 问题：`recorded = contentClassification ?? recorded` 没有对 `contentClassification` 做下限校验；若未来工具返回低于 `invocation.dataClassification` 的值，敏感结果会以更低分类写入 `runtime-tool-output` 和 `runtime-tool-result`。适配器的 `#raiseVisible` 有 floor，模型准入不会降级，但持久化分类会错。
- 证据：`:674-683` `let recorded = invocation.dataClassification; ... recorded = contentClassification ?? recorded; ... this.#writeJson(invocation, \`runtime-tool-output:${key}\`, value, recorded)`；`:705` 结果载荷也用 `recorded`。
- 现状：唯一生产者 `recallWithClassification` 用 `highestClassification(invocation.dataClassification, ...)`（`production-memory-recall.ts:260-263`），所以当前不会触发；属防御性问题。
- 建议：`recorded = highestClassification(invocation.dataClassification, [contentClassification])`，并在写之前用 `isModelVisible` 校验。

### 5. 低：非法/受限分类在工具执行后抛 `TypeError`，整次运行失败
- 文件:行：`packages/runtime-pi/src/pi-runtime-adapter.ts:1163-1175`、`:2038-2042`
- 问题：`#raiseVisible` 在分类不是模型可见时抛 `TypeError("RUNTIME_CONTENT_NOT_MODEL_VISIBLE")`，此时工具已执行、结果已落盘。当前所有生产者都不会返回 restricted，属失败关闭，但错误形态是崩溃式失败。另有 `#visibleClassification` 在 `finally` 删除后，若仍有异步工具回调再调用 `#raiseVisible`，会重新插入孤条目（资源泄漏，推测）。
- 建议：改为可控的工具错误/运行失败码；如需保留，确认所有工具回调都在 `finally` 前结束。

### 6. 低：文档/配置与代码的小不一致
- 已证实：
  - `docs/adr/0192` 与 `.claude/rules/prompt-prefix.md` 已加入旧对话一次性前缀变化的例外；代码行为与例外一致（见 Q1）。
  - 配置退役：`packages/platform-node/src/strict-configuration.ts:1177-1179` 接受 `maxMemoryClassification` 并返回 `retiredKeys`；`service-main.ts:658-663` 记 `configuration.key_retired`。`scripts/delivery-mode/packet-template/acceptance/cloud/probe-source/test/qualification/sandbox-install-restart-probe.mjs:850` 仍写着 `maxMemoryClassification: "private"`，因为配置现在接受该键，不会坏。
- 可指摘点：`retiredKeys` 对 `maxMemoryClassification` 的取值不做任何校验（以前非法值会被 `classifications()` 拒绝），现在写什么值都静默接受；`startup log` 没有直接测试（作者已承认）。

## 二、读代码证实「没问题」的关键路径

- 运行完成写线程消息接受更高分类：`packages/persistence-sqlite/src/sqlite-run-lifecycle-operations.ts:762-795` 取最终回答载荷分类，只在回答分类低于 `max(trigger 分类, input.dataClassification)` 时拒绝；敏感回答 + private 运行会通过。`:837-855` 用回答分类 `dataClassification` 提交线程消息，不受运行 private 限制。
- 最终回答/历史/留档使用可见分级：`pi-runtime-adapter.ts:1809-1811`（final answer）、`:1617-1620`（captureHistory）、`:1431/:1450`（provider request/response）、`:2133`（runtime.message）、`:2193/:2216/:2235`（tool intent/result/compaction）均为 `this.#visibleOf(request)`。
- 准入使用提升后的分级：`pi-runtime-adapter.ts:1247-1251` 设置可见分类，`:1580` 用 `{ ...request, dataClassification: this.#visibleOf(request) }` 调 `admitPiStream`；`:2038-2042` 在工具结果返回后提升。
- 真实准入校验存在：`packages/application/src/services/model-invocation-admission-service.ts:481-487`；单测 `model-invocation-admission-service.unit.test.ts:90` 有 `["classification", { dataClassification: "restricted" }]` 反向用例。作者「桩测试 + 真实校验单测覆盖」的说法成立。
- 附件读取与失败路径：`context-projection-service.ts:504-535`；`read()` 在 `readText` 成功后才 push 分类（`:512`），所以受限/缺失附件走 `UNREADABLE_ATTACHMENT` 时不会抬高分级；`readText` 的超限报错在 `:561-568`。
- `contentClassification` 汇总：`context-projection-service.ts:90-103` 覆盖 runtimeHistory 引用、history、contextBlocks（含 owner profile）、workerBlocks、附件分类，并以 `input.dataClassification` 为底。
- 压缩提案：没有找到读取 `proposalRef` 的消费方；`run-coordinator.ts:1093-1100` 只把事件写 trace，不读载荷内容。因此更高分级可被接受；但也意味着没有端到端测试。

## 三、侧重检查（错误路径、不可信输入、安全、资源耗尽、不可撤销操作、文档一致性）

- 错误路径：附件受限/缺失→显示「读不出来」且不抬分级，已证实（见上）；工具返回非法分类→聊天路径 `#raiseVisible` 抛错失败关闭；但 proactive 的 `highestClassification` 是失败开放（问题 3）。
- 不可信输入：`ProactiveMemoryHit.dataClassification`、`EpisodeSegment.dataClassification`、`RuntimeToolSettledResult.contentClassification` 都是运行时来自数据/端口的值，只有类型约束；问题 3、4 与此相关。`retiredKeys` 接受任意值（问题 6）。
- 安全：问题 1 是真正的敏感数据越权发送风险；问题 2 是派生内容分级不一致；问题 4 是潜在降级存储。
- 资源耗尽：`#visibleClassification` 每 run 删除（`pi-runtime-adapter.ts:1150-1155`）；若 finally 后仍有回调会重新插入孤条目（推测，未核实）。`highestClassification` 对这些小集合无性能问题。
- 不可撤销操作：本 PR 不涉及删除/外部副作用；但 sensitive 判定会直接导致请求被拒（不可回滚的运行失败），属预期。
- 文档一致性：ADR 0192 关于附件、最终回答、压缩摘要、配置退役、旧对话一次性前缀变化的描述与代码基本一致；不一致处是问题 2（proactive 派生输出仍 private）和问题 6（非法退役键值静默接受）。ADR 的「事件段补嵌入留给下个 PR」在文档里承认了，但问题 1 说明它不是单纯「缺标签」。

## 四、必答问题

### Q1：是否改变模型已见过的请求开头？是否仍只在末尾追加、每轮变化值都在最后一条消息里？
- 新对话：是只在末尾追加。每轮变化的内容（时间、当前 prompt、owner profile/记忆/摘要 context blocks、工具结果、新回答）都进入当轮最后一条 `<himawari-context> + <owner-message>`（`pi-runtime-adapter.ts:600-618`），系统提示和工具定义不变。已存历史字节不变；`contentClassification` 只影响准入/存储标注，不改消息文本。
- 旧对话：会改变一次请求开头。`context-formation-service.ts:147-193、270-312、403-409` 把过滤从 `min(运行分类, maxMemoryClassification)` 改为 `VISIBLE_RANK`（sensitive），以前被挡在模型外的 sensitive 历史 owner/agent 消息可能在部署后第一轮出现在历史中间。`.claude/rules/prompt-prefix.md` 第 4 条与 ADR 0192 Consequences 已把它写成一次性例外（Andy 同意）。system 角色的敏感历史走 `systemBlocks` 进入当轮 context block（`context-projection-service.ts:388-397`），属于末尾追加，不改历史中间。
- 未核实：没有测试覆盖「旧对话升级后第一轮」的实际前缀变化；如果配置了 `maxThreadMessages`，通常只会在首轮把旧敏感消息纳入窗口，之后随新消息被挤出，但这一点未用测试证实。

### Q2：同一段文字会不会在不同请求里变成不同字节？
- 未发现本改动引入这种变化。`highestClassification` 是顺序无关的最大值；分类只影响准入和存储级别，不改消息文本。出口遮盖的占位符是对 `(kind,value)` 的 HMAC（`model-egress.ts:121-126`），密钥不变时确定；本改动没有加入时间、随机数或无序列集合到消息文本。
- 一个存储层现象：`RuntimeHistoryService.save` 以 `${dataClassification}:${serialized}` 去重（`runtime-history-service.ts:55`），可见分类在同一 run 内升高时，同一消息可能以 private、sensitive 各存一份；消息字节相同，请求字节不变，但会多一份存储，不是字节不稳定。
- 未核实：若外侧 redaction ruleset 会随请求变化，本 PR 未涉及，我没有继续核对其对字节的影响。

### Q3：有没有自动检查？反向用例真的会失败吗？
- 有。`test/integration/memory-model-visible.test.ts` 覆盖：敏感记忆进入 private 会话并按 sensitive 准入/遮盖、名单止于 private 时拒绝且无请求体、全 private 仍按 private、敏感附件进入模型视野并抬高 contentClassification、敏感 recall 后下一次调用升 sensitive 且最终回答/history 存 sensitive、敏感工具结果下一轮仍在。
- `packages/runtime-pi/test/prompt-prefix.compat.test.ts` 新增 `[RULE-memory-visible]`，覆盖敏感记忆/工具结果后续轮次只追加。
- Proactive：`test/integration/proactive-mail-check.test.ts` 新增敏感记忆标注 sensitive、prompt 不含 `dataClassification`、全 private 反例；单元测试覆盖 recall/episodes/consolidation/owner profile/daily review/配置退役。
- 反向用例会失败：若把 `captureFinalAnswer` 改回 `request.dataClassification`，`chat.answers` 的 sensitive 断言会失败；若附件 ceiling 回退，附件 `contentClassification`/内容断言会失败；若工具结果不 raise，`admitted` 序列会失败。作者说法基本成立。
- 覆盖缺口：附件用例只断言投影分类，没有直接断言该轮准入为 sensitive；`sqlite-run-lifecycle-operations` 接受更高最终回答分类没有自动测试（只由我读代码确认）；压缩提案存 sensitive 没有测试；`configuration.key_retired` 日志无测试；真实检索索引（sensitive 不进全文/实体索引，见 `memory-engine-index.test.ts:307-308`）没有被端到端测试覆盖，测试主要走 reference adapter/桩。真实准入本身有单测（见上）。

### Q4：每个新/改值，产生方与使用方的校验是否匹配？
- `RuntimeProjection.contentClassification`：产生于 `ContextProjectionService`（已含附件分类），消费于 `pi-runtime-adapter`（`#raiseVisible`）；测试桩可省略，适配器回退到 run 分类。两端可接受。
- `RuntimeToolSettledResult.contentClassification`：产生于 `ProductionRuntimeTools`/`recallWithClassification`，消费于适配器并随结果 JSON 持久化；被 `#ownerScoped` 信任而未做下限校验（问题 4）。当前生产者 >= run，故现状安全。
- `ProactiveMemoryHit.dataClassification`：产生于 `createProactiveMemoryRecall`，消费于 `#batchMemories`→`highestClassification`；运行时无校验（问题 3）。prompt JSON 已剥离该字段（`proactive-mail-check-service.ts:382-398`），不会把标签发给模型。
- `EpisodeSegment.dataClassification`：产生于 `dueSegments`，消费于 `summarize`/`generate`/`record`，一致；后补嵌入未接收它（问题 1）。
- `RunPolicyConfiguration.retiredKeys`：产生于 `strict-configuration`，消费于 `service-main` 日志与测试；无其他 TS 使用点。可接受，但值不校验（问题 6）。
- `recallWithClassification` 返回结构：产生方 `ProductionMemoryRecall`、消费方 `ProductionRuntimeTools` 一致；`ProductionRuntimeToolsOptions.memoryRecall` 的构造点（service-main、测试）都已改为 `recallWithClassification`。
- sqlite 完成校验：接受更高（`sqlite-run-lifecycle-operations.ts:762-795`），两端口径一致。
- 压缩提案载荷：没有消费方读取，故不存在下游校验拒绝更高分类的问题；但也因此「消费方能否接受」目前是**未被代码使用**，只能标「未核实/无消费方」。
- 附件失败路径：失败时不 push 分类、显示不可读，接受更高分级只在成功读取时发生，设计一致。
