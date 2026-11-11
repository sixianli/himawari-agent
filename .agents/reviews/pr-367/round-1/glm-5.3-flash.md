# PR 367 复核结论

## 发现的问题（按严重度从高到低）

**1.（中）`packages/application/src/services/proactive-mail-check-service.ts:1316-1333` + `apps/agent-service/src/production-proactive-summaries.ts:42-55`：补生成的“四分之一时间上限”管不住进行中的模型调用。**
证据（读代码证实）：`#summaries` 里 `const catchUpSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.floor(this.#options.limits.perCheckMs / 4))])` 只传给了 `source.catchUp`；而 `generate` 回调里是 `await this.#invoke(prompt, dataClassification, deadlineAt, signal, trace)`——用的是**外层** signal，不是 catchUpSignal。`catchUp` 循环里 `if (signal.aborted)` 只在两段之间检查。所以超时后正在跑的那次补生成模型调用会继续跑满 perCheckMs；对比同文件 `#related`（第 798-801 行）把组合 signal 直接传下去、能中断在途调用，做法不一致。一次慢的补生成调用可以吃掉整个检查窗口，把判断调用挤过 `deadlineAt`。
建议：generate 回调改用 catchUpSignal（或在 `#invoke` 处用 `AbortSignal.any([signal, catchUpSignal])`）。
作者说法“补生成单独用检查时间的四分之一”**只在段间成立，不是硬上限**，与代码不符。

**2.（低）`docs/adr/0216-gmail-check-reads-recent-day-summaries.md:54`：ADR 断言“同一天内的多次检查，摘要块的字节相同”不成立。**
证据（读代码证实）：两次检查之间，聊天 run 或上一次检查的补生成都可能新增 `day_summary` 行，`recent()` 的结果随之变化，字节就变。作者材料里的说法（“同一次检查各批字节相同”）是准确的，ADR 把范围扩大到了“同一天内多次检查”，过度声明。缓存论证只需要批间一致即成立，建议删掉后半句。

**3.（低）`docs/execution/specs/2026-11-09-decision-record-write-convention.md:37-44`：约定文档没有收录六个新字段。**
证据（读代码证实）：该文档开头写“新增写入决策记录的代码，必须照下面写”，字段表列出抽屉会读的 `proactive` 字段；本次新增的 `summaryInjected/summaryIds/summaryDays/summaryCharacters/summaryRead/summaryGenerated` 抽屉确实会读（`decision-chain-drawer.tsx:203-209`、`production-decision-chain.ts:124-129`），但表里没有它们。约定第 5 条（读取端测试）已满足，文档本身漏更。
建议：把六项补进“必须写的字段”表。

**4.（低）测试覆盖缺口：真实接线与嵌入记账路径没有集成覆盖。**
证据（读代码证实）：`test/integration/proactive-mail-check.test.ts` 的 harness 传入 `embedForMailCheck: (_context, operation) => operation()`（直接透传），所以 `apps/agent-service/src/service-main.ts:1630-1646` 的生产接线、`production-run-memory.ts:197-215` 里 `mail.costMicros += actualCostMicros` 的嵌入费用记账、以及 `#summaries` 里 `budget.costMicros += Math.max(0, caught.costMicros)` 的汇总额，都没有任何测试走到。静态 scope 测试只查文件名单。
建议：至少补一条用真实 `mailScope` 透传路径的单测，验证嵌入费用计入检查成本。

**5.（低，信息）`packages/memory-engine/src/episodes.ts:211`：候选窗口取 `Math.min(100, input.limit * 2)`（=16 段），占位/读不到的段落消耗名额后不回补。**
证据（读代码证实）：循环里 `UNSUMMARIZED` 与读取失败的段落 `continue` 掉，但候选只取了 16 条；若 16 条里占位多，明明库里还有合格摘要也不会再取，最终带进提示的段数可能少于 `perCheck`（8），且不标 `partial`。影响很小，但与“最多 8 段”的意图有偏差。

**6.（信息）`proactive-mail-check-service.ts:1223`（`#judge` 的 `beforeInvoke` 在 `model.prepare` 之后才执行）：`model.prepare` 抛错且无后续批次时，摘要已选入 prompt 但 `summaryIds=[]`、`summaryInjected=false`。**
语义上“是否真的发给了模型”自洽，与写入校验 `(summaryInjected ?? false) === summaryIds.length > 0`（注意 JS 优先级，`>` 先于 `===`，解析为 `summaryInjected === (len > 0)`，正确）也不矛盾。无需修改，仅记录。

## 作者说法核对（逐条，读代码证实，除注明外均成立）

- candidates 为空或花费到上限就不读不补（`proactive-mail-check-service.ts:804-808`）——成立。
- 补生成用判断模型、按天上限核对估算（`#invoke` 用 `this.#options.model`；generate 里比对 `dailyCostMicros`）——成立。“四分之一时间”**不完全成立**（见问题 1）。暂停时不补（`capturePaused`）、只补允许分级、失败记 partial 不挡判断——均成立。
- 读出只取模型可见且允许的分级（`modelVisibleClassifications().filter(...)` + SQL `IN`）、跳过占位文字（`text === UNSUMMARIZED`）、从新到旧整段挑、超 4000 字丢最旧整段、reverse 后早→晚、同一次检查各批字节相同（同一数组复用，且有测试断言）——成立。
- 时区用 `runPolicy.timeZone`（`service-main.ts:1409-1411` 创建的同一个 `memoryEpisodes` 实例传给 `createProactiveRecentSummaries`，`recentDays` 用同一 `timeZone`）——成立。
- 决策记录六项、写入校验、没接读取器一项不写（`recentSummaries === undefined ? {} : ...`）、旧记录补默认值（`entryFromRow` 的 `??` 默认）——成立。
- 静态 scope 测试存在且名单与实际一致——成立。
- **说法偏差**：材料称 `[P3-6]` 组“13 条”，实际该组是 **12** 条 `it`（我从 diff 逐条数过）。

## 必答问题

1. **不会改变模型已见过的请求开头。**摘要只进 `proactivePrompt`（Gmail 判断这一条后台单发请求）的数据段，位置在固定说明 `mail.judgment` 之后、每批记忆/邮件之前，“现在是…”仍在最后（`proactive-mail-check-service.ts:429-456`，golden 文件逐字节锁定）。聊天路径的系统提示、工具、历史、遮盖结果零改动；scope 静态测试封住接线。每轮会变的值（摘要、记忆、邮件、时间）都在最后一条也是唯一一条用户消息里，固定头不变，符合 prompt-prefix 第 15 条。
2. **不会。**JSON 键序固定（`{day, text}`）、段序由 SQL `ORDER BY day DESC, ended_at DESC, id ASC` 固定、`trim()` 确定、同一次检查只读一次各批复用（有字节相同测试）；摘要不经过任何依赖后文的遮盖分支，整条提示作为一条消息按确定性规则遮盖。
3. **有，反向用例设计有效。**[P3-6] 组含 5 条 REVERSE（旧日/压缩/受限/占位不带块、敏感越权、暂停不补、写入校验拒绝 8 组坏值、无新邮件不调用）；我逐条对照实现推理过回归时会失败（例如 store 校验的 `ids` 去重、日期正则、`summaryRead` 未知值、partial 注入矛盾都会 reject）。我未运行测试（工具受限），运行结果未核实。
4. **两端都能接受。**`listDaySummaries`：port → durable adapter → SQLite 校验（DAY 正则、CLASSIFICATIONS、limit≤100、fromDay≤toDay）→ 复用现有 `memory_episodes_scope_index(owner_id, agent_id, day)`，无迁移。六项决策输入：service 写入 → `validateInputs/summaryInputsValid` → `entryFromRow` 默认值 → `readDecisionChain` → `contracts-v2` schema → 抽屉 i18n（三语言 + message-ids），全链核对一致。提示词 id `mail.judgment.recent-summaries-header` 已登记 manifest（ADR 0216）。遗留问题只有上面第 2、3 条文档不一致。

## 侧重检查

走的流程：新邮件到达 → `ProactiveMailCheckService.run` → fetch/去重 → `#related` → `#summaries`（catchUp → recent）→ `proactivePrompt` → `#judge` → store.record（校验）→ decision_ledger → `readDecisionChain` → 契约 → 抽屉渲染。
结论：主链路各环节都有测试；**没有覆盖**的路径是——service-main 生产接线与守卫、真实 `embedForMailCheck` 的 mail 分支费用记账（问题 4）、补生成超时不中断在途调用（问题 1）、`recent()` 候选窗口不足回补（问题 5）、`dueSegments` 多于 3 段时选哪 3 段（由 `listUnsummarized` 按 `last_committed_at` 升序决定，确定但无测试断言其语义）。文档侧：ADR 0216 与代码一致除问题 2；约定文档漏新字段（问题 3）；作者材料“13 条”实为 12。
