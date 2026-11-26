---
status: active
document_type: adr
decision_status: accepted
supersedes: "https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0025-pi-tools-and-managed-execution-lifecycles.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0026-job-scoped-network-egress.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0029-protected-native-runtime-history.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0030-durable-workspace-release-facts.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0031-isolated-tool-execution.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0032-original-directory-disk-and-sensitive-file-limits.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0033-process-sandbox-default-and-optional-containers.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0036-agent-worker-restart-as-a-pair.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0037-macos-bundled-bash.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0054-readonly-tools-in-host-and-reused-task-sandbox.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0055-bash-uses-system-commands-in-sandbox.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0069-trust-unprotected-runtime-like-claude-code.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0072-linux-pid-namespace-sweep-counts-as-release-confirmed.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0094-stop-job-host-supervision-after-final-result.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0116-reuse-host-file-check-by-file-state.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0156-srt-0-0-81-with-a-locked-seccomp-helper.md"
superseded_by: ""
date: "2026-11-26"
covers: "packages/runtime-sandbox/src/user-computer/manager.ts, scripts/operations/computers/install-computers.sh, scripts/operations/computers/settings.json, apps/agent-service/src/production-computer-tools.ts, apps/agent-service/src/production-browser-tools.ts, packages/runtime-sandbox/computer-image/himawari-browser.mjs, packages/runtime-sandbox/computer-image/Dockerfile, packages/runtime-sandbox/src/job-host.ts, packages/execution-contracts/src/sandbox-runtime-version.ts, packages/platform-node/src/capabilities/sandbox-host-verifier.ts, apps/agent-service/src/production-sandbox-services.ts, apps/execution-worker/src/production-sandbox-execution-v2.ts, packages/runtime-sandbox/scripts/check-srt-boundary.mjs"
verified_at: "e691135f5add430cdec85201e781a6eb59e96a45"
---

# ADR 0298：工具在哪里执行：沙箱和执行环境

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
  - [控制和执行分开](#planes)
  - [默认用进程级沙箱，容器是可选的严格模式](#modes)
  - [只读工具在主进程，命令和写入复用沙箱](#tools)
  - [最小权限和失败即拒绝](#least-privilege)
  - [网络出口](#egress)
  - [停止、释放和工作区占用](#release)
  - [安装核验](#host-check)
  - [SRT 版本](#srt)
  - [进程和历史](#process)
  - [每人一台电脑](#user-computers)
  - [浏览器](#browser)
- [还没做到的](#not-yet)
- [放弃的做法](#rejected)
- [后果](#consequences)

<a id="context"></a>

## 背景

模型调用的工具（尤其是会执行代码、改文件、联网的工具）在哪里执行、怎样隔离、怎样停止，原来分散在十六份 ADR 里（0025、0026、0029 到 0033、0036、0037、0054、0055、0069、0072、0094、0116、0156），后面的多次部分修正前面的（例如 0033 把默认方式从容器改成进程级沙箱，0054 让只读工具回到主进程）。这份 ADR 只写现在为真的做法。工具调用本身的生命周期（批准、超时、后台命令、结果未知）见 [ADR 0299](0299-tool-calls-and-command-lifecycle.md)。旧文全文在 `supersedes` 列的固定提交链接里。

SRT 指 Anthropic 开源的 sandbox-runtime（`@anthropic-ai/sandbox-runtime`），在 Linux 上用 bubblewrap 和 seccomp 限制一个进程能读写的文件、能连的网络。Job Host 是 Worker 为执行工具起的宿主子进程。

<a id="decision"></a>

## 决定

<a id="planes"></a>

### 控制和执行分开

- Agent 控制面（模型循环、授权、持久状态）和有副作用的执行面分开。Shell、任意代码、构建工具、包管理器、Git 写操作、浏览器自动化等会改文件、联网或起进程的工具，不在 Agent 主进程里执行，而在 Execution Worker 管理的隔离环境里执行。
- 模型侧复用 Pi 的工具定义和 Agent 循环，只提交操作意图；授权和持久状态归 Himawari，隔离归执行后端。不另建工具框架或模型循环。
- 工具结果、副作用证据、监管状态和清理状态分别保存。命令正常退出只是命令结果；未知副作用和监管失联继续阻止依赖它的动作，也不能说成功。
- 取消只是停止请求，不证明副作用没发生；重启、重新审批、换主机都不能成为自动重放未知操作的通道。

<a id="modes"></a>

### 默认用进程级沙箱，容器是可选的严格模式

- macOS 和 Linux 都默认用 SRT 模式：工具由独立的 Job Host 进程在 SRT 限制下运行。SRT 做不到的限制按资格记录如实报告，不宣称已经做到。
- 容器是可选的严格模式，只在配置 `taskEnvironments` 里明确打开时使用，即使装了容器运行时也不自动切换。打开后所有工具都在容器里跑，容器还不支持的工具显示“不可用”。两种模式之间不静默回退，同一个安装同一时间只用一种。
- 后台任务、服务类任务和无人值守任务在 SRT 模式下照常允许，但界面要让主人看清用的是哪种模式、哪些后台程序还在跑、停止是否经过严格确认。
- 执行后端的接口由产品自己定义，不依赖某个容器产品；不由产品自带虚拟机。

<a id="tools"></a>

### 只读工具在主进程，命令和写入复用沙箱

- `read`、`ls`、`find`、`grep` 在可信主进程执行，复用 Pi 的工具实现，Himawari 只提供带路径检查的文件操作：解析后的真实路径必须在授权目录内，不能经 `..`、符号链接或硬链接跑出去；不写文件、不启动未核对的外部程序、不自动下载。做不到这些条件的工具继续进沙箱。
- `bash`、`write`、`edit` 等在任务级隔离环境执行，同一轮对话（一个 Run）的多次调用复用同一个沙箱；复用只在同一所有者、同一任务、同一冻结授权和期限内成立，一轮结束或授权变化时停止并释放。
- 沙箱里的 `bash` 可以用系统自带的程序：子命令的 PATH 依次是 `runtimeRoot/pi-tools/bin`、`/usr/local/bin`、`/usr/bin`、`/bin`，安装包里核验过的 `bash`、`rg`、`fd` 排在最前；系统程序不计入安装摘要。`PI_OFFLINE=1`，工具运行时不自动下载。

<a id="least-privilege"></a>

### 最小权限和失败即拒绝

- 文件：只有授权的工作区、必要输入和可信运行文件可见，可写路径单独授予；挂载目录不等于能读其中所有内容。原目录模式只遮挡创建环境时已存在的敏感文件，受保护文件有多个硬链接时拒绝原目录模式；运行期间新建的敏感文件读得到，这一点要在授权说明里写明。
- 资源：CPU、内存、进程数、硬期限和任务私有临时目录的额度由运行时强制。原目录模式的磁盘用量是非硬性保护：准入时和运行期间检查剩余空间，跌破下限或增长过快就整体停止环境；观察跑不起来时不启用原目录模式。
- 凭据不无条件暴露给任务；默认非 root、no-new-privileges。
- 后端不存在、启动失败、停止或核查无法确认时，返回明确、可恢复、可审计的错误，绝不静默退回主机执行。

<a id="egress"></a>

### 网络出口

- 每个 Job Host 建自己的认证 HTTP 上游出口，SRT 的 `parentProxy` 指向它，`noProxy` 清空。出口只放行冻结的主机名和端口，每次建连时解析并检查全部地址，拒绝非公网和特殊用途地址，再用检查过的 IP 连接；不解密 TLS，不注入凭据，不自动跟随重定向。
- 出口准备好之后才允许 SRT 初始化和任务启动；停止时立即关闭监听和所有连接。默认不能联网，联网由任务的联网授权决定。

<a id="release"></a>

### 停止、释放和工作区占用

- 核心规则：旧任务的执行环境没被确认不会再产生副作用之前，不释放它的工作区占用，也不让冲突的新任务接管。授权到期、工具退出、Run 结束、主进程消失都不是释放证据。
- SRT 模式下，宿主确认任务的进程组已经全部消失，就结束这次调用的目录占用，释放记录写明依据是 `process_group_gone`。用 `setsid`、两次 fork 脱离进程组的后代不跟踪，也不挡目录；只有停止本身失败或无法确认时才继续挡住目录，交给恢复流程。
- 在 Linux 常驻路径上，任务宿主确认整个 PID 命名空间都扫过（`namespaceSwept`）时，释放记录带 `cleanupScope: "pid_namespace"`，页面显示“已释放”；没有这一项的 `process_group_gone`（Mac、一次性路径、旧记录）显示“停止未经严格确认”。容器严格模式是唯一写 `cleanup: confirmed` 的路径。
- 释放是接纳时经宿主核验、持久保存的历史事实，和占用结束在同一个短事务里提交，以后不因时间推进重新判定；结果交接（ACK）迟到或重复不影响释放事实，也不会让工具重新执行。之后真有新风险时另建关联原操作的风险记录，不恢复旧占用。
- 授权范围回答“允许访问什么”，资源协调回答“这次操作要保护什么”：拿到整个目录的授权，不等于把一次文件提交当成整个目录的排他操作。
- 停止证明只证明不会继续执行，不撤销已经写入的文件或已经发出的数据。

<a id="host-check"></a>

### 安装核验

- 受保护安装：程序归 root 所有，运行账号不能改部署文件；root 发布 `protected-runtime.v1` 记录，每个进程按它完整审计一次。
- 未保护安装信任安装结果：宿主核验不再读取、计算摘要或遍历运行时目录和可执行文件的内容，只检查绑定、资格、平台、资源上限和各路径的规范性（绝对路径、不是符号链接、组和其他人不可写、属主正确）。防改动靠沙箱把运行时目录作为只读路径交出，策略拒绝它和工作区、私有目录重叠。
- 服务进程里的宿主核验按“文件状态”（每个受检路径的 `lstat` 信息加绑定内容的摘要）复用最长 10 秒（`SANDBOX_HOST_REUSE_MS`）；核验前 2 秒内被改过的文件不记下，重启全部作废。授权每次照常重判，Worker 启动前那次完整核验不变。

<a id="srt"></a>

### SRT 版本

- SRT 锁定 0.0.81，版本号只来自 `SANDBOX_RUNTIME_VERSION`；`npm run check:srt-version` 要求依赖文件和实际安装的包都等于它。策略显式写 `allowNestedUserNamespaces: false`。
- Job Host 启动前核对实际加载的 SRT 版本和 Linux 上 seccomp 小程序的路径与 SHA-256，不符就不启动（`JOB_HOST_SRT_VERSION_MISMATCH`、`JOB_HOST_SECCOMP_HELPER_UNAVAILABLE`）；SRT 生成的命令结尾必须严格等于锁定小程序加我们传入的命令，否则报 `JOB_HOST_SECCOMP_HELPER_NOT_IN_USE`。
- 真实沙箱边界检查 `check-srt-boundary.mjs` 用真实 SRT 和 bubblewrap 逐项验证（嵌套用户命名空间、AF_VSOCK、io_uring、只读临时目录），每项带阳性对照；它在出包时的上线包检查里跑，不进 `npm run check`。

<a id="process"></a>

### 进程和历史

- Agent Service 和 Execution Worker 是一个重启单位：任一进程退出，就停掉另一个再一起重启，先停 Agent 再停 Worker。“只剩一个进程在运行”时产品只保证不交付未确认的结果、不重复执行工具。
- Job Host 交回最终结果后，调用方不再检查心跳和租约；之后迟迟不退出由收尾期限兜底强制清理。
- 运行历史由 Himawari 受保护地持久化：Pi 的原生消息作为不可变的加密 Payload，快照保存有序引用。模型调用、工具执行和停止确认之前先等需要的历史写完，写不进去就终止继续执行。展示用的过程记录和规范运行历史分开保存。

<a id="user-computers"></a>

### 每人一台电脑

Andy 2026-11-26 同意的方案是给每个用户一台用 gVisor 隔离的长期“电脑”（gVisor 是 Google 开源的容器运行时，命令名 `runsc`，给每个容器一个用户态内核，容器里的程序碰不到宿主的真内核）。现在已经有的部分：

- 电脑管理 `UserComputerManager`（`packages/runtime-sandbox/src/user-computer/`）：按用户 id 算出用户键，每个用户一个 Docker 容器 `himawari-computer-<用户键>`，用配置里的运行时（生产是 `runsc`）启动；第一次用时创建，关着就开机，开机前按宿主 `/proc/meminfo` 的 `MemAvailable` 减去预留量判断放不放得下，放不下先关最久没用、没有调用在跑的电脑，还不够就排队，超过等待时长报 `COMPUTER_WAITING_FOR_MEMORY` 并写明在等什么。每台电脑的内存用量读 cgroup 的 `memory.current` 加宿主上 runsc 进程的 RSS，不用 `docker stats`（东京机上它显示 0）。
- 空闲关机：没有调用在跑、最后一次调用结束超过配置的空闲时长就 `docker stop`，只停不删。常驻的浏览器进程不算“在用”。30 天没开机的电脑可以列出来（`staleComputers`），删除要调用 `deleteComputer`；在聊天里先问用户、确认后才删，这一步还没接上。
- 磁盘：每人一个固定大小的 ext4 磁盘文件，loop 挂到宿主上同目录的 `home/`，再绑定挂到电脑里的 `/home/himawari`，写满就写不进。根目录保持 runsc 默认的覆盖层，`apt` 装的东西关机就没了；pip、npm、micromamba 的安装位置由镜像的环境变量指到家目录。
- 隔离和网络：每台电脑在自己的 `--internal` Docker 网络里，别的用户的电脑连不到；去掉全部能力后只加回装软件要用的几项，`no-new-privileges`，内存、CPU、进程数有硬上限。出口代理开在这个网络的网关地址上，带每台电脑自己的口令，只放行这个用户当前正在跑的所有调用给的网址的并集，没有调用在跑时全部拒绝，并沿用现有出口的公网地址检查。
- 接口：`UserComputers.exec({ ownerId, argv, stdin, cwd, env, allowedDomains, deadlineAt, maxOutputBytes })`。挂磁盘要 root，所以电脑管理由单独的 root 进程（`user-computer/host-main.ts`）运行，经一个只有服务账号组能连的 Unix 套接字收请求；Himawari 服务用 `UserComputerClient` 调它，不需要 Docker 权限。开机失败就报错，不退回 SRT。
- 镜像：`packages/runtime-sandbox/computer-image/Dockerfile`，基于按摘要锁定的 Playwright 镜像，带 Chromium、Node、Python 文档库和 micromamba。`.github/workflows/user-computer.yml` 在 GitHub 的 arm64 机器上装锁定版本的 gVisor、构建镜像，并在 runsc 里跑资格测试 `test/qualification/user-computer-qualification.ts`。
- 编码工具：配置里有 `runPolicy.userComputers`（电脑管理套接字的路径）时，`read`、`write`、`edit`、`bash`、`find`、`grep`、`ls` 七个编码工具在授权通过之后交给主人自己的电脑执行（`apps/agent-service/src/production-computer-tools.ts`），不再走 SRT，也不发执行句柄。做法是把 Himawari 打包好的程序目录（编码能力的沙箱绑定里的 `runtimeRoot`，每次上线自动换成新版本）只读挂到电脑里的 `/opt/himawari`，在电脑里运行和容器模式同一个 Pi 运行器 `container-pi-main.js`，工作目录是 `/home/himawari/workspace`；所以 Pi 自带的 `grep`、`find` 用的是电脑里的 `rg`、`fd`，不碰宿主。程序目录换了版本时电脑会重建一次，家目录不受影响。路径仍按授权目录检查，再换成工作目录里的相对路径；电脑里在授权目录原来的路径上放一个指向工作目录的链接，模型在 `bash` 里写原来的绝对路径也能用。命令能用的软件路径由镜像的 `HIMAWARI_COMMAND_PATH` 给出，包括家目录里装的软件。网络按编码能力绑定里这个工具的网络设置放行部署配置的网址。
- 第一次给某个用户执行编码工具时，先把这个用户原来授权的目录整个复制到电脑里的 `~/workspace`（电脑管理的 `seedWorkspace`，只认配置 `hostPaths.seedRoots` 下的目录），只复制一次，记下来源和时间；复制失败就报 `COMPUTER_SEED_FAILED`，工具不执行。之后电脑里的改动不写回原目录。
- 一次调用发到电脑之后服务重启、没拿到结果的，下次报“结果未知”，不自动重做。工具在电脑里跑时不能开 `move_directory` 和 `save_copy`（它们改的是宿主上的原目录），配置校验会拒绝。`bash` 的工具说明换成电脑版（`tools.builtin.bash.computer`），写明家目录里的东西关机后还在、`apt` 装的关机就没了；按对话冻结的规则，只对新对话生效。
- 生产安装：自动上线在服务读回就绪之后，以 root 运行 `scripts/operations/computers/install-computers.sh ensure --release <正在运行的版本>`（`scripts/delivery-mode/ci-deploy.sh`）。它可以重复跑：缺 Docker 就装，装 `scripts/operations/computers/settings.json` 里锁定版本和校验值的 gVisor 并登记为 Docker 运行时，在本机构建电脑镜像、用镜像 ID 当摘要，写 `/etc/himawari-computers/config.json` 和 `himawari-computers.service`（用正在运行那一版里的 `host-main.js`），套接字归服务账号的组。所有数值都在 `settings.json` 里。出包时按实例文件 `configTargets.computers` 在生产配置里加上 `runPolicy.userComputers` 和 `runPolicy.browser`（`make-packet.py` 的 `run_policy_target()`），回滚还原原配置时一起去掉。这一步失败时主服务照常运行，上线结果记为失败（`CI_DEPLOY_REFUSED COMPUTERS_FAILED`）。

<a id="browser"></a>

### 浏览器

浏览器工具 `browser`（`apps/agent-service/src/production-browser-tools.ts`）在主人自己的电脑里开网页、点击、输入、按键、后退、截图和读页面文字。电脑里的程序是 `himawari-browser`（`packages/runtime-sandbox/computer-image/himawari-browser.mjs`），用 Playwright 起一个常驻的 Chromium，资料目录在家目录的 `~/.himawari/browser/profile`，所以登录状态留在主人自己的磁盘上；电脑关机前，电脑管理先执行 `himawari-browser stop` 把浏览器收好（配置项 `beforeStop`）。

- 每次动作都是一次 `UserComputers.exec`，网址只能经电脑的出网代理出去。`open` 放行要去的网站，`click`、`type`、`press`、`back` 放行当前页面所在的网站，`read` 和 `screenshot` 什么都不放行。没放行的网站代理直接拒绝，工具报 `BROWSER_SITE_NOT_ALLOWED` 并说出是哪个网站。
- 授权走统一的主人范围授权，目标类型是 `browser-site`，按网站问主人；已有的“这次任务 / 几天 / 一直”照常有效，读过外部网页后只认“这次任务”。授权提示的文字按主人设的界面语言。
- 截图只交给能看图的模型（看模型目录里这个模型的输入类型），交给 Pi 的工具结果里多一张图；不能看图的模型只拿到一句说明。
- 配置里同时有 `runPolicy.userComputers` 和 `runPolicy.browser`（单次输出上限、正文字数上限、给回复留的时间）时才开这个工具；只有后者，配置校验拒绝。

<a id="not-yet"></a>

## 还没做到的

- macOS 安装包自带一份核验过的 Bash（`runtimeRoot/pi-tools/bin/bash`，计入安装摘要并附 GPLv3 许可证和源码获取方式）已决定但未实现；来源、版本和签名方式要先写 Spec 由 Andy 确认。Mac 上的服务端验证目前无限期推迟。
- 远端执行只预留了接口：Agent 目前只能配置一个非 SRT 后端，远端执行还要先传入工作目录、结束后核对版本再写回。
- 每人一台电脑：工具在电脑里跑时，`bash` 之后的“工作目录改动”记录和对话里的产出文件列表还没接上（它们读的是宿主上的授权目录）；30 天没用的电脑在聊天里先问再删也还没接上。

<a id="rejected"></a>

## 放弃的做法

- 默认每个任务一个容器：资格和运维成本高，个人部署大多数时候用不上；改为可选的严格模式。
- 每次工具调用新建一个沙箱：首次建环境要好几秒，同一轮里重复付出。
- 把脱离进程组的后代也当成挡住目录的条件：SRT 模式下跟踪不到它们，结果是目录被长期误锁。
- 每次调用都对整个运行时目录算摘要：耗时长，未保护安装又挡不住同账号改文件，改为靠沙箱只读和受保护安装。

<a id="consequences"></a>

## 后果

- SRT 模式下，脱离进程组的程序可能在“停止未经严格确认”之后仍在运行、改文件或联网；界面如实显示，需要严格保证时打开容器模式。
- 升级 SRT 要同时改版本常量、seccomp 小程序摘要，并让真实边界检查通过。
