CLAIM|1|一致|test/tooling/policy.test.mjs:66|`coverage` 作业要带着覆盖率统计跑六个测试项目|projects: ["unit", "contracts", "tooling", "integration", "e2e", "pi-compat"],
CLAIM|2|不一致|scripts/ci/coverage-model.mjs:33|`coverage` 作业要带着覆盖率统计跑六个测试项目|export const coverageProjects = ["unit", "contracts", "tooling", "integration"];
CLAIM|3|一致|scripts/ci/check-policy.mjs:225|而且要先等 `policy` 作业|sameSet(coverage.needs ?? [], ["policy", "build"]) &&
CLAIM|4|一致|test/tooling/policy.test.mjs:70|而 policy 里又重复跑了一遍 tooling 测试|value.checks.find((check) => check.id === "policy").projects = ["tooling"];
CLAIM|5|一致|docs/adr/0266-ci-policy-static-security-run-on-the-oracle-arm-machine.md:11|ADR 0266 已经把 policy、static、security 搬到 Oracle 的 ARM 机器上|# ADR 0266：policy、static、security 三项检查改在 Oracle 的 ARM 机器上跑
CLAIM|6|一致|scripts/ci/check-policy.mjs:378|每项检查都要等 policy|const expectedNeeds = { policy: [], static: ["policy"], build: ["policy"], browser: ["build"],
CLAIM|7|一致|scripts/ci/check-policy.mjs:225|coverage 还要等 build|sameSet(coverage.needs ?? [], ["policy", "build"]) &&
CLAIM|8|一致|scripts/ci/check-policy.mjs:225|本 PR 之前的 `ci/policy.json` 里 coverage 一项，原话 `"needs": ["policy", "build"],`|sameSet(coverage.needs ?? [], ["policy", "build"]) &&
CLAIM|9|一致|ci/policy.json:25|static、build、security 各自的 `"needs": ["policy"],`|"needs": ["policy"],
CLAIM|10|一致|ci/policy.json:42|static、build、security 各自的 `"needs": ["policy"],`|"needs": ["policy"],
CLAIM|11|一致|ci/policy.json:132|static、build、security 各自的 `"needs": ["policy"],`|"needs": ["policy"],
CLAIM|12|一致|test/tooling/policy.test.mjs:70|policy 作业原来跑 tooling 测试|value.checks.find((check) => check.id === "policy").projects = ["tooling"];
CLAIM|13|一致|test/tooling/policy.test.mjs:66|coverage 作业也跑|projects: ["unit", "contracts", "tooling", "integration", "e2e", "pi-compat"],
CLAIM|14|一致|test/tooling/policy.test.mjs:70|本 PR 之前的 `ci/policy.json` 里 policy 一项，原话 `"projects": ["tooling"],`|value.checks.find((check) => check.id === "policy").projects = ["tooling"];
CLAIM|15|一致|scripts/ci/check-policy.mjs:52|`scripts/ci/check-policy.mjs` 里 coverage 的必选项目，原话 `const mainProjects = ["unit", "contracts", "integration", "e2e", "pi-compat", "tooling"];`|const mainProjects = ["unit", "contracts", "integration", "e2e", "pi-compat", "tooling"];
CLAIM|16|一致|.agents/evidence/ci-test-timing-2026-11-13.md:14|tooling 里 3 个复核脚本的测试占了 tooling 文件耗时的约 81%|合计 1003 秒，约占 tooling 的 81%。
CLAIM|17|一致|.agents/evidence/ci-test-timing-2026-11-13.md:14|原话“合计 1003 秒，约占 tooling 的 81%”|合计 1003 秒，约占 tooling 的 81%。
CLAIM|18|一致|.agents/evidence/ci-test-timing-2026-11-13.md:1|这是云端容器上的实测，不是 CI 机器上的数字|# 各测试项目的耗时（2026-11-13，云端容器，Node 22.23.4，不带覆盖率插桩）
CLAIM|19|一致|vitest.workspace.ts:22|统计覆盖率时，测试在 v8 的覆盖率收集下运行|provider: "v8",
CLAIM|20|一致|vitest.workspace.ts:25|再生成 JSON 和 LCOV 报告|reporter: ["json", "lcov", "text-summary"],
CLAIM|21|一致|scripts/ci/run.mjs:380|并和基线比较|const compareCoverage = async () => {
CLAIM|22|一致|scripts/ci/run.mjs:349|本 PR 之前的 `scripts/ci/run.mjs`，原话 `"--coverage",`|"--coverage",
CLAIM|23|一致|scripts/ci/run.mjs:338|以及 `collectCoverage()`、`compareCoverage()` 两步|const collectCoverage = async () => {
CLAIM|24|一致|scripts/ci/run.mjs:380|以及 `collectCoverage()`、`compareCoverage()` 两步|const compareCoverage = async () => {
CLAIM|25|一致|scripts/ci/run.mjs:336|不统计覆盖率时，测试照样全部运行|const measuredProjects = measure ? coverageProjects : [];
CLAIM|26|一致|scripts/ci/run.mjs:428|失败照样让作业失败|throw new Error(`CI_TEST_INCOMPLETE:${plainProjects.join(",")}`);
CLAIM|27|一致|scripts/ci/run.mjs:336|本 PR 之后的 `scripts/ci/run.mjs` 第 336–337 行，原话 `const measuredProjects = measure ? coverageProjects : [];`|const measuredProjects = measure ? coverageProjects : [];
CLAIM|28|一致|scripts/ci/run.mjs:337|本 PR 之后的 `scripts/ci/run.mjs` 第 336–337 行，原话 `const plainProjects = check.projects.filter((id) => !measuredProjects.includes(id));`|const plainProjects = check.projects.filter((id) => !measuredProjects.includes(id));
CLAIM|29|一致|ci/policy.json:98|`coverage` 作业改名 `tests`|"id": "tests",
CLAIM|30|一致|ci/policy.json:104|仍在 CI 服务器上|"runner": "ci-vps",
CLAIM|31|一致|ci/policy.json:99|仍等 policy 和 build|"needs": ["policy", "build"],
CLAIM|32|一致|ci/policy.json:110|跑 unit、contracts、integration、e2e、pi-compat 五个项目|"projects": ["unit", "contracts", "integration", "e2e", "pi-compat"],
CLAIM|33|一致|scripts/ci/run.mjs:315|`scripts/ci/run.mjs` 默认不统计覆盖率|const measure = coverage === "measure" || candidate !== undefined;
CLAIM|34|一致|scripts/ci/run.mjs:315|只有传 `--coverage measure`（或者仓库还没有覆盖率基线、要生成初始基线时）才统计|const measure = coverage === "measure" || candidate !== undefined;
CLAIM|35|一致|scripts/ci/run.mjs:88|`--coverage` 给别的值直接报错 `CI_COVERAGE_OPTION_INVALID`|throw new Error("CI_COVERAGE_OPTION_INVALID");
CLAIM|36|一致|ci/policy.json:114|新增 `tooling` 作业|"id": "tooling",
CLAIM|37|一致|ci/policy.json:120|在 Oracle 的 ARM 机器上跑|"runner": "ci-arm",
CLAIM|38|一致|docs/adr/0266-ci-policy-static-security-run-on-the-oracle-arm-machine.md:30|在 Oracle 的 ARM 机器上跑|Andy 租的 Oracle 东京 ARM 机器（4 核、24 GB）上已经装好 `ci-arm-1`、`ci-arm-2` 两个 runner。
CLAIM|39|一致|ci/policy.json:115|只等 policy|"needs": ["policy"],
CLAIM|40|一致|ci/policy.json:115|和 tests 并行|"needs": ["policy"],
CLAIM|41|一致|ci/policy.json:20|policy 作业不再跑任何测试|"projects": [],
CLAIM|42|一致|ci/policy.json:149|`ci/required`（汇总作业）等 tests 和 tooling|"needs": ["policy", "static", "build", "browser", "tests", "tooling", "security"],
CLAIM|43|一致|scripts/ci/contracts.mjs:19|去 ARM 机器取 policy、static、tooling、security 四份报告|export const armChecks = Object.freeze(["policy", "static", "tooling", "security"]);
CLAIM|44|一致|scripts/ci/install-dependencies.mjs:67|挪到 runner 账号的 `~/.cache/himawari-ci/npm`|const target = join(home, ".cache", "himawari-ci", "npm");
CLAIM|45|一致|scripts/ci/install-dependencies.mjs:67|跨作业保留|const target = join(home, ".cache", "himawari-ci", "npm");
CLAIM|46|一致|scripts/ci/install-dependencies.mjs:47|满 7 天整个清空重建|const runnerCacheMaxAgeMs = 7 * 24 * 60 * 60 * 1000;
CLAIM|47|一致|scripts/ci/install-dependencies.mjs:450|`scripts/ci/install-dependencies.mjs` 的 `--cache runner`|options[name] = name === "cacheDirectory" && value === "runner" ? value : resolve(value);
CLAIM|48|一致|scripts/ci/install-dependencies.mjs:377|npm 照旧按锁文件里的摘要核对每个包|npmCli, "ci", "--ignore-scripts",
CLAIM|49|一致|scripts/ci/check-policy.mjs:51|main 上旧的 7 作业策略|const coverageJobIds = ["policy", "static", "build", "browser", "coverage", "security", "required"];
CLAIM|50|一致|scripts/ci/check-policy.mjs:220|policy 带 tooling 或不带|[[], ["tooling"]].some((projects) => sameSet(find("policy").projects ?? [], projects)) &&
CLAIM|51|一致|scripts/ci/check-policy.mjs:226|coverage 带全部测试|sameSet(coverage.projects ?? [], mainProjects) &&
CLAIM|52|一致|scripts/ci/check-policy.mjs:211|由 `upgradeCoverageToTests` 升级成新的 8 作业形状|export function upgradeCoverageToTests(policy) {
CLAIM|53|一致|scripts/ci/check-policy.mjs:49|由 `upgradeCoverageToTests` 升级成新的 8 作业形状|const jobIds = ["policy", "static", "build", "browser", "tests", "tooling", "security", "required"];
CLAIM|54|一致|scripts/ci/check-policy.mjs:1331|摘要照旧按原始字节算|return { policy, policySha256: sha256(bytes), coverage, baseSha, initialization: !hasPolicy };
CLAIM|55|一致|scripts/ci/check-policy.mjs:230|只认那一种完整写法，其他写法照样被拒|if (!accepted) return policy;
CLAIM|56|不一致|scripts/ci/coverage-model.mjs:33|每个 PR 的测试从“policy 跑完 tooling 测试，再跑带覆盖率统计的全部测试”改为“policy 只做校验，再跑不统计覆盖率的测试”|export const coverageProjects = ["unit", "contracts", "tooling", "integration"];
CLAIM|57|一致|test/tooling/policy.test.mjs:70|tooling 测试失败要等 tooling 作业，原来在 policy 阶段就能看到|value.checks.find((check) => check.id === "policy").projects = ["tooling"];
CLAIM|58|一致|scripts/ci/platforms.mjs:15|要先让构建产物支持 linux-arm64|const ARTIFACT_PLATFORM_KEYS = Object.freeze(["macos-arm64", "linux-x64"]);
CLAIM|59|一致|test/tooling/policy.test.mjs:1251|`test/tooling/policy.test.mjs` 里名字带 `[ADR-0267]` 的用例|it("[ADR-0267] 基准上 coverage 作业带全部测试的七作业策略升级成 tests 加 Oracle 上的 tooling", () => {
CLAIM|60|一致|test/tooling/policy.test.mjs:1251|旧 7 作业策略升级成 tests 加 tooling|it("[ADR-0267] 基准上 coverage 作业带全部测试的七作业策略升级成 tests 加 Oracle 上的 tooling", () => {
CLAIM|61|一致|test/tooling/policy.test.mjs:1310|只升级完整的旧写法，少 integration、少 LCOV 输出、coverage 放到 ARM、required 不等 coverage 的照样被拒|])("[ADR-0267] 只升级完整的 coverage 七作业写法，%s的照样被拒", (_name, mutate) => {
CLAIM|62|一致|test/tooling/policy.test.mjs:1316|反向：policy 重新带上 tooling、tests 带上 tooling、tooling 回到 CI 服务器，策略都被拒|it("[ADR-0267] 反向：policy 作业重新带上 tooling、tests 带上 tooling 或 tooling 回到 CI 服务器，策略都被拒", () => {
CLAIM|63|一致|test/tooling/runner-orchestration.test.mjs:384|`test/tooling/runner-orchestration.test.mjs` 覆盖 tests 不统计覆盖率时照样跑全部项目|it("[ADR-0267] tests 不带 --coverage measure 时只跑测试，不量覆盖率", async () => {
CLAIM|64|一致|test/tooling/runner-orchestration.test.mjs:400|`--coverage` 给别的值报错|])("[ADR-0267] 拒绝%s的覆盖率选项%s，不启动命令", async (checkId, coverage) => {
CLAIM|65|一致|test/tooling/runner-orchestration.test.mjs:378|tooling 作业只跑 tooling|it("[ADR-0267] tooling 只跑 tooling 测试，不跑 policy 检查", async () => {

未核对的部分：前提 6 所述 CI 机器上 tests 作业不统计覆盖率时的真实时长，仓库里没有运行记录；比较方案里 vitest 4.1.2 的崩溃与 `--shard` 行为属于第三方产品，未核对；第 2 步的夜间定时和报告展示尚未实施，未按现状核对。
