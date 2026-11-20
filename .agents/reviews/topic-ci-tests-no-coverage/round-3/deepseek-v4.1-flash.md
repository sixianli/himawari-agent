CLAIM|1|一致|120fdd939:ci/policy.json:110|`coverage` 作业要跑六个测试项目|`"projects": ["unit", "contracts", "tooling", "integration", "e2e", "pi-compat"],`
CLAIM|2|一致|scripts/ci/coverage-model.mjs:33|其中 unit、contracts、tooling、integration 四个带覆盖率统计|`export const coverageProjects = ["unit", "contracts", "tooling", "integration"];`
CLAIM|3|一致|120fdd939:ci/policy.json:99|而且要先等 `policy` 作业|`"needs": ["policy", "build"],`
CLAIM|4|一致|120fdd939:ci/policy.json:20|而 policy 里又重复跑了一遍 tooling 测试（仓库脚本自己的测试）|`"projects": ["tooling"],`
CLAIM|5|一致|docs/adr/0266-ci-policy-static-security-run-on-the-oracle-arm-machine.md:56|ADR 0266 已经把 policy、static、security 搬到 Oracle 的 ARM 机器上|1. policy、static、security 三项检查的 `runs-on` 和策略里的 runner 都改成 `ci-arm`；build、browser、coverage 和汇总作业仍在 CI 服务器上，因为后几项要用 x64 的构建产物。
CLAIM|6|一致|120fdd939:ci/policy.json:42|每项检查都要等 policy|`"needs": ["policy"],`
CLAIM|7|一致|120fdd939:ci/policy.json:99|coverage 还要等 build|`"needs": ["policy", "build"],`
CLAIM|8|一致|120fdd939:ci/policy.json:25|static、build、security 各自的 `"needs": ["policy"],`|`"needs": ["policy"],`
CLAIM|9|一致|120fdd939:ci/policy.json:42|static、build、security 各自的 `"needs": ["policy"],`|`"needs": ["policy"],`
CLAIM|10|一致|120fdd939:ci/policy.json:115|static、build、security 各自的 `"needs": ["policy"],`|`"needs": ["policy"],`
CLAIM|11|一致|120fdd939:ci/policy.json:20|policy 作业原来跑 tooling 测试|`"projects": ["tooling"],`
CLAIM|12|一致|120fdd939:ci/policy.json:110|coverage 作业也跑|`"projects": ["unit", "contracts", "tooling", "integration", "e2e", "pi-compat"],`
CLAIM|13|一致|120fdd939:scripts/ci/check-policy.mjs:50|`scripts/ci/check-policy.mjs` 里 coverage 的必选项目，原话 `const mainProjects = ["unit", "contracts", "integration", "e2e", "pi-compat", "tooling"];`|`const mainProjects = ["unit", "contracts", "integration", "e2e", "pi-compat", "tooling"];`
CLAIM|14|一致|.agents/evidence/ci-test-timing-2026-11-13.md:14|tooling 里 3 个复核脚本的测试占了 tooling 文件耗时的约 81%|tooling 里最大的三个文件：`opencode-review.test.mjs` 417 秒、`opencode-review-merge-gate.test.mjs` 364 秒、`review-gateway.test.mjs` 222 秒，合计 1003 秒，约占 tooling 的 81%。
CLAIM|15|一致|.agents/evidence/ci-test-timing-2026-11-13.md:14|原话“合计 1003 秒，约占 tooling 的 81%”|tooling 里最大的三个文件：`opencode-review.test.mjs` 417 秒、`opencode-review-merge-gate.test.mjs` 364 秒、`review-gateway.test.mjs` 222 秒，合计 1003 秒，约占 tooling 的 81%。
CLAIM|16|一致|.agents/evidence/ci-test-timing-2026-11-13.md:1|这是云端容器上的实测|# 各测试项目的耗时（2026-11-13，云端容器，Node 22.23.4，不带覆盖率插桩）
CLAIM|17|一致|.agents/evidence/ci-test-timing-2026-11-13.md:1|不是 CI 机器上的数字|# 各测试项目的耗时（2026-11-13，云端容器，Node 22.23.4，不带覆盖率插桩）
CLAIM|18|一致|vitest.workspace.ts:22|统计覆盖率时，测试在 v8 的覆盖率收集下运行|`provider: "v8",`
CLAIM|19|一致|vitest.workspace.ts:25|再生成 JSON 和 LCOV 报告|`reporter: ["json", "lcov", "text-summary"],`
CLAIM|20|一致|scripts/ci/coverage-model.mjs:520|并和基线比较|`for (const [group, baseline] of Object.entries(comparison?.groups ?? policy.baseline.groups)) {`
CLAIM|21|一致|120fdd939:scripts/ci/run.mjs:341|来源：本 PR 之前的 `scripts/ci/run.mjs`，原话 `"--coverage",`|`"--coverage",`
CLAIM|22|一致|120fdd939:scripts/ci/run.mjs:330|以及 `collectCoverage()`、`compareCoverage()` 两步|`const collectCoverage = async () => {`
CLAIM|23|一致|120fdd939:scripts/ci/run.mjs:372|以及 `collectCoverage()`、`compareCoverage()` 两步|`const compareCoverage = async () => {`
CLAIM|24|一致|scripts/ci/run.mjs:336|第 336–337 行，原话 `const measuredProjects = measure ? coverageProjects : [];`|`const measuredProjects = measure ? coverageProjects : [];`
CLAIM|25|一致|scripts/ci/run.mjs:337|第 336–337 行，原话 `const plainProjects = check.projects.filter((id) => !measuredProjects.includes(id));`|`const plainProjects = check.projects.filter((id) => !measuredProjects.includes(id));`
CLAIM|26|一致|scripts/ci/run.mjs:414|不统计覆盖率时，测试照样全部运行|`projects: plainProjects,`
CLAIM|27|一致|scripts/ci/run.mjs:429|失败照样让作业失败|`throw new Error(\`CI_TEST_INCOMPLETE:${plainProjects.join(",")}\`);`
CLAIM|28|一致|test/tooling/policy.test.mjs:1252|`test/tooling/policy.test.mjs` 里名字带 `[ADR-0267]` 的用例|`it("[ADR-0267] 基准上 coverage 作业带全部测试的七作业策略升级成 tests 加 Oracle 上的 tooling", () => {`
CLAIM|29|一致|test/tooling/policy.test.mjs:1257|旧 7 作业策略升级成 tests 加 tooling|`expect(upgradeCoverageToTests(accepted)).toEqual(policy);`
CLAIM|30|一致|test/tooling/policy.test.mjs:1309|只升级完整的旧写法|`expect(upgradeCoverageToTests(value)).toBe(value);`
CLAIM|31|一致|test/tooling/policy.test.mjs:1281|少 integration、少 LCOV 输出、coverage 放到 ARM、required 不等 coverage 的照样被拒|`"coverage 少 integration",`
CLAIM|32|一致|test/tooling/policy.test.mjs:1287|少 integration、少 LCOV 输出、coverage 放到 ARM、required 不等 coverage 的照样被拒|`"coverage 少 lcov 输出",`
CLAIM|33|一致|test/tooling/policy.test.mjs:1293|少 integration、少 LCOV 输出、coverage 放到 ARM、required 不等 coverage 的照样被拒|`"coverage 放到 ci-arm",`
CLAIM|34|一致|test/tooling/policy.test.mjs:1299|少 integration、少 LCOV 输出、coverage 放到 ARM、required 不等 coverage 的照样被拒|`"required 没等 coverage",`
CLAIM|35|一致|test/tooling/policy.test.mjs:1315|反向：policy 重新带上 tooling、tests 带上 tooling、tooling 回到 CI 服务器，策略都被拒|`expect(() => validatePolicy(withTooling)).toThrow("Incomplete project selection: policy");`
CLAIM|36|一致|test/tooling/policy.test.mjs:1318|反向：policy 重新带上 tooling、tests 带上 tooling、tooling 回到 CI 服务器，策略都被拒|`expect(() => validatePolicy(testsWithTooling)).toThrow("Incomplete project selection: tests");`
CLAIM|37|一致|test/tooling/policy.test.mjs:1323|反向：policy 重新带上 tooling、tests 带上 tooling、tooling 回到 CI 服务器，策略都被拒|`expect(() => validatePolicy(toolingOnVps)).toThrow("Incorrect platform: tooling/default");`
CLAIM|38|一致|test/tooling/runner-orchestration.test.mjs:388|`test/tooling/runner-orchestration.test.mjs` 覆盖 tests 不统计覆盖率时照样跑全部项目|`expect(result.projects.map(({ id }) => id)).toEqual([`
CLAIM|39|一致|test/tooling/runner-orchestration.test.mjs:406|`--coverage` 给别的值报错|`await expect(run(checkId, { coverage })).rejects.toThrow("CI_COVERAGE_OPTION_INVALID");`
CLAIM|40|一致|test/tooling/runner-orchestration.test.mjs:381|tooling 作业只跑 tooling|`expect(result.projects.map((entry) => entry.id)).toEqual(["tooling"]);`

背景与“本 PR 之前”的说法按 120fdd939（PR 起点）核对，“本 PR 之后”按 HEAD 核对。第 6 条前提（CI 机器上 tests 不统计覆盖率时的真实时长）没有日志可查，未能核实；决定与后果里的夜间 03:00 定时、报告呈现等属于计划或预测，Andy 原话和 vitest 第三方 issue 属于外部信息，均未按仓库现状核对。
