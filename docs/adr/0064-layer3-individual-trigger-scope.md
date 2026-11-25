---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-21"
covers: "ci/policy.json, scripts/ci/check-policy.mjs"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0064：只在检查阶段运行的 CI 脚本改动不再单独触发完整第 3 层

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

[ADR 0057](0057-batch-layers-one-two-for-small-defects.md) 沿用 ADR 0056 的规则：改动碰到“测试运行器本身（Vitest 配置、`scripts/ci/`、`ci/policy.json`）”时，第 3 层（构建加完整 `npm test`）要对这一个改动单独跑一次。2026-10-21 的 R2-H1（测试卫生门禁，[ADR 0063](0063-test-value-gate-speed-budget-hygiene.md)）只改了 `scripts/ci/check-policy.mjs`、它的测试、样本和一个基线 JSON，没有改任何产品代码，却因为这条规则在 Hermes 上多跑了 30–60 分钟的完整第 3 层。用户问“这次改了业务代码了吗？为什么要跑这么多测试？”，并同意把规则细化（G151）。

`scripts/ci/` 下的脚本分两类：一类决定测试怎么被执行（`local.mjs`、`run.mjs`、`test.mjs`、`execute.mjs`、`test-concurrency.mjs`、`build.mjs`、`install-*.mjs`、`vitest.workspace.ts`、`ci/policy.json`），改它们会改变每个测试的运行方式，完整跑一遍才知道有没有弄坏；另一类只在检查阶段运行、不参与测试执行（`check-policy.mjs`、`check-coverage.mjs`、`check-security.mjs`、`quality.mjs`、`quality-policy.mjs`、`main-*.mjs`、`security-*.mjs`、`coverage-*.mjs`、`publish.mjs`、`aggregate.mjs`、`export-evidence.mjs`、`redact-text.mjs` 等），它们的影响面是 `local.mjs` 里对应的那一个检查步骤和 tooling 测试项目。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **完整第 3 层单独触发的范围缩小到“改变测试执行方式”的改动。** 仍然单独跑完整第 3 层的：SQLite 结构或迁移、Agent 与 Worker 之间的协议、认证或握手、构建或打包配置、依赖清单或锁文件、以及测试运行器本身——`vitest.workspace.ts`、`ci/policy.json`、`scripts/ci/` 里的 `local.mjs`、`run.mjs`、`test.mjs`、`execute.mjs`、`test-concurrency.mjs`、`build.mjs`、`install-tools.mjs`、`install-dependencies.mjs`、`install-gate-dependencies.mjs`、`context.mjs`、`contracts.mjs`。
2. **只在检查阶段运行的 `scripts/ci/` 脚本，单独跑的替代品是“对应的检查步骤加整个 tooling 项目”。** 在测试主机上对该改动跑 `node scripts/ci/local.mjs --check <该脚本所属的检查，例如 policy、coverage、security>` 和 `vitest run --project tooling` 整组；两者都通过即可提交。完整第 3 层照 ADR 0057 的批次规则在一批的最终版本上跑一次，不因这类改动提前。
3. **拿不准归哪类时按第 1 条办。** 判断依据只有一个：这个脚本是否参与决定测试怎样被收集、启动、并发或判定。把判断写进提交说明。
4. **其余规则不变。** ADR 0057 的全部决定（第 1–2 层按批、主机、账号、磁盘、时限）照旧。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

### 方案 A：保持“改 `scripts/ci/` 就单独跑完整第 3 层”（原规则，未采用）

- 好处：规则一句话，不用判断。
- 代价：每次改一个检查脚本都多跑 30–60 分钟且占用唯一的测试主机，而多跑的几百个产品测试和改动无关。

### 方案 B：按脚本是否参与测试执行分两类（采用）

- 好处：检查脚本的改动只跑真正受影响的部分（对应检查步骤加 tooling 项目），完整第 3 层仍在批末跑一次。
- 代价：多一个判断；用第 3 条的单一依据和提交说明里的记录来控制。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 正面：检查脚本类改动的验证时间从约一小时降到十分钟以内；测试主机更快空出来给下一批。
- 负面：如果把一个实际影响测试执行的脚本误判为“只在检查阶段运行”，问题会推迟到批末的完整第 3 层才暴露；第 3 条要求把判断写进提交说明，审核时核对。
- 后续：`AGENTS.md` 的第 3 层一条改为引用本 ADR；ADR 0057 加一行指向本 ADR 的说明，内容不改。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- 用户原话：.agents/tasks/round2-tool-execution/goal.md 的 G151。
- 被细化的规则：[ADR 0057](0057-batch-layers-one-two-for-small-defects.md)（保持有效）。
- 触发本决定的改动：[ADR 0063](0063-test-value-gate-speed-budget-hygiene.md) 的测试卫生门禁（R2-H1）。
