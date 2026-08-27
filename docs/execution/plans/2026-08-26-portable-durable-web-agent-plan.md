---
status: active
document_type: plan
supersedes: ""
superseded_by: ""
date: "2026-08-26"
---

# Himawari Agent v0.2 持久 Web 基础 Implementation Plan

**来源 Spec：** [SOURCE: docs/execution/specs/2026-08-26-portable-durable-web-agent-design.md]

**v0.2 Spec 套件：** [SOURCE: docs/execution/specs/2026-08-26-v0.2-spec-suite-integration-design.md]

**目标：** 在已完成的 Foundation 边界上，实现一个可在 Mac 与 Hermes 正式启动、跨正常重启恢复、经受认证公共 Web 使用，并可通过停机加密迁移切换单一活动权威的 Himawari Agent 基础切片。

**架构：** 保持 domain、contracts 和 application 的产品自有边界，以 SQLite 作为单一产品状态权威，以受保护 Payload、host-specific secret source、Mem0 projection、HTTP+SSE Gateway、Cloudflare 身份断言、GitHub App 和 execution.v1 over UDS 作为外层 adapters。Agent Service 负责权威、接纳、编排和持久结果；Execution Worker 作为独立受限进程执行已授权能力；Pi Session 继续只是可重建的单 Run runtime projection。

本 Plan 只实施来源 Spec 的“持久 Web 基础切片”。Thread/对话、控制中心体验、行动授权与能力治理、Web 研究、文件与代码工作区、Apple/iCloud Calendar、主动性/Worker/自我改进和生产资格现已分别由 active 且已确认的 Specs 设计，现在可以各自派生 Plan。本 Plan 不越界实现隐藏半成品，也不把基础切片完成等同于 v0.2 production-ready。

---

## 执行授权与停止点

本 Plan 只规定实施顺序和验证证据，不因文档存在而自动授权代码实现或外部副作用。未来执行时必须遵守以下停止点：

- 新增或升级直接依赖前，先提交精确版本、许可证、维护状态、Node.js `>=22.19.0` 兼容性、Mac/Hermes 原生二进制产物可用性、安全记录和 lockfile 影响；取得 Owner 授权后才能安装或提交依赖变更。
- 第一次真实生成模型、嵌入模型或 Mem0 所依赖模型调用前，先提交 primary、fallback、embedding 的精确身份或 snapshot、能力、披露范围、费用结构、预计成本和有上限测试预算；取得 Owner 对实际调用和费用边界的授权。
- 创建或修改 Cloudflare、GitHub App、DNS、Tunnel、MFA、webhook、仓库安装范围或其他外部账户状态前，展示精确目标、权限、外部变化和回退边界并取得授权。
- 在 Mac 或 Hermes 安装 service、修改 launchd/systemd、切换公共入口、执行真实 transfer、恢复、密钥轮换或生产验收前，完成只读 preflight，展示目标主机、资源影响、变更顺序和回退边界并取得对应授权。
- 永久删除、清空 state root、销毁迁移包、使旧权威不可启动或清理 7 天保留副本属于破坏性动作，必须逐次确认并以只读证据解析精确目标。
- 如果 compatibility spike、实现或真实平台证据否定本 Spec 的 adapter、数据模型、安全边界或恢复语义，立即停止相关任务；先修订或 supersede Spec/ADR，再继续实施，不能在 Plan 中暗自引入新设计。
- 每个任务只暂存和提交该任务范围内的变更；发现用户已有改动时先盘点，重叠范围必须交由 Owner 决定。

## 文件边界

### 新建

- SQLite 产品状态 adapter：
  - `packages/persistence-sqlite/`
  - `packages/persistence-sqlite/src/migrations/`
  - `packages/persistence-sqlite/test/`
- Mem0 projection adapter：
  - `packages/memory-mem0/`
  - `packages/memory-mem0/test/`
- GitHub App adapter：
  - `packages/integration-github/`
  - `packages/integration-github/test/`
- 浏览器控制中心：
  - `apps/control-center/`
  - `apps/control-center/src/`
  - `apps/control-center/test/`
- 离线管理 CLI：
  - `apps/admin-cli/`
  - `apps/admin-cli/src/`
  - `apps/admin-cli/test/`
- 正式部署资产，在对应实现与验证存在后创建：
  - `packaging/launchd/`
  - `packaging/systemd/`
  - `packaging/cloudflare/`
- 跨进程、浏览器、安全、持久性、规模与迁移验证：
  - `test/fixtures/memory/`
  - `test/fixtures/github/`
  - `test/integration/persistence/`
  - `test/integration/process/`
  - `test/integration/security/`
  - `test/e2e/browser/`
  - `test/e2e/migration/`
  - `test/performance/`
- 只有操作已经实现并被实测后，才从 Runbook 模板创建对应文件：
  - `docs/runbooks/install-start-stop-runbook.md`
  - `docs/runbooks/backup-restore-runbook.md`
  - `docs/runbooks/authority-transfer-runbook.md`
  - `docs/runbooks/secret-rotation-runbook.md`
  - `docs/runbooks/github-app-setup-runbook.md`
  - `docs/runbooks/identity-gateway-runbook.md`
  - `docs/runbooks/incident-diagnosis-runbook.md`

### 修改

- 根工程契约：`package.json`、`package-lock.json`、`tsconfig.json`、`vitest.workspace.ts`、`biome.json`、`scripts/check-boundaries.mjs`。
- 产品领域与状态机：`packages/domain/src/`。
- 稳定 wire contracts：`packages/gateway-contracts/src/`、`packages/execution-contracts/src/` 及其 v1 fixtures；不兼容变化必须使用新 schema version，不能偷偷改变现有 v1 fixture 的语义。
- 产品端口与应用服务：`packages/application/src/ports/`、`packages/application/src/services/`、`packages/application/src/index.ts`、`packages/application/src/runtime-port.ts`。
- Node 信任边界：`packages/platform-node/src/`，包括严格配置、state-root lock、Payload encryption、host secrets、HTTP/SSE、UDS、health、日志与指标 adapters。
- Pi 运行时投影：`packages/runtime-pi/src/` 和 compatibility tests；继续禁止 Pi 类型扩散到产品端口。
- 正式服务组合：`apps/agent-service/src/`、`apps/execution-worker/src/` 及其 package scripts；保留现有 deterministic local composition 作为测试 profile。
- 可复用 conformance 与故障注入：`packages/testing/src/`、`packages/testing/test/`。
- 当前事实与使用入口：`README.md`、`docs/architecture-v0.1.md`；只在相应行为实现并验证后更新。
- 源 Spec 只在证据发现真实设计冲突且 Owner 确认后修改；ADR 的决策、背景、选项和后果不得由本 Plan 改写。

### 测试

- `packages/domain/test/`
- `packages/application/test/`
- `packages/gateway-contracts/test/`
- `packages/execution-contracts/test/`
- `packages/persistence-sqlite/test/`
- `packages/platform-node/test/`
- `packages/memory-mem0/test/`
- `packages/integration-github/test/`
- `packages/runtime-pi/test/`
- `packages/testing/test/`
- `apps/agent-service/test/`
- `apps/execution-worker/test/`
- `apps/control-center/test/`
- `apps/admin-cli/test/`
- `test/integration/`
- `test/e2e/`
- `test/performance/`

### 依赖方向

```text
apps/agent-service → application + contracts + approved adapters + runtime-pi
apps/execution-worker → application + execution-contracts + approved adapters
apps/control-center → gateway-contracts + browser-only UI dependencies
apps/admin-cli → application + approved offline/admin adapters

persistence-sqlite → application + domain + product contracts
memory-mem0 → application + domain
integration-github → application + domain + product contracts
platform-node → application + domain + product contracts
runtime-pi → application/runtime-port + @earendil-works/pi-*
application → domain + product contracts
contracts → no internal dependency
domain → no internal dependency
testing → application + domain + product contracts
```

`scripts/check-boundaries.mjs` 必须识别全部新 workspace，拒绝反向依赖、循环、未声明依赖、非精确直接外部版本、越出 workspace 的相对 import、纯层 `node:` import，以及 `packages/runtime-pi` 之外的任何 `@earendil-works/pi-*` import。

## 实施任务

### Task 1：固定基线、追踪矩阵与执行证据格式

- [x] 在任何实现改动前记录 `git status --short --branch`、Node/npm 版本、现有 workspace、依赖 lock、Architecture Known Limitations 和全部当前测试结果。
- [x] 运行现有 `npm run check`、unit、contracts、integration、e2e、Pi compatibility 与 strict document validation，保存精确命令、退出状态、测试数量和 skip 原因。
- [x] 建立本 Plan 的 Spec 验收映射：每个验收项绑定负责 Task、测试入口、Mac/Hermes 证据和外部授权门槛。
- [x] 定义每个 Task 的证据记录格式：改动范围、设计来源、验证命令、结果、未验证项、外部副作用和 Git commit。
- [x] 证明当前 `main` 与 `origin/main` 的关系，并在每个后续任务开始前重新盘点工作树；不把干净工作树误当成远端同步证明。

Task 1 的 evidence format 位于 `test/fixtures/v0.2/task-evidence.schema.json`，fresh baseline 位于 `test/integration/qualification/evidence/s1-task1-baseline.json`；S1-A01–S1-A09 的任务、证据和验证入口由 `test/fixtures/v0.2/coverage-manifest.json` 固定。

### Task 2：完成外部依赖与平台兼容性 preflight

- [x] 仅从上游官方文档、release、registry metadata 和安全公告收集候选版本；分别核验 better-sqlite3、mem0ai/oss、HTTP/JWT、Web UI/build、GitHub App client 和必要密码学依赖。
- [x] 对每个直接依赖记录精确版本、许可证、Node.js engine、维护状态、原生二进制产物来源、Mac 与 Hermes CPU/OS 支持、传递依赖和已知阻断性问题。
- [x] 在隔离 spike 中读取实际 `sqlite_version()`，验证 WAL、Backup API、worker-thread/专用持久化执行上下文和 Node.js `>=22.19.0`；不得只根据 npm package 版本判断安全。
- [x] 在 Mac 与 Hermes 分别运行 Mem0 OSS add/search/update/delete/history、显式 LLM/embedder/vector/history 配置、重启持久性、并发、telemetry 和隐藏 provider-call 检查。
- [x] 对 HTTP/SSE、JWT/JWKS、GitHub App、前端构建与可访问性栈建立最小兼容 spike；禁止在 spike 中改外部账户或使用生产秘密。
- [x] 汇总建议的精确 dependency set、manifest diff 和 lockfile 影响，等待 Owner 授权；未授权前不得安装或提交新依赖。
- [x] 任一 mandatory spike 失败时停止，不得静默替换为 Mem0 Cloud、OpenViking、共享数据库、第三生成模型或另一身份网关。

Task 2 的精确版本、许可证、engine、传递依赖、原生产物、双平台结果、lockfile 影响和已知风险位于 `test/integration/qualification/evidence/s1-task2-dependency-matrix.json`，任务命令与外部副作用记录位于 `test/integration/qualification/evidence/s1-task2-dependency-preflight.json`。Mac arm64 Node 25.6.0 与 Hermes x86_64 Node 22.19.0 均运行到 SQLite 3.53.2；SQLite、Mem0、HTTP/SSE、JWT/JWKS、GitHub App、严格 TypeScript 和 Vite build mandatory spikes 全部通过，Mac 额外完成 Chromium 交互与 axe 零违规扫描。

固定候选集保持 Owner 已批准的精确直接版本。`mem0ai@3.1.7` 的公开声明会引用未安装的 optional provider 类型，因此正式 adapter 必须通过运行时动态加载和产品自有最小结构类型隔离供应商声明；`better-sqlite3@12.11.1` 的 `prebuild-install@7.1.3` 已停止维护，但 Mem0 当前 peer 范围尚不支持 13.x，故把它保留为已知升级风险而不静默换型。真实模型费用、Cloudflare/GitHub 外部账户和正式部署仍保留各自停止点。

### Task 3：扩展 workspace、构建与边界检查

- [x] 为 `persistence-sqlite`、`memory-mem0`、`integration-github`、`control-center` 和 `admin-cli` 创建最小 package/tsconfig/export 边界；所有获批直接外部依赖使用精确版本。
- [x] 更新 root build/test scripts，使 Node 服务、browser bundle、CLI、contracts 和 compatibility projects 可以独立构建与测试。
- [x] 扩展 `scripts/check-boundaries.mjs` 的依赖图和 Node/browser import 规则，并为每个非法方向添加可重复 negative probe。
- [x] 保留 `packages/runtime-pi` 对 Pi 的唯一导入权；确认 committed manifest/lockfile 不出现 `../pi-mono`、`file:` 或未固定版本。
- [x] 增加 build artifact manifest 与 package checksum 入口，为以后不依赖源码 checkout 的安装和发布验证提供稳定证据。
- [x] 运行 `npm run check:boundaries`、类型检查和空 workspace 测试，确认基础脚手架不改变现有行为。

Task 3 把 workspace 从 9 个扩展到 14 个，并把 Node、browser、CLI、contracts、Pi compatibility 和 scaffold 测试入口分开。边界测试覆盖依赖图的每个非法方向及 Node/browser/Pi/local-locator 规则；正式 lockfile 包含 564 个 package entries、14 个 workspace 和全部精确直接外部版本，不包含 `../pi-mono`、`file:` 或 `link:` locator。

`scripts/generate-artifact-manifest.mjs` 生成根 manifest/lock、14 个 package 内容和 browser build artifacts 的 SHA-256 入口。实现与验证证据位于 `test/integration/qualification/evidence/s1-task3-workspace-scaffold.json`；新增 adapters、Control Center 与 admin CLI 仍只是边界脚手架，真实行为从后续任务开始。

### Task 4：扩展产品领域、协议和端口

- [x] 先为 deployment、authority epoch/fence、Thread/message/checkpoint、browser session/device、job/occurrence、Memory generation、GitHub receipt/coverage gap、backup/transfer 和 health 状态编写 domain 与 contract tests。
- [x] 保留现有 Owner/Agent/Thread/Session/Run/Trigger 身份；新增稳定 product IDs 和显式状态机，不把数据库 row ID、Mem0 ID、Cloudflare subject 或 GitHub delivery ID 当作产品主键。
- [x] 扩展 `gateway.v1` 的 Thread/chat、approval、task、inbox、Memory、Trace、session/device 和 health 命令/查询/事件；若现有 v1 无法兼容，新增明确的新 schema version 与 fixture。
- [x] 扩展 `execution.v1` 的 handshake、readiness、cursor replay、deadline、cancellation、resource ceiling 和 reconcile 消息，并保持大正文只传 Payload reference。
- [x] 新增 persistence、configuration、identity assertion、session/device、Thread checkpoint、Memory projection、GitHub、backup/transfer 和 health ports；禁止 driver、HTTP framework、JWT、Mem0 或 GitHub SDK 类型进入 application/domain/contracts。
- [x] 对风险、授权、数据等级、secret exclusion、stale fence 和不支持 schema 编写 fail-closed contract tests。
- [x] 运行 domain、contract、type 和 boundary tests，冻结兼容 fixtures 后再进入 adapter 实现。

v1 strict parsers 无法在不改变既有接受集合的情况下安全加入新消息，因此 Task 4 保持原 `gateway.v1` / `execution.v1` fixtures 不变，并新增显式 `gateway.v2` 与 `execution.v2`。v2 信封固定 deployment/authority epoch/fence、数据等级、风险与授权引用；正文、Worker 输入输出和 secret 只传引用。协议与领域测试会拒绝缺授权的高风险请求、零或 stale fence、不支持 schema、未知字段、raw secret 和非法终态恢复。

新增产品端口覆盖 persistence lifecycle、严格 configuration、identity assertion、product session/device、Thread message/checkpoint、Memory product state/projection、background work、GitHub receipt/gap/read、同机 recovery point、authority transfer、health 及 v2 Gateway/Worker transport。产品层 source scan 明确禁止 driver、HTTP framework、JWT、Mem0 与 GitHub SDK 类型。实现与验证证据位于 `test/integration/qualification/evidence/s1-task4-domain-contracts.json`。

### Task 5：冻结 SQLite schema 与不可变 migration 机制

- [x] 从 Spec 的 schema 分组建立规范化表、foreign keys、unique constraints、revision/CAS、authority fence、outbox、Payload ownership、deletion tombstone 和 migration ledger。
- [x] 为每个 schema 对象写明产品端口、生命周期、加密分类、删除关系、迁移与恢复责任；禁止出现无法追溯到产品模型的供应商权威表。
- [x] 实现带 sequence、name 和 SHA-256 digest 的 immutable migration loader；历史 migration 内容改变、顺序缺口、未知已应用 migration 或 digest mismatch 必须拒绝启动。
- [x] 固定 `foreign_keys=ON`、本地磁盘 WAL、authority/product commit `synchronous=FULL`、有界 busy timeout 与受控 checkpoint policy。
- [x] 实现 expand/backfill/verify/contract migration 骨架，并在迁移前要求一致、已验证的同机 snapshot；应用回滚不得自动执行数据库 downgrade。
- [x] 用真实 SQLite 文件验证 fresh create、连续 upgrade、重复执行、并发启动、损坏 ledger、未知新 schema 和旧二进制拒绝写入。

Task 5 以 40 个产品表和 2 个内部治理表冻结首版 SQLite schema；`schemaCatalog` 逐表记录产品端口、生命周期、加密/Payload 分类、删除关系和 migration owner。两个连续 SQL migration 的 SHA-256 进入不可变 ledger，loader 与启动检查会拒绝 gap、历史 digest 改变、损坏 ledger、未知未来 schema 和旧 writer；change set 只允许沿 `expand → backfill → verify → contract` 前进，不提供自动 downgrade。

真实文件连接固定 foreign keys、WAL、FULL synchronous、5000 ms busy timeout 和 1000 页 checkpoint policy。已有 schema 升级前必须提供 SQLite backup API 生成并经 integrity、主机、源路径、sequence 与 digest 验证的同机 snapshot。契约测试覆盖 fresh create、1→2 连续升级、重复执行、并发锁竞争、外键、幂等结果、Outbox、Payload ownership 与删除墓碑；实现与验证证据位于 `test/integration/qualification/evidence/s1-task5-sqlite-schema.json`。专用 execution context、state-root lock、单 writer transaction 与生产 repositories 从 Task 6–7 实现。

### Task 6：实现 SQLite 连接隔离、事务与权威 fencing

- [x] 在专用 persistence execution context 中独占 SQLite connection；证明同步 driver 调用不会阻塞 Agent Service 的 HTTP/model event loop。
- [x] 实现 state-root 独占锁、单 writer queue、transaction duration、busy timeout、WAL checkpoint 和 disk headroom 采样。
- [x] 把 ProductState、idempotent command result 和 pending Reliable Event 映射到同一 transaction，并在 commit 前验证 lease ID、fencing token、expected revision 和 command fingerprint。
- [x] 实现 authority/deployment/epoch/retired 状态持久化；inactive、retired、stale epoch 和旧 Worker/Gateway 消息一律不能提交。
- [x] 对 transaction 的每个 mutation checkpoint 做 child-process kill/restart，证明不会出现 state-only、result-only 或 event-only 的部分提交。
- [x] 验证 concurrent duplicate command 收敛、SQLite busy 有界处理、long reader checkpoint、disk full 与实际 WAL recovery。

Task 6 新增专用 Worker execution context；主线程只通过结构化消息访问由 Worker 独占的同步 SQLite connection。显式 state root 由带 host/PID/token 的原子目录锁保护，正常关闭核对 token，崩溃恢复只回收已确认死亡进程的专用锁。writer queue、transaction duration、busy timeout、WAL bytes/checkpoint、filesystem free bytes 和 disk headroom restriction 都有可观察状态。

四段新增 migration 按 `expand → backfill → verify → contract` 增加 `product_state_records`，并把 Outbox 从“一命令最多一个事件”无损升级为一命令可含多个稳定事件。Product State、command result 和 pending events 在单个 `BEGIN IMMEDIATE` transaction 中提交；持久 `AuthorityLeasePort` 与 `DeploymentAuthorityStatePort` 负责单 live lease、续期/过期、单调 fence、active epoch 和永久 retired。17 项真实文件集成测试复用正式 Product State/Authority conformance，并覆盖 event-loop isolation、并发重复、state-root lock、stale authority、20 ms busy、长 reader checkpoint、headroom、真实 `SQLITE_FULL`、三个 transaction mutation kill 点和 COMMIT 后回包前崩溃重放。实现与验证证据位于 `test/integration/qualification/evidence/s1-task6-sqlite-transactions.json`。

### Task 7：实现生产 repositories、outbox 与持久 Read Model

- [x] 让现有 persistence、Trace、authorization、capability、scheduler、attention、delivery、audit 和 deletion conformance suites 可以直接运行 SQLite harness。
- [x] 实现 ProductStateRepository、ReliableEvent、Trace、Payload metadata、Audit、Authorization、Capability、Scheduler、Attention、Delivery 和 Gateway Read Model 的 SQLite adapters。
- [x] publisher 使用可恢复 claim/lease 和稳定 event ID；在 sink 已接收但 acknowledgment 未提交时重放同一事件，由 consumer dedupe。
- [x] 实现持久 cursor、scope-safe event query、retention watermark 和 bounded snapshot refresh 所需的 read model 记录。
- [x] 启动时恢复 pending outbox、expired claims、未终结 Run、待审批、待投递、未完成删除和可安全重试的工作。
- [x] 用多进程与重启测试证明进程内 reference adapter 和 SQLite adapter 遵守同一产品契约，同时明确 reference profile 不代表生产耐久性。

Task 7 把 Trace、受保护 Payload 记录、Audit、Authorization/Grant、Capability Registry/Handle、Scheduler、Attention/Delivery、Session 删除与 Gateway Read Model 全部接入 Task 6 的同一专用 SQLite Worker，不允许适配器另开旁路连接。正式 reference conformance suite 直接运行真实 SQLite harness；Attention State suite 同时覆盖 Delivery Request 的原子创建、单客户端 claim、失败重开和终态确认，外部 `DeliveryPort` 仍是客户端 I/O 边界而不是数据库端口。

第七个不可变 migration 增加完整记录列、Attention policy revision、Gateway Thread/Run snapshots、cursor-ordered stream events、retention metadata 和 consumer receipt。Outbox publisher 使用带到期时间的 claim，只有匹配 claim 才能提交 acknowledgment；sink 成功但 acknowledgment 未提交时，冷启动回收过期 claim 并以原 event ID 重放，consumer receipt 对 `(consumer_id, event_id)` 做持久去重。Gateway 查询强制 Owner/Agent scope，snapshot revision 单调且 Thread 引用窗口有界，cursor 低于 retention watermark 后返回明确的 not-found。

冷启动在对外提供 repository 前恢复过期 Outbox claim，并把中断的 `delivering` 请求带新 revision 重开为 `pending`；恢复报告同时枚举未终结 Run、待审批、待投递、未完成删除及 `queued/retry_wait` occurrence。19 项 Task 7 集成测试叠加 Task 6 的 17 项多进程/事务测试，证明正式 SQLite adapter 与进程内 reference adapter 共享产品契约，并证明重启后的删除、Outbox、Delivery、审批、调度重试和 Read Model 状态仍可恢复。实现与验证证据位于 `test/integration/qualification/evidence/s1-task7-durable-repositories.json`；reference profile 仍只用于确定性测试，不提供跨进程耐久性。

### Task 8：实现生产 Payload 加密与 host secret sources

- [x] 为 versioned envelope encryption、唯一 nonce、AAD 绑定、tamper rejection、digest、DEK/KEK version、rewrap 和 key rotation 先写 known-answer 与属性测试。
- [x] 以维护中的 authenticated-encryption primitive 实现 production `PayloadProtectorPort`；禁止 `test-xor-v1` 被正式配置选择。
- [x] 让小 Payload 和可选 content-addressed ciphertext file 走同一 ownership/lifecycle conformance；缺文件、有孤儿、digest/tag 错误均形成明确 integrity failure。
- [x] 实现 macOS Keychain-backed secret material adapter，以及 Hermes systemd credential/encrypted credential 或权限等价 secret-file adapter。
- [x] production readiness 拒绝 environment/in-memory secret source；产品状态、Trace、日志、迁移包和错误只能保存 secret reference、version、purpose/scope 与验证结果。
- [x] 在 model、Memory、GitHub、Worker 和 identity 路径执行 secret-format exclusion；测试原值不会进入模型输入、provider input、Memory、Trace、日志、错误或迁移包。

Task 8 使用 Node.js 维护中的 AES-256-GCM primitive 实现 `aes-256-gcm-envelope-v1`：每个 Payload 生成独立 DEK、payload nonce 与 wrapping nonce，AAD 固定绑定 Owner、Agent、Payload、classification、content type 和算法版本；SQLite 只保存认证 envelope 元数据，KEK 由 host secret source 即时解析。rewrap 只解开并重新包装 DEK，不解密正文；`test-xor-v1`、environment 和 in-memory source 在 production assertion 中均 fail closed。

小 ciphertext 保持 SQLite blob，超过阈值的 ciphertext 使用受限权限的 content-addressed file；同一 `PayloadStorePort` 负责引用生命周期，integrity inspector 区分 missing、digest corruption 和 orphan。Mac adapter 通过 `/usr/bin/security` 读取 Keychain generic password；Hermes adapter 读取显式 systemd credential 或权限等价的绝对 secret directory，并拒绝 symlink、相对路径及 group/other 可读权限。稳定机器秘密规则只输出 rule ID/count，gateway/execution contracts 继续拒绝 raw secret 字段，model trusted adapter、Trace redaction 及后续 Memory/GitHub/Worker/identity 边界复用同一 exclusion policy。实现与验证证据位于 `test/integration/qualification/evidence/s1-task8-payload-security.json`；真实 Keychain/systemd credential readback 留在 Task 28 的双平台 immutable install 验收。

### Task 9：实现严格配置、state-root 生命周期与健康模型

- [x] 定义版本化、未知字段拒绝的非秘密配置 schema，覆盖 IDs、paths、public origin、model/Memory descriptors、repository allowlist、secret refs、预算、并发与 deadline。
- [x] 实现显式 state root、目录权限、runtime/cache 分区、lock 文件和 authority.json 的原子读写；不得从当前工作目录推断生产路径。
- [x] 按 Spec 顺序实现 startup coordinator：配置、secret refs、deployment lock、authority、SQLite/version/migrations、Payload、repositories/outbox、models/Mem0、Worker、scheduler、HTTP readiness。
- [x] 实现 liveness、readiness 和 authenticated dependency health；provider reachability 可以 degraded，但 authority、schema、keyring、Worker、Mem0 persistence、recovery 与 public identity trust root 不满足时不得 ready。
- [x] 实现 drain coordinator：先撤销 readiness 和 admission，再停止 scheduling/publisher，checkpoint 或取消在途 Run，最后关闭 Memory/SQLite/socket 并释放 authority。
- [x] 为每个启动/关闭阶段注入失败，验证稳定机器码、无秘密诊断、无半 ready 和可重复恢复。

Task 9 固定 `himawari.configuration.v1` 严格 JSON contract，所有层级拒绝未知字段、相对或隐式路径、非同源 public URL、未声明 secret ref、重复 descriptor、越界预算/并发/deadline 和机器秘密格式。`stateRoot`、`runtimeDirectory`、`cacheDirectory` 与 Mem0 持久目录必须显式配置；state-root 初始化建立权限受限的 data/runtime/cache/Payload 分区，沿用 Task 6 的独占 deployment lock，并用同目录临时文件、fsync 与 rename 原子维护 `authority.json`。

startup coordinator 固定 11 个有序阶段，从 configuration 到 HTTP readiness；任一阶段失败按逆序 rollback，错误只暴露稳定 phase code。drain 固定先撤销 readiness/admission，再停止 scheduler/publisher、settle in-flight Runs、关闭 Memory/SQLite/socket，最后释放 authority/lock，即使中间阶段失败也继续执行剩余安全关闭。health model 把 liveness 与 readiness 分开：authority、schema、SQLite、Payload keyring、Worker、Mem0 persistence、recovery 和 public identity trust 为 required，model provider reachability 只产生 degraded。24 项 Task 9 新增 unit tests 对每个 startup/drain 阶段逐一注入失败并证明无 half-ready、无秘密错误与失败后可重复启动；实现与验证证据位于 `test/integration/qualification/evidence/s1-task9-startup-health.json`。

### Task 10：实现 execution.v1 over UDS 与真实 Worker 进程

- [x] 先写 UDS transport contract tests，覆盖 `0700` runtime 目录、`0600` socket、boot-scoped token、schema handshake、body limit、deadline、cursor、取消和重连。
- [x] 在 Agent Service 实现 execution client，在 Execution Worker 实现 HTTP/JSON server；所有消息继续经过严格 parser（Task 4 已冻结为 `execution.v2`，见下方说明）。
- [x] Worker 启动时验证 instance identity、当前 boot token、支持 schema、resource ceiling 和 adapter registry；不能直接打开 `product.sqlite` 或签发授权。
- [x] 实现 work.execute、work.cancel、work.reconcile、event subscription 和 readiness；大输入/结果只使用 Payload/secret/capability handles。
- [x] 对重复请求、重复结果、stale handle、stale fence、Worker crash、Agent crash、socket replacement 和未知外部结果运行真实 child-process tests。
- [x] 证明 Agent Service 不会在 Worker unavailable 时静默降级为进程内执行。

Task 4 已确认严格 v1 parser 不能兼容 handshake、authority fence、resource ceiling 与 cursor 字段，因此本 Task 标题和来源 Spec 中的“execution.v1 over UDS”作为 Worker protocol 的历史名称保留，实际 wire transport 使用已经冻结的 `execution.v2`，原有 `execution.v1` fixture 与接受集合没有变化。`ExecutionUdsServer` 在权限为 `0700` 的 runtime directory 上绑定 HTTP/JSON Unix socket 并设为 `0600`，同时验证 Owner-only boot token、Agent Service instance、bounded body、content type 和 request deadline；活动 socket、普通文件替换与 inode race 均 fail closed，只有同一账户拥有且确认无人监听的 crash residue 才能在 inode 复核后移除。

Agent Service 的 production client 必须先完成 schema/instance/boot-token handshake；Worker 不可用时返回 `EXECUTION_WORKER_UNAVAILABLE` 并撤销 client readiness，不存在进程内 fallback。Production Worker 只依赖注入的 `ExecutionWorkerService`、已注册 adapter 清单和短期 handle，不依赖 SQLite persistence 或授权签发服务；它验证当前 deployment epoch/fence、adapter version/operation 和配置上限，并对 wall deadline、progress 上限、重复 identity、stale handle、取消、cursor replay 与未知外部结果执行 fail-closed 处理。5 项 UDS contract tests、6 项 Worker unit tests 和 3 项真实进程 integration tests 分别覆盖 Worker `SIGKILL` 后安全 socket 恢复、Agent client 子进程崩溃后的单一结果、重复结果去重和重连；实现与验证证据位于 `test/integration/qualification/evidence/s1-task10-execution-uds.json`。

### Task 11：建立可安装的 Agent Service、Worker 与 admin CLI 入口

- [x] 为两个服务添加真正的 `main`、start/build scripts、信号处理、退出码、结构化启动诊断和不依赖源码 checkout 的产物布局。
- [x] 让正式 composition 只接受 production adapters；现有 testing adapters 只能通过显式 test/development profile 选择，public mode 不能使用。
- [x] 创建 `himawari doctor` 和 `himawari db status` 的只读骨架，输出 deployment、schema、SQLite、authority、Payload、Worker、Memory 和 identity 的脱敏状态。
- [x] admin CLI 的写操作必须取得独占管理锁、验证 stopped/drained 条件、显示目标与计划，并使用明确 confirm flag 或交互确认；不得打印秘密。
- [x] 运行安装到临时前缀后的 smoke test，证明服务与 CLI 不依赖 repository cwd、TypeScript source 或 sibling `pi-mono`。
- [x] 验证正常启动、双启动冲突、错误配置、非安全 SQLite、无 secret source、graceful stop、forced stop 和 service-manager restart。

Task 11 新增独立 `main.ts`、workspace `build/start` scripts、稳定 JSON 诊断、退出码和保持事件循环的 SIGINT/SIGTERM drain。`tsconfig.node-build.json` 与 packaging scripts 把已编译 workspace 和精确的 native SQLite runtime closure 组装成可重定位 `dist/node-runtime`，安装器在任意绝对前缀生成 `himawari`、`himawari-agent-service` 与 `himawari-execution-worker` 入口；production artifact 不包含 `@himawari-agent/testing`，临时前缀 smoke 从仓库外 cwd 启动，未读取 TypeScript source、sibling `pi-mono` 或仓库 `node_modules`。

Agent Service 只接受显式 `--profile production`，验证 strict configuration、活动 authority、独占 state-root lock、qualified SQLite 与 production Worker handshake；public mode 在身份/Gateway trust root 尚未完成时以 `SERVICE_PUBLIC_MODE_INCOMPLETE` fail closed。Worker 入口验证相同 authority 和 owner-only boot token，adapter registry 尚未注入时只提供 transport/handshake 并对 work 返回 `WORKER_ADAPTER_REGISTRY_EMPTY`，没有用 deterministic/testing adapter 冒充生产能力。`himawari doctor` 与 `himawari db status` 使用只读 SQLite 打开方式并只输出脱敏状态；`db migrate` 先显示目标/计划，要求精确 confirm、stopped service 和独占 lock。安装测试覆盖正常与双启动、错误 config、损坏 SQLite、缺 token、graceful/forced stop 和 supervisor-style restart；实际 launchd/systemd unit 安装仍由 Task 28 的双主机演练完成。实现与验证证据位于 `test/integration/qualification/evidence/s1-task11-installable-services.json`。

### Task 12：实现持久 Run、Scheduler、Attention 与 Delivery 恢复

- [x] 把 Run checkpoint、job、occurrence、work lease、retry/deadline、budget、Attention 和 inbox delivery 落到 SQLite，并用现有应用服务复用统一 Trigger admission。
- [x] 保证同一 job 默认只有一个活动 Run；重复人工、timer 或 external occurrence 使用稳定 key 合并，只有显式安全配置才能并行。
- [x] 实现 IANA timezone、DST 跳过/单次、periodic missed skip、one-shot `MISSED`、有界退避和凭据/授权/策略错误不重试。
- [x] 实现全局、分类和单 Run 硬预算与前台保留容量；在线已接纳工作在预算或容量不足时进入可见的 `BUDGET_BLOCKED` 或 `CAPACITY_BLOCKED`。
- [x] Attention 只产生固定五级结果并应用确定性最低等级；Web Delivery 持久化、可重放、可去重，浏览器关闭不影响后台任务。
- [x] 重启测试覆盖 running、awaiting approval、retry_wait、MODEL_BLOCKED、unknown external result、pending Delivery 和 authority loss。

Task 12 新增第九个不可变 migration，把 background occurrence revision、分类、预算保留/实际费用、显式并行安全标记、work lease、错误和完整记录加入规范 SQLite schema；Run Coordinator 的 `run-checkpoint:<RunId>` 通过受 scope 限制的持久 checkpoint store 跨进程恢复。`DurableBackgroundWorkService` 以 `(job_id, stable_key)` 合并 timer、人工和 external occurrence，并始终经 `UnifiedTriggerIngestionService` 接纳；SQLite 即时事务共同验证 current deployment fence、单 job active Run、全局/分类/单 Run 预算、总量/category 并发与前台保留容量，阻塞状态保持可见。

schedule evaluator 覆盖 interval、one-shot 和 IANA daily schedule；periodic misfire 跳过旧槽位，one-shot 超时标记 `MISSED`，DST 不存在时刻无候选、重复时刻按本地日期只执行一次。work lease 到期后才允许原 identity reclaim；transport/provider 仅按有界 exponential backoff 与稳定 jitter 重试，credential、authorization、policy 和 invalid input 不自动重试。真实 SQLite restart matrix 同时覆盖 awaiting approval、due retry、`MODEL_BLOCKED`、unknown external result、pending/interrupted Delivery、过期 running lease 与 authority fence 变化。正式 Agent Service 已打开 repository 并输出脱敏恢复计数；生产 timer loop 留到 Task 13 的 Trigger Control Plane 组合，不使用测试 sink 冒充公共 Gateway。实现与验证证据位于 `test/integration/qualification/evidence/s1-task12-durable-background.json`。

### Task 13：实现受认证 HTTP Gateway 与可恢复 SSE

- [x] 先为 HTTP adapter 写 contract/security tests，证明每个命令、查询和事件请求都经过版本 parser、`GatewayAuthenticationContext`、scope policy、Control Plane 或 Read Model。
- [x] 实现同源静态资产、`/api/gateway/v1/commands`、查询和 SSE；机器 webhook、health、bootstrap 与 break-glass 使用独立最小 route，不共享普通业务权限。
- [x] mutation 验证 Origin、Fetch Metadata/CSRF、bounded body、content type、idempotency key 和 replay；配置 restrictive CSP、framing、MIME 与 cache headers。
- [x] SSE 包含 durable cursor/event ID/scope、heartbeat、backpressure 和 reconnect；旧 cursor 超出 retention 时只执行有界 snapshot refresh，不重复业务结果。
- [x] 证明伪造 header、跨 Owner/Agent scope、重复 cursor、同 Run 非递增 sequence、direct-origin bypass 和 unsupported schema 在 Control Plane 前被拒绝。
- [x] 在主流浏览器测试重连、后台 tab、移动网络切换和 browser close/reopen 的已接纳结果恢复。

Task 13 新增 Fastify 同源静态资产与严格 `gateway.v1`/`gateway.v2` HTTP adapter；业务请求先经过版本 parser、注入的认证上下文、Owner/Agent scope policy 和应用 Gateway service，再委派给 Control Plane 或 Read Model。mutation 在业务执行前验证 Host、Origin、Fetch Metadata、session-bound CSRF、精确媒体类型、有限 body 和 header/message 幂等键一致性；静态与 API 响应配置 CSP、framing、MIME 和 no-store 边界。独立最小 health、bootstrap、break-glass route 不继承普通业务权限。

SSE 使用持久 cursor/event ID/scope、heartbeat 和 Node stream backpressure，拒绝重复 cursor 与同 Run 非递增 sequence；v1 旧 cursor 只返回有界 Thread/Run snapshot refresh，不重放业务命令。Chromium `151.0.7922.34` 与 macOS WebKit `26.5` 的真实浏览器进程通过断网恢复、后台 tab、close/reopen 和移动视口验收。Playwright Firefox 因本机 content sandbox 无法启动，已明确留给 Task 27 的完整平台矩阵；Task 13 不据此宣称 Firefox 或公网 staging 已验证。实现与证据位于 `test/integration/qualification/evidence/s1-task13-http-sse.json`。

### Task 14：实现 Owner bootstrap、身份断言、session/device 与 break-glass

- [x] 实现仅 loopback、短时有效、默认关闭的一次性 bootstrap；只创建唯一 Owner 并绑定一个稳定外部 subject，成功后不可再次访问。
- [x] 实现 Cloudflare Access JWT verifier：按 `kid` 获取 JWKS、有界缓存与轮换，验证 algorithm、signature、issuer、audience、exp、nbf 和 clock skew；不信任 email/username forwarded header。
- [x] 实现产品 session/device、撤销、最近活动和 recent-auth；关键操作 recent-auth 不足时返回稳定 reauthentication requirement。
- [x] 实现本机独立恢复凭据、独占管理锁和受保护审计下的 break-glass；只允许修复 Owner mapping、撤销 session/device 或关闭公网入口。
- [x] 安全测试覆盖 forged/missing JWT、wrong issuer/audience、JWKS rotation、expired/future token、header spoofing、bootstrap replay、session revoke 和非 Owner subject。
- [x] 证明公网身份只解决“谁在访问”，不会绕过 `ALLOW / ASK / DENY` 行动授权。

Task 14 新增第十个不可变 migration，持久保存唯一 Owner 外部 subject binding、产品 device/session、token digest、活动与 recent-auth 状态；真实 SQLite restart 后身份与撤销仍生效。loopback bootstrap 默认关闭、短时有效并原子只允许一次；Cloudflare Access verifier 只接受 RS256，验证 signature、`kid`/JWKS 有界缓存与轮换、issuer、audience、`exp`、`nbf` 和 clock skew，稳定 subject reference 由 issuer 与 subject 派生，不信任 forwarded email/username。

产品 session/device 支持 activity、recent-auth 和分层撤销；session-bound HMAC CSRF 拒绝过期与跨 session 使用。break-glass 使用独立 loopback credential 与独占文件锁，只暴露 Owner mapping 修复、session/device 撤销和关闭公网入口，并写受保护审计。Gateway v2 在身份验证后仍执行确定性授权，因此有效 JWT 不能把 `ASK` 或 `DENY` 变成 `ALLOW`。本任务只使用本地密码学与 SQLite fixture，真实 Cloudflare/MFA 与最终 Agent Service 组合分别保留给 Tasks 27 和 23。实现与证据位于 `test/integration/qualification/evidence/s1-task14-identity-gateway.json`。

### Task 15：构建持久 Web 控制中心基础旅程

- [x] 建立 browser-only workspace、typed Gateway client、SSE state synchronizer、本地草稿/last cursor/UI preference storage 和无秘密日志边界。
- [x] 实现受认证 Thread list、持久 chat、streaming Run、cancel、pending approval、后台任务、repository monitor、inbox、Memory、Trace、session/device 和 health 页面。
- [x] 浏览器本地只能保存未发送草稿、UI preference 和 last cursor；不得本地接纳命令、创建任务、批准行动或缓存长期私人正文。
- [x] 所有 mutation 使用稳定 idempotency key，并在 pending/accepted/rejected/expired/replayed 状态间提供明确反馈。
- [x] 为键盘、焦点、屏幕阅读器语义、触摸目标、对比度和非颜色提示建立基础自动化检查；完整三语和 WCAG 2.2 AA 由控制中心体验 Spec 收口，不能在本 Plan 中误报完成。
- [x] Browser E2E 覆盖 Thread/chat、重连、审批、inbox、Memory correction/delete、Trace、session/device 和 degraded health。

Task 15 把 `apps/control-center` 从构建占位改为 browser-only React/Vite 控制中心：严格 typed v1/v2 client、受保护 Payload admission、SSE synchronizer 与本地 storage 只保存未发送草稿、显示密度和 last cursor。页面覆盖 Thread/chat、streaming Run/cancel、审批、后台任务与 repository monitor、inbox、Memory correction/delete、Trace、session/device 和 health；所有 mutation 生成独立幂等键，并明确显示 pending、accepted、replayed、rejected 与 expired。

可重复真实浏览器脚本通过实际点击与文本输入完成消息发送、Run 取消、批准、任务暂停、Memory 更正/删除和 session 撤销，再覆盖 degraded health、断网恢复、后台 tab、close/reopen 与 `390x844` 视口。Chromium 与 WebKit 的最小触控目标分别为 `44.78125px` 和 `44px`，axe 均为零 violation；语义 landmark、label、live region、visible focus、对比度和非颜色连接文字只建立基础门槛，不宣称三语或完整 WCAG 2.2 AA。fixture 不是生产 Control Plane、真实身份或公网路径；完整浏览器矩阵仍由 Task 27 收口。实现与证据位于 `test/integration/qualification/evidence/s1-task15-control-center.json`。

### Task 16：完成 Mem0 OSS 双平台 compatibility gate

- [x] 在获批精确版本上构建独立 harness，显式注入 LLM、embedder、vector/history store、dimensions、paths 和 custom instructions；不接受默认 provider 或临时目录。
- [x] 在 Mac 与 Hermes 分别验证 add/search/update/delete/history、filter/metadata、provider ID round-trip、restart persistence、concurrent access、correction 和 deletion。
- [x] 监测网络、telemetry、文件和进程行为，证明没有未声明 provider call、隐藏 LLM/embedder、内存-only durability 或 policy 外遥测。
- [x] 验证产品 ID/source/classification/version 可以稳定映射并从产品状态重建 provider projection。
- [x] 记录版本、平台、实际存储、模型依赖和全部异常；mandatory conformance 任一失败即停止 Task 17–19 并修订 Spec。

独立 harness 在 import `mem0ai/oss@3.1.7` 前关闭 telemetry，显式注入仅监听本机回环的确定性 LLM 与 12 维 embedder，并把 vector/history store 写入调用方提供的绝对 SQLite 路径。Mac `darwin-arm64 / Node 25.6.0` 与 Hermes `linux-x64 / Node 22.19.0` 均通过全部 mandatory conformance、重启持久性、双实例并发和从产品记录重建 projection；套接字监测只观察到资格测试的回环 provider，未观察到未声明网络、子进程或额外文件。

故障注入同时确认 `mem0ai@3.1.7` 的批量推断路径会在一个 embedding 失败时静默保留其余成功项。该行为不阻断已确认的 mandatory gate，但 Task 17 的产品 adapter 必须把每条产品 Memory 独立投影为一次 Mem0 add，并验证恰好返回一个 provider ID，不能依赖批量调用的全有或全无语义。Hermes 使用官方 Node 22.19.0 归档，SHA-256 为 `c0649af18e6a24f6fe5535a3e86b341dd49a8e71117c8b68bde973ef834f16f2`；同步、安装和运行均限定在 `/data/tmp/himawari-task16-d3a43c8-a`。完整命令、平台、存储、监测与异常证据位于 `test/integration/qualification/evidence/s1-task16-mem0-compatibility.json`。

### Task 17：实现产品 Memory 记录、projection 与检索交集

- [x] 扩展 product Memory schema 与 service，覆盖 active version、protected content ref、provenance、classification、inference/confidence、provider link、archive/delete tombstone 和最近使用。
- [x] Mem0 只能产生新增、更新、合并或不变 proposal；产品 policy 和 SQLite transaction 决定稳定 Memory ID、revision 与 active version。
- [x] 用 reliable projection job 协调 SQLite 与 Mem0；对话 commit 不等待 provider，失败有界重试且可观察。
- [x] retrieval 把 Mem0 hits 与 active product records 取交集，再执行 classification、source 和数量限制；失活或删除记录立即不可进入 context。
- [x] 实现 correction、archive、delete、provider cleanup retry 和 full rebuild；旧 provider 副本不能重新激活删除 tombstone。
- [x] 运行 restart、projection loss、duplicate proposal、out-of-order retry、correction/delete propagation 与 rebuild equivalence tests。

第 11 个不可变 SQLite migration 为 `memory_records` 补齐最近使用时间，并为 `memory_projection_jobs` 增加可恢复 claim lease。SQLite adapter 以乐观 revision 和单向 lifecycle 保存产品 Memory、来源、classification、inference/confidence、provider link 与 tombstone；projection job 使用由 `MemoryId + revision + operation` 派生的稳定身份，产品 transaction 完成后才由独立 worker claim 和调用 provider，失败进入有界 `retry_wait` 或 `failed_terminal`。

`DurableMemoryService` 只接受 create/update/merge/unchanged proposal，先提交产品状态再排队投影；乱序旧 revision 会完成为空操作，不能覆盖新 revision。检索先取 Mem0 hits，再与同 Owner/Agent 的 active 产品记录、当前 provider link、classification、source 和数量上限取交集。correction 产生新 revision；archive 和 delete 先退出检索，再可靠清理 provider；只有 deletion cleanup 成功才进入 `deleted_verified`。`Mem0ProjectionAdapter` 使用 Task 16 的动态加载和产品自有最小结构类型，每条产品 Memory 单独 `infer: false` add，并强制恰好一个 provider ID 与 metadata round-trip。真实 SQLite restart、duplicate proposal、out-of-order、失败重试、projection loss、correction/delete 和 rebuild equivalence 均已通过；实现与证据位于 `test/integration/qualification/evidence/s1-task17-memory-projection.json`。

### Task 18：实现增量自动 Memory 与敏感逐项审批

- [x] 建立受治理 multi-turn golden dataset，覆盖 durable facts、transient chatter、correction、contradiction、decision、commitment、experience、敏感个人信息、第三方信息和机器秘密格式。
- [x] committed Run 后先执行 machine-secret exclusion 和 classification，再运行增量 extraction；失败不得回滚已提交消息或 Run。
- [x] 高置信非敏感结果可按 policy 自动 commit，并保留来源、模型/policy version、推断标记和 Trace。
- [x] 交互式敏感候选在当前 Thread 同步逐项 ASK；批准前不保存候选正文，同轮多个候选允许逐项批准、编辑或拒绝。
- [x] “请记住”只批准明确指向项；后台只保存指向原始加密 source 的最小 reference，Owner 在线后重新提取或询问。
- [x] 机器秘密命中只记录 rule ID、count、source reference 和 outcome；任何秘密原值进入模型、Memory provider、产品 Memory 或 Trace 都是 release blocker。
- [x] 测量 extraction precision/recall、false secret retention、correction propagation 和 duplicate-generation rate，记录阈值与未通过样本。

版本化 `memory-golden-v1` 包含 14 类多轮样本与明确 policy/model identity、review date 和阈值，覆盖稳定事实、寒暄、纠正、矛盾、决定、承诺、经验、个人/第三方敏感信息、同轮多敏感候选、明确“请记住”、低置信、机器秘密与提取失败。`AutomaticMemoryService` 只处理已经 committed 的 Run 来源：先扫描原始来源的机器秘密，再调用显式 extractor，随后对每个候选再次扫描；提取失败只记录派生失败，不修改原消息或 Run。

高置信非敏感候选写入稳定 protected Payload 后交给 Task 17 产品 transaction；低置信和 transient 候选不提交。敏感候选在第 12 个 SQLite migration 引入的 `memory_approval_requests` 中只保存 source ref、候选序号、预分配产品 ID、classification、policy/model 和 delivery metadata，不保存候选正文。交互式候选逐项 ASK；后台使用 `queued_no_ui` 最小引用；批准或编辑时重新读取受保护来源、按原 policy/model 重新提取并再次扫秘密，之后才保存正文。明确“请记住”只直接提交其指向序号，其余敏感候选仍 ASK。

确定性 golden extractor 基线得到 precision `1.0`、recall `1.0`、false secret retention `0`、correction propagation `1.0` 和 duplicate-generation rate `0`，分别通过 `>=0.95`、`>=0.95`、`=0`、`=1.0` 与 `=0` 阈值；未通过样本为空。该结果证明 policy、persistence 和测量 harness，不代表 Task 20 真实模型质量。实现与证据位于 `test/integration/qualification/evidence/s1-task18-automatic-memory.json`。

### Task 19：实现 Thread 稳定检查点、摘要与候选提炼

- [x] 实现由 `ThreadId + source watermark + distillation policy version` 派生的稳定 job/generation identity 和 pending/running/completed/retry/terminal 状态。
- [x] 支持 Owner 明确操作、所有 admitted Runs 稳定后的受控 idle、compaction 前和 source-size threshold 四类触发；均不得结束、归档或替换 Thread。
- [x] 单次 generation 原子提交 summary、零条或多条 Memory/experience/commitment candidates 和 provenance；中断不能发布 partial generation。
- [x] summary 保存来源范围、水位线、policy/model version，可用于 context builder 但不能删除或取代 transcript。
- [x] 未解决 commitment 没有持续有效授权时只能形成候选，不能创建 job、capability 或 external action。
- [x] 对四类 trigger、重复请求、进程中断、model response 前后、product commit 前后和 compaction/restart 运行 exactly-once recovery tests。
- [x] 测量 summary faithfulness/source coverage、跨 Thread retrieval relevance 和 checkpoint generation duplication。

第 13 个不可变 SQLite migration 为 checkpoint 增加 trigger、retry 与 claim lease，并新增 source slice、summary、Memory/experience/commitment candidate 和 provenance 表。`ThreadCheckpointService` 由 Thread、水位线与 policy version 派生稳定 job/generation identity；Owner 明确操作、稳定 idle、pre-compaction 与 source threshold 都写入同一持久状态机，不修改 Thread lifecycle。

模型调用前逐条执行机器秘密扫描；summary 与非敏感候选先写稳定 protected Payload，敏感或 restricted 候选只提交无正文的 `awaiting_sensitive_approval` metadata。SQLite 在单个 immediate transaction 中共同写 summary、全部 candidates/provenance 及 completed 标记；事务前失败不可见，COMMIT 后回包丢失按 generation identity 回读原输出。未解决 commitment 不连接 Scheduler、Capability 或 external action。Context Formation 只附加符合分类限制的最新摘要，原始 transcript 仍完整保存并继续注入。

确定性恢复矩阵覆盖四类 trigger、重复请求、模型响应前失败、protected-content 写入失败、产品事务前失败、事务后 acknowledgement loss、claim lease 过期、进程重启与 pre-compaction。资格基线得到 summary faithfulness `1.0`、source coverage `1.0`、跨 Thread retrieval relevance `1.0` 与 generation duplication `0`；真实模型质量仍属于 Task 20。实现与证据位于 `test/integration/qualification/evidence/s1-task19-thread-distillation.json`。

### Task 20：冻结模型配置并接通生产 Model/Pi 路径

- [ ] 在第一次 live call 前向 Owner 展示 primary、fixed fallback 和 embedding 的精确 provider/model/version 或 snapshot、能力、披露、费用、secret ref、预计成本和 capped test budget。
- [ ] 未获批准时只使用 deterministic provider 与 fault injection；不得添加隐藏第三生成模型、隐式 embedding、动态 marketplace route 或本地生成模型。
- [ ] 为获批 provider 实现受信任 transport adapter；每次调用记录精确 identity、purpose、classification/disclosure、tokens、cost、latency 和稳定终态，正文只通过 protected Payload。
- [ ] Router 始终先选 primary；只有配置为 retryable 的 transport/provider failure 可以考虑 fixed fallback，authorization、policy、invalid input 和 disclosure incompatibility 不可绕过。
- [ ] 非 GitHub fallback 必须满足预批准、能力、预算和不扩大披露；GitHub content 每次 fallback 单独生成 ASK。
- [ ] Pi adapter 只接收 product-selected binding、context refs 和 authorized tools；继续关闭 Pi 自有 model selection、Session persistence、Skills discovery 和 built-in tools。
- [ ] 获批后运行有界 live smoke/eval，并与 deterministic recovery、cancellation、tool-call、fallback、cost accounting 和 secret-redaction tests 一起记录证据。

### Task 21：实现 GitHub App 凭据、webhook 与持久接纳

- [ ] 从实际只读调用反推 dedicated GitHub App permission manifest；全部 repository/account write permissions 为 none，并限制到 Owner 选择的 repositories。
- [ ] App private key 与 webhook secret 只通过 host secret source 解析；installation token 限定仓库/权限、只驻留内存并按过期时间更新。
- [ ] webhook route 限制 body、content type、rate，按 raw bytes constant-time 验证 `X-Hub-Signature-256`，再验证 event/action、installation 和 repository allowlist。
- [ ] 在成功响应前把 delivery ID、protected payload reference、scope 和 authority fence 持久化；重复投递只形成一个 external-event Trigger/occurrence。
- [ ] 默认事件覆盖 default branch push、Pull Request create/update/merge、Release 和 GitHub Actions failure；未知或禁用事件不得触发任意工作。
- [ ] 测试错误签名、replay、oversized body、错误 installation/repository、revoked credential、rate limit、token refresh 和 2 秒内持久接纳/明确拒绝。

### Task 22：实现只读仓库镜像、在线监控与 coverage gap

- [ ] 连接仓库前在 Web UI 展示当前 primary provider/model 和排除机器秘密后整仓可披露范围；一次明确确认同时启用仓库与这一披露。
- [ ] 在受保护、有界 cache 中维护所选仓库只读 mirror；所有 Git 操作和 GitHub API surface 都通过无写权限 capability 与 Worker 执行。
- [ ] 所有通过来源/范围验证的在线事件进入 model relevance 和 Attention；不得增加会绕过模型判断的确定性语义预过滤。
- [ ] 服务离线时不 polling、不 reconciliation、不 history scan；恢复只记录 coverage gap 起止和可能遗漏说明。
- [ ] 在线已接纳事件在预算不足时进入有界 `BUDGET_BLOCKED`；普通完成结果进入持久 Web inbox，并保留仓库、事件、模型、授权和 Trace 来源。
- [ ] 撤销 repository 时立即停止读取并删除 mirror/cache；历史摘要/Trace/任务按 Owner 选择保留或删除，GitHub secret 永不进入迁移包。
- [ ] 断言初始能力无法 push、comment、merge、dispatch workflow、创建 deployment 或访问 Git credential。

### Task 23：实现同机 snapshot、验证与恢复 CLI

- [x] 实现 `himawari backup create|verify|restore`，使用 SQLite 一致性 snapshot、受保护 Payload 和 manifest allowlist，不复制 runtime locks/sockets/cache/secrets。
- [x] 创建后自动解密到权限受限临时目录，运行 authentication、digest、schema、quick/full integrity、row counts、Payload authentication 和 outbox continuity 验证。
- [x] restore 只能在 stopped service、独占管理锁和明确目标下执行，先恢复到新目录并验证，再原子切换；失败不得破坏当前 state root。
- [x] 标记恢复点与 retention，确保永久删除数据在 30 天内退出所有可恢复本地副本；不得把同机 snapshot 描述为 off-host disaster recovery。
- [x] 对每个 create/verify/restore 阶段注入中断、disk full、tamper、wrong key、schema mismatch 和 SQLite corruption。
- [x] 完成真实恢复演练后才创建并 seal backup/restore Runbook。

恢复点采用每文件 AES-256-GCM envelope encryption 与 HMAC-SHA256 canonical manifest；allowlist 只包含 SQLite backup API 生成的 `data/product.sqlite` 和该副本实际引用的 Payload ciphertext。create 自动在受限 staging 中独立验证，restore 只在显式目标与确认词匹配、state-root 管理锁可独占取得时原子切换 `data/`，切换阶段失败会移回 previous data。30 天 `retainUntil` 与 `purgeExpired()` 固定本机副本退出边界；该机制不改变 authority，也不提供异地灾难恢复。

9 项恢复点集成测试覆盖 create/verify/restore 全阶段中断、`ENOSPC`、manifest/object 篡改、错误密钥、schema mismatch、SQLite/Payload 损坏、运行中锁和切换回滚；安装后的 `himawari` 二进制另在临时 state root 完成损坏前创建、独立验证与恢复演练。已创建并 seal `docs/runbooks/backup-restore-runbook.md`；实现与证据位于 `test/integration/qualification/evidence/s1-task23-backup-restore.json`。


### Task 24：实现停机加密 authority transfer

- [x] 实现 transfer/deployment 状态机与 `export|inspect|import|activate|abandon` CLI，验证 target intent、current deployment、monotonic epoch、transfer ID 和 exclusive offline lock。
- [x] export 按 Spec 顺序停止 admission/scheduling、drain/checkpoint、关闭服务与 stores、执行 checkpoint/integrity、枚举 allowlist、排除 secrets/cache/log/socket、rewrap DEKs 并生成 canonical manifest。
- [x] 使用维护中的 authenticated streaming encryption；passphrase/private key 只从交互输入或 recipient secret source 读取，不进入 argv、环境转储、日志或 Trace。
- [x] import 只写临时目录，验证 authentication、digests、versions、Owner/Agent、epoch、transfer consumption、Payload、Memory 和 forward migration，再原子建立 inactive-ready target。
- [x] activate 前要求 target secret refs、doctor/readiness 与公共入口 preflight 全部通过；激活后 source 进入 retired 且普通启动失败。
- [x] source 加密副本保留 7 天后删除；回切只能由当前 active target 发起 reverse transfer，不能直接启动旧副本。
- [x] 在每个 export/import/activate step 后注入失败，证明不存在 partial active target、自动 source restart 或双活普通路径。

迁移包使用逐文件流式 AES-256-GCM、recipient-wrapped package DEK 和 HMAC-SHA256 canonical manifest；allowlist 只包含一致性 SQLite、被引用的 Payload ciphertext 与 Memory 文件。export 在离线锁内先把源 SQLite/authority file 置为 `retired_pending_transfer`，保证任何后续中断都不能普通重启；import 在受限 staging 验证并以目标 KEK rewrap Payload 后，才原子建立 `epoch/fence=0/0` 的 inactive target；activate 要求受限 preflight 证据并把 epoch/fence 各推进一代。目标 canonical SQLite 把 source 记为 `retired`，物理源保持 pending 并由 Agent Service 的 SQLite/authority 双读校验 fail closed。

4 项 authority-transfer 集成测试覆盖完整导出/检查/导入/激活/放弃、manifest tamper、Payload 目标 KEK authentication、Memory copy、7 天 purge、旧源禁止再导出，以及所有 16 个 export/import/activate 注入阶段；安装后的 `himawari` 二进制另完成 stopped source→inactive target→activated target 演练。已创建 `docs/runbooks/authority-transfer-runbook.md`；实现与证据位于 `test/integration/qualification/evidence/s1-task24-authority-transfer.json`。真实 Mac↔Hermes 双向演练仍属于 Task 28，不能由本 Task 的临时 fixture 替代。

### Task 25：完成删除、存储压力、可观察性与安全加固

- [x] 把 Thread、Run、task、Memory、Payload、Trace、inbox、search/cache/archive 的失活、Trash、永久删除和 tombstone 传播接到真实 stores；不把抽象 deletion target 当作生产完成证据。
- [x] 实现 7 天 Trash、立即永久删除和 30 天恢复点清除边界；Thread 删除前处理关联活动任务，外部副作用只保留不含正文的最小墓碑。
- [x] 实现 disk headroom warning、严重不足时停止高容量 admission，并保留只读、transfer export 与人工清理；不得自动删除 Owner 内容。
- [x] 结构化日志只含 correlation/Run/event/adapter/version/latency/stable error；指标覆盖 DB、WAL/disk、outbox、jobs、Worker、Memory、model/fallback/cost 和 SSE。
- [x] 详细 dependency health 需要认证并脱敏；公共 health 不暴露路径、secret ref、repository、Owner 或私人正文。
- [x] 运行 secret scan、dependency audit、CSP/CSRF、filesystem/socket permission、request limit、log redaction 和 tamper tests。

`SqliteGovernedDeletionAdapter` 与 `himawari delete trash|restore|inspect|purge|purge-expired` 已把 Thread/task/Memory 的 7 天 Trash、Run/task/Thread 级联、Payload metadata/ciphertext file、Trace、inbox、Gateway Read Model 和 state-root 内受管 search/cache/archive artifact 接到真实 SQLite 与文件系统。Thread mutation plan 在确认前列出关联 task，并在 Trash 时暂停 active task、恢复时只恢复本次暂停的 task；永久删除把保留 Memory 的来源改为无正文 deleted-source marker。外部可靠事件内容删除后只保存 SHA-256 引用的 Audit 墓碑；任一物理目标失败都会在 durable tombstone 中保持 `deletion_pending` 并可重试。带 provider projection 的 Memory 必须先经既有 durable projection cleanup 到 `deleted_verified`，不能由离线 CLI 冒充外部清理成功。30 天边界由 Task 23 的固定恢复点 retention 保证：永久删除后的新恢复点不再含对应行，旧恢复点最迟在各自 `retainUntil` 退出本机副本。

SQLite status 现在区分 `normal|warning|write_restricted`，并输出 database/WAL/free bytes、writer queue、Outbox、job、Memory projection、deletion 与 SSE retained-event 计数。`RuntimeMetricsRegistry` 另覆盖 Worker、model/fallback/cost、SSE connection/backpressure 和 request latency，固定指标名且不接受私人标签；详细 health/metrics API 要求认证，公共 health 只返回最小状态。结构化诊断统一执行 machine-secret redaction；`npm run check:secrets` 扫描 tracked 与未忽略的新文件，并用精确匹配 digest baseline 区分已有测试假凭据。`npm audit --omit=dev --audit-level=high` fresh 查询报告 0 vulnerabilities。实现与验证证据位于 `test/integration/qualification/evidence/s1-task25-deletion-observability-security.json`。

### Task 26：扩展真实进程、崩溃与恢复矩阵

- [x] 以真实 child process 启动 Agent Service、Worker 和测试客户端，在 context formation、model stream、approval wait、Worker result、outbox、Thread checkpoint、Memory projection 与 Delivery 阶段 kill/restart。
- [x] 为 SQLite transaction/outbox 每个 crash point、WAL/lock contention、long reader、disk full、migration digest mismatch 和 corruption 记录可重复证据。
- [ ] 验证 stale Gateway/Worker/event、旧 authority fence、inactive/retired host、重复 webhook、重复 model result 和 duplicate Delivery 都不能产生第二次业务效果。
- [x] 验证未知外部副作用总是先 reconcile；取消和超时保留真实副作用，任何补偿都是新的授权行动。
- [x] 验证 Thread checkpoint、Memory projection/delete、scheduler 和 inbox 在重建 service object 与重启进程后沿用原 identity。
- [x] 所有 fault injection 使用非生产 fixture；不得把一次成功重启误报为覆盖完整恢复矩阵。

非生产 `durable-phase-child` fixture 在八个明确业务阶段分别持久化原 identity，向父测试报告已到达边界后由父进程发送 `SIGKILL`，再由全新进程取得同一 state root 独占锁并运行正式 startup recovery。它与既有真实 Agent Service、Execution Worker、测试客户端、四个 SQLite transaction crash point、WAL/锁/长 reader/`SQLITE_FULL`/migration/corruption、故障恢复矩阵和 service-object 重建测试共同构成证据；一次普通重启不计为矩阵覆盖。当前 stale Gateway/Worker/event、旧 fence、inactive/retired host 与 duplicate Delivery 已有确定性证据；重复 webhook 和重复 model result 仍分别依赖 Task 21 与 Task 20，完成前本 Task 保持未收口。阶段性证据位于 `test/integration/qualification/evidence/s1-task26-process-recovery.json`。

### Task 27：完成浏览器、身份与真实公共路径验证

- [ ] 在 Safari、Chrome、Edge、Firefox、iOS Safari 和 Android Chrome 的受支持版本范围运行关键 Browser E2E；记录实际版本和平台。
- [ ] 覆盖 bootstrap、MFA redirect、Thread/chat、SSE reconnect、approval、inbox、Memory、Trace、sessions/devices、recent re-auth、degraded state 和 browser offline draft。
- [x] 安全测试覆盖 forged/missing JWT、wrong issuer/audience、JWKS rotation、header spoofing、CSRF/cross-origin、replay、oversized body、CSP 和 direct-origin bypass。
- [ ] 在得到外部账户授权后运行 staging Cloudflare Access/Tunnel smoke，验证真实 public URL、origin 只绑定受控入口、MFA、SSE heartbeat/reconnect 和最小公共 route set。
- [ ] 在桌面与手机完成本基础切片的键盘、屏幕阅读器、焦点、对比度、触摸和非颜色提示检查，并把完整三语/WCAG 验收留在控制中心体验 Spec 的实施范围。
- [x] 不把 staging 通过等同于 production deployment 或完整 v0.2 验收。

本机真实 Chrome `151.0.7922.172` 与 Edge `150.0.4078.50` 已通过 Thread/chat、Run cancel、approval、task、inbox、Memory、Trace、sessions、health degraded、SSE 断网/后台/关闭重开、键盘焦点、ARIA landmark、axe、触摸目标和非颜色连接状态资格测试。Playwright WebKit `26.5` 通过同一矩阵；iPhone 15 WebKit 与 Pixel 7 Chrome 仅为 macOS 上的设备模拟，不能当作 iOS/Android 真机证据。系统 Safari 为 `27.0`，但现有设置未启用 `Allow remote automation`，因此没有创建会话或修改该设置；Playwright Firefox `153.0` 在缓存路径和无 provenance 的临时副本中都被自身 macOS content sandbox 阻断。真实 Safari、Firefox、iOS/Android 真机、屏幕阅读器和 staging Cloudflare/MFA 仍是明确缺口。

本地密码学和 HTTP 安全矩阵已覆盖本 Task 列出的全部拒绝路径；bootstrap、session/device、recent re-auth 的产品边界和持久重启已通过，但真实 MFA redirect 只能在授权后的 Cloudflare Access 路径验证。阶段性证据位于 `test/integration/qualification/evidence/s1-task27-browser-identity-public-path.json`；本 Task 保持未收口，且这些本机结果不代表 staging 或 production。

### Task 28：完成 Mac/Hermes、规模与迁移验收

- [ ] 在 Mac 与 Hermes 使用同一 immutable build、schema、adapter versions 和配置契约分别完成 install/start/stop、重启、恢复与健康验证。
- [ ] 执行 Mac→Hermes 与 Hermes→Mac transfer drill，包含非空 Thread、pending/completed Runs、summaries/watermarks、Memory/experience/candidates、jobs、GitHub monitor 和 Payload classifications。
- [ ] 比较迁移前后 manifest、Owner/Agent/Thread/Run IDs、authority epoch、schema、row counts、Payload authentication、Memory retrieval 和 Trace causality。
- [ ] 证明迁移包不含 machine secrets，target readiness 精确列出需重配 secret/directory permission，source 在 target 激活后不能普通启动。
- [ ] 在 20 万 messages、1 万 Threads、50 万 Runs、100 active jobs 和 50 repositories 的生成数据上验证核心 query、search、approval、Memory、Trace、delete 和 transfer；记录 p50/p95/p99、资源与瓶颈。
- [ ] 验证 Web/GitHub 在 2 秒内持久接纳或拒绝、正常重启后 2 分钟内可查询、任务 5 分钟内恢复或显示阻塞；普通在线 GitHub 分析目标 10 分钟只在模型和外部服务可用的授权环境中测量。
- [ ] 7 天连续运行属于完整 v0.2 上线门槛；如果其他 Specs 尚未完成，本 Plan 只记录基础切片 soak，不宣称 v0.2 production-ready。

### Task 29：创建已验证 Runbooks 并对账当前事实文档

- [ ] 仅在对应命令与真实演练存在后，从 document-governance Runbook 模板创建 install/start/stop、backup/restore、transfer、secret rotation、GitHub、identity gateway 和 incident diagnosis Runbooks。
- [ ] 每份 Runbook 写入静态 contract sources、fresh target preflight、effective risk、授权、证据、停止规则、mutation boundary 和 rollback boundary；semantic reconciliation 后显式 seal 并再次 check。
- [ ] 更新 `docs/architecture-v0.1.md` 只描述已验证的 packages、schema、processes、adapters、data flow、deployment 与 Known Limitations；不把目标或 staging 状态写成当前生产事实。
- [ ] 更新 README 的 verified install、development、test、doctor 和安全边界；不写入 secret、临时 URL 或本机私有配置。
- [ ] 若实施形成新的持久技术决策，先创建并接受单一决策 ADR；不得把 ADR 决策藏在 Plan evidence 或 Architecture 中。
- [ ] 对账 v0.2 Spec 套件中全部 active sibling Specs、跨切片契约和 Architecture 当前事实；如果 PRD 新增范围尚无 Spec，则阻止收口并按文档治理创建 Spec，不能用本 Plan、Backlog 或 `docs/TODO.md` 代替当前范围。

### Task 30：完成验收映射、发布证据与文档收口

- [ ] 把本 Spec 每个验收标准映射到 fresh test、平台、artifact、外部 readback 和结果；明确 `已验证`、`部分验证`、`未验证`，不得用推断填补缺口。
- [ ] 运行 immutable clean-install verification，记录 commit、package checksums、dependency lock、schema/migration digests、actual sqlite_version、adapter/model identities 和测试数量。
- [ ] 运行全部静态、unit、contract、integration、E2E、Pi compatibility、browser/security、persistence、migration 和 strict document checks。
- [ ] 对授权后的真实 Cloudflare、GitHub、model 和 transfer 操作执行 readback，区分“命令报告成功”和“目标状态已验证”。
- [ ] 记录应用回退、数据库恢复、authority transfer 和外部账户回退是不同边界；不得把一个边界的授权扩展到另一个。
- [ ] 只有本 Spec 基础旅程全部通过 Mac、Hermes、真实 adapters 与公共认证路径，且当前事实文档和 Runbooks 已对账，才关闭并归档本 Spec 与 Plan。
- [ ] 即使本 Plan 完成，只要其他 v0.2 Specs、三语/WCAG 或完整 PRD 验收未完成，就不得标记或宣传 v0.2 production-ready。

## 验收映射

| Spec 验收组 | 主要任务 | 必需证据 | 当前状态 |
| --- | --- | --- | --- |
| 可运行部署 | Tasks 2–11、28 | 双平台 immutable install、startup/readiness、graceful drain、无源码 checkout | 待实施 |
| 受认证 Web 对话与身份 | Tasks 13–15、27 | origin 安全、bootstrap/MFA/session/device、Browser E2E、SSE replay | 待实施 |
| 持久后台工作 | Tasks 6–7、10、12、26 | SQLite/outbox、真实 Worker、scheduler/Delivery、kill/restart | 待实施 |
| 自动与敏感 Memory | Tasks 16–19、25 | 双平台 Mem0 conformance、golden dataset、逐项审批、重建与删除 | 待实施 |
| 模型路由 | Task 20 | 精确 descriptors、Owner 费用授权、deterministic 与有界 live evidence | 待实施 |
| GitHub 在线只读监控 | Tasks 21–22、27 | 权限 manifest、签名/去重、在线事件、coverage gap、无 write surface | 待实施 |
| 同机恢复点与跨主机迁移 | Tasks 23–24、28 | 真实 restore、双向 transfer、failure injection、source retired | 待实施 |
| 删除与存储压力 | Tasks 23、25–26、28 | Trash/restore、删除传播、snapshot 清除、disk pressure 与恢复 | 待实施 |
| 本 Spec 收口 | Tasks 25–30 | 安全/规模/平台、Runbooks、Architecture、immutable release evidence | 待实施 |

## 验证

基础命令：

- `npm ci --ignore-scripts`
- `npm run check`
- `npm run test:unit`
- `npm run test:contracts`
- `npm run test:integration`
- `npm run test:e2e`
- `npm run check:boundaries`
- `npm run check:pi-compat`
- `python3 /Users/triggerjames/.codex/skills/document-governance/scripts/validate_docs.py --strict .`
- `git diff --check`

实施过程中必须新增并固定以下可重复入口，确切脚本名在 Task 3 落地后写回 evidence：

- SQLite migration、integrity、WAL、backup/restore 和 crash matrix。
- Agent Service/Worker child-process、UDS、authority fence 和 drain/restart integration。
- Browser E2E、identity/security、SSE reconnect 与 accessibility checks。
- Mem0 compatibility、Memory golden dataset、projection/rebuild/delete。
- GitHub App permission、webhook、read-only monitor 和 coverage gap。
- Mac/Hermes packaging、transfer drill、规模与 soak。

真实 provider、Cloudflare、GitHub、Mac/Hermes service-manager、迁移和生产类验证必须在对应授权与适用 Runbook/preflight 下单独运行。一次 live success、HTTP 200、测试替身通过或 Compose/配置解析均不能单独证明生产完成。

## 收口清单

- [ ] 所有 Task 已完成，并记录 fresh 命令、结果、平台、artifact、外部 readback、未验证项和 commit。
- [ ] 本 Spec 全部验收标准已映射到证据，不存在被测试替身、历史结果或推断掩盖的缺口。
- [ ] Mac 与 Hermes 分别通过本基础切片验收，Mac→Hermes 与 Hermes→Mac transfer 均已验证。
- [ ] paid/live models、Cloudflare、GitHub 和其他外部变更均有独立授权、费用/权限边界和完成后 readback。
- [ ] production secrets、machine-secret literals、私人生产数据、临时凭据和本机绝对配置未进入 Git、fixture、日志、Trace 或迁移包。
- [ ] 当前 Architecture、README 和已经实现的 Runbooks 与代码、schema、部署和实际限制一致。
- [ ] v0.2 全部硬性范围已由 Spec 套件中的 active Specs 承接；没有用 Backlog、`docs/TODO.md` 或 Plan prose 把当前版本范围推迟为未来工作。
- [ ] 没有新 durable decision 只存在于代码或 Plan；需要的 ADR 已接受，旧 ADR 未被改写。
- [ ] `npm run check`、全部相关测试、Pi compatibility、严格文档校验和 `git diff --check` 全部通过。
- [ ] 本 Plan 与来源 Spec 仅在工作真正关闭后移动到 `docs/archive/plans/` 与 `docs/archive/specs/`。
- [ ] 即使本 Plan 关闭，也没有在其余 v0.2 Specs 和完整 PRD 验收完成前宣称 v0.2 production-ready。
