---
status: active
document_type: plan
supersedes: ""
superseded_by: ""
date: "2026-09-30"
---

# 生产服务器首次部署计划

**依据：** [SOURCE: docs/adr/0049-first-production-host-acceptance-exception.md#hosts]（云服务器只用于生产；普通测试、构建与整套资格在 Hermes；本次首次安装仅允许经具体授权的有限主机能力验收，旧云测试环境原样保留）及 [SOURCE: docs/adr/0048-vercel-ai-gateway-replaces-openrouter.md]（文本、嵌入及路由）。

**目标：** 把 Himawari 部署到生产云服务器 `84.247.157.41`，让用户通过 SSH 隧道（把服务器本机端口转发到用户自己电脑的 SSH 功能）打开控制中心（Himawari 的网页界面）亲自体验。

**当前安排（2026-10-07）：** Codex 接手规划、实施和自审。G50的云端只读预检已经结束，G51批准的有限主机能力验收例外已保存。当前先在Hermes验证验收适配，补齐工具安装前提，再固定具体云操作清单并申请授权。原暂缓部署决定仍有效，用户的“继续”用于推进准备工作。服务仍只监听服务器本机地址，通过 SSH 隧道访问。生产服务使用普通用户，root SSH 仅用于当次获准的管理步骤。

<a id="reading-navigation"></a>

## 阅读导航

- [用户决定](#decisions)
- [2026-10-01 更新：同机测试与 Ubuntu 24.04 前提](#update-2026-10-01)
- [当前证据与部署前提](#current-prerequisites)
- [本次只读预检结果与下一项决定](#preflight-2026-10-07)
- [已知限制](#limits)
- [步骤](#steps)
- [响应时间测量](#response-time)
- [验收](#verification)

<a id="decisions"></a>

## 用户决定（2026-09-30）

- **版本：** 立即部署当前版本，不等工具执行排查第二轮的修复。部署的是分支 `claude/isolated-tool-execution` 上当时已推送的最新提交，具体提交号在部署时记录。之后修复完成，再按同样步骤升级一次。
- **访问方式：** SSH 隧道。控制中心只监听服务器本机地址，公网上不暴露任何新端口。
- **权限：** 用户最初选择“普通用户登录，root 步骤写成脚本由用户运行”，随后在同一天改为**给 Claude root 权限，但不提供密码**：用户把 Mac 上的 SSH 公钥加入服务器 root 账号，Claude 用密钥登录。Claude 不接触任何密码。执行需要 root 的步骤前，先说明要做什么；Himawari 服务本身运行在专用的普通用户下，不用 root 运行。
- 每一次部署或改动都是生产操作，本计划记录的授权只覆盖这一次首次部署；以后的升级仍要用户逐次授权。
- **2026-09-30 用户决定暂缓部署：** 在用户下次明确要求部署之前，不做任何步骤，也不登录或检查生产服务器。届时重新确认要部署的版本和上面的访问、权限安排，再按下面的步骤执行。

<a id="update-2026-10-01"></a>

## 2026-10-01 更新：同机测试与 Ubuntu 24.04 前提

本节保留 2026-10-01 的历史检查。部署仍处于暂缓状态；当次操作按[步骤](#steps)取得用户授权，并以新的现场结果核对前提。下列历史数据不证明当前目录、服务或普通生产用户的沙箱已经就绪。

当天测试环境搭建时已核对的服务器情况（只读检查和用户执行的脚本，详见 [ADR 0044](../../adr/0044-tests-on-cloud-server.md#context)）：

- Ubuntu 24.04.5，x86_64，4 核，7.8 GiB 内存，无交换空间，一块约 100 GB 的虚拟磁盘（上报为非旋转盘）。
- SSH 已改为只允许密钥登录，root 只能用密钥登录（用户执行，配置文件 `/etc/ssh/sshd_config.d/00-key-only.conf`）。
- 测试用户 `himawari-test` 和 `/srv/himawari-test/` 已建立，2026-10-02 起不再使用、原样保留；部署之前按用户的决定清理。生产服务要另建专用用户和目录，不能与之共用。

当时记录的前提：

1. **AppArmor 与 bwrap。** Ubuntu 24.04 默认限制普通程序创建用户命名空间，产品沙箱用的 bwrap 会被挡住，见 [BL-20261001-001](../../backlog/BL-20261001-001-ubuntu-24-04-默-认-禁-止-bwrap.md)。[SOURCE: docs/backlog/BL-20261001-001-ubuntu-24-04-默-认-禁-止-bwrap.md] 系统 `/usr/bin/bwrap`（0.9.0，SRT 路径使用）已由用户加了只针对它的规则。program 与 stdio MCP 的隔离后端要求 bubblewrap `>=0.11.2`（ADR 0021），已在测试目录从官方源码编译。用户 2026-10-01 以 root 运行脚本，把它安装到 `/usr/local/libexec/bubblewrap-0.11.2/bwrap`（root 所有，权限 0755，SHA-256 `20a3bdb6c1147f62a043a9d4d9c7873db233df40f11a0cc48731a16b97e008f3`），并新增只针对这个路径的规则 `/etc/apparmor.d/bwrap-0.11.2`；以测试用户运行（含 `--unshare-net` 断网隔离）验证成功。生产配置要指向这个路径，安装说明要写明这两条规则。
2. **磁盘同步写入慢。** 实测每次 4 KiB 同步写入约 11–19ms，比 Hermes 固态盘（约 3ms）慢数倍；同一流程的测试在这台机器上超过 5 秒，见 [BL-20261001-002](../../backlog/BL-20261001-002-回-到-同-步-写-入-快-的.md)。[SOURCE: docs/backlog/BL-20261001-002-回-到-同-步-写-入-快-的.md] 部署前测量一次真实请求（一次对话加一次工具调用）的响应时间，结果告诉用户，由用户决定是否接受或更换存储。
3. **版本。** 2026-09-30 的版本安排保留为历史决定。之后有暂缓部署、上线前修复和网关迁移的决定；当次部署重新固定已推送提交与测试证据，不直接使用当时安装包。

[返回导航](#reading-navigation)

<a id="current-prerequisites"></a>

## 当前证据与部署前提（2026-10-07）

以下是准备依据，尚未在云端执行安装或启动。

| 范围 | 保留证据与实际边界 |
| --- | --- |
| 产品可执行内容 | `28a79bfc97dc09a30da69057b09a5503c07c8127`，包含 Vercel 网关与 Mem0 `3.3.1`；截至候选构建提交`2ea2df2`，后续提交只改文档、AGENTS及长任务记录，产品代码、依赖和测试配置保持。具体生产提交尚未获准部署 |
| Hermes 完整检查 | 上述实现内容指纹 `cffd6c44f39d67fba247b75dcb5f0eefdc2df7a6fbc26d98df4ff8f65f158621` 上，第 1 层通过，第 3 层构建及五项目 5465 通过、0 失败、0 跳过；不筛选 Linux 产品路径 47 通过、0 失败、1 原可选性能对照跳过。原件见[迁移批次报告](../../../.ci-output/handoff/2026-10-06-codex-round2-l5-migration-report.md#evidence) |
| 云端工具环境 | G47 仅授权 bubblewrap 身份、版本与 AppArmor 文件/加载状态；2026-10-07 的检查通过。R2-L2 按 G48 使用 7 天环境证据，仍不能替代当次生产预检。原件见[云只读检查报告](../../../.ci-output/handoff/2026-10-07-codex-round2-l2-cloud-preflight-report.md) |
| 安装包 | Hermes在`2ea2df2`上构建Linux x64候选包通过，66,607,740字节，SHA-256为`77754830ba6eb0bf38a4a1654325ae18e5e874e3a79ade09dab685bc383e647d`。原件见[候选包输入](../../../.ci-output/production/2026-10-07-host-acceptance-preparation-01/hermes-reports/candidate-inputs.json)；包仍在Hermes自有检出目录的`.ci-output/`中供后续适配使用，尚未复制到云端。该次只运行构建，不是完整第3层 |
| 最终版本检查 | A1/A2 的精确命令条件仍显示旧版本验证；没有改写指纹规则。生产提交固定后按原规则安排检查，不能把文档更新说成已在新指纹运行过完整命令 |
| Hermes验收适配 | 候选包安装及短路径检查八项通过。Worker被杀后，任务命名空间退出且脱离进程没有写出标记；七个网络边界场景全部观察到拒绝和连接关闭。报告保持`productionSuitable: false`，没有生成生产证明。原件见[有限探测报告](../../../.ci-output/production/2026-10-07-host-acceptance-preparation-01/hermes-reports/worker-boundary-report.json) |
| 工具安装前提 | 候选包不含`pi-tools`宿主工具目录。Pi验收脚本在首个场景前因缺Bash退出；安装合同要求在资格前配置Bash、rg、fd。Hermes已存在Bash和rg，本任务目录没有fd。后续只提议在Hermes下载固定fd及现有网络探测的`is-number@7.0.0`，具体范围见[问询12](../../../.ci-output/handoff/2026-10-07-codex-round2-user-question-12.md)；批准前不执行下载或临时依赖安装 |

安装与启停依照[安装 Runbook](../../runbooks/install-start-stop-runbook.md#live-state-preflight)。[SOURCE: docs/runbooks/install-start-stop-runbook.md] 每次使用前重新检查其静态合同和目标现场；静态检查通过不授权云操作。

- **目标目录与覆盖。** `/opt/himawari`、`/etc/himawari`、`/var/lib/himawari` 仅为本次预检候选。安装器会替换前缀中的 `lib/himawari-agent`，初始化命令则拒绝已有 state root。发现已有路径、链接或服务时停止制定覆盖动作，先核对归属和恢复条件；本次不递归读取这些目录。实际安装、配置和 state root 在下一份批准方案中固定。
- **运行用户、Node 与服务。** `himawari-prod` 与 loopback 端口 `8400` 仅为候选，预检只检查是否存在或被占用。安装器生成的入口从 PATH 调用 Node，因此需要核对目标 Node 及其来源，不能使用旧测试账号或目录的工具链。当前安装 Runbook 不包含 systemd 服务注册；系统服务文件、权限、启动/停止顺序和恢复步骤需另给具体方案，不能猜命令直接注册。
- **真实工具资格。** 产品要求能力部署快照与实际主机、运行时和安装字节匹配；缺失、过期或不匹配时 Worker 保持未就绪。不能复制 Hermes 的测试资格夹具，也不能虚填 `productionSuitable`。G51允许[本次首次安装限定验收](../../adr/0049-first-production-host-acceptance-exception.md#first-install-acceptance)，先在Hermes验证适配，再取得具体云操作清单授权；验收和签署完成前停止真实工具启动及测量。当前管理员 CLI 没有生成资格的命令，不编造 `sandbox qualify`。
- **账号与秘密。** 账号创建会生成验证器设置资料和 10 条恢复码。用户自行输入、保存密码、验证器资料和生产网关密钥；Codex 不读取秘密正文。实际受保护目录、文件模式、命令及保留策略在当次方案中说明。开发密钥 G44/G45 的授权已用于历史探测，不能用于这次生产请求。
- **模型与预算。** 遵循[网关迁移设计](../specs/2026-10-06-vercel-gateway-migration-design.md)：文本只用 `deepseek/deepseek-v4.1-flash`，嵌入只用 `alibaba/qwen3-embedding-8b`、4096 维；路由优先 runware、deepinfra、morph，其余按 cost。真实产品请求还可能触发标题和记忆请求；付费授权应覆盖这些实际路径，并固定数据、预算和停止条件，不能把一次对话等同于一次 HTTP 请求。[SOURCE: docs/execution/specs/2026-10-06-vercel-gateway-migration-design.md]

[返回导航](#reading-navigation)

<a id="preflight-2026-10-07"></a>

## 本次只读预检结果与下一项决定（2026-10-07）

用户 G50 批准问询10后，冻结脚本在 `root@84.247.157.41` 执行一次，耗时 4.184 秒、SSH 退出码 0。主机为 `vmi3618928`，Ubuntu 24.04.5、Linux x86_64、内核 `6.8.0-142-generic`，4 核，检查时负载为 0，可用内存约 7.26 GiB、无交换空间。输出与退出结果见[本次预检原件](../../../.ci-output/production/2026-10-07-preflight-01/execution.json)，[独立读回](../../../.ci-output/production/2026-10-07-preflight-01/independent-readback.json)重新检查了输出摘要和各字段。

| 候选对象 | 本次实际结果 | 对后续准备的影响 |
| --- | --- | --- |
| `/opt/himawari`、`/etc/himawari`、`/var/lib/himawari` | 三者均不存在；各路径已有父目录所在磁盘可用约 89.34 GiB | 可以据此准备新目录方案，创建前仍须再检查现场，不能据一次读取自动获得写入许可 |
| `himawari-prod` | 用户不存在 | 需要在具体生产操作清单中说明创建用户及其目录/权限 |
| `/usr/bin/node`、`/usr/local/bin/node` | 两个路径均不存在 | 需要独立生产 Node 运行时及其身份检查；本次没有查找其他 Node 位置，不读取旧测试环境的工具链 |
| 8400 TCP/TCP6 监听 | 没有监听记录 | 可以继续准备 loopback 8400 候选配置，启动前重新核对占用 |
| 五个指定服务 | 均为 `LoadState=not-found`、inactive、MainPID=0 | 本次只排除了这些服务名，不能排除其他名称或手动启动进程；服务注册方案仍需准备与授权 |

本次只执行了已批准的一次云连接，没有创建目录、安装软件、操作服务、运行命名空间或发出模型请求。本次结果始终为 `readyToDeploy: false`，L3 接受决定和 L4 部署决定仍空。

**G51已批准首次生产安装必要的有限主机能力验收例外，具体云操作尚未授权。** 产品配置要求沙箱资格绑定当前 hostId、runtimeDigest、runnerDigest、平台与安装字节。当前 `inspectSrtDependencies()` 明确保留 `productionSuitable: false`，检查依赖不能生成主机资格；管理员 CLI 也没有生成资格的入口。旧 Node26 探测只用于诊断，已有 Hermes 签署/启动流程则绑定旧主机、安装和签署者，不能照搬。

原批准范围见[问询11](../../../.ci-output/handoff/2026-10-07-codex-round2-user-question-11.md)，现行规则见[ADR0049的限定验收](../../adr/0049-first-production-host-acceptance-exception.md#first-install-acceptance)。先在 Hermes 验证适配流程，再提供冻结版本、目标、命令、资源和清理边界的生产操作清单；没有具体云端授权就不执行。普通项目测试和构建继续只在 Hermes，旧云测试环境保持，全部产品资格校验保留。

[返回导航](#reading-navigation)

<a id="limits"></a>

## 已知限制

- 2026-09-30 的三项失败属于历史版本，不能作为当前测试结果；当前 Hermes 结果见[当前证据与部署前提](#current-prerequisites)。第二轮仍有未完成和用户决定条目，以 `longtask.py status` 为准。
- Hermes 结果不能证明 Ubuntu 24.04 生产机的响应时间、并发或沙箱运行。当前仅有云端工具环境证据，没有普通生产用户的主机能力资格，也没有真实产品响应时间。
- 模型服务 API 密钥由用户自己在服务器上填写，Codex 不经手密钥；具体生产密钥范围和付费请求仍需当次授权。
- （2026-10-02 记录）Linux 上生产配置中的 `privateRoot`（存放每个沙箱任务私有数据的目录）**不能超过 27 字节**，例如 `/var/lib/himawari/jobs`（22 字节）可以。原因是沙箱运行时 SRT 在 `privateRoot/<44 字节的任务编号>/` 下建 Unix 套接字，完整路径不能超过 107 字节。产品在加载能力安装声明的 sandbox binding 时检查这一点，超出预算会以 `CAPABILITY_DEPLOYMENT_INVALID_VALUE` 拒绝配置，消息说明实际字节数和上限；实现及复现测试见 [BL-20261002-002](../../backlog/BL-20261002-002-生-产-privateroot-超-过-27-字-节.md)。[SOURCE: docs/backlog/BL-20261002-002-生-产-privateroot-超-过-27-字-节.md] 部署前确认该项的审核与验证证据，并在[具体部署方案](#steps)写明选用的路径和它的 UTF-8 字节数。Mac 不创建 Linux 的网络桥，按实际 mux 套接字、5 位 PID，以及每个新 Job Host 只初始化一次、序号固定为 `0` 的约束核算，上限为 37 字节。依据来自 SRT 0.0.75 源码，详见[按平台核算套接字预算](../../backlog/BL-20261002-002-生-产-privateroot-超-过-27-字-节.md#socket-budget)；未在 Mac 上验证。

<a id="steps"></a>

## 步骤

| 顺序 | 准备与执行 | 授权和保留结果 |
| --- | --- | --- |
| 1：只读预检 | G50批准后执行一次冻结脚本，实际结果见[本次只读预检](#preflight-2026-10-07) | 本次读取授权已执行完；新的云连接或部署前重新检查包含在后续具体操作清单中授权 |
| 2：具体部署方案 | 根据新预检固定版本、安装目录、普通运行用户、配置、服务管理方式、能力资格处理及恢复条件；重新核对 Runbook 与原测试证据 | 准备可审阅脚本和配置中的非秘密部分，列出所有覆盖、创建、权限和服务效果；申请本次生产操作。任何目标身份或状态不明就停止 |
| 3：安装与就绪 | 获准后在 Hermes 构建及核对 Linux 包，复制到云端新前缀；按批准顺序建用户、安装、初始化和注册服务。用户管理秘密与账号设置资料 | 云端不跑普通测试、构建或整套产品路径资格；只允许G51限定且本次清单明确授权的主机能力验收。真实工具资格未满足则不启动该工具。原测试账号及 `/srv/himawari-test/` 原样保留，清理需另给用户脚本和明确授权 |
| 4：成对服务启动 | 按安装 Runbook 先 Worker 后 Agent，使用同包、同 state root、`--profile production`；核对双方 `service.ready`、本次身份和握手，再执行只读 `doctor`、`db status` | 具体启动、服务权限与生产配置属于本次生产授权；只绑定 loopback，不改 SSH、AppArmor、内核或防火墙设置。失败保留脱敏日志并停止，不猜恢复命令 |
| 5：实际使用与测量 | 用户通过 SSH 隧道登录，用获准的虚构数据完成[响应时间测量](#response-time) | 先取得数据、生产密钥使用及付费额度的具体授权；保留服务端状态读回和用户侧计时，不自动重发失败请求 |

以上是准备顺序，不是执行许可。第一阶段只读取目录元数据和指定服务状态，不能据此证明不存在任意手动启动进程、锁、socket 或旧部署；安装前仍需当次完整目标预检。

[返回导航](#reading-navigation)

<a id="response-time"></a>

## 响应时间测量

**尚未测量，没有可供用户接受的数值。** 本项测的是生产云服务器上的一次实际使用：用户发出一条消息，模型完成一次文件读取工具调用，返回可核对的答复。Hermes 的测试耗时和历史网关探测不能替代这个结果。首次有限生产运行需要先获准；不能为了“部署前测量”自行安装或启动产品。

使用用户批准的专用工作区和一个虚构内容文件，只授权这次文件读取与结果披露。请求要求读取该文件并回答指定内容；不让模型执行写文件、Bash 或任意网络任务。工具未执行、执行了其他操作、回复不匹配文件或 Run 未到终态时，保留失败记录并停止，不能把这一轮当成功响应时间。生产请求数量、模型路由、标题/记忆的附带请求、输出上限、费用预算及期限在执行方案中固定。

| 指标 | 记录与计算 |
| --- | --- |
| 用户等待总时长 | 同一浏览器的单调时钟记录提交、首次可见内容和完整回复时间；总时长包括 SSH 隧道、网络、模型、工具和审批等待 |
| 工具处理时长 | 对同一 `threadId/runId/itemId` 从持久 `thread.execution` 记录读取 `phase`、`occurredAt` 和 `sequence`，计算 started 到 completed/failed/stopped；原始记录和审批等待单独列出 |
| 服务端终态与实际结果 | 用产品查询和只读状态核对这一轮 Run、工具调用与最终回复，只接受同一执行身份；由用户核对虚构文件正文和答复。完整工具结果、审批与终态依据保留脱敏副本 |
| 实际费用与运行条件 | 记录各物理模型请求的实际账单和计费是否未知、执行版本与安装包摘要、目标系统/负载/磁盘空间、路由结果以及此次是否首轮请求 |

浏览器和服务器的绝对时间不相减；它们的时钟未证明同步。界面显示的工作时长会扣除审批等待，因此也要列出用户实际总等待，不能只报界面数字。单次结果只说明这一轮，不能作为长期延迟分位数或磁盘根因证明；后续重复或更换存储由用户决定。

保留精确操作、开始/结束时间、退出结果、执行身份、状态读回和费用记录到 `.ci-output/production/<本次独立目录>/`，不保留密码、令牌、OTP 资料或私人正文。测量结束后向用户报告这些数值及失败/未知项，再问“测得的响应时间是否可以接受？”。只有用户明确答复后才记录 L3 的决定；首次部署安排 L4 单独记录，不以预检批准代替。

[返回导航](#reading-navigation)

<a id="verification"></a>

## 验收

- 服务状态、Agent 与 Worker 的就绪事件、`doctor` 与 `db status` 的只读输出。
- 从服务器外部确认控制中心端口没有对公网开放。
- 用户通过隧道完成一次对话；数据库里能读回这一轮的 Run 记录。
- 部署记录（提交号、安装包摘要、服务器环境、执行过的命令和结果）保存在 `.ci-output/production/` 下。
- 用户明确批准本次生产运行，当前主机能力资格与实际安装匹配；缺失时停止，不把 R2-L2 环境检查当作生产工具资格。
- [响应时间测量](#response-time)有实际结果与独立状态读回，用户明确决定是否接受；第二轮的其他条目不因此自动关闭。

[返回导航](#reading-navigation)
