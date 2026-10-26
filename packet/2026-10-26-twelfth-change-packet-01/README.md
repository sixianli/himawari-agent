# 第十二次生产变更：操作包

本目录是第十二次生产变更的操作包（一组按顺序在生产机上运行的脚本和它们要核对的输入）。它从第十一次的操作包复制而来，再按这次要上线的内容修改。冻结清单 `freeze-manifest.json`（列出包内每个文件字节数和 SHA-256 摘要的文件）由 `inputs/finalize-bindings.py --freeze-reviewed-packet` 生成；冻结后改动任何文件，步骤都会拒绝运行。

导航：[现状](#现状) · [这次上线什么](#这次上线什么) · [和第十一次相比的差别](#和第十一次相比的差别) · [数据库不升级](#数据库不升级) · [S8 历史核对](#s8-历史核对) · [步骤](#步骤) · [真实网页验收](#真实网页验收) · [没有做的验证](#没有做的验证) · [冻结前做过的检查](#冻结前做过的检查) · [用户的决定](#用户的决定) · [回滚](#回滚)

## 现状

- 线上运行的是第十一次部署的版本（源码 `aa563155`），安装在 `/opt/himawari/releases/2026-10-26-eleventh`，数据库结构版本（Schema，数据库表结构的编号）是 56。
- 第十一次上线后网页不能用：服务重启后，已经打开的网页读对话和设置时被服务拒绝（返回 403 `PORT_NOT_AUTHORITATIVE`，意思是“这个页面拿的授权编号已经过期”），页面一直停在“正在加载权威状态”，设置里的“允许联网搜索”勾不上；另外第十一次把读网页上限从 32768 调到 102400 后，原来勾过的联网搜索同意失效了。
- 生产配置 `/etc/himawari/config.json` 里没有 `budgets`（费用上限）；主模型 `deepseek-primary` 的上下文窗口是 1000000、输出长度上限 `maxTokens` 是 32768；读网页的单次上限 `runPolicy.publicFetch.maximumBytes` 是 102400 字节。
- 冻结前的只读读取 S0 在仓库根目录运行 `bash .ci-output/production/run-twelfth-packet-s0.sh`，结果放进 `inputs/`（`s0-db-readback.json`、`system-tools-observed.json`、`npm-observed.json`）。

[返回导航](#第十二次生产变更操作包)

## 这次上线什么

1. 把代码换到分支 `claude/eleventh-hotfix` 的 `470b6d30`（候选提交，要装到生产上的代码版本）。它在 `aa563155` 上修了两处：
   - 网页收到“授权编号已过期”的拒绝时，重新读取一次服务配置并换用新的授权编号，不再卡住；
   - 联网搜索同意只和模型、发送对象绑定，读网页上限等数字变化不再让同意失效。
2. 新代码装在 `/opt/himawari/releases/2026-10-26-twelfth`，第十一次的版本目录保留用于回退。
3. 配置文件 `/etc/himawari/config.json` 只改 `http.staticRoot`（网页静态文件目录）：从第十一次版本目录下的路径改成第十二次的路径；其余字段一律不变（读网页上限仍是 102400，主模型窗口仍是 1000000、输出长度仍是 32768）。之后签署准备步骤照常更新 `capabilityDeployment`。
4. 数据库不升级，见[数据库不升级](#数据库不升级)。
5. 三个已登记的能力（能力：Himawari 可调用的一组工具）`himawari.pi-coding`、`himawari.public-search`、`himawari.public-fetch` 都只换运行程序，走普通升级，审计动作都是 `owner.capability.upgrade`；不登记新能力，不改出网和密钥范围。

[返回导航](#第十二次生产变更操作包)

## 和第十一次相比的差别

| 项目 | 第十一次 | 第十二次 |
| --- | --- | --- |
| 候选提交 | `aa563155` | `470b6d30` |
| 数据库结构 | 55 升到 56 | 保持 56，不运行迁移 |
| 配置 | 改 `http.staticRoot`、`publicFetch.maximumBytes` 改成 102400 | 只改 `http.staticRoot` |
| 能力 | 三个都只换运行程序 | 相同 |
| S8 历史核对 | 和 S3 保存的数据库逐行比较 | 相同 |
| 回滚 | 恢复原配置、原服务单元、快照和 Schema 55 数据库 | 相同，恢复的是 Schema 56 数据库（恢复点 `twelfth-20261026-raw-schema56`） |
| 上线前验收 | 只看首页返回 200 | `deploy.sh` 要求这个候选包的真实网页验收全部通过，见[真实网页验收](#真实网页验收) |
| 部署命令 | `scripts/delivery-mode/deploy.sh` | 相同 |

步骤名 `S3_COPY51`、`S9_RAW_RESTORE51`、`S9_RAW_CONTROL51` 是 `deploy.sh` 和回滚脚本里固定的名字，这次沿用；它们实际处理的是 Schema 56。

[返回导航](#第十二次生产变更操作包)

## 数据库不升级

候选 `470b6d30` 自带的迁移和 `aa563155` 一样，最后一条是 56（`authority_revision`），生产库已经是 56。所以 `S7_CONFIG_APPLY` 不再运行 `himawari db migrate`，只做：

1. 要求服务停着、`S7_DB_STATUS` 已通过、数据库是 Schema 56、当前配置等于原配置、历史表和 S3 副本一致；
2. 写出并换上只改了 `http.staticRoot` 的新配置，确认新版本解析结果里没有 `budgets`、读网页上限仍是 102400；
3. 再读一次数据库：Schema 和最低可写版本都是 56，历史表和换配置前完全一样，证据写进 `s7-config-apply-after56.json`。

[返回导航](#第十二次生产变更操作包)

## S8 历史核对

沿用第十一次的做法：`S8_READBACK` 和 S3 保存的数据库副本（恢复点 `twelfth-20261026-raw-schema56`）逐行比较 12 张历史表：

- 上线前已有的行不能被删除，表的列不能变；
- 已有行的内容不能改，唯一例外是 `sandbox_execution_records.recovery_json`（服务启动时的恢复逻辑会改写已结束记录的这一列），被改的行号写进报告 `s8-history-preserved.json`；
- 允许出现新行（服务启动后可能写入新记录）。

注意：服务在 `S7_SWITCH_START` 启动后到 S8 结束前，如果有人在网页上继续旧对话，旧对话那一行会被更新，S8 会失败并自动回退。部署期间请不要使用对话，等终端打印 `DEPLOY_PASSED` 再用。

[返回导航](#第十二次生产变更操作包)

## 步骤

包冻结后，在仓库根目录运行：

```sh
bash scripts/delivery-mode/deploy.sh .ci-output/production/2026-10-26-twelfth-change-packet-01
```

它先运行 `inputs/check-packet-consistency.py`（包自带的一致性检查）、`scripts/delivery-mode/browser-acceptance-gate.py`（核对[真实网页验收](#真实网页验收)的结果）和 `scripts/delivery-mode/deploy-preflight.py`（只读的上线前检查），不通过就不改动生产机；然后经 `steps/run-user-step.sh` 依次运行下面各步，遇到第一个失败就停，并打印 `DEPLOY_STOPPED_AT <步骤名> exit=<退出码>`：

`S1_TRANSPORT` → `S1_INSTALL` → `S2_STOP` → `S3_COPY51` → `S6_ACCEPTANCE` → `S6_PUBLISH_MATERIALS` → `S6_FINALIZE_BINDINGS` → `S6_SIGN` → `S6_RUNTIME_PROTECTION` → `S6_READ` → `S7_DB_STATUS` → `S7_CONFIG_APPLY` → `S7_CATALOG_UPGRADE` → `S7_SWITCH_START` → `S8_READBACK`

- 如果失败发生在 `S2_STOP` 之前，服务没有被动过；从 `S2_STOP` 起失败，`deploy.sh` 会自动运行 `scripts/delivery-mode/rollback.sh` 回到第十一次的版本。
- `S7_CONFIG_APPLY`：只换配置，见[数据库不升级](#数据库不升级)。
- `S7_CATALOG_UPGRADE`：要求数据库是 Schema 56；签署准备写入三个能力的新快照；核对三个能力的数据库登记仍是 S0 的样子；运行 `upgrade-plan --reviewed` 并逐项核对计划；运行 `upgrade --confirm <计划摘要> --reviewed`；最后读回三个能力都与新快照一致，审计记录正好多出三条 `owner.capability.upgrade`，升级后读回写进 `s7-catalog-after56.json`。
- `S7_SWITCH_START`、`S8_READBACK`：要求配置只比原配置多改了 `http.staticRoot` 和 `capabilityDeployment`，数据库是 Schema 56；S8 的历史核对见[上一节](#s8-历史核对)。
- `deploy.sh` 把终端输出同时写进本目录下的 `run-logs/deploy-<时间>.log`。这个目录在冻结之后才出现，包的冻结检查只忽略包根目录下的 `run-logs/`，其他位置多出文件仍会被拒绝。

逐步入口见 [steps/README.md](steps/README.md)。

[返回导航](#第十二次生产变更操作包)

## 真实网页验收

`browser-acceptance/walkthrough.json` 是在 Hermes 上用产品路径测试“release acceptance in a real browser”（用真实浏览器按用户的方式操作网页的测试）对这个包里的候选压缩包跑出的结果。它记录候选压缩包的 SHA-256 和六项检查：首页能打开、设置里“允许联网搜索”能勾上、搜新闻有结果、长回答完整显示、记忆页能打开、服务重启后已打开的页面还能勾开关和搜索。`deploy.sh` 在动生产机之前要求这六项都是 passed，且压缩包摘要和 `inputs/bindings.json` 里的候选摘要一致。

同一个测试对第十一次的候选 `aa563155` 跑时，在“服务重启后已打开的页面还能勾开关”这一项失败（60 秒内开关一直不能勾），和 Andy 在生产上看到的现象一致。

[返回导航](#第十二次生产变更操作包)

## 没有做的验证

- 按快速模式（`DELIVERY_MODE=fast`，ADR 0073），代码的相关测试、`npm run check` 和 `npm run build` 在 Hermes 上跑；不跑 L2–L4 测试，也不做整包演练。冻结前在 Hermes 构建候选、跑真实网页验收、运行包自带的检查和维护代码的固定样例检查。
- 真实网页验收用的是测试账号和测试数据，不是生产数据；“授权编号已过期后重新读取配置”在生产上的效果要等上线后实际打开网页确认。

[返回导航](#第十二次生产变更操作包)

## 冻结前做过的检查

- 在 Hermes 上构建候选，构建检查通过（`LAYER3_VERDICT_PASSED`），按这次构建生成候选材料，填写候选字段。
- 在 Hermes 上对候选压缩包跑真实网页验收，六项全部通过，结果放进 `browser-acceptance/walkthrough.json`。
- 在 Hermes 上运行固定样例检查（`verify-fixtures.mjs`、`verify-capability-manifest.mjs`、`verify-doctor.test.mjs`、`verify-s9-*`、`verify-steps.py`、`verify-finalize-bindings.py` 等）。`verify-fixtures.mjs` 改成要求原配置已经是读网页上限 102400、主模型 1000000/32768、没有 `budgets`，新配置只改 `http.staticRoot`；数据库样例改成 Schema 56。
- S0 结果放入后再重算清单摘要，运行 `inputs/check-packet-consistency.py` 和 `inputs/finalize-bindings.py --candidate-from-s0`，通过后冻结。

[返回导航](#第十二次生产变更操作包)

## 用户的决定

- 2026-10-26 09:17:55Z，Andy：“不要退回去，就把这一版修完，修完美了再发上去。”所以这次不回退第十一次，直接修好再上线。
- 上线后 Andy 需要在设置里重新勾一次“允许联网搜索”：第十一次的同意因为旧的绑定方式已经失效，新代码不会自动替用户重新同意。

[返回导航](#第十二次生产变更操作包)

## 回滚

`deploy.sh` 在 `S2_STOP` 之后失败时会自动运行 `bash scripts/delivery-mode/rollback.sh <包目录>`；其他时候只在 Andy 决定回退时手动运行。它恢复 S2 保存的原配置、原服务单元、原快照和启动证明，以及 S3 保存的 Schema 56 数据库（恢复点 `twelfth-20261026-raw-schema56`）。回退前会先把当时的数据库原样另存一份。回退到的是第十一次的版本，它有上面[现状](#现状)里说的两个问题。说明见 [maintenance/S9-rollback.md](maintenance/S9-rollback.md) 和 [install/P12-rollback.md](install/P12-rollback.md)。

[返回导航](#第十二次生产变更操作包)
