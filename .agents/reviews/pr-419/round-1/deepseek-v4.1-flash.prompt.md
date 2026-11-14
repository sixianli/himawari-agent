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
仓库就是当前目录，已检出 670f950743ac0b039a4862ce4300986bbec6477e。
对比基准是 44a0e332b4550b0ef7fdbb663552812d9b21fc97，先运行 git diff 44a0e332b4550b0ef7fdbb663552812d9b21fc97..670f950743ac0b039a4862ce4300986bbec6477e 看改动。
作者的说法（可能有错，请核对）：
# PR 419 作者说明

## 问题
2026-11-12 手机发消息，上游模型服务返回 HTTP 429，Himawari 对 429 不重试，直接向用户报"模型服务当前限流"。生产日志（已核对）：这一轮 429（provider_status_429），数据库没堵。

## 目标
模型请求遇到偶发的 429/503 等暂时性失败时，在请求层自动重试最多 2 次，用户无感；不破坏"发给模型的内容只追加"、缓存命中、准入/预算/用量记录。

## 约束
- Pi 自带的自动重试必须仍然关着：它会追加 context_edit，改变已发出的内容（docs/adr/0198-upgrade-pi-to-1-5-0.md）。
- Vercel 网关请求观察器原来规定每次调用只发一次请求（packages/runtime-pi/src/gateway-observation.ts），和计费核对绑定。

## 已核对的事实
- pi-ai 的 `maxRetries`/`maxRetryDelayMs` 选项走 `retryProviderRequest`（node_modules/@earendil-works/pi-ai/dist/utils/provider-retry.js）：只重试 408/409/429/5xx 和连接错误，先看 retry-after-ms、retry-after，没有则指数退避；服务方要求等得比上限久就立刻抛 "Server requested Ns retry delay (max: Ms). <原错误>"。
- 此前 Himawari 传 `maxRetries: 0`。现在传 2 和 10_000 ms。
- 新增 `provider-rejection-observation.ts` 记录每个非 2xx 响应（状态码、retry-after、x-should-retry、主机名）；service-main 写日志 `model.request_rejected`。
- 改动文件：packages/runtime-pi/src/{pi-runtime-adapter,gateway-observation,provider-rejection-observation}.ts，apps/agent-service/src/{service-main,production-run-composition}.ts，测试，ADR 0245，规则文档两处。
- `production-model-composition.unit.test.ts` 有 18 条测试在没有本改动的 main 上同样失败（PI_MODEL_RUNTIME_CONFIGURATION_FAILED），不属于本 PR。

## 说明
这里列的做法只是参考，请从问题本身出发，指出你认为更好或更稳妥的做法；不要因为不在上面的清单里就忽略。
重点请看：重试在准入/预算/用量记录、出口遮盖（每次重发都重新走 wrapFetch）、网关观察器、压缩摘要请求、取消信号上的正确性。
