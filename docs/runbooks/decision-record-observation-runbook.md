---
status: active
document_type: runbook
execution_risk: critical
contract_sha256: "sha256:864e3522a25e08609e9620ae89f1690072349512795f8c1ae9a0915dc5ef3341"
supersedes: ""
superseded_by: ""
date: "2026-11-03"
covers: ".agents/instructions/delivery-mode.md, apps/agent-service/src/production-observation.ts, packages/application/src/services/ledger-observation.ts, packages/persistence-sqlite/src/migrations/0074_ledger_observation.sql, scripts/delivery-mode/deploy.sh, scripts/delivery-mode/packet-template/s0-db/read-s0-db.mjs"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# 决策记录观察期 Runbook

<!-- runbook-contract:
- https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0155-decision-record-observation-and-weekly-report-page.md
- apps/agent-service/src/production-observation.ts
- packages/application/src/services/ledger-observation.ts
- packages/persistence-sqlite/src/migrations/0074_ledger_observation.sql
- scripts/calibration-report/report.mjs
- scripts/delivery-mode/packet-template/s0-db/read-s0-db.mjs
-->

本手册说明 P0-8 的“连续运行验收”怎样做：带观察功能的版本上线以后，Andy 在网页上选数据起点，服务每天自己检查决策记录（数据库表 `decision_ledger`，记录 Himawari 每次拿主意的那张表）有没有正常写入，第 8 天出首份校准周报。决定和检查规则见 [ADR 0302](../adr/0302-decision-records-and-calibration.md)。本手册里的时间都是日本时间（JST）。

<a id="contents"></a>

## 阅读导航

- [适用范围](#scope)
- [权威来源](#authoritative-sources)
- [安全前提](#safety-and-preconditions)
- [目标现场只读检查](#live-state-preflight)
- [步骤](#procedure)
- [结果验证](#verification)
- [证据](#evidence)
- [回退](#rollback)
- [停止条件](#stop-conditions)
- [排障](#troubleshooting)

<a id="scope"></a>

## Scope

- 适用：带迁移 0074 的版本上线之后，开始观察期、每天查看检查结果、处理失败、在第 8 天确认首份校准周报。
- 不适用：上线和回滚本身（按 [交付模式](../../.agents/instructions/delivery-mode.md) 用 `scripts/delivery-mode/deploy.sh` 和 `rollback.sh`）；修改检查规则（改代码和 ADR）。
- 目标：生产机（Oracle 东京的 ARM 机）上的服务 `himawari-prod.service` 和数据库 `/var/lib/himawari/state/data/product.sqlite`；Andy 的生产网页。
- 观察期的检查是服务自己做的，本手册里的生产操作只有只读查看。唯一会改数据的一步是 Andy 在网页上设置数据起点，这一步只能由 Andy 本人做，而且只能做一次。

[↑ 回到阅读导航](#contents)

<a id="authoritative-sources"></a>

## Authoritative Sources

- 决定、检查项和门槛：[ADR 0302](../adr/0302-decision-records-and-calibration.md)。
- 检查规则代码：`packages/application/src/services/ledger-observation.ts`；服务定时任务：`apps/agent-service/src/production-observation.ts`；表结构：`packages/persistence-sqlite/src/migrations/0074_ledger_observation.sql`。
- 生产访问规则：[交付模式](../../.agents/instructions/delivery-mode.md)第 29 行（可以以 `root` 或 `himawari-prod` 登录读 `/var/lib/himawari`，不打印、不带出机密，不以生产账号跑测试）。
- 事故和门槛：`.claude/rules/incident-gates.md`、`docs/incidents-and-gates.md`。

[↑ 回到阅读导航](#contents)

<a id="safety-and-preconditions"></a>

## Safety and Preconditions

- 生产机的操作只能从 Andy 的 MacBook 上的 Remote Control 线程做；云端会话连不到生产机。
- 读数据库只用只读方式（`sqlite3 -readonly` 或 `better-sqlite3` 的 `readonly: true`），以 `himawari-prod` 身份运行。服务运行时数据库旁边已经有 `-wal`、`-shm` 两个附属文件，只读连接不会新建文件；如果这两个文件不在，停下，不要读（只读连接会自己建出附属文件且删不掉，见 `docs/lessons.md` 的 sidecar-reader-choice）。
- 数据起点：只能由 Andy 在网页的“校准周报”标签里设置，设置前网页会要求重新验证身份；数据库触发器拒绝直接修改和删除（只有删除 Agent 或整个账户时随之删除）。任何线程都不得直接写 `ledger_observation_start`、`ledger_observation_checks`、`observation_events`。
- 观察期内 Andy 可以清除 Gmail 记录；清除那天的检查会写明清除了多少行，不算失败。
- 不打印数据库里的正文、加密内容或配置里的机密；本手册的查询只读计数、日期、状态和原因代码。

[↑ 回到阅读导航](#contents)

<a id="live-state-preflight"></a>

## Live-State Preflight

在 Mac 线程里以只读方式执行，任何一项不符就停下：

1. `systemctl is-active himawari-prod.service` 为 `active`。
2. `ls -l /var/lib/himawari/state/data/` 能看到 `product.sqlite-wal` 和 `product.sqlite-shm`。
3. 以 `himawari-prod` 只读查询 `SELECT value FROM schema_metadata WHERE key='current_sequence'`，结果不小于 `74`。
4. 只读查询 `SELECT min(first_seen_at), max(last_seen_at), max(service_revision) FROM service_heartbeats`：有值，且最后一次心跳在 20 分钟以内。最早一次心跳就是新版本第一次启动的时间，数据起点最早是它的下一个日本时间日。
5. 只读查询 `SELECT occurred_at, detail FROM observation_events WHERE owner_id = 'owner:first-production' AND agent_id = 'agent:first-production' AND kind = 'state_snapshot'`：正好一条（服务第一次启动时写下的开关状态快照；生产的所有者和 Agent 编号见 `scripts/delivery-mode/packet-template/s0-db/read-s0-db.mjs` 的 `fixed`）。
6. 配置里的 `runPolicy.timeZone` 是 `Asia/Tokyo`（只读 `jq '.runPolicy.timeZone' /etc/himawari/config.json`，不输出其他字段）。
7. 只读查询 Gmail 提醒和记忆的当前状态：`SELECT enabled FROM proactive_settings`、`SELECT status FROM proactive_connections WHERE source='gmail'`、`SELECT capture_paused FROM memory_settings`。观察期要求 `enabled=1`、`status='connected'`、`capture_paused=0`；不满足时告诉 Andy，由他决定先打开再选起点，还是接受“受阻”。

[↑ 回到阅读导航](#contents)

<a id="procedure"></a>

## Procedure

1. 上线带迁移 0074 的版本（按交付模式），完成[目标现场只读检查](#live-state-preflight)，把第 4 步的最早心跳时间和版本号报告给 Andy。
2. Andy 在网页“校准周报”标签里选数据起点并确认。线程不代他设置。设置后只读查询 `SELECT start_day, set_at, service_revision, first_boot_at FROM ledger_observation_start`，把这四个值报告给 Andy，并写进本次的交付报告：这就是“起始日期与版本”的记录。
3. 观察期内每天（日本时间 1 点以后）查看网页上的 7 个格子，或只读查询 `SELECT day, status, checked_at FROM ledger_observation_checks ORDER BY day, checked_at`。每天的结果以每天最新的一条为准。
4. 某天是“失败”或“没有检查记录”：
   1. 打开那天的明细（网页或 `checks` 列），看是哪一项、原因代码是什么（见[排障](#troubleshooting)）。
   2. 按“修 bug 先查根因”处理：先写一个能复现的测试并证明它失败，修好，证明通过，按交付模式上线，在 `docs/incidents-and-gates.md` 加一行。
   3. 起点不动，失败那天的结果不删不改。修好后从下一天起重新数连续通过天数。
5. 某天是“受阻”：告诉 Andy 是哪个开关（Gmail 关掉、断开、记忆暂停、没配置 Gmail 提醒），由他决定是否打开。受阻不是故障，但会让连续通过天数归零。
6. 起点后第 8 天 0 点以后，网页上的校准周报出现比例，即“首份校准周报可生成”。把网页显示的窗口、各类决策的条数和比例记进交付报告。网页上另有“观察信号 · 不是打分”一节（提醒被点开、撤销、回复，见 [ADR 0302](../adr/0302-decision-records-and-calibration.md)），它只是观察，不进验收判断，交付报告里单独写，不和打分比例合并。
7. P0-8 验收通过 = 首份校准周报可生成，且网页显示“连续通过”达到 7 天。没达到时继续每天查看，直到达到。

[↑ 回到阅读导航](#contents)

<a id="verification"></a>

## Verification

- 起点：`ledger_observation_start` 正好一行，日期等于 Andy 选的日期，`first_boot_at` 等于最早心跳。
- 每天的检查：从起点到昨天的每一天都有至少一条结果；没有的那天网页显示“没有检查记录”。
- 首份校准周报：`proactive.weekly.read` 的返回里 `report.complete` 为真、`ratesWithheld` 为假。
- 验收：返回里 `observation.passStreak` 不小于 7，`observation.accepted` 为真。

[↑ 回到阅读导航](#contents)

<a id="evidence"></a>

## Evidence

- 权威证据是生产数据库里的四张表本身：起点和每天的结果都不能被修改或删除。
- 每次查看时，在交付报告里记下：查询的命令、得到的日期、状态和原因代码、服务版本。不复制数据库，不记正文、加密内容或机密。
- 首份校准周报的数字只记条数和比例。

[↑ 回到阅读导航](#contents)

<a id="rollback"></a>

## Rollback

- 观察期本身没有需要回退的操作：线程只做只读查看。
- 数据起点设错了不能改（这是要求）。如果 Andy 认定起点必须作废，停下，由他另行决定处理方式，并出新的 ADR；不得直接改表。
- 程序上的问题按交付模式回滚程序版本；回滚到不含迁移 0074 的旧版本前，先确认旧版本能接受 0074 之后的数据库（迁移引擎会拒绝过旧的写入程序，见 `assertWritableSchema`），不能时只能修了再上新版本。

[↑ 回到阅读导航](#contents)

<a id="stop-conditions"></a>

## Stop Conditions

- 只读检查任何一项不符。
- 数据库旁边缺 `-wal` 或 `-shm`。
- 需要写这四张表中的任何一张（除 Andy 在网页上设置起点外）。
- 发现检查结果被修改或删除过、或起点不止一行。
- 需要打印正文、加密内容或机密才能继续。

[↑ 回到阅读导航](#contents)

<a id="troubleshooting"></a>

## Troubleshooting

| 原因代码 | 含义 | 只读诊断 | 处理 |
| --- | --- | --- | --- |
| `service_running` / `hours_missing` | 当天缺了 2 个小时以上的心跳，服务停过 | `journalctl -u himawari-prod.service --since` 那天 | 查停服原因；是上线引起的，记事故并考虑上线时段 |
| `proactive_writing` / `gap_too_long` | Gmail 开着连着，但检查记录中间断档太久 | 那天 `decision_ledger` 里 `kind='proactive'` 的时间；服务日志 `proactive.failed` | 查定时器和 Gmail 读取失败 |
| `proactive_writing` / `switched_off`、`source_not_connected`、`not_configured`、`interval_too_long` | 受阻：Gmail 被关掉、断开、没配置，或检查间隔超过 1 小时 | `observation_events` 里那天的开关事件 | 告诉 Andy，由他决定 |
| `memory_capture` / `paused` | 受阻：当天暂停过自动记忆 | `observation_events` 里那天的 `memory_capture_paused` | 告诉 Andy，由他决定 |
| `proactive_writing` / `records_cleared` | 当天结束后、检查前清除过 Gmail 记录，当天的 Gmail 记录已无法判断，记为通过 | `observation_events` 里的 `proactive_records_cleared` | 无需处理 |
| `consolidation_recorded` / `run_failed` | 整理记忆失败 | `observation_events` 里 `consolidation_failed` 的 `errorCode`；服务日志 | 查失败原因 |
| `consolidation_recorded` / `run_stuck` | 整理卡在运行中超过 12 小时 | `memory_consolidation_runs` 那天的行 | 查服务是否在整理中途停掉 |
| `consolidation_recorded` / `rows_mismatch` | 整理改了 N 条记忆，决策记录不是 N 行 | `memory_consolidation_changes` 和 `decision_ledger` 里该批次的行数 | 这是决策记录漏写，按事故处理 |
| `rows_kept` / `rows_missing` | 之前检查过的某天某类决策行数变少，又没有清除 Gmail 记录 | 明细里的日期、类型、前后行数 | 查是什么删了行；这是数据丢失，按事故处理 |
| `time_format` / `malformed` | 有决策记录的时间格式不对 | 那天不符合格式的行数 | 查写入点 |
| 网页“没有检查记录” | 那天结束超过 1 小时仍没有结果 | 服务是否在跑；服务日志 `observation.failed` | 服务重启后会自动补查；补不上按事故处理 |

[↑ 回到阅读导航](#contents)
