---
status: active
document_type: adr
decision_status: accepted
supersedes: "docs/adr/0037-macos-bundled-bash.md"
superseded_by: ""
amends: "docs/adr/0018-sqlite-product-state-authority.md, docs/adr/0019-offline-authority-transfer.md, docs/adr/0025-pi-tools-and-managed-execution-lifecycles.md, docs/adr/0026-job-scoped-network-egress.md, docs/adr/0031-isolated-tool-execution.md, docs/adr/0032-original-directory-disk-and-sensitive-file-limits.md, docs/adr/0033-process-sandbox-default-and-optional-containers.md, docs/adr/0036-agent-worker-restart-as-a-pair.md, docs/adr/0054-readonly-tools-in-host-and-reused-task-sandbox.md, docs/adr/0055-bash-uses-system-commands-in-sandbox.md, docs/adr/0069-trust-unprotected-runtime-like-claude-code.md, docs/adr/0071-replaceable-web-search-and-fetch-providers.md, docs/adr/0072-linux-pid-namespace-sweep-counts-as-release-confirmed.md"
date: "2026-11-03"
---

# ADR 0156：Himawari 只在 Linux 上运行，不再支持 macOS

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [对既有 ADR 的处理](#amendments)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

Andy 在 2026-11-03 的云端线程里作出决定，原话是：“我这个项目以后都不会运行在 macOS 上，只会运行在 Linux 上。”

在此之前，多份仍然有效的文档把 macOS 写成和 Linux 同等受支持的运行平台：

- [PRD v0.2](../prd-v0.2.md) 的范围写着“Mac 与 Hermes Linux 两个同等受支持的生产平台”，并要求两个平台分别通过完整验收。
- [ADR 0018](0018-sqlite-product-state-authority.md) 要求同一套数据和数据库迁移规则“在 Mac 和 Hermes 运行”，并在两台机器之间做停机迁移。
- [ADR 0025](0025-pi-tools-and-managed-execution-lifecycles.md) 决定 6、[ADR 0031](0031-isolated-tool-execution.md) 和 [ADR 0033](0033-process-sandbox-default-and-optional-containers.md) 决定 1 为 macOS 规定了沙箱的停止方式：macOS 只能“尽力停止”，用 `setsid` 脱离进程组的后台程序可能在停止后继续运行。
- [ADR 0037](0037-macos-bundled-bash.md) 决定 macOS 安装包自带一份 Bash，因为 macOS 系统自带的 `/bin/bash` 带苹果平台签名，复制后运行会被系统终止。
- [ADR 0055](0055-bash-uses-system-commands-in-sandbox.md) 的后续工作里写着“macOS 的行为未验证”。

实际情况早已只剩 Linux：

- 生产运行在 Andy 租用的 Contabo 云服务器 `84.247.157.41` 上，系统是 Ubuntu 24.04（[生产服务器访问 Runbook](../runbooks/production-server-access-runbook.md)）。
- 测试只在 Hermes（Ubuntu 22.04）和云服务器的 `himawari-ci` 账号上跑；MacBook 不跑任何测试（[测试主机操作 Runbook](../runbooks/test-host-operations-runbook.md)）。
- Andy 在 2026-09-30 无限期推迟了所有 Mac 验证（[ADR 0043](0043-push-every-commit-full-test-before-merge.md#context)），此后 Mac 上的行为一律写成“未在 Mac 上验证”。

[产品愿景](../product-vision.md)对运行位置的要求是“自有优先、数据自持”：运行在 Andy 的自有设备或他租用并控制的服务器上，判定标准是主权在谁手里，而不是哪台机器、哪种系统。只支持 Linux 不违背这条原则。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **Himawari 的服务端只支持 Linux。** Agent Service（对话与调度服务）、Execution Worker（执行工具的后台服务）、Job Host（每次工具调用的监督进程）、admin CLI（管理命令行）和安装包，都只为 Linux 构建、安装、测试和验收。不再为 macOS 做以上任何一项，也不再把 macOS 列为生产平台或测试平台。
2. **以下不受影响，因为它们不是“Himawari 运行在 macOS 上”：**
   - Andy 的 MacBook 继续作为操作终端：编辑代码、审查、提交，以及通过 Remote Control（远程控制，让云端会话在 MacBook 上执行命令）生成上线包、执行上线和回滚。它依然不跑 Himawari 的测试和构建，这条规则不变。
   - 任何系统上的浏览器（包括 macOS 和 iPhone）都可以打开 Himawari 网页、接收网页推送。原生 macOS 客户端本来就不在 [PRD v0.2](../prd-v0.2.md) 的范围内，本决定不改变这一点。
   - Apple 提供的网络服务（例如 Apple 日历、iPhone 的推送通道）是外部服务，用不用它们与服务端跑在什么系统上无关。
3. **ADR 0037 被本 ADR 整份取代。** macOS 安装包不再需要，自带 Bash 的工作取消。Linux 上 `bash`、`rg`、`fd` 仍按[安装启停 Runbook](../runbooks/install-start-stop-runbook.md)的现行规定由安装者准备。
4. **既有 ADR 中只属于 macOS 的要求作废，其余继续有效**，已知的逐条见下文[对既有 ADR 的处理](#amendments)。表里没列到的仍有效 ADR，只要某条要求只在 macOS 上成立（Mac 安装、Mac 验收、Mac 沙箱、钥匙串、launchd 等），也随本 ADR 作废；把 Mac 当作操作终端的内容不受影响。
5. **代码里现有的 macOS 实现暂时保留，但不再维护。** 例如 `packages/platform-node/src/workspaces/mac-seatbelt-xpc-command-sandbox.ts`（Mac 的 Seatbelt 沙箱）、`packages/platform-node/src/workspaces/apple-container-command-provider.ts`（Apple container）、钥匙串密钥来源，以及各处按 `darwin` 分支的代码。删除它们会动到沙箱、安装和密钥读取这些核心部分，按 [Andy 定的长期规则](../../.claude/rules/owner-standing-rules.md)属于大改动，要先出方案和 Andy 讨论；这项工作记在 [BL-20261103-5c43td](../backlog/BL-20261103-5c43td-删除产品代码里的-macos-分支.md)。删除之前：
   - 新代码不得为 macOS 增加分支或特殊处理；
   - 不为 macOS 分支补测试、修缺陷或做验收；
   - 文档不再把这些分支描述为受支持的功能。
6. **历史记录不改写。** 已被取代的 ADR、已归档的文档、历史测试结果和证据里关于 Mac 的内容保持原样，它们记录的是当时的事实。现行文档（PRD、架构文档、README、仍有效的 Runbook、仍有效的 Spec 和 Plan、指令文件和仍未关闭的 Backlog）按本决定更新；篇幅很长、macOS 内容分散在历史段落里的 Runbook、Spec 和 Plan，在开头加一段运行平台说明，写明其中把 macOS 当作运行、测试或验收平台的要求、验收条款和未完成任务一律作废，描述过去结果或冻结代码的段落只作历史记录。

[↑ 返回阅读导航](#contents)

<a id="amendments"></a>

## 对既有 ADR 的处理

本 ADR 整份取代 ADR 0037，只部分修正下表中的其他 ADR；这些 ADR 中与 macOS 无关的决定继续有效。表里没列到的 ADR 按[决定](#decision)第 4 条处理。

| ADR | 作废的 macOS 部分 | 继续有效的部分 |
| --- | --- | --- |
| [ADR 0018](0018-sqlite-product-state-authority.md) | 在 Mac 和 Hermes 两种系统上运行同一套数据，以及 Mac 与 Hermes 之间的停机迁移 | SQLite 是唯一权威数据库；单写者、迁移只在服务停止后导出；迁移在两台 Linux 主机之间进行 |
| [ADR 0019](0019-offline-authority-transfer.md) 背景与验证 | “同一个 Agent 必须能够在 Mac 或 Hermes 运行”、Mac→Hermes 和 Hermes→Mac 双向验证、macOS Keychain 机器秘密 | 停机加密导出/导入迁移、单一权威、机器秘密不进迁移包；迁移在两台 Linux 主机之间进行 |
| [ADR 0025](0025-pi-tools-and-managed-execution-lifecycles.md) 决定 6 | Mac 的“尽力停止”和脱离进程组的后代可能存活的披露要求 | 每个平台分别证明文件、网络限制、停止和清理；未知不能改成已确认 |
| [ADR 0026](0026-job-scoped-network-egress.md) | “Mac 清理限制”和 Mac 脱离后代的文件权限等 Mac 专属说法 | 可信出口、地址核查和停止时关闭连接的原则 |
| [ADR 0031](0031-isolated-tool-execution.md) | macOS 新执行方式必须有任务级停止证明的要求 | 工具不在 Agent 主进程里运行；严格模式下的停止证明要求 |
| [ADR 0032](0032-original-directory-disk-and-sensitive-file-limits.md) | 关于 macOS 的平台说明（例如 APFS 不能给任意目录设额度） | 原目录模式的磁盘与敏感文件限制在 Linux 上的规定 |
| [ADR 0033](0033-process-sandbox-default-and-optional-containers.md) 决定 1 及背景 | “macOS 和 Linux 都默认使用 SRT 模式”中的 macOS，以及“分发给 macOS 用户”这一背景 | Linux 默认用 SRT 模式（SRT 是 `@anthropic-ai/sandbox-runtime`，在宿主上限制单个进程能访问哪些文件和网络的沙箱），容器是可选的严格模式 |
| [ADR 0036](0036-agent-worker-restart-as-a-pair.md) 后果 | “实现 Mac 的 launchd 配置时按本决定配置成对重启”这项后续工作取消 | Agent Service 和 Execution Worker 必须成对重启；生产启动器在任一进程退出时自动成对重启（[安装启停 Runbook](../runbooks/install-start-stop-runbook.md)） |
| [ADR 0054](0054-readonly-tools-in-host-and-reused-task-sandbox.md) | “Mac 上 read、ls、find、grep 继续进沙箱”和“Mac 每次调用新建沙箱” | 只读文件工具在主进程执行，命令和写入复用同一轮的任务沙箱 |
| [ADR 0055](0055-bash-uses-system-commands-in-sandbox.md) 后续工作 | “macOS 的行为未验证”这一条不再需要处理 | 沙箱里的 `bash` 可以使用系统自带命令，PATH 顺序不变 |
| [ADR 0069](0069-trust-unprotected-runtime-like-claude-code.md) | 把“Mac 上的安装”列为一种未保护安装 | 未保护安装像 Claude Code 一样信任运行时；Hermes 测试安装和生产保护步骤之前的规定 |
| [ADR 0071](0071-replaceable-web-search-and-fetch-providers.md) | 主机密钥“Mac 放在钥匙串” | Linux 上主机密钥放在 `<stateRoot>/secrets/` 的规定 |
| [ADR 0072](0072-linux-pid-namespace-sweep-counts-as-release-confirmed.md) | “Mac 上的提示不变”等 Mac 专属展示口径 | Linux 上扫过整个 PID 命名空间的释放显示为“已释放” |

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

| 方案 | 好处 | 代价 | 结论 |
| --- | --- | --- | --- |
| 维持现状：macOS 和 Linux 都是支持的平台 | 将来想在 Mac 上直接运行时不用重新设计 | 每项沙箱、安装和停止规则都要写两套；macOS 的停止证明做不到，只能如实披露；要处理 Bash 的 GPLv3 分发和苹果公证；Mac 验证已无限期推迟，“支持”名不副实 | 不采用 |
| 只支持 Linux，同时立刻删除全部 macOS 代码 | 代码和文档一次对齐 | 删除动到沙箱、安装、密钥读取等核心部分，属于大改动，需要先出方案并经 Andy 同意；和文档改动混在一个提交里难以审查 | 不采用；删除作为单独的后续工作 |
| 只支持 Linux；文档立即改，macOS 代码冻结并另行删除 | 决定马上生效，后续开发不再为 macOS 付出成本；代码删除可以按方案审查 | 在删除之前，代码里还留着不再支持的分支 | 采用 |

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处：沙箱、停止证明、套接字路径长度预算（只需按 Linux 的 107 字节路径上限核算，`privateRoot` 由此最多 27 字节，不再另算 Mac 的 103 字节上限）、安装和测试都只需按一个系统设计和验证。“一个平台的结果不能代替另一个平台”的规则里不再有 Mac 这一项。
- 好处：不再需要分发 GPLv3 许可的 Bash、处理苹果签名和公证。
- 代价：Himawari 不能直接在 Mac 上运行。想在 Mac 上用，只能连到一台 Linux 服务器，或在 Mac 上跑一台 Linux 虚拟机。
- 代价：删除 macOS 代码之前，代码库里还留着不再支持的分支；它们可能让读代码的人误以为 macOS 仍受支持，所以文档要写明冻结状态。
- 后续：
  - [BL-20261103-5c43td](../backlog/BL-20261103-5c43td-删除产品代码里的-macos-分支.md)：出方案后删除产品代码里的 macOS 分支，同时删掉 CI 配置里的 macOS 构建和测试矩阵（`.github/workflows/ci.yml`、`ci/policy.json`、`scripts/ci/`，Andy 2026-11-03 决定）。删除之前 GitHub Actions 处于关闭状态（[ADR 0092](0092-pause-github-actions.md)），这些 macOS 任务不会运行；重新打开 Actions 之前必须先删掉。
  - 关闭只为 macOS 存在的 Backlog 条目：macOS 安装包自带 Bash（BL-20260929-003）、Mac 主机名变化后旧锁阻止自动恢复（BL-20260929-002）。
  - 同一 PR 更新 PRD v0.2、架构文档、README、仍有效的 Runbook、Spec、Plan 和测试主机指令中把 macOS 当作运行平台的内容。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- 被取代：[SOURCE: docs/adr/0037-macos-bundled-bash.md]
- 被部分修正：[SOURCE: docs/adr/0018-sqlite-product-state-authority.md]、[SOURCE: docs/adr/0026-job-scoped-network-egress.md]、[SOURCE: docs/adr/0032-original-directory-disk-and-sensitive-file-limits.md]、[SOURCE: docs/adr/0054-readonly-tools-in-host-and-reused-task-sandbox.md]、[SOURCE: docs/adr/0069-trust-unprotected-runtime-like-claude-code.md]、[SOURCE: docs/adr/0071-replaceable-web-search-and-fetch-providers.md]、[SOURCE: docs/adr/0072-linux-pid-namespace-sweep-counts-as-release-confirmed.md]、[SOURCE: docs/adr/0019-offline-authority-transfer.md]、[SOURCE: docs/adr/0036-agent-worker-restart-as-a-pair.md]、[SOURCE: docs/adr/0025-pi-tools-and-managed-execution-lifecycles.md]、[SOURCE: docs/adr/0031-isolated-tool-execution.md]、[SOURCE: docs/adr/0033-process-sandbox-default-and-optional-containers.md]、[SOURCE: docs/adr/0055-bash-uses-system-commands-in-sandbox.md]
- Mac 验证无限期推迟：[SOURCE: docs/adr/0043-push-every-commit-full-test-before-merge.md]
- 产品范围：[SOURCE: docs/prd-v0.2.md]
- 运行位置原则：[SOURCE: docs/product-vision.md]
- 后续工作：[SOURCE: docs/backlog/BL-20261103-5c43td-删除产品代码里的-macos-分支.md]
