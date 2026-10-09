---
status: active
document_type: plan
supersedes: ""
superseded_by: ""
date: "2026-09-30"
---

# 生产服务器首次部署计划

**依据：** [SOURCE: docs/adr/0051-second-production-host-acceptance-exception.md#hosts]（云服务器只用于生产；普通测试、构建与整套资格在 Hermes；本次首次安装仅允许经具体授权的有限主机能力验收，旧云测试环境原样保留）及 [SOURCE: docs/adr/0048-vercel-ai-gateway-replaces-openrouter.md]（文本、嵌入及路由）。

**目标：** 把 Himawari 部署到生产云服务器 `84.247.157.41`，让用户通过 SSH 隧道（把服务器本机端口转发到用户自己电脑的 SSH 功能）打开控制中心（Himawari 的网页界面）亲自体验。

**当前安排（2026-10-07）：** 按用户G52，Claude 规划和审核，Codex 实施和自审。G50的云端只读预检已经结束，G51批准的有限主机能力验收例外已保存。当前先在Hermes验证验收适配，补齐工具安装前提，再固定具体云操作清单并申请授权。原暂缓部署决定仍有效，用户的“继续”用于推进准备工作。服务仍只监听服务器本机地址，通过 SSH 隧道访问。生产服务使用普通用户，root SSH 仅用于当次获准的管理步骤。

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
- [本次第二次部署的授权边界](#second-deployment-authorization)

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
- 测试用户 `himawari-test` 和 `/srv/himawari-test/` 已建立，2026-10-02 起不再使用、原样保留。2026-10-07 用户选择部署前清掉（长任务目标文件 `.agents/tasks/round2-tool-execution/goal.md` 的 G58）：Claude 写好脚本并逐条说明删除内容，删除该账号和该目录。原定由用户自己运行；用户 2026-10-07 改为在手机上逐步批准后由 Claude 用已有 root 密钥执行并读回结果（同一目标文件的 G63，只限本次首次部署）；bubblewrap（沙箱启动程序）0.11.2 及其 AppArmor（Ubuntu 的程序权限限制机制）规则保留给生产使用。脚本运行前不登录、不改动旧测试环境。生产服务要另建专用用户和目录，不能与之共用。

当时记录的前提：

1. **AppArmor 与 bwrap。** Ubuntu 24.04 默认限制普通程序创建用户命名空间，产品沙箱用的 bwrap 会被挡住，见 [BL-20261001-001](../../backlog/BL-20261001-001-ubuntu-24-04-默-认-禁-止-bwrap.md)。[SOURCE: docs/backlog/BL-20261001-001-ubuntu-24-04-默-认-禁-止-bwrap.md] 系统 `/usr/bin/bwrap`（0.9.0，SRT 路径使用）已由用户加了只针对它的规则。program 与 stdio MCP 的隔离后端要求 bubblewrap `>=0.11.2`（ADR 0021），已在测试目录从官方源码编译。用户 2026-10-01 以 root 运行脚本，把它安装到 `/usr/local/libexec/bubblewrap-0.11.2/bwrap`（root 所有，权限 0755，SHA-256 `20a3bdb6c1147f62a043a9d4d9c7873db233df40f11a0cc48731a16b97e008f3`），并新增只针对这个路径的规则 `/etc/apparmor.d/bwrap-0.11.2`；以测试用户运行（含 `--unshare-net` 断网隔离）验证成功。生产配置要指向这个路径，安装说明要写明这两条规则。
2. **磁盘同步写入慢。** 实测每次 4 KiB 同步写入约 11–19ms，比 Hermes 固态盘（约 3ms）慢数倍；同一流程的测试在这台机器上超过 5 秒，见 [BL-20261001-002](../../backlog/BL-20261001-002-回-到-同-步-写-入-快-的.md)。[SOURCE: docs/backlog/BL-20261001-002-回-到-同-步-写-入-快-的.md] 部署前测量一次真实请求（一次对话加一次工具调用）的响应时间，结果告诉用户，由用户决定是否接受或更换存储。
3. **版本。** 2026-09-30 的版本安排保留为历史决定。之后有暂缓部署、上线前修复和网关迁移的决定；当次部署重新固定已推送提交与测试证据，不直接使用当时安装包。

[返回导航](#reading-navigation)

<a id="current-prerequisites"></a>

## 当前证据与部署前提（2026-10-08）

以下是准备依据，尚未在云端执行安装或启动。

| 范围 | 保留证据与实际边界 |
| --- | --- |
| 产品可执行内容 | 冻结生产候选来源为 `3a65b9006b83d2a24bc7b2fbb1c1c831f239b841`。其后本批只增加 R2-L6 探针、测试和文档，产品可执行内容、依赖、CI 配置未改；生产部署仍须具体授权 |
| Hermes 完整检查 | `3a65b90` 上第 1 层、第 3 层构建与五项目完整测试 5469/5469 通过；不筛选 Linux 产品路径 47 通过、0 失败、1 原可选性能对照跳过。原件见[最终代码证据](../../../.ci-output/handoff/2026-10-07-codex-round2-d4-a1-stop-01.md)。本批新增探针后的检查另外记录，不能把历史结果称为新版本全测 |
| 云端工具环境 | G47 的 bubblewrap 身份、版本和 AppArmor 检查通过，G50 的历史预检见下文。R2-L2 环境证据仍不能替代当次生产预检；本批不连接云服务器 |
| 安装包 | 同一冻结 Linux x64 ABI127 候选，66607727 字节，SHA-256 `6cc0c9d8b273fa1e5c4b46d053f9b146ae9613506027feabd8b635a82ac7fbd3`；context 497 字节，SHA-256 `a2932641a699830b9826713cf6b10467c05c071656d5db0289732f768cb10f87`。包仍在 Hermes 本任务检出的 `.ci-output/r64-d4-rework-a1-final-01-product-build/`，尚未复制到云端 |
| 最终版本检查 | 条目状态只取 `longtask.py status`。最终 Cfa 第十组三次与完整第1层通过，whole业务49通过/0失败/1原基线跳过、Vitest0；原外层因late opaque清理拒绝退出1，保留现场，[BL008](../../backlog/BL-20261007-008-同-账-号-不-可-读-进-程.md)保持open。源码提交推送ba2bcf6并获Claude独立approved；预算重置及主trace控制缺陷按实际范围关闭，见[最终证据](2026-09-28-tool-execution-audit-plan.md#r74-final-validation) |
| Hermes 验收适配 | G59 唯一冻结命令已执行：Pi 22、网络 10 场景通过，实际安装前后摘要相同；报告保持非生产且未签署。原件见[G59 验收与清理报告](../../../.ci-output/handoff/2026-10-07-codex-round2-d4-a1-stop-02.md#evidence)。651264 字节历史空间差额已在该报告保留，不改写为全恢复 |
| 工具安装前提 | G53/G59 的 fd 10.5.0 与 is-number 7.0.0 固定输入和安装已通过原 32 场景。云端仍须在获准后按 P8 下载、核对并安装工具，使用云端现场 Bash、rg 和正式 Node 工具目录；Hermes 摘要不代表云端工具身份 |
| 有限真实重启 | 已有 `--runtime` 只读入口在最终三次及完整P8中使用同实际安装，十断言、before/after/fresh摘要与原期限通过；未知占用、真实同库重启、不重放、可信释放与新准入有原件。原effect仍unknown/result仍null，新请求随后取消，没有第二次Bash执行；云端未执行或签署，见[最终证据](2026-09-28-tool-execution-audit-plan.md#r74-final-validation) |
| 当前云操作清单 | [P0–P13 审阅稿](../../../.ci-output/production/2026-10-07-first-deploy-packet-01/README.md)仍待具体逐步授权。相同运输材料在Hermes新空目录的原artifact完整安装及七报告P8、11安装文件取证和原清理已通过（E20261008T094449-48ed2b），原三次控制失败保留。P6候选CLI doctor第二次严格加载0（E20261008T100042-26d55a），schema正确、ready=false；[原件](../../../.ci-output/tool-execution-audit/2026-09-28/round2/hermes-r74/p5/p6-doctor-02-full/)只证明scratch派生配置加载，没有init/服务/模型。26原身份gone、hyzh3 absent、清理0，225280B短差未知；原run01在doctor前控制失败且无fresh BEFORE保留。旧final04/central01保持历史原件；正式85路径漏传P5源码证明已在Hermes由同一材料检查先失败1、修正后通过0，记录 `E20261008T102918-e3116e`、`E20261008T102918-e5615a`。当前prep08为86正式+8 Hermes-only+11审阅、105成员读回0；central02四次完整稳定读取441份实际文件、442条SUMS，记录 `E20261008T102918-420065`。详见[P3运输遗漏及新冻结](../../backlog/BL-20261008-006-p3-正-式-运-输-遗-漏-p5.md#2026-10-08-修正后实际结果)；[BL001准备缺口](../../backlog/BL-20261007-001-首-次-部-署-清-单-的-准.md#2026-10-08-最终公开清单与集中材料读回)按reply-01关闭，不视为生产参数批准；正式Node官方SUMS、云端host/tool/UID/workspace、有限验收、签署、服务、秘密和付费均未执行；R2-L3/L4仍需用户决定 |

安装与启停依照[安装 Runbook](../../runbooks/install-start-stop-runbook.md#live-state-preflight)。[SOURCE: docs/runbooks/install-start-stop-runbook.md] 每次使用前重新检查其静态合同和目标现场；静态检查通过不授权云操作。

- **目标目录与覆盖。** `/opt/himawari`、`/etc/himawari`、`/var/lib/himawari` 仅为本次预检候选。安装器会替换前缀中的 `lib/himawari-agent`，初始化命令则拒绝已有 state root。发现已有路径、链接或服务时停止制定覆盖动作，先核对归属和恢复条件；本次不递归读取这些目录。实际安装、配置和 state root 在下一份批准方案中固定。
- **运行用户、Node 与服务。** `himawari-prod` 与 loopback 端口 `8400` 仅为候选，预检只检查是否存在或被占用。安装器生成的入口从 PATH 调用 Node，因此需要核对目标 Node 及其来源，不能使用旧测试账号或目录的工具链。2026-10-07 用户选择官方 Node 22.22.3（同一目标文件的 G57）：从 nodejs.org 下载官方 Linux x64 压缩包，用官方 SHASUMS256（官方发布的文件指纹清单）核对，放进 Himawari 自己的安装目录，root 所有、服务账号只读；版本与 Hermes 测试用的相同，安装包按它的 ABI 127（Node 原生模块接口版本）构建。这是一次新下载，云操作清单要写明下载地址、文件大小和指纹，单独取得用户授权后才下载。当前安装 Runbook 不包含 systemd 服务注册；系统服务文件、权限、启动/停止顺序和恢复步骤需另给具体方案，不能猜命令直接注册。
- **真实工具资格。** 产品要求能力部署快照与实际主机、运行时和安装字节匹配；缺失、过期或不匹配时 Worker 保持未就绪。不能复制 Hermes 的测试资格夹具，也不能虚填 `productionSuitable`。G51允许[本次首次安装限定验收](../../adr/0051-second-production-host-acceptance-exception.md#first-install-acceptance)，先在Hermes验证适配，再取得具体云操作清单授权；验收和签署完成前停止真实工具启动及测量。当前管理员 CLI 没有生成资格的命令，不编造 `sandbox qualify`。
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

原批准范围见[问询11](../../../.ci-output/handoff/2026-10-07-codex-round2-user-question-11.md)，现行规则见[ADR0051沿用的限定验收](../../adr/0051-second-production-host-acceptance-exception.md#first-install-acceptance)。先在 Hermes 验证适配流程，再提供冻结版本、目标、命令、资源和清理边界的生产操作清单；没有具体云端授权就不执行。普通项目测试和构建继续只在 Hermes，旧云测试环境保持，全部产品资格校验保留。

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
| 2：具体部署方案 | 按 [P0–P13 审阅稿](../../../.ci-output/production/2026-10-07-first-deploy-packet-01/README.md)固定版本、安装目录、普通运行用户、配置、服务管理方式、能力资格处理及恢复条件；先处理 BL-20261007-005/006，再核对 Runbook 与原测试证据 | 准备可审阅脚本和配置中的非秘密部分，列出所有覆盖、创建、权限和服务效果；申请本次生产操作。任何目标身份或状态不明就停止 |
| 3：安装与就绪 | 使用已在 Hermes 构建并检查的冻结候选，获准后核对并复制到云端新前缀；按批准顺序建用户、安装、初始化和注册服务。用户管理秘密与账号设置资料 | 云端不跑普通测试、构建或整套产品路径资格；只允许G51限定且本次清单明确授权的主机能力验收。真实工具资格未满足则不启动该工具。原测试账号及 `/srv/himawari-test/` 在部署前用 Claude 提供的清理脚本删除（G58），脚本运行前原样保留。本次首次部署中需要 root 的步骤（清理、安装 Node、注册和启动服务），由 Claude 在聊天里逐行说明脚本、用户逐步批准后用已有 root 密钥执行并读回（G63），不延用到以后的部署 |
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

### reply-09 的材料与验收裁定

按[reply-09](../../../.ci-output/handoff/2026-10-07-codex-round2-cloud-packet-claude-reply-09.md)，临时核对材料改为精确 `3a65b90` bundle、整份锁定 `node_modules`、原锁定 Python 和 Node、候选包及 context。整份依赖在打包前必须证明与锁文件一致，不用原六包子集、不预编译控制层、不在云端补装依赖。Hermes 从空目录按相同 `--artifact` 命令安装，准备工具后对新安装跑原六报告加 R2-L6；临时状态及自有进程只在本任务 scratch，不签发生产资格。

SRT 实际 `/usr/bin/bwrap` 与 program/stdio 的 `/usr/local/libexec/bubblewrap-0.11.2/bwrap` 分别绑定真实版本、文件摘要和各自 AppArmor 规则。只有 program/stdio 保留 `>=0.11.2` 门槛，系统 bwrap 不新增相同版本或相同摘要要求。

G64 取消 Hermes 和云端的 systemd 离线检查，不在别处补做；保留 Node/Bash 语法、P9 实际 ready、身份、握手和原重启算式。原失败保留，[BL-009](../../backlog/BL-20261007-009-hermes-systemd249-不-支-持-首-次-部.md)按用户决定关闭。G57 新下载及 G63 每项 root 操作仍须用户对具体步骤批准；Codex 本批不连接云端。全部云输入集中到 Hermes 的 `/data/hermes/himawari/tool-audit-round2/r30/evidence/cloud-transfer/`，实际摘要、完整 P13 及相对 G59 `-04` 的完整 diff 将随 stop-10 交审。

### 2026-10-08 本次临时材料与独立演练结果

本次首次部署另运输615项源码构建输入的已证完整mode，仅在新建自有 validation/source 中核bytes/身份后还原571项0664、44项0644，再通过原sourceTreeDigest与原artifact检查。这个准备补法只服务本次首次部署，不新增所有安装/升级的外部合同，不改产品或正式runtime。实际composition只记录固定10直接解析；Hermes-only控制层在删除前独立取证全部11候选匹配安装文件，domain仅是补充字节证据。

rehearsal01/02/03分别因gzip读取顺序、未运输完整source mode、10解析/11取证集合混用失败，原退出码、完整原件和清理/资源记录不撤销。修正版rehearsal04完整结果、EID及非生产边界见[最终审计记录](2026-09-28-tool-execution-audit-plan.md#r74-final-validation)。本次outer1040384B、inner1269760B是不同阶段的未知根盘差额，不相加、不用后续空间变化抵销历史短差。BL008旧现场保留与新的清理许可独立。

<a id="second-deployment-authorization"></a>

## 本次第二次部署的授权边界（2026-10-09）

G65 仅批准第二次部署按首次相同限制重做主机能力验收，规则见 [SOURCE: docs/adr/0051-second-production-host-acceptance-exception.md#first-install-acceptance]。G66 选择冻结包经逐步说明、审阅后由 Claude 顺序执行，意外结果停止并保留现场。公开材料位于[第二次部署包](../../../.ci-output/production/2026-10-09-second-deploy-packet-01/README.md)。S0-DB 是用户运行的只读输入步骤，最终付费真实对话为 S10；Codex 不连接生产。此次例外不适用于第三次及以后的部署，普通测试与构建仍只在 Hermes。

G67 选择沿用 `/var/lib/himawari/qualification-workspace`，用新编号 `directory:himawari-prod-workspace-20261009` 创建 90 天目录授权。原授权 `directory:himawari-prod-qualification` 已到期，保留原记录，不延长原记录或删除重建。这个决定只适用于本次授权替换；新授权不复活旧 Run、工具调用或资源租约，规则见[有效权限合同](../specs/2026-09-16-workspace-authorization-lifecycle-design.md#grants)。[SOURCE: docs/execution/specs/2026-09-16-workspace-authorization-lifecycle-design.md#grants] 用户决定及裁定见 [reply-05](../../../.ci-output/handoff/2026-10-08-codex-prod-sandbox-reply-05.md)。

本次冻结包须按以下顺序实现，当前文字记录待生产执行的设计：

1. `S5_ADMIN_CLEANUP` 完成后、S6 前，Agent 和 Worker 保持停止，再执行 `S5_RENEW_WORKSPACE_GRANT`。该步骤使用现有 `workspace grant` CLI；CLI 自行取得 state-root 独占锁，包装器不得预先持有同一把锁。目录和 `--confirm` 均为上述规范路径，`--id` 为上述新编号。`--expires-at` 使用该步骤实际 `startedAt` 加 90 天的规范 UTC ISO 时间，不使用冻结包制作时间。
2. 新授权写入数据库后，独立读回新编号、当前有效状态、`readAllowed`、目录 device/inode 和原授权记录未变的证据。保留已有 capability catalog、能力版本、操作范围、路径策略及其他已批准政策。S6 签署输入须绑定新授权和本次授权创建回执 SHA；签名 snapshot 中仍绑定原规范目录及其 device/inode。此时原配置和原 snapshot 引用保持不变。数据库写入失败或后续签署失败时停止并保留现场，不删除旧授权或重放原 Job。包内同时提供用户执行的备用包装。
3. S7 的数据库前检使用原配置在内存中的投影核对新授权，投影仅替换 `runPolicy.coding.grantId`，不提前改写原配置文件或原 snapshot。前检通过后，正式 `ExecStartPre` prepare 完成新签名和 snapshot 检查，再以一次原子配置替换同时发布新 `runPolicy.coding.grantId` 与新 `capabilityDeployment`。其余配置字段保持不变。新 snapshot 单独先发布；snapshot 与配置不是跨文件事务，中断时保留实际现场并停止。数据库授权创建和配置文件替换是两个步骤。
4. S7/S8 独立读回新授权当前有效、允许 read，且目录 device/inode 与签名 snapshot 一致；读回原授权记录未变，原到期状态属于预期。首次切换检查不能变成长期开机时固定旧授权编号或冻结到期时间的限制；正式产品仍逐次检查真实授权。G65 主机能力验收继续只操作本次新建的虚构目录，不读取原工作目录内容。

Hermes 的已安装产品演练已用公开 CLI 创建新编号，并在新配置和非生产签名 snapshot 下完成真实 HTTP Agent → Worker → JobHost → Pi read，11 项断言通过；旧过期行与 catalog 原字节未变。输入转换和首次切换守卫另覆盖两字段必须共同发布、错误输入拒绝及恢复库缺少新授权行。真实 read 演练没有运行生产固定路径的 prepare 或 systemd，生产 S7/S8 仍须独立读回。原始结果见[授权替换演练](../../../.ci-output/handoff/prod-second-evidence-06/reports/grant-installed03/installed-read/grant-renewal-report.json)。操作检查见[安装 Runbook 的已有目录授权替换](../../runbooks/install-start-stop-runbook.md#workspace-grant-replacement)。

本次49恢复路线恢复旧过期授权选择。50恢复路线的新控制配置可保留新编号，但S4的完整50恢复点早于授权创建，恢复库中没有新授权行。两条路线均不自动补授权，保持停服；账号恢复和再次启动须另获具体批准。恢复成功不表示授权已经可用。

[返回导航](#reading-navigation)
