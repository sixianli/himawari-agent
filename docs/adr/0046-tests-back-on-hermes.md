---
status: active
document_type: adr
decision_status: accepted
supersedes: "docs/adr/0045-short-test-temp-root.md,docs/adr/0044-tests-on-cloud-server.md,docs/adr/0043-push-every-commit-full-test-before-merge.md,docs/adr/0042-hermes-test-scratch-on-root-disk.md,docs/adr/0041-test-hosts-and-production-server.md,docs/adr/0038-test-layer-trigger-timing.md"
superseded_by: ""
date: "2026-10-02"
---

# ADR 0046：测试回到 Hermes，云服务器只用于生产

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
  - [测试和部署的位置](#hosts)
  - [Hermes 上的连接、账号和目录](#storage)
  - [测试时限不放宽](#time-limits)
  - [测试层级和触发条件](#layers)
  - [提前运行完整测试的情况](#early-full)
  - [提交、推送与结果复用](#commits)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

[ADR 0045](0045-short-test-temp-root.md) 规定测试在云服务器 `84.247.157.41` 上以普通用户 `himawari-test` 运行，Hermes（局域网里的 Linux 服务器）不再使用。

在云服务器上跑测试遇到的主要问题是慢：这块虚拟磁盘每次同步写入要 11–19 毫秒，产品的 SQLite 每次提交都要等数据落盘，所以完整 `npm test` 的五个测试项目合计约 70.8 分钟，远超 `ci/policy.json` 的 30 分钟总时限。为此用户在 2026-10-01 和 10-02 先后同意只在云端放宽测试时限（[BL-20261001-002](../backlog/BL-20261001-002-回-到-同-步-写-入-快-的.md)）。作为对照，2026-09-28 在 Hermes 上同样的完整测试（临时数据放在固态根盘）五个项目合计约 26 分钟。

2026-10-02 用户决定：

> 我现在决定，把这个项目的测试放在hermes上做，至于如何ssh hermes，请参考ssh hermes skill。以后不再在我的云服务器上进行测试，云服务器只用于发布生产。

随后用户在两道选择题里又定了两件事（原文见第二轮长任务目录的 `goal.md`，G20、G21）：

- 云端的时限放宽方案整个撤掉：Hermes 一律用默认时限，超时就当缺陷修。
- 云服务器上已有的测试环境先保留，不登录、不改动、不再写入，等首次生产部署前再一起清理。

同一天核对 Hermes 的现状：`ssh hermes` 连通，主机名 `hermes-home`；Ubuntu 22.04.5，4 核、15 GiB 内存；根盘是 110 GB 的 NVMe 固态盘，可用约 14 GiB；`/data` 是 466 GB 的机械硬盘，可用约 197 GiB；`/tmp` 在根盘上；`/usr/bin/bwrap` 是 0.6.1；登录账号的默认 umask 是 `0002`。

<a id="decision"></a>

## 决定

<a id="hosts"></a>

### 测试和部署的位置

1. **开发 Mac 不跑测试。** 沿用 ADR 0043：MacBook 只用来编辑代码、审核和提交。
2. **测试在 Hermes 上跑。** 第 0–3 层和 Linux 产品路径验证都在 Hermes 上运行。按这个决定在 Hermes 上跑测试，不需要每次再问用户。需要 sudo、改动 Hermes 上的系统设置或服务时，先给用户脚本并逐步说明，由用户执行。
3. **云服务器 `84.247.157.41` 只用于生产。** 不在上面跑任何测试、构建或测试资格验证。部署生产版本、启动或改动生产服务，每次都要用户明确授权。
4. **云服务器上原有的测试环境先原样保留。** 测试账号 `himawari-test`、`/srv/himawari-test/` 下的代码、依赖和证据，不登录、不改动、不再写入；首次生产部署之前再按用户的决定一起清理。bubblewrap 0.11.2 和它的 AppArmor 规则生产也要用，一直保留（见 [BL-20261001-001](../backlog/BL-20261001-001-ubuntu-24-04-默-认-禁-止-bwrap.md)）。
5. **不碰 Hermes 上与测试无关的东西。** Hermes 上还运行着其他服务，包括 `/data/hermes/himawari/releases/` 下原有的 Himawari 常驻服务。测试不读写这些服务的目录和数据，不停止或重启它们。
6. **Mac 定向验证仍无限期推迟。** 沿用 ADR 0043：在用户重新安排之前，Mac 上的行为写成“未在 Mac 上验证”。

<a id="storage"></a>

### Hermes 上的连接、账号和目录

连接按 `hermes-ssh` skill：使用 Mac 上已有的 SSH 别名 `hermes`，它经 `cloudflared`（Cloudflare 的命令行代理）建立通道，再用本机已有的密钥登录。非交互命令写成 `ssh -o BatchMode=yes -o ConnectTimeout=15 hermes '<命令>'`。需要 Cloudflare 浏览器授权时请用户完成；不为绕过连接失败去改 SSH 配置、凭据或主机密钥检查。

| 内容 | 放在哪里 |
| --- | --- |
| 运行测试的账号 | SSH 配置里的登录账号；不新建账号，不用 sudo 跑测试 |
| 源码检出、npm 依赖、固定工具链、浏览器、构建产物、日志、测试报告和保留的证据 | 机械盘上本任务的目录，例如第二轮工具执行排查用 `/data/hermes/himawari/tool-audit-round2/` |
| 测试**运行中**产生的临时数据：SQLite 文件、socket、产品路径测试安装、测试进程的 `TMPDIR` | 每次运行用 `mktemp -d /tmp/hXXXX`（按模板新建一个名字末尾随机的目录）新建的 10 字节独占目录，权限 0700；同时设为 `HIMAWARI_TEST_TEMP_ROOT` 和 `TMPDIR` |

临时目录放在根盘，是因为它在固态盘上：2026-09-30 在机械盘上跑 unit 组，2,144 项里有 67 项因同步写入慢而超时（[ADR 0042](0042-hermes-test-scratch-on-root-disk.md)）。临时目录必须是 10 字节的短路径，原因见 [ADR 0045 的存放规则](0045-short-test-temp-root.md#storage)：产品路径测试里最长的 Unix 套接字路径比临时根多 95 字节，而 Linux 上限是 107 字节。

根盘空间小，下面几条规则继续执行：

1. **跑之前查空间。** 每次运行前用 `df` 检查根盘，可用空间低于 10 GiB 就不启动，写停止文件说明。
2. **记录峰值。** 记录临时目录的最大占用和根盘的最低可用空间，写进这次运行的证据。
3. **跑完就收走、删掉。** 需要保留的失败现场先复制到机械盘上的证据目录，再删除这次运行的临时目录。删除前按 `AGENTS.md` 的 “Disk Space Hygiene” 核对没有进程还在用它。
4. **只删自己建的目录。** `/tmp` 是公共目录，只能删除本次运行自己创建的 `/tmp/h*` 目录。
5. **创建后先核对。** 核对临时根的属主是测试账号、权限是 0700、`realpath`（求出目录真实位置的命令）的结果与原路径相同，并把路径和字节数写进运行记录。
6. **用 `umask 022` 运行测试。** 登录账号默认的 `0002` 会让测试建的目录成为组可写，沙箱会把它们当作不安全的宿主路径拒绝（2026-10-01 在云服务器上因此有约 100 项失败，见 [BL-20261001-004](../backlog/BL-20261001-004-安-装-结-果-继-承-安-装.md)）。

<a id="time-limits"></a>

### 测试时限不放宽

- Hermes 上使用项目原有的时限：`ci/policy.json` 的总时限，Vitest 各项目的默认时限，测试里写死的时限，都不改。
- 不设置 `HIMAWARI_TEST_TIMEOUT_MS`。为云端增加的这个变量及其代码，按 [BL-20261001-002](../backlog/BL-20261001-002-回-到-同-步-写-入-快-的.md) 撤掉。
- 2026-10-02 为云端设计的“总时限 110 分钟、测试自己的时限 4 倍”没有实施，也不再实施。
- Hermes 上出现超时，作为缺陷查原因并修复，不再提议放宽。

<a id="layers"></a>

### 测试层级和触发条件

沿用 ADR 0043，只把运行位置换成 Hermes：

| 层级 | 内容 | 在哪里跑 | 什么时候运行 |
| --- | --- | --- | --- |
| 第 0 层：定向测试 | 能复现缺陷或验证新行为的测试，以及直接相关的测试文件 | Hermes | 改生产代码之前先运行，证明它失败；之后每次修改都运行同一测试 |
| 第 1 层：静态检查 | `npm run check`（格式、代码规范、类型、模块边界等） | Hermes | 每次提交之前 |
| 第 2 层：受影响模块测试 | 改动所在的整个测试组，以及引用了被改模块的集成测试文件 | Hermes | 一个缺陷或功能修稳定、准备提交时 |
| 第 3 层：完整测试 | 构建安装包，再运行完整 `npm test` | Hermes | 一批改动准备交付审核或验收时；开 PR（合并请求）或合并之前；一轮工作结束时；以及[提前运行完整测试的情况](#early-full) |
| 第 4 层：真实产品路径 | 真实安装后，按用户操作走一遍产品场景 | Linux 版在 Hermes 上，装在测试账号自己的目录里；Mac 版推迟 | 改动影响安装、升级、进程管理或沙箱运行时行为时，只运行相关场景；不加筛选的完整版本，只在一轮工作结束或发布之前运行 |
| 第 5 层：生产部署 | 部署到云服务器 `84.247.157.41` 的生产位置 | 云服务器 | 每次部署都要用户明确授权 |

补充规则沿用 ADR 0043：一批通常不超过 3 个互相独立的缺陷；先完成第 0–2 层和自查，再跑第 3 层；第 3 层失败就回到第 0 层，修好后只对这一批的最终版本再跑一次；只改文档时只运行文档校验和 Runbook（操作手册）封存检查。

<a id="early-full"></a>

### 提前运行完整测试的情况

沿用 ADR 0043。改动涉及下列公共部分时，这一次改动就要单独跑第 3 层：

- 产品数据库（SQLite）的表结构或迁移；
- Agent Service（负责对话和数据库的服务进程）与 Execution Worker（执行工具的进程）之间的通信协议、认证或握手；
- 构建和打包配置、依赖声明或锁文件；
- 测试运行方式本身，例如 Vitest 的配置、`scripts/ci/` 下的测试脚本或 `ci/policy.json`。

<a id="commits"></a>

### 提交、推送与结果复用

- 沿用 ADR 0043：每个独立缺陷单独提交，提交前通过第 0–2 层；每个提交创建后立即推送到 `origin` 的同名分支，第一次推送时设置上游；不 force-push、不改写已推送的历史、不绕过 hook，推送被拒绝或失败就停下报告。推送过的提交不等于完整测试过的提交，提交说明只写实际跑过的层级和运行位置。开分支、打标签、开 PR、合并仍要用户明确要求。
- **不同机器的结果不能互相代替。** Hermes 是 Ubuntu 22.04，生产云服务器是 Ubuntu 24.04，处理器、内存和磁盘也不同。Hermes 上的结果不能证明生产机上的沙箱、AppArmor 和计时行为；云服务器上以前得到的测试结果只作历史记录。Mac 与 Linux 的结果也不能互相代替。
- GitHub 上合并 PR 之前必须通过的 CI 检查，仍由 `ci/policy.json` 规定。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

### 方案 A：测试回到 Hermes，云服务器只做生产（采用）

- 好处：Hermes 的固态根盘同步写入快，完整测试在原有时限内能跑完，不需要放宽时限；测试和生产分在两台机器上，测试不会挤占生产机的资源，也不会误碰生产目录。
- 代价：Hermes 根盘只剩约 14 GiB，每次运行都要查空间；Hermes 上还有其他服务，测试负载会和它们相互影响；Hermes 是 Ubuntu 22.04，生产机特有的问题（例如 24.04 的 AppArmor 限制）要在部署时另外验证。

### 方案 B：继续在云服务器上测试并放宽时限

- 不采用：用户决定云服务器只用于生产。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- `AGENTS.md` 的 “Test and Production Hosts”、“Test Trigger Timing”、“Pushing Commits”、“Disk Space Hygiene” 改为引用本 ADR，原 “Cloud Test Server Connectivity” 改为 Hermes 的连接规则。
- 第二轮工具执行排查的条目 R2-E2（云端放宽时限）按用户决定撤回；各条目完成条件里的测试主机从云服务器改为 Hermes。
- [BL-20261001-002](../backlog/BL-20261001-002-回-到-同-步-写-入-快-的.md) 的恢复工作开始执行：撤掉 `HIMAWARI_TEST_TIMEOUT_MS`，在 Hermes 上按默认时限跑通第 2、3 层。
- **待核对**：产品的 Linux 隔离后端要求 bubblewrap 0.11.2 或更新版本，Hermes 只有系统自带的 0.6.1。需要真实 0.11.2 的测试在 Hermes 上会跳过还是失败，第一次运行时核对；如果要在 Hermes 上安装 0.11.2，属于新下载和系统改动，先问用户。
- 首次生产部署计划要改为：安装包在 Hermes 上构建，带着提交号和 SHA-256 到生产机安装；部署前先按用户决定清理云服务器上的测试环境。
- 生产 `privateRoot` 不超过 27 字节的长度上限（[BL-20261002-002](../backlog/BL-20261002-002-生-产-privateroot-超-过-27-字-节.md)）不受影响。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- 被取代的决定：[SOURCE: docs/adr/0045-short-test-temp-root.md]
- 更早的测试位置和测试时机决定，原先由 ADR 0045 取代，现在一并由本 ADR 取代（文档校验要求取代者必须有效，所以它们的 `superseded_by` 都指向本 ADR）：[SOURCE: docs/adr/0044-tests-on-cloud-server.md]、[SOURCE: docs/adr/0043-push-every-commit-full-test-before-merge.md]、[SOURCE: docs/adr/0042-hermes-test-scratch-on-root-disk.md]、[SOURCE: docs/adr/0041-test-hosts-and-production-server.md]、[SOURCE: docs/adr/0038-test-layer-trigger-timing.md]
- 测试时限的放宽与撤销：[SOURCE: docs/backlog/BL-20261001-002-回-到-同-步-写-入-快-的.md]
- 生产机的 bwrap 前提：[SOURCE: docs/backlog/BL-20261001-001-ubuntu-24-04-默-认-禁-止-bwrap.md]
- 测试账号 umask：[SOURCE: docs/backlog/BL-20261001-004-安-装-结-果-继-承-安-装.md]
- 生产 `privateRoot` 的长度上限：[SOURCE: docs/backlog/BL-20261002-002-生-产-privateroot-超-过-27-字-节.md]
- 首次生产部署计划（目前暂缓）：[SOURCE: docs/execution/plans/2026-09-30-production-first-deployment-plan.md]
- 进行中的工具执行排查：[SOURCE: docs/execution/plans/2026-09-28-tool-execution-audit-plan.md]
