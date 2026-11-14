CLAIM|1|一致|docs/adr/0267-ci-tests-without-coverage-on-prs.md:58|在这份 ADR 之前，按 ADR 0267，每个 PR 仍要把 unit、contracts、integration、e2e、pi-compat 全部跑完|- `coverage` 作业改名 `tests`，仍在 CI 服务器上、仍等 policy 和 build，跑 unit、contracts、integration、e2e、pi-compat 五个项目。
CLAIM|2|一致|docs/adr/0267-ci-tests-without-coverage-on-prs.md:59|在这份 ADR 之前，按 ADR 0267，每个 PR 仍要把 tooling 全部跑完|- 新增 `tooling` 作业，在 Oracle 的 ARM 机器上跑，只等 policy，和 tests 并行。policy 作业不再跑任何测试。
CLAIM|3|一致|.github/workflows/ci.yml:366|`ci/required`（CI 的汇总作业，PR 能不能合看它）|    name: ci/required
CLAIM|4|一致|.agents/instructions/delivery-mode.md:27|现行合并门槛是 PR 最新提交上的 `ci/required` 成功|GitHub 合并门槛：合并进 `main` 之前，PR 最新提交上的 `ci/required` 必须是成功
CLAIM|5|一致|.agents/evidence/ci-related-tests-2026-11-14.md:7|改 `packages/application/src/ports/memory-episodes.ts` 时 integration 全量 186 个|全量|317|43|186|-|-|-|
CLAIM|6|一致|.agents/evidence/ci-related-tests-2026-11-14.md:8|改 `packages/application/src/ports/memory-episodes.ts` 时 integration 选出 165 个|packages/application/src/ports/memory-episodes.ts|132|26|165|1|0|5|
CLAIM|7|一致|.agents/evidence/ci-related-tests-2026-11-14.md:10|改 `apps/agent-service/src/cache-hit-monitor.ts` 时只选出 1 个|apps/agent-service/src/cache-hit-monitor.ts|2|1|1|0|0|0|
CLAIM|8|一致|.github/workflows/ci.yml:14|`ci.yml` 支持手动触发|  workflow_dispatch:
CLAIM|9|一致|.github/workflows/ci.yml:17|`ci.yml` 带基线输入，原话 `description: 明确的比较基线 commit SHA`|        description: 明确的比较基线 commit SHA
CLAIM|10|一致|scripts/ci/main-evidence.mjs:112|来源原话 `"MAIN_VALIDATION_CHANGED",`|    "MAIN_VALIDATION_CHANGED",
CLAIM|11|一致|scripts/ci/main-evidence.mjs:108|比较的目录包括 `".github",`|      ".github",
CLAIM|12|一致|scripts/ci/main-evidence.mjs:109|比较的目录包括 `"ci",`|      "ci",
CLAIM|13|一致|scripts/ci/main-evidence.mjs:110|比较的目录包括 `"scripts/ci",`|      "scripts/ci",
CLAIM|14|一致|scripts/model-review/opencode-review.mjs:1527|合并前的复核检查要求 `--main-ref` 是被检查提交的祖先，原话 ``problems.push(`main-not-merged ${printable(mainRef)}`);``|    problems.push(`main-not-merged ${printable(mainRef)}`);
CLAIM|15|一致|.claude/rules/owner-standing-rules.md:43|合并由做 PR 的线程执行，原话“合并 PR 一律由做这个 PR 的线程执行”|合并 PR 一律由做这个 PR 的线程执行，要等 Andy 说“合并”（在那个线程或项目聊天里说都算）。
CLAIM|16|一致|scripts/ci/test-scope.mjs:70|只在 `pull_request` 事件上缩小范围；手动触发、推送和夜间运行一律全量|  if (context.event !== "pull_request") return { related, reason: "full-event" };
CLAIM|17|一致|scripts/ci/test-scope.mjs:6|unit 和 contracts 照跑全量|export const relatedEligibleProjects = ["integration", "e2e", "pi-compat", "tooling"];
CLAIM|18|一致|.agents/evidence/ci-test-timing-2026-11-13.md:9|云端容器上实测 unit 183 秒|unit|317|188|183|
CLAIM|19|一致|.agents/evidence/ci-test-timing-2026-11-13.md:10|云端容器上实测 contracts 34 秒|contracts|43|33|34|
CLAIM|20|一致|scripts/ci/test-scope.mjs:44|integration、e2e、pi-compat、tooling 只跑 `vitest list --changed <PR 基线>` 选出的测试|        "--changed",
CLAIM|21|一致|scripts/ci/run.mjs:224|相关测试可以是零个|        if (selected?.length === 0) {
CLAIM|22|一致|scripts/ci/test-scope.mjs:15|改动里只要有一个文件不是指定源码，也不是 `.md` 或 `.agents/` 下的记录，就全部全量|  const fullFiles = files.filter((file) => !ignorable(file) && !sourceFile(file));
CLAIM|23|一致|scripts/ci/test-scope.mjs:15|改依赖、SQL、JSON、提示词文本、`scripts/`、`ci/`、`.github/` 都跑全量|  const fullFiles = files.filter((file) => !ignorable(file) && !sourceFile(file));
CLAIM|24|一致|scripts/ci/test-scope.mjs:77|某个项目的 `vitest list` 出错时，那个项目退回全量|    if (files === null) fallback.push(project);
CLAIM|25|一致|scripts/ci/run.mjs:218|检查结果里记下哪些项目只跑了相关测试（`relatedProjects`）|      if (plan.related.size) result.relatedProjects = [...plan.related.keys()];
CLAIM|26|一致|scripts/ci/aggregate.mjs:241|汇总结果标 `scope: related`|    scope: relatedScope ? "related" : "full",
CLAIM|27|一致|scripts/ci/aggregate.mjs:103|汇总只在 PR 上接受相关范围|      if (context.event !== "pull_request")
CLAIM|28|一致|scripts/ci/aggregate.mjs:106|汇总只接受 integration、e2e、pi-compat、tooling 四个项目的相关范围|        if (!check.projects.includes(id) || !relatedEligibleProjects.includes(id))
CLAIM|29|一致|scripts/ci/aggregate.mjs:128|只有声明了相关范围的项目才允许零计数|      if (!(related.has(project.id) && skipped(project.counts)))
CLAIM|30|一致|scripts/ci/main-evidence.mjs:221|main 的轻量确认不接受标成 `related` 的 PR 结果（`MAIN_GATE_RELATED_SCOPE`）|  assert(summary.scope !== "related", "MAIN_GATE_RELATED_SCOPE");
CLAIM|31|一致|.claude/rules/owner-standing-rules.md:43|线程在原来“调用合并接口”的地方改成给 PR 加 `merge-queue` 标签|线程执行合并的方式是给 PR 加 `merge-queue` 标签，由合并队列完整测过后合进 `main`；改了 CI 自身文件的 PR 仍由线程直接合并
CLAIM|32|一致|scripts/ci/merge-queue.mjs:477|加标签前的条件不变：复核已到最新提交|    const review = checkReview(number, head, main);
CLAIM|33|一致|scripts/ci/merge-queue.mjs:473|加标签前的条件不变：PR 上 `ci/required` 成功|    const check = await github.requiredCheck(head);
CLAIM|34|一致|.github/workflows/merge-queue.yml:29|工作流 `.github/workflows/merge-queue.yml` 在 ARM 机器上跑|    runs-on: ci-arm
CLAIM|35|一致|.github/workflows/merge-queue.yml:3|触发方式是 CI 跑完（`workflow_run`）|  workflow_run:
CLAIM|36|一致|.github/workflows/merge-queue.yml:7|每 10 分钟定时触发|    - cron: "*/10 * * * *"
CLAIM|37|一致|.github/workflows/merge-queue.yml:8|支持手动触发|  workflow_dispatch:
CLAIM|38|一致|.github/workflows/merge-queue.yml:21|`concurrency` 保证同时只有一个在跑|  group: merge-queue
CLAIM|39|一致|.github/workflows/merge-queue.yml:34|它只检出 `main`|          ref: main
CLAIM|40|一致|.github/workflows/merge-queue.yml:43|只运行 `main` 上的 `scripts/ci/merge-queue.mjs`|        run: node scripts/ci/merge-queue.mjs
CLAIM|41|一致|test/tooling/merge-queue.test.mjs:577|不用 `pull_request_target`|    expect(text).not.toContain("pull_request_target");
CLAIM|42|一致|test/tooling/merge-queue.test.mjs:575|不执行 PR 的代码|  it("工作流只在 main 的检出上运行队列脚本，不检出 PR 代码，不用 pull_request_target", () => {
CLAIM|43|一致|scripts/ci/merge-queue.mjs:121|PR 的内容只当作 git 数据合并|              "--no-ff",
CLAIM|44|一致|scripts/ci/merge-queue.mjs:9|队列状态存在 `merge-queue-state` 分支|export const stateBranch = "merge-queue-state";
CLAIM|45|一致|scripts/ci/merge-queue.mjs:172|队列状态文件是 `state.json`，带格式校验|      const text = run(["show", "refs/mq/state:state.json"]);
CLAIM|46|一致|scripts/ci/merge-queue.mjs:64|当前候选记录分支名、提交、基于哪个 main、每个 PR 的头提交和合入后的树、对应的 CI 运行|        candidate.prs.every((pr) => isPositive(pr.number) && isSha(pr.head) && isSha(pr.tree)),
CLAIM|47|一致|scripts/ci/merge-queue.mjs:34|队列状态记录待测分组、是否已停下|  return { version: 1, stopped: null, candidate: null, groups: [] };
CLAIM|48|一致|scripts/ci/merge-queue.mjs:444|有候选在跑时，main 被别的方式改了，就取消候选的 CI、丢掉候选|        await github.cancel(run.id);
CLAIM|49|一致|scripts/ci/merge-queue.mjs:447|候选超过 3 小时也取消后丢掉|      if (now() - Date.parse(candidate.createdAt) > candidateTimeoutMs) {
CLAIM|50|一致|scripts/ci/merge-queue.mjs:437|触发 15 分钟还找不到运行就丢掉|      if (now() - Date.parse(candidate.createdAt) > runGraceMs) drop("run-missing");
CLAIM|51|一致|scripts/ci/merge-queue.mjs:456|候选的 CI 跑完并且 `ci/required` 作业成功|    if (run.conclusion === "success" && required === "success")
CLAIM|52|一致|scripts/ci/merge-queue.mjs:378|先确认 main 还是候选的基线、每个 PR 还开着、还有标签、头提交没变，有一项不满足就一个都不合、丢掉候选|    if (main !== candidate.base) return drop("main-moved");
CLAIM|53|一致|scripts/ci/merge-queue.mjs:388|逐个调合并接口（带 `sha`）|      const result = await github.merge(pr.number, pr.head);
CLAIM|54|一致|scripts/ci/merge-queue.mjs:387|每次合并前确认 main 等于上一步的结果|      if (current !== expected) return drop(`main-moved-during-merge after ${merged.join(",")}`);
CLAIM|55|一致|scripts/ci/merge-queue.mjs:393|合并后核对 main 的两个父提交和树与候选里这一步完全一致|        parents.length !== 2 ||
CLAIM|56|一致|scripts/ci/merge-queue.mjs:398|不一致就停下整个队列，状态里写原因，在 PR 上留言|        stop(`main ${after} 和候选 ${candidate.sha} 里 #${pr.number} 合入后的树不一致`);
CLAIM|57|一致|scripts/ci/merge-queue.mjs:408|合完的 PR 去掉标签并留言|      await github.removeLabel(pr.number, queueLabel);
CLAIM|58|一致|scripts/ci/merge-queue.mjs:423|候选失败且只有一个 PR 时把它移出队列（去掉标签、加失败标签、留言带运行链接）|      await eject(candidate.prs[0].number, `它和当前 main 合在一起后完整 CI 没过：${run.url}`);
CLAIM|59|一致|scripts/ci/merge-queue.mjs:429|多于一个 PR 时拆成前后两半排在最前面|    state = { ...state, candidate: null, groups: splitGroups(numbers, rest) };
CLAIM|60|一致|scripts/ci/merge-queue.mjs:416|前一半过了就先合入，后一半在新的 main 上重测|    state = { ...state, candidate: null, groups: remainingGroups(candidate) };
CLAIM|61|一致|scripts/ci/merge-queue.mjs:502|没有候选时按最近一次加标签的时间排序|      stamped.sort((a, b) => a.at.localeCompare(b.at) || a.number - b.number);
CLAIM|62|一致|scripts/ci/merge-queue.mjs:507|取最多 5 个就绪的 PR|      if (ready.length >= batchLimit) break;
CLAIM|63|一致|scripts/ci/merge-queue.mjs:333|就绪的 PR 要开着、不是草稿、来自本仓库、目标是 main|  if (pr.state !== "open") return "closed";
CLAIM|64|一致|scripts/ci/merge-queue.mjs:468|没改 `.github`、`ci`、`scripts/ci` 的 PR 才进候选|    const protectedFiles = touchesProtected(repo.changedFiles(main, head));
CLAIM|65|一致|scripts/ci/merge-queue.mjs:474|`ci/required` 还在跑或还没有的跳过，不移出|    if (check.state === "pending" || check.state === "missing") return { skip: true };
CLAIM|66|一致|scripts/ci/merge-queue.mjs:465|其余不满足的移出并留言|    if (problem) return { eject: `PR 状态不满足排队条件（${problem}）` };
CLAIM|67|一致|scripts/ci/merge-queue.mjs:517|以当前 main 为底逐个 `git merge --no-ff`|    const built = repo.buildCandidate(main, ready);
CLAIM|68|一致|scripts/ci/merge-queue.mjs:518|冲突的移出|    for (const number of built.conflicts)
CLAIM|69|一致|scripts/ci/merge-queue.mjs:527|推到唯一的 `mq/<运行号>-<尝试次数>` 分支|    const branch = `${candidatePrefix}${runTag}`;
CLAIM|70|一致|scripts/ci/merge-queue.mjs:529|手动触发 `ci.yml`（基线是当前 main）|    await github.dispatch(branch, main);
CLAIM|71|一致|scripts/ci/merge-queue.mjs:312|复核检查在 PR 头的临时检出上运行|    repo.withWorktree(head, (dir) => {
CLAIM|72|一致|scripts/ci/merge-queue.mjs:317|复核检查运行 main 上的 `opencode-review.mjs --assert-reviewed`|          "--assert-reviewed",
CLAIM|73|一致|scripts/ci/merge-queue.mjs:323|`--main-ref` 用 main 和 PR 头的共同祖先|          repo.mergeBase(main, head),
CLAIM|74|一致|.claude/rules/owner-standing-rules.md:43|改了 CI 自身文件的 PR 照原流程等 PR 上的 CI 后由线程手动合并|改了 CI 自身文件的 PR 仍由线程直接合并
CLAIM|75|一致|scripts/ci/main-evidence.mjs:112|这类 PR 的 main 确认会跑全量|    "MAIN_VALIDATION_CHANGED",
CLAIM|76|一致|scripts/ci/merge-queue.mjs:555|只在 `DELIVERY_MODE` 为 `fast` 时工作|  if (mode !== "fast") {
CLAIM|77|一致|scripts/delivery-mode/github-ruleset.sh:29|完整模式的规则集要求分支保持最新|        "strict_required_status_checks_policy": true,
CLAIM|78|找不到|-|完整模式下批里第二个 PR 合不进去|-|
CLAIM|79|一致|.github/workflows/merge-queue.yml:41|合并用 `GITHUB_TOKEN`|          HIMAWARI_CI_GITHUB_TOKEN: ${{ github.token }}
CLAIM|80|一致|scripts/ci/merge-queue.mjs:545|队列停下后手动触发 “Merge queue” 工作流并把 `resume` 填成 true，队列才会继续|  if (state.stopped && resume) {
CLAIM|81|找不到|-|队列合入的提交不跑 `main.yml`，人手合并的仍然跑|-|
CLAIM|82|不一致|scripts/ci/test-scope.mjs:15|tooling 在不改 `scripts/` 时通常只剩几个文件|  const fullFiles = files.filter((file) => !ignorable(file) && !sourceFile(file));
CLAIM|83|一致|test/tooling/merge-queue.test.mjs:47|`test/tooling/merge-queue.test.mjs` 用真实 git 仓库|  git(root, ["init", "--quiet", "--bare", "-b", "main", origin]);
CLAIM|84|一致|test/tooling/merge-queue.test.mjs:62|`test/tooling/merge-queue.test.mjs` 用假的 GitHub 接口|  const fake = new FakeGithub({ origin, scratch });
CLAIM|85|一致|test/tooling/merge-queue.test.mjs:212|`test/tooling/merge-queue.test.mjs` 覆盖按顺序建候选、通过后逐个合并并核对树、失败拆半直到找出单个 PR、两半各自都过合在一起失败、改 CI 文件被拒、CI 未完成跳过、复核不过被拒、冲突、main 被抢先改、合并前 PR 变化、树不一致时停下、运行被取消或超时、找不到运行、完整模式不工作、草稿和 fork 被拒、一批最多 5 个、复核检查的参数、合并接口重试、工作流不检出 PR 代码|describe("合并队列 [ADR-0268]", () => {
CLAIM|86|一致|test/tooling/test-scope.test.mjs:23|`test/tooling/test-scope.test.mjs` 覆盖哪些改动走相关测试、哪些全量；不是 PR 时全量；`vitest list` 的参数和失败退回全量|describe("PR 上测试范围的选择 [ADR-0268]", () => {
CLAIM|87|一致|test/tooling/aggregate.test.mjs:116|`test/tooling/aggregate.test.mjs` 里名字带 `[ADR-0268]` 的用例覆盖相关范围只在 PR 上、只对四个项目、零计数只在声明了相关范围时接受|describe("PR 上只跑相关测试时的汇总 [ADR-0268]", () => {
CLAIM|88|一致|test/tooling/runner-orchestration.test.mjs:403|`test/tooling/runner-orchestration.test.mjs` 里名字带 `[ADR-0268]` 的用例覆盖相关范围的处理|  it("[ADR-0268] PR 上 tooling 没有相关测试时不启动 vitest，结果记下相关范围和零计数", async () => {
CLAIM|89|一致|test/tooling/main-evidence.test.mjs:165|`test/tooling/main-evidence.test.mjs` 里名字带 `[ADR-0268]` 的用例覆盖 main 不接受相关范围的结果|  it("[ADR-0268] PR 上只跑了相关测试的验收不能当 main 的证据，标成 full 的可以", () => {

前提 2–4 和比较方案里的 GitHub/vitest 官方行为、GitHub 自带 merge queue、pull_request_target 风险等属于外部产品或文档，未在本次核对范围内；上线后第一批观察也是未来事项。另外，仓库里没有读到“人手合并用哪种 token、是否会触发 main.yml”的直接证据，因此第 78、81 条判为找不到。
