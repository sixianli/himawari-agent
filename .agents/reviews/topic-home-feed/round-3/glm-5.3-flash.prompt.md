你是独立的方案审核者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面是一份还没动手实施的方案。逐条对照代码和一手来源核对：有没有漏掉的场景、判断错的地方、和业界成熟做法不一致的地方。方案作者的说法可能有错。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：测试有没有覆盖这次改动、文档和规则与代码是否一致；挑一条最普通的使用流程，从入口走到结束，标出经过的、没有测试覆盖的代码路径。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你走过的流程和结论。
输出格式：按严重度从高到低排列，每条写：严重度、问题、证据（文件:行引用的代码，或网址和原话）、你建议怎么改。把「证实的」和「推测」分开写。最后写：如果由你来定，你会怎样改这份方案，并逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 0d989adb521245a18eea3e8e26c55c27469b70c2。
待审核的方案：
# 材料：服务器端“首页条目”读取接口

## 要解决的问题

Himawari 正在做苹果端（iPhone、Apple Watch、Mac 菜单栏）。设计已定：App 的“今天”首屏只放“Himawari 主动找主人的事”，而且“最要紧的排最前、最大”。主人（Andy）的原话（2026-11-12）：

> “一个个人 AI agent 的主动性是一个非常非常重要的特性。如果什么事情都要主人去主动发起，那我觉得这个 AI agent 做得就不够，就很鸡肋。”
> “我希望首屏一定是最紧急、最优先、最需要抓住用户注意力的事情。”

客户端不能自己排序，也不能自己拼数据：需要服务器提供一个读取接口，返回一份已经排好序的“首页条目”清单。设计上这份清单里可能有六种条目：

1. 主动提醒或拦截（Himawari 看到某件事，主动告诉主人或替主人拦下）；
2. 等主人点头的审批（要主人同意了 Himawari 才能继续做）；
3. 待确认的记忆（Himawari 听到或推断出一条记忆，等主人确认要不要记）；
4. 替主人做好的（已经做完的事，能撤销的给“撤销”）；
5. 正在做的（Himawari 正在后台做的事）；
6. 出错要主人处理的。

每条要有：一句话（说这是什么事）、来源说明（从哪看出来的）、主人能做的动作（例如“同意/不同意”“记下/不记”）、能不能撤销。

另外：
- 要一个“等主人定的件数”，iPhone“今天”页签的红点数字、Watch 表盘、Mac 菜单栏数字都用这同一个数；设计上它只数需要主人做决定的条目（提醒、审批、待确认的记忆），不数“替主人做好的”和“正在做的”。
- 每条条目点开能看“为什么告诉你”：Himawari 看到的来源、命中的规则（主人定的规则）、用到的记忆。哪一项没有，就不给哪一行，不能编。
- 每条能给反馈：“有用”或“打扰到我了”（设计里这两个动作叫 `useful` 和 `disturbing`）。

## 目标

给出这个读取接口的完整方案：返回什么、怎么排序、数据从哪来（对着现有代码）、“件数”怎么定义并可验证、“为什么”怎么取、反馈怎么记、要不要改表、要加哪些测试（含反向用例）、费用和上限。

## 约束（项目的硬规则）

- “理解意思”一律交给模型判断，不用关键词表、正则或写死的词典。
- 不改已经发给模型的内容（请求开头逐字节不变，只在末尾追加）；新加的后台模型调用要登记提示词、固定内容在前、会变的内容在后。
- 不写死：清单、阈值、模型列表、能力参数，能从系统动态获取的一律动态获取；上限要让主人看得见（页面上看得到，不是藏在代码里）。
- 不考虑旧数据兼容。
- 界面上给主人看的每个数字和判断词，要有可验证的定义和门槛；每个判断类功能要有反向验收（给不该命中的输入，期望为空）。
- 只用低价模型（按量付费只能用 DeepSeek V4.1 Flash 这类低价模型）；任何新的模型调用要说明每天最多几次、每次大概多少钱、到上限怎么办。
- 只有一台生产机（4 核、8GB 内存），不能为了这个接口加很重的常驻计算。
- 愿景里原则冲突时的顺序：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。
- 改表要说明，迁移号要连续排队。
- 提醒类通知锁屏上只显示标题一级，敏感内容只显示一句提示，正文由主人解锁后向服务器取。

## 已核对的事实（对着当前 main 的代码）

下面每条后面是文件路径和行号（相对仓库根目录），请自己再打开核对。

**接口形态**
- 设备接口表里已有 `GET threads`、`GET usage`、`POST feedback`、`POST approvals/respond`，没有“首页”这一项：`docs/execution/specs/2026-11-11-apple-device-body-design.md:198-229`。设备请求要设备签名；每个会改数据的请求带唯一编号去重。
- 现有网页走的是 `gateway.v2` 消息（例如 `approval.list`、`proactive.overview.read`、`memory.overview.read`、`decision.chain.read`、`presence.heartbeat`）：`packages/gateway-contracts/src/contracts-v2.ts:19-140`。

**各种条目现在有什么数据**
- 审批：`ApprovalRequest` 有 `status`（pending 等）、`expiresAt`、`deliveryState`（`deliverable` 或 `queued_no_ui`）、`runId`、`intentSnapshot`；治理版还有 `finalRisk`（low/medium/high/critical）：`packages/application/src/ports/authorization.ts:168-203`。意图里有 `reversible`、`recipients`、`threadId`、`modelClassification.reasonCode`、`deterministicFacts`：同文件 40-75 行。审批里没有一句人话的描述字段。
- 主动提醒（目前只有 Gmail 邮件来源）：`ProactiveInsight` 有 `result`（act、know、check）、`priority`（high、medium、low，可为空，由读邮件的模型给）、`dueAt`、`floorRaised`、`status`（open、replied、done、muted）：`packages/application/src/ports/proactive-checks.ts:5-7, 101-115`；服务读取并过滤“值得提醒”的在 `packages/application/src/services/proactive-overview.ts:117-160`。
- 每次主动检查的决策记录（表 `decision_ledger`）里 `inputs` 记了：命中的规则 `ruleIds/floorHits/ruleHits`、看到的邮件 `sourceIds`、用到的记忆 `usedMemoryIds/memoryByMail`：`packages/application/src/ports/proactive-checks.ts:235-256`、`packages/application/src/services/proactive-mail-check-service.ts:1642-1670`。网页已有“决策链”读取，每一段带“有记录/没有/没记录”三种状态：`packages/gateway-contracts/src/contracts-v2.ts:1259-1340`、`apps/agent-service/src/production-decision-chain.ts:71-140`。
- 记忆：`memory.overview.snapshot` 里有：等确认的敏感记忆 `pending`（含 `requestedAt`）、别的 agent 提议的记忆 `externalProposals`、到点的提醒 `reminders`、已替主人整理的 `tidyUps`（带 `undoable`）、做梦回看 `conversationReviews`（带 `undoable`）、导入批次 `imports`、`personSuggestions`；记忆本身有 `tentative`、`inference`、`importance`：`packages/gateway-contracts/src/contracts-v2.ts:1437-1605`。
- 决策记录的种类：`proactive`、`memory_candidate`、`consolidation`、`context_truncation`、`retrieval_degrade`、`external_read`、`rule_review`；`memory_candidate` 的结果含 `pending_approval`、`capture_gave_up`；`rule_review` 的结果是 `needs_review`：`packages/persistence-sqlite/src/migrations/0089_consolidation_hold.sql:20-70`。
- 运行（run）：状态有 `accepted`、`building_context`、`running`、`awaiting_approval`、`reconciling_external_result`、`completed`、`failed`、`cancelled`：`packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:149`。触发来源有 `user_message`、`schedule`、`external_event`：同文件 133 行。后台运行有 `listBackgroundRuns`：`packages/application/src/ports/run-lifecycle.ts:105`。网页推送已有“跑完的运行”这一种推送（`web_push_cursors.source = 'finished-runs'`）：`packages/persistence-sqlite/src/migrations/0058_web_push.sql`。
- Gmail 连接可能是 `needs_reconnect`：`packages/application/src/ports/proactive-checks.ts:137`；主动检查的结论里有 `needs_owner`：同文件 15 行。

**“要紧程度”现状**
- 有一个按 0 到 100 的 `urgency` 和 `confidence` 分级的 `AttentionPolicyService`（SILENT、INBOX、DIGEST、NOTIFY、INTERRUPT）：`packages/application/src/services/attention-policy-service.ts`。生产代码里没有任何地方构造它，只有测试和测试夹具构造（`grep "new AttentionPolicyService"` 只命中 `packages/testing`、`test/`、`apps/agent-service/test/`）。
- 审批的 `finalRisk` 是“这个动作有多危险”，不是“多紧急”。
- 各类条目没有一个可以互相比较的要紧程度。

**反馈现状**
- 决策记录的主人评价 `owner_rating` 只有 `useful`、`unneeded`、`missed` 三个值：`packages/persistence-sqlite/src/migrations/0089_consolidation_hold.sql:43`；决策信号 `decision_signals.signal` 只有 `opened`、`undone`、`replied`：`packages/persistence-sqlite/src/migrations/0080_decision_signals.sql:6`。代码里没有叫 `disturbing` 的东西，它只出现在设备端设计文档里，并写着“接进现有的决策信号”：`docs/execution/specs/2026-11-11-apple-device-body-design.md:508`。
- 审批没有对应的决策记录行。

**还没有的东西**
- 审批没有“一句话”描述；设计里“工具调用的一句话和图标由模型给（工具参数加两项）”那个 PR 还没有合进 main（未核实它的最终形态）。
- “听到的待确认记忆”依赖感知功能，感知记录还没合进 main。
- 现有网页没有“首页”这种跨类汇总的读取。


---

# 下面是线程的方案（请审核）

# 线程方案 v1：首页条目读取接口（在看到两个模型的独立方案之前先写好）

## 一句话

在应用层加一个“首页读取层”（只读，不存正文），把现有六类来源统一成一份带稳定编号的条目清单；排序由一个后台小模型调用给出相对顺序，结果存在内存和用量表里，读取时只做确定的算术（到期时间抬升）和校验（模型漏掉的条目补回、多出的丢掉）；件数和清单同源；“为什么”直接复用现有决策链；反馈映射到现有评价，不改表。设备接口加一项 `GET home`，同时加一个把动作分发给现有命令的 `POST home/act`。

## 条目种类和真实来源（我核对过的）

| 条目种类 | 来源 | 等主人定 | 有真实来源？ |
|---|---|---|---|
| 主动提醒（邮件） | `source_insights`，状态 open，经 `isReminderWorthy` 过滤（`proactive-overview.ts:117-160`） | 是 | 是 |
| 主动提醒（到点的记忆提醒） | `memory_reminders` 状态 scheduled 且 `remind_at` 已到 | 是 | 是 |
| 审批 | `authorization.listApprovals`：pending 且未过期且 `deliveryState = deliverable` | 是 | 是（一句话没有，见下） |
| 待确认的记忆 | `memory_approval_requests` pending、`external_memory_proposals` 待决 | 是 | 是；“听到的”依赖感知，没合入 |
| 替主人做好的 | `tidyUps`、`conversationReviews`（带 `undoable`） | 否 | 是，且是仅有的带真撤销的 |
| 正在做的 | `runs` 非终态且触发来源是 schedule/external_event，加 `listBackgroundRuns` | 否 | 是 |
| 出错要主人处理 | Gmail 连接 `needs_reconnect`、`rule_review` 的 `needs_review`、后台运行 failed | 是 | 是，但“重试”命令不存在 |

“没有真实来源就先不显示”的：设备动作做完的（日历、提醒事项、家居，设备批次才有）、感知听到的待确认记忆。

## 排序

1. 排序是语义判断（哪件对主人更要紧），按硬规则交给模型；不用关键词表。
2. 模型不在读取路径上：条目集合变化（新增、消失、关键字段变化）时，由一个后台任务把当前候选（编号、种类、一句话、期限、等了多久、命中规则、`priority`）发给低价模型，请它给出相对顺序（listwise）和 0 到 1000 的要紧度；结果按“候选集合摘要”缓存在内存，同一集合不重复调用。
3. 读取时：对缓存里的要紧度加上到期抬升（剩余时间 / 总时长越小越抬高，抬升的起点是一项可配置的设置，网页上看得到）；模型漏掉的条目用兜底比较补回，模型编出来的编号丢掉；任何条目都不会因为模型出错而消失。
4. 命中主人定的规则的（例如重要发件人 `floorRaised`）直接进最高档，模型只在档内排序（愿景 v2.2：规则是硬性设定，不是给模型的建议）。
5. 模型不可用或到当天上限：用兜底比较（等主人定的在前 → 期限近的在前 → 邮件模型给的 `priority` → 时间新的在前），并在响应里写 `rankBasis: "fallback"`，不假装是模型排的。
6. 敏感和受限的条目，只把种类、期限和“[敏感内容]”占位发给模型，沿用现有出口遮盖。
7. 费用：每次约 1500 到 3000 个 token，每天最多 N 次（配置，默认待定），用量记入模型用量表，用途 `home-rank`；仿 ADR 0237 的失败退避和从表里数用量的做法。

## 件数

`awaitingCount` = 条目里 `awaitsOwner = true` 的个数，计算用的是完整候选集，不受返回页数限制；响应里 `items` 必须包含全部 `awaitsOwner` 条目（硬上限 100，超了写 `truncated`）。不数“替主人做好的”“正在做的”、过期的审批、已 mute/done 的提醒。红点、Watch、Mac 菜单栏、APNs 的角标都调同一个函数。测试：不变式“件数 == items 里 awaitsOwner 的个数”，反向：只有做好的/正在做的时件数为 0；审批过期后掉出；同一份数据下 `GET home` 和角标函数返回同一个数。

## 为什么

直接复用决策链：来源（看到的邮件、来自哪个对话、哪条记忆）、规则（命中的规则、版本、是否还有效）、记忆（用到的记忆，带分级可见性）。三段沿用现有的“有记录 / 没有 / 没记录”状态；响应里只返回“有记录”的段，其余整段省略。
- 邮件提醒：全有（`inputs` 里有三样）。
- 审批：规则段给 `policyAuthorization` 和 `deterministicFacts`；来源给发起的对话；记忆段没有记录，不给。
- 待确认记忆：来源给原对话/原消息，规则给敏感分级策略，记忆段不给。
- 做好的（整理）：来源给被整理的记忆和依据，规则不给。

## 反馈

`useful` → 现有评价 `useful`；`disturbing` → 现有评价 `unneeded`。只对有决策记录的条目开放（邮件提醒、记忆候选、整理、规则复核）；审批和运行没有决策记录，响应里 `feedback.available = false`，客户端不显示那一行（不给的就不显示）。不改表。取舍留给 Andy：要不要为“打扰”单独加一个评价值（要改表）。

## 一句话

- 邮件提醒：读邮件的模型已给 `summary`。
- 记忆类：记忆文字本身。
- 审批：没有一句话。依赖“工具调用的一句话由模型给”的那个 PR（未合入）；合入前先用对话标题加固定模板的动作名，并在响应里标 `sentenceBasis`。
- 正在做：对话标题。

## 接口

- `GET /api/device/v1/home?locale=…&limit=…`，设备签名；响应带 `revision`（候选集合摘要），支持条件请求；下行事件流加一种 `home_changed` 事件（带 revision），设备收到就重新取，不轮询。
- `POST /api/device/v1/home/act {itemId, actionId, requestId}`：服务器按条目种类转给现有命令（`approval.respond`、`memory.approval.respond`、`memory.external.respond`、`memory.reminder.respond`、`proactive.insight.respond`、各种 undo），客户端只认动作编号。要主人在场的审批照常走挑战值。
- “撤销”：只对服务器真有撤销的（整理、做梦回看、导入、外来提议）给 `undo`；审批和拒绝没有服务器撤销，设计里的 6 秒“撤销”由客户端延迟 6 秒再提交实现。

## 表

不改表：排序缓存在内存，费用进现有用量表。只有“为‘打扰’加评价值”一条会改表，等 Andy 定。

## 测试

真实 SQLite 的集成测试，每类来源一正一反：条目出现；状态变了（审批通过、提醒 mute、记忆确认）条目消失且件数减一；过期、不可投递、已撤销的不出现。排序：模型返回漏编号、重复编号、编造编号、全空、超时，响应仍含全部条目；命中规则的永远在最高档；到期抬升；兜底标注。件数：同源不变式。为什么：没记录的段整段不返回。分级：敏感条目的一句话遮盖。提示词前缀：新增的后台调用登记在目录、固定在前，`check:prompt-prefix` 不变。

## 我认为的最大风险

1. 审批的“一句话”没有来源，直到另一个 PR 合入。
2. 排序模型的稳定性：同一集合多次调用顺序抖动。靠集合摘要缓存和把上一次顺序放进提示解决，未验证。
3. `disturbing` 与 `unneeded` 的语义是否等同。
4. 出错类的“重试”命令不存在，只能“打开对话”。

## 补充（苹果端设计线程 11-12 来信，来源：/mnt/project-files/ambient-sensing/pending-doc-edits.md 最后一节）

首页现在从上到下三样：找主人的事、接下来、一行感知状态。所以 `GET home` 响应除了条目和件数，还有：
1. `perception`：开着的感知项目（来自设备配置里的开关）、是否暂停（及恢复时间）、今天写入的感知记录条数。“今天”按主人所在时区，条数用和“感知到的”页同一个查询（`perception_records` 里 `active`、发生日落在今天），不得另算。感知记录和暂停还没合入 main，响应里整块省略（不给的就不显示），不返回 0。
2. `upcoming`（接下来）：现有真实来源是 `memory.overview` 的 `upcoming` 提醒（到期日在未来）；日历镜像在设备批次才有。这一块不参与排序，也不计入件数。

“为什么告诉你”就地展开，数据不变。

## 请重点挑战的几处（不限于这些）

1. 跨类排序交给后台模型调用（集合变化才调、结果缓存、读取时不调模型）是否必要？只用现有结构化字段做确定的比较是否已经够，或者更好？两种做法各自在什么真实情形下会排错？
2. 排序结果只放内存够不够，还是应该落表（重启后顺序不变、以后能拿“主人先处理了哪件”来校准排序）？
3. 反馈三种落法：映射到现有评价不改表；扩现有评价的可选值（重建表）；另加一张反馈表。哪一种不会让主人对同一件事评两次、数据又真的有人用？
4. 件数：出错要主人处理的算不算；只是“知道一下”的提醒算不算；`deliveryState = queued_no_ui` 的审批算不算、显不显示。
5. 动作：客户端只回传条目编号和动作编号、由服务器分发给现有命令，会不会丢掉审批需要的版本号和内容指纹核对？应该怎样绑定？
6. “正在做的”取“非终态且不是主人发消息触发的运行，加后台运行”，现有代码有没有现成的读取？一句话从哪来？
7. 到点的记忆提醒并入首页是否合适。
8. 感知状态那一块在感知没合入前整块省略，是否妥当。
