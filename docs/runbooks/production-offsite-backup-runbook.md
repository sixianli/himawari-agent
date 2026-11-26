---
status: active
document_type: runbook
execution_risk: critical
supersedes: ""
superseded_by: ""
covers: "scripts/operations/backup/**, scripts/delivery-mode/ci-deploy.sh, apps/admin-cli/src/index.ts, packages/persistence-sqlite/src/sqlite-recovery-point.ts"
verified_at: "e51fe4363ed3e21ab6581e3563c652441f4e6b76"
date: "2026-11-26"
---

# 生产数据机外备份与恢复 Runbook

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

本手册管 Himawari 生产机（Oracle 东京的 ARM 机）上用户数据的机外备份：安装、日常运行、每周恢复演练，以及整台机器丢了之后从机外备份恢复。

备份内容（一次备份叫一个“快照”）：

- 产品库恢复点：`himawari backup create` 用 SQLite 在线备份接口拍下的 `product.sqlite`（记忆、聊天记录、对话、任务、保险箱密文等都在里面）加上它引用的附件密文文件，用服务器上的备份钥匙加密，并当场解密核对过行数和完整性（代码见 `packages/persistence-sqlite/src/sqlite-recovery-point.ts`）。
- 恢复所需的其余文件：状态目录下的 `authority.json` 和 `configuration.json`、密钥目录（`<stateRoot>/secrets`，含备份钥匙、附件钥匙、模型密钥）、`/etc/himawari/config.json`，以及安装时用 `--extra-path` 加进来的目录。
- 不含保险箱总钥匙：它只在 Andy 的 iPhone 和 iCloud 钥匙串里（ADR 0288 第 2 条），服务器和备份里都没有。

整份快照再用 restic（一个成熟的开源备份程序，自带加密、去重和按日/周保留）加密后，经 rclone（一个对接各家对象存储的开源程序）上传到 Oracle 对象存储的一个桶里。东京机用“实例主体”身份（Oracle 给云主机的免密钥身份）写这个桶，服务器上不放 Oracle 密码。

定时：

| 任务 | 时间（JST） | 做什么 |
| --- | --- | --- |
| `himawari-backup.timer` | 每天 03:30 左右 | 拍恢复点、上传、按保留规则删旧快照、本机只留最近 3 个恢复点 |
| `himawari-backup-drill.timer` | 每周日 04:30 左右 | 新拍一份并上传，再从对象存储下载回来，在临时目录用当前版本的 `himawari backup verify` 解密核对，最后抽查 10% 的仓库数据 |
| 上线前 | 每次 `ci-deploy.sh` 真正上线之前 | 拍一份 `pre-deploy` 快照；失败就不上线 |

保留规则（`scripts/operations/backup/pins.json`）：日备 7 天、周备 4 周、上线前 5 份、演练 2 份。

<a id="authoritative-sources"></a>
## Authoritative Sources

- `scripts/operations/backup/himawari-backup.py`：备份、演练、查看。
- `scripts/operations/backup/install-backup.sh`：安装和更新。
- `scripts/operations/backup/pins.json`：rclone 版本和摘要、保留规则、定时。
- `scripts/delivery-mode/ci-deploy.sh`：上线前备份。
- `scripts/delivery-mode/instances/andy-production.json`：服务账号、配置、状态目录等路径。
- `apps/admin-cli/src/index.ts` 和 `packages/persistence-sqlite/src/sqlite-recovery-point.ts`：恢复点的建立、核对和恢复。

<a id="safety-and-preconditions"></a>
## Safety and Preconditions

- restic 密码在服务器 `/etc/himawari-backup/restic-password`（只有 root 能读）。另一份必须存在服务器之外（Andy 的密码管理器）：机器整台丢了时，没有这份密码，对象存储里的备份打不开。
- 恢复到生产会覆盖当前数据，恢复点之后写入的一切都会丢，必须先问 Andy。演练只写临时目录，不碰生产数据。
- 都在 Oracle 永久免费额度内（对象存储共 20 GB）。用量接近 15 GB 时先报告再处理。

<a id="live-state-preflight"></a>
## Live-State Preflight

在生产机上以 root 运行，只读：

```bash
systemctl list-timers 'himawari-backup*' --no-pager
python3 -I /usr/local/sbin/himawari-backup status
journalctl -t himawari-backup -t himawari-backup-drill -n 50 --no-pager
```

<a id="procedure"></a>
## Procedure

<a id="install"></a>
### 安装（一次）

前提：Oracle 控制台里已建好桶，并给东京机建了动态组和只能管这个桶里对象的策略：

```text
Allow dynamic-group <组名> to manage objects in compartment id <区间> where target.bucket.name='<桶名>'
Allow dynamic-group <组名> to read buckets in compartment id <区间> where target.bucket.name='<桶名>'
```

然后在东京机上，用部署入口的仓库副本（`/var/lib/himawari-deploy/checkout`）以 root 运行：

```bash
bash scripts/operations/backup/install-backup.sh install --namespace <对象存储命名空间> --bucket <桶名> [--healthcheck-url-file <文件>]
python3 -I /usr/local/sbin/himawari-backup run --reason manual
python3 -I /usr/local/sbin/himawari-backup drill
```

生产机上 Magpie（模型路由程序）的设置和用量记录也要一起备份，安装时加上 `--extra-path /var/lib/magpie/.config/magpie --extra-path /etc/magpie`。区域和区间号由脚本从实例元数据读出，不用手填。如果 `/etc/himawari/config.json` 里还没有“备份加密”用途的钥匙（生产配置模板原本没有），安装脚本会在密钥目录生成 `backup-key.v1`（属主和数据加密钥匙相同，权限 600），并把它登记进配置；已有就不动。安装后把 restic 密码交给 Andy 存进密码管理器。

<a id="update"></a>
### 更新

每次上线时 `ci-deploy.sh` 会把新提交里的 `himawari-backup.py` 装到 `/usr/local/sbin/himawari-backup`。改了定时、保留规则或 rclone 版本时，重新运行上面的 `install` 命令（不会换密码）。

<a id="restore-to-production"></a>
### 从机外备份恢复到生产（要 Andy 同意）

1. 在生产机（原机或新装的机器，已装好同一版本的 Himawari）上停服务：`systemctl stop himawari-prod.service`。
2. 列快照，选一个：`python3 -I /usr/local/sbin/himawari-backup status`。新机器先按[安装](#install)装好，并把 Andy 保存的 restic 密码写进 `/etc/himawari-backup/restic-password`。
3. 下载：`RCLONE_CONFIG=/etc/himawari-backup/rclone.conf RESTIC_PASSWORD_FILE=/etc/himawari-backup/restic-password RESTIC_REPOSITORY=$(python3 -c 'import json;print(json.load(open("/etc/himawari-backup/settings.json"))["repository"])') restic restore <快照号> --target /var/lib/himawari-restore`。
4. 新机器时：把下载目录里的 config/config.json 放回 `/etc/himawari/config.json`，state/authority.json、state/configuration.json 和 state/secrets/ 放回状态目录，属主改成服务账号、权限 600/700。
5. 把 state/recovery-points/<恢复点号> 复制进 `<stateRoot>/recovery-points/`，属主改成服务账号，然后以服务账号运行：`himawari backup restore --config /etc/himawari/config.json --secret-dir <stateRoot>/secrets --backup <恢复点号> --target <stateRoot> --confirm RESTORE_<恢复点号>`。恢复后内置账号要重新登录。
6. 启动服务，读回 `/health/ready`，再跑一次 `himawari-backup drill`。

<a id="verification"></a>
## Verification

- `himawari-backup run` 打印 `BACKUP_PASSED`，带快照号和记忆、消息等表的行数。
- `himawari-backup drill` 打印 `DRILL_PASSED`，说明从对象存储下载回来的那份能用当前版本解密并通过完整性和行数核对。
- `himawari-backup status` 里能看到 daily、pre-deploy、drill 三类快照。

<a id="evidence"></a>
## Evidence

结果在 systemd 日志（`journalctl -t himawari-backup -t himawari-backup-drill`）里，失败时也推到 Healthchecks.io（一个“定时没收到报平安就发邮件”的网站），前提是安装时给了它的地址。日志里只有快照号、恢复点号和行数，没有密码或数据内容。

<a id="rollback"></a>
## Rollback

- 安装出错：`systemctl disable --now himawari-backup.timer himawari-backup-drill.timer`，删掉 `/etc/systemd/system/himawari-backup*` 和 `/usr/local/sbin/himawari-backup`。不删 `/etc/himawari-backup/restic-password`，否则已有快照打不开。
- 恢复到生产出错：`himawari backup restore` 失败时会把原 `data` 目录换回去（`sqlite-recovery-point.ts` 的 `restore`）；再启动服务即可。

<a id="stop-conditions"></a>
## Stop Conditions

- 演练失败（`DRILL_FAILED`）时先查原因，不删任何快照。
- restic 报密码错误（`BACKUP_PASSWORD_WRONG`）时停下：不要重新 `init`，那会让人以为旧快照没了。
- 要恢复到生产但 Andy 没同意时停下。

<a id="troubleshooting"></a>
## Troubleshooting

| 现象 | 只读排查 | 处理 |
| --- | --- | --- |
| `BACKUP_REPOSITORY_UNREACHABLE` | `RCLONE_CONFIG=/etc/himawari-backup/rclone.conf rclone lsd himawari-oci:` | 多半是 Oracle 策略或动态组没包含这台机器；在控制台核对后重试 |
| `BACKUP_CLI_MISSING` / `BACKUP_RELEASE_UNKNOWN` | `grep -o '/opt/himawari/releases/[^ ]*' /etc/systemd/system/himawari-prod.service` | 服务单元里没有在用版本，先修好上线再备份 |
| `BACKUP_ALREADY_RUNNING` | `systemctl status himawari-backup.service` | 等前一次跑完 |
| 上线报 `CI_DEPLOY_REFUSED BACKUP_FAILED` | 同上几条 | 先修好备份再上线；不要跳过 |
