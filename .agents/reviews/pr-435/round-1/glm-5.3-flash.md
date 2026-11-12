# PR 435 复核结论

## 主要发现（按严重度从高到低）

### 1.【中】gateway.v2 冻结合同新增必填字段，服务端与页面跨版本互不兼容
- 文件:行：packages/gateway-contracts/src/contracts-v2.ts:1910-1925、2345-2355；packages/gateway-contracts/src/validation.ts:174-184
- 问题（读代码证实）：`capability.disable` / `capability.rollback` 的 payload 新增 `recentAuthenticationRef: nullable(machineString)`，`capability.snapshot` 新增 `lastInvalidation`。本仓库的 `object()` 校验器对**每个声明字段都要求必须存在**（validation.ts:180 "missing required field"），且**拒绝未知字段**（validation.ts:174-176）。因此：新服务端 + 旧页面 → 旧页面发的 disable/rollback 缺 `recentAuthenticationRef`，报 `$.payload.recentAuthenticationRef: missing required field`（与事故 I-73 的「消息发不出去」是同类现象）；旧服务端 + 新页面 → 新页面多发的字段报 "unknown field"。两个方向都会让停用/退回在部署窗口期不可用。docs/architecture-v0.1.md:666 称 gateway.v2 是「冻结的产品契约」，本次是在冻结契约上就地加必填字段，没有 expand/contract 两步走。
- 建议：确认控制中心静态页面与服务端是同一构建原子部署（本仓库构建产物 manifest 一起出，若上线流程保证同步替换则风险可接受，此点未核实）；若不是原子部署，应把新字段先改为可选（不传 = 拒绝，校验放在服务端逻辑层），或按 Parallel Change 先发兼容版再收缩。

### 2.【中】生产退回（rollback）的成功路径无任何测试覆盖，快照不可读路径也无覆盖
- 文件:行：test/integration/production-capability-gateway.test.ts:141-151、263-328；apps/agent-service/src/production-capability-lifecycle.ts:32-77
- 问题（读代码证实）：该测试文件的 fixture 里 `configuration` 只有 `ownerId/agentId`，没有 `capabilityDeployment`，所以 `loader` 恒为 `undefined`，`entryFor` 恒返回 `NO_DEPLOYMENT`。两个 rollback 用例（“refuses rollback when there is no previous version"、“not in the deployment snapshot"）测的都是失败路径；`createProductionCapabilityLifecycle` 中「快照里有同引用同版本同摘要的条目 → 核验通过 → 退回成功」这条主线、以及 `SNAPSHOT_UNREADABLE`（快照读取抛错）分支，全仓库没有任何测试执行过。
- 另一处（读代码证实）：production-capability-lifecycle.ts:74 `runtime.qualify` 里 `throw new Error(reason)` 抛的是裸 Error 而非 `ApplicationPortError`。实际执行序列里 `artifacts.verify` 先于 `runtime.qualify`，条目缺失时 verify 已先抛 NOT_AUTHORITATIVE，所以这行接近死代码；但一旦未来调用顺序变化被触发，它会以非端口错误漏到 HTTP 层。
- 建议：给 fixture 加 `capabilityDeployment`（临时快照文件 + 摘要），补「rollback 成功」用例和「快照文件损坏/摘要不符」用例；`runtime.qualify` 的 throw 改为 `ApplicationPortError(NOT_AUTHORITATIVE, …)`。

### 3.【低】浏览器 e2e 的 mock 服务器不校验 disable/rollback 的最近认证
- 文件:行：test/e2e/fixtures/control-center-browser-server.mjs:1839-1843（对比同文件 1763-1767 approval.respond 有校验）
- 问题（读代码证实）：mock 对 `capability.disable` / `capability.rollback` 只做 revision 冲突检查，不检查 `recentAuthenticationRef`。也就是说浏览器 e2e 无法守住「UI 忘传/传错 ref」这类回归；这层防护目前只靠单元测试 `governance-interactions.unit.test.ts:281-292`（断言 payload 含 `recentAuthenticationRef: "recent-auth-01"`）。
- 建议：mock 里对这两个命令加与真实服务端一致的拒绝分支（ref 缺失/不匹配 → 403），让 e2e 也能反向失败。

### 4.【低】合同层 fail-closed 用例没有「disable 缺 recentAuthenticationRef」的反向项
- 文件:行：packages/gateway-contracts/test/gateway-v2.contract.test.ts:57-228
- 问题（读代码证实）：fail-closed 列表里有 `host.file.execute` 的 recent-auth 反向用例（:150-158），但没有 `capability.disable`/`capability.rollback` 缺该字段的用例。正向覆盖存在（governanceMessages fixture 已含新字段，roundtrip 测试会在字段被删时失败）。集成层反向用例是有的：test/integration/governance-control-center.test.ts:553-599（null 和他人 ref 都拒绝且状态不变）、production-capability-gateway.test.ts:207-246。所以这是覆盖层级缺口，不是无覆盖。
- 建议：在 gateway-v2.contract.test.ts 的 fail-closed 列表补两条缺字段用例。

### 5.【低】lastInvalidation 的计数与生命周期语义有两个小偏差
- 文件:行：packages/persistence-sqlite/src/sqlite-durable-operations.ts:2632-2655、2690-2694
- 问题（读代码证实）：a) 计数口径是 DB `status != 'revoked'`，而该列只有 active/paused/revoked（migrations/0001:317），所以**被 pause 的任务也会被计入 cancelledScheduledJobs** 并翻成 revoked；b) `lastInvalidation` 每次 invalidate 都整体覆盖：先 disable（记 disabled + N）再 revoke/uninstall 后，前面 disable 的记录被替换为最后一次的 lifecycle 与计数。schema 允许三种 lifecycle，UI 也能显示，行为本身自洽，但「取消个数看 lastInvalidation」只对最后一次生效。
- 建议：如需保留历史，改为列表或至少在文档注明「只保留最近一次」；文档写明 paused 任务计入。

### 6.【低】依赖任务读取的静默回退
- 文件:行：apps/agent-service/src/production-approval-gateway.ts:195-196
- 问题（读代码证实）：`listTaskRefsByCapability: async (capabilityRef) => (await capabilities.listScheduledJobRefs?.(capabilityRef)) ?? []` — 若 store 未实现该方法，详情页会静默显示空依赖任务而非报错。当前 sqlite store 已实现（durable-adapters.ts:428-430），但与旁边 `listTaskRefsByGrant: unsupported`（显式抛错）的风格不一致。
- 建议：方法缺失时显式抛 `PORT_INVALID_OPERATION`。

## 侧重检查

我走的最普通流程：Owner 打开控制中心 → Capabilities 页 → `capability.list` → 详情 `capability.detail`（后端经 `listScheduledJobRefs` 出 `dependencyTaskRefs`）→ 点「停用」（UI 门禁 governed-action.ts:34：destructive+critical 必须有 recentAuthenticationRef，缺失直接禁用按钮，不会发出）→ `capability.disable` 命令带 ref → HTTP `/api/gateway/v2/commands` → access policy（production-http-composition.ts:428-451，owner session 通用放行）→ 安装操作清单校验 → control plane 幂等收据（fingerprint 含 payload，换 ref 重放会 409）→ `#disableCapability` → **先** `assertRecentAuthentication`（governance-gateway-adapter.ts:981）→ `lifecycle.disable` → `invalidateCapabilityAuthority` 单事务（撤销句柄、数任务、存 lastInvalidation、取消任务）→ 审计 → 详情刷新显示 lastInvalidation 行和空依赖任务。

沿途无测试覆盖的代码路径：HTTP 路由到 gateway 的映射（共享通用分发器，仅 production-http-composition.unit.test.ts:367-373 断言操作清单）、上述 rollback 成功路径（发现 2）、e2e mock 的 recent-auth 分支（发现 3）。文档一致性：docs/architecture-v0.1.md:364/554 的新表述与代码逐条相符（只装四个操作、审查/批准/更新响应未装、依赖任务口径、退回条件）；i18n 三语新增条目有 i18n-runtime.unit.test.ts:48-66 的完整性门槛。

## 作者说法核对

- 「生产库实查 3 条能力记录，都是 active」——**未核实**（无生产访问手段）。
- 「停用原有事务同时撤销句柄、把 status != 'revoked' 的定时任务取消」——证实（sqlite-durable-operations.ts:2625-2680，本 PR 只是把 saveCapability 挪后并注入 lastInvalidation，事务仍原子）。
- 「退回以当前部署快照为依据：无同引用同版本同摘要条目即拒绝」——证实（production-capability-lifecycle.ts:41-77；loader 每次现读、SHA-256 校验、资格新鲜度在 parse 时把关，capability-deployment.ts:1425-1466）。
- 「契约新增字段」——证实，但注意均为**必填**（发现 1）。
- 「reactivate 不在范围、没改表结构、没改发给模型的内容」——证实（diff 无迁移文件、无 prompt/Thread 网关改动）。
- 「停用/退回最近认证在状态变化前、幂等重放不可绕过」——证实（:981/:1003 先于状态变化；重放路径仅当 revision 已 +1 且状态已是 disabled/rolled_back 时跳过检查，只作确认、不改状态；fingerprint 含 ref，同 key 换 ref 报 CONFLICT）。
- 「退回失败时状态不变」——证实（qualify 先行，失败即抛、无写入；测试断言 revision 保持 2）。
- 「新增存储读操作有 owner/agent 范围限制」——证实（store 按 (ownerId, agentId) 构造，durable-adapters.ts:425-427 闭包注入，SQL 再过滤 owner/agent/capabilityRef）。

## 必答问题

1. **发给模型的内容是否仍只在末尾追加？** 是。本 PR 改动全部在控制中心 Gateway v2、持久化、UI 与运维脚本；系统提示、工具定义、历史消息、遮盖结果、Thread v3 路径均未触碰（diff 文件清单证实）。注：任务里引用的 `.claude/rules/prompt-prefix.md` 在本仓库不存在（glob 无结果），该规则的原文内容**未核实**，结论是按代码事实独立得出的。
2. **同一段文字是否会变成不同字节？** 不会产生新的此类风险。`lastInvalidation.occurredAt` 是停用时刻落库的固定值，`cancelledScheduledJobs` 是落库计数，`dependencyTaskRefs` SQL `ORDER BY id` 确定性输出；UI 渲染的是存量数据。快照本身已有的 `generatedAt` 是既有行为，非本次引入。
3. **有无自动检查、反向用例会不会真失败？** 有，分层覆盖：合同正向 roundtrip（fixture 含新字段，删字段会挂）；集成层反向（缺/错 ref → 拒绝且状态不变，两套测试）；持久层（listScheduledJobRefs 正常/空、lastInvalidation 落库与计数）；运维脚本（只读、泄漏反向、多余参数 64 退出码）；composition 单测（操作清单）。缺口：rollback 成功路径与快照不可读无覆盖（发现 2）、e2e mock 不设防（发现 3）、合同层缺缺字段反向项（发现 4）。
4. **每个新值的产生端与使用端是否两端都校验？** 逐值核对：`PRODUCTION_CAPABILITY_OPERATIONS`（产生:67-72；使用:281、production-http-composition.ts:693，有单测钉住）✓；`recentAuthenticationRef`（产生:浏览器取自配置接口的 session.authenticationRef；两端校验:合同 machineString + 服务端与 authenticationRef 严格比对、还要 evidence/身份/会话绑定，UI 门禁防呆）✓；`lastInvalidation`（产生:同一事务；使用:读模型→schema→UI，持久层与生产集成测试两端钉住）✓；`reasons` 错误详情字段（capability-lifecycle-service.ts:654 新增）目前仅测试断言用到，HTTP 层是否透传给客户端未核实，属低风险；`prod-read capabilities` 查询（metadata only，测试断言不吐 record_json/secret）✓。
