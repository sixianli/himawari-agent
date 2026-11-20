---
status: active
document_type: runbook
execution_risk: critical
contract_sha256: "sha256:7309e159a6d481c172f45893ecf613e65ed9e263aa35e98da1152fe24fd550ea"
supersedes: ""
superseded_by: ""
date: "2026-10-21"
---

# 测试主机操作 Runbook：在 Hermes 和云服务器测试账号上跑测试并还回空间

<!-- runbook-contract:
- docs/adr/0056-cloud-server-also-test-host.md
- scripts/ci/context.mjs
- ci/policy.json
-->

本手册把原先写在 `AGENTS.md` 里的测试主机操作步骤集中到一处：怎样连 Hermes（局域网里的 Linux 测试服务器）和云服务器的测试账号 `himawari-ci`，目录和临时数据放在哪里，跑测试时要记录什么，跑完怎样把磁盘空间还回去。规则本身来自 [ADR 0057](../adr/0057-batch-layers-one-two-for-small-defects.md) 和它保留的 [ADR 0056](../adr/0056-cloud-server-also-test-host.md)；`AGENTS.md` 只留硬边界并链接到这里。

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

- 适用：在 Hermes 或云服务器 `84.247.157.41` 的测试账号 `himawari-ci` 上运行第 0–4 层开发测试（定向测试、`npm run check`、受影响模块、完整 `npm test`、真实产品路径），以及每次运行前后的记录和清理。
- 不适用：生产部署（第 5 层）、生产服务的任何操作、Mac 上的验证（用户 2026-09-30 起无限期推迟）、新下载（工具链、bubblewrap 等，需用户先批准）。用户本人以管理员身份登录生产云服务器、查看生产服务和处理内核锁定，见[生产云服务器访问与系统更新 Runbook](production-server-access-runbook.md)。
- 目标：Hermes（Ubuntu 22.04，bwrap 0.6.1）和云服务器的 `himawari-ci` 账号（Ubuntu 24.04，与生产服务同一台机器）。两者的结果互不代替，也都不代替生产安装的行为。

<a id="authoritative-sources"></a>

## Authoritative Sources

- 测试和部署的位置、云测试账号的限制、Hermes 的目录：[SOURCE: docs/adr/0056-cloud-server-also-test-host.md#decision]
- 测试分层和触发时机：[SOURCE: docs/adr/0057-batch-layers-one-two-for-small-defects.md#decision]
- CI 入口拒绝 `.ci-output/` 之外的输出路径（`CI_OUTPUT_OUTSIDE_RUN_DIRECTORY`）：`scripts/ci/context.mjs`
- 必过的 CI 检查清单：`ci/policy.json`
- 对照测量必须在安静主机上做的教训：[docs/lessons.md 的“对照测量时机器上还有别的负载”](../lessons.md#measurement-not-isolated)
- `umask 022` 的教训：[docs/lessons.md 的 Hermes umask 条目](../lessons.md#hermes-umask)

<a id="safety-and-preconditions"></a>

## Safety and Preconditions

- 永远不在用户的 MacBook 上跑 Himawari 的测试、构建、`npm run check`、`npm test`、任何 Vitest 项目或产品路径资格测试；发现有在跑的就停掉。Mac 只用来编辑、审查、提交。
- 云服务器上只用 `himawari-ci`（uid 1001，没有 sudo），只在 `/srv/himawari-ci/` 下工作；不用 root，不用生产账号，不读生产密钥，不碰 `/opt/himawari`、`/etc/himawari`、`/var/lib/himawari` 和生产服务（不停、不重启、不发请求）。
- Hermes 上还跑着别的服务，包括 `/data/hermes/himawari/releases/` 下已有的 Himawari 服务：测试不读写它们的目录和数据，不停止、不重启它们。
- 需要 sudo 或改 Hermes 系统设置、服务的事，写成可执行脚本、逐步说明，由用户运行。
- 不放宽测试时限；不设 `HIMAWARI_TEST_TIMEOUT_MS`（按 [BL-20261001-002](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/backlog/BL-20261001-002-回-到-同-步-写-入-快-的.md) 正在移除）。超时是要诊断修复的缺陷，不是环境问题。
- 不改 SSH 配置、凭据、Cloudflare 设置、防火墙或主机密钥校验来绕过连接失败；报告用户。
- 第一个会改变目标的动作是在测试主机上建检出目录和临时目录；日常测试工作已由 ADR 0056 授权，不需要逐次请示。

<a id="live-state-preflight"></a>

## Live-State Preflight

1. 连接并核对主机名。Hermes 优先走 Tailscale（Mac 和家里网络之间的私有网络）：`ssh -o BatchMode=yes -o ConnectTimeout=20 -o ProxyCommand=none -o HostName=100.64.53.104 hermes '<命令>'`，`100.64.53.104` 是 Hermes 的 Tailscale 地址（`tailscale status` 里的 `hermes-home`）；这只覆盖命令行上的代理和地址，不改 SSH 配置。Tailscale 不可用时才走 `hermes-ssh` skill 的路线：Mac 的 SSH 别名 `hermes`（经 `cloudflared` 和 Cloudflare Access），例如 `ssh -o BatchMode=yes -o ConnectTimeout=15 hermes '<命令>'`；Cloudflare 要浏览器登录时请用户完成后重试同一条命令。两条路线都要检查退出码，并确认远端主机名是 `hermes-home`。云服务器：`ssh himawari-ci@84.247.157.41`，用 Mac 上已有的密钥。opencode 和 Grok 只能通过项目的包装脚本连接（见 `AGENTS.md` 的 Delegated Coding Agents）。
2. 记录根盘可用空间：`df -h /`。没有最低可用空间下限（G54），但要记下来，跑完比较。
3. 做对照测量（修前修后、空闲对负载、两种设置对比）之前，先运行 `.ci-output/handoff/scripts/require-quiet-host.sh hermes|cloud`，只有它打印 `QUIET_HOST_OK` 才开始；证据里没有这一行的对照结果不被接受。
4. 云服务器上每次重测试（构建、整个 Vitest 项目、完整 `npm test`、产品路径）开始前，用只读查询记录 `himawari-prod.service` 的状态、重启次数、内存、CPU，以及测试账号的内存和 `oom_kill` 次数。
5. 确认 `PATH` 里锁定的 Node.js 在最前：非交互 SSH 可能没有它，例如 `PATH=/data/hermes/himawari/tool-audit-round2/r30/tools/bin:/usr/bin:/bin`；并把 `HIMAWARI_CI_TOOLS`、`HIMAWARI_CI_PYTHON`、`PLAYWRIGHT_BROWSERS_PATH`、`TMPDIR` 指向本任务的目录。

<a id="procedure"></a>

## Procedure

1. **目录布局（Hermes）。** 源码检出和它的 `node_modules` 放在登录账号家目录下本任务自己的目录、固态根盘上（例如 `~/himawari-tests/round2/source`，约 1 GiB）；机械盘 `/data` 上几万个小文件的冷读曾让首批测试超时。工具链、浏览器、日志、报告和保留的证据放在 `/data` 上本任务的目录（例如 `/data/hermes/himawari/tool-audit-round2/`）。构建和测试输出只在检出的 `.ci-output/` 里（CI 入口对外面的路径报 `CI_OUTPUT_OUTSIDE_RUN_DIRECTORY`）。云服务器上对应 `/srv/himawari-ci/` 的 `tools/`、`browsers/`、`source/`、`evidence/`。
2. **同步代码。** 用 `git bundle` 和补丁从 Mac 同步；不在服务器上改代码。
3. **建临时根。** 每次运行 `mktemp -d /tmp/hXXXX`，检查属主是测试账号、权限 0700、`realpath` 等于自身，然后同时设为 `HIMAWARI_TEST_TEMP_ROOT` 和 `TMPDIR`。路径保持 10 字节：Linux 的 Unix socket 路径上限 107 字节，产品路径夹具拒绝更长的根。SQLite 文件、socket、产品路径的测试安装、测试的 `TMPDIR` 都放在这里。
4. **运行方式。** `umask 022`（登录账号默认 `0002` 会让测试建的目录组可写，沙箱以 `SANDBOX_HOST_PATH_UNSAFE` 拒绝）。预计超过几分钟的命令写成主机上的脚本后台启动：`setsid -f bash -c 'echo $$ > <pid 文件>; exec bash <脚本>' > <日志> 2>&1 < /dev/null`，`cd` 写在脚本里，结果写进文件，用 `.ci-output/handoff/scripts/hermes-wait.sh <日志> '<结束行>' <pid 文件>` 等待。一台主机同一时间只跑一个产品路径测试或一组第 2 层测试。
5. **云服务器上盯着生产服务。** 运行中每 30 秒记录一次负载、测试账号内存和峰值、`oom_kill` 次数、生产服务的状态、内存、CPU 和重启次数，都是只读查询。结束后再记录一次。
6. **按批分配主机。** Claude 把每批分到空闲的主机，一批的第 0–3 层尽量在同一台上。
7. **记录空间。** 记录临时目录的峰值大小和根盘最低可用空间。
8. **还回空间。** 跑完先把要保留的报告和失败证据复制到 `/data`（或 `/srv/himawari-ci/evidence/`）上本任务的证据目录，再删除临时目录（只删本次运行自己建的 `/tmp/h*`）和这次运行留下的其他根盘产物：`.ci-output/` 下已被取代的构建和测试输出、产品路径和候选安装、解包的下载副本。任务结束时删除固态盘上的检出。
9. **再记一次空间。** 应回到运行前的水平；差额在停止文件或提交说明里逐项写明有意保留的内容、大小和原因。报告删除的路径和释放的空间。

<a id="verification"></a>

## Verification

- 测试报告在检出的 `.ci-output/` 里，带用例计数；用例数为 0、有跳过或有失败的运行不算通过。
- 云服务器：运行前后的生产服务记录显示它一直 `active`、重启次数没有增加、测试账号 `oom_kill` 为 0。
- 运行后的 `df -h /` 与运行前相同，或差额已逐项解释。
- 对照测量的证据里有 `QUIET_HOST_OK` 行。

<a id="evidence"></a>

## Evidence

- 证据目录：Hermes 上 `/data` 下本任务的目录，云服务器上 `/srv/himawari-ci/evidence/`。每次运行一个唯一编号，报告、日志、状态读回和跟踪记录按文件分别保存。
- 不保存 `node_modules`、`.git`、与提交相同的源码；改记提交号、锁文件摘要和“路径、大小、SHA-256”清单。几次运行共用的输入只存一份，其他地方放写有路径和 SHA-256 的引用文件。近似的诊断只留一份完整的加差异。单个证据文件超过 50 MB 或一次运行超过 100 MB，先查里面是什么、为什么要留；同目录的 `EVIDENCE-REASONS.txt` 写明 `文件名: 理由`，否则等待脚本的证据门禁不接受这一批。
- 不记录密钥和含密钥的配置。
- 自动清理（用户决定，2026-10-26）：`scripts/disk-hygiene/prune-rebuildable.py` 只删能重新生成的文件，即源码包 `*.bundle`、依赖包 `node-modules.tar.gz`、构建安装包 `*-abi<数字>-*.tar.gz`、Python 安装包 `python-<版本>.tar.gz`，以及 `doc-check/` 下文档检查留下的旧临时仓库副本。它不删日志、报告、证据、脚本和 `.ci-output/tools/`（本地 CI 工具链），不删 24 小时内改过的文件，也不删任何 `production/` 目录下日期最新的两个操作包。`deploy.sh` 在 `DEPLOY_PASSED` 后对 `.ci-output` 跑一次。每天凌晨 4 点的定时清理由 `scripts/disk-hygiene/install-schedule.sh mac|hermes <目录>...` 安装：Mac 上用 launchd（macOS 自带的定时任务），Hermes 上用登录账号的 crontab。遇到正在跑的构建或测试，这一轮跳过。`remove-mac`、`remove-hermes` 用来卸载。不加 `--apply` 只列清单、不删除。
- 始终保留：测试报告、控制台和服务日志、数据库或状态读回、跟踪记录、截图、文档和交接文件引用的证据、备份和恢复点、云服务器上的生产版本及其前一个版本。只能重建的产物优先删除；要减少证据本身时先问用户。

<a id="rollback"></a>

## Rollback

- 这里的“回退”是把主机恢复到运行前的状态：删除本次运行建的临时目录、检出和产物，按 [Procedure](#procedure) 第 8–9 步执行并记录空间。
- 删除之前确认没有进程、未完成的命令或任务还在用它，并在仓库和 `.ci-output/` 里搜索该路径；文档、交接文件、证据 README 或测试报告说是保留证据、或是某个未解决失败唯一现场的，不删。
- 云服务器上 root 所有的路径按用户运行脚本的流程删除：给用户可执行脚本，逐条说明删什么、为什么，等用户运行。

<a id="stop-conditions"></a>

## Stop Conditions

- 生产服务不再 `active`，或重启次数增加：立刻停止本次测试，保留记录，告诉用户。
- 测试账号出现 `oom_kill`：停下诊断，不调高上限。
- 远端主机名不是 `hermes-home`（Hermes）或登录账号不是 `himawari-ci`（云服务器）。
- `require-quiet-host.sh` 没有打印 `QUIET_HOST_OK` 而要做对照测量。
- 需要新下载、sudo 或改系统设置。
- 发现测试在 MacBook 上运行。

<a id="troubleshooting"></a>

## Troubleshooting

| 现象 | 安全的诊断 | 处理 |
| --- | --- | --- |
| 大量测试报 `SANDBOX_HOST_PATH_UNSAFE` | 查当前 `umask` 和测试建的目录权限 | 用 `umask 022` 重跑；不改沙箱检查 |
| CI 入口报 `CI_OUTPUT_OUTSIDE_RUN_DIRECTORY` | 查输出路径是否在检出的 `.ci-output/` 里 | 把输出路径改回 `.ci-output/` |
| 产品路径夹具拒绝临时根 | 查 `HIMAWARI_TEST_TEMP_ROOT` 的长度、属主、权限、`realpath` | 用 `mktemp -d /tmp/hXXXX` 重建 10 字节的根 |
| 首批测试在 `/data` 上超时 | 查检出是否在机械盘 | 把检出和依赖移到固态根盘的任务目录 |
| SSH 超时但 Hermes 健康 | `tailscale status` 看 `hermes-home` 是否在线 | 改走 Tailscale 路线；不改 SSH 配置 |
| 非交互 SSH 找不到 `node` | `echo $PATH` | 把锁定工具链放到 `PATH` 最前 |
| 同步等待长命令被 300 秒上限结束 | 看包装脚本的提示 | 改为 `setsid -f` 后台启动并用 `hermes-wait.sh` 等待 |
