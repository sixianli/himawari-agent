---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-11"
---

# ADR 0213：主人的一句话变成长期规则，由测过的规则类型执行

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [业界怎么做](#industry)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

任务块 P2-3 要求：主人在对话里说一条常设要求（例如“涉及退款必须看整个邮件串”“日本入管局相关的邮件以后必须通知我”“订阅相关的必须提醒我”），系统把它变成程序执行的长期规则，同时写规则类记忆作为出处，并在历史决策上回放给主人看；没有测试的规则类型不得写入。

[ADR 0209](0209-rule-book-with-cel-expressions-and-judge.md) 已有规则手册和裁判（CEL 表达式，CEL 是一种只能求值、不能执行任意代码的表达式语言），[ADR 0211](0211-hard-rule-points-back-to-its-rule-memory.md) 让规则记着来源记忆。但此前规则只有程序内置的几条和主人在设置页填的两种，主人在对话里说的话只会进记忆、靠模型自己记住。

Andy 在 2026-11-11 定了两点：明说“以后/一律/必须”的直接生效、回执卡上给试算、回放和一键撤销；模型推断出来的只生成提议，主人点头才生效（他选“2 按你的建议”，以及“按照你的建议”同意改动清单）。

[返回阅读导航](#contents)

<a id="premises"></a>

## 前提

1. 规则是程序执行的硬性设定，记忆只保存出处：`AGENTS.md` 的“产品愿景”一节写“Andy 定的规则是硬性设定，不是记忆：规则写进程序、必定执行、每条有回归测试”。
2. 规则手册只存参数、表达式由程序生成：[ADR 0209](0209-rule-book-with-cel-expressions-and-judge.md) 决定里写“这两条的表达式不存库，由程序按存下来的参数生成，所以参数是唯一来源”。
3. 待重审的规则照常执行：[ADR 0211](0211-hard-rule-points-back-to-its-rule-memory.md) 写“待重审的规则照常执行”，并把“重新确认”按钮留给后续。
4. 工具集合变了，老对话换新一次是允许的：`.claude/rules/prompt-prefix.md` 第 6 条，“工具集合变了（工具名，或者去掉说明文字后的参数结构）……才换新一次，并且每次都留记录”。
5. 邮件检查原来只把主题和摘要交给规则：`packages/application/src/rules/rule-book.ts` 原 `mailItemFacts` 里 `const text = \`${item.subject}\n${item.snippet}\``。
6. 原来的“抬升”不推送：`proactive-rules.ts` 的 `applyFloor` 把“不用管”改成“值得知道”，推送条件是 `dueSoon || (final.result === "check" && floor)`。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **规则类型注册表。**新文件 `packages/application/src/rules/rule-types.ts` 列出主人能立的规则类型，每种类型写明闸门、结果和测试文件路径。现有两种：
   - `mail_must_notify`：某类邮件一定提醒并推送（新结果 `require_notify`：模型判什么都改成“要你看”并推送，`act` 不动）。
   - `mail_read_whole_thread`：某类邮件判断前读完同一邮件串的全部往来（新结果 `require_whole_thread`：读不全或读取失败就改成“要你看”并推送）。
   没有测试文件的类型写入时拒绝（`RULE_TYPE_UNTESTED`）；读到不认识的类型或参数不合法的行时不执行，规则列表里标“暂时没有执行”。
2. **参数而不是规则语言。**参数只有发件域名（含子域名）、发件地址、词语、英文整词和排除词，每列最多 32 项、每项 1 到 64 字（词语至少 2 字），拒绝不可见字符和正则；写入时统一全半角和大小写、去重排序。表达式和正反例都由程序按参数生成，排除词把所有命中都排除掉的参数直接拒绝。
3. **匹配范围加正文。**规则字段新增 `content_folded`（主题加正文，读不到正文用摘要，统一全半角和大小写）和 `content_words`（其中的英文整词）。内置规则仍用原来的 `text`，行为不变。
4. **存储不改表。**主人规则存进现有 `rule_book_rules`，`rule_id` 以 `owner:` 开头，`parameters` 存 `{type, params, summary}`，`source_memory_id` 指向同时写入的规则类记忆。邮件检查每次检查前读一遍，写入或撤销后下一次检查即生效。
5. **对话工具。**`rule_set`、`rule_list`、`rule_undo` 三个工具，描述登记在提示词目录。直接生效要同时满足三条：模型没标“推断”、原话逐字出现在本对话最近 6 条主人消息里、原话带“以后、一律、必须、always”这类表示一直有效的字样；否则只存成提议（加密存在载荷库，不进规则手册），主人在回执卡上点“生效”才写入。同一组参数已经有规则时返回那一条，不新建；每人最多 32 条生效规则。撤销时同时归档对应的规则类记忆。语气、格式这类偏好记成偏好记忆，不由程序执行。
6. **历史回放。**新规则在近 30 天、每种结论最多 300 封已判断的邮件上重算：优先用当时发给模型的内容，取不到时用存下的发件人和标题。回执卡列出命中数、会改变处理的数，以及其中主人评过“有用”的邮件（最多 20 封），并写明这是估计。
7. **网页。**网关新增查询 `memory.rules.read` 和命令 `memory.rule.respond`（撤销、确认提议、重新确认）。聊天里 `rule_set` 的结果显示为回执卡；记忆页新增“长期规则”一节。决策记录的依据抽屉用规则手册里的说明显示主人规则，不再显示“未登记的规则”。
8. **自动检查。**`npm run check:rule-registry` 加跑 `packages/application/test/rule-type-*` 和 `test/tooling/rule-type-tests.test.ts`：按注册表逐个检查测试文件存在、带 `[rule-type:<id>]` 标签、没有跳过写法、确实被这一步运行，并带反向用例。

[返回阅读导航](#contents)

<a id="industry"></a>

## 业界怎么做

- Gmail 的过滤规则就是声明式条件加动作：按发件人、“包含字词”“不含字词”组合，用户不写代码（[Gmail 帮助：Create rules to filter your emails](https://support.google.com/mail/answer/6579)）。本 ADR 的参数和排除词照这个形状。
- ChatGPT 的记忆可以由用户明说“记住……”保存，并在设置里查看和删除（[OpenAI Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq)）；但它只是给模型看的文字，不保证执行。本 ADR 让明说的要求进程序执行，记忆只作出处。
- 表达式求值沿用 ADR 0209 选的 CEL（[cel.dev](https://cel.dev/)）。

[返回阅读导航](#contents)

<a id="options"></a>

## 放弃的做法

- **让模型直接写 CEL 表达式。**任务块写明“不发明规则语言、模型起草条目不写代码”，而且模型写的表达式没法逐条有测试。
- **复用“抬升”表达“必须通知”。**抬升只把“不用管”改成“值得知道”，不推送（前提 6），达不到“通知我”。
- **新开提议表。**要改表结构，而改表要排队；提议放加密载荷库就够用，点“生效”时重新校验参数。
- **每轮后台抽取规则、不加聊天工具。**主人看不到回执、不能当场撤销，也多一次模型调用。
- **合成一个工具带 action 参数。**换新代价一样（前提 4），三个工具的说明更清楚。

[返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 工具集合多了三个，老对话下一轮开始时按前提 4 换新一次，系统提示和历史整段按全价算一次；之后照常命中缓存。
- 被判“不用管”的邮件只存了遮盖后的发件人和标题，回放可能少算正文里才出现的词；也可能多算：回放用的是发给模型的正文窗口，而当时规则只看主题和摘要。回执卡写明是估计。
- 整串读取上限是每封 50 封、6 万字（配置项 `wholeThreadMailsPerMail`、`wholeThreadCharactersPerMail`），超出即判“读不全”并推送；同一封邮件只处理一次，不会重复推。
- 规则手册仍不在数据导出范围内（ADR 0209、0211 已写明）；规则说明会进决策记录的依据抽屉。
- 不改表，没有迁移。

[返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0209](0209-rule-book-with-cel-expressions-and-judge.md)：规则手册、裁判。
- [ADR 0211](0211-hard-rule-points-back-to-its-rule-memory.md)：规则记着来源记忆，待重审。
- [ADR 0180](0180-gmail-check-reads-earlier-mail-about-the-same-matter.md)：邮件检查读以前的往来邮件。
- [ADR 0165](0165-freeze-the-request-head-per-conversation.md)：系统提示和工具按对话冻结。
- [Agent 规则清单](../agent-rulebook-inventory.md)：H-15、H-16、H-17。

[返回阅读导航](#contents)
