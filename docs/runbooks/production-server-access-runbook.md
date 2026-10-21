---
status: active
document_type: runbook
execution_risk: critical
contract_sha256: "sha256:e4dbd65ce9e0a1b5c271564b05afac58be64063a4b6dd6f697f0ea2d1f3be243"
supersedes: ""
superseded_by: ""
date: "2026-10-22"
---

# 生产云服务器访问与系统更新 Runbook

<!-- runbook-contract:
- docs/adr/0056-cloud-server-also-test-host.md
- docs/backlog/BL-20261021-009-生-产-启-动-绑-定-精-确.md
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
- [排障](#troubleshooting)

<a id="scope"></a>

## Scope

- 适用：用户本人以管理员身份登录生产云服务器，查看生产服务状态和日志，处理启动失败，安排内核或系统程序更新。
- 不适用：Claude、opencode 和 Grok 都不以 `root` 或任何生产账号登录，不改 SSH 配置、启动设置或软件包状态；它们只用测试账号 `himawari-ci` 做只读查询（`AGENTS.md` 的 Test and Production Hosts）。生产部署按各次冻结操作包执行，不在本手册里。
- 目标：云服务器 `84.247.157.41` 上的 `root` 账号、`himawari-prod.service`、启动引导程序 GRUB 和软件包管理器 apt。

[返回导航](#阅读导航)

<a id="authoritative-sources"></a>

## Authoritative Sources

- 云服务器同时是生产主机和测试主机，测试账号的边界：[SOURCE: docs/adr/0056-cloud-server-also-test-host.md]
- 启动前检查绑定内核版本导致的停摆、根因确认和恢复记录：[SOURCE: docs/backlog/BL-20261021-009-生-产-启-动-绑-定-精-确.md]
- 启动前检查脚本 `cloud-protected-prepare.mjs` 和封存脚本 `cloud-seal.mjs` 在各次操作包的 `signing/` 目录（本地未提交的 `.ci-output/production/`）；第五次版本安装在服务器的 `/opt/himawari/operations/fifth-20261017/`。

[返回导航](#阅读导航)

<a id="safety-and-preconditions"></a>

## Safety and Preconditions

- **只接受密钥登录**。`/etc/ssh/sshd_config.d/00-key-only.conf`（2026-10-01 写入）和 `60-cloudimg-settings.conf` 都设了 `PasswordAuthentication no`，`sshd_config` 里 `root` 为 `PermitRootLogin prohibit-password`：任何账号都不能用密码经 SSH 登录，`root` 只能用密钥。推断这份设置在 2026-10-19 重启后才实际生效，之前密码登录可能仍可用。
- **管理员登录用 `root` 和用户 Mac 上已有的密钥**：`ssh root@84.247.157.41`。历次生产操作包的步骤脚本也用同一方式（`ssh -o BatchMode=yes ... root@84.247.157.41`，`BatchMode` 表示不弹出密码输入）。
- **不要用 Contabo 面板的 “Reset credentials”**，除非现有密钥确实失效：它重置默认用户（`root`）的凭据，可能替换而不是追加 `root` 的密钥列表，让操作包脚本用的密钥失效；也可能需要重启服务器。确需使用时选 “SSH-Key” 页，粘贴 Mac 上 `.pub` 公钥文件的一整行，绝不粘贴私钥。
- **启动前检查核对的系统状态**：内核版本（`os.release()`）必须与安装回执里封存时的版本完全相同；`/usr/bin/bwrap`、`/usr/bin/socat`、`/usr/bin/bash`、`/usr/bin/rg` 和 `bwrap` 的 AppArmor 配置文件的摘要必须不变。任何一项变化，服务启动前检查就失败，`systemd` 每 10 秒重试一次，且没有告警。
- **当前锁定状态（2026-10-22 起）**：GRUB 长期默认启动 `6.8.0-142-generic`（`GRUB_DEFAULT=saved`，`saved_entry` 指向 142）；`apt-mark hold` 了 `linux-virtual`、`linux-image-virtual`、`linux-headers-virtual`、`linux-image-6.8.0-142-generic`、`linux-modules-6.8.0-142-generic`、`bubblewrap`、`socat`、`bash`、`ripgrep`；`/etc/apt/apt.conf.d/52himawari-hold` 让自动更新排除 `^linux-`、`^bubblewrap$`、`^socat$`、`^bash$`、`^ripgrep$`。代价是这些软件暂时收不到安全补丁。
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

<a id="troubleshooting"></a>

## Troubleshooting

| 现象 | 含义 | 处理 |
| --- | --- | --- |
| `Permission denied (publickey)` | 服务器只认密钥，Mac 没提供对得上的那把 | 用[步骤](#procedure)第 1 步的 `ssh -v` 看试了哪把；必要时用 VNC 控制台登录后把公钥加进 `/root/.ssh/authorized_keys` |
| VNC 报 `Connection failed`，`nc` 显示 `Connection refused` | 主机商的 VNC 端口没有程序在听 | 面板里设密码后点 “Confirm”，等几分钟；端口可能变化，以面板显示为准 |
| `journalctl` 显示 `AssertionError` 且 `actual`/`expected` 是两个内核版本 | 服务器换了内核 | 按[回退](#rollback)回到已验收内核 |
| 登录提示 “updates can be applied” 或 “New release available” | 普通提示 | 不运行 `apt upgrade` 或 `do-release-upgrade`，见[安全前提](#safety-and-preconditions) |

[返回导航](#阅读导航)
