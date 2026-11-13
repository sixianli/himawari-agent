---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0175-cheaper-code-review-rounds.md"
date: "2026-11-13"
---

# ADR 0263：代码复核交给子代理，机械步骤交给脚本，第 3 轮起低意见只列不修

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [Andy 的原话](#owner-decisions)
- [决定](#decision)
- [业界做法](#industry)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

合并前的代码复核用 `scripts/model-review/opencode-review.mjs` 经 OpenCode（一个能让模型读代码、调用工具的命令行程序）请 DeepSeek V4.1 Flash 只读复核，线程（Claude Code 的一段对话）再逐条判断、修改、再复核。2026-11-13 统计 180 个 PR 的复核记录和 4 个 PR 线程的用量（数字和取法见 [`docs/assets/review-cost/2026-11-13-data.txt`](../assets/review-cost/2026-11-13-data.txt)）：

- 钱的大头在 Claude 线程这边。4 个 PR 的整个线程按 API 价折算 39–86 美元，同一批 PR 的 DeepSeek 复核 0.4–1.4 美元。线程上下文常有 15 万到 30 万 token，每调一次工具都按缓存价重读整段上下文；一轮复核要读答案、逐条打开代码、手写 `verdicts.jsonl`（逐字抄模型原话）和 `judgments.md`、提交、跑检查，约 25–40 次调用。
- 线程常整份读 `.agents/instructions/model-review.md`（约 8 万字节）、`docs/incidents-and-gates.md`（约 18 万）、`docs/lessons.md`（约 15 万），读进来以后每次调用都要重付。
- 2026-11-11 起，增量轮（带 `--previous`）中位 53 步，和第 1 轮的 57 步差不多：提示原话是“上一轮复核到 ${previous}，先看 git diff ${previous}..${head} 的增量，但可以读任何文件。”，步数说明模型每轮基本把整个 PR 重查一遍。
- 各轮成立的中高意见：第 1 轮 460 条、第 2 轮 195、第 3 轮 107、第 4 轮 57、第 5 轮 34、6 轮以上 51。第 3 轮以后的回报明显变少，而按 [ADR 0175](0175-cheaper-code-review-rounds.md) 第 5 条，低严重度意见要修改、补测试后用 `--accept-low` 记进账本，每轮都这样。

图表和逐项解释见线程文档“复核省 token 和提速：数据与结论”。

[↑ 返回阅读导航](#contents)

<a id="owner-decisions"></a>

## Andy 的原话

- 2026-11-13，线程里对四项建议（复核交给小上下文、机械活交给脚本、少读大文件、少跑轮次）回复：“同意，可以按照你的顺序来，然后赶快把它们优化掉”。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **每一轮复核交给一个新的子代理。**PR 线程开好 PR 后，每一轮用 Claude Code 的 Agent 工具起一个子代理 `code-review-round`（定义在 `.claude/agents/code-review-round.md`；新的一段对话，上下文从零开始），由它跑这一轮复核、逐条判断、按结论修改并提交，然后交回几行结论；下一轮再起一个新的，免得在子代理里攒出长上下文。主线程不读模型答案和判断文件，收尾时自己再跑一次 `--assert-reviewed`，子代理自报的结果不算数。逐条判断仍由 Claude 做，只是换到子代理里。做法写在新的一页流程卡 [`.agents/instructions/model-review-card.md`](../../.agents/instructions/model-review-card.md)。
2. **机械步骤交给脚本。**`opencode-review.mjs` 新增两条不花钱的命令：
   - `--judge-skeleton --pr <编号>`：把最新一轮模型答案里每个 `###` 标题写成 `verdicts.jsonl` 的一行，编号和原话已填好；“结论”“侧重检查”“必答问题”几节里的标题跳过；文件已存在时拒绝覆盖，一条都找不到时拒绝、不写文件。代码复核的输出格式同时改为“每条意见单独一个以 `### ` 开头的标题”。
   - `--finish-round --pr <编号>`：核对每条原话都在答案里、判“不成立”和“可以更好”的都写了依据 `why`、自由文本里没有控制字符，由 `verdicts.jsonl` 生成 `judgments.md`，打印这一轮的计数和下一步命令。下一轮命令里的 `--previous` 自动填成这一轮复核的提交，免得再把账本提交当成上一轮复核的提交传进去。
3. **一页流程卡，大文件按需查。**线程跑代码复核先读流程卡，遇到卡上没写的情况或报错，按卡上的链接只读完整说明的对应一节；事故清单和教训记录按编号查。测试核对流程卡上的每个锚点和参数都真实存在。
4. **增量轮只查增量，第 3 轮起低意见只列不修。**
   - 带 `--previous` 的轮次，提示改为“先看增量，复核增量和它直接影响的代码：调用它的地方、它调用的地方、它产生或修改的值的每个使用端；增量没碰到、行为也没被改变的旧代码不必整份重读，但证据指向旧代码时要跟下去；结论写清查过哪些范围”。必答问题不变。
   - 第 3 轮起，一轮里成立的“会出错”意见全是低时，不修、不记 `low-fix`、不再复核；`--report` 新增一节“低严重度未修（第 3 轮起只列不修）”，列出第 3 轮起每一轮只剩低意见、又没记 `low-fix` 的那些意见（轮次、编号、原话、触发条件、后果），交给 Andy 抽查。起始轮次写在 `scripts/model-review/review-models.json` 的 `lowDeferFromRound`，不写死在脚本里。第 1、2 轮照旧按 ADR 0175 修低意见。合并检查不变：最后一轮复核的就是当前代码，复核链本来就接得上。

这修订了 ADR 0175 第 5 条在第 3 轮及以后的适用范围；ADR 0175 的其他决定不变。

[↑ 返回阅读导航](#contents)

<a id="industry"></a>

## 业界做法

- Claude Code 官方文档对子代理的说法（[Subagents](https://code.claude.com/docs/en/sub-agents)）：“Use one when a side task would flood your main conversation with search results, logs, or file contents you won't reference again: the subagent does that work in its own context and returns only the summary.” 同一页也写明：“It also sends its own requests, which count toward the same usage limits as your main conversation.” 所以省下的是主线程大上下文的重读，子代理自己的请求照样计入额度。
- 复核意见的判断质量不能降，所以子代理沿用主线程的模型，不按文档里“routing tasks to faster, lower-cost models like Haiku”换成小模型。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- 主线程照旧复核，只靠脚本减少调用：每次调用仍要重读 15 万以上 token 的上下文，省得少，放弃。
- 新开一个线程做复核：要经协调者，交接慢，和子代理效果相同，放弃。
- 一个子代理跑完所有轮次（第一版方案）：DeepSeek 审方案时指出子代理里会重新攒出长上下文，改成每轮一个。
- 子代理不加载项目指令（`omitClaudeMd`）：能再省约 1.5 万 token，但子代理改代码也要守项目规则（例如不写注释），放弃。
- 主线程每轮读判断文件抽查：正是要省掉的开销，改为收尾时自己跑合并检查。
- 第 3 轮起连低意见也不判断：会漏掉被判错的中高意见，放弃；仍逐条判断，只是低的不修。
- 增量轮完全禁止读增量以外的代码：会漏掉增量影响到的调用方，放弃；改成只读增量直接影响的代码。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 正面：复核部分的 Claude 花费预计降到原来的三到四成；增量轮步数预计减少；`--previous` 不再需要手抄。
- 负面：第 3 轮起的低意见留在代码里，靠 `--report` 列给 Andy；子代理的判断主线程不复看，质量靠流程卡和 `--finish-round` 的核对；增量轮可能漏掉与增量没有直接关系、但前几轮也没发现的问题；子代理自己的请求照样计入 Claude 额度，每起一个子代理要重新加载一次项目指令（约 1.5 万 token）。
- 改动前后的实测对比在 PR 描述里给出；之后两周的 PR 复核数据再复查一次，增量轮漏掉问题就退回旧提示。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0175：代码复核第 2 轮起只用 DeepSeek，低严重度意见不再触发下一轮](0175-cheaper-code-review-rounds.md)
- [ADR 0259：方案审核和代码复核默认只用 DeepSeek](0259-review-models-default-to-deepseek.md)
- [和 OpenCode 协作](../../.agents/instructions/model-review.md)
- [代码复核流程卡](../../.agents/instructions/model-review-card.md)

[↑ 返回阅读导航](#contents)
