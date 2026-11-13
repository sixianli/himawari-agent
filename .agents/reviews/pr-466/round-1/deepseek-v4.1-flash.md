（本轮工具步数已达上限，未再运行任何命令；以下结论只基于我已读到的代码，未实际执行 tsc 或测试。）

# PR 466 复核结论

## 读代码证实的

### 1. 高：新增必填字段会让 `npm run typecheck` 失败（control-center 测试夹具没补字段）

文件：`packages/gateway-contracts/src/contracts-v2.ts:1792-1793`、`apps/control-center/src/memory.ts:24-27`、`apps/control-center/test/owner-rules.unit.test.ts:68-79`

问题：`memory.rules.snapshot` 的每一条规则新增了两个必填字段，但 control-center 的 `OwnerRule` 测试夹具没有补，`rule()` 的返回类型正是 `OwnerRule`。

证据：

```ts
// contracts-v2.ts:1790-1793
quote: nullable(boundedString(500)),
quoteSuperseded: booleanValue,
quoteLatestMemoryId: nullable(machineString),
```

```ts
// memory.ts:24-27
export type OwnerRule = Extract<
  GatewayV2Snapshot,
  { type: "memory.rules.snapshot" }
>["payload"]["rules"][number];
```

```ts
// owner-rules.unit.test.ts:68-79
const rule = (change: Partial<OwnerRule> = {}): OwnerRule => ({
  ruleId: "...",
  ...
  quote: null,
  changes: 0,
  lastUsed: null,
  ...change,
});
```

`tsconfig.base.json` 是 `strict: true`；`apps/control-center/tsconfig.json` 明确包含 `test/**/*.ts`；`package.json` 的 `typecheck` 是 `tsc -p tsconfig.json && tsc -p apps/control-center/tsconfig.json`。对象字面量只通过 `Partial<OwnerRule>` 展开，两个必填字段仍是可选的，赋值给 `OwnerRule` 会报“缺少属性”。这不是运行期问题，但会卡住 `npm run check` 里的 `typecheck`。建议在 `rule()` 里补 `quoteSuperseded: false`、`quoteLatestMemoryId: null`，或把这两个字段设计成可选（如果确实允许旧夹具）。

### 2. 中：`supersededBy` 链遍历没有深度/节点上限，违反项目已有做法，存在资源耗尽风险

文件：`apps/agent-service/src/production-memory-control.ts:540-551`、`:518-524`、`:589-600`

问题：每条规则沿 `supersededBy` 一路读库，只做了环检测，没有深度或节点上限；`#rules` 又对所有规则 `Promise.all`，最坏是“规则数 × 链长”次数据库读。

证据：

```ts
async #latestVersion(first: MemoryId, sourceId: MemoryId): Promise<string | null> {
  const seen = new Set<MemoryId>([sourceId]);
  let next: MemoryId = first;
  for (;;) {
    if (seen.has(next)) return null;
    seen.add(next);
    const record = await this.options.state.read(next);
    if (!record || !this.#quotable(record)) return null;
    const after = (record.attributes?.supersededBy ?? null) as MemoryId | null;
    if (after === null) return record.status === "active" ? record.id : null;
    next = after;
  }
}
```

项目里同类链遍历已有上限先例：

```ts
// sqlite-memory-consolidation-operations.ts:19-20
const MEMORY_BASIS_CHAIN_MAX_DEPTH = 8;
const MEMORY_BASIS_CHAIN_MAX_NODES = 200;
```

建议加同样的深度/节点上限，超过就返回 `null`（或明确截断），并考虑同一快照内按 memoryId 缓存，避免多条规则重复走同一条链。

### 3. 中：`login.device.revoke` 没有持久化幂等回执；同键换设备会再执行，重放又会被最近验证拦住

文件：`apps/agent-service/src/production-login-devices-control.ts:82-103`、`apps/agent-service/src/production-approval-gateway.ts:237-238`、`packages/application/src/services/governance-gateway-adapter.ts:610-611`、`:650-709`

问题：治理命令会按 `idempotencyKey` 建回执并校验语义指纹；`login.device.revoke` 不走治理命令，直接进 delegate。它的“重放”只是看设备当前是不是已撤销：

```ts
// production-login-devices-control.ts:90-101
if (command.payload.deviceId === authentication.deviceId)
  throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "LOGIN_DEVICE_IS_CURRENT");
await this.#options.recentAuthentication.assertRecentAuthentication({
  authentication,
  expectedAuthenticationRef: command.payload.recentAuthenticationRef,
});
const all = await this.#options.state.listDevices(ownerId, true);
const device = all.find((entry) => entry.id === command.payload.deviceId);
if (!device) throw ...
if (device.status === "revoked") return { resultRef: device.id, replayed: true };
```

后果：
- 同一个 `idempotencyKey` 若被客户端错误地配上另一个 `deviceId`，会真的撤销另一台设备；治理命令在这种情况下会因指纹不同报冲突。
- 第一次已成功但响应丢失，重试时如果最近验证证据已过期，会先被 `assertRecentAuthentication` 拒绝（`recent-authentication-service.ts:57-89`），即使设备早已被撤销，客户端也拿不到 `replayed: true`。

建议：给这条命令加回执（记录 key → deviceId/result），或者在执行前先按 key 查历史；至少对“已撤销”的重放先返回成功再要求最近验证。也可以把 `login.*` 纳入类似数据导出 `jobs.start(idempotencyKey)` 的幂等处理。

### 4. 中低：`#quotable` 用的是“模型可见”，不是作者说的“主人看得到”；还多加了 agentId 条件

文件：`apps/agent-service/src/production-memory-control.ts:528-537`、`packages/application/src/services/daily-review.ts:172-174`、`packages/application/src/services/model-visibility.ts:10-25`

证据：

```ts
#quotable(record: ProductMemoryRecord): boolean {
  const { ownerId, agentId } = this.options.configuration;
  return (
    record.ownerId === ownerId &&
    record.agentId === agentId &&
    record.status !== "deletion_pending" &&
    ...
    reviewMemoryVisible(record.dataClassification)
  );
}
```

`reviewMemoryVisible` 实际等于 `isModelVisible`，只允许 `public/private/sensitive`，`restricted` 会被挡住。也就是说，一条 `restricted` 的记忆主人自己在网页上能看到，但这里不会给出 `quoteLatestMemoryId`。这与作者说明“主人看得到才给 id”不一致（虽然失败方向是保守的）。另外，作者没提到新增了 `agentId` 相等条件，跨 agent 的旧来源记忆会因此不再给引用/最新 id。

建议：确认这里到底要“主人可见”还是“模型可见”；如果要主人可见，应换用主人侧可见性判断；同时把 `agentId` 条件写进说明并加反向测试。

### 5. 低：可选的 query context 会被其他 ReadModel 包装层静默丢掉

文件：`packages/application/src/ports/gateway.ts:106-107`、`packages/application/src/services/autonomy-gateway-adapter.ts:355-356`、`packages/application/src/services/host-workspace-gateway-adapter.ts:625-626`

现状：生产实际链路是 `GovernanceGatewayV2ReadModel` 转发 context，所以 `login.devices.read` 现在能用。但另外两个实现仍是单参数：

```ts
// autonomy-gateway-adapter.ts:355-356
async query(query: GatewayV2Query): Promise<GatewayV2Snapshot> {
  if (!QUERIES.has(query.type)) return this.#dependencies.delegate.query(query);
```

```ts
// host-workspace-gateway-adapter.ts:625-626
async query(query: GatewayV2Query): Promise<GatewayV2Snapshot> {
  if (!QUERIES.has(query.type)) return this.#dependencies.delegate.query(query);
```

如果以后组合顺序变化（例如把这两个包装器放到治理层前面），登录查询会丢掉 authentication，直接 403。建议把 context 设计成必填并让所有实现都转发，或为需要登录上下文的查询单独开接口，而不是让可选参数在包装链里静默丢失。

### 6. 低：新增字段/可见性/跨 owner 的反向测试不完整

文件：`test/integration/production-memory-capture.test.ts:2270-2323`、`apps/agent-service/test/production-http-composition.unit.test.ts:1245-1260`

已有反向用例覆盖了：来源被取代、最新被归档、环、来源归档。未覆盖：
- `restricted` 最新记忆应给 null（对应作者“主人看得到”的说法）；
- 跨 owner/agent 的 `supersededBy`；
- 缺少 `quoteSuperseded` / `quoteLatestMemoryId` 的新必填字段反向断言。

文件列表测试里还有一处弱断言：

```ts
if (webDevices.statusCode === 200)
  expect(...).toEqual(...);
```

网页路由非 200 时“和网页同一份数据”的比较会被整体跳过。建议改成必须 200，或单独说明允许的失败条件。

### 7. 低：坏 cursor 会以 409 返回，而不是 400

文件：`packages/gateway-contracts/src/contracts-v2.ts:744-751`、`packages/persistence-sqlite/src/sqlite-thread-artifact-operations.ts:248-250`、`packages/platform-node/src/http-gateway-server.ts:883-891`

合同只校验 cursor 是 1-512 位 `[A-Za-z0-9_-]`，不校验能否 base64/JSON 解码；一个合法字符集但解不开的 cursor 会到存储层抛 `PORT_INVALID_OPERATION`，而 HTTP 错误映射对 `ApplicationPortError` 默认返回 409：

```ts
const statusCode =
  error.code === PORT_ERROR_CODES.NOT_AUTHORITATIVE ? 403
  : error.code === PORT_ERROR_CODES.NOT_FOUND ? 404
  : error.code === PORT_ERROR_CODES.OPERATION_NOT_INSTALLED ? 501
  : 409;
```

这是不合规输入的错误路径，建议在合同或控制层做 base64url 解码校验，或把 `PORT_INVALID_OPERATION` 映射成 400。

### 8. 低：文件列表内容路径长度两端上限不一致（I-73 式隐患）

文件：`apps/agent-service/src/production-files-control.ts:68-71`、`packages/gateway-contracts/src/contracts-v2.ts:775`

`contentPath` 上限是 256，但生成方式是固定前缀 + `encodeURIComponent(artifact.id)`，生产没有独立上限。当前生产 id 是 `thread-artifact:<uuid>`（约 53 字符，实际远小于上限），所以现在不会触发；但合同允许 `fileId` 到 128 字符，若字符需要百分号编码（例如 `:` → `%3A`），前缀加编码后理论上可超过 256，导致整个快照校验失败。建议让产生处显式校验/截断，或把合同上限和“前缀 + 最大 id 编码长度”对齐。

## 推测（未完全核实）

- iOS 端如何使用 `quoteSuperseded`/`quoteLatestMemoryId`、`contentPath` 未核实：本检出没有 `clients/apple`，Swift 调用方不在仓库里。
- `files.list.snapshot` 的 `contentPath` 目前指向网页会话的 `/api/files/v1/content/`，设备签名下载口按作者说明在另一个 PR。若 iOS 页面直接使用这个路径打开文件，在设备签名接入前会失败；这是作者已声明的交付缺口，不是本 PR 隐藏的行为。
- 在已有 `gateway.v2` 快照上新增必填字段，对旧严格客户端是接受集合变化；旧浏览器缓存 bundle 或旧 iOS 版本会因 `object()` 拒绝未知字段而解析失败。按仓库文档“稳定 wire contract 不兼容变化必须使用新 schema version”的精神，这值得确认；是否允许 v2 内加字段，未核实具体发布策略。
- 设备列表排序用了 `localeCompare`（`production-login-devices-control.ts:60-63`），不同 Node locale/ICU 下理论上可能产生不同顺序。当前是 UI 快照、不是模型内容，影响低；若要求逐字节确定，应改成直接比较字符串。

## 侧重检查

- 错误路径：文件/登录查询的 scope 不匹配返回 `PORT_NOT_AUTHORITATIVE`（403）；撤销当前设备返回 `CONFLICT`（409）；最近验证失败返回 `NOT_AUTHORITATIVE`；坏 cursor 走存储层会落到 409（见第 7 条）。未安装操作在已装配组合里走不到，控制层抛的是普通 `Error`，会被映射成 500，但当前 `installedOperations` 已包含这些类型，正常请求不会触发。
- 不可信输入：文件名走 `displayText`，替换 `\p{Cc}` 并按 UTF-16 长度截断；设备标签走 `singleLine`，替换控制字符并截断到 80；`deviceId`/`fileId`/`quoteLatestMemoryId` 在合同和 domain/machineString 两侧格式一致。`\p{Cf}`（如 bidi 控制符）不在 `\p{Cc}` 里，合同 `boundedString` 也不拒绝（只拒绝 `<0x20` 和 `0x7f`），文件/设备名仍可能有显示欺骗风险，属低风险。
- 权限与安全：`login.devices.read/revoke` 经 `AgentGatewayV2Service.authorize` 和 `ProductionThreadGatewayAccessPolicy` 校验 owner/agent/actor；撤销当前设备被显式拒绝；`revokeProductDevice` 会同时把该设备的活动 session 置为 revoked（`sqlite-durable-operations.ts:5012-5036`），所以“退出别的设备”在存储层是有效的。
- 资源耗尽：`#latestVersion` 无界（第 2 条）；设备列表没有分页/数量上限，但网页同一接口本来也返回全部设备，属既有行为；文件列表有 `limit<=100` 和分页。
- 不可撤销操作：设备撤销需要最近验证，方向正确；幂等回执缺失和重放顺序是第 3 条的主要问题。
- 规则/文档与代码一致性：`ci/operations-pending.json` 新增的三条说明与代码基本一致；`check-operations.mjs` 确实只扫描 `.ts/.tsx/.mjs`，不会发现 Swift 调用方，作者的说明成立。但第 1 条的 typecheck 问题会让“有自动检查”这个整体结论打折扣。

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

不会（基于代码路径，未实际跑 `check:prompt-prefix`）。本 PR 改的是 gateway 合同、控制层和返回给网页/iOS 的 snapshot，没有改系统提示、工具定义、历史消息、遮盖或压缩逻辑。规则相关的 `memory.rules.snapshot` 只由 control-center/iOS 通过 gateway 查询读取；模型侧的规则块走的是 `owner-profile`/memory projection 那套（`docs/agent-rulebook-inventory.md` 的 M-4 仍明确“被取代的记忆不进规则块”）。新增的 `quoteSuperseded`/`quoteLatestMemoryId` 没有进入模型消息。因此仍然只会在末尾追加；每轮会变的值（`generatedAt`、设备当前标记、最新记忆 id）都留在 snapshot 响应里，不在模型请求头中。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

对模型内容：不会。对 UI 快照：会按设计变化——`generatedAt` 每次不同，`quoteSuperseded`/`quoteLatestMemoryId` 取决于当前记忆链状态，`current` 取决于当前设备。这不是遮盖或序列化不确定导致的；没有发现依赖前后文的遮盖、输出无序 Set 或非确定序列化。设备列表排序用了 `localeCompare`，跨 locale 理论上有轻微不确定性（见推测）；文件按 `createdAt DESC, id DESC`，cursor 是 `[createdAt,id]` 的 base64url，顺序是确定的。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有对应的合同测试和集成测试：
- 文件列表合同测试覆盖了未知 kind/origin、超限、坏 cursor、未知字段、控制字符等反向用例；`object()` 会拒绝未知字段和缺字段（`validation.ts:168-184`），这些反向用例会真实失败。
- 登录设备合同测试覆盖了坏标签、坏时间、未知字段、缺 deviceId、缺 recentAuthenticationRef 等。
- 记忆规则集成测试覆盖了被取代、最新归档、环、来源归档。
但有两个问题：
- 第 1 条的 `OwnerRule` 夹具缺少两个必填字段，`npm run typecheck` 会失败，所以这个 PR 按现状过不了项目自动检查（未实际运行，按类型和 tsconfig 判断）。
- 新增两个必填字段本身、restricted 最新记忆、跨 owner/agent、以及文件列表与网页的强一致，没有专门反向用例；文件测试里的网页一致性断言还会被 `if (statusCode === 200)` 跳过。

### 4. 每个新值两端都能接受吗？

已核实同仓库内的两端：
- `fileId` / `threadId` / `deviceId` / `quoteLatestMemoryId`：生产产生处分别来自 artifact id、ThreadId、DeviceId、MemoryId，格式和 `machineString` 一致（domain `identifiers.ts:39` 的 `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`）。
- `nextCursor` / `before`：存储用 `Buffer.toString("base64url")`，合同正则只允许 `[A-Za-z0-9_-]`，一致。
- `contentPath`：`/api/files/v1/content/` + `encodeURIComponent(id)`，内容路由正则是 `^/api/files/v1/content/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$`（`http-gateway-server.ts:271`），与 id 格式一致；但长度上限存在第 8 条的隐患。
- `kind` / `origin`：合同 `FILE_LIST_KINDS` / `FILE_LIST_ORIGINS` 与 `THREAD_ARTIFACT_KINDS` / `THREAD_ARTIFACT_ORIGINS` 当前一致；这是两份独立清单，存在以后只改一边的漂移风险。
- 时间字段：生产 device 写入用 `toISOString()`，artifact 生成用服务 clock，均满足合同 `timestamp` 的规范化要求；旧数据是否全部规范未核实。
- `mediaType` / `name` / `label`：产生处做了控制字符替换和截断，合同 `boundedString` 通过。

未核实：iOS/Swift 消费端是否会接受新字段、`quoteLatestMemoryId` 如何被使用，以及旧客户端对 v2 新增必填字段的兼容性。

## 作者说法核对

1. “规则快照加 quoteSuperseded、quoteLatestMemoryId……来源记忆仍在用但已被取代时照样给引用并标明……”
   大部分正确：只有 `status === "active"` 且 `supersededBy !== null` 才标 `true`；沿链找最新，环和归档返回 null。但“主人看得到才给 id”实际是“模型可见才给 id”，`restricted` 会被挡；另外新增了未声明的 `agentId` 相等条件；链遍历没有上限。

2. “files.list.read/snapshot……按时间倒序分页，按类型、来源筛选；contentPath 沿用网页会话的下载路由。”
   与代码一致；另外会包含已删除文件（和网页列表一致），没有搜索筛选。

3. “login.devices.read/snapshot、login.device.revoke……不能退出当前这台……由 AgentGatewayV2Service 和治理层转交。”
   生产链路一致：当前设备会被 409 拒绝，最近验证必填，`GovernanceGatewayV2ReadModel` 会转发 context；存储层撤销设备也会撤销其 session。补充两点作者未说：其他 ReadModel 包装器不会转发 context；`login.device.revoke` 没有治理层的持久化幂等回执，重放和同键换设备的行为见第 3 条。

## 建议的处理顺序

1. 先修第 1 条（补 control-center 夹具字段），否则 CI 直接红。
2. 再决定第 2 条链上限和第 3 条幂等回执；这两条涉及资源与不可撤销操作，应该在本 PR 或紧接的修复里处理。
3. 第 4 条先确认“主人可见”到底是不是需求；若是，补 visibility 判断和反向测试。
4. 第 5～8 条可作为后续加固或本 PR 顺手修；第 5 条建议趁这次把 query context 从可选改成所有适配器统一转发，避免以后组合层踩坑。
