# 代码复核报告（fc44e448..37a537b5，PR 382）

## 发现的问题（按严重度从高到低）

### 1. 中 | docs/execution/specs/2026-11-09-decision-record-write-convention.md:35、45 | 写入约定文档未随代码更新，违反了文档自己定的流程
- 证据（读代码证实）：代码已让 `external_read` 经 `insertLedgerRow` 落 summary 六项（`sqlite-decision-ledger-operations.ts:183-192`），并拒绝其他 kind 带这六项（`sqlite-decision-ledger-operations.ts:112-116`）。但约定第 35 行仍写「其他种类……目前只落 `memoryIds`、`ruleIds`、`batchId`、`resultMemoryIds` 四个键」，第 45 行仍把 summary 六项标为「`proactive`，只在 Gmail 检查接上了对话日摘要读取时写」。而第 35 行末尾自己规定：「要让这些种类也记下别的字段，**先改 `insertLedgerRow` 和它的校验，再改这份约定**」——本 PR 做了前者没做后者。
- 建议：更新约定第 35、45 行，写明 `external_read` 也落这六项、且校验拒绝其他种类带这六项。

### 2. 低 | apps/agent-service/src/production-mcp-read.ts:259-262、289、300 | 提醒先失败时，账本把摘要记成「读取失败」，与事实不符
- 证据（读代码证实）：`#todayContext` 先读提醒（359 行）再读摘要（360 行）；若提醒抛出，`run()` 失败，`delivered` 为 undefined，`summaries` 取 `SUMMARIES_FAILED`（261 行，`read: "failed"`），`#record` 写 `summaryRead: memoryIds ? summaries.read : "failed"`（300 行）——此时摘要源从未被调用过。按 ADR 0216 的语义，「没接上/没进行」应是 `off`，`failed` 表示尝试过且失败。
- 建议：`run()` 失败时写 `summaryRead: "off"`（或区分「未尝试」与「尝试失败」）。
- 备注（推测）：实际影响仅限账本语义准确性，不影响返回给客户端的内容（该次调用已按失败处理）。

### 3. 低 | apps/agent-service/src/production-mcp-read.ts:343-349、335 | 两个分支没有测试覆盖
- 证据（读代码证实）：`#recentDays` 的 partial 分支（部分正文读不到 → `recentDaysComplete: false` 且 `summaryRead: "partial"`，343-349 行）在 `test/integration/mcp-read.test.ts` 里没有用例——新加的测试只有全部成功（episode-yesterday）和全部失败（`failSummaries`）两种。ADR 0219 决定 7 明确声称「有摘要没读到时多一个 `recentDaysComplete: false`」的行为，该行为无测试。另外 `sources.summaries` 缺失时返回 `{ output: {} }`（335 行），`recentDays` 键整个不存在，也无测试；这与新工具描述文字「recentDays，每天一段或几段」给外部客户端的预期不完全一致。
- 建议：补 partial 用例（seed 一段正文读不到的 episode）；并在 ADR 或工具描述中写明摘要源未启用时字段可能整体缺省。

### 4. 低 | test/integration/decision-chain.test.ts | 读取端未按约定第 55 行补测试
- 证据（读代码证实）：写入约定规则 5（spec 第 55 行）要求「改写入方时同时补测试：读取端的 `decision-chain.test.ts` 必须能列出新字段」。本次新字段只补了写入端（decision-ledger.test.ts:453-498）和 mcp-read 的回读，`decision-chain.test.ts` 的 summary 用例（476-529 行）仍只覆盖 proactive。`production-decision-chain.ts:97、156-170` 只对 `kind === "proactive"` 显示 `mails.summaries`，external_read 的六项只会出现在通用 `inputFields` 里。
- 建议：补一条 external_read 记录的 chain 用例，锁定 `inputFields` 含六个 summary 键。

### 5. 信息 | packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:42 | 校验比文档宽
- 证据（读代码证实）：`SUMMARY_READS = ["off","ok","partial","failed"]` 对 external_read 也接受 `off`，而 ADR 0219 决定 7 说 external_read 的 `summaryRead` 只有 `ok`/`partial`/`failed`。目前没有写入方会写 `off`，无害。
- 建议：可接受；若想严格，可为 external_read 单独限定取值。

## 作者说法逐条核对

- 「today_context 返回今天和昨天的日摘要」——属实。`TODAY_CONTEXT_SUMMARY_DAYS = 2`，`recentDays()` 取 toDay 和 toDay−1（episodes.ts:197-204）。
- 「只读已生成的摘要、不补生成」——属实。`recent()` 只调 `listDaySummaries` 和 `readText`，不调用 summarize/generate（episodes.ts:206-240）。
- 「只取模型可见分级」——属实。service-main.ts:1795 用 `modelVisibleClassifications()`（model-visibility.ts:10-14 = public/private/sensitive），`recent()` 内部再过滤一次（episodes.ts:213）。
- 「和其他文字一起遮盖」——属实。`#call` 对整个 output 调 `maskForExternalRead`（production-mcp-read.ts:252），`mapStrings` 递归遍历数组和对象，`recentDays[].text` 会被收集遮盖。
- 「摘要读不到时不挡提醒，标 recentDaysComplete: false」——属实（351-354 行 catch）。
- 「insertLedgerRow 落六项、共用 summaryInputsValid、别的类别拒绝」——属实。我把被删的 proactive 私有实现与新共享函数逐条比对：ids 闭包同形（1..256、去重）、days≤31 且日期正则相同、`summaryRead` 有值时六项必须全在、count 语义等价（旧代码的 `others.some(undefined) → false` 先拦截了 undefined）、maxIds 各自传 `MAX_INPUT_IDS=500` / `MAX_IDS=200` 不变——proactive 路径行为等价，无回归。proactive 记录走自己的 INSERT（kind 'proactive'，sqlite-proactive-operations.ts:730-782），不经 `validateLedgerWrite`，因此「非 external_read 拒绝」不影响 Gmail 检查路径。
- 「Himawari 自己发给模型的请求一个字节都不变」——属实。`MCP_TOOL_TODAY_CONTEXT` 只被 production-mcp-read.ts:220 使用（外部 MCP 服务器的工具描述，不进 Himawari 自己的提示）；service-main.ts 的改动只是给 MCP read server 加数据源；提示词目录有强制 gate（prompt-catalog.unit.test.ts:187 `PROMPT_MANIFEST_STALE` + 370-381 行反向用例）。manifest 里具体 sha256 值本身未核实（我不能运行命令），但该 gate 会在值与文字不一致时报错。
- 「npm run check 48 步、persistence-sqlite 全部测试通过」——未核实（工具受限不能运行命令）。

## 必答问题

1. **不会改变已见请求开头。** 本次改动没有触碰任何发给 Himawari 自己模型的内容：系统提示、工具定义、历史消息、遮盖都不在改动范围内；改的提示词文字只作为对外 MCP 服务器的工具描述发给外部客户端。「只追加/末尾变化值在最后一条消息」的规则本轮不适用——根本没有改动发给模型的请求。
2. **不会产生新的跨请求字节不稳定。** `recentDays` 顺序由 SQL 固定（`ORDER BY day DESC, ended_at DESC, id ASC`，sqlite-memory-operations.ts:1536）；`summaryDays` 用 Set 去重但保持插入序；账本 JSON 键序由对象字面量固定；字符数用 `[...text].length` 确定。没有新增带时间字段（`now`/`today` 是原有字段）。输出内容本身随数据库状态变化属数据差异，不是序列化不稳定。
3. **有对应的自动检查，反向用例会真失败。** decision-ledger.test.ts:453-498 含 4 个反向用例（只带 summaryIds、带 injected 无 ids、坏日期、坏状态）加一条非 external_read 拒绝——若去掉新校验，这些 append 会成功，测试即失败，是真反向。提示词目录 gate 也有反向用例。缺口：`#recentDays` 的 partial 分支和 summaries 源缺失分支无测试（问题 3）。
4. **逐值核对通过，但读取端展示有文档级缺口。**
   - `recentDays`/`recentDaysComplete`：产生于 production-mcp-read.ts:343，使用方为外部客户端，工具描述（tools.ts:239）和 ADR 已同步；遮盖覆盖。
   - `summaries` 数据源：service-main.ts:1789-1805 调 `memoryEpisodes.recent`，签名与 episodes.ts:206-240 匹配；`memoryEpisodes` 未启用时源缺省、MCP 侧有兜底（335 行）。
   - summary 六项（账本）：产生于 production-mcp-read.ts:294-303；校验在 `validateLedgerWrite`（含 external_read-only 限制）；落库 insertLedgerRow:183-192；读回 entryFromRow:291-296 有默认值；决策链读取端只对 proactive 读这些键（production-decision-chain.ts:97、163），external_read 走通用 `inputFields`——两端校验都能接受。与 I-73 教训相关的一点：这次确实两头都查了（写入校验 + 读回默认值 + chain 的 `?? "off"` 容错），但约定文档（问题 1）和读取端测试（问题 4）没跟上。

## 侧重检查

走的流程：外部客户端一次 `today_context` 调用，从入口到结束——`admit`（BearerGate 限流/鉴权）→ MCP HTTP handler → `#call` → `#todayContext`（提醒 list + `#recentDays` → `MemoryEpisodeService.recent` → `listDaySummaries` SQL → `readText` 解密）→ `maskForExternalRead` → `#record` → `ledger.append` → `validateLedgerWrite` → `insertLedgerRow`。主路径有集成测试（真实 SQLite、真实 episode 存储、官方 SDK 客户端）覆盖。**没有测试覆盖的路径**：summaries 源缺失（memoryEpisodes 未启用的部署形态）、partial 读取（部分正文解密失败）、提醒先失败时账本的 summary 语义、决策卡「依据」抽屉对 external_read 新字段的展示。文档与规则核对：ADR 0219 决定 7 与代码一致；写入约定 spec 未更新（问题 1）；ADR 0216 的 `summaryRead` 取值（含 off、补生成失败记 partial）与 external_read 用法（无补生成、generated 固定 0）兼容。
