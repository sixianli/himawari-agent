## 结论

方向可行，但按这版直接实施会卡在 3 个硬阻塞上：`ci/policy.schema.json` 仍要求 9 个作业、`check-policy` 仍用 4 个覆盖率项目校验、旧基准升级链会被 timeout 名单改动破坏。另有 2 处检查会被静默削弱：JUnit/逐项目报告、coverage 分支的归档摘要复核。

## 一、已证实的问题（按严重度）

### 1.【高】`ci/policy.schema.json` 的 `checks.minItems` 还是 9

证据：`ci/policy.schema.json:104` 是 `"minItems": 9`；`check-policy.mjs:119` 在任何新逻辑之前先执行 `validateRecord("CheckPolicy", policy)`。把 `jobIds` 改成 7 个后，`ci/policy.json` 会直接 schema 失败，方案里的升级函数、coverage 改造都不会执行。

建议：同步改为 7（或按最终作业数），并在 `test/tooling/policy.test.mjs` 加一条“实际 policy 的作业数能通过 schema”的用例。

### 2.【高】`validatePolicy` 仍要求 coverage 恰好是 4 个项目，和方案里的 6 个项目冲突

证据：`check-policy.mjs:204-213` 的 `requiredProjects` 对 coverage 取 `coverageProjects`；`coverage-model.mjs:33` 的 `coverageProjects` 固定为 `["unit","contracts","tooling","integration"]`。方案把 `ci/policy.json` 的 coverage `projects` 改成 6 个，会在 `check-policy.mjs:213` 报 `Incomplete project selection: coverage`。

建议把两个概念拆开并改名：

- `coverageMeasurementProjects`：仍为 4 个，只用于覆盖率采集和 `ci/coverage-policy.json`；
- `coverageJobProjects`：6 个，用于 `ci/policy.json` 的 coverage 作业、`aggregate` 的 project 集合和 `run.mjs` 的结果汇总。

`check-policy` 的 coverage `requiredProjects` 应改为 6 个，不能继续直接复用 `coverageProjects`。

### 3.【高】删 `test`/`node-floor` 时一并删 timeout 名单，会破坏已有的旧基准升级链

证据：`upgradeHostedRunnerPolicy` 和 `upgradeRunnerLabel` 用 `hostedTimeoutMinutesFor` / `timeoutMinutesFor` 识别旧 policy（`check-policy.mjs:57-76`、`:78-95`），`resolvePolicySource` 在 `:1021` 按这个顺序升级基准 policy。现有测试 `test/tooling/policy.test.mjs:691-798` 明确要求 hosted/hermes 的 9 作业旧 policy 能被升级。若从这两个函数删掉 `test`/`node-floor`，旧 policy 的 timeout 不再匹配，升级函数原样返回，随后 `validatePolicy` 按新 7 作业拒绝，基于旧 main 的 PR 或 push 会失败。

另外两个配套问题：

- 新的 fold 函数必须放在现有升级链**最外层**，即 `upgradeFold(...upgradeRunnerLabel(upgradeHostedRunnerPolicy(...)))`，否则旧 runner 形状先被 fold 看到会不匹配；`check-policy.mjs:1021` 的顺序要明确写进方案和测试。
- 现有旧基准迁移还包括 coverage 3 个项目、integration 预算等（`check-policy.mjs:1027-1044`）。fold 只认“当前 main 的 9 作业形状”时，更老的基准会卡住；而 `resolvePolicySource` 的旧 coverage 迁移是在 `validatePolicy` **之后**才把 coverage 设为 4 个，无法喂给 fold。应把迁移统一成一条在 `validatePolicy` 之前执行的 pipeline，并让所有路径最终都产出 6 个 coverage 项目。

建议：保留 `timeoutMinutesFor` / `hostedTimeoutMinutesFor` 里的 `test`、`node-floor` 条目（它们只影响旧 policy 识别，不影响新 policy 校验）；只从 `jobIds`、`expectedNeeds`、`required.needs`、`ci.yml`、`run.mjs` 分支和 `chromiumChecks` 删除。

### 4.【高】`test` 作业独有的证据没有补齐：JUnit、逐项目 JSON、归档摘要

证据：

- `ci/policy.json:84` 的 test `outputs` 是 `["json","junit","artifact"]`；coverage 是 `:149` 的 `["json","lcov","artifact"]`。
- `scripts/ci/test.mjs:58-77` 每个项目都生成 `--reporter=junit`，`:124` 把它写进报告；`run.mjs:210-224` 的 coverage 调用只有 `--reporter=json`，`:333-335` 也只写 JSON。
- `aggregate.mjs:154-156` 只检查 `check.outputs` 里声明的 kind。因为 coverage `outputs` 没有 `junit`，删掉 test 后不会有人失败，JUnit 会静默消失。
- `test.mjs:128-132` 在所有项目跑完后再次核对 `archive` 和 `artifact` 的摘要；`run.mjs:273-313` 的 coverage 分支只在开始时 `verifyArtifact` 并核对复制摘要，测试结束后没有再次核对。

建议：

- 明确决定是否保留 JUnit。若保留，把 `junit` 加进 coverage 的 `outputs`，在 coverage 调用和 e2e/pi-compat 调用都生成 JUnit；这样 `aggregate` 会强制要求它。
- 在 coverage 四项目调用结束后，对 `retained` 归档再做一次 `fileSha256` 比对，失败用类似 `CI_TEST_ARCHIVE_CHANGED` 的错误码。
- 逐项目 JSON/JUnit 只有 test 作业有；coverage 现在是一个合并报告。若逐项目证据是门禁要求，方案必须明确补上，否则就是降低证据粒度。

### 5.【中】删除 `lock.node.floor` 漏了 `install-dependencies.mjs`，且 `[baseline, floor].includes` 会因 `undefined` 误通过

证据：`install-tools.mjs:353`、`:487` 和 `install-dependencies.mjs:291-294` 都写的是：

```js
[lock.node.baseline, lock.node.floor].includes(installation.node)
```

删除 `floor` 后变成 `[baseline, undefined].includes(x)`。如果 `installation.json` 损坏、`installation.node` 缺失，`x === undefined` 会返回 `true`，检查被绕过。方案只提到 `validateToolchain` 和 `install-tools.mjs`，没有提 `install-dependencies.mjs`。

建议：全部改成显式校验 `typeof value === "string" && value === lock.node.baseline`，不要用数组 `includes`；同时更新 `validateToolchainLock` 的 `fields` 列表和 `test/tooling/toolchain-lifecycle.test.mjs:277-286` 的 floor 安装测试。

### 6.【中】把 `runTests` 接进 coverage 分支时有报告/目录冲突风险

证据：`test.mjs:26` 用 `mkdir(destination, { recursive: false })` 创建输出目录，`:38-39` 写 `context.json`，`:136-140` 写 `tests.json` 和 artifact 报告。coverage 分支自己也在 `directory` 下写 `context.json`、`tests.json`（`run.mjs:290-304`），并已在 `result.artifacts` 记录 consumed artifact（`run.mjs:281-286`）。如果 `runTests` 的 `output` 直接用 `directory`，会目录已存在或文件重复；如果直接把 `runTests` 的 `reports`/`artifacts` 合并，`aggregate.mjs:141-153` 会报重复 report path，`:157-172` 会报重复 artifact identity。

建议：方案里明确 `runTests` 的输出放在 `directory/tests-extra` 一类的子目录，合并时只取 JSON/JUnit/计数，artifact 只保留 coverage 分支自己那一条；同时把 `runTests` 的 `exitCode !== 0` 显式转成 coverage 的 failed 状态。

### 7.【中】只对 `source.policy` 跑测试清单检查，proposed 的新 6 项目归属不会被清单检查

证据：`check-policy.mjs:1168` 校验 proposed 的 `validatePolicy`，`:1181-1182` 校验两端 `validateVitestProjects`，但 `:1192` 的 `validateTestInventory` 只对 `source.policy` 执行。方案把 coverage 从 4 个项目改成 6 个项目，proposed 的 project 归属没有经过“所有测试文件恰好一个 owner”的检查。

建议：至少对本次改动同时执行 `validateTestInventory(proposed, files, ...)`；否则以后有人在 proposed 里把测试项目改窄，policy 作业仍可能放行。

### 8.【中】`npm test` 改成 `local.mjs --check coverage` 改变了本地语义

证据：`local.mjs:27` 当前允许 `test`；`:70-83` 会先 build 再跑 test/coverage；`README.md:67` 说 `npm test` 依次跑 unit、contracts、integration、e2e、pi-compat。改成 coverage 后，本地“跑全部测试”会附带覆盖率阈值、基线比较，可能触发 `coverage-comparison.mjs` 的历史 clone/fetch（`coverage-comparison.mjs:41-58`），还可能要求本地已有 Chromium。

建议：把本地 `test` 保留成一个只跑六个项目、不采集覆盖率的 local-only 模式（可以由 `local.mjs` 直接调用重构后的 `runTests`），另加 `npm run test:coverage`。如果坚持 `npm test` = coverage，至少要在 README 写明它现在依赖覆盖率基线和浏览器。

### 9.【中】文档和元数据遗漏

已证实仍写着旧值或旧作业集合的地方：

- `README.md:19-21` 最低 Node 22.19；`:41` “双平台 build/test、最低 Node”；`:67` 的五项目 `npm test`；`:69` 的 coverage 四项目描述。
- `docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:200-203` 的 test/node-floor 行、`:217` 的 coverage 四项目、`:320` 的 test/node-floor 超时。
- `docs/architecture-v0.1.md:158,613` 的 Node 22.19 / 最低 Node。
- `scripts/ci/local.mjs:104-109` 的 pending 中仍有 “Linux Node floor”。
- `package-lock.json:28-30` 的根 `engines.node` 仍是 `>=22.19.0`。
- `scripts/package-node-runtime.mjs:278` 生成的 `runtime-manifest.json` 仍写 `nodeMinimum: "22.19.0"`。
- 测试侧：`test/tooling/quality-local.test.mjs:571-601`（期望调用 test、pending 含 floor）、`test/tooling/runner-orchestration.test.mjs:493-518`（test/coverage 项目数）、`test/tooling/toolchain-lifecycle.test.mjs:277-286`（floor 安装）、`test/tooling/aggregate.test.mjs:16`（floor fixture）、`test/tooling/pipeline.test.mjs:327-340`（5 个项目/JUnit）、`test/tooling/gate-lifecycle.test.mjs:126-143`（test 5 项目 mock）都会受影响。方案只写了“`policy.test.mjs` 等”，范围明显不够。

`docs/adr/0171-two-runners-on-hermes.md:31` 和 `docs/adr/0174-...md:86` 是历史 ADR，可不动，但新 ADR 应说明它们描述的 9 作业是历史状态。

## 二、推测/未核实

1. **fold 的“精确旧形状”可能不覆盖全部字段（推测，需确认）**：方案说“test 和 node-floor 的字段与现在 main 完全一样”，但没说要连 `testProjects`、`registeredTests` 一起冻结。`workflow_dispatch` 的 base 来自用户输入（`context.mjs:127-130` 只校验 SHA 格式，不做祖先/分支校验），`resolvePolicySource` 会读取该提交的 policy（`check-policy.mjs:1004-1026`）。如果只比对作业字段，恶意 base 可以把测试项目改窄或把测试登记成 qualification，而 `validateTestInventory` 只对 source policy 跑（`check-policy.mjs:1192`），不一定能兜住。建议把整个旧 policy 的规范化快照（或哈希）作为 fold 的输入条件，并加一条“改 testProjects/registeredTests 不升级”的反向用例。
2. **60 分钟是否够（推测）**：test 作业 33.0 分钟包含 unit/contracts/integration/e2e/pi-compat，coverage 32.6 分钟包含 unit/contracts/tooling/integration。简单相加不能推出“e2e+pi-compat 5 分钟以内”；而且 integration 在 coverage 里是 2 worker、test 里是 3 worker。建议从 run 42362797124 的逐项目耗时算增量，或暂时保留 90 分钟。
3. **JUnit 是否有下游消费者（未发现代码消费者）**：仓库内没有代码读取 JUnit；但 policy 输出和文档把它当公开证据。是否允许删掉需要 Owner 明确决定，不能默认“聚合不报错就等于没问题”。
4. **`npm ci` 是否会因 `package-lock.json` 的 engines 与 package.json 不一致而失败（未核实）**：即使不失败，lockfile 的根 `engines` 也应同步，否则 `npm install` 与 lockfile 表达的约束不一致。
5. **提高 engines 对 Mac 开发的影响（确定但需决策）**：Pi 只要求 `>=22.19.0`（`docs/archive/plans/2026-08-25-agent-foundation-plan.md:90`），提到 `>=22.22.3` 是主动收窄支持范围；使用 Node 22.19–22.21 的开发机会无法安装。生产/Hermes 固定 22.22.3 支持这个收窄，但应把它写成一条明确的兼容性决定，而不是顺手改。

## 三、侧重检查

我按错误路径、不可信输入、安全、资源耗尽和文档一致性检查了以下路径：

- **错误路径**：`install-tools.mjs:353,487` 与 `install-dependencies.mjs:291-294` 的 `undefined` 匹配问题；`runCheck` 的 `AggregateError`/`CI_INCOMPLETE_EXECUTION`（`run.mjs:384-390,479-485`）；`runTests` 的 `exitCode` 与计数矛盾（`test.mjs:99-100,128-135`）；coverage copy/verify 摘要（`run.mjs:273-313`）。
- **不可信输入**：`createContext` 的 base SHA 只在 `context.mjs:84-87` 校验格式；`resolvePolicySource` 从任意 base 读取 policy（`check-policy.mjs:993-1055`）；`parseArguments`、`existingInside`、workflow shell 插值检查（`check-policy.mjs:389-403`）。
- **安全**：删除 test/node-floor 本身不新增 secret/权限；`required` 仍由 `aggregate` 检查每个上游 `success`（`aggregate.mjs:43-59`）。但 JUnit/逐项目报告和归档摘要的丢失是门禁证据的实质减少；`[baseline, floor].includes` 的 `undefined` 是明确的输入校验漏洞。
- **资源耗尽**：coverage 合并后 60 分钟上限、integration 2 worker、`runTests` 的 `remainingBudgetMs`（`test.mjs:29-30,55-56`）；没有新增无界循环或无限重试。
- **不可撤销操作**：本改动不涉及删除数据、发布或生产操作；主要是 CI policy/workflow 的不可逆合并，需靠 PR 审查和完整 CI 验证。
- **规则/文档一致性**：`prompt-prefix` 规则不涉及本改动；但 README、Spec、Architecture、local pending、lockfile、runtime manifest 均存在旧值，见上。
- **业界对照**：GitHub Actions 的 `needs` 只是依赖声明，删 job 必须同步 `required.needs`（[官方文档](https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/using-jobs-in-a-workflow)）；Vitest 的 coverage include/exclude 控制报告范围而不是测试选择（[官方文档](https://vitest.dev/guide/coverage)）；npm `engines` 是安装约束，不是运行时强制（[官方文档](https://docs.npmjs.com/cli/v10/configuring-npm/package-json#engines)）。

## 四、如果由我来定，我会怎样改

1. **先做最小安全改动**：只删 `node-floor`，保留 `test` 作业，`engines` 提到 `>=22.22.3`。这样直接省掉约 39.9 分钟，不改变测试证据；如果还要省 test 的 33 分钟，再走下面的合并方案。
2. **合并时保留 test 的语义**：
   - coverage 作业跑 4 个测量项目 + e2e/pi-compat 两个测试项目；
   - 4 项目调用补 `--retry 0`、文件集合核对、结束后归档摘要复核；
   - e2e/pi-compat 用重构后的 `runTests`，输出放子目录，避免 `tests.json`/`context.json` 和 artifact 记录冲突；
   - 若保留 JUnit，coverage `outputs` 加 `junit`，否则明确记录“JUnit 证据取消”并由 Owner 决定。
3. **policy 形状一次改全**：
   - `jobIds` 7、`ci/policy.schema.json` `minItems` 7；
   - coverage `projects` 6，但 `coverageMeasurementProjects` 保持 4；
   - `required.needs` 6；
   - 保留 `timeoutMinutesFor`/`hostedTimeoutMinutesFor` 里的旧 ID，只用于旧 policy 升级识别。
4. **升级函数做成一条可测试的迁移 pipeline**：
   - 放在现有 hosted/hermes/retention 升级之后；
   - 对旧 policy 做整份规范化比对（包含 `testProjects`、`registeredTests`、`outputs`、`needs`），不是只比 9 个作业；
   - 把旧 coverage 3/4 项目统一迁到 6；
   - 加测试：当前旧形状升级、hosted/hermes 链式升级、改任意一个字段不升级、已是 7 作业的新形状原样通过。
5. **清理 floor 的所有消费者**：`validateToolchainLock`、`validateToolchain`、`install-tools` 三处、`install-dependencies`、toolchain 测试；`[baseline, floor].includes` 全部改成严格相等。
6. **同步元数据和文档**：`package-lock.json`、`package-node-runtime.mjs` 的 `nodeMinimum`、README 19-21/41/67/69、Spec 200-203/217/320、Architecture 158/613、`local.mjs` pending。建议再加一条自动检查：`package.json` 的 `engines.node` 必须等于 `>=${lock.node.baseline}`，`nodeMinimum` 也必须等于 `lock.node.baseline`，防止三处漂移。
7. **本地命令与 CI 解耦**：`npm test` 继续跑六个测试项目但不采集覆盖率；覆盖率单独 `npm run test:coverage`。这样本地不会因为覆盖率基线或历史 clone 而失败。
8. **验证顺序**：`npm run test:tooling -- --base <main>`、`npm run check`、`npm run build`，再在 VPS 上跑完整 7 作业 CI；`npm run check` 本身不跑 tooling 测试（`README.md:55`），不能替代 tooling 测试。

## 五、必答问题

### 1. 会不会改变模型已经见过的请求开头？

不会。这个改动只涉及 `.github/workflows/ci.yml`、`ci/`、`scripts/ci/`、文档和 `package.json`，不进入 `packages/runtime-pi`、`packages/prompt-catalog`、`apps/agent-service` 的请求组装路径；没有新增系统提示、工具定义、历史消息或遮盖逻辑。发给模型的内容仍然只在末尾追加；每轮会变的值仍然只应放在最后一条消息里。`npm run check` 里的 `check:prompt-prefix` 照常覆盖这一点。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

不会涉及模型请求字节。CI 侧需要注意的只有集合顺序：新的 `jobIds`、`required.needs`、`coverage.projects` 要用字面量固定数组，不要依赖 `Set` 或对象键遍历；`policySha256` 仍按 base policy 的原始字节计算（`check-policy.mjs:1054`），fold 不改它。CI 报告里已有的 `durationMs`、`measuredAt` 等时间字段与本改动无关。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

部分有，但方案列的验证不够，且有几条会“因为别的原因失败”：

- “旧形状能升级、改一个字段不升级”方向对，但要断言升级函数**返回原对象**，并覆盖 `coverage.projects`、`required.needs`、`testProjects`、`registeredTests`，不能只测 test/node-floor 的字段。
- “ci.yml 多出 test/node-floor 被拒”现有 `validateWorkflow` 的 “unknown job” 用例已经覆盖，不算新增保护。
- “coverage 缺 e2e/pi-compat 被拒”只有在 `check-policy` 的 `requiredProjects` 改成 6 后才有意义；否则会因旧的四项目断言失败，测试通过的原因不对。
- “文件集合少一个文件时 coverage 失败”方向对；还应加“重复文件/不期望文件”和“coverage 结束后归档被改”的反向用例。
- 缺少：`ci/policy.schema.json` 作业数、`required.needs`、`testProjects` 变更、JUnit 输出、7 作业新形状原样通过、hosted/hermes/legacy 链式升级、`install-dependencies` 的 `undefined`、`package-lock`/`nodeMinimum` 一致性。
- `npm run check` 不运行 tooling 测试（`README.md:55`），所以必须保留 `npm run test:tooling`，不能只靠 `npm run check`。

### 4. 改动产生/修改的每个值，两端都能接受吗？

| 值 | 产生处 | 使用处 | 结论 |
| --- | --- | --- | --- |
| `jobIds` 7 个 | `check-policy.mjs:31-41` | `validatePolicy`、`expectedNeeds`、`required.needs`、`ci.yml`、测试、文档 | 方案未提 `ci/policy.schema.json:104` 的 `minItems: 9`，会先失败 |
| coverage `projects` 6 个 | `ci/policy.json` | `check-policy.mjs:204-213`、`run.mjs` coverage、`aggregate.mjs:108-121`、`local.mjs`、测试 | `check-policy` 仍用 `coverageProjects` 4 个，必须拆成“测量 4 / 作业 6” |
| coverage `outputs` | `ci/policy.json:149` | `aggregate.mjs:154-156`、`publish.mjs:79-109`、测试 | 若不加 `junit`，JUnit 会静默消失；若加，coverage 分支必须真的生成 |
| `node.floor` | `ci/toolchain-lock.json:5` | `check-policy.mjs:1060,1070`、`install-tools.mjs:84,90,353,487`、`install-dependencies.mjs:292`、`toolchain-lifecycle.test.mjs:277`、`aggregate.test.mjs:16` | 删除要全部清理；`[baseline, floor].includes` 会产生 `undefined` 误通过 |
| `engines.node` | `package.json:8` | npm 安装、`package-lock.json:28-30`、README/Spec/Architecture、`package-node-runtime.mjs:278` | 三处会漂移；建议加“engines == lock baseline == nodeMinimum”的检查 |
| local check/pending | `local.mjs:27,104-109` | `quality-local.test.mjs:571-601` | 删 test 的同时要改 pending 和测试；`npm test` 语义要明确 |
| 文档 | README/Spec/Architecture | 人工阅读和后续维护 | 方案只列了部分行，`README:41,67,69`、Spec `:217,320`、local pending 仍会不一致 |

**一句话结论**：这个方案的核心思路（去掉 22.19 专用作业、由 coverage 复用同一构建）成立，但不能按当前版本实施。先修 schema 9、coverage 4/6 概念、旧 policy 升级链这三处硬阻塞，再决定 JUnit/逐项目证据和本地 `npm test` 的语义；否则会出现“政策校验先失败”或“CI 变绿但证据和完整性检查变少”两种结果。
