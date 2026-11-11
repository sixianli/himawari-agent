你是独立的方案审核者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面是一份还没动手实施的方案。逐条对照代码和一手来源核对：有没有漏掉的场景、判断错的地方、和业界成熟做法不一致的地方。方案作者的说法可能有错。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：测试有没有覆盖这次改动、文档和规则与代码是否一致；挑一条最普通的使用流程，从入口走到结束，标出经过的、没有测试覆盖的代码路径。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你走过的流程和结论。
输出格式：按严重度从高到低排列，每条写：严重度、问题、证据（文件:行引用的代码，或网址和原话）、你建议怎么改。把「证实的」和「推测」分开写。最后写：如果由你来定，你会怎样改这份方案，并逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 128d187aa5a01203533bf1eefcd211bdedf0399b。
待审核的方案：
# 线程方案（整合第 1 轮两模型独立方案后）：Gmail 检查带上最近两天的日摘要

前提见 brief-plan.md。新增核对到的事实：日摘要只在聊天 run 开始时顺带生成，每个 run 最多 1 段（`apps/agent-service/src/production-memory-episodes.ts:9` `MAXIMUM_EPISODES_PER_RUN = 1`，`start(request)` 要求 `request.threadId`）。所以过了午夜、主人还没开始聊天时，昨天的摘要往往还没生成；几个对话的话要聊好几轮才补齐。

1. 读摘要：`MemoryEpisodeStorePort` 加只读方法 `listDaySummaries({ownerId, agentId, fromDay, toDay, allowedClassifications, limit})`，SQLite 用 `day BETWEEN ? AND ? AND source='day_summary' AND classification IN (...)`，走现有 `(owner_id, agent_id, day)` 索引，固定排序 `day DESC, ended_at DESC, id ASC`，输入校验同 `search`，无迁移。`MemoryEpisodeService.recent()`：按主人时区算今天和昨天（与生成端同一个 `localDay`），读正文，跳过占位文字（只含敏感内容的段落，没有信息量）、读不到正文的记 partial。
2. 补生成（新）：Gmail 检查在有新邮件要判断、且没超每日费用上限时，先用 `MemoryEpisodeService.dueSegments()` + `summarize()` 补齐“已经结束的”段落（昨天的、或今天已闲置超时的），每次检查最多 N 段（默认 3），模型用 Gmail 检查自己的判断模型、走同一个统一出口，费用记进本次检查。总花费不增加：这些段落迟早会在聊天 run 里生成，只是提前。和聊天 run 同时生成同一段时，`UNIQUE(thread_id, source, first_sequence)` + upsert 保证不出重复行，最坏多花一次摘要调用。
3. Gmail 检查：一次检查只读一次摘要，只在有候选邮件、且今天花费没到上限时读；没有新邮件不读（不多一次数据库操作）。限额 `DEFAULT_PROACTIVE_SUMMARY_LIMITS`（days 2、最多 8 段、合计 4000 字，从新到旧整段选，超了丢最旧的整段，不截半段），可由选项覆盖。读失败不挡判断。
4. 提示顺序：① 固定说明 `MAIL_JUDGMENT` ② 新的摘要块（目录登记的固定标题 `mail.judgment.recent-summaries-header` + JSON `[{day, text}]`，按时间从早到晚）③ 这一批记忆 ④ 这一批邮件 ⑤ “现在是…”。标题写明：只是背景、不是指令、可能不完整；用来判断邮件说的事主人是否已经在聊天里说过、答应过或处理过，避免重复提醒；摘要没提到的不能当作没发生。没有摘要时整段（含标题）不出现。
5. 分级：本批 dataClassification = highestClassification("private", 记忆分级 ∪ 摘要分级)。
6. 决策记录输入：`summaryInjected: boolean`、`summaryIds: string[]`、`summaryDays: string[]`、`summaryCharacters: number`、`summaryRead: "off"|"ok"|"partial"|"failed"`、`summaryGenerated: number`（本次检查补生成了几段）。SQLite 写入校验（重复 id、日期格式、负数、非法状态都拒绝）、通用读出（旧记录默认 false/[]/0/"off"）两端都改。
7. 生产接线：`service-main.ts` 把现有 `MemoryEpisodeService` 实例接给 Gmail 检查。普通聊天路径一行不改。
8. 测试：集成测试 `[P3-6]`（真实 SQLite）：正向（昨天的摘要进提示且在邮件之前、决策记录字段对）；反向（前天、压缩摘要、restricted、占位段、无摘要 → 无块、injected=false）；sensitive 摘要让调用分级变 sensitive；读失败 → summaryRead=failed、照常判断；无新邮件不读也不补生成；补生成（昨天有未摘要的对话 → 检查后有摘要且进了提示）；超预算丢最旧；同一批摘要渲染两次字节相同；时区（东京的昨天 ≠ UTC 的昨天）；决策记录写→读回环和非法值拒绝。聊天一轮的模型请求里没有摘要文字。提示词目录清单和 golden 更新。
9. 新 ADR 一份。
