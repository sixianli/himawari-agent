你是独立的方案设计者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面只给了问题、目标和约束，没有给出任何人的方案；材料里如果提到某种做法，只作参考。先读代码弄清现状，再独立提出你认为最好的方案，不要假设已经有人想好了答案。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
输出格式：先列方案依赖的前提，每个前提附来源（文件:行或网址）和原话；再写方案本身、考虑过但不选的做法及原因、风险和反例、需要人拍板的取舍。把「读代码或来源证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 3c8c971fcc34e6c3a978210eecaed17746410ac2。
问题、目标和约束：
# 方案讨论材料：CI 排队太长

## 问题

2026-11-12 19:30 JST，仓库有 28 次 CI 运行在排队，新 PR 的检查要等几个小时才开始。Andy 的目标：CI 要顺；修根因，不降低检查质量；绝不在 GitHub 上花钱（仓库私有，不用 GitHub 托管的 runner）；不在服务器上多花钱（只用现有的 CI VPS）。

## 已核对的事实

1. CI 在一台 VPS 上跑：8 个 vCPU、22 GB 内存，两个自托管 runner `ci-vps-1`、`ci-vps-2`，标签都是 `ci-vps`。来源：`docs/adr/0176-ci-on-ovh-vps.md` 第 34、72、75 行（“两个 runner 合计 `MemoryHigh=19G`、`MemoryMax=20G`，每个 `MemoryHigh=14G`、`MemoryMax=15G`”）；第 54 行（“先装 2 个，跑一次完整 CI 再决定要不要加到 3”）。
2. 每个 runner 一次只跑一个作业（GitHub 自托管 runner 的固有行为）。`ci.yml` 一次完整运行有 6 个检查作业（policy、static、build、browser、coverage、security）加汇总作业 `ci/required`，全部 `runs-on: ci-vps`（`.github/workflows/ci.yml`）。
3. 实测作业时长（GitHub API 的作业记录，2026-11-12）：policy 13 到 14 分钟，static 13 到 14 分钟，build 约 6 分钟，security 约 6 分钟。policy 作业的资源记录：峰值内存 2.68 GB（作业日志里的 `peakBytes: 2682445824`），机器 8 核。
4. `ci.yml` 的并发设置（第 23 到 25 行）：`group: ${{ github.workflow }}-${{ github.event_name }}-${{ github.event.pull_request.number || github.ref }}-${{ github.event_name == 'push' && github.run_id || '' }}`，`cancel-in-progress: ${{ github.event_name == 'pull_request' }}`。
5. 汇总作业 `required` 是 `if: always()`、`runs-on: ci-vps`，第一步“草稿和被取消的运行直接判失败”（`ci.yml` 第 324 行起）。草稿 PR 的 6 个检查作业都被跳过，但汇总作业仍要占一个 runner 跑几秒钟。来源：[ADR 0241](../../../docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md)。
6. 实测：排队的 28 次运行里，多数是“6 个检查作业已跳过或已取消，只剩 `ci/required` 在等 runner”的运行，例如运行 43188147300、43191538886、43186918106（都是 `ci/required | queued`，其余作业 `skipped`）。同一个 PR 的新运行处于 `pending`，要等旧运行的 `ci/required` 跑完才开始（例如 PR 439：43188147300 排队，43193780006 等待）。
7. `main.yml`（合并到 main 之后的确认）的并发组是 `main-confirmation-${{ github.run_id }}`、`cancel-in-progress: false`，所以 main 上连续合并 6 次就有 6 次确认各自排队；证据取不到时走完整 CI（6 个作业）。
8. 当天有多个线程同时开发，短时间内反复推送；每次推送触发一次运行。
9. 分支保护规则目前没有要求 `ci/required`（AGENTS.md“交付模式”一节：合并前 PR 最新提交上的 `ci/required` 必须是成功，由线程自己遵守）。
10. `scripts/ci/check-policy.mjs` 逐字校验 `ci.yml` 的结构，`scripts/ci/main-workflow.mjs` 校验 `main.yml`；改工作流要同步改它们和 `test/tooling/policy.test.mjs`。
11. VPS 的 runner 安装脚本在 `scripts/operations/ci-runner/`，运行手册是 `docs/runbooks/ci-vps-runner-runbook.md`。云端线程没有 VPS 的登录凭证，改 VPS 要 Andy 在 Mac 上执行。

## 约束

- 不花钱：不用 GitHub 托管 runner，不加服务器。
- 不降低检查质量：不能跳过、合并或弱化检查；被取消或草稿的运行不能被当成通过（跳过的必需检查在 GitHub 分支保护里算通过，这是 ADR 0241 让汇总作业 `if: always()` 并判失败的原因）。
- 汇总结论要打印在 `ci/required` 作业日志里，main 的轻量确认靠它（ADR 0243）。
- 代码不写注释；工作流改动要有硬规则和反向用例。

## 请你给出

一套让排队明显变短的方案：改哪些文件、VPS 上要做什么、每项改动的风险和怎样验证；参考 GitHub 官方文档和成熟开源项目在自托管 runner 上的做法，附一手来源。指出上面哪条事实你核对后认为不对。
