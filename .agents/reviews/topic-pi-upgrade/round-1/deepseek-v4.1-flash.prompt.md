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
仓库就是当前目录，已检出 6eae66805fe50ee2395edb754c5ef006eafe0b26。
问题、目标和约束：
# 问题、目标和约束

## 问题
Himawari（本仓库）用 Pi（https://github.com/earendil-works/pi ，官网 https://pi.dev ）的两个包：`@earendil-works/pi-ai` 和 `@earendil-works/pi-coding-agent`，都锁在 0.84.2（`packages/runtime-pi/package.json:10-11`）。Pi 最新发布版是 1.5.0（2026-11-02，tag `v1.5.0`）。两个问题：

1. 升到 1.5.0，0.84.2 之后的破坏性改动都要改好，测试全过。
2. 主人的要求原话：“如果我们在 Himawari Agent 里面写的一些东西，在 Pi 的这些模块里已经做了相应功能的话，就直接用 Pi 的，我们就不自己写了。” 要把 Himawari 自有代码和 Pi 1.5.0 的各模块逐项对照，写“换成 Pi / 保留我们的 / 理由”。主人另要求：Pi 的功能以 Pi 官网或官方 GitHub 仓库为准；怎么接入 Pi 以 Pi 官方文档和社区成熟做法为准。

## 已核对的事实（一手来源）

Pi 1.5.0 官方仓库 `packages/` 下的包（README.md “Packages” 表和目录）：pi-ai、pi-agent-core（packages/agent）、pi-coding-agent、pi-durable（README 开头：“**Experimental.** The API changes without notice between releases.”，持久化会话/任务/文档运行时，SQLite 或 JSONL 存储，崩溃后 resume，任务 sleep/wake，压缩，用量费用）、chord（插件宿主、复制状态、RPC）、pi-telemetry（与厂商无关的遥测契约，没有导出器）、pi-tui（终端界面）、pi-mcp（独立 MCP 客户端）、pi-codemode（QuickJS 沙箱跑模型写的 JS，只能调注入的工具）、pi-schema（不用 eval 的 JSON Schema 校验）、pi-env（让 pi-durable 的工具在远端机器经 SSH 执行）。`pi-client`、`pi-protocol` 已停发（packages/chord/CHANGELOG.md:122 “Removed `@earendil-works/pi-client`, `@earendil-works/pi-protocol`, and `@earendil-works/pi-server` ... they are no longer released”）。另有独立仓库 earendil-works/gondolin（“Alpine Linux sandbox for running untrusted code with controlled filesystem and network access”）。

Pi 官方 README “Permissions & Containerization”：“Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access.”

0.84.2 → 1.5.0 影响 Himawari 的破坏性改动（原文见各包 CHANGELOG.md）：
- pi-ai 0.86.0：`StreamFunction` 输入从 `Context` 换成 `TranscriptContext`，系统提示和工具改放在 transcript 的 system 消息里，用 `getCurrentSystemPrompt()`、`getCurrentTools()` 读。ai/README.md “System Messages”：中途可以追加 system 消息改提示或工具（toolsAdded/toolsRemoved）；对不支持的模型自动折叠到开头。`openai-completions` 默认 `supportsMidConvoSystemMessages: false`（packages/ai/src/api/openai-completions.ts:1671）。
- pi-ai 0.86.0：`ToolCall.arguments`、`ToolResultMessage.details` 限定为 JSON 值。
- pi-coding-agent 0.87.0：“Made `SessionManager` canonical for `AgentSession` provider context. Assigning `session.agent.state.messages` no longer replaces future request history; restore with `SessionManager.inMemory(cwd, { id }, entries)` ... or append through `session.sessionManager` and call `session.refreshContext()`.” 官方 SDK 文档（packages/coding-agent/docs/sdk.md）：“Restore external history by constructing the session with a manager containing those entries.”
- pi-coding-agent 0.87.0：删 `shouldStopAfterTurn` 改 `finishTurn`；`TurnEndEvent` 字段变多。
- pi-ai 1.4.0：请求选项 `telemetryContext` 改名 `telemetry`。
- pi-ai 1.5.0：不再导出 TypeBox；工具参数用 pi-schema 校验。
- Node 要求 >=22.19（我们锁 22.22.3，`ci/toolchain-lock.json`）。

试升结果（临时分支，只改两包版本号，`npm install`，未改代码）：
- `tsc` 报 8 处错：`pi-runtime-adapter.ts:930`（`clampMaxTokensToContext` 要 TranscriptContext）、`:1570`（`requested.tools` 不存在）、`:1590`（StreamFn 类型）、`pi-tool-batch-continuation.ts:97`（`systemPrompt` 只读）、`prepare-file-mutation.ts:64`、`sandboxed-coding-executor.ts:54`（JsonObject）、两个测试文件。
- `packages/runtime-pi` 测试：405 条里 48 条失败（修好测试夹具对旧版嵌套 pi-ai 路径的引用之后；修之前 64 条）。主要是 `prompt-prefix.compat.test.ts` 等 19 条 `PI_RUNTIME_ERROR`（自定义 streamFunction 读 `requested.tools`、改 systemPrompt 的写法在新版失效）、`pi-tool-batch-continuation` 恢复失败、内置 bash 工具描述文字变了（“Shell command to execute”）。未升级的 main 上同一批测试全过。
- 1.5.0 安装后只剩一份 pi-ai（0.84.2 时 pi-coding-agent 下面另有一份嵌套的 pi-ai）。

社区做法（一手来源）：Pi README 点名的真实集成 OpenClaw（https://github.com/OpenClaw/OpenClaw ）在 2026.5.22 版 “internalize the former Pi agent runtime into OpenClaw, remove legacy package dependencies”（CHANGELOG/2026.5.22.md:29），现在只依赖 pi-tui（docs/agent-runtime-architecture.md）；同一版 “disable the embedded pi-coding-agent runtime auto-retry so OpenClaw's own retry and failover loop does not replay failed tool calls through a nested SDK retry”（:255）。

Himawari 现状要点（请自己读代码核对）：
- 只有 `packages/runtime-pi` 能导入 Pi（`.agents/instructions/pi-and-workspace.md`：“只能在 `packages/runtime-pi` 中导入 `@earendil-works/pi-*` 包”）。
- runtime-pi 约 5800 行：`pi-runtime-adapter.ts`（建会话、自定义 streamFunction、冻结系统提示和工具、出口遮盖、准入、历史预填 `prehydrateSession`）、`pi-tool-batch-continuation.ts`（工具批次挂起/恢复，审批后续跑）、`pi-native-history.ts`、`legacy-pi-history.ts`、`egress-context.ts`、`pi-model-transport.ts`、`configured-model-binding.ts`（只走 openai-completions，经 Magpie 或 Vercel AI Gateway）、`pi-tool-progress-guard.ts`（工具死循环检测）、`governed-*`、`sandboxed-coding-executor.ts`、`host-read-only-executor.ts`、`cache-usage-observation.ts`、`gateway-observation.ts`、`model-output-budget.ts`。已关闭 Pi 自带重试（`retry: { enabled: false }`）、已用 Pi 的 compaction。
- 其他包：application（运行编排、审批、检查点、提醒、后台任务、模型路由和备选）、persistence-sqlite（自有 SQLite 存储和迁移）、runtime-sandbox（bwrap 沙箱、出口代理、Linux 主机守护）、platform-node（用官方 `@modelcontextprotocol/client` 做 MCP 客户端，`exa-public-search.ts`、`capabilities/node-capability-runtime.ts`；`runtime-observability.ts` 指标）、memory-engine、sensitive-capture（敏感信息识别）、gateway-contracts、execution-contracts。

## 目标
1. 一份升级到 1.5.0 的方案：每处破坏性改动按 1.5.0 源码和官方文档的推荐做法改，拆成几个 PR。
2. 一张对照表：Himawari 自有的每一块功能 vs Pi 1.5.0 的模块，逐项写“换成 Pi / 保留 / 以后再评估”和理由。凡是 Pi 已有同样功能、又满足下面的硬规则的，就换成 Pi 并删掉自己的代码。

## 约束（硬规则，Pi 版本满足不了的要保留我们的并写清差别）
- 用户主权、权限审批：工具执行要过 Himawari 的授权和审批，可挂起、可恢复。
- 出口遮盖：发给模型前遮盖敏感信息，回来再还原（`.claude/rules/prompt-prefix.md` 第 5、11 条）。
- 发给模型的内容只追加：已发内容不得改、重排、删除；系统提示和工具按对话冻结（`.claude/rules/prompt-prefix.md` 第 4、6 条；阻断检查 `npm run check:prompt-prefix`）。升级本身可能让所有对话的请求开头变一次，主人 11-09 说过不用为旧聊天记录做兼容，但要写进 ADR。
- 数据自持：数据存在主人控制的机器上。
- 依赖版本精确锁定；只有 runtime-pi 能导入 Pi（要改这条要单独提出）。
- 不许写死，能动态获取的一律动态。不得调用贵模型。
- 修 bug 找根因；大改动先出方案。

请读本仓库代码，并到 https://github.com/earendil-works/pi/tree/v1.5.0 读 Pi 1.5.0 源码和文档（packages/*/README.md、packages/coding-agent/docs/sdk.md、sessions.md、compaction.md、custom-provider.md、packages/ai/README.md）。上面提到的做法只作参考，不要局限于此，请从问题本身出发提出你认为最好的方案。
