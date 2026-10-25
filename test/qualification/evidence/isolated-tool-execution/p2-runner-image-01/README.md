# P2：运行 Pi 工具的 runner 镜像

日期：2026-09-26 UTC。对应[隔离执行实施计划的 P2](../../../../../docs/execution/plans/2026-09-24-isolated-tool-execution-plan.md#p2)第 2 项里还缺的“运行 Pi 工具的 runner 镜像”。runner 是容器里替 Pi 工具实际干活的程序，见 Spec 的[环境内 runner 的可信程度](../../../../../docs/execution/specs/2026-09-24-isolated-tool-execution-design.md#runner-trust)。本批只准备镜像，并让后端能使用它；runner 程序本身和 Pi 工具的接入属于 P3。

## 用词

| 用词 | 意思 |
| --- | --- |
| 仓库摘要 | 镜像在镜像仓库里的 SHA-256 摘要，例如 `node@sha256:e583…`；镜像从仓库下载时才有 |
| 内容 ID | Docker 根据镜像内容算出的 SHA-256，例如 `sha256:0918…`；本机构建的镜像只有这个，没有仓库摘要 |
| Alpine | 一个很小的 Linux 发行版，node 官方镜像的 `-alpine` 版本以它为底 |
| `rg`、`fd` | ripgrep 和 fd，两个文件搜索程序，Pi 的 grep 和 find 工具要用 |

## 用户的决定

2026-09-26 我给出三个方案，用户选择 A：以已经固定的 node 镜像为底，自建 runner 镜像。用户同意修改后端，让它接受本地构建镜像的内容 ID。之前用户已批准“运行 Pi 工具的 runner 镜像：需要下载镜像”；构建时从 Alpine 软件源下载的软件包属于这个范围。

没有选的两个方案：

- B：沿用现有镜像，另外挂入 `rg`、`fd`。这样没有 `bash`，也没有 Spec 要求在环境内执行的 `git`。
- C：换用约 1.1 GB 的 Debian 版 node 镜像。它要占用 Hermes 只剩 16 GB 的根盘，而且仍然要单独挂入 `rg`、`fd`。

## 为什么需要这几个程序

对照固定的 Pi 源码（`pi-mono/packages/coding-agent`）：

- Pi 的 bash 工具先找 `/bin/bash`，找不到就退回 `sh`（`utils/shell.ts` 的 `getShellConfig`）。
- grep 和 find 工具通过 `ensureTool` 找 `rg`、`fd`（`utils/tools-manager.ts`）：先看 Pi 自己的工具目录，再看 PATH，都没有就去下载。环境里通常不能联网，所以要事先装好。
- Spec 的[凭据的使用方式](../../../../../docs/execution/specs/2026-09-24-isolated-tool-execution-design.md#credentials)要求本地 Git 提交在环境内执行，所以要有 `git`。
- runner 用 Node.js 运行，版本和产品一致，都是 22.22.3。

## 做了什么

- **构建文件** [`runner-image/Dockerfile`](../../../../../packages/runtime-sandbox/runner-image/Dockerfile)：以 `node:22.22.3-alpine@sha256:e583…`（Alpine 3.24.1）为底，安装 `bash=5.3.9-r1`、`git=2.54.0-r0`、`ripgrep=15.1.0-r0`、`fd=10.2.0-r3`。这些是 2026-09-26 Alpine 3.24 软件源里的版本。Alpine 软件源只保留每个软件包的最新修订，以后按原版本号重新构建可能会失败，那时要更新版本号，并重新做资格验证。
- **后端的镜像固定方式**：任务镜像和出口代理镜像都必须写明 `pin`（固定方式），见 [`container-records.ts`](../../../../../packages/runtime-sandbox/src/execution-backend/container-records.ts) 的 `PinnedImage`。
  - `registry-digest`：和原来一样，镜像必须带有这个仓库摘要。
  - `image-id`：按 `sha256:<内容 ID>` 查找镜像，而且查到的 ID 必须完全相同。不按镜像名查，因为镜像名可以被改指到别的镜像。
  - 两种方式下，[`container-execution-backend.ts`](../../../../../packages/runtime-sandbox/src/execution-backend/container-execution-backend.ts) 和 [`egress-proxy.ts`](../../../../../packages/runtime-sandbox/src/execution-backend/egress-proxy.ts) 创建容器时，都直接用核对过的内容 ID，不再用“镜像名@摘要”。这样核对过的镜像和实际使用的镜像一定是同一个。
- **资格验证入口**：
  - `qualify:container` 现在还要求设置 `HIMAWARI_CONTAINER_RUNNER_IMAGE_ID`（本机构建出的内容 ID），缺少时和缺少运行时一样直接失败。
  - `quality.yml` 的 `container` 任务在拉取镜像后，先构建 runner 镜像，把内容 ID 写进后续步骤的环境变量，见 [`quality-policy.mjs`](../../../../../scripts/ci/quality-policy.mjs)。

同一台机器每次构建出的内容 ID 可能不同，不同架构的一定不同。所以内容 ID 由构建它的机器记录，并交给后端。信任的依据是“这台机器用仓库里的构建文件构建出的这个镜像”。

## 测试

**后端单元测试**（[`container-execution-backend.unit.test.ts`](../../../../../packages/runtime-sandbox/test/container-execution-backend.unit.test.ts)）：先写后实现。新增 2 项，共 46 项。

- 本地镜像按内容 ID 固定：
  - 镜像不存在时拒绝；
  - 声明为 `registry-digest` 时，不能拿一个没有仓库摘要的本地镜像来满足；
  - 创建容器用的是 `sha256:<内容 ID>`，而不是镜像名。
- 仓库镜像创建容器时，也改用核对过的内容 ID。

写实现之前运行，这 2 项失败，一批会创建容器的旧测试也失败了：测试替身开始照实记录传入的镜像名，而当时的实现还在用“镜像名@摘要”创建容器。实现后全部通过。

**资格测试**（[`container-execution-backend-qualification.test.ts`](../../../../integration/container-execution-backend-qualification.test.ts)）：新增 1 项，共 14 项。runner 镜像里的环境挂载一个有写权限的目录，任务以目录所有者的身份运行，检查以下几点：

- `bash`、`node`、`git`、`rg`、`fd` 的版本；
- `rg`、`fd` 能在挂载的目录里找到文件；
- `git` 能在挂载的目录里提交，并且在宿主一侧能读到这次提交；
- 根文件系统写不进去；
- 连不上外网。

**tooling 测试**：[`quality-local.test.mjs`](../../../../../test/tooling/quality-local.test.mjs) 把 runner 内容 ID 加进必需的变量；[`quality-policy.test.mjs`](../../../../../test/tooling/quality-policy.test.mjs) 新增一项：工作流里缺少构建步骤时，校验要报错。

## 结果

| 检查 | Mac（OrbStack 2.2.3，arm64） | Hermes（Docker 29.6.1，amd64） |
| --- | --- | --- |
| 构建 | 成功，内容 ID `09181f1e2ce4…`，约 185 MB | 成功，内容 ID `b27f6f38dd2d…`；根盘剩余空间仍是 16 GB |
| runner 里的程序 | bash 5、node v22.22.3、git 2.54.0、rg 15.1.0、fd 10.2.0 | 相同 |
| 搜索、提交、根文件系统、外网 | 都符合预期；任务用户为目录所有者 501 | 都符合预期；任务用户为 1000 |
| 后端单元测试 | 46 项通过 | 46 项通过 |
| 资格测试 | 经 `qualify:container` 入口运行，14 项通过（`qualify-container-mac-runner-01/`） | 14 项通过（`hermes-qualification-01.*`） |
| 不给 runner 内容 ID | 这一项失败，报错点名缺少 `HIMAWARI_CONTAINER_RUNNER_IMAGE_ID`，没有跳过 | 未另测 |

**反向检查**：临时把“按内容 ID 查镜像”改成按镜像名查，对应的单元测试失败（`mutation-image-name.log`），之后按 SHA-256 核对恢复了原文件。

**tooling 项目**：1040 项通过，10 项失败（`tooling-02.log`），都是[资格验证入口的记录](../p2-qualification-entry-01/README.md)里已经查明的原有失败。

这次完整运行 tooling 时，还发现上一个提交 `e765f53` 漏改了一处：`policy.test.mjs` 写死了 11 个 Vitest 项目，而新增重启测试后是 12 个。已单独提交 `cb98f47` 修正，修正前的输出是 `tooling-01-before-count-fix.log`。

**正式的 `npm test`**：提交 `86b349b` 之后在本机沙箱外运行，构建和测试两步都通过：contracts 355 项、unit 2014 项（比上一次多 2 项，正是本批新增的 2 项后端测试）、integration 1779 项、e2e 3 项、pi-compat 130 项，没有失败或跳过。报告在 [`npm-test-86b349b.tar.gz`](npm-test-86b349b.tar.gz)，安装包只记录了 SHA-256。

原始输出打包在 [`raw-logs.tar.gz`](raw-logs.tar.gz)。

## 没有覆盖的部分

- **runner 程序本身**：镜像里还没有 Himawari 的 runner 代码和 Pi 的依赖包，Pi 工具也还没有真正在环境里运行过。这些属于 P3。
- **原有的资格测试**：前面的 13 项仍然使用 BusyBox 镜像，没有换成 runner 镜像。
- **GitHub 上的构建**：`quality.yml` 里的构建步骤没有在 GitHub 上真正跑过。
