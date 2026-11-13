你是独立的方案设计者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面只给了问题、目标和约束，没有给出任何人的方案；材料里如果提到某种做法，只作参考。先读代码弄清现状，再独立提出你认为最好的方案，不要假设已经有人想好了答案。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
输出格式：先列方案依赖的前提，每个前提附来源（文件:行或网址）和原话；再写方案本身、考虑过但不选的做法及原因、风险和反例、需要人拍板的取舍。把「读代码或来源证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 cd91001b934785b4f28fbd30c3b7da43e740b473。
问题、目标和约束：
# 材料：iPhone“Himawari 自己”页里四块功能怎样接进线上

只写问题、目标、约束和已核对的事实。下面没有线程的方案；任何列出的做法都只是参考，请不要局限于它们，从问题本身出发，提出你认为更好的方案。

## 问题和目标

iPhone 设置里要新增一组“Himawari 自己”（原型：docs 外的项目文件，见下面“要展示什么”）。其中四块要展示的东西，服务器上都有现成代码，但生产里没有数据来源，手机拿不到真实数据，这四行现在只能藏起来。目标：为这四块定出“生产里真正的数据从哪来、怎样让手机读到和操作、先后顺序”，并判断每块要不要做、做到什么程度。Himawari 的产品愿景见仓库 docs/product-vision.md：只属于一个人、自有优先、主权在主人、行动有边界、记忆可靠、规则是硬性设定（带出处和回归测试）、进化和自造工具必须可评估可回滚、不得扩大自身权限。

## 要展示什么（原型“Himawari 自己”页，四块）

1. 派出去的帮手：“在忙：比较三家酒店，10:12 派出去的，看到第 2 家”；“今天做完的：整理 11 月的发票，9:30，找到 14 张”。只能看。
2. 待采纳的改进：卡片“算出门时间时，雨天多留 10 分钟”，依据“这个月有 2 次下雨天你出门晚了”，按钮“看依据 / 不要 / 采纳”。
3. 代码和文件夹：“himawari-notes，在哪：MacBook Pro，它改了 3 个文件，它想提交：整理 11 月会议记录，notes/2026-11.md +42 −7”，按钮“先不 / 提交”，同意提交时要面容。
4. 能力重新启用：“它会的本事”行（点进去能停用、退回上一版）之外，停用后要能重新打开。

界面上给主人看的每个数字和判断词必须有可验证的定义；可读文字（标题、主机显示名、改了几个文件等）要在记录产生时存下，来源是模型或主人当时的原话，不得用关键词表、正则或写死模板拼。

## 已核对的代码事实（仓库 sixianli/himawari-agent，main 的 cd91001b）

A. 生产手机网关的装配在 apps/agent-service/src/production-approval-gateway.ts。读侧是 GovernanceGatewayV2ReadModel，它的 delegate 按查询类型前缀依次转给 memoryControl、webPushControl、observationControl、proactiveControl、museControl、ownerPreferencesControl、sensitiveInterceptionsControl，最后是 searchAuthorization；控制侧同理（含 workspace.copy.* 转给 workspaceCopies）。已安装的操作清单 PRODUCTION_APPROVAL_OPERATIONS 只有 approval.list、approval.detail、approval.respond、search.authorization.read、search.authorization.set（第 54–60 行），再按选项追加 copy、memory、web push、proactive、muse、observation、owner preferences、sensitive interceptions 各组。没有任何 delegation.*、improvement.*、workspace.list/detail、host.*、capability.* 操作。

B. 帮手。packages/application/src/services/autonomy-gateway-adapter.ts 里 AutonomyGatewayV2ReadModel 能回答 delegation.list/detail、improvement.list/detail，数据来自 DelegationStatePort（packages/application/src/ports/delegation.ts，实体 Delegation：parentRunId、workerRunId、subtaskRef（载荷引用）、预算、status created/running/validating/completed/failed/cancelled、workerResult.conclusionRef 等）。返回的是引用（ref）而不是可读文字。生产里（apps/ 下）没有任何地方构造 DelegationService（packages/application/src/services/delegation-service.ts）或 DurableDelegationStateAdapter，也没有 delegationState 的装配，所以没人往里写 Delegation。生产里实际存在的“派出去”是 apps/agent-service/src/production-runtime-tools.ts 里的 WorkerDelegationService（第 377 行）：把一次能力（工具）调用转给隔离的 worker 进程执行，记录在 capabilityInvocationReceiptPort / capabilityInvocationResultPort，不是“模型派子任务”，没有可读的子任务标题。生产里另有后台命令（production-background-commands.ts）。没有让模型把大事拆给子 agent 的工具。

C. 改进。ImprovementCandidateService（services/improvement-candidate-service.ts）处理的是“代码补丁候选”：字段 baseRevision、baseDigest、allowedPaths、patchRef、validation（命令观察）、comparison、artifactRef，要用 CandidateWorkspacePort（qualify 平台只认 macos/linux、create、patch、validate、compare、packageArtifact、quarantine）。apps/ 下没有任何地方构造它，也没有 ImprovementStatePort 的装配，没有人调用 propose。与此不同，生产里已有一条真实的“提议→主人点头才生效”的流程：apps/agent-service/src/production-owner-rules.ts（ADR 0213、0226、0209 决定 6）——主人明说“以后……”的规则直接生效并给回执卡；模型推断出来的只存成提议（proposalId 形如 rule-proposal:…，带 summary 一句话说明、quote 主人原话），主人在 Himawari 里确认才生效；规则带出处，规则手册有回归测试。规则类型目前只有 mail_must_notify、mail_read_whole_thread（packages/application/src/rules/rule-types.ts）。生产里另有每日复盘（reflection）相关服务（services/reflection-service.ts），但未核对是否接入生产。

D. 代码和文件夹。HostWorkspaceGatewayV2ReadModel（services/host-workspace-gateway-adapter.ts:618）回答 workspace.list、workspace.detail、host.directory.detail，数据来自 HostWorkspaceProjectionPort（durable-host-workspace-state-adapter.ts 里有 DurableHostWorkspaceProjectionAdapter）和 WorkspaceStatePort 里的 WorkspaceSnapshot（含 branch、head、files[].owner/state、taskChangeSetRevision）。生产里（apps/agent-service/src/production-workspace-copies.ts）只装了控制侧 HostWorkspaceGatewayV2ControlPlane 做“工作目录副本”的创建和选择，delegate 是一个一律抛错的存根；WorkspaceService（services/workspace-service.ts，负责拍快照、区分主人改的和任务改的）在 apps/ 下没有构造；写 workspace 投影的 stage/commit 命令没有装进生产的已安装操作清单。生产里真实存在的文件改动记录是 ADR 0097：每条 bash 命令执行前后各扫一遍授权工作目录，改动清单（新建/修改/删除，路径、大小、时间）写进这次运行的 run_payload_artifacts，并在命令结果末尾附一句摘要；执行代码在 packages/application/src/services/workspace-changes.ts 和 packages/platform-node/src/files/host-read-only.ts。授权目录（grant）有 hostId 和 displayPath。工作目录副本（workspace copy）有 baseline（grantId、canonicalRootId 等）。

E. 能力重新启用。CapabilityLifecycleService（services/capability-lifecycle-service.ts）里 disable 只允许 active→disabled，revoke 允许 active/disabled→revoked，uninstall 允许 disabled/revoked→uninstalled，没有任何路径回到 active；activate 只允许 installation_approved→active，并要重新验证产物摘要（artifacts.verify）和运行时资格（runtime.qualify，要求 productionSuitable 且各项隔离措施都执行）。disable 通过 store.invalidateCapabilityAuthority（packages/persistence-sqlite/src/sqlite-durable-operations.ts:2605）在一个事务里：保存 disabled、撤销该能力的全部 capability handle、把引用该能力的 scheduled_jobs 全部改成 revoked/cancelled。这些撤销之后不会自动恢复。apps/ 下没有构造 CapabilityLifecycleService，且生产已安装操作清单里没有 capability.list/detail/disable/rollback，所以“它会的本事”这一行的数据在生产里同样没装。

F. 手机读到的“引用”：网关查询返回的是载荷引用（PayloadRef），需要再读载荷库（payloads.readText / protectJson）才能得到文字；记录产生时存下可读文字的做法在别处已有（例如规则的 summary、quote）。

## 约束

- 每个新操作必须经过现有网关授权（面容/最近认证、回执、审计）。主人在手机上的同意动作要有回执；风险高的（提交代码、重新启用一个曾被停用的能力）要最近认证。
- 发给模型的内容只追加（.claude/rules/prompt-prefix.md）：改工具集合、系统提示、历史都会让已有对话的请求开头变化，属于需要主人同意的大改动；请指出你的做法会不会碰到。
- 不顾旧数据兼容；表结构一次只改一块；能动态获取的不写死；不用关键词表/正则/写死词典理解用户意思；测试不许用假替身。
- 生产机只有一台，不能为这件事多花钱；评测不得花超过 0.5 美元。

## 请你回答

1. 这四块，生产里真正的数据来源应该是什么（沿用上面哪套现成代码、还是换成别的现成来源、还是现在就不该做）？每块给出你的结论和理由。
2. 每块需要新增什么（读操作、写操作、存哪里、可读文字何时存、要不要改表、要不要动模型调用或工具集合）。
3. 先后顺序，以及哪些部分可以先做、哪些必须主人同意再做。
4. 能力重新启用要怎样做才不违背“停用时的撤销不能悄悄恢复”。
5. 你认为愿景里还有哪些该有、而这四块没覆盖到的能力（例如主人对子任务的取消、对改进的撤销、对重新启用后的健康检查与可回滚）。
