---
status: active
document_type: runbook
execution_risk: critical
contract_sha256: "sha256:fcd411339ca17dfba515fff0bf41b5cf87149203390b09c3e317cc27920e68e5"
supersedes: ""
superseded_by: ""
date: "2026-11-04"
---

# Hermes 自托管 runner Runbook

<!-- runbook-contract:
- scripts/operations/hermes-runner
-->

本手册说明 Hermes（家里的 Linux 服务器，Ubuntu 22.04，主机名 `hermes-home`）上那两个 GitHub 自托管 runner（装在自己机器上、替 GitHub 执行 CI 任务的程序）怎么安装、注册、日常维护、暂停、排错和卸载。为什么这样做见 [ADR 0160](../adr/0160-self-hosted-runner-on-hermes.md) 和 [ADR 0164](../adr/0164-two-runners-on-hermes.md)。

<a id="contents"></a>

## 阅读导航

- [Scope](#scope)：管什么、不管什么，以及各部分放在哪里
- [Authoritative Sources](#authoritative-sources)
- [Safety and Preconditions](#safety-and-preconditions)：权限、令牌、共享主机的规矩
- [Live-State Preflight](#live-state-preflight)：动手前的只读检查
- [Procedure](#procedure)：安装、注册、暂停和恢复、日常维护
- [Verification](#verification)
- [Evidence](#evidence)
- [Rollback](#rollback)：只卸第 2 个 runner，或全部卸载
- [Stop Conditions](#stop-conditions)
- [Troubleshooting](#troubleshooting)

<a id="scope"></a>

## Scope

- **管的范围**：仓库 `sixianli/himawari-agent` 的两个自托管 runner，名字分别是 `hermes-home`（第 1 个）和 `hermes-home-2`（第 2 个），标签都是 `hermes-home`。`ci.yml` 和 `main.yml` 的任务派给其中空闲的一个。
- **不管的范围**：`quality.yml` 仍用 GitHub 托管的 `ubuntu-24.04`；macOS 的构建和测试已暂停（见 ADR 0160 的决定第 3 条）；Hermes 上其他服务、容器和数据一律不碰。

各部分的位置：

| 内容 | 位置 | 属主 |
| --- | --- | --- |
| runner 程序（版本 2.338.2）和工作目录 `_work`（Playwright 浏览器缓存在任务的检出目录里，见 `ci.yml` 的 `PLAYWRIGHT_BROWSERS_PATH`） | 第 1 个 `/srv/gh-runner/runner/`，第 2 个 `/srv/gh-runner-2/runner/` | 各自的账号 `gh-runner`、`gh-runner-2` |
| runner 的家目录 | `/srv/gh-runner/home/`、`/srv/gh-runner-2/home/` | 各自的账号 |
| 每个任务开始和结束时的磁盘记录 `disk.log` | `/srv/gh-runner/logs/`、`/srv/gh-runner-2/logs/` | 各自的账号 |
| 任务开始、结束钩子 | `/srv/gh-runner/hooks/`、`/srv/gh-runner-2/hooks/` | root，只读 |
| 每日清理脚本（两个 runner 都清） | `/srv/gh-runner/hooks/clean-old.sh` | root，只读 |
| 暂停、恢复脚本 | Mac 上的入口 `scripts/operations/hermes-runner/pause-runners.sh`、`resume-runners.sh`；它们每次把 `runners.sh`、`runner-pause.sh`、`runner-resume.sh` 传到 Hermes 的 `/home/andy/himawari-tests/hermes-runner/` 再运行。安装脚本会删掉旧的 `/srv/gh-runner/bin/` | andy |
| systemd 服务（Linux 管理后台服务的程序） | `/etc/systemd/system/gh-runner.service`、`gh-runner-2.service`（都由仓库里的模板 `gh-runner.service.in` 生成）、`gh-runners.slice`、`gh-runner-nft.service`、`gh-runner-clean.service`、`gh-runner-clean.timer` | root |
| 安装前的备份 | `/var/backups/gh-runner/<时间>/` | root |
| 防火墙规则 | `/etc/gh-runner/nft.rules`，加载后是 nftables（Linux 自带的防火墙）里的表 `inet gh_runner` | root |
| andy 启停 runner 的窄 sudo 规则 | `/etc/sudoers.d/91-gh-runner-control` | root |
| 仓库里的源文件 | [scripts/operations/hermes-runner/](../../scripts/operations/hermes-runner/) | — |

身份和限额（写在服务模板 `gh-runner.service.in` 和 `gh-runners.slice` 里）：

- 每个 runner 一个系统用户（`gh-runner`、`gh-runner-2`），不能登录，只属于自己的组，不在 sudo 组或 docker 组里。
- `ProtectHome=yes` 和 `InaccessiblePaths=/data` 让它看不到 `/home`（包括 andy 的 SSH 密钥）和 `/data`（Hermes 的密钥和其他项目的数据），也碰不到 Docker 的控制接口；`ProtectSystem=strict` 让它只能写自己的三个目录；每个服务还藏起另一个 runner 的目录（`InaccessiblePaths=-/srv/gh-runner-2` 或 `-/srv/gh-runner`）。
- `ProtectProc=invisible` 让它在 `/proc` 里只看得到自己的进程，看不到 Hermes 上其他服务的进程和命令行参数。
- 防火墙规则只对两个 runner 账号生效（一条规则同时匹配两个账号的 uid）：拒绝它访问局域网和 Tailscale 地址（`10/8`、`100.64/10`、`172.16/12`、`192.168/16` 等），以及本机 TCP 端口名单里的端口（DNS 的 53 端口除外）。名单在每次生成规则时取当时在监听的端口，再加上上一份规则里已有的端口，所以某个服务恰好停着时它的端口也不会从名单里掉出去。访问互联网不受影响。防火墙不管 UDP 和本机的 Unix 套接字（同一台机器上进程之间通信用的文件形式的接口）：Unix 套接字靠文件权限挡住，Docker 的控制接口另外被藏起来；2026-11-05 核对时 Hermes 本机只有 DNS 的 53 端口在监听 UDP，Hermes 的所有网卡地址都是私有地址，已在拒绝范围内。
- 同一个 runner 上的所有任务都以同一个账号运行，所以一个任务能读到这个 runner 自己的注册凭证，也能改 runner 的安装文件和后面任务的残留。仓库是私有的，只有 Andy 和他自己的代理线程会推送，所以接受这一点。怀疑 runner 被改过时，按 [Rollback](#rollback) 完整卸载后重新安装、注册；只重新运行安装脚本不会重新解压 runner。
- 每个 runner 的 CPU 最多两个核（`CPUQuota=200%`），内存最多 7 GB（`MemoryHigh=6G`、`MemoryMax=7G`），不用交换分区，最多 2048 个进程。两个服务都放在 `gh-runners.slice`（把几个服务放进同一个资源分组、一起设上限的单元）里，合计 CPU 最多三个核（`CPUQuota=300%`），内存最多 9 GB（`MemoryHigh=8G`、`MemoryMax=9G`，[ADR 0170](../adr/0170-more-memory-for-hermes-runners.md)），最多 4096 个进程。slice 上的 `CPUWeight=20`、`IOWeight=20` 和服务的 `Nice=10` 让 Hermes 上的其他服务优先。
- 每个任务开始前检查 runner 目录所在磁盘（就是根盘）的可用空间，低于 16 GiB（两个任务可能同时占盘）或读不出数字时都拒绝这个任务；任务结束后删除它的检出和 `_work/_temp`；每天的定时清理删除三天前的 `_work` 残留和 14 天前的 runner 诊断日志，哪个 runner 有任务在跑就跳过它，查不出有没有任务时也跳过并以退出码 1 结束。

[↑ 返回阅读导航](#contents)

<a id="authoritative-sources"></a>

## Authoritative Sources

- 决定和理由：[SOURCE: docs/adr/0160-self-hosted-runner-on-hermes.md]、[SOURCE: docs/adr/0164-two-runners-on-hermes.md]、[SOURCE: docs/adr/0168-longer-ci-job-limits-on-hermes.md]、[SOURCE: docs/adr/0169-pause-runners-by-removing-the-label.md]、[SOURCE: docs/adr/0170-more-memory-for-hermes-runners.md]
- 测试主机的硬边界：[测试主机与生产主机](../../.agents/instructions/test-and-production-hosts.md)
- 安装、注册、卸载、暂停和恢复的脚本，以及服务和钩子的原文：[scripts/operations/hermes-runner/](../../scripts/operations/hermes-runner/)
- 哪些任务跑在 runner 上：`ci/policy.json`、`.github/workflows/ci.yml`、`.github/workflows/main.yml`
- GitHub 官方文档：[About self-hosted runners](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/about-self-hosted-runners)
- runner 自带的服务模板 `/srv/gh-runner/runner/bin/actions.runner.service.template`：启动命令用 `runsvc.sh`、停止信号用 `SIGTERM`，本手册的服务与它一致

[↑ 返回阅读导航](#contents)

<a id="safety-and-preconditions"></a>

## Safety and Preconditions

- **sudo**：安装、注册、卸载和修改服务都要 root。代理没有长期 sudo；需要时先问 Andy，由 Andy 在 Hermes 上运行 `sudo bash grant-temp-sudo.sh <分钟数>`（1 到 120 分钟）。脚本写入临时规则 `/etc/sudoers.d/90-claude-temp`，并装一个 systemd 定时器，到点删除这条规则；关机错过时间的，开机后立即补删。代理不得延长或重新授予。到点只会删掉这一条规则：临时授权期间以 root 做过的任何改动（包括再装一条 sudo 规则）都会保留，所以授权期间只做 Andy 同意的那几步，结束后用 `sudo -l` 和 `ls /etc/sudoers.d/` 确认只剩 `91-gh-runner-control`。想提前收回，运行 `sudo rm -f /etc/sudoers.d/90-claude-temp`。
- **长期保留的窄规则**：andy 免密只能对 `gh-runner.service` 和 `gh-runner-2.service` 执行 `systemctl start|stop|restart`，暂停和恢复只用到它们。规则由安装脚本按现存的 runner 账号生成。
- **注册令牌**：注册令牌（GitHub 发的一次性注册密码，一小时内有效）每个 runner 单独生成一个，只能通过标准输入交给 `register-runner.sh`，脚本把它放进环境变量 `ACTIONS_RUNNER_INPUT_TOKEN` 交给 runner 的配置程序。令牌不得出现在命令行参数、文件、日志或提交里；注册完检查日志里没有令牌样的字符串后删除日志。
- **共享主机**：不清理、修改或重启任何不属于 runner 的容器、镜像、服务或数据；磁盘不够时先报告，不自行删除。
- **Docker**：runner 用户不得加入 docker 组。哪个 workflow 真要 Docker，先向 Andy 说明风险和替代方案，由 Andy 决定。
- **受保护测试**：Hermes 上受保护的第 3、4 层测试或出上线包期间不能有 CI 任务在跑，开始前按[暂停和恢复](#pause-and-resume)停掉 runner。
- **第一个改动目标的动作**：安装时创建 runner 用户。它和本手册所有写入 root 目录的步骤一样，属于 `critical`（共享主机、安全边界）：每次动手前要向 Andy 说明具体对象、动作和影响，并取得授权。

[↑ 返回阅读导航](#contents)

<a id="live-state-preflight"></a>

## Live-State Preflight

所有 Hermes 命令都通过 `.ci-output/handoff/scripts/hermes-ssh.sh '<命令>'` 执行。下面全是只读命令，有一项对不上就停下：

1. 主机名是 `hermes-home`：`hostname`。
2. 根盘可用空间：`df -B1 --output=avail /`。低于 16 GiB 时 runner 会拒绝任务，先报告。
3. 服务状态：`systemctl is-active gh-runner.service gh-runner-2.service gh-runner-nft.service gh-runner-clean.timer`，四个都应是 `active`。
4. 用户没有多余的组：`id gh-runner`、`id gh-runner-2` 各自只列出自己的一个组。
5. 防火墙表在：`sudo -n nft list table inet gh_runner` 需要 root；没有 sudo 时用 `systemctl is-active gh-runner-nft.service` 代替。
6. 限额生效：`systemctl show gh-runner.service gh-runner-2.service -p Slice -p MemoryMax -p CPUQuotaPerSecUSec -p ExecStart`，两个都应为 `Slice=gh-runners.slice`、`MemoryMax=7516192768`、`CPUQuotaPerSecUSec=2s`，启动命令分别是 `/srv/gh-runner/runner/bin/runsvc.sh` 和 `/srv/gh-runner-2/runner/bin/runsvc.sh`；`systemctl show gh-runners.slice -p MemoryMax -p CPUQuotaPerSecUSec -p CPUWeight -p IOWeight` 应为 `MemoryMax=6442450944`、`CPUQuotaPerSecUSec=3s`、`CPUWeight=20`、`IOWeight=20`。
7. GitHub 上的状态（在 Mac 上运行）：`gh api repos/sixianli/himawari-agent/actions/runners --jq '.runners[]|{id,name,status,busy}'`，应看到 `hermes-home` 和 `hermes-home-2` 都为 `online`。
8. 有没有任务在跑：`pgrep -u gh-runner -x Runner.Worker; pgrep -u gh-runner-2 -x Runner.Worker`，有输出就是有任务。

[↑ 返回阅读导航](#contents)

<a id="procedure"></a>

## Procedure

<a id="install"></a>

### 安装

1. 把 `scripts/operations/hermes-runner/` 下的全部文件（包括 `runners.sh` 和 `gh-runner.service.in`）用 `.ci-output/handoff/scripts/hermes-upload.sh` 传到 Hermes 的 `/home/andy/himawari-tests/hermes-runner/`。
2. 取得临时 sudo（见 [Safety and Preconditions](#safety-and-preconditions)）。
3. 有 runner 服务在运行时安装脚本以退出码 70 拒绝，所以先按[暂停和恢复](#pause-and-resume)在 Mac 上运行 `pause-runners.sh`。
4. `sudo -n bash /home/andy/himawari-tests/hermes-runner/install-runner.sh`。脚本会：确认主机名是 `hermes-home`（否则以退出码 68 拒绝）；把要改动的服务文件、slice、`/etc/gh-runner/`、窄 sudo 规则、`/srv/gh-runner/bin/` 和两个 runner 的 `hooks/` 目录复制到 `/var/backups/gh-runner/<时间>/`，并记下哪些原来不存在；之后任何一步失败或脚本被中断（`Ctrl-C`、`TERM`、`HUP`），都会把原有的放回（先复制到旁边再换上，复制失败时原文件不动）、把这次新建的删掉，这次新建的用户（先结束它的进程）、组和这次新建的目录（包括原来就有的 runner 目录下新建的 `home/`、`logs/`）也一并删掉，撤销这次新启用的开机启动，重新加载防火墙规则，并打印 `INSTALL_FAILED`；有放不回去的会打印 `RESTORE_INCOMPLETE`，列出是哪几项，并指出备份目录，这时照备份目录手动放回；建 `gh-runner` 和 `gh-runner-2` 两个用户（已有额外组时以退出码 67 拒绝；已有这个用户但没有它的 `runner` 目录时以退出码 69 拒绝，不接管不是它建的账号），建两个 runner 的目录，没装过 runner 的下载 2.338.2 并核对 SHA-256，装钩子、slice 和服务（两个服务都由模板生成），删掉旧的暂停脚本目录 `/srv/gh-runner/bin/`，按端口名单和现存的 runner 账号生成防火墙规则并先用 `nft -c` 检查，生成窄 sudo 规则，加载防火墙规则，启用防火墙服务和每日清理定时器。成功时打印 `INSTALL_OK`，同时打印 runner 账号的 uid、拦住的本机端口和备份目录。
5. 在 Mac 上运行 `resume-runners.sh`，已注册的 runner 按新的服务设置启动。新装的第 2 个 runner 还没注册，要先按[注册](#register)注册。

<a id="register"></a>

### 注册

1. 在 Mac 上用 `gh api -X POST repos/sixianli/himawari-agent/actions/runners/registration-token --jq .token` 取令牌，通过管道直接交给 Hermes 上的 `sudo -n bash register-runner.sh <1|2>` 的标准输入；令牌不落盘、不进参数。注册两个 runner 时每次单独取一个令牌。
2. 脚本先确认主机名是 `hermes-home`、装了 `python3`、以 root 运行；没写注册第几个 runner 时以退出码 64 拒绝（免得 `--replace` 把现有的 `hermes-home` 换掉），标准输入里没有令牌时也以退出码 64 拒绝。再确认这个 runner 版本会读 `ACTIONS_RUNNER_INPUT_TOKEN`（否则拒绝，以免令牌只能放进命令行），然后以对应账号注册：第 1 个名字是 `hermes-home`，第 2 个是 `hermes-home-2`，标签都是 `hermes-home`。最后启用并启动对应的服务。成功时打印 `REGISTER_OK`。

<a id="pause-and-resume"></a>

### 暂停和恢复

两个入口都在 Andy 的 Mac 上、从仓库根目录运行，用 Andy 已登录的 `gh` 改 runner 标签，用 `.ci-output/handoff/scripts/hermes-ssh.sh` 和 `hermes-upload.sh` 操作 Hermes。Hermes 上不放任何 GitHub 凭证。两个入口共用一把锁（`.ci-output/hermes-runner-pause.lock` 目录），同时只能跑一个，否则以退出码 75 打印 `RUNNER_LOCKED`；进程被强杀留下的锁目录要手动删掉。做法和理由见 [ADR 0169](../adr/0169-pause-runners-by-removing-the-label.md)。

- 暂停：`scripts/operations/hermes-runner/pause-runners.sh`。暂停可能要等到最长任务的时限（`ci/policy.json` 里最大的 `timeoutMinutes`）加 5 分钟，代理要在后台运行它。
  1. 把 Hermes 上的脚本传过去，读 Hermes 上装了哪几个 runner，和 GitHub 上的 runner 对账：Hermes 上的每个 runner 在 GitHub 上必须恰好有一个同名的，GitHub 上带 `hermes-home` 标签的 runner 也必须都装在 Hermes 上。对不上就打印 `RUNNER_PAUSE_FAILED` 和原因，什么都不改。
  2. 去掉这些 runner 的 `hermes-home` 标签，再读一遍确认真的去掉了。有一个没去掉，就把已经去掉的加回去，打印 `RUNNER_PAUSE_FAILED`，不碰 Hermes。都去掉后打印 `RUNNER_LABELS_REMOVED`：从这时起 GitHub 不再给它们派新任务，新任务在 GitHub 上排队。
  3. 每 30 秒查一次 GitHub：两个 runner 都显示 `busy=false` 时，在 Hermes 上运行 `runner-pause.sh --labels-removed 90`。它连续观察 90 秒，期间每 10 秒查一次本机有没有 `Runner.Worker`，一直没有才停两个服务，打印 `RUNNER_PAUSED`；中途看到任务就打印 `RUNNER_STILL_BUSY`，以退出码 2 结束、不停服务，Mac 侧接着等。
  4. 成功时打印 `RUNNER_PAUSED labels=removed services=stopped`。
  5. 到了等待上限还有任务，打印 `RUNNER_PAUSE_INCOMPLETE labels=removed services=running`，以退出码 2 结束；Hermes 那一步出错时同样打印这一行，以退出码 1 结束。这时标签保持去掉、服务继续跑完手上的任务，不会再接新任务；重新运行 `pause-runners.sh` 即可，或运行 `resume-runners.sh` 撤销。
- 恢复：`scripts/operations/hermes-runner/resume-runners.sh`。它先在 Hermes 上运行 `runner-resume.sh`，只启动已注册（服务已启用）的 runner；再等 GitHub 显示它们 `online`（最多 5 分钟），最后把 `hermes-home` 标签加回去并读一遍确认，打印 `RUNNER_RESUMED labels=restored`。服务没起来时打印 `RUNNER_RESUME_FAILED`，不加标签；5 分钟内没上线打印 `RUNNER_RESUME_INCOMPLETE services=running labels=removed`；标签没加上打印 `RUNNER_RESUME_INCOMPLETE` 和是哪个 runner。这几种情况下排队的任务都继续排队，不会失败，处理后重新运行即可。2026-11-05 实测：恢复后排队的任务约 3.5 分钟才开始跑，两个 runner 同一秒接到任务，原因在 GitHub 一侧、没有确认，等几分钟即可，不要因此重启 runner。
- 暂停期间新的 CI 任务在 GitHub 上排队；**排队超过 24 小时的任务会被 GitHub 判为失败**，所以暂停不要超过一天。GitHub 大约 1 分钟后才把停掉的 runner 显示为 `offline`。
- 暂停期间 Hermes 重启：服务会自己起来，但标签还是去掉的，不会接任务；之后照常运行 `resume-runners.sh`。不要在暂停期间重新注册 runner（`config.sh --replace` 会重置标签）。
- 受保护的第 3、4 层测试正在跑时，`hermes-ssh.sh` 只放行只读命令，这时暂停或恢复都做不了，要等那次运行结束。
- `runner-pause.sh` 不带 `--labels-removed` 时以退出码 64 拒绝：直接在 Hermes 上停服务会让 GitHub 在停之前的空档里派来的任务被取消。
- GitHub 文档写明，它不能保证常驻 runner 停机时绝对不被派任务（[Self-hosted runners reference](https://docs.github.com/en/actions/reference/runners/self-hosted-runners)）。去掉标签再观察 90 秒，把这个空档压到很小，但不是零。

<a id="routine-maintenance"></a>

### 日常维护

- **磁盘**：看两个 runner 各自的 `logs/disk.log`，每个任务记一行开始时的可用空间，一行结束时 `_work` 的大小和可用空间。
- **runner 升级**：runner 会自己升级到 GitHub 要求的版本（它的目录归各自的 runner 账号所有，所以能写）。要换安装脚本里固定的版本时，改 `install-runner.sh` 里的 `VERSION` 和 `SHA256`，SHA-256 从 GitHub 的发布页核对。
- **本机新增了服务**：防火墙只挡端口名单里的端口。之后新开的本机服务端口不在名单里，要刷新规则：先按[暂停和恢复](#pause-and-resume)在 Mac 上运行 `pause-runners.sh`（有 runner 服务在运行时安装脚本以退出码 70 拒绝），再重新运行 `install-runner.sh`（脚本可重复运行，不会重新下载或重建用户，最后会重新加载防火墙规则），最后运行 `resume-runners.sh`。
- **防火墙表被清掉**：如果有人重启了系统的 `nftables` 服务，而 `/etc/nftables.conf` 里有 `flush ruleset`，表 `inet gh_runner` 会被一并清掉。用 `sudo systemctl restart gh-runner-nft.service gh-runner.service gh-runner-2.service` 恢复。
- **重启服务**：`sudo -n /usr/bin/systemctl restart gh-runner.service`（第 2 个是 `gh-runner-2.service`）。runner 会先向 GitHub 注销会话再退出，几秒后重新在线。

[↑ 返回阅读导航](#contents)

<a id="verification"></a>

## Verification

- GitHub 接口显示 `hermes-home` 和 `hermes-home-2` 都为 `online`，空闲时 `busy` 为 `false`，标签有 `self-hosted`、`Linux`、`X64`、`hermes-home`。
- `journalctl -u gh-runner.service` 和 `journalctl -u gh-runner-2.service` 最近都出现 `Listening for Jobs`，之后没有 `Conflict`。
- 分别以 `gh-runner` 和 `gh-runner-2` 身份读 `/data` 下的文件、`/home/andy/.ssh`、Docker 控制接口、另一个 runner 的目录都被拒绝；访问本机已有服务的端口和 Tailscale 地址被拒绝；访问 `https://api.github.com` 正常。
- PR 的 `ci/required` 在这两个 runner 上运行并通过，任务日志开头的 `Runner name` 是 `hermes-home` 或 `hermes-home-2`。

[↑ 返回阅读导航](#contents)

<a id="evidence"></a>

## Evidence

- 证据放在 Hermes 的 `/data/hermes/himawari/tool-audit-round2/hermes-runner/<运行编号>/`，每次操作一个新编号，编号用 JST 时间，例如 `20261104-1013`。
- 记录：预检输出、执行的命令和退出码、验证结果、是否回退、结论。
- 不记录注册令牌或任何密钥；日志里出现令牌样的字符串时，先删掉那份日志再继续。

[↑ 返回阅读导航](#contents)

<a id="rollback"></a>

## Rollback

触发条件：runner 影响到 Hermes 上的其他服务或受保护测试，或者 Andy 决定不再用它；或者第 2 个 runner 的一周试跑不达标（标准见 ADR 0164 决定第 8 条）。

**只卸第 2 个 runner**：

1. 取得临时 sudo，先在 Mac 上运行 `pause-runners.sh`，再在 Hermes 上运行 `sudo -n bash /home/andy/himawari-tests/hermes-runner/uninstall-runner.sh 2`。它停掉并删除 `gh-runner-2.service`、结束 `gh-runner-2` 的进程、删除 `/srv/gh-runner-2/`、删除 `gh-runner-2` 用户和组，再按剩下的第 1 个 runner 重新生成防火墙规则和窄 sudo 规则（端口名单沿用上一份规则里的端口，再加上当时在监听的）。第 1 个 runner 的服务、目录、账号不动。全部删干净才打印 `UNINSTALL_OK`；还有残留时打印 `UNINSTALL_INCOMPLETE` 和残留清单，并以退出码 1 结束。
2. 在 Mac 上运行 `resume-runners.sh` 启动第 1 个 runner 并加回它的标签。
3. 在 Mac 上从 GitHub 删除 `hermes-home-2`：先用 `gh api repos/sixianli/himawari-agent/actions/runners --jq '.runners[]|{id,name}'` 查到编号，再运行 `gh api -X DELETE repos/sixianli/himawari-agent/actions/runners/<编号>`。
4. 验证：`id gh-runner-2` 报用户不存在，`/srv/gh-runner-2` 不存在，`sudo -n nft list table inet gh_runner` 的规则里只剩 `gh-runner` 的 uid，`hermes-home` 仍为 `online`。

**全部卸载**：

1. 在 Mac 上先把 workflow 改回托管机器（还原把 `runs-on` 改成 `hermes-home` 的那次提交），或者按 ADR 0092 的办法关掉 Actions，免得任务排队等不存在的 runner。
2. 取得临时 sudo，在 Hermes 上运行 `sudo -n bash /home/andy/himawari-tests/hermes-runner/uninstall-runner.sh all`。它停掉并删除两个 runner 的服务、slice、防火墙服务和每日清理，删除防火墙表和 `/etc/gh-runner/`、删除窄 sudo 规则，结束两个账号的进程，删除 `/srv/gh-runner/` 和 `/srv/gh-runner-2/`，再删除两个用户和组。最后逐项核对：全部删干净才打印 `UNINSTALL_OK`；还有残留时打印 `UNINSTALL_INCOMPLETE` 和残留清单，并以退出码 1 结束，按清单手动处理后再运行一次。缺 `nft` 命令时以退出码 66 拒绝，因为删不掉也查不了防火墙表。
3. 在 Mac 上按上面第 3 步从 GitHub 删除 `hermes-home` 和 `hermes-home-2`。
4. 验证：`id gh-runner`、`id gh-runner-2` 都报用户不存在，`/srv/gh-runner`、`/srv/gh-runner-2` 都不存在，`nft list tables` 里没有 `gh_runner`，GitHub 的 runner 列表里没有这两个 runner，Hermes 上其他服务的状态和端口与卸载前一样。

不传参数时卸载脚本以退出码 64 拒绝，不删任何东西。

[↑ 返回阅读导航](#contents)

<a id="stop-conditions"></a>

## Stop Conditions

- 主机名不是 `hermes-home`。
- 根盘可用空间低于 16 GiB，或者需要删除不属于 runner 的东西才能腾出空间。
- 需要 sudo 而 Andy 没有授权，或者临时授权已到期。
- 某个 workflow 需要 Docker、需要访问 `/data` 或本机服务。
- `gh-runner` 或 `gh-runner-2` 出现了自己以外的组。
- Hermes 上其他服务的状态、端口或容器重启次数在操作后发生变化。
- 注册令牌出现在命令行、文件或日志里。

[↑ 返回阅读导航](#contents)

<a id="troubleshooting"></a>

## Troubleshooting

| 现象 | 安全的诊断 | 处理 |
| --- | --- | --- |
| 日志反复出现 `A session for this runner already exists` 和 `Conflict` | `journalctl -u gh-runner.service --since -10min`（第 2 个看 `gh-runner-2.service`） | runner 上次没来得及注销会话（例如进程被强杀）。GitHub 端的旧会话约 2 到 3 分钟后过期，runner 会自己重连，不用处理。正常重启也出现时，检查服务的启动命令是不是 `bin/runsvc.sh`、停止信号是不是 `SIGTERM`。 |
| GitHub 显示 `offline` | Preflight 第 3、7 项；对应服务的 `journalctl -u` | 服务停着就在 Mac 上运行 `resume-runners.sh`；服务在跑但连不上，看日志里的网络错误，Hermes 断网时只能等。 |
| 任务报 `below the 16 GiB floor; job refused` | `df -h /`；两个 runner 的 `disk.log` 末尾几行 | 先报告 Andy；只能清 `/srv/gh-runner/runner/_work`、`/srv/gh-runner-2/runner/_work` 下没有任务在用的旧目录，其他东西不删。 |
| 任务访问本机服务或局域网地址失败 | `sudo -n nft list table inet gh_runner` | 防火墙按设计拒绝。确实需要时先问 Andy，不自行放开。 |
| 任务装浏览器时要 root | 看是否用了 `playwright install --with-deps` | Hermes 上浏览器依赖已装好，workflow 里去掉 `--with-deps`。 |
| `gh-runner-nft.service` 失败，runner 服务起不来 | `systemctl status gh-runner-nft.service`；`sudo -n nft -c -f /etc/gh-runner/nft.rules` | 规则文件坏了就重新运行 `install-runner.sh` 生成。 |
| 安装脚本以退出码 70 拒绝 | 输出里点名的服务 | 有 runner 服务在运行；先在 Mac 上运行 `pause-runners.sh`，装完再 `resume-runners.sh`。 |
| 两个任务同时跑时任务被系统杀掉或测试变慢、超时 | `cat /sys/fs/cgroup/gh.slice/gh-runners.slice/memory.events`（systemd 按名字里的 `-` 把它放在 `gh.slice` 下面） 看 `oom_kill`；`systemctl show gh-runners.slice -p MemoryCurrent` | 合计 6 GB 不够用的迹象。记录下来报告 Andy，按 ADR 0164 决定第 8 条判断是否卸掉第 2 个 runner；不自行调高上限。 |

[↑ 返回阅读导航](#contents)
