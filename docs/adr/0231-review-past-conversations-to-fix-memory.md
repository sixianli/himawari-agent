---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-11"
---

# ADR 0231：后台回看过去的对话，补记漏掉的记忆、标出被取代的旧记忆

> 2026-11-24 补：[ADR 0286](0286-the-main-model-reads-and-writes-memory-itself.md) 把回看改为“做梦”：主模型带着全部记忆和新对话原话合并、更新、补记、整理主题页，取代每日摘要；原话校验和整批撤销保留。

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [业界怎么做](#industry)
- [Andy 的原话](#owner-decisions)
- [决定](#decision)
- [和变更清单不一样的地方](#deviations)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

Himawari 现在有两个环节写记忆，但没有一个环节拿“对话”去核对“旧记忆”：

- 每轮抽取（`apps/agent-service/src/production-memory-capture.ts`）每次只看这一轮的话，上下文上限是 `const MAXIMUM_CONTEXT_CHARACTERS = 1500;`。跨几轮才说完整的事（例如前一轮说“我换工作了”，后一轮才说新公司名）记不全。
- 整理记忆（`packages/memory-engine/src/consolidation.ts`）只拿记忆和记忆比，而且只在用词重叠够多时才比（`if (!text || overlap(current.text, text) < MINIMUM_OVERLAP) continue;`，`MINIMUM_OVERLAP = 0.5`）。主人在对话里说“我已经不在那家公司了”，如果当时没抽成一条新记忆，旧的“在某公司工作”会一直被当真。

这是根因，不是表面症状：缺的是一个“重读对话、对照旧记忆”的环节。本 ADR 加上这个环节，名字叫“回看对话”（词表第 19 行）。

<a id="industry"></a>

## 业界怎么做

- Anthropic 的 Dreams（[文档](https://platform.claude.com/docs/en/managed-agents/dreams)）：“A dream reads an existing memory store alongside past session transcripts, then produces a new, reorganized memory store: duplicates merged, stale or contradicted entries replaced with the latest value, and new insights surfaced.” 它的输出是一个新的记忆库，原库不动：“The input store is never modified, so you can review the output and discard it if you don’t like the result.”
- Anthropic Cookbook 的示例（[Dreaming with a dynamic workflow](https://platform.claude.com/cookbook/managed-agents-cma-dreaming-with-a-dynamic-workflow)）由调用方自己决定什么时候跑、读哪些对话。
- Letta 的 dreaming（[文档](https://docs.letta.com/guides/agents/sleep-time-agents)）：“uses background subagents to review recent conversations, consolidate useful lessons, and update memory”，触发时机是“after a set number of completed agent steps or when the context window is compacted”。

我们的做法和它们的共同点：后台跑、读原始对话（不读摘要）、对照旧记忆、过时的用新说法取代。不同点和理由：

- 不整库重写，只增量地改有证据的几条。Himawari 的每条记忆都带出处、修订号和历史，整库重写会把这些全丢掉，也没法逐条撤销。
- 直接生效，不先出一份待审的新库。Andy 选了“上线就自动生效”；可逆性靠“整批撤销”和逐条记录改前的值来保证，不靠审批。

<a id="owner-decisions"></a>

## Andy 的原话

2026-11-11 18:59 JST，对方案文档（<https://claude.ai/artifact/PxbiHsuZpfT3a4UCTrXMLi>）里两件要拍板的事：“方案里面要我拍板的两件事情，我都同意”。两件事是：做这个功能；上线就自动生效，不先影子运行。

2026-11-11 19:04 JST，对变更清单（`/mnt/project-files/dreaming/change-list.md`）：“同意”。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

依据的原则：愿景原则 3“记忆可靠性”（记忆要跟着主人的新说法变对），受原则 2“边界与可逆性”约束（每次改动可整批撤销，主人改过的记忆不碰）。

1. **独立的后台任务。** `ProductionMemoryConversationReview`（`apps/agent-service/src/production-memory-conversation-review.ts`）在日摘要和整理记忆之后启动（`production-titled-runtime.ts`），由主人发起的一轮对话顺带触发，不阻塞回答；同一时间只跑一个，两次触发之间至少隔 10 分钟。
2. **按日摘要的段落往前走。** 游标是“最新一段已完成或已放弃的回看”，按 `(episode_created_at, episode_id)` 排序；每次从游标之后取段（`listDaySummariesAfter`），每天最多回看 `maximumSegmentsPerDay` 段。每段在 `memory_conversation_reviews` 记一行，失败的最多重试 3 次（`MEMORY_CONVERSATION_REVIEW_MAX_ATTEMPTS`），之后记为 `gave_up`，游标跳过它。游标只看对应日摘要还在的回看记录，从数据导出导入进来的回看记录（没有日摘要）不影响游标。回看编号是 `memory-review:` 加段编号的 SHA-256 前 32 位，长度固定，不随 thread 编号或消息序号变长（网关的编号上限是 128 字符）。
3. **读主人原话，不读摘要。** 回读这一段对话的消息：跳过 system 和没提交的消息，模型看不到的（`isModelVisible`）和分级高于这段摘要的都排除；单条截到 1500 字，总字数不超过 `maximumSourceCharacters`。代码里有测试保证不读摘要正文（`proactive-summaries-scope.unit.test.ts`）。
4. **带上相关旧记忆。** 用这段原话做混合检索（含待确认的记忆），只保留仍有效、没被取代、分级允许的，最多 `maximumRelatedMemories` 条；每条只给编号、记下的日期、正文、立场和是否待确认，不给分数。
5. **提示词固定在前，会变的在最后。** `memory.conversation-review` 是固定指令；接着是本段数据 JSON（旧记忆、已有子分类、认识的人、主人时区、原话）；最后一行是 `memory.conversation-review.day`（“今天是 {day}（主人所在时区）。”）。见 [KV 缓存规范第 15 条](../kv-cache-guide.md)。
6. **模型只能做三种判断：新增（create）、取代（supersede）、确认（unchanged）。** 解析后在代码里再执行硬规则，不只靠提示词：
   - 引用的消息必须是这段里主人说的话，原话必须逐字出现在那条消息里（复用每轮抽取的 `parseMemoryCandidates`）。
   - 习惯类必须用 `alsoSeenIn` 指向另一天记下的旧记忆，只有一天的证据不算习惯；`alsoSeenIn` 里的消息编号不算证据。
   - 敏感候选直接跳过，不发审批；推断出来的健康、财务类直接丢弃。
   - 确认只在旧记忆是“待确认”时才生效，把它转正。
   - 每天新增不超过 `maximumNewMemoriesPerDay` 条。
   - 取代要过 `replacesOlder`（从整理记忆抽出的共用判断，见 [ADR 0220](0220-consolidation-conflicts-wait-for-the-owner.md)）：新说法更晚且置信度够才取代；否则两条都留，新条标为待确认。
   - 回看期间主人改过的记忆（修订号变了）跳过。
7. **写库复用每轮抽取那条路。** 新增和取代走 `createProductionAutomaticMemory().processCommittedRun`，每条用固定编号 `memory-review:<段编号和消息编号的 SHA-256 前 32 位>` 建真实的生成记录（策略 `memory-conversation-review:v1`），所以 850 门槛、决策记录、遮盖还原都和每轮抽取一样。模型输出加密存一份（`memory-review-output:<回看编号>:<第几次>`），重试时复用，不再调模型。模型费用记在 `memory-consolidation` 用途下。
8. **整批撤销。** `memory_conversation_review_changes` 记下这一批改了哪些记忆、动作（created、superseded、confirmed）、改后的修订号、改前的 `supersededBy` 和 `validTo`。
   - 先记后写：写记忆之前，先按这次回看的快照记下“打算改哪些记忆”和改前的值（这时改后的修订号为空）；写完、写失败时、下次重试开始时，按记忆的实际状态补上修订号，没发生的删掉。这样写到一半失败也不会留下不在任何批次里的记忆，重试也不会把已改过的值当成改前的值。新增的记忆在写之前还不存在，所以这张表不对记忆表用外键，改用删除触发器，记忆被删时一并删掉改动行。
   - 撤销（网关命令 `memory.conversationReview.undo`，`packages/memory-engine/src/conversation-review.ts`）只对已完成或已放弃的批次开放，进行中或失败待重试的批次不显示、不能撤销。新增的归档、被取代的恢复原状、确认的改回待确认；只要有一条记忆在回看之后又被别人改过，整批不能撤销，界面显示“锁定”而不是按钮。
   - 撤销中途失败可以接着做：改回每条记忆之前先记下改回后应有的修订号（`undone_revision`，改回固定把修订号加 1），再点撤销时跳过已改回的。“已改回”要修订号相同、实际状态也对（新建的已归档、被取代的恢复成改前值、确认的回到待确认），所以改回失败后别人的修改不会被当成已改回。
   - “取代是否发生”只认被本批新建的记忆取代，别处的取代不算进本批。新记忆已保存、取代没做就中断时，重试会补做取代：`DurableMemoryService.applyProposal` 遇到同一提案已存在时也执行 `supersedes`（每轮记忆抽取共用这一处）。主人恢复旧记忆时会同时归档取代它的新记忆，所以重试不会再取代已恢复的旧记忆。
   - 已知空隙：检查修订号和写库之间没有锁，主人恰好在这几毫秒里改了那条旧记忆时，它仍会被标成已取代（可撤销）。由“每轮记忆抽取做成一个事务”的另一项改动一并根治。
9. **记忆页。** “整理记忆”筛选里显示回看批次：这一批新记住、取代、确认了几条，每条带记忆正文和原话，一个整批撤销按钮。
10. **配置。** `configuration.memory.conversationReview` 下的 `enabled`（缺省开）、`maximumSegmentsPerDay`（3）、`maximumSourceCharacters`（16000）、`maximumRelatedMemories`（30）、`maximumNewMemoriesPerDay`（5）、`maximumOutputTokens`（1024；生产经 Magpie 调用时关掉推理，这个上限只管答案；不经 Magpie 的推理模型改用 4096 的推理上限），都有上下限检查，不写死。
11. **数据导出。** 两张新表进导出格式（`data/conversation-reviews.jsonl`），导入时挂到导入建的占位对话上；来源对话、段落和消息的编号不导出，和记忆的来源对话编号不导出一致。

[↑ 返回阅读导航](#contents)

<a id="deviations"></a>

## 和变更清单不一样的地方

- 配置路径是 `configuration.memory.conversationReview`，不是清单写的 `runPolicy.memory.conversationReview`：配置里没有 `runPolicy.memory` 这一层，记忆相关设置本来就在 `configuration.memory` 下（`strict-configuration.ts` 的 `parseProductConfiguration`）。
- 段落按日摘要的创建时间排序，不按 `(day, threadId, firstSequence)`：游标要一个全局单调的位置，创建时间加编号就够，而且有索引。
- 习惯类不要求“两个不同日期的原话”，改为“一条原话加另一天记下的旧记忆”：一段对话只属于一天，单段里拿不到两天的原话。
- 不支持模型改写旧记忆（update）：改写会让整批撤销变复杂（要恢复正文和历史），取代已经覆盖“说法变了”的情况。
- 共用的取代判断叫 `replacesOlder`，不叫 `decideReplacement`。
- 回看表不记 token 和费用：费用已经按 `memory-consolidation` 用途记进模型用量，不再重复存。

<a id="options"></a>

## 比较过的方案

- **像 Dreams 一样整库重写：** 丢掉每条记忆的出处、修订号和历史，没法逐条撤销。放弃。
- **扩大每轮抽取的上下文：** 每轮都多花钱，而且仍然不对照旧记忆，过时记忆还是改不掉。放弃。
- **放进整理记忆里一起做：** 整理一天只开一次运行（`ON CONFLICT (owner_id, agent_id, day) DO NOTHING`），它的“新建推断”要两条以上旧记忆做依据，和“从原话新增”是两回事；混在一起，撤销和计数都不清楚。放弃，改为单独任务、单独记录。
- **读日摘要而不读原话：** 摘要是模型写的二手内容，原话核对（逐字出现）就做不了。放弃。
- **先影子运行一段时间：** Andy 选了上线就生效。

<a id="consequences"></a>

## 后果

- 正面：跨轮才说完整的事能补记；过时的记忆会被新说法取代；每一批都能在记忆页看到原话并整批撤销。
- 负面：每天多几次后台模型调用，按变更清单估计每月约 0.06 到 0.18 美元（DeepSeek Flash）。模型输出的加密副本在对话删除后不会跟着删，和现有候选输出一样，留给以后的清理任务。
- 新增两张表（迁移号在改表排队放行时确定）。
- 真实模型评测（2026-11-11，OpenCode Go 套餐的 DeepSeek V4.1 Flash，20 段对话各 1 次，`scripts/evals/memory-conversation-review-live.eval.ts`，和生产一样关掉推理、输出上限 1024）：19/20 通过；该记、该取代、该确认的 14 项做到 13 项，9 段不该有改动的全部没动，没有多记、多确认或取代错记忆，没有被截断的输出。没做到的一项是“升职为技术经理”记成了新记忆，但没有标出旧的职位记忆被取代。平均每段输入约 1900 token、输出约 80 token。开着推理时（`EVAL_THINKING=enabled`）推理占输出约 89%，1024 的上限会截断，所以评测默认关推理。

<a id="references"></a>

## 关联文档

- [ADR 0220：整理记忆判到冲突时默认进待确认](0220-consolidation-conflicts-wait-for-the-owner.md)
- [模型请求的 KV 缓存规范](../kv-cache-guide.md)
- [词表](../glossary.md)

[↑ 返回阅读导航](#contents)
