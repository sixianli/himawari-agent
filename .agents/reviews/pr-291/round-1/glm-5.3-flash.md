# 复核报告：PR 291（去掉 node-floor，把 test 并进 coverage）

## 发现的问题（按严重度从高到低）

**1. 中危（运行风险，「推测+计算」，非代码缺陷）**
- 文件：`.github/workflows/ci.yml:276`、`scripts/ci/run.mjs:403-411`、`docs/adr/0181-…md:78`
- 问题：coverage 作业时限 60 分钟，但作业现在要**顺序完成**覆盖率统计 + e2e + pi-compat。旧 test 作业整段 33.0 分钟（含安装、下载），旧 coverage 32.6 分钟，合计超过 60 分钟。若 e2e/pi-compat 段在去掉安装开销后剩不到 ~27 分钟，新 coverage 作业会超时，`ci/required` 变红。
- 证据：`ci.yml` 的 coverage `timeout-minutes: 60`；`run.mjs:404-405` 先 `await Promise.allSettled([collectCoverage, compareCoverage])`，**之后**才 `await Promise.allSettled([runPlainProjects()])`，`run.mjs:392` 用剩余预算传给 `runTests`；`test.mjs:30-31` 超出即 `CI_TEST_CHECK_TIMEOUT`。作者自己声明的约束就是保持 60 分钟（未调超时，这点代码属实）。
- 建议：合并后首跑记录 coverage 实际耗时（ADR 已写此待办）。若超预算，调时限需要新的 ADR（本次明确不动）。

**2. 低危（代码与 ADR/作者说法不一致，实际利用面很窄）**
- 文件：`scripts/ci/check-policy.mjs:125-150`（`upgradeRetiredTestChecks`）
- 问题：ADR 0181:59 与作者说法称「`test`、`node-floor` 两项**和 `coverage`、`required` 的相关字段**都和 main 逐字段完全一样」才升级。代码实际只核对了：① 作业 id 集合，② 两个退役作业逐字段（`canonicalJson`），③ `required.needs`。**coverage 的字段（如 outputs）没有逐字段核对**。`validatePolicy`（`check-policy.mjs:254`）对 `outputs` 只查唯一性，不锁定内容：一个把 coverage `outputs` 改弱（如去掉 `lcov`/`artifact`）的九作业基线会通过升级+校验，aggregate 的「输出种类齐全」检查（`aggregate.mjs:152-154`）就少两道闸。
- 缓解（读代码证实）：基线来自目标分支提交（`resolvePolicySource` 用 `git show baseSha:ci/policy.json`），PR 改不了；这种基线只能先经既有 PR 门槛进 main，因此当下没有直接利用路径。但「任何字段不同都原样返回」的说法与代码不符。
- 建议：把 `retiredTestChecks` 相核对的集合扩到 coverage/required 的完整 canonical 形状，或在 `validatePolicy` 钉住 coverage 的 outputs。

**3. 低危（误导性错误信息）**
- 文件：`scripts/ci/check-policy.mjs:185`
- 问题：`"Policy must declare exactly nine required jobs"` — 现在期望的是 7 个作业，报错文案没改。
- 建议：改为 seven；顺带 `check-policy.mjs:39,44` 的 `timeoutMinutesFor`/`hostedTimeoutMinutesFor` 仍含 `"test"/"node-floor"`——核实这是**故意保留**（`upgradeHostedRunnerPolicy` 要识别含这些作业的 30 分钟托管基线才能升成 90/60，`retiredTestChecks` 才能匹配 90），建议加一行注释防误删。

**4. 信息项（已接受的后果，核对属实）**
- unit/contracts/integration 失去单独 JUnit（`aggregate.mjs` 只要求 policy 声明的 outputs，coverage 声明为 `["json","lcov","artifact"]`，e2e/pi-compat 的 junit 作为额外 kind 在白名单 `security-redaction.mjs:107` 中允许，不会被拒）。与 ADR 0181:79 一致。

## 侧重检查（测试覆盖、文档一致性；普通流程走查）

走查流程：PR → `policy` 作业（`run.mjs checkId=policy` → `check-policy.mjs main()`，校验提案 policy + 升级后的基线 policy + ci.yml + `vitest.workspace.ts` + 测试归属/卫生）→ `coverage` 作业（ci.yml:270 下载 Linux 构建归档 → `run.mjs coverage`：源码快照 → 四项目带覆盖率 Vitest → e2e+pi-compat（`runTests`，`--retry 0` 见 test.mjs:74、跑完核归档摘要 test.mjs:131-134）→ `check-coverage.mjs --mode` 覆盖率门禁）→ `required`/`aggregate`。这条链上每步都有测试锚到**真实** `ci/policy.json`/`ci.yml`（`aggregate.test.mjs:13,127`、`ci-optimization.test.mjs:70-73`、`policy.test.mjs:846-920`、`runner-orchestration.test.mjs:429-527,695-702`、`evidence.test.mjs:161-172`、`toolchain-lifecycle.test.mjs:277`、`quality-local.test.mjs:672-674`）。反向用例（改一项的旧基线升级该拒绝、九作业 ci.yml 多一个作业被拒、coverage 缺 e2e/pi-compat 被拒、覆盖率失败仍跑 e2e 后合并报告）都用 `toThrow`/状态断言钉住；未实际执行测试（本环境禁止）。「未核实到」的唯一路径：`compareCoverage` 的真实 remeasure 分支（隔离 checkout 重测，runner-orchestration 里是 mock，属既有状况，非本次引入）。文档（README、architecture、设计文档、ADR 0181、evidence/policy schema）与代码逐条对过，除第 2 条外一致；`main-confirm.mjs` 本就不引用 test/node-floor，`package-node-runtime.mjs` 的 `nodeMinimum` 全仓仅生产、无消费方，`prepare-runtime-tools.py:66` 固定 `v22.22.3`（证实作者「生产只接受 22.22.3」）。

## 必答问题逐答

1. **请求开头**：不影响。整个 diff 只动 CI 配置、脚本、表格格式文档，无任何 apps/packages 运行时或提示词代码；「只追加」规则（.claude/rules/prompt-prefix.md:35）没有被碰到的面。（读代码证实）
2. **字节确定性**：不受影响。新增的 `canonicalJson`（check-policy.mjs:87）只用于同进程内策略比较；没有新增时间字段或顺序敏感清单；coverage projects 沿用原数组顺序追加。（读代码证实）
3. **自动检查**：有且反例钉了 throw（见侧重检查清单）。结构上确认反例会失败；未实际运行。（读代码证实断言、未执行）
4. **值的两端核对**：`engines.node`、policy 7 作业、schema 7/8/9、`--projects`、`nodeMinimum`、toolchain-floor 全删、`local.mjs` 检查列表、`CI_CHECK_UNSUPPORTED`、junit kind 白名单均已找到生产端与消费端且一致；例外即第 2、3 条所列两个低危点。

作者四条说法的核对结论：第 1 条（文件集合核对分工）属实——`runTests` 对 e2e/pi-compat 逐文件核对（test.mjs:103-121），四项目清单由 `check-coverage.mjs verifyTestRun`（check-coverage.mjs:361-409）核对；第 2 条不完全属实（见第 2 条发现）；第 3 条基本属实（残余引用皆为升级功能所需或历史记录）；第 4 条（时长数据）未核实，第 1 条发现表明总时长风险是本次最需要盯的实测点。
