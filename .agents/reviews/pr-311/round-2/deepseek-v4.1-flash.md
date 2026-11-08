## 复核范围

`87edabe2` 相对 `5530765e`（main）的本 PR 改动共 31 个文件；`6b8afcf..HEAD` 里含 `1b60e173` 合并 main 的噪声，下面的判断以 `git diff 5530765e..87edabe2` 和当前文件为准。未运行测试，只做静态核对。

## 问题（按严重度）

### 中 1：页面与统计脚本对“提醒创建”的判定会不一致（>512 引用）

- 文件：`apps/control-center/src/memory-source.ts:24-27`、`apps/agent-service/src/production-memory-control.ts:347`、`scripts/operations/memory-source-report.mjs:29-33`
- 问题：页面用概览里的 `sourceRefs` 判提醒，而概览已把超过 512 字符的引用过滤掉了；脚本却用全部 `memory_provenance.source_id` 判提醒，没有长度过滤。
- 证据：
  - `memory-source.ts:24-27`：`item.sourceRefs.length > 0 && item.sourceRefs.every((ref) => ref.startsWith(REMINDER_SOURCE_PREFIX)) ? "reminder" : "unavailable"`
  - `production-memory-control.ts:347`：`sourceRefs: memory.sourceRefs.filter((ref) => ref.length <= 512)`
  - `memory-source-report.mjs:29-33`：提醒条件只查 `memory_provenance`，没有 `length(p.source_id) <= 512`
  - 后果：一条记忆有 `memory-content:reminder:*` 引用，同时有一个 >512 的非提醒引用时，页面判“提醒创建”，脚本判“来源已不可查”。这与作者“脚本的过滤已对齐”和 ADR“用同一套分类”的说法不符。
- 建议：给脚本的提醒 `EXISTS`/`NOT EXISTS` 也加 `length(p.source_id) <= 512`，或把分类逻辑收敛到一处共享实现。

### 中 2：脚本新增的 committed / 线程存活 / 提醒过滤没有反向用例

- 文件：`test/integration/memory-source-report.test.ts:27-33,69-74`、`scripts/operations/memory-source-report.mjs:25-27`
- 问题：脚本是第二套 SQL 实现，但测试只造了 `status='open'` 的线程和默认 `committed` 的消息。
- 证据：
  - 线程插入固定为 `VALUES (?, 'o', 'a', 1, 'open', ?, ?)`。
  - `thread_messages` 插入列里没有 `message_status`，依赖默认值 `committed`。
  - 脚本新增的 `t.message_status = 'committed'` 和 `h.status NOT IN ('trashed','deletion_pending','deleted_verified')` 从未被反向用例覆盖。
  - 因此“消息未提交、对话在回收站/删除中/已删除”这些修复只在 `production-memory-capture.test.ts` 验证了服务端查询，没有验证脚本；上面第 1 条的不一致正是这种漂移的结果。
- 建议：给 `memory-source-report.test.ts` 补 partial 消息、trashed/deletion_pending/deleted_verified 线程、提醒引用混合长引用等用例，或让页面和脚本共用同一套分类。

### 中 3：10 秒过期可能早于大对话加载完成，导致“跳到原话”静默失效

- 文件：`apps/control-center/src/message-focus.ts:6,14-16`、`apps/control-center/src/components/chat-history.tsx:114-128`、`apps/control-center/src/thread-control-center.tsx:654-672`
- 问题（推测，代码路径成立）：线程详情会先循环加载全部分页，再 `setDetail` 渲染 `ChatHistory`；如果大对话加载超过 10 秒，`pendingMessageFocus()` 在 ChatHistory 首次消费时已过期，请求被清掉，既不滚动也不高亮。
- 证据：
  - `message-focus.ts:6`：`const REQUEST_LIFETIME_MS = 10_000;`
  - `message-focus.ts:14-16`：只有调用 `pendingMessageFocus()` 时才检查过期并清空。
  - `thread-control-center.tsx:654-672`：`while (current.payload.nextSequence !== null) { ... }` 把全部分页拉完；`682` 行才 `setDetail(current)`。
  - 浏览器验收只在 `memory-source-browser.test.ts:102` 断言 `waitForURL`，不检查是否真的滚到并高亮；这条路径没有覆盖。
- 建议：消费请求时不要只依赖挂载时刻，可在详情到达后再给一次机会；或把过期起点改成“详情已就绪”，并补一个延迟加载的测试。若坚持 10 秒，至少在 ADR 里写明大对话会静默失效。

### 低 4：ADR 声称覆盖“同内容引用的 agent 消息”，测试实际没有覆盖

- 文件：`docs/adr/0186-memory-jumps-to-the-owners-original-message.md:70`、`test/integration/production-memory-capture.test.ts:1974-1977`
- 问题：ADR 写“agent 的消息即使内容引用相同也不命中”，但测试只是把引用换成 agent 自己的、本来就不相同的 `contentRef`。
- 证据：
  - ADR 第 70 行原话：“agent 的消息即使内容引用相同也不命中”。
  - 测试：`const agentRef = await context.turn("agent", "好的，记下了", null); setReferences(agentRef); expect(await sourceOf()).toBeNull();`
  - `setup` 里 `contentRef = \`payload-${role}-${sequence}\``，所以 agent 引用和 owner 的 `payload-owner-1` 必然不同。
- 建议：补一条真正“agent 消息与 owner 消息共用同一 content_ref”的用例，或把 ADR 改成“只认 owner 消息，agent 消息的引用不命中”。

### 低 5：最早历史事件文字读不出时，页面会把它当成“整理记忆”，脚本仍按最早事件判“来源对话已删除”

- 文件：`apps/agent-service/src/production-memory-control.ts:325-327`、`apps/control-center/src/memory-source.ts:29`、`scripts/operations/memory-source-report.mjs:35-38`
- 问题（推测，需 payload 缺失或为空才触发）：概览构造历史时，读不出文字的事件会被 `continue` 丢弃；页面用 `history[0]?.sourceDeleted`，脚本用数据库里最早一条历史事件，两边可能一个说 `tidy`、一个说 `deleted`。
- 证据：
  - `production-memory-control.ts:326-327`：`const eventText = await textOfRef(event.contentRef); if (!eventText) continue;`
  - `memory-source.ts:29`：`return item.history[0]?.sourceDeleted ? "deleted" : "tidy"`
  - `memory-source-report.mjs:35-38`：直接取 `memory_history_events ... ORDER BY h.occurred_at, h.rowid LIMIT 1`
- 建议：分类所需的 `sourceDeleted` 不要依赖事件文字是否读得出，单独从最早事件带出，或页面与脚本都基于同一个“最早事件”字段。

### 低 6：非提醒的“来源已不可查”会彻底失去打开来源对话的入口

- 文件：`apps/control-center/src/components/memory-page.tsx:543-544`
- 问题（行为已证实；是否为预期需确认）：只要不是提醒、又匹配不到消息，详情只显示“来源已不可查”，即使 `sourceThreadId` 还在、对话仍可打开。改动前的逻辑在这个分支会显示“来源对话”按钮。
- 证据：`origin === "unavailable" ? message("memory.page.sourceUnavailable") : ...`，该分支没有按钮；对比改动前的 `origin ? ... : <button>{message("memory.source")}</button>`。
- 建议：如果来源对话仍存活，保留“来源对话”入口与“来源已不可查”并列；如果故意移除，ADR 里写清代价。

### 低 7：提醒分支没有看来源对话是否已进回收站/删除流程

- 文件：`apps/control-center/src/memory-source.ts:22-27`、`scripts/operations/memory-source-report.mjs:20-34`
- 问题：提醒只根据“引用全是 reminder 前缀”判定，完全不知道线程状态；而 `findOwnerMessages` 对 trashed/deletion_pending/deleted_verified 的线程返回空，只会让 `sourceMessageId` 为空，于是提醒仍被判“提醒创建”并显示“来源对话”入口，可能打开一个已删除的对话。
- 证据：页面分支只检查 `sourceThreadId`、`sourceMessageId` 和 `sourceRefs`；脚本提醒分支同样不查 `threads.status`。
- 建议：需要产品确认提醒是否也应区分“来源对话已删除”；若要区分，概览需要把线程存活状态带出来。

### 低 8：概览新增查询按对话逐条执行，且最早匹配是逐条记忆全表过滤

- 文件：`apps/agent-service/src/production-memory-control.ts:308-318,108-113`、`packages/persistence-sqlite/src/sqlite-memory-book-operations.ts:565-584`、`packages/persistence-sqlite/src/sqlite-memory-operations.ts:934-939`
- 问题（推测，规模相关）：`findOwnerMessages` 对每个来源对话、每 200 个引用执行一条 prepared statement；概览本身 `listActive` 没有条数上限。记忆分散在很多对话时，一次概览可能发上千条 SQL；`earliestSourceMessage` 又对每条记忆全量 `filter + toSorted`。
- 建议：按 threadId 一次查出后建 `Map<threadId, Map<contentRef, earliest>>`，或把查询合并成一条带 `thread_id IN (...)` 的语句。

## 侧重检查

- **错误路径/不可信输入**：`findOwnerMessages` 的 `threadId`、`refs` 全部走绑定参数，无 SQL 注入；空 `refs` 时内层循环不执行，不会生成 `IN ()`；但 `lookups` 结构完全没有校验，传入畸形 payload 会抛 TypeError 而不是 `PORT_INVALID_OPERATION`（仅内部调用，风险低）。
- **回收站/删除中/未提交/跨对话/agent/同 ref/>200**：服务端查询在 `production-memory-capture.test.ts` 覆盖了前五类和 >200；但“同 ref 的 agent 消息”没有真正覆盖；统计脚本侧的 committed/线程状态过滤完全没有覆盖。
- **安全**：新 SQL 只读、只返回 `messageId`，不返回正文；统计脚本只读打开数据库且只输出计数；`sourceMessageId` 由 `machineString` 校验；DOM 里只是 `dataset` 比较，无注入面。
- **资源耗尽**：见低 8；另 10 秒过期与全量分页加载叠加，见中 3。
- **不可逆操作**：本改动无写操作、无迁移；`findOwnerMessages` 使用 `.all()`，是只读查询。
- **规则/文档/代码一致**：ADR 编号 0186 唯一，0185 确为 PR 310 的敏感记忆 ADR，没有指向旧路径的残留引用；“JOIN threads 只认 open”与 DB 约束 `('open','trashed','deletion_pending','deleted_verified')` 一致；“来源对话 id 下推进 SQL”确实有 `thread_messages(thread_id, turn_id, sequence)` 可用；发现的不一致已列在上面（提醒长引用、历史事件文字、同 ref agent 测试、脚本反向用例）。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

不会。PR 相对 main 的 31 个文件里没有系统提示、工具定义、提示词目录、历史存储、压缩或遮盖代码；新增的 `sourceMessageId` 只进 `memory.overview.snapshot`（给控制中心），新查询 `findOwnerMessages` 是只读的（`sqlite-memory-book-operations.ts:570-581` 的 `.all()`）。因此发给模型的内容仍然只在末尾追加，本改动没有往系统提示/工具定义/历史里加任何每轮会变的值。

### 2. 同一段文字会不会在不同请求里变成不同字节？

不会影响模型请求。`sourceMessageId` 由数据库确定（按 `sequence` 取最早，`production-memory-control.ts:108-113`）；唯一的 `Date.now()` 在浏览器端 `message-focus.ts:11`，不会序列化进模型请求；`refsByThread` 的 Map 顺序只影响 SQL 执行，不进入模型字节。页面计数会受概览加载范围影响（ADR 已写明），但那是界面数字，不是模型内容。

### 3. 有没有自动检查，反向用例真的会失败吗？

有检查，但覆盖不完整。静态看，`production-memory-capture.test.ts` 的反向用例确实针对修复前的缺陷（旧查询在 `6b8afcf` 上没有 JOIN threads / `message_status`），页面单测也覆盖了不可查、提醒、导入；但我没有运行测试，“会失败”是静态推断。缺口是：统计脚本的 committed / 线程状态 / 提醒过滤没有反向用例（中 2），同 ref 的 agent 消息没有用例（低 4），浏览器正例只校验 URL、不校验滚动高亮（中 3）。

### 4. 新值在产生端和使用端都能被接受吗？

- `sourceMessageId`：产生端 `production-memory-control.ts:346`；契约端 `contracts-v2.ts:940` 为 `nullable(machineString)`，消息 id 与线程详情同源（`sqlite-thread-operations.ts:142-145`），控制中心用它匹配 `data-message-id`（`chat-history.tsx:196`），测试夹具已同步（`gateway-v2.fixture.ts:369`、浏览器夹具 `:849`、单测 helper `:53`）。这一项两端能对上。
- `findOwnerMessages`：端口 `memory-book.ts:121`、适配器 `durable-adapters.ts:958`、SQLite 实现 `sqlite-memory-book-operations.ts:556`、调用方 `production-memory-control.ts:315` 均已接通；grep 未发现第二个 `MemoryBookStorePort` 实现。
- 新状态 `reminder`：`memory-source-report.mjs` 的 `SOURCE_STATES` 与 `.d.mts` 一致，i18n 三种语言和 `message-ids.ts` 都有；参数化消息补了 sample。
- 不能完全对上的地方就是“页面分类 vs 脚本分类”：两者是两套实现，已发现长引用导致提醒判定不一致（中 1），且没有交叉测试（中 2）。此外，旧版 Agent Service 配新版控制中心时，契约把 `sourceMessageId` 当必填可空字段，可能整页 `MEMORY_INVALID`；部署是否原子未核实。
