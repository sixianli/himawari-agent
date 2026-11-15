CLAIM|1|一致|.github/workflows/ci.yml:236@1baa489cf71a94dc00e8816c189d8f0b59b52266|ci.yml 的 tests 作业在 CI 服务器的一个 runner 上|runs-on: ci-vps
CLAIM|2|一致|ci/policy.json:110@1baa489cf71a94dc00e8816c189d8f0b59b52266|依次跑 unit、contracts、integration、e2e、pi-compat 五个测试项目|"projects": ["unit", "contracts", "integration", "e2e", "pi-compat"],
CLAIM|3|一致|scripts/ci/test.mjs:59@1baa489cf71a94dc00e8816c189d8f0b59b52266|测试项目依次跑|for (const id of selection) {
CLAIM|4|一致|.agents/evidence/ci-tests-split-2026-11-15.md:13|main 上一次完整运行里这个作业用了约 50 分钟|作业从 00:33:15Z 开始、01:23:33Z 结束，共约 50 分钟，其中五个项目依次跑约 46 分钟，前面装工具、装依赖、取构建约 3 分钟。
CLAIM|5|一致|.agents/evidence/ci-tests-split-2026-11-15.md:9|其中 integration 一项就 34 分钟|2021 秒（`"durationMs":2021486`，这一次有失败，已由 PR 537 修好）
CLAIM|6|找不到|-|同一台机器上的另外两个检查 runner 在 browser 作业跑完后就空着|-
CLAIM|7|找不到|-|ARM 机器上的 `tooling` 检查连续两次 main 运行各有两条测试因为超过 vitest 的 5 秒默认超时而失败，两次失败的测试不全相同|-
CLAIM|8|一致|.agents/evidence/ci-tests-split-2026-11-15.md:11|unit 596 秒|596 秒（`"durationMs":596203`）
CLAIM|9|一致|.agents/evidence/ci-tests-split-2026-11-15.md:7|contracts 110 秒|110 秒（`"durationMs":110063`）
CLAIM|10|一致|.agents/evidence/ci-tests-split-2026-11-15.md:10|pi-compat 35 秒|35 秒（`"durationMs":34800`）
CLAIM|11|一致|.agents/evidence/ci-tests-split-2026-11-15.md:8|e2e 6 秒|6 秒（`"durationMs":5872`）
CLAIM|12|一致|ci/policy.json:103@1baa489cf71a94dc00e8816c189d8f0b59b52266|拆分前 tests 只有一个矩阵成员|"key": "default",
CLAIM|13|一致|docs/runbooks/ci-vps-runner-runbook.md:17|CI 服务器共用 8 个 vCPU、22 GB 内存|8 个 vCPU，22 GB 内存
CLAIM|14|一致|docs/runbooks/ci-vps-runner-runbook.md:38|CI 服务器有三个检查 runner|`ci-vps-1`、`ci-vps-2` 和 `ci-vps-3`（脚本里的编号是 1、2、6）是检查 runner
CLAIM|15|一致|docs/runbooks/ci-vps-runner-runbook.md:67|三个合计内存上限 16 GB|合计内存最多 16 GB
CLAIM|16|一致|scripts/ci/test-concurrency.mjs:4|integration 每次最多开 3 个 worker（同时跑测试的子进程）|maximum: 3,
CLAIM|17|一致|scripts/ci/test-concurrency.mjs:13|其他项目只开 1 个|if (!project.fileParallelism || !project.workerLimits) return 1;
CLAIM|18|一致|scripts/ci/test.mjs:139|每次跑完，`scripts/ci/test.mjs` 都核对 vitest 实际跑的文件是不是正好等于该跑的文件，不等就失败|throw new Error(`CI_TEST_FILE_SET_MISMATCH:${id}`);
CLAIM|19|一致|scripts/ci/check-policy.mjs:1353|PR 和 main 上的 CI 都按基准提交上的 `ci/policy.json` 执行|? git(["show", `${baseSha}:${policyPath}`])
CLAIM|20|一致|scripts/ci/check-policy.mjs:1357|旧写法要靠 `upgrade…` 函数一次性换成新写法|upgradeCoverageToTests(
CLAIM|21|一致|vitest.workspace.ts:41@1baa489cf71a94dc00e8816c189d8f0b59b52266|仓库只给 integration 设了 30 秒|testTimeout: 30_000,
CLAIM|22|找不到|-|上一次是 run 43657965830 的 `full / tooling` 作业（`artifact.test.mjs`、`prod-read.test.mjs` 各一条）|-
CLAIM|23|找不到|-|这一次是 run 43662602059 的 `full / tooling` 作业日志，原话 `prod-read.test.mjs > prod-read.sh lists capabilities as metadata only, running the script read-only` 和 `srt-version.test.mjs > SRT version single source passes the repository as checked in`，两条都是 `Error: STACK_TRACE_ERROR`|-
CLAIM|24|一致|scripts/ci/run.mjs:238|`scripts/ci/run.mjs` 给 tooling 起 vitest 时写的是 `"--maxWorkers",` 后跟 `"2",`|"--maxWorkers",
CLAIM|25|一致|ci/policy.json:98@1baa489cf71a94dc00e8816c189d8f0b59b52266|本仓库 main 上早已有策略|"id": "tests",
CLAIM|26|一致|test/tooling/source-inputs.test.mjs:37|tooling 里不少测试会起子进程、建临时 git 仓库|execFileSync("git", ["init", "--quiet", root]);
CLAIM|27|找不到|-|在 4 核的 ARM 机器上和 static 检查同时跑时会超过 5 秒|-

验证部分列出的 `[ADR-0275]` 用例属于拟新增验证，未按现状核对；ARM/tooling 两次运行日志、browser 后另外两个 runner 的实际空闲状态和 4 核 ARM 上超 5 秒的性能说法在仓库内没有证据，均标为找不到。决定和后果里拟改动或预期的内容也未计入现状。
