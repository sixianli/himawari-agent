## 侧重检查

- **错误路径**：逐步读了 `ApplicationPortError` 在 HTTP 网关里的出口（`packages/platform-node/src/http-gateway-server.ts:884-899`）。现在只有白名单里的 `error.message` 会变成 `error.reasonCode`；自由文字、`details` 都不会发出。`sendJson` 没有其他拼装错误正文的分支。结论：错误正文没有新增泄漏面。
- **不可信输入 / 安全**：旧的“纯大写机器码”正则已删除（diff 中 `MACHINE_REASON` 被移除），改为精确清单匹配（`packages/gateway-contracts/src/contracts-v2.ts:949-952`）。内部机器码如 `EMBEDDING_LOCAL_NOT_READY` 不会再因为“长得像机器码”而外泄。结论：这是安全边界上的收紧。
- **资源耗尽 / 不可撤销操作**：`login.devices.revoke_others` 的重试、成功条件和最终抛出点没有改变，只把消息换成带类型的常量（`apps/agent-service/src/production-login-devices-control.ts:32,137-138`）。没有新增重试、并发或撤销范围。结论：没有改变不可撤销操作的行为。
- **规则 / 文档一致性**：本次 diff 没有改任何提示词、系统提示、工具定义、历史或遮盖代码；`docs/incidents-and-gates.md` 中 I-73 的教训是“每个值都要核对产生处和使用处”，本次新增值基本照做，但客户端消费和文档登记仍有缺口（见下）。
- **自动检查**：逐行读了新增测试；没有运行测试（工具限制只允许读代码和只读 git）。

## 发现

### 1. 低：新增用例打的是查询接口，而目标原因码来自命令接口

- 文件：`packages/platform-node/test/http-gateway-server.contract.test.ts:459-496`
- 问题：真正产生 `LOGIN_DEVICES_STILL_CHANGING` 的是 `login.devices.revoke_others` 命令，但新用例打的是 `/api/gateway/v2/queries`。当前两条路由共用全局 `setErrorHandler`，所以行为一致；但这个测试没有锁住“命令路由仍然走同一个错误出口”这件事。
- 证据（亲自读到）：

```ts
// production-login-devices-control.ts:101
if (command.type === "login.devices.revoke_others") {
// production-login-devices-control.ts:137-138
if (remaining.length > 0)
  throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, LOGIN_DEVICES_STILL_CHANGING);

// http-gateway-server.contract.test.ts:469-472
const query = () =>
  app.inject({
    method: "POST",
    url: "/api/gateway/v2/queries",
```

- 建议：把该用例改成 `/api/gateway/v2/commands`（带 CSRF 和 idempotency-key），或额外补一条命令路由用例。若将来有人给命令路由加局部错误处理，这个缺口才会暴露。

### 2. 低：公开原因码仍走 `error.message`，与仓库已有的 `details.reasonCode` 约定不一致

- 文件：`packages/platform-node/src/http-gateway-server.ts:896`
- 问题：网关从人类可读的 `error.message` 取协议值；仓库里已有结构化通道 `ApplicationPortError.details.reasonCode`（`packages/application/src/services/agent-gateway-v2-service.ts:104-110`）。当前 `LOGIN_DEVICES_STILL_CHANGING` 是放在 message 里，所以能工作；但以后生产者如果按已有习惯把原因码放 `details.reasonCode`，白名单检查就读不到，原因码会静默丢失。`GatewayErrorReasonCode` 目前也只约束了登录设备控制层的一个常量，并不能约束所有生产者。
- 证据（亲自读到）：

```ts
// http-gateway-server.ts:893-898
sendJson(reply, statusCode, {
  error: {
    code: error.code,
    ...(isGatewayErrorReasonCode(error.message) ? { reasonCode: error.message } : {}),
  },
});

// agent-gateway-v2-service.ts:106-110
throw new ApplicationPortError(
  PORT_ERROR_CODES.NOT_AUTHORITATIVE,
  "Authenticated Gateway v2 device is not authorized",
  { reasonCode: decision.reasonCode },
);
```

- 建议：给 `ApplicationPortError` 增加一个受 `GatewayErrorReasonCode` 约束的结构化字段（或统一使用 `details.reasonCode`），网关只从该字段取公开原因码，并保留清单校验。这样生产端、网关端和测试端共用同一个类型/清单，不依赖错误文案。这是“推测”的未来风险，不是当前功能失败。

### 3. 信息：仓库里目前没有真正消费 `error.reasonCode` 的客户端

- 文件：`apps/control-center/src/gateway-client.ts:319-330`
- 问题：控制中心的 HTTP 错误解析只读 `error.code`，不读 `error.reasonCode`；Apple 客户端也没有 `login.devices.revoke_others` 的消费路径。也就是说本次新增字段在当前仓库里是“只发不用”。如果 PR 的验收标准是“手机端要能分出设备还在变”，那这个 PR 只完成了后端部分。
- 证据（亲自读到）：

```ts
// gateway-client.ts:321-327
if (!response.ok) {
  const code =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as { error?: { code?: unknown } }).error?.code
      : undefined;
  const error = new Error(typeof code === "string" ? code : "CONTROL_CENTER_REQUEST_REJECTED");
```

- 建议：明确这是第 11 批客户端工作的前置；若要本 PR 内闭环，至少加一个客户端解析 `error.reasonCode` 的用例和类型导出。否则在 PR 说明里写清“本 PR 不包含消费者”。

### 4. 信息：共享清单不是网关上所有 `reasonCode` 的全集

- 文件：`packages/platform-node/src/http-gateway-server.ts:626-628`、`:1072`
- 问题：SSE 出口仍会发 `reasonCode: "CURSOR_OUTSIDE_RETENTION"`，它不在 `GATEWAY_ERROR_REASON_CODES` 里。作者已说明 SSE 不在本批范围，所以这不是当前缺陷；但清单名字叫“GATEWAY_ERROR_REASON_CODES”，容易被后来者误当成所有网关错误原因码的完整集合。
- 证据（亲自读到）：

```ts
data: {
  code: error.code,
  ...(error.code === PORT_ERROR_CODES.NOT_FOUND
    ? { reasonCode: "CURSOR_OUTSIDE_RETENTION" }
    : {}),
},
```

- 建议：要么把清单命名收窄为只表示“JSON error body 可公开的原因码”，要么以后把 SSE 的 `CURSOR_OUTSIDE_RETENTION` 也收编进同一份清单并加校验。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本次 diff 只改了 HTTP 错误响应、登录设备控制的错误常量和对应测试，没有触及系统提示、工具定义、历史消息、遮盖或模型请求组装。新增的 `reasonCode` 只出现在客户端 HTTP 错误体里，不会进入发给模型的内容。就“本次改动”而言，不改变模型请求开头；整体提示词是否仍然只追加，本次没有逐行复核（未核实）。

2. **同一段文字会不会在不同请求里变成不同字节？**
   不会。白名单是冻结的静态数组，`isGatewayErrorReasonCode` 是精确字符串匹配，不含时间、随机数或无序集合；JSON 键顺序固定为 `code` 后 `reasonCode`，未列入清单时该字段完全不出现。唯一变量是 `error.message`，但只有精确等于静态清单值的 message 才会被使用，因此同一原因每次输出的字节相同。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有两条：
   - `packages/platform-node/test/http-gateway-server.contract.test.ts:459-496`：清单内值必须带 `reasonCode`，未列入清单的 `EMBEDDING_LOCAL_NOT_READY` 和自由文字必须不带。旧实现的正则 `/^[A-Z][A-Z0-9_]{2,63}$/` 会匹配 `EMBEDDING_LOCAL_NOT_READY`，所以反向用例在旧实现下会失败（这是按代码推断，未运行测试）。
   - `apps/agent-service/test/production-login-devices-control.unit.test.ts:175-182`：断言抛出的 message 在共享清单里；移除清单项或改变生产者值都会失败。

   缺口是第 1 条发现：没有直接覆盖命令接口和真实登录设备控制链路的端到端用例。

4. **改动产生或修改的每个值，两端都能接受吗？**
   逐个核对了：
   - 清单值定义：`packages/gateway-contracts/src/contracts-v2.ts:949`（`GATEWAY_ERROR_REASON_CODES`）。
   - 生产处：`apps/agent-service/src/production-login-devices-control.ts:32` 用 `GatewayErrorReasonCode` 类型约束常量，在 `:137-138` 抛出。
   - 传输路径：`apps/agent-service/src/production-approval-gateway.ts:243-244` 原样调用登录设备控制，`packages/application/src/services/agent-gateway-v2-service.ts:43-45` 原样返回，没有被包装成别的错误。
   - 消费处：`packages/platform-node/src/http-gateway-server.ts:896` 用同一清单的 `isGatewayErrorReasonCode` 做运行时校验。
   - 两端校验：生产处是编译期类型成员检查加单元测试；消费处是运行时精确匹配加契约测试。两端使用的是同一份清单，当前一致。
   - 现有客户端：控制中心忽略多余字段，不会因新增 `reasonCode` 报错；Apple 客户端没有该接口消费路径。没有发现会拒绝这个字段的消费者。

   结论：当前值的产生处和使用处一致；主要不足是客户端消费者尚未实现（信息级），以及公开原因码仍借用 `error.message` 而不是结构化字段（低风险设计问题）。

## 未核实

- `.agents/reviews/pr-483/round-1/` 下的判断记录：工作树中没有该目录，仓库的只读规则也拒绝通过 `git show`/`git diff` 读取 records 路径，因此无法核对作者“判断记在该目录”的说法。
- 测试是否实际通过：本次只能读代码，不能运行测试；反向用例会失败是按旧正则和当前测试断言推断的。
- 仓库外客户端（如果存在）是否会严格校验错误响应结构：未核实。
