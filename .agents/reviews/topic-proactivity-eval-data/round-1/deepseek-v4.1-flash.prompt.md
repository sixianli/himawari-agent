你是独立的方案设计者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面只给了问题、目标和约束，没有给出任何人的方案；材料里如果提到某种做法，只作参考。先读代码弄清现状，再独立提出你认为最好的方案，不要假设已经有人想好了答案。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.agents/instructions/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
输出格式：先列方案依赖的前提，每个前提附来源（文件:行或网址）和原话；再写方案本身、考虑过但不选的做法及原因、风险和反例、需要人拍板的取舍。把「读代码或来源证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 5834935d102709955c38e76220c6ed8a6df5cc51。
问题、目标和约束：
# 问题：记哪些数据，才能判断 Himawari 的主动性变好还是变坏

## 目标

产品愿景（docs/product-vision.md 3.7 节）Jarvis Test 第 10 条要求：“连续 30 天统计所有由模型做出的门槛决策——主动提醒的开口与沉默、记忆的保留与丢弃、整理的合并与作废——的命中率、误扰率与已审漏报率，附样本量；命中率上升、误扰率下降，趋势可量化”。第 11 条要求任意一次开口或沉默都能追溯到原始记录。

主人 Andy 的原话（2026-11-15）：“我也没想明白你应该记录哪些数据、这些数据的什么状态，才能基于它们去反映或统计出整个系统和 AI agent 是变好了还是变坏了。”“我感觉现在的数据存的到处都是，有没有必要重新整理一下数据表？”

请你设计：产品库里应该记录哪些数据、每条数据有哪些状态、存在哪些表里，才能可靠地回答“主动性（以及其他由模型做的门槛决策）是变好了还是变坏了”；以及用这些数据怎样算出结论。

## 约束

- 只有一个用户（Andy），数据量小，做不了 A/B 对照实验。
- 这一步不新增模型调用（新增模型调用要主人另外批准，可以作为后续步骤提出，说明用途和大致费用）。
- 不建和现有决策记录平行的新账本；优先复用决策记录及其参照表（decision_ledger、decision_ledger_kinds、decision_ledger_outcomes）。
- 迁移规则见 .agents/instructions/migrations.md：会增长的取值不用 CHECK 枚举，用参照表加触发器。
- 不写死：阈值、窗口、上限能配置的要可配置并让主人看得见。
- 理解用户意思不能用关键词表或正则（.claude/rules/owner-standing-rules.md）。
- 线上历史数据不重要，可以一次性迁移，不必为旧数据保留兼容。
- 主人的时间是成本：需要他打分的地方要尽量少。
- 不考虑开发工作量。

## 已核对的现状（main 5834935d）

- 决策记录 decision_ledger：邮件主动检查（kind=proactive，开口和沉默都记，模型输入输出存在 decision_ledger_payloads）、记忆保留丢弃、整理等都写这里。写入字段见 packages/application/src/ports/decision-ledger.ts 的 DecisionLedgerWrite；没有记录做判断时的模型、提示词版本、设置版本。
- 主人评分：decision_ledger.owner_rating（useful、unneeded、missed）；每日复盘 packages/application/src/services/daily-review.ts 抽判断给主人评；模型预审 decision_prereviews。
- 反应信号 decision_signals：只有 opened、undone、replied 三种，写死在 CHECK 里；只对邮件主动提醒写。
- 推送反馈 web_push_feedback：每条送达的推送一行（网页推送和苹果推送），有 opened_at、dismissed_at；网页端的“点开”会同步成 decision_signals，“划掉”不会；苹果 App 不回报（clients/apple/Sources/HimawariManage/Generated/ClientCapabilities.swift 里 push.feedback.record 标为 notOnPhone）。
- “想一想”（对话外主动提议，ADR 0274）：apps/agent-service/src/production-think-worker.ts 的 settle 只把 think_inbox.status 改成 proposed、skipped、failed 并记原因代码，不写决策记录。思考过程是一段隐藏对话，7 天后自动删（ADR 0277）。
- 提议箱 owner_proposals：status 有 pending、accepted、rejected、expired、superseded、withdrawn，另有执行状态；采纳、拒绝不写决策记录，也不写信号。决策记录已登记 proposal 种类及 proposed、accepted、dismissed、expired、executed、failed、undone、not_proposed、superseded、told 等结果值；目前只有 packages/application/src/services/perception-extraction.ts 写 proposed 和 not_proposed。
- 统计包 packages/calibration：按组算比例和 Wilson 置信区间，有每周历史；主要组只覆盖邮件提醒、邮件沉默、记忆、整理。
- App 里的提议卡片第一次显示在屏幕上的时间没有记录。

## 请你做的

列出的现状只是事实，不是方案。不要局限于现有结构，请从问题本身出发，读代码、上网查大厂和论文对主动型 agent 的评估做法（附一手来源），提出你认为最好的方案：

1. 要回答“变好还是变坏”，必须记录的数据和状态是什么，各存在哪张表（新表、改表都可以提，说明理由）。
2. 现有的表里，哪些该合并、哪些该保留、哪些列该搬走。
3. 怎样从这些数据算出结论，样本少时怎样避免下错结论。
4. 你认为会漏掉或容易做错的地方。
