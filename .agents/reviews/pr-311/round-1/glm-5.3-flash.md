# 复核报告：PR 311（P1-1 记忆跳到原话）

## 读代码证实的结论（按严重度排列）

### 1.（中）`findOwnerMessages` 不过滤 `message_status`，可能把跳转目标指到界面上不渲染的消息

- 文件:行：`packages/persistence-sqlite/src/sqlite-memory-book-operations.ts:564-570`
- 问题：新 SQL 只按 `role = 'owner'` 过滤，没有 `message_status = 'committed'` 条件。而 `thread_messages.message_status` 允许 `'committed' | 'partial' | 'failed'`（`packages/persistence-sqlite/src/migrations/0015_thread_lifecycle_and_search.sql:14-15`），并且这个代码库里所有其它读取消息的地方都过滤 committed：`sqlite-thread-operations.ts:1521`、`:1685`、`:1863`，连同类检查 `:1550-1554`（`role = 'owner' AND message_status = 'committed'`）也过滤。线程详情快照也只返回 committed 消息（`sqlite-thread-operations.ts:1685`）。
- 后果：一旦某条 provenance 引用指向 partial/failed 消息的 content_ref，网关会给出 `sourceMessageId`，界面显示「跳到原话」，但对话页里那条消息永远不出现——点击后静默无反应，且计数把它算作「能跳到原话」，与 ADR 0185 的「找不到原话要如实说」相悖。
- 概率评估（推测）：抓取记忆时存的是已提交消息的 payloadRef，所以实际命中的可能性低；但这个不一致是实打实的，同类检查 `:1550-1554` 已经踩过这个点并加了过滤。
- 建议：SQL 加 `AND message_status = 'committed'`。

### 2.（低）服务端过滤 `ref.length <= 512`，统计脚本不过滤——两端定义有缝隙

- 文件:行：`apps/agent-service/src/production-memory-control.ts:310、340`（两处 `.filter((ref) => ref.length <= 512)`）对比 `scripts/operations/memory-source-report.mjs:14-25`（`STATE_EXPRESSION` 的 JOIN 没有长度条件）。
- 问题：若某条 content_ref 超过 512 字符，服务端会把它从查询和 `sourceRefs` 输出里都滤掉（该记忆判为 unavailable），脚本却照常 JOIN 匹配（判为 jump）。同一份数据，界面数字和报告脚本数字会不同，违背作者「按同一定义数出条数」的说法。
- 概率评估（推测）：content_ref 是 `payload:http:<sha256>` 这类带命名空间的短串（`production-http-composition.ts:469`），现实中很难超 512。
- 建议：脚本加同样的长度过滤，或两端都去掉。

### 3.（低）界面计数与脚本计数的基数不同

- 文件:行：`apps/agent-service/src/production-memory-control.ts:315-316`（`if (!text) continue;` ——读不出文字的记忆整个从概览里丢掉）；`apps/control-center/src/memory-source.ts:22-27` 基于 `overview.memories` 计数；脚本按数据库全量 `status IN ('active','archived')` 统计。
- 问题：payload 被清掉/读失败的记忆，脚本会计入某类，界面根本看不到、不计入。边界情况下两边的「来源已不可查」条数会对不上。
- 建议：接受并在 ADR「已知局限」里写明，或让概览不丢这些记忆。

### 4.（低）`MESSAGE_FOCUS_EVENT` 是死信号；全局 `pending` 有滞留场景

- 文件:行：`apps/control-center/src/message-focus.ts:5-20`
- 问题：`requestMessageFocus` 派发事件，但全仓 grep 只有定义和派发两处，没有任何监听者——跳转实际靠 `chat-history.tsx:114-128` 的渲染副作用轮询 `pendingMessageFocus()`。另外 `pending` 是模块级单例，只有线程匹配的 `ChatHistory` 挂载才会清（`chat-history.tsx:121`）：点了「跳到原话」后导航失败或改去别的页面，`pending` 会一直留着，之后从对话列表普通打开同一个对话时会触发一次意料外的滚动和高亮。
- 建议：删掉事件派发，或在路由切换离开对话面时 `clearMessageFocus()`。

### 5.（低，测试缺口）跳转主链路的几段没有覆盖

- `app.tsx:452-456` 的接线（`requestMessageFocus` + navigate）没有测试：单测里 `MemoryPage` 用自己的 `opened` spy，绕过了这段。
- 真实浏览器的滚动/高亮、payload 文本异步到达后的表现、live 刷新竞态：只有 jsdom 单测，无 e2e（作者自己也承认）。
- `findOwnerMessages` 的 200 条分批循环（`sqlite-memory-book-operations.ts:557-568`）没有超过一批的用例。
- 跨对话过滤（`threadId === memory.sourceThreadId`）只在脚本的 SQL 级测试（`test/integration/memory-source-report.test.ts` 的 wrong-thread 用例）覆盖；走网关全链路的 `production-memory-capture.test.ts:1869-1897` 只有一个对话，测不到这个分支。

## 「作者的说法」核对结果

- 「服务端用 sourceRefs 匹配 Andy 的消息（role=owner）、取最早一条」——证实：`production-memory-control.ts:103-112`（`toSorted` 按 sequence，取第一条）+ SQL `role = 'owner'` + `ORDER BY thread_id, sequence`。
- 「只读查询、不改来源存法、不加迁移」——证实：`durable-adapters.ts:958` 注册为 `this.context.read`；diff 里没有任何迁移文件。
- 「脚本按同一定义数条数」——大体证实，但有两处缝隙（上面第 2、3 条）。
- 「条数定义在 ADR 0185」——证实，且脚本的 6 类互斥、合计等于总数的说法有测试断言（`memory-source-report.test.ts:101-108`）。
- 「未做真实库统计、未做浏览器验收」——与 diff 一致（诚实申报）。
- 约束：`.github/security-review-manifest.json` 未动；无代码注释；文档为简体中文——均证实。

## 侧重检查（走过的一条普通流程）

记忆页 → 点开一条记忆 → 点「跳到原话」→ 打开来源对话 → 滚动并高亮：

1. `memorySourceState` / `memorySourceCounts`（memory-source.ts）——有单测覆盖（memory-interactions 三个 `[P1-1]` 用例，含 owner/tidy 不计入的反向用例）。
2. 详情按钮与横幅渲染（memory-page.tsx:517-531、1436-1445）——有文本断言覆盖。
3. `app.tsx` 接线——**无测试**（见第 5 条）。
4. `message-focus.ts` + `chat-history.tsx` 副作用——jsdom 单测覆盖正反（别的对话、消息不存在不动）；真实浏览器未测。
5. 对话页消息加载：`thread-control-center.tsx:643-679` 在设置 detail 前把全部分页拉完再渲染，所以不存在「目标消息在未加载页里」的竞态——读代码证实，无问题。
6. 服务端 `earliestSourceMessage` → `findOwnerMessages`——happy path、消息被删、导入三条有全链路集成测试；跨对话、>512 引用、>200 引用分批未在此层覆盖。

## 必答问题逐条回答

**1. 会不会改变模型已经见过的请求开头？** 不会。全部改动落在 `memory.overview.snapshot`（控制中心 UI 的查询快照）、新端口/SQL、UI 组件、测试、文档和脚本；grep 全仓确认 `sourceMessageId` 的生产者与消费者只有网关概览和 memory-page，模型请求组装（提示词、工具定义、历史存储、遮盖、记忆召回）一个文件都没碰。发给模型的内容仍只追加，本次也不引入任何每轮变化的值。

**2. 会不会让同一段文字在不同请求里变成不同字节？** 不会（读代码证实）。`sourceMessageId` 由固定 SQL + 稳定排序（按 sequence，`toSorted` 稳定）推导，与记录遍历顺序无关（records 按 updatedAt 排序的并列不稳定只影响 SQL 批次划分，不影响结果值）；概览无时间戳类新字段；脚本输出按固定的 `SOURCE_STATES` 数组渲染。推测级残留：仅当同一对话内两条 message 的 sequence 相同才可能不确定——未核实 sequence 的唯一性约束。

**3. 有没有对应的自动检查、反向用例会不会真的失败？** 有，四处（两条集成测试 + 两组前端单测），且都带反向用例：脚本测试的 wrong-thread/unmatched/trashed、message-focus 的「别的对话、消息不存在不动」、memory-interactions 的「owner/tidy 不计入不可查」。逻辑上这些断言在实现回退时会失败（例如去掉 threadId 过滤，wrong-thread 会从 unavailable 变成 jump 而挂掉）。缺口见第 5 条。

**4. 改动产生的每个值，两端都核对了吗？** 逐个核过，未发现断端：`MemorySourceMessage` 与 `memoryBook.findOwnerMessages` 操作名（端口 → dispatch case `sqlite-memory-book-operations.ts:106-107` → adapters 注册 `durable-adapters.ts:958`）；契约字段 `sourceMessageId: nullable(machineString)`（schema、两个 fixture、e2e fixture 均同步，message id 形如 `message:...`/`message-...` 都能过 machineString 正则 `validation.ts:49-60`）；5 个新 i18n 键在 message-ids 与 en/ja/zh-CN 三个资源里齐全，`memory.page.origin` 的 `import` 分支兜底了批次丢失的情况（zh-CN.ts:693）。唯一两端不一致的是第 2 条的 512 过滤（服务端滤、脚本不滤）。
