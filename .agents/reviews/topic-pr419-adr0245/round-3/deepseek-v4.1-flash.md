CLAIM|1|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1491|本 ADR 之前两层重试都关着：Pi 的自动重试（`packages/runtime-pi/src/pi-runtime-adapter.ts` 里 `retry: { enabled: false, maxRetries: 0 }`）|          retry: { enabled: false, maxRetries: 0 },
CLAIM|2|一致|cf040251^:packages/runtime-pi/src/pi-runtime-adapter.ts:1147|以及传给模型服务方请求函数的 `maxRetries: 0`。|        maxRetries: 0,
CLAIM|3|一致|docs/adr/0198-upgrade-pi-to-1-5-0.md:40|第一层要关，因为 Pi 的自动重试会往历史追加 `context_edit`，改变已发出的内容（[ADR 0198](0198-upgrade-pi-to-1-5-0.md#decision) 前提 5、决定 7）。|5. Pi 只在两处追加 `context_edit`（把失败的那次回答从模型上下文里拿掉）：自动重试（`agent-session.ts` 里 `_omitRecoveryAttempt(message)`，注释“Keep the failed attempt in raw history while durably omitting it from model projection.”），以及上下文溢出或截断恢复，后者紧接着压缩（同一文件，“Persistently omit the selected final attempt before post-run recovery compaction.”）。Himawari 一直关着 Pi 的自动重试：`packages/runtime-pi/src/pi-runtime-adapter.ts` 设置 `retry: { enabled: false, maxRetries: 0 }`。
CLAIM|4|一致|packages/runtime-pi/test/prompt-prefix.compat.test.ts:1188|第二层没有这个问题：它在发出 HTTP 请求的那一层，只重发同一份请求，不碰对话历史。|  it("[ADR-0198] a failing provider is retried at the request layer with identical bytes, never inside Pi, so no context_edit removes anything from the next request", async () => {
CLAIM|5|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1491|Pi 的自动重试仍然关着|          retry: { enabled: false, maxRetries: 0 },
CLAIM|6|一致|docs/adr/0198-upgrade-pi-to-1-5-0.md:55|决定 7 的前提不变。|这一句已被 [ADR 0245](0245-retry-rate-limited-model-requests-at-the-request-layer.md) 修订：Pi 的自动重试仍关着，但请求层现在会对 429/503 重发同一份请求，用例改为检查重发的字节相同
CLAIM|7|一致|packages/runtime-pi/src/gateway-observation.ts:159|其他非 2xx（如 400、401）仍然报 `AI_GATEWAY_MULTIPLE_REQUESTS_FORBIDDEN`|        throw new Error("AI_GATEWAY_MULTIPLE_REQUESTS_FORBIDDEN");
CLAIM|8|一致|packages/runtime-pi/src/gateway-observation.ts:159|发过一次成功响应后再发，仍然报 `AI_GATEWAY_MULTIPLE_REQUESTS_FORBIDDEN`|        throw new Error("AI_GATEWAY_MULTIPLE_REQUESTS_FORBIDDEN");
CLAIM|9|一致|packages/runtime-pi/src/gateway-observation.ts:157|网络错误之后再发，直接重抛原来的错误，不再发请求。|        if (failure !== undefined) throw failure;
CLAIM|10|一致|apps/agent-service/src/production-model-composition.ts:468|标题、邮件判断、记忆整理等后台调用走 `packages/runtime-pi/src/pi-model-transport.ts`|      transport: new PiModelTransport({
CLAIM|11|一致|packages/runtime-pi/src/pi-model-transport.ts:376|仍然 `maxRetries: 0`|        maxRetries: 0,
CLAIM|12|找不到|-|它们的准入、用量和缓存预热是另一条路|-
CLAIM|13|一致|docs/adr/0222-retry-and-queue-failed-memory-capture.md:53|记忆保存已有自己的同轮重试（[ADR 0222](0222-retry-and-queue-failed-memory-capture.md)）。|1. **同轮重试一次，只对可能是偶发的错误。**
CLAIM|14|一致|.claude/rules/prompt-prefix.md:46|换服务方会让缓存整段重算（prompt-prefix 规则第 8、9 条）。|9. **同一对话的请求送到同一个服务方。**缓存存在各服务方自己的机器上，换一家服务方就要整段重算。
CLAIM|15|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:959|被拒绝的响应没有生成内容，不记用量，所以一次调用仍只记一份用量|              await recordUsage(usage, await cacheReported());
CLAIM|16|找不到|-|准入和预算按调用算，没有变。|-
CLAIM|17|一致|packages/runtime-pi/src/gateway-observation.ts:157|走 Vercel 网关时观察器不会真的再发，直接重抛原来的错误。|        if (failure !== undefined) throw failure;
CLAIM|18|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1694|压缩摘要请求也走同一个请求函数，一并重试|          return admitPiStream(
CLAIM|19|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:457|它的失败原因仍按状态码归类|  if (status === "429") return "PI_MODEL_RATE_LIMITED";
CLAIM|20|一致|packages/application/test/model-egress.unit.test.ts:680|`packages/application/test/model-egress.unit.test.ts` 的 `[RETRY-429]`（重发字节相同、只上报一次|  it("[RETRY-429] resends the same bytes and reports once when the identical request is sent again", async () => {
CLAIM|21|一致|packages/application/test/model-egress.unit.test.ts:583|被拒绝后重发再抛同一个拒绝、只上报一次|  it("[RETRY-429] a refused request that is sent again is refused again without a second withheld report", async () => {
CLAIM|22|一致|packages/application/test/model-egress.unit.test.ts:610|不同请求体、自带请求体的请求对象不沿用记忆的反向用例|  it("REVERSE [RETRY-429] the resend memory is not used for a different body or for a request object carrying its own body", async () => {
CLAIM|23|一致|packages/runtime-pi/test/prompt-prefix.compat.test.ts:1224|`prompt-prefix.compat.test.ts` 里真实 Pi + 真实遮盖的遮盖重发用例|  it("[RETRY-429] a value named as a password only in the new message is masked the same way in the first attempt and in the resend", async () => {
CLAIM|24|一致|packages/runtime-pi/test/provider-rejection-observation.unit.test.ts:17|`provider-rejection-observation.unit.test.ts`|it("records status, retry hints and only the host of a rejected response", async () => {
CLAIM|25|一致|packages/runtime-pi/test/prompt-prefix.compat.test.ts:1188|`packages/runtime-pi/test/prompt-prefix.compat.test.ts` 的 `[ADR-0198]`（持续 503 时重发的请求字节完全相同、历史里没有 `context_edit`、下一轮仍以第一轮开头）|  it("[ADR-0198] a failing provider is retried at the request layer with identical bytes, never inside Pi, so no context_edit removes anything from the next request", async () => {
CLAIM|26|一致|packages/runtime-pi/test/prompt-prefix.compat.test.ts:1203|`[RETRY-429]`|  it("[RETRY-429] a rate-limited request is resent once the provider allows it and the turn completes", async () => {
CLAIM|27|一致|packages/runtime-pi/test/prompt-prefix.compat.test.ts:1239|及其反向用例（等待超过上限立刻失败）|  it("REVERSE [RETRY-429] a provider that asks for a long wait fails at once and still reports as rate limited", async () => {
CLAIM|28|一致|packages/runtime-pi/test/gateway-observation.unit.test.ts:10|`gateway-observation.unit.test.ts`|it("allows the request to be resent after the gateway rejected it with a non-success status", async () => {

未核对的部分：`out.txt` 的生产日志和 154 次操作/349 ms 等外部数据；`@earendil-works/pi-ai` 的 `dist/utils/provider-retry.js`、1.3 秒/22 秒等待以及 OpenAI/Anthropic SDK 默认值等第三方行为（仓库内没有 node_modules，读不到）；还有“准入、用量和缓存预热是另一条路”“准入和预算按调用算，没有变”没有找到直接证据。`maxRetries: 0` 的历史状态是用 cf040251 的父提交核对的。
