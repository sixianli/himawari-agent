<a id="home-feed-plan"></a>
# 方案：服务器端“首页条目”读取接口

状态：Andy 2026-11-12 19:47（JST）已同意。写于 2026-11-12；第 1 步已于 2026-11-13 合入 main（PR 446），合入的代码和本文不同的地方见[第 1 步合入后和本文不同的地方](#as-built)，那一节和前文冲突时以那一节和代码为准。第 2 到 4 步还没有代码。

<a id="contents"></a>
## 阅读导航

- [先回答两个问题](#two-questions)
- [前提和来源](#premises)
- [方案](#plan)
- [要 Andy 定的一件事](#decisions)
- [和设计稿不一样的地方](#design-gaps)
- [三方方案怎么取舍的](#comparison)
- [第 1 步合入后和本文不同的地方](#as-built)
- [还没核实的事](#unverified)

<a id="two-questions"></a>
## 先回答两个问题

**ChatGPT、Claude、苹果遇到同样的事怎么做，用户看到什么。**

- ChatGPT 的 Pulse（OpenAI 2025 年 9 月推出的主动推送功能）：每天给一组卡片，每张卡片能点拇指上下，另有“curate”让用户说想看什么；2026 年 6 月的更新说明写它并入了定时任务。来源：<https://openai.com/index/introducing-chatgpt-pulse/>、<https://help.openai.com/en/articles/6825453-chatgpt-release-notes>。这两页抓取被拒，以上是搜索结果摘要的转述，没有逐字核对。
- 苹果通知把“要不要打断人”分成四档（passive、active、time-sensitive、critical），由发通知的一方按事情本身定档，系统按档决定亮不亮屏、能不能穿过专注模式。搜索摘要里的原话：“The system adds the notification to the notification list without lighting up the screen or playing a sound.”（passive 一档）。来源：<https://developer.apple.com/documentation/usernotifications/unnotificationinterruptionlevel>。
- 苹果自己的“优先通知”是给每条通知单独判断要不要置顶，再按固定层级排。GLM 审核时引的原话：“Your iPhone can determine which notifications have priority over others. Priority notifications appear at the top of the stack”（<https://support.apple.com/guide/iphone/summarize-notifications-reduce-interruptions-iph1fbe7d2b9/ios>）。这一页我自己抓取时只拿到目录，这句没有逐字核对。
- Claude 的手机 App 没有跨类的“找你的事”首页（凭我对产品的了解，没有一手来源，未核实）。

共同点：要紧程度是一条一条判断、在事情产生的时候定下来并存住，再按固定层级排，读取时不重新判断；反馈只有“有用 / 没用”一对按钮。本方案照这个做。

**这是根因还是表面修补。** 是根因。现在服务器没有任何一处把“Himawari 主动找主人的事”汇在一起，也没有一个各类事情之间能比较的要紧程度（见前提 9、10）。只在客户端把几个现有读取拼起来再排，就是表面修补，而且三台设备会各算各的。

<a id="premises"></a>
## 前提和来源

行号对应提交 `0d989adb`。

1. 设备接口只有设计，main 上没有代码（在 `apps/`、`packages/` 的源码里搜索 `api/device/v1` 没有命中）。`docs/execution/plans/2026-11-11-apple-device-body-plan.md:47`：“服务器：设备配对、设备密钥验签、设备接口的骨架（配对、配置、对话列表、发消息、事件流）”列在第 1 批。设计里的接口表没有“首页”一项：`docs/execution/specs/2026-11-11-apple-device-body-design.md:223-229` 只有 `POST approvals/respond`、`POST feedback`、`GET usage`、`GET threads` 等。
2. 网页的读取走网关消息（`gateway.v2`，网页和服务器之间约定的一组消息类型），已有 `approval.list`、`proactive.overview.read`、`memory.overview.read`、`decision.chain.read`，没有跨类汇总的：`packages/gateway-contracts/src/contracts-v2.ts:22-141`。
3. 邮件提醒有模型给的档位和到期时间。`packages/application/src/ports/proactive-checks.ts:7`：`export type ProactivePriority = "high" | "medium" | "low";`，`:110`：`readonly priority: ProactivePriority | null;`。
4. 邮件提醒的“为什么”三样已经记在决策记录里。`packages/application/src/services/proactive-mail-check-service.ts:1654-1655`：`memoryIds: [...trace.memoryIds],`、`usedMemoryIds: [...trace.usedMemoryIds],`；同一处还记了 `ruleIds`、`sourceIds`、`floorHits`、`ruleHits`。
5. 网页已有“决策链”读取，每一段带四种状态。`packages/gateway-contracts/src/contracts-v2.ts:1252-1257`：`"recorded", "none", "not_recorded", "not_applicable"`。
6. 审批有过期时间和投递状态，没有一句人话。`packages/application/src/ports/authorization.ts:185`：`readonly deliveryState: "deliverable" | "queued_no_ui";`，`:187`：`readonly expiresAt: string;`。投递状态只在创建时写一次：`packages/application/src/services/action-policy-service.ts:506`：`deliveryState: options.uiAvailable ? "deliverable" : "queued_no_ui",`。
7. 回答审批必须带版本号和内容指纹：`packages/application/src/ports/authorization.ts:205-208` 的 `ResolveApprovalInput` 有 `expectedRevision`、`semanticSnapshotHash`。
8. 记忆总览里已有：等确认的敏感记忆 `pending`、别的 agent 提议的记忆 `externalProposals`、到点的提醒 `reminders`、接下来的提醒 `upcoming`、替主人整理的 `tidyUps`、做梦回看 `conversationReviews`，后两样带 `undoable`：`packages/gateway-contracts/src/contracts-v2.ts:1478-1522`、`:1572-1602`，`:1487`：`undoable: booleanValue,`。
9. 运行的触发来源有三种。`packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:133`：`source_type TEXT NOT NULL CHECK (source_type IN ('user_message', 'schedule', 'external_event')),`。现成的读取只有后台运行：`packages/application/src/ports/run-lifecycle.ts:105`：`listBackgroundRuns?(): Promise<readonly BackgroundRunRecord[]>;`。
10. 按 0 到 100 打分的 `AttentionPolicyService` 在生产里没有接线：`packages/application/src/services/attention-policy-service.ts:186` 定义了它，搜索 `new AttentionPolicyService` 只命中测试和测试夹具。
11. 主人评价只有三个值。`packages/persistence-sqlite/src/migrations/0089_consolidation_hold.sql:43`：`owner_rating TEXT CHECK (owner_rating IS NULL OR owner_rating IN ('useful', 'unneeded', 'missed')),`。决策信号只有三个值：`packages/persistence-sqlite/src/migrations/0080_decision_signals.sql:6`：`signal TEXT NOT NULL CHECK (signal IN ('opened', 'undone', 'replied')),`。`disturbing` 只出现在设计文档里。
12. 网页推送的角标现在是另一套算法。`apps/agent-service/src/production-web-push.ts:306`：`await this.#deliver(now, approvals, reminders.length + approvals.length);`，提醒只取到点 6 小时内的（`:19`：`const REMINDER_WINDOW_MS = 6 * 3_600_000;`）。
13. 模型用量表的“用途”是写死在表约束里的清单，加新用途要重建表：`packages/application/src/ports/model-usage.ts:3-13`（`:11`：`"review-prereview",`）；上一次加用途是迁移 0091。
14. 预评的先例：模型判断单独存一张不许改的表，每天有次数上限，默认 50。`packages/application/src/services/review-prereview.ts:43`：`dailyLimit: 50,`；`docs/adr/0237-model-pre-rates-waiting-decisions.md` 决定 1、3。
15. 原则顺序。`docs/product-vision.md:55`：“原则冲突时，按序优先：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。”
16. 设计要求（仓库外的文件，核对代码说法的模型读不到；2026-11-12 我对着原文逐字核过，三句分别在第 99、108、150 行）：`/mnt/project-files/ambient-sensing/pending-doc-edits.md` 2026-11-12 的“首页整页重想”一节：“首屏只放 Himawari 主动找主人的事，顺序由服务器按要紧程度给，客户端不自己排。”“‘今天’页签上的红点数字 = 等主人定的件数（提醒、审批、待确认记忆），不数‘替你做好的’和‘正在做的’。”最后一节：“首页从上到下现在是三样：找你的事、接下来、一行感知状态。”

<a id="plan"></a>
## 方案

<a id="shape"></a>
### 1. 形态：一个读取层，两个薄入口

- 应用层新加一个只读的“首页读取层”。它从现有各来源读出候选，统一成同一种条目，排序，算件数。读取时不调模型、不写库。
- 入口一：网关消息 `home.read` / `home.snapshot`。现在就能做、能测，网页以后要用也现成。
- 入口二：设备接口 `GET /api/device/v1/home`。等第 1 批设备接口（PR 404）合入后接上，只做验签和转发。
- 三台设备和网页拿到的是同一份结果。条目变了怎么通知设备：照审批订阅现在的做法（`apps/agent-service/src/production-approval-gateway.ts:124-165`，每秒算一次变化标记，变了就发 `snapshot_required`），事件流里带上首页的版本号，设备收到再取。不做“没变就返回 304”，因为快到期的事会随时间改变顺序。

<a id="response"></a>
### 2. 返回什么

- `items`：排好序的条目。每条有：
  - `key`：稳定编号，带种类前缀（例如 `approval:…`、`insight:…`、`memory_request:…`），不同来源不会撞。
  - `kind`：`heads_up`（主动提醒）、`approval`（审批）、`memory_confirm`（待确认的记忆）、`done`（替主人做好的）、`running`（正在做的）、`problem`（出错）。
  - `awaitsOwner`：是不是在等主人定。
  - `sentence` 和 `sentenceBasis`：一句话，以及它是哪来的（`recorded` 已有记录、`model` 模型写的、`none` 还没有）。是 `none` 时不给 `sentence`，客户端显示固定的“有一件事等你点头”，不把机器用的动作名给主人看。
  - `target`：点进去去哪（哪个对话、哪条记忆、哪封邮件的原信链接）。
  - `progress`：只有正在做的条目有，和对话里过程行同一句“正在做什么”加图标名，取自同一条记录；过程行那个 PR 合入前不给这个字段。
  - `source`：来源说明用的结构化字段（哪封邮件、哪个对话、哪个 agent、什么时候）。
  - `deadline`：到期时间，没有就不给。
  - `actions`：主人能做的动作，每个带 `action`（动作名）、`label`（按钮文字）、`labelBasis`（按钮文字是哪来的：`catalog` 登记的通用文字、`model` 模型写的）、`polarity`（`positive` 肯定、`negative` 否定）、`ownerPresence`（要不要主人本人在场）、`reviewLabel`（只有要本人在场时有，进去看内容的那段通用文字）、`binding`（绑定串，见[动作](#actions)）。一条条目可以有不止两个动作。`action`、`label`、`ownerPresence` 三个名字照第 4 批推送线程自己报的动作字段取（它的代码还没合入 main，我没读过，见[还没核实的事](#unverified)），推送以后加 `labelBasis` 和 `polarity` 也用这两个名字。
  - `undo`：只有服务器真能撤销时才给。
  - `why`：三段，各带状态（见[为什么](#why)）。
  - `feedback`：能不能评价、现在评的是什么；不能评就不给这个字段。
  - `rank`：这条为什么排在这（`rule` 命中主人规则、`deadline` 快到期、`model` 模型打分、`unscored` 还没打分）。
  - `dataClassification`：数据分级。
- `awaitingCount`：等主人定的件数。
- `upcoming`：接下来（见[感知状态和接下来](#perception)）。
- `perception`：感知状态一行，可选。
- `revision`、`generatedAt`。

<a id="sources"></a>
### 3. 各类条目从哪来

| 种类 | 真实来源 | 等主人定 | 一句话 |
| --- | --- | --- | --- |
| 主动提醒：邮件 | `source_insights`，状态 open，经现有的 `isReminderWorthy` 过滤 | 是 | 读邮件的模型已写好的 `summary` |
| 主动提醒：到点的记忆提醒 | 记忆总览的 `reminders` | 是 | 记忆文字 |
| 审批 | 现有审批列表里 pending 且没过期的；`queued_no_ui` 的也显示也计数（前提 6：这个状态只表示创建时没有界面，之后不会更新） | 是 | 现在没有，见下 |
| 待确认的记忆 | 记忆总览的 `pending` 和 `externalProposals` | 是 | 记忆文字 |
| 替主人做好的 | 记忆总览的 `tidyUps`、`conversationReviews`，最近一段时间内的 | 否 | 记忆文字 |
| 正在做的 | 后台运行（`listBackgroundRuns`）；再加一个新的只读查询：没结束、且不是主人发消息触发的运行（前提 9） | 否 | 对话标题 |
| 出错 | Gmail 连接要重新授权；规则要主人复核（决策记录 `rule_review` 的 `needs_review`）；后台运行失败 | 前两样是，运行失败不是 | 前两样是固定的两句（登记在文案里，三种语言）；运行失败用对话标题 |

现在没有真实来源、先不显示的：设备上替主人做完的事（日历、提醒事项、家居，设备批次才有表）；感知“听到的”待确认记忆（感知的记录和读取还没合入，main 上只有两个设置键，`packages/gateway-contracts/src/contracts-v2.ts:515`、`:520`）；普通运行跑完的结果（`runs` 表只有状态，没有“做成了什么”的字段，`packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:141-153`）。

审批的一句话：审批记录里只有机器字段。办法是在给新条目打分的那次模型调用里（见下一节）顺带让模型按审批的结构化字段写一句，存起来，标 `sentenceBasis: "model"`；高风险审批点下去仍然先显示完整内容再确认，一句话只用于列表。“过程行的一句话由模型给”那个 PR 合入后，改用它的那一句。模型那句还没写好或模型不可用时，标 `none`，不给一句话，也不拼模板句。

审批的肯定按钮文字（苹果端设计线程 2026-11-12 提的）：只写“同意”，主人看不出点下去会发生什么。所以同一次调用里让模型顺带写一个肯定按钮的短文字，说清点下去会做什么（例如“发出去”“改到 9:40”），和那一句话存在同一行，不重写；通知、Watch 和首页显示的是同一份。不增加调用次数。只对审批这样做，否定按钮和其余种类的按钮一律用登记的通用文字。几条守卫：

- 这段文字和那一句话都跟着审批的内容指纹存。审批内容变了（指纹不同），旧的那份不再显示，退回通用的“同意”和 `sentenceBasis: "none"`，等重新写好。否则按钮上写的可能不是现在点下去会做的事，这直接关系到主人是不是知情地点头（用户主权）。
- 长度上限是设置，按语言分别定。设计线程给的默认值：中文 6 个字，日文 8 个字，英文 16 个字符（含空格）。模型写的超过上限、为空、或者和否定按钮的通用文字相同，服务器不截断，直接退回通用的“同意”。
- 模型没写、不可用、到每天上限、按出口规则这条审批的内容不能发给模型：都退回通用的“同意”。
- 要主人本人在场的审批：列表、锁屏通知、Watch 上的肯定按钮点了是进 App 看完整内容，不是直接执行，所以这些地方固定显示登记的通用文字“看内容再定”，不用模型文字；进 App 看完内容后的那个确认按钮才用模型写的文字。响应里这种动作同时给两段文字（进去看的那段、确认的那段），各端不各写。
- 推送不等这次调用（设计线程定的：提醒要按时到）。推送发出时模型文字还没写好，锁屏按钮就用通用文字；已经送达的通知之后不改字，主人打开 App 看到的是写好的那一份。两处文字可以不同，意思必须一致，所以审批的通用文字只有“同意”“不同意”两个，不再有第三种说法。
- 读取层另给一个方法：按审批编号和内容指纹取那一句话和肯定按钮文字，没有就返回空。推送（第 4 批）调它，没取到就用通用文字，不自己另存一份。
- 以后那一句话改用过程行 PR 的那一句时，按钮文字仍由这次调用写。
- 没法由程序保证的一点：模型写的按钮文字说的就是这个动作。高风险审批点下去会先显示完整内容再确认，这层还在；低风险审批是一下点完的，主人看到的只有模型写的一句话和按钮。所以上线前要用真实审批跑一小批，逐条看按钮文字和实际动作对不对得上；对不上的比例高，就先不开这一项，只用通用的“同意”。

<a id="ranking"></a>
### 4. 排序

要不要用模型：要，但只用在一处，而且不在读取的时候。

- 哪件事对主人更要紧，是理解意思的判断，现有字段答不了：审批的 `finalRisk` 说的是动作多危险，不是多急；首页上的记忆类条目（待确认的、别的 agent 提议的、到点的提醒）自己没有档位（前提 3、6、8、10）。存下来的记忆有一个 `importance`（0 到 1000，`packages/gateway-contracts/src/contracts-v2.ts:1461`；库里默认 500，`packages/persistence-sqlite/src/migrations/0052_memory_engine.sql:2`），说的是这条记忆本身有多重要，主人画像在用它排序，不是“这件事现在多急”；记忆总览里的提醒只有提醒编号，没有带这个值（`:1504-1511`）；编码时如果提醒能对应到一条存下来的记忆，就把那条记忆的这个值作为一项输入给打分的模型，不直接拿来排。用“审批排第一档、记忆排第三档”这种固定的表来排，就是写死。
- 做法：等主人定的条目**新出现时**，后台调一次低价模型，给它打一个 0 到 1000 的要紧度。发给模型的内容：固定的打分说明在前；接着是当前还开着的条目和它们已有的分数（按编号排序），当参照；最后是新条目和当前时间。已经打过分的条目不重打，所以顺序不会来回跳。几条同时出现合成一次调用。
- 分数存进新表 `home_item_scores`（只增不改，记模型、提示词版本、条目文字摘要、费用），重启不丢。条目文字变了（摘要不同）才重打。
- 模型排得准不准要量，不默认它准：周报加一个数，“模型排在最前的那件，是不是主人最先处理的”，定义是一周里“首页同时有两件以上等主人定的事”的那些时刻中，主人先处理的正是排第一那件的比例；样本不到门槛不给比例。这个数长期低，就说明该改打分说明或退回只按到期时间排。
- 读取时的顺序，全部是确定的比较，同样的数据永远得到同样的顺序：
  1. 命中主人定的规则的（例如重要发件人，现有的 `floorRaised`）最前。规则是硬性设定，不交给模型权衡。
  2. 快到期的：离 `deadline` 不到“提前量”的。提前量是一项设置，页面上看得到、能改。
  3. 其余等主人定的，按模型分数从高到低。还没打分的排在这一档最前，标 `unscored`：一件等主人定的事，宁可早看到。
  4. 不等主人定的（做好的、正在做的、运行失败），按时间新的在前。
  5. 并列时依次比到期时间、创建时间、编号。
- 模型出错、超时、到每天上限：条目照常返回，只是标 `unscored`。任何条目都不会因为模型出问题而消失或被藏起来。
- 敏感内容：每类来源用它自己已有的分级（审批用意图里的分级，记忆用记忆的分级）。按现有出口规则不能发给这个模型的，只发种类和到期时间；`restricted` 的一律不发。这次调用登记进提示词目录和出口遮盖检查。

<a id="count"></a>
### 5. 等主人定的件数

- 定义：`awaitsOwner` 为真的条目数。具体是：状态 open 的邮件提醒、到点且没处理的记忆提醒、pending 且没过期的审批、等确认的记忆、别的 agent 提议的记忆、Gmail 要重新授权、规则要复核。不数做好的、正在做的、运行失败。
- 一个函数算，所有地方用：首页响应、页签红点、Watch、Mac 菜单栏、苹果推送角标，以及现有网页推送的角标（前提 12 那一行改成调这个函数；网页角标的数会因此变大，因为以前不数邮件提醒和待确认记忆）。
- 件数和清单分开保证：等主人定的条目全部返回，不分页；只有不等主人定的条目才按时间窗口截取。等主人定的超过上限（设置，页面可见）时，件数仍是真实的数，响应里标明清单被截断。
- 验证：同一份数据下，件数等于清单里 `awaitsOwner` 的条数；反向：只有做好的和正在做的时件数是 0；审批过期后件数减一；提醒点了“完成”后件数减一。

<a id="why"></a>
### 6. 为什么告诉你

三段都带状态，沿用决策链的四种（前提 5）；客户端只在 `recorded` 时显示那一行。服务器不编。邮件提醒直接复用现有的决策链读取；其余种类没有决策链可用，是按下表从各自的记录里新拼的，每个字段都要写校验。

| 种类 | 看到的来源 | 你的规则 | 用到的记忆 |
| --- | --- | --- | --- |
| 邮件提醒 | 有：发件人、主题、原信 | 有：命中的规则和版本 | 有：用到的记忆 |
| 到点的记忆提醒 | 有：那条记忆和它出自的对话 | 没有 | 就是那条记忆 |
| 审批 | 有：发起它的对话 | 治理版审批有策略依据；这不是“你定的规则”，用单独的标签，不混进“你的规则” | 没有记录 |
| 待确认的记忆 | 敏感记忆有原对话；别的 agent 提议的只有 agent 名和它给的来源键 | 没有记录 | 没有 |
| 做好的、正在做的、出错 | 有：对应的记忆、对话或连接 | 没有 | 没有 |

也就是说，三行齐全的现在只有邮件提醒。其余种类想要三行，得先让它们产生时把依据记下来，那是另一件事，不在这个读取接口里补。

<a id="feedback"></a>
### 7. 反馈

- 界面上是一句“这次告诉你，有用吗”加一对拇指。拇指朝下的意思是“这次不该告诉我”，和现有评价里的 `unneeded` 是同一个意思：校准代码把“提醒了且评 `unneeded`”算作“不该提醒”（`packages/calibration/src/index.ts:431`）。
- 做法：设备发来的 `useful` 记成现有评价 `useful`，`disturbing` 记成 `unneeded`，走现有的评价命令。不改表。主人在手机上评过的，网页“每天打分”里就是已评，不用评第二遍。
- 只有对应着决策记录的条目能评（邮件提醒、记忆候选、整理）。审批、运行、出错没有决策记录，响应里不给 `feedback`，界面不显示那一行。
- 两个模型都不赞成这样映射（GLM 主张给评价加一个值，DeepSeek 主张另加一张表，理由都是“打扰”和“不需要”以后可能想分开看）。没采纳：界面上只有一个朝下的拇指，分不出这两种意思；另存一处的话，同一件事主人要评两遍，或者那份数据没人用。苹果端设计线程 2026-11-12 定了按映射做。

<a id="actions"></a>
### 8. 动作和撤销

- 设备接口加 `POST /api/device/v1/home/act`：传条目编号、动作名、绑定串、请求编号。服务器按这个动作的绑定串转给现有命令（`approval.respond`、`memory.approval.respond`、`memory.external.respond`、`memory.reminder.respond`、`proactive.insight.respond`、`memory.tidy.undo`、`memory.conversationReview.undo`、`memory.rule.respond`）。转给哪个命令、对着哪条记录，由绑定串决定，不由条目的种类决定；这样一条条目里可以放对着不同记录的动作（见下面“提醒带一个提议的动作”）。设备端不用认识八种命令，设备接口的白名单也只多一项。
- 绑定串是读取时服务器给的，客户端原样传回。审批的绑定串里是审批编号、版本号、内容指纹（前提 7）；服务器重新读审批，三样对不上就拒绝并让设备刷新。动作名必须在这条条目允许的动作里。要主人本人在场的审批，照设计走挑战值和确认密钥，这个接口不放宽。
- 现在每类条目实际有的动作（都来自现有命令，没有“改到 9:40”这种跟具体事情有关的动作，具体内容在一句话里）：

  | 种类 | 动作 | 现有命令 |
  | --- | --- | --- |
  | 邮件提醒 | 完成（肯定）、不再提醒（否定） | `proactive.insight.respond` 的 `done`、`mute` |
  | 到点的记忆提醒 | 知道了（肯定）、稍后再提醒、取消这个提醒（否定） | `memory.reminder.respond` 的 `dismiss`、`snooze`、`cancel` |
  | 审批 | 同意（肯定；按钮文字优先用模型写的那份，见[各类条目从哪来](#sources)）、不同意（否定） | `approval.respond` |
  | 敏感记忆待确认 | 记下（肯定）、不记（否定）；改了再记是带文字的，只在 App 里做 | `memory.approval.respond` 的 `approved`、`rejected`、`edited` |
  | 别的 agent 提议的记忆 | 记下（肯定）、不记（否定） | `memory.external.respond` 的 `keep`、`reject` |
  | 规则要复核 | 仍然有效（肯定）、撤掉这条规则（否定） | `memory.rule.respond` 的 `reconfirm`、`undo` |
  | Gmail 要重新授权 | 去重新授权（打开授权页，不是服务器命令） | 现有的 Google 授权入口 |
  | 做好的 | 只有撤销 | `memory.tidy.undo`、`memory.conversationReview.undo` |
  | 正在做的、运行失败 | 没有动作，点进去看对话 | 无 |

  按钮文字：这些动作都是通用的，文字按动作名登记在一处（三种语言），服务器在响应里给出，各端不各写一份。唯一的例外是审批的肯定按钮。
- Himawari 主动提议下一步（现在还没有，留好位置）：设计稿首屏最大那件事是“田中把会改到 15:00，出门提醒要跟着改吗”，带两个按钮。现在主人对一条邮件提醒能做的只有四样：完成、不再提醒、恢复、评价（`packages/gateway-contracts/src/contracts-v2.ts:674` 的 `done`、`mute`、`reopen`、`rate`），没有一样是执行一件具体的事。这件事有单独的方案：`/mnt/project-files/ambient-sensing/proposed-actions-plan.md`（文件里写着 Andy 2026-11-12 21:23 JST 已同意；它的“审核后改的地方”一节优先）。下面是首页这一层怎么接，和那份方案冲突时以那份为准。它引的 PR 436、PR 444 都还没合入，我没读过那两个分支。
  - 提议存在“四块功能”任务 1 的提议箱里（表 `owner_proposals`，PR 436），不落成审批，也不另起命令：采纳、不要、撤销用提议箱的同一个命令。读取层接得上，因为动作是按绑定串转发的，不要求那条记录是审批。绑定串拆出来是提议编号、版本号、内容指纹，转发时另带请求编号。
  - 挂在邮件提醒上的提议不单独成条。读取层看到一条提醒有开着的提议，就合成一条条目：编号、“为什么”、评价都是提醒的；一句话用提议的问句（`sentenceBasis: "model"`）；`actions` 先放提议的肯定和否定，后面可以再跟提醒自己的“不再提醒”。件数只数一次，这条要有测试。
  - 单独冒出来的提议自己成一条，条目种类加一个值 `proposal`，带过期时间。它不算等主人定的事（`awaitsOwner` 为假）：不进件数，不打分，排在所有等主人定的条目之后，和做好的、正在做的按时间新的在前混排（苹果端设计线程定的）。过期或主人点了“不用”就从首页收走，不留“已过期”的行。
  - 按钮文字：肯定按钮由模型在提出提议时写（`labelBasis: "model"`），守和审批一样的字数上限，超了退回登记的“好”；否定按钮是登记的“不用”。由外部内容引出的“去办一件事”，肯定按钮固定是“看内容再定”。所以 `labelBasis` 仍只有 `catalog` 和 `model` 两个值，我之前为第 1 版加的 `computed` 作废。确定动作另有一行程序按参数生成的明细，凡是显示按钮的地方都带着它；首页条目为此加一个可选的明细字段，接的时候和那份方案对名字。
  - `home/act` 转发时要能带两样凭据：近期认证（要主人本人在场的动作），和“看过全文”的短期凭据（外部内容引出的“去办一件事”，客户端打开全文时向服务器换，绑着提议编号、版本号和指纹）。服务器验过才执行；这个接口不放宽。
  - 同意“去办一件事”后，提议条目收走和那次运行开始在同一个事务里，运行记成不是主人消息触发的，所以它会出现在“正在做的”里，不会同时有“提议”和“在办”两条。没有撤销。
  - 确定动作执行当场的结果和成功后的撤销入口在 `home/act` 的返回里给。失败时条目留着，条目加一个可选的 `outcome`（上一次动作的结果和原因文字）。撤销以后提议不再出现，挂着的邮件提醒重新打开。
  - 推送要加“提议”这一种，角标不数它。
  - 邮件的来源版本是 Gmail 消息编号，最长 256，首页合约里凡是装它的地方不用最长 128 的一般标识串。
  - 接进来时合约要加的值（条目种类 `proposal`、可选的 `outcome` 和明细字段）都是只增不改；合约里枚举是严格校验的，所以产生它的地方和每个读它的地方（网页、苹果端、推送）要在同一次改动里一起认。
  - 绑定串的长度：审批编号、版本号、内容指纹拼在一起可能超过合约里一般标识串的长度上限（那个方案的审核指出上限是 128）。所以 `binding` 在合约里用单独的、够长的字符串类型，由服务器生成和拆开，设备原样传回；对内转给命令时拆成分开的字段。
- 撤销只给服务器真能撤的。查过的结果：
  - 整理、做梦回看：能撤（各有撤销命令）。
  - 邮件提醒点了完成或不再提醒：能撤，现有命令有 `reopen`，把状态改回 open（`apps/agent-service/src/production-proactive.ts:652`）。
  - 别的 agent 提议的记忆点了记下或不记：能撤，现有 `memory.external.undo` 按批撤回。
  - 敏感记忆点了不记、记忆提醒点了知道了或取消：现在没有恢复的命令，不给撤销。要给得另加代码，不在这次读取接口里。
  - 审批的同意和拒绝：撤不了。
  - 不给撤销的，定完只出一句结果提示，客户端不做延迟提交。

<a id="perception"></a>
### 9. 感知状态和接下来

- `perception`：原样嵌入第 3 批（感知记录和上传）线程做的那个读取方法的返回值，首页不另算。已和那个线程对过：“今天记了 N 件”和“感知到的”页今天一栏出自同一个查询。那个方法还没合入时，整块不给，不返回 0。
  - 第 3 批线程 2026-11-12 报来的读法（草稿 PR 444，分支 `claude/project-thread-jmjzyz`，还没复核、没合入，我没读过它的代码；字段在它复核时可能改，第 4 步编码时对着合入后的代码核）：网关查询 `perception.status.read`，返回 `perception.status.snapshot`，服务端是 `PerceptionService.status`。首页用到的字段：`state`（`sensing`、`paused`、`off`）、`pausedUntil`（没暂停时为空）、`senses`（开着的感知，固定顺序）、`day`（主人时区的日期）、`todayCount`（今天记了几件）。它还返回 `availableSenses`、`retention`、`pauseMaximumSeconds`、`revision`、`generatedAt`，首页原样带上，不挑字段、不改名。
  - 它报的三条保证：这个读取不写任何表；`todayCount` 和“感知到的”页今天一栏走同一个查询，有测试断言两者相等；`senses` 的顺序固定。首页的测试只需要再加一条：首页里的 `perception` 和直接调那个读取得到的逐字段相等。
- `upcoming`：现在的真实来源是记忆总览的 `upcoming`（到期日在未来的提醒）。日历要等设备批次。不参与排序，不计入件数。

<a id="tables"></a>
### 10. 改表

要改，一个迁移里两件事，排进改表队列：

1. 新表 `home_item_scores`：条目编号、分数、模型写的一句话的引用、模型写的肯定按钮文字（只有审批有）、模型、提示词版本、条目文字摘要（审批用它的内容指纹）、费用、时间。只增不改，条目来源被删时跟着删。
2. 重建 `model_usage_observations`，给“用途”加一个 `home-urgency`（前提 13）。

<a id="cost"></a>
### 11. 费用和上限

- 新增模型调用只有打分这一种，用低价模型，经生产现有的模型路由（先用套餐内的额度）。
- 每次大约 2000 到 3000 个输入 token、200 个输出 token。按复核脚本里记的 DeepSeek V4.1 Flash 按量单价（每百万输入 0.15 美元、输出 0.6 美元，`scripts/model-review/gateway.json:27`）算，一次约 0.0005 美元。
- 每天最多次数是设置，默认 50 次（和预评一样，前提 14），用量页看得到已用和上限。到上限后新条目标 `unscored`，首页照常。失败的条目 24 小时内不重试。
- 读取本身是几次数据库读取，没有常驻计算。各来源读取条数、参照条目数、等主人定的条目上限、“做好的”时间窗口、快到期提前量，都是设置。

<a id="tests"></a>
### 12. 测试

用真实 SQLite，每条守卫都有“去掉它就失败”的反向用例。

- 每类来源：出现；处理后消失且件数减一；过期、已撤销的不出现。`queued_no_ui` 的审批出现并计数。
- 件数：等于清单里等主人定的条数；网页推送角标和首页是同一个数；等主人定的超过上限时件数仍是真实的数。
- 排序：数据库插入顺序打乱，结果不变；命中规则的永远最前；快到期的升上来；模型返回漏编号、重复、编造编号、空、超时，条目一条不少；重启后顺序不变。
- 打分调用：同一条目不重复打分；到每天上限不再调用；发给模型的请求里没有不许发的原文（抓请求体核对）；参照条目按编号排序，同样的输入发出同样的字节。提示词登记进目录（`npm run check:prompt-catalog` 守着），调用出口登记进出口遮盖检查（`npm run check:egress-redaction` 守着）；`npm run check:prompt-prefix` 只跑对话请求的那一个测试文件（`scripts/check-prompt-prefix.mjs:9`：`packages/runtime-pi/test/prompt-prefix.compat.test.ts`），管不到这次新调用。
- 为什么：没有记录的段不显示；审批的策略依据不出现在“你的规则”里。
- 动作：旧版本号、改过内容、显示之后点之前刚好过期、别的条目的动作名、别人的条目编号、重复的请求编号，全部拒绝或只生效一次；要本人在场的审批没有挑战值不能过。
- 审批的肯定按钮文字：模型写了就用它并标 `model`；模型没写、写空、超过上限、和否定按钮文字相同，都退回通用的“同意”并标 `catalog`；上限按语言各测一条刚好和超一个字的；要本人在场的审批，进去看的那段文字永远是通用的“看内容再定”；审批内容指纹变了，旧文字不再出现；其余种类和所有否定按钮永远是通用文字；首页和推送读到的是同一份。
- 正在做的：还没有标题的后台运行也能显示，不出现空的一句话。
- 反馈：`disturbing` 落成 `unneeded`；没有决策记录的条目评价被拒。
- 新值两端一致：`kind`、`rank`、`sentenceBasis`、按钮文字的来源、用途 `home-urgency`、事件里的首页版本号，各有一条“合约和表约束对不上就失败”的检查。

<a id="order"></a>
### 13. 先后顺序

1. 读取层、网关入口、件数函数、网页推送角标改用它。不依赖设备接口，不改表，可以先做；这时全部条目是 `unscored`，按到期时间和创建时间排。
2. 打分表、打分调用、审批的一句话和肯定按钮文字。要改表，排队。
3. 设备入口 `GET home` 和 `home/act`。等 PR 404。动作的 `binding` 字段在这一步才加（第 1 步的合约里动作没有它，网页仍用各自的现有命令）；加的时候用单独的够长的字符串类型，并用真实长度的审批编号和内容指纹测一条能过合约校验的。
4. 感知状态一行。等第 3 批。

<a id="decisions"></a>
## 要 Andy 定的一件事

Andy 2026-11-12 19:47（JST）定了：按建议，用模型。

**排序用不用模型。** 建议用（上面第 4 节）：每天最多 50 次、约 0.03 美元以内。DeepSeek 的独立方案主张完全不用模型，只按“有没有到期时间、危险档位、时间”排；它自己也写了这样会把“7 天后才过期的高危审批”和“1 小时后到期的邮件”排错其中一种。GLM 审核时主张模型打分默认关、量过再开；没采纳的理由见[三方方案怎么取舍的](#comparison)。

另外两件原本列在这里，苹果端设计线程 2026-11-12 按 Andy 给它的定位（界面和体验由它整体拿主意）定了：

- 拇指朝下记成现有的 `unneeded`，不改表（第 7 节）。
- 红点的定义是“主人不出手就不会往前走的事”：Gmail 要重新授权、规则要复核、到点的记忆提醒都算，后台运行失败不算（第 5 节）。设计文档由设计线程改。

<a id="design-gaps"></a>
## 和设计稿不一样的地方

苹果端设计线程 2026-11-12 已逐条定了界面怎么跟：

- “为什么”只显示有记录的段，有几段显示几行；一段都没有时那行小字不能展开。审批的策略依据用单独的标签“为什么要你点头”，不放进“你的规则”。
- “这次告诉你，有用吗”一行，响应里有 `feedback` 才显示。
- 只有响应里给了 `undo` 的才出“撤销”，其余定完只出一句结果提示。
- 审批的一句话还没有时，显示固定的“有一件事等你点头”，下面照常写是哪个对话发起的。
- 没有真实来源的三样先不显示，不留占位。
- 通知、Watch、Mac 菜单栏、小组件都读这同一份；第 4 批（推送服务器部分）线程会来对条目和按钮文字。
- 审批的肯定按钮由模型写一个说清会做什么的短文字，没有时退回“同意”（第 3 节）。
- 首屏那种“提醒带一个提议的动作”现在服务器还提不出来，原型里那一条要等另一个方案；接口结构已留好位置（第 8 节）。

<a id="comparison"></a>
## 三方方案怎么取舍的

原始记录在 `.agents/reviews/topic-home-feed/`。

| 问题 | 我原来的方案 | GLM | DeepSeek | 定稿 |
| --- | --- | --- | --- | --- |
| 排序 | 集合变了就让模型整体重排，结果放内存 | 独立方案同左、结果落表；审核时改口：第一版不用模型，模型排序默认关、量过一致率再开 | 不用模型 | 新条目出现时打一次分并落表，旧条目不重打。采纳了两份审核都指出的：整体重排会让顺序来回跳，放内存重启后顺序会变，小模型做整体重排没有证据说它排得好。没采纳“默认关”：打分只影响先后，不藏任何条目，关着就没有数据可量；改成默认开、周报里量它准不准 |
| 反馈 | 映射到现有评价 | 给评价加值 | 另加一张表 | 映射，设计线程定 |
| 动作 | 只传条目编号和动作名 | 没提 | 必须带版本号和内容指纹 | 采纳 DeepSeek：加绑定串 |
| `queued_no_ui` 的审批 | 不显示 | 没提 | 显示并计数 | 采纳 DeepSeek，我原来的判断是错的 |
| 件数和分页 | 件数等于返回的条数 | 同左 | 分页前算 | 采纳 DeepSeek：等主人定的不分页；并把网页推送角标一起改 |
| 模型用量 | 记成新用途，不改表 | 新配置键 | 没有模型调用 | DeepSeek 审核指出新用途过不了表约束，定稿改为要重建那张表 |
| 审批的 6 秒撤销 | 客户端延迟提交 | 没提 | 不该叫撤销 | 采纳 DeepSeek：不做 |
| 到点的记忆提醒 | 并入首页 | 并入 | 先不并入 | 并入：它本来就是 Himawari 主动提醒主人的事，网页推送现在就在推 |

<a id="as-built"></a>
## 第 1 步合入后和本文不同的地方

第 1 步（读取层、网关入口、件数函数、网页推送角标）在 PR 446 合入，合并提交 `bb3aa621`。下面每条我都对着这个提交的代码看过，行号是这个提交的。后面几步照代码写，不照前文。

- `rank` 的取值是 `rule`、`deadline`、`unscored`、`recency`（`packages/gateway-contracts/src/contracts-v2.ts:656`）。`recency` 是前文没有的，给不等主人定的条目用，表示按时间新旧排。`model` 第 2 步加。
- `sentenceBasis` 的取值是 `recorded`、`catalog`、`none`（`:655`）。`catalog` 是前文没有的，表示登记的固定文字（例如 Gmail 要重新授权那一句）。`model` 第 2 步加。
- `labelBasis` 现在只有 `catalog`（`:702`），`model` 第 2 步加。`polarity` 多一个 `neutral`（`:703`），给“稍后再提醒”这种不算肯定也不算否定的动作。
- 查询要带语言（`:706`），固定文字和按钮文字按它给。
- 响应多一个 `incompleteSources`（`:750`）：某个来源读失败，或者有条目的编号过不了合约校验，就列出来源名。这时件数函数返回空（`packages/application/src/services/home-feed.ts:220-223`），推送不带角标（`apps/agent-service/src/production-web-push.ts:398-400`、`:139`），不给一个可能偏小的数。前文“件数永远是真实的数”要加上这个条件：读全了才给数。
- 响应多一个 `awaitingTruncated`（`:749`），就是前文说的“清单被截断”的标记。
- 第 1 步的条目还没有 `why`、`feedback`、`undo`、`progress`，动作还没有 `binding`。这些随后面几步加。
- `upcoming` 每条带数据分级。条目编号最长 160（`:646`）。

第 1 步线程另外发现一处原有的问题，不在首页范围里：记忆提醒的编号是 `reminder:` 加记忆编号拼的，可能超过合约里 128 的长度上限，记忆页和 `memory.reminder.respond` 都受影响；首页遇到这种提醒时不显示它，并把这个来源标成不完整。这一条我没有自己复现，已转给协调者安排修。

<a id="unverified"></a>
## 还没核实的事

- 记忆候选和整理的条目，怎样对应到“每天打分”里的那一条（评价命令认的是打分清单里的键），编码时要先对出来。对不出来的种类先不给评价。
- “过程行的一句话由模型给”那个 PR 的最终形态。
- 生产数据量下首页读取要多久，没测。
- 规则要复核时，`memory.rule.respond` 的 `confirm`、`reconfirm`、`undo` 三个动作各对应什么情形，只看了合约里的名字（`packages/gateway-contracts/src/contracts-v2.ts:1629`），没读处理代码；上面动作表里这一行要编码时对准。
- 打分的稳定性和费用是估算，上线前要用真实条目跑一小批。
- 第 4 批（推送服务器部分）还没合入，下面是那个线程自己说的，我没读它的代码（分支 `claude/project-thread-a0ne2a`）：从通知点审批按钮走的是它自己的 `POST /api/device/v1/approvals/respond`，带一次性凭据，服务器存着凭据和审批编号、版本号、内容指纹的绑定；和这里的 `home/act` 是两条入口，最后都转给现有的 `approval.respond`。两条入口的拒绝条件要一致，编码时对着它合入后的代码核一遍。
- 模型写的肯定按钮文字和实际动作对不对得上，没有数据，上线前要用真实审批跑一小批。
- 上面关于 ChatGPT 和 Claude 的说法没有逐字核对原文。
