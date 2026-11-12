---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0172-resume-runners-labels-first.md, docs/adr/0176-ci-on-ovh-vps.md, docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md"
date: "2026-11-12"
---

# ADR 0256：汇总作业用专用 runner，main 的确认只留最新一次

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提和来源](#premises)
- [Andy 的原话](#owner-decisions)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [验证](#verification)
- [关联文档](#references)

<a id="context"></a>

## 背景

CI（持续集成，每次推送后 GitHub Actions 自动跑的检查）在 Andy 租的一台 CI 服务器上跑，机器上装了两个 runner（替 GitHub 执行 CI 作业的程序），每个 runner 一次只跑一个作业。2026-11-12 晚上仓库有 28 次运行在排队，新 PR 的检查要等几个小时才开始，一次 main 合并后的确认等了近 4 小时。

排队的主因不是机器不够快。草稿 PR 和被新推送取消的运行，检查作业都不跑，但汇总作业 `ci/required`（把各项检查的结果汇成一个结论的作业）按 [ADR 0241](0241-draft-prs-skip-ci-and-merge-waits-for-green.md) 必须运行并判失败，它只要几秒钟，却和 13 分钟的检查作业排同一个队。同一个 PR 的新运行要等旧运行的汇总作业结束才开始。当晚 28 次排队里有 20 次只剩这个几秒钟的作业在等。

第二个原因是 main 的确认：每合并一次就排一次，互不顶替，连续合并 6 次就排 6 次确认（证据取得到时是轻量确认，取不到时是完整检查）。

Andy 的要求：CI 要顺；修根因，不降低检查质量；不在 GitHub 上花钱；不在服务器上多花钱。

[↑ 返回阅读导航](#contents)

<a id="premises"></a>

## 前提和来源

1. 草稿和被取消的运行，检查作业（6 种，实际 8 个，见前提 8）不跑，但汇总作业 `ci/required` 仍要占一个 runner（CI 服务器上替 GitHub 跑任务的程序）。来源：`.github/workflows/ci.yml` 第 324 到 327 行，原话 `required:` / `if: always()` / `runs-on: ci-vps`；`docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md` 决定第 2 条，原话“`ci/required` 仍带 `always()`，但第一步……草稿 PR 打印 `CI_DRAFT_UNVERIFIED` 并失败”。
2. 汇总作业不能跟着跳过。来源：同一份 ADR 背景一节，原话“GitHub 把被跳过的作业当成成功……所以汇总作业不能跟着跳过，否则草稿会显示成‘通过’”；GitHub 文档 https://docs.github.com/en/pull-requests/reference/status-checks ，原话 “A job that is skipped will report its status as ‘Success’”。
3. 只有两个 runner，标签相同，每个一次跑一个作业。来源：`scripts/operations/ci-runner/runners.sh` 第 15、22 行（`RUNNER_NAME=ci-vps-1`、`RUNNER_NAME=ci-vps-2`）；`docs/adr/0176-ci-on-ovh-vps.md` 第 54 行，原话“先装 2 个，跑一次完整 CI 再决定要不要加到 3”。
4. 同一个并发组里最多一个在跑、一个在等；新来的会顶掉还在等的那个。来源：https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency ，原话 “there can be at most one running job or workflow in a concurrency group at any time”“any existing `pending` job or workflow in the same concurrency group will be canceled”。
5. main 的确认每次合并一个独立的并发组，互不顶替。来源：`.github/workflows/main.yml` 第 9 到 11 行，原话 `group: main-confirmation-${{ github.run_id }}`、`cancel-in-progress: false`。
6. runner 的标签在注册时用 `--labels` 指定。来源：`scripts/operations/ci-runner/register-runner.sh` 第 29 行 `--labels "$RUNNER_LABEL"`；GitHub 文档 https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/apply-labels ，原话 “You can pass label names to the `config` script using the `labels` parameter”。
7. 实测（2026-11-12 19:30 JST，GitHub 接口）：28 次排队的运行里多数只剩 `ci/required` 在等 runner，前面排着 6 到 14 分钟的检查作业；同一个 PR 的新运行要等旧运行的 `ci/required` 结束才开始。
8. 一次完整运行实际是 8 个检查作业加汇总作业：`browser` 是 3 个浏览器各一个作业。来源：`ci/policy.json` 第 69、77、85 行各有一个 `"runner": "ci-vps"` 的 browser 成员。static、build、coverage、security 都要等 policy 跑完才开始。来源：`.github/workflows/ci.yml` 第 73 到 74、116 到 117、285 到 286 行，原话 `needs:` / `- policy`。
9. `ci/required` 用目标分支上的 `ci/policy.json` 校验工作流，旧写法靠升级函数过渡。来源：`scripts/ci/check-policy.mjs` 第 1191 行，原话 `upgradeArtifactRetention(upgradeRunnerLabel(upgradeHostedRunnerPolicy(JSON.parse(bytes))))`；`ci/policy.schema.json` 第 64 行 `"enum": ["ci-vps", "macos-15"]`。
10. runner 的服务模板只藏一个“另一个 runner”的目录。来源：`scripts/operations/ci-runner/gh-runner.service.in` 第 37 行，原话 `InaccessiblePaths=-/run/docker.sock -/var/run/docker.sock -@OTHER_ROOT@`。
11. 2026-11-12 19:52 JST 再量一次：28 次排队里 20 次只剩 `ci/required` 在等；两个 runner 都在干活，一个作业约 13 分钟；main 上 06:55 UTC 创建的确认到 10:50 UTC 才开始跑第一个作业。来源：GitHub 接口 `actions/runs?status=queued` 和各运行的 `jobs`。
12. policy 作业峰值内存 2.68 GB，机器 8 核 22 GB，两个 runner 合计内存上限 20 GB。来源：作业日志 `peakBytes: 2682445824`；`scripts/operations/ci-runner/gh-runners.slice` 第 6、7 行。其他作业的峰值内存和 CPU 占用：未核实，加 runner 之前要先量。

13. PR 的 CI 跑的是“PR 和目标分支合并后的提交”，工作流文件也取自这个合并提交，所以工作流改动合进 main 后，其他 PR 下一次运行自动用新工作流。来源：https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request ，原话 “GITHUB_SHA: Last merge commit on the GITHUB_REF branch”“GITHUB_REF: PR merge branch refs/pull/PULL_REQUEST_NUMBER/merge”；`scripts/ci/context.mjs` 第 97 到 108 行把合并提交的第一个父提交当基准。
14. 所有 runner 的服务都放在同一个内存池里（现在是两个，直接再加一个也会进这个池子），池子上限 20 GB，每个 runner 自己的上限不是预留。来源：`scripts/operations/ci-runner/gh-runners.slice` 第 6、7 行 `MemoryHigh=19G`、`MemoryMax=20G`；`gh-runner.service.in` 第 25、26 行 `MemoryHigh=14G`、`MemoryMax=15G`。
15. 暂停和恢复靠 Mac 上的脚本增删一个全局标签；注册和卸载脚本只认 1、2 号。来源：`scripts/operations/ci-runner/mac-runners.sh` 第 4 行 `LABEL=$RUNNER_LABEL`；`register-runner.sh` 第 11 到 14 行只接受 `1` 和 `2`；`uninstall-runner.sh` 第 10 到 14 行只接受 `2` 和 `all`。
16. 汇总作业跑的是 PR 合并提交里的脚本，和检查作业在同一个信任范围。来源：`.github/workflows/ci.yml` 第 350 到 366 行（检出后运行 `scripts/ci/required.mjs`）。

[↑ 返回阅读导航](#contents)

<a id="owner-decisions"></a>

## Andy 的原话

2026-11-12 22:13（日本时间），Andy 在决定卡片“同意按 ADR 0256 修 CI 排队吗（加专用 runner，main 确认只留最新）？”上选了“两项都同意”。第 1 步和第 2 步照做；第 3 步仍然先量再定。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

### 第 1 步：给汇总作业一个专用的小 runner（主因的修法）

分两个 PR，中间由 Andy 在 Mac 上装一次。

PR A（安装脚本和运行手册，不动工作流）：

- `runners.sh`：`RUNNER_IDS` 加 3 号，名字 `ci-vps-gate`，标签只有 `ci-vps-gate`，不带 `ci-vps`，所以检查作业永远不会落到它上面；标签从全局一个值改成每个 runner 自己的值。
- `gh-runner.service.in`：`InaccessiblePaths` 藏另外两个 runner 的目录（前提 10）；所属的内存池、内存和进程数限额从写死改成按 runner 填。`install-runner.sh` 安装和备份新的 `ghgate.slice`，`uninstall-runner.sh all` 一并删掉它；`prepare-vps.sh` 的重启保护检查和 `gh-runner-nft.service` 的启动顺序也把 3 号算进去。
- 3 号放进自己单独的内存池：预留 2 GB（`MemoryMin`），上限 2 GB，进程数上限单独算；两个检查 runner 的池子从 20 GB 降到 18 GB（前提 14）。这样检查作业把内存吃满时，系统不会先杀汇总作业。2 GB 够不够先在 VPS 上量一次汇总作业的峰值再定。3 号的内存池是一个单独的 systemd 分组（slice，systemd 用来给一组服务统一设限额的单位）`ghgate.slice`；名字里不带短横线，因为 systemd 把短横线当成上下级（`gh-runners.slice` 实际挂在 `gh.slice` 下面），而预留内存要每一级上级都设了才生效。
- `register-runner.sh`、`uninstall-runner.sh` 认 3 号；`mac-runners.sh`、`pause-runners.sh`、`resume-runners.sh`、`runner-pause.sh` 按 runner 名字对应各自的标签（前提 15）。
- 新增一个应急脚本：3 号坏了时，在 Mac 上跑一条命令，把 `ci-vps-gate` 标签临时加到 1 号上，汇总作业就改由 1 号接，不用改代码、不用回滚 PR；3 号修好后再跑一次去掉。
- `test/tooling/ci-runner-scripts.test.mjs`：断言 `runners.sh` 里 3 号的标签是 `ci-vps-gate`、1 和 2 号是 `ci-vps`、3 号不带 `ci-vps`，3 号的服务文件在 `ghgate.slice` 里、限额是 2 GB。和 `contracts.mjs`、`ci/policy.json`、`ci.yml`、`.github/actionlint.yaml`、`ci/policy.schema.json` 的跨文件对照用例放在 PR B，因为这些文件到 PR B 才有 `ci-vps-gate`。反向用例：3 号标签写成 `ci-vps`、恢复时给 3 号加回 `ci-vps`、1 号看得到 3 号目录、暂停后 `ci-vps-gate` 标签还在、卸载漏掉 3 号，都必须失败。
- 运行手册 `docs/runbooks/ci-vps-runner-runbook.md` 逐处改成三个 runner，补 3 号的预检、验证、应急和卸载，并重新封存。

Andy 在 Mac 上：按运行手册暂停、上传脚本、安装（会重新生成 1、2 号的服务文件，所以要先暂停）、注册 3 号、恢复，确认三个 runner 在线、3 号的标签只有 `ci-vps-gate`。

PR B（工作流和硬规则，要等 3 号 runner 在线才能合并）：

- `ci.yml` 的 `required` 改成 `runs-on: ci-vps-gate`。作业名 `ci/required` 不变，main 的轻量确认照旧按名字找它。`main.yml` 这次不动。
- `ci/policy.json` 的 required 成员、`ci/policy.schema.json` 的枚举（加一个值，不替换）、`.github/actionlint.yaml`、`scripts/ci/contracts.mjs`（新增 `gateRunnerLabel`）同步。
- `check-policy.mjs`：汇总作业只能在 `ci-vps-gate` 上跑，检查作业只能在 `ci-vps` 上跑。加一个升级函数 `upgradeGateRunnerPolicy`，放在升级链的最外层最后执行，只把“现行 7 个作业、required 还在 `ci-vps`”这一种旧写法升级；原有几个升级函数和它们用的旧值不动（前提 9）。
- 测试：PR A 推迟过来的跨文件对照用例（上面几个文件里汇总作业的 runner 标签和 `runners.sh` 里 3 号的标签必须是同一个值）；四种历史写法的目标分支策略各一条升级用例；混写、required 改回 `ci-vps`、某个检查作业改到 `ci-vps-gate`，都必须失败并断言具体的错误信息。
- 其他开着的 PR 不用特别处理：它们下一次运行跑的是和 main 合并后的提交，自动用新工作流和新策略（前提 13）。和 main 有冲突的 PR 本来就要先合 main。

效果：草稿和被取消的运行几秒钟就结束，不再排在 13 分钟的检查后面，同一个 PR 的新运行马上开始。ADR 0241 的判定一条不改：草稿和被取消照样判失败。

没有改变的：汇总作业仍然执行 PR 里的脚本，3 号 runner 不比另外两个更可信（前提 16）。

风险：3 号停了，所有 PR 的 `ci/required` 都等着（不会被当成通过）。处理办法是上面的应急脚本。非草稿 PR 的汇总作业要检出代码、装工具，可能要一两分钟；几个 PR 同时跑完检查时，汇总作业会在 3 号上排一小会儿，上线后量。

### 第 2 步：main 的确认只保留最新一次

- `main.yml` 并发组改成固定的 `main-confirmation`，`cancel-in-progress` 保持 `false`：正在跑的那次跑完，还在等的只留最新一次（前提 4）。不用 `true`，因为那会把跑到一半的确认也掐掉。
- 效果：连续合并 6 次不再排 6 次确认。main 的确认仍然和 PR 用同一批 runner（检查作业用两个检查 runner，完整确认里的汇总作业和 PR 一样用 3 号），只是次数少了。
- 取舍：连续合并时，中间那几个提交没有单独的确认结果，显示为取消；最新一次失败时，要自己查是哪个提交弄坏的。
- `main-workflow.mjs` 的硬规则和反向用例同步（改回带运行号的组、改成 `true`，都必须失败）。

### 第 3 步：让一次完整运行本身变短（不减检查，先量再做）

- 把 npm 下载缓存留在 runner 上。这是 ADR 0241 决定第 5 条，Andy 2026-11-11 已同意，还没实现。先量：同一个 runner 连续跑两次，看 policy 和 static 的 13 分钟里安装依赖占多少。
- 量过之后再决定加不加第三个检查 runner（那会是第 4 个 runner）：两个检查作业同时跑时 CPU 没吃满、三个的内存峰值加起来不超过池子上限，才加。
- static、build、security 不再等 policy，和它同时开始（`ci/required` 仍等全部作业）。代价：策略不合法的 PR 会白跑一些检查。排在最后，前两步做完队列仍长再做。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

不做的：

- 不让汇总作业在草稿上跳过（前提 2）。
- 不给 `required` 加作业级的并发组：有了专用 runner，旧运行的汇总作业几秒钟就结束。
- 不把 `main.yml` 的取证据作业挪到 3 号：它只跑 15 秒，不是排队的来源，挪过去只多一个依赖 3 号的地方。
- 不用 GitHub 托管的 runner，不加服务器。
- 不删减或合并检查，不按改动的文件跳过检查。

模型的意见怎么处理的（记录在 `.agents/reviews/topic-ci-queue/`）：

独立方案（第 1 轮）和我的主方向一致。采纳：策略要加升级函数、服务模板要藏两个目录、暂停恢复按 runner 的标签、实际是 8 个检查作业。没采纳：给 `required` 加作业级并发组（理由见上）、main 用 `cancel-in-progress: true`（会掐掉跑到一半的确认）。

审核（第 2 轮）11 条。采纳：回滚路径要能在 3 号停机时走通（改成应急脚本）、升级函数放最外层并保留旧值、脚本改动逐文件写清、跨文件对照用例、3 号单独内存池并先量峰值、`main.yml` 的取证据作业不挪、写明信任范围没变、新 ADR 和运行手册重新封存、第 2 步的效果不夸大。没采纳 1 条：“PR B 合并后其他开着的 PR 全部过不了 policy”，因为 PR 的运行用的是合并后的工作流和策略（前提 13），不是 PR 分支里的旧文件。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 不花钱：3 号 runner 装在现有的 CI 服务器上，不占 GitHub 额度。
- Andy 要在 Mac 上按运行手册装一次 3 号 runner，约 10 分钟。
- 多一个要照看的 runner；它停了有应急脚本。
- 连续合并时，中间的 main 提交不再逐个确认。
- [ADR 0176](0176-ci-on-ovh-vps.md) 里“两个 runner”的说法改为三个；[ADR 0241](0241-draft-prs-skip-ci-and-merge-waits-for-green.md) 的判定不变，只是汇总作业换了 runner。[ADR 0172](0172-resume-runners-labels-first.md) 的“先加标签再启动”不变，但恢复时加回的是每个 runner 自己的标签：检查 runner 加 `ci-vps`，汇总 runner 加 `ci-vps-gate`。

[↑ 返回阅读导航](#contents)

<a id="verification"></a>

## 验证

- 第 1 步：开一个草稿 PR 推一次，`ci/required` 在 1 分钟内出失败结果，作业日志开头的 runner 名是 `ci-vps-gate`；同一个 PR 连推两次，第二次的检查作业不用等第一次的汇总作业；跑一次应急脚本，确认汇总作业能落到 1 号上。
- 第 2 步：靠 `main-workflow.mjs` 的硬规则用例；上线后看连续合并时等着的确认是否只剩一次。
- 上线一周后再量一次排队时间，和前提 11 对比。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0176：CI 在自己的服务器上跑](0176-ci-on-ovh-vps.md)
- [ADR 0241：草稿 PR 不跑 CI，合并前等 CI 变绿](0241-draft-prs-skip-ci-and-merge-waits-for-green.md)
- [ADR 0243：CI 完全不用 GitHub 产物](0243-ci-uses-no-github-artifacts.md)
- [CI 服务器 runner 运行手册](../runbooks/ci-vps-runner-runbook.md)
