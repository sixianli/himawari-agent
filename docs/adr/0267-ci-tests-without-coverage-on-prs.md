---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: ""
date: "2026-11-14"
---

# ADR 0267：PR 上照跑全部测试但不量覆盖率，覆盖率改到夜里在 main 上量

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提和来源](#premises)
- [Andy 的原话](#owner-decisions)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [验证](#verification)

<a id="context"></a>

## 背景

CI（每次推送后 GitHub Actions 自动跑的检查）里，`coverage` 作业（覆盖率作业：跑大部分测试，同时统计每行代码有没有被测试走到）一个作业独占约 52 分钟，是每个 PR 从推送到出结论的最长一段。它要先等 `policy` 作业，而 policy 里又重复跑了一遍 tooling 测试（仓库脚本自己的测试）。[ADR 0266](0266-ci-policy-static-security-run-on-the-oracle-arm-machine.md) 已经把 policy、static、security 搬到 Oracle 的 ARM 机器上。这份 ADR 定下再往下的两步：PR 上不再统计覆盖率，tooling 测试单独在 ARM 上并行跑；覆盖率改成每天夜里在 main 上统计一次，只出报告。

<a id="premises"></a>

## 前提和来源

1. 每项检查都要等 policy，coverage 还要等 build。来源：本 PR 之前的 `ci/policy.json` 里 coverage 一项，原话 `"needs": ["policy", "build"],`；static、build、security 各自的 `"needs": ["policy"],`。
2. policy 作业原来跑 tooling 测试，coverage 作业也跑。来源：本 PR 之前的 `ci/policy.json` 里 policy 一项，原话 `"projects": ["tooling"],`；`scripts/ci/check-policy.mjs` 里 coverage 的必选项目，原话 `const mainProjects = ["unit", "contracts", "integration", "e2e", "pi-compat", "tooling"];`。
3. tooling 里 3 个复核脚本的测试占了 tooling 文件耗时的约 81%。来源：`.agents/evidence/ci-test-timing-2026-11-13.md`，原话“合计 1003 秒，约占 tooling 的 81%”。这是云端容器上的实测，不是 CI 机器上的数字。
4. 统计覆盖率时，测试在 v8 的覆盖率收集下运行，再生成 JSON 和 LCOV 报告并和基线比较。来源：本 PR 之前的 `scripts/ci/run.mjs`，原话 `"--coverage",`，以及 `collectCoverage()`、`compareCoverage()` 两步。
5. 不统计覆盖率时，测试照样全部运行，失败照样让作业失败。来源：本 PR 之后的 `scripts/ci/run.mjs` 第 336–337 行，原话 `const measuredProjects = measure ? coverageProjects : [];` 和 `const plainProjects = check.projects.filter((id) => !measuredProjects.includes(id));`。
6. 未核实：CI 机器上 tests 作业不统计覆盖率时的真实时长。合并后第一批运行的作业时长和 `CI_HOST_LOAD` 日志是核对依据。

<a id="owner-decisions"></a>

## Andy 的原话

- 2026-11-13：“那个 Oracle 的加速方案不用给我看了，方案出来之后直接实施”
- 2026-11-14：“现在就做这个优化方案啊，不要再把那个老的 coverage 再拿去跑 60 分钟了，太耗时间了！”
- 2026-11-14（关于依赖缓存）：“这个也直接做”
- 2026-11-14：“那可不可以这样：覆盖率不是最耗时吗？那可不可以等晚上我睡觉之后，在夜里起一个定时任务，单独完整地跑一次主分支上的覆盖率，这样不就行了吗？平时开发就不要再被覆盖率挡住了，只在晚上闲时来做一次覆盖率检测？”

<a id="decision"></a>

## 决定

分两步，每步一个 PR：

1. **PR 上照跑全部测试，但不统计覆盖率**（随这份 ADR 的 PR 实施）。
   - `coverage` 作业改名 `tests`，仍在 CI 服务器上、仍等 policy 和 build，跑 unit、contracts、integration、e2e、pi-compat 五个项目。`scripts/ci/run.mjs` 默认不统计覆盖率，只有传 `--coverage measure`（或者仓库还没有覆盖率基线、要生成初始基线时）才统计。`--coverage` 给别的值直接报错 `CI_COVERAGE_OPTION_INVALID`。
   - 新增 `tooling` 作业，在 Oracle 的 ARM 机器上跑，只等 policy，和 tests 并行。policy 作业不再跑任何测试。
   - `ci/required`（汇总作业）等 tests 和 tooling，去 ARM 机器取 policy、static、tooling、security 四份报告。
   - 装依赖时 npm 的下载缓存从作业工作区（每个作业结束就清掉）挪到 runner 账号的 `~/.cache/himawari-ci/npm`，跨作业保留，满 7 天整个清空重建（`scripts/ci/install-dependencies.mjs` 的 `--cache runner`）。npm 照旧按锁文件里的摘要核对每个包，所以缓存被改坏只会让安装失败，不会装进别的东西。
   - main 上旧的 7 作业策略（policy 带 tooling 或不带、coverage 带全部测试）由 `upgradeCoverageToTests` 升级成新的 8 作业形状，摘要照旧按原始字节算；只认那一种完整写法，其他写法照样被拒。
2. **每天夜里在 main 上统计一次覆盖率，只出报告，不挡 PR。** 定时在日本时间 03:00，用 `run.mjs --check tests --coverage measure` 跑同样的测试并统计覆盖率，和基线比较的结果写进报告。具体放在哪个工作流、报告怎样给人看，在第 2 步的 PR 里定，写进这份 ADR 的后续修订。

<a id="options"></a>

## 比较过的方案

| 方案 | 结论 | 原因 |
| --- | --- | --- |
| PR 上不统计覆盖率，夜里在 main 上统计 | 采用 | Andy 提出；测试照样全部拦在 PR 上，只把统计挪走 |
| 彻底不要覆盖率 | 不采用 | 再也看不到哪些新代码没有测试；夜里统计不占 PR 时间，没有理由全丢 |
| coverage 按项目分两路，一路 CI 服务器、一路 ARM，再合并覆盖率 | 不采用 | 本 ADR 草稿原先的第 2、3 步。要先让构建产物支持 linux-arm64，再加跨机器合并，工作量大；统计挪到夜里后不再需要 |
| 只用 vitest 的 `--shard` 把 coverage 切成几个作业 | 不采用 | 按文件数切，不看耗时，tooling 里 3 个大文件可能落在同一片；合并要靠 `--merge-reports`，vitest 4.1.2 有 v8 覆盖率合并时原生崩溃的报告（https://github.com/vitest-dev/vitest/issues/10032 ） |

<a id="consequences"></a>

## 后果

- 每个 PR 的最长一段从“policy 跑完 tooling 测试，再跑带覆盖率统计的全部测试”缩短为“policy 只做校验，再跑不统计覆盖率的测试”；tooling 测试在 ARM 上同时跑。
- 新代码有没有被测试走到，PR 上不再报。某个 PR 让覆盖率掉到基线以下，要等夜里的报告才看到，而且不会挡住它合并；夜里报告出问题时，由看到的线程补测试。
- 第 2 步之前，覆盖率暂时没人统计。
- tooling 测试失败要等 tooling 作业，原来在 policy 阶段就能看到；static、build、security 不再被它挡住，更早开始。

<a id="verification"></a>

## 验证

- 第 1 步：`test/tooling/policy.test.mjs` 里名字带 `[ADR-0267]` 的用例：旧 7 作业策略升级成 tests 加 tooling；只升级完整的旧写法，少 integration、少 LCOV 输出、coverage 放到 ARM、required 不等 coverage 的照样被拒；反向：policy 重新带上 tooling、tests 带上 tooling、tooling 回到 CI 服务器，策略都被拒。`test/tooling/runner-orchestration.test.mjs` 覆盖 tests 不统计覆盖率时照样跑全部项目、`--coverage` 给别的值报错、tooling 作业只跑 tooling。上线后比较 `ci/required` 的总时长。
- 第 2 步：在它的 PR 里写明验证和反向用例。
