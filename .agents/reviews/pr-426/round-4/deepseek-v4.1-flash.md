# PR 426 第 4 轮复核

说明：本次只能用 `read`/`grep`/`git show` 等只读手段，**没有运行测试**；以下“证实”均来自我亲自读到的代码。

## 一、读代码证实的问题（按严重度）

### 1. 中：`onAuditFailed` 自己抛错时，会替换命令结果或原始错误，和“结果与错误不变”不符

- 文件：`packages/platform-node/src/device-gateway.ts:166-178`
- 问题：`settle` 只捕获 `record(outcome)` 的失败，没有隔离 `onAuditFailed` 自身的异常。作者的说法是“命令结果和抛出的错误不变”，但回调一旦抛错（或返回 rejected Promise），`settle` 会 reject：
  - `failed` 路径：`await settle("failed")` 抛回调错误，后面 `throw error` 执行不到，原始执行错误被替换；
  - `completed` 路径：`await settle("completed")` 抛错，成功的 `result` 丢失。
- 证据：

```ts
166:  const settle = (outcome: "completed" | "failed") =>
167:    record(outcome).catch((error: unknown) =>
168:      input.onAuditFailed?.({ action, targetRef, outcome, error }),
169:    );
...
175:    await settle("failed");
176:    throw error;
...
178:  await settle("completed");
179:  return result;
```

- 建议：把回调本身也包起来，例如 `try { input.onAuditFailed?.(...) } catch {}`，并对异步回调 `void Promise.resolve(cb(...)).catch(() => undefined)`；审计上报失败永远不能改变命令结果/原始错误。补一条“回调抛错时结果与错误不变”的用例。

### 2. 中：配对码改为“用后可重放”，与设计文档和安全语义不一致，文档未同步

- 文件：`packages/persistence-sqlite/src/sqlite-paired-device-operations.ts:123-129`、`packages/persistence-sqlite/src/schema-catalog.ts:762`
- 问题：代码现在保留已使用的配对码，并在公钥相同的情况下返回原设备（`replayed`），重放不检查 `expiresAt`，可以一直用到主人下一次生成配对码或设备被删。设计文档仍写“只能用一次”“用掉或过期就删那一行”，验收表也仍要求“用过的配对码查不到人”。本 PR 只改了 `schema-catalog`，没有改设计文档/ADR。
- 证据：

```ts
123:      if (code.usedAt !== null) {
124:        const redeemed = code.deviceId ? this.readDevice(code.deviceId) : undefined;
125:        return redeemed &&
126:          redeemed.devicePublicKey === input.device.devicePublicKey &&
127:          redeemed.confirmPublicKey === input.device.confirmPublicKey
128:          ? { kind: "replayed", device: redeemed }
129:          : { kind: "code_used" };
```

```ts
762:    "kept after use so a retried pairing request gets the same device; removed when the Owner starts another pairing, and with Owner or Agent deletion",
```

设计文档：

```md
165: ...配对码只存哈希，用掉或过期就删那一行...
169: ...服务器生成配对码：128 位随机数，10 分钟有效，只能用一次...
705: | 设备索引的两种行... | ... | 编号唯一；过期或用过的配对码查不到人...
```

- 建议：要么把重放限制在明确窗口并写进设计/ADR，要么保持“一次性”语义；至少同步修改 `docs/execution/specs/2026-11-11-apple-device-body-design.md` 的 165/169/705 行，并说明重放只返回设备元数据、不重建设备。注意 `test/integration/device-api.test.ts` 新增用例正好把 705 行要求的“用过的查不到”反向断言掉了。

### 3. 低：数据导出新增必填 `lastSeenAt`，但格式版本仍是 v2，旧导出文件会校验失败

- 文件：`packages/persistence-sqlite/src/data-export/schemas.ts:3,49-58,163`、`packages/persistence-sqlite/src/data-export/verify.ts:290-295,318-326`
- 问题：`objectOf(..., [], ...)` 把未列入 `optional` 的属性全部放进 `required`。新增的 `lastSeenAt` 是必填；而基准提交 `ccd11aa` 的同一 v2 schema 没有这个字段，旧的 `data/paired-devices.jsonl` 行会缺字段。`FORMAT_VERSION` 未升版本，`parseLines` 会用新 schema 逐行校验，因此旧版本生成的 v2 导出会在校验/导入时失败。
- 证据：

```ts
49: const objectOf = (
50:   properties: ...,
51:   optional: ... = [],
...
57:   required: Object.keys(properties).filter((key) => !optional.includes(key)),
58:   additionalProperties: false,
```

```ts
163:    lastSeenAt: nullable(timestamp),
```

```ts
290:    const problem = validateAgainst(schema, value);
291:    if (problem !== null)
292:      throw new DataExportError(..., `${path}:${index + 1} ${problem}`);
```

`git show ccd11aa:.../schemas.ts` 证实基准版本的 `PAIRED_DEVICE_SCHEMA` 没有 `lastSeenAt`。如果这个设备导出只存在于未发布分支，影响较小；一旦用户拿到过旧导出，这是兼容性回归。
- 建议：把 `lastSeenAt` 放进 `optional`，或升级 `FORMAT_VERSION` 并在导入时按版本兼容旧文件；补一条“旧 v2 导出（无 `lastSeenAt`）仍能校验/导入”的反向用例。

### 4. 低：`payloads/text` 的 4 MB 预算没有把键名和 `deferred` 自身算进去，且第一条永不检查

- 文件：`packages/platform-node/src/device-api-routes.ts:538-550`
- 问题：预算只累计 `JSON.stringify(item)` 的字节，没算 `payloadRef` 键、逗号以及 `deferred` 数组；判断条件 `responseBytes > 0 && ...` 使第一条无论多大都会放进去。因此响应仍可能超过 `DEVICE_PAYLOAD_TEXT_RESPONSE_BYTES`，与“4 MB 一响应”的意图不完全一致。`deferred` 字段也没有设计文档或客户端消费方记录。
- 证据：

```ts
538:            const bytes = Buffer.byteLength(JSON.stringify(item), "utf8");
539:            if (responseBytes > 0 && responseBytes + bytes > DEVICE_PAYLOAD_TEXT_RESPONSE_BYTES) {
540:              deferred.push(payloadRef);
541:              continue;
542:            }
543:            responseBytes += bytes;
...
550:        return options.sendJson(reply, 200, { items, deferred });
```

- 建议：至少把引用键和固定开销计入预算；第一条也按同一上限判断（或确认单条已有独立上限）；在设计/客户端清单中补上 `deferred` 语义和重试方式。

### 5. 低：新回调的反向路径与生产接线没有自动检查

- 文件：`packages/platform-node/test/device-gateway.unit.test.ts:98-120`
- 问题：用例确实覆盖了 completed/failed 两条回调内容，若退回 `.catch(() => undefined)` 会失败；但没有用例覆盖“回调自己抛错”，也没有用例验证 `production-http-composition` → `service-main` 真的会写出 `device.audit_failed`（`grep` 只在生产源码里出现该事件名，没有任何测试引用）。
- 证据：`grep` 结果中 `device.audit_failed` 只出现在 `apps/agent-service/src/service-main.ts:2775`；测试文件只 mock 了网关层的回调。
- 建议：加一条回调抛错的网关单测，以及在 `production-http-composition`/服务启动层捕获诊断输出、断言字段（`action`、`targetRef`、`outcome`、`code`）的用例。

## 二、推测（未证实）

- `preParsing` 用 `payload.pipe(new Transform(...))`，超限时只让 Transform 报错，没有显式 `destroy` 上游请求流（`device-api-routes.ts:268-284`）。Fastify 通常会在错误后销毁请求，但是否所有路径都及时停止读取，我没有验证；若未销毁，chunked 大包可能继续占用连接/内存。建议超限时同时销毁上游或使用 `pipeline`。
- `createPairingCode` 的删除语句 `DELETE ... WHERE expires_at <= ? OR used_at IS NOT NULL OR (owner_id = ? AND agent_id = ?)`（`sqlite-paired-device-operations.ts:89-92`）会删掉所有 owner/agent 的已用码，而不只是当前 owner 的；目前单人库里影响不大，接 ADR 0234 多人共库时需要再核对。
- 重放路径不检查 `expires_at`，也不按 `device.status` 区分；设计上如果希望“已吊销设备重放仍返回已吊销”，当前行为可能可接受，但没有文档说明。

## 三、侧重检查（错误路径、不可信输入、安全、资源、文档一致性）

- 审计写入失败：`completed`/`failed` 均会回调；`accepted` 写失败仍直接中断请求（改动前行为）；**回调自身失败未被隔离**（见问题 1）。
- 配对重放：输入走既有 `canonicalSpki` 校验、要求两把公钥不同且完全匹配；不匹配返回 `code_used`；已用码在数据库里保留（见问题 2）。未发现重放能拿到 `webSessionId`/`authenticationRef` 的路径（`presentDevice` 不导出这些字段）。
- 请求体上限：`onRequest` 先看 `content-length`，新增 `preParsing` 对 chunked 流计数并在超限时走 `rejectBody(413)`；`rejectBody` 对 413 抛 `PairedDeviceError("DEVICE_BODY_TOO_LARGE")`，错误处理器可正确返回。上游流清理见“推测”。
- 文本批次：`refs` 有数量、去重、机器字符串校验；缺失项返回 `null`；超预算进入 `deferred`。预算精度见问题 4。
- 导出/导入：`lastSeenAt` 从快照查询到导出、schema、`ParsedPairedDevice` 全链路存在；配对设备本来就不在导入时恢复，但校验仍会读整行，旧 v2 文件兼容性见问题 3。
- 错误处理器：`PairedDeviceError` 现在会把 `details` 展开进 `error` 对象，`DeviceGatewayError` 保持只回 `code`；`details` 默认 `{}`，现有构造点无需改动。未发现误改其他错误类型。
- 文档一致性：`schema-catalog` 已更新；设计文档的“一次性配对码/用后删除”仍未更新（见问题 2）。`deferred` 响应字段在设计文档的接口表里没有出现。

## 四、必答问题

1. **不会改变模型已见过的请求开头。** 本增量没有触碰系统提示、工具定义、历史消息或遮盖逻辑（没有 `prompt-catalog`、`runtime-pi`、请求组装相关改动）。设备网关只是把 `forward(input)` 的原结果返回；新增的审计诊断写的是服务日志，不进模型请求。因此发给模型的内容仍然只在末尾追加，每轮变化的值没有挪到开头。依据 [.claude/rules/prompt-prefix.md](../../.claude/rules/prompt-prefix.md#rules) 的要求，本次改动未涉及该规则约束的对象。

2. **不会让同一段文字在不同请求里变成不同字节。** 新增的随机 id（`randomUUID`）、`occurredAt`/诊断时间戳只出现在审计和日志里，不进入模型输入；`targetRef` 由设备 id、gateway、type 组成，稳定。`deferred` 的分区对同一输入和同一内容确定。没有发现依赖后文遮盖、时间字段或无序遍历进入模型内容的路径。

3. **有自动检查，但覆盖不完整。** 网关单测覆盖了 `completed`/`failed` 两条回调内容，把实现退回静默吞掉会失败；配对重放、chunked 体积上限、`deferred`、过期配对码错误体也都有用例。缺口是：没有“回调抛错不改变结果”的反向用例，也没有生产接线（`service-main` 的 `device.audit_failed`）的自动检查；旧 v2 导出兼容性也没有反向用例。

4. **逐个核对改动产生的值：**
   - `replayed`：`sqlite-paired-device-operations.ts` 产生 → `paired-device-service.ts` 的 `switch` 已加分支 → `device-api-routes.ts` 用于决定 200/201；没有其他 `PairingRedeemResult` 实现或 `.pair()` 调用方需要改。
   - `PairedDeviceError.details`/`pairingCodeTtlSeconds`：仅 `pairing-code-expired` 构造时传入，默认 `{}` 兼容其他调用；`http-gateway-server.ts` 的 `PairedDeviceError` 分支展开 `details`，测试已更新。
   - `onAuditFailed`/`DeviceGatewayAuditFailure`：`device-gateway` → `device-api-routes` → `http-gateway-server` 的 `devices` → `production-http-composition` → `service-main` 命名一致；`service-main` 把 `action/targetRef/outcome/code` 交给 `writeServiceDiagnostic`，类型都是字符串，可接受。
   - `lastSeenAt`：`snapshot.ts` 查询列 → `export.ts` 输出 → `schemas.ts` 校验 → `verify.ts` 的 `ParsedPairedDevice`；`PairedDevice` 端口本身已有该字段。**兼容性问题见问题 3**（新增为必填但未升格式版本）。
   - `DEVICE_PAYLOAD_TEXT_RESPONSE_BYTES`：在 `device-api-routes.ts` 定义并通过 `index.ts` 的 `export *` 暴露，路由和集成测试都引用同一常量，值一致。
   - `deferred`：只在 `payloads/text` 路由产生，当前只有新集成测试消费；生成客户端/设计文档没有对应字段（见问题 4）。
   - `device.audit_failed` 的字段名/取值：生产日志消费方是 `writeServiceDiagnostic`，接受字符串；没有其他地方校验该事件名。未发现两端不一致，但缺少测试保护。
