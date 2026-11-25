# S7：第十二次变更（__PKT_LABEL__-__PKT_DATE_COMPACT__）的能力升级、服务切换与启动

本目录是第十二次变更（R2-L13）操作包的一部分，包还没有冻结，也没有在生产执行。冻结后由 Andy 运行 `scripts/delivery-mode/deploy.sh`，按[步骤入口](../steps/README.md)的顺序执行。第十二次的数据库结构版本（Schema，数据库表结构的编号）从头到尾都是 56，没有迁移。S7 分四步：

1. `S7_DB_STATUS`：只读核对数据库（Schema 56）、授权和能力登记，配置仍是原件。
2. `S7_CONFIG_APPLY`：把正式配置文件 `/etc/himawari/config.json` 里的 `http.staticRoot`（网页静态文件目录）改到第十二次的安装目录，数据库不升级（见[网页静态文件目录配置](#网页静态文件目录配置)和包的 [README](../README.md#数据库不升级)）。
3. `S7_CATALOG_UPGRADE`：服务停着时准备新快照，并用升级命令更新三个能力的登记。
4. `S7_SWITCH_START`：发布新 unit（systemd 系统服务定义文件）并正式启动一次。

它不新增 `enable`（设置开机自启），不重跑 `capabilities register` 命令，也不自动回退。

导航：[前置门槛](#前置门槛) · [网页静态文件目录配置](#网页静态文件目录配置) · [能力升级与配置切换](#能力升级与配置切换) · [执行命令](#执行命令) · [独立启动读回](#独立启动读回) · [失败与用户包装](#失败与用户包装) · [清理候选](#清理候选) · [包自带检查](#包自带检查)

## 前置门槛

`S7_DB_STATUS` 必须在配置保持原样时先完成。它以生产账号运行新版本的维护程序：

```bash
umask 022
/usr/sbin/runuser -u himawari-prod -- /usr/bin/env -i HOME=/var/lib/himawari/state PATH=/opt/himawari/node/bin:/usr/bin:/bin LANG=C.UTF-8 /opt/himawari/node/bin/node --no-global-search-paths /opt/himawari/operations/__PKT_LABEL__-__PKT_DATE_COMPACT__/maintenance/run-maintenance.mjs S7_DB_STATUS
```

这一步：

- 要求 `S3_COPY51` 的报告 passed，且报告里的绑定 SHA（`inputs/bindings.json` 的 SHA-256，即内容指纹）等于当前冻结绑定。第十二次没有跨绑定复用旧报告的例外：绑定里不能有 `retainedStepBindingSha256`；
- 检查 Schema current 和 minimum writer 都是 56、未解决的沙箱预留为零、没有未结束的 Run（一次对话运行）、历史表与 S3 复制后的读回 `s3-copy-after56.json` 相同；
- 读取升级前的授权和能力登记（`s7-preupgrade-authorization.json`，格式 `himawari.__PKT_LABEL__-change-preupgrade-authorization.v1`），要求配置 SHA 仍等于 S0（冻结前在生产机上做的只读读取）读到的原配置、三个能力的登记仍是 S0 读到的严格一致形状、授权和工作目录逐字等于 S0 冻结读回。

它保留 `s7_db_status-result.json`、`s7-preswitch-state.json` 和 `s7-preupgrade-authorization.json`。读取失败、表缺失、SQL 错误和身份不符均停止，不能当作零计数。若 Claude 的自动权限检查拒绝此步骤，由用户运行[数据库备用包装](../maintenance/run-user-maintenance.sh)的 `S7_DB_STATUS`，不要改权限或绕过检查。

S7 切换脚本（`S7_SWITCH_START`）在替换 unit 之前还要求：

- 服务 `inactive`、MainPID 0，unit 文件仍是 S0 读到的原件，Node 是锁定版本；
- 正式配置已经由 `S7_CONFIG_APPLY` 和 `S7_CATALOG_UPGRADE` 改过：与 S2 保存的 `original-config.json` 相比，只改了 `http.staticRoot`，并且 `capabilityDeployment` 已指向新快照，其他字段逐字相同；原配置 SHA 等于 S0 读到的摘要；绑定里没有 `configurationChange`；
- `S7_DB_STATUS`、`S7_CONFIG_APPLY` 和 `S7_CATALOG_UPGRADE` 三份报告都 passed、绑定 SHA 一致，报告引用的每份证据文件 SHA 不变；
- `s7-config-apply.json` 记录的配置前后 SHA 和字节数，与脚本自己按原配置算出的新配置一致；`s7-static-root-authorization.json` 里的授权等于 S0 冻结读回；
- 授权计划固定为 G90 的 `directory:himawari-prod-workspace-20261015`（目录 `/var/lib/himawari/workspace`，子目录 `files`、`repos`），原配置的编码路由指向它；目录当前的 device/inode、属主 __PKT_SERVICE_UID__:__PKT_SERVICE_GID__ 和权限 0700 等于 S0 冻结读回；
- 升级报告列出的能力正好是 S0 读回的三个能力；升级审计只在原有记录后追加三条 `owner.capability.upgrade`，每个能力一条；当前快照 SHA 与配置里的 `capabilityDeployment` 和升级报告一致；升级后的读回 `s7-catalog-after.json` 里授权和工作目录不变，每个能力都是 active、没有待定声明、登记等于快照声明；
- 切换前的读回 `s7-preswitch-state.json` 和升级后的读回 `s7-catalog-after56.json` 都是 Schema 56/56、门槛为零、没有未结束的 Run、部署租约等于绑定，两者历史表相同；升级后的状态读回 `s7-post-upgrade-state.json` 里 `integrityCheck` 和 `foreignKeys` 都是 ok、迁移记录 56 条、Schema 56/56；
- 完整 S6 验收报告（`cloud-__PKT_LABEL__-change`）及清理通过、一次服务环境真实 read 和独立清理通过、签名公开材料和新保护文件存在。

`bindings.json` 必须是 `frozen-approved`。S7 不修改该文件或冻结 SHA。新 pair supervisor（同时拉起并看管 Agent 和 Worker 两个进程的程序）放在 `/opt/himawari/operations/__PKT_LABEL__-__PKT_DATE_COMPACT__/pair-supervisor.mjs`；绑定里的 `service.pairSupervisor` 记的是 S0 读到的旧服务正在用的 `/opt/himawari/operations/__PKT_LABEL__-__PKT_DATE_COMPACT__/pair-supervisor.mjs`，不覆盖它。

[返回导航](#s7第十二次变更__PKT_LABEL__-__PKT_DATE_COMPACT__的能力升级服务切换与启动)

## 网页静态文件目录配置

`S7_CONFIG_APPLY` 在 `S7_DB_STATUS` 之后、服务仍停着时运行，由维护程序的 `applyStaticRootConfiguration` 完成：

```bash
umask 022
/usr/sbin/runuser -u himawari-prod -- /usr/bin/env -i HOME=/var/lib/himawari/state PATH=/opt/himawari/node/bin:/usr/bin:/bin LANG=C.UTF-8 /opt/himawari/node/bin/node --no-global-search-paths /opt/himawari/operations/__PKT_LABEL__-__PKT_DATE_COMPACT__/maintenance/run-maintenance.mjs S7_CONFIG_APPLY
```

它要求（缺一即停，不改配置）：`S7_DB_STATUS` 报告 passed、服务停着、当前配置的 SHA 等于 S0 读到的原配置、原配置里的 `http.staticRoot` 正是第十一次的 `/opt/himawari/releases/__PKT_DATE__-__PKT_LABEL__/share/control-center`、旁边没有 `config.json.next` 残留、新目录 `/opt/himawari/releases/__PKT_DATE__-__PKT_LABEL__/share/control-center/index.html` 是普通文件。

动作依次：

1. 在原配置上把 `http.staticRoot` 改成 `/opt/himawari/releases/__PKT_DATE__-__PKT_LABEL__/share/control-center`，其余字段和键的顺序不变，得到唯一允许的新配置。原配置里 `deepseek-primary` 不是正好一项、或窗口和输出长度不是 1000000 和 32768，以 `__PKT_LABEL_UPPER___MAINTENANCE_ORIGINAL_MODEL_DESCRIPTOR_CHANGED` 停止；原配置带 `budgets`，以 `__PKT_LABEL_UPPER___MAINTENANCE_ORIGINAL_BUDGETS_PRESENT` 停止；读网页上限不是 102400，以 `__PKT_LABEL_UPPER___MAINTENANCE_ORIGINAL_PUBLIC_FETCH_CHANGED` 停止；字节要等于绑定能算出的 SHA，否则以 `__PKT_LABEL_UPPER___MAINTENANCE_STATIC_ROOT_CONFIG_BYTES_CHANGED` 停止；
2. 以独占方式写 `/etc/himawari/config.json.next`（生产账号所有、权限 0600），读回字节一致；
3. 用新安装前缀里的配置解析器 `JsonFileConfigurationPort` 加载它，要求读出的 `http.staticRoot` 是新目录、主模型的窗口和输出长度仍是 1000000 和 32768、解析结果里没有 `budgets` 且读网页上限仍是 102400，否则分别以 `__PKT_LABEL_UPPER___MAINTENANCE_NEW_RUNTIME_REJECTED_STATIC_ROOT`、`__PKT_LABEL_UPPER___MAINTENANCE_NEW_RUNTIME_REJECTED_MODEL_LIMITS`、`__PKT_LABEL_UPPER___MAINTENANCE_NEW_RUNTIME_REJECTED_PUBLIC_FETCH` 停止并删掉 `.next`；
4. 通过后一次改名替换正式配置，再读回属主、权限 0600 和 SHA，并确认配置阶段是“静态目录已改、`capabilityDeployment` 未变”；
5. 再读一次升级前的授权和能力登记，要求其中的配置 SHA 等于新配置 SHA，保存为 `s7-static-root-authorization.json`；改动记录（路径、前后 SHA、字节数）保存为 `s7-config-apply.json`。
6. 数据库不升级（见包的 [README](../README.md#数据库不升级)），换配置后再读一次数据库，保存为 `s7-config-apply-after56.json`。

配置改完后，维护程序重新读回的“原配置”判断都改成：当前配置必须等于只改了上面第 1 条那些字段的原配置（再加上之后才会换的 `capabilityDeployment`），多出任何别的改动都拒绝。

`S7_CONFIG_APPLY` 成功后不能重跑：再运行会因“当前配置已不是原配置”以 `__PKT_LABEL_UPPER___MAINTENANCE_ORIGINAL_CONFIG_REQUIRED` 拒绝。在改名之前中断，配置仍是原件，留下的 `.next` 文件由下面的 S9 控制文件恢复处理（见 [S9 恢复](../maintenance/S9-rollback.md#控制文件恢复)）。

[返回导航](#s7第十二次变更__PKT_LABEL__-__PKT_DATE_COMPACT__的能力升级服务切换与启动)

## 能力升级与配置切换

这次要升级三个能力 `himawari.pi-coding`、`himawari.public-search`、`himawari.public-fetch`：都只换运行程序和运行目录，出网和密钥范围不变，审计动作都是 `owner.capability.upgrade`。不登记新能力。

搜索和读网页的执行绑定都用 `private_temp` 临时目录、运行方式 `network_only`（只联网，不读授权工作目录）；Pi 仍然读授权工作目录、不联网。工作目录、授权、启用的工具、批准方式、输出上限和系统提示沿用 S0 读到的值。

`S7_CATALOG_UPGRADE` 在 `S7_CONFIG_APPLY` 之后、服务仍停着时运行，依次：

1. 重新核对 S3 恢复点（`__PKT_LABEL__-__PKT_DATE_COMPACT__-raw-schema56`）仍能校验、数据库门槛为零、历史不变，保存升级前的能力登记 `s7-catalog-before.json`；要求三个能力仍是 S0 的登记。
2. 以生产账号经 `/usr/bin/setpriv --no-new-privs` 运行准备脚本 `cloud-protected-prepare.mjs --prepare /etc/himawari/config.json`（`--no-new-privs` 让进程不能再通过 setuid 程序提权；产品的运行保护核对要求准备脚本进程的 `NoNewPrivs` 为 1，见 `packages/platform-node/src/capabilities/protected-runtime.ts`，服务单元靠 `NoNewPrivileges=yes` 满足它，维护程序经 `runuser` 启动时没有这个标志，所以要显式加上）：核验本次签名和真实主机后，独占写入并改名发布新能力快照、写启动证明，最后才以一次改名切换配置里的 `capabilityDeployment`。运行前维护程序要求 `config.json.next` 和 `capability-deployment.json.next` 都不存在，否则以 `__PKT_LABEL_UPPER___MAINTENANCE_PREPARE_LEFTOVER_PRESENT` 拒绝。在最后这次改名之前中断，配置仍是只改了静态目录的原件。中断后不重跑 `S7_CATALOG_UPGRADE`：started 报告已存在，且 `.next` 残留会让它拒绝；留下的 `.next` 文件由 S9 控制文件恢复处理（见 [S9 恢复](../maintenance/S9-rollback.md#控制文件恢复)）。
3. 核对准备后的配置和快照 SHA。配置除 `capabilityDeployment` 外仍等于“按第 1 条改过的原配置”；每个能力的运行目录是新安装目录，操作、费用、权限引用和版本与快照一致；三个能力的范围、密钥引用和声明与登记除制品摘要外一致；待登记能力列表为空。
4. 运行 `himawari capabilities upgrade-plan --config /etc/himawari/config.json --reviewed`，核对计划的字段正好是 `current`、`planDigest`、`registrations`、`snapshotDigest`、`upgrades`：`current` 为空；`upgrades` 正好列出三个能力，来源和目标摘要、旧安装目录（`/opt/himawari/releases/__PKT_DATE__-__PKT_LABEL__/lib/himawari-agent`）和新安装目录（`/opt/himawari/releases/__PKT_DATE__-__PKT_LABEL__/lib/himawari-agent`）符合预期；每项都没有范围变化；`registrations` 为空。再运行 `himawari capabilities upgrade --config /etc/himawari/config.json --confirm <计划摘要> --reviewed`，要求结果的升级列表正好是三个能力、登记列表为空。`--reviewed` 是第十一次加入的选项（允许登记新能力和改范围）；第十二次仍带它，是因为维护代码按它的输出形状核对计划，计划里没有登记和范围变化，所以效果和普通升级相同。
5. 读回升级后的登记和数据库（`s7-catalog-after.json`、`s7-catalog-after56.json`），要求：三个能力的修订号各加 1、`integrity` 列等于新 runner、回退值是原来的摘要；三者登记都等于快照声明（严格检查）、历史不变；审计表在原有记录之后正好追加三条 `completed`；并写升级后状态读回 `s7-post-upgrade-state.json`。它不运行末尾的 `db status`，因此不会留下 `-wal`/`-shm` 附属文件。严格检查里“没有未撤销的执行句柄”（字段 `unrevokedHandles`，执行句柄是产品发给一次对话、允许它调用某个能力的凭据）只数状态仍为 `active` 的句柄：产品升级时只撤销 `active` 的句柄（`packages/persistence-sqlite/src/sqlite-durable-operations.ts` 的 `revokeCapabilityHandlesCore`），对话结束时句柄改成 `revoked`、用满次数时改成 `consumed`，这两种都不再能用，但 `revoked_at` 列为空。第五次曾按 `revoked_at` 为空计数，把已结束对话的句柄算成未撤销，升级本身已完成却读回失败；用户在 G134 批准改成现在的口径。第十二次沿用现在的口径。

快照与配置不是跨文件事务；任何一步失败都保持停服、保留现场。

### 从升级后的失败现场续做

`S7_CATALOG_UPGRADE` 开始时若配置已经是“已准备”状态（`capabilityDeployment` 已换成新快照），就不走上面的 5 步，而走续做分支。该机制由第五次的 G134 首次使用，第十二次保留代码；第十二次的包里没有现成的修订工具，真要续做，先由用户批准并另外准备。准备时要：把失败那次的 `s7_catalog_upgrade-started.json`、`s7_catalog_upgrade-failure.json` 移走存档；在证据根写 root:himawari-prod 0640 的续做批准文件 `s7-catalog-resume-approval.json`，里面记下绑定 SHA、准备后的配置和快照 SHA，以及原地保留的 4 份记录（`s7-catalog-before.json`、`s7-catalog-prepare-command.json`、`s7-catalog-plan-command.json`、`s7-catalog-upgrade-command.json`）的路径、SHA 和字节数。代码只接受批准文件里的 `failedCondition` 等于 `__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_DECLARATION_NOT_STRICT`（升级已完成、严格读回失败）；别的失败条件不能用这条路径续做。

续做分支不再运行准备脚本、`upgrade-plan` 和 `upgrade`，不写配置、快照、启动证明和数据库。它依次：

1. 要求 `S7_CONFIG_APPLY` 已通过，重新校验 S3 恢复点；读维护绑定时不要求还没产生的启动报告（准备后的配置、签名收据、运行目录摘要、快照和启动证明照常核验）。
2. 核对批准文件和 4 份记录逐字未变；升级前登记的配置 SHA 等于“按第 1 条改过的原配置”的 SHA、S0 读回 SHA 和授权与冻结读回相同；准备、计划、升级三条命令就是原路径会运行的命令（升级和计划命令都带 `--reviewed`），退出码为 0，空间采样没有错误；准备输出的快照摘要等于批准文件和现在的快照。
3. 用留存的计划输出重新做计划核对，要求升级结果等于计划；数据库门槛为零、历史等于 `s7-preswitch-state.json`；升级后的登记按上面第 4、5 步的严格检查读回。
4. 写 `s7-catalog-after.json`、`s7-catalog-after56.json`、`s7-post-upgrade-state.json` 和结果报告；结果报告里的 `catalogBefore`、`prepare`、`plan`、`upgrade` 指向原地保留的 4 份记录，所以 `S7_SWITCH_START` 的核对不需要改。

续做不再运行只读的 `upgrade-plan` 复核：这条命令会读快照，快照里的资格检查时间超过 5 分钟就以 `CAPABILITY_DEPLOYMENT_QUALIFICATION_STALE` 拒绝（`packages/platform-node/src/capabilities/capability-deployment.ts` 的 `CAPABILITY_DEPLOYMENT_MAX_QUALIFICATION_AGE_MS`），而生产上的准备已过去很久；启动时准备脚本会重新做资格检查。

[返回导航](#s7第十二次变更__PKT_LABEL__-__PKT_DATE_COMPACT__的能力升级服务切换与启动)

## 执行命令

冻结后经步骤入口 `S7_SWITCH_START` 以 root 执行：

```bash
/usr/bin/python3 -I /var/tmp/himawari-__PKT_LABEL__-__PKT_DATE_COMPACT__/packet/systemd/S7-switch-start-readback.py --approved-r2l13-__PKT_LABEL__-deployment-switch-start
```

脚本先核对冻结清单 `freeze-manifest.json` 的批准标识和全部冻结字节，以及[本目录 SHA 清单](OWNED-SHA256SUMS)，保存旧 unit 原字节和摘要，再发布新的操作辅助文件。它只替换 `/etc/systemd/system/himawari-prod.service` 这一个文件，执行 `daemon-reload`，独立读回 systemd 解析后的 User/Group、环境、安全属性、准备辅助程序、新安装目录和停止期限，然后执行一次 `start`。

[新 unit](himawari-prod.service.draft)使用新安装目录 `/opt/himawari/releases/__PKT_DATE__-__PKT_LABEL__` 和第十二次操作目录 `/opt/himawari/operations/__PKT_LABEL__-__PKT_DATE_COMPACT__`。正式启动时 `ExecStartPre`（服务启动前先运行的命令）再运行一次同一个准备脚本，重新核验签名和主机，重新发布快照和启动证明；服务随后按严格检查读取能力登记。冻结时把 unit 文件的 SHA 写进绑定的 `service.newUnitSha256`；S7 发布前核对它，S2 的只检查模式和 S9 控制文件恢复用它识别“已经换成新 unit”的状态。`UnsetEnvironment=TMPDIR` 保持主服务入口没有 TMPDIR。NoNewPrivileges、空 capability 集合、Restart on-failure、先 Worker 后 Agent 的启动顺序、先 Agent 后 Worker 的停止顺序、supervisor 30 秒与 unit 35 秒停止上限均保持。脚本要求本次初次启动没有自动重启；启动异常不能被自动重启掩盖。

[返回导航](#s7第十二次变更__PKT_LABEL__-__PKT_DATE_COMPACT__的能力升级服务切换与启动)

## 独立启动读回

[S7-startup-readback.mjs](S7-startup-readback.mjs)读取本次 systemd 启动的 JSON 日志、当前快照、配置、启动证明、当前部署租约、Agent 和 Worker 两份启动绑定、实际进程、执行 socket 和 HTTP 监听。它检查：

- `ExecStartPre` 在本次启动恰好产生一份 `installation-verified`，与启动证明、快照和安装回执的摘要一致；签名与真实主机核验都通过；快照里的每个能力（Pi、搜索、读网页三个）都有本次签名。
- 部署身份与 S0 一致，epoch（租约代数）等于绑定的 `authority.authorityEpoch`。正式启动领取新租约，启动后的 fencing token（防止旧进程继续写的递增编号）必须大于 S0 绑定的值，并与当前数据库、两个启动绑定和双方就绪日志完全相同。
- Worker 与 Agent 使用同一 worker 实例和启动身份；双方真实就绪，协议为 `execution.v2`，Worker 的适配器清单来自本次已核验的快照；Agent 使用正式 Pi 和 Memory 路径。
- 两个子进程实际 UID/GID 为 __PKT_SERVICE_UID__/__PKT_SERVICE_GID__，没有新权限和 capability；Node 和执行入口来自新运行时，父进程是本次的新 supervisor（`__PKT_LABEL__-__PKT_DATE_COMPACT__/pair-supervisor.mjs`）。
- HTTP 只监听配置中的本机地址，监听由当前 Agent 持有；执行 socket 为服务账号拥有的 0600 socket。外部监听、额外启动、错误、超时、心跳丢失等事件均拒绝。

Doctor（自检命令）实际有七个依赖键。已知 [BL-20261008-007](../../../../docs/backlog/BL-20261008-007-doctor-把-已-配-置-内-置-身.md) 只允许 `identity=unavailable` 且 `ready=false`；`authority`、`schema`、`sqlite`、`payload`、`worker`、`memory` 六项必须全部 `available`。[verify-doctor.mjs](verify-doctor.mjs) 独立检查输出，不能以一条 success 或 ActiveState 代替两进程检查。

成功后 root 写 `/var/lib/himawari/__PKT_LABEL__-__PKT_DATE_COMPACT__-evidence/s7-startup-verification.json`（root:himawari-prod 0640，格式 `himawari.__PKT_LABEL__-change-startup-verification.v1`）。报告必须有 `passed=true`、配置、快照、回执的 SHA、运行时摘要、`signatureVerified`、`liveHostVerified`、当前租约和 `currentEpoch`、`currentFencingToken`。S8 必须先读取这份报告，才在切换后的配置下做数据库读回。

S7 保留原始 stdout/stderr、启动日志、unit 前后属性、旧 unit 与编排回执。它不把配置、token、消息正文、工具结果或完整环境输出到聊天。S7 证明启动读回；它没有执行付费模型请求，所以读网页和 DeepSeek 能否真的返回结果，要靠之后的一次真实对话确认；它也没有验证 systemd 崩溃后自动重启。

[返回导航](#s7第十二次变更__PKT_LABEL__-__PKT_DATE_COMPACT__的能力升级服务切换与启动)

## 失败与用户包装

任一前检失败，脚本不会切换 unit。切换后失败，脚本停止本次新 unit，保留新 unit、配置、状态、日志和失败回执。它不恢复旧 unit，不启动旧版本，不继续 S8/S9，也不自动重试验收或工具 read。

若自动权限检查在执行前拒绝，用户在仓库根目录运行步骤入口，不产生另一套步骤：

```bash
bash <操作包目录>/steps/run-user-step.sh S7_DB_STATUS
bash <操作包目录>/steps/run-user-step.sh S7_CONFIG_APPLY
bash <操作包目录>/steps/run-user-step.sh S7_CATALOG_UPGRADE
bash <操作包目录>/steps/run-user-step.sh S7_SWITCH_START
```

后三条只适用于该步尚未开始的拒绝。`S7_CONFIG_APPLY` 已写入 started 报告，或 `S7_CATALOG_UPGRADE` 已写入 started 报告、准备脚本已运行，或 S7 已切换、启动后，任何失败都先报告用户并保留现场，不能重新执行；唯一例外是 `S7_CATALOG_UPGRADE` 在用户批准的准备完成、写入续做批准文件之后，按[从升级后的失败现场续做](#从升级后的失败现场续做)再运行一次。最后的真实聊天由用户另行执行。

[返回导航](#s7第十二次变更__PKT_LABEL__-__PKT_DATE_COMPACT__的能力升级服务切换与启动)

## 清理候选

S8 读回成功后，先保留全部原报告、状态读回、资源观察、日志、签署公开材料和恢复点。安全清理候选只包括本次运输目录里可重建的副本：`validation/source` 与完整依赖、`validation/ui-verified`、`input` 下已传输的候选包、源码 bundle 和整份依赖归档。清理由 `S9_TRANSPORT_PREFLIGHT` 和 `S9_TRANSPORT_APPLY` 按[固定清单](../install/S9-clean-transport.md)执行，这里不删除任何东西。

旧版本（`/opt/himawari/releases/__PKT_DATE__-__PKT_LABEL__`）和新版本（`/opt/himawari/releases/__PKT_DATE__-__PKT_LABEL__`）的正式安装、正式 state/jobs/secrets（包括 `deepseek-web` 密钥文件）、授权目录、签名密钥、公开验收材料、证据根、备份和恢复点不在清理候选中。失败现场不进入自动清理。恢复只按[维护恢复流程](../maintenance/S9-rollback.md)由 Andy 具体批准的路线手动执行；清理不会触发它。

[返回导航](#s7第十二次变更__PKT_LABEL__-__PKT_DATE_COMPACT__的能力升级服务切换与启动)

## 包自带检查

按用户决定 G180 的快速模式，第十二次不在 Hermes（用户的另一台 Linux 服务器）上跑 L2–L4 测试、不做整包演练，也不做“生产形状演练”。冻结前只运行包自带的检查：`systemd/fixtures/verify-doctor.test.mjs`（用锁定的 Node 检查 `verify-doctor.mjs` 对 Doctor 输出的判断）、`maintenance/verify-fixtures.mjs` 等固定样例检查、`inputs/check-packet-consistency.py` 和 `steps/verify-steps.py`。它们都没有执行固定生产目标的 S7 脚本。

因此第十二次的 `S7_CONFIG_APPLY` 和能力升级，第一次完整运行就在生产上；生产上的真实 systemd、AppArmor（Ubuntu 的程序访问限制）、UID __PKT_SERVICE_UID__ 和当前数据库状态，由 Andy 在批准后的冻结操作中检查，不能用任何固定样例的结果代替。

[返回导航](#s7第十二次变更__PKT_LABEL__-__PKT_DATE_COMPACT__的能力升级服务切换与启动)
