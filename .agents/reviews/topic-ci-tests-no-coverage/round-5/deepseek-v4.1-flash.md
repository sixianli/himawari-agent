CLAIM|1|一致|test/tooling/policy.test.mjs:66|CI 里 coverage 作业要跑六个测试项目|      projects: ["unit", "contracts", "tooling", "integration", "e2e", "pi-compat"],
CLAIM|2|一致|scripts/ci/coverage-model.mjs:33|其中 unit、contracts、tooling、integration 四个带覆盖率统计|export const coverageProjects = ["unit", "contracts", "tooling", "integration"];
CLAIM|3|一致|scripts/ci/check-policy.mjs:225|而且要先等 policy 作业|    sameSet(coverage.needs ?? [], ["policy", "build"]) &&
CLAIM|4|一致|.agents/evidence/ci-test-timing-2026-11-13.md:16|而 policy 里又重复跑了一遍 tooling 测试（仓库脚本自己的测试）|`ci/policy.json` 里 policy 检查的 `projects` 原来是 `["tooling"]`，coverage 检查的 `projects` 含 tooling：同一批测试在 policy 和 coverage 里各跑一遍。
CLAIM|5|一致|docs/adr/0266-ci-policy-static-security-run-on-the-oracle-arm-machine.md:11|ADR 0266 已经把 policy、static、security 搬到 Oracle 的 ARM 机器上|# ADR 0266：policy、static、security 三项检查改在 Oracle 的 ARM 机器上跑
CLAIM|6|一致|scripts/ci/check-policy.mjs:383-392|每项检查都要等 policy|    static: ["policy"],
CLAIM|7|一致|scripts/ci/check-policy.mjs:225|coverage 还要等 build|    sameSet(coverage.needs ?? [], ["policy", "build"]) &&
CLAIM|8|一致|scripts/ci/check-policy.mjs:225|`scripts/ci/check-policy.mjs` 的 `upgradeCoverageToTests` 认的旧写法，原话 `sameSet(coverage.needs ?? [], ["policy", "build"])`|    sameSet(coverage.needs ?? [], ["policy", "build"]) &&
CLAIM|9|一致|scripts/ci/check-policy.mjs:220|policy 作业原来可以跑 tooling 测试|    [[], ["tooling"]].some((projects) => sameSet(find("policy").projects ?? [], projects)) &&
CLAIM|10|一致|test/tooling/policy.test.mjs:66|coverage 作业也跑 tooling|      projects: ["unit", "contracts", "tooling", "integration", "e2e", "pi-compat"],
CLAIM|11|一致|scripts/ci/check-policy.mjs:220|同一个函数认的旧写法，原话 `[[], ["tooling"]].some((projects) => sameSet(find("policy").projects ?? [], projects))`|    [[], ["tooling"]].some((projects) => sameSet(find("policy").projects ?? [], projects)) &&
CLAIM|12|一致|scripts/ci/check-policy.mjs:226|和 `sameSet(coverage.projects ?? [], mainProjects)`|    sameSet(coverage.projects ?? [], mainProjects) &&
CLAIM|13|一致|scripts/ci/check-policy.mjs:52|`mainProjects` 的原话是 `const mainProjects = ["unit", "contracts", "integration", "e2e", "pi-compat", "tooling"];`|const mainProjects = ["unit", "contracts", "integration", "e2e", "pi-compat", "tooling"];
CLAIM|14|一致|.agents/evidence/ci-test-timing-2026-11-13.md:14|tooling 里 3 个复核脚本的测试占了 tooling 文件耗时的约 81%|tooling 里最大的三个文件：`opencode-review.test.mjs` 417 秒、`opencode-review-merge-gate.test.mjs` 364 秒、`review-gateway.test.mjs` 222 秒，合计 1003 秒，约占 tooling 的 81%。
CLAIM|15|一致|.agents/evidence/ci-test-timing-2026-11-13.md:14|来源：`.agents/evidence/ci-test-timing-2026-11-13.md`，原话“合计 1003 秒，约占 tooling 的 81%”|tooling 里最大的三个文件：`opencode-review.test.mjs` 417 秒、`opencode-review-merge-gate.test.mjs` 364 秒、`review-gateway.test.mjs` 222 秒，合计 1003 秒，约占 tooling 的 81%。
CLAIM|16|一致|.agents/evidence/ci-test-timing-2026-11-13.md:1|这是云端容器上的实测，不是 CI 机器上的数字|# 各测试项目的耗时（2026-11-13，云端容器，Node 22.23.4，不带覆盖率插桩）
CLAIM|17|一致|vitest.workspace.ts:22|统计覆盖率时，测试在 v8 的覆盖率收集下运行|      provider: "v8",
CLAIM|18|一致|scripts/ci/run.mjs:321|再生成 JSON 报告|          { path: path.join(coverageDirectory, "coverage-final.json"), kind: "json" },
CLAIM|19|一致|scripts/ci/run.mjs:322|再生成 LCOV 报告|          { path: path.join(coverageDirectory, "lcov.info"), kind: "lcov" },
CLAIM|20|一致|scripts/ci/coverage-model.mjs:542|并和基线比较|            code: "baseline-regression",
CLAIM|21|一致|scripts/ci/run.mjs:350|来源：`scripts/ci/run.mjs` 带 `--coverage measure` 时走的那段，原话 `"--coverage",`|            "--coverage",
CLAIM|22|一致|scripts/ci/run.mjs:339|以及 `collectCoverage()` 两步之一|      const collectCoverage = async () => {
CLAIM|23|一致|scripts/ci/run.mjs:381|以及 `compareCoverage()` 两步之一|      const compareCoverage = async () => {
CLAIM|24|一致|scripts/ci/install-gate-dependencies.mjs:86|汇总作业的 `scripts/ci/install-gate-dependencies.mjs` 至今仍用作业工作区里的 `.ci-output/npm-cache`|      path.join(root, ".ci-output/npm-cache"),
CLAIM|25|一致|test/tooling/policy.test.mjs:1252|main 上旧的 7 作业策略由 `upgradeCoverageToTests` 升级成新的 8 作业形状|  it("[ADR-0267] 基准上 coverage 作业带全部测试的七作业策略升级成 tests 加 Oracle 上的 tooling", () => {
CLAIM|26|一致|scripts/ci/check-policy.mjs:220|policy 带 tooling 或不带|    [[], ["tooling"]].some((projects) => sameSet(find("policy").projects ?? [], projects)) &&
CLAIM|27|一致|scripts/ci/check-policy.mjs:226|coverage 带全部测试|    sameSet(coverage.projects ?? [], mainProjects) &&
CLAIM|28|一致|scripts/ci/check-policy.mjs:1336|摘要照旧按原始字节算|  return { policy, policySha256: sha256(bytes), coverage, baseSha, initialization: !hasPolicy };
CLAIM|29|一致|scripts/ci/check-policy.mjs:230|只认那一种完整写法，其他写法照样被拒|  if (!accepted) return policy;
CLAIM|30|一致|docs/adr/0189-drop-node-floor-and-fold-test-into-coverage.md:58|ADR 0189 决定 4 的 `--check coverage`|4. **本地入口不变成两个命令。**`npm test` 改成 `local.mjs --check coverage`，仍然一条命令跑全部测试。
CLAIM|31|一致|docs/adr/0064-layer3-individual-trigger-scope.md:37|ADR 0064 示例里的 `coverage`|2. **只在检查阶段运行的 `scripts/ci/` 脚本，单独跑的替代品是“对应的检查步骤加整个 tooling 项目”。** 在测试主机上对该改动跑 `node scripts/ci/local.mjs --check <该脚本所属的检查，例如 policy、coverage、security>` 和 `vitest run --project tooling` 整组；两者都通过即可提交。完整第 3 层照 ADR 0057 的批次规则在一批的最终版本上跑一次，不因这类改动提前。

方案前提 6 自述的 CI 机器真实时长、npm 自身按锁文件摘要核对每个包的行为，以及“本 PR 之后”的 `run.mjs` 行为，我都没有按现状核对。仓库没有 `main` 引用，无法直接打开 `main` 上的旧策略，旧 7 作业形状只能依据当前升级函数与测试夹具核对。
