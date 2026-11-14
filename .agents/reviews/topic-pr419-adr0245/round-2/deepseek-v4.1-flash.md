CLAIM|1|不一致|packages/runtime-pi/src/pi-runtime-adapter.ts:443|Himawari 对 429 没有任何重试，立刻报错，用户只能自己重发。|const MODEL_REQUEST_MAX_RETRIES = 2;
CLAIM|2|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1491|Himawari 关着两层重试：Pi 的自动重试（`packages/runtime-pi/src/pi-runtime-adapter.ts` 里 `retry: { enabled: false, maxRetries: 0 }`）|retry: { enabled: false, maxRetries: 0 },
CLAIM|3|不一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1171|以及传给模型服务方请求函数的 `maxRetries: 0`|maxRetries: MODEL_REQUEST_MAX_RETRIES,
CLAIM|4|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1491|Pi 的自动重试仍然关着|retry: { enabled: false, maxRetries: 0 },
CLAIM|5|一致|packages/runtime-pi/src/gateway-observation.ts:150|Vercel 网关的请求观察器原来只许每次调用发一次请求。|if (sent) {\n        repeated = true;\n        throw new Error("AI_GATEWAY_MULTIPLE_REQUESTS_FORBIDDEN");\n      }\n      sent = true;\n      const response = await fetch(input, init);
CLAIM|6|一致|apps/agent-service/src/production-model-composition.ts:468|标题、邮件判断、记忆整理等后台调用走 `packages/runtime-pi/src/pi-model-transport.ts`|transport: new PiModelTransport({
CLAIM|7|一致|packages/runtime-pi/src/pi-model-transport.ts:376|仍然 `maxRetries: 0`|maxRetries: 0,
CLAIM|8|一致|apps/agent-service/src/production-memory-capture.ts:856|记忆保存已有自己的同轮重试|invocationId: `memory-capture:${request.runId}:retry`,
CLAIM|9|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1694|压缩摘要请求也走同一个请求函数|return admitPiStream(
CLAIM|10|一致|packages/runtime-pi/src/gateway-observation.ts:157|走 Vercel 网关时观察器不会真的再发，直接重抛原来的错误|if (failure !== undefined) throw failure;
CLAIM|11|一致|packages/application/test/model-egress.unit.test.ts:680|`packages/application/test/model-egress.unit.test.ts` 的 `[RETRY-429]`（重发字节相同、只上报一次|it("[RETRY-429] resends the same bytes and reports once when the identical request is sent again", async () => {
CLAIM|12|一致|packages/application/test/model-egress.unit.test.ts:583|被拒绝后重发再抛同一个拒绝、只上报一次|it("[RETRY-429] a refused request that is sent again is refused again without a second withheld report", async () => {
CLAIM|13|一致|packages/application/test/model-egress.unit.test.ts:610|不同请求体、自带请求体的请求对象不沿用记忆的反向用例|it("REVERSE [RETRY-429] the resend memory is not used for a different body or for a request object carrying its own body", async () => {
CLAIM|14|一致|packages/runtime-pi/test/prompt-prefix.compat.test.ts:1224|`prompt-prefix.compat.test.ts` 里真实 Pi + 真实遮盖的遮盖重发用例|it("[RETRY-429] a value named as a password only in the new message is masked the same way in the first attempt and in the resend", async () => {
CLAIM|15|一致|packages/runtime-pi/test/provider-rejection-observation.unit.test.ts:17|`provider-rejection-observation.unit.test.ts`|it("records status, retry hints and only the host of a rejected response", async () => {
CLAIM|16|一致|packages/runtime-pi/test/prompt-prefix.compat.test.ts:1188|`packages/runtime-pi/test/prompt-prefix.compat.test.ts` 的 `[ADR-0198]`（持续 503 时重发的请求字节完全相同、历史里没有 `context_edit`、下一轮仍以第一轮开头）|it("[ADR-0198] a failing provider is retried at the request layer with identical bytes, never inside Pi, so no context_edit removes anything from the next request", async () => {
CLAIM|17|一致|packages/runtime-pi/test/prompt-prefix.compat.test.ts:1203|`[RETRY-429]` 及其反向用例（等待超过上限立刻失败）|it("[RETRY-429] a rate-limited request is resent once the provider allows it and the turn completes", async () => {
CLAIM|18|一致|packages/runtime-pi/test/prompt-prefix.compat.test.ts:1239|`[RETRY-429]` 及其反向用例（等待超过上限立刻失败）|it("REVERSE [RETRY-429] a provider that asks for a long wait fails at once and still reports as rate limited", async () => {
CLAIM|19|一致|packages/runtime-pi/test/gateway-observation.unit.test.ts:10|`gateway-observation.unit.test.ts`|it("allows the request to be resent after the gateway rejected it with a non-success status", async () => {
CLAIM|20|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:457|压缩摘要请求也走同一个请求函数，一并重试；它的失败原因仍按状态码归类。|if (status === "429") return "PI_MODEL_RATE_LIMITED";

未核实：`out.txt` 生产日志、Andy 的原话、OpenAI/Anthropic 与 Pi 的外部资料，以及后果中“一次调用仍只记一份用量；准入和预算按调用算”和后台调用“准入、用量和缓存预热是另一条路”的细节。第 5 条“原来”按父提交 1a68a5a3 的历史版本核对；第 1、3 条描述的是改动前状态，与当前 HEAD 不一致。
