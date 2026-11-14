我先看仓库结构和材料里提到的关键文件，再形成方案。
这份设备设计规格大部分与四块无关。我继续读四块直接相关的代码，先核验材料里最承重的两处：能力生命周期（E）和规则提议流程（C）。
核对 B、D、E 三块的实现和生产的装配方式。
最后核对两处可行性：建议/复盘流水线在生产库的落点，和工作台平台端口（提交）的实现。
# 方案：iPhone「Himawari 自己」页四块怎样接进线上

## 一、方案依赖的前提（读代码或来源证实）

1. **四块的协议两端其实都已存在**。`packages/gateway-contracts/src/contracts-v2.ts:89-130` 已枚举 `capability.review/install.approve/update.respond/disable/rollback`、`capability.list/detail`、`delegation.list/detail`、`improvement.list/detail`、`suggestion.respond`、`reflection.configure/detail`、`workspace.list/detail/stage/commit`、`host.directory.detail`，命令/查询/快照的 schema（:1690-1738、:1888-1998、:2313-2340）和注册表（:2475-2498）齐全。生产缺的是装配，不是协议。
2. **生产的闸门在两处**：操作必须在 `installedOperations` 里，否则一律 `OPERATION_NOT_INSTALLED`（`packages/application/src/services/agent-gateway-v2-service.ts:34-42`）；生产清单目前只有 approval/search 加各组选项（`apps/agent-service/src/production-approval-gateway.ts:54-60、250-262`），且任何 `capability.*` 都不在其中。
3. **读模型/控制平面已原生支持 capability.***，不需要 delegate：`GovernanceGatewayV2ReadModel` 自己处理 `capability.list/detail`（`packages/application/src/services/governance-gateway-adapter.ts:237-252`），`GovernanceGatewayV2ControlPlane` 自己处理 `capability.disable/rollback`（:713-728）；但生产构造控制平面时**没有传 `capabilityLifecycle`**（`production-approval-gateway.ts:193-248` 没有该字段；`governance-gateway-adapter.ts:731-739` 缺了就抛错）。平台侧实现已备好：`FileCapabilityArtifactVerifier`（platform-node/src/capabilities/artifact-verifier.ts:105）和 `NodeCapabilityRuntimeQualifier`（isolation.ts:739）。
4. **生命周期里没有 disabled→active 的路**。activate 只认 `installation_approved→active` 且必须重验产物摘要和运行时资格（`capability-lifecycle-service.ts:408-426、645-676`）；disable/revoke/uninstall 走 `invalidate`（:621-631、678-698），落库时在一个事务里撤销全部 capability handle、把引用该能力的 scheduled_jobs 全部改成 revoked/cancelled（`sqlite-durable-operations.ts:2605-2653`）。
5. **高风险动作的“面容”机制已存在**：审批响应在 `recentAuthenticationRequired` 时强制最近认证（`governance-gateway-adapter.ts:765-770`）；生产 delegate 也有一处直接断言最近认证的先例（`production-approval-gateway.ts:214-219`）。
6. **提交闸门已有完整实现**：`CommitGateService` 的 prepare 在提议时把 message、HEAD、index 摘要一起冻结（`commit-gate-service.ts:31-70`），commit 要求一次性 Handle（`maxUses=1`、authorityFence、**recentAuthenticationRef 非空**，:72-93）；`GitWorkspaceAdapter implements WorkspacePlatformPort` 已在 platform-node（git-workspace-adapter.ts:34）。
7. **生产里真实且持久的“文件改动”记录是 run_payload_artifacts**（ADR 0097 流程，`workspace-changes.ts:34-54` 产出、`sqlite-run-payload-artifact-operations.ts:385` 落库），粒度是每条命令的前后扫描；授权目录 grant 带 `hostId` 和 `displayPath`（读模型原样返回，`host-workspace-gateway-adapter.ts:726-744`）。而 `workspace.list/detail` 依赖的投影在生产没有任何写入者（材料事实 D，与代码一致：读模型在 `host-workspace-gateway-adapter.ts:618-714`，无人装配）。
8. **规则提议流程是生产里唯一在跑的“提议→主人点头”**：模型推断的只存提议（`production-owner-rules.ts:637-666`，`proposalId = rule-proposal:<hash>`，summary/quote 写进载荷），主人在手机上 confirm 才生效（:669-676）；但可写规则类型只有极少数（材料事实 C：`rule-types.ts` 只有 mail_must_notify、mail_read_whole_thread——此条我未亲核，标材料证实）。
9. **“帮手”在生产里没有对应物**：WorkerDelegationService 是“一次工具调用转隔离 worker”（`production-runtime-tools.ts:377-397`），回执字段里没有子任务标题、没有进度（`capability-invocations.ts:62-90`）；后台命令只在内存 Map 里，重启即失，自述“服务重启后，之前的后台命令都已停止”（`production-background-commands.ts:96-113、233`）。完整的 Delegation 管线（`ports/delegation.ts:10-63`、`durable-autonomy-state-adapter.ts:178-209` 的适配器）存在但生产无人装配，也没有让模型创建 Delegation 的工具。
10. **复盘/建议管线未接生产**：`SuggestionService`（去重键=证据引用排序后的哈希，配额、过期，`suggestion-service.ts:89-118`）和 `ReflectionService` 存在，autonomy 读模型有 `suggestion.respond`（`autonomy-gateway-adapter.ts:49-51、129-166`），但 apps/ 下没有构造，且 **persistence-sqlite 里没有 ProactivityStatePort 的存储**（全库检索无命中——推测需要新表）。
11. **发给模型的内容约束**（`.claude/rules/prompt-prefix.md`）：已发内容只追加（规则 4，:35）；系统提示和工具按对话冻结、工具集合变了换新一次且每次留记录（规则 6/7，:41-44）；后台调用固定在前、会变的在后（规则 15，:67）；阻断检查 `check:prompt-prefix` 自带反向用例（:74）。业界来源（该文件内引用）：Anthropic/OpenAI 缓存文档、Claude Code 博客 https://platform.claude.com/docs/en/build-with-claude/prompt-caching 、https://claude.dev/blog/lessons-from-building-claude-code-prompt-caching-is-everything/ 。
12. **I-73 的教训**：一个值只在一端认就会炸（`docs/incidents-and-gates.md:112`：「双模型复核只看了 diff，没问『清单里的 id 能通过后端校验吗』」）。

## 二、方案

**总原则**：四块的协议、快照 schema、多数服务实现都已经在两个包里写好并互相认识（前提 1）。所以主线是「把现成实现装配进生产」，新写的代码只限于生产语义真正缺的三样：能力的重新启用转换、读 run_payload_artifacts 的一个小读模型、改进提议的产生通道。不新造平行机制，也不为展示去拼模板文字。

### 第 4 块：能力重新启用 —— 第一优先，先做

**结论：做。数据来源就是 capability registry 本身，代码两端齐全，只缺装配和一个新转换。**

- 读侧：把 `capability.list`、`capability.detail` 加进 `installedOperations`（`PRODUCTION_APPROVAL_OPERATIONS` 追加，或新建 `PRODUCTION_CAPABILITY_OPERATIONS`）。「它会的本事」行的每个数字（会几个、几个被停用）都来自 registry 现状，可验证；显示名用 manifest 里评审时记下的 `displayName`（`governance-gateway-adapter.ts:437`），不新拼。
- 写侧：生产构造 `CapabilityLifecycleService` 传入 `FileCapabilityArtifactVerifier` + `NodeCapabilityRuntimeQualifier`，挂到控制平面；把 `capability.disable`、`capability.rollback`、`capability.review`、`capability.install.approve`、`capability.update.respond` 一起装上（disable 和 rollback 是“退回上一版”和“停用”按钮的现成实现，前提 3）。
- **重新启用 = 新增显式转换，不做“复活”**：新命令 `capability.reenable`（contracts 两端同一次改动加 schema 和 fixture），载荷带 `recentAuthenticationRef`，控制平面先断言最近认证（照抄 `production-approval-gateway.ts:214-219` 的写法），再把 `disabled → installation_proposed`（reviewer 记主人本人），然后走**已有的** `capability.install.approve → activate`：重新验产物摘要、重新跑运行时资格（前提 4）。停用时撤销的 handle 和 scheduled_jobs **一律不恢复**：重新启用后它们仍是 revoked/cancelled，定时任务要主人重新建，新建句柄只来自新的运行。
- 启用后的健康检查：activate 本身要 `productionSuitable` 且各项隔离措施 enforced（`capability-lifecycle-service.ts:657-667`）才算成功；上线走查加一项「重新启用一个曾被停用的能力后，它出现在已装清单里，且停用期间被取消的定时任务保持取消」。

### 第 3 块：代码和文件夹 —— 第二优先，读侧先行、提交走现成审批

**结论：做，分两期。第一期的数据来源是 run_payload_artifacts + grant，第二期才是 workspace 投影和 CommitGateService。**

- 第一期（读）：
  - 「在哪」：来自 grant 的 `hostId`、`displayPath`——这是主人在授权时刻确认、记录产生时存下的文字（前提 7），不是拼出来的。
  - 「它改了 N 个文件 / 哪些文件」：新增一个小读模型（delegate 分支，例如 `workspace.changes.read`——需要 contracts 两端同步加 query+snapshot schema），从 `run_payload_artifacts` 按（grant、日）聚合，显示**记录产生时已存**的字段：路径、新建/修改/删除、大小、时间、所属 run/thread。列表按 path 排序输出（字节确定，见必答 2）。「+42 −7」这类行级统计现在没人记录，第一期不显示（不造假数）。
  - 不先接 `workspace.list/detail`：投影没有写入者，接了也是空页（前提 7）。
- 第二期（写，需主人同意再做）：
  - 「同意提交时要面容」：两条路。**近期**：模型真要提交时走它本来就走的审批——生产里工具调用本就有 approval/respond 管线，高危审批带 `recentAuthenticationRequired`（前提 5），手机的「提交」按钮就是 `approval.respond`；**此后**：装配 `WorkspaceService + CommitGateService + GitWorkspaceAdapter`，把 contracts 里已有的 `workspace.stage/commit` 装进生产已装清单，提交前 prepare 冻结 message 和 HEAD/index 摘要，提交凭一次性 Handle + 最近认证（前提 6）。一期不做 stage/commit，因为「它想提交」的预览数据（stagedDiff）还没有生产写入者。

### 第 2 块：待采纳的改进 —— 第三优先，落在「提议→点头」的现成骨架上

**结论：做，但不用 ImprovementCandidateService。原型里那张卡（“雨天多留 10 分钟”+依据）不是代码补丁，硬塞进补丁管线是错配。**

- ImprovementCandidateService 管 baseDigest/allowedPaths/patchRef/候选工作区隔离，并且明文禁止候选自我 apply/commit（`improvement-candidate-service.ts:20-35、241`）——它是愿景第 7 条“自造工具”的管线，是另一个更大的工程；生产既无装配也无 CandidateWorkspacePort，现在接它违背“一次只改一块”。
- 方案：**复用规则提议的骨架，加一种新的提议载荷**。模型在对话里用一个新的小工具（或 rule_set 的扩展参数）把改进提议写成 JSON 载荷，记录产生时存下：summary（模型原话）、evidence（引用的记忆 id + 当时的引文原话，像规则的 quote 一样整句存，`production-owner-rules.ts:637-666` 的做法），不做关键词表、不用模板拼。
- 手机端：新增 `advice.list / advice.respond`（contracts 两端同步）；「看依据」展开 evidence 引文；「不要」把提议标记为 dismissed；「采纳」通过既有 `DurableMemoryService.applyProposal` 写一条**带出处**的偏好/约定记忆（inference 标记、置信度、来源都按 `production-owner-rules.ts:412-456` 的写法），并写一条决策记录。采纳不直接改任何执行逻辑——「雨天多留 10 分钟」要变成硬规则，必须以后走规则手册的类型+回归测试那条路（愿景原则 3：「规则不是记忆，是硬性设定」，product-vision.md:59）。
- 备选（考虑过，列为二期）：装配 ReflectionService/SuggestionService + 每日复盘任务。它的去重、配额、`suggestion.respond` 都是现成的，但生产库没有 ProactivityStatePort 存储，要新表 + 后台模型调用（后台调用遵守规则 15：指令固定在前、数据居中、时间在最后）。放在建议管线验证价值之后。

### 第 1 块：派出去的帮手 —— 最后，第一期先不做

**结论：现在不做「帮手」页。生产里不存在“模型把大事拆给子 agent”这件事，页面上没有真话可说；凑数展示工具调用回执会把“一次 bash 命令”冒充“一个帮手”，每个数字的定义立不住。**

- 分两步，第二步要主人同意：
  - **第一期（可选，便宜）**：不叫“帮手”，只在现有页面加一个诚实的“它今天在忙什么”：从持久的 capability invocation 回执 + worker_result 载荷（`sqlite-capability-invocation-operations.ts`、run_payload_artifacts `purpose='worker_result'`，前提 9）按日聚合，只显示记录产生时存下的字段：能力名/操作名、派发时刻、状态、所属对话（可点回对话）。后台命令不入列（内存态，重启即失，前提 9）。
  - **第二期（真帮手）**：给模型加一个 `subtask.create` 类工具，生产装配 `DelegationService + DurableDelegationStateAdapter`，把 `delegation.list/detail` 装进已装清单；子任务标题是模型派出那一刻写进 `subtaskRef` 的原话（前提 9 的 Delegation 实体），进度事件逐条追加。**代价**：这是工具集合变更——每个已有对话的请求开头会重建一次（规则 7 的既有取舍），必须 Andy 同意并留 ADR 记录；还有 worker 编排和预算管制的接线成本。原型里“看到第 2 家”的进度体验到这一步才有。

### 先后顺序与主人同意点

1. 第 4 块（读+停用+回滚+重新启用）——纯装配+一个新转换，最先。
2. 第 3 块第一期（changes 读模型 + grants）。
3. 第 2 块（advice 提议/采纳）。
4. 第 3 块第二期（workspace 投影 + stage/commit + 面容提交）。
5. 第 1 块第一期（回执聚合，可并入第 3 块的页面）。
6. 第 1 块第二期（delegation 工具）。

需要 Andy 点头才动工的：任何工具集合变更（1 的二期；2 若选模型工具通道）；`capability.reenable` 这个“恢复权力”的新转换本身（愿景原则 7：不得扩大自身权限，product-vision.md:63，这属于边界变更，应出 ADR）；提交按钮的启用；每日复盘后台调用若上（持续小成本）。

## 三、考虑过但不选的做法

- **第 2 块接 ImprovementCandidateService**：错配（补丁≠行为建议），且要候选工作区隔离平台，成本远超一张卡片的价值。留作“自造工具”主线的一环。
- **第 2 块直接装 Reflection/Suggestion 管线**：机制最贴原型，但存储缺失要新表、后台任务要预算管治，先用手动提议通道验证需求，避免第一铲子挖太大。
- **第 3 块第一期就上 workspace.list/detail**：投影无写入者，页面永远空；先接有真实写入者的 run_payload_artifacts。
- **第 1 块用关键词/正则从对话里“提取帮手标题”**：约束明令禁止，且违反「可读文字记录产生时存下、来源是模型或主人原话」。
- **重新启用做成 disabled→active 直通**：会把停用事务里撤销的 handle/任务悄悄“看起来恢复”，违背前提 4；驳回。
- **新开一套“手机专用 API”**：设备接口（ADR 0229）在配对页之外本就该走嵌入网页的现有网关接口，四块全部复用 gateway v2 的已装操作，不另起炉灶。

## 四、风险与反例

- **I-73 复发风险**：新增的 `workspace.changes.read`、`advice.*`、`capability.reenable` 每个都是新值，必须两端（contracts schema + 生产 delegate/控制平面 + 手机 UI）同一次改动里对齐，并进第 3 节的门槛 1/2。反例：手机先上按钮、后端没装 → 旧版生产直接 `OPERATION_NOT_INSTALLED`，页面报错而不是悄悄空转。
- **重新启用被滥用**：反例——停用后的能力靠重放旧命令恢复：语义指纹 + 回执幂等会拒绝重放（`governance-gateway-adapter.ts:678-684`），且生命周期校验 revision/lifecycle，测试要覆盖「停用后重放旧 disable 前的任何命令都无效」。
- **聚合页误导**：反例——把每次 bash 都算“帮手”，一天几百条；所以第一期回执聚合若上，必须按能力分组并标注粒度，否则宁可不上。
- **提交竞争**：prepare 后 HEAD/index 变了必须拒绝（CommitGateService:126-143 已实现），反例测试要断言 invalidated 状态。
- **成本**：全部装配类改动不新增模型调用；每日复盘若上，预算并入现有 dailyCostMicros（前提 S6，strict-configuration.ts:1067）；评测限于两三个真服务的集成用例，$0.5 以内。

## 五、需要人拍板的取舍

1. `capability.reenable` 是否算“扩大权限”需要 Andy 以 ADR 明确边界（我的立场：不算扩大——权限集合恢复到停用前主人批准过的同一份 manifest，且要面容+重新资格验证；但这必须他说了算）。
2. 第 1 块二期的工具集合变更换不换（每个老对话一次性缓存重建）。
3. 第 2 块“采纳”落成偏好记忆还是等待规则化——涉及愿景原则 3 的边界。
4. 提交按钮先走审批通道还是等 CommitGateService 全套。

## 六、证实与推测

- **读代码证实**：前提 1–7、9（含行号引用），控制平面缺 capabilityLifecycle、装配点在 `production-http-composition.ts:1114-1145`、`GitWorkspaceAdapter`/两个能力端口的 platform-node 实现存在、persistence 无 ProactivityStatePort 存储。
- **材料证实（我未亲核）**：rule-types 只有两种；ADR 0097/0213/0226 的决定原文；`DurableHostWorkspaceProjectionAdapter` 细节。
- **推测**：reflection 管线接入需要一张新表；模型对“帮手”的真实需求量；手机端这页走原生还是嵌入网页。

## 七、必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。四块全部走 gateway v2 的读操作/控制平面，产生的快照和回执只发给手机，不进模型请求；没有任何值写进系统提示或工具定义。唯一会碰的是第 1 块二期的新工具和第 2 块的提议工具：按规则 6/7（prompt-prefix.md:41-44）工具集合变更是允许的换新事由，但每个已有对话的请求开头会重建一次，必须 Andy 同意并留 ADR；换新后开头逐字节冻结。运行中产生的进度、建议交付这类每轮会变的值，只以追加消息（工具结果/背景通知）出现在末尾，后台复盘调用遵守“指令固定在前、数据居中、时间最后”（:67）。遮盖规则不变：新内容都是外来文字，照常走出口遮盖，历史存遮盖前原文、每次确定性重遮（:36）。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。快照里的列表全部显式排序（autonomy 适配器 `.sort()`，governance 用 `distinctSorted`，我方案里 run_payload_artifacts 聚合按 path、按时间+序号排序）；时间戳只出现在发给手机的 `generatedAt`，不进模型请求；建议去重键是证据引用排序后的哈希（`suggestion-service.ts:89-99`），确定；JSON 由对象字面量按固定键序构造。第 1 块二期若上，进度消息里携带的外部内容会经遮盖——遮法只取决于该消息及其前文（:52-54），不引入新的不确定性。
3. **有没有自动检查、反向用例会不会真失败？** 方案要求新增三道，全部先写反向用例：① `check:gateway-operations`：PRODUCTION_*_OPERATIONS 里每个名字必须存在于 contracts 注册表且有 fixture 往返、生产 delegate 必须有对应分支——手机调一个没装的操作、或清单里出现 contracts 不认识的名字，检查失败；② 快照契约检查：各控制适配器产出的快照必须能过 contracts 的完整 schema（现在 `parseSnapshot` 只查 `kind`，`governance-gateway-adapter.ts:144-151`——这正是 I-73 的缺口），字段漂移即失败；③ 生命周期门槛：disabled 直接 activate 抛错、reenable 无最近认证抛错、重新启用后旧 handle 仍 revoked 且 scheduled_jobs 仍 cancelled、资格验证失败则仍未激活——每条都有失败断言。既有的 `check:prompt-prefix` 反向用例（改写历史、系统提示带变化值、关冻结，:74）继续守住第 1/2 块的模型侧改动。
4. **每个新值的产生端和使用端都核过吗？** 逐个：`capability.reenable`（产生：手机按钮；使用：contracts 注册表+schema、installedOperations、控制平面 recent-auth 断言、生命周期 disabled→installation_proposed 校验——四端一次改齐）；`workspace.changes.read` 的 query/snapshot schema（产生：手机+contracts；使用：生产读模型、聚合处字段与 run_payload_artifacts 列一一对应）；`advice.*` 提议 id（产生端沿用 `rule-proposal:<32hex>` 的格式校验（production-owner-rules.ts:670），新前缀在 confirm/响应两端都校验）；采纳产生的记忆 id/出处沿用 `applyProposal` 的既有校验；提交走 `approval.respond`，semanticSnapshotHash + revision 双核对（governance-gateway-adapter.ts:758-770）已是现成两端校验；重新启用新句柄只能由新运行产生（invalidate 事务已保证旧句柄 revoked，sqlite-durable-operations.ts:2612-2651），使用端（运行时授权）只认 active 句柄。每道门槛（上面第 3 条）就是把“两端都认”变成机器检查，防 I-73 重演。
