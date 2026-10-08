---
status: active
document_type: runbook
execution_risk: critical
contract_sha256: "sha256:ba7aac170aa3f7d3952e3cb4d37f296d542fa82a8f36508237e23cd1c274ff1c"
supersedes: ""
superseded_by: ""
date: "2026-10-08"
---

# 未绑定沙箱预约的离线管理员处置

执行前必须通过本 Runbook 的静态合同检查与本次现场预检。本文及功能实现批准均不授权生产停服、迁移、数据库处置或服务启动。

阅读导航：[范围](#scope) · [前提](#safety-and-preconditions) · [现场核查](#live-state-preflight) · [Schema 49 离线路线](#schema-49-offline-route) · [处置步骤](#procedure) · [独立读回](#verification) · [停止条件](#stop-conditions)。

<!-- runbook-contract:
- docs/execution/specs/2026-09-28-sandbox-preparation-control-recovery-design.md
- packages/application/src/ports/sandbox-execution-journal.ts
- packages/application/src/services/sandbox-execution-projection.ts
- packages/persistence-sqlite/src/sqlite-sandbox-reservation-never-started.ts
- packages/persistence-sqlite/src/sqlite-sandbox-reservation-administration.ts
- packages/persistence-sqlite/src/sqlite-sandbox-reservation-release.ts
- packages/persistence-sqlite/src/migration-engine.ts
- packages/persistence-sqlite/src/sqlite-recovery-point.ts
- packages/persistence-sqlite/src/schema-catalog.ts
- packages/persistence-sqlite/src/index.ts
- packages/persistence-sqlite/src/migrations/0050_sandbox_reservation_administration.sql
- packages/persistence-sqlite/src/state-root-lock.ts
- packages/persistence-sqlite/src/migrations
- apps/admin-cli/src/index.ts
- apps/admin-cli/src/sandbox-command.ts
- scripts/install-node-runtime.mjs
- apps/agent-service/src/production-tool-result-recovery.ts
- test/integration/sandbox-reservation-administration.test.ts
- test/integration/product-path-browser.test.ts
- test/fixtures/product-path-harness.ts
-->

## Scope

只处置当前配置 Owner/Agent/deployment 下，单个前台 SRT Run 的一个已停止、未绑定预约。目标须为 `reserved`、`started_at` 为空且有原停止标记；空 started 不证明从未启动。bound、container、托管后台任务、跨主体目标及其他未处置资源不在范围内。

该操作保存管理员确认的资源释放，明确结束 Run；原工具结果和外部效果仍未确认，不重放工具、不调用模型、不交付 `SANDBOX_TOOL_NOT_STARTED`。它不删除原计划、facts、observations、控制 Payload 或执行历史。

目标还须有仍为 `open` 的所属 Thread、原执行租约和恢复记录；Run 与 checkpoint 都处于 `reconciling_external_result`，checkpoint 尚无终态、output 或最终答案。其他未释放资源、未决保护或未确认意图会使本次处置被拒绝。

## Authoritative Sources

- [管理员处置合同](../execution/specs/2026-09-28-sandbox-preparation-control-recovery-design.md#admin-reservation-disposition)。[SOURCE: docs/execution/specs/2026-09-28-sandbox-preparation-control-recovery-design.md]
- [停止证明与结果分开](../execution/specs/2026-09-24-isolated-tool-execution-design.md#lifecycle)。[SOURCE: docs/execution/specs/2026-09-24-isolated-tool-execution-design.md]
- [永久释放与结果交接](../adr/0030-durable-workspace-release-facts.md)。[SOURCE: docs/adr/0030-durable-workspace-release-facts.md]
- [安装启停](install-start-stop-runbook.md)、[同机备份恢复](backup-restore-runbook.md)。[SOURCE: docs/runbooks/install-start-stop-runbook.md] [SOURCE: docs/runbooks/backup-restore-runbook.md]
- [只读历史清单](workspace-lifecycle-audit-runbook.md)不是实际宿主证明，也不是管理员处置授权。

## Safety and Preconditions

确认处置使用本次受验证的完整安装、匹配配置与 Schema 50。只读预览接受 Schema 49/50，不自动迁移；Schema 49 旧库须先完成下述独立离线路线，生产还需覆盖完整候选安装、备份、迁移和管理员处置的具体授权。Schema 49 及更旧 writer 不得接管新库；不得直接修改数据库列或补造 Host final。Agent 与 Worker 必须停止，确认命令自行取得原 state-root 独占锁；存活锁取得失败时停止，不删除或绕过它。

执行账号须有目标配置与数据库的合法访问权。命令记录实际本机 UID/account/hostname，并分别保存 `--administrator` 声明引用；声明引用不证明具体自然人身份。准备本次独立现场报告、SHA-256、已经验证的完整恢复点及项目批准的受保护证据目录。

在任何停服、迁移或处置之前，报告具体主机、安装、state root、Owner/Agent、Run/Job、拟修改记录和副作用，取得覆盖这些动作的授权。生产还须对应本次冻结操作包的具体授权。本文不包含服务管理、系统设置或生产变更脚本。

## Live-State Preflight

1. 运行本 Runbook 静态检查，核对当前 Git/worktree、安装摘要、运行账号、配置归属、真实数据库位置和 Schema。只读预览只接受 Schema 49/50；未知版本或不匹配安装停止，Schema 49 不得执行确认处置。
2. 以只读 `sandbox inspect-reservation` 核对 Job/Run/Thread/环境身份、停止标记与四个 revision，保存摘要和固定 `confirmation`。摘要绑定其他相关资源的数据库快照，但预览不输出资源统计；confirmation 列明三项必须由运维独立确认的声明。该命令不解密 control、不读取 secret 或工具正文，不检查任何进程或 final。
3. 运维独立确认原宿主进程组已不存在、原控制目录内没有 final、没有相关运行进程。将原任务身份、检查时间、依据、权限可见范围及结论保存在本次受保护现场报告；独立计算其 SHA-256。
4. 旧记录缺少可信 PID/PGID 时，运维必须另行核对系统现场，不能从数据库空值、目录名、不可连接 socket 或普通进程列表为空推导结论。不能确认三项中的任何一项，停止。
5. 核对 Agent/Worker 已停止、恢复点可用、证据目录隔离及空间可用。若停服或迁移尚未得到具体授权，不执行这些动作。

三项运维声明和报告 SHA 都不是认证 Host proof。CLI 不读取现场报告正文，也不自动核验这些声明；管理员承担本次确认责任。

## Procedure

<a id="schema-49-offline-route"></a>

### Schema 49 的独立离线路线

旧安装/升级 Runbook 的 `reserved` 且 `started_at` 为空计数门禁限制服务升级与切换。非零仍按原门禁停止并报告。这里为已经批准的离线数据库维护提供独立路线；它不通过或放宽旧门禁，也不授权切换或启动服务。

1. 先核对受支持的 Schema 49 完整旧安装、原配置、完整新候选及独立新前缀。新候选按[安装流程](install-start-stop-runbook.md#procedure)校验并复制到独立前缀，只产生该前缀的 runtime 与三个 wrapper；安装脚本不读产品 state、不迁移数据库、不启动服务，也不改现有服务的安装指向。安装该候选仍须属于本次具体授权。
2. 按已授权的停服步骤停止 Agent/Worker，确认 state-root 锁释放。在 Schema 49 仍完整时，用匹配 Schema 49 的旧完整安装绝对路径，按[同机备份流程](backup-restore-runbook.md#procedure)执行 `backup create` 与 `backup verify`，保存完整恢复点、核验结果及恢复所需的旧安装。`backup create` 会写恢复点登记和加密文件，必须已获得对应目标与动作授权。新 Schema 50 CLI 的 recovery adapter 要求恢复点 schema 精确为 50，不能用它替代这一旧库备份或核验。
3. 完整 Schema 49 恢复点核验成功后，使用受验证新候选的绝对路径执行以下接口。公共 `db migrate` 独立取得停服 state-root 锁，使用 SQLite backup API 创建并核验同机迁移前数据库快照，再应用迁移；它不执行旧升级 Runbook 的预约计数门禁。这个数据库快照不替代步骤 2 的完整恢复点。迁移只推进数据库合同，原未确认预约与历史仍须保留。

```text
<absolute-new-prefix>/bin/himawari db migrate --config PATH --confirm APPLY_MIGRATIONS
<absolute-new-prefix>/bin/himawari db status --config PATH
```

4. 独立核对 schema sequence 和 minimum writer 均为 50、迁移账本及数据库检查成功，原目标、未确认预约、计划和观察未被删除或改写。用该完整 Schema 50 新候选按[同机备份流程](backup-restore-runbook.md#procedure)创建并核验 Schema 50 完整恢复点，保留迁移前的 Schema 49 恢复点。任一步失败均停止，不让旧 Schema 49 writer 再写新库。
5. 仍在停服状态，用新候选执行下述 Schema 50 资格预览、现场确认与单目标管理员处置。此时才能取得确认所需的最新 digest。处置不会把旧升级统计改写为自动通过；旧门禁仍非零时，不切换或启动服务，报告剩余阻断并另行取得后续动作授权。

迁移、管理员处置与服务切换是不同动作。源代码存在上述入口不等于 Schema 49 到 50 再处置的安装场景已经通过；执行前还须取得匹配本次候选字节的实际验证证据与目标现场预检。

### Schema 50 的单目标处置

以下为接口示例，所有占位值必须来自已经核对的目标。它们不是可直接运行的生产操作包。

```text
<absolute-prefix>/bin/himawari sandbox inspect-reservation --config PATH --job JOB
```

1. 完成静态检查、现场只读核查及有效风险判断。在首次目标变更前取得所需授权；Schema 49 目标先完成[独立离线路线](#schema-49-offline-route)，停服或安装分别遵循相应 Runbook，不由处置命令自动完成。
2. Agent/Worker 停止且 Schema 50 就绪后，再读一次预览；停服前的摘要不能替代这次读回。
3. 仅在三项现场条件已由运维确认、报告已保留且摘要已独立计算时执行一次确认命令：

```text
<absolute-prefix>/bin/himawari sandbox confirm-reservation-cleanup --config PATH --job JOB --digest sha256:64hex --administrator MACHINE_REF --evidence sha256:64hex --confirm HOST_GROUP_ABSENT_FINAL_ABSENT_RELATED_PROCESSES_ABSENT
```

4. 命令在独占锁内重新比较配置归属、目标资格、版本和摘要。同事务保存管理员回执、审计、占用释放、Run/checkpoint 失败、执行租约结算及 Thread 持久事件。
5. 保存实际命令、退出码和固定结果。任一拒绝均停止；摘要变化重新预览和核查，不通过改参数或删历史重试。

## Verification

命令成功退出后，以处置命令返回的回执、匹配版本的只读 workspace inventory 和独立受保护数据库读回共同确认。`inspect-reservation` 只做处置资格预览；成功后 Run 已 failed 且回执已存在，再执行 inspect 会返回 `SANDBOX_RESERVATION_ADMIN_NOT_ELIGIBLE`，不能把这个拒绝当作处置失败。独立读回要求：

- 只有目标 Job 有一条独立管理员回执，`schemaVersion=sandbox-admin-reservation-release.v1`、`basis=administrator_confirmed_cleanup`，身份、摘要、实际执行账号与管理员声明匹配。
- 对应占用已释放，后续核查安排结束；Run 与 checkpoint 均为 `failed`，原执行租约已结算。
- 所属 Thread 的持久事件与审计指向同一次处置；相同处置不会重复事件、审计或版本变化。
- checkpoint 诊断为 `SANDBOX_ADMINISTRATOR_CONFIRMED_CLEANUP`，审计 action 为 `sandbox.reservation_cleanup_confirmed`，Thread 事件为 `run.failed`。管理员回执为永久历史，不套用 Host verification 的 `validUntil`。
- 历史回执仍通过原计划身份、authority 摘要和审计关联的完整性检查；关联缺失或不匹配时停止，不把损坏记录作为释放依据。
- 原计划、facts、observations、started、控制材料和工具结果保持原样；工具及外部效果仍未确认，没有新工具结果交付、模型继续执行意图或工具派发。

刷新后保留同一行政失败事实。Run `failed`、管理员回执存在或进程列表为空，均不能作为工具从未启动、工作区未改动、外部副作用已核实或当前整个主机安全的证明。服务启动另按已授权的启停流程执行，不能作为本命令的隐含步骤。

## Evidence

使用项目批准的受保护证据根和唯一处置编号；根目录未确认则停止。保存静态检查、旧/新完整安装摘要与绝对前缀、目标身份与版本、迁移前后的完整恢复点及核验结果、迁移快照与独立读回、两次预览、现场报告及摘要、授权引用、实际命令与退出码、管理员回执、事务结果的独立读回、停止或回退结论。

保留原失败证据和本次新证据，不覆盖历史。正文、控制密钥、环境变量、secret 值和未经筛选的配置输出不进入公开文档或聊天。生产报告不能用 Hermes 夹具报告代替。

Run 进入 `reconciling_external_result` 不表示停止记录和恢复记录已经持久化。Hermes 管理员安装场景须在原期限内等待公共只读 `inspect-reservation` 接受目标，再保存处置前读回；该等待不替代独立进程组和 final 核查，也不放宽原状态断言。

该安装夹具失败时保留原错误和独立读回。只有目标尚无释放回执、原签名 final 的摘要和长度匹配且原宿主与进程组已不存在，才恢复夹具保存的原 final 并等待正常证明释放；已有管理员回执时不恢复 final。失败收尾始终继续报告失败，不能计作管理员场景通过；这也不是生产处置步骤。

Hermes 安装权限回归若超时，保留完整报告，并使用既有 `HIMAWARI_TEST_INSTALLATION_REPORT` 与 `HIMAWARI_TEST_DIAGNOSTIC_OUTPUT` 在本次受保护输出目录记录安装耗时、全量权限清单和安装、核验、断言、清理阶段。继续使用默认 30 秒期限；单独运行通过不证明原超时原因已解决。诊断输出失败也必须执行原安装目录清理，并同时保留原核验、清理和诊断写入错误；不得用观测错误覆盖原失败。

## Rollback

提交前失败会回滚事务，保持原占用和 Run；先检查固定错误与预览变化，不直接修改 SQL。提交后不撤销或覆盖管理员回执，不复活 failed Run。出现相反现场证据时停止新的冲突操作，保留处置历史并按既有风险保护流程处理。

只有经过独立验证的完整恢复点、对应版本和重新取得的具体恢复授权，才可进入[备份恢复流程](backup-restore-runbook.md)。恢复处置前快照会恢复当时的未确认状态及占用，不自动重放管理员确认；不承诺恢复能撤销已经发生的工具或外部效果。

## Stop Conditions

- 静态合同未封存或不匹配、安装或 Schema 不匹配、目标归属不明、缺少恢复点或受保护证据目录。
- Agent/Worker 未停止、存活或未知 state-root 锁、无法确认三项现场条件、现场报告缺失。
- 不是单个前台 SRT 已停止 reserved、存在其他未处置资源或保护、预览摘要或版本改变。
- 参数、确认串、报告 SHA 或管理员声明不符合接口；已有不同处置回执；任一事务或独立读回失败。
- 生产或服务动作没有具体授权。不得通过删除记录、删除活锁、改身份或改写 final 继续。

## Troubleshooting

| 现象 | 核查与处理 |
| --- | --- |
| socket 不可连接、没有 final | 只说明机器证明不足；自动恢复保持占用。运维另行核查，不能确认则不处置 |
| started 为空、原 PID/PGID 未保存 | 只读预览不能判断是否启动或是否消失；不要按当前相似 PID 猜测 |
| 独占锁取得失败 | 核对原服务与锁持有者；不删除存活或未知锁 |
| 摘要变化或存在其他资源 | 停止本次窄范围处置，重新核对目标和现场；不批量删除 |
| 管理员回执存在，工具仍显示未确认 | 这是资源责任与工具结果分开的预期状态；不补造工具失败或交回模型 |
| 原安装/升级统计仍非零 | 保留原保守升级门禁，按安装 Runbook 停止并报告；不删除已处置历史使计数归零 |
