---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-13"
covers: ""
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0055：沙箱里的 bash 可以使用系统自带命令

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

2026-10-13 opencode 第 19 批在 Hermes 产品路径上验证七个编码工具时发现：沙箱（用操作系统机制限制程序能访问的文件和网络的隔离环境）里的 `bash` 工具只能找到安装目录 `runtimeRoot/pi-tools/bin/` 里的 `bash`、`rg`、`fd` 三个程序。`ls`、`cat`、`wc`、`git`、`python3` 这类常用命令都找不到，测试只能改用 bash 内建命令。证据见 `.ci-output/handoff/2026-10-13-r2t1-oc-stop-19.md` 第 6.2 节。

原因是一条有意的设计：命令的查找路径（PATH，决定去哪些目录找命令）只设为这个固定目录，目的是让每个能运行的程序都计入 runtimeDigest（整个安装内容的摘要，用来核验安装没被改动）。这条规定写在[安装启停 Runbook](../runbooks/install-start-stop-runbook.md)、[架构文档](../architecture-v0.1.md)和 [SRT 统一执行设计](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/execution/specs/2026-09-07-srt-unified-execution-design.md)中。

用户的目标是把 Himawari 做成个人全能 Agent（长任务目标 G88）。Codex 和 Claude Code 在沙箱里执行命令时都使用系统自带的命令，沙箱只限制写入范围和联网。

Claude 给出三个选项：使用系统自带命令；只用安装包里的固定工具，逐个补齐常用程序；先保持现状。用户的决定（长任务目标 G92）：选“用系统自带命令（推荐）”。

<a id="decision"></a>

## 决定

1. **`bash` 工具执行的命令可以使用系统自带的程序。** 子命令的 PATH 依次为 `runtimeRoot/pi-tools/bin`、`/usr/local/bin`、`/usr/bin`、`/bin`。固定目录排在最前面，所以 `bash`、`rg`、`fd` 仍然使用安装包里核验过的那一份。
2. **Pi 工具本身使用的程序不变。** `bash` 工具的外壳程序、`grep` 用的 `rg`、`find` 用的 `fd`，仍然只从固定目录取得，启动前照旧检查它们是普通可执行文件、不是符号链接（指向别处的快捷文件），并计入 runtimeDigest。`PI_OFFLINE=1` 不变，不允许工具运行时自动下载。
3. **沙箱边界不变。** 系统程序在沙箱里运行：只能写授权工作目录和本次调用的私有临时目录，联网仍按 [ADR 0026](0026-job-scoped-network-egress.md) 由任务的联网授权决定，默认不能联网。授权与批准规则见 [ADR 0053](0053-workspace-auto-approval-like-codex.md)。
4. **系统程序不计入 runtimeDigest。** 它们随服务器系统升级而变化，Himawari 不核验它们的版本和摘要；主机资格（确认安装内容与批准版本一致）只覆盖安装目录。

<a id="options"></a>

## 比较过的方案

| 方案 | 好处 | 代价 | 结论 |
| --- | --- | --- | --- |
| 维持现状：只用固定目录 | 每个能运行的程序都经过摘要核验 | 常用命令都不能用，`bash` 工具几乎没有用处 | 不采用 |
| 只用安装包里的固定工具，逐个补齐 coreutils、git、python 等 | 保留“只运行核验过的程序” | 每个工具都要下载、核验摘要、跟进安全更新，第四次上线明显推迟，可用命令仍然有限 | 不采用 |
| 固定目录优先，其后使用系统自带命令 | 与 Codex、Claude Code 一致；常用命令立即可用；沙箱的写入和联网限制不变 | 系统程序不经 Himawari 核验，行为随系统升级变化 | 采用（G92） |

<a id="consequences"></a>

## 后果

- 好处：Himawari 可以在授权目录里执行 `ls`、`cat`、`git`、`python3` 等命令，完成整理文件、查看代码、运行脚本这类任务。
- 代价：命令结果依赖服务器上实际安装的系统程序；生产服务器（Ubuntu 24.04）和测试服务器 Hermes（Ubuntu 22.04）上的程序版本不同，测试结果不能代表生产的具体程序行为。
- 后续工作（长任务条目 R2-T3）：
  - 修改沙箱命令的 PATH，并在 Hermes 产品路径上验证 `ls`、`cat`、`git` 等系统命令能在沙箱里运行，写入范围外和联网仍被拒绝。
  - 同一提交更新安装启停 Runbook、架构文档和 SRT 统一执行设计里“仅使用固定目录作为 PATH”的描述，并重新封存受影响的 Runbook。
  - macOS 的行为未验证（用户 2026-09-30 暂停了所有 Mac 验证）。

<a id="references"></a>

## 关联文档

- [ADR 0026：按任务限定的联网](0026-job-scoped-network-egress.md)
- [ADR 0037：macOS 安装包自带 Bash](0037-macos-bundled-bash.md)
- [ADR 0053：授权工作目录内的操作默认不需要批准](0053-workspace-auto-approval-like-codex.md)
- [ADR 0054：只读文件工具在主进程执行，命令和写入复用任务沙箱](0054-readonly-tools-in-host-and-reused-task-sandbox.md)
- [安装启停 Runbook](../runbooks/install-start-stop-runbook.md)
