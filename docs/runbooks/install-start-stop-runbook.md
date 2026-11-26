---
status: active
document_type: runbook
execution_risk: critical
supersedes: ""
superseded_by: ""
date: "2026-11-26"
covers: "scripts/install/first-install.sh, scripts/install/prepare-host-tools.sh, scripts/operations/install-deploy-key.sh, scripts/delivery-mode/packet-template/systemd/pair-supervisor.mjs, apps/admin-cli/src/account-command.ts"
verified_at: "7c8521fe5f55e7dd57c5bd52badd16eef647502e"
---

# 生产机安装与启停 Runbook

本手册写怎样把 Himawari 装到一台新的生产机上、怎样启动和停止生产服务，以及内置账号怎样建立和找回。日常升级不在这里：合进 `main` 后由 GitHub 工作流自动上线，做法见[交付模式](../../.agents/instructions/delivery-mode.md#fast-mode)和 [ADR 0293](../adr/0293-how-production-deploys-work.md)。时间一律日本时间（JST）。

<a id="contents"></a>

## 阅读导航

- [Scope](#scope)
- [Authoritative Sources](#authoritative-sources)
- [Safety and Preconditions](#safety-and-preconditions)
- [Live-State Preflight](#live-state-preflight)
- [Procedure](#procedure)
- [Verification](#verification)
- [Evidence](#evidence)
- [Rollback](#rollback)
- [Stop Conditions](#stop-conditions)
- [Troubleshooting](#troubleshooting)

<a id="scope"></a>

## Scope

- 适用：在一台新的 Ubuntu 机器（linux-arm64 或 linux-x64）上第一次装生产；装好后放上线用的钥匙；平时启动、停止、查看生产服务；建立或找回内置账号。
- 不适用：日常上线和回滚（交付模式里的 `ci-deploy.sh`、`deploy.sh`、`rollback.sh`）；备份和恢复（[生产数据机外备份 Runbook](production-offsite-backup-runbook.md)）；网页入口和 Cloudflare 登录（[生产网页入口 Runbook](production-web-entry-runbook.md)）。
- 目标：生产机上的服务 `himawari-prod.service`（一个单元里同时管 Agent 和 Worker 两个进程，任一个退出就一起重启）、程序目录 `/opt/himawari`、配置 `/etc/himawari/config.json`、状态目录 `/var/lib/himawari/state`。

<a id="authoritative-sources"></a>

## Authoritative Sources

- `scripts/install/first-install.sh`：装软件包、建账号、构建、安装、写配置、初始化数据库、搬密钥、写 systemd 单元并启动。
- `scripts/install/prepare-host-tools.sh`：装沙箱用的 bubblewrap、AppArmor 规则和构建账号的工具，生成主机资格签名钥匙。
- `scripts/operations/install-deploy-key.sh`：建 `himawari-deploy` 账号和上线入口，把上线钥匙放进 GitHub 的 `production` 环境。
- `scripts/delivery-mode/packet-template/systemd/pair-supervisor.mjs`：服务单元实际运行的成对启动程序。
- `apps/admin-cli/src/account-command.ts`：`himawari account create`、`himawari account recover`。

<a id="safety-and-preconditions"></a>

## Safety and Preconditions

- 首次安装和 `prepare-host-tools.sh` 都以 root 运行，会装软件包、建账号、改 AppArmor 和 systemd；只在一台还没有生产数据、或已经决定要换上去的新机器上运行。
- 从旧机器搬过来时，`first-install.sh` 的第二个参数是一个“种子目录”：里面按原路径放旧机器的 `/etc/himawari/config.json` 和状态目录下的 `secrets/`（可选再放旧数据库，用来带过登录身份绑定）。种子目录含密钥，传完即删，不打印、不提交。
- 旧机器的数据不由这两个脚本搬：搬数据用[机外备份恢复](production-offsite-backup-runbook.md#restore-to-production)。
- 停服、改配置、改数据库都要先按交付模式的生产访问规则先备份；删除或不可逆地改动生产数据要先问 Andy。

<a id="live-state-preflight"></a>

## Live-State Preflight

以 root 在目标机器上只读执行：

```bash
uname -m
cat /etc/os-release
sysctl kernel.apparmor_restrict_unprivileged_userns
systemctl is-active himawari-prod.service
df -h / /opt /var/lib
```

- 首次安装前：`himawari-prod.service` 不应存在，状态目录 `/var/lib/himawari/state` 不应存在（存在时脚本跳过初始化并打印 `FIRST_INSTALL_STATE_ROOT_EXISTS`）。
- 启停前：记下 `systemctl is-active` 的结果和 `journalctl -u himawari-prod.service -n 20` 的最后几行。

<a id="procedure"></a>

## Procedure

<a id="first-install"></a>

### 第一次安装

1. 把种子目录传到目标机器（例如 `/root/seed`），以 root 运行：

   ```bash
   bash first-install.sh <提交号> /root/seed [--public-origin https://<域名>]
   ```

   它装 git、构建工具和 bubblewrap，建服务账号 `himawari-prod` 和构建账号 `himawari-build`，按 `ci/toolchain-lock.json` 下载并核对 Node，在构建账号里构建，安装到 `/opt/himawari/releases/<日期>-<提交前 8 位>/`，写配置、初始化数据库、搬密钥、生成新的 Worker 令牌，写 `himawari-prod.service` 并启动，最后对本机首页请求 90 秒，拿到 200 打印 `FIRST_INSTALL_OK`。
2. 以 root 运行 `bash prepare-host-tools.sh <同一提交号>`。它装 socat、ripgrep 等沙箱工具，下载并核对 bubblewrap 0.11.2 装到 `/usr/local/libexec/bubblewrap-0.11.2/`，给 `/usr/bin/bwrap` 和它各写一条 AppArmor 规则（Ubuntu 24.04 默认限制普通程序用用户命名空间，没有规则沙箱建不起来），为 arm64 上线准备构建账号的工具，生成主机资格签名钥匙。结束打印 `PREPARE_HOST_OK`。
3. 在能以 root SSH 到这台机器、并已登录 `gh` 的地方，运行 `HIMAWARI_PACKET_HOST=<地址> bash scripts/operations/install-deploy-key.sh`。之后合进 `main` 的提交会自动上线到这台机器。
4. 按[机外备份 Runbook 的安装](production-offsite-backup-runbook.md#install)装备份。
5. Cloudflare 隧道和登录关卡不由这些脚本装，按[生产网页入口 Runbook](production-web-entry-runbook.md) 核对。

<a id="start-stop"></a>

### 启动、停止和查看

```bash
systemctl status himawari-prod.service --no-pager
systemctl stop himawari-prod.service
systemctl start himawari-prod.service
journalctl -u himawari-prod.service -n 100 --no-pager
```

停止时 systemd 先发 SIGTERM，35 秒内没退出再强制结束。不要只停 Agent 或只停 Worker：两个进程由同一个单元成对管理。

<a id="built-in-account"></a>

### 内置账号

只在配置的 `identity.kind` 是 `built-in` 时有用；现在生产用 Cloudflare 登录，不走这一步。

1. 停服务。在只有服务账号能读的目录里准备一个输入文件（权限 600），只写 `username` 和 `password`。
2. 第一次建立：`himawari account create --config /etc/himawari/config.json --input <输入文件> --output <新的设置文件> --secret-dir <stateRoot>/secrets`。设置文件里有验证器地址和 10 条一次性恢复码，交给 Andy 保存后删掉服务器上的副本。
3. 丢了密码或全部第二因素时：同样准备输入文件，运行 `himawari account recover ...`，加 `--confirm RECOVER_ACCOUNT_<配置里的 Owner ID>`。它重设密码和第二因素，并让全部旧会话和设备失效。
4. 启动服务，在网页上用新凭据登录一次。

<a id="verification"></a>

## Verification

- 首次安装：输出里有 `FIRST_INSTALL_OK` 和 `PREPARE_HOST_OK`；`curl -s -o /dev/null -w '%{http_code}' -H 'Host: <域名>' http://127.0.0.1:<配置里的 http.listenPort>/` 是 200。
- 上线钥匙：脚本最后打印 `DEPLOY_KEY_INSTALLED`；下一次合进 `main` 的上线工作流不再提示钥匙缺失。
- 启停：`systemctl is-active himawari-prod.service` 是 `active`，日志里有 `service.ready`。

<a id="evidence"></a>

## Evidence

脚本的输出（每步以 `FIRST_INSTALL_STEP`、`PREPARE_HOST_STEP` 开头）和 `journalctl -u himawari-prod.service` 就是记录；交付报告里写提交号、安装目录和最后一行结果，不写密钥、种子目录内容或配置全文。

<a id="rollback"></a>

## Rollback

- 首次安装失败：机器上还没有生产数据时，修好原因后重跑同一脚本（它会跳过已建的账号和已存在的状态目录）。已经有数据时不要重跑，按[机外备份恢复](production-offsite-backup-runbook.md#restore-to-production)处理。
- 上线钥匙放错：重跑 `install-deploy-key.sh` 会生成新钥匙并覆盖服务器和 GitHub 上的旧值。

<a id="stop-conditions"></a>

## Stop Conditions

- `FIRST_INSTALL_NODE_DIGEST_MISMATCH`、`PREPARE_HOST_BWRAP_DIGEST_MISMATCH` 等下载核对失败：不改摘要，查清下载来源。
- `FIRST_INSTALL_HEALTH_FAILED`：先看脚本打印的最后 40 行日志，不要放宽检查。
- 目标机器上已经在跑生产服务、而这次不是有意替换它。

<a id="troubleshooting"></a>

## Troubleshooting

| 现象 | 排查 | 处理 |
| --- | --- | --- |
| 沙箱工具报用户命名空间被拒绝 | `sysctl kernel.apparmor_restrict_unprivileged_userns`、`aa-status` | 重跑 `prepare-host-tools.sh`，它会重新加载两条 AppArmor 规则 |
| `FIRST_INSTALL_IDENTITY_NOT_BOUND` | 种子目录里没有旧数据库 | 按[生产网页入口 Runbook](production-web-entry-runbook.md#procedure) 重新绑定登录身份 |
| 本机 `curl http://127.0.0.1:<配置里的 http.listenPort>/` 是 403 | 没带 `publicOrigin` 的 Host 头 | 加 `-H 'Host: <域名>'` |
| 服务反复重启 | `journalctl -u himawari-prod.service -n 100` | 按日志里的错误码查；内核和资格签名不一致时看上线前检查的提示 |
