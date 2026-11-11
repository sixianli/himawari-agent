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
仓库就是当前目录，已检出 dd6b650c2fc5e1067165df8bf702ea08a9652e5a。
对比基准是 2997b499a8b26037ff7545cfd5aefaee3b4e7be7，先运行 git diff 2997b499a8b26037ff7545cfd5aefaee3b4e7be7..dd6b650c2fc5e1067165df8bf702ea08a9652e5a 看改动。
作者的说法（可能有错，请核对）：
# PR 396 作者说明

问题：多人方案要求体验者进来就有示范记忆，并用假收件箱演示主动提醒，且不能连到任何真人的邮箱或数据。

做了什么：
1. `data demo-pack --locale ja|en --out DIR` 生成现有导入格式（`packages/persistence-sqlite/src/data-export/demo-pack.ts`）的示范记忆包，内容在 `packages/domain/src/demo-persona.ts`。
2. 假收件箱 `packages/platform-node/src/demo-mailbox.ts`：一个 ProactiveSourceReader，邮件按相对连接时刻的分钟数到达；连接前的邮件只作相关旧邮件；不联网。
3. 配置 `runPolicy.proactive.demoInbox`（ja/en）与 `gmail` 二选一（strict-configuration.ts）；`ProductionProactive.seedDemoInbox/authorizationRedirect`；设置页加 `gmail=demo` 提示（三语）。
4. ADR 0236。不改表。

必答问题的回答：
- 发给模型的请求开头：没有改系统提示、工具定义、历史；示范邮件只作为一次邮件检查的数据进入提示词末尾部分，与真实邮件路径相同。
- 同一内容字节是否确定：示范包按传入的 now 生成，同一 now 同字节（有测试）；邮件日期按连接时刻和固定时区计算。
- 自动检查：`test/integration/demo-data.test.ts`、`proactive-production.test.ts` 的 [P6-demo]、startup-configuration 的 [P6-demo]、proactive-interactions 的 [P6-demo]，含反向用例。
- 新值的使用处：示范令牌 `demo-inbox:v1:<locale>:<anchor>` 存在 sealed 的连接里，只由 demo reader 解析；demoInbox 配置值由 isDemoLocale 校验。

请重点看：假收件箱能否在任何情况下向 Google 发请求或被当成真实令牌；断开/重连流程；配置二选一的校验；示范包能否在导入时出错；时区和日期计算。
