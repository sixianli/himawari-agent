CLAIM|1|一致|docs/adr/0267-ci-tests-without-coverage-on-prs.md:58-59|每个 PR 仍要把 unit、contracts、integration、e2e、pi-compat 和 tooling 全部跑完|跑 unit、contracts、integration、e2e、pi-compat 五个项目。
CLAIM|2|一致|.agents/instructions/delivery-mode.md:27|现行合并门槛是 PR 最新提交上的 `ci/required` 成功|合并进 `main` 之前，PR 最新提交上的 `ci/required` 必须是成功
CLAIM|3|一致|.agents/evidence/ci-related-tests-2026-11-14.md:7|改 `packages/application/src/ports/memory-episodes.ts` 时 integration 选出 165 个（全量 186 个）|全量 | 317 | 43 | 186 | - | - | - |
CLAIM|4|一致|.agents/evidence/ci-related-tests-2026-11-14.md:8|改 `packages/application/src/ports/memory-episodes.ts` 时 integration 选出 165 个（全量 186 个）|packages/application/src/ports/memory-episodes.ts | 132 | 26 | 165 | 1 | 0 | 5 |
CLAIM|5|一致|.agents/evidence/ci-related-tests-2026-11-14.md:10|改 `apps/agent-service/src/cache-hit-monitor.ts` 时只选出 1 个|apps/agent-service/src/cache-hit-monitor.ts | 2 | 1 | 1 | 0 | 0 | 0 |
CLAIM|6|一致|.github/workflows/ci.yml:14|`ci.yml` 支持手动触发并带基线输入|workflow_dispatch:
CLAIM|7|一致|.github/workflows/ci.yml:17|`ci.yml` 支持手动触发并带基线输入|description: 明确的比较基线 commit SHA
CLAIM|8|一致|scripts/ci/main-evidence.mjs:112|改了 CI 自身文件的合并不能用 PR 上的结果顶替 main 确认|"MAIN_VALIDATION_CHANGED",
CLAIM|9|一致|scripts/ci/main-evidence.mjs:108-110|比较的目录是 `".github",`、`"ci",`、`"scripts/ci",`|".github",
CLAIM|10|一致|scripts/model-review/opencode-review.mjs:1527|合并前的复核检查要求 `--main-ref` 是被检查提交的祖先|problems.push(`main-not-merged ${printable(mainRef)}`);
CLAIM|11|一致|.claude/rules/owner-standing-rules.md:43|合并由做 PR 的线程执行|合并 PR 一律由做这个 PR 的线程执行
CLAIM|12|一致|scripts/ci/test-scope.mjs:70|只在 `pull_request` 事件上缩小范围；手动触发（合并队列的候选）、推送和夜间运行一律全量|if (context.event !== "pull_request") return { related, reason: "full-event" };
CLAIM|13|一致|scripts/ci/test-scope.mjs:6|unit 和 contracts 照跑全量|export const relatedEligibleProjects = ["integration", "e2e", "pi-compat", "tooling"];
CLAIM|14|一致|.agents/evidence/ci-test-timing-2026-11-13.md:9|云端容器上实测 unit 183 秒|unit | 317 | 188 | 183 |
CLAIM|15|一致|.agents/evidence/ci-test-timing-2026-11-13.md:10|云端容器上实测 contracts 34 秒|contracts | 43 | 33 | 34 |
CLAIM|16|一致|scripts/ci/test-scope.mjs:6|integration、e2e、pi-compat、tooling 只跑 `vitest list --changed <PR 基线>` 选出的测试|export const relatedEligibleProjects = ["integration", "e2e", "pi-compat", "tooling"];
CLAIM|17|一致|scripts/ci/test-scope.mjs:47|integration、e2e、pi-compat、tooling 只跑 `vitest list --changed <PR 基线>` 选出的测试|"--changed",
CLAIM|18|一致|scripts/ci/run.mjs:224|integration、e2e、pi-compat、tooling 只跑 `vitest list --changed <PR 基线>` 选出的测试，可以是零个|if (selected?.length === 0) {
CLAIM|19|一致|scripts/ci/test-scope.mjs:15|改动里只要有一个文件不是 `apps/`、`packages/`、`test/` 下的源码，也不是 `.md` 或 `.agents/` 下的记录，就全部全量|const fullFiles = files.filter((file) => !ignorable(file) && !sourceFile(file));
CLAIM|20|一致|scripts/ci/test-scope.mjs:10|改依赖、SQL、JSON、`scripts/`、`ci/`、`.github/` 都跑全量|/^(?:apps|packages|test)\/.+\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/u.test(file) &&
CLAIM|21|不一致|packages/prompt-catalog/src/chat.ts:3|改提示词文本都跑全量|export const CHAT_IDENTITY = fixedPrompt({
CLAIM|22|一致|scripts/ci/test-scope.mjs:77|某个项目的 `vitest list` 出错时，那个项目退回全量|if (files === null) fallback.push(project);
CLAIM|23|一致|scripts/ci/run.mjs:218|检查结果里记下哪些项目只跑了相关测试（`relatedProjects`）|if (plan.related.size) result.relatedProjects = [...plan.related.keys()];
CLAIM|24|一致|scripts/ci/aggregate.mjs:241|汇总结果标 `scope: related`|scope: relatedScope ? "related" : "full",
CLAIM|25|一致|scripts/ci/aggregate.mjs:104|汇总只在 PR 上接受相关范围|fail(checkId, matrixKey, source, "Related test scope outside pull_request");
CLAIM|26|一致|scripts/ci/aggregate.mjs:106|汇总只接受上面四个项目|if (!check.projects.includes(id) || !relatedEligibleProjects.includes(id))
CLAIM|27|一致|scripts/ci/aggregate.mjs:110|只有声明了相关范围的项目才允许零计数|related.size > 0 && JSON.stringify(counts) === JSON.stringify(zeroCounts());
CLAIM|28|一致|scripts/ci/main-evidence.mjs:221|main 的轻量确认不接受标成 `related` 的 PR 结果（`MAIN_GATE_RELATED_SCOPE`）|assert(summary.scope !== "related", "MAIN_GATE_RELATED_SCOPE");
CLAIM|29|一致|scripts/ci/main-evidence.mjs:253|`main-evidence.mjs` 拿不到可用证据时退回 `mode: "full"`|let result = { mode: "full", reason: "evidence-unavailable" };
CLAIM|30|一致|.github/workflows/main.yml:44-47|PR 上只跑了相关测试、又被人手合并的提交，在 main 上会跑全量|full:
CLAIM|31|一致|scripts/ci/main-evidence.mjs:221|PR 上本来就跑了全量的，main 仍可走轻量确认|assert(summary.scope !== "related", "MAIN_GATE_RELATED_SCOPE");
CLAIM|32|不一致|scripts/ci/main-evidence.mjs:112|PR 上本来就跑了全量的（例如改了 CI 文件的 PR），main 仍可走轻量确认|"MAIN_VALIDATION_CHANGED",
CLAIM|33|一致|.github/workflows/merge-queue.yml:3-8|触发方式是 CI 跑完（`workflow_run`）、每 10 分钟定时、手动触发|workflow_run:
CLAIM|34|一致|.github/workflows/merge-queue.yml:29|工作流在 ARM 机器上跑|runs-on: ci-arm
CLAIM|35|一致|.github/workflows/merge-queue.yml:21-22|`concurrency` 保证同时只有一个在跑|group: merge-queue
CLAIM|36|一致|.github/workflows/merge-queue.yml:34-43|它只检出 `main`、只运行 `main` 上的 `scripts/ci/merge-queue.mjs`|ref: main
CLAIM|37|一致|test/tooling/merge-queue.test.mjs:577|不用 `pull_request_target`，不执行 PR 的代码|expect(text).not.toContain("pull_request_target");
CLAIM|38|一致|scripts/ci/merge-queue.mjs:9|队列状态存在 `merge-queue-state` 分支的 `state.json`（带格式校验）|export const stateBranch = "merge-queue-state";
CLAIM|39|一致|scripts/ci/merge-queue.mjs:64|当前候选含分支名、提交、基于哪个 main、每个 PR 的头提交和合入后的树、对应的 CI 运行|candidate.prs.every((pr) => isPositive(pr.number) && isSha(pr.head) && isSha(pr.tree)),
CLAIM|40|一致|scripts/ci/merge-queue.mjs:14|超过 3 小时也取消后丢掉|export const candidateTimeoutMs = 3 * 3600_000;
CLAIM|41|一致|scripts/ci/merge-queue.mjs:13|触发 15 分钟还找不到运行就丢掉|export const runGraceMs = 15 * 60_000;
CLAIM|42|一致|scripts/ci/merge-queue.mjs:378-381|先确认 main 还是候选的基线、每个 PR 还开着、还有标签、头提交没变，有一项不满足就一个都不合、丢掉候选|if (main !== candidate.base) return drop("main-moved");
CLAIM|43|一致|scripts/ci/merge-queue.mjs:388|逐个调合并接口（带 `sha`）|const result = await github.merge(pr.number, pr.head);
CLAIM|44|一致|scripts/ci/merge-queue.mjs:393-396|合并后核对 main 的两个父提交和树与候选里这一步完全一致|repo.tree(after) !== pr.tree
CLAIM|45|一致|scripts/ci/merge-queue.mjs:398|不一致就停下整个队列（状态里写原因，在 PR 上留言）|stop(`main ${after} 和候选 ${candidate.sha} 里 #${pr.number} 合入后的树不一致`);
CLAIM|46|一致|scripts/ci/merge-queue.mjs:422-424|只有一个 PR 时把它移出队列（去掉 `merge-queue`、加 `merge-queue-failed`、留言带运行链接）|if (candidate.prs.length === 1) {
CLAIM|47|一致|scripts/ci/merge-queue.mjs:77|多于一个时拆成前后两半排在最前面，依次测|export function splitGroups(numbers, rest) {
CLAIM|48|一致|scripts/ci/merge-queue.mjs:501|按最近一次加标签的时间排序|stamped.push({ number, at: (await github.labeledAt(number)) ?? "" });
CLAIM|49|一致|scripts/ci/merge-queue.mjs:12|取最多 5 个就绪的 PR|export const batchLimit = 5;
CLAIM|50|一致|scripts/ci/merge-queue.mjs:467|已关闭的、标签已被摘掉的、PR 头在读取期间刚变的都跳过，不移出|if (head !== pr.head.sha) return { skip: true };
CLAIM|51|一致|scripts/ci/merge-queue.mjs:11|改了 `.github`、`ci`、`scripts/ci` 的 PR 不进队列|export const protectedPaths = [".github", "ci", "scripts/ci"];
CLAIM|52|一致|scripts/ci/merge-queue.mjs:518|以当前 main 为底逐个 `git merge --no-ff`，冲突的移出|for (const number of built.conflicts)
CLAIM|53|一致|scripts/ci/merge-queue.mjs:527|推到唯一的 `mq/<运行号>-<尝试次数>` 分支|const branch = `${candidatePrefix}${runTag}`;
CLAIM|54|一致|scripts/ci/merge-queue.mjs:529|手动触发 `ci.yml`（基线是当前 main），完整跑一遍|await github.dispatch(branch, main);
CLAIM|55|一致|scripts/ci/merge-queue.mjs:317|复核检查在 PR 头的临时检出上运行 main 上的 `opencode-review.mjs --assert-reviewed`|"--assert-reviewed",
CLAIM|56|一致|scripts/ci/merge-queue.mjs:323|`--main-ref` 用 main 和 PR 头的共同祖先|repo.mergeBase(main, head),
CLAIM|57|一致|scripts/ci/merge-queue.mjs:555|只在 `DELIVERY_MODE` 为 `fast` 时工作|if (mode !== "fast") {
CLAIM|58|一致|scripts/delivery-mode/github-ruleset.sh:29|完整模式的规则集要求 PR 分支包含 main 的最新提交（第 29 行 `"strict_required_status_checks_policy": true`）|"strict_required_status_checks_policy": true,
CLAIM|59|一致|scripts/ci/merge-queue.mjs:556|完整模式下队列什么都不做|log(`MQ_MODE_UNSUPPORTED ${mode}`);
CLAIM|60|一致|.github/workflows/merge-queue.yml:41|合并用 `GITHUB_TOKEN`|HIMAWARI_CI_GITHUB_TOKEN: ${{ github.token }}
CLAIM|61|一致|scripts/ci/merge-queue.mjs:396|候选的完整 CI 测的就是合并后 main 的那棵树，合完核对树一致|repo.tree(after) !== pr.tree
CLAIM|62|一致|scripts/ci/test-scope.mjs:9|改了 `scripts/` 下的文件时，`sourceFile` 只认 `apps`、`packages`、`test` 下的源码，这个 PR 会退回完整测试|const sourceFile = (file) =>
CLAIM|63|一致|.agents/evidence/ci-test-timing-2026-11-13.md:9-10|unit、contracts 两项合起来只有几分钟|unit | 317 | 188 | 183 |
CLAIM|64|一致|test/tooling/merge-queue.test.mjs:47|`merge-queue.test.mjs` 用真实 git 仓库|git(root, ["init", "--quiet", "--bare", "-b", "main", origin]);
CLAIM|65|一致|test/tooling/merge-queue.test.mjs:70|`merge-queue.test.mjs` 用假的 GitHub 接口|class FakeGithub {
CLAIM|66|一致|test/tooling/merge-queue.test.mjs:212|`merge-queue.test.mjs` 覆盖按顺序建候选、通过后逐个合并并核对树、失败拆半直到找出单个 PR 等场景|describe("合并队列 [ADR-0268]", () => {
CLAIM|67|一致|test/tooling/test-scope.test.mjs:120|`test-scope.test.mjs` 覆盖哪些改动走相关测试、哪些全量、不是 PR 时全量、`vitest list` 的参数和失败退回全量|it("用 vitest list --changed 以 PR 基线找相关测试，输出改成仓库相对路径并去重排序；vitest 失败时返回 null", () => {
CLAIM|68|一致|test/tooling/aggregate.test.mjs:116|`aggregate.test.mjs` 里名字带 `[ADR-0268]` 的用例覆盖相关范围只在 PR 上、只对四个项目、零计数只在声明了相关范围时接受|describe("PR 上只跑相关测试时的汇总 [ADR-0268]", () => {
CLAIM|69|一致|test/tooling/runner-orchestration.test.mjs:403|`runner-orchestration.test.mjs` 里名字带 `[ADR-0268]` 的用例|it("[ADR-0268] PR 上 tooling 没有相关测试时不启动 vitest，结果记下相关范围和零计数", async () => {
CLAIM|70|一致|test/tooling/main-evidence.test.mjs:165|`main-evidence.test.mjs` 里名字带 `[ADR-0268]` 的用例：main 不接受相关范围的结果|it("[ADR-0268] PR 上只跑了相关测试的验收不能当 main 的证据，标成 full 的可以", () => {
CLAIM|71|一致|scripts/ci/merge-queue.mjs:545-547|队列停下后要人工看原因，确认没事后手动触发 “Merge queue” 工作流并把 `resume` 填成 true，队列才会继续|if (state.stopped && resume) {

未核对的部分：前提 2、3、4 引用的 GitHub Actions、GitHub 合并接口和 vitest 官方文档都是站外资料，未核对；“runner 一直被占满”、`GITHUB_TOKEN` 合并不触发 `main.yml`、私有仓库 merge queue 是否免费属于运行态或外部产品行为，也未核对。
