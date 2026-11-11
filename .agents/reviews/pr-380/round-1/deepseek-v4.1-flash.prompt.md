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
仓库就是当前目录，已检出 a11c8d9c3725c5c7e86ee28858b570d03542aa5e。
对比基准是 cb9c281916784201ff2ef3e8bca5fc8f359b64fc，先运行 git diff cb9c281916784201ff2ef3e8bca5fc8f359b64fc..a11c8d9c3725c5c7e86ee28858b570d03542aa5e 看改动。
作者的说法（可能有错，请核对）：
# PR 380 作者说明：P2-3 主人一句话变成长期规则

目标：主人在对话里说一条常设要求（例如“日本入管局相关的邮件以后必须通知我”“涉及退款必须看整个邮件串”“订阅相关的必须提醒我”），系统把它变成程序执行的长期规则，写一条规则类记忆作出处，在聊天里给回执卡（试算、近 30 天历史回放、一键撤销）。没有测试的规则类型不得写入。决定写在 docs/adr/0213-owner-sentence-becomes-a-standing-rule.md。

约束：只做 Gmail 邮件检查一种闸门；不发明规则语言（模型只填参数）；发给模型的内容只追加（新增三个工具，老对话按 .claude/rules/prompt-prefix.md 第 6 条换新一次）；不改表结构（主人规则存进现有 rule_book_rules，rule_id 以 owner: 开头）。

主要改动：
- packages/application/src/rules/rule-types.ts：规则类型注册表、参数校验、表达式与正反例生成。
- rule-book.ts / field-catalog.ts：新字段 content_folded、content_words；新结果 require_notify、require_whole_thread。
- proactive-mail-check-service.ts：每次检查读主人规则；整串读取；强制“要你看”并推送的分支；决策记录 ruleHits/floorHits。
- platform-node/src/gmail-related.ts：整串读取（含后来的回复），complete 标志。
- persistence-sqlite/src/sqlite-owner-rule-operations.ts：主人规则的列出、读取、创建（幂等）、改状态。
- apps/agent-service/src/production-owner-rules.ts：rule_set/rule_list/rule_undo 工具和写入器（明说判定、提议、去重、上限、撤销时归档记忆、重新确认）。
- owner-rule-replay.ts：历史回放。
- 网关 memory.rules.read / memory.rule.respond；网页回执卡、记忆页规则列表。
- check:rule-registry 加跑类型测试和 test/tooling/rule-type-tests.test.ts。

请重点看：明说判定能否被邮件内容里的提示注入绕过；强制推送分支与原有抬升、降推送规则的交互；整串读取 complete 的判断；回放的边界；SQLite 操作的输入校验与事务。
