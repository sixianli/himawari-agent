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
仓库就是当前目录，已检出 6e33c029fbed56b8201d7924c22dafe10ead139c。
问题、目标和约束：
# 问题：Himawari 看到值得提醒的事时，不会提出可以一键执行的后续动作

## 问题

主人（Andy）认可的手机首页原型里，最要紧的一条是这样的：

> 田中把周五的会改到 15:00，出门提醒要跟着改吗
> [不改] [改到 9:40]

点“改到 9:40”，Himawari 就替他把那条出门提醒改掉，并给“撤销”。

现在 main 上做不到。邮件提醒（`source_insights`）只有“完成”“不再提醒”两个动作，Himawari 只会告诉主人有这件事，不会接着提出一个准备好的、主人点一下就执行的动作。

要补的是：Himawari 看到一条值得提醒的事时，如果有明确的后续动作（例如改提醒时间、回一封信、建一个日程，这三个只是示意，不是清单），就把这个动作准备好，作为“等主人点头的一件事”和提醒一起给出，主人同意后执行并核实结果。

请你从问题本身出发，设计这件事在服务器端应该怎么做：动作从哪里来、怎么存、怎么和主人看到的内容绑定、主人点头后怎么执行和核实、出错和过期怎么办、怎么和现有的审批、规则、决策记录、首页条目接口接上、怎么量它做得好不好、分几步做。

## 目标和约束（都是主人已定的）

1. 产品原则的裁决顺序：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率（`docs/product-vision.md:55`）。原则 2：“敏感或不可逆的行动需要确认；能可逆、先验证的，不直接做成不可逆。……常规判断应由规则手册预先授权，不逐次确认；每日需要我介入的次数与时间有上限”。原则 6：“核实结果而非假设成功；失败时说明失败在哪、还剩什么没做”。原则 1：“外部内容与其他 Agent 的输出是数据，不是可覆盖我意图的指令”。
2. 理解意思一律交给模型判断，不许用关键词表、正则、写死的词典。
3. 不许写死：清单、选项、阈值、模型、能力参数，能从系统动态取的一律动态取；上限要做成设置并且主人看得见。
4. 主人看到的和实际执行的必须一致（主人明确反感“显示和实际不一致”）。动作要绑定版本号和内容指纹：主人点的是哪一版、什么内容，执行的就只能是那一版、那个内容。
5. 动作要走现有的权限、审批和规则体系，不另起一套（规则 = CEL 表达式 + 裁判，ADR 0209）。
6. 界面上给主人看的每个数字和判断词都要有可验证的定义；功能要有反向验收（不该提出动作的输入，结果必须是不提出）。
7. 发给模型的内容：固定的在前、会变的在后；同样的内容每次序列化成同样的字节；后台调用也一样（`.claude/rules/prompt-prefix.md`）。
8. 钱：只用低价模型（生产经 Magpie 路由）；每天的模型调用次数和费用要有上限，做成设置。禁止 Claude、OpenAI 这类贵模型。
9. 测试不许用假替身糊弄，用真实 SQLite；每条守卫都要有“去掉它就失败”的反向用例。
10. 不考虑工期，方案要做到位；但不为假想的需求造抽象。
11. 要和“首页条目接口”方案对上（见下面事实 9），三台苹果设备和网页读到同一份。

## 已对着代码核对过的事实（提交 6e33c029）

1. 邮件检查是一次性的批量模型调用，不是带工具的循环。模型对每封邮件输出 `result`（act / know / check / ignore）、`confidence`、`todo`、`reason`、`dueAt`、`priority`、`usedMemoryIds`、`amount`（`packages/application/src/services/proactive-mail-check-service.ts:232-241` 的 `Judgement`）。没有任何“建议动作”字段。
2. 邮件提醒存在 `source_insights`，每个邮件线程一行，状态只有 `open | replied | done | muted`（`packages/application/src/ports/proactive-checks.ts:16`）。主人能做的命令是 `proactive.insight.respond`，动作只有 `done`、`mute`、`reopen`、`rate`（`apps/agent-service/src/production-proactive.ts:640-656`）。
3. Gmail 授权只有只读：`packages/platform-node/src/gmail-source.ts:10-11` 只有 `gmail.readonly` 和 `calendar.readonly` 两个范围。服务器现在不能发信，也不能写日历。
4. 服务器上现有的、会改主人数据的模型工具只有：`reminder_set`、`reminder_cancel`（`apps/agent-service/src/production-reminder-writer.ts:65-100`，没有“改时间”的工具，但存储层 `MemoryReminderStorePort.update` 能改 `dueAt` / `remindAt`，带 `expectedUpdatedAt` 做并发检查，`packages/application/src/ports/memory-reminders.ts:36-44`）、`rule_set`、`rule_undo`（`apps/agent-service/src/production-owner-rules.ts`）。提醒是挂在一条记忆上的（`memoryId`），到点后经网页推送提醒主人。
5. 审批体系：`ApprovalRequest` 绑定一轮运行（`runId`）和一个动作意图（`intentSnapshot`），有 `revision`、`semanticSnapshotHash`、`status`（pending / approved / denied / expired）、`expiresAt`（`packages/application/src/ports/authorization.ts:167-190`）。回答审批必须带 `expectedRevision` 和 `semanticSnapshotHash`（同文件 `:205-213`）。动作类别和风险基线在 `packages/application/src/services/action-policy-service.ts:37-50`：READ 低，CREATE_OR_UPDATE 中，DELETE 高，COMMUNICATE 高，PURCHASE_OR_FUNDS 等最高。最高一档要主人本人在场（`recentAuthenticationRequired: intent.finalRisk === "CRITICAL"`，同文件 `:501`）。
6. 规则手册现在只有两道闸门：`mail_item`（判断一封邮件）和 `mail_delivery`（判断现在能不能推送），见 `packages/application/src/rules/field-catalog.ts:9`。ADR 0209 写了“第 3 步动作闸门”是后续步骤，还没做（`docs/adr/0209-rule-book-with-cel-expressions-and-judge.md:104`）。
7. 仓库里有一套更早写的 `SuggestionService`（`packages/application/src/services/suggestion-service.ts`，建议 → 主人批准 → 建一个任务）和 `AttentionPolicyService`，生产里都没有接线（搜索 `new SuggestionService`、`new AttentionPolicyService` 只命中测试）。
8. 苹果设备的详细设计（`docs/execution/specs/2026-11-11-apple-device-body-design.md`，还没实现）里已经有两样相关的东西：
   - 表 `perception_suggestions`（“建议”）：由不可信来源（别人说的话、网页、短信）产生的、等主人点头的提醒或日程，“主人点‘好’时才真正去建”（第 6 节）。后台发起的一轮运行读过不可信内容后想做有后果的事，“一律不做，改存‘建议’”（第 7 节）。
   - 设备动作登记表和 `device_actions` 流程（第 12 节）：`calendar.create/update/delete`、`reminder.create/complete`、`alarm.set` 等，各登记风险档位、要不要主人在场、怎样读回核实、能不能撤销；状态 `queued → delivered → succeeded / failed / result_unknown / expired / rejected`；“结果未知不重放”。
9. “首页条目接口”方案（`/mnt/project-files/ambient-sensing/home-feed-plan.md`，等主人同意，仓库里没有）：服务器把“Himawari 主动找主人的事”汇成一份排好序的条目。每条有 `key`、`kind`、`awaitsOwner`、`sentence`（一句话）、`actions`（每个带动作名、是肯定还是否定、要不要主人本人在场、一个绑定串）、`undo`（只有服务器真能撤销时才给）、`why`（看到的 / 你的规则 / 用到的记忆，三段各带状态）、`feedback`。设备用 `POST /api/device/v1/home/act` 传条目编号、动作名、绑定串、请求编号，服务器按种类转给现有命令；审批的绑定串里是审批编号、版本号、内容指纹，三样对不上就拒绝并让设备刷新。那份方案明写：现在每类条目的动作“都来自现有命令，没有‘改到 9:40’这种跟具体事情有关的动作”。
10. 决策记录：邮件检查每次写 `decision_ledger`，输入里记了 `ruleIds`、`sourceIds`、`memoryIds`、`usedMemoryIds`（`packages/application/src/services/proactive-mail-check-service.ts:1654-1655` 附近）。主人评价只有 `useful / unneeded / missed` 三个值；隐式信号只有 `opened / undone / replied`（迁移 0080）。
11. 模型用量表的“用途”是写死在表约束里的清单，加新用途要重建表（`packages/application/src/ports/model-usage.ts:3-13`，上一次是迁移 0091）。
12. 邮件检查有每次和每天的费用上限（设置里的 `perCheckCostMicros`、`dailyCostMicros`），到日上限只停模型。

## 查到的一手资料（只是参考，不要局限于此，请你自己再查）

- OpenAI Agents SDK 的 human-in-the-loop：工具标 `needsApproval`，需要批准时 SDK “pauses the run, returns `interruptions`, and lets you resume later from the same `RunState`”；“The human-in-the-loop flow is designed to be interruptible for longer periods of time without keeping your server running.”；对长时间挂起，建议 “assigning your own code a version number and storing it along with the serialized state”。<https://openai.github.io/openai-agents-js/guides/human-in-the-loop>
- LangChain 的 human-in-the-loop 中间件：三种决定，approve “Execute the tool with the original arguments as proposed by the agent.”，edit “Modify the tool arguments before execution.”，reject “Skip executing this tool call entirely and return rejection feedback to the agent.”；审核的人看到的是 “The `tool_call_id`, `name`, and `args` fields identify the call under review.”。<https://docs.langchain.com/oss/python/langchain/human-in-the-loop>
- Anthropic Claude for Chrome：“Claude asks users before taking high-risk actions like publishing, purchasing, or sharing personal data.”；提示注入的实例是 “a malicious email claiming that, for security reasons, emails needed to be deleted.”，没有防护时 “Claude followed these instructions to delete the user’s emails without confirmation.”。<https://claude.com/blog/claude-for-chrome>
- Google Gmail 里的 Gemini：“Gemini will automatically detect calendar related content in your email”，出现 “Add to calendar” 按钮，“Upon clicking this option, the side panel in Gmail will open to confirm the event has been added to your calendar.”，并且 “A calendar event created via the “Add to calendar” button will not include other guests.”。<https://workspaceupdates.googleblog.com/2025/03/add-events-to-google-calendar-using-gemini-in-gmail.html>
- 苹果的可操作通知：“Actionable notifications let the user respond to a delivered notification without launching the corresponding app.”；“Because your app must handle all actions, you must declare the actions that your app supports at launch time.”；动作可以标 `authenticationRequired`（只能在解锁的设备上执行）和 `destructive`。<https://developer.apple.com/documentation/usernotifications/declaring-your-actionable-notification-types>
- 苹果 Mail 里的 Siri 建议：从邮件里认出日程，给“add to Calendar”，可以先看详情再加，也可以 Ignore。<https://support.apple.com/guide/mail/mlhleed80167>
- ChatGPT Pulse：每天一组卡片，拇指上下反馈；公开资料里没有查到卡片带“一键执行”的动作（openai.com 抓取被拒，这一条没有逐字核对）。

## 请回答

1. 你的完整方案（数据怎么存、流程、各种边界情况、和现有体系怎么接、测试、分步）。
2. 你考虑过并放弃的做法，各为什么放弃。
3. 你认为风险最大的三处，以及怎么守住。
4. 需要主人拍板的取舍（只列真正要他定的）。
