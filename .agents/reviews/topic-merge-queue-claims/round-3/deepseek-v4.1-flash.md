CLAIM|1|一致|ci/policy.json:110|每个 PR 仍要把 unit、contracts、integration、e2e、pi-compat 全部跑完|      "projects": ["unit", "contracts", "integration", "e2e", "pi-compat"],
CLAIM|2|一致|ci/policy.json:127|每个 PR 仍要把 tooling 全部跑完|      "projects": ["tooling"],
CLAIM|3|一致|ci/policy.json:149|ci/required（CI 的汇总作业，PR 能不能合看它）才会变绿|      "needs": ["policy", "static", "build", "browser", "tests", "tooling", "security"],
CLAIM|4|一致|scripts/delivery-mode/github-ruleset.sh:31|ci/required（CI 的汇总作业，PR 能不能合看它）|        "required_status_checks": [{"context": "ci/required", "integration_id": 15368}]
CLAIM|5|一致|.agents/instructions/delivery-mode.md:27|现行合并门槛是 PR 最新提交上的 ci/required 成功|合并进 `main` 之前，PR 最新提交上的 `ci/required` 必须是成功
CLAIM|6|一致|.agents/evidence/ci-related-tests-2026-11-14.md:8|改 packages/application/src/ports/memory-episodes.ts 时 integration 选出 165 个|packages/application/src/ports/memory-episodes.ts | 132 | 26 | 165 | 1 | 0 | 5 |
CLAIM|7|一致|.agents/evidence/ci-related-tests-2026-11-14.md:7|integration 全量 186 个|全量 | 317 | 43 | 186 | - | - | - |
CLAIM|8|一致|.agents/evidence/ci-related-tests-2026-11-14.md:10|改 apps/agent-service/src/cache-hit-monitor.ts 时只选出 1 个|apps/agent-service/src/cache-hit-monitor.ts | 2 | 1 | 1 | 0 | 0 | 0 |
CLAIM|9|一致|.github/workflows/ci.yml:14|ci.yml 支持手动触发|  workflow_dispatch:
CLAIM|10|一致|.github/workflows/ci.yml:17|ci.yml 带基线输入，原话 description: 明确的比较基线 commit SHA|        description: 明确的比较基线 commit SHA
CLAIM|11|一致|scripts/ci/main-evidence.mjs:112|改了 CI 自身文件的合并不能用 PR 上的结果顶替 main 确认，原话 "MAIN_VALIDATION_CHANGED",|    "MAIN_VALIDATION_CHANGED",
CLAIM|12|一致|scripts/ci/main-evidence.mjs:108-110|比较的目录是 ".github", "ci", "scripts/ci"|      "scripts/ci",
CLAIM|13|一致|scripts/model-review/opencode-review.mjs:1526|合并前的复核检查要求 --main-ref 是被检查提交的祖先|  else if (gitStatus(["merge-base", "--is-ancestor", mainRef, head], repo).status !== 0)
CLAIM|14|一致|scripts/model-review/opencode-review.mjs:1527|原话 problems.push(`main-not-merged ${printable(mainRef)}`);|    problems.push(`main-not-merged ${printable(mainRef)}`);
CLAIM|15|一致|.claude/rules/owner-standing-rules.md:43|合并由做 PR 的线程执行|合并 PR 一律由做这个 PR 的线程执行
CLAIM|16|一致|.agents/evidence/ci-test-timing-2026-11-13.md:9|云端容器上实测 unit 183 秒|unit | 317 | 188 | 183 |
CLAIM|17|一致|.agents/evidence/ci-test-timing-2026-11-13.md:10|contracts 34 秒|contracts | 43 | 33 | 34 |
CLAIM|18|一致|scripts/ci/test-scope.mjs:70|只在 pull_request 事件上缩小范围；手动触发（合并队列的候选）、推送和夜间运行一律全量|  if (context.event !== "pull_request") return { related, reason: "full-event" };
CLAIM|19|一致|scripts/ci/test-scope.mjs:6|integration、e2e、pi-compat、tooling 只跑相关测试|export const relatedEligibleProjects = ["integration", "e2e", "pi-compat", "tooling"];
CLAIM|20|一致|scripts/ci/test-scope.mjs:44|只跑 vitest list --changed <PR 基线> 选出的测试|        "--changed",
CLAIM|21|一致|scripts/ci/run.mjs:224|选出的测试可以是零个|        if (selected?.length === 0) {
CLAIM|22|一致|scripts/ci/test-scope.mjs:10|源码只认 apps/、packages/、test/ 下的指定扩展名|  /^(?:apps|packages|test)\/.+\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/u.test(file) &&
CLAIM|23|一致|scripts/ci/test-scope.mjs:11|配置文件 *.config.*、vitest.* 也不算源码|  !/(?:^|\/)[^/]*\.config\.[^/]+$/u.test(file) &&
CLAIM|24|一致|scripts/ci/test-scope.mjs:8|也不是 .md 或 .agents/ 下的记录|const ignorable = (file) => file.startsWith(".agents/") || file.endsWith(".md");
CLAIM|25|一致|scripts/ci/test-scope.mjs:15|只要有一个文件不属于上述源码或记录，就全部全量|  const fullFiles = files.filter((file) => !ignorable(file) && !sourceFile(file));
CLAIM|26|一致|test/tooling/test-scope.test.mjs:41|改依赖、SQL、JSON、提示词文本、scripts/、ci/、.github/ 都跑全量|    "scripts/operations/cache-hit-report.mjs",
CLAIM|27|一致|scripts/ci/test-scope.mjs:77|某个项目的 vitest list 出错时，那个项目退回全量|    if (files === null) fallback.push(project);
CLAIM|28|一致|scripts/ci/run.mjs:218|检查结果里记下哪些项目只跑了相关测试（relatedProjects）|      if (plan.related.size) result.relatedProjects = [...plan.related.keys()];
CLAIM|29|一致|scripts/ci/aggregate.mjs:241|汇总结果标 scope: related|    scope: relatedScope ? "related" : "full",
CLAIM|30|一致|scripts/ci/aggregate.mjs:103|汇总只在 PR 上接受相关范围|      if (context.event !== "pull_request")
CLAIM|31|一致|scripts/ci/aggregate.mjs:106|汇总只接受上面四个项目|        if (!check.projects.includes(id) || !relatedEligibleProjects.includes(id))
CLAIM|32|一致|scripts/ci/aggregate.mjs:110|只有声明了相关范围的项目才允许零计数|      related.size > 0 && JSON.stringify(counts) === JSON.stringify(zeroCounts());
CLAIM|33|一致|scripts/ci/main-evidence.mjs:221|main 的轻量确认不接受标成 related 的 PR 结果（MAIN_GATE_RELATED_SCOPE）|  assert(summary.scope !== "related", "MAIN_GATE_RELATED_SCOPE");
CLAIM|34|不一致|test/tooling/main-evidence.test.mjs:170|人手合并的 PR 在 main 上会跑全量|    expect(verifyGate(full)).toMatchObject({ mode: "light" });
CLAIM|35|一致|.github/workflows/merge-queue.yml:29|工作流 .github/workflows/merge-queue.yml 在 ARM 机器上跑|    runs-on: ci-arm
CLAIM|36|一致|.github/workflows/merge-queue.yml:3|触发方式是 CI 跑完（workflow_run）|  workflow_run:
CLAIM|37|一致|.github/workflows/merge-queue.yml:7|每 10 分钟定时|    - cron: "*/10 * * * *"
CLAIM|38|一致|.github/workflows/merge-queue.yml:8|手动触发|  workflow_dispatch:
CLAIM|39|一致|.github/workflows/merge-queue.yml:20|concurrency 保证同时只有一个在跑|  group: merge-queue
CLAIM|40|一致|.github/workflows/merge-queue.yml:34|它只检出 main|          ref: main
CLAIM|41|一致|.github/workflows/merge-queue.yml:40|只运行 main 上的 scripts/ci/merge-queue.mjs|        run: node scripts/ci/merge-queue.mjs
CLAIM|42|一致|test/tooling/merge-queue.test.mjs:577|不用 pull_request_target|    expect(text).not.toContain("pull_request_target");
CLAIM|43|一致|test/tooling/merge-queue.test.mjs:578|不执行 PR 的代码|    expect(text).not.toMatch(/head\.sha|head_ref|head\.ref|github\.event\.workflow_run\.head/u);
CLAIM|44|一致|scripts/ci/merge-queue.mjs:125|PR 的内容只当作 git 数据合并|              pr.head,
CLAIM|45|一致|scripts/ci/merge-queue.mjs:9|队列状态存在 merge-queue-state 分支|export const stateBranch = "merge-queue-state";
CLAIM|46|一致|scripts/ci/merge-queue.mjs:172|state.json 带格式校验|      const text = run(["show", "refs/mq/state:state.json"]);
CLAIM|47|一致|scripts/ci/merge-queue.mjs:64|当前候选记录每个 PR 的头提交和合入后的树|        candidate.prs.every((pr) => isPositive(pr.number) && isSha(pr.head) && isSha(pr.tree)),
CLAIM|48|一致|scripts/ci/merge-queue.mjs:34|队列状态含待测分组、是否已停下|  return { version: 1, stopped: null, candidate: null, groups: [] };
CLAIM|49|一致|scripts/ci/merge-queue.mjs:14|超过 3 小时也取消后丢掉|export const candidateTimeoutMs = 3 * 3600_000;
CLAIM|50|一致|scripts/ci/merge-queue.mjs:13|触发 15 分钟还找不到运行就丢掉|export const runGraceMs = 15 * 60_000;
CLAIM|51|一致|scripts/ci/merge-queue.mjs:444|main 被别的方式改了就取消候选的 CI、丢掉候选|        await github.cancel(run.id);
CLAIM|52|一致|scripts/ci/merge-queue.mjs:378|先确认 main 还是候选的基线|    if (main !== candidate.base) return drop("main-moved");
CLAIM|53|一致|scripts/ci/merge-queue.mjs:381|每个 PR 还开着、还有标签、头提交没变，有一项不满足就一个都不合、丢掉候选|      if (problem) return drop(`pr-${problem} #${pr.number}`);
CLAIM|54|一致|scripts/ci/merge-queue.mjs:290|逐个调合并接口（带 sha）|          { merge_method: "merge", sha },
CLAIM|55|一致|scripts/ci/merge-queue.mjs:387|每次合并前确认 main 等于上一步的结果|      if (current !== expected) return drop(`main-moved-during-merge after ${merged.join(",")}`);
CLAIM|56|一致|scripts/ci/merge-queue.mjs:396|合并后核对 main 的两个父提交和树与候选里这一步完全一致|        repo.tree(after) !== pr.tree
CLAIM|57|一致|scripts/ci/merge-queue.mjs:398|不一致就停下整个队列（状态里写原因，在 PR 上留言）|        stop(`main ${after} 和候选 ${candidate.sha} 里 #${pr.number} 合入后的树不一致`);
CLAIM|58|一致|scripts/ci/merge-queue.mjs:408|合完的 PR 去掉标签并留言|      await github.removeLabel(pr.number, queueLabel);
CLAIM|59|一致|scripts/ci/merge-queue.mjs:423|只有一个 PR 时把它移出队列，留言带运行链接|      await eject(candidate.prs[0].number, `它和当前 main 合在一起后完整 CI 没过：${run.url}`);
CLAIM|60|一致|scripts/ci/merge-queue.mjs:358|移出时去掉 merge-queue、加 merge-queue-failed、留言|    await github.removeLabel(number, queueLabel);
CLAIM|61|一致|scripts/ci/merge-queue.mjs:79|多于一个时拆成前后两半排在最前面|  return [numbers.slice(0, middle), numbers.slice(middle), ...rest];
CLAIM|62|一致|scripts/ci/merge-queue.mjs:429|失败再拆|    state = { ...state, candidate: null, groups: splitGroups(numbers, rest) };
CLAIM|63|一致|scripts/ci/merge-queue.mjs:502|按最近一次加标签的时间排序|      stamped.sort((a, b) => a.at.localeCompare(b.at) || a.number - b.number);
CLAIM|64|一致|scripts/ci/merge-queue.mjs:12|取最多 5 个就绪的 PR|export const batchLimit = 5;
CLAIM|65|一致|scripts/ci/merge-queue.mjs:334|就绪条件包括开着、不是草稿、来自本仓库、目标是 main|  if (pr.draft) return "draft";
CLAIM|66|一致|scripts/ci/merge-queue.mjs:475|PR 头上 ci/required 成功|    if (check.state !== "success")
CLAIM|67|一致|scripts/ci/merge-queue.mjs:478|复核检查通过|    if (!review.ok)
CLAIM|68|一致|scripts/ci/merge-queue.mjs:11|没改 .github、ci、scripts/ci|export const protectedPaths = [".github", "ci", "scripts/ci"];
CLAIM|69|一致|scripts/ci/merge-queue.mjs:474|ci/required 还在跑或还没有的跳过，不移出|    if (check.state === "pending" || check.state === "missing") return { skip: true };
CLAIM|70|不一致|scripts/ci/merge-queue.mjs:464|其余不满足的移出并留言|    if (problem === "closed" || problem === "unlabeled") return { skip: true };
CLAIM|71|一致|scripts/ci/merge-queue.mjs:122|以当前 main 为底逐个 git merge --no-ff|              "--no-ff",
CLAIM|72|一致|scripts/ci/merge-queue.mjs:519|冲突的移出|      await eject(
CLAIM|73|一致|scripts/ci/merge-queue.mjs:527|推到唯一的 mq/<运行号>-<尝试次数> 分支|    const branch = `${candidatePrefix}${runTag}`;
CLAIM|74|一致|scripts/ci/merge-queue.mjs:529|手动触发 ci.yml（基线是当前 main），完整跑一遍|    await github.dispatch(branch, main);
CLAIM|75|一致|scripts/ci/merge-queue.mjs:312|复核检查在 PR 头的临时检出上运行|    repo.withWorktree(head, (dir) => {
CLAIM|76|一致|scripts/ci/merge-queue.mjs:309|运行 main 上的 opencode-review.mjs --assert-reviewed|  script = path.join(scriptRoot, "scripts/model-review/opencode-review.mjs"),
CLAIM|77|一致|scripts/ci/merge-queue.mjs:323|--main-ref 用 main 和 PR 头的共同祖先|          repo.mergeBase(main, head),
CLAIM|78|一致|scripts/ci/merge-queue.mjs:469|改了 .github、ci、scripts/ci 的 PR 不进队列|    if (protectedFiles.length > 0)
CLAIM|79|一致|scripts/ci/main-evidence.mjs:112|这类 PR 的 main 确认会跑全量|    "MAIN_VALIDATION_CHANGED",
CLAIM|80|一致|scripts/ci/merge-queue.mjs:555|只在 DELIVERY_MODE 为 fast 时工作|  if (mode !== "fast") {
CLAIM|81|一致|scripts/delivery-mode/github-ruleset.sh:29|完整模式的规则集要求 PR 分支包含 main 的最新提交（第 29 行 "strict_required_status_checks_policy": true）|        "strict_required_status_checks_policy": true,
CLAIM|82|一致|.github/workflows/merge-queue.yml:41|合并用 GITHUB_TOKEN|          HIMAWARI_CI_GITHUB_TOKEN: ${{ github.token }}
CLAIM|83|一致|scripts/ci/merge-queue.mjs:396|候选的完整 CI 测的就是合并后 main 的那棵树，合完核对树一致|        repo.tree(after) !== pr.tree
CLAIM|84|一致|test/tooling/test-scope.test.mjs:41|改了 scripts/ 下的文件时，test-scope.mjs 的 sourceFile 只认 apps、packages、test 下的源码，这个 PR 会退回完整测试|    "scripts/operations/cache-hit-report.mjs",
CLAIM|85|一致|scripts/ci/merge-queue.mjs:582|队列停下后手动触发 Merge queue 工作流并把 resume 填成 true，队列才会继续|    resume: env.GITHUB_EVENT_NAME === "workflow_dispatch" && env.MQ_RESUME === "true",
CLAIM|86|一致|test/tooling/merge-queue.test.mjs:62|merge-queue.test.mjs 用真实 git 仓库和假的 GitHub 接口|  const fake = new FakeGithub({ origin, scratch });
CLAIM|87|一致|test/tooling/merge-queue.test.mjs:230|merge-queue.test.mjs 覆盖按顺序建候选、通过后逐个合并并核对树|  it("候选的完整 CI 通过后逐个合并，每次合并后核对 main 的树和候选一致，去掉标签并删掉候选分支", async () => {
CLAIM|88|一致|test/tooling/merge-queue.test.mjs:283|merge-queue.test.mjs 覆盖失败拆半直到找出单个 PR、两半各自都过合在一起失败|  it("两半各自都过、合在一起才失败时，先合入的一半成为新 main，后一半在它上面重测并继续拆，直到找出单个 PR", async () => {
CLAIM|89|一致|test/tooling/merge-queue.test.mjs:302|merge-queue.test.mjs 覆盖改 CI 文件被拒、CI 未完成跳过、复核不过被拒、冲突|  it("改了 .github、ci 或 scripts/ci 的 PR 不进候选，移出队列并说明要按原流程手动合并", async () => {
CLAIM|90|一致|test/tooling/merge-queue.test.mjs:347|merge-queue.test.mjs 覆盖 main 被抢先改、合并前 PR 变化、树不一致时停下、运行被取消或超时、找不到运行|  it("候选还在跑时 main 被别的方式改了：取消候选的 CI、丢掉候选，在新 main 上重建", async () => {
CLAIM|91|一致|test/tooling/merge-queue.test.mjs:433|merge-queue.test.mjs 覆盖完整模式不工作、草稿和 fork 被拒、一批最多 5 个|  it("完整模式下队列什么都不做", async () => {
CLAIM|92|一致|test/tooling/merge-queue.test.mjs:490|merge-queue.test.mjs 覆盖复核检查的参数|  it("复核检查在 PR 头的临时检出上运行 main 的复核脚本，主线基准用 main 和 PR 头的共同祖先", () => {
CLAIM|93|一致|test/tooling/merge-queue.test.mjs:515|merge-queue.test.mjs 覆盖合并接口重试|  it("GitHub 接口：合并遇到 405 时重试，四次都失败返回未合并；找运行只认同分支同提交的 ci.yml 手动触发", async () => {
CLAIM|94|一致|test/tooling/merge-queue.test.mjs:575|merge-queue.test.mjs 覆盖工作流不检出 PR 代码|  it("工作流只在 main 的检出上运行队列脚本，不检出 PR 代码，不用 pull_request_target", () => {
CLAIM|95|一致|test/tooling/test-scope.test.mjs:120|test-scope.test.mjs 覆盖哪些改动走相关测试、哪些全量；不是 PR 时全量；vitest list 的参数和失败退回全量|  it("用 vitest list --changed 以 PR 基线找相关测试，输出改成仓库相对路径并去重排序；vitest 失败时返回 null", () => {
CLAIM|96|一致|test/tooling/aggregate.test.mjs:116|aggregate.test.mjs 里名字带 [ADR-0268] 的用例覆盖相关范围只在 PR 上、只对四个项目、零计数只在声明了相关范围时接受|describe("PR 上只跑相关测试时的汇总 [ADR-0268]", () => {
CLAIM|97|一致|test/tooling/runner-orchestration.test.mjs:403|runner-orchestration.test.mjs 里名字带 [ADR-0268] 的用例覆盖相关范围|  it("[ADR-0268] PR 上 tooling 没有相关测试时不启动 vitest，结果记下相关范围和零计数", async () => {
CLAIM|98|一致|test/tooling/main-evidence.test.mjs:165|main-evidence.test.mjs 里名字带 [ADR-0268] 的用例覆盖 main 不接受相关范围的结果|  it("[ADR-0268] PR 上只跑了相关测试的验收不能当 main 的证据，标成 full 的可以", () => {

未能核对的部分：前提 2、3、4 依赖 GitHub 与 vitest 的外部文档（无网络无法打开），以及“GITHUB_TOKEN 合并后 main.yml 不会被触发”这类第三方行为；Andy 的原话、上线后第一批的观察计划也不在当前仓库可验证范围内。
