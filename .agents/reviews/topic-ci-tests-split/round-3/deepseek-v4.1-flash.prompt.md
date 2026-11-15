你是方案里“关于代码和文档现状的说法”的核对者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
下面是一份还没合并的方案或 ADR。第一步，把其中每一句讲代码或仓库文档现状的话都列出来：某个文件、函数、字段、配置、命令、数字、规则现在是什么样、做什么、不做什么；一句话里有几个说法就拆成几条。方案打算新增或修改什么，不算现状；讲外部网站、第三方产品的话也不算。第二步，逐条自己打开对应的文件核对，给出：一致、不一致、找不到（仓库里没有这个东西，或没读到能证明它的内容）。方案里讲“原来”“已删除”“改之前”的旧代码，在材料里给出的基线提交里找：证据位置写成 文件:行@完整提交哈希，代码原文取自那个提交里的文件；这样写只限于当前提交里已经没有这段原文的旧代码，讲现状的句子仍然用当前提交里的文件和行。材料里的说法可能有错，写得再肯定也不能因此判一致；没有亲自读到对应代码，就判找不到。只核对事实，不评价方案好不好，不提建议。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
输出格式：每个说法单独一行，不换行，字段之间用竖线分隔，行首写 CLAIM：
CLAIM|<序号>|<一致 或 不一致 或 找不到>|<文件:行 或 文件:行@完整提交哈希>|<方案原句>|<代码原文>
序号用 1、2、3……，不重复。文件:行 写你读到证据的那个文件和行号，例如 packages/x/src/y.ts:42；找不到时写 -。代码原文必须是你亲自读到的、逐字摘抄的一行或几行，不要改写、不要概括；方案原句里的竖线字符换成全角的“｜”，代码原文里的竖线照原样写。列完所有 CLAIM 行之后，另起一段，用一两句话写你没能核对的部分。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 5db1fdd1e024851dd3f69298c13feb1aa37c7a88。
本 PR 的基线提交是 1baa489cf71a94dc00e8816c189d8f0b59b52266（main 与 5db1fdd1e024851dd3f69298c13feb1aa37c7a88 的共同祖先）。
待核对的方案：
方案文件：docs/adr/0275-tests-job-runs-on-three-runners.md（在提交 5db1fdd1e024851dd3f69298c13feb1aa37c7a88 里的内容）

---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: ""
date: "2026-11-15"
---

# ADR 0275：tests 作业拆成三台并行，tooling 测试超时放到 30 秒

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提和来源](#premises)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [验证](#verification)

<a id="context"></a>

## 背景

按 [ADR 0267](0267-ci-tests-without-coverage-on-prs.md)，`ci.yml` 的 `tests` 作业在 CI 服务器的一个 runner（替 GitHub 执行 CI 任务的程序）上依次跑 unit、contracts、integration、e2e、pi-compat 五个测试项目。main 上一次完整运行里这个作业用了约 50 分钟，其中 integration 一项就 34 分钟，是整次 CI 最慢的一段；同一台机器上的另外两个检查 runner 在 browser 作业跑完后就空着（用时见 `.agents/evidence/ci-tests-split-2026-11-15.md`）。

另外，ARM 机器上的 `tooling` 检查连续两次 main 运行各有两条测试因为超过 vitest 的 5 秒默认超时而失败，两次失败的测试不全相同（同一份证据文件的“ARM 上 tooling 测试超时”一节）。

<a id="premises"></a>

## 前提和来源

1. 拆分前 tests 作业的用时：integration 2021 秒、unit 596 秒、contracts 110 秒、pi-compat 35 秒、e2e 6 秒，整个作业约 50 分钟。来源：`.agents/evidence/ci-tests-split-2026-11-15.md`，原话 `"durationMs":2021486`、“共约 50 分钟”。
2. 拆分前 tests 只有一个矩阵成员。来源：main 上 `ci/policy.json` 第 98–109 行，原话 `"id": "tests"` 下的 `"key": "default"`。
3. CI 服务器有三个检查 runner，共用 8 个 vCPU、22 GB 内存，三个合计内存上限 16 GB。来源：`docs/runbooks/ci-vps-runner-runbook.md` 第 17 行原话“8 个 vCPU，22 GB 内存”，第 67 行原话“合计内存最多 16 GB”。
4. integration 每次最多开 3 个 worker（同时跑测试的子进程），其他项目只开 1 个。来源：`scripts/ci/test-concurrency.mjs` 第 4 行 `maximum: 3`，以及同一文件 `if (!project.fileParallelism || !project.workerLimits) return 1;`。
5. vitest 官方的拆分做法是按测试文件分份、每份放一台机器，用 GitHub Actions 矩阵跑。来源：https://vitest.dev/guide/improving-performance ，原话 “Vitest splits your test files, not your test cases, into shards.”，示例矩阵 `shardIndex: [1, 2, 3, 4]`。
6. 每次跑完，`scripts/ci/test.mjs` 都核对 vitest 实际跑的文件是不是正好等于该跑的文件，不等就失败。来源：`scripts/ci/test.mjs`，原话 ``throw new Error(`CI_TEST_FILE_SET_MISMATCH:${id}`);``。
7. PR 和 main 上的 CI 都按基准提交上的 `ci/policy.json` 执行，旧写法要靠 `upgrade…` 函数一次性换成新写法。来源：`scripts/ci/check-policy.mjs` 的 `resolvePolicySource`，原话 ``git(["show", `${baseSha}:${policyPath}`])``，后面依次调用 `upgradeCoverageToTests(`、`upgradeArmRunnerPolicy(` 等。
8. vitest 默认每条测试 5 秒超时；仓库只给 integration 设了 30 秒。来源：main 上 `vitest.workspace.ts` 第 41 行 `testTimeout: 30_000,`（只在 `project.id === "integration"` 分支里）；vitest 默认值见 https://vitest.dev/config/testtimeout ，原话 “Default: `5_000` in Node.js”。
9. ARM 上连续两次各有两条 tooling 测试报超时，两次失败的测试不全相同。来源：上一次是 run 43657965830 的 `full / tooling` 作业（`artifact.test.mjs`、`prod-read.test.mjs` 各一条），这一次是 run 43662602059 的 `full / tooling` 作业日志，原话 `prod-read.test.mjs > prod-read.sh lists capabilities as metadata only, running the script read-only` 和 `srt-version.test.mjs > SRT version single source passes the repository as checked in`，两条都是 `Error: STACK_TRACE_ERROR`。

<a id="decision"></a>

## 决定

### tests 拆成三个矩阵成员

- `ci/policy.json` 里 tests 的成员从一个 `default` 换成三个：`integration-1`、`integration-2` 各跑 integration 的一半（`"shard": { "index": 1, "count": 2 }` 和 `index: 2`），`others` 跑 unit、contracts、e2e、pi-compat。成员上新加的 `projects`、`shard` 两个字段写进 `ci/policy.schema.json`。
- 分份办法：把这个项目该跑的测试文件（全量时是 `git ls-files --cached` 列出的、已提交且符合 include、exclude 的文件，PR 上只跑相关测试时是相关的那些）按路径排序，从 0 开始数，第 i 个文件归第 `i % count + 1` 份。只用已提交的文件，是为了让各台机器分到的清单一致：同一个提交检出的已提交文件相同，没提交的文件各台可能不同。每份把自己的文件名明确交给 vitest，`CI_TEST_FILE_SET_MISMATCH` 核对照旧生效：多跑或少跑一个文件都失败。
- `scripts/ci/check-policy.mjs` 的 `validatePolicy` 要求 tests 正好是这三个成员；每个项目在成员之间恰好跑一次（要么一个成员整个跑，要么几个成员的 `shard` 正好是 1/N 到 N/N）；分片成员只能跑一个项目；tests 以外的作业不能写 `projects`、`shard`。工作流的矩阵仍须和策略逐字一致。
- 基准上还是单个 `default` 成员的策略，由新的 `upgradeSplitTests` 换成三个成员，所以这个 PR 自己的 CI 和合并后的 main 用的是同一种写法。
- 汇总（`scripts/ci/aggregate.mjs`）按每个成员自己的项目核对报上来的项目，三个成员缺一个就不过。证据导出的检查条数上下限从 9、10 改成 11、12。
- `--coverage measure`（统计覆盖率）不分片：在哪个成员上统计，就在那一台上跑全部项目，因为覆盖率要所有项目在同一份报告里。已知的限制：仓库第一次接入（基准上没有 `ci/policy.json`）时，tests 作业带的 `--baseline-candidate initial-only` 会让三个成员都这样统计，而汇总按每个成员自己的项目核对，这种运行会不过。本仓库 main 上早已有策略，这条路走不到；以后要在新仓库第一次接入时，先让 tests 只有一个成员。
- `scripts/ci/local.mjs` 在本机依次跑三个成员。

### tooling 测试超时放到 30 秒

`vitest.workspace.ts` 给 tooling 项目也设 `testTimeout: 30_000`，和 integration 一样。tooling 里不少测试会起子进程、建临时 git 仓库，在 4 核的 ARM 机器上和 static 检查同时跑时会超过 5 秒；这些测试没有卡住，只是慢，所以放宽超时，而不是改测试本身。

<a id="options"></a>

## 比较过的方案

- **用 vitest 自带的 `--shard`**：放弃。它按文件路径的哈希排序后切块，选法写在 vitest 内部，`test.mjs` 要核对“该跑哪些文件”就得照抄它的内部算法，升级 vitest 后可能悄悄对不上。自己按排序轮流分，规则只有一行，核对不变。
- **按上次用时平衡两份**：先不做。要先把每个文件的用时存下来并在 CI 里读回，多一套状态；先看轮流分的两份实际差多少，差得多再改。
- **integration 分三份**：先不做。三个检查 runner 还要跑三个 browser 作业，分三份会让 tests 和 browser 抢 runner，而且三台合计内存上限是 16 GB。
- **把 tooling 的 worker 从 2 个减到 1 个**（`scripts/ci/run.mjs` 给 tooling 起 vitest 时写的是 `"--maxWorkers",` 后跟 `"2",`）：放弃。会让 tooling 整体变慢，而失败的原因是单条测试超过 5 秒，不是并发出错。

<a id="consequences"></a>

## 后果

- 预计 tests 这一段从约 50 分钟降到约 20 分钟：integration 两份各约 17 分钟加装环境约 3 分钟，others 约 12 分钟。实际要看下一次 main 运行。
- 三个检查 runner 在 build 之后要接六个作业（三个 browser、三个 tests），谁先拿到不固定；最坏时 tests 要等 browser 先跑完一轮（约 7 分钟）。
- 两份 integration 和 others 同时跑时最多 7 个测试 worker 在这台 8 核机器上，内存合计上限 16 GB。如果下一次 main 运行出现内存超限被杀，把 integration 的 worker 上限调低，或者让 tests 成员少一个。
- PR 上只跑相关测试时，两份各自分到相关文件的一半；某一份分到零个文件时，这一份按“相关测试为零”记为通过，和以前整个项目没有相关测试时一样。全量运行里某一份分到零个文件会被当成没跑测试而失败。

<a id="verification"></a>

## 验证

- `test/tooling/policy.test.mjs` 的 `[ADR-0275]` 用例：现行策略就是三个成员；基准上的单成员写法升级一次、摘要仍按原始字节算；少一份、编号重复、份数不符、项目没人跑、项目跑两次、分片成员带两个项目、跑 tests 以外的项目、成员不写项目、tests 以外的作业写拆分、工作流矩阵和策略不一致，都被拒。
- `test/tooling/pipeline.test.mjs` 的 `[ADR-0275]` 用例：五个文件分两份是第 1、3、5 个和第 2、4 个，合起来正好全部；vitest 多跑了不属于这一份的文件时失败；份数写错时一个测试都不跑。
- `test/tooling/aggregate.test.mjs` 的 `[ADR-0275]` 用例：三个成员各报自己的项目时通过；分片多报项目、少一个成员时不过。
- `test/tooling/test-timeout.test.mjs`：只有 integration 和 tooling 带 30 秒超时。
