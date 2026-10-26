# 第十次变更的能力登记、签署与升级

本文说明第十次变更（`twelfth-20261026`，R2-L13）怎样签署新版本，再用两段式升级命令，把数据库里的能力登记更新为新快照（签名过的能力清单）的声明。这次涉及三个已登记的能力 `himawari.pi-coding`、`himawari.public-search`、`himawari.public-fetch`，都只换运行程序（runner，沙箱里执行工具的程序）和运行目录；不登记新能力，出网和密钥范围都不变。

数据库结构版本（Schema）保持 51，没有迁移。工作目录和授权沿用第四次建立的那一份，不在本次改动。下面列出代码依据和包内可复跑的检查；它们不证明生产上的签署或升级已完成。

导航：[两种记录的职责](#两种记录的职责) · [签署前必须成立的条件](#签署前必须成立的条件) · [服务停着时的能力升级](#服务停着时的能力升级) · [沿用的工作目录授权](#沿用的工作目录授权) · [包自带检查](#包自带检查)

## 两种记录的职责

| 当前入口 | 实际行为 | 代码依据 |
| --- | --- | --- |
| `capabilities register` | 把已登记的声明与新声明做完整 JSON 比较；安装路径或时间变了也报 `ADMIN_CAPABILITY_REVIEW_REQUIRED`，所以第十次也不用它重新登记已有能力 | `apps/admin-cli/src/capabilities-command.ts` |
| `capabilities upgrade-plan` / `upgrade --confirm` | 读签名快照和数据库生成升级计划。不带 `--reviewed` 时，只接受制品摘要、来源位置、审核时间、健康检查时间和 `runtime.argv` 前两项安装前缀的变化，其他变化报 `ADMIN_CAPABILITY_REVIEW_REQUIRED`。确认时重算计划，摘要不符报 `ADMIN_CAPABILITY_PLAN_MISMATCH`。在一个事务里给每条登记加一个修订号、写新声明（旧声明留作回退值）、撤销该能力未用的执行句柄并写审计 | 同上 |
| 加 `--reviewed` | 第七次加入：经过核对的计划可以登记新能力，并接受出网和密钥范围的改变；计划输出多一个 `registrations` 列表，结果多一个 `registered` 列表。第十次维护代码仍带这个选项，但要求 `registrations` 为空、每项升级都没有 `scopeChanges`，所以三条审计都是 `owner.capability.upgrade`（代码在没有 `scopeChanges` 时选这个动作） | `9ab89e9b` 里的 `apps/admin-cli/src/capabilities-command.ts` |
| 快照加载 | 解析新清单和主机资格，直接在内存中构造记录、适配器和绑定；这一步不读数据库里的能力目录 | `packages/platform-node/src/capabilities/capability-deployment.ts` |
| 沙箱执行 | 每次重读并重核已接纳的快照，按能力编号和版本找新绑定；不会用旧目录里的命令行启动 runner | `apps/agent-service/src/production-sandbox-services.ts` |
| 调用政策 | 从数据库里的能力记录核对 active、healthy、版本、操作和数据分类 | `packages/application/src/services/action-policy-service.ts` |

签署脚本生成的 `runtime.argv` 前两项是新运行时里的 Node 和 runner 路径，只有安装目录前缀变化；主机编号、worker 实例编号、数组长度、文件后缀和其他声明字段必须与已登记的声明相同。

三个能力的执行绑定（[cloud-seal.mjs](cloud-seal.mjs) 的 `bindings`）：

| 能力 | runner 文件 | 操作 | 范围来源 | 联网 |
| --- | --- | --- | --- | --- |
| `himawari.pi-coding` | `pi-coding-main.js` | `read`、`write`、`edit`、`find`、`grep`、`ls`、`bash` | `grant_targets`（授权工作目录） | 禁止 |
| `himawari.public-search` | `web-search-main.js` | `web_search`，契约类型 `network_only` | `private_temp`（每次调用新建、用完删除的私有临时目录） | `mcp.exa.ai:443`、`api.deepseek.com:443` |
| `himawari.public-fetch` | `web-fetch-main.js` | `web_fetch`，契约类型 `network_only` | `private_temp` | `mcp.exa.ai:443`、`api.deepseek.com:443` |

搜索和读网页的清单里 `scopes.secrets` 都是 `["deepseek-web"]`，`scopes.network` 与 `runtime.network` 都是上面两个域名，与第九次登记的相同；Pi 的网络和密钥范围都为空。

[返回导航](#第十次变更的能力登记签署与升级)

## 签署前必须成立的条件

签署时（S6）数据库是第九次升级后的严格状态：三个能力的登记等于第九次快照的声明。[cloud-capability-manifest.mjs](cloud-capability-manifest.mjs) 的 `assertCapabilityCompatibility` 对每个能力要求：

- 每个能力：S0 读回里必须有它（否则 `FROZEN_CAPABILITY_OBSERVATION_REQUIRED`），仍是 active、healthy，版本、操作、范围、费用、秘密引用和权限引用都与上一次（第九次）快照相同，并且整组严格键全真：`declarationMatchesSnapshotExceptArtifact`、`snapshotIntegrityMatchesRunner`、`storedIntegrityMatchesDeclaration`、`runnerMatchesRecorded`、`integrityMatchesSnapshot`、`declarationInvariantMatchesSnapshot`。任何一项为 false 或缺失都报 `OLD_CAPABILITY_CHECK_FAILED` 或 `OLD_CAPABILITY_PREVIOUS_SHAPE_CHANGED`。这样能发现 S0 之后有人改过登记或 runner。
- 新声明的 `integrity` 和 `artifact.digest` 都等于 `sha256:` 加新 runner 的真实 SHA。把这两个制品摘要换回已登记 runner 的摘要后，`manifestInvariantDigest`（见下）必须等于 S0 读到的上一次快照值，否则报 `NEW_CAPABILITY_POLICY_INCOMPATIBLE`。也就是说，新声明除制品摘要外与已登记声明逐字相同。
- 第十次没有允许范围变化的例外，新能力列表 `newCapabilityRefs` 为空：任何能力改了范围、密钥、操作、费用、文件或权限引用，都报 `NEW_CAPABILITY_POLICY_INCOMPATIBLE`。
- 现场验收里只有搜索有单独的安装后探针（`web-search-installed`，[cloud-seal.mjs](cloud-seal.mjs) 要求 3 条证据）；读网页没有单独的验收探针。

`manifestInvariantDigest` 是按对象键递归排序、数组保持原顺序后的紧凑 JSON 的 SHA。只删除 `source.locator`、`health.checkedAt` 和 `reviewedAt`；`argv[0]`、`argv[1]` 只有等于安装目录或以它加 `/` 开头时，才把这段前缀换成 `<runtime>`。不能整体排除 argv，也不允许相似前缀或新增参数。主机资格和运行时摘要重新签署，不复用第九次的时间或摘要。

[返回导航](#第十次变更的能力登记签署与升级)

## 服务停着时的能力升级

`S7_CATALOG_UPGRADE`（[S7 说明](../systemd/P9-switch-start-readback.md#能力升级与配置切换)，执行代码在 `maintenance/run-maintenance.mjs` 和 `maintenance/maintenance-common.mjs`）在签署和 `S7_CONFIG_APPLY` 之后、服务启动之前运行。升级后它写一份状态读回 `s7-post-upgrade-state.json`（`integrity_check`、迁移条数、Schema 版本），不运行末尾的 `db status`，因此数据库旁不会留下 `-wal`/`-shm` 附属文件（[BL-20261017-007](../../../../docs/backlog/BL-20261017-007-s9-回-滚-前-处-理-数-据.md)，第五次留下过这两个文件）：

1. 升级前读回 `s7-catalog-before.json`：三个能力仍是上一次（第九次）的严格形状；此时配置已经是 `S7_CONFIG_APPLY` 写出的“改了 `http.staticRoot`、主模型 `deepseek-primary` 的 `contextWindow`（1000000）和 `maxTokens`（32768）、`budgets` 的六个额度（都是 1000000000000000） 的原配置”。
2. 以生产账号经 `/usr/bin/setpriv --no-new-privs` 运行准备脚本 [cloud-protected-prepare.mjs](cloud-protected-prepare.mjs)（与服务单元的 `NoNewPrivileges=yes` 相同，运行保护核对要求它），发布第十次快照和启动证明，最后改名切换配置里的 `capabilityDeployment`。准备后的读回（`verifyPreparedCapabilities`）要求：运行目录是新安装目录；操作、费用、权限引用、版本都与快照一致；三个能力的范围、密钥引用、声明除制品摘要外都与登记一致。`integrityMatchesSnapshot` 如实反映新 runner 是否等于登记值。待登记能力列表（`verifyPendingCapabilities`）必须为空。
3. `upgrade-plan --reviewed` 的计划（`verifyUpgradePlan`）必须正好满足：`current` 为空；`upgrades` 正好是三个能力，每项的版本不变，`fromIntegrity` 等于 S0 读到的登记值，`toIntegrity` 等于新 runner，`fromRuntimeRoot` 是第九次部署的安装目录 `/opt/himawari/releases/2026-10-26-twelfth/lib/himawari-agent`，`toRuntimeRoot` 是 `/opt/himawari/releases/2026-10-26-twelfth/lib/himawari-agent`；每项都没有范围变化；`registrations` 为空。计划里不能有别的项。
4. `upgrade --confirm <计划摘要> --reviewed` 的结果必须与计划一致：升级列表是三个能力，登记列表为空，没有 `current` 项。之后的读回（`verifyUpgradedCatalog`）要求：三个能力的安装目录是新的、版本和状态及主机编号、worker 实例编号不变、修订号加 1、`integrity` 列等于新 runner、登记记录已变，严格检查全部为 true（登记等于快照声明、资格等于快照、active、没有待定声明、回退值是原来的摘要、没有状态仍为 `active` 的执行句柄；对话结束或用满次数留下的 `revoked`、`consumed` 句柄不算，见 [S7 说明第 5 步](../systemd/P9-switch-start-readback.md#能力升级与配置切换)）；审计表在原有记录之后正好追加三条 `completed` 的 `owner.capability.upgrade`，每个能力一条。

升级已完成而读回失败时，按 [从升级后的失败现场续做](../systemd/P9-switch-start-readback.md#从升级后的失败现场续做) 在用户批准的准备后续做，不重复升级。

升级之后数据库和管理界面里的能力“完整性摘要”与实际运行的 runner 一致。S7 启动读回和 S8 读回都用严格检查，并要求登记与升级后读回相同。S9 恢复把 S3 原样数据库放回，三个能力的登记随之回到 S0 的样子，见 [S9 恢复](../maintenance/S9-rollback.md)。

[返回导航](#第十次变更的能力登记签署与升级)

## 沿用的工作目录授权

第十次不新建目录或授权。[workspace-grant-binding.py](workspace-grant-binding.py) 的 `bind_existing_grant` 要求：编码路由只有一个授权，编号是第四次的 `directory:himawari-prod-workspace-20261015`，目录 `/var/lib/himawari/workspace`，未撤销、未到期、可读，能力是 `himawari.pi-coding` 1.0.0；目录和 `files/`、`repos/` 属于服务账号、权限 0700，device/inode 与授权记录一致；部署身份和租约与冻结绑定相同；原配置 SHA 等于 S0。签名快照的授权根列表 `authorizedRoots` 只有这一个目录，限定主机验收用另建的虚构目录，签署脚本拒绝它与生产授权根相同。搜索和读网页用的是 `private_temp` 临时目录，不读也不改这个授权目录。

之后每次启动只核对配置的属主、Agent、部署身份、签署的授权根、完整的清单政策和现场主机资格。授权到期，或用户通过正式产品流程改授权编号，不阻止服务重启；产品每次请求都从数据库重新检查真实授权。未签署的目录仍会被拒绝。

[返回导航](#第十次变更的能力登记签署与升级)

## 包自带检查

按用户决定 G180 的快速模式，第十次不在 Hermes（用户的另一台 Linux 服务器）上跑 L2–L4 测试，也不做整包演练，也没有“生产形状演练”（用任务自有的数据库和安装模拟整条步骤链的检查）。冻结前只运行下面这些固定样例检查：

- [verify-capability-manifest.mjs](verify-capability-manifest.mjs)：纯输入夹具，覆盖合法安装前缀变化、政策和 runner 参数比较、上一次严格形状被破坏时拒绝、S0 结果或绑定变化时拒绝；没有新能力；搜索和读网页对已登记的第九次声明做普通升级能通过，缺 S0 观察时报 `FROZEN_CAPABILITY_OBSERVATION_REQUIRED`，改范围、密钥、操作、费用、文件或权限引用都被拒绝；Pi 不能增加网络范围；授权到期或经产品流程改编号后仍能启动、不扩大已签名的根。不发请求、不碰生产。
- [verify-finalize-capability-check.py](verify-finalize-capability-check.py)：把 `finalize-binding-inputs.py` 里核对 S0 能力读回的那一段代码单独取出来，用 `inputs/s0-db-readback.json` 和 `inputs/bindings.draft.json` 做固定样例检查。

这些检查不执行固定生产目标的脚本，也不证明云主机上 systemd 或 AppArmor（Ubuntu 的程序访问限制）的行为；那些由 S1–S8 在生产上逐项检查。第十次的升级命令第一次完整运行就在生产上。

[返回导航](#第十次变更的能力登记签署与升级)
