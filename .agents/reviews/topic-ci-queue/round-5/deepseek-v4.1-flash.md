CLAIM|1|一致|docs/adr/0176-ci-on-ovh-vps.md:32|CI 在 Andy 租的一台 CI 服务器上跑|Andy 租了一台 OVH（法国的云服务商）的 VPS（按月租用的云服务器）。2026-11-06 核对到的情况：
CLAIM|2|一致|scripts/operations/ci-runner/runners.sh:1|机器上装了两个 runner|RUNNER_IDS="1 2"
CLAIM|3|找不到|-|每个 runner 一次只跑一个作业|-
CLAIM|4|找不到|-|2026-11-12 晚上仓库有 28 次运行在排队|-
CLAIM|5|找不到|-|新 PR 的检查要等几个小时才开始，一次 main 合并后的确认等了近 4 小时|-
CLAIM|6|一致|.github/workflows/ci.yml:32|草稿 PR 的检查作业不跑|    if: ${{ github.event_name != 'pull_request' || github.event.pull_request.draft != true }}
CLAIM|7|找不到|-|被新推送取消的运行，检查作业不跑|-
CLAIM|8|一致|docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md:54|汇总作业 ci/required 按 ADR 0241 必须运行并判失败|草稿 PR 打印 `CI_DRAFT_UNVERIFIED` 并失败
CLAIM|9|找不到|-|它只要几秒钟|-
CLAIM|10|一致|.github/workflows/ci.yml:327|它和检查作业排同一个队|    runs-on: ci-vps
CLAIM|11|找不到|-|检查作业要 13 分钟|-
CLAIM|12|找不到|-|同一个 PR 的新运行要等旧运行的汇总作业结束才开始|-
CLAIM|13|一致|.github/workflows/main.yml:10|main 的确认每合并一次就排一次，互不顶替|  group: main-confirmation-${{ github.run_id }}
CLAIM|14|一致|.github/workflows/main.yml:10|连续合并 6 次就排 6 次确认|  group: main-confirmation-${{ github.run_id }}
CLAIM|15|一致|.github/workflows/main.yml:46|证据取得到时是轻量确认，取不到时是完整检查|    if: always() && (needs.plan.result != 'success' || needs.plan.outputs.mode != 'light')；    if: needs.plan.result == 'success' && needs.plan.outputs.mode == 'light'
CLAIM|16|一致|ci/policy.json:129|检查作业有 6 种|      "needs": ["policy", "static", "build", "browser", "coverage", "security"],
CLAIM|17|一致|.github/workflows/ci.yml:177|一次完整运行实际是 8 个检查作业加汇总作业|          - key: chromium；          - key: firefox；          - key: webkit
CLAIM|18|一致|.github/workflows/ci.yml:177|browser 是 3 个浏览器各一个作业|          - key: chromium；          - key: firefox；          - key: webkit
CLAIM|19|一致|ci/policy.json:69|ci/policy.json 第 69、77、85 行各有一个 runner 为 ci-vps 的 browser 成员|          "runner": "ci-vps",
CLAIM|20|一致|.github/workflows/ci.yml:237|static、build、coverage、security 都要等 policy 跑完才开始|  coverage:；    needs:；      - policy；      - build
CLAIM|21|不一致|.github/workflows/ci.yml:237|来源是 ci.yml 第 73 到 74、116 到 117、285 到 286 行|  coverage:；    needs:；      - policy；      - build
CLAIM|22|一致|scripts/ci/check-policy.mjs:1187|ci/required 用目标分支上的 ci/policy.json 校验工作流|    ? git(["show", `${baseSha}:${policyPath}`])
CLAIM|23|一致|scripts/ci/check-policy.mjs:1191|旧写法靠升级函数过渡|      upgradeArtifactRetention(upgradeRunnerLabel(upgradeHostedRunnerPolicy(JSON.parse(bytes)))),
CLAIM|24|一致|ci/policy.schema.json:64|ci/policy.schema.json 第 64 行是 "enum": ["ci-vps", "macos-15"]|                  "enum": ["ci-vps", "macos-15"]
CLAIM|25|一致|scripts/operations/ci-runner/gh-runner.service.in:37|runner 的服务模板只藏一个“另一个 runner”的目录|InaccessiblePaths=-/run/docker.sock -/var/run/docker.sock -@OTHER_ROOT@
CLAIM|26|找不到|-|2026-11-12 19:52 JST 再量一次：28 次排队里 20 次只剩 ci/required 在等；两个 runner 都在干活，一个作业约 13 分钟；main 上 06:55 UTC 创建的确认到 10:50 UTC 才开始跑第一个作业|-
CLAIM|27|找不到|-|policy 作业峰值内存 2.68 GB|-
CLAIM|28|一致|docs/adr/0176-ci-on-ovh-vps.md:34|机器 8 核 22 GB|Ubuntu 24.04.4，内核 6.8，8 个 vCPU（虚拟 CPU 核），22 GB 内存，200 GB 磁盘
CLAIM|29|一致|scripts/operations/ci-runner/gh-runners.slice:7|两个 runner 合计内存上限 20 GB|MemoryMax=20G
CLAIM|30|一致|scripts/ci/context.mjs:108|PR 的 CI 跑的是 PR 和目标分支合并后的提交|    baseSha = parents[0];
CLAIM|31|找不到|-|工作流文件也取自这个合并提交|-
CLAIM|32|一致|scripts/ci/context.mjs:108|context.mjs 第 97 到 108 行把合并提交的第一个父提交当基准|    baseSha = parents[0];
CLAIM|33|一致|scripts/operations/ci-runner/gh-runner.service.in:9|所有 runner 的服务都放在同一个内存池里|Slice=gh-runners.slice
CLAIM|34|一致|scripts/operations/ci-runner/gh-runner.service.in:9|现在是两个，直接再加一个也会进这个池子|Slice=gh-runners.slice
CLAIM|35|一致|scripts/operations/ci-runner/gh-runners.slice:7|池子上限 20 GB|MemoryMax=20G
CLAIM|36|一致|scripts/operations/ci-runner/gh-runner.service.in:25|每个 runner 自己的上限不是预留|MemoryHigh=14G；MemoryMax=15G
CLAIM|37|一致|scripts/operations/ci-runner/mac-runners.sh:4|暂停和恢复靠 Mac 上的脚本增删一个全局标签|LABEL=$RUNNER_LABEL
CLAIM|38|不一致|scripts/operations/ci-runner/uninstall-runner.sh:10|注册和卸载脚本只认 1、2 号|  2) REMOVE="2" ；；  all) REMOVE="$RUNNER_IDS" ；；  *) echo "usage: sudo bash uninstall-runner.sh <2|all>
CLAIM|39|一致|scripts/operations/ci-runner/register-runner.sh:12|register-runner.sh 第 11 到 14 行只接受 1｜2|  1|2) runner_select "$1" ;;
CLAIM|40|一致|scripts/operations/ci-runner/uninstall-runner.sh:12|uninstall-runner.sh 第 10 到 14 行只接受 2｜all|  all) REMOVE="$RUNNER_IDS" ；；  *) echo "usage: sudo bash uninstall-runner.sh <2|all>
CLAIM|41|一致|.github/workflows/ci.yml:366|汇总作业跑的是 PR 合并提交里的脚本|        run: .ci-output/tools/bin/node scripts/ci/required.mjs --reports .ci-output/reports --output .ci-output/gate --base "$CI_BASE"
CLAIM|42|一致|.github/workflows/ci.yml:327|汇总作业和检查作业在同一个信任范围|    runs-on: ci-vps
CLAIM|43|一致|.github/workflows/ci.yml:350|ci.yml 第 350 到 366 行检出后运行 scripts/ci/required.mjs|      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683；        run: .ci-output/tools/bin/node scripts/ci/required.mjs --reports .ci-output/reports --output .ci-output/gate --base "$CI_BASE"
CLAIM|44|一致|.github/workflows/ci.yml:325|作业名 ci/required 不变|    name: ci/required
CLAIM|45|一致|scripts/ci/main-evidence.mjs:162|main 的轻量确认照旧按名字找它|  const gates = jobs.jobs.filter((job) => job.name === "ci/required");
CLAIM|46|一致|.github/workflows/ci.yml:350|非草稿 PR 的汇总作业要检出代码、装工具|      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683；        run: node scripts/ci/install-tools.mjs --directory .ci-output/tools --node "$CI_NODE" --without-scanners
CLAIM|47|找不到|-|汇总作业可能要一两分钟|-
CLAIM|48|一致|docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md:57|把 npm 下载缓存留在 runner 上，这是 ADR 0241 决定第 5 条|5. **runner 上保留 npm 依赖缓存。**npm 下载缓存从每次检出都清掉的 `.ci-output/npm-cache` 挪到 runner 账号目录，并入 [ADR 0181](0181-persistent-verified-download-cache-on-runners.md) 的上限和清理；只缓存下载的包，不缓存 `node_modules`，better-sqlite3 照旧每次现编译并跑探针。这一条在后续 PR 里实现。
CLAIM|49|一致|docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md:45|Andy 2026-11-11 已同意|2026-11-11，问三项取舍（草稿 PR 完全不跑 CI、合并前要等 CI 变绿、runner 上保留 npm 依赖缓存）的建议，三项都建议做之后，答：“同意”。
CLAIM|50|一致|.github/workflows/ci.yml:53|npm 下载缓存还没实现|        run: node scripts/ci/install-dependencies.mjs --tools .ci-output/tools --evidence .ci-output/installation --cache .ci-output/npm-cache
CLAIM|51|一致|ci/policy.json:129|ci/required 仍等全部作业|      "needs": ["policy", "static", "build", "browser", "coverage", "security"],
CLAIM|52|找不到|-|main.yml 的取证据作业只跑 15 秒|-
CLAIM|53|一致|docs/adr/0176-ci-on-ovh-vps.md:72|ADR 0176 里有“两个 runner”的说法|1. **Linux 的 CI 检查全部改在 VPS 上跑。** 新的 runner 标签是 `ci-vps`，两个 runner 叫 `ci-vps-1`、`ci-vps-2`，VPS 的主机名改为 `ci-vps`。
CLAIM|54|一致|docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md:54|ADR 0241 的判定不变，只是汇总作业换了 runner|草稿 PR 打印 `CI_DRAFT_UNVERIFIED` 并失败

未核实：GitHub API 的排队数量、等待时长、作业耗时、peakBytes、main.yml 取证据作业的 15 秒、每个 runner 一次只跑一个作业、被取消运行中检查作业的行为、PR 工作流文件取自合并提交等运行态或外部信息；仓库里没有可读证据，均按找不到处理。
