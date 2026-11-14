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
仓库就是当前目录，已检出 5858f0ca9d28b918799abffd04f5d975dbc8ebf1。
对比基准是 504308d13f3c8aa087b66e754bbe35c00a2ab9ac，先运行 git diff 504308d13f3c8aa087b66e754bbe35c00a2ab9ac..5858f0ca9d28b918799abffd04f5d975dbc8ebf1 看改动。
作者的说法（可能有错，请核对）：
# 任务 B 第一部分：对外 MCP 读工具统一登记、四个读工具接读取上限、内置规则声明对外参数

## 背景和目标（已核对的事实）
- ADR 0242 决定 4 和 2026-11-12 补注（docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md 第 95-101 行）：对外 MCP 服务上的每一个读工具走同一道读取上限检查；以后加读工具不接读取上限就过不了自动检查；“读工具统一登记，登记时必须带上读取上限，没带的登记不上”。`today_context` 和 `start_here` 带的提醒正文、对话摘要也按上限过滤。
- 同一 ADR “通用，不按场景写死”一节第 201 行：`rule_book` 原来用 `rule.id === "quiet_hours"` / `"floor_important_sender"` 决定给哪些参数，要改成内置规则自己声明对外给哪些参数，加一条带参数的内置规则不用改对外入口。
- 任务 A（PR 413）只给 `start_here` 接了上限；`start_here` 概况的版本号没把“还有几条没列出”算进去；概况来源失败的用例没有；“一处点名、别处同值也被遮”的用例只测了遮盖函数。
- 这一部分不改表。按接入分开的读取上限、接入记录、统计表在第二部分做；现在的上限仍是全局一个 `readCeiling`（默认 private），经 `admit` 放进 `authInfo.extra.readCeiling`，第二部分改成按接入取。

## 改了什么
- `apps/agent-service/src/production-mcp-read.ts`：`MCP_READ_TOOLS` 登记表，每条写 `readCeiling.sources`（读哪几样数据）；`mcpReadToolRegistry` 拒绝没写、写空、写了不认识数据源的条目和重名；`ProductionMcpRead` 构造时校验（可传 `readTools` 换一份）。工具实现移出类，只能经 `McpReadRequest.read` 拿到自己声明过、且已按上限绑定的数据源。`#call` 不再按工具名判断是否记摘要，改看工具有没有声明 `summaries`。主人规则按出处那条记忆的分级过滤（`memoryClassifications` 数据源），出处找不到的不给。
- `apps/agent-service/src/production-memory-recall.ts`：`recallOutsideRun` 必须带上限，记忆和对话摘要都按上限过滤。
- `packages/application/src/rules/rule-book.ts`：`RuleRecord.sharedParameters`（分级 + 值），`importantSenderRule`、`quietHoursRule` 声明为 private。
- `apps/agent-service/src/service-main.ts`：接上 `memoryClassifications`。
- 测试：`test/integration/mcp-read.test.ts` 新增 `[P5-B]` 一组，四个读工具各有上限正反用例、登记失败用例、新登记工具只能读声明数据源的用例、内置规则声明参数的用例；`[P5-A]` 里补了版本号、概况失败、经真实 `start_here` 调用的跨段遮盖。
- 手工验证过的反向：去掉版本号里的“没列出条数”、把遮盖改成逐段、把上限固定成 sensitive，对应用例都会失败。

## 请特别看
- 对外 MCP 的工具清单、顺序、描述和参数结构有没有变（不应变）。
- 读取上限有没有漏掉的路径（任何读工具能不经过绑定上限的数据源拿到内容）。
- `ownerRulesWithin` 按出处记忆分级过滤是否合理、会不会误伤正常规则。
