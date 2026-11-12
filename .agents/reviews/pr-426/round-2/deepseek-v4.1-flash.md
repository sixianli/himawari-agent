## 发现的问题（按严重度）

### 1. 中 — “执行后审计写入失败不改变返回结果”这条新行为没有自动测试

- 文件:行：`packages/platform-node/src/device-gateway.ts:155`、`:160`、`:163`；测试 `test/integration/device-gateway.test.ts:357-383`
- 问题：代码对 `failed` / `completed` 的审计写入做了 `.catch(() => undefined)`，但现有测试只覆盖审计写入成功的情况；没有任何用例让 `AuditLedgerPort.append` 在执行后失败，因此这条行为（尤其是不可逆的 `change` 操作返回成功、但完成审计缺失）没有回归保护。
- 证据：
  ```ts
  // device-gateway.ts
  await record("accepted");
  ...
  await record("failed").catch(() => undefined);
  throw error;
  ...
  await record("completed").catch(() => undefined);
  return result;
  ```
  测试只断言：
  ```ts
  // device-gateway.test.ts:378-381
  expect(await auditTrail(h)).toEqual([
    `device.gateway.change:${client.deviceId}:v2:memory.mutate:accepted`,
    `device.gateway.change:${client.deviceId}:v2:memory.mutate:failed`,
  ]);
  ```
- 建议：给 `dispatchDeviceGatewayRequest` 加一个审计桩，让第 2/3 次 `append` 抛错，断言下游结果仍原样返回、`accepted` 已存在；再做一个反向用例，去掉 `.catch` 时该用例必须失败。

### 2. 低 — `setEnabled` 写观测事件没有被直接测试

- 文件:行：`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:326-352`；相关测试 `test/integration/proactive-production.test.ts:705-709`、`test/integration/ledger-observation-store.test.ts:316-317`
- 问题：`setEnabled` 的关键行为是“一次事务只改开关并写 `proactive_enabled` / `proactive_disabled` 观测事件”。暂停测试只检查 `enabled`、静默时段和重要发件人未被改坏，没有检查观测事件；现有的观测事件断言走的是 `writeSettings`，不是新的 `setEnabled`。如果将来 `setEnabled` 只更新开关而漏掉观测事件，现有测试不会失败。
- 证据：
  ```ts
  // sqlite-proactive-operations.ts:345-351
  if ((before?.enabled === 1) !== input.enabled)
    insertObservationEvent(this.database, {
      ...
      kind: input.enabled ? "proactive_enabled" : "proactive_disabled",
      occurredAt: input.now,
    });
  ```
  ```ts
  // proactive-production.test.ts:705-709
  await h.command("proactive.pause", {});
  const paused = await h.overview();
  expect(paused.enabled).toBe(false);
  expect(paused.quietHours).toEqual(tuned.quietHours);
  expect(paused.importantSenders).toEqual(tuned.importantSenders);
  ```
- 建议：在 `proactive.pause`、演示收件箱或连接邮箱的用例里，直接读 `observation_events` 断言新增了对应 kind，且重复暂停不会重复插入。

### 3. 低（推测影响）— `accepted` 审计用随机 UUID 和当前时间，重试会重复记“受理”

- 文件:行：`packages/platform-node/src/device-gateway.ts:145-154`；`packages/persistence-sqlite/src/sqlite-durable-operations.ts:1843-1853`
- 问题：每次请求的审计 id 都是新的 `randomUUID()`，同一设备重试同一 `messageId` / 幂等键时会再次写一条 `accepted`，而不是复用上一次受理记录。若后续有消费者把 `accepted` 当“受理次数”或按时间顺序理解审计链，重试会造成重复和歧义。此条影响为推测，当前代码和测试没有规定 `accepted` 必须幂等。
- 证据：
  ```ts
  id: `audit:device-gateway:${randomUUID()}`,
  ...
  occurredAt: input.now().toISOString(),
  ```
  ```ts
  FROM audit_records WHERE agent_id = ? ORDER BY occurred_at, id
  ```
  同一毫秒内的 `accepted` 和 `completed` 只能按随机 id 排序，无法保证先受理后完成。
- 建议：若希望审计也按幂等键去重，用 `pairedDeviceId + messageId + tier` 派生稳定 id；若故意按每次传输尝试记录，请在类型或注释/文档中写明“accepted 是每次请求尝试的受理记录”，避免后续误用。

### 4. 低（未核实）— 生成的 Swift 引用字段目前没有客户端消费者

- 文件:行：`packages/platform-node/src/device-gateway.ts:67-68`、`:100-107`、`:116-129`；`clients/apple/Sources/HimawariManage/Generated/ClientCapabilities.swift:169-170`；`test/tooling/client-parity.test.ts:113-114`
- 问题：`referencePlaceholder` 和 `serverFilledReferences` 已生成到 Swift，但仓库里没有任何 Swift 代码使用它们；因此“客户端会按这份清单发送 `device` 占位值、并能通过服务端校验”目前只是清单与生成器一致，真实客户端行为未核实。另外清单只给出字段名，没有说明哪些能力类型允许带这些字段；客户端若无差别地把它们塞进所有 payload，会被严格 schema 拒绝。
- 证据：
  ```ts
  export const SERVER_FILLED_PAYLOAD_KEYS = [AUTHORIZATION_KEY, RECENT_AUTHENTICATION_KEY] as const;
  export const DEVICE_REFERENCE_PLACEHOLDER = "device";
  ```
  ```swift
  public static let referencePlaceholder = "device"
  public static let serverFilledReferences = ["authorizationRef", "recentAuthenticationRef"]
  ```
  全仓搜索 `serverFilledReferences` / `referencePlaceholder`，除生成文件和生成器外没有其他使用点。
- 建议：客户端接入时补“生成清单里的每个字段在对应能力类型上都能通过服务端 `classifyDeviceGatewayRequest` 与 schema 校验”的测试；必要时在清单里标出字段适用的能力类型。

## 侧重检查

- **错误路径**：`accepted` 写失败会让请求在 `forward` 之前失败（fail-closed），`failed` / `completed` 写失败被吞掉，返回结果不变。前一种行为没有测试，后一种行为也没有测试；见问题 1。
- **不合规范/不可信输入**：`classifyDeviceGatewayRequest` 只允许 `authorizationRef` / `recentAuthenticationRef` 取占位值 `"device"`，非占位值直接 400；随后 `withServerFilledReferences` 用会话认证引用覆盖，客户端不能伪造身份引用。v1 请求在分类阶段直接 403，`thread-v3 thread.message.submit` 也被挡在设备网关外。以上读代码证实。
- **安全**：设备发消息的专用 `POST /messages` 只接受 `messageId / threadId / expectedRevision / text`，`occurredAt` 用服务器 `now()`，`dataClassification` 固定 `"private"`，客户端不能覆盖时间或分级（`device-api-routes.ts:518-577`）。上传文字走 `parseTextAdmission`，拒绝额外字段、空内容、超长、非法分级（`text-admission.ts:16-31`）。未发现本轮引入新的越权路径。
- **资源耗尽**：审计新增每次 change/tighten 两条记录，量级有界；上传文字有 64 KiB 上限，设备请求体有硬上限。未发现新增无界循环或无限增长。
- **不可撤销操作**：`thread.delete_permanently` 仍是 `change`，无确认直接 403；确认后先写 accepted，再执行。完成审计失败不改变返回结果，这是作者声明的设计，但缺测试（问题 1）。
- **规则/文档一致性**：本次没有改 `packages/runtime-pi`、`packages/prompt-catalog` 或历史组装代码；`prompt-prefix` 规则没有受到影响。`proactive.pause` 加进 `ci/operations-pending.json` 与 `check-operations.mjs` 的行为一致：后端和测试有字面量，网页/脚本没有调用方，因此留在 pending 是正确的。未发现说明文档与代码矛盾；设计文档没有覆盖这轮的设备网关审计细节，属于未核实而非冲突。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本次 diff 只改设备网关/能力表/主动提醒设置持久化/生成的 Swift 清单，没有改系统提示、工具定义、历史消息、遮盖实现或提示词目录。发给模型的内容仍然只由原有流程在末尾追加；新增的每请求变化值（审计 UUID/时间、服务端填充的认证引用）不进入模型请求。读代码证实。

2. **同一段文字会不会在不同请求里变成不同字节？**
   不会涉及模型输入。`SERVER_FILLED_PAYLOAD_KEYS` 是固定顺序的常量，`CLIENT_CAPABILITY_TABLE` 是固定数组，Swift 生成结果确定；审计记录含随机 UUID 和时间，但它们不是模型可见文本。需要注意 `audit_records` 按 `occurred_at, id` 排序，同一毫秒内 accepted/completed 的先后不保证，但这不是模型字节问题。读代码证实排序规则，影响为观察项。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   部分有：
   - v1 全部 `not_on_phone`：有测试；若改回原 tier，测试环境没有装 v1，会得到 `DEVICE_GATEWAY_UNAVAILABLE` 而不是 403，测试会失败，反向有效。
   - `read` 只给查询、`memory.page.viewed` 为 routine：有测试；改回去会失败。
   - `accepted` → `completed` / `failed` 审计：有测试；去掉 accepted 会失败。
   - 上传文字拒绝：有测试；但这是对既有行为的回归测试，不是本轮新增逻辑。
   - Swift 清单：有精确文件比对和“加一种类型但未重生成”的反向测试，反向有效。
   - **缺口**：审计写入失败后不改变返回结果、`setEnabled` 写观测事件，都没有直接测试；见问题 1、2。

4. **每个新值两端都能接受吗？**
   已逐个核对：
   - 审计 outcome `accepted`：`AuditRecord` 类型允许（`packages/application/src/ports/observability.ts:115`），数据库 `audit_records` 的 CHECK 也允许（`migrations/0001_initial_product_schema.sql:293`）。
   - 操作名 `proactive.setEnabled`：产生于 `durable-adapters.ts:1025`，消费于 `sqlite-proactive-operations.ts:143`，前缀路由 `sqlite-durable-operations.ts:594` 能到，两端一致。
   - `setEnabled` 入参：接口 `proactive-checks.ts:337-339` 与 SQLite 实现字段一致。
   - v1 / thread-v3 / memory.page.viewed 的 tier 与 kind：契约测试逐网关校验 kind，另有 v1、read-only 测试；客户端能力表与 Swift 生成器共用同一份表。
   - Swift 的 `referencePlaceholder` / `serverFilledReferences`：生成器直接使用 platform-node 的两个常量，值一致。
   - 新增 `check:client-parity` / `generate:client-capabilities`：`tooling`、`contracts` 项目都存在，新测试文件也被现有 include 覆盖。
   - **唯一未核实的一端**：Swift 字段还没有实际客户端消费者，客户端是否会正确使用占位值、以及能否通过各能力类型的 schema，当前无法从代码确认。

未运行测试或构建（受工具限制），以上结论基于静态阅读代码。
