---
status: superseded
document_type: adr
decision_status: superseded
supersedes: ""
superseded_by: "docs/adr/0047-test-checkout-on-hermes-nvme.md"
date: "2026-10-02"
---

# ADR 0045：云服务器测试的临时目录改为 `/tmp` 下的短路径

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

[ADR 0044](0044-tests-on-cloud-server.md) 按用户 2026-10-01 的决定，把测试从 Hermes 移到云服务器 `84.247.157.41`，并规定测试运行中的临时数据放在 `/srv/himawari-test/scratch/` 下每次运行独占的目录里。

2026-10-02 在云服务器上运行产品路径测试时发现，这个目录太长：

- 产品路径测试夹具 `test/fixtures/product-path-harness.ts` 在安装产品之前，先核算安装后会出现的每个 Unix 套接字的路径长度，超出上限就拒绝运行。架构文档把这项核算写成正式设计。
- 用 35 字节的 `/srv/himawari-test/scratch/<8 位十六进制>` 作临时根时，沙箱运行时 SRT 的网络桥套接字路径要 130 字节，超过 Linux 的 107 字节上限，正向用例 `creates the installation directory under the explicit short root` 实际失败。
- 只缩短测试里的目录前缀解决不了：即使去掉安装目录这一层，下限仍是 115 字节。

问题出在 ADR 0044 选的目录，而不是产品或测试：定规则时没有核算套接字长度。Hermes 上用的是 `/tmp/h…` 这样的短路径，所以以前没有出现。本 ADR 只改临时目录这一条，ADR 0044 的其余规则原样保留在下面。

<a id="decision"></a>

## 决定

ADR 0044 中用户 2026-10-01 确认的规则继续有效，只有[云服务器上的账号和目录](#storage)中测试临时数据的位置由 Claude 在 2026-10-02 改为 `/tmp` 下的短路径。完整规则如下：

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
| 测试**运行中**产生的临时数据：SQLite 文件、socket、产品路径测试安装、测试进程的 `TMPDIR` | 每次运行由 `himawari-test` 用 `mktemp -d /tmp/hXXXX`（系统命令，按模板新建一个名字末尾随机的目录）新建的独占目录（共 10 字节，例如 `/tmp/hAb3x`），权限 0700；同时设为 `HIMAWARI_TEST_TEMP_ROOT` 和 `TMPDIR` |

临时目录必须短，原因是 Unix 套接字（同一台机器上进程之间通信用的特殊文件）的完整路径有长度上限：Linux 最多 107 字节，产品自己的控制套接字还限定不超过 100 字节。产品路径测试会在临时目录下装一套产品，沙箱运行时 SRT（Anthropic 的 `@anthropic-ai/sandbox-runtime`，负责隔离网络）在其中的任务目录里建 `claude-socks-<16 位十六进制>.sock`，这条路径比临时根多 95 字节，所以临时根最多 12 字节。ADR 0044 原定的 `/srv/himawari-test/scratch/<8 位十六进制>` 有 35 字节，算下来是 130 字节，测试夹具在安装前就会拒绝运行。`/tmp/hXXXX` 是 10 字节，对应 105 字节。

`/tmp` 在这台机器上和 `/srv` 是同一块固态盘的同一个 ext4 分区（2026-10-02 用 `findmnt -T /tmp` 核对），不是内存盘，所以改到 `/tmp` 不改变磁盘和内存的占用。系统的 `systemd-tmpfiles` 只清理 30 天以上的条目，不影响正在运行的测试。

这台机器只有一块固态盘，所以 ADR 0042 和 ADR 0043 中“证据放机械盘、临时数据放固态根盘”的区分不再需要。下面几条空间规则继续执行：

1. **跑之前查空间。** 每次运行前用 `df` 检查根盘，可用空间低于 10 GiB 就不启动，写停止文件说明。
2. **记录峰值。** 记录临时目录的最大占用和根盘的最低可用空间，写进这次运行的证据。
3. **跑完就收走、删掉。** 需要保留的失败现场先复制到任务目录下的证据目录，再删除这次运行的临时目录。删除前按 `AGENTS.md` 的 “Disk Space Hygiene” 核对没有进程还在用它。
4. **只用测试用户自己的目录。** 不写其他用户或系统服务的目录。`/tmp` 是公共目录，只能删除本次运行自己创建的 `/tmp/h*` 目录，不碰 `/tmp` 下的其他内容。
5. **创建后先核对。** 核对临时根的属主是 `himawari-test`、权限是 0700、`realpath`（求出目录真实位置的命令）的结果与原路径相同，即没有经过符号链接（指向别处的快捷方式），并把路径和字节数写进运行记录。

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

之后又按用户同意安装了 bwrap 0.11.2 及其专用 AppArmor 规则，记录在[对应的 Backlog](../backlog/BL-20261001-001-ubuntu-24-04-默-认-禁-止-bwrap.md)。这只说明 bwrap 能启动了，不等于产品沙箱在这台机器上已经验证通过；后者要靠实际测试。默认的 Ubuntu 24.04 上需要这项前提，也是产品安装时要面对的问题，后续工作记录在[对应的 Backlog](../backlog/BL-20261001-001-ubuntu-24-04-默-认-禁-止-bwrap.md)。

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

### 方案 A：每次运行在 `/tmp` 下用 `mktemp -d /tmp/hXXXX` 建 10 字节的目录（采用）

- 好处：不需要 root，测试用户自己就能创建；路径足够短，SRT 套接字为 105 字节；`/tmp` 与 `/srv` 在同一分区，空间和性能都不变；与 Hermes 时期的做法一致。
- 代价：`/tmp` 是所有用户共用的目录，要靠 0700 权限、属主核对和“只删本次创建的目录”来隔离；临时数据不再和任务目录放在一起，记录脚本要写明路径。

### 方案 B：由 root 新建 `/srv/h/` 交给测试用户，每次在下面建 `/srv/h/XXXX`

- 好处：临时数据仍在 `/srv` 下。
- 代价：要用 root 改系统目录；`/srv/h/XXXX` 为 11 字节，与方案 A 相比没有实际好处。

### 方案 C：缩短产品的套接字名称或放宽夹具的长度核算

- 不采用：会改变产品行为，或者让测试不再能提前发现超长路径，只是为了迁就测试目录。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- `AGENTS.md` 的 “Test and Production Hosts” 改为本 ADR 的临时目录规则，并把引用从 ADR 0044 改为本 ADR。
- 工具执行排查使用的运行记录脚本改为创建 `/tmp/hXXXX`，并在运行记录里写明临时根和它的字节数。
- 测试夹具中各临时目录前缀按 10 字节的临时根重新核算；超过上限的另行修正。
- 同样的长度限制也约束生产安装：产品把每个任务的 `TMPDIR` 设为 `privateRoot/<44 字节的任务编号>`，SRT 在其中建套接字，所以 Linux 生产配置中的 `privateRoot` 不能超过 27 字节，而产品目前不在启动时检查这一点。后续工作见[对应的 Backlog](../backlog/BL-20261002-002-生-产-privateroot-超-过-27-字-节.md)。
- ADR 0044 的其他后果（AppArmor 前提、测试与生产共用机器、root 和 SSH 设置由用户决定）继续有效。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- 被取代的决定：[SOURCE: docs/adr/0044-tests-on-cloud-server.md]
- 更早的测试位置和测试时机决定，原先由 ADR 0044 取代，现在一并由本 ADR 取代（文档校验要求取代者必须有效，所以它们的 `superseded_by` 都指向本 ADR）：[SOURCE: docs/adr/0043-push-every-commit-full-test-before-merge.md]、[SOURCE: docs/adr/0042-hermes-test-scratch-on-root-disk.md]、[SOURCE: docs/adr/0041-test-hosts-and-production-server.md]、[SOURCE: docs/adr/0038-test-layer-trigger-timing.md]
- Ubuntu 24.04 的 bwrap 限制：[SOURCE: docs/backlog/BL-20261001-001-ubuntu-24-04-默-认-禁-止-bwrap.md]
- 生产 `privateRoot` 的长度上限：[SOURCE: docs/backlog/BL-20261002-002-生-产-privateroot-超-过-27-字-节.md]
- 首次生产部署计划（目前暂缓）：[SOURCE: docs/execution/plans/2026-09-30-production-first-deployment-plan.md]
- 进行中的工具执行排查：[SOURCE: docs/execution/plans/2026-09-28-tool-execution-audit-plan.md]
