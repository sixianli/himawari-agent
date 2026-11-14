CLAIM|1|不一致|scripts/ci/test-scope.mjs:6|ADR 0267 之后，每个 PR 仍要把 unit、contracts、integration、e2e、pi-compat 和 tooling 全部跑完|export const relatedEligibleProjects = ["integration", "e2e", "pi-compat", "tooling"];
CLAIM|2|一致|.github/workflows/ci.yml:366|ci/required（CI 的汇总作业）|    name: ci/required
CLAIM|3|一致|.agents/instructions/delivery-mode.md:27|PR 能不能合看 `ci/required`|合并进 `main` 之前，PR 最新提交上的 `ci/required` 必须是成功
CLAIM|4|一致|.agents/instructions/delivery-mode.md:27|现行合并门槛是 PR 最新提交上的 `ci/required` 成功|合并进 `main` 之前，PR 最新提交上的 `ci/required` 必须是成功
CLAIM|5|一致|.agents/evidence/ci-related-tests-2026-11-14.md:14|改一个源码文件时 vitest 选出的相关测试数差别很大|结论：改到被很多地方引用的核心包时，integration 仍要跑约九成；改到边缘文件时几乎不用跑。
CLAIM|6|一致|.agents/evidence/ci-related-tests-2026-11-14.md:8|改 `packages/application/src/ports/memory-episodes.ts` 时 integration 选出 165 个|| packages/application/src/ports/memory-episodes.ts | 132 | 26 | 165 | 1 | 0 | 5 |
CLAIM|7|一致|.agents/evidence/ci-related-tests-2026-11-14.md:7|（全量 186 个）|| 全量 | 317 | 43 | 186 | - | - | - |
CLAIM|8|一致|.agents/evidence/ci-related-tests-2026-11-14.md:10|改 `apps/agent-service/src/cache-hit-monitor.ts` 时只选出 1 个|| apps/agent-service/src/cache-hit-monitor.ts | 2 | 1 | 1 | 0 | 0 | 0 |
CLAIM|9|一致|.github/workflows/ci.yml:14|`ci.yml` 支持手动触发|  workflow_dispatch:
CLAIM|10|一致|.github/workflows/ci.yml:17|并带基线输入|        description: 明确的比较基线 commit SHA
CLAIM|11|一致|scripts/ci/main-evidence.mjs:101-113|改了 CI 自身文件的合并不能用 PR 上的结果顶替 main 确认|    "MAIN_VALIDATION_CHANGED",
CLAIM|12|一致|scripts/ci/main-evidence.mjs:112|原话 `"MAIN_VALIDATION_CHANGED",`|    "MAIN_VALIDATION_CHANGED",
CLAIM|13|一致|scripts/ci/main-evidence.mjs:108-110|比较的目录是 `".github",`、`"ci",`、`"scripts/ci",`|      ".github",
CLAIM|14|一致|scripts/model-review/opencode-review.mjs:1526|合并前的复核检查要求 `--main-ref` 是被检查提交的祖先|  else if (gitStatus(["merge-base", "--is-ancestor", mainRef, head], repo).status !== 0)
CLAIM|15|一致|scripts/model-review/opencode-review.mjs:1527|原话 ``problems.push(`main-not-merged ${printable(mainRef)}`);``|    problems.push(`main-not-merged ${printable(mainRef)}`);
CLAIM|16|一致|.claude/rules/owner-standing-rules.md:43|合并由做 PR 的线程执行，原话“合并 PR 一律由做这个 PR 的线程执行”|- 合并 PR 一律由做这个 PR 的线程执行，要等 Andy 说“合并”（在那个线程或项目聊天里说都算）。
CLAIM|17|一致|scripts/ci/test-scope.mjs:6|unit 和 contracts 照跑全量|export const relatedEligibleProjects = ["integration", "e2e", "pi-compat", "tooling"];
CLAIM|18|找不到|-|两个加起来约 4 分钟|-
CLAIM|19|一致|scripts/delivery-mode/github-ruleset.sh:29|完整模式的规则集要求分支保持最新|        "strict_required_status_checks_policy": true,

前提 2、3、4 引用的 GitHub Actions、GitHub 合并接口和 vitest 文档属于外部网站，按要求没有核对；方案中新增或修改的测试范围、合并队列流程和验证用例属于计划内容，未当作现状。另有“CI 服务器 runner 一直被占满”这类运行状态说法，仓库文件无法证明。
