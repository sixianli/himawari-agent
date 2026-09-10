---
status: active
document_type: runbook
execution_risk: critical
contract_sha256: "sha256:b15c3532f951d4619d8ae9b727728b2a11e9fcf9543fa8582dae41a3c336c1be"
supersedes: ""
superseded_by: ""
date: "2026-08-27"
---

# 本地 Node runtime 安装、启停与诊断 Runbook

<!-- runbook-contract:
- apps/agent-service/src/production-managed-tasks.ts
- apps/agent-service/src/production-sandbox-stream.ts
- apps/agent-service/src/production-sandbox-services.ts
- apps/execution-worker/src/production-sandbox-execution-v2.ts
- packages/execution-contracts/src/sandbox-readiness.ts
- apps/agent-service/src/capability-programs/pi-coding-main.ts
- packages/runtime-pi/src/sandboxed-coding-executor.ts
- packages/platform-node/src/files/sandboxed-coding-operations.ts
- packages/platform-node/src/files/pi-output-export.ts
- packages/execution-contracts/src/pi-runner-v1.ts
- apps/agent-service/src/production-sandbox-output.ts
- apps/agent-service/src/production-sandbox-control.ts
- packages/application/src/services/sandbox-execution-reconciliation.ts
- packages/runtime-sandbox/src/job-host-control-client.ts
- packages/runtime-sandbox/src/linux-namespace.ts
- packages/execution-contracts/src/sandbox-preparation-v2.ts
- packages/persistence-sqlite/src/migrations/0029_sandbox_execution_preparation.sql
- packages/execution-contracts/src/sandbox-execution-support.ts
- packages/execution-contracts/src/sandbox-host-binding-v1.ts
- packages/execution-contracts/src/sandbox-qualification-v1.ts
- packages/execution-contracts/src/sandbox-execution-v2.ts
- packages/application/src/ports/sandbox-execution-journal.ts
- packages/application/src/services/sandbox-execution-projection.ts
- packages/persistence-sqlite/src/sqlite-sandbox-execution-operations.ts
- packages/persistence-sqlite/src/sqlite-capability-invocation-operations.ts
- apps/execution-worker/src/production-worker-composition.ts
- apps/execution-worker/src/production-sandbox-worker.ts
- packages/platform-node/src/capabilities/sandbox-host-verifier.ts
- packages/application/src/services/sandbox-scope-service.ts
- packages/application/src/services/sandbox-network-authorization.ts
- packages/application/src/services/sandbox-startup-recovery.ts
- apps/execution-worker/src/production-execution-worker.ts
- apps/execution-worker/src/production-sandbox-execution.ts
- apps/execution-worker/src/broker-sandbox-execution.ts
- packages/execution-contracts/src/payload-broker-v1.ts
- packages/platform-node/src/payload-uds-transport.ts
- apps/execution-worker/src/production-payload-broker-client.ts
- packages/runtime-sandbox/src
- packages/application/src/services/sandbox-job-lifecycle-service.ts
- packages/application/src/ports/sandbox-execution.ts
- apps/execution-worker/src/product-job-host.ts
- packages/application/src/services/runtime-continuation-service.ts
- packages/application/src/ports/run-checkpoints.ts
- packages/runtime-pi/src/pi-tool-batch-continuation.ts
- docs/adr/0023-durable-hitl-execution.md
- packages/runtime-pi/src/pi-runtime-adapter.ts
- apps/agent-service/src/capability-programs
- apps/agent-service/src/production-file-read-workflow.ts
- apps/agent-service/src/production-file-read-services.ts
- packages/runtime-pi/src/governed-read-executor.ts
- packages/platform-node/src/files/constrained-file-system.ts
- packages/application/src/services/run-execution-input-service.ts
- packages/application/src/services/run-coordinator.ts
- packages/application/src/ports/run-dispatch.ts
- packages/domain/src/run-state.ts
- apps/agent-service/src/production-run-reconciler.ts
- scripts/ci/build.mjs
- scripts/package-node-runtime.mjs
- scripts/install-node-runtime.mjs
- scripts/generate-artifact-manifest.mjs
- scripts/ci/install-tools.mjs
- scripts/ci/install-dependencies.mjs
- scripts/ci/resources.mjs
- scripts/ci/redact-text.mjs
- scripts/ci/artifact-files.mjs
- scripts/ci/artifact-archive.py
- scripts/ci/contracts.mjs
- scripts/ci/context.mjs
- scripts/ci/check-policy.mjs
- scripts/ci/quality-policy.mjs
- scripts/ci/source-inputs.mjs
- scripts/ci/verify-artifact.mjs
- ci/toolchain-lock.json
- ci/policy.schema.json
- ci/quality-policy.json
- ci/result.schema.json
- ci/coverage.schema.json
- package.json
- package-lock.json
- apps/admin-cli/src
- apps/agent-service/src
- apps/execution-worker/src/service-main.ts
- packages/application/src/ports/configuration.ts
- packages/platform-node/src/authenticated-uds-transport.ts
- packages/platform-node/src/execution-uds-transport.ts
- packages/platform-node/src/ephemeral-secret-port.ts
- packages/platform-node/src/strict-configuration.ts
- packages/platform-node/src/state-root-layout.ts
- packages/memory-mem0/src/index.ts
- packages/persistence-sqlite/src/product-state-repository.ts
- packages/persistence-sqlite/src/sqlite-run-dispatch-operations.ts
- packages/persistence-sqlite/src/sqlite-run-lifecycle-operations.ts
- packages/persistence-sqlite/src/sqlite-run-checkpoint-operations.ts
- packages/persistence-sqlite/src/migration-engine.ts
- packages/persistence-sqlite/src/migrations
- docs/execution/specs/2026-08-26-portable-durable-web-agent-design.md
-->

## Scope

schema 28 在原数据库追加 v2 资源关联、独立操作/资源观察、目录占用和派发回执。升级既有库仍须先取得已验证快照；0020/0027 不改写。恢复/迁移时必须保留占用和未确认派发；旧未结束作业缺少可信目录链时按主机保守阻止新准入，缺少主机身份时阻止所有主机的新准入。禁止通过删除 Run、清空占用或把旧记录改成 v2 来恢复执行。已确认清理的旧历史结果保持原解释，不由迁移补写新资格。

这些 SQLite 机制已有独立测试数据库的升级、重开和事务验证；本次未升级运行中的 state root，也未执行真实安装、恢复或跨主机迁移。正式组合已具备显式 v2 foreground 固定读取/命令路径、目录身份和证据读取，Pi 七工具前台 runner 已有假数据验收，目标安装资格仍须独立验证。恢复后继续适用当前主机/目录/权威检查，不能自动重放旧任务或未确认派发。

SRT 的 Agent Service 和 Worker 启动组合已连接现有准入、目录授权状态、受保护 scope、认证 Payload 通道与作业监督器；scope 来源已支持文件 inspect/read 工作流及已批准 Grant targets 的通用工具范围；七工具前台 runner 及后台执行已有专用假数据验收，目标安装资格仍须独立完成。网络范围须来自本次操作同一 Grant 的审批快照确切小写 hostname:port 目标，并与主机能力上界核对；不新增授权或再次消费 Grant。准入及启动前验证授权、父调用和真实 host/runtime/runner/qualification。缺少可信来源时拒绝。策略只由 Worker 编译，初始观察可无摘要，首次原子启动固定摘要后不可替换。

R8 增加 Job Host 私有认证上游，初始化时强制 SRT 两种代理协议通过上游并禁用 bypass；解析后的非公网地址被拒绝。旧裸域名绑定与审批快照不可自动补端口，须由现有授权流程取得有效的明确端口目标。Worker 对所有 mode 每轮监督都重查原授权，失败后请求 Job Host 关闭；关闭出口会终止连接，不等于撤回已经外发的数据或未知后代的文件权限。监督间隔为 250 ms，但 RPC 和调度会增加实际停止延迟。Node 客户端使用 SRT 生成并规范为数字回环地址的代理 URL，不需要为解析 localhost 开放额外 DNS 服务。联网工具仍须在主机 inventory 中声明其必要的只读系统工具链/证书文件，并验证下载、安装和重定向。出口测试计数不是生产签名资格；不得手工把测试证据复制到部署 qualification。

安装产物源码新增了 R1 的 v2 合同、类型端口和纯判断函数，以及 R2 的 SQLite 账本，正式组合按安装声明分别使用 v1 与 v2 foreground；声明不能代替目标平台资格。新增 `SandboxExecutionPortV2` 导出不代表 Job Host 取得新监督资格，也不会把旧 unknown 回执转换为已清理。后续接入 v2 正式适配器时，须重新核对本 Runbook 的迁移、恢复和安装验证。

v2 broker 与 Worker foreground 已接入准备、登记、唯一绑定、观察和限定核查，并有真实 Mac UDS/SQLite/Worker 假数据验收；R6 已增加显式 background/service 路径，只有 Worker、安装声明与资格共同支持时才可准入。安装清单/资格中的 `supportedExecutions` 仅表示显式兼容声明，不提供授权、监管证明或 v2 启用开关；缺少声明不能推断支持 v2，显式排除 v1 的声明也不能通过旧路径运行。追加 migration 0029 已修正准备顺序：先保存不含运行摘要的执行预留及目录占用，Worker 准备后首次 CAS 固定真实绑定；旧记录保持 `legacy_bound`。迁移仍须通过现有同机备份和停机入口，不能直接对正在运行的产品库执行 SQL。R3 范围/控制接口验收已完成，Pi 工具 runner 已完成专用假数据验收，安装资格仍待完成，不得用占位摘要或把 v2 数据标为 v1 进行安装验收。Job Host 私有 IPC 增加会话/boot/序号/监督窗口，但 PID、心跳、主进程退出及 reset 仍不构成任务树释放证明；真实长临时路径探针在 SRT 初始化出现过 `EADDRINUSE`，安装资格还须验证所选 privateRoot 的实际可用性。

schema 27 的作业账本继续作为持久依据；不能给无账本的旧凭证补建可启动作业，不能自动重放清理未知作业。旧作业读回、清理和重复观察不恢复执行权限。Job Host 接收至多 48 KiB 的私有 IPC 输入，仅送入任务 stdin；正文不进入 argv 或环境变量。stdout 保留原 runner 合同并保存为受保护 Payload；CPU/RSS 观察随作业观察持久保存。固定有界进程采样超限或失败时请求停止，采样不能证明硬配额、所有短命后代都被计入或整个进程树已退出。

Agent 启动在开放准入前还会使用当前权威失效 v2 旧监督观察，保留已知结果、效果和目录占用；此恢复没有启动能力，不按旧 PID 接管进程。Job Host 双向心跳超时会请求停止，过期 IPC 消息不能续期。Worker 卡住、重启记录转为 lost/unknown 的测试通过不表示残留风险已消除；解除占用仍需独立可信清理证据。

真实 Mac 假数据组合探针已验证实际 scope/UDS/SQLite/Worker/Job Host、保护规则、资源记录及隔离后不重放，但使用的是受控测试资格和已准备的测试调用；它不是正式主机资格签发，也没有验证真实模型/HITL 或实际进程崩溃后的安装恢复。正式安装与恢复验收仍待完成。启动时的旧作业核查、清理未知隔离，以及关闭时先保存观察再断开通道的顺序继续适用。安装、备份和权威迁移流程不因组件接入而改变，恢复的旧 Capability 记录不能充当新 SRT profile 的资格。

本 Runbook 只覆盖当前仓库已经验证的本地 Node runtime：从锁定依赖构建可重定位 artifact，安装到明确的绝对前缀，使用受保护的 Execution Worker UDS 启动 Agent Service，执行只读 doctor/db status，并以有界信号完成正常停止或故障重启。它不负责安装 systemd/launchd unit、不修改公网入口、不切换 authority、不配置真实 provider、不部署到 Hermes，也不替代 authority transfer Runbook。

公开服务主入口已连接 HTTP、持久 Run、Pi、已授权 Worker 工具和 Mem0。缺少 `runPolicy`、HTTP、身份配置或实际模型配置时，仍以 `SERVICE_PUBLIC_MODE_INCOMPLETE` 拒绝启动。启用前必须验证同一安装候选的完整请求、持久结果和重启回读；库导入成功或 `service.ready` 不能替代这些证据，也不能替代实际目标环境资格。

文件读取工具已复用 Pi `read` 定义，无 Handle 调用表示读取意图。正式组合已提供 inspect/read 两阶段工作流，持久保存调用 context、阶段输入和 Handle，并通过 Worker 派发；读取与模型披露分别检查授权。缺少有效路由或目录授权时拒绝执行，需要审批时保存等待状态。安装及服务启动成功仍不能证明实际 Mac 文件读取可用，须完成目标 Worker 隔离资格及全流程验收。Agent Service 不执行 Pi 默认本机文件 I/O，既有可执行工具仍通过受限 `inputRef` 使用 Worker。

安装产物包含 Agent Service、Execution Worker、admin CLI 及产品运行时包；它不包含 `packages/testing` 的生产 adapter。打包器从列入 runtime 的生产 workspace manifests 自动推导全部直接外部依赖根，再递归复制其依赖闭包；因此 `platform-node` 声明的官方 MCP client 也必须出现在安装产物，新增生产依赖不能依赖手工清单。Agent Service 启动时只从 strict configuration 读取一个 primary、一个 private-only fallback 和一个独立 embedding descriptor；支持的 OpenRouter 配置创建 production Model/Pi 与 Mem0 composition，Mem0 使用配置声明的 embedding provider/model/version 和 dimensions，deterministic 配置只报告 descriptor，不创建隐藏模型或调用 provider。每个构建记录提交身份、实际源码与 package-lock 摘要、workspace checksum、Node 平台/架构和外部依赖闭包；已审阅的未提交改动不能被省略为只有提交身份。由于 `better-sqlite3` 等 native 依赖，Mac 与 Linux 必须分别构建和验收，不能把一个平台的二进制包当作另一个平台的 immutable artifact。

## Authoritative Sources

- 服务启动、authority/SQLite 检查、UDS client/server、信号 drain 和稳定错误码：`apps/agent-service/src/service-main.ts`、`apps/execution-worker/src/service-main.ts`、`packages/platform-node/src/execution-uds-transport.ts`；共享认证、socket 权限和绝对截止时限由 `packages/platform-node/src/authenticated-uds-transport.ts` 管理。
- 可重定位 artifact、内部 workspace 包和外部依赖闭包：`scripts/package-node-runtime.mjs`。
- 绝对前缀安装和三个入口：`scripts/install-node-runtime.mjs`。
- 固定工具、禁用未知安装脚本和 SQLite 原生构建探针：`ci/toolchain-lock.json`、`scripts/ci/install-tools.mjs`、`scripts/ci/install-dependencies.mjs`。
- 安装期间的磁盘采样与错误脱敏：`scripts/ci/resources.mjs`、`scripts/ci/redact-text.mjs`；采样只提供观测峰值下界，出现采样错误时须保留不完整状态和有界诊断，不能从安装成功推导采样完整。协调暂停单独记录原因、耗时和操作结果，不抹去暂停前的失败。
- 文件模式、内容摘要和归档校验：`scripts/ci/artifact-files.mjs`、`scripts/ci/verify-artifact.mjs`。CI 归档安装还绑定同一次运行的 context；它与下述本机目录安装入口有不同的输入参数。 Context 的来源由 `scripts/ci/context.mjs` 核验；周期质量归档还核对已提交的启用状态、默认分支、cron 与同次 SHA，不能通过临时修改工作树取得周期身份。共享 Context 支持周期事件不启用任何安装或周期操作。
- CI 源码摘要记录实际工作树中的构建输入，包含普通源码的新增、修改、删除和文件模式，不能只记录 Git HEAD。构建器仍引用的模块或显式必需文件缺失时必须失败；构建期间及安装前再次核对摘要，不能用忽略所有缺失文件的方式通过校验。
- state root、SQLite migration、Worker recovery 与身份边界：`packages/platform-node/src/state-root-layout.ts`、`packages/persistence-sqlite/src/product-state-repository.ts`。
- 本 Runbook contract selector 中列出的源文件和 portable durable web-agent Spec。

本地安装合同补充：Worker 以 deployment binding.kind 区分 sandbox 与旧 process 后端；SRT 不需要伪造旧 process isolation 配置，仍须通过真实 host 资格复核。权限续租只改变到期信息时，不使并发读取失去原权威；停止或身份变化仍必须拒绝。公开网页客户端先创建产品 session，再从认证配置读取 sessionId，不能拼造 ID。重复 Payload 上传须比较带 `sha256:` 前缀的同一正文摘要；并发活跃时间更新冲突时重新检查会话及设备撤销状态。这些规则已通过实际 HTTP／SQLite 和并发回归验证。

Hermes 的 systemd、Cloudflare 入口、Host 签名与付费模型验收是 Owner 另行明确授权的部署操作，证据记录在 [SOURCE: docs/execution/plans/2026-09-07-srt-unified-execution-plan.md] 的 R8；不扩张本 Runbook 的本地安装操作范围。

## Safety and Preconditions

- 目标必须是本机明确的临时或已批准 state root、runtime 前缀和配置路径；不得使用工作目录推断生产路径，不得把 `/data/hermes` 或其他共享 Hermes Agent state root 当作 Himawari 目标。
- 安装前记录 Git HEAD/worktree、package-lock digest、Node/npm、目标前缀和 state root、磁盘可用空间及现有进程。目标前缀必须由本次运行创建，或已取得清理其 `lib/himawari-agent` 的明确授权。
- 配置必须是 strict production profile，authority.json 的 deployment/Owner/Agent/status/epoch/fence 必须与 SQLite 一致；Worker token 只能从 `0600` 文件读取，secret source 不得进入 argv、日志或证据。
- 启用真实 Worker 能力时，配置必须引用 Owner 独占、非符号链接、大小有界且 SHA-256 匹配的不可变能力部署快照。快照中的 Manifest、平台资格和 runtime binding 必须与当前 build、平台及 Agent Service 的 active Capability Registry 一致；空、缺失、被改写或不合格的快照必须使 Worker 保持 not ready。
- Agent Service 必须先有同一 deployment 的 Worker；Agent Service 不会在 Worker 不可用时降级到进程内执行。两个服务必须使用同一 state root 的 runtime 目录和 boot-scoped token。
- 启停与诊断证据只写入 `test/integration/qualification/evidence/operations/install-start-stop/<unique-run-id>/`，目录 `0700`、文件 `0600`；不记录配置全文、token、secret value 或私人 Payload。

公开模式的 `runPolicy` 必须显式配置，例如：

~~~json
{
  "version": "owner-policy-v1",
  "systemInstruction": "按用户请求执行已授权任务。",
  "memoryLimit": 20,
  "maxSelectedMemories": 5,
  "maxMemoryClassification": "private"
}
~~~

系统指令不得包含凭据。Memory 选取数不得超过检索数，实际注入分类同时受当前 Run 分类约束。模型描述符和费用上限仍由原配置字段提供。修改配置只影响尚未冻结输入的 Run；运行中的已冻结请求不会改用新指令。已有数据库需按同机 snapshot 和迁移合同升级到当前 schema，不能跳过备份直接启动旧库。

启用文件读取时，`runPolicy.fileRead` 必须引用当前 Worker instance、目标 hostId、既有目录 Grant 和匹配的 Capability 版本。能力 program 的固定 argv 应指向安装树中 agent-service 包的 `dist/capability-programs/host-file-read-main.js` 并携带 hostId/workerInstanceId；该入口由 Worker 隔离后端启动，不能在 Agent Service 内执行。Manifest 声明 inspect/read/disclose，后者仅用于授权。配置、程序存在或打包成功均不创建动作授权，也不替代本机能力隔离资格。

项目七工具使用独立的 `dist/capability-programs/pi-coding-main.js`，固定 argv 仍是 hostId/workerInstanceId；安装 operationBindings 显式声明 `pi-coding-tool` 版本 `1`，只读工具采用 fixed_read，bash 采用 command，write/edit 采用带 verifier 的 verified_effect。scope 必须是 authorized-project.v1，仍复用 Grant targets 和原准入通道。该入口不能替代 host-readonly.v1 的 inspect/read 审批。工具目录不会因为文件存在而自动向模型开放能力。

在计算 runtimeDigest 和主机资格之前准备 `runtimeRoot/pi-tools/bin/bash`、`rg`、`fd`：必须为适合目标 OS、可实际执行的普通文件，不接受符号链接。运行环境仅使用该目录作为 PATH，PI_OFFLINE=1；缺依赖明确失败。不要直接复制 macOS 平台签名的系统 Bash 并假定副本能运行；须验证实际安装文件及其签名/加载依赖。其他命令依赖同样须先安装在允许且固定的工具链内，不能以工具运行触发隐式下载。新增二进制会改变 runtimeDigest，须重新取得当前主机资格。

通用 HITL 需要 migration 0026、受保护恢复 Payload、审批存储和执行租约一同可用。公开入口使用已有身份与 CSRF 校验提供 `approval.list/detail/respond`，Thread 的等待、恢复和取消状态通过持久事件通知页面。等待审批不占用执行槽位；批准、拒绝、审批过期或原 Run 总期限到达后才重新领取。恢复仍使用原始截止时间，不能重新分配时长。其他治理操作未因审批入口接入而自动启用。

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
2. 在干净或已审阅的工作树上按 README 安装固定工具链，再执行 `npm run ci:install`；该入口先运行 `npm ci --ignore-scripts`，只构建清单中已审阅的 SQLite 原生依赖并实际验证内存读写。将本次工具目录的 `bin` 放到 PATH 后执行 `npm run build`。工具目录和安装证据目录必须是本次新目录，已有目录使用显式参数另选路径，不覆盖旧证据。不能把未校验的旧 node_modules 或单独 `npm ci --ignore-scripts` 当作完成原生依赖安装。
3. 核对两个 artifact manifest 的提交输入、package-lock SHA、workspace checksum、Node 平台/架构、schema/migration sequence 和依赖版本。确认 runtime 外部依赖根与列入打包的生产 workspace manifests 完全对应，`@modelcontextprotocol/client` 等新生产依赖和传递闭包存在，`@himawari-agent/testing` 不存在；若核对失败，删除本次临时产物并停止。
4. 创建本次明确的绝对安装前缀并安装：

~~~text
mkdir -p <absolute-prefix>
npm run install:node-runtime -- --prefix <absolute-prefix>
~~~

5. 在启动前运行 `himawari db status` 与 `himawari doctor`，确认 SQLite quick check、schema、authority、Payload、Worker 和 identity 的脱敏状态；若配置声明能力部署快照，还要回读其规范路径、owner/mode、字节数、SHA-256、Manifest/运行绑定数量和本平台资格结论。只读命令失败时不启动普通服务。
6. 以独立子进程先启动 Worker，再启动 Agent Service。Worker 先公布本次 `workerInstanceId/workerBootId`；Agent 取得当前 authority lease 后启动反向权限与 Payload 服务，再发布同时绑定双方实例、boot 和当前 authority 的启动文件，最后完成 Worker handshake。记录双方 `service.ready` 的 component、schema、identity 和 recovery counters；只存在 socket 或旧启动文件不算完成握手。
7. 运行只读 doctor、db status 和适用业务查询；确认 Agent Service 通过 UDS handshake、`service.ready` 记录 model path、memory path 与 embedding descriptor identity、没有 testing adapter、没有 repository checkout 路径，也没有秘密或私人正文输出。deterministic profile 必须显示 descriptor-only；支持的 Pi/Mem0 profile 只能显示配置中的 primary/fallback/embedding reference、version 和 dimensions，不能显示 secret value。
8. 正常停止时先向 Agent Service 发送 `SIGTERM`。Agent 按已登记资源先停止接纳、等待在途工作，再逆序关闭依赖；Memory 消费者停止领取新任务并等待当前批次完成后，才关闭 Memory、模型、authority 和 SQLite。等待 `service.draining` 与 `service.stopped`，再向 Worker 发送 `SIGTERM`，等待其停止并确认 socket 已删除。超出有界等待后才记录 forced stop，并把后续启动视为 recovery drill。
9. 重启或 forced stop 后重新取得 state-root lock，确认同一 deployment/Owner/Agent/Run identity、SQLite schema/quick check、pending recovery counters 和 UDS handshake；不得将普通一次重启写成完整 crash matrix。
10. 完成验证后保存脱敏命令输出、artifact identity、进程退出码、socket/lock 回读和 rollback 状态；临时 prefix、临时 state root 与证据目录按本次授权的保留策略清理。

## Verification

- 未保存完整审批暂停点的中断执行交给生产恢复组件后，Run 与 checkpoint 必须同时显示 `reconciling_external_result`，旧执行租约失效，已有结果引用保留；恢复不能重新调用模型或工具。此检查当前有本地 SQLite 证据，完整安装入口验证仍待完成。已经待核实的记录不重复占用初始扫描批次，不代表外部结果已经确认。

- `runtime-manifest.json`、build artifact manifest、package-lock 和 `git rev-parse HEAD` 能互相对应；内部 package 版本和外部依赖版本均为精确值，生产 workspace manifest 的每个直接外部依赖根及其闭包都存在，且安装树不包含 `@himawari-agent/testing`。
- `himawari doctor` 返回 ready，`himawari db status` 显示 managed schema、预期 migration sequence 和 `quickCheck: ok`。
- Worker 与 Agent Service 均从安装 prefix 运行，不依赖 repository cwd、TypeScript source、未声明 `../pi-mono` 或 testing adapter；Worker 先于 Agent Service ready。
- Worker ready 必须来自非空且完整验证的能力部署快照；`capabilityRef + version + artifact digest + platform qualification + runtime binding` 任一不一致时，真实能力 adapter 不得注册或执行。
- `service.ready` 的 model path、memory path 与 embedding descriptor 来自 strict configuration；deterministic profile 不初始化 Pi 或 Mem0，production Pi profile 只绑定显式 primary/fallback，embedding 不进入 Pi generation registry，而由 Mem0 projection 使用显式 dimensions（本次配置为 4096）。
- 正常停止后无遗留 UDS socket、活跃 state-root lock 或未记录 child process；forced stop 后下次启动仍通过正式 recovery。
- Worker 重启产生新 boot identity 后，旧 Agent 启动绑定必须失效；只重启 Worker 不得沿用旧 Agent/Worker 配对。当前 authority 或任一 peer identity 不匹配时，权限与 Payload 请求不得通过。
- 配置了生产 Memory 时，ready 前已执行消费者启动与当前 authority 检查；每次新任务领取前再次检查权威。只构造 Mem0 对象不算消费者就绪。该消费者证据不代表其他尚未接入的后台任务已经运行。
- 当安装产物启用持久执行领取时，验证领取使用当前实际权威和新进程身份，旧执行不能续租或写 Run/检查点；恢复必须区分安全续跑与未知结果待核对。停止服务不得伪造 Owner 取消，也不能仅凭启动日志或表中存在租约就认定领取循环已接入。
- 启用持久 Run 组合时，核对 `deadlines.runMs` 已冻结为受保护输入中的绝对截止时间；恢复不得超过首次冻结的截止时间。缺少截止时间的旧执行快照不能自动重建或继续执行，应保留现场并核实旧执行状态。超时必须请求停止当前执行并拒绝迟到成功，Worker 请求的截止不能超过父 Run。
- 目标前缀、state root、authority file、SQLite、Payload、runtime/cache 和证据权限符合当前配置；诊断输出不含 token、配置全文或私人正文。
- 该 Runbook 的成功只证明本机安装/启停边界，不证明 Mac/Hermes 双向迁移、真实 provider/GitHub/Cloudflare、systemd/launchd 或 production readiness。

- 对保存了完整 `awaiting_approval` checkpoint 的 Run，核对对应审批、恢复正文、原工具调用和模型调用序号均可回读；待决时无新执行租约，作出决定后使用新租约。重启后的已确认工具阶段不得重复执行，未知阶段继续核查。原 Run 已取消或超过总期限时不得继续读取或调用模型。

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
- 能力部署快照缺失、可被其他账号写入、为符号链接、超出上限、SHA-256 不符、含未知或重复项，或 Manifest、资格、runtime binding 与当前平台/注册表不一致。
- 需要把 secret 放进 argv/env/log/Trace，扩大安装目录、覆盖既有数据、猜测 systemd/launchd 命令，或对 `/data/hermes` 共享 Hermes Agent state root 做写入。
- 磁盘不足、安装脚本跨出绝对 prefix、服务未在有界时间内 drain/stop，或 forced stop 后现场无法安全回读。
- 要求把本地安装通过等同 Mac/Hermes transfer、真实外部账户、public URL、paid model 或 v0.2 production-ready。

## Troubleshooting

Unix socket 路径以 UTF-8 字节计数，macOS 最多 103 字节、Linux 最多 107 字节（不含终止 NUL）。启动在绑定前拒绝超长路径；应选择更短的独立 state root，不能依靠系统截断后的文件名或手工改 socket 名称继续运行。

| 症状 | 安全诊断 | 停止或有界修复 |
| --- | --- | --- |
| `ADMIN_ARGUMENT_INVALID` | 只读核对入口参数、绝对 config 路径和命令版本 | 停止并修正参数；不把错误输出当作服务 ready |
| `STATE_ROOT_PATH_UNSAFE` 或权限错误 | 回读规范绝对路径、owner/mode、authority file 和 runtime 目录 | 停止；人工修复已授权目录权限后重新 preflight，不递归清理未知目录 |
| `SQLITE_STATE_ROOT_LOCKED` | 只读检查 lock owner、PID、token、socket 和进程存活 | 保留活锁；确认 owner 已死亡且符合回收规则后再从完整 preflight 重试 |
| Worker UDS handshake/authentication failure | 核对 Worker/Agent 配置、boot token reference、deployment epoch/fence 和 socket owner | 停止 Agent；先修复同一运行 Worker，再重新启动，不降级为进程内执行 |
| `SERVICE_AUTHORITY_MISMATCH` 或 schema error | 对比 authority.json、SQLite deployment、config 和 bundled migration ledger | 停止；选择匹配的 prefix/state root 或走独立迁移/恢复决策，不手工改 authority |
| forced stop 后无法恢复 | 保留 lock/socket/SQLite 现场，运行只读 doctor、db status 和进程检查 | 若正式 recovery 未证明安全则停止，转入 backup/restore 或 incident diagnosis 的独立 Runbook |
| 需要 systemd/launchd 或 Hermes 操作 | 仅确认当前 Runbook scope 不包含服务管理器和远端部署 | 停止；选择经过验证且已授权的对应 Runbook，不猜测命令 |

### v2 原环境核查约束（2026-09-09）

恢复必须保留既有受保护 Run trace 中的控制引用、终态证据及其 Payload；不得仅备份 SQLite 中的 PID。当前 Agent 权威通过原环境认证控制端口 inspect/stop，或读取原 Job Host 的签名终态；身份、目录 inode、策略或宿主变化时继续隔离，不能在目标主机按旧 PID 停止或重启。Agent 仅加载不含 SRT 启动能力的控制客户端。

Linux 前台清理证据要求原 PID namespace init 已消失及完整终态；Mac 已启动任务没有全树保证时继续 unknown。端口失联、证据不完整和超时均不能解除相交占用。真实假数据探针不签发安装资格；不得把测试临时 bubblewrap/socat 的 PATH 配置用于生产，生产依赖位置须单独验证。实际安装、备份恢复和跨主机迁移的既有步骤及审批边界保持适用。

### 资源输出分页保留

v2 已保存输出的分页引用和 cursor 归原 Run 的受保护 artifact；同机恢复须一同保留对应加密 Payload、artifact 关联及原作业账本。游标只定位原调用/资源的固定输出快照，不能改写为宿主路径，也不能用来重新执行任务。原输出缺失或摘要不符时拒绝，不能以空文件代替；权威迁移仍按原回执和当前身份拒绝旧 Worker 输出权限。R6 追加了后台运行输出片段、结束标记和命令退出事实，均归原 Run；恢复时须同时保留这些 artifact，不补造丢失片段、不重启原命令。后台/服务的目标安装资格仍须独立验证。

### 受管理后台资源的安装与恢复

后台 Bash 继续使用安装的 Pi runner 和固定工具链；其运行模式由 Worker 从匹配的操作声明传入，不能从模型参数选择。前台 Bash 保留原结果格式；后台输出只在完整行检查后追加，末尾无换行内容在退出时检查，机器秘密命中即停止并拒绝输出。start 回执只表示资源已启动，命令退出码另存入连续输出的结束事实。资源句柄与管理调用不能重复消费 Grant。

服务仅在安装声明含匹配的 `readinessProbes` 且具备该模式资格时启用。本批探针使用私有目录内唯一 Unix socket 的 HTTP GET、预期 2xx 状态和最多 30 秒期限；不开放通用本地 TCP 或其他 Unix socket，不以日志判断就绪。恢复后的声明、运行文件与资格必须重新匹配；不得凭旧 ready 回执连接新服务。

Run 正常完成前停止其后台资源；SQLite 完成事务拒绝仍有未释放资源的 Run。未知清理进入原核查流程并保留写目录占用。Mac 测试主进程退出仍不证明任意后代已全部退出，不能清除隔离以获得正常完成。这里没有新增迁移文件、安装资格签发或运行中数据库修改步骤。
