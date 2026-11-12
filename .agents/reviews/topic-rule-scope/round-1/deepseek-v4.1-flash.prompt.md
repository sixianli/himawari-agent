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
仓库就是当前目录，已检出 cc2c9cc908be3d698cdb76587de43970b006f452。
问题、目标和约束：
# 方案讨论材料：判断主人一句话是“长期规矩”还是“只管一段时间/一次”

请先读代码，再从问题本身出发提出你认为最好的方案。这里只写问题、目标、约束和已核对的事实，不预设做法。

## 问题

Himawari 是 Andy 的个人助理。主人在对话里说一句话（例如“夜里别提醒我”“以后入管局的邮件必须提醒我”），主模型调用 `rule_set` 工具，把它立成程序强制执行的长期规则（ADR 0213、ADR 0244）。

主模型调用时自己填 `inferred`（是不是它推断的）。之后程序要决定：规则马上生效，还是先做成一张提议卡、等主人点“生效”。现在程序用写死的词表判断原话是不是“长期有效”：

- `apps/agent-service/src/production-owner-rules.ts` 第 54–260 行左右：`STANDING_MARKERS`（以后、必须、always…）、`QUIET_REQUEST_MARKERS`（别提醒我…）、`RECURRING_TIME_MARKERS`（夜里、周末…）、`ONE_OFF_MARKERS`（今天、这个周末、下个月、暂时…，约 90 个）、`STANDING_STARTS`。
- 判断函数 `isStandingQuote`，第 450 行；用在第 799–801 行：`!input.inferred && isStandingQuote(quote) && ownerSaid(...)` 才直接生效，否则存成提议。
- 测试：`test/integration/production-memory-capture.test.ts` 第 2097–2139 行。

PR 414 做了 6 轮代码复核，每轮都找到词表漏掉的新说法（例如“这个周末别提醒我”被当成长期静默）。说法是开放的，词表收不全。Andy 已同意不再用词表，改成让模型读整句判断。

另一个已核对的事实：规则记录没有“到期”的概念（`packages/application/src/rules/rule-types.ts`、`rule-book.ts` 里没有 expires/until 字段）。所以即使正确认出“这个周末别提醒我”是限时的，现在也只能变成一张“永久规则”的提议卡，主人点了就成了永久规则。

## 目标

1. 主人一句话的时效（长期 / 到某个时刻为止 / 只管眼前这一件）由模型读整句话判断，不用词表。
2. “用户主权”优先：模型不能把一次性的话变成永久规则后悄悄执行；主人明说的长期规矩不该让他多点一下。
3. 判断错的代价看得见、可撤销。

## 约束

- 产品原则冲突时的顺序：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率（`docs/product-vision.md`）。
- Andy 已定（ADR 0213 第 32 行）：明说的直接生效、回执卡上给试算、一键撤销；模型推断的只生成提议，主人点头才生效。
- 只能用便宜模型：生产经 Magpie 调 DeepSeek V4.1 Flash 一类模型；不得调用 Claude/OpenAI 按 token 付费的模型；不得写死模型名。
- 发给模型的内容只能往后追加，系统提示和工具定义按对话冻结；改工具定义会让老对话重建一次缓存（`.claude/rules/prompt-prefix.md`）。PR 414 还没上线，它本身已经让工具定义变一次。
- 不许写死能动态获取的东西；代码里不写注释。
- 已有的旁路模型调用例子：起对话标题 `apps/agent-service/src/production-thread-titles.ts`；邮件判断 `packages/application/src/services/proactive-mail-check-service.ts`。
- 规则类型目前三种：`mail_must_notify`、`mail_read_whole_thread`、`push_quiet_hours`（PR 414 新增）。词表对所有类型通用。

## 已查的业界资料（一手）

- Anthropic 建议用轻量模型单独做一次分类、用结构化输出限定答案：https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks
- OpenAI 护栏 cookbook：用便宜快速的模型和主模型并行做分类，权衡准确、延迟、费用：https://developers.openai.com/cookbook/examples/how_to_use_guardrails
- ChatGPT 定时任务的工具提示（2025 年泄露版）：一次性用相对偏移 `dtstart_offset_json`，重复用 iCal RRULE：https://simonwillison.net/2025/Jan/15/chatgpt-tasks/
- iPhone 专注模式可选“1 小时”“到今晚”“直到离开此地”：https://support.apple.com/guide/iphone/turn-a-focus-on-or-off-iph5c3f5b77b/15.0

## 请回答

1. 你的方案：谁来判断时效、输出什么结构、程序怎么核对、限时的说法最后怎么执行。
2. 是根因修复还是表面修补，为什么。
3. ChatGPT / Claude / Google 遇到同样情况怎么做，用户会看到什么。
4. 会不会改变模型已经见过的请求开头（工具定义、系统提示）；怎样把影响降到最小。
5. 失败路径：判断模型超时、出错、两边说法不一致、主人说法含糊时怎么办。
6. 怎样测试（包括反向用例）而不依赖真模型的随机性。
