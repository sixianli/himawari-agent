---
status: active
document_type: adr
decision_status: accepted
supersedes: "https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0086-generate-release-packets-from-parameters.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0099-production-host-firewall-ssh-only.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0120-release-cleanup-on-every-deploy-and-space-preflight.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0135-failure-scenes-in-tmp-capped-at-one.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0151-ship-incremental-source-bundles-to-a-server-side-cache.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0279-history-is-compared-only-while-the-service-is-stopped.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0282-deploy-clears-its-own-leftovers-and-reuses-unchanged-materials.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0290-linux-arm64-is-a-production-platform.md"
superseded_by: ""
date: "2026-11-26"
covers: "scripts/delivery-mode/make-packet.py, scripts/delivery-mode/deploy.sh, scripts/delivery-mode/rollback.sh, scripts/delivery-mode/deploy-preflight.py, scripts/delivery-mode/generated-packet-gate.py, scripts/delivery-mode/run-packet-checks.py, scripts/delivery-mode/release-cleanup.py, scripts/delivery-mode/release-cleanup-remote.py, scripts/delivery-mode/packet-template/install/source-cache.mjs, scripts/delivery-mode/instances/andy-production.json, scripts/ci/platforms.mjs"
verified_at: "7c8521fe5f55e7dd57c5bd52badd16eef647502e"
---

# ADR 0293：上线包怎样生成、上线和清理

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
  - [上线包由生成器按参数生成](#generate)
  - [生产平台和构建机](#platform)
  - [数据库升级和历史数据比较](#migrations)
  - [上线前检查和步骤顺序](#preflight)
  - [只传变了的东西](#transfer)
  - [失败时怎么办](#failure)
  - [清理上线留下的东西](#cleanup)
- [放弃的做法](#rejected)
- [后果](#consequences)

<a id="context"></a>

## 背景

上线包（把一个提交装到生产机上的那一整套脚本、材料和检查结果）的规矩原来分散在八份 ADR 里：ADR 0086 定由生成器按参数出包，ADR 0120、0135、0282 先后定上线前后怎么清理，ADR 0151、0282 定只传变了的源码和大材料，ADR 0279 改了历史数据的比较时机，ADR 0290 让 ARM 机成为生产平台，ADR 0099 是给已经退租的旧生产机开防火墙。这份 ADR 把仍然有效的决定合成一份；具体命令和每一步的操作写在[交付模式](../../.agents/instructions/delivery-mode.md#fast-mode)，这里只记“定了什么、为什么”。旧文全文在 `supersedes` 列的固定提交链接里。

ADR 0099 整份作废：它是给 2026-11-25 退租的那台 x86 云服务器（Contabo）开 `ufw` 防火墙，Andy 当天说“84.247 这一台就不要再去管了”，现在的生产机是 Oracle 东京的 ARM 机。

<a id="decision"></a>

## 决定

<a id="generate"></a>

### 上线包由生成器按参数生成

- 模板在 `scripts/delivery-mode/packet-template/`，每次上线会变的值写成 `__PKT_名字__` 占位，生成器是 `make-packet.py`。缺参数或留下没替换的占位就拒绝出包（`PACKET_PARAMETER_MISSING`）。上线包不从上一次复制，也不手改；要改上线做的事，改模板或实例文件后重新生成。
- 要人决定的输入只有：上线哪个提交、给哪个实例上线（`scripts/delivery-mode/instances/<名字>.json`）、可选的日期，以及用 `--host` 指定目标机器。其余全部推出来：第几次上线、原配置的模型上限和读网页上限、生产数据库版本、主机名、CPU 架构、服务账号编号等都从目标机器只读读出（不读、不打印密钥），代码的数据库版本取这个提交的迁移文件，安装包和源码包的摘要取这次构建的结果。模板和构建脚本里不得写死机器信息，`check-template-neutral.py` 会拦。
- 全部检查在出包时跑（`run-packet-checks.py`），任何一项不过就不出包，结果写进 `packet-checks.json`。`deploy.sh` 先运行 `generated-packet-gate.py`，不是生成器出的包、或检查没记全部通过、或提交对不上，就以退出码 6 停下，生产机上什么都不动。`rollback.sh` 不受这道检查限制，因为回退要先恢复服务。
- 冻结紧挨着上线：离上线时间长了，用 `make-packet.py freeze` 重新冻结。上线前检查对比生产机现在的配置、服务单元和授权轮次是否和冻结时一样，不一样就在停服前停下（`PREFLIGHT_REFREEZE`）。
- 每人一个实例以后只需多写一个实例文件。
- 实例文件的 `configTargets.computers`（浏览器的三个上限）让生成器在配置切换时给 `runPolicy` 加上 `userComputers`（套接字路径取自 `scripts/operations/computers/settings.json`）和 `browser`，S7 切换脚本和维护脚本按同样顺序算出新配置；回退还原原配置时这两项一起去掉。
- 实例文件的 `configTargets.appConnections`（每项：应用名、显示名、MCP 网址、客户端编号、客户端密钥的引用和版本、`trustsReadOnlyLabels`）让生成器在配置切换时写入 `runPolicy.appConnections`，并在顶层 `secretReferences` 里放一条用途为 `app-connection-client` 的引用（同名引用先去掉再加，重复上线结果不变）；密钥文件本身由 Andy 事先放在 `<stateRoot>/secrets/<引用>.<版本>`，生成器不碰它（见 [ADR 0311](0311-connecting-apps-through-remote-mcp.md#connect)）。

<a id="platform"></a>

### 生产平台和构建机

- linux-arm64 和 linux-x64 都是生产平台，上线包按目标机器的架构生成（Andy 2026-11-25 决定生产只放在 Oracle 东京 ARM 机）。
- 构建机是目标机器上一个没有 sudo 权限的构建账号，在那里构建和检查（`hermes/builder-arm64.json`）；只支持 arm64。原来给 x64 用的 Hermes 构建设置（[当时的构建设置文件](https://github.com/sixianli/himawari-agent/blob/7c8521fe5f55e7dd57c5bd52badd16eef647502e/scripts/delivery-mode/hermes/builder.json)）随 Hermes 不再当测试机一起删除。
- `scripts/ci/platforms.mjs` 承认 `linux-arm64`。本地运行时 `run.mjs` 给 `build` 检查补一个 ARM 成员；`ci/policy.json` 不加 ARM 成员，GitHub 上的 CI 仍不构建 ARM 产物。

<a id="migrations"></a>

### 数据库升级和历史数据比较

- 代码的数据库版本比生产高时，生成器从这个提交的 `migration-engine.ts` 取出要补的迁移写进维护脚本；`S7_CONFIG_APPLY` 换完配置后用新版本的 `himawari db migrate` 升库。出包时还要用这个提交装出来的 CLI 把一个真实的旧版本数据库升一遍。
- 迁移改写要保留的历史表时拒绝出包（`PACKET_MIGRATION_TOUCHES_PRESERVED_TABLES`）。登记过摘要的例外（`make-packet.py` 的 `ROW_PRESERVING_REBUILDS`、`ADDED_COLUMN_BACKFILLS`）才放行，摘要对不上照样拒绝。
- 历史数据只在服务停着时比较：S3、S7 按表摘要比，迁移前后比，S7 切换脚本在启动新版本前比较已保存的停服读回，S9 恢复后和 S3 读回比。S8 在新服务启动后运行，不再逐行比对生产库和 S3 副本，因为运行中的服务会合法地改旧行，分不清正常写入和损坏（[I-108](../incidents-and-gates.md#incidents)）。“新版本启动后代码写得对不对”归产品测试管。实例文件带 `historyComparison` 时以 `PACKET_HISTORY_COMPARISON_SWITCH_REMOVED` 拒绝出包。

<a id="preflight"></a>

### 上线前检查和步骤顺序

- 根分区空间按实测算：预计安装占用 = 包大小 + 上一版 S1 实际占用 × 1.2（没有记录时按 3 倍包大小），要求装完还剩 10 GiB 加 1 GiB 余量，否则在任何上线步骤之前停下（`ROOT_FREE_FOR_ACCEPTANCE`），日志打印 `PREFLIGHT_SPACE`。`/opt` 和状态盘要有两倍包大小。
- 清理之后 `/tmp` 里的验收现场目录（名字是 `h` 加 4 个字符）仍超过 1 个时，在停服前停下（`TMP_SCRATCH_WITHIN_LIMIT`），免得验收换了目录名或清理漏了而悄悄占满磁盘。
- 生产机上的验收挪到停服之前：步骤顺序是 `S1_TRANSPORT S1_INSTALL S6_ACCEPTANCE S2_STOP …`，验收失败时旧版本照常服务。环境变量 `HIMAWARI_DEPLOY_ACCEPTANCE_AFTER_STOP=1` 只在新顺序本身出问题时临时恢复旧顺序。

<a id="transfer"></a>

### 只传变了的东西

- 源码：生产机留一个只放 git 对象的仓库 `/opt/himawari/source-cache.git`（root 所有，组和其他人不可写）。出包时只读地问它有哪些已装过的提交，挑离目标提交最近的祖先做基点，生成增量包；没有可用基点就生成完整包，`--full-source` 强制完整包。安装时先 `git bundle verify` 再取进缓存，读回的提交号必须等于冻结值，然后照旧核对源码树指纹。上线前检查发现生产机缓存里没有基点就拒绝上传。缓存只增不减，清理不碰它。
- 大材料：实例文件的 `materialCache`（默认 16 MiB 到 1 GiB 之间的成员）冻结进包参数。传输前只读地查生产机 `/opt/himawari/material-cache/sha256/<SHA>` 里已有哪些，tar 流里不放它们；接收端从缓存核对大小和 SHA-256 后放回，再整体核对冻结清单。核对不符就删掉那条缓存并失败，下次自动整包传；缓存目录不安全或查询失败时照常整包传。
- 依赖包可复现：依赖收集脚本在每个依赖根下只收锁文件列出的包、`.bin` 和 `.package-lock.json`，跳过 `.vite`、`.vite-temp`、`.cache`，遇到其他不认识的条目以 `P5_MODULE_UNEXPECTED_ENTRY` 报错。

<a id="failure"></a>

### 失败时怎么办

- 自动上线（`scripts/delivery-mode/ci-deploy.sh`）在真正上线之前，先用 `scripts/delivery-mode/shadow-rehearsal.sh` 在生产机上开一台影子机（用 systemd 自带的容器工具 `systemd-nspawn` 把本机系统原样起一份：先在一个用完即丢的磁盘镜像文件上用 overlayfs（Linux 的叠层文件系统，下层只读、写入只落在上层）把本机根目录叠一层，再把叠好的目录交给 `systemd-nspawn`；它不接受直接把根目录 `/` 交给它再叠层，会报 “Spawning container on root directory is not supported”。网卡独立、连不到外网），把生产数据目录用 `scripts/delivery-mode/shadow-copy.py` 复制进去（数据库用 SQLite 的 `VACUUM INTO` 做一致副本），在里面原样跑一遍 `deploy.sh`，从停服、签名、迁移一直到读回。影子机里任何一步失败，就以 `SHADOW_REHEARSAL_FAILED` 停下，生产服务没停、也不用回滚（I-120：停服后才发现生产数据和程序假设对不上，已发生近 30 次）。做法参照 GitLab 在生产库克隆上真跑迁移、不通过不能合并（<https://docs.gitlab.com/development/database/database_migration_pipeline/>）；容器选项见 <https://man7.org/linux/man-pages/man1/systemd-nspawn.1.html>。放弃了“把升级脚本的路径改成参数、给服务程序加预演启动方式”的做法，因为新版服务启动要用停服后才生成的签名文件，那样预演不到签名和切换启动（Andy 2026-11-27 选定）。
- 自动上线（`scripts/delivery-mode/ci-deploy.sh`）在服务读回就绪后，以 root 运行 `scripts/operations/computers/install-computers.sh ensure`，装好或更新每人一台电脑的系统服务（见 [ADR 0298](0298-where-tools-run.md#user-computers)）。这一步失败不回退主服务，上线结果记为失败（`COMPUTERS_FAILED`）。
- `S2_STOP` 之前失败，旧版本继续服务。
- `S2_STOP` 或之后失败，看实例文件的 `onDeployFailure`（或环境变量 `HIMAWARI_DEPLOY_ON_FAILURE`）：`rollback` 时立即回退；`keep` 时不回退，失败的新版本和现场原样保留，要恢复时手动运行 `rollback.sh`。`andy-production` 设为 `rollback`（Andy 2026-11-26 开始真实使用后在决定卡上选了“自动退回上一版”，取代 2026-11-15 的“失败后不回滚，保留现场”）。

<a id="cleanup"></a>

### 清理上线留下的东西

- `deploy.sh` 在三个时点运行 `release-cleanup.py <操作包> apply`：上线前检查之前、上线成功之后、上线失败但旧版本仍在服务之后。回退也失败、或选了 `keep` 时不清理，现场全部留给诊断。清理失败不改变上线结果，只打印 `DEPLOY_CLEANUP_FAILED`。`plan` 模式只列出会删什么。另外，`ci-deploy.sh` 在生成新的上线包之前，先用上一次留下的上线包跑一遍清理（`CI_DEPLOY_PREVIOUS_CLEANUP`），让上次失败留下的目标目录不会挡住这一次（I-120）。
- 清什么由生产机当时的状态决定：远端脚本从 systemd 单元读出正在服务的版本和它的回退目标，`/opt/himawari/releases/` 只留这两个；正在服务的版本是手装的、没有记录回退目标（操作目录里没有绑定记录）时，照样清掉失败留下的目标路径，其余旧版本一律保留（`serving-release-has-no-recorded-rollback-target`）；`/var/tmp/` 下的上线副本只留正在服务那一版的 `packet/`；正在服务那一版的证据整个保留，其他证据里超过 10 MiB 的文件删除（最新 3 份数据库副本除外）；删之前把 1 MiB 以下的报告和日志复制到 `/var/lib/himawari/release-cleanup/<时间>/`，并写 `cleanup-report.json`。
- `/tmp` 里的验收现场：上线前那次清理留 1 份，上线成功后留 0 份，失败后留 1 份。只删名字、类型、权限、属主都符合、且没有进程在用的目录；测试 `test_release_cleanup.py` 核对清理和验收用的是同一套名字规则。
- 上次失败留在目标路径上的残留由清理自己处理：属于正在服务的版本、回退目标、被进程或数据库引用的、或是符号链接的，保留并报 `CLEANUP_TARGET_PATH_LEFT`，其余先把小文件复制到 `release-cleanup/failed-attempts/` 再删。失败现场最多留 2 份，总量超过 200 MB 时只留最新一份。清理后仍有路径被占用，`deploy.sh` 在预检前以 `target-paths-left` 停下。Andy 同意这作为长期规则，不再逐次授权。
- 宁可少删也不误删：单元文件或 `/etc/himawari/` 提到的、任何进程在用的、数据库里出现的路径都保留；读不出正在服务的版本、发现上线步骤正在运行、服务不是 active 时什么都不删；同一时间只允许一次清理。

<a id="rejected"></a>

## 放弃的做法

- 复制上一次的上线包再手改：容易漏改、改错，也没法在出包时把检查跑全。
- 停服后才在生产机上验收：验收失败时服务已经停了。
- 启动新版本后逐行比对历史数据：运行中的服务会合法地改旧行，比对只会误报。
- 每次整包上传源码和大材料：大部分内容和上一次一样，白白占上传时间。
- 失败残留一律保留、等人处理：每次都要 Andy 授权删除，上线卡住。

依据的原则：边界与可逆性（失败现场留报告和日志、只删能重新生成的内容）优先于主动性与效率（省下的上传时间和磁盘）。

<a id="consequences"></a>

## 后果

- 上线只需要选提交和目标机器，其余由生成器从机器和仓库读出来，换机器只改 `--host`。
- 上线包没过检查就出不来，`deploy.sh` 也不认手改的包。
- 生产机上同时最多留两个版本和少量失败现场，磁盘不会被历次上线慢慢占满。
- 选了 `keep` 时，失败的上线会让服务停着，直到修好重新上线或手动回退。
