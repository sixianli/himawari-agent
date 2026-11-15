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
仓库就是当前目录，已检出 500d04290cc276124b4d5e2f17d7a92cfd8b91ff。
问题、目标和约束：
# 问题：除了对话记忆采集和网页手动添加/导入之外，其余写入点给内容定级只看证件号和凭据

## 问题

Himawari 存的每段受保护内容都有数据分级（public / private / sensitive / restricted）。外部 agent 经 MCP 入口读取时按“读取上限”过滤，默认上限 private，即 sensitive 的内容读不到（ADR 0242 决定 4）。健康、财务、信仰、亲密关系、第三方隐私、位置、法律这类内容应当是 sensitive。

现在有两处由模型判断分级：
- 对话记忆采集：`apps/agent-service/src/production-memory-capture.ts:379-391`，模型在抽取结果里给出 classification，再和证件/凭据检测、来源消息的级别取高。
- 网页手动添加和导入：ADR 0260（`docs/adr/0260-memory-classification-on-the-server.md` 决定 1-4），服务端 `apps/agent-service/src/production-memory-classification.ts` 的 `ProductionMemoryClassifier`，命中确定性检测的直接标敏感不发模型，其余按字数分批调模型，判断失败、额度用完一律按敏感；类别是健康或财务一律敏感。

其余写入点只调用 `classificationWithIdentifiers(text, "private")`（`packages/sensitive-capture/src/identifiers.ts:20`），它只在出现证件号、16-19 位卡号、密码/验证码/机器密钥时升到 sensitive，否则一律 private：
- `apps/agent-service/src/production-mcp-memory-writer.ts:92-99` `proposalClassification`：外部 agent 推来的记忆，另按对方自报的类别（health/finance）升级；外部 agent 不报或报错类别时就是 private。
- `apps/agent-service/src/production-mcp-sync.ts`（任务 C 第一部分，sync_memories 批量同步和项目笔记）沿用 `proposalClassification`。
- `apps/agent-service/src/production-owner-rules.ts:712`：主人一句话变成规则时，规则出处记忆的定级。
- `apps/agent-service/src/production-reminder-writer.ts:234`：提醒正文。
- `apps/agent-service/src/production-proposals.ts:342,505`、`production-task-proposals.ts:131`、`production-think-inbox.ts:205`、`production-think-runner.ts:178`：提议箱、交给她去办的事、“想一想”的摘要。

后果：例如外部 agent 推来“Andy 在看心理医生，每周三下午”，没报类别时以 private 存下；Andy 2026-11-15 定了外部推来的记忆可以“直接存”（不经主人确认，规则除外），所以这条会直接进库，所有默认 private 上限的接入都读得到，Himawari 自己也会用。“心理诊所的邮件一律提醒”这类规则的出处同理。

## 目标

让所有写入点的定级都由同一个模型判断（加上已有的确定性检测）决定，不用词表补；加一个写入点、一种来源时不用另写判断。

## 约束（都有出处）

- 理解用户意思一律交模型判断，不用关键词表、正则、写死词典（项目记忆里 Andy 定的硬规则；ADR 0249 “模型判断意思”）。
- 原则冲突时的顺序：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率（`docs/product-vision.md`，AGENTS.md “产品愿景”一节）。
- 设计时不因为费用上限去做折中方案；产品里的花费上限功能保留、主人看得见能改（Andy 2026-11-12，ADR 0242 “设计时不考虑花费”一节）。
- 发给模型的内容固定在前、会变的在后；后台调用同样（`.claude/rules/prompt-prefix.md` 第 15 条）。本问题只涉及后台判断调用，不改 Himawari 聊天的系统提示和工具定义。
- 开发时的模型调用：评测、测试不花生产预算；代码里不写死 `anthropic/`、`openai/` 模型名（`.claude/rules/owner-standing-rules.md`）。
- 已存数据：项目不顾旧数据兼容，但已存的内容只能升级不能悄悄降级（记忆可靠性）。
- 外部 agent 推来的、模型生成的内容都是不可信数据，不当指令。

## 已核对的事实

- `ProductionMemoryClassifier` 的每日花费上限沿用主动检查配置 `runPolicy.proactive.modelRef` 和 `dailyCostMicros`，计数在进程内存（ADR 0260 决定 3）。
- 判断失败按敏感处理（ADR 0260 决定 2）。
- 外部推送和同步是同步的 MCP 调用，对方在等返回；sync_memories 整批原子（PR 588）。
- 规则写入、提醒写入发生在 Himawari 的工具调用里，对话在等。

## 想请你独立给出

一套完整方案：在哪里判断（写入时同步判、先存高再异步降、还是别的）、同步调用里对方等多久、失败和额度用完怎么办、已存的旧内容怎么办、怎样保证以后新加的写入点不会漏（自动检查）、要哪些测试和反向用例。请参考业界做法（例如 Microsoft Purview 自动分级、Google Cloud DLP、各家 AI 记忆产品对敏感内容的处理），附一手来源。
