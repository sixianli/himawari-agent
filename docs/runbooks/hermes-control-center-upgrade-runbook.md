---
status: active
document_type: runbook
execution_risk: critical
contract_sha256: "sha256:99bb4374ee46c70bd7dc229e76f71bc1e5da2fa24bafea16cf3eb87a88f08bae"
supersedes: ""
superseded_by: ""
date: "2026-09-11"
---

# Hermes 控制中心升级与真实验收

<!-- runbook-contract:
- apps/admin-cli/src
- apps/agent-service/src
- apps/execution-worker/src
- packages/platform-node/src
- packages/application/src/ports/configuration.ts
- packages/gateway-contracts/src/contracts-v2.ts
- packages/persistence-sqlite/src
- packages/runtime-pi/src
- packages/runtime-sandbox/src
- packages/runtime-sandbox/scripts
- scripts/package-node-runtime.mjs
- scripts/install-node-runtime.mjs
- scripts/ci/artifact-files.mjs
- package-lock.json
-->

## Scope

升级用户已明确授权的 Hermes Linux 上 Himawari 安装。目标限定 `/data/hermes/himawari`，不操作父目录中的其他 Hermes Agent 服务或其他应用。Mac 仅用于源码开发、浏览器和交付查看，不作为运行主机。此流程不执行跨主机 Authority Transfer，不创建 PR 或推送。

## Authoritative Sources

- [SOURCE: docs/execution/specs/2026-09-10-control-center-local-acceptance-design.md]
- [SOURCE: docs/execution/plans/2026-09-10-control-center-local-acceptance-plan.md]
- [SOURCE: docs/execution/plans/2026-09-07-srt-unified-execution-plan.md]
- [SOURCE: docs/adr/0027-built-in-owner-authentication.md]

## Safety and Preconditions

用户已授权在 Hermes 安装、使用机械盘、复用现有 OpenRouter 凭据进行累计不超过 1 美元的验收，并批准内置账号登录。模型调用只使用验收文本，文件操作只针对明确授权工作目录的验收文件。预算包含已发生费用及不能确定实际费用的预留，不将失败调用算作免费。

当前目标是 `hermes-home`，SSH 为 `hermes`，Cloudflare 认证无法及时完成时使用已授权的 `hermes-tailscale-breakglass`。公开入口是 `https://himawari.siyi.win`，保留现有 Cloudflare Access 和 tunnel，只更新本机 127.0.0.1:18082 的产品服务。不得改变其他账号、网络规则或共享磁盘挂载。

## Live-State Preflight

只读核对主机名、Linux/架构、`findmnt /data` 与磁盘可用空间；核对 `systemctl --user cat/status himawari.service` 的真实单元、PID、安装前缀和工作目录。检查生产配置的 Owner/Agent/deployment 与现有 authority、数据库记录一致，记录活动 Run 和已发生/预留费用，禁止输出配置全文或密钥。确认配置、state、qualifications 均是规范路径且权限安全，旧发布目录保留且可回读。

新建证据运行 ID 后，将白名单源码清单、SHA-256、秘密扫描结果和真实命令结果写入本次证据目录。工具链使用固定 Node 22.22.3/npm 11.8.0，依赖闭包来自精确 lockfile。构建、依赖、临时探针、发布和数据库全部放在 `/data`。

## Procedure

1. 检查本 Runbook 静态合同。只传输已审阅且通过秘密扫描的源码白名单；不打包配置、凭据、真实数据或历史浏览器证据。构建安装到本次独立发布目录，保留旧版本。
2. 打包统一文件和目录权限，禁止 group/other write。安装固定 Pi 工具普通文件后，针对实际安装树执行 Pi、组合、网络允许/拒绝、Worker 崩溃清理及公开搜索探针。固定探针使用合成数据；必须验证真实 namespace 释放、安装字节摘要、实际工具和 provider 返回，不能复用旧资格或伪造结果。任何产物变更后重新执行受影响资格。
3. 实测通过后，使用该主机既有受保护签名源签署本次安装事实，保存证据摘要、runtime/runner/system tool 字节摘要及精确能力上界。Pi 探针使用与正式 Worker 相同的 5 秒清理期限。Pi write/edit 使用 verified_effect，并要求安装的 Pi 程序在实际回读成功后生成内容摘要、字节数和路径；Worker 将原受保护输出绑定到持久证据，Agent 再核对原调用、Grant 和输入。不能以 exit 0 代替效果校验。bash 本轮只读，退出事实为 not_asserted。搜索为独立 fixed_read 程序，出口仅 `mcp.exa.ai:443`。两者都要求既有目录 Grant 和逐次动作/披露批准。
4. 在切换前复查旧服务无活动 Run。停止已核验的 `himawari.service`，检查旧 Agent/Worker 退出与锁释放；使用旧安装的正式 backup create/verify 命令保存并核验恢复点，同时私密保留配置、单元和旧签名启动器。不能删除活动锁或清理未知子进程。
5. 用新安装的 `db migrate --confirm APPLY_MIGRATIONS` 升级同一数据库。该命令在停机独占锁内用 SQLite backup 创建并校验同主机迁移前快照，存于 state/data 下新建的 0700 目录，文件 0600；输出 snapshotPath，重复执行且无待迁移时不再创建快照。此快照不替代步骤 4 的完整恢复点。保留原 Owner、Agent、部署、对话、授权和受保护 Payload。只有没有外部 Owner 绑定时才通过 `account create` 建立内置账号；已有绑定不得自动覆盖。Hermes 当前保留 Cloudflare 产品登录，内置账号迁移须明确确认具体 Owner 与会话撤销影响后另行执行。密码输入和验证器设置只放在 0700 目录中的 0600 文件。
6. 通过 `workspace grant` 授权已核验的工作目录，并明确确认其规范绝对路径；默认仅 read/create/update，不代替动作审批。通过 `capabilities register` 显式确认合格部署快照摘要并写入现有 Registry；不得手工插入批准或资格记录。
7. 更新已核验的同一 systemd 用户服务启动路径。启动器每次核对主机、签名、证据和实际 runtime 字节，再生成本次启动快照；随后启动独立 Worker 与 Agent。初次握手使用配置的 Worker 请求期限，须等待实际 service.ready，不能以 systemd active 代替就绪证据。运行中复查快照原字节，不能因启动超过五分钟失去能力，也不能接受被修改的快照。
8. 使用真实浏览器登录原 HTTPS 入口，完成聊天、多轮上下文、工具审批与文件、公开搜索、停止、刷新和服务恢复。实际调用沿用预算与披露校验；不把通过 HTTP 或受控测试写成真实模型验收。

仅浏览器静态资源变化时，服务端安装字节与资格保持不变；先验证可移植 Web 构建、体积和安全检查，按显式清单校验上传的静态文件。先安装带内容哈希的新资源，对同名文件要求字节完全一致，再保存原 index.html 并原子替换入口。保留旧资源以支持正在打开的页面，不为网页更新重启 Agent/Worker。最终在正式 URL 刷新验证，分别记录服务端资格版本与 Web 资源摘要。

## Verification

必须回读正式服务 PID、安装路径、握手和真实 Run 状态。SQLite quick check 通过且旧记录保留；模型与工具记录按轮持久化；文件内容须从主机独立回读确认。批准前不能产生文件或出口；拒绝后不能执行。搜索显示实际来源及查询时间，过期资料必须明确说明。重启后身份、聊天、草稿边界及旧结果符合合同，不能重新执行原工具。

## Evidence

主机原始证据限定 `/data/hermes/himawari/qualifications/<本次运行 ID>/`，目录 0700、文件 0600；公开可提交副本限定 `test/qualification/evidence/hermes-web-2026-09-11/`，仅保留脱敏摘要、公开合成验收、截图与运行结果。密码、TOTP、恢复码、私钥、配置全文及真实用户 Payload 不进入仓库、日志、模型或聊天。

## Rollback

切换前失败保持旧服务。切换后失败先停止本次服务，保留新状态与失败证据。仅代码兼容且 schema 一致时可恢复旧前缀；schema 已升级时不得直接让旧二进制打开新数据库。数据库恢复必须使用已核验恢复点的独立目标并再次核验身份，不能覆盖当前数据；未获该具体恢复授权时保留停机现场，报告所需决策。不得自动撤回已执行外部动作或清除未知结果。

## Stop Conditions

主机、路径、身份、预算不明确；静态合同或实际安装验证失败；签名/摘要/权限/namespace 证据不匹配；活跃 Run 无法正常停机；恢复点不通过；迁移、身份、握手失败；需要放宽授权、访问其他用户数据或修改 Cloudflare 策略。停止依赖步骤，继续不依赖它的源码修复和验证。

## Troubleshooting

`SANDBOX_HOST_PATH_UNSAFE` 先核对精确路径及 mode，以及 SRT Unix socket 路径长度；生产 jobId 使用完整 SHA-256 的 base64url 编码缩短目录名，外部恢复 ID 合同不变；重新正确打包和验证，不放宽检查。Provider 429 显示限流/过载，保留未知费用与失败记录，不伪造完成。`result_unknown` 检查原环境终态及 namespace，不能通过清空占用重跑。SSH 未认证先使用已授权替代链路；不得打印 Cloudflare 一次性认证链接中的令牌。

模型配置中的 `reasoningRequired: true` 用于 Provider 明确要求思考的端点，需同时 `reasoning: true`。确认菜单不再提供 off，当前轮记录保留实际选择。审批详情必须能显示含斜线和中文的目录目标；不得将加载失败当成批准或跳过审批。

恢复审批须读取已有冻结请求，不能用新时间重写同一持久化 key。验收核对 Pi 工具真实失败标记、审批等待扣除和文件回读；是否要求近期认证以实际审批合同为准，不以“工具”一概判断。

若计划在 Worker 准入前拒绝，比较实际请求与签名能力的每个资源额度；正式组合必须逐项取较小值，不能直接扩大签名上限。Trace 的 Runtime 和授权审计并发时使用数据库原子序号分配；不得删除审计记录、重置序号或重发工具来消除冲突。

前台任务也必须核对清理。已取消/失败的 Run 可以通过原停止命令再次核对，禁止重新运行其模型或工具。协调器完整性核验使用现有 30 秒上限；不要把 Job Host 的 5 秒进程退出期限与包括安装文件核验的协调期限混为一谈。机械盘主机可配置 Worker 等待 300 秒、Run 900 秒、Provider 120 秒，仍逐项受已签名能力上限约束。升级旧安装前先使用相同安装和原受保护证据释放遗留环境；只有规范协调器核验并持久化 released 才能报告清理完成。

若旧 fixed_read 已有真实结果及清理证据，却仍保留 SANDBOX_NOT_STARTED 效果，先核对其固定只读合同、结果绑定与原安装字节，再通过现有 Journal CAS 补充 not_applicable；不能把写操作、未知退出或未经验证的副作用套用此修复。维护进程在服务停止后正常取得独占 Authority，保留旧安装做核验，结束后释放 Authority；不继承旧 Worker 的执行权，不直接更新数据库列。候选版本的同一受测验证/持久化组件可用于这次受限修复，随后才替换安装树。
