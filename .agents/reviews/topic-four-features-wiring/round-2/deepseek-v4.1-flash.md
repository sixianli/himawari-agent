## 结论先说

这份方案的方向比“只装读取那一半”更接近根因，但仍有 3 个阻断性问题：B 的“重新启用再走现成激活”拿不到面容，且失败后不一定停在“已停用”；B 要装的 `capability.detail` 在生产网关里被 `unsupported` 依赖直接打断；C 的“改了几个文件”定义无法用现有改动记录算出来。另外，“操作名三处缺一失败”的自动检查并不存在。

---

## 一、证实的（按严重度）

### 1. 阻断：B 的“重新启用”不满足“面容 + 失败保持停用”

**问题**：方案说“从已停用回到待批准安装，再走现成的激活”，并说“批准这一步正好是面容和回执挂的地方”。但现成的 `capability.install.approve` 根本没有 `recentAuthenticationRef`，服务端也没有最近认证检查。审批流只有 `approval.respond` 会调 `#assertRecentAuthentication`。因此：
- 重新启用后，`capability.install.approve` 可以不带面容直接激活；
- 如果激活时 `qualify` 失败，记录通常已从 `disabled` 走到 `installation_proposed` 或 `installation_approved`，并不会“保持停用”；
- `activate` 只允许从 `installation_approved` 进入，方案若只调 `activate` 也会直接拒绝。

**证据**：
- `packages/gateway-contracts/src/contracts-v2.ts:1694-1701`：`capability.install.approve` 的 payload 只有 `capabilityRef`、`expectedRevision`、`approvalRef`，没有最近认证引用。
- `packages/application/src/services/governance-gateway-adapter.ts:885-914`：`#approveCapabilityInstallation` 直接 `approveInstallation` 然后 `activate`，没有 `#assertRecentAuthentication`。
- `packages/application/src/services/capability-lifecycle-service.ts:392-426`：`approveInstallation` 要求 `installation_proposed`，`activate` 要求 `installation_approved`，`qualify` 失败会抛错，已完成的 `save` 不会回滚到 `disabled`。
- `packages/gateway-contracts/src/contracts-v2.ts:1726-1742` 与 `governance-gateway-adapter.ts:967-1004`：`capability.disable`、`capability.rollback` 也没有服务端最近认证检查。

**建议**：不要复用两步审批。新增一个原子的 `capability.reactivate` 命令，payload 带 `capabilityRef`、`expectedRevision`、`recentAuthenticationRef`、`reasonCode`；服务端先 `assertRecentAuthentication`，再重新核对 artifact 摘要和运行环境资格，**全部通过后才把 `disabled` 直接写成 `active`**，任何一步失败都不改状态。不要恢复旧句柄和定时任务。若坚持两步，则必须给 `capability.install.approve` 增加最近认证字段和检查，并记录“这次是从 disabled 来的”以便失败回退。

### 2. 阻断：B 要装的 `capability.detail` 在生产网关里必然失败

**问题**：方案说“先把现成的能力列表、详情装进生产”。列表可以，详情不行：`capability.detail` 的读模型会调用 `listTaskRefsByCapability`，而生产网关明确把它和 `listTaskRefsByGrant` 设成 `unsupported`。一旦安装 `capability.detail`，每次详情查询都会抛错。方案没有提到要补这个依赖，也没有提到构造 `CapabilityLifecycleService` 及其 `artifacts`、`runtime` 两个端口。

**证据**：
- `apps/agent-service/src/production-approval-gateway.ts:179-180`：`listTaskRefsByCapability: unsupported`、`listTaskRefsByGrant: unsupported`。
- 同文件 `:90-95`：`unsupported` 直接抛 `Gateway operation is not installed`。
- `packages/application/src/services/governance-gateway-adapter.ts:411-421`：`capability.detail` 调 `listTaskRefsByCapability`。
- `packages/application/src/services/capability-lifecycle-service.ts:330-343`：生命周期服务需要 `store`、`clock`、`artifacts`、`runtime`；`apps/agent-service` 下没有构造。

**建议**：先实现生产可用的 `listTaskRefsByCapability`（从 `scheduled_jobs` / handle 查询）或把该字段从快照里移除并明确返回空；同时把 `CapabilityLifecycleService`、`FileCapabilityArtifactVerifier`、`NodeCapabilityRuntimeQualifier` 接进生产组装。给 `capability.list/detail/disable/rollback` 加一条经真实 HTTP 入口的冒烟测试，而不是只测服务类。

### 3. 阻断：C 的“改了几个文件”定义无法由现有改动记录计算

**问题**：方案定义“内容和当时不同的文件去重后的个数”，并要求“删掉后又恢复原样的不算”。但 ADR 0097 的改动记录只给 `before` 存了大小和修改时间，`after` 才存 `sha256`；第一次命令的基线快照也没有内容摘要。因此无法判断“恢复后的内容是否等于最初内容”，只能知道“某条命令改了它”。这个计数不是实现细节，而是当前数据模型算不出来。

**证据**：
- `apps/agent-service/src/production-workspace-ledger.ts:17-29`：`WorkspaceFingerprint` 的 `before` 只有 `size`、`modifiedAtNs`；`after` 才有可选的 `sha256`。
- 同文件 `:102-122`：`before` 构造时没有 `sha256`，`after` 才计算 `sha256`。
- `packages/application/src/ports/host-files.ts:306-317`：`HostWorkspaceSnapshotEntry` 只有 size、modifiedAtNs、inode，没有内容摘要。
- `docs/adr/0097-bash-writes-workspace-with-change-ledger.md:43-49`：只记录前后大小/时间和改动后的指纹。

**建议**：三选一，并在方案里写清：
1. 给 `before` 也记录 `sha256`，或在第一条命令时存一份“基线摘要表”；
2. 第一版把定义改成“这些命令报告改动过的文件并集”，并明确删掉又恢复也算改过；
3. 读取时重新扫描并计算当前内容，但这会随文件变化，不能保证同一段文字在不同请求里字节相同，也会带来性能问题。
同时必须处理 `complete: false`（扫描不完整）和并发命令互相记到对方改动的问题，不能显示一个看似精确的 N。

### 4. 高：C 只记录 `bash`，会漏掉 `write` / `edit` 的改动

**问题**：方案说“这个文件夹的改动”按“每条命令改动记录”来，但生产只对 `bash` 做目录前后对比；`write`、`edit` 的改动只进 `thread-artifacts`，不进 workspace ledger。一个只使用 `write/edit` 的对话会显示“没改”，但文件实际变了。若界面叫“这个文件夹的改动”，这是错误信息。

**证据**：
- `apps/agent-service/src/production-coding-workflow.ts:558-561`：只有 `tool === "bash" && grant !== null && !binding.workspaceCopy` 才用 ledger。
- 同文件 `:633-648`：`write/edit` 只调 `recordThreadArtifacts`，不走 `ledger.record`。
- `docs/adr/0097-bash-writes-workspace-with-change-ledger.md:43`：只对 `bash` 留档。

**建议**：第一版要么把 `write/edit`（以及 `move_directory`、`save_copy` 中会改工作目录的操作）也纳入读模型，要么把功能明确命名为“bash 命令改动”，并在界面说明“文件卡片里可能还有 write/edit 的改动”。加一条只用 `write/edit` 的测试。

### 5. 高：A 的“不要”和“待采纳列表”没有落到契约、路由和消费端，且现有 else 分支有误删风险

**问题**：方案只说“新增一张表、读操作、另加‘不要’”，但没说清契约怎么变。当前 `memory.rule.respond` 的 `action` 只有 `undo | confirm | reconfirm`，`memory.rules.snapshot` 的 `status` 只有 `active | needs_review`。更危险的是：`production-memory-control.ts` 对非 `confirm/reconfirm` 一律走 `undo(target)`。如果先改契约允许 `"reject"`、后端分支没同步，客户端发 `action:"reject", target:"owner:..."` 会把规则撤销，而不是“拒绝提议”。

**证据**：
- `packages/gateway-contracts/src/contracts-v2.ts:1449`：`OWNER_RULE_ACTIONS = ["undo", "confirm", "reconfirm"]`。
- 同文件 `:1454-1476`：规则列表 `status` 只允许 `active | needs_review`，`memory.rule.respond` 的 `action` 枚举只有三项。
- `apps/agent-service/src/production-memory-control.ts:1182-1190`：`action === "confirm" ? ... : action === "reconfirm" ? ... : (await control.undo(target)).ruleId`。
- `apps/control-center/src/memory.ts:17-27`：`OwnerRuleAction` 也只有三项。

**建议**：明确写出契约增量。建议新增独立的 `memory.rule.proposals.read` + `memory.rule.proposals.snapshot`（不要污染现有 `memory.rules.snapshot` 的 `status` 枚举），并在 `memory.rule.respond` 增加 `"reject"` 的显式分支；同步 `OwnerRuleAction`、UI、i18n、fixture、契约测试。禁止把 `reject` 落入 `undo`。新增操作必须同时改 `GATEWAY_V2_MESSAGE_TYPES`、`PRODUCTION_MEMORY_OPERATIONS`、`production-memory-control` 路由和 `check-operations` 的待办清单。

### 6. 高：A 的“主人原话”可能是模型推断的，且新表存储需要保护/限额/删除策略

**问题**：方案说“看依据显示提议产生那一刻存下的原话”。但提议允许 `inferred: true`，`quote` 只是模型填写的文本；只有显式激活路径才用 `#ownerSaid` 校验它是否真的出现在主人最近的对话里，提议路径没有。把模型写的 quote 显示成“主人原话”会误导主人。其次，新表要存 quote 和回放数据（含邮件主题、发件人、messageId）；现有提议走 `protect()` + `classificationWithIdentifiers`，新表若直接存明文会绕过保护。最后，模型可以反复调用 `rule_set` 产生提议，现有代码只限制“生效规则 32 条”，没有限制提议数量和过期。

**证据**：
- `apps/agent-service/src/production-owner-rules.ts:599-606`：只有 `SOFT_TYPE` 才校验 `#ownerSaid`；`:637-639` 只有显式规则才校验 `#ownerSaid`。
- 同文件 `:394-409`：现有提议用 `protector.protect` 和 `classificationWithIdentifiers` 存储。
- 同文件 `:514-515`：只有 `ACTIVE_RULE_LIMIT = 32`，没有提议上限或过期。
- `packages/gateway-contracts/src/contracts-v2.ts` 的 `RuleReplay` 相关字段（现有 `OwnerRuleReplayResult`）含邮件元数据。

**建议**：给提议增加 `quoteSource: "owner" | "model_inferred"`，界面分别显示“主人原话”或“Himawari 从对话推断”；或者提议阶段也校验 quote 是否出现在来源对话里，做不到就不叫原话。quote 和 replay 必须走受保护 payload，表里只存 payload ref；给每个 owner/对话设置提议数量上限和过期/清理策略；定义来源对话或邮件被删除时 quote/replay 的删除/脱敏行为；迁移时说明已有提议 payload 的兼容处理。

### 7. 高：方案声称的“操作名三处缺一失败”并不存在

**问题**：方案把“手机用到的每个操作名同时在契约、已安装清单、路由三处，缺一处测试失败”列为自动检查。但现有 `scripts/check-operations.mjs` 只检查：契约里的操作有后端实现、前端调用方、测试；已安装清单里的名字在契约里。它**不检查**前端用到的操作是否真的进了已安装清单，也不检查路由/控制中心 inventory。因此 A 新增读操作、B 新增重新启用命令、C 新增文件夹改动读操作时，漏加已安装清单或路由不会被它拦住。

**证据**：
- `scripts/check-operations.mjs:201-227`：逐操作检查 `backendTexts`、`frontendTexts`、`testTexts`；最后只检查 `list.names` 是否在 `contractNames`，方向是“已安装清单 → 契约”。
- `test/tooling/operations-check.test.mjs` 没有“前端使用但未安装”的反向用例。
- `package.json` 的 `check:operations` 只运行这个脚本和它的测试。

**建议**：扩展 `check-operations.mjs`：
- 从 `CONTROL_CENTER_SURFACE_INVENTORY` 和手机实际发送的操作名里收集“使用方”；要求每个都被某个 `PRODUCTION_*_OPERATIONS` 包含，或在 `ci/operations-pending.json` 里有理由；
- 要求每个已安装操作在 `AgentGatewayV2Service` / `GovernanceGatewayV2ControlPlane` 的 `delegate`/`isGovernanceCommand`/read model 中有实际路由，而不是只在源码里出现一次字符串；
- 增加反向 fixture：前端新增操作但已安装清单没加、已安装清单加了但路由没加，都必须报错。
这正好是 I-73 的教训：不能只看 diff，要让“清单里的值”走一遍真正的消费者。

### 8. 高：C 的“主机显示名”没有写入口、没有契约暴露，可能被误用进模型提示

**问题**：方案说“授权目录上加一个由主人起的名字字段；没起名就显示路径”。但现有 `HostDirectoryGrant` 没有这个字段，`host.directory.snapshot` 也不返回它，生产也没有“设置目录名字”的命令。方案没有说明谁写、写到哪里、界面从哪里读。另一个风险是：如果为了“它会显示名字”而把 displayName 塞进运行环境说明，它就会进入最后一条消息；这本身允许，但必须只在最后消息、只在变化时追加，且不能进系统提示或工具定义。

**证据**：
- `packages/application/src/ports/host-files.ts:26-40`：`HostDirectoryGrant` 只有 `hostId`、`displayPath` 等，没有 displayName。
- `packages/gateway-contracts/src/contracts-v2.ts:2212-2230`：`host.directory.snapshot` 只返回 `displayPath`。
- `packages/application/src/services/host-workspace-gateway-adapter.ts:716-744`：目录详情只映射 `displayPath`。
- `apps/agent-service/src/production-run-policy.ts:241-265`：模型可见的 `workspaceRoot` 仍取 `grant.displayPath`。

**建议**：新增一个 owner-only、受作用域校验的命令（例如 `host.directory.rename`）和契约字段，把 displayName 限制为短文本、无控制字符，只作为 UI 标签，不参与路径、权限、哈希或模型工具输入；如果确实要进模型可见的运行环境说明，按 ADR 0164 只放在最后一条消息，并附“改名会追加新块、不改系统提示”的 prompt-prefix 测试。

### 9. 中：B 的停用/回滚是近似不可逆操作，但服务端没有面容；N 的来源也没定义

**问题**：方案只要求“重新启用要面容”。但停用会撤销句柄、取消定时任务，而且方案明确说“一律不恢复”；回滚也只切换版本，`externalEffectsRolledBack: false`、`productStateRolledBack: false`。这些是实际上的不可逆/半不可逆操作，服务端却没有最近认证检查。控制中心虽然在 `governed-action.ts` 里对 destructive 动作要求 `recentAuthenticationRef`，但 `executeAction` 对 `capability.disable/rollback` 没有把该引用放进命令 payload，服务端也无法验证。
另外，“回执写明有 N 个定时任务仍是取消状态”没有现成字段：`invalidateCapabilityAuthority` 只返回 capability record，`capability.snapshot` 的 `dependencyTaskRefs` 也不含“本次取消的 N”。

**证据**：
- `apps/control-center/src/accessibility/governed-action.ts:34-35`：destructive 动作要求 `recentAuthenticationRef`。
- `apps/control-center/src/governance-control-center.tsx:751-773`：`capability.disable`、`capability.rollback` 的 payload 没有 `recentAuthenticationRef`。
- `packages/application/src/services/governance-gateway-adapter.ts:967-1004`：停用/回滚没有最近认证检查。
- `packages/application/src/services/capability-lifecycle-service.ts:597-618`：回滚明确写 `externalEffectsRolledBack: false`、`productStateRolledBack: false`。
- `packages/persistence-sqlite/src/sqlite-durable-operations.ts:2605-2653`：停用会撤销句柄并更新 `scheduled_jobs`，但只返回 record。

**建议**：给停用/回滚也加服务端最近认证和明确的不可逆提示；在停用事务里统计“本次从非 revoked 变成 revoked 的 job 数”，通过 `capability.snapshot` 或 command receipt 的 payload 暴露出来，定义为“本次停用取消的定时任务数”，不要用事后全表计数。回滚界面要显示 `externalEffectsRolledBack: false` 的警告。

### 10. 中：A 的提议 ID 是内容哈希，拒绝后再次提议会发生碰撞/状态歧义

**问题**：提议 ID 由 `ownerId + type + params + summary + quote` 哈希得到，且 `#writeText` 在 payload 已存在时不覆盖。若主人拒绝后，模型再次提出同样的规则（同一对话或新对话），会得到同一个 proposal ID；新表如果按 ID 插入会冲突，如果复用旧行则可能仍是“已拒绝”，导致主人永远看不到这次新提议。方案没有定义“再次提议”的语义。

**证据**：
- `apps/agent-service/src/production-owner-rules.ts:645-653`：proposal ID 是内容哈希。
- 同文件 `:394-409`：`#writeText` 只在 payload 不存在时写入。
- 同文件 `:669-675`：`confirm` 只按 ID 读 payload。

**建议**：明确二选一：
- ID 加一个非内容相关的 nonce/generation，让同一内容可以产生新提议；或
- 保留确定性 ID，但“再次提议”时原子地把已拒绝行重置为 `proposed`，并保留审计历史。
加测试：拒绝后再次提议可见；确认后再次提议不会重复生效；并发 confirm/reject 只有一个赢家。

### 11. 中：文档、控制中心 inventory 和代码会不一致

**问题**：方案 B/C 会把能力、文件夹改动接进生产，但仓库文档仍写着“当前正式 Gateway v2 只安装 approval.list/detail/respond”，控制中心 `improvements` surface 仍声明 `improvement.list/detail/review`，而 A 却把“待采纳的改进”接到规则提议上。方案没有列出这些文档/inventory 更新，合并后会出现“文档说没装、代码已装”或“页面声明 improvement.*、实际用 memory.rule.*”的不一致。

**证据**：
- `docs/architecture-v0.1.md:554`：当前正式 Gateway v2 只安装 `approval.list/detail/respond`。
- `docs/runbooks/install-start-stop-runbook.md:369`：其他 13 个页面应显示“未启用”。
- `apps/control-center/src/app/control-center-inventory.ts:342-356`：`improvements` surface 的 queries/mutations 是 `improvement.list/detail/review`。
- `apps/control-center/src/app/control-center-inventory.ts:213-224`：`capabilities-adapters` 已声明 `capability.list/detail/disable/rollback`，但生产未安装。

**建议**：把文档更新列为每块任务的完成条件：`docs/architecture-v0.1.md`、相关 runbook、control-center inventory、ADR、`docs/incidents-and-gates.md`（若新增门槛）。A 要么复用 `improvements` surface 并改其声明的操作，要么新增一个明确的“待采纳规则”surface，不要保留两个语义不同的 `improvements`。

### 12. 中：E 的“手机能看、能取消”只说了服务，没有网关命令和读模型接线

**问题**：`DelegationService` 和 `DurableDelegationStateAdapter` 确实存在，`DelegationService.cancel` 也存在，但网关只有 `delegation.list/detail` 查询契约，没有取消命令；生产 approval gateway 也没有接 autonomy read model。方案说“装现成的 DelegationService”，但没说要构造 `DelegationService`、`DurableDelegationStateAdapter`、`WorkerRunPort`、`WorkerResultReader`、`DelegationHandleLifecyclePort`、`DelegationProposalPort`，也没说把 `delegation.list/detail` 装进生产读模型。另外，方案说“每个子任务有时间和费用上限”，但没定义总预算、并发上限和子任务数量上限。

**证据**：
- `packages/gateway-contracts/src/contracts-v2.ts:1959-1972`：只有 `delegation.detail/list`，没有 cancel。
- `packages/application/src/services/delegation-service.ts:280-293`：有 `cancel`。
- `apps/agent-service/src/production-runtime-tools.ts:377-397`：生产里构造的是 `WorkerDelegationService`，不是 `DelegationService`。
- `apps/` 下没有构造 `DelegationService` / `DurableDelegationStateAdapter`（方案前提 2 已承认）。

**建议**：E 单独出方案时补齐：`delegation.cancel` 命令契约、路由、客户端、已安装清单；`delegation.list/detail` 的生产读模型；`DelegationService` 的完整依赖；每个 run 的总时间/总费用/并发上限和 owner 配置；取消的最近认证/幂等语义。加一条“取消后 worker 不再继续、结果不再被接受”的测试。

### 13. 低：D 的提交闸门本身是现成的，但“提议提交”的写入口仍缺

**问题**：`CommitGateService.prepare` 会冻结 HEAD、index、hooks、config 等状态，`workspace.commit` 会校验最近认证；这部分方案判断是对的。但生产没有 `WorkspaceService`/workspace projection，`workspace.commit` 的 staging 和 preview 写入方都没有。方案说“后置、单独同意”是合理的，但不要把它描述成“装现成的闸门”就够；还需要 `WorkspacePlatformPort`、`WorkspaceStatePort`、staging、preview 持久化和模型工具。

**证据**：
- `packages/application/src/services/commit-gate-service.ts:31-69`：`prepare` 需要 `workspaceId`、`stagingRef`、`taskChangeSetRevision` 等。
- 同文件 `:72-187`：`commit` 校验 `recentAuthenticationRef`、preview hash、HEAD/index/hooks/config。
- `apps/agent-service` 下没有构造 `WorkspaceService`/`CommitGateService` 的生产入口。

**建议**：D 的独立方案先写清 workspace/staging/preview 的持久化和“模型提议原话”的存储，再谈工具和面容；本轮保持后置。

---

## 二、推测 / 未核实

- **未核实：生产实际是否启用 `bash`。** 仓库里的生产形态模板 `scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:24-26` 只写了 `enabledTools: ["read"]`。如果生产也只开 `read`，C 的“命令改动记录”根本不会产生，页面会一直是“暂无记录”。方案说“在编码任务里先核实生产实际用哪种”，这是对的，但应把它列为 C 的前置条件，而不是实现细节。
- **未核实：生产实际是否使用工作目录副本。** 方案已承认需要核实。若生产大量使用副本，C 第一版基本为空。
- **未核实：生产 `run_payload_artifacts` 中是否已有 workspace-changes 记录。** 取决于 `bash` 是否启用、是否有历史运行；没有只读核对生产库，无法确认。
- **未核实：生产是否有 capability 记录、是否有已停用能力。** 管理 CLI `apps/admin-cli/src/capabilities-command.ts:81-118` 会直接注册 `active` 记录；如果部署从未执行过注册，B 的页面也可能是空的。方案没有说明数据从哪来。
- **未核实：A 的“待采纳的改进”是否应该复用现有 `improvements` 页面。** 现有页面和翻译已经叫“待采纳的改进”，但契约是 `improvement.*`，与本方案的规则提议不是同一种东西；这是产品语义选择，不是纯代码事实。

---

## 三、侧重检查

**错误路径**：
- B 的 `qualify` 失败、artifact 摘要不匹配、运行环境资格不通过时，是否会回到 `disabled`；方案的两步流做不到，必须原子化。
- B 的 `capability.detail` 因 `unsupported` 依赖失败；需要在生产网关层测。
- C 的扫描 `complete: false`、并发命令、文件被外部修改、grant 过期时，界面是否会把“至少 N”说成“N”。
- A 的 `reject` 目标不是提议 ID、提议已确认/已拒绝、重复拒绝、确认与拒绝并发时的结果。
- D/E 的提交预览过期、HEAD/index 变化、子任务 worker 崩溃/取消后的未知结果。

**不合规范或不可信的输入**：
- A 的 `target` 必须同时校验格式、owner/agent scope、状态；不能只信客户端传来的 proposal ID。
- A 的 `quote` 是模型生成文本，不能默认称为“主人原话”；`summary`/`params` 也要沿用现有长度/字符校验。
- C 的 `displayName` 是主人输入，必须限制长度、控制字符，不能当路径使用；`grantId`/`threadId` 必须做 scope 校验。
- E 的模型工具参数（子任务、context refs、model refs、预算）必须只能从父 run/owner 已授予的集合中选择；`DelegationService.create` 已有 subset 校验，不能在网关层绕过。
- D 的提交说明来自模型，必须冻结并在主人确认前不执行；不能把模型文本直接当 Git 命令。

**安全**：
- 停用/回滚是半不可逆操作，服务端必须做最近认证；不能只依赖 `governed-action.ts` 的客户端检查。
- A 的 quote/replay 含主人原话和邮件元数据，必须走 `protect()` 和正确的 data classification；删除来源对话/邮件时要有删除或脱敏策略。
- 新操作必须纳入 owner/agent scope 和 authority fence 校验；不能因为“只是读”就跳过 scope。
- D/E 新增模型工具后，工具定义和系统提示会变，必须按 `prompt-prefix.md` 第 6/8 条让 Andy 同意，并跑 `npm run check:prompt-prefix`。

**资源耗尽**：
- A 的提议无上限、无过期，模型可以反复写 payload；需要 per-owner/per-thread 上限和清理。
- C 的改动记录可能很多（每条命令最多 50,000 条目、单文件 32 MiB 哈希），按对话/文件夹读取时要分页和限流；`run_payload_artifacts` 的索引是 `(owner, agent, run, purpose, operation_key)`，按 `operation_key` 跨 run 查询不高效，可能需要投影表。
- E 的子任务需要总费用/总时长/并发上限，不能只限制单个子任务。
- D 的提交预览和 staging 需要有界存储和过期清理。

**不可撤销操作**：
- B 停用：撤销句柄、取消定时任务，且方案明确不恢复；必须有明确警告、面容和回执。
- B 回滚：只切版本，不撤销外部副作用和产品数据库状态；界面不能暗示完全回退。
- D 提交：真实 Git 提交不可撤销，闸门必须冻结代码状态和提交说明，并在状态变化时作废。
- E 取消子任务：要确认 worker 真的停止或标记未知，不能只把数据库状态改成 cancelled。

**规则文件、说明文档和代码一致性**：
- `prompt-prefix.md` 第 6/8 条：D/E 改工具集合，必须停下来让 Andy 同意；本方案已识别，保留。
- `docs/architecture-v0.1.md:554`、`docs/runbooks/install-start-stop-runbook.md:369`、`control-center-inventory.ts` 的操作声明必须随 A/B/C 更新。
- B 需要 ADR，C 的计数语义和 ledger 格式变更也需要 ADR 或在 ADR 0097 上追加决定；A 的提议表和拒绝动作应写清状态机。
- `check-operations` 的“三处”说法要改成真正可执行的检查，否则文档和门槛不一致。

---

## 四、如果由我来定，我会怎样改这份方案

我会把方案改成“先补契约和门槛，再按块接生产”，而不是先做四块页面：

1. **先做契约/接线清单和门槛。**
   - 扩展 `check-operations`：前端使用的操作必须在生产已安装清单或 pending 台账里；已安装操作必须有真实路由；加反向 fixture。
   - 为 A/B/C 加“模型请求不变”的守护测试：系统提示、工具定义、历史前缀逐字节不变；D/E 单独加 `check:prompt-prefix` 和 Andy 同意。
   - 更新 architecture、runbook、control-center inventory、ADR。

2. **A 先做“规则提议”最小闭环。**
   - 明确新读操作和快照契约，不复用 `memory.rules.snapshot` 的旧状态枚举。
   - `memory.rule.respond` 显式增加 `reject` 分支，绝不落入 `undo`。
   - 提议 quote/replay 走受保护 payload；加提议数量上限、过期、来源删除策略；区分“主人原话”和“模型推断”。
   - 定义重复提议、确认/拒绝并发、确认两次的幂等语义。
   - 模型工具和系统提示不动。

3. **B 改成原子重新启用。**
   - 新增 `capability.reactivate`，带最近认证，`disabled` 直接到 `active`，失败保持 `disabled`，不恢复句柄/任务。
   - 停用/回滚也加服务端最近认证和不可逆警告。
   - 先接 `CapabilityLifecycleService`、artifact verifier、runtime qualifier、`listTaskRefsByCapability`，再安装 `capability.list/detail/disable/rollback`。
   - 回执/快照返回“本次取消的定时任务数”，并写 ADR、更新架构文档。

4. **C 先明确“算什么”，再谈页面。**
   - 如果坚持“改回原样不算”，先改 ledger 记录 `before` 的 `sha256` 或基线摘要；否则第一版就叫“bash 命令改动”，按命令并集计数，并明确删掉再恢复也算改过。
   - 把 `write/edit` 纳入读模型，或明确告诉主人“这里只显示 bash 命令的改动”。
   - 读操作要有 `grantId`/`threadId` scope、分页、上限，处理 `complete: false` 和并发改动。
   - `displayName` 单独设计写命令和契约字段，只做 UI 标签，不进入路径/权限/模型工具。

5. **D/E 继续后置，但先写清前置条件。**
   - D：workspace/staging/preview 持久化、“提议提交”原文存储、面容、工具集合变更审批。
   - E：`delegation.cancel` 契约、生产读模型、`DelegationService` 完整依赖、总预算/并发/子任务上限。

---

## 五、逐条回答必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**A/B/C：不会，前提是按“UI/网关只读或控制面”实现。**
- A 的提议列表、拒绝动作是控制中心操作，不是模型工具；`rule_set` 的工具定义和系统提示不变，已有历史不改写。
- B 的能力列表/停用/重新启用是网关和控制中心操作，不进入系统提示或工具定义。
- C 的“文件夹改动”是读模型；现有 `workspace-changes` 摘要本来就是在 `bash` 工具结果末尾追加给模型的，记录格式不变就不会改历史。
- 但 C 的 `displayName` 如果被放进运行环境说明，它只能出现在**最后一条用户消息**里，按 ADR 0164 在内容变化时追加，不能进系统提示或工具定义；否则会违反 `prompt-prefix.md` 第 2 条。
- A 的提议状态、时间、回放数字、B 的能力状态、C 的“改了几个文件”都不应该进系统提示；如果以后要让模型看到，只能放在最后一条消息或追加的工具结果里。

**D/E：会。**
新增“提议提交”工具和“派子任务”工具会改变工具定义或工具集合，按 `prompt-prefix.md` 第 6 条会触发一次换新，按第 8 条必须先出方案让 Andy 同意。方案已识别这一点，保留。

**结论**：A/B/C 只要不改 `rule_set` 描述、不把 displayName/能力状态塞进系统提示或工具定义，发给模型的内容仍然只在末尾追加；每轮变化的值保持在最后一条消息或 UI 侧。D/E 明确会改变请求开头，必须单独批准。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**会，如果实现不当。** 具体风险：

- **A 的提议列表**：如果按数据库返回顺序或 `createdAt` 相同值排序，同一列表在不同请求里可能顺序不同。方案已写“列表顺序固定”，要落实到固定的 `ORDER BY`（例如 `created_at DESC, proposal_id`），并加打乱插入顺序的测试。
- **A 的 `generatedAt` / 提议时间**：如果这些值进入模型可见内容，每次请求都会变；只能留在 UI，或放在最后一条消息/追加结果里。
- **C 的“改了几个文件”**：如果读取时重新扫描当前文件系统，同一对话在不同时间会得到不同数字；必须从已存记录计算。但如第 3 条所述，现有记录不足以支持“改回原样不算”，所以要么改记录格式，要么改定义。
- **C 的 displayName**：只要存储后稳定，字节稳定；若从当前路径/主机名推导，可能随环境变化。
- **A 的遮盖**：新表如果绕过 `protect()` 或用了不同的分类，同一段 quote 可能在不同请求里以不同形式出现；应复用现有保护/遮盖路径。
- **D/E**：工具定义固定，不依赖时间；但工具结果中的提交预览/子任务时间必须只追加，不能改写历史。

**结论**：A/B/C 的读模型如果只在 UI 使用，不进入模型上下文，就不影响模型请求字节；一旦要让模型看到，必须固定排序、固定序列化，并把时间/计数放在最后一条消息。C 的计数尤其不能每次重算。

### 3. 改动有没有对应的自动检查？反向用例是否真的会失败？

**部分有，但方案说的“操作名三处”检查不存在。** 具体：

- 现有 `scripts/check-operations.mjs` 不能证明“前端使用的操作已安装/已路由”，需要扩展；否则 A/B/C 新增操作漏装不会失败。
- A：需要测试“拒绝不写规则不写记忆”“确认两次只生效一次”“拒绝后再次提议可见”“确认/拒绝并发只有一个赢家”“打乱数据库顺序列表仍固定”。反向用例要在去掉对应分支后失败。
- B：需要测试“重新启用时资格检查失败仍保持 disabled”“旧句柄仍 revoked”“定时任务仍 revoked”“没有最近认证被拒绝”“capability.detail 在真实生产组装下不报 unsupported”。其中“失败保持 disabled”在当前两步流下**会失败**，这正好能暴露方案问题。
- C：需要测试“只读命令为 0”“改动后为 N”“恢复原样为 0”“扫描不完整显示至少 N/记录不完整”“只用 write/edit 时不会误报 0”。但“恢复原样为 0”在现有 ledger 上**无法通过**，必须先改记录格式或改定义；否则这个测试只能是假的或依赖重新扫描。
- D/E：需要 `npm run check:prompt-prefix`，并增加工具集合变更的反向用例。
- 所有块都要有真实 SQLite + 真实服务的 HTTP 入口测试，不能只测 service；这正是 I-73 的教训。

**结论**：方案列出的检查方向对，但至少 A 的契约/已安装清单、B 的失败保持停用、C 的恢复原样、D/E 的工具集合变更这四类反向用例目前没有可靠门槛。要先补门槛，再写功能。

### 4. 每个新值，生产端和使用端都能接受吗？

逐个看：

- **A**：
  - `proposalId` 目前 `confirm` 的校验是 `^rule-proposal:[0-9a-f]{32}$`（`production-owner-rules.ts:670`），新表的 ID 必须继续满足；不能换成 UUID 或带时间戳的格式而不改校验。
  - `action` 的 `"reject"` 要同时改契约、`production-memory-control` 分支、`OwnerRuleAction`、UI；绝不能落入 `undo`。
  - 新读操作的快照类型、`GATEWAY_V2_MESSAGE_TYPES`、`PRODUCTION_MEMORY_OPERATIONS`、`production-memory-control` 路由、控制中心可用性判断必须一致。
  - 提议表里的 quote/replay 要能被 payload protector 读回；如果表存明文，使用端（memory control/UI）会绕过分类和保护。
- **B**：
  - 新命令类型、`recentAuthenticationRef` 字段要同时进契约、`GOVERNANCE_COMMAND_TYPES`、`#assertCommand`/`#mutate`、控制中心 inventory、客户端 payload；只改 UI 会导致 400/操作未安装。
  - 新生命周期边要同时更新 `CapabilityLifecycleService`、`CapabilityRegistryRecord` 的持久化/读取、`capability.snapshot`、文档。
  - “N 个定时任务”要有明确生产端和读取端：生产事务里计数，快照/receipt 里暴露，UI 读取；不能只在 UI 里数。
- **C**：
  - 新读操作的输入/输出类型要进 `GATEWAY_V2_MESSAGE_TYPES`、`GATEWAY_V2_QUERY_TYPES`（或对应合同）、生产网关 read model、控制中心 inventory；否则 I-73 重演。
  - `displayName` 要同时改 `HostDirectoryGrant`、`host.directory.snapshot` 契约、gateway adapter、可能的 `configuredWorkspaceRoot` 消费者；所有读取 grant 的 capability program 目前是宽松 spread，但新增字段后要确认没有严格 key 校验。
  - “改了几个文件”的计数由谁产生、谁使用、两端如何校验要写清：如果前端自己从多条 ledger 记录算，后端不校验，就会出现“页面算法变了、后端数据没变”的不一致；建议后端返回已经算好的值并带 `complete` 标记。
- **D**：
  - 新工具名/参数要进 prompt catalog、runtime tool descriptors、工具集合测试；模型看到的工具定义变了，缓存开头会换新一次。
  - 提交预览的 `canonicalHash`、`previewId`、`recentAuthenticationRef` 要同时被 `CommitGateService` 和 `workspace.commit` 契约接受；不能只写 UI。
- **E**：
  - 新工具名/参数、`delegation.cancel` 命令、预算字段要同时进契约、安装清单、路由、客户端、`DelegationService`；`DelegationService.create` 已限制 `depth === 1`，不要让工具绕过。
  - 子任务费用/时长上限要同时被 `DelegationService.create` 校验、worker 执行和 UI 显示；只在 UI 写上限不算。

**结论**：方案目前只对 A/B/C 的“值”做了概略描述，没有逐项列出“谁产生、谁使用、两端怎么校验”。按 I-73 的教训，必须为每个新操作名、字段、枚举值、状态值写一张产生者/消费者表，并用真实网关请求把值走一遍；否则最容易在“契约/已安装清单/路由/UI”之间漏掉一端。
