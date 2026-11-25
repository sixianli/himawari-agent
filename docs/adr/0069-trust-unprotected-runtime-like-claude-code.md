---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amended_by: "docs/adr/0078-authority-check-once-then-version-compare.md"
date: "2026-10-23"
covers: "apps/execution-worker/src/production-sandbox-execution-v2.ts, packages/platform-node/test/sandbox-host-verifier.unit.test.ts, packages/platform-node/test/sandbox-runtime-digest-worker.unit.test.ts, packages/runtime-sandbox/src/policy.ts, packages/runtime-sandbox/test/policy.unit.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0069：未保护安装信任安装结果，只靠沙箱禁止写入和受保护安装防改动

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联](#references)

<a id="context"></a>

## 背景

宿主核验（`verifySandboxHost`，每次沙箱工具调用前确认运行环境没变的检查）里有一部分专门确认“运行时”没被改过。运行时指安装目录里执行工具要用的程序文件，例如 Node（运行 JavaScript 的程序）、runner（在沙箱里替模型执行工具命令的小程序）和 SRT（Anthropic 开源的沙箱工具 sandbox-runtime），第六版安装约 3.3 万个文件。

这部分检查分两种情况：

- **受保护安装**（[ADR 0028](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0028-protected-runtime-installation.md)）：Linux 上程序文件归 root（系统管理员账号）所有，服务用另一个不能改这些文件的普通账号运行，root 发布 `protected-runtime.v1` 保护记录。每个进程只完整审计一次。
- **未保护安装**：Mac 上的安装（一直如此）、Hermes 测试安装，以及生产机做保护步骤之前（例如第六次变更的 S6 验收）。安装文件和服务属于同一个账号。[ADR 0034](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0034-runtime-verification-by-inode-metadata.md) 和 [ADR 0067](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0067-runtime-artifacts-by-inode-metadata.md) 规定：每个进程第一次读全部字节算摘要，之后每次调用都遍历整个目录比对每个文件的元数据（设备号、inode 编号、权限、所有者、大小、修改时间、状态变更时间）。

这一块反复耗费开发和使用时间：

- 2026-09-27 Mac 上一次读文件调用做了 8 次核验，合计约 57 秒，超过 60 秒工具期限（ADR 0034 的起因）。
- 第六次生产变更（R2-L13）的 S6 验收在生产机 `84.247.157.41` 上第二次失败（`R2_L6_ORIGINAL_START_TIMEOUT`）：一个任务启动前 6 轮宿主核验每轮 2.3–6.5 秒，合计 24.2 秒，准入阶段共 51.5 秒，探针最多等 60 秒。ADR 0067 去掉了每轮重读 Node 可执行文件之后，Hermes 演练里第一个任务仍有 8 轮、每轮 0.53–0.85 秒。

2026-10-23 核对了这项检查实际防的是什么：

- 沙箱里的工具改不了运行时。每条启动路径都把运行时目录放进只读工具链路径（`apps/execution-worker/src/production-sandbox-execution-v2.ts` 和 `production-sandbox-worker.ts` 里的 `readOnlyToolchainPaths`），沙箱策略（`packages/runtime-sandbox/src/policy.ts` 的 `compileSandboxPolicy`）拒绝工具链路径与工作区、私有目录相同或互相包含（`SRT_POLICY_TOOLCHAIN_OVERLAP`），可写目录只有工作区和私有目录。
- 未保护时，有能力改运行时文件的只有和服务同一个账号的其他程序；它们同样能改服务和 Worker（执行工具的后台进程）自己的代码，包括做核验的那段代码。所以每轮比对防不住有意的篡改，只能发现误改，例如升级只做了一半。DeepSeek 的独立方案（`.ci-output/handoff/2026-10-23-r2d25-host-verify-proposal-oc-stop.md`，“未确认前提、风险与限制”第 3 条）也独立指出：进程启动时的检查不是进程自身代码的信任来源，未保护时真正能防启动前篡改的是受保护安装。

同一天对照了其他编程代理工具的官方文档（只读了文档，没读源码；“没看到”表示读过的内容里没有，不等于证明没有）：

| 工具 | 隔离方式 | 每次调用前是否核验自己的安装文件 | 靠什么防止被改 |
| --- | --- | --- | --- |
| Claude Code（含 SRT） | macOS 用 Seatbelt（系统自带沙箱），Linux 用 bubblewrap（沙箱工具）加 seccomp（系统调用过滤） | 没看到，只检查 bwrap 版本和路径是否可执行 | 默认禁止写入；可写目录里的配置、钩子脚本、技能文件也禁止沙箱写 |
| Codex CLI | Seatbelt 和 bubblewrap | 没看到 | 根文件系统只读挂载，`.git`、`.codex` 重新挂成只读 |
| OpenHands | Docker 容器 | 没看到 | 信任容器镜像，只有挂进 `/workspace` 的目录可写 |
| Gemini CLI | Seatbelt、Docker、gVisor 等 | 没看到 | 写入限制在项目目录 |

来源：`https://code.claude.com/docs/en/sandboxing`、`https://github.com/anthropic-experimental/sandbox-runtime`、`https://raw.githubusercontent.com/openai/codex/main/codex-rs/linux-sandbox/README.md`、`https://docs.openhands.dev/openhands/usage/runtimes/docker`、`https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/sandbox.md`。

用户的决定：

- 用户原话，2026-10-23：“再改产品”。
- 用户原话，2026-10-23，在 Claude 列出上表之后：“按照 以上说的 Claude code 的方案来做”。
- 用户原话，2026-10-23，被问到“进程启动时完整算一次摘要”和“每次调用核对 node、runner 身份信息”这两个小检查保留还是去掉时：“全部去掉”。随后补充：“我想要的是：全部去掉：和 Claude Code 完全一致，只靠沙箱禁止写入和受保护安装。”

ADR 0067 取代了 ADR 0034 和 ADR 0028。文档校验只认一层取代关系，所以三份旧 ADR 的取代者都改记为本 ADR，ADR 0067 的 `supersedes` 字段清空；三份旧 ADR 的正文不变。

[返回目录](#contents)

<a id="decision"></a>

## 决定

1. **受保护安装不变。** ADR 0028 的规则和 ADR 0034、ADR 0067 沿用它的部分继续有效：程序归 root 所有，独立的运行账号不能拥有部署文件、不能提权；root 发布 `protected-runtime.v1` 记录，服务通过 `HIMAWARI_RUNTIME_PROTECTION_FILE` 选择它；每个进程按保护记录完整审计一次。
2. **未保护安装信任安装结果。** 宿主核验不再读取、计算摘要、遍历或比对运行时目录、Node 可执行文件和 runner 的内容或元数据，进程启动时也不算摘要。取代 ADR 0034 和 ADR 0067 对未保护安装的全部规定。
3. **保留不涉及文件内容的检查。** 每次调用仍核对绑定、资格、主机号、平台、计划字段和资源上限，并检查私有目录、工作区根目录、运行时根目录、只读工具链路径、可执行文件和 runner 的路径（运行时根目录只检查它本身，不遍历其中内容）：必须是绝对路径、规范路径、不是符号链接、不能被组或其他用户写、所有者是当前账号或 root；工作区根目录的设备号和 inode 编号必须与登记一致。
4. **防改动靠沙箱禁止写入。** 运行时目录始终作为只读工具链路径交给沙箱；沙箱策略拒绝它与工作区、私有目录相同或互相包含。这一条由带 `[R2-D25]` 标签的测试固定（`packages/runtime-sandbox/test/policy.unit.test.ts`）。
5. 摘要线程（`sandbox-runtime-digest-worker.ts`）只剩完整摘要一种用法，供受保护安装的首次审计和安装工具使用；元数据指纹模式删除。

[返回目录](#contents)

<a id="options"></a>

## 比较过的方案

### 只在 Worker 启动程序前遍历一次（方案甲）

Claude 方案（`.ci-output/handoff/2026-10-23-r2d25-host-verify-claude-proposal.md`）和 DeepSeek 独立方案都提出过：服务进程各轮只做结构检查，Worker 在真正启动程序前完整遍历一次。

- 好处：运行期间的误改在下一次启动程序前就能发现。
- 代价：每次任务启动仍要遍历 1–2 次，DeepSeek 推算生产准入阶段仍要约 32–40 秒；要改的调用点有十几处，测试也多；对有意篡改的防护和本决定相同。用户选了本决定。

### 保留启动时摘要和 node、runner 身份核对

- 好处：安装不完整或被改过时，服务直接起不来。
- 代价：Mac 上每次进程启动多约 5 秒；Claude Code 没有这类检查。用户选择全部去掉。

### 加快遍历本身（常驻线程、减少重复检查）

- 好处：不改变保证。
- 代价：只能快 1.5–2 倍，生产上仍有 6 轮，每轮 1.5–3 秒。

### 借助内核变更通知（FSEvents、inotify）

- 代价：Node 的 `fs.watch` 证明不了没有丢事件，漏检时没有任何信号。

[返回目录](#contents)

<a id="consequences"></a>

## 后果

- 好处：未保护安装（Mac、Hermes 测试安装、生产机保护步骤之前）上，宿主核验不再遍历约 3.3 万个文件，每次工具调用和每次进程启动都不再为它等待；代码和测试都变少。
- 限制：未保护安装里，同一账号的其他程序在沙箱外误改或篡改运行时文件，Himawari 不再发现，直到出现运行错误，包括把运行时子目录换成指向可写目录的符号链接（沙箱策略只比较运行时根目录、工作区和私有目录三者，不检查运行时内部的链接）；这与 Claude Code 等工具的做法一致。需要防篡改的部署必须用受保护安装。Himawari 自己在沙箱外的文件写入（主机侧发布）只写进授权的工作区根目录，工作区根目录与运行时目录互相包含的情况目前只有沙箱策略拒绝，主机侧发布没有单独的检查；这一点没有因本决定改变。
- 后续：本决定不改变工具协议、授权、审批、输出披露或停止条件。引用 ADR 0034、ADR 0067 的架构文档和 Runbook 改为引用本 ADR，Runbook 按新代码核对后重新封存。对应测试带 `[R2-D25]` 标签，在 `packages/platform-node/test/sandbox-host-verifier.unit.test.ts`、`packages/platform-node/test/sandbox-runtime-digest-worker.unit.test.ts` 和 `packages/runtime-sandbox/test/policy.unit.test.ts`；其中一个用例在运行时目录里放一个无权限的子目录，证明核验不递归进入运行时目录（以非 root 账号运行时有效）。

[返回目录](#contents)

<a id="references"></a>

## 关联

- [SOURCE: https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0067-runtime-artifacts-by-inode-metadata.md]
- [SOURCE: https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0034-runtime-verification-by-inode-metadata.md]
- [SOURCE: https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0028-protected-runtime-installation.md]
- [SOURCE: docs/architecture-v0.1.md]

<a id="multi-user-follow-up"></a>

## 2026-11-11 后续：多人使用

[ADR 0234](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0234-one-program-per-person-database-file.md) 取代 ADR 0083，多人使用时每人一个数据库文件、每人一个专属执行账号。[ADR 0083](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0083-isolated-instance-per-person-with-owner-entry.md) 记录的前提“使用者就是可信的主人”对 Andy 自己的那一份仍然成立；对其他受邀的人，沙箱不再只防误改，还要防一个人读到另一个人的数据，所以 [ADR 0234](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0234-one-program-per-person-database-file.md) 第 4 条补上了系统账号、目录权限和内存、CPU、磁盘的硬上限。本 ADR 的决定不变。
