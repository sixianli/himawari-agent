# Hermes 生产升级到 c71adbd（schema 32 → 48）

日期：2026-09-27（日本时间 18:35–19:04）。所有者批准把 Hermes 上的 `himawari.service` 直接升级到本分支提交 `c71adbd5f23a88834512ad26112f587d6fa993b9`（不先合并到 main），删除一个卡住的测试 Run，执行[删除旧的未确认 SRT 执行记录](../p3-legacy-purge-01/README.md)，并在升级和检查完成后收回临时 sudo。所有者说明当前没有用户，因此不做数据库副本上的预演，直接切换。

## 用词

| 用词 | 意思 |
| --- | --- |
| Hermes | 所有者家里局域网的 Linux 服务器，生产服务 `himawari.service` 在上面运行 |
| schema | 产品数据库的结构版本号，由 `schema_migration_ledger` 表里最大的迁移序号表示 |
| 资格验证（qualification） | 在真实安装目录上、用正式运行账号 `himawari` 跑的六组探针，确认工具、网络限制和崩溃清理都按规定工作；通过后用主机签名密钥签署安装回执 |
| 安装回执 | `installation-receipt.json` 及其签名；启动脚本每次启动都核对它，与实际安装字节不符就拒绝启动 |
| 能力登记 | 数据库 `capability_declarations` 表里对每个工具程序（如 `himawari.pi-coding`）的登记，含版本、允许的操作、权限和程序指纹 |
| 程序指纹 | 程序文件内容的 SHA-256 摘要，字段名 `integrity` 和 `artifact.digest` |
| Agent / Worker | 服务里的两个进程：Agent 负责对话和调度，Worker 负责执行工具 |
| `service.ready` | Agent、Worker 各自完成启动检查后写进日志的事件；以它为准，而不是以 systemd 显示 active 为准 |

## 结果

- 生产服务已运行新版本：Agent 和 Worker 都写出 `service.ready`，HTTP `/health/ready` 返回 `ready`，进程以 uid 998 且 `NoNewPrivs` 运行，服务私有挂载视图里的安装目录是固态盘上的 `/opt/himawari/releases/2026-09-27-c71adbd`（只读）。
- 数据库从 schema 32 迁移到 48（迁移 33–48），外键检查 0 个错误，没有活动 Run。
- 卡住的测试 Run `run:2058c816-b008-402f-8b0f-965782d3d03c`（2026-09-16 起停在 `reconciling_external_result`）经正式删除命令删除，状态 `deleted_verified`。
- 旧的未确认 SRT 执行记录：Hermes 上 81 条执行记录全部是已确认清理、已释放，清单为空（摘要 `sha256:6406e5a0030506941264368e3e25f9c884865d804729e089fb9dab919245a591`），所以没有执行删除。
- 临时 sudo 已收回：删除了 `/etc/sudoers.d/99-himawari-claude-20260927` 和到期清理定时器，`visudo -c` 通过，`sudo -n true` 失败。
- **有一处与正式流程不同**：能力登记里 `himawari.pi-coding` 仍是旧程序指纹，详见[能力登记没有更新](#registry-deviation)。
- **上线后发现旧占用挡住写文件**，已由所有者批准直接改库修正，详见[上线后发现：旧占用挡住所有写文件请求](#occupancy-fix)。

## 可核验证据

| 文件 | 内容 |
| --- | --- |
| [`build.json`](build.json) | 源码归档、源码清单、准备清单和运行时摘要。构建在断网（`PrivateNetwork=yes`）的 systemd 单元里完成；前两次失败见[执行中发现的问题](#findings) |
| [`qualification.json`](qualification.json)、[`platform-probes.json`](platform-probes.json)、[`protected-runtime-probe.json`](protected-runtime-probe.json)、[`signer-preflight.json`](signer-preflight.json)、[`web-static-installed.json`](web-static-installed.json)、[`workspace-links.json`](workspace-links.json) | 六组资格验证：Pi 22 项、组合、允许网络 10 项、拒绝网络 7 项（全部拒绝、命名空间全部释放）、Worker 被杀后清理、公开搜索 3 项；23 个网页静态文件以运行账号读回一致；签署回执摘要 `eec1d319…70cce4`。资格阶段服务没有停，也没有写生产数据库 |
| [`database-before.json`](database-before.json) | 停服后、迁移前：schema 32，88 个 Run（其中 1 个是卡住的测试 Run），37 个对话，81 条执行记录 |
| [`backup-verify.json`](backup-verify.json) | 迁移前完整恢复点 `before-c71adbd-2026-09-27`：schema 32，完整性检查 `ok`，14,880 个 Payload，摘要 `sha256:ff0fb3ec…0919` |
| [`migrate.json`](migrate.json) | 迁移 33–48 全部应用；迁移命令另存的迁移前快照在 `state/data/pre-migration-35kes0/` |
| [`delete-purge.json`](delete-purge.json)、[`database-after-run-deletion.json`](database-after-run-deletion.json) | 卡住的 Run 删除：各删除目标都为 `verified`，6 个外部影响删除标记；删除后 87 个 Run、无活动 Run |
| [`unconfirmed-before.json`](unconfirmed-before.json) | 旧未确认记录清单为空 |
| [`failure.json`](failure.json)、[`exception.json`](exception.json) | 第一次切换脚本在“能力登记不变”检查处停下；此时迁移已完成，脚本按设计不自动回退数据库 |
| [`registry-deviation.json`](registry-deviation.json) | 登记与新部署快照的全部差异（只有 `himawari.pi-coding` 的两个指纹字段）和所有者的决定 |
| [`cutover.json`](cutover.json) | 续做脚本切换并启动的结果 |
| [`postflight.json`](postflight.json) | 启动后检查：HTTP、挂载、配置差异（只有 `capabilityDeployment` 变了）、schema、外键、历史数量 |
| [`deployment-helpers.zip`](deployment-helpers.zip)、[`deployment-helpers.sha256`](deployment-helpers.sha256) | 本次实际运行的构建、资格、签署、启动、切换和续做脚本。每个文件都和 Hermes 上 root 持有的冻结副本逐一核对过摘要。脚本绑定本次的路径和摘要，不能改日期直接用于下次发布 |

历史数量：升级前 37 个对话、88 个 Run；升级后 37 个对话、151 条消息、87 个 Run（少的 1 个是所有者要求删除的测试 Run）。数量一致与备份完整性检查是本次的证据，不等于逐条核对了历史内容。

<a id="registry-deviation"></a>
## 能力登记没有更新

第一次切换脚本在停服、备份、迁移、删除之后，运行 `hermes-protected-registered.mjs` 检查“数据库里的能力登记与新部署快照一致”，以 `CAPABILITY_SEMANTICS_CHANGED` 失败。原因：C3（提交 `02dbfc6`）改了 Pi 编码工具程序 `pi-coding-main.js`，所以程序指纹从 `sha256:49b09ed2…36f2e` 变成 `sha256:2de07ab0…6c79`；版本号 `1.0.0`、允许的操作和权限都没变。

Runbook 第 6 步写的正式做法 `himawari capabilities register` 在这里用不了：它发现已有登记且内容不同，就以 `ADMIN_CAPABILITY_REVIEW_REQUIRED` 拒绝（[`capabilities-command.ts`](../../../../../apps/admin-cli/src/capabilities-command.ts)）。控制中心里的能力更新流程按版本号进行，也不处理“同版本只换程序”的情况。Runbook 也不允许手工改数据库登记。

按代码核实，服务运行时对登记只检查状态、版本和允许的操作（[`production-runtime-tools.ts`](../../../../../apps/agent-service/src/production-runtime-tools.ts) 的 `#handle`、[`capability-registry-service.ts`](../../../../../packages/application/src/services/capability-registry-service.ts) 的 `issueExecutionHandle`），不比较登记里的程序指纹；实际运行哪个程序由签名的部署快照决定，Worker 启动时用快照核对（[`production-worker-composition.ts`](../../../../../apps/execution-worker/src/production-worker-composition.ts) 的 `completeDeployment`）。所有者据此选择“先启动，登记以后再补”。续做脚本 `hermes-c71adbd-cutover-resume.py` 只接受这一种差异：`himawari.pi-coding` 的 `integrity` 和 `artifact.digest`，其余任何差异都拒绝；它没有写登记表。

影响：控制中心里这个工具的登记详情仍显示旧指纹，数据库登记在补上之前不准确。补救需要让 `capabilities register` 支持“同版本、只换了已通过资格验证的程序”的更新并写审计记录，这是单独的代码改动。

<a id="findings"></a>
## 执行中发现的问题

- **构建第 1 次失败**：断网构建用的旧 npm 缓存里没有 `@earendil-works/pi-tui-0.84.2`。合并了 Hermes 上以往六次构建的 npm 缓存后解决；只有 30 个非 Linux 平台的可选二进制包到处都没有，不影响 Linux 安装。
- **构建第 2 次失败**：npm 认为缓存过期，仍然尝试联网确认。在构建用源码目录的 `.npmrc` 里加 `prefer-offline=true` 后，第 3 次完全离线成功。失败日志保留在 Hermes 的 `builds/2026-09-27-c71adbd-attempt1`、`-attempt2`。
- **资格脚本模板里的旧运行时摘要**：模板仍写着更早版本的 `6d803c29…`；改成当时生产的 `fa74f6a8…` 后才运行，它只用来确认资格阶段线上安装没被换掉。
- **首次启动 Worker 超时**：新服务第一次启动时，Worker 等 Agent 发布启动绑定超过固定的 30 秒（`WORKER_STARTUP_TIMEOUT`），整个服务退出；systemd 按单元的重启设置在 15 秒后重启，第二次约 25 秒就绪。以往几次启动，从安装校验通过到 Worker 就绪约 20–25 秒，余量本来就小；迁移后第一次冷启动更慢。这次没有查明 Agent 启动慢在哪一步，需要单独排查（例如机器重启后的冷启动也可能碰到）。

<a id="occupancy-fix"></a>
## 上线后发现：旧占用挡住所有写文件请求

所有者上线后在真实浏览器里让它写 `贪吃蛇.html`，写入请求批准后一直显示“正在等待资源”。原因是占用表 `sandbox_workspace_occupancy` 里有两条 2026-09-12、09-15 的只读占用没有解除（`released_at` 为空），而它们对应的执行早已正常结束：清理已确认、结果已送达并确认、对话已完成。这是 v4 的已知缺陷：结果送达时把占用重新打开、确认后不再解除，已在提交 `fe92846`（[ADR 0030](../../../../../docs/adr/0030-durable-workspace-release-facts.md)）修正，但 v4 没有包含这个修正。写请求和已有占用在同一目录上冲突，所以默认工作目录里的一切写入和编辑都会排队到期后取消。新版本启动时的自动恢复没能重新核实这两条（`SANDBOX_RECONCILIATION_UNCONFIRMED`）。

**这是升级前检查的遗漏**：只核对了执行记录的清理标记，没有核对占用表里是否还有未解除的占用。

现有命令都处理不了这两条：只读核查工具不修改数据，旧未确认记录的删除命令只处理清理结果为 `unknown` 的记录。所有者同意作为一次例外，直接在数据库里改这两行（[`occupancy-fix.json`](occupancy-fix.json)）：以服务账号运行，先只读预览，再用 SQLite 备份接口把整个数据库复制到 `state/data/manual-before-occupancy-fix-2026-09-27/` 并检查完整性；然后在一个事务里，只在 `released_at` 仍为空时把这两行设为当前时间，要求恰好改 2 行；最后读回，未解除占用为 0。改之前核实了服务账号下只有 19:02 启动的三个进程，当年的工具进程都已不存在。没有写释放回执、没有写审计记录、没有重启服务，改后健康检查仍为 `ready`。这绕过了 ADR 0030 第 5 条要求的“逐条条件更新”的正式命令，以后应补上正式命令。

## 恢复方式

新服务已经启动过，按 Runbook 不自动回退数据库。需要回到 v4 时：停服，用旧版 CLI 恢复 `before-c71adbd-2026-09-27`（schema 32），再从切换目录 `qualifications/2026-09-27-c71adbd-cutover/private/` 恢复旧的 unit、配置、保护记录和启动证明。schema 48 的数据库不能直接给 v4 用。旧安装 `/opt/himawari/releases/2026-09-16-v4-0600b29` 保留未动。

## 没有验证的部分

- 没有用真实浏览器登录生产页面走一遍聊天、审批和刷新（Runbook 第 8 步）；只检查了 HTTP 就绪、首页和它引用的 2 个资源返回 200，以及资格阶段以运行账号读回的 23 个静态文件。
- 没有发起任何模型请求，新版本的真实模型对话还没有验收。
- 生产配置没有打开严格模式（没有 `taskEnvironments`），所以本分支的容器任务环境、C3 的宿主一侧发布在 Hermes 上没有被用到；部署绑定仍是 v4 的 `sandbox-host-binding.v1`，没有启用新的工具合同。

## 重新运行

脚本都绑定了本次的路径和摘要。下次升级应以 [`deployment-helpers.zip`](deployment-helpers.zip) 为模板，改成新的目录和摘要，并按[升级手册](../../../../../docs/runbooks/hermes-control-center-upgrade-runbook.md)执行：`build.sh` 在断网单元里构建；`hermes-c71adbd-qualify.py --qualify` 做资格验证并签署；`hermes-c71adbd-cutover.py --apply --receipt <回执摘要>` 停服、备份、迁移和切换；续做脚本只适用于本次的登记差异。
