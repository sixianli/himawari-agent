## 本轮核查范围

只针对 `67baca78062bc4a00ae15d80759492af4a14ede0..a75d608cb8566e987cd60e321794dd077682cfbe` 的增量：`packages/application/src/services/device-action-service.ts` 和 `test/integration/device-actions.test.ts`（其余是复核记录/usage 文件）。跟到了 `sqlite-device-action-operations.ts`、`device-api-routes.ts`、`production-device-action-authorization.ts`、`owner-scope-authorization.ts`、`identifiers.ts`、`device-api-harness.ts` 和相关文档；旧代码未整份重读。

## 上一轮意见核对：已改好

上一轮「未确认的撤销会占住 `undo:<id>`，之后带确认密钥也无法再撤销同一动作」在顺序路径上已修复。

- `undoToolCallId` 现在按 `ownerPresent` 分成两套键（`device-action-service.ts:177-178`）。
- `#undoState` 明确把 plain 的 `rejected` 当成「不存在」，从而继续显示 `available`（`device-action-service.ts:849-860`）。
- `#undoKey` 在 owner 记录不存在、plain 记录为 `rejected` 时返回 `undo:<id>:owner`（`device-action-service.ts:863-874`）。
- 复现路径：未确认撤销因 run 读过外来内容被拒 → plain 记录 `rejected`；随后确认撤销走 `undo:<id>:owner`，`ownerInitiated: true` 把 `readUntrustedContent` 置为 `false`，不再重放那条 rejected 记录（`device-action-service.ts:425-428、886-893`）。

实际测试未运行（受工具限制），只按代码路径核对；下方「必答问题 3」说明未核实部分。

## 侧重检查

- **路由输入与身份**：`actions/undo` 只接受 `id`，要求 `DEVICE_ACTION_ID_PATTERN`，整条路由是签名路由；`ownerPresent` 来自 `authenticated.confirmed`，只有同时带设备签名和确认密钥签名、且 nonce 一致时才为 true（`device-api-routes.ts:873-891`、`device-request-signature.ts:288-302`）。未发现无确认签名可冒充主人的路径。
- **不可信 evidence**：反向参数只来自 registry 的 `undo` 函数和 `evidence.before`，随后通过 `validateDeviceActionArguments`；未知字段、超长/格式错误、非法事件 id 都会被拒；`calendar.delete` 的单次发生删除明确不撤（`device-action-registry.ts:226-268、502/529/565/603`，`device-action-service.ts:827-839`）。
- **安全/不可撤销操作**：反向动作仍走原来的 `request`，重新检查 device 是否支持、policy 是否 block、统一授权/审批；`ownerInitiated` 只绕过 `readUntrustedContent` 这一道 deny，`ownerScope.authorize` 仍会从 run 的外部内容标记生成 `contextExternalContent` 事实（`production-device-action-authorization.ts:56-60`、`owner-scope-authorization.ts:177-180、254-263`）。作者「统一审批仍按那一轮的外来内容标记询问」这一句与生产代码一致。
- **资源耗尽**：同一套键的重试会重放同一条记录，不会无限新增；plain 被拒后确认路径最多再产生一条 owner 记录。并发场景见意见 2。
- **文档一致性**：`docs/execution/specs/2026-11-11-apple-device-body-design.md:222` 写了 `actions/undo` 需要确认密钥才算主人亲自点，与代码一致；文档没有承诺两套键或具体状态值，不需要随本次增量改。作者说法中的固定 `undo:<id>` 已过时，见意见 5。
- **模型请求开头**：本次没有触碰提示词、工具定义、历史或遮盖；`views()` 只被设备 API 路由使用（`device-api-routes.ts:833-839`），不会进入模型请求。

## 意见

### 1. 低：确认撤销的 idempotency key 在合法长 runId 下可能超过 128 字符而抛错

文件：`packages/application/src/services/device-action-service.ts:547`、`packages/domain/src/identifiers.ts:39-50`、`packages/gateway-contracts/src/validation.ts:49-59`

问题：`#risk` 用 `${runId}:${toolCallId}` 生成 `IdempotencyKey`，而 `createIdentifier` 只接受最多 128 字符。增量把确认撤销的 toolCallId 从 `undo:<37字符>`（43）加长到 `undo:<37字符>:owner`（49，含分隔冒号后总拼接为 runId 长度 +49）。网关契约允许 `runId` 长达 128（`machineString`），因此 runId 长度 79–84 的合法输入原本可以完成撤销，现在确认撤销会在 `createIdempotencyKey` 处抛 `DomainError`，表现为 500，而不是可控的 4xx。生产自生成 runId 目前是 `run:<32 hex>`，只有 36 字符，所以实际触发取决于是否有外部网关/导入路径提供更长的 runId；这一点未核实。

证据：

```ts
idempotencyKey: createIdempotencyKey(`${input.runId}:${input.toolCallId}`),
```
```ts
const MACHINE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
```
```ts
input.length > MACHINE_STRING_MAX_LENGTH ||
! /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(input)
```

建议：不要直接拼接原始 runId 和 toolCallId；像其他流程一样用 digest 缩短，或在撤销入口显式限制 runId 长度并返回 4xx；补一条接近最大长度的 runId 反向用例。这是 I-73 类型的「产生端加长、使用端有长度上限」问题。

### 2. 低（推测）：并发的一个未确认 + 一个已确认撤销，可能在两套键下各插入一条反向动作

文件：`packages/application/src/services/device-action-service.ts:863-874、886-893`、`packages/persistence-sqlite/src/sqlite-device-action-operations.ts:135-145`

问题：`#undoKey` 的读取和 `request` 的插入不是同一个原子操作。并发时，未确认请求可能选中 `undo:<id>`，确认请求选中 `undo:<id>:owner`。如果前者在后者执行 `insert` 前已经完成（进入 `succeeded`），`open_duplicate` 只查 `OPEN_STATES`，不再命中，后者会再插入一条反向动作。撤销 `calendar.delete` 时，反向动作是 `calendar.create`，可能生成两个重复日程。此为并发推测，未复现；顺序调用不会出现，因为 `#undoKey` 会复用已存在的非 rejected 记录。

证据：

```ts
if (await read(true)) return undoToolCallId(record.id, true);
const plain = await read(false);
if (plain && plain.state !== "rejected") return undoToolCallId(record.id, false);
return undoToolCallId(record.id, ownerPresent);
```
```sql
AND state IN ('waiting_owner', 'queued', 'delivered', 'result_unknown')
```

建议：为「原动作只能有一个撤销槽」做原子约束，例如在存储层同时检查两套键（包括已 `succeeded` 的记录），或引入一个不新增表的确定性撤销槽键；补并发测试（两个请求同时进入 `undo`）。

### 3. 低：授权拒绝的反向动作实际返回 200 + `state:"rejected"`，不是作者说的「409 撤不了」

文件：`packages/platform-node/src/device-api-routes.ts:884-890`、`packages/application/src/services/device-action-service.ts:335-348、464-470`

问题：`request` 对授权 deny、policy block、device unsupported 都会插入一条 `state: "rejected"` 的记录并返回 `kind:"recorded"`；`#outcome` 永远返回 `kind:"recorded"`，所以路由的 409 分支只在 `invalid`/`not_undoable` 时命中。作者说「404 不是这台设备的动作，409 撤不了，成功返回 `{id,state}`」不完整：反动作被授权拒绝时客户端会收到 200 `{id,state:"rejected"}`，如果客户端只看 HTTP 状态，可能把失败显示成成功。

证据：

```ts
if (outcome.kind === "not_found" || outcome.kind === "not_undoable")
  return options.sendJson(reply, outcome.kind === "not_found" ? 404 : 409, ...);
if (outcome.kind !== "recorded")
  return options.sendJson(reply, 409, { code: "DEVICE_ACTION_NOT_UNDOABLE" });
return options.sendJson(reply, 200, { id: outcome.actionId, state: outcome.state });
```

建议：要么把 `rejected` 视为 409，要么在 API 文档/PR 说明中明确「200 只表示撤销请求被记录，必须检查 state」；补一条授权拒绝的反向用例。

### 4. 低：`views()` 把所有 plain `rejected` 都当成可重试，策略永久拒绝时也会报 `available`

文件：`packages/application/src/services/device-action-service.ts:849-860`

问题：新逻辑对 plain 的 `rejected` 不再区分拒绝原因。若某次未确认撤销是因为反向动作被 device policy block 或设备不支持而拒绝，`#undoState` 仍会走 `#undoPlan` 并返回 `available`；但 `#undoPlan` 只看 action/evidence，不检查 policy 或设备支持。主人确认后 `request` 仍会拒绝，并留下第二条 owner rejected 记录，之后才显示 `failed`。这与「API 要说明哪些动作能撤」的目标不完全一致。

证据：

```ts
const reverse = ownerReverse ?? (plainReverse?.state === "rejected" ? null : plainReverse);
...
return (await this.#undoPlan(record)) ? "available" : "none";
```

建议：在 `#undoState` 里区分可恢复拒绝（例如 untrusted-content/owner-presence）与永久拒绝（policy/unsupported），或在 `#undoPlan` 之后同样检查 `readPolicy` 和 `supportedBy`；补 policy block 场景的 views 断言。

### 5. 低：作者仍称撤销使用固定 `undo:<原动作号>`，增量后已变成两套键；`undo` 签名也漏了 `ownerPresent`

文件：`packages/application/src/services/device-action-service.ts:177-178、876-880`

问题：作者说法 #2 的「用固定的 toolCallId `undo:<原动作号>`，所以重放返回同一个结果、同一动作只能撤一次」在本次增量后已不准确：代码现在有 `undo:<id>` 和 `undo:<id>:owner` 两套键，单次保证由 `#undoKey` 的优先级承担，而不是单一键。作者说法 #2 的 `undo({device, actionId})` 也漏了实际必需的 `ownerPresent`。这是说明与代码不一致，不是直接运行错误。

证据：

```ts
const undoToolCallId = (actionId: string, ownerPresent: boolean) =>
  ownerPresent ? `undo:${actionId}:owner` : `undo:${actionId}`;
```
```ts
async undo(input: {
  readonly device: PairedDevice;
  readonly actionId: string;
  readonly ownerPresent: boolean;
}): Promise<DeviceActionUndoOutcome> {
```

建议：更新 PR 说明/注释，写清两套键及 `#undoKey` 的优先级，避免后续维护者按「单键幂等」理解而改坏。

### 6. 低：新增回归用例没有断言未确认调用确实被拒

文件：`test/integration/device-actions.test.ts:1299-1302`

问题：用例直接发一次未确认撤销、再发确认撤销，但没有断言第一次返回 `state:"rejected"`。如果以后 `externalContent.mark` 或 authorization 接线变化，让第一次变成 `queued`/`waiting_owner`，确认请求会重放那条非 rejected 的 plain 记录，测试仍然通过，却不再覆盖本轮修复的回归条件。按当前代码路径，第一次确实会被拒，旧实现下确认会重放 rejected，因此该用例现在能抓住旧实现；但前置条件没有显式锁住。

证据：

```ts
await confirmablePost(h, client, "actions/undo", { id }, false);
const confirmed = await confirmablePost(h, client, "actions/undo", { id }, true);
expect(confirmed.body).not.toMatchObject({ state: "rejected" });
expect(confirmed.status).toBe(200);
```

建议：断言未确认调用的结果（至少 `expect(unconfirmed.body).toMatchObject({ state: "rejected" })`），并可进一步断言确认请求产生的是 waiting_owner/queued 而不是重放旧记录。

## 必答问题

1. **是否改变模型已经见过的请求开头？** 不涉及。增量只改设备动作的撤销键和 `views()` 的 `undo` 字段；没有改系统提示、工具定义、历史消息或出口遮盖。`views()` 在仓库内只被 `device-api-routes.ts:833-839` 使用，不进入模型请求；发给模型的内容仍然只在末尾追加，每轮变化的值仍只在最后一条消息里。依据规则 4（只追加）与规则 10（字节确定）。
2. **同一段文字会不会在不同请求里变成不同字节？** 不涉及模型文本。增量没有新增会进入模型请求的时间字段、无序集合或依赖前后文的遮盖；`ownerPresent` 只让设备动作标识分成 `undo:<id>` / `undo:<id>:owner`，这是设备动作的内部键，不是发给模型的文字。`undo` 状态字段只在设备 API 视图中，不进模型。
3. **有没有自动检查，反向用例真的会失败吗？** 有：`test/integration/device-actions.test.ts:1270-1304`。按代码路径推断，旧实现下确认请求会重放 plain 的 `rejected` 记录并返回 200 `{state:"rejected"}`，`expect(...).not.toMatchObject({state:"rejected"})` 会失败；所以该用例能抓住上一轮问题。未实际运行测试（工具限制，作者称 33 passed 未核实）。用例缺少「未确认调用确实被拒」的前置断言，见意见 6。
4. **每个产生/修改的值的直接使用端都能接受吗？** 逐个核查结果：
   - `undoToolCallId` 产生的 `undo:<id>:owner`：`readInvocation` 用完整字符串精确查询，SQLite `tool_call_id` 是 TEXT，无额外格式限制；`request` 的 `createIdempotencyKey` 接受冒号等允许字符，但存在长度上限，见意见 1；`DeviceActionIntent.toolCallId` 进入 `ownerScope.authorize` 后只被 digest，无格式拒绝。
   - `#undoState` 的 `none/available/pending/done/failed`：仓库内使用者只有设备路由的 JSON 响应和测试；没有发现 `DeviceActionUndoState` 的 schema 校验。外部 iOS 客户端是否接受这些值未核实（仓库里没有对应设备客户端实现）。
   - 路由/接口的 `{id,state}`、404/409：与测试和文档基本一致；但 `rejected` 的 200 响应是作者说法未覆盖的分支，见意见 3。
   - 测试辅助 `confirmablePost`：所有旧 `changePolicy` 调用仍通过包装函数进入同一路径，签名和路径拼接一致。

**未核实**：实际运行测试的结果；真实 iPhone 客户端对新增 `undo` 字段和 `{id,state:"rejected"}` 的处理；是否存在实际产生 79–84 字符 runId 的外部/导入路径。
