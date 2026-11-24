# Himawari 长期记忆系统重设计

## 结论先行

现在的记忆系统不是“主模型不够聪明”，而是**主模型拿不到原始证据**：写记忆时先由一个抽取模型把原话压成 200 字以内的第三人称摘要，读记忆时再由固定 top-k 检索替主模型挑 5 条，翻旧对话时只给日摘要。主模型看到的每一层都是别人替它判断过的二手结果，所以它再聪明也补不回被丢掉的原话、条件和例外。

我的方案是把层次倒过来：

> **原始对话是底稿，Markdown 笔记是目录和索引，主模型自己检索、自己判断。数据库保留事务、加密、来源、删除和导出保证；不再让抽取模型、确认裁判或固定 top-k 挡在主模型前面。**

这不是推倒重来。现有的 SQLite、加密 payload、`memory_records` 的版本/来源/有效期/分级、FTS5/向量索引、导出和记忆页都可以保留；要换的是**写读策略和工具面**。

---

# 一、方案依赖的前提

## A. 产品与规则前提（读代码证实）

1. **原则冲突时的优先级是用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。**
   来源：`docs/product-vision.md:55`，原话：“原则冲突时，按序优先：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。”

2. **记忆必须是单一权威源，可查看、编辑、删除；事实/偏好/推断分开；推断带来源、时间、置信度；纠正要传播；规则不是记忆。**
   来源：`docs/product-vision.md:59`，原话：“记忆是所有决策的主要输入，必须有单一权威源，且我可查看、编辑与删除。记忆区分事实、偏好与推断，推断带来源、时间与置信度；遗忘与纠正同样是记忆的功能，纠正应传播到受其影响的推断与行为。规则不是记忆，是硬性设定：记忆只保存一条规则的出处和修改历史；规则本身写进程序、必定执行，每条都有回归测试守着。”

3. **发给模型的内容只追加；固定的在前，会变的在后；每轮会变的值只能放最后一条用户消息；系统提示和工具按对话冻结。**
   来源：`.agents/instructions/prompt-prefix.md:27-28`，原话：“固定的在前，会变的在后。顺序是：工具定义 → 系统提示 → 历史 → 最后一条用户消息。越靠前的越不能变……每轮都会变的内容只放在最后一条用户消息里。”
   来源：`.agents/instructions/prompt-prefix.md:36`，原话：“已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。”
   来源：`.agents/instructions/prompt-prefix.md:42`，原话：“系统提示和工具按对话冻结……只有下面这些情况才换新一次……工具集合变了……模型变了……或者手动执行了 `thread prompt rebuild`。”

4. **同样内容每次必须序列化成同样字节；列表顺序、JSON 键顺序、记忆顺序都要固定；遮盖必须确定。**
   来源：`.agents/instructions/prompt-prefix.md:53`，原话：“同样的内容，每次都要序列化成同样的字节。JSON 的键顺序、工具的顺序、列表的顺序（命令清单、服务商、记忆）都要固定，不能依赖对象遍历顺序或数据库返回顺序。”
   来源：`.agents/instructions/prompt-prefix.md:54`，原话：“遮盖敏感信息必须是确定的。一条消息遮成什么样，只能取决于它自己和它前面的内容，不能取决于它后面的内容。”

5. **理解用户意思交给模型，程序只做校验，不得用关键词表/正则猜意图。**
   来源：`.claude/rules/owner-standing-rules.md:62`，原话：“判断用户一句话的意图、时效、是否明说、两句话是不是同一件事，一律交给模型，程序只做校验（原话是否逐字出自主人、格式、额度、白名单）。不得用关键词表、正则、停用词表或写死的词典去猜用户的意思。”

## B. 当前实现前提（读代码证实）

6. **现在每轮上下文由 `ContextFormationService` 组装：档案块 + 用本轮消息自动搜记忆，选 top-k。**
   来源：`packages/application/src/services/context-formation-service.ts:281-286`，原话：
   ```ts
   const selected: readonly SelectedMemory[] = allowed
     .slice(0, request.maxSelectedMemories)
     .map((candidate) => ({ ...candidate, reasonCode: "relevant_and_classification_allowed" as const }));
   ```
   来源：同文件 `:313-338` 把没选中的记忆写进 `context_truncation` 决策记录。

7. **生产模板里 `memoryLimit` 是 20、`maxSelectedMemories` 是 5。**
   来源：`scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:14-15`，原话：`"memoryLimit": 20, "maxSelectedMemories": 5`。

8. **主人档案块有 2000 字硬预算，只收重要度 ≥600 的五类记忆。**
   来源：`packages/application/src/services/owner-profile-service.ts:20`，原话：`export const OWNER_PROFILE_CHARACTER_BUDGET = 2000;`
   来源：同文件 `:24`，原话：`const PROFILE_MINIMUM_IMPORTANCE = 600;`
   来源：同文件 `:31-37`，只包含 `identity`、`preference`、`relationship`、`goal`、`project` 五类。

9. **模型能主动调的只有 `recall`：最多 10 条记忆 + 5 段日摘要。**
   来源：`apps/agent-service/src/production-memory-recall.ts:41`，原话：`limit: { type: "integer", minimum: 1, maximum: 10 },`
   来源：同文件 `:289`，原话：`limit: Math.min(5, input.limit),`
   来源：同文件 `:301-305`，返回的 `conversations` 是 `episode` 的 `summary`，不是原话。

10. **写记忆是每轮结束后单独一次模型调用，有 6000 字原文、20 条近期、10 条相关、最多 8 个候选、500 字记忆正文的硬上限。**
    来源：`apps/agent-service/src/production-memory-capture.ts:63-79`，原话：
    ```ts
    export const MEMORY_CAPTURE_POLICY_VERSION = "memory-capture:v5";
    const MAXIMUM_SOURCE_CHARACTERS = 6000;
    const MAXIMUM_RECENT_MEMORIES = 20;
    ...
    const MAXIMUM_RELEVANT_MEMORIES = 10;
    const MAXIMUM_CONTEXT_CHARACTERS = 1500;
    const MAXIMUM_CANDIDATES = 8;
    const MAXIMUM_MEMORY_CHARACTERS = 500;
    ```

11. **抽取提示词要求把原话改写成第三人称、一句完整的话、最多 200 字；原话只作为 `quote` 保留，至少 8 个字。**
    来源：`packages/prompt-catalog/src/memory.ts:5`，原话：“每条记忆用第三人称写成一句完整、独立的话……最多 200 字。”
    来源：同文件 `:57`，原话：“quote：从 ownerMessage 里原样摘抄支撑这条记忆的那句话（至少 8 个字……）……每条都必须填……找不到原话就不要输出这条记忆。”

12. **还有一次单独的“确认裁判”模型调用，判断主人的原话是否确认了某条待确认记忆。**
    来源：`packages/prompt-catalog/src/memory.ts:65-82`，原话：“你是 Himawari 的核对员……判断主人这句原话，是不是在重申、确认或再次表达 pendingMemory 所说的同一件事……拿不准，判否。”

13. **日摘要把一天对话压成最多 1200 字，原文最多 120 条、每条 1500 字、总转录 16000 字。**
    来源：`packages/memory-engine/src/episodes.ts:22-26`，原话：
    ```ts
    const MAXIMUM_SEGMENT_MESSAGES = 120;
    const MAXIMUM_MESSAGE_CHARACTERS = 1500;
    const MAXIMUM_TRANSCRIPT_CHARACTERS = 16000;
    const MAXIMUM_SUMMARY_CHARACTERS = 1200;
    ```

14. **整理记忆只处理最多 20 条新变化、3 个邻居、3 条洞察，词重叠低于 0.5 不比。**
    来源：`packages/memory-engine/src/consolidation.ts:46-50`，原话：
    ```ts
    const MAXIMUM_FRESH = 20;
    const MAXIMUM_NEIGHBOURS = 3;
    const MAXIMUM_INSIGHTS = 3;
    const MINIMUM_OVERLAP = 0.5;
    ```

15. **上下文块是放进最后一条用户消息的，不是系统提示。**
    来源：`packages/runtime-pi/src/pi-runtime-adapter.ts:644-662`，`turnPrompt` 把 `<himawari-context>`、时间、`blocks`、运行环境、`<owner-message>` 拼成最后一条用户消息。

16. **正文加密存在 `payloads`，对话消息在 `thread_messages`，记忆在 `memory_records`。**
    来源：`packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:57-74`（`payloads` 的 `ciphertext`/`key_ref`）、`:88-100`（`thread_messages` 的 `content_ref`）、`:393-408`（`memory_records` 的 `content_ref`、`classification`、`inference`、`confidence_permille`）。
    来源：`0052_memory_engine.sql:1-8` 增加 `category`、`importance_permille`、`valid_from`、`valid_to`、`superseded_by`、`use_count`、`evidence_verified`、`sensitive_topic`；`:18-46` 是 `memory_search_index` 和 FTS5 `memory_search_terms`。
    来源：`0053_memory_episodes.sql:4-34` 是 `memory_episodes` 和 `memory_episode_terms`。

17. **已有对话搜索投影和导出能力，但模型没有读原话的工具。**
    来源：`packages/persistence-sqlite/src/migrations/0015_thread_lifecycle_and_search.sql:47-57` 的 `thread_search_projection` 按消息建 token；`sqlite-thread-operations.ts:2024-2096` 的 `search` 只返回 `thread`，不返回消息。
    来源：`apps/agent-service/src/production-runtime-tools.ts:600` 只注册了 `memoryRecallDescriptor()`，没有写记忆或打开原话的工具。
    来源：ADR 0235 决定 1 已经有“每个对话一个 Markdown、`data/threads.jsonl`”的聊天导出；ADR 0200 决定 1 已经有 `MEMORY.md` + `memory/<类别>.md` 的记忆导出。

## C. 业界一手资料前提

18. **Anthropic memory tool：模型看到 `/memories` 下的文件，按需读；存储由应用决定，应用控制保留。**
    来源：<https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool>，原话：“The memory tool lets Claude store and retrieve information across conversations in a directory of memory files… Memory supports just-in-time context retrieval. Rather than loading all relevant information up front, an agent records what it learns in memory files and reads them back on demand.”；“The memory tool operates client-side… You control where and how the data is stored through your own infrastructure.”

19. **Anthropic 上下文工程：上下文会腐烂；最佳做法是“最小的高信号 token 集合”+ just-in-time；Claude Code 是 CLAUDE.md 预加载 + glob/grep 按需检索的混合。**
    来源：<https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>，原话：“as the number of tokens in the context window increases, the model’s ability to accurately recall information from that context decreases.”；“good context engineering means finding the smallest possible set of high-signal tokens that maximize the likelihood of some desired outcome.”；“Claude Code is an agent that employs this hybrid model: CLAUDE.md files are naively dropped into context up front, while primitives like glob and grep allow it to navigate its environment and retrieve files just-in-time.”

20. **Claude Code 的 MEMORY.md 只开局载入前 200 行/25KB，主题文件按需读；记忆文件就是可编辑/删除的 Markdown。**
    来源：<https://code.claude.com/docs/en/memory>，原话：“The first 200 lines or 25KB of `MEMORY.md`, whichever comes first, load at session start… Claude Code doesn’t load topic files… Claude reads them on demand using its standard file tools when it needs the information.”；“Auto memory files are plain markdown you can edit or delete at any time.”

21. **Claude App：边聊边按主题存记忆；能搜索旧聊天并引用回原对话；改一个主题会作用于之后所有对话。**
    来源：<https://support.claude.com/en/articles/11817273>，原话：“Claude saves memory as a set of individual topics as you chat, rather than summarizing conversations after they end.”；“When Claude references previous conversations through search, you’ll see citations linking back to the original chats, along with the option to delete specific conversations.”；“Fix something in one topic and the change applies to every conversation from then on.”

22. **ChatGPT：记忆不是保留每个细节；它会判断哪些信息与回答相关；有保存记忆和参考聊天记录两条路；Sources 可回溯。**
    来源：<https://help.openai.com/en/articles/8590148-memory-faq>，原话：“Memory does not retain every detail from every conversation. ChatGPT decides which available information is relevant to a response, and Memory can change as your context changes.”；“Reference chat history… lets ChatGPT use relevant information from past conversations to personalize future responses.”；“Sources can help you review information such as a past chat, saved memory, custom instruction, file, or connected email that contributed to personalization.”

23. **LangChain：单份 profile 越大越容易出错；集合召回更高但更新/搜索更难；写记忆分 hot path 和 background，各有代价。**
    来源：<https://docs.langchain.com/oss/javascript/concepts/memory>，原话：“This can become error-prone as the profile gets larger… a document collection tends to lead to higher recall downstream… However, this shifts some complexity memory updating… and memory search over the list.”；“Creating memories during runtime… may increase complexity… can impact agent latency.”；“Creating memories as a separate background task… eliminates latency in the primary application… Determining the frequency of memory writing becomes crucial.”

24. **Letta：把对话历史放进文件、用文件系统工具检索，在 LoCoMo 上 74.0%，高于专用记忆工具；记忆更多取决于 agent 如何管理上下文，而不是检索机制本身。**
    来源：<https://www.letta.com/blog/benchmarking-ai-agent-memory>，原话：“Letta agents running on `gpt-4o-mini` achieve 74.0% accuracy on LoCoMo by simply storing conversation histories in files, rather than using specialized memory or retrieval tools.”；“memory is more about how agents manage context than the exact retrieval mechanism used.”

25. **Letta sleep-time：把记忆管理放到睡眠时的子 agent，主 agent 不直接改 core memory；记忆形成可以异步整理。**
    来源：<https://www.letta.com/blog/sleep-time-compute>，原话：“Offloading memory to a sleep-time agent allows memory management to happen asynchronously.”；“the primary agent is not provided with tools to edit its core memory… These tools are attached to the sleep-time agent.”

26. **Zep：原始 episode 无损保留、事实带双时间线、失效不删。**
    来源：<https://arxiv.org/abs/2501.13956>，原话：“Graphiti — a temporally-aware knowledge graph engine that dynamically synthesizes both unstructured conversational data and structured business data while maintaining historical relationships.”（论文是作者自评，数字 94.8% vs 93.4%、最高 18.5% 提升、90% 延迟下降均为作者报告。）

27. **Mem0：写时抽取/整合/检索；相对全上下文，p95 延迟低 91%、token 省 90% 以上。**
    来源：<https://arxiv.org/abs/2504.19413>，原话：“dynamically extracting, consolidating, and retrieving salient information from ongoing conversations.”；“Mem0 attains a 91% lower p95 latency and saves more than 90% token cost.”（作者报告；材料里“全上下文基线准确率反而最高”这句，我读到的摘要没有直接写，未逐表核实。）

28. **LongMemEval：商业聊天助手和长上下文模型在持续交互上准确率掉 30%；按“轮/会话”分解、事实增强的 key 扩展、时间感知查询扩展有效。**
    来源：<https://arxiv.org/abs/2410.10813>，原话：“commercial chat assistants and long-context LLMs showing a 30% accuracy drop on memorizing information across sustained interactions.”；“session decomposition for value granularity, fact-augmented key expansion for indexing, and time-aware query expansion for refining the search scope.”

29. **MemDelta：受控对比下，逐字 RAG 与全上下文接近（47.2% vs 49.8%），agent 自管记忆 42% 不如基础检索 47%；评测必须固定嵌入模型、按模型家族分层、报告写入成本。**
    来源：<https://arxiv.org/abs/2606.29914>（预印本），原话：“verbatim RAG matches full-context GPT-4o-mini (47.2% vs. 49.8%, p = 0.34).”；“agent self-memory (42%) underperforms basic retrieval (47%).”；“We recommend memory evaluations fix embedding models across comparisons, stratify by model family, and report write-path cost before attributing gains to architecture.”

30. **Mnemon：原样保存带日期的对话记录，写入时不做决定；后台整理成主题时间线、价值历史、常驻指令，并链回原记录；在 LoCoMo 91.7%、LongMemEval-S 83.8%，每题不到 4k token；100K 到 10M token 每题成本只涨 1.11 倍。**
    来源：<https://arxiv.org/abs/2609.36059>（预印本），原话：“It keeps conversations as raw, dated records… Because nothing is decided about a record when it is written, the same agent can read any store that returns dated records.”；“A background pass consolidates each record once into topic timelines, value histories and standing instructions linked to the records.”；“91.7% on LoCoMo… 83.8% on LongMemEval-S, from under 4k tokens of context per question… cost per question grows by a factor of 1.11.”

## D. 推测（尚未由代码或来源证实）

- **推测 1：** 去掉每轮抽取模型后，主模型在“原话、条件、例外、纠正”类问题上的表现会明显变好。依据是 MemDelta 的“逐字 RAG ≈ 全上下文、agent 自管记忆更差”和 Mnemon 的“写入时不决定”，但 Himawari 自己的数据上还没测。
- **推测 2：** 主模型会稳定地使用 `memory_search` / `memory_open` / `memory_write` 这些工具。Letta 的文件系统实验支持这一点，但 Himawari 的模型和提示词不同，必须用 eval 验证。
- **推测 3：** 在 Andy 的真实数据规模下，SQLite FTS5 + 向量 + 消息级索引能在 4 核 8GB 上满足延迟。仓库里没有生产库的实测数字（ADR 0239 明确说没读生产库），未核实。
- **推测 4：** 一次性的工具集合换新（缓存失效）Andy 能接受。ADR 0165 的上线影响已经说明过类似代价，但这次要 Andy 明确同意。
- **推测 5：** Markdown 笔记 + 数据库目录能同时满足“可读可改”和“单一权威源”。这是设计判断，不是已证实结论。

---

# 二、根因：现在的设计哪里让主模型不够聪明

## 根因 1：写记忆时就把原话压成了摘要，主模型永远看不到被丢掉的部分

`production-memory-capture.ts` 每轮结束后单独调用一次模型，只给它当前消息最多 6000 字、20 条近期记忆、10 条相关记忆，要求最多 8 个候选；提示词还要求把记忆改写成第三人称、最多 200 字（`production-memory-capture.ts:64-79`、`prompt-catalog/src/memory.ts:5`）。这不是“记忆”，这是**写时的一次有损压缩**。原话里的条件、例外、语气、时间关系、未说完的线索，一旦没被抽成候选，就永久丢失；主模型之后无论多聪明都找不回来。

## 根因 2：读记忆时又用固定 top-k 替主模型挑了一小块

`ContextFormationService` 用本轮消息自动搜记忆，按分数取前 `maxSelectedMemories` 条（生产 5 条），其余写进 `context_truncation`（`context-formation-service.ts:281-286`、`:313-338`）。主模型没有“再看 20 条”“按时间翻”“打开这条的来源”的能力。它看到的不是“所有必要上下文”，而是**一个机械排序器认为最像的 5 条**。这正是 Andy 说的“只看一小块信息的小判断”，只是这次判断者不是模型，是检索器。

## 根因 3：翻旧对话只有日摘要，没有原话

`production-memory-recall.ts:301-305` 返回的 `conversations` 是 `episode.summary`，不是 `thread_messages` 的原文；`episodes.ts:22-26` 把一天压成最多 1200 字。主模型无法回答“我当时原话怎么说的”“这个条件的例外是什么”“那次纠正发生在哪一句”。这和目标“能翻回以前对话的原话”直接冲突。

## 根因 4：档案块是预计算的有损投影，且有 2000 字/重要度 600 的硬门槛

`OwnerProfileService` 只把重要度 ≥600 的五类记忆放进 2000 字预算（`owner-profile-service.ts:20,24,31-37`）。低重要度但有上下文价值的事实、事件、承诺、健康/财务类，默认不进档案；进了档案的也被压成一行。主模型没有“档案之外还有什么”的地图，也没有“展开”的入口。

## 根因 5：所有数量上限都是写死的，和“不要为了他看不过来设上限”冲突

`2000`、`5`、`10`、`6000`、`20`、`8`、`120`、`1200`、`20/3/3` 这些值散落在 `owner-profile-service.ts`、`production-memory-recall.ts`、`production-memory-capture.ts`、`episodes.ts`、`consolidation.ts`。它们不是物理限制，是产品判断；而且判断发生在主模型之前。Andy 要的是“能动态获取的值不要写死”，这些正是该被替换的。

## 根因 6：规则被当成记忆，和“规则不是记忆，是硬性设定”冲突

`OwnerProfileService` 从 `memory_records` 里取 `category === "rule"` 的记忆拼成 `owner-rules` 块（`owner-profile-service.ts:216-219`）。产品原则明确说规则不是记忆，是硬性设定（`product-vision.md:59`）。把规则放在记忆里，就会出现“模型有没有把它归为 rule、有没有被标成待确认、有没有被 2000 字预算挤掉”的概率性问题；这正是 v2.2 愿景里已经指出的裂缝。

**一句话根因：** 系统把“记忆”理解成“写时判断后的事实库”，而不是“原始证据 + 可检索的索引”。判断发生在主模型之前，证据被摘要替代，检索窗口被写死，所以主模型拿不到做最聪明判断所需的东西。

---

# 三、完整设计

## 3.1 总体结构：两层 + 一套派生索引

```
┌─────────────────────────────────────────────────────────────┐
│ L0 原始记录（权威：发生过什么）                              │
│ thread_messages / tool results / events                      │
│ 逐字、加密、追加、带 thread/sequence/时间/角色/分级          │
└───────────────────────┬─────────────────────────────────────┘
                        │ 派生（可重建，不是权威）
┌───────────────────────▼─────────────────────────────────────┐
│ L1 记忆笔记（权威：现在相信什么）                            │
│ Markdown 文档 + YAML frontmatter                             │
│ 事实/偏好/推断/承诺/事件/关系/项目；来源、有效期、置信度     │
│ 版本历史、supersedes、derived_from、tentative、删除墓碑      │
└───────────────────────┬─────────────────────────────────────┘
                        │ 派生（可重建，不是权威）
┌───────────────────────▼─────────────────────────────────────┐
│ L2 索引与视图                                                │
│ FTS5 / 向量 / 实体 / 时间；MEMORY.md 目录；导出 Markdown     │
└─────────────────────────────────────────────────────────────┘
```

**单一权威源怎么落地：**
- “发生过什么”只有一个权威：L0 原始记录。
- “现在相信什么”只有一个权威：L1 笔记目录（数据库里的笔记行 + 加密 Markdown 正文）。
- 索引、`MEMORY.md`、档案卡、导出文件、日摘要都是派生视图，**永远可以从 L0/L1 重建**，不得成为第二份可写副本。
- 这解决了现在“记忆记录、日摘要、档案块、导出 Markdown 各说一套”的问题。

## 3.2 存什么

### L0 原始记录

- 每条主人消息、助手回答、工具调用/结果、系统事件，按实际发送/收到的字节存。
- 字段：`thread_id`、`message_id`、`sequence`、`role`、`content_ref`（加密 payload）、`classification`、`committed_at`、`run_id`、`turn_id`、附件引用、来源。
- 不改写、不摘要、不删除（除非主人明确删除对话/消息）。
- 复用现有 `thread_messages` 和 `payloads`；新增消息级检索索引（现有 `thread_search_projection` 已经是消息级 token，只是搜索接口只返回 thread，需要扩成返回 message）。

### L1 记忆笔记

每个笔记是一个 Markdown 文档，数据库行是目录项。建议 frontmatter：

```yaml
---
id: mem_01J...
path: preferences/food.md
kind: fact | preference | inference | commitment | event | relationship | project
title: 饮食偏好
status: active | tentative | archived | deleted
confidence: 0.92
valid_from: 2026-11-01
valid_to: null
recorded_at: 2026-11-24T10:00:00Z
updated_at: 2026-11-24T10:00:00Z
supersedes: [mem_01H...]
superseded_by: null
derived_from: [mem_01G...]
sources:
  - thread: thread_...
    message: msg_...
    quote: "我以后不吃辣了"
classification: private
tags: [饮食, 健康]
---
正文用 Markdown，可以写多段、列表、条件、例外、原话引用。
```

- **事实/偏好/推断**用 `kind` 区分；推断必须至少有一个 `sources` 或 `derived_from`，`confidence < 1`，默认 `tentative` 直到主人确认或再次出现。
- **双时间线**：`valid_from/valid_to` 是“这件事什么时候为真”，`recorded_at/updated_at` 是“我们什么时候知道/改的”。这是 Zep 的做法（来源 26），也是纠正和“以前的情况”问题的基础。
- **来源**：`sources` 存消息 ID + 逐字引文；`derived_from` 存笔记到笔记的推导边。这样纠正可以传播。
- **规则不进来**：规则继续走 rule book / `rule_set`，笔记最多记一条“主人何时立了这条规则、原话是什么”的出处笔记，规则本身由程序执行（`product-vision.md:59`）。

### L2 索引

- 笔记：FTS5（正文/标题/标签/实体）+ 向量 + 实体 + 时间/状态/类型过滤。复用 `memory_search_index`、`memory_search_terms`、`memory_entities`。
- 原始消息：消息级 FTS5 + 向量 + 时间/线程/角色/分级过滤。复用/扩展现有 `thread_search_projection`。
- 所有索引带 `index_version`、`embedding_model`、`dimensions`；模型/维度变了就重建，不混用。

## 3.3 存哪：Markdown 的好处 + 数据库的保证

Andy 要“两样都要”，我的答案是：**逻辑上是 Markdown 文档，物理上由 SQLite 做目录和保证。**

- **Markdown 的好处**：人和模型都能直接读；一条笔记一个文件，可 diff、可 Git、可单独编辑；导出就是文件树；模型用文件工具时符合训练分布（Letta 的文件系统实验，来源 24；Claude Code 的 `MEMORY.md` + 主题文件，来源 20）。
- **数据库的保证**：事务、外键、并发写、加密、访问控制、索引、版本历史、来源、删除墓碑、备份一致性、导出清单和哈希。纯文件系统在这些方面会退化成“两个客户端 + 模型 + 主人”同时改同一份文件，容易出现 split-brain；纯数据库又失去 Markdown 的可读可编辑。
- **落地**：笔记正文以 `text/markdown` 加密存进 `payloads`，`memory_records.content_ref` 指向它；`memory_records` 加 `path`、`body_format`、`kind`、`derived_from` 等目录字段。服务把 L1 渲染成 `/memories` 视图和 `MEMORY.md`；模型通过工具读写，Andy 通过记忆页读写。**服务是唯一写入口**；如果 Andy 直接改磁盘上的 `.md`，由一个导入器做 schema 校验 + 版本冲突检测后再写库，不让文件绕过权威。
- 这样既保留“Markdown 文档”的形态，又不把 SQLite 的保证丢掉。

## 3.4 怎么写

### 3.4.1 原始记录：每轮都写，不做判断

- 消息提交时，`thread_messages` 原样落库。**不再依赖抽取模型来决定“这条消息值不值得记”**；原始记录永远在。
- 这直接落实 Mnemon 的“写入时不做决定”（来源 30）和 MemDelta 的“逐字检索是强基线”（来源 29）。

### 3.4.2 主模型直接写笔记

新增工具（工具定义固定，结果追加）：

- `memory_write`：创建/更新/取代一条笔记。
  - 参数：`path` 或 `id`、`kind`、`title`、`content`（Markdown 正文）、`sources`（消息 ID + 逐字引文）、`derived_from`、`valid_from/valid_to`、`confidence`、`tags`、`expected_version`。
  - 校验：owner/agent 范围；分类不超过模型可见上限；`restricted` 拒绝；`sources` 的消息必须属于主人、已提交、未删除、分类允许，且引文逐字出现在消息里；`inference` 必须有来源/推导边且 `confidence < 1`；`supersedes` 必须存在且无环；`path` 必须是安全相对路径；`expected_version` 必须匹配当前版本（乐观并发）。
  - 返回：新 `id`、`version`、`path`、变更摘要；工具结果的分级取笔记和来源的最高分级。
- `memory_append`：向已有笔记追加一段（带版本检查），适合“同一主题又补充了一点”。
- `memory_delete`：默认软删除（墓碑 + 从索引/卡片移除 + 保留历史）；硬删除需要主人确认，删 payload/引文并审计。
- `memory_restore`：恢复某个历史版本。
- `memory_history`：列出版本、变更、来源、谁改的、为什么。

**为什么让主模型写，而不是再开一个抽取模型：**
- Andy 要删掉“先问另一个判断模型值不值得想”的结构。主模型已经在对话里，最懂当前语境；让它直接写，省掉一次有损转述和一次额外调用。
- LangChain 的 hot path 写有延迟/复杂度代价（来源 23），但 Himawari 是单人、非高并发，且主模型写一条笔记只是一次工具调用；比“每轮固定再调一次抽取模型”更省、更准。
- 如果主模型没写，原始记录还在，之后仍可检索/补写；不会像现在这样“没抽到就丢了”。

### 3.4.3 后台整理：是图书管理员，不是门卫

- 保留后台整理/回看，但改职责：**只整理 L1 笔记，不决定 L0 能不能被看到，不阻塞当前轮。**
- 输入：自上次游标以来的原始消息（不是日摘要）+ 相关笔记。
- 动作：合并重复、标出冲突、把“跨几条消息才完整”的事补成笔记、把被推翻的旧笔记标 `superseded`、把推断标 `tentative`。
- 输出：可逆的批量变更（带 batch id、改前值、撤销），或进入 Andy 的 review queue。**不做整库重写**（Dreams 式整库重写会丢来源/版本/撤销，ADR 0231 已拒绝）。
- 不再用“确认裁判”作为门：确认由主模型在对话里做（主人再次表达/明确确认），或由 Andy 在 review queue 里做；程序只做“引文是否逐字出现”的确定性校验。
- 频率/批量由时间/费用预算动态决定，不写死每天最多几条。

### 3.4.4 明确“记住”

- 主人说“记住”时，主模型调用 `memory_write` 立即写；不靠关键词表识别（`owner-standing-rules.md:62`）。
- 如果主模型漏了，后台回看会从原始记录补；Andy 也可以在记忆页手动加。
- 规则类请求走 `rule_set`，不走记忆；记忆只记出处。

## 3.5 怎么读

### 3.5.1 开局给一张“地图”，不给整座图书馆

在对话开始时，最后一条用户消息里放一个**动态预算的记忆卡**（复用 `turnPrompt` 的 context block 机制，`pi-runtime-adapter.ts:644-662`）：

- 置顶/常驻笔记（主人 pin 的、身份/长期偏好/进行中的项目/未来承诺）。
- 一张目录摘要：按类型/标签的笔记数、最近更新时间、原始对话/消息数、可用工具提示。
- 现有“未来 7 天安排”和“规则”块保留，但规则块来自 rule book，不来自记忆。
- 预算不是 2000 字，而是**由模型上下文窗口和当前 token 用量算出来的**（例如剩余预算的 3%–5%，有配置上下限）。放不下就只放目录和计数，并明确告诉模型“还有 N 条，调用 `memory_index` 看更多”。这不是“他看不过来”的产品上限，是物理/费用预算。
- 后续轮次只追加“记忆增量”（自上一轮以来新增/修改/删除的笔记摘要 + 置顶项），没有变化就不追加；完整内容仍靠工具按需取。

### 3.5.2 工具面（固定定义，结果追加）

建议一次加齐，之后不再改工具集合：

1. `memory_index(query?, path?, kind?, status?, cursor?, limit?)`
   - 返回目录/标题/元数据，不返回全文；支持分页；`limit` 默认按剩余上下文动态算，不写死 10。
2. `memory_search(query, scope?, from?, to?, kinds?, include_history?, include_raw?, cursor?, limit?)`
   - 混合检索（FTS + 向量 + 实体 + 时间/新近度 + 状态/有效期），RRF 融合；返回排序后的片段、`id`、类型、日期、状态、置信度、来源消息 ID、`nextCursor`。
   - `include_raw=true` 时同时搜 L0 原始消息；否则只搜笔记。
   - 默认只返回当前有效；`include_history=true` 才返回已失效/被取代的，并标“历史”。
   - 保留相关度门槛避免 I-23 的“无关也凑 5 条”；但结果里带 `belowCutoff` 计数和 `nextCursor`，模型可以要求“继续”或“放宽”。
3. `memory_open(id, range?)`
   - 打开笔记：完整 Markdown + frontmatter + 历史摘要 + 来源。
   - 打开原始消息/对话窗口：逐字原文 + 前后文 + 时间 + 线程标题；长对话分页。
4. `conversation_search(query, from?, to?, thread?, cursor?, limit?)`
   - 只搜 L0 原始消息；返回消息级命中、逐字片段、线程/日期/角色、深链。
5. `conversation_open(threadId, aroundMessageId?, range?)`
   - 打开原始对话窗口，逐字返回。
6. `memory_write` / `memory_append` / `memory_delete` / `memory_restore` / `memory_history`
   - 见 3.4.2。

`recall` 可以保留为 `memory_search` 的兼容别名，或直接替换；替换会改工具集合，按 ADR 0165 换新一次。

### 3.5.3 检索策略

- **笔记和原话都检索，但角色不同**：笔记是“索引/结论”，原话是“证据”。默认先给笔记片段 + 来源；模型要原话时 `memory_open`/`conversation_open`。对“我当时怎么说的”“条件是什么”这类问题，提示词要求先打开原话。
- **不做“先让一个小模型判断值不值得想”**：检索结果直接给主模型；主模型决定要不要继续查、要不要打开、要不要写。
- **不做固定 top-k 的唯一通道**：保留一个小卡片作为“地图”，但模型永远可以 `memory_search`/`memory_index` 拿到更多；没有“第 6 条永远看不到”的情况。
- **时间由模型给**：`from/to`、`include_history` 由模型按问题决定（现有 `memory.recall` 已有这个设计，ADR 0262）；程序只校验日期格式和时区。
- **分类在返回前过滤**：按模型可见上限（sensitive；restricted 永不可见）过滤；结果报告最高分级，运行按实际内容升级准入（ADR 0193）。敏感内容仍走出口遮盖。

## 3.6 谁来决定

| 角色 | 决定什么 | 不决定什么 |
|---|---|---|
| 主模型 | 这条信息要不要写、写成什么、要不要搜、搜什么、打开哪条、怎么解释、要不要纠正 | 不绕过 owner/分类/加密/删除校验 |
| 服务（确定性代码） | owner/agent 范围、分类上限、加密、引文逐字校验、版本并发、路径安全、索引、审计、删除 | 不判断“重不重要”“相关性够不够”（相关度门槛是检索参数，不是内容裁决） |
| 后台整理 | 合并/取代/补记/推断的建议或可逆自动应用 | 不阻塞当前轮、不删原始记录、不整库重写 |
| Andy | 最终查看、编辑、删除、恢复、导出、暂停、pin、review | 不需要逐条确认常规记忆 |

## 3.7 怎么纠正和遗忘

### 纠正

1. 主模型或 Andy 改一条笔记 → 新版本；旧版本 `valid_to` 设为变更时间，`superseded_by` 指向新版本；历史保留。
2. 沿 `derived_from` 找依赖它的推断/笔记：
   - 能确定性重算的，重算并记新版本；
   - 不能的，标 `needs_review` + `tentative`，进 review queue；
   - 依赖它的规则，标“规则出处已变，需复核”（现有 ADR 0232 的 `memory_rule_needs_review` 思路）。
3. 失效档案卡/缓存；下一轮卡片和检索立刻反映新状态。
4. 决策记录写一条：改了哪条、为什么、影响了哪些依赖、谁改的。
5. 测试：纠正后旧说法不再作为“当前”返回；新说法返回；依赖推断不再 active；规则被标复核；原始记录仍保留旧说法（可查“以前的情况”）。

### 遗忘

- **删笔记**：软删除 = 墓碑 + 从 FTS/向量/实体/卡片移除 + 历史保留；硬删除 = 删 payload/引文/历史 + 审计 + 删除验证。原始消息不受影响。
- **删原始消息/对话**：走现有对话删除流程；相关笔记的 `sources` 标“来源已不可查”（ADR 0186 的既有做法）；如果笔记只有这一个来源，标 `source_missing` 并可归档；从消息索引移除。
- **按主题遗忘**：主模型用 `memory_search`/`conversation_search` 找全相关笔记和原话，生成删除/抑制清单，Andy 确认后批量处理；不靠关键词表。
- **“不要再提”**：给笔记/主题加 suppression 标记，检索排除，但原始记录保留（ChatGPT 的 “Don't mention this again” 类似，来源 22）。这和删除分开，避免误删证据。
- **时间范围遗忘**：删某段消息；依赖该段的笔记标 `source_missing`。
- **删除验证**：删除后 FTS/向量/实体/卡片/导出/网页都不再返回；备份/日志按保留策略处理并写清楚；硬删除用 crypto-shred（删 payload 密钥/密文）。

## 3.8 原话怎么翻

- `conversation_search` 搜 L0 消息，返回逐字片段 + `thread_id`/`message_id`/日期/角色；`conversation_open` 打开原文和前后文。
- 笔记的 `sources` 里存消息 ID + 逐字引文；`memory_open` 一条笔记就能看到“这句话出自哪条消息”，点开就是原话。
- 日摘要保留，但降级为“导航”：每段摘要带 `first_sequence`/`last_sequence` 和原始消息链接；摘要可能错，模型可以随时打开原话核对。这样既保留摘要的快速浏览，又不让摘要成为唯一证据。
- 对长对话，`conversation_open` 用窗口 + 游标分页；不设“最多 120 条”这种内容上限，只设单次返回的 token/条数预算，模型可以继续翻。

## 3.9 Andy 怎么看和改

记忆页建议：

- **笔记树/列表**：按类型、标签、时间、状态（active/tentative/archived/deleted）、分类筛选；搜索；置顶；显示来源数、更新时间、置信度。
- **笔记详情**：Markdown 正文 + frontmatter；来源（点开原话）；历史版本/diff/恢复；`derived_from` 依赖图；“为什么存在”（决策记录）；编辑/删除/抑制。
- **原始对话浏览**：全文搜索、日期/线程筛选、打开原话、高亮；和现有聊天页打通。
- **Review queue**：后台整理的合并/取代建议、待确认推断、来源缺失的笔记、需复核的规则；一键接受/拒绝/撤销。
- **控制**：暂停记忆、暂停某个来源、导出、导入、删除全部（带确认）。
- **可解释**：任何一次回答都能点开“用了哪几条笔记/哪几条原话、命中了哪条规则、决策记录是什么”，对应 Jarvis Test #11。

## 3.10 怎么导出

在现有 ADR 0200 / 0235 基础上做 v2：

- `himawari.memory.v2` 包：
  - `MEMORY.md`：目录，一行一条笔记（路径、类型、更新时间、状态、一句话摘要）。
  - `memory/<path>.md`：每条笔记一个 Markdown 文件（frontmatter + 正文），文件顺序/键顺序固定。
  - `data/notes.jsonl`：机器可读的权威数据（含历史、来源、`derived_from`、分类、版本）。
  - `data/raw-messages.jsonl` 或独立的 `himawari.chat-export.v1`：原始对话（逐字、加密/遮盖规则同现有）。
  - `schema/*.schema.json`：笔记、原始消息、清单的 JSON Schema。
  - `manifest.json`：格式版本、迁移序号、导出时间、每个文件路径/角色/字节数/SHA-256/行数、条数、扣留数、未导出项。
  - 可选 `sealed/sealed.enc`：口令加密的机密原文（沿用 ADR 0200 的 scrypt + AES-256-GCM）。
- **导入**：校验路径/清单/哈希/schema/引用完整性；只进空库或按明确冲突策略合并；用目标库的保护器重新加密；重建索引；保留 ID/来源/版本；失败整体回滚。
- **文件数量**：不再固定“每个文件最多 500 条”；按大小/条数动态分片，manifest 写清楚。
- **Git 友好**：一条笔记一个文件、确定性序列化，Andy 可以直接 `git diff`。

## 3.11 和现有代码的映射（不是推倒重来）

| 现有 | 新设计 |
|---|---|
| `thread_messages` + `payloads` | L0 原样保留；新增消息级 FTS/向量检索接口 |
| `memory_records` + `memory_history_events` + `memory_provenance` + `memory_entities` | L1 笔记目录；`content_ref` 改为 `text/markdown`；加 `path`、`body_format`、`kind`、`derived_from`；历史/来源复用 |
| `memory_search_index` / `memory_search_terms` | L1 索引复用；加消息级索引 |
| `context-formation-service` | 改成“卡片构建器”：动态预算 + 增量；不再做固定 top-k 的唯一选择 |
| `owner-profile-service` | 改成卡片渲染器；去掉 2000/6000 硬预算和重要度门槛；规则改从 rule book 取 |
| `production-memory-recall` | 扩成 `memory_search` / `memory_open` / `conversation_search` / `conversation_open`；去掉 10/5 上限，加游标/动态 limit |
| `production-memory-capture` | 降级为可选后台回看；不再每轮固定抽取；去掉确认裁判门 |
| `consolidation` | 读原始消息 + 笔记；去掉 20/3/3/0.5 硬上限；可逆批量 + review queue |
| `episodes` | 保留为导航摘要；不再作为唯一旧对话通道；每段链回原始消息 |
| 导出 ADR 0200/0235 | 升级到 v2；Markdown 文件树 + JSONL + manifest；导入校验 |
| 记忆页 | 笔记树 + 原文浏览 + review queue + 历史/来源/依赖 |

**迁移路径：**
1. **阶段 0（最快见效）**：加 `conversation_search` / `conversation_open`，把 `recall` 的上限改成动态；先让主模型能翻原话。这一步就能验证“原话”价值。
2. **阶段 1**：加 `memory_search` / `memory_open`，把现有笔记按 Markdown 渲染，去掉 10/5 硬上限；卡片改成动态预算 + 目录。
3. **阶段 2**：加 `memory_write` / `memory_append` / `memory_history` / `memory_delete`；停止每轮抽取作为门；后台回看改为补记；加 `derived_from` 和纠正传播。
4. **阶段 3**：规则从记忆迁到 rule book；导出/导入 v2；UI review queue；全量评测。

---

# 四、怎么用评测证明新设计更好

## 4.1 比较哪几种做法

用同一套模型、同一套提示词、同一套嵌入模型（MemDelta 的教训，来源 29），只换记忆层：

| 代号 | 做法 | 作用 |
|---|---|---|
| A | 现在的生产：2000 字档案 + top-5 自动注入 + `recall` 10 条 + 日摘要 5 段 | 基线 |
| B | 全量原始历史直接放上下文（能放下时） | 上界/成本对照 |
| C | 只用原始消息做逐字 RAG，模型自己搜 | 验证“原话检索” |
| D | 只用笔记（改进后的结构化记忆） | 验证“笔记” |
| E | **本方案：原始 + 笔记 + 主模型工具（无小裁判）** | 主方案 |
| F | E 去掉后台整理 | 消融 |
| G | E 加一个小模型裁判（Andy 想删的那种） | 验证“小裁判是否真的有用” |
| H | Claude Code 式固定索引（200 行/25KB）+ 主题文件 | 验证固定上限 vs 动态索引 |

## 4.2 量什么

| 维度 | 指标 | 说明 |
|---|---|---|
| 回答质量 | LongMemEval-S 准确率、按能力分（抽取/多会话/时间/知识更新/拒答） | 公开对照；同一判分模型 |
| 真实分布 | ADR 0239 的真实记忆周评测、固定面板 | Andy 自己的数据 |
| 检索 | Recall@k、MRR、stale-free、无关命中率 | 现有 `memory-evaluation.test.ts` 的指标 |
| 原话 | 逐字引用准确率、来源准确率（引用消息是否真的支持结论）、条件/例外完整率 | 新增“原话/来源”题集 |
| 纠正 | 纠正后旧说法抑制率、新说法命中率、依赖推断更新率、规则复核触发率 | 新增纠正题集 |
| 拒答/负例 | 无关问题返回空、删除后不返回、受限不泄漏、tentative 标注 | I-23 类反向用例 |
| 成本 | 每轮输入/输出 token、模型调用次数、p50/p95 延迟、缓存命中率、存储/索引成本 | 必须报告写入成本（MemDelta） |
| 规模 | 100K/1M/10M token 历史下的准确率和每题成本增长 | 目标 <2x（Mnemon 报告 1.11x） |
| 人 | Andy 每周真实使用评分、决策记录评价、“不用重复交代”率、“引用对原话”率 | Jarvis Test #10/#11 |

## 4.3 成功标准

- E 在 LongMemEval-S 上 ≥ A + 5pp，且不低于 C（逐字 RAG 是强基线；如果 E 不如 C，说明笔记层没价值，应该砍掉或简化）。
- E 在“原话/来源”和“纠正”题集上 ≥ A + 20pp。
- 负例：无关/删除/受限/待确认的误命中为 0（或低于约定阈值）。
- 成本：E 每轮成本 ≤ A × 1.2，缓存命中率不低于 A；如果工具调用导致成本上升，用“去掉每轮抽取调用”抵消。
- 规模：100K→10M token 每题成本增长 <2x。
- 消融：F（无后台整理）应下降但不应崩；G（加小裁判）如果不如 E，就证明 Andy 的判断正确，正式删掉小裁判。

## 4.4 自动检查和反向用例（必须真的会失败）

在现有 `check:prompt-prefix` 基础上加：

1. **`[memory-v2-prefix]`**
   - 新工具在冻结头里；记忆内容只出现在最后一条消息/工具结果；系统提示/工具定义里没有记忆正文、时间、路径。
   - 反向：把一条笔记的 `updated_at` 或 `current` 放进系统提示 → 检查失败；把记忆卡插到历史中间 → 失败；改写上一轮已存消息 → 失败。
2. **`check:memory-determinism`**
   - 同一 DB 快照渲染两次，字节相等；打乱 DB 返回顺序，字节仍相等；搜索两次，顺序相同。
   - 反向：去掉排序/用 `Object.keys` 原顺序 → 失败；把 `now` 写进笔记正文 → 失败。
3. **`check:memory-contract`（I-73 教训）**
   - 每个新值（笔记 ID、`path`、`kind`、`status`、`confidence`、`sources`、`derived_from`、工具参数、导出字段）从产生端到所有消费端走一遍：DB CHECK、网关契约、导出 schema、UI、工具参数、索引。
   - 反向：生成一个带 `/`、`:`、Unicode、超长、空值的 ID/字段，必须被两端一致地接受或拒绝；如果只在一端校验，检查失败。
   - 参考 I-73：`modelRef` 清单生成 `magpie:opencode-go/...`，但发送校验只允许 `._:-`，导致消息发不出去（`docs/incidents-and-gates.md:112`）。
4. **`check:memory-deletion`**
   - 删笔记后 FTS/向量/实体/卡片/导出/UI 都不返回；原始消息仍在；删原始消息后 `conversation_search` 不返回；来源缺失的笔记标 `source_missing`。
   - 反向：不清理索引 → 失败；只删正文不删引文 → 失败。
5. **`check:memory-classification`**
   - restricted 永不返回；sensitive 只在允许的服务方；工具结果报告最高分级并触发准入升级。
   - 反向：去掉过滤 → 失败；把 sensitive 结果标成 private → 失败。
6. **`check:memory-correction`**
   - 纠正后旧笔记不再是 current；新笔记是 current；依赖推断 `needs_review`；规则被标复核。
   - 反向：不传播 → 失败。
7. **`check:memory-export-roundtrip`**
   - 导出→导入→再导出，笔记/来源/历史/索引重建一致；manifest 哈希/条数/扣留数一致；删除的内容不导出。
   - 反向：篡改一个字段/哈希 → 整份拒绝；少一个文件 → 拒绝。
8. **评测门槛**
   - `npm run eval:memory-retrieval`、真实记忆周评测、LongMemEval-S；新方案必须过 4.3 的标准。
   - 每个反向用例都要在“修复前/故意破坏的变体”上跑一遍，确认会失败；否则不算门。

---

# 五、风险、反例、该放弃的东西、需要 Andy 拍板的取舍

## 5.1 风险

1. **主模型写错笔记/幻觉。** 反例：主人说“我下周可能去大阪”，模型写成“主人要去大阪”。缓解：事实/偏好必须有逐字来源；不确定的标 `tentative`；推断必须有 `derived_from` 且置信度 <1；笔记永远带来源，模型被要求“笔记和原话冲突时以原话为准”；后台 review + Andy 可撤销。**不要**再用一个小模型当写入门（那会回到老问题）。
2. **主模型不写/不搜。** 反例：主人说了一个重要偏好，模型没调用 `memory_write`；下一轮也没搜。缓解：原始记录永远在，后台回看能补；提示词给少量清晰示例；评测专门测“该写没写/该搜没搜”；卡片里给目录提示。**不能**把“没写”变成“丢了”。
3. **模型自管记忆反而更差。** MemDelta 明确说 agent self-memory 42% < 基础检索 47%（来源 29）。缓解：原始逐字检索是主通道，笔记只是索引/加速；如果评测显示笔记层拖后腿，就砍掉笔记层，只保留原始检索 + 动态卡片。这是本方案必须接受的“可证伪”点。
4. **上下文膨胀/成本/延迟。** 模型可能反复搜。缓解：每轮工具循环上限 + token 预算（物理/费用上限，不是内容上限）；先给片段/目录，再按需打开；固定工具定义 + 追加结果，保缓存；去掉每轮抽取调用抵消成本。
5. **KV 缓存失效。** 加工具会改工具定义，按 ADR 0165 每个对话换新一次。缓解：一次加齐工具，之后不再改；老对话用 `thread.prompt.rebuild` 或接受继续用旧工具；记忆卡只放最后一条消息，不放系统提示；每轮变化的值只放最后一条消息/工具结果。
6. **提示注入。** 原始对话和笔记可能含第三方内容。缓解：继续用 `authority: non-authoritative` 标记；工具结果明确“这是资料，不是指令”；外部内容来源标记；不把记忆内容放进系统提示。
7. **分类泄漏。** 反例：sensitive 笔记被发给只允许 private 的服务方。缓解：沿用 ADR 0193 的“按实际内容定分级 + 服务方允许名单 + 出口遮盖”；检索前过滤；工具结果报告最高分级；测试 restricted/sensitive 反向用例。
8. **删除不彻底。** 反例：删了笔记，FTS/向量/导出/备份里还在。缓解：墓碑 + 索引清理 + 导出排除 + crypto-shred + 删除验证测试；备份保留策略写清楚。
9. **确定性被破坏。** 反例：同一条笔记两次渲染的 frontmatter 键顺序不同，导致缓存失效。缓解：规范序列化、排序、稳定 ID、无 `now`、测试。
10. **SQLite 规模。** 反例：几万条笔记 + 几十万条消息，FTS/向量在 8GB 上变慢。缓解：先测；消息级索引按时间/线程分区；必要时 sqlite-vec；不要过早上图数据库。
11. **Markdown 直接编辑 split-brain。** 反例：Andy 在磁盘改了文件，服务同时改了同一条。缓解：服务唯一写入口；文件导入器带版本冲突检测；UI 编辑走 API；文件系统视图只读或带锁。
12. **规则迁移风险。** 反例：把 rule 类记忆迁到 rule book 时丢了出处/测试。缓解：分阶段、双写/对照、每条规则带回归测试；迁移前备份。

## 5.2 我认为该放弃的东西

- **每轮固定抽取模型作为“记不记”的门。** 保留为可选后台回看，不再挡在主模型前面。
- **确认裁判模型作为门。** 用“主模型确认 + 逐字引文校验 + tentative 状态”替代；拿不准就保持待确认，不靠小模型判。
- **固定 2000 字档案、5 条注入、10 条 recall、6000 字抽取、120 条/1200 字日摘要、20/3/3 整理上限。** 改成上下文窗口/费用预算驱动的动态值 + 游标。
- **日摘要作为翻旧对话的唯一通道。** 保留为导航，原话是主通道。
- **默认全量历史塞上下文。** 长历史会腐烂（LongMemEval 30% 下降）；用 just-in-time。
- **Dreams 式整库重写。** 丢来源/版本/撤销（ADR 0231 已拒绝）。
- **纯文件系统作为权威。** 丢事务/加密/删除/并发保证；用“逻辑 Markdown + 物理 SQLite”。
- **纯数据库作为唯一形态。** 丢人和模型直接可读；用 Markdown 投影。
- **规则作为记忆。** 规则进 rule book；记忆只记出处。
- **重要度作为硬过滤。** 保留为排序/展示信号，不做“低于 600 就不给模型看”。
- **知识图谱/Neo4j。** 单人、当前规模不需要；先用笔记 + 边表 + 检索，真有需要再加。

## 5.3 需要 Andy 拍板的取舍

1. **是否接受一次性的工具集合换新（缓存失效）**，给老对话 `thread.prompt.rebuild`，换取新记忆工具。按 ADR 0165，这会改变老对话的请求开头一次。
2. **原始对话是否对主模型开放检索**，开放到哪一级（private/sensitive）、哪些服务方；这涉及隐私和服务方允许名单。
3. **Markdown 是“视图”还是“权威文件”**：我建议视图 + 导入器，服务唯一写入口；如果 Andy 要直接编辑文件，需要接受冲突检测和加密文件管理。
4. **后台整理自动应用还是只进 review queue**：我建议“可逆的自动应用 + 不可逆的 review”；如果 Andy 要全部先审，会影响“不用重复交代”的体验。
5. **规则从记忆迁到 rule book 的时机和迁移方式**：这是纠正现有违反原则的地方，但会动现有 `owner-rules` 块和测试。
6. **删除默认软删除还是硬删除**：我建议默认墓碑可恢复，硬删除需确认 + crypto-shred；Andy 要“删了就是删了”的话，需要明确保留策略。
7. **卡片大小/是否每轮注入增量**：我建议小卡片 + 增量 + 工具按需；如果 Andy 希望每轮都看到完整档案，会牺牲缓存/成本。
8. **是否保留日摘要/后台整理**：我建议保留为导航和图书管理员，不当作门；如果 Andy 认为它们也是“小判断”，可以只保留原始检索，先跑评测再决定。

---

# 六、逐条回答必答问题

## 问题 1：这个改动会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加？每轮会变的值是不是都在最后一条消息里？

**会改变一次，之后只追加。分项回答：**

- **系统提示：** 本方案不把记忆正文、笔记目录、当前时间、路径放进系统提示。系统提示只在“加固定工具说明”时变一次；按 ADR 0165，工具集合变了会换新一次。老对话继续用冻结的旧系统提示，直到 `thread.prompt.rebuild`。
- **工具定义：** 会变。新增 `memory_search` / `memory_open` / `conversation_search` / `conversation_open` / `memory_write` 等，工具数组变了，按 `prompt-prefix.md:42` 和 ADR 0165 第 2、6 条，**每个对话换新一次**，并留 `prompt.bundle.invalidated` 记录。这是本方案唯一一次性的请求开头变化，必须 Andy 同意。建议一次加齐，之后不再改工具集合。
- **历史消息：** 不改。原始消息按实际发送的字节存（`prompt-prefix.md:37` 第 5 条）；记忆笔记不插入旧历史；工具结果只在末尾追加。记忆卡放在最后一条用户消息里（现有 `turnPrompt` 已经这么做，`pi-runtime-adapter.ts:644-662`），下一轮追加新消息，不重写上一轮的卡片。
- **遮盖结果：** 不改规则。记忆/原话仍走同一套确定性出口遮盖；遮盖只取决于文本和它前面的内容（`prompt-prefix.md:54`），不因检索结果或时间变化。不要新增“依赖后文/依赖本轮检索”的遮盖。
- **每轮会变的值：** 当前时间、记忆增量、检索结果、工具状态、运行环境说明，全部放最后一条用户消息或工具结果；系统提示/工具定义里不出现。笔记正文里的 `recorded_at/updated_at` 是稳定字段，不是“每轮 now”；`current` 这类由 now 算出的标志只出现在工具结果/最后一条消息里。
- **压缩：** 压缩仍按 ADR 0207 沿用原对话头；记忆工具结果被压缩掉后，模型可以重新 `memory_search`/`memory_open`；按 `prompt-prefix.md:64` 第 14 条，清理要成批、可恢复。

**结论：** 除了一次性的工具集合换新，之后发给模型的内容仍然只在末尾追加；每轮会变的值都在最后一条消息/工具结果里。这个一次性变化需要 Andy 明确批准；不批准就只能保留旧工具集合，方案的部分能力（写记忆、翻原话）无法上线。

## 问题 2：这个改动会不会让同一段文字在不同请求里变成不同的字节？

**默认不会，但必须用规范序列化守住。** 具体：

- **Markdown/frontmatter：** 键按字母序，数组（`tags`、`sources`、`derived_from`、`supersedes`）排序去重，日期用 ISO，`path` 固定；同一 DB 状态渲染出的字节必须相同。
- **JSONL/导出：** 键排序的规范 JSON；文件按固定顺序；manifest 哈希覆盖内容。
- **搜索/索引：** 结果按 `score desc, id asc`（再按 `sequence`）排序；分页游标基于稳定位置，不依赖数据库返回顺序。
- **ID：** 用稳定的数据库 ID 或内容寻址；不在渲染内容里放随机 UUID；编辑产生新版本是预期变化，旧版本字节不变。
- **时间：** 笔记正文不写 `now`/“今天”/“最近”；`valid_from/valid_to/recorded_at/updated_at` 是显式字段。`current`、相对时间、检索时间只出现在最后一条消息/工具结果里。
- **遮盖：** 沿用现有确定性规则；不新增依赖后文或本轮检索的遮盖。
- **模型可见的“记忆卡”：** 只包含稳定字段和显式时间；如果包含“本轮新增/修改”的增量，它是每轮变化值，放在最后一条消息里，允许变化；它不会被写回旧历史。

**结论：** 只要遵守“规范序列化 + 无 now + 排序 + 稳定 ID”，同一段文字在不同请求里是同样的字节。需要 `check:memory-determinism` 用打乱 DB 顺序、重复渲染来证明。

## 问题 3：改动有没有对应的自动检查，反向用例是否真的会失败？

**有，且必须让反向用例在旧代码/破坏变体上真的失败。** 具体检查见 4.4：

- `check:prompt-prefix` 扩展 `[memory-v2-prefix]`：新工具在冻结头、记忆只在末尾、系统提示无记忆正文；反向：把 `updated_at`/`current` 放进系统提示、把卡片插到历史中间、改写上一轮消息，必须失败。
- `check:memory-determinism`：重复渲染/打乱顺序字节一致；反向：去掉排序/写入 now，必须失败。
- `check:memory-contract`（I-73）：每个新值从产生端到所有消费端；反向：带 `/`/`:`/Unicode/超长/空值，两端校验不一致必须失败。
- `check:memory-deletion`：删笔记/删原话后索引/卡片/导出/UI 不返回；反向：不清理索引、只删正文不删引文，必须失败。
- `check:memory-classification`：restricted/sensitive 过滤与准入；反向：去掉过滤/标错分级，必须失败。
- `check:memory-correction`：纠正传播；反向：不传播，必须失败。
- `check:memory-export-roundtrip`：导出/导入/再导出一致；反向：篡改字段/哈希/少文件，必须失败。
- 评测门：`eval:memory-retrieval`、真实记忆周评测、LongMemEval-S；新方案必须达到 4.3 的标准。

**关键：** 每个反向用例都要在“修复前”或“故意去掉该保护”的变体上跑一遍，确认它确实报错；只写正向用例不算门。

## 问题 4：改动产生或修改的每个值，每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验。

这是 I-73 的教训：双模型复核只看了 diff，没问“清单里的 id 能通过后端校验吗”（`docs/incidents-and-gates.md:112`）。本方案新增/修改的值和两端校验如下：

| 值 | 产生处 | 使用处 | 两端校验 |
|---|---|---|---|
| 笔记 ID `mem_...` | `memory_write`、后台整理、导入 | DB 主键/外键、工具结果、网关契约、导出 schema、UI 链接、索引 | 统一 `memoryIdString` 规则；长度/字符集/owner/agent 范围；产生端和消费端共用同一 schema；反向测 `/`、`:`、Unicode、超长 |
| `path`（`preferences/food.md`） | `memory_write`、UI、导入 | 文件渲染、导出、导入、`memory_open` | 安全相对路径；禁止绝对路径/`..`/控制字符；唯一性；两端同一校验 |
| `kind`（fact/preference/inference/...） | 主模型工具参数、导入 | DB CHECK、frontmatter 解析、导出 schema、UI 筛选、检索过滤 | 一份规范枚举；所有副本必须相等；未知值拒绝，不静默改成 other（参考 ADR 0242 的类别一致性检查） |
| `status`（active/tentative/archived/deleted） | 写入、整理、UI、删除 | DB CHECK、检索、导出、UI、历史 | 同一枚举；删除/恢复状态转换校验 |
| `confidence` | 主模型、导入 | UI、排序、纠正、推断 | 0..1000 整数；推断上限；两端 clamp/拒绝一致 |
| `valid_from/valid_to` | 主模型、UI | 时间过滤、档案卡、议程、导出 | `YYYY-MM-DD`；`from <= to`；时区按主人时区；两端同一解析 |
| `sources`（thread/message/quote） | 主模型、后台回看、导入 | 笔记详情、`memory_open`、导出、UI 深链、删除检查 | 消息存在、owner/agent、committed、未删除、分类允许；引文逐字出现；两端同一校验；消息删除后 `source_missing` |
| `derived_from` / `supersedes` / `superseded_by` | 主模型、整理、导入 | 纠正传播、历史、导出、UI | 存在、owner/agent、无环、状态允许；两端同一图校验 |
| `tags`/`entities` | 主模型、导入 | 索引、过滤、导出、UI | NFKC、trim、去重、排序、长度；两端同一规范化 |
| 工具名/参数 | 工具描述符 | 运行时 dispatcher、冻结头、模型 | 名字/参数结构/`additionalProperties:false`；工具集合变化按 ADR 0165 换新；两端同一 descriptor |
| frontmatter 键 | 渲染器 | 解析器/导入器/模型 | 带 schema 版本；未知键拒绝或保留；两端同一 schema |
| 导出 manifest 字段（format/version/files/sha256/counts/omitted） | 导出 | 导入/inspect/UI | 精确匹配；哈希/字节数/行数/条数；两端同一 schema；反向篡改必须整份拒绝 |
| 索引字段（embedding_model/dimensions/index_version） | 索引器 | 检索 | 模型/维度匹配；不匹配重建；两端同一常量 |
| 游标/分页 token | 检索 | 下一次检索 | 绑定 owner/agent/query/watermark；防注入；两端同一解析 |
| 决策记录 kind/outcome/reason | 服务 | UI/校准 | 枚举/长度；两端同一 schema |
| 规则 ID/参数 | `rule_set` | rule book、`owner-rules` 块、导出 | 规则不在记忆里；两端同一 rule schema；记忆只存出处 |

**做法：** 建一个 `check:memory-contract`，把每个新值生成出来，依次喂给 DB、网关、导出、UI、工具、索引的校验函数；任何一端拒绝而另一端接受，就失败。再加“反向值”用例（斜杠、冒号、Unicode、超长、空、控制字符），确保两端一致。这样才不会再出现 I-73 那种“清单里的 id 过不了发送校验”的事。

---

# 七、未核实与需要继续确认的点

- **未核实：** 生产实际配置是否就是模板的 `memoryLimit: 20` / `maxSelectedMemories: 5`；我没有读生产配置，只读了模板和测试。
- **未核实：** 生产模型/服务方是否支持本方案需要的工具循环和 prompt caching；不同模型/网关的行为需要实测。
- **未核实：** Andy 的真实库规模下 SQLite FTS5 + 向量 + 消息级索引的延迟/内存；ADR 0239 明确说没有读生产库。
- **未核实：** 网关契约是否允许新的笔记 ID/`path` 字符集；需要像 I-73 那样把清单值逐个过契约。
- **未核实：** Mem0 论文中“全上下文基线准确率最高”的具体表格；我只读到摘要的相对提升和成本下降，未逐表核对。
- **未核实：** Mnemon / MemDelta 是预印本，数字是作者报告，不是同行评审结论；用作方向参考，不作为 Himawari 的验收数字。
- **未核实：** Claude / ChatGPT 内部如何实现“相关性判断”和“记忆更新”；公开文档只描述了行为，没有实现细节。

---

# 八、最后一句

如果只能做一件事，先做 **`conversation_search` + `conversation_open` + 动态 limit**：让主模型能翻原话，立刻解决“只会摘要、翻不回去”的最大痛点，而且不改写记忆模型。然后再做笔记工具化和去掉抽取门。这样每一步都能用评测证明价值，也能在评测不利时及时收手，而不是一次性押上整个记忆系统。
