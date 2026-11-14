# PR 435 复核结论

## 一、读代码证实的问题（按严重度）

### 1. 严重度：中高（功能/一致性）— 生产退回核验与部署快照“同一 ref 只能有一个版本”冲突
- 位置：`apps/agent-service/src/production-capability-lifecycle.ts:44-50`、`packages/platform-node/src/capabilities/capability-deployment.ts:1203-1212`
- 问题：退回要求“上一版”的 `ref/version/integrity` 出现在当前部署快照里；但快照加载器明确禁止同一 `ref` 出现两个版本。若生产快照按当前部署版本维护（通常只含当前版本），上一版不可能同时存在，退回成功路径实际不可达。
- 证据：
  - `production-capability-lifecycle.ts:44-49`：
    ```ts
    const entry = loaded.snapshot.capabilities.find(
      ({ manifest: candidate }) =>
        candidate.ref === manifest.ref &&
        candidate.version === manifest.version &&
        candidate.integrity === manifest.integrity,
    );
    ```
  - `capability-deployment.ts:1204-1212`：
    ```ts
    if (
      new Set(refs).size !== refs.length ||
      new Set(capabilities.map((entry) => entry.manifest.ref)).size !== capabilities.length
    ) {
      throw failure(
        CAPABILITY_DEPLOYMENT_ERROR_CODES.DUPLICATE_CAPABILITY,
        "snapshot.capabilities",
        "must not contain duplicate identities",
      );
    }
    ```
- 建议：确认生产部署快照是否允许/实际保留旧版本，并为“生产 lifecycle + 真实快照”补一条成功退回用例；否则应把“上一版仍在当前部署快照”改成可实际维护的规则（例如单独的 rollback artifact 记录），或明确退回在生产不可用。
  “快照通常只含当前版本”属于推测，需运维确认；快照禁止同 ref 多版本是读代码证实的。

### 2. 严重度：中 — “不在部署快照”的测试实际测的是“未配置部署快照”
- 位置：`test/integration/production-capability-gateway.test.ts:151-155`、`277-323`
- 问题：用例名和提交说明都说“上一版不在部署快照里”，但 fixture 传给 `createProductionCapabilityLifecycle` 的 configuration 没有 `capabilityDeployment`，实际走的是 `NO_DEPLOYMENT` 分支；`NOT_IN_DEPLOYMENT` 和 `SNAPSHOT_UNREADABLE` 分支完全没有测试。
- 证据：
  - `production-capability-gateway.test.ts:151-155`：
    ```ts
    capabilityLifecycle: createProductionCapabilityLifecycle({
      configuration: { ownerId: OWNER_ID, agentId: AGENT_ID },
      repository,
      clock,
    }),
    ```
  - `production-capability-gateway.test.ts:320-323`：
    ```ts
    ).rejects.toMatchObject({
      code: PORT_ERROR_CODES.NOT_AUTHORITATIVE,
      details: { reasons: "capability_deployment_not_configured" },
    });
    ```
- 建议：在 fixture 中写入真实快照文件与 sha256，分别覆盖“快照无此条目”“快照读不到/摘要不匹配”“成功核验”三条路径。当前 `production-capability-lifecycle.ts:15-16` 里 `NOT_IN_DEPLOYMENT`、`SNAPSHOT_UNREADABLE` 全仓库只在实现处出现，没有任何测试。

### 3. 严重度：中 — 退回缺少“最近认证缺失/不匹配”的反向用例
- 位置：`packages/application/src/services/governance-gateway-adapter.ts:1003`；测试仅覆盖停用，见 `test/integration/governance-control-center.test.ts:559-599`
- 问题：停用有“无匹配最近认证则状态不变”的反向用例，退回没有。把 `#assertRecentAuthentication` 从退回路径删掉，现有测试不会失败。
- 证据：
  - `governance-gateway-adapter.ts:1003`：
    ```ts
    await this.#assertRecentAuthentication(authentication, command.payload.recentAuthenticationRef);
    ```
  - `governance-control-center.test.ts:559` 的用例只针对 `capability.disable`；`production-capability-gateway.test.ts:253` 的退回用例用的是合法认证。
- 建议：补“退回时 `recentAuthenticationRef` 为 null/不匹配 -> NOT_AUTHORITATIVE 且 revision/lifecycle 不变”，并补一个“幂等重放已完成后不重复要求认证但只返回已提交结果”的用例。

### 4. 严重度：中低 — `recentAuthenticationRef` 设为必填 nullable，旧客户端不兼容；且重认证后重试会撞幂等指纹
- 位置：`packages/gateway-contracts/src/contracts-v2.ts:1907-1925`、`packages/gateway-contracts/src/validation.ts:174-184`、`apps/control-center/src/governance-control-center.tsx:668-685,795-813`
- 问题：
  1. `object()` 严格校验未知字段且要求所有字段存在，因此旧版控制中心/旧标签页省略 `recentAuthenticationRef` 会直接契约失败，而不是按 `null` 处理。
  2. 该字段进入命令语义指纹（`#fingerprint` 包含 `payload`）。控制中心在非 409 失败时不清 pending 幂等键；如果停用/退回因最近认证失败，用户重新认证后拿到新的 `recentAuthenticationRef` 再用同一 idempotencyKey 重试，会因指纹不同得到 CONFLICT。
- 证据：
  - `contracts-v2.ts:1913` / `1923`：
    ```ts
    recentAuthenticationRef: nullable(machineString),
    ```
  - `validation.ts:179-180`：
    ```ts
    for (const key of expectedKeys) {
      if (!Object.hasOwn(record, key)) fail(`${path}.${key}`, "missing required field");
    ```
  - `governance-control-center.tsx:669`：
    ```ts
    const idempotencyKey = pending?.idempotencyKey ?? `governance:${crypto.randomUUID()}`;
    ```
  - `governance-control-center.tsx:799-813`：只有 409 才清理 pending，其他错误保留。
- 建议：契约解析对 `recentAuthenticationRef` 做“缺省视为 null”的兼容；最近认证失败（403）时清掉 pending，或让 UI 在 `recentAuthenticationRef` 变化时换新幂等键。

### 5. 严重度：低 — 内存测试替身未实现 `lastInvalidation` / `listScheduledJobRefs`
- 位置：`packages/testing/src/in-memory/capabilities.ts:119-127`
- 问题：内存 store 的 `invalidateCapabilityAuthority` 只保存记录和撤销句柄，不统计任务、不写 `lastInvalidation`，也没有 `listScheduledJobRefs`。使用该替身的治理集成测试（如 `test/integration/governance-control-center.test.ts:204`）不会覆盖新行为，测试替身与生产 SQLite 语义不一致。
- 证据：
  ```ts
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
- 建议：同步实现计数与 `lastInvalidation`（哪怕只对内存任务表计数），并让治理集成测试也跑一遍该路径。

### 6. 严重度：低 — `prod-read.sh capabilities` 的说明与查询不一致，且未按 owner/agent 限定
- 位置：`scripts/operations/prod-read.sh:26`、`95-100`
- 问题：usage 写“newest 200”，实际 `ORDER BY c.id`；`capability_declarations` 没有时间列，无法按“最新”排序。查询还没有 owner/agent 过滤，`handle_count` 统计的是全部句柄（包括已撤销）。若生产库不是严格单 owner，会跨租户输出元数据。
- 证据：
  - `prod-read.sh:26`：
    ```sh
    capabilities                metadata (no declaration body) of the registered capabilities, newest 200, with handle count
    ```
  - `prod-read.sh:98-100`：
    ```sh
    "SELECT c.id, c.status, c.revision, c.version, " +
      "(SELECT count(*) FROM capability_handles h WHERE h.capability_id = c.id) AS handle_count " +
      "FROM capability_declarations c ORDER BY c.id LIMIT 200",
    ```
- 建议：把说明改成“按 id 前 200 条”，或加时间字段后按时间排序；明确是否要求 owner/agent 过滤；`handle_count` 改成只统计 active 或分列 active/revoked。

### 7. 严重度：低 — 幂等重放快路径跳过最近认证，且不核对原因/目标版本
- 位置：`packages/application/src/services/governance-gateway-adapter.ts:973-980`、`994-1002`
- 问题：重放快路径在最近认证检查之前返回成功。它只在 `revision === expectedRevision + 1` 且状态已匹配时触发，因此不会产生新的状态变化，不构成“绕过认证去停用/退回”；但它没有核对 `reasonCode`，退回也没有核对 `lastVersionTransition` 的 from/to 版本。如果状态是被另一条命令改到这个 revision，旧命令的重试会被当成成功并记审计。
- 证据：
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
  （退回处同理，只检查 `outcome === "rolled_back"`）
- 建议：重放条件补上 `lastInvalidation.lifecycle`/reason 或 `lastVersionTransition` 的目标版本；或明确接受“重放只认 revision+状态”的语义并写进测试。

## 二、推测 / 需确认

- 生产库“3 条能力记录、都是 active”：未核实（本次不允许连库）。
- 生产部署快照是否真的只含当前版本、以及这些记录是否有 `rollbackDeclaration`：未核实。若能确认快照保留旧版本，则问题 1 的严重度下降。
- 生产是否可能存在旧版控制中心标签页跨发布继续使用：推测存在，因此问题 4 的实际影响取决于发布方式。
- `listScheduledJobRefs` 没有 LIMIT，若单个能力名下非 cancelled 定时任务很多，详情查询和内存排序会随数量增长；属于潜在资源消耗，未做压力验证。
- 生产 artifact 核验把“安装包核验”降为“条目在摘要校验过的部署快照中”，并未独立校验 manifest 的签名/内容，仅以 `ref/version/integrity` 匹配。这与作者说法一致，但安全强度取决于部署快照的生成与保护流程。

## 三、侧重检查

- **最近认证/绕过路径：** 停用和退回的 `#assertRecentAuthentication` 都在 `lifecycle.disable/rollback` 状态变化之前。真实 `RecentAuthenticationGuard` 会校验 `expectedAuthenticationRef === authentication.authenticationRef`、证据会话/owner/device 绑定和时效；配置接口只在 guard 通过时才下发 ref（`http-gateway-server.ts:945-953`）。未发现可让“状态发生新变化”的绕过。重放路径只在状态已是 `expectedRevision+1` 后跳过认证，不产生新状态变化；但存在问题 7 的审计归属缺口。
- **不可信输入/契约：** 命令 schema 严格、`machineString`/`timestamp`/`integer` 校验明确；SQL 全部参数化；`json_extract` 仅用于匹配。未发现注入或类型混淆。新增字段的必填问题是兼容性问题，不是注入问题。
- **范围（owner/agent）：** `listScheduledJobRefs` 经 durable adapter 传入 `ownerId/agentId`，SQL 也按 owner/agent 过滤（`sqlite-durable-operations.ts:2687-2695`），生产读路径有范围限制。`prod-read.sh` 的 capabilities 查询没有 owner/agent 过滤（见问题 6）。
- **资源耗尽：** `listScheduledJobRefs` 无 LIMIT；回退会两次调用 `loader.load()`（`artifacts.verify` 一次、`runtime.qualify` 一次），每次读整份快照并计算摘要。未发现无界循环或递归；风险主要是任务数量增长。
- **不可逆操作：** 停用在同一个 `transaction.immediate()` 里撤销句柄、统计并取消任务、保存 `lastInvalidation`，失败会整体回滚；被取消任务设置 `status='revoked'`、`next_occurrence_at=NULL`，UI 文案明确“不会自动恢复”。没有 reactivate 路径，符合本 PR 范围。
- **规则/文档/代码一致性：**
  - `docs/architecture-v0.1.md` 的生产安装清单与实现一致。
  - 提交说明“上一版不在部署快照里”的测试名不副实（问题 2）。
  - `prod-read.sh` 的 “newest 200” 与 `ORDER BY c.id` 不一致（问题 6）。
  - 内存 store 与 SQLite store 的新行为不一致（问题 5）。
  - 未修改 prompt-catalog、系统提示、工具定义或历史消息代码。

## 四、必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？**
不会。改动只涉及 governance gateway v2 的 control-plane/read model、SQLite 持久化、控制中心 UI/i18n 和 ops 脚本；没有改 `packages/prompt-catalog`、运行时提示词、工具定义、历史消息或遮盖代码。`PRODUCTION_CAPABILITY_OPERATIONS` 进入的是控制中心/网关的 `installedOperations`（`http-gateway-server.ts:965`），不是模型工具；`lastInvalidation` 只出现在 `capability.snapshot`。发给模型的内容仍只在末尾追加，未新增每轮变化的值。未核实：生产部署快照是否会被本 PR 之外的外部流程改写；本 PR 的停用/退回代码不会改部署快照文件。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
对模型请求不会。新增的 `lastInvalidation.occurredAt` 是时间字段，但只在控制中心读取的 `capability.snapshot` 中，且停用后固定；`generatedAt` 在改动前就存在。`listScheduledJobRefs` 使用 `ORDER BY id`，读模型又经过 `distinctSorted`，顺序确定。`recentAuthenticationRef` 是会话值并进入命令指纹，但不进入模型 prompt。如果将来把 `capability.snapshot` 拼进模型上下文，这些时间字段会破坏确定性；目前没有这样的代码。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**
部分有：
- 会失败的反向用例：停用无匹配最近认证且状态不变（`governance-control-center.test.ts:559`、`production-capability-gateway.test.ts:208`）；停用计数与 `lastInvalidation` 持久化（`sqlite-durable-repositories.test.ts:794-812`）；停用后依赖任务为空（`production-capability-gateway.test.ts`）；无上一版时退回被拒且状态不变。
- 不够或名不副实：
  - 退回缺少“最近认证缺失/不匹配”的反向用例，删掉退回的认证检查不会失败（问题 3）。
  - “上一版不在部署快照里”的用例实际测的是“未配置部署快照”；`NOT_IN_DEPLOYMENT`、`SNAPSHOT_UNREADABLE` 没有测试（问题 2）。
  - 生产 lifecycle 没有“成功退回/成功核验”的用例；`createProductionCapabilityLifecycle` 只在一个没有 `capabilityDeployment` 的 fixture 中被调用。
  - 没有跨 owner/agent 的 `listScheduledJobRefs` 隔离测试。
  - 控制中心没有非空 `lastInvalidation` 的显示测试；e2e fixture 停用后仍保持 `null`。
  - 幂等重放“已完成/执行中”与最近认证的组合没有专门测试。

**4. 改动产生或修改的每个值，使用它的地方都能接受吗？**
逐个核对结果：
- `recentAuthenticationRef`（disable/rollback payload）：产生于控制中心配置（`governance-control-center.tsx:770,783`），由严格契约接收（`contracts-v2.ts:1913,1923`），服务端 guard 只接受与当前 `authentication.authenticationRef` 相同且证据有效的值。仓库内所有生产者已更新；但旧客户端省略该字段会被严格 `object()` 判为 missing（问题 4），且它进入幂等指纹会导致重认证后的同 key 重试冲突。
- `lastInvalidation` / `cancelledScheduledJobs` / `occurredAt`：由 SQLite `invalidateCapabilityAuthority` 写入，读模型映射为 `null` 或原值，契约要求 nullable 的 enum/integer/timestamp，控制中心按 count/time 展示；旧记录缺字段时 `?? null` 可接受。生产 SQLite 两端一致；内存测试替身不产生该值（问题 5）。
- `listScheduledJobRefs`：产生于 durable adapter，SQL 按 owner/agent/capabilityRef 过滤，消费方是 gateway read model；可选方法缺失时回退 `[]`。生产范围正确，但没有跨 owner 测试。
- `PRODUCTION_CAPABILITY_OPERATIONS`：生产网关安装清单与控制中心配置清单同时加入，二者一致。
- 错误详情 `reasons`：由 `CapabilityLifecycleService.qualify` 产生，测试按精确字符串断言，HTTP 错误详情可序列化，接受。
- `capabilities` prod-read 查询：产出 id/status/revision/version/handle_count；说明写“newest 200”但实际按 id 排序、未按 owner/agent 过滤（问题 6）。
- `capabilityDeployment` 作为回退核验依据：消费方 `CapabilityDeploymentSnapshotLoader` 接受该配置，但与“同 ref 多版本”约束冲突（问题 1）。
