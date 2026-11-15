# S3–S8：停服后的数据库独立读回

本文说明第十二次变更（`__PKT_LABEL__-__PKT_DATE_COMPACT__`）里，每一步怎样在服务停着时单独读一遍生产数据库，并和前一步比较。数据库结构版本（Schema，数据库表结构的编号）从头到尾都是 56，没有迁移步骤。

实际执行器是 [run-maintenance.mjs](run-maintenance.mjs) 和 [maintenance-common.mjs](maintenance-common.mjs)。它们用安装里自带的 better-sqlite3（Node 使用 SQLite 数据库的驱动库）以只读、文件必须存在的方式打开生产数据库，设置并核对 `query_only=1`（连接只能读、不能写），在同一个读事务里读取。缺表、身份不符、行数不符都直接报错退出，不执行后续步骤。

维护程序自己只写证据文件，不改数据库内容。这次会改生产状态的只有三处：

- `S7_CONFIG_APPLY` 改正式配置文件 `/etc/himawari/config.json`（不是数据库），见 [S7 说明](../systemd/P9-switch-start-readback.md#网页静态文件目录配置)；
- `S7_CATALOG_UPGRADE` 里产品自己的 `himawari capabilities upgrade --reviewed` 命令改能力登记（数据库里记录每个能力版本和声明摘要的行）；
- 回退时的 `S9_RAW_RESTORE51` 放回恢复点（见 [S9 恢复说明](S9-rollback.md)）。

回退前整理附属文件的 `S9_SIDECAR_TIDY`（[附属文件整理](S9-rollback.md#附属文件整理)）只做文件层的 checkpoint（把 SQLite 预写日志里的内容合并回主库文件），不改逻辑内容。它的读法按附属文件情况选：处理前读回用宽松只读（`openReadonly`，不带 `immutable=1`），只有 `-shm` 时用 `immutable=1` 只读主库，而 `immutable=1` 看不到 `-wal` 里尚未合并的内容（见[读法选择](../../../../docs/lessons.md#sidecar-reader-choice)）；处理后读回用严格读法。`immutable=1` 只读依赖环境变量 `SQLITE_USE_URI=1`（better-sqlite3 首次打开数据库时按它调用 `sqlite3_config(SQLITE_CONFIG_URI, 1)`），由维护模块导入 [raw-copy-recovery.mjs](raw-copy-recovery.mjs) 时设置；因此调用方必须先导入维护模块、再打开任何数据库，`openImmutableReadonly` 打开前也显式断言它等于 `1`，否则以 `__PKT_LABEL_UPPER___SQLITE_URI_REQUIRED` 停止。

导航：[每步读什么、怎样比较](#每步读什么怎样比较) · [历史不变的比较链](#历史不变的比较链) · [为什么要求未结束的 Run 为 0](#为什么要求未结束的-run-为-0) · [S7 到 S9 的衔接](#s7-到-s9-的衔接) · [没有做的验证](#没有做的验证)

## 每步读什么、怎样比较

下表是每次读回的内容。维护程序核对全库；S3 到 S8 共用同一套读法。

| 读取内容 | 怎样比较 |
| --- | --- |
| Schema | 所有步骤（`S3_COPY51`、`S7_DB_STATUS`、`S7_CONFIG_APPLY`、`S7_CATALOG_UPGRADE`、`S8_READBACK`）都要求 `current` 和 `minimumWriter` 是 56，不满足就以 `__PKT_LABEL_UPPER___MAINTENANCE_EXPECTED56` 停止。迁移记录连续，逐项与安装里自带的迁移的序号、名称、阶段、摘要一致；`integrity_check` 为 ok，`foreign_key_check` 为空。 |
| 部署身份和租约 | 部署编号、属主、Agent 与 S0 一致；epoch（租约代数）不变；服务启动前读回时 fencing token（防止旧进程继续写的递增编号）等于 S0 绑定的值；S8 要求严格大于 S0，并等于启动报告和两份启动绑定里的值。S9 回退前读回只要求 epoch 不变、token 不小于 S0。 |
| 升级门 | 未解决的沙箱预约数必须是 0。 |
| 未结束的 Run | 状态不是 completed、failed、cancelled 的 Run（一次对话运行）数。S0 在服务运行时读取，只记录；`S3_COPY51`、`S7_DB_STATUS`、`S7_CONFIG_APPLY`、`S7_CATALOG_UPGRADE` 和 `S8_READBACK` 要求为 0。 |
| 历史表 | `runs`、`threads`、`thread_gateway_events`、`run_coordination_checkpoints`、`model_budget_accounts`、`model_budget_allocations`、`model_invocation_identities`、`run_payload_artifacts`、`capability_invocation_receipts`、`sandbox_execution_records`、`sandbox_release_receipts`、`sandbox_reservation_release_receipts` 这 12 张表各自的行数，以及按 rowid 排序后每行规范 JSON 的 SHA-256。不输出行内容。只在服务停着时比较，S8 不比。 |
| 能力登记 | 三个能力的登记记录、`integrity` 列、修订号和升级审计。升级前（`S7_DB_STATUS`、`S7_CONFIG_APPLY` 和 `S7_CATALOG_UPGRADE` 开始时）要求 `himawari.pi-coding`、`himawari.public-search`、`himawari.public-fetch` 仍是 S0 读到的严格一致形状。升级后要求三个能力的修订号各加 1、登记等于第十二次快照的声明；审计在原有记录后正好追加三条 `owner.capability.upgrade`，见 [能力登记与签署](../signing/catalog-binding-report.md#服务停着时的能力升级)。 |

`S7_CONFIG_APPLY` 改的是配置文件，不是数据库，所以它读回数据库只是为了证明改配置前后历史没有变。

[返回导航](#s3s8停服后的数据库独立读回)

## 历史不变的比较链

每一步的读回都和前一步比较“历史表”这一项：

1. `S3_COPY51` 复制前后相同：`s3-copy-before56.json`、`s3-copy-after56.json`。
2. `S7_DB_STATUS` 读到的状态 `s7-preswitch-state.json` 等于 `s3-copy-after56.json`。
3. `S7_CONFIG_APPLY` 改配置前再读一次，等于 `s7-preswitch-state.json`；它另外保存两份证据：`s7-config-apply.json`（配置改动前后的 SHA-256 和字节数）和 `s7-web-config-authorization.json`（新配置下的授权和能力登记读回）。
4. `S7_CATALOG_UPGRADE` 升级前等于 `s7-preswitch-state.json`，升级后读回 `s7-catalog-after56.json` 等于升级前。
5. `S8_READBACK` 只核对保存的 `s3-copy-after56.json` 和 `s7-catalog-after56.json` 两份读回相同（两份都是服务启动前读的）。它**不**拿启动后的生产库和 S3 的数据库副本逐行比较：新服务启动后会合法地改老行（例如结算模型预算、完成对话、清理到期的“想一想”对话），这些写入分不清是正常运行还是损坏。历史的保护全部放在服务停着的这几步：上面第 1 到 4 条，加上 S7 切换脚本在换服务定义、启动新版本之前再比一次（`SWITCH_HISTORY_CHANGED`），以及出包时对迁移改历史表的拒绝（`PACKET_MIGRATION_TOUCHES_PRESERVED_TABLES`）。S9 恢复后和 S3 读回的历史比较照常进行。决定见 [ADR 0279](../../../../docs/adr/0279-history-is-compared-only-while-the-service-is-stopped.md)。

能力登记和升级审计不在这 12 张表里，所以升级不影响历史比较；它们另有各自的前后检查（见上表“能力登记”一行）。

[返回导航](#s3s8停服后的数据库独立读回)

## 为什么要求未结束的 Run 为 0

服务启动时会接着处理未结束的 Run（例如把中断的 Run 判为失败），这会改写 `runs` 等历史表。`S3_COPY51` 在复制恢复点之前检查这一项，若有未结束的 Run 就停下：服务保持停止，不做任何数据改动，由用户决定怎样处理那个 Run。这样停服后的几次整表摘要比较就不会被启动恢复逻辑之外的 Run 状态影响；启动之后服务自己的写入（包括启动恢复改写 `sandbox_execution_records.recovery_json`）不再进入历史比较。

[返回导航](#s3s8停服后的数据库独立读回)

## S7 到 S9 的衔接

- `S7_DB_STATUS` 在配置仍是原件、服务停着时运行（详见 [S7 说明](../systemd/P9-switch-start-readback.md#前置门槛)）：数据库已经是 Schema 56，它读取升级前的授权和能力登记，要求配置 SHA 等于 S0、授权和工作目录逐字等于 S0 冻结读回。
- `S7_CONFIG_APPLY` 随后把配置里的 `http.staticRoot` 改到第十二次的安装目录，并改主模型窗口、输出长度和六个预算额度（见 [S7 说明](../systemd/P9-switch-start-readback.md#网页静态文件目录配置)）。
- `S7_CATALOG_UPGRADE` 要求数据库是 56、配置已改好静态目录。它升级后不再运行 `db status`，不会留下 `-wal`/`-shm` 附属文件，见 [能力升级与配置切换](../systemd/P9-switch-start-readback.md#能力升级与配置切换)。
- `S8_READBACK` 在服务启动后运行：要求当前租约、S7 root 启动报告和两份启动绑定一致，Schema 56，历史表不再和 S3 副本比较（见[历史不变的比较链](#历史不变的比较链)第 5 条），三个能力的登记按严格检查等于快照声明且与升级后读回相同，授权在切换后的真实配置下仍有效，S3 的 Schema 56 恢复点（`__PKT_LABEL__-__PKT_DATE_COMPACT__-raw-schema56`）仍可核验。它有[用户备用包装](run-user-maintenance.sh)，命令是该脚本加同名动作。
- S9 恢复只在用户具体批准后手动执行，见 [S9 恢复说明](S9-rollback.md)：它读取已停止的当前状态（Schema 56），要求同一 epoch、fencing token 不小于 S0，先把当前数据原样保存一份，再按 S3 的 Schema 56 恢复点恢复，恢复后与 S3 读回比较，能力登记随之回到 S0 的样子（三个能力都回到第十一次的登记）。回退前若数据库旁留有 `-wal`/`-shm`，先用生产账号运行 `S9_SIDECAR_TIDY` 整理，它用宽松只读前读和严格后读、以 SQLite checkpoint 收尾，不删文件、不改内容；整理失败即停。S9 恢复不能当作 S8 启动验收。

S6 的服务环境 read 是独立的启动前探针，不进入生产 Run，不需要模型请求。用户的 S10 付费对话才是真实聊天验收。数据库没有新增行不能证明外部模型服务没有收到请求。

[门禁 SQL](read-upgrade-gate.sql) 只作审阅参考；冻结动作使用参数绑定、逐项检查并在首个错误处退出的 Node 助手，不直接运行 SQL 参考文件。

[返回导航](#s3s8停服后的数据库独立读回)

## 没有做的验证

按用户决定 G180 的快速模式，第十二次不在 Hermes（用户的另一台 Linux 服务器）上跑 L2–L4 测试、不做整包演练。包内只有固定样例检查（例如 [verify-fixtures.mjs](verify-fixtures.mjs)、[verify-raw-copy-fixtures.mjs](verify-raw-copy-fixtures.mjs)、[verify-sidecar-tidy-fixtures.mjs](verify-sidecar-tidy-fixtures.mjs)），它们用做出来的数据检查读回逻辑，不能证明这些步骤在真实生产数据库上通过。第十二次的 `S7_CONFIG_APPLY` 和能力升级，第一次完整运行就在生产上。

[返回导航](#s3s8停服后的数据库独立读回)
