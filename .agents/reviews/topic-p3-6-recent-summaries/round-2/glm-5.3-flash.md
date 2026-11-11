# 审核结论：Gmail 检查带上最近两天的日摘要

先说我核实过的关键事实（全部读到代码级）：日摘要确实只在聊天 run 开始时生成（`apps/agent-service/src/production-memory-episodes.ts:9` `MAXIMUM_EPISODES_PER_RUN = 1`，由 `production-titled-runtime.ts:47` 在 run 开始时调 `start(request)`）；邮件判断是一次性后台调用，prompt 由 `proactivePrompt` 组装（`packages/application/src/services/proactive-mail-check-service.ts:374-411`），顺序已是「固定说明 → 记忆 → 邮件 → 现在是…」；`memory_episodes` 表确有 `UNIQUE (thread_id, source, first_sequence)` 和 `(owner_id, agent_id, day)` 索引（`packages/persistence-sqlite/src/migrations/0053_memory_episodes.sql:24,27`），方案第 1、2 条的索引与去重前提成立。

## 问题清单（按严重度）

**高 1：补生成放在判断之前，会挤占检查的时限和每日费用预算，可能让当天邮件不判。（证实：机制；发生频率推测）**
- 证据：`run()` 在开始就起了 `perCheckMs` 的硬定时器（`proactive-mail-check-service.ts:627-631`），判断循环里超时即 `stop="capped"`、费用超即 `capped_daily`（:771-779），未判的邮件整批丢弃（:833-857）。每段摘要是独立模型调用，输入最多 16000 字符（`packages/memory-engine/src/episodes.ts:24`），3 段就可能是检查预算的大头。方案说「读失败不挡判断」，但补生成慢/失败同样吃 deadline。「总花费不增加」的说法只对全局成立：聊天 run 的摘要费用不走 `store.costSince` 这个账本，把它挪进邮件检查的每日上限，等于用邮件判断的预算付记忆的钱。
- 建议：补生成挪到判断循环**结束之后**（`tick()` 内、decision 记录前），或给它单独的小预算/单独超时；每次补生成调用前重算当日余量，不要只在开头查一次。

**高 2：sensitive 摘要会把调用分级抬到 sensitive，而邮件判断模型只保证允许 private——不允许 sensitive 时整批邮件判不了。（证实）**
- 证据：`proactiveModel` 组成时只检查 `allowedDataClassifications.includes("private")`（`apps/agent-service/src/production-model-composition.ts:502`），`prepare` 时分级不在允许列表直接 throw `PROACTIVE_MODEL_DISCLOSURE_DENIED`（:522-523）；这个 throw 发生在 `#judge` 里，被 `:789` 的 `.catch` 变成 `MODEL_CALL_ERROR`，批次 → `stop="failed"`（:808-809）。方案测试「sensitive 摘要让调用分级变 sensitive」只会在模型恰好允许 sensitive 时通过。
- 建议：接线时校验 descriptor；不允许 sensitive 就不注入 sensitive 摘要（记 `partial`），而不是抬级。并在测试里加这条反向用例。

**高 3：决策记录新字段只写了 SQLite 两端，读取端链条没列全，违反 2026-11-09 决策记录写入约定规则 5。（证实）**
- 证据：约定明确「改写入方时同时补测试：读取端的 `test/integration/decision-chain.test.ts` 必须能列出新字段」（`docs/execution/specs/2026-11-09-decision-record-write-convention.md:54`）。消费链至少还有：`DecisionInputs` 类型（`packages/application/src/ports/decision-ledger.ts:83-85`）、读默认值（`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:139-209`，现有字段全部 `?? false/[]/"off"`）、决策链组装（`apps/agent-service/src/production-decision-chain.ts:117-124`）、网关合约（`packages/gateway-contracts/src/contracts-v2.ts:1044`）、控制中心抽屉（`apps/control-center/src/components/decision-chain-drawer.tsx:200`）。这正是 I-73 的教训——`docs/incidents-and-gates.md` I-73：「双模型复核只看了 diff，没问『清单里的 id 能通过后端校验吗』」。
- 建议：方案第 6 条把上面每个文件逐一列出；`summaryIds` 若要在抽屉显示，注意它是 `memory_episodes.id`（`episode:day_summary:…`），不是 `memory_records.id`，抽屉的记忆分支（按记忆 id 读视图，`production-decision-chain.ts:136`）不能复用，需单独展示或只显示计数，且摘要随线程删除（`sqlite-governed-deletion.ts:781`）后要按约定「这条记忆已不存在」处理。

**中 4：直调 `MemoryEpisodeService.summarize()` 会绕过嵌入的预算包装。（推测，机制有据）**
- 证据：聊天路径把 `summarize`（内含 `embedder.embed`，`episodes.ts:342`）包进 `embedWithin` 预算槽（`production-memory-episodes.ts:99-108`、`service-main.ts:1414-1435`）；检查路径若直接调 `service.summarize`，嵌入不记账，失败则被 `onEmbeddingFailure` 吞掉 → 该段无向量只进词索引。方案没提嵌入。
- 建议：检查侧复用 `ProductionMemoryEpisodes` 的封装（`assertActive` 换成 AbortSignal），不要手写第二套生成逻辑。

**中 5：失败路径的 payload 泄漏。**
- 证据：`#check` 的 catch 只释放 `trace.payloads` 和 `trace.sealed`（`proactive-mail-check-service.ts:664-676`）；补生成若走 `ProactiveModelInvoker.prepare`（`payloadBoundary.writeText`，`production-model-composition.ts:525`），其 input/output ref 不进 `trace.payloads` 就不会释放。
- 建议：补生成的 payload ref 全部登记进 trace；同时写明决策记录 `modelPayloads` 是否包含摘要调用（上限 5000 不会触顶，但要定）。

**中 6：端口新方法是三处接线，方案只写了一处。（证实）**
- 证据：`MemoryEpisodeStorePort` 的方法出现在 SQLite 实现、dispatch case（`sqlite-memory-operations.ts:405-437`）和 durable IPC 代理（`durable-adapters.ts:1121-1129`，`memoryEpisodes()` 每个 method 映射一个 `"memoryEpisode.*"` 操作走 worker 通道）。
- 建议：方案写全三处，集成测试补一条 durable 模式（worker）路径——现有测试常用 `describe.each(["worker","direct"])` 的写法（如 `decision-signals.test.ts:43`）。

**中 7：测试计划缺两条反向用例。**
- (a) 聊天 run 与检查并发补生成同一段：`UNIQUE` 去重值得一条真并发用例；(b) 上文高 2 的 disclosure-denied。另外「同一批摘要渲染两次字节相同」要从 DB 查询到渲染字符串整段比对，不能只测渲染函数。

**低 8：接线细节。**
- `MemoryEpisodeService` 只在 `memoryComposition && episodeProtector` 存在时构造（`service-main.ts:1378`），可能 undefined，接线必须可选；读摘要正文必须复用同一条 unprotect 的 `readText`（:1383-1389），方案没写这条解密路径。
- 摘要文字应纳入 `#reportMasked` 的敏感值上报范围（现在只扫邮件字段，:524-557）——摘要和记忆文字一样直接进 prompt，`onMasked` 是否覆盖它们需写明（此点未核实到出口遮盖在 proactive 调用内的具体行为，标推测）。

**低 9：`dueSegments` 不按天过滤。**
- 它按 `listUnsummarized` 的存储顺序取「已关闭」段（`episodes.ts:121-151`），补出来的可能是更早的天，那些摘要生成后进不了「今天+昨天」的注入窗。行为无害（替聊天 run 省了未来的调用），但 ADR 里「补齐昨天的」要写准。

**未核实**：brief-plan.md 在仓库中不存在（方案前提文件，无法核对）；生产环境的邮件判断模型 descriptor 是否允许 sensitive；出口遮盖在 proactive 统一出口内对摘要文字的具体行为。

## 侧重检查

我走的普通流程：Gmail 检查一次 tick 的完整路径——`ProductionProactive.tick`（`production-proactive.ts:205`）→ `ProactiveMailCheckService.run` → `#checkTraced`：读设置/连接 → fetch → 分类/候选 → `costSince` → 关联邮件 → `#recall` 记忆检索 → 批次判断 `#judge` → 规则/回退门 → `#finish` 写决策记录。**无测试覆盖的路径**（本次改动新引入或现有测试没碰到）：补生成所在的前置段（新增代码）、`listDaySummaries`（新方法）、决策记录新字段在抽屉/UI 的展示链（`decision-chain.test.ts` 现无 summary 断言）、durable 模式下的新端口方法。聊天流程单独走了一遍：`service-main.ts:1378` 构造 `MemoryEpisodeService`、`production-titled-runtime.ts:47` 启动，方案「普通聊天路径一行不改」与代码结构相符。规则一致性：`prompt-prefix.md` 第 15 条（后台调用固定在前、会变的在后）与方案第 4 条的提示顺序一致；prompt 目录机制（`prompt-manifest.json` sha256 登记、`prompt-catalog.unit.test.ts`、`entry.ts:59` 24 字符门槛）存在，方案第 8 条已提。

## 必答问题

1. **不会改变模型已见过的请求开头。** 聊天路径零改动（方案第 7 条与代码相符）；聊天里摘要只会通过记忆搜索结果进入每轮最后一条消息的资料块（规则 2 允许「本轮选中的记忆」在最后）。邮件判断是一次性后台调用、无历史，prompt 固定说明 `MAIL_JUDGMENT` 在最前，摘要块插在固定说明之后、数据与「现在是…」之前，每轮会变的值（摘要、记忆、邮件、时间）都在后段，符合规则 15；补生成调用的 `episodeSummaryPrompt` 也是固定说明在前、数据在后（`episodes.ts:98-103`）。新固定标题需登记 prompt-manifest（sha256，会被 `prompt-catalog.unit.test.ts` 拦），只影响邮件判断这个不冻结请求头的调用，聊天请求头不涉及。业界依据：Anthropic/OpenAI 的缓存匹配是请求开头逐字节相同（见 `.claude/rules/prompt-prefix.md:6` 引用的 [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)、[OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)），本改动不动任何已发历史。
2. **设计上可以做到字节确定，但要补三处硬性规定**：查询固定 `ORDER BY day DESC, ended_at DESC, id ASC`（方案已写）；`[{day,text}]` 的 JSON 键顺序固定、渲染从旧到新（方案已写）；摘要正文读出后是否 trim/截断要定死（参照 `#batchMemories` 对记忆文本的 `replace(/\s+/gu," ").trim().slice(...)`，`proactive-mail-check-service.ts:1265`——方案未写）。`localDay` 是纯函数、时区两端一致（`service-main.ts:1408` 与 `:1581` 同用 `runPolicy.timeZone ?? "UTC"`），无时间戳字段、无无序集合进 prompt。
3. **有计划中的自动检查，反向用例多数会真失败**（前天/restricted/占位段/无摘要 → 无块、`injected=false` 是直接断言），但有两个缺口：模型不允许 sensitive 的反向用例会以 `PROACTIVE_MODEL_DISCLOSURE_DENIED` 的意外方式失败（高 2）；并发竞态用例缺。另注意 `npm run check:prompt-prefix` 只跑聊天多轮（`prompt-prefix.md:74`），不覆盖邮件判断调用——本改动的前缀保障完全落在新的集成测试上，应加「MAIL_JUDGMENT 原文不变、摘要块位于记忆块之前」的字节级断言。
4. **两端核对不全，方案第 6 条需要扩**：已核对的两端——决策记录写校验（`sqlite-proactive-operations.ts:643-690`）与读默认（`sqlite-decision-ledger-operations.ts:139-209`）方案已提；漏的：`DecisionInputs` 类型、决策链抽屉、网关合约、控制中心 UI、`decision-chain.test.ts`（高 3）；端口方法三处接线（中 6）；`summaryIds` 与记忆 id 不是同一命名空间（高 3）；`MemoryEpisodeService` 可能 undefined 及摘要正文的 unprotect 读取路径（低 8）。SQLite 索引与 UNIQUE 前提已证实成立。

## 如果由我来定

1. 补生成移到判断循环之后执行，带独立小额预算，费用仍记进本次决策；
2. sensitive 摘要在注入前按 descriptor 允许与否过滤（不允许则记 partial），不抬调用分级赌运气；
3. 把决策记录的完整消费链（类型、读默认、抽屉、合约、UI、decision-chain 测试）按 2026-11-09 约定逐文件写进方案；
4. 补生成复用 `ProductionMemoryEpisodes` 的封装（预算槽、失败回调、停止信号），payload ref 全进 trace；
5. 端口方法三处接线写全，集成测试补：并发竞态、disclosure-denied、durable 模式、DB→渲染全程字节相同。
