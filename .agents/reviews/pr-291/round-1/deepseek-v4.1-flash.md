# 复核结论（对照 34843f52..336ff040）

## 读代码证实的问题

### 1. 中：e2e/pi-compat 测试失败会被记成 `infrastructure_failed`，并丢掉真实退出码
- 文件:行：`scripts/ci/run.mjs:110-111`、`scripts/ci/run.mjs:381-401`
- 问题：`runPlainProjects` 在 `runTests` 返回非零时只 `throw`，没有像被删掉的 `test` 分支那样先写 `result.status = "failed"` / `result.exitCode`。外层 `catch`（`run.mjs:493-497`）只追加 `details.failures`，不改状态，所以只有 e2e/pi 失败时 `result.json` 仍是初始的 `infrastructure_failed`、`exitCode: 1`。
- 证据：
  - `run.mjs:110-111`：`status: "infrastructure_failed", exitCode: 1,`
  - `run.mjs:400-401`：`if (outcome.exitCode !== 0) throw new Error(\`CI_TEST_INCOMPLETE:${plainProjects.join(",")}\`);`
  - 被删的旧 `test` 分支在 `git diff` 里明确有：`result.status = "failed"; result.exitCode = ...; throw new Error("CI_PIPELINE_FAILED:...")`。
  - 现有反向测试没有覆盖这条路径：`test/tooling/runner-orchestration.test.mjs:197-216` 的 `runTests` mock 返回 `exitCode: state.pipelineExitCode`，而覆盖率相关用例从未把 `pipelineExitCode` 设为非零（只在 `:671` 给 `build` 用）。
- 建议：在 `runPlainProjects` 的 `outcome.exitCode !== 0` 分支先设置 `result.status = "failed"` 和 `result.exitCode`（非零时用真实值），再抛出；补一个 e2e/pi 返回 7 的用例，断言 `status === "failed"` 且 `exitCode === 7`。门禁结果本身不会因此误放行，但失败分类和保留的退出码会错。

### 2. 低：`upgradeRetiredTestChecks` 的守卫比 ADR 说的窄，“逐字段相同”不成立
- 文件:行：`scripts/ci/check-policy.mjs:125-149`；说法在 `docs/adr/0181-drop-node-floor-and-fold-test-into-coverage.md:59`
- 问题：ADR 说目标分支策略只有 `test`、`node-floor` 和 `coverage`、`required` 的相关字段都与 2026-11-08 的 main 逐字段相同才升级。代码只核对了：作业 id 集合、`test`/`node-floor` 整对象、`required.needs`；`coverage` 只在函数体里用 `sameSet(check.projects, coverageProjects)` 决定是否追加 e2e/pi，并没有作为升级条件；`coverage.outputs` 等字段完全不比较（`validatePolicy` 也只校验 `outputs` 无重复，不校验取值）。
- 证据：
  - `check-policy.mjs:128-140`：`sameSet(checks.map(...), [...jobIds, ...retiredIds]) && retiredTestChecks.every(...) && sameSet(required.needs, ...)`
  - `check-policy.mjs:144-147`：`if (check.id === "coverage" && sameSet(check.projects, coverageProjects)) check.projects = [...]`
  - `check-policy.mjs:252-255` 只对 `needs`/`timeoutMinutes`/`projects` 做了固定值校验，对 `outputs` 只 `unique(check.outputs, ...)`。
- 影响：该函数跑在目标分支（`createContext` 的 `parents[0]`）上，攻击者在 PR 里改不了目标分支，所以这不是直接的 PR 绕过；但“逐字段相同”的描述与代码不一致，且 `coverage.outputs` 这类字段确实带不出校验。建议按整对象 `canonicalJson` 比对 `coverage`/`required`（或对除已知迁移字段外的完整策略做比对），并补一个 `coverage.outputs` 漂移的反向用例。顺带说明：`outputs` 取值本来就没有被 `validatePolicy` 钉住（既有问题，非本 PR 引入）。

### 3. 低：升级链的真实历史组合没有测试，真正会走到它的地方是覆盖率比较
- 文件:行：`test/tooling/policy.test.mjs:690-711`、`:757-778`、`:798-845`
- 问题：托管/hermes 的正向测试都用 `clone()`（现在是新的 7 作业策略），所以实际只测了“新策略的 runner 迁移”；模拟旧 9 作业的 `retiredTestPolicy` 用的是 `ci-vps` 形态。真正会把 `resolvePolicySource` 跑到旧策略上的路径是 `scripts/ci/coverage-comparison.mjs:63` 的 `createContext({root: checkout, base: baseline.sourceSha})`，而当前覆盖率基线 `ci/coverage-policy.json:22` 的 `sourceSha = 5daedc92...`，它的策略是“托管 9 作业 + 未暂停 macOS + 30/7 保留期”。我读了这个提交的 `ci/policy.json`，按 `upgradeHostedRunnerPolicy → upgradeRunnerLabel → upgradeArtifactRetention → upgradeRetiredTestChecks` 的顺序推演应能升级成功，但没有任何测试直接覆盖这个组合。
- 建议：用 `git show 5daedc92ff1dddda3917f8e956b9439cb239caef:ci/policy.json` 的形状做 fixture，断言 `resolvePolicySource`/`createContext` 得到当前 7 作业策略；否则以后调整升级顺序或某一层条件时，只有等到真正改覆盖率策略触发比较才会炸。

### 4. 低：有几处文字与代码不一致
- `scripts/ci/check-policy.mjs:185`：错误信息仍是 `"Policy must declare exactly nine required jobs"`，实际是 7 个。
- `docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:318`：本次编辑了该行，但仍写 `build/test/node-floor/browser 30 分钟`；`ci/policy.json` 里 build/browser 是 90 分钟（`:41`、`:65`），test/node-floor 已删除。
- 建议：改成“七个”并顺手把该行时限改成 90/60（或明确标注是历史初值）。

## 推测 / 未核实
- **60 分钟 job 时限可能不够（推测）**：`ci.yml:276` 仍是 60 分钟，`run.mjs:403-406` 是先等覆盖率采集/比较全部结束，再串行跑 e2e/pi；`run.mjs:392` 的剩余预算会随之减少。若 e2e/pi 耗时较大，或触发 `compareCoverage`（覆盖率策略变更时才触发）时比较/安装/构建耗时高，job 可能在 e2e/pi 前被 GitHub 杀掉，此时 `runPlainProjects` 会因剩余预算 ≤0 直接抛 `CI_TEST_CHECK_TIMEOUT`，并不会“照样跑”。作者只给了 coverage 32.6 分钟和原 test 33.0 分钟，没有给 e2e/pi 的单独耗时；ADR 也承认要等合并后的完整运行才有数据。这属于风险，不是已证实缺陷。
- **Hermes 上 tooling 1984 通过 / 7 个 `npm test` 失败与 base 复现**：仓库里看不到运行日志，未核实。
- **`.claude/rules/prompt-prefix.md`**：不在当前稀疏检出中，原文未核实；下面关于提示前缀的结论只基于本 diff 的代码范围。
- 当前是 sparse checkout（91% 文件存在），`.agents/reviews/**` 等文件不在工作区，未逐条核对。

## 侧重检查
- **错误路径**：覆盖采集失败时，`Promise.allSettled` 保证 e2e/pi 仍会跑（`run.mjs:403-406`）；但 e2e/pi 自身失败时的状态/退出码有上面第 1 条问题；覆盖率和 e2e/pi 同时失败时 `AggregateError` 会带上两条原因（`run.mjs:407-412`）。e2e/pi 失败时 `coverage-policy` 会被跳过，覆盖率阈值/文件清单不会在本 job 里再核验，但门禁仍因状态失败而拒绝。
- **不合规范/不可信输入**：`runTests` 新增 `--projects` 校验（`test.mjs:54-55`），空选择、缺失选择、越界 id 都抛 `CI_TEST_PROJECT_SELECTION_INVALID`，且 `parseArguments` 拒绝重复/非法参数；升级函数只读目标分支的完整 SHA（`check-policy.mjs:1052-1059`），PR 无法控制目标分支内容。
- **安全**：本 diff 没有引入新 secret、网络出口或 shell 插值；`publish`/`security-redaction` 的 kind 白名单包含 `junit`（`security-redaction.mjs:107`），e2e/pi 新增的 JUnit 报告能被接收。
- **资源耗尽**：覆盖率 job 现在把覆盖率（可能还有 baseline 比较）和 e2e/pi 串行塞进同一个 60 分钟预算；`runTests` 还会把归档再复制一份到 `.ci-output/.../tests/`（只用于运行，不进 `result.reports`），有额外磁盘占用。未见无界循环或无限重试。
- **不可撤销操作**：新增逻辑只做复制、`mkdir`（非递归，`test.mjs:26-27`）和写 `tests/` 报告；`check-coverage --mode measure` 仍只在 `status === "passed"` 时写基线（`check-coverage.mjs:583-599`）。未发现新增危险删除/覆盖。
- **规则/文档一致性**：ADR 0181、README、架构文档、CI 设计文档已更新到位；剩余不一致见第 4 条，以及 `docs/execution/plans/2026-08-26-...`、`docs/execution/specs/2026-08-26-...` 等日期性文档仍写 `>=22.19.0`（视为历史资料则无需改）。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？
不会。`git diff --name-status` 只涉及 `.github/workflows/ci.yml`、`ci/*`、`scripts/ci/*`、`scripts/package-node-runtime.mjs`、`package*.json`、测试和文档；没有 `apps/`、`packages/` 里构造系统提示、工具定义、历史消息或遮盖逻辑的代码。发给模型的内容仍然只在末尾追加，每轮变化的值没有进入本条 diff 覆盖的模型输入路径。附带确认：`pi-compat`（含 `packages/runtime-pi/test/prompt-prefix.compat.test.ts`）和 `integration`（含 I-82 提到的请求体/请求头用例）仍分别在 coverage 作业的六项目里执行。依据规则文档本身未在当前检出，未核实原文。

### 2. 会不会让同一段文字在不同请求里变成不同字节？
不会影响模型请求。CI 侧新增的 `canonicalJson`（`check-policy.mjs:87-92`）只用 `localeCompare` 对 ASCII 对象键排序来做两段策略的相等比较，不参与任何序列化输出；没有新增带时间的模型字段、无序集合或依赖前后文的遮盖。原有的非确定性（如 `readReportEnvelopes` 的文件遍历顺序）未被本 PR 改变。

### 3. 有没有对应的自动检查，反向用例真的会失败？
大部分有：
- 策略/升级：`policy.test.mjs:846-919` 有正向升级和 5 个反向变异（test 项目、node-floor 版本、macOS 未暂停、required 缺 node-floor、多一个作业），另有“现行七作业原样返回”“工作流多 test/node-floor 被拒”“coverage 缺 e2e/pi 被拒”。
- 运行器：`runner-orchestration.test.mjs` 校验覆盖率命令只带四个 `--project`（`:523-526`）、覆盖率进程失败时 e2e/pi 照跑（`:431-461`）；`pipeline.test.mjs:318-336` 覆盖空/缺失/越界 `--projects` 和只跑选中项目。
- schema/证据：`evidence.test.mjs:164-172` 把 `checks` 上下限和策略活跃/总成员数绑定；`aggregate.test.mjs` 的期望数改成 8；`ci-optimization.test.mjs:73` 校验 7 个作业；`toolchain-lifecycle.test.mjs:276-286` 拒绝 22.19.0；`quality-local.test.mjs:675-676` 拒绝 `test`/`node-floor`。
- 缺口：e2e/pi 非零退出时的状态/退出码没有反向用例（见问题 1）；旧“托管 9 作业 / hermes 9 作业 + test/node-floor”的组合没有用例（见问题 3），因此“升级链组合被改坏”不会被现有测试发现。

### 4. 每个改动值，所有使用方都能接受吗？
逐个核对结果：
- `engines.node >=22.22.3`：`package-lock.json` 根 `engines` 已同步；README 和 `prepare-runtime-tools.py` 的 `v22.22.3` 一致；CI 各作业 `CI_NODE`/`matrix.node` 均为 22.22.3。接受。
- 删除 `node.floor`：`install-tools.mjs` 的 `fields(lock.node, [...])` 和 `fields(lock.node.releases, [baseline])` 已改成精确集合；`install-dependencies.mjs`、`check-policy.validateToolchain` 都只接受 baseline；仓库内已无 `lock.node.floor` 使用方（grep 确认）。接受。
- 作业数 9→7：`ci/policy.schema.json` 下限 7，`validatePolicy` 的 `jobIds` 精确集合、`required.needs`、`ci.yml` 的 jobs、`ci-optimization.test.mjs` 的 7 一致。接受。
- evidence `checks` 8/9：`expectedMembers`（排除 required、排除暂停的 build macOS）= 8，非 required 全部成员 = 9；真实运行 8 条 envelope，测试把上下限和这两个数绑定。接受。
- `coverage.projects` 四→六：`run.mjs:314-315` 按 `coverageProjects` 拆成四+二；`check-coverage.mjs:72-74`、`:361-363` 仍只核对四个（`ci/coverage-policy.json` 未变）；`aggregate.mjs:109` 按六项目比对；`local.mjs`、`test.mjs` 和测试同步。接受。
- `package-node-runtime.mjs` 的 `nodeMinimum: "22.22.3"`：仓库里没有校验旧值 22.19 的使用方（grep `nodeMinimum` 仅在生成侧）；与交付脚本一致。接受。
- 唯一需要保留的保留意见：`coverage.outputs` 等 `outputs` 取值本身不被 `validatePolicy` 钉住（既有问题），所以升级函数“逐字段”声明无法从代码得到支持（见问题 2）。
