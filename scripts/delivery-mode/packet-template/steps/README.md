# 第十二次变更的逐步执行入口

本目录是第十二次生产变更（`__PKT_LABEL__-__PKT_DATE_COMPACT__`）每一步的统一入口。它沿用前几次在生产上用过的逐步执行检查，只把路径、批准参数和步骤换成第十二次的流程。这次变更要做的事见包的 [README.md](../README.md)：把代码换到候选提交 `__PKT_COMMIT8__`，数据库结构版本（Schema，数据库表结构的编号）保持 56、没有迁移；`S7_CONFIG_APPLY` 把配置里的 `http.staticRoot`（网页静态文件目录）改到第十二次的版本目录，并把主模型窗口改成 1000000、输出长度改成 32768、六个预算额度都改成 1000000000000000；在服务停着时用能力升级命令把 `himawari.pi-coding`、`himawari.public-search`、`himawari.public-fetch` 三个能力都只换运行程序，更新到第十二次快照。工作目录 `/var/lib/himawari/workspace` 和它的授权 `directory:himawari-prod-workspace-20261015` 保持不变。

目前包还没有冻结（没有冻结清单 `freeze-manifest.json`），本目录的代码存在不代表已经在生产上执行；整个包要等冻结后，由 Andy 按用户决定 G180 运行。按 G180 的快速模式（`DELIVERY_MODE=fast`，ADR 0073），第十二次不在 Hermes（用户的另一台 Linux 服务器）上跑 L2–L4 测试，也不做整包演练。

导航：[用户入口](#用户入口) · [每步的检查](#每步的检查) · [S1 传输与安装](#s1-传输与安装) · [动作表](#动作表) · [包自带检查](#包自带检查)

## 用户入口

整套自动流程由 Andy 在 Mac 的仓库根目录运行 `bash scripts/delivery-mode/deploy.sh <操作包目录>`，它依次运行下面各步，遇到第一个失败就停，并打印 `DEPLOY_STOPPED_AT <步骤名> exit=<退出码>`：

`S1_TRANSPORT` → `S1_INSTALL` → `S2_STOP` → `S3_COPY51` → `S6_ACCEPTANCE` → `S6_PUBLISH_MATERIALS` → `S6_FINALIZE_BINDINGS` → `S6_SIGN` → `S6_RUNTIME_PROTECTION` → `S6_READ` → `S7_DB_STATUS` → `S7_CONFIG_APPLY` → `S7_CATALOG_UPGRADE` → `S7_SWITCH_START` → `S8_READBACK`

需要单独运行一步时（例如某一步被拒绝后重试），在仓库根目录逐步运行，每次一个动作：

```sh
bash <操作包目录>/steps/run-user-step.sh <动作>
```

`deploy.sh` 也是对每一步调用这个逐步脚本。`deploy.sh` 先在本地运行 `inputs/check-packet-consistency.py`（包自带的一致性检查脚本）核对包内的清单、摘要和身份字段（云端验收输入清单、各目录的 `OWNED-SHA256SUMS`、探针脚本写死的摘要等），不通过就不连接服务器。随后本地转交 [run-user-step.sh](run-user-step.sh) 和 [run-local-step.py](run-local-step.py)；`run-local-step.py` 调用 [packet-common.py](packet-common.py) 的 `verify_frozen` 核对冻结清单：读取 `freeze-manifest.json` 和 `inputs/bindings.json`，要求批准引用一致，清单列出的每个文件的字节数和 SHA-256（由文件内容算出的固定长度指纹，内容变一个字节指纹就变）都必须一致，且包内不能多出文件（例如 macOS 生成的 `._*` 或 `.DS_Store`），不一致就不连接服务器。唯一不算包内容的是包根目录下的 `run-logs/`：`deploy.sh` 在冻结之后把终端输出写进这里，S1 传输也只发送冻结清单列出的文件。然后它经 SSH（加密的远程登录）连接 `root@__PKT_ADDRESS__`，在远端先核对主机名是 `__PKT_HOSTNAME__`、用户是 root、远端冻结清单 SHA 和入口脚本 SHA，再执行。

每次运行在 `.ci-output/production/__PKT_DATE__-__PKT_LABEL__-change-execution-01/` 留下完整终端输出（`<动作>.<时间>.console.txt`）和回执（`<动作>.<时间>.json`，记录命令、退出码、本地冻结 SHA 和入口 SHA）。包装原样返回远端退出码；非零就停下，不运行下一步。

[返回导航](#第十二次变更的逐步执行入口)

## 每步的检查

S1 之后的动作都由 [run-step.py](run-step.py) 在服务器上以 root 执行。它要求：

- 参数是 `--approved-r2l13-__PKT_LABEL__-step <动作> <冻结 SHA>`，用 `/usr/bin/python3 -I` 运行，主机名 `__PKT_HOSTNAME__`，生产账号 `himawari-prod` 仍是 uid __PKT_SERVICE_UID__、gid __PKT_SERVICE_GID__。
- 运输目录 `/var/tmp/himawari-__PKT_LABEL__-__PKT_DATE_COMPACT__/packet` 的冻结清单 SHA 与参数相同，清单内每个文件字节不变，批准引用是 `round2/R2-L13/__PKT_LABEL__-__PKT_DATE_COMPACT__/reviewed`。
- 操作目录 `/opt/himawari/operations/__PKT_LABEL__-__PKT_DATE_COMPACT__` 里由 S1 发布的每个文件仍与冻结包一致。
- S1 报告 `s1-result.json` 存在且 passed。
- 除 `S2_STOP`、`S8_READBACK` 和 S9 传输清理外，服务必须是 inactive（systemd 报告的“未运行”状态）、MainPID 0（主进程号为 0，即没有主进程）。

每次执行在证据根 `/var/lib/himawari/__PKT_LABEL__-__PKT_DATE_COMPACT__-evidence` 独占写入 `step-<动作>-<时间>-started.json`、标准输出、标准错误和 `-result.json`。共用的文件检查函数在 [packet-common.py](packet-common.py)。维护类动作（`S3_COPY51`、`S7_DB_STATUS`、`S7_CONFIG_APPLY`、`S7_CATALOG_UPGRADE`、`S8_READBACK`、`S9_SIDECAR_TIDY`、`S9_RAW_RESTORE51`）以生产账号 `himawari-prod` 运行 `maintenance/run-maintenance.mjs`。

[返回导航](#第十二次变更的逐步执行入口)

## S1 传输与安装

`S1_TRANSPORT` 把整个冻结包（含 `materials/` 里的候选包和依赖）按清单顺序打成 tar 流（把多个文件连成一个字节流的归档格式），经 SSH 标准输入发给服务器。服务器上不预置脚本：包装把本地冻结的 [packet-common.py](packet-common.py) 和 [transport-packet.py](transport-packet.py) 代码随命令一起发送。接收端：

- 第一个成员必须是冻结清单，且 SHA 等于参数；
- 独占新建 `/var/tmp/__PKT_LABEL__-packet-upload/__PKT_DATE__-__PKT_LABEL__-change-packet-01`（root:0700，父目录也必须是 root:0700）；目录已存在就拒绝；
- 每个文件边写边算 SHA，字节数和 SHA 与清单不符、多出成员、重复成员、路径越界或缺成员都失败；
- 依赖缓存：包参数 `MATERIAL_CACHE_JSON`（来自实例文件的 `materialCache`）不为空时，包装先经 SSH 只读查一次服务器上的 `/opt/himawari/material-cache/sha256/<SHA>` 里有哪些不小于 `minBytes` 的成员，tar 流里不再放这些成员，并把它们的路径作为命令最后一个参数告诉接收端。接收端只允许这些成员不在流里：从缓存逐个核对大小和 SHA 后复制进上传目录，核对不符就把这条缓存删掉并失败，下次自动整包传；没声明的缺成员照旧失败。传完后把不小于 `minBytes` 的成员存进缓存（root:0700 目录，0600 文件），总量超过 `maxBytes` 时先删本次没用到的最旧条目。缓存目录不安全或建不起来时，整包传输照常进行，只是不读也不写缓存；缓存里已有、但查询不会报命中的条目（权限、属主、大小不对或是目录），本次包里有同名成员的传完后被替换，其余的在超出 `maxBytes` 修剪时照常删掉；锁文件 `lock` 不是普通文件时先删掉再新建；
- 写完后重新读回整个目录，确认与清单完全一致；
- 在父目录留下 `transport-<时间>-started.json` 和 `-result.json`。失败时保留不完整目录供检查，不自动删除。

`S1_INSTALL` 核对上传目录的冻结清单和 S1 脚本 SHA 后，运行 [S1 发布并安装](../install/S1-publish-and-install.py)。S1 把冻结包复制到运输目录，发布操作目录（包括本目录 `steps/`），建立证据根，并安装新版本到 `/opt/himawari/releases/__PKT_DATE__-__PKT_LABEL__`。第十一次的版本目录 `/opt/himawari/releases/__PKT_DATE__-__PKT_LABEL__` 保留用于回退。它不改当前配置、数据库或 unit，服务仍在运行。

第十二次的 S1 还没有在生产上执行过，包内也没有为第十二次准备“冻结后修订包”的工具。如果冻结并执行 S1 之后发现包要修改，先停下报告，由用户决定怎么处理，不套用其他次变更的修订工具。

[返回导航](#第十二次变更的逐步执行入口)

## 动作表

前十五行就是 `deploy.sh` 的顺序；`S2_INSPECT` 和各个 `S9_*` 动作不在自动流程里，只在需要时单独运行。

| 动作 | 效果 |
| --- | --- |
| `S1_TRANSPORT` | 传输整个冻结包到独占上传目录并读回。 |
| `S1_INSTALL` | 发布运输目录、操作目录和证据根，安装新版本。 |
| `S2_STOP` | 保存原配置、unit（systemd 系统服务定义文件）、快照和启动证明，停止第十一次部署的服务，确认没有残留的服务进程。 |
| `S3_COPY51` | 以生产账号持锁原样复制 Schema 56 数据库和加密 Payload（加密保存的对话内容文件），作为唯一恢复点 `__PKT_LABEL__-__PKT_DATE_COMPACT__-raw-schema56`；证据是 `s3-copy-before56.json` 和 `s3-copy-after56.json`。 |
| `S6_ACCEPTANCE` | 有限主机验收：专用普通账号、新虚构工作区、临时数据；范围和限制同前几次，覆盖三个能力（Pi、搜索、读网页）。需要用户对第十二次的批准（G180）。 |
| `S6_PUBLISH_MATERIALS` | 发布验收材料和签署辅助文件。 |
| `S6_FINALIZE_BINDINGS` | 按实际验收读回生成签署输入。 |
| `S6_SIGN` | 用首次部署的同一签署身份签新版本。 |
| `S6_RUNTIME_PROTECTION` | 发布新的运行保护文件和运行时指纹缓存（`runtime-fingerprints.json`，root 属主、权限 0644，没产出就失败）。 |
| `S6_READ` | 与正式服务相同身份和环境下读一次虚构文件，不付费。 |
| `S7_DB_STATUS` | 新版本的维护程序只读读取数据库：要求 `S3_COPY51` 的报告 passed 且绑定摘要等于当前冻结绑定；Schema 56、没有未结束的 Run、历史与 S3 复制后相同；读取升级前的授权和能力登记（要求三个能力仍是 S0 读到的严格一致状态），配置 SHA 仍是 S0 读到的原配置。见 [S7 说明](../systemd/P9-switch-start-readback.md#前置门槛)。 |
| `S7_CONFIG_APPLY` | 服务停着时：要求 `S7_DB_STATUS` 已通过、当前配置等于原配置；在 `/etc/himawari/config.json.next`（权限 0600）写出只改了 `http.staticRoot` 的新配置，先用新版本的配置解析器检查（静态目录是新值、文件和解析结果里都没有 `budgets`），通过后改名替换，再读回核对；数据库不升级，换配置后再读一次，要求 Schema 56、历史表与换配置前完全一样（`s7-config-apply-after56.json`）。见 [S7 说明](../systemd/P9-switch-start-readback.md)。 |
| `S7_CATALOG_UPGRADE` | 服务停着时：要求 `S7_CONFIG_APPLY` 已通过；运行准备脚本（写第十二次快照、启动证明、最后切换配置里的 `capabilityDeployment`），再运行 `himawari capabilities upgrade-plan --reviewed` 和 `upgrade --confirm <计划摘要> --reviewed`：三个能力都只换运行程序，审计动作都是 `owner.capability.upgrade`。读回核对并写入 `s7-post-upgrade-state.json`（Schema 56，升级后读回 `s7-catalog-after56.json`）；不运行末尾的 `db status`，因此不会留下 `-wal`/`-shm` 附属文件。见 [S7 说明](../systemd/P9-switch-start-readback.md#能力升级与配置切换)。配置已准备过时改走续做分支，只读回、不重复升级，见 [从升级后的失败现场续做](../systemd/P9-switch-start-readback.md#从升级后的失败现场续做)。 |
| `S7_SWITCH_START` | 核对 S6、`S7_DB_STATUS`、`S7_CONFIG_APPLY` 和 `S7_CATALOG_UPGRADE` 的报告后，切换 unit 并启动；要求配置只比原配置改了 `S7_CONFIG_APPLY` 的那些字段和 `capabilityDeployment`。启动前的准备脚本再按严格检查读回启动绑定。 |
| `S8_READBACK` | 启动后数据库读回：Schema 56；S3 读回和 S7 读回的历史摘要相同（历史数据只在服务停着时比较，启动后不再逐行比较；见 ADR 0279），三个能力的登记等于快照声明、授权不变、S3 的 Schema 56 恢复点仍能校验。 |
| `S2_INSPECT` | 只检查服务和进程是否都已停止，不停服、不删锁。S9 恢复控制文件前会自动调用。 |
| `S9_SIDECAR_TIDY` | 仅在需要回退且数据库旁边留有 `-wal`/`-shm`（SQLite 的预写日志和共享内存文件）时，在 S9 回滚前以生产账号整理这两个附属文件；不删文件、不改数据，见 [附属文件整理](../maintenance/S9-rollback.md#附属文件整理)。 |
| `S9_RAW_RESTORE51` | 仅在 Andy 具体批准后：先把当前数据（Schema 56）另存一份，再放回 S3 原样数据，能力登记随之回到 S0 的样子，见 [S9 恢复](../maintenance/S9-rollback.md)。 |
| `S9_RAW_CONTROL51` | 仅在数据库恢复成功后：恢复第十一次部署的配置、unit、快照和启动证明，删除 `S7_CONFIG_APPLY` 或准备脚本中断时留下的 `.next` 临时文件；工作目录和授权不动。 |
| `S9_TRANSPORT_PREFLIGHT`、`S9_TRANSPORT_APPLY` | 部署成功后清理临时传输材料，先预检再执行。 |

不在表里的动作（例如第六次的 `S3_COPY50`、`S7_MIGRATE51`、`S9_RAW_RESTORE50`、`S9_RAW_CONTROL50`，以及更早几次的 `S5_*`、`S4_*`）都会被拒绝，错误码 `__PKT_LABEL_UPPER___STEP_ACTION_INVALID`（维护类动作在 `run-maintenance.mjs` 里被拒绝时打印 `__PKT_LABEL_UPPER___MAINTENANCE_ARGUMENT_INVALID`）。

[返回导航](#第十二次变更的逐步执行入口)

## 包自带检查

[verify-steps.py](verify-steps.py) 是一个固定样例检查，不是整包演练。它要求在主机名为 `hermes-home` 的 Hermes 上用普通账号运行，参数是 10 字节的私有临时目录。它用一个假的 `ssh` 程序记录命令和标准输入，不连网络，检查：动作映射、拒绝未批准动作、退出码保留、远端 SHA 检查内容、S1 传输流内容，以及接收端对改字节、多成员、缺成员、重复成员、路径越界、错误冻结 SHA、目标已存在、父目录权限不安全的拒绝；还检查本地冻结核对只忽略包根目录下的 `run-logs/`，其他位置的 `run-logs/` 或多出的文件仍被拒绝；依赖缓存一组：存入缓存、从缓存补上声明的成员并照旧整体核对、没声明或没冻结的缺成员被拒绝、改过或是符号链接的缓存条目被删掉并失败、权限不对或是目录的条目被下次整包传输替换、超上限时修剪、缓存目录不安全或建不起来时整包传输照常、接收端核对缓存指令、本地一侧读包参数里的 `MATERIAL_CACHE_JSON` 并把命中的成员留在流外。

这个检查不运行任何一个生产步骤，所以 `S7_CONFIG_APPLY` 和能力升级，第一次完整运行就在生产上。

[返回导航](#第十二次变更的逐步执行入口)
