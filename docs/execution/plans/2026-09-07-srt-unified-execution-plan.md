---
status: active
document_type: plan
supersedes: ""
superseded_by: ""
date: "2026-09-07"
---

# SRT 统一执行实施计划

**来源 Spec：** [SOURCE: docs/execution/specs/2026-09-07-srt-unified-execution-design.md]

**目标：** 按已确认的 SRT 架构交付正式 Worker 的统一执行能力，并保留 Pi 工具与 Agent loop、Himawari 的通用授权和持久状态。

**架构：** 应用层接纳动作并冻结授权输入，Execution Worker 监督每作业 Job Host，固定 SRT 适配管理受限执行。Web/远程 MCP 等外部服务通过狭窄产品适配接受相同治理。首批包含原目录文件与编码操作、Shell、MCP、授权联网、真实 Web Search 和已有 commit GitHub 推送；下列依赖顺序不改变首批范围。

本计划覆盖整批交付。Task 1–2 已完成，Task 3 已获继续实施授权，以下按已验证结果标记。Task 1–2 的合同和本地测试通过不代表安装资格、真实模型或浏览器验收通过。

## 文件与调用方边界

| 责任 | 当前入口及改动位置 | 迁移要求 |
|---|---|---|
| Pi 工具与调用身份 | `packages/runtime-pi/src/governed-coding-tools.ts`、`governed-host-operations.ts`、`pi-runtime-adapter.ts`、`governed-read-executor.ts` | 复用固定 Pi 工厂；每调用 Operations 绑定；Agent 侧只接纳意图，复合工具在 runner 中执行 |
| 产品执行合同 | `packages/execution-contracts/src/sandbox-execution-v1.ts`、`packages/application/src/ports/sandbox-execution.ts` | 严格 schema、作业身份与回执；不暴露 SRT 类型，不替换 execution.v2 |
| 授权计划投影 | `packages/application/src/services/sandbox-execution-plan.ts`、`apps/agent-service/src/production-runtime-tools.ts` | 复用现有 invocation key、Handle/inputRef 与租约；正式派发时复核当前权威 |
| 审批与恢复 | `runtime-continuation-service.ts`、`production-file-read-workflow.ts`、Run checkpoint 与 Pi continuation | 沿 ADR 0023 恢复；保留原期限、模型和父子调用关系 |
| SRT 基础设施 | `packages/runtime-sandbox` 与待实现的 Worker `sandbox-job-main` | 唯一直接依赖固定版本 SRT 的包，每作业独立 manager，干净环境与监督清理 |
| Worker 与通信 | `apps/execution-worker/src/production-worker-composition.ts`、现有 execution admission 与 Payload broker | 原可信 UDS/Handle 通道继续使用；新增 Job Host 私有 IPC 不给任务进程 |
| 作业持久观察 | `packages/persistence-sqlite` migration、Capability invocation/result 与 Run artifact 操作 | 在现有权威下追加 job/attempt/sequence 与清理记录；CAS 防重复，未知结果不重放 |
| 文件与命令 | `capability-programs/host-file-read.ts`、`HostFileReadService`、`platform-node` workspaces/capabilities | 固定 runner 内复用；覆盖 program、命令、导入导出与 stdio MCP 的全部可达启动点 |
| 外部能力 | `integration-web`、`integration-github`、MCP 客户端与生产工具组合 | 真实 provider；Git push 独立动作和凭据，监控仍只读；不重写协议 |
| 安装与检查 | runtime 打包脚本、边界检查、主机资格和相关 Runbook | 固定依赖与产物摘要；逐平台验证；实际合同变化后语义核对再封存 |

## 实施任务

### Task 1：设计、覆盖与提交基线

- [x] 将已确认范围、ADR 0024 与 SRT Spec 整理为本计划，明确调用方及依赖顺序。
- [x] 原始指南补治理元数据，核对移除元数据后的正文 SHA-256 保持不变。
- [x] PRD 覆盖表按原目录编码、授权联网、真实搜索、独立 push 语义重新核对；同步覆盖摘要及条款数。
- [x] 修订 S1/S6 中与已确认范围冲突的排除说明，保留只读监控和 commit gate。
- [x] 完成检查并按独立目的整理提交本轮及前轮已完成的相关改动；已有全仓 lint 另行记录，不批量改写无关代码。

### Task 2：统一合同与每次调用绑定

- [x] 定义 `sandbox-execution.v1`、`SandboxExecutionPort` 和严格回执校验，覆盖 prepare/start/observe/cancel/reconcile 与清理结果。
- [x] 执行计划从现有 Capability 回执与 Run 请求投影；核对调用 key、inputRef、Owner/Agent/Thread/Run、模型、租约与期限，避免扩大资源范围。
- [x] Pi 工具工厂提供互斥的 `operationsForCall`；每次调用独立绑定，异步绑定前后检查取消，保留 Worker 单次固定 Operations 用途。
- [x] 本地测试覆盖并发身份、恢复后重新绑定、撤权和取消；合同测试覆盖跨调用/租约替换、过期、非法字段、未知结果与终态重启拒绝。
- [x] 完成最终类型、边界和相关回归，并记录证据。

Task 2 不新增第二个权限库、Run 状态机或数据库。schema 校验不能证明记录来自可信来源；Worker 持久接纳时仍需复核当前权限、受保护 scope 与主机资格。

### Task 3：正式 Worker/SRT 作业基础

- [x] 固定 `@anthropic-ai/sandbox-runtime@0.0.75`，只由 `runtime-sandbox` 直接依赖；依赖边界检查和 Node 产物打包纳入此包。
- [x] 增加候选策略编译：规范绝对路径、独立目录、全盘读取默认拒绝与显式例外、受保护路径、严格域名白名单及共享默认写目录拒绝。
- [x] 增加可安装的 Job Host 入口与父进程控制器；在干净环境中固定一次初始化策略，支持显式启动和有界取消。正式 Worker 与持久账本监督接线仍见后续未完成项。
- [x] 定义受保护 `sandbox-scope.v1` 正文，携带目录授权版本与父调用引用；准入前复用 Payload 解密、验证摘要和调用/主机/输入/授权/模型/profile/有效期绑定。
- [x] scope 校验复用 `HostFileStatePort.readGrant()` 检查当前目录授权的主机、版本、根身份、授权引用、有效期和操作范围；绑定准入请求的父请求 ID。
- [ ] 将目录授权状态来源接到正式主机，补齐网络授权、父工具调用关系及 host/runtime/runner/qualification 验证，并在启动点重新核查。
- [x] 增加 SQLite 作业账本与启动意图 CAS：同一 invocation 唯一 attempt，记录观察历史，支持重开读回与待核查作业分页。
- [x] 将 SRT 凭证消费与作业准备放入同一 SQLite 事务；消费后缺少账本的旧请求拒绝重新准入，首次观察写入失败回滚权限消费。
- [x] 既有 Worker 准入服务支持显式 SRT 模式：使用原子建账返回的冻结凭证构造首次执行消息；重放、未知或 scope 准备失败不派发，不退回独立消费路径。
- [x] 执行消息携带可信准入分配的 SRT job/attempt 身份，校验调用范围和回执绑定；当前 Worker 在转换为旧执行请求前拒绝 SRT 作业，防止误用旧后端。
- [ ] 在生产组合中提供真实 scope/资格解析并启用 SRT 模式，将原子准入与账本接到正式 prepare/start/observe/cancel/reconcile；启动前还须验证受保护 scope、主机资格与代理初始化。
- [ ] 使用真实 SRT 在 Mac 专用目录验证读写与命令、假秘密保护、越界与未授权联网、超时取消、进程和继承管道观察，以及清理未知时的持久隔离、禁止自动重放和核查。
- [ ] 需要启用 Linux profile 时，在 Hermes 的隔离测试目录单独取得证据；先确认磁盘挂载与空间。

当前证据（2026-09-08）：`packages/runtime-sandbox/test/policy.unit.test.ts` 覆盖策略非法字段、目录相交、权限例外、符号链接与异步输入改变。`npm run build:node` 后运行 `node packages/runtime-sandbox/scripts/qualify-policy.mjs`，在 Mac 自动创建的专用假数据目录验证读取、写入、假秘密拒绝、目录越界拒绝、符号链接越界拒绝与代理联网拒绝。网络断言核对 SRT 的 `blocked-by-allowlist` 响应头及拒绝正文，不能用任意 curl 失败冒充通过。探针退出码 0、stderr 为空；依赖探针 errors/warnings 均为空。

此探针仅验证固定脚本下的策略，输出明确保持 `productionSuitable: false`；不是正式 Worker 接线、授权 scope 存储或平台资格签发。资源观测与超限停止、未知清理的持久隔离与 Worker 崩溃核查、正式启动接纳仍缺完整实现与证据；新增账本仅提供持久化基础。2026-09-08 Owner 已取消 CPU/内存硬上限作为硬性验收要求，改用资源观测和超限停止；不得声称原生 SRT 提供硬配额。SRT 0.0.75 的配置没有硬 CPU/内存限制；`cleanupAfterCommand()` 与 `reset()` 不负责证明任务后代全部退出。因此不能只用启动参数适配或 `kill(-pid)` 启用生产 profile。权限 scope 的原始授权、host/runtime/runner 摘要及 TOCTOU 复核仍必须在正式接纳与启动点完成，策略编译不能替代这些检查。

Job Host 组件证据（2026-09-08）：新增 `runtime-sandbox/src/job-host-main.ts` 与父进程控制器，准备完成不自动启动，父进程必须显式提交 start；子进程不继承宿主秘密环境和 Worker IPC。策略编译将 SDK 的 HOME 默认路径绑定到作业私有 HOME，避免父子摘要不同。取消在 SDK 初始化或启动描述生成期间发生时，清理等待该阶段结束，并保留强制退出期限。收到启动意图后失联而没有启动观察，返回启动未知，不能标成未执行。

`packages/runtime-sandbox/scripts/qualify-job-host.mjs` 使用固定假数据，在真实 Mac SRT 验证显式启动、参数原样传递、假秘密拒绝、输出洪泛、取消、超时及策略摘要变化拒绝；`--installed` 验证打包入口。新增单元测试与已有策略测试共 18 项通过。实际 `setsid()` 负向用例已证明：主命令退出、stdio 关闭、SRT reset 成功后，脱离原进程组的子进程仍能写入专用测试文件。该测试子进程有界自退出，不留下常驻任务。因此当前控制器对已启动任务始终报告 `taskTreeCleanup: unknown`；源码探针和安装产物均不签发生产资格。2026-09-08 Owner 已接受首批原生 Mac 不以任意后代必定回收为硬性条件；上述负向证据保留为已知限制。正式启用仍须完成尽力停止、清理未知持久化、禁止自动重放及重启核查，不把组件探针计为这些接线的验收。

Task 4 的前置账本部分已提前实施：追加迁移 `0027_sandbox_job_observations.sql`，通过 `SqliteProductStateRepository.sandboxJobJournal()` 提供原子准入、追加、读回与待核查分页。在同一个 `BEGIN IMMEDIATE` 事务内检查现有部署权威、Handle/Grant、Run 和执行租约，再保存启动序号；回放返回 `applied: false`，不能据此再次启动。过期后仍可在当前部署权威下追加停止/核查观察；完成必须引用本次调用已持久化的受保护输出。`admit()` 已将现有凭证消费与首条作业观察放入同一事务，直接的独立 `sandboxPrepare` 写入口已禁止。摘要由实际消费结果生成；重放凭证没有账本时直接拒绝，不能补建后自动启动。首次观察写入失败时凭证和 Handle 消费一起回滚。`WorkerDelegationAdmissionService` 已支持由可信组合显式选择的 SRT 模式，使用事务返回的冻结凭证构造既有 Worker 消息，避免二次消费或额外读回。真实 SQLite 测试验证首次单次派发、重放不派发、未知旧请求、scope 准备失败及准备期间权限过期拒绝执行。准入时间在异步准备完成后重新获取。生产 `service-main` 尚未配置此模式；作业身份已通过 `work.execute.payload.sandboxJob` 和现有认证 UDS 传递；调用方不能指定该身份。当前 Worker 返回 `SANDBOX_SUPERVISOR_UNAVAILABLE`，不会丢弃身份后使用旧后端执行。`SandboxScopeService` 已从现有 Payload 存储读取有界 JSON 正文，使用现有加密端口验证 Owner/Agent 与内容完整性，再验证 scope 摘要及计划绑定；错误仅返回 `SANDBOX_SCOPE_UNAVAILABLE`，不泄露正文。准入服务必须先通过此检查才能消费凭证。真实加密 Payload 与 SQLite 测试覆盖身份替换、过期、密文篡改和摘要替换。目录授权校验已通过既有状态端口接入，拒绝缺失、撤销、过期、版本/根/主机/授权变化及操作范围不足；scope 中的 `parentRequestId` 必须匹配准入请求的 causationId。测试使用真实加密 Payload/SQLite 与注入的目录状态端口，并非正式主机授权来源验收。正式目录状态来源、网络授权、父工具调用关系、主机资格解析与 Job Host 监督仍待接入。

真实 SQLite 回执暴露并修复了原合同的摘要格式不匹配：`semanticFingerprint` 保留持久凭证的 `sha256:` 前缀，不改写旧凭证。execution-contracts 的内部相对导入改为项目既有的 `.ts` 源码写法，使 SQLite 源码 Worker 可以加载校验器；Node 构建仍将路径改写为 `.js`。相关回归覆盖旧 schema 26 升级、数据库重开、重复启动、租约改变、Handle 撤销、Run 取消、过期清理、事务回滚、输出持久化与终态禁止重启。正式 Worker/Job Host 仍未切换到这套账本，不能将这些测试计为主机执行资格。

### Task 4：持久作业观察与通用 HITL

- [x] 在既有 invocation/result 权威下追加账本迁移：job 唯一 attempt 关联、观察 sequence、政策摘要、清理/副作用状态；不改写旧 receipt 或旧 migration。
- [x] 账本层将当前 fence/lease/Handle 校验与启动状态写入同一事务；相同观察重放只读回，未知状态禁止重新进入执行。正式恢复协调器仍待接入。
- [ ] 审批前不启动作业；批准后按新租约重验，保留原期限及模型；取消、拒绝、过期均有确定反馈。
- [ ] 用真实文件读取与受控写入/删除两个场景验证活跃进程和重启恢复，覆盖并发批准、取消竞态、Worker/Job Host 崩溃及清理未知。

### Task 5：文件及编码工具迁移

- [ ] inspect/read 两阶段迁入正式 SRT runner，保留路径、目录授权、inode/设备身份、大小、分类与模型披露检查。
- [ ] 在同一作业内复用 Pi edit/write/bash；补齐 find/grep/ls Operations，避免默认本机 I/O。
- [ ] 默认操作授权原目录；保留已有修改，写前检查冲突，删除与重要覆盖沿已有策略审批。
- [ ] 枚举并迁移 program、Git/archive/tar、候选导入导出等模型可达启动点；切换后移除无调用方的旧后端。

### Task 6：授权联网与 MCP

- [ ] 为安装依赖、下载、本地 stdio MCP 和远程 MCP 明确授权与披露；复用当前 MCP SDK。
- [ ] stdio 传输交给作业监督器持有；验证子进程树、网络重定向/SSRF/内网目标、撤权后连接终止。
- [ ] 不把模型密钥、宿主环境、SSH agent、Docker socket 或通用凭据暴露给普通任务。

### Task 7：真实 Web Search

- [ ] 复用 `WebCapabilityService`、搜索 provider 及页面读取端口，落实真实 provider 配置、秘密来源与预算。
- [ ] 注册 Pi 薄适配工具，核实结果、页面来源、查询时间与页面发布时间；失败不编造结果。

### Task 8：受治理 GitHub push

- [ ] 将已验证的 Pi bash 入口接入正式动作接纳与 durable HITL；完整解析受支持意图，固定仓库/ref/OID/输入对象与披露范围。
- [ ] 无凭据作业安全导出对象，私有 Git 数据目录中的标准客户端执行传输；普通 Shell/MCP 无权复用凭据通道。
- [ ] 核实可复用凭据来源和短期委托，分别验证源 hook/config、同用户进程可见性、目标替换、拒绝和非快进。
- [ ] 在明确授权的 GitHub 仓库推送已知 commit，验证远端结果、断连未知与重启核查；不顺带创建 commit、强推、合并或发布。

### Task 9：真实模型与浏览器验收

- [ ] 正式 Agent Service/Worker、身份/CSRF、OpenRouter 配置、预算与 Memory 组合就绪。
- [ ] ego Lite 发起读取文件并总结，由真实模型产生工具调用、Worker 读取、正文回到同一 Pi loop，再生成并保存回答。
- [ ] 验证刷新、服务重启后回读不触发新模型调用，以及未授权/不存在文件的明确失败反馈。
- [ ] 记录真实搜索、联网、MCP 和 Git 推送的本批验收；继续按主机/profile 报告未通过能力。

### Task 10：安装资格、文档与交付

- [ ] 核对产物身份、依赖归属、主机资格和启用策略；实际生效范围与公开健康检查一致。
- [ ] 受影响 Runbook 语义复核、目标 preflight、合同检查与重新封存；不复制生产签名或伪造资格。
- [ ] 更新架构图和实施状态，保留无密钥、无私人正文的可复核证据，完成本地提交。

## 原待办迁移关系

| 原待办 | 本计划归属与保留要求 |
|---|---|
| P0-01–P0-05 | 保留原验收、Pi/OpenRouter/embedding 和接口证据；Task 9 再验正式 SRT 全流程，不把协议测试算作文件验收 |
| P0-06 | 已确认 Pi 工具复用路径；Task 2 固定按次绑定，Task 5 迁移 runner |
| P0-07–P0-09 | 保留路径身份、读取/披露双授权和按次 Handle/input 持久化；Task 3–5 更换执行后端并回归，不自动继承旧平台资格 |
| P0-10 | Task 4 沿通用 durable HITL 扩展作业观察，多工具验收 |
| P0-11 | Task 3、5：正式 Worker/SRT 资格替代被否决的 Mac 原生 helper 路线 |
| P0-12–P0-14 | Task 5、9：保护正文、原工具结果、模型续接和最终提交；旧实现状态与新路径验收分开 |
| P1-01–P1-02 | Task 2–6、8：期限、取消、未知结果、重复调用与关键负向回归 |
| P1-03–P1-05 | Task 9：正式入口、ego Lite、刷新/重启及失败反馈 |
| P2-01–P2-02 | Task 1、10：语义一致文档、检查、证据、提交；全部完成后才关闭整批计划 |

本映射没有重新勾选原完整流程待办。历史实现和测试继续保留，新资格必须重新取得。

## 数据迁移与回退约束

旧 Run、审批、Payload、Capability receipt 和已确认结果保持可读，回读不启动旧或新执行器。Task 2 的合同文件是新增模块，不改变 `execution.v2`、`execution-admission.v1` 或旧数据库 schema。Task 4 的追加作业迁移已作为 Task 3 前置部分实施；正式失联作业核查与恢复接线仍待验收。

同一主机切换先停止旧执行准入，核查在途作业并确认清理，再启用新资格。旧审批若不覆盖新权限语义则重新确认或拒绝；未知结果不得换主机/attempt 自动重做。不得回退到已知不满足当前要求的执行后端。

## 验证

本轮 Task 1–2 的验证入口：

```sh
npm run typecheck
npm run check:boundaries
npm run check:v0.2-coverage
npm run check:v0.2-invariants
npm run check:secrets
npm run check:ci-policy
npm run check:pi-compat
node_modules/.bin/vitest run --config vitest.workspace.ts --project integration test/integration/sandbox-execution-contract.test.ts
node_modules/.bin/vitest run --config vitest.workspace.ts --project unit packages/runtime-pi/test/governed-coding-tools.unit.test.ts
python3 /Users/triggerjames/.codex/skills/document-governance/scripts/validate_docs.py . --strict
```

新增 schema/接口由本轮合同单元测试与 Pi 兼容性测试验证。已有授权/Capability/continuation 集成回归按实际影响运行。Task 3 起增加真实平台负向测试；禁止把本轮 fixture 标成主机安装资格。

## Task 1–2 验证记录

2026-09-07 至 2026-09-08 本地验证：Pi compatibility 6 个文件、62 项测试通过；统一作业合同 10 项、现有工具工厂 2 项、Capability 回执与 runtime continuation 集成回归 30 项，以及备份/迁移 CLI 2 项均通过。类型检查和 Node runtime 构建通过；依赖边界、v0.2 覆盖、产品不变量、秘密扫描与 CI 测试注册检查通过。

文档 strict 校验为 0 错误、0 警告；3 个受 S1 Spec 变更影响的 Runbook 已核对语义、重新封存并通过静态合同检查。没有执行真实安装、备份、迁移或 SRT 作业。原始指南补充 frontmatter 后，正文 SHA-256 与修改前一致。

全仓 `npm run check` 仍在既有 lint 上失败：182 个错误、977 个警告；本次改动代码的定向 Biome 检查无错误或警告。后续处理记录在 [SOURCE: docs/backlog/BL-20260907-001-修-复-全-仓-既-有-lint-问.md]。这些结果是本地源码和测试证据，不是主机资格或上线验收。

## 关闭检查

- [ ] 全部 Task 的验收证据齐全，首批必需能力没有遗漏。
- [ ] 产品行为、架构图、资格和 Runbook 与实际运行一致。
- [ ] 遗留工作记录到对应 Backlog，未完成必需能力不以关闭计划隐藏。
- [ ] 整批交付完成后按治理流程归档本 Plan。
