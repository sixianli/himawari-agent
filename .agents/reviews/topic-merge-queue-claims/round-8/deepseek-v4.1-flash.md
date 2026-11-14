CLAIM|1|一致|docs/adr/0267-ci-tests-without-coverage-on-prs.md:58|每个 PR 仍要把 unit、contracts、integration、e2e、pi-compat 和 tooling 全部跑完|跑 unit、contracts、integration、e2e、pi-compat 五个项目 / 新增 `tooling` 作业，在 Oracle 的 ARM 机器上跑，只等 policy，和 tests 并行。
CLAIM|2|一致|.github/workflows/ci.yml:366|`ci/required`（CI 的汇总作业，PR 能不能合看它）|  required: /    name: ci/required /    if: always() /    needs:
CLAIM|3|找不到|-|CI 服务器的 runner（替 GitHub 执行 CI 任务的程序）一直被占满|-
CLAIM|4|一致|.agents/instructions/delivery-mode.md:27|现行合并门槛是 PR 最新提交上的 `ci/required` 成功|GitHub 合并门槛：合并进 `main` 之前，PR 最新提交上的 `ci/required` 必须是成功
CLAIM|5|一致|.agents/instructions/delivery-mode.md:27|来源：`.agents/instructions/delivery-mode.md` 第 27 行，原话“合并进 `main` 之前，PR 最新提交上的 `ci/required` 必须是成功”|GitHub 合并门槛：合并进 `main` 之前，PR 最新提交上的 `ci/required` 必须是成功
CLAIM|6|一致|.agents/evidence/ci-related-tests-2026-11-14.md:8|改 `packages/application/src/ports/memory-episodes.ts` 时 integration 选出 165 个（全量 186 个）|| 全量 | 317 | 43 | 186 | - | - | / | packages/application/src/ports/memory-episodes.ts | 132 | 26 | 165 | 1 | 0 | 5 |
CLAIM|7|一致|.agents/evidence/ci-related-tests-2026-11-14.md:10|改 `apps/agent-service/src/cache-hit-monitor.ts` 时只选出 1 个|| apps/agent-service/src/cache-hit-monitor.ts | 2 | 1 | 1 | 0 | 0 | 0 |
CLAIM|8|一致|.github/workflows/ci.yml:14|`ci.yml` 支持手动触发并带基线输入|  workflow_dispatch:
CLAIM|9|一致|.github/workflows/ci.yml:17|原话 `workflow_dispatch:` 和 `description: 明确的比较基线 commit SHA`|        description: 明确的比较基线 commit SHA
CLAIM|10|一致|scripts/ci/main-evidence.mjs:107|改了 CI 自身文件的合并不能用 PR 上的结果顶替 main 确认|      "--", /      ".github", /      "ci", /      "scripts/ci", /    ]), /    "MAIN_VALIDATION_CHANGED",
CLAIM|11|一致|scripts/ci/main-evidence.mjs:112|原话 `"MAIN_VALIDATION_CHANGED",`|    "MAIN_VALIDATION_CHANGED",
CLAIM|12|一致|scripts/ci/main-evidence.mjs:108|比较的目录是 `".github",`、`"ci",`、`"scripts/ci",`|      ".github", /      "ci", /      "scripts/ci",
CLAIM|13|一致|scripts/model-review/opencode-review.mjs:1529|合并前的复核检查要求 `--main-ref` 是被检查提交的祖先|  else if (gitStatus(["merge-base", "--is-ancestor", mainRef, head], repo).status !== 0)
CLAIM|14|一致|scripts/model-review/opencode-review.mjs:1530|原话 ``problems.push(`main-not-merged ${printable(mainRef)}`);``|    problems.push(`main-not-merged ${printable(mainRef)}`);
CLAIM|15|一致|.claude/rules/owner-standing-rules.md:43|合并由做 PR 的线程执行|合并 PR 一律由做这个 PR 的线程执行，要等 Andy 说“合并”（在那个线程或项目聊天里说都算）。
CLAIM|16|一致|.claude/rules/owner-standing-rules.md:43|原话“合并 PR 一律由做这个 PR 的线程执行”|合并 PR 一律由做这个 PR 的线程执行，要等 Andy 说“合并”（在那个线程或项目聊天里说都算）。
CLAIM|17|一致|.agents/evidence/ci-test-timing-2026-11-13.md:9|云端容器上实测 unit 183 秒|| unit | 317 | 188 | 183 |
CLAIM|18|一致|.agents/evidence/ci-test-timing-2026-11-13.md:10|contracts 34 秒|| contracts | 43 | 33 | 34 |
CLAIM|19|一致|packages/prompt-catalog/src/tools.ts:9|提示词写在 `packages/prompt-catalog/src/` 的 `.ts` 文件里|export const TOOL_REMINDER_SET = fixedPrompt({ /   text: "给主人设一个提醒，提醒会出现在 Himawari 网页和已开启的手机通知里。
CLAIM|20|一致|scripts/ci/main-evidence.mjs:253|`main-evidence.mjs` 拿不到可用证据时退回 `mode: "full"`|  let result = { mode: "full", reason: "evidence-unavailable" };
CLAIM|21|一致|scripts/ci/main-evidence.mjs:112|改了 `.github`、`ci`、`scripts/ci` 的提交在 main 上一律跑全量（`MAIN_VALIDATION_CHANGED`）|    "MAIN_VALIDATION_CHANGED",
CLAIM|22|一致|scripts/delivery-mode/github-ruleset.sh:29|完整模式的规则集要求 PR 分支包含 main 的最新提交|        "strict_required_status_checks_policy": true,
CLAIM|23|一致|scripts/delivery-mode/github-ruleset.sh:29|`scripts/delivery-mode/github-ruleset.sh` 第 29 行 `"strict_required_status_checks_policy": true`|        "strict_required_status_checks_policy": true,

外部文档来源（GitHub Actions、GitHub REST、vitest 文档）按任务要求未核对；合并队列工作流与脚本、`test-scope.mjs` 规则、新增测试用例等属于方案新增内容，未当作现状核对。背景里 runner 被占满的运行状况在仓库内没有可核对的记录。
