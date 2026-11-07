---
status: active
document_type: runbook
execution_risk: critical
contract_sha256: "sha256:edb24e73a3045dcadb993bd80575d8dccd47ed948a21ac581ac5e7a4b2d5b007"
supersedes: "docs/archive/runbooks/2026-11-07-hermes-self-hosted-runner-runbook.md"
superseded_by: ""
date: "2026-11-07"
---

# CI VPS 上的自托管 runner Runbook

<!-- runbook-contract:
- scripts/operations/ci-runner
-->

本手册说明 CI VPS（Andy 在 OVH 租的云服务器，Ubuntu 24.04，8 个 vCPU，22 GB 内存，公网地址 `158.69.191.249`，主机名 `ci-vps`）上那两个 GitHub 自托管 runner（装在自己机器上、替 GitHub 执行 CI 任务的程序）怎么准备机器、安装、注册、日常维护、暂停、排错和卸载。为什么这样做见 [ADR 0176](../adr/0176-ci-on-ovh-vps.md)。这台机器只跑 CI，不用来跑 Himawari 的开发测试。

<a id="contents"></a>

## 阅读导航

- [Scope](#scope)：管什么、不管什么，以及各部分放在哪里
- [Authoritative Sources](#authoritative-sources)
- [Safety and Preconditions](#safety-and-preconditions)：权限、令牌、Docker
- [Live-State Preflight](#live-state-preflight)：动手前的只读检查
- [Procedure](#procedure)：准备机器、安装、注册、暂停和恢复、日常维护、注销 Hermes 上的旧 runner
- [Verification](#verification)
- [Evidence](#evidence)
- [Rollback](#rollback)：只卸第 2 个 runner，或全部卸载
- [Stop Conditions](#stop-conditions)
- [Troubleshooting](#troubleshooting)

<a id="scope"></a>

## Scope

- **管的范围**：仓库 `sixianli/himawari-agent` 的两个自托管 runner，名字分别是 `ci-vps-1`（第 1 个）和 `ci-vps-2`（第 2 个），标签都是 `ci-vps`。`ci.yml` 和 `main.yml` 的任务派给其中空闲的一个。
- **不管的范围**：`quality.yml` 停用，等另一个 PR 搬到这台机器（ADR 0176 决定第 8 条）；macOS 的构建和测试已暂停；Hermes 只作合并前本地检查的测试主机，它的操作见[测试主机操作 Runbook](test-host-operations-runbook.md)。

各部分的位置：

| 内容 | 位置 | 属主 |
| --- | --- | --- |
| runner 程序（版本 2.338.2）和工作目录 `_work`（Playwright 浏览器缓存在任务的检出目录里，见 `ci.yml` 的 `PLAYWRIGHT_BROWSERS_PATH`） | 第 1 个 `/srv/gh-runner/runner/`，第 2 个 `/srv/gh-runner-2/runner/` | 各自的账号 `gh-runner`、`gh-runner-2` |
| runner 的家目录 | `/srv/gh-runner/home/`、`/srv/gh-runner-2/home/` | 各自的账号 |
| 每个任务开始和结束时的磁盘记录 `disk.log` | `/srv/gh-runner/logs/`、`/srv/gh-runner-2/logs/` | 各自的账号 |
| 任务开始、结束钩子 | `/srv/gh-runner/hooks/`、`/srv/gh-runner-2/hooks/` | root，只读 |
| 每日清理脚本（两个 runner 都清） | `/srv/gh-runner/hooks/clean-old.sh` | root，只读 |
| 暂停、恢复脚本 | Mac 上的入口 `scripts/operations/ci-runner/pause-runners.sh`、`resume-runners.sh`；它们每次用 `scp` 把 `runners.sh`、`runner-pause.sh`、`runner-resume.sh` 传到 VPS 的 `/home/ubuntu/ci-runner/` 再运行 | ubuntu |
| systemd 服务（Linux 管理后台服务的程序） | `/etc/systemd/system/gh-runner.service`、`gh-runner-2.service`（都由仓库里的模板 `gh-runner.service.in` 生成）、`gh-runners.slice`、`gh-runner-nft.service`、`gh-runner-clean.service`、`gh-runner-clean.timer` | root |
| 安装前的备份 | `/var/backups/gh-runner/<时间>/` | root |
| 防火墙规则 | `/etc/gh-runner/nft.rules`，加载后是 nftables（Linux 自带的防火墙）里的表 `inet gh_runner` | root |
| ubuntu 启停 runner 的窄 sudo 规则（ubuntu 本来就有免密 sudo，这条规则留着是为了脚本在别的机器上也成立） | `/etc/sudoers.d/91-gh-runner-control` | root |
| 仓库里的源文件 | [scripts/operations/ci-runner/](../../scripts/operations/ci-runner/) | — |
| 一次性准备的配置 | `/etc/cloud/cloud.cfg.d/99-ci-vps-hostname.cfg`（重启后保留主机名）、`/etc/apt/apt.conf.d/52ci-vps-no-auto-reboot`（安全更新后不自动重启）、`/etc/apparmor.d/bwrap`（只给系统的 bwrap 放开用户命名空间） | root |

身份和限额（写在服务模板 `gh-runner.service.in` 和 `gh-runners.slice` 里）：

- 每个 runner 一个系统用户（`gh-runner`、`gh-runner-2`），不能登录，只属于自己的组，不在 sudo 组或 docker 组里。
- `ProtectHome=yes` 让它看不到 `/home`（包括 ubuntu 的 SSH 密钥），`InaccessiblePaths` 让它碰不到 Docker 的控制接口；`ProtectSystem=strict` 让它只能写自己的三个目录；每个服务还藏起另一个 runner 的目录（`InaccessiblePaths=-/srv/gh-runner-2` 或 `-/srv/gh-runner`）。
- `ProtectProc=invisible` 让它在 `/proc` 里只看得到自己的进程，看不到本机其他服务的进程和命令行参数。
- 服务不在 `/proc` 下加任何挂载，所以不设 `ProtectKernelTunables`、`ProtectKernelLogs`，`ReadOnlyPaths`、`InaccessiblePaths` 里也不写 `/proc` 下的路径：项目沙箱要给自己新挂一份 `/proc`，VPS 的内核遇到这类挂载会拒绝，沙箱就起不来（原因和复现见 [ADR 0176](../adr/0176-ci-on-ovh-vps.md#decision) 决定第 6 条）。
- 防火墙规则只对两个 runner 账号生效（一条规则同时匹配两个账号的 uid）：拒绝它访问私有网段（`10/8`、`100.64/10`、`172.16/12`、`192.168/16`、`fc00::/7`、`fe80::/10`）和 `169.254.0.0/16`（云主机的元数据服务地址），以及本机任何地址（回环地址、公网 IPv4 和 IPv6 都算，规则写作 `fib daddr type local`）上端口名单里的 TCP 端口（DNS 的 53 端口除外）。名单在每次生成规则时取当时在监听的端口，再加上上一份规则里已有的端口。访问互联网不受影响。防火墙不管 UDP 和本机的 Unix 套接字（同一台机器上进程之间通信用的文件形式的接口）：Unix 套接字靠文件权限挡住，Docker 的控制接口另外被藏起来。
- 同一个 runner 上的所有任务都以同一个账号运行，所以一个任务能读到这个 runner 自己的注册凭证，也能改 runner 的安装文件和后面任务的残留。仓库是私有的，只有 Andy 和他自己的代理线程会推送，所以接受这一点。这也是两个 runner 都不给 docker 组的原因：docker 组等于 root，一个任务就能拿到整台机器。怀疑 runner 被改过时，按 [Rollback](#rollback) 完整卸载后重新安装、注册；只重新运行安装脚本不会重新解压 runner。
- VPS 只跑 CI，所以 runner 不限 CPU，CPU 和磁盘优先级用系统默认。每个 runner 内存最多 15 GB（`MemoryHigh=14G`、`MemoryMax=15G`），不用交换分区，最多 2048 个进程。两个服务都放在 `gh-runners.slice`（把几个服务放进同一个资源分组、一起设上限的单元）里，合计内存最多 20 GB（`MemoryHigh=19G`、`MemoryMax=20G`），最多 4096 个进程；留出的约 2 GB 让 ssh 在 runner 用满自己的内存时仍能登录。
- 每个任务开始前检查 runner 目录所在磁盘（就是根盘）的可用空间，低于 16 GiB（两个任务可能同时占盘）或读不出数字时都拒绝这个任务；任务结束后删除它的检出和 `_work/_temp`；每天的定时清理删除三天前的 `_work` 残留和 14 天前的 runner 诊断日志，哪个 runner 有任务在跑就跳过它，查不出有没有任务时也跳过并以退出码 1 结束。

[↑ 返回阅读导航](#contents)

<a id="authoritative-sources"></a>

## Authoritative Sources

- 决定和理由：[SOURCE: docs/adr/0176-ci-on-ovh-vps.md]、[SOURCE: docs/adr/0168-longer-ci-job-limits-on-hermes.md]、[SOURCE: docs/adr/0169-pause-runners-by-removing-the-label.md]
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
4. 服务状态：`systemctl is-active gh-runner.service gh-runner-2.service gh-runner-nft.service gh-runner-clean.timer`，四个都应是 `active`。
5. 用户没有多余的组：`id gh-runner`、`id gh-runner-2` 各自只列出自己的一个组。
6. 防火墙表在：`sudo -n nft list table inet gh_runner` 里有 `fib daddr type local`。
7. 限额生效：`systemctl show gh-runner.service gh-runner-2.service -p Slice -p MemoryHigh -p MemoryMax -p MemorySwapMax -p TasksMax -p CPUQuotaPerSecUSec -p CPUWeight -p IOWeight -p Nice -p ExecStart`，两个都应为 `Slice=gh-runners.slice`、`MemoryHigh=15032385536`、`MemoryMax=16106127360`、`MemorySwapMax=0`、`TasksMax=2048`、`CPUQuotaPerSecUSec=infinity`、`CPUWeight=[not set]`、`IOWeight=[not set]`、`Nice=0`，启动命令分别是 `/srv/gh-runner/runner/bin/runsvc.sh` 和 `/srv/gh-runner-2/runner/bin/runsvc.sh`；`systemctl show gh-runners.slice -p MemoryHigh -p MemoryMax -p MemorySwapMax -p TasksMax -p CPUQuotaPerSecUSec -p CPUWeight -p IOWeight` 应为 `MemoryHigh=20401094656`、`MemoryMax=21474836480`、`MemorySwapMax=0`、`TasksMax=4096`、`CPUQuotaPerSecUSec=infinity`、`CPUWeight=[not set]`、`IOWeight=[not set]`。
8. GitHub 上的状态（在 Mac 上运行）：`gh api repos/sixianli/himawari-agent/actions/runners --jq '.runners[]|{id,name,status,busy}'`，应看到 `ci-vps-1` 和 `ci-vps-2` 都为 `online`。
9. 有没有任务在跑：`pgrep -u gh-runner -x Runner.Worker; pgrep -u gh-runner-2 -x Runner.Worker`，有输出就是有任务。

[↑ 返回阅读导航](#contents)

<a id="procedure"></a>

## Procedure

<a id="install"></a>

### 准备机器

只在新机器上做一次，之后可以重复运行：

1. 把 `scripts/operations/ci-runner/prepare-vps.sh` 用 `scp` 传到 VPS 的 `/home/ubuntu/`。
2. `sudo bash /home/ubuntu/prepare-vps.sh > /home/ubuntu/prepare-vps.log 2>&1`（要几分钟，放后台）。脚本确认以 root 运行（否则退出码 64）、主机名是 `ci-vps` 或 OVH 给的原名 `vps-482b8c36`（否则 68）、系统是 Ubuntu 24.04（否则 69）；装编译工具、`unzip`、`xz-utils`、`bubblewrap`、`socat`、`ripgrep`、`apparmor-utils`；写 cloud-init 配置并把主机名改成 `ci-vps`；关掉安全更新后的自动重启；写入并加载 `/etc/apparmor.d/bwrap`（已有内容不同的同名文件时以退出码 70 拒绝，不覆盖），确认全局开关仍是 1（否则 71）；下载 Node 22.22.3 并核对 SHA-256（不对时 72），用它装 Playwright 1.62.1 需要的 chromium、firefox、webkit 系统库。成功时最后一行是 `CI_VPS_PREPARED hostname=ci-vps bwrap=<版本> userns_restrict=1 gcc=<版本> playwright_deps=1.62.1`。
3. `sudo systemctl reboot`，重新连上后按 [Live-State Preflight](#live-state-preflight) 第 1、2 项核对主机名和 bwrap。

### 安装

1. 把 `scripts/operations/ci-runner/` 下的全部文件（包括 `runners.sh` 和 `gh-runner.service.in`）用 `scp` 传到 VPS 的 `/home/ubuntu/ci-runner/`。
2. 有 runner 服务在运行时安装脚本以退出码 70 拒绝，所以重装前先按[暂停和恢复](#pause-and-resume)在 Mac 上运行 `pause-runners.sh`。
3. `sudo bash /home/ubuntu/ci-runner/install-runner.sh`。脚本会：确认主机名是 `ci-vps`（否则以退出码 68 拒绝）；把要改动的服务文件、slice、`/etc/gh-runner/`、窄 sudo 规则和两个 runner 的 `hooks/` 目录复制到 `/var/backups/gh-runner/<时间>/`，并记下哪些原来不存在；之后任何一步失败或脚本被中断（`Ctrl-C`、`TERM`、`HUP`），都会把原有的放回、把这次新建的文件、用户、组和目录删掉，撤销这次新启用的开机启动，重新加载防火墙规则，并打印 `INSTALL_FAILED`；有放不回去的会打印 `RESTORE_INCOMPLETE`，列出是哪几项和备份目录；建 `gh-runner` 和 `gh-runner-2` 两个用户（已有额外组时以退出码 67 拒绝；已有这个用户但没有它的 `runner` 目录时以退出码 69 拒绝），建两个 runner 的目录，没装过 runner 的下载 2.338.2 并核对 SHA-256，装钩子、slice 和服务，按端口名单和现存的 runner 账号生成防火墙规则并先用 `nft -c` 检查，生成窄 sudo 规则，加载防火墙规则，启用防火墙服务和每日清理定时器。成功时打印 `INSTALL_OK`，同时打印 runner 账号的 uid、拦住的本机端口和备份目录。
4. 重装时最后在 Mac 上运行 `resume-runners.sh`；第一次安装要先按[注册](#register)注册。

<a id="register"></a>

### 注册

1. 在 Mac 上用 `gh api -X POST repos/sixianli/himawari-agent/actions/runners/registration-token --jq .token` 取令牌，通过管道直接交给 VPS 上的 `sudo bash /home/ubuntu/ci-runner/register-runner.sh <1|2>` 的标准输入，例如 `gh api ... --jq .token | ssh -o BatchMode=yes ubuntu@158.69.191.249 'sudo bash /home/ubuntu/ci-runner/register-runner.sh 1'`；令牌不落盘、不进参数。注册两个 runner 时每次单独取一个令牌。
2. 脚本先确认主机名是 `ci-vps`、装了 `python3`、以 root 运行；没写注册第几个 runner 时以退出码 64 拒绝（免得 `--replace` 把现有的 `ci-vps-1` 换掉），标准输入里没有令牌时也以退出码 64 拒绝。再确认这个 runner 版本会读 `ACTIONS_RUNNER_INPUT_TOKEN`（否则拒绝，以免令牌只能放进命令行），然后以对应账号注册：第 1 个名字是 `ci-vps-1`，第 2 个是 `ci-vps-2`，标签都是 `ci-vps`（取自 `runners.sh` 的 `RUNNER_LABEL`）。最后启用并启动对应的服务。成功时打印 `REGISTER_OK`。

<a id="pause-and-resume"></a>

### 暂停和恢复

VPS 上没有受保护测试，平时不用暂停；重装或维护 runner 时才用。两个入口都在 Andy 的 Mac 上、从仓库根目录运行，用 Andy 已登录的 `gh` 改 runner 标签，用 `ssh` 和 `scp`（选项 `BatchMode=yes`、`ConnectTimeout=20`、`ServerAliveInterval=15`）操作 VPS，地址默认 `ubuntu@158.69.191.249`，可用环境变量 `CI_VPS_SSH` 改；每条远程命令先核对主机名是 `ci-vps`，不是就以退出码 68 结束。VPS 上不放任何 GitHub 凭证。两个入口共用一把锁（`.ci-output/ci-runner-pause.lock` 目录），同时只能跑一个，否则以退出码 75 打印 `RUNNER_LOCKED`；进程被强杀留下的锁目录要手动删掉。做法和理由见 [ADR 0169](../adr/0169-pause-runners-by-removing-the-label.md)。

- 暂停：`scripts/operations/ci-runner/pause-runners.sh`。暂停可能要等到最长任务的时限（`ci/policy.json` 里最大的 `timeoutMinutes`）加 5 分钟，代理要在后台运行它。
  1. 把三个脚本传到 VPS，读 VPS 上注册过（服务已启用）的 runner，和 GitHub 上的 runner 对账（只建了账号、还没注册的 runner 不算）：VPS 上的每个 runner 在 GitHub 上必须恰好有一个同名的，GitHub 上带 `ci-vps` 标签的 runner 也必须都装在 VPS 上。对不上就打印 `RUNNER_PAUSE_FAILED` 和原因，不改标签、不停服务（VPS 上的三个脚本已经更新为仓库里的版本）。
  2. 去掉这些 runner 的 `ci-vps` 标签，再读一遍确认真的去掉了。有一个没去掉，就把已经去掉的加回去，打印 `RUNNER_PAUSE_FAILED`，不碰 VPS。回读时读不全 GitHub 的列表，也按“没去掉”处理。这一步被 Ctrl-C、`TERM` 或 `HUP` 打断时，同样把已经发出删除请求的标签都加回去，打印 `RUNNER_PAUSE_FAILED interrupted`，以退出码 130 结束。都去掉后打印 `RUNNER_LABELS_REMOVED`：从这时起 GitHub 不再给它们派新任务，新任务在 GitHub 上排队。
  3. 每 30 秒查一次 GitHub：两个 runner 都显示 `busy=false` 时，在 VPS 上运行 `runner-pause.sh --labels-removed 90`。它连续观察 90 秒，期间每 10 秒查一次本机有没有 `Runner.Worker`，一直没有才停两个服务，打印 `RUNNER_PAUSED`；中途看到任务就打印 `RUNNER_STILL_BUSY`，以退出码 2 结束、不停服务，Mac 侧接着等。
  4. 成功时打印 `RUNNER_PAUSED labels=removed services=stopped`。
  5. 到了等待上限还有任务，打印 `RUNNER_PAUSE_INCOMPLETE labels=removed services=<每个服务当时的状态>` 和还在忙的 runner（一直读不到 GitHub 时写 `(could not read GitHub)`），以退出码 2 结束。服务状态读不到时写 `services=unknown`。VPS 那一步出错（例如只停掉了一个服务）时，打印 `RUNNER_PAUSE_INCOMPLETE labels=removed services=<每个服务当时的状态>`，以退出码 1 结束；等待期间被 Ctrl-C、`TERM` 或 `HUP` 打断时，打印同样一行并加上 `interrupted`，以退出码 130 结束。这几种情况下标签都保持去掉，还在跑的服务跑完手上的任务，不会再接新任务；重新运行 `pause-runners.sh` 即可，或运行 `resume-runners.sh` 撤销。
- 恢复：`scripts/operations/ci-runner/resume-runners.sh`。它先像暂停一样对账，对不上就打印 `RUNNER_RESUME_FAILED` 和原因，不启动服务、不加标签；再在 VPS 上运行 `runner-resume.sh`，只启动已注册（服务已启用）的 runner；再等 GitHub 显示它们 `online`（最多 5 分钟），最后把 `ci-vps` 标签加回去并读一遍确认，打印 `RUNNER_RESUMED labels=restored`。服务没起来时打印 `RUNNER_RESUME_FAILED services=<每个服务当时的状态>`，不加标签；5 分钟内没上线打印 `RUNNER_RESUME_INCOMPLETE services=<各服务状态> labels=removed` 和没上线的 runner（一直读不到 GitHub 时写 `(could not read GitHub)`）；标签没加上打印 `RUNNER_RESUME_INCOMPLETE` 和每个 runner 的标签状态；对账之后任何时候被 Ctrl-C、`TERM` 或 `HUP` 打断，打印 `RUNNER_RESUME_INCOMPLETE interrupted`、各服务状态和每个 runner 的标签状态（`on`、`off`、`unread`），以退出码 130 结束。这几种情况下排队的任务都继续排队，不会失败，处理后重新运行即可。2026-11-05 实测：恢复后排队的任务约 3.5 分钟才开始跑，两个 runner 同一秒接到任务，原因在 GitHub 一侧、没有确认，等几分钟即可，不要因此重启 runner。
- 暂停期间新的 CI 任务在 GitHub 上排队；**排队超过 24 小时的任务会被 GitHub 判为失败**，所以暂停不要超过一天。GitHub 大约 1 分钟后才把停掉的 runner 显示为 `offline`。
- 暂停期间 VPS 重启：服务会自己起来。按 runner 源码（[`ConfigurationManager.cs`](https://github.com/actions/runner/blob/main/src/Runner.Listener/Configuration/ConfigurationManager.cs)），标签只在配置（`config.sh`）时发给 GitHub，所以重启后标签应该还是去掉的、不会接任务；但启动会话的代码没有核对，也没实测过，重启后先用 `gh api` 看一眼标签。之后照常运行 `resume-runners.sh`。不要在暂停期间重新注册 runner（`config.sh --replace` 会重置标签）。
- `runner-pause.sh` 不带 `--labels-removed` 时以退出码 64 拒绝：直接在 VPS 上停服务会让 GitHub 在停之前的空档里派来的任务被取消。
- GitHub 文档写明，它不能保证常驻 runner 停机时绝对不被派任务（[Self-hosted runners reference](https://docs.github.com/en/actions/reference/runners/self-hosted-runners)）。去掉标签再观察 90 秒，把这个空档压到很小，但不是零。

<a id="routine-maintenance"></a>

### 日常维护

- **磁盘**：看两个 runner 各自的 `logs/disk.log`，每个任务记一行开始时的可用空间，一行结束时 `_work` 的大小和可用空间。
- **runner 升级**：runner 会自己升级到 GitHub 要求的版本（它的目录归各自的 runner 账号所有，所以能写）。要换安装脚本里固定的版本时，改 `install-runner.sh` 里的 `VERSION` 和 `SHA256`，SHA-256 从 GitHub 的发布页核对。
- **本机新增了服务**：防火墙只挡端口名单里的端口。之后新开的本机服务端口不在名单里，要刷新规则：先按[暂停和恢复](#pause-and-resume)在 Mac 上运行 `pause-runners.sh`（有 runner 服务在运行时安装脚本以退出码 70 拒绝），再重新运行 `install-runner.sh`（脚本可重复运行，不会重新下载或重建用户，最后会重新加载防火墙规则），最后运行 `resume-runners.sh`。
- **防火墙表被清掉**：如果有人重启了系统的 `nftables` 服务，而 `/etc/nftables.conf` 里有 `flush ruleset`，表 `inet gh_runner` 会被一并清掉。用 `sudo systemctl restart gh-runner-nft.service gh-runner.service gh-runner-2.service` 恢复。
- **系统更新**：自动安全更新开着，但不自动重启。要重启时先暂停 runner，重启后按 [Live-State Preflight](#live-state-preflight) 核对，再恢复。
- **重启服务**：`sudo -n /usr/bin/systemctl restart gh-runner.service`（第 2 个是 `gh-runner-2.service`）。runner 会先向 GitHub 注销会话再退出，几秒后重新在线。

<a id="retire-hermes-runners"></a>

### 注销 Hermes 上的旧 runner（一次性）

ADR 0176 决定第 10 条：VPS 上完整跑通一次 CI 之后做，不留作备用。要在改名的 PR 合并之前做，用 `main` 上还在的旧脚本（`scripts/operations/hermes-runner/`）；合并之后只能从历史里取，例如 `git show 058293d1:scripts/operations/hermes-runner/uninstall-runner.sh`。

1. 在 Mac 上从 `main` 的检出运行 `scripts/operations/hermes-runner/pause-runners.sh`，看到 `RUNNER_PAUSED labels=removed services=stopped`。
2. 从 GitHub 删除 `hermes-home` 和 `hermes-home-2`：`gh api repos/sixianli/himawari-agent/actions/runners --jq '.runners[]|{id,name}'` 查编号，再 `gh api -X DELETE repos/sixianli/himawari-agent/actions/runners/<编号>`。
3. Andy 的账号在 Hermes 上没有 root，所以请 Andy 在 Hermes 上运行 `sudo bash /home/andy/himawari-tests/hermes-runner/uninstall-runner.sh all`（脚本先用 `hermes-upload.sh` 传上去），看到 `UNINSTALL_OK`。
4. 验证：GitHub 的 runner 列表里只剩 `ci-vps-1`、`ci-vps-2`；Hermes 上 `id gh-runner`、`id gh-runner-2` 都报用户不存在。

[↑ 返回阅读导航](#contents)

<a id="verification"></a>

## Verification

- GitHub 接口显示 `ci-vps-1` 和 `ci-vps-2` 都为 `online`，空闲时 `busy` 为 `false`，标签有 `self-hosted`、`Linux`、`X64`、`ci-vps`。
- `journalctl -u gh-runner.service` 和 `journalctl -u gh-runner-2.service` 最近都出现 `Listening for Jobs`，之后没有 `Conflict`。
- 分别以 `gh-runner` 和 `gh-runner-2` 身份读 `/home/ubuntu/.ssh`、另一个 runner 的目录都被拒绝；连本机公网地址和 `127.0.0.1` 的 22 端口、`169.254.169.254` 都被拒绝；访问 `https://api.github.com` 正常；在 runner 账号下用 bwrap 建立隔离环境成功。
- 以 `gh-runner` 身份运行一次 `packages/runtime-sandbox/scripts/check-srt-boundary.mjs`（它不在 `npm run check` 里），记录 bwrap 版本、AppArmor 开关和结果。
- PR 的 `ci/required` 在这两个 runner 上运行并通过，任务日志开头的 `Runner name` 是 `ci-vps-1` 或 `ci-vps-2`。

[↑ 返回阅读导航](#contents)

<a id="evidence"></a>

## Evidence

- 证据放在 VPS 的 `/home/ubuntu/ci-runner-evidence/<运行编号>/`，每次操作一个新编号，编号用 JST 时间，例如 `20261107-0130`。
- 记录：预检输出、执行的命令和退出码、验证结果、是否回退、结论。
- 不记录注册令牌或任何密钥；日志里出现令牌样的字符串时，先删掉那份日志再继续。

[↑ 返回阅读导航](#contents)

<a id="rollback"></a>

## Rollback

触发条件：Andy 决定不再用这台机器，或者两个 runner 同时跑时内存不够（见 [Troubleshooting](#troubleshooting) 最后一行）。

**只卸第 2 个 runner**：

1. 先在 Mac 上运行 `pause-runners.sh`，再在 VPS 上运行 `sudo bash /home/ubuntu/ci-runner/uninstall-runner.sh 2`。它停掉并删除 `gh-runner-2.service`、结束 `gh-runner-2` 的进程、删除 `/srv/gh-runner-2/`、删除 `gh-runner-2` 用户和组，再按剩下的第 1 个 runner 重新生成防火墙规则和窄 sudo 规则（端口名单沿用上一份规则里的端口，再加上当时在监听的）。第 1 个 runner 的服务、目录、账号不动。全部删干净才打印 `UNINSTALL_OK`；还有残留时打印 `UNINSTALL_INCOMPLETE` 和残留清单，并以退出码 1 结束。
2. 在 Mac 上运行 `resume-runners.sh` 启动第 1 个 runner 并加回它的标签。
3. 在 Mac 上从 GitHub 删除 `ci-vps-2`：先用 `gh api repos/sixianli/himawari-agent/actions/runners --jq '.runners[]|{id,name}'` 查到编号，再运行 `gh api -X DELETE repos/sixianli/himawari-agent/actions/runners/<编号>`。
4. 验证：`id gh-runner-2` 报用户不存在，`/srv/gh-runner-2` 不存在，`sudo -n nft list table inet gh_runner` 的规则里只剩 `gh-runner` 的 uid，`ci-vps-1` 仍为 `online`。

**全部卸载**：

1. 在 Mac 上先停用 `ci.yml` 和 `main.yml`（`gh workflow disable`），免得任务排队等不存在的 runner。
2. 在 VPS 上运行 `sudo bash /home/ubuntu/ci-runner/uninstall-runner.sh all`。它停掉并删除两个 runner 的服务、slice、防火墙服务和每日清理，删除防火墙表和 `/etc/gh-runner/`、删除窄 sudo 规则，结束两个账号的进程，删除 `/srv/gh-runner/` 和 `/srv/gh-runner-2/`，再删除两个用户和组。最后逐项核对：全部删干净才打印 `UNINSTALL_OK`；还有残留时打印 `UNINSTALL_INCOMPLETE` 和残留清单，并以退出码 1 结束，按清单手动处理后再运行一次。缺 `nft` 命令时以退出码 66 拒绝，因为删不掉也查不了防火墙表。
3. 在 Mac 上按上面第 3 步从 GitHub 删除 `ci-vps-1` 和 `ci-vps-2`。
4. 验证：`id gh-runner`、`id gh-runner-2` 都报用户不存在，`/srv/gh-runner`、`/srv/gh-runner-2` 都不存在，`nft list tables` 里没有 `gh_runner`，GitHub 的 runner 列表里没有这两个 runner。

不传参数时卸载脚本以退出码 64 拒绝，不删任何东西。

[↑ 返回阅读导航](#contents)

<a id="stop-conditions"></a>

## Stop Conditions

- 主机名不是 `ci-vps`。
- 根盘可用空间低于 16 GiB，或者需要删除不属于 runner 的东西才能腾出空间。
- 要做的系统改动超出 Andy 已授权的范围。
- 某个 workflow 需要 Docker 或本机服务。
- 用户命名空间限制的全局开关不是 1，或者需要关掉它才能让测试通过。
- `gh-runner` 或 `gh-runner-2` 出现了自己以外的组。
- 注册令牌出现在命令行、文件或日志里。

[↑ 返回阅读导航](#contents)

<a id="troubleshooting"></a>

## Troubleshooting

| 现象 | 安全的诊断 | 处理 |
| --- | --- | --- |
| 日志反复出现 `A session for this runner already exists` 和 `Conflict` | `journalctl -u gh-runner.service --since -10min`（第 2 个看 `gh-runner-2.service`） | runner 上次没来得及注销会话（例如进程被强杀）。GitHub 端的旧会话约 2 到 3 分钟后过期，runner 会自己重连，不用处理。正常重启也出现时，检查服务的启动命令是不是 `bin/runsvc.sh`、停止信号是不是 `SIGTERM`。 |
| GitHub 显示 `offline` | Preflight 第 3、7 项；对应服务的 `journalctl -u` | 服务停着就在 Mac 上运行 `resume-runners.sh`；服务在跑但连不上，看日志里的网络错误，VPS 断网时只能等，或在 OVH 控制台看机器状态。 |
| 任务报 `below the 16 GiB floor; job refused` | `df -h /`；两个 runner 的 `disk.log` 末尾几行 | 先报告 Andy；只能清 `/srv/gh-runner/runner/_work`、`/srv/gh-runner-2/runner/_work` 下没有任务在用的旧目录，其他东西不删。 |
| 任务访问本机服务、私有网段或元数据服务地址失败 | `sudo -n nft list table inet gh_runner` | 防火墙按设计拒绝。确实需要时先问 Andy，不自行放开。 |
| 任务装浏览器时要 root | 看是否用了 `playwright install --with-deps` | 准备脚本已装好浏览器的系统库，workflow 里去掉 `--with-deps`；Playwright 升级后重新运行 `prepare-vps.sh`（先把里面的版本号改成新的）。 |
| `gh-runner-nft.service` 失败，runner 服务起不来 | `systemctl status gh-runner-nft.service`；`sudo -n nft -c -f /etc/gh-runner/nft.rules` | 规则文件坏了就重新运行 `install-runner.sh` 生成。 |
| 安装脚本以退出码 70 拒绝 | 输出里点名的服务 | 有 runner 服务在运行；先在 Mac 上运行 `pause-runners.sh`，装完再 `resume-runners.sh`。 |
| bwrap 报 `Operation not permitted` 或 `setting up uid map` | `sysctl -n kernel.apparmor_restrict_unprivileged_userns`；`sudo aa-status \| grep bwrap` | `/etc/apparmor.d/bwrap` 没加载或被改过。重新运行 `prepare-vps.sh`；不要关掉全局开关。 |
| 两个任务同时跑时任务被系统杀掉或测试变慢、超时 | `cat /sys/fs/cgroup/gh.slice/gh-runners.slice/memory.events`（systemd 按名字里的 `-` 把它放在 `gh.slice` 下面） 看 `oom_kill`；`systemctl show gh-runners.slice -p MemoryCurrent` | 合计 20 GB 不够用的迹象。记录下来报告 Andy，由 Andy 决定是否改为只跑一个 runner；不自行调高上限。 |

[↑ 返回阅读导航](#contents)
