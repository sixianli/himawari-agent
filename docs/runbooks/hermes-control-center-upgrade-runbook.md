---
status: active
document_type: runbook
execution_risk: critical
contract_sha256: "sha256:beb8026c8531ad75b215fcc690a4421d19a15598dc6c1ecdd3b9c4498341f9a8"
supersedes: ""
superseded_by: ""
date: "2026-09-11"
---

# Hermes 控制中心升级与真实验收

<!-- runbook-contract:
- packages/persistence-sqlite/src/migrations/0032_runtime_history.sql
- packages/application/src/services/runtime-history-service.ts
- packages/runtime-pi/src/pi-native-history.ts
- apps/admin-cli/src
- apps/agent-service/src
- apps/control-center/src
- scripts/qualify-control-center-browser.mjs
- scripts/test-thread-loading-browser.mjs
- scripts/test-mobile-composer-browser.mjs
- apps/execution-worker/src
- packages/platform-node/src
- packages/application/src/ports/configuration.ts
- packages/gateway-contracts/src/contracts-v2.ts
- packages/persistence-sqlite/src
- packages/runtime-pi/src
- packages/runtime-pi/test/fixtures/rejected-current-task-context.ts
- packages/runtime-sandbox/src
- packages/runtime-sandbox/scripts
- scripts/package-node-runtime.mjs
- scripts/install-node-runtime.mjs
- scripts/probe-protected-runtime.mjs
- scripts/operations
- scripts/ci/artifact-files.mjs
- package-lock.json
-->

## Scope

升级用户已明确授权的 Hermes Linux 上 Himawari 安装。目标限定 `/data/hermes/himawari`，以及经用户单独同意后用于程序和运行依赖的 `/opt/himawari/releases`，不操作父目录中的其他 Hermes Agent 服务或其他应用。既有网络资格探针另外使用 `/data/himawari-r8-web-2026-09-11` 中新建的唯一临时子目录；执行前须验证此专用验收根为当前服务账号所有、0700、普通规范目录且位于 `/data` 机械盘，不访问其他同级目录。Mac 仅用于源码开发、浏览器和交付查看，不作为运行主机。此流程不执行跨主机 Authority Transfer，不创建 PR 或推送。

## Authoritative Sources

- [SOURCE: docs/execution/specs/2026-09-10-control-center-local-acceptance-design.md]
- [SOURCE: docs/execution/plans/2026-09-10-control-center-local-acceptance-plan.md]
- [SOURCE: docs/execution/plans/2026-09-07-srt-unified-execution-plan.md]
- [SOURCE: docs/adr/0027-built-in-owner-authentication.md]
- [SOURCE: docs/adr/0028-protected-runtime-installation.md]

原生历史修复的切换前资格入口为 `scripts/operations/hermes-native-history-qualify.py --qualify`。该入口只适用于 schema 32 原生历史候选及 v3 数据库副本演练通过的现场；在独立证据目录创建受保护候选，通过 systemd 私有目录视图把候选映射到最终安装路径，当前线上服务仍使用原安装。先核对真实签署者可读取工作区 device/inode 且目录身份不变，再由实际运行账号验证写入拒绝、完整核验复用与六组资格探针，成功后签署新安装事实。此步骤只新增候选安装、独立保护记录与资格证据，不改线上配置、数据库、服务单元或当前保护记录。通过不代表正式切换完成；后续仍须执行已核验停机备份、schema 迁移、旧历史导入、启动和真实模型验收。

若首轮停在 `composition-installed`，且独立诊断和同账号对照确认临时测试运行目录误用了正式安装保护记录，可使用 `scripts/operations/hermes-native-history-resume-qualification.py --resume`。此入口核对冻结脚本和既有诊断，只在该合成目录用例中不设置安装保护记录，继续使用完整文件摘要验证；正式安装权限与缓存探针保持启用。新结果写入 `attempt-v2`，保留首轮失败证据，六组通过后才发布签署结果。

正式原生历史切换入口为 `scripts/operations/hermes-native-history-cutover.py --apply`，只适用于其绑定的 Hermes 安装、签署摘要和十轮旧历史候选。停服前通过私有候选视图检查历史水位及真实启动配置和已注册能力语义；确认无活动 Run、无未释放沙箱后，停服创建并核验 schema 31 备份。新版 CLI 正常迁移到 schema 32，导入器通过普通仓库锁和 Authority 保存历史，随后切换安装、保护记录和启动入口。首次启动前失败时，先保存失败数据，再用同一已核验恢复点恢复旧 schema、配置、文件所有权和安装；这个恢复目标与范围须包含在本次具体执行授权中。首次启动已尝试后不自动回退数据库，防止丢失新接纳的工作；停止失败服务并保留现场。启动 ready 仍不能代替真实模型验收。

在 schema 32 已切换的安装上，后续 E2E 修复使用独立的安装候选与资格目录，不再次迁移数据库或导入旧历史。`hermes-ui-session-qualify.py --qualify` 绑定本次界面语言与令牌刷新候选的源码摘要，并复用已验证的签署顺序、权限保护和六组安装探针；在正式切换前保留当前运行安装及其保护记录。验收通过后，`hermes-ui-session-cutover.py --apply` 必须绑定本次签署摘要及当前安装摘要，核对无活动 Run 与未清理作业，停服创建并验证 schema 32 备份后只切换安装、启动配置与保护记录，不重做迁移或历史导入；首次启动前失败恢复旧安装，首次启动尝试后保留数据现场。语言选择仅控制 UI，不注入模型回答语言。页面只有收到服务器明确的 `HTTP_GATEWAY_CSRF_REJECTED` 时才在身份和 authority 均未变化的前提下更新令牌，使用原请求和原幂等键重试一次；网络失败或其他拒绝不自动重试。

通用 Harness 生命周期候选使用 `hermes-harness-qualify.py --qualify`，构建目录为 `/data/hermes/himawari/builds/2026-09-12-harness-lifecycle`，独立资格目录为 `2026-09-12-harness-lifecycle-installation`。该候选从 Cindy 借鉴工具结果指纹和有限窗口循环检测，并在 Pi 审批续跑快照中保留检测状态、排除已完成结果的本地重放；取消事件在 SessionManager 中保留原生类型，交由 Pi 在发往模型时转换。入口绑定当前 `a83239f9…` 运行时、候选源码归档、完整安装树和各辅助脚本摘要；先以真实运行账号检查六个页面资源及入口引用，再执行既有六组受保护安装探针并签署新证据。资格阶段不停止线上服务、不写产品数据库、不改变模型路由。循环中止与取消事件保真已有确定性测试；旧对话正确回答和多工具正常汇总仍需通过实际服务验收，不能把本候选签署结果当成这两项通过。后续切换使用 `hermes-harness-cutover.py --apply --receipt <本次签署摘要>`，绑定本候选资格目录及当前 `a83239f9…` 安装。入口先以实际运行账号再次核对候选页面，再确认无活动 Run、无未清理作业，停服创建并验证 schema 32 备份，核对候选启动配置和已注册能力后切换安装。当前启动器绑定 `2026-09-12-three-fixes-installation`；新启动器绑定本次 `harness-lifecycle-installation`。首次启动前失败恢复旧安装与配置；首次启动尝试后失败则停止服务并保留数据现场，不自动回退数据库。

`hermes-harness-finalization-comparison.mjs --compare` 用于已切换 `0d269e65…` 候选后的完成阶段诊断。只读取两条明确授权的四工具失败 Run：旧分支的 `run:cb547c58-80ea-42e6-8b90-4cfac81dcdf2` 和本次复测的 `run:d1872f77-4434-405f-af8c-ecb3cfbb485c`；先核对各四个作业均已清理、结果按原调用 ID 成对且全部成功。每条原始输入对照两种后续响应，各重复两次：原始工具选项，以及 Pi 在存在工具历史但当前工具列表为空时的 `tools: []` 序列化。所有消息、工具结果、推理和模型路由保持原值，不附加新请求，不执行返回工具。最多八次模型请求，本组预估上限 0.50 美元；费用合并所有前组实际费用、未知费用完整预留、新鲜产品费用及搜索预留，累计不得超过已授权 2 美元。结果仅导出结构、摘要、费用、工具状态标记及经既有产品脱敏器处理且不超过 2400 字符的合成验收回答。此步骤不写产品数据库、不更改服务或生产配置；通过只说明本次对照支持进一步设计完成阶段，不能据此关闭全部工具或宣称正式任务验收已通过。

Worker 阶段编号修正候选使用 `hermes-loop-identity-qualify.py --qualify` 与 `hermes-loop-identity-cutover.py --apply --receipt <本次签署摘要>`，绑定 `2026-09-13-loop-identity` 构建和当前 `7b05555b…` 安装。其前一版真实验收在第四次相同目录结果后仍请求第五次审批，已取消且没有执行第五次；原因是内置文件工具的 Worker 阶段编号与模型调用编号不同。此修正只在产品内置工具的受保护 `pi-result.v1` 结果中排除瞬时来源调用编号，保留其他来源与内容变化，自定义工具输出仍作为不透明内容比较。使用原有六组隔离安装探针、schema 32 备份核验和安装切换，不修改模型路由或导入历史。安装后须重新完成逐项审批循环中止及单次说明验收；四工具正常汇总和旧对话当前来源仍分别验证，不能相互替代。历史固定日期脚本的摘要属于原冻结入口，格式整理后的源码不能冒充原字节重新执行；本候选每个辅助入口重新绑定实际使用的脚本摘要。

## Safety and Preconditions

Pi 默认工具提示修复候选使用 `scripts/operations/hermes-three-fixes-qualify.py --qualify`，仅适用于其绑定的 UI-session 版本已经上线的现场。先验证本次源码归档、准备清单和全部安装文件摘要，再复制到独立候选目录；同样使用真实运行账号、最终路径的私有视图和六组安装探针。复制后的 workspace 链接必须指向隔离源码中的同名包，不能沿用构建目录的绝对链接。首次尝试若在链接保护阶段失败、且尚无探针输出或运行授权文件，可使用 `--resume-links`：核验安装文件与源码摘要、保留首次失败记录后，仅重定位身份匹配的 workspace 链接；任意其他外部链接仍然拒绝。此入口不切换线上版本。

签署者读取资格目录中的受保护源码清单副本，避免把旧候选的源码信息写入新签名。正式切换使用 `hermes-three-fixes-cutover.py --apply --receipt <本次 installation-receipt.json 的 SHA-256>`，须核对资格结果与签名摘要、旧安装摘要和服务入口；在没有活动 Run 时停止服务、创建并验证备份，再切换候选。保留既有 schema 32 和历史，不重复导入。新服务启动前的失败恢复原安装；尝试启动新服务后的失败保留现场数据供诊断，不盲目恢复旧数据库。

若新服务未就绪，使用 `hermes-three-fixes-startup-diagnostic.py --read-startup-errors` 导出限定长度、脱敏后的启动日志。检查最近日志时须包含 `service.failed` 等结构化事件，不能只筛选 `Error` 字样。`hermes-three-fixes-recover-service.py --restore-installation-only` 仅适用于本次绑定的启动失败：确认 schema 32、无活动任务、切换后没有新 Run，保存失败安装与当前配置后恢复旧安装及原配置，并重新等待 Agent、Worker 就绪。该恢复入口不恢复或覆盖数据库；出现新任务时拒绝继续，需要根据现场判断兼容性。

本次因缺失 `share/control-center` 触发的 `PRODUCTION_HTTP_STATIC_ROOT_INVALID` 使用 `hermes-three-fixes-cutover-v2.py --apply --receipt <本次签名摘要>` 重试。它只补入摘要已绑定、且与现用页面一致的六个浏览器构建文件；停机前在候选私有视图中，以真实运行账号检查静态根目录、全部文件和 HTML 引用，并重新计算运行时摘要，确认六组安装探针所签署的运行时代码未变。静态检查不通过时保持原服务运行。切换结果与备份使用独立的第二次尝试名称，保留首次失败与恢复记录。

本次三项修复回归另获最多 2 美元的模型与搜索调用授权，仅使用已有合成验收对话和验收文件。`hermes-three-fixes-observer.py` 以本次开始时间及三个固定验收 Thread 限定费用、任务和清理摘要，已结算调用计实际费用，未知调用保留预计费用。每次发起真实回归前核对新鲜摘要和配置中的每 Run 上限，为未决调用与搜索成本保留额度；没有可验证的剩余额度时不发起新调用。该观察器最多运行一小时，不执行模型或工具，也不导出对话正文、配置全文或凭据。

若真实模型在取得正确工具结果后仍串入旧任务或重复调用，先用 `hermes-three-fixes-model-diagnostic.mjs` 检查固定合成 Run 的消息结构、调用编号和结果摘要。`hermes-three-fixes-input-comparison.mjs --compare` 仅用于两个固定失败输入的离线对照：原输入、临时移除旧的明文推理、仅保留当前轮，各重复两次，最多十二次模型请求。后两种都是实验副本，不改写持久历史，也不是已采纳的产品方案；当前轮推理和工具结果保持不变，遇到旧签名推理则拒绝实验。它使用既有 OpenRouter 模型及凭据，在本次 2 美元授权内另设最多 0.50 美元的保守预估上限，运行前核对最新公开价格，并通过 OpenRouter `provider.max_price` 限定单价、拒绝额外按次收费，每次记录实际费用；费用缺失或超出预估立即停止，不重试。返回的工具调用只做摘要，绝不执行。证据目录排他创建，阻止重复启动；读取生产数据库时启用只读模式，输出限定结构和已知标记，不导出消息原文或凭据。该模型对照费用单独记账，必须与产品观察器费用合并核对，不能只看产品预算表。

在上述对照仍复现故障时，`hermes-three-fixes-provider-comparison.mjs --compare` 保留两个输入的完整历史及本轮推理，以 OpenInference、DeepInfra 两个公开可用上游为对照；四工具输入另比较仅提取本轮 `pi-result.v1.content` 的原生文本。每个条件重复两次，合计最多十二次非流式请求，输出上限 4096 token；天气输入不做无意义的工具包装变体。两种输入差异和上游差异分别记录，不能用单个成功样本推断根因。路由保留原有数据收集和 ZDR 约束，原路由若排除任一目标则拒绝运行；每个请求固定一个上游且不回退，并根据最新端点价格设置上限。开始前只读核对本次产品已结算费用、上一组对照实际费用，另保留 0.25 美元搜索额度；本组预估最多 0.50 美元且三者合计不得超过本次 2 美元授权。未决产品费用、价格异常、响应上游不符或费用缺失即停止。脚本不修改正式路由、历史或工具结果，不执行模型返回的调用，使用独立排他证据目录，仅输出摘要。

若 provider-comparison 在第二个 DeepInfra 请求超时停止，`hermes-three-fixes-tool-content-comparison.mjs --compare` 只补做尚未执行的四工具结果格式对照：固定原失败 Run 及四个工具调用编号，保留全部历史与本轮推理，在 OpenInference 分别发送原包装和仅提取本轮原生文本的实验副本，各两次，合计四次。它校验前一脚本的冻结摘要、前一结果确为第二次调用超时，并将该组全部预估费用继续预留；不重试超时请求。继续使用只读数据库、当前结算费用核对、每组最多 0.50 美元和累计 2 美元约束，以及原有数据收集和 ZDR 约束。输出仅供判断输入格式的影响，单独成功样本不能代替真实产品回归。

当历史删减和本轮工具文本提取都不能消除重复调用时，`hermes-three-fixes-provider-matrix.mjs --compare` 用两个原始失败输入对照 OpenInference、BaseTen、DeepInfra，分别固定 `open-inference/fp8`、`baseten/fp8`、`deepinfra/fp8` 端点，按对应端点定价；保留所有消息、工具定义及推理，各条件计划两次，最多十二次请求。输出上限统一 4096 token，单次等待上限提高到 240 秒；某上游第一次请求失败后，跳过该上游剩余样本，继续其他上游。失败或费用未知的请求按全部预估费用占用预算，不算免费，也不自动重发。响应上游不符、认证拒绝或总费用超界则停止整组。运行前合并本次产品新鲜已结算费用、首组输入对照费用、超时组全部预留和四次格式对照费用，继续保留搜索额度；本组预估上限 0.50 美元、总授权上限 2 美元。每个请求按公开最新端点最高价格设置 `provider.max_price`，保留原数据策略，禁止回退和执行返回工具。该入口只产生独立实验摘要，不修改生产模型路由；有完整对照结果后才决定是否存在可采用的上游路由修复。

`hermes-three-fixes-task-context.mjs --compare` 验证通用上下文扩展的效果：固定当前生产配置指定的单一端点，使用同样两个受保护的原始失败输入，各对照原始输入和本轮状态提醒两次，最多八次请求。不切换模型或提供商、不改写历史、不执行返回工具。提醒文本来自已编译并绑定摘要的候选模块。2026-09-12 对照中该候选四个样本仅一次天气通过、两次多工具均失败，已从运行时撤回；源码保存在 `packages/runtime-pi/test/fixtures/rejected-current-task-context.ts`，仅用于核对既有实验，不能作为当前产品能力或上线方案。费用合并所有前组实际费用及未知费用预留，保留搜索额度；本组上限 0.50 美元、累计授权上限 2 美元。原始消息、调用 ID、工具结果和推理逐字保留，仅在完整结果批次之后附加当前请求和返回状态。该组非流式对照通过后仍须真实服务流式验收；循环中止不能算正常任务完成。

用户已授权在 Hermes 安装、使用机械盘、复用现有 OpenRouter 凭据进行累计不超过 1 美元的验收，并批准内置账号登录。2026-09-12 全功能 E2E 另获最多 2 美元模型与搜索预算，优先使用 DeepSeek V4 Flash 0731；两笔预算分别记录，不能把额外上限当作剩余额度。模型调用只使用验收文本，文件操作只针对明确授权工作目录的验收文件。预算包含已发生费用及不能确定实际费用的预留，不将失败调用算作免费。

当前目标是 `hermes-home`，SSH 为 `hermes`，Cloudflare 认证无法及时完成时使用已授权的 `hermes-tailscale-breakglass`。公开入口是 `https://himawari.siyi.win`，保留现有 Cloudflare Access 和 tunnel，只更新本机 127.0.0.1:18082 的产品服务。不得改变其他账号、网络规则或共享磁盘挂载。

## Live-State Preflight

只读核对主机名、Linux/架构、`findmnt /data` 与磁盘可用空间；核对 `systemctl cat/status himawari.service`（受保护迁移后的系统级服务，运行账号必须为 `himawari`） 的真实单元、PID、安装前缀和工作目录。检查生产配置的 Owner/Agent/deployment 与现有 authority、数据库记录一致，记录活动 Run 和已发生/预留费用，禁止输出配置全文或密钥。确认配置、state、qualifications 均是规范路径且权限安全，旧发布目录保留且可回读。

新建证据运行 ID 后，将白名单源码清单、SHA-256、秘密扫描结果和真实命令结果写入本次证据目录。工具链使用固定 Node 22.22.3/npm 11.8.0，依赖闭包来自精确 lockfile。构建、开发依赖、临时探针和数据库放在 `/data`。用户授权 NVMe 迁移时，仅完整安装前缀中的程序、运行依赖和静态页面复制到 `/opt/himawari/releases/<版本>`；先核对根盘确为 NVMe、剩余空间至少 10 GiB 且复制后仍保留该余量。数据库、附件、日志、备份与构建缓存继续位于 `/data`。

## Procedure

NVMe 迁移保持已签名能力的规范运行路径不变：在服务私有挂载视图中，用 `BindReadOnlyPaths=/opt/himawari/releases/<版本>:/data/hermes/himawari/releases/2026-09-11-control-center` 将固态盘的受保护安装挂到原路径。宿主上的旧机械盘安装保留，作为切换前回退源；服务实际读取的设备必须通过其挂载命名空间内的 `findmnt`、`stat` 和 `/proc/<PID>/exe` 独立核对，不能只看路径名。新版本的资格探针必须采用完全相同的只读绑定视图，并重新签署实际运行时摘要。切换脚本只替换保护记录、启动入口和绑定配置，不重命名或覆盖旧机械盘安装；后续升级必须检查现有 `BindReadOnlyPaths`，不能继续套用只替换宿主旧目录的脚本。

Agent 在创建沙箱服务时完成本进程的首次安装校验，校验失败不得进入 ready。Worker 的独立校验不能代替 Agent 的校验。受保护安装仅复用安装身份及文件身份、权限、大小和修改时间均一致的程序摘要；每次仍检查保护记录、进程权限、父目录、工作区和执行授权。外置或未受保护程序保留逐次字节校验。首次校验、不同 runner 之间的复用、权限变化和失败重试均须通过自动化回归；记忆检索及其参与问答的流程保持完整，不添加空记忆跳过路径。

迁移前先保持旧服务运行，在独立资格目录验收写入拒绝、六组现有 Linux 探针和实际 host verification 的首次及重复耗时。全部通过后确认无活动 Run 和未清理沙箱，停服创建并独立核验 schema 32 备份，再切换绑定、保护记录和启动配置。首次启动前失败恢复旧 unit、保护记录、配置及 attestation；首次启动已尝试后保留数据库和失败现场。Agent 与 Worker ready 后，再通过真实请求测量记忆检索、搜索启动和完整回答耗时；安装探针通过不代表问答已通过。

仅修改控制中心资源的修订可以采用静态资源切换：先核对候选提交相对当前生产提交只改变浏览器实现、对应测试及运行手册，依赖锁、Gateway、Agent、Worker、数据库和受保护运行时字节均不变。在 `/data` 的独立目录构建浏览器资源，执行移动端与完整浏览器验收；随后将新资源以 root 持有、服务账号只读的权限复制到静态目录，保留旧的带内容摘要的资源文件，最后原子替换 `index.html`。切换前保存旧入口及每个文件的摘要；切换后回读 HTTP 返回的入口和资源，复查原服务 PID、运行时摘要与核心健康状态。失败只恢复旧入口，不回滚数据库。此流程不重启服务、不更换运行时资格、不重签工具；只要运行时或依赖发生变化，就必须执行下面的完整安装资格与切换流程。

循环退出候选使用 `scripts/operations/hermes-loop-finalization-qualify.py --qualify` 和 `hermes-loop-finalization-cutover.py --apply --receipt <已核对的摘要>`。入口绑定 `2026-09-13-loop-finalization` 构建、源码清单、完整安装文件集、启动与签署脚本，以及当前运行时摘要；沿用六组受保护安装探针。安装验证期间保留线上服务，切换前核对没有活动任务、沙箱资源已释放、schema 32 和备份可恢复，切换只替换安装与已签署配置。此候选修复循环结果指纹中的调用编号干扰，并允许循环中止后最多一次受费用准入约束的说明；正常多步任务保留活动工具。检查源码回归和直接导入打包模块的回归结果，随后仍须真实浏览器验收，不能把循环中止后给出说明算作四工具正常完成。新启动前失败沿用安装恢复；新启动后失败保留现场并诊断，不覆盖对话数据库。

1. 检查本 Runbook 静态合同。只传输已审阅且通过秘密扫描的源码白名单；不打包配置、凭据、真实数据或历史浏览器证据。构建安装到本次独立发布目录，保留旧版本。
2. 打包统一文件和目录权限，禁止 group/other write。安装固定 Pi 工具普通文件后，针对实际安装树执行 Pi、组合、网络允许/拒绝、Worker 崩溃清理及公开搜索探针。固定探针使用合成数据；必须验证真实 namespace 释放、安装字节摘要、实际工具和 provider 返回，不能复用旧资格或伪造结果。任何产物变更后重新执行受影响资格。
3. 实测通过后，使用该主机既有受保护签名源签署本次安装事实，保存证据摘要、runtime/runner/system tool 字节摘要及精确能力上界。Pi 探针使用与正式 Worker 相同的 5 秒清理期限。Pi write/edit 使用 verified_effect，并要求安装的 Pi 程序在实际回读成功后生成内容摘要、字节数和路径；Worker 将原受保护输出绑定到持久证据，Agent 再核对原调用、Grant 和输入。不能以 exit 0 代替效果校验。bash 本轮只读，退出事实为 not_asserted。搜索为独立 fixed_read 程序，出口仅 `mcp.exa.ai:443`。两者都要求既有目录 Grant 和动作/披露授权。用户明确开启“允许联网搜索”后，固定 Exa 搜索可从服务端设置派生精确的一次性 Grant，记录真实的 policyAuthorization 来源；关闭设置后，旧派生 Grant 在消费和 Sandbox 准入时失效。该设置不授权其他工具、附件或任意网络出口。配置中的搜索路径或模型披露身份改变时，设置失效，须重新确认。
4. 在切换前复查旧服务无活动 Run。停止已核验的 `himawari.service`，检查旧 Agent/Worker 退出与锁释放；使用正式 backup create/verify 命令保存并核验恢复点：优先旧安装；若已复现旧备份缺陷，可使用经回归与安装资格验证、schema 相同的候选 CLI 完成备份，不改写旧数据或放宽验证，同时私密保留配置、单元和旧签名启动器。不能删除活动锁或清理未知子进程。
5. 用新安装的 `db migrate --confirm APPLY_MIGRATIONS` 升级同一数据库。该命令在停机独占锁内用 SQLite backup 创建并校验同主机迁移前快照，存于 state/data 下新建的 0700 目录，文件 0600；输出 snapshotPath，重复执行且无待迁移时不再创建快照。此快照不替代步骤 4 的完整恢复点。保留原 Owner、Agent、部署、对话、授权和受保护 Payload。只有没有外部 Owner 绑定时才通过 `account create` 建立内置账号；已有绑定不得自动覆盖。Hermes 当前保留 Cloudflare 产品登录，内置账号迁移须明确确认具体 Owner 与会话撤销影响后另行执行。密码输入和验证器设置只放在 0700 目录中的 0600 文件。
6. 通过 `workspace grant` 授权已核验的工作目录，并明确确认其规范绝对路径；默认仅 read/create/update，不代替动作审批。通过 `capabilities register` 显式确认合格部署快照摘要并写入现有 Registry；不得手工插入批准或资格记录。
7. 更新已核验的同一 systemd 用户服务启动路径。启动器每次核对主机、签名、证据和实际 runtime 字节，再生成本次启动快照；随后启动独立 Worker 与 Agent。初次握手使用配置的 Worker 请求期限，须等待实际 service.ready，不能以 systemd active 代替就绪证据。运行中复查快照原字节，不能因启动超过五分钟失去能力，也不能接受被修改的快照。
8. 使用真实浏览器登录原 HTTPS 入口，完成聊天、多轮上下文、工具审批与文件、公开搜索、停止、刷新和服务恢复。实际调用沿用预算与披露校验；不把通过 HTTP 或受控测试写成真实模型验收。

仅浏览器静态资源变化时，服务端安装字节与资格保持不变；先验证可移植 Web 构建、体积和安全检查，按显式清单校验上传的静态文件。先安装带内容哈希的新资源，对同名文件要求字节完全一致，再保存原 index.html 并原子替换入口。保留旧资源以支持正在打开的页面，不为网页更新重启 Agent/Worker。最终在正式 URL 刷新验证，分别记录服务端资格版本与 Web 资源摘要。

`hermes-harness-continuation-gate.mjs --compare` 是未接入生产的继续工作对照。它保留上述两个四工具失败输入的全部历史、路由、推理与结果，将后续工具列表替换为仅含 `continue_work` 的实验选项：资料足够时直接回答，仍需工具时返回所需工具名及原因。另从较短验收线程的真实 `ls` 结果构造“先列目录，再读取 script.py 解释其行为”的未完成任务，移除其余三个调用及结果并明确记录为合成样本；此样本用于验证不会把多步任务提前结束，不能冒充真实已执行的读取。每个样本分别保留原始工具和实验选项，各重复两次，最多十二次请求。本组上限 0.50 美元，累计仍为已授权的 2 美元，额外纳入前组八次汇总对照费用；不执行任何返回的工具、不修改数据库、服务或模型配置。脚本绑定当前 `0d269e65…` 安装和两个固定诊断辅助模块。输出仅保留有长度限制的脱敏回答、继续原因、工具名和费用。空工具对照四次成功汇总仅证明在固定输入下可生成答案，不证明已找到正常任务的结束条件；本组仍需人工核对正确汇总与必要续跑，且通过后仍须真实 Pi 与服务流式验收。

用户于 2026-09-13 另行明确选择“允许 8 小时完整 sudo，接受整台主机的 root 权限范围”。仅此临时授权允许执行 `hermes-temporary-sudo.py --grant-eight-hours`：在 Hermes 的 `/etc/sudoers.d/99-himawari-codex-20260913` 创建 `andy` 可作为 root 执行任意命令的免密码规则，使用 sudo 的 `NOTAFTER` 限定从安装起八小时，并由固定 systemd 定时器调用 root 持有的 `/etc/himawari/codex-sudo-expiry-20260913.py`，核对规则摘要后删除该条规则。此权限在系统层面覆盖整台主机；本任务仍只执行已授权的 Himawari 工作，不自动延长授权。它是对本 Runbook 项目路径范围的显式账户权限例外，不能泛化为后续任务的默认权限。安装前验证主机、账号、父目录所有权、目标与定时单元不存在及整个 sudoers 配置；先准备规则并通过 `visudo`，启动清理定时器后原子安装，再从 `andy` 身份忽略缓存执行 `sudo -n -k id -u` 验证。失败时撤销本次创建的规则与清理入口。用户在自己的终端输入密码，脚本不接收或保存密码。安装回执写入 `/data/hermes/himawari/qualifications/2026-09-13-temporary-sudo/receipt.json`，代理须读取实际到期时间。到期阻止新 sudo 命令，不能撤销已完成的修改或自动停止已启动的服务；重启后即使临时清理定时器丢失，规则自身的到期限制仍保留。若规则被修改，自动清理拒绝删除并保留诊断。需要提前撤销时，仅删除该临时规则并重新检查 sudoers，不覆盖系统已有规则。

## Verification

手机输入区遵循已确认原型的单行附件、执行菜单、模型、发送按钮顺序；搜索授权仅在执行菜单中展开，思考深度位于模型菜单内，运行时停止按钮占用发送位置。`scripts/test-mobile-composer-browser.mjs` 使用现有 HTTP fixture，通过 Gateway 边界提供生产同类的模型及搜索控件，检查三语、320/393/430 像素宽度、长模型名、菜单位置、较矮视口和运行状态。几何断言检查同一行、无重叠、触摸区域和视口内可见性，失败截图保留在报告目录；同时运行完整浏览器验收。模拟 WebKit 不等于真实 iPhone 软键盘或第三方浏览器已验证。

连接与侧栏修订的候选须同时包含 HTTP Gateway 和控制中心资源。空闲 SSE 在 HTTP 身份校验后立即发送不含业务数据的注释帧；订阅授权仍由 Gateway 执行。浏览器切换标签页时保留健康连接，握手超过 10 秒会关闭并按既有退避重试。验收需覆盖无新事件时建立连接、标签页恢复、断网重连及会话撤销，不能以单次健康响应代替。侧栏验收从新建、折叠搜索、置顶和最近分组进入；管理页面通过底部“管理”菜单打开，未启用页面在该菜单内展开。核对桌面收起恢复、手机抽屉、三语和键盘焦点。 对话首页不再展示全局加载提示，首次列表使用占位条，正常后台刷新保持现有消息和草稿。以 `scripts/test-thread-loading-browser.mjs` 实测 3 秒慢请求、失败重试、空列表刷新、手机直达链接失败及快速切换；重试应替换旧读取而非等待其结束。完整浏览器验收还须证明聊天和管理页面断网时立即禁止联网操作，联网后恢复。隔离浏览器报告不能替代 Hermes 上对应版本的实际验收。

此次后端修改会改变运行时摘要。历史固定日期的资格与切换脚本只用于各自绑定的冻结候选，不能直接复用于本修订。部署前必须从明确的提交及获准附带的工作区改动准备独立候选，重新绑定源码、安装、脚本与当前安装摘要，完成既有安装资格探针和停机备份前置检查。未完成该准备或未获本次切换授权时，不执行线上变更。

Schema 32 增加受保护原生历史快照、Run 内顺序和 Fork 固定引用。迁移须先取得既有机制核验通过的停机备份；升级后回读 `run_payload_artifacts`、对应 Payload 密文和 `thread_fork_lineage.runtime_history_json`，核对旧 artifact 内容未变、外键完整。恢复与迁移须保留清单引用的所有消息 Payload，不能只搬运聊天正文。重启后以新 Run 验证旧工具调用/结果可见且不重新执行；取消后核对实际结果及新请求，不能仅看服务 ready。旧 Trace 没有自动导入为完整历史，不能由 schema 升级推断旧会话已修复。回退需要匹配旧版本的整套已核验数据库备份，禁止旧二进制直接打开 schema 32，也不手工删除 migration ledger。

必须回读正式服务 PID、安装路径、握手和真实 Run 状态。SQLite quick check 通过且旧记录保留；模型与工具记录按轮持久化；文件内容须从主机独立回读确认。批准前不能产生文件或出口；拒绝后不能执行。搜索显示实际来源及查询时间，过期资料必须明确说明。重启后身份、聊天、草稿边界及旧结果符合合同，不能重新执行原工具。

v5 已完成后的服务恢复验收可使用 `scripts/operations/hermes-protected-acceptance.py --restart-and-observe`。管理员通过限时独立 systemd 单元启动；入口核对受保护版本、账号和无活动 Run，再重启同一系统服务一次，并读取新 Agent/Worker 就绪事件。随后最多观察十五分钟，只导出两个固定合成对话的 Run 状态、工具清理事实及总费用和未结算预留；不导出正文、Payload、凭据或原始日志。输出位于本次独立 `attempt-v5/live-acceptance/`，该目录存在时拒绝重复运行。观察本身不调用模型；真实浏览器测试须依据导出的剩余预算再准入。新取消和完成 Run 均终结后提前结束观察；窗口结束不等于验收成功。

搜索时间标注候选使用 `hermes-search-time-qualify.py --qualify` 和 `hermes-search-time-cutover.py --apply --receipt <本次签署摘要>`，构建及资格目录分别为 `2026-09-13-search-time`、`2026-09-13-search-time-installation`。入口绑定当前 `4c2ffd5d…` 安装、完整源码归档和候选文件摘要。此候选只为检索源中带 `Z` 的发布时间明确标注 UTC，不改模型连接、路由、日期值或引用正文；日期缺少时区时不推断。先以锁定的 npm 11.8.0 和原锁文件执行完整 `npm ci`，保留工作区自己的依赖，核对 `packages/platform-node/node_modules/zod` 为 4.4.3，不能只复制根目录依赖而遗漏 MCP SDK 使用的版本。候选 SQLite 预编译模块与原本本地编译模块字节不同，须通过数据库测试及六组实际安装验证后再签署。复制资格源码时仅忽略根依赖目录并单独复制，保留工作区内依赖；全部符号链接继续接受既有内部路径验证。切换前确认无活动 Run、无未清理作业，创建并验证 schema 32 备份，只切换安装和启动配置；原安装保留在 `2026-09-13-before-search-time`。不重导历史、不覆盖数据库，首次启动前沿用安装恢复，首次启动尝试后保留现场。切换后在已授权合成旧对话中核对本轮搜索、源日期及回答，不能以静态时区标注测试代替实际回答验证。

完整测试使用 `/data/himawari-tests-20260913` 中新建的独立临时目录，根目录必须为部署账号所有、0700、普通规范目录且位于 `/data`。测试 shell 使用 `umask 077` 和正式 `vitest.workspace.ts` 的项目配置，不能用 `/dev/shm` 引入与只读 `/dev` 重叠的测试根，也不能遗漏集成项目的 30 秒超时设置。此目录只供隔离候选测试，不扩大生产工作区范围。

中文正文中的自动来源链接修复使用 `hermes-source-links-qualify.py --qualify` 与 `hermes-source-links-cutover.py --apply --receipt <本次签署摘要>`，构建目录为 `2026-09-13-source-links`。候选只更换 `share/control-center` 的 HTML 和主 JavaScript 资源；运行时目录每个文件与已安装搜索时间候选相同，资格入口强制摘要仍为 `a9b48f67…`。自动识别的网址在中文标点前结束，剩余正文继续由 Marked 解析；显式 Markdown 地址和原生 Unicode 路径不截断。停服前沿用页面检查、真实账号保护和六组资格探针，切换入口绑定当前搜索时间安装和本次签署，创建并验证 `before-source-links-2026-09-13` 备份后更换安装与启动入口。旧安装保留在 `2026-09-13-before-source-links`，schema 32 与历史保持不变。浏览器复测直接打开已保存的合成天气回答，核对两个实际链接的 href 不含中文句尾，不增加模型请求。现有恢复与首次启动后保留现场规则继续适用。

## Evidence

主机原始证据限定 `/data/hermes/himawari/qualifications/<本次运行 ID>/`，私有输出目录 0700、文件 0600。独立运行账号方案下，外层目录可由 root 持有并设为 0711，以便部署账号和运行账号分别访问各自私有子目录；仅经过字段筛选、不含凭据或用户正文的资格签名、权限验证摘要和错误码由 root 以 0644 发布。配置全文、私钥和原始错误日志仍保持私有；公开可提交副本限定 `test/qualification/evidence/hermes-web-2026-09-11/` 与 `test/qualification/evidence/runtime-history/`，仅保留脱敏摘要、公开合成验收、截图与运行结果。密码、TOTP、恢复码、私钥、配置全文及真实用户 Payload 不进入仓库、日志、模型或聊天。

## Rollback

切换前失败保持旧服务。切换后失败先停止本次服务，保留新状态与失败证据。仅代码兼容且 schema 一致时可恢复旧前缀；schema 已升级时不得直接让旧二进制打开新数据库。数据库恢复必须使用已核验恢复点的独立目标并再次核验身份，不能覆盖当前数据；未获该具体恢复授权时保留停机现场，报告所需决策。不得自动撤回已执行外部动作或清除未知结果。

## Stop Conditions

主机、路径、身份、预算不明确；静态合同或实际安装验证失败；签名/摘要/权限/namespace 证据不匹配；活跃 Run 无法正常停机；恢复点不通过；迁移、身份、握手失败；需要放宽授权、访问其他用户数据或修改 Cloudflare 策略。停止依赖步骤，继续不依赖它的源码修复和验证。

## Troubleshooting

`SANDBOX_HOST_PATH_UNSAFE` 先核对精确路径及 mode，以及 SRT Unix socket 路径长度；生产 jobId 使用完整 SHA-256 的 base64url 编码缩短目录名，外部恢复 ID 合同不变；重新正确打包和验证，不放宽检查。Provider 429 显示限流/过载，保留未知费用与失败记录，不伪造完成。`result_unknown` 检查原环境终态及 namespace，不能通过清空占用重跑。SSH 未认证先使用已授权替代链路；不得打印 Cloudflare 一次性认证链接中的令牌。

未配置受保护安装时，完整安装校验在独立工作线程逐字节读取全部文件，保留路径、权限、文件身份和前后变化检查，不使用跨任务校验缓存。验证 Node 源码入口与安装后的 JavaScript Worker 均能加载，校验摘要必须与原算法一致。

ADR 0028 的受保护 Linux 安装是上述逐次全量校验的显式替代路径。迁移前准备独立系统运行账号、由 root 保护的安装/启动入口和 `/etc/himawari` 中的版本记录，保留部署账号管理权限。账号不得加入 sudo、Docker 或其他特权组；systemd 使用 `User=himawari`、`NoNewPrivileges=yes`，子进程明确继承 `HIMAWARI_RUNTIME_PROTECTION_FILE`。运行数据和私有秘密仍由运行账号持有；签名私钥不能交给它。Himawari 自有父目录只给予必要穿越权限，不公开同级服务。共享的 `/data/hermes` 属于另一套 Hermes Agent，其权限会被该服务重设为 0700，不能依赖一次 chmod，也不得停用它的安全加固。系统单元以 `TemporaryFileSystem=/data/hermes:ro,mode=0755` 和 `BindPaths=/data/hermes/himawari` 提供私有目录视图，宿主父目录保留原所有者和 0700。root 持有安装及保护记录的要求保持不变。启动时可写的能力快照和 attestation 放在私有运行数据目录，不能要求服务修改受保护资格目录。

停服前先以新账号在同样的 systemd 私有目录视图中验证：父目录由 root 持有且为 0755，仅能看到 himawari 子目录，映射目录的 device/inode 与原目录一致，Node 确实可执行。此检查失败时保留原服务，不能先停服再验证账号能否启动解释器。正式单元和六组验收均使用相同视图、NoNewPrivileges 和 capability 限制；限定临时单元设置运行期限，并在异常后停止、释放。

切换前以新账号实际执行 `scripts/probe-protected-runtime.mjs`，仅使用本次安装中的 `protection-probe/sentinel.txt` 和 `/data/himawari-r8-protected` 独立验收 scratch；首次新建前确认路径不存在，创建后验证规范路径、运行账号所有及 0700。若继续已确认回退的失败尝试，仅复用已核实归属的该验收目录，旧证据保留并为新尝试另建输出目录。必须证明覆盖、chmod、删除、父目录替换、版本记录写入及 Docker 控制访问被拒绝，同时临时工作区读写成功；记录首次完整审计及后续十次核验耗时和完整摘要调用次数。该探针不代表完整工具或模型响应时间。继续以相同非特权账号、NoNewPrivs 和最终安装路径执行六组现有 SRT/Pi 探针，重新签署实际资格后才替换原用户单元为系统单元。候选失败时不启动新服务；权限迁移后的回退须同时恢复原运行身份和私有数据权限，不能只改 ExecStart。管理员必须停机升级，不得原地热改活动安装。无管理员认证时只准备脚本和候选，保留旧服务。

账号迁移须按步骤核对每个进程实际读取路径时的身份。部署签署者仍为部署账号时，必须在私有工作区交接给运行账号之前读取并签署其 device/inode；签署完成后交接所有权，再由迁移程序及新服务核对路径和 device/inode 未变。不得让部署签署者依赖已经归运行账号所有的 0700 工作区，也不得通过放宽私有目录权限解决顺序错误。仅在迁移前旧账号下运行检查不能证明迁移中各阶段的可访问性。

本次 v4 失败后的修复入口为 `scripts/operations/hermes-protected-migration.py`，与同目录三个 `.mjs` 程序一起部署，辅助程序必须符合入口内绑定的 SHA-256。此入口仅适用于已核实的 v4 回退状态，不是通用升级器。`--check` 只读核对现场；`--apply` 仅能由管理员通过独立 systemd 单元执行，并再次核对现场。新证据限定 `qualifications/2026-09-11-protected/attempt-v5/`，该目录已存在时拒绝重跑，保留现场供检查。

停服前，先在新证据目录的合成工作区执行同一所有权交接函数，用真实 `andy` 和 `himawari` 身份验证：签署读取在交接前成功，交接后新账号可读取且旧账号被拒绝，原 device/inode、0700 权限和文件内容不变。随后以正式签署者核对实际工作区和签名源的可读取性，不输出私钥。正式六组探针使用独立 scratch 作为 HOME；签署成功之前，所有生产运行数据仍由旧账号持有。签署后才统一交接运行数据，并在交接前后比较目录身份。签署失败时不交接数据；部分交接失败时进入已停服状态下的原有权限恢复流程。macOS 上的受控回归测试不替代这次真实 Linux 账号演练、最终保护验证和服务验收。

资格探针的 stdout 必须是一个可直接解析的 JSON 值；Vite 依赖预处理、警告和其他诊断均写到 stderr。验证冷缓存时也必须满足该合同，不能依赖缓存恰好已热身；签署端保持严格解析，不通过截取 JSON 或忽略任意前缀把污染输出当成合格证据。

长时间的特权迁移必须由 systemd 后台单元接管，使用固定单元名和 root 所有的独占锁防止重复运行；不得把 SSH 终端、前台 `sudo` 或调用方输出管道的存活作为迁移成功的前提。启动命令返回后，通过单元状态及原子写入的阶段记录观察进度。记录应先持久化，再输出日志；关闭输出管道不得导致迁移退出。捕获可处理的终止信号并走已有回退，强制终止或主机断电后不能仅凭旧阶段记录自动重跑。

若在“安装目录已切换、正式服务尚未启动”阶段中断，先核对两个服务均停止、无遗留资格验证进程、原安装和备份完整、配置未变、数据库无活动 Run、安装归 root 所有且运行数据归专用账号所有。只针对核实后的阶段恢复，保留旧验证输出，在新输出目录重新执行资格检查；不得重复交换目录或把不完整输出签署为通过。后台恢复依然需要管理员认证，该认证由用户在 Hermes 终端完成，不通过聊天传递密码。

模型配置中的 `reasoningRequired: true` 用于 Provider 明确要求思考的端点，需同时 `reasoning: true`。确认菜单不再提供 off，当前轮记录保留实际选择。审批详情必须能显示含斜线和中文的目录目标；不得将加载失败当成批准或跳过审批。

恢复审批须读取已有冻结请求，不能用新时间重写同一持久化 key。验收核对 Pi 工具真实失败标记、审批等待扣除和文件回读；是否要求近期认证以实际审批合同为准，不以“工具”一概判断。

若计划在 Worker 准入前拒绝，比较实际请求与签名能力的每个资源额度；正式组合必须逐项取较小值，不能直接扩大签名上限。Trace 的 Runtime 和授权审计并发时使用数据库原子序号分配；不得删除审计记录、重置序号或重发工具来消除冲突。

前台任务也必须核对清理。已取消/失败的 Run 可以通过原停止命令再次核对，禁止重新运行其模型或工具。协调器完整性核验使用现有 30 秒上限；不要把 Job Host 的 5 秒进程退出期限与包括安装文件核验的协调期限混为一谈。机械盘主机可配置 Worker 等待 300 秒、Run 900 秒、Provider 120 秒，仍逐项受已签名能力上限约束。升级旧安装前先使用相同安装和原受保护证据释放遗留环境；只有规范协调器核验并持久化 released 才能报告清理完成。

若旧 fixed_read 已有真实结果及清理证据，却仍保留 SANDBOX_NOT_STARTED 效果，先核对其固定只读合同、结果绑定与原安装字节，再通过现有 Journal CAS 补充 not_applicable；不能把写操作、未知退出或未经验证的副作用套用此修复。维护进程在服务停止后正常取得独占 Authority，保留旧安装做核验，结束后释放 Authority；不继承旧 Worker 的执行权，不直接更新数据库列。候选版本的同一受测验证/持久化组件可用于这次受限修复，随后才替换安装树。
