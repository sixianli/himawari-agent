## 结论（按严重度从高到低）

### 1. 中：源码扫描门槛只覆盖一个文件、只认字面量 `body += chunk`，同类假服务器漏在门槛外

- 文件:行：`test/integration/request-body-decoding.test.ts:21-28`、`:86-96`；漏掉的同类代码 `test/fixtures/product-path-harness.ts:631-635`
- 问题：门槛只读取 `production-http-composition-process.test.ts` 一个文件，正则只匹配 `\bbody \+= chunk\b`，且只统计字面量 `readRequestBody(request)`。同仓库另一个假模型服务器仍用逐块字符串拼接。
- 证据（我亲自读到）：
  - `test/integration/request-body-decoding.test.ts:24-25`：
    ```ts
    if (/\bbody \+= chunk\b/u.test(source)) problems.push("body += chunk");
    if (source.split("readRequestBody(request)").length - 1 < 2)
    ```
  - `test/fixtures/product-path-harness.ts:631-634`：
    ```ts
    let raw = "";
    request.on("data", (chunk: Buffer | string) => {
      raw += chunk;
    });
    ```
  - `test/fixtures/request-body.ts:1-14` 的读法才是先收 `Buffer[]` 再 `Buffer.concat(...).toString("utf8")`。
- 影响：`product-path-harness.ts` 由 `test/integration/product-path-browser.test.ts` 使用；如果它的请求体也被切在多字节字符边界，同样会产生 U+FFFD。它是否真的会触发，我**未核实**（该文件在 `ci/policy.json` 里作为 qualification 被排除在常规 integration 之外）。
- 建议：把“按块拼字符串”的检查做成可复用的扫描函数，扫描所有测试里的假 HTTP/HTTPS 模型服务器（至少 `test/fixtures/**`、`test/integration/**` 中自建 provider 的文件），并匹配 `+= chunk`、`= body + chunk`、`push(...).join("")` 等常见写法；或直接让所有假 provider 复用 `readRequestBody`。反向用例至少覆盖“换变量名/换拼接写法仍被抓到”。

### 2. 低：`answerFailedRead` 只处理“读取失败”，处理器内的解析/异常仍是未处理的 Promise 拒绝

- 文件:行：`test/integration/production-http-composition-process.test.ts:76-79`、`:200-223`、`:227-285`
- 问题：`readRequestBody(request).then(onFulfilled, answerFailedRead(response))` 的第二个参数只接收第一个 Promise 的拒绝；`onFulfilled` 内部的 `JSON.parse`、`input.model` 读取、`response.writeHead(200)` 等抛错不会被它接住，而是变成未处理的 Promise 拒绝（`void` 丢弃了返回的 Promise）。
- 证据（我亲自读到）：
  ```ts
  const answerFailedRead = (response: ServerResponse) => () => {
    response.writeHead(500);
    response.end();
  };
  ```
  ```ts
  void readRequestBody(request).then((body) => {
    const input = JSON.parse(body);
    ...
    response.writeHead(200, { "content-type": "application/json" });
  }, answerFailedRead(response));
  ```
- 影响：作者说“处理器读取失败回 500”是准确的；但“读取成功、处理失败”仍会以未处理拒绝结束测试进程。若客户端已断开、`response` 已 destroyed，`answerFailedRead` 里的 `writeHead` 本身也可能再抛错，形成第二个未处理拒绝（这一点我**未核实**运行表现）。
- 建议：改成 `.then(...).catch(...)`，或者把整个处理体放进 `try/catch`，并在回 500 前检查 `response.headersSent`/`response.writableEnded`/`response.destroyed`；失败时至少保留可诊断信息。

### 3. 低：扫描门槛会误报正确的重构，也会放过注释/字符串里的假命中

- 文件:行：`test/integration/request-body-decoding.test.ts:24-26`
- 问题：门槛是字符串计数，不是语法检查。
  - 误报：把调用改成多行 `readRequestBody(\n  request,\n)`、或包一层 helper、或给 `readRequestBody(request, callback)` 传回调，都会让 `source.split("readRequestBody(request)")` 计数不足而失败，尽管行为正确。
  - 漏报：注释或字符串里出现两次 `readRequestBody(request)` 也能凑够数量；实际调用被删掉仍可能通过。
- 证据：同文件 `:25` 的 `source.split("readRequestBody(request)").length - 1 < 2`；同文件 `:59` 的真实 HTTP 用例自己就用了 `readRequestBody(request, () => { ... })`，这种写法在假服务器里会被门槛判为不合格。
- 建议：改为检查 AST/正则允许空白与参数，或至少匹配 `readRequestBody\s*\(\s*request\b`，并排除注释/字符串；更好的做法是断言假服务器在“分两块送达”的真实 HTTP 场景下返回正确文本，而不是扫源码。

### 4. 低：`isAgentRequest` 靠“第一条 system 消息内容恰好等于遮盖说明”区分后台请求，规则较脆

- 文件:行：`test/fixtures/agent-request.ts:1-13`
- 问题：后台请求被排除的唯一依据是 `first.content !== CHAT_EGRESS_LEGEND.text`。当前后台上下文确实是“system 提示正好是这段说明”，所以能工作；但一旦以后后台提示改成“说明 + 其他文字”、或说明文字换版本，后台请求就会被重新算作对话请求。反过来，如果某个真实对话的系统提示恰好等于这段说明，也会被排除。
- 证据（我亲自读到）：
  - `test/fixtures/agent-request.ts:11-12`：
    ```ts
    const first = (body["messages"] as Array<{ role?: unknown; content?: unknown }>)[0];
    return first?.role === "system" && first.content !== CHAT_EGRESS_LEGEND.text;
    ```
  - `packages/runtime-pi/src/egress-context.ts:23-28` 确认后台上下文是 `systemPrompt: EGRESS_PLACEHOLDER_LEGEND`，`messages: [{ role: "user", ... }]`。
  - `packages/runtime-pi/test/pi-model-transport.unit.test.ts:543-546` 确认实际序列化后第一条是 `{ role: "system", content: EGRESS_PLACEHOLDER_LEGEND }`。
- 影响：当前实现可用，属于可维护性/未来回归风险，不是眼前错误。
- 建议：用更明确的信号区分后台请求（例如请求体里的 `max_tokens`、特定模型、或测试侧给后台调用打的标记），或在门槛里同时锁定“后台上下文必须仍然只有这段说明”，让规则变化时测试先失败。

### 5. 信息：这次改动没有产品代码变更，测试用的假服务器仍无请求体大小上限（测试环境，非生产风险）

- 文件:行：`test/fixtures/request-body.ts:1-14`、`test/integration/production-http-composition-process.test.ts:163-304`
- 问题：`readRequestBody` 会把整个请求体缓存在内存里，没有上限。它只用于测试假服务器，生产请求路径未改；不构成生产资源耗尽风险，但测试若被超大请求打到会占用内存。
- 证据：`test/fixtures/request-body.ts` 使用 `const chunks: Buffer[] = []` 后 `Buffer.concat(chunks)`；生产代码在 `51d680b..038d032` 的 diff 中没有任何 `apps/`、`packages/` 源码变化。
- 建议：无需为测试加限额；若以后把该 helper 复用到会接外部流量的地方，应加上限。

---

## 读代码证实的 vs 推测

**读代码证实的：**

- 相对 `51d680b`（main），`038d032` 只改了测试、文档、`.claude` 和 `.agents`，没有改 `apps/` 或 `packages/` 的产品源码。
- `isAgentRequest` 已抽到 `test/fixtures/agent-request.ts`，生产测试和直接用例都引用它。
- `readRequestBody` 是先收集 `Buffer`、最后一次性 `toString("utf8")`，不会在多字节字符中间解码。
- 假服务器两处读取（embeddings、chat completions）都换成了 `readRequestBody(request)`，失败时走 `answerFailedRead`。
- 扫描门槛只读 `production-http-composition-process.test.ts`，正则只认 `body += chunk`，调用计数只认 `readRequestBody(request)` 这个精确字符串。
- `test/fixtures/product-path-harness.ts` 仍用 `raw += chunk` 读请求体。
- `isAgentRequest` 的直接用例覆盖：对话请求为 true、只带说明的后台请求为 false、非 chat 路径为 false、空 messages 为 false、缺 body 为 false；反向用例证明旧过滤器会把后台请求算成 true。
- `docs/incidents-and-gates.md` 的 I-82 描述与新增用例大体一致：真实 HTTP 分块、反向 U+FFFD、源码扫描、`isAgentRequest` 正反例。
- `.claude/rules/prompt-prefix.md` 对端到端测试的描述已改成“测试自建 HTTPS 模型桩里收齐字节后抓取原始请求体”，与 `readRequestBody` + `capturedRequest.raw = body` 一致。
- `ci/policy.json` 的 `integration` 项目包含 `test/integration/**/*.test.ts`，`test`、`node-floor`、`coverage` 都跑 integration，所以新增的 `request-body-decoding.test.ts` 在常规 CI 范围内。

**推测/未核实：**

- 作者说本地 `production-http-composition-process.test.ts` 10 个用例、`request-body-decoding.test.ts` 7 个用例全过；我没有运行测试，**未核实**。
- `product-path-harness.ts` 的假 provider 在实际测试中是否真的会把多字节字符切块，**未核实**。
- `answerFailedRead` 在客户端断开、`response` 已 destroyed 时是否会再抛错，**未核实**。
- I-82 里“CI 上 PR-A 第二轮请求体为什么比本机大到超过 16134 字节”这一未覆盖项，我没有进一步查，**未核实**。

---

## 侧重检查（错误路径、不可信输入、安全、资源耗尽、不可撤销操作、文档一致性）

- **错误路径**：读取失败回 500 已覆盖；但解析/处理器异常仍会未处理拒绝，见问题 2。
- **不可信输入**：`isAgentRequest` 对 `messages` 非数组、元素非对象、空数组、缺 body 都有防御，不会崩；`first?.role` 对 null/原始值也安全。`readRequestBody` 对 `string` 和 `Buffer` 分别处理；对象模式下的非 Buffer chunk 会被强转，测试场景未涉及，**未核实**。
- **安全**：改动只在测试；没有引入新的密钥、日志或网络暴露。假服务器仍监听回环地址并使用测试证书，未见新的信任边界变化。
- **资源耗尽**：`readRequestBody` 无大小上限，但仅测试使用；`providerRequests` 在测试进程内累加，属既有行为。
- **不可撤销操作**：本次 diff 没有涉及删除、迁移、覆盖持久化数据的生产操作；测试里的数据库更新只改临时库里的 `expiresAt`。
- **规则/文档一致性**：`prompt-prefix.md` 和 I-82 与代码中“收齐字节再解码”“isAgentRequest 排除遮盖说明”一致；但 I-82 的门槛描述容易被读成“所有假模型服务器都不再用 `body += chunk`”，而实际只扫一个文件，`product-path-harness.ts` 仍是旧写法，见问题 1。

---

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？

**不会改变生产请求开头。** 相对 main，这个提交没有改任何产品代码（`apps/`、`packages/` 均无变化），发给模型的内容不会因为本改动而变。

测试侧仍然在验证“只追加、开头不变”：
- `test/integration/production-http-composition-process.test.ts:1870-1878` 的 `expectAppendOnly` 逐条比较旧消息 `JSON.stringify` 完全相等；
- `:1937-1938` 比较三轮的 `requestHead`（前缀字节 + tools）；
- `:1943-1947` 断言每轮会变的运行环境说明出现在最后一条消息，且第二轮/第三轮的前缀里不出现工作目录。

因此，就本次改动而言：**请求开头未被改变，仍然是末尾追加；每轮变化的值仍由最后一条消息承载**（至少覆盖了 PR-A 的运行环境和 PR-B 的系统提示场景）。产品代码层面没有变更，这一点是确定的。

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

**不会引入新的字节不稳定。** `readRequestBody` 先收集字节再一次解码（`test/fixtures/request-body.ts:6-13`），同一段文字得到相同字节；`isAgentRequest` 是纯函数，只做字符串比较，不含时间、随机数或顺序依赖。

新增的 `egress` 只是把测试夹具对齐生产的出口遮盖，占位符按同一密钥和同一值生成同一编号（`packages/application/src/services/model-egress.ts` 的 `letters`/`table`），不依赖请求顺序产生不同字节。

仓库里原本就存在的后台调用 `Date.now()` 时间戳（`packages/runtime-pi/src/pi-model-transport.ts:310` 传给 `backgroundModelContext`）是既有行为，且只影响后台请求的 user 消息，不是本次改动引入的，也不在对话请求头部。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**有，并且在常规 CI 范围内。** `test/integration/request-body-decoding.test.ts` 属于 integration 项目；`ci/policy.json` 的 `test`、`node-floor`、`coverage` 都包含 integration，`package.json` 的 `test` 走 `scripts/ci/local.mjs --check test`。

反向用例的有效性：
- 源码扫描反向用例 `:90-95` 对旧写法 `body += chunk` 会返回 `"body += chunk"`，对只有一处 `readRequestBody(request)` 会返回数量不足，**会失败**。
- `isAgentRequest` 反向用例 `:116-125` 证明旧过滤器对后台请求返回 true，而新函数返回 false；如果把它改回旧实现，直接用例 `:110` 会失败；如果改成恒 true/false，正例/反例也会失败，**行为被锁住**。

局限：扫描反向用例只证明“精确的 `body += chunk`”和“精确的 `readRequestBody(request)` 计数”会失败，不能证明换变量名、换拼接方式、换格式、注释假命中会被发现；也没有覆盖 `product-path-harness.ts`。所以“有反向用例”成立，但“反向用例覆盖所有同类回归”不成立。测试实际执行结果我**未核实**。

### 4. 改动产生或修改的每个值，每个使用它的地方都能接受吗？

逐项核对：

- **`isAgentRequest`**（新增于 `test/fixtures/agent-request.ts`）
  - 产生：`test/fixtures/agent-request.ts:3-13`。
  - 使用：`test/integration/production-http-composition-process.test.ts:20,81,1859`，`test/integration/request-body-decoding.test.ts:8,109-113,124`。
  - 两端一致：签名接受 `{ path, body? }`，`Array.prototype.filter` 会额外传 index/array，但函数只解构第一个参数，能接受；`body` 可能为 undefined，已用 `body?.` 处理。**可接受。**
- **`readRequestBody`**（新增/扩展于 `test/fixtures/request-body.ts`）
  - 产生：`:3-14`。
  - 使用：`production-http-composition-process.test.ts:200,227`；`request-body-decoding.test.ts:43,59`。
  - 两端一致：前者只传 request，后者传 request + 回调；函数第二个参数可选，`Readable` 类型匹配。返回 `string`，调用方都按字符串解析/比较。**可接受。**
- **`answerFailedRead`**（新增于 `production-http-composition-process.test.ts:76-79`）
  - 使用：`:223`、`:285` 作为 `.then` 的 onRejected。
  - 两端一致：签名 `(response) => () => void` 正好匹配 onRejected 的“接收一个 reason、返回 void”。**可接受**，但只覆盖读取失败，见问题 2。
- **`egress` 配置键**（新增于 `test/fixtures/production-service-main-child.mjs:130`）
  - 使用端是 `agent.createProductionModelComposition({...})`；同文件 `:166` 的 memory composition 已经用过同一个 `egress: agent.createProductionModelEgress(configuration, sources)`，生产 `apps/agent-service/src/service-main.ts:295,348` 也这样传。
  - 结论：键名和值的形式与既有调用一致，**可接受**。我没有逐行核对 `createProductionModelComposition` 的完整类型定义，但已有同构调用和生产调用作为证据。
- **`CHAT_EGRESS_LEGEND` 的引用位置**（从生产测试移到 `test/fixtures/agent-request.ts`）
  - 两端都是 `@himawari-agent/prompt-catalog` 的同一导出，值相同。**可接受。**
- **文档/manifest**
  - `.claude/rules/prompt-prefix.md:75` 与 `readRequestBody`/`raw` 实现一致。
  - `docs/incidents-and-gates.md` 的 I-82 与新增用例逐项对应；唯一偏差是“假模型服务器源码不得再出现 `body += chunk`”的实际扫描范围只限一个文件，见问题 1。

总体：**新增/修改的值在它们各自的使用点上类型和语义都相容；没有发现会直接导致编译或运行失败的错配。** 主要问题是门槛覆盖不完整，而不是某一端的校验拒绝了这个值。
