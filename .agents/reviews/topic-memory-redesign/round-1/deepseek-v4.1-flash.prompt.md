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
仓库就是当前目录，已检出 891955719fb913e9860392207b70e5aef0055ecf。
问题、目标和约束：
# 问题：重新设计 Himawari 的长期记忆系统

Himawari 是只服务一个人（Andy）的个人 Agent，仓库就是当前副本。请从问题本身出发，自己读代码、上网查一手资料，提出你认为最好的记忆系统设计。下面列出的业界做法只是参考，不要局限于这些，也不要被现有实现框住；如果你认为该推倒重来或该保留，都请给出理由。

## 目标（Andy 2026-11-24 原话）
- “我做这个项目我要做到极致，就是我要它足够聪明，你不用帮我考虑模型调用的问题”
- “我要的是让主模型能看得到所有必要的上下文，然后让它做出最聪明的判断”（他要求删掉“先问另一个判断模型值不值得想”这类在主模型前面、只看一小块信息的小判断模型）
- 他问过：能否把记忆改成 Markdown 文档的形式存储，而不是放数据库；之后说 Markdown 的好处和数据库的保证“两样都要”。
- 要能在聊天中翻回以前对话的原话，不只是摘要。
- 不设为了“他看不过来”而定的数量上限；能动态获取的值不要写死。

## 约束（已核对）
- 产品愿景 docs/product-vision.md 原则 3：“记忆是所有决策的主要输入，必须有单一权威源，且我可查看、编辑与删除。记忆区分事实、偏好与推断，推断带来源、时间与置信度；遗忘与纠正同样是记忆的功能，纠正应传播到受其影响的推断与行为。规则不是记忆，是硬性设定”。原则优先级：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。
- 发给模型的内容只追加、每轮会变的内容放最后一条消息、系统提示和工具按对话冻结：.agents/instructions/prompt-prefix.md。
- 理解用户意思交给模型，不用关键词表/正则：.claude/rules/owner-standing-rules.md “理解用户的意思交给模型”。
- 数据在一台自租服务器（x86 4 核 8GB）上的 SQLite；正文加密存储；有数据分级（public/private/sensitive/restricted），某些级别不能发给某些模型服务方。
- 只有一个用户；客户端主要是 iPhone App 和网页。

## 现状（线程已对着代码核过，你请自己再核）
- 聊天：threads / thread_messages 表，正文加密在 payloads。每个对话每天一段摘要存 memory_episodes。
- 记忆：memory_records（类别、重要度、valid_from/valid_to、superseded_by、出处、tentative 等），词索引 memory_search_terms（FTS5）和向量索引 memory_search_index。
- 每轮上下文：packages/application/src/services/context-formation-service.ts 组装：主人资料块（owner-profile-service.ts，OWNER_PROFILE_CHARACTER_BUDGET = 2000 字）+ 用本轮消息自动搜记忆选若干条（runPolicy.memoryLimit / maxSelectedMemories）。
- 模型能主动调的只有读工具 memory.recall（apps/agent-service/src/production-memory-recall.ts，最多 10 条 + 5 段摘要）。主模型没有写记忆的工具，也没有打开旧对话原话的工具。
- 写记忆：每轮结束后由单独一次模型调用抽取（apps/agent-service/src/production-memory-capture.ts：原文最多 6000 字、近期记忆 20 条、相关记忆 10 条、最多 8 个候选，另有确认裁判），加上每日回看对话（production-memory-conversation-review.ts）和每日整理（consolidation）。
- 已有评测：test/integration/memory-evaluation.test.ts、evals/memory-retrieval、evals/memory-capture、真实记忆周评测（ADR 0239）。

## 查到的一手资料（只是参考）
- Anthropic memory tool：模型看到 /memories 下的文件，命令 view/create/str_replace/insert/delete/rename；背后存储由应用决定（文件或数据库）。https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
- Anthropic 上下文工程：上下文会“腐烂”，长了召回变差；建议预先放一小部分 + 模型按需检索（just-in-time）。https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Claude App：边聊边按“主题”存记忆；另有搜索旧聊天的工具调用，回答带链接指回原对话。https://support.claude.com/en/articles/11817273
- Claude Code：MEMORY.md 索引开局载入前 200 行/25KB，主题文件按需读。https://code.claude.com/docs/en/memory
- ChatGPT：保存的记忆 + 参考聊天记录；新版“持续更新的较宽摘要”。https://help.openai.com/en/articles/8590148-memory-faq
- LangChain：单份 profile 越大越容易出错；集合召回更高但更新难。https://docs.langchain.com/oss/javascript/concepts/memory
- Letta：记忆块常驻上下文、模型自己改；睡眠时 agent 后台整理；用文件系统工具的 agent 在 LoCoMo 74%。https://www.letta.com/blog/benchmarking-ai-agent-memory https://www.letta.com/blog/sleep-time-compute
- Zep：原始 episode 无损保留、事实带双时间线、失效不删。https://arxiv.org/abs/2501.13956
- Mem0：ADD/UPDATE/DELETE/NOOP；论文表里全上下文基线准确率反而最高，优势在延迟和 token。https://arxiv.org/abs/2504.19413
- LongMemEval：按“轮”存原始历史最好；长上下文模型直接读全部历史掉 30%–60%。https://arxiv.org/abs/2410.10813
- MemDelta：受控对比下，原话检索与全上下文接近，agent 自管记忆(42%)不如基础检索(47%)。https://arxiv.org/abs/2606.29914
- Mnemon：原样保存带日期的对话记录，写入时不做决定，后台整理成主题时间线并链回原记录。https://arxiv.org/abs/2609.36059

## 请你给出
1. 你认为的根因（现在的设计哪里让主模型不够聪明）。
2. 完整设计：存什么、存哪、怎么写、怎么读、谁来决定、怎么纠正和遗忘、原话怎么翻、Andy 怎么看和改、怎么导出。
3. 怎么用评测证明新设计更好（要比较哪几种做法、量什么）。
4. 风险和你认为该放弃的东西。
