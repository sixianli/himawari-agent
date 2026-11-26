---
status: active
document_type: runbook
execution_risk: standard
supersedes: ""
superseded_by: ""
date: "2026-11-26"
covers: "scripts/operations/workspace-lifecycle-audit.mjs, test/integration/workspace-lifecycle-audit.test.ts"
verified_at: "7c8521fe5f55e7dd57c5bd52badd16eef647502e"
---

# 工作区占用只读核查

`scripts/operations/workspace-lifecycle-audit.mjs` 只读地列出数据库里还没确认释放的工具执行、工作目录占用、排队和任务执行环境，用来判断哪些记录需要人工核对。它以只读连接打开数据库，不迁移、不改记录、不派发任务、不解密正文。上线验收也会自动运行它。

<a id="contents"></a>

## 阅读导航

- [Scope](#scope)
- [Authoritative Sources](#authoritative-sources)
- [Safety and Preconditions](#safety-and-preconditions)
- [Live-State Preflight](#live-state-preflight)
- [Procedure](#procedure)
- [Verification](#verification)
- [Evidence](#evidence)
- [Rollback](#rollback)
- [Stop Conditions](#stop-conditions)
- [Troubleshooting](#troubleshooting)

<a id="scope"></a>

## Scope

- 适用：排查工具卡在“结果未确认”、工作目录一直被占用、上线停在未解决预约等问题时，先看数据库里记了什么。
- 不适用：修复。输出固定带 `liveHostVerified: false` 和 `repairEligible: false`：它只是数据库清单，不证明进程真的停了，也不授权任何修复。要处置单个卡住的一次性沙箱预约，见[卡住的沙箱预约](sandbox-reservation-administrative-disposition-runbook.md)。

<a id="authoritative-sources"></a>

## Authoritative Sources

- 核查程序：`scripts/operations/workspace-lifecycle-audit.mjs`。
- 回归测试：`test/integration/workspace-lifecycle-audit.test.ts`（真实 CLI 和真实 SQLite，核对读前读后数据库不变）。

<a id="safety-and-preconditions"></a>

## Safety and Preconditions

- 以能读数据库的账号（生产上是 `himawari-prod`）运行，用仓库锁定的 Node 和依赖。
- 优先在恢复点或数据库副本上跑；在运行中的数据库上跑时，每一页是各自的快照，不同页之间可能不是同一时刻。
- 输出含内部任务编号，只放在受保护的目录，不贴进对话。

<a id="live-state-preflight"></a>

## Live-State Preflight

确认数据库的绝对路径和它属于哪个 Owner、Agent（生产是 `owner:first-production`、`agent:first-production`）。数据库版本不在程序认得的范围内时，程序报 `WORKSPACE_AUDIT_SCHEMA_UNSUPPORTED`，不要改数据库去迁就它。

<a id="procedure"></a>

## Procedure

```sh
node scripts/operations/workspace-lifecycle-audit.mjs \
  --database /absolute/path/to/product.sqlite \
  --owner owner-id --agent agent-id \
  --section executions --limit 100
```

依次读四个分区：`executions`（每次工具执行和它的占用）、`legacy`（旧版未释放的占用）、`queue`（排队记录）、`environments`（任务执行环境和环境级占用）。`nextAfterId` 不为空时，把它作为同一分区下一次的 `--after`，直到它为空。每页最多 1000 条。

<a id="verification"></a>

## Verification

先看输出的 `mode` 是 `read_only`，Owner、Agent 和分区对得上。每条记录的原因代码含义：

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
| `ADMINISTRATOR_CONFIRMED_CLEANUP` | 数据库保存了管理员确认清理的预约释放来源 | 实际宿主与原操作效果仍须独立核对；不能作为认证 Host proof 或自动修复资格 |
| `LEGACY_WORKSPACE_PROTECTION_ACTIVE` | 旧版占用尚未释放 | 旧宿主身份及实际清理情况 |
| `ENVIRONMENT_RELEASE_UNCONFIRMED` | 任务级执行环境没有已接收的释放回执 | 执行后端对原环境身份给出的新停止证明；迟到的创建请求是否已被停止标记挡住 |
| `ENVIRONMENT_CREATE_UNKNOWN` | 创建请求已发出但结果未知，环境可能已经存在 | 按原创建记录向执行后端核查；不能重新创建一个替代环境 |
| `ENVIRONMENT_LEASE_ACTIVE` | 环境级占用仍有效，冲突的任务会被挡住 | 同上；占用只随释放回执一起解除 |
| `QUEUED_WITHOUT_DISPATCH_COMMIT` | 该排队条目没有对应准入和调用回执 | 原请求绑定、当前权限与目标；这不是重发许可 |
| `QUEUE_CANCELLED` / `QUEUE_ADMITTED` | 队列记录已取消或已有对应准入 | 保留历史；不要创建第二次执行 |
| `QUEUE_ADMISSION_REQUIRES_RECONCILIATION` | 队列与准入记录需逐条核对 | 不据此猜测已派发或未派发 |

<a id="evidence"></a>

## Evidence

记下提交号、数据库是哪一份（副本还是运行中的）、命令参数、每页输出和退出码。

<a id="rollback"></a>

## Rollback

程序不写数据库，没有要回退的。读失败时保留错误码，改正参数或环境后重跑；不删 WAL、不改版本号。

<a id="stop-conditions"></a>

## Stop Conditions

数据库版本不认得、读失败、Owner 或 Agent 不明确，或输出和现场矛盾时，不据此做任何修复。

<a id="troubleshooting"></a>

## Troubleshooting

| 错误码 | 处理 |
| --- | --- |
| `WORKSPACE_AUDIT_ARGUMENT_INVALID` | 检查绝对路径、Owner、Agent、分区名、游标和 1 到 1000 的页大小 |
| `WORKSPACE_AUDIT_SCHEMA_UNSUPPORTED` | 程序不认得这个数据库版本，换用和数据库匹配的提交里的程序 |
| `WORKSPACE_AUDIT_READ_FAILED` | 查文件是否存在、读权限和数据库是否被长时间独占锁住 |
