---
status: active
document_type: runbook
execution_risk: critical
contract_sha256: "sha256:f361c193b5349520fd45a3aa82eaf70e569d4297fa2f609f6193f3752326b97d"
supersedes: ""
superseded_by: ""
date: "2026-10-28"
covers: ".claude/rules/owner-standing-rules.md, scripts/delivery-mode/deploy-preflight.py"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# 生产云服务器访问与系统更新 Runbook

<!-- runbook-contract:
- https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0056-cloud-server-also-test-host.md
- docs/backlog/BL-20261021-009-生-产-启-动-绑-定-精-确.md
- https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0099-production-host-firewall-ssh-only.md
-->

本手册记录用户怎样登录生产云服务器 `84.247.157.41`（主机商 Contabo 的虚拟服务器，主机名 `vmi3618928`，Ubuntu 24.04），以及服务器上为保护生产服务而锁定的内核和系统程序。起因是 2026-10-19 服务器重启进入自动安装的新内核后，生产服务的启动前检查因内核版本与安装回执不符而连续失败约 51 小时（[BL-20261021-009](../backlog/BL-20261021-009-生-产-启-动-绑-定-精-确.md)）。测试账号 `himawari-ci` 的用法不在这里，见[测试主机操作 Runbook](test-host-operations-runbook.md)。

## 阅读导航

- [适用范围](#scope)
- [权威来源](#authoritative-sources)
- [安全前提](#safety-and-preconditions)
- [目标现场只读检查](#live-state-preflight)
- [步骤](#procedure)
- [结果验证](#verification)
- [证据](#evidence)
- [回退](#rollback)
- [停止条件](#stop-conditions)
- [防火墙](#firewall)
- [Magpie 管理页](#magpie-admin)
- [心跳告警](#heartbeat)
- [排障](#troubleshooting)

<a id="scope"></a>

## Scope

- 适用：用户本人以管理员身份登录生产云服务器，查看生产服务状态和日志，处理启动失败，安排内核或系统程序更新。
- 不适用：Claude、opencode 和 Grok 都不以 `root` 或任何生产账号登录，不改 SSH 配置、启动设置或软件包状态；它们只用测试账号 `himawari-ci` 做只读查询（`AGENTS.md` 的 Test and Production Hosts）。生产部署按各次冻结操作包执行，不在本手册里。
- 目标：云服务器 `84.247.157.41` 上的 `root` 账号、`himawari-prod.service`、启动引导程序 GRUB 和软件包管理器 apt。

[返回导航](#阅读导航)

<a id="authoritative-sources"></a>

## Authoritative Sources

- 云服务器同时是生产主机和测试主机，测试账号的边界：[SOURCE: https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0056-cloud-server-also-test-host.md]
- 启动前检查绑定内核版本导致的停摆、根因确认和恢复记录：[SOURCE: docs/backlog/BL-20261021-009-生-产-启-动-绑-定-精-确.md]
- 启动前检查脚本 `cloud-protected-prepare.mjs` 和封存脚本 `cloud-seal.mjs` 在各次操作包的 `signing/` 目录（本地未提交的 `.ci-output/production/`）；第五次版本安装在服务器的 `/opt/himawari/operations/fifth-20261017/`。

[返回导航](#阅读导航)

<a id="safety-and-preconditions"></a>

## Safety and Preconditions

- **只接受密钥登录**。`/etc/ssh/sshd_config.d/00-key-only.conf`（2026-10-01 写入）和 `60-cloudimg-settings.conf` 都设了 `PasswordAuthentication no`，sshd_config 里 `root` 为 `PermitRootLogin prohibit-password`：任何账号都不能用密码经 SSH 登录，`root` 只能用密钥。这份设置由用户 2026-10-01 运行 ssh-key-only.sh 写入，当天已从外部验证只剩密钥一种登录方式（撤销脚本 revert-ssh-key-only.sh，两个脚本在本地未提交的 `.ci-output/cloud-test-host/`）。
- **管理员登录用 `root` 和用户 Mac 上已有的密钥**：`ssh root@84.247.157.41`。历次生产操作包的步骤脚本也用同一方式（`ssh -o BatchMode=yes ... root@84.247.157.41`，`BatchMode` 表示不弹出密码输入）。
- **不要用 Contabo 面板的 “Reset credentials”**，除非现有密钥确实失效：它重置默认用户（`root`）的凭据，可能替换而不是追加 `root` 的密钥列表，让操作包脚本用的密钥失效；也可能需要重启服务器。确需使用时选 “SSH-Key” 页，粘贴 Mac 上 `.pub` 公钥文件的一整行，绝不粘贴私钥。
- **启动前检查核对的系统状态**：内核版本（`os.release()`）必须与安装回执里封存时的版本完全相同；`/usr/bin/bwrap`、`/usr/bin/socat`、`/usr/bin/bash`、`/usr/bin/rg` 和 `bwrap` 的 AppArmor 配置文件的摘要必须不变。任何一项变化，服务启动前检查就失败，`systemd` 每 10 秒重试一次，且没有告警。
- **当前锁定状态（2026-10-22 起）**：GRUB 长期默认启动 `6.8.0-142-generic`（`GRUB_DEFAULT=saved`，`saved_entry` 指向 142）；`apt-mark hold` 了 `linux-virtual`、`linux-image-virtual`、`linux-headers-virtual`、`linux-image-6.8.0-142-generic`、`linux-modules-6.8.0-142-generic`、`bubblewrap`、`socat`、`bash`、`ripgrep`；`/etc/apt/apt.conf.d/52himawari-hold` 让自动更新排除 `^linux-`、`^bubblewrap$`、`^socat$`、`^bash$`、`^ripgrep$`。代价是这些软件暂时收不到安全补丁。
- **上线前检查会读重启后进哪个内核**：`scripts/delivery-mode/deploy-preflight.py` 的 `NEXT_BOOT_KERNEL_IS_RUNNING_KERNEL` 读 `/boot/grub/grub.cfg` 和 `/boot/grub/grubenv`（GRUB 的启动菜单和它保存的启动项），下一次重启（一次性的 `next_entry`）或之后每次重启（`saved_entry`）会启动的内核不是当前运行的内核、或者读不出来，就拦下这次上线；运行中的版本、服务和 GRUB 都不改。要改回时按下文[回滚](#rollback)一节，`grub-set-default` 写完整的带引号路径（子菜单标识、`>`、菜单项标识），例如 `grub-set-default 'gnulinux-advanced-<uuid>>gnulinux-6.8.0-142-generic-advanced-<uuid>'`。
- 不运行 `apt upgrade`、`apt full-upgrade` 或 `do-release-upgrade`：它们会绕过上面的排除名单改动受检查的程序，系统大版本升级还会让当前安装的验收全部失效。

[返回导航](#阅读导航)

<a id="live-state-preflight"></a>

## Live-State Preflight

以 `root` 登录后先只读记录：

1. `uname -r`：应为 `6.8.0-142-generic`。
2. `systemctl is-active himawari-prod.service` 和 `systemctl show -p NRestarts,ActiveEnterTimestamp himawari-prod.service`：服务应为 `active`，重启次数不再增加。
3. `grub-editenv list`：应只有 `saved_entry=...6.8.0-142-generic...`。
4. `apt-mark showhold` 和 `apt-config dump | grep -A8 Package-Blacklist`：应与[安全前提](#safety-and-preconditions)里的锁定清单一致。

测试账号 `himawari-ci` 也能只读看到第 1、2 项，但读不到服务日志（日志只对 `adm`、`systemd-journal` 组可见）。

[返回导航](#阅读导航)

<a id="procedure"></a>

## Procedure

1. **SSH 登录**：在 Mac 终端运行 `ssh root@84.247.157.41`。连不上时用 `ssh -v -o BatchMode=yes root@84.247.157.41 true 2>&1 | grep -E "Offering|identity file|Authenticated|denied"` 看 Mac 试了哪把密钥。
2. **控制台登录（SSH 不可用时）**：Contabo 面板的 “VNC Control” 显示 VNC 地址和端口（是主机商的机器，不是 `84.247.157.41`）。先 “Set password” 再点 “Confirm” 保存，等几分钟生效；VNC 传统密码只认前 8 个字符。在 Mac 上用 `nc -vz -w 5 <地址> <端口>` 确认端口已开，再 `open vnc://<地址>:<端口>`。macOS 自带的屏幕共享连不上时换第三方 VNC 客户端（需要用户自己下载）。控制台登录不经过 SSH，但账号必须设过密码。用完把 “VNC enabled” 关掉：VNC 不加密。
3. **看生产服务**：`systemctl status himawari-prod.service --no-pager -n 0`；日志 `journalctl -u himawari-prod.service -b --no-pager | tail -60`。启动成功时日志有 `installation-verified` 和 `Started himawari-prod.service`；启动前检查在刚开机时约需一分钟。
4. **启动前检查失败时**：先看日志里的 `AssertionError` 写的是哪一项（内核版本、`BWRAP_EXECUTABLE_CHANGED`、`SYSTEM_TOOL_CHANGED` 等），把输出交给 Claude 判断；不要改启动脚本跳过检查。内核版本不符时，按[回退](#rollback)回到已验收的内核。
5. **需要更新内核或受检查的程序时**：不要直接解除锁定。先由 Claude 准备“更新后重新验收并封存”的操作包，经审核、Hermes 演练、冻结后，用户授权执行；新版本的生产部署本身也会在当时的内核上重新封存。

[返回导航](#阅读导航)

<a id="verification"></a>

## Verification

- 登录：`ssh root@84.247.157.41 'hostname; uname -r'` 输出 `vmi3618928` 和 `6.8.0-142-generic`。
- 生产服务：`active`、`ActiveEnterTimestamp` 有时间、重启次数在几分钟内不再增加。
- 锁定状态：`apt-mark showhold` 列出 9 个包，`apt-config dump` 的排除名单有 5 条。

[返回导航](#阅读导航)

<a id="evidence"></a>

## Evidence

- 2026-10-21/22 停摆与恢复的过程记录：本地 `.ci-output/handoff/2026-10-21-prod-down-kernel-incident.md`、`.ci-output/handoff/2026-10-22-prod-recovery-options.md`。
- 每次登录处理生产问题时，把 `systemctl status` 和相关 `journalctl` 片段贴给 Claude，由 Claude 记入当次的交接文件或 Backlog。

[返回导航](#阅读导航)

<a id="rollback"></a>

## Rollback

回到已验收内核（2026-10-22 实际执行过的做法，菜单项名称以 `grep -oE "menuentry_id_option '[^']+'" /boot/grub/grub.cfg` 的输出为准，根分区 UUID 是 `9a3e62be-4b82-4a7a-8f47-0b25d728fa3a`）：

1. `cp /etc/default/grub /etc/default/grub.bak-<日期>`；把 `GRUB_DEFAULT` 改为 `saved`；`update-grub`。
2. `grub-set-default` 设为当前内核作为退路，`grub-reboot` 设为已验收内核只用一次，`grub-editenv list` 核对后 `reboot`。
3. 重启后按[结果验证](#verification)检查；正常后再 `grub-set-default` 设为已验收内核。已验收内核起不来时，在 Contabo 面板强制重启，只用一次的设置已用掉，会回到原内核。

撤销 GRUB 改动：`cp /etc/default/grub.bak-<日期> /etc/default/grub`，`update-grub`，`grub-editenv - unset saved_entry next_entry`。撤销锁定：`apt-mark unhold <包名>`，删除 `/etc/apt/apt.conf.d/52himawari-hold`；只在[步骤](#procedure)第 5 步的重新验收计划里做。

[返回导航](#阅读导航)

<a id="stop-conditions"></a>

## Stop Conditions

- 启动前检查报的不是内核版本、而是程序或配置摘要变化：停下，把日志交给 Claude，不要回退内核或改文件。
- 服务启动后重启次数持续增加：停下，保留日志，交给 Claude 诊断。
- SSH 和 VNC 都无法登录：不改面板上的网络、防火墙或凭据设置，先联系 Contabo 支持或找 Claude 商量。

[返回导航](#阅读导航)

<a id="firewall"></a>

## 防火墙

2026-10-28 起生产机启用了 `ufw`（Ubuntu 自带的防火墙管理工具），决定见 [ADR 0099](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0099-production-host-firewall-ssh-only.md)：入站默认拒绝，只放行 `22/tcp`（IPv4 和 IPv6），出站不限。网页流量走 Cloudflare 隧道（`cloudflared` 从服务器主动连出），不需要开 80、443 或 8400。

- **查看**：`ufw status verbose` 应显示 `Default: deny (incoming), allow (outgoing)`，规则只有 `22/tcp` 和 `22/tcp (v6)`；`systemctl is-enabled ufw.service` 为 `enabled`，`grep ENABLED /etc/ufw/ufw.conf` 为 `ENABLED=yes`（开机自动生效）。
- **被拦的连接**：`journalctl -k --since "-1h" --no-pager | grep "UFW BLOCK"`。
- **改规则前**：先备份 `iptables-save`、`ip6tables-save` 和 `/etc/ufw` 到 `/root/firewall-backup-<UTC 时间>/`；再设防锁死保险 `systemd-run --unit=ufw-deadman --on-active=10min /usr/sbin/ufw disable`；改完保持旧连接，另开新 `ssh` 连接确认能登录，最后 `systemctl stop ufw-deadman.timer` 取消保险。
- **不要**给 SSH 用 `ufw limit`：上线脚本会连续开很多 `ssh` 连接，30 秒内超过 6 次会被拒。不要随手删掉 `22/tcp` 规则。
- **公网验证**（在 Mac 上）：`nc -z -G 4 -w 4 84.247.157.41 22` 成功，80、443、8400 不通；`curl -s -o /dev/null -w '%{http_code}' https://himawari.siyi.win/` 返回 `302`（跳到 Cloudflare Access 登录）。服务器上 `curl -s 127.0.0.1:20241/ready` 的 readyConnections 大于 0 表示隧道正常。
- **锁在外面时**：等 10 分钟让保险自动关闭防火墙；保险已取消或无效时，按[步骤](#procedure)第 2 步用 Contabo 面板 VNC 控制台以 `root` 登录，执行 `ufw disable`，再按上面的步骤重新启用。
- **撤销**：`ufw disable`（规则保留，开机不再启用）；需要回到启用前的状态时用备份目录里的 `etc-ufw` 和 `default-ufw` 覆盖 `/etc/ufw` 和 `/etc/default/ufw`。2026-10-28 的备份在 `/root/firewall-backup-20261028T014151Z/`。
- Contabo 面板另有免费的网络层防火墙（Network Services → Firewall），目前没有启用；启用时入站同样只放行 22/tcp。

[返回导航](#阅读导航)

<a id="magpie-admin"></a>

## Magpie 管理页

Magpie（装在生产机上的模型路由程序，Himawari 经它调用模型）带一个网页管理页，可以看和改路由组、模型账号和密钥。2026-11-02 用户在 Mac 上只读确认的现场状态：

- `systemctl cat magpie.service` 显示 `ExecStart=/usr/local/bin/magpie serve --web=127.0.0.1:3430`、`Environment=MAGPIE_ADDR=127.0.0.1:3425`、`EnvironmentFile=/etc/magpie/web.env`，服务以 `magpie` 账号运行。[ADR 0117](../adr/0117-magpie-routes-models-through-owned-subscriptions.md) 记的是 2026-10-29 安装时的程序位置 `/opt/magpie/v0.1.2001/magpie`；`/usr/local/bin/magpie` 和它是什么关系（例如是否是指向它的链接）没有核实，以服务器上 `readlink -f /usr/local/bin/magpie` 的输出为准。
- `ss -ltnp` 显示同一个 `magpie` 进程监听 `127.0.0.1:3425`（模型接口）和 `127.0.0.1:3430`（管理页），两者都只在回环地址上，公网连不到，[防火墙](#firewall)也只放行 22。

管理页的密码：Magpie 源码 `internal/gui/web.go`（[yetone/magpie](https://github.com/yetone/magpie/blob/main/internal/gui/web.go)，2026-11-07 的 main）里，常驻的管理页从环境变量 MAGPIE_WEB_KEY 取固定密码；浏览器第一次用 `?k=<密码>` 打开时，页面核对后把密码存进一个只给本站用的 cookie（浏览器保存的小段登录凭据，固定密码时保留 400 天），并跳转到去掉 `k` 的地址。生产装的是更早的版本，源码描述只作参考；生产上的实际表现是：2026-11-02 用户用这个流程登进了生产管理页，之后地址栏是不带 `k` 的 `http://127.0.0.1:3430/?view=settings&tab=general`，与上面的跳转一致。生产服务里这个变量应该来自 `/etc/magpie/web.env`，但文件内容没有读过；用 `ssh root@84.247.157.41 "grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' /etc/magpie/web.env"` 只看变量名（打印成 `名字=` 的样子，注释行不打印）、不显示值。不要把密码贴进聊天、写进仓库或存进书签；把 Magpie 的日志（`journalctl -u magpie.service`）贴给任何人或模型之前，先用 `grep -c 'k='` 确认里面没有带密码的网址。生产机上还有无 sudo 的测试账号 `himawari-ci`，所以要确认它读不到这个文件和 Magpie 的数据目录（里面存着各模型账号的密钥）：`ssh root@84.247.157.41 "stat -c '%a %U:%G %n' /etc/magpie/web.env /var/lib/magpie; for f in /etc/magpie/web.env /var/lib/magpie; do sudo -u himawari-ci test -r \$f; echo \$f \$?; done"`。每个路径后面的数字：`1` 表示测试账号读不到，`0` 表示能读，其他数字表示检查本身失败（例如账号不存在）。两个都是 `1` 才算通过；有 `0` 或其他数字就停下，改权限是生产配置变更，按[授权、上线和合并](../../.claude/rules/owner-standing-rules.md#authorization-deploys-and-merges)处理。

这一节的命令都以 `root` 登录生产机，只由用户本人执行（见[适用范围](#scope)）。管理页拿到密码就能改配置、看全部密钥，所以只经 SSH 端口转发（把 Mac 本机的一个端口经 SSH 接到服务器上的端口）访问，转发在 Mac 上也只绑 `127.0.0.1`，不对外开放。

**一次性连接**：在 Mac 终端运行 `ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:3430:127.0.0.1:3430 root@84.247.157.41`，保持窗口开着（`-N` 表示只做转发、不打开服务器的命令行）。下面的自动连接已经在运行时不要再开这一条：本机 3430 已被占用，它会报错退出。

**登录后自动连接**（2026-11-02 用户已在自己的 Mac 上配好）：

1. `~/.ssh/config` 里加一个 `Host magpie-prod`，写 `HostName 84.247.157.41`、`User root`、`LocalForward 127.0.0.1:3430 127.0.0.1:3430`、`ServerAliveInterval 30`、`ServerAliveCountMax 3`、`ExitOnForwardFailure yes`、`AddKeysToAgent yes`、`UseKeychain yes`。
2. `~/Library/LaunchAgents/com.andy.magpie-tunnel.plist` 让 macOS 的 launchd（自动启动并看管后台程序的系统服务）在用户登录后运行 `/usr/bin/ssh -N -o BatchMode=yes magpie-prod`，`Label` 为 `com.andy.magpie-tunnel`，设 [RunAtLoad](https://github.com/sixianli/himawari-agent/blob/a56903d808de68423561a52d5e4db4b0b622191b/.claude/skills/x-auto-post/scripts/xpost.py)、`KeepAlive` 为真，ThrottleInterval 为 15 秒；断线后自动重连。它是用户级的 LaunchAgent，Mac 开机后要用户登录才会运行。
3. 启用：`launchctl load ~/Library/LaunchAgents/com.andy.magpie-tunnel.plist`；停用：`launchctl unload` 同一路径。看状态：`launchctl list | grep magpie-tunnel`，第一列是进程号，第二列是上次退出码。
4. 验证：`curl -sS -o /dev/null -w '%{http_code}\n' --noproxy '*' http://127.0.0.1:3430/` 输出 `401`，表示请求已经到达生产机的管理页、只是还没登录；输出 `000` 表示没拿到网页回应：隧道没通，或生产机上的 Magpie 没在运行。

**登录**：在浏览器里打开一次 `http://127.0.0.1:3430/?k=<密码>`（密码不是纯字母数字时，先对整个密码做网址编码，例如先运行 `read -rs K` 粘贴密码回车（不回显、不进命令历史），再运行 `K="$K" python3 -c 'import os,urllib.parse;print(urllib.parse.quote(os.environ["K"],safe=""))'`），跳转后地址栏不再带密码，再到浏览历史里删掉带 `k=` 的那一条（不要用无痕窗口，关窗后 cookie 就没了）；把这个不带密码的 `http://127.0.0.1:3430/` 存成书签。之后 cookie 有效期内直接点书签就能进；浏览器清了 cookie 时再用 `?k=` 登录一次。浏览器的 cookie 按主机名区分、不按端口区分，这个 cookie 里就是生产密码，同一个浏览器打开任何 `http://127.0.0.1:<端口>/` 的页面都会把它发过去；所以生产管理页用一个单独的浏览器（或单独的浏览器用户），这个浏览器里不打开别的本机页面。

注意：

- 在管理页里改的路由组、账号或密钥立即影响线上对话，算生产配置变更，按[授权、上线和合并](../../.claude/rules/owner-standing-rules.md#authorization-deploys-and-merges)处理。路由组 `group/himawari-main` 改动的历史见 [ADR 0117](../adr/0117-magpie-routes-models-through-owned-subscriptions.md)，当前顺序以管理页显示的为准。
- Hermes 测试环境的 Magpie 管理页也用 3430：2026-11-01 在 Hermes 装了测试容器 `magpie-test`，只绑 `127.0.0.1:3425` 和 `127.0.0.1:3430`（Hermes 端口快照 [hr4-after.txt](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/.agents/tasks/hermes-runner/artifacts/hr4-after.txt) 里同时有这个容器和 `127.0.0.1:3430`）；[ADR 0142](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0142-keep-background-memory-capture.md) 写于 2026-10-31，说「Hermes 上没有 Magpie」是安装之前的情况。要连 Hermes 时先 `launchctl unload` 生产隧道，否则两条转发抢同一个本机端口，后开的那条会因 ExitOnForwardFailure 直接退出。Hermes 的管理页在平时用的浏览器里打开，不要在登过生产管理页的那个浏览器里打开，原因见上面的登录一段。
- SSH 密钥设了口令时，后台的 `ssh` 无法弹窗输入，会每 15 秒重试一次、一直连不上；先运行一次 `ssh-add --apple-use-keychain <私钥文件>` 把口令存进钥匙串。

[返回导航](#阅读导航)

<a id="heartbeat"></a>

## 心跳告警

2026-10-19 生产重启后进了新内核，服务停了约 51 小时、没有任何人知道（[BL-20261021-009](../backlog/BL-20261021-009-生-产-启-动-绑-定-精-确.md)）。心跳告警补的就是“没人知道”：生产机上一个系统定时任务每分钟先问本机服务是否就绪（`http://127.0.0.1:8400/health/ready`，返回 200 才算就绪），就绪就向 Healthchecks.io（一个“超时没收到心跳就发通知”的外部服务）发一次心跳；不就绪就不发心跳，只把原因记进这条检查的日志，连续超过宽限时间（5 分钟）没收到心跳，Healthchecks.io 才发通知。整台机器停了或这个定时任务不跑，同样会因为超时发通知。所以上线和回滚时服务停止的几分钟不会报警；上线或回滚预计超过 5 分钟时，先在 Healthchecks.io 页面点这条检查的暂停，做完再恢复。它不随上线包安装，上线、回滚、重启都不会带走它。

脚本和安装命令在 `scripts/operations/heartbeat/`：`himawari-heartbeat.py` 每次运行一次，`install-heartbeat.sh` 安装、移除和查看状态。专属网址只放在生产机的 `/etc/himawari-heartbeat/healthcheck-url`（目录和文件都归 root，目录 0700、文件 0600；不能放在 `/etc/himawari/`，那个目录归 himawari-prod 且 0700，心跳单元去掉了 root 绕过目录权限的能力，会读不到，2026-11-15 第一次安装就是这样失败的，I-110），脚本只接受 `https://hc-ping.com/` 开头、只含字母数字、`_`、`-`（最多再带一段 `/名字`，名字不能是 `fail`、`start`、`log`）的网址，别的一律拒绝，不写进仓库、命令行或日志。

- **安装**（root，需要 Andy 对这次生产机写操作的同意）：把本仓库的 `scripts/operations/heartbeat/` 目录拷到生产机，然后 `bash install-heartbeat.sh install < <装有专属网址的文件>`，网址从标准输入读，不出现在命令行里；换网址就再装一次；只重装脚本不换网址用 `install --keep-url`（顺便把网址文件权限改回 0600）。装到一半失败时（例如 `enable` 报错），修好原因后重跑同一条命令即可。systemd 的加固选项没有在真实 systemd 上跑过，装完用 `status` 和 `journalctl` 确认第一次运行成功。装完会启用 `himawari-heartbeat.timer`。
- **网址存在哪里、丢了怎么办**：网址只在两处：Andy 的 Mac 上的 `~/healthcheck-url.txt`（装的时候用），和生产机的上面那个文件。它相当于“服务正常”的暗号，谁拿到都能替生产机发心跳，所以不提交进仓库、不贴进聊天或命令行。丢了不用补备份：Healthchecks.io 上那条检查（`himawari-prod`，周期 1 分钟、宽限 5 分钟）的页面永远能重新复制 Ping URL（选 uuid 那个）；怀疑泄露就在页面上换一个，再用 `install` 重装一次。安装脚本会顺手删掉旧位置 `/etc/himawari/healthcheck-url` 的残留（`install --keep-url` 在新位置没有网址时会先从旧位置取；普通 `remove` 不动旧位置，只有 `remove --purge` 才删）。
- **查看**：`bash install-heartbeat.sh status` 显示定时器是否在运行；`journalctl -u himawari-heartbeat.service -n 20` 看每次运行的结果，正常时一行 `HEARTBEAT ok`，不就绪时是 `HEARTBEAT skipped <原因>`。
- **移除**：`bash install-heartbeat.sh remove`；连同专属网址一起删用 `remove --purge`。
- **Healthchecks.io 上的设置**：这条检查的周期 1 分钟、宽限 5 分钟，通知方式选邮件加手机推送。
- **验收**：装完先看到 `HEARTBEAT ok`，Healthchecks.io 页面显示检查在线；再在不影响用户的时间停服务约 6 分钟（需要 Andy 的同意），确认收到“没收到心跳”的通知，起来后恢复在线。
- **没覆盖**：服务就绪几分钟又崩的循环，只要 5 分钟内还有心跳就不会告警，要连续 5 分钟没就绪才告警；手工暂停检查后忘了恢复会一直静默，所以做完要回到页面确认显示在线；服务正常、但外部访问入口（Cloudflare）断了的情况，本机心跳发现不了；要盖住它需要外部探测加 Cloudflare 服务令牌，另做。

[返回导航](#阅读导航)

<a id="troubleshooting"></a>

## Troubleshooting

| 现象 | 含义 | 处理 |
| --- | --- | --- |
| `Permission denied (publickey)` | 服务器只认密钥，Mac 没提供对得上的那把 | 用[步骤](#procedure)第 1 步的 `ssh -v` 看试了哪把；必要时用 VNC 控制台登录后把公钥加进 `/root/.ssh/authorized_keys` |
| VNC 报 `Connection failed`，`nc` 显示 `Connection refused` | 主机商的 VNC 端口没有程序在听 | 面板里设密码后点 “Confirm”，等几分钟；端口可能变化，以面板显示为准 |
| `journalctl` 显示 `AssertionError` 且 `actual`/`expected` 是两个内核版本 | 服务器换了内核 | 按[回退](#rollback)回到已验收内核 |
| `ssh` 连接超时（不是 `Connection refused`），VNC 能登录 | 防火墙规则里没有 22 | 按[防火墙](#firewall)的“锁在外面时”处理 |
| 登录提示 “updates can be applied” 或 “New release available” | 普通提示 | 不运行 `apt upgrade` 或 `do-release-upgrade`，见[安全前提](#safety-and-preconditions) |

[返回导航](#阅读导航)
