你是独立的方案审核者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面是一份还没动手实施的方案。逐条对照代码和一手来源核对：有没有漏掉的场景、判断错的地方、和业界成熟做法不一致的地方。方案作者的说法可能有错。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、问题、证据（文件:行引用的代码，或网址和原话）、你建议怎么改。把「证实的」和「推测」分开写。最后写：如果由你来定，你会怎样改这份方案，并逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 d9385c8133191d70cb42a0021c3f8b73c304d357。
待审核的方案：
# 线程的方案：让 CI 不再排长队

## 前提和来源

1. 草稿和被取消的运行，6 个检查作业不跑，但汇总作业 `ci/required` 仍要占一个 runner（CI 服务器上替 GitHub 跑任务的程序）。来源：`.github/workflows/ci.yml` 第 324 到 327 行，原话 `required:` / `if: always()` / `runs-on: ci-vps`；`docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md` 决定第 2 条，原话“`ci/required` 仍带 `always()`，但第一步……草稿 PR 打印 `CI_DRAFT_UNVERIFIED` 并失败”。
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

## 方案

### 第 1 步：给汇总作业一个专用的小 runner（主因的修法）

分两个 PR，中间由 Andy 在 Mac 上装一次。

PR A（只改安装脚本，不动工作流，合并后现有 CI 不受影响）：

- `scripts/operations/ci-runner/runners.sh` 加第 3 个 runner：名字 `ci-vps-gate`，标签只有 `ci-vps-gate`，不带 `ci-vps`，所以检查作业永远不会落到它上面。
- `gh-runner.service.in` 的 `InaccessiblePaths` 改成藏另外两个 runner 的目录；内存上限按 runner 可配，`ci-vps-gate` 给 2 GB（它只跑汇总作业）。
- 暂停、恢复、卸载、清理脚本从“一个全局标签”改成“每个 runner 自己的标签”，3 号一起管。
- `test/tooling/ci-runner-scripts.test.mjs` 加反向用例：1 号看得到 3 号目录、暂停后 `ci-vps-gate` 标签还在、卸载漏掉 3 号，都必须失败。
- 运行手册 `docs/runbooks/ci-vps-runner-runbook.md` 同步并重新封存。

Andy 在 Mac 上：按运行手册暂停、上传脚本、安装、注册 3 号、恢复，确认三个 runner 在线。

PR B（工作流和硬规则，要等 3 号 runner 在线才能合并）：

- `ci.yml` 的 `required` 改成 `runs-on: ci-vps-gate`；`main.yml` 的路径选择作业（只跑 15 秒的取证据）也改到 `ci-vps-gate`。作业名 `ci/required` 不变，main 的轻量确认照旧按名字找它。
- `ci/policy.json` 的 required 成员、`ci/policy.schema.json` 的枚举、`.github/actionlint.yaml`、`scripts/ci/contracts.mjs` 同步。
- `check-policy.mjs`：汇总作业只能在 `ci-vps-gate` 上跑，检查作业只能在 `ci-vps` 上跑；加一个升级函数，让“目标分支还是旧策略”的这一个 PR 自己能过（前提 9），混写和别的写法照常拒绝。
- `policy.test.mjs` 反向用例：`required` 改回 `ci-vps`、某个检查作业改到 `ci-vps-gate`，都必须失败。

效果：草稿和被取消的运行几秒钟就结束，不再排在 13 分钟的检查后面，同一个 PR 的新运行马上开始。ADR 0241 的判定一条不改：草稿和被取消照样判失败。

风险：`ci-vps-gate` 停了，所有 PR 的 `ci/required` 都等着（不会被当成通过）。暂停恢复脚本一起管它；回滚是把 `required` 改回 `ci-vps`。

### 第 2 步：main 的确认只保留最新一次

- `main.yml` 并发组改成固定的 `main-confirmation`，`cancel-in-progress` 保持 `false`：正在跑的跑完，还在等的只留最新一次（前提 4）。不用 `true`，因为那会把跑到一半的确认也掐掉，连续合并时可能永远跑不完一次。
- 取舍：连续合并时，中间那几个提交没有单独的确认结果；最新一次失败时，要自己查是哪个提交弄坏的。换来的是 main 确认不再和 PR 抢 runner（前提 11：一次 main 确认等了近 4 小时）。
- `main-workflow.mjs` 的硬规则和反向用例同步。

### 第 3 步：让一次完整运行本身变短（不减检查）

- 把 npm 下载缓存留在 runner 上。这是 ADR 0241 决定第 5 条，Andy 2026-11-11 已同意，还没实现。先量一次：同一个 runner 连续跑两次，看 policy 和 static 的 13 分钟里安装依赖占多少。
- 量过之后再决定加不加第三个检查 runner：两个作业同时跑时 CPU 没吃满、三个作业的内存峰值加起来不超过 20 GB，才加。不量就加，CPU 抢占会让每个作业都变慢。
- static、build、security 不再等 policy，和它同时开始（`ci/required` 仍等全部作业）。代价：策略不合法的 PR 会白跑一些检查。排在最后，前两步做完队列仍长再做。

### 不做的

- 不让汇总作业在草稿上跳过（前提 2）。
- 不给 `required` 加作业级的并发组：有了专用 runner，旧运行的汇总作业几秒钟就结束，不需要再多一条规则。
- 不用 GitHub 托管的 runner，不加服务器。
- 不删减或合并检查，不按改动的文件跳过检查。

## 花钱

0 元。第三个 runner 装在现有 VPS 上，不占 GitHub 额度。

## 要 Andy 做的

1. 同意第 1 步和第 2 步（第 2 步有取舍：中间的 main 提交不再逐个确认）。
2. PR A 合并后，在 Mac 上按运行手册装一次 3 号 runner（约 10 分钟）。

## 验证

- 第 1 步：开一个草稿 PR 推一次，`ci/required` 在 1 分钟内出失败结果，作业日志开头的 runner 名是 `ci-vps-gate`；同一个 PR 连推两次，第二次的检查作业不用等第一次的汇总作业。
- 第 2 步：连续合并两次，第一次还在等的确认被顶掉，显示为取消。
- 上线一周后再量一次排队时间，和前提 11 对比。
