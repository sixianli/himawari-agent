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
仓库就是当前目录，已检出 979a3121d8e004becb751630dec10015c9eed7a2。
问题、目标和约束：
# 方案材料：用户硬规则第 2 步（通知闸门和金额字段）

## 背景

Himawari 是给不会用编程工具的人用的（ADR 0083：一个人一个实例），用户侧功能必须在产品内闭环。上一步（PR 361，已合并）建好了“规则手册”：每个实例（主人加 Agent）有一组规则，每条规则是一行数据，用 CEL 表达式（`@marcbachmann/cel-js` 8.0.0 外加白名单）写条件，加一个结果；程序里只有一个裁判 `RuleJudge.decide(gate, facts, rules)`。代码在 `packages/application/src/rules/`，设计见 `docs/adr/0209-rule-book-with-cel-expressions-and-judge.md`。现在手册里有四条规则：重要发件人、公共机构域名后缀、金钱词（这三条都是“地板规则”，命中就不能把邮件判成不用管）和静默时段；表 `rule_book_rules`、`rule_book_history` 在迁移 0086。

最终方案（Andy 已同意，要照它做）的第 2 步：加“通知闸门”，所有发给主人的推送在入队前问裁判；先做静默时段和金额；邮件判断加金额字段；把两份静默时段的实现合成一份。下面是已核对的现状，**不含任何方案**。

## 目标

1. 一处管住全部五类推送（到点提醒、待审批、任务完成、邮件主动提醒、Muse 通道中断）：入队前过通知闸门，结果可以是“照常推送”、“延后到某时刻”、“不推送但仍留在提醒页”。
2. 静默时段、金额门槛都是规则手册里的规则，由裁判计算；结果要写进决策记录，写明是哪条规则、哪一版。
3. 邮件判断要读出金额（整数最小单位加币种加可信度），规则可以用它；金额读不出来或不确定时，建议照常推送，免得漏掉付款。
4. 只有一份静默时段的实现。
5. 不让“发给模型的内容”改写已发出的部分（`.claude/rules/prompt-prefix.md`：只追加；系统提示和工具按对话冻结；后台调用固定的在前、会变的在后）。

## 约束

- 不改变任何现有行为之外的东西：每一处行为变化都要写在 ADR 里并有测试。
- 规则内容是数据，规则执行是程序；用户的规则只存参数，表达式由代码生成（ADR 0209）。
- 每条规则要自带“该命中、不该命中”的例子，加载时自动跑。
- 每个 PR 要有迁移契约测试、对照测试；不得用假替身；改表结构的迁移号连续（下一个 0087），ADR 号下一个 0210。
- 界面上的数字和判断词要有可验证的定义；用户在网页上看到的推送延后、被规则拦下，都要能看懂、能撤销，不依赖开发线程。
- 费用：硬规则执行不花 token；邮件判断多输出一个字段，提示词会变一次（后台调用，非对话开头）。

## 已核对的现状（文件与行号）

1. 五类推送都由 `apps/agent-service/src/production-web-push.ts` 的 `#collect`（第 315 行起）收集后调 `store.enqueue` 入队，发送由 `#deliver` 做。`#collect` 和 `#deliver` 里没有任何静默时段或规则判断（该文件里搜不到 “quiet”）；`#deliver` 只判断：过期、推送类别开关（`kinds`）、主人正在看页面（`presence.anyVisible`）。
2. 出站表 `web_push_outbox`（`0058_web_push.sql:22`）的 `kind` 只有 `reminder`、`approval`、`run` 三种；邮件主动提醒和 Muse 中断都用 `kind = 'reminder'`，靠 `source_key` 前缀（`proactive:`、`muse-channel:`）区分。表里没有“延后到”的列；`web_push_attempts` 有 `next_attempt_at`（发送重试用）。
3. 邮件主动提醒已经有自己的延后队列：表 `proactive_pushes`（`ready_at`、`status = 'pending'|'enqueued'`），`proactive-mail-check-service.ts:1290-1300` 用 `quietEnd(...)`（`packages/application/src/services/proactive-rules.ts`）算 `readyAt`，同一时段同一个 `readyAt` 的多条合成一条（`store.pendingPush`）；`production-web-push.ts` 经 `proactive.listReady(now)` 取到点的并 `markEnqueued`。静默时段的设置来自规则手册（`readSettings`）。
4. 另有一份静默时段实现：`packages/application/src/services/attention-policy-service.ts:71` 的 `isQuietHours`（单个时间窗加 UTC 偏移，命中时把 NOTIFY 降为 DIGEST）。生产代码里没有 `new AttentionPolicyService`，只有测试夹具 `apps/agent-service/test/fixtures/local-composition-root.ts:202` 和 `packages/testing/test/attention-policy.unit.test.ts` 用它。
5. 到点提醒来自 `reminders.listDue`（`production-web-push.ts:293`），窗口 `REMINDER_WINDOW_MS`；待审批来自 `listApprovals`；任务完成来自 `store.listFinishedRuns` 的游标。
6. 邮件判断提示词在 `packages/prompt-catalog/src/mail.ts` 的 `MAIL_JUDGMENT`（输出 JSON `{"items":[{"id","result","confidence","todo","priority","dueAt","reason"}]}`），解析在 `proactive-mail-check-service.ts:461` 的 `parseJudgements`，没有金额字段。后台调用的排列：固定的提示在前，邮件数据段、当前时间（`MAIL_JUDGMENT_NOW`）在最后。
7. 规则手册现状：`RuleJudge` 的闸门名有 `mail_item` 和 `mail_delivery`；字段目录在 `packages/application/src/rules/field-catalog.ts`，其中 `mail_delivery` 的字段是 `local_minutes`、`local_weekday`、`local_previous_weekday`；结果有 `raise_floor` 和 `defer_to_quiet_hours` 两种。规则的结果类型不够表达“不推送但留在提醒页”。
8. 决策记录里现在写的是地板规则的 id（`floor_*`），没有规则 id 和版本号字段（ADR 0209 后果一节：留到第 2 步）。
9. 迁移 0086 的 `rule_book_rules` 里每个实例一条 `quiet_hours`、一条 `floor_important_sender`，`parameters` 是 JSON；历史表只追加。
10. 时区：邮件检查服务有 `timeZone` 选项（`proactive-mail-check-service.ts`），推送服务 `production-web-push.ts` 有 `#formatTime`；主人的时区来自配置。

## 要求模型回答的问题

- 通知闸门放在哪里、怎么跨五类推送共用？延后的通知存在哪里（复用已有的 `proactive_pushes`，还是新表）？到点时重新裁决一次，规则改过怎么办？
- 金额字段：怎么从邮件读出、怎么存、规则里怎么引用？“字段缺失怎么算”怎么写进规则？
- 哪些推送类别受静默时段管（待审批、Muse 通道中断是否该延后）？需要哪些边界例子？
- 两份静默时段实现怎么合成一份？
- 迁移怎么设计（要不要新表、新列）？结果类型怎么扩展？
- 有哪些漏掉的场景、和业界成熟做法不一致的地方？请附一手来源。
