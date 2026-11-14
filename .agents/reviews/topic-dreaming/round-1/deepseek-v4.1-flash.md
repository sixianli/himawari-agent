## 结论

**做，但只做一部分：做“按日摘要窗口的离线回看”，不做 Anthropic 那种“读全部聊天、重写整个记忆库”的完整 dreaming。**

核心判断：

- 每轮抽取只看主人这一条消息加上一轮回答末尾 1500 字，跨天、跨轮才显露的信息确实会漏（`apps/agent-service/src/production-memory-capture.ts:62,189-190,752-755`）。
- 每天整理只拿“上次整理后新记下的记忆，最多 20 条”，每条最多 3 个邻居，不读对话原文（`packages/memory-engine/src/consolidation.ts:35-39,245-252`）。所以“新说法没被每轮抽取记下”时，整理也发现不了。
- 但现有“对话日摘要”（episodes）已经按天保存了每段对话的摘要（`packages/memory-engine/src/episodes.ts:21-25,85-103`），是现成的、已经付过费的证据层。再做一套读全部原文的 dreaming，既贵又与现有整理冲突。

因此我建议：**以 episodes 为窗口，读窗口内的主人原文做引用校验，产出的变更走现有每日整理的事务、依据链和撤销路径；不确定的冲突两条都留，不直接重写；不新增 dreaming 服务、不新增动作类型、不新增第二套记忆库。**

---

## 一、方案依赖的前提

### 产品与规则（已读代码/文档证实）

1. 原则冲突顺序：`docs/product-vision.md:55`
   > “原则冲突时，按序优先：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。”

2. 存下的记忆必须能被模型看到；产品功能尽量不让主人逐条确认：`docs/adr/0193-memory-is-visible-to-the-model.md:56,69`
   > “模型能看到什么”由固定的模型可见上限决定，上限是 sensitive……restricted 永远不给模型。
   > “敏感记忆每次给模型前先问主人。Andy 2026-11-07 的要求是产品功能尽量不让他人工介入；他已经在名单这一处一次性同意，不再逐条确认。”

3. 发给模型的内容只追加，固定的在前、会变的在最后一条消息：`.claude/rules/prompt-prefix.md:27-29,35-36`
   > “顺序是：工具定义 → 系统提示 → 历史 → 最后一条用户消息。”
   > “已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。”
   > “存历史时存实际发出去的那一条。”

4. 后台调用同样固定指令在前、本次数据在后、当前时间最后：`.claude/rules/prompt-prefix.md:67-68`
   > “后台调用也是固定的在前、会变的在后。整理记忆、判断邮件、起对话标题这类调用，先放固定的指令，再放这次的数据，最后放当前时间这类每次都变的值。”

5. 当前聊天把资料和记忆拼在最后一条用户消息里：`packages/runtime-pi/src/pi-runtime-adapter.ts:623-641`
   > `turnPrompt()` 依次放 `<himawari-context>`、时间、资料块、运行环境，再放 `<owner-message>`。
   `packages/prompt-catalog/src/runtime.ts:3-9` 的说明也写明“以下是系统为本轮附上的时间和资料”。记忆日期同样标为 `last-user-message`（`packages/prompt-catalog/src/memory.ts:123-127`）。

6. 当前每轮抽取的上下文很窄：`production-memory-capture.ts:62,189-190,752-755`
   > `const MAXIMUM_CONTEXT_CHARACTERS = 1500;`
   > `previousAssistantMessage?.slice(-MAXIMUM_CONTEXT_CHARACTERS) ?? null`

7. 当前每日整理只看新记忆，不读原文：`consolidation.ts:35-39,245-252`
   > `MAXIMUM_FRESH = 20`、`MAXIMUM_NEIGHBOURS = 3`、`MAXIMUM_INSIGHTS = 3`；`fresh` 来自 `state.listActive()`，再按 `updatedAt` 过滤。

8. 对话日摘要按天、按线程生成，单条消息截 1500 字、整段最多 16000 字；摘要提示词要求 300 字，但代码上限是 1200 字符：`episodes.ts:21-25,85-103`、`packages/prompt-catalog/src/memory.ts:54-65`
   > `MAXIMUM_MESSAGE_CHARACTERS = 1500`、`MAXIMUM_TRANSCRIPT_CHARACTERS = 16000`、`MAXIMUM_SUMMARY_CHARACTERS = 1200`；提示词写“最多 300 字”。

9. 久不用不再自动归档；合并重复、新事实取代旧事实保留：`docs/adr/0196-index-sensitive-memory-after-masking-and-stop-idle-archiving.md:60`
   > “记忆整理不再因为久没用到就归档；合并重复、新事实取代旧事实这两种归档保留。”

10. 整理改动、依据行、决策记录在同一事务写，可撤销：`docs/adr/0194-record-the-whole-basis-chain-of-a-memory-tidy-up.md:39-42`
    > “改记忆、变更行、依据行、决策记录在同一个事务里写……事务里任何一步失败，记忆和决策记录都不变。”

11. 记忆可恢复到任意版本：`docs/adr/0217-restore-memory-to-any-version.md:36-41`
    > “只能恢复到‘当前生效的那条记忆’……变化记录里每一行用表里已有的行号作版本编号……旧历史一条不删。”

12. 价格假设：`docs/adr/0207-compaction-request-reuses-conversation-head.md:41`
    > “DeepSeek 价格每百万 token：缓存命中 $0.003，未命中 $0.15……输出约 $0.6。”

13. 档案块只有 2000 字，待确认记忆不进档案：`packages/application/src/services/owner-profile-service.ts:14,110`
    > `OWNER_PROFILE_CHARACTER_BUDGET = 2000`；`tentative === true` 不进入 profile。

14. 敏感候选默认走审批，不静默提交：`packages/application/src/services/automatic-memory-service.ts:169-188`
    > `if (isSensitive(candidate) && !explicitlyApproved) { ... requestApproval ... }`

15. 整理动作在数据库和契约里是封闭枚举：`packages/persistence-sqlite/src/migrations/0054_memory_consolidation.sql:26`、`packages/application/src/ports/memory-consolidation.ts:4`、`packages/persistence-sqlite/src/data-export/schemas.ts:171`、`packages/gateway-contracts/src/contracts-v2.ts:989,1118,1225`
    > `CHECK (action IN ('merge', 'supersede', 'archive', 'reflect'))`，四处都是同一组值。

16. 记忆投影任务对 generation 有硬外键：`packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:381-390,418-422`
    > `memory_generations.id` 要求先有 `thread_checkpoint_jobs`；`memory_projection_jobs.generation_id` 外键指向 `memory_generations(id)`。
    这意味着**不能给新记忆随便编一个 generation id**，必须走现有 `generations.request` 生成真实 generation。

### 业界一手来源

17. Anthropic Dreams：<https://platform.claude.com/docs/en/managed-agents/dreams>
    > “The input store is never modified, so you can review the output and discard it if you don’t like the result.”
    > “A dream reads an existing memory store alongside past session transcripts… duplicates merged, stale or contradicted entries replaced with the latest value, and new insights surfaced.”
    > “Cost scales roughly linearly with the number and length of input sessions.”

18. Anthropic 研究文章：<https://www.anthropic.com/research/components-of-agent-memory>
    > “Dreaming is one way to fix these mistakes… it requires compute. Directing Claude to continuously check all its memories might not be practical. It may be important instead to focus dreaming on information that’s likely to change or to carefully tune the cadence of dreaming.”
    > “The top layer of the memory hierarchy has to stay relatively small.”

19. Anthropic Cookbook：<https://platform.claude.com/cookbook/managed-agents-cma-dreaming-with-a-dynamic-workflow>
    按题目材料：每段对话一个小模型分析者，最后一个整理者合并；每晚 cron，只处理上次成功之后的对话，失败的那晚保留窗口重试；默认不经人审直接改库，文档自己写了“坏对话第二天早上就会进记忆”。

20. Letta：<https://docs.letta.com/guides/agents/sleep-time-agents>
    > “Dreaming uses background subagents to review recent conversations, consolidate useful lessons, and update memory without interrupting your active work.”
    > “Choose when it runs: after a set number of completed agent steps or when the context window is compacted.”
    > “Select Agent reviews before applying… This uses more model tokens and does not ask you for approval.”

21. Graphiti：<https://github.com/getzep/graphiti>，材料所述 `resolve_edge_contradictions` 与 `prompts/dedupe_edges.py`：只有“新旧不能同时为真”才算矛盾，进展、状态更新不算。

22. mem0：<https://github.com/mem0ai/mem0>，材料所述最新版写入时只做 ADD（`ADDITIVE_EXTRACTION_PROMPT`），旧的 UPDATE/DELETE 判断仍在代码里。

23. ChatGPT：<https://help.openai.com/en/articles/8590148-memory-faq>；Gemini：<https://blog.google/innovation-and-ai/products/gemini-app/switch-to-gemini-app/>；Copilot：<https://support.microsoft.com/en-us/microsoft-365-copilot/personalize-what-microsoft-365-copilot-remembers>。这些是产品行为说明，不是架构实现。

---

## 二、方案

### 2.1 什么时候跑

复用现有每日整理，不新开调度器：

- 触发点仍是当天第一轮对话后的 `ProductionMemoryConsolidation.start()`（`apps/agent-service/src/production-memory-consolidation.ts:63-85`；`production-titled-runtime.ts:37-49` 先做抽取、日摘要，再整理）。
- 同一主人、同一 Agent、同一当地日只跑一次；失败沿用现有 1 小时重试、下一天重跑。
- 回看窗口：`createdAt` 晚于上次成功整理 run 的 `startedAt`、且已经闭段的 episodes；按 `(day, threadId, firstSequence)` 排序，最多 `MAXIMUM_REFLECTION_EPISODES`（建议 20）或 token 预算上限。
- **不新增游标列**：用上次成功 run 的 `startedAt` 当窗口水位（`sqlite-memory-consolidation-operations.ts:188-200` 已有 `lastCompleted`）。失败不推进水位；重复处理由下面的幂等机制挡住。
- 如果给 `memory_consolidation_runs` 新增“episodeReviewedThrough”列，必须同步改 `data-export/snapshot.ts:103`、`export.ts:316`、`schemas.ts:159`、`import.ts:433`、`verify.ts:99`，还要考虑旧导出兼容。**v1 不建议加列。**

### 2.2 读什么

**不读全部历史，也不只读摘要。**

- 用**已闭段的 episode 作为窗口和索引**：知道哪一天、哪个线程、哪段 sequence 值得看。
- 对窗口内每个 episode，读它 `firstSequence..lastSequence` 的**主人原文**（`threads.listMessages`），单条截 1500 字、整批总预算 16000 字；只用主人消息作为证据，助手消息最多作为上下文且明确“不可从中抽取记忆”。
- 已有记忆只取相关的：用 episode 文本检索 top-K（混合检索），加上同日新记忆、同 category/subCategory 邻居；按 `(score, id)` 稳定排序，最多 20-30 条。
- 敏感/受限按现有规则：`isModelVisible` 之外的不要；restricted 一律不进来。
- prompt 顺序遵守规则：**固定指令 + 输出格式在前，episodes/原文/记忆在后，当地日期放最后**。不要用“现在几点几分”这种会进入记忆正文的值。

### 2.3 产出什么

模型只输出“候选变更”，不直接写库：

- `additions`：新的长期事实、偏好、长期计划进展。每条必须带：
  - `anchorEpisode`：来自输入集合；
  - `quote`：主人原文里的原话；
  - `validFrom`：按该消息的 `committedAt`/episode 的 `day` 换算成 `YYYY-MM-DD`，不是回看运行日；
  - `confidence`、`category`、`importance`、`text`。
- `corrections`：针对某条已有记忆的新说法，带目标 `memoryId`、新正文、anchor、quote、`observedAt`。
- `duplicates`：与已有记忆重复，只记录证据，不新建。
- `noop`：没有值得记的。

硬规则：

- 行为/习惯类结论（“主人最近在学西班牙语”“每天晨跑”）要求**至少两个不同日期的 episode**支持，或主人明确说“以后都这样/记住”。
- 单条一次性事件（“今天买了饭团”）不记。
- 不从助手的话、摘要的概括、模型的推测里提取事实。
- 健康、财务、宗教、政治、他人隐私不推断；敏感候选不在回看里自动创建，走现有审批或先挂起。

### 2.4 怎么落库、怎么撤销

- 复用现有整理写入路径：`MemoryConsolidationService` + `DurableMemoryService.applyProposal/revise`，每次变更写 `memory_consolidation_changes`、依据行、决策记录（ADR 0194）。
- 新建记忆复用已有动作 `reflect`，但 `inference` 按证据决定：单条主人原话且 quote 校验通过 -> `inference: false`；多段摘要归纳 -> `inference: true`、低置信度、`tentative: true`。这样**不新增 `dream` 动作**，避免迁移、导出、UI、撤销逻辑全线改。
- 取代旧条时，先创建新记忆，再用现有 `#supersede` 记录旧条变更。不要用 `applyProposal(create + supersedes)` 直接完成，因为 `DurableMemoryService` 内部的 `supersede()` 不会传整理回调（`durable-memory-service.ts:162,520-555`），旧条的取代不会进 `memory_consolidation_changes`，就失去整理撤销和依据链。
- 新记忆的 generation 必须真实存在：对 anchor 线程调用现有 `generations.request`，创建 `thread_checkpoint_jobs` + `memory_generations`，再用它的 generation id。**不要编造 generation id**，否则 `memory_projection_jobs.generation_id` 外键会拒绝（`0001_initial_product_schema.sql:418-422`）。
- quote 用现有内容存储写 `quoteRef`，让 P4-6 以后还能核对原话。
- `sourceRefs` 只放真实主人消息的 `contentRef`；**不要把 episode id 塞进 `sourceRefs`**，因为 `production-run-memory.ts:384` 直接把 `sourceRefs[0]` 当来源引用用，`production-memory-control.ts:112-123,448-456` 也按消息 ref 查原话。episode id 只在本次运行内使用，不作为持久化字段。
- 撤销：记忆页现有 tidy-up 撤销即可。`reflect` 新建的撤销后归档；`supersede` 撤销后恢复 `supersededBy`/`validTo`；已改过的记忆拒绝撤销（`MEMORY_CHANGED_AFTER_CONSOLIDATION`，现有测试已覆盖）。ADR 0217 还允许恢复到任意版本。
- 不需要新的主人确认 UI。可疑的、两条都留的，交给 P4-6 的“两条说法不一样/置信度低”类，不新增打扰。

### 2.5 防误改、误记

- **原话校验**：候选的 `quote` 必须在该 episode 的主人原文中按现有 `quoteFromOwnerMessage` 的归一化方式找到；找不到就拒绝并记 `evidence_unverified`。
- **日期校验**：`validFrom` 只能来自证据消息的日期；没有绝对日期的冲突不取代，只挂起。
- **冲突门槛**：沿用 P3-8：只有“新条更晚且置信度 ≥ 门槛”才取代；否则新条存为待确认、两条都留，记 hold。没有日期或拿不准时一律 hold。
- **旧条永不仅因“旧/久不用”被归档**（ADR 0196）。
- **数量上限**：每天最多新增 3-5 条；不自动置顶、不自动进档案块；重要度由模型给但服务端 clamp，防止把 2000 字档案预算挤爆。
- **并发**：模型思考期间主人改了记忆，版本号冲突就跳过（现有测试“skips a memory the Owner edited while the model was thinking”已覆盖）。
- **敏感**：沿用现有遮盖、分类、服务方允许名单；回看 prompt 里先遮盖再发；restricted 不发给模型。

### 2.6 防重复处理

- 窗口由“上次成功 run 的 startedAt”决定；失败不推进。
- 同一天 run id 固定；模型输出先落到按 run id 命名的受保护 payload，重试时**复用同一份输出**，不再调用模型。
- 新记忆 id 用现有 `memory:${generation}:${ordinal}`，重试时同一 ordinal 得到同一 id；`applyProposal` 遇到内容相同的 create 会直接返回（`durable-memory-service.ts:122-137`），不会重复。
- 成功应用后才算本次窗口完成；中途失败下一天重跑，已应用的变更因状态/版本/相同内容被跳过。

### 2.7 和 P3-5、P3-8、P4-6、P3-6 的分工

- **P3-5（抽取失败重试/补做）**：不冲突。P3-5 补同一轮的抽取；回看是下一日从 episode 兜底。回看不做“补做同一轮”的写入，避免双写。
- **P3-8（冲突先 hold）**：**必须共用同一套门槛**。回看不自己写新的冲突判断；如果 P3-8 还没合，就先把 P3-8 的门槛抽成共享函数，两边调用。否则会出现“每日整理 hold、回看直接 supersede”的两套逻辑。
- **P4-6（每周记忆体检）**：回看产生的 tentative/hold 正好喂给 P4-6 的“两条说法不一样”“置信度低”两类；不再新增主人确认入口。P4-6 仍按它自己的每周节奏跑，回看不依赖它。
- **P3-6（Gmail 带最近两天 episode）**：两者都读 episode，但回看不生成 episode、不改 Gmail 检查；只读已生成的 episode，顺序上放在 episode 生成之后即可。没有重复写入。

### 2.8 每天费用估算

假设：1 个主人、1-3 个活跃线程、每天 30 条主人消息、每天 3 个闭段 episode；episode 摘要 300-1200 字；回看读窗口内主人原文约 3-9k 字；相关记忆 20-30 条；每天 1 次模型调用；输出 1-2k token。

- 典型输入 8-12k token、输出 1.5k token：
  - 输入：10k × $0.15/M ≈ $0.0015
  - 输出：1.5k × $0.6/M ≈ $0.0009
  - 合计约 **$0.0024/天，约 $0.07/月**（按 30 个活跃日）。
- 10 倍对话量（30 个 episode、60 条记忆、约 25k 输入、3k 输出）：
  - 约 **$0.0055/天，约 $0.17/月**。
- 最坏情况：20 个 episode 上限、40 条记忆、2 次重试，约 **$0.01-0.02/天，不到 $0.6/月**。
- 对比：Cookbook 的 11 段对话约 $0.36 是用 Haiku/Sonnet 的价格；DeepSeek 按 ADR 0207 的价格便宜一个量级。我们不重写整库，只读窗口内主人原文，费用主要由 episode 数和原文长度线性增长。

控制上限：

- 每天最多 1 次运行；无新闭段 episode 不调用模型。
- 每次最多 20 个 episode / 16000 字原文 / 30 条记忆 / 4k 输出 token。
- 先做低成本的确定性预筛（无实质内容、纯事务性对话直接跳过），预筛不过不调模型。
- 走现有预算准入；每次记录 token 和费用，超过日预算就停，等下一天。
- 不建议为了“省钱”把回看改成每轮都跑；每轮跑会把成本乘上轮数，且每轮 prompt 都在变。

### 2.9 验收（含反向用例）

正向：

1. 连续两天 episode 都提到“开始学西班牙语”，回看生成 1 条长期记忆，带 anchor 和原话；下一轮模型在最后一条消息里能看到。
2. 旧记忆“住在东京”，新 episode 说“11 月 1 日搬到 Osaka”，回看把旧条标 `validTo`、新条 active；recall 里旧条标历史。
3. 新旧说法矛盾但新说法日期/置信度不够：新条 tentative，旧条仍 active，记一条 hold，两条都能被 recall 看到。
4. 重复说法：不新增第二条，只记录证据。
5. 回看产生的变更能在记忆页逐条撤销；撤销 `reflect` 会归档新条，撤销 `supersede` 会恢复旧条的 `supersededBy`/`validTo`。

反向：

1. “今天买了饭团”这种一次性事件 -> 不记。
2. “你记得我喜欢咖啡吗？”这种问句 -> 不改旧记忆。
3. 助手在 episode 里说“主人住在 Osaka”，主人原文没说 -> 原话校验失败，拒绝。
4. 模型给出的 quote 是改写/概括 -> 拒绝。
5. 密码、验证码、密钥 -> 不自动创建 sensitive 记忆，不进明文索引，不发给不允许的服务方。
6. 健康/财务/宗教/政治/他人隐私推断 -> 拒绝。
7. 同一窗口重跑、失败后重试 -> 不产生重复记忆。
8. 主人在模型思考时改了记忆 -> 版本冲突，跳过。
9. 半年没用的旧记忆 -> 不因“久不用”被归档。
10. 回看只改变记忆、不改变聊天请求开头：对同一个对话，回看前后下一轮请求除最后一条用户消息外逐字节相同；`npm run check:prompt-prefix` 通过。

反向用例必须“去掉防护就失败”：去掉 quote 校验，第 3/4 条失败；去掉窗口水位，第 7 条失败；去掉 P3-8 门槛，第 3 条失败；去掉敏感跳过，第 5 条失败；把记忆写进历史中段而不是最后一条消息，第 10 条失败。仓库 ADR 已有“去掉修复后 N 条失败”的写法，按同样方式登记。

**本次没有运行测试**，以上是设计；具体新用例尚未写。

### 2.10 更好的、不在这几家做法里的思路

两个可选增量，不放进 v1 主路径：

1. **证据累积/晋升阶梯**：不把“回看一次”直接变成记忆，而是把候选 claim 作为“证据”暂存；同一条 claim 在 ≥2 个不同日期出现，或主人明确说“记住/以后都这样”，才晋升为正式记忆；否则只作为 recall 的线索。这样“跨几天才显露”的信息会被自然累积，而一次性噪声不会进档案。代价是要有 claim 归一化和暂存区；v1 可以先用 decision ledger 或受保护 payload 暂存，不新建表。
2. **影子模式上线**：先跑 2-4 周，只记录“本来会改什么”和依据，不实际应用；用 P4-6 的评分/主人撤销记录对比精度，再打开自动应用。它不让主人多做操作，但能先量化误改率。Anthropic Dreams 的“输出库先给人看”思路类似，但我们改成“影子决策记录”，不引入第二套记忆库。

---

## 三、考虑过但不选的做法

1. **完整 Anthropic Dreams：读全部历史、生成新记忆库、原库不动**
   - 不选：Himawari 只有一个权威记忆源，主人不会用 AI 工具去审一个新库；两套库会让 recall、档案、撤销、导出全部复杂化。我们采用“候选 + 现有库内可撤销变更”，保留“输入不被直接重写”的精神，但不做第二套库。

2. **每晚读全部对话原文**
   - 不选：成本随聊天量线性增长，且与每轮抽取重复；Anthropic 研究文章自己也说“持续检查全部记忆可能不现实”。我们用 episode 窗口 + 主人原文引用校验，读得少但证据够。

3. **只读日摘要，不读原文**
   - 不选：摘要会丢细节、会混入助手措辞，无法做原话校验，容易把“可能”记成“确定”。原文只在窗口内读，成本可控。

4. **新增 `dream` 动作 / 新表 / 新 UI**
   - 不选：`action` 在数据库 CHECK、端口类型、导出 schema、网关契约、UI 文案、撤销逻辑里都是封闭枚举（见前提 15）。新增一个值要同时改这些地方，容易重演 I-73“清单里的 id 过不了后端校验”。v1 复用 `reflect`/`supersede`。

5. **让回看直接 supersede，不经过 P3-8 门槛**
   - 不选：会和 P3-8 形成两套冲突逻辑；且模型无法可靠判断“新说法是否真的推翻旧说法”。必须共用门槛，拿不准就 hold。

6. **每轮把上下文加长来补跨轮信息**
   - 不选：每轮都付 token，且仍然跨不了多天；回看按天批处理更便宜。

7. **久不用就归档 / 每周全库扫描**
   - 不选：ADR 0196 已停掉；全库扫描成本高、收益低。

8. **自动把回看结论提升到“每次会话开头加载”的档案层**
   - 不选：Anthropic 明确说顶层要小，错误笔记会被带进每次会话；现有档案只有 2000 字。回看只产生普通记忆，靠重要度和现有预算自然进入，不自动置顶。

---

## 四、风险和反例

1. **摘要/助手内容污染**：episode 摘要里可能有助手说的“你住在 Osaka”。如果只读摘要，会把助手的话记成主人的。对策：证据必须是主人原文，quote 校验；反例 3/4。
2. **相对日期漂移**：同一段对话在不同日期回看，“上周”会变成不同日期，导致同一记忆文本不同字节。对策：只接受绝对日期；`validFrom` 用消息日期；当前日期只放 prompt 最后，不进记忆正文。
3. **无日期冲突**：模型说“主人现在不喜欢咖啡”，但旧记忆没有日期、新证据也说不清时间。对策：不 supersede，两条都留 + hold；反例 3。
4. **把进展当矛盾**：“正在学西班牙语”与“以前学法语”不是矛盾。对策：照 Graphiti 的规则，只有“不能同时为真”才算冲突；进展/状态更新只追加。
5. **问句/否定/条件句误判**：“你记得我喜欢咖啡吗”“如果我搬到 Osaka 的话”不是事实。对策：quote 必须包含完整命题；拿不准就 tentative/skip；反例 2。
6. **敏感信息进入明文索引**：回看读原文时可能带密码。对策：沿用现有遮盖和 `maskForIndex`，sensitive 不自动创建；反例 5。
7. **档案预算被挤爆**：一天新增太多低价值记忆，把档案里的重要条目挤掉。对策：每天最多 3-5 条、不自动置顶、重要度 clamp；档案仍按现有 2000 字预算选择。
8. **重试重复写入**：模型输出不稳定，重试产生第二条不同措辞的记忆。对策：stage 输出按 run id 复用、确定性 memory id、相同内容跳过；反例 7。
9. **主人并发编辑**：模型思考时主人改了记忆。对策：版本冲突跳过；反例 8。
10. **generation 外键失败**：给新记忆编造 generation id，投影任务写入失败，记忆看似创建但检索不到。对策：先 `generations.request` 建真实 generation；这是 I-73 类“两端校验不一致”的典型，必须先核对。

---

## 五、需要 Andy 拍板的取舍

1. **范围**：只做 episode 窗口 + 原文引用校验（推荐），还是坚持每晚读全部对话原文？后者成本和质量都要重新评估。
2. **自动应用还是先影子**：推荐先影子 2-4 周测误改率，再自动应用；但影子期不产生实际记忆，目标 1 会晚一点达成。
3. **敏感记忆**：v1 是否完全不在回看里自动创建（推荐），只走现有每轮抽取的审批？还是允许回看走同一审批队列（会给主人增加确认）。
4. **冲突门槛**：直接复用 P3-8 的 850，还是更严（例如 900）？以及“新条更晚”是否必须要求绝对日期。
5. **每日新增上限**：3 条还是 5 条；是否允许回看结果自动进入档案块（推荐不允许，靠重要度自然进入）。
6. **实现顺序**：是否等 P3-8 和 P4-6 合并后再做回看，避免两套冲突/体检逻辑；还是先做回看、P3-8 用共享函数后补。
7. **动作语义**：接受复用 `reflect`（UI 显示“归纳/整理新增”），还是坚持新增 `dream` 动作并承担迁移、导出、契约、UI 全套改动（不推荐）。

---

## 六、必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会，前提是不把回看结果写进系统提示、工具定义或历史中段。**

- 回看本身是后台调用，有自己的 prompt，不属于聊天请求的“已经发过的开头”。
- 回看产生的记忆只在**下一轮的最后一条用户消息**里出现：`turnPrompt()` 把资料块、记忆、时间都放在 `<himawari-context>`，再放 `<owner-message>`（`pi-runtime-adapter.ts:623-641`）；规则也要求每轮会变的值只放最后一条消息（`prompt-prefix.md:28`）。
- 系统提示和工具按对话冻结（`prompt-prefix.md:41-44`）；回看不改工具集合、不改系统提示、不改回答语言、不改数据分级，因此不触发换新。
- 历史消息保存的是实际发出去的那一条（`prompt-prefix.md:36`）；回看改了记忆，不会回头改写旧消息。
- 遮盖结果也不变：回看不改遮盖规则；聊天发送时仍按确定规则重新遮盖（`prompt-prefix.md:51-54`）。
- 唯一要注意：不要为了“通知模型回看完成了”在历史中间插 system 消息；如果确实要告诉模型，只能追加一条消息，或等下一轮最后一条消息。
- 结论：**发给模型的内容仍然只在末尾追加；每轮会变的值（时间、选中的记忆、运行环境、本轮资料）都在最后一条消息。** 需要用 `npm run check:prompt-prefix` 的 `[I-66]` 用例守住。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**按下面的设计不会；但当前代码里有两处排序没有 id 兜底，必须在回看里补上。**

风险点：

- 相对日期：如果模型把“上周”写进记忆，同一段对话隔几天回看会变成不同日期。对策：只接受绝对日期，`validFrom` 取消息日期，当前日期只放 prompt 末尾。
- 无序集合/数据库顺序：`confirmedFirstByRecency` 只按 `tentative`、`updatedAt` 排（`production-memory-capture.ts:52-59`）；整理的 `fresh` 只按 `updatedAt` 排（`consolidation.ts:250-252`）。`updatedAt` 相同或数据库返回顺序变化时，标签和 prompt 顺序会变。回看必须加 `id` 作为第二排序键，并固定 JSON 键顺序。
- 检索并列：相关记忆按分数排序时，同分要有 `id` 兜底（现有 recall 已有类似做法）。
- 遮盖：同一段文字、同一遮盖密钥、同一前文，遮出的字节相同；回看不要引入跨请求的“已见秘密集合”，每次按完整 prompt 固定顺序生成 placeholder 表（现有 `placeholderTable` 是每 prompt 确定的）。
- 重试：同一窗口重试不能重新让模型生成不同措辞；按 run id 暂存输出，重试复用。
- 记忆正文本身：一旦写入，后续轮次注入的是同一份字节；记忆被回看修改后，变化只发生在**之后**的最后一条消息里，不回头改写历史。

### 3. 有没有对应的自动检查，反向用例真的会失败？

有，分四层：

- **现有门槛**：`npm run check:prompt-prefix`（含 `[I-66]`、`[RULE-memory-visible]`）继续保证只追加、动态记忆只在最后一条消息、遮盖确定。回看新增 `[DREAM]` 用例：回看前后同一对话的下一轮请求，除最后一条用户消息外逐字节相同；把记忆写进历史中段，用例必须失败。
- **整理集成测试**：`test/integration/memory-consolidation.test.ts` 已覆盖 merge/supersede/keep、insight 过滤、撤销、主人并发修改、不同 subCategory 不分组。回看新增用例复用这些 fixture。
- **回看单元/集成测试**：正例 add/correct/duplicate/no-op；反例一次性事件、问句、助手来源、假 quote、敏感、健康/财务、重试重复、无日期冲突、旧记忆久不用。
- **契约/导出测试**：复用 `reflect`/`supersede` 后，动作枚举不用改；但仍要测 dream 产生的记忆能导出/导入、`memory.basis.read` 能读出依据、网关 overview 能接受 memoryId/sourceRefs、记忆页能撤销。

反向用例要按仓库惯例做“去掉防护就失败”的验证：去掉 quote 校验，假 quote 用例失败；去掉窗口水位，重试用例失败；去掉 P3-8 门槛，无日期冲突用例失败；去掉敏感跳过，密码用例失败；去掉最后一条消息注入，prefix 用例失败。

**本次没有运行这些测试**；P3-8/P4-6 还不在 main，相关用例要等对应分支或共享函数落地后才能跑。

### 4. 每个值的使用方都能接受吗？

按 v1“不新增动作、不新增持久化字段”的设计，逐个核对如下：

| 值 | 产生处 | 使用处/校验 | 结论 |
|---|---|---|---|
| `policyVersion = memory-reflection:v1` | 回看服务 | `memory_records.policy_version` 是 TEXT，无枚举；审计、checkpoint job；导出 schema `text(1,512)` | 可接受；若经网关暴露，`machineString` 也接受冒号/连字符 |
| `generationId` | 必须由 `generations.request` 创建 | `thread_checkpoint_jobs.generation_id`、`memory_generations.id`、`memory_projection_jobs.generation_id` 外键 | **不能编造**；必须先建真实 generation |
| `memoryId = memory:<generation>:<ordinal>` | `memoryIdFor` | 网关 `machineString`；导出 `text(1,512)`；历史/撤销/投影 | 现有格式，可接受 |
| `sourceRefs` | anchor 主人消息的 `contentRef` | 网关 `boundedString(512)`；`production-run-memory.ts:384` 取 `[0]`；`production-memory-control.ts:112-123` 按消息 ref 查原话；导出 `text(1,512)` | **只能放真实消息 ref，不能放 episode id** |
| `quoteRef` | 现有内容存储 | P4-6 核对原话、导出、历史 | 复用现有 key 格式即可 |
| `validFrom/validTo` | 证据消息日期、取代时间 | `memoryDatesOf` 只认 `YYYY-MM-DD` 或 ISO；导出 `text(1,40)` | 用日期形，别写相对时间 |
| `action` | `reflect` / `supersede` | DB CHECK、端口类型、导出 schema、网关枚举、UI 文案、撤销 | 复用现有值；**不要新增 `dream`** |
| `tentative/inference/confidence/importance` | 回看候选 | capture gate、recall、档案过滤、P4-6、导出 | 全部在现有 0-1000/布尔范围内 |
| `dataClassification` | 来源消息最高分级 | 准入允许名单、遮盖、索引、历史 | 沿用现有规则；sensitive 不自动创建 |
| episode 窗口水位 | 上次成功 run 的 `startedAt` | `lastCompleted`、下次窗口 | 不新增列；若要加列，必须同步改导出 snapshot/export/schema/import/verify |

特别提醒 I-73：如果为了“来源好看”把 episode id 加进 `sourceRefs`，`production-run-memory.ts:384` 会把它当来源引用，`production-memory-control.ts` 也找不到对应消息；如果新增 `dream` 动作，数据库 CHECK、端口类型、导出 schema、网关契约、UI 三处 i18n、撤销逻辑都要同步，少一处就会出现“清单里的值后端不接受”。**这就是为什么 v1 坚持复用现有值。**

---

## 七、你另外问的 6 个问题（简答）

1. **该不该做**：做一部分。做“episode 窗口 + 原文引用校验”的离线回看；不做整库重写、不做全量原文扫描。
2. **方案**：见第二节。触发复用每日整理；读闭段 episode + 窗口内主人原文 + 相关记忆；产出 additions/corrections/holds；走现有整理事务和撤销；不新增动作/表/UI；窗口水位 + stage 输出 + 确定性 id 防重复。
3. **和 P3-5/P3-8/P4-6/P3-6**：P3-5 互不依赖；P3-8 必须共用门槛；P4-6 接收 hold/tentative，不新增确认入口；P3-6 只共享 episode，不互相写。
4. **费用**：典型约 $0.0024/天、约 $0.07/月；10 倍量约 $0.17/月；最坏不到 $0.6/月。用每日 1 次、20 episodes、16k 字、30 条记忆、4k 输出封顶。
5. **验收**：见 2.9，正向 5 条、反向 10 条，外加“去掉防护就失败”的变异验证和 prefix 检查。
6. **更好的思路**：证据累积/晋升阶梯、影子模式上线；两者都不增加主人操作，但比“回看一次就写库”更稳。

---

## 八、哪些是证实的，哪些是推测/未核实

**读代码或来源证实：**

- 当前每轮抽取的 1500 字上下文、每日整理只看 20 条新记忆、episode 的 16000/1500/1200 上限。
- 记忆和资料在最后一条用户消息里；系统提示/工具按对话冻结；历史存实际发出的字节。
- 整理动作的封闭枚举、generation 外键、导出/网关的字段校验。
- `reflect` 的撤销语义、`supersede` 的 `validBefore` 恢复、档案 2000 字预算、tentative 不进档案。
- Anthropic Dreams 的输入库不改、输出独立、按 token 计费；Anthropic 研究文章说持续检查全部记忆不现实、顶层要小；Letta 的触发和“后台复核不询问用户”。

**推测/需要实测：**

- 回看模型能否稳定给出可校验的原话、能否可靠区分“矛盾/进展/问句”；需要小规模评测。
- 典型对话量、token 数、费用；我只按假设估算，未用生产数据核实。
- 两阶段/单阶段的质量差异、误记率、hold 比例。
- P3-5、P3-8、P4-6、P3-6 的具体实现细节来自题目材料，未在 main 6d70648 核实；P3-8、P4-6 的分支未在本地仓库。
- 回看与每日整理合并后的失败重试行为、部分变更后的幂等性，需要真实 SQLite 集成测试验证。

**未核实：**

- 生产实际每天有多少 episode、多少主人消息、多少线程。
- DeepSeek 对中文的精确 token 换算；费用估算用的是保守的字符/token 近似。
- P4-6 的 ADR 0218 具体字段和判定门槛，本地 main 没有。
