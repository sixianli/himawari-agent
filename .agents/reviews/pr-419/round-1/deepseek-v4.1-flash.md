## 结论摘要

改动本身把重试放在 HTTP 请求层，不碰对话历史；按现有代码与测试，**请求开头仍然只在末尾追加，重试重发同一份请求体**。主要问题不在前缀，而在：长等待失败的错误分类没有被测试锁住、后台/标题调用其实没有重试、网关观察器在非 2xx 后留下过宽的重发口子，以及重试会重复累加敏感拦截审计计数。

> 说明：当前检出是稀疏工作区，`node_modules` 不在，无法直接读 `@earendil-works/pi-ai` 的 `provider-retry.js`。凡是依赖该库内部行为的地方，我标为「未核实」或「推测」。

---

## 问题（按严重度从高到低）

### 1. 【中】【读代码证实 + 部分推测】超过等待上限的错误可能归类不成“限流”
- 位置：`packages/runtime-pi/src/pi-runtime-adapter.ts:446-451`
- 问题：新增的第二个正则只接受整数秒，且状态码后必须立刻跟空白或冒号：

  ```ts
  /^Server requested \d+s retry delay \(max: \d+s\)\. (\d{3})(?:\s|:)/.exec(message)?.[1]
  ```

  如果 pi-ai 的消息是小数秒（例如 `retry-after-ms: 10500` → `10.5s`），或原错误只有状态码且正好在结尾（例如 `... 429`），这里匹配失败，随后 `modelFailureCode` 返回 `PI_MODEL_ERROR`，`loggableModelFailure` 记 `provider_message_withheld`。这与 ADR 0245 决定 5“用户看到的还是限流”不一致。
- 证据：同一函数上方第一段正则也要求 `(?:\s|:)`；测试只覆盖了整数并带尾随文字的样例：`packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:2286-2290`。pi-ai 是否真的会产生小数秒/裸状态码，**未核实**；正则本身的限制是代码证实的。
- 建议：改成 `\d+(?:\.\d+)?s`，状态码后用 `(?=\s|:|$)`；补 `10.5s`、`429` 结尾两条用例。

### 2. 【中】【读代码证实】反向用例名字说“仍报限流”，但没有断言错误码
- 位置：`packages/runtime-pi/test/prompt-prefix.compat.test.ts:1220-1227`
- 问题：测试名是 `REVERSE [RETRY-429] ... still reports as rate limited`，实际只断言了：

  ```ts
  expect(outcomes).toEqual(["runtime.completed", "runtime.failed", "runtime.completed"]);
  expect(server.bodies).toHaveLength(3);
  ```

  没有断言 `errorCode` 是 `PI_MODEL_RATE_LIMITED`，也没有断言 `onModelStreamFailed` 的码/信息。如果 pi-ai 在重试预算耗尽时是“抛错”而不是返回带 `errorMessage` 的错误流，错误会走 `admitPiStream` 的 catch：

  ```ts
  } catch (error) {
    onAdmissionFailed?.(request, admissionFailure(error));
    ...
    return failedPiStream(model, "Model invocation admission failed");
  }
  ```

  该路径最终是 `PI_MODEL_ERROR`，用户看到的不是“模型服务当前限流”。这正是 ADR 0245 决定 5 要保证的行为，但现在的测试锁不住。
- 证据：`packages/runtime-pi/src/pi-runtime-adapter.ts:1212-1220`；`packages/runtime-pi/test/prompt-prefix.compat.test.ts:1220-1227`。
- 建议：反向用例直接断言 `runtime.failed` 的 `errorCode: "PI_MODEL_RATE_LIMITED"`，并补一条 `onModelStreamFailed` / 最终错误事件的断言；如果 pi-ai 确实抛错，应在 catch 里识别“Server requested … retry delay”而不是统一记成 admission failed。

### 3. 【中】【读代码证实】标题、后台、记忆等模型调用仍然 `maxRetries: 0`，与作者“现在传 2”的表述不符
- 位置：`packages/runtime-pi/src/pi-model-transport.ts:376`
- 问题：`PiModelTransport` 仍明确传：

  ```ts
  maxRetries: 0,
  ```

  而它正是标题、记忆、动作复核等后台 `TrustedModelTransport` 使用的路径（`apps/agent-service/src/production-model-composition.ts:333-356, 468-492`）。对应测试也仍然断言 0：`apps/agent-service/test/production-model-composition.unit.test.ts:1350, 1647`。
- 证据：ADR 0245 背景还专门提到“同一秒起标题的后台调用也被同一上游限流”，但本次只改了 `PiAgentRuntimeAdapter`。因此偶发 429 对标题/后台调用仍然没有缓解。
- 建议：要么在 ADR/说明里明确“本次只覆盖主对话与压缩摘要，后台调用不重试”，要么给后台路径单独设计重试（注意它没有走运行准入/预算/用量，且网关观察器与缓存预热有交互）。

### 4. 【低-中】【读代码证实】网关观察器在任意非 2xx 后重新开放，且没有尝试次数上限
- 位置：`packages/runtime-pi/src/gateway-observation.ts:150-167`
- 问题：

  ```ts
  if (sent) {
    if (failure !== undefined) throw failure;
    repeated = true;
    throw new Error("AI_GATEWAY_MULTIPLE_REQUESTS_FORBIDDEN");
  }
  sent = true;
  ...
  if (!response.ok) {
    sent = false;
    return response;
  }
  ```

  只要收到一次非 2xx，`sent` 就回到 `false`，之后任何再次调用这个 `fetch` 的代码都能发请求，直到下一次请求开始。它并不区分 400/401 这类不可重试状态，也没有“最多 2 次”的计数器。当前只因为 pi-ai 自己不重试不可重试状态，才没有无限重发；防护依赖了外部库行为。ADR 决定 3 是“非 2xx 后允许重发”，但代码没有把“重发”限制在 pi-ai 的重试循环内。
- 证据：`gateway-observation.ts:150-167`；现有测试只覆盖“一次 429 后成功”和“成功后再发被拒”，没有覆盖“不可重试 4xx 后另一个调用者再发”。
- 建议：记录最近一次拒绝的状态码，只在 408/409/429/5xx 后重新开放；增加本地尝试计数（最多 2 次重发），或使用一次性的重试许可，避免把“只发一次成功请求”的约束改成“任意多次失败请求”。

### 5. 【低】【读代码证实】重试会重复累加敏感拦截记录的 `seen_count`
- 位置：`packages/application/src/services/model-egress.ts:165-172, 251`
- 问题：每次重试都会重新走 `exchange.wrapFetch` → `#prepare` → `this.#report(sightings)`；`SensitiveInterceptionRecorder.reportEgress` 对每条观测都记 `occurrences: 1`（`packages/application/src/services/sensitive-interception-recorder.ts:44-61`），而 SQLite 是累加：

  ```sql
  seen_count = seen_count + excluded.seen_count
  ```

  （`packages/persistence-sqlite/src/sqlite-sensitive-interception-operations.ts:128-130`）。一次带卡号/密码的请求被 429 重试两次，审计里会显示成“看到了 3 次”，而不是一次。
- 证据：上述三处代码。是否有人按 `seen_count` 做用户可见展示，**未核实**；持久化计数会被放大是证实的。
- 建议：把 egress 报告从“每次 fetch 调用”改为“每个逻辑请求一次”，或在 `Exchange` 内按一次请求去重；补一条“敏感内容 + 429 重试后 seen_count 仍为 1”的测试。

### 6. 【低】【读代码证实 + 部分推测】新增拒绝日志接受未校验的供应商头部，且 `hostOf` 不识别 `Request`
- 位置：`packages/runtime-pi/src/provider-rejection-observation.ts:10-17, 28-35`
- 问题：

  ```ts
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : undefined;
  ```

  如果 pi-ai 以 `Request` 对象调用 `fetch`，`host` 会一直是 `null`，诊断日志就缺了 ADR 想补的“谁返回的 429”。另外 `retryAfter` / `shouldRetry` 是供应商可控头部，原样写入服务日志，没有长度上限；对比 `pi-model-transport.ts:324-327` 对 `x-magpie-*` 明确 `slice(0, 128)`。
- 证据：上述代码；pi-ai 实际传入 string 还是 `Request` **未核实**（现有测试用的是字符串 URL）。
- 建议：`hostOf` 增加 `Request`/带 `url` 或 `href` 的对象；对 `retryAfter`、`shouldRetry` 截断（例如 128 字符），必要时只接受数字或日期格式。

### 7. 【低】【读代码证实】说明文档里仍有与新行为冲突的旧表述
- 位置：`docs/adr/0198-upgrade-pi-to-1-5-0.md:55`、`docs/pi-development-guide.md:328`、`.claude/rules/prompt-prefix.md:74`
- 问题：
  - ADR 0198 决定 7 仍写“模型返回 503 时，同一轮不会再发第二次请求”，现在已被 ADR 0245 修正，但正文没有注记；只说 `amends` 字段，读者单看 0198 会得到错误结论。
  - `pi-development-guide.md:328` 仍写网关“只允许发一次”，现在成功请求后仍然如此，但非 2xx 后已允许重发，措辞范围变窄了。
  - `.claude/rules/prompt-prefix.md:74` 说“另有两条用例”，实际重试用例已有 `[ADR-0198]`、`[RETRY-429]`、反向长等待三条。
- 建议：在 ADR 0198 决定 7 加一行“已被 ADR 0245 修订”；把 guide 改成“成功请求后只允许一次”；规则文档改为准确数量或改成“包括重试用例”。

---

## 侧重检查

- **错误路径**：重点看了重试耗尽后的错误分类。`providerStatusOf` 的正则边界问题（问题 1）和反向用例未断言错误码（问题 2）是主要风险；如果 pi-ai 抛错，`admitPiStream` 的 catch 会把 429 归成 admission failed / `PI_MODEL_ERROR`。
- **不合规范/不可信输入**：`retry-after`、`x-should-retry` 是供应商可控值，当前无长度限制（问题 6）。`hostOf` 对 `Request` 输入会丢 host。没有发现路径、密钥或请求体被写进新日志：`hostOf` 只取 `URL.host`，日志字段只有状态码和头部。
- **安全**：重试仍在 `exchange.wrapFetch` 之后，每次重发都重新走出口遮盖；没有发现重试绕过遮盖。新增日志经 `writeServiceDiagnostic` 的 `redactMachineSecrets`，但没有格式/长度校验。
- **资源耗尽**：重试次数上限 2、单次等待上限 10 秒，代码层面有界；但**取消信号在退避等待期间是否立即生效未核实**，也没有“等待中取消”测试。现有重试测试都用 `retry-after: "0"`，不覆盖真实等待。
- **不可撤销操作**：重试只发生在模型 HTTP 请求层，不执行工具、不写业务状态；未发现不可撤销副作用。模型请求可能重复发出，若服务方对部分 5xx 仍计费，则存在未核实的多计风险（作者“失败的尝试不收费”未见证据）。
- **规则/文档一致**：前缀规则“只追加”与代码一致；但 ADR 0198、开发指南、规则文档仍有旧表述（问题 7）。
- **未核实**：
  - `@earendil-works/pi-ai` 的 `provider-retry.js` 不在当前工作区，无法核实重试状态集合、退避是否响应 `AbortSignal`、错误是抛出还是转成错误流、`maxRetryDelayMs` 的真实消息格式。
  - 作者称 `production-model-composition.unit.test.ts` 有 18 条在 main 上也失败；当前环境不能运行测试，未核实。

---

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？
**不会。** 重试发生在 `streamSimple` 的 HTTP 请求层，重发同一份 `transcript` 和请求体；没有向历史追加 `context_edit`。Pi 的自动重试仍然关着：`pi-runtime-adapter.ts:1491` 仍是 `retry: { enabled: false, maxRetries: 0 }`。测试 `[ADR-0198]` 明确检查了重发的请求体逐字节相同、历史里没有 `context_edit`、下一轮请求仍以第一轮开头（`prompt-prefix.compat.test.ts:1186-1197`）。
发给模型的内容仍然只在末尾追加；本改动没有新增每轮变化的系统提示/工具字段。唯一不足是：这条测试用的是普通对话，没有同时带银行卡号等遮盖内容，所以“遮盖后重试仍逐字节相同”没有直接被这条测试锁住。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？
**未发现会。** 新增的时间戳只出现在服务日志（`writeServiceDiagnostic` 里的 `new Date().toISOString()`），不进模型请求；`gatewayPayload` 的 `routing.order` 来自固定配置；遮盖占位符由密钥和值签名生成，重试时同一个 `Exchange` 重新计算应得到相同占位符。
但这是**部分未核实**：重试会再次执行 `exchange.wrapFetch`/`#prepare`，代码上确定，但没有“带密码/银行卡 + 429 重试”的字节相等测试；同时如问题 5 所述，重试会重复写审计记录。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？
有，但不完整。
- 会失败的反向用例：`gateway-observation.unit.test.ts` 的“成功后第二次请求被拒”和“传输错误后重抛原错误”在旧代码上会失败；`[ADR-0198]` 期望 5 次请求、`[RETRY-429]` 期望 429 后继续完成，在旧代码 `maxRetries: 0` 下也会失败。
- 缺口：反向长等待用例没有断言“限流”错误码（问题 2）；没有测试 `retry-after-ms`、小数秒、无 `retry-after` 的指数退避；没有网关 + 重试 + 单次结算的集成测试；没有取消信号在退避中的测试；`provider-rejection-observation.ts` 没有独立单测；没有“敏感遮盖 + 重试”的字节/计数测试。

### 4. 改动产生或修改的每个值，使用它的地方都能接受吗？
- `maxRetries: 2`、`maxRetryDelayMs: 10_000`：只传给 pi-ai；单测在 `model-accounting.unit.test.ts:565` 只检查这两个字段。pi-ai 是否识别 `maxRetryDelayMs`、是否按作者所述格式生成错误，**未核实**（包不在工作区）。后台 `PiModelTransport` 仍是 0，见问题 3。
- `onModelRequestRejected`：生产链路 `PiAgentRuntimeAdapter` → `production-run-composition.ts:467-469` → `service-main.ts:2534-2543` 类型一致；`writeServiceDiagnostic` 接受 `string | number | boolean | readonly string[]`，`status` 是 number，`retryAfter`/`shouldRetry`/`host` 是 string 或省略，能通过。问题在值本身未做长度/格式校验、`host` 可能丢失（问题 6）。
- `providerStatusOf` 的返回值：被 `modelFailureCode` 和 `loggableModelFailure` 同时使用，两处语义一致；但正则的边界导致部分真实消息进入错误分支（问题 1）。
- 网关的 `sent`/`failure`/`repeated`：被 `gateway.result()` 和 `relayAdmittedPiStream` 消费；成功后的行为保持“第二次请求被拒”，非 2xx 后的开放范围过宽（问题 4）。
- ADR 的 `amends` 路径 `docs/adr/0198-upgrade-pi-to-1-5-0.md` 存在；新事件名 `model.request_rejected` 没有发现其他校验清单拒绝它。
