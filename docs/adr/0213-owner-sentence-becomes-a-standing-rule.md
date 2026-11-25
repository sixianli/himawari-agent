---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-11"
covers: "evals/owner-rule/result.json, packages/application/src/rules/rule-book.ts, packages/application/src/rules/rule-types.ts, scripts/evals/owner-rule-live.eval.ts, test/tooling/rule-type-tests.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0213：主人的一句话变成长期规则，由测过的规则类型执行

> 2026-11-25 补：Gmail 检查不再调用模型逐封判断，新邮件改为进收件箱、由主对话里的她自己决定要不要告诉主人（[ADR 0285](0285-one-main-thread-subthreads-and-one-inbox.md) 第 1 步，PR 648）。本文里关于邮件判断提示词、判断结果和判断前带给模型的内容的部分已不再执行；规则手册、决策记录等其余部分照旧。

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
4. 工具集合变了，老对话换新一次是允许的：`.agents/instructions/prompt-prefix.md` 第 6 条，“工具集合变了（工具名，或者去掉说明文字后的参数结构）……才换新一次，并且每次都留记录”。
5. 邮件检查原来只把主题和摘要交给规则：`packages/application/src/rules/rule-book.ts` 原 `mailItemFacts` 里 `const text = \`${item.subject}\n${item.snippet}\``。
6. 原来的“抬升”不推送：`proactive-rules.ts` 的 [applyFloor](https://github.com/sixianli/himawari-agent/blob/9a395ec730b7c96519309bf1199355a04d8199aa/packages/application/src/services/proactive-rules.ts) 把“不用管”改成“值得知道”，推送条件是 `dueSoon || (final.result === "check" && floor)`。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **规则类型注册表。**新文件 `packages/application/src/rules/rule-types.ts` 列出主人能立的规则类型，每种类型写明闸门、结果和测试文件路径。现有两种：
   - `mail_must_notify`：某类邮件一定提醒并推送（新结果 `require_notify`：模型判什么都改成“要你看”并推送，`act` 不动）。
   - `mail_read_whole_thread`：某类邮件判断前读完同一邮件串的全部往来（新结果 `require_whole_thread`：读不全、读取失败或找不到这个邮件串，就改成“要你看”并推送；模型判“要你做事”的不动，因为那已经交给主人）。
   两种规则在当天模型额度用完、邮件没有被判断时，命中的邮件同样直接交给主人看并推送，和内置的抬升规则一样。
   没有测试文件的类型写入时拒绝（`RULE_TYPE_UNTESTED`）；读到不认识的类型或参数不合法的行时不执行，规则列表里标“暂时没有执行”。
2. **参数而不是规则语言。**参数只有发件域名（含子域名）、发件地址、词语、英文整词和排除词，每列最多 32 项、每项 1 到 64 字（词语至少 2 字），拒绝不可见字符和正则；规则说明最多 200 个 UTF-16 单位（和网页契约同一口径，一般汉字算 1，emoji 算 2）、不能有换行；整组参数存进库前不超过 16384 字；写入时统一全半角和大小写、去重排序。表达式和正反例都由程序按参数生成，排除词把所有命中都排除掉的参数直接拒绝。
3. **匹配范围加正文。**规则字段新增 `content_folded`（主题加正文，读不到正文用摘要，统一全半角和大小写）和 `content_words`（其中的英文整词）。内置规则仍用原来的 `text`，行为不变。
4. **存储不改表。**主人规则存进现有 `rule_book_rules`，`rule_id` 以 `owner:` 开头，`parameters` 存 `{type, params, summary}`，`source_memory_id` 指向同时写入的规则类记忆。邮件检查每次检查前读一遍，写入或撤销后下一次检查即生效。
5. **对话工具。**`rule_set`、`rule_list`、`rule_undo` 三个工具，描述登记在提示词目录。直接生效要同时满足三条：模型没标“推断”、原话是本对话最近 200 条消息中、最近 6 条主人消息里完整的一句或连续几句（按句号、逗号、换行这类标点切开后整句相同，至少 4 个字；只截一句里的半句不算，防止把“这封必须提醒我”里的“必须提醒我”拿去配上别的条件）、原话带“以后、一律、必须、always”这类表示一直有效的字样，并且至少有一个分句带这类字样、同一分句里不带“这封、这次、今天、刚才那封、this time”这类只指这一次的字样，也不带“再说、再看、回头、later”这类推迟的字样（“从今天开始，以后每次……”和“今天起每次都提醒我”算明说，“这封必须提醒我”和“这封先不用管，以后再说”不算；英文字样按整词匹配，mustard、must2fa 不算 must）；否则只存成提议（加密存在载荷库，不进规则手册），主人在回执卡上点“生效”才写入。同一组参数已经有规则时返回那一条，不新建，那条规则在等重新确认的话按“重新确认”处理（出处记忆一起恢复）；同一组参数、同一句原话和说明的提议只存一份；撤销后再点同一张提议卡的“生效”，或对待重新确认的规则点“重新确认”，规则和规则类记忆一起恢复，出处记忆已删除的会报错、要主人重新说，不会把删掉的记忆重新建出来（网页上目前只显示“操作失败”，还看不到“请重新说一遍”这句，留到网页验收时一起补）；恢复记忆后规则改状态失败的（再次确认和重新确认都一样），把这次恢复的记忆重新归档再报错；规则已达上限时先报错，不动记忆；每人最多 32 条生效规则。撤销时先归档对应的规则类记忆、再停用规则，归档失败就报错且规则照常执行，再撤销一次即可（记忆已在回收站或已删除的不算失败），不会出现规则已停用而模型仍看得到这条规矩；写规则失败时把刚写的规则类记忆归档，不留孤儿。语气、格式这类偏好记成偏好记忆，不由程序执行，也要是主人原话（不是推断）才记。
6. **历史回放。**新规则在近 30 天、每种结论最多 300 封已判断的邮件上重算：优先用当时发给模型的内容，取不到时用存下的发件人和标题。回执卡列出命中数、会改变处理的数（“一定提醒”规则写“会改成要你看”，“先读整串”规则写“以后先读完整串再判断”），以及其中主人评过“有用”的邮件（最多 20 封），并写明这是估计。
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
- 整串交给模型的上限是每封 50 封、6 万字（配置项 `wholeThreadMailsPerMail`、`wholeThreadCharactersPerMail`），超出即判“读不全”并推送；从 Gmail 取邮件串本身是一次请求，按原来的每次检查请求预算计数；同一封邮件只处理一次，不会重复推。
- 规则手册仍不在数据导出范围内（ADR 0209、0211 已写明）；规则说明会进决策记录的依据抽屉。
- 回放拿不到“这封是主人自己发的”这一信息，实时检查不对主人自己发的邮件执行主人规则，所以回放可能多算这类邮件。
- 主人把别人写的文字粘贴进对话，这段文字也算主人的消息，里面带“以后……必须……”的整句可以直接立规则。模型照工具说明不会这样做；程序只能保证原话来自主人发的消息，分不出是手打还是粘贴。
- 两家模型实测（2026-11-11，OpenCode Go 套餐，5 个用例各 3 次，结果在 `evals/owner-rule/result.json`，脚本 `scripts/evals/owner-rule-live.eval.ts`）：DeepSeek V4.1 Flash 15/15，GLM 5.3 Flash 14/15，没达到脚本默认的全部通过门槛（`EVAL_MINIMUM_PASS_SHARE=1`）。没过的一次是把订阅规则标成了推断，只会变成要主人点头的提议，不会自己生效。实测花钱，不在自动检查里跑。
- 一封邮件命中的规则在决策记录里最多记 16 条（和原有的存储上限一致），超出的照样执行，只是记录里看不到。
- 推迟字样按包含匹配，“再说明”“回头客”这类词也会让原话只变成提议，要主人点一下；方向是安全的。
- 原话里带密码、验证码这类凭据的值（只提到“密码”两个字不算），或带证件号、银行卡号时，规则照样建立，原话按 `sensitive`（敏感）保存，和其他带这类信息的记忆一样；不拒绝建规则，因为规则本身只用域名、地址和词语，原话里的卡号不进规则表达式（Andy 2026-11-11 选定）。
- 不改表，没有迁移。

[返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0209](0209-rule-book-with-cel-expressions-and-judge.md)：规则手册、裁判。
- [ADR 0211](0211-hard-rule-points-back-to-its-rule-memory.md)：规则记着来源记忆，待重审。
- [ADR 0180](https://github.com/sixianli/himawari-agent/blob/9a395ec730b7c96519309bf1199355a04d8199aa/docs/adr/0180-gmail-check-reads-earlier-mail-about-the-same-matter.md)：邮件检查读以前的往来邮件。
- [ADR 0165](0165-freeze-the-request-head-per-conversation.md)：系统提示和工具按对话冻结。
- [Agent 规则清单](../agent-rulebook-inventory.md)：H-15（读以前的往来邮件）、H-17、H-18（本 ADR 新增的两种规则）。
- [ADR 0233](0233-rule-book-joins-the-data-export.md)：规则手册进入数据导出（后续）。

[返回阅读导航](#contents)
