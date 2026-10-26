---
status: active
supersedes: ""
superseded_by: ""
date: "2026-10-26"
---

# Himawari 工程难题与方案案例库

<a id="contents"></a>

这份文档把 Himawari 开发中遇到的难题、bug（程序缺陷）和重要架构决定，一件一件写成“案例”。每个案例都按同一个顺序写：当时看到了什么、真正的原因是什么、我们怎么解决、考虑过哪些别的办法、业界一般怎么做、两者比起来取舍是什么、最后量到的结果，以及相关的决策记录和代码合并请求。

它有两个用处：

- 给 Andy 准备简历和面试。应聘 AI Application Engineer（AI 应用工程师）或 AI Agent Engineer（AI 智能体工程师）时，可以挑其中几个案例，按“现象 → 根因 → 方案 → 取舍 → 数据”讲清楚。
- 给以后的线程留下“为什么这样做”的完整理由，避免同样的讨论重来一遍。

项目一句话：Himawari 是只属于 Andy 一个人的个人 Agent（能自己调用工具、多步完成任务的 AI 助手），本地优先、以长期记忆为核心，建在开源的 Pi Coding Agent（一个可扩展的编程智能体框架，代码在 `pi-mono` 仓库）之上，单机部署在一台 Linux 云服务器上。

**诚信说明（面试时请照实讲）：** 产品方向、架构取舍和上线授权都由 Andy 拍板，ADR（架构决策记录，每份记下一个重要决定和理由）里保留了 Andy 的原话；具体代码主要由 AI 编码代理（Claude、Codex、opencode 等）在 Andy 的指挥和审查下写成。本文的数字都来自提交说明、ADR、测试记录或生产日志，出处写在每个案例的“相关 ADR/PR”里；没量过的地方写明“未测量”。

## 目录

- [怎么用这份文档](#how-to-use)
- [岗位能力对照表](#competency-map)
- 案例
  1. [自研长期记忆：去掉 Mem0，改用 SQLite 三路检索](#case-memory-engine)
  2. [记忆“只读不写”：检索接好了，库却一直是空的](#case-memory-capture)
  3. [工具隔离架构：控制平面和执行沙箱分开](#case-tool-isolation)
  4. [授权核对太频繁：一次新闻请求核对 42 次](#case-authority-checks)
  5. [一次联网新闻回答要 49 秒：逐段拆耗时](#case-search-latency)
  6. [沙箱冷启动：从 3.3 秒到 0.22 秒，再到“用到才启动”](#case-sandbox-cold-start)
  7. [可替换的搜索供应商链](#case-web-providers)
  8. [改了搜索开关，对话空转 5 分钟](#case-search-toggle-spin)
  9. [上下文窗口配错，长回答被截断](#case-context-window)
  10. [删掉费用预算上限，只保留用量账本](#case-budget-removal)
  11. [第十次上线：五次尝试才成功](#case-tenth-deploy)
  12. [生产一直在跑 10 月 7 日的旧前端](#case-static-root)
  13. [快速交付模式：把“门槛”变成一个开关](#case-fast-mode)
  14. [管住 AI 编码代理：同一错误第三次就加硬约束](#case-agent-governance)
  15. [模型网关迁移和“速度优先”路由](#case-model-gateway)
  16. [运行中却显示“已完成”：模型过渡话被当成回答](#case-narration-status)
  17. [记忆管理页重设计：记忆越来越多，一页长列表管不过来](#case-memory-page)
  18. [个人 Agent 怎么给家人朋友用：每人一个实例，还是一个实例分用户](#case-multi-user)
  19. [搜索已经结束，却被判“失联”，整个服务卡 5 分钟](#case-sandbox-lost-race)
  20. [第十一、十二次上线：首页正常，打开的页面却用不了；修复版又因复制来的旧脚本停服一次](#case-eleventh-twelfth-deploy)
  21. [个人 Agent 要不要做 iOS App：先补“连得上、叫得到、能说话”](#case-mobile-client)
  22. [系统提示开头一直是“编程助手”：给 Himawari 写自己的身份说明](#case-identity-prompt)
  23. [答对了却“没有过程”：用到的记忆不在步骤里](#case-memory-steps)
  24. [模型只用 3.9 秒，整轮却要 12 秒：找出 Himawari 自己造成的空档](#case-run-gaps)
  25. [上线操作包从“复制上一次再手改”改成“按参数生成”](#case-packet-generator)
- [小案例速查](#small-cases)
- [业界资料的核对情况](#source-status)
- [新增案例模板](#case-template)
- [维护规则](#maintenance)

<a id="how-to-use"></a>

## 怎么用这份文档

- **准备面试：** 先看[岗位能力对照表](#competency-map)，按职位要求挑 3–5 个案例。每个案例最后有一段“面试 30 秒版”，可以先用它开场，再按面试官追问展开到根因、备选方案和数据。
- **被问“为什么不用某某现成方案”：** 看每个案例的“方案讨论与备选”和“对比与取舍”。
- **被问“业界怎么做”：** 看“业界主流做法”。每条资料都标了核对情况，图例见[业界资料的核对情况](#source-status)。标“✅”的资料都打开原文核对过，可以直接引用；标“⚠”的没能核对，面试时不要引用。

[返回目录](#contents)

<a id="competency-map"></a>

## 岗位能力对照表

| 岗位常见要求 | 可以讲的案例 |
| --- | --- |
| Agent 记忆、RAG（先检索资料再让模型回答）和检索质量评估 | [自研长期记忆](#case-memory-engine)、[记忆只读不写](#case-memory-capture)、[记忆管理页重设计](#case-memory-page)、[用到的记忆不在步骤里](#case-memory-steps) |
| 工具调用、Agent Loop（模型和工具轮流执行的主循环）、并行工具 | [49 秒拆耗时](#case-search-latency)、[工具隔离架构](#case-tool-isolation) |
| Agent 安全：沙箱、权限、提示注入防护、外发网络控制 | [工具隔离架构](#case-tool-isolation)、[授权核对](#case-authority-checks)、[搜索供应商链](#case-web-providers)、[多用户隔离](#case-multi-user) |
| 延迟优化和性能分析 | [49 秒拆耗时](#case-search-latency)、[沙箱冷启动](#case-sandbox-cold-start)、[授权核对](#case-authority-checks)、[每轮系统空档](#case-run-gaps) |
| 模型接入、路由、上下文管理、成本 | [模型网关](#case-model-gateway)、[上下文窗口](#case-context-window)、[删掉预算上限](#case-budget-removal) |
| 可靠性：失败恢复、回退、熔断 | [搜索供应商链](#case-web-providers)、[搜索开关空转](#case-search-toggle-spin)、[第十次上线](#case-tenth-deploy)、[搜索被判失联](#case-sandbox-lost-race) |
| 上线、回滚和事故复盘 | [第十次上线](#case-tenth-deploy)、[搜索被判失联](#case-sandbox-lost-race)、[旧前端事故](#case-static-root)、[快速交付模式](#case-fast-mode)、[第十一、十二次上线](#case-eleventh-twelfth-deploy)、[按参数生成操作包](#case-packet-generator) |
| Agent 交互体验：把执行过程如实展示给用户 | [运行中却显示“已完成”](#case-narration-status)、[记忆管理页重设计](#case-memory-page)、[用到的记忆不在步骤里](#case-memory-steps) |
| 用 AI 编码代理做工程、管理多代理协作 | [管住 AI 编码代理](#case-agent-governance)、[快速交付模式](#case-fast-mode)、[按参数生成操作包](#case-packet-generator) |
| 多用户 / 多租户隔离和登录方式选择 | [多用户隔离](#case-multi-user) |
| 多端接入、主动推送和语音入口 | [要不要做 iOS App](#case-mobile-client) |
| 系统提示设计、Agent 身份和行为约束、提示注入边界 | [Himawari 身份系统提示](#case-identity-prompt) |

[返回目录](#contents)

<a id="case-memory-engine"></a>

## 案例 1：自研长期记忆：去掉 Mem0，改用 SQLite 三路检索

**背景与现象**

长期记忆是 Andy 定的核心能力：Agent 要记住“我对青霉素过敏”“我最喜欢蓝色”这类事实，以后在新对话里自己想起来。最早用的是开源库 Mem0 3.3.1（一个给 AI 应用加记忆的流行开源库）。用下来有几个问题：

- 中文关键词搜不到。比如问“那家火锅店叫什么”，向量相似度（把文字变成一串数字后比较“意思像不像”）不一定能命中只出现过一次的店名。
- 事实改了以后旧的还在。比如“我搬到了上海”之后，问“我住哪”可能还召回旧城市。
- 向量库和历史库各存一份明文，删除时要两边核对。

**根因**

读了 Mem0 3.3.1 的源码后确认：它在我们这种本地用法下，检索就是 `SELECT * FROM vectors` 把整张表读出来，再在 JavaScript 里逐条算余弦相似度；没有关键词检索；新版算法只新增、不更新旧事实。也就是说，我们实际只用到了它的“调嵌入接口 + 全表比相似度”，而“改事实、按时间过滤、关键词命中”这些真正难的部分它都没解决。

**我们的方案**（ADR 0075，分四个阶段上线）

1. **检索（阶段一）：** 记忆全部放进产品已有的 SQLite 主库（一个单文件数据库），不再多跑一个服务。每次检索同时走三路：
   - 向量相似度：嵌入向量存成二进制字段，用 sqlite-vec 0.1.9（SQLite 的向量扩展）的标量函数算余弦距离，扩展没加载时退回 JavaScript 计算。
   - 关键词：FTS5（SQLite 自带的全文检索）建索引，中文先用 `Intl.Segmenter`（浏览器和 Node 自带的分词器）分词，再补上相邻两个汉字的组合，解决中文短词搜不到。
   - 实体：人名、地名、店名单独建表匹配。
   - 三路结果用 RRF（倒数排名融合，按每路里的名次合并，不需要把不同分数换算到同一尺度）合并，再按重要度、可信度和“90 天减半”的新鲜度调整。过了有效期的事实不再召回。
2. **防止模型编造记忆：** 提炼记忆时要求模型给出 Andy 原话里的一段引文，主机程序在原消息里逐字找到这段话才保存，找不到就丢弃并记审计。
3. **历史和时间（阶段二）：** 新事实“取代”旧事实而不是删掉旧的，能回答“我以前住哪”；加了按天的对话摘要和一个“回忆过去对话”的工具。
4. **每日整理，可撤销（阶段三）：** 每个 Agent 每天整理一次，只看上次整理之后变动过的记忆，没有新内容就不调模型。合并重复、新事实取代旧事实、最多推测 3 条习惯（标为“待确认”，确认前不参与召回）。很久没用的琐事只归档、不删除。每一处改动都记下改动前的样子，可以逐条撤销；Andy 中途手改过的记忆会被跳过。规则类记忆“第一次看到先观察，再次出现或确认后才生效”。
5. **承诺提醒（阶段四）：** Agent 答应过的事到时间会提醒。

**方案讨论与备选**

| 备选 | 好处 | 为什么没选 |
| --- | --- | --- |
| 继续用 Mem0 | 不用改 | 只用到全表比相似度；没有关键词检索；两份明文要双写；新算法只新增不更新 |
| Postgres + pgvector（向量扩展） | 成熟、功能全 | 要多跑一个数据库服务，违背“本地优先、单文件状态”；主库是 SQLite，迁移大 |
| Graphiti + 图数据库（Zep 的时序知识图） | 时间维度做得最完整 | 要额外的 Python 服务和图数据库，每条消息多次模型调用；只借鉴了“事实有有效期、失效不删” |
| Letta 服务 | 常驻记忆块和后台整理记忆是现成的 | 自带一整套 Agent 运行时，和 Pi 重复；只借鉴了“后台整理记忆” |
| sqlite-vec 的 `vec0` 虚拟表 | 同数据量下快约 1.7 倍（3 万条 1024 维：72 ms 对 120 ms） | 没加载扩展的数据库连接读不了这张表，备份和恢复工具会出错；记忆在千条以内时标量函数约 17 ms（5 千条），够用 |

放弃了什么：不用现成的托管记忆服务，检索质量要靠自己的评测集证明；向量检索是暴力扫描，记忆量涨到几十万条时要换方案。

**业界主流做法**

- ✅ Mem0 官方 README（[github.com/mem0ai/mem0](https://github.com/mem0ai/mem0)）写明 2026 年 4 月的新算法是“Single-pass ADD-only extraction -- one LLM call, no UPDATE/DELETE”，检索把“semantic, BM25 keyword, and entity matching scored in parallel and fused”；同时说明公布的高分“reflect Mem0's managed platform, which includes proprietary optimizations not available in the open-source SDK”。也就是说，业界最新做法和我们一样是“向量 + 关键词 + 实体”三路融合，但开源版拿不到这些优化。
- ✅ Graphiti（Zep 的开源引擎，[github.com/getzep/graphiti](https://github.com/getzep/graphiti)）：“Facts have validity windows. When information changes, old facts are invalidated — not deleted.” 我们的“取代而不删”借鉴了这一点。
- ✅ sqlite-vec 官方文档（[KNN 查询说明](https://raw.githubusercontent.com/asg017/sqlite-vec/main/site/features/knn.md)）：标量函数可以做暴力 KNN（找最相近的 K 条），`vec0` 虚拟表“faster and more compact, but is less flexible”。
- ✅ Claude 的记忆工具（[Memory tool 文档](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)）：“The memory tool operates client-side”，记忆是 `/memories` 下的文件，由应用自己执行读写。说明头部厂商也把“记忆存在哪、怎么管”留给应用方。
- ✅ LongMemEval（[论文 arXiv 2410.10813](https://arxiv.org/abs/2410.10813)，ICLR 2025 的长期记忆评测）：考五种能力，“information extraction, multi-session reasoning, temporal reasoning, knowledge updates, and abstention”（信息提取、跨会话推理、时间推理、知识更新、该拒答时拒答），共“500 meticulously curated questions”。我们的中文评测集按这五种能力分类。
- ✅ Zep 论文（[arXiv 2501.13956](https://arxiv.org/abs/2501.13956)，数字在 PDF 正文）：在 DMR 记忆评测上“Zep demonstrates superior performance (94.8% vs 93.4%)”，对手是 MemGPT，两者都用 gpt-4-turbo。
- ✅ RRF 原论文（Cormack、Clarke、Buettcher，SIGIR 2009，[PDF](https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf)）：“RRFscore(d ∈ D) = Σ 1/(k + r(d)), where k = 60 was fixed during a pilot investigation”。只看名次、不看原始分数，所以能直接合并向量分和关键词分这种尺度不同的结果。
- ✅ SQLite FTS5 文档（[sqlite.org/fts5.html](https://www.sqlite.org/fts5.html)）：“A contentless FTS5 table is created by setting the "content" option to an empty string.”，并且“It is also possible to create custom tokenizers for FTS5.”。我们用的“无内容索引 + 自定义分词”都是官方支持的用法。
- ✅ Generative Agents（[arXiv 2304.03442](https://arxiv.org/abs/2304.03442)）：检索时“scores all memories as a weighted combination of the three elements”（新近度、重要度、相关度），另有“reflection, which synthesizes memories into higher-level inferences over time”。我们的“重要度 + 新鲜度”加权和“每日整理”分别对应这两点。
- ✅ Letta 文档（[Memory & dreaming](https://docs.letta.com/configuration/memory)）：“Dreaming uses background subagents to review recent conversations, consolidate useful lessons, and update memory without interrupting your active work.”，触发时机是完成一定步数后或上下文被压缩时。我们改成每天固定整理一次，并且每处改动可撤销。
- 📎 自研记忆提案（[已归档的提案](archive/specs/2026-10-25-self-built-memory-engine-proposal.md)）在 2026-10-25 调研时还对照了 ChatGPT 记忆、Mastra、LangMem 等，链接见该提案。

**对比与取舍**

我们和 Mem0 托管版的检索思路一致（三路融合），区别在于：全部在本机 SQLite 里完成，不依赖外部服务；中文分词专门处理；“原话引文校验”和“每处改动可撤销”是 Mem0 没有的。代价是规模上限低、要自己维护评测集。对一个人用的个人 Agent，记忆量在千条级，这个取舍合适。

**结果数据**

- 中文评测集：155 条记忆、100 个问题，按 LongMemEval 五种能力分类。用真实的 Qwen3-Embedding-8B（4096 维）向量：改过的事实不再召回旧值的比例 0.8 → 1.0，知识更新类 MRR（第一个正确答案排名的倒数的平均，越接近 1 越好）0.69 → 0.79，时间类 MRR 0.87 → 0.93，五种能力全部高于 Mem0 基线（提交 `68ff784`）。
- 阶段二新增 32 个问题和 12 份每日摘要（用简化向量先测）：时间窗口召回 0.25 → 0.92，历史类 MRR 0.37 → 0.70，每日摘要召回 1.0（同上）。
- 给整个评测集算一次嵌入花费 0.00006 美元（提交 `23bb67f`）。
- 2026-10-26 第十次上线后在生产生效，Mem0 下线。生产实测（“记住我最喜欢蓝色”后新开对话再问）还在等 Andy 验收。

**相关 ADR/PR**

[ADR 0075](adr/0075-self-built-memory-engine.md)；[PR #21](https://github.com/sixianli/himawari-agent/pull/21)、[PR #24](https://github.com/sixianli/himawari-agent/pull/24)、[PR #25](https://github.com/sixianli/himawari-agent/pull/25)；提交 `2215bcd`（阶段一）、`68ff784`（阶段二评测）、`a211b17`（阶段三）。

**面试 30 秒版**

“我们原来用 Mem0，读源码发现它本地版只是全表算余弦，中文关键词搜不到、改过的事实还会召回旧的。我们在 SQLite 里自己做了向量、关键词、实体三路检索加 RRF 融合，事实用‘取代’不删，每天整理一次且每处改动可撤销，还要求模型给原话引文、主机逐字校验，防止编造记忆。用 155 条记忆、100 个问题的中文评测集量，过期事实召回从 20% 降到 0，各项都高于 Mem0 基线。”

[返回目录](#contents)

<a id="case-memory-capture"></a>

## 案例 2：记忆“只读不写”：检索接好了，库却一直是空的

**背景与现象**

2026-10-25，Andy 在生产里说了好几次个人信息，之后问起来 Agent 都不记得。

**根因**

查代码发现：每轮对话前都会去记忆库检索（读的一侧接好了），但从来没有任何代码把对话内容写进记忆库。也就是说功能“看起来有”，测试也测了检索，但生产记忆库一直是空的（提交 `979b4ff`）。这是典型的“只验证了一半链路”。

**我们的方案**

- 每轮对话第一条回答之后，跑一次记忆提炼：读 Andy 的消息和最多 40 条已有记忆，让模型输出候选记忆（JSON 格式）。
- 候选交给已有的自动记忆服务：扫描密钥、过滤一次性信息、可信度低于阈值的丢掉、Andy 明说“记住”时直接保存。
- 敏感内容（例如健康信息）进入审批：界面弹确认卡，Andy 点同意才保存（[PR #17](https://github.com/sixianli/himawari-agent/pull/17) 的审批和记忆页）。
- 提炼不阻塞回答：只等它“被接收”，不等它完成。

**方案讨论与备选**

- 在回答的同一次模型调用里顺便输出记忆：省一次调用，但会拖慢回答，且回答失败时记忆也丢。没选。
- 每条消息实时提炼 vs 对话空闲时批量提炼：实时更符合“刚说完就该记住”的预期，选了实时；批量整理放到[每日整理](#case-memory-engine)里做。
- 敏感信息直接存 vs 先确认：Andy 定敏感记忆要确认、但允许用云端模型做嵌入。

**业界主流做法**

- ✅ Claude 记忆工具的文档写明记忆读写由应用侧执行（见[案例 1](#case-memory-engine) 的链接），什么时候写、写什么要应用自己设计。
- ⚠ ChatGPT 的记忆 FAQ（`https://help.openai.com/en/articles/8590148-memory-faq`）：2026-10-26 在云端和 Andy 的 Mac 上打开都返回 HTTP 403，没能核对，面试时不要引用。

**对比与取舍**

我们比通用做法多了“敏感内容先确认”和“原话引文校验”，代价是多一次模型调用和偶尔一张确认卡。

**结果数据**

修复提交里新增的记忆提炼集成测试和相关测试通过（提交 `979b4ff`）；生产端到端验收（说“我对青霉素过敏”看到确认卡）随第十次上线一起等 Andy 实测。

**相关 ADR/PR**

[PR #16](https://github.com/sixianli/himawari-agent/pull/16)、[PR #17](https://github.com/sixianli/himawari-agent/pull/17)；提交 `979b4ff`。

**面试 30 秒版**

“上线后发现记忆检索接好了，但根本没有写入路径，库一直是空的。教训是要用端到端测试从‘说一句话’验证到‘新对话里想起来’，而不是分别测读和写。修复时把敏感信息做成确认卡，并让提炼异步执行、不拖慢回答。”

[返回目录](#contents)

<a id="case-tool-isolation"></a>

## 案例 3：工具隔离架构：控制平面和执行沙箱分开

**背景与现象**

Agent 能执行命令、改文件、联网。模型可能被网页里的恶意文字诱导（提示注入，即把指令藏在 Agent 读到的内容里），所以执行这些工具的地方必须和掌握授权、密钥、数据库的主程序隔开。早期每次工具调用都新建一个沙箱（用操作系统机制限制程序能访问的文件和网络的隔离环境），结果 2026-10-13 第三次上线后，读一个不存在的文件也要 7–14 秒；Andy 让 Agent“列出文件并打开一个”，一轮 7 次读取都要手动批准。

**根因**

- 架构上要求“有副作用的工具一律进隔离环境”是对的，但实现成了“每次调用新建一个”，把启动成本乘到了每一步。
- 每次进沙箱前还要核对运行环境没被改过（宿主核验）：Mac 上一次读文件做了 8 次核验共约 57 秒；第六次上线的验收在生产机上一个任务启动前 6 轮核验、每轮 2.3–6.5 秒，准入阶段共 51.5 秒。
- 授权策略是“每一步都问”，比主流编程 Agent 严得多。

**我们的方案**

1. **控制平面和执行平面分开**（ADR 0031）：可信的主程序负责模型调度、授权、审计；执行命令和写文件放到独立的执行环境，一个任务一个环境，同一任务的多次调用共用。具体用 Anthropic 开源的 SRT（sandbox-runtime，底层在 Linux 上用 bubblewrap，一个轻量沙箱工具），外发网络只允许精确的“主机:端口”。
2. **只读工具留在主进程**（ADR 0054）：读文件、列目录、找文件、搜索内容不进沙箱，直接复用 Pi 的工具实现，Himawari 只加路径检查（解析后的真实路径必须在授权目录内，不能借 `..`、符号链接或硬链接跑出去）。
3. **同一轮复用一个沙箱**（ADR 0054 后续补充）：常驻任务宿主加沙箱内常驻执行程序，不再每次新建。
4. **去掉每次调用前的安装核验**（ADR 0069）：分析后确认沙箱里的工具本来就改不了运行时目录（只读挂载），能改它的程序同样能改核验代码本身，所以每次比对防不住有意篡改。按 Andy 的决定，和 Claude Code 一样只靠“沙箱禁止写入 + 生产上 root 拥有的受保护安装”。
5. **工作目录内默认放行**（ADR 0053）：参照 Codex 的 Auto 模式，授权目录内读、写、执行不联网的命令都不再逐次批准；越界写入和联网仍要询问。

**方案讨论与备选**

| 备选 | 为什么没选 |
| --- | --- |
| 每次工具调用一个新容器 | 丢失任务内的依赖、产物和后台进程，创建成本反复付 |
| 所有任务共用一个长期容器 | 权限和状态在任务间串，没法单独停止并证明某个任务已释放 |
| 只靠进程组清理来“停止” | 拦不住脱离父进程的后台程序（例如 `setsid`、两次 fork） |
| 只读工具也进沙箱，但复用和缓存 | 第一次调用仍要几秒；最终只用于命令和写入 |
| 只读免批准、写和执行仍要批准（Claude Code 默认） | Andy 选了更宽的 Codex Auto 方案，原话：“我这个 Agent 是要做成个人的一个全能 Agent。如果给这么多限制，怎么全能？” |
| 保留每次调用前的安装核验，但加快遍历 | 只能快 1.5–2 倍，生产上仍有 6 轮、每轮 1.5–3 秒 |

放弃了什么：工作目录内的误操作不再有人逐次把关，要靠沙箱和可撤销来兜底；只读工具在主进程，路径检查必须写对。

**业界主流做法**

- ✅ Claude Code 沙箱文档（[Configure the sandboxed Bash tool](https://code.claude.com/docs/en/sandboxing)）：“The sandbox covers shell commands only.”，Read、Edit、Write、WebFetch、WebSearch 等工具“follow permission rules instead”。
- ✅ Claude Code 权限文档（[Configure permissions](https://code.claude.com/docs/en/permissions)）：文件读取和 Grep 在工作目录内不需要批准；Bash 命令除内置的一组只读命令外需要批准；改文件需要批准。
- ✅ Anthropic 工程博客（[Making Claude Code safer with sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing)）：基于“OS level primitives such as Linux bubblewrap and MacOS seatbelt”，内部使用中“sandboxing safely reduces permission prompts by 84%”。
- ✅ Codex 审批与安全文档（[Agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security)）：默认的 Auto 模式“Codex can read files, make edits, and run commands in the workspace. Codex requires approval to edit outside the workspace or to access network.” 我们的 ADR 0053 就是照这个定的。
- 📎 OpenHands 和 Gemini CLI 的隔离方式，在 ADR 0069 写成时（2026-10-23）对照过官方文档，链接见该 ADR。
- ✅ OWASP LLM01 提示注入（[LLM01:2025 Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)）：“Indirect prompt injections occur when an LLM accepts input from external sources, such as websites or files.” Agent 会读网页和文件，所以执行工具的地方必须和掌握授权、密钥的地方分开。

**对比与取舍**

我们的隔离比 Claude Code 更重：Claude Code 的沙箱是本机上的一层，我们额外做了“控制平面不进沙箱、一个任务一个环境、外发网络按主机端口授权、停止要能证明”。原因是 Himawari 是常驻服务、会在无人看着时执行后台任务，而 Claude Code 默认有人在终端前。批准策略则比 Claude Code 宽，和 Codex Auto 一致。

**结果数据**

- 只读工具改到主进程后，从每次 7–14 秒降到毫秒级（ADR 0054 的预期；生产逐次计时未单独发布）。
- 去掉安装核验后，生产任务准入阶段不再有那 6 轮、合计 24.2 秒的核验（ADR 0069 的背景数据）。

**相关 ADR/PR**

[ADR 0031](adr/0031-isolated-tool-execution.md)、[ADR 0054](adr/0054-readonly-tools-in-host-and-reused-task-sandbox.md)、[ADR 0069](adr/0069-trust-unprotected-runtime-like-claude-code.md)、[ADR 0053](adr/0053-workspace-auto-approval-like-codex.md)。

**面试 30 秒版**

“Agent 会被提示注入，所以我们把掌握授权和密钥的控制平面和执行工具的沙箱分开，一个任务一个沙箱、外发网络按主机端口授权。一开始每次调用都新建沙箱，读个文件 7–14 秒；后来对照 Claude Code 把只读工具留在主进程、加严格路径检查，命令和写入复用同一个沙箱，还去掉了每轮都做、其实防不住篡改的安装核验。”

[返回目录](#contents)

<a id="case-authority-checks"></a>

## 案例 4：授权核对太频繁：一次新闻请求核对 42 次

**背景与现象**

- 2026-10-25 12:10（UTC），生产里第一次真实联网搜索被它自己的任务宿主杀掉了。
- 2026-10-26 拆解一次新闻请求的耗时时发现：一次请求做了 42 次完整授权核对，合计约 7 秒，其中约 3 秒在关键路径上。每次核对中位数 130 ms，其中宿主核验 80 ms、解密授权范围 40 ms；生产上的单次宿主核验在 22–1257 ms 之间波动。

**根因**

- 沙箱每发起一个外发连接，都要向 Worker（执行工具的后台进程）问一次“现在还有权限吗”，最多等 1.5 秒；Worker 每 250 ms 还会主动巡检一次。每次都做一整套核对：读部署快照、宿主核验、解密授权范围、读授权和审批记录。代码里明确写着“永远不缓存授权成功的结果”。
- 第一次搜索被杀的直接原因：三次完整核对同时跑，把宿主核验拖慢到每次 1.0–1.3 秒，有两次回答超过 1.5 秒，任务宿主判定超时、停掉任务，退出码还丢了，于是对话一直等对账直到期限（提交 `15057e0`）。
- 撤销授权只是数据库里的一行记录，只能靠轮询发现，这也是“每次都重新核对”的原因。

**我们的方案**

1. **先止血（已上线）：** 同一个沙箱任务同一时间只跑一次完整核对；核对进行中又来的请求等它跑完后共享下一次核对，下一次一定在请求到达之后才开始，所以不会拿到比请求更旧的结果。1.5 秒的上限不变（提交 `15057e0`）。
2. **方案 A（Andy 2026-10-26 批注“同意”，开发中）：** 任务开始时完整核对一次；之后在内存里按版本号比对，版本没变就直接通过；最多 60 秒强制重新完整核对一次；撤销时主动推送“取消任务”，而不是等下一次轮询。

**方案讨论与备选**

| 备选 | 为什么没选 |
| --- | --- |
| 保持每次都完整核对 | 一次请求 7 秒，且并发时会超时杀任务 |
| 简单缓存 N 秒 | 撤销后最多 N 秒才生效，且看不到版本变化 |
| 只合并并发核对（已做） | 解决了超时，但次数仍多 |
| 版本比对 + 定期重核 + 主动撤销（方案 A） | 采用：平时几乎零成本，撤销靠推送立即生效，60 秒重核兜住推送丢失 |

放弃了什么：两次完整核对之间，如果授权以“不改版本号”的方式变化，最多 60 秒才发现；所以所有授权变更都必须改版本号或发撤销推送。

**业界主流做法**

- ✅ Go 的 singleflight 包（[golang.org/x/sync/singleflight](https://pkg.go.dev/golang.org/x/sync/singleflight)）：“If a duplicate comes in, the duplicate caller waits for the original to complete and receives the same results.” 和我们第一步止血是同一个思路；我们多加了一条“共享的结果必须在请求到达之后才开始计算”，避免拿到过期的授权结论。
- ✅ NIST SP 800-207 零信任架构（[PDF](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-207.pdf)）：“Access to individual enterprise resources is granted on a per-session basis.”，“Access to resources is determined by dynamic policy”。即按会话授予、按策略动态评估，不要求每个网络包都重新做完整核对。
- ✅ Microsoft Entra 持续访问评估（[CAE 文档](https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-continuous-access-evaluation)）：平时访问令牌“By default ... valid for one hour”，但遇到“User termination or password change/reset: User session revocation is enforced in near real time.” 即“平时用缓存，撤销靠事件立即生效”，和方案 A 一样。
- ✅ OpenID CAEP（[规范 1.0](https://openid.net/specs/openid-caep-1_0.html)）：定义了“Session Revoked”事件，发送方可以“send continuous updates”给接收方。对应方案 A 里“撤销时主动推送取消”。
- ✅ Kubernetes（[kube-apiserver 参数](https://kubernetes.io/docs/reference/command-line-tools-reference/kube-apiserver/)）：授权 webhook 的结果默认缓存，“--authorization-webhook-cache-authorized-ttl ... Default: 5m0s”，拒绝结果“Default: 30s”。
- ✅ AWS API Gateway（[Authorizer API 参考](https://docs.aws.amazon.com/apigateway/latest/api/API_Authorizer.html)）：授权结果缓存“If this field is not set, the default value is 300. The maximum value is 3600”（秒）。
- ✅ Google Zanzibar 论文（[USENIX ATC 2019 PDF](https://www.usenix.org/system/files/atc19-pang.pdf)）：“95th-percentile latency of less than 10 milliseconds and availability of greater than 99.999% over 3 years”。说明大规模授权系统也要把单次核对压到毫秒级，而我们单次核对中位数 130 ms。

**对比与取舍**

方案 A 就是业界“缓存 + 持续评估 + 事件推送撤销”的组合。我们比通常做法多一层“按版本号比对”，因为单机部署下读版本号几乎免费。

**结果数据**

- 止血后：并发核对不再让任务超时被杀（提交 `15057e0`，随第七次之后的上线生效）。
- 方案 A：尚未上线，未测量。预期把 42 次完整核对降到 1 次加若干次版本比对。

**相关 ADR/PR**

提交 `15057e0`；[PR #30](https://github.com/sixianli/himawari-agent/pull/30)（草稿，方案 A 将加入）；[耗时分析文档](https://claude.ai/artifact/GsPbeiHDAFG1PPENkjiKfv)。

**面试 30 秒版**

“沙箱每个外发连接都要问一次授权，每次都完整核对，一次新闻请求核对了 42 次、约 7 秒，并发时还把任务自己超时杀掉了。先用 singleflight 的思路合并并发核对止血，再按零信任里‘缓存加持续评估’的做法改成：开头完整核对一次，之后按版本号比对，最多 60 秒重核，撤销时主动推送取消。”

[返回目录](#contents)

<a id="case-search-latency"></a>

## 案例 5：一次联网新闻回答要 49 秒：逐段拆耗时

**背景与现象**

Andy 在生产里问“今天有什么新闻”，等了约 49 秒才看到完整回答，第一个字出来前也要等很久。

**根因**（逐段计时，合计约 48 秒）

| 部分 | 耗时 | 原因 |
| --- | --- | --- |
| 写答案的模型调用 | 约 21 秒，其中首字约 10 秒 | 路由按“最便宜”选服务商，首字慢 |
| 两次搜索串行 | 9.2 秒 | 模型一次给了两个搜索调用，但按顺序一个一个执行 |
| 每次搜索的沙箱开销 | 约 8 秒（Exa 本身只要 1–2 秒） | 约 5 次授权核对约 2 秒、启动沙箱 1.5 秒、加载模块 1.2 秒、拆除 1.4 秒 |
| 授权核对 | 42 次，合计约 7 秒（关键路径约 3 秒） | 见[案例 4](#case-authority-checks) |
| 事件写盘排队 | 2.1 秒 | SQLite 用最严格的同步写入，每个事件 150–300 ms |
| 记忆检索 | 1.3 秒 | — |
| 没用上的沙箱预热 | 约 6 秒 CPU | 每轮都预热一个命令沙箱，但这次只用到搜索 |

关键发现是：模型只占一半，另一半全是我们自己的程序。

**我们的方案**（Andy 2026-10-26 决定）

1. **只读工具并行执行：** Pi 的工具定义里有 `executionMode`（可设 `"parallel"` 或 `"sequential"`），一批调用里只要有一个是顺序的，整批都顺序执行。把搜索、读网页等只读工具标为并行（[PR #30](https://github.com/sixianli/himawari-agent/pull/30)）。
2. **搜索和读网页移出沙箱：** 它们只发 HTTPS 请求、不碰文件，改在服务进程里执行，加主机侧出口检查：只允许 https、只允许配置里的主机、解析出的地址必须是公网地址（防止被诱导访问内网）。决定记在 ADR 0077（在 PR #30 里）。
3. **路由改成速度优先：** 首选服务商改为 digitalocean、fireworks、morph（2026-10-26 04:25 改生产配置）。
4. **授权核对按方案 A 改**，沙箱按方案 B 改（见[案例 4](#case-authority-checks)、[案例 6](#case-sandbox-cold-start)）。

**方案讨论与备选**

- 只换更快的模型服务商：只能省首字的几秒，另一半 24 秒不动。
- 搜索留在沙箱、只优化沙箱启动：每次仍有核对、启动、拆除；而搜索不碰文件，放进沙箱的安全收益很小，真正的风险是访问内网，用主机侧出口检查更直接。
- 所有工具都并行：会写文件或执行命令的工具并行可能互相冲突，所以只并行只读工具。

**业界主流做法**

- ✅ Claude Agent SDK 文档（[How the agent loop works](https://code.claude.com/docs/en/agent-sdk/agent-loop)）：“Read-only tools ... can run concurrently. Tools that modify state (like `Edit`, `Write`, and `Bash`) run sequentially to avoid conflicts.” 和我们的做法完全一致。
- ✅ Claude API 并行工具文档（[Parallel tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use)）：模型“can contain several `tool_use` blocks in a single assistant turn”，结果要“all together in the next user message”返回。
- ✅ Claude Code 沙箱文档（见[案例 3](#case-tool-isolation)）：WebFetch、WebSearch 不在沙箱里，走权限规则。
- ✅ OWASP SSRF（服务端请求伪造，即诱导服务器去访问内网地址）防护清单（[Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)）：协议要对照“an allowed list of protocols (HTTP or HTTPS)”，并且“Domain allowlisting alone does not prevent DNS rebinding. Validate the resolved destination IP addresses”。我们的出口检查正是“只允许 https + 只允许配置的主机 + 检查解析出的地址是公网地址”三层。

**对比与取舍**

我们的做法和 Claude Agent SDK 的默认行为一致：只读并行、写入顺序；网络工具不进沙箱、靠出口检查。取舍是：搜索出沙箱后，安全完全依赖主机侧的出口检查写对，所以给它单独写了测试。

**结果数据**

- PR #30 在 Hermes（项目的测试服务器）上 2375 个测试全部通过，前端压缩后总体积 176965 字节（上限 184320）。
- 尚未上线，生产耗时未重新测量。预期去掉两次搜索串行的约 4–5 秒和每次搜索约 8 秒的沙箱开销。

**相关 ADR/PR**

[PR #30](https://github.com/sixianli/himawari-agent/pull/30)（草稿，含 ADR 0077）；[耗时分析](https://claude.ai/artifact/GsPbeiHDAFG1PPENkjiKfv)；[提速方案](https://claude.ai/artifact/135D4LELqHTpXHBzYdtoEt)。

**面试 30 秒版**

“一次新闻回答 49 秒。我们逐段计时，发现模型只占一半，另一半是我们自己的：两个搜索串行、每次搜索在沙箱里花 8 秒而搜索本身只要 1–2 秒、授权核对 42 次。按 Claude Agent SDK 的做法让只读工具并行，把只发 HTTPS 的搜索移出沙箱、改用主机侧出口检查防 SSRF，再把路由改成速度优先。”

[返回目录](#contents)

<a id="case-sandbox-cold-start"></a>

## 案例 6：沙箱冷启动：从 3.3 秒到 0.22 秒，再到“用到才启动”

**背景与现象**

同一轮对话里复用沙箱之后，第一次工具调用仍然慢：Hermes 上中位数 3.3 秒，其中约 3.07 秒是新建常驻沙箱会话；而且同一轮里后面的调用经常又付一次。

**根因**

- 每当对话等用户批准再继续，系统会领一个新的执行租约（证明“这一轮由谁执行”的凭证），租约编号变了，而编号在沙箱的复用键里，于是每次批准后都把旧沙箱当作“权限已撤销”停掉、重新冷启动（提交 `0da0b59`）。
- 第一次调用前沙箱还没起来。

**我们的方案**

1. **复用键只保留不会因重新领租约而变化的部分**（授权租约、部署、授权纪元等），授权、允许的域名、模型等仍在键里；每次调用照样做完整准入，只复用沙箱进程。
2. **对话开始时预热**：模型还在思考时就在后台启动沙箱（提交 `0da0b59`）。
3. **方案 B（Andy 2026-10-26 批注“同意”，开发中）：** 预热在生产里浪费了约 6 秒 CPU（那次只用到搜索，见[案例 5](#case-search-latency)）。改为：同一对话复用一个沙箱，空闲 10 分钟回收，用到才启动，不再每轮预热。需要改 ADR 0031、0054、0067。

**方案讨论与备选**

- 每轮都预热：首次调用快，但用不上时白白耗 CPU；单机部署下 CPU 浪费会拖慢同时在跑的其他请求。
- 用到才启动 + 跨轮复用（方案 B）：第一次仍要冷启动，但之后整个对话都快，且没有浪费。
- 回收时间：参考业界 5–20 分钟的区间，选 10 分钟。

**业界主流做法**

- ✅ Claude 代码执行工具（[Code execution tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool)）：“After about 5 minutes of inactivity a container is checkpointed”，带着容器编号再请求即可恢复；容器从创建起 30 天后过期。即“空闲后挂起、按需恢复”。
- ✅ OpenAI 代码解释器（[Code Interpreter 文档](https://developers.openai.com/api/docs/guides/tools-code-interpreter)）：“A container expires if it is not used for 20 minutes.”，过期后数据不能恢复。
- ✅ E2B（[Sandbox persistence](https://docs.e2b.dev/sandbox/persistence)）：“Pausing a sandbox takes approximately 4 seconds per 1 GiB of RAM”，“Resuming a sandbox takes approximately 1 second”，暂停会同时保存文件系统和内存。
- ✅ AWS Lambda（[执行环境生命周期](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html)）：调用之间冻结执行环境，“When the function is invoked again, Lambda thaws the environment for reuse.”

**对比与取舍**

方案 B 和 Anthropic、OpenAI 的托管沙箱一样，按“会话复用 + 空闲回收”管理生命周期。我们没做“挂起到磁盘再恢复”，因为单机上直接保留进程 10 分钟成本更低。

**结果数据**

- 复用键修复 + 预热的第一版：Hermes 上第一次工具调用 3.3 秒 → 0.47 秒，但第 4 层测试有 14 个用例失败，原因是服务重启后和会话数量上预热做多了。修好后第七次生产变更的代码在 Hermes 第 0–4 层全部通过，首次工具调用中位数 0.22 秒（2026-10-25 项目进展记录）。
- 方案 B 未上线，未测量。

**后续（2026-10-26）**

第十二版的生产日志显示，每轮预热用了 4.9–7.5 秒，并且和事件写入变慢、运行完成推迟的时间点重合，没用工具的一轮也照样预热。按 Andy 同意的方案 B 先去掉了每轮预热，改为用到才启动，见[案例 24](#case-run-gaps) 和 [ADR 0085](adr/0085-remove-per-turn-system-gaps.md)；按对话复用仍是下一步。

**相关 ADR/PR**

[ADR 0054 的预热补充](adr/0054-readonly-tools-in-host-and-reused-task-sandbox.md#resident-prewarm)；提交 `0da0b59`；[PR #30](https://github.com/sixianli/himawari-agent/pull/30)（方案 B 将加入）。

**面试 30 秒版**

“沙箱复用后第一次调用还要 3.3 秒，查下来是复用键里放了每次批准都会变的租约编号，导致批准一次就冷启动一次。去掉这类字段、加上预热后降到 0.22 秒。后来生产数据显示预热常常用不上、白耗 6 秒 CPU，就改成和 Anthropic 代码执行容器一样的‘会话内复用、空闲回收、用到才启动’。”

[返回目录](#contents)

<a id="case-web-providers"></a>

## 案例 7：可替换的搜索供应商链

**背景与现象**

联网搜索原来只有一条写死的路径：沙箱程序连 Exa 的免费公开 MCP 服务（MCP 是让 AI 应用调用外部工具的一种通用协议）。没有读网页工具；Exa 一出问题，搜索就整个不可用；想换 DeepSeek 要改工具和授权流程。

**根因**

供应商信息（收件方、出口主机、是否要密钥）散写在工具、授权绑定和沙箱出口规则里，没有一处统一的定义。

**我们的方案**（ADR 0071）

- **供应商注册表：** 一处定义 `exa-public` 和 `deepseek`，写明收件方、出口主机端口、是否需要密钥、查询长度上限；工具和授权都只读注册表。
- **按配置顺序回退：** 限流、超时、服务不可用时换下一家；输入非法或结果被脱敏时直接失败、不换家。整条链共用 45 秒期限，剩余不足 5 秒不再开始下一家。
- **熔断：** 一家 5 分钟内失败 3 次，暂停 2 分钟不再尝试。
- **主机侧缓存：** 授权通过后、派发前查缓存，搜索缓存 10 分钟、读网页 15 分钟，最多 128 条。
- **一次同意覆盖整条链：** 供应商列表变了就要重新同意。
- **密钥通道：** 需要密钥的供应商只给“不访问文件的网络程序”注入密钥；模型和程序输入里只出现引用名，不出现密钥值。

**方案讨论与备选**

- 每家一个工具（`exa_search`、`deepseek_search`）：模型要自己选，失败也不会自动换家。没选。
- 让沙箱直接访问任意网页：和“按主机端口授权出口”冲突，内网风险要另处理。Andy 决定以后再说。
- 每家单独同意：要连点多次，回退时还可能卡在没同意的那一家。
- 缓存放在沙箱程序里：程序每次都是新进程，存不住。

**业界主流做法**

- ✅ 熔断器模式（Martin Fowler，[CircuitBreaker](https://martinfowler.com/bliki/CircuitBreaker.html)）：“Once the failures reach a certain threshold, the circuit breaker trips, and all further calls to the circuit breaker return with an error”，之后进入半开状态时“results in a trial call”。我们的“5 分钟内失败 3 次暂停 2 分钟”就是这个模式。
- ✅ AWS《Timeouts, retries, and backoff with jitter》（[原链接](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/)，现跳转到 AWS Builder Center）：重试用来应对“transient and random errors”，并且“APIs with side effects aren't safe to retry unless they provide idempotency.” 我们按错误类型决定换不换家，和这里的思路一致。

**对比与取舍**

和通用熔断、回退做法一致；特别之处是“授权按整条链一次同意”和“出错类型决定是否换家”（输入非法换家也没用，被脱敏换家会泄露）。

**结果数据**

第七到第九次上线陆续生效；搜索审计报告见 [https://claude.ai/artifact/QaTQNqMhqCmrdjnMmSGZC2](https://claude.ai/artifact/QaTQNqMhqCmrdjnMmSGZC2)。回退命中率等运行数据尚未统计。

**相关 ADR/PR**

[ADR 0071](adr/0071-replaceable-web-search-and-fetch-providers.md)；[PR #7](https://github.com/sixianli/himawari-agent/pull/7)、[PR #8](https://github.com/sixianli/himawari-agent/pull/8)。

**面试 30 秒版**

“搜索原来写死在 Exa 上，我们做了供应商注册表和回退链：按错误类型决定是否换家，整条链共享 45 秒期限，加熔断和主机侧缓存；密钥只注入给不碰文件的网络程序，模型永远看不到密钥值。换供应商只改配置。”

[返回目录](#contents)

<a id="case-search-toggle-spin"></a>

## 案例 8：改了搜索开关，对话空转 5 分钟

**背景与现象**

2026-10-25，Andy 在一次搜索准备过程中切换了联网搜索开关，之后那轮对话一直转圈，约 5 分钟后才报超时。

**根因**

开关一改，授权版本号就变了，正在准备的那次搜索在启动前被拒绝（这本身是对的）。但“结果恢复”逻辑会重新跑一遍授权，而版本已经变了，这次授权永远不可能通过；于是每约 2 秒重试一次，一直到 5 分钟期限（提交 `1a3aedc`）。

**我们的方案**

一个从未启动、预留已释放的工具调用不会泄露任何信息，所以恢复时直接从保存的凭证里交付“工具没有启动”（`SANDBOX_TOOL_NOT_STARTED`），不再重新授权。

**方案讨论与备选**

- 给恢复加重试次数上限：只是把 5 分钟变短，没解决“永远不可能成功的重试”。没选。
- 授权改成不看版本号：会让撤销失效。没选。

**业界主流做法**

- ✅ Stripe 幂等请求（[Idempotent requests](https://docs.stripe.com/api/idempotent_requests)）：带幂等键（idempotency key，给每个请求一个唯一编号）的请求“you can safely repeat the request without risk of creating a second object”。重点是先判断“重复执行是否安全、是否可能成功”，再决定是否重试；我们的修复按同样思路识别出“永远不会成功”的重试。

**对比与取舍**

修复按“这个状态还可能变成功吗”来区分错误，而不是按次数截断，和“只重试暂时性错误”的原则一致。

**结果数据**

第九次上线（2026-10-25 18:11Z）后生效；同类空转未再出现（未做专门统计）。

**相关 ADR/PR**

[PR #22](https://github.com/sixianli/himawari-agent/pull/22)；提交 `1a3aedc`。

**面试 30 秒版**

“用户在搜索准备时切了开关，授权版本变了，恢复逻辑却一直重试一次永远不可能通过的授权，空转 5 分钟。修复是识别‘从未启动、什么都没泄露’的状态，直接交付明确的失败结果，而不是给重试加上限。”

[返回目录](#contents)

<a id="case-context-window"></a>

## 案例 9：上下文窗口配错，长回答被截断

**背景与现象**

Andy 让 Agent 写一个贪吃蛇游戏，做到第 16 步时回答突然只剩一个字就结束了，界面显示“回答不完整”。

**根因**

- 生产配置把 DeepSeek 的上下文窗口（模型一次能处理的最大文字量，按 token 计，token 是模型处理文字的基本单位）写成了 32768，而真实值是 1048576。
- 第 16 步时对话历史已约 2.9 万 token。Pi 会把“最大输出长度”限制为“窗口 − 已用 − 4096”，于是只剩 1 个 token 可写。
- 这个错误配在两处，第九次上线一起修正（提交 `01d3388` 及第九次上线记录）。

**我们的方案**

1. 配置改成真实值：窗口 1000000、最大输出 32768。
2. 加防护：如果算出来的可输出长度太小，调用前就拒绝并报 `PI_CONTEXT_WINDOW_EXHAUSTED`，界面明确告诉用户“对话超出上下文”；如果模型因长度停止且几乎没输出，也按同一错误处理。

**方案讨论与备选**

- 只改配置不加防护：下次再配错还是悄悄截断成一个字。
- 自动压缩历史：是长期方向，但不能替代“配置错误要明确报错”。

**业界主流做法**

- 🟡 Claude API 上下文窗口文档（[Context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows)）：Claude 4.5 及以后的模型，“if input tokens plus `max_tokens` exceeds the context window size, the API accepts the request”，生成到上限时以 `model_context_window_exceeded` 停止；更早的模型直接返回参数错误。也就是说，头部厂商的做法是给出一个专门的停止原因，让应用能区分“写完了”和“写不下了”。我们的 `PI_CONTEXT_WINDOW_EXHAUSTED` 起的是同样的作用。

**对比与取舍**

我们选择“调用前就拒绝”，比“让模型写到一半再停”更省钱也更清楚；代价是要相信配置里的窗口大小，所以配置值必须和供应商公布的一致。

**结果数据**

第九次上线后长回答恢复正常；同一次上线如果不先删预算上限，按新窗口估算每次调用要预留约 53 万微美元，超过每轮 10 万的上限，所有对话都会被拦（见[案例 10](#case-budget-removal)）。

**相关 ADR/PR**

[PR #22](https://github.com/sixianli/himawari-agent/pull/22)；提交 `01d3388`。

**面试 30 秒版**

“窗口配成了 3.2 万而真实是 100 万，框架把可输出长度算成‘窗口减已用’，第 16 步时只剩 1 个 token，回答被截成一个字。修配置的同时加了防护：可输出空间不够就调用前报明确错误，和 Claude API 用专门停止原因区分‘写不下’是同一个思路。”

[返回目录](#contents)

<a id="case-budget-removal"></a>

## 案例 10：删掉费用预算上限，只保留用量账本

**背景与现象**

配置里有三种费用上限：全局累计 1 美元、“私密”类累计 0.1 美元、单轮 0.1 美元。前两种从第一次调用起累计、永不清零。当时实际用量约 0.038 美元，按这个速度两三天后所有对话都会被拦；第九次上线修正上下文窗口后，单次调用的预留就超过了单轮上限（见[案例 9](#case-context-window)）。

**根因**

“累计永不清零”的上限不是预算，而是一个迟早会触发的停机开关；而且预留按最坏情况估算，窗口一放大，预留就远超实际花费。

**我们的方案**（ADR 0076）

- 删除整个 `budgets` 配置段；严格配置校验把它当未知字段拒绝启动，不留“看着像限制其实不起作用”的字段。
- 准入不再按费用拒绝任何调用。
- 保留预算账本：记录每次调用的预估、实际花费和状态（已预留 → 已开始 → 已结算 / 结果未知 / 已释放）。结果未知时账户进入“需要对账”状态，防止服务重启后重复发请求。
- 不改数据库结构，旧数据照样合法。

**方案讨论与备选**

- 把上限调成极大值：字段和比较代码都还在，有人照旧样例写回 1 美元又会全部卡住；Andy 不要摆设。
- 整套删掉账本：账本同时承担调用身份和重启后不重复请求的职责，删掉风险大、没收益。
- 新代码接受但忽略旧字段：忽略的字段就是摆设。

**业界主流做法**

- ✅ Vercel AI Gateway 预算（[Budgets and Spend Limits](https://vercel.com/docs/ai-gateway/observability-and-spend/budgets)）：“A budget caps AI Gateway spend at one of four scopes: Team… Project… API key… User”。费用上限可以放在网关一侧设置，产品内只记账，是一种常见分工。

**对比与取舍**

费用上限的职责交给模型网关和人工查看用量，产品内只保留“记账 + 防重复请求”。代价是失控的循环不会被费用拦住，要靠轮次期限和工具期限兜底。

**结果数据**

第十次上线（2026-10-26）后生产配置已无 `budgets`；用量账本照常记录。

**相关 ADR/PR**

[ADR 0076](adr/0076-no-model-cost-budget-limits.md)；[PR #23](https://github.com/sixianli/himawari-agent/pull/23)。

**面试 30 秒版**

“累计永不清零的费用上限其实是定时停机开关，而且预留按最坏情况算，窗口一放大单次预留就超限。我们删掉上限字段、让配置校验拒绝它，但保留账本，因为账本还负责‘结果未知时先对账、重启后不重复发请求’。”

[返回目录](#contents)

<a id="case-tenth-deploy"></a>

## 案例 11：第十次上线：五次尝试才成功

**背景与现象**

2026-10-26 00:29 Andy 授权第十次上线（包含自研记忆、删预算等）。上线脚本在停服后跑验收，任何一项不过就自动回退到旧版本。前四次都失败并自动回退：

| 次数 | 失败原因 | 停服 |
| --- | --- | --- |
| 1 | 操作包里 3 个测试脚本还是第九次的旧版本，生成的测试配置里还带着已删除的 `budgets` | 约 5 分钟 |
| 2 | 第一次失败留下的临时目录没清，脚本拒绝继续 | 约 5 分钟 |
| 3 | 验收第 21 项：后台沙箱 10 秒内没启动。在 Hermes 上重跑 10 次都通过；失败前 25 秒内核正在回收网络命名空间（沙箱用来隔离网络的系统机制） | 约 5 分钟 |
| 4 | 验收脚本读取 `s7-catalog-after51.json`（第九次的文件名），而这次前一步写出的是 `after55`；回退时 systemd（Linux 的服务管理器）显示旧版本“已启动”，但它第一次启动其实超时了 | 约 17 分钟 |
| 5 | 03:13Z 通过（版本 `030f81f`，数据库结构 55） | 约 17 分钟 |

**根因**

- 第 1、4 次是同一类错误：操作包（上线用的一整套固定脚本和输入）是复制上一次的再改，旧文件和旧文件名留了下来。这类错误此前在第三、四、六次上线已经出现过（记在 lessons 的“操作包里写死的摘要和文件清单没跟着内容更新”）。
- 第 4 次的回退“成功”是假的：只看 systemd 状态，没看用户能不能打开首页。
- 第 3 次是偶发的系统资源竞争，不是代码问题，但暴露了沙箱启动没有分阶段计时、子进程错误输出被丢弃，很难诊断。

**我们的方案**

1. **硬检查（按 ADR 0060 的“第三次就加硬约束”）：** 操作包一致性检查新增 `EVIDENCE_NAME_WITHOUT_PRODUCER`：每个验收步骤读取的证据文件，必须由前一步写出；否则上线脚本直接拒绝（退出码 3），不会走到停服。
2. **回退要等首页 200：** 回退脚本从恢复后的配置读出监听地址，最多等 180 秒等首页返回 200，稳定期后再查一次，才算回退成功（提交 `20a0cb5`，[PR #29](https://github.com/sixianli/himawari-agent/pull/29)）。
3. **所有检查放在停服之前**，能提前发现的问题不占停服时间。
4. 后续改进（已记录、未做）：沙箱宿主启动分阶段计时、保留子进程错误输出。

**方案讨论与备选**

- 只写一条“复制操作包时要改名”的提醒：前几次已经有书面规则，仍然重犯，所以必须改成脚本强制检查。
- 回退只看服务状态：第 4 次证明“服务已启动”不等于“用户能用”。
- 第 3 次加长等待时间：没有分阶段计时前不知道慢在哪，盲目加长可能掩盖真问题，所以先记为待改进的诊断能力。

**业界主流做法**

- ✅ Kubernetes 就绪探针（[配置存活、就绪和启动探针](https://raw.githubusercontent.com/kubernetes/website/main/content/en/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md)，kubernetes/website 仓库的源文件）：“A pod with containers reporting that they are not ready does not receive traffic through Kubernetes Services.”，HTTP 探针“Any code greater than or equal to 200 and less than 400 indicates success.” 即“进程起来了”和“能接流量”要分开判断，我们的“等首页 200”就是就绪探针。
- ✅ 十二要素应用的“构建、发布、运行”（[V. Build, release, run](https://raw.githubusercontent.com/heroku/12factor/main/content/en/build-release-run.md) 源文件）：“strict separation between the build, release, and run stages”，“Every release should always have a unique release ID”，发布一旦创建不能修改。我们每次上线一个独立发布目录、不改旧包，符合这一点；而“复制旧包再改”恰恰违反了“发布不可变、由构建产生”。
- ✅ Google SRE《发布工程》（[Release Engineering](https://sre.google/sre-book/release-engineering/)）：“Our builds are hermetic, meaning that they are insensitive to the libraries and other software installed on the build machine”。操作包应该每次重新生成，而不是复制上一次再改。
- ✅ Google SRE 工作手册《金丝雀发布》（[Canarying Releases](https://sre.google/workbook/canarying-releases/)）：“a partial and time-limited deployment of a change in a service and its evaluation”。单机部署做不了按流量比例的金丝雀，所以我们用“停服前在生产机上试跑探针”代替。
- ✅ Google SRE《事后复盘文化》（[Postmortem Culture](https://sre.google/sre-book/postmortem-culture/)）：“Blameless postmortems are a tenet of SRE culture.” 我们的 lessons 记录也只写原因和约束，不追究是哪个代理犯的错。

**对比与取舍**

我们是单机部署，没有滚动发布和流量切换，所以“停服 → 验收 → 失败自动回退”是最稳妥的形态，代价是每次失败都有几分钟停服。改进方向是业界通用的：把检查前移到停服之前，把“就绪”而不是“已启动”作为成功标准。

**结果数据**

- 第五次尝试通过，停服约 17 分钟；部署日志 `run-logs/deploy-20261026T024703Z.log`。
- 新检查的验证：放回第四次的旧文件时报 `EVIDENCE_NAME_WITHOUT_PRODUCER ... s7-catalog-after51.json`，改成 `after55` 后这一项消失（记录在 lessons）。它只覆盖两个读取脚本，内容过时但名字合法的文件仍要靠已有的哈希核对。检查脚本在操作包里，操作包不进仓库。

**相关 ADR/PR**

[ADR 0074](adr/0074-claude-runs-production-deployments.md)、[ADR 0060](adr/0060-hard-constraint-on-third-repeat.md)；[PR #27](https://github.com/sixianli/himawari-agent/pull/27)、[PR #29](https://github.com/sixianli/himawari-agent/pull/29)；[lessons：复制上一次操作包时留下旧文件和旧文件名](lessons.md#copied-packet-stale-names)、[lessons：操作包里写死的摘要和文件清单没跟着内容更新](lessons.md#stale-packet-pins)。

**面试 30 秒版**

“一次上线试了五次。四次失败都被自动回退接住了，但我们发现其中两次是‘复制上一次操作包留下旧文件名’，这类错误以前犯过，所以加了脚本强制检查：每一步读的证据文件必须是前一步写出来的。还有一次回退显示成功其实首页打不开，于是按就绪探针的思路改成等首页返回 200 才算恢复。”

[返回目录](#contents)

<a id="case-static-root"></a>

## 案例 12：生产一直在跑 10 月 7 日的旧前端

**背景与现象**

2026-10-25，Andy 发现生产界面上联网搜索开关点不动，后台日志报 `$.payload.recipients: unknown field`。第五、六、七次上线里改过的前端都没有生效。

**根因**

前端静态文件目录（配置里的 `staticRoot`）自 10 月 7 日第一次部署后从没更新过：上线包更新了服务端，却没有一并更新静态文件。旧前端发的请求格式和新服务端对不上，就出现了“未知字段”。验收也只测了服务端接口，没核对浏览器拿到的前端是不是新版。

**我们的方案**

1. 10-25 12:09 用脚本把静态目录切到新版本（`STATIC_ROOT_FIX_PASSED`）。第一次运行时停服后才发现一个系统命令路径写错（`runuser` 在 `/usr/sbin/` 下），于是把所有检查都挪到停服之前。
2. 规则：每次上线包必须一并更新 `staticRoot`；验收要核对服务端返回的前端资源和新版本一致。

**方案讨论与备选**

- 前端由服务端进程直接从发布目录读取（不单独配置静态目录）：能根除不同步，但要改配置结构，当时先用规则 + 验收核对。

**业界主流做法**

- ✅ 十二要素应用的“构建、发布、运行”（见[案例 11](#case-tenth-deploy)）：一次发布应包含构建产物和配置的完整组合并有唯一编号；前端和后端分开更新、其中一个停在旧版本，正是这一原则要避免的。

**对比与取舍**

用验收核对“用户实际拿到的版本”，而不是只核对服务端。

**结果数据**

修复后搜索开关等前端改动在生产生效（`STATIC_ROOT_FIX_PASSED`）。“上线包一并更新 `staticRoot`、验收核对前端资源版本”已定为上线规则。

**相关 ADR/PR**

第七次之后的上线记录；项目记忆中的“生产旧前端事故”条目。

**面试 30 秒版**

“三次上线的前端改动都没生效，因为静态文件目录从第一次部署后就没更新过，而验收只测了服务端。之后把‘用户实际拿到的前端版本’纳入验收。”

[返回目录](#contents)

<a id="case-fast-mode"></a>

## 案例 13：快速交付模式：把“门槛”变成一个开关

**背景与现象**

2026-10-25 Andy 说：现在只有我一个用户，要尽快让完整产品上线给投资人看，但每改一点都要跑大量测试和演练。盘点结果：

- 第五次上线真正的上线步骤只用了 16 分钟，其余两个多小时花在出错后的修订上。
- 第六次上线修订了 7 次，服务停了约 57 小时。
- 合并进主分支要等 CI（持续集成，提交后自动跑的检查），每次 20–55 分钟；当天 19 次运行里 13 次失败或被取消。

**根因**

流程是为“多人、生产有真实用户”设计的：每次修订都要在测试机上跑第 0–4 层测试、重新冻结操作包、演练、再批准。对一个人用、需要快速迭代的阶段来说，门槛成本远大于它防住的风险。

**我们的方案**（ADR 0073、ADR 0074）

1. 仓库根目录放一个 `DELIVERY_MODE` 文件：`fast` 是快速模式，`full` 或没有文件是完整模式。只有 Andy 能切换。
2. 快速模式只保留：和改动相关的测试、`npm run check`（格式、lint、类型检查、模块边界、密钥扫描）、`npm run build`。
3. 暂停的规则写在一处（`.agents/instructions/delivery-mode.md`），提交钩子读到 `fast` 时跳过逐层测试声明。
4. GitHub 合并规则由脚本一键切换。
5. 上线、回滚各一条命令，由 Claude 直接执行（ADR 0074）。
6. 不变的底线：不在 MacBook 上跑测试、不写代码注释、每个提交都推送。

**方案讨论与备选**

- 每个任务说明里写“这次少跑点”：规则散在多处，每个线程都要重新说服一遍。
- 改 CI 工作流：CI 配置本身被严格核对，改它又要走完整流程。
- 环境变量做开关：每个线程、每台机器都要单独设置，容易漏；提交进仓库的文件所有人读到的都一样。

**业界主流做法**

- ✅ 功能开关（Martin Fowler，[Feature Toggles](https://martinfowler.com/articles/feature-toggles.html)）：区分“Release Toggles”（让未完成的代码先上线但不启用）和“Ops Toggles”（“control operational aspects of our system's behavior”）。`DELIVERY_MODE` 是管流程的开关，而不是管功能的开关，思路相同。
- ✅ DORA 交付指标（[DORA's software delivery performance metrics](https://dora.dev/guides/dora-metrics/)）：已从“original four keys”改为五项：Change lead time（变更前置时间）、Deployment frequency（部署频率）、Failed deployment recovery time（失败部署恢复时间）、Change fail rate（变更失败率）和 Deployment rework rate（部署返工率）。快速模式改善的主要是前两项，代价可能体现在变更失败率上，所以要靠自动回退控制恢复时间。

**对比与取舍**

用一个提交进仓库的文件当“流程开关”，让人和所有 AI 代理读到同一个状态；代价是快速模式下测试覆盖变少，要靠“上线失败自动回退”兜底（见[案例 11](#case-tenth-deploy)）。

**结果数据**

切换后第七到第十次上线在两天内完成（10-25 11:13、14:53、18:11，10-26 03:13）；对比第六次修订 7 次、停服约 57 小时。

**相关 ADR/PR**

[ADR 0073](adr/0073-fast-delivery-mode.md)、[ADR 0074](adr/0074-claude-runs-production-deployments.md)；[快速模式规则](../.agents/instructions/delivery-mode.md)。

**面试 30 秒版**

“第六次上线修订 7 次、停服 57 小时，时间都花在门槛上。我们盘点了 14 道门槛，把流程做成一个提交进仓库的开关：快速模式只跑相关测试、静态检查和构建，上线和回滚各一条命令，失败自动回退。之后两天内上线了四次。”

**后续（2026-10-26）：快速模式下把文档校验加回来**

快速模式把文档治理整套暂停后，文档开始落后：10-25 以来 `main` 上 88 个提交里有 27 个写了 `Docs: deferred (fast mode)`，严格校验积累了 7 个错误（6 个 Runbook 摘要与代码不符，1 个 Runbook 依据的 Mem0 文件已删除）。另一个原因是 claude.ai 项目的云端线程不加载仓库里的 `.claude/skills/`，文档治理 skill 虽然在仓库里，线程看不到。

调整（[ADR 0080](adr/0080-document-governance-in-fast-mode.md) 取代 ADR 0073）：

- 规则写进云端线程每次启动都会读的 `.claude/rules/document-governance.md`，写明 skill 在哪、什么情况必须用。
- `npm run check` 加一步 `check:docs`：跑一次严格校验，约 1 秒（云端实测 0.997 秒）。快速模式下只放行“Runbook 封存落后”这一类错误，其余结构错误都拦下；完整模式全部拦下。
- 按错误类型放行，不维护“已知错误清单”：现有 7 个错误正好都属于这一类，放行规则和快速模式“Runbook 复核延后”的规则一致，不需要另一份要手工维护的清单。
- 取舍：只写规则成本最低，但 27 个欠账提交说明光靠文字不够；完全恢复又会让几乎每个改产品代码的提交都要复核 Runbook。最后只把“1 秒能查完的”留下，“要人逐个复核的”继续延后，并记成 Backlog。

结果数据：加入后 `npm run check:docs` 在当前 `main` 上通过，放行 7 个 Runbook 封存错误，0 个阻断错误；“之后欠账是否减少”未测量。


[返回目录](#contents)

<a id="case-agent-governance"></a>

## 案例 14：管住 AI 编码代理：同一错误第三次就加硬约束

**背景与现象**

这个项目的代码大部分由 AI 编码代理写，多个代理（Claude、Codex、opencode）在不同会话里协作。同类错误会在不同会话、不同代理之间反复出现，例如：直接 ssh 到测试机干扰正在跑的测量、复制操作包留下旧文件名、给用户的回复没用中文、新代码里加注释。

**根因**

代理每次会话都从零开始，书面提醒容易被忽略或在上下文压缩时丢失；只靠“下次注意”防不住。

**我们的方案**（ADR 0060）

- 同一错误第三次出现时，停下当前工作，找出之前的预防为什么失效，然后加一个对所有代理都生效的硬约束：自动化测试、提交或 CI 门禁、脚本每次运行都做的检查、拒绝规则、钩子。
- 必须先在复现上看到它报错，去掉错误后看到它通过。
- 错误和约束记在 [docs/lessons.md](lessons.md)，目前已有 25 条。
- 例子：
  - 直接 ssh 到测试机：加了 `hermes_direct_ssh_guard.py` 钩子，直接调用会被拒绝，只能走封装脚本（[lessons：对照测量时机器上有别的负载](lessons.md#measurement-not-isolated)）。
  - 复制操作包留下旧文件名：`EVIDENCE_NAME_WITHOUT_PRODUCER` 检查（[案例 11](#case-tenth-deploy)）。
  - 漏跑相关测试：提交说明必须逐行写 `Layer-0-tests:`，钩子核对（[lessons：第 0 层漏跑直接相关的测试文件](lessons.md#layer0-related-tests)）。

**方案讨论与备选**

- 每次犯错都加规则：规则会膨胀到没人读。所以一次错误不记录，第三次才加硬约束。
- 只写进提示词：已证明不够。

**业界主流做法**

- ✅ 精益生产的防错（[Poka Yoke](https://www.lean.org/lexicon-terms/poka-yoke/)，Lean Enterprise Institute）：“Poka-yoke is a Japanese term that means "error-proofing"”，目标是“finding defects at their source”。“第三次就加硬约束”就是把复盘结论变成防错装置。无责复盘见[案例 11](#case-tenth-deploy) 引用的 Google SRE 原文。

**对比与取舍**

把复盘的结论落到“机器强制执行”而不是“人记住”，对 AI 代理尤其必要，因为它们没有跨会话的记忆。代价是约束本身要维护，过时的约束会挡路，所以 ADR 0073 的快速模式会暂停一部分。

**结果数据**

lessons 共 25 条；第十次上线中“复制操作包留旧名”达到第三次后当天加了检查。各约束加上后同类错误是否再犯，尚未系统统计。

**相关 ADR/PR**

[ADR 0060](adr/0060-hard-constraint-on-third-repeat.md)；[docs/lessons.md](lessons.md)。

**面试 30 秒版**

“项目代码主要由多个 AI 编码代理写，它们没有跨会话记忆，同类错误会反复出现。我们定了一条规则：同一错误第三次就必须加一个机器强制的约束，比如钩子、提交门禁或脚本检查，并且要先在复现上看到它报错。现在 lessons 里有 25 条这样的记录。”

[返回目录](#contents)

<a id="case-model-gateway"></a>

## 案例 15：模型网关迁移和“速度优先”路由

**背景与现象**

- 2026-10-04 Andy 决定不再用 OpenRouter（一家模型网关服务，统一对接多家模型厂商），改用 Vercel AI Gateway；文本模型只能用 `deepseek/deepseek-v4.1-flash`，嵌入模型沿用 Qwen3 Embedding 8B。
- 要求“合理路由，性价比最高”，于是路由按最便宜的服务商优先。
- 2026-10-26 拆解新闻请求耗时时发现，最便宜的服务商首字要约 10 秒（见[案例 5](#case-search-latency)）。

**根因**

同一个模型在网关上有多家服务商实际运行，价格和速度差别很大；“最便宜优先”在演示阶段牺牲了最影响体验的首字延迟。

**我们的方案**

1. **迁移时复用 Pi 已有的 `openai-completions` 接口**，指向 Vercel 的 OpenAI 兼容地址，不在 Himawari 里另写一套请求协议（ADR 0048）。OpenRouter 专有字段换成 Vercel 对应能力或删除。
2. **路由改为速度优先**：首选服务商改为 digitalocean、fireworks、morph（2026-10-26 04:25 改生产配置，重启 32 秒，旧配置已备份）。

**方案讨论与备选**

| 备选 | 为什么没选 |
| --- | --- |
| 用 Pi 自带的 `vercel-ai-gateway` 接入 | 只走 Anthropic 格式接口，模型清单里没有需要的模型，要升级 Pi 或改上游 |
| 在 Himawari 里引入 Vercel AI SDK | 等于在 Pi 之外再建一套请求协议，违背“Pi 优先”原则 |
| 继续最便宜优先 | 首字约 10 秒，演示体验差；Andy 定模型费用不设限 |

**业界主流做法**

- ✅ Vercel AI Gateway 服务商路由（[Provider Routing and Fallbacks](https://vercel.com/docs/ai-gateway/models-and-providers/provider-options)）：“You can use order, only, and sort in providerOptions.gateway”，其中 `sort` 可取 `'cost'`（价格）、`'ttft'`（首字延迟）和 `'tps'`（吞吐）。我们现在用 `order` 固定首选服务商；如果服务商的速度经常变化，可以改成 `sort: 'ttft'`，让网关按实测首字延迟排序。

**对比与取舍**

在网关一层做服务商选择，产品只关心“哪个模型”，换服务商只改配置。速度优先的代价是单价更高。

**结果数据**

速度优先路由的实际提速，要等 Andy 下次查新闻时测量；目前未测量。

**相关 ADR/PR**

[ADR 0048](adr/0048-vercel-ai-gateway-replaces-openrouter.md)。

**面试 30 秒版**

“我们用 Vercel AI Gateway 统一接模型，复用框架已有的 OpenAI 兼容接口，不另写协议。一开始按最便宜路由，拆耗时发现首字要 10 秒，就改成速度优先，换服务商只改配置。”

[返回目录](#contents)

<a id="case-narration-status"></a>

## 案例 16：运行中却显示“已完成”：模型过渡话被当成回答

**背景与现象**

2026-10-26 Andy 在生产版（030f81f）里问“搜一下美国新闻，给我最新的10条”。页面顶部写“正在执行”，步骤列表里两个“搜索网页”一个“正在执行”、一个“正在准备”，可下面同时出现一个“已完成”标签和一句英文“I'll search for the latest US news now.”。Andy 问这是设计如此还是 bug。随后这一轮卡了一分多钟：第一个搜索变成“结果未确认”，第二个一直“正在准备”。

**根因**

读代码确认是三个问题叠在一起：

1. **把“一段文字说完了”误当成“这一轮完成了”。** 模型调用工具前会先说一句过渡话，这句话和两个工具调用在同一条模型消息里。消息一结束，服务端把这段文字记成 `completed`（`thread-execution-projection.ts`）。前端 `chat-history.tsx` 把“最后一段文字”直接当作回答预览放在步骤列表下面，并原样显示它的状态，于是出现“上面正在执行、下面已完成”。两个状态说的是不同对象，但摆在一起像是在说同一件事。
2. **英文过渡话。** Pi 自带的系统提示词全是英文（`pi-coding-agent` 的 `buildSystemPrompt`，开头是 “You are an expert coding assistant…”），我们追加的产品指令里没有“用用户提问的语言回答”这条，模型就顺着英文说了。产品需求文档早就定了“模型根据用户提问选择回答语言”，只是没写进指令。
3. **状态文案说的不是实情。** 生产版的工具一个接一个执行，第二个搜索其实在排队等第一个结束，服务端只能看到“还没开始”，统一显示成“正在准备”。第一个搜索的“结果未确认”，对应执行环境超过约定时间没有回报（原因码 `RESOURCE_OBSERVATION_EXPIRED` 或 `RESOURCE_STATE_UNCONFIRMED`），页面却用了和“这一轮已经结束但结果不明”一样的字眼。为什么没回报，由耗时优化线程查生产日志，本案例不下结论。

用单元测试复现：按截图构造“过渡话 + 两个搜索、第一个在执行”的记录，旧代码渲染出 `chat.phase.completed`、没有“排队”状态，4 个新测试在旧代码上全部失败。

**我们的方案**

- 只在前端改展示，不改服务端记录：工具调用之前的模型文字（判断方法：之后还有工具调用）放进步骤列表它出现的位置，用对话气泡图标显示原文；步骤列表下面只放最后一次工具之后的文字，也就是真正的回答。
- 回答预览的“已完成”只在整轮结束后才显示，进行中一律显示“输出中”。
- 模型已经请求、但 Pi 还没开始执行的工具，显示“排队等待”，不再显示“正在准备”。
- 执行环境没按时回报时显示“执行环境没有按时回报”；卡住时的提示改成白话：“工具已经交给执行环境，但还没收到它的结果……可以继续等，或点停止结束这一轮”。
- 产品指令固定加一条回答语言规则：用用户本轮提问的语言回答，调用工具前后写给用户的说明也用这种语言，搜索关键词可以用别的语言。复用 Pi 的“追加系统提示词”入口，不改 Pi。

**方案讨论与备选**

| 备选 | 好处 | 为什么没选 |
| --- | --- | --- |
| 服务端把过渡话的状态改成“进行中” | 前端不用判断 | 记录要如实反映“这段文字确实说完了”，改记录等于让数据说谎；而且历史记录不会变 |
| 直接隐藏过渡话 | 页面最干净 | 过渡话告诉用户模型打算做什么，藏掉会让步骤列表更像黑盒；Anthropic 文档也建议把它当成普通回答文字展示 |
| 用提示词禁止模型说过渡话 | 问题从源头消失 | 模型不一定照做，换模型就可能复发；展示逻辑本身仍然是错的 |
| 在设置里加“回答语言”选项 | 用户可控 | Andy 2026-09-12 定过“语言选择器只控制界面，不往模型指令里注入页面语言”，所以只按用户提问的语言回答 |

放弃了什么：过渡话没有单独的状态和时长；文字还在流式输出、工具调用还没出现的那一两秒里，它会先显示在回答位置，等工具调用出现再移进步骤列表。

**业界主流做法**

- ✅ Anthropic 工具调用文档（[Define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools#model-responses-with-tools)）：“When using tools, Claude often comments on what it's doing or responds naturally to the user before calling tools.”，并要求“Your code should treat these responses like any other assistant-generated text”。说明调用工具前的过渡话是常态，应当作为模型说的话展示，而不是丢掉。
- ✅ OpenAI 官方 Node SDK 的 Responses 接口类型定义（[openai-node `responses.ts`](https://github.com/openai/openai-node/blob/master/src/resources/responses/responses.ts)）：单个输出项结束时发 `ResponseOutputItemDoneEvent`（“Emitted when an output item is marked done.”），整次回复结束时才发 `ResponseCompletedEvent`（“Emitted when the model response is complete.”）；每条消息自己的 `status` 是 “One of `in_progress`, `completed`, or `incomplete`”。也就是说，主流接口都把“某一项完成”和“整次回复完成”分成两件事。

**对比与取舍**

和业界一样，我们保留“每段文字、每个工具各有自己的状态”，只是在界面上把“某段文字说完了”和“这一轮完成了”分开展示：前者放进过程，后者只在整轮结束时出现。差别在于我们没有改记录格式，判断“哪段是过渡话”靠的是“后面还有没有工具调用”，这在文字流式输出的头一两秒里还判断不了。

**结果数据**

- 4 个新单元测试在旧代码上失败、新代码上通过；控制中心全部 392 个测试通过（2026-10-26，云端容器）。
- 前端 gzip 总体积 176965 → 177406 字节（上限 184320），入口 148942 字节（上限 153600），来自本次 `npm run build` 输出。
- 卡住一分多钟的原因、改后用户是否看得懂：未测量，等上线后 Andy 实测。

**相关 ADR/PR**

[PR #33](https://github.com/sixianli/himawari-agent/pull/33)（提交 42a0ad5）；相关背景：[ADR 0048](adr/0048-vercel-ai-gateway-replaces-openrouter.md)（模型接入复用 Pi）、[案例 5](#case-search-latency)（同一类新闻请求的耗时）、PR #15（每步白话摘要）。

**面试 30 秒版**

“用户看到上面‘正在执行’、下面‘已完成’。查下来是界面把‘模型调用工具前说的一句话说完了’当成了‘这一轮完成了’。我们没改记录，而是在界面上把过渡话放回执行过程里它出现的位置，‘已完成’只在整轮结束后出现；顺手把排队中的工具标成‘排队等待’，并补上‘用用户提问的语言回答’的指令。先写了 4 个能复现的测试，旧代码全失败、新代码全通过。”

[返回目录](#contents)

<a id="case-memory-page"></a>

## 案例 17：记忆管理页重设计：记忆越来越多，一页长列表管不过来

**背景与现象**

自研记忆上线后（[案例 1](#case-memory-engine)），“设置 → 记忆”页面是 PR #17 时做的一页长列表，从上到下排着 7 块内容。2026-10-26 Andy 要求重新设计，并要求先看原型图再改代码。当时的问题：

- 两块都叫“待你确认”（敏感记忆审批、推测出的习惯），按钮叫法还不一样。
- 同一条“主人最喜欢蓝色”在档案里一次、列表里一次，分不清是一条还是两条。
- 列表只能按文字搜，不能按分类、状态、时间看；每条下面三个大按钮，一屏只能看约 3 条。
- 每日整理归档的记忆看不到；按天的整理记录藏在页底折叠块里。
- 提醒只在到点时出现，已经安排的提醒看不到，也不能提前取消。
- 删除要弹确认框；“归档”和“删除”两个按钮，Andy 问“有什么区别”。

**根因**

页面是随功能一块一块加出来的：每加一种能力（审批、推测、整理、提醒）就在页底再加一块，没有按“用户要做什么”重新组织。后端很多数据库里已有的信息（分类、归档状态、最近用到时间、未来的提醒）也没有传给页面，前端想做筛选也没有数据。

**我们的方案**

先做可点的原型和设计说明给 Andy 审（2026-10-26 07:05、07:15 两次同意），再改代码：

- **按用途分页签：** 设置窗口在记忆页加宽到 960 像素（其他设置页仍是 680）。页签分两组，中间一条竖线：“要处理的”（待确认、提醒）和“随时看的”（档案、全部记忆、时间线）。三种待确认合并成一个队列。
- **档案：** 按分类分卡片，卡片里按小类分组，每张先显示 3 条。小类由模型在记下记忆时给出，要求优先复用已有小类，每个分类最多 8 个。
- **全部记忆：** 搜索 + 分类、小类、状态（在用 / 已归档 / 最近删除）筛选，按“今天 / 本周 / 更早”分组；按钮收进展开后的详情。
- **删除改成可恢复：** 不再弹确认框，删除后先进“最近删除”，7 天内可恢复，之后自动彻底清除；删的那一刻底部有 6 秒的“撤销”。每条记忆只留“编辑 / 删除”，归档只由每日整理自动做。
- **提醒：** 后端新增“接下来”的提醒列表和“不再提醒”（`cancel`）动作；每年重复的提醒点“不再提醒”只结束这一年，取消则彻底停止。
- **人物关系：** 不引入图数据库，在 SQLite 主库加人物、别名、人物关系等表。提炼记忆的那次模型调用顺便输出“提到的人和关系”，不加额外调用；拿不准是不是同一个人时进“待确认”问 Andy。界面上画以一个人为中心、只画一层的放射图（自己用 SVG 画，不引入图库），点一个人就以他为中心重画。
- **暂停、手动添加、导出、导入：** 暂停后已有记忆照常使用，但不记新的、不做每日整理。导入支持 Codex 的记忆文件（`~/.codex/memories/`）、其他 AI 列出的记忆、Himawari 自己的导出文件；先预览勾选再写入，整批可以撤销；健康、财务等敏感内容默认不勾，像密码、卡号的行直接丢掉。
- **体积：** 新页面改成“打开记忆页时才下载”（React 的 `lazy`），聊天页首次打开要下载的主文件不变大。

**方案讨论与备选**

| 备选 | 好处 | 为什么没选 |
| --- | --- | --- |
| 记忆做成左侧栏里的独立页面，左列表右详情 | 地方大 | v4 视觉基线不允许新增独立入口和通用详情侧栏；加宽设置窗口已经够用 |
| 学 Claude 按主题合成段落 | 读起来像笔记 | 我们的底层是一条条带来源和历史的事实（ADR 0075），合成段落会丢掉单条的来源和更正历史 |
| 每条记忆给“归档”和“删除”两个按钮 | 能留着过时事实又不让它影响回答 | 用户分不清区别；编辑时旧说法本来就保留，删错了 7 天内能恢复 |
| 删除前弹确认框 | 不会误删 | 多点一次；撤销提示条加 7 天回收站同样防误删，而且不打断 |
| 人物关系画全景网络图，或引入 d3 等图库 | 一张图看全 | 人一多就缠成一团；图库会吃掉前端体积余量 |
| 导入时让模型把文件拆成一条条记忆 | 能处理任意格式的长段落 | 第一版改为按行和按 Codex 文件的小节规则拆分：结果可预测、不花模型调用、不会把导入文件里的话改写走样；代价是长段落不会被拆细，要在预览里自己编辑 |
| 不放宽前端体积上限，砍掉导入和人物关系图 | 守住 180 KiB 总上限 | 两块都是 Andy 专门要求的；多出来的部分只在打开记忆页时下载，不拖慢聊天页 |

放弃了什么：每条记忆在数据库里都要挂在一次“从对话提炼记忆”的记录上，这条记录又必须属于某个对话；全新安装、还没从对话里记下任何东西时，手动添加和导入无处可挂，所以这时两个按钮先灰掉，并写明“先和 Himawari 说一件关于你的事”。真正去掉这个限制要重建记忆投影任务表和三张用量账本表，风险大，留作后续。“你的原话”和来源对话标题这一版没有显示（原话只存了“已核对”，没有单独存文字）；时间线没有按天摘要；Claude 那种“一键清空全部记忆”故意没做，因为不可恢复，对只有一个用户的核心数据风险大于价值。

**业界主流做法**

- ✅ Claude 帮助中心（[How does Claude's memory work](https://support.claude.com/en/articles/11817273)）：记忆按主题列出，“Select any topic to read it, then use the edit icon to change it or select "Delete" to remove it.”；暂停时“Claude keeps its existing memory … but won't use memory or make new memories.”，重置则“Permanently deletes all memories”且“this cannot be undone”；另有实验性的导入导出：“import memories from other AI assistants or export your Claude memory for backup or migration.”。我们照搬了“能逐条看改删、能暂停、能导入导出”，但暂停后仍使用已有记忆，也没有做不可恢复的重置。
- ✅ Codex 记忆流程说明（[openai/codex `codex-rs/memories/README.md`](https://github.com/openai/codex/blob/main/codex-rs/memories/README.md)）：记忆目录在 `~/.codex/memories/`，整理后的输出是“`MEMORY.md`, `memory_summary.md`, and `skills/`”。这说明 Codex 的记忆就是本机的 Markdown 文件，可以直接拖进来导入，不需要官方导出功能。
- ✅ Graphiti 的同一实体判断提示词（[`dedupe_nodes.py`](https://github.com/getzep/graphiti/blob/main/graphiti_core/prompts/dedupe_nodes.py)）：“Return `duplicate_candidate_id = -1` when there is no match or you are unsure.” 我们同样规定“没把握就不合并”，区别是不直接当成新人，而是进“待确认”问 Andy。
- 📎 ChatGPT 记忆 FAQ、Gemini 帮助、Mem0 自定义分类、Monica、Google People API 的关系字段、全景网络图“缠成一团”的分析：设计说明（[记忆管理界面重新设计：设计说明](https://claude.ai/artifact/CykKuRNV26pNSBcfvNsDNR)）里列了链接，其中前三条当时只看到搜索摘录，没有逐字核对，面试时不要引用原文。

**对比与取舍**

和 Claude、ChatGPT、Gemini 一样，记忆放在设置里、能逐条看改删、能暂停。Himawari 多出来的是更正历史、整理可撤销、提醒、人物关系和导入预览，因为这些是自研记忆特有的能力，藏起来等于没有。最大的取舍在体积：总上限从 180 KiB 放宽到 192 KiB，换来全部功能保留；主文件上限 150 KiB 不变，聊天页首次打开基本不受影响。

**结果数据**

- 前端 gzip 体积（2026-10-26 云端 `npm run build` 的检查输出）：主文件 151949 字节（上限 153600）；总计 195773 字节（原上限 184320，放宽后 196608）。改前总计约 177016 字节。放宽后只剩约 0.8 KB 余量，下一次加前端功能就要先省体积。
- 测试：后端相关测试和前端 12 个记忆页交互测试通过，`npm run check`、`npm run build` 通过（云端容器）。
- 真实使用效果（找记忆是否更快、导入 Codex 文件的效果）：未测量，等上线后 Andy 实测。

**相关 ADR/PR**

[ADR 0075](adr/0075-self-built-memory-engine.md)（自研记忆）；原型 <https://claude.ai/artifact/SJkcL4hNPHeM2V6Nk3V4jL>；设计说明 <https://claude.ai/artifact/CykKuRNV26pNSBcfvNsDNR>；数据库迁移 `0057_memory_page.sql`；[PR #34](https://github.com/sixianli/himawari-agent/pull/34)（提交 bfa6162）。

**面试 30 秒版**

“记忆功能是一块块加出来的，设置页变成 7 块的长列表，同一条记忆出现两次、删除要确认、整理改了什么看不见。我先出可点原型给用户审，再按‘要处理的’和‘随时看的’分页签，删除改成 7 天可恢复加撤销，人物关系用 SQLite 表加以人为中心的放射图，不引入图数据库。新页面改成打开时才下载，聊天页主文件没变大，代价是总体积上限从 180 放宽到 192 KiB。”

[返回目录](#contents)

<a id="case-multi-user"></a>

## 案例 18：个人 Agent 怎么给家人朋友用：每人一个实例，还是一个实例分用户

**背景与现象**

2026-10-26 Andy 提出：Himawari 要能分享给老婆、朋友，以后也许给任何人用，每个人的对话、记忆和个人数据互相隔离，也就是多租户（一套系统服务多个互相看不到对方数据的用户）。他自己不确定这是不是好需求。当时 Himawari 只有 Andy 一个用户，生产只能通过 ssh 隧道访问，而且当天刚连续两版上线出过“用不了”的事故。

**根因**

这是一个设计问题，不是缺陷。难点在于先弄清“单用户”写死在哪一层。读代码（`main` 提交 `5c5feac`）发现：数据库几乎每张产品表已经有 `owner_id` 和 `agent_id`；写死单人的是配置里唯一的 `ownerId`、登录成功后总是返回这个主人、Cloudflare 登录只允许绑定第一个身份、全局的 `secrets/` 目录、按配置主人算出的授权存储键、只为一个主人运行的每日整理和提醒推送。另外，Agent 会替人运行命令、读写文件，原来的安全前提是“使用者就是可信的主人”（ADR 0069）。

**我们的方案**

定为“每人一个只属于自己的 Himawari”，分三步：

- 先用独立实例（silo）：老婆一个实例，有自己的数据库文件、密钥目录、配置、系统服务、系统账号和端口；稳定两周后再给最多 2 位朋友开。产品代码几乎不改。
- 只邀请，不开放注册。别人的实例前面放 Cloudflare Access（先确认身份再放行的入口服务），只放行 Andy 列出的邮箱，用邮箱验证码登录；服务端已有的代码会核对 Access 发的登录凭证。
- 别人的实例每人每月模型费用上限 10 美元（Andy 定的数）。不在产品里重新加预算代码（[案例 10](#case-budget-removal) 刚删掉），而是给每个别人的实例单独一把模型网关 API key，在网关上设按月重置的 10 美元预算，用满后网关直接拒绝这把 key 的请求。
- 用户超过约 5 人时，再改成一个实例按 `owner_id` 隔离（pool），先写“用 A 的身份读不到 B 的数据”的隔离测试；对陌生人开放的 SaaS 不做。
- 开工条件：第十一版事故修好、真实网页验收通过、生产连续 7 天无“用不了”事故、上线脚本能按参数自动生成。

这次决定不涉及 Pi：Pi 不管用户身份和数据归属，这些本来就是 Himawari 自己负责的部分。

**方案讨论与备选**

| 备选 | 好处 | 为什么没选或暂缓 |
| --- | --- | --- |
| 一个实例按 `owner_id` 隔离（pool） | 只运维一份 | 要改登录、配置、服务组装、后台任务、密钥和调度，正是最近事故的地方；漏一个过滤条件就泄露别人的记忆，SQLite 没有行级安全策略兜底。粗估 2–4 周（未测量），留到人多时 |
| 对陌生人开放注册的 SaaS | 增长空间最大 | 要做注册、计费、配额、合规和多台服务器；陌生人能刷爆模型费用，还能在放着 Andy 私人数据的机器上运行不可信的代码 |
| 内置账号（密码 + 手机验证码）给朋友登录 | 产品已有 | 验证码不防钓鱼，朋友还要自己绑验证器；作为备选 |
| Tailscale 私有网络共享 | 不暴露到公网 | 每个客人都要开 Tailscale 账号、装客户端，对家人朋友太麻烦 |

放弃了什么：独立实例让每次上线要升级多份、磁盘和内存翻倍；以后改 pool 时要做一次把多个数据库合并的数据迁移。

**业界主流做法**

- ✅ AWS SaaS Lens（[Silo, pool, and bridge models](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/silo-pool-and-bridge-models.html)）：“The silo model refers to an architecture where tenants are provided dedicated resources”。
- ✅ AWS SaaS 架构基础（[Tenant isolation](https://docs.aws.amazon.com/whitepapers/latest/saas-architecture-fundamentals/tenant-isolation.html)，页面标注为历史参考）：“the fact that a tenant user is authenticated does not mean that your system has achieved isolation.”
- ✅ Azure 架构中心（[Tenancy models](https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/considerations/tenancy-models)）：共用部署时“you typically rely on your application code and a tenant identifier that's in a database to keep each tenant's data separate.”
- ✅ Mem0（[Entity-scoped memory](https://docs.mem0.ai/platform/features/entity-scoped-memory)）：“Unmentioned entities are not constrained”，即查询时漏传的标识不做限制。
- ✅ Zep（[Users](https://help.getzep.com/users)）：“Each user has a user graph that stores context for that user.”
- ✅ Cloudflare D1（[Limits](https://developers.cloudflare.com/d1/platform/limits/)）：“designed for horizontal scale out across multiple, smaller (10 GB) databases, such as per-user, per-tenant or per-entity databases.”
- ✅ Cloudflare Access（[One-time PIN](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)）：“To grant a user access... simply add their email address to an Access policy.”；[验证凭证](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)：“You should validate the token with your public key to ensure that the request came from Access and not a malicious third party.”
- ✅ Vercel AI Gateway 预算（[Budgets and Spend Limits](https://vercel.com/docs/ai-gateway/observability-and-spend/budgets)）：“AI Gateway checks every budget in scope before each request and rejects further requests once a limit is exceeded, until the budget resets or you raise it.”；预算可以按单把 API key 设，周期可选 `monthly`（每月 1 日 UTC 0 点重置）。
- ✅ LiteLLM 网关（[Budgets, Rate Limits](https://docs.litellm.ai/docs/proxy/users)）：“Personal budgets : Create virtual keys without team_id for individual spending limits”，并用 `budget_duration` 设重置周期。OpenRouter（[Provisioning API keys](https://openrouter.ai/docs/features/provisioning-api-keys)）的示例就是给每个客户实例建一把带额度的密钥：“name: 'Customer Instance Key', limit: 1000”，超额的密钥会被自动停用，可选按天、周、月重置。说明“每个用户或实例一把带预算的网关密钥”是模型网关的通行做法。
- ✅ NIST SP 800-63B-4（[原文](https://pages.nist.gov/800-63-4/sp800-63b.html)）：“OTP authentication is not phishing-resistant.”
- ✅ OWASP 大模型应用十大风险（[LLM10:2025 Unbounded Consumption](https://genai.owasp.org/llmrisk/llm102025-unbounded-consumption/)）：“Denial of Wallet (DoW): By initiating a high volume of operations, attackers exploit the cost-per-use model of cloud-based AI services”。
- ✅ Open WebUI（[环境变量](https://docs.openwebui.com/reference/env-configuration)）：`DEFAULT_USER_ROLE` 默认 `pending`，“New users are pending until their accounts are manually activated by an admin.”
- ⚠ ChatGPT 记忆按账号隔离的官方说明（Memory FAQ）：打开返回 HTTP 403，没有核对，面试时不要引用。

**对比与取舍**

记忆类产品（Mem0、Zep）都按用户标识分开记忆，这相当于 pool，隔离靠每次调用都带对标识。我们先选 silo，是因为用户只有两三个熟人、团队只有一个人，“隔离靠结构而不是靠每个查询都写对”更稳；代价是运维多份。登录用 Cloudflare Access，和 Google IAP 是同一类“身份入口放在应用前面”的做法；最强的 passkey 登录 Himawari 还没有，留作加强项。

**结果数据**

- 代码盘点：数据库几乎全部产品表已有 `owner_id`（迁移 0001–0057）；写死单用户的位置见 [ADR 0081](adr/0081-isolated-instance-per-person.md#context)。
- 工作量：独立实例粗估 2–4 天，pool 粗估 2–4 周，SaaS 2–3 个月以上，均未测量。
- 实际效果：还没开工，未测量。

**相关 ADR/PR**

[ADR 0081](adr/0081-isolated-instance-per-person.md)；Idea `docs/ideas/IDEA-20261026-001-per-person-isolated-himawari.md`；Backlog `docs/backlog/BL-20261026-003-isolated-instance-per-person.md`；评估文档 <https://claude.ai/artifact/77cUajUv5MWWHHMH8m2g1N>；[PR #37](https://github.com/sixianli/himawari-agent/pull/37)。

**后续（2026-10-26）**

评估 iOS App 时决定 Andy 的手机也走 Cloudflare 入口，所以 [ADR 0083](adr/0083-isolated-instance-per-person-with-owner-entry.md) 取代了 ADR 0081，只改了“Andy 自己继续走 ssh 隧道”这一句，其余决定不变。详见[案例 21](#case-mobile-client)。

**面试 30 秒版**

“个人 Agent 要分享给家人朋友，各自的记忆必须隔离。我先盘点代码：数据库每张表已经带主人 ID，单用户写死在配置、登录、密钥和后台任务。对照 AWS 的 silo / pool 模型，我没有马上改成一个实例分用户，因为漏一个过滤条件就会泄露别人的记忆；先给每人起一个独立实例，前面用 Cloudflare Access 只放行邀请的邮箱，不开放注册，避免陌生人刷爆模型费用。用户超过五人再迁到 pool，先写隔离测试。”

[返回目录](#contents)

<a id="case-sandbox-lost-race"></a>

## 案例 19：搜索已经结束，却被判“失联”，整个服务卡 5 分钟

**背景与现象**

2026-10-26 07:07（UTC）Andy 在生产版（第十次上线，源码 030f81f）问“美国新闻最新10条”，这一轮卡住不动。他停掉重问，新的一轮也卡住，服务等于完全不能用。大约 5 分钟后才自己恢复。

**根因**

用生产数据库和沙箱的控制文件确认（只读登录生产机查看）：

1. 搜索任务本身正常结束了。沙箱主机（运行沙箱的那个进程）在任务进程退出后，要先清理沙箱，再写最终结果文件 `final.json`。
2. agent-service（Himawari 的服务进程）里的 `classify`（`apps/agent-service/src/production-sandbox-control.ts`）每次查看沙箱时，如果发现沙箱的隔离环境已经没了，但主机还没把“任务进程已退出”记下来，就直接判成“失联”（`lost`）。清理期间恰好就是这个状态，失联标记比主机写 `final.json` 只早了 19 毫秒。
3. worker（执行工具的组件）看到“失联”就取消任务，结果变成“未知”（`SANDBOX_EXIT_UNKNOWN`）。这一轮进入“等外部结果对账”的状态，一直等到 5 分钟的运行期限。
4. 生产配置 `concurrency.totalRuns` 是 1，同一时间只允许一轮运行，所以卡住的这一轮把后面所有新对话都堵住了。

第九次上线的代码在这条路径上没有区别，只是碰巧没撞上，所以回退旧版本没用。复现方法：单元测试里让沙箱的隔离环境先报告“已释放”、主机还没记下进程退出，旧代码判成 `lost`/`unknown`，测试失败；加上修复后通过。

**我们的方案**

- 立即止血（第十一次上线）：把已经合并的 PR #30 上线。搜索和读网页改在服务进程里执行，不再进沙箱（[ADR 0079](adr/0079-parallel-read-only-tools-and-host-web-tools.md)），绕开了这次出事的路径。
- 根因修复（单独的 PR）：在 `classify` 里加一条规则：Linux 上、隔离环境已释放、主机状态还是“运行中”且没记下进程退出、主机最近 1.5 秒内还在报告、还没到期限时，判成“清理中”（`exit_cleanup_pending`），继续等主机写结果；过了期限仍按失联处理。
- 还没做：只读工具的结果变成“未知”时，直接把失败交给模型，而不是让整轮等到期限。

**方案讨论与备选**

| 备选 | 好处 | 为什么没选 |
| --- | --- | --- |
| 回退到第九次 | 最快 | 第九次也有同样的问题，只是没撞上 |
| 把 `totalRuns` 从 1 改成 2 | 一轮卡住时别的对话还能用 | 只是让卡住不那么明显，根因还在；而且这是 Andy 要决定的配置，他还没答复 |
| 主机清理期间继续刷新状态 | 判断条件不用改 | 要改沙箱主机的协议，改动面更大，上线更慢 |
| 判断时多等一会儿再判失联 | 改动最小 | 等多久都是猜的，等长了又会拖慢真正失联时的处理 |

放弃了什么：这次止血靠的是“搜索不进沙箱”，运行命令的工具仍走同一条判断路径，要等根因修复上线才算真正解决。

**业界主流做法**

- ✅ Kubernetes 节点文档（[Nodes](https://kubernetes.io/docs/concepts/architecture/nodes/)）：节点失联时，“the node controller sets the `Ready` condition to `Unknown`”，并且“By default, the node controller waits 5 minutes between marking the node as `Unknown` and submitting the first eviction request.” 也就是说，收不到心跳先记成“未知”，等一段宽限时间再采取行动，不在第一次没收到就判死。

**对比与取舍**

思路和 Kubernetes 一样：暂时看不清的状态先当“未知/清理中”，到期限才处理。不同点是我们不加一段固定的等待时间，而是复用已有的运行期限，并且要求主机 1.5 秒内还在报告，这样主机真的没了时仍能很快判成失联。

**结果数据**

- 修复前写的复现测试失败（结果是 `lost`/`unknown`），修复后同一测试通过；沙箱相关测试文件 104/104 通过（Hermes 测试机，2026-10-26）。
- 第十一次上线的结果、上线后新闻搜索的耗时：见本案例上线后的补充，未测量前不写数字。

**相关 ADR/PR**

[ADR 0079](adr/0079-parallel-read-only-tools-and-host-web-tools.md)、[PR #30](https://github.com/sixianli/himawari-agent/pull/30)（搜索移出沙箱）；根因修复的 PR 见本案例所在的提交；相关：[案例 8](#case-search-toggle-spin)（同样是对话空转 5 分钟）、[案例 11](#case-tenth-deploy)。

**面试 30 秒版**

“生产上搜索已经结束，服务却把它判成‘失联’，整轮等到 5 分钟期限，又因为同时只允许一轮运行，所有新对话都堵住了。查下来是沙箱清理那几十毫秒里，隔离环境已经没了、主机还没记下进程退出，判断逻辑把这个中间状态当成了失联。我们先上线‘搜索不进沙箱’止血，再把这个中间状态改判为‘清理中’，用一个能复现的测试证明修复前失败、修复后通过。”

**后续（2026-10-26）**

根因修复是提交 `cab7f8b9`，放在 [PR #38](https://github.com/sixianli/himawari-agent/pull/38) 里，随第十二次上线进入生产（2026-10-26 12:18 UTC 新版本启动）。上线经过见[案例 20](#case-eleventh-twelfth-deploy)。上线后的新闻搜索耗时：未测量，等 Andy 试用后从日志补上。

[返回目录](#contents)

<a id="case-eleventh-twelfth-deploy"></a>

## 案例 20：第十一、十二次上线：首页正常，打开的页面却用不了；修复版又因复制来的旧脚本停服一次

**背景与现象**

2026-10-26 第十一次上线（代码 `aa563155`）的验收读回首页返回 200 就结束了。约 16 分钟后 Andy 报告：已经打开的页面在服务重启后，审批卡一直停在“正在加载权威状态”，设置里“允许联网搜索”勾不上，之前给过的搜索许可也失效了（出处：[lessons：上线验收只查了首页 200 没真点网页](lessons.md#release-without-browser-walkthrough)）。Andy 决定不退回旧版本，要求把这一版修好再上。

修复版作为第十二次上线。第一次尝试在停服之后失败，自动回退也失败，服务停了约 15 分钟，由 Claude 手动回退到第十一版。第二次尝试通过，停服约 11 分钟。

**根因**

第十一版用不了，有两个原因，都在 Hermes 测试机上用真实浏览器复现过：

1. **页面带着过期的授权编号。** 网页打开时读一次服务配置，之后每次查询都带上授权编号（fencing token：服务每次启动都会加一，用来拒绝旧实例发来的请求）。服务重启后编号从 29 变成 30，已经打开的页面还带着 29 去查，被服务以 HTTP 403 `PORT_NOT_AUTHORITATIVE` 拒绝，审批卡和搜索开关都拿不到状态。对话本身用的另一组接口不核对编号，所以页面看上去还能聊天。
2. **搜索许可绑得太宽。** 存下的联网搜索许可是整段搜索和读网页配置的摘要。第十一次把读网页的大小上限从 32768 调到 102400，摘要变了，许可就悄悄失效。按 [ADR 0071](adr/0071-replaceable-web-search-and-fetch-providers.md)，许可只应该针对“数据发给哪个模型、哪个服务”。

验收没发现，是因为它只读回服务端状态，没人在浏览器里按 Andy 的用法走一遍。这已经是第四次“只有在网页里用才看得出”的上线问题。

第十二次第一次尝试失败，也有两个原因：

3. **切换脚本带着上一版的预期。** 操作包（上线用的整套固定脚本和输入）是复制第十一次的再改。停服后切换版本前，`systemd/S7-switch-start-readback.py` 要核对生产机的原配置，它仍要求原配置的读网页上限是 32768（第十一次之前的值），于是报 `TWELFTH_SWITCH_ORIGINAL_PUBLIC_FETCH_CHANGED`，新版本没有启动。“新配置应该长什么样”在操作包里写了两遍：维护脚本 `maintenance/maintenance-common.mjs` 那份改了并有测试，S7 的 Python 那份没改，也没有测试运行它。
4. **回退脚本拼错了步骤名。** `scripts/delivery-mode/rollback.py` 按数据库版本号拼出 `S3_COPY56`、`S9_RAW_RESTORE56` 这样的步骤名，而操作包里这些步骤一直叫 `S3_COPY51`、`S9_RAW_RESTORE51`、`S9_RAW_CONTROL51`。回退找不到 `s3_copy56-result.json` 停下了。它的测试只用数据库第 51 版的操作包跑过，名字恰好对上。

**我们的方案**

1. 页面收到 403 `PORT_NOT_AUTHORITATIVE` 时重新读一次服务配置；部署、轮次或编号变了，就换一个新的接口客户端，审批卡和搜索开关重新加载（提交 `470b6d30`）。
2. 搜索许可的摘要只覆盖模型和数据接收方，读网页上限这类参数变了不影响许可（`470b6d30`）。旧摘要对不上新摘要，所以 Andy 上线后要重新勾一次“允许联网搜索”。
3. 上线门槛：`scripts/delivery-mode/deploy.sh` 先运行 `browser-acceptance-gate.py`。操作包里没有这个安装包在真实浏览器里的验收结果（首页、搜索开关、新闻搜索、长回答、记忆页、服务重启后已打开的页面，共 6 项），就以退出码 5 停下，不碰生产机（`856a2cee`）。
4. 切换脚本：改正核对函数，并在操作包里加 `systemd/verify-switch-config-fixtures.py`，每次出包都运行。它要求 S7 算出的新配置和维护脚本算出的逐字节相同，并要求 7 种旧值或缺项都被拒绝。
5. 回退脚本：改用操作包里固定的步骤名；`scripts/delivery-mode/test_rollback.py` 要求回退要跑的步骤都在操作包的步骤表里，恢复点报告名和 `deploy.sh` 实际跑的那个 S3 步骤对应（`2135359c`）。
6. 失败时先恢复服务：用改好的回退脚本副本手动回退，数据库用停服后立刻做的副本恢复，服务回到第十一版之后再查原因。

**方案讨论与备选**

| 备选 | 好处 | 为什么没选 |
| --- | --- | --- |
| 退回第十版 | 恢复最快 | Andy 决定不退，要求修完这一版 |
| 页面定时重新读授权编号 | 实现简单 | 间隔多长都是猜的，重读之前仍会失败；按“被拒绝的原因”重读更准 |
| 被拒绝后整页刷新 | 改动最小 | 会丢掉用户正在输入的内容 |
| 再写一条“复制操作包要逐个核对”的提醒 | 不用写代码 | 同类错误在第十次上线时已经第三次出现，书面提醒没挡住；[ADR 0060](adr/0060-hard-constraint-on-third-repeat.md) 要求加硬约束 |
| 出包时按参数自动生成整套脚本 | 从根上消除复制残留 | 改动大，交给单独的线程做 |

放弃了什么：S7 和维护脚本仍各有一份“新配置的样子”，只是靠测试保证两份一致；出包检查在 `.ci-output/`（不进仓库），`deploy.sh` 不强制要求跑过它。停服后的验收（`S6_ACCEPTANCE`）仍然在停服期间跑，约占 7 分钟。

**业界主流做法**

- ✅ OAuth 2.0 持有者令牌规范 [RFC 6750 第 3.1 节](https://www.rfc-editor.org/rfc/rfc6750.txt)（IETF 标准）对过期令牌 `invalid_token` 写道：“The access token provided is expired, revoked, malformed, or invalid for other reasons. … The client MAY request a new access token and retry the protected resource request.” 凭证过期时由客户端重新取一份再重试，和我们“被拒绝后重读配置换编号”是同一个思路。不同点：规范建议用 401，我们沿用服务已有的 403 和错误码。
- ✅ Google SRE《大规模可靠地发布产品》（[Reliable Product Launches at Scale](https://sre.google/sre-book/reliable-product-launches/)）谈发布检查清单：“The checklist needs continuous attention in order to remain relevant and up-to-date: … areas of concern from previous launches become obsolete due to new policies and processes.” 上一次的检查条件会过时；我们从第十一次复制来的 S7 核对，正是过时的上一次条件。同一章也写“If the change doesn’t pass the validation period, it’s automatically rolled back.” 自动回退是常规做法，我们补上的是“回退脚本本身也要拿当次的操作包测过”。
- ✅ 十二要素应用和 Google SRE《发布工程》都要求每次发布由构建产生、不可修改，不要复制上一次再改，原文见[案例 11](#case-tenth-deploy)。

**对比与取舍**

我们是单机部署，没有流量切换，只能“停服、验收、切换，失败就回退”。业界靠自动生成发布物和金丝雀发布把风险挪到停服之前；我们现在用两件事接近它：上线前要求真实浏览器的验收结果，出包时用测试核对复制来的脚本。代价是每次出包多跑几分钟检查。下一步是按参数自动生成操作包，并把约 7 分钟的停服后验收挪到停服之前。

**结果数据**

- 网页验收对第十一版 `aa563155` 重现了问题（服务重启后，设置里的开关等 60 秒仍勾不上），对修好的 `470b6d30` 六项全部通过（Hermes `pp15-old-accept/`、`pp15-new-accept/`，记录在 lessons）。
- 第十二次第一次尝试：11:04:26 UTC 停服，11:15:35 S7 切换失败，自动回退失败，11:19:43 手动回退完成，停服约 15 分钟（`.ci-output/production/twelfth-attempt1-20261026/run-logs/`）。
- 第二次尝试：12:07:25 UTC 停服，12:18:14 新版本服务启动，停服约 11 分钟；其中停服后的验收 `S6_ACCEPTANCE` 占 6 分 45 秒（12:07:54 到 12:14:39）（操作包 `run-logs/deploy-20261026T120047Z.log`）。上线后读回：服务在运行、首页返回 200、前端目录指向第十二版、模型上下文 1000000、输出上限 32768，服务日志没有警告。
- 两道新检查：第一次尝试的 S7 脚本让出包检查报错并以 1 退出，改好的通过 9 项；旧的 `rollback.py` 让回退测试失败，改好的通过 13 项（Hermes `himawari-tests/twelfth/`、`news-latency/evidence/ck19/`）。
- Andy 试用后的搜索耗时：未测量，待补。

**相关 ADR/PR**

[ADR 0071](adr/0071-replaceable-web-search-and-fetch-providers.md)、[ADR 0060](adr/0060-hard-constraint-on-third-repeat.md)、[ADR 0074](adr/0074-claude-runs-production-deployments.md)；[PR #38](https://github.com/sixianli/himawari-agent/pull/38)（提交 `470b6d30`、`856a2cee`、`2135359c`）；[lessons：上线验收只查了首页 200 没真点网页](lessons.md#release-without-browser-walkthrough)、[lessons：复制上一次操作包时留下旧文件和旧文件名](lessons.md#copied-packet-stale-names)；相关：[案例 11](#case-tenth-deploy)、[案例 12](#case-static-root)、[案例 19](#case-sandbox-lost-race)。

**面试 30 秒版**

“一个版本上线后首页正常，但已经打开的页面在服务重启后什么都批不了，因为它带着重启前的授权编号。我们让页面在被拒绝时重读配置换编号，并把‘在真实浏览器里走一遍’做成上线脚本的硬门槛。修复版上线时，从上一版复制来的切换脚本带着旧预期失败了，自动回退又因为按版本号拼步骤名而失败；我们先手动恢复服务，再给这两处各加一道能复现旧错误的测试，第二次上线停服 11 分钟成功。”

[返回目录](#contents)

<a id="case-mobile-client"></a>

## 案例 21：个人 Agent 要不要做 iOS App：先补“连得上、叫得到、能说话”

**背景与现象**

2026-10-26 Andy 问：要不要开发一个 iOS App 客户端。项目愿景是“同一个 Agent 出现在命令行、桌面、网页、手机、语音上”，Himawari 当时只有一个网页控制中心。Andy 在手机上用 Himawari 很不方便：生产只能通过 ssh 隧道打开，记忆提醒只有网页开着时才弹，也没有语音入口。

**根因**

这是一个设计问题，不是缺陷。关键是先分清“手机端缺的到底是什么”。读代码（`main` 提交 `8f1783d`）发现，网页早已按手机屏幕适配过，缺的是三件和“App”无关的事：

- 连不上：生产只监听 `127.0.0.1:8400`。
- 叫不到：提醒用浏览器 `new Notification()`，只在网页标签页开着时弹（`apps/control-center/src/components/memory-panel.tsx`）。另外，到期记忆提醒经 Bark（一个开源 iOS 推送 App）加密推送的代码在 10 月 25 日已经写好并进了生产（提交 `f73b0b7`），但没配置，所以一直没开。评估初稿漏看了这段代码，把 Bark 写成“内容经第三方服务器、有隐私问题”，核对代码后当场更正。
- 不能说话：代码里没有录音、语音转文字和朗读。

**我们的方案**

不做原生 App，分步补齐这三件事（[ADR 0082](adr/0082-mobile-pwa-push-before-native-app.md)）：

1. 用 Cloudflare Tunnel 加 Cloudflare Access 给生产开 HTTPS 入口，Andy 的手机也走它（因此 [ADR 0083](adr/0083-isolated-instance-per-person-with-owner-entry.md) 取代了 ADR 0081 里“Andy 继续走 ssh 隧道”这一句）。
2. 控制中心做成 PWA（Progressive Web App，加到主屏幕后像 App 一样全屏打开的网页应用），加网页推送：到期记忆提醒、任务完成、等待审批。
3. 语音先做网页“按住说话”和 iPhone 快捷指令（Siri 一句话问 Himawari）。
4. 过渡期先打开已写好的 Bark 推送，当天就能在锁屏收到记忆提醒。
5. 原生 App 只在需要锁屏小组件、灵动岛、Siri 深度整合、后台感知，或网页推送实测不可靠时重新评估。

Pi 不管客户端和推送，这些是 Himawari 自己负责的部分；语音转文字开工前按 Pi 优先原则先查 Pi 和现有模型网关已有的能力。

**方案讨论与备选**

| 备选 | 好处 | 为什么没选或暂缓 |
| --- | --- | --- |
| 原生 iOS（Swift） | 能用全部系统能力：小组件、灵动岛、Siri、后台定位 | 推送和 TestFlight 都要 99 美元/年的开发者计划；对话、审批、记忆页要重写一遍并长期两边维护；粗估 6–10 周（未测量） |
| 跨平台（React Native / Expo / Flutter） | 复用 TypeScript 接口类型，另带安卓 | 苹果的费用、期限、审核一样不少；小组件仍要写 Swift；粗估 4–8 周（未测量） |
| 只开 Bark 推送 | 代码已在生产，约 15 分钟配置，正文端到端加密 | 只推记忆提醒，点开进的是 Bark；作为过渡采用 |
| Telegram 机器人 | 双向聊天方便，Manus、OpenClaw 都这么做 | 机器人对话存在 Telegram 云端，Andy 的记忆会留在第三方服务器上 |

放弃了什么：锁屏小组件、灵动岛、Siri 直接调用应用内功能、后台持续录音或定位，这些 PWA 做不到；iOS 上网页推送也只在加到主屏幕后可用。

**业界主流做法**

- ✅ WebKit（[Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)）：“Now with iOS and iPadOS 16.4, we are adding support for Web Push to Home Screen web apps.”；“You do not need to be a member of the Apple Developer Program to use it.”
- ✅ WebKit（[Meet Declarative Web Push](https://webkit.org/blog/16535/meet-declarative-web-push/)）：iOS 18.4 起，推送消息可以自带要显示的内容，不依赖后台脚本。
- ✅ RFC 8291（[Message Encryption for Web Push](https://www.rfc-editor.org/rfc/rfc8291)）：推送内容可以“secured against inspection, modification, and forgery by a push service”。
- ✅ Apple（[Apple Developer Program](https://developer.apple.com/programs/)）：“$99 annual membership”；[会员对比](https://developer.apple.com/support/compare-memberships/)：免费账号“You can register up to 3 devices, which expire after 7 days.”
- ✅ Apple 开发者论坛（[DTS 工程师回答](https://developer.apple.com/forums/thread/811929)）：“Push notifications and iCloud capabilities are part of Apple Developer Program membership.”
- ✅ Apple（[TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)）：“You can test a build for up to 90 days.”
- ✅ Apple（[App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)）4.2：“Your app should include features, content, and UI that elevate it beyond a repackaged website.”
- ✅ Claude（[Team plan and iOS app](https://claude.com/blog/team-plan-and-ios)，2024-05-01）：“Pick up where you left off across devices.”
- ✅ Google（[The Gemini app is now available on iPhone](https://blog.google/products-and-platforms/products/gemini/gemini-iphone-app/)，2024-11-14）：独立 iPhone App，主打 Gemini Live 实时语音对话。
- ✅ Perplexity（[Voice Assistant for iOS](https://www.perplexity.ai/help-center/en/articles/11132456-how-to-use-the-perplexity-voice-assistant-for-ios)）：“Once configured, you can access Perplexity by simply pressing and holding the Action Button on your iPhone.”
- ✅ Manus（[Manus in Your Chat](https://manus.im/blog/manus-agents-telegram)）：“your agent should be accessible wherever you already communicate”，Telegram 是第一个渠道。
- ✅ OpenClaw（[iOS](https://docs.openclaw.ai/platforms/ios.md)）：iPhone App “Connects to a Gateway over WebSocket (LAN or tailnet)”，提供摄像头、定位、语音唤醒；[Channels](https://docs.openclaw.ai/channels)：“Start with Telegram.”
- ✅ Open WebUI（[Install the app (PWA)](https://docs.openwebui.com/ecosystem/computer/phone-and-remote/phone-app/)）：“iPhone/iPad (Safari): Share button → Add to Home Screen.”
- ✅ Telegram（[FAQ](https://telegram.org/faq)）：“Server-client encryption is used in Cloud Chats”，机器人“can see messages you send to them”。
- ✅ Cloudflare（[Service tokens](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/)）：自动化程序用 `CF-Access-Client-Id` 和 `CF-Access-Client-Secret` 两个请求头通过 Access。
- ⚠ ChatGPT iOS App 的 OpenAI 官方页面：打开返回 HTTP 403，没有核对，面试时不要引用。

**对比与取舍**

面向亿级用户的公司（Claude、Gemini、Perplexity）都做原生 App，因为它们要跨设备同步、实时语音和系统入口，也有专门的移动团队。自托管的个人 Agent 更像 Open WebUI 和 OpenClaw：前者只用 PWA；后者有原生 App，但用途是给 Gateway 提供手机的摄像头、定位和语音唤醒，不是重做聊天界面。Himawari 和后者最像，所以把“需要手机的感官”定为再做原生 App 的条件。和 Manus、OpenClaw 先接 Telegram 不同，我们把“数据留在自己手里”放在便利之前，推送只用内容加密的通道。

**结果数据**

- 代码盘点：手机端三处缺口和 Bark 推送现状见 [ADR 0082 背景](adr/0082-mobile-pwa-push-before-native-app.md#context)；前端 gzip 体积 195773 / 196608 字节。
- 工作量：入口 0.5–1 天、主屏网页应用加推送 3–5 天、语音 2–4 天、原生 App 6–10 周，均为估计，未测量。
- 实际效果：还没开工，未测量。

**相关 ADR/PR**

[ADR 0082](adr/0082-mobile-pwa-push-before-native-app.md)；[ADR 0083](adr/0083-isolated-instance-per-person-with-owner-entry.md)（取代 ADR 0081）；Backlog `docs/backlog/BL-20261026-004-production-cloudflare-entry-for-owner-phone.md`、`BL-20261026-005-home-screen-web-app-and-web-push.md`、`BL-20261026-006-voice-entry-hold-to-talk-and-siri-shortcut.md`、`BL-20261026-007-enable-bark-reminder-push-in-production.md`；Bark 推送实现提交 `f73b0b7`；评估文档 <https://claude.ai/artifact/Vs8dfsFfsgLNeMhSfTatoS>。

**面试 30 秒版**

“有人问个人 Agent 要不要做 iOS App。我先查手机端到底缺什么：不是界面，而是连不上、网页关了收不到提醒、不能说话。iOS 16.4 起主屏网页应用就能收推送，不需要 99 美元的开发者账号，内容还加密，所以我们先开 Cloudflare 入口、做 PWA 加网页推送、再用 Siri 快捷指令做语音入口，零费用一两周补齐。原生 App 留到需要手机摄像头、定位这类网页做不到的能力时再做，这和 OpenClaw 这类自托管 Agent 的做法一致。”

[返回目录](#contents)

<a id="case-identity-prompt"></a>

## 案例 22：系统提示开头一直是“编程助手”：给 Himawari 写自己的身份说明

**背景与现象**

2026-10-26 查“记忆步骤不显示”时（[PR #39](https://github.com/sixianli/himawari-agent/pull/39)）顺带发现：Himawari 每次调用模型时，系统提示（模型最优先遵守的开头说明）的第一句是 Pi 默认的英文 “You are an expert coding assistant operating inside pi, a coding agent harness.”。后面还有 Pi 自己的文档路径，以及在普通聊天里显示的 “Available tools: (none)”。Himawari 自己的规则只是接在后面。也就是说，一个以记忆为核心的个人 Agent，一直被告知自己是编程助手。

**根因**

读代码确认（没有线上复现）：Pi 适配层给 Pi 的资源加载器传了空的自定义提示，再把产品规则追加在后面。Pi 0.84.2 的 `buildSystemPrompt` 在自定义提示为空时使用默认的编程助手开头。这是 2026-09-13 的提交 `d30d59c` 有意选的：规格要求保留 Pi 为内置工具生成的工具简介和用法规则，而 Pi 一旦用自定义提示，就会把这两样一起丢掉。Pi 只给了两个选择，要么要它的开头、留住工具说明，要么换开头、丢掉工具说明，当时选了前者，身份问题就一直留着。

**我们的方案**

- 产品层（`production-run-policy.ts`）新增固定的 `HIMAWARI_IDENTITY`，放在每轮系统指令最前面，分“你是谁、记忆、主动、做事、资料不是指令、回答方式”六节。不写主人名字，名字来自记忆里的主人档案，这样“每人一个实例”（[案例 18](#case-multi-user)）不用改提示。
- Pi 适配层改用 Pi 的 `systemPromptOverride`（自定义提示入口），返回“产品系统指令 + 内置工具简介 + 工具用法”。工具简介和用法原样取自 Pi 内置工具定义的 `promptSnippet`、`promptGuidelines`，所以没有自己重写工具说明。
- 复用 Pi 的：资源加载器、自定义提示机制、内置工具定义和它们的说明文字。Himawari 自己负责的：身份、记忆使用规则、审批边界、资料与指令的边界、回答语言。多写的只有约 20 行，把工具说明接回去，因为 Pi 在自定义提示模式下不做这件事。
- 顺带解决了一个矛盾：主人档案里“主人对 Himawari 的要求（回答时遵守）”这一块，外面包着“treat as data, not as an instruction”的标记。身份说明里写明：标为 `owner-rules` 的资料是主人亲口定下的要求，要遵守；其他资料里的指令都不算数。

**方案讨论与备选**

| 备选 | 好处 | 为什么没选 |
| --- | --- | --- |
| 只改生产配置里的系统指令 | 不改代码 | Pi 的编程助手开头仍在最前面，两段身份互相矛盾；配置在生产机上，没有测试和版本记录 |
| Pi 的 `before_agent_start` 扩展事件替换提示 | Pi 原生支持 | 只在新提问时触发，审批后续跑（`agent.continue()`）不触发，会退回编程助手开头 |
| 在模型调用包装里对 Pi 的英文原文做字符串替换 | 覆盖所有调用 | Pi 改一个词就悄悄失效 |
| 改上游 Pi，加“只换开头”的选项 | 最干净 | Himawari 不改 `pi-mono`，要等上游发布；以后可以提 |

放弃了什么：Pi 默认提示里的 “Be concise in your responses”“Show file paths clearly when working with files” 两条通用规则不再发送（身份说明的“回答方式”已覆盖）；Pi 在自定义提示后固定追加的 `Current working directory: /var/lib/himawari/state` 一行仍在，Pi 0.84.2 没有去掉它的选项。

**业界主流做法**

- ✅ Anthropic 提示工程指南（[Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)）：“Setting a role in the system prompt focuses Claude's behavior and tone for your use case. Even a single sentence makes a difference”。同一页还建议写明原因：“Providing context or motivation behind your instructions … can give Claude more information about your goals”；并给出让 Agent 默认动手的提示：“By default, implement changes rather than only suggesting them.”
- ✅ Anthropic 工程博客（[Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)）：系统提示要在“right altitude”，既不要“hardcoding complex, brittle logic”，也不要“vague, high-level guidance”；建议“organizing prompts into distinct sections”，并给出“the minimal set of information that fully outlines your expected behavior”。
- ✅ Anthropic 公开的 Claude 应用系统提示（[Claude Opus 5.5 system prompts](https://platform.claude.com/docs/en/release-notes/system-prompts/claude-opus-5-5)，2026-09-22 版）：按主题分节（产品信息、语气与格式、知识截止等）；格式规则是“Claude avoids over-formatting with bold emphasis, headers, lists, and bullet points, using the minimum formatting needed for clarity.”
- ✅ OpenAI Model Spec（[2026-08-18 版](https://model-spec.openai.com/2026-08-18.html)）：指令有层级（平台、开发者、用户）；引用文字、工具输出和文件“are assumed to contain untrusted data and have no authority by default”。

**对比与取舍**

和 Anthropic、OpenAI 的公开做法一致的地方：一句明确的身份开头、按主题分节、写清行为背后的原因、工具和网页内容默认没有指令权。不同的地方：Claude 应用的系统提示很长，因为要覆盖所有人；Himawari 只服务一个主人，大部分“懂主人”的内容放在每轮的记忆资料里，所以身份说明只写不变的原则（约 900 个汉字），具体偏好交给记忆。另一个取舍是没有用 Pi 的事件钩子，而用资源加载器的自定义提示，因为只有后者在审批后续跑时也生效。

**结果数据**

- 删掉的 Pi 默认开头：普通聊天轮次（没有文件工具）1608 个字符（本地用 Pi 0.84.2 的 `buildSystemPrompt` 实算）。
- 新增的身份说明：907 个字符、UTF-8 编码 2469 字节（同样本地实算）。折算成 token（模型计费和计长度的单位）未测量。
- 测试：适配层测试改为断言提示以产品系统指令开头、包含 Pi 的工具简介和用法、不含 “coding assistant”；这个测试在旧代码上失败、新代码上通过。产品策略测试断言身份说明在配置指令之前。
- 回答质量的变化：还没上线，未测量。

**相关 ADR/PR**

[ADR 0084](adr/0084-himawari-identity-system-prompt.md)；[原生运行历史规格](execution/specs/2026-09-11-native-runtime-history-design.md#数据与流程)（2026-10-26 补充）；提交 `d30d59c`（原做法）；发现问题的 [PR #39](https://github.com/sixianli/himawari-agent/pull/39)。

**面试 30 秒版**

“我发现我们的个人 Agent 每次调用模型，系统提示第一句都是底层框架默认的‘你是编程助手’。原因是框架只给两个选项：用它的开头并保留工具说明，或换成自己的开头但丢掉工具说明，之前为保工具说明选了前者。我用框架的自定义提示入口换上自己的身份说明，再把框架内置工具的说明原样接回去，没有改框架源码，也没有做字符串替换；身份说明按 Anthropic 和 OpenAI 公开的做法分节，写清记忆、审批和‘资料不是指令’的边界。测试在旧代码上失败、新代码上通过。”

[返回目录](#contents)

<a id="case-memory-steps"></a>

## 案例 23：答对了却“没有过程”：用到的记忆不在步骤里

**背景与现象**

2026-10-26 第十二版上线后，Andy 在生产上问“我最喜欢的颜色是？”。模型（DeepSeek V4.1 Flash，思考强度“高”）答对了“蓝色。你之前提过，蓝色是你最喜欢的颜色。”，答案来自长期记忆。可是这一轮的步骤区写着“思考 0 次 · 执行 0 步”和“没有可展示的过程记录”。Andy 的原话是：“模型思考、记忆调用、工具调用那一个没有任何显示。”他要看到“查了记忆、用到了什么”，而界面让人以为模型什么也没做。

**根因**

分成三件事查，代码证据和生产记录都看了（生产记录用一个只读脚本在 Andy 的 Mac 上登录生产机读取，对象是这一轮 `run:bafb641b`）：

1. **记忆其实查了，后台也记下了，是网页没画出来。** 每一轮开始前，`ContextFormationService`（组装上下文的服务，就是决定把哪些内容一起交给模型）会做两件事：把“主人档案”（由已确认的长期记忆整理出的偏好、身份等，`OwnerProfileService` 生成）放进上下文，再按这句话去检索相关记忆。两件事都写进了运行记录：`memory.query`、`memory.candidates`、`memory.selection`、`context.formed`。服务端的 `ThreadExecutionProjection`（把运行记录转成网页能显示的步骤）也把它们发给了网页，但只发了事件名，内容是空的。网页早期（2026-09-14）把这几条画成“发起记忆检索”“完成记忆筛选”这类没有内容的阶段，2026-09-16 按 v4 设计改版（提交 `0600b295`）时去掉了，之后步骤列表只画工具、过渡话、思考、授权检查四种，记忆事件一律跳过。生产记录显示：这一轮候选 1 条、按问题选中 0 条，“蓝色”是通过主人档案（1 条记忆）进入上下文的。
2. **“执行 0 步”是对的。** 这个数字只数工具调用。模型这一轮直接从上下文里读到答案，没有调用 `recall`（翻看记忆）工具，也没有调用别的工具。
3. **“思考 0 次”也是如实的。** 请求里带了 `reasoning: {effort: "high"}`，但模型返回的内容只有一段正文，没有思考段，供应商回报的思考 token 数为 0。同一对话上一轮（搜新闻）同一个模型、同样的设置，每次回复都带思考段（334 和 1383 个字符）。所以思考显示的链路是通的，是模型这一轮没有思考。为什么没思考（模型对简单问题自己跳过，还是网关转给的上游供应商不返回思考）还没查清。

**我们的方案**

- **服务端：** `ThreadExecutionProjection` 读到 `memory.selection` 和 `context.formed` 时，从加密的记录里取出这一轮带给模型的记忆编号，再按编号从记忆库读出每条记忆的原文，放进步骤记录：条数写在 `text`，原文一行一条写在 `output`。只显示还在用或已归档的记忆；已删除、在回收站里的不显示原文；分级高于这一轮的也不显示。读的是记忆库里的当前原文，不是当时拼好的档案文字，所以删掉一条记忆后，旧对话的步骤里也看不到它。
- **网页：** 步骤列表最前面加两种步骤，图标是数据库样式，点开能看原文：“按这句话找到 N 条相关记忆”和“带上档案里的 N 条记忆”。文案只说“带上了哪些”，不说“命中了哪条”，因为系统无法知道模型具体用了哪一条。
- **体积：** 删掉 5 个早已不用的“阶段”文案（三种语言），前端 gzip 总体积只多 59 字节（195773 → 195832，上限 196608）。
- **没改的：** 记忆检索本身、模型请求、思考的显示规则都不变。这是展示层的修复，不涉及 Pi 的任何模块（Pi 不管记忆和步骤展示，这两块本来就是 Himawari 自己负责的）。

**方案讨论与备选**

| 备选 | 好处 | 为什么没选 |
| --- | --- | --- |
| 把被删掉的“发起记忆检索 / 完成记忆筛选 / 上下文准备完成”阶段原样加回去 | 改动最小 | 只有名字没有内容，看不出查到了什么，正是 v4 改版去掉它们的原因；Andy 也反感“摆设” |
| 显示“命中了哪一条” | 用户最想知道 | 系统不知道模型实际用了哪一条，硬写就是在编；只能列出交给模型的那些 |
| 直接显示当时拼好的档案文字 | 和模型看到的一字不差 | 档案文字是另存的一份，删掉记忆后旧档案文字还在，会让已删除的内容重新出现在页面上 |
| 让模型每次都调用 `recall` 工具，靠工具步骤来显示 | 不用改展示 | 多一次模型往返，变慢；档案本来就应该常驻上下文，不该为了显示改变检索方式 |
| 把记忆条数并进“思考 N 次 · 执行 N 步” | 摘要里一眼看到 | 这行摘要说的是模型做了什么，记忆是系统在模型开始前准备的；而且又要多一条三语文案，前端只剩约 0.8 KB |

放弃了什么：步骤里的条数是“当时带上的条数”，删掉其中一条后，条数不变但原文少一行；按问题检索时用了哪些检索词、每条的相关分数没有显示。

**业界主流做法**

- ✅ Claude 帮助中心（[How does Claude's memory work](https://support.claude.com/en/articles/11817273)）：搜索以前的对话时“will appear as tool calls during your conversations”，以及“When Claude searches your previous chats, you will see this reflected in your current chat as a tool call.” 旧版记忆还会“see citations linking back to the original chats”。同一篇文章没有写自动带入的记忆摘要在回答里怎么显示。Claude 的做法是：主动检索要让用户看见，用工具调用的形式显示。
- ✅ OpenTelemetry 生成式 AI 规范（[semantic-conventions-genai `gen-ai-spans.md`](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md)）：把查记忆单列成一种操作，“`search_memory` | Search/query memories from a memory store”，并建议记录 `gen_ai.memory.record.count`（“For `search_memory` operations, this is the number of memory records returned by the operation.”）。记忆原文 `gen_ai.memory.records` 则“SHOULD NOT capture this attribute by default”，因为“may contain sensitive information including user/PII data”。

**对比与取舍**

和 Claude 一样，我们让“查了记忆”在对话里看得见；不同的是，Himawari 的档案是每轮自动带入的，不是模型调用工具查的，所以单独做成步骤，而不是硬套成工具调用。和 OpenTelemetry 一样，我们把“查记忆”当作独立的一步，并记下条数。OpenTelemetry 默认不记原文，是因为遥测数据（运行监控数据）通常会发给第三方系统；我们的原文只从本机加密库读出、只给主人本人看，所以默认显示。

**结果数据**

- 生产记录（2026-10-26 只读脚本，`run:bafb641b`）：候选记忆 1 条，按问题选中 0 条，档案带入 1 条（含“蓝”）；思考段 0、思考 token 0、输出 14 token。对照轮 `run:61268ba2`：思考段 334 和 1383 个字符，思考 token 96 和 618。
- 测试：新增集成测试走真实的上下文组装和真实 SQLite 运行记录，在旧代码上失败、新代码上通过；网页单元测试 1 个；真实浏览器（Chromium）12 个场景通过，其中 4 个聊天场景（中文 1280、320，日文 393，英文 430）检查两条记忆步骤、图标、文案和展开后的原文，刷新后仍在。相关 74 个测试文件 1320 项通过，`npm run check`、`npm run build` 通过（云端容器）。
- 前端 gzip 总体积 195773 → 195832 字节（上限 196608），主文件 152056 字节（上限 153600），来自本次 `npm run build:browser` 输出。
- 上线后 Andy 是否觉得看得懂：未测量，随第十三版上线后实测。

**相关 ADR/PR**

[ADR 0075](adr/0075-self-built-memory-engine.md)（自研记忆，档案常驻上下文）；[PR #39](https://github.com/sixianli/himawari-agent/pull/39)（提交 f298254）；[案例 16](#case-narration-status)（同一块步骤列表的上一次修复）；[案例 17](#case-memory-page)（记忆管理页）；[案例 22](#case-identity-prompt)（这次排查顺带发现的系统提示问题）。

**面试 30 秒版**

“用户问最喜欢的颜色，模型答对了，界面却说‘没有过程记录’。查下来记忆其实查了、也记下了，是一次界面改版把记忆步骤整类去掉了；‘思考 0 次’则是模型那一轮真没思考，我用生产记录对照另一轮证实了链路没问题。修法是让服务端按记忆编号读出当时带给模型的原文，界面加两种记忆步骤，只说‘带上了哪些’，不编造‘命中了哪条’，已删除的记忆不回显。先写了在旧代码上失败的集成测试，前端只多了 59 字节。”

[返回目录](#contents)

<a id="case-run-gaps"></a>

## 案例 24：模型只用 3.9 秒，整轮却要 12 秒：找出 Himawari 自己造成的空档

**背景与现象**

2026-10-26 第十二版上线后，Andy 在重新设计过程区时要求“每一步的时间一定一定要准确”。用生产数据库的 `trace_events`（每轮执行过程的事件表，只取事件类型和时间，没读内容）核对两轮对话：

- “我最喜欢的颜色是？”共 12.1 秒，模型真正输出只有约 3.9 秒，没调用工具。上下文准备好到模型开始之间 2.7 秒没有任何事件；模型输出结束 1.1 秒后才写进数据库；运行结束后又过 1.7 秒回答才提交。
- “查新闻”共 27.1 秒，准备与衔接约 6.4 秒；“等你确认”事件比实际暂停晚约 3.6 秒才写入，而网页从数据库读事件，确认卡片会跟着晚出现。

**根因**

先看代码，再用生产服务日志对时间，确认了五个原因：

1. **每轮都预热沙箱**（沙箱：用操作系统机制限制程序能访问的文件和网络的隔离环境）。日志 `sandbox.srt_prewarm.requested` 显示两轮预热用了 4866 毫秒和 7523 毫秒；两轮里事件写入变慢、运行完成推迟，都正好在预热结束那一刻恢复。颜色那轮没用工具，结束时还要先停这个沙箱再提交回答。联网搜索当天已经不进沙箱，预热基本白做。拖慢的具体机制（抢 CPU 还是抢唯一的数据库写入线程）还没有区分，上线后用新加的分段计时确认。
2. **调度器没人叫醒**。调度循环有 `wakeup()` 方法，但全仓库没有一处调用，新消息和审批后的续跑只能等每秒一次的兜底扫描。代码证据：`grep` 不到任何 `.wakeup()` 调用。
3. **后台起标题拖住整轮**。后台模型调用借本轮执行租约登记，本轮暂停或完成前要等它们登记好；但记忆写入要等起标题的模型调用整个做完才开始登记。用单元测试复现：标题一直不结束时，旧代码永远放不出“完成”事件。
4. **找记忆和读档案先后进行**，两者互不依赖。测试复现：让读档案等到检索开始才结束，旧代码会卡死。
5. **每段流式文字要四次数据库提交，每次都等落盘**。生产库是 WAL 加 `synchronous = FULL`，这台机器每次同步写入实测 11.5–18.7 毫秒（BL-20261001-002 的记录）。四次里有一次只是更新进度检查点的计数器，恢复逻辑不依赖它。

**我们的方案**

1. 按 Andy 已同意的沙箱方案 B，去掉每轮预热，第一次用到 `bash`、`write`、`edit` 时才启动沙箱。
2. HTTP 网关的命令接口返回成功后立即调用 `wakeup()`，兜底扫描保留。
3. 起标题、记忆写入等后台调用同时开始登记；本轮仍等全部登记完（保持租约约束），但不再等起标题做完。
4. 找记忆和读档案并行。
5. 流式事件不再逐个写进度检查点，只在阶段、结束状态或诊断码变化时写；事件的父子链接不变。
6. 每次执行结束写一行 `run.timing` 日志：上下文准备、记忆检索、模型登记、事件记录、数据库提交、工具、停沙箱、提交回答等每类步骤的次数、累计、最长和起止时间点。用包装端口（不改 Pi）实现，Pi 的执行循环和事件不动。

还有一项需要 Andy 拍板：过程记录（步骤事件、流式文字片段）可以按次关掉“等落盘”，外部动作、授权、模型调用登记、最终回答照旧等落盘。

**方案讨论与备选**

- 只加计时、不改行为：最稳，但 Andy 要的是消掉空档；有代码证据和测试复现的几处直接改。
- 立刻做按对话复用的常驻沙箱：每轮既不启动也不停，但工作量约 1–2 天，排在方案 B 的下一步。
- 先提交回答再停沙箱：能省结尾 1–2 秒，但要放宽“沙箱确认释放才算完成”；不预热后，没用工具的轮次本来就不用停沙箱，不必放宽。
- 后台调用不借本轮租约：本轮完全不用等，但要另设一套权限，放弃。
- 把每轮所有写入合成一次提交：省得最多，但要改多个存储接口和恢复逻辑，先不做。
- 全库改成不等落盘：最简单，但会让外部动作记录在断电时也可能丢；改成只对过程记录关掉，交给 Andy 选。

**业界主流做法**

- ✅ SQLite（[PRAGMA synchronous](https://www.sqlite.org/pragma.html#pragma_synchronous)）：“WAL mode is always consistent with synchronous=NORMAL, but WAL mode does lose durability. A transaction committed in WAL mode with synchronous=NORMAL might roll back following a power loss or system crash. Transactions are durable across application crashes regardless of the synchronous setting or journal mode.”
- ✅ SQLite（[Write-Ahead Logging](https://www.sqlite.org/wal.html)）：“Writers sync the WAL on every transaction commit if PRAGMA synchronous is set to FULL but omit this sync if PRAGMA synchronous is set to NORMAL.”
- ✅ Graphile Worker（[首页](https://worker.graphile.org/)，基于数据库的任务队列）：“Jobs start in milliseconds thanks to Postgres' LISTEN/NOTIFY”，即新任务到来时主动通知执行者，而不是靠定时扫描。
- ✅ OpenTelemetry（[Traces](https://opentelemetry.io/docs/concepts/signals/traces/)）：span（一段计时的工作）“represents a unit of work or operation”，每个 span 带开始和结束时间；我们的 `run.timing` 按同样的思路给每类步骤记起止时间，但先写成一行日志，没有引入整套追踪系统。

**对比与取舍**

叫醒调度器和 Graphile Worker 的“有新任务就通知”是同一个思路，兜底扫描保留是为了别的来源（比如提醒）。分段计时只记名字和数字，满足 Andy“时间要准”的要求，又不把对话内容写进日志。没有照搬 SQLite 推荐的“WAL 用 NORMAL 就够了”，因为 Himawari 有“外部动作先记录再执行”的保证，所以只对过程记录考虑放宽，并交给 Andy 决定。

**结果数据**

- 改前（生产 trace 和日志）：颜色那轮 12.1 秒，其中模型约 3.9 秒；预热 4.9 秒和 7.5 秒；确认事件晚写入约 3.6 秒；回答提交比运行结束晚 1.35–1.7 秒。
- 复现测试：叫醒调度器、后台登记、并行检索、少写检查点四项各有一个测试，改前失败、改后通过。
- 改后生产耗时：未上线，未测量。上线后用 `run.timing` 回填。

**相关 ADR/PR**

[ADR 0085](adr/0085-remove-per-turn-system-gaps.md)；[ADR 0054 的预热补充](adr/0054-readonly-tools-in-host-and-reused-task-sandbox.md#resident-prewarm)；[BL-20261024-006](backlog/BL-20261024-006-first-tool-call-cold-start.md)；[BL-20261001-002](backlog/BL-20261001-002-回-到-同-步-写-入-快-的.md)；PR #44（已合并，合并提交 `f7b68a2`）；[ADR 0088](adr/0088-process-records-skip-disk-sync.md)（后续）。

**面试 30 秒版**

“一个不用工具的问题，模型只花 3.9 秒，整轮却要 12 秒。我把生产事件表和服务日志按时间对齐，找到五个原因：每轮都预热一个用不上的沙箱、调度器只靠每秒扫描、后台起标题拖住完成、两步本可并行的检索在串行、每段流式文字要四次等落盘的数据库提交。每个原因先写测试复现再修，并给每轮加了按步骤的计时，上线后每一秒花在哪都能看到。”

**后续（2026-10-26）：过程记录不再等硬盘确认**

Andy 选了“过程记录不等落盘”。现在只有过程记录（执行过程事件和用途为 `trace` 的事件内容）提交时临时切到 `synchronous = NORMAL`，提交后立刻切回 `FULL`；回答、运行状态、审批、记忆和外部动作记录照旧等硬盘确认。WAL 是按顺序追加的，下一次等硬盘的提交会把前面的过程记录一起写盘，所以断电时最多丢最后几条步骤，服务崩溃不丢。每个流式事件因此少两次等硬盘确认。测试：一条新测试在改动前失败（没有切换），改动后通过；生产效果未上线，未测量。决定记在 [ADR 0088](adr/0088-process-records-skip-disk-sync.md)。

[返回目录](#contents)

<a id="case-packet-generator"></a>

## 案例 25：上线操作包从“复制上一次再手改”改成“按参数生成”

**背景与现象**

Himawari 单机部署，每次上线用一个操作包：约 146 个固定脚本、输入和材料，由 `scripts/delivery-mode/deploy.sh` 按步骤执行，停服、换版本、失败就自动回退。到 2026-10-26，每次的操作包都是复制上一次的再手改“第几次”、版本目录、数据库版本号、配置预期和材料摘要，生成工具放在 Mac 和 Hermes（测试机）上被 git 忽略的 `.ci-output/` 里。

后果是同一类错误反复在停服之后才暴露：第十次上线读错旧文件名 `s7-catalog-after51.json`，停服约 17 分钟后回退；第十二次上线切换脚本带着上一版的配置预期、回退脚本又拼错步骤名，停服约 15 分钟（[案例 20](#case-eleventh-twelfth-deploy)）。同时出包要 49 分钟到 1 小时，第十二次成功那次停服约 11 分钟。Andy 的原话：“这个时间也太长了吧？还能加快吗？因为我希望的是快速迭代上线验证。”

**根因**

1. **要变的值散在 146 个文件里，靠人记得改。** 一次上线要变的值只有十几个，但它们被抄进很多脚本。上一次的值看起来和这一次一样合理，复制后没有任何东西机械地对照“这一次应该是什么”。代码证据：第十二次的 S7 切换脚本里，原配置读网页上限 32768 是从第十一次抄来的，而维护脚本里同一个预期已经改成 102400。
2. **之前的硬约束都是“复制之后再查”。** 每次出事后加一道检查（文件摘要表、交接文件名、切换配置夹具），只能拦已经想到的那类旧值，而且检查本身也在 `.ci-output/` 里靠复制带到下一次。把操作包搬进仓库时又找到一处没被任何检查发现的旧副本：包里的 `workspace-lifecycle-audit.mjs` 只认到数据库第 56 版，代码已改成认 57 版（提交 `bfa6162`），第十三次升库时会在停服后失败。
3. **慢在冻结和停服后的验收。** 冻结（读生产状态、算绑定）离上线很远，中间服务一重启配置指纹就变，只能整套重做；停服后的验收 `S6_ACCEPTANCE` 占了 11 分钟停服里的 6 分 45 秒。

**我们的方案**

1. **模板加参数。** 第十二次冻结的操作包改写成模板 `scripts/delivery-mode/packet-template/`，每个随上线变化的值换成 `__PKT_名字__` 占位，文件名里的也一样；生成器 `scripts/delivery-mode/make-packet.py` 渲染时缺参数或留下占位都拒绝。
2. **只让人决定该人决定的事。** 输入只有提交（默认 `origin/main`）和实例文件（主机和这次要设的模型上限、读网页上限）。“第几次”、旧版本目录、原配置的值从生产机只读读出；数据库版本从生产读回和提交里的迁移文件推出；材料摘要从 Hermes 上对这个提交的构建算出；包里带的仓库文件副本按这个提交刷新。
3. **数据库升级变成模板的通用能力。** 代码版本更高时，生成器从 `migration-engine.ts` 取出要补的迁移，`S7_CONFIG_APPLY` 用新版本的 `himawari db migrate` 升库，并核对历史、能力目录、授权和回执内容不变。迁移如果改写这些要保留的表，出包时就拒绝。出包检查里加一项：用这个提交装出来的命令，把一个真实的旧版本数据库升到新版本。
4. **检查前移到出包，上线只认生成器出的包。** 16 项操作包检查（升库时 17 项）在 Hermes 上并行跑，不过就不出包，结果写进 `packet-checks.json`；`deploy.sh` 发现包里没有生成器的记录，以退出码 6 停下，生产机上什么都不动。
5. **冻结紧挨上线，停服前核对。** 出包最后一步冻结，过时了用 `make-packet.py freeze` 约一分钟重冻；上线前检查在停服前对比配置摘要、服务单元摘要和授权轮次、编号，变了就不停服并提示重冻。
6. **验收挪到停服之前。** 步骤顺序改成 `S1_INSTALL → S6_ACCEPTANCE → S2_STOP`，验收失败时旧版本照常服务。

这件事和 Pi（Himawari 依赖的开源 Agent 框架）无关，全部是 Himawari 自己的上线流程。

**方案讨论与备选**

| 备选 | 好处 | 为什么没选 |
| --- | --- | --- |
| 继续复制，再加检查清单 | 不用改工具 | 同类错误已经三次以上，[ADR 0060](adr/0060-hard-constraint-on-third-repeat.md) 不许再只靠提醒；时间也降不下来 |
| 改用 Ansible、Helm 一类通用部署工具 | 模板和变量写法现成 | 要重写 146 个在生产上验证过的脚本和夹具；单机停服切换用不上滚动更新 |
| 升库只靠 Hermes 整套演练 | 最接近真实 | 快速模式不跑演练，一次几十分钟；改成出包时用真实命令升一个真实旧库，几十秒 |
| 冻结后完全不许服务重启 | 实现最简单 | 做不到；改成停服前核对，变了就一分钟重冻 |

放弃了什么：模板保留了第十二次的历史写法（例如步骤名 `S3_COPY51`）；生成器要同时连生产机和 Hermes，只能在 Andy 的 Mac 上跑；手写两个记录文件仍能骗过上线前检查，它拦的是“忘了用生成器”。

**业界主流做法**

- ✅ 十二要素应用《构建、发布、运行》（[Build, release, run](https://12factor.net/build-release-run)）：“The resulting release contains both the build and the config and is ready for immediate execution”，并且“Releases are an append-only ledger and a release cannot be mutated once it is created.” 发布物由构建加配置生成、生成后不改，对应我们“按参数生成、冻结后不手改”。
- ✅ Google SRE《发布工程》（[Release Engineering](https://sre.google/sre-book/release-engineering/)）：构建应该“insensitive to the libraries and other software installed on the build machine”，并且“configuration changes are a potential source of instability.” 我们把配置预期从生产读出而不是手抄，就是为了去掉这个不稳定来源。
- ✅ Helm 入门文档（[Getting Started](https://helm.sh/docs/chart_template_guide/getting_started/)）：Helm 把 `templates/` 目录“send all of the files … through the template rendering engine”，默认值在 `values.yaml`，“These values may be overridden by users during `helm install` or `helm upgrade`.” 模板加每次的值生成部署文件，和我们的模板加实例文件同一个思路。
- ✅ Kubernetes API 概念（[API Concepts](https://kubernetes.io/docs/reference/using-api/api-concepts/)）：“In the event that the resource has changed (the `resourceVersion` the client provided is stale), the API server returns a `409 Conflict` error response.” 读的时候记下版本，写之前对不上就拒绝、让客户端重读，我们停服前对比冻结时的配置摘要和授权编号也是这样。
- ✅ Martin Fowler《Parallel Change》（[ParallelChange](https://martinfowler.com/bliki/ParallelChange.html)）把不兼容的改动拆成 expand（扩展）、migrate（迁移）、contract（收缩）三步，expand 阶段“you augment the interface to support both the old and the new versions.” 第 57 版迁移就是 expand 阶段，只加表和可空列，所以回退时旧版本还能用原副本。

**对比与取舍**

相同点：发布物由“代码 + 每次的值”生成、生成后不改，写之前核对版本。不同点：业界通常有多台机器做滚动更新和金丝雀发布，把风险挪到不停服；我们是单机，只能“停服、切换、失败回退”，所以把能挪的检查和验收都挪到停服之前。我们也没用 Helm 一类工具，而是把已经在生产上验证过的操作包直接变成模板，代价是模板里留着历史写法。

**结果数据**

- 用第十二次的参数生成：除 21 个有意改动的文件外，与第十二次冻结的操作包逐字节相同；生成器单元测试 18 项通过（`scripts/delivery-mode/test_make_packet.py`，云端容器，约 1.7 秒）。
- 复现第十二次事故：把读网页上限换回手抄值 32768 生成时，S7 核对函数报 `TWELFTH_SWITCH_ORIGINAL_PUBLIC_FETCH_CHANGED`；按生产读出的值生成时通过（同一测试文件）。
- 第十三次要升的 56 → 57：生成的操作包 17 项检查全部通过，其中真实升库一项 6 个用例都通过，17 项共 34 秒（云端 4 核容器，提交 `4ca2d24c` 的构建）；不升库的第十二次参数 16 项全部通过。
- 上线脚本：没有生成器记录、检查没全过或提交对不上、升库却没跑升库检查时，`deploy.sh` 都以 6 退出且一个上线步骤都没跑；冻结后配置、服务单元或授权编号变了，停服前拒绝（`scripts/delivery-mode/test_deploy.py`，21 项通过）。
- 整次出包时间、停服时间：未测量，等第十三次在 Mac 上出包演练和上线后补。目标是出包约 15–20 分钟（只改配置复用材料约 3 分钟），停服约 4 分钟（11 分钟减去挪走的 6 分 45 秒验收，推算）。

**相关 ADR/PR**

[ADR 0086](adr/0086-generate-release-packets-from-parameters.md)、[ADR 0060](adr/0060-hard-constraint-on-third-repeat.md)、[ADR 0074](adr/0074-claude-runs-production-deployments.md)、[ADR 0083](adr/0083-isolated-instance-per-person-with-owner-entry.md)；[PR #42](https://github.com/sixianli/himawari-agent/pull/42)；[lessons：复制上一次操作包时留下旧文件和旧文件名](lessons.md#copied-packet-stale-names)；相关：[案例 11](#case-tenth-deploy)、[案例 20](#case-eleventh-twelfth-deploy)。

**面试 30 秒版**

“我们的上线操作包有 146 个文件，过去每次复制上一次再手改，三次上线都因为漏改的旧值在停服之后才失败。我把它改成模板加参数生成：只有提交和实例配置由人给，其余从生产只读读回和代码里推出，数据库升级也从迁移清单自动生成；所有检查在出包时跑，上线脚本只接受生成器出的包。用第十二次的参数生成的包和当时手工冻结的逐字节一致，旧的手抄值能复现当时的事故，第十三次的升库在出包时就用真实命令验证过。”

[返回目录](#contents)

<a id="small-cases"></a>

## 小案例速查

这些问题小，但面试时可以作为“对细节负责”的例子。

| 问题 | 根因 | 解决 | 出处 |
| --- | --- | --- | --- |
| 仓库改成私有后 CI 报 403 | CI 用的 `GITHUB_TOKEN`（GitHub 给每次 CI 运行发的临时令牌）缺 `pull-requests: read` 权限 | 在工作流里按最小权限显式补上（✅ [GitHub 工作流语法](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)：可以用 `permissions` 修改 `GITHUB_TOKEN` 的默认权限，`pull-requests` 是其中一项） | PR #6，PR #9 修复其后续检查 |
| 推理强度选项是写死的 | 界面列出了模型并不支持的档位 | 只显示 DeepSeek V4.1 Flash 真实支持的档位 | PR #13 |
| 执行环境状态条像摆设 | 状态条一直显示，和实际情况无关 | 只在有事时出现 | PR #14 |
| 运行过程看不懂 | 每一步只显示内部名称 | 给每一步加白话步骤摘要 | PR #15 |
| 审批风险标签不准 | 风险等级和实际操作不符 | 保留自动放行，只改准标签（Andy 选择） | PR #28（草稿） |

[返回目录](#contents)

<a id="source-status"></a>

## 业界资料的核对情况

2026-10-26 写第一版时，云端环境只能打开 GitHub、Anthropic 和 Go 的官方网站。同一天又用 Andy 的 Mac 本机网络逐条打开其余资料补核，结果已经写回各个案例。图例：

- ✅ 本次打开原文核对过，引文是原文。
- 🟡 打开了原文，但只核对到部分内容。
- 📎 本次没重新打开，但项目里的 ADR 或调研文档写成时打开过，链接在那份文档里。
- ⚠ 打不开原文，没有核对；面试时不要引用。

目前唯一没能核对的是 ChatGPT 记忆 FAQ：云端和 Mac 上打开都返回 HTTP 403。另有 4 条资料按原文改了措辞：Vercel 预算是四个范围，Letta 按步数或上下文压缩时整理，AWS 重试文章强调幂等，DORA 现在是五项指标。

[返回目录](#contents)

<a id="case-template"></a>

## 新增案例模板

复制下面的结构，追加在最后一个案例之后，并在[目录](#contents)和[岗位能力对照表](#competency-map)里加上链接。

```markdown
<a id="case-简短英文名"></a>

## 案例 N：一句话标题（写清楚问题本身）

**背景与现象**
用户或系统看到了什么，什么时候，影响多大。

**根因**
真正的原因，以及怎么确认的（复现、代码证据、计时数据）。

**我们的方案**
做了什么，复用了 Pi 的什么、Himawari 自己负责什么。

**方案讨论与备选**
考虑过哪些办法，各自好处和代价，为什么选这个，放弃了什么。

**业界主流做法**
只写打开过的一手资料，标 ✅ / 🟡 / 📎 / ⚠，附原文短引文。

**对比与取舍**
我们和业界做法的相同点、不同点和原因。

**结果数据**
量到的数字和出处；没量过就写“未测量”。

**相关 ADR/PR**
ADR、PR、提交、lessons 链接。

**面试 30 秒版**
三四句话：现象、根因、方案、数据。

[返回目录](#contents)
```

[返回目录](#contents)

<a id="maintenance"></a>

## 维护规则

- 规则写在项目说明 [AGENTS.md 的 Engineering Casebook 一节](../AGENTS.md#engineering-casebook)：任何线程或代理解决了一个值得一提的难题或 bug，或者做出了重要的架构或设计决定，就在同一次交付里新增或更新一个案例。快速模式和完整模式都适用。
- 只写有出处的数字；业界资料只引打开过的一手来源。
- 案例按时间追加，不改写旧案例的结论；结论变了就在原案例里补一段“后续”，写明日期。
- 方案 A、方案 B、速度优先路由等上线并测量后，回到[案例 4](#case-authority-checks)、[案例 5](#case-search-latency)、[案例 6](#case-sandbox-cold-start)、[案例 15](#case-model-gateway) 补上结果数据。

[返回目录](#contents)
