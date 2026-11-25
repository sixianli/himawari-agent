---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-27"
covers: "apps/agent-service/src/production-coding-workflow.ts, apps/agent-service/src/production-run-policy.ts, apps/agent-service/src/production-workspace-ledger.ts, apps/agent-service/src/workspace-auto-authorization.ts, apps/agent-service/test/production-coding-workflow.unit.test.ts, apps/agent-service/test/production-workspace-ledger.unit.test.ts, packages/application/src/services/workspace-changes.ts, packages/application/test/workspace-changes.unit.test.ts, packages/execution-contracts/src/protected-directory-names.ts, packages/platform-node/src/files/host-read-only.ts, packages/platform-node/test/host-read-only.unit.test.ts, scripts/delivery-mode/packet-template/signing/cloud-seal.mjs, test/integration/product-path-browser.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0097：命令可以写工作目录，每条命令的文件改动都留档

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [业界做法](#industry)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

2026-10-27，Andy 在 Himawari 网页（他日常聊天用的网页，代码在 `apps/control-center`）里让 Himawari 写一个贪吃蛇小游戏。模型用 `bash`（在沙箱里执行命令的工具）把文件写进工作目录（交给 Himawari 使用的目录，生产上是 `/var/lib/himawari/workspace`）时失败，报 `Read-only file system`（只读文件系统）。

查下来，命令能不能写工作目录，由部署时封存的能力配置决定：`scripts/delivery-mode/packet-template/signing/cloud-seal.mjs` 给 `bash` 只封了 `["read"]`，沙箱据此把工作目录挂成只读。这和 [ADR 0053](0053-workspace-auto-approval-like-codex.md) 的本意不一致：ADR 0053 参照 Codex 的 `Auto` 模式，决定授权工作目录内读文件、改文件、执行命令都默认允许。

Andy 问：工作目录就是给 Agent 用的，Agent 应该能在里面做任何想做的事，对吗？Claude 给出 B 方案：命令可以写工作目录，但每条命令前后对比工作目录，把改了哪些文件记下来；受保护的文件和文件夹仍然不能读也不能写。

用户原话，2026-10-27：我同意方案 B。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **命令可以写工作目录。** 部署封存配置给 `bash` 的目录操作改为 `["read", "create", "update"]`（读、新建、修改），和 `write` 一致；`workspace-auto-authorization.ts` 的自动授权、`production-coding-workflow.ts` 里执行前的权限检查同步改。工作目录以外仍然只读，越界写入照旧失败。没有单独的删除权限：沙箱里目录一旦可写，删除在物理上就做得到，所以删除不另设开关，而是靠第 3 条留档。
2. **受保护的条目不变。** `.git`、`.env`、`.ssh`、`.himawari-recovery`、`.himawari-trash`、`*.pem`、`*.key` 等（完整清单在 `packages/execution-contracts/src/protected-directory-names.ts`）仍然在沙箱里不能读也不能写。
3. **每条命令留一份改动记录。** 只对“直接在授权工作目录里执行、不是在工作目录副本里执行”的 `bash` 调用做：
   - 执行前，Himawari 主进程（`agent-service`，不是沙箱）沿着工作目录走一遍，记下每个条目的路径、类型、大小、修改时间和 inode（文件在磁盘上的编号）。走目录用文件描述符逐级打开、不跟随符号链接、不跨设备，跳过受保护条目和 `.git`。实现在 `packages/platform-node/src/files/host-read-only.ts` 的 `snapshotWorkspace`。
   - 执行后再走一遍，对比两次结果，得出新建、修改、删除的条目（`packages/application/src/services/workspace-changes.ts`）。只对新建和修改的文件计算 SHA-256 指纹（文件内容的摘要），单个文件超过 32 MiB 或读不到时指纹记为空。
   - 记录写进这次运行的持久记录（`run_payload_artifacts`），内容包括运行、工具调用、对话、目录授权、命令原文、两次扫描耗时、是否扫描完整、每个改动条目前后的大小和时间。中途崩溃恢复时直接复用已经保存的执行前快照和改动记录，不重复扫描。
   - 一句中文摘要附在命令结果末尾给模型看，例如“工作目录改动：新建 a；修改 b；删除 c”。
   - 执行前快照拍不出来（例如目录身份变了），命令不执行，返回 `WORKSPACE_LEDGER_UNAVAILABLE`。命令执行后对比失败，命令结果照常返回，记录里写明失败原因，摘要写“这次没能记录”。
   - 单次扫描超过 0.2 秒或条目超过 50,000 个时，在服务日志里写一条 `workspace.ledger.scan` 警告；超过上限的部分不再对比，摘要里注明只对比了前一部分。
4. **告诉模型规则。** 每轮的能力说明（`production-run-policy.ts`）写明：命令可以新建、修改、删除工作目录里的文件，改动会被对比和留档，临时文件放到 `$TMPDIR`，受保护条目不能读也不能写。
5. **暂不做的部分。** 改动记录只记“改了什么”和内容指纹，不保存文件内容副本，所以还不能一键恢复被命令改坏或删掉的文件。保存副本、把命令产出的文件放进对话里的文件卡片，归到“产出文件交付”这个专题一起设计（登记表、副本、版本、文件库页面）。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

| 方案 | 好处 | 代价 | 结论 |
| --- | --- | --- | --- |
| A：维持命令只读，只让 `write`、`edit` 写文件 | 所有写入都经过带版本检查的文件工具 | 模型不能用命令生成、移动、解压文件，常见开发任务做不成；和 ADR 0053 的本意矛盾 | 不采用 |
| B：命令可写工作目录，每条命令前后对比并留档 | 符合 ADR 0053 和 Codex `Auto`；事后能查到每条命令改了哪些文件 | 每条命令多两次目录扫描；同一时间并发的命令可能互相记到对方的改动 | 采用 |
| C：命令可写，但每条命令先在副本或覆盖层里跑，确认后再合并 | 可以整体撤销 | 要引入覆盖文件系统或复制整个目录，改动大、慢；合并冲突要另设计 | 暂不采用，工作目录变大后再评估 |
| D：命令可写，不留档 | 最简单 | 出了问题不知道哪条命令改了什么 | 不采用 |

扫描成本是在 Andy 的 Mac 上实测估算的：11.7 万个文件扫一遍约 2.4 秒，约每个文件 20 微秒；对 200 个文件（4.9 MB）算指纹约 65 毫秒。生产工作目录当前只有 37 个文件、720 KB（2026-10-27 只读登录生产机查看），扫描时间可以忽略。

[↑ 返回阅读导航](#contents)

<a id="industry"></a>

## 业界做法

- Codex 的 `workspace-write` 沙箱模式允许在工作目录内读写文件和执行命令，工作目录外的写入和联网才需要询问。[Codex 审批与安全文档](https://learn.chatgpt.com/docs/agent-approvals-security)
- Claude Code 的检查点（checkpoint，可以回退的存档点）只跟踪它自己的文件编辑工具做的修改；官方文档写明，只被 Bash 命令改过的文件不跟踪，要回退得用 Git 等版本控制。[Claude Code 检查点文档](https://code.claude.com/docs/en/checkpointing)

对比：Himawari 和 Codex 一样让命令写工作目录；比 Claude Code 多做了一步，命令改过的文件也能查到。但 Himawari 目前和 Claude Code 一样，不能自动恢复命令改动的内容，见[决定](#decision)第 5 条。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处：模型可以用命令直接在工作目录里生成和整理文件；每条命令改了哪些文件，模型马上看得到，事后也查得到。
- 代价：每条命令前后各扫描一次工作目录。工作目录很大（例如装了 `node_modules` 这类依赖目录）时会变慢，靠 0.2 秒警告发现；需要时再改成跳过依赖目录或用覆盖层。
- 已知不准确的地方：改动记录是“这条命令执行期间工作目录发生的变化”。如果同一个工作目录里同时有别的命令在跑，或者命令在等待批准期间目录被别的操作改了，改动会被记到这条命令上。
- 低层的失败提示（`production-sandbox-tool-result.ts` 里“Himawari 没有核验这条命令是否改动了工作区”）保留不变：它在不留档的场景（工作目录副本、非 Linux 主机）仍然成立；留档时摘要附在其后，以摘要为准。
- 生效时间：部署封存配置在下一次上线时重新生成，Andy 用 `deploy.sh` 上线后生效。
- 测试：
  - `test/integration/product-path-browser.test.ts` 的 `[R2-T5]`：命令写工作目录成功，写工作目录外、`/tmp`、家目录仍失败，回答里带“工作目录改动：新建 … r2t5-workspace.txt”。
  - `packages/platform-node/test/host-read-only.unit.test.ts` 的 `[BW-2]`：快照不跟随符号链接、跳过受保护条目和 `.git`，超过上限标为不完整且不泄漏文件描述符。
  - `packages/application/test/workspace-changes.unit.test.ts`、`apps/agent-service/test/production-workspace-ledger.unit.test.ts`、`apps/agent-service/test/production-coding-workflow.unit.test.ts` 的 `[BW-3]`：对比结果、指纹、慢扫描警告、执行顺序、崩溃恢复复用、快照失败不执行、对比失败仍返回结果。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [SOURCE: docs/adr/0053-workspace-auto-approval-like-codex.md]
- [SOURCE: docs/adr/0031-isolated-tool-execution.md]
- [SOURCE: docs/engineering-casebook.md#case-bash-workspace-write]
- 产出文件交付调研页：<https://claude.ai/artifact/3DVB7FZb7SKpG1zw9JSVtR>
- 代码：`scripts/delivery-mode/packet-template/signing/cloud-seal.mjs`、`apps/agent-service/src/workspace-auto-authorization.ts`、`apps/agent-service/src/production-coding-workflow.ts`、`apps/agent-service/src/production-workspace-ledger.ts`、`packages/application/src/services/workspace-changes.ts`、`packages/platform-node/src/files/host-read-only.ts`、`apps/agent-service/src/production-run-policy.ts`

[↑ 返回阅读导航](#contents)
