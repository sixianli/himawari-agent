# 复核报告：PR 446（首页条目读取层第 1 步，169a3c66）

## 侧重检查（我走过的流程和结论）

流程一（home.read 主链路）：`POST /api/gateway/v2/queries` → `routeOptions` 允许的操作清单（production-http-composition.ts:696 加了 `PRODUCTION_HOME_OPERATIONS`）→ `createProductionApprovalGateway` 的 `delegate.query`（production-approval-gateway.ts:111）→ `ProductionHomeControl.query` → `HomeFeedService.read` → 8 个来源（mail/approvals/reminders/memory_requests/external_proposals/rules/done/runs）+ upcoming → `orderHomeItems` → 快照经 `gatewayV2MessageSchema` 校验。
- 有测试覆盖：contract fixture 往返（gateway-v2.contract.test.ts:34-46 要求每个 message type 都有 fixture）、集成测试 13 条（test/integration/home-feed.test.ts，worker/direct 两种执行各跑一遍，且每次 `read()` 都把快照 parse 一遍合约）、单元测试 14 条（home-feed.unit.test.ts）。
- **没有**测试覆盖的路径：`external_proposals` 来源的 candidate 映射和 `unread = total - items.length` 算法（home-feed.test.ts 从未 seed 外部提议，fixture 里 `options.externalProposals` 为 undefined，`#externalProposals` 直接返回 0）；`done` 来源在 home 侧的 `recentSince` 过滤和 `lead` 过滤（tidyUpViews/conversationReviewViews 本身被既有 memory.overview 集成测试间接守门，decision-chain.test.ts:1126-1166 断言 tidyUps 内容，所以重构等价性有守门，但 home 的过滤分支没有直接用例）；`runSource` 里 `threadTitle` 返回 null 导致整个 run 被丢弃的分支（测试只覆盖了 `{title:null}` 的 untitled 分支）；`onHomeDiagnostic` 日志路径。

流程二（网页推送角标）：`push.tick()` → `#collect`（旧逻辑不变）→ `#deliver` → `badge ??= await this.#badge()` → `home.awaitingCount()`（awaiting-only 来源）→ `webPushPayload`。有测试：production-web-push.test.ts 的 `[HOME-count]`（undefined、抛错、只在真发送时读三个方向）和 home-feed.test.ts:925-956（角标数字 = 首页件数）。

流程三（配置）：`runPolicy.homeFeed` → `parseHomeFeed`（strict-configuration.ts）→ `ProductionHomeControl` settings → 各来源 limit/时间窗。有测试 [HOME-settings]，含越界和未知键的反向用例。

## 发现的问题（按严重度从高到低）

**1. 低 · packages/persistence-sqlite/src/sqlite-run-lifecycle-operations.ts:941-976**
问题：有未释放后台占位的**终态**运行被标成 `state: "running"`，首页会以“正在做”显示一条已完成/已取消/已失败的运行。
证据（读代码证实）：`active` 计算为 `(r.status NOT IN ('completed','failed','cancelled') OR EXISTS (… h.released_at IS NULL)) AS active`，随后 `state: row["active"] === 1 ? "running" : "failed"`。SQL 的第二个 OR 分支（有未释放占位）不筛状态，所以 status='completed' 或 'cancelled' 且占位未释放的运行也返回且 active=1。集成测试 home-feed.test.ts:842-871 明确期望 `run-background`（completed + hold open）→ kind "running"，说明是有意行为还是疏漏需要作者确认——按“正在做、已做完的事”的语义，已完成的运行标“正在做”至少有歧义。
建议：state 改按 status 判（只有非终态才 running），或在方案文档写明“占位未释放的终态运行按正在做显示”。

**2. 低 · test/integration/home-feed.test.ts（缺文件内用例）**
问题：`external_proposals` 来源没有集成用例，其映射（proposal→candidate）和 unread 算法（production-home.ts:301 `Math.max(0, total - items.length)`）零集成覆盖；单元测试只覆盖了通用 unread 注入，不经过这条生产映射。
证据（读代码证实）：home-feed.test.ts 全文没有 seed 外部提议的语句；fixture 里未传 `externalProposals`。
建议：第 2/3 步接调用方前补一条 seed 提议的用例（含超限 unread）。

**3. 低 · apps/agent-service/src/production-home.ts:538-541（done 来源）**
问题：home 侧 `done` 来源的 `recentSince` 过滤（`createdAt >= recentSince`、`finishedAt < recentSince` 剔除）没有直接测试；集成 fixture 里 tidy/review 均为空。
证据（读代码证实）：home-feed.test.ts 无 tidyUp/conversationReview seed。
建议：与上一条一并补。

**4. 低 · apps/agent-service/src/production-home.ts:629-635**
问题：upcoming 的排除集合来自 `dueReminderViews(settings.sourceReadLimit)` 的 rowIds（上限 200）。当 due 行超过 sourceReadLimit 时，超出的 due 提醒不会被排除，若其 `due_at` 仍在未来（remind_at 已到点但 due_at 未过），同一条会同时出现在 items 和 upcoming。（读代码证实排除逻辑；“是否真会发生”依赖 >200 条 due 且 due_at 在未来的数据——推测，极边缘。）memory.overview 旧路径用 REMINDERS_SHOWN=10 排除，同类缺口是既有行为，本 PR 未使其变差。
建议：排除时直接用 countDue 的全量 id，或注明已知边缘。

**5. 低（推测，未核实） · packages/application/src/services/proactive-overview.ts:194-195,280**
问题：`home.snapshot` 的 `source.at`（timestamp，要求 canonical RFC3339，validation.ts:115-124）取自 `insight.createdAt` 和 `connection.updatedAt`，这两个字段在既有合约（proactive.overview.snapshot）里没有出现过、没被 timestamp 校验过。若 proactive store 曾写入非 canonical 时间戳，整个 home.snapshot 校验失败。测试里的时间都是 canonical；生产写入路径是否全部经 `clock.now()` 的 canonical ISO 未逐一核实。
建议：在 proactive store 写入处确认格式，或给 home 的集成测试加一条非 canonical 输入的反向用例。

**6. 信息（未核实，低风险）**：`onSourceFailure` 记录 `error.message` 进日志（production-http-composition.ts:1169-1175）。来源错误一般是 SQL/端口错误，理论上不含记忆正文；未逐类核实错误消息来源。

## 作者说法逐条核对（读代码证实的，除非注明）

- “排序结果和来源返回行的顺序无关”——证实。`compareItems` 构成全序（rank → 等主人的 deadline → createdAt → key，home-feed.ts:73-88），键全局唯一；单测用 25 个乱序种子验证（home-feed.unit.test.ts:104-111）。唯一与顺序有关的是跨来源重复键时保留哪份内容（dedup 保留先到者），但生产来源顺序固定且等主人来源都排在非等主人来源之前，排序不受影响。
- “不自报 awaitsOwner 的条目被丢弃”——证实（home-feed.ts:153-155 过滤 `item.awaitsOwner === source.awaitsOwner`；单测 home-feed.unit.test.ts:159-168）。
- “来源抛错时列表仍返回，incompleteSources 写出来源名”——证实（home-feed.ts:157-161；单测 200-220）。注意：失败来源的 unread 也一并丢失，badge 路径无任何信号，这是设计使然。
- “网页推送只在真的要发送时才调用件数函数；undefined/抛错时不带 app_badge”——证实。`badge ??= await this.#badge()` 在 expired/suppressed `continue` 之后（production-web-push.ts:430-437）；`#badge` 捕获错误→0（:398-404）；`webPushPayload` 只在 `badge > 0` 时带 `app_badge`（:139）；`[HOME-count]` 测试覆盖 undefined、抛错、只在发送时读三个方向。
- “home.snapshot 里每个字符串都按合约上限截断或置空”——基本证实。sentence 2000 / from 320 / label 500 / link 512 都经 `line()` 按 UTF-16 长度截断并替换控制字符（production-home.ts:139-155），与 `boundedString` 的 UTF-16 length + 控制字符拒绝完全对应（validation.ts:89-106）；upcoming.text 经 `singleLine` slice(0,2000)（production-memory-control.ts:117-125）；actions label/reviewLabel 来自固定目录。**例外（推测，低风险）**：target.id/threadId/decisionId/reminderId/memoryId 等 machineString 字段不截断，依赖既有 id 生成长度 ≤128（与 I-73 同型的“两端校验”点，我核算过：key 前缀最长 19 字符 + id ≤128 = 147 < 160 上限，安全）；这些 id 在其他合约里已按 machineString 使用过，风险低。
- “runLifecycle.listUnattended 只返回三类”——证实。SQL 三个 OR 分支与说法逐条对应；第三类对 failed 用户消息运行不要求占位未释放（含已释放占位），与“曾有后台占位”一致。但 state 映射有第 1 条的问题。
- “production-memory-control.ts 拆分后原 overview 返回内容没变”——证实。pending/reminders/upcoming/tidyUps/conversationReviews/externalProposals 的输出字段与旧代码逐字段一致（新增的 dataClassification/lead 在 overview 出口被剥离）；`#dueReminders` 仍被修订摘要（:395）原样使用；既有 memory.overview 集成测试守门。新增行为只有 rows.length ≥ limit 时多一次 countDue 读。

## 必答问题

1. **不会改变发给模型的内容。** 依据 diff 文件清单：没有触碰任何模型请求组装路径（无 runtime-pi、prompt、history、工具定义、遮盖改动）。唯一的共享数据改动是 `ProactiveOverview` 接口加了 `decisionId`/`createdAt`/`changedAt`：读代码证实它们只被字段级消费——daily-review.ts:351、446 只取 decisions/audit.items 的既有字段，production-proactive.ts:544-599 组装 proactive.overview.snapshot 时显式挑字段，新增字段不进快照也不进提示。home feed 和 web push 都不发模型请求。`.claude/rules/prompt-prefix.md` 的条目 4/5（只追加、存实际发出的）不涉及本次改动；`check:prompt-prefix` 门不需要也不应该变。
2. **不会。** home.snapshot 的每个文字都来自 DB 原值或固定目录文本（HOME_TEXT），键顺序按对象字面量固定；排序是全序比较、与来源返回顺序无关；`revision` 对相同数据+locale 稳定（单测 240-253 验证同数据同哈希、变数据变哈希）；`generatedAt` 是独立字段不掺进文字。没有发现依赖前后文、带注入时间或无序集合序列化的文字。
3. **有，且反向用例真实存在**：合约层——fixture 往返测试要求 home.read/home.snapshot 都有 fixture，`object` schema 拒绝未知字段（validation.ts:174-176）；HTTP 层——未认证 401 反向用例（production-http-composition.unit.test.ts:1180）；配置层——越界值、非整数、未知键都会抛（startup-configuration.unit.test.ts:1065-1092，会真失败）；推送层——`[HOME-count]` 覆盖 undefined/抛错/不必要读取；服务层——awaitsOwner 自相矛盾、重复键去重、截断时保真计数、来源失败命名、“badge 不读非等主人来源”都有单元用例。**缺口**：external_proposals 和 done 来源没有集成用例（见问题 2、3），超长文字→截断这条没有反向用例（靠 `line()`/`singleLine` 的实现保证，无测试钉住）。
4. **逐值核对通过**：来源名 8+1 个、动作名 13 个、locale 3 个、target/origin 类型、kind/rank/sentenceBasis/polarity 全部在 contracts-v2.ts 新增枚举内，产生端（production-home.ts）与校验端（homeSnapshotSchema）一一对应，集成测试每次 read 都过一遍 `gatewayV2MessageSchema.parse` 真实输出；`home.read` 登记在 GATEWAY_V2_MESSAGE_TYPES、schemasByType、gateway reads、routeOptions、operations-pending.json 五处一致；`countDue` 和 `listUnattendedRuns` 在端口定义、durable-adapters 实现、sqlite execute 分派三端齐全，且 listUnattended 的 limit ≤500 检查（sqlite-run-lifecycle-operations.ts:945）大于配置上限 sourceReadLimit ≤200，不会互相打架。剩下未闭环的只有第 5 条的 timestamp 格式推测项。
