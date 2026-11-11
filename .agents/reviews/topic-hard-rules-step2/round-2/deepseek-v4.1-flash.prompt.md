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
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、问题、证据（文件:行引用的代码，或网址和原话）、你建议怎么改。把「证实的」和「推测」分开写。最后写：如果由你来定，你会怎样改这份方案，并逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 979a3121d8e004becb751630dec10015c9eed7a2。
待审核的方案：
# 线程的方案：用户硬规则第 2 步（通知闸门和金额字段）

## 前提与来源

1. 五类推送都经 `production-web-push.ts` 的 `#collect` 入队，该文件没有任何静默判断。来源：`apps/agent-service/src/production-web-push.ts:315-405`，`#deliver` 只判过期、类别开关、主人正在看页面（`:420-450`）。
2. 现在只有邮件主动提醒受静默时段管，办法是创建推送时算 `readyAt`。来源：`packages/application/src/services/proactive-mail-check-service.ts:1290-1300`；`proactive_pushes.ready_at`（`sqlite-proactive-operations.ts` 的 `listReadyPushes`）。
3. `AttentionPolicyService` 的静默判断生产代码不用。来源：`grep "new AttentionPolicyService"` 只在 `apps/agent-service/test/fixtures/local-composition-root.ts:202` 和 `packages/testing/test/attention-policy.unit.test.ts:59`。
4. 到点提醒由主人自己设时间，窗口 6 小时。来源：`production-web-push.ts:19`、`:293-299`。
5. 裁判现有两个闸门 `mail_item`、`mail_delivery`，结果 `raise_floor`、`defer_to_quiet_hours`。来源：`packages/application/src/rules/field-catalog.ts:9`、`rule-book.ts:4`。
6. 邮件判断输出没有金额字段，解析在 `parseJudgements`。来源：`packages/prompt-catalog/src/mail.ts`、`proactive-mail-check-service.ts:461`。
7. 最终方案（Andy 已同意）：通知闸门先做静默和金额；金额缺失时照常推送；邮件判断加金额字段；两份静默合成一份。来源：Claude Doc 最终版（https://claude.ai/artifact/PNvUTw6W4iw9YQiTKgT5Xk）“金额读不出来或不确定时怎么办？建议照常推送”。
8. 发给模型的内容只追加，后台调用固定的在前。来源：`.claude/rules/prompt-prefix.md` 第 15 条。

## 方案

1. **闸门改名并加字段。** `mail_delivery` 改名 `notification`（迁移里改 `quiet_hours` 那行的 `gate` 值）。字段：现有三个当地时间字段，加 `source`（`reminder`、`approval`、`run`、`mail`、`muse_channel`）、`amount_minor`（整数）、`amount_currency`（三位大写字母）、`amount_confident`（布尔）。金额三项标记为“可缺失”。
2. **缺失字段的算法写进裁判。** 规则引用了可缺失字段而这个事实没有时，这条规则算“不命中”，不报错，并在返回里记 `skipped: [规则 id]`。这样“金额读不出来就照常推送”是程序行为，不靠规则作者记得写。
3. **结果加一种：`suppress_push`**（不推送，提醒页仍保留）。每个闸门在目录里写明允许的结果，`notification` 闸门允许 `defer_to_quiet_hours`、`suppress_push`。
4. **`NotificationGate` 服务**（application 包）：`decide(item) → send | suppress`，每条命中带规则 id 和版本。`#collect` 对五类推送每条都问一次；`suppress` 的不入队，并写决策。邮件推送被拦下时，`proactive_pushes` 记 `suppressed`（新状态），不再每轮重复取到。
5. **静默只保留一份实现。** 邮件创建推送时算 `readyAt` 的办法不变，它已经走规则手册和裁判；删掉没人用的 `AttentionPolicyService` 的静默窗口（`quietHours` 配置、`isQuietHours`、`quiet_hours` 降级），夹具和测试同步改。
6. **静默默认只管邮件**，不改变其他四类的现有行为。理由：主人自己设的 06:30 提醒是他明确下的指令，用默认静默把它推到 07:00 会违背他的意思（用户主权排在效率前）；待审批和 Muse 中断有时效。方案文档里“23:30 到点的提醒延后到 07:00”的例子，改由第 4 步主人一句话说“夜里别提醒我”生成的规则来实现，闸门已经支持（规则里用 `source` 字段）。这条与最终方案文档的例子不同，要 Andy 定。
7. **金额字段。** 邮件判断可选输出 `"amount":{"value":"100.00","currency":"CNY","confidence":"sure"}`，只在 act、know 里有金额时写。程序按 ISO 4217 小数位表把 `value` 换成整数最小单位（JPY 0 位、CNY 和 USD 2 位、KWD 3 位），币种不在表里或数值格式不对就当没有金额，并记一次观察。存到 `source_insights` 的三个可空列。提示词只在固定部分末尾追加一句说明，数据段和时间照旧在最后；老对话没有影响（后台调用）。
8. **决策记录。** 新表 `rule_decisions`（只追加：实例、闸门、对象键、规则 id、版本、结果、时间），随 Agent 或主人一起删除时才能删。对象键用 `source_key`。
9. **迁移 0087**：`source_insights` 加金额三列；`proactive_pushes` 的 status 加 `suppressed`（重建表）；新建 `rule_decisions`；`rule_book_rules` 里 `quiet_hours` 的 gate 值改名。
10. **ADR 0210**：写明上面第 3、6 点和与最终方案文档的差异。

## 验证

- 对照测试：默认设置、无金额时，五类推送入队的内容与改动前完全一致（旧入队路径做参照）。
- 反向用例：金额缺失、币种不同、金额正好等于门槛、`unsure` 都照常推送；非邮件来源的推送不受静默默认规则影响；退休的规则不生效。
- 规则自带例子：金额门槛的边界例子由程序按比较符自动补。
- 迁移契约测试：旧库迁移后读回、历史只追加、重建表后外键检查通过。
- 提示词：`check:prompt-prefix` 通过；邮件判断解析对有无金额字段都能解析。

## 要 Andy 定的

- 静默默认是否只管邮件（线程建议：是，理由见第 6 点）。
