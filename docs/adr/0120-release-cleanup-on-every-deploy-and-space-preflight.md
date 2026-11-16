---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0074-claude-runs-production-deployments.md"
date: "2026-10-30"
---

# ADR 0120：每次上线前后自动清理生产机上的上线临时产物，上线前检查按上次实际安装占用算“装完还剩多少”

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [与 ADR 0074 的关系](#amendments)
- [比较过的方案](#options)
- [后果](#consequences)
- [补充决定：保留最近 3 份数据库副本](#database-copies)
- [补充决定：只认现行配置和数据库里的有效记录，出包结束清 Hermes](#references-and-hermes)
- [补充决定：出包和上线脚本必须包含要上线的提交](#current-scripts)
- [补充决定：升级前副本和恢复留下的原库也各留最近 3 份](#state-copies)
- [关联文档](#references)

<a id="context"></a>

## 背景

生产机（Contabo 云服务器 84.247.157.41）的根分区三次在上线前不够用，每次都靠人手删目录：

| 日期（日本时间） | 版本 | 现象 | 当时怎么办 |
| --- | --- | --- | --- |
| 2026-10-27 | 第十三版 | 上线前检查通过，装完新版本只剩 8.19 GB，验收要 10 GiB，停在停服前的验收 | 删掉第一到第九版的 8 个上线临时目录（17.6 GB）后重来；改进只记成 [BL-20261027-001](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/backlog/BL-20261027-001-deploy-preflight-root-free-after-install.md) 和 [BL-20261027-002](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/backlog/BL-20261027-002-prune-production-release-leftovers.md) |
| 2026-10-29 | 第十九版 | 上线前空间不够 | 人手清出 4.8 GB |
| 2026-10-30 | 第二十版 | 上线前只剩 14.0 GB，每版装上去约用 4 GB | 人手删第十四、十八版失败上线留下的临时副本和上传包约 7.7 GB；第一次上线失败后 Andy 又打“删”清掉失败副本 |

代码里的原因（2026-10-30 读 `scripts/delivery-mode/` 确认）：

1. **清理步骤从来没被调用。** 每次上线在生产机 `/var/tmp` 留下三样东西：上传的整个操作包（`/var/tmp/<第几版>-packet-upload/`），S1 安装时再复制一份操作包、一份安装材料和一整套验证用的源码检出（含完整依赖目录 `node_modules`，`/var/tmp/himawari-<第几版>-<日期>/`）。操作包模板里有专门删它们的 S9 步骤（`install/S9-clean-transport.py`），但 `deploy.sh` 的步骤列表里没有它，安装脚本自己也写明“验证材料保留到全部完成”（`validationMaterialsRemoved: false`）。
2. **失败后只改名不删。** 重试时上线前检查遇到上次留下的目录，提示“改名为 .attemptN-failed-日期”，改名不释放空间。
3. **生产机没有定时清理。** 每天 04:00 的清理（`scripts/disk-hygiene/install-schedule.sh`）只装在 Mac 和 Hermes 上。
4. **旧版本全部永久保留。** `/opt/himawari/releases/` 里没有“只留最近几版”的规则；每次上线的数据库恢复点（停服后整库复制，约 0.3 GB）也都留在各版证据目录里。
5. **空间检查是写死的数。** 上线前检查要求根分区空闲不少于“10 GiB + 2 倍包大小”。10 GiB 是验收脚本 `run-stage-03.py` 自己要的空闲，但 S1 安装实际用掉的空间（第十三版约 3 GB）不是 2 倍包大小能估准的。

第十三版那次的改进只写进了 Backlog，没有落成自动检查，所以同样的事又发生了两次。2026-10-30 09:30（日本时间）Andy 定为项目指令：任何测试和发布完成后（含失败的尝试）都要自动清理临时测试产物和临时发布产物，不许只改名留下，只留证据、日志小文件和用于回退的最近一版。

<a id="decision"></a>

## 决定

1. **`deploy.sh` 在三个时点调用 `scripts/delivery-mode/release-cleanup.py <操作包> apply`：** 上线前检查之前（清掉以前失败或中断留下的东西）；上线成功之后；上线失败但旧版本仍在服务之后（停服前就失败，或停服后失败并已自动回退）。自动回退也失败时不清理，现场全部留给诊断。操作包没通过生成检查或网页走查时，生产机一点不碰，也不清理。清理失败不改变上线结果，只打印 `DEPLOY_CLEANUP_FAILED`。
2. **清理规则只由生产机当时的状态决定，而不是由调用时点决定。** 远端脚本 `release-cleanup-remote.py` 从 systemd 单元文件的 `ExecStart` 读出正在服务的版本目录和它的操作目录，再从该操作目录的 `inputs/bindings.json` 读出它的回退目标版本（`oldPrefix`）。然后：
   - `/opt/himawari/releases/` 只留正在服务的版本和回退目标版本，其余删除；
   - `/var/tmp/` 里名字是 `himawari-<第几版>-<日期>[...]` 或 `<第几版>-packet-upload[...]` 的目录全部删除，只有正在服务那一版的 `packet/` 留着（`rollback.sh` 回退时要用它校验操作包）；
   - 本次操作包失败时新建的操作目录删除；各版证据目录里超过 10 MiB 的文件（数据库恢复点）删除，正在服务那一版的证据目录整个保留（回退要用它的恢复点）；本次失败的证据目录改名为 `.attempt-failed-<时间>` 让重试能用原路径，里面只剩小文件；
   - 删之前，把要删目录里 1 MiB 以下的报告、日志、结果文件（`.json`、`.log`、`.txt`、`.stdout`、`.stderr` 等，不含操作包副本、源码检出和安装材料）复制到 `/var/lib/himawari/release-cleanup/<时间>/`，并写 `cleanup-report.json`，列出删了什么、各多大、留了什么和为什么。
3. **宁可少删也不误删。** 下列情况保留并写明原因：单元文件或 `/etc/himawari/` 下的文件提到这个路径；任何进程的工作目录、程序、打开的文件、加载的库或命令行用到它；数据库（含 WAL 日志文件）里出现这个版本目录。读不出正在服务的版本时什么都不删（`CLEANUP_SERVING_RELEASE_UNKNOWN`）；发现上线步骤正在运行时什么都不删（`CLEANUP_RELEASE_STEP_RUNNING`）；同一时间只允许一次清理（`/run/lock/himawari-release-cleanup.lock`）；服务不是 active 时不清理。`plan` 模式只列出会删什么，不动文件。
4. **上线前检查改为按实际算。** `deploy-preflight.py` 从正在服务那一版证据目录的 `s1-result.json` 读出它 S1 安装实际用掉的根分区空间，预计本次安装占用 = 包大小（上传）+ 上次 S1 占用 × 1.2；没有记录时按 3 倍包大小。要求“现在空闲 − 预计安装占用 ≥ 10 GiB（验收要的）+ 1 GiB 余量”，否则在任何上线步骤之前停下（`ROOT_FREE_FOR_ACCEPTANCE`）。日志里新增一行 `PREFLIGHT_SPACE`，写出现在空闲、预计占用、预计装完还剩多少、要求多少、是否来自实测。因为清理在检查之前，检查看到的是清理后的空间。

<a id="amendments"></a>

## 与 ADR 0074 的关系

[ADR 0074](0074-claude-runs-production-deployments.md#decision) 的“预检不过就停，生产机一点不碰”改为：预检之前先清理已经不用的上线临时产物；预检不过时，正在服务的版本、配置、数据库都没被改动。根分区的空间要求改为[决定](#decision)第 4 条的算法；`/opt` 和状态盘“至少两倍包大小”的检查不变。

<a id="options"></a>

## 比较过的方案

| 方案 | 好处 | 代价 | 结论 |
| --- | --- | --- | --- |
| 把现有 S9 步骤 `S9_TRANSPORT_PREFLIGHT` / `S9_TRANSPORT_APPLY` 加进 `deploy.sh` | 复用已有脚本，检查最严 | 只在 S6–S8 全部通过后才能跑，失败路径用不上；只管本次的 `/var/tmp/himawari-*`，不管上传包、旧版本、以前失败的改名目录；它要求先人工审一遍计划、30 分钟内再执行，不适合自动跑 | 不选 |
| 生产机装每天定时清理（同 Mac、Hermes 的 04:00） | 不依赖上线流程 | 上线临时产物只在上线时产生，上线前后各清一次已经覆盖；定时任务要另外装到生产机、要处理与上线同时运行；多一个常驻的东西 | 暂不做。上线前那次清理就是兜底：上次中断没清的，下次上线开始前一定会清 |
| 新版本的依赖目录与旧版本共用（硬链接或共享目录） | 每版省下依赖目录的空间 | 安装脚本逐个检查文件必须只有一个硬链接（`st_nlink == 1`）、目录归 root、不可写，共享会打破这些检查，也让回退版本受新版本影响 | 不选；只留两版后旧版本的依赖目录不再累积 |
| 只把空间门槛调高 | 改一行 | 不解决累积，只是更早报错 | 不选 |
| 本方案：上线前后各清一次 + 按上次实测预估 | 成功、失败、中断三种情况都清；只留回退要用的；预估随实际变化 | 远端脚本要扫一遍进程和数据库（数据库约 0.3 GB，顺序读不到 1 秒） | 采用 |

业界做法（一手来源）：Capistrano（Ruby 社区常用的部署工具）的配置项 `:keep_releases` 默认 5，说明是 “The last `n` releases are kept for possible rollbacks.”（[Capistrano 配置文档](https://capistranorb.com/documentation/getting-started/configuration/)）；Kubernetes 的 kubelet（每台机器上管理容器的程序）按磁盘占用自动删镜像：“Disk usage above the configured `HighThresholdPercent` value triggers garbage collection”，并且 “The kubelet deletes images until disk usage reaches the `LowThresholdPercent` value.”（[Kubernetes 垃圾回收文档](https://kubernetes.io/docs/concepts/architecture/garbage-collection/)）。两者都是“由工具自动删，只留回退需要的”，不靠人记得删。本项目只留 2 版，因为 Andy 的指令是“只留用于回退的最近一版”，而回退流程只会回到上一版。

<a id="consequences"></a>

## 后果

- 好处：每次上线结束后，`/var/tmp` 只剩正在服务那一版的操作包，`/opt/himawari/releases/` 只剩两版；失败重试不再要人改名；空间不够在上线前就停下，并说明预计装完还剩多少。
- 代价：只能回退到上一版；更早的版本要重新出包。旧证据目录里的数据库恢复点被删，只剩小文件。
- 自动检查：`scripts/delivery-mode/test_release_cleanup.py`（清理规则 11 条）和 `scripts/delivery-mode/test_deploy.py` 的 `ProductionCleanupFlowTest`、`RootSpacePreflightTest`。去掉本次对 `deploy.sh` 和 `deploy-preflight.py` 的修改时，新增的 10 条中 7 条失败、2 条报错。事故记录 I-33（[事故与门槛清单](../incidents-and-gates.md)）。
- 待做：第一次在生产机实际运行要等下一次上线，届时核对 `cleanup-report.json` 删除的路径和释放的空间。Hermes 上出包用的工作目录和 Mac 上的测试产物按同一条指令另行处理。

<a id="database-copies"></a>

## 补充决定：保留最近 3 份数据库副本

2026-10-30 10:30（日本时间），Andy 在选择卡上选了“留最近 3 份”。第二十版上线前的清理计划显示，各版证据目录里有 32 份升级前的数据库原样副本，共 3.81 GiB。正式备份还没做，这些副本就是现有的全部数据库备份。

因此[决定](#decision)第 2 条“各版证据目录里超过 10 MiB 的文件删除”加一个例外：所有证据目录中，路径含 `*-raw-schema<编号>*/data/` 的数据库副本，按修改时间保留最新的 3 份（`release-cleanup.py` 的 `KEEP_DATABASE_COPIES`），清单里标为 `recent-database-copy`，其余照删。正在服务那一版的证据目录仍整个保留，它的副本也计入这 3 份。测试：`test_release_cleanup.py` 的 `test_the_three_newest_database_copies_stay_and_older_ones_go`。

<a id="references-and-hermes"></a>

## 补充决定：只认现行配置和数据库里的有效记录，出包结束清 Hermes

第二十版上线时，第一次实跑的清理按“被提到就不删”留下了 7 个旧版本。2026-10-30 在生产机上只读核查（`/mnt/project-files/release-references-production-20261030T0220Z.txt`）的结果：

- 第一、八、十版只在 `/etc/himawari/config.json.before-*` 这 4 份旧配置备份里出现，现行的 `config.json` 和单元文件都没有提到它们。
- 用 SQL 查数据库现有的行，没有一行提到第五、七、十一、十八版。原规则是把数据库文件按字节整个扫一遍，会扫到已删除的行留在空闲页里的旧内容，所以误判成“数据库还在用”。

改为：

1. 配置只看单元文件和现行的 `config.json`（`release-cleanup.py` 计划里的 `config`），不看同目录下的备份文件。
2. 数据库改为用只读连接、SQL 逐表查现有行的每一列。查到才保留，原因写成 `named-by-database:<表>.<列>`，下次能直接看出是哪张表；查不了的表列在 `unreadableTables` 里。
3. `make-packet.py prepare` 不论成功还是失败，结束时都删掉 Hermes 上这次出包的可重建副本：`<工作目录>/materials`、`<工作目录>-checks/packet`、`<工作目录>-inputs/packet.tgz` 和上传的源码包，日志和报告保留；同时删掉 Mac 上的临时工作目录 `packet-work-*`。原来出包失败时这个目录（含约 1 GB 的安装材料）会一直留在 Mac 的临时目录里。

测试：`test_release_cleanup.py` 的 `test_a_deleted_database_row_that_still_sits_in_free_pages_does_not_keep_a_release`、`test_an_old_configuration_backup_does_not_keep_a_release`，以及 `test_make_packet.py` 的 `HermesCleanupTest`（3 条）。在原代码上，前两条失败，后 3 条报错。

<a id="current-scripts"></a>

## 补充决定：出包和上线脚本必须包含要上线的提交

本 ADR 的清理逻辑写在 `deploy.sh`、`release-cleanup.py` 和 `make-packet.py` 里，只有从包含这些改动的检出里运行才会生效。2026-10-30 Mac 线程确认：第十九、二十版都是从 `origin/main` 的临时检出出包和上线的，但 Mac 上的主工作区停在旧分支 `claude/isolated-tool-execution`，那里的脚本没有这些清理。有人在主工作区直接运行，就会用旧代码，而且什么提示都没有。

改为：

- `make-packet.py prepare` 先检查自己所在检出的 `HEAD` 是否包含要出包的提交，不包含就停下（`PACKET_SCRIPTS_OLDER_THAN_COMMIT`）。
- `deploy.sh` 检查自己所在检出是否包含操作包的提交（`script-checkout-gate.py`），不包含就退出码 7、结果 `old-scripts`，生产机一点不碰。

测试：`test_deploy.py` 的 `ScriptCheckoutGateTest`，`test_make_packet.py` 的 `ScriptCheckoutTest`。在原脚本上，前者 1 条失败，后者 2 条报错。主工作区要不要切回 `main`，由 Andy 决定。

<a id="state-copies"></a>

## 补充决定：升级前副本和恢复留下的原库也各留最近 3 份

2026-10-31 核对第二十二版上线后的生产机（`/mnt/project-files/r22-db-copies.txt`），清理没有碰 `state/data/pre-migration-*`（11 份，约 2.0 GB）和 `state/.raw-restore-*-original`（5 份，约 1.0 GB）。前者由 `apps/admin-cli/src/index.ts` 在数据库升级时创建，后者由 `raw-copy-recovery.mjs` 在恢复时创建；仓库里没有任何代码在创建之后读取或删除它们，回退用的是证据目录里的恢复点。Andy 在选择卡上选了“纳入，各留最近 3 份”。

改为：`release-cleanup-remote.py` 在 `state/data` 下按修改时间保留最新 3 个 `pre-migration-*`，在 `state` 下保留最新 3 个 `.raw-restore-*-original`，其余整个目录删除（`old-state-copy`）；保留的标为 `recent-state-copy`；被单元文件、现行配置或运行中进程提到的照旧保留。数据库文件本身 `state/data/product.sqlite` 不在匹配范围内。数量由计划里的 `keepStateCopies` 决定（`release-cleanup.py` 的 `KEEP_STATE_COPIES`）。按清单估算可再释放约 1.25 GB，未实测。

测试：`test_release_cleanup.py` 的 `test_the_three_newest_upgrade_and_restore_copies_stay_and_older_ones_go`、`test_plan_mode_keeps_upgrade_and_restore_copies`、`test_an_old_upgrade_copy_named_by_a_process_is_kept`、`test_plan_keeps_three_upgrade_and_restore_copies_under_the_state_root`。

<a id="references"></a>

## 关联文档

- [SOURCE: docs/adr/0074-claude-runs-production-deployments.md]
- 代码：`scripts/delivery-mode/deploy.sh`、`scripts/delivery-mode/release-cleanup.py`、`scripts/delivery-mode/release-cleanup-remote.py`、`scripts/delivery-mode/deploy-preflight.py`
- [ADR 0074：快速模式下由 Claude 直接执行生产上线、回滚和诊断](0074-claude-runs-production-deployments.md)
- [ADR 0086](0086-generate-release-packets-from-parameters.md)
- [BL-20261027-001](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/backlog/BL-20261027-001-deploy-preflight-root-free-after-install.md)、[BL-20261027-002](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/backlog/BL-20261027-002-prune-production-release-leftovers.md)
- [工程案例库：案例 65](../engineering-casebook.md#case-release-cleanup)
