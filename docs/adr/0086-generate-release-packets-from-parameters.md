---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-26"
covers: ".agents/instructions/delivery-mode.md, packages/persistence-sqlite/src/migration-engine.ts, scripts/delivery-mode/deploy.sh, scripts/delivery-mode/make-packet.py, scripts/delivery-mode/run-packet-checks.py, scripts/delivery-mode/test_make_packet.py, scripts/operations/workspace-lifecycle-audit.mjs"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0086：上线操作包由仓库里的生成器按参数生成，不再复制上一次的再手改

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

操作包是一次生产上线要用的整套固定脚本、输入和材料（约 146 个文件），由 `scripts/delivery-mode/deploy.sh` 执行，失败时由 `rollback.sh` 回退（[ADR 0074](0074-claude-runs-production-deployments.md)）。到 2026-10-26 为止，每一次的操作包都是复制上一次的，再逐处手改“第几次”、版本目录、数据库版本号、配置预期和材料摘要。生成和检查它的工具放在 Mac 和 Hermes（测试机）上被 git 忽略的 `.ci-output/` 里，不在仓库中。

这样做已经让生产停服出事三次以上，都记在 [lessons：复制上一次操作包时留下旧文件和旧文件名](../lessons.md#copied-packet-stale-names)：

- 第十次上线第四次尝试：切换脚本还读第九次的文件名 s7-catalog-after51.json，停服约 17 分钟后自动回退。
- 第十二次上线第一次尝试：切换脚本 `systemd/S7-switch-start-readback.py` 还按第十一次之前的配置核对，要求原配置的读网页上限是 32768，停服后报 `TWELFTH_SWITCH_ORIGINAL_PUBLIC_FETCH_CHANGED`；回退脚本又按数据库版本号拼错步骤名，服务停了约 15 分钟（[工程案例集案例 20](../engineering-casebook.md#case-eleventh-twelfth-deploy)）。
- 本次搬进仓库时又发现一处：操作包里带的 `scripts/operations/workspace-lifecycle-audit.mjs` 副本只认到数据库第 56 版，`main` 上的同名文件已改成认 57 版（提交 `bfa6162`）。下一次照旧复制，第十三次升库到 57 版时就会在停服后失败。

此外，2026-10-26T11:25Z Andy 说：“这个时间也太长了吧？还能加快吗？因为我希望的是快速迭代上线验证。”当时出包约 49 分钟到 1 小时，第十二次第二次尝试停服约 11 分钟，其中停服后的验收 `S6_ACCEPTANCE` 占 6 分 45 秒（[案例 20 的结果数据](../engineering-casebook.md#case-eleventh-twelfth-deploy)）。

线程提出“全做”方案，2026-10-26T12:55Z Andy 在决定卡片上选了“全做（推荐）”。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **模板和生成器进仓库。** 第十二次冻结的操作包改写成模板 `scripts/delivery-mode/packet-template/`：凡是随每次上线变化的值都换成 `__PKT_名字__` 占位（例如 `__PKT_LABEL__` 是“第几次”的英文序数词，`__PKT_CURRENT_SCHEMA__` 是生产数据库版本），文件名里的也一样。生成器是 `scripts/delivery-mode/make-packet.py`。渲染时缺参数或留下没替换的占位，都拒绝出包（`PACKET_PARAMETER_MISSING`）。操作包的格式、`deploy.sh` 和 `rollback.sh` 的用法都不变。
2. **只有真正要人决定的事作为输入。** 输入只有三样：上线哪个提交（默认 `origin/main`）、给哪个实例上线（实例文件 `scripts/delivery-mode/instances/<名字>.json`，写主机、固定路径和这次要设成的模型上限、读网页上限），以及可选的日期。其余全部推出来：
   - “第几次”取生产机服务单元里正在运行的那一次，加一。
   - 原配置的模型上限和读网页上限，从生产机只读读出（不读、不打印任何密钥）。
   - 生产数据库版本从生产的只读 S0 读回取；代码的数据库版本从这个提交的迁移文件取，要求编号从 1 连续。
   - 安装包、源码包、依赖材料的摘要和大小，从 Hermes 上对这个提交的构建结果算出。
   - 操作包里带的仓库文件副本（例如上面的 `workspace-lifecycle-audit.mjs`）按这个提交自动刷新；改过的适配副本和这个提交对不上时拒绝出包（`PACKET_ADAPTER_SOURCE_CHANGED`）。
3. **数据库升级由模板通用处理。** 代码版本比生产高时，生成器从这个提交的 `packages/persistence-sqlite/src/migration-engine.ts` 取出要补的每一步迁移（编号、名字、阶段），写进 `maintenance/maintenance-common.mjs`。`S7_CONFIG_APPLY` 换完配置后用新版本的 `himawari db migrate` 升库，再要求历史表、能力目录、授权和释放回执的内容不变、迁移记录正好多出这几步。迁移文件如果改写这些要保留的表（例如给历史表加列），出包时就拒绝（`PACKET_MIGRATION_TOUCHES_PRESERVED_TABLES`），因为那需要人另外设计核对方法。例外有两个。第一个例外是 `0083_model_invocation_owner_lost.sql`：它去掉首尾空白后的内容摘要和 `make-packet.py` 里 `ROW_PRESERVING_REBUILDS` 记的一致，且只对 `model_budget_allocations`、`model_invocation_identities` 做“存一份、删除、重建、原样插回”，摘要对不上就仍然拒绝；替代核对是停服时的历史表比较（S3、S7 和切换脚本启动前；S8 启动后的逐行比较已由 [ADR 0279](0279-history-is-compared-only-while-the-service-is-stopped.md) 取消）。`onDeployFailure` 为 `rollback` 时由 `deploy.sh` 回滚；为 `keep` 时不自动回滚，靠 S3 的恢复点和人工运行 `rollback.sh`。第二个例外是 `20261115045512_thread_origin.sql`：它给 `threads` 加 `origin` 列并回填，内容摘要必须和 `make-packet.py` 里 `ADDED_COLUMN_BACKFILLS` 记的一致，且这一表一列在 `maintenance-common.mjs` 的 `addedColumnBackfills` 登记过；只有本包要补的迁移里有它时，这次上线停服时的历史比较（S3、S7）才不比 `threads.origin`，之后的上线照常比较。回退仍恢复停服后立刻做的原版本数据库副本。
4. **所有检查在出包时跑，不过就不出包。** `scripts/delivery-mode/run-packet-checks.py` 在 Hermes 上并行跑操作包里的 16 个夹具和一致性检查；要升库时多跑一个 `maintenance/verify-migrate-fixtures.mjs`，用这个提交装出来的 `himawari db migrate` 把一个真实的旧版本数据库升到新版本。任何一项不过，生成器拒绝出包。结果写进操作包的 `packet-checks.json`。
5. **上线脚本只接受生成器出的包。** `deploy.sh` 先运行 `generated-packet-gate.py`：操作包里没有 `packet-parameters.json`，或 `packet-checks.json` 没记全部检查通过、提交对不上，就以退出码 6 停下，结果为 `not-generated`，生产机上什么都不动。`rollback.sh` 不受这道检查限制，因为回退要先恢复服务。
6. **冻结紧挨着上线。** `make-packet.py prepare` 出包的最后一步冻结；离上线时间长了，先运行 `make-packet.py freeze <操作包目录>` 重新冻结（只重新读 S0 并重算绑定，约一分钟，未测量）。`deploy-preflight.py` 在停服前对比生产机现在的配置摘要、服务单元摘要和 `authority.json` 里的授权轮次与编号是否和冻结时一样；不一样（例如冻结后服务重启过）就不停服，并提示重新冻结（`PREFLIGHT_REFREEZE`）。
7. **生产机上的验收挪到停服之前。** `deploy.sh` 的步骤顺序改为 `S1_TRANSPORT S1_INSTALL S6_ACCEPTANCE S2_STOP …`，验收失败时旧版本照常服务。环境变量 `HIMAWARI_DEPLOY_ACCEPTANCE_AFTER_STOP=1` 恢复旧顺序，只在新顺序出问题时临时使用。
8. **给以后每人一个实例留好位置。** 实例的主机和固定值都在实例文件里，生成器按 `--instance` 选，[ADR 0083](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0083-isolated-instance-per-person-with-owner-entry.md) 的每人一个实例以后只需多写一个实例文件。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

### 方案 A：继续复制上一次的操作包，加检查清单

- 好处：不用改工具。
- 代价：同一种错误已经出现三次以上，每次之后都加了检查，下一次又有检查没覆盖的旧值；按 [ADR 0060](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0060-hard-constraint-on-third-repeat.md) 不能再只靠书面提醒。出包时间也降不下来。

### 方案 B：模板加参数生成，出包时跑全部检查（选这个）

- 好处：复制残留从根上没有了；要变的值集中在一个参数文件里，从生产和代码推出；检查在停服前就跑完。
- 代价：模板保留了第十二次的全部历史写法（例如步骤名 `S3_COPY51`）；生成器要能同时连生产机（只读）和 Hermes，只能在 Andy 的 Mac 上运行。

### 方案 C：改用通用部署工具（Ansible、Helm 一类）重写上线流程

- 好处：业界常用，模板和变量的写法现成。
- 代价：要重写 146 个已经在生产上验证过的脚本和全部夹具，期间没有可用的上线流程；单机、停服切换的场景用不上它们的滚动更新。

### 方案 D：升库时只靠 Hermes 上的整套演练

- 好处：最接近真实。
- 代价：快速模式下不跑演练（[ADR 0073](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0073-fast-delivery-mode.md)）；一次演练要几十分钟。改为出包时用真实命令升一个真实的旧版本数据库，几十秒内跑完。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处：
  - 用第十二次的参数生成的操作包，除 21 个有意改动的文件外，和当时冻结的操作包逐字节相同（`scripts/delivery-mode/test_make_packet.py`）。
  - 用旧的手抄值（读网页上限 32768）生成时，测试重现了第十二次的 `TWELFTH_SWITCH_ORIGINAL_PUBLIC_FETCH_CHANGED`；按生产读出的值生成时通过。
  - 第十三次要把数据库从 56 版升到 57 版，生成的操作包 17 项检查全部通过，其中用真实的升级命令升库的一项 6 个用例都通过（云端容器，34 秒）。
  - 第十三次在 Andy 的 Mac 上连真实生产机和 Hermes 只出包不上线的演练（2026-10-26 第六次通过，提交 `500817f`，数据库 56 → 57）：整次出包 385.7 秒，其中 Hermes 构建约 259 秒；17 项检查约 50 秒，网页验收和检查并行。前五次演练分别在出包阶段拦下了上传目录、过期构建、文件权限、验收工具和验收文字的问题，生产一次都没停。检查的临时目录放在 Hermes 的 `/tmp`，那里在根分区（约 7.4 GB 空闲），每次检查结束都会删掉。
- 代价：
  - 第十三次真正上线（2026-10-26，提交 `d39e7a9`，数据库 56 → 57）实测停服 4 分 28 秒：23:24:26.6Z 服务停止，23:28:54.4Z 新版本报告就绪，和约 4 分钟的推算相符。出包 414.8 秒；上线全程约 19 分钟，停服前 14 分钟（传包 4 分 01 秒、安装 2 分 11 秒、验收 7 分 50 秒），停服后最慢的是 `S7_SWITCH_START` 2 分 17 秒，其中新版本启动到就绪约 51 秒。
  - 第一次上线停在停服前的验收：上线前检查只要求空闲不少于包大小的 2 倍，装完新版本后根分区只剩 8.19 GB，验收要 10 GiB。服务没停，删掉旧版本的临时目录后第二次成功。改进记在 [BL-20261027-001](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/backlog/BL-20261027-001-deploy-preflight-root-free-after-install.md) 和 [BL-20261027-002](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/backlog/BL-20261027-002-prune-production-release-leftovers.md)。
  - 模板来自第十二次冻结的操作包，带着历史名字和说明文字；改模板时要同时改 `test_make_packet.py` 里的有意改动清单。
  - 手工写一份 `packet-parameters.json` 和 `packet-checks.json` 也能骗过上线前的检查；这道检查拦的是“忘了用生成器”，不是有意绕过。
- 后续：
  - 停服后剩下的约 4 分半里，切换启动 `S7_SWITCH_START`（2 分 17 秒）最长，能否再缩短等下次上线时拆开看。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [SOURCE: docs/lessons.md#copied-packet-stale-names]
- [SOURCE: docs/engineering-casebook.md#case-packet-generator]
- [SOURCE: docs/engineering-casebook.md#case-eleventh-twelfth-deploy]
- [交付模式规则：快速模式](../../.agents/instructions/delivery-mode.md#fast-mode)
- [ADR 0060：同一错误第三次就加硬约束](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0060-hard-constraint-on-third-repeat.md)
- [ADR 0073：快速交付模式](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0073-fast-delivery-mode.md)
- [ADR 0074：Claude 自己执行生产上线](0074-claude-runs-production-deployments.md)
- [ADR 0083：每人一个独立实例，主人也走 Cloudflare 入口](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0083-isolated-instance-per-person-with-owner-entry.md)

[↑ 返回阅读导航](#contents)

<a id="multi-user-follow-up"></a>

## 2026-11-11 后续：多人使用

[ADR 0234](0234-one-program-per-person-database-file.md) 取代 ADR 0083：多人不再是“每人一个实例”，而是一个程序、每人一个数据库文件。第 8 条预留的“按实例文件扩容”因此不再用于多人；Andy 的生产实例文件照旧。本 ADR 的决定不变。
