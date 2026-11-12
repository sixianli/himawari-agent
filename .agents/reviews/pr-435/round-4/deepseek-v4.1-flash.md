## 读代码证实的发现（按严重度）

### 1. 中低：`lastInvalidation` / `listScheduledJobRefs` 的新语义只落在 SQLite 实现，in-memory 存储没有实现

- 文件:行：`packages/testing/src/in-memory/capabilities.ts:119-127`、`packages/application/src/ports/capabilities.ts:279,293-300`
- 问题：端口上的 `CapabilityRegistryStorePort` 新增了 `lastInvalidation` 字段和可选的 `listScheduledJobRefs`，但 `InMemoryCapabilityRegistryStore.invalidateCapabilityAuthority` 只做 `save` + `revokeCapabilityHandles`，既不统计定时任务，也不写 `lastInvalidation`；该类也没有 `listScheduledJobRefs`。
- 证据：
  ```ts
  // packages/testing/src/in-memory/capabilities.ts:119
  async invalidateCapabilityAuthority(
    record: CapabilityRegistryRecord,
    expectedRevision: number,
    revokedAt: string,
  ): Promise<CapabilityRegistryRecord> {
    const saved = await this.save(record, expectedRevision);
    await this.revokeCapabilityHandles(record.ref, revokedAt);
    return saved;
  }
  ```
  生产用的 SQLite 实现则在事务里统计并写入 `lastInvalidation`（`packages/persistence-sqlite/src/sqlite-durable-operations.ts:2643-2657`）。而主治理集成测试 `test/integration/governance-control-center.test.ts:204` 正是用 `new InMemoryCapabilityRegistryStore()`。
- 影响：任何使用 in-memory store 的环境/测试都会看到 `lastInvalidation: null`、`dependencyTaskRefs: []`，与文档宣称的“停用事务里统计、详情里显示”不一致。生产当前用 SQLite，所以不是线上阻断，但这是一个契约/测试替身不一致。
- 建议：要么在 in-memory store 中实现同样的计数和 `listScheduledJobRefs`，要么把计数职责上移到应用服务（例如增加一个事务性 store 方法返回被取消任务数），让端口契约明确要求所有实现都产出 `lastInvalidation`。并补一条使用 in-memory store 的集成用例。

### 2. 低：幂等重放与最近认证的反向用例没有覆盖“同一 idempotencyKey 失败后重试成功”

- 文件:行：`packages/application/src/services/governance-gateway-adapter.ts:620-631`；测试 `test/integration/governance-control-center.test.ts:577-590`
- 问题：新增的 `#authenticateBeforeFirstReceipt` 在首次请求时先验最近认证，避免认证失败留下 `executing` receipt；但现有反向用例对 `null` 和错误 session 分别使用了不同 idempotency key（`idem-disable-${recentAuthenticationRef}`），没有覆盖“同一个 key 先认证失败、补认证后重试成功”的路径。
- 证据：
  ```ts
  // governance-gateway-adapter.ts:625-631
  const existing = await this.#dependencies.receipts.get(
    this.#dependencies.ownerId,
    this.#dependencies.agentId,
    command.idempotencyKey,
  );
  if (existing) return;
  await this.#assertRecentAuthentication(authentication, command.payload.recentAuthenticationRef);
  ```
  ```ts
  // test/integration/governance-control-center.test.ts:584
  `idem-disable-${recentAuthenticationRef}`,
  ```
- 影响：如果以后有人删掉 `#authenticateBeforeFirstReceipt`、只保留 `#disableCapability` 内部检查，现有用例仍会通过；但首次失败会创建 `executing` receipt，之后用户补最近认证再用同一个 key 重试时，payload 里的 `recentAuthenticationRef` 从 `null` 变成字符串，指纹不同，会被判为 `CONFLICT`。这是该改动最容易回归的语义之一。
- 建议：补一条“第一次以 `recentAuthenticationRef: null`、key K 提交并失败；第二次同一 key K、有效 ref 提交，必须成功且只增加一个 revision”的用例；再补同一 key 改 payload 必须 `CONFLICT` 的用例。

### 3. 低：`lastInvalidation` 的保留语义、UI 展示和浏览器 E2E 假服务器都没有被覆盖

- 文件:行：`packages/persistence-sqlite/src/sqlite-durable-operations.ts:2643-2656`、`apps/control-center/src/governance-control-center.tsx:488-498`、`test/e2e/fixtures/control-center-browser-server.mjs:1839-1843`
- 问题：文档说“保留最近一次停用（之后的撤销或卸载不改它）”，但测试只覆盖了 disabled 时写入计数（`test/integration/sqlite-durable-repositories.test.ts:831-838`），没有覆盖 revoke/uninstall 后 `lastInvalidation` 仍保留；控制中心也没有一条非 null `lastInvalidation` 的渲染用例。浏览器假服务器的 `capability.disable` 分支只改 lifecycle/health，不写 `lastInvalidation`。
- 证据：
  ```ts
  // sqlite-durable-operations.ts:2648-2655
  lastInvalidation:
    lifecycle === "disabled"
      ? { lifecycle, cancelledScheduledJobs: jobs.length, occurredAt: input.revokedAt }
      : (input.record.lastInvalidation ?? null),
  ```
  ```mjs
  // control-center-browser-server.mjs:1839-1843
  case "capability.disable":
    target.revision += 1;
    target.lifecycle = "disabled";
    target.healthStatus = "unknown";
    break;
  ```
  测试 fixture 中该字段只有 `null`（`apps/control-center/test/fixtures/control-plane-snapshots.json:207`、`packages/gateway-contracts/test/gateway-v2.fixture.ts:983`）。
- 影响：UI 文案、格式化、非 null 分支和“保留最近一次停用”的行为都没有自动检查；E2E 也不会复现“停用后显示取消任务数”的真实组合。
- 建议：补 revoke/uninstall 保留 `lastInvalidation` 的持久化用例；补一条控制中心非 null 渲染用例；让 E2E 假服务器在 disable 时写入 `lastInvalidation`，并考虑让假服务器不要声明 `capability.rollback` 已安装（当前 `test/e2e/fixtures/control-center-browser-server.mjs:2210-2220` 仍列出它），否则 E2E 与生产实际组合不一致。

### 4. 低：新增的运维只读查询 `capabilities` 没有 owner/agent 范围

- 文件:行：`scripts/operations/prod-read.sh:95-103`
- 问题：`listScheduledJobRefs` 的存储读是有 owner/agent 约束的，但 `prod-read.sh capabilities` 的 SQL 是全表：
  ```sql
  SELECT c.id, c.status, c.revision, c.version,
    (SELECT count(*) FROM capability_handles h WHERE h.capability_id = c.id) AS handle_count
  FROM capability_declarations c ORDER BY c.id LIMIT 200
  ```
- 影响：如果数据库不是严格一人一库，操作员会看到所有 owner/agent 的能力元数据和 handle 数量。当前 ADR 0234 是一人一库，因此风险低，但与新增存储读的“范围限制”不一致。
- 建议：给 `capabilities` 增加 owner/agent 过滤参数，或至少在脚本说明/测试里明确“只适用于单 owner 生产库”；同时补一个双 owner 的测试。

### 5. 低：详情关联任务和停用统计都是无上限读取

- 文件:行：`packages/persistence-sqlite/src/sqlite-durable-operations.ts:2682-2695`、`packages/application/src/services/governance-gateway-adapter.ts:419-420`
- 问题：`listCapabilityScheduledJobRefs` 没有 `LIMIT`，`capability.detail` 会把该能力下所有未撤销任务 id 放进一个 snapshot；同一事务里的停用逻辑也会把全部任务 `SELECT` 进内存再逐条更新（`sqlite-durable-operations.ts:2632-2642`）。
- 影响：已认证 Owner 可以触发；不是未认证 DoS，但一个能力下任务很多时会造成大响应/长事务。
- 建议：给详情关联任务加分页/上限；停用计数可用单独的 `COUNT(*)`，只有真正需要更新的 id 才分批读取。

## 推测（未核实）

- **契约兼容性**：`object()` 会拒绝未知字段和缺失字段（`packages/gateway-contracts/src/validation.ts:174-180`）。`capability.disable` 的 `recentAuthenticationRef` 和 `capability.snapshot` 的 `lastInvalidation` 都是新增必填字段；仓库内生产者已更新，但如果存在旧版/被浏览器缓存的 control-center bundle，或仓库外的 gateway.v2 客户端，升级服务端后它们会因缺字段而被拒绝。是否构成问题取决于部署是否保证前后端同版本、以及是否有缓存旧前端。建议确认发布方式，必要时把字段做成可选/带默认值或升版本。
- 生产库“3 条能力记录，都是 active”和“部署快照每个能力只有当前版本”无法在仓库内核实；5 分钟资格过期常量已确认（`packages/platform-node/src/capabilities/capability-deployment.ts:30`）。

## 侧重检查

- **错误路径**：`capability.disable` 的最近认证检查在 `lifecycle.disable` 之前（`governance-gateway-adapter.ts:996-1000`）；`rollback` 的检查在 `lifecycle.rollback` 之前（`1018-1022`）。`rollback` 内部先 `qualify` 再 `switchCapabilityVersion`（`capability-lifecycle-service.ts:595-618`），资格失败不会先改状态。认证失败时状态不变已有测试覆盖。
- **不合规范/不可信输入**：`capabilityRef` 在 `get`/`listScheduledJobRefs` 中都是 SQL 参数，无注入面；`recentAuthenticationRef` 只允许 machine string 或 null，真实 guard 对 null、空串、跨 session、过期证据都会拒绝（`recent-authentication-service.ts:57-89`）；`expectedRevision` 是正整数。
- **安全/绕过**：重放已完成或已改状态且 revision 已推进的 receipt 会直接返回旧结果，但不会再改状态；payload 不同的重放会被指纹判为 `CONFLICT`（`governance-gateway-adapter.ts:694-700`）。首次认证失败不会创建 receipt。未发现状态变更前的绕过路径。
- **资源耗尽**：见发现 5；新增详情读和停用事务都无上限，但只有已认证 Owner 能触发。
- **不可撤销操作**：停用会撤销 handle、不可逆地取消任务；UI 侧有 destructive acknowledgement 和最近认证要求（`governed-action.ts:34-43`），文档也明确“不会自动恢复”。服务端本身只强制最近认证，没有单独的“我确认不可恢复”字段；这是现有治理命令的一致做法。
- **规则/文档/代码一致性**：模型提示词目录、系统提示组装、工具定义文件均未改动；`installedGatewayV2Operations` 只进入浏览器配置。架构文档关于“暂停任务也计入、只在停用时写、之后撤销/卸载不改、详情任务来自未取消任务、生产不安装 rollback”的描述与代码一致。新增消息 ID/en/ja/zh 资源齐全；e2e 假服务器和 in-memory store 与生产实现存在上述测试保真度差距。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   代码层面没有。改动没有触碰 `packages/prompt-catalog`、系统提示组装、工具定义或遮盖逻辑；新增的 `lastInvalidation`、`recentAuthenticationRef`、`installedGatewayV2Operations` 都只出现在控制中心/网关契约与 API 响应里。没有新增进入模型请求的每轮变化值。唯一可能影响模型可见工具的是“停用能力导致执行 handle 失效”，这属于既有 handle 工具出现/消失的例外，不是本 PR 新增的提示词写入路径。未运行 `npm run check:prompt-prefix`，以上为代码阅读结论。

2. **同一段文字会不会在不同请求里变成不同字节？**
   没有新增这种风险。`capability.list` 使用 `distinctSorted`，`listScheduledJobRefs` 使用 `ORDER BY id`；`lastInvalidation.occurredAt` 是停用时固定写入的值，不是每次请求变化；新字段不进入模型输入或遮盖。API snapshot 里原有的 `generatedAt` 仍是每请求变化字段，但不是模型内容。未发现依赖前后文的遮盖变化。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有，但覆盖不完整。已验证存在：无/错误最近认证时 disable 被拒且状态不变（`test/integration/governance-control-center.test.ts:559-599`）、rollback 无/错误认证被拒且状态不变（同文件 819-845）、生产未安装 rollback 且状态不变（`test/integration/production-capability-gateway.test.ts:253-275`）、停用计数 2（含 paused）和详情任务清空（同文件 202-248 及 `test/integration/sqlite-durable-repositories.test.ts:786-849`）。缺少：同一 idempotencyKey 认证失败后重试成功、`lastInvalidation` 在 revoke/uninstall 后的保留、非 null `lastInvalidation` 的 UI 渲染、in-memory store 的新语义、跨 owner/agent 的读取隔离。按代码推断，删除最近认证检查或删除计数逻辑会让现有相关用例失败；但只删除 `#authenticateBeforeFirstReceipt` 时现有用例可能仍通过（见发现 2）。本轮未实际运行测试。

4. **新增/修改的每个值，生产端和使用端都能接受吗？**
   - `recentAuthenticationRef`：控制中心发送 `string | null`；契约接受 nullable machine string；真实 guard 接受并校验；null/不匹配会被拒绝。仓库内所有 `capability.disable` / `capability.rollback` 生产者（控制中心、集成测试、契约 fixture）都已补字段。
   - `lastInvalidation`：SQLite 产生 `{ lifecycle: "disabled", cancelledScheduledJobs: number, occurredAt: string }`；read model 输出 `record.lastInvalidation ?? null`；契约要求 nullable 三字段；UI 按 nullable 处理。值本身两端匹配。但 in-memory store 不产生该值，e2e 假服务器也不写入，见发现 1、3。
   - `mutationsOfferedWhenInstalled`：只在 `control-center-inventory.ts` 产生，被 `isSurfaceInstalled` 和测试消费；类型只允许 `true`，两端一致。
   - `PRODUCTION_CAPABILITY_OPERATIONS`：`capability.list/detail/disable` 都是合法 gateway.v2 操作名，既存在于契约类型/命令集合，也存在于 `AgentGatewayV2Service.installedOperations`；没有 I-73 那种“清单 id 过不了后端校验”的问题。
   - 新增消息 ID 和 `prod-read capabilities` 模式：en/ja/zh 资源、message-id 清单、sample value、脚本 usage/switch 均已同步。
   - 风险点：严格契约下新增必填字段对旧客户端是破坏性变化（见“推测”）。
