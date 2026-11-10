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
你的额外侧重：测试有没有覆盖这次改动、文档和规则与代码是否一致；挑一条最普通的使用流程，从入口走到结束，标出经过的、没有测试覆盖的代码路径。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你走过的流程和结论。
输出格式：按严重度从高到低排列，每条写：严重度、文件:行、问题、证据（引用你亲自读到的那几行代码）、建议。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 d76066f1b81cb2e59eda19b00041770dca45948a。
对比基准是 6557219861106b52321416b4d62a19c8b92601a9，先运行 git diff 6557219861106b52321416b4d62a19c8b92601a9..d76066f1b81cb2e59eda19b00041770dca45948a 看改动。
作者的说法（可能有错，请核对）：
# 作者说明

这个 PR 把 Pi 二次开发规范里的偏离 D4 改回官方写法（docs/adr/0204-pi-native-provider-auth.md，方案 https://claude.ai/artifact/S3X53E7x5xHGS7FTUQG8Nk，Andy 已同意开工）。

做了什么：
- `packages/runtime-pi/src/configured-model-binding.ts`：用 `createProvider` + `runtime.registerNativeProvider` 注册模型服务方，注册后 `await runtime.refresh({ allowNetwork: false })`；`auth.apiKey.check` 固定返回已配置、不读密钥；`resolve` 只在 Himawari 经 `apiKey` 选项传入密钥时原样返回，否则返回 undefined；流式实现用官方 `openAICompletionsApi()`。
- `packages/runtime-pi/src/pi-runtime-adapter.ts`：删除用 Proxy 改写 `hasConfiguredAuth` 的 `sessionModelRuntime`；准入、取密钥、传 `apiKey` 的代码（`admitPiStream`）没动。
- 测试：第一个提交先用旧写法录下 magpie 与 vercel-ai-gateway 的请求（方法、路径、请求头、原始请求体）存成 `packages/runtime-pi/test/fixtures/d4-golden-requests.json`；第二个提交换写法后逐字节比对通过；新增 `[D4]` 契约测试（真实 Pi 运行时，不读密钥、凭据库为空、环境变量里的密钥不被取用）。
- 文档：新增 ADR 0204，规范 D4 行改为已关闭，D7 行补了缓存预热绕过准入的事实，重写 architecture-v0.1.md 第 647 行附近。

已知取舍（Andy 经协调者同意）：`check` 恒返回已配置；缓存预热的准入和预算归 D7，这个 PR 不碰。

我做过的验证：改写前后请求字节一致；变异验证（check 返回 undefined、resolve 凭空给密钥、改 maxTokensField）测试都会失败。没有跑 Hermes 上的测试。

请特别看：`resolve` 会不会在准入之前读到密钥；Pi 内置 `vercel-ai-gateway` 被整体替换后有没有 Himawari 还在用的东西丢了；`registerNativeProvider` 后的快照刷新有没有时序问题；golden 文件和测试里有没有会让别的机器上失败的不稳定字段。
