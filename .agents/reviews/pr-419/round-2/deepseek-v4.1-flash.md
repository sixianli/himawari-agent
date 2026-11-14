## 读代码证实的

### 1.（中）端到端重试用例没有覆盖“遮盖后重发”这条真正要修的路径
**文件：** `packages/runtime-pi/test/prompt-prefix.compat.test.ts:418-434`、`1188-1222`

`THREE_TURNS` 的三条提示都是普通中文（“明天是否需要带伞”等），没有任何密码、验证码、卡号等会被 `testModelEgress()` 遮盖的内容。因此 `[ADR-0198]` 和 `[RETRY-429]` 用例里断言

```ts
expect(server.bodies[2]).toBe(server.bodies[1]);
expect(server.bodies[3]).toBe(server.bodies[1]);
```

即使把 `model-egress.ts` 里新增的 `#lastRequest` 复用整段删掉，也照样通过——因为第一次遮盖根本没有改变请求体。真正会因缺少复用而失败的是 `packages/application/test/model-egress.unit.test.ts:640-682` 的单元用例；端到端没有把“真实 Pi 重试 + 真实遮盖 + 遮盖出的字节不同”这三点连起来。

**建议：** 在 `retryAdapter` 的某一轮里加入 `密码：hunter22abc`，并在该消息之前再放一次同一个值（就像单元用例那样），断言重发的两次请求体逐字节相同、拦截记录只报一次；再加一条反向用例：把第二次的正文改掉，断言不会沿用上一次的遮盖结果。

### 2.（低）`#lastRequest` 只记最后一次，地址+请求体作为键，交换被复用时的 A→B→A 会失效
**文件：** `packages/application/src/services/model-egress.ts:132`、`192-200`、`262-267`

```ts
#lastRequest: { readonly key: string; readonly body: string | undefined } | undefined;
...
const requestKey = `${href}\u0000${body}`;
if (this.#lastRequest?.key === requestKey) { ... return { ... body: resent ... }; }
...
this.#lastRequest = { key: requestKey, body: redacted };
```

当前生产接线是安全的：`egress.exchange(...)` 在每次 `admitPiStream` 里新建（`packages/runtime-pi/src/pi-runtime-adapter.ts:1124`），每次后台请求也在 `pi-model-transport.ts:312` 新建，所以一个交换里能出现“相同地址+相同请求体”的只有 Pi 自己对同一请求的重试。作者担心的“被不同请求共用”目前不会发生。

但 `ModelEgressExchange.wrapFetch` 的 API 本身允许复用。一旦有人在**同一个交换**里交错发 A、B、A，第三次 A 因为 `#lastRequest` 已被 B 覆盖而不会命中，会被重新遮盖；此时 `#known` 里已经有 A 和 B 的值，A 的早期内容可能被补遮，字节与第一次 A 不同——正是这次修复想避免的现象。并发调用 `#prepare` 时，`await this.#options.key()` 前后两段交错，也会让后完成的请求覆盖先完成的缓存。

**建议：** 要么在类型/文档上明确“一个交换只服务一次逻辑请求”，要么把缓存换成按 `href+body` 索引的小 Map（只在重试窗口内保留），或者让调用方显式传入 attempt/request id，避免“最后一条”语义。另外键里没有 `method`，虽不影响当前路径，但加上更稳。

### 3.（低）缓存键复制并长期持有整段未遮盖请求体；大请求会多一份内存，也延长了秘密在内存里的存活时间
**文件：** `packages/application/src/services/model-egress.ts:192`、`132`、`267`

`requestKey = \`${href}\u0000${body}\`` 会把整个原始请求体**复制**成一个新字符串；`#lastRequest.key` 会一直持有它，直到这个交换（对应整条模型流）结束。对于带长附件的请求，这是额外的一份完整正文内存；而且即使请求体已经被替换成遮盖后的版本，键里仍然是未遮盖原文。原来 `#prepare` 返回后原文有机会被回收，现在不会。

**建议：** 键只存 `href` 和一个摘要（实现里已有 `sign`，或直接用长度+哈希），需要精确比较时再存原文引用；至少不要把正文拼进键里。交换结束（流关闭）时要显式清空。

### 4.（低，推测）拒绝路径没有被记忆，若 Pi 把它当连接错误重试，会重复遮盖、重复上报 `withheld`
**文件：** `packages/application/src/services/model-egress.ts:243-257`；重试开关在 `packages/runtime-pi/src/pi-runtime-adapter.ts:1171-1172`

`refuse("sensitive material remained after redaction")` 之前已经调用了 `this.#report(withheld)`，但抛错发生时 `#lastRequest` 没有写入，所以下一次重试会重新跑完整遮盖并再次上报。作者说 Pi 只重试 408/409/429/5xx 和连接错误；一个从 fetch 里同步抛出的 `ModelEgressRefusedError` 是否会被 provider-retry 当成连接错误，仓库里没有 pi-ai 源码，无法确认。若会，则“不重复上报”这条承诺只覆盖成功路径。**建议：** 确认 pi-ai 的 `isRetryable` 逻辑，或在抛出前把这次失败也标记下来。

### 5.（低，推测）连接错误重试可能让直连服务方的请求被重复计费，文档只论证了“被拒绝的响应不收费”
**文件：** `packages/runtime-pi/src/pi-runtime-adapter.ts:1171-1172`；`packages/runtime-pi/src/gateway-observation.ts:163-175`

ADR 0245 说“被拒绝的响应没有生成内容，不记用量”，但 Pi 的请求层重试（ADR 第 32 行自己写明）还包括**连接错误**。走网关时观察器在传输错误后会重抛同一个错误，不会真的再发（`gateway-observation.ts:165-168`）；不走网关时没有这个保护，连接在服务方已处理请求之后断开时可能再发一次，带来重复计费/重复副作用。这属于启用请求层重试的固有风险，建议在 ADR 里明确说明并评估是否也要对直连路径禁掉连接错误重试。

## 推测 / 未核实

- `providerStatusOf` 依赖 pi-ai 的错误文字格式（`pi-runtime-adapter.ts:446-451`）。仓库里没有 `@earendil-works/pi-ai` 源码，无法核实“`Math.ceil` 生成整数秒”“状态码后一定有空格”。不过 `prompt-prefix.compat.test.ts:1224-1233` 用真实 Pi + `retry-after: 120` 断言 `PI_MODEL_RATE_LIMITED`，只要该用例实际运行，就能兜住这种格式；我未能运行测试。
- `maxRetryDelayMs` 这个选项名是否被当前 pi-ai 版本接受，同样无法从仓库核实；`package.json`/锁文件不在稀疏检出里。

## 侧重检查

- **错误路径：** 网关对 400 的反向用例（`gateway-observation.unit.test.ts:47-58`）、重发次数上限反向用例（`:60-72`）、传输错误重抛原错误（`:35-45`）、长 `retry-after` 立即失败并归类为限流（`prompt-prefix.compat.test.ts:1224-1233`）都覆盖到了；逻辑与 ADR 0245 第 3 条一致（`gateway-observation.ts:169-176`）。
- **不可信输入：** `retry-after`/`x-should-retry` 是服务方可控，`headerText` 截到 128（`provider-rejection-observation.ts:10-13`），日志经 `JSON.stringify` 再写（`packages/platform-node/src/service-runtime.ts:71-72`），换行会被转义，没有日志注入；`hostOf` 对任意对象放在 `try/catch` 里，只取 host、不含 path（`provider-rejection-observation.ts:15-29`）。
- **安全：** 沿用已遮盖请求体只会重发“已经发出去过的字节”，不会额外泄露；但见第 3 条，键长期保留未遮盖原文。
- **资源耗尽：** 网关重发被 `MAX_GATEWAY_RESENDS = 2` 限住（`gateway-observation.ts:138-139`），请求层 `maxRetries: 2`，总尝试次数有界；主要额外内存来自第 3 条的整段正文复制。
- **不可撤销操作/计费：** 重试本身不改历史、不写持久化；风险集中在第 5 条的连接错误重复计费。
- **规则/文档与代码一致性：** ADR 0245 的范围（仅聊天+压缩摘要）、`maxRetries: 2`/`maxRetryDelayMs: 10000`、网关 408/409/429/5xx、头部 128、复用已遮盖请求体，都与代码一致；`pi-model-transport.ts:376` 仍是 `maxRetries: 0`，与“后台调用不在范围内”一致。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。增量只改了 fetch 包装层：`model-egress.ts` 的重发缓存（`:192-200`、`:262-267`）和 `pi-runtime-adapter.ts` 的 `maxRetries`/日志包装（`:1132-1143`、`:1167-1173`）；系统提示、工具定义、历史构造、`withPlaceholderLegend`/`normalizeContext` 都没有改动。重发时 `#prepare` 直接把第一次遮盖好的 `body` 交回去，不再追加也不重排任何消息，`content-length` 仍会被去掉。每轮会变的时间/记忆仍由原有构造放在最后一条用户消息里，这次没有搬动。需要保留的限定：端到端用例用的是无敏感内容的正文，所以“真实 Pi 重试 + 真实遮盖”下的逐字节不变只有单元测试兜底（见第 1 条）。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
这次改动是在**减少**这种差异，不引入新的。同一交换内只有重试会命中缓存，且返回第一次的同一串字节；跨轮请求每次都会新建交换（`pi-runtime-adapter.ts:1124`），`#known`/`table` 不跨请求累积，所以不同轮次的同一段前缀仍走同样的首次遮盖结果。例外是第 2 条描述的“共用交换做 A→B→A”这一非当前接线场景，以及 `requestKey` 用 `\u0000` 拼接在极端情况下可能撞键（URL/正文含真实 NUL），目前都不可达或极不现实。

**3. 有没有对应的自动检查，反向用例真的会失败？**
有，且我逐条推演后认为反向用例是有效的：
- `model-egress.unit.test.ts:668-682`：若复用忽略请求体差异，`calls[1]` 会等于第一次或漏掉 `other77pass9`，断言失败。
- `gateway-observation.unit.test.ts:47-58`：旧逻辑（任何非 2xx 都允许重发）下第二次调用会返回 400 而不是抛 `AI_GATEWAY_MULTIPLE_REQUESTS_FORBIDDEN`，会失败。
- `gateway-observation.unit.test.ts:60-72`：去掉次数上限后第 4 次会返回 503，会失败。
- `provider-rejection-observation.unit.test.ts`：去掉截断则长度不是 128；旧 `hostOf` 不认 `{url}` 则 host 为 null。
- `prompt-prefix.compat.test.ts:1224-1233`：去掉 `providerStatusOf` 的第二种格式匹配，失败码会变成 `PI_MODEL_ERROR`。
唯一缺口是第 1 条：端到端重试用例本身在删除复用代码后仍然通过。

**4. 每个产生/修改的值，使用它的地方都能接受吗？**
逐个核过：
- `onModelRequestRejected`：`PiAgentRuntimeAdapterDependencies`（`pi-runtime-adapter.ts:230`）→ `ProductionRunCompositionOptions`（`production-run-composition.ts:143-151`）→ 透传（`:467-469`）→ `service-main.ts:2534-2543`，字段名/可选性/类型两端一致；日志写入器接受 `string | number | boolean | readonly string[]`。
- `ProviderRejection` 的 `status/retryAfter/shouldRetry/host`：下游只用于 `writeServiceDiagnostic`，没有更严格的校验/枚举依赖；截断后仍是 `string | null`。
- `RESENDABLE_STATUSES`、`MAX_GATEWAY_RESENDS`、`maxResends`：模块内部常量/默认参数，现有调用方（`pi-runtime-adapter.ts:1141`、`pi-model-transport.ts:332`、集成夹具）都不传第三个参数，行为一致。
- `providerStatusOf` 的返回值：`modelFailureCode` 会把它映射成 `PI_MODEL_RATE_LIMITED`/`QUOTA`/`AUTH`/`UNAVAILABLE`/`ERROR`，`loggableModelFailure` 只输出 `provider_status_<code>`，不会回显原始文字。
- `maxRetries`/`maxRetryDelayMs`：传给 `original(...)`，`model-accounting.unit.test.ts:565` 断言了 2/10000；`maxRetryDelayMs` 是否被当前 pi-ai 接受属于未核实项。
- `#lastRequest`、`requestKey`：仅类内部使用，没有外部消费方。
