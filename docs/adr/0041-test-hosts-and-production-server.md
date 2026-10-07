---
status: superseded
document_type: adr
decision_status: superseded
supersedes: ""
superseded_by: "docs/adr/0050-hermes-root-disk-cleanup-without-floor.md"
date: "2026-09-29"
---

# ADR 0041：测试在 Hermes 上运行，开发 Mac 不跑测试，生产部署到云服务器

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
  - [测试和部署的位置](#hosts)
  - [测试层级和触发条件](#layers)
  - [提前运行完整测试的情况](#early-full)
  - [提交与结果复用](#commits)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

[ADR 0038](0038-test-layer-trigger-timing.md) 规定了各层测试什么时候运行，并默认在开发 Mac 上跑第 0–4 层；第 5 层是部署前在 Hermes（局域网里的 Linux 服务器）上验证，每次都要用户同意。

2026-09-29 工具执行排查第二轮最后一批在开发 Mac 上跑完整测试和产品路径资格时，Mac 明显变卡。用户同一天新购买了一台云服务器 `84.247.157.41`，作为以后的生产环境。

<a id="decision"></a>

## 决定

用户在 2026-09-29 确认：

<a id="hosts"></a>

### 测试和部署的位置

1. **开发 Mac 不跑测试。** 用户的 MacBook 只用来编辑代码、审核和提交。构建、`npm test`、各组 Vitest 测试和产品路径资格都不在 Mac 上跑。`npm run check` 这类静态检查也放到 Hermes 上。
2. **测试在 Hermes 上跑。** 第 0–3 层和 Linux 产品路径验证，通过 SSH 在 Hermes 上运行。源码、依赖、构建产物、日志和测试安装都放在挂载的数据盘 `/data` 下、属于本任务的目录里。按这个决定在 Hermes 上跑测试不需要每次再问用户；需要 sudo 或改动 Hermes 上的服务时，仍按现有做法先给用户脚本、由用户执行。
3. **Mac 仍是支持的产品平台，Mac 专属验证按需进行。** Mac 系统沙箱、Mac 安装包、Mac 自带 Bash（[ADR 0037](0037-macos-bundled-bash.md)）这类 Mac 专属行为，在 Linux 上测不了。只有改动影响这些 Mac 专属部分、或者发布之前，才在 Mac 上跑 Mac 专属验证；每次都要先说明要跑什么、大约多久，得到用户同意，时间由用户决定。
4. **生产环境是云服务器 `84.247.157.41`。** 在这台服务器上的任何部署或改动都是生产操作，每次都要用户明确授权。登录方式没有记录时问用户，不自行探测。

<a id="layers"></a>

### 测试层级和触发条件

各层测试什么时候运行，沿用 ADR 0038；变化只在第 4、5 层和运行位置：

| 层级 | 内容 | 在哪里跑 | 什么时候运行 |
| --- | --- | --- | --- |
| 第 0 层：定向测试 | 能复现缺陷或验证新行为的测试，以及直接相关的测试文件 | Hermes | 改生产代码之前先运行，证明它失败；之后每次修改都运行同一测试 |
| 第 1 层：静态检查 | `npm run check`（格式、代码规范、类型、模块边界等） | Hermes | 每次提交之前 |
| 第 2 层：受影响模块测试 | 改动所在的整个测试组，以及引用了被改模块的集成测试文件 | Hermes | 一个缺陷或功能修稳定、准备提交时 |
| 第 3 层：完整测试 | 构建安装包，再运行完整 `npm test` | Hermes | 一批改动准备交付审核或验收时；推送、开 PR（合并请求）或合并之前；一轮工作结束时；以及[提前运行完整测试的情况](#early-full) |
| 第 4 层：真实产品路径 | 真实安装后，按用户操作走一遍产品场景 | Linux 版在 Hermes 上；Mac 版按上面第 3 条在 Mac 上 | 改动影响安装、升级、进程管理或沙箱运行时行为时，只运行相关场景；不加筛选的完整版本，只在一轮工作结束或发布之前运行 |
| 第 5 层：生产部署 | 部署到云服务器 `84.247.157.41` | 云服务器 | 每次部署都要用户明确授权 |

补充规则沿用 ADR 0038：

- **一批**指一起交付审核或验收的一组改动，通常不超过 3 个互相独立的缺陷。
- **先自查，再跑完整测试。** 启动第 3 层之前，先完成第 0–2 层、自查代码和相关文档。
- **完整测试失败时**，回到第 0 层复现并修复，通过第 0–2 层后，只对这一批的最终版本再跑一次第 3 层。
- **只改文档**时，只运行文档校验和 Runbook（操作手册）的封存检查，不运行产品测试。

<a id="early-full"></a>

### 提前运行完整测试的情况

沿用 ADR 0038。改动涉及下列公共部分时，这一次改动就要单独跑第 3 层，不等到一批结束：

- 产品数据库（SQLite）的表结构或迁移；
- Agent Service（负责对话和数据库的服务进程）与 Execution Worker（执行工具的进程）之间的通信协议、认证或握手；
- 构建和打包配置、依赖声明或锁文件；
- 测试运行方式本身，例如 Vitest 的配置、`scripts/ci/` 下的测试脚本或 `ci/policy.json`。

<a id="commits"></a>

### 提交与结果复用

沿用 ADR 0038：

- 每个独立缺陷单独提交，提交前必须通过第 0–2 层。提交说明和交付记录只能写实际跑过的层级和运行位置；中间提交没有单独跑过完整测试时，要写明完整测试覆盖的是哪个版本。
- 代码、依赖、测试配置和相关环境都没有变化时，已有的测试结果可以继续使用。在 Mac 上得到的结果不能当作 Linux 的结果，反之亦然。
- GitHub 上合并 PR 之前 CI（代码推送后在 GitHub 上自动运行的检查）必须通过的检查集合，仍由 `ci/policy.json` 规定。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

### 方案 A：只做 Linux，Mac 不再是目标平台

- 好处：最省事，只维护一个平台。
- 代价：以后想恢复 Mac 版，要重新验证 Mac 专属部分。

### 方案 B：保留 Mac，日常测试在 Hermes 上跑，Mac 专属验证经用户同意后按需在 Mac 上跑（采用）

- 好处：开发 Mac 平时不再被测试占满；Mac 版仍有验证证据。
- 代价：改到 Mac 专属部分或发布前，要安排一次用户同意的 Mac 验证。

### 方案 C：保留 Mac，但完全不在 Mac 上测

- 好处：Mac 永远不跑测试。
- 代价：Mac 专属行为以后没有验证证据，只能在报告和发布说明里写“Mac 未验证”。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 需要在 Hermes 上准备固定版本的 Node 和 npm、Linux 原生依赖和浏览器；下载新依赖仍要用户同意。
- 产品路径测试夹具 `test/fixtures/product-path-harness.ts` 现在用 `mkdtemp("/tmp/hma-pp-")` 把测试安装建在 `/tmp`，设置 `TMPDIR` 也改不了。在 Hermes 上跑产品路径之前，要先让它支持放在 `/data` 下的指定目录（见 `.ci-output/tool-execution-audit/2026-09-28/round2/linux-verification-handoff.md` 第 3 条）。
- Hermes 根盘空间紧张，所有测试数据都放 `/data`；清理规则沿用 `AGENTS.md` 的 “Disk Space Hygiene”。
- 在 Mac 上已经得到的历史测试结果仍然有效，但只代表 Mac。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- 被取代的测试时机决定：[SOURCE: docs/adr/0038-test-layer-trigger-timing.md]
- CI 必需检查与证据边界：[SOURCE: docs/architecture-v0.1.md#ci-政策与证据边界]
- Mac 自带 Bash：[SOURCE: docs/adr/0037-macos-bundled-bash.md]
- 进行中的工具执行排查：[SOURCE: docs/execution/plans/2026-09-28-tool-execution-audit-plan.md]
