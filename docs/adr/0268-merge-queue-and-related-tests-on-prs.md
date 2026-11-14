---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: ""
date: "2026-11-14"
---

# ADR 0268：自建合并队列，PR 上只跑基础测试和相关测试

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

在这份 ADR 之前，按 [ADR 0267](0267-ci-tests-without-coverage-on-prs.md)，每个 PR 仍要把 unit、contracts、integration、e2e、pi-compat 和 tooling 全部跑完，`ci/required`（CI 的汇总作业，PR 能不能合看它）才会变绿。几个 PR 同时排队时，每个都跑一遍全量，CI 服务器的 runner（替 GitHub 执行 CI 任务的程序）一直被占满。这份 ADR 定下两件一起做的事：PR 上只跑基础测试和与改动相关的测试；PR 要合并时加 `merge-queue` 标签进合并队列（合并队列：把几个排队的 PR 先合到一起，用完整 CI 测一次合在一起的结果，过了再逐个合进 `main`），由队列补上完整测试。

<a id="premises"></a>

## 前提和来源

1. 现行合并门槛是 PR 最新提交上的 `ci/required` 成功。来源：`.agents/instructions/delivery-mode.md` 第 27 行，原话“合并进 `main` 之前，PR 最新提交上的 `ci/required` 必须是成功”。
2. 用 Actions 自带的 `GITHUB_TOKEN` 产生的事件不会再触发工作流，`workflow_dispatch` 例外。来源：https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow ，原话 “events triggered by the `GITHUB_TOKEN` will not create a new workflow run”、“`workflow_dispatch` and `repository_dispatch` events always create workflow runs.”
3. 合并接口的 `sha` 参数只锁 PR 头，不锁 `main`。来源：https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request ，原话 “SHA that pull request head must match to allow merge.”
4. vitest 按 import 关系找相关测试，只认静态 import。来源：https://vitest.dev/guide/cli ，`--changed` 的说明原话 “Run tests that are affected by the changed files”；`vitest related` 一节原话 “Works with static imports … but not the dynamic ones”。
5. 改一个源码文件时 vitest 选出的相关测试数差别很大：改 `packages/application/src/ports/memory-episodes.ts` 时 integration 选出 165 个（全量 186 个），改 `apps/agent-service/src/cache-hit-monitor.ts` 时只选出 1 个。来源：`.agents/evidence/ci-related-tests-2026-11-14.md`。
6. `ci.yml` 支持手动触发并带基线输入。来源：`.github/workflows/ci.yml`，原话 `workflow_dispatch:` 和 `description: 明确的比较基线 commit SHA`。
7. 改了 CI 自身文件的合并不能用 PR 上的结果顶替 main 确认。来源：`scripts/ci/main-evidence.mjs`，原话 `"MAIN_VALIDATION_CHANGED",`，比较的目录是 `".github",`、`"ci",`、`"scripts/ci",`。
8. 合并前的复核检查要求 `--main-ref` 是被检查提交的祖先。来源：`scripts/model-review/opencode-review.mjs`，原话 ``problems.push(`main-not-merged ${printable(mainRef)}`);``。
9. 合并由做 PR 的线程执行。来源：`.claude/rules/owner-standing-rules.md`，原话“合并 PR 一律由做这个 PR 的线程执行”。

<a id="owner-decisions"></a>

## Andy 的原话

- 2026-11-14：“那可不可以做到每个 PR 只跑基础测试，然后自己写一下 merge queue 的逻辑，把多个 PR 合到一起再做一次完整的 CI？CI 过了之后直接合并到 main 分支，这样是不是一个更好的方案？”
- 2026-11-14，在“只跑相关测试先做哪种”的选项里选了“等合并队列一起做”。
- 2026-11-14：“出完方案之后，和 DeepSeek 讨论一轮之后直接实施就行了，不要给我看了。”

<a id="decision"></a>

## 决定

### PR 上的测试范围

- 只在 `pull_request` 事件上缩小范围；手动触发（合并队列的候选）、推送和夜间运行一律全量。
- unit 和 contracts 照跑全量（云端容器上实测 unit 183 秒、contracts 34 秒，见 `.agents/evidence/ci-test-timing-2026-11-13.md`；全量跑也能接住一部分只靠动态 import 才用到的代码）。
- integration、e2e、pi-compat、tooling 只跑 `vitest list --changed <PR 基线>` 选出的测试，可以是零个（`scripts/ci/test-scope.mjs`）。
- 改动里只要有一个文件不是 `apps/`、`packages/`、`test/` 下的 `.ts`、`.tsx`、`.mts`、`.cts`、`.js`、`.mjs`、`.cjs` 源码（配置文件 `*.config.*`、`vitest.*` 也不算源码），也不是 `.md` 或 `.agents/` 下的记录，就全部全量。所以改依赖、SQL、JSON、`scripts/`、`ci/`、`.github/` 都跑全量；提示词写在 `packages/prompt-catalog/src/` 的 `.ts` 文件里，只改它们时按源码走相关测试。某个项目的 `vitest list` 出错时，那个项目退回全量。
- 检查结果里记下哪些项目只跑了相关测试（`relatedProjects`），汇总结果标 `scope: related`。汇总只在 PR 上接受相关范围，只接受上面四个项目，只有声明了相关范围的项目才允许零计数。
- main 的轻量确认不接受标成 `related` 的 PR 结果（`MAIN_GATE_RELATED_SCOPE`），`main-evidence.mjs` 拿不到可用证据时退回 `mode: "full"`，所以 PR 上只跑了相关测试、又被人手合并的提交，在 main 上会跑全量；PR 上本来就跑了全量的（例如改了 `package.json` 的 PR），main 仍可走轻量确认；改了 `.github`、`ci`、`scripts/ci` 的提交在 main 上一律跑全量（`MAIN_VALIDATION_CHANGED`）。

### 合并队列

- 入口：线程在原来“调用合并接口”的地方改成给 PR 加 `merge-queue` 标签，加完可以手动触发一次 “Merge queue” 工作流，不触发就等下一次触发。加标签前的条件不变：复核已到最新提交、PR 上 `ci/required` 成功。
- 工作流 `.github/workflows/merge-queue.yml` 在 ARM 机器上跑，触发方式是 CI 跑完（`workflow_run`）、每 10 分钟定时、手动触发；`concurrency` 保证同时只有一个在跑。它只检出 `main`、只运行 `main` 上的 `scripts/ci/merge-queue.mjs`，不用 `pull_request_target`，不执行 PR 的代码；PR 的内容只当作 git 数据合并。
- 队列状态存在 `merge-queue-state` 分支的 `state.json`（带格式校验）：当前候选（分支名、提交、基于哪个 main、每个 PR 的头提交和合入后的树、对应的 CI 运行）、待测分组、是否已停下、连续几次没有得到 CI 结论。
- 每次运行做这些事：
  1. 有候选在跑：main 被别的方式改了就取消候选的 CI、丢掉候选；超过 3 小时也取消后丢掉；触发 15 分钟还找不到运行就丢掉。后两种和“跑完却没有成功或失败的结论”一样算一次没有结论，连续 3 次就停下队列；CI 给出成功或失败的结论时计数清零。
  2. 候选的 CI 跑完并且 `ci/required` 作业成功：先确认 main 还是候选的基线、每个 PR 还开着、还有标签、头提交没变，有一项不满足就一个都不合、丢掉候选。然后逐个调合并接口（带 `sha`），每次合并前确认 main 等于上一步的结果，合并后核对 main 的两个父提交和树与候选里这一步完全一致；不一致就停下整个队列（状态里写原因，在 PR 上留言），等人工检查。合完的 PR 去掉标签并留言。
  3. 候选失败（运行结论和 `ci/required` 作业都是 failure）：只有一个 PR 时把它移出队列（去掉 `merge-queue`、加 `merge-queue-failed`、留言带运行链接）；多于一个时拆成前后两半排在最前面，依次测。前一半过了就先合入，后一半在新的 main 上重测，失败再拆，所以“两半各自都过、合在一起才失败”的情况最终会落到一个 PR 上被移出，不会无限循环。
  4. 没有候选：按最近一次加标签的时间排序，取最多 5 个就绪的 PR（开着、不是草稿、来自本仓库、目标是 main、PR 头上 `ci/required` 成功、复核检查通过、没改 `.github`、`ci`、`scripts/ci`）。已关闭的、标签已被摘掉的、PR 头在读取期间刚变的，以及 `ci/required` 还在跑或还没有的，都跳过，不移出；其余不满足的移出并留言。以当前 main 为底逐个 `git merge --no-ff`，冲突的移出；推到唯一的 `mq/<运行号>-<尝试次数>` 分支（`mq/` 下的分支只归队列用，推新候选前会删掉状态里没有的 `mq/*` 分支），手动触发 `ci.yml`（基线是当前 main），完整跑一遍。
- 复核检查在 PR 头的临时检出上运行 main 上的 `opencode-review.mjs --assert-reviewed`，`--main-ref` 用 main 和 PR 头的共同祖先，这样批里前面的 PR 合入后，后面的 PR 不会因为 main 前进而被判 `main-not-merged`。合在一起是否出错由候选的完整 CI 判断。
- 改了 `.github`、`ci`、`scripts/ci` 的 PR 不进队列：候选的完整 CI 会用到这些改动，不能自己证明自己。这类 PR 照原流程等 PR 上的 CI 后由线程手动合并，main 确认会跑全量。
- 只在 `DELIVERY_MODE` 为 `fast` 时工作。完整模式的规则集要求 PR 分支包含 main 的最新提交（`scripts/delivery-mode/github-ruleset.sh` 第 29 行 `"strict_required_status_checks_policy": true`），批里第一个 PR 合进去后，第二个 PR 的分支就不再包含最新的 main，合并会被拒绝，所以完整模式下队列什么都不做。
- 合并用 `GITHUB_TOKEN`，由前提 2，队列合并后 `main.yml` 不会被触发；候选的完整 CI 测的就是合并后 main 的那棵树，合完核对树一致。

<a id="options"></a>

## 比较过的方案

| 方案 | 结论 | 原因 |
| --- | --- | --- |
| 自建队列，PR 只跑基础和相关测试 | 采用 | Andy 提出；完整测试从“每个 PR 一次”变成“每批一次” |
| GitHub 自带的 merge queue | 不采用 | Andy 定过不在 GitHub 上花钱；私有仓库能不能免费用没有核实，方案不依赖它 |
| 加标签用 `pull_request_target` 触发 | 不采用 | 这个事件带写权限，在自托管 runner 上和 PR 内容放在一起风险大；改用 CI 跑完、定时和手动触发 |
| 候选过了直接把候选分支快进成 main | 不采用 | 要能直推 main、绕过合并接口，PR 不会显示已合并 |
| unit、contracts 也只跑相关测试 | 不采用 | 两项合起来只有几分钟；全量跑能接住一部分 import 关系看不到的代码 |
| 候选失败只把前一半拿来重测 | 不采用 | 前一半过了、问题在后一半时没有出路；改成两半都测、先合过了的那半 |

<a id="consequences"></a>

## 后果

- PR 上的结果出得更快：改边缘文件时 integration 几乎不跑；改核心包时省得不多（前提 5）。改了 `scripts/` 下的文件时，`test-scope.mjs` 的 `sourceFile` 只认 `apps`、`packages`、`test` 下的源码，这个 PR 会退回完整测试。
- 单个 PR 从加标签到进 main 要再等一次完整 CI；线程加完标签就可以去做别的，不用守着合并。
- 相关测试漏掉的问题（动态 import、子进程里用到的代码）会在候选的完整 CI 上被拦下，代价是整批要拆开重测。
- 队列合入的提交不跑 `main.yml`（前提 2），人手合并的仍然跑。
- 队列合到一半停下时（合并后树不一致、main 被抢先改），main 上可能已经有批里前几个 PR，这几个是作为整批的一部分测过的，没有单独测过；下一个候选会在它上面完整测一次。合并接口只锁 PR 头、不锁 main，所以队列在合并前核对 main 和调用合并接口之间如果有人改了 main，这一个 PR 会先合进去，队列事后发现树不一致才停下；这个空当无法在不改分支保护的前提下消除。
- 候选的完整 CI 只有在运行结论和 `ci/required` 都是 failure 时才算 PR 的错（拆半或移出）；整次运行启动失败、整次运行超时、`ci/required` 被跳过或没有结论都当作 CI 本身的问题，丢掉候选重建，不给 PR 加 `merge-queue-failed`；连续 3 次这样就停下队列等人工检查，不无限重跑。单个作业超时或被取消时 `ci/required` 也是 failure，这种情况仍按 PR 的错处理，代价是可能把无辜的 PR 拆出来重测或移出。复核检查的子进程没有正常退出（5 分钟超时被杀、启动失败、输出超过上限）时，这一轮跳过这个 PR、也不再检查排在后面的 PR，不移出。
- 队列复核检查读的是 PR 自己提交的 `.agents/reviews` 记录，信任程度和手动合并前的 `--assert-reviewed` 相同，不比原流程更强。
- 队列停下后要人工看原因，确认没事后手动触发 “Merge queue” 工作流并把 `resume` 填成 true，队列才会继续。

<a id="verification"></a>

## 验证

- `test/tooling/merge-queue.test.mjs`：用真实 git 仓库和假的 GitHub 接口，覆盖按顺序建候选、通过后逐个合并并核对树、失败拆半直到找出单个 PR、两半各自都过合在一起失败、改 CI 文件被拒、CI 未完成跳过、复核不过被拒、冲突、main 被抢先改、合并前 PR 变化、树不一致时停下、运行被取消或超时、找不到运行、完整模式不工作、草稿和 fork 被拒、一批最多 5 个、复核检查的参数和超时、合并接口重试、加标签前先建标签、改名移出保护目录也被拒、CI 本身出错不怪 PR、连续 3 次没有结论就停下（含找不到运行）、给出结论后计数清零、复核检查被杀时跳过并停止检查后面的 PR、只有 already_exists 的 422 才算标签已存在、清理状态外的 mq 分支且只在建候选时清理、工作流不检出 PR 代码。
- `test/tooling/test-scope.test.mjs`：哪些改动走相关测试、哪些全量；不是 PR 时全量；`vitest list` 的参数和失败退回全量。
- `test/tooling/aggregate.test.mjs`、`test/tooling/runner-orchestration.test.mjs`、`test/tooling/main-evidence.test.mjs` 里名字带 `[ADR-0268]` 的用例：相关范围只在 PR 上、只对四个项目、零计数只在声明了相关范围时接受；main 不接受相关范围的结果。
- 上线后第一批：看一个只改边缘文件的 PR 的 tests 和 tooling 作业时长，以及第一个候选从建到合并的全过程。
