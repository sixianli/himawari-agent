---
status: active
document_type: plan
supersedes: ""
superseded_by: ""
date: "2026-09-24"
---

# Agent 任务级隔离工具执行实施计划

**Source Spec：** [SOURCE: docs/execution/specs/2026-09-24-isolated-tool-execution-design.md]

**架构决定：** [SOURCE: docs/adr/0031-isolated-tool-execution.md]

**目标：** 从按 invocation 绑定的 SRT / Job Host 路径迁移到任务级隔离环境，在不破坏既有授权、结果与持久释放事实的前提下，以环境整体终止证明控制 workspace 交接。

**状态：** 待实施。本轮只完成 ADR、Spec 和 Plan；以下勾选项均不是已交付功能。本 Plan 根据已完成自审的 ADR 和 Spec 编写，不以计划存在推断 runtime、镜像或生产资格。

<a id="contents"></a>

## 阅读导航

- [基线、范围与依赖](#baseline)
- [文件边界](#files)
- [分阶段实施](#phases)：[P0](#p0)、[P1](#p1)、[P2](#p2)、[P3](#p3)、[P4](#p4)、[P5](#p5)
- [验证命令与证据](#verification)
- [切换、回退与停止条件](#rollout)
- [完成清单](#closure)
- [本轮文档自审记录](#document-review)

<a id="baseline"></a>

## 基线、范围与依赖

源码核查基线为 `506a91d56ab28ee6daa72f629dd85c1e3bcaee84` 加读取时在途改动。开始实施前重新盘点 Git、适用指令、当前依赖及已有变更，只复核与本 Plan 有关的变化。不得覆盖现有 workspace lifecycle / UI 工作，也不得把它们算作本 Plan 的完成证据。

先阅读 [Spec 的代码差距表](../specs/2026-09-24-isolated-tool-execution-design.md#baseline)。优先处理的结构性问题是任务环境身份与每调用身份分离；直接替换 `spawn` 不足以达成新架构。

相关既有工作：

- [SRT Plan](2026-09-07-srt-unified-execution-plan.md)：[SOURCE: docs/execution/plans/2026-09-07-srt-unified-execution-plan.md]。保留既有实现及历史证据；新任务环境、严格停止与 backend 路线由本 Plan 接续，不重新执行旧 Host-first 目标。
- [Workspace lifecycle Plan](2026-09-16-workspace-authorization-lifecycle-plan.md)：[SOURCE: docs/execution/plans/2026-09-16-workspace-authorization-lifecycle-plan.md]。继续负责授权、文件发布、队列、恢复展示及其未完成验收。本 Plan 依赖这些合同，新增父环境 lease，不重复建设审批或状态系统。
- ADR 0030 释放事实及现有 reservation stop fence 必须保留。任何在途实现若仍以子调用完成释放全部环境占用，须在 P1/P3 完成集成后才能开启新 backend。

第一阶段实现一个本地 Docker-compatible backend 及现有工具迁移；浏览器只做 containment fixture 与绕过拒绝测试，不新增浏览器产品功能。Remote browser、MicroVM、远端工作区同步及跨 Run 常驻服务留在扩展边界，不要求本轮实现。实施、安装、生产迁移、真实外部服务调用分别按当时授权执行；本次文档请求不授权这些操作。

<a id="files"></a>

## 文件边界

下表为实施定位，不保证每个文件都需要改动；新文件名在同一模块内可按当时约定细化。

| 目的 | 修改 / 新建边界 | 复用测试 |
| --- | --- | --- |
| 产品环境合同 | `packages/execution-contracts/src/` 的版本化环境与执行合同；`packages/application/src/ports/sandbox-execution*.ts`，新增 `execution-backend.ts` 产品 port | `packages/execution-contracts/test/execution-v2.contract.test.ts`，新增环境合同测试 |
| 任务身份与路由 | `apps/agent-service/src/production-sandbox-services.ts`、`production-runtime-tools.ts`；application 生命周期与资源服务 | `test/integration/sandbox-execution-v2.test.ts`、`sandbox-execution-preparation.test.ts` |
| Lease 与持久化 | `packages/persistence-sqlite/src/sqlite-sandbox-*.ts`、`migrations/` 追加下一可用 migration；workspace admission/claims | `sqlite-sandbox-execution-v2.test.ts`、`sandbox-resource-recovery-scheduling.test.ts`、workspace 集成测试 |
| Backend 适配 | Worker 组合与 `packages/runtime-sandbox/src/` 内独立 `execution-backend/` 模块；legacy Job Host 保持可核查 | Worker service tests、`sandbox-v2-worker-lifecycle.test.ts`，新增 container 合同测试 |
| 工具 runner | `packages/runtime-pi/src/sandboxed-coding-executor.ts`、平台受控文件 operations 与 runner 打包入口 | `sandboxed-coding-executor.compat.test.ts`、既有 Pi compatibility |
| 安全与资格 | `runtime-sandbox` policy/egress、平台 host verifier、qualification 合同与安装清单 | 网络拒绝、scope、真实主机 qualification；新增真实容器策略矩阵 |
| Recovery 与投影 | `sandbox-execution-reconciliation.ts`、`sandbox-startup-recovery.ts`、resource recovery、Run reconciler、thread execution resources/state | `sandbox-control-evidence.test.ts`、`sandbox-resource-recovery-scheduling.test.ts`、状态投影测试 |
| 用户路径与证据 | 新增 `test/e2e/isolated-tool-execution.test.ts`；故障注入置于 `test/integration/`；必要 qualification 注册在 `ci/policy.json` | 沿现有 Vitest projects，不另建测试运行系统 |

运行时依赖只能精确固定；Pi imports 仍只存在于 runtime-pi。不修改 sibling pi-mono，不使用本地链接替代提交的发布依赖，不手改 dist。

<a id="phases"></a>

## 分阶段实施

每阶段先列相关不变量、边界及失败模式，优先在真实入口新增可重放 E2E；只有故障不易稳定触发时才补隔离测试。先运行测试确认命中旧缺陷/缺口，再实施最小完整变化。没有旧失败证据时记录原因，不虚构 red run。阶段内仅跑 focused tests，最终运行全项目 E2E 及必需检查。

<a id="p0"></a>

### P0：建立当前基线与 qualification 输入

- [ ] 读取当前 AGENTS、相关 Spec/Plan、Git 状态、已安装 Pi/SRT 和生产路由；核对代码差距表，记录版本与局部 diff 摘要。
- [ ] 盘点所有工具入口：Pi 七工具、后台任务、network-only/Web Search、Git/发布适配、浏览器/第三方 CLI。分类为环境工具或固定可信中介，查明是否存在 Host 任意代码旁路。
- [ ] 核查候选 Docker-compatible runtime 的环境整体停止、restart、inspect identity、策略与资源能力；不把 `docker info` 成功作为 qualification。镜像、挂载方式和工具链纳入资格输入。
- [ ] 确定既有测试中 ITE-01～15 的覆盖和缺口，建立本 Plan 的验收记录，不复用旧绿色日志证明新环境。
- [ ] 以当前可重放 fixture 留存“单次调用环境身份”“Mac 已启动环境 unknown”和 lease 阻塞基线；历史 setsid 证据可作为动机，新的前后对比要有本次日志。

完成条件：当前路径、版本、现有 dirty 工作、可用 runtime 与必须拒绝的策略模式均有记录。若 runtime 不可用，可继续实现不依赖实机的合同，但不得标记后端验证完成；需要新外部安装或权限时按实际授权停止。

<a id="p1"></a>

### P1：任务级环境身份、持久 lease 与协议

覆盖 ITE-01、02、05、06、10、11、12、14。

- [ ] 先写环境父 lease 与调用子 claim 的验收：两个调用共享环境；一个调用结束后后台 writer 仍持有占用；同任务内部不被自己的父 lease 误阻塞；跨任务冲突仍阻塞。
- [ ] 覆盖 create response 丢失、延迟 create/start、stop fence 竞争、generation 替换、旧 writer 不识别新记录、证明接纳后 ACK 到期的失败窗口。
- [ ] 在现有产品数据库追加 execution job、环境/generation、调用关联、create/stop intents、环境 lease 和 immutable release receipt；不得改写旧 job 含义或历史 migration。
- [ ] 定义产品 backend port、能力声明和协议版本；解析失败禁止尝试较弱合同。增加读写兼容门禁，旧程序不得清除新父 lease。
- [ ] 实现幂等 create intent 与绑定 CAS、停止 fence；在新后端尚未合格时保持新任务执行不可启用。

完成条件：真实 SQLite 并发/重启验证通过；旧记录按原版本读回；原批准只消费一次；每个未知窗口保留占用。测试 stub 只支持持久化协议证据，不代表真实隔离。

<a id="p2"></a>

### P2：本地 container backend 与最小权限

覆盖 ITE-03、04、07、08、09、13、14、15。

- [ ] 在真实容器 fixture 先建立负向矩阵：邻仓/假秘密/Host socket、symlink、外置 gitdir、网络旁路、privilege、pids/内存/磁盘上限、挂载写回与用户 dirty 保留。
- [ ] 实现可信 runtime 管理适配、固定镜像/runner 摘要、non-root 与只读根文件系统、显式限额 mount、任务私有 HOME/tmp/cache；任务不获得 daemon/control socket。
- [ ] 建立 task-scoped egress 与 broker 生命周期，复用地址校验规则；证明直连和 DNS/IPv6/UDP 旁路被限制。若替换 SRT，验证相同策略，不能用特权运行化解 nested sandbox 问题。
- [ ] 实现 create/inspect/stop/verifyStopped/destroy；禁自动 restart，先保存证据后删除；后台 watchdog 在 Worker/Agent 死亡时仍强制原期限。
- [ ] 验证 stop 在 setsid/double fork/daemon 场景覆盖整个环境，并区分错误 runtime、not-found、paused、重启、超时与可信 stopped。
- [ ] 用实际 browser fixture 验证进程、profile、下载与出口一并纳管；未注册 browser backend 的产品入口继续拒绝。
- [ ] 记录 bind mount 的磁盘/嵌套敏感文件保护支持矩阵；无法强制则拒绝该模式，不能签发全面合格。

完成条件：可信 backend 合同与实机策略矩阵通过；资格严格绑定版本/镜像/模式。此时仍不切换产品默认路由。

<a id="p3"></a>

### P3：Pi 与 Worker 多调用共享环境、停止释放集成

覆盖 ITE-01、02、03、05、07、10、11、15。

- [ ] 先建立中等复杂度真实用户路径：授权 workspace → 写入 fixture 项目 → 安装本地 fixture 包 → 构建 → 启动后台 watcher → 修改文件并测试 → 读取 Git 状态 → 停止 → 新冲突任务接管。每步核对同一环境 ID、独立调用身份和实际文件结果。
- [ ] 在上述路径停止时注入 detached writer；独立宿主读回及后端观察证明停止，未收到 proof 时新任务不能执行。
- [ ] 将完整 Pi 工具实现及其内置搜索/临时 I/O 移入任务 executor；复用现有工厂、Operations、输出保护和 artifact 导出，不在 Control Plane 执行默认本地 I/O。
- [ ] Agent 首次工具准入创建父环境，Worker 后续调用复用；保持逐次授权、预算、期限及停止检查，权限变化只能显式安全轮换。
- [ ] Run 正常结束/取消/撤权接整体 stop，后端证明经现有 evidence reader 接纳，再在同一事务释放父 lease。逐调用 result 不再替代环境终态。
- [ ] 原目录与工作副本分别验证，保留候选发布/版本冲突合同；可信中介不能成为任意命令旁路。

完成条件：真实产品准入、SQLite、认证通信、Pi runner 与容器共同通过代表场景；不能以手工 `docker exec` 成功替代此阶段。

<a id="p4"></a>

### P4：恢复、故障窗口与安全回退

覆盖 ITE-04、05、06、10、11、12、14。

- [ ] 用可控同步点测试 create 前后、bind 前后、execute 持久化前后、stop/proof/lease release 前后 Agent 与 Worker 崩溃；真实断线/重启可重复且不会破坏其他任务。
- [ ] 验证 runtime 失联和重启，旧环境不自动复活；旧 authority、旧 generation、迟到输出/exec 不获得新执行资格。
- [ ] 接入既有 startup/reconciliation/recovery scheduler；恢复器只能 inspect/stop，不接受任意执行参数，不重新消费批准。
- [ ] legacy SRT unknown 与新 container 环境同时读回：只在相应证据满足时释放；新凭据不能为旧进程补造停止事实。
- [ ] 投影清楚显示未派发、停止中、核查未知和仍占用；保留已知工具结果；接口及 UI 变动遵循现有冻结交互，不新增独立审批入口。
- [ ] 回退演练证明停止新准入且保留核查能力；不降回 Host execution，不用旧 writer 处理新 lease。

完成条件：故障矩阵和恢复后独立状态 readback 通过；未知保留、ACK 不反锁、无自动重放均有断言。

<a id="p5"></a>

### P5：完整验证、启用资格与文档交付

覆盖全部 ITE-01～15。

- [ ] focused 场景通过后，运行完整项目 E2E 与必需 lint/type/build/integration/compatibility 等检查，留存成功和失败证据。
- [ ] Mac + 选定 Docker-compatible runtime 与 Linux 分别完成 qualification；Host 专有工具、不同挂载模式和未覆盖后端明确标为不可用或未验证。
- [ ] 检查是否已有项目 verification skill；本变更显著改变共享执行前提，若存在则按 `maintain-verification-skill` 更新并实际验证；不存在不自动创建。
- [ ] 根据真实实现更新 Architecture、README、安装/停止/恢复 Runbook；Runbook 必须按 document-governance 重核静态合同与操作步骤后 seal，不把本文当运行手册。
- [ ] 在已授权目标上完成受控启用与回退；生产数据库、安装与部署另按具体目标授权执行。不因本地资格通过宣称生产已迁移。
- [ ] 核对所有验收与剩余 gap；只提交任务内完成的变化，保持用户其他 dirty 工作。

完成条件：本地交付与平台资格边界明确；若必需实机或全量检查被阻塞，则 Plan 保持 active，不将未执行项勾选完成。

[↑ 返回阅读导航](#contents)

<a id="verification"></a>

## 验证命令与证据

已核对 `package.json`、`vitest.workspace.ts` 与 `ci/policy.json`：项目有 contracts、integration、e2e、pi-compat 等 runner。新增 E2E 文件需先在 P1/P3 创建；下面引用它的命令是**实施后的目标命令，当前未运行**。

| 时点 | 命令 |
| --- | --- |
| 环境合同与持久化 focused | `npx vitest run --config vitest.workspace.ts --project contracts packages/execution-contracts/test/execution-v2.contract.test.ts`；新增环境测试使用同一 project |
| 既有释放与恢复回归 | `npx vitest run --config vitest.workspace.ts --project integration test/integration/sqlite-sandbox-execution-v2.test.ts test/integration/sandbox-resource-recovery-scheduling.test.ts test/integration/sandbox-control-evidence.test.ts` |
| 新用户路径 focused | `npm run test:e2e -- test/e2e/isolated-tool-execution.test.ts --reporter=default --reporter=json --outputFile=test/qualification/evidence/isolated-tool-execution/<run-id>/focused.json` |
| 最终完整 E2E | `npm run test:e2e -- --reporter=default --reporter=json --outputFile=test/qualification/evidence/isolated-tool-execution/<run-id>/e2e.json` |
| 项目必需静态与构建 | `npm run check`、`npm run build` |
| 合同、集成、Pi 与项目测试 | `npm run test:contracts`、`npm run test:integration`、`npm run check:pi-compat`、`npm test`；复用输入未变的通过结果，避免无依据重复运行 |
| 文档 | `python3 /Users/triggerjames/.codex/skills/document-governance/scripts/validate_docs.py --strict .`、`git diff --check`；其他机器解析实际技能路径 |

`<run-id>` 必须替换为本次真实验证 ID，不得把占位文本作为路径直接运行。实际命令和 runtime fixture 开启方式由 P0/P2 接入既有 runner 后记录，不能编造当前不存在的 `qualify:container` 命令。环境缺失应导致必需 qualification 明确失败/blocked，不用 skip 获得绿色结论。

每次 E2E 均在 `test/qualification/evidence/isolated-tool-execution/<run-id>/` 留存：

1. exact command、Git revision、相关 local diff 摘要、OS/runtime/镜像/runner/策略摘要、fixture 准备与销毁方法；不保存凭据。
2. ITE ID、场景、断言与 test runner report；失败输出、trace、必要截图及 network error 不丢弃。
3. 独立 SQLite lease/release/barrier readback、环境 inspect 与停止证据、文件/下载/网络 canary 结果；单独日志“stopped”或截图不足以证明释放。
4. 测试拥有的 runtime 资源清单及清理 readback；清理仅删除 fixture 自有容器/volume/网络，不碰用户 workspace；验证 evidence 不在清理目录内。

实机强制限制与容器退出证据须真实执行；stub/fake clock 仅用于稳定制造 journal/CAS 竞态，不 mock 掉正在验证的隔离或停止机制。Hermes 运行前按项目指令读取运维约束、核查 `/data` 挂载、容量与 runtime；不因本 Plan 自动获得远端写入或安装权限。

<a id="rollout"></a>

## 切换、回退与停止条件

阶段顺序为 P0 → P1 → P2 → P3 → P4 → P5；只有 P1/P2 的门禁成立才接通真实执行，P3/P4 全部通过后才授予新路径资格。共享 schema / 授权 / 持久化变更不与正在修改同一文件的工作并行写入。

切换时先阻止新的旧路径高副作用准入，排空并核查旧环境，unknown 保留原占用；只把满足新 qualification 的任务派到新 backend。无需全站停机，但相交 workspace 不得在旧风险未清除时迁移。即使新 runtime 健康，也不能把旧 Mac unknown 当作已停止。

失败回退为关闭新执行入口、保存现有记录、保留当前或兼容版本的 recovery；**不允许 Host fallback、清空占用、改写历史证明、回滚到不识别新 lease 的 writer**。若 backend 安全保证失效，停止新准入并针对相关环境建立 incident；不删除资源以隐藏故障。

必须停止启用的情形：必需 policy 无法强制、身份/证明不可信、停止后仍有 writer/连接、全量验收缺失、未知占用被提前释放、runtime/socket 暴露给任务、历史数据被升级成无依据的 confirmed。测试故障要先诊断，不能放宽断言或增加无理由重试来通过。

<a id="closure"></a>

## 完成清单

- [ ] ADR 0031 的全部不变量与 ITE-01～15 有实现及可重放证据。
- [ ] 当前工具入口不存在未声明的 Host 任意代码旁路。
- [ ] 所有必需检查真实运行，未验证平台、模式和原因逐项说明。
- [ ] workspace lease 释放、迟到 ACK、恢复、混合版本 writer 与回退已验证。
- [ ] 用户数据和验证证据在 cleanup 后保留；无任务自有残留执行资源。
- [ ] 当前事实文档与 Runbook 根据实现更新；必要 verification skill 已维护。
- [ ] 未完成但另有范围的后续能力按需要记录 Backlog，不用空占位掩盖未交付要求。
- [ ] 完成后才按 document-governance 归档本 Spec/Plan；ADR 留在 `docs/adr/`。

<a id="document-review"></a>

## 本轮文档自审记录

2026-09-24：先完成 ADR 0031，自审其架构图、十项核心原则、0025/0026 的逐条修正范围和 0030 的保留关系，再编写 Spec；复核 Spec 的身份、lease、授权边界、stop proof 与错误合同后编写本 Plan。自审不等同独立外部评审或实现验收。

| 审核项 | 结论 |
| --- | --- |
| ADR 与实现计划分离 | ADR 固定原则、边界和权衡；API 语义、字段、文件与迁移任务分别位于 Spec/Plan |
| 单任务多工具 | 明确现有 invocation 级身份的差距、父环境 lease、状态共享与权限变更轮换 |
| 全树停止与外部效果 | 环境整体停止及不可复活是必要条件；已发生效果、数据完整性与 ACK 独立处理 |
| 部分修正 | 保留 0025/0026 原文，以双向 amendment 及限定范围消除冲突，不整份废弃 |
| 当前事实 | 代码证据注明 revision 与 dirty 边界；历史 Mac 反例、用户 OrbStack 验证和本轮静态检查不冒充新实机资格 |
| 实施路径 | 合同/持久化先行，容器隔离资格后接产品，再做恢复与完整验收；切换失败不得恢复 Host 执行 |

文档治理修改前全仓基线发现四份既有未跟踪 `docs/runbooks/* 2.md` 的合同指纹不匹配，本任务不修改或重新 seal 它们。最终全仓严格检查仍仅报告这四项既有错误，未新增治理错误。本次九份文档的 frontmatter、SOURCE、Plan 结构、全部 ADR 替代关系及双向 amendment 检查通过，三份新文档的 60 个本地链接及其锚点静态检查通过；未宣称已在阅读器逐个点击或验证 Mermaid 渲染。

`git diff --check` 在普通及扩展只读环境均因 `.git/objects/pack/pack-50f4a0848e9eb170fc7b4df6f553a76b8ce0bb0d.pack` 无法正常读取而失败，报 `is far too short to be a packfile` 和 `unable to read 6df0af5eeefb5b12197c71a5178d67df6c6cad36`；文件元数据长度非零但直接读取返回空，根因未确定。后续核查确认该 pack 及对应 `.rev` 带有 macOS `dataless` 标记；Apple FileManager 返回 iCloud `NotDownloaded`。通过官方文件下载 API 定向下载原文件后，Git diff 恢复可读，无需重建或替换 Git 对象。继续复核本次九份文档并完成本地提交；具体提交标识与最终检查结果见交付记录。这些文档检查不代表本 Plan 已实施，也没有运行产品 E2E 或实机容器资格。

[↑ 返回阅读导航](#contents)
