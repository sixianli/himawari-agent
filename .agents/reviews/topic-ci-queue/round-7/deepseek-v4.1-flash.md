CLAIM|1|一致|docs/adr/0176-ci-on-ovh-vps.md:12|CI（持续集成，每次推送后 GitHub Actions 自动跑的检查）在 Andy 租的一台 CI 服务器上跑|# ADR 0176：CI 全部搬到 OVH 的 VPS 上，注销 Hermes 上的 runner
CLAIM|2|一致|scripts/operations/ci-runner/runners.sh:1|机器上装了两个 runner|RUNNER_IDS="1 2"
CLAIM|3|一致|.agents/evidence/ci-queue-2026-11-12.md:14|每个 runner 一次只跑一个作业|- 每个 runner 一次只跑一个作业：历次读到的作业记录里，同一个 runner 名下同一时刻最多一个 `in_progress` 的作业。
CLAIM|4|一致|.agents/evidence/ci-queue-2026-11-12.md:7|2026-11-12 晚上仓库有 28 次运行在排队，新 PR 的检查要等几个小时才开始|- 2026-11-12 19:30 JST：仓库有 28 次 CI 运行在排队，新 PR 的检查要等几个小时才开始。
CLAIM|5|一致|.agents/evidence/ci-queue-2026-11-12.md:15|一次 main 合并后的确认等了近 4 小时|- main 上 06:55 UTC 创建的确认（运行 43171503136）到 10:50 UTC 才开始跑第一个作业，一次 main 合并后的确认等了近 4 小时。
CLAIM|6|一致|.github/workflows/ci.yml:25,32|草稿 PR 和被新推送取消的运行，检查作业都不跑|  cancel-in-progress: ${{ github.event_name == 'pull_request' }}；    if: ${{ github.event_name != 'pull_request' || github.event.pull_request.draft != true }}
CLAIM|7|一致|docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md:55|汇总作业 `ci/required` 按 ADR 0241 必须运行并判失败|`ci/required` 仍带 `always()`，但第一步（在检出代码、装工具之前）是一段不依赖任何安装的 bash：草稿 PR 打印 `CI_DRAFT_UNVERIFIED` 并失败
CLAIM|8|一致|docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md:79|它只要几秒钟|- 草稿 PR 每次推送只占 runner 几秒（汇总作业的入口检查），队列里只剩准备合并的 PR 和 main。
CLAIM|9|一致|.agents/evidence/ci-queue-2026-11-12.md:10|13 分钟的检查作业|- 作业时长（作业记录里的开始和结束时间）：policy 13 到 14 分钟，static 13 到 14 分钟，build 约 6 分钟，security 约 6 分钟。
CLAIM|10|一致|.github/workflows/ci.yml:33,327|汇总作业和检查作业排同一个队|    runs-on: ci-vps；    runs-on: ci-vps
CLAIM|11|一致|.agents/evidence/ci-queue-2026-11-12.md:9|同一个 PR 的新运行要等旧运行的汇总作业结束才开始|- 同一个 PR 的新运行处于 `pending`，要等旧运行的 `ci/required` 跑完才开始，例如 PR 439：43188147300 排队，43193780006 等待。
CLAIM|12|一致|.agents/evidence/ci-queue-2026-11-12.md:8|当晚 28 次排队里有 20 次只剩这个几秒钟的作业在等|- 这 28 次里有 20 次是检查作业已跳过或已取消、只剩 `ci/required` 在等 runner 的运行，例如运行 43188147300、43191538886、43186918106。
CLAIM|13|一致|.github/workflows/main.yml:10|每合并一次就排一次，互不顶替，连续合并 6 次就排 6 次确认|  group: main-confirmation-${{ github.run_id }}；  cancel-in-progress: false
CLAIM|14|一致|.github/workflows/main.yml:46|证据取得到时是轻量确认，取不到时是完整检查|    if: always() && (needs.plan.result != 'success' || needs.plan.outputs.mode != 'light')；    if: needs.plan.result == 'success' && needs.plan.outputs.mode == 'light'
CLAIM|15|一致|.github/workflows/ci.yml:324-327|`.github/workflows/ci.yml` 第 324 到 327 行，原话 `required:` / `if: always()` / `runs-on: ci-vps`|  required:；    if: always()；    runs-on: ci-vps
CLAIM|16|一致|docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md:55|`ci/required` 仍带 `always()`，但第一步……草稿 PR 打印 `CI_DRAFT_UNVERIFIED` 并失败|`ci/required` 仍带 `always()`，但第一步（在检出代码、装工具之前）是一段不依赖任何安装的 bash：草稿 PR 打印 `CI_DRAFT_UNVERIFIED` 并失败
CLAIM|17|一致|docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md:37|GitHub 把被跳过的作业当成成功……所以汇总作业不能跟着跳过，否则草稿会显示成“通过”|但 GitHub 把被跳过的作业当成成功；所以汇总作业不能跟着跳过，否则草稿会显示成“通过”。
CLAIM|18|一致|scripts/operations/ci-runner/runners.sh:1,3|只有两个 runner，标签相同|RUNNER_IDS="1 2"；RUNNER_LABEL=ci-vps
CLAIM|19|一致|scripts/operations/ci-runner/runners.sh:15,22|`RUNNER_NAME=ci-vps-1`、`RUNNER_NAME=ci-vps-2`|      RUNNER_NAME=ci-vps-1；      RUNNER_NAME=ci-vps-2
CLAIM|20|一致|docs/adr/0176-ci-on-ovh-vps.md:54|先装 2 个，跑一次完整 CI 再决定要不要加到 3|先装 2 个，跑一次完整 CI 再决定要不要加到 3 个。
CLAIM|21|一致|.github/workflows/main.yml:9-11|`.github/workflows/main.yml` 第 9 到 11 行，原话 `group: main-confirmation-${{ github.run_id }}`、`cancel-in-progress: false`|  group: main-confirmation-${{ github.run_id }}；  cancel-in-progress: false
CLAIM|22|一致|scripts/operations/ci-runner/register-runner.sh:29|`scripts/operations/ci-runner/register-runner.sh` 第 29 行 `--labels "$RUNNER_LABEL"`|  --labels "$RUNNER_LABEL" \
CLAIM|23|一致|.agents/evidence/ci-queue-2026-11-12.md:7-10|实测（2026-11-12 19:30 JST，GitHub 接口）：28 次排队的运行里多数只剩 `ci/required` 在等 runner，前面排着 6 到 14 分钟的检查作业；同一个 PR 的新运行要等旧运行的 `ci/required` 结束才开始|2026-11-12 19:30 JST：仓库有 28 次 CI 运行在排队；这 28 次里有 20 次……只剩 `ci/required` 在等 runner；policy 13 到 14 分钟，static 13 到 14 分钟，build 约 6 分钟，security 约 6 分钟；同一个 PR 的新运行处于 `pending`，要等旧运行的 `ci/required` 跑完才开始
CLAIM|24|一致|ci/policy.json:69,77,85|`ci/policy.json` 第 69、77、85 行各有一个 `"runner": "ci-vps"` 的 browser 成员|          "runner": "ci-vps",
CLAIM|25|一致|.github/workflows/ci.yml:177-189|`browser` 是 3 个浏览器各一个作业|          - key: chromium；          - key: firefox；          - key: webkit
CLAIM|26|一致|ci/policy.json:129|一次完整运行实际是 8 个检查作业加汇总作业|      "needs": ["policy", "static", "build", "browser", "coverage", "security"],
CLAIM|27|一致|.github/workflows/ci.yml:73-74,116-117,237-239,285-286|static、build、coverage、security 都要等 policy 跑完才开始|    needs:；      - policy
CLAIM|28|一致|scripts/ci/required.mjs:22|`ci/required` 用目标分支上的 `ci/policy.json` 校验工作流，旧写法靠升级函数过渡|  const source = resolvePolicySource({ root, base: context.baseSha });
CLAIM|29|一致|scripts/ci/check-policy.mjs:1191|`scripts/ci/check-policy.mjs` 第 1191 行，原话 `upgradeArtifactRetention(upgradeRunnerLabel(upgradeHostedRunnerPolicy(JSON.parse(bytes))))`|      upgradeArtifactRetention(upgradeRunnerLabel(upgradeHostedRunnerPolicy(JSON.parse(bytes)))),
CLAIM|30|一致|ci/policy.schema.json:64|`ci/policy.schema.json` 第 64 行 `"enum": ["ci-vps", "macos-15"]`|                  "enum": ["ci-vps", "macos-15"]
CLAIM|31|一致|scripts/operations/ci-runner/gh-runner.service.in:37|`scripts/operations/ci-runner/gh-runner.service.in` 第 37 行，原话 `InaccessiblePaths=-/run/docker.sock -/var/run/docker.sock -@OTHER_ROOT@`|InaccessiblePaths=-/run/docker.sock -/var/run/docker.sock -@OTHER_ROOT@
CLAIM|32|一致|.agents/evidence/ci-queue-2026-11-12.md:13,15|2026-11-12 19:52 JST 再量一次：28 次排队里 20 次只剩 `ci/required` 在等；两个 runner 都在干活，一个作业约 13 分钟；main 上 06:55 UTC 创建的确认到 10:50 UTC 才开始跑第一个作业|- 2026-11-12 19:52 JST 再量一次：28 次排队里 20 次只剩 `ci/required` 在等；两个 runner 都在干活……一个作业约 13 分钟。；- main 上 06:55 UTC 创建的确认（运行 43171503136）到 10:50 UTC 才开始跑第一个作业
CLAIM|33|一致|.agents/evidence/ci-queue-2026-11-12.md:11|policy 作业峰值内存 2.68 GB，来源：作业日志 `peakBytes: 2682445824`|- policy 作业日志里的资源记录：`peakBytes: 2682445824`（约 2.68 GB），机器 8 核。
CLAIM|34|一致|docs/adr/0176-ci-on-ovh-vps.md:34|机器 8 核 22 GB|8 个 vCPU（虚拟 CPU 核），22 GB 内存
CLAIM|35|一致|scripts/operations/ci-runner/gh-runners.slice:7|两个 runner 合计内存上限 20 GB|MemoryMax=20G
CLAIM|36|一致|scripts/ci/context.mjs:108|`scripts/ci/context.mjs` 第 97 到 108 行把合并提交的第一个父提交当基准|    baseSha = parents[0];
CLAIM|37|一致|scripts/operations/ci-runner/gh-runner.service.in:9|所有 runner 的服务都放在同一个内存池里（现在是两个，直接再加一个也会进这个池子）|Slice=gh-runners.slice
CLAIM|38|一致|scripts/operations/ci-runner/gh-runners.slice:6-7|池子上限 20 GB|MemoryHigh=19G；MemoryMax=20G
CLAIM|39|一致|scripts/operations/ci-runner/gh-runner.service.in:25-26|`gh-runner.service.in` 第 25、26 行 `MemoryHigh=14G`、`MemoryMax=15G`|MemoryHigh=14G；MemoryMax=15G
CLAIM|40|一致|scripts/operations/ci-runner/mac-runners.sh:4|`scripts/operations/ci-runner/mac-runners.sh` 第 4 行 `LABEL=$RUNNER_LABEL`|LABEL=$RUNNER_LABEL
CLAIM|41|一致|scripts/operations/ci-runner/mac-runners.sh:86,90|暂停和恢复靠 Mac 上的脚本增删一个全局标签|  gh api -X POST "repos/$REPO/actions/runners/$1/labels" -f "labels[]=$LABEL" > /dev/null；  gh api -X DELETE "repos/$REPO/actions/runners/$1/labels/$LABEL" > /dev/null
CLAIM|42|一致|scripts/operations/ci-runner/register-runner.sh:11-12|`register-runner.sh` 第 11 到 14 行只接受 `1` 和 `2`|case "${1:-}" in；  1|2) runner_select "$1" ;;
CLAIM|43|一致|scripts/operations/ci-runner/uninstall-runner.sh:10-12|`uninstall-runner.sh` 第 10 到 14 行只接受 `2` 和 `all`|case "${1:-}" in；  2) REMOVE="2" ;;；  all) REMOVE="$RUNNER_IDS" ;;
CLAIM|44|一致|.github/workflows/ci.yml:350,366|`.github/workflows/ci.yml` 第 350 到 366 行（检出后运行 `scripts/ci/required.mjs`）|      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683；        run: .ci-output/tools/bin/node scripts/ci/required.mjs --reports .ci-output/reports --output .ci-output/gate --base "$CI_BASE"
CLAIM|45|一致|docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md:58|这是 ADR 0241 决定第 5 条|5. **runner 上保留 npm 依赖缓存。**
CLAIM|46|一致|docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md:46|Andy 2026-11-11 已同意|2026-11-11，问三项取舍（草稿 PR 完全不跑 CI、合并前要等 CI 变绿、runner 上保留 npm 依赖缓存）的建议，三项都建议做之后，答：“同意”。
CLAIM|47|一致|.github/workflows/ci.yml:53|还没实现|        run: node scripts/ci/install-dependencies.mjs --tools .ci-output/tools --evidence .ci-output/installation --cache .ci-output/npm-cache
CLAIM|48|找不到|-|模型的意见怎么处理的（记录在 `.agents/reviews/topic-ci-queue/`）|-
CLAIM|49|找不到|-|它只跑 15 秒，不是排队的来源|-

未核对的部分：GitHub 官方文档里的并发组、跳过作业状态、标签参数和 `pull_request` 的 `GITHUB_SHA`／`GITHUB_REF` 说明属于外部资料，按要求没有核对；`.agents/reviews/topic-ci-queue/` 读不到，`main/evidence` 作业“只跑 15 秒”也没有仓库证据（`main.yml` 第 19 行只有 `timeout-minutes: 15`）。实测数字按仓库内的 `.agents/evidence/ci-queue-2026-11-12.md` 核对，没有重新访问 GitHub 接口。
