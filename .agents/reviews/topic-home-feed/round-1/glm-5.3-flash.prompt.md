你是独立的方案设计者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面只给了问题、目标和约束，没有给出任何人的方案；材料里如果提到某种做法，只作参考。先读代码弄清现状，再独立提出你认为最好的方案，不要假设已经有人想好了答案。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
输出格式：先列方案依赖的前提，每个前提附来源（文件:行或网址）和原话；再写方案本身、考虑过但不选的做法及原因、风险和反例、需要人拍板的取舍。把「读代码或来源证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 0d989adb521245a18eea3e8e26c55c27469b70c2。
问题、目标和约束：
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

## 请回答的事

1. 排序要不要用模型？用在哪一步、什么时候调用、花多少、失败怎么办？有没有不用模型也能做对的部分？
2. “替主人做好的”和“正在做的”两类，现在哪些数据可以作为真实来源？没有真实来源的先不显示，列清楚。
3. 接口形态（设备接口里加一项，还是复用现有网页消息，还是两者共用一个读取层）。
4. “等主人定的件数”的精确定义，以及怎么保证各端的数字永远一样、怎么测。
5. “为什么”三样各类条目分别能给出什么，哪些给不出。
6. 反馈 `useful` / `disturbing` 怎么落地，能不能不改表。
7. 要不要改表；要改哪些。
8. 测试清单（含反向用例）。
9. 你认为方案里最大的风险和还没核实的事。
