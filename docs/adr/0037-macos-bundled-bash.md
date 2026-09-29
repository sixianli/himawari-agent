---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-09-29"
---

# ADR 0037：macOS 安装包自带 Pi 工具使用的 Bash

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

模型的 `bash` 工具由 Pi（Himawari 所基于的编程 Agent 框架）执行。运行时只从安装目录里的固定工具目录 `runtimeRoot/pi-tools/bin/` 查找程序，不使用用户系统的 PATH（程序查找路径）。[安装启停 Runbook](../runbooks/install-start-stop-runbook.md) 目前规定：安装的人要在计算 runtimeDigest（整个安装内容的摘要，用来核验安装没被改动）和主机资格之前，自己在这个目录里放好一个能实际运行的 Bash。主机资格是指确认这台机器上的安装内容和已批准的版本一致，核验通过后才允许执行工具。

在 macOS 上，这一步不能直接复制系统自带的 `/bin/bash`：它带有苹果的平台签名，复制到别处后运行会被系统直接终止（实测退出码 137）。2026-09-28 的工具执行排查中，测试用的办法是复制一份系统 Bash，再给副本重新做一个本机签名（ad-hoc 签名，不经过苹果认证、只在本机有效）。这个办法能运行，但只是测试时的临时办法。

Himawari 要分发给其他用户使用（见 [ADR 0033](0033-process-sandbox-default-and-optional-containers.md) 的背景）。如果每个 macOS 用户都要自己准备 Bash，漏做或做错时 `bash` 工具会直接不可用。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **macOS 的安装包自带一份 Bash**，安装后位于 `runtimeRoot/pi-tools/bin/bash`。安装过程不依赖、也不复制用户系统里的 Bash。
2. 这份 Bash 和安装包里的其他文件一样，计入 runtimeDigest 并参与主机资格核验。所以同一版本的安装包在每台 Mac 上运行的是字节完全相同的 Bash。
3. 分发时遵守 Bash 的 GPLv3 许可证（GNU 通用公共许可证第 3 版，要求分发程序的人同时提供对应源码）：安装包附带许可证原文，并提供对应版本的源码或获取源码的明确方式。
4. 以下细节**尚未决定**，实现前要先写 Spec，并由用户确认：Bash 的来源（使用已有的编译产物，还是从 GNU 官方源码自行编译）、版本、签名方式（仅 ad-hoc 签名，还是用开发者证书签名并经苹果公证；公证是把程序交给苹果做自动安全检查，通过后其他用户的 Mac 才会直接放行从网上下载的程序）、以及安全更新如何跟进。获取 Bash 需要下载，下载前要得到用户同意。
5. Linux 不在本决定范围内，仍按现行 Runbook 由安装者准备。

用户在 2026-09-29 确认采用本决定。在实现完成之前，安装启停 Runbook 中“由安装者准备 Bash”的现行规定仍然有效。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

### 方案 A：维持现状，由安装的人按 Runbook 自己准备

- 好处：不改安装流程，也不引入新的外部依赖。
- 代价：每次在 Mac 上安装都要记得这一步；普通用户很难自己做对，做错时 `bash` 工具直接失败。

### 方案 B：安装程序自动复制系统 Bash 并做 ad-hoc 签名

- 好处：不用下载任何东西，和测试中的做法一致。
- 代价：依赖 macOS 以后继续允许这种做法；不同 macOS 版本的系统 Bash 不同，安装内容因机器而异；还要改安装程序。

### 方案 C：安装包自带一份 Bash（采用）

- 好处：不依赖用户系统，每台机器的 Bash 完全一致，安装后即可使用。
- 代价：需要下载或编译 Bash，并负责它的版本和安全更新；安装包略微变大；要履行 GPLv3 的分发义务；可能需要处理签名与苹果公证。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处：macOS 用户安装后不需要额外步骤，`bash` 工具就能使用。
- 代价：Himawari 要自己维护这份 Bash 的来源、版本、许可证文件和安全更新。
- 后续：实现工作记录在 [BL-20260929-003](../backlog/BL-20260929-003-macos-安-装-包-自-带-pi-工.md)。实现落地时，同一次修改要更新安装启停 Runbook 的相关规定，并重新封存该 Runbook。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- 现行安装规定：[SOURCE: docs/runbooks/install-start-stop-runbook.md]
- 受保护的运行时安装：[SOURCE: docs/adr/0028-protected-runtime-installation.md]
- 分发背景与默认执行方式：[SOURCE: docs/adr/0033-process-sandbox-default-and-optional-containers.md]
- 实现待办：[SOURCE: docs/backlog/BL-20260929-003-macos-安-装-包-自-带-pi-工.md]
