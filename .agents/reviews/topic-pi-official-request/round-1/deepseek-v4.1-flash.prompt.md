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
仓库就是当前目录，已检出 e2561a042af4b6f09d372ce66138e47c6535493e。
问题、目标和约束：
# 题目：Himawari 每次请求模型的代码，能否改回 Pi 官方写法

## 问题
Himawari 用 Pi（npm 包 @earendil-works/pi-coding-agent 与 pi-ai，官方仓库 https://github.com/earendil-works/pi ）当 Agent 循环。当前在 `packages/runtime-pi/src/pi-runtime-adapter.ts` 约第 1617–1655 行把 `session.agent.streamFunction` 整个替换成自己的函数。Andy 的要求：Pi 官方有写法就照官方；官方写法有缺口时才自己设计，且要出方案给他看。

## 目标
找出：这个替换里的每一项职责，哪些能改用 Pi 官方接入点（扩展钩子、注册服务方），哪些官方确实做不到必须保留自己的；给出推荐路径和代价。

## 现在这个替换函数做的事（读代码核对）
1. 压缩请求识别：session.subscribe 里 compaction_start/end 设 `compacting` 标志；压缩时用 Pi 自带的摘要系统提示（himawariSummaryContext）。
2. 聊天请求：丢掉 Pi 放在 transcript 里的全部 system 消息，换成按对话冻结的系统提示和工具（himawariRequestContext）；冻结工具名与 Pi 当前能执行的工具名不一致就一次请求都不发（PI_REQUEST_TOOLS_DIVERGED）。
3. 审批续跑：`restored.takeReplay()` 直接回放已存的那次回答，不调模型。
4. 已暂停/结果未知/循环保护（toolProgress.blocked）时返回失败流，不发请求。
5. `admitPiStream`（约 941 行起）：预算准入（admission.begin 拿 permit、markStarted、settle 记账、失败 markUnknown）、出口遮盖（egress.exchange 包 fetch，回复流还原占位符 restoreModelStream，系统提示末尾追加遮盖图例）、用量记录、网关选项、密钥每次请求才从主机取（apiKey 传入）、maxRetries 0、窗口耗尽检查。
6. 另外：`himawari-system-prompt` 扩展在 before_agent_start 返回同一份系统提示（资源加载器也已用 systemPromptOverride 给了同一份）；`himawari-provider-observer` 扩展已用 before_provider_request 观察请求体。

## 硬约束
- 发给模型的内容只能往后追加；系统提示和工具按对话冻结；同一对话请求开头逐字节不变（.claude/rules/prompt-prefix.md，npm run check:prompt-prefix 会检查）。
- 出口遮盖不能丢：发出去的每个字节都要先过遮盖，回复里的占位符要还原。
- 预算准入不能丢：没拿到 permit 不得发请求；失败要记 unknown，不能漏记也不能少记。
- 压缩请求也必须经过准入和遮盖。
- 不得写死；密钥不进 Pi 的凭据库。
- 不要求兼容旧数据（Andy 允许彻底改，但缓存前缀规则仍要守）。

## 已核对的事实（来源：npm 包 @earendil-works/pi-coding-agent@1.5.1 的 docs/ 与 dist/，项目锁 1.5.0）
- docs/extensions.md 第 352–359 行：一次模型请求的钩子顺序 `context` → `context_with_system` → `before_provider_headers` → `before_provider_request` → `after_provider_response` → `provider_stream_event`。
- docs/extensions.md 第 831 行：context_with_system “The returned messages are sent as they are: this hook owns the prompt and tool declarations for the request.” 第 844 行规则：下标 0 必须是 system 消息。
- dist/core/extensions/runner.js emitContext：钩子抛错只 emitError（记录），请求照常用未改的消息继续；也就是钩子本身不能“失败就不发”。
- dist/core/sdk.js 约 261–272 行：Pi 默认的 streamFn 里，会话请求先 `cacheWarmer.start(...)` 再 `modelRuntime.streamSimple(...)`；替换 streamFunction 会绕过缓存预热。
- dist/core/agent-session.js 约 2305、3443、3685 行：压缩和分支摘要都用 `this.agent.streamFunction` 发请求，摘要的系统提示是 Pi 自带的 SUMMARIZATION_SYSTEM_PROMPT（compaction/compaction.js 约 500 行），不是会话系统提示。
- docs/custom-provider.md 第 164–176 行：协议相同就在注册的服务方里委托 Pi 内置 API 实现；示例 examples/extensions/custom-provider-gitlab-duo/index.ts 在自己的 streamSimple 里调 `openAIResponsesApi().streamSimple(...)`。自写流必须遵守 options.onPayload、onResponse、onProviderStreamEvent、signal。
- docs/sdk.md 第 40 行：SessionManager 是历史权威，给 agent.state.messages 赋值无效。
- ModelRuntime 在 Himawari 里是进程内共享的（configured-model-binding.ts 约 367–395 行用 registerProvider(provider, ProviderConfig) 注册；另有 pi-model-transport.ts 约 372 行的后台调用也经 binding.modelRuntime.stream 且有自己的准入路径）。每个会话用 Proxy 包一层（pi-runtime-adapter.ts 约 639 行 sessionModelRuntime）。
- 1.5.1 相对 1.5.0 在这块文档无实质变化（extensions.md 只新增说明：before_provider_request 的 payload 对“接续上次回答”的服务方可能只含新增部分）。

## 请你做的
读代码和 Pi 包/官方仓库，独立提出你认为最好的做法（可以是完全保留、完全改成官方写法、或混合），逐项说明每个职责放在哪个接入点、官方写法缺什么、失败时是否仍然“不发请求”、对缓存前缀与 check:prompt-prefix 的影响、需要改哪些文件和测试、风险。
