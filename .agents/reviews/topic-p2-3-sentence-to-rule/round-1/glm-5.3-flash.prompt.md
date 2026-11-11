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
仓库就是当前目录，已检出 cb56223cc7553f6679fe656839bceb2746c44f81。
待审核的方案：
# P2-3 一句话变成长期规则：线程的实施方案（交双模型审核）

## 前提（每条附来源和原话）

1. 主人明说“以后 / 一律……”直接生效 + 回执卡（试算例子、一键撤销）；模型推断出来的只作提议，主人点头才生效；只说一次的话不变成规则。来源：`docs/adr/0209-rule-book-with-cel-expressions-and-judge.md` 第 58 行（决定 6）。Andy 2026-11-11 在线程里再次选定这个方式。
2. 规则手册存“主人的参数（JSON）”，表达式由程序按参数生成，参数是唯一来源。来源：同文件第 54 行：“这两条的表达式不存库，由程序按存下来的参数生成，所以参数是唯一来源。”
3. 让模型译表达式之前要先补求值次数上限或禁止嵌套 exists/all。来源：同文件第 108 行。
4. 规则手册的表：`rule_book_rules(owner_id, agent_id, rule_id ≤64 字符, revision, parameters JSON 对象, status ∈ active/needs_review/retired, source ≤256 字符, source_memory_id, updated_at)`，历史表只追加。来源：`packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql`（rule_book_rules_next 建表语句）。
5. 规则类记忆被改/取代/删除时，数据库触发器把 `source_memory_id` 指向它的规则标“待重审”并写决策记录；`source_memory_id` 由第 4 步（本块）填写。来源：`docs/adr/0211-...md` 第 50、92 行。
6. 邮件检查已经能接收额外规则：`ProactiveMailCheckOptions.ownerRules`（`packages/application/src/services/proactive-mail-check-service.ts` 第 109 行），但生产没有接上；读规则的 SQL 只认两个固定 id（`packages/persistence-sqlite/src/sqlite-proactive-operations.ts` 第 232 行起）。
7. 邮件检查会读同一件事的旧邮件：同一 Gmail 串整串取回，但和标题、编号搜到的旧邮件合起来只留最近 `perMail`（默认 6）封。来源：`packages/platform-node/src/gmail-related.ts` 第 162 行 `byMail.set(item.messageId, ordered.slice(-limits.perMail))`；`docs/adr/0180-...md` 决定 1、3。
8. 愿景：“对退款、预订、付款是否办结，必须读完线程全文并搜后续确认/收据才下结论，绝不只看标题。”来源：`docs/product-vision.md` 第 133 行。
9. 决策记录逐封邮件有主人评价：`proactive_processed_messages.owner_rating ∈ useful/unneeded/missed`，并记着当时的结论 `outcome` 和所属检查 `decision_id`；每次检查发给模型的内容加密存在 `decision_ledger_payloads`（role = model_input）。来源：`0087_rule_book_memory_link.sql` 中这两张表的建表语句；ADR 0147。
10. 应用内工具的现成写法：提醒工具 `reminder_set`（`apps/agent-service/src/production-reminder-writer.ts`）——工具描述登记在提示词目录 `packages/prompt-catalog/src/tools.ts`，执行时经 `production-runtime-tools.ts` 的 `#ownerScoped` 做幂等，写记忆用 `DurableMemoryService.applyProposal`。
11. Pi 加工具的官方写法是自定义工具；后台单次模型调用一律走 `pi-model-transport.ts`。来源：`docs/pi-development-guide.md` 第 116、244 行。
12. 系统提示和工具按对话冻结；工具集合变了，老对话在下一轮开始时换新一次并留记录。来源：`.claude/rules/prompt-prefix.md` 第 6、7 条。
13. Himawari 给不会编程的人用，用户侧功能须在产品内闭环；不许写死，能动态获取的一律动态。来源：Andy 2026-11-10 项目聊天原话（协调者转达）；项目指令第 14 条。

## 对标

- ChatGPT 的“记忆 / 自定义指令”和 Claude 的 Project instructions：主人说“以后……”，产品直接记下并在界面上给一条“已更新记忆”的提示，可点进去删除，不弹确认框。但它们只是“给模型看的文字”（软偏好），不保证执行。本块多做的一层是：能表达成规则类型的，交给程序必定执行。
- 这是根因做法：现在主人的常设要求只能存成记忆文字，执行靠模型概率性遵守；本块让它进规则手册由裁判执行。

## 方案

### 1. 规则类型（代码，带测试）——不需要改表

新文件 `packages/application/src/rules/rule-types.ts`。一种规则类型 = 闸门 + 结果 + 参数校验 + 由参数生成 CEL 表达式 + 由参数生成试算例子 + 指定测试文件。第一版只有 Gmail 主动检查两种：

| 类型 id | 闸门 | 结果 | 参数 |
|---|---|---|---|
| `mail_must_notify` | `mail_item` | `raise_floor`（已有：模型判“不用管”也至少提醒主人看一眼并推送） | `senderDomains[]`、`senderAddresses[]`、`phrases[]`（按子串匹配，任何语言）、`words[]`（英文整词，匹配 `text_words`） |
| `mail_read_whole_thread` | `mail_item` | 新结果 `require_whole_thread` | 同上 |

- 参数限制：每个列表 ≤ 32 项，每项 1–64 字符，不含代理项；域名、地址格式校验；至少一个列表非空。表达式只用 `in`、`contains`、`exists`（一层），不嵌套，所以不需要先补求值次数上限（前提 3）。
- 每个类型在注册表里写明 `tests: "<测试文件路径>"`。写入时类型没有 `tests` 就拒绝（`RULE_TYPE_UNTESTED`）。
- 新检查（并入 `npm run check` 的 `check:rule-registry`）：每个注册的类型，测试文件必须存在，且含 `describe("[rule-type:<id>]"` 的用例，不得 `.skip`；反向用例：删掉一种类型的测试文件，检查失败。
- 每种类型的测试：正例、反例、参数被拒的例子、生成的表达式过裁判白名单；`mail_read_whole_thread` 的测试还覆盖下面第 3 节的执行。

### 2. 主人的规则存在哪——不需要改表

- 存进已有的 `rule_book_rules`：`rule_id = "owner:" + 随机`，`parameters = { "type": <类型 id>, "params": {...}, "summary": <一句话说明> }`，`source = "chat:<threadId>"`，`source_memory_id = <规则类记忆 id>`。历史照旧只追加。撤销 = 状态改 `retired`、修订号加 1、写历史。
- 理由：前提 2 已定“库里只存参数”；表达式和试算例子随类型代码重新生成。表结构不变，所以不占改表排队。
- 读：`readSettings` 旁边加 `readOwnerRules`，按 `rule_id LIKE 'owner:%'`、状态 active/needs_review 取出，在应用层用类型注册表还原成 `RuleRecord`；遇到不认识的类型或参数不合法的行，不执行并写一条决策记录（不悄悄忽略）。
- 生产接上 `ownerRules`（前提 6）。

### 3. “必须看整个邮件串”怎么由程序保证

- 邮件检查在找旧邮件之前先算 `require_whole_thread` 的命中。
- 读取器 `related()` 增加入参 `wholeThread: Set<messageId>`：这些邮件同一 Gmail 串里比它早的邮件全部保留（不受 `perMail` 截断），上限放配置 `runPolicy.proactive.wholeThreadMessagesPerMail`（默认 50）、`wholeThreadCharactersPerMail`（默认 60000）；返回每封是否读全 `threadComplete`。
- 命中的邮件如果整串没读全（读取失败、超上限、字数截断），模型给出的“不用管 / 知道就行”不采信，结论至少升到 `check` 并推送，决策记录 `ruleHits` 记规则 id 和原因 `thread_incomplete`。读全了就照模型的结论。
- 不改发给模型的固定说明；邮件数据里已有的 `related`、`relatedUnavailable` 照用。

### 4. 一句话怎么变成规则：Agent 工具（照提醒工具的写法）

- 新工具 `rule_set`、`rule_list`、`rule_undo`，描述登记进提示词目录。`rule_set` 参数：`quote`（主人原话）、`type`（规则类型 id 或 `soft`）、`params`、`summary`。起草由正在对话的模型完成（就是这次对话请求本身，走统一出口和遮盖）；模型写的是参数，不是表达式。
- 程序校验：类型已注册且有测试；参数合法；`quote` 必须逐字出现在本对话最近几条主人消息里才算“明说”→ 直接生效；对不上或模型标了“推断” → 只生成提议，不生效。
- 写入顺序：先用确定的 id 写规则类记忆（`category = rule`，内容 = 原话 + 规则说明，出处 = 对话），再写规则手册行（`source_memory_id` 指向它）。两步都按 `runId + toolCallId` 幂等，重试不重复。
- `type = soft`：只写一条偏好类记忆（给模型看的文字，走现有记忆注入），回执卡写明“不会由程序强制执行”。
- 只说一次的话不调用工具（工具描述里写明）。

### 5. 历史回放

- 写入前，用新规则在最近 `runPolicy.proactive.ruleReplayDays`（默认 30 天）的邮件检查记录上重跑：取每封已判断邮件当时发给模型的内容（解密 `model_input`），或被判“不用管”邮件存下的发件人和标题，重算字段，用裁判判断新规则命中与否。
- 列出：会改变结论的邮件数；其中主人评过“有用”的邮件（逐封：日期、发件人、标题、当时结论 → 新结论）；和内置规则重叠的数量。
- 近似说明：回放用的是当时遮盖后的内容，正文可能比当时算规则用的摘要更长，所以只会多报、不会少报；卡上写明。

### 6. 回执卡和撤销（网页内闭环）

- 聊天里 `rule_set` 的结果显示成回执卡：规则说明、类型（硬 / 软）、主人原话、2–4 个试算例子（“这封会提醒 / 这封不会”）、回放结果、[撤销] 按钮；提议卡显示 [生效] [不要]。
- 新网关接口：撤销、确认提议、列出规则；三语文案；设置页“规则”一栏列出主人的规则（含待重审标记和“重新确认”）。
- Playwright 用例：正向（明说 → 卡出现 → 撤销后规则消失）、反向（只说一次的话不出卡；推断的话出提议卡不生效）。

### 7. 验收

- Andy 给的 3 条原文：①涉及退款必须看整个邮件串；②日本入管局相关的邮件以后必须通知我；③订阅相关的必须提醒我（理解为付费订阅的扣款、续费、试用到期、涨价、取消；不含新闻通讯）。
- 每条：真实模型把原话译成参数 → 程序校验 → 写入 → 用构造的邮件跑一次真实邮件检查流程，正例命中、反例不命中。
- 用例在 DeepSeek V4.1 Flash 和 GLM 5.3 Flash 上各跑一遍（经 OpenCode Go 套餐），跑前报费用。

### 8. 不做的

- 不让模型写自由 CEL 表达式（等补了求值上限再说）；不做五类推送的统一闸门；不做其他规则类型（记忆、动作）。
- 不改系统提示；只加工具（老对话下一轮换新一次，有记录）。

## 想请审核重点看的

1. 不改表、把主人规则存进 `rule_book_rules.parameters` 是否有问题（id 前缀、状态、历史、触发器）。
2. “原话逐字出现在主人消息里 = 明说”这个判定是否够；有没有更稳的做法。
3. 整串读取的上限和“读不全就升级”是否会误报太多。
4. 回放的近似是否可接受。
5. 工具集合变化对 KV 缓存的影响。
