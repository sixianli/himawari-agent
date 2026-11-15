CLAIM|1|一致|docs/adr/0267-ci-tests-without-coverage-on-prs.md:58|按 ADR 0267，`ci.yml` 的 `tests` 作业在 CI 服务器上跑 unit、contracts、integration、e2e、pi-compat 五个测试项目。|`coverage` 作业改名 `tests`，仍在 CI 服务器上、仍等 policy 和 build，跑 unit、contracts、integration、e2e、pi-compat 五个项目。
CLAIM|2|一致|ci/policy.json:103@1baa489cf71a94dc00e8816c189d8f0b59b52266|拆分前 tests 作业只有一个 runner（一个矩阵成员）。|          "key": "default",
CLAIM|3|一致|.agents/evidence/ci-tests-split-2026-11-15.md:13|tests 作业依次跑这五个测试项目。|作业从 00:33:15Z 开始、01:23:33Z 结束，共约 50 分钟，其中五个项目依次跑约 46 分钟，前面装工具、装依赖、取构建约 3 分钟。
CLAIM|4|一致|.agents/evidence/ci-tests-split-2026-11-15.md:13|main 上一次完整运行里这个作业用了约 50 分钟。|作业从 00:33:15Z 开始、01:23:33Z 结束，共约 50 分钟，其中五个项目依次跑约 46 分钟，前面装工具、装依赖、取构建约 3 分钟。
CLAIM|5|一致|.agents/evidence/ci-tests-split-2026-11-15.md:9|其中 integration 一项约 34 分钟。|各项目用时表中 integration 为 2021 秒。
CLAIM|6|找不到|-|integration 是整次 CI 最慢的一段。|-
CLAIM|7|一致|.agents/evidence/ci-tests-split-2026-11-15.md:19|同一台机器上的另外两个检查 runner 在 browser 作业跑完后就空着。|同一次运行里 browser 作业 6 到 7 分钟就跑完，而 tests 作业在 `ci-vps-2` 上单独跑了约 50 分钟；这台机器上没有别的作业要跑，另外两个检查 runner 在 browser 作业跑完后空着。
CLAIM|8|一致|.agents/evidence/ci-tests-split-2026-11-15.md:25|ARM 机器上的 tooling 检查连续两次 main 运行各有两条测试因为超过 vitest 的 5 秒默认超时而失败。|- 上一次：run 43657965830 的 `full / tooling` 作业，`artifact.test.mjs`、`prod-read.test.mjs` 各一条测试超过 vitest 的 5 秒默认超时而失败。
CLAIM|9|一致|.agents/evidence/ci-tests-split-2026-11-15.md:27|两次失败的测试不全相同。|- 两次都各有两条测试超时，失败的测试不全相同：两次都有 `prod-read.test.mjs`，另一条一次是 `artifact.test.mjs`、一次是 `srt-version.test.mjs`。
CLAIM|10|一致|.agents/evidence/ci-tests-split-2026-11-15.md:9|拆分前 tests 作业 integration 2021 秒。|各项目用时表中 integration 为 2021 秒。
CLAIM|11|一致|.agents/evidence/ci-tests-split-2026-11-15.md:11|unit 596 秒。|各项目用时表中 unit 为 596 秒。
CLAIM|12|一致|.agents/evidence/ci-tests-split-2026-11-15.md:7|contracts 110 秒。|各项目用时表中 contracts 为 110 秒。
CLAIM|13|一致|.agents/evidence/ci-tests-split-2026-11-15.md:10|pi-compat 35 秒。|各项目用时表中 pi-compat 为 35 秒。
CLAIM|14|一致|.agents/evidence/ci-tests-split-2026-11-15.md:8|e2e 6 秒。|各项目用时表中 e2e 为 6 秒。
CLAIM|15|一致|.agents/evidence/ci-tests-split-2026-11-15.md:13|整个作业约 50 分钟。|作业从 00:33:15Z 开始、01:23:33Z 结束，共约 50 分钟，其中五个项目依次跑约 46 分钟，前面装工具、装依赖、取构建约 3 分钟。
CLAIM|16|一致|ci/policy.json:103@1baa489cf71a94dc00e8816c189d8f0b59b52266|拆分前 tests 只有一个矩阵成员。|          "key": "default",
CLAIM|17|一致|ci/policy.json:103@1baa489cf71a94dc00e8816c189d8f0b59b52266|main 上 `ci/policy.json` 的 tests 下只有 `"key": "default"` 一个成员。|          "key": "default",
CLAIM|18|一致|docs/runbooks/ci-vps-runner-runbook.md:38|CI 服务器有三个检查 runner。|`ci-vps-1`、`ci-vps-2` 和 `ci-vps-3`（脚本里的编号是 1、2、6）是检查 runner
CLAIM|19|一致|docs/runbooks/ci-vps-runner-runbook.md:17|三个检查 runner 共用 8 个 vCPU、22 GB 内存。|8 个 vCPU，22 GB 内存
CLAIM|20|一致|docs/runbooks/ci-vps-runner-runbook.md:67|三个检查 runner 合计内存上限 16 GB。|三个检查 runner 的服务都放在 `gh-runners.slice`（把几个服务放进同一个资源分组、一起设上限的单元）里，合计内存最多 16 GB（`MemoryHigh=15G`、`MemoryMax=16G`），最多 6144 个进程。
CLAIM|21|一致|scripts/ci/test-concurrency.mjs:4|integration 每次最多开 3 个 worker。|  maximum: 3,
CLAIM|22|一致|scripts/ci/test-concurrency.mjs:13|其他项目只开 1 个 worker。|  if (!project.fileParallelism || !project.workerLimits) return 1;
CLAIM|23|一致|scripts/ci/test.mjs:139|`scripts/ci/test.mjs` 每次跑完都核对 vitest 实际跑的文件是不是正好等于该跑的文件，不等就失败。|      throw new Error(`CI_TEST_FILE_SET_MISMATCH:${id}`);
CLAIM|24|一致|scripts/ci/check-policy.mjs:1353|PR 和 main 上的 CI 都按基准提交上的 `ci/policy.json` 执行。|    ? git(["show", `${baseSha}:${policyPath}`])
CLAIM|25|一致|scripts/ci/check-policy.mjs:1357|旧写法要靠 `upgrade…` 函数一次性换成新写法，后面依次调用 `upgradeCoverageToTests(`、`upgradeArmRunnerPolicy(` 等。|      upgradeCoverageToTests(
CLAIM|26|一致|vitest.workspace.ts:39@1baa489cf71a94dc00e8816c189d8f0b59b52266|仓库拆分前只给 integration 设了 30 秒超时。|          ...(project.id === "integration"
CLAIM|27|一致|.agents/evidence/ci-tests-split-2026-11-15.md:25|上一次是 run 43657965830 的 `full / tooling` 作业（`artifact.test.mjs`、`prod-read.test.mjs` 各一条）。|- 上一次：run 43657965830 的 `full / tooling` 作业，`artifact.test.mjs`、`prod-read.test.mjs` 各一条测试超过 vitest 的 5 秒默认超时而失败。
CLAIM|28|一致|.agents/evidence/ci-tests-split-2026-11-15.md:26|这一次是 run 43662602059 的 `full / tooling` 作业日志，两条都是 `Error: STACK_TRACE_ERROR`。|- 这一次：run 43662602059 的 `full / tooling` 作业日志，失败的两条是 `prod-read.test.mjs > prod-read.sh lists capabilities as metadata only, running the script read-only` 和 `srt-version.test.mjs > SRT version single source passes the repository as checked in`，两条都是 `Error: STACK_TRACE_ERROR`。
CLAIM|29|一致|ci/policy.json:103|`ci/policy.json` 里 tests 的成员现在是 `integration-1`、`integration-2`、`others` 三个。|          "key": "integration-1",
CLAIM|30|一致|ci/policy.json:109|`integration-1` 跑 integration 的一半，`"shard": { "index": 1, "count": 2 }`。|          "shard": { "index": 1, "count": 2 }
CLAIM|31|一致|ci/policy.json:118|`integration-2` 的 shard 是 `index: 2`。|          "shard": { "index": 2, "count": 2 }
CLAIM|32|一致|ci/policy.json:126|`others` 跑 unit、contracts、e2e、pi-compat。|          "projects": ["unit", "contracts", "e2e", "pi-compat"]
CLAIM|33|一致|ci/policy.schema.json:85|成员上新加的 `projects` 字段写进 `ci/policy.schema.json`。|                "projects": {
CLAIM|34|一致|ci/policy.schema.json:93|成员上新加的 `shard` 字段写进 `ci/policy.schema.json`。|                "shard": {
CLAIM|35|一致|scripts/ci/test.mjs:56|全量分片时用 `git ls-files --cached` 列出的已提交文件。|    shard ? ["--cached"] : ["--cached", "--others", "--exclude-standard"],
CLAIM|36|一致|scripts/ci/test.mjs:74|PR 上只跑相关测试时用相关的那些文件。|    const candidates = (related.get(id) ?? trackedFiles)
CLAIM|37|一致|scripts/ci/test.mjs:80|候选文件按路径排序。|      .sort();
CLAIM|38|一致|scripts/ci/test.mjs:82|第 i 个文件归第 `i % count + 1` 份。|      ? candidates.filter((_filename, index) => index % shard.count === shard.index - 1)
CLAIM|39|一致|scripts/ci/test.mjs:110|每份把自己的文件名明确交给 vitest。|        ...(selected ?? []),
CLAIM|40|一致|scripts/ci/check-policy.mjs:430|`validatePolicy` 要求 tests 正好是这三个成员。|            ? testsMembers.map((member) => member.key)
CLAIM|41|一致|scripts/ci/check-policy.mjs:491|每个项目在成员之间恰好跑一次。|    assert(whole || sharded, `Tests project must run exactly once across members: ${id}`);
CLAIM|42|一致|scripts/ci/check-policy.mjs:475|分片成员只能跑一个项目。|      !member.shard || member.projects.length === 1,
CLAIM|43|一致|scripts/ci/check-policy.mjs:465|tests 以外的作业不能写 `projects`、`shard`。|    assert(!split, `Only tests members may split projects: ${check.id}`);
CLAIM|44|一致|scripts/ci/check-policy.mjs:628|工作流的矩阵仍须和策略逐字一致。|        sameSet(matrix.include.map(canonical), activeMembers(check).map(canonical)),
CLAIM|45|一致|scripts/ci/check-policy.mjs:161|基准上还是单个 `default` 成员的策略，由新的 `upgradeSplitTests` 换成三个成员。|  if (!tests || canonicalJson(tests.members) !== canonicalJson([ciVpsDefaultMember])) return policy;
CLAIM|46|一致|scripts/ci/aggregate.mjs:100|汇总按每个成员自己的项目核对报上来的项目。|    const memberProjects = member.projects ?? check.projects;
CLAIM|47|一致|scripts/ci/aggregate.mjs:193|三个成员缺一个就不过。|    fail(check.id, member.key, "reports", "Missing required matrix member report");
CLAIM|48|一致|ci/evidence.schema.json:138|证据导出的检查条数下限现在是 11。|      "minItems": 11,
CLAIM|49|一致|ci/evidence.schema.json:139|证据导出的检查条数上限现在是 12。|      "maxItems": 12,
CLAIM|50|一致|ci/evidence.schema.json:138@1baa489cf71a94dc00e8816c189d8f0b59b52266|证据导出的检查条数原来下限是 9。|      "minItems": 9,
CLAIM|51|一致|ci/evidence.schema.json:139@1baa489cf71a94dc00e8816c189d8f0b59b52266|证据导出的检查条数原来上限是 10。|      "maxItems": 10,
CLAIM|52|一致|scripts/ci/run.mjs:354|`--coverage measure` 统计覆盖率时在那一台上跑全部项目。|      const plainProjects = (measure ? check.projects : (member.projects ?? check.projects)).filter(
CLAIM|53|一致|scripts/ci/run.mjs:436|统计覆盖率时不分片。|            shard: measure ? undefined : member.shard,
CLAIM|54|一致|scripts/ci/run.mjs:332|仓库第一次接入、基准上没有 `ci/policy.json` 时，`--baseline-candidate initial-only` 会让三个成员都统计全部项目。|      const measure = coverage === "measure" || candidate !== undefined;
CLAIM|55|一致|.agents/evidence/ci-tests-split-2026-11-15.md:35|本仓库 main 上早已有策略。|`ci/policy.json` 第 98–110 行，tests 只有一个成员 `default`，依次跑五个项目：
CLAIM|56|一致|scripts/ci/local.mjs:84|`scripts/ci/local.mjs` 在本机依次跑三个成员。|    for (const member of testsMembers) await execute("tests", member.key, built);
CLAIM|57|一致|vitest.workspace.ts:48|`vitest.workspace.ts` 给 tooling 项目也设 `testTimeout: 30_000`。|          ...(project.id === "tooling" ? { env: toolingEnvironment, testTimeout: 30_000 } : {}),
CLAIM|58|一致|vitest.workspace.ts:41|integration 也带 30 秒超时。|                testTimeout: 30_000,
CLAIM|59|一致|.agents/evidence/ci-tests-split-2026-11-15.md:29|tooling 里不少测试会起子进程、建临时 git 仓库。|`test/tooling/` 下 101 个测试文件里，59 个起子进程（用 `spawnSync` 或 `execFileSync`），29 个建临时 git 仓库（`git init`）
CLAIM|60|一致|docs/runbooks/ci-vps-runner-runbook.md:180|ARM 机器是 4 核，static 和 tooling 都在这台机器上跑。|第二处 runner 装在 Andy 的 Oracle 东京 ARM 机器上（Ubuntu 24.04，处理器是 64 位 ARM，系统里显示为 `aarch64`；4 核 24 GB，公网地址 `138.2.31.252`，这台机器同时是测试机）。
CLAIM|61|一致|.agents/evidence/ci-tests-split-2026-11-15.md:28|这些测试没有卡住，只是慢。|- 再下一次：run 43666353293（main 上 1baa489cf）的 `full / tooling` 作业没有任何测试失败，结论是 `success`，所以这些测试不是卡住，只是有时超过 5 秒。
CLAIM|62|一致|ci/policy.json:70|三个检查 runner 还要跑三个 browser 作业。|          "key": "chromium",
CLAIM|63|一致|docs/runbooks/ci-vps-runner-runbook.md:67|三台合计内存上限是 16 GB。|三个检查 runner 的服务都放在 `gh-runners.slice`（把几个服务放进同一个资源分组、一起设上限的单元）里，合计内存最多 16 GB（`MemoryHigh=15G`、`MemoryMax=16G`），最多 6144 个进程。
CLAIM|64|一致|scripts/ci/run.mjs:238|`scripts/ci/run.mjs` 给 tooling 起 vitest 时写的是 `"--maxWorkers",` 后跟 `"2",`。|          "--maxWorkers",
CLAIM|65|一致|.agents/evidence/ci-tests-split-2026-11-15.md:15|browser 作业约 6 到 7 分钟。|同一次运行里，三个 browser 作业各用 6 到 7 分钟（另一次运行 run 43662602059：chromium 01:33:48Z–01:40:08Z，webkit 01:33:48Z–01:40:59Z）。
CLAIM|66|一致|scripts/ci/test.mjs:82|PR 上只跑相关测试时，两份各自分到相关文件的一半。|      ? candidates.filter((_filename, index) => index % shard.count === shard.index - 1)
CLAIM|67|一致|scripts/ci/run.mjs:538|某一份分到零个文件时，这一份按“相关测试为零”记为通过。|      memberProjects.every((id) => result.relatedProjects?.includes(id)) &&
CLAIM|68|一致|scripts/ci/test.mjs:61@1baa489cf71a94dc00e8816c189d8f0b59b52266|和以前整个项目没有相关测试时一样。|    if (selected?.length === 0) {
CLAIM|69|一致|scripts/ci/run.mjs:546|全量运行里某一份分到零个文件会被当成没跑测试而失败。|      throw new Error("CI_INCOMPLETE_EXECUTION");
CLAIM|70|一致|scripts/ci/run.mjs:354|仓库第一次接入时让三个成员都统计全部项目，汇总按每个成员自己的项目核对，这种运行会不过。|      const plainProjects = (measure ? check.projects : (member.projects ?? check.projects)).filter(
CLAIM|71|一致|test/tooling/policy.test.mjs:1358|`test/tooling/policy.test.mjs` 的 `[ADR-0275]` 用例里，现行策略就是三个成员。|    expect(policy.checks.find((check) => check.id === "tests").members).toEqual(testsMembers);
CLAIM|72|一致|test/tooling/policy.test.mjs:1364|基准上的单成员写法升级一次。|    expect(upgradeSplitTests(single)).toEqual(policy);
CLAIM|73|一致|test/tooling/policy.test.mjs:1373|摘要仍按原始字节算。|    expect(selected.policySha256).toBe(sha256(JSON.stringify(single)));
CLAIM|74|一致|test/tooling/policy.test.mjs:1441|少一份、编号重复、份数不符、项目没人跑、项目跑两次、分片成员带两个项目、跑 tests 以外的项目、成员不写项目，都被拒。|  ])("[ADR-0275] 反向：tests 拆分写错（%s）时策略被拒", (_name, mutate, message) => {
CLAIM|75|一致|test/tooling/policy.test.mjs:1450|tests 以外的作业写拆分被拒。|    expect(() => validatePolicy(value)).toThrow("Only tests members may split projects: tooling");
CLAIM|76|一致|test/tooling/policy.test.mjs:1458|工作流矩阵和策略不一致时被拒。|      "Matrix members differ: tests",
CLAIM|77|一致|test/tooling/pipeline.test.mjs:373|五个文件分两份是第 1、3、5 个和第 2、4 个，合起来正好全部。|      expect(named).toEqual(files.filter((_file, position) => position % 2 === index - 1));
CLAIM|78|一致|test/tooling/pipeline.test.mjs:388|vitest 多跑了不属于这一份的文件时失败。|    ).rejects.toThrow("CI_TEST_FILE_SET_MISMATCH:integration");
CLAIM|79|一致|test/tooling/pipeline.test.mjs:400|份数写错时一个测试都不跑。|    expect(mocks.execute).not.toHaveBeenCalled();
CLAIM|80|一致|test/tooling/aggregate.test.mjs:212|三个成员各报自己的项目时通过。|    expect(aggregate(input).status).toBe("passed");
CLAIM|81|一致|test/tooling/aggregate.test.mjs:226|分片多报项目时不过。|      "Project count set differs from policy",
CLAIM|82|一致|test/tooling/aggregate.test.mjs:235|少一个成员时不过。|    expect(missing.missing).toContain("tests/integration-2");
CLAIM|83|一致|test/tooling/test-timeout.test.mjs:38|`test/tooling/test-timeout.test.mjs` 里只有 integration 和 tooling 带 30 秒超时。|    for (const name of ["integration", "tooling"])

未核实或无法核对的部分：我没有查 GitHub 上的实际运行日志，只核对了 `.agents/evidence/ci-tests-split-2026-11-15.md` 里的记录；也没有核对 vitest 官方文档所说的 5 秒默认值、`--shard` 内部算法等第三方行为，以及“integration 是整次 CI 最慢的一段”“不是并发出错”这类没有在仓库材料里直接读到依据的说法。
