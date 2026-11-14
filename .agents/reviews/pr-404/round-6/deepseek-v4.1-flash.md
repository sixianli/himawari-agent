## 本轮查过的范围

- 增量：`git diff 9e8b9918..388e0c40`，并逐条看了 `f299cb263`、`388e0c402` 的完整 diff。
- 合并：`git show --remerge-diff 420f38a8`，逐个核对了 17 个冲突/重命名解决处（头文件、网关分派、配置、迁移号、导出 schema、迁移测试、审计脚本等）。
- 代码：`paired-device-service.ts`、`sqlite-durable-operations.ts`、`sqlite-paired-device-operations.ts`、`device-api-routes.ts`、`strict-configuration.ts`、`device-limits.ts`、`production-http-composition.ts`、`production-approval-gateway.ts`、`service-main.ts`、`http-gateway-server.ts` 的错误处理、数据导出各文件、`check-data-export.mjs`、`migration-engine.ts`、`schema-catalog.ts`、`workspace-lifecycle-audit.mjs`、设备/启动/导出测试与 harness。
- 文档与规则：`.claude/rules/prompt-prefix.md`、设备设计文档、设备计划、`ci/operations-pending.json`。
- 未重读：main 自身带入、且与设备无关的提示词、记忆、CI 等改动；下文凡依赖这些的地方都标了「未核实」。

## 侧重检查

- **错误路径**：核对了已吊销设备重发配对（403）、流上限（429 + `streamConnections` 字段）、验签失败/设备 pending/会话失效、非限定路径、请求体上限。错误响应走统一 `PairedDeviceError` 分支，未发现状态码或响应体泄漏问题。
- **不合规范/不可信输入**：`isDeviceAccessText` 与网关合约用同一个 `accessText`；配对码、设备名、导出条目仍按严格校验；新增导出 schema 拒绝多余字段（`additionalProperties:false`）。未发现新入口绕过校验。
- **安全**：新增诊断只带 `event`、`deviceId`、`retained`；导出不含公钥、配对码哈希、随机值，且有逐文件反向断言。未发现新泄漏。
- **资源耗尽**：流上限在验签后、发送前检查并按设备计数；429 不占名额；但释放完全依赖流的 `close`，客户端断开/发送失败无自动化用例（见意见 2）。告警节流表不按吊销清理（见意见 4）。
- **不可撤销操作**：账户页吊销现在在同一个事务里吊销内部会话、删除该设备随机值、把对应 `paired_devices` 标为 revoked；其它设备按 `web_device_id` 隔离。未发现跨设备影响。
- **规则/文档一致性**：发现设计文档“设备页显示告警”未落地，以及 `streamConnections` 未写入设计文档；操作清单里设备条目的理由已过时（见意见 3–5）。

## 意见

### 1、低、同一配对码并发重开时，返回的过期时间可能来自另一个码，返回的码还可能已失效
文件：`packages/platform-node/src/paired-device-service.ts:149-162`、`packages/persistence-sqlite/src/sqlite-paired-device-operations.ts:88-110`

问题：`createPairingCode` 和 `readOpenPairingCode` 是两次独立调用；写入时先删掉该 owner/agent 下所有其它码，读取却只按 `ownerId/agentId` 取“任意一个尚未过期的码”，不按 `code_hash` 或 `session_id` 过滤。两个会话并发开配对时，A 的响应可能拿到 B 的过期时间，而 A 的码已被 B 的写入删掉。

证据：
```ts
await this.#options.store.createPairingCode({ ... });
const open = await this.#options.store.readOpenPairingCode({
  ownerId: scope.ownerId,
  agentId: scope.agentId,
  now: now.toISOString(),
});
return Object.freeze({ code, expiresAt: open?.expiresAt ?? expiresAt });
```
```sql
DELETE FROM device_pairing_codes
 WHERE expires_at <= ? OR used_at IS NOT NULL OR (owner_id = ? AND agent_id = ?)
```
性质：读取范围与写入范围不一致是读代码证实；并发交错导致的具体后果是推测。

建议：让 `createPairingCode` 返回实际写入的 `expiresAt`，或在同一个事务里按 `code_hash`（再加 `session_id`）读回；`readOpenPairingCode` 只用于页面展示。

### 2、低、流名额只在 `close` 释放，客户端断开或发送失败路径没有用例，名额可能一直占到连接寿命上限
文件：`packages/platform-node/src/device-api-routes.ts:201-220`、`485-487`、`664-666`

问题：计数在调用 `reply.send` 之前就加了，释放只挂在 `stream.once("close")`；`setStreamHeaders`/`reply.send` 抛错时没有回滚，客户端断开是否一定触发 `close` 也没有自动化用例。作者声称“客户端断开也不泄漏”，但测试只覆盖正常结束/超时（`connectionMaxSeconds:1`）和 429 拒绝。

证据：
```ts
counts.set(deviceId, open + 1);
stream.once("close", () => {
  const remaining = (counts.get(deviceId) ?? 1) - 1;
  if (remaining > 0) counts.set(deviceId, remaining);
  else counts.delete(deviceId);
});
```
```ts
holdStream(authenticated.device.id, stream, configuration.streamConnections);
options.setStreamHeaders(reply);
return reply.send(stream);
```
性质：计数逻辑与测试覆盖范围是读代码证实；“换不到 close 就泄漏”是推测。

建议：把“发送”包进 `try/catch`，失败时用幂等的释放函数扣回名额；补一个客户端强制断开后立即重开的集成用例；可同时在 `error` 事件上做一次幂等释放。

### 3、低、设计文档要求随机值存满时“设备”页显示告警，代码只写诊断日志
文件：`docs/execution/specs/2026-11-11-apple-device-body-design.md:585`、`packages/platform-node/src/paired-device-service.ts:318-328`、`apps/control-center/src/components/device-settings.tsx:9-20`

问题：设计原文是“同时记一条告警，‘设备’页显示”；388 只把告警交给 `onWarning` 写进服务诊断，设备页没有对应字段或文案。

证据：
```md
| `device.nonce.retained` | ... | 10000 个 | 拒绝这台设备的新请求，直到旧的过期；同时记一条告警，“设备”页显示 |
```
```ts
this.#options.onWarning?.({
  event: "device.nonce_store_full",
  deviceId: current.id,
  retained: configuration.limits["device.nonce.retained"],
});
```
设备页的 `DEVICE_LIMIT_KEYS` 里只有十项硬上限，没有任何告警字段。
性质：读代码证实。

建议：要么在 `device.list.snapshot`/管理列表里增加一个告警字段并在设备页显示，要么在设计和计划里明确第 1 批只记诊断日志、页面显示留到后续批次。

### 4、低、操作清单里 `device.*` 的理由已过时，仍写着缺“后端实现、测试”
文件：`ci/operations-pending.json:9-13`

问题：本轮已经补了后端和测试，只有 TypeScript 调用方还缺（或按清单说法等 iOS 第 11 批）。`check-operations` 只检查条目是否存在、理由长度等，不核对“缺什么”的文字，所以不会变红，但清单内容与代码现状不一致。

证据：
```json
"device.list.read": "...（缺：后端实现、调用方、测试）。PR 404 补后端和测试、iOS 第 11 批补调用方，三项都齐后移出名单",
"device.revoke": "...（缺：后端实现、调用方、测试）。PR 404 补后端和测试、iOS 第 11 批补调用方，三项都齐后移出名单",
```
性质：读代码证实。

建议：把这几条理由改成“只缺调用方”，避免下一位复核者按旧描述误判。

### 5、低、新增 `streamConnections` 配置键没有写进设备设计/传输说明
文件：`docs/execution/specs/2026-11-11-apple-device-body-design.md:253-259`、`573-585`、`packages/application/src/ports/device-limits.ts:121-129`、`packages/platform-node/src/strict-configuration.ts:1379-1384`

问题：设计文档的连接说明只写了心跳、最长寿命和身份核对，没有“每台设备并发事件流上限”这个行为；硬上限表也不含它。代码新增了默认 4、范围 1–64 的配置键，并会对第 N+1 条流返回 429。设计文档与实现的行为集合不一致。

证据：
```md
- **身份。** ... 连接有最长寿命（配置，默认 1 小时），到了由设备无缝重连。
```
```ts
streamConnections: optional(
  "streamConnections",
  DEVICE_CONFIGURATION_DEFAULTS.streamConnections,
  1,
  64,
),
```
性质：读代码证实。

建议：在设计文档“连接和传输”或配置表里补上这个键、默认值、范围和超限行为；如果这是第 1 批之外临时加的保护，也在计划里注明。

### 6、低、告警节流表按设备只增不减，吊销或反复配对后会留下旧条目
文件：`packages/platform-node/src/paired-device-service.ts:108-110`、`318-328`、`267-271`

问题：`#warnedAt` 只在新设备第一次写满随机值时插入；设备吊销、删除、重新配对都不会清理旧设备编号。单用户设备数有限，影响很小，但这是无上限的进程内映射，且与“吊销后清掉随机值”的清理语义不一致。

证据：
```ts
readonly #warnedAt = new Map<string, number>();
```
```ts
revoke(scope): Promise<PairedDevice> {
  return this.#options.store.revokeDevice({ ...scope, now: this.#now().toISOString() });
}
```
性质：读代码证实结构与调用路径；“长期运行后内存增长到不可接受”是推测。

建议：吊销成功时 `this.#warnedAt.delete(deviceId)`；或给映射设一个清理/上限策略。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本轮增量只改设备配对、验签、事件流、诊断、导出和迁移；没有改系统提示、工具定义、历史消息或遮盖实现。用到的 `now()` 只进入设备网关的消息编号、流消息编号和诊断时间戳，不是模型输入。发给模型的内容仍然沿用原有“只在末尾追加”的路径。合并带入的 main 提示词相关改动不在本轮范围，未重新核实。

2. **不会让同一段文字在不同请求里变成不同字节（就模型可见内容而言）。** 新导出按 `ORDER BY paired_at, id` 生成，JSON 字段顺序固定；错误/配置响应用对象字面量固定键序；`device.stream` 的消息编号含时间，但那是设备网关订阅标识，不是模型文本。诊断行会加时间戳，但诊断不进入模型请求。

3. **有自动检查，反向用例大多会真的失败。**
   - 第 23 条：账户页吊销的测试若去掉 `paired_devices` 更新，列表状态会从 `revoked` 变回 `active`，测试失败；403 单独断言不充分，因为内部会话被吊销也会 403，真正起反向作用的是状态断言。
   - 第 24 条：去掉上限检查，第二条流会 200；不释放名额，重开会 429；两项都会失败。测试覆盖正常结束/超时和 429，**没有覆盖客户端断开**。
   - 第 25 条：告警测试断言数组严格等于 `{event, deviceId, retained}`，若每次都记或带上随机值/公钥/access 会失败；但生产日志写入路径本身没有端到端断言。
   - 第 26 条：组合测试同时断言设备与 main 新增的 home/data.export/files/login 操作；迁移测试把序列改为 96；`check-data-export` 从 104 改为 107，三条新增 `[P1-6]` 用例确认存在。不是每个冲突都有专门测试，但关键冲突点有覆盖。

4. **新增/修改的值逐个核对了产生端和使用端，未发现使用端拒收。**
   - `paired_devices.status = 'revoked'`：SQL CHECK 接受；`DEVICE_STATUSES`、导出 schema、列表/验签/`stillActive` 都接受。
   - `streamConnections`：严格配置 1–64、默认 4；GET config 返回；服务端两条流都用它；Swift 端是可选的 `Int?`，缺失也兼容。
   - `DEVICE_STREAM_LIMIT` 与错误体里多出的 `streamConnections`：错误处理器按通用 `PairedDeviceError` 序列化；Swift `ErrorBody.Inner` 只取 `code` 等已知字段，未知字段被忽略。
   - `device.nonce_store_full`：`writeServiceDiagnostic` 接受 `string | number` 字段，仅有 `event/deviceId/retained`。
   - `isDeviceAccessText`：启动校验与网关合约的 `deviceAccessSchema` 使用同一规则。
   - 导出的 `pairedDevices` 清单项：manifest schema 已列为 required，导出、demo pack、导入、verify、测试全部更新；导入显式返回 0 且不写表。
   - 迁移号 96：迁移列表、schema 测试、`workspace-lifecycle-audit.mjs` 的 `SUPPORTED_SCHEMA_MAX` 都是 96；没有残留 `0094_paired_devices`。
   发现的两处不一致不是“值被拒收”，而是文档/清单文字落后于实现（意见 3–5）。
