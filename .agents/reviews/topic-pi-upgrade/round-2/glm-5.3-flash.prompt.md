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
仓库就是当前目录，已检出 6eae66805fe50ee2395edb754c5ef006eafe0b26。
待审核的方案：
# 待审方案：Himawari 升级 Pi 0.84.2 → 1.5.0，并把能换的换成 Pi

## 前提和来源
1. Pi 不带权限系统。https://github.com/earendil-works/pi/blob/v1.5.0/README.md “Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access.”
2. 恢复历史的官方做法：packages/coding-agent/docs/sdk.md “Restore external history by constructing the session with a manager containing those entries. Assigning `session.agent.state.messages` does not replace persisted context.” `SessionManager.inMemory(cwd?, options?, entries?: FileEntry[])`（session-manager.ts）。
3. 1.5.0 的 `AgentState.messages` 里带 system 消息，`systemPrompt` 是只读 getter：packages/agent/src/agent.ts:90 `get systemPrompt()`（返回 `getCurrentSystemPrompt(messages)`）。
4. openai-completions 默认把中途 system 消息折叠到开头：packages/ai/src/api/openai-completions.ts:1671 `supportsMidConvoSystemMessages: false`；Himawari 只走 openai-completions（configured-model-binding.ts:72）。
5. Pi 1.5.0 在两种情况下会追加 `context_edit` 把失败的那次回答从模型上下文里拿掉：自动重试（agent-session.ts:3868）和上下文溢出恢复（:3124，紧接着压缩）。Himawari 已关自动重试（pi-runtime-adapter.ts:1361），开着压缩（:1360）。
6. pi-durable 是实验性：packages/durable/README.md “**Experimental.** The API changes without notice between releases.”
7. pi-client、pi-protocol 已停发：packages/chord/CHANGELOG.md:122。
8. 社区：OpenClaw 2026.5.22 把 Pi agent 运行时收回自己维护（CHANGELOG/2026.5.22.md:29），并关掉 Pi 内置重试以免重放失败的工具调用（:255）。
9. 只有 runtime-pi 能导入 Pi：.agents/instructions/pi-and-workspace.md。
10. 试升实测：tsc 8 处错，runtime-pi 测试 48/405 失败；main 上同一批全过。
11. Andy 11-09：不为以前的聊天记录、旧数据做兼容。

## 一、升级（PR-1，一个 PR 做完，测试全过才合）
1. 两包改 1.5.0，重锁；测试夹具改为直接导入 `@earendil-works/pi-ai`（1.5.0 只剩一份）。
2. 自定义 streamFunction 收 TranscriptContext：用 `getCurrentSystemPrompt`/`getCurrentTools` 读出 Pi 给的提示和工具，和冻结 bundle 比对，不一致就拒绝发送（fail closed）；再用 pi-ai 导出的 `normalizeContext({ systemPrompt: 冻结提示, tools: 冻结工具 + 本轮执行句柄工具, messages: 去掉 system 后的历史 })` 生成请求。出口遮盖图例改为追加到这条开头 system 消息（和现在一样每次确定地追加）。`clampMaxTokensToContext` 直接收它。
3. 工具批次恢复：不再给 `state.messages`、`state.systemPrompt` 赋值。在 `prehydrateSession` 时把批次的 prefix 追加进 SessionManager（Pi 官方路径，前提 2），系统提示继续走已有的 `systemPromptOverride`；`takeReplay` 回放已存的 assistant，不重新请求模型。快照升到 v3，不再存系统提示；v2 不兼容：遇到 v2 明确报错、这一批按“需要重新开始”处理（前提 11），不悄悄执行。
4. 存历史时过滤掉 `role: "system"`（前提 3），`pi-native-history` 继续拒绝 system 角色。
5. `validateToolArguments` 两处调用：参数先过一个 JSON 值检查（拒绝 undefined、BigInt、Map 等），不用类型强转；工具结果 `details` 构造时不放 undefined 字段。
6. 内置工具文字跟随 Pi 1.5.0 新文字，更新快照测试；矛盾检查（C6/C10）按新原文重新核对。
7. `context_edit`（前提 5）：只会出现在溢出恢复，和压缩同时发生，归入 prompt-prefix 规则第 12 条的“压缩”例外，写进 ADR；在 `check:prompt-prefix` 加反向用例：普通轮次出现 `context_edit` 必须报失败。
8. 删掉没人调用的 `legacy-pi-history.ts`（只被自己的测试引用）。
9. `check:prompt-prefix` 必须过；新增反向用例：请求中途出现非开头的 system 消息必须判为破坏。升级让所有对话的请求开头变一次，ADR 记为一次性例外。
10. 对我们有利、要验证不违反硬规则的新行为：坏 JSON 参数不再执行（1.3.0）、换模型丢掉别家思考块、更多网关错误分类、工具参数流式解析省内存（1.5.0）。

## 二、对照表（Himawari 自有 vs Pi 1.5.0）
| Himawari | Pi 对应 | 决定 | 理由 |
|---|---|---|---|
| Agent 循环、内置工具本体、工具参数校验、输出截断、压缩 | pi-coding-agent / pi-ai | 已经用 Pi，继续用 | — |
| 历史预填、批次恢复 | SessionManager 条目 | 换成 Pi 的官方路径（PR-1 第 3 条） | 前提 2 |
| 系统提示和工具按对话冻结 | 1.x 的 transcript system 消息 | 保留我们的“何时冻结、何时换新”，表达方式换成 Pi 的 transcript | 前提 4：我们走的接口会把增量折叠到开头 |
| 出口遮盖 | 无 | 保留 | 硬规则 |
| 审批挂起和恢复 | 无（pi-durable 的 beforeTool 只能拦） | 保留，变薄 | 前提 1 |
| 死循环检测 | 无 | 保留 | — |
| 重试、备选模型、准入、预算 | Pi 自动重试 | 保留自己的，继续关 Pi 的 | 前提 8 |
| 缓存/网关用量观测 | Usage（cacheRead、1.5 的 responseModel、totalFromProvider） | PR-2：能从 Pi Usage 读到的不再自己解析，网关专有的头保留 | 小改 |
| 运行持久化、恢复、提醒、后台任务 | pi-durable | 本次不换，另开评估 | 前提 6；等于重写核心 |
| 沙箱 | gondolin、pi-env | 保留 | 前提 1；微虚拟机要另做生产机资格验证 |
| MCP 客户端（官方 SDK） | pi-mcp | 保留 | 不是自己写的代码；换了要改前提 9 |
| 指标 | pi-telemetry（只有契约） | 以后再评估 | 没有导出器 |
| 记忆、敏感信息识别、权限、数据分级 | 无 | 保留 | Pi 不做 |
| pi-tui、chord、pi-client/protocol、codemode | — | 不适用 | 终端界面 / 已停发 / 新功能不是替换 |

## 三、拆 PR
- PR-1：升级本身（第一部分全部）。
- PR-2：用量观测改读 Pi 的 Usage 字段。
- 以后另开：pi-durable 评估；压缩请求沿用冻结开头（规则 13 已知缺口，可用 `session_before_compact`）。

## 四、要 Andy 拍板
1. pi-durable 要不要另开评估。
2. 升级时所有对话缓存断一次（他已说不为旧记录兼容，只是告知）。
