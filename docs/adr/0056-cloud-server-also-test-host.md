---
status: superseded
document_type: adr
decision_status: superseded
supersedes: ""
superseded_by: "docs/adr/0057-batch-layers-one-two-for-small-defects.md"
date: "2026-10-14"
---

# ADR 0056：云服务器同时作为受限测试机

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
  - [测试和部署的位置](#hosts)
  - [云服务器上的测试账号和限制](#cloud-test-host)
  - [生产部署的限定主机验收（不变）](#first-install-acceptance)
  - [Hermes 的连接和目录（不变）](#storage)
  - [时限不放宽、测试层级、提交推送（不变）](#unchanged)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

[ADR 0052](0052-third-production-host-acceptance-exception.md) 及其前序 ADR 规定：项目测试只在 Hermes（家里的测试服务器，4 核 i5-6300HQ、15.8 GiB 内存）上跑，云服务器 `84.247.157.41` 只用于生产。

2026-10-14 第二轮工作中，一批改动约 85% 的时间花在等 Hermes 上的测试：完整 `npm test` 的测试阶段约 26 分钟（长任务条目 R2-T4），几批改动只能排队用同一台机器。Claude 建议另租一台更强的测试机，用户在长任务 `goal.md` G100 回答：

> 同意，这样吧，把云服务器也可以当作测试机器

Claude 随后说明了代价：云服务器只有 4 核、7.8 GiB 内存、没有交换空间（内存用完时没有磁盘可以临时顶替），正在跑生产服务；用它测试不会让单次测试变快，好处只是两批改动可以在两台机器上同时测试，还可能拖慢生产服务或因内存不足让系统杀掉生产进程。用户仍选择“就用 84.247.157.41”。

同日用户批准了一个由 root 执行的脚本（`setup-himawari-ci.sh`），新建测试账号并给它设资源上限；配套的撤销脚本 `revert-himawari-ci.sh` 能删除账号、目录和上限设置。两份脚本和执行读回保存在开发 Mac 的 `.ci-output/cloud-test-host-2026-10-14/`。

本 ADR 取代 ADR 0052，只改“云服务器只用于生产”这一条；ADR 0052 的其他规则全部保留，下面重述当前有效的部分。ADR 0052 的正文保留为历史记录。

<a id="decision"></a>

## 决定

<a id="hosts"></a>

### 测试和部署的位置

1. **开发 Mac 不跑测试。** MacBook 只用来编辑代码、审核和提交。Mac 定向验证仍无限期推迟，Mac 上的行为写成“未在 Mac 上验证”。
2. **Hermes 和云服务器都是测试机。** 第 0–4 层可以在任一台上跑；Claude 按当时哪台空闲分配批次，同一批的第 0–2 层和第 3 层尽量在同一台上跑。在 Hermes 上的规则见[Hermes 的连接和目录](#storage)，在云服务器上的规则见[云服务器上的测试账号和限制](#cloud-test-host)。需要 sudo 或改两台机器系统设置的事，仍由 Claude 写脚本逐步说明、用户执行。
3. **生产仍在云服务器 `84.247.157.41`。** 部署生产版本、启动或改动生产服务，每次都要用户明确授权。生产部署的限定主机验收规则不变，见[下文](#first-install-acceptance)。
4. **不碰两台机器上与测试无关的东西。** Hermes 上 `/data/hermes/himawari/releases/` 下原有的 Himawari 服务和其他服务，云服务器上的生产服务 `himawari-prod.service` 及其目录，测试都不读写它们的数据，不停止或重启它们。
5. **结果不能互相代替。** Hermes 是 Ubuntu 22.04、bubblewrap（沙箱用来隔离进程的程序）0.6.1；云服务器是 Ubuntu 24.04，有 AppArmor（Ubuntu 限制程序权限的安全模块）对用户命名空间的限制，和生产相同。云服务器上测试账号的结果可以说明“Ubuntu 24.04 加这台机器的 AppArmor 设置下，测试账号自己的安装能否工作”，但不等于生产安装已验证（生产用的是另一个账号、另一套目录和真实配置）。Hermes 的结果不能证明 Ubuntu 24.04 上的沙箱行为；Mac 与 Linux 的结果也不能互相代替。

<a id="cloud-test-host"></a>

### 云服务器上的测试账号和限制

| 项 | 规定 |
| --- | --- |
| 账号 | 普通用户 `himawari-ci`（uid 1001），没有 sudo。测试只以这个账号运行；不用 root，不用生产服务账号 |
| 登录 | `ssh himawari-ci@84.247.157.41`，用 Mac 上已有的密钥。opencode、Grok 等代为编码的工具也只能用这个账号登录；root 登录和生产操作包装脚本对它们仍然禁止 |
| 目录 | `/srv/himawari-ci/`（属主 `himawari-ci`，权限 750）：`tools/`（固定工具链）、`browsers/`（测试浏览器）、`source/`（源码检出和依赖）、`evidence/`（保留的证据） |
| 临时目录 | 每次运行 `mktemp -d /tmp/hXXXX`，规则与 Hermes 相同：10 字节、属主是测试账号、权限 0700、`realpath` 等于自身，同时设为 `HIMAWARI_TEST_TEMP_ROOT` 和 `TMPDIR`，运行后删除 |
| 资源上限 | systemd（Linux 的服务和进程管理程序）给这个账号的全部进程设了上限（`/etc/systemd/system/user-1001.slice.d/50-himawari-ci-limits.conf`）：内存最多 6 GiB（`MemoryMax=6G`），不用交换空间（`MemorySwapMax=0`），CPU 和磁盘的争用权重都是 10（生产服务默认 100，争用时生产服务优先），进程数最多 4096。超过内存上限时系统只杀这个账号里的进程，不杀生产服务 |
| 工具和依赖 | 从 Hermes 拷贝已校验的下载缓存，再用项目的 `scripts/ci/install-tools.mjs --directory /srv/himawari-ci/tools` 离线安装（命中缓存时逐个核对 SHA-256，不联网）。新下载仍需用户先批准 |
| 运行方式 | `umask 022`；不设 `HIMAWARI_TEST_TIMEOUT_MS`；时限不放宽；长命令用 `setsid nohup` 后台启动，结果写文件 |

**每次重测试（构建、整个 Vitest 项目、完整 `npm test`、产品路径）都要看着生产服务：**

1. 开始前记录 `himawari-prod.service` 的状态、重启次数（`NRestarts`）、内存，以及测试账号内存统计里的被杀次数（`memory.events` 的 `oom_kill`）。
2. 运行中每 30 秒记录一次：负载、测试账号内存和峰值、被杀次数、生产服务的状态、内存、CPU 用量和重启次数。这些都是只读查询，不向生产服务发请求。
3. 生产服务不再是 `active`、重启次数增加，就立刻停止本次测试，保留记录，报告用户。测试账号里出现被杀的进程，同样停下查原因，不调大上限去绕过。
4. 结束后再记录一次，并把记录放进证据目录。

**测试不能碰：** `/opt/himawari`、`/etc/himawari`、`/var/lib/himawari` 等生产位置，生产密钥，生产服务账号，以及生产服务本身（不停止、不重启、不向它发请求）。

**撤销：** 用户决定不再把云服务器当测试机时，由用户以 root 运行 `revert-himawari-ci.sh`，删除账号、`/srv/himawari-ci/` 和资源上限设置。

[↑ 返回阅读导航](#contents)

<a id="first-install-acceptance"></a>

### 生产部署的限定主机验收（不变）

沿用 ADR 0052：G51、G65、G75 分别批准首次安装、2026-10-09 的第二次部署和 2026-10-12 决定的第三次部署，在 84.247.157.41 上做部署所必需的有限主机能力验收；第四次及以后的部署仍需用户独立决定。

1. 验收用本次批准的专用普通账号，只使用新建的虚构工作区、临时状态和自有进程。测试账号 `himawari-ci` 不是验收账号，它的测试结果不能代替验收和签署。
2. 验收内容、证明生成条件、Hermes 先验证适配、冻结操作包、用户批准冻结包后由 Claude 按顺序执行并遇到意外即停的方法，全部按 [ADR 0052 的限定主机验收](0052-third-production-host-acceptance-exception.md#first-install-acceptance)。
3. 这些例外本身不授权云命令、生产密钥读取、付费请求或正式部署。

原云测试环境（`himawari-test` 账号和 `/srv/himawari-test/`）已按 G58 删除。bubblewrap 0.11.2 和它的 AppArmor 规则生产要用，一直保留（见 [BL-20261001-001](../backlog/BL-20261001-001-ubuntu-24-04-默-认-禁-止-bwrap.md)）。

<a id="storage"></a>

### Hermes 的连接和目录（不变）

- 连接优先走 Tailscale（家里网络与 Mac 之间的私有网络）：`ssh -o BatchMode=yes -o ConnectTimeout=20 -o ProxyCommand=none -o HostName=100.64.53.104 hermes '<命令>'`（用户 2026-10-12 决定）；Tailscale 不可用时才走 SSH 别名 `hermes` 经 `cloudflared` 和 Cloudflare Access 的旧路径。两条路都要核对退出码和远端主机名是 `hermes-home`。
- 源码检出和依赖放在固态根盘上登录账号家目录里本任务的目录；工具链、浏览器、日志、报告和保留的证据放在机械盘 `/data` 上本任务的目录；运行中的临时数据放在 `mktemp -d /tmp/hXXXX` 建的 10 字节目录。理由和细节见 [ADR 0052 的 Hermes 目录规则](0052-third-production-host-acceptance-exception.md#storage)。
- 根盘没有最低可用空间下限（G54），但每次运行前后记录 `df`，跑完把根盘空间还回去：先复制要保留的证据，再删除临时目录、旧构建和产品路径安装，只删本次运行自己建的东西。

<a id="unchanged"></a>

### 时限不放宽、测试层级、提交推送（不变）

- **时限：** `ci/policy.json` 的总时限、Vitest 各项目的默认时限、测试里写死的时限都不改；不设 `HIMAWARI_TEST_TIMEOUT_MS`（按 [BL-20261001-002](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/backlog/BL-20261001-002-回-到-同-步-写-入-快-的.md) 撤掉）；超时作为缺陷查原因修复。两台测试机都一样。
- **测试层级：** 第 0 层定向测试、第 1 层 `npm run check`、第 2 层受影响模块测试、第 3 层构建加完整 `npm test`、第 4 层真实产品路径、第 5 层生产部署，触发时机和提前跑完整测试的情况全部按 [ADR 0052 的测试层级](0052-third-production-host-acceptance-exception.md#layers)和[提前运行完整测试的情况](0052-third-production-host-acceptance-exception.md#early-full)。唯一变化是第 0–4 层的运行位置可以是 Hermes 或云服务器测试账号。
- **提交推送：** 每个提交创建后立即推送到 `origin` 的同名分支；不 force-push、不改写已推送的历史、不绕过 hook；推送失败就停下报告；提交说明写清实际跑过的层级和运行位置（哪台机器）。开分支、打标签、开 PR、合并仍要用户明确要求。GitHub 上合并前必须通过的检查仍由 `ci/policy.json` 规定。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

### 云服务器同时当测试机，用独立账号和资源上限隔开（采用）

不花钱、当天可用，和生产同为 Ubuntu 24.04。代价：单次测试不会更快（同样 4 核）；测试和生产争用 CPU、内存和磁盘，生产服务的响应可能变慢；内存上限能防止测试把生产进程挤死，但不能消除争用。用每 30 秒的生产服务监测和“生产异常就停”的规则控制风险。

### 另租一台更强的测试机（未采用）

能让单次测试变快，也不影响生产，但要付费、要重新准备环境。用户选择先用现有云服务器。

### 继续只用 Hermes（未采用）

不影响生产，但几批改动只能排队等同一台机器，是当前交付慢的主要原因。

<a id="consequences"></a>

## 后果

- `AGENTS.md` 的 “Test and Production Hosts” 改为引用本 ADR；opencode 和 Grok 的本地禁止清单改为只允许以 `himawari-ci` 登录云服务器，root 登录和生产操作包装脚本仍然禁止。
- 云服务器上的测试会和生产服务争用资源；每次重测试的监测记录作为证据保留。第一次完整测试（长任务条目 R2-E4）用来标定它在云服务器上要跑多久、对生产服务有什么影响。
- 撤销测试机只需用户运行撤销脚本；生产服务不受撤销影响。

<a id="references"></a>

## 关联文档

- 前序历史：[ADR 0052](0052-third-production-host-acceptance-exception.md)、[ADR 0051](0051-second-production-host-acceptance-exception.md)、[ADR 0046](0046-tests-back-on-hermes.md)。
- 当前架构：[SOURCE: docs/architecture-v0.1.md]
- 生产准备及真实响应时间：[2026-09-30-production-first-deployment-plan.md（已删除，链接指向删除前的版本）](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/execution/plans/2026-09-30-production-first-deployment-plan.md)
- 安装操作合同：[SOURCE: docs/runbooks/install-start-stop-runbook.md]

[↑ 返回阅读导航](#contents)
