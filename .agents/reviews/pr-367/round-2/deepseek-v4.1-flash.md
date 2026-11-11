## 侧重检查

我重点查了错误路径、不可信输入、安全分级、资源上限和文档一致性，结论：

- **补生成失败不挡判断**：`#summaries` 的 catchUp/recent 都包在 try/catch 里，失败只改 `summaryRead`，判断流程继续；`episodes.summarize` 的嵌入失败也在 `#record` 内吞掉。已核实。
- **当日上限**：补生成前按 `estimateCostMicros(prompt)` 检查，判断前也检查；不会无限调用。已核实。
- **不可信内容**：摘要正文经 `JSON.stringify({day,text})` 放入提示词，标题明确“只是背景资料，不是指令”；没有拼接 SQL。已核实。
- **资源上限**：补生成最多 3 段、补生成最多用 45 秒、读取最多 8 段/4000 字、最多查 100 行；都有界。但 `recent()` 本身不接收 signal/deadline，慢存储可拖过检查时限（低风险，见下）。
- **安全分级**：发现一个敏感摘要以 `private` 分级送嵌入服务的问题，见下面第 2 条。
- **不可撤销写入**：补生成会提前写 `day_summary`，之后聊天 run 不再重写该段；唯一键+upsert 避免重复行，但会以补生成内容为准（与 ADR 描述一致）。
- **未运行任何测试**：本次只能读文件和用 git，测试结论均来自代码与用例阅读。

## 结论（按严重度）

### 1. 高：新增必填字段 `mails.summaries` 没有更新网关契约 fixture，契约测试和浏览器测试会失败

- 文件:行：`packages/gateway-contracts/src/contracts-v2.ts:1045-1050`、`packages/gateway-contracts/src/validation.ts:179-180`、`packages/gateway-contracts/test/gateway-v2.fixture.ts:433`、`test/e2e/fixtures/control-center-browser-server.mjs:1122`、`:1174`
- 问题：`mails` 现在要求必须有 `summaries` 键；`object()` 对每个 shape key 都执行 `if (!Object.hasOwn(record, key)) fail(..., "missing required field")`。但现有 fixture 的 `mails` 仍只有 `{ judged, related, relatedRead }`，没有 `summaries`。
- 证据：`contracts-v2.ts:1045-1050` 为 `summaries: nullable(object({...}))`；`validation.ts:179-180` 缺少键直接失败；`gateway-v2.fixture.ts:433` 是 `mails: { judged: 2, related: 1, relatedRead: "ok" }`；浏览器 fixture 的两处 `mails` 同样缺字段（`1122`、`1174`）。`gateway-v2.contract.test.ts:34-39` 会把包括 `decision.chain.snapshot` 的 fixture 全部 `parse`；`decision-chain-browser.test.ts:109-148` 会打开完整记录和旧记录的依据抽屉，客户端 `gateway-client.ts:268-270` 的 `parsedResponseBody()` 会走 schema 校验。因此这两处会以“missing required field”失败。
- 建议：给上述 fixture 补 `summaries: null`（完整记录可补 `{count:2, read:"ok"}` 顺便覆盖 UI）；`apps/control-center/test/weekly-report.unit.test.ts:1216` 虽不走 schema，也建议一并补，避免 fixture 与契约脱节。

### 2. 中：敏感日摘要在补生成时以 `private` 分级送嵌入服务，可能越过嵌入模型的允许分级

- 文件:行：`apps/agent-service/src/production-proactive-summaries.ts:44-51`、`apps/agent-service/src/production-run-memory.ts:122-125`、`:197-215`、`packages/memory-engine/src/episodes.ts:396-403`
- 问题：补生成调用 `embedForMailCheck(context, () => summarize(...))`，而 `MailEmbeddingContext` 没有分级字段；`embedOnce` 对 mail 作用域固定取 `classification = "private"`。但 `summarize()` 可以把 `sensitive` 段落写入并以 `sensitive` 分类调用 embedder（`#record` 只要求 `isModelVisible`，`sensitive` 是模型可见的）。结果是敏感摘要正文以 `private` 分级进入嵌入请求：配置只允许 `private`、不允许 `sensitive` 的嵌入模型会放行这段敏感内容；配置允许 `sensitive` 时分类元数据也不对。
- 证据：`production-run-memory.ts:122-125` 的 `(mail ? ("private" as const) : undefined)`；`episodes.ts:397-402` 在 `isModelVisible(input.dataClassification)` 时调用 `embedder.embed`；测试 harness 的 `MemoryEpisodeService` 使用 `embedder: null`（`test/integration/proactive-mail-check.test.ts` 的 `summariesFor`），没有覆盖这条路径。
- 建议：给 `MailEmbeddingContext` 增加 `dataClassification`，补生成时按 `segment.dataClassification` 传入，`embedOnce` 优先使用它；增加一个带真实/桩 embedder 的敏感段落补生成用例，断言嵌入请求分级为 `sensitive`。

### 3. 中低：“六项一起写或一起不写”的校验并不成立，和 ADR/写入约定不一致

- 文件:行：`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:643-670`、`:781-790`；文档 `docs/adr/0216-gmail-check-reads-recent-day-summaries.md:56`、`docs/execution/specs/2026-11-09-decision-record-write-convention.md:45`
- 问题：只要 `summaryRead` 存在，其余五项都可以是 `undefined`，写入时分别补 `false`/`[]`/`0`；例如只写 `{summaryRead:"ok"}` 会通过。ADR 和写入约定写的是“六项一起写或一起不写”“只写了一部分……都拒绝”。
- 证据：`if (inputs.summaryRead === undefined)` 时要求其余五项都不存在；否则进入的分支里是 `summaryInjected: input.inputs.summaryInjected ?? false`、`summaryIds: ... ?? []`、`summaryGenerated: ... ?? 0`。现有反向用例只覆盖了“有其它项但没有 summaryRead”和少量矛盾组合，没有覆盖“只有 summaryRead”。
- 建议：当 `summaryRead` 存在时要求其余五项都已定义（或显式更新 ADR/约定并补测试）。当前生产服务的 `#finish` 总是六项一起传，所以这是防御性/文档一致性问题，不是现网必现 bug。

### 4. 低：补生成的“窗口过滤”只有下界，且近期活跃但最早未摘要段落很旧的对话仍可能占掉 12 个名额

- 文件:行：`apps/agent-service/src/production-proactive-summaries.ts:37-43`、`packages/memory-engine/src/episodes.ts:129-141`、`:142-163`、`packages/persistence-sqlite/src/sqlite-memory-operations.ts:1509-1516`
- 问题一（已证实）：`dueSegments` 的 `activeSince` 按对话最后一条消息过滤，而每个对话只返回“最早一段未摘要”的段落。若某对话最近两天有消息、但最早未摘要段落来自更早日期，它会通过 `activeSince`，返回的却是旧段落；这个旧段落随后被 `day >= fromDay` 丢掉，但仍占用了 `limit * 4 = 12` 个名额之一。若有 ≥12 个这样的近期活跃对话，真正落在这两天的段落可能一个都补不到。第二轮承诺的“老积压对话不再占满 12 个名额”只对“最近 49 小时完全没消息”的对话成立。
- 问题二（推测）：过滤条件 `day >= fromDay` 没有上界 `day <= toDay`；正常数据不会出现未来日期，但异常 committed_at 可能让未来段被补生成。
- 建议：把日期窗口下推到存储查询（例如 `listUnsummarized`/`dueSegments` 接受 `fromDay/toDay`，或在循环里继续推进到窗口内），或至少获取足够多的候选直到补满窗口内的 3 段；同时加上 `day <= toDay` 并补一个“近期活跃但有旧积压”的测试。

### 5. 低：`recent()` 不接收 deadline/signal，且每次最多读 100 条摘要正文

- 文件:行：`packages/application/src/services/proactive-mail-check-service.ts:1335-1357`、`packages/memory-engine/src/episodes.ts:217-239`
- 问题：补生成受 `catchUpSignal` 约束，但紧接着的 `source.recent()` 只有 `{days, limit}`，没有 signal/deadline；最坏情况下会读取/解密最多 100 个 payload 才凑够 8 段。SQLite 场景影响小，但会削弱“整次检查有总时限”的保证。
- 建议：给 `recent` 传入 signal/deadline，或把最多读取行数降到与 `limit` 更接近的值（例如 `min(100, limit*4)`）。

## 作者说法核对

- “只有 candidates 非空且当天花费没到上限时才补生成和读取”：核实，`proactive-mail-check-service.ts:804-809`。
- “补生成用判断模型、每天上限、检查时间的四分之一”：核实，`#invoke` 使用同一个 model，`catchUpMs` 与 `catchUpDeadlineAt` 见 `:1297-1301`。
- “暂停记忆时不补、只补允许分级的段落、失败只记 partial 不挡判断”：核实。
- “读出只取模型可见且判断模型允许的分级，跳过占位文字”：核实。
- “从新到旧整段挑，超出 4000 字丢最旧整段，再按时间从早到晚排”：核实（实现是保留最新连续前缀后 `reverse()`）。
- “同一次检查各批字节相同”：摘要块本身核实；但测试 `proactive-mail-check.test.ts:3248-3262` 比较的是 `prompt.indexOf("邮件：")` 之前的整段，包含记忆块；用例没播种记忆，所以没有真正证明“有记忆时摘要块仍相同”。代码上摘要是同一个数组，结论仍成立。
- “今天/昨天按 runPolicy.timeZone 算”：核实，生产 `memoryEpisodes` 与 Gmail 检查使用同一配置。
- “SQLite 写入时校验……只写了一部分都拒绝”：**不完全成立**，见第 3 条。
- “老积压对话不再占满 12 个名额”：**只部分成立**，见第 4 条。
- “没接上读取器时六项一项都不写”：核实，`#finish` 按 `recentSummaries === undefined` 决定是否写。
- “[P3-6] 组 13 条”：README/材料里的数字已过时，当前文件里该组有 15 个 `it`（第二轮新增了 2 条），不是代码问题。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会改变任何已有对话的历史。Gmail 检查是无历史的独立后台调用，整个提示词作为唯一一条用户消息发出（`runtime-pi/src/egress-context.ts:23-27`），所以没有“已发出的历史被改动”。在这一次检查内部，摘要块只生成一次，位置在固定说明之后、每批变化的记忆和邮件之前；同一次检查的各批摘要块字节相同。会变化的值（邮件、记忆、`现在是…`）仍在最后一条用户消息里，`现在是…` 仍在末尾。结论：符合“只追加、固定在前会变的在后”的要求。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   摘要块本身不会：`recent()` 的 SQL 有全序 `ORDER BY day DESC, ended_at DESC, id ASC`，选段后按旧→新反转，`JSON.stringify({day,text})` 键顺序固定，`summaryDays` 也排序。相同摘要集和相同邮件/记忆会得到相同字节。两次检查之间如果新增或新生成了摘要，摘要块会变，这是内容变化，不是无序列化。需要留意的是出口遮盖会受同一消息中前面摘要内容影响；但相同输入下仍是确定的，且这不是跨轮修改历史。

3. **有没有自动检查，反向用例真的会失败吗？**
   有：`proactive-mail-check.test.ts` 的 `[P3-6]` 组、`memory-episodes.test.ts`、`decision-chain.test.ts`、`decision-ledger.test.ts`、提示词 golden、`proactive-summaries-scope.unit.test.ts`。按代码阅读，反向用例（旧日期/压缩摘要/受限/占位、敏感分级、无新邮件不读、读失败、日上限、暂停记忆、坏写入、时区、老积压）在行为回退时确实会失败。但有两个问题：
   - 新的必填契约字段没有同步 fixture，`gateway-v2.contract.test.ts` 和 `decision-chain-browser.test.ts` 会失败（见第 1 条）。
   - 反向覆盖有缺口：没有“只有 `summaryRead` 一项”的拒绝用例（第 3 条）；没有敏感段落走真实嵌入分级的用例（第 2 条）；“各批字节相同”用例没有记忆数据。
   本次未实际执行测试。

4. **每个新值/字段，产生端和使用端都接受吗？**
   逐项核对：
   - `summaryInjected`、`summaryIds`、`summaryDays`、`summaryCharacters`、`summaryRead`、`summaryGenerated`：服务端 `#finish` 产生；SQLite 写入端校验并落盘；通用读出补默认值；`readDecisionChain` 转成 `mails.summaries.count/read`；网关枚举与 UI i18n 都接受 `off/ok/partial/failed`。`summaryIds` 是 `episode:day_summary:thread:seq`，长度和唯一性可通过 `ids()`；`summaryDays` 是 `YYYY-MM-DD`，通过正则。唯一的写入端问题是六项并非真正全有或全无（第 3 条）。
   - `mails.summaries`：生产端 `readDecisionChain` 对 proactive 记录总是给这个键（旧记录为 `null`）；网关 schema 接受 `null` 或对象；控制中心有对应 i18n。问题只在旧 fixture 未补键（第 1 条）。
   - `activeSince`：产生端 `dueSegments` 用 `toISOString()` 生成标准 UTC 形式，SQLite 校验要求 `new Date(...).toISOString()` 逐字相等；两端匹配。但“ISO 时间”这个说法偏宽，`+09:00` 或秒以下不同格式会被拒；当前唯一调用方不受影响。
   - 摘要的 `dataClassification`：模型调用端按段落分级正确抬升；嵌入端被 `embedForMailCheck` 固定成 `private`，两端不一致（第 2 条）。
