## 复核结论

### 高 — 退回目标版本不可能出现在“当前部署快照”里

- 严重度：高（功能在生产不可用）
- 文件:行：
  - `packages/platform-node/src/capabilities/capability-deployment.ts:1203-1212`
  - `scripts/delivery-mode/packet-template/signing/cloud-protected-prepare.mjs:85-86,130-153`
  - `apps/agent-service/src/production-capability-lifecycle.ts:46-52`
  - `test/integration/production-capability-gateway.test.ts:136-170,172-183`
- 问题：`entryFor` 要求退回目标 `ref+version+integrity` 出现在当前部署快照中，但快照加载器明确禁止同一 `ref` 出现多个版本，而生产快照生成器又是每个安装绑定（即每个能力当前版本）写一条。因此当前快照只能有“当前版本”，不可能同时有“上一版”这个退回目标。
- 证据：
  ```ts
  // capability-deployment.ts:1203-1212
  const refs = capabilities.map((entry) => `${entry.manifest.ref}@${entry.manifest.version}`);
  if (
    new Set(refs).size !== refs.length ||
    new Set(capabilities.map((entry) => entry.manifest.ref)).size !== capabilities.length
  ) {
    throw failure(..., "must not contain duplicate identities");
  }
  ```
  ```js
  // cloud-protected-prepare.mjs:85-86,153
  const capabilities = [];
  for (const { key, binding } of receipt.bindings) { ... capabilities.push({ manifest, ... }); }
  const snapshot = { schemaVersion: "capability-deployment.v1", capabilities },
  ```
  ```ts
  // production-capability-lifecycle.ts:46-52
  const entry = loaded.snapshot.capabilities.find(
    ({ manifest: candidate }) =>
      candidate.ref === manifest.ref &&
      candidate.version === manifest.version &&
      candidate.integrity === manifest.integrity,
  );
  ```
  测试却构造了一个只含 `0.9.0` 的快照，而登记记录的当前声明仍是 `1.0.0`（`writeDeployment({versions:["0.9.0"]})` + `withPreviousVersion(f,"0.9.0")`），这不是生产中的一致状态。
- 建议：退回核验不能以“当前部署快照”为准。应保留上一版快照/制品引用单独核验，或让快照结构显式携带可退回制品（不受同 ref 唯一限制）。测试必须使用“快照含当前版本”的真实形态，否则无法暴露此问题。

### 高 — 复用启动期快照加载器，5 分钟后退回必然因资格过期失败

- 严重度：高（退回不可用，且错误原因被伪装成“快照不可读”）
- 文件:行：
  - `apps/agent-service/src/production-capability-lifecycle.ts:35-44`
  - `packages/platform-node/src/capabilities/capability-deployment.ts:30,619-625`
  - 测试时钟：`test/fixtures/sqlite-capability-invocation-fixture.ts` 的 `T0=00:00:00`、`T1=00:00:01`
- 问题：退回时每次调用 `loader.load()`，加载器默认要求资格检查时间不超过 5 分钟；生产快照的 `qualification.checkedAt` 是部署准备时写入的固定值，服务运行超过 5 分钟后任何退回都会被 `QUALIFICATION_STALE` 拒绝，并被 `catch` 统一折叠成 `capability_deployment_snapshot_unreadable`。
- 证据：
  ```ts
  // capability-deployment.ts:30
  export const CAPABILITY_DEPLOYMENT_MAX_QUALIFICATION_AGE_MS = 5 * 60 * 1_000;
  // :619-625
  if (nowMs - checkedAtMs > maximumAgeMs) {
    throw failure(CAPABILITY_DEPLOYMENT_ERROR_CODES.QUALIFICATION_STALE, ..., "is too old ...");
  }
  ```
  ```ts
  // production-capability-lifecycle.ts:35-44
  const loader = deployment
    ? new CapabilityDeploymentSnapshotLoader({ ...deployment, now: () => clock.now() })
    : undefined;
  ...
  try { loaded = await loader.load(); }
  catch { return { reason: SNAPSHOT_UNREADABLE }; }
  ```
  现有单元测试 `capability-deployment.unit.test.ts:609-614` 本身已证明超过 `maximumQualificationAgeMs` 会抛 `QUALIFICATION_STALE`；而本 PR 的退回测试时钟只比 `checkedAt` 晚 1 秒，所以测不出来。
- 建议：运行时退回应有独立核验策略（重新做资格检查，或显式放宽/单独配置新鲜度），不要复用“启动准入”加载器的默认 5 分钟限制；至少把“过期”与“不可读”分开报错。增加“时钟前进 >5 分钟仍可退回”的测试。

### 低 — 幂等重放路径跳过“最近认证”检查

- 严重度：低（无法造成新的状态变化，但检查语义不完整，可产生虚假成功/审计）
- 文件:行：`packages/application/src/services/governance-gateway-adapter.ts:974-981,995-1003`（对比 `execute` 的 `:598-601`、`#begin` 的 `:635-693`）
- 问题：`recovering` 早退发生在 `#assertRecentAuthentication` 之前：
  ```ts
  if (recovering && current.revision === expectedRevision + 1 && current.lifecycle === "disabled") {
    return this.#capabilityResult(current);
  }
  await this.#assertRecentAuthentication(authentication, command.payload.recentAuthenticationRef);
  ```
  退回同理。幂等重放本身不产生新变更，且要走到该分支必须先有状态已推进。但收据是在认证前创建的，因此攻击者可以先用错误/空的 `recentAuthenticationRef` 创建一个 `executing` 收据；之后若该能力被另一条合法命令停用/退回，攻击者用原 key 重放会得到成功结果，并写入一条以其幂等键为 id 的 `capability.disable/rollback` 审计记录，而无需重新通过最近认证。
- 证据：上述早退代码；`execute` 中 `#begin` 在 `#mutate` 之前执行（`:598-601`）；`#begin` 在收据不存在时直接创建 `phase: "executing"`（`:643-657`）。
- 建议：在 recovering 分支同样校验认证证据，或至少把这类响应标记为“纯重放”且不追加新的“完成”审计；补充“失败认证后重放”的测试。说明：状态变化本身仍需此前真实认证，因此不是直接的权限提升；利用可达性属于推测。

### 低 — `lastInvalidation` 会被撤销/卸载覆盖，但界面仍写“最近一次停用”

- 严重度：低（展示与语义不一致）
- 文件:行：`packages/persistence-sqlite/src/sqlite-durable-operations.ts:2643-2656`；`apps/control-center/src/governance-control-center.tsx:485-495`；`apps/control-center/src/i18n/resources/zh-CN.ts:580-581`
- 问题：实现里 `disabled | revoked | uninstalled` 都会写 `lastInvalidation`，后两者会覆盖停用时的值；界面标签固定为“最近一次停用 / Latest disable”，也不显示 `lifecycle`，用户会误以为显示的是停用信息。
- 证据：
  ```ts
  lastInvalidation:
    lifecycle === "disabled" || lifecycle === "revoked" || lifecycle === "uninstalled"
      ? { lifecycle, cancelledScheduledJobs: jobs.length, occurredAt: input.revokedAt }
      : (input.record.lastInvalidation ?? null),
  ```
  ```tsx
  label={message("governance.lastInvalidation")}
  value={snapshot.payload.lastInvalidation ? message("governance.lastInvalidationValue", {...}) : "—"}
  ```
- 建议：改为“最近一次失效”并展示 `lifecycle`，或只对 `disabled` 写该字段、撤销/卸载用另一字段。

### 低 — 契约新增必填字段，旧/新客户端双向不兼容（推测发布顺序风险）

- 严重度：低（代码事实明确，实际影响取决于是否原子发布/是否有旧前端缓存）
- 文件:行：`packages/gateway-contracts/src/contracts-v2.ts:1910-1923,2348-2356`；`packages/gateway-contracts/src/validation.ts:174-183`
- 问题：`recentAuthenticationRef` 与 `lastInvalidation` 都是“必填但可为 null”。`object()` 会拒绝未知字段和缺失字段：旧 Control Center 包解析新 `capability.snapshot` 时会因多出 `lastInvalidation` 报 unknown field；新包连旧后端时会因缺字段报 missing required field。
- 证据：
  ```ts
  for (const key of Object.keys(record)) {
    if (!expectedKeySet.has(key)) fail(`${path}.${key}`, "unknown field");
  }
  ...
  if (!Object.hasOwn(record, key)) fail(`${path}.${key}`, "missing required field");
  ```
- 建议：把新增字段做成可选（读侧 `?? null`），或明确版本升级并保证前后端原子发布。旧客户端缓存/回滚发布顺序属于推测，未核实。

### 低 — 失败认证会留下永久 `executing` 收据，403 清键后重试不断新增

- 严重度：低（仅限已认证 Owner，但可被滥用造成表无限增长）
- 文件:行：`packages/application/src/services/governance-gateway-adapter.ts:598-601,981,1003`；`apps/control-center/src/governance-control-center.tsx:807`
- 问题：`#begin` 在最近认证检查之前创建收据；认证失败后收据停在 `executing`，没有清理。Control Center 在 403 后清除 pending key，下一次重试会生成新的幂等键，于是每次认证失败都新增一行 `governance_mutation_receipts`。
- 证据：`execute` 顺序为 `#begin` → `#mutate`，而 `#assertRecentAuthentication` 在 `#mutate` 内；`if (status === 403) storage.clearPendingGovernanceMutation(...)`。
- 建议：把最近认证检查前移到收据创建之前，或为长期 `executing` 收据增加 TTL/清理；至少补一个失败后不残留可重放收据的测试。

---

## 侧重检查

- 错误路径
  - 停用：最近认证在 `lifecycle.disable` 之前；失败后状态不变（测试已覆盖）。
  - 退回：`rollback` 先 `require`、再 `qualify`、最后 `switchCapabilityVersion`；资格失败在写状态前，失败后状态不变（测试已覆盖）。
  - 快照加载异常被折叠为 `SNAPSHOT_UNREADABLE`，把“资格过期”“摘要不匹配”“文件不存在”混为一类，诊断性差，并掩盖了上面的 5 分钟问题。
  - 停用事务中 `saveCapability` 与定时任务更新在同一 `immediate` 事务，任一步失败都会一起回滚；计数发生在更新前，事务内无并发，计数与保存一致。
- 不合规范/不可信输入
  - 命令 schema 对 `recentAuthenticationRef` 的 `null`/字符串有校验；`null` 随后被 guard 拒绝。
  - 快照加载器有大小上限、摘要校验、UTF-8 校验、未知字段拒绝、平台/资格/绑定校验；但这些校验是在“当前部署”语义下设计的，不适合长期运行的退回核验。
  - SQL 都是参数化，未发现注入。
- 安全与范围
  - `getCapability` 与 `listCapabilityScheduledJobRefs` 都带 `owner_id`/`agent_id` 条件；`#assertCommand` 要求 scope、subject、actorType、authorizationRef 匹配；最近认证 guard 校验 evidence、session、identity，而不只是 ref 字符串。
  - 真正的问题是退回核验依据本身不可用（高 1、高 2），不是越权读取。
- 资源耗尽
  - 每次退回会最多两次完整读取/哈希 8MB 快照（`verify` 一次、`qualify` 一次）；不算严重。
  - 失败认证留下的 `executing` 收据没有清理（低 6）。
  - `prod-read.sh capabilities` 有 `LIMIT 200`，不会无界输出。
- 不可撤销操作
  - 停用会撤销句柄并取消定时任务；文档和提示明确“不会自动恢复”。退回只切版本，文档也明确不声称恢复外部副作用/产品状态。语义一致。
- 文档与代码一致性
  - `docs/architecture-v0.1.md` 已补充“暂停任务也计入”“撤销/卸载会覆盖”等说明，和实现一致。
  - 但文档“上一版必须仍在当前部署快照里通过安装包核验和运行环境资格检查，否则拒绝”在代码上是一个生产不可达路径（高 1、高 2），文档描述不成立。
  - `.claude/rules/prompt-prefix.md` 不在本次检出中（glob 未找到），无法逐字核对规则原文；只能按改动范围判断。

---

## 必答问题

1. 会不会改变模型已见过的请求开头？
   不会。本次 diff 未触及 system prompt、tool definitions、历史消息、遮盖（redaction）或 prompt bundle；新增的 `capability.list/detail` 是 Control Center 的治理网关查询，不是模型上下文。没有新增每轮变化且进入前缀的字段，发给模型的内容仍可保持“只在末尾追加”。依据的规则文件本体未在仓库检出，无法逐字对照；以上是按代码改动范围得出的结论。

2. 会不会让同一段文字在不同请求里变成不同字节？
   不会（就模型输入而言）。新增的 `lastInvalidation` 是停用/撤销/卸载时写一次的持久值，详情原样读出；`dependencyTaskRefs` 由 `listCapabilityScheduledJobRefs` 的 `ORDER BY id` 加 `distinctSorted` 产生；`prod-read.sh` 的 `capabilities` 也是 `ORDER BY id LIMIT 200`。网关响应里原本就有每请求变化的 `generatedAt`，不是本次引入，也不进模型前缀。

3. 有没有对应的自动检查，反向用例真的会失败？
   部分有，但不足以覆盖生产失败路径。
   - 已覆盖：停用/退回缺最近认证会拒绝且状态不变；退回时快照缺目标版本、摘要不匹配会拒绝且状态不变；停用取消任务数为 2 并出现在详情；停用后依赖任务为空；`prod-read capabilities` 只读且不含 `record_json`。
   - 未覆盖/覆盖失真：退回成功测试的快照只含 `0.9.0`，而登记当前声明是 `1.0.0`，并且测试时钟只比 `checkedAt` 晚 1 秒；没有“当前版本在快照、目标版本不在快照”的真实形态，也没有“超过 5 分钟”的用例，因此高 1、高 2 不会被测试捕获。另有幂等重放绕过、暂停任务计数、跨 owner 范围隔离没有反向用例。
   - 另外，`production-capability-gateway.test.ts:408` 的标题是“previous version is not in the deployment snapshot”，但该用例实际用的是完全没有配置 `capabilityDeployment` 的 fixture，期望的是 `capability_deployment_not_configured`，标题与断言不一致。

4. 每个新增/修改的值，使用它的地方都能接受吗？
   - `lastInvalidation`：生产端只在 SQLite `invalidateCapabilityAuthority` 写；读取端为 `GovernanceGatewayV2ReadModel`、`capabilitySnapshotSchema` 和 Control Center。契约要求该键存在但可为 null，读取端用 `?? null` 兼容旧记录；类型与时间格式匹配。问题只在界面标签与撤销/卸载覆盖语义不一致（低 4）。
   - `listScheduledJobRefs`：端口新方法在 `durable-adapters.ts` 提供，SQL 同时按 `owner_id/agent_id` 过滤；消费端是生产网关的 `listTaskRefsByCapability`。两端范围一致。没有跨 owner 的反向测试。
   - `recentAuthenticationRef`：生产者是 Control Center 的两个命令分支和测试夹具；消费端是契约的必填 nullable 字段与 `RecentAuthenticationGuard`。控制中心已发送；旧客户端会因缺字段被契约拒绝（低 5）。
   - 操作名 `capability.list/detail/disable/rollback`：生产网关安装列表与 `routeOptions` 上报列表一致，Control Center 清单原本已声明这四个操作；未发现名称不一致。
   - `capabilityDeployment` 配置：`strict-configuration.ts` 只接受 `snapshotPath`/`sha256`，新消费方把这两个键直接传给加载器；正因为无法传 `maximumQualificationAgeMs`，高 2 的 5 分钟限制无法在配置层放宽。
   - 未核实：生产库实际 3 条 active 能力记录、生产 `capabilityDeployment` 快照的当前内容，以及旧 Control Center 静态资源缓存/发布顺序。以上均无线上数据或运行环境可查。
