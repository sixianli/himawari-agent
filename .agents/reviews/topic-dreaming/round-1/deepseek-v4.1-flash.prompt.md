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
仓库就是当前目录，已检出 6d70648373f50390c4818a5c29accd9a193cdb23。
问题、目标和约束：
# 问题：Himawari 要不要、怎样做“离线回看对话、整理记忆”（业界叫 dreaming / sleep-time / reflection）

## 问题

Andy 问：Himawari 要不要做类似 Anthropic “做梦”的功能——定期回看主人一段时间内的全部聊天，从中挖出有价值的新记忆，并整理已有记忆（发现过时的、被新说法推翻的，把新说法记进去）。请从问题本身出发，提出你认为最好的方案（包括“不做”或“只做一部分”）。

## 目标

1. 主人跨好几轮、好几天才显露的信息（习惯、偏好变化、长期计划的进展）能被记下。
2. 旧记忆被后来的聊天推翻或过时时，系统能自己发现并处理，而不是要主人提起。
3. 主人不用为此做额外操作（Himawari 的用户不会用 AI 编程工具，用户侧功能必须在产品内自己完成，尽量不要人工确认）。

## 约束（来源都在仓库里，可自行打开核对）

- 产品原则冲突时的顺序：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率（`docs/product-vision.md`；`AGENTS.md` “产品愿景”一节）。
- 存入的记忆必须能被模型看到；不顾旧数据兼容（ADR 0193）。
- 发给模型的内容只能往后追加，固定的在前、会变的在后；后台调用也是固定指令在前、本次数据在后（`.claude/rules/prompt-prefix.md` 第 15、16 条）。
- 只能用低价模型：生产经 Magpie，按量付费只用 DeepSeek V4.1 Flash 这类（`.claude/rules/owner-standing-rules.md` “钱和模型”）。DeepSeek 价格每百万 token：缓存命中 $0.003，未命中 $0.15（`docs/adr/0207-compaction-request-reuses-conversation-head.md:41`），输出约 $0.6。
- 不许写死能动态获取的值（清单、阈值、模型列表）。
- 改动都要可撤销；Andy 极在意钱。

## 已核对的现状（main 6d70648）

- 每轮后台抽取记忆：`apps/agent-service/src/production-memory-capture.ts`（策略 `memory-capture:v5`）。抽取时只看主人这一轮的话加上一条 Himawari 回答的末尾 1500 字（`MAXIMUM_CONTEXT_CHARACTERS = 1500`，`previousAssistantMessage`）。2026-10-31 评测后 Andy 定：继续每轮后台抽取，不改成主模型自己调工具记（ADR 0142）。
- 每天一次记忆整理：`packages/memory-engine/src/consolidation.ts`。`due()` 看今天（主人时区）是否已整理过；当天第一轮对话时触发（`apps/agent-service/src/production-memory-consolidation.ts`）。它只拿“上次整理后新记下的记忆，最多 20 条”（`MAXIMUM_FRESH = 20`），每条去找最多 3 条相近旧记忆（`MAXIMUM_NEIGHBOURS = 3`），让模型判“重复 / 冲突 / 无关”，再给最多 3 条推断（`MAXIMUM_INSIGHTS = 3`，至少 2 条依据，不推断健康和财务）。它不重读对话原文。每次改动记在 `memory_consolidation_changes`，记忆页能撤销（ADR 0194）。
- 闲置归档已停（ADR 0196）。
- 对话日摘要（episodes）：`packages/memory-engine/src/episodes.ts`，每段对话按天写一条 300 字以内的第三人称摘要，输入最多 16000 字、单条消息截 1500 字；可被 `recall` 工具检索，不自动注入。
- 在做、未合并的相关工作：
  - P3-5（PR 377）：存记忆失败时重试或补做同一轮的抽取。
  - P3-8（分支未开 PR）：整理判为冲突时，不再直接作废旧条；只有“新条更晚且置信度 ≥ 门槛（缺省 850）”才取代，否则新条存为待确认、两条都留，记一个 hold。
  - P4-6（PR 371，ADR 0218）：每周记忆体检，把四类可疑记忆（两条说法不一样、N 天没用过、置信度低、来源原话已找不到）放进“每天打分”让主人点确认 / 删除 / 合并，都能撤销。
  - P3-6（PR 367）：Gmail 检查带上最近两天的对话日摘要，没生成的先补。
- 记忆有 validFrom / supersededBy（取代旧条不删除，可恢复，ADR 0217 恢复到任意版本）。

## 业界一手资料（已读）

- Anthropic Managed Agents “Dreams”（research preview）：<https://platform.claude.com/docs/en/managed-agents/dreams>。读一个已有记忆库加 1–100 段对话，生成一个新的记忆库（重复合并、过时或被推翻的换成最新值、提出新见解）；原库不动，开发者看过再决定用不用；按 token 计费，费用大致随对话数和长度线性增长；跑几分钟到几小时。
- Anthropic Cookbook “Dreaming with a dynamic workflow”：<https://platform.claude.com/cookbook/managed-agents-cma-dreaming-with-a-dynamic-workflow>。每段对话一个分析者（小模型）：读全文、拿对话核对已有记忆（降级没把握的、改正矛盾的）、补充；最后一个整理者合并重复、无法判断的矛盾标 CONFLICT 并附来源日期而不猜。每晚 cron 跑，只处理上次成功之后的对话，失败的那晚保留窗口重试；默认不经人审直接改库（文档自己写了“坏对话第二天早上就会进记忆”）。11 段对话约 $0.36（Haiku/Sonnet 价）。把对话里的指令当数据，不记密钥。
- Anthropic 研究文章：<https://www.anthropic.com/research/components-of-agent-memory>。dreaming 的作用：拿对话改正记忆错误、建立索引类结构、把重要笔记提升到每次会话开头加载的那一层（并保持那层小）；代价是要算力，持续检查全部记忆可能不现实；错误笔记会被带进每次会话。
- Letta（开源，`letta-ai/letta-code`）：反思子代理 `src/agent/subagents/builtin/reflection-v2.md`，按“完成 N 步”（默认 25，`src/cli/helpers/memory-reminder.ts`）或“上下文压缩时”触发，读最近对话，优先级：错误与纠正 > 偏好与模式 > 新事实 > 与已存记忆矛盾的 > 可复用流程；多段对话时“偏向跨会话都出现的模式，矛盾以最新证据为准，不记一次性任务状态”；把相对日期换成绝对日期；没东西就不改。改动是 git 提交，可回退；可选“改之前再让一个后台对话审一遍”，不问用户。文档：<https://docs.letta.com/guides/agents/sleep-time-agents>。
- mem0（开源，`mem0ai/mem0`）：最新版写入时只做 ADD（`ADDITIVE_EXTRACTION_PROMPT`，`mem0/configs/prompts.py`），旧的 UPDATE/DELETE 写入时判断仍在代码里。
- Graphiti / Zep（开源，`getzep/graphiti`）：写入时找“新旧不能同时为真”的事实，把旧的设 invalid_at / expired_at，不删（`graphiti_core/utils/maintenance/edge_operations.py` 的 `resolve_edge_contradictions`；提示 `prompts/dedupe_edges.py`：“只有新旧不能同时为真才算矛盾，进展、状态更新不算”）。
- ChatGPT：两层——用户让记的 saved memories，和“参考聊天记录”（会随时间更新哪些内容更值得记）；Plus/Pro 有“自动管理记忆”：把最相关的放前面，不重要的移到后台，用户可关掉、可手动调优先级（OpenAI Help Center，<https://help.openai.com/en/articles/8590148-memory-faq>，二手报道称 2025-10-15 上线）。
- Gemini：读已保存的过往聊天做个性化（原叫 Personal context，2026-03 改名 Memory，<https://blog.google/innovation-and-ai/products/gemini-app/switch-to-gemini-app/>）。
- Microsoft Copilot：从聊天中记关键细节和偏好，并从历史对话做推断；关掉个性化会删掉这些推断（<https://support.microsoft.com/en-us/microsoft-365-copilot/personalize-what-microsoft-365-copilot-remembers>）。

## 想请你回答

1. 该不该做；不做或只做一部分的理由也欢迎。
2. 你的方案：什么时候跑、读什么（对话原文 / 日摘要 / 已有记忆的哪一部分）、产出什么、怎么落库（直接改 / 待确认 / 两条都留）、怎么撤销、怎么防误改和误记、怎么防重复处理。
3. 和上面在做的 P3-5、P3-8、P4-6、P3-6 怎么分工，会不会重复或冲突。
4. 每天费用估算（写清假设的对话量），以及怎样控制上限。
5. 怎样验收（含反向用例：不该记、不该改的情况）。
6. 有没有更好的、不在上面任何一家做法里的思路。
