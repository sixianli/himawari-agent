# 复核结论（PR 318：草稿 PR 只跑快检查）

## 读代码证实的核心事实

- diff 共触及 5 个文件：`.github/workflows/ci.yml`、`scripts/ci/check-policy.mjs`、`test/tooling/policy.test.mjs`、新增 `docs/adr/0190-...md`、`docs/execution/specs/2026-09-03-...design.md`。与作者描述一致。
- 并发组表达式（ci.yml:25）与 check-policy.mjs:384-392 的期望逐字符一致；`browser`/`coverage` 的 `if`（ci.yml:194、273）与 `githubExpression(DRAFT_SKIP_CONDITION)`（check-policy.mjs:102 定义 `githubExpression = (e) => \`${{ ${e} }}\``，check-policy.mjs:27-28、438-442）逐字符一致。
- 事件语义推演（基于表达式求值规则，读 ci.yml:24-26）：
  - `synchronize`/`opened`/`reopened`/`ready_for_review`：组为 `CI-pull_request-<N>--`（push 段、edited 段均为空），互相取消——`ready_for_review` 会取消在跑的草稿运行，与 ADR 决定 3 一致。
  - `edited`：组为 `CI-pull_request-<N>--<run_id>`，组唯一，既不取消别人也不被取消（包括后续 edited）——与作者说法一致。
  - 非草稿 PR 的 `edited`：`draft != true` 为真 → browser/coverage 照跑；草稿 PR 的 `edited` → 跳过。`workflow_call`/`workflow_dispatch`：`event_name != 'pull_request'` 短路为真 → 完整运行。均正确。
- 跳过导致 `ci/required` 失败：required 带 `always()`（ci.yml:381），aggregate.mjs:49-54 `if (needs[id]?.result !== "success") fail(...)`，skipped 上游必失败；该行为有既有测试 aggregate.test.mjs:131-146（含 `"skipped"` 用例，断言 status 为 failed）。
- 草稿运行不进 main 证据：main-evidence.mjs:96 查询 `status=success`，:101-103 要求 `r.status === "completed" && r.conclusion === "success"`。证实。
- 反向用例逐一推演（policy.test.mjs:456-475 + 530-534 的 harness）：「other condition on coverage」不等于期望条件 → 440 行断言抛错；「draft condition on policy」走 443 行 `assert(job.if === undefined)` 抛错；「missing draft condition on browser」`undefined === 表达式` 不成立抛错。三个用例都会真失败。
- 正向夹具已同步新表达式（policy.test.mjs:94-105、120-126），332 行断言通过。

## 问题（按严重度）

1. **中 | docs/adr/0190-draft-pull-requests-run-fast-checks-only.md:69（后果节）** — ADR 声称「Auto-fix 会把它当作失败事件发给线程，线程应忽略草稿上由此产生的 ci/required 失败」。证据：在本仓库 `*.ts` 中 grep `ci/required` 与 `auto-?fix` 均无结果；「忽略草稿失败」的逻辑在本仓库既无实现也无测试。该承诺落在仓库外组件上，文档与代码之间不可核验。建议：在 ADR 中标注该行为依赖哪个外部组件及其验收位置，或补一条端到端测试/契约。
2. **低 | .github/workflows/ci.yml:25** — edited 运行的组含 `run_id`，组永远唯一，因此**连续多次 edited 之间也互不取消**，标题连改几次会叠加多轮完整 CI 挤占 2 个 runner。ADR 决定 4 只说「自己也不会被后来的推送取消」，未明说后续 edited 也不取消前者；后果节「偶尔会多出一轮」表述偏轻。这是有意取舍的放大面，建议在 ADR 中写明上限观察方式（已有「以排队时间观察」，勉强覆盖，故只算低）。
3. **低 | test/tooling/policy.test.mjs:402-533** — 反向用例没有覆盖「并发组删掉 edited 段」这一最可能的回归（`fake concurrency tokens` 只覆盖粗粒度错配）。缓解：CI 的 policy 作业会对真实 ci.yml 跑 `validateWorkflow`（check-policy.mjs:1252-1255），真实改动会被拦住；仅单测层面缺一格。
4. **低 | 未核实** — 「Hermes 上 822 个测试通过、真实 ci.yml 通过 policy 检查」无法在本环境运行验证。但我已手工比对 ci.yml:25/194/273/381 与 check-policy.mjs:384-396/435/440 的全部期望字符串，结构上一致，该说法可信。

## 侧重检查（普通使用流程走查）

流程：开草稿 PR → push（synchronize）→ policy/static/build/security 运行，browser/coverage 因 if 跳过 → required（always()）运行 → aggregate 因 skipped 上游判失败 → `ci/required` 红（有意）→ 转 ready → ready_for_review 运行（同组取消草稿运行）→ 完整 CI → main-evidence 只认 success，草稿红运行不污染 main 证据。
- 有测试覆盖：夹具正向（policy.test.mjs:332）、3 个反向用例（:456-475）、aggregate 拒绝 skipped 上游（aggregate.test.mjs:140-146）、check-policy 硬规则在 CI policy 作业对真实 ci.yml 生效（check-policy.mjs:1253）。
- 无测试覆盖的路径：① 单测不直接对真实 `.github/workflows/ci.yml` 跑 `validateWorkflow`（只靠 CI 作业兜底）；② 「线程忽略草稿 ci/required 失败」（仓库外，见问题 1）；③ `ready_for_review` 载荷中 `draft=false` 依赖 GitHub 语义，离线无法核实（属标准行为，标注为未核实）。

## 必答问题

1. **不改变请求开头。** diff 只触及 CI 工作流、CI 脚本、测试、文档；没有任何 prompt、工具定义、历史消息或遮盖逻辑被改动，无「发给模型的内容」参与。读 diff 证实。
2. **不会产生跨请求字节差异。** 新值（并发组字符串、if 条件）由 GitHub Actions 运行时求值，不进入模型请求；check-policy 输出为确定性 JSON（`canonicalJson` 已有既有排序）。无时间戳、无依赖前后文的遮盖、无无序集合新增。
3. **有自动检查，反向用例会真失败。** check-policy.mjs:438-443 精确断言 if、:384-396 精确断言并发组，且在 CI policy 作业对真实文件执行；policy.test.mjs 三个新反向用例逐一推演均命中抛错断言；aggregate 的 skipped 拒绝有既有用例。缺口见问题 3。
4. **逐值核对通过（一处例外）。** ① 并发组表达式：产生于 ci.yml:25，消费于 GitHub 并发匹配、check-policy:384-396、test 夹具 ：94-105，三端一致；② `DRAFT_SKIP_CONDITION`：check-policy:26-28 ↔ ci.yml:194/273 ↔ test:120-126，一致；③ 跳过的下游消费：aggregate.mjs:49（拒绝，有测试）、main-evidence.mjs:96-103（排除，读代码证实）、GitHub 合并检查显示红（有意）；④ 例外：ADR 对「Auto-fix/线程忽略草稿失败」的约定在仓库内无产生方和使用方（问题 1），未核实。
