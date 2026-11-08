## 结论摘要

按改动范围看，这是一次纯 CI 策略/脚本/工作流/文档改动，没有触碰模型请求组装。代码与作者的大部分说法一致；我没有发现高严重度的逻辑错误。下面按严重度列出我能读代码证实的问题和风险，并把「读代码证实」与「推测/未核实」分开。

---

## 发现

### 1. 严重度：中 — coverage 作业 60 分钟预算现在要装下六个项目，存在超时风险

- 文件:行：`ci/policy.json:96-110`、`.github/workflows/ci.yml:270-276`、`scripts/ci/run.mjs:392`、`scripts/ci/test.mjs:30-31`
- 问题：改动前 `test` 作业 90 分钟跑五个项目，`coverage` 作业 60 分钟跑四个带覆盖率的项目；合并后 `coverage` 仍是 60 分钟，却要在同一次作业里跑四个带覆盖率的项目 **加上** e2e、pi-compat。e2e/pi-compat 的预算从原来的 90 分钟降到与覆盖率共享的 60 分钟。
- 证据（读代码证实）：
  - `ci/policy.json`：`"timeoutMinutes": 60`（coverage）。
  - `scripts/ci/run.mjs:392`：`remainingBudgetMs: check.timeoutMinutes * 60_000 - (performance.now() - started)`。
  - `scripts/ci/test.mjs:30-31`：`const budgetMs = Math.min(check.timeoutMinutes * 60_000, remainingBudgetMs ?? Infinity);`。
- 推测/未核实：作者给的运行 42362797124 中 test 33.0 分钟、coverage 32.6 分钟。合并后耗时是否稳定低于 60 分钟，我没有运行数据，无法核实。ADR 0181 也写明要记录合并后第一次 VPS 运行的 coverage 耗时。
- 建议：把「合并后首个 VPS 运行 coverage 实测耗时」作为合并后必须核对项；如果接近 60 分钟，应在不改变「不调高测试超时」约束的前提下拆分或另出方案，而不是等它偶发超时。

### 2. 严重度：低 — `coverageFailed` 把 collectCoverage 和 compareCoverage 混在一起，个别组合下丢失 e2e/pi-compat 的真实退出码

- 文件:行：`scripts/ci/run.mjs:400-407`、`scripts/ci/run.mjs:409-414`
- 问题：`coverageFailed` 只要 `collectCoverage()` 或 `compareCoverage()` 任一 reject 就为 true。若只有 `compareCoverage` 失败（覆盖率测试本身通过），同时 e2e/pi-compat 进程非零，`runPlainProjects` 会因 `!coverageFailed` 为假而不设置 `result.status/exitCode`，最终可能是默认的 `infrastructure_failed`/`1`，而不是 e2e/pi-compat 的真实失败码。
- 证据（读代码证实）：
  ```js
  // run.mjs:400-407
  if (outcome.exitCode !== 0) {
    if (!coverageFailed) {
      result.status = "failed";
      result.exitCode = ...;
    }
    throw new Error(`CI_TEST_INCOMPLETE:${plainProjects.join(",")}`);
  }
  // run.mjs:409-414
  const coverageOutcomes = await Promise.allSettled([collectCoverage(), compareCoverage()]);
  ... runPlainProjects(coverageOutcomes.some((outcome) => outcome.status === "rejected"))
  ```
- 推测：`compareCoverage` 失败多属基础设施/策略比较问题，`infrastructure_failed` 的分类未必错，所以定为低。但它确实覆盖了 round-2 想区分的「覆盖率进程失败」与「比较失败」两种情况。
- 建议：只用 `collectCoverage()` 的 rejected 结果决定是否抑制 e2e/pi-compat 的退出码；`compareCoverage` 失败单独记录即可。

### 3. 严重度：低 — environment 测试没有真正证明宿主传入的 `HIMAWARI_REVIEW_GATEWAY` 会被清空

- 文件:行：`test/tooling/environment.test.mjs:29-50`
- 问题：新断言接受 `HIMAWARI_REVIEW_GATEWAY: ""`，但测试启动子进程时没有在宿主环境里设置一个非空值，所以它只证明了「配置里写死空字符串」，没有证明「宿主设成 magpie 时会被清空」。反向用例不够有力。
- 证据（读代码证实）：宿主 env 只设置了 `GITHUB_ACTIONS`、`GITHUB_SHA`、`GITHUB_FUTURE_CONTEXT`、`HIMAWARI_CI_PYTHON`（第 29-35 行）；断言第 44 行期望 `HIMAWARI_REVIEW_GATEWAY: ""`。
- 建议：在宿主 env 里设置 `HIMAWARI_REVIEW_GATEWAY: "magpie"`，再断言 tooling env 里为 `""`，这样才与「清空」的意图对应。

### 4. 严重度：低/信息 — 这次 PR 合并后，main 的 light 确认会退回 full CI

- 文件:行：`scripts/ci/context.mjs:130,142`、`scripts/ci/main-evidence.mjs:164`
- 问题：PR 运行时的 `context.policySha256` 来自 base（合并前 main 的九作业策略字节），而合并后 main 的 `ci/policy.json` 已变成七作业。`verifyGate` 要求 `context.policySha256 === hash(policy.bytes)`，因此这次合并的 main 确认会以 `MAIN_POLICY_MISMATCH` 退回 full CI。
- 证据（读代码证实）：
  ```js
  // context.mjs:130,142
  const source = resolvePolicySource({ root, base: baseSha });
  policySha256: source.policySha256,
  // main-evidence.mjs:164
  assert(context.policySha256 === hash(policy.bytes), "MAIN_POLICY_MISMATCH");
  ```
- 说明：退回 full CI 是安全兜底，不是错误；作者说 `main-confirm.mjs` 没有 test/node-floor 引用也属实。这里只是提醒「合并后第一次确认不会走 light」。
- 建议：无需改代码；如果希望这次合并也走 light，需要另行设计 policy 身份跨版本匹配，但会削弱身份绑定，不建议为省一次 full CI 去改。

### 5. 信息 — 退役作业名仍留在升级辅助函数里，是有意为之

- 文件:行：`scripts/ci/check-policy.mjs:39,44`
- 内容：`timeoutMinutesFor` / `hostedTimeoutMinutesFor` 仍包含 `"test"`、`"node-floor"`。这是为了让 `upgradeHostedRunnerPolicy` 能识别九作业旧策略（30 分钟 → 90 分钟）并在升级链中保留，属于必要残留，不是漏改。同理，历史文档和 qualification evidence 里的 test/node-floor 是历史记录，不应改写。

---

## 侧重检查

- **错误路径**：`run.mjs` 在覆盖率失败后仍执行 e2e/pi-compat；`AggregateError` 会同时保留两边失败（`run.mjs:409-421`，测试 `runner-orchestration.test.mjs:462-492`）。发现第 2 条的 `compareCoverage` 边界。
- **不合规范/不可信输入**：新增的 `upgradeRetiredTestChecks` 只接受与 2026-11-08 旧策略四项逐字段相同的 base（`check-policy.mjs:133-164`），否则原样返回交给 `validatePolicy` 拒绝；`canonicalJson` 对对象键排序，数组保持固定顺序，没有不可信输入进入命令。反向用例覆盖 test 项目数、node-floor 版本、macOS paused、required needs、coverage outputs/projects、required timeout、多余作业。
- **安全**：没有新增 secret 使用、没有放宽权限；工作流仍禁止 `${{ }}` 插进 shell、要求 action 全 SHA、checkout 不持久凭证（`check-policy.mjs:460-508`）。
- **资源耗尽**：第 1 条的 60 分钟共享预算；`runTests` 对每个项目按剩余预算设置子进程超时（`test.mjs:56-58,84`），超时会被显式报告而不是静默通过。
- **不可撤销操作**：本次改动没有新增删除/覆盖类操作；输出仍用 `wx`/`existsSync` 拒绝覆盖。
- **规则/文档一致性**：`README.md`、`docs/architecture-v0.1.md`、CI 设计文档、ADR 0181 与代码一致；`docs/execution/specs/2026-09-03...` 的 coverage 行已写明接手 e2e/pi-compat。历史文档中的 test/node-floor 属历史记录，保留合理。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会（读代码证实）。** 本次 diff 只涉及 `.github/workflows`、`ci/*`、`scripts/ci/*`、`scripts/package-node-runtime.mjs`、`test/tooling/*` 和文档；没有改 `packages/prompt-catalog`、`packages/runtime-pi`、`apps/agent-service`、出口遮盖或消息序列化。发给模型的内容仍然只在末尾追加，每轮会变的值仍然只能放在最后一条消息里；本次没有触碰 `.claude/rules/prompt-prefix.md` 的约束。`test/tooling/environment.test.mjs` 和 `vitest.workspace.ts` 是测试隔离，不是模型请求。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**不会影响模型请求；CI 侧新增序列化是确定的（读代码证实）。** `check-policy.mjs:87-92` 的 `canonicalJson` 对对象键排序；`retiredShapeChecks`、fixture、schema 都是静态数据，没有时间、随机数或无序集合遍历。新增的 `hosted-nine-jobs-5daedc92*.json` 是静态 fixture。因此不存在「同一段文字因前后文/时间/集合顺序变成不同字节」的问题；这与模型请求无关。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

**有测试，但实际红绿未核实（工具限制，未运行测试）。** 按代码推理：
- `runner-orchestration.test.mjs:462-476`：旧代码下 e2e/pi-compat 非零只会抛错、不设 `status/exitCode`，会得到 `infrastructure_failed`/`1`，而测试期望 `failed`/`3`，所以是有效反向用例。
- `policy.test.mjs:860-917` 的 3 条 round-2 反向用例（coverage 少输出、coverage 多项目、required 时限变化）：旧版 `upgradeRetiredTestChecks` 只核对 test/node-floor 和 required.needs，这些改动仍会被升级，`expect(upgradeRetiredTestChecks(value)).toBe(value)` 会失败，所以是有效反向用例。
- `environment.test.mjs`：旧断言要求 tooling env 里除 `GITHUB_*` 外没有键，而 `vitest.workspace.ts:13` 有 `HIMAWARI_REVIEW_GATEWAY: ""`，旧断言会失败；改成新断言后通过。
- 注意：「覆盖率进程和 e2e 都失败保留覆盖率退出码」这条在 round-2 之前也能通过（旧代码同样不覆盖覆盖率的状态），不是严格反向用例。
- 另外，`5daedc92` 全链路测试只断言 `checks` 和 `retentionDays` 等于现行策略，没有断言 `testProjects`/`registeredTests`；这不算错误，但覆盖范围比测试名听起来窄。

### 4. 每个改动产生的值，使用它的地方都能接受吗？

**逐项核对，未发现使用端校验冲突（读代码证实）。**

- **7 个作业 id**：`check-policy.mjs:31` 的 `jobIds`、`ci/policy.json`、`ci.yml`、`required.needs`、`aggregate.mjs:42-57`（从 policy 派生）、`local.mjs:27`、`main-evidence.mjs:150-152`（从 policy 派生）一致。除升级函数/历史文档/反向测试外，没有消费方仍要求 `test`/`node-floor`。
- **coverage 六个项目**：`run.mjs:314-315` 用 `coverageProjects` 拆成「四个带覆盖率 + e2e/pi-compat」；`test.mjs:54-55` 校验 selection 是 `check.projects` 子集；`aggregate.mjs:109` 用 `check.projects` 比对结果；`check-policy.mjs:280-288` 要求 coverage 项目等于 `mainProjects`（六个）；`coverage-model.mjs:33-40` 仍只约束 `ci/coverage-policy.json` 的四个；`check-coverage.mjs:71-74,350-410` 硬编码四个并核对文件清单。两端一致。
- **evidence schema 8/9**：`contracts.mjs:56-63` 的 `expectedMembers` 排除 `required` 和 paused = 8；所有成员排除 `required` = 9；`export-evidence.mjs:172-176` 只输出实际报告（活跃成员）；`evidence.test.mjs:166-171` 动态核对上下限。一致。
- **policy.schema minItems 7**：与 7 个作业一致。
- **Node 版本**：`package.json`、`package-lock.json` 根 `engines`、`package-node-runtime.mjs:278` 的 `nodeMinimum`、`install-tools.mjs:84-87,350,484`、`install-dependencies.mjs:289`、`check-policy.mjs:1135-1145` 都改为只接受 `22.22.3`；`ci/toolchain-lock.json` 删掉 `floor` 后没有残留消费方。`nodeMinimum` 只写入 `runtime-manifest.json`，没有其他校验读取它，不存在两端不一致。
- **`timeoutMinutesFor` 里的退役 id**：是升级链识别旧策略所需，属有意保留。
- **结论**：没有发现「生产出的 id/字段/清单项在某个使用端校验不过」的情况。
