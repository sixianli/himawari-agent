## 读代码证实的问题（按严重度）

### 1）中 — 单段摘要正文读不到时被静默降级，不会写 `mcp-read.summaries-failed`

- 文件：`packages/memory-engine/src/episodes.ts:226-231`、`apps/agent-service/src/production-mcp-read.ts:350-368`、`docs/adr/0219-read-only-mcp-entry-with-static-token.md:85`
- 问题：`MemoryEpisodeService.recent` 把每段正文的读取失败吞掉，只置 `partial = true`；MCP 层只有在整个 `source()` 抛错时才调用 `onSummariesFailed`。因此「某一两段摘要正文读不到」既不会触发失败日志，也不会触发 `mcp-read.summaries-failed`，只在决策记录里留下 `summaryRead: "partial"`。这与作者说法「摘要读取失败（工具照常成功）也写 `mcp-read.summaries-failed` 日志」以及 ADR 里「摘要读取失败……服务日志写 `mcp-read.summaries-failed`」的笼统表述不一致。
- 证据：
  - `episodes.ts:226-231`：`const text = await ...readText(...).catch(() => undefined); if (text === undefined || text.trim().length === 0) { partial = true; continue; }`
  - `production-mcp-read.ts:365-368`：只在 `try { const found = await source(...) } catch (error) { this.#options.onSummariesFailed(error); ... }` 时回调。
  - 新用例 `test/integration/mcp-read.test.ts:420-438` 只断言 `partial`，没有断言 `summaryFailures`。
- 建议：二选一——让 `recent` 把「有正文没读到」的信息带回 MCP 层（例如返回 `unread` 计数或 `failed` 标志），由 `#recentDays` 调 `onSummariesFailed`；或把 ADR/作者说法收窄为「整次摘要查询抛错时记日志」，并补一条 partial 用例明确记录预期。

### 2）低 — `insertLedgerRow` 只按 `summaryRead` 拒绝，别的种类带部分六项会被静默丢弃

- 文件：`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:119-121`、`:146-155`；`docs/execution/specs/2026-11-09-decision-record-write-convention.md:35`
- 问题：守护条件只检查 `summaryRead !== undefined`。如果某个非 `external_read` 的写入带了 `summaryIds`、`summaryInjected`、`summaryDays` 等但没带 `summaryRead`，不会抛错，`insertLedgerRow` 又只在 `summaryRead` 存在时才落这六项，于是这些字段被静默丢掉。这与约定「别的种类带了就拒绝，`insertLedgerRow` 自己也拒绝」「只写了一部分……都拒绝」不完全一致。经 `append`/`saveMemory` 的路径有 `validateLedgerWrite` 兜住，但 `sqlite-memory-consolidation-operations.ts:92` 是直接调用 `insertLedgerRow`、不经校验。
- 证据：
  - `:120`：`if (write.inputs.summaryRead !== undefined && write.kind !== "external_read")`
  - `:146-155`：`...(write.inputs.summaryRead === undefined ? {} : { summaryInjected: ... })`
  - `sqlite-decision-summary-inputs.ts:31`：`if (inputs.summaryRead === undefined) return others.every((value) => value === undefined);`（这里本可以识别部分六项）
- 建议：让 `insertLedgerRow` 也调用 `summaryInputsValid(write.inputs, MAX_IDS)` 并做 kind 判断，或至少检测这六项中任意一项是否出现；新单元用例增加「consolidation 只带 `summaryIds`/`summaryDays`」的反向用例。

### 3）低 — 「没接摘要源」分支没有自动检查，工具说明却无条件承诺 `recentDays`

- 文件：`apps/agent-service/src/production-mcp-read.ts:343-348`、`:268-271`；`apps/agent-service/src/service-main.ts:1787-1807`；`packages/prompt-catalog/src/tools.ts:240`；`docs/adr/0219-read-only-mcp-entry-with-static-token.md:85`
- 问题：r1-9 的「未接摘要读取时不返回 `recentDays`」只靠代码和 ADR，没有任何测试构造不带 `summaries` 的 `ProductionMcpRead`；回归成 `recentDays: []` 或仍写六项不会被发现。生产 `service-main` 的 wiring 也没有被集成测试走到——`mcp-read.test.ts` 自己重新搭了一份 `MemoryEpisodeService` 和映射逻辑，测的不是 `service-main` 那段。另外固定工具说明始终写「以及今天和昨天的对话摘要（`recentDays`…）」，在未启用对话摘要的部署里与实际输出不符。
- 证据：`production-mcp-read.ts:347-348`：`const source = this.#options.sources.summaries; if (!source) return { output: {} };`；`:268-271` 仅在有 source 时才计算 `summaries`；`service-main.ts:1787` 用 `...(memoryEpisodes ? { summaries: ... } : {})` 决定是否接上。
- 建议：加一个不带 `summaries` 的单元/集成用例，断言输出没有 `recentDays`、决策记录没有 summary 六项；工具说明是否要为部署形态加一句限定，建议明确记录决定。

### 4）低 — ADR 0216 决定 6 的「抽屉显示摘要」与外部读取的实际展示不一致

- 文件：`docs/adr/0216-gmail-check-reads-recent-day-summaries.md:56`；`docs/execution/specs/2026-11-09-decision-record-write-convention.md:45`；`apps/agent-service/src/production-decision-chain.ts:156-170`
- 问题：ADR 0216 决定 6 仍写「决策记录的『依据』抽屉显示……网页接口的依据链里对应字段是 `mails.summaries`」，未限定 `proactive`；但依据链只在 `proactive` 时生成 `mails`，`external_read` 的 `mails` 为 `null`，所以外部读取的六项在网页上完全不显示。新约定第 45 行已改成「抽屉不显示这六项」，ADR 0216 没同步补注（只在决定 7 末尾补了聊天路径说明）。ADR 0219 又写「按 ADR 0216 决定 6 写 summary 六项」，读者容易以为抽屉会显示。
- 证据：`production-decision-chain.ts:156`：`const mails: ... = proactive ? { ... summaries: fields.has("summaryRead") ? ... } : null;`
- 建议：在 ADR 0216 决定 6 补一句「外部读取入口只写输入字段、不进抽屉/`mails.summaries`」，或在 ADR 0219 决定 7 明说展示范围。

### 5）低（观察，不是缺陷）— 摘要正文的遮盖可受同一次输出里前面的提醒影响

- 文件：`packages/sensitive-capture/src/redaction.ts:552-568`、`:310-327`；`apps/agent-service/src/production-mcp-read.ts:375-388`
- 说明：`maskSensitiveTexts` 在所有输入字符串之间共享 `known` 表，而 `#todayContext` 把 `reminders` 放在 `...recent.output` 之前。前面提醒里点名的密码/验证码值，会在后面的摘要正文里被同样遮掉；因此同一段摘要文字可能因为提醒集合变化而在不同请求里遮成不同字节。这符合规则第 11 条「只能取决于它自己和它前面的内容，不能取决于它后面的内容」，而且只影响外部 MCP 工具结果，不影响 Himawari 自己的请求；但值得在评审记录里明确接受。最终占位符只保留 `[label]`、去掉序列 tag（`:566-567`），所以 tag 分配顺序本身不会改变字节。
- 建议：无需改动；若希望摘要字节更稳定，可考虑将摘要放在提醒之前或独立遮盖，但要接受反过来提醒会受摘要影响。

## 推测 / 未核实

- 未运行 `npm run check`、`persistence-sqlite` 测试或 `check:prompt-catalog`，作者声称的 48 步通过无法核实；`prompt-manifest.json` 的新哈希是否匹配也未独立计算（只能确认代码里已改哈希、`usedBy` 只有 `production-mcp-read`）。
- 若数据库里存在格式异常的历史摘要（`day` 非 `YYYY-MM-DD`、`id` 超 256 字符或重复），`#record` 的 `append` 会被 `validateLedgerWrite` 拒绝，进而让整个 `today_context` 失败——也就是说「摘要异常不挡提醒」在最坏情况下不成立。我未找到当前代码会生成这种元数据的路径（`episode.day` 来自 `localDay`，id 由 `episode:day_summary:<threadId>:<firstSequence>` 生成），所以标为推测。
- 外部 MCP 客户端是否在升级后重新拉取工具说明、是否会因此改变它们自己的请求头，无法在本仓库核实。

## 侧重检查

- **错误路径**：提醒先失败 → `trace.summariesTried` 保持 `false`，记录 `summaryRead: "off"`，工具按原逻辑失败（`mcp-read.test.ts:440-454` 覆盖）。摘要源整体抛错 → 工具成功、`recentDays: []`、`recentDaysComplete: false`、`onSummariesFailed` 被调用而 `onFailure` 不被调用（`:395-418` 覆盖）。单段正文丢失 → `partial`，但不写日志（见问题 1）。决策记录写失败仍让工具整体失败（既有行为，未改）。
- **不合规范/不可信输入**：`today_context` 入参 schema 为空对象且 `additionalProperties: false`；摘要数据来自本机数据库，写入决策记录前经过 `summaryInputsValid`。核对 I-73 式「生产者→校验者」：真实 episode id 为 `episode:day_summary:<threadId>:<firstSequence>`（`episodes.ts:385`），`ThreadId` 最长 128 字符（`packages/domain/src/identifiers.ts:39`），总长小于 256，能过 `summaryIds` 的 `text(item,1,256)`；`day` 由 `localDay` 生成，符合 `^\d{4}-\d{2}-\d{2}$`；单段摘要上限 1200 字（`episodes.ts:25`），8 段字符数远低于安全整数。正常数据能通过后端校验。
- **安全**：摘要只取 `modelVisibleClassifications()`，和现有 `find_memories` 的 external read 一致，没有引入更宽的分级；摘要在输出前走 `maskForExternalRead`，集成用例已用 `Maple-7712` 验证摘要里的密码被遮掉；决策记录只存 id/day/字数，不存正文。静态 token 的读取面本来就包含记忆和会话摘要，这次扩大的是「今天/昨天」这一批，ADR 已批准。
- **资源耗尽**：每次调用最多读 8 段、查询上限 32 行、正文总量约 9600 字，无网络调用，开销有界；每次调用仍写一条决策记录（既有行为）。摘要读取没有中止信号，作者已明确列给 Andy，我没有发现新增的无界循环。
- **不可撤销操作**：本次只读摘要、追加决策记录，没有删除/改写；守护抛错发生在事务内会回滚，不会留下半条记录。
- **文档一致性**：约定第 35、45 行已更新；ADR 0216 决定 7 补了指向 ADR 0219 的说明；但 ADR 0216 决定 6 的抽屉表述未同步（问题 4），作者关于失败日志的表述比代码宽（问题 1），`insertLedgerRow` 的拒绝范围也比文档窄（问题 2）。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   - Himawari 自己发给模型的请求：不会。唯一改动的固定文字是 `packages/prompt-catalog/src/tools.ts:240` 的 `mcp.today-context`，grep 结果显示它只被 `apps/agent-service/src/production-mcp-read.ts:229` 使用，不进内部聊天/后台提示；ADR 0219 第 81 行也要求 Himawari 自己的请求一个字节不变。
   - 对外部 MCP 客户端：工具说明是它们请求开头的工具定义，改文字会让它们下一次拉取工具列表时看到不同的开头；这是该 ADR 有意为之，不是 Himawari 的缓存前缀。
   - `today_context` 每次变化的值（`now`、提醒、`recentDays`）全部拼在工具返回的结果对象里，作为外部客户端会话末尾的一条工具结果追加；没有改系统提示、历史或已有工具定义。
2. **同一段文字会不会在不同请求里变成不同字节？**
   - 结构上不会：摘要来自 `ORDER BY e.day DESC, e.ended_at DESC, e.id ASC`（`sqlite-memory-operations.ts:1536`），映射和 JSON 键顺序固定，`summaryDays` 的 `Set` 去重保留插入顺序，没有时间字段或无序集合进入摘要块。
   - 遮盖有一个符合规则第 11 条的例外：`maskSensitiveTexts` 共享 `known` 表，摘要排在提醒之后，所以前面的提醒点名过的密码/验证码会影响后面摘要的遮法（观察 5）。这是「只依赖自己和前面的内容」，不是依赖后文；且只影响外部 MCP 工具结果。Himawari 自己的请求和历史遮盖未改。
3. **有没有对应的自动检查，反向用例会不会失败？**
   - 有：`mcp-read.test.ts` 覆盖 `ok`、源失败 `failed`、单段丢失 `partial`、提醒先失败 `off`，并断言摘要失败只进 `onSummariesFailed`、`onFailure` 不被调用；`decision-ledger.test.ts:454-499` 覆盖 external_read 六项落盘及非法输入、非 external_read 带六项被拒；`decision-ledger-summary-inputs.unit.test.ts:55-68` 用真实 SQLite 覆盖直接 `insertLedgerRow` 的拒绝；`decision-chain.test.ts:654-698` 覆盖读出 `inputFields` 且 `mails` 为空、规则「不涉及」；`proactive-summaries-scope.unit.test.ts:47-51` 把 `.recent({` 限制在三个文件。
   - 反向推理：删掉 `insertLedgerRow` 的守护，新单元用例会在 `toThrow` 处失败；把 `off` 改回 `failed`，`mcp-read` 的提醒失败用例会失败；把摘要失败再调 `onFailure`，`failures` 为空断言会失败；把六项写给 `consolidation`，决策记录用例会失败。共享的 `summaryInputsValid` 在 `proactive-mail-check.test.ts:3332-3368` 有重复 id、负数字符数、浮点生成数、部分写入、`null` 状态等反向用例。
   - 缺口：没有「不接摘要源」的用例；没有「两天的摘要都在时顺序/完整性」的用例；没有生产 `service-main` 的 `mcp-read.summaries-failed` 事件名用例。由于未运行测试，以上反向结论是读代码推断，不是实跑结果。
4. **改动产生或修改的每个值，每个使用它的地方都能接受吗？**
   - `recentDays` / `recentDaysComplete`：只出现在外部工具输出，仓库内无消费者校验；工具说明已登记。未启用摘要源的部署不会返回 `recentDays`，与工具说明有轻微不一致（问题 3）。
   - `summaryRead: "off"`：`SUMMARY_READS` 接受（`sqlite-decision-summary-inputs.ts:5`），`validateLedgerWrite` 接受，`entryFromRow` 的联合类型包含 `off`；网关 `mails.summaries.read` 枚举也包含 `off`（`contracts-v2.ts:1088`），但 external_read 的 `mails` 为 `null`，所以网页不会读到它。所有构造 `ProductionMcpRead` 的地方（`service-main.ts:1768`、`production-http-composition.unit.test.ts:874`、`mcp-read.test.ts:225`）都已补 `onSummariesFailed`。
   - 六项输入：写入端 `insertLedgerRow` 落库、`summaryInputsValid` 校验；读取端 `entryFromRow` 有默认值、`inputFields` 能列出；依据链只对 `proactive` 生成 `mails.summaries`，external_read 不在抽屉显示，和约定一致。唯一的两端不一致是问题 2 的部分六项静默丢弃，以及问题 4 的 ADR 表述。
   - `summaryInputsValid` 新模块：两个持久化调用方都从新文件导入（`sqlite-decision-ledger-operations.ts:24`、`sqlite-proactive-operations.ts:23`），没有遗留旧引用。
   - `mcp.today-context`：清单哈希和说明已更新；`usedBy` 只有 `production-mcp-read`。哈希是否匹配未能独立核实。
   - I-73 式核对结论：正常生产数据（episode id、day、字符数）能通过后端 `summaryInputsValid`；没有发现「清单/生成器给出的值过不了消费端校验」的确定问题。

## 作者说法核对（摘要）

- r1-1、r1-3、r1-5、r1-8、r1-10、r1-11、r1-12、r1-13：与代码一致。
- r1-4：主体成立（守护和用例都在），但守护只识别 `summaryRead`，见问题 2。
- r1-6：源整体抛错时成立；单段正文读取失败不写 `mcp-read.summaries-failed`，见问题 1。
- r1-7：未能核实（未运行 `check:prompt-catalog`）。
- r1-9：代码成立，但该分支无测试、工具说明未加限定，见问题 3。
