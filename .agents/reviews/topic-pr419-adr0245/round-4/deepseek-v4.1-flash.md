CLAIM|1|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:443|传给 Pi 模型层的 `maxRetries` 从 0 改成 2|const MODEL_REQUEST_MAX_RETRIES = 2;
CLAIM|2|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:444|`maxRetryDelayMs` 设为 10 秒|const MODEL_REQUEST_MAX_RETRY_DELAY_MS = 10_000;
CLAIM|3|一致|packages/runtime-pi/test/prompt-prefix.compat.test.ts:1197|重试只重发同一份请求体|expect(server.bodies[2]).toBe(server.bodies[1]);
CLAIM|4|一致|packages/runtime-pi/test/prompt-prefix.compat.test.ts:1199|失败的那次不进历史|expect(server.bodies.join("\n")).not.toContain("context_edit");
CLAIM|5|一致|.claude/rules/prompt-prefix.md:35|不影响 KV 缓存（prompt-prefix 规则第 4 条）|4. **已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。**
CLAIM|6|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1491|Pi 的自动重试仍然关着|retry: { enabled: false, maxRetries: 0 },
CLAIM|7|一致|packages/runtime-pi/src/gateway-observation.ts:138|上一次得到 408、409、429 或 5xx 的拒绝（没有生成内容，不记用量）时允许重发，最多重发 2 次|const RESENDABLE_STATUSES = new Set([408, 409, 429]); const MAX_GATEWAY_RESENDS = 2;
CLAIM|8|一致|packages/runtime-pi/src/gateway-observation.ts:159|其他非 2xx（如 400、401）、发过一次成功响应后再发，仍然报 `AI_GATEWAY_MULTIPLE_REQUESTS_FORBIDDEN`|throw new Error("AI_GATEWAY_MULTIPLE_REQUESTS_FORBIDDEN");
CLAIM|9|一致|packages/runtime-pi/src/gateway-observation.ts:157|网络错误之后再发，直接重抛原来的错误，不再发请求|if (failure !== undefined) throw failure;
CLAIM|10|一致|apps/agent-service/src/service-main.ts:2537|聊天请求和压缩摘要请求里，每个被拒绝的响应写一行服务日志 `model.request_rejected`|event: "model.request_rejected",
CLAIM|11|一致|apps/agent-service/src/service-main.ts:2538|运行号、状态码、`retry-after`、`x-should-retry`、服务方主机名|runId: request.runId, status: rejection.status, ...(rejection.retryAfter === null ? {} : { retryAfter: rejection.retryAfter }), ...(rejection.shouldRetry === null ? {} : { shouldRetry: rejection.shouldRetry }), ...(rejection.host === null ? {} : { host: rejection.host }),
CLAIM|12|一致|packages/runtime-pi/src/provider-rejection-observation.ts:25|服务方主机名（不含路径、密钥和内容）|return href === undefined ? null : new URL(href).host;
CLAIM|13|一致|packages/runtime-pi/src/provider-rejection-observation.ts:10|头部文字截到 128 个字符|const HEADER_LIMIT = 128;
CLAIM|14|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:450|错误信息以“Server requested …s retry delay (max: …s).”开头|/^Server requested \d+s retry delay \(max: \d+s\)\. (\d{3})(?:\s|:)/.exec(message)?.[1]
CLAIM|15|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:457|仍按其后的状态码归类成“限流”|if (status === "429") return "PI_MODEL_RATE_LIMITED";
CLAIM|16|一致|apps/control-center/src/i18n/resources/zh-CN.ts:81|用户看到的还是“模型服务当前限流”|"chat.error.rateLimited": "模型服务当前限流。请稍后重试，或为下一轮选择其他已配置模型。",
CLAIM|17|一致|packages/application/src/services/model-egress.ts:199|同一个出口交换里，请求地址、方法和请求体都与上一次完全相同时|last.href === href && last.method === method && last.body === body
CLAIM|18|一致|packages/application/src/services/model-egress.ts:207|直接沿用上一次遮盖后的请求体，不重新遮盖、不重复上报拦截记录|init: { ...options, body: last.redacted, headers: withoutLength(options["headers"]) },
CLAIM|19|一致|packages/application/src/services/model-egress.ts:203|重发直接再抛同一个拒绝，不再检查、不重复上报|if (last.refusal !== undefined) throw last.refusal;
CLAIM|20|一致|packages/application/src/services/model-egress.ts:192|先检查地址和“请求对象自带请求体”|if (hasBodyInRequest(input)) refuse("request object carries its own body");
CLAIM|21|一致|packages/application/src/services/model-egress.ts:132|一个出口交换服务一次模型调用，只记住上一次请求|#lastRequest:
CLAIM|22|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1708|范围：只覆盖聊天请求和压缩摘要请求|summaryContext ? "other" : "chat",
CLAIM|23|一致|apps/agent-service/src/production-model-composition.ts:468|标题、邮件判断、记忆整理等后台调用走 `packages/runtime-pi/src/pi-model-transport.ts`|transport: new PiModelTransport({
CLAIM|24|一致|packages/runtime-pi/src/pi-model-transport.ts:376|它们仍然 `maxRetries: 0`|maxRetries: 0,
CLAIM|25|一致|docs/adr/0222-retry-and-queue-failed-memory-capture.md:53|记忆保存已有自己的同轮重试（ADR 0222）|1. **同轮重试一次，只对可能是偶发的错误。**
CLAIM|26|一致|.claude/rules/prompt-prefix.md:46|换服务方会让缓存整段重算（prompt-prefix 规则第 8、9 条）|9. **同一对话的请求送到同一个服务方。**缓存存在各服务方自己的机器上，换一家服务方就要整段重算。
CLAIM|27|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:959|被拒绝的响应没有生成内容，不记用量，所以一次调用仍只记一份用量|await recordUsage(usage, await cacheReported());
CLAIM|28|一致|packages/runtime-pi/src/gateway-observation.ts:157|走 Vercel 网关时观察器不会真的再发，直接重抛原来的错误|if (failure !== undefined) throw failure;
CLAIM|29|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1694|压缩摘要请求也走同一个请求函数|return admitPiStream(
CLAIM|30|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:443|持续限流时多发最多 2 次请求|const MODEL_REQUEST_MAX_RETRIES = 2;
CLAIM|31|一致|packages/application/src/services/model-egress.ts:207|每次都带上同一份遮盖后的内容|init: { ...options, body: last.redacted, headers: withoutLength(options["headers"]) },
CLAIM|32|一致|packages/application/test/model-egress.unit.test.ts:680|`packages/application/test/model-egress.unit.test.ts` 的 `[RETRY-429]`（重发字节相同、只上报一次）|it("[RETRY-429] resends the same bytes and reports once when the identical request is sent again", async () => {
CLAIM|33|一致|packages/application/test/model-egress.unit.test.ts:583|被拒绝后重发再抛同一个拒绝、只上报一次|it("[RETRY-429] a refused request that is sent again is refused again without a second withheld report", async () => {
CLAIM|34|一致|packages/application/test/model-egress.unit.test.ts:610|不同请求体、自带请求体的请求对象不沿用记忆的反向用例|it("REVERSE [RETRY-429] the resend memory is not used for a different body or for a request object carrying its own body", async () => {
CLAIM|35|一致|packages/runtime-pi/test/prompt-prefix.compat.test.ts:1224|`prompt-prefix.compat.test.ts` 里真实 Pi + 真实遮盖的遮盖重发用例|it("[RETRY-429] a value named as a password only in the new message is masked the same way in the first attempt and in the resend", async () => {
CLAIM|36|一致|packages/runtime-pi/test/provider-rejection-observation.unit.test.ts:17|`provider-rejection-observation.unit.test.ts`|it("records status, retry hints and only the host of a rejected response", async () => {
CLAIM|37|一致|packages/runtime-pi/test/prompt-prefix.compat.test.ts:1188|`packages/runtime-pi/test/prompt-prefix.compat.test.ts` 的 `[ADR-0198]`（持续 503 时重发的请求字节完全相同、历史里没有 `context_edit`、下一轮仍以第一轮开头）|it("[ADR-0198] a failing provider is retried at the request layer with identical bytes, never inside Pi, so no context_edit removes anything from the next request", async () => {
CLAIM|38|一致|packages/runtime-pi/test/prompt-prefix.compat.test.ts:1203|`[RETRY-429]` 及其反向用例（等待超过上限立刻失败）中的 `[RETRY-429]`|it("[RETRY-429] a rate-limited request is resent once the provider allows it and the turn completes", async () => {
CLAIM|39|一致|packages/runtime-pi/test/prompt-prefix.compat.test.ts:1239|`[RETRY-429]` 及其反向用例（等待超过上限立刻失败）中的反向用例|it("REVERSE [RETRY-429] a provider that asks for a long wait fails at once and still reports as rate limited", async () => {
CLAIM|40|一致|packages/runtime-pi/test/gateway-observation.unit.test.ts:10|`gateway-observation.unit.test.ts`|it("allows the request to be resent after the gateway rejected it with a non-success status", async () => {

未核对的是仓库外或第三方部分：Pi/pi-ai 内部的请求层重试实现（重试哪些状态和连接错误、`retry-after` 解析、指数退避、10 秒上限与约 22 秒总等待、把遮盖拒绝当连接错误再试 2 次等），以及 `out.txt`、Andy 在卡片上的选择、OpenAI/Anthropic 的外部文档。
