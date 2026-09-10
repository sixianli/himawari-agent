---
status: active
document_type: plan
supersedes: ""
superseded_by: ""
date: "2026-09-10"
---

# 控制中心真实服务验收实施计划

**来源：** [SOURCE: docs/execution/specs/2026-09-10-control-center-local-acceptance-design.md]

## 当前执行目标

用户明确要求把 Himawari 做成可通过 Web 日常使用的 AI Agent，并于 2026-09-11 纠正最终主机为 Hermes Linux。Mac 只用于开发和浏览器。服务须保留原 Owner、Agent、部署、对话与保护边界；源码继续在 `codex/web-page-refactor`，不推送、不创建 PR。

安装流程见 [SOURCE: docs/runbooks/hermes-control-center-upgrade-runbook.md]。网页天气、文件读写、脚本是代表性验证，不能用少量演示替代通用聊天、工具、审批与恢复行为。

## 已完成与进行中

- [x] 复查 Git：开始本阶段工作区干净，HEAD `099eefc1a5cec454cc4a5e68e984f08714c53014`；SRT 分支是当前祖先，左右差异为 0/7，不回退历史。
- [x] 停止误在 Mac 启动的本次 Agent/Worker；按完整命令核对 PID 38210、38211 后 SIGTERM，确认退出。保留独立目录用于审计。
- [x] 连接 Hermes：Cloudflare SSH 未成功后使用用户批准的 Tailscale；核实 `/data` 机械盘、现有 systemd 用户服务、原 HTTPS 地址和独立 Himawari state root。
- [x] 核实真实缺口：Hermes 原有两个已完成 Run，Capability Registry 没有声明，未配置目录 Grant 和模型请求到通用 Pi 工具的正式桥接。
- [x] 实现离线首次初始化、显式工作目录 Grant、合格能力 Registry 登记；都使用既有独占锁、活动身份、事务和审计，不手工插入动作批准。
- [x] 接入 Pi 七工具和 Exa MCP 公开搜索请求路径；模型参数先冻结，授权与披露批准后才签发 Handle 并由 Worker 执行。公开搜索已通过 v15 真实 Web 验收，见末节。
- [x] 修复 Provider 错误展示、失败 assistant 记录、启动快照超过五分钟的复查方式，以及 Linux 构建目录受默认 umask 影响的发布权限。
- [x] 完成 v15 Linux 安装树的六项实测资格、签名与启动前核查；Web v17 单独核对静态产物。
- [x] 保存并验证旧恢复点，同一数据库从 schema 29 升级至 31，登记工作目录和两个能力，保留原 Owner、Agent 和部署。
- [ ] 内置账号遇到已有外部 Owner 绑定，明确迁移方案并确认；当前保留 Cloudflare 产品登录。
- [x] 修复机械盘冷启动等待不足并验证实际就绪；最终重启后 Agent 于 21:20:34 UTC ready，随后真实续聊完成。
- [x] 真实浏览器验证聊天、多轮、公开 Web 搜索、文件/脚本、批准/拒绝、停止、刷新、重连与重启，保留费用证据。
- [ ] 对话列表搜索生产接口与索引同步缺失；404 已复现，不能称为通过。
- [x] 当前源代码完整测试 1984 项、tooling 565 项通过，零跳过，浏览器体积检查通过。
- [x] 完成文档治理、截图、入口和已完成改动的本地提交；提交记录以当前分支 Git 历史为准。内置账号正式迁移仍待具体授权。

## 本阶段证据与失败处理

真实安装根为 `/data/hermes/himawari`；构建、依赖、资格和日志均在机械盘。原发布保留；服务曾在切换及 Worker 冷启动失败期间不可用，不能将 systemd active 当成 ready。源码上传使用显式生产文件白名单、逐文件摘要和秘密扫描；一次宽泛归档被自动审批拒绝后改为经过检查的白名单，未绕过拒绝。

当前分项：新工具/原读取链路及界面回归 62 项通过；公开搜索与披露 13 项通过；初始化与目录 Grant 的实际 SQLite 检查通过；打包权限 26 项通过，先失败证据显示复制产物保留 group-write。完整测试第一次为 188 文件、1930 项执行、1921 通过、9 失败；失败都来自 Worker 测试未替换新增快照复查入口，修复后该文件 9 项通过。第二次完整命令在构建时因源码继续变化触发 `ARTIFACT_BUILD_INPUT_MISMATCH`，不能报告测试通过，需冻结输入后再跑。

Hermes 初次当前产物验证：Pi、网络允许/拒绝和 Worker 丢失检查通过；组合验证因构建目录 0775 被 `SANDBOX_HOST_PATH_UNSAFE` 拒绝。修复打包权限并改用安装树中的 seccomp 依赖后重新验证，不放宽实际 Host 检查。

本阶段决策日志：`test/qualification/evidence/local-service-2026-09-10/decisions.tsv`。最终 Hermes 脱敏证据目录：`test/qualification/evidence/hermes-web-2026-09-11/`。未完成的真实流程不能用受控测试或原型证明。

## 历史阶段说明

早期测试运行器修复已解决共享 300 秒限制，完整五项目当时为 183 文件、1914 项通过（`.ci-output/local-1789041051666/test-macos-arm64/result.json`）。内置账号交付时为 185 文件、1921 项及 tooling 565 项通过，见 `test/qualification/evidence/built-in-account-2026-09-10/`。这些结果不覆盖本阶段后续变更。

Mac 唯一一次真实聊天失败，受保护记录确认 DeepInfra 返回 HTTP 429/engine_overloaded；不能称为聊天成功，也不能将未知费用记为零。总验收授权上限仍为 1 美元，包含既有调用、未确定费用预留以及 Hermes 后续调用。原文件名保留以维持历史引用，其“local”不再代表 Mac 部署目标。

## 后续实测发现

`db migrate` 原来不能迁移已有数据库，实际报 `SQLITE_MIGRATION_SNAPSHOT_REQUIRED`。修复为在独占锁内生成并验证同主机快照；回归测试先失败后通过，管理命令七项通过。Hermes 恢复点 `before-web-20260911-v9` 验证成功，正式迁移应用 30/31，原身份保留。

Pi 写入/编辑的回读证据已接入现有 verified_effect；生产 jobId 采用带字母前缀的完整 SHA-256 base64url，满足既有机器标识合同和 Linux socket 长度约束。作用域测试 18 项通过。一次 Pi 编辑探针未拿到确定退出结果；原探针诊断重跑通过，随后将探针清理期限从 1 秒改为正式 Worker 的 5 秒，保留失败证据并重新验证 22 项，不用文件存在替代退出证据。

一次完整测试 1952 项执行、1951 通过、1 失败，发现 jobId 首字符问题并修复。随后 1947 项通过，但六项安装测试因验证期间源文件变化而报 `ARTIFACT_BUILD_INPUT_MISMATCH`，该次仍为失败，须最终冻结输入后重跑。

Hermes 启动时实际出现 `EXECUTION_WORKER_UNAVAILABLE`。同一安装树的一次完整摘要校验约 25 秒，两个能力会超过写死的 30 秒握手等待。保留全部检查并进行有界并发读取，握手改用配置的 Worker 请求预算；候选摘要与原算法一致，嵌套文件、符号链接、权限与内容改变等 24 项检查通过。最终安装与真实网页验证仍需完成。


## 网页真实链路修复（2026-09-11）

Hermes v10 六项安装资格通过，Worker 与 Agent 分别在 2026-09-10T18:10:12.643Z、18:10:13.789Z 输出 ready；公开网页已能新建和提交真实对话。首次 GLM 请求返回 400，明确要求 reasoning，现有 off 选项错误。增加可选 reasoningRequired 配置，验证必须具备 reasoning 能力，映射为 Pi 原有 thinkingLevelMap.off=null；菜单与请求验证共用 Pi 支持列表，未显式指定时选第一个支持等级，明确不支持的选择仍拒绝。106 项相关测试通过，先失败证据保留。

第二轮真实模型发出 Bash 调用并进入审批，但审批详情报 HTTP_GATEWAY_REQUEST_INVALID。真实目标包含目录路径；Gateway 误将目标引用限定为 machineString。将目标字段改为有限长度、禁止控制字符的展示文本，保留 ID 字段校验与原审批授权。使用中文目录的实际 Governance 读模型测试先失败，修复后 26 项通过。该轮因未完成审批最终失败，没有执行未知命令。

完整 v10 命令执行 1958 项、1957 通过、1 失败；运行期间新加入的 reasoning 回归测试尚未修复时被收集，不能称最终通过。冻结当前修复后重新跑完整检查。当前还没有成功的纯文字聊天和浏览器批准后执行证据。

第二轮未获得此前项目代号的原因也已核实：Hermes 配置 maxMemoryClassification=public，而 ContextFormationService 同时用该值过滤 Thread 历史，私有用户消息被明确排除。配置改为 private，保持 maxSelectedMemories=0；范围仍是用户已批准的私有对话披露，不导入其他记忆。升级后需实测多轮上下文。


## 审批恢复与真实工具状态修正

普通聊天在 Hermes v11 已完成：第三轮正确恢复第一轮的“晨光计划”；断线期间草稿在刷新后保留，早前记录与计时保留。DeepSeek 第四轮实际限流，未做盲目重试。v11 完整测试为 191 文件、1959 项全部通过，零跳过（`.ci-output/local-1789064856996/test-macos-arm64/result.json`）。

第五轮 write 的真实审批已在网页批准；卡片明确不要求近期重新认证，不能将所有工具批准都称为认证阻塞。批准后未生成 Worker 收据和 Sandbox Job，目标文件不存在，Run 进入核对状态。源码与回归复现确认恢复时重写 context 时更改了时间，触发 SQLite 的不可变 operation identity 冲突；改为读取原冻结记录后仍核对输入与绑定。测试替身原来默许不同内容复用 key，现按真实 SQLite 的 contentDigest/contentType/classification 合同拒绝；先六项失败，修正后 118 项通过。该 Run 通过正式停止操作结束，未手工改状态。

Pi 0.84.2 的 executeToolCall 将正常返回视为 isError=false，不读取返回对象自带的 isError。复用 Pi 官方 tool_result 钩子，将产品 failed/result_unknown 保留为错误，保留输出与引用；真实 AgentSession 测试先两项失败后 49 项通过。旧记录中的明确 errorCode 也不能投影成成功，加密投影回归先失败后通过。工具/消息耗时扣除已记录审批等待，并保留第一次结束边界，避免恢复事件把旧消息耗时延长。时间测试 12 项通过。上述修正晚于 v11 全量通过，需最终重新验证。

外部 Owner 到内置账号迁移仍待用户确认，与普通文件写入审批是独立事项。Cloudflare 官方重新认证入口实际要求 WARP，未启用电脑网络组件、未注销其他应用，也未改变近期认证规则。

## 工具资源额度与并发记录（2026-09-11）

v12 的最终完整测试 191 文件、1960 项全部通过、零跳过；六项 Linux 安装资格通过，Worker/Agent 于 19:06:51/52 UTC 就绪。第六轮在网页批准 write 后仍未产生文件；实际冻结请求的 CPU 上限 120000ms 超过签名能力的 30000ms，计划在进入 Worker 前被拒绝。正式请求改为取产品设置与该能力合格资源上限的逐项较小值，保持 Host 检查；请求额度回归先失败后 17 项通过。

同时，Run 的最后事件为序号 51 的 authorization.grant_consumed，后续 Runtime 记录尚未成功写入，调度器记录 RUN_EXECUTION_FAILED_WITHOUT_RESULT 并停止服务。SessionTraceRecorder 在读取最后序号后还要加密和写 Payload，授权审计可在这期间占用该序号；并发回归明确复现 PORT_INVALID_OPERATION。新增 TraceStorePort.appendNext，在 SQLite 写入事务中分配序号并沿用原有作用域、重复事件、Payload 和 Gateway 事件检查；需要提供精确序号的 append 保留原校验。三个相关集成文件 42 项通过，包含真实 SQLite 端口与并发、重复和跨作用域检查。新代码晚于 v12 全量结果，正在重新执行完整验证。

第六轮通过网页正式停止，旧记录和未知费用保留。运行中曾把后续思考深度选为 low，当前轮仍保持 minimal；页面刷新后下一轮偏好回到既有配置默认值，尚不能据此声称后续选择在刷新后持久化。普通 Shift Enter 换行、升级期间草稿保留及 Light/Dark 六色组合已有真实浏览器记录；手机为浏览器视口与触摸模拟，不是实体手机验收。

## Hermes 前台工具收尾修正（2026-09-11）

v13 全量测试 191 文件、1963 项全部通过，零失败/跳过；原始结果 `.ci-output/local-1789068407628/test-macos-arm64/result.json`。Hermes 六项安装资格通过，Worker/Agent 于 19:36:00/01 UTC 就绪。实际 Web write 已产生 `acceptance-morning.txt`，主机回读为“晨光计划验收”，Worker 留下 verified_effect；但返回晚于 120 秒期限约 3 秒，Run 进入结果核对，随后通过网页取消，不能称为完整成功。

原控制协调器只等 5 秒，而机械盘上的运行时字节核验需要更久。改用已有合同允许的 30 秒上限，不删除完整性检查。同时修复 stopRun 跳过前台记录并误报已释放的问题；取消/失败记录允许重试清理检查，既不重新调用模型也不重做工具。入口放在详情面板，沿用 thread.run.cancel、现有会话与权限。尚未绑定的环境不能报已释放，已释放环境仍须通过原 CAS 和证据校验。两项回归均留有修改前失败证据，相关 41 项通过。

主机执行等待拟设为 Worker 300 秒、Run 900 秒、Provider 120 秒；Worker 上限不超过原签名能力 wall-time 300 秒，CPU 仍按签名 30 秒上限取小值。此调整只给予现有校验和审批足够时间，不扩张文件、网络、预算或凭据权限。升级前必须用原安装核验遗留环境；不手改数据库状态或清空工作区占用。

## 已验证结果交回模型的实际缺口

v14 实测 read 已写入受保护结果且 Linux 清理 released/confirmed，但 Worker 的前台路径无条件返回 result_unknown，Agent 未消费既有 projectSandboxExecution 和 prepareIntent/dispatchIntent/acknowledgeIntent，因此仍进入结果核对。固定只读合同还遗漏 not_applicable 效果标记。修复限定为接通现有应用层合同，不新增模型侧工具协议，不由 Worker 授予披露权。

Agent 以原 Run/Invocation 读取真实日志，验证受保护输出与原安装/进程事实，再使用已有一秒有效期的证据执行 SQLite 的序号、操作修订、Run、Authority 和冲突检查。授权与披露在准备、交付前重查；先持久化交付收据，再确认原意图，随后通过现有 RuntimeToolResult 返回 Pi。发出意图后的失败保留不确定性，禁止重做工具。昂贵的 Host 核验在签发当前证据之前完成，同次核验直接携带其证明，避免重复核验把一秒证明耗尽；不延长有效期，也不跨工具缓存安装验证。

已释放状态仅允许重新核验同一终态：保留状态、统计、进程身份、已知结果和已验证效果，新增序号/时间与真实验证凭据；不得转回 controlled 或改变进程。此路径仍要求真实 Host/namespace 校验和现有一秒证明，不缓存跨任务资格。新增 SQLite 测试覆盖成功交付、取消后禁止交付、过期证明拒绝、持久化收据失败保留未知，以及拒绝替换已释放进程、统计或恢复运行。相关 73 项通过。v14 完整 191 文件、1965 项通过，零跳过；当前新增修正需要下一次全量结果。


## 正文可读性与 v15 真实结果

v15 的 Hermes 新读取轮次已完成，原 read 结果经现有交付意图确认后返回模型，页面显示真实文件内容；公开搜索工具同样完成并返回真实来源。受控完整测试为 191 文件、1975 项通过、零跳过，tooling 为 565 项通过。真实工具仍耗时数分钟，不等同于交互性能验收通过。

真实浏览器发现模型正文的代码块、表格和来源链接仍显示 Markdown 原文。使用固定 marked 18.0.5 的 lexer 在独立 React 组件渲染已获披露的 assistant 文本，不调用 HTML renderer，用户原文与工具输入输出继续按文字呈现。禁止原始 HTML 和远程图片；链接仅允许无凭据的绝对 HTTP(S)，由用户点击新页打开且不发送 referrer。浏览器依赖白名单仅新增这个解析包，Node、模型与持久化模块边界保持原规则。沿用已确认主题、字体和布局，不扩展执行或披露合同。安全与流式片段渲染八项检查通过，需完成当前版本完整检查和实际安装显示验证。

首次 React Markdown 方案入口 gzip 167274 字节、总计 187553 字节，超过项目既有 150/180 KiB 上限，构建检查如实失败。改用 Marked 原生 token 树生成 React 节点，保留 GFM 表格、列表和链接，不引入自建 Markdown 解析协议，不放宽体积门槛。


## 2026-09-11 最终 Hermes 验收事实

当前服务端为 v15，Web 为 v17；原始设计与 Logo 没有改写。正式入口 `https://himawari.siyi.win`，欢迎对话为“开始使用 Himawari”，验收历史为置顶“Hermes 功能验收”。默认工作目录 `/data/hermes/himawari/workspaces/default`，所有部署数据、依赖、数据库与日志位于已核验机械盘 `/data`。Mac 不运行产品服务。

冻结后的完整测试：192 文件、1984 项通过，零失败/跳过，477019ms；tooling 单独运行 23 文件、565 项通过、零跳过，57731ms。并发运行的 tooling 曾有仓库扫描 5.56 秒超过原 5 秒期限，保留失败，未更改期限；单独重跑成功。`npm run check` 与原浏览器 150/180 KiB 上限通过，入口 gzip 134415 字节、总计 154694 字节。结果含基准 HEAD 上的任务改动，不能把报告中的旧 HEAD 当作最终源代码摘要。

真实 Web 的 read、公开 Exa 搜索、write 脚本、UTF-8 文本附件、动作批准和拒绝均有实际结果。成功工具的 Journal 留有 dispatched/acknowledged 意图，环境 released/cleanup confirmed。脚本文件独立回读为 865 字节、Python AST 解析通过；没有执行该脚本、没有创建日志或安装 crontab。拒绝后的目标文件不存在且没有 Sandbox Job。公开搜索是实际 Exa 摘录和网址，没有打开网页全文，不把来源日期或预测当成本站验证的天气事实。

停止测试在 GLM low 的真实流式回答中进行：向上滚动时位置保持，出现回到最新入口；停止后记录 cancelled，刷新保留已输出前缀和 1294 字正文。模型未提供允许展示的 thinking 摘要时，页面明确说明缺少摘要。GLM minimal/low 的实际运行有证据；DeepSeek 真实调用返回 429，没有成功使用证据。运行中修改下一轮选择不改当前 Run，但刷新后下一轮选择回到配置默认值。

最终服务重启后 Worker 于 2026-09-10T21:20:33.373Z、Agent 于 21:20:34.265Z 就绪，fence 28，未结束 Run 为 0。浏览器经历离线、自动实时重连和刷新，标题、历史、未发送草稿保持。随后 Run `90be1290-64cb-4bc9-b799-dba0899339ed` 完成，正确返回上一轮默认工作目录。没有重做旧工具。数据库 quick_check=ok，原身份和历史保留，systemd 服务 enabled/active。

费用：Hermes 确认费用 9543 micro-USD、未知预留 228230；计入此前 Mac 63652 预留及 embedding 1 后，上界为 301426 micro-USD（0.301426 美元），低于 1 美元授权。保留未知预留，不表示已实际花费该上界。

手机验证使用真实浏览器的 390×844 CSS 视口与触摸模拟，正文不导致页面水平溢出，列表/详情/附件触摸目标至少 44px；没有实体手机或系统软键盘实测。Light/Dark 各六色的中性背景、正文与语义状态颜色保持不变，主题偏好刷新保留。实际欢迎页、菜单、手机截图与脱敏 JSON 位于 `test/qualification/evidence/hermes-web-2026-09-11/`。

## 尚未达到完整成品验收的部分

1. **对话搜索不可用**：真实 POST `/api/thread-search/v1/prepare` 返回 404。`BrowserThreadSearchPreparer`、受保护 tokenizer 与 SQLite 消息/标题索引端口已有受控测试，但 `createProductionHttpComposition` 没有装配准备接口，也没有生产索引同步。必须补齐权限范围内的索引建立、历史补建与更新合同，再验收；不能只挂上接口返回空成功，也不以浏览器明文过滤替代。此项不等于已经通过的公开互联网搜索。
2. **性能未达目标**：当前读取/搜索/写入工具约 3 分 12 秒，整轮工作约 4–5 分钟，审批等待另计。长对话刷新后的受保护记录加载也慢。完整 Host 字节核验不能通过绕过或跨任务缓存来消除。
3. **内置账号在 Hermes 未启用**：当前使用原有 Cloudflare 登录。外部 Owner 迁移及会话撤销的具体影响尚待授权，不删除绑定；新建实例的内置账号实现与受控测试不代表该实例已迁移。
4. **模型质量与能力边界**：一轮模型只声称等待批准，实际没有调用工具，页面没有伪造批准；再次明确发起真实工具后完成拒绝验收。应以真实工具/审批卡片为准。Bash 目前只读，尚未启用自主安装定时任务和其他管理模块；只验收了编写脚本。

因此，“Hermes 上可真实聊天、搜索互联网并经批准处理工作目录文件”已具备直接证据；“完整成品、全部原始验收项通过”尚未实现，Spec/Plan 保持 active，不归档为完成。
