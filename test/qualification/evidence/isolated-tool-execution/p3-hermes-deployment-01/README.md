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
- **上线后发现读文件的结果会丢失、对话停在“对账中”**，原因已查明并在提交 `4f2b776` 修正，详见[上线后发现：工具结果被后台恢复挤掉](#result-lost)。这个修正已于同日 21:22（日本时间）部署到 Hermes，详见[修正上线：4f2b776](#fix-deploy)。
- **4f2b776 上线约 10 分钟后 Agent 崩溃重启一次**，原因已从 Hermes 数据查明，修正随 2026-09-28 的升级上线（schema 48 → 49），详见[升级到 116d6db](#fix-116d6db)。

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

<a id="result-lost"></a>
## 上线后发现：工具结果被后台恢复挤掉

占用修正后，所有者在同一个对话里重试，Run `run:f52264fe-b2b1-4bb6-a687-e9facdc06070` 又停在 `reconciling_external_result`（结果未确认、等待对账的状态）。所有者同意后，只解密了这次工具调用在 19:47:09–19:47:16 写下的监控和结果记录，没有解密对话内容；数据库只读查询。

查到的事实（时间为 UTC 10:47）：

| 时间 | 谁 | 记下了什么 |
| --- | --- | --- |
| 13.196 | 进程宿主（运行沙箱进程的监督程序） | 仍在运行 |
| 13.238 | 进程宿主 | 已结束，进程组全部消失 |
| 13.470 | Agent 的实时观测 | 第 4 条资源记录：失去控制（`SANDBOX_CONTROL_UNCONFIRMED`） |
| 13.606 | Worker | 写入 Pi 的输出：一份正常的 `pi-result.v1`，内容是文件不存在（`PI_FILE_MISSING`），程序退出码 1 |
| 14.884–16.605 | Agent 的后台资源恢复 | 第 5 条“对账中”、第 6 条“已释放”，占用解除；恢复记录版本 3、尝试 1 次 |
| 16.775 | Agent | 工具结果：`WORKER_RESULT_RECONCILIATION_REQUIRED`（结果未确认） |

执行记录里的操作结果始终为空，也就是 Worker 的结果从没写进数据库。

原因（依据上表和代码，另有本机复现）：

1. Agent 观测时，宿主文件里还是 13.196 的“运行中”，但 Linux 进程命名空间在 13.238 已经消失。[`production-sandbox-control.ts`](../../../../../apps/agent-service/src/production-sandbox-control.ts) 的判定要求“运行中”时命名空间也还在，不满足就判为失去控制。这个判定偏保守，但本身不会丢数据。Mac 上的判定不看命名空间，所以本机测试一直碰不到这个时机。
2. 一旦记录是“失去控制”，Agent 的后台资源恢复（[`sandbox-resource-recovery.ts`](../../../../../packages/application/src/services/sandbox-resource-recovery.ts)）马上把它当成要核查的对象，写入“对账中”，把记录序号从 4 推到 5。
3. Worker 这时正带着结果提交第 5 条记录，要求当前序号仍是 4，于是被数据库拒绝。旧代码（[`production-sandbox-execution-v2.ts`](../../../../../apps/execution-worker/src/production-sandbox-execution-v2.ts)）把这个失败吞掉，直接回报“结果未知”，结果就永久丢了。恢复只能证明进程已清理，不能补出结果，所以 Run 停在对账中。

佐证：Hermes 上 2026-09-14 的网页搜索 `302ab4dc` 也出现过同样的“先判失去控制、Worker 再提交”，那次 Worker 先写成功，所以没有丢结果；区别只在谁先写到数据库。本机用真实 Pi 程序读不存在的文件、不制造竞争时，结果能正常写入并返回“失败”。

修正（提交 `4f2b776`）：Worker 提交结果被拒时重新读取记录；如果后台恢复正在进行（“对账中”），先等它结束再写，避免打断恢复；记录已释放时只写操作结果，否则照旧写一条“失去控制”并带上结果。只有记录确实被别人改过才重试，最多 5 次。新增的场景 `pi-recovered-during-delivery`（[`sandbox-v2-worker-lifecycle.test.ts`](../../../../../test/integration/sandbox-v2-worker-lifecycle.test.ts)）在修正前失败（结果一直是“未知”），修正后通过。修正提交后，由 Claude 在本机运行 `npm test -- --output .ci-output/npm-test-4f2b776`（项目规定的完整测试，运行期间没有改动工作区），全部通过：contracts 380、unit 2069、integration 1853、e2e 3、pi-compat 130，报告在 [`npm-test-4f2b776.tar.gz`](npm-test-4f2b776.tar.gz)。托管的 GitHub 检查没有运行（`hosted gate: not_executed`）。Linux 上的真实竞争时机没有在本机重现；修正已部署（见[修正上线：4f2b776](#fix-deploy)），但部署时没有发起真实对话，所以在 Hermes 上还没有观察到它实际起作用。

仍然存在、没有在这次修正里处理的：

- 已经卡住的 `run:f52264fe…` 不会因为部署新版本而恢复，它的结果从未入库。
- Pi 读文件返回错误时，模型看到的是“操作未确认成功。”，看不到“文件不存在”，可能导致模型不知道下一步该做什么。本机复现里看到了这一点，这是另一处需要单独修正的问题。

<a id="fix-deploy"></a>
## 修正上线：4f2b776

日期：2026-09-27（日本时间 21:05–21:24）。所有者批准“部署并重启”，并在自己的终端里用 sudo 密码开了 12 小时的临时 root 权限。部署的源码是提交 `d6516794530b75df65ff9f3dbc34653f271817b3`，它包含修正 `4f2b776` 和上面这些记录；与已上线的 `c71adbd` 相比，产品代码只改了 Worker 的 [`production-sandbox-execution-v2.ts`](../../../../../apps/execution-worker/src/production-sandbox-execution-v2.ts)。数据库结构没变（仍是 schema 48），所以这次不迁移、不删除任何数据。

结果：

- 生产服务已运行新版本：Agent 和 Worker 都在 21:22:39 写出 `service.ready`，这次没有出现 Worker 启动超时，服务没有自动重启；`/health/ready` 返回 `ready`；进程 uid 998、`NoNewPrivs` 为 1；服务看到的安装目录是只读挂载的 `/opt/himawari/releases/2026-09-27-4f2b776`；从运行中进程的视图读到的 Worker 程序里包含新代码（`SANDBOX_RECOVERY_UNSETTLED`）。
- 停服时间约 70 秒（21:21:28 停服到 21:22:39 就绪），中间做了完整备份并校验。
- 卡住的 `run:f52264fe…` 按所有者要求没有处理，仍停在对账中。
- 能力登记里 `himawari.pi-coding` 的旧指纹仍未更新，差异与上一次完全相同（两个指纹字段），切换脚本只接受这一种差异，没有写登记表。
- 临时 root 权限已收回：删除了 `/etc/sudoers.d/99-himawari-claude-4f2b776`，停掉了到期清理定时器，之后 `sudo -n true` 要求密码。

证据在 [`fix-4f2b776/`](fix-4f2b776/)：

| 文件 | 内容 |
| --- | --- |
| [`build.json`](fix-4f2b776/build.json) | 源码归档（3979 个文件）、源码清单、准备清单和运行时摘要 `fbce5ae6…7716`。在断网的 systemd 单元里一次构建成功。与 `c71adbd` 的安装相比只有 7 个文件不同：改过的 Worker 程序、3 个启动脚本（里面写着构建目录路径）和 3 个随构建路径变化的 better-sqlite3 编译文件；23 个网页静态文件完全相同 |
| [`qualification.json`](fix-4f2b776/qualification.json)、[`platform-probes.json`](fix-4f2b776/platform-probes.json)、[`protected-runtime-probe.json`](fix-4f2b776/protected-runtime-probe.json)、[`signer-preflight.json`](fix-4f2b776/signer-preflight.json)、[`web-static-installed.json`](fix-4f2b776/web-static-installed.json)、[`workspace-links.json`](fix-4f2b776/workspace-links.json) | 六组资格验证全部通过（Pi 22 项、组合、允许网络 10 项、拒绝网络 7 项、Worker 被杀后清理、公开搜索 3 项），签署回执摘要 `907607f5…acfc57`。资格阶段服务没有停，也没有写生产数据库 |
| [`database-before.json`](fix-4f2b776/database-before.json)、[`database-before-switch.json`](fix-4f2b776/database-before-switch.json) | 停服后和切换前：schema 48，90 个 Run、38 个对话、83 条执行记录（全部已清理、已释放），唯一未结束的 Run 是 `run:f52264fe…` |
| [`backup-verify.json`](fix-4f2b776/backup-verify.json) | 切换前完整恢复点 `before-4f2b776-2026-09-27`：schema 48，完整性检查 `ok`，15,076 个 Payload |
| [`registry-deviation.json`](fix-4f2b776/registry-deviation.json) | 能力登记与部署快照的差异，与[能力登记没有更新](#registry-deviation)相同 |
| [`cutover.json`](fix-4f2b776/cutover.json)、[`postflight.json`](fix-4f2b776/postflight.json) | 切换结果和启动后检查 |
| [`deployment-helpers.zip`](fix-4f2b776/deployment-helpers.zip)、[`deployment-helpers.sha256`](fix-4f2b776/deployment-helpers.sha256) | 本次实际运行的构建、资格、签署、启动和切换脚本；Hermes 上 root 持有的副本在 `/etc/himawari/deploy-4f2b776/`，运行前用 `frozen.sha256` 逐一核对过 |

和上一次切换脚本相比，这次的 `hermes-4f2b776-cutover.py` 去掉了迁移和删除步骤；把“能力登记不变”检查换成上一次续做脚本里“只接受 pi-coding 两个指纹字段差异”的检查；允许唯一未结束的 Run 是 `run:f52264fe…`；新版本启动失败时也会停掉它并恢复旧的 unit、配置和保护记录后启动旧版本（结构版本相同，旧版本能直接用这个数据库）。这次没有触发回退。

没有验证的部分：

- 没有发起任何模型请求，也没有用真实浏览器走聊天。修正在 Linux 真实竞争时机下是否生效，要等下次出现“先判失去控制、Worker 再提交结果”时，看 Run 是否正常结束、执行记录里是否有操作结果。
- 公开入口的首页没有从本机经 Cloudflare 打开；只检查了本机 `/health/ready` 和资格阶段、切换前以运行账号读回的 23 个静态文件。不带正式主机名直接请求本机首页返回 403，这次没有查它具体按什么拒绝。

需要回到 `c71adbd` 时：停服，用切换目录 `qualifications/2026-09-27-4f2b776-cutover/private/` 里的 `unit-before.service`、`production-before.json`、`authority-before.json`、`attestation-before.json` 恢复，`systemctl daemon-reload` 后启动。数据库结构相同，不需要恢复备份；`/opt/himawari/releases/2026-09-27-c71adbd` 保留未动。

<a id="fix-116d6db"></a>
## 升级到 116d6db（schema 48 → 49）

日期：2026-09-28（日本时间 09:05–11:29）。所有者批准“两个都按你建议的做，然后继续部署到 Hermes”，并在自己的终端里用 sudo 密码开了 12 小时的临时 root 权限。部署的源码是提交 `116d6db5417731828f2433ced9a99a06ecef5c6d`。与 `4f2b776` 相比，产品代码的改动来自这些提交：

- `e7d735c`：查找记忆时嵌入模型（把文字转成向量用于检索的模型）请求断开，不再让 Agent 进程崩溃，而是把这一轮判为失败。
- `16a6803`、`a788d31`、`2374390`：沙箱隔离拒绝和进程结果在高负载下保持一致；按文件元数据复查已审计的沙箱运行时；沙箱进程恰好在定时控制检查前退出时，不再误当作失去控制而丢掉退出结果。
- `3412faa`：只读工具（read、ls、find、grep）失败时，把 Pi 自己的报错输出交给模型。
- `116d6db`：生成对话标题的模型花费记到单独的“标题预算账户”，标题结果不确定时不再冻结这一轮对话自己的预算账户；为此新增迁移 49。

<a id="crash-0927"></a>
### 9 月 27 日 21:33 的崩溃

4f2b776 上线后，Agent 在 2026-09-27 21:33:12（日本时间）写出 `runtime.failed`（`SERVICE_STARTUP_FAILED`）后退出，systemd 15 秒后自动重启。日志只有这个笼统的错误码，原因从数据库查明：所有者新发的一轮对话 `run:bf813a27…` 先查找记忆，调用 OpenRouter 的嵌入模型 `qwen/qwen3-embedding-8b`，请求开始 0.6 秒后断开，结果记为 `transport_unresolved`（不知道对方是否收到）；这个错误逃出了负责协调这一轮的代码，Run 停在 `reconciling_external_result`，调度循环把它当作运行失败，Agent 随即退出。这正是 `e7d735c` 修正的情况，证据在 [`crash-2026-09-27.json`](fix-116d6db/crash-2026-09-27.json)。

### 结果

- 生产服务已运行新版本：Agent 和 Worker 都写出 `service.ready`；`/health/ready` 返回 `ready`；进程 uid 998、`NoNewPrivs` 为 1；服务看到的安装目录是只读挂载的 `/opt/himawari/releases/2026-09-28-116d6db`；运行中进程视图里的 Agent 程序包含新代码（`CONTEXT_MEMORY_UNAVAILABLE`）。上线后到检查时没有自动重启。
- 停服约 1 分钟（11:27:21 开始停服，11:28:43 两个进程都就绪），中间做了完整备份并校验，再把数据库从 schema 48 迁移到 49（只应用了迁移 49），外键检查 0 个错误，`quick_check` 为 `ok`。
- 模型预算账户表已有 `title_run_id` 列；已有的 91 个账户都是 Run 账户，标题账户要等下一次生成标题时才会出现。
- 卡住的 `run:bf813a27…` 没有处理，仍停在对账中；切换脚本只允许这一个未结束的 Run。
- 能力登记里 `himawari.pi-coding` 的旧指纹仍未更新，差异与 4f2b776 时逐字节相同，没有写登记表。
- 临时 root 权限已提前收回：删除了 `/etc/sudoers.d/99-himawari-claude-20260928`，停掉了到期清理定时器，之后 `sudo -n true` 要求密码。

### 执行中出的问题

- **第一次切换在入口检查处停下**（10:56）。生成切换脚本时，Claude 把 “4f2b776” 批量替换成 “116d6db”，把本应指向当前旧版本的 `OLD_START`、`OLD_PHYSICAL` 两行也改成了新版本，脚本发现服务定义里的启动命令对不上，报 `UNEXPECTED_SERVICE_UNIT` 退出。这个检查在停服和建切换目录之前，所以什么都没改。改回这两行后，与 4f2b776 的切换脚本逐行比对，只剩预期的差异。
- **重新运行被 Claude Code 的自动安全检查拦下**。改由所有者在 Hermes 上运行 `bash ~/run-116d6db-cutover.sh`：先核对修正后脚本的摘要 `46ba8384…41e8`，装进 root 持有的 `/etc/himawari/deploy-116d6db/` 并核对全部 7 个脚本，再启动切换（11:26:37）。之后的等待、检查、收回权限和取证由 Claude 完成。
- **这次构建没有放在断网单元里**：由普通用户 andy 直接运行 `build.sh`，网络没有被切断。依赖安装报告 `"cache": "warm"`，`package-lock.json` 自 4f2b776 以来没有变，依赖都来自本机缓存。

### 证据

证据在 [`fix-116d6db/`](fix-116d6db/)：

| 文件 | 内容 |
| --- | --- |
| [`build.json`](fix-116d6db/build.json) | 源码归档（3998 个文件）、源码清单、准备清单和运行时摘要 `9815e419…1c51`；与 4f2b776 相比变了 27 个安装文件（17 个产品程序和迁移文件、3 个启动脚本、3 个 better-sqlite3 编译文件、4 个网页文件），没有文件被删除；网页静态文件共 26 个（保留旧的 22 个资源，供已打开的页面继续加载）。另记录了本机上线前检查：`npm test` 通过、产品路径 E2E 8/8 通过（只用假模型）、安全检查里 semgrep 没有跑完（`SEMGREP_TOOL_FAILED`），gitleaks 的 244 条都是 `test/` 下的摘要和测试令牌 |
| [`qualification.json`](fix-116d6db/qualification.json)、[`platform-probes.json`](fix-116d6db/platform-probes.json)、[`protected-runtime-probe.json`](fix-116d6db/protected-runtime-probe.json)、[`signer-preflight.json`](fix-116d6db/signer-preflight.json)、[`web-static-installed.json`](fix-116d6db/web-static-installed.json)、[`workspace-links.json`](fix-116d6db/workspace-links.json) | 六组资格验证全部通过（Pi 22 项、组合、允许网络 10 项、拒绝网络 7 项、Worker 被杀后清理、公开搜索 3 项），签署回执摘要 `10592fca…b1bb`。资格阶段服务没有停，也没有写生产数据库 |
| [`database-before.json`](fix-116d6db/database-before.json)、[`database-after-migration.json`](fix-116d6db/database-after-migration.json)、[`database-before-switch.json`](fix-116d6db/database-before-switch.json) | 停服后 schema 48、迁移后和切换前 schema 49：91 个 Run、38 个对话、83 条执行记录（全部已清理、已释放），唯一未结束的 Run 是 `run:bf813a27…` |
| [`backup-verify.json`](fix-116d6db/backup-verify.json)、[`migrate.json`](fix-116d6db/migrate.json) | 迁移前完整恢复点 `before-116d6db-2026-09-28`：schema 48，完整性检查 `ok`，15,082 个 Payload；迁移只应用了 49，迁移命令另存的快照在 `state/data/pre-migration-v9CS9P/` |
| [`registry-deviation.json`](fix-116d6db/registry-deviation.json) | 能力登记差异，与 4f2b776 时相同 |
| [`web-static-preflight.json`](fix-116d6db/web-static-preflight.json) | 停服前以运行账号读回新版本的 26 个网页文件 |
| [`cutover.json`](fix-116d6db/cutover.json)、[`postflight.json`](fix-116d6db/postflight.json) | 切换结果和启动后检查 |
| [`crash-2026-09-27.json`](fix-116d6db/crash-2026-09-27.json) | 上面崩溃的日志、模型调用记录和 Run 检查点 |
| [`deployment-helpers.zip`](fix-116d6db/deployment-helpers.zip)、[`deployment-helpers.sha256`](fix-116d6db/deployment-helpers.sha256) | 本次实际运行的构建、资格、签署、启动和切换脚本（切换脚本是修正后的版本）；Hermes 上 root 持有的副本在 `/etc/himawari/deploy-116d6db/` |

和 4f2b776 的切换脚本相比，这次的 `hermes-116d6db-cutover.py` 在校验备份之后加了迁移 49 的步骤；迁移开始之后如果失败，只恢复旧的 unit、配置和保护记录，不启动旧版本（旧版本不能写 schema 49 的数据库），等所有者批准后再用备份恢复。这次没有触发回退。

没有验证的部分：

- 没有发起任何模型请求，也没有用真实浏览器走聊天。嵌入请求断开时是否真的只让这一轮失败、标题账户是否按设计出现，要等真实对话时再看。
- 公开入口的首页没有从本机经 Cloudflare 打开；不带正式主机名直接请求本机首页仍返回 403。

需要回到 `4f2b776` 时：停服，用旧版 CLI 恢复 `before-116d6db-2026-09-28`（schema 48），再从 `qualifications/2026-09-28-116d6db-cutover/private/` 恢复旧的 unit、配置、保护记录和启动证明后启动。schema 49 的数据库不能直接给 4f2b776 用。`/opt/himawari/releases/2026-09-27-4f2b776` 保留未动。

## 恢复方式

新服务已经启动过，按 Runbook 不自动回退数据库。需要回到 v4 时：停服，用旧版 CLI 恢复 `before-c71adbd-2026-09-27`（schema 32），再从切换目录 `qualifications/2026-09-27-c71adbd-cutover/private/` 恢复旧的 unit、配置、保护记录和启动证明。schema 48 的数据库不能直接给 v4 用。旧安装 `/opt/himawari/releases/2026-09-16-v4-0600b29` 保留未动。

## 没有验证的部分

- 没有用真实浏览器登录生产页面走一遍聊天、审批和刷新（Runbook 第 8 步）；只检查了 HTTP 就绪、首页和它引用的 2 个资源返回 200，以及资格阶段以运行账号读回的 23 个静态文件。
- 没有发起任何模型请求，新版本的真实模型对话还没有验收。
- 生产配置没有打开严格模式（没有 `taskEnvironments`），所以本分支的容器任务环境、C3 的宿主一侧发布在 Hermes 上没有被用到；部署绑定仍是 v4 的 `sandbox-host-binding.v1`，没有启用新的工具合同。

## 重新运行

脚本都绑定了本次的路径和摘要。下次升级应以 [`deployment-helpers.zip`](deployment-helpers.zip) 为模板，改成新的目录和摘要，并按[升级手册](../../../../../docs/runbooks/hermes-control-center-upgrade-runbook.md)执行：`build.sh` 在断网单元里构建；`hermes-c71adbd-qualify.py --qualify` 做资格验证并签署；`hermes-c71adbd-cutover.py --apply --receipt <回执摘要>` 停服、备份、迁移和切换；续做脚本只适用于本次的登记差异。
