## 侧重检查

我按“错误路径、不可信输入、安全、资源耗尽、不可撤销操作、规则文档与代码一致性”优先看了这些路径：

- **错误路径**：坏 cursor 在 `production-files-control.ts:61-68` 只把 `PORT_INVALID_OPERATION` 转成 `ContractValidationError`，HTTP 层在 `http-gateway-server.ts:879-881` 转成 400；`login.device.revoke` 的找不到/冲突/最近认证失败分别走 404/409/403（`http-gateway-server.ts:883-892`、`production-login-devices-control.ts:99-110`）。
- **不可信输入**：文件 `name`/`mediaType` 和登录设备 `label` 都做了控制字符替换与长度截断（`production-files-control.ts:19-26`、`production-login-devices-control.ts:29-36`）；cursor 有 512 字符与字符集限制（`contracts-v2.ts:744-750`）；`deviceId`、`recentAuthenticationRef` 用 `machineString`（`contracts-v2.ts:801-807`）。
- **安全**：文件和登录控制都核对登录主人、scope 主人和 agent（`production-files-control.ts:43-49`、`production-login-devices-control.ts:45-61`）；撤销禁止当前设备并要求最近认证（`production-login-devices-control.ts:99-109`）；查询上下文从 `AgentGatewayV2Service` 一路转发（`agent-gateway-v2-service.ts:45`、`autonomy-gateway-adapter.ts:356-357`、`governance-gateway-adapter.ts:211`、`host-workspace-gateway-adapter.ts:626-627`）。
- **资源耗尽**：文件列表每页最多 100（`contracts-v2.ts:757`），登录设备列表没有上限（`contracts-v2.ts:789-799`，作者说明这是沿用网页行为）；记忆引用链最多 8 个节点（`production-memory-control.ts:546`），但每条规则最多会多读 8 次记忆。
- **不可撤销操作**：`login.device.revoke` 会撤销设备及其会话（`sqlite-durable-operations.ts:5012-5041`），有最近认证和“不能撤销当前设备”两道限制；已撤销设备的重发是幂等的，不改变状态。
- **规则/文档一致性**：网页撤销确实允许当前设备，且网页按钮在当前设备被撤销后会登出（`built-in-identity-routes.ts:162-176`、`account-login.tsx:250-256`），与作者说明一致；网页设备列表和文件列表也确实不分页/同一份存储，与说明一致。

---

## 发现（按严重度从高到低）

### 低：已撤销设备的重放路径绕过了“最近验证身份”，并且会对外返回成功

**读代码证实。**

`apps/agent-service/src/production-login-devices-control.ts:101-109`：

```ts
if (device.status === "revoked") return { resultRef: device.id, replayed: true };
await this.#options.recentAuthentication.assertRecentAuthentication({
  authentication,
  expectedAuthenticationRef: command.payload.recentAuthenticationRef,
});
```

只要目标设备已经撤销，控制层在检查 `recentAuthenticationRef` 之前就直接返回 `replayed: true`。因此：

- 一个有效但**没有最近验证**的会话，对已撤销设备发撤销命令会得到 200；
- 这与作者说明“退出别的设备要最近验证过身份”在重放路径上不一致；
- 还不能区分“同一个幂等请求的重发”和“另一个请求刚好指向已撤销设备”，因为控制层没有看 idempotency key 或回执。

测试也固化了这个行为：`apps/agent-service/test/production-http-composition.unit.test.ts:1318-1320` 用 `null` 的 `recentAuthenticationRef` 重发并期待 200/`replayed: true`。

**建议**：至少把最近认证检查放到“已撤销”短路之前；更严谨的做法是像治理命令那样把重放绑定到同一 idempotency key 的完成回执，而不是仅凭设备当前状态判断 `replayed`。如果不是安全边界，也应在说明里明确“重放不要求最近认证”。

### 低：设备标签和文件名的清理只处理了 `Cc`，没有处理双向控制符/零宽格式字符

**读代码证实。**

`apps/agent-service/src/production-login-devices-control.ts:29-35`：

```ts
for (const character of value.replace(/\p{Cc}/gu, " ").trim()) {
```

`apps/agent-service/src/production-files-control.ts:19-26`：

```ts
for (const character of value.replace(/\p{Cc}/gu, "\uFFFD")) {
```

`\p{Cc}` 只覆盖 C0/C1 控制字符，不覆盖 `\p{Cf}`（例如 U+202A–U+202E 双向控制、U+200B 零宽空格、U+2066–U+2069 等）。设备标签的来源是登录时客户端提交的 `deviceLabel`，只做了 128 字符切片（`packages/platform-node/src/identity-gateway.ts:611`），因此设备列表中可以出现视觉上伪装成另一台设备、或完全不可见的标签。文件名同理，可能被用来伪装扩展名/文件类型。iOS 设备管理页正是让用户选择要撤销的设备，伪装标签会增加误撤销风险。

**建议**：清理时同时去掉/替换 `\p{Cf}` 和双向控制符；如果清理后只剩零宽或空白，回退到 `?`/`U+FFFD`，并补一条“只有双向控制符的标签/文件名”的反向用例。

### 低：登录设备列表无上限，属于有意的资源风险

**读代码证实，且作者说明这是有意沿用网页行为。**

`packages/gateway-contracts/src/contracts-v2.ts:789-799` 的 `devices` 数组没有长度上限，控制层直接返回 `listDevices(ownerId, false)` 的全部设备（`production-login-devices-control.ts:68-72`）。设备数量如果随登录次数增长，设置页每次刷新都会返回全量列表。作者已说明“设备列表不分页（网页同样不分页）”，因此这不是本次改动引入的偏差，但建议在协议里预留一个上限，或在文档里记录预期设备数量很小。

### 低：文件控制的 agent-scope 分支缺少直接测试

**读代码证实。**

`production-files-control.unit.test.ts` 只测了文件名/媒体类型截断；`sqlite-thread-artifacts.test.ts` 覆盖了主人不匹配、未登录、坏 cursor，但没有覆盖 `query.scope.agentId !== agentId` 的分支（`production-files-control.ts:47`）。HTTP composition 测试也只使用正确 agent。这个分支目前看起来实现正确，只是反向用例不完整。

### 推测/未核实

- `quoteLatestMemoryId` 使用 `machineString`（最大 128 字符）。记忆 id 目前多数由 `createMemoryId` 校验到 128 字符，但 `production-memory-control.ts:1083` 的 `memory:owner:${idempotencyKey}` 用了强制类型转换，`idempotencyKey` 本身最多 128 字符，拼上前缀后理论上可超过 128。若这种 id 恰好成为“最新记忆”，整份 `memory.rules.snapshot` 可能在客户端解析失败。这不是本次改动独有的问题（现有 `memory.overview` 也把 `memoryId` 声明为 `machineString`），但建议确认实际 id 生成是否保证不超过 128。
- 治理层上下文转发没有单独的 `governance` 单元测试；不过 HTTP composition 集成测试实际走通了 `files.list.read`/`login.devices.read`，属于间接覆盖。
- 受工具限制，我没有运行测试；下面关于测试的判断来自读代码。

---

## 必答问题

### 1. 改动会不会改变模型已经见过的请求开头？

**不会。** 这次 diff 没有改 `packages/prompt-catalog`、运行时请求组装、历史写入、出口遮盖、工具定义或系统提示相关代码；新增的只有网关契约、控制层、查询上下文和测试。`memory.rules.snapshot` 的新字段由控制中心读取（`apps/control-center/src/memory.ts:116-119`），不是模型请求输入。`AgentGatewayV2Service` 只是把已有 `authentication` 作为查询上下文传下去（`agent-gateway-v2-service.ts:45`），没有改消息顺序或内容。

对照规则 [`prompt-prefix.md:27-35`](.claude/rules/prompt-prefix.md#rules)：模型内容仍然只在末尾追加；这次没有把任何每轮变化的值放进系统提示、工具定义或历史。`generatedAt`、`current` 这些会变的值只出现在网关快照响应里（`production-files-control.ts:92`、`production-login-devices-control.ts:86`），没有进入模型请求。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**对模型侧不会；对网关快照会有意随数据/时间变化。**

- 文件列表顺序由 SQL 固定为 `created_at DESC, id DESC`（`sqlite-thread-artifact-operations.ts:272-283`），控制层原样保留；
- 设备列表按 `lastSeenAt` 降序、同值按 `id` 升序固定排序（`production-login-devices-control.ts:68-72`）；
- 文件名/媒体类型/设备标签的替换和截断是确定函数（`production-files-control.ts:19-26`、`production-login-devices-control.ts:29-36`）；
- `memory.rules` 的引用字段只由当前记忆状态决定，没有依赖请求顺序或无序集合；
- `generatedAt`、设备列表的 `current` 会随请求时间和当前会话变化，但它们是网关响应字段，不是模型内容；作者说明的目标也不是让快照逐字节固定。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有对应检查，但受工具限制我**没有执行测试**，下面是代码层面的核对：

- 契约反向用例：`packages/gateway-contracts/test/files-list-gateway.contract.test.ts` 覆盖未知 kind/origin、零/超上限 limit、带 padding/空/超长 cursor、文件名控制字符、负数大小、额外字段；`login-devices-gateway.contract.test.ts` 覆盖标签控制字符/超长、坏时间戳、缺 `current`、额外字段、设备 id 带空格、缺 `recentAuthenticationRef`。
- 控制层反向用例：`apps/agent-service/test/production-login-devices-control.unit.test.ts` 覆盖 agent 不匹配、未登录、当前设备、标签截断；`production-http-composition.unit.test.ts` 覆盖 401、坏 cursor 400、撤销当前设备 409、无最近认证非 200、已撤销重放 200、缺失设备 404、排序/current。
- 记忆引用：`test/integration/production-memory-capture.test.ts` 覆盖未取代、已取代、最新归档、循环链、超过 8 步、跨 agent、源归档等状态，并用 `gatewayV2MessageSchema.parse` 校验快照。
- 文件列表：`test/integration/sqlite-thread-artifacts.test.ts` 覆盖分页、类型/来源过滤、网页列表同序、坏 cursor、主人/agent 校验，并断言 `FILE_LIST_KINDS`/`ORIGINS` 与存储层常量一致、页大小不超过存储上限。

这些用例的断言是具体的 `toThrow`/`toEqual`/`toMatchObject`，去掉字段或放宽校验时逻辑上会失败。覆盖缺口是：文件控制层 agent 不匹配分支没有直接用例；设备空标签回退 `?`；重放路径与“最近认证”的关系没有被作为安全用例单独验证。

### 4. 每个产生/修改的值，使用它的地方都能接受吗？

按改动值逐个核对：

- **`files.list.read` / `files.list.snapshot`**
  - 产生：`production-files-control.ts:75-90`。
  - 契约：类型列表 `contracts-v2.ts:143-144`，schema `contracts-v2.ts:751-780`，映射表 `contracts-v2.ts:2810-2811`。
  - `fileId` 来自 `thread-artifact:<uuid>`（`service-main.ts:246`、`production-thread-artifacts.ts:334`），符合 `machineString`；`threadId` 也是同一类生成 id；`kind`/`origin` 与 `THREAD_ARTIFACT_KINDS`/`ORIGINS` 一致（集成测试断言）；`name`/`mediaType` 被截到 256/128 并去控制字符；`contentPath` 前缀与 HTTP 路由正则一致（`http-gateway-server.ts:271`），长度远低于 512；`nextCursor` 来自存储层 base64url，符合 cursor 正则。
  - 消费方：目前没有 TypeScript 前端调用方，`ci/operations-pending.json` 已登记“缺调用方”，与 `check:operations` 的扫描范围一致；集成测试会用契约解析快照。
  - 结论：两端校验一致。

- **`login.devices.read` / `login.devices.snapshot` / `login.device.revoke`**
  - 产生：`production-login-devices-control.ts:79-87`、`:94-111`。
  - 契约：类型列表 `contracts-v2.ts:145-147`，schema `contracts-v2.ts:782-807`，映射表 `contracts-v2.ts:2812-2814`。
  - `deviceId` 由 `device:<random hex>` 生成（`identity-gateway.ts:593`），符合 `machineString`；`label` 截到 80 且替换控制字符；时间字段来自 `toISOString()`；`recentAuthenticationRef` 的实际格式是 `sha256:<64 hex>`（`identity-gateway.ts:100-102`、`built-in-identity.ts:29-31`），长度和字符集符合 `machineString`。
  - 消费方：iOS 调用方尚未合入，`ci/operations-pending.json` 已登记；HTTP 集成测试已经用契约解析响应。
  - 结论：两端校验一致，除上面“重放绕过最近认证”的语义问题。

- **`quoteSuperseded` / `quoteLatestMemoryId`**
  - 产生：`production-memory-control.ts:503-554`、`:601`。
  - 契约：`contracts-v2.ts:1792-1793`。
  - 消费方：控制中心的 `OwnerRule` 类型直接从契约快照推导（`apps/control-center/src/memory.ts:24-27`），测试工厂和 gateway fixture 已补字段；目前网页 UI 还没有读取这两个新字段，因此没有“生产值不符合消费方校验”的问题。
  - `quoteLatestMemoryId` 使用 `machineString`，与现有其他 `memoryId` 字段一致；但见“推测/未核实”里关于超长 `memory:owner:<idempotencyKey>` 的提醒。

- **`GatewayV2QueryContext`**
  - 定义：`packages/application/src/ports/gateway.ts:103-108`。
  - 传递：`agent-gateway-v2-service.ts:45` 传入；`autonomy-gateway-adapter.ts:356-357`、`governance-gateway-adapter.ts:211`、`host-workspace-gateway-adapter.ts:626-627` 原样转发；生产组合的分发器在 `production-approval-gateway.ts:123-149` 把上下文交给登录/文件控制。
  - 消费方都能接受；可选参数不会让现有实现编译失败，缺少上下文时文件和登录控制会以 `NOT_AUTHORITATIVE` 失败关闭。
