---
status: active
document_type: spec
supersedes: ""
superseded_by: ""
date: "2026-09-03"
---

# Himawari Agent GitHub CI 与质量门禁设计 Spec

## 目标

为每次代码变更提供完整、可复现、能拒绝不合格结果的质量判断。贡献者可以从 PR 找到失败项和复现命令，维护者可以核对被测试的源码、依赖、平台和最终安装产物。

门禁分为 PR 合并检查、周期质量检测和 S9 发布资格输入。CI 通过只证明本文件规定的检查成立。GitHub 服务端强制合并限制、目标主机资格和生产签署分别验收。

本文件是待实施工程设计，不描述已上线能力。用户在前一轮方案讨论后明确要求同时编制 Spec 与 Plan，本次授权覆盖设计固化和计划编制。详细合同供实施前审阅；本文件不授权账户升级、付费调用、远程修改、部署或生产签署。

## 来源上下文

- 产品范围与生产目标：[SOURCE: docs/prd-v0.2.md]
- 当前依赖方向、运行时与测试边界：[SOURCE: docs/architecture-v0.1.md]
- Pi 复用决策：[SOURCE: docs/adr/0001-pi-runtime-adapter.md]
- Node 运行时：[SOURCE: docs/adr/0016-typescript-node-runtime.md]
- Workspace 边界：[SOURCE: docs/adr/0017-workspace-monorepo.md]
- Mac 命令隔离：[SOURCE: docs/adr/0022-mac-tiered-command-sandbox.md]
- S0 需求归属与跨切片验收：[SOURCE: docs/execution/specs/2026-08-26-v0.2-spec-suite-integration-design.md]
- S3 控制中心与浏览器要求：[SOURCE: docs/execution/specs/2026-08-26-control-center-experience-design.md]
- S9 发布资格与候选身份：[SOURCE: docs/execution/specs/2026-08-26-production-qualification-upgrade-design.md]

本 Spec 使用 `CI-A01` 至 `CI-A14` 作为工程验收编号，不向 S0 的十个产品 Spec 增加 `S10`，不接管 S9 的发布资格状态。对应 Plan 只以本 Spec 为主来源，协同引用 S0 和 S9。

### 设计依据及证据限制

以下为 2026-09-03 的设计输入，实施前重新核查。Owner 已将仓库改为公开，本次通过 GitHub API 重新核验可见性、Actions 和规则；原私有仓库的 Pro/403 前提不再适用。

| 已观察事实 | 设计影响 |
| --- | --- |
| 本地基线为 `6f18b051f70ed596c86ffc4dd5af9f65aa599d42`，工作树起始干净；本地和 GitHub 均无工作流 | 新建 CI，不宣称已有检查被保护 |
| 仓库 API 返回 `sixianli/himawari-agent`、`visibility: public`、`private: false`、Owner 类型 `User`、默认分支 `main` | 按个人公开仓库设计；分支 Rulesets 不再以升级 Pro 为前提 |
| Rulesets API 成功返回 `[]`；`main` 保护 API 返回 `404 Branch not protected`；Actions workflow 数量为 0 | 规则能力已可访问，但工作流和强制门禁尚未启用；空规则与接口权限失败分别处理 |
| fork PR 审批 API 返回 `first_time_contributors`；协作者查询只有 Owner 一名 `admin` | 当前仅首次贡献者需批准运行；目标改为所有外部贡献者需批准运行，设置变更单独授权。Owner 自建 PR 不要求另一名用户批准，独立审批仍是能力缺口 |
| `npm run check` 与文档严格校验在同会话通过 | 复用现有检查，不重写现有政策 |
| `npm test` 未包含 `pi-compat`；其他四个命名 project 是主 project 的子集 | 使用五个主 project，避免遗漏及重复计算 |
| `test:browser` 实际运行 Node 测试；真实浏览器脚本使用构建产物和 fixture 服务 | 单列真实浏览器检查，明确 fixture 证明范围 |
| 安装测试会内部执行 `build:node`；规模脚本默认写回受跟踪 evidence | 移除测试内隐式构建，分离 CI 输出目录 |
| `check:v0.2-coverage` 是需求映射检查；尚无代码覆盖率 provider | 保留需求映射检查，另建可测量的代码覆盖率策略 |
| 文档治理校验器在个人 Skill 目录，并导入同目录其他模块 | 将完整校验运行依赖固定到仓库，保留原始来源和摘要 |

上述静态及本机结果不证明干净 runner 安装、GitHub 工作流执行、目标 Mac/Hermes 状态或生产资格。S6 的历史 blocked evidence 只能作为待验证事项，不能代替当前目标主机探测。

## 范围

### 本 Spec 包含

- 可在本地和 GitHub Actions 执行的同一组检查入口与政策。
- Linux x64、macOS arm64、最低 Node 版本和三个浏览器引擎的确定性验证。
- 精确依赖、原生依赖构建、Pi 发布包、安装产物、证据摘要和输出隔离。
- 格式、lint、类型、架构、需求映射、文档、覆盖率、安全扫描和门禁自身的负向验证。
- PR、默认分支、周期检测、手动验证的触发规则和最小权限。
- GitHub 分支规则的目标配置、只读核查和授权后的生效验收。
- 向 S9 提供 CI 证据的格式和边界。

### 本 Spec 不包含

- 更改产品功能、PRD 范围、现有授权语义或 Pi 协议。
- 在本次文档交付中实现工作流、启动定期任务或修改 GitHub 设置。
- GitHub 账户升级、再次更改仓库可见性或迁移组织、付费安全服务、merge queue、自动合并。
- 生产部署、Secret 分发、Hermes 常驻 PR runner、真实 provider 或外部账户调用。
- 代替 S9 实现发布状态机、七天 soak、平台资格、签名和升级操作。
- 将同仓库可修改的 CI 视为抵御恶意仓库管理员的安全边界。

## 验收标准

| ID | 给定与触发 | 必须观察到的结果 |
| --- | --- | --- |
| CI-A01 | 检查定义、workflow、测试分组或矩阵被修改 | 唯一政策与实际执行图保持一致，遗漏、重复和未知检查均被拒绝 |
| CI-A02 | 没有缓存、个人目录或相邻 Pi checkout 的干净 runner | 按精确工具链和锁文件完成安装、原生绑定探测及 Pi 发布物身份检查 |
| CI-A03 | PR 引入失败测试、空 project、`.only`、未登记 skip 或未归属测试 | 合并检查失败；五个主 project 的文件归属和实际执行均可核验 |
| CI-A04 | 构建产物被安装、传递或修改 | 安装测试消费同一份内容；校验缺失、跨平台复用、混合 revision 或篡改均失败 |
| CI-A05 | 构建后的控制中心出现关键交互、三语、键盘或自动无障碍回归 | 对应真实浏览器 job 失败，保留可定位证据，模拟设备不冒充实体设备 |
| CI-A06 | 类型、依赖方向、产品不变量、需求映射或文档合同被破坏 | 现有检查和严格治理校验失败，检查过程不更新基线或 seal |
| CI-A07 | 新增可执行代码、删测或覆盖率报告缺失 | 按固定分母执行增量和基线策略；未导入生产文件仍被统计 |
| CI-A08 | 出现密钥泄漏、未豁免阻断规则命中或扫描不可用 | 安全检查失败，结果脱敏，不能通过自动更新例外转绿 |
| CI-A09 | 上游失败、取消、跳过、少一个矩阵成员、旧报告或空报告 | `ci/required` 不成功，且报告具体原因 |
| CI-A10 | PR、fork、Dependabot、默认分支 push 或手动运行 | 以正确 revision 和最小权限执行；需批准的 fork 运行在批准前不成功；不向 PR 提供生产凭据或主机入口，输出符合公开可读要求 |
| CI-A11 | 公开仓库具备规则管理权限且 Owner 授权启用强制门禁 | GitHub 只接受最新组合的必需检查；失败 PR 无法合并；只读回读与实测一致，不以账户升级为前置任务 |
| CI-A12 | 周期质量检测运行或向 S9 提交 CI 证据 | 输出独立 artifact，绑定来源和平台，不写产品资格状态，不修改历史 evidence |
| CI-A13 | 对门禁运行受控负向样例 | 每项不合格样例均被拒绝；正向对照通过；失败退出码不能被吞掉 |
| CI-A14 | 工具升级、检查失败、交付或恢复执行 | 有版本、复现命令、证据、耗时和未关闭项；当前事实文档与实际启用状态一致 |

## 设计

### 1. 政策、执行与结果各有一个责任方

仓库内 CI 政策描述检查身份、矩阵、测试分组、阈值和证据要求。Node 工具负责执行命令及校验报告。GitHub workflow 只负责调度、权限、隔离和 artifact 传递。GitHub Ruleset 只消费最终检查，不复制阈值或测试选择逻辑。

不增加产品 package、数据库表、常驻服务或 CI 专用 Agent。执行工具沿用仓库的 `.mjs` 约定，在 JSON 边界做 schema 校验，内部使用已经验证的数据。小型纯函数处理集合、状态与摘要，外部命令和文件系统调用保留在边界。

| 记录 | 必需信息 | 唯一责任 |
| --- | --- | --- |
| `CheckPolicy` | schema、稳定 check ID、事件、矩阵成员、测试分组、超时、输出类型 | 定义期望集合和允许结果 |
| `ToolchainLock` | Node、npm、Python、Action SHA、工具及规则版本、下载摘要、许可来源 | 定义可复现工具身份 |
| `CheckResult` | check ID、矩阵键、repository、event、run ID、attempt、tested SHA、head/base SHA、政策摘要、工具链、命令退出码、计数、耗时、报告摘要 | 每个检查只写自己的结果 |
| `ArtifactRecord` | 来源 run/attempt、source SHA、OS/arch/ABI、锁文件和构建输入摘要、文件清单、归档摘要 | 构建步骤声明内容，消费者重新核验 |
| `ExceptionRecord` | 规则或 advisory ID、精确路径/依赖范围、原因、Owner、审阅引用、失效日 | 仅容纳经审阅的可豁免项 |
| `GateSummary` | 期望与实测集合、逐项判定、缺失项和失败原因 | 汇总器生成一次，不允许 worker 宣告总体成功 |

`CheckResult` 的终态为 `passed`、`failed`、`infrastructure_failed`。未运行或被取消不是成功结果。只有政策显式定义的叶子指标允许 `not_applicable`，例如没有新增可执行行；它仍要求有效完整报告和原因，不允许整个必需 job 跳过。

政策中的矩阵与 workflow 的字面声明通过结构校验保持一致。初期使用清晰的固定 DAG，不运行时生成任意 job，也不以路径过滤省略必需检查。

首次引入 CI 时，目标分支尚无政策和覆盖率基线。只有实际确认两者均不存在时才进入一次性初始化流程，使用提议政策完成正反验证和真实测量，报告标记为初始化证据。Owner 审阅后先合入正常 CI 变更，再以默认分支运行结果启用 required rule。缺一个既有政策文件属于损坏，不能重新进入初始化。

普通功能 PR 使用目标分支已经接受的阈值和例外。确需修正规则或接纳新例外时，提交只包含政策及其验证材料的独立变更。若旧规则仍能通过，按正常 PR 合入；若旧规则本身阻止合法政策修复，必须由 Owner 单独授权临时规则维护，记录准确变更、对照证据和恢复结果，再重新证明强制门禁生效。不得在功能 PR 中利用这一入口降低自己的失败条件。

### 2. 固定工具链并验证干净安装

初始基线 Node 为 `22.22.3`，最低兼容版本为 `22.19.0`，npm 为仓库声明的 `11.8.0`。这些是选定版本，不声明为最新版本。Python 固定一个满足治理校验器要求的 3.10 以上精确版本。工具链变更必须在 PR 中重新验证，不能由 runner 自带版本决定。

主要 runner 使用 `ubuntu-24.04` x64 与 `macos-15` arm64。记录实际 runner image 版本。固定标签仍会收到镜像更新，不等于字节级固定 OS。目标 Mac/Hermes 的真实 OS、签名、权限与隔离由 S9 单独验证。

先执行 `npm ci --ignore-scripts`，再只运行审核过的原生依赖构建入口。`better-sqlite3` 必须在本平台成功加载并执行内存数据库读写。禁止为安装成功而全局放开未知 lifecycle scripts、换 Node 版本或改锁文件。原生依赖探测失败即停止该 job。

所有直接依赖使用精确版本。安装后核对 manifests、lockfile、实际 Pi 版本和真实路径。工作区内部正常 symlink 被允许，外部 Pi 包不得指向仓库外或本地源码。CI 不运行 `check:local-pi`，也不需要 `../pi-mono`。

缓存仅覆盖已验证的下载内容。npm key 包含 OS、arch、Node ABI、npm 版本和锁文件摘要。浏览器缓存包含 Playwright 版本与 OS/arch。每次仍执行锁文件安装；不跨平台缓存或传递 `node_modules`，不把缓存命中当验收。

文档治理运行依赖放在仓库内的固定工具目录，保留上游 Skill 来源、许可依据、完整依赖闭包和内容摘要。采用原始 `validate_docs.py`、其导入模块及必需资源，不另写文档规则。更新由显式同步工具整体完成，CI 只读验证。来源或许可未明确时该任务未完成，不能静默跳过文档检查。

### 3. 测试集合完整且不重复

普通 CI 运行 `unit`、`contracts`、`integration`、`e2e`、`pi-compat`。本地调试别名可以保留，但不重复计入 CI。新增 CI 工具测试放进明确的 tooling project，并纳入最终门禁。

测试清单检查覆盖以下集合关系。

- 所有受跟踪测试文件必须属于一个主测试 project，或明确登记为专用资格测试/辅助 child fixture。
- 每个主 project 至少包含一个测试文件和一个实际执行测试。禁止 `passWithNoTests`、`.only`、未登记的 `.skip`、`.todo` 和空 suite。
- 聚焦/跳过检测按实际测试声明或发现结果判定，不能把负向 fixture 中的字符串和注释误识别为运行中的 `.only`。fixture 豁免必须精确且接受正反测试。
- 将两类 scale 与两类 live provider 测试从普通 integration 集合明确排除，分配到专用 project。登记具体文件和原因，不使用覆盖整个目录的任意 skip。
- integration 保持 `fileParallelism: false`。跨 job 通过独立 checkout 并行，不能用全局测试并行化覆盖 SQLite、UDS 或固定端口约束。
- CI 默认禁用测试重试。基础设施失败可以重跑整个检查并保留 attempt，禁止只选成功重试隐藏不稳定测试。

本地 `npm test` 与 CI 通过同一个主测试执行入口消费政策。该入口显式准备需要的产物，再执行测试。测试文件自身不构建，不更改全局目录或工具版本。

### 4. 一次构建的产物经过安装验证后再交付

每个平台的构建步骤生成 Node runtime、浏览器静态资源和内容清单。复用现有 build/package 脚本，扩充其遗漏的 Node 文件摘要、模式、外部依赖闭包、迁移资源和平台身份。metadata 的生成时间不进入内容可重复性比较，但保留在执行报告中。

构建只写自己的临时输出，成功后发布本次 run 的不可变归档。安装测试在独立临时 prefix 和非源码 cwd 中安装该归档，不执行构建，不从开发 `node_modules` 或 `NODE_PATH` 补依赖。测试前后重新核验产物摘要。

安装验收至少覆盖三个 binary、runtime manifest、排除 testing adapter、SQLite 绑定、启动/doctor、锁冲突、drain/restart，以及现有恢复和权威迁移模拟测试。所有状态和模拟 Secret 留在临时目录，不接触用户真实状态。

同一份经验证的归档用于后续 artifact 交付。归档按 OS、arch、ABI、tested SHA、run ID 和 attempt 命名。消费者按本次构建返回的 artifact ID 下载并核验内容，禁止按 latest、相同分支名或模糊名称获取旧产物。

这证明被测试与被交付的内容一致，不自动证明跨 OS 相同字节或独立构建的字节级可重复。后者需要单独实验，不能从两个绿色 build 推断。

### 5. PR 验证图

下表是目标完整集合。矩阵成员数量也是门禁合同。

| Job | 运行环境 | 输入与依赖 | 通过条件 |
| --- | --- | --- | --- |
| `policy` | Ubuntu 基线 Node | checkout、政策和 workflow | 政策 schema、DAG、tool lock、例外、测试归属及 tooling tests 通过 |
| `static` | Ubuntu 基线 Node | `policy` | `npm run check`、文档严格校验、actionlint 和差异检查通过 |
| `build` | Linux x64、macOS arm64，共 2 项 | `policy`，各自干净安装 | 构建、原生探测、现有前端产物预算及内容清单通过 |
| `test` | Linux x64、macOS arm64，共 2 项 | `policy` 和本平台 `build` | 五个主 project 非空、无失败，安装测试消费本次归档 |
| `node-floor` | Ubuntu、Node `22.19.0` | `policy` | 单独干净安装、构建及五个主 project 通过 |
| `browser` | Ubuntu，Chromium/Firefox/WebKit，共 3 项 | Linux `build` | 本次静态产物的关键交互、三语、键盘和自动无障碍检查通过 |
| `coverage` | Ubuntu 基线 Node | `policy` | 受控的 unit/contracts/tooling 覆盖率、增量与基线策略通过 |
| `security` | Ubuntu 基线 Node | `policy` | 密钥、依赖与静态安全分析全部完成且满足政策 |
| `required` | Ubuntu | 上述全部 job 和矩阵结果 | 唯一显示名 `ci/required`，按第 8 节严格汇总 |

相比仅 Chromium 的初步方案，本设计把三个已支持的浏览器引擎和声明的最低 Node 版本都纳入 PR。它们覆盖明确的兼容性边界，当前没有可靠变更影响分析可以证明某个 PR 无需执行。周期任务仍承担品牌浏览器版本发现、规模检测和持续依赖复扫。

`browser` 每个引擎使用独立 runner，避免现有固定 `4173` 端口冲突。复用 `qualify-control-center-browser.mjs` 的关键交互并补齐缺失断言，直接消费 `build` 的静态产物。页面异常、关键请求失败和自动 accessibility 阻断项均失败。报告保存引擎版本、locale、测试场景、脱敏 screenshot/trace；失败证据保留不能改变退出码。

fixture browser 验证不是生产 Gateway 测试。WebKit 不是 Safari 品牌版本，设备模拟不是 iOS Safari 或 Android Chrome 实机。WCAG 自动检查也不代替人工辅助技术验收。

### 6. 代码覆盖率与核心安全断言

使用与 Vitest `4.1.9` 精确匹配的 coverage provider。覆盖率 job 对 unit/contracts/tooling 的进程内测试计算门禁，显式 include 全部 `apps/*/src`、`packages/*/src` 的生产 TS/TSX 和 `scripts/ci` 的自有执行代码。排除仅限声明文件、明确生成物、测试夹具和原样引入的第三方工具；`packages/testing` 按测试夹具责任显式登记。独立进程 integration、浏览器与 Pi 上游包另行验证，不假装已合并它们的执行覆盖率。

新增或修改的可执行行覆盖率至少 90%。对含有变更的函数统计可定位分支，分支覆盖率至少 85%。分母为 source-map 还原后的可执行位置，不能用文本行数、注释或未定位分支替代。无新增可执行行或无相关分支时记录精确原因和 diff 摘要，完整覆盖率报告仍须存在。

首次启用前实测并提交各生产 workspace 及自有 CI 工具的固定基线，之后 lines、branches、functions、statements 均不得低于基线。现有不足通过明确的初始基线表达，不伪造 90% 的全仓覆盖率。已有未覆盖代码本次被修改时适用增量规则。未来提高基线由验证后的显式变更完成，CI 不自动回写。

PR 的增量范围取目标分支与 head 的 merge-base 到 head。默认分支 push 则取事件的 before/after；手动检查必须提供可验证的比较基线。新分支或无法解析 before 时显式使用已声明基线，缺失就失败，不使用空 diff 代替。纯文档变更可以没有新增可执行行，但仍完整运行既定检查。

基线和例外默认读取目标分支受保护版本；同一 PR 提议的新阈值不能使自身失败变为成功。覆盖率工具版本、include 范围或映射算法改变时，先用相同策略在隔离目录对旧基线和候选做可比测量。无法建立比较时阻断政策迁移，不以旧数字硬判通过。

授权、撤销、预算、Secret/Payload、路径边界、幂等和崩溃恢复还必须有对应的负向行为测试。90%/85% 是代码执行证据阈值，不是安全正确性的替代。

### 7. 安全与例外政策

密钥检测保留现有 `scan-machine-secrets.mjs`，增加固定版本 Gitleaks。PR 扫描完整提交范围和当前受跟踪内容，检测曾提交后删除的泄漏；默认分支和周期检查执行历史扫描。例外仅限经过审阅的合成测试样例，真实凭据泄漏不可豁免。

静态安全分析采用固定版本 Semgrep CE 和仓库固定的、许可明确的规则集。启用阻断语义，规则错误、解析失败、空扫描或报告缺失均视为检测失败。高置信度阻断规则先用正反样例验证。不得在运行中下载浮动规则或通过未知 suppressions 消除问题。

维护者于 2026-09-04 明确要求从 CI 移除 npm 依赖漏洞查询。本 Spec 据此取消完整锁文件 advisory 扫描及其网络诊断、重试和 High/Critical 漏洞门禁；PR、默认分支和手动 quality 安全入口采用同一范围。安全检查保留机器密钥、Gitleaks 和 Semgrep，发现阻断项或扫描不可用仍失败。安装仍校验锁文件与依赖完整性并使用 `--no-audit`；安全通过不代表依赖无已知漏洞。

例外必须包含精确 advisory/规则、依赖版本或路径、理由、Owner、审阅依据和到期日。运行时使用 UTC 判断到期；重复、未知、无效或扩大范围的例外失败。新例外与基线变更单独审阅，不由失败 job 自动生成。真实 Secret、缺失测试、缺失平台和伪造产物没有通用豁免入口。

构建归档包含锁定 npm 包原样发布的文档、测试和源映射。对其中已核实为占位值、未求值插值、认证说明或合成密码学测试材料的命中，使用同一 `ci/security-exceptions.json` 中的 `published-synthetic-fixture` 精确记录；公开来源本身不构成豁免理由。记录必须绑定包名、版本、锁文件路径、官方发布包完整性摘要、归档成员路径、成员文件摘要，以及每条扫描规则、字面量摘要和准确次数，并保留用途、来源核对依据、Owner 和到期日。任意成员内容、依赖身份或命中集合变化均须重新审阅，不允许按包或目录放行。公开输出检查读取目标分支已接受的例外；仅在初始化时目标分支的政策和例外均不存在，才按明确的初始化提案路径验证候选政策，并保留待 Owner 审阅状态。缺少执行上下文时不应用例外；敏感哨兵和真实凭据始终阻断。

公开仓库可使用 GitHub CodeQL/code scanning、Dependency Review 和 SARIF 接收能力，不再标记为私有仓库能力受限。功能可用不等于已配置。首期必需门禁仍采用机器密钥、Gitleaks 和 Semgrep CE 扫描，以保留本地复现与统一例外判定；GitHub 原生能力可作为后续补充，接入前需明确检查身份、启用配置、权限、失败语义与正反验证，并同步本 Spec 和 Plan。Dependency Review 的增量检查不能替代完整依赖复扫，上传 SARIF 成功也不能代替安全判定。

JSON、JUnit、LCOV、日志、截图和 trace 均按公开可读材料准备。公开仓库的 Actions artifacts 可由登录且有仓库读取权限的用户下载，不是私密证据存储。上传只允许明确列出的合成测试输出、构建产物与脱敏报告，禁止打包整个工作区、环境变量转储、真实状态目录、数据库、Secret 或用户正文。脱敏覆盖日志输出和失败路径，不能只在最终归档阶段处理；需要保密的 S9 主机证据保留在另行批准的受限位置。

### 8. 汇总器必须拒绝不完整成功

`required` 使用 `if: always()`，在正常可调度时即使依赖失败也运行。GitHub 取消整次工作流时该 job 也可能无法执行，此时必需状态保持非成功，仍禁止合并。

汇总器先检查 GitHub `needs` 的每个预期 job 严格为 `success`，再读取本次 run/attempt 的结构化报告。矩阵必须恰好包含政策列出的每个唯一成员。额外、重复、缺失或替代平台不能被 aggregate success 掩盖。

每份报告校验 schema、tested SHA、event、head/base、政策和工具链摘要、实际执行计数、命令退出码及 artifact 摘要。纯 job 绿色、空 JSON、历史 evidence 文件或 worker 的文字总结不能满足合同。实际运行证据与 schema 验证都有独立负向样例。

完整门禁只接受同一次 workflow attempt 的证据。仅重跑失败 job 会复用之前成功 job 的旧报告，初始设计明确不接受这种混合结果；恢复时使用完整工作流重跑。单个检查中的有界下载重试仍属于同一 attempt，必须记录次数。

只有全部条件成立才输出 `passed`。报告缺失、结果 `neutral/skipped/cancelled`、上游安装错误、超时、artifact 上传失败和未执行扫描一律不成功。日志和证据上传可以在失败后执行，但不能吞掉原始退出码。

### 9. 触发、并发、权限与信任边界

PR 使用 `pull_request`，在 opened、synchronize、reopened、ready_for_review 及影响目标分支的 edited 事件重新验证。初期 draft PR 也完整运行。默认分支使用 `push` 复验。`workflow_dispatch` 只验证明确 ref/SHA，不自动发布。禁用工作流级路径过滤和以 skip 标记跳过必需检查的交付方式。

公开 fork PR 作为正常贡献入口。目标 Actions 设置为所有外部贡献者需批准运行（`all_external_contributors`）；Owner 先审阅当前提交，特别是 workflow、安装脚本、政策和汇总器变更，再批准相应运行。等待批准属于尚未执行，不能计作成功或自动豁免；批准运行不等于批准合并，之后仍执行完整矩阵。首次贡献者、重复外部贡献者及 Dependabot 的实际审批和只读 token 行为分别验收，不通过改用 `pull_request_target` 或提供写权限来消除等待。

PR 记录 head SHA、base SHA 和实际 tested merge SHA，不擅自将 checkout 改为 PR head 来回避组合测试。`push` 结果绑定真正的默认分支提交。PR 的临时合并 SHA 产物不能冒充后来不同 SHA 的发布产物。

同一 PR 的更新可取消较旧 CI。concurrency key 包含 workflow、event 和 PR/ref，避免不同 workflow 相互取消。默认分支交付记录使用唯一 run key，不取消前一个已开始的构建验证。矩阵 `fail-fast: false` 保留完整诊断，不降低总体失败条件。

默认 `GITHUB_TOKEN` 只有 `contents: read`，checkout 使用 `persist-credentials: false`。确有 artifact 元数据读取需要的 job 单独申请 `actions: read`。不配置 write、`id-token: write` 或生产 Secret。Action 固定完整提交 SHA；工具下载验证摘要，直接调用锁定本地 executable，不让 `npx` 自动安装未知最新版。

不使用 `pull_request_target` 执行 PR 代码，不通过有写权限的 `workflow_run` 接收并执行不可信产物。PR 标题、分支和其他用户输入通过环境变量传给受控参数解析，不直接拼接进 shell。报告始终按数据解析，禁止执行其中命令或解包路径穿越条目。

PR 运行在 GitHub 托管临时 runner，不进入个人 Mac 或 Hermes。下载阶段可以访问审核过的软件源；测试只需要 loopback 和合成状态。缺少真实凭据不应导致普通测试偷偷读取主机 Secret。此合同不将测试 mock 或 Node 网络 stub 宣称为对恶意代码的 OS 网络隔离。

同仓库 writer 及外部 PR 都能提议修改 workflow、政策和汇总器，绑定 GitHub Actions 来源不能证明执行逻辑未被修改。当前采用可信 Owner 审阅这一边界，批准外部运行前和合并前均需核对这些改动；有第二名审阅者后可增加 CODEOWNERS/非作者审批。需要独立可信 CI 控制面时另立设计，不能在本方案中假称已实现。

### 10. GitHub 强制门禁的独立启用

当前仓库已公开，GitHub Free 的公开仓库支持分支 Rulesets，无需先升级 Pro。Owner 授权后，读取当前管理权限、Actions fork 审批设置和规则，展示目标配置差异；先让完整 `ci/required` 在目标仓库真实运行，再启用主分支规则。不能预先要求一个从未产生的状态导致仓库锁死。公开状态、接口可读、规则已配置和规则实测生效是四种不同事实。

目标规则要求通过 PR 修改 `main`、最新组合上的 `ci/required`、预期 GitHub Actions 来源、分支保持最新、讨论已解决，并禁止强推和删除。初始不要求一名非作者审批，也不设长期日常 bypass。任何紧急绕过必须单独授权并留下记录。

实际规则以 GitHub 回读和失败 PR 的不可合并状态为证据。规则尚未配置时记录 `enforcement_not_configured`；规则接口拒绝或管理权限不足时记录 `enforcement_unavailable`。已启用规则下的 fork 待批准、检查未运行或资源限制属于检查未完成，必须继续阻止合并，不能误报规则不存在。不得回退为本地 hook 后宣称服务端强制完成。

当前个人公开仓库方案不包含 merge queue。将来仓库具备并选择该能力时，新增 `merge_group` 事件和临时组合 SHA 验证，并重新执行门禁负向矩阵。

### 11. 周期检测与 S9 交接

周期 workflow 只运行默认分支受审阅源码，建议每天一次并避开整点，UTC 时间写入版本化配置。是否真正启用 schedule 是后续明确授权的外部动作。周期内容包括 scale/thread-scale、品牌浏览器 smoke、已发布依赖风险变化和额外受支持 Node 大版本的兼容性观察。未获资格的新大版本不扩张当前产品支持声明。

周期身份保留真实 `schedule` 事件，`headSha`、`testedSha` 和 `baseSha` 均固定为该次默认分支的 `GITHUB_SHA`。执行时核对默认分支 ref、冻结提交中的启用状态、cron 和实际 checkout；工作树临时修改不能开启周期任务。这里的 base 用于选择该次提交中已接受的政策和例外，不是增量覆盖率或性能比较基线。手动运行继续要求明确 base；普通 CI 和 S9 的 push 交接不因共享 Context 支持周期事件而扩张事件集合。质量政策与 workflow 的启用状态、cron、检查集合、资源限额和只读权限必须一致。

scale 使用固定数据形状、seed 和受控临时目录，输出本次 run 的报告，不写入 `test/integration/qualification/evidence`。比较性能时记录硬件、runner image、样本数和 p50/p95/p99/max；跨硬件变化只报告不可比，不能伪造退化结论。产品绝对目标沿用 S9，不重新定义。

记录工程指标，包括排队与执行时长、各检查耗时、峰值磁盘、缓存冷热和失败重跑率。初始 job 超时分别为 policy/static/security/coverage 15 分钟、build/test/node-floor/browser 30 分钟、scale 60 分钟、汇总 5 分钟。超时是资源上限，不是实测性能承诺。完整报告的常规保留期为 30 天，诊断 screenshot/trace 为 7 天；缺少保留能力要明确报告。

公开仓库使用标准 GitHub 托管 runner 的 Actions 运行免费；仍需遵守并发、执行时间、存储和保留限制，不据此移除超时或扩大资源。更大规格 runner、付费服务或外部 provider 不因仓库公开而获得授权。

周期失败在 GitHub 原生结果中可见，本方案不创建外部通知或自动 issue。发布时 S9 必须检查候选相关的未解决周期失败，不能拿另一 SHA 的绿色 nightly 替代。对会随时间变化的安全扫描，在候选签署前 24 小时内基于同一产物重跑；这一新鲜度不等于软件无漏洞保证。

CI 对外提供证据包，包含真实默认分支 tested SHA、构建输入、平台归档摘要、测试/安全报告及所有未完成项。现有 S9 `ReleaseQualification` 仍是候选与签署的唯一责任方。CI 不另建 release 状态机，不颁发 `qualified_v0.2`，不生成 Owner 签名。S9 尚未实现时只验收可验证的交接格式，真实发布验收继续待实施。

Mac/Hermes 平台 conformance、六类正式浏览器、人工 WCAG、两次七天 soak 和升级恢复由 S9 执行。发布证据须在 Actions retention 到期前转入经批准的持久证据位置并重新核验；默认不上传数据库、Secret、用户正文或未脱敏 Trace。

### 12. Pi 复用映射与设计取舍

| 现有能力 | 本设计的使用方式 | Himawari 自有责任 |
| --- | --- | --- |
| Pi `createAgentSession`、`SessionManager`、`ModelRuntime` | 通过现有 `runtime-pi` 适配器和 `pi-compat` 验证已发布 `0.84.2` | 产品持久状态、恢复投影、路由和预算合同 |
| Pi coding ToolDefinition 与工具协议 | 保留现有复用，验证适配结果 | 授权、Grant、Secret Handle、Payload 和沙箱边界 |
| 现有 boundary/invariant/secret/build checks | 编排已有入口并验证实际结果 | 统一结果格式、集合完整性与失败处理 |
| 现有 document-governance validator | 固定原始运行依赖并执行 strict | 可移植调用与来源校验，不另写文档规则 |
| S9 candidate/qualification 设计 | 输出可供其消费的 CI 证据 | 不接管生产签署和目标主机验收 |

相邻 `pi-mono` 在设计时只读核查了当前 `0.84.2` API，CI 始终以锁定发布物为准。本方案不新增 Pi 协议实现。

| 候选方案 | 判断 |
| --- | --- |
| 单一 job 只运行 `npm test` | 不采用，遗漏 Pi 兼容、构建、浏览器、安全和文档检查 |
| 把九个 Vitest project 全部重复执行 | 不采用，重复子集掩盖真正的测试归属问题 |
| 首期只按路径选择检查 | 不采用，尚无可靠影响分析且容易造成 required 状态遗漏 |
| 每个 PR 在真实 Mac/Hermes 与付费 provider 上验收 | 不采用，越过凭据和主机边界，无法作为普通 PR 的确定性条件 |
| 阈值失败后自动更新 baseline | 不采用，使同一变更有能力取消自己的失败 |
| 托管确定性矩阵、同一产物验证、S9 独立资格 | 采用，分别提供可重复的工程判断与真实发布证据 |

## 错误处理

| 失败类型 | 处理 |
| --- | --- |
| 安装、工具校验、原生加载失败 | 停止该 job，记录实际版本及稳定错误码，不换版本重试到成功 |
| 测试、覆盖率、policy 或安全规则失败 | 保留失败报告，修复原因；不得降低规则、加大范围排除或改成功出口 |
| 下载、runner 或 artifact 服务不可用 | `infrastructure_failed`；有界重试保留 attempt，耗尽后仍阻断 |
| UDS/listen、权限或沙箱前提不满足 | 报运行环境失败，不用 fixture 冒充真实验证，不跳过相关合同 |
| evidence 混合 SHA、错误矩阵或篡改 | 拒绝汇总，重新生成当前组合的完整证据 |
| GitHub 规则不可用或规则漂移 | 标明服务端门禁未生效；保留可执行检测，等待授权条件满足 |
| 历史 flaky 或低覆盖率 | 记录具体来源，修复或走窄范围审阅流程；不得加入全局 continue-on-error |

## 验证策略

Plan 必须按 CI-A01 至 CI-A14 建立双向映射。机械验证与真实 GitHub 行为分别记录，结构校验通过不能代替后者。

负向验证至少包含以下独立场景。

1. 格式/类型错误、越界 Pi import、需求映射断链和无效文档 SOURCE。
2. 主 project 没有测试、新文件未归属、`.only`、未登记 skip 和原始测试失败。
3. 依赖阶段失败使下游被跳过、工作流取消、矩阵缺项/重复、空报告和旧 attempt 报告。
4. 产物单字节修改、缺迁移资源、错误 OS/ABI、源码依赖泄漏及安装测试重新构建。
5. 合成 Secret 的历史提交后删除、到期例外、安全规则未加载；另验证安全入口不调用 advisory API。
6. 新增未导入生产文件、删测降低覆盖率、同 PR 降低 baseline 和空分母伪造成功。
7. fixture 页面交互破坏、JS 异常和自动无障碍阻断项。
8. fork 等待批准时无成功结果，批准后与 Dependabot 分别以受限权限完成普通检查；PR head/base 变化使旧结果失效，公开日志和 artifact 无合成敏感哨兵原文。
9. 真正绿色对照可满足规则，故意红色 PR 在 GitHub 无法合并；测试不实际合并或部署。

仓库内正反样例在临时 fixture repo 中运行，不污染真实分支历史。涉及 GitHub 的样例 PR、push、取消运行和设置变更必须先获授权。CI 自身不可用时保留失败状态，不能以人工勾选代替负向验收。

## 外部依据

以下资料于 2026-09-03 核查。实施时对影响权限或 runner 的条款重新验证。

- [必需状态、跳过与 tested SHA](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)。
- [Rulesets 的账户与仓库范围](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)。
- [GitHub 托管 runner 标签与架构](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。
- [Actions 权限与不可信代码边界](https://docs.github.com/en/actions/reference/security/secure-use)。
- [merge queue 可用范围与事件](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)。
- [公开仓库 code scanning 与 SARIF](https://docs.github.com/en/code-security/concepts/code-scanning/code-scanning)。
- [Dependency Review 可用范围](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependency-review)。
- [公开 fork 工作流审批](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/approve-runs-from-forks)。
- [fork 审批策略 API](https://docs.github.com/en/rest/actions/permissions#set-fork-pr-contributor-approval-permissions-for-a-repository)。
- [Actions artifact 下载权限](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)。
- [公开仓库标准 runner 计费与使用限制](https://docs.github.com/en/actions/concepts/billing-and-usage)。
- [Vitest coverage 配置](https://vitest.dev/config/coverage.html)。
- [Gitleaks](https://github.com/gitleaks/gitleaks)、[Semgrep CE](https://docs.semgrep.dev/deployment/oss-deployment)、[actionlint](https://github.com/rhysd/actionlint)、[npm audit](https://docs.npmjs.com/cli/v11/commands/npm-audit/)。
