---
status: active
document_type: runbook
execution_risk: critical
contract_sha256: "sha256:420dc65c29627b726fed2aa276a4e03b7ecd3a6f01aa0baef2ea28fa32bb97a7"
supersedes: ""
superseded_by: ""
date: "2026-11-04"
---

# Hermes 自托管 runner Runbook

<!-- runbook-contract:
- scripts/operations/hermes-runner
-->

本手册说明 Hermes（家里的 Linux 服务器，Ubuntu 22.04，主机名 `hermes-home`）上那台 GitHub 自托管 runner（装在自己机器上、替 GitHub 执行 CI 任务的程序）怎么安装、注册、日常维护、暂停、排错和完整卸载。为什么这样做见 [ADR 0160](../adr/0160-self-hosted-runner-on-hermes.md)。

<a id="contents"></a>

## 阅读导航

- [Scope](#scope)：管什么、不管什么，以及各部分放在哪里
- [Authoritative Sources](#authoritative-sources)
- [Safety and Preconditions](#safety-and-preconditions)：权限、令牌、共享主机的规矩
- [Live-State Preflight](#live-state-preflight)：动手前的只读检查
- [Procedure](#procedure)：安装、注册、暂停和恢复、日常维护
- [Verification](#verification)
- [Evidence](#evidence)
- [Rollback](#rollback)：完整卸载
- [Stop Conditions](#stop-conditions)
- [Troubleshooting](#troubleshooting)

<a id="scope"></a>

## Scope

- **管的范围**：仓库 `sixianli/himawari-agent` 唯一的自托管 runner，名字和标签都是 `hermes-home`，`ci.yml` 和 `main.yml` 的所有任务都跑在它上面。
- **不管的范围**：`quality.yml` 仍用 GitHub 托管的 `ubuntu-24.04`；macOS 的构建和测试已暂停（见 ADR 0160 的决定第 3 条）；Hermes 上其他服务、容器和数据一律不碰。

各部分的位置：

| 内容 | 位置 | 属主 |
| --- | --- | --- |
| runner 程序（版本 2.338.2）和工作目录 `_work` | `/srv/gh-runner/runner/` | `gh-runner` |
| runner 的家目录（Playwright 浏览器缓存在这里） | `/srv/gh-runner/home/` | `gh-runner` |
| 每个任务开始和结束时的磁盘记录 `disk.log` | `/srv/gh-runner/logs/` | `gh-runner` |
| 任务开始、结束钩子和每日清理脚本 | `/srv/gh-runner/hooks/` | root，只读 |
| 暂停、恢复脚本 | `/srv/gh-runner/bin/` | root，只读 |
| systemd 服务（Linux 管理后台服务的程序） | `/etc/systemd/system/gh-runner.service`、`gh-runner-nft.service`、`gh-runner-clean.service`、`gh-runner-clean.timer` | root |
| 防火墙规则 | `/etc/gh-runner/nft.rules`，加载后是 nftables（Linux 自带的防火墙）里的表 `inet gh_runner` | root |
| andy 启停 runner 的窄 sudo 规则 | `/etc/sudoers.d/91-gh-runner-control` | root |
| 仓库里的源文件 | [scripts/operations/hermes-runner/](../../scripts/operations/hermes-runner/) | — |

身份和限额（写在 `gh-runner.service` 里）：

- 系统用户 `gh-runner`，不能登录，只属于自己的组，不在 sudo 组或 docker 组里。
- `ProtectHome=yes` 和 `InaccessiblePaths=/data` 让它看不到 `/home`（包括 andy 的 SSH 密钥）和 `/data`（Hermes 的密钥和其他项目的数据），也碰不到 Docker 的控制接口；`ProtectSystem=strict` 让它只能写自己的三个目录。
- `ProtectProc=invisible` 让它在 `/proc` 里只看得到自己的进程，看不到 Hermes 上其他服务的进程和命令行参数。
- 防火墙规则只对 `gh-runner` 这个用户生效：拒绝它访问局域网和 Tailscale 地址（`10/8`、`100.64/10`、`172.16/12`、`192.168/16` 等），以及本机在最近一次运行安装脚本时已经在监听的 TCP 端口（DNS 的 53 端口除外）。访问互联网不受影响。防火墙不管 UDP 和本机的 Unix 套接字（同一台机器上进程之间通信用的文件形式的接口）：Unix 套接字靠文件权限挡住，Docker 的控制接口另外被藏起来；2026-11-05 核对时 Hermes 本机只有 DNS 的 53 端口在监听 UDP，Hermes 的所有网卡地址都是私有地址，已在拒绝范围内。
- 所有任务都以同一个 `gh-runner` 用户运行，所以一个任务能读到 runner 自己的注册凭证，也能改 runner 的安装文件和后面任务的残留。仓库是私有的，只有 Andy 和他自己的代理线程会推送，所以接受这一点。怀疑 runner 被改过时，按 [Rollback](#rollback) 完整卸载后重新安装、注册；只重新运行安装脚本不会重新解压 runner。
- CPU 最多两个核（`CPUQuota=200%`），内存最多 5 GB，不用交换分区，最多 2048 个进程；`Nice=10`、`CPUWeight=20`、`IOWeight=20` 让 Hermes 上的其他服务优先。
- 每个任务开始前检查 runner 目录所在磁盘（就是根盘）的可用空间，低于 8 GiB 或读不出数字时都拒绝这个任务；任务结束后删除它的检出和 `_work/_temp`；每天的定时清理删除三天前的 `_work` 残留和 14 天前的 runner 诊断日志，有任务在跑时跳过。

[↑ 返回阅读导航](#contents)

<a id="authoritative-sources"></a>

## Authoritative Sources

- 决定和理由：[SOURCE: docs/adr/0160-self-hosted-runner-on-hermes.md]
- 测试主机的硬边界：[测试主机与生产主机](../../.agents/instructions/test-and-production-hosts.md)
- 安装、注册、卸载、暂停和恢复的脚本，以及服务和钩子的原文：[scripts/operations/hermes-runner/](../../scripts/operations/hermes-runner/)
- 哪些任务跑在 runner 上：`ci/policy.json`、`.github/workflows/ci.yml`、`.github/workflows/main.yml`
- GitHub 官方文档：[About self-hosted runners](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/about-self-hosted-runners)
- runner 自带的服务模板 `/srv/gh-runner/runner/bin/actions.runner.service.template`：启动命令用 `runsvc.sh`、停止信号用 `SIGTERM`，本手册的服务与它一致

[↑ 返回阅读导航](#contents)

<a id="safety-and-preconditions"></a>

## Safety and Preconditions

- **sudo**：安装、注册、卸载和修改服务都要 root。代理没有长期 sudo；需要时先问 Andy，由 Andy 在 Hermes 上运行 `sudo bash grant-temp-sudo.sh <分钟数>`（1 到 120 分钟）。脚本写入临时规则 `/etc/sudoers.d/90-claude-temp`，并装一个 systemd 定时器，到点删除这条规则；关机错过时间的，开机后立即补删。代理不得延长或重新授予。到点只会删掉这一条规则：临时授权期间以 root 做过的任何改动（包括再装一条 sudo 规则）都会保留，所以授权期间只做 Andy 同意的那几步，结束后用 `sudo -l` 和 `ls /etc/sudoers.d/` 确认只剩 `91-gh-runner-control`。想提前收回，运行 `sudo rm -f /etc/sudoers.d/90-claude-temp`。
- **长期保留的窄规则**：andy 免密只能执行 `systemctl start|stop|restart gh-runner.service` 这三条命令，暂停和恢复只用到它们。
- **注册令牌**：注册令牌（GitHub 发的一次性注册密码，一小时内有效）只能通过标准输入交给 `register-runner.sh`，脚本把它放进环境变量 `ACTIONS_RUNNER_INPUT_TOKEN` 交给 runner 的配置程序。令牌不得出现在命令行参数、文件、日志或提交里；注册完检查日志里没有令牌样的字符串后删除日志。
- **共享主机**：不清理、修改或重启任何不属于 runner 的容器、镜像、服务或数据；磁盘不够时先报告，不自行删除。
- **Docker**：runner 用户不得加入 docker 组。哪个 workflow 真要 Docker，先向 Andy 说明风险和替代方案，由 Andy 决定。
- **受保护测试**：Hermes 上受保护的第 3、4 层测试或出上线包期间不能有 CI 任务在跑，开始前按[暂停和恢复](#pause-and-resume)停掉 runner。
- **第一个改动目标的动作**：安装时创建 `gh-runner` 用户。它和本手册所有写入 root 目录的步骤一样，属于 `critical`（共享主机、安全边界）：每次动手前要向 Andy 说明具体对象、动作和影响，并取得授权。

[↑ 返回阅读导航](#contents)

<a id="live-state-preflight"></a>

## Live-State Preflight

所有 Hermes 命令都通过 `.ci-output/handoff/scripts/hermes-ssh.sh '<命令>'` 执行。下面全是只读命令，有一项对不上就停下：

1. 主机名是 `hermes-home`：`hostname`。
2. 根盘可用空间：`df -B1 --output=avail /`。低于 8 GiB 时 runner 会拒绝任务，先报告。
3. 服务状态：`systemctl is-active gh-runner.service gh-runner-nft.service gh-runner-clean.timer`，三个都应是 `active`。
4. 用户没有多余的组：`id gh-runner` 只列出 `gh-runner` 一个组。
5. 防火墙表在：`sudo -n nft list table inet gh_runner` 需要 root；没有 sudo 时用 `systemctl is-active gh-runner-nft.service` 代替。
6. 限额生效：`systemctl show gh-runner.service -p MemoryMax -p CPUQuotaPerSecUSec -p ExecStart`，应为 `MemoryMax=5368709120`、`CPUQuotaPerSecUSec=2s`、启动命令是 `/srv/gh-runner/runner/bin/runsvc.sh`。
7. GitHub 上的状态（在 Mac 上运行）：`gh api repos/sixianli/himawari-agent/actions/runners --jq '.runners[]|{id,name,status,busy}'`，应看到 `hermes-home` 为 `online`。
8. 有没有任务在跑：`pgrep -u gh-runner -x Runner.Worker`，有输出就是有任务。

[↑ 返回阅读导航](#contents)

<a id="procedure"></a>

## Procedure

<a id="install"></a>

### 安装

1. 把 `scripts/operations/hermes-runner/` 下的文件用 `.ci-output/handoff/scripts/hermes-upload.sh` 传到 Hermes 的 `/home/andy/himawari-tests/hermes-runner/`。
2. 取得临时 sudo（见 [Safety and Preconditions](#safety-and-preconditions)）。
3. `sudo -n bash /home/andy/himawari-tests/hermes-runner/install-runner.sh`。脚本会：确认主机名是 `hermes-home`（否则以退出码 68 拒绝），建 `gh-runner` 用户（已有额外组时拒绝；已有这个用户但没有 `/srv/gh-runner/runner` 目录时以退出码 69 拒绝，不接管不是它建的账号），建 `/srv/gh-runner/` 下的目录，下载 runner 2.338.2 并核对 SHA-256，装钩子、脚本和服务，按当时在监听的端口生成防火墙规则并先用 `nft -c` 检查，装窄 sudo 规则，启用防火墙服务和每日清理定时器，最后重新加载一次防火墙规则（防火墙服务已经在运行时，启用它不会重读规则）。成功时打印 `INSTALL_OK`。改了 `gh-runner.service` 后，要按[暂停和恢复](#pause-and-resume)停一次再启动，新的服务设置才生效。

<a id="register"></a>

### 注册

1. 在 Mac 上用 `gh api -X POST repos/sixianli/himawari-agent/actions/runners/registration-token --jq .token` 取令牌，通过管道直接交给 Hermes 上的 `sudo -n bash register-runner.sh` 的标准输入；令牌不落盘、不进参数。
2. 脚本先确认主机名是 `hermes-home`、装了 `python3`，再确认这个 runner 版本会读 `ACTIONS_RUNNER_INPUT_TOKEN`（否则拒绝，以免令牌只能放进命令行），再以 `gh-runner` 身份注册，名字和标签都是 `hermes-home`，然后启动 `gh-runner.service`。成功时打印 `REGISTER_OK`。

<a id="pause-and-resume"></a>

### 暂停和恢复

- 暂停：`/srv/gh-runner/bin/runner-pause.sh [最多等待秒数，默认 3600]`。它先等正在跑的任务结束，再停服务，打印 `RUNNER_PAUSED`；等满时间任务还没结束，就打印 `RUNNER_BUSY_TIMEOUT` 并以退出码 2 结束，runner 保持运行。等待秒数只接受 1 到 86400 的整数，否则以退出码 64 拒绝，不碰服务。脚本确认没有任务到真正停服务之间有几秒空档：GitHub 恰好在这几秒里派来的任务会被停掉，在 GitHub 上显示为取消或失败，恢复后要重新运行那个任务。
- 恢复：`/srv/gh-runner/bin/runner-resume.sh`，打印 `RUNNER_RESUMED`。
- 暂停期间新的 CI 任务在 GitHub 上排队；GitHub 大约 1 分钟后才把 runner 显示为 `offline`。

<a id="routine-maintenance"></a>

### 日常维护

- **磁盘**：看 `/srv/gh-runner/logs/disk.log`，每个任务记一行开始时的可用空间，一行结束时 `_work` 的大小和可用空间。
- **runner 升级**：runner 会自己升级到 GitHub 要求的版本（它的目录归 `gh-runner` 所有，所以能写）。要换安装脚本里固定的版本时，改 `install-runner.sh` 里的 `VERSION` 和 `SHA256`，SHA-256 从 GitHub 的发布页核对。
- **本机新增了服务**：防火墙只挡安装时已在监听的端口。之后新开的本机服务端口不在名单里，要重新运行 `install-runner.sh` 刷新规则（脚本可重复运行，不会重新下载或重建用户，最后会重新加载防火墙规则）。
- **防火墙表被清掉**：如果有人重启了系统的 `nftables` 服务，而 `/etc/nftables.conf` 里有 `flush ruleset`，表 `inet gh_runner` 会被一并清掉。用 `sudo systemctl restart gh-runner-nft.service gh-runner.service` 恢复。
- **重启服务**：`sudo -n /usr/bin/systemctl restart gh-runner.service`。runner 会先向 GitHub 注销会话再退出，几秒后重新在线。

[↑ 返回阅读导航](#contents)

<a id="verification"></a>

## Verification

- GitHub 接口显示 `hermes-home` 为 `online`，空闲时 `busy` 为 `false`，标签有 `self-hosted`、`Linux`、`X64`、`hermes-home`。
- `journalctl -u gh-runner.service` 最近出现 `Listening for Jobs`，之后没有 `Conflict`。
- 以 `gh-runner` 身份读 `/data` 下的文件、`/home/andy/.ssh`、Docker 控制接口都被拒绝；访问本机已有服务的端口和 Tailscale 地址被拒绝；访问 `https://api.github.com` 正常。
- PR 的 `ci/required` 在 `hermes-home` 上运行并通过，任务日志开头的 `Runner name` 是 `hermes-home`。

[↑ 返回阅读导航](#contents)

<a id="evidence"></a>

## Evidence

- 证据放在 Hermes 的 `/data/hermes/himawari/tool-audit-round2/hermes-runner/<运行编号>/`，每次操作一个新编号，编号用 JST 时间，例如 `20261104-1013`。
- 记录：预检输出、执行的命令和退出码、验证结果、是否回退、结论。
- 不记录注册令牌或任何密钥；日志里出现令牌样的字符串时，先删掉那份日志再继续。

[↑ 返回阅读导航](#contents)

<a id="rollback"></a>

## Rollback

触发条件：runner 影响到 Hermes 上的其他服务或受保护测试，或者 Andy 决定不再用它。

1. 在 Mac 上先把 workflow 改回托管机器（还原把 `runs-on` 改成 `hermes-home` 的那次提交），或者按 ADR 0092 的办法关掉 Actions，免得任务排队等一台不存在的 runner。
2. 取得临时 sudo，在 Hermes 上运行 `sudo -n bash /home/andy/himawari-tests/hermes-runner/uninstall-runner.sh`。它停掉并删除四个服务、删除防火墙表和 `/etc/gh-runner/`、删除窄 sudo 规则、结束 `gh-runner` 的进程、删除 `/srv/gh-runner/`，再删除 `gh-runner` 用户和组。最后逐项核对这些东西都已不在：全部删干净才打印 `UNINSTALL_OK`；还有残留时打印 `UNINSTALL_INCOMPLETE` 和残留清单，并以退出码 1 结束，按清单手动处理后再运行一次。
3. 在 Mac 上从 GitHub 删除 runner：先用 `gh api repos/sixianli/himawari-agent/actions/runners --jq '.runners[]|{id,name}'` 查到编号，再运行 `gh api -X DELETE repos/sixianli/himawari-agent/actions/runners/<编号>`。
4. 验证：`id gh-runner` 报用户不存在，`/srv/gh-runner` 不存在，`nft list tables` 里没有 `gh_runner`，GitHub 的 runner 列表里没有 `hermes-home`，Hermes 上其他服务的状态和端口与卸载前一样。

[↑ 返回阅读导航](#contents)

<a id="stop-conditions"></a>

## Stop Conditions

- 主机名不是 `hermes-home`。
- 根盘可用空间低于 8 GiB，或者需要删除不属于 runner 的东西才能腾出空间。
- 需要 sudo 而 Andy 没有授权，或者临时授权已到期。
- 某个 workflow 需要 Docker、需要访问 `/data` 或本机服务。
- `gh-runner` 出现了 `gh-runner` 以外的组。
- Hermes 上其他服务的状态、端口或容器重启次数在操作后发生变化。
- 注册令牌出现在命令行、文件或日志里。

[↑ 返回阅读导航](#contents)

<a id="troubleshooting"></a>

## Troubleshooting

| 现象 | 安全的诊断 | 处理 |
| --- | --- | --- |
| 日志反复出现 `A session for this runner already exists` 和 `Conflict` | `journalctl -u gh-runner.service --since -10min` | runner 上次没来得及注销会话（例如进程被强杀）。GitHub 端的旧会话约 2 到 3 分钟后过期，runner 会自己重连，不用处理。正常重启也出现时，检查服务的启动命令是不是 `bin/runsvc.sh`、停止信号是不是 `SIGTERM`。 |
| GitHub 显示 `offline` | Preflight 第 3、7 项；`journalctl -u gh-runner.service` | 服务停着就 `runner-resume.sh`；服务在跑但连不上，看日志里的网络错误，Hermes 断网时只能等。 |
| 任务报 `below the 8 GiB floor; job refused` | `df -h /`；`disk.log` 末尾几行 | 先报告 Andy；只能清 `/srv/gh-runner/runner/_work` 下没有任务在用的旧目录，其他东西不删。 |
| 任务访问本机服务或局域网地址失败 | `sudo -n nft list table inet gh_runner` | 防火墙按设计拒绝。确实需要时先问 Andy，不自行放开。 |
| 任务装浏览器时要 root | 看是否用了 `playwright install --with-deps` | Hermes 上浏览器依赖已装好，workflow 里去掉 `--with-deps`。 |
| `gh-runner-nft.service` 失败，`gh-runner.service` 起不来 | `systemctl status gh-runner-nft.service`；`sudo -n nft -c -f /etc/gh-runner/nft.rules` | 规则文件坏了就重新运行 `install-runner.sh` 生成。 |

[↑ 返回阅读导航](#contents)
