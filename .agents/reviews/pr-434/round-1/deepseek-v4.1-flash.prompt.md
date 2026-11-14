你是独立的代码复核者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
系统的真相在代码里。下面「作者的说法」可能有错，每一条都要对照代码核对；发现说法和代码不一致，要明确指出。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、文件:行、问题、证据（引用你亲自读到的那几行代码）、建议。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 4778b1ca7fb950e37bdbf557202af639ccbe6426。
对比基准是 0d989adb521245a18eea3e8e26c55c27469b70c2，先运行 git diff 0d989adb521245a18eea3e8e26c55c27469b70c2..4778b1ca7fb950e37bdbf557202af639ccbe6426 看改动。
作者的说法（可能有错，请核对）：
# PR 434 第 1 轮作者说明

问题：Andy 改了、删了或换掉一条记忆后，依据它“反思”（`reflect`）推出来的记忆、以及由它立的硬规则可能已经不对了。以前只有直接来源被改的规则会标“待重审”，规则照常执行，等 Andy 手动确认。任务 P4-1 要求：沿依据链把所有推出来的记忆和指向它的规则都标成待重审；规则由模型重读来源记忆后自动核对，对不上就暂停并写决策记录，核对通过就清标记；记忆文字一律不自动改。P4-3 并入：清单上的每次点击进决策记录，算一致率（样本少于 5 只显示样本不足），漏标单独计数。决定见 `docs/adr/0232-memory-corrections-flag-derived-memories-and-recheck-rules.md`。

改动：
- 迁移 `packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql`：新表 `memory_review_items`；触发器 `memory_change_flags_downstream`（修改后）、`memory_delete_flags_downstream`（删除前）只写直接下游；规则 `suspended` 状态和约束；重建 `decision_ledger` 一族（加 `memory_review` 类型和新结果）、`rule_book_rules`、`rule_book_history`、`model_usage_observations`；删 0087 的两个旧触发器。
- `packages/persistence-sqlite/src/sqlite-correction-review-operations.ts`：展开依据链（最多 8 层、200 条，记“已截断”）、列清单、处理 Andy 的选择、漏标、一致率计数。
- `packages/application` 里的 `RuleReviewService`：每次查邮件前核对最多 3 条待重审规则；模型调用失败重试 3 次（间隔 1 小时）后记 `recheck_failed`，规则照常执行；写入核对修订号。
- 规则 `suspended` 的消费方：裁判 `ruleIsEnforced`、`enforceableOwnerRule`、MCP `rule_book`、数据导出。
- 网关 `memory.review.read` / `respond` / `reportMissed`（`apps/agent-service/src/production-memory-control.ts`），`service-main.ts` 和 `production-proactive.ts` 接上后台核对，周报快照加 `correction`。
- 网页：`apps/control-center/src/components/correction-review.tsx`（待重审清单）、记忆详情里的“还有哪条也该跟着改”、周报一致率卡片，三种语言文案。
- 合入了 main 的外部提议导出 v3，解决了 `data-export/export.ts`、`snapshot.ts` 的冲突。

约束：理解用户意思交给模型，不用关键词表；后台模型调用固定内容在前、会变的在后，提示词登记在提示词目录；待重审的规则照常执行，只有模型给出对不上的结论才暂停，调用失败不暂停；记忆文字不自动改；代码不写注释。

请核对：
1. 触发器是否在所有该触发的变化（改正文、状态、取代、分类、删除、恢复）都写了直接下游，不该触发的（只改重要度、无关记忆）不写；展开是否会重复标、漏标、死循环，截断是否如实显示。
2. 规则核对的并发和顺序：核对期间 Andy 改了规则或来源，修订号检查能不能防止旧结果覆盖新状态；Andy 点“采用建议/确认暂停/恢复原规则”时修订号对不上是否正确拒绝；暂停的规则是否在所有执行入口都不执行。
3. 后台核对的错误路径：模型返回格式不对、超时、规则来源已删除、没有配置邮件检查时，是否不暂停规则、不阻断查邮件、不无限重试。
4. 一致率的计数是否符合 ADR 0232“一致率和漏标怎么算”一节：哪些算认可、哪些不算，漏标不进分母，少于 5 条不出比例。
5. 网关输入（target、action、expectedRevision、memoryId、upstreamMemoryId）是否都校验了归属和存在，能否操作别的主人的记忆或规则。
6. 迁移重建表是否丢数据或丢约束、外键、索引；合入 main 后导出的“未导出”清单是否正确。
7. ADR 0232、案例 92 和代码是否一致。
