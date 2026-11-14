CLAIM|1|一致|scripts/operations/ci-runner/runners.sh:1|机器上装了两个 runner（替 GitHub 执行 CI 作业的程序）|RUNNER_IDS="1 2"
CLAIM|2|找不到|-|每个 runner 一次只跑一个作业|（未找到能证明并发数的仓库内容）
CLAIM|3|一致|.agents/evidence/ci-queue-2026-11-12.md:7|2026-11-12 晚上仓库有 28 次运行在排队|- 2026-11-12 19:30 JST：仓库有 28 次 CI 运行在排队，新 PR 的检查要等几个小时才开始。
CLAIM|4|一致|.agents/evidence/ci-queue-2026-11-12.md:7|新 PR 的检查要等几个小时才开始|- 2026-11-12 19:30 JST：仓库有 28 次 CI 运行在排队，新 PR 的检查要等几个小时才开始。
CLAIM|5|找不到|-|一次 main 合并后的确认等了近 4 小时|（未找到记录）
CLAIM|6|一致|.github/workflows/ci.yml:32|草稿 PR 和被新推送取消的运行，检查作业都不跑|if: ${{ github.event_name != 'pull_request' || github.event.pull_request.draft != true }}
CLAIM|7|找不到|-|被新推送取消的运行，检查作业都不跑|（未找到能直接证明该运行行为的仓库内容）
CLAIM|8|一致|docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md:55|汇总作业 `ci/required`……按 ADR 0241 必须运行并判失败|`ci/required` 仍带 `always()`，但第一步（在检出代码、装工具之前）是一段不依赖任何安装的 bash：草稿 PR 打印 `CI_DRAFT_UNVERIFIED` 并失败；
CLAIM|9|找不到|-|它只要几秒钟|（未找到记录）
CLAIM|10|一致|.github/workflows/ci.yml:327|却和 13 分钟的检查作业排同一个队|runs-on: ci-vps
CLAIM|11|一致|.agents/evidence/ci-queue-2026-11-12.md:9|同一个 PR 的新运行要等旧运行的汇总作业结束才开始|- 同一个 PR 的新运行处于 `pending`，要等旧运行的 `ci/required` 跑完才开始，例如 PR 439：43188147300 排队，43193780006 等待。
CLAIM|12|一致|.agents/evidence/ci-queue-2026-11-12.md:8|当晚 28 次排队里有 20 次只剩这个几秒钟的作业在等|- 这 28 次里有 20 次是检查作业已跳过或已取消、只剩 `ci/required` 在等 runner 的运行，例如运行 43188147300、43191538886、43186918106。
CLAIM|13|一致|.github/workflows/main.yml:10|main 的确认每合并一次就排一次，互不顶替|group: main-confirmation-${{ github.run_id }}
CLAIM|14|一致|.github/workflows/main.yml:11|连续合并 6 次就排 6 次确认|cancel-in-progress: false
CLAIM|15|一致|.github/workflows/main.yml:51|证据取得到时是轻量确认，取不到时是完整检查|if: needs.plan.result == 'success' && needs.plan.outputs.mode == 'light'
CLAIM|16|一致|.github/workflows/ci.yml:32|草稿和被取消的运行，检查作业（6 种，实际 8 个，见前提 8）不跑|if: ${{ github.event_name != 'pull_request' || github.event.pull_request.draft != true }}
CLAIM|17|一致|.github/workflows/ci.yml:326|汇总作业 `ci/required` 仍要占一个 runner|if: always()
CLAIM|18|一致|.github/workflows/ci.yml:324|`.github/workflows/ci.yml` 第 324 到 327 行，原话 `required:` / `if: always()` / `runs-on: ci-vps`|required:
CLAIM|19|一致|docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md:55|`docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md` 决定第 2 条，原话“`ci/required` 仍带 `always()`，但第一步……草稿 PR 打印 `CI_DRAFT_UNVERIFIED` 并失败”|`ci/required` 仍带 `always()`，但第一步（在检出代码、装工具之前）是一段不依赖任何安装的 bash：草稿 PR 打印 `CI_DRAFT_UNVERIFIED` 并失败；
CLAIM|20|一致|docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md:37|汇总作业不能跟着跳过|所以汇总作业不能跟着跳过，否则草稿会显示成“通过”。
CLAIM|21|一致|scripts/operations/ci-runner/runners.sh:1|只有两个 runner|RUNNER_IDS="1 2"
CLAIM|22|一致|scripts/operations/ci-runner/runners.sh:3|标签相同|RUNNER_LABEL=ci-vps
CLAIM|23|一致|docs/adr/0176-ci-on-ovh-vps.md:54|`docs/adr/0176-ci-on-ovh-vps.md` 第 54 行，原话“先装 2 个，跑一次完整 CI 再决定要不要加到 3”|先装 2 个，跑一次完整 CI 再决定要不要加到 3 个。
CLAIM|24|一致|.github/workflows/main.yml:10|main 的确认每次合并一个独立的并发组，互不顶替|group: main-confirmation-${{ github.run_id }}
CLAIM|25|一致|scripts/operations/ci-runner/register-runner.sh:29|runner 的标签在注册时用 `--labels` 指定|--labels "$RUNNER_LABEL" \
CLAIM|26|一致|.agents/evidence/ci-queue-2026-11-12.md:8|28 次排队的运行里多数只剩 `ci/required` 在等 runner|- 这 28 次里有 20 次是检查作业已跳过或已取消、只剩 `ci/required` 在等 runner 的运行，例如运行 43188147300、43191538886、43186918106。
CLAIM|27|一致|.agents/evidence/ci-queue-2026-11-12.md:10|前面排着 6 到 14 分钟的检查作业|- 作业时长（作业记录里的开始和结束时间）：policy 13 到 14 分钟，static 13 到 14 分钟，build 约 6 分钟，security 约 6 分钟。
CLAIM|28|一致|.agents/evidence/ci-queue-2026-11-12.md:9|同一个 PR 的新运行要等旧运行的 `ci/required` 结束才开始|- 同一个 PR 的新运行处于 `pending`，要等旧运行的 `ci/required` 跑完才开始，例如 PR 439：43188147300 排队，43193780006 等待。
CLAIM|29|一致|scripts/ci/check-policy.mjs:46|一次完整运行实际是 8 个检查作业加汇总作业|const jobIds = ["policy", "static", "build", "browser", "coverage", "security", "required"];
CLAIM|30|一致|.github/workflows/ci.yml:176|`browser` 是 3 个浏览器各一个作业|include:
CLAIM|31|一致|ci/policy.json:69|`ci/policy.json` 第 69、77、85 行各有一个 `"runner": "ci-vps"` 的 browser 成员|"runner": "ci-vps",
CLAIM|32|一致|.github/workflows/ci.yml:74|static、build、coverage、security 都要等 policy 跑完才开始|- policy
CLAIM|33|一致|scripts/ci/check-policy.mjs:1187|`ci/required` 用目标分支上的 `ci/policy.json` 校验工作流|? git(["show", `${baseSha}:${policyPath}`])
CLAIM|34|一致|scripts/ci/check-policy.mjs:1191|`scripts/ci/check-policy.mjs` 第 1191 行，原话 `upgradeArtifactRetention(upgradeRunnerLabel(upgradeHostedRunnerPolicy(JSON.parse(bytes))))`|upgradeArtifactRetention(upgradeRunnerLabel(upgradeHostedRunnerPolicy(JSON.parse(bytes)))),
CLAIM|35|一致|ci/policy.schema.json:64|`ci/policy.schema.json` 第 64 行 `"enum": ["ci-vps", "macos-15"]`|"enum": ["ci-vps", "macos-15"]
CLAIM|36|一致|scripts/operations/ci-runner/gh-runner.service.in:37|runner 的服务模板只藏一个“另一个 runner”的目录|InaccessiblePaths=-/run/docker.sock -/var/run/docker.sock -@OTHER_ROOT@
CLAIM|37|找不到|-|2026-11-12 19:52 JST 再量一次：28 次排队里 20 次只剩 `ci/required` 在等|（仓库证据只记录了 19:30 和 22:45，没有 19:52）
CLAIM|38|找不到|-|两个 runner 都在干活|（未找到记录）
CLAIM|39|一致|.agents/evidence/ci-queue-2026-11-12.md:10|一个作业约 13 分钟|- 作业时长（作业记录里的开始和结束时间）：policy 13 到 14 分钟，static 13 到 14 分钟，build 约 6 分钟，security 约 6 分钟。
CLAIM|40|找不到|-|main 上 06:55 UTC 创建的确认到 10:50 UTC 才开始跑第一个作业|（未找到记录）
CLAIM|41|一致|.agents/evidence/ci-queue-2026-11-12.md:11|policy 作业峰值内存 2.68 GB|- policy 作业日志里的资源记录：`peakBytes: 2682445824`（约 2.68 GB），机器 8 核。
CLAIM|42|一致|docs/adr/0176-ci-on-ovh-vps.md:34|机器 8 核 22 GB|8 个 vCPU（虚拟 CPU 核），22 GB 内存
CLAIM|43|一致|scripts/operations/ci-runner/gh-runners.slice:7|两个 runner 合计内存上限 20 GB|MemoryMax=20G
CLAIM|44|一致|scripts/ci/context.mjs:108|`scripts/ci/context.mjs` 第 97 到 108 行把合并提交的第一个父提交当基准|baseSha = parents[0];
CLAIM|45|一致|scripts/operations/ci-runner/gh-runner.service.in:9|所有 runner 的服务都放在同一个内存池里（现在是两个，直接再加一个也会进这个池子）|Slice=gh-runners.slice
CLAIM|46|一致|scripts/operations/ci-runner/gh-runners.slice:7|池子上限 20 GB|MemoryMax=20G
CLAIM|47|一致|scripts/operations/ci-runner/gh-runner.service.in:26|每个 runner 自己的上限不是预留|MemoryMax=15G
CLAIM|48|一致|scripts/operations/ci-runner/mac-runners.sh:4|暂停和恢复靠 Mac 上的脚本增删一个全局标签|LABEL=$RUNNER_LABEL
CLAIM|49|一致|scripts/operations/ci-runner/register-runner.sh:12|`register-runner.sh` 第 11 到 14 行只接受 `1|2`|1|2) runner_select "$1" ;;
CLAIM|50|一致|scripts/operations/ci-runner/uninstall-runner.sh:12|`uninstall-runner.sh` 第 10 到 14 行只接受 `2|all`|all) REMOVE="$RUNNER_IDS" ;;
CLAIM|51|一致|.github/workflows/ci.yml:366|`.github/workflows/ci.yml` 第 350 到 366 行（检出后运行 `scripts/ci/required.mjs`）|run: .ci-output/tools/bin/node scripts/ci/required.mjs --reports .ci-output/reports --output .ci-output/gate --base "$CI_BASE"
CLAIM|52|一致|.github/workflows/ci.yml:325|作业名 `ci/required` 不变|name: ci/required
CLAIM|53|一致|scripts/ci/main-evidence.mjs:162|main 的轻量确认照旧按名字找它|const gates = jobs.jobs.filter((job) => job.name === "ci/required");
CLAIM|54|一致|docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md:58|把 npm 下载缓存留在 runner 上。这是 ADR 0241 决定第 5 条|5. **runner 上保留 npm 依赖缓存。**
CLAIM|55|一致|docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md:46|Andy 2026-11-11 已同意|问三项取舍（草稿 PR 完全不跑 CI、合并前要等 CI 变绿、runner 上保留 npm 依赖缓存）的建议，三项都建议做之后，答：“同意”。
CLAIM|56|一致|.github/workflows/ci.yml:53|还没实现|run: node scripts/ci/install-dependencies.mjs --tools .ci-output/tools --evidence .ci-output/installation --cache .ci-output/npm-cache
CLAIM|57|一致|scripts/operations/ci-runner/install-runner.sh:85|安装（会重新生成 1、2 号的服务文件，所以要先暂停）|render_runner_unit "$id" "$SRC/gh-runner.service.in" > "$UNIT_DIR/$RUNNER_UNIT"
CLAIM|58|一致|ci/policy.json:134|只把“现行 7 个作业、required 还在 `ci-vps`”这一种旧写法升级|"runner": "ci-vps",
CLAIM|59|一致|docs/adr/0176-ci-on-ovh-vps.md:75|ADR 0176 里“两个 runner”的说法|两个 runner 合计 `MemoryHigh=19G`、`MemoryMax=20G`
CLAIM|60|找不到|-|记录在 `.agents/reviews/topic-ci-queue/`|（仓库的 .agents 下没有 reviews 目录）
CLAIM|61|一致|scripts/ci/main-workflow.mjs:47|`main-workflow.mjs` 的硬规则和反向用例同步（改回带运行号的组、改成 `true`，都必须失败）|w.concurrency?.["cancel-in-progress"] === false &&

未能核对的部分：GitHub 文档所述“跳过的作业记为成功”、并发组行为和 pull_request 使用合并提交等第三方行为，以及仓库证据文件没有记录的 19:52 复测、两个 runner 同时忙碌、main 确认 06:55 UTC 到 10:50 UTC 和“近 4 小时”等实时数据；还有“每个 runner 一次只跑一个作业”的 GitHub runner 默认行为。
