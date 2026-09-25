# P2 第二批：原目录模式的目录挂载、敏感文件遮挡与磁盘保护

日期：2026-09-25 UTC。对应[隔离执行实施计划的 P2](../../../../../docs/execution/plans/2026-09-24-isolated-tool-execution-plan.md#p2)第 1、2、9 项。规则来源是 Spec 的[授权与安全策略](../../../../../docs/execution/specs/2026-09-24-isolated-tool-execution-design.md#policy)、[原目录模式的平台门禁](../../../../../docs/execution/specs/2026-09-24-isolated-tool-execution-design.md#host-mount-gate)，以及 [ADR 0032 的决定](../../../../../docs/adr/0032-original-directory-disk-and-sensitive-file-limits.md#decision)。

本批让[第一批的容器后端](../p2-container-lifecycle-01/README.md)能把用户批准的真实目录直接挂进容器（原目录模式），并在 Mac（OrbStack）和 Hermes（Linux）上用真实容器验证。**磁盘保护不是硬性额度**：它按固定间隔检查剩余空间，两次检查之间写入的量不受限制，实测最多超出阈值 238 MiB（见[磁盘保护的数值与实测超出量](#disk-guard)）。所以本记录不签发“全面合格”，只证明下文逐项列出的行为。后端仍没有接进产品，新任务执行仍然关闭。

<a id="contents"></a>

## 目录

- [用词](#terms)
- [用户在本批之前作出的决定](#decisions)
- [实现了什么](#implementation)
- [真实容器上验证了什么](#qualification)
- [磁盘保护的数值与实测超出量](#disk-guard)
- [Mac 上的大小写漏洞](#case-alias)
- [单元测试覆盖的情况](#unit)
- [测试能否发现缺陷](#mutations)
- [验证命令与结果](#verification)
- [没有覆盖的部分](#gaps)

<a id="terms"></a>

## 用词

| 用词 | 意思 |
| --- | --- |
| 原目录模式 | 把用户批准的真实目录直接挂进容器，容器里写的内容会真实写回宿主；与之相对的是先复制再发布的“工作副本模式” |
| 挂载（bind mount） | 让容器里的某个路径直接指向宿主上的一个目录或文件 |
| 遮挡 | 在挂进来的目录里，用一个只读的空文件或空目录盖住某个路径，容器里只能看到空内容 |
| 硬链接 | 同一份文件内容的另一个文件名；按路径遮挡盖不住另一个名字 |
| 符号链接 | 指向另一个路径的特殊文件，类似快捷方式 |
| inode、device | 文件系统给每个文件的编号，以及它所在磁盘的编号；两者一致才说明是同一个文件 |
| FIFO、socket | 两种用于进程之间通信的特殊文件；挂进容器后，容器里的程序可能借它们和宿主上的程序通信 |
| gitdir、worktree、commondir | Git 仓库的元数据位置。`git worktree` 建出的工作目录里，`.git` 是一个文件，写着真正元数据所在的路径（gitdir）；gitdir 里的 `commondir` 再指向共享的元数据 |
| uid、gid | Linux 的用户编号和用户组编号，决定能读写哪些文件 |
| APFS、ext4 | Mac 和 Linux 上的文件系统；Mac 默认的 APFS 不区分文件名大小写，ext4 区分 |
| statfs | 读取某个目录所在磁盘剩余空间的系统调用 |
| OrbStack | Mac 上的 Docker 兼容运行时，在一个 Linux 虚拟机里运行容器 |

[↑ 返回目录](#contents)

<a id="decisions"></a>

## 用户在本批之前作出的决定

2026-09-25 用户确认：

1. **遮挡哪些文件**（名字比较不区分大小写，出现在目录中任何层级都算）：`.env` 和 `.env.*`、`.ssh/`、`*.pem`、`*.key`、`id_rsa*`、`id_ed25519*`、`.npmrc`、`.pypirc`、`.netrc`、`.aws/`、`.docker/config.json`、`.himawari-trash`、`.himawari-recovery`。**不遮挡 `.git`**，因为 Spec 要求在环境里完成本地 Git 提交；数据库文件默认不遮挡。
2. **Hermes 的测试方式**：挂载目录必须在运行 Docker 的同一台机器上，所以测试程序在 Hermes 本机运行，代码副本和依赖放在 `/data/himawari-p2-20260925-01`；允许在需要时下载依赖。实际用已有的 npm 缓存离线安装成功，没有下载。

[↑ 返回目录](#contents)

<a id="implementation"></a>

## 实现了什么

代码在 [`packages/runtime-sandbox/src/execution-backend/`](../../../../../packages/runtime-sandbox/src/execution-backend/)：

- 新增 [`host-directories.ts`](../../../../../packages/runtime-sandbox/src/execution-backend/host-directories.ts)：在宿主一侧准备要挂载的目录。
- 新增 [`container-backend-error.ts`](../../../../../packages/runtime-sandbox/src/execution-backend/container-backend-error.ts)：错误码从后端文件移出来，供两个文件共用。
- 修改 [`container-execution-backend.ts`](../../../../../packages/runtime-sandbox/src/execution-backend/container-execution-backend.ts)：创建、执行、停止时接入目录挂载和磁盘保护。

| 方面 | 做法 |
| --- | --- |
| 找到目录 | 后端不接受任何路径参数。权限上限里的 `{hostId, grantRef, canonicalRootId, access}` 交给组装入口注入的可信函数 `resolveDirectory`，它返回路径和 inode/device（与现有 SRT 路线 `resolveSandboxWorkspaceRoot` 使用的授权根目录记录同一形状）。`hostId` 与本环境不符、找不到都拒绝 |
| 核对目录 | 路径必须是绝对路径、没有多余成分、`realpath` 与原路径相同（路径中没有符号链接）、是目录、inode/device 与记录一致；否则拒绝。两个目录互相包含、路径含有 Docker 挂载参数无法表达的字符（逗号、引号、换行）时拒绝。容器启动后再核对一次，目录已被替换就立即结束容器 |
| 挂到哪里 | 每个目录挂在 `/workspaces/<canonicalRootId>`；只读授权用只读挂载 |
| 任务用户 | 有目录时，任务以目录所有者的 uid:gid 运行（Hermes 实测：用 65534 用户写不进属于 1000 用户的目录）。多个目录的所有者不同、所有者是 root、或所有者与受保护 init 同一用户时拒绝。实际使用的用户写在容器标签里，并计入实际配置的核对 |
| 遮挡敏感文件 | 创建前扫描整个目录（不跟随符号链接），对命中清单的条目、以及 FIFO、socket 等特殊文件，加一层只读挂载：文件用空文件、目录用空目录盖住。空文件和空目录放在后端的状态目录里，权限为 0444 和 0555 |
| 遮挡不住就拒绝 | 以下情况拒绝原目录模式：敏感文件有多个硬链接；敏感目录里有多个硬链接的文件；敏感文件名本身是符号链接；敏感条目路径上任何一级能用大小写不同或 Unicode 写法不同的名字访问到同一个文件（见[Mac 上的大小写漏洞](#case-alias)）；需要遮挡的条目超过上限；扫描的条目数超过上限 |
| Git 元数据 | `.git` 是文件时读出 gitdir；gitdir、其中的 `commondir`、以及 `.git` 符号链接指向的位置，解析后都必须在目录内，读不懂也拒绝。不会为了让 Git 能用而多挂父目录或其他仓库 |
| 核对实际配置 | 创建后读回容器配置，把挂载列表（来源、目标、是否只读、传播方式）和任务用户一起比对，不一致就删除且不启动 |
| 磁盘保护 | 只对可写目录生效。创建前读剩余空间：读不到拒绝，低于下限拒绝；把这时的剩余空间作为基准写入状态目录。容器运行中按固定间隔再读：读不到、低于下限、或比基准少了超过阈值，就先写记录，再立即结束整个容器（`docker container kill`），之后的执行报 `CONTAINER_DISK_GUARD_TRIPPED`。停止或删除环境时结束检查 |
| 换进程后继续检查 | 检查的计时器在后端进程里。新的后端进程在执行前如果发现这个环境还没有人检查，先按保存的基准立即检查一次，再接着定期检查 |

磁盘保护直接结束容器，而不是走完整的停止顺序：停止顺序的第一步是在 SQLite 里保存停止 intent，这属于协调服务，后端无权写。这和硬期限到期时 init 自己退出是同一类情况：环境被结束后，协调服务仍按停止顺序请求停止并取得停止证明（单元测试和真实容器测试都验证了这一点）。

[↑ 返回目录](#contents)

<a id="qualification"></a>

## 真实容器上验证了什么

测试文件是 [`container-execution-backend-qualification.test.ts`](../../../../integration/container-execution-backend-qualification.test.ts)，新增 4 项，第一批的 5 项照常运行。Hermes 这一次和第一批不同：测试程序在 Hermes 本机运行，连本机的 Docker；测试用的目录放在 `/data` 上的任务目录里（通过 `HIMAWARI_CONTAINER_WORK_ROOT` 指定）。

| 场景 | Mac（OrbStack 2.2.3，Docker 29.4.0，APFS 不区分大小写） | Hermes（Ubuntu 22.04，Docker 29.6.1，`/data` 是 ext4） |
| --- | --- | --- |
| 看到哪些目录 | `/workspaces` 下只有批准的 `docs` 和 `repo`；`repo/..` 也只有这两个 | 相同 |
| 符号链接 | 指向相邻仓库秘密文件的绝对和相对符号链接都读不到 | 相同 |
| `.git` | 可见，未遮挡 | 相同 |
| 只读目录 | 写入被拒绝，宿主上没有新文件 | 相同 |
| 写回宿主 | 容器写的新文件出现在宿主上，所有者是目录所有者（501）；用户未提交的修改原样保留，`git status` 为 ` M tracked.txt`、`?? src/new.txt` | 所有者 1000，其余相同 |
| 敏感文件遮挡 | 有敏感文件时拒绝创建（原因见[Mac 上的大小写漏洞](#case-alias)），测试删掉敏感文件、FIFO 和 socket 后再验证上面各项 | `.env`、`.env.production`、`config/tls.key`、`.docker/config.json` 读出为空；`.ssh/`、`.himawari-trash/` 是空目录；FIFO 和 socket 变成普通空文件；删除 `.env` 被拒绝；宿主上 `.env` 内容不变 |
| 创建前拒绝 | 有硬链接的 `.env` → `CONTAINER_PROTECTED_FILE_UNMASKABLE`；`git worktree` 建出的外置 gitdir → `CONTAINER_GIT_METADATA_OUTSIDE`；下限设为比剩余空间大 1 TiB → `CONTAINER_DISK_FLOOR`；读剩余空间出错 → `CONTAINER_DISK_GUARD_UNAVAILABLE`。均未产生容器 | 相同 |
| 磁盘增长超过阈值 | 容器内持续写入，检查发现后结束整个容器，写入命令退出码 137；之后执行报 `CONTAINER_DISK_GUARD_TRIPPED`；停止后给出停止证明 | 相同；数值见下节 |
| 目录属于 root | 不适用：OrbStack 把容器里 root 建的目录显示为 Mac 用户（uid 501）所有，后端正常创建 | 拒绝，`CONTAINER_DIRECTORY_OWNER_UNSUPPORTED` |
| 第一批的 5 项 | 通过；硬期限 8 秒，实际 10.8 秒停止 | 通过；8.6 秒停止 |
| 清理 | 按本轮标签删除遗留容器后读回为 0 | 读回为 0；原有 38 个容器仍在运行 |

Mac 上的 socket 没有测试：测试目录在 `/var/folders/...` 下，路径超过 Unix socket 的长度上限，测试按设计跳过了建 socket 这一步（证据里 `socketMasked: false`）。在 Mac 上有 socket 的目录同样会因为大小写漏洞被拒绝。

写本批测试时发现两处测试本身的缺陷，均已改正并重跑：遮挡测试给的遮挡数量上限（8）小于用例实际的条目数（10），在 Linux 上首次运行时报 `CONTAINER_PROTECTED_FILE_UNMASKABLE`（`hermes-linux/unit-linux-01.log`），改为 16；夹具仓库只提交了 `tracked.txt`，`git status` 会多出 `src/app.txt`，改为一并提交。另外，在写实现之前，我在 Hermes 上手工运行了一次探针脚本 `hermes-linux/probe-linux.sh`，用来确认遮挡、所有者和挂载记录格式；它的输出没有保存，结论已由上表的正式测试覆盖。

[↑ 返回目录](#contents)

<a id="disk-guard"></a>

## 磁盘保护的数值与实测超出量

本批验证时使用的数值：**剩余空间下限 1 GiB，增长阈值 256 MiB，检查间隔 1 秒**。产品接入时如果改用其他数值，要按下面的方法重新实测。

测试方法：容器里用 `dd` 以 1 MiB 块连续写入最多 4 GiB，直到被结束；结束后在宿主上读文件实际大小，超出量 = 文件大小 − 256 MiB。每个平台跑 3 次：

| 平台 | 3 次超出量 | 检查发现时的用量 | 从开始写到被结束 |
| --- | --- | --- | --- |
| Hermes（`/data`，机械硬盘） | 5、17、36 MiB | 260–288 MiB | 约 4.1 秒 |
| Mac（APFS，经 OrbStack 写入） | 174、73、238 MiB | 291–460 MiB | 1.1–1.6 秒 |

结论：

- 超出量大约等于“写入速度 × 检查间隔”。Mac 的写入速度更快，所以超出更多。**实测最大超出 238 MiB**。
- 下限 1 GiB 大于实测最大超出量：检查时剩余空间不低于 1 GiB，在下一次检查前最多再被写掉约 240 MiB，所以磁盘不会被这一个环境写满。这只对单个写入程序、1 MiB 块、本次两台机器的磁盘速度成立；更快的磁盘或并行写入会超出更多。
- 这是非硬性保护，产品和文档不能说成额度。

[↑ 返回目录](#contents)

<a id="case-alias"></a>

## Mac 上的大小写漏洞

Mac 默认的 APFS 不区分文件名大小写，Linux 容器却按区分大小写的规则记录“哪个路径上有挂载”。测试里直接用 Docker 做了对照（证据 `caseAliasProbe`）：把 `.env` 用空文件盖住后，容器里读 `.env` 得到空内容，读 `.ENV` 却得到原内容 `SECRET-ENV`。

所以在不区分大小写的文件系统上，按路径遮挡挡不住。后端在宿主上检查每个敏感条目路径上的每一级名字：换一种大小写或 Unicode 写法后，能否访问到同一个文件（inode 和 device 相同）。能访问到就拒绝原目录模式。后果是：**在 Mac 上，只要授权目录里已有任何需要遮挡的条目，原目录模式都会被拒绝**；没有这类条目的目录可以正常挂载。这符合 ADR 0032 “遮挡不住就拒绝”的规则。Mac 上的这类目录要能执行，需要改用工作副本模式，这是后续的产品选择。

[↑ 返回目录](#contents)

<a id="unit"></a>

## 单元测试覆盖的情况

[`container-execution-backend.unit.test.ts`](../../../../../packages/runtime-sandbox/test/container-execution-backend.unit.test.ts) 新增 13 项，共 29 项。模拟 Docker 的应答，但目录扫描、硬链接、符号链接、FIFO 都在真实的临时目录里建立：

- 目录挂载到固定位置，任务以目录所有者运行；读回的挂载与批准的不一致时删除容器。
- 目录在检查后、容器启动前被替换时结束容器。
- 找不到目录、`hostId` 不符、路径中有符号链接、inode 不符、不是目录、两个目录互相包含、路径含逗号时，不接触运行时就拒绝。
- 敏感条目和 FIFO 被遮挡，`.envrc`、`.git` 等不在清单里的不遮挡。在不区分大小写的文件系统（Mac）上，同一测试改为验证拒绝。所以遮挡的挂载列表只在 Linux 上被实际检查，本批在 Hermes 上运行了这一分支。
- 硬链接的 `.env`、敏感目录里的硬链接、符号链接形式的 `.env`、遮挡条目超过上限、扫描条目超过上限时拒绝。
- gitdir 用绝对路径或 `..` 指到目录外、`commondir` 指到目录外、`.git` 是指到目录外的符号链接、`.git` 文件内容读不懂时拒绝；gitdir 和子模块的 `.git` 都在目录内时允许。
- 读不到剩余空间、剩余空间低于下限时拒绝创建；只读目录不检查磁盘。
- 运行中增长超过阈值、低于下限、读不到时结束容器，之后不再检查，执行被拒绝，停止后仍能给出停止证明。
- 停止后不再检查；新的后端进程执行前按保存的基准补做检查。

[↑ 返回目录](#contents)

<a id="mutations"></a>

## 测试能否发现缺陷

单元测试和资格测试都先于实现写好。单元测试在实现前运行过一次，14 项失败：新增的 13 项，以及把预期从“不支持”改为“找不到目录”的 1 项旧测试，原因都是后端还不支持目录；另有 1 项未处理的 Promise 拒绝，是测试写法问题，已修正。为了确认测试能发现缺陷，逐项临时破坏实现后重跑，再恢复原样。恢复后的 SHA-256 与破坏前一致：`host-directories.ts` 为 `060cfedd…`，`container-execution-backend.ts` 为 `94476694…`。

| 临时破坏 | 平台 | 结果 |
| --- | --- | --- |
| 不做大小写和 Unicode 别名检查 | Mac | 1 项失败（遮挡测试） |
| 不判断增长超过阈值 | Mac | 2 项失败 |
| 容器启动后不再核对目录 | Mac | 1 项失败（目录被替换的测试） |
| 执行前不补做磁盘检查 | Mac | 4 项失败 |
| 不检查敏感文件的硬链接 | Hermes | 1 项失败 |
| 敏感条目不加遮挡 | Hermes | 2 项失败 |

Hermes 上的输出在 `hermes-linux/mutations.log`；Mac 上的输出只记录在本表。

[↑ 返回目录](#contents)

<a id="verification"></a>

## 验证命令与结果

基于提交 `ad3f3cc` 加上本批改动，Node.js 22.22.3。两个平台运行的改动文件 SHA-256 相同，见包内 `changed-files.sha256`。

Mac（在本机沙箱外运行，因为沙箱不允许连接 Docker 的 socket）：

```bash
HIMAWARI_CONTAINER_QUALIFICATION=1 HIMAWARI_CONTAINER_DOCKER_CLI=/usr/local/bin/docker HIMAWARI_CONTAINER_DOCKER_HOST=unix:///Users/<用户>/.orbstack/run/docker.sock HIMAWARI_CONTAINER_EVIDENCE_PATH=<输出文件> npx vitest run --config vitest.workspace.ts --project qualification-container --reporter=verbose
```

Hermes：把代码副本放在 `/data/himawari-p2-20260925-01/source`，用 `/data/himawari-p3-20260921-01/node-v22.22.3-linux-x64` 的 Node.js 和复制来的 npm 缓存执行 `npm ci --offline`，然后运行：

```bash
HIMAWARI_CONTAINER_QUALIFICATION=1 HIMAWARI_CONTAINER_DOCKER_CLI=$(command -v docker) HIMAWARI_CONTAINER_DOCKER_HOST=unix:///var/run/docker.sock HIMAWARI_CONTAINER_WORK_ROOT=/data/himawari-p2-20260925-01/work HIMAWARI_CONTAINER_EVIDENCE_PATH=<输出文件> npx vitest run --config vitest.workspace.ts --project qualification-container --reporter=verbose
```

只重测磁盘保护时加 `-t "grow past the threshold"`。

| 命令 | 结果 |
| --- | --- |
| 资格验证，Mac | 9 项通过（`mac-orbstack/mac-qualification-01.*`）；磁盘保护另测 2 次（`mac-disk-guard-02.*`、`-03.*`） |
| 资格验证，Hermes | 9 项通过（`hermes-linux/hermes-qualification-01.*`）；磁盘保护另测 2 次（`hermes-disk-guard-02.*`、`-03.*`） |
| 容器后端单元测试，Mac | 29 项通过（`mac-orbstack/unit-mac-01.log`） |
| 容器后端单元测试，Hermes | 29 项通过（`hermes-linux/unit-linux-02.log`；`-01` 是改正测试缺陷前的那次失败） |
| `npm ci --offline`，Hermes | 成功，没有下载（`hermes-linux/npm-ci-offline.log`） |
| `npm run typecheck`；改动文件的 `biome format` 与 `biome lint --error-on-warnings` | 通过；lint 只有 `useLiteralKeys` 提示，这是 `noPropertyAccessFromIndexSignature` 要求的写法 |

原始输出打包在 [`raw-logs.tar.gz`](raw-logs.tar.gz)（用 `tar -xzf raw-logs.tar.gz` 解开）。

[↑ 返回目录](#contents)

<a id="gaps"></a>

## 没有覆盖的部分

- **Mac 上的遮挡**：因为大小写漏洞，Mac 上有敏感条目的目录一律拒绝，所以 Mac 上没有“遮挡后读不到”的正向结果；工作副本模式属于后续批次。
- **后端进程停止后的磁盘检查**：检查的计时器在后端进程里。进程崩溃后，要等下一次创建或执行才会恢复检查；这段时间只有硬期限兜底。启动恢复时主动恢复检查，属于计划 P4。
- **运行中新增的敏感文件**：按 ADR 0032 不遮挡，审批时要告知用户；审批内容属于 P3。
- **磁盘保护的极端写入**：只测了单个写入程序、1 MiB 块。并行写入、稀疏文件或更快的磁盘会超出更多。
- **多个可写目录**：磁盘保护按每个目录分别比较基准；本批的真实测试只用了一个可写目录。多个目录在同一块磁盘上时，各自的增长会互相计入，结果会偏严格，没有实测。
- **容器里的 Git 提交**：`.git` 可见，但 BusyBox 镜像没有 `git`，没有在容器里实际提交。要等带工具的 runner 镜像。
- **Hermes 上的 socket 通信**：socket 已被遮挡成空文件，但没有反向证明“不遮挡时容器能连上宿主程序”，因为 BusyBox 的 `nc` 不支持 Unix socket。
- **第一批留下的项目**：联网出口与临时凭据、运行时本身重启、带 Node.js 的 runner、生产账号不能用 Docker、`quality.mjs` 等资格验证入口，都仍未完成，见[第一批的未覆盖部分](../p2-container-lifecycle-01/README.md#gaps)。

[↑ 返回目录](#contents)
