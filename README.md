# Himawari Agent

Himawari Agent 是一个本地优先、无头、长期个人记忆驱动的私人 Agent。Foundation Plan 的 Task 1 至 Task 20 已在确定性参考配置中完成；当前 portable durable web-agent Plan 已补齐模型路由、GitHub webhook/只读 monitor、持久 receipt 去重、浏览器 disclosure preview、真实进程恢复和规模资格的本地实现与证据。当前已按明确批准的边界完成 OpenRouter `qwen/qwen3-embedding-8b` 的 4096 维 Mem0 embedding live smoke，并完成 primary `deepseek/deepseek-v4-flash-0731` 与 fixed fallback `z-ai/glm-5.3-flash` 的有界 generation provider/model/token/cost 回读；GitHub/Cloudflare 账户、跨主机 transfer 和最终 production composition 仍按证据单独验收。

当前交付是可安装、可运行的架构验证平台，不是 production-ready 服务。Node runtime 已有 Agent Service、Execution Worker 和 admin CLI 的 `main`、受保护 UDS、持久 SQLite、doctor/db status 及信号 drain；支持的 OpenRouter 配置现在会在 Agent Service 生命周期中创建 Model/Pi 与 Mem0 composition，并把 4096 维 embedding identity 写入 ready diagnostic。主机文件/代码工作区已接通 Gateway v2、Worker 和控制中心，支持受治理 read/write/move/Trash/restore/permanent delete、workspace ownership、无 filter 独立 index 暂存、冻结 CommitPreview 与 task-only local commit；主动建议、周期反思、最小 Worker delegation 和永久 review-required 的隔离自我改进候选也已完成本地状态、恢复和 UI 边界。Mac 命令已冻结为双层合同：低风险只读关闭集合进入签名 App Sandbox/XPC helper，高风险与未知命令进入 Apple `container 1.2.0`，路由失败不降级；Hermes 使用 `bubblewrap 0.11.2 + prlimit >=2.38`。三种 production backend 都尚未通过同一 revision 的真实资格，Node host path adapter 也必须在对应外层隔离通过前保持 inactive。没有安装或启用真实 capability，治理 Gateway 中的审批查询与决定已组合进 production Agent Service，其余治理入口尚未完成总组合。公开 HTTP listener、身份、可信 Run policy、持久执行与回答、Pi、Mem0 projection consumer 和已授权 Worker 工具现已接入主入口；真实公共身份路径资格、生产 Vault/GitHub 总组合、结构化 Worker 子任务、真实远程 Worker 沙箱、地图/预订供应商和通知客户端仍未完成。默认 local composition 使用进程内参考适配器，退出后数据不会保留。完整边界和限制见 [Architecture v0.1](docs/architecture-v0.1.md)。

正式网页入口的可用页面以服务器实际安装的接口为准。目前开放对话、审批以及服务与依赖健康检查；其余页面显示“未启用”。下文各领域的本地实现与测试覆盖不等于正式 Gateway 已接通。

当前审查修复将工作区变更归属、Git index 事务、删除内容版本、建议/反思/委派状态转换和候选资源清理落实为明确的持久合同。恢复与并发测试使用本地临时仓库和受控适配器；真实模型恢复、Mac/Hermes 隔离资格仍按上述门禁独立验收。

控制中心的本机重构采用已确认的 Himawari 品牌、Light/Dark 与六种主题色；聊天按每轮持久记录显示输出、工具和审批等待，输入区的模型/思考深度由配置能力决定，并在提交时冻结。实现与本机验收边界见 [控制中心重构设计](docs/archive/specs/2026-09-10-control-center-product-refactor-design.md)。原型与测试服务中的消息不代表真实模型验收。

## 已确认的 Web 设计

2026-09-10 确认的 Logo 与聊天界面已保存为后续重构的设计基准。修改控制中心前，请先查看 [设计说明](docs/execution/specs/2026-09-10-control-center-visual-baseline-design.md)、[交互原型](docs/assets/control-center/2026-09-10-v1/index.html) 和 [Logo 图片资源](assets/brand/himawari/README.md)。原型可下载或在本地用浏览器直接打开，图标已内嵌，支持离线查看；页面中的运行结果均为演示数据。

## Toolchain

- Node.js 要求：`>=22.19.0`
- npm 锁定工具版本：`11.8.0`
- CI 基线：Node.js `22.22.3`；最低兼容矩阵：`22.19.0`；Python：`3.12.10`
- TypeScript：`5.9.3`
- Biome：`2.3.5`
- Vitest：`4.1.9`
- `@earendil-works/pi-coding-agent`、`@earendil-works/pi-ai`：`0.84.2`

安装固定工具、锁文件依赖及审核过的 SQLite 原生绑定：

```bash
node scripts/ci/install-tools.mjs --directory .ci-output/tools
.ci-output/tools/bin/node scripts/ci/install-dependencies.mjs --tools .ci-output/tools --evidence .ci-output/installation
export PATH="$PWD/.ci-output/tools/bin:$PATH"
```

正式依赖始终来自 npm 发布物。仓库不提交指向相邻 `../pi-mono` 的 `file:` 依赖；本地 Pi 源码学习只通过下面的 developer-local link 模式选择。

## CI 与质量门禁

`ci/policy.json` 定义必需检查、矩阵和测试归属；`scripts/ci/run.mjs` 执行检查并记录身份、退出码、计数与文件摘要；`aggregate.mjs` 核对同一 run/attempt 的完整报告。GitHub 配置保存在 `.github/workflows/ci.yml`，完整集合是 policy、static、双平台 build/test、最低 Node、三个浏览器、coverage、security 和 `ci/required`。

在固定工具环境下，本地入口为：

```bash
git fetch origin main
CI_BASE="$(git rev-parse origin/main)"
umask 077
npm run check
npm run test:tooling -- --base "$CI_BASE"
npm test -- --base "$CI_BASE"
npm run ci:local -- --base "$CI_BASE"
```

提交或推送涉及安装、发布辅助脚本、CI 或其测试的修改前，必须在准备提交的干净候选源码上执行上面的 `npm run check` 和完整 `npm run test:tooling`，再执行受影响的产品测试。`npm run check` 不包含 tooling 测试，不能替代它；工作区存在其他未提交内容时，不要把混合工作区的通过结果当作候选提交的验证。合并仍以 PR 最新提交的完整 `ci/required` 为准。

准备合入 `main` 的 PR 必须使用最新 `origin/main` 作为 `--base`，不能用功能分支自己的 `HEAD` 代替目标分支，否则历史扫描、已接受例外及覆盖率比较与 GitHub 不一致。涉及 CI 或安全扫描的修改还必须运行完整 `npm run ci:local`；该入口对每项报告执行与 GitHub 相同的公开产物检查，仅写入本地 `.ci-output`，不会上传文件。构建成功但产物扫描失败时，本地结果仍为失败。测试源码放在各 workspace 的 `test` 目录，不能落入生产覆盖率包含的 `src` 目录；policy 会在耗时的构建和覆盖率任务之前拒绝这种混放。

历史发布辅助脚本中的固定摘要代表当时审核过的输入，不能为了适配当前文件而直接更新。共享探针继续演进时，历史校验使用带来源提交和摘要的原始快照；新发布独立审核并绑定自己的输入。快照缺失或被改动仍须使测试失败。示例见 `test/tooling/fixtures/releases/2026-09-12-three-fixes/README.md`。

工具目录可用 `--tools` 指定；输出写入独立 `.ci-output` 目录。工具安装目录和依赖安装的证据目录须为空，已有结果不会被静默覆盖。依赖安装默认使用独立空缓存；需要测量热缓存时可显式传入 `--cache .ci-output/npm-cache`，仍执行完整锁文件安装和原生探测。执行报告记录硬件、耗时与分配磁盘采样峰值；峰值是观测下界，不代表未采到的瞬间峰值。浏览器引擎使用锁定 Playwright 配套版本，安装到独立位置：

```bash
PLAYWRIGHT_BROWSERS_PATH="$PWD/.ci-output/browsers" .ci-output/tools/bin/node node_modules/playwright/cli.js install chromium firefox webkit
```

`npm test` 准备一份当前平台归档，再依次执行 unit、contracts、integration、e2e、pi-compat。安装测试从归档安装到临时前缀，在源码目录外验证三个 binary；测试自身不构建。已有归档必须同时传入其 `--context`，来源、平台、ABI、依赖、迁移和内容摘要均重新核验。四类 scale/live 测试有独立资格 project，普通 integration 明确排除它们。

覆盖率采集 unit/contracts/tooling/integration，包含未被导入的生产 TS/TSX 和自有 CI 执行脚本。变更行至少 80%，变更函数的可定位分支至少 70%；各 workspace 四类指标使用目标分支接受的基线。首次引入仅免去不存在的历史基线比较，不放宽增量阈值。安全检查使用原有机器密钥扫描和固定 Gitleaks/Semgrep；缺报告、扫描不可用、到期例外或未豁免阻断发现均失败。按维护者要求，CI 不执行 npm 依赖漏洞查询；安全检查通过不代表依赖无已知漏洞。

新增安全例外必须先形成精确清单并获得仓库所有者批准。`.github/security-review-manifest.json` 保存被批准的原始清单，`.github/security-review-comment.json` 仅保存 PR 评论编号；编号或文件内的状态字段都不能证明已获批准。检查从 GitHub 公开 API 读取评论，核对所有者身份、仓库、PR、源码提交、清单原始字节摘要与有效期，并继续执行源码来源、发现数量及依赖文档全文校验。清单内容变化后需要新的明确批准；不能扩大为目录豁免或延长既有例外。GitHub 不可访问、评论撤回或失效时检查失败，应恢复有效证据后重跑。审批只覆盖列出的扫描发现，不替代测试、覆盖率或部署验收。


Ubuntu coverage 作业显式传入 `--baseline-candidate initial-only`，仅在合法初始化且本轮校验通过时，使用同一份 snapshot、测试、JSON 和 LCOV 生成 `initial-coverage-baseline.json` 报告。维护者核对该 run/attempt、artifact 摘要与测量结果后，显式审阅提交候选；CI 不修改仓库基线。初始化结束后该选项继续执行通常的基线比较，不再生成初始候选。

公开仓库也可使用 GitHub 的 [CodeQL/code scanning](https://docs.github.com/en/code-security/concepts/code-scanning/code-scanning)、[Dependency Review](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependency-review) 和 [SARIF 展示](https://docs.github.com/en/code-security/reference/code-scanning/sarif-files/sarif-support)。它们分别提供额外代码分析、PR 依赖差异审阅及扫描结果展示；本期门禁使用上面的固定工具与完整锁文件检查，尚未启用这些附加服务。后续接入须先更新 Spec/Plan 并明确新增权限，当前 workflow 不为展示报告添加写权限。

`.github/workflows/quality.yml` 提供默认分支的手动规模、品牌浏览器、安全复扫和额外 Node 观察；schedule 保持停用，拟定时间记录在 `ci/quality-policy.json`。检测结果与历史 qualification evidence 分离。`export-evidence.mjs` 只接受完整默认分支 CI、同一平台产物和 24 小时内的安全报告；导出格式不代表 S9 资格、Owner 签署或持久证据转存已完成。

正常 PR 在 `718ef1b` 的真实 Actions 运行中 13 个 job 全部通过。Owner 于 2026-09-04 授权分支收尾，`main` 的 Active Ruleset `22256403` 已启用并回读确认：必须通过 PR、GitHub Actions 来源的 `ci/required`、分支保持最新、讨论解决，禁止强推和删除且无 bypass。目标 fork 审批策略及其专项实测仍未完成。本地平台结果不能代替完整托管矩阵或服务端拒绝合并证据。当前验证、初始化基线和未完成项见 [CI 实施 Plan](docs/execution/plans/2026-09-03-github-ci-quality-gates-plan.md)。

## Local reference composition

`apps/execution-worker` 和 `apps/agent-service` 同时公开程序化 process API 与可安装 `main`。参考启动顺序是先独立启动 Worker，再把它的 `execution.v2` client 注入前台 Agent Service；Agent process 不会隐式启动 Worker。启动诊断只包含 component、adapter identity、schema version 和 readiness，不包含 credential 或 Secret reference。

程序化组合用于自动化测试和本地架构验证；可安装入口使用受保护的 `execution.v2` UDS，公开模式通过生产 `main` 组合 HTTP、身份、持久 Run、Pi、Memory 与已授权 Worker 工具。支持的 OpenRouter 配置还会显式构造 Mem0 projection；deterministic profile 仍只报告 descriptor，不触发 Pi、Mem0 或 provider。可运行的生命周期、边界与规模验证是：

```bash
npm run test:unit -- local-execution-worker local-composition-root
npm run test:integration -- agent-gateway external-action-reconciliation
npm run test:e2e -- beef-restaurant
npm run test:journeys
npm run qualify:scale -- --output .ci-output/scale-run
npm run qualify:thread-scale -- --output .ci-output/thread-scale-run
npm run build
```

安装已构建的 Node runtime 到绝对临时前缀：

```bash
tmp_prefix="$(mktemp -d)"
npm run install:node-runtime -- --prefix "$tmp_prefix"
"$tmp_prefix/bin/himawari" db status --config /absolute/path/configuration.json
```

关闭 Agent process 会先拒绝新请求，再等待登记的 in-flight Run settlement；Worker 由调用方单独关闭。`SecretPort`、Gateway Control Plane/Read Model 和 Worker client 都是显式注入边界，因此未来远程或持久适配器不需要修改 domain contracts。

## Local Pi source debugging

正常安装和 CI 始终使用 published `0.84.2`：

```bash
npm ci --ignore-scripts
npm run check:pi-compat
```

若同级目录存在同版本 `../pi-mono`，先只读检查版本与构建入口，再临时链接：

```bash
npm run check:local-pi
npm run link:local-pi
NODE_OPTIONS=--enable-source-maps npm run check:pi-compat
npm run unlink:local-pi
npm run check:local-pi
```

`link:local-pi` 和 `unlink:local-pi` 只管理 `node_modules` 中的 symlink、published backup 与 recovery state；运行前后都会验证 `packages/runtime-pi/package.json` 和 `package-lock.json` 哈希。若脚本发现版本不一致、构建入口缺失、unmanaged symlink 或 backup 冲突，会 fail closed。无论调试是否成功，结束时都应执行 unlink；最终 check 应显示 `mode: "published"`。

VS Code 可以用下列 launch 配置在 Vitest 中断进 sibling TypeScript source map：

```json
{
  "type": "node",
  "request": "launch",
  "name": "Himawari Pi compatibility",
  "cwd": "${workspaceFolder}",
  "program": "${workspaceFolder}/node_modules/vitest/vitest.mjs",
  "args": ["run", "--config", "vitest.workspace.ts", "--project", "pi-compat"],
  "sourceMaps": true,
  "outFiles": ["${workspaceFolder}/../pi-mono/packages/*/dist/**/*.js"],
  "resolveSourceMapLocations": [
    "${workspaceFolder}/../pi-mono/**",
    "!**/node_modules/**"
  ],
  "skipFiles": ["<node_internals>/**"]
}
```

适配器操作对应的上游源码如下：

| Adapter operation | `../pi-mono` source |
| --- | --- |
| `createAgentSession()`、tool allowlist、model/session 注入 | `packages/coding-agent/src/core/sdk.ts` |
| Session lifecycle、subscribe、abort、settled、compaction | `packages/coding-agent/src/core/agent-session.ts` |
| 内存 Session projection 与 entry tree | `packages/coding-agent/src/core/session-manager.ts` |
| provider/tool lifecycle hook 类型与分发 | `packages/coding-agent/src/core/extensions/types.ts`, `packages/coding-agent/src/core/extensions/runner.ts` |
| custom ToolDefinition 到 Agent tool 的包装 | `packages/coding-agent/src/core/tools/tool-definition-wrapper.ts` |
| 内置 coding tool schemas 与可注入 Operations | `packages/coding-agent/src/core/tools/` |
| compaction result 生成 | `packages/coding-agent/src/core/compaction/compaction.ts` |
| Agent message/turn/tool event loop | `packages/agent/src/types.ts`, `packages/agent/src/agent-loop.ts` |
| 自动化测试使用的 faux provider | `packages/ai/src/providers/faux.ts` |

## Workspace boundaries

| Workspace | Responsibility | Allowed internal dependencies |
| --- | --- | --- |
| `packages/domain` | 领域身份、状态和不变量 | 无 |
| `packages/gateway-contracts` | `gateway.v1` 客户端协议 schema、类型与兼容性夹具 | 无 |
| `packages/execution-contracts` | `execution.v1` Worker 协议 schema、类型与兼容性夹具 | 无 |
| `packages/application` | 产品端口和 Gateway、Run/Worker、Trace、授权、Memory、Model、Scheduler、Attention、对账应用服务 | domain、两类 contracts |
| `packages/runtime-pi` | 产品 Agent Runtime 端口的 Pi 适配器 | application、固定版本 Pi |
| `packages/platform-node` | Node.js 基础设施适配器 | application、domain、两类 contracts |
| `packages/testing` | 可复用 conformance suites、确定性内存适配器、故障注入和 E2E fixture | application、domain、两类 contracts |
| `apps/agent-service` | in-process Gateway 与可信前台 local composition | application、contracts、runtime-pi、platform-node、testing reference adapters |
| `apps/execution-worker` | 独立 `execution.v1` Worker process 边界 | application、execution-contracts、platform-node；测试期使用 testing |

`npm run check:boundaries` 会检查根和 workspace 清单以及 TypeScript import，拒绝非精确的直接外部依赖、非法反向依赖、依赖环、未声明的内部依赖、逃出 workspace 根的相对 import、纯产品层的 `node:` import，以及 `packages/runtime-pi` 之外的直接 Pi import。

文件总结的 P007–P009 已接入正式 `read` 的两阶段 Worker 路径：先用独立凭证检查文件身份，再分别授权读取和当前模型披露，保存新输入并签发单次读取凭证。可选 `runPolicy.fileRead` 只选择主机、Worker、目录 Grant 和能力版本；现有授权记录与平台资格仍须独立有效。文件程序由 Worker 的受隔离 program runtime 启动，复用 Pi read；Agent Service 不旁路读取。配置、完成证据与未完成的正式 Mac/ego Lite 验收见 [真实文件总结设计](docs/execution/specs/2026-09-07-real-file-summary-agent-loop-design.md)。

通用 HITL 已接入受保护暂停记录、SQLite checkpoint、审批后新租约恢复和 Pi 原工具批次回放；文件读取使用同一契约。审批等待不依赖存活进程，也不重新发送原模型请求。未知副作用继续核查，不能通过再次批准重做。设计与实际验证边界见 [通用 HITL 决策](docs/adr/0023-durable-hitl-execution.md)。

## Domain foundation

`packages/domain` 当前公开：

- Owner、Agent、Thread、Session、Run、Turn 和 Trigger 的 branded ID 工厂；机器标识必须以 ASCII 字母或数字开头，之后只能使用 ASCII 字母、数字、点、下划线、冒号或连字符，总长 1–128 个字符，且不会被自动规范化。
- 从 Owner 到 Turn 的冻结实体，以及 Session、Trigger 和 Run 创建时的所有权一致性检查。
- `accepted`、`building_context`、`running`、`awaiting_approval`、`reconciling_external_result`、`completed`、`failed`、`cancelled` Run 状态机。
- 每个 Agent 单槽位的逻辑权威租约规则：同一租约可幂等重申，第二个同时存在的租约会失败，只有当前 lease ID 可以释放。
- `DomainError` 和固定的 `DOMAIN_*` 机器错误码。

领域层不生成 ID、不读取时钟，也不持久化租约。参考适配器已在应用端口外侧实现租约到期、续租和 fencing token，并在 Task 5 的产品状态提交路径校验当前 fence；生产级持久化仍未实现。

## Protocol contracts

- `gateway.v1`：统一 Trigger admission，Thread 创建/关闭、Run 取消、审批响应，Thread/Run 快照与查询、Trace 查询、事件订阅和有序流事件。启动 Run 必须经过 Trigger admission。
- `gateway.v2`：携带 deployment/authority fence 的 Approval、Capability、Grant、Task、Memory、Trace、Identity 与 health 信封；当前 Approval/Capability/Grant 使用严格 Agent-scoped list/detail snapshot 和 revision/idempotency mutation。
- `gateway.thread.v3`：Thread message、search、checkpoint、Fork、lifecycle、answer locale 与删除协调的独立严格扩展。
- `execution.v1`：Worker 执行、取消和外部结果对账请求，以及进度、结果、取消确认和对账事件。
- 两类信封都显式携带 schema 版本、消息标识、correlation、causation、数据等级和产品 scope；改变状态的 Gateway 命令及全部 Worker 请求另带幂等键。
- wire payload 只承载稳定机器值和受控引用。大型或敏感内容、执行输入/输出、能力句柄和秘密都用引用表示；协议不公开 Pi runtime 类型或凭证明文。
- `gatewayMessageSchema` 与 `executionMessageSchema` 提供严格 `parse`、`parseJson` 和 `serialize`，并拒绝未知字段、未知版本及自相矛盾的执行结果。

## Application ports

`packages/application` 公开 State、Reliable Event、Product State Repository、Reliable Event Sink、Trace、Payload、Audit、Memory、Model、Agent Runtime、Runtime Projection/Tool、Capability、Secret、External Action Reconciliation、Scheduler、Attention、Gateway Access/Control Plane/Read Model、Authority Lease、Clock 和 ID Generator 端口。端口只依赖产品领域和契约类型，不公开数据库、供应商、传输或 Pi 对象。

v0.2 治理路径固定 11 类 `ActionKind`、确定性风险下限、冻结 Approval snapshot/hash、一次性或有界长期 Grant、短期 fenced `capability-handle.v2` 和统一 `capability.v2` Manifest。SQLite 以 CAS 收敛并发预算、在停用时原子撤销 Handle 与依赖任务，并把 Grant usage 写成可由权威 Trace API 读回的完整因果事件。Tool/Skill/MCP/program/API/adapter 共享授权、secret reference、成本、隔离、health、更新与回退语义；未知外部结果只进入 reconcile，不盲目重试副作用。

Task 5 新增的提交路径具有以下语义：

- `RunStateCommitCoordinator` 使用领域状态机形成下一版 Run 状态，并把状态、命令结果和 outbox 事件交给一次原子提交。
- 新的 Agent 状态写命令必须携带当前 authority lease ID 和 fencing token；过期或已被替换的 fence 返回 `PORT_NOT_AUTHORITATIVE`，不产生部分写入。
- 幂等结果按 Owner、Agent 和 idempotency key 共同定址；相同 command type/fingerprint 返回原提交结果，不同命令复用同一键返回冲突，并发重复接纳也只产生一个状态版本和一个事件。
- `ReliableEventPublisher` 在提交后独立发布 pending 事件。投递前失败会保留 outbox；投递成功但标记失败会重投同一事件 ID，由 Sink 去重后完成标记。
- 新建协调器可以从同一个产品状态参考适配器恢复 Run 和 pending 事件，不读取或依赖 Pi Session 文件。

`packages/testing` 提供：

- `@himawari-agent/testing/conformance`：未来适配器可以复用的 Vitest harness 和行为 suite。
- `createReferenceAdapterSet()`：全部端口的隔离内存参考实现。
- `ManualClock` 和 `DeterministicIdGenerator`：可重复的时间与 ID。
- `DeterministicFailureScheduler`：按 checkpoint 和调用次数安排预写入失败，用于稳定重现崩溃/重试路径。
- `createBeefRestaurantFixture()`：固定 Owner/Agent/Thread/Run、Tokyo/牛肉偏好、模型、搜索、监控 Grant、预订和 37-event Session Trace 基准。
- `ScriptedExternalActionReconciliationPort`：以 reference-only lookup 验证 `result_unknown → work.reconcile → work.reconciled`。

这些适配器只用于测试和本地架构验证。内存 Product State Repository 提供可验证的 transaction/outbox 等价语义，但不提供跨进程生产耐久性、生产加密或进程隔离。

## Portable durable web-agent qualification

`packages/integration-github` 的当前实现只允许 read-oriented GitHub capability：App private key、webhook secret 和短期 installation token 通过 host secret source，webhook 先做 raw-byte HMAC、安装/仓库 scope、事件 allowlist 和 rate/body 限制，再以 SQLite transaction 持久化 receipt、protected payload reference 与 occurrence。只读 mirror 使用 bounded content-addressed cache；离线只记录 coverage gap，预算不足产生 `BUDGET_BLOCKED`，不会 polling、history scan 或静默确定性过滤。

控制中心在启用仓库前显示 primary provider/model/version/ref、仓库范围和披露分类，并单独标出机器秘密排除；确认会随 `gateway.v2` 的 `github.monitor.set_state` 命令提交，服务端再次校验 Owner/Agent scope、CAS revision、模型/仓库/分类后才改变 monitor 状态。撤销会先停止 monitor 和对应 scheduler job、清理 bounded mirror，再把 Owner 选择的 retain/delete 交给 history policy port；真实生产组合、历史记录 durable 清理/保留 readback、GitHub App 安装、权限 readback、外部 webhook、Cloudflare public path 与 paid model 尚未验证。

规模切片可以用确定性临时 SQLite 重跑，精确生成 200,000 条消息、10,000 个 Thread、500,000 个 Run、100 个 active jobs 和 50 个仓库 monitor，并记录 query/search/approval/Memory/Trace/delete 与 snapshot transfer 的 p50/p95/p99：

```bash
npm run qualify:scale -- --output .ci-output/scale-run
```

这项命令会把生成数据和 snapshot 限制在临时目录并在结束时清理；本次报告写入指定的新目录，历史结果见 [S1-T28 scale evidence](test/integration/qualification/evidence/s1-task28-scale.json)。Hermes 新隔离目录也已用同一源码/锁文件 runtime manifest 完成 Linux 构建和安装后服务资格测试，但 native 产物按平台分别构建；这些结果不代表 Mac/Hermes 双向 authority transfer、完整加密迁移、7 天 soak 或 production readiness。

Thread 专项资格使用同样的临时 SQLite 边界，但运行真实 S2 Thread repository/application 路径：10,000 个同时间戳 Thread、200,000 条初始 Message、混合 active/archived/trashed、opaque search、pin、Fork、projection rebuild 和 repository restart。当前 Mac 证据中 active list/search/pin/Fork/projection rebuild 的 p95 分别为 2.811/8.835/3.215/1.262/0.646 ms，正常关闭重开为 357.85 ms；全部分页无重复或遗漏，旧 projection 行清零。重跑命令和证据为：

```bash
npm run qualify:thread-scale -- --output .ci-output/thread-scale-run
```

S2 对 S0 J01–J03/J13 的责任映射由 `npm run test:journeys` 校验。该入口组合既有领域、集成、E2E 与浏览器证据，不复制第二套 Thread/Memory/删除行为；它只表示 S2 本地责任完成，不代表真实外部身份提供方 MFA、实体设备、物理 OS 重启或 S0 全局 journey 已完成。

## Validation

```bash
npm run check
npm test
npm run test:tooling
npm run test:journeys
npm run qualify:scale -- --output .ci-output/scale-run
npm run qualify:thread-scale -- --output .ci-output/thread-scale-run
```

测试按文件名和目录分组：

- unit：`apps/**/*.unit.test.ts`、`packages/**/*.unit.test.ts`
- contracts：`apps/**/*.contract.test.ts`、`packages/**/*.contract.test.ts`
- integration：`test/integration/**/*.test.ts`
- journeys：`test/integration/journeys/**/*.test.ts`，验证 S2 与 S0 canonical journey/evidence 映射
- e2e：`test/e2e/**/*.test.ts`
- Pi compatibility：`packages/runtime-pi/**/*.compat.test.ts`

普通 integration 明确排除四类 scale/live suite，它们各自登记为独立资格 project；最终 fresh 测试数量、构建产物 checksum、SQLite 版本和外部 readback 以本轮命令及对应 qualification evidence 为准。E2E 覆盖完整牛肉餐厅参考旅程；integration 包含恢复矩阵、GitHub durable state、模型重复结果和安装后服务路径。默认自动化测试不访问网络、付费模型、外部账户或生产凭据；Task 20 的 embedding 与 generation smoke 只有在分别显式设置 `HIMAWARI_LIVE_EMBEDDING_SMOKE=1` 或 `HIMAWARI_LIVE_GENERATION_SMOKE=1` 时才会使用公开合成文本和已批准的 Keychain provider-secret，并且共同受 `1.00 USD` 上限约束，结果记录在对应 evidence 中。

## Project documents

- 当前实现：[Architecture v0.1](docs/architecture-v0.1.md)
- 已关闭设计：[Foundation Spec](docs/archive/specs/2026-08-25-agent-foundation-design.md)
- 已完成计划：[Foundation Plan](docs/archive/plans/2026-08-25-agent-foundation-plan.md)


### 内置账号登录

控制中心可通过 `identity.kind: "built-in"` 使用 Himawari 自己的账号，登录流程为用户名/密码加验证器验证码，恢复码可代替第二步验证码。账号用于本机或经 HTTPS 反向代理访问的服务器，不要求 Cloudflare；现有 Cloudflare 配置继续可用。仍为单一 Owner，不开放公众注册。登录后的“会话与设备”提供再次验证、设备撤销和退出登录。

首次账号由服务所在主机的管理命令创建，输入与验证器设置资料通过权限为 0600 的文件传递；不能把密码放在命令参数或日志中。账号恢复需停机、活动权威验证和独占状态目录锁，并撤销旧会话。配置、命令和验证边界见 [内置账号设计](docs/archive/specs/2026-09-10-built-in-account-authentication-design.md) 与 [安装运行说明](docs/runbooks/install-start-stop-runbook.md)。登录能力不替代真实 Worker、模型或公网入口的独立验收。
