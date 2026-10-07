---
status: superseded
document_type: adr
decision_status: superseded
supersedes: ""
superseded_by: "docs/adr/0049-first-production-host-acceptance-exception.md"
date: "2026-10-01"
---

# ADR 0044：测试改在云服务器 84.247.157.41 上运行，不再使用 Hermes

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
  - [测试和部署的位置](#hosts)
  - [云服务器上的账号和目录](#storage)
  - [Ubuntu 24.04 的沙箱前提](#apparmor)
  - [测试层级和触发条件](#layers)
  - [提前运行完整测试的情况](#early-full)
  - [提交、推送与结果复用](#commits)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

[ADR 0043](0043-push-every-commit-full-test-before-merge.md) 规定第 0–3 层测试和 Linux 产品路径在 Hermes（局域网里的 Linux 服务器）上运行，开发 Mac 不跑测试，每个提交立即推送。

2026-10-01 用户告知 **Hermes 已经不能使用**，并决定**改在云服务器 `84.247.157.41` 上运行测试**。这台服务器也是 ADR 0043 定下的生产环境。用户通过 SSH 密钥给了临时 root 权限，没有提供密码。

同一天对这台服务器做了只读检查，结果如下：

| 项目 | 情况 |
| --- | --- |
| 系统 | Ubuntu 24.04.5 LTS，x86_64 |
| 处理器 / 内存 | 4 核，7.8 GiB 内存，没有交换空间 |
| 磁盘 | 一块 100 GB 固态盘，根目录约 94 GB 可用；不像 Hermes 那样分成机械数据盘和固态根盘 |
| 已运行的服务 | 只有系统自带服务和 SSH；没有安装过 Himawari |
| SSH 设置 | 允许 root 登录，允许密码登录 |

检查中还发现：Ubuntu 24.04 默认打开 `kernel.apparmor_restrict_unprivileged_userns`。这项设置让 AppArmor（Ubuntu 自带的安全模块）限制普通程序创建用户命名空间（Linux 让普通用户在隔离环境里运行程序的机制）。bubblewrap（Linux 上的沙箱程序 `bwrap`）因此无法以普通用户身份启动，测试用户运行时报错 `setting up uid map: Permission denied`。Hermes 是 Ubuntu 22.04，没有这项限制，所以之前没有出现这个问题。

<a id="decision"></a>

## 决定

用户在 2026-10-01 确认：

<a id="hosts"></a>

### 测试和部署的位置

1. **开发 Mac 不跑测试。** 沿用 ADR 0043：MacBook 只用来编辑代码、审核和提交。
2. **测试在云服务器 `84.247.157.41` 上跑。** 第 0–3 层和 Linux 产品路径验证，通过 SSH 以专用测试用户运行。按这个决定在这台服务器上跑测试，不需要每次再问用户。
3. **不再使用 Hermes。** 不在 Hermes 上运行测试，也不往 Hermes 写入数据。Hermes 上以前留下的证据仍是历史记录，本地 `.ci-output/` 中引用它们的报告不改。
4. **root 只用于系统准备。** 临时 root 只用来安装系统软件包、创建测试用户和目录。新的下载要先经用户同意。改动系统安全设置（例如 AppArmor）时，先给用户脚本，说明每一步的作用和撤销方法，由用户自己执行。
5. **生产部署仍要逐次授权。** 测试与将来的生产服务在同一台机器上。往这台服务器部署生产版本、启动或改动生产服务，仍然是生产操作，每次都要用户明确授权。测试不得读写生产目录（例如 `/opt/himawari`、`/etc/himawari`、`/var/lib/himawari`），不得使用生产服务的系统用户。
6. **Mac 定向验证仍无限期推迟。** 沿用 ADR 0043：在用户重新安排之前，Mac 上的行为写成“未在 Mac 上验证”。

<a id="storage"></a>

### 云服务器上的账号和目录

| 内容 | 放在哪里 |
| --- | --- |
| 运行测试的账号 | 普通用户 `himawari-test`，没有 sudo 权限，只能通过 SSH 密钥登录 |
| 源码检出、npm 依赖、固定工具链、浏览器、构建产物、日志、测试报告和保留的证据 | `/srv/himawari-test/<任务目录>/` 下，例如 `/srv/himawari-test/round2/` |
| 测试**运行中**产生的临时数据：SQLite 文件、socket、产品路径测试安装、测试进程的 `TMPDIR` | `/srv/himawari-test/scratch/` 下每次运行独占的 0700 目录，通过 `HIMAWARI_TEST_TEMP_ROOT` 指定 |

这台机器只有一块固态盘，所以 ADR 0042 和 ADR 0043 中“证据放机械盘、临时数据放固态根盘”的区分不再需要。下面几条空间规则继续执行：

1. **跑之前查空间。** 每次运行前用 `df` 检查根盘，可用空间低于 10 GiB 就不启动，写停止文件说明。
2. **记录峰值。** 记录临时目录的最大占用和根盘的最低可用空间，写进这次运行的证据。
3. **跑完就收走、删掉。** 需要保留的失败现场先复制到任务目录下的证据目录，再删除这次运行的临时目录。删除前按 `AGENTS.md` 的 “Disk Space Hygiene” 核对没有进程还在用它。
4. **只用测试用户自己的目录。** 不写其他用户或系统服务的目录。

<a id="apparmor"></a>

### Ubuntu 24.04 的沙箱前提

用户 2026-10-01 以 root 在服务器上执行了 Claude 准备的脚本，新增 `/etc/apparmor.d/bwrap`，内容如下，只允许 `/usr/bin/bwrap` 这一个程序创建用户命名空间：

```text
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
```

脚本随后用 `apparmor_parser -r /etc/apparmor.d/bwrap` 加载规则。全局开关 `kernel.apparmor_restrict_unprivileged_userns` 仍为 1，其他程序照旧受限制；以 `himawari-test` 身份运行 `bwrap --unshare-all` 成功。撤销方法是 root 执行 `apparmor_parser -R /etc/apparmor.d/bwrap` 后删除该文件。

这只说明 bwrap 能启动了，不等于产品沙箱在这台机器上已经验证通过；后者要靠实际测试。默认的 Ubuntu 24.04 上需要这项前提，也是产品安装时要面对的问题，后续工作记录在[对应的 Backlog](../backlog/BL-20261001-001-ubuntu-24-04-默-认-禁-止-bwrap.md)。

<a id="layers"></a>

### 测试层级和触发条件

沿用 ADR 0043，只把运行位置从 Hermes 换成云服务器：

| 层级 | 内容 | 在哪里跑 | 什么时候运行 |
| --- | --- | --- | --- |
| 第 0 层：定向测试 | 能复现缺陷或验证新行为的测试，以及直接相关的测试文件 | 云服务器 | 改生产代码之前先运行，证明它失败；之后每次修改都运行同一测试 |
| 第 1 层：静态检查 | `npm run check`（格式、代码规范、类型、模块边界等） | 云服务器 | 每次提交之前 |
| 第 2 层：受影响模块测试 | 改动所在的整个测试组，以及引用了被改模块的集成测试文件 | 云服务器 | 一个缺陷或功能修稳定、准备提交时 |
| 第 3 层：完整测试 | 构建安装包，再运行完整 `npm test` | 云服务器 | 一批改动准备交付审核或验收时；开 PR（合并请求）或合并之前；一轮工作结束时；以及[提前运行完整测试的情况](#early-full) |
| 第 4 层：真实产品路径 | 真实安装后，按用户操作走一遍产品场景 | Linux 版在云服务器上，装在测试用户自己的目录里；Mac 版推迟 | 改动影响安装、升级、进程管理或沙箱运行时行为时，只运行相关场景；不加筛选的完整版本，只在一轮工作结束或发布之前运行 |
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

- 沿用 ADR 0043：每个独立缺陷单独提交，提交前通过第 0–2 层；每个提交创建后立即推送；提交说明只写实际跑过的层级和运行位置。
- **Hermes 上的结果不能直接当作云服务器的结果。** 两台机器的系统版本（22.04 与 24.04）、处理器和内存、磁盘类型都不同。代码、依赖、测试配置都没变时，Hermes 上的通过结果仍可作为历史参考；但涉及计时、并发或沙箱的结论，要在云服务器上重新得到。Mac 与 Linux 的结果也不能互相代替。
- GitHub 上合并 PR 之前必须通过的 CI 检查，仍由 `ci/policy.json` 规定。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

### 方案 A：改在云服务器上跑测试（采用）

- 好处：用户手上现有、能用的 Linux 机器；系统是 Ubuntu 24.04，与将来的生产环境一致，能提前发现产品在新版 Ubuntu 上的问题，例如这次的 bwrap 限制。
- 代价：处理器和内存比 Hermes 少，没有交换空间，完整测试可能更慢；测试与将来的生产服务共用一台机器，要靠专用用户和目录隔开。

### 方案 B：等 Hermes 恢复

- 代价：恢复时间不确定，这一轮排查会一直停着；用户已经明确不采用。

### 方案 C：把云服务器重装成 Ubuntu 22.04 或 Debian 12，避开 bwrap 限制

- 好处：不用改 AppArmor 设置。
- 代价：Ubuntu 22.04 的标准支持到 2027 年 4 月结束，以后升级还会遇到同样的限制；换成 Debian 则没有机器验证产品在 Ubuntu 24.04 上的行为。重装还要重新配置访问。用户 2026-10-01 选择保留 Ubuntu 24.04，执行只针对 bwrap 的 AppArmor 规则。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- `AGENTS.md` 中的 “Test and Production Hosts”、“Test Trigger Timing” 和原 “Hermes Connectivity” 按本 ADR 改写。
- 正在进行的工具执行排查，要把运行记录脚本和路径从 Hermes 改到云服务器。旧的 Hermes 记录脚本不能直接使用。
- 默认的 Ubuntu 24.04 需要额外的 AppArmor 规则产品沙箱才能工作。生产部署和产品安装说明都要处理这一点，见[对应的 Backlog](../backlog/BL-20261001-001-ubuntu-24-04-默-认-禁-止-bwrap.md)。
- 测试和将来的生产服务共用机器。生产部署计划要另行确定生产服务用户和目录，并说明它们与 `himawari-test` 的隔离方式。
- 临时 root 权限和服务器的 SSH 设置（允许 root 登录、允许密码登录）由用户决定是否收回或收紧，本 ADR 不做改动。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- 被取代的决定：[SOURCE: docs/adr/0043-push-every-commit-full-test-before-merge.md]
- 更早的测试位置和测试时机决定，原先由 ADR 0043 取代，现在一并由本 ADR 取代（文档校验要求取代者必须有效，所以四者的 `superseded_by` 都指向本 ADR）：[SOURCE: docs/adr/0042-hermes-test-scratch-on-root-disk.md]、[SOURCE: docs/adr/0041-test-hosts-and-production-server.md]、[SOURCE: docs/adr/0038-test-layer-trigger-timing.md]
- Ubuntu 24.04 的 bwrap 限制：[SOURCE: docs/backlog/BL-20261001-001-ubuntu-24-04-默-认-禁-止-bwrap.md]
- 首次生产部署计划（目前暂缓）：[SOURCE: docs/execution/plans/2026-09-30-production-first-deployment-plan.md]
- 进行中的工具执行排查：[SOURCE: docs/execution/plans/2026-09-28-tool-execution-audit-plan.md]
