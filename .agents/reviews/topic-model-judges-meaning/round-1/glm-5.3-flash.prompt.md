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
仓库就是当前目录，已检出 44a0e332b4550b0ef7fdbb663552812d9b21fc97。
问题、目标和约束：
# 问题：把“用词表/正则判断用户意思”的 5 处改成模型判断，各自怎么改最好

## 背景和原则

Andy（主人）定的 agent 开发基本原则：理解用户的意思（意图、时间范围、语气、类别、是否相关、是否敏感等）一律交给模型判断，不用关键词表、正则、写死的词典。程序只做模型做不了或不该做的事：校验模型输出的格式、核对引用是否逐字出自原文、处理纯格式文本、以及“发给模型前遮盖密码和验证码”这类必须先于模型、每次结果一致的安全过滤（这一类保留，不在本题内）。

下面 5 处现在是词表/正则。请对每一处从问题本身出发，提出你认为最好的做法（包括“这一处其实不该改”或“只改一部分”）。我们列的现状和问题只是事实，不是倾向。

## 目标

1. 说法千变万化也不漏判、不误判；
2. 不让用户多等（对话主路径不增加模型调用，除非有强理由）；极在意钱，只能用低价模型（DeepSeek V4.1 Flash 一类，经 Magpie）；
3. 出错时的默认结果要安全（模型失败、超时、输出格式不对时怎么办要写清）；
4. 每个新增的模型调用都要说明：谁调、什么时候调、输入什么、输出什么结构、成本和延迟的量级、失败怎么办。

## 约束（来源在仓库里，可自行打开核对）

- 产品原则冲突时的顺序：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率（`docs/product-vision.md`）。
- 存入的记忆必须能被模型看到（ADR 0193）；敏感级别的记忆不给模型看，所以“是否敏感”判错有后果。
- 发给模型的内容只能往后追加；系统提示和工具定义按对话冻结，改工具说明只对新对话生效；固定的在前、会变的在后（`.claude/rules/prompt-prefix.md`）。
- 只能用低价模型；不写死能动态获取的值。
- 不顾旧数据兼容，要做彻底。
- 每个界面上的数字/判断词要有可验证定义（`.claude/rules/owner-standing-rules.md`）。

## 已核对的现状（main 44a0e332）

### ① 搜记忆时用正则猜时间范围
- `packages/memory-engine/src/time-scope.ts` 的 `parseTimeScope(query, now, timeZone)`：约 200 行正则，识别“以前/之前/去年/前天/上周三/3 个月前/last week”等，输出 `{includeHistory, from, to}`。`includeHistory` 决定是否搜已失效（被新情况取代）的历史记忆；from/to 给融合排序用（`packages/memory-engine/src/fusion.ts`）。
- 调用处：`apps/agent-service/src/production-memory-recall.ts:159`（模型调用 memory_recall 工具时）和 `packages/memory-engine/src/hybrid-memory-provider.ts:166`（调用方没传 scope 时兜底）。
- 模型调用工具时本来就能填 `from`、`to`（YYYY-MM-DD）、`includeHistory`（工具说明在 `packages/prompt-catalog/src/tools.ts:36`）；填了就用模型的，没填才用正则猜（`production-memory-recall.ts:160-183`）。
- 还有不经过工具的调用方：每轮对话开始前自动召回记忆（`packages/application/src/services/context-formation-service.ts:241`，`apps/agent-service/src/production-run-memory.ts:450`），主动提醒（`production-proactive-memory.ts:41`），整理记忆（`production-memory-consolidation.ts`），真实评测（`production-real-eval.ts:604`），外部 agent 经 MCP 的 find_memories 等。这些路径上没有模型替这次搜索填时间，所以正则是它们唯一的时间来源。
- 对话摘要（episodes）按日期存，工具说明里写“对话摘要按日期给出”。

### ② 记忆页导入和手动添加时用关键词分类、判断是否敏感
- `apps/control-center/src/memory-import.ts:29` `guessCategory(text)`：关键词→类别（health、finance、relationship、rule、preference、event、goal、project、other），命中健康/财务关键词就标敏感。导入解析（markdown 结构、去重、Task Group 等）是确定性解析，不在本题内；另有 `mentionsSensitiveMaterial`（密码、token、卡号等）和 `classificationWithIdentifiers`（证件号、银行卡、密码的确定性检测）属于安全过滤，保留。
- 手动添加表单（`memory-page.tsx:2210`）在用户打字时实时猜类别，用户可手动改下拉。
- 自动抽取路径（`production-memory-capture.ts`）已经由模型在同一次调用里给出 category、classification（private/sensitive/restricted）、topic，并叠加确定性的证件号/卡号检测。
- 导入可能一次几十到几百条；浏览器端解析，写入通过 API 带上客户端算好的 category 和 sensitive。

### ④ 记忆抽取时用停用词表判断“引用和已有记忆是否相关”
- `apps/agent-service/src/production-memory-capture.ts:148-176`：`GENERIC_TERMS`（一张中文停用词/虚词正则）+ 两字切分，`quoteRelatesToMemory(quote, memoryTexts)` 判断模型给出的原话引用和某条已有记忆有没有共同词。
- 唯一用处在 `:362-369`：当模型的决定是 unchanged/update/merge 且指向的是“待确认的规矩（tentative）”时，只有“引用逐字出自主人原话”且“引用和该待确认记忆相关”两项都成立，才算主人确认了这条规矩（规矩确认后会变成生效的硬规则）。逐字核对（`quoteFromOwnerMessage`）是确定性的防编造，要保留。
- 抽取提示词 `packages/prompt-catalog/src/memory.ts`（`MEMORY_CAPTURE`）已让模型给 existingMemoryId、quote、decision 等。

### ⑤ 真实记忆评测里用正则抽“时间说法”
- `packages/application/src/services/real-memory-eval.ts:91-170`：`chineseNumber`、`PART_OF_DAY`、`dateTokens`，被 `leaksAnswer(question, sources)` 使用。这是**出题阶段**的防泄露检查：模型根据一条记忆出一道问题后，检查问题文字有没有把答案带出来（字符 n-gram 重叠、数字重叠、时间说法重叠，三种方式）。n-gram 和数字重叠是语言无关的字符串比较；时间说法归一化（“下午三点”=“15 点”之类）是中文专用的正则。
- 评测打分另有裁判模型（`REAL_EVAL_JUDGE`、`parseJudgeVerdict`），不是正则。
- 评测只在配置开启时跑，每次只花几美分，用于上线后质量监控。

### ⑥ 邮件里靠关键词找订单号
- `packages/platform-node/src/gmail-related.ts:15` `REFERENCE_CONTEXT`：在邮件主题和正文里找“order/booking/ticket/订单/预约/予約…”后面紧跟的 8–40 位字母数字串，最多取 3 个，用它去 Gmail 搜“同一个单号”的其他邮件，把相关邮件作为上下文交给判断模型。搜到的邮件还要核对“确实逐字含这个单号”（`mentions()`，确定性，保留）。
- 先后顺序（`packages/application/src/services/proactive-mail-check-service.ts` 约 847–900 行）：先取相关邮件（`#related`）→再召回记忆→再把邮件+相关邮件+记忆交给判断模型。也就是说单号是**判断模型调用之前**抽取的，判断模型的输出还没有。
- 邮件判断本来就是模型做的，且已经让模型顺带输出金额（`amount`）。主动检查有每日成本上限和每次时间上限机制。邮件内容发给模型前会经出口遮盖。

## 请你做的事

1. 对 ①②④⑤⑥ 每一处，给出你认为最好的做法，写清上面“目标”里第 4 条要求的内容；
2. 5 处之间有没有可以共用的机制（例如共用一个“后台低价模型分类/抽取”调用），或者必须分开的理由；
3. 上网查业界（Anthropic、OpenAI、Google 等公开做法，GitHub 上成熟的开源记忆/邮件/评测项目）对同类问题怎么做，附一手来源；
4. 给每一处写出“怎么证明改对了”：一个正向用例和一个反向用例（不该命中/不该触发的输入，期望空或不触发）；
5. 在代码库里再找找有没有同类的、“用词表/正则/关键词判断用户自然语言意思”的地方（不含：发给模型前的安全遮盖、纯格式处理、界面文案），列出文件和行号。
