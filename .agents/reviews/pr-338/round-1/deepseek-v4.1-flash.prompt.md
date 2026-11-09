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
仓库就是当前目录，已检出 c4df673b6b921dc6f4fef90074fc0c0b536a37d3。
对比基准是 6eae66805fe50ee2395edb754c5ef006eafe0b26，先运行 git diff 6eae66805fe50ee2395edb754c5ef006eafe0b26..c4df673b6b921dc6f4fef90074fc0c0b536a37d3 看改动。
作者的说法（可能有错，请核对）：
# PR 338：Pi 0.84.2 升到 1.5.0

## 问题和目标
Himawari 只在 packages/runtime-pi 里用 Pi（@earendil-works/pi-ai、pi-coding-agent）。把两个包从 0.84.2 升到 1.5.0，修掉全部不兼容，测试全过；同时守住几条硬规则：发给模型的内容只往后追加、系统提示和工具按对话冻结（.claude/rules/prompt-prefix.md）、审批挂起后续跑不重复执行已完成的工具、出口遮盖不变。

## 已核对的 Pi 1.5.0 事实（来源在 docs/adr/0198-upgrade-pi-to-1-5-0.md 的“前提”一节）
- StreamFn 收到的是 TranscriptContext，只有 messages；系统提示和工具在 role:"system" 的消息里；normalizeContext 是生成它的唯一入口。
- SessionManager 是历史的唯一来源，给 agent.state.messages 赋值不影响请求；agent.state.systemPrompt 只读。官方恢复做法是 SessionManager.inMemory(cwd, options, entries)。
- Pi 只在自动重试和溢出/截断恢复时追加 context_edit；后者紧接着压缩。Himawari 设置里关了自动重试。
- openai-completions 默认把中途 system 消息折叠到开头。

## 这次的改动
- pi-runtime-adapter.ts：himawariRequestContext 去掉 Pi 的 system 消息，用冻结提示和冻结工具（加执行句柄工具）组成 Context，再在 admitPiStream 里 normalizeContext(withPlaceholderLegend(context))；Pi 当前工具名集合和声明不一致时返回失败流。存历史时过滤 system 消息。续跑时用快照条目建 SessionManager，而不是按对话历史重建。
- pi-tool-batch-continuation.ts：快照 v3 存会话条目（挂起那次回答之前）、冻结提示、回答和已完成结果；续跑前核对冻结提示一致；inspectPiToolBatch 遇到非 v3 返回 undefined，production-tool-result-recovery.ts 跳过它。
- json-tool-arguments.ts：执行 Pi 内置工具前做 JSON 值检查。
- scripts/ci/security-exceptions.mjs、check-security.mjs：main 上已接受的例外里，指向已不在锁文件里的依赖的条目不再参与校验（以前会让依赖升级的 PR 永远报 SECURITY_EXCEPTION_DEPENDENCY_UNKNOWN）；候选清单仍严格校验。
- 测试、ADR 0198、规则文字、README、案例库。

## 已运行
packages/runtime-pi 全部 unit 和 pi-compat 测试、相关 16 个集成测试文件、security 相关 tooling 测试、npm run check（44/46，没过的 2 步在未改动文件里，main 上同样失败）、npm run build。另用同一份 Context 分别在 0.84.2 和 1.5.0 下生成 openai-completions 请求体，逐字节相同。
