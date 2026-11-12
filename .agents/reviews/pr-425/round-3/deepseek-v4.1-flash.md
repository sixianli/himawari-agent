我会先查看改动，再对照代码核对作者的说法。
## 作者说法核对（先说明不一致）

- “配对码由调用方生成”与仓库内可读到的设计文档相反：设计写的是“服务器生成配对码：128 位随机数，10 分钟有效，只能用一次”（`docs/execution/specs/2026-11-11-apple-device-body-design.md:169-170`）。作者说的 `claude/project-thread-ppm8gq` 分支在本地不存在（`git show` 报 `invalid object name`），所以“最新版设计”这一点**未核实**。
- “十个硬上限键”与仓库内设计文档不一致：文档写“硬上限的九个配置键”，且键名是 `device.prefetch.cache`（`:583`、`:706`）。
- “server.status.read 的结果和网页健康接口逐项相等”不准确：测试只比较 `live/ready/status/dependencies` 四个字段，网页响应还多一个 `id`；契约还多一个真实健康模型永远不会产生的 `blocked` 依赖状态。
- “PR 404 合并后移出名单”与检查逻辑不符：PR 404 只补后端/测试，调用方仍是第 11 批；此时从 `ci/operations-pending.json` 删除理由会让 `check:operations` 报 `OPERATION_INCOMPLETE ... 缺：调用方`。
- “第 1 轮已采纳四条”在代码里能对上：发布渠道枚举、配对码末字符规范、confirm/rename 额外字段用例、集成测试用合约解析响应体，均可在增量中找到。
- “check:operations、check:secrets、check:boundaries、tsc 通过”**未核实**（本次不能运行命令）。
- “不改发给模型的内容”已核实：diff 只涉及 `packages/gateway-contracts`、`apps/agent-service` 的 HTTP/control、`ci/operations-pending.json` 和测试/复核记录，没有 prompt、工具定义或历史消息组装代码。
- 第 1 轮 `verdicts.jsonl` **未核实**：工作区没有该文件，`git show` 被环境拒绝（`REVIEW_GIT_REFUSED records-path`）。

## 读代码证实的问题（按严重度）

### 1. 中：`device.pairing.start` 的配对码生成方与仓库设计文档相反

- 文件:行：`packages/gateway-contracts/src/contracts-v2.ts:609-612`
- 问题：合约要求调用方在命令里提交 `pairingCode`，服务器只能校验格式，不能保证 128 位随机、只能用一次；而仓库内设计明确写服务器生成。
- 证据：

```ts
const devicePairingStartCommandSchema = object({
  ...commandEnvelope("device.pairing.start"),
  payload: object({ pairingCode: devicePairingCodeSchema }),
});
```

设计文档：

```text
1. Andy 在已登录的网页“设置 → 设备”里点“添加设备”。服务器生成配对码：128 位随机数，10 分钟有效，只能用一次，库里只存它的哈希。
```

- 建议：若最新设计确实改成调用方生成，本次应同时更新仓库内的设计文档；否则把命令改成空 payload，由服务器生成并在快照里返回配对码/哈希。不要只靠“另一个分支上的文档”作为安全依据。

### 2. 中：上限键清单与设计文档不一致，属于 I-73 式“两端各认一套”

- 文件:行：`packages/gateway-contracts/src/contracts-v2.ts:510-521`；`docs/execution/specs/2026-11-11-apple-device-body-design.md:583`、`:706`
- 问题：代码有十个键，并把 `device.prefetch.cache` 拆成 `device.prefetch.cache.entries` 和 `device.prefetch.cache.bytes`；仓库内设计只有九个键，键名是 `device.prefetch.cache`。未来的配置解析器/后端如果真的按设计文档实现，产出的 `limits[].key` 会过不了这里的枚举。
- 证据：

```ts
export const DEVICE_LIMIT_KEYS = [
  ...
  "device.prefetch.cache.entries",
  "device.prefetch.cache.bytes",
  ...
] as const;
```

```text
| `device.prefetch.cache` | 每台设备的抢跑缓存 | 20 条、合计 200 KB | 丢最旧的 |
...
| 硬上限的九个配置键 ...
```

- 建议：二选一并同步仓库内文档：要么设计改成十个键并写清 `.entries`/`.bytes`，要么合约保留单个 `device.prefetch.cache`，用结构化值表达“20 条 / 200 KB”。同时补一条“配置解析器产出的键集合必须等于合约枚举”的自动检查。

### 3. 中（取决于最新设计）：6 位确认数字只出现在快照，`device.pairing.confirm` 没有这个输入

- 文件:行：`packages/gateway-contracts/src/contracts-v2.ts:590`、`:617-620`
- 问题：`pairingNumber` 只出现在 `device.list.snapshot.devices[]`，而确认命令只带 `deviceId` 和 `expectedRevision`。如果作者所说“最新设计有 6 位确认数字”意味着确认时要提交/核对这个数字，当前合约无法表达，后端 PR 404 也无法从命令里校验它。
- 证据：

```ts
pairingNumber: nullable(devicePairingNumberSchema),
...
const devicePairingConfirmCommandSchema = object({
  ...commandEnvelope("device.pairing.confirm"),
  payload: object(deviceRevisionTargetShape),
});
```

```ts
const deviceRevisionTargetShape = {
  deviceId: deviceIdSchema,
  expectedRevision: integer(0),
};
```

- 建议：确认 6 位数字的用途。若用于确认时校验，在 confirm payload 加 `pairingNumber: devicePairingNumberSchema` 并补反向用例；若只用于展示，在设计文档里写清楚，避免后端按“需要校验”实现。

### 4. 中（安全策略需确认）：合约里直接出现 `clientSecret`，而“不要原始秘密”的检查没有覆盖它

- 文件:行：`packages/gateway-contracts/src/contracts-v2.ts:568-572`；`packages/gateway-contracts/test/gateway-v2.fixture.ts:419-422`；`packages/gateway-contracts/test/gateway-v2.contract.test.ts:17-25`
- 问题：新增了字面量 `clientSecret` 字段，并在 fixture 里写入 `"secret-01"`。现有合约测试的禁用键集合只有 `secretValue`、`credential`、`password` 等，没有 `clientSecret`，所以“合约不得含原始秘密”的检查不会报警。
- 证据：

```ts
const accessText = boundedString(256);
const deviceAccessSchema = object({
  clientId: accessText,
  clientSecret: accessText,
});
```

```ts
access: { clientId: "access-client-01", clientSecret: "secret-01" },
```

```ts
const forbiddenKeys = new Set([
  "apiKey",
  "accessToken",
  "password",
  "secretValue",
  "credential",
  "rawContent",
  "jwt",
]);
```

- 建议：优先改成引用（如 `clientSecretRef` / 一次性凭据引用）；如果确实必须下发短期秘密，在设计里写明“为什么可以越过合约的不含秘密约定”，并把 `clientSecret` 加入禁用键白名单/例外说明，确保日志和错误响应不会带出该字段。

### 5. 低：`blocked` 依赖状态没有生产者，且控制层重复定义枚举，存在漂移风险

- 文件:行：`packages/gateway-contracts/src/contracts-v2.ts:630`、`:645`；`apps/agent-service/src/production-server-status-control.ts:14`；`packages/domain/src/durable-state.ts:532`
- 问题：合约和 control 的端口都允许 `"blocked"`，但真实健康模型的 `DependencyHealthStatus` 只有 `healthy | degraded | unavailable`，网页 `/api/health/v1/dependencies` 永远不会返回 `blocked`。iOS 若按契约写了 `blocked` 分支，该分支永远不可达；集成测试也没有真实 `blocked` 生产路径。
- 证据：

```ts
export const SERVER_STATUS_DEPENDENCY = ["healthy", "degraded", "blocked", "unavailable"] as const;
```

```ts
export type DependencyHealthStatus = "healthy" | "degraded" | "unavailable";
```

- 建议：删掉 `blocked`，或让健康模型真正能产生并在集成测试覆盖；同时让 `ServerStatusHealthPort` 的状态类型从合约派生，避免两处枚举各自演进。

### 6. 低：设备名按 UTF-16 长度限制，且允许 bidi/不可见字符

- 文件:行：`packages/gateway-contracts/src/contracts-v2.ts:552-563`
- 问题：作者/设计说“1–64 个字符”，代码用 `trimmed.length`（UTF-16 码元）计数，64 个 emoji 会被当成 128 而拒绝；同时只拒绝 `< 0x20` 和 `0x7f`，允许 U+202E 之类的 bidi 控制字符和零宽字符。设备名来自待配对设备，主人要在确认页辨认，bidi 字符可能造成显示欺骗。
- 证据：

```ts
const trimmed = input.trim();
if (
  trimmed.length < 1 ||
  trimmed.length > DEVICE_NAME_MAX_LENGTH ||
  [...trimmed].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  })
)
```

- 建议：用 `[...trimmed].length` 按 Unicode 字符计数；拒绝 C1、bidi 控制和零宽字符，或在显示层做转义。

### 7. 低：无会话反向用例只断言 `>= 400`，不能证明是认证拒绝

- 文件:行：`apps/agent-service/test/production-http-composition.unit.test.ts:1145-1155`
- 问题：如果认证路径抛 500，测试也会通过，无法证明“无会话被拒”；也没有固定错误码。
- 证据：

```ts
expect(withoutSession.statusCode).toBeGreaterThanOrEqual(400);
```

- 建议：断言精确的 `401`/`403` 及错误码，和现有认证测试保持一致。

### 8. 低：`ci/operations-pending.json` 的移除时机说明与检查逻辑不符

- 文件:行：`ci/operations-pending.json:6-10`；`scripts/check-operations.mjs:205-213`
- 问题：新增说明写“PR 404 合并后移出名单”，但 PR 404 只补“后端实现、测试”，调用方仍是第 11 批。检查要求后端、调用方、测试三者齐全；提前移出会报 `OPERATION_INCOMPLETE ... 缺：调用方`。
- 证据：

```text
"device.list.read": " ... （缺：后端实现、调用方、测试）。PR 404 合并后移出名单",
```

```js
if (!frontendTexts.some((text) => frontendSends(text, name))) missing.push("调用方");
...
if (missing.length > 0 && reason === undefined)
  errors.push(`OPERATION_INCOMPLETE ${name} 缺：${missing.join("、")}`);
```

- 建议：改成“PR 404 补后端/测试，第 11 批补调用方后移出名单”，避免后人按说明提前删除。

## 推测 / 未核实

- 最新设计文档在 `claude/project-thread-ppm8gq` 分支的说法无法核实；本地没有该 ref。
- PR 404 的实现和 `paired_devices` 表不在本仓库，`DEVICE_LIMIT_KEYS`、`deviceId`、`releaseChannel`、`pairingNumber` 的真实生产端无法核对。
- `verdicts.jsonl`、第 1 轮复核结论无法读取，作者“第 1 轮无会出错意见”未核实。
- `blocked` 可能属于未来健康模型计划新增的状态；若如此，应在同一批里补生产者与测试，而不是只放在合约里。
- `clientSecret` 是否有意作为一次性下发凭据，需要设计/安全确认；仅从代码看它确实是原始秘密字段。

## 侧重检查

- **错误路径**：`server.status.*` 走 `production-approval-gateway.ts:126-128`；未安装操作由 `agent-gateway-v2-service.ts:34-42` 返回 501；kind 不匹配由 `http-gateway-server.ts:354-358` 返回 400；认证在 `http-gateway-server.ts:1103-1107` 先于网关调用。未发现新路径绕过认证。
- **不合规范/不可信输入**：配对码有规范 base64url 校验，deviceId 有长度/字符校验，整数有下界、时间戳要求规范 UTC，object 拒绝额外字段；设备名存在长度计数和 bidi/零宽字符问题（见 #6）。
- **安全**：`ProductionServerStatusControl` 调 `authenticatedSnapshot(true)`，目前依赖上游 HTTP 已认证，尚可接受；但 control 自身丢弃了 `configuration` 和认证上下文，未来若被其他路径复用会直接返回数据。`clientSecret` 明文入合约是主要安全观察点（见 #4）。
- **资源耗尽**：`devices`、`limits`、`dependencies` 数组在合约里没有长度上限；客户端提交受 `maximumBodyBytes` 限制，快照由服务器产生，暂不构成本 PR 的利用路径，但后端 PR 404 应设上限。
- **不可撤销操作**：`device.revoke` 有 `expectedRevision` 防陈旧写入，但没有 `recentAuthenticationRef`；与现有 `grant.revoke`/`capability.disable` 一致，暂不算缺陷。吊销本身应确认后端按 revision 做 CAS。
- **规则/文档一致性**：`prompt-prefix.md` 要求的模型请求路径未被触碰；设计与代码在配对码生成方、上限键数量/名字上不一致；I-73 关注的“清单值两端都能接受”在消息类型和 `server.status.read` 上成立，在上限键上不成立。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。改动只涉及网关合约、`server.status.read` 的 HTTP/control 组装、CI 清单和测试；没有系统提示、工具定义、历史消息或遮盖代码的变化。`generatedAt`/健康快照只出现在网关响应，不进入模型请求。因此发给模型的内容仍然只在末尾追加；本 PR 也没有新增每轮变化值到请求开头。

**2. 同一段文字会不会在不同请求里变成不同字节？**
模型请求层面不会。网关快照里的 `generatedAt` 会随每次请求变化，`pairing.expiresAt` 也随时间/配对状态变化，但这些是接口响应，不是模型输入；`dependencies` 顺序来自 `RuntimeHealthModel` 的 Map 插入顺序，当前固定。`device.list.snapshot` 的生产者不在本仓库，设备/上限列表顺序是否稳定**未核实**。若未来把这类快照塞进模型提示，`generatedAt` 必须放到最后一条用户消息里。

**3. 有没有对应的自动检查，反向用例真的会失败吗？**
有，且第 2 轮新增的四类反向用例确实能挡住回归：配对码非规范末字符、未知发布渠道、confirm/rename 额外字段、集成测试对响应体做合约解析。设备名、deviceId、额外字段、整数边界、时间戳、状态枚举都有正/反用例。缺口是：上限键没有生产者/配置解析器两端检查；`blocked` 没有真实生产路径；无会话只断言 `>=400`；`clientSecret` 没被“无原始秘密”检查覆盖。整体是“有检查，但不完整”。

**4. 每个新值两端都能接受吗？**
逐项核对结果：
- 新消息类型字符串：`GATEWAY_V2_MESSAGE_TYPES`、`schemasByType`、fixture、`check:operations` 的 regex 都能接受，**通过**。
- `server.status.read` 安装清单项：合约、`PRODUCTION_SERVER_STATUS_OPERATIONS`、`check:operations` 三方一致，**通过**。
- `DEVICE_KINDS`、`DEVICE_STATUSES`、`DEVICE_RELEASE_CHANNELS`：与仓库内设计文档一致；生产端在 PR 404，**未核实**。
- `DEVICE_LIMIT_KEYS`：与仓库内设计文档不一致，且无配置解析器可核对，**不通过/未核实**（见 #2）。
- `pairingNumber`、`clientSecret`、`deviceId`：没有生产端可核对；`pairingNumber` 还可能与确认流程脱节（见 #3/#4）。
- `SERVER_STATUS_OVERALL`：与 `DeploymentHealthSnapshot` 一致，**通过**。
- `SERVER_STATUS_DEPENDENCY`：多出 `blocked`，生产端不产生，**不通过**（见 #5）。
- `generatedAt`、`actor: "agent-service"`：合约能接受，且集成测试会解析响应体，**通过**。
- 序列化：既有 round-trip 测试覆盖了新 fixture；但 `deviceNameSchema` 的 `parse` 会 `trim`，如果生产者用未裁剪名字调用 `serialize`，输出会与输入不同，需生产者先规范化，**风险已记录**。
