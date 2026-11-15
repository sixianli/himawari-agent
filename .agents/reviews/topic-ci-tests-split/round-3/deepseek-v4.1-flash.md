CLAIM|1|一致|docs/adr/0267-ci-tests-without-coverage-on-prs.md:58|按 ADR 0267，ci.yml 的 tests 作业在 CI 服务器的一个 runner 上依次跑 unit、contracts、integration、e2e、pi-compat 五个测试项目。|`coverage` 作业改名 `tests`，仍在 CI 服务器上、仍等 policy 和 build，跑 unit、contracts、integration、e2e、pi-compat 五个项目。
CLAIM|2|一致|.github/workflows/ci.yml:236@1baa489cf71a94dc00e8816c189d8f0b59b52266|ci.yml 的 tests 作业在 CI 服务器的一个 runner 上运行。|    runs-on: ci-vps
CLAIM|3|一致|ci/policy.json:110@1baa489cf71a94dc00e8816c189d8f0b59b52266|tests 作业跑 unit、contracts、integration、e2e、pi-compat 五个测试项目。|      "projects": ["unit", "contracts", "integration", "e2e", "pi-compat"],
CLAIM|4|一致|scripts/ci/test.mjs:59@1baa489cf71a94dc00e8816c189d8f0b59b52266|这五个测试项目依次跑。|  for (const id of selection) {
CLAIM|5|一致|.agents/evidence/ci-tests-split-2026-11-15.md:13|main 上一次完整运行里 tests 作业用了约 50 分钟。|作业从 00:33:15Z 开始、01:23:33Z 结束，共约 50 分钟，其中五个项目依次跑约 46 分钟，前面装工具、装依赖、取构建约 3 分钟。
CLAIM|6|一致|.agents/evidence/ci-tests-split-2026-11-15.md:9|其中 integration 一项就 34 分钟。|| integration | 2021 秒（`"durationMs":2021486`，这一次有失败，已由 PR 537 修好） |
CLAIM|7|一致|.agents/evidence/ci-tests-split-2026-11-15.md:19|integration 是整次 CI 最慢的一段。|同一次运行里 browser 作业 6 到 7 分钟就跑完，而 tests 作业在 `ci-vps-2` 上单独跑了约 50 分钟；这台机器上没有别的作业要跑，另外两个检查 runner 在 browser 作业跑完后空着。
CLAIM|8|一致|.agents/evidence/ci-tests-split-2026-11-15.md:19|同一台机器上的另外两个检查 runner 在 browser 作业跑完后空着。|同一次运行里 browser 作业 6 到 7 分钟就跑完，而 tests 作业在 `ci-vps-2` 上单独跑了约 50 分钟；这台机器上没有别的作业要跑，另外两个检查 runner 在 browser 作业跑完后空着。
CLAIM|9|一致|.agents/evidence/ci-tests-split-2026-11-15.md:27|ARM 机器上的 tooling 检查连续两次 main 运行各有两条测试超时。|- 两次都各有两条测试超时，失败的测试不全相同：两次都有 `prod-read.test.mjs`，另一条一次是 `artifact.test.mjs`、一次是 `srt-version.test.mjs`。
CLAIM|10|一致|.agents/evidence/ci-tests-split-2026-11-15.md:27|两次失败的测试不全相同。|- 两次都各有两条测试超时，失败的测试不全相同：两次都有 `prod-read.test.mjs`，另一条一次是 `artifact.test.mjs`、一次是 `srt-version.test.mjs`。
CLAIM|11|一致|.agents/evidence/ci-tests-split-2026-11-15.md:9|拆分前 integration 用时 2021 秒。|| integration | 2021 秒（`"durationMs":2021486`，这一次有失败，已由 PR 537 修好） |
CLAIM|12|一致|.agents/evidence/ci-tests-split-2026-11-15.md:11|拆分前 unit 用时 596 秒。|| unit | 596 秒（`"durationMs":596203`） |
CLAIM|13|一致|.agents/evidence/ci-tests-split-2026-11-15.md:7|拆分前 contracts 用时 110 秒。|| contracts | 110 秒（`"durationMs":110063`） |
CLAIM|14|一致|.agents/evidence/ci-tests-split-2026-11-15.md:10|拆分前 pi-compat 用时 35 秒。|| pi-compat | 35 秒（`"durationMs":34800`） |
CLAIM|15|一致|.agents/evidence/ci-tests-split-2026-11-15.md:8|拆分前 e2e 用时 6 秒。|| e2e | 6 秒（`"durationMs":5872`） |
CLAIM|16|一致|.agents/evidence/ci-tests-split-2026-11-15.md:13|拆分前整个 tests 作业约 50 分钟。|作业从 00:33:15Z 开始、01:23:33Z 结束，共约 50 分钟，其中五个项目依次跑约 46 分钟，前面装工具、装依赖、取构建约 3 分钟。
CLAIM|17|一致|.agents/evidence/ci-tests-split-2026-11-15.md:9|证据文件里有原话 `"durationMs":2021486`。|| integration | 2021 秒（`"durationMs":2021486`，这一次有失败，已由 PR 537 修好） |
CLAIM|18|一致|.agents/evidence/ci-tests-split-2026-11-15.md:13|证据文件里有“共约 50 分钟”。|作业从 00:33:15Z 开始、01:23:33Z 结束，共约 50 分钟，其中五个项目依次跑约 46 分钟，前面装工具、装依赖、取构建约 3 分钟。
CLAIM|19|一致|ci/policy.json:103@1baa489cf71a94dc00e8816c189d8f0b59b52266|拆分前 tests 只有一个矩阵成员。|          "key": "default",
CLAIM|20|一致|docs/runbooks/ci-vps-runner-runbook.md:67|CI 服务器有三个检查 runner，三个合计内存上限 16 GB。|三个检查 runner 的服务都放在 `gh-runners.slice`（把几个服务放进同一个资源分组、一起设上限的单元）里，合计内存最多 16 GB（`MemoryHigh=15G`、`MemoryMax=16G`），最多 6144 个进程。
CLAIM|21|一致|docs/runbooks/ci-vps-runner-runbook.md:17|CI 服务器共用 8 个 vCPU、22 GB 内存。|本手册说明 CI VPS（Andy 在 OVH 租的云服务器，Ubuntu 24.04，8 个 vCPU，22 GB 内存，公网地址 `158.69.191.249`，主机名 `ci-vps`）上的 GitHub 自托管 runner
CLAIM|22|一致|scripts/ci/test-concurrency.mjs:4|integration 每次最多开 3 个 worker。|  maximum: 3,
CLAIM|23|一致|scripts/ci/test-concurrency.mjs:13|其他项目只开 1 个 worker。|  if (!project.fileParallelism || !project.workerLimits) return 1;
CLAIM|24|一致|scripts/ci/test.mjs:138|每次跑完，scripts/ci/test.mjs 都核对 vitest 实际跑的文件是不是正好等于该跑的文件。|    if (JSON.stringify(expectedFiles) !== JSON.stringify(actualFiles))
CLAIM|25|一致|scripts/ci/test.mjs:139|核对不等就失败。|      throw new Error(`CI_TEST_FILE_SET_MISMATCH:${id}`);
CLAIM|26|一致|scripts/ci/check-policy.mjs:1353|PR 和 main 上的 CI 都按基准提交上的 ci/policy.json 执行。|    ? git(["show", `${baseSha}:${policyPath}`])
CLAIM|27|一致|scripts/ci/check-policy.mjs:1357|旧写法后面依次调用 `upgradeCoverageToTests`、`upgradeArmRunnerPolicy` 等 upgrade 函数换成新写法。|      upgradeCoverageToTests(
CLAIM|28|一致|vitest.workspace.ts:41@1baa489cf71a94dc00e8816c189d8f0b59b52266|仓库只给 integration 设了 30 秒超时，只在 `project.id === "integration"` 分支里。|                testTimeout: 30_000,
CLAIM|29|一致|.agents/evidence/ci-tests-split-2026-11-15.md:25|上一次 run 43657965830 的 full / tooling 作业有一条 artifact.test.mjs 测试超时。|- 上一次：run 43657965830 的 `full / tooling` 作业，`artifact.test.mjs`、`prod-read.test.mjs` 各一条测试超过 vitest 的 5 秒默认超时而失败。
CLAIM|30|一致|.agents/evidence/ci-tests-split-2026-11-15.md:25|上一次 run 43657965830 的 full / tooling 作业有一条 prod-read.test.mjs 测试超时。|- 上一次：run 43657965830 的 `full / tooling` 作业，`artifact.test.mjs`、`prod-read.test.mjs` 各一条测试超过 vitest 的 5 秒默认超时而失败。
CLAIM|31|一致|.agents/evidence/ci-tests-split-2026-11-15.md:26|这一次 run 43662602059 的 full / tooling 作业日志里失败的一条是 prod-read.test.mjs > prod-read.sh lists capabilities as metadata only, running the script read-only。|- 这一次：run 43662602059 的 `full / tooling` 作业日志，失败的两条是 `prod-read.test.mjs > prod-read.sh lists capabilities as metadata only, running the script read-only` 和 `srt-version.test.mjs > SRT version single source passes the repository as checked in`，两条都是 `Error: STACK_TRACE_ERROR`。
CLAIM|32|一致|.agents/evidence/ci-tests-split-2026-11-15.md:26|这一次 run 43662602059 的 full / tooling 作业日志里失败的另一条是 srt-version.test.mjs > SRT version single source passes the repository as checked in。|- 这一次：run 43662602059 的 `full / tooling` 作业日志，失败的两条是 `prod-read.test.mjs > prod-read.sh lists capabilities as metadata only, running the script read-only` 和 `srt-version.test.mjs > SRT version single source passes the repository as checked in`，两条都是 `Error: STACK_TRACE_ERROR`。
CLAIM|33|一致|.agents/evidence/ci-tests-split-2026-11-15.md:26|这两条失败都是 `Error: STACK_TRACE_ERROR`。|- 这一次：run 43662602059 的 `full / tooling` 作业日志，失败的两条是 `prod-read.test.mjs > prod-read.sh lists capabilities as metadata only, running the script read-only` 和 `srt-version.test.mjs > SRT version single source passes the repository as checked in`，两条都是 `Error: STACK_TRACE_ERROR`。
CLAIM|34|一致|scripts/ci/run.mjs:238|scripts/ci/run.mjs 给 tooling 起 vitest 时写的是 `"--maxWorkers",` 后跟 `"2",`。|          "--maxWorkers",
CLAIM|35|找不到|-|tooling 里不少测试会起子进程、建临时 git 仓库。|-
CLAIM|36|找不到|-|这些测试在 4 核的 ARM 机器上和 static 检查同时跑时会超过 5 秒；这些测试没有卡住，只是慢。|-
CLAIM|37|一致|test/tooling/policy.test.mjs:1358|test/tooling/policy.test.mjs 的 `[ADR-0275]` 用例断言现行策略就是三个成员。|    expect(policy.checks.find((check) => check.id === "tests").members).toEqual(testsMembers);
CLAIM|38|一致|test/tooling/policy.test.mjs:1364|基准上的单成员写法升级一次。|    expect(upgradeSplitTests(single)).toEqual(policy);
CLAIM|39|一致|test/tooling/policy.test.mjs:1373|基准上的单成员写法升级后摘要仍按原始字节算。|    expect(selected.policySha256).toBe(sha256(JSON.stringify(single)));
CLAIM|40|一致|test/tooling/policy.test.mjs:1383|少一份分片会被拒。|      "Incomplete matrix: tests",
CLAIM|41|一致|test/tooling/policy.test.mjs:1391|分片编号重复会被拒。|      "Tests project must run exactly once across members: integration",
CLAIM|42|一致|test/tooling/policy.test.mjs:1399|分片总数和份数不符会被拒。|      "Tests project must run exactly once across members: integration",
CLAIM|43|一致|test/tooling/policy.test.mjs:1407|一个项目没人跑会被拒。|      "Tests project must run exactly once across members: e2e",
CLAIM|44|一致|test/tooling/policy.test.mjs:1415|一个项目跑了两次会被拒。|      "Tests project must run exactly once across members: integration",
CLAIM|45|一致|test/tooling/policy.test.mjs:1423|分片成员带两个项目会被拒。|      "Sharded tests member must run exactly one project: integration-1",
CLAIM|46|一致|test/tooling/policy.test.mjs:1431|成员跑 tests 以外的项目会被拒。|      "Split tests member runs a project outside tests: others",
CLAIM|47|一致|test/tooling/policy.test.mjs:1439|成员不写项目会被拒。|      "Split tests member names no projects: others",
CLAIM|48|一致|test/tooling/policy.test.mjs:1450|tests 以外的作业写拆分会被拒。|    expect(() => validatePolicy(value)).toThrow("Only tests members may split projects: tooling");
CLAIM|49|一致|test/tooling/policy.test.mjs:1458|工作流矩阵和策略不一致会被拒。|      "Matrix members differ: tests",
CLAIM|50|一致|test/tooling/pipeline.test.mjs:373|test/tooling/pipeline.test.mjs 的 `[ADR-0275]` 用例中五个文件分两份是第 1、3、5 个和第 2、4 个。|      expect(named).toEqual(files.filter((_file, position) => position % 2 === index - 1));
CLAIM|51|一致|test/tooling/pipeline.test.mjs:381|两份合起来正好是全部文件。|      ["a", "b", "c", "d", "e"].map((n) => `test/integration/${n}.test.ts`),
CLAIM|52|一致|test/tooling/pipeline.test.mjs:388|vitest 多跑了不属于这一份的文件时失败。|    ).rejects.toThrow("CI_TEST_FILE_SET_MISMATCH:integration");
CLAIM|53|一致|test/tooling/pipeline.test.mjs:400|份数写错时一个测试都不跑。|    expect(mocks.execute).not.toHaveBeenCalled();
CLAIM|54|一致|test/tooling/aggregate.test.mjs:212|test/tooling/aggregate.test.mjs 的 `[ADR-0275]` 用例中三个成员各报自己的项目时通过。|    expect(aggregate(input).status).toBe("passed");
CLAIM|55|一致|test/tooling/aggregate.test.mjs:226|分片多报项目时不过。|      "Project count set differs from policy",
CLAIM|56|一致|test/tooling/aggregate.test.mjs:234|少一个成员时不过。|    expect(missing.status).toBe("failed");
CLAIM|57|一致|test/tooling/test-timeout.test.mjs:38|test/tooling/test-timeout.test.mjs 断言只有 integration 和 tooling 带 30 秒超时。|    for (const name of ["integration", "tooling"])

未核对的部分：tooling 测试是否大量起子进程、建临时 git 仓库，以及它们只是慢而非卡住的运行时判断，仓库里没有可直接逐字证明的代码或文档，均标为找不到；vitest 官方文档和 `--shard` 行为按题目要求未计入。
