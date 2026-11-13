## 读代码证实的问题

### 1. 中：`reasonCode` 对所有 `ApplicationPortError` 一律放行，没有白名单或两端契约

- 文件:行：`packages/platform-node/src/http-gateway-server.ts:893-898`，正则定义在 `:204`
- 问题：不是只针对登录设备冲突，而是把**任何** message 恰好长得像大写机器码的端口错误都发给客户端。`ApplicationPortError` 的 message 来自整个应用层、持久化层、供应商适配层，包含 `EMBEDDING_*`、`WORKER_*`、`SANDBOX_*`、`SQLITE_*` 等内部原因码。客户端因此得到一个没有枚举、没有 schema、由实现细节决定的开放字符串集。
- 证据：

```ts
// http-gateway-server.ts:204
const MACHINE_REASON = /^[A-Z][A-Z0-9_]{2,63}$/;

// http-gateway-server.ts:893-898
sendJson(reply, statusCode, {
  error: {
    code: error.code,
    ...(MACHINE_REASON.test(error.message) ? { reasonCode: error.message } : {}),
  },
});
```

内部机器码确实会作为 `ApplicationPortError.message` 出现，例如：

```ts
// packages/platform-node/src/local-onnx-embedding.ts:211-213
function failure(code: string): ApplicationPortError {
  return new ApplicationPortError(PORT_ERROR_CODES.PROVIDER_FAILURE, code);
}
```

`EMBEDDING_LOCAL_NOT_READY`、`EMBEDDING_HTTP_FAILURE` 等都符合这个正则。它们是否会经过某个 HTTP 路由到达这个处理器，我没有逐个路由追完（标「未核实」）；但处理器本身不区分来源，这一点是确定的。

- 建议：不要从 message 猜。给 `ApplicationPortError` 增加显式的、受约束的 `reasonCode` 字段（或使用 `details.reasonCode`），只允许产品明确要暴露给客户端的枚举；在边界映射，而不是用正则判断任意 message。若坚持用正则，至少加允许清单并把清单做成共享契约。

### 2. 中低：磁盘余量等存储冲突不会得到 reasonCode，可能达不到“把两类冲突分开”的目标

- 文件:行：`apps/agent-service/src/production-login-devices-control.ts:135-136`、`apps/agent-service/test/production-login-devices-control.unit.test.ts:182-201`、`packages/platform-node/src/http-gateway-server.ts:896`
- 问题：登录设备控制层对“其他设备一直被改动”抛的是固定的 `LOGIN_DEVICES_STILL_CHANGING`；而存储冲突的 message 是自由文字 `"disk headroom"`，`details.reason` 也不会外发。因此客户端只能看到“有 reasonCode = still changing”，对磁盘不足只能靠“没有 reasonCode”来间接推断；任何其他冲突也都表现为没有 reasonCode。若 iOS 第 11 批需要正向区分“磁盘余量不足”，这个改动不够。
- 证据：

```ts
// production-login-devices-control.ts:135-136
if (remaining.length > 0)
  throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "LOGIN_DEVICES_STILL_CHANGING");
```

```ts
// production-login-devices-control.unit.test.ts:184-186
const storageError = new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "disk headroom", {
  reason: "disk_headroom",
});
```

新测试自己也是把 `"disk headroom"` 当作“不暴露的自由文字”用例（`http-gateway-server.contract.test.ts:460`、`:489-491`）。

- 建议：确认 iOS 的需求是“只需识别 still changing”还是“要识别磁盘不足”。前者现在够用；后者需要给存储冲突定义明确的公开原因码（例如 `LOGIN_DEVICE_STORAGE_UNAVAILABLE`），并在登录设备控制层显式抛出。

### 3. 低：只改了普通 JSON 出口，SSE 出口没有同步

- 文件:行：`packages/platform-node/src/http-gateway-server.ts:487-491`、`:553-554`、`:618-629`、`:688-694`
- 问题：同样的 `ApplicationPortError` 进入 SSE 时仍然只发 `data: { code: error.code }`。线程事件流里甚至已经有硬编码的 `reasonCode: "CURSOR_OUTSIDE_RETENTION"`，与本改动“从 message 推导 reasonCode”是两套规则。如果未来有 streaming 操作也需要区分同类冲突，客户端拿不到 reasonCode；两套逻辑也容易漂移。
- 证据：

```ts
// http-gateway-server.ts:553-555
if (error instanceof ApplicationPortError) {
  yield serializeSse({ event: "gateway.stream_error", data: { code: error.code } });
  return;
}
```

```ts
// http-gateway-server.ts:624-628
data: {
  code: error.code,
  ...(error.code === PORT_ERROR_CODES.NOT_FOUND
    ? { reasonCode: "CURSOR_OUTSIDE_RETENTION" }
    : {}),
},
```

- 建议：抽一个统一的错误体序列化函数，普通 JSON 和 SSE `stream_error` 共用；至少要在代码或文档里明确“reasonCode 只保证出现在非流式响应”。

### 4. 低：测试没有把真实生产者和真实网关接起来，反向用例也不是本改动的回归用例

- 文件:行：`packages/platform-node/test/http-gateway-server.contract.test.ts:459-495`
- 问题：
  - 测试直接手工抛 `"LOGIN_DEVICES_STILL_CHANGING"`，没有经过 `ProductionLoginDevicesControl`，因此不能证明生产代码实际抛出的值能通过网关的过滤。
  - 机器码用例在去掉本改动后会失败，这是有效的正向回归。
  - “自由文字不外发”的用例在改动前也通过，**不是本改动的反向回归用例**；它只防止以后把 details/自由文字加进去。
  - 没有覆盖：带尾部换行的机器码、`PORT_NOT_AUTHORITATIVE`/`PORT_NOT_FOUND` 等其他状态、实际存储冲突、未来客户端读到未知 reasonCode 的行为。
- 证据：

```ts
// http-gateway-server.contract.test.ts:460-465
const reasons = ["LOGIN_DEVICES_STILL_CHANGING", "disk headroom"];
...
throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, reasons.shift() ?? "", {
  internal: "private detail",
});
```

- 建议：加一条从真实 `ProductionLoginDevicesControl`（含存储冲突场景）到 HTTP 网关的用例；把公开原因码定义成共享常量，让生产者测试和网关测试引用同一份值，符合 I-73 的“两端都认”要求。

### 5. 低：正则的 `$` 允许一个末尾换行，且与现有机器码判断重复但不一致

- 文件:行：`packages/platform-node/src/http-gateway-server.ts:204`
- 问题：JavaScript 的 `$` 在没有 `m` 标志时也会匹配“末尾单个换行符之前”，所以 message 为 `"LOGIN_DEVICES_STILL_CHANGING\n"` 时也会通过，`reasonCode` 会带上换行。它与同一仓库已有的 `/^[A-Z][A-Z0-9_]{2,127}$/`（`production-record-failure.ts:1`）和 `{2,63}`（`production-data-export.ts:172`、`production-chat-export.ts:86`）是同一规则的多份拷贝，长度上限还不一致。
- 证据：

```ts
const MACHINE_REASON = /^[A-Z][A-Z0-9_]{2,63}$/;
```

- 建议：用一个共享的、明确的机器码判断函数/常量，并排除 `\r`/`\n`（例如先检查 `!/[\\r\\n]/.test(message)`，或在支持的环境使用更严格的边界）。这样也能避免以后各处上限漂移。

### 6. 信息：文档中的“新值清单”没有登记这个字段

- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:696`
- 问题：该设计文档要求“每个新出现的值，都写明谁产生、谁使用、两端怎样校验、哪道检查守着”，但 `error.reasonCode` 没有出现在新值清单里；`docs/architecture-v0.1.md:268` 也仍然只把 `PORT_*` 固定错误码描述为端口的稳定分类。若本改动属于 Apple 设备批次，说明文档和代码不一致。
- 建议：在新值清单里补上 `error.reasonCode` 的产生处、消费处、允许值、自动检查；或者如果这个字段不属于该设计范围，在 PR 说明里明确它的契约归属。

## 推测 / 未核实

- 哪些内部原因码（`EMBEDDING_*`、`WORKER_*`、`SANDBOX_*`）在生产中实际会经过某个 HTTP 路由到达 `setErrorHandler`：**未逐个路由核实**。处理器对所有 `ApplicationPortError` 生效是确定的，具体泄漏面未核实。
- iOS 第 11 批是否要求“磁盘不足”有正向 reasonCode：**未核实**；仓库里的 iOS 客户端目前还没有读取 reasonCode。
- 外部客户端（仓库外）是否对错误体做严格 schema 校验：**未核实**；仓库内客户端不受影响（见问题 4 的答案）。

## 侧重检查

- **错误路径**：检查了 `setErrorHandler` 中的 `HttpGatewayError`、`ContractValidationError`、`ApplicationPortError`、413/500 分支（`http-gateway-server.ts:875-916`），四处 SSE 错误出口（`:487`、`:553`、`:618`、`:688`），以及身份路由的独立错误处理器（`built-in-identity-routes.ts:95-110`）。结论：本改动只覆盖一个非流式出口，SSE 和身份路由没有同步。
- **不可信输入 / 注入**：`reasonCode` 完全来自 `error.message`，不直接来自请求体；正则只允许大写字母、数字、下划线，无法带上路径分隔符、引号、控制字符（末尾换行除外，见问题 5）。我搜索了 `new ApplicationPortError` 的动态 message，找到的都是 `Run ${runId} not found` 这类带空格/小写的自由文字，不会通过正则；没有发现当前代码把主人数据或密钥拼成纯大写 message 的情况。**未发现**直接的 secret/owner 数据泄漏路径。
- **鉴权失败**：`authenticate` 捕获所有异常后固定抛 `HttpGatewayError(..., 401)`（`http-gateway-server.ts:732-746`），不会走 `ApplicationPortError` 分支，因此不会新增鉴权失败原因码。CSRF 的 `verify` 返回 boolean，不抛端口错误。**但** `PORT_NOT_AUTHORITATIVE`（403）现在会额外暴露 `LOGIN_DEVICES_OWNER_REQUIRED`、`FILES_SCOPE_MISMATCH`、`MODEL_SELECTION_NOT_ALLOWED`、`THREAD_EXECUTION_RESOURCE_SCOPE_MISMATCH` 等更细的授权原因码；这些是内部代码，不是主人数据，属于新增的信息披露面。
- **资源耗尽 / 不可逆操作**：正则对已有 message 做一次线性匹配，新增输出只有一个小字段，没有新的循环、递归、外部调用或不可逆操作；不构成资源耗尽风险。
- **规则、文档与代码一致**：`prompt-prefix.md` 约束的是发给模型的内容，本改动只改 HTTP 错误响应，未触及模型请求组装；`docs/architecture-v0.1.md:268` 的“`PORT_*` 固定错误码”描述仍成立，但新增的 `reasonCode` 没有在 Apple 设计文档的新值清单中登记；UI 规则“不给主人看系统用语和错误码”（`docs/ui-ux-design-guide.md:59`）没有冲突，前提是 iOS 把 reasonCode 映射成用户文案而不是直接显示。

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会。** 改动位于 HTTP 网关的错误响应处理（`http-gateway-server.ts:893-898`），不是模型请求组装、系统提示、工具定义、历史消息或遮盖逻辑。发给模型的内容没有新增、删除或重排，仍然只由原来的提示词/历史组装路径决定；每轮变化的值也没有被移动到这个出口。依据 `prompt-prefix.md` 的“只追加”要求，这个改动不在其作用范围内。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**不会。** `reasonCode` 只由当前这个 `ApplicationPortError` 的 message 决定，不依赖时间、随机数、前后请求或无序集合；同一错误消息每次序列化结果相同。它也不是发给模型的文字。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有测试，但覆盖不完整：

- `http-gateway-server.contract.test.ts:459-495` 会进入 CI 的 `contracts` 项目（`ci/policy.json` 的 `packages/**/*.contract.test.ts`），属于自动检查。
- 机器码用例在撤掉本改动后会失败（旧代码没有 `reasonCode`），是有效的正向回归。
- 自由文字用例在改动前也通过，**不是本改动的反向回归**；它只守住“将来不要把自由文字/details 加进去”。
- 没有实际 `ProductionLoginDevicesControl` 到 HTTP 的端到端用例，也没有尾部换行、其他状态码、磁盘冲突等边界用例。
- 注意 `npm run check` 本身不跑 `contracts` 项目，只有 CI 的 coverage 作业会跑；本地只跑 `npm run check` 不会执行这个新测试。

建议补一条真实生产者→网关的契约用例，并把公开 reasonCode 做成共享常量，避免只靠两处硬编码字符串“碰巧一致”。

### 4. 改动产生/修改的每个值，使用它的地方都能接受吗？

新增值是错误体里的 `error.reasonCode`：

- **产生处**：`http-gateway-server.ts:896`，值是任意匹配 `^[A-Z][A-Z0-9_]{2,63}$` 的 `error.message`；没有枚举、没有白名单、没有服务端响应 schema。
- **仓库内消费处**：
  - `apps/control-center/src/gateway-client.ts:319-327` 只读 `error.code`，其他字段被忽略，能接受多出来的 `reasonCode`。
  - `clients/apple/Sources/HimawariCore/DeviceAPIClient.swift:211-223` 的 `ErrorBody.Inner` 只解码 `code`、`serverTime`、`pairingCodeTtlSeconds`；Swift 的 `JSONDecoder` 默认忽略未知键，所以现有 iOS 客户端不会因为多一个字段而解析失败。
- **两端校验**：目前没有。服务端不限制具体值，客户端也还没有读取 `reasonCode`；即将到来的 iOS 第 11 批若要按字符串分支，必须自己维护一份与服务端一致的允许值，否则一个 message 改名就会让客户端静默走进默认分支。这正是 I-73 提醒的那类“只在改动一端认”的问题。

建议把 reasonCode 定义成共享的、可校验的枚举/类型，并在网关出口、客户端解析和测试里共同使用。
