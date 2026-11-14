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
仓库就是当前目录，已检出 4460960d8184b5e5d2a669f49e58d8a411400338。
问题、目标和约束：
# 方案材料：用户硬规则第 4 步里的“统一通知闸门和延后”

## 背景

Himawari 是给不会用编程工具的人用的（ADR 0083：一个人一个实例），用户侧功能必须在产品内闭环。已完成的前几步：规则手册、字段目录、裁判 `RuleJudge.decide(gate, facts, rules)`（`packages/application/src/rules/`，ADR 0209）；邮件推送的金额字段和“不推送”结果（ADR 0212）；主人一句话变成长期规则的规则类型注册表、`rule_set`/`rule_list`/`rule_undo` 三个对话工具和规则页（ADR 0213，`packages/application/src/rules/rule-types.ts`，现有两种类型都只管邮件）。

最终方案原本要求“五类推送共用一道通知闸门，静默延后做进出站队列”，但第 2 步核对后推迟到现在，原因（ADR 0212 写明）：已入队的推送会绕过闸门；到点提醒只在 6 小时窗口内有效，“23:30 延到 07:00”会发不出去；待审批会在静默时段里过期；并且当时没有任何规则会作用于邮件以外的四类推送。现在要决定：值不值得现在做、做成什么样、第一条会作用于另外四类推送的规则是什么。下面是已核对的现状，**不含任何方案**。

## 目标（来自最终方案，Andy 已同意）

1. 一处管住全部五类推送（到点提醒、待审批、任务完成、邮件主动提醒、Muse 通道中断）：结果可以是“照常推送”、“延后到某时刻”、“不推送但仍留在提醒页/记录里”。
2. 规则内容是数据，执行是程序；闸门命中要写进决策记录（规则 id、版本号）。
3. 默认行为不变：默认静默时段只管邮件；主人自己设的 06:30 提醒是明确指令，不该被默认静默推到 07:00；待审批有时效；Muse 中断是故障告警。关键审批通知、告警、出口遮盖、沙箱是系统规则，用户规则既不能放宽也不能吞掉（例如“什么都别推送”不能让审批卡悄悄过期）。
4. 用户在网页上看到的推送被延后、被规则拦下，都要能看懂、能撤销，不依赖开发线程。

## 约束

- 不改变既有行为之外的东西；每处行为变化写进 ADR 并有测试；不得用假替身；改表结构的迁移号连续（当前最新是 0092）；同一时间只允许一个改表结构的步骤在做。
- 发给模型的内容只追加（`.claude/rules/prompt-prefix.md`）；本步不应改系统提示和工具定义。
- 费用：硬规则执行不花 token。
- 界面上的数字和判断词要有可验证的定义，并做正反向验收。

## 已核对的现状（文件与行号，提交 4460960d）

1. 五类推送都由 `apps/agent-service/src/production-web-push.ts` 的 `#collect`（约 314 行起）收集后调 `store.enqueue` 入队，发送由 `#deliver` 做；每 10 秒一次的 `#run` 先取待审批（`listApprovals`，未过期的）、到点提醒（`reminders.listDue`，且 `now - remindAt ≤ REMINDER_WINDOW_MS = 6 小时`）、已结束的任务（`listFinishedRuns`，按游标只消费一次，窗口 24 小时）、邮件主动提醒（`proactive.listReady(now)`，窗口 24 小时）、Muse 通道中断（`museChannel.listActive`，窗口 12 小时），统一生成 `WebPushOutboxItem`（`sourceKey`、`kind`、`sourceRef`、`threadId`、`createdAt`、`expiresAt`）。入队对已有 `source_key` 是 `ON CONFLICT DO NOTHING`。`#deliver` 只判断：过期、推送类别开关 `kinds`、主人正在看页面（`presence.anyVisible`）。这个文件里没有静默时段或规则判断。
2. 出站表 `web_push_outbox`（`packages/persistence-sqlite/src/migrations/0058_web_push.sql:22`）的 `kind` 只有 `reminder`、`approval`、`run`；邮件主动提醒和 Muse 中断都是 `kind='reminder'`，靠 `source_key` 前缀（`proactive:`、`muse-channel:`、`reminder:`）区分。表里没有“延后到”的列；`listDue`（`sqlite-web-push-operations`）按 `a.status IS NULL OR (pending AND next_attempt_at <= now)` 取；`web_push_attempts` 有 `next_attempt_at`（发送重试用）。
3. 邮件主动提醒已有自己的延后队列：`proactive_pushes`（`ready_at`，`status pending|enqueued`），`proactive-mail-check-service.ts` 创建推送时用 `quietEnd(...)`（`packages/application/src/services/proactive-rules.ts`）算 `readyAt`，同一时段同一 `readyAt` 的多条合成一条。静默时段设置现在是规则手册里的一条规则（表达式用 `local_minutes` 等字段）。
4. 待审批的有效期由审批自带的 `expiresAt` 决定（`approval-service.ts:61` 过了就拒绝）；推送的 `expiresAt` 取审批的 `expiresAt`。
5. 规则手册：`RuleGate = "mail_item" | "mail_delivery"`（`field-catalog.ts`）；结果有 `raise_floor`、`suppress_push`、`defer_to_quiet_hours`、（ADR 0213 新增）`require_notify`、`require_whole_thread`；每个闸门允许的结果有固定表（`rule-book.ts` 的 `GATE_OUTCOMES`）；规则类型注册表 `rule-types.ts`：每种类型写明闸门、结果、测试文件，没有测试的类型拒绝写入。
6. 决策记录输入里有 `floorHits`、`ruleHits`（`规则id@修订号`）、`ruleIds`，只有邮件检查写它们；推送的闸门命中目前没有地方记。
7. `AttentionPolicyService` 的第二份静默窗口已在 ADR 0212 删除。
8. 推送类别开关 `kinds`（主人在网页上开关哪几类推送）是现有的用户设置。

## 要求模型回答的问题

- 值不值得现在做？第一条会作用于另外四类推送的用户规则可以是什么（例如“夜里别提醒我”）？没有这样的规则时，统一闸门是不是没人用的代码？
- 闸门放在哪里、怎么跨五类共用？延后的通知存在哪里（给 `web_push_outbox` 加“延后到”列并迁移，还是不入队、等下一次收集再取，还是复用 `proactive_pushes`）？到点时要不要重新裁决？规则改过怎么办？
- 三个已知问题怎么解决：已入队的推送绕过闸门、提醒 6 小时窗口、审批在静默时段里过期；游标一次性消费的“任务完成”怎么延后？
- 哪些推送受规则管、哪些是不可触碰的？边界例子有哪些？
- 迁移要不要？结果类型怎么扩展？规则类型注册表怎么扩展？
- 网页上怎么让主人看懂“这条被延后/被拦下”并能撤销？
- 有哪些漏掉的场景、和业界成熟做法（手机专注模式、Gmail 过滤器、Slack 免打扰、PagerDuty 通知规则）不一致的地方？请附一手来源。
