---
status: active
document_type: runbook
execution_risk: standard
contract_sha256: "sha256:5e22ec39ab1692e840705731a027d7658ecef8be2cad851879027f8ca86a5c67"
supersedes: ""
superseded_by: ""
date: "2026-09-19"
---

# 工作区历史占用只读核查

**来源：** [SOURCE: docs/execution/specs/2026-09-16-workspace-authorization-lifecycle-design.md]

<!-- runbook-contract:
- packages/persistence-sqlite/src/migrations/0042_sandbox_resource_incidents.sql
- scripts/operations/workspace-lifecycle-audit.mjs
- test/integration/workspace-lifecycle-audit.test.ts
- packages/persistence-sqlite/src/migrations
-->

阅读导航：[范围](#scope) · [前提](#safety-and-preconditions) · [现场预检](#live-state-preflight) · [步骤](#procedure) · [结果判读](#verification) · [停止条件](#stop-conditions)

## Scope

本流程读取 Schema 28～45 的工作区占用、执行和排队元数据，供后续恢复方案使用。工具通过 SQLite 只读连接和 `query_only` 执行，一页最多读取 1,000 条记录，不创建数据库、不迁移、不更新释放记录、不派发任务、不消费授权，也不解密文件正文或工具结果。

Schema 39 的自动审查记录不属于这三个工作区分区；空列表不证明没有审查或授权记录。

Schema 44 的绑定历史与 Schema 45 的批次关联同原队列一起保留；本清单按原队列身份报告是否已经准入，不把重新绑定解释为已执行或可重放。

这是数据库清单，不是实际宿主的停止证明。所有输出固定标明 `liveHostVerified: false` 和 `repairEligible: false`。即使数据库已有释放回执，也不据此生成自动解锁或重新执行命令。

## Authoritative Sources

- [执行与恢复约束](../execution/specs/2026-09-16-workspace-authorization-lifecycle-design.md#七恢复与错误合同)。
- [实施进度和验收边界](../execution/plans/2026-09-16-workspace-authorization-lifecycle-plan.md#implementation-record)。
- [核查入口](../../scripts/operations/workspace-lifecycle-audit.mjs)与[真实 CLI/SQLite 回归](../../test/integration/workspace-lifecycle-audit.test.ts)。
- [数据库备份与恢复流程](backup-restore-runbook.md)。复制活动数据库时应使用合适的 SQLite 备份方法，不只复制主文件而遗漏 WAL 中的数据。

## Safety and Preconditions

使用本仓库锁定依赖和匹配的 Node/native SQLite 环境。运行账号必须有目标数据库的读取权限。优先在已经验证的隔离备份上核查，明确该副本对应哪个实例、Owner 和 Agent，以及备份时间。

输出包含内部任务编号和状态，保存在目标实例允许的受保护证据目录，不把清单公开上传。工具不打印数据库路径、授权 JSON、秘密引用、文件内容或受保护结果正文；命令行本身仍含数据库路径，应按本机终端记录的权限管理。

读取当前实例是只读操作；任何后续停止进程、修复记录、迁移或部署均不包含在本流程中，需要对应的现场证明和具体操作授权。

## Live-State Preflight

1. 核对目标数据库绝对路径、对应实例和 Owner/Agent；不从相似文件名猜测目标。
2. 核对当前源码、依赖及本 Runbook 静态合同；未知 Schema 停止读取，不自动升级。
3. 确认是冻结备份还是活动数据库。每一页是独立 SQLite 快照；活动数据库的不同页面可能看到不同时间的状态，不能把跨页结果冒充同一时刻的完整清单。
4. 确認证据输出目录和访问权限。本文命令中的路径与 ID 均为占位值，必须替换为已核对值。

## Procedure

在本仓库根目录执行，以下命令仅示范参数：

```sh
node scripts/operations/workspace-lifecycle-audit.mjs \
  --database /absolute/path/to/verified-copy.sqlite \
  --owner owner-id --agent agent-id \
  --section executions --limit 100
```

依次读取三个分区：`executions` 是新版执行与占用；`legacy` 是旧版未释放保护；`queue` 是持久排队记录。Schema 28～34 尚无持久队列表，`queue` 返回空页，不能理解为已存在该功能但当前没有任务。

当 `nextAfterId` 非空，用该值作为同一分区下一次调用的 `--after` 参数。保留每一页和其参数，直到返回空游标；恰好填满一页时可能还需要读取一次空页。分页按 job ID 排序，`queue.sequence` 才是原排队次序，不能按报告展示次序重排队列。

工具没有 `--repair`、`--apply` 或写入选项，未知参数直接拒绝。核查结束后，把需要宿主证明的条目交给对应的恢复流程；不要直接改表或重新执行原工具。

## Verification

`recoveryStatus=scheduled` 表示等待核查，`recoveryAction` 为 inspect/stop，`recoveryNextAttemptAt` 为最早核查时间；它不证明后台此刻正在执行。Schema 43 之前该时间字段为空。`unresolved` 与空的下一时间表示本次已结束且没有自动重试，不能将它画成仍在核查。只读报告不改变这些记录。

`releaseReceiptPresent` 表示已绑定资源的永久回执；`reservationReleaseReceiptPresent` 表示未绑定预约的独立回执。后者不补造资源 supervision 或工具结果，停止标记仍保留；只有回执存在且没有有效 claim/barrier，才不再列为未确认的资源责任。字段只反映数据库记录，仍不证明当前宿主安全，也不授予重新执行或修改数据库的权限。

首先核对输出 `mode=read_only`、Owner/Agent、Schema 和分区。下表说明主要原因代码；同一条目可以有多个原因。

| 代码 | 能说明什么 | 后续仍需核对什么 |
| --- | --- | --- |
| `UNBOUND_RESERVATION_STOPPED` | 未绑定预约已禁止启动；保留停止时间与恢复终点 | 原私有环境及占用是否真正释放；停止标记不是释放证明 |
| `RESOURCE_RELEASE_UNCONFIRMED` | 数据库没有已释放的资源状态或未绑定预约释放回执 | 原进程及后代是否仍能写入 |
| `RELEASED_WITH_ACTIVE_CLAIMS` | 已释放状态与仍有效占用同时存在 | 原身份、迟到派发隔离和有效释放证明 |
| `RELEASE_RECEIPT_MISSING` | 没有永久释放回执 | 不得把旧过期凭据重新当作当前证明 |
| `TERMINAL_RUN_HAS_RESOURCE_OBLIGATION` | Run 已结束，但仍有资源责任 | 结束对话不等于结束宿主进程 |
| `SANDBOX_RELEASE_CONTRADICTED` | 有独立资源矛盾事件，原释放事实仍保留 | 比事件更新且身份匹配的宿主停止证明；`resourceIncidents` 仅为计数，不披露证据正文 |
| `WORKSPACE_PROTECTION_ACTIVE` / `CONTROL_ACK_PENDING` | 仍有新风险保护或未确认控制消息 | 控制消息是否仍可能引起写入 |
| `RESULT_DELIVERY_PENDING` | 原结果交接尚未确认 | 当前披露权限；不得因此重新锁定或执行 |
| `RESULT_UNRESOLVED` / `EFFECT_UNRESOLVED` | 结果或修改效果尚无明确记录 | 原发布记录或其他独立效果证据 |
| `LEGACY_WORKSPACE_PROTECTION_ACTIVE` | 旧版占用尚未释放 | 旧宿主身份及实际清理情况 |
| `QUEUED_WITHOUT_DISPATCH_COMMIT` | 该排队条目没有对应准入和调用回执 | 原请求绑定、当前权限与目标；这不是重发许可 |
| `QUEUE_CANCELLED` / `QUEUE_ADMITTED` | 队列记录已取消或已有对应准入 | 保留历史；不要创建第二次执行 |
| `QUEUE_ADMISSION_REQUIRES_RECONCILIATION` | 队列与准入记录需逐条核对 | 不据此猜测已派发或未派发 |

回归命令沿用仓库集成测试入口：

```sh
node node_modules/vitest/vitest.mjs run --config vitest.workspace.ts \
  --project integration test/integration/workspace-lifecycle-audit.test.ts
```

## Evidence

保存源码提交、目标副本标识及时间、命令参数、分区游标、返回页和退出码。[本地证据目录](../../test/qualification/evidence/workspace-authorization-lifecycle/p7-local-01/)记录 CLI 子进程和真实 SQLite 测试，包括读取前后数据库正文及含 WAL 状态的独立序列化读回相同；不是生产历史数据演练或宿主进程资格证明。

## Rollback

工具没有业务写入，无数据库回退步骤。发生读取失败时保留错误代码和已取得的页面，修正目标或环境后重新核查；不通过删除 WAL、修改版本号或关闭完整性检查来让读取通过。

## Stop Conditions

遇到未知 Schema、账本序号不连续、读取错误、目标归属不清或输出与现场矛盾时，停止据此制定修复动作。`repairEligible=false` 永远不因缺少错误原因而变成允许修复。

## Troubleshooting

- `WORKSPACE_AUDIT_ARGUMENT_INVALID`：检查绝对路径、Owner/Agent、分区、游标和 1～1,000 的整数页大小。
- `WORKSPACE_AUDIT_SCHEMA_UNSUPPORTED`：当前读取器不支持该版本或账本序号不连续；不要修改数据库来适配脚本。
- `WORKSPACE_AUDIT_READ_FAILED`：检查数据库存在性、读取权限、只读副本完整性、SQLite native 环境和是否长期被独占锁占用。公共错误输出不包含底层路径或数据库内容。
