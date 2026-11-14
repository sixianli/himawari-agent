CLAIM|1|一致|scripts/operations/ci-runner/runners.sh:1|机器上装了两个 runner|RUNNER_IDS="1 2"
CLAIM|2|找不到|-|每个 runner 一次跑一个作业|-
CLAIM|3|一致|docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md:54|汇总作业 `ci/required` 按 ADR 0241 必须运行并判失败|`ci/required` 仍带 `always()`，但第一步（在检出代码、装工具之前）是一段不依赖任何安装的 bash：草稿 PR 打印 `CI_DRAFT_UNVERIFIED` 并失败
CLAIM|4|一致|.github/workflows/ci.yml:32|草稿 PR 上 6 种检查作业不跑|    if: ${{ github.event_name != 'pull_request' || github.event.pull_request.draft != true }}
CLAIM|5|找不到|-|被取消的运行的检查作业不跑|-
CLAIM|6|一致|ci/policy.json:69|一次完整运行实际是 8 个检查作业加汇总作业|          "runner": "ci-vps",
CLAIM|7|一致|.github/workflows/ci.yml:326|汇总作业 `ci/required` 仍带 `always()`|    if: always()
CLAIM|8|一致|.github/workflows/ci.yml:327|汇总作业 `ci/required` 仍要占一个 `ci-vps` runner|    runs-on: ci-vps
CLAIM|9|一致|docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md:54|`ci/required` 仍带 `always()`，但第一步……草稿 PR 打印 `CI_DRAFT_UNVERIFIED` 并失败|`ci/required` 仍带 `always()`，但第一步（在检出代码、装工具之前）是一段不依赖任何安装的 bash：草稿 PR 打印 `CI_DRAFT_UNVERIFIED` 并失败
CLAIM|10|一致|scripts/operations/ci-runner/runners.sh:1|只有两个 runner|RUNNER_IDS="1 2"
CLAIM|11|一致|scripts/operations/ci-runner/runners.sh:3|两个 runner 标签相同|RUNNER_LABEL=ci-vps
CLAIM|12|找不到|-|每个 runner 一次只跑一个作业|-
CLAIM|13|一致|docs/adr/0176-ci-on-ovh-vps.md:54|先装 2 个，跑一次完整 CI 再决定要不要加到 3|2. 在 VPS 上建一个专用账号跑 runner，先装 2 个，跑一次完整 CI 再决定要不要加到 3 个。
CLAIM|14|一致|.github/workflows/main.yml:10|main 的确认每次合并一个独立的并发组，互不顶替|  group: main-confirmation-${{ github.run_id }}
CLAIM|15|一致|.github/workflows/main.yml:11|main 的确认 `cancel-in-progress: false`|  cancel-in-progress: false
CLAIM|16|一致|scripts/operations/ci-runner/register-runner.sh:29|runner 的标签在注册时用 `--labels` 指定|  --labels "$RUNNER_LABEL" \
CLAIM|17|一致|ci/policy.json:69,77,85|`ci/policy.json` 第 69、77、85 行各有一个 `"runner": "ci-vps"` 的 browser 成员|          "runner": "ci-vps",
CLAIM|18|一致|.github/workflows/ci.yml:73-74|static 要等 policy 跑完才开始|      - policy
CLAIM|19|一致|.github/workflows/ci.yml:116-117|build 要等 policy 跑完才开始|      - policy
CLAIM|20|一致|.github/workflows/ci.yml:237-238|coverage 要等 policy 跑完才开始|      - policy
CLAIM|21|一致|.github/workflows/ci.yml:285-286|security 要等 policy 跑完才开始|      - policy
CLAIM|22|一致|scripts/ci/check-policy.mjs:1191|`upgradeArtifactRetention(upgradeRunnerLabel(upgradeHostedRunnerPolicy(JSON.parse(bytes))))`|      upgradeArtifactRetention(upgradeRunnerLabel(upgradeHostedRunnerPolicy(JSON.parse(bytes)))),
CLAIM|23|一致|ci/policy.schema.json:64|`ci/policy.schema.json` 第 64 行 `"enum": ["ci-vps", "macos-15"]`|                  "enum": ["ci-vps", "macos-15"]
CLAIM|24|一致|scripts/ci/check-policy.mjs:1187|`ci/required` 用目标分支上的 `ci/policy.json` 校验工作流|    ? git(["show", `${baseSha}:${policyPath}`])
CLAIM|25|一致|scripts/ci/check-policy.mjs:1191|旧写法靠升级函数过渡|      upgradeArtifactRetention(upgradeRunnerLabel(upgradeHostedRunnerPolicy(JSON.parse(bytes)))),
CLAIM|26|一致|scripts/operations/ci-runner/gh-runner.service.in:37|runner 的服务模板只藏一个“另一个 runner”的目录|InaccessiblePaths=-/run/docker.sock -/var/run/docker.sock -@OTHER_ROOT@
CLAIM|27|一致|docs/runbooks/ci-vps-runner-runbook.md:17|机器 8 核 22 GB|本手册说明 CI VPS（Andy 在 OVH 租的云服务器，Ubuntu 24.04，8 个 vCPU，22 GB 内存，公网地址 `158.69.191.249`，主机名 `ci-vps`）上那两个 GitHub 自托管 runner（装在自己机器上、替 GitHub 执行 CI 任务的程序）怎么准备机器、安装、注册、日常维护、暂停、排错和卸载。
CLAIM|28|一致|scripts/operations/ci-runner/gh-runners.slice:7|两个 runner 合计内存上限 20 GB|MemoryMax=20G
CLAIM|29|一致|scripts/ci/context.mjs:108|`scripts/ci/context.mjs` 第 97 到 108 行把合并提交的第一个父提交当基准|    baseSha = parents[0];
CLAIM|30|不一致|scripts/operations/ci-runner/runners.sh:1|三个 runner 共用一个内存池|RUNNER_IDS="1 2"
CLAIM|31|一致|scripts/operations/ci-runner/gh-runners.slice:7|池子上限 20 GB|MemoryMax=20G
CLAIM|32|一致|scripts/operations/ci-runner/gh-runner.service.in:26|每个 runner 自己的上限不是预留|MemoryMax=15G
CLAIM|33|一致|scripts/operations/ci-runner/mac-runners.sh:4|暂停和恢复靠 Mac 上的脚本增删一个全局标签|LABEL=$RUNNER_LABEL
CLAIM|34|一致|scripts/operations/ci-runner/register-runner.sh:12|`register-runner.sh` 第 11 到 14 行只接受 `1｜2`|  1|2) runner_select "$1" ;;
CLAIM|35|一致|scripts/operations/ci-runner/uninstall-runner.sh:13|`uninstall-runner.sh` 第 10 到 14 行只接受 `2｜all`|  *) echo "usage: sudo bash uninstall-runner.sh <2|all>   (2 removes only the second runner; all removes both and the shared files)" >&2; exit 64 ;;
CLAIM|36|一致|.github/workflows/ci.yml:366|汇总作业跑的是 PR 合并提交里的脚本，和检查作业在同一个信任范围|        run: .ci-output/tools/bin/node scripts/ci/required.mjs --reports .ci-output/reports --output .ci-output/gate --base "$CI_BASE"
CLAIM|37|一致|.github/workflows/ci.yml:325|作业名 `ci/required` 不变|    name: ci/required
CLAIM|38|一致|scripts/ci/main-evidence.mjs:162|main 的轻量确认照旧按名字找它|  const gates = jobs.jobs.filter((job) => job.name === "ci/required");
CLAIM|39|一致|ci/policy.json:134|现行 7 个作业、required 还在 `ci-vps`|          "runner": "ci-vps",
CLAIM|40|一致|.github/workflows/ci.yml:53|把 npm 下载缓存留在 runner 上……还没实现|        run: node scripts/ci/install-dependencies.mjs --tools .ci-output/tools --evidence .ci-output/installation --cache .ci-output/npm-cache
CLAIM|41|找不到|-|`main.yml` 的取证据作业只跑 15 秒|-
CLAIM|42|找不到|-|记录在 `.agents/reviews/topic-ci-queue/`|-
CLAIM|43|一致|docs/adr/0176-ci-on-ovh-vps.md:72|ADR 0176 里“两个 runner”的说法改为三个|两个 runner 叫 `ci-vps-1`、`ci-vps-2`
CLAIM|44|一致|.github/workflows/main.yml:18|main 的确认仍然和 PR 用同样两个 runner|    runs-on: ci-vps

未能核对的部分：前提 7、11、12 里的排队次数、等待时长、作业耗时和峰值内存来自 GitHub 接口或作业日志，不在仓库中；背景里的 28 次、20 次、近 4 小时、13 分钟同样无法用仓库文件核对。另有两处读不到证据：`.agents/reviews/topic-ci-queue/` 在仓库里不存在（`.agents` 下只有 handoffs、instructions、tasks 等），以及“每个 runner 一次只跑一个作业”“取证据作业只跑 15 秒”没有对应代码或文档可证明。
