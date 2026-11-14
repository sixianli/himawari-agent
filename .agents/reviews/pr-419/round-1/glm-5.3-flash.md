# 复核报告：PR 419（请求层重试 429/503）

## 侧重检查（先写：走过的普通流程）

我走了一条最普通的聊天流程：用户消息 → `service-main` 的 tenant runtime → `production-run-composition` 组装适配器 → `PiAgentRuntimeAdapter.run` → `governedModelRuntime`（pi-runtime-adapter.ts:1661）→ `admitPiStream`（准入 `gate.begin` 一次、`permit.markStarted` 一次）→ 出口链 `observeCacheFields(observeProviderRejections(exchange.wrapFetch(...)))`（1132-1139）→（网关时再包 `observeGatewayFetch`，1141）→ pi-ai 模型调用带 `maxRetries: 2`（1171）→ 429 时 pi-ai 内部重发、每次重新走整条 fetch 链 → 成功后 `done` 事件 → 网关计费核对（927-943）→ `permit.settle` + `recordUsage` 一次（956-959）→ 历史只在 `message_end`/`compaction_end` 捕获（1804-1820）。

结论：
- 准入、预算、用量记录都是“每次调用一次”，重试不新增准入或用量记录（读代码证实）。
- 压缩摘要请求走同一个 `admitPiStream` 唯一调用点（1694），同样拿到重试和拒绝日志（读代码证实，ADR 说法与代码一致）。
- 没有测试覆盖的路径：`service-main.ts:2535` 新日志行的接线（全仓库无任何测试引用 `model.request_rejected` 或 `onModelRequestRejected` 的生产接线）；带敏感信息遮盖时的重试字节一致性；重试退避期间用户取消；网关路径上“拒绝后重发再成功”的计费核对（新单测只测到重发许可，没测计费）。
- 后台/标题调用（`PiModelTransport`，pi-model-transport.ts:376）仍是 `maxRetries: 0`，不在本次改动内——见下面第 2 条问题。

## 问题（按严重度从高到低）

**1.（高）遮盖状态跨重试残留，可能让“字节完全相同的重发”不成立**
- 文件：packages/application/src/services/model-egress.ts:130,223 + packages/sensitive-capture/src/redaction.ts:411-426 + packages/runtime-pi/src/pi-runtime-adapter.ts:1132-1139
- 问题：`Exchange` 实例（含 `#known` 表）在一次 `admitPiStream` 里创建一次，`wrapFetch` 闭包引用同一个实例，重试的每次重发共用它。遮盖规则里“密码/验证码被认出后记入 `known`，同请求里含该值的文本按 `named-earlier` 追加遮盖”（redaction.ts:320-326, 411-425），这是**依赖前文的遮盖**。第一次尝试发出后 `known` 已被填充；若 pi-ai 重试时按同一 context 重建请求体（见“推测”），则第二次重发时，排在“点名消息”**前面**的消息里的同一个值会被追加遮成占位符——与第一次尝试字节不同，同时偏离规则第 54 行“排在点名消息前面的消息不受影响”。
- 证据：model-egress.ts:130 `readonly #known = new Map<string, string>();`；223 `known: this.#known`（每次 `#prepare` 都传同一份）；redaction.ts:411-425 `if (known !== undefined && known.size > 0) { for (const [value, placeholder] of known) { … text.replace(pattern, …) } }`；pi-runtime-adapter.ts:1134 `exchange.wrapFetch(...)` 每次调用只包一次。
- 影响：ADR 0245 决定 1 和后果里“重试只重发同一份请求体/每次都带上同一份遮盖后的内容”在该场景不成立；重发请求历史中段字节变化 → 该次缓存整段失效（费用），并且发出的请求内容与上一次已发出的不同。
- 建议：在 `#prepare` 每次进入时恢复首次调用前的 `#known` 快照（重试语义=同一请求），或在 prompt-prefix 测试里加一条“验证码/密码跨消息出现 + 503 重试”的用例，断言各次尝试字节相同；现在 [ADR-0198] 用例（prompt-prefix.compat.test.ts:1186-1197）全是普通文本，抓不到这个。

**2.（中）标题等后台调用不在重试和拒绝日志范围内，而事故本身包含它们**
- 文件：packages/runtime-pi/src/pi-model-transport.ts:376
- 问题：`PiModelTransport`（后台调用：标题、邮件判断等，production-model-composition.ts:333,468）仍传 `maxRetries: 0`，也没有接 `observeProviderRejections`。ADR 0245 背景里写的事故正是“标题的后台调用也被同一上游限流”，决定 4 却说“每个被拒绝的响应写一行服务日志”。聊天流修好了，后台流还是一次就失败、且不留 `model.request_rejected` 日志。
- 证据：pi-model-transport.ts:376 `maxRetries: 0,`；`provider-rejection-observation` 全仓库只被 pi-runtime-adapter.ts:98-102,1133 引用。
- 建议：要么给 `PiModelTransport` 同样开 2 次重试并接拒绝观察（它的用量/计费走 `observations()`，路径独立，需单独核对），要么在 ADR 里明确写“只覆盖聊天与压缩请求，后台调用照旧”，避免文档与代码的“每个”不一致。

**3.（中）“Server requested …s retry delay”分类依赖 pi-ai 的确切报错文案，端到端测试不校验归类结果**
- 文件：packages/runtime-pi/src/pi-runtime-adapter.ts:450
- 问题：`providerStatusOf` 第二个正则硬编码了文案格式 `/^Server requested \d+s retry delay \(max: \d+s\)\. (\d{3})(?:\s|:)/`。pi-ai 的真实文案本仓库无法核对（`node_modules` 不存在）。单测（pi-runtime-adapter.compat.test.ts:2286-2291）只是把**假设的**文案喂进去；端到端反向用例（prompt-prefix.compat.test.ts:1220 之后那条 `REVERSE [RETRY-429]`）只断言 `runtime.failed` 事件类型和请求数，**不断言失败码**——若真实文案与假设有出入（例如秒数带小数、中文标点、状态码不在句首），分类会静默退化成 `PI_MODEL_ERROR`/`provider_message_withheld`，用户看到通用报错而非“模型服务当前限流”，没有任何测试会红。
- 证据：pi-runtime-adapter.ts:448-451；prompt-prefix.compat.test.ts:1177-1179 `outcomes.push(events.find((event) => event.type === "runtime.failed")?.type ?? …)`（只取 `.type`）。
- 建议：在 `REVERSE [RETRY-429]` 用例里同时断言 `runtime.failed` 事件的失败码是 `PI_MODEL_RATE_LIMITED`；升级 pi-ai 时把该文案列入 pi-development-guide 的升级检查项。

**4.（低）网关观察器对任何非 2xx 都放开重发，包括不可重试状态**
- 文件：packages/runtime-pi/src/gateway-observation.ts:164-166
- 问题：`if (!response.ok) { sent = false; return response; }` 对 400/401/402/403 和 3xx 也把 `sent` 复位。按作者说明，pi-ai 只重试 408/409/429/5xx 和连接错误（此点未核实），所以当前不会真的多发；但这个闸门的语义从“成功后只许一次”弱化成了“最后一个非 2xx 后允许任意多次”，未来 pi-ai 重试策略变化或新增调用方时没有防线。
- 建议：只对可重试状态码（408/409/429/5xx）复位 `sent`，其余保持只许一次；或至少加注释说明依赖 pi-ai 的重试集合。

**5.（低）重试会重复上报出口遮盖 sighting、重复累计 findings**
- 文件：packages/application/src/services/model-egress.ts:231-232,251
- 问题：每次 `#prepare`（即每次重试）都重新遮盖同一文本并 `#report(sightings)`、给 `#counts` 累加。同一次调用的遮盖日志会随重试次数重复，`findings()` 计数翻倍（`findings()` 目前只有测试消费，日志重复影响小）。
- 建议：`#report` 按 sighting 指纹去重，或明确接受重复。

**6.（低）生产接线无测试；`shouldRetry` 字段无任何断言**
- 文件：apps/agent-service/src/service-main.ts:2534-2544
- 问题：`model.request_rejected` 的接线（含 `host`、`retryAfter` 条件省略逻辑）没有端到端或组合测试；`ProviderRejection.shouldRetry` 在所有测试里都没被断言过（prompt-prefix.compat.test.ts:1203 收集时只取了 status/retryAfter/host）。
- 建议：在 `production-http-composition-process.test.ts` 加一条 429 用例断言日志行；`[RETRY-429]` 里补 `shouldRetry`。

**7.（提示）`REVERSE [RETRY-429]` 反向用例不能区分“功能被删”**
- 文件：packages/runtime-pi/test/prompt-prefix.compat.test.ts:1220 起
- 问题：该用例断言“retry-after 120s 超上限 → 立刻失败、只有 1 次请求”。把 `MODEL_REQUEST_MAX_RETRIES` 改回 0，此用例同样通过（同样是 1 次请求、同样 failed）。它锁住的是“不超时硬等”，不是重试功能本身；真正能发现回退的是 [ADR-0198] 用例的 `bodies` 长度 5（1186-1197）。
- 建议：给该用例补断言失败码（见第 3 条），使其在 pi-ai 行为变化时也有区分力。

## 读代码证实的（与作者说法逐条对照）

- `maxRetries` 0→2、`maxRetryDelayMs` 10_000：证实（pi-runtime-adapter.ts:444-445,1171-1172；diff 删除了 `maxRetries: 0`）。
- Pi 自带自动重试仍关着：证实（pi-runtime-adapter.ts:1491 `retry: { enabled: false, maxRetries: 0 }`）。
- 网关观察器改为“非 2xx 后允许重发、成功后再发报错、传输错误后重抛原错误”：证实（gateway-observation.ts:145-174，且与三条新单测一致）。
- `provider-rejection-observation` 记录 status/retry-after/x-should-retry/主机名、`service-main` 写 `model.request_rejected`：证实（provider-rejection-observation.ts:25-37；service-main.ts:2534-2544；`writeServiceDiagnostic` 接受任意字段并打码机器密钥，platform-node/src/service-runtime.ts:67-73）。但“每个被拒绝的响应”不成立——后台调用链不经过它（见问题 2）。
- “每次重发都重新走 wrapFetch”：证实（model-egress.ts:165-174，每次调用重新 `#prepare`）。但遮盖状态不重置（见问题 1）。
- 失败的尝试不进历史、不产生 `context_edit`：证实（历史只在 message_end/compaction_end 捕获，pi-runtime-adapter.ts:1804-1820；用量只在 done 结算一次，955-959；准入每调用一次，1093-1113）。
- 压缩摘要请求一并重试：证实（唯一 `admitPiStream` 调用点 1694，chat 与 summary 共用）。
- 规则文档两处与代码一致：证实（.claude/rules/prompt-prefix.md:74 与测试相符；docs/pi-development-guide.md:326 与常量相符）。
- 改动文件清单：与 diff 一致。

## 推测（未能核实）

- pi-ai `provider-retry.js` 的行为（只重试 408/409/429/5xx 和连接错误、先看 retry-after-ms/retry-after、否则指数退避、超上限抛 "Server requested Ns retry delay (max: Ms). <原错误>"）：**未核实**——仓库里没有 `node_modules`，我读不到 pi-ai 的发行代码。问题 1 的触发条件（重试时重建请求体 vs 复用首次遮盖后的 body）和问题 3 的文案格式都取决于它。
- “18 条测试在无本改动的 main 上同样失败（PI_MODEL_RUNTIME_CONFIGURATION_FAILED）”：**未核实**（不能运行命令）。
- 用户取消发生在重试退避期间时的行为：推测 pi-ai 会把 signal 传入并中止、Himawari 端按 `markUnknown("cancel_unresolved")` 收尾（relayAdmittedPiStream:975-984 的错误路径可覆盖），但 pi-ai 侧未核实。

## 必答问题逐条

1. **会不会改变模型已见过的请求开头？** 消息层面不会：重试发生在 pi-ai 模型调用内部，历史、系统提示、工具定义不变，Pi 自动重试仍关（1491 行），失败尝试不进历史，每轮变化的值不受本 PR 影响（未改动）。但字节层面有一个例外：问题 1 的遮盖状态跨重试残留，特定内容下重发的请求与首次发出的请求字节不同（条件成立时）。除此之外，重发确实逐字节相同（[ADR-0198] 用例断言 bodies[1..3] 相同）。
2. **同一段文字会不会在不同请求里变成不同字节？** 会，就是问题 1：`named-earlier` 遮盖依赖 `#known` 的累积，而该状态跨重试存活，导致同一消息在重试请求里被遮成不同字节。其余新增值（日志字段、常量）不进模型请求；`gatewayPayload`、序列化均无顺序/时间依赖的改动。
3. **有没有对应的自动检查、反向用例真会失败吗？** 大体有：网关三条单测（删掉重发许可→第 1 条红；删掉禁止重发→REVERSE 红）；[ADR-0198] 在 `maxRetries` 回退为 0 时会红（bodies 长度 3≠5）；model-accounting 断言 `maxRetries: 2` 透传；分类单测覆盖两种文案。弱点：`REVERSE [RETRY-429]` 在功能被整体删除时仍然通过（问题 7）；“Server requested…”文案格式只有假设性单测、端到端不断言失败码（问题 3）；遮盖场景的字节一致性、生产日志接线无任何测试（问题 1、6）。
4. **每个新值的两端核对。** `MODEL_REQUEST_MAX_RETRIES=2` / `MODEL_REQUEST_MAX_RETRY_DELAY_MS=10_000`：生产端在 pi-runtime-adapter.ts:1171-1172；消费端是 pi-ai（未核实其接受性与语义，现有测试只断言了透传，属循环论证）。`onModelRequestRejected` → `ProviderRejection{status,retryAfter,shouldRetry,host}`：production-run-composition.ts:143-149,467-468 的类型与 adapter 依赖一致；service-main 只在字段非 null 时写入日志，`writeServiceDiagnostic` 接受 string/number（platform-node/src/service-runtime.ts:69），主机名只取 `URL.host` 不含路径与密钥——两端校验可接受。`model.request_rejected` 事件名是新增日志键，无下游解析依赖（未发现消费方，推测无风险）。没有清单项或序列化格式改动。I-73 式的“只看改动没看对端”在 `maxRetryDelayMs` 这一项上仍然存在：它的有效性完全押在未核实的 pi-ai 上，建议升级 pi-ai 时把重试行为列入检查清单。
