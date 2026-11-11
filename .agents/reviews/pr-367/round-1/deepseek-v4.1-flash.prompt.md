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
仓库就是当前目录，已检出 7ab2d808da28f1e9bf485ab93ae43e9b1d08f36e。
对比基准是 aa1b0b0b551f5d7843ac0f7120f649f74bf12e5f，先运行 git diff aa1b0b0b551f5d7843ac0f7120f649f74bf12e5f..7ab2d808da28f1e9bf485ab93ae43e9b1d08f36e 看改动。
作者的说法（可能有错，请核对）：
# PR 367 代码复核材料：Gmail 检查带上最近两天的对话日摘要（P3-6）

## 问题
Himawari 每天把每个对话当天的内容写成日摘要（memory_episodes 表，source = day_summary），但主动的 Gmail 检查看不到，可能重复提醒主人已经在聊天里说过、处理过的事。日摘要只在聊天 run 开始时顺带生成、每个 run 一段，所以早上主人还没聊天时，昨天的摘要多半还不存在。

## 目标（验收，不能改）
1. Gmail 检查（唯一的主动 run）的上下文含最近两天的摘要块。
2. 决策记录的输入里有对应字段（集成测试覆盖）。
3. 聊天的首字延迟不增加：聊天路径不读也不生成这些摘要。

## 约束
- 摘要走统一出口，放在最后一条（也是唯一一条）用户消息的数据部分，不进系统提示；新文字登记在 packages/prompt-catalog。
- 发给模型的内容只追加、固定的在前会变的在后（.claude/rules/prompt-prefix.md）。
- 决策记录写入约定 docs/execution/specs/2026-11-09-decision-record-write-convention.md：不适用的键整项省略（第 4 条），读取端能列出新字段（第 5 条）。
- Andy 选了“检查前先补生成”：有新邮件时，先把日期落在今天和昨天的已结束段落补成摘要，每次最多 3 段。
- 不改表（已有 memory_episodes_scope_index(owner_id, agent_id, day)）。

## 作者的说法（请验证，不要默认成立）
- 只有 candidates 非空且当天花费没到上限时才补生成和读取，没有新邮件不多读一次库。
- 补生成用 Gmail 检查的判断模型和每天上限，单独用检查时间的四分之一，主人暂停记忆记录时不补，只补模型允许分级的段落；失败只把 summaryRead 记为 partial，不挡判断。
- 读出只取模型可见且判断模型允许的分级，跳过占位文字；从新到旧整段挑，超出 4000 字丢最旧的整段，再按时间从早到晚排；同一次检查各批字节相同。
- 今天/昨天按 runPolicy.timeZone 算（和生成摘要同一个 localDay）。
- 决策记录六项：summaryInjected、summaryIds、summaryDays、summaryCharacters、summaryRead、summaryGenerated；SQLite 写入时校验，没接上读取器时一项都不写；通用读出给旧记录补默认值。
- 摘要块、读取器和接线只出现在 Gmail 检查的文件里（apps/agent-service/test/proactive-summaries-scope.unit.test.ts 静态检查）。
- 决定和放弃的做法见 docs/adr/0216-gmail-check-reads-recent-day-summaries.md。

## 测试
test/integration/proactive-mail-check.test.ts 的 [P3-6] 组（13 条，含反向用例）、test/integration/memory-episodes.test.ts 的 [P3-6]、test/integration/decision-chain.test.ts、decision-ledger.test.ts、提示词定稿文件 mail.judgment.recent-summaries。
