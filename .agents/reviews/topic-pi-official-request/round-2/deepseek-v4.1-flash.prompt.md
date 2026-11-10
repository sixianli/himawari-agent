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
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、问题、证据（文件:行引用的代码，或网址和原话）、你建议怎么改。把「证实的」和「推测」分开写。最后写：如果由你来定，你会怎样改这份方案，并逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 e2561a042af4b6f09d372ce66138e47c6535493e。
待审核的方案：
# 线程方案 v2：D1（替换 `session.agent.streamFunction`）怎样靠近 Pi 官方写法

## 事实（均已读源码/文档核对，Pi 1.5.0 与 1.5.1 在这块无差别）
F1. `context_with_system` 钩子“owns the prompt and tool declarations for the request”（docs/extensions.md 第 831 行）；钩子抛错只记录，请求用未改消息照发（runner.js emitContext 的 catch）——钩子本身做不到“失败就不发”。
F2. `before_agent_start` 返回的 systemPrompt 会在钩子之后再投影一次、盖掉钩子写的头（docs/extensions.md 第 844 行；agent-session.js `_installAgentForcedPromptProjection`）。
F3. 压缩/分支摘要直接用 `this.agent.streamFunction`，不经过 context 钩子；摘要系统提示是 Pi 自带的 SUMMARIZATION_SYSTEM_PROMPT，与 before_agent_start 无关。
F4. Pi 默认 streamFn（sdk.js 261–272）= buildRequestOptions → 会话请求时 cacheWarmer.start → `modelRuntime.streamSimple(...)`；缓存预热里也是 `models.streamSimple(...).result()`，所以对 `streamSimple` 的包装必须同步返回流（cache-warmer.js 183 行）。
F5. 今天 Himawari 的替换函数最内层仍调用被替换前的 Pi 默认函数（admitPiStream 里的 `original(...)`），所以缓存预热没有被绕开；没预热的真正原因是模型没填 `promptCache`、设置没开 `cacheWarming`（我先前简报里“绕过预热”一句是错的，已更正）。Pi 1.5.0 的 `cacheWarming` 默认是 "streaming"，没填 promptCache 就不预热。
F6. 注册服务方（registerProvider）是进程级共享的，`streamSimple(model, context, options)` 里没有 runId/owner/permit/暂停状态；Himawari 已经为每次运行建一个 `sessionModelRuntime(binding)` 的 Proxy 传给 `createAgentSession`（pi-runtime-adapter.ts 约 639、1558 行）。
G1. 官方没有“不调模型直接回放已存回答”的写法（审批续跑，偏离 D3）。

## 方案
S1（D6，单独就能做）：删掉 `himawari-system-prompt` 扩展（`before_agent_start` 返回系统提示）。理由：资源加载器已用 `systemPromptOverride` 给了同一份提示；当前替换函数从不读 Pi 的头内容，只读 Pi 声明的工具名做一致性检查；压缩不受影响（F3）。要用逐字节对比和 check:prompt-prefix 验证请求体完全不变。做 S3 前必须先做（F2）。

S2（D1 主体）：不再赋值 `session.agent.streamFunction`。把现在替换函数里的全部职责（压缩识别、换冻结头、暂停/未知/循环保护拒发、审批回放、admitPiStream 的准入/遮盖/用量/密钥/网关）搬到每次运行的 `sessionModelRuntime` Proxy 的 `streamSimple` 上，Pi 的默认 streamFn（含预热、请求选项整理、before_provider_headers）原样保留在外层，里面调 `target.streamSimple`。`streamSimple` 同步返回一个输出流，准入在后台异步驱动（F4）。每次运行的状态（request、冻结提示/工具、restored、suspended、toolProgress、compacting）通过闭包 state 惰性读取。后台调用（pi-model-transport）仍用共享运行时，不受影响。设置里显式 `cacheWarming: "off"`，等 D7 定了再开。

S3（头部官方化，取舍项）：新增隐藏扩展，在 `context_with_system` 里返回 `[冻结头, ...非 system 消息]`（冻结头用公开的 `normalizeContext({systemPrompt, tools, messages: []}).messages[0]` 生成，与现在字节一致）；S2 的包装层只“校验头等于冻结头，不等就拒发”（因为钩子 fail-open，F1）。不做 S3 的话，包装层自己换头，行为等价但头部是在自写代码里换的。

## 要改的文件/测试
pi-runtime-adapter.ts（删 1617–1651 的赋值与 himawari-system-prompt；sessionModelRuntime 扩成带 streamSimple 覆盖；admitPiStream 的 `original` 换成 `target.streamSimple`）；4 个测试文件里 stub `agent.streamFunction` 的地方迁到新接缝（pi-runtime-adapter.compat.test.ts、model-accounting.unit.test.ts、pi-tool-batch-continuation.compat.test.ts、runtime-event-contract.unit.test.ts）；新增：旧新两版对同输入生成请求体逐字节相等、钩子抛错/未注册时一次请求都不发、压缩和审批回放仍经准入、预热请求不会被当聊天请求（暂时靠 cacheWarming off + 无 promptCache）。docs/pi-development-guide.md 第五节 D1/D6 两行、新 ADR。

## 已知风险
- 包装层如果漏校验，钩子失效时会发 Pi 自己的头；需反向用例。
- `admitPiStream` 里 `model !== binding.model` 的对象身份检查在新接缝下要重新核对。
- 摘要鉴权：现在替换后的函数不在 Pi 的“运行时 streamFn”登记表里，摘要走 `getAuth` 预解析；改回默认 streamFn 后摘要不预解析凭据，要确认包装层自己取密钥（admitPiStream 已每次 resolveSecret 并删掉环境 apiKey）后行为不变。
- D7 以后打开预热时，预热请求会进包装层，要有标记区分（`disableContinuation` 等）。

## 要 Andy 拍板
1. 是否接受“每次运行的 ModelRuntime 代理上的 streamSimple 包装”作为 D1 唯一保留的偏离（官方钩子不能失败即拒发、服务方没有运行状态）。
2. S3 要不要做（头部放官方钩子 + 包装层校验，还是包装层自己换头）。
