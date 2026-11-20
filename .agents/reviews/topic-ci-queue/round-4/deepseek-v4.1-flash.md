CLAIM|1|一致|docs/adr/0176-ci-on-ovh-vps.md:32|CI 在 Andy 租的一台 CI 服务器上跑|Andy 租了一台 OVH（法国的云服务商）的 VPS（按月租用的云服务器）。2026-11-06 核对到的情况：
CLAIM|2|一致|scripts/operations/ci-runner/runners.sh:1|机器上装了两个 runner|RUNNER_IDS="1 2"
CLAIM|3|一致|scripts/operations/ci-runner/runners.sh:15|两个 runner 叫 ci-vps-1、ci-vps-2|RUNNER_NAME=ci-vps-1
CLAIM|4|一致|scripts/operations/ci-runner/runners.sh:3|两个 runner 标签相同|RUNNER_LABEL=ci-vps
CLAIM|5|找不到|-|每个 runner 一次只跑一个作业|-
CLAIM|6|一致|.github/workflows/ci.yml:32|草稿 PR 的检查作业都不跑|if: ${{ github.event_name != 'pull_request' || github.event.pull_request.draft != true }}
CLAIM|7|一致|.github/workflows/ci.yml:25|被新推送取消的运行的检查作业都不跑|cancel-in-progress: ${{ github.event_name == 'pull_request' }}
CLAIM|8|一致|docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md:54|汇总作业 ci/required 按 ADR 0241 必须运行并判失败|`ci/required` 仍带 `always()`，但第一步（在检出代码、装工具之前）是一段不依赖任何安装的 bash：草稿 PR 打印 `CI_DRAFT_UNVERIFIED` 并失败；任何上游作业的结果是 `cancelled` 时打印 `CI_UPSTREAM_CANCELLED` 并失败；两个值缺失或不是 `false` 时同样失败。
CLAIM|9|一致|.github/workflows/ci.yml:326|ci.yml 第 324 到 327 行是 required:、if: always()、runs-on: ci-vps|if: always()
CLAIM|10|找不到|-|同一个 PR 的新运行要等旧运行的汇总作业结束才开始|-
CLAIM|11|一致|.github/workflows/main.yml:4|main 的确认每合并一次就排一次|branches: [main]
CLAIM|12|一致|.github/workflows/main.yml:10|main 的确认互不顶替|group: main-confirmation-${{ github.run_id }}
CLAIM|13|不一致|.github/workflows/main.yml:46|连续合并 6 次就排 6 次完整检查|if: always() && (needs.plan.result != 'success' || needs.plan.outputs.mode != 'light')
CLAIM|14|一致|docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md:54|ci/required 仍带 always()，但第一步草稿 PR 打印 CI_DRAFT_UNVERIFIED 并失败|`ci/required` 仍带 `always()`，但第一步（在检出代码、装工具之前）是一段不依赖任何安装的 bash：草稿 PR 打印 `CI_DRAFT_UNVERIFIED` 并失败；任何上游作业的结果是 `cancelled` 时打印 `CI_UPSTREAM_CANCELLED` 并失败；两个值缺失或不是 `false` 时同样失败。
CLAIM|15|一致|docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md:36|GitHub 把被跳过的作业当成成功，所以汇总作业不能跟着跳过，否则草稿会显示成“通过”|但 GitHub 把被跳过的作业当成成功（[GitHub 文档：Status checks](https://docs.github.com/en/pull-requests/reference/status-checks)，原话 “A job that is skipped will report its status as ‘Success’”），所以汇总作业不能跟着跳过，否则草稿会显示成“通过”。
CLAIM|16|一致|docs/adr/0176-ci-on-ovh-vps.md:54|先装 2 个，跑一次完整 CI 再决定要不要加到 3|先装 2 个，跑一次完整 CI 再决定要不要加到 3 个。
CLAIM|17|一致|.github/workflows/main.yml:10|main 的确认用 group: main-confirmation-${{ github.run_id }}|group: main-confirmation-${{ github.run_id }}
CLAIM|18|一致|.github/workflows/main.yml:11|main 的确认 cancel-in-progress: false|cancel-in-progress: false
CLAIM|19|一致|scripts/operations/ci-runner/register-runner.sh:29|runner 标签在注册时用 --labels 指定|--labels "$RUNNER_LABEL" \
CLAIM|20|一致|ci/policy.json:129|一次完整运行实际是 8 个检查作业加汇总作业|"needs": ["policy", "static", "build", "browser", "coverage", "security"],
CLAIM|21|一致|ci/policy.json:69|browser 是 3 个浏览器各一个作业，第 69、77、85 行各有一个 runner 为 ci-vps 的 browser 成员|"runner": "ci-vps",
CLAIM|22|一致|.github/workflows/ci.yml:74|static、build、coverage、security 都要等 policy 跑完才开始|- policy
CLAIM|23|一致|scripts/ci/check-policy.mjs:1187|ci/required 用目标分支上的 ci/policy.json 校验工作流|? git(["show", `${baseSha}:${policyPath}`])
CLAIM|24|一致|scripts/ci/check-policy.mjs:1191|旧写法靠升级函数过渡|upgradeArtifactRetention(upgradeRunnerLabel(upgradeHostedRunnerPolicy(JSON.parse(bytes)))),
CLAIM|25|一致|ci/policy.schema.json:64|ci/policy.schema.json 第 64 行枚举为 ci-vps、macos-15|"enum": ["ci-vps", "macos-15"]
CLAIM|26|一致|scripts/operations/ci-runner/gh-runner.service.in:37|runner 服务模板只藏一个“另一个 runner”的目录|InaccessiblePaths=-/run/docker.sock -/var/run/docker.sock -@OTHER_ROOT@
CLAIM|27|找不到|-|policy 作业峰值内存 2.68 GB|-
CLAIM|28|一致|docs/adr/0176-ci-on-ovh-vps.md:34|机器 8 核 22 GB|- Ubuntu 24.04.4，内核 6.8，8 个 vCPU（虚拟 CPU 核），22 GB 内存，200 GB 磁盘；公网地址 `158.69.191.249`，另有一个 IPv6 公网地址；账号 `ubuntu` 有免密 sudo。已关掉 SSH 密码登录，防火墙 ufw 只放行 22 端口。
CLAIM|29|一致|scripts/operations/ci-runner/gh-runners.slice:7|两个 runner 合计内存上限 20 GB|MemoryMax=20G
CLAIM|30|一致|scripts/ci/context.mjs:108|context.mjs 第 97 到 108 行把合并提交的第一个父提交当基准|baseSha = parents[0];
CLAIM|31|一致|scripts/operations/ci-runner/gh-runner.service.in:9|所有 runner 的服务都放在同一个内存池里|Slice=gh-runners.slice
CLAIM|32|一致|scripts/operations/ci-runner/gh-runner.service.in:9|直接再加一个 runner 也会进这个池子|Slice=gh-runners.slice
CLAIM|33|一致|scripts/operations/ci-runner/gh-runner.service.in:25|每个 runner 自己的上限不是预留|MemoryHigh=14G
CLAIM|34|一致|scripts/operations/ci-runner/gh-runners.slice:6|gh-runners.slice 第 6、7 行是 MemoryHigh=19G、MemoryMax=20G|MemoryHigh=19G
CLAIM|35|一致|scripts/operations/ci-runner/gh-runner.service.in:26|gh-runner.service.in 第 25、26 行是 MemoryHigh=14G、MemoryMax=15G|MemoryMax=15G
CLAIM|36|一致|scripts/operations/ci-runner/mac-runners.sh:4|暂停和恢复靠 Mac 上的脚本增删一个全局标签|LABEL=$RUNNER_LABEL
CLAIM|37|一致|scripts/operations/ci-runner/register-runner.sh:12|注册脚本只认 1、2 号|1|2) runner_select "$1" ;;
CLAIM|38|不一致|scripts/operations/ci-runner/uninstall-runner.sh:13|卸载脚本只认 1、2 号|*) echo "usage: sudo bash uninstall-runner.sh <2|all>   (2 removes only the second runner; all removes both and the shared files)" >&2; exit 64 ;;
CLAIM|39|一致|.github/workflows/ci.yml:366|汇总作业检出后运行 scripts/ci/required.mjs|run: .ci-output/tools/bin/node scripts/ci/required.mjs --reports .ci-output/reports --output .ci-output/gate --base "$CI_BASE"
CLAIM|40|一致|.github/workflows/ci.yml:325|作业名 ci/required 不变|name: ci/required
CLAIM|41|一致|scripts/ci/main-evidence.mjs:162|main 的轻量确认照旧按名字找它|const gates = jobs.jobs.filter((job) => job.name === "ci/required");
CLAIM|42|一致|docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md:57|把 npm 下载缓存留在 runner 上是 ADR 0241 决定第 5 条|5. **runner 上保留 npm 依赖缓存。**npm 下载缓存从每次检出都清掉的 `.ci-output/npm-cache` 挪到 runner 账号目录，并入 [ADR 0181](0181-persistent-verified-download-cache-on-runners.md) 的上限和清理；只缓存下载的包，不缓存 `node_modules`，better-sqlite3 照旧每次现编译并跑探针。这一条在后续 PR 里实现。
CLAIM|43|一致|docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md:45|Andy 2026-11-11 已同意保留 npm 缓存|- 2026-11-11，问三项取舍（草稿 PR 完全不跑 CI、合并前要等 CI 变绿、runner 上保留 npm 依赖缓存）的建议，三项都建议做之后，答：“同意”。
CLAIM|44|一致|.github/workflows/ci.yml:53|npm 下载缓存还没实现留在 runner 上|run: node scripts/ci/install-dependencies.mjs --tools .ci-output/tools --evidence .ci-output/installation --cache .ci-output/npm-cache
CLAIM|45|找不到|-|main.yml 的取证据作业只跑 15 秒|-
CLAIM|46|找不到|-|模型的意见记录在 .agents/reviews/topic-ci-queue/|-
CLAIM|47|一致|docs/adr/0176-ci-on-ovh-vps.md:72|ADR 0176 里有两个 runner 的说法|新的 runner 标签是 `ci-vps`，两个 runner 叫 `ci-vps-1`、`ci-vps-2`，VPS 的主机名改为 `ci-vps`。
CLAIM|48|一致|.github/workflows/ci.yml:350|汇总作业仍然执行 PR 里的脚本|- uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683

未核实部分：GitHub 接口里的排队数、各运行耗时和等待时间，作业日志里的峰值内存 2.68 GB，main/evidence 作业实际运行 15 秒，以及 GitHub 文档里的并发与标签行为，都是仓库外的运行数据或外部文档；仓库中也没有 `.agents/reviews/topic-ci-queue/` 目录可查。
