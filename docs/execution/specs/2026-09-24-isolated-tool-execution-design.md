---
status: active
document_type: spec
supersedes: ""
superseded_by: ""
date: "2026-09-24"
---

# Agent 任务级隔离工具执行设计

<a id="contents"></a>

## 阅读导航

- [目标与来源](#goal)
- [当前代码与目标差距](#baseline)
- [任务身份与共享边界](#identity)
- [组件职责与后端合同](#backend)
- [授权与安全策略](#policy)
- [状态、停止与释放证明](#lifecycle)
- [持久化、恢复与兼容](#recovery)
- [浏览器与外部资源](#browser)
- [错误与产品投影](#errors)
- [验收标准](#acceptance)
- [验证策略与适用资料](#verification)

<a id="goal"></a>

## 目标与来源

将 [ADR 0031](../../adr/0031-isolated-tool-execution.md) 固定的两层安全边界落为 Himawari 的可实施设计：一个任务环境承载多次工具调用，所有高副作用工具经 Execution Backend，只有可信环境终止证明才能释放任务 workspace lease。

这是目标设计，**尚未实现**。用户已要求在 ADR 自审通过后编写 Spec 和 Plan；本文不代表已经完成代码迁移、部署或容器资格验收。第一阶段交付本地 Docker-compatible backend；macOS OrbStack 是候选 concrete runtime。远端 backend、MicroVM 和完整浏览器产品接入只定义相同合同，不在第一阶段自动实现。

- 架构决定：[SOURCE: docs/adr/0031-isolated-tool-execution.md]
- 当前架构事实：[SOURCE: docs/architecture-v0.1.md]
- Pi 与旧生命周期：[SOURCE: docs/adr/0025-pi-tools-and-managed-execution-lifecycles.md]
- 网络安全：[SOURCE: docs/adr/0026-job-scoped-network-egress.md]
- 释放事实：[SOURCE: docs/adr/0030-durable-workspace-release-facts.md]
- 既有执行设计：[SOURCE: docs/execution/specs/2026-09-07-srt-unified-execution-design.md]
- Workspace authorization / claim / barrier：[SOURCE: docs/execution/specs/2026-09-16-workspace-authorization-lifecycle-design.md]

对 2026-09-07 Spec 的 Host SRT 首选、每调用环境及 Mac 尽力停止目标，由本 Spec 的新路径设计取代；旧运行证据保持原含义。2026-09-16 Spec 的权限、原目录/工作副本、版本比较、队列、自动审查与展示合同保留，仅将其底层执行和环境释放条件改由本文约束。不新增自动审批权限，不改变模型或费用配置，不启用 MCP、Git push 或跨 Run 常驻服务。

<a id="baseline"></a>

## 当前代码与目标差距

核查日期 2026-09-24，Git HEAD `506a91d56ab28ee6daa72f629dd85c1e3bcaee84`；工作区另有在途代码、测试和文档改动，以下结论来自读取时的源码，不是干净提交或生产状态声明。本轮未运行容器/停止探针。旧 Plan 的 Mac setsid 反例属于历史证据，不冒充本轮复现。

| 已核查入口 | 现有机制 | 目标变化 |
| --- | --- | --- |
| [production-sandbox-services.ts](../../../apps/agent-service/src/production-sandbox-services.ts) | 多个准入入口以 `jobId(input.invocationId)`、`environment:${hash(input.invocationId)}` 生成绑定 | 增加任务级环境身份，保留每次 invocation/attempt；不能只把现有 spawn 换成 docker run |
| [production-sandbox-execution-v2.ts](../../../apps/execution-worker/src/production-sandbox-execution-v2.ts)、[sandbox-execution.ts](../../../packages/application/src/ports/sandbox-execution.ts) | Worker prepare / bind / start、结果与资源分离、认证 broker、resource inspect/stop | 同一环境内多次 execute，环境级 start/stop fence；保留逐次授权 |
| [job-host.ts](../../../packages/runtime-sandbox/src/job-host.ts)、[job-host-main.ts](../../../packages/runtime-sandbox/src/job-host-main.ts) | 独立 Node Job Host、SRT manager、私有 IPC、进程组停止；主控制器明确返回未知树清理 | Host supervisor 变为 backend 适配器；任务实际工具代码进入环境；不靠 Host PID tree 证明停止 |
| [linux-namespace.ts](../../../packages/runtime-sandbox/src/linux-namespace.ts) | Linux 捕获 PID namespace/init 身份并核查存续；不能推广到 Mac | 保留旧证据解释；新 backend 按不可混淆的环境身份及 incarnation 核查整体终止 |
| [resource-observer.ts](../../../packages/runtime-sandbox/src/resource-observer.ts) | `ps` 采样观察 CPU/内存与已知后代，不是硬配额 | 由后端强制 CPU/memory/pids/disk 等额度，观察仅用于审计 |
| [sqlite-sandbox-release-operations.ts](../../../packages/persistence-sqlite/src/sqlite-sandbox-release-operations.ts) | 释放凭据接纳、occupancy 释放、迟到 control barrier 与新风险记录 | 新增环境级 lease 和释放事实；旧按 job 的工具完成不能释放父环境 |
| [sandbox-execution-reconciliation.ts](../../../packages/application/src/services/sandbox-execution-reconciliation.ts)、[sandbox-startup-recovery.ts](../../../packages/application/src/services/sandbox-startup-recovery.ts) | 当前 authority、sequence/CAS、有界 inspect/stop、未知占用恢复，不授予重启能力 | 以持久 backend/environment 绑定跨 Worker、Agent、runtime 重启核查 |
| [sandboxed-coding-executor.ts](../../../packages/runtime-pi/src/sandboxed-coding-executor.ts) | 固定 Pi 0.84.2，复用工具工厂及受控 Operations；find/grep/ls 整段实现放在 runner | 复用完整 executor，路径及 tmp 在环境内；不复制 Pi 工具实现 |

已核对 canonical 只读 `pi-mono/packages/coding-agent` 的 0.84.2 源码和已安装 Bash 类型：`BashOperations.exec` 提供命令、cwd、signal、timeout、onData；`grep.ts` 自行启动 rg，因此只代理 Bash 不足以覆盖全部 I/O。继续使用 `createGovernedPiCodingTools()` / `createPiOperationsFromGovernedHostPort()` 与现有受限 runner。Pi 不提供产品的 Grant、workspace lease 或持久环境终止证明，这些责任由 Himawari 的薄后端适配与账本承担，不引入第二套 Agent Loop、工具协议或权限数据库。

<a id="identity"></a>

## 任务身份与共享边界

### 明确区分三种身份

| 概念 | 含义及关系 |
| --- | --- |
| 产品 Thread / Pi Session | 对话历史；不持有永久容器，不作为环境授权 |
| 任务级 execution job | 第一阶段由一个 Run 拥有、首次需要工具时惰性创建，绑定 Owner/Agent/Host、冻结策略和期限；默认一个任务一个环境，多工具共享；不跨 Run 转移 |
| invocation / attempt | 单次工具或受管理后台操作的稳定身份；继续原有幂等和一次 Handle 消费；多个 invocation 关联同一任务环境 |

新增产品拥有的 `executionJobId` 与 `environmentGeneration`；现有 `SandboxJobIdentity.jobId` 保留调用作业的历史语义，不批量改名、不把旧 invocation 合并。`environmentId` 由可信协调器创建，持久绑定 executionJob、backend、runtime 实例、不可变 runtime environment ID、generation、策略摘要和镜像/runner 摘要。名称、PID、容器 label 或模型提供的 ID 均不是授权证明。

默认一个 Run 的执行任务只使用一个同时存活的环境。权限上界变化时，必须停止并证明旧环境释放，再以同一任务的下一 generation 创建环境；不得同时保有相交写能力。新环境只按明确授权导入必要 workspace/产物，不能恢复旧进程、秘密或无限延长原期限。这是权限变更/恢复的显式轮换，不是每个 tool call 创建环境。

### 同一环境共享什么

同一任务保有 cwd、workspace、Git 工作树、任务私有 HOME/tmp/cache、依赖及构建产物。后台程序属于父环境；单个前台工具返回不清理这些状态，不证明任务结束。默认串行处理同一环境的前台变更；同任务并发需满足资源冲突规则，不能用“相同 Run”绕过文件发布的版本检查。

共享以**已经明确授权整个环境存续期的能力上界**为前提。批准一次精确命令不等于批准后续程序任意复用其能力；如果授权仅覆盖某次操作且能力无法在共享环境内可靠隔离/撤回，就停止轮换或拒绝组合，不能把多个一次 Grant 的并集挂进同一个长寿环境。每个工具仍需当前 ActionPolicy、Grant/Handle、输入指纹、期限、预算与取消检查；这些检查不能代替 OS/后端权限限制。

<a id="backend"></a>

## 组件职责与后端合同

| 层 | 所有权 |
| --- | --- |
| Agent Service / application | Pi orchestration、授权/HITL、execution job、lease、持久 intent/fence、结果披露和 recovery |
| Worker | 读取当前 authority，调用 backend，维持认证通信、输出回传与执行观察；不在 Worker 运行任意工具实现 |
| Execution Backend adapter | 受保护 runtime 管理接口，编译/验证策略，创建与定位环境，执行、整体停止、核查并提供可信证据 |
| 环境内 executor | 复用 Pi 工具、Shell/CLI/浏览器及其子进程；不得签发释放证明或读取控制平面秘密 |
| SQLite 与 evidence reader | 事务接纳事实、验证证据主体和摘要、处理 CAS 竞争、维护 lease/barrier；runner 输出不直接写权威状态 |

产品 port 放在 application；版本化序列化合同放在 execution-contracts。具体容器适配隔离于基础设施模块，只有组合根选择实现。沿现有 execution.v2 / Payload 认证通道扩展版本，不能让 application 调用 Docker CLI。第一阶段适配器可使用受保护的 Docker-compatible API 或固定 CLI argv；模型不能提供 daemon endpoint、image、mount、启动器或 runtime 参数。CLI 只是实现细节，不是公开产品合同。

目标 `ExecutionBackendPort` 的语义如下；实现时沿现有端口扩展，不另造并行调度系统：

| 操作 | 输入及约束 | 返回和失败语义 |
| --- | --- | --- |
| `capabilities` / `health` | 受信配置的 backend/host 及 qualification 绑定 | 明确可强制的策略、生命周期与资源保证；健康不等于安全资格；不支持的能力拒绝 |
| `create` | 已持久化 execution job、generation、create intent 幂等键、冻结策略、资源预算、镜像/runner digest、已核查 workspace | 创建尚不可接收用户工具的环境；返回不可变定位与有效策略；响应丢失按同一 intent 核查，不盲建第二个环境 |
| `execute` | 已绑定环境、当前 fence、调用身份、受保护参数引用和期限 | 同一环境执行；稳定输出 cursor、操作结果与独立环境观察；重投递只读已登记结果/状态，不重新执行未知动作 |
| `inspect` | 完整 backend/runtime/environment/generation 身份和期望序号 | `running` / `stopped` / `unknown` 等可信观察及证据；连接失败、daemon 被替换、仅名称匹配或不明确的 not-found 均不是 stopped |
| `stop` | 原环境身份、持久 stop intent、当前控制 authority、有限清理期限 | 幂等风险缩减，阻止新的 execute，整体停止环境及关联资源；返回请求接纳与终止观察，接纳不是证明 |
| `verifyStopped` | stop fence、原 runtime 实例、不可变定位与所需证明维度 | 可信、带摘要且有接纳时效的停止证明，或 unknown；不能由任务 stdout/exit code 推导 |
| `destroy` | 已停止且证据已持久保存的任务自有资源清单 | 回收环境层、私有 profile/tmp/cache；保留用户 workspace 和验证证据；失败保留 GC 义务，不抹掉已接纳停止事实 |

Adapter 必须有同一语义的合约测试；未来 remote backend 只改变定位、传输和证明机制。运行远端工作区时需显式导入/发布及版本检查，不能把本机路径直接解释成远端路径。

[↑ 返回阅读导航](#contents)

<a id="policy"></a>

## 授权与安全策略

### 策略快照与资格

创建前冻结 `filesystem / network / credentials / privileges / resources`、实际生效机制和摘要。启动前核对后端能力与安装/镜像/runner 资格；运行期复核当前权限和期限，撤权立即冻结新调用并请求整个环境停止。后端不能兑现任何必需约束时，准入拒绝。不得通过嵌套 sandbox 失败后自动去掉安全策略。

第一阶段 Linux container 不强制内嵌 SRT。沿用可复用的目标校验、输出保护和授权规则，以 container runtime、namespace、seccomp、capability 限制及受控出口满足策略；是否额外启用 SRT 由该组合的资格决定。现有 macOS SRT native 只保留 legacy 核查和其他适用策略场景，不能接纳需要新严格 lifecycle 保证的工具任务。

### 文件与 workspace lease

- 仅挂载明确批准的真实目录/必要输入；只读和可写分别声明，根文件系统默认只读，临时写入只在限额的任务目录。HOME 为任务私有目录，不是用户 Home。
- 原目录执行仍可通过限定 bind mount 支持，不强迫所有任务先建工作副本。挂载会真实写回 Host；容器停止不回滚这些修改。工作副本仍是既有可选模式，导出沿原版本比较与发布协议。
- 检查 canonical path、目录身份、符号链接、嵌套挂载、Git worktree 的外置 gitdir/common dir；不得为使 Git 可用而自动挂载父目录或其他仓库。需要的 Git 元数据必须属于授权集合；不足时拒绝或在授权副本内执行。
- `.env`、私钥、credential 配置、Host 安装目录、数据库、control socket 和运行产物不能因处在授权根下而自动可读写；若后端无法隔离这类嵌套保护范围，该挂载模式不可启用。
- 维护环境级 lease，范围至少覆盖环境可实际写入/保持文件句柄的全部资源。任意 Shell 若可写整个授权 workspace，就必须占用对应目录范围直到环境停止。只拥有受限文件能力的任务可沿既有细粒度 claim 协调，不把授权目录一概变为目录独占。
- 子调用 claim 可在后置条件满足时结束，但不覆盖父环境 lease。同环境内部操作复用父所有权，仍进行细粒度序列化；其他任务必须检查父环境和风险 barrier。read/read 及不相交资源的并发按既有规则保留。

### 网络、秘密和特权

默认无网络；批准联网时仅通过不可绕过的任务出口。沿 ADR 0026 保留确切 hostname:port、完整 DNS 地址集校验、检查后数字 IP 拨号、重定向重新授权和迟到 DNS 防重开。直连 IPv4/IPv6、UDP/QUIC、DNS、Host gateway、私网/metadata、其他任务网络及 Unix socket 均须在策略内明确处理并测试。代理变量不是防火墙；无法阻断旁路就不能签发资格。

任务只能获得期限及目标受限的 broker handle/临时 credential；长期 provider key、SSH key、Docker socket、Host agent socket 不挂载。外部提交型副作用在专用窄适配内执行，校验目标、调用身份和披露，不接受任意 CLI 作为代理载荷。Git 写操作及 hook、包管理安装脚本仍在环境内执行。

任务默认 non-root、drop capabilities、no-new-privileges、受限 syscalls、私有 PID/mount/network/IPC；不使用 privileged、host PID/network、任意设备或嵌套 runtime 管理 socket。容器管理适配器属于可信计算基础，其接口必须最小化；任务不能通过它启动兄弟容器或 Host 进程。

### 资源

每环境冻结 CPU 上限、内存硬上限、进程数上限、wall timeout、输出/文件大小及磁盘/workspace 额度；禁止无限默认值。额度取自现有策略与主机预算，数值经资格测量确定。runtime 全局容量也做 admission，避免大量合规小任务耗尽 Host。

磁盘不能只限制可写容器层而忽略 bind-mounted workspace。必须验证所用文件系统/runtime 的配额或使用有界存储与受控发布；原目录模式无法强制所需额度时返回不支持，不能用“容器有 quota”掩盖宿主盘无界写入。清理有独立有限预算，超时保持 blocked，不延长用户执行。

<a id="lifecycle"></a>

## 状态、停止与释放证明

### 环境状态与操作状态独立

目标环境状态：`reserved → creating → ready → running → stop_requested → stopping → stopped_verified → released`。创建或观察不确定进入 `unknown / blocked`；这些是新环境记录的语义，不直接重命名旧 Run 状态。对用户的 `STOPPED` 只在环境释放条件满足后投影；业务 succeeded/failed/cancelled 与环境状态保持独立。

环境可在多个工具调用之间保持 `running`；单个命令结束不转入环境停止。正常任务完成、Run 取消、期限/资源超限、撤权、监督失联或服务退出需求均请求整体停止。全局 coordinator 完成 Run 前要原子核对没有新派发、未释放环境及必要 barrier。

### 停止顺序

1. SQLite 持久 stop intent 并提升执行 fence，禁止后续 create/start/execute；与准入/派发使用同一权威事务规则。backend 对延迟请求再次检查该 fence，不能只依赖调用端已取消。
2. 关闭任务网络出口、撤销 broker credential 与相关远端 session；请求环境级停止并在有限宽限后强制终止。使用 backend 的环境生命周期机制，不以 PID tree 猜测完整后代。
3. 核查不可变环境身份、runtime incarnation、所有关联执行资源、停止状态与不可复活条件。关闭自动 restart，禁用任务委托外部 scheduler；可信侧不再接受旧 exec/start 消息。
4. 保存环境终止及必要能力关闭证据；持久化失败保留 lease，重复核查不能重放工具。
5. 在短事务中接纳 release proof、完成环境占用释放、更新任务终态；交付 ACK 独立处理。有关文件完整性或未决发布的 barrier 仍阻止相应冲突。
6. 环境删除、临时文件回收等无执行能力残留可以在后续 GC 完成。安全相关清理未完成不得释放；纯存储回收失败不把已经可靠停止的环境重新描述为活着。

### Release proof 的最低内容

| 维度 | 必须证明的内容 |
| --- | --- |
| 主体 | executionJob、Owner/Agent/Host、backend/runtime identity、不可变 environment ID、generation、原 create intent、policy/image/runner digest |
| 顺序 | stop intent/fence、环境观察 sequence、checkedAt/validUntil、可信验证者与受保护 evidence digest |
| 终止 | 环境已终止，子孙/daemon/setsid/double fork 无法留在环境外执行；关联 browser/service 全部停止；不是仅主 PID/exec session 退出 |
| 不能复活 | 无自动 restart、旧 Worker/延迟调用无法启动或执行、控制端旧 authority 无效；runtime 重启后的身份与状态可核实 |
| 能力关闭 | 任务出口与 active connections 关闭、broker 句柄撤销、私有控制端点不再允许执行；必要发布/写回已经完成或受到单独 barrier 保护 |

第一阶段禁用自动删除环境，先保存证据再删除。inspect 的 not-found 只有能绑定原 runtime、原创建记录、受信删除/终止记录且排除自动复活时才可转换为证明；daemon 不可达、重装、连接错主机均为 unknown。后端能力说明和负向资格探针共同支持其生命周期保证，不能只读一个 `State.Running=false` 字段就签发完整证明。

没有真正创建/启动用户环境时，可沿既有 reservation release 思路证明 never-created / never-started：必须封锁延迟 create/start 并核查原 intent；创建响应丢失不可当作从未创建。环境停止后即使外部 API 结果未知，也不能伪称未发生；另行恢复该操作结果，必要时保留资源级 barrier。

[↑ 返回阅读导航](#contents)

<a id="recovery"></a>

## 持久化、恢复与兼容

沿 SQLite 现有 journal 追加环境记录、调用关联、环境 lease、create/stop intent 与 release receipt；版本化合同不得给 v1/v2 旧数据补 `verified` 默认值。采用追加 migration，编号在实施时取当时下一可用号；禁止修改已发布 migration。

- 环境绑定事务保证一个 execution job/generation 只有一个获准环境；create 前持久 intent，create 后绑定实际 locator，再允许用户 execute。
- 每调用仍保存旧语义的调用回执、输入指纹、输出与结果；新 reader 将环境状态关联到旧操作视图。环境可有多个子调用，release 判定必须查父 lease。
- 重启先恢复所有未释放环境、未决 create/stop 和 barrier，再开放相交准入。reconciler 只有 inspect/stop 权限，无 execute/start 权限。
- Worker/Agent 崩溃后由可信后端监管执行期限及停止，不依赖已崩溃进程的定时器；监督通道失联触发后端停止。runtime 恢复后原环境不得自动复活；恢复流程核查原 ID，不能先建替代容器。
- 当前 authority 接纳新证明并使用 CAS，旧 Worker 迟到结果不能覆盖新 generation。证明首次接纳要验证时效，历史读取验证当时接纳事实；TTL、ACK 不反向改变释放状态。
- 释放后出现可信的矛盾写入证据时，新建 incident/barrier 保护真实受影响资源，保留原释放历史；调查后端资格并禁止新准入，不用重新锁旧记录伪装从未释放。
- legacy 环境保留原 SRT/namespace 观察和恢复路径，unknown 不能批量升级成 stopped。混合版本 writer 必须显式拒绝不理解的新环境/lease 合同；升级失败回退到停止新工具准入及保留恢复能力，不恢复 Host 执行。

<a id="browser"></a>

## 浏览器与外部资源

本地 browser 及 driver 在任务环境内运行，使用任务私有 profile、下载目录、cookie 与受控出口；CDP/control endpoint 不开放给其他任务或宿主公共网络。浏览器子进程和下载与任务一并终止。不得连接用户现有登录 profile 或桌面浏览器来绕过隔离。

未来 remote browser adapter 需要持久 session locator、当前授权、可验证 session terminate、下载/credential 清理和失联恢复。仅 close websocket 不足以释放；远端仍能下载/导航时保留 blocked。其他远端异步执行遵循同一约束；普通外部 API 已接受的业务效果独立记录，不宣称可被本地 stop 撤销。

第一阶段不新增浏览器产品工具；默认阻止未经资格的浏览器路径，同时以真实浏览器 fixture 验证容器后端能够包含这一进程类型。未来接入时补产品端到端验收，不能从 fixture 推导已具备浏览器功能。

<a id="errors"></a>

## 错误与产品投影

新增稳定产品原因码；实现时与现有错误分类统一，不能把所有错误投影成 result_unknown：

| 场景 | 目标原因及恢复 |
| --- | --- |
| 未安装/未启动/健康失败 | `EXECUTION_BACKEND_UNAVAILABLE`；未派发，等待修复后重新准入，不 Host fallback |
| 无资格、策略或额度不支持 | `EXECUTION_POLICY_UNSUPPORTED`；未派发，说明具体不支持项，不自动放宽 |
| 创建失败且证明从未存在 | `EXECUTION_ENVIRONMENT_CREATE_FAILED`；接纳无启动证明后释放预留 |
| create / execute 响应丢失 | `EXECUTION_ENVIRONMENT_UNKNOWN`；保留占用并核查原 intent，不重建/重放 |
| 停止/inspect/能力关闭失败 | `EXECUTION_STOP_UNCONFIRMED`；停止待核验，保持 lease，有限 recovery |
| 身份/generation/fence 不匹配 | `EXECUTION_BINDING_CHANGED`；拒绝旧消息，保留原风险归属 |
| 资源上限触发 | `EXECUTION_RESOURCE_LIMIT`；记录实际限制及操作事实，整体停止后再验证释放 |

用户应能区分“工具已有结果”“正在停止”“停止尚未确认”“工作区仍被占用”和“执行后端不可用”。沿已有 thread execution resources / state 投影与会话内审批，不新增独立审批页或泛用详情侧栏。观察时间、执行时间、批准等待和恢复时间分别记录，不用 UI timer 推断 backend 生命周期。本 Spec 不重新设计视觉页面。

<a id="acceptance"></a>

## 验收标准

| ID | Given / When / Then |
| --- | --- |
| ITE-01 | 同一 Run 的已授权任务；依次写入、安装 fixture 依赖、构建、测试、读取 Git 状态；环境 ID 不变、产物与状态保留，各调用身份/结果独立，Host 未执行其任意代码 |
| ITE-02 | 两个不同任务或不同权限上界；尝试复用环境、credential、profile 或扩大 mount/network；拒绝并审计，不合并 Grant |
| ITE-03 | 任务创建 child/grandchild、daemon、detached、setsid、double fork、background writer 且关闭 stdio；停止任务；后端独立 inspect 与宿主文件/网络 readback 证明全部停止，lease 只在 proof 接纳后释放 |
| ITE-04 | 后端缺失、未启动、健康失败或创建失败；发起工具；明确拒绝，无 Host spawn、无重复 create；创建响应不确定保持 lease |
| ITE-05 | 旧环境可能仍写入且 stop/inspect 超时、断线或身份改变；冲突新任务不能启动，不相交任务仍按既有规则运行 |
| ITE-06 | Agent/Worker 在 create、bind、execute、stop、proof 接纳、lease release 前后崩溃；恢复核查原身份，不重放未知命令，不提前释放；runtime 重启也不复活已停环境 |
| ITE-07 | 授权文件与假秘密/邻仓/Host socket 并存；尝试越界读写、symlink、外置 gitdir；仅允许显式范围，写能力覆盖的父 lease 保持到停止 |
| ITE-08 | deny-all 或 allowlist 网络；直连、代理、IPv6、UDP/DNS、重定向、私网及迟到 DNS；未授权请求均被阻止，停止后已有连接不能继续使用 |
| ITE-09 | CPU/memory/pids/timeout/disk 限制及输出洪泛；触发限制；Host 保持可用，任务整体停止或 blocked；bind mount 额度不能绕过 |
| ITE-10 | 原权限撤销/过期，或旧 execute 延迟到达；不再派发，后台进程与出口停止；原 Grant 失效不阻止可信紧急清理 |
| ITE-11 | proof 已接纳后 ACK 迟到、重复、丢失及凭证过期；release fact 不反锁、不重跑；新矛盾证据单独创建 barrier |
| ITE-12 | legacy unknown 与新环境记录并存；升级/旧 writer/回退；旧 unknown 不被自动释放，新 lease 不被旧调用完成回执清除 |
| ITE-13 | 真实 browser fixture 有导航、下载、cookie 与子进程；停止后 profile 隔离、下载不继续；未启用的 Host/remote browser 路径被拒绝 |
| ITE-14 | 替换实现或使用不支持必需能力的 backend；上层只使用产品合同；未知能力拒绝，不包含 OrbStack/Docker 专用分支 |
| ITE-15 | 原目录有用户 dirty 修改、工作副本发布遇版本变化或 cleanup 失败；保留用户数据/产物及证据，不 reset、不删除授权 workspace，不虚构成功 |

<a id="verification"></a>

## 验证策略与适用资料

以真实产品入口的持久 E2E 为主要覆盖，使用现有 Vitest e2e/integration、真实 SQLite/认证通道/Worker 和实际容器。测试后端仅覆盖不可可靠触发的竞态与能力协商，不代替真实 runtime 的 containment、网络、挂载或资源验证。每个失败窗口由可观测同步点控制，禁止固定 sleep 冒充停止证明；有限观测必须结合后端强制机制，不宣称有限等待可证明所有未来行为。

在 Mac + Docker-compatible runtime 上完成主验收；Linux container 平台另行执行相同合同。每种安装版本、镜像、策略、挂载方式和模式都有独立资格。用户已验证 OrbStack 可用只支持候选选择，不能当作 ITE-01～15 全部通过。具体文件、命令、留存证据和阶段门禁见 [Implementation Plan](../plans/2026-09-24-isolated-tool-execution-plan.md)。

查阅的官方资料（2026-09-24）用于约束适配设计，不代替平台实测：

- [Docker run](https://docs.docker.com/engine/containers/run/)：网络与 bind mount 默认行为不能直接作为产品策略；必须显式配置。
- [Docker resource constraints](https://docs.docker.com/engine/containers/resource_constraints/)：资源限制需要配置；资源观察不是额度强制。
- [Docker Engine security](https://docs.docker.com/engine/security/)：runtime 管理面属于可信边界，任务不能获得其控制权。

[↑ 返回阅读导航](#contents)
