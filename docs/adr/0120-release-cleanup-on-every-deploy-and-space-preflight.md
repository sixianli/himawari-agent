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
- [关联文档](#references)

<a id="context"></a>

## 背景

生产机（Contabo 云服务器 84.247.157.41）的根分区三次在上线前不够用，每次都靠人手删目录：

| 日期（日本时间） | 版本 | 现象 | 当时怎么办 |
| --- | --- | --- | --- |
| 2026-10-27 | 第十三版 | 上线前检查通过，装完新版本只剩 8.19 GB，验收要 10 GiB，停在停服前的验收 | 删掉第一到第九版的 8 个上线临时目录（17.6 GB）后重来；改进只记成 [BL-20261027-001](../backlog/BL-20261027-001-deploy-preflight-root-free-after-install.md) 和 [BL-20261027-002](../backlog/BL-20261027-002-prune-production-release-leftovers.md) |
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

<a id="references"></a>

## 关联文档

- [SOURCE: docs/adr/0074-claude-runs-production-deployments.md]
- 代码：`scripts/delivery-mode/deploy.sh`、`scripts/delivery-mode/release-cleanup.py`、`scripts/delivery-mode/release-cleanup-remote.py`、`scripts/delivery-mode/deploy-preflight.py`
- [ADR 0074：快速模式下由 Claude 直接执行生产上线、回滚和诊断](0074-claude-runs-production-deployments.md)
- [ADR 0086](0086-generate-release-packets-from-parameters.md)
- [BL-20261027-001](../backlog/BL-20261027-001-deploy-preflight-root-free-after-install.md)、[BL-20261027-002](../backlog/BL-20261027-002-prune-production-release-leftovers.md)
- [工程案例库：案例 65](../engineering-casebook.md#case-release-cleanup)
