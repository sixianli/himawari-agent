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
仓库就是当前目录，已检出 aa1b0b0b551f5d7843ac0f7120f649f74bf12e5f。
问题、目标和约束：
# 问题：主动的 Gmail 检查不知道昨天发生过什么

## 背景（已核对，提交 aa1b0b0）
- Himawari 每天把每个对话当天的内容写成一段“日摘要”，存在 `memory_episodes` 表，`source = 'day_summary'`（另有 `compaction` 来源的压缩摘要）。生成代码：`packages/memory-engine/src/episodes.ts`（每段最长 1200 字，见第 25 行；只含敏感内容的段落写占位文字，见第 27 行）。存储接口：`packages/application/src/ports/memory-episodes.ts`；SQLite 实现：`packages/persistence-sqlite/src/sqlite-memory-operations.ts`。表上有索引 `(owner_id, agent_id, day)`（`packages/persistence-sqlite/src/migrations/0053_memory_episodes.sql:27`）。
- 日摘要不会自动进任何上下文，只有聊天里的回忆工具会搜它（`apps/agent-service/src/production-memory-recall.ts`）。
- 主动的 Gmail 检查（`packages/application/src/services/proactive-mail-check-service.ts`，生产接线在 `apps/agent-service/src/service-main.ts` 约 1566 行和 `production-proactive.ts`）每 15 分钟左右跑一次：读新邮件、逐封搜相关记忆、按批拼一段提示（`proactivePrompt`），作为唯一一条用户消息经统一出口发给判断模型（`packages/runtime-pi/src/egress-context.ts:26`），结果写进决策记录（`decision_ledger` 表，`inputs` 列是 JSON，类型 `ProactiveCheckInputs`，`packages/application/src/ports/proactive-checks.ts:208`）。
- 因为看不到最近的对话，Gmail 检查可能重复提醒主人昨天已经在聊天里说过、处理过的事，或漏掉上下文。生产上目前只有 Gmail 检查这一种主动 run（定时触发的 run 没有接线）。

## 目标（主人定的验收，不能改）
1. 主动 run（Gmail 检查）的上下文包含最近 1–2 天的日摘要块；普通聊天不带。
2. 带没带、带了哪些，写进那条决策记录的输入（有集成测试）。
3. 聊天的首字延迟不增加。

## 约束（仓库规则）
- 发给模型的内容都走统一出口（ADR 0148）；新增或改动的提示词文字必须登记进提示词目录 `packages/prompt-catalog`。
- KV 缓存：固定的在前、会变的在后；会变的值只能放在最后一条用户消息里（`.claude/rules/prompt-prefix.md` 第 1、2 条）。摘要要放在最后一条用户消息的资料块里，不进系统提示。
- 记忆和摘要的“模型可见分级”判断用已有的 `modelVisibleClassifications()`；识别敏感内容的规则只能写在专门的包里。
- 事故清单 I-25、I-45（数据库操作排队让聊天变慢）、I-60 都是聊天延迟问题，这次改动不能让聊天变慢。
- Gmail 检查有每天费用上限和单次 3 分钟时间上限；能动态获取或配置的值不写死。
- 尽量不加数据库迁移；不考虑旧数据兼容。

请给出你的方案：读哪些摘要、怎么取舍条数和字数、放在提示的哪里、决策记录记什么、怎么保证聊天不受影响、要哪些测试（含反向用例）。
