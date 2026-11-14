CLAIM|1|一致|.github/workflows/ci.yml:366|`ci/required`（CI 的汇总作业，PR 能不能合看它）才会变绿|    name: ci/required
CLAIM|2|一致|.agents/instructions/delivery-mode.md:27|现行合并门槛是 PR 最新提交上的 `ci/required` 成功。|GitHub 合并门槛：合并进 `main` 之前，PR 最新提交上的 `ci/required` 必须是成功
CLAIM|3|一致|.agents/evidence/ci-related-tests-2026-11-14.md:7|改 `packages/application/src/ports/memory-episodes.ts` 时 integration 选出 165 个（全量 186 个）|<!-- -->| 全量 | 317 | 43 | 186 | - | - | - |
CLAIM|4|一致|.agents/evidence/ci-related-tests-2026-11-14.md:8|改 `packages/application/src/ports/memory-episodes.ts` 时 integration 选出 165 个|<!-- -->| packages/application/src/ports/memory-episodes.ts | 132 | 26 | 165 | 1 | 0 | 5 |
CLAIM|5|一致|.agents/evidence/ci-related-tests-2026-11-14.md:10|改 `apps/agent-service/src/cache-hit-monitor.ts` 时只选出 1 个|<!-- -->| apps/agent-service/src/cache-hit-monitor.ts | 2 | 1 | 1 | 0 | 0 | 0 |
CLAIM|6|一致|.github/workflows/ci.yml:14|`ci.yml` 支持手动触发|  workflow_dispatch:
CLAIM|7|一致|.github/workflows/ci.yml:17|`ci.yml` 带基线输入|        description: 明确的比较基线 commit SHA
CLAIM|8|一致|scripts/ci/main-evidence.mjs:112|来源：`scripts/ci/main-evidence.mjs`，原话 `"MAIN_VALIDATION_CHANGED",`|    "MAIN_VALIDATION_CHANGED",
CLAIM|9|一致|scripts/ci/main-evidence.mjs:108-110|比较的目录是 `".github",`、`"ci",`、`"scripts/ci",`|".github", "ci", "scripts/ci",
CLAIM|10|一致|scripts/model-review/opencode-review.mjs:1526|合并前的复核检查要求 `--main-ref` 是被检查提交的祖先|  else if (gitStatus(["merge-base", "--is-ancestor", mainRef, head], repo).status !== 0)
CLAIM|11|一致|.claude/rules/owner-standing-rules.md:43|合并由做 PR 的线程执行。|- 合并 PR 一律由做这个 PR 的线程执行，要等 Andy 说“合并”（在那个线程或项目聊天里说都算）。不让 Andy 自己去 GitHub 操作。线程执行合并的方式是给 PR 加 `merge-queue` 标签，由合并队列完整测过后合进 `main`；改了 CI 自身文件的 PR 仍由线程直接合并（[ADR 0268](../../docs/adr/0268-merge-queue-and-related-tests-on-prs.md)）。
CLAIM|12|一致|scripts/ci/test-scope.mjs:70|只在 `pull_request` 事件上缩小范围；手动触发（合并队列的候选）、推送和夜间运行一律全量|  if (context.event !== "pull_request") return { related, reason: "full-event" };
CLAIM|13|一致|scripts/ci/test-scope.mjs:75|unit 和 contracts 照跑全量|  for (const project of projects.filter((id) => relatedEligibleProjects.includes(id))) {
CLAIM|14|一致|.agents/evidence/ci-test-timing-2026-11-13.md:9|云端容器上实测 unit 183 秒|<!-- -->| unit | 317 | 188 | 183 |
CLAIM|15|一致|.agents/evidence/ci-test-timing-2026-11-13.md:10|contracts 34 秒|<!-- -->| contracts | 43 | 33 | 34 |
CLAIM|16|一致|scripts/ci/test-scope.mjs:6|integration、e2e、pi-compat、tooling 只跑 `vitest list --changed <PR 基线>` 选出的测试|export const relatedEligibleProjects = ["integration", "e2e", "pi-compat", "tooling"];
CLAIM|17|一致|scripts/ci/test-scope.mjs:37|integration、e2e、pi-compat、tooling 只跑 `vitest list --changed <PR 基线>` 选出的测试|        "list",
CLAIM|18|一致|scripts/ci/test-scope.mjs:44|integration、e2e、pi-compat、tooling 只跑 `vitest list --changed <PR 基线>` 选出的测试|        "--changed",
CLAIM|19|一致|scripts/ci/run.mjs:224|可以是零个|        if (selected?.length === 0) {
CLAIM|20|一致|scripts/ci/test-scope.mjs:10|改动里只要有一个文件不是 `apps/`、`packages/`、`test/` 下的 `.ts`、`.tsx`、`.mts`、`.cts`、`.js`、`.mjs`、`.cjs` 源码|  /^(?:apps|packages|test)\/.+\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/u.test(file) &&
CLAIM|21|一致|scripts/ci/test-scope.mjs:11|配置文件 `*.config.*` 也不算源码|  !/(?:^|\/)[^/]*\.config\.[^/]+$/u.test(file) &&
CLAIM|22|一致|scripts/ci/test-scope.mjs:12|`vitest.*` 也不算源码|  !/(?:^|\/)vitest\.[^/]+$/u.test(file);
CLAIM|23|一致|scripts/ci/test-scope.mjs:8|也不是 `.md` 或 `.agents/` 下的记录|const ignorable = (file) => file.startsWith(".agents/") || file.endsWith(".md");
CLAIM|24|一致|scripts/ci/test-scope.mjs:15|改动里只要有一个文件不是源码……就全部全量|  const fullFiles = files.filter((file) => !ignorable(file) && !sourceFile(file));
CLAIM|25|一致|test/tooling/test-scope.test.mjs:41|所以改依赖、SQL、JSON、`scripts/`、`ci/`、`.github/` 都跑全量|    "scripts/operations/cache-hit-report.mjs",
CLAIM|26|一致|packages/prompt-catalog/src/chat.ts:3|提示词写在 `packages/prompt-catalog/src/` 的 `.ts` 文件里|export const CHAT_IDENTITY = fixedPrompt({
CLAIM|27|一致|scripts/ci/test-scope.mjs:77|某个项目的 `vitest list` 出错时，那个项目退回全量|    if (files === null) fallback.push(project);
CLAIM|28|一致|scripts/ci/run.mjs:218|检查结果里记下哪些项目只跑了相关测试（`relatedProjects`）|      if (plan.related.size) result.relatedProjects = [...plan.related.keys()];
CLAIM|29|一致|scripts/ci/aggregate.mjs:241|汇总结果标 `scope: related`|    scope: relatedScope ? "related" : "full",
CLAIM|30|一致|scripts/ci/aggregate.mjs:103|汇总只在 PR 上接受相关范围|      if (context.event !== "pull_request")
CLAIM|31|一致|scripts/ci/aggregate.mjs:106|只接受上面四个项目|        if (!check.projects.includes(id) || !relatedEligibleProjects.includes(id))
CLAIM|32|一致|scripts/ci/aggregate.mjs:111|只有声明了相关范围的项目才允许零计数|    if (!(skipped(result.counts) && check.projects.every((id) => related.has(id))))
CLAIM|33|一致|scripts/ci/main-evidence.mjs:221|main 的轻量确认不接受标成 `related` 的 PR 结果（`MAIN_GATE_RELATED_SCOPE`）|  assert(summary.scope !== "related", "MAIN_GATE_RELATED_SCOPE");
CLAIM|34|一致|scripts/ci/main-evidence.mjs:253|`main-evidence.mjs` 拿不到可用证据时退回 `mode: "full"`|  let result = { mode: "full", reason: "evidence-unavailable" };
CLAIM|35|一致|test/tooling/main-evidence.test.mjs:171|PR 上本来就跑了全量的（例如改了 `package.json` 的 PR），main 仍可走轻量确认|    expect(verifyGate(full)).toMatchObject({ mode: "light" });
CLAIM|36|一致|scripts/ci/main-evidence.mjs:112|改了 `.github`、`ci`、`scripts/ci` 的提交在 main 上一律跑全量（`MAIN_VALIDATION_CHANGED`）|    "MAIN_VALIDATION_CHANGED",
CLAIM|37|一致|.github/workflows/merge-queue.yml:29|工作流 `.github/workflows/merge-queue.yml` 在 ARM 机器上跑|    runs-on: ci-arm
CLAIM|38|一致|docs/runbooks/ci-vps-runner-runbook.md:180|工作流 `.github/workflows/merge-queue.yml` 在 ARM 机器上跑|第二处 runner 装在 Andy 的 Oracle 东京 ARM 机器上（Ubuntu 24.04，处理器是 64 位 ARM，系统里显示为 `aarch64`；4 核 24 GB，公网地址 `138.2.31.252`，这台机器同时是测试机）。那里有两个 runner：`ci-arm-1` 和 `ci-arm-2`，标签都是 `ci-arm`，合计最多用 18 GB 内存。
CLAIM|39|一致|.github/workflows/merge-queue.yml:3|触发方式是 CI 跑完（`workflow_run`）|  workflow_run:
CLAIM|40|一致|.github/workflows/merge-queue.yml:7|每 10 分钟定时|    - cron: "*/10 * * * *"
CLAIM|41|一致|.github/workflows/merge-queue.yml:8|手动触发|  workflow_dispatch:
CLAIM|42|一致|.github/workflows/merge-queue.yml:21|`concurrency` 保证同时只有一个在跑|    group: merge-queue
CLAIM|43|一致|.github/workflows/merge-queue.yml:34|它只检出 `main`|          ref: main
CLAIM|44|一致|.github/workflows/merge-queue.yml:43|只运行 `main` 上的 `scripts/ci/merge-queue.mjs`|        run: node scripts/ci/merge-queue.mjs
CLAIM|45|一致|test/tooling/merge-queue.test.mjs:577|不用 `pull_request_target`|    expect(text).not.toContain("pull_request_target");
CLAIM|46|一致|test/tooling/merge-queue.test.mjs:578|不执行 PR 的代码|    expect(text).not.toMatch(/head\.sha|head_ref|head\.ref|github\.event\.workflow_run\.head/u);
CLAIM|47|一致|scripts/ci/merge-queue.mjs:120|PR 的内容只当作 git 数据合并|          "merge",
CLAIM|48|一致|scripts/ci/merge-queue.mjs:9|队列状态存在 `merge-queue-state` 分支的 `state.json`|export const stateBranch = "merge-queue-state";
CLAIM|49|一致|scripts/ci/merge-queue.mjs:173|队列状态带格式校验|      return { state: validateState(JSON.parse(text)), parent };
CLAIM|50|一致|scripts/ci/merge-queue.mjs:64|当前候选（分支名、提交、基于哪个 main、每个 PR 的头提交和合入后的树、对应的 CI 运行）、待测分组、是否已停下|        candidate.prs.every((pr) => isPositive(pr.number) && isSha(pr.head) && isSha(pr.tree)),
CLAIM|51|一致|scripts/ci/merge-queue.mjs:444|main 被别的方式改了就取消候选的 CI、丢掉候选|        await github.cancel(run.id);
CLAIM|52|一致|scripts/ci/merge-queue.mjs:14|超过 3 小时也取消后丢掉|export const candidateTimeoutMs = 3 * 3600_000;
CLAIM|53|一致|scripts/ci/merge-queue.mjs:13|触发 15 分钟还找不到运行就丢掉|export const runGraceMs = 15 * 60_000;
CLAIM|54|一致|scripts/ci/merge-queue.mjs:378|先确认 main 还是候选的基线|    if (main !== candidate.base) return drop("main-moved");
CLAIM|55|一致|scripts/ci/merge-queue.mjs:380|每个 PR 还开着、还有标签、头提交没变|      const problem = livePrProblem(await github.pull(pr.number), github.repository, pr.head);
CLAIM|56|一致|scripts/ci/merge-queue.mjs:388|逐个调合并接口（带 `sha`）|      const result = await github.merge(pr.number, pr.head);
CLAIM|57|一致|scripts/ci/merge-queue.mjs:387|每次合并前确认 main 等于上一步的结果|      if (current !== expected) return drop(`main-moved-during-merge after ${merged.join(",")}`);
CLAIM|58|一致|scripts/ci/merge-queue.mjs:398|不一致就停下整个队列（状态里写原因，在 PR 上留言）|        stop(`main ${after} 和候选 ${candidate.sha} 里 #${pr.number} 合入后的树不一致`);
CLAIM|59|一致|scripts/ci/merge-queue.mjs:408|合完的 PR 去掉标签并留言|      await github.removeLabel(pr.number, queueLabel);
CLAIM|60|一致|scripts/ci/merge-queue.mjs:423|只有一个 PR 时把它移出队列（去掉 `merge-queue`、加 `merge-queue-failed`、留言带运行链接）|      await eject(candidate.prs[0].number, `它和当前 main 合在一起后完整 CI 没过：${run.url}`);
CLAIM|61|一致|scripts/ci/merge-queue.mjs:79|多于一个时拆成前后两半排在最前面，依次测|  return [numbers.slice(0, middle), numbers.slice(middle), ...rest];
CLAIM|62|一致|scripts/ci/merge-queue.mjs:502|按最近一次加标签的时间排序|      stamped.sort((a, b) => a.at.localeCompare(b.at) || a.number - b.number);
CLAIM|63|一致|scripts/ci/merge-queue.mjs:12|取最多 5 个就绪的 PR|export const batchLimit = 5;
CLAIM|64|一致|scripts/ci/merge-queue.mjs:463|取就绪的 PR（开着、不是草稿、来自本仓库、目标是 main）|    const problem = livePrProblem(pr, github.repository);
CLAIM|65|一致|scripts/ci/merge-queue.mjs:475|PR 头上 `ci/required` 成功|    if (check.state !== "success")
CLAIM|66|一致|scripts/ci/merge-queue.mjs:477|复核检查通过|    const review = checkReview(number, head, main);
CLAIM|67|一致|scripts/ci/merge-queue.mjs:464|已关闭的、标签已被摘掉的……都跳过，不移出|    if (problem === "closed" || problem === "unlabeled") return { skip: true };
CLAIM|68|一致|scripts/ci/merge-queue.mjs:467|PR 头在读取期间刚变的……都跳过，不移出|    if (head !== pr.head.sha) return { skip: true };
CLAIM|69|一致|scripts/ci/merge-queue.mjs:474|`ci/required` 还在跑或还没有的，都跳过，不移出|    if (check.state === "pending" || check.state === "missing") return { skip: true };
CLAIM|70|一致|scripts/ci/merge-queue.mjs:465|其余不满足的移出并留言|    if (problem) return { eject: `PR 状态不满足排队条件（${problem}）` };
CLAIM|71|一致|scripts/ci/merge-queue.mjs:121|以当前 main 为底逐个 `git merge --no-ff`|          "--no-ff",
CLAIM|72|一致|scripts/ci/merge-queue.mjs:518|冲突的移出|    for (const number of built.conflicts)
CLAIM|73|一致|scripts/ci/merge-queue.mjs:527|推到唯一的 `mq/<运行号>-<尝试次数>` 分支|    const branch = `${candidatePrefix}${runTag}`;
CLAIM|74|一致|scripts/ci/merge-queue.mjs:529|手动触发 `ci.yml`（基线是当前 main）|    await github.dispatch(branch, main);
CLAIM|75|一致|scripts/ci/merge-queue.mjs:312|复核检查在 PR 头的临时检出上运行|    repo.withWorktree(head, (dir) => {
CLAIM|76|一致|scripts/ci/merge-queue.mjs:323|`--main-ref` 用 main 和 PR 头的共同祖先|          repo.mergeBase(main, head),
CLAIM|77|一致|scripts/ci/merge-queue.mjs:11|改了 `.github`、`ci`、`scripts/ci` 的 PR 不进队列|export const protectedPaths = [".github", "ci", "scripts/ci"];
CLAIM|78|一致|scripts/ci/merge-queue.mjs:555|只在 `DELIVERY_MODE` 为 `fast` 时工作|  if (mode !== "fast") {
CLAIM|79|一致|scripts/delivery-mode/github-ruleset.sh:29|完整模式的规则集要求 PR 分支包含 main 的最新提交（第 29 行 `"strict_required_status_checks_policy": true`）|        "strict_required_status_checks_policy": true,
CLAIM|80|一致|.github/workflows/merge-queue.yml:41|合并用 `GITHUB_TOKEN`|          HIMAWARI_CI_GITHUB_TOKEN: ${{ github.token }}
CLAIM|81|一致|test/tooling/test-scope.test.mjs:41|改了 `scripts/` 下的文件时……这个 PR 会退回完整测试|    "scripts/operations/cache-hit-report.mjs",
CLAIM|82|一致|scripts/ci/merge-queue.mjs:582|确认没事后手动触发 “Merge queue” 工作流并把 `resume` 填成 true，队列才会继续|    resume: env.GITHUB_EVENT_NAME === "workflow_dispatch" && env.MQ_RESUME === "true",
CLAIM|83|一致|test/tooling/merge-queue.test.mjs:212|`test/tooling/merge-queue.test.mjs`：用真实 git 仓库和假的 GitHub 接口，覆盖按顺序建候选、通过后逐个合并并核对树、失败拆半直到找出单个 PR、两半各自都过合在一起失败、改 CI 文件被拒、CI 未完成跳过、复核不过被拒、冲突、main 被抢先改、合并前 PR 变化、树不一致时停下、运行被取消或超时、找不到运行、完整模式不工作、草稿和 fork 被拒、一批最多 5 个、复核检查的参数、合并接口重试、工作流不检出 PR 代码|describe("合并队列 [ADR-0268]", () => {
CLAIM|84|一致|test/tooling/test-scope.test.mjs:23|`test/tooling/test-scope.test.mjs`：哪些改动走相关测试、哪些全量；不是 PR 时全量；`vitest list` 的参数和失败退回全量|describe("PR 上测试范围的选择 [ADR-0268]", () => {
CLAIM|85|一致|test/tooling/aggregate.test.mjs:116|`test/tooling/aggregate.test.mjs`……里名字带 `[ADR-0268]` 的用例：相关范围只在 PR 上、只对四个项目、零计数只在声明了相关范围时接受|describe("PR 上只跑相关测试时的汇总 [ADR-0268]", () => {
CLAIM|86|一致|test/tooling/runner-orchestration.test.mjs:403|`test/tooling/runner-orchestration.test.mjs` 里名字带 `[ADR-0268]` 的用例：相关项目记入 `relatedProjects`、零计数|  it("[ADR-0268] PR 上 tooling 没有相关测试时不启动 vitest，结果记下相关范围和零计数", async () => {
CLAIM|87|一致|test/tooling/main-evidence.test.mjs:165|`test/tooling/main-evidence.test.mjs` 里名字带 `[ADR-0268]` 的用例：main 不接受相关范围的结果|  it("[ADR-0268] PR 上只跑了相关测试的验收不能当 main 的证据，标成 full 的可以", () => {

外部文档（前提 2、3、4）和 GitHub 运行时行为（`GITHUB_TOKEN` 不触发工作流、`main.yml` 是否实际触发、`strict_required_status_checks_policy` 的实际拦截效果）按规则未核对；也没有实际运行测试或队列。历史说法“在这份 ADR 之前每个 PR 跑全量”同样未核实。
