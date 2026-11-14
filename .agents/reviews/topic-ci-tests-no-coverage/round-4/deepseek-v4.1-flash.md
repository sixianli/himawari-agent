CLAIM|1|一致|ci/policy.json:110（提交 120fdd939）|`coverage` 作业要跑六个测试项目|"projects": ["unit", "contracts", "tooling", "integration", "e2e", "pi-compat"],
CLAIM|2|一致|scripts/ci/coverage-model.mjs:33|unit、contracts、tooling、integration 四个带覆盖率统计|export const coverageProjects = ["unit", "contracts", "tooling", "integration"];
CLAIM|3|一致|ci/policy.json:99（提交 120fdd939）|`coverage` 作业要先等 `policy` 作业|"needs": ["policy", "build"],
CLAIM|4|一致|ci/policy.json:20（提交 120fdd939）|policy 里又重复跑了一遍 tooling 测试|"projects": ["tooling"],
CLAIM|5|一致|docs/adr/0266-ci-policy-static-security-run-on-the-oracle-arm-machine.md:11|ADR 0266 已经把 policy、static、security 搬到 Oracle 的 ARM 机器上|# ADR 0266：policy、static、security 三项检查改在 Oracle 的 ARM 机器上跑
CLAIM|6|一致|ci/policy.json:25（提交 120fdd939）|每项检查都要等 policy|"needs": ["policy"],
CLAIM|7|一致|ci/policy.json:99（提交 120fdd939）|coverage 还要等 build，来源原话 `"needs": ["policy", "build"],`|"needs": ["policy", "build"],
CLAIM|8|一致|ci/policy.json:25（提交 120fdd939）|static 的 `"needs": ["policy"],`|"needs": ["policy"],
CLAIM|9|一致|ci/policy.json:42（提交 120fdd939）|build 的 `"needs": ["policy"],`|"needs": ["policy"],
CLAIM|10|一致|ci/policy.json:115（提交 120fdd939）|security 的 `"needs": ["policy"],`|"needs": ["policy"],
CLAIM|11|一致|ci/policy.json:20（提交 120fdd939）|policy 作业原来跑 tooling 测试|"projects": ["tooling"],
CLAIM|12|一致|ci/policy.json:110（提交 120fdd939）|coverage 作业也跑 tooling 测试|"projects": ["unit", "contracts", "tooling", "integration", "e2e", "pi-compat"],
CLAIM|13|一致|scripts/ci/check-policy.mjs:52|`scripts/ci/check-policy.mjs` 里 coverage 的必选项目，原话 `const mainProjects = ["unit", "contracts", "integration", "e2e", "pi-compat", "tooling"];`|const mainProjects = ["unit", "contracts", "integration", "e2e", "pi-compat", "tooling"];
CLAIM|14|一致|.agents/evidence/ci-test-timing-2026-11-13.md:14|tooling 里 3 个复核脚本的测试占了 tooling 文件耗时的约 81%，原话“合计 1003 秒，约占 tooling 的 81%”|tooling 里最大的三个文件：`opencode-review.test.mjs` 417 秒、`opencode-review-merge-gate.test.mjs` 364 秒、`review-gateway.test.mjs` 222 秒，合计 1003 秒，约占 tooling 的 81%。
CLAIM|15|一致|.agents/evidence/ci-test-timing-2026-11-13.md:1|这是云端容器上的实测，不是 CI 机器上的数字|# 各测试项目的耗时（2026-11-13，云端容器，Node 22.23.4，不带覆盖率插桩）
CLAIM|16|一致|package.json:112|统计覆盖率时，测试在 v8 的覆盖率收集下运行|"@vitest/coverage-v8": "4.1.9",
CLAIM|17|一致|scripts/ci/run.mjs:321|再生成 JSON 报告|{ path: path.join(coverageDirectory, "coverage-final.json"), kind: "json" },
CLAIM|18|一致|scripts/ci/run.mjs:322|再生成 LCOV 报告|{ path: path.join(coverageDirectory, "lcov.info"), kind: "lcov" },
CLAIM|19|一致|scripts/ci/run.mjs:381|并和基线比较|const compareCoverage = async () => {
CLAIM|20|一致|scripts/ci/run.mjs:350|原话 `"--coverage",`|"--coverage",
CLAIM|21|一致|scripts/ci/run.mjs:339|`collectCoverage()` 这一步|const collectCoverage = async () => {
CLAIM|22|一致|scripts/ci/run.mjs:381|`compareCoverage()` 这一步|const compareCoverage = async () => {
CLAIM|23|一致|scripts/ci/run.mjs:414|不统计覆盖率时，测试照样全部运行|projects: plainProjects,
CLAIM|24|一致|scripts/ci/run.mjs:429|失败照样让作业失败|throw new Error(`CI_TEST_INCOMPLETE:${plainProjects.join(",")}`);
CLAIM|25|一致|scripts/ci/run.mjs:336|原话 `const measuredProjects = measure ? coverageProjects : [];`|const measuredProjects = measure ? coverageProjects : [];
CLAIM|26|一致|scripts/ci/run.mjs:337|原话 `const plainProjects = check.projects.filter((id) => !measuredProjects.includes(id));`|const plainProjects = check.projects.filter((id) => !measuredProjects.includes(id));
CLAIM|27|一致|.github/workflows/ci.yml:233|`coverage` 作业改名 `tests`|tests:
CLAIM|28|一致|.github/workflows/ci.yml:236|仍在 CI 服务器上|runs-on: ci-vps
CLAIM|29|一致|ci/policy.json:99|仍等 policy 和 build|"needs": ["policy", "build"],
CLAIM|30|一致|ci/policy.json:110|跑 unit、contracts、integration、e2e、pi-compat 五个项目|"projects": ["unit", "contracts", "integration", "e2e", "pi-compat"],
CLAIM|31|一致|scripts/ci/run.mjs:315|`scripts/ci/run.mjs` 默认不统计覆盖率|const measure = coverage === "measure" || candidate !== undefined;
CLAIM|32|一致|scripts/ci/run.mjs:315|只有传 `--coverage measure`（或者仓库还没有覆盖率基线、要生成初始基线时）才统计|const measure = coverage === "measure" || candidate !== undefined;
CLAIM|33|一致|scripts/ci/run.mjs:88|`--coverage` 给别的值直接报错 `CI_COVERAGE_OPTION_INVALID`|throw new Error("CI_COVERAGE_OPTION_INVALID");
CLAIM|34|一致|.github/workflows/ci.yml:284|新增 `tooling` 作业，在 Oracle 的 ARM 机器上跑|runs-on: ci-arm
CLAIM|35|一致|ci/policy.json:115|只等 policy|"needs": ["policy"],
CLAIM|36|一致|ci/policy.json:20|policy 作业不再跑任何测试|"projects": [],
CLAIM|37|一致|package.json:81|`npm test` 运行 `scripts/ci/local.mjs --check tests`|"test": "node scripts/ci/local.mjs --check tests",
CLAIM|38|一致|package.json:93|`npm run test:tooling` 运行 `--check tooling`|"test:tooling": "node scripts/ci/local.mjs --check tooling",
CLAIM|39|一致|docs/adr/0189-drop-node-floor-and-fold-test-into-coverage.md:58|ADR 0189 决定 4 的 `--check coverage`|4. **本地入口不变成两个命令。**`npm test` 改成 `local.mjs --check coverage`，仍然一条命令跑全部测试。
CLAIM|40|一致|docs/adr/0064-layer3-individual-trigger-scope.md:37|ADR 0064 示例里的 `coverage`|2. **只在检查阶段运行的 `scripts/ci/` 脚本，单独跑的替代品是“对应的检查步骤加整个 tooling 项目”。** 在测试主机上对该改动跑 `node scripts/ci/local.mjs --check <该脚本所属的检查，例如 policy、coverage、security>` 和 `vitest run --project tooling` 整组；两者都通过即可提交。完整第 3 层照 ADR 0057 的批次规则在一批的最终版本上跑一次，不因这类改动提前。
CLAIM|41|不一致|docs/adr/0189-drop-node-floor-and-fold-test-into-coverage.md:58|ADR 0189 决定 4 的 `--check coverage` 从此换成 `tests`|4. **本地入口不变成两个命令。**`npm test` 改成 `local.mjs --check coverage`，仍然一条命令跑全部测试。
CLAIM|42|不一致|docs/adr/0064-layer3-individual-trigger-scope.md:37|ADR 0064 示例里的 `coverage` 从此换成 `tests`|2. **只在检查阶段运行的 `scripts/ci/` 脚本，单独跑的替代品是“对应的检查步骤加整个 tooling 项目”。** 在测试主机上对该改动跑 `node scripts/ci/local.mjs --check <该脚本所属的检查，例如 policy、coverage、security>` 和 `vitest run --project tooling` 整组；两者都通过即可提交。完整第 3 层照 ADR 0057 的批次规则在一批的最终版本上跑一次，不因这类改动提前。
CLAIM|43|一致|scripts/ci/local.mjs:28|`coverage` 这个检查名已经不存在|if (check && !["policy", "static", "build", "tests", "tooling", "security"].includes(check))
CLAIM|44|一致|ci/policy.json:149|`ci/required`（汇总作业）等 tests 和 tooling|"needs": ["policy", "static", "build", "browser", "tests", "tooling", "security"],
CLAIM|45|一致|.github/workflows/ci.yml:404|去 ARM 机器取 policy、static、tooling、security 四份报告|run: .ci-output/tools/bin/node scripts/ci/run-share.mjs collect --to .ci-output/reports --remote-jobs policy,static,tooling,security
CLAIM|46|一致|.github/workflows/ci.yml:53（提交 120fdd939）|npm 的下载缓存原来在作业工作区|run: node scripts/ci/install-dependencies.mjs --tools .ci-output/tools --evidence .ci-output/installation --cache .ci-output/npm-cache
CLAIM|47|找不到|-|作业工作区每个作业结束就清掉|-
CLAIM|48|一致|scripts/ci/install-dependencies.mjs:67|挪到 runner 账号的 `~/.cache/himawari-ci/npm`|const target = join(home, ".cache", "himawari-ci", "npm");
CLAIM|49|一致|scripts/ci/install-dependencies.mjs:71|跨作业保留，满 7 天整个清空重建|if (!created?.isFile() || now - created.mtimeMs > runnerCacheMaxAgeMs) {
CLAIM|50|一致|scripts/ci/install-dependencies.mjs:81|`scripts/ci/install-dependencies.mjs` 的 `--cache runner`|if (value === "runner") return runnerNpmCache(env);
CLAIM|51|一致|scripts/ci/install-dependencies.mjs:377|npm 照旧按锁文件里的摘要核对每个包|"ci",
CLAIM|52|找不到|-|缓存被改坏只会让安装失败，不会装进别的东西|-
CLAIM|53|一致|scripts/ci/check-policy.mjs:51|旧的 7 作业策略|const coverageJobIds = ["policy", "static", "build", "browser", "coverage", "security", "required"];
CLAIM|54|一致|scripts/ci/check-policy.mjs:220|policy 带 tooling 或不带|[[], ["tooling"]].some((projects) => sameSet(find("policy").projects ?? [], projects)) &&
CLAIM|55|一致|scripts/ci/check-policy.mjs:226|coverage 带全部测试|sameSet(coverage.projects ?? [], mainProjects) &&
CLAIM|56|一致|scripts/ci/check-policy.mjs:211|由 `upgradeCoverageToTests` 升级|export function upgradeCoverageToTests(policy) {
CLAIM|57|一致|scripts/ci/check-policy.mjs:49|升级成新的 8 作业形状|const jobIds = ["policy", "static", "build", "browser", "tests", "tooling", "security", "required"];
CLAIM|58|一致|scripts/ci/check-policy.mjs:1336|摘要照旧按原始字节算|return { policy, policySha256: sha256(bytes), coverage, baseSha, initialization: !hasPolicy };
CLAIM|59|一致|scripts/ci/check-policy.mjs:230|只认那一种完整写法，其他写法照样被拒|if (!accepted) return policy;
CLAIM|60|一致|scripts/ci/check-policy.mjs:240|升级成 tests 加 tooling 里的 tests|id: "tests",
CLAIM|61|一致|scripts/ci/check-policy.mjs:245|升级成 tests 加 tooling 里的 tooling|id: "tooling",
CLAIM|62|一致|test/tooling/policy.test.mjs:1252|`test/tooling/policy.test.mjs` 里名字带 `[ADR-0267]` 的用例：旧 7 作业策略升级成 tests 加 tooling|it("[ADR-0267] 基准上 coverage 作业带全部测试的七作业策略升级成 tests 加 Oracle 上的 tooling", () => {
CLAIM|63|一致|test/tooling/policy.test.mjs:1281|只升级完整的旧写法，少 integration 的照样被拒|"coverage 少 integration",
CLAIM|64|一致|test/tooling/policy.test.mjs:1288|少 LCOV 输出的照样被拒|"coverage 少 lcov 输出",
CLAIM|65|一致|test/tooling/policy.test.mjs:1294|coverage 放到 ARM 的照样被拒|"coverage 放到 ci-arm",
CLAIM|66|一致|test/tooling/policy.test.mjs:1300|required 不等 coverage 的照样被拒|"required 没等 coverage",
CLAIM|67|一致|test/tooling/policy.test.mjs:1315|反向：policy 重新带上 tooling 被拒|expect(() => validatePolicy(withTooling)).toThrow("Incomplete project selection: policy");
CLAIM|68|一致|test/tooling/policy.test.mjs:1318|反向：tests 带上 tooling 被拒|expect(() => validatePolicy(testsWithTooling)).toThrow("Incomplete project selection: tests");
CLAIM|69|一致|test/tooling/policy.test.mjs:1323|反向：tooling 回到 CI 服务器被拒|expect(() => validatePolicy(toolingOnVps)).toThrow("Incorrect platform: tooling/default");
CLAIM|70|一致|test/tooling/runner-orchestration.test.mjs:384|`test/tooling/runner-orchestration.test.mjs` 覆盖 tests 不统计覆盖率时照样跑全部项目|it("[ADR-0267] tests 不带 --coverage measure 时只跑测试，不量覆盖率", async () => {
CLAIM|71|一致|test/tooling/runner-orchestration.test.mjs:406|`--coverage` 给别的值报错|await expect(run(checkId, { coverage })).rejects.toThrow("CI_COVERAGE_OPTION_INVALID");
CLAIM|72|一致|test/tooling/runner-orchestration.test.mjs:381|tooling 作业只跑 tooling|expect(result.projects.map((entry) => entry.id)).toEqual(["tooling"]);

未能核对：CI 机器上 tests 作业不统计覆盖率时的真实时长（方案自己也标为未核实），以及旧缓存所在作业工作区是否在每个作业结束时被清掉、缓存被改坏是否只会导致安装失败。夜间定时统计覆盖率和“上线后比较 ci/required 总时长”属于第 2 步或后续计划，仓库当前内容没有对应实现可核。
