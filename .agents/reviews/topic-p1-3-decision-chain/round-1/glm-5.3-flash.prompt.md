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
仓库就是当前目录，已检出 fd283e437a172cfbe807dddaae5da674cc814c18。
问题、目标和约束：
# P1-3：给一条决策记录，返回并展示「它从哪来」的完整链

## 问题
Andy 要求 Himawari 的每一次主动开口或沉默都能追溯：命中了哪条规则、用了哪条记忆、这条记忆来自 Andy 的哪句话、它是从哪几条记忆推出来的。决策记录（表 decision_ledger，每个由模型做出的门槛决策一行，Andy 可一键评价）是起点。零件都在，缺的是把它们接起来给人看。

## 目标
1. 给一条决策记录，返回完整链：决策 → 命中的规则及出处 → 注入的记忆（原话、来源、当前状态、被谁取代）→ 推论链（由哪几条记忆推出）→ Andy 的评价。
2. 控制中心（apps/control-center）用详情抽屉展示这条链，抽屉只展示这条链，不做堆内部运行信息的通用面板。
3. 产出一页「决策记录写入约定」文档（有哪些字段、哪些类型、各块往里写时的要求），后续块以它为准。
4. 做到什么算完：端到端测试选一条 Gmail 记录展示完整链；缺哪一环就显示「无记录」而不是空白；约定文档进仓库。

## 约束
- 复用系统里已有的「本轮注入了哪些记忆」记录和已保存的提示词/回答，不重算。
- 不改变任何发给模型的请求（系统提示、工具定义、历史只追加，见 .claude/rules/prompt-prefix.md）；新发给模型的请求必须走统一出口。
- 提示词改动要登记 packages/prompt-catalog；识别敏感内容的规则只在 packages/sensitive-capture。
- 「决策账本」已改名「决策记录」，文档和界面文案用新名（docs/glossary.md）；三语界面（zh-CN、en、ja）。
- 界面数字和判断词要有可验证的定义；界面功能要有正向和反向验收。
- 设计基线：.agents/instructions/web-design-baselines.md；记忆页抽屉样式见 apps/control-center/src/components/memory-page.tsx。
- 主人只有 Andy 一人，一个数据库属于一位主人。

## 已核对的事实（main fd283e43）
- 前置块已在 main：P1-1 给每条记忆算 sourceMessageId（apps/agent-service/src/production-memory-control.ts 约第 395 行，记忆概览 memory.overview.snapshot 的每条记忆带 sourceThreadId、sourceMessageId、sourceRefs、history（含原话 quote）、supersededBy、status、inference）；P1-2 把整理改动的依据记进表 memory_consolidation_change_basis，并有读取接口 readBasisChain（packages/application/src/ports/memory-consolidation.ts:71）和网关查询 memory.basis.read（目前没有界面用）。
- 决策记录 inputs（JSON 列）字段见 packages/application/src/ports/decision-ledger.ts 的 DecisionInputs：memoryIds、ruleIds、floorHits（邮件→规则）、memoryByMail、usedMemoryIds、tentativeMemoryIds、memoryRecall、relatedByMail 等。类型 kind 共六种：proactive、memory_candidate、consolidation、context_truncation、retrieval_degrade、external_read。其中只有 Gmail（proactive）写满这些字段；memory_candidate 把 reasonCode 当 ruleIds 写（automatic-memory-service.ts:572）；其余多数写空数组。
- Gmail 每次检查调模型的提示词和每段回答已加密存入 payloads，由表 decision_ledger_payloads 关联（迁移 0070，role 为 model_input / model_output），读取入口 apps/agent-service/src/production-proactive.ts 的 readDecisionModelIo；现在没有界面用它。
- 规则：地板规则三条（packages/application/src/services/proactive-rules.ts FLOOR_RULE_IDS：floor_important_sender、floor_public_domain、floor_money_words），其中第一条取决于 Andy 在设置里维护的「重要发件人」；出处在 docs/adr/0106 第 4 条。仓库里没有统一的规则登记册。
- 现有网关：查询/快照类型集中在 packages/gateway-contracts/src/contracts-v2.ts；生产实现分别挂在 apps/agent-service 的 production-memory-control.ts、production-proactive.ts 等，经 production-approval-gateway.ts 派发。提醒页「提醒检查记录」（apps/control-center/src/components/proactive-reminders.tsx ProactiveDecisionLog）逐行列出 Gmail 检查，现在没有详情。
- 控制中心的记忆页已有详情抽屉（memory-drawer 样式）和来源分类函数 memorySourceState（apps/control-center/src/memory-source.ts），可跳到来源对话的原话。
- 现有测试风格：test/integration/ 下用真实 SQLite 的集成测试（decision-ledger.test.ts、proactive-mail-check.test.ts、memory-source-browser.test.ts 是真实浏览器）。
- 当前不需要、也不希望为此新增迁移，除非你们认为必须（说明理由）。

## 请你们做的
读代码，自己决定怎么做，给出一套完整方案：数据从哪读、网关接口怎么定、规则出处怎么表示、「无记录」怎么定义、抽屉怎么展示、写入约定文档应包含什么、测试怎么设计，以及你认为容易被忽略的风险和更简单的做法。上网查业界怎样做「AI 决策可追溯 / 审计链 / 数据血缘」的界面和数据结构（一手来源）。
