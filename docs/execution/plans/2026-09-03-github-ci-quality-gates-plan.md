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

**编制与执行状态：** 用户已明确要求同时编制 Spec 和 Plan，因此本文件与来源 Spec 一同交付。`status: active` 表示开放执行工作，不表示实施已获授权或验收完成。所有实施任务初始未完成。执行者须先确认来源 Spec 的合同和本轮实施授权，再开始 Task 1。

## 使用方法与证据边界

本文件供后续 AI Agent 或维护者逐项执行。先读来源 Spec，再核对当前 Git、工具链和 GitHub 状态。不得把本次设计基线、历史测试数量、曾经通过的命令或 Plan checkbox 当作新 revision 的证据。

每个 checkbox 只有在指定文件、测试输出或远端回读存在后才能勾选。记录完整命令、退出码、tested SHA、工具版本、证据位置和未验证项。方案中的新命令在本文件创建时尚不存在，须由对应任务实现后才能使用。

采用 document-governance 的 Plan 模板和来源关系。这里不创建 PStack 常驻协调程序，不自动创建 Goal、分支、PR、定时任务或发布流程。需要子任务时按主机可用并发执行，只有不重叠的文件边界可以并行写入。

## 执行依赖与授权停止点

- Tasks 1–12 是本地实施与验证。开始这些任务需要新的实施授权，本次文档请求不执行它们。
- Task 13 涉及 push、样例 PR、正常 CI 变更的合并和真实 Actions，Task 14 涉及启用 schedule，Task 15 涉及账户条件和分支规则。这些动作分别取得明确授权，不由本地通过结果推导。
- 账户升级、公开仓库、迁移组织、购买额度、安装生产主机依赖和真实 provider 调用不在本 Plan 执行范围。
- 保留私有仓库。Rulesets 或保护接口拒绝时，Task 15 保持未完成。不得改成“本地 hook 已满足”。
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
| U5 | Tasks 13–15，GitHub 验证与强制门禁 | U4，各项外部授权及账户前提 | run URLs、拒绝合并证据、规则回读 |
| U6 | Task 16，文档和交接 | 已完成单元的事实 | 验收映射、未关闭事项与准确交付状态 |

Task 7 与 Task 8 可在不同文件范围并行。构建脚本、npm scripts、Vitest 配置和政策文件由一个协调者顺序合并。每个平台输出独立目录。验证完成后按单元做本地提交；分支、push、PR 和合并仍单独授权。

吞吐检查点为先完成政策和干净安装，再拆分产物/测试与安全检查。共享状态仅为版本化配置，禁止多个执行者同时修改。并行单元都返回具体证据，主执行者复核后才推进依赖任务。

## 实施任务

### Task 1：确认合同并记录当前基线

- [ ] 读取来源 Spec、项目 AGENTS、现有 package/test/build 脚本及 S0/S9 边界，记录确认和实施授权范围。
- [ ] 记录 HEAD、dirty 文件、工具版本和锁文件摘要。保护用户已有修改，只在隔离临时目录运行破坏性样例。
- [ ] 实跑现有 `npm run check`、文档严格校验和五个主测试项目，逐项记录实际基线及 opt-in suite，不从历史计数推算。
- [ ] 只读复核 GitHub 仓库类型、默认分支、Actions、可写协作者及规则能力。保存脱敏结果和查询时间，区分 403 权限限制与空规则。
- [ ] 在基线目录记录当前安装/构建耗时、磁盘峰值、工具依赖和未通过项。基线失败先定位，不先放宽门禁。

### Task 2：固定工具链与治理校验器

- [ ] 按 Spec 第 2 节建立 `ci/toolchain-lock.json`，选定 Python、Action、scanner 和规则的精确版本与下载摘要，记录许可来源。
- [ ] 用 `sync-governance.mjs` 固定 validator 的实际运行依赖闭包和原始内容摘要。保留来源证据；不得手写替代 validator。
- [ ] 实现工具安装入口，使用锁文件和审核过的原生构建清单；未知包脚本、digest 错误或工具缺失立即失败。
- [ ] 在无缓存、无个人 Skill 目录、无 sibling Pi 的临时环境运行安装、SQLite 内存读写和 strict docs validation。
- [ ] 用损坏工具摘要、缺失治理模块、错误 Pi 版本和非法外部 symlink 验证拒绝路径。保留允许的 workspace 内部链接正向对照。

### Task 3：实现政策、结果 schema 与测试归属

- [ ] 建立 Spec 第 1 节的最小 JSON 记录和 schema，拒绝未知字段、重复身份、非法终态和缺失来源。
- [ ] 实现 `check-policy.mjs`，核对 workflow job/矩阵与唯一政策、完整测试文件归属及固定工具身份。
- [ ] 建立 `test/tooling` project，复用当前 Vitest；登记主测试、专用资格测试和辅助 child fixture，拒绝未知文件与 `.only`/未登记 skip。
- [ ] 实现来源 Spec 的首次初始化与后续政策更新边界。旧政策缺失或损坏不能被当作首次引入，功能变更不能自行使用新例外。
- [ ] 用空 project、漏掉一个矩阵成员、重复测试归属和新增未登记测试验证政策检查会失败。
- [ ] 定义 `run.mjs` 的受控参数与输出目录，拒绝仓库外任意写入、无效 artifact 路径和不支持的 check ID。调用不接受报告中的任意 shell。

### Task 4：构建可核验的单次产物

- [ ] 调整现有 build/package 入口，输出到明确的本次运行目录；移除依赖共享 `dist` 的隐式并发假设。
- [ ] 在现有 manifest 上补齐 Node 文件清单、模式、依赖闭包、migration、OS/arch/ABI、输入与内容摘要，不另建第二份产品候选状态。
- [ ] 将构建内容归档，校验归档路径安全、完整性和平台身份；生成时间只用于运行记录，不参与内容等价比较。
- [ ] 准备 Linux x64 与 macOS arm64 的独立构建入口，在本机可用平台完成干净构建与原生探测。尚不可用平台的实际运行明确留给 Task 13。
- [ ] 注入单字节修改、缺失迁移文件、错误 ABI、错误来源 SHA 和路径穿越归档，确认 `verify-artifact.mjs` 全部拒绝。

### Task 5：统一五个主 project 并验证安装产物

- [ ] 将四类 opt-in suite 分配给专用资格 project，从普通 integration 集合明确排除；保留其具体路径与理由。
- [ ] 使 `npm test` 与 CI 共用主测试执行入口。入口显式准备/接收产物，五个 project 均非空，不使用 `passWithNoTests`。
- [ ] 移除安装测试的内部 `build:node`。测试从本次归档安装到临时 prefix，在非源码 cwd 下运行三个 binary，禁止开发依赖搜索路径补漏。
- [ ] 保持 integration 文件串行。完成现有启动、doctor、SQLite、锁冲突、drain/restart、恢复与迁移模拟场景，核验安装前后归档摘要不变。
- [ ] 测试失败、主 project 清空、产物被替换、缺少依赖和测试内部重新构建均产生非零结果。保留 source-independent 安装成功对照。

### Task 6：把真实浏览器纳入必需矩阵

- [ ] 让现有 Playwright 脚本和 fixture server 消费构建产物路径，报告目录与端口显式可控，启动失败和清理失败不吞掉错误。
- [ ] 保留现有治理交互，补齐实际缺失的 `zh-CN`、`en`、`ja`、键盘、可见焦点、JS 异常和自动无障碍断言。
- [ ] 在独立环境执行 Chromium、Firefox、WebKit，保存引擎版本、场景结果及脱敏失败诊断。
- [ ] 注入破坏按钮、页面异常、缺翻译与无障碍阻断样例，确认对应检查失败，fixture-only 和设备模拟身份保持明确。
- [ ] 实跑前端预算检查，确认其现有限制未因测试接入被放宽。记录真实浏览器耗时，不把首次结果当性能承诺。

### Task 7：建立可比较的代码覆盖率门禁

- [ ] 精确添加匹配 Vitest 的 coverage provider，固定 Spec 第 6 节的 include/exclude 和 unit/contracts/tooling 采集范围，覆盖自有 CI 执行代码。
- [ ] 输出 LCOV/JSON 和 source-map 还原位置；未导入生产文件仍在分母。跨进程、浏览器和上游 Pi 不冒充已合并覆盖。
- [ ] 实测初始各生产 workspace 与自有 CI 工具的四类指标并记录基线。按 Spec 实现新增行 90%、变更函数分支 85% 和整体不退化规则。
- [ ] 基线从目标分支固定版本读取，给出精确的无新增行/无分支原因；同 PR 降低基线不得将自身失败转绿。
- [ ] 实现 PR、push 和手动检查的 diff 基线解析；before/base 缺失不得退化为空 diff，并验证首次基线初始化路径。
- [ ] 用新增未导入文件、删测、缺报告、错误 source map、伪造空分母和更换工具版本验证拒绝或不可比结果。保留可比政策迁移的正向样例。

### Task 8：实现安全扫描与窄范围例外

- [ ] 复用当前 machine-secret scan，接入固定 Gitleaks 的当前内容与提交范围扫描。fixture 使用合成凭据，输出脱敏。
- [ ] 固定 Semgrep CE 及许可明确的规则，启用阻断命中和工具错误失败；验证规则实际加载和生产文件覆盖。
- [ ] 根据完整锁文件扫描生产/开发及传递依赖，保留 advisory 响应摘要、时间和 High/Critical 判定。
- [ ] 实现精确 `ExceptionRecord` 校验，读取受审阅基线，拒绝到期、重复、扩大范围或自动生成的例外。
- [ ] 验证历史泄漏后删除、真实泄漏不可豁免、到期例外、advisory 不可用、规则解析失败、空扫描和报告缺失均失败。

### Task 9：实现拒绝不完整成功的汇总器

- [ ] 实现 `aggregate.mjs` 的纯判定逻辑。先验证 `needs` 全部成功，再核对所有报告、矩阵和身份。
- [ ] 对 tested SHA、head/base、event、run ID/attempt、政策摘要、工具链、退出码、计数和 artifact 摘要做完整校验。
- [ ] 以真实正向格式生成 `GateSummary`，每个失败原因可定位到 check ID、矩阵键和原始报告。
- [ ] 测试 `failure`、`cancelled`、`skipped`、`neutral`、缺失 job、矩阵 aggregate success 但成员缺失、空报告和旧 attempt 均不能通过。
- [ ] 验证完整 workflow 重跑产生可接受的新 attempt，仅重跑失败 job 的混合结果按 Spec 拒绝并提示完整重跑。
- [ ] 验证诊断或上传步骤失败不抹去原始失败，未知输入不得默认为 success。总体通过需要完整正向对照。

### Task 10：实现 PR 与默认分支工作流

- [ ] 编写 `.github/workflows/ci.yml`，完整实现 Spec 第 5 节的 job/矩阵和依赖；稳定显示名为 `ci/required`。
- [ ] 配置 Spec 第 9 节的事件、正确 checkout 身份、并发取消、超时、`fail-fast: false` 和最小权限，不设置 workflow paths 过滤。
- [ ] 配置本次 artifact ID 的传递与重新校验，防止按 latest/分支名读旧归档。各 job 不共享可写 checkout 或原生依赖缓存。
- [ ] 令 `required` 使用 `always()`，上传报告保留失败语义；取消整个 workflow 时保持未成功，而非额外写成功状态。
- [ ] 使用 actionlint、政策结构检查和本地组合入口验证 YAML、依赖、矩阵数量、Action SHA 与参数处理。此任务不 push 或触发远端运行。

### Task 11：实现周期检测与 CI 证据交接

- [ ] 编写 `.github/workflows/quality.yml` 的手动和待授权周期配置，固定默认分支执行、时间、检查集合与同类任务互斥规则。
- [ ] 修改 scale/thread-scale 入口，数据和报告输出到本次临时目录，禁止 CI 写回历史 qualification evidence。
- [ ] 实现品牌浏览器版本记录、依赖复扫和额外受支持 Node 版本的观察，声明它们的证明范围与不可比条件。
- [ ] 用 `export-evidence.mjs` 输出 S9 可消费的 CI 证据包，绑定默认分支真实 SHA、平台产物和未完成项，不写产品 qualification 状态。
- [ ] 校验 retention、新鲜度、脱敏及持久交接前提。过期、混合 SHA、错平台和未完成必需检查均不能形成可交接成功结果。

### Task 12：完成本地负向矩阵与资源基线

- [ ] 对下节 N01–N12 完成可本地执行的 fixture 与正反对照，在临时仓库中生成变更，不污染真实历史。真实取消、fork 权限和拒绝合并证据留至 Tasks 13/15，不以 fixture 勾选远端验收。
- [ ] 在同一资源等级上记录各检查冷/热安装耗时、磁盘峰值和命令退出码，验证符合 Spec 的超时限制。
- [ ] 对工具升级的性能比较使用相同政策/硬件并交错运行基线和候选。不可比时明确标记，不能报告无回归。
- [ ] 在干净 checkout 上执行 `npm run check`、tooling tests、完整本地 CI 入口和 strict docs validation，检查受跟踪文件未被测试改写。
- [ ] 复核 diff、任务范围和负向报告，按单元完成本地提交，列出所有尚未获得 GitHub 证据的项目。

### Task 13：在授权后验证真实 GitHub 行为

- [ ] 展示拟 push 的分支/提交、样例 PR、预期 Actions 资源和负向操作，取得对应授权。缺授权时保持本任务未完成。
- [ ] 在真实 Actions 上运行完整绿色对照，确认 Linux/macOS、最低 Node、三个浏览器和所有报告均属于本次 run/attempt。
- [ ] 在授权样例 PR 验证红色测试、上游失败、矩阵缺失、取消运行及 PR 更新导致旧 SHA 失效，不合并故意失败代码。
- [ ] 验证 fork/Dependabot 权限语义和无生产 Secret 路径。若真实入口当前不可用，记录未验证，不能以同仓库普通 PR 冒充。
- [ ] 在完整绿色正常 CI PR 经 Owner 审阅并明确授权合并后，将正常变更合入默认分支并验证 push 运行。样例失败 PR 不合并；schedule 在 Task 14 授权前不得随该变更意外启用。
- [ ] 保存 run/check URLs、tested SHA、实际权限、artifact IDs、报告摘要、失败结论和计费资源观测。清理远端样例需在已有授权内或另获授权。

### Task 14：在授权后启用周期检测

- [ ] 展示周期、默认分支、资源上限和检查内容，取得 schedule 启用授权；仅编写 YAML 不作为已授权启用依据。
- [ ] 在正式默认分支通过手动触发验证一次同样的质量任务，再启用已审阅时间配置。
- [ ] 核对周期 run 的触发来源、SHA、报告与历史 evidence 未被修改，保留一次真实周期触发证据。
- [ ] 验证周期失败不会自动合并、部署、生成生产资格或向外部渠道发消息。记录 GitHub 原生通知的责任边界。

### Task 15：在授权后启用服务端强制门禁

- [ ] 重新核查账户与仓库资格、当前规则及可写协作者。403 或权限不满足时记录 `enforcement_unavailable`，不请求公开仓库来绕过限制。
- [ ] 在 Owner 完成必要账户选择后展示准确 Ruleset 差异、required check 来源和回退方案，取得访问控制修改授权。
- [ ] 确认完整 `ci/required` 已实际出现且有效，再配置 Spec 第 10 节的主分支规则，避免锁死仓库。
- [ ] 验证首次初始化已结束，说明正常政策更新和经单独授权的规则维护路径；不得保留自动初始化或长期绕过入口。
- [ ] 回读并比较每项规则，核对最新组合、required check 来源、禁止强推/删除、讨论解决及无长期 bypass。
- [ ] 用授权样例确认失败 PR 无法合并、绿色对照满足条件；不实际合并或部署。不把 policy 文件或配置请求成功当服务端生效证据。

### Task 16：同步当前事实并交接未关闭项

- [ ] 按已实现行为更新 README 的安装/检查入口与 Architecture 的 CI 责任边界。若形成新的持久决策，在实施时按一事一 ADR 记录，不改写旧 ADR。
- [ ] 完成下方 CI-A01–CI-A14 映射，引用确切 SHA、命令、报告和远端证据。任务数或测试数变化时从当前结果重新计算。
- [ ] 明确交付是本地工具完成、工作流已运行还是 GitHub 强制门禁已生效，不把其中一个状态代替另外两个。
- [ ] 将真正独立且未关闭的未来工作按 document-governance 写入 Backlog；本 Plan 仍负责的未完成项留在本 Plan，不创建重复任务索引。
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
| N07 | 历史合成 Secret 提交后删除、未批准例外 | 扫描失败 | Task 8 的临时 Git 历史和脱敏结果 |
| N08 | Advisory 网络失败、空扫描、规则未加载 | infrastructure/工具失败 | Task 8 的故障注入报告 |
| N09 | 新增未导入代码、删测、降低同 PR baseline | coverage 失败 | Task 7 的分母、差异和基线报告 |
| N10 | 页面异常、关键按钮失效、缺翻译/无障碍阻断 | browser 失败 | Task 6 的引擎结果与脱敏诊断 |
| N11 | fork/Dependabot、恶意标题/分支参数 | 无越权、无 shell 注入，普通检查可运行 | Task 10 参数测试与 Task 13 权限证据 |
| N12 | 红色/绿色对照 PR、规则漂移 | 红色不可合并，绿色符合规则，漂移被回读发现 | Task 15 的规则与 mergeability 证据 |

## 验证入口

本次文档交付可以执行以下现有入口。

```sh
python3 -B /Users/triggerjames/.codex/skills/document-governance/scripts/validate_docs.py --strict .
npm run check:v0.2-coverage
git diff --check
```

该绝对路径只记录本机文档验证入口。Task 2 完成后，项目和 CI 的规范入口必须使用仓库固定副本。以下为待实现接口，实施时保持语义一致并写入 README。

```sh
npm run check
npm run check:ci-policy
npm run test:tooling
npm run ci:verify
python3 -B tools/document-governance/scripts/validate_docs.py --strict .
```

`check:ci-policy` 对应政策和结构检查，`test:tooling` 对应门禁自身的正反样例，`ci:verify` 在当前受支持平台执行本地完整入口并报告其他平台尚待执行。单机命令不能伪造 Linux/macOS 全矩阵通过，跨平台完成由真实报告集合证明。

## 验收映射

| Acceptance ID | 负责任务 | 必需证据 | 初始状态 |
| --- | --- | --- | --- |
| CI-A01 | Tasks 3、9、10 | 政策/schema、DAG/矩阵/测试归属正反测试 | 待实施 |
| CI-A02 | Tasks 1、2、4、13 | 干净 runner、原生读写、工具与 Pi 身份 | 待实施 |
| CI-A03 | Tasks 3、5、12、13 | 五个主 project 和 N02/N03 | 待实施 |
| CI-A04 | Tasks 4、5、12、13 | 同一归档安装、平台清单和 N06 | 待实施 |
| CI-A05 | Tasks 6、12、13 | 三引擎报告、三语/键盘/自动无障碍和 N10 | 待实施 |
| CI-A06 | Tasks 2、3、10、12 | 现有 checks、固定治理 validator 和 N01 | 待实施 |
| CI-A07 | Tasks 7、12 | 可比基线、增量报告和 N09 | 待实施 |
| CI-A08 | Tasks 8、12、13 | 三类安全扫描、例外与 N07/N08 | 待实施 |
| CI-A09 | Tasks 9、10、12、13 | needs+成员报告的严格判定和 N03–N05 | 待实施 |
| CI-A10 | Tasks 10、13 | 实际事件/SHA/权限和 N11 | 待实施 |
| CI-A11 | Tasks 13、15 | 有效账户资格、规则回读与 N12 | 待实施，存在外部前提 |
| CI-A12 | Tasks 11、14 | 周期 run、独立输出和 S9 交接格式验证 | 待实施，启用需授权 |
| CI-A13 | Tasks 12、13、15 | N01–N12 全部正反对照及实际门禁拒绝 | 待实施 |
| CI-A14 | Tasks 1、12、16 | 资源基线、复现入口、文档与完整交付记录 | 待实施 |

## 关闭检查清单

- [ ] CI-A01–CI-A14 均有对应当前实现证据，没有缺失矩阵或未授权动作被标成通过。
- [ ] 本地工具、GitHub workflow 与 GitHub 强制门禁分别验收。账户或权限仍阻塞时，不把本 Plan 标记全部完成。
- [ ] 所有负向验证场景被正确拒绝，正常对照通过，真实 GitHub 结果与汇总逻辑一致。
- [ ] README、Architecture 与已采用的操作文档只描述已实现事实；不存在未验证的 Runbook seal。
- [ ] S0 验收归属、S9 待完成事项、历史 evidence、Pi 边界和用户数据保持正确。
- [ ] 严格文档校验、项目检查、差异校验及适用测试通过，远端修改有独立授权和回读。
- [ ] 已合并、拒绝、被替代或另有明确关闭决定，剩余工作有唯一归属。
- [ ] 使用 document-governance 的 `archive_doc.py` 归档 Spec 和 Plan，随后重新执行 strict validation，不手动移动文件。
