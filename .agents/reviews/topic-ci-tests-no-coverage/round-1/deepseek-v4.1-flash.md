CLAIM|1|一致|120fdd939:ci/policy.json:110|`coverage` 作业跑大部分测试|`"projects": ["unit", "contracts", "tooling", "integration", "e2e", "pi-compat"],`
CLAIM|2|一致|120fdd939:scripts/ci/run.mjs:341|`coverage` 作业同时统计每行代码有没有被测试走到|`"--coverage",`
CLAIM|3|找不到|-|`coverage` 作业一个作业独占约 52 分钟|-
CLAIM|4|找不到|-|`coverage` 作业是每个 PR 从推送到出结论的最长一段|-
CLAIM|5|一致|120fdd939:ci/policy.json:99|它要先等 `policy` 作业|`"needs": ["policy", "build"],`
CLAIM|6|一致|120fdd939:ci/policy.json:20；120fdd939:scripts/ci/run.mjs:247|policy 里又重复跑了一遍 tooling 测试|`"projects": ["tooling"],`；`await vitest(check.projects);`
CLAIM|7|一致|ci/policy.json:13,31,138|ADR 0266 已经把 policy、static、security 搬到 Oracle 的 ARM 机器上|`"runner": "ci-arm",`
CLAIM|8|一致|120fdd939:ci/policy.json:25,42,66,99,115,132|每项检查都要等 policy|`"needs": ["policy"],`；`"needs": ["build"],`
CLAIM|9|一致|120fdd939:ci/policy.json:99|coverage 还要等 build|`"needs": ["policy", "build"],`
CLAIM|10|一致|120fdd939:ci/policy.json:99|本 PR 之前的 `ci/policy.json` 里 coverage 一项，原话 `"needs": ["policy", "build"],`|`"needs": ["policy", "build"],`
CLAIM|11|一致|120fdd939:ci/policy.json:25,42,115|static、build、security 各自的 `"needs": ["policy"],`|`"needs": ["policy"],`
CLAIM|12|一致|120fdd939:ci/policy.json:20；120fdd939:scripts/ci/run.mjs:247|policy 作业原来跑 tooling 测试|`"projects": ["tooling"],`；`await vitest(check.projects);`
CLAIM|13|一致|120fdd939:ci/policy.json:110|coverage 作业也跑 tooling 测试|`"projects": ["unit", "contracts", "tooling", "integration", "e2e", "pi-compat"],`
CLAIM|14|一致|120fdd939:ci/policy.json:20|本 PR 之前的 `ci/policy.json` 里 policy 一项，原话 `"projects": ["tooling"],`|`"projects": ["tooling"],`
CLAIM|15|一致|120fdd939:scripts/ci/check-policy.mjs:50|`scripts/ci/check-policy.mjs` 里 coverage 的必选项目，原话 `const mainProjects = ["unit", "contracts", "integration", "e2e", "pi-compat", "tooling"];`|const mainProjects = ["unit", "contracts", "integration", "e2e", "pi-compat", "tooling"];
CLAIM|16|一致|.agents/evidence/ci-test-timing-2026-11-13.md:14|tooling 里 3 个复核脚本的测试占了 tooling 文件耗时的约 81%|tooling 里最大的三个文件：`opencode-review.test.mjs` 417 秒、`opencode-review-merge-gate.test.mjs` 364 秒、`review-gateway.test.mjs` 222 秒，合计 1003 秒，约占 tooling 的 81%。
CLAIM|17|一致|.agents/evidence/ci-test-timing-2026-11-13.md:14|原话“合计 1003 秒，约占 tooling 的 81%”|tooling 里最大的三个文件：`opencode-review.test.mjs` 417 秒、`opencode-review-merge-gate.test.mjs` 364 秒、`review-gateway.test.mjs` 222 秒，合计 1003 秒，约占 tooling 的 81%。
CLAIM|18|一致|.agents/evidence/ci-test-timing-2026-11-13.md:1|这是云端容器上的实测，不是 CI 机器上的数字|# 各测试项目的耗时（2026-11-13，云端容器，Node 22.23.4，不带覆盖率插桩）
CLAIM|19|一致|vitest.workspace.ts:22|统计覆盖率时，测试在 v8 的覆盖率收集下运行|provider: "v8",
CLAIM|20|一致|vitest.workspace.ts:25|再生成 JSON 和 LCOV 报告|reporter: ["json", "lcov", "text-summary"],
CLAIM|21|一致|120fdd939:scripts/ci/run.mjs:379|并和基线比较|const prepared = await prepareCoverageComparison({
CLAIM|22|一致|120fdd939:scripts/ci/run.mjs:341|本 PR 之前的 `scripts/ci/run.mjs`，原话 `"--coverage",`|"--coverage",
CLAIM|23|一致|120fdd939:scripts/ci/run.mjs:330|`collectCoverage()` 这一步|const collectCoverage = async () => {
CLAIM|24|一致|120fdd939:scripts/ci/run.mjs:372|`compareCoverage()` 这一步|const compareCoverage = async () => {
CLAIM|25|一致|scripts/ci/run.mjs:337,413|不统计覆盖率时，测试照样全部运行|const plainProjects = check.projects.filter((id) => !measuredProjects.includes(id));；projects: plainProjects,
CLAIM|26|一致|scripts/ci/run.mjs:428|失败照样让作业失败|throw new Error(`CI_TEST_INCOMPLETE:${plainProjects.join(",")}`);
CLAIM|27|一致|scripts/ci/run.mjs:336|本 PR 之后的 `scripts/ci/run.mjs` 第 336 行，原话 `const measuredProjects = measure ? coverageProjects : [];`|const measuredProjects = measure ? coverageProjects : [];
CLAIM|28|一致|scripts/ci/run.mjs:337|本 PR 之后的 `scripts/ci/run.mjs` 第 337 行，原话 `const plainProjects = check.projects.filter((id) => !measuredProjects.includes(id));`|const plainProjects = check.projects.filter((id) => !measuredProjects.includes(id));
CLAIM|29|找不到|-|未核实：CI 机器上 tests 作业不统计覆盖率时的真实时长|-

决定、后果、验证各节讲的是方案将新增或修改的内容，按题目要求未纳入现状核对；第 3、4 条（52 分钟、最长一段）和 CI 上 tests 不统计覆盖率时的真实时长在仓库里没有读到对应测量记录，判找不到。
