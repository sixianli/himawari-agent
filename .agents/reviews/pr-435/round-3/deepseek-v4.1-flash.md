以下结论均基于我在当前检出 `9ad87ea` 上读到的代码和 diff；没有运行测试（环境只允许读文件和 git 只读命令），需要执行才能确认的标为“未核实”。

## 发现（读代码证实的，按严重度）

### 1【中】材料标题/“已核对的事实”与代码不一致：退回并没有装进生产，部署快照核验也已删除
- 文件：`apps/agent-service/src/production-approval-gateway.ts:64`、`apps/agent-service/src/production-capability-lifecycle.ts:21`
- 问题：材料标题写“列表、详情、停用、退回装进生产”，并称“本 PR 用当前部署快照（capabilityDeployment）作为依据：快照里没有同引用同版本同摘要的条目就拒绝”。实际最终提交把 `capability.rollback` 从生产安装清单删除，且 `production-capability-lifecycle.ts` 已不再引用 `CapabilityDeploymentSnapshotLoader`。
- 证据：
  - `production-approval-gateway.ts:64-70`
    ```ts
    export const PRODUCTION_CAPABILITY_OPERATIONS = Object.freeze([
      "capability.list",
      "capability.detail",
      "capability.disable",
    ] as const);
    ```
  - `production-capability-lifecycle.ts:27-38`
    ```ts
    verified: false,
    reasonCodes: [VERSION_CHECKS_UNAVAILABLE],
    ...
    qualify: async (manifest) => {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Capability runtime qualification is not available on this gateway",
    ```
  - `docs/architecture-v0.1.md:364` 已改成“生产网关安装 `capability.list/detail/disable`……退回……生产网关没有安装它”，说明代码/架构文档是一致的，只有复核材料没跟上。
- 建议：把材料“目标和已核对的事实”改成：本 PR 只装 `list/detail/disable`；`rollback` 仅在契约和服务层保留，生产不可用。否则复核者会按错误前提检查“退回失败状态不变”。

### 2【低-中】幂等重放路径不复验“最近认证”
- 文件：`packages/application/src/services/governance-gateway-adapter.ts:599`、`:625`、`:989`、`:1010`
- 问题：对已存在的 receipt，新加的前置检查直接跳过认证；已完成 receipt 在 `#begin` 后立刻返回；正在执行且状态已变的 receipt 走 recovering 短路也跳过 `#assertRecentAuthentication`。因此“同一 idempotencyKey + 同一 payload”的重放不需要匹配或未过期的最近认证。它不改变状态，但和“停用/退回在服务器端验最近认证”的字面要求不完全一致，且没有反向用例覆盖。
- 证据：
  - `governance-gateway-adapter.ts:625-631`
    ```ts
    const existing = await this.#dependencies.receipts.get(...);
    if (existing) return;
    await this.#assertRecentAuthentication(authentication, command.payload.recentAuthenticationRef);
    ```
  - `governance-gateway-adapter.ts:599-600`
    ```ts
    const attempt = await this.#begin(input.command);
    if (attempt.completedResult) return attempt.completedResult;
    ```
  - `governance-gateway-adapter.ts:989-996`
    ```ts
    if (
      recovering &&
      current.revision === command.payload.expectedRevision + 1 &&
      current.lifecycle === "disabled"
    ) {
      return this.#capabilityResult(current);
    }
    await this.#assertRecentAuthentication(...);
    ```
- 建议：明确这是“回放只返回旧结果、不再做新状态变化”的设计取舍并写进文档；如果想严格，在返回 replayed 结果前也验证 authenticationRef 与 receipt 记录一致，或至少在重放路径记录原因码。补一个“已 disabled 后用过期认证重放”的反向测试，确认预期行为。

### 3【低】403 后不再清重试键；前置认证修复只覆盖 disable/rollback
- 文件：`apps/control-center/src/governance-control-center.tsx:795`、`packages/application/src/services/governance-gateway-adapter.ts:781`、`:711`
- 问题：本轮删除了 `if (status === 403) storage.clearPendingGovernanceMutation(...)`。`capability.disable` 因新增了 `#authenticateBeforeFirstReceipt`，认证失败不会再留下 executing receipt；但 `approval.respond` 等命令仍在 `#begin` 之后才验最近认证。一次 403 会留下 executing receipt，补认证后 `recentAuthenticationRef` 变化，再用同一 idempotencyKey 重试会因 fingerprint（包含 payload）不同得到 409，被界面显示成“版本冲突”。触发面窄（UI 对 critical/destructive 会先要求 recentAuthenticationRef），但这是一个真实存在的重试路径。
- 证据：
  - `governance-control-center.tsx:795-813` 只剩 401/409 分支，403 不清键。
  - `governance-gateway-adapter.ts:781-785` `approval.respond` 在 receipt 建立后调用 `#assertRecentAuthentication`。
  - `governance-gateway-adapter.ts:711-721` fingerprint 包含完整 `payload`。
- 建议：把“认证前置于 receipt”推广到所有需要最近认证的治理命令，或对 `approval.respond` 保留 403 清键；并恢复 403 的交互测试。

### 4【低】测试/夹具覆盖缺口
- 文件：`test/integration/sqlite-durable-repositories.test.ts:786`、`test/e2e/fixtures/control-center-browser-server.mjs:1839`、`:2210`、`packages/testing/src/in-memory/capabilities.ts:119`
- 问题：
  - SQLite 用例只验证 disable 计数，没有验证文档强调的“暂停中的任务也算被取消”，也没有验证 revoke/uninstall 保留 `lastInvalidation`。
  - e2e 夹具仍宣告安装了 `capability.rollback`，且 `capability.disable` 既不校验 `recentAuthenticationRef` 也不写 `lastInvalidation`，无法反映生产行为。
  - in-memory store 的 `invalidateCapabilityAuthority` 只 `save` + 撤销句柄，未实现 `listScheduledJobRefs` / `lastInvalidation`，服务层测试看不出与 SQLite 实现的差异。
- 证据：
  - `packages/testing/src/in-memory/capabilities.ts:119-127`
    ```ts
    async invalidateCapabilityAuthority(record, expectedRevision, revokedAt) {
      const saved = await this.save(record, expectedRevision);
      await this.revokeCapabilityHandles(record.ref, revokedAt);
      return saved;
    }
    ```
  - `test/e2e/fixtures/control-center-browser-server.mjs:1839-1843` disable 分支只改 revision/lifecycle。
- 建议：补 paused 计数和 preserve 用例；让 e2e 夹具与生产 `installedGatewayV2Operations` 对齐并在 disable 时校验 recent auth、写 `lastInvalidation`；in-memory fake 同步新语义。

## 推测
- `listCapabilityScheduledJobRefs` 无 LIMIT、且 `json_extract(record_json, '$.capabilityRef')` 无法走索引，任务很多时会全表扫描。当前 `scheduled_jobs` 规模通常很小，暂不算问题；若单能力任务可能上千，建议加索引列或上限。
- `record_json` 新增 `lastInvalidation` 后，交付/维护脚本里的 `registryRecordSha256`（如 `scripts/delivery-mode/packet-template/maintenance/maintenance-common.mjs:164`）会变化。任何 disable 本来就会改 revision，因此不是新故障类，但上线维护流程要知道 disable 会让冻结目录 hash 失配。

## 侧重检查
- 错误路径：disable 无最近认证时先于状态变化报 `NOT_AUTHORITATIVE`，生产集成测试验证状态仍 `active/revision 1`（`test/integration/production-capability-gateway.test.ts:222-228`）；rollback 未安装返回 `OPERATION_NOT_INSTALLED` 且状态不变（同文件 253-275）；rollback 服务层先 `qualify` 再 `switchCapabilityVersion`，失败不会改状态（`capability-lifecycle-service.ts:595-617`）。
- 不可信/越界输入：`capabilityRef` 受 `machineString` 约束，SQLite `get/list/listScheduledJobRefs/invalidate` 均带 `owner_id/agent_id` 参数（`sqlite-durable-operations.ts:2682-2696`、`durable-adapters.ts:428-429`）。
- 安全：`RecentAuthenticationGuard` 校验 ref、evidence、session/device、时间窗和身份绑定（`recent-authentication-service.ts:52-126`）；缺陷是重放路径跳过它（发现 2）。生产配置接口只在 evidence 新鲜时下发 `recentAuthenticationRef`（`http-gateway-server.ts:945-962`）。
- 不可撤销操作：disable 会取消定时任务且不自动恢复，UI 文案和架构文档写明；`lastInvalidation` 的计数在同一事务内完成（`sqlite-durable-operations.ts:2625-2679`），计数与保存一致。
- 资源耗尽：见“推测”。
- 规则/文档一致性：`prompt-prefix` 相关文件、模型请求组装文件均未改动；`docs/architecture-v0.1.md:364,554` 与代码一致；不一致的是复核材料（发现 1）和 e2e 夹具（发现 4）。

## 必答问题

1. **会不会改变模型已见过的请求开头？** 不会（基于 diff 的结论；未重跑 `check:prompt-prefix`）。改动只涉及产品治理网关、SQLite 记录、控制中心 UI/文案、测试和架构文档，没有触碰系统提示、工具定义、历史消息、出口遮盖或模型请求组装。`installedGatewayV2Operations` 只用于浏览器配置和页面显隐，不进入模型请求。因此“只追加、每轮变化值在最后一条用户消息”的现状未被破坏。

2. **同一段文字在不同请求里会不会变成不同字节？** 不会影响模型侧字节。新增的会变值（`occurredAt`/`cancelledScheduledJobs`）只出现在控制中心 capability snapshot 和持久化 `record_json`，不进入模型请求；存储读取用 `ORDER BY id`，读模型再用 `distinctSorted`，同一状态内枚举顺序确定。没有新增依赖后文的遮盖。未发现会进入模型请求的无序集合或时间字段。

3. **有没有自动检查，反向用例真的会失败吗？** 有：
   - `test/integration/production-capability-gateway.test.ts` 覆盖“无 recent auth 拒绝且状态不变”“disable 计数 2 并详情显示”“rollback 未安装且状态不变”。其中第一次 `disable(null, "disable-none")` 与第二次 `disable(auth, "disable-none")` 复用同一 idempotencyKey——若删掉 `#authenticateBeforeFirstReceipt`，第一次会留下 executing receipt，第二次会 fingerprint 冲突而失败，因此这个反向用例确实能守住前置认证修复。
   - `test/integration/governance-control-center.test.ts` 新增 disable/rollback 的 null 与不匹配认证拒绝、状态不变，以及恢复路径。
   - `test/integration/sqlite-durable-repositories.test.ts` 覆盖 `listScheduledJobRefs` 及 disable 后 `lastInvalidation`/任务取消。
   - 控制中心 inventory/action 过滤用例会在过滤逻辑被去掉时失败（fixture 的 `rollbackAvailable` 为 true）。
   - 缺口：paused 计数、revoke/uninstall 保留 `lastInvalidation`、重放路径用过期认证、e2e 真实行为均未覆盖（见发现 4）。

4. **新值每个生产/使用点两端都能接受吗？**
   - `recentAuthenticationRef`：UI 生成（`governance-control-center.tsx:762-786`）→ 契约 `nullable(machineString)`（`contracts-v2.ts:1908-1924`）→ 控制面校验（`governance-gateway-adapter.ts:620-632,996,1018`）→ `RecentAuthenticationGuard` 要求非空且匹配 evidence。两端一致；UI 对 destructive 动作还要求非空（`governed-action.ts:34`）。
   - `lastInvalidation`：SQLite 只在 `lifecycle === "disabled"` 时写入（`sqlite-durable-operations.ts:2643-2657`）→ 端口类型 `lifecycle: "disabled"`（`ports/capabilities.ts:279`）→ 读模型 `record.lastInvalidation ?? null`（`governance-gateway-adapter.ts:478`）→ 契约枚举只允许 `"disabled"`（`contracts-v2.ts:2345-2355`）→ UI 按 count/time 渲染（`governance-control-center.tsx:489-495`）。夹具 `gateway-v2.fixture.ts:983`、`control-plane-snapshots.json:207`、e2e 夹具均已补 null。两端一致。
   - `capability.listScheduledJobRefs`：adapter 发出字符串（`durable-adapters.ts:428-429`）→ dispatcher 同名 case（`sqlite-durable-operations.ts:776-779,2682-2696`）；端口可选，生产网关用 `?.() ?? []` 兜底；owner/agent 限制在闭包和 SQL 两处都有。
   - `mutationsOfferedWhenInstalled`：只在清单产生（`control-center-inventory.ts:45,225`），只被 `isSurfaceInstalled` 消费（同文件 67-69），一致。
   - `PRODUCTION_CAPABILITY_OPERATIONS`：同时用于 `routeOptions` 广告和网关 `installedOperations`，是同一常量，一致。
   - 唯一“同一个值两端认知不同”的地方是复核材料对 rollback/部署快照的描述（发现 1），不是运行时代码；另外 `record_json` 的 hash 被交付脚本当消费方使用，disable 后 hash 必然变化（见“推测”）。
