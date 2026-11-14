CLAIM|1|一致|ci/policy.json:110,127|在这份 ADR 之前，按 ADR 0267，每个 PR 仍要把 unit、contracts、integration、e2e、pi-compat 和 tooling 全部跑完|      "projects": ["unit", "contracts", "integration", "e2e", "pi-compat"],\n      "projects": ["tooling"],
CLAIM|2|一致|.github/workflows/ci.yml:374-375|`ci/required`（CI 的汇总作业，PR 能不能合看它）才会变绿|      - tests\n      - tooling
CLAIM|3|一致|.agents/instructions/delivery-mode.md:27|现行合并门槛是 PR 最新提交上的 `ci/required` 成功|合并进 `main` 之前，PR 最新提交上的 `ci/required` 必须是成功
CLAIM|4|一致|.agents/evidence/ci-related-tests-2026-11-14.md:8|改 `packages/application/src/ports/memory-episodes.ts` 时 integration 选出 165 个|| packages/application/src/ports/memory-episodes.ts | 132 | 26 | 165 | 1 | 0 | 5 |
CLAIM|5|一致|.agents/evidence/ci-related-tests-2026-11-14.md:7|全量 186 个|| 全量 | 317 | 43 | 186 | - | - | - |
CLAIM|6|一致|.agents/evidence/ci-related-tests-2026-11-14.md:10|改 `apps/agent-service/src/cache-hit-monitor.ts` 时只选出 1 个|| apps/agent-service/src/cache-hit-monitor.ts | 2 | 1 | 1 | 0 | 0 | 0 |
CLAIM|7|一致|.github/workflows/ci.yml:14|`ci.yml` 支持手动触发|  workflow_dispatch:
CLAIM|8|一致|.github/workflows/ci.yml:17|并带基线输入|        description: 明确的比较基线 commit SHA
CLAIM|9|一致|scripts/ci/main-evidence.mjs:112|改了 CI 自身文件的合并不能用 PR 上的结果顶替 main 确认。|    "MAIN_VALIDATION_CHANGED",
CLAIM|10|一致|scripts/ci/main-evidence.mjs:108-110|比较的目录是 `".github",`、`"ci",`、`"scripts/ci",`。|      ".github",\n      "ci",\n      "scripts/ci",
CLAIM|11|一致|scripts/model-review/opencode-review.mjs:1530|合并前的复核检查要求 `--main-ref` 是被检查提交的祖先。|    problems.push(`main-not-merged ${printable(mainRef)}`);
CLAIM|12|一致|.claude/rules/owner-standing-rules.md:43|合并由做 PR 的线程执行。|- 合并 PR 一律由做这个 PR 的线程执行，
CLAIM|13|一致|.agents/evidence/ci-test-timing-2026-11-13.md:9|云端容器上实测 unit 183 秒|| unit | 317 | 188 | 183 |
CLAIM|14|一致|.agents/evidence/ci-test-timing-2026-11-13.md:10|contracts 34 秒|| contracts | 43 | 33 | 34 |
CLAIM|15|一致|scripts/ci/main-evidence.mjs:253|`main-evidence.mjs` 拿不到可用证据时退回 `mode: "full"`|  let result = { mode: "full", reason: "evidence-unavailable" };
CLAIM|16|一致|scripts/delivery-mode/github-ruleset.sh:29|完整模式的规则集要求 PR 分支包含 main 的最新提交（`scripts/delivery-mode/github-ruleset.sh` 第 29 行 `"strict_required_status_checks_policy": true`）|        "strict_required_status_checks_policy": true,
CLAIM|17|一致|packages/prompt-catalog/src/memory.ts:5|提示词写在 `packages/prompt-catalog/src/` 的 `.ts` 文件里|    "每条记忆用第三人称写成一句完整、独立的话（例如“主人最喜欢的颜色是蓝色”），使用消息的语言，最多 200 字。",
CLAIM|18|一致|scripts/ci/test-scope.mjs:10|`test-scope.mjs` 的 `sourceFile` 只认 `apps`、`packages`、`test` 下的源码|  /^(?:apps|packages|test)\/.+\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/u.test(file) &&
CLAIM|19|一致|scripts/ci/test-scope.mjs:15|这个 PR 会退回完整测试。|  const fullFiles = files.filter((file) => !ignorable(file) && !sourceFile(file));
CLAIM|20|一致|scripts/model-review/opencode-review.mjs:3411|`--assert-reviewed` 打印 `REVIEW_RECORD_INVALID`|      console.log(`REVIEW_RECORD_INVALID ${error.message}`);
CLAIM|21|一致|scripts/model-review/exit-codes.mjs:1|并以 5 退出|export const REVIEW_NOT_COVERED_EXIT = 5;
CLAIM|22|一致|scripts/model-review/opencode-review.mjs:2831|队列复核检查读的是 PR 自己提交的 `.agents/reviews` 记录|export const REVIEWS_DIR = ".agents/reviews";
CLAIM|23|一致|test/tooling/merge-queue.test.mjs:218|`test/tooling/merge-queue.test.mjs`：用真实 git 仓库和假的 GitHub 接口，覆盖按顺序建候选、通过后逐个合并并核对树、失败拆半直到找出单个 PR、两半各自都过合在一起失败、改 CI 文件被拒、CI 未完成跳过、复核不过被拒、冲突、main 被抢先改、合并前 PR 变化、树不一致时停下、运行被取消或超时、找不到运行、完整模式不工作、草稿和 fork 被拒、一批最多 5 个、复核检查的参数和超时、合并接口重试、加标签前先建标签、改名移出保护目录也被拒、CI 本身出错不怪 PR、连续 3 次没有结论就停下（含找不到运行）、给出结论后计数清零、复核检查没有正常退出（被杀或退出码既不是 0 也不是 5）时这一轮不建候选且连续 3 轮就停下、超时也计入没有结论、只有 already_exists 的 422 才算标签已存在、清理状态外的 mq 分支且只在建候选时清理、工作流不检出 PR 代码。|describe("合并队列 [ADR-0268]", () => {
CLAIM|24|一致|test/tooling/opencode-review-merge-gate.test.mjs:1642-1643|`test/tooling/opencode-review-merge-gate.test.mjs`：PR 里的复核账本有一行坏 JSON 时，`--assert-reviewed` 输出 `REVIEW_RECORD_INVALID` 并以 5 退出。|      expect(run.stdout).toMatch(/^REVIEW_RECORD_INVALID USAGE_LEDGER_INVALID /m);\n      expect(run.status).toBe(5);
CLAIM|25|一致|test/tooling/test-scope.test.mjs:25|`test/tooling/test-scope.test.mjs`：哪些改动走相关测试、哪些全量；不是 PR 时全量；`vitest list` 的参数和失败退回全量。|describe("PR 上测试范围的选择 [ADR-0268]", () => {
CLAIM|26|一致|test/tooling/aggregate.test.mjs:137,test/tooling/runner-orchestration.test.mjs:403,test/tooling/main-evidence.test.mjs:165|`test/tooling/aggregate.test.mjs`、`test/tooling/runner-orchestration.test.mjs`、`test/tooling/main-evidence.test.mjs` 里名字带 `[ADR-0268]` 的用例：相关范围只在 PR 上、只对四个项目、零计数只在声明了相关范围时接受；main 不接受相关范围的结果。|describe("PR 上只跑相关测试时的汇总 [ADR-0268]", () => {\n  it("[ADR-0268] PR 上 tooling 没有相关测试时不启动 vitest，结果记下相关范围和零计数", async () => {\n  it("[ADR-0268] PR 上只跑了相关测试的验收不能当 main 的证据，标成 full 的可以", () => {

未核对的部分：前提 2–4 引用的是 GitHub Actions、GitHub REST 和 vitest 的外部文档，按题目要求未纳入核对；验证部分只读了当前提交里的测试文件和用例内容，没有实际运行测试，也没有在真实 GitHub/CI 上验证队列运行效果。
