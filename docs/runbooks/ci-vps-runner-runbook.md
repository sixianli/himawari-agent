---
status: active
document_type: runbook
execution_risk: critical
contract_sha256: "sha256:11bf4f414df75dd72ad9fdc64b5553f4691b32d8e9d2d9a02a3091b85c1d1f33"
supersedes: "docs/archive/runbooks/2026-11-07-hermes-self-hosted-runner-runbook.md"
superseded_by: ""
date: "2026-11-07"
---

# CI VPS 上的自托管 runner Runbook

<!-- runbook-contract:
- scripts/operations/ci-runner
-->

本手册说明 CI VPS（Andy 在 OVH 租的云服务器，Ubuntu 24.04，8 个 vCPU，22 GB 内存，公网地址 `158.69.191.249`，主机名 `ci-vps`）上的 GitHub 自托管 runner（装在自己机器上、替 GitHub 执行 CI 任务的程序；原来两个跑检查、一个只跑汇总作业，2026-11-13 起可再加第 3 个检查 runner `ci-vps-3`，见[安装](#install)第 6 条）怎么准备机器、安装、注册、日常维护、暂停、排错和卸载。为什么这样做见 [ADR 0176](../adr/0176-ci-on-ovh-vps.md)；汇总 runner 的理由见 [ADR 0256](../adr/0256-gate-job-gets-its-own-runner.md)。这台机器只跑 CI，不用来跑 Himawari 的开发测试。

<a id="contents"></a>

## 阅读导航

- [Scope](#scope)：管什么、不管什么，以及各部分放在哪里
- [Authoritative Sources](#authoritative-sources)
- [Safety and Preconditions](#safety-and-preconditions)：权限、令牌、Docker
- [Live-State Preflight](#live-state-preflight)：动手前的只读检查
- [Procedure](#procedure)：准备机器、安装、注册、暂停和恢复、汇总 runner 坏了时的应急、[Oracle 的 ARM 机器上的两个 runner](#arm-site)、日常维护、注销 Hermes 上的旧 runner
- [Verification](#verification)
- [Evidence](#evidence)
- [Rollback](#rollback)：只卸第 2 个检查 runner、第 3 个检查 runner 或汇总 runner，或全部卸载
- [Stop Conditions](#stop-conditions)
- [Troubleshooting](#troubleshooting)

<a id="scope"></a>

## Scope

- **管的范围**：仓库 `sixianli/himawari-agent` 在 CI VPS 上的四个自托管 runner。`ci-vps-1`、`ci-vps-2` 和 `ci-vps-3`（脚本里的编号是 1、2、6）是检查 runner，标签都是 `ci-vps`，`ci.yml` 和 `main.yml` 里写 `runs-on: ci-vps` 的任务派给其中空闲的一个。`ci-vps-gate`（脚本里的编号是 3）是汇总 runner，标签只有 `ci-vps-gate`，不带 `ci-vps`，所以检查任务不会派给它；`ci.yml` 的汇总作业 `ci/required` 改成 `runs-on: ci-vps-gate` 之后只由它来跑（改工作流的那个 PR 合并之前，它在线但没有任务）。
- **不管的范围**：`quality.yml` 停用，等另一个 PR 搬到这台机器（ADR 0176 决定第 8 条）；macOS 的构建和测试已暂停；Hermes 只作合并前本地检查的测试主机，它的操作见[测试主机操作 Runbook](test-host-operations-runbook.md)。

各部分的位置：

| 内容 | 位置 | 属主 |
| --- | --- | --- |
| runner 程序（版本 2.338.2）和工作目录 `_work`（Playwright 浏览器缓存在任务的检出目录里，见 `ci.yml` 的 `PLAYWRIGHT_BROWSERS_PATH`） | 第 1 个检查 runner `/srv/gh-runner/runner/`，第 2 个 `/srv/gh-runner-2/runner/`，第 3 个 `/srv/gh-runner-3/runner/`，汇总 runner `/srv/gh-runner-gate/runner/` | 各自的账号 `gh-runner`、`gh-runner-2`、`gh-runner-3`、`gh-runner-gate` |
| runner 的家目录 | `/srv/gh-runner/home/`、`/srv/gh-runner-2/home/`、`/srv/gh-runner-3/home/`、`/srv/gh-runner-gate/home/` | 各自的账号 |
| 每个任务开始和结束时的磁盘记录 `disk.log` | `/srv/gh-runner/logs/`、`/srv/gh-runner-2/logs/`、`/srv/gh-runner-3/logs/`、`/srv/gh-runner-gate/logs/` | 各自的账号 |
| 任务开始、结束钩子 | `/srv/gh-runner/hooks/`、`/srv/gh-runner-2/hooks/`、`/srv/gh-runner-3/hooks/`、`/srv/gh-runner-gate/hooks/` | root，只读 |
| 每小时清理脚本（每个 runner 和共享目录都清） | `/srv/gh-runner/hooks/clean-old.sh` | root，只读 |
| CI 作业之间传文件的共享目录（每轮运行一个子目录，汇总作业结束就删，见 [ADR 0238](../adr/0238-ci-job-files-stay-on-the-ci-vps.md)） | `/srv/gh-runner-share/`，权限 `2770` | root，组 `gh-ci-share` |
| 暂停、恢复、应急脚本 | Mac 上的入口 `scripts/operations/ci-runner/pause-runners.sh`、`resume-runners.sh`、`gate-fallback.sh`（只改 GitHub 上的标签，不连 VPS）、`arm-fallback.sh`；`pause-runners.sh`、`resume-runners.sh` 和 `arm-fallback.sh` 每次用 `scp` 把 `runners.sh`、`runner-pause.sh`、`runner-resume.sh` 传到 VPS 的 `/home/ubuntu/ci-runner/` 再运行 | ubuntu |
| systemd 服务（Linux 管理后台服务的程序） | `/etc/systemd/system/gh-runner.service`、`gh-runner-2.service`、`gh-runner-3.service`、`gh-runner-gate.service`（都由仓库里的模板 `gh-runner.service.in` 生成）、`gh-runners.slice`、`ghgate.slice`、`gh-runner-nft.service`、`gh-runner-clean.service`、`gh-runner-clean.timer` | root |
| 安装前的备份 | `/var/backups/gh-runner/<时间>/` | root |
| 防火墙规则 | `/etc/gh-runner/nft.rules`，加载后是 nftables（Linux 自带的防火墙）里的表 `inet gh_runner` | root |
| ubuntu 启停 runner 的窄 sudo 规则（ubuntu 本来就有免密 sudo，这条规则留着是为了脚本在别的机器上也成立） | `/etc/sudoers.d/91-gh-runner-control` | root |
| 仓库里的源文件 | [scripts/operations/ci-runner/](../../scripts/operations/ci-runner/) | — |
| 一次性准备的配置 | `/etc/cloud/cloud.cfg.d/99-ci-vps-hostname.cfg`（重启后保留主机名）、`/etc/apt/apt.conf.d/52ci-vps-no-auto-reboot`（安全更新后不自动重启）、`/etc/apparmor.d/bwrap`（只给系统的 bwrap 放开用户命名空间） | root |

身份和限额（写在服务模板 `gh-runner.service.in`、`runners.sh`、`gh-runners.slice` 和 `ghgate.slice` 里）：

- 每个 runner 一个系统用户（`gh-runner`、`gh-runner-2`、`gh-runner-3`、`gh-runner-gate`），不能登录，只属于自己的组，不在 sudo 组或 docker 组里。服务启动时另外用 `SupplementaryGroups=gh-ci-share` 拿到共享目录的组，账号本身不加入这个组；环境变量 `HIMAWARI_CI_SHARE=/srv/gh-runner-share` 告诉 `scripts/ci/run-share.mjs` 目录在哪。这几个 runner 因此能读写彼此在共享目录里放的本次运行文件，取用时靠内容摘要核对发现被改过的文件（理由见 [ADR 0238](../adr/0238-ci-job-files-stay-on-the-ci-vps.md#consequences)）。
- `ProtectHome=yes` 让它看不到 `/home`（包括 ubuntu 的 SSH 密钥），`InaccessiblePaths` 让它碰不到 Docker 的控制接口；`ProtectSystem=strict` 让它只能写自己的三个目录和共享目录 `/srv/gh-runner-share`；每个服务还藏起其他 runner 的目录（例如第 1 个是 `InaccessiblePaths=… -/srv/gh-runner-2 -/srv/gh-runner-3 -/srv/gh-runner-gate`）。汇总 runner 照样执行 PR 里的脚本，并不比检查 runner 更可信。
- `ProtectProc=invisible` 让它在 `/proc` 里只看得到自己的进程，看不到本机其他服务的进程和命令行参数。
- 服务不在 `/proc` 下加任何挂载，所以不设 `ProtectKernelTunables`、`ProtectKernelLogs`，`ReadOnlyPaths`、`InaccessiblePaths` 里也不写 `/proc` 下的路径：项目沙箱要给自己新挂一份 `/proc`，VPS 的内核遇到这类挂载会拒绝，沙箱就起不来（原因和复现见 [ADR 0176](../adr/0176-ci-on-ovh-vps.md#decision) 决定第 6 条）。
- 防火墙规则只对这几个 runner 账号生效（一条规则同时匹配这几个账号的 uid）：拒绝它访问私有网段（`10/8`、`100.64/10`、`172.16/12`、`192.168/16`、`fc00::/7`、`fe80::/10`）和 `169.254.0.0/16`（云主机的元数据服务地址），以及本机任何地址（回环地址、公网 IPv4 和 IPv6 都算，规则写作 `fib daddr type local`）上端口名单里的 TCP 端口（DNS 的 53 端口除外）。名单在每次生成规则时取当时在监听的端口，再加上上一份规则里已有的端口。访问互联网不受影响。防火墙不管 UDP 和本机的 Unix 套接字（同一台机器上进程之间通信用的文件形式的接口）：Unix 套接字靠文件权限挡住，Docker 的控制接口另外被藏起来。
- 同一个 runner 上的所有任务都以同一个账号运行，所以一个任务能读到这个 runner 自己的注册凭证，也能改 runner 的安装文件和后面任务的残留。仓库是私有的，只有 Andy 和他自己的代理线程会推送，所以接受这一点。这也是所有 runner 都不给 docker 组的原因：docker 组等于 root，一个任务就能拿到整台机器。怀疑 runner 被改过时，按 [Rollback](#rollback) 完整卸载后重新安装、注册；只重新运行安装脚本不会重新解压 runner。
- VPS 只跑 CI，所以 runner 不限 CPU，CPU 和磁盘优先级用系统默认。每个检查 runner 内存最多 15 GB（`MemoryHigh=14G`、`MemoryMax=15G`），不用交换分区，最多 2048 个进程。三个检查 runner 的服务都放在 `gh-runners.slice`（把几个服务放进同一个资源分组、一起设上限的单元）里，合计内存最多 16 GB（`MemoryHigh=15G`、`MemoryMax=16G`），最多 6144 个进程。汇总 runner 单独放在 `ghgate.slice` 里：预留 2 GB（`MemoryMin=2G`，检查任务把内存吃满时系统也不会先回收它这一份），上限 4 GB（`MemoryHigh=3G`、`MemoryMax=4G`；2026-11-14 收报告时在 2 GB 上限处被系统按内存超限杀掉，所以调大），最多 1024 个进程。这个分组的名字不带短横线，因为 systemd 把名字里的短横线当成上下级（`gh-runners.slice` 实际挂在 `gh.slice` 下面），而预留内存要每一级上级都设了才生效。两个分组合计 20 GB，留出的约 2 GB 让 ssh 在 runner 用满自己的内存时仍能登录。
- 每个任务开始前检查 runner 目录所在磁盘（就是根盘）的可用空间，低于 16 GiB（几个检查任务可能同时占盘，汇总任务占得很少）或读不出数字时都拒绝这个任务；任务结束后删除它的检出和 `_work/_temp`；每小时的定时清理删除三天前的 `_work` 残留和 14 天前的 runner 诊断日志，哪个 runner 有任务在跑就跳过它，查不出有没有任务时也跳过并以退出码 1 结束；共享目录里超过 6 小时没变的运行目录（汇总作业被取消或 runner 崩溃时留下的）不论有没有任务都删掉。

[↑ 返回阅读导航](#contents)

<a id="authoritative-sources"></a>

## Authoritative Sources

- 决定和理由：[SOURCE: docs/adr/0176-ci-on-ovh-vps.md]、[SOURCE: docs/adr/0168-longer-ci-job-limits-on-hermes.md]、[SOURCE: docs/adr/0169-pause-runners-by-removing-the-label.md]、[SOURCE: docs/adr/0172-resume-runners-labels-first.md]
- 用户命名空间限制和 bwrap 的 AppArmor 配置：[安装与启停 Runbook](install-start-stop-runbook.md)
- 测试主机的硬边界：[测试主机与生产主机](../../.agents/instructions/test-and-production-hosts.md)
- 准备机器、安装、注册、卸载、暂停和恢复的脚本，以及服务和钩子的原文：[scripts/operations/ci-runner/](../../scripts/operations/ci-runner/)
- 哪些任务跑在 runner 上：`ci/policy.json`、`.github/workflows/ci.yml`、`.github/workflows/main.yml`
- GitHub 官方文档：[About self-hosted runners](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/about-self-hosted-runners)
- runner 自带的服务模板 `/srv/gh-runner/runner/bin/actions.runner.service.template`：启动命令用 `runsvc.sh`、停止信号用 `SIGTERM`，本手册的服务与它一致

[↑ 返回阅读导航](#contents)

<a id="safety-and-preconditions"></a>

## Safety and Preconditions

- **sudo**：准备机器、安装、注册、卸载和修改服务都要 root。VPS 的 `ubuntu` 账号有免密 sudo，Andy 2026-11-06 选“按推荐做”时授权了加固 VPS、在上面装 runner；这之外的系统改动（例如开新端口、装别的服务）先问 Andy。
- **连接**：在 Mac 上直接 `ssh -o BatchMode=yes ubuntu@158.69.191.249`，每次先核对 `hostname` 是 `ci-vps`。这台机器不经 Hermes 的包装脚本。
- **注册令牌**：注册令牌（GitHub 发的一次性注册密码，一小时内有效）每个 runner 单独生成一个，只能通过标准输入交给 `register-runner.sh`，脚本把它放进环境变量 `ACTIONS_RUNNER_INPUT_TOKEN` 交给 runner 的配置程序。令牌不得出现在命令行参数、文件、日志或提交里；注册完检查日志里没有令牌样的字符串后删除日志。
- **Docker**：runner 用户不得加入 docker 组（ADR 0176 决定第 8 条）。哪个 workflow 真要 Docker，先向 Andy 说明风险和替代方案，由 Andy 决定。
- **改动目标的动作**：准备机器和安装时改系统配置、创建 runner 用户。它们和本手册所有写入 root 目录的步骤一样，属于 `critical`（合并闸门所在的机器、安全边界）：超出 Andy 已授权范围的，动手前要向 Andy 说明具体对象、动作和影响，并取得授权。

[↑ 返回阅读导航](#contents)

<a id="live-state-preflight"></a>

## Live-State Preflight

下面全是只读命令，在 Mac 上用 `ssh -o BatchMode=yes ubuntu@158.69.191.249 '<命令>'` 执行，有一项对不上就停下：

1. 主机名是 `ci-vps`：`hostname`。
2. 用户命名空间限制开着、bwrap 能用：`sysctl -n kernel.apparmor_restrict_unprivileged_userns` 是 `1`；`bwrap --unshare-all --ro-bind /usr /usr --symlink usr/lib64 /lib64 --symlink usr/lib /lib --symlink usr/bin /bin /usr/bin/true` 退出码是 0。
3. 根盘可用空间：`df -B1 --output=avail /`。低于 16 GiB 时 runner 会拒绝任务，先报告。
4. 服务状态：`systemctl is-active gh-runner.service gh-runner-2.service gh-runner-3.service gh-runner-gate.service gh-runner-nft.service gh-runner-clean.timer`，六个都应是 `active`（第 3 个检查 runner 还没装时没有 `gh-runner-3.service`，汇总 runner 还没装时没有 `gh-runner-gate.service`，其余应是 `active`）。
5. 用户没有多余的组：`id gh-runner`、`id gh-runner-2`、`id gh-runner-3`、`id gh-runner-gate` 各自只列出自己的一个组。共享目录在：`stat -c '%a %U %G' /srv/gh-runner-share` 是 `2770 root gh-ci-share`。
6. 防火墙表在：`sudo -n nft list table inet gh_runner` 里有 `fib daddr type local`。
7. 限额生效：`systemctl show gh-runner.service gh-runner-2.service gh-runner-3.service -p Slice -p MemoryHigh -p MemoryMax -p MemorySwapMax -p TasksMax -p CPUQuotaPerSecUSec -p CPUWeight -p IOWeight -p Nice -p ExecStart`，三个都应为 `Slice=gh-runners.slice`、`MemoryHigh=15032385536`、`MemoryMax=16106127360`、`MemorySwapMax=0`、`TasksMax=2048`、`CPUQuotaPerSecUSec=infinity`、`CPUWeight=[not set]`、`IOWeight=[not set]`、`Nice=0`，启动命令分别是 `/srv/gh-runner/runner/bin/runsvc.sh`、`/srv/gh-runner-2/runner/bin/runsvc.sh` 和 `/srv/gh-runner-3/runner/bin/runsvc.sh`；`systemctl show gh-runners.slice -p MemoryHigh -p MemoryMax -p MemorySwapMax -p TasksMax -p CPUQuotaPerSecUSec -p CPUWeight -p IOWeight` 应为 `MemoryHigh=16106127360`、`MemoryMax=17179869184`、`MemorySwapMax=0`、`TasksMax=6144`、`CPUQuotaPerSecUSec=infinity`、`CPUWeight=[not set]`、`IOWeight=[not set]`。汇总 runner：`systemctl show gh-runner-gate.service -p Slice -p MemoryMin -p MemoryHigh -p MemoryMax -p MemorySwapMax -p TasksMax -p ExecStart` 应为 `Slice=ghgate.slice`、`MemoryMin=2147483648`、`MemoryHigh=3221225472`、`MemoryMax=4294967296`、`MemorySwapMax=0`、`TasksMax=1024`，启动命令是 `/srv/gh-runner-gate/runner/bin/runsvc.sh`；`systemctl show ghgate.slice -p MemoryMin -p MemoryMax` 应为 `MemoryMin=2147483648`、`MemoryMax=4294967296`；`cat /sys/fs/cgroup/ghgate.slice/memory.min` 应为 `2147483648`（确认预留真的写进了内核）。
8. GitHub 上的状态（在 Mac 上运行）：`gh api repos/sixianli/himawari-agent/actions/runners --jq '.runners[]|{id,name,status,busy,labels:[.labels[].name]}'`，应看到 `ci-vps-1`、`ci-vps-2`、`ci-vps-3`、`ci-vps-gate` 都为 `online`；`ci-vps-1`、`ci-vps-2`、`ci-vps-3` 的标签里有 `ci-vps`、没有 `ci-vps-gate`（应急期间 `ci-vps-1` 会多带一个，见[应急](#gate-fallback)），`ci-vps-gate` 的标签里有 `ci-vps-gate`、没有 `ci-vps`。
9. 有没有任务在跑：`pgrep -u gh-runner -x Runner.Worker; pgrep -u gh-runner-2 -x Runner.Worker; pgrep -u gh-runner-3 -x Runner.Worker; pgrep -u gh-runner-gate -x Runner.Worker`，有输出就是有任务。

[↑ 返回阅读导航](#contents)

<a id="procedure"></a>

## Procedure

<a id="install"></a>

### 准备机器

只在新机器上做一次，之后可以重复运行：

1. 把 `scripts/operations/ci-runner/prepare-vps.sh` 用 `scp` 传到 VPS 的 `/home/ubuntu/`。
2. `sudo bash /home/ubuntu/prepare-vps.sh > /home/ubuntu/prepare-vps.log 2>&1`（要几分钟，放后台）。脚本确认以 root 运行（否则退出码 64）、主机名是 `ci-vps` 或 OVH 给的原名 `vps-482b8c36`（否则 68）、系统是 Ubuntu 24.04（否则 69）；装编译工具、`unzip`、`xz-utils`、`bubblewrap`、`socat`、`ripgrep`、`apparmor-utils`；写 cloud-init 配置并把主机名改成 `ci-vps`；关掉安全更新后的自动重启；写入 `/etc/needrestart/conf.d/50ci-vps-gh-runner.conf`，让自动安全更新之后不自动重启 `gh-runner` 开头的服务，并当场按 needrestart 的规则核对四个 runner 服务都不会被重启（否则 73）；写入并加载 `/etc/apparmor.d/bwrap`（已有内容不同的同名文件时以退出码 70 拒绝，不覆盖），确认全局开关仍是 1（否则 71）；下载 Node 22.22.3 并核对 SHA-256（不对时 72），用它装 Playwright 1.62.1 需要的 chromium、firefox、webkit 系统库。成功时最后一行是 `CI_VPS_PREPARED hostname=ci-vps bwrap=<版本> userns_restrict=1 gcc=<版本> playwright_deps=1.62.1`。
3. `sudo systemctl reboot`，重新连上后按 [Live-State Preflight](#live-state-preflight) 第 1、2 项核对主机名和 bwrap。

### 安装

1. 把 `scripts/operations/ci-runner/` 下的全部文件（包括 `runners.sh` 和 `gh-runner.service.in`）用 `scp` 传到 VPS 的 `/home/ubuntu/ci-runner/`。
2. 有 runner 服务在运行时安装脚本以退出码 70 拒绝，所以重装前先按[暂停和恢复](#pause-and-resume)在 Mac 上运行 `pause-runners.sh`。
3. `sudo bash /home/ubuntu/ci-runner/install-runner.sh`。脚本会：确认主机名是 `ci-vps`（否则以退出码 68 拒绝）；把要改动的服务文件、slice、`/etc/gh-runner/`、窄 sudo 规则和各个 runner 的 `hooks/` 目录复制到 `/var/backups/gh-runner/<时间>/`，并记下哪些原来不存在；之后任何一步失败或脚本被中断（`Ctrl-C`、`TERM`、`HUP`），都会把原有的放回、把这次新建的文件、用户、组和目录删掉，撤销这次新启用的开机启动，重新加载防火墙规则，并打印 `INSTALL_FAILED`；某一步出错时，先打印一行 `INSTALL_STEP_FAILED line <行号> exit <退出码>: <出错的命令>`，指出是哪一步；回滚期间忽略 `PIPE` 信号（读输出的一方已退出时系统发出的信号），所以标准错误被关掉、或接收输出的程序已经退出时，回滚也会放回全部文件，不会中途停下；有放不回去的会打印 `RESTORE_INCOMPLETE`，列出是哪几项和备份目录；建 `gh-runner`、`gh-runner-2`、`gh-runner-3`、`gh-runner-gate` 四个用户（已有额外组时以退出码 67 拒绝；已有这个用户但没有它的 `runner` 目录时以退出码 69 拒绝），建系统组 `gh-ci-share` 和共享目录 `/srv/gh-runner-share`（`2770`，属主 root；组不存在而目录已存在时以退出码 71 拒绝，不接管别人建的目录），建四个 runner 的目录，没装过 runner 的下载 2.338.2 并核对 SHA-256，装钩子、两个 slice 和服务（服务文件每次都全部重新生成，所以给已有的机器加 runner 时，原有 runner 的服务文件也会换成新的），按端口名单和现存的 runner 账号生成防火墙规则并先用 `nft -c` 检查，生成窄 sudo 规则，加载防火墙规则，启用防火墙服务和每小时清理定时器。成功时打印 `INSTALL_OK`，同时打印共享目录、 runner 账号的 uid、拦住的本机端口和备份目录。
4. 重装时最后在 Mac 上运行 `resume-runners.sh`；第一次安装要先按[注册](#register)注册。
5. 在已经有两个检查 runner 的机器上加汇总 runner：第 2 步暂停，第 1 步上传，第 3 步安装（看到 `INSTALL_OK`，`runner_uids` 里有四个 uid：安装脚本按 `runners.sh` 的名单一起建好第 3 个检查 runner 的账号和服务，只是不注册），按[注册](#register)注册汇总 runner（`register-runner.sh 3`），再运行 `resume-runners.sh`，最后按 [Live-State Preflight](#live-state-preflight) 第 4、5、7、8 项核对。恢复脚本只给已注册的 runner 加标签，所以要先注册再恢复。
6. 加第 3 个检查 runner `ci-vps-3`（编号 6，账号 `gh-runner-3`，目录 `/srv/gh-runner-3/`，服务 `gh-runner-3.service`，标签 `ci-vps`，和前两个检查 runner 共用 `gh-runners.slice` 的 16 GB 内存池（2026-11-14 前是 18 GB））：做法同第 5 条，注册时用 `register-runner.sh 6`。2026-11-13 量过：两个检查 runner 都在跑作业时，CPU 平均空着 37%，内存实际只用了 4 GB（其余是可回收的文件缓存），所以加第 3 个。三个检查作业同时吃满内存时，内存池上限会让其中一个作业被系统杀掉、作业失败，这时按 [Rollback](#rollback) 里“只卸第 3 个检查 runner”卸掉它。

<a id="register"></a>

### 注册

1. 在 Mac 上用 `gh api -X POST repos/sixianli/himawari-agent/actions/runners/registration-token --jq .token` 取令牌，通过管道直接交给 VPS 上的 `sudo bash /home/ubuntu/ci-runner/register-runner.sh <1|2|3|6>` 的标准输入（1、2、6 是三个检查 runner，3 是汇总 runner），例如 `gh api ... --jq .token | ssh -o BatchMode=yes ubuntu@158.69.191.249 'sudo bash /home/ubuntu/ci-runner/register-runner.sh 1'`；令牌不落盘、不进参数。注册几个 runner 就取几次令牌，每次单独取。
2. 脚本先确认主机名是 `ci-vps`、装了 `python3`、以 root 运行；没写注册第几个 runner 时以退出码 64 拒绝（免得 `--replace` 把现有的 `ci-vps-1` 换掉），标准输入里没有令牌时也以退出码 64 拒绝。再确认这个 runner 版本会读 `ACTIONS_RUNNER_INPUT_TOKEN`（否则拒绝，以免令牌只能放进命令行），然后以对应账号注册：第 1 个名字是 `ci-vps-1`，第 2 个是 `ci-vps-2`，标签都是 `ci-vps`；第 3 个名字和标签都是 `ci-vps-gate`（标签由 `runners.sh` 的 `runner_select` 按编号给出）。最后启用并启动对应的服务。成功时打印 `REGISTER_OK`。

<a id="pause-and-resume"></a>

### 暂停和恢复

VPS 上没有受保护测试，平时不用暂停；重装或维护 runner 时才用，这台机器上的所有 runner 一起暂停、一起恢复。两个入口都在 Andy 的 Mac 上、从仓库根目录运行，用 Andy 已登录的 `gh` 改 runner 标签，用 `ssh` 和 `scp`（选项 `BatchMode=yes`、`ConnectTimeout=20`、`ServerAliveInterval=15`）操作 VPS，地址默认 `ubuntu@158.69.191.249`，可用环境变量 `CI_VPS_SSH` 改；每条远程命令先核对主机名是 `ci-vps`，不是就以退出码 68 结束。VPS 上不放任何 GitHub 凭证。两个入口共用一把锁（`.ci-output/ci-runner-pause.lock` 目录），同时只能跑一个，否则以退出码 75 打印 `RUNNER_LOCKED`；进程被强杀留下的锁目录要手动删掉。做法和理由见 [ADR 0169](../adr/0169-pause-runners-by-removing-the-label.md)。

- 暂停：`scripts/operations/ci-runner/pause-runners.sh`。暂停可能要等到最长任务的时限（`ci/policy.json` 里最大的 `timeoutMinutes`）加 5 分钟，代理要在后台运行它。
  1. 把三个脚本传到 VPS，读 VPS 上注册过（服务已启用）的 runner，和 GitHub 上的 runner 对账（只建了账号、还没注册的 runner 不算）：VPS 上的每个 runner 在 GitHub 上必须恰好有一个同名的，GitHub 上带 `ci-vps` 或 `ci-vps-gate` 标签的 runner 也必须都装在 VPS 上。对不上就打印 `RUNNER_PAUSE_FAILED` 和原因，不改标签、不停服务（VPS 上的三个脚本已经更新为仓库里的版本）。
  2. 去掉这些 runner 身上的 `ci-vps` 和 `ci-vps-gate` 标签（带哪个去哪个，包括应急时加在 `ci-vps-1` 上的 `ci-vps-gate`），再读一遍确认真的去掉了。有一个没去掉，就把已经去掉的加回去，打印 `RUNNER_PAUSE_FAILED`，不碰 VPS。回读时读不全 GitHub 的列表，也按“没去掉”处理。这一步被 Ctrl-C、`TERM` 或 `HUP` 打断时，同样把已经发出删除请求的标签都加回去，打印 `RUNNER_PAUSE_FAILED interrupted`，以退出码 130 结束。都去掉后打印 `RUNNER_LABELS_REMOVED`：从这时起 GitHub 不再给它们派新任务，新任务在 GitHub 上排队。
  3. 每 30 秒查一次 GitHub：这些 runner 都显示 `busy=false` 时，在 VPS 上运行 `runner-pause.sh --labels-removed 90`。它连续观察 90 秒，期间每 10 秒查一次本机有没有 `Runner.Worker`，一直没有才停全部服务，打印 `RUNNER_PAUSED`；中途看到任务就打印 `RUNNER_STILL_BUSY`，以退出码 2 结束、不停服务，Mac 侧接着等。还在等的时候，Mac 侧打印一行 `RUNNER_PAUSE_WAITING for: <还在忙的 runner>`，写明最多还要等几分钟；等的对象变了才再打印一行。GitHub 的接口有时查不到正在跑的任务属于哪次运行，要立刻停时在 VPS 上 `sudo -n /usr/bin/systemctl stop <服务>`，那个任务会失败，恢复后重跑它。
  4. 成功时打印 `RUNNER_PAUSED labels=removed services=stopped`。
  5. 到了等待上限还有任务，打印 `RUNNER_PAUSE_INCOMPLETE labels=removed services=<每个服务当时的状态>` 和还在忙的 runner（一直读不到 GitHub 时写 `(could not read GitHub)`），以退出码 2 结束。服务状态读不到时写 `services=unknown`。VPS 那一步出错（例如只停掉了一个服务）时，打印 `RUNNER_PAUSE_INCOMPLETE labels=removed services=<每个服务当时的状态>`，以退出码 1 结束；等待期间被 Ctrl-C、`TERM` 或 `HUP` 打断时，打印同样一行并加上 `interrupted`，以退出码 130 结束。这几种情况下标签都保持去掉，还在跑的服务跑完手上的任务，不会再接新任务；重新运行 `pause-runners.sh` 即可，或运行 `resume-runners.sh` 撤销。
- 恢复：`scripts/operations/ci-runner/resume-runners.sh`。它先像暂停一样对账，对不上就打印 `RUNNER_RESUME_FAILED` 和原因，不加标签、不启动服务；再给每个 runner 加回它自己的标签（检查 runner 加 `ci-vps`，汇总 runner 加 `ci-vps-gate`，不会给汇总 runner 加 `ci-vps`；应急标签不会自动加回）并读一遍确认，有没加上、读不到、或者某个 runner 只带着别人的标签（状态 `foreign`）的就打印 `RUNNER_RESUME_INCOMPLETE labels: <每个 runner 的标签状态>; services not started`，不启动服务；某个 runner 除了自己的标签还带着别人的标签（状态 `mixed`，例如汇总 runner 带着 `ci-vps`，或 `ci-vps-2` 带着 `ci-vps-gate`）时同样不启动服务，要先在 GitHub 上去掉那个多出来的标签再重新运行，唯一允许的是 `ci-vps-1` 带着应急用的 `ci-vps-gate`（状态 `extra`）；然后在 VPS 上运行 `runner-resume.sh`，只启动已注册（服务已启用）的 runner；最后等 GitHub 显示它们 `online`（最多 5 分钟），打印 `RUNNER_RESUMED labels=restored`。先加标签再启动，是因为后加的标签不会让排队的任务派下来，原因和证据见 [ADR 0172](../adr/0172-resume-runners-labels-first.md)；runner 没启动时是 `offline`，不会接任务，所以标签先加回去没有影响。服务没起来时打印 `RUNNER_RESUME_FAILED services=<每个服务当时的状态> labels=restored`；5 分钟内没上线打印 `RUNNER_RESUME_INCOMPLETE services=<各服务状态> labels=restored` 和没上线的 runner（一直读不到 GitHub 时写 `(could not read GitHub)`）；对账之后任何时候被 Ctrl-C、`TERM` 或 `HUP` 打断，打印 `RUNNER_RESUME_INCOMPLETE interrupted`、各服务状态和每个 runner 的标签状态（`on` 只带自己的标签、`extra` 另外还带着应急标签、`mixed` 另外还带着不该有的别人的标签、`off`、`foreign`、`unread`），以退出码 130 结束。这几种情况下排队的任务都继续排队，不会失败，处理后重新运行即可。如果恢复后 runner 在线、带着标签，排队的任务仍然超过 10 分钟不派，重启其中一个 runner 服务（`sudo -n systemctl restart gh-runner.service`），并把这次现象记进 ADR 0172 的后果。
- 暂停期间新的 CI 任务在 GitHub 上排队；**排队超过 24 小时的任务会被 GitHub 判为失败**，所以暂停不要超过一天。GitHub 大约 1 分钟后才把停掉的 runner 显示为 `offline`。
- 暂停期间 VPS 重启：服务会自己起来。按 runner 源码（[`ConfigurationManager.cs`](https://github.com/actions/runner/blob/main/src/Runner.Listener/Configuration/ConfigurationManager.cs)），标签只在配置（`config.sh`）时发给 GitHub，所以重启后标签应该还是去掉的、不会接任务；但启动会话的代码没有核对，也没实测过，重启后先用 `gh api` 看一眼标签。之后照常运行 `resume-runners.sh`。不要在暂停期间重新注册 runner（`config.sh --replace` 会重置标签）。
- `runner-pause.sh` 不带 `--labels-removed` 时以退出码 64 拒绝：直接在 VPS 上停服务会让 GitHub 在停之前的空档里派来的任务被取消。
- GitHub 文档写明，它不能保证常驻 runner 停机时绝对不被派任务（[Self-hosted runners reference](https://docs.github.com/en/actions/reference/runners/self-hosted-runners)）。去掉标签再观察 90 秒，把这个空档压到很小，但不是零。

<a id="gate-fallback"></a>

### 汇总 runner 坏了时的应急

汇总作业改成只在 `ci-vps-gate` 上跑之后，汇总 runner 停了，所有 PR 的 `ci/required` 都会一直排队（不会被当成通过）。修好之前，在 Mac 上从仓库根目录运行：

- `scripts/operations/ci-runner/gate-fallback.sh on`：把 `ci-vps-gate` 标签加到 `ci-vps-1` 上，汇总作业改由第 1 个检查 runner 接，不用改代码。成功时打印 `GATE_FALLBACK_ON ci-vps-1`。`ci-vps-1` 不带 `ci-vps` 标签（runner 处于暂停）时拒绝，先运行 `resume-runners.sh`；`ci-vps-1` 在 GitHub 上不是 `online` 时也拒绝（它自己也接不了任务），打印以 `GATE_FALLBACK_FAILED ci-vps-1 is offline` 开头的一行，标签不动。加上标签时如果 `ci-vps-gate` 在 GitHub 上还是 `online`，脚本多打印一行 `note:`，提醒两个 runner 都会接汇总作业。
- `scripts/operations/ci-runner/gate-fallback.sh off`：汇总 runner 修好并在线之后运行，去掉这个标签，打印 `GATE_FALLBACK_OFF ci-vps-1`。
- 这个脚本只改 GitHub 上的标签，不连 VPS，和暂停、恢复共用同一把锁。读不到 GitHub、标签没加上或没去掉时打印 `GATE_FALLBACK_FAILED` 和原因，以退出码 1 结束。
- 应急期间运行过 `pause-runners.sh` 的话，应急标签会被一起去掉；`resume-runners.sh` 之后如果汇总 runner 还没修好，再运行一次 `gate-fallback.sh on`。
- 应急期间汇总作业和检查作业又在同一个队里，排队会回到加汇总 runner 之前的样子，所以只是临时办法。

<a id="arm-site"></a>

### Oracle 的 ARM 机器上的两个 runner

第二处 runner 装在 Andy 的 Oracle 东京 ARM 机器上（Ubuntu 24.04，处理器是 64 位 ARM，系统里显示为 `aarch64`；4 核 24 GB，公网地址 `138.2.31.252`，这台机器同时是测试机）。那里有两个 runner：`ci-arm-1` 和 `ci-arm-2`，标签都是 `ci-arm`，合计最多用 18 GB 内存。脚本和 CI VPS 用同一套，靠环境变量 `RUNNER_SITE=arm` 区分；不写这个变量时，所有脚本管的都是 CI VPS。必过的 `ci.yml` 里 policy、static、security 三项检查写 `runs-on: ci-arm`，由这两个 runner 接（[ADR 0266](../adr/0266-ci-policy-static-security-run-on-the-oracle-arm-machine.md)）；build、browser、coverage 和汇总作业仍在 CI 服务器上。三项检查在 ARM 上把报告写进那台机器自己的共享目录，汇总作业用下面“报告怎样回到汇总作业”一节的办法取回。用 `arm-fallback.sh on` 应急期间，这三项检查改由 CI VPS 的检查 runner 接，汇总照样认可 x64 的报告。

**安装（Andy 在 Mac 上，仓库根目录，一条命令）**：`scripts/operations/ci-runner/install-arm-runners.sh`。它依次做 8 步，每步打印一行 `ARM_INSTALL_STEP n/8`，全部成功时打印 `ARM_INSTALL_OK`：

1. 确认两台机器都连得上、`sudo` 不要密码。
2. 把脚本传到两台机器的 `/home/ubuntu/ci-runner/`。
3. 在 ARM 机器上运行 `prepare-arm.sh`：打印机器的实际情况（主机名、系统版本、内存、磁盘、`/home` 下各目录的权限、`/srv` 和 `/opt` 下的目录、在监听的端口，每行以 `CI_ARM_PROBE` 开头），不是 Ubuntu 24.04 的 aarch64、根分区剩余不到 40 GiB、内存不到 20 GB，或 `/home` 下有目录对所有账号可读时拒绝（`CI_ARM_PREPARE_FAILED` 加原因）；然后装 `nftables`、编译工具和 runner 需要的系统库，再用固定版本的 Node 和 Playwright 装 Chromium 需要的系统库（static 检查里的布局检查要用 Chromium，少了这些库会在“安装布局检查用的 Chromium”一步报缺库）。脚本可以重复运行，不动正在运行的 runner；机器已经装好 runner、只缺这些库时，单独重跑它即可。
4. 在 CI VPS 上运行 `install-gate-remote.sh key`：生成汇总 runner 取报告用的钥匙（已有就沿用），放在 `/etc/gh-runner/remote-share/`，只有 root 和汇总 runner 的账号读得到，检查 runner 读不到。
5. 在 ARM 机器上运行 `install-runner.sh`：建两个 runner 账号、systemd 服务、防火墙规则和内存分组，另建一个只用来交报告的账号 `gh-ci-send`。这个账号的 `authorized_keys` 只放第 4 步的公钥，并写明只接受来自 CI VPS 地址的连接、只能执行 `/usr/local/lib/gh-runner/send-reports` 这一个脚本。失败时把改过的东西放回去。已经有 runner 服务在跑时跳过这一步。
6. 把 ARM 机器的主机密钥和地址交给 CI VPS（`install-gate-remote.sh trust`），再用 `install-gate-remote.sh check` 以汇总 runner 的身份取一份不存在的报告，对方回答“没有这份报告”才算通（`GATE_REMOTE_OK`）。
7. 向 GitHub 要注册令牌，经 ssh 的标准输入交给 ARM 机器上的 `register-runner.sh 4` 和 `5`；令牌不出现在任何命令行里。已经注册并在跑的 runner 跳过。
8. 等 GitHub 显示两个 runner 都在线并带 `ci-arm` 标签，最多等 3 分钟。

任何一步失败都打印 `ARM_INSTALL_FAILED step=<第几步>` 和原因，以退出码 1 结束；修好原因后重新运行同一条命令，做完的步骤可以安全地重复。两台机器的地址可以用 `CI_VPS_SSH`、`CI_ARM_SSH` 换掉，`CI_VPS_SSH` 必须以 CI VPS 的 IPv4 地址结尾。

**报告怎样回到汇总作业**：ARM 上的检查会把报告写在那台机器自己的 `/srv/gh-runner-share/<运行号>-<重试号>/`。汇总作业在 CI VPS 上发现本机共享目录里没有某份报告、而命令行的 `--remote-jobs` 名单里有这个作业时，用上面那把钥匙连 ARM 机器，请求名只能是“运行号-重试号/报告名”，对方把那个目录里的普通文件打成一段 JSON 交回来（符号链接、硬链接、超过 500 个文件、单个文件超过 16 MiB、合计超过 64 MiB 都拒绝）。取回的内容写进本机共享目录后照旧按摘要核对；连不上、超时（总时限 2 分钟）、主机密钥不对、内容对不上，都记成缺这份报告，汇总判失败。ARM 机器上不放任何能连别处的钥匙。

**暂停和恢复**：在 Mac 上运行 `RUNNER_SITE=arm scripts/operations/ci-runner/pause-runners.sh` 和 `RUNNER_SITE=arm scripts/operations/ci-runner/resume-runners.sh`，行为和上面[暂停和恢复](#pause-and-resume)一节相同，只是对象换成 ARM 机器上的两个 runner 和 `ci-arm` 标签。两处各有各的锁，暂停一处不影响另一处。

**ARM 机器不在时的应急**：`ci-arm` 的任务会一直排队，不会被当成通过。在 Mac 上运行 `scripts/operations/ci-runner/arm-fallback.sh on`，先从 CI VPS 读出装了哪些 runner，把 `ci-arm` 标签加到已装的检查 runner（`ci-vps-1`、`ci-vps-2`、`ci-vps-3`；还没装的跳过，并打印 `not installed on ci-vps, left out:`）上，这些任务改由 CI VPS 接（`ARM_FALLBACK_ON`）；ARM 机器恢复后运行 `arm-fallback.sh off`（`ARM_FALLBACK_OFF`）。连不上 CI VPS、一个检查 runner 都没装、已装的 runner 在 GitHub 上找不到或重名、它们不带 `ci-vps` 标签（暂停中）或都不在线时拒绝，标签不动。`on` 时如果有没装的检查 runner 还带着 `ci-arm`（以前的应急没关就卸掉了），不论还装着几个，都先拒绝并提示运行 `off`。`off` 会去掉所有检查 runner 身上的 `ci-arm`，包括已经卸掉、但 GitHub 上还留着的；一个检查 runner 都没装时 `off` 也照样清理。应急开着的时候，两处的 `pause-runners.sh` 都会拒绝运行并提示先 `arm-fallback.sh off`：否则 GitHub 会继续把 `ci-arm` 的任务派给正要停的 runner。

**卸载**：在 ARM 机器上 `sudo RUNNER_SITE=arm bash /home/ubuntu/ci-runner/uninstall-runner.sh all`（先在 Mac 上暂停），它删掉两个 runner、交报告的账号和脚本、防火墙规则和共享目录；`5` 只删第 2 个。CI VPS 上取报告的钥匙用 `sudo bash /home/ubuntu/ci-runner/install-gate-remote.sh remove` 删。GitHub 上的 runner 记录照[全部卸载](#rollback)一节的做法另删。

<a id="routine-maintenance"></a>

### 日常维护

- **磁盘**：看每个 runner 各自的 `logs/disk.log`，每个任务记一行开始时的可用空间，一行结束时 `_work` 的大小和可用空间。
- **runner 升级**：runner 会自己升级到 GitHub 要求的版本（它的目录归各自的 runner 账号所有，所以能写）。要换安装脚本里固定的版本时，改 `install-runner.sh` 里的 `VERSION`，并改 `runners.sh` 里 x64 和 arm64 两处的 `RUNNER_PACKAGE_SHA256`（两个架构的安装包各一个校验值），SHA-256 从 GitHub 的发布页核对。
- **本机新增了服务**：防火墙只挡端口名单里的端口。之后新开的本机服务端口不在名单里，要刷新规则：先按[暂停和恢复](#pause-and-resume)在 Mac 上运行 `pause-runners.sh`（有 runner 服务在运行时安装脚本以退出码 70 拒绝），再重新运行 `install-runner.sh`（脚本可重复运行，不会重新下载或重建用户，最后会重新加载防火墙规则），最后运行 `resume-runners.sh`。
- **防火墙表被清掉**：如果有人重启了系统的 `nftables` 服务，而 `/etc/nftables.conf` 里有 `flush ruleset`，表 `inet gh_runner` 会被一并清掉。用 `sudo systemctl restart gh-runner-nft.service gh-runner.service gh-runner-2.service gh-runner-3.service gh-runner-gate.service` 恢复。
- **系统更新**：自动安全更新开着，但不自动重启。要重启时先暂停 runner，重启后按 [Live-State Preflight](#live-state-preflight) 核对，再恢复。
- **重启服务**：`sudo -n /usr/bin/systemctl restart gh-runner.service`（第 2 个检查 runner 是 `gh-runner-2.service`，第 3 个检查 runner 是 `gh-runner-3.service`，汇总 runner 是 `gh-runner-gate.service`）。runner 会先向 GitHub 注销会话再退出，几秒后重新在线。

<a id="retire-hermes-runners"></a>

### 注销 Hermes 上的旧 runner（一次性）

ADR 0176 决定第 10 条：不留作备用。原定 VPS 上完整跑通一次 CI 之后做；Andy 2026-11-07 要求提前做，当天三步都已完成（第 3 步由 Andy 运行，输出 `UNINSTALL_OK`；随后核对 Hermes 上 `gh-runner`、`gh-runner-2` 两个账号都已不存在，GitHub 上只剩 `ci-vps-1`、`ci-vps-2`）。要在改名的 PR 合并之前做，用 `main` 上还在的旧脚本（`scripts/operations/hermes-runner/`）；合并之后只能从历史里取，例如 `git show 058293d1:scripts/operations/hermes-runner/uninstall-runner.sh`。

1. 在 Mac 上从 `main` 的检出运行 `scripts/operations/hermes-runner/pause-runners.sh`，看到 `RUNNER_PAUSED labels=removed services=stopped`。
2. 从 GitHub 删除 `hermes-home` 和 `hermes-home-2`：`gh api repos/sixianli/himawari-agent/actions/runners --jq '.runners[]|{id,name}'` 查编号，再 `gh api -X DELETE repos/sixianli/himawari-agent/actions/runners/<编号>`。
3. Andy 的账号在 Hermes 上没有 root，所以请 Andy 在 Hermes 上运行 `sudo bash /home/andy/himawari-tests/hermes-runner/uninstall-runner.sh all`（脚本先用 `hermes-upload.sh` 传上去），看到 `UNINSTALL_OK`。
4. 验证：GitHub 的 runner 列表里只剩 `ci-vps-1`、`ci-vps-2`；Hermes 上 `id gh-runner`、`id gh-runner-2` 都报用户不存在。

[↑ 返回阅读导航](#contents)

<a id="verification"></a>

## Verification

- GitHub 接口显示 `ci-vps-1`、`ci-vps-2`、`ci-vps-3` 和 `ci-vps-gate` 都为 `online`，空闲时 `busy` 为 `false`；三个检查 runner 的标签有 `self-hosted`、`Linux`、`X64`、`ci-vps`，`ci-vps-gate` 的标签有 `self-hosted`、`Linux`、`X64`、`ci-vps-gate`，没有 `ci-vps`。
- `journalctl -u gh-runner.service`、`journalctl -u gh-runner-2.service`、`journalctl -u gh-runner-3.service` 和 `journalctl -u gh-runner-gate.service` 最近都出现 `Listening for Jobs`，之后没有 `Conflict`。
- 分别以 `gh-runner`、`gh-runner-2`、`gh-runner-3` 和 `gh-runner-gate` 身份读 `/home/ubuntu/.ssh`、其他 runner 的目录都被拒绝；连本机公网地址和 `127.0.0.1` 的 22 端口、`169.254.169.254` 都被拒绝；访问 `https://api.github.com` 正常；在 runner 账号下用 bwrap 建立隔离环境成功。
- 以 `gh-runner` 身份运行一次 `packages/runtime-sandbox/scripts/check-srt-boundary.mjs`（它不在 `npm run check` 里），记录 bwrap 版本、AppArmor 开关和结果。
- PR 的检查作业在检查 runner 上运行并通过，任务日志开头的 `Runner name` 是 `ci-vps-1`、`ci-vps-2` 或 `ci-vps-3`；汇总作业切到 `ci-vps-gate` 之后，`ci/required` 的 `Runner name` 是 `ci-vps-gate`（应急期间是 `ci-vps-1`）；它的“从 CI 服务器收齐”步骤打印 `CI_SHARE_COLLECT 8`，结束后 `/srv/gh-runner-share/` 下没有这一轮的目录；GitHub 上这一轮只留 `gate-` 和失败时的 `diagnostic-` 产物，没有 `report-`。

[↑ 返回阅读导航](#contents)

<a id="evidence"></a>

## Evidence

- 证据放在 VPS 的 `/home/ubuntu/ci-runner-evidence/<运行编号>/`，每次操作一个新编号，编号用 JST 时间，例如 `20261107-0130`。
- 记录：预检输出、执行的命令和退出码、验证结果、是否回退、结论。
- 不记录注册令牌或任何密钥；日志里出现令牌样的字符串时，先删掉那份日志再继续。

[↑ 返回阅读导航](#contents)

<a id="rollback"></a>

## Rollback

触发条件：Andy 决定不再用这台机器，几个检查 runner 同时跑时内存不够（见 [Troubleshooting](#troubleshooting) 里“合计 16 GB 不够用”那一行），或者决定不再用专门的汇总 runner。

**只卸第 2 个 runner**：

1. 先在 Mac 上运行 `pause-runners.sh`，再在 VPS 上运行 `sudo bash /home/ubuntu/ci-runner/uninstall-runner.sh 2`。它停掉并删除 `gh-runner-2.service`、结束 `gh-runner-2` 的进程、删除 `/srv/gh-runner-2/`、删除 `gh-runner-2` 用户和组，再按仍装着的 runner 重新生成防火墙规则和窄 sudo 规则（端口名单沿用上一份规则里的端口，再加上当时在监听的）。其他 runner 的服务、目录、账号不动。全部删干净才打印 `UNINSTALL_OK`；还有残留时打印 `UNINSTALL_INCOMPLETE` 和残留清单，并以退出码 1 结束。
2. 在 Mac 上运行 `resume-runners.sh` 加回其余仍安装的 runner 的标签并启动它们。
3. 在 Mac 上从 GitHub 删除 `ci-vps-2`：先用 `gh api repos/sixianli/himawari-agent/actions/runners --jq '.runners[]|{id,name}'` 查到编号，再运行 `gh api -X DELETE repos/sixianli/himawari-agent/actions/runners/<编号>`。
4. 验证：`id gh-runner-2` 报用户不存在，`/srv/gh-runner-2` 不存在，`sudo -n nft list table inet gh_runner` 的规则里没有 `gh-runner-2` 的 uid、只有仍装着的 runner 账号的 uid，其他 runner 仍为 `online`。

**只卸第 3 个检查 runner**：

1. 先在 Mac 上运行 `pause-runners.sh`，再在 VPS 上运行 `sudo bash /home/ubuntu/ci-runner/uninstall-runner.sh 6`。做法和“只卸第 2 个 runner”相同，删的是 `gh-runner-3.service`、`/srv/gh-runner-3/` 和 `gh-runner-3` 用户和组。
2. 在 Mac 上运行 `resume-runners.sh`，再按“只卸第 2 个 runner”的第 3 步从 GitHub 删除 `ci-vps-3`。

**只卸汇总 runner（`ci-vps-gate`）**：

1. 先确认 `ci.yml` 的汇总作业已经不写 `runs-on: ci-vps-gate`（改回去的 PR 已合并），或者已经运行 `gate-fallback.sh on` 并打算一直让第 1 个 runner 接汇总作业；否则卸掉之后所有 PR 的 `ci/required` 都会一直排队。
2. 在 Mac 上运行 `pause-runners.sh`，再在 VPS 上运行 `sudo bash /home/ubuntu/ci-runner/uninstall-runner.sh 3`。它停掉并删除 `gh-runner-gate.service`、结束 `gh-runner-gate` 的进程、删除 `/srv/gh-runner-gate/`、删除 `gh-runner-gate` 用户和组，再按剩下的 runner 重新生成防火墙规则和窄 sudo 规则。`ghgate.slice` 文件留着，没有服务用它时不占内存；检查 runner 合计的内存上限仍是 16 GB。
3. 在 Mac 上运行 `resume-runners.sh`，再按“只卸第 2 个 runner”的第 3 步从 GitHub 删除 `ci-vps-gate`。
4. 验证：`id gh-runner-gate` 报用户不存在，`/srv/gh-runner-gate` 不存在，各检查 runner（`ci-vps-1`、`ci-vps-2`，装了的话还有 `ci-vps-3`）仍为 `online`。

**全部卸载**：

1. 在 Mac 上先停用 `ci.yml` 和 `main.yml`（`gh workflow disable`），免得任务排队等不存在的 runner。
2. 在 VPS 上运行 `sudo bash /home/ubuntu/ci-runner/uninstall-runner.sh all`。它停掉并删除四个 runner 的服务、两个 slice、防火墙服务和每小时清理，删除防火墙表、`/etc/gh-runner/`、共享目录 `/srv/gh-runner-share/` 和组 `gh-ci-share`、删除窄 sudo 规则，结束四个账号的进程，删除 `/srv/gh-runner/`、`/srv/gh-runner-2/`、`/srv/gh-runner-3/` 和 `/srv/gh-runner-gate/`，再删除四个用户和组。最后逐项核对：全部删干净才打印 `UNINSTALL_OK`；还有残留时打印 `UNINSTALL_INCOMPLETE` 和残留清单，并以退出码 1 结束，按清单手动处理后再运行一次。缺 `nft` 命令时以退出码 66 拒绝，因为删不掉也查不了防火墙表。
3. 在 Mac 上按“只卸第 2 个 runner”的第 3 步从 GitHub 删除 `ci-vps-1`、`ci-vps-2`、`ci-vps-3` 和 `ci-vps-gate`。
4. 验证：`id gh-runner`、`id gh-runner-2`、`id gh-runner-3`、`id gh-runner-gate` 都报用户不存在，`/srv/gh-runner`、`/srv/gh-runner-2`、`/srv/gh-runner-3`、`/srv/gh-runner-gate` 都不存在，`nft list tables` 里没有 `gh_runner`，GitHub 的 runner 列表里没有这四个 runner。

不传参数时卸载脚本以退出码 64 拒绝，不删任何东西。

[↑ 返回阅读导航](#contents)

<a id="stop-conditions"></a>

## Stop Conditions

- 主机名不是 `ci-vps`。
- 根盘可用空间低于 16 GiB，或者需要删除不属于 runner 的东西才能腾出空间。
- 要做的系统改动超出 Andy 已授权的范围。
- 某个 workflow 需要 Docker 或本机服务。
- 用户命名空间限制的全局开关不是 1，或者需要关掉它才能让测试通过。
- `gh-runner`、`gh-runner-2`、`gh-runner-3` 或 `gh-runner-gate` 出现了自己以外的组。
- `ci-vps-gate` 带上了 `ci-vps` 标签，或者 `ci-vps-2` 带上了 `ci-vps-gate` 标签。
- 注册令牌出现在命令行、文件或日志里。

[↑ 返回阅读导航](#contents)

<a id="troubleshooting"></a>

## Troubleshooting

| 现象 | 安全的诊断 | 处理 |
| --- | --- | --- |
| 日志反复出现 `A session for this runner already exists` 和 `Conflict` | `journalctl -u gh-runner.service --since -10min`（第 2 个检查 runner 看 `gh-runner-2.service`，第 3 个检查 runner 看 `gh-runner-3.service`，汇总 runner 看 `gh-runner-gate.service`） | runner 上次没来得及注销会话（例如进程被强杀）。GitHub 端的旧会话约 2 到 3 分钟后过期，runner 会自己重连，不用处理。正常重启也出现时，检查服务的启动命令是不是 `bin/runsvc.sh`、停止信号是不是 `SIGTERM`。 |
| GitHub 显示 `offline` | Preflight 第 3、7 项；对应服务的 `journalctl -u` | 服务停着就在 Mac 上运行 `resume-runners.sh`；服务在跑但连不上，看日志里的网络错误，VPS 断网时只能等，或在 OVH 控制台看机器状态。 |
| 任务报 `below the 16 GiB floor; job refused` | `df -h /`；每个 runner 的 `disk.log` 末尾几行 | 先报告 Andy；只能清 `/srv/gh-runner/runner/_work`、`/srv/gh-runner-2/runner/_work`、`/srv/gh-runner-3/runner/_work`、`/srv/gh-runner-gate/runner/_work` 下没有任务在用的旧目录，其他东西不删。 |
| 任务访问本机服务、私有网段或元数据服务地址失败 | `sudo -n nft list table inet gh_runner` | 防火墙按设计拒绝。确实需要时先问 Andy，不自行放开。 |
| 正在跑的任务日志里出现 `The runner has received a shutdown signal` | `sudo journalctl -u gh-runner -u gh-runner-2 -u gh-runner-3 -u gh-runner-gate --since <时间>` 里有 `Stopping gh-runner`，同一时段 `/var/log/unattended-upgrades/unattended-upgrades.log` 有升级记录 | 自动安全更新之后 needrestart 重启了 runner。确认 `/etc/needrestart/conf.d/50ci-vps-gh-runner.conf` 还在；不在就重新运行 `prepare-vps.sh`。被杀掉的运行在 GitHub 上重跑。runner 要用上新库时，等所有 runner 都空闲再 `sudo systemctl restart gh-runner gh-runner-2 gh-runner-3 gh-runner-gate`。 |
| 任务装浏览器时要 root | 看是否用了 `playwright install --with-deps` | 准备脚本已装好浏览器的系统库，workflow 里去掉 `--with-deps`；Playwright 升级后重新运行 `prepare-vps.sh`（先把里面的版本号改成新的）。 |
| CI 作业在“放进 CI 服务器”或“取构建”步骤失败，报 `CI_SHARE_ROOT_REQUIRED` 或 `CI_SHARE_ROOT_INVALID` | `stat -c '%a %U %G' /srv/gh-runner-share`；`systemctl show gh-runner.service -p SupplementaryGroups -p Environment` | 共享目录或组没装：先 `pause-runners.sh`，再重新运行 `install-runner.sh`，最后 `resume-runners.sh`。 |
| 一个 runner 取另一个 runner 放的文件时报 `EACCES`（没有权限） | `stat -c '%a %U %G' /srv/gh-runner-share` 应为 `2770 root gh-ci-share`；`ls -ld /srv/gh-runner-share/*` 的组都应是 `gh-ci-share` | 共享目录的 setgid 位（让子目录继承组的权限位）丢了：先 `pause-runners.sh`，重新运行 `install-runner.sh`，删掉组不对的运行目录，再 `resume-runners.sh`。 |
| 报 `CI_SHARE_DIGEST_MISMATCH:<名字>`、`CI_SHARE_MISSING:<名字>` 或 `CI_SHARE_DIGEST_INVALID` | 看同一轮里那个上游作业有没有成功；`ls -la /srv/gh-runner-share/<运行号-尝试号>/` | 上游没跑完、或用了“只重跑失败的作业”，都是缺失（摘要为空时报 `CI_SHARE_DIGEST_INVALID`），重跑整轮（Re-run all jobs）；摘要不符说明文件在存和取之间被改了，先报告。共享目录里的文件在这一轮 `ci/required` 结束时已被删掉，能留下的只有作业日志：放文件的作业日志里有 `CI_SHARE_PUT <名字> <摘要>`，汇总日志里有 `CI_SHARE_COLLECT_MISSING`，记下运行号和这两行。 |
| `gh-runner-nft.service` 失败，runner 服务起不来 | `systemctl status gh-runner-nft.service`；`sudo -n nft -c -f /etc/gh-runner/nft.rules` | 规则文件坏了就重新运行 `install-runner.sh` 生成。 |
| 安装脚本以退出码 71 拒绝（`refusing to take over`；注意 `prepare-vps.sh` 的 71 是另一件事） | `getent group gh-ci-share`；`ls -la /srv/gh-runner-share` | 组不存在而共享目录已存在，安装脚本不接管别人建的目录。先查清目录是谁建的、里面有什么；确认没用后手动移走（不要用 `uninstall-runner.sh all`，它会删掉这个目录），再重新运行安装脚本。 |
| 安装脚本以退出码 70 拒绝 | 输出里点名的服务 | 有 runner 服务在运行；先在 Mac 上运行 `pause-runners.sh`，装完再 `resume-runners.sh`。 |
| bwrap 报 `Operation not permitted` 或 `setting up uid map` | `sysctl -n kernel.apparmor_restrict_unprivileged_userns`；`sudo aa-status \| grep bwrap` | `/etc/apparmor.d/bwrap` 没加载或被改过。重新运行 `prepare-vps.sh`；不要关掉全局开关。 |
| 几个检查任务同时跑时任务被系统杀掉或测试变慢、超时 | `cat /sys/fs/cgroup/gh.slice/gh-runners.slice/memory.events`（systemd 按名字里的 `-` 把它放在 `gh.slice` 下面） 看 `oom_kill`；`systemctl show gh-runners.slice -p MemoryCurrent` | 合计 16 GB 不够用的迹象。记录下来报告 Andy，由 Andy 决定是否减少检查 runner；不自行调高上限。 |
| 所有 PR 的 `ci/required` 都在排队，检查作业却照常跑完 | Preflight 第 4、8 项里 `gh-runner-gate.service` 和 `ci-vps-gate` 的状态；`journalctl -u gh-runner-gate.service --since -30min` | 汇总 runner 停了或掉线。先在 Mac 上运行 `gate-fallback.sh on`（见[应急](#gate-fallback)），再查服务；服务停着就 `sudo -n /usr/bin/systemctl restart gh-runner-gate.service`。修好后运行 `gate-fallback.sh off`。 |
| 汇总作业被系统杀掉，或 `ci/required` 的日志在装工具、收报告时中断 | `cat /sys/fs/cgroup/ghgate.slice/memory.events` 看 `oom_kill`；`systemctl show ghgate.slice -p MemoryPeak` | 汇总 runner 的 4 GB 不够用。记录峰值报告 Andy；要调时改 `runners.sh` 里汇总 runner（编号 3）的三个内存值和 `ghgate.slice`，并相应调低 `gh-runners.slice`，两个分组合计不超过 20 GB。 |

[↑ 返回阅读导航](#contents)
