# P0 平台探针：容器停止、挂载门禁与硬期限

日期：2026-09-25 UTC。对应[隔离执行实施计划的 P0](../../../../../docs/execution/plans/2026-09-24-isolated-tool-execution-plan.md#p0)。本目录只保存容器运行时本身的实测结果，**不是**产品已接入容器的证据：Himawari 的工具目前仍由 SRT（现有的进程级沙箱）执行，本次没有改动产品代码。

<a id="contents"></a>

## 目录

- [本次做了什么](#scope)
- [运行环境](#environment)
- [结果汇总](#results)
- [原目录模式的平台门禁](#host-mount-gate)
- [硬期限与休眠](#deadline)
- [工具入口盘点](#tool-inventory)
- [清理与对外影响](#cleanup)
- [复跑方法](#rerun)
- [未验证范围](#unverified)

<a id="scope"></a>

## 本次做了什么

用户在 2026-09-25 批准了以下操作：在本机 OrbStack（Docker 兼容的容器运行时）上跑一次性容器探针；需要时停止自动恢复的 `just-rag-postgres` 容器；由用户亲自让 Mac 休眠；Linux 平台在 Hermes（局域网 Linux 服务器）上测试。

[`probe.sh`](probe.sh) 在 Mac 和 Hermes 上以同一版本运行（SHA-256 `f6c29fe169ea7dbea71f5fdb344b0d79996ee8e8694c134aad56f75522a06acc`）。每个探针容器都禁止联网，按普通用户身份运行，并去掉全部 Linux capability（root 权限拆分出的各项特权）。容器还设置了 no-new-privileges（运行中不能再获得新特权），根文件系统只读，进程数和内存有上限。每项检查的观察值写入各平台目录下的 `summary.tsv`。全部原始输出按仓库惯例打包在 [`raw-logs.tar.gz`](raw-logs.tar.gz) 中（用 `tar -xzf raw-logs.tar.gz` 解开），下文提到的文件都在包内：Mac 在 `mac-orbstack/`，Hermes 在 `hermes-linux/`，休眠测试在 `mac-orbstack-sleep/`。[`sleep-probe.sh`](sleep-probe.sh) 只在 Mac 上运行，用来观察休眠对期限的影响。

第一次 Mac 运行时，脚本有 3 处判定写法错误：读 `/proc/1/mem` 的错误类型没区分；取到的是管道里其他命令的退出码；BusyBox 的程序互为硬链接，用复制覆盖失败并不说明只读保护生效。另外，Hermes 上 `--storage-opt` 被接受但没有验证是否生效。修正脚本后两个平台都重新运行，本目录只保留修正后的结果。Hermes 第一次运行后另做的写入核对，保存在包内的 `hermes-linux/quota-storage-opt-first-run-write-check.txt`。

[↑ 返回目录](#contents)

<a id="environment"></a>

## 运行环境

| 平台 | 系统与运行时 | 临时目录所在的文件系统 |
| --- | --- | --- |
| Mac | macOS 27.2（arm64）；OrbStack 2.2.3，Docker 29.4.0，虚拟机内核 7.0.14-orbstack，cgroup v2，seccomp 默认规则 | APFS（默认不区分大小写） |
| Hermes | Ubuntu 22.04.5（x86_64），内核 5.15.0-185；Docker 29.6.1，使用 containerd 存储后端，cgroup v2，AppArmor 与 seccomp 默认规则 | `/data`，ext4，`rw,noatime`，没有开启项目配额 |

镜像固定为 `docker.io/library/busybox@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e`，两个平台各自取对应架构。完整记录见各平台目录中的 `environment.txt`。

[↑ 返回目录](#contents)

<a id="results"></a>

## 结果汇总

逐项原始记录在包内的 `mac-orbstack/summary.tsv` 和 `hermes-linux/summary.tsv`。

| 检查 | Mac | Hermes | 说明 |
| --- | --- | --- | --- |
| 整体停止 | 通过 | 通过 | 三种写入程序：用 `setsid` 脱离进程组的、两次 fork 后被 1 号进程收养的、关闭标准输入输出的后台程序。`docker stop` 给 2 秒宽限后，三者全部停止，宿主独立读回的文件大小在停止时和 3 秒后一致。 |
| 停止后不复活、不能再执行 | 通过 | 通过 | 重启策略为 `no`，重启次数 0；对已停容器执行命令被拒绝。本次没有测试运行时重启后的情况。 |
| 任务私有临时目录额度（tmpfs，16 MB） | 通过 | 通过 | 请求写 32 MB，实际只写入 16 MB。 |
| 容器根文件系统额度（`--storage-opt size=64m`） | 被拒绝 | **接受但不生效** | Mac 报错说只支持 XFS 且开启项目配额的情况。Hermes 返回成功，但容器里写入了 96 MB。“没报错”不代表限制生效。产品计划使用只读根文件系统，所以不依赖这一项。 |
| 挂进容器的工作目录额度 | **做不到** | **做不到** | 运行时没有给挂载目录限额的选项，容器向挂载目录写入 96 MB，没有任何拦截。 |
| 按路径遮挡嵌套敏感文件 | 通过 | 通过 | 用空文件盖住 `.env`、用空的内存目录盖住 `secrets/` 后，容器读不到原内容；指向 `.env` 的符号链接也读到空内容；任务无法卸载、删除、改名或写入这些遮挡。 |
| 遮挡的漏洞：硬链接 | **漏洞** | **漏洞** | 同一文件在授权目录里的另一个硬链接名（本次为 `hardlink-to-env`），能读到被遮挡的内容。按路径遮挡盖不住它。 |
| 遮挡的漏洞：启动后新增的文件 | **漏洞** | **漏洞** | 容器启动后宿主新建的敏感文件（本次为 `late.env`）在容器里可见，因为遮挡在创建容器时就固定了。 |
| inode 与硬链接数 | 不一致 | 一致 | Mac 上容器看到的 inode 编号（例如 186）与宿主（例如 410651827）不同，但同一文件的多个硬链接在容器内仍是同一编号，链接数也一致。Hermes 两边编号完全相同。 |
| 大小写规则 | 一致（都不区分） | 一致（都区分） | Mac 容器里用 `foo.txt` 能读到宿主的 `Foo.txt`；创建 `bar.txt` 和 `BAR.txt` 两边都只有一个文件。 |
| 指向目录外的符号链接 | 两边解释不同 | 两边解释不同 | 宿主按宿主路径解析到目录外的文件；容器按容器自己的文件系统解析，读不到。 |
| 受保护 init 的反向测试 | 全部被拒绝 | 全部被拒绝 | init 用用户 2001、任务用用户 2002。任务尝试的操作：对 1 号进程发 KILL、TERM、STOP 信号；读它的内存和环境变量（与 ptrace 调试附加相同的权限检查）；读它的程序路径；覆盖或删除 `/bin/sleep`；改写 `/proc/1/oom_score_adj`；重新挂载根目录；修改系统时钟。全部被拒绝，1 号进程仍在运行。本次没有专门的 ptrace 工具，用 `/proc/1/mem` 的访问检查代替。 |
| 到期后整体停止 | 通过（25 秒期限，26 秒观察到） | 通过（25 秒期限，26 秒观察到） | 1 号进程到期退出后，任务启动的 `setsid` 写入程序也一起停止，文件大小不再变化。 |
| `docker pause` 暂停 20 秒 | 26 秒结束 | 26 秒结束 | 暂停期间期限照常计算，恢复后立即到期。这是运维操作，任务自己无法暂停容器。 |

[↑ 返回目录](#contents)

<a id="host-mount-gate"></a>

## 原目录模式的平台门禁

[Spec 的平台门禁](../../../../../docs/execution/specs/2026-09-24-isolated-tool-execution-design.md#host-mount-gate)要求同时满足三项。本次结论如下：

1. **挂进容器的工作目录能强制磁盘额度：两个平台都不满足。** 容器运行时本身做不到；要做到只能靠宿主文件系统的额度功能。Linux 的 ext4 和 XFS 支持项目配额（按目录树统计用量），但 Hermes 的 `/data` 没有开启，开启需要修改服务器的文件系统设置，本次没有做，也没有验证。macOS 的 APFS 只能给整个卷设额度，不能给任意目录设。
2. **嵌套敏感文件能被隔离：两个平台都只部分满足。** 按路径遮挡对已知路径有效，但硬链接和启动后新增的文件会漏出来。要用原目录模式，宿主一侧必须在创建前拒绝“敏感文件有多个硬链接”的授权目录，并且接受“运行期间新增的敏感文件无法遮挡”这一限制，或者改用不含敏感文件的工作副本。
3. **路径身份一致，或全部由宿主一侧解析：** Hermes 的 inode 和大小写一致；Mac 的 inode 编号不一致。两个平台对指向目录外的符号链接解释都不同。所以两个平台都必须由宿主一侧解析路径身份，不能用容器里看到的编号或路径做判断。Spec 允许这种做法。

按 Spec，第 1 项不满足时，实施者要停下来请用户在两个方案中选择：(a) 该平台的普通命令也改用有容量上限的工作副本；(b) 接受非硬性的磁盘保护，另写 ADR 修正。结论出来之前，任何平台都不启用原目录模式。

[↑ 返回目录](#contents)

<a id="deadline"></a>

## 硬期限与休眠

休眠测试记录（包内 `mac-orbstack-sleep/sleep-result.txt`）：两个容器都在 14:29:29（日本时间）启动，期限都是 900 秒。用户在 14:34:42 合上盖子让 Mac 休眠，14:44:03 唤醒。宿主每秒一次的时间记录断了 542 秒。

| 计时方式 | 结束时刻（宿主观察） | 结论 |
| --- | --- | --- |
| A：1 号进程执行 `sleep 900`（按运行时间计时） | 启动后 1442 秒 | 期限被推迟了整个休眠时长（900 + 542）。休眠时虚拟机的运行时间不计数，所以这种写法给不出以墙上时间计的上界。 |
| B：1 号进程每秒对照当前时刻，到点退出（按墙上时间计时） | 启动后 901 秒 | 准时结束。唤醒后虚拟机时钟与宿主的偏差为 0 秒。 |

结论：受保护 init 必须按墙上时间计算到期，不能用 `sleep` 这类按运行时间计时的等待。休眠期间虚拟机整体暂停，任务不会运行，所以按墙上时间计，期限上界就是设定的期限，加上唤醒后最多 1 秒的检查间隔。修改墙上时间需要宿主或虚拟机的管理权限，任务做不到（见上面修改系统时钟的反向测试）。Hermes 是一直运行的服务器，本次没有测试它的休眠或挂起。

[↑ 返回目录](#contents)

<a id="tool-inventory"></a>

## 工具入口盘点

盘点基于提交 `cfd8590`。方法是找出产品代码里所有在宿主上启动进程的地方（`node:child_process`），再查生产程序是否使用它。

| 入口 | 现在在哪里运行 | 迁移后的归类 |
| --- | --- | --- |
| Pi 的七个工具（read、write、edit、find、grep、ls、bash） | Worker 启动独立的 Job Host 进程，Job Host 用 SRT（`@anthropic-ai/sandbox-runtime` 的 `SandboxManager`）启动已登记的 `pi-coding-main.js`，Shell 命令在这个受限进程里执行（[job-host-main.ts](../../../../../packages/runtime-sandbox/src/job-host-main.ts)、[pi-coding-main.ts](../../../../../apps/agent-service/src/capability-programs/pi-coding-main.ts)、[sandboxed-coding-operations.ts](../../../../../packages/platform-node/src/files/sandboxed-coding-operations.ts)）。Worker 组装里按平台选择的隔离后端（Mac 签名辅助程序、Linux bubblewrap）用于部署资格检查 | 在环境内运行 |
| web_search | 同样经 Job Host 和 SRT 运行已登记的 `web-search-main.js`，只允许访问 `mcp.exa.ai:443` | 在网络辅助环境内运行 |
| 后台任务的查询、输出与停止（`execution.task.*`） | Agent 服务直接处理，只读写已有沙箱资源的记录，不执行代码（[production-managed-tasks.ts](../../../../../apps/agent-service/src/production-managed-tasks.ts)） | 控制一侧，不执行任务代码 |
| 读取授权目录里的文件、保存副本、准备文件修改 | Agent 服务用 `ConstrainedHostFileSystem` 直接做固定的文件操作 | 控制一侧的固定文件操作 |
| 目录改名 | 宿主上的固定原生程序（由 `rename-native.c` 编译），只接受根目录、源和目标相对路径以及设备号和 inode（[constrained-file-system.ts](../../../../../packages/platform-node/src/files/constrained-file-system.ts)） | 环境外的专用执行程序 |
| 主机密钥读取 | `host-secret-source.ts` 调用系统命令读取宿主保存的密钥，不接收模型输入 | 控制一侧 |
| Git 工作区适配、候选工作区、Apple container、bubblewrap 命令沙箱与 Mac 命令路由 | 代码存在，但生产程序没有引用 | 不是现有入口；接入前需重新评估 |
| GitHub 集成、浏览器 | `integration-github` 列在依赖里但生产代码没有引用；没有浏览器工具入口 | 不是现有入口 |

本次没有发现“模型可以让宿主直接运行任意代码”的生产入口。任意代码目前只经 bash 工具，在 SRT 限制的进程里运行。这是静态核查的结论，没有运行生产服务验证。

[↑ 返回目录](#contents)

<a id="cleanup"></a>

## 清理与对外影响

- **Mac**：OrbStack 开始时是停止状态，这次启动时没有自动拉起 `just-rag-postgres` 或其他容器，所以没有停止任何已有容器。所有探针容器都带有 `himawari.probe` 标签，按标签删除后读回为 0 个。结束时 OrbStack 已恢复为 `Stopped`。临时文件在本会话的临时目录里。
- **Hermes**：只在新建的 `/data/himawari-p0/` 下写入；根盘上多了一个约 4 MB 的 BusyBox 镜像，留着供后续阶段复用。探针容器按标签删除，读回为 0 个。临时目录已删除，只留下脚本和最终结果。结束时 38 个已有容器全部仍在运行。

[↑ 返回目录](#contents)

<a id="rerun"></a>

## 复跑方法

```bash
DOCKER="/usr/local/bin/docker --context orbstack" bash probe.sh <结果目录> <不存在的临时目录>
DOCKER="/usr/local/bin/docker --context orbstack" DEADLINE=900 bash sleep-probe.sh <结果目录>
```

Hermes 上把 `DOCKER` 设为 `docker`，临时目录放在 `/data` 下。在 Claude Code 沙箱里运行时，需要允许连接 OrbStack 的 Docker socket（本次在沙箱外运行）。休眠测试需要有人在期限内让 Mac 休眠 3 分钟以上。

[↑ 返回目录](#contents)

<a id="unverified"></a>

## 未验证范围

- 运行时或虚拟机重启后，已停止的容器是否仍保持停止；Docker 守护进程失联时如何判定。这两项留到 P2 的资格验证。
- 网络出口限制、CPU/进程数/内存额度被触发时的表现、浏览器，都不在本次范围。
- Linux 宿主的项目配额能否限制挂载目录；Hermes 的休眠或挂起。
- 真实 ptrace 附加。本次用 `/proc/1/mem` 的访问检查代替，两者走的是同一类权限检查，但不是同一个系统调用。
