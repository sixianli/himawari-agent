# P3 第二批（前半）：Pi 工具在容器环境里运行

日期：2026-09-26 UTC。对应[隔离执行实施计划的 P3](../../../../../docs/execution/plans/2026-09-24-isolated-tool-execution-plan.md#p3)中“把完整的 Pi 工具实现及其内置搜索和临时文件读写移进环境内的 runner；复用现有工厂、Operations、输出保护和产物导出”这一项的前一半。本批让七个 Pi 工具在容器环境里真正运行，并由宿主读回写入结果；固定目标文件、另存副本、移动目录这三类要由宿主核对版本的写入，留到后一半。产品仍未接入。

## 用词

| 用词 | 意思 |
| --- | --- |
| runner | 容器里替 Pi 工具实际干活的程序，可信程度和任务代码相同 |
| runtime | 已安装的 Himawari 程序目录（编译后的代码和依赖），由 `npm test` 的构建步骤产生 |
| Operations | Himawari 交给 Pi 工具的受控读写和命令执行接口（`createSandboxedCodingOperations`） |
| 设备号:inode | 文件系统给一个目录的编号，现有代码用它确认“还是原来那个目录” |

## 做了什么

**runtime 怎样进入容器**

- 在 Linux 容器里直接运行仓库源码行不通：源码里的导入写的是 `.js`，实际文件是 `.ts`，必须先编译。
- 改为挂载构建好的安装包里的 `runtime/` 目录。实测结果：这个目录在 node Alpine 容器里只读挂载、不联网、以 nobody 用户运行时，Pi 执行器、平台层和 Pi 编码工具包都能正常加载。Pi 依赖里的原生模块（剪贴板、终端界面）不在 runner 用到的路径上。
- 容器后端新增 `runtime` 配置（[`container-execution-backend.ts`](../../../../../packages/runtime-sandbox/src/execution-backend/container-execution-backend.ts)）：
  - 目录只读挂到 `/opt/himawari`；
  - 创建环境前核对：目录存在、是真实目录、不是经符号链接到达的，否则报 `CONTAINER_RUNNER_UNQUALIFIED`，并且不调用运行时；
  - runtime 的摘要计入 runner 摘要（新增 `containerRunnerDigest`）。不配置 runtime 时，runner 摘要和原来的常量相同。

**容器 runner**

- 新增入口 [`container-pi-main.ts`](../../../../../apps/agent-service/src/capability-programs/container-pi-main.ts) 和输入合同 [`pi-container-runner-v1.ts`](../../../../../packages/execution-contracts/src/pi-container-runner-v1.ts)。
- 合同规定：
  - 工作目录必须正好是 `/workspaces/<授权目录编号>`；
  - 只读授权不能用 write 和 edit；
  - 不接受另存副本和移动目录。
- runner 复用 Pi 的工具工厂（`executeSandboxedPiCodingTool`）和现有的受控 Operations：
  - 屏蔽 `.git`、`.env`、`.himawari-*`；
  - 设置 `PI_OFFLINE=1`，Pi 不会自行下载 `rg` 和 `fd`，直接用 runner 镜像里的；
  - 命令查找路径用容器里的标准 PATH。
- 整理结果（导出完整输出、密钥扫描、大小上限、退出码）的代码从现有 runner 里抽成共用的 [`pi-foreground-result.ts`](../../../../../apps/agent-service/src/capability-programs/pi-foreground-result.ts)，两个 runner 共用。现有 runner 的 42 项测试照常通过。
- Operations 的参数 `binaryDirectory` 改名为 `commandPath`（命令查找路径，可以是冒号分隔的多个目录）。现有 runner 仍传原来的工具目录，行为不变。

**根目录身份**

- 第一次在容器里跑 read 时，报 `HOST_ROOT_IDENTITY_CHANGED`：受控文件访问层要求目录的“设备号:inode”等于授权里记录的宿主编号，而 Mac 容器里看到的编号和宿主不同（P0 已实测）。
- 修法：容器 runner 启动时读取工作目录在容器里的编号，作为本次调用的根目录身份。这样文件访问层核对的是“本次调用期间根目录没有被换掉”，这在容器内部成立。宿主目录的真实身份，由后端在创建环境时从宿主一侧核对，符合 Spec 里“路径身份由宿主一侧解析”的要求。

## 测试

- **合同测试** [`pi-container-runner.contract.test.ts`](../../../../../packages/execution-contracts/test/pi-container-runner.contract.test.ts)：先写后实现，11 项。
- **后端单元测试**：新增 2 项，共 48 项。覆盖只读挂载和摘要绑定；runtime 不存在、不是目录、经符号链接时拒绝，并且不调用运行时。
- **真实容器资格测试** [`container-pi-runner-qualification.test.ts`](../../../../integration/container-pi-runner-qualification.test.ts)：登记为独立项目 `qualification-container-runner`。运行它需要：
  - `HIMAWARI_CONTAINER_RUNNER_QUALIFICATION=1`；
  - 构建好的 runtime 目录和它的摘要（`HIMAWARI_CONTAINER_RUNTIME_ROOT`、`HIMAWARI_CONTAINER_RUNTIME_DIGEST`）；
  - 本机构建的 runner 镜像 ID。

  测试经容器后端的 `execute` 调用 runner，工作目录是挂载进去的宿主目录：

| 检查 | Mac（OrbStack） | Hermes（Docker 29.6.1） |
| --- | --- | --- |
| write 新文件，宿主读回内容，SHA-256 和字节数与 runner 报告一致 | 通过 | 通过 |
| edit 改文件，宿主读回内容和摘要一致 | 通过 | 通过 |
| read、grep（`rg`）、find（`fd`）、ls 结果正确，环境不联网 | 通过 | 通过 |
| bash 运行 `node --version` 和 `git --version`，写出的文件宿主能读到 | 通过 | 通过 |
| bash 命令 `exit 7`：退出码 7 原样传回 | 通过 | 通过 |
| 读取真实存在的 `.git/config`、`.himawari-state.txt` 以及 `.env`：都被拒绝，输出里没有文件内容 | 通过 | 通过 |
| 只读授权：合同拒绝 write；bash 写文件失败，宿主文件不变 | 通过 | 通过 |
| 两个环境都拿到停止证明，测试留下的容器读回为 0 | 通过 | 通过 |

Mac 上把受保护的文件放进测试目录时，注意到一条 P2 已有的规则：含 `.env` 的目录在 Mac 上不能挂载（`CONTAINER_PROTECTED_FILE_UNMASKABLE`，因为文件系统不区分大小写）。所以测试目录里不放 `.env`，改为用真实存在的 `.git/config` 和 `.himawari-state.txt` 检验保护。最初的版本只检查了不存在的文件：即使没有保护，读取也会因为文件不存在而失败，发现后改正了。

**反向检查**：在 runtime 的一个临时副本里，同时去掉 runner 和 Operations 两处路径保护，资格测试失败（读取 `.git/config` 成功了）。副本随后删除，仓库代码没有改动。

**原有测试**：

- 容器资格测试在两台机器上各 14 项通过。这批改了后端，增加了 runtime 挂载。
- Mac 上合同、平台层、后端与现有 runner 的单元测试共 768 项通过；Hermes 上相关单元测试 78 项通过。
- tooling 项目 1045 项通过，9 项失败，都是[资格验证入口的记录](../p2-qualification-entry-01/README.md)里已查明的原有环境问题。此前由 `.DS_Store` 引起的那一项，删除该文件后已经通过。
- `format:check`、`typecheck`、`lint`、`check:boundaries`、`check:v0.2-coverage`、`check:v0.2-invariants`、`check:secrets` 都通过。

**runtime 的来源**：用 `node scripts/ci/local.mjs --check build` 从工作区构建。构建记录里的提交号是 `6e22219`，但编译的是当时工作区里还没提交的本批代码。内容摘要 `04f8cd2c…`，摘要信息在包里的 `dev-artifact-summary.json`。

Hermes 上用的也是这份 Mac 构建的 runtime，因为 Hermes 没有安装构建工具。runner 用到的都是纯 JS 模块，所以这次验证有效；但正式部署时，Hermes 应该使用 Linux 版安装包。

原始输出打包在 [`raw-logs.tar.gz`](raw-logs.tar.gz)。

## 没有覆盖的部分

- **固定目标文件、另存副本、移动目录**：这三类写入依赖宿主事先算好的文件版本和发布日志，需要改成由宿主自己读回并比较版本（Spec 的 ITE-19）。这是第二批的后一半。
- **Worker 一侧**：Worker 还没有按参数引用读取调用参数、组装 runner 输入，本批测试直接经后端调用。这属于第三批的产品接入。
- **后台执行的 bash**：现有 runner 支持后台和服务模式，容器 runner 目前只支持前台调用。
- **runner 输出**：输出仍按“不可信”对待。本批用宿主读回核对了写入，但产品里怎样使用这份输出，是第三批的工作。
