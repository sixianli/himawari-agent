# P2 第一批：容器后端的生命周期与最小权限

日期：2026-09-25 UTC。对应[隔离执行实施计划的 P2](../../../../../docs/execution/plans/2026-09-24-isolated-tool-execution-plan.md#p2)。规则来源是 Spec 的[组件职责与后端合同](../../../../../docs/execution/specs/2026-09-24-isolated-tool-execution-design.md#backend)、[停止顺序](../../../../../docs/execution/specs/2026-09-24-isolated-tool-execution-design.md#stop-order)和[不依赖控制进程存活的硬期限](../../../../../docs/execution/specs/2026-09-24-isolated-tool-execution-design.md#deadline)。

本批实现了第一个真实的执行后端：它通过 Docker 命令行（容器运行时的管理命令）创建、执行、查看、停止、核查和删除任务环境，并在 Mac（OrbStack）和 Hermes（Linux）上用真实容器验证。本批的环境**不挂载目录、不联网**：挂目录要先实现原目录模式的磁盘保护和敏感文件遮挡，联网要先实现任务专属出口，都在 P2 后续批次。后端还没有接进产品，新任务执行仍然关闭。

<a id="contents"></a>

## 目录

- [用词](#terms)
- [实现了什么](#implementation)
- [真实容器上验证了什么](#qualification)
- [单元测试覆盖的情况](#unit)
- [测试能否发现缺陷](#mutations)
- [验证命令与结果](#verification)
- [没有覆盖的部分](#gaps)

<a id="terms"></a>

## 用词

| 用词 | 意思 |
| --- | --- |
| 容器 | 用 Linux 内核隔离出来的一组进程，有自己的进程编号空间、文件系统视图和网络；本批一个任务环境就是一个容器 |
| OrbStack | Mac 上的 Docker 兼容运行时，在一个 Linux 虚拟机里运行容器 |
| 固定镜像 | 按内容摘要（SHA-256）指定的容器文件系统模板；本批用 P0 已固定的 BusyBox 镜像 `docker.io/library/busybox@sha256:bdf57e52…`，不从网上拉取 |
| 受保护 init | 容器里的 1 号进程；它只按墙上时间计时，到期退出，内核随即结束容器里所有进程 |
| capability | Linux 把 root 权限拆成的一项项特权，例如修改系统时间 |
| seccomp | 内核的系统调用过滤 |
| no-new-privileges | 进程运行中不能再获得新特权的内核标记 |
| tmpfs | 放在内存里、可以设容量上限的临时文件系统 |
| `setsid`、两次 fork | 让程序脱离启动它的进程、在后台继续运行的两种常见做法 |
| 停止证明 | 后端给出的、带摘要证据和有效期的“环境已整体停止且不会复活”的记录 |
| 定位信息（locator） | 后端返回的环境位置：哪个后端、哪个运行时实例、哪个容器、按哪个创建请求建的、实际生效的策略摘要 |
| 资格验证 | 在真实运行时上证明后端做得到它声明的保证；只有显式打开开关（opt-in）才运行 |

[↑ 返回目录](#contents)

<a id="implementation"></a>

## 实现了什么

代码在 [`packages/runtime-sandbox/src/execution-backend/`](../../../../../packages/runtime-sandbox/src/execution-backend/)：

- [`docker-command.ts`](../../../../../packages/runtime-sandbox/src/execution-backend/docker-command.ts)：用固定参数调用 Docker 命令行，有超时和输出大小上限；忽略调用方环境变量里的 `DOCKER_HOST` 等设置，模型和任务都不能改变连到哪个 Docker。
- [`container-execution-backend.ts`](../../../../../packages/runtime-sandbox/src/execution-backend/container-execution-backend.ts)：实现产品后端接口 `ExecutionBackendPort` 的六个操作和能力声明。

| 操作 | 做法 |
| --- | --- |
| 能力声明 | 读 Docker 的实例 ID 作为运行时身份；要求 cgroup v2（Linux 限制资源的机制）和 seccomp，并确认固定镜像已在本机。声明五项保证，**不声明**任务联网出口，所以现有协调服务会拒绝使用它，这是有意的 |
| 创建 | 只接受固定镜像和固定 runner 摘要；有目录或网络的权限上限直接拒绝。先在宿主上记下创建请求，再建容器；建好后读回容器的实际配置逐项核对，不一致就删除且不启动。启动前再查一次停止标记，已有停止标记就删除容器 |
| 容器配置 | init 用 65532 用户，任务用 65534 用户；根文件系统只读；去掉全部 capability；no-new-privileges；无网络；不自动重启；不拉取镜像；进程数、内存（不允许用交换区）、CPU 上限；`/tmp` 是有容量上限的 tmpfs，HOME、临时目录和缓存都放在里面；不写容器日志 |
| 执行 | 有停止标记、Docker 换了实例、容器被重新启动过、或容器不在运行时都拒绝；以任务用户执行，输出存在宿主上，只返回引用，内容按不可信处理。超时时报错，由调用方停掉整个环境 |
| 查看 | 按容器名找，再核对全部身份标签、容器 ID、运行时实例和策略摘要。连不上 Docker、换了实例、标签不符、被重新启动过都返回 `unknown`；暂停算 `running`；找不到返回 `not_found` |
| 停止 | 先写停止标记（之后所有执行和启动都被拒绝），再整体停止容器 |
| 核查已停止 | 只有容器已退出、未暂停、未重新启动、同一运行时实例、不自动重启且无网络时才给出停止证明；证据是当时读回的容器状态，保存在宿主上并附摘要。容器从没启动过时给出“从未创建”证明；启动过的容器被外部删掉时不给证明 |
| 删除 | 只删除已停止的容器；先保存证据和删除记录再删除。之后找不到容器时，用删除记录继续给出停止证明 |

每个环境的记录（创建请求、启动开始、实际启动时间、停止标记、删除记录、证据、执行输出）保存在后端配置的宿主目录里，后端进程重启后照样可用。

[↑ 返回目录](#contents)

<a id="qualification"></a>

## 真实容器上验证了什么

测试文件：[`container-execution-backend-qualification.test.ts`](../../../../integration/container-execution-backend-qualification.test.ts)，在 [`ci/policy.json`](../../../../../ci/policy.json) 登记为 `kind: qualification`，项目名 `qualification-container`。只有设置 `HIMAWARI_CONTAINER_QUALIFICATION=1` 才运行；打开后连不上运行时，5 项全部失败，不会跳过（见 [`missing-runtime.log`](raw-logs.tar.gz)）；不打开时 5 项跳过。

Mac 和 Hermes 用同一份测试，结果一致（Hermes 通过 Docker 的 SSH 连接运行容器，测试程序在 Mac 上）：

| 场景 | Mac（OrbStack 2.2.3，Docker 29.4.0，arm64） | Hermes（Ubuntu 22.04，Docker 29.6.1，x86_64） |
| --- | --- | --- |
| 任务用户、特权 | uid 65534；有效 capability 为 0；no-new-privileges 为 1；seccomp 为过滤模式 | 相同 |
| 写根文件系统、Docker socket | 写 `/etc` 被拒绝；容器里没有 Docker socket | 相同 |
| 网络 | 只有回环网卡 `lo`；访问 `1.1.1.1` 失败 | 相同 |
| 私有存储上限 16 MiB | 写 64 MiB 只写进 16777216 字节 | 相同 |
| 进程数上限 64 | 连续启动 200 个后台程序，到上限时报 `can't fork`，宿主看到 63 个进程 | 相同 |
| 内存上限 128 MiB | 不断加倍字符串的程序被内核结束，退出码 137 | 相同 |
| 攻击受保护 init | 任务向 1 号进程发 KILL、TERM 都返回失败；读 init 内存、替换 `/bin/sh` 被拒绝；改系统时间报 `Operation not permitted` 且时钟没有变；1 号进程属于 65532 用户；之后环境仍在运行 | 相同 |
| 整体停止 | 用 `setsid`、两次 fork、`nohup` 启动的后台程序在执行结束后仍在运行（宿主看到至少 3 个）；停止后容器退出，Docker 报容器未运行；之后的执行被拒绝 | 相同 |
| 删除后仍能证明 | 删除容器后，按删除记录仍给出停止证明，证据里标明已删除 | 相同 |
| 硬期限 | 期限 8 秒，无人调用停止，环境在 8.7 秒时整体停止；再等 3 秒仍未重启，重启次数为 0；之后的执行报“未运行” | 9.1 秒停止，其余相同 |
| 暂停 | 返回 `running`，不算已停止 | 相同 |
| 连错运行时 | 用别的运行时实例 ID 查询返回 `unknown` | 相同 |
| 证明后又被启动 | 返回 `unknown`，再核查报 `CONTAINER_RESTARTED` | 相同 |
| 被外部删除 | 返回 `not_found`，核查停止报 `CONTAINER_STOP_UNVERIFIED`，不给证明 | 相同 |
| 清理 | 测试结束按本轮标签删除遗留容器，读回为 0；Mac 与 Hermes 上原有容器不受影响（Hermes 仍是 38 个运行中） | 相同 |

写本批测试时发现两处测试本身的缺陷，均已改正并重跑：BusyBox 的 `date -s` 修改时间失败时仍返回 0，所以改为同时检查错误信息和时钟有没有变；`kill` 检查原来把错误信息当成结果，断言形同虚设，改为检查退出码。

[↑ 返回目录](#contents)

<a id="unit"></a>

## 单元测试覆盖的情况

[`container-execution-backend.unit.test.ts`](../../../../../packages/runtime-sandbox/test/container-execution-backend.unit.test.ts) 用模拟的 Docker 应答，覆盖真实运行时上难以稳定触发的情况，共 16 项：

- 连不上 Docker、固定镜像缺失、cgroup 不是 v2 时拒绝声明能力。
- 同一创建请求重复创建只建一个容器；另一个创建请求用同一环境时拒绝。
- 权限上限带目录或网络、镜像或 runner 摘要不符、期限已过时，不接触运行时就拒绝。
- 读回的配置不符（例如被改成特权容器）时删除且不启动。
- 停止请求恰好发生在“容器已建、未启动”之间时，不启动、删除容器，并给出“从未创建”证明；之后不能再创建。
- 执行命令超时时报 `CONTAINER_COMMAND_TIMEOUT`；Docker 换了实例、容器被重新启动过、已有停止标记时拒绝执行。
- 未请求停止、停止请求不符、暂停中、运行时不可达、证明后被重新启动时都不给停止证明；证据文件的摘要与返回值一致。
- Docker 命令超时会被结束；每路输出按上限截断；调用方的 `DOCKER_HOST` 不生效。

[↑ 返回目录](#contents)

<a id="mutations"></a>

## 测试能否发现缺陷

测试先写在实现之前：单元测试首次运行时因模块不存在而无法加载；资格测试也写在实现之前，但没有在实现前单独运行。这只证明顺序，不证明行为。为确认测试能发现缺陷，逐项临时破坏实现后重跑，然后按原样恢复（恢复后 SHA-256 与破坏前一致，`728bdb76…`）：

| 临时破坏 | 结果 |
| --- | --- |
| 不检查容器是否被重新启动过 | 单元测试 3 项失败 |
| 执行前不检查停止标记 | 单元测试 1 项失败 |
| 核查停止时不要求容器已停止 | 单元测试 1 项失败 |
| 受保护 init 改用任务用户运行（真实 OrbStack） | 资格测试失败：任务发 KILL、TERM 返回成功，1 号进程属于 65534 用户 |

这几次破坏的输出只记录在本表，没有另存日志。

[↑ 返回目录](#contents)

<a id="verification"></a>

## 验证命令与结果

基于提交 `ec1bb3e` 加上本批改动，Node.js 22.22.3，macOS 27.2（arm64）。各平台的 Docker 版本、实例 ID、内核和镜像 ID 见包内 `environment.txt`。

真实容器资格验证（需要在本机沙箱外运行，因为沙箱不允许连接 Docker 的 socket）：

```bash
HIMAWARI_CONTAINER_QUALIFICATION=1 HIMAWARI_CONTAINER_DOCKER_CLI=/usr/local/bin/docker HIMAWARI_CONTAINER_DOCKER_HOST=unix:///Users/<用户>/.orbstack/run/docker.sock HIMAWARI_CONTAINER_EVIDENCE_PATH=<输出文件> npx vitest run --config vitest.workspace.ts --project qualification-container
```

Hermes 把 `HIMAWARI_CONTAINER_DOCKER_HOST` 设为 `ssh://hermes-tailscale-breakglass`，要求 Hermes 已有同一固定镜像。

| 命令 | 结果 |
| --- | --- |
| 资格验证，Mac | 5 项通过（`mac.log`、`mac-vitest.json`、`mac-observations.json`） |
| 资格验证，Hermes | 5 项通过（`hermes.log`、`hermes-vitest.json`、`hermes-observations.json`） |
| 资格验证，打开开关但运行时不存在 | 5 项失败，均为 `CONTAINER_RUNTIME_UNAVAILABLE`（`missing-runtime.log`） |
| 资格验证，不打开开关 | 5 项跳过（`opt-out.log`） |
| 容器后端单元测试 | 16 项通过（`unit-container-backend.log`） |
| `npm run typecheck`、`npm run check:boundaries`；改动文件的 `biome format` 与 `biome lint --error-on-warnings` | 通过 |

`npm run check:ci-policy` 在提交前报 “Vitest file selection differs from policy: integration”：这项检查同时用上一个提交里已接受的登记核对 Vitest 的文件选择，本批把资格测试文件从 integration 项目中排除，改动登记前后必然不一致。提交 `e5195c3` 之后以它为基准重新检查，通过。向 `main` 提 PR 时，托管 CI 会把它作为一次测试登记变更来核对。

**正式的 `npm test`**：提交 `e5195c3` 之后在本机沙箱外运行 `npm test`（`scripts/ci/local.mjs --check test`，使用已下载的 CI 工具），按 `e5195c3` 打安装包后单线程运行全部测试项目。构建和测试两步都通过：contracts 355 项、unit 1983 项（比上一批多 16 项容器后端测试）、integration 1779 项、e2e 3 项、pi-compat 130 项，没有失败或跳过。报告在 [`npm-test-e5195c3.tar.gz`](npm-test-e5195c3.tar.gz)，包括各项目的 JSON、JUnit 和日志、运行上下文和安装包的 SHA-256；安装包本身没有保存。

integration 比上一批少 1 项，已逐项比对两次报告的测试清单：唯一少掉的是 `workspace-boundaries.test.ts` 里的 “rejects @himawari-agent/runtime-sandbox -> @himawari-agent/execution-contracts”。这个测试按 [`scripts/boundary-policy.mjs`](../../../../../scripts/boundary-policy.mjs) 为每一条**不允许**的包依赖自动生成一项反向检查；本批允许 `runtime-sandbox` 依赖版本化合同包 `execution-contracts`（后端要按合同解析和返回定位信息与停止证明），这一条就不再生成。其他反向检查照常运行，`runtime-sandbox` 仍不能依赖 application 等其他包。

**覆盖率检查**：真实容器资格测试不计入覆盖率，所以另在本机沙箱外运行 `node scripts/ci/local.mjs --check coverage`（针对 `e5195c3`）。unit 1983 项、contracts 355 项、integration 1779 项全部通过；tooling 1042 项中 4 项失败，检查因此在计算改动行阈值之前停止，**这台 Mac 上没有得到覆盖率检查的正式通过结果**。4 项失败逐一核对如下：

| 失败的测试 | 原因 | 与本批的关系 |
| --- | --- | --- |
| `test/tooling/policy.test.mjs` 的 Vitest 项目数 | 期望 10 个项目，本批登记资格测试后是 11 个 | 本批造成；已把期望值改为 11，该文件 393 项通过 |
| `test/tooling/toolchain.test.mjs` 的治理快照 | 工作目录的 `tools/document-governance/` 里有一个 2026-09-24 生成、被 `.gitignore` 忽略的 `.DS_Store`（macOS Finder 的文件夹显示信息），检查要求目录里只有登记过的文件 | 本机环境造成，干净检出里没有这个文件；在 `ec1bb3e` 的干净工作副本里该项通过 |
| `test/tooling/gate-installation.test.mjs` | macOS 的 `/var` 实际指向 `/private/var`，测试比较未解析的路径 | 本批之前已存在：在 `ec1bb3e` 的干净工作副本里同样失败 |
| `test/tooling/main-confirmation.test.mjs` | 期望对象与实际不符 | 本批之前已存在：在 `ec1bb3e` 的干净工作副本里同样失败，未进一步排查 |

检查已生成覆盖率报告，按其中的 lcov 数据直接计算本批新增文件：`container-execution-backend.ts` 行 228/245（93.1%）、分支 178/223（79.8%）、函数 43/44；`docker-command.ts` 行 29/31（93.5%）、分支 6/8（75.0%）。项目阈值是改动行 80%、函数分支 70%。这是按报告自行计算的数字，不能代替覆盖率检查的正式结论。检查的结果、日志和 lcov 数据在 [`coverage-e5195c3.tar.gz`](coverage-e5195c3.tar.gz)。

原始输出打包在 [`raw-logs.tar.gz`](raw-logs.tar.gz)（用 `tar -xzf raw-logs.tar.gz` 解开）。

[↑ 返回目录](#contents)

<a id="gaps"></a>

## 没有覆盖的部分

- **挂载目录与原目录模式**：相邻仓库、假秘密、符号链接、外置 gitdir、挂载写回、用户未提交修改的保留，以及磁盘保护和敏感文件遮挡，都要等第二批实现目录挂载后验证。
- **联网出口与临时凭据**：本批只证明“无网络”；按目标放行、DNS/IPv6/UDP 绕行和凭据撤销属于后续批次。后端因此不声明联网保证。
- **运行时本身重启**：P0 把“运行时重启后能否核实身份和状态”留到 P2。重启 OrbStack 或 Hermes 的 Docker 会影响机器上其他容器（Hermes 有 38 个在运行），本批没有做，需要另行安排。
- **工具 runner**：本批用 BusyBox 的 `sh` 执行命令，没有 Node.js，不能运行 Pi 的工具。带 Node.js 的 runner 镜像需要新下载，之后先征得同意。
- **主机休眠**：P0 已测 Mac 休眠时按墙上时间计时的等待准时到期；本批的 init 采用同一计时方式，没有重测休眠。
- **产品接入**：协调服务要求全部六项保证，本后端缺联网保证而被拒绝；产品默认路径不变。
- **生产账号与 Docker 权限冲突**：[Hermes 升级 Runbook](../../../../../docs/runbooks/hermes-control-center-upgrade-runbook.md) 规定生产运行账号 `himawari` 不得加入 Docker 组，并要求验证它无法控制 Docker；本后端却必须能调用 Docker 才能创建和停止环境。接入产品（P3）和部署（P8）之前要先决定由谁、通过什么受限入口替它调用 Docker，本批没有处理。
- **资格验证入口**：`scripts/ci/quality.mjs` 的检查项、`qualify:*` 命令和 `quality.yml` 的 Linux 任务尚未添加，属于计划 P2 最后一项。

[↑ 返回目录](#contents)
