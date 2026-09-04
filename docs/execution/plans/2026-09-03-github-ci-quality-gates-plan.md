---
status: active
document_type: plan
supersedes: ""
superseded_by: ""
date: "2026-09-03"
---

# Himawari Agent GitHub CI 与质量门禁实施 Plan

**来源 Spec：** [SOURCE: docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md]

**协同来源：**

- [SOURCE: docs/execution/specs/2026-08-26-v0.2-spec-suite-integration-design.md]
- [SOURCE: docs/execution/specs/2026-08-26-production-qualification-upgrade-design.md]
- [SOURCE: docs/execution/plans/2026-08-26-production-qualification-upgrade-plan.md]
- [SOURCE: docs/architecture-v0.1.md]

**目标：** 实现来源 Spec 的 CI-A01 至 CI-A14，并分别交付本地可运行检查、GitHub 工作流证据和服务端强制门禁的实际生效证据。

**架构：** 仓库政策定义检查集合，Node 工具执行并校验结果，GitHub workflow 调度隔离 job，`ci/required` 汇总。安装测试消费构建步骤生成的归档。S9 继续拥有候选资格和签署，CI 只输出证据。

**编制与执行状态：** 用户于 2026-09-03 明确要求使用 `poteto-mode` 实施本 Plan，并确认允许在本公开仓库复制和分发原始文档治理校验器。Tasks 1–12 的本地实施与 Task 16 的事实同步已获授权；Task 13 的正常草稿 PR、隔离负例与标准 Actions 验证随后获明确授权，合并及 Tasks 14–15 的远端操作仍按下述独立边界执行。`status: active` 表示实施仍在进行，不能据此推导 CI 已通过或强制门禁已生效。

**公开仓库前提：** Owner 已将仓库改为公开；2026-09-03 API 回读确认 `visibility: public`，Rulesets 返回空列表、`main` 返回 `Branch not protected`、workflow 数量为 0。fork 运行审批当前为 `first_time_contributors`，目标为来源 Spec 规定的 `all_external_contributors`。原私有仓库的 Pro 升级前提已解除，规则配置、审批策略变更与真实门禁验收仍待实施；本轮再次只读确认 `main` 未保护（HTTP 404）；规则启用仍待独立授权。

## 使用方法与证据边界

本文件供后续 AI Agent 或维护者逐项执行。先读来源 Spec，再核对当前 Git、工具链和 GitHub 状态。不得把本次设计基线、历史测试数量、曾经通过的命令或 Plan checkbox 当作新 revision 的证据。

每个 checkbox 只有在指定文件、测试输出或远端回读存在后才能勾选。一个步骤已有证据不表示所在验收项全部完成；尤其要区分执行失败的记录和通过证据。记录完整命令、退出码、tested SHA、工具版本、证据位置和未验证项。方案中的新命令在本文件创建时尚不存在，须由对应任务实现后才能使用。

采用 document-governance 的 Plan 模板和来源关系。这里不创建 PStack 常驻协调程序，不自动创建 Goal、分支、PR、定时任务或发布流程。需要子任务时按主机可用并发执行，只有不重叠的文件边界可以并行写入。

## 执行依赖与授权停止点

- Tasks 1–12 是本地实施与验证，当前实施请求已经授权。当前工作树起点干净，基线提交为 `3f865d2860301d86f33978e6534cfbba02c37a89`；仅修改本任务文件，尚未进行远端写入。
- Task 13 涉及 push、样例 PR、正常 CI 变更的合并和真实 Actions，Task 14 涉及启用 schedule，Task 15 涉及 fork 审批设置和分支规则。这些动作分别取得明确授权，不由本地通过结果推导。
- 账户升级、再次更改仓库可见性、迁移组织、购买额度、安装生产主机依赖和真实 provider 调用不在本 Plan 执行范围。
- 按公开仓库实施分支 Rulesets，不要求先升级 Pro。规则尚未配置、权限拒绝与检查尚未运行分别记录；Task 15 必须有规则回读与拒绝合并实测才能完成，不得改成“本地 hook 已满足”。
- 不触碰真实 Mac/Hermes 服务、用户数据库、Keychain 或生产 Secret，不运行 S9 soak 和部署。
- 当前仓库代码与来源 Spec 有冲突时，先判断是设计缺口还是实现缺口。新增设计决定先回写 Spec，不能只在 Plan 增加要求。
- 任何规则、平台或覆盖率无法满足时，保留具体失败；不得通过减少必需集合来勾选任务。

## 文件边界

### 新建

| 路径 | 责任 |
| --- | --- |
| `ci/policy.json`、`ci/policy.schema.json` | 唯一期望检查集合、矩阵、分组与资源上限 |
| `ci/toolchain-lock.json` | 精确工具、规则、下载摘要和许可来源 |
| `ci/coverage-policy.json`、`ci/security-exceptions.json` | 经审阅的覆盖率基线与精确安全例外 |
| `ci/result.schema.json`、`ci/evidence.schema.json` | 检查结果和 CI 证据包格式，不定义 S9 产品状态 |
| `ci/rules/` | 固定的 Semgrep 规则与样例 |
| `tools/document-governance/` | 原始治理 validator 的运行依赖闭包、来源、许可与摘要 |
| `scripts/ci/` | 政策验证、工具安装、执行、报告、汇总和证据导出入口 |
| `scripts/ci/check-policy.mjs` | 政策与 workflow、矩阵和测试文件集合一致性检查 |
| `scripts/ci/run.mjs` | 本地与 CI 共用检查执行入口 |
| `scripts/ci/aggregate.mjs` | 纯结果判定及错误说明 |
| `scripts/ci/verify-artifact.mjs` | 平台、内容、归档路径和摘要校验 |
| `scripts/ci/check-coverage.mjs`、`scripts/ci/check-security.mjs` | 报告解析与来源 Spec 定义的政策判定 |
| `scripts/ci/export-evidence.mjs` | S9 可消费的 CI 证据包 |
| `scripts/ci/sync-governance.mjs` | 显式同步原始治理工具并更新来源清单，CI 不自动调用 |
| `test/tooling/`、`test/fixtures/ci/` | 门禁逻辑与临时样例仓库测试 |
| `.github/workflows/ci.yml`、`.github/workflows/quality.yml` | PR/default-branch 验证及周期/手动检测 |

内部辅助模块仅在多个调用方确有复用时增加，不新增产品 workspace 或通用流水线框架。

### 修改

- `package.json`、`package-lock.json`、`vitest.workspace.ts`。固定所需测试依赖，统一主测试入口，注册 tooling 和专用资格 project。
- `scripts/package-node-runtime.mjs`、`scripts/generate-artifact-manifest.mjs`、`scripts/install-node-runtime.mjs`。使输出显式可定位，补齐内容身份和安全安装验证。
- `test/integration/installable-node-services.test.ts` 及实际消费该构建的测试 fixture。移除内部构建，统一消费本次产物。
- 真实 Git 子进程测试和 Execution Worker/安装服务集成测试。仅调整与串行启动阶段相容的 suite 外层预算，并确保失败或超时后回收本例子进程；内部产品期限和业务断言不变。
- `scripts/qualify-control-center-browser.mjs` 及其 fixture server。接收产物和报告目录，补充实际缺失的三语与失败证据断言。
- 两个 scale 测试与对应 npm 入口。将数据和证据位置作为显式输入，CI 不回写历史 evidence。
- `.gitignore`、必要的 formatter/lint 配置。仅增加明确生成输出的排除，不能为通过检查排除生产代码。
- `README.md`、`docs/architecture-v0.1.md`。只在相关实现实际成立后同步当前事实。

### 保持既有责任

- 不改 Pi 源码，不引入 local link，不将 Pi import 移出 `packages/runtime-pi`。
- 不扩大 S0 的十个产品 Spec 数量，不修改 PRD digest 或验收归属来容纳 CI 文档。
- 不改 S9 的候选状态机、资格要求或 Owner 签署，不将其待完成 checkbox 勾选。
- 本次文档交付不提前创建或 seal CI Runbook。实际操作稳定后如确需 Runbook，按治理 Skill 创建并执行三重门禁。

## 任务依赖与验证单元

| 单元 | 任务 | 前置条件 | 单元结束证据 |
| --- | --- | --- | --- |
| U1 | Tasks 1–3，基线、工具与政策 | 来源 Spec 确认及实施授权 | 干净安装探针、工具来源、政策正反样例 |
| U2 | Tasks 4–6，产物、测试和浏览器 | U1 | 本机产物安装/浏览器证据与可在另一平台运行的入口，完整托管矩阵由 Task 13 验收 |
| U3 | Tasks 7–8，覆盖率与安全 | U1，Task 7 还依赖 Task 5 | 可比覆盖率基线、安全扫描和例外负向证据 |
| U4 | Tasks 9–12，汇总、workflow、周期证据与负向矩阵 | U2、U3；Task 9 可在 Task 3 后先实现纯逻辑 | 本地完整政策验证与负向 fixture，GitHub 场景留至 Tasks 13/15 |
| U5 | Tasks 13–15，GitHub 验证与强制门禁 | U4，各项外部授权及仓库管理权限 | run URLs、fork 审批与拒绝合并证据、规则回读 |
| U6 | Task 16，文档和交接 | 已完成单元的事实 | 验收映射、未关闭事项与准确交付状态 |

Task 7 与 Task 8 可在不同文件范围并行。构建脚本、npm scripts、Vitest 配置和政策文件由一个协调者顺序合并。每个平台输出独立目录。验证完成后按单元做本地提交；分支、push、PR 和合并仍单独授权。

吞吐检查点为先完成政策和干净安装，再拆分产物/测试与安全检查。共享状态仅为版本化配置，禁止多个执行者同时修改。并行单元都返回具体证据，主执行者复核后才推进依赖任务。

## 实施任务

### Task 1：确认合同并记录当前基线

- [x] 读取来源 Spec、项目 AGENTS、现有 package/test/build 脚本及 S0/S9 边界，记录确认和实施授权范围。
- [x] 记录 HEAD、dirty 文件、工具版本和锁文件摘要。保护用户已有修改，只在隔离临时目录运行破坏性样例。
- [x] 实跑现有 `npm run check`、文档严格校验和五个主测试项目，逐项记录实际基线及 opt-in suite，不从历史计数推算。
- [x] 只读复核 GitHub 可见性、默认分支、Actions、fork 审批策略、可写协作者及规则能力。保存脱敏结果和查询时间，区分公开可用、空规则、分支未保护与权限失败，不沿用已失效的私有仓库 403。
- [x] 在基线目录记录当前安装/构建耗时、磁盘峰值、工具依赖和未通过项。基线失败先定位，不先放宽门禁；不完整采样仍明确标记。

### Task 2：固定工具链与治理校验器

- [x] 按 Spec 第 2 节建立 `ci/toolchain-lock.json`，选定 Python、Action、scanner 和规则的精确版本与下载摘要，记录许可来源。
- [x] 用 `sync-governance.mjs` 固定 validator 的实际运行依赖闭包和原始内容摘要。保留来源证据；不得手写替代 validator。
- [x] 实现工具安装入口，使用锁文件和审核过的原生构建清单；未知包脚本、digest 错误或工具缺失立即失败。
- [x] 在无缓存、无个人 Skill 目录、无 sibling Pi 的临时环境运行安装、SQLite 内存读写和 strict docs validation。
- [x] 用损坏工具摘要、缺失治理模块、错误 Pi 版本和非法外部 symlink 验证拒绝路径。保留允许的 workspace 内部链接正向对照。

### Task 3：实现政策、结果 schema 与测试归属

- [x] 建立 Spec 第 1 节的最小 JSON 记录和 schema，拒绝未知字段、重复身份、非法终态和缺失来源。
- [x] 实现 `check-policy.mjs`，核对 workflow job/矩阵与唯一政策、完整测试文件归属及固定工具身份。
- [x] 建立 `test/tooling` project，复用当前 Vitest；登记主测试、专用资格测试和辅助 child fixture，拒绝未知文件与 `.only`/未登记 skip。
- [x] 实现来源 Spec 的首次初始化与后续政策更新边界。旧政策缺失或损坏不能被当作首次引入，功能变更不能自行使用新例外。
- [x] 用空 project、漏掉一个矩阵成员、重复测试归属和新增未登记测试验证政策检查会失败。
- [x] 定义 `run.mjs` 的受控参数与输出目录，拒绝仓库外任意写入、无效 artifact 路径和不支持的 check ID。调用不接受报告中的任意 shell。

### Task 4：构建可核验的单次产物

- [x] 调整现有 build/package 入口，输出到明确的本次运行目录；移除依赖共享 `dist` 的隐式并发假设。
- [x] 在现有 manifest 上补齐 Node 文件清单、模式、依赖闭包、migration、OS/arch/ABI、输入与内容摘要，不另建第二份产品候选状态。
- [x] 将构建内容归档，校验归档路径安全、完整性和平台身份；生成时间只用于运行记录，不参与内容等价比较。
- [x] 准备 Linux x64 与 macOS arm64 的独立构建入口，在本机可用平台完成干净构建与原生探测。尚不可用平台的实际运行明确留给 Task 13。
- [x] 注入单字节修改、缺失迁移文件、错误 ABI、错误来源 SHA 和路径穿越归档，确认 `verify-artifact.mjs` 全部拒绝。

### Task 5：统一五个主 project 并验证安装产物

- [x] 将四类 opt-in suite 分配给专用资格 project，从普通 integration 集合明确排除；保留其具体路径与理由。
- [x] 使 `npm test` 与 CI 共用主测试执行入口。入口显式准备/接收产物，五个 project 均非空，不使用 `passWithNoTests`。
- [x] 移除安装测试的内部 `build:node`。测试从本次归档安装到临时 prefix，在非源码 cwd 下运行三个 binary，禁止开发依赖搜索路径补漏。
- [x] 保持 integration 文件串行。完成现有启动、doctor、SQLite、锁冲突、drain/restart、恢复与迁移模拟场景，核验安装前后归档摘要不变。
- [x] 测试失败、主 project 清空、产物被替换、缺少依赖和测试内部重新构建均产生非零结果。保留 source-independent 安装成功对照。

### Task 6：把真实浏览器纳入必需矩阵

- [x] 让现有 Playwright 脚本和 fixture server 消费构建产物路径，报告目录与端口显式可控，启动失败和清理失败不吞掉错误。
- [x] 保留现有治理交互，补齐实际缺失的 `zh-CN`、`en`、`ja`、键盘、可见焦点、JS 异常和自动无障碍断言。
- [x] 在独立环境执行 Chromium、Firefox、WebKit，保存引擎版本、场景结果及脱敏失败诊断。托管 run `33816516553` 三个独立 job 各 58/58；本机 Firefox 的既有启动失败另行保留。
- [x] 注入破坏按钮、页面异常、缺翻译与无障碍阻断样例，确认对应检查失败，fixture-only 和设备模拟身份保持明确。
- [x] 实跑前端预算检查，确认其现有限制未因测试接入被放宽。记录真实浏览器耗时，不把首次结果当性能承诺。

### Task 7：建立可比较的代码覆盖率门禁

- [x] 精确添加匹配 Vitest 的 coverage provider，固定 Spec 第 6 节的 include/exclude 和 unit/contracts/tooling 采集范围，覆盖自有 CI 执行代码。
- [x] 输出 LCOV/JSON 和 source-map 还原位置；未导入生产文件仍在分母。跨进程、浏览器和上游 Pi 不冒充已合并覆盖。
- [x] 实测初始各生产 workspace 与自有 CI 工具的四类指标并记录基线。按 Spec 实现新增行 90%、变更函数分支 85% 和整体不退化规则；原 Mac 候选已由 Task 13 的冻结 Ubuntu 测量替换，合入与最终源码验证继续由 Task 13 负责。
- [x] 基线从目标分支固定版本读取，给出精确的无新增行/无分支原因；同 PR 降低基线不得将自身失败转绿。
- [x] 实现 PR、push 和手动检查的 diff 基线解析；before/base 缺失不得退化为空 diff，并验证首次基线初始化路径。
- [x] 用新增未导入文件、删测、缺报告、错误 source map、伪造空分母和更换工具版本验证拒绝或不可比结果。保留可比政策迁移的正向样例。

### Task 8：实现安全扫描与窄范围例外

- [x] 复用当前 machine-secret scan，接入固定 Gitleaks 的当前内容与提交范围扫描。fixture 使用合成凭据，输出脱敏。
- [x] 记录公开仓库可用的 CodeQL/code scanning、Dependency Review 和 SARIF 与首期必需工具的区别；不自动启用附加功能或为报告展示扩大 token 权限，后续接入先同步来源 Spec 与 Plan。
- [x] 固定 Semgrep CE 及许可明确的规则，启用阻断命中和工具错误失败；验证规则实际加载和生产文件覆盖。
- [x] 根据完整锁文件扫描生产/开发及传递依赖，保留 advisory 响应摘要、时间和 High/Critical 判定。
- [x] 实现精确 `ExceptionRecord` 校验，读取受审阅基线，拒绝到期、重复、扩大范围或自动生成的例外。
- [x] 验证历史泄漏后删除、真实泄漏不可豁免、到期例外、advisory 不可用、规则解析失败、空扫描和报告缺失均失败。
- [x] 按公开可读要求实现日志脱敏和 artifact 上传白名单；用合成敏感哨兵验证正常及失败输出、截图/trace 和归档，不上传完整工作区、环境转储或真实 S9 主机证据。

### Task 9：实现拒绝不完整成功的汇总器

- [x] 实现 `aggregate.mjs` 的纯判定逻辑。先验证 `needs` 全部成功，再核对所有报告、矩阵和身份。
- [x] 对 tested SHA、head/base、event、run ID/attempt、政策摘要、工具链、退出码、计数和 artifact 摘要做完整校验。
- [x] 以真实正向格式生成 `GateSummary`，每个失败原因可定位到 check ID、矩阵键和原始报告。
- [x] 测试 `failure`、`cancelled`、`skipped`、`neutral`、缺失 job、矩阵 aggregate success 但成员缺失、空报告和旧 attempt 均不能通过。
- [x] 验证完整 workflow 重跑产生可接受的新 attempt，仅重跑失败 job 的混合结果按 Spec 拒绝并提示完整重跑。
- [x] 验证诊断或上传步骤失败不抹去原始失败，未知输入不得默认为 success。总体通过需要完整正向对照。

### Task 10：实现 PR 与默认分支工作流

- [x] 编写 `.github/workflows/ci.yml`，完整实现 Spec 第 5 节的 job/矩阵和依赖；稳定显示名为 `ci/required`。
- [x] 配置 Spec 第 9 节的事件、正确 checkout 身份、并发取消、超时、`fail-fast: false` 和最小权限，不设置 workflow paths 过滤；fork 待批准时不生成成功替代状态。
- [x] 配置本次 artifact ID 的传递与重新校验，防止按 latest/分支名读旧归档。各 job 不共享可写 checkout 或原生依赖缓存。
- [x] 令 `required` 使用 `always()`，上传报告保留失败语义；取消整个 workflow 时保持未成功，而非额外写成功状态。
- [x] 使用 actionlint、政策结构检查和本地组合入口验证 YAML、依赖、矩阵数量、Action SHA 与参数处理。此任务不 push 或触发远端运行。

### Task 11：实现周期检测与 CI 证据交接

- [x] 编写 `.github/workflows/quality.yml` 的手动和待授权周期配置，固定默认分支执行、时间、检查集合与同类任务互斥规则。
- [x] 修改 scale/thread-scale 入口，数据和报告输出到本次临时目录，禁止 CI 写回历史 qualification evidence。
- [x] 实现品牌浏览器版本记录、依赖复扫和额外受支持 Node 版本的观察，声明它们的证明范围与不可比条件。
- [x] 用 `export-evidence.mjs` 输出 S9 可消费的 CI 证据包，绑定默认分支真实 SHA、平台产物和未完成项，不写产品 qualification 状态。
- [x] 校验 retention、新鲜度、公开输出和持久交接前提；需要保密的 S9 证据不上传公开 Actions。过期、混合 SHA、错平台和未完成必需检查均不能形成可交接成功结果。

### Task 12：完成本地负向矩阵与资源基线

- [x] 对下节 N01–N12 完成可本地执行的 fixture 与正反对照，在临时仓库中生成变更，不污染真实历史。真实取消、fork 权限和拒绝合并证据留至 Tasks 13/15，不以 fixture 勾选远端验收。
- [x] 在同一资源等级上记录各检查冷/热安装耗时、磁盘峰值和命令退出码，验证符合 Spec 的超时限制。同机冷/热安装观测已保存；run `33823121330` 的 12 份检查及 13 份安装采样全部完整，整个 job 的实际耗时均符合限额。磁盘值是采样下界，不同标准 runner 的硬件不能用于无回归结论。
- [x] 对工具升级的性能比较使用相同政策/硬件并交错运行基线和候选。不可比时明确标记，不能报告无回归。本期为首次引入 CI，仅记录同机冷/热缓存观测，没有可比的前版 CI，不作无回归结论。
- [x] 在干净 checkout 上执行 `npm run check`、tooling tests、完整本地 CI 入口和 strict docs validation，检查受跟踪文件未被测试改写。完整运行保留 Firefox 启动失败，覆盖率解析修复后已独立重新采集通过。
- [x] 复核 diff、任务范围和负向报告，按单元完成本地提交，列出所有尚未获得 GitHub 证据的项目。

### Task 13：在授权后验证真实 GitHub 行为

- [x] 展示拟 push 的分支/提交、样例 PR、预期 Actions 资源和负向操作，取得对应授权。Owner 已明确回复“授权”；范围为正常草稿 PR、隔离负例 PR 和标准 Actions 验证，不含合并、周期启用、审批设置、Rulesets 或远端清理。
- [x] 在真实 Actions 上运行完整绿色对照，确认 Linux/macOS、最低 Node、三个浏览器和所有报告均属于本次 run/attempt。正常 PR #1 的 run `33823121330`、attempt 1、head `58089d3` 全部通过，12/12 报告身份和摘要核验通过，汇总本地重放一致。
- [x] 在首次接受基线前，用 Ubuntu coverage job 对冻结源码的实际 snapshot、tests、JSON 和 LCOV 显式重新测量并提交初始基线，再复核同一报告。run `33818215500` 的候选经独立重算后替换 Mac 数值，随本次修改提交；最终源码与合入仍分别验收。不得在基线合入后选择旧 base 重新进入初始化以绕过不退化规则。
- [ ] 在授权样例 PR 验证红色测试、上游失败、矩阵缺失、取消运行及 PR 更新导致旧 SHA 失效，不合并故意失败代码。
- [ ] 在当前审批设置下验证 fork 等待批准、Owner 审阅当前代码后批准运行、完整矩阵执行与只读 token；Dependabot 单独验证。若真实入口当前不可用，记录未验证，不能以同仓库普通 PR 冒充，Task 15 再验收目标审批设置。
- [x] 检查真实公开 run 的日志、摘要、截图/trace 和可下载 artifact，确认只含允许输出且无合成敏感哨兵原文，不用真实 Secret 做泄漏样例。run `33823121330` 的 323 份非归档文件及两个平台归档通过公开检查；trace 无图像，不宣称视觉验收。后续负例按各自 run 单独审计。
- [ ] 在完整绿色正常 CI PR 经 Owner 审阅并明确授权合并后，将正常变更合入默认分支并验证 push 运行。样例失败 PR 不合并；schedule 在 Task 14 授权前不得随该变更意外启用。
- [ ] 保存 run/check URLs、tested SHA、实际权限、artifact IDs、报告摘要、失败结论和资源观测。核对使用的是公开仓库免费标准 runner，保留并发/超时/存储限制；更大规格或付费服务另行授权。清理远端样例需在已有授权内或另获授权。

### Task 14：在授权后启用周期检测

- [ ] 展示周期、默认分支、资源上限和检查内容，取得 schedule 启用授权；仅编写 YAML 不作为已授权启用依据。
- [ ] 在正式默认分支通过手动触发验证一次同样的质量任务，再启用已审阅时间配置。
- [ ] 核对周期 run 的触发来源、SHA、报告与历史 evidence 未被修改，保留一次真实周期触发证据。
- [ ] 验证周期失败不会自动合并、部署、生成生产资格或向外部渠道发消息。记录 GitHub 原生通知的责任边界。

### Task 15：在授权后启用服务端强制门禁

- [ ] 重新核查公开可见性、管理权限、当前规则、fork 审批策略及可写协作者。空规则记为 `enforcement_not_configured`；接口拒绝或管理权限不足记为 `enforcement_unavailable`，不把待批准/未运行检查误判为规则不可用。
- [ ] 展示准确 Ruleset 差异、fork 审批设置差异、required check 来源和回退方案，取得对应访问控制修改授权，无需先完成 Pro 升级。
- [ ] 在授权后将 fork 审批设置为 `all_external_contributors` 并回读。用适用的首次及重复外部贡献者样例证明待批准时不成功、批准运行后执行完整检查；该批准不代替合并审阅。
- [ ] 确认完整 `ci/required` 已实际出现且有效，再配置 Spec 第 10 节的主分支规则，避免锁死仓库。
- [ ] 验证首次初始化已结束，说明正常政策更新和经单独授权的规则维护路径；不得保留自动初始化或长期绕过入口。
- [ ] 回读并比较每项规则，核对最新组合、required check 来源、禁止强推/删除、讨论解决及无长期 bypass。
- [ ] 用授权样例确认失败 PR 无法合并、绿色对照满足条件；不实际合并或部署。不把 policy 文件或配置请求成功当服务端生效证据。

### Task 16：同步当前事实并交接未关闭项

- [x] 按已实现行为更新 README 的安装/检查入口与 Architecture 的 CI 责任边界。若形成新的持久决策，在实施时按一事一 ADR 记录，不改写旧 ADR。
- [x] 完成下方 CI-A01–CI-A14 映射，引用确切 SHA、命令、报告和远端证据。任务数或测试数变化时从当前结果重新计算。
- [x] 明确交付是本地工具完成、工作流已运行还是 GitHub 强制门禁已生效，不把其中一个状态代替另外两个。
- [x] 将真正独立且未关闭的未来工作按 document-governance 写入 Backlog；本 Plan 仍负责的未完成项留在本 Plan，不创建重复任务索引。
- [ ] 仅在下面的关闭条件成立后归档 Spec/Plan。S9 的生产资格任务保留原状态，本工程 Plan 的完成不代表产品可发布。

## 负向验证矩阵

| 编号 | 受控场景 | 预期结果 | 证据责任 |
| --- | --- | --- | --- |
| N01 | 格式/类型错误、Pi 越界 import、SOURCE 断链 | 对应静态检查非零 | Task 3/10 的 fixture 与工具输出 |
| N02 | 空 project、新测试无归属、`.only`、未登记 skip | 测试清单或执行失败 | Task 3/5 的发现与执行报告 |
| N03 | 实际测试失败、上游安装失败后下游跳过 | 汇总失败 | Task 9 单测和 Task 13 真实 run |
| N04 | 整次 workflow 取消、旧 SHA 或旧 attempt | required 不成功 | Task 9 fixture 和 Task 13 检查状态 |
| N05 | 矩阵缺项/重复/错平台但父 job 显示成功 | 集合校验失败 | Task 9 的正反结果集合 |
| N06 | 归档篡改、缺迁移、错 ABI、安装时重新构建 | 产物或安装检查失败 | Task 4/5 的 digest 与安装日志 |
| N07 | 历史合成 Secret 提交后删除、未批准例外、公开输出中的合成敏感哨兵 | 扫描失败，日志与上传材料不暴露哨兵原文 | Task 8 的临时 Git 历史、脱敏正反样例及 Task 13 的真实输出检查 |
| N08 | Advisory 网络失败、空扫描、规则未加载 | infrastructure/工具失败 | Task 8 的故障注入报告 |
| N09 | 新增未导入代码、删测、降低同 PR baseline | coverage 失败 | Task 7 的分母、差异和基线报告 |
| N10 | 页面异常、关键按钮失效、缺翻译/无障碍阻断 | browser 失败 | Task 6 的引擎结果与脱敏诊断 |
| N11 | fork 待批准/批准后运行、重复外部贡献者、Dependabot、恶意标题/分支参数 | 待批准不成功，批准后完整运行，无越权、无 shell 注入 | Task 10 参数测试、Task 13 权限证据与 Task 15 目标审批设置实测 |
| N12 | 红色/绿色对照 PR、规则漂移 | 红色不可合并，绿色符合规则，漂移被回读发现 | Task 15 的规则与 mergeability 证据 |

## 验证入口

先按 README 使用固定工具链安装依赖。以下入口已经实现，不依赖个人 Skill 路径。

```sh
npm run check
npm run check:ci-policy
npm run test:tooling
npm test
npm run ci:local
python3 -E -s -B tools/document-governance/scripts/validate_docs.py . --strict
```

`test:tooling` 和 `ci:local` 默认读取 `.ci-output/tools`；使用其他已验证工具目录时显式传入 `--tools`。`python3` 必须来自同一固定工具目录。`ci:local` 在当前受支持平台执行共享入口；浏览器执行前按 README 安装锁定 Playwright 对应的引擎。它不会将本机结果替换为托管矩阵，也不会配置 Rulesets。

## 本轮实施证据

### GitHub 托管验证

正常草稿 [PR #1](https://github.com/sixianli/himawari-agent/pull/1) 已创建，分支为 `codex/github-ci-quality-gates`。首轮 [run 33766675738](https://github.com/sixianli/himawari-agent/actions/runs/33766675738) 的 attempt 为 1，head 为 `7950d3e91cbfad997b9af74bb79c425fd555ac2c`，实际测试的 PR merge SHA 为 `ab468266c37199eed27e992eac8f3f5267d6d604`，base 为 `3f865d2860301d86f33978e6534cfbba02c37a89`。

首轮固定工具安装、锁文件安装和 SQLite 探针通过。tooling 测试共 478 项，其中 54 项因临时 Git 仓库继承真实 GitHub 环境变量而触发 `CI_CHECKOUT_SHA_MISMATCH`，policy 失败。其余检查按依赖跳过；`ci/required` 明确失败，报告只有 1/12，未将跳过或报告缺失视为成功。该失败保留为原始证据，不能改写为绿色对照。

修复仅在 Vitest 的 tooling 项目隔离继承的 `GITHUB_*`，正式 runner 的身份校验与其他测试项目保持原样；显式 hosted 测试继续覆盖真实校验分支。污染环境下用 `--maxWorkers=2` 完整执行 21 文件、480/480，零跳过；项目检查与严格文档校验通过。默认本机并发的两轮验证分别有 2/5 项既有 5 秒超时，已保留原始失败，未修改提交中的并发、重试或超时政策。远端修复后的完整运行另行记录。

实际 runner 为 Ubuntu 24.04，镜像 `20260831.293.1`；日志确认 token 只有 `contents: read` 和 `metadata: read`。已下载 policy artifact `9897918408` 与 gate artifact `9898005121`，分别核对 GitHub 提供的 ZIP SHA256 `ceb4d55daff430fcaeeefd1ea329653bf76a5f47756c1d879ae4b1a4b215345e` 和 `c81c970734012e1ee1580a9423fbd5c226f56001f9480e33457d69bb42dab03a`。完整记录位于本地忽略目录 `.ci-output/github-task13-20260903/`。

当前只读回读的 fork 审批策略为 `first_time_contributors`。仓库没有 fork，唯一 PR 来自 Owner；没有适用的 fork 或 Dependabot 实测入口，两项继续标记未验证。审批策略修改仍属于 Task 15 的单独授权范围。

环境隔离修复提交 `c4ea56962d2ee1a69ed585d67f79468ab54f7a1b` 的 [run 33816516553](https://github.com/sixianli/himawari-agent/actions/runs/33816516553) 使用 attempt 1，实际 merge SHA 为 `94dabbdc586eada647542e4a347498887cae57fc`，base 保持不变。policy、static、security、Linux/macOS 构建、macOS 五项目和三引擎浏览器通过；macOS 为 916/916，Chromium、Firefox、WebKit 各 58/58。Linux 五项目及最低 Node 均为 914/916，coverage 为 997/999；失败均来自两个测试硬编码 `/private/...`，Ubuntu 报 `EACCES`。对应 integration 379/379、e2e 3/3 和 pi-compat 15/15 均通过。该 run 仍是失败证据，不是绿色对照。

跨平台修复仅将这两个文件的状态目录改为 `mkdtemp(tmpdir())`，每例独立创建并清理，同时保留越界反例的语义。生产代码、provider 和 fake loader 未改；本机两文件 10/10 通过，专属临时父目录无剩余 fixture。Ubuntu 实际修复结果以随后完整 run 为准。

为完成 Ubuntu 初始基线复核，coverage 共享入口增加显式 `--baseline-candidate initial-only`。合法初始化时调用原测量器，使用同一次 snapshot/tests/JSON/LCOV 生成候选；非初始化继续通常比较。未达标、候选缺失或损坏、子进程写后失败及清理失败均不能形成可公开候选，仓库基线不会自动改写。公开 JSON 只有在去除字符串外空白后与标准序列化一致、原始和解码表示均通过脱敏检查时才保留原始字节，确保候选的报告摘要可直接核验下载材料。编码后的重复字段敏感值已有失败复现及修复回归，不能借原始字节保留绕过公开检查。

候选接线及输出保护的完整 tooling 验证为 508/508；随后补充编码重复字段保护，最终相关 runner/publisher/gate 55/55 通过。两轮证明范围分别保留，最终工具数量由下一轮完整报告重新计算。原始 GitHub ZIP、API 元数据、结果与诊断位于 `.ci-output/github-task13-20260903/run-33816516553/`，下载时逐一核对 GitHub 摘要与报告文件摘要。

第二轮的 16 个 artifact 已全部下载并核对原始 ZIP 摘要，107 份成员报告的文件大小和 SHA256 均相符；本地重放汇总与原始失败结论完全一致，实收 12/12、无缺项。316 份 JSON、日志、JUnit、LCOV 与 trace ZIP 通过公开输出检查；三个 trace 均没有截图或视频帧，因此没有可执行的截图视觉复核。7 份归档绑定对应两种实际内容摘要，两者均通过归档公开检查，已核验的合成 fixture 例外仍待 Owner 合入审阅。

第二轮 13 份依赖安装资源记录完整，12 份检查记录中 10 份完整，两个 build 各有 `workspace:1`。旧实现没有保留 `du` 的 stderr，无法从退出码确定根因；历史失败继续标为 `incomplete`。磁盘峰值是观测样本下界，不是内存峰值；标准 runner 的 CPU 型号也不完全相同，不能据此声明性能无回归。

第三轮 [run 33818215500](https://github.com/sixianli/himawari-agent/actions/runs/33818215500) 的 head 为 `b1baf8e43f7d7dc138acc6ff488ad2c4a414ea40`，attempt 1，实际 merge SHA 为 `c9723c9054f1552b3c2356f26e86ddc9efca61ad`。Ubuntu coverage 通过 1033/1033，生成 15 组初始化候选，新增行 2905/3076（94.440832%）、变更函数分支 1657/1830（90.546448%）。候选 artifact `9917438868` 的 ZIP SHA256 为 `b4045031c165d5e1cfbd0c58e51142c94ef5450ccc6fc240c0f1cb65d032fd2c`；独立核验全部 ZIP 成员、236 份生产源、91 项 snapshot 输入及原始 JSON/LCOV/tests 后，本地纯重算的完整结果与 Ubuntu 原报告一致。

该候选已显式替换 `ci/coverage-policy.json` 中的 Mac 数值，只有格式化空白变化，策略、阈值与原候选语义保持一致。来源 SHA 仍是实际测量的 `c9723c9`，不能改写成后续提交；本次显式提交初始候选，不表示 Owner 已批准合入。审计位于 `.ci-output/github-task13-20260903/early-33818215500/independent-audit/`；资源诊断等后续源码仍须重新验证。

第三轮最终为 `failure`：其余 11 个成员检查通过，Linux/macOS/最低 Node 五项目各 916/916，三浏览器各 58/58。安全检查的 machine-secret、Gitleaks、Semgrep 通过；npm advisory 请求 60 秒后报 `ADVISORY_NETWORK_UNAVAILABLE`，检查明确为 `infrastructure_failed`。汇总实收 12/12、无缺项，并因安全检查失败而失败。保留原始网络失败，不放宽安全门禁；下一次完整运行另行记录。

第三轮 16 个 artifact 原始 ZIP 和 110 份报告摘要均已核验；321 份非归档文件通过公开内容检查，7 份归档绑定对应的两种平台内容也通过独立扫描，汇总本地重放与原始失败完全一致。检查资源记录 11/12 完整，只有 macOS build 保留 `workspace:1`；13 份安装资源记录均完整。三个 trace 仍无截图或视频内容，不宣称视觉验收。证据位于 `.ci-output/github-task13-20260903/run-33818215500/` 和 `public-audit-33818215500/`。

资源诊断修订后，在本机真实 build 复现一次目录消失：采样于 23:50:02.186 UTC 开始，构建报告于 23:50:02.558 写成，8.534 秒后 `du` 报本次 `build/work/payload` 内目录不存在；随后最终采样成功。本次失败可定位到构建工作目录清理与遍历重叠，不能追改历史未保留 stderr 的失败原因。原始 187.229 秒构建及不完整资源记录保留在 `.ci-output/resource-diagnostic-20260904/`；该工作树含本机重复依赖文件，仅用于诊断，不是干净交付或可比性能基线。

修复通过同一资源观察器协调清理：先暂停新的遍历并等待当前采样，构建清理自己的工作目录后恢复计时。暂停和失败均有有界记录，清理错误与原构建错误分别保留。6 文件、171 项定向测试通过，无依赖冷导入与实际采样通过；真实本机构建 188.027 秒通过，三个资源范围均 6/6 样本、零失败，清理暂停 10.414 秒且工作目录已删除。该结果只证明本机修复，托管资源完整性继续等待新 run。

最终检查又将构建与清理的错误汇总改为明确顺序，避免 `finally` 中的显式抛出覆盖控制流；合成敏感反例的输入值保持不变，改为运行时构造。此后的项目检查与完整 tooling 524/524 通过，已有 188.027 秒构建不冒充这些最后修改的完整运行。资源修复单独提交为 `11a8092`。安装 Runbook 已重新核对语义和冷安装依赖闭包并 seal，严格文档校验 0 warning；所有原始失败和修复后记录均保留。

第四轮 [run 33823121330](https://github.com/sixianli/himawari-agent/actions/runs/33823121330) 为正常 PR 的完整绿色对照，attempt 1、head `58089d3a431d19473a7a535d843c4f2119eb28f8`、实际 merge `7c5209ffc67336e68d726edfa01ee2cd514cb7f9`，base 保持 `3f865d2`。12 个成员及 `ci/required` 全部成功；policy 524/524，Linux/macOS/最低 Node 各 916/916，三浏览器各 58/58，coverage 1043/1043。安全四项均通过，第三轮 advisory 网络失败仍单独保留。

本轮 16 个 artifact 官方 ZIP 摘要和 110 项报告文件摘要、字节数全部匹配。323 份非归档文件公开扫描通过，7 份归档绑定对应两个平台的内容摘要，均通过归档公开扫描；39 个合成 fixture 成员、165 处命中的精确初始化提案仍待 Owner 合入审阅。汇总本地重放为 passed、实收 12/12、无缺项，与原始报告完全一致。三个 trace 没有图像，未执行或声称截图视觉验收。

12 份检查与 13 份安装资源均为 `measured`，零采样错误；构建清理与采样协调已获得托管验证。13 个整个 job 的实际起止耗时都低于固定限额，最长为最低 Node 的 412 秒；required 为 123 秒，限额 300 秒。结合此前同机冷/热安装观测关闭 Task 12 的资源条目；历史 incomplete、采样值仅为磁盘下界、标准 runner 硬件不可比的边界保持不变。原始下载、归档重放、公开材料与资源记录位于 `.ci-output/github-task13-20260903/run-33823121330/` 和 `public-audit-33823121330/`。

本轮 Ubuntu 覆盖率的 237 份生产源、91 项 snapshot 输入及 tests/JSON/LCOV 经冻结源码独立复核，完整重算与原报告相同。新增行 2983/3156（94.518377%），变更函数分支 1689/1864（90.611587%）。14 个产品分组四指标保持原值，`scripts/ci` 四指标均提高；同份报告使用已提交 `c9723c9` 基线执行非初始化判定也通过。因此保留现有基线，新候选只作观测，审计位于 `coverage-review-33823121330/`，不自动提高门槛。

隔离草稿 [PR #2](https://github.com/sixianli/himawari-agent/pull/2) 使用 `codex/ci-negative-controls`，标题明确禁止合并。无注入 [run 33824226564](https://github.com/sixianli/himawari-agent/actions/runs/33824226564) 使用相同 `58089d3`，但 advisory 网络请求在 60007 ms 后失败，其余 11 个成员通过；原始错误未保留 DNS、TLS 或取消原因，不能进一步归因。12/12 报告和公开归档核验通过，汇总重放保留失败。Firefox 的临时 SQLite journal 在 `du` 遍历期间消失，检查资源记录为 11/12 完整；不把它算作资源验收成功。

随后仅作一次空提交，保持源码树不变。[run 33825241163](https://github.com/sixianli/himawari-agent/actions/runs/33825241163) 的 head 为 `b768a8e`，实际 merge 为 `61b3102`。本轮 advisory 通过，但最低 Node 的恢复点篡改用例和 WebKit 页面异常检查失败，其余 10 个成员通过。12/12 报告身份及摘要核验通过，汇总重放与原始失败一致；321 份非归档文件和两个平台归档公开扫描通过，12 检查及 13 安装资源完整。失败截图只显示合成后台任务页面，不据此推断页面异常的原因。

恢复点夹具原先替换 base64url 末字符，可能只改变未使用的编码位，解码后的 MAC 字节不变。确定性重现后改为翻转解码后的首字节，并断言字节确实变化；9/9 恢复点测试和 `npm run check` 通过，提交为 `2718cf3`。没有修改生产加密验证或测试超时。

WebKit 的两次 payload access-control 异常都发生在硬导航附近、受控断网之前。Mac 上使用失败 run 的冻结前端及固定 WebKit 进行 8 组对照，未完成请求导航时出现 14 条 `cancelled`，等待响应后为零；所有组均无页面或 DOM 异常，尚未复现 Ubuntu 的错误。浏览器资格脚本增加有界请求与页面导航观察，保留请求发起时的页面和主 frame 导航序号并输出 `browser-observation.json`，不改变错误分类。下一轮用实际 Ubuntu 事件查明原因。证据位于 `control-test-fixes/`、`webkit-navigation-repro/`、`negative-controls/` 和对应 run 目录。

两轮无注入 PR #2 均未获得绿色，因此故障注入仍未开始；不能用正常 PR 的旧绿色替代同一隔离 PR 的对照。历史失败均保留。 新诊断模块的 4 项合同测试通过，行覆盖率 100%、分支覆盖率 96.42%；完整 tooling 528/528、项目检查和严格文档校验通过。Mac WebKit 全部 58 项通过，实际观察到 1368 个事件且无截断；这只验证本地接入，不替代 Ubuntu 的待查错误。

新增诊断后的正常 [run 33827481864](https://github.com/sixianli/himawari-agent/actions/runs/33827481864) 使用 head `50e671f`、merge `ab6066e`；隔离 [run 33827484007](https://github.com/sixianli/himawari-agent/actions/runs/33827484007) 使用 head `66218cf`、merge `419085c`，两者源码树相同。两轮最低 Node 及双平台各 916/916，policy 528/528、coverage 1047/1047。正常 PR 三个浏览器通过，但 advisory 在 60006 ms 后失败；隔离 PR 另有 WebKit 页面异常。两个汇总均正确失败，未进行故意负例注入。

两轮各 16 个官方 artifact ZIP 和报告摘要核验通过，归档审计使用对应冻结 merge 的代码与政策，扫描前后检查受跟踪源码及工具代码摘要不变。汇总重放均与实际失败一致，实收 12/12、没有缺项。两轮各 324 份非归档文件及两个平台归档通过检查，各 12 检查与 13 安装资源完整、所有采样零失败。13 个 job 的实际权限均只有 Contents/Metadata read，最长 job 分别为 388/396 秒，均低于限额。非归档独立扫描记录实际 verifier 哈希及其三处传递模块与冻结源码的差异，不冒充冻结版本；归档及汇总另用冻结版本重放。

隔离 WebKit 的唯一异常发生于硬导航开始后、完成前；观察器无截断，但没有可唯一关联的 payload 请求失败。Mac 又完成四组 query 响应/即时导航与实际标题就绪对照，即时导航可产生 payload 取消，全部仍无页面或 DOM 异常。因此保留未知根因，不增加例外。资格流程将两处“进入对话后立即硬跳转”改为真实列表选择，并等待已提交标题与正文；完整 58 项检查和其他深链接保持。Mac 全量通过，Ubuntu 效果等待下一次冻结源码实跑。

advisory 的归一错误此前丢失原始原因。本地新增单次请求/响应体阶段的有界安全诊断，117 项定向测试通过；不重试、不扩大 60 秒预算，不把网络失败视为零发现。具体 DNS、连接、TLS 或等待响应原因仍待实际失败诊断。

Task 14 准备审查发现原代码永久拒绝启用状态、未识别周期事件，也未定义其 base。已补齐保持禁用状态的本地支持及质量 workflow 合同校验，周期 base 固定为同次默认分支 SHA，手动输入与主 CI/交接边界保持。实际 `enabled` 仍为 false，YAML 没有注册 cron；本地支持不等于已获启用授权或真实周期验收。后续仍先完成 Task 13，再按 Task 14 的默认分支手动运行和启用步骤验收。

合并后的当前本地修订已完成单次 tooling 586/586、`npm run check` 和严格文档校验，全部通过。列表导航修订的 Mac WebKit 58/58 通过，观察到 1314 个事件、无截断或页面异常。安装 Runbook 因共享 Context schema 与源文件变化完成语义核对，补齐相关 contract selector 并 seal 为 `sha256:a781a945e6e6299c0c70c776e8458a7830df04b9f7a21f90387d090fc4c9fb1b`；没有执行安装、启停或部署操作。这些本地结果不替代下一次托管全量验证。

最新无注入隔离 [run 33829889364](https://github.com/sixianli/himawari-agent/actions/runs/33829889364) 的 13 个 job 全部通过，head `60a000c`、merge `40584c8`。同源码树正常 [run 33829859902](https://github.com/sixianli/himawari-agent/actions/runs/33829859902) 的 head 为 `30e0aec`、merge 为 `252a28c`，仅 security 及其汇总失败，其他成员通过；两轮 Ubuntu WebKit 均通过。正常 advisory 的新诊断明确为请求尚未返回响应时，自有 60 秒期限触发 `TimeoutError`（code 23）；相同请求摘要在隔离运行耗时 9606 ms 成功。此证据不能判定 DNS、TLS 或服务端的具体根因。

按来源 Spec 已允许的有界重试补齐窄范围恢复：相同请求在自身期限到期且尚无响应时最多再执行一次，每次 60 秒、间隔最多 1 秒。每次结果均保留，实际重试次数进入检查报告；其他失败与发现不重试。该修订的 149 项定向测试、变更覆盖率、项目检查及严格文档校验通过。最终托管状态以正常 PR 最新检查为准；隔离故障样例继续使用上述真实绿色提交作为固定对照，不混入新的正常分支修订。

### 本轮收尾状态

重试修订提交 `c62c4d6` 已推送至正常 PR。真实 [run 33832717445](https://github.com/sixianli/himawari-agent/actions/runs/33832717445) 的 tested merge 为 `d5c6f41`，实收 12/12 报告，无缺项；构建、双平台测试、最低 Node、三浏览器、政策、静态和覆盖率均通过，覆盖率采集测试 1116/1116。仅 security 的 advisory 查询失败，最终汇总正确阻断。两次请求分别耗时 60003/60000 ms，总耗时 121008 ms，均为自身期限到期且尚未收到响应；`requestAttempts` 和正式 `CheckResult.retryCount=1` 保留完整。其他三项扫描通过。本次未发现重试实现错误，也不能将网络超时解释为没有漏洞。

本轮仅保存必要的官方 gate、安全及覆盖率 artifact，核验元数据、ZIP 摘要、报告绑定和运行身份；不重复下载和审计此前已覆盖的大型构建归档。正常 PR 的当前提交未取得完整绿色，不继续增加重试次数或修改安全门禁。默认分支合入、周期启用、fork/Dependabot 和 Ruleset 验收均保持未完成，Spec/Plan 不归档。

隔离红测试 [run 33832549495](https://github.com/sixianli/himawari-agent/actions/runs/33832549495) 使用 head `fe8b448`、tested merge `d6fac02`。预设的 `schemaVersion` 断言实际报 `expected 1 to be 2`，双平台测试与最低 Node 失败；汇总实收 12/12 并明确拒绝这些失败成员。旧绿色 head `60a000c` 与当前失败 head 不同，API 中当前 `ci/required` 也为失败。该轮另有独立 advisory 超时，故不宣称为单一原因样例，不为排除此噪声重跑整轮。

隔离安装失败 [run 33833572857](https://github.com/sixianli/himawari-agent/actions/runs/33833572857) 使用 head `32f3d59`、tested merge `c3573ef`。两平台在实际 `npm ci` 中均报 `EINTEGRITY`，build 失败，下游 test/browser 被跳过；汇总明确拒绝 build failure、下游 skipped 及七个缺失成员报告。该轮亦有独立 advisory 超时，保留多原因事实。拟取消前的即时回读显示运行已自然结束，因此没有把它记为取消证据。

“全部上游成功后仅扣留一个 Firefox 报告”的独立远端样例本轮未执行；不能用上述安装失败造成的报告缺失替代。持续 advisory 超时尚未解决，后续恢复稳定绿色再补验，不降低门禁或继续增加重试次数。

隔离分支恢复提交为 `918fce4`，源码树与绿色对照 `60a000c` 完全一致，两个注入目标均已还原。恢复推送触发 [run 33834326410](https://github.com/sixianli/himawari-agent/actions/runs/33834326410)，在仅 policy 启动、矩阵尚未运行时执行取消；policy 和其余上游均取消，`always()` 汇总继续执行后明确失败，整次 run 最终为 `cancelled`，没有成功替代状态。该观测不覆盖已有矩阵成功后再取消的更强场景，不据此关闭全部取消验收。

### 干净提交验证

实现提交为 `f2ce494fa8d7ee1e7f67bbe4093befabe4f2cbcb`。从本地提交建立 `/tmp/himawari-ci-clean-f2ce494`，无缓存锁文件安装、SQLite 探针和三个专属 Playwright 引擎安装均通过；测试没有修改受跟踪文件。完整 `ci:local` 比较基线固定为 `3f865d2860301d86f33978e6534cfbba02c37a89`。

| 检查 | 本次实际结果 |
| --- | --- |
| policy / static | tooling 20 文件、476/476；项目检查、严格文档、actionlint 和差异检查通过 |
| build / test | 7 项构建检查通过，归档 32,075 文件；五项目 111 文件、916/916，零失败、零跳过，消费摘要不变 |
| Chromium / WebKit | 各 58/58，通过同一份归档 |
| Firefox | 专属目录重新安装后仍在启动阶段报 `sandbox_extension_issue_file_to_process … Operation not permitted` 和 SWGL 初始化错误；未关闭浏览器沙箱或放宽检查 |
| coverage 首轮 | 995/995 采集通过，差异解析将源码中的 `Binary files ` 字面量误认成 Git 二进制标记，检查明确失败；原始结果保留 |
| security | machine-secret、Gitleaks、Semgrep、完整锁文件 advisory 四项通过；642 个当前文件、119 个历史提交，659 个锁文件条目，advisory 为 0 |
| 公开输出准备 | 九组成功/失败报告全部通过本地 publish，保留各自原始状态；包括归档、日志及浏览器诊断，没有实际上传 |
| 资源 | 同机冷缓存安装 45.396 秒、热缓存 49.349 秒，SQLite 均通过，安装采样完整。构建 115.983 秒、五项目 162.138 秒；各检查耗时均低于配置上限。构建和 Firefox 各有一条 `workspace:1` 采样错误，仍为 incomplete，其余检查采样完整；时点峰值均为观测下界 |

归档 SHA256 为 `7419049751ba63cf90a4bc8254b793f068302c4b347dc83f12ee1e32cb967202`。本次完整运行结论是 `failed`，不得改写为全绿。报告已复制到当前工作区 `.ci-output/final-delivery/`：`local-summary-f2ce494.json`、`publication-f2ce494/`、`resources-f2ce494.json` 及冷/热安装记录；它们仍是本地忽略文件，未完成远端或 S9 持久交接。

覆盖率解析修复单独提交为 `43d3969fd851cf7c03d09b926f66babec6571a52`：只将拒绝条件改为 Git 独立标记行，保留真正二进制差异的拒绝。22/22 回归及项目检查通过；修复后的完整采集使用新的 snapshot，不复用首轮报告。构建、主测试和浏览器证据仍绑定上述 `f2ce494`，不冒充新提交的整次运行。

干净 `43d3969` 的静态检查和新覆盖率采集均通过：86 文件、997/997（unit 365、contracts 154、tooling 478）；236 个源码文件、15 组基线，新增行 2879/3052（94.331585%）、变更函数分支 1628/1802（90.344062%）。使用该轮原始 snapshot/tests/JSON/LCOV 显式测量后再次检查通过；当时 Mac 候选的来源 SHA 保持 `43d3969`，没有改写为后续基线与文档提交。该历史候选现已由上文 Task 13 的 Ubuntu 测量替换。

修复后的报告位于 `.ci-output/final-delivery/publication-43d3969/`，原始测量与输入摘要位于 `measurement-43d3969/`。本地负例索引为 `.ci-output/final-negative-inventory-clean.json`，逐项区分本次断言、实施中历史故障注入及尚未执行的 GitHub 验收。构建输入、测试源码和事实文档的不同验证边界均保留；没有合并成伪造的完整成功 run。

### 实施过程记录

以下均为 2026-09-03 的本地观测。提交身份是起点 HEAD，工作树内容另外由报告中的输入摘要绑定；这些中间结果不能冒充最终提交或真实 GitHub run。`.ci-output` 是忽略目录，报告暂留在当前工作区，尚未上传或持久交接。

| 证据 | 实际结果与范围 | 本地记录 |
| --- | --- | --- |
| 原始检查 | 原始 `npm run check`、严格文档校验通过；完整测试曾有资源和安装测试失败，保留原始输出 | `.ci-output/baseline/check.log`、`docs.log`、`isolated-projects.json` |
| 无缓存安装 | Node 22.22.3、npm 11.8.0、Python 3.12.10；33.861 秒；643 包、15 workspaces；SQLite 内存读写通过；无个人 Skill、sibling Pi 或旧 node_modules | `.ci-output/baseline/toolchain/cold-installation.json` |
| 当前工作区锁文件重装 | 同一固定工具、643 包、15 workspaces；冷缓存 120.588 秒、热缓存 77.893 秒，SQLite 探针通过；保留包的版本无变化。冷轮一条磁盘样本失败，资源记录明确为 incomplete，不能冒充完整峰值 | `.ci-output/final-install/{cold,warm}/installation-result.json` |
| YAML 补丁 | 本期新增直接依赖 YAML 从既有传递版本 2.8.1 固定到 2.8.3，解决已确认的 `GHSA-48c2-rrv3-qjmp`；其余包版本、数量不变。再次锁文件安装与 SQLite 探针通过，64.713 秒，磁盘采样无错误；锁文件 SHA256 为 `0dd237e60a4394393b39741aab157aaa3867d1c71e491a5149d39fabb00a8a9e` | `.ci-output/final-install/yaml-patched/installation-result.json`；[上游补丁](https://github.com/eemeli/yaml/releases/tag/v2.8.3) |
| 干净依赖构建 | Mac 归档含 32,075 文件、57,637,921 字节，构建检查通过；归档 SHA256 为 `e48e4d902b63875b330238e46c4438eccfe8bcb9a4c0e259e5f9d2abf9205f5b`。后续源码和覆盖率基线仍将触发最终重建 | `.ci-output/final-build/result.json` |
| 单一归档安装与测试 | Mac 构建和安装测试成功；111 文件、916 用例通过，零跳过。使用的旧 node_modules 后续发现额外重复文件，此证据不代表干净依赖安装，固定锁文件重装后必须重建 | `.ci-output/u2-20260903/tests-result-2.json` |
| 干净依赖五项目首轮 | 916 用例中 911 通过、5 个外层超时；保留失败。Git suite 默认 5 秒、两组进程 suite 默认 5/15/30 秒短于允许的多阶段执行，限定调整 suite 预算，未改内部业务期限。Git 17/17、两组集成 7/7 的独立复核通过，归档摘要不变；尚待最终完整运行 | `.ci-output/final-tests/result.json`、`.ci-output/git-harness-budget-1/tests.json`、`.ci-output/integration-suite-budgets-1/outcome.json` |
| 浏览器 | Chromium 58/58；WebKit 首轮请求错误，诊断轮 58/58，不将诊断重跑覆盖为首轮通过；Firefox 启动权限/渲染错误在同一 binary 独立启动复现 | `.ci-output/u2-20260903/` 的各引擎原始报告 |
| 浏览器负例 | 页面异常、按钮损坏、缺翻译、自动无障碍阻断四类真实故障注入均拒绝 | `.ci-output/u2-20260903/` 的故障注入报告 |
| 工具负例 | 政策、归档、依赖安装、扫描、汇总、执行退出码、公开输出和证据交接已有正反样例；最终 tooling 全量与覆盖率仍待冻结采集 | `test/tooling/`、`.ci-output/baseline/root-regressions.log` |
| 真实静态负例 | 格式、类型、Pi 依赖方向、SOURCE 和需求映射的 12 次正反工具执行均得到预期退出码 | `.ci-output/n01/results.json` |
| 禁止测试内重建 | 临时副本的原测试正向 8/8、exit 0；注入旧内部 `build:node` 片段后只有对应守卫失败，7/8、exit 1；未执行内部构建，当前仓库输入摘要未变 | `.ci-output/n06-rebuild-guard/results.json` |
| 合成规模 | scale 与 Thread 专项均通过各 1 个实际用例，分别为 67.582/5.995 秒；生成行数符合原有目标，报告和数据使用本次独立目录。scale 产品资格仍为 partial，CI 检查通过不消除既有 S9 未完成项 | `.ci-output/final-quality-scale/quality.json`、`.ci-output/final-quality-thread-scale/quality.json` |
| 额外 Node 观察 | 固定 Node 24.11.1 的两套类型检查与 4 文件、158 个纯工具用例通过；不扩大产品支持范围，不证明该 ABI 的 SQLite 绑定 | `.ci-output/final-quality-node-observation/quality.json` |
| 安全扫描 | 当前内容及 118 个历史提交实际扫描；28 处合成样例对应 13 条精确初始化提案；依赖无 High/Critical，1 项 Moderate。提案仍需 Owner 合入审阅 | `.ci-output/security-task8-final/qualified-scan/security-report.json` |
| 覆盖率初始测量 | unit/contracts/tooling 共 86 文件、995 用例通过，236 个源码文件覆盖 15 组；新增行 2879/3052（94.33%），变更函数可定位分支 1627/1800（90.39%），严格映射与 LCOV 校验通过，初始基线已写入。随后两份合成安全测试仅调整源码拼接、保留运行字节；最终基线仍须由干净提交副本重新采集 | `.ci-output/coverage-baseline-20260903-final-2/`、`ci/coverage-policy.json` |
| 提交前项目检查 | 最终合成安全 fixture 调整后 `npm run check` 通过，现有机器密钥扫描通过 642 文件；固定 actionlint 校验两个 workflow 通过 | `.ci-output/baseline/check-final-2.log`、`actionlint-final.log` |
| 公开输出 | 干净归档 39 个命中文件全部核验官方 npm SHA512 → tar 成员 SHA256 → 构建文件一致性，165 处命中、48 个字面量已核实为文档、占位和合成测试用途。正式 publish 已通过，10 份报告全部摘要核对，新增 `public-review.json` 保留初始化提案及待 Owner 审阅状态；旧包成员准入不替代后续源码变更后的重新构建 | `.ci-output/security-task8-final/published-source-proof.json`、`published-admission-result.json` |
| 文档治理 | 安装 Runbook 已按工具安装、归档与真实临时服务测试校对，并按原治理脚本重新 seal；严格校验 0 warning。该静态 seal 不表示已对真实主机执行 Live-State Preflight 或启停 | `.ci-output/baseline/docs-final-source.log`、`docs/runbooks/install-start-stop-runbook.md` |
| GitHub 状态 | 只读证据显示公开仓库、main 无保护；没有新建分支、push、PR、Actions run、schedule 或规则修改 | `.ci-output/baseline/branch-protection.json` |

原始磁盘记录为时点样本，不能追记为峰值。上述本地冷/热安装、规模检查和干净 checkout 已实际执行；本地资源采样错误与 Firefox 启动失败仍保留，后续托管浏览器通过另见上文。所有未关闭的托管验证、周期任务和强制规则继续由 Tasks 13–15 负责，S9 状态保持不变。

## 验收映射

| Acceptance ID | 负责任务 | 必需证据 | 当前状态 |
| --- | --- | --- | --- |
| CI-A01 | Tasks 3、9、10 | 政策/schema、DAG/矩阵/测试归属正反测试 | 本地与第三轮托管 policy 通过；最终源码仍须重新执行 |
| CI-A02 | Tasks 1、2、4、13 | 干净 runner、原生读写、工具与 Pi 身份 | 第三轮 Linux/macOS 及最低 Node 的固定安装、SQLite 探针通过 |
| CI-A03 | Tasks 3、5、12、13 | 五个主 project 和 N02/N03 | 第三轮 Linux/macOS/最低 Node 各 916/916、零跳过；故意红色测试 PR 待执行 |
| CI-A04 | Tasks 4、5、12、13 | 同一归档安装、平台清单和 N06 | 两个平台构建与消费检查均已托管通过；第二轮全部归档下载摘要与公开检查通过 |
| CI-A05 | Tasks 6、12、13 | 三引擎报告、三语/键盘/自动无障碍和 N10 | 第二、三轮托管三引擎各 58/58；本机 Firefox 旧失败保留，不冒充品牌或真机资格 |
| CI-A06 | Tasks 2、3、10、12 | 现有 checks、固定治理 validator 和 N01 | 干净 f2ce494 与修复后的 43d3969 静态检查均通过；N01 的 12 次真实正反工具执行有效 |
| CI-A07 | Tasks 7、12 | 可比基线、增量报告和 N09 | 第三轮 Ubuntu 1033/1033，增量 94.440832%/90.546448%；冻结源码候选与原报告独立重算一致，最终源码仍须验证 |
| CI-A08 | Tasks 8、12、13 | 三类安全扫描、例外与 N07/N08 | 第二轮四项安全检查通过；第三轮 advisory 网络超时按失败处理；精确例外仍待 Owner 合入审阅 |
| CI-A09 | Tasks 9、10、12、13 | needs+成员报告的严格判定和 N03–N05 | 正常 run `33823121330` 实收 12/12 并成功；两轮隔离 PR 无注入 run 正确保留安全/测试/浏览器失败，故意负例待执行 |
| CI-A10 | Tasks 8、10、13、15 | 实际事件/SHA/权限、公开输出检查与 N11 | 同仓库草稿 PR 的只读 token 与第二轮公开材料已验证；fork/Dependabot 无适用入口，仍未验证 |
| CI-A11 | Tasks 13、15 | 公开仓库管理权限、规则回读与 N12 | enforcement_not_configured；无 Pro 升级前提 |
| CI-A12 | Tasks 11、14 | 周期 run、独立输出和 S9 交接格式验证 | 手动质量任务和导出器已实现；schedule 未启用，真实交接未验收 |
| CI-A13 | Tasks 12、13、15 | N01–N12 全部正反对照及实际门禁拒绝 | 本地负例索引逐断言复核；真实取消、fork/Dependabot 与 N12 的拒绝合并仍未执行 |
| CI-A14 | Tasks 1、12、16 | 资源基线、复现入口、文档与完整交付记录 | 本地冷/热安装与托管资源报告已保存；正常 run `33823121330` 的 12 检查与 13 安装采样完整、全部 job 符合限额；历史不完整观测单独保留 |

## 关闭检查清单

- [ ] CI-A01–CI-A14 均有对应当前实现证据，没有缺失矩阵或未授权动作被标成通过。
- [ ] 本地工具、GitHub workflow、fork 审批设置与 GitHub 强制门禁分别验收。规则未配置、权限受限或实际检查未完成时，不把本 Plan 标记全部完成。
- [ ] 所有负向验证场景被正确拒绝，正常对照通过，真实 GitHub 结果与汇总逻辑一致。
- [ ] README、Architecture 与已采用的操作文档只描述已实现事实；不存在未验证的 Runbook seal。
- [ ] S0 验收归属、S9 待完成事项、历史 evidence、Pi 边界和用户数据保持正确。
- [ ] 严格文档校验、项目检查、差异校验及适用测试通过，远端修改有独立授权和回读。
- [ ] 已合并、拒绝、被替代或另有明确关闭决定，剩余工作有唯一归属。
- [ ] 使用 document-governance 的 `archive_doc.py` 归档 Spec 和 Plan，随后重新执行 strict validation，不手动移动文件。
