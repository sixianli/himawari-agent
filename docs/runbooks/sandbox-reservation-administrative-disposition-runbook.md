---
status: active
document_type: runbook
execution_risk: critical
supersedes: ""
superseded_by: ""
date: "2026-11-26"
covers: "apps/admin-cli/src/sandbox-command.ts, packages/persistence-sqlite/src/sqlite-sandbox-reservation-administration.ts, scripts/delivery-mode/packet-template/maintenance/run-maintenance.mjs, test/integration/sandbox-reservation-administration.test.ts"
verified_at: "7c8521fe5f55e7dd57c5bd52badd16eef647502e"
---

# 卡住的沙箱预约：核对和管理员处置

本手册处理一种少见情况：一次性沙箱（SRT，产品在 Linux 上跑工具用的隔离环境）给某次工具调用登记了“预约”，但还没真正启动就停了，又没有留下自动释放的证明。这样的预约会一直占着工作目录，上线时维护步骤也会因为它停下。处置的办法是由管理员人工确认现场干净后，用管理命令写一条“管理员确认已清理”的记录。

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

- 适用：当前配置的 Owner 和 Agent 下，单个前台一次性 SRT 调用留下的预约，状态是 `reserved`、`started_at` 为空、已有停止标记，且没有自动释放回执。
- 不适用：已启动（`bound`）的任务、后台任务、容器，以及同一轮复用的常驻沙箱（计划后端是 `srt-task-environment`，Linux 默认走这条路）。常驻沙箱的预约靠任务环境的释放回执自动释放，本命令对它们报 `SANDBOX_RESERVATION_ADMIN_NOT_ELIGIBLE`。
- 处置只写“资源已释放”和“这一轮失败”，不重放工具、不调用模型；原工具结果和外部效果仍是“未确认”。

<a id="authoritative-sources"></a>

## Authoritative Sources

- 命令入口：`apps/admin-cli/src/sandbox-command.ts`（`sandbox inspect-reservation`、`sandbox confirm-reservation-cleanup`）。
- 资格、摘要和写入：`packages/persistence-sqlite/src/sqlite-sandbox-reservation-administration.ts`。
- 上线时的同一项检查：`scripts/delivery-mode/packet-template/maintenance/run-maintenance.mjs`，未解决的预约数不是 0 就停下。
- 回归测试：`test/integration/sandbox-reservation-administration.test.ts`，其中一组用例直接运行下面[统计未解决预约](#count)那段脚本。

<a id="safety-and-preconditions"></a>

## Safety and Preconditions

- 确认命令要求服务已停（命令自己取状态目录的独占锁，取不到就失败），并且数据库是当前程序的版本。只读预览不需要停服。
- 管理员要独立确认三件事：原沙箱进程组已经不在、原控制目录里没有最终结果文件、没有相关进程在跑。命令不检查进程和文件，只记下管理员的声明、现场报告的 SHA-256 和实际执行的本机账号；声明不是机器证明，管理员对它负责。
- 停服属于生产操作，按[交付模式](../../.agents/instructions/delivery-mode.md#fast-mode)先备份；处置写入的记录不可撤销，执行前把目标任务号和影响报告给 Andy。

<a id="live-state-preflight"></a>

## Live-State Preflight

1. 用下面[统计未解决预约](#count)的脚本只读查一遍，记下数量。
2. 对每个目标任务号只读预览：`himawari sandbox inspect-reservation --config /etc/himawari/config.json --job <任务号>`。记下返回的 `digest` 和 `confirmation`。不符合资格时返回 `SANDBOX_RESERVATION_ADMIN_NOT_ELIGIBLE`，停下。
3. 在生产机上核对上面三件事，把核对的时间、依据和结论写成现场报告，算出它的 SHA-256。任何一件确认不了就停下。

<a id="procedure"></a>

## Procedure

<a id="count"></a>

### 统计未解决预约

把路径换成 `<stateRoot>/data/product.sqlite`，以服务账号运行。它只读，数量不为 0 时以非零退出码结束：

~~~sh
python3 - /absolute/path/product.sqlite <<'PYTHON'
import pathlib, sqlite3, sys
uri = pathlib.Path(sys.argv[1]).resolve(strict=True).as_uri() + "?mode=ro"
with sqlite3.connect(uri, uri=True) as database:
    database.execute("PRAGMA query_only = ON")
    count = database.execute("""
        SELECT count(*) FROM sandbox_execution_records reservation
        WHERE json_extract(reservation.plan_json, '$.backendRef') = 'srt'
          AND reservation.preparation_state = 'reserved' AND reservation.started_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM sandbox_reservation_release_receipts released
            WHERE released.job_id = reservation.job_id
              AND json_extract(released.verification_json, '$.identity.jobId') = reservation.job_id
              AND json_extract(released.verification_json, '$.stopRequestedAt') = reservation.reservation_stopped_at
          )
          AND NOT EXISTS (
            SELECT 1 FROM sandbox_release_receipts released
            WHERE released.job_id = reservation.job_id
              AND json_extract(released.verification_json, '$.identity.jobId') = reservation.job_id
          )
    """).fetchone()[0]
print("尚未启动的 SRT 预约数：", count)
if count:
    raise SystemExit("停止升级：仍有尚未解决的 SRT 预约，须报告用户并独立核查释放回执。")
PYTHON
~~~

### 单个预约的处置

1. 停服务，再预览一次（停服前的摘要不能用）。
2. 执行一次：

   ```text
   himawari sandbox confirm-reservation-cleanup --config /etc/himawari/config.json --job <任务号> --digest sha256:<预览返回的摘要> --administrator <管理员标识> --evidence sha256:<现场报告摘要> --confirm HOST_GROUP_ABSENT_FINAL_ABSENT_RELATED_PROCESSES_ABSENT
   ```

   命令在独占锁里重新核对资格和摘要，同一事务写入管理员回执、审计、释放占用、把这一轮和它的检查点标成失败、结算执行租约，并给对话写一条“这一轮失败”的事件。
3. 再跑一次[统计](#count)，确认这一条不再计入，然后启动服务。

<a id="verification"></a>

## Verification

- 命令返回的 `receipt.verification.basis` 是 `administrator_confirmed_cleanup`。
- 再预览同一任务号返回 `SANDBOX_RESERVATION_ADMIN_NOT_ELIGIBLE`，这是预期的：它已经处置过了。
- 统计数量比处置前少一，并且 `node scripts/operations/workspace-lifecycle-audit.mjs` 的 `executions` 分区里这一条带 `ADMINISTRATOR_CONFIRMED_CLEANUP`（见[工作区占用只读核查](workspace-lifecycle-audit-runbook.md)）。

<a id="evidence"></a>

## Evidence

交付报告写：任务号、两次预览的摘要、现场报告的 SHA-256、实际命令和退出码、处置前后的统计数量。现场报告正文放在生产机上只有 root 能读的目录，不贴进对话或仓库。

<a id="rollback"></a>

## Rollback

- 提交前任何检查失败，事务整体回滚，什么都没写。
- 提交后不撤销：管理员回执是永久记录。如果之后发现原进程其实还在，停下，保留记录，另行处理；要整体退回只能按[机外备份 Runbook](production-offsite-backup-runbook.md#restore-to-production) 恢复到处置前的恢复点，恢复点之后的数据会丢。

<a id="stop-conditions"></a>

## Stop Conditions

- 预览不符合资格、摘要在两次预览之间变了，或有其他未释放的资源。
- 三件事任何一件确认不了，或现场报告缺失。
- 服务没停、锁取不到：不删锁文件。

<a id="troubleshooting"></a>

## Troubleshooting

| 现象 | 处理 |
| --- | --- |
| `SANDBOX_RESERVATION_ADMIN_SCHEMA_UNSUPPORTED` | 程序和数据库版本不一致；先完成上线让两者一致，不改数据库版本 |
| `SANDBOX_RESERVATION_ADMIN_NOT_ELIGIBLE` | 不是本手册管的那种预约，或已经处置过；用工作区占用核查看它属于哪类 |
| 摘要变了 | 重新预览、重新核对现场，不改参数重试 |
| 上线停在维护步骤、提示未解决预约 | 按本手册逐条处置后重新上线；不删记录让数量归零 |
