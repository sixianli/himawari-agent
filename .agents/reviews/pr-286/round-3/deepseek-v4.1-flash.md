## 结论概览

对比 `c6ff303..a86c737` 与第 2 轮增量后：产品代码（`apps/*/src`、`packages/*/src`）没有任何改动；改动集中在测试夹具、测试、文档和复核记录。`038d032..a86c737` 里的 `jarvis-test`、`integration-parallelism`、`apps/control-center` 等是合并 `origin/main` 带来的，不属于本 PR 的第 3 轮修复。

没有发现高危问题。主要问题是：宣称“不得再出现逐块拼字符串”的源码扫描正则覆盖面不足，以及一个仍然使用旧过滤器的测试回调。

---

## A. 读代码证实的问题（按严重度）

### 1. 中：扫描正则只认 `X += chunk;`，漏掉同样是逐块字符串化的写法；文档说法过宽

- 文件: `test/integration/request-body-decoding.test.ts:25`、`:30`、`:94`；`docs/incidents-and-gates.md:120`
- 问题: 正则 `/\b\w+\s*\+=\s*chunk\s*;/u` 只匹配“累加变量名 + `+=` + 字面量 `chunk` + 分号”。以下三种同样是逐块解码、同样会产生 U+FFFD，但都不会被扫描到：
  - `body += chunk.toString("utf8");`
  - `request.on("data", (data) => { body += data; });`（源变量改名）
  - `body += chunk`（无分号，ASI 写法）
- 证据（读代码）:
  - `const CHUNKWISE_STRING_DECODING = /\b\w+\s*\+=\s*chunk\s*;/u;`（`request-body-decoding.test.ts:25`）
  - `test/fixtures/product-path-harness.ts:1207` 现有代码就是 `output += chunk.toString("utf8");`，正则不会命中它（本次这里是子进程 stdout，恰好是 ASCII，不影响结果）。
  - 文档写成“不得再出现逐块拼字符串……并带换变量名的反向”（`docs/incidents-and-gates.md:120`），实际反向用例只换了累加变量名（`body`/`raw`），没有换源变量名，也没有覆盖 `.toString()`。
- 建议: 扫描 `request.on("data", ...)` 回调内任何对参数做字符串化后 `+=` 的写法，或强制两个夹具都使用 `Buffer[]` + `Buffer.concat`/`readRequestBody`。反向用例加入 `raw += chunk.toString("utf8")`、`(data) => { body += data; }` 和无分号写法；同时明确排除子进程 stdout 诊断的 `output += chunk.toString(...)`。

### 2. 低：`product-path-harness.ts` 的扫描 `minimumReadCalls` 为 0，未真正验证“先收 Buffer 再解码”

- 文件: `test/integration/request-body-decoding.test.ts:94`；`test/fixtures/product-path-harness.ts:631-636`
- 问题: 对 `product-path-harness.ts` 只检查“没有匹配到那个正则”，不要求它使用 `readRequestBody` 或 `Buffer.concat`。如果以后退回成 `body = body + chunk`、`body += chunk.toString()`，测试仍会通过。当前实现本身是正确的。
- 证据（读代码）:
  - `expect(chunkwiseDecodingProblems(readFileSync(PRODUCT_PATH_PROVIDER, "utf8"), 0)).toEqual([]);`
  - 当前实现: `const received: Buffer[] = []; ... const raw = Buffer.concat(received).toString("utf8");`
- 建议: 对第二个文件至少断言存在 `Buffer.concat(...).toString("utf8")`，或要求它导入 `readRequestBody`；更简单的做法是统一两个假服务器都用 `readRequestBody`。

### 3. 低：`chatReply` 仍用“第一条消息是 system 就算对话请求”，现在后台请求会命中这个旧判断

- 文件: `test/integration/production-http-composition-process.test.ts:1980`
- 问题: 夹具补上 `egress` 后，标题/记忆整理等后台请求真的会到达假模型服务器。`chatReply` 仍用旧条件判断是否对话请求：
  `if (messages[0]?.role !== "system" || !chosen) return { text: "安装后的持久回答" };`
  后台请求的第一条消息恰好也是 `role: "system"`（内容为遮盖说明），因此当 `chosen` 已被前一个对话请求设置后，后台请求会收到 `{ tool: chosen }`。`PiModelTransport` 会把工具调用判为 `AI_GATEWAY_TOOL_CALL_UNSUPPORTED`，后台调用失败。
- 证据（读代码）:
  - 上述 `:1980`。
  - 后台请求形状由 `packages/runtime-pi/test/pi-model-transport.unit.test.ts:543-546` 固定为 `[{ role: "system", content: EGRESS_PLACEHOLDER_LEGEND }, { role: "user", ... }]`。
  - `packages/runtime-pi/src/pi-model-transport.ts` 有 `terminalMessage.content.some((item) => item.type === "toolCall")` 时返回 `AI_GATEWAY_TOOL_CALL_UNSUPPORTED`。
- 说明: 当前工具循环测试没有断言后台调用必须结算，所以可能仍然通过；这是启用了后台请求后遗留的测试逻辑不一致，不是产品缺陷。
- 建议: 该回调也改用 `isAgentRequest`（或同样的“首条 system 且内容不是遮盖说明”判断），后台请求一律回普通文本。

### 4. 低：`isAgentRequest` 直接绑定提示词目录常量，和后台请求使用的别名是两个入口

- 文件: `test/fixtures/agent-request.ts:1`、`:12`；`packages/application/src/services/egress-legend.ts:6`；`packages/runtime-pi/src/egress-context.ts:25`
- 问题: 过滤用 `CHAT_EGRESS_LEGEND.text`，后台系统提示用 `EGRESS_PLACEHOLDER_LEGEND`。目前二者相等（`EGRESS_PLACEHOLDER_LEGEND = CHAT_EGRESS_LEGEND.text`），所以过滤器正确；但只要以后后台改用 `CHAT_EGRESS_LEGEND_WITH_RESTORE` 或加前后缀，`isAgentRequest` 会静默把后台请求重新算成对话请求。
- 证据（读代码）: 上述三处赋值与 `return first?.role === "system" && first.content !== CHAT_EGRESS_LEGEND.text;`。
- 建议: 测试夹具直接复用后台上下文使用的同一个常量/别名，或在测试里断言两者相等，避免未来漂移。

### 5. 低：`.then(...).catch(answerFailedRead(response))` 现在也会吞掉成功处理器里抛出的错误

- 文件: `test/integration/production-http-composition-process.test.ts:76-81`、`:228`、`:300`
- 问题: 从 `.then(onFulfilled, onRejected)` 改成 `.then(onFulfilled).catch(...)` 后，`JSON.parse`、`chatReply`、`response.write` 等成功处理器内部的异常也会被转成 500，原始错误不再冒泡。对测试桩来说更健壮，但会把测试作者的断言/回调错误变成远端 500，诊断信息变少。
- 证据（读代码）: `answerFailedRead` 本身检查正确：
  `if (response.destroyed || response.writableEnded) return;`
  `if (!response.headersSent) response.writeHead(500);`
  `response.end();`
- 建议: 若只想处理读取失败，保留 `.then(ok, fail)`；若要兜住处理器异常，至少在 `answerFailedRead` 里记录一下错误类别，避免完全静默。

### 6. 低：新的源码扫描放在 integration 项目，`npm run check` 不会跑

- 文件: `package.json` 的 `check:steps`；`ci/policy.json` 的 integration `include`
- 问题: `request-body-decoding.test.ts` 位于 `test/integration/**`，`npm run check` 的步骤里没有常规 integration（只有 `check:admin-schema-range` 这种按名字挑选的单测）。I-82 恰恰是“快速模式不跑第 3 层、CI 又停了”才漏掉的；这个新门禁在本地快速模式下同样不会运行，只在完整测试/CI 的 integration 作业里运行。
- 证据（读代码）: `check:steps` 列表；`ci/policy.json` 中 integration `include` 为 `test/integration/**/*.test.ts`。
- 建议: 这段源码扫描和真实分块解码测试其实不需要产品构建，可以移到 `test/tooling/` 并挂进 `npm run check`（或新增一个 `check:request-body-decoding` 步骤），让它在快速模式也拦住同类回归。

### 7. 低：真实 HTTP 分块测试依赖 50ms 定时器和“至少两块”

- 文件: `test/integration/request-body-decoding.test.ts:83`、`:86`
- 问题: 通过 `setTimeout(() => outgoing.end(tail), 50)` 造成两块，并断言 `chunkCount >= 2`。在高负载 CI 上，客户端的两次写入仍可能被服务器合并为一个 `data` 事件，导致偶发失败。
- 证据（读代码）: 上述定时器与 `expect(chunkCount).toBeGreaterThanOrEqual(2);`。
- 建议: 直接对服务器端用两个 `Readable`/`PassThrough` 块驱动，或放宽断言为“解码结果正确”（分块读取的单测已经覆盖了块边界）。

### 8. 观察：同类逐块解码仍存在于另一个假模型服务器

- 文件: `test/tooling/opencode-review.test.mjs:1358-1361`
- 问题: `startScriptedModel` 仍是 `body += chunk;`。它不在本次两文件扫描范围内；如果该测试的请求体包含中文且被切在字符中间，同样会出现 U+FFFD。是否实际触发取决于请求体大小和分块，未核实。
- 证据（读代码）: `request.on("data", (chunk) => { body += chunk; });`
- 建议: 如果这个桩会处理非 ASCII 大请求，顺手改成收 `Buffer` 再解码；否则在文档里把“假模型服务器”范围明确限定为本次两个产品路径夹具即可。

---

## B. 推测 / 未核实

- 作者说本地 `production-http-composition-process.test.ts` 10 个用例、`request-body-decoding.test.ts` 7 个用例全过：用例数量与代码一致（我数到 10 和 7），但**我没有运行测试**，无法核实通过。
- `product-path-harness.ts` 的假服务器“只在 Hermes 资格验证里用”：读代码看，`installProductPath` 只被 `product-path-browser.test.ts` 等资格/浏览器测试调用，符合；但 Hermes 上是否实际运行，未核实。
- `product-path-harness.ts` 改动后的真实行为没有在本机跑；只从代码判断：Data 事件默认是 `Buffer`，收集后一次 `toString("utf8")` 与原逻辑的最终语义一致，且修复了跨块汉字损坏。若外部没有调用 `request.setEncoding`，行为保持。
- 后台请求首条消息实际序列化形状由 `pi-model-transport.unit.test.ts` 的断言固定为 `role: "system", content: EGRESS_PLACEHOLDER_LEGEND`；外部 `@earendil-works/pi-ai` 的实际实现未读到（`node_modules` 未安装），但测试代码和旧过滤器行为一致，可信度高。

---

## C. 侧重检查

- **错误路径**：`readRequestBody` 拒绝时由 `.catch` 回 500；响应已销毁或已结束时不再写，避免 `write after end`。这条逻辑正确（`production-http-composition-process.test.ts:76-81`）。`readRequestBody` 对空 body 返回 `""`，`JSON.parse("")` 现在会被 `.catch` 接住，比原来在 `end` 事件里抛未捕获异常更好。
- **不可信/畸形输入**：两个假服务器仍对请求体直接 `JSON.parse`；`product-path-harness.ts` 的 `JSON.parse` 仍在 `request.on("end")` 里且没有 `try/catch`，畸形 body 会让测试进程抛异常。这是既有行为，本次未改，也不是产品代码风险。测试桩没有请求体大小上限，属于测试环境资源风险，非新增。
- **安全**：`production-service-main-child.mjs:130` 新增的 `egress` 使用受限密钥源懒解析，不写日志；与生产 `service-main.ts:1798-1803` 的用法一致，且测试配置里有唯一的 `payload-encryption` 引用（`production-http-composition-process.test.ts:424`）。新增出口遮盖只会让测试更接近生产，没有发现秘密暴露。
- **资源耗尽**：`readRequestBody` 与原来的字符串累加都会持有整个 body，内存量级相同；本次没有新增限制，也没有恶化。
- **不可撤销操作**：本 PR 没有删除/写生产数据；合并进来的 `removeWorkspace` 只操作测试临时目录，属于 main 的改动。
- **规则/文档一致性**：`.claude/rules/prompt-prefix.md:75` 的修改准确（HTTPS 桩收齐字节后比对）。I-82 行关于“两个假模型服务器、带反向”基本准确，但“逐块拼字符串”的保证强于正则实际覆盖，见问题 1。`check-incident-gates` 只校验带 `/` 的反引号路径，I-82 里裸文件名 `production-http-composition-process.test.ts` 不会被校验；其余带路径的文件都存在，门槛格式不会因此失败（读 `scripts/check-incident-gates.mjs:11,65-70` 证实）。

---

## D. 逐条回答必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会（产品侧）。** `git diff --stat -- packages apps` 对产品源码无输出；本次只改了测试夹具、测试、文档和复核记录。发给模型的内容仍由原有生产代码组装，仍然遵循 `prompt-prefix.md` 第 4 条“只在末尾追加”和第 2 条“会变的值只放最后一条消息”。

测试侧：`readRequestBody` 只改变“假服务器如何解码已收到的字节”，不改变真实请求内容。`production-service-main-child.mjs` 补 `egress` 只影响测试里的后台请求（标题、记忆整理、主动判断等），让它们从“直接崩掉”变成按生产行为发送；这些是独立的后台调用，不是同一对话的轮次追加，不会动对话请求的系统提示/工具/历史前缀。`isAgentRequest` 只是把后台调用从“对话请求”统计里排除，避免 `[PR-A]/[PR-B]` 把后台调用误认为后续轮次。

每轮会变的值（时间、记忆、运行环境说明）仍然在最后一条用户消息里：后台 prompt 的 `当前时间` 也在最后一条 user 消息（`packages/runtime-pi/test/pi-model-transport.unit.test.ts:555-562`）；本次没有移动它们。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**不会。** 本次恰好是在修“同一段文字因分块边界不同而变成 U+FFFD”的不确定解码：`readRequestBody` 先收 `Buffer[]`，最后只 `toString("utf8")` 一次，结果与分块方式无关。`product-path-harness.ts` 也改成同样做法。没有新增带时间的请求字段、无序集合或依赖后文的遮盖。`isAgentRequest` 使用固定常量比较，不引入上下文相关字节。

### 3. 有没有对应的自动检查，反向用例会不会真的失败？

有，但有两处不足：

- 有 7 个用例；覆盖真实 HTTP 两块送达、旧写法产生 U+FFFD 的反向、两个假服务器源码扫描、`isAgentRequest` 正反用例。
- 如果直接把 `production-http-harness` 退回成 `body += chunk;`、或把 `product-path-harness` 退回成 `raw += chunk;`，扫描断言会失败（正则能命中）。
- **但**退回成 `body += chunk.toString("utf8")`、`body += data`（源变量改名）或无分号写法时，检查不会失败，见问题 1、2。
- 该测试位于 integration 项目，`npm run check` 不运行；本地快速模式只有完整测试/CI 才会跑到，见问题 6。

### 4. 每个产生或修改的值，使用方都能接受吗？

逐个核对结果：

- `test/fixtures/request-body.ts` 的 `readRequestBody`：使用方是 `production-http-composition-process.test.ts:201,232` 和测试自身；`IncomingMessage` 是 `Readable`，类型与运行时都接受。**接受**。
- `test/fixtures/agent-request.ts` 的 `isAgentRequest`：使用方是 `production-http-composition-process.test.ts:82,1874` 的两处过滤，`providerRequests` 的 `path`/`body` 形状匹配。逻辑上能正确排除后台请求（首条 system 且内容等于遮盖说明）。**接受**，但有常量耦合，见问题 4。
- `docs/incidents-and-gates.md` 新增 I-82 的路径：`test/integration/request-body-decoding.test.ts`、`test/fixtures/request-body.ts`、`test/fixtures/agent-request.ts`、`test/fixtures/product-path-harness.ts` 均存在；`check-incident-gates` 只校验带 `/` 的路径，裸文件名不校验，**不会因路径缺失失败**。
- `test/fixtures/production-service-main-child.mjs:130` 的 `egress`：`ProductionModelCompositionOptions` 要求 `egress: ModelEgress`（`production-model-composition.ts:87-88`），`createProductionModelEgress(configuration, sources)` 返回该类型；配置里有且只有一个 `payload-encryption` 引用（`production-http-composition-process.test.ts:424`），`createProductionModelEgress` 对“必须恰好一个”的校验通过。同一模式已在 `service-main.ts:1798-1803` 和 `test/qualification/sandbox-install-restart-model.mjs:321` 使用。**接受**。
- `request-body-decoding.test.ts` 里的 `CHUNKWISE_STRING_DECODING` / `READ_REQUEST_BODY_CALL` 只在测试内部使用，没有外部使用方。**接受**。

---

## E. 对作者三个重点问题的直接回答

1. **`product-path-harness.ts` 是否保持原行为**：是。除了把“按块 `toString` 隐式解码”改成“收齐 `Buffer` 后解码一次”这一处有意的正确性修复外，`JSON.parse`、`modelRequests.push`、各路由分支的时序都没有变；字符串 chunk（若外部调用过 `setEncoding`）也会先转回字节再统一解码，最终语义相同。
2. **扫描正则是否误报 `output += chunk.toString(...)`**：不会误报；它匹配不到。但这正是问题：这是一种同样会破坏多字节字符的写法，应该被拦下，见问题 1。
3. **`answerFailedRead` 的检查是否正确**：正确。先看 `destroyed || writableEnded`，避免重复结束；只在 `!headersSent` 时写 500，避免重复 `writeHead`；随后 `end()`。唯一值得留意的是 `.catch` 把成功处理器里的错误也吞成 500，见问题 5。
