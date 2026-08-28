---
status: active
document_type: runbook
execution_risk: critical
contract_sha256: "sha256:c36bb10bed332c3f888d9ae6d8f040a7fbdd6169faa870b039016317adffcbb0"
supersedes: ""
superseded_by: ""
date: "2026-08-27"
---

# 本地 Node runtime 安装、启停与诊断 Runbook

<!-- runbook-contract:
- scripts/package-node-runtime.mjs
- scripts/install-node-runtime.mjs
- apps/admin-cli/src
- apps/agent-service/src/service-main.ts
- apps/agent-service/src/production-model-composition.ts
- apps/agent-service/src/production-memory-composition.ts
- apps/execution-worker/src/service-main.ts
- packages/application/src/ports/configuration.ts
- packages/platform-node/src/execution-uds-transport.ts
- packages/platform-node/src/ephemeral-secret-port.ts
- packages/platform-node/src/strict-configuration.ts
- packages/platform-node/src/state-root-layout.ts
- packages/memory-mem0/src/index.ts
- packages/persistence-sqlite/src/product-state-repository.ts
- docs/execution/specs/2026-08-26-portable-durable-web-agent-design.md
-->

## Scope

本 Runbook 只覆盖当前仓库已经验证的本地 Node runtime：从锁定依赖构建可重定位 artifact，安装到明确的绝对前缀，使用受保护的 Execution Worker UDS 启动 Agent Service，执行只读 doctor/db status，并以有界信号完成正常停止或故障重启。它不负责安装 systemd/launchd unit、不修改公网入口、不切换 authority、不配置真实 provider、不部署到 Hermes，也不替代 authority transfer Runbook。

安装产物包含 Agent Service、Execution Worker、admin CLI 及产品运行时包；它不包含 `packages/testing` 的生产 adapter。打包器从列入 runtime 的生产 workspace manifests 自动推导全部直接外部依赖根，再递归复制其依赖闭包；因此 `platform-node` 声明的官方 MCP client 也必须出现在安装产物，新增生产依赖不能依赖手工清单。Agent Service 启动时只从 strict configuration 读取一个 primary、一个 private-only fallback 和一个独立 embedding descriptor；支持的 OpenRouter 配置创建 production Model/Pi 与 Mem0 composition，Mem0 使用配置声明的 embedding provider/model/version 和 dimensions，deterministic 配置只报告 descriptor，不创建隐藏模型或调用 provider。每个构建固定提交内容、package-lock、workspace checksum、Node 平台/架构和外部依赖闭包。由于 `better-sqlite3` 等 native 依赖，Mac 与 Linux 必须分别构建和验收，不能把一个平台的二进制包当作另一个平台的 immutable artifact。

## Authoritative Sources

- 服务启动、authority/SQLite 检查、UDS client/server、信号 drain 和稳定错误码：`apps/agent-service/src/service-main.ts`、`apps/execution-worker/src/service-main.ts`、`packages/platform-node/src/execution-uds-transport.ts`。
- 可重定位 artifact、内部 workspace 包和外部依赖闭包：`scripts/package-node-runtime.mjs`。
- 绝对前缀安装和三个入口：`scripts/install-node-runtime.mjs`。
- state root、SQLite migration、Worker recovery 与身份边界：`packages/platform-node/src/state-root-layout.ts`、`packages/persistence-sqlite/src/product-state-repository.ts`。
- 本 Runbook contract selector 中列出的源文件和 portable durable web-agent Spec。

## Safety and Preconditions

- 目标必须是本机明确的临时或已批准 state root、runtime 前缀和配置路径；不得使用工作目录推断生产路径，不得把 `/data/hermes` 或其他共享 Hermes Agent state root 当作 Himawari 目标。
- 安装前记录 Git HEAD/worktree、package-lock digest、Node/npm、目标前缀和 state root、磁盘可用空间及现有进程。目标前缀必须由本次运行创建，或已取得清理其 `lib/himawari-agent` 的明确授权。
- 配置必须是 strict production profile，authority.json 的 deployment/Owner/Agent/status/epoch/fence 必须与 SQLite 一致；Worker token 只能从 `0600` 文件读取，secret source 不得进入 argv、日志或证据。
- Agent Service 必须先有同一 deployment 的 Worker；Agent Service 不会在 Worker 不可用时降级到进程内执行。两个服务必须使用同一 state root 的 runtime 目录和 boot-scoped token。
- 启停与诊断证据只写入 `test/integration/qualification/evidence/operations/install-start-stop/<unique-run-id>/`，目录 `0700)、文件 `0600)；不记录配置全文、token、secret value 或私人 Payload。

## Live-State Preflight

在安装或启动前执行以下只读检查，并保存脱敏结果：

~~~text
git rev-parse HEAD
git status --short --branch
node --version
npm --version
df -h <target-filesystem>
ps -axo pid,command
~~~

确认构建输入来自当前 checkout 和 committed `package-lock.json`，目标 prefix/state root 是绝对规范路径，目录 owner/mode 安全，旧的 `execution.sock` 不存在或由同一受控进程持有，目标 deployment 没有其他 active service。启动前再运行：

~~~text
<absolute-prefix>/bin/himawari db status --config <absolute-config-path>
<absolute-prefix>/bin/himawari doctor --config <absolute-config-path>
~~~

若目标已有活动服务、state-root lock、socket、authority 不匹配、schema 不完整或可用空间不足，停止；不得删除活锁、覆盖 state root 或猜测服务管理器命令。

## Procedure

1. 对本 Runbook 执行静态 contract check，建立新的受限 evidence 目录，冻结本次构建 commit、prefix、state root、deployment、Owner/Agent 和运行 ID。
2. 在干净或已审阅的工作树上执行 `npm ci --ignore-scripts` 和 `npm run build`。
3. 核对两个 artifact manifest 的提交输入、package-lock SHA、workspace checksum、Node 平台/架构、schema/migration sequence 和依赖版本。确认 runtime 外部依赖根与列入打包的生产 workspace manifests 完全对应，`@modelcontextprotocol/client` 等新生产依赖和传递闭包存在，`@himawari-agent/testing` 不存在；若核对失败，删除本次临时产物并停止。
4. 创建本次明确的绝对安装前缀并安装：

~~~text
mkdir -p <absolute-prefix>
npm run install:node-runtime -- --prefix <absolute-prefix>
~~~

5. 在启动前运行 `himawari db status` 与 `himawari doctor`，确认 SQLite quick check、schema、authority、Payload、Worker 和 identity 的脱敏状态；只读命令失败时不启动普通服务。
6. 以独立子进程先启动 Worker，再启动 Agent Service；记录 `service.ready` 的 component、schema、identity 和 recovery counters。
7. 运行只读 doctor、db status 和适用业务查询；确认 Agent Service 通过 UDS handshake、`service.ready` 记录 model path、memory path 与 embedding descriptor identity、没有 testing adapter、没有 repository checkout 路径，也没有秘密或私人正文输出。deterministic profile 必须显示 descriptor-only；支持的 Pi/Mem0 profile 只能显示配置中的 primary/fallback/embedding reference、version 和 dimensions，不能显示 secret value。
8. 正常停止时先向 Agent Service 发送 `SIGTERM)，等待 `service.draining` 与 `service.stopped`，再向 Worker 发送 `SIGTERM)，等待其停止并确认 socket 已删除。超出有界等待后才记录 forced stop，并把后续启动视为 recovery drill。
9. 重启或 forced stop 后重新取得 state-root lock，确认同一 deployment/Owner/Agent/Run identity、SQLite schema/quick check、pending recovery counters 和 UDS handshake；不得将普通一次重启写成完整 crash matrix。
10. 完成验证后保存脱敏命令输出、artifact identity、进程退出码、socket/lock 回读和 rollback 状态；临时 prefix、临时 state root 与证据目录按本次授权的保留策略清理。

## Verification

- `runtime-manifest.json`、build artifact manifest、package-lock 和 `git rev-parse HEAD` 能互相对应；内部 package 版本和外部依赖版本均为精确值，生产 workspace manifest 的每个直接外部依赖根及其闭包都存在，且安装树不包含 `@himawari-agent/testing`。
- `himawari doctor` 返回 ready，`himawari db status` 显示 managed schema、预期 migration sequence 和 `quickCheck: ok`。
- Worker 与 Agent Service 均从安装 prefix 运行，不依赖 repository cwd、TypeScript source、未声明 `../pi-mono` 或 testing adapter；Worker 先于 Agent Service ready。
- `service.ready` 的 model path、memory path 与 embedding descriptor 来自 strict configuration；deterministic profile 不初始化 Pi 或 Mem0，production Pi profile 只绑定显式 primary/fallback，embedding 不进入 Pi generation registry，而由 Mem0 projection 使用显式 dimensions（本次配置为 4096）。
- 正常停止后无遗留 UDS socket、活跃 state-root lock 或未记录 child process；forced stop 后下次启动仍通过正式 recovery。
- 目标前缀、state root、authority file、SQLite、Payload、runtime/cache 和证据权限符合当前配置；诊断输出不含 token、配置全文或私人正文。
- 该 Runbook 的成功只证明本机安装/启停边界，不证明 Mac/Hermes 双向迁移、真实 provider/GitHub/Cloudflare、systemd/launchd 或 production readiness。

## Evidence

每次执行使用新的 `test/integration/qualification/evidence/operations/install-start-stop/<unique-run-id>/`，记录静态 contract digest、Git HEAD/worktree、Node/npm、平台/架构、artifact/package-lock/workspace checksum、prefix/state-root/authority identity、目录和 socket/lock 权限、磁盘空间、精确命令与 exit status、service ready/draining/stopped 日志摘要、doctor/db status、重启 recovery counters 和清理结论。

只记录稳定错误码、计数、版本和引用；不得记录 secret value、Worker token、环境转储、Cookie、private key、配置全文、Payload plaintext、数据库行或共享 Hermes Agent 数据。

## Rollback

- 构建或安装在服务启动前失败时，只移除本次新建 prefix 和 `dist` 产物；不得触碰既有 state root、其他 prefix 或共享主机服务。
- 服务启动失败时保留脱敏 stderr、authority/lock/socket 现场和 evidence；先停止同一运行创建的 child process，再按正式 doctor/db status 诊断，不能用 `kill -9` 后直接删除活锁。
- 正常停止后若重启验证失败，保持服务停止，回退到本次安装前已验证的 prefix/state root 或走独立 backup/restore；不得把应用回退与数据库恢复、authority transfer 或公网入口切换混为一个动作。
- prefix 清理不删除 Owner 数据；state root、Payload、recovery point、迁移包、secret source 和外部副作用各有独立授权与 rollback 边界。

## Stop Conditions

- Runbook static check、Git/build/artifact contract 或 target-read-only preflight 失败。
- prefix、state root、deployment、Owner/Agent、authority epoch/fence、配置或 Worker token 路径不明确、不匹配或权限不安全。
- 发现活跃 Agent/Worker、UDS socket、state-root lock、未知 child process、testing adapter、repository cwd 依赖或旧 authority 未对齐。
- SQLite 版本、schema/migration digest、quick/full integrity、Payload authentication、Worker handshake、doctor/db status 或 recovery identity 任一失败。
- 需要把 secret 放进 argv/env/log/Trace，扩大安装目录、覆盖既有数据、猜测 systemd/launchd 命令，或对 `/data/hermes` 共享 Hermes Agent state root 做写入。
- 磁盘不足、安装脚本跨出绝对 prefix、服务未在有界时间内 drain/stop，或 forced stop 后现场无法安全回读。
- 要求把本地安装通过等同 Mac/Hermes transfer、真实外部账户、public URL、paid model 或 v0.2 production-ready。

## Troubleshooting

| 症状 | 安全诊断 | 停止或有界修复 |
| --- | --- | --- |
| `ADMIN_ARGUMENT_INVALID` | 只读核对入口参数、绝对 config 路径和命令版本 | 停止并修正参数；不把错误输出当作服务 ready |
| `STATE_ROOT_PATH_UNSAFE` 或权限错误 | 回读规范绝对路径、owner/mode、authority file 和 runtime 目录 | 停止；人工修复已授权目录权限后重新 preflight，不递归清理未知目录 |
| `SQLITE_STATE_ROOT_LOCKED` | 只读检查 lock owner、PID、token、socket 和进程存活 | 保留活锁；确认 owner 已死亡且符合回收规则后再从完整 preflight 重试 |
| Worker UDS handshake/authentication failure | 核对 Worker/Agent 配置、boot token reference、deployment epoch/fence 和 socket owner | 停止 Agent；先修复同一运行 Worker，再重新启动，不降级为进程内执行 |
| `SERVICE_AUTHORITY_MISMATCH` 或 schema error | 对比 authority.json、SQLite deployment、config 和 bundled migration ledger | 停止；选择匹配的 prefix/state root 或走独立迁移/恢复决策，不手工改 authority |
| forced stop 后无法恢复 | 保留 lock/socket/SQLite 现场，运行只读 doctor、db status 和进程检查 | 若正式 recovery 未证明安全则停止，转入 backup/restore 或 incident diagnosis 的独立 Runbook |
| 需要 systemd/launchd 或 Hermes 操作 | 仅确认当前 Runbook scope 不包含服务管理器和远端部署 | 停止；选择经过验证且已授权的对应 Runbook，不猜测命令 |
