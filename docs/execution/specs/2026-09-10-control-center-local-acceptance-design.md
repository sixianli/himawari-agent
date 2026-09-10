---
status: active
document_type: spec
supersedes: ""
superseded_by: ""
date: "2026-09-10"
---

# 控制中心完整测试与 Hermes 真实服务验收

## 目标与来源

用户要求将已确认的 Web 设计落实为可日常使用的 AI Agent。天气搜索、文件读写、脚本编写是代表性场景，不能以硬编码示例或受控服务代替真实模型、工具、审批和恢复。用户于 2026-09-11 明确最终运行主机为 Hermes Linux，Mac 仅承担开发与浏览器访问。

- [SOURCE: docs/archive/specs/2026-09-10-control-center-product-refactor-design.md]
- [SOURCE: docs/execution/specs/2026-09-10-control-center-visual-baseline-design.md]
- [SOURCE: docs/adr/0027-built-in-owner-authentication.md]
- [SOURCE: docs/runbooks/hermes-control-center-upgrade-runbook.md]

## 当前链路与缺口

正式链路为控制中心、Gateway、RunCoordinator、Pi 0.84.2、OpenRouter、独立 Execution Worker、SQLite 与受保护 Payload。Hermes 已有 Himawari 的活动 Owner/Agent/deployment、两个已完成 Run 和 HTTPS 入口；此前 Capability Registry 未登记声明，未配置目录 Grant，通用工具尚未连到自然语言请求。不能重新初始化或覆盖该真实实例。

Pi 提供模型连接、流式事件、会话、Agent Loop 和 read/write/edit/bash/find/grep/ls 工具定义；`packages/runtime-pi` 内复用既有 governed 工具与 Operations。Himawari 负责动作授权、明确接收方的披露、限定主机和目录、Worker 调度、加密记录、预算与审计。Pi 没有内置公开 Web 搜索，项目已有 `PublicWebAdapterPort`，通过现有 MCP SDK 增加 Exa 只读搜索适配，不另建 MCP 或模型协议。

## 初始化与账号

离线 `init` 只用于不存在的新 state root：独占创建、验证路径、事务建立 Owner/Agent/Deployment 与审计，最后发布 authority。重复执行拒绝，不创建工具授权或资格。Hermes 已有实例不调用 init。

采用用户批准的内置账号：密码与 TOTP/一次性恢复码、受保护第二因素、可撤销设备和产品会话，沿用 CSRF、近期认证和归属校验。账号通过停机 `account create` 建立，凭据只经私密文件交付。Hermes 已有外部 Owner 绑定，`account create` 明确拒绝自动替换；在具体身份迁移获确认前保留现有 Cloudflare 产品登录，不能删除绑定或冒用 `recover` 绕过迁移要求。内置账号在该主机尚未启用。原 Cloudflare Access/tunnel 保留为入口保护，不改变外部账户或网络策略。用户已否决仅 loopback 登录方案，此方案不再实施。

## 通用工具与配置边界

`runPolicy.coding` 选择已安装 Pi 工具；`runPolicy.publicSearch` 选择独立搜索程序。均引用 host、Worker instance、目录 Grant、Capability 版本与输出上限。模型目录和思考深度来自实际配置与 Pi 能力；选择随新 Run 固定，运行中变更只影响后续消息。每轮系统上下文保存真实请求时间，查询“今天”时不能沿用模型知识中的日期。

工具参数冻结到受保护的 Run artifact。动作 Intent 只包含工具、范围、输入摘要和明确接收方；原始文件内容、命令和凭据不放进公开审批摘要。动作/披露批准后签发单次 Handle，继续走现有 Worker 准入、scope 与隔离；拒绝和暂停不签发可执行 Handle。恢复复查原输入、目录版本、模型身份、执行租约、截止时间和当前授权，不能因刷新改变操作或重新授予期限。

`workspace grant` 离线登记明确确认的规范目录及真实设备/inode，默认 read/create/update、private/model 披露；它不代替逐次动作批准。`capabilities register` 只登记经严格 loader 验证且 Owner 明确确认摘要的安装声明，不生成主机资格。

Pi write/edit 在真实平台回读校验成功后附带路径、内容摘要和字节数，Worker 将原受保护输出绑定为持久效果证据，Agent 再验证原调用、输入和 Grant；本次安装 bash 仅有只读目录范围，文件修改使用 write/edit。路径穿越、符号链接、跨设备、受保护目录与机器秘密继续拒绝。不能为了让脚本可运行而默认开放删除、安装、凭据或其他目录。

## 公开搜索

搜索适配实现既有 PublicWebAdapterPort 的 search 部分，使用固定 `https://mcp.exa.ai/mcp` 与 MCP SDK。只支持真实 `web_search_exa`，不提供无法满足完整网页状态/内容合同的伪 open 实现。查询限制长度与结果数量、拒绝机器秘密；披露审批明确包含 Exa 与本轮模型。运行程序只接收已准入的受保护 stdin，使用认证 SRT 代理，安装网络上界只有 `mcp.exa.ai:443`，禁止重定向扩大出口。

结果保留实际标题、网址、日期摘录与查询时间，`openedResourceId` 为 null；不能把搜索摘录表述为已打开全文。未知 provider 格式、限流或真实错误必须失败，不返回编造的空成功。第三方返回视为不可信资料，不能变成新的工具授权。免费服务也可能限流，其可用性以实际请求为证据。

## 流式、失败、恢复与安装

沿用 Pi 和 Gateway 真实事件及持久化顺序。Provider 429、401/403、5xx 映射为有界可读错误；不把原始 provider 元数据开放给浏览器。assistant 的错误/停止终态与实际 stopReason 一致。每轮记录独立保留，不把未提供或不允许展示的 thinking 编造出来。

安装时严格检查新鲜资格；同一次启动内复查原快照字节和实际 Host/runtime/runner，而不是因五分钟经过使所有后续工具失效。打包统一去除 group/other write，保留可执行位；运行时不放宽安全检查。安装树校验按最多八个文件并发读取，每次仍检查全部文件字节、规范路径、权限和前后元数据，不跨任务缓存。Agent 初次握手遵守配置中的 Worker 请求预算，避免机械盘上完整校验超过写死的 30 秒期限。资格绑定当前 Linux、实际安装产物、工具和 namespace 清理证据，旧 Mac 或旧版本结果不能代替新资格。签名是主机安装事实的签名，不冒充上游发布签名。

数据、构建、依赖、日志和证据位于 `/data/hermes/himawari`；机械盘实际挂载先核验。现有服务切换前保存并核验恢复点，迁移同一数据库，保留原身份、历史和未知执行记录。恢复不能自动重放旧工具或将未知结果标为成功。

## 验收与交付

完整测试共享既有 30 分钟预算，真实 SQLite/UDS integration 使用明确的 30 秒默认单例期限，测试内业务期限不变。输入冻结后执行完整命令并保留真实结果；构建输入改变、超时或缺少报告不能写成通过。

真实浏览器连接 Hermes 正式 HTTPS 服务，验证多轮聊天、模型与深度、文件/脚本、公开搜索、批准/拒绝、停止、断线、刷新、重启和草稿。逐项区分受控故障注入与真实 Provider/Worker 证据；工具副作用由主机独立回读。交付入口、登录方式、截图、实际费用、已知限制、本地提交和最终工作区状态，不自动推送或创建 PR。

## 历史证据边界

早期 300 秒测试限制已修复，1914 项完整通过；内置账号交付时为 1921 项与 tooling 565 项通过。后续代码必须另验。原 Mac 独立实例已停止，唯一真实聊天失败为 DeepInfra HTTP 429，未知费用仍保留预留。本次累计模型费用上限为用户已批准的 1 美元，不将失败调用算为免费。文件名保留历史引用，其 local 不再代表 Mac 部署。


## 网页真实链路修复（2026-09-11）

Hermes v10 六项安装资格通过，Worker 与 Agent 分别在 2026-09-10T18:10:12.643Z、18:10:13.789Z 输出 ready；公开网页已能新建和提交真实对话。首次 GLM 请求返回 400，明确要求 reasoning，现有 off 选项错误。增加可选 reasoningRequired 配置，验证必须具备 reasoning 能力，映射为 Pi 原有 thinkingLevelMap.off=null；菜单与请求验证共用 Pi 支持列表，未显式指定时选第一个支持等级，明确不支持的选择仍拒绝。106 项相关测试通过，先失败证据保留。

第二轮真实模型发出 Bash 调用并进入审批，但审批详情报 HTTP_GATEWAY_REQUEST_INVALID。真实目标包含目录路径；Gateway 误将目标引用限定为 machineString。将目标字段改为有限长度、禁止控制字符的展示文本，保留 ID 字段校验与原审批授权。使用中文目录的实际 Governance 读模型测试先失败，修复后 26 项通过。该轮因未完成审批最终失败，没有执行未知命令。

完整 v10 命令执行 1958 项、1957 通过、1 失败；运行期间新加入的 reasoning 回归测试尚未修复时被收集，不能称最终通过。冻结当前修复后重新跑完整检查。当前还没有成功的纯文字聊天和浏览器批准后执行证据。


## 审批恢复与真实工具状态修正

普通聊天在 Hermes v11 已完成：第三轮正确恢复第一轮的“晨光计划”；断线期间草稿在刷新后保留，早前记录与计时保留。DeepSeek 第四轮实际限流，未做盲目重试。v11 完整测试为 191 文件、1959 项全部通过，零跳过（`.ci-output/local-1789064856996/test-macos-arm64/result.json`）。

第五轮 write 的真实审批已在网页批准；卡片明确不要求近期重新认证，不能将所有工具批准都称为认证阻塞。批准后未生成 Worker 收据和 Sandbox Job，目标文件不存在，Run 进入核对状态。源码与回归复现确认恢复时重写 context 时更改了时间，触发 SQLite 的不可变 operation identity 冲突；改为读取原冻结记录后仍核对输入与绑定。测试替身原来默许不同内容复用 key，现按真实 SQLite 的 contentDigest/contentType/classification 合同拒绝；先六项失败，修正后 118 项通过。该 Run 通过正式停止操作结束，未手工改状态。

Pi 0.84.2 的 executeToolCall 将正常返回视为 isError=false，不读取返回对象自带的 isError。复用 Pi 官方 tool_result 钩子，将产品 failed/result_unknown 保留为错误，保留输出与引用；真实 AgentSession 测试先两项失败后 49 项通过。旧记录中的明确 errorCode 也不能投影成成功，加密投影回归先失败后通过。工具/消息耗时扣除已记录审批等待，并保留第一次结束边界，避免恢复事件把旧消息耗时延长。时间测试 12 项通过。上述修正晚于 v11 全量通过，需最终重新验证。

外部 Owner 到内置账号迁移仍待用户确认，与普通文件写入审批是独立事项。Cloudflare 官方重新认证入口实际要求 WARP，未启用电脑网络组件、未注销其他应用，也未改变近期认证规则。

## 实测补充约束：资源额度与 Trace 序号

工具请求的资源额度在冻结 work.execute 前与精确 Capability 版本的已验证上限逐项取较小值。此步骤只缩小 CPU、内存、输出、进度与时间额度，不能扩大 Handle、Grant 或 Host 限制；签发后仍由原准入和 Worker 重验。

Runtime 与授权审计共享同一 Run 的 Trace 顺序。SessionTraceRecorder 使用 TraceStorePort.appendNext，由持久化事务分配序号并返回实际保存的 TraceEvent；加密 Payload 写入期间发生的其他审计事件不会被覆盖，也不能以重新提交工具解决序号竞争。现有显式序号 append 仍拒绝重复、跳号和跨作用域记录，Gateway 通知与 Trace 插入保持同一事务。

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


## 最新验收边界

最终状态以 [SOURCE: docs/execution/plans/2026-09-10-control-center-local-acceptance-plan.md] 的“最终 Hermes 验收事实”及脱敏证据为准。v15 服务端和 v17 网页已通过真实聊天、Web 搜索、文件、审批与重启续聊，但对话列表搜索生产接口缺失、工具耗时数分钟、Hermes 内置账号迁移尚未执行；不能将前述中间阶段结果误认为全部成品验收通过。原失败 Run、未知费用与未完成项保留，本文保持 active。
