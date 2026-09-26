# 删除旧的未确认 SRT 执行记录：管理命令

日期：2026-09-27 UTC。对应[隔离执行实施计划的 P3 补充](../../../../../docs/execution/plans/2026-09-24-isolated-tool-execution-plan.md#p3-modes)第二项（ITE-26），规则见 [Spec 的删除旧的未确认记录](../../../../../docs/execution/specs/2026-09-24-isolated-tool-execution-design.md#legacy-purge)，操作步骤见[运维手册的删除旧的未确认 SRT 执行记录](../../../../../docs/runbooks/install-start-stop-runbook.md#purge-unconfirmed-srt-records)。

## 用词

| 用词 | 意思 |
| --- | --- |
| SRT | 在宿主上限制单个进程能访问哪些文件和网络的进程级沙箱（依赖包 `@anthropic-ai/sandbox-runtime`） |
| 未确认记录 | 执行记录的清理结果为 `unknown`：没有证据说明工具程序已经停下，所以一直挡住目录 |
| 摘要（digest） | 对整份待删清单算出的 SHA-256 值；删除时要带上它，清单有任何变化就对不上 |
| state root 锁 | 产品状态目录上的独占锁；服务运行时持有它，所以拿不到锁就说明服务没停 |
| 删除标记 | 写在现有 `deletion_tombstones` 表里的记录，说明某条执行记录已被删除，供界面和 Run 结束检查使用 |
| Run | 用户每发一条消息启动的一轮执行 |

## 改了什么

- 新增 [`SqliteUnconfirmedSandboxPurge`](../../../../../packages/persistence-sqlite/src/sqlite-sandbox-unconfirmed-purge.ts)：`list()` 只读列出清单和摘要；`purge(digest)` 在一个事务里重新计算清单，摘要不同就以 `SANDBOX_PURGE_DIGEST_MISMATCH` 拒绝，相同则写删除标记、汇总和审计事件，先删目录占用、冲突保护、观察记录、操作观察和执行 intent，再删执行记录本身。数据库原有的删除保护触发器（有未释放占用或未解决保护时不许删执行记录）不受影响，因为这些关联数据先被删掉了。
- 管理命令行新增 `himawari sandbox list-unconfirmed` 和 `himawari sandbox purge-unconfirmed --digest <摘要>`（[`sandbox-command.ts`](../../../../../apps/admin-cli/src/sandbox-command.ts)）。删除前取得 state root 锁，拿不到时以 `ADMIN_TARGET_NOT_STOPPED` 拒绝。
- Run 结束检查（[`sqlite-run-resource-guard.ts`](../../../../../packages/persistence-sqlite/src/sqlite-run-resource-guard.ts)）：已准入的排队记录如果对应的执行记录已被本命令删除（有 `sandbox_execution` 删除标记），不再算作未释放资源。排队记录本身不删，因为它的授权绑定有禁止删除的触发器。
- 没有新增数据库迁移：删除标记和汇总用现有的 `deletion_tombstones`（状态写 `verified`，其他读取这张表的代码只处理 `pending`、`incomplete`），审计用现有的 `audit_records`。

## 自动测试

[`sandbox-unconfirmed-purge.test.ts`](../../../../integration/sandbox-unconfirmed-purge.test.ts) 从管理命令行入口 `runAdminCli` 进入，使用真实迁移后的 SQLite。同一个数据库里放入范围内的 2 条记录（`lost` 和 `reconciling` 两种未确认状态，其中一条带未解决保护、未确认的控制 intent、操作观察和已准入的排队记录），以及范围外的 5 条（已释放且有回执、未启动的预约、严格模式、清理仍为 `pending` 的受控记录、其他 Owner 的记录）。

| 场景 | 断言 |
| --- | --- |
| 列出 | 只列出范围内 2 条，目录、条数和开始时间正确；两次列出摘要相同；列出前后 16 张相关表逐行相同 |
| 拒绝 | 缺少摘要报参数错误；错误摘要报 `SANDBOX_PURGE_DIGEST_MISMATCH`；测试持有 state root 锁时报 `ADMIN_TARGET_NOT_STOPPED`；列出之后又新增一条未确认记录，用旧摘要删除被拒绝；每次拒绝后逐表读回都没有变化 |
| 删除 | 输出被删编号和条数；8 张执行相关表逐表读回，只少了范围内记录的行；Owner、Agent、对话、Run、排队、授权绑定、调用回执、Payload 8 张表逐行不变；写入 2 条删除标记、1 条汇总和 1 条审计事件；范围内记录所属的 Run 从“有未释放资源”变为可以结束，严格模式和其他 Owner 的 Run 仍被挡住；再次列出为空 |

- [`sandbox-unconfirmed-purge.log`](sandbox-unconfirmed-purge.log)：3 项通过。运行方式：`npx vitest run --config vitest.workspace.ts --project integration test/integration/sandbox-unconfirmed-purge.test.ts --reporter verbose`，代码版本为提交 `79289ec` 加本次改动（即本证据所在提交）。输出里本机沙箱打印的、与测试无关的 `failed to copy trust settings` 行已去掉。
- 功能实现前，同一测试 3 项全部失败，原因是命令不存在（`ADMIN_ARGUMENT_INVALID`）。
- 反向检查：临时让 Run 结束检查不识别删除标记后，“删除”场景在 Run 可以结束的断言处失败；恢复后通过。
- 相关回归：`sqlite-sandbox-execution-v2`、`workspace-lifecycle-audit`、`sqlite-governed-deletion`、`sandbox-resource-recovery-scheduling` 集成测试共 262 项，admin-cli 单元测试 27 项，persistence-sqlite 合同测试 33 项，全部通过；`npm run typecheck`、`npm run lint`（只有提示级信息）、`npm run check:boundaries` 通过。

## 未验证的部分

- 没有对任何真实数据库执行删除。所有者已授权在所有机器上执行，执行放在本提交和完整 `npm test` 之后。
- 测试数据是按真实表结构直接写入的行，写入时关闭了外键检查（调用回执、Handle、Trigger 等前置记录没有造）；删除本身在开启外键检查的连接里运行。真实库里的记录由产品写入流程产生，字段比测试数据多，列出和删除只读取测试里用到的字段。
- 界面对被删记录显示“执行记录已删除”还没有做，在下一个提交里处理；在那之前，历史对话里对应的工具步骤可能不显示资源状态，经过排队的调用可能显示为未确认。
