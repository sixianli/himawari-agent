## 复核结论

未发现会改变模型请求开头、或造成跨主人越权的高/中危问题。下面按严重度列出我读代码确认的缺口，均为低危或测试覆盖问题。

## 已读代码证实

### 低 1：登录设备控制层没有自己校验 `scope.agentId`

- 文件:行：`apps/agent-service/src/production-login-devices-control.ts:45-52`、`90-92`
- 问题：`#owner` 只比对 `authentication.ownerId` 和 `query/command.scope.ownerId`，不像文件列表控制层那样同时校验 `scope.agentId`。生产链的外层 `ProductionThreadGatewayAccessPolicy` 会拦（见下方证据），所以当前不可利用；但这是控制层自身的二次校验缺口。
- 证据：
  ```ts
  // production-login-devices-control.ts:45-51
  #owner(authentication, scopeOwnerId) {
    const { ownerId } = this.#options.configuration;
    if (!authentication || authentication.ownerId !== ownerId || scopeOwnerId !== ownerId)
  ```
  对比：
  ```ts
  // production-files-control.ts:39
  if (query.scope.ownerId !== ownerId || query.scope.agentId !== agentId)
  ```
  生产外层确实会校验：
  ```ts
  // production-http-composition.ts:440-447
  input.message.scope.ownerId !== this.#ownerId ||
  input.message.scope.agentId !== this.#agentId ||
  ```
- 建议：在登录设备控制层补 `command/query.scope.agentId === configuration.agentId`，并加一条错误路径测试；或至少明确注释“依赖外层访问策略”。

### 低 2：登录设备的新排序比较器没有测试固定

- 文件:行：`apps/agent-service/src/production-login-devices-control.ts:60-64`
- 问题：第 2 轮把 `localeCompare` 改成手写 `<`/`>` 比较，但现有测试比较前对两边都 `.sort()`，所以把比较器改回旧实现、或把排序方向改反，测试仍然通过。
- 证据：
  ```ts
  // production-login-devices-control.ts:60-64
  const devices = [...(await this.#options.state.listDevices(ownerId, false))].sort(
    (left, right) =>
      (right.lastSeenAt > left.lastSeenAt ? 1 : right.lastSeenAt < left.lastSeenAt ? -1 : 0) ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
  ```
  ```ts
  // production-http-composition.unit.test.ts:1259-1263
  expect(before.map(({ deviceId }) => deviceId).sort()).toEqual(
    (await running.repository.sessionDeviceState().listDevices(OWNER_ID as never, false))
      .map(({ id }) => id)
      .sort(),
  );
  ```
- 建议：直接断言 `before.map(({ deviceId }) => deviceId)` 等于预期的 `lastSeenAt` 降序、同时间 `id` 升序，才能守住新比较器。该排序本身与 SQLite 的 `ORDER BY last_seen_at DESC, id`（`sqlite-durable-operations.ts:4947-4948`）一致，我未发现问题。

### 低 3：“找不到设备返回 404”的新顺序没有被真正固定

- 文件:行：`apps/agent-service/src/production-http-composition.unit.test.ts:1294-1296`
- 问题：作者说把设备查找移到最近验证之前。测试却用有效的 `second.authenticationRef` 去调不存在的设备，旧顺序（先验证最近身份）也会返回 404，因此这条用例无法证明“没有最近验证也先返回 404”。
- 证据：
  ```ts
  // production-http-composition.unit.test.ts:1294-1296
  expect(
    (await revoke("device-missing", second.authenticationRef, "revoke-missing")).statusCode,
  ).toBe(404);
  ```
  代码本身顺序是对的：
  ```ts
  // production-login-devices-control.ts:93-101
  const all = await this.#options.state.listDevices(ownerId, true);
  const device = all.find((entry) => entry.id === command.payload.deviceId);
  if (!device) throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, ...);
  ...
  await this.#options.recentAuthentication.assertRecentAuthentication(...)
  ```
- 建议：把该用例的 `recentAuthenticationRef` 改成 `null`，仍断言 404。

### 低 4：两个适配器的 context 转交没有自动检查

- 文件:行：`packages/application/src/services/autonomy-gateway-adapter.ts:356-357`、`packages/application/src/services/host-workspace-gateway-adapter.ts:626-627`
- 问题：两处 `delegate.query(query, context)` 的改动没有测试。把 `context` 去掉后，现有测试不会失败。
- 证据：
  ```ts
  // autonomy-gateway-adapter.ts:356-357
  async query(query: GatewayV2Query, context?: GatewayV2QueryContext) {
    if (!QUERIES.has(query.type)) return this.#dependencies.delegate.query(query, context);
  ```
  ```ts
  // host-workspace-gateway-adapter.ts:626-627
  async query(query: GatewayV2Query, context?: GatewayV2QueryContext) {
    if (!QUERIES.has(query.type)) return this.#dependencies.delegate.query(query, context);
  ```
- 建议：给这两个适配器加 delegate spy，断言非本适配器负责的查询会原样收到同一个 `context.authentication`。这两个适配器不在生产链，优先级低。

### 低 5：新增的 `#quotable` agent 限制没有反向用例

- 文件:行：`apps/agent-service/src/production-memory-control.ts:530-539`
- 问题：作者声明“同主人但不同 agent 的记忆不给引用”，代码确实加了 `record.agentId === agentId`，但现有集成测试全部使用同一个 `AGENT_ID`，把这一行删掉测试也不会失败。
- 证据：
  ```ts
  // production-memory-control.ts:530-539
  #quotable(record: ProductMemoryRecord): boolean {
    const { ownerId, agentId } = this.options.configuration;
    return (
      record.ownerId === ownerId &&
      record.agentId === agentId &&
      record.status !== "deletion_pending" &&
  ```
  现有链测试只构造同 agent 数据：
  ```ts
  // production-memory-capture.test.ts:2288
  const newer = (await state.listActive(OWNER_ID, AGENT_ID)).find(({ id }) => id !== sourceId);
  ```
- 建议：加一条同 owner、不同 agent 的 `supersededBy` 记录，断言 `quote` 不出现或 `quoteLatestMemoryId` 为 `null`，反向去掉 agent 判断时失败。

### 低 6：`contentPath` 的 512 边界缺少拒绝用例

- 文件:行：`packages/gateway-contracts/test/files-list-gateway.contract.test.ts:49-58`
- 问题：新增用例覆盖了 128 个冒号编码后的 406 字符路径，能证明“从 256 提到 406 以上”生效；但没有 513 字符拒绝用例，也没有正好 512 字符的接受用例，512 这个上限本身没有被钉住。
- 证据：
  ```ts
  // files-list-gateway.contract.test.ts:49-58
  gatewayV2MessageSchema.parse(
    snapshot({
      files: [{
        ...file,
        contentPath: `/api/files/v1/content/${encodeURIComponent(":".repeat(128))}`,
      }],
    }),
  );
  ```
  实际长度：前缀 `/api/files/v1/content/` 22 字符，最大合法 `machineString` id 128 字符且只可能编码 `:` 这一类字符，最大 `22 + 3*128 = 406`，所以 512 对生产者的合法 id 足够。
- 建议：补 `512` 接受、`513` 拒绝两个边界用例；如果只关心生产者最大值，也可保留现用例但注明 406 是生产者上界。

## 推测 / 未核实

- **`quoteLatestMemoryId` 与超长 memory id（既有风险，被新字段再次暴露）**：`production-memory-control.ts:1083` 用 `memory:owner:${command.idempotencyKey}` 直接 cast 成 `MemoryId`，而契约 `machineString` 允许 idempotencyKey 最长 128（`contracts-v2.ts:187`、`validation.ts:49-58`），拼出来可达 141 字符，超过 `memoryId`/`quoteLatestMemoryId` 的 128 上限。域层 `identifiers.ts:39` 也限制 128。这个路径在改动前已经可能让 memory overview 的 `memoryId` 失败，本次只是新增字段又消费一次；我没有继续追到 memory engine 是否会在入库存前拒绝这种 id，因此标为推测/既有风险，不是本 PR 新引入。
- **文档一致性**：仓库里没有找到针对本批 `files.list.read`、`login.devices.read`、`login.device.revoke`、`quoteSuperseded` 的新值清单或设计文档；目前只有 `ci/operations-pending.json` 的理由说明。若批次规范在仓库外，这一项未核实。

## 侧重检查

- **错误路径**：当前设备 409、已退设备 replay、缺设备 404、活动设备缺最近验证被拒，代码顺序和返回码与作者说明一致（`production-login-devices-control.ts:91-103`）。缺设备测试未覆盖“无最近验证”这一新顺序，见低 3。
- **不合规范/不可信输入**：`files.list.read` 的 `before`、`limit`、`kind`、`origin` 由契约校验（`contracts-v2.ts:744-759`），存储层再次校验（`sqlite-thread-artifact-operations.ts:239-250`）；文件 `name`/`mediaType` 经过 `displayText` 截断和 Cc 控制字符替换（`production-files-control.ts:14-22`）。设备 `label` 经过 `singleLine` 截断和 Cc 替换（`production-login-devices-control.ts:29-36`）。
- **安全**：登录设备查询/撤销只返回或操作本 owner 设备；`#owner` 只查 owner，agent 依赖外层访问策略，见低 1。没有发现跨 owner 读取路径。
- **资源耗尽**：取代链新增 8 步上限和成环检测（`production-memory-control.ts:546`），避免无限遍历；文件页最多 100 条（契约上限），单条 name/mediaType 有截断；登录设备列表没有分页，但网页现有 `/api/identity/v1/devices` 同样返回全量，属既有行为。
- **不可撤销操作**：设备撤销会同时撤销其 sessions（`sqlite-durable-operations.ts:5031-5035`）；新网关禁止撤销当前设备，保护了不会把自己踢下线。网页撤销路由确实没有这条守卫（`built-in-identity-routes.ts:162-175`），作者说明为原有行为，代码核对一致。
- **规则/说明与代码**：`ci/operations-pending.json` 中 `files.list.read`、`login.devices.read`、`login.device.revoke` 的理由与实现、契约名一致；`check-operations.mjs` 会因缺少 TypeScript 调用方而要求保留在 pending。未发现规则文件被违反。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本次 diff 只改网关契约、读模型适配器、`ProductionFilesControl`/`ProductionLoginDevicesControl`、`memory.rules` 网关快照和测试；没有改提示词目录、线程提示词组装、历史存储或遮盖代码。`memory.rules.read` 的消费方是网页控制中心（`apps/control-center/src/memory.ts:114-119`），不是模型请求组装。因此发给模型的内容仍只在末尾追加，每轮变化的值仍应只放最后一条消息（`.claude/rules/prompt-prefix.md:27-29`、`35`）。新增的 `generatedAt` 只出现在客户端网关快照，不进模型请求。

2. **同一段文字会不会在不同请求里变成不同字节？**
   对模型可见内容不会。文件列表顺序由存储层 `ORDER BY a.created_at DESC, a.id DESC` 固定（`sqlite-thread-artifact-operations.ts:272-276`）；登录设备改为显式 `lastSeenAt`/`id` 比较，结果确定（`production-login-devices-control.ts:60-64`）；取代链只依赖当前记忆状态，给定状态结果确定（`production-memory-control.ts:542-553`）。`generatedAt` 和登录设备的 `lastSeenAt` 会随时间/活动变化，但只出现在网关响应中，不进入模型请求。

3. **有没有自动检查，反向用例真的会失败？**
   有：
   - 契约层：`files-list-gateway.contract.test.ts`、`login-devices-gateway.contract.test.ts` 覆盖正反字段校验；`contentPath` 406 字符正例在退回 256 时会失败。
   - 集成层：`sqlite-thread-artifacts.test.ts:394-521` 覆盖文件列表分页、过滤、网页同源数据、错误 owner、非法 cursor/limit/kind；`production-memory-capture.test.ts:2316-2347` 覆盖 9 节点链返回 null、8 节点链返回最新、成环返回 null，去掉深度/成环守卫会失败；`production-http-composition.unit.test.ts:1291-1293` 覆盖已退设备 replay，去掉“先返回 replay”会因 null 最近验证而失败。
   - 缺口：排序顺序未断言（低 2）、缺设备 404 未用 null 最近验证（低 3）、适配器 context 转交无测试（低 4）、`#quotable` 的 agent 限制无反向用例（低 5）、`contentPath` 512 边界无 513 拒绝（低 6）。

4. **每个新值的产生处和使用处两端校验是否匹配？**
   - `files.list.read` / `files.list.snapshot`：契约、fixture、生产安装名单、`ProductionFilesControl` 四端都已加入（`contracts-v2.ts:143-144`、`2807-2810`、`production-approval-gateway.ts:147-148`）。`fileId` 由 `artifact.id` 产生，实际生成形式 `thread-artifact:<uuid>` 通过 `machineString`；`contentPath` 与网页路径前缀一致（`production-files-control.ts:12`、`control-center/src/gateway-client.ts:741`），最大合法值 406 < 512。
   - `login.devices.read` / `login.devices.snapshot` / `login.device.revoke`：契约、fixture、安装名单、控制层四端一致（`contracts-v2.ts:145-147`、`2812-2814`、`production-approval-gateway.ts:124-125`、`237-238`）。`deviceId` 实际来自 `device-<uuid>` 或 `device:<hex>`，都满足 `machineString`；`label` 截断到 80；时间字段来自设备表。
   - `quoteSuperseded` / `quoteLatestMemoryId`：产生处 `production-memory-control.ts:520-527`，使用处契约 `contracts-v2.ts:1792-1793`；`quoteLatestMemoryId` 与已有 `memoryId`/`supersededBy` 使用同一个 `machineString`，未发现新增的不匹配。潜在超长 memory id 见“推测”。
   - `recentAuthenticationRef`：契约允许 `null`（`contracts-v2.ts:802-806`），控制层对活动设备要求非空且匹配当前认证，对已退设备跳过；两端语义一致。
   - `PRODUCTION_FILES_OPERATIONS` / `PRODUCTION_LOGIN_DEVICE_OPERATIONS`：同时加入 `installedOperations`（`production-approval-gateway.ts:296-297`）和 HTTP 可见安装名单（`production-http-composition.ts:702-703`），名称都存在于契约；`ci/operations-pending.json` 因缺少 TypeScript 调用方而保留，`check:operations` 的规则与文件内容一致。

总体建议：可合并；合并前最好补上低 2、3、5 的三条断言，尤其是低 5 的“同 owner 不同 agent 不给引用”是作者明确声称的产品行为，应有反向用例守住。
