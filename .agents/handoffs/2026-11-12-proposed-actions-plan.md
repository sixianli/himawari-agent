<a id="proposed-actions-plan"></a>
# 方案：系统主动提醒带一个准备好的动作，主人点一下就执行

状态：等 Andy 同意。只有方案，没有代码。写于 2026-11-12（JST）。

<a id="contents"></a>
## 阅读导航

- [要 Andy 定的事](#decisions)
- [先回答两个问题](#two-questions)
- [前提和来源](#premises)
- [方案](#plan)
- [和首页条目接口怎么接](#home-feed)
- [三方方案怎么取舍的](#comparison)
- [还没核实的事](#unverified)

<a id="decisions"></a>
## 要 Andy 定的事

1. **同意这个方案动工。** 它新增一种后台模型调用、一张表和一个命令，属于大改动。
2. **第一版只做 Himawari 现在真能执行的两种动作：改一条提醒的时间、建一条提醒。** 首页原型里“田中把周五的会改到 15:00，出门提醒要跟着改吗 [不改] [改到 9:40]”这一条能做出来。建议同意。
3. **回信这次不做。** 服务器现在只有 Gmail 只读授权，发不了信。建议以后单独定：只申请“存草稿”的权限，Himawari 把回信写进你的 Gmail 草稿箱，你自己点发送。这是给 Himawari 新增权限，所以不放在这次里。
4. **建日程这次不做。** 服务器不能写日历；等苹果端“设备动作”那一批做完，日历动作登记进同一张表，就自动能被提议，不用改这套机制。

按产品原则顺序（用户主权 > 边界与可逆性 > 主动性）已经定下、不用你选的：来自邮件的提议一律等你点头，第一版没有任何自动执行；按钮上的字由程序按实际参数生成，不由模型写。

[返回阅读导航](#contents)

<a id="two-questions"></a>
## 先回答两个问题

**别家遇到同样的事怎么做，用户看到什么。**

- Gmail 里的 Gemini：读到邮件里有日程，就在邮件上出一个按钮。原话：“Gemini will automatically detect calendar related content in your email”，“Upon clicking this option, the side panel in Gmail will open to confirm the event has been added to your calendar.”，并且 “A calendar event created via the “Add to calendar” button will not include other guests.”（<https://workspaceupdates.googleblog.com/2025/03/add-events-to-google-calendar-using-gemini-in-gmail.html>）。也就是：一键、只动用户自己的日历、做完给确认。
- 苹果 Mail 的 Siri 建议：从邮件里认出日程，给“add to Calendar”，可以先看详情，也可以 Ignore（<https://support.apple.com/guide/mail/mlhleed80167>，这一页是搜索摘要的转述，没有逐字核对）。
- 苹果的可操作通知：“Actionable notifications let the user respond to a delivered notification without launching the corresponding app.”，“Because your app must handle all actions, you must declare the actions that your app supports at launch time.”（<https://developer.apple.com/documentation/usernotifications/declaring-your-actionable-notification-types>）。也就是：能点的动作是事先登记好的有限几种。
- OpenAI Agents SDK 和 LangChain 给开发者的“人点头再执行”：模型提出一次具体的工具调用，系统停下等人。LangChain 的原话，同意是 “Execute the tool with the original arguments as proposed by the agent.”，人看到的是 “The `tool_call_id`, `name`, and `args` fields identify the call under review.”（<https://docs.langchain.com/oss/python/langchain/human-in-the-loop>）。OpenAI 的原话：“pauses the run, returns `interruptions`, and lets you resume later from the same `RunState`”，长时间挂起建议 “assigning your own code a version number and storing it along with the serialized state”（<https://openai.github.io/openai-agents-js/guides/human-in-the-loop>）。也就是：人同意的是那一次调用的原样参数，挂起的东西要带版本。
- Anthropic 的 Claude for Chrome：“Claude asks users before taking high-risk actions like publishing, purchasing, or sharing personal data.”；它公开的事故例子是一封恶意邮件，“a malicious email claiming that, for security reasons, emails needed to be deleted.”，没有防护时 “Claude followed these instructions to delete the user’s emails without confirmation.”（<https://claude.com/blog/claude-for-chrome>）。也就是：邮件里的话能骗模型，由邮件引出的动作不能不经人就执行。
- ChatGPT Pulse：每天一组卡片，拇指上下反馈。公开资料里没查到卡片带一键执行的动作（openai.com 抓取被拒，没有逐字核对）。

共同点：动作是登记好的有限几种；人点的是一次具体的、参数已经定好的动作；只动用户自己的东西的可以一键，对外的要先看内容；做完给确认。本方案照这个做，并多做两件别家没公开承诺的：点的那一版和执行的那一版用版本号加内容指纹绑死；执行后读回核实并给撤销。

**这是根因还是表面修补。** 是根因。现在邮件判断的模型输出里没有“动作”这个概念（前提 1），提醒只有“完成”“不再提醒”两个动作（前提 2），服务器也没有地方存一个“准备好、等点头”的动作。只在界面上加两个按钮、点了以后再让模型去理解一遍该做什么，是表面修补：主人点的时候看到的和后来执行的可能不是一回事。

[返回阅读导航](#contents)

<a id="premises"></a>
## 前提和来源

行号对应提交 `6e33c029`。

1. 邮件判断是一次批量模型调用，输出里没有动作。`packages/application/src/services/proactive-mail-check-service.ts:232-241`：`interface Judgement { readonly result: ProactiveResult; … readonly todo: string; readonly reason: string; readonly dueAt: string | null; readonly priority: ProactivePriority | null; … }`。
2. 邮件提醒的状态和主人能做的事。`packages/application/src/ports/proactive-checks.ts:16`：`export type ProactiveInsightStatus = "open" | "replied" | "done" | "muted";`。`apps/agent-service/src/production-proactive.ts:652`：`: { status: action === "done" ? "done" : action === "mute" ? "muted" : "open" }),`。
3. Gmail 只有只读授权。`packages/platform-node/src/gmail-source.ts:10`：`export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";`，`:11`：`export const CALENDAR_READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";`。
4. 提醒的工具只有三个，没有“改时间”：`apps/agent-service/src/production-reminder-writer.ts:67` `name: "reminder_set",`、`:83` `name: "reminder_list",`、`:90` `name: "reminder_cancel",`。存储层能改时间并做并发检查：`packages/application/src/ports/memory-reminders.ts:36-44` 的 `update(input: { readonly id: string; readonly expectedUpdatedAt: string; … readonly dueAt: string; readonly remindAt: string; … }): Promise<boolean>;`。提醒的状态：同文件 `:14` `readonly status: "scheduled" | "dismissed" | "cancelled";`。
5. 审批记录必须挂在一轮真实的运行上。`packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:183`：`run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,`。邮件检查的模型调用用的不是运行表里的编号：`apps/agent-service/src/production-model-composition.ts:533`：``const runId = `proactive:${invocationId}` as RunId;``。
6. 回答审批要带版本号和内容指纹：`packages/application/src/ports/authorization.ts:205-213` 的 `ResolveApprovalInput` 有 `readonly expectedRevision: number;`、`readonly semanticSnapshotHash: string;`。
7. 风险档位的算法。`packages/application/src/services/action-policy-service.ts:37-50`：`CREATE_OR_UPDATE: "MEDIUM",`、`DELETE: "HIGH",`、`COMMUNICATE: "HIGH",`。同文件 `:58-60`：`if (intent.actionKind === "DELETE" && !intent.reversible) facts.push("CRITICAL");`。
8. 规则手册只有两道闸门。`packages/application/src/rules/field-catalog.ts:9`：`export const RULE_GATES = ["mail_item", "mail_delivery"] as const;`。动作闸门是后续步骤：`docs/adr/0209-rule-book-with-cel-expressions-and-judge.md:104`：“后续步骤要改的：第 2 步通知闸门和金额字段……第 3 步动作闸门”。
9. 读数据库走只读连接，读的路径里不能写。`docs/adr/0131-read-lane-separate-readonly-connection.md:55`：“读线程只读，发出写语句会直接报 “attempt to write a readonly database””。`packages/persistence-sqlite/src/durable-adapters.ts:1071`：`listInsights: (input) => this.context.read("proactive.listInsights", input),`。
10. 清除记录现在删哪些表。`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:560-565` 列的是 `"source_insights",`、`"proactive_processed_messages",`、`"proactive_pushes",`、`"proactive_push_backoff",`。
11. 系统主动提醒的每日费用按决策记录里 `proactive` 一类累计。同文件 `:991-992`：`SELECT COALESCE(SUM(cost_micros), 0) AS total FROM decision_ledger`、`WHERE owner_id = ? AND agent_id = ? AND kind = 'proactive' AND checked_at >= ?`。
12. 决策记录的种类是写死在表约束和代码里的清单。`packages/application/src/ports/decision-ledger.ts:32-40`：`export const DECISION_KINDS = [ "proactive", "memory_candidate", … "rule_review", ] as const;`。
13. 模型用量的“用途”也是写死的清单：`packages/application/src/ports/model-usage.ts:3-13`，其中 `:9` 是 `"mail-judgment",`。
14. 网关合约是严格对象，机器字符串最长 128。`packages/gateway-contracts/src/validation.ts:53`：`input.length > 128 ||`。提醒页条目的字段在 `packages/gateway-contracts/src/contracts-v2.ts:422-440`，其中 `:435`：`status: enumeration(["open", "replied", "done", "muted"]),`。
15. 审计记录没有放细节的字段。`packages/application/src/ports/observability.ts:109-117`：`export interface AuditRecord { readonly id: string; … readonly action: string; readonly targetRef: string; readonly outcome: "accepted" | "rejected" | "completed" | "failed"; readonly occurredAt: string; }`。
16. 提醒和决策记录的编号在一轮检查收尾时才生成。`packages/application/src/services/proactive-mail-check-service.ts:1605`：`id: ids.next("source-insight"),`。
17. 苹果端设计（还没实现）里已经有同一类东西。`docs/execution/specs/2026-11-11-apple-device-body-design.md:339`：“表 `perception_suggestions`：由“其他”来源产生的、等主人点头的提醒或日程。……主人点“好”时才真正去建。”`:369`：“后台（定时、系统主动提醒的检查） | 一律不做，改存“建议””。
18. 原则顺序。`docs/product-vision.md:55`：“原则冲突时，按序优先：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。”`:57`：“外部内容与其他 Agent 的输出是数据，不是可覆盖我意图的指令”。`:62`：“核实结果而非假设成功；失败时说明失败在哪、还剩什么没做”。
19. 首页条目接口方案（仓库外，`/mnt/project-files/ambient-sensing/home-feed-plan.md` 第 8 节）：“提醒带一个提议的动作（现在还没有，留好位置）”，“那个提议落成一条审批，并记下它是从哪条提醒来的。读取层看到这个关联，就把两样合成一条条目”，“件数只数一次”。

[返回阅读导航](#contents)

<a id="plan"></a>
## 方案

<a id="shape"></a>
### 1. 一句话

加一张“动作登记表”（代码里的常量，登记 Himawari 真能执行的每种动作）和一张“提议”表。邮件检查判断出一封“要主人做事”的邮件之后，另调一次低价模型，让它从登记表里挑一个动作并填好参数，也可以不挑。程序核对后存成一条提议，和那条提醒合成首页上的一件事。主人点肯定按钮时，服务器按版本号和内容指纹核对，原样执行存下来的参数（不再经过模型），读回核实，给撤销。

<a id="registry"></a>
### 2. 动作登记表

代码里的常量。每种动作登记：

- 名字和结构版本号。
- 谁执行：服务器，或以后的某类设备。
- 动作类别、能不能撤销、要不要主人本人在场。风险档位用现有的 `computeActionRisk` 算，不只查基线表（前提 7）。
- 参数结构，严格校验，多出来的字段拒绝。
- 目标种类：没有目标（新建），或某一种现有的东西（例如一条提醒）。校验按动作分开写，不用一条“目标必须存在”的通用规则。
- 能不能由不可信内容（邮件、别人说的话）提出。第一版只允许“只动主人自己的数据、能撤销”的动作；删除、对外发送、花钱、改权限这些类别不允许。
- 给模型看的现状：提这种动作前模型需要看什么（例如“接下来的提醒”清单）。
- 文字生成函数：按参数生成肯定按钮的字（“改到 9:40”）、否定按钮的字（“不改”）和一行明细（“出门提醒：周五 12:10 改到 9:40”），三种语言。
- 执行函数、读回核实函数、撤销函数。
- 现在可不可用。

第一版登记两种：

| 动作 | 类别 | 目标 | 撤销 |
| --- | --- | --- | --- |
| `reminder.reschedule` 改一条提醒的时间 | 新建或修改，中 | 一条状态是 `scheduled` 的提醒 | 恢复原来的时间 |
| `reminder.create` 建一条提醒 | 新建或修改，中 | 没有 | 取消这条提醒并收回它挂着的那条记忆；做不到完整收回就不给撤销 |

取消提醒第一版不做成可提议的动作：它属于删除类，不该由一封邮件引出一键执行。

模型拿到的可用动作清单每次从登记表和可用性算出来，提示词里不写具体动作名。执行函数直接调服务器内部的提醒写入代码（给它加一个改时间的方法，用前提 4 里存储层已有的 `update`）。不新增对话里的模型工具，所以对话请求的开头不变。

<a id="proposer"></a>
### 3. 提议从哪来

- **时机**。在一轮邮件检查里，判断调用结束、结果是“要主人做事”并且会上提醒页的邮件，接着做一次“提议”调用。这次调用排在这一轮收尾写库之前（提醒和决策记录的编号提前生成，前提 16），提议和提醒在同一次写库里一起落下。推送被静默时段压住时照样准备。
- **限额**。每轮最多几封（设置，默认 3，按优先级和到期时间挑）、每天最多几次（设置，默认 30）、这一轮剩下的时间不够就不做。都在用量页看得到。到上限、出错、超时：提醒照常，只是不带动作。这一轮没轮到的，下一轮检查补做（按“还开着、结果是要做事、当前这一版还没做过提议判断”查出来），同样受限额管。
- **发给模型的内容**，固定的在前：固定说明（登记进提示词目录）→ 可用动作清单（按名字排序）→ 这封邮件和同一件事的相关邮件（和判断调用同一套遮盖、同一个顺序）→ 判断调用写的待办和理由（再过一次遮盖）→ 各动作要的现状（提醒按到期时间和编号排序，只给编号、文字、时间）→ 这封邮件用到的记忆（按编号排序）→ 日期对照表和当前时间。键顺序固定。这次调用不读也不写任何对话的历史，不用对话的系统提示和工具。
- **模型输出**。不提议（带原因），或一条提议：动作名、参数、目标编号、问主人的那一句、依据（哪封邮件的哪句原话、用了哪几条记忆）。模型不输出目标的版本；版本由服务器从自己发出去的那份现状里取。
- **程序核对**，任何一项不过就不存提议，原因记进决策记录：
  - 动作在登记表里、现在可用、允许由邮件提出。
  - 参数过结构校验和业务校验（时间在将来、文字过现有的提醒文字检查）。时间参数是和现状清单同一种写法的当地时间；提前多久提醒由服务器用现有算法重算，不采信模型给的。
  - 有目标的动作，目标编号必须在这次发给模型的那份清单里，不是只要数据库里有就行。
  - 引用的原话能在模型实际看到的那封邮件文字里逐字找到；原话里带遮盖占位符的直接丢。
  - 同样的提议在这封邮件的这一版下已经被主人拒绝过，就不再提。
- **费用和用量**。费用加在这一轮邮件检查的那条决策记录上，现有的每日费用上限照旧把它算进去（前提 11），不另算一份。模型用量记成新用途 `action-proposal`，用邮件判断同一个模型配置，不写死模型。按复核脚本里记的 DeepSeek V4.1 Flash 按量单价估，一次约 0.001 美元，每天 30 次封顶约 0.03 美元。
- **为什么不放进现有的判断调用**。那次调用一批 8 封，多数是不用管的邮件，把动作清单和提醒清单塞给每一批是浪费；改它的提示词和输出会动到已经调好的判断；提议失败不该连累提醒本身。
- **为什么不用带工具的循环**。第一版需要的现状能事先取好，一次调用够了，便宜、可重放、容易测。

<a id="storage"></a>
### 4. 存什么

新表 `action_proposals`。每行：

- 编号；来源种类和来源编号（现在是邮件提醒）；来源版本（提醒的 `last_message_id`）；产生它的那条决策记录。
- 动作名和结构版本；参数（和提醒内容一样加密存）；目标种类、目标编号、提议时的目标版本（提醒的 `updatedAt`；没有目标的为空）。
- 内容指纹：对“动作名、结构版本、规范化后的参数、目标编号和版本、来源编号和版本”取 SHA-256。规范化的写法定死：键排序、时间统一成 UTC 的 ISO 格式、文字做 Unicode NFC。
- 版本号：每次状态变化加 1。
- 问句、依据（加密存）。
- 状态、过期时间、主人点头的时间和确认方式、执行后的目标版本、执行结果、原样（撤销用）、失败原因。
- 同一封邮件的同一版下，还开着或正在执行的提议只能有一条（数据库唯一索引）。

内容写入后不再改。内容要变就把旧的标成被取代，另写一行。

状态怎样变：

| 从 | 到 | 什么时候 |
| --- | --- | --- |
| `open` | `executing` | 主人点肯定，核对通过，领取成功 |
| `executing` | `succeeded` | 执行并读回核实一致 |
| `executing` | `failed` | 没改成，或读回和要求的不一致；写明原因 |
| `executing` | `result_unknown` | 说不清做没做（只会出现在以后的设备动作）；不重做，只读回核实 |
| `open` | `declined` | 主人点否定 |
| `declined` | `open` | 主人撤销刚才的否定 |
| `open` | `superseded` | 邮件线程来了新邮件，或目标被改了 |
| `open` | `expired` | 过了过期时间 |
| `open` | `withdrawn` | 主人直接把提醒点了完成或不再提醒 |
| `succeeded` | `undone` | 主人撤销；同时按撤销后的目标版本另写一行内容相同的 `open` 提议 |

断开 Gmail、清除记录、数据导出和导入都要带上这张表和它的加密内容（前提 10）。

<a id="accept"></a>
### 5. 主人点了之后

新命令 `proactive.proposal.respond`，动作是接受、拒绝、撤销。载荷里是三个分开的字段：提议编号、期望的版本号、内容指纹（不拼成一个字符串，前提 14）。这三样不是通行证：命令仍然要求已登录的主人；登记了要本人在场的动作，仍然要面容确认。

接受：

1. 核对：编号、版本号、指纹三样对上，状态是 `open`，没过期。同一个请求编号只生效一次。
2. 重新核对前提：提醒还是那一版、还开着；目标还在、版本没变；登记表里这个动作还可用、结构版本没变；按存下来的内容重算指纹和存的一致。对不上：标 `superseded`，什么都不执行，告诉界面“这件事变了”。
3. 领取：把提议从 `open` 改成 `executing`，带版本号条件。两台设备同时点，只有一个领得到。
4. 执行存下来的参数。改时间：存储层新加一个原子操作，在一个数据库事务里存原样、改提醒（带目标版本条件）、记下执行后的目标版本、提议改成 `succeeded`、邮件提醒改成 `done`，要么全成要么全不成。建提醒：现有的建提醒代码要先写记忆再写提醒，不在一个事务里，所以用提议编号当去重键（同一个键再建一次只会返回已有的那条），中途断了再来一次是安全的。
5. 读回核实：读到的时间、文字、状态等于参数里的才算成功；不一致记 `failed`，写明是哪一样不对。
6. 写审计记录（接受时一条，做完或失败时一条）。现有审计记录放不下指纹和风险档位（前提 15），这些细节记在提议这一行上。
7. 返回结果、程序生成的明细、撤销入口。

拒绝：提议标 `declined`，邮件提醒标 `done`（主人已经看过并定了，从首页收走），可以撤销。

撤销：按原样恢复，条件是目标现在的版本等于“执行后的目标版本”；在那之后又被改过就拒绝并说明，不覆盖别人的改动。原来的时间已经过去、恢复不回去的，也拒绝并说明。

失败：提议留在 `failed`，邮件提醒还开着，首页显示没改成和原因。

为什么不往现有的审批表里写：审批记录必须挂在一轮真实的运行上，邮件检查的调用没有对应的运行（前提 5），为记一笔造一轮假的运行不值得；提议还有被取代、撤回、执行结果、撤销这些审批没有的状态。沿用的是审批的做法：版本号加内容指纹的绑定（前提 6）、现有的风险算法、最高档要本人在场、审计记录。

<a id="stale"></a>
### 6. 变旧和过期

- 邮件线程来了新邮件：检查写库时，旧版本下还开着的提议全部标 `superseded`，对新版本重新做提议判断。
- 主人自己改了或取消了那条提醒，或删了它挂着的那条记忆：那次写库顺带把指向它的开着的提议标 `superseded`。
- 两封邮件各对同一条提醒提了不同的改法：主人接受其中一条后，另一条在核对目标版本时对不上，标 `superseded`。
- 读取的路径不写库（前提 9）：首页和提醒页读的时候只比对，过期的、目标版本对不上的不显示；状态由上面两处写库、接受时的核对和一个后台清理任务落下。
- 过期时间取最早的：事情本身的时间、提议里的新时间、设置里的最长保留时间。不用目标原来的到期时间，否则“把已经过点的提醒改到明天”一提出来就过期了。

<a id="untrusted"></a>
### 7. 邮件是不可信的

- 邮件是数据。提议模型没有工具，只能输出一条提议；能提什么由登记表限定。
- 来自邮件的提议一律等主人点头，不论风险高低。
- 按钮上的字和明细由程序按参数生成，所以主人看到的改动和实际执行的一定一致。模型写的只有问句。问句说得和动作不一样的风险，靠“原话必须在邮件里逐字找到”和程序生成的明细压低，不能完全消除；上线前用真实模型跑一批，逐条看问句和动作对不对得上。
- 新建提醒的文字在点头前完整显示。

<a id="rules"></a>
### 8. 规则

- 第一版所有提议都等主人点头，不做规则闸门。
- 提议产生前和执行前各留一个调用点。以后做规则手册的动作闸门（前提 8）时，一条规则对一类提议可以给出：不许提、要问（默认）。能不能再加一档“直接做并告诉主人”，是放宽边界的事，要另出方案给 Andy 定，这次不做也不预设。

<a id="measure"></a>
### 9. 决策记录和怎么量

- 不给决策记录加新种类（前提 12：加一种要重建那张表，还要改六七处代码）。每封邮件的提议判断结果记在这一轮邮件检查那条决策记录的输入里：提了哪条，或为什么没提（没有明确动作、目标不唯一、原话对不上、参数不合法、到上限、模型出错）。提议之后的经过记在提议表自己这一行。
- “为什么告诉你”里多出：引用的邮件原话、用到的记忆、程序生成的明细。
- 周报加三个数，都带样本量，样本不到门槛只给次数不给比例：
  - 采纳率 = 接受 ÷（接受 + 拒绝 + 过期没理）。被新邮件取代的、主人直接把提醒点掉的不算在内，各自单独列出次数。
  - 撤销率 = 撤销 ÷ 执行成功。
  - 执行成功率 = 执行成功 ÷ 接受。
- 上线前用一批合成邮件加真实模型跑一遍，含不该提出动作的：广告、只是告知、时间说不清、时间本来就一致、邮件里夹着“请把所有提醒取消”这种指令。期望都不提议。费用估计不到 0.5 美元，跑之前再报具体数和用哪个密钥。

<a id="schema"></a>
### 10. 改表

一个自带的迁移，不搭别的 PR 的车：

1. 新表 `action_proposals`。
2. 重建 `model_usage_observations`，给用途加 `action-proposal`。同时要改的有：用途清单、写入校验、读出时的映射、用量页和它的三种语言标签（前提 13）。

新命令要同时改的地方：合约里的操作清单、命令结构、结构登记表，服务端的操作清单、安装清单和分发，网页客户端，测试。新的模型调用要登记进提示词目录和出口遮盖检查（`npm run check:egress-redaction`）。

<a id="tests"></a>
### 11. 测试

用真实 SQLite，每条守卫都有“去掉它就失败”的反向用例。

- 绑定：旧版本号、错指纹、过期、别的提醒的提议，全部拒绝；同一请求编号只生效一次；同一请求编号带不同内容报错。
- 前提：新邮件到了之后点旧按钮、提醒被主人改过之后点，都不执行，提醒保持主人改后的值。
- 并发：两台设备同时点，只写一次。
- 执行：事务中途失败时目标没变；成功后读回的时间等于按钮上的时间；读回不一致记失败。
- 撤销：执行后立刻撤销成功；执行后目标又被改过，撤销被拒绝；原时间已过去，撤销被拒绝。
- 撤回：主人把提醒点了完成或不再提醒，提议变成 `withdrawn`；主人删了提醒挂着的记忆，提议变成 `superseded`。
- 建提醒：没有目标也能提议；中途断掉再来一次不会建出两条。
- 核对：登记表外的动作、不可用的动作、不许由邮件提出的类别、目标不在发给模型的清单里、原话在邮件里找不到、原话带遮盖占位符、参数多字段、时间在过去，都不存提议。
- 限额：一轮 20 封要做事的邮件只调用上限次数；到每天上限后提醒照常出现、不带动作；费用只算一份。
- 遮盖：邮件正文里有卡号或验证码时，提议调用的请求体里没有原值。
- 字节：同样输入两次发出的请求字节相同；打乱邮件、提醒、记忆、动作的读取顺序后仍相同。
- 读取不写库：在只读连接上读提醒页和首页，不发出写语句。
- 清除和导出：断开 Gmail 后新表为空、加密内容已删；导出再导入后提议还在。
- 按钮文字：每种动作的文字生成函数，三种语言、长的人名和时间都试过，肯定和否定按钮都不超字数上限（中文 6 字、日文 8 字、英文 16 字符，按显示的字符数算）；肯定按钮超了退回登记的通用肯定词；12 小时制和 24 小时制的地区都试。
- 合约：带提议的提醒页快照通过校验；多一个未声明的字段就失败；新命令过 `check:operations`。
- 提示词：新的固定文字进提示词目录；开着和关着提议功能，同一个对话发出的请求字节相同。
- 真实网页上的正反向验收：一封该提的邮件出现两个按钮，点了以后提醒时间真的变了；一封不该提的邮件只有普通提醒。

<a id="order"></a>
### 12. 先后顺序

1. 登记表、提议表和迁移、`proactive.proposal.respond`、改时间和建提醒两个动作的执行、读回、撤销、清除和导出、提醒页合约里的提议子对象、网页提醒页上的按钮。不调模型，用测试里种下的提议就能验。
2. 提议调用、提示词登记、限额、用途、决策记录里的结果、合成邮件评测、周报的三个数。
3. 接进首页条目接口、设备入口和推送（等那几个 PR）。
4. 以后：设备动作、日历、感知来源的“建议”登记进来；规则手册的动作闸门。各自另出方案。

[返回阅读导航](#contents)

<a id="home-feed"></a>
## 和首页条目接口怎么接

- 提议不单独成条。读取层看到一条邮件提醒有开着的提议，就把这条提醒的条目换成：一句话用提议的问句（来源标成模型写的）；`actions` 先放提议的肯定和否定，后面跟提醒自己的“不再提醒”。件数只数一次。
- 按钮的字是程序按参数生成的，不是登记的通用文字，也不是模型写的。首页条目方案第 8 节已为此给按钮文字的来源加了第三个值 `computed`（程序按这次动作存下来的参数算出来的），肯定和否定按钮都可以是它。合约里这个枚举是严格校验的，所以加 `computed` 时，产生它的地方和每个读它的地方（网页、苹果端、推送）要在同一次改动里一起认。
- 苹果端设计线程给按钮定的字数上限是中文 6 字、日文 8 字、英文 16 字符。字数按显示的字符数算，不按字节。设计线程 2026-11-12 定的写法：
  - 肯定按钮带时间：中文“改到 9:40”，英文“Move to 9:40”，日文“9:40に変更”。时间按主人的地区格式出（12 小时制地区的英文是“Move to 9:40 AM”）。超了上限就退回这种动作登记的通用肯定词，不硬缩；建提醒的“建 9:40 的提醒”这类就是这样退回。
  - 否定按钮：每种动作在登记表里登记一个固定、不带参数的否定词（改时间是“不改”，建提醒是“不建”），来源也算 `computed`。设计线程原先“否定按钮一律通用文字”要防的是模型写否定词，登记表里的固定词不在那条限制里。否定词同样受字数上限约束；它的意思必须是“这条提议不做”，不能让人读成取消提醒本身。
- 首页条目方案原来设想“提议落成一条审批”（前提 19）。这里改成提议自己一张表，理由见[主人点了之后](#accept)；首页条目方案第 8 节已跟着改。设备传回的绑定串由首页读取层生成和拆开，里面是提议编号、版本号、内容指纹；拆开后按三个字段转给 `proactive.proposal.respond`。绑定串在合约里用单独的、够长的字符串类型，不用 `machineString`。
- 执行当场的结果和成功后的撤销入口都在 `home/act` 的返回里给：成功后条目被收走，撤销不靠条目本身。失败时条目留着，首页条目加一个可选字段 `outcome`（上一次动作的结果和原因文字），给之后再打开首页时看。
- 首页第 1 步的代码还没合进 main（分支 `claude/project-thread-tywujv`）。第 3 步接首页时对着合入后的代码写。
- 推送、Watch、Mac 菜单栏用同一份文字和同一个绑定。锁屏上的按钮只是把这次点击交给已登录的 App 去提交，绑定串本身不是通行证。
- 苹果端设计里的 `perception_suggestions`（前提 17）和这张提议表是同一类东西。这张表的来源种类和可空的目标已经容得下它；并不并、什么时候并，由苹果端规划线程在做到那一批时定，这个方案不替它改设计文档。

[返回阅读导航](#contents)

<a id="comparison"></a>
## 三方方案怎么取舍的

原始记录在 `.agents/reviews/topic-proposed-actions/`。两个模型独立出的方案和线程的方案在主干上一致：登记表限定动作、单独一次模型调用、单独一张表、按版本和指纹绑定、执行存下来的参数、读回、撤销。下面是有分歧或被审核改掉的地方。

| 问题 | 线程原来的方案 | GLM | DeepSeek | 定稿 |
| --- | --- | --- | --- | --- |
| 要不要提议，信号从哪来 | 所有会上提醒页的“要做事”邮件都做一次提议调用 | 判断调用加一个可选字段当信号，再做落实调用 | 判断调用不动，另做一次调用 | 判断调用不动。GLM 的做法能少调几次，但要改已经调好的判断提示词和输出，不值 |
| 目标的版本谁给 | 模型输出目标编号，没说版本 | 模型输出 | 服务器从自己发出去的清单里取 | 采纳 DeepSeek |
| 点头怎么记 | 记成审批加一次性授权 | 点头时建审批并当场同意 | 点头时建审批，并指出审批表要求真实的运行、这一步没核实 | 不写审批表，沿用它的做法。核对了前提 5，线程原来的写法落不了库 |
| 读取时发现目标变了 | 读的时候顺手标成被取代 | 读取时惰性标过期 | 审核指出读的路径不能写库 | 采纳 DeepSeek 的审核，线程原来的写法是错的 |
| 取消提醒 | 第一版就登记 | 建议先不做 | 审核指出它是删除类，和“删除类不许由邮件提出”自相矛盾 | 第一版不做 |
| 新建提醒的目标 | 一条“目标必须存在”的通用校验 | 第一版只做改时间 | 审核指出新建没有目标，按字面过不了校验 | 目标按动作区分，可以没有 |
| 撤销用哪个版本比对 | 只存了提议时的目标版本 | 要求目标仍是执行后的值 | 审核指出执行本身会改版本，用旧版本比必然对不上 | 存执行后的目标版本 |
| 决策记录 | 加新种类 | 扩隐式信号 | 加新种类；审核时指出加种类要改的地方很多 | 不加种类，记在邮件检查那条记录的输入里和提议表里 |
| 费用记在哪 | 记在父记录上 | 计入现有每日上限 | 记在父记录上，避免重复算 | 记在父记录上 |
| 限额 | 每天上限 | 每天带动作的条数上限 | 审核指出缺每轮上限，一批邮件能耗光当天额度 | 每轮和每天都有上限 |
| 清除和导出 | 没提 | 提了随主人删除 | 审核指出断开 Gmail、清除、导出都漏了新表 | 全部接上 |
| 绑定串 | 一个拼起来的串 | 一个拼起来的串 | 审核指出会超过合约里 128 的长度上限 | 命令里三个分开的字段 |
| 过期时间 | 含目标原来的到期时间 | 提醒时间和保留天数取早 | 审核指出改已过点的提醒会立刻过期 | 用提议里的新时间 |
| 第一版登记哪些动作 | 改时间、建、取消 | 独立方案只做改时间；审核时主张做改时间和取消、不做建（建提醒的事务、撤销、目标最难） | 改时间，建可选 | 改时间和建。取消是删除类，不由邮件引出；建提醒对“周五前交表”这类邮件最有用，它不在一个事务里的问题用去重键解决，撤销做不完整就不给 |
| 规则能不能让它自动执行 | 以后可以，另出方案 | 第 2 步就加“自动”一档 | 规则只管能不能提，永远不给执行权 | 这次不做也不预设，放宽边界要 Andy 另定 |
| 和感知“建议”合并 | 直接并进来 | 以后接 | 列为要主人定；审核指出不能只写一句“并进来” | 表结构容得下，并不并由苹果端规划线程定 |

[返回阅读导航](#contents)

<a id="unverified"></a>
## 还没核实的事

- 建提醒的撤销能不能把它挂着的那条记忆完整收回，只读了建和取消的代码，没读记忆删除那一段；做不到就不给撤销。
- 改提醒时间后，提前多久提醒（`remindAt`）怎样重算，要对准现有建提醒时的算法。
- 提议调用加进一轮检查后，会不会把检查拖过它的时间上限，要用真实邮件量测。
- 新的固定提示词进了受信文字清单后，会不会让老对话里某段文字的遮盖结果变一次，要按 `.claude/rules/prompt-prefix.md` 第 11 条检查。
- 模型写的问句和实际动作对不对得上的比例、采纳率，没有数据，上线前要跑一批。
- 苹果 Mail 的 Siri 建议和 ChatGPT Pulse 的说法没有逐字核对原文。

[返回阅读导航](#contents)
