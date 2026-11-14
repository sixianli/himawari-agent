## 一、方案依赖的前提（已核实）

**P1｜发给模型的内容只能追加，本轮会变的值只能放最后一条消息。**
来源：`.claude/rules/prompt-prefix.md:35` 原话“已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加”；同文件 `:27-28` 原话“固定的在前，会变的在后”“每轮都会变的内容只放在最后一条用户消息里”。
推论：只改手机网关的读/写操作、表、返回字段，不会碰模型请求；只有改工具集合或系统提示才会碰请求开头。

**P2｜工具集合按对话冻结，改工具集合要主人同意。**
来源：`.claude/rules/prompt-prefix.md:41` 原话“系统提示和工具按对话冻结……只有……工具集合变了……才换新一次”；`:84` 原话“会，就停下来出方案，Andy 同意才动工”。

**P3｜同样内容必须序列化成同样字节。**
来源：`.claude/rules/prompt-prefix.md:51` 原话“JSON 的键顺序、工具的顺序、列表的顺序……都要固定，不能依赖对象遍历顺序或数据库返回顺序”。

**P4｜一个值必须两端都认。**
来源：`docs/incidents-and-gates.md:112`（I-73）原话“双模型复核只看了 diff，没问「清单里的 id 能通过后端校验吗」”；处置是“清单生成出的每个引用都要过两个包的校验”。

**P5｜生产网关已装的操作很少，委托链决定谁能回答。**
来源：`apps/agent-service/src/production-approval-gateway.ts:54-60` 原话只列 `approval.list/detail/respond`、`search.authorization.read/set`；`:96-121` 读侧按 `memory.`、`push.`、`proactive.`、`muse.`、`owner.preferences.`、`sensitive.interceptions.` 依次转，最后 `searchAuthorization`；`:200-237` 控制侧同理，只额外有 `workspace.copy.*`。没有任何 `delegation.*`、`improvement.*`、`workspace.list/detail`、`host.*`、`capability.*`。

**P6｜真正的“子任务委派”代码存在，但生产没有生产者。**
来源：`packages/application/src/ports/delegation.ts:10-41` 定义 `Delegation`（`parentRunId`、`workerRunId`、`subtaskRef`、`status`、`workerResult.conclusionRef`）；`packages/application/src/services/delegation-service.ts:55-162` 是创建流程，`:280-293` 有 `cancel`。但 `apps/` 里没有任何地方构造 `DelegationService`；生产里叫“delegation”的是 `apps/agent-service/src/production-runtime-tools.ts:377-397` 的 `WorkerDelegationService`，它只是把一次工具调用交给隔离 worker 执行，没有“模型把大事拆给子任务”的标题。

**P7｜现有的 Improvement 服务是“代码补丁候选”，不是行为改进，而且不能“采纳”。**
来源：`packages/application/src/services/improvement-candidate-service.ts:58-140` 的 `propose` 要 `baseRevision`、`baseDigest`、`allow`、`patchRef`、`validation`、`artifactRef`；`:214-229` 的 `review` 决策只有 `"reject" | "request_revision"`，没有“采纳并生效”。生产 `apps/` 没有构造它。

**P8｜真正的“提议→主人点头才生效”是 owner rule 流，且已接进生产；但只列已有规则、不列待确认提议。**
来源：`apps/agent-service/src/production-owner-rules.ts:637-639` 原话“`const explicit = !input.inferred && isStandingQuote(quote) && ...`；`if (explicit) return this.#activate(...)`”；`:640-666` 非明说的只写 `rule-proposal:...`；`:669-676` `confirm` 再激活。`apps/agent-service/src/production-memory-control.ts:55-65` 已装 `memory.rules.read`、`memory.rule.respond`；但 `:487-516` 的 `#rules` 只调 `control.list()`，列的是已存在的规则，不是 `rule-proposal`。
规则类型只有两类：`packages/application/src/rules/rule-types.ts:204-209` 的 `mail_must_notify`、`mail_read_whole_thread`。

**P9｜工作目录/提交代码存在，但生产只装了副本控制，读侧和 stage/commit 都没装。**
来源：`packages/application/src/services/host-workspace-gateway-adapter.ts:618-745` 能回答 `workspace.list/detail`、`host.directory.detail`；`:396-441` 是 `workspace.stage`，`:443-471` 是 `workspace.commit`，其中 `:456` 明确要近期认证。`apps/agent-service/src/production-workspace-copies.ts:173-180` 的 delegate 原话“Gateway operation is not installed”。生产真实的文件改动记录在 ADR 0097：`apps/agent-service/src/production-workspace-ledger.ts:93-130` 记录 `changes` 和 `summary`；`apps/agent-service/src/production-coding-workflow.ts:558-561` 只在 `tool === "bash" && grant !== null && !binding.workspaceCopy` 时启用 ledger。

**P10｜能力停用会撤销句柄和定时任务，且没有回到 active 的路径。**
来源：`packages/application/src/services/capability-lifecycle-service.ts:621-623` 的 `disable` 只允许 `active`；`:408-426` 的 `activate` 只允许 `installation_approved`；`:678-698` 走 `invalidateCapabilityAuthority`。`packages/persistence-sqlite/src/sqlite-durable-operations.ts:2605-2653` 在一个事务里保存 disabled、撤销该能力的全部 handle、把引用它的 `scheduled_jobs` 改成 `revoked/cancelled`。

**P11｜“可读文字”必须在记录产生时存原话，不能用关键词/正则/模板拼。**
来源：材料约束原文；代码里 owner rule 的 `summary`、`quote` 是模型原话（`production-owner-rules.ts:601-666`），而 `workspace-changes.ts:56-68` 的 `summarizeWorkspaceChanges` 是固定中文模板，不能直接当界面主文案。

**P12｜产品原则要求可审计、可回滚、不得扩大权限。**
来源：`docs/product-vision.md:63` 原话“进化与新工具必须经过评估与回归验证、可版本化、可回滚、可审计，且不得扩大自身权限”；`:115` 原话“每一次行动、每一次进化、每一个自造工具都有记录、可回滚”。

---

## 二、四块的数据来源与做法（回答问题 1、2）

### 1. 派出去的帮手

**结论：现在不要按原型做“模型派子任务”的界面；生产里没有这个数据源。** 不要把 `WorkerDelegationService` 的工具调用包装成“帮手标题”，那是把“隔离执行一次工具”说成“模型拆了一个子任务”，违反“每个判断词必须有可验证定义”。

可选的诚实做法，按代价从低到高：

- **1a（建议先不做，或只做“正在后台运行”）：** 用已有的后台命令记录（`production-background-commands.ts`）和工具调用回执，显示“正在运行的命令/工具 + 开始时间 + 原样命令参数”。文字来源是模型当时的工具参数，不是系统拼的标题；不叫“派出去的帮手”。缺点：后台命令表在内存（`Map`），重启丢失，不能显示“今天做完的”历史；要历史就得另存一张表，属于为一个临时 UI 加持久化，不划算。
- **1b（完整版，另出 ADR、主人同意后才做）：** 给模型真正的 `delegation.*` 工具，生产装配 `DelegationService` + `DurableDelegationStateAdapter` + worker/result/verification；创建时把模型写的子任务标题作为 payload 存下；网关装 `delegation.list/detail`，并新增 `delegation.cancel`（合同里现在只有 list/detail，没有 cancel，见 `packages/gateway-contracts/src/contracts-v2.ts:1959-1972`）。这会改变工具集合，**触碰请求开头**，只对新对话生效，必须主人同意。

**新增：** 1a 不需要改模型、不需要改提示词；若做历史，新增一张小的 `work_items` 表（runId、toolCallId、标题/命令原文、开始/结束、状态），在 `ProductionRuntimeTools` 开始/结束时写。1b 才需要 `DelegationService` 的装配和 `delegation.cancel`。

### 2. 待采纳的改进

**结论：沿用 owner rule 的“提议→主人确认”，不要用 `ImprovementCandidateService`。** 理由：后者是代码补丁候选，且只有拒绝/要求修改，不能“采纳生效”；前者已经是生产的“推断只存提议、主人确认才生效”，带 `summary` 和主人原话 `quote`，符合“规则是硬性设定、带出处和回归测试”。

**但原型的“雨天多留 10 分钟”现在做不了**：现有可执行规则只有邮件两类（`rule-types.ts:204-209`）。这次要么只展示现有邮件规则的提议，要么先扩展规则类型（每种类型要有解析、执行、回归测试），后者是独立的大改，不能为了卡片硬造。

**新增：**
- 读：新增 `memory.rule.proposals.read`（或新快照类型），列出 `proposalId`、`type`、`summary`、`quote`、证据、`createdAt`、`status`。不要改 `memory.rules.snapshot` 的既有形状去硬塞，避免两端升级不一致。
- 存：新增一张 `owner_rule_proposals` 表（一次只加这一块）。`ProductionOwnerRuleWriter.create` 目前只把 `key/type/params/summary/quote/threadId/source` 写进 payload（`:628-654`），要在**提议产生时**把 `trials`/`replay` 证据一起存下，不能在读取时重新跑 replay（会随邮件现状变化）。
- 写：确认复用 `memory.rule.respond` 的 `confirm`；**拒绝不能复用 `undo`**——`undo` 只认 `owner:` 前缀的 ruleId（`:760-762`），传 `rule-proposal:` 会返回 `RULE_NOT_FOUND`，这是典型的 I-73 两端不一致。要新增 `reject` 动作，只把提议标为 rejected，不写规则、不写记忆。
- 可读文字：卡片标题/说明用创建时模型写的 `summary`，依据用记录时存下的命中样本和原话；“2 次”这类数字要给出定义（哪段时间、哪些样本、命中几封），不能只是写死的文案。
- 不改模型调用和工具集合：`rule_set` 工具已经存在，新增的是手机侧网关读写。

### 3. 代码和文件夹

**结论：先做只读的“它改了哪些文件”，用 ADR 0097 的 ledger；提交按钮后置，且要单独主人同意。** 不要为了卡片把未接线的 `WorkspaceService`/`HostWorkspaceGatewayV2ReadModel` 整套硬接上。

理由：生产真实存在的是 ADR 0097 的每命令前后快照和 `workspace-changes.v1` 记录；`workspace.list/detail`、`workspace.stage/commit` 在生产都没装，`production-workspace-copies.ts` 的读 delegate 是抛错存根。另一方面，`production-coding-workflow.ts:558-561` 在选择了 workspace copy 时**不跑 ledger**，这一点生产是否实际选了 copy 我未核实；如果生产默认选 copy，ledger 就没有数据，需要改用副本服务自己的记录。

**新增：**
- 读：新增 `workspace.changes.read`（按 grant/host 和最近时间列出），数据来自 ADR 0097 的 ledger。建议在写 ledger 的同一处另写一张 `workspace_change_ledger` 投影表（owner/agent/host/grant/run/thread/toolCall/createdAt/changes JSON），因为 `run_payload_artifacts` 是按 run 存的，不适合按“文件夹”查询；这张表和 block 2 的表分两次迁移，一次只改一块。也可以先直接查 `run_payload_artifacts`，但需要核实它的索引能否按 grant/时间高效查，未核实。
- 可读文字：文件路径、增删改类型、大小是事实；“改了 3 个文件”是 `changes` 里去重后的文件数，定义清楚即可。**不要直接显示 `summarizeWorkspaceChanges` 的固定模板**（`workspace-changes.ts:56-68`），它不满足“可读文字必须是模型/主人原话”。“它想提交：整理 11 月会议记录”必须是真正 stage 后 `CommitPreview` 里的模型/主人提交说明，不能从文件改动推断。
- 主机显示名：`HostDirectoryGrant` 只有 `hostId` 和 `displayPath`（`packages/application/src/ports/host-files.ts:26-39`），没有“MacBook Pro”。要么在授权创建时存主人给的主机显示名（新增字段，两端都要改），要么就显示 `hostId/displayPath`，不要写死“MacBook Pro”。
- 写：提交要装 `workspace.stage`/`workspace.commit` + `WorkspaceService`/`CommitGateService`，`workspace.commit` 已强制近期认证（`host-workspace-gateway-adapter.ts:456`）。模型现在没有 stage/commit 工具，所以“它想提交”要么由主人在手机上发起（不需要改提示词），要么新增模型工具（改工具集合，需主人同意）。diff `+42 −7` 若 `CommitPreview` 没有行数，就不要显示；要有定义并在预览产生时存下。

### 4. 能力重新启用

**结论：做，但必须是“显式重新授权 + 重新验证”，不是把状态字符串改回 active。** 用 `CapabilityLifecycleService` 和现有 registry；新增 `reactivate`，只允许 `disabled → installation_approved`（或重新审核），然后走现有 `activate` 的 `artifacts.verify` + `runtime.qualify`。**撤销过的句柄和定时任务保持撤销，绝不自动恢复。**

**新增：**
- 读：把 `capability.list`、`capability.detail` 装进生产已安装操作。读模型 `GovernanceGatewayV2ReadModel` 已有这两个查询（`governance-gateway-adapter.ts:237-251`），数据来自 `repository.capabilityStore`；注册由 admin CLI 做（`apps/admin-cli/src/capabilities-command.ts:81-118`）。我未核实生产库里当前有没有 capability 记录。
- 写：`capability.disable` 已有合同（`contracts-v2.ts:1726-1733`）；新增 `capability.reactivate` 合同和操作，带 `expectedRevision`、`reasonCode`、`recentAuthenticationRef`。`reactivate` 里先 `qualify`，失败就不改状态；成功后记录 `reactivatedAt`、审批 ref、停用时间。
- 健康检查与回滚：重新启用后跑一次有界健康探针（无外部副作用），把 `health.status/checkedAt` 存下；如果失败，只提示主人，不自动再次停用（自动停用是另一种撤销，应该由规则或主人决定）。若 `rollbackDeclaration` 存在，开放 `capability.rollback`（合同已有，`:1735-1742`）；不存在就隐藏“退回上一版”，不要假装能退。
- 不改模型调用和工具集合：这些是手机侧网关操作。

---

## 三、先后顺序与哪些要主人同意（回答问题 3）

建议顺序：

1. **Block 2（owner rule 提议）**：最小、复用已装 `memory.rule.respond`，只新增读和一张提议表；不改提示词。先只支持现有邮件规则。
2. **Block 4（能力读 + 停用 + 重新启用）**：复用现有 registry 和 lifecycle，新增 `reactivate`；重新启用和回滚要近期认证。
3. **Block 3 只读（改动清单）**：新增 ledger 投影/查询；不写 git。先核实生产是否使用 workspace copy，再决定数据源。
4. **Block 3 提交**：单独主人同意；要么主人从手机发起（不改提示词），要么新增模型提交工具（改工具集合，需按 P2 再同意）。
5. **Block 1 完整版**：新增真正的 delegation 工具和 `delegation.cancel`，改工具集合，必须主人同意，只对新对话生效。
6. **Block 1 的临时“正在运行”**：如果只想先填页面，可以插在 3 之前，但必须改名、只显示真实命令/工具，不叫“帮手”。

必须主人同意的：
- 任何工具集合/系统提示变化（Block 1 完整版；Block 3 若让模型提议提交）。
- 提交代码到 git（Block 3 写操作）。
- 重新启用一个曾被停用的能力（动作当时的近期认证）。
- 新增可执行规则类型（Block 2 的雨天/出门类规则）。
- 任何生产迁移和新表的启用（按项目变更流程）。

---

## 四、能力重新启用怎样不违背“撤销不能悄悄恢复”（回答问题 4）

1. **状态上分两步：** `disabled → installation_approved` 要带新的主人审批 ref；再从 `installation_approved → active` 走现有 `activate`，重新验产物摘要和运行时资格。禁止直接 `disabled → active`。
2. **句柄不恢复：** `invalidateCapabilityAuthority` 已撤销该能力的全部 handle；重新启用后也不批量恢复，后续调用由正常流程重新签发一次性 handle。
3. **定时任务不恢复：** `scheduled_jobs` 仍保持 `revoked/cancelled`；重新启用回执里明确写“有 N 个定时任务仍是撤销状态”，要恢复必须主人逐个重新创建并重新授权。
4. **重新验证：** 重新启用前必须 `artifacts.verify` 通过、`runtime.qualify` 的 `productionSuitable` 为真且所有 `enforcement` 为真（复用 `capability-lifecycle-service.ts:645-676` 的 `qualify`）。
5. **可回滚：** 保留停用前的 `rollbackDeclaration`/`runtimeQualification`；只有存在上一版时才显示“退回上一版”，并同样走 `qualify`。
6. **审计：** 记录停用人、重新启用人、审批 ref、时间、健康检查结果；在能力页面能点开每一次停用/启用的原因。

---

## 五、愿景里还该有、这四块没覆盖的（回答问题 5）

- **取消正在跑的子任务：** `DelegationService.cancel` 存在（`delegation-service.ts:280`），但网关合同没有 `delegation.cancel`，手机无法取消。完整版必须补上，并带预算/停止条件（愿景原则 8）。
- **撤销已采纳的改进：** owner rule 有 `undo`（`:760-788`）能退回规则，但“改进”若是代码/配置变更，还需要版本化、回滚和回归证据；不能只有“采纳”没有“撤销”。
- **重新启用后的健康检查与自动降级建议：** 重新启用不是结束，要有一次健康探针、观察窗口和失败时的“建议停用/回滚”，而不是悄悄当作 active。
- **权限不扩大的自动检查：** 重新启用同版本也要证明 scope 未扩大；改进/新规则要有 `assessCapabilityUpdate` 同类的负数测试。
- **决策可解释：** 每个卡片都能链到“为什么”：规则的原话与出处、子任务的模型原话、工作区命令的 runId、能力的审批历史（Jarvis Test #11）。
- **注意力预算：** 这四块会产生新的待确认项（提议、提交、重新启用）。要计入“每日需要我介入的次数”上限，超出排队，不能都堆给主人（愿景原则 2）。

---

## 六、考虑过但不选的做法及原因

- **直接把 `delegation.list/detail` 接上，用 `WorkerDelegationService` 当数据源。** 不选：它不产生 `Delegation` 记录，只是工具隔离；接上会永远空，或者要伪造标题。
- **用 `ImprovementCandidateService` 做“待采纳的改进”。** 不选：它是代码补丁候选，`review` 没有“采纳”，生产没装配；把它当行为改进会混淆两种东西。
- **新增模型工具来做这四块。** 不选：四块里三块只需手机网关读写；新增工具会改请求开头、只对新对话生效，代价没有必要。
- **把 `workspace.list/detail` 整套读模型直接接上。** 不选（至少不先做）：`WorkspaceService` 没构造，快照没有生产者；接上会读到空。先用已有的 ADR 0097 ledger。
- **停用后直接允许 `disabled → active`。** 不选：会绕过重新验证，也会让主人误以为撤销过的句柄/定时任务回来了。
- **读取时重跑规则 replay 生成“看依据”。** 不选：证据会随邮件现状变化，同一段文字在不同请求里字节不同，违背确定性；应在提议产生时存下。

---

## 七、风险和反例

- **Block 1 最大的风险是“看起来有、其实没有”。** 反例：把 `bash` 工具调用显示成“派出去比较三家酒店”，主人点进去没有任何子任务、不能取消、没有标题；这比隐藏更糟。
- **Block 2 的反例：** 用 `undo` 处理 `proposalId` 会 `RULE_NOT_FOUND`；提议表不排序会导致手机每次顺序不同；读取时重新 replay 会让“依据”变化；规则类型不够时硬套“雨天”会得到一条永远不会执行的规则。
- **Block 3 的反例：** 生产选了 workspace copy 时 ledger 不跑，页面空白；`hostId` 直接显示成“host-xxx”而不是“MacBook Pro”；提交预览过期后再点“提交”失败；没有近期认证就提交；把固定模板摘要当模型原话。
- **Block 4 的反例：** 重新启用后旧的定时任务没有恢复，主人以为“都回来了”；`qualify` 通过但健康探针失败；`rollbackDeclaration` 为空却显示“退回上一版”；两个手机同时点重新启用，旧 revision 被接受。
- **通用反例：** 新操作名只加在合同、没加进 `installedOperations`，手机上永远 `OPERATION_NOT_INSTALLED`；新 `proposalId` 格式与 `confirm` 的正则不一致；新 `capabilityRef` 不能过 `machineString`；集合顺序依赖数据库返回顺序。

---

## 八、需要人拍板的取舍

1. **Block 1：** 先显示诚实的“正在后台运行”，还是直接隐藏到真正的 delegation 工具做出来？
2. **Block 2：** 这次只展示现有邮件规则提议，还是先扩展新的可执行规则类型（雨天/出门）？后者要接受更大的开发和回归测试成本。
3. **Block 3：** 第一版只读改动清单，还是同时做提交？提交由主人从手机发起，还是让模型提议提交（后者改工具集合）？
4. **Block 4：** 重新启用是“重新验证即可”，还是“必须重新走一次安装审核”？我建议前者，但保留主人审批和近期认证；撤销过的定时任务是否允许一键重建，还是必须逐个重建？我建议逐个。
5. **主机的显示名：** 新增字段由主人命名，还是暂时显示 `hostId/displayPath`？
6. **迁移顺序：** Block 2 和 Block 3 各加一张表，是否接受分两次上线、一次只改一块？

---

## 九、必答问题

### 1. 会不会改变模型已经见过的请求开头？

**除 Block 1 完整版和“模型提议提交”外，不会。** 本方案新增的是手机网关的查询/命令、表、返回值，不改系统提示、工具定义、历史消息、遮盖规则；发给模型的内容仍然只在末尾追加，每轮会变的值仍只在最后一条用户消息里（P1、P2）。Block 1 完整版新增 delegation 工具、Block 3 若新增模型提交工具，会改变工具定义，属于 P2 的“工具集合变了”，只对新对话生效，必须主人同意（`.claude/rules/prompt-prefix.md:41,84`）。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**模型请求不会。** 本方案不新增模型输入。手机返回的文字要在**记录产生时**存原话，读取时原样返回；不要在读取时重跑 replay、重新总结或按关键词拼（P3、P11）。集合必须按稳定键排序（proposalId、createdAt+id、capabilityRef、path），不能用数据库返回顺序或 `Set` 遍历顺序（`.claude/rules/prompt-prefix.md:51`）。`generatedAt` 这类每请求变化的值只放在手机响应里，不放进任何模型请求；如果手机端要做缓存/去重，应忽略它。用于生成 id 的 `JSON.stringify` 要保证键顺序固定（owner rule 的 params 经过解析后顺序固定，但仍要加测试钉住）。

### 3. 有没有对应的自动检查？反向用例真的会失败吗？

有，且都要有“去掉修复就失败”的反向用例（按 I-73 的做法）：

- **操作安装检查：** 手机用到的每个操作名必须同时出现在 `gateway-contracts` 的操作联合、`installedOperations`、delegate 路由里；删掉其中一个，测试失败。
- **两端 id 检查：** 新产生的 `proposalId`、`ruleId`、`capabilityRef`、`workspaceId/grantId` 必须过消费者使用的同一套校验（`machineString`、`confirm` 的 `/^rule-proposal:[0-9a-f]{32}$/`、`store.get`）；把 id 改成带斜杠/后缀，测试失败。对应 I-73 的 `check:model-ref-contract` 思路。
- **提议流：** `confirm` 两次幂等、`reject` 不写规则不写记忆、过期提议不展示、读取顺序稳定；把 `reject` 错接到 `undo`，测试失败。
- **工作区：** ledger 记录顺序稳定；`workspace.commit` 没有近期认证必须失败；没有 commit preview 不得出现“它想提交”；选了 workspace copy 时数据源切换的用例必须说明是哪种来源。
- **能力：** `disable` 后 handle 全部 revoked、scheduled_jobs 全部 cancelled；`reactivate` 后这两类数量仍然是 0 自动恢复；产物或资格验证失败时不能变 active；`disabled → active` 直接转换必须被拒绝；旧 revision 的重新启用必须冲突。
- **确定性：** 同一状态连续读两次，除 `generatedAt` 外文字和顺序逐字节相同。
- **提示词：** 照常跑 `npm run check:prompt-prefix`；本方案不改提示词时应继续通过。所有测试用真实 SQLite 和真实服务，不用假替身；不新增付费模型调用，费用远低于 0.5 美元。

### 4. 每个值两端都能接受吗？

逐个核对，不能只看改动：

- **新操作名**（`memory.rule.proposals.read`、`capability.reactivate`、`delegation.cancel`、`workspace.changes.read`）：产生于合同/网关，使用于 `installedOperations` 和 delegate 路由；两端都要加，测试钉住。
- **`proposalId`**：产生于 `production-owner-rules.ts:645-654`（`rule-proposal:<32hex>`），使用于 `:669-676` 的 `confirm` 正则；新列表必须返回完全相同的格式，否则确认失败。
- **`ruleId`**：产生于 `:494`（`owner:` 前缀），使用于 `:699-701` 和 `:760-762`；拒绝提议不能把它当 ruleId 传给 `undo`。
- **`capabilityRef`**：产生于 capability store 的 `ref`，使用于 `store.get` 和合同 `machineString`；要加一条“清单里的 ref 能通过两个包的校验”测试。
- **`workspaceId`/`grantId`/`hostId`**：产生于投影/grant，使用于 `workspace.detail`、`host.directory.detail` 的 `machineString`；新 `displayName` 若加，产生端（授权创建）和消费端（快照 schema、手机）都要接受，不能拿 `displayPath` 冒充名字。
- **载荷引用**：若返回 `PayloadRef`，手机必须走 `payloads.readText/protectJson` 才能得到文字；若想内联文字，快照 schema 要加有界字符串，且生产端在记录时已存原文。不要一端返回 ref、另一端当纯文本用。
- **状态枚举**：新增的 `proposal` 状态、`reactivation` 结果要同时加进查询过滤、快照枚举和手机端；漏一个就会“列表里有、点进去不认”。
- **时间戳**：统一用现有 `timestamp` 合同格式，两端用同一个解析；不要一端 ISO、一端本地时间字符串。
