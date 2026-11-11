# PR 382 第 3 轮复核（1048fab2..86e71a91，并核对整体改动）

## 一、读代码证实的问题（按严重度从高到低）

### 1.【中】把 `recent()` 的 `partial` 一律当成“摘要正文读不到”，日志错误码会误报
- 位置：`apps/agent-service/src/production-mcp-read.ts:357`；`packages/memory-engine/src/episodes.ts:229-238`
- 问题：`onSummariesFailed(new Error("MCP_READ_SUMMARY_TEXT_UNREADABLE"))` 对 `found.partial` 无条件触发。但 `MemoryEpisodeService.recent` 的 `partial` 有两个来源，第二个不是“正文读不到”：
  ```ts
  // episodes.ts:229-231
  if (text === undefined || text.trim().length === 0) { partial = true; continue; }
  // episodes.ts:237-238
  if (episodes.length >= Math.min(100, input.limit * 4) && summaries.length < input.limit)
    partial = true;
  ```
  第二处是“SQL 列表被上限（`limit*4`=32）截断”。极端但可达的例子：两天内有 32 条 `UNSUMMARIZED`（纯敏感、可正常读取的占位）日摘要，`summaries.length` 为 0，`partial` 为 true，但没有任何正文读不到。此时日志写 `MCP_READ_SUMMARY_TEXT_UNREADABLE`。
- 与说法不一致：作者 r2-1 说“只有部分摘要正文读不到时（`recent()` 返回 `partial`）”，ADR 0219 决定 7 也写“只有部分摘要正文读不到时也写这条”。代码与这句话不符。
- 建议：让 `recent()` 返回 `partialReason`（`unreadable` / `truncated`），或对“截断”单独返回标志；`production-mcp-read` 只在 `unreadable` 时记 `MCP_READ_SUMMARY_TEXT_UNREADABLE`，截断可记中性错误码（如 `MCP_READ_SUMMARIES_INCOMPLETE`），并同步 ADR。若不想改 `recent`，至少把错误码改成不声称“正文不可读”的中性名字，并修 ADR/作者说明。

### 2.【低】r2-5“遮法只取决于自己和前面的内容”的方向与实现不符：后面的摘要会影响前面的提醒
- 位置：`apps/agent-service/src/production-mcp-read.ts:128-137`；`packages/sensitive-capture/src/redaction.ts:552-568`、`411-425`
- 证据：
  ```ts
  // redaction.ts:552-568
  const tags = new Map<string, string>();
  const options: EgressRedactionOptions = { known: new Map<string, string>(), ... };
  for (const input of inputs) redactForEgress(input, options);      // 第一遍：把每个输入的“点名值”写进同一个 known
  return inputs.map((input) => redactForEgress(input, options).text...); // 第二遍：用已含全部输入点名值的 known
  ```
  ```ts
  // redaction.ts:411-425
  if (known !== undefined && known.size > 0) {
    for (const [value, placeholder] of known) { ... text = text.replace(pattern, ...); }
  }
  ```
  输出顺序是 `reminders` 在前、`recentDays` 在后（`production-mcp-read.ts:378-391`），但第一次遍历会把**后面摘要**里识别出的密码/验证码值放进共享 `known`，第二次遍历时**前面的提醒**文本也会被这些值命中。即“后面影响前面”，与 r2-5 的“只取决于自己和前面的内容”表述相反（“前面影响后面”成立，“后面影响前面”也成立）。
- 影响：仅限对外 MCP 工具结果，不进入 Himawari 自己的模型请求，也不改写已存历史；所以不违反 prompt-prefix 的只追加要求。但若把“同一段文字在不同请求里字节稳定”作为硬指标，这条要记入风险。
- 建议：若要保持“只用自己和前面内容遮盖”，`maskSensitiveTexts` 应逐条累积 `known` 并在第二次遍历时只使用“该条之前”的 known（或按输入顺序一次遍历产出），而不是先全局收集。至少修正 r2-5 的结论表述。

### 3.【低】摘要已成功读出、但出口遮盖/序列化抛错时，决策记录会写 `summaryRead: "failed"`
- 位置：`apps/agent-service/src/production-mcp-read.ts:260-273`
- 证据：
  ```ts
  try {
    const outcome = await run(args, signal, trace);
    delivered = { text: JSON.stringify(maskForExternalRead(outcome.output)), ... };
  } catch (error) { this.#options.onFailure(error); }
  const summaries = ... ? (delivered?.summaries ?? (trace.summariesTried ? SUMMARIES_FAILED : SUMMARIES_NOT_TRIED)) : undefined;
  ```
  `#recentDays` 已成功返回 `read: "ok"` 后，若 `maskForExternalRead`/`JSON.stringify` 抛错，`delivered` 仍是 `undefined`，于是记录成 `summaryRead: "failed"`，与实际“读取成功、交付失败”不符。另：`production-mcp-read.ts:357` 的 `onSummariesFailed` 在 `try` 内部，若该回调自身抛错，会被同一 `catch` 捕获并再次调用 `onSummariesFailed`（第二次若再抛则整个 `today_context` 失败）。
- 建议：区分“摘要读取状态”和“交付/遮盖状态”；用局部变量保存 `recent.read`，遮盖失败时不要把它改成 `failed`。把诊断回调放在 `try` 外，或确保其异常不影响主流程。

### 4.【低】自动检查缺口：截断型 `partial`、service-main 的日志事件、restricted 分级排除都没有用例
- 位置：`test/integration/mcp-read.test.ts:437-459`（只覆盖正文丢失）、`461-475`（无摘要源）、`477-491`（提醒先失败）
- 问题：
  - 没有覆盖 `episodes.ts:237-238` 的“列表截断导致 partial”路径，因此上面第 1 条误报不会被测试发现。
  - 集成测试只断言测试自己注入的 `onSummariesFailed`（`mcp-read.test.ts:277`），没有验证 `service-main.ts:1816-1821` 实际写出的 `event: "mcp-read.summaries-failed"` 与 `code`。
  - 没有反向用例验证 `restricted` 日摘要会被 `modelVisibleClassifications()` 排除（现有测试只 seed 了 `private`）。
- 建议：补“只有 `UNSUMMARIZED`/截断、无正文缺失”时不应误报 `MCP_READ_SUMMARY_TEXT_UNREADABLE` 的用例；补 service-main 诊断输出用例；补 restricted 摘要不出现在 `recentDays` 且不进入 ledger six 项的用例。

## 二、推测（未直接证实为线上可触发）

### 5.【低/推测】存储里的 `day`/`id` 不合新校验时，整个 `today_context` 会被拖失败
- `ProductionMcpRead.#record` 把 `found.summaries` 的 `episode.id`/`episode.day` 原样写入 ledger（`production-mcp-read.ts:305-314`），而 `insertLedgerRow` 现在强制 `summaryDays` 为 `YYYY-MM-DD` 且 `summaryIds` 长度 1..256（`sqlite-decision-summary-inputs.ts:18-37`、`sqlite-decision-ledger-operations.ts:119-124`）。若存储里出现异常 `day`/超长 `id`，ledger 写入抛错，`#call` 会把整个 `today_context` 结果置为失败（`production-mcp-read.ts:274-282`），与“摘要问题不挡提醒”的意图相悖。
- 不过 `upsertEpisode` 在写入时校验了 `document.day`（`sqlite-memory-operations.ts:1292-1297`），所以正常路径不会触发，只有绕过校验/数据库损坏时才可能。可改为先过滤校验失败的摘要，仅降低摘要完整性，不阻止日期和提醒返回。

## 三、侧重检查

- 错误路径：摘要读取整体抛错 → 已捕获，提醒照常返回并标 `recentDaysComplete:false`（`production-mcp-read.ts:368-371`）；提醒先失败 → `off`（`270-273`），与 ADR 一致。partial 的误报见第 1 条；遮盖失败误记见第 3 条。
- 不合规范/不可信输入：`today_context` 入参 schema 为空且 `additionalProperties:false`（`production-mcp-read.ts:232`），`summaries` 的 `days/limit` 是常量（`37-38`），外部输入不会进入摘要查询。ledger 六项来自内部存储，两端（`validateLedgerWrite:73-77` / `insertLedgerRow:120-124` / `summaryInputsValid`）校验一致。
- 安全/隐私：只取 `modelVisibleClassifications()`（`model-visibility.ts:10-26`；`service-main.ts:1795`），摘要正文随整个输出经 `maskForExternalRead`（`production-mcp-read.ts:263`）；ledger 只存 id/日期/字数/状态，不存正文。未发现越权面扩大。
- 资源耗尽：每次 `today_context` 最多 `limit*4=32` 条摘要读取（`episodes.ts:221`）；未向 `recent` 传 `AbortSignal`，若 payload 读取卡住会占用请求，但授权调用有 30 次/分限制（`bearer-admission.ts:4,32`）。风险低。
- 不可撤销/破坏性操作：本改动只读和 append ledger，无删除/覆盖。
- 规则/文档/代码一致：ADR 0219 决定 7、ADR 0216 决定 6、写入约定与代码基本一致；不一致处是第 1 条的“partial 仅代表正文读不到”。`mcp.today-context` 已登记进 manifest 并更新 sha（`prompt-manifest.json:342-344`），但我无法运行哈希校验。

## 四、必答问题

1. **会不会改变 Himawari 已见过的请求开头？**
   不会。唯一改动到的提示词文字是 `packages/prompt-catalog/src/tools.ts:234-241` 的 `mcp.today-context`，其 `usedBy` 只有 `apps/agent-service/src/production-mcp-read.ts`（`tools.ts:237`），在 `production-mcp-read.ts:231` 作为**对外 MCP 工具描述**注册；它不进入 Himawari 自己的系统提示/工具定义/历史。新增的 `recentDays`/`recentDaysComplete` 只在 `#todayContext` 的工具输出里（`production-mcp-read.ts:378-394`），返回给外部客户端，不写入 Himawari 的历史。每轮变化的值（`now`、摘要内容、ledger 的 `decidedAt`）都在工具结果/记录里，不在请求头。发给 Himawari 的内容仍然只在末尾追加。需要说明的附带影响：外部客户端自己的模型会看到改过的工具说明，这是外部会话的请求头变化，不属于本约束。

2. **同一段文字会不会在不同请求里变成不同的字节？**
   对 Himawari 自己的请求：不会。`recentDays` 的取数和顺序是确定的（`sqlite-memory-operations.ts:1532-1536`：`ORDER BY e.day DESC, e.ended_at DESC, e.id ASC`），`{day,text}` 键序固定，且只出现在对外结果里。对对外 MCP 结果：摘要正文本身从存储读出后字节稳定，但出口遮盖不是逐字符串独立的——`maskSensitiveTexts` 两遍共享 `known`（`redaction.ts:552-568`），后出现的摘要里被“点名”的密码/验证码会让前面的提醒也被遮（`411-425`），反之摘要也会受前面提醒影响。这是外部结果层的变化，不影响 Himawari 的 prompt 前缀；若对“同一段文字跨请求逐字节稳定”有硬要求，需要按第 2 条修正遮盖实现。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有，且主要反向用例是真的会失败：
   - partial 日志：`mcp-read.test.ts:448-451` 断言 `MCP_READ_SUMMARY_TEXT_UNREADABLE` 且 `onFailure` 不被调用；删掉 `production-mcp-read.ts:357` 会失败。
   - 无摘要源：`mcp-read.test.ts:467-474` 断言没有 `recentDays`/`recentDaysComplete` 且原始 `inputFields` 无 summary 键；`mcp-read.test.ts:247-267` 的 `withoutSummaries` 反向成立。
   - 直接写库的部分六项：`decision-ledger-summary-inputs.unit.test.ts:61-81` 覆盖 consolidation 只带两项、external_read 只带一项；回退到只看 `summaryRead` 会失败。
   - `ledger.append` 的非法组合：`decision-ledger.test.ts` 新增用例覆盖缺状态、有注入无 id、坏日期、坏状态、非 external 种类。
   缺口：截断型 partial（第 1 条）、service-main 日志事件、restricted 分级排除没有反向用例（第 4 条）。作者声称的 `npm run check` 48 步、persistence-sqlite 全量测试，我无法运行，**未核实**。

4. **每个产生/修改的值，使用它的地方都能接受吗？**
   - 六项摘要字段（`production-mcp-read.ts:305-314`）→ `validateLedgerWrite`（`sqlite-decision-ledger-operations.ts:73-77`）/`insertLedgerRow`（`119-124`）/读模型（`257-262`）：`summaryIds` 来自去重后的 episode 行（≤8、唯一）、`summaryDays` 经 `Set` 去重且为 ISO 日期、`summaryCharacters` 非负安全整数、`summaryRead` 为枚举、`summaryInjected` 与 `ids.length>0` 一致、`summaryGenerated=0`、`kind=external_read`，全部能过校验。**已核对。**
   - Gmail 检查路径（`proactive-mail-check-service.ts:1585-1594`：`Set` + `sort`）→ `sqlite-proactive-operations.ts:682` 的共享 `summaryInputsValid`：唯一、日期格式、排序均满足。**已核对。**
   - `MCP_READ_SUMMARY_TEXT_UNREADABLE` → `stableErrorCode`（`service-runtime.ts:55-57` 接受全大写下划线）→ 日志 `code` 能原样输出。**已核对。**
   - 新增必填 `onSummariesFailed`：两处构造点都提供了（`service-main.ts:1816`、`production-http-composition.unit.test.ts:892`），grep 未发现遗漏。**已核对。**
   - `mcp.today-context` 的 manifest 条目已改 sha 和 reason（`prompt-manifest.json:342-344`），但哈希值我无法重算，**未核实**。
   - external_read 的六项不会出现在「依据」抽屉/`mails.summaries`：`production-decision-chain.ts:97` 只在 `kind === "proactive"` 时构造 `mails`（`156-170`），新用例 `decision-chain.test.ts` 断言 `chain.mails === null`。**已核对。**
   - 潜在边界：存储中异常的 `day`/`id` 会让 `insertLedgerRow` 抛错并拖垮整个 `today_context`（第 5 条，推测）。
