<a id="review-card"></a>
# 代码复核流程卡

这一页是合并前代码复核的常用路径。完整规则在[和 OpenCode 协作](model-review.md)（约 8 万字节），平时不通读，遇到下面没写到的情况或报错时，按链接只读对应那一节。事故清单 `docs/incidents-and-gates.md` 和教训记录 `docs/lessons.md` 也一样：按编号或标题用 `grep` 查那一段，不整份读。

为什么这样做：复核的花费大头在 Claude 线程这边。线程上下文常有 15 万到 30 万 token，每调一次工具都要把整段上下文再读一遍；一轮复核要调二三十次。每一轮的判断、修改和收尾交给一个新开的子代理（Claude Code 的 Agent 工具新开的一段对话，上下文从零开始，一轮做完就结束，不在子代理里攒出长上下文），主线程只拿回结论（[ADR 0263](../../docs/adr/0263-cheaper-claude-side-of-code-review.md)）。DeepSeek 复核由主线程在后台跑，答案出来后再起子代理：子代理的缓存只保留 5 分钟，让它等复核（实测一次等了 10.8 分钟），回来就要按 1.25 倍价把整段上下文重写一遍。

- [主线程怎么做](#main-thread)
- [子代理每一轮怎么做](#each-round)
- [停下来交回主线程](#stop)
- [常见报错查哪里](#errors)

<a id="main-thread"></a>
## 主线程怎么做

PR 开好、测试过了以后，每一轮分两步：

1. 主线程自己在后台跑这一轮的复核命令（Bash 工具的后台运行，时限至少 40 分钟），跑之前看一眼已花的钱（上一次复核输出的 `REVIEW_SPENT_TOTAL`）：已花的加上这一轮的预留（脚本按每个模型 0.2 美元算）会超过 1 美元时先问 Andy，他同意后在命令里加 `--approved-usd <他同意的总额>` 再跑。第 1 轮是 `node scripts/model-review/opencode-review.mjs --mode code-review --base <base> --head <提交> --pr <编号> --brief <材料> --gateway magpie`；之后的轮次照抄上一个子代理交回的 `NEXT` 命令，把 `<修改后的提交>` 换成它交回的新提交、`<材料文件>` 换成材料文件的路径，`--previous` 已经填好；带 `--previous` 的轮次，脚本自动把上一轮已提交的 `verdicts.jsonl` 里成立的“会出错”意见带进提示，并让模型只查上一轮意见是否改好、增量改的行、增量产生或修改的值的直接使用端，所以上一轮的 `verdicts.jsonl` 要先提交（[ADR 0270](../../docs/adr/0270-faster-review-rounds.md)）。等待时不调工具，后台命令结束会叫醒主线程。
2. 命令退出码是 0、输出里有 `outcome=ok` 的 `REVIEW_RESULT` 行，并且这一轮该跑的每个模型都有 `outcome=ok` 的结果（用 `--round` 只补跑了一部分的不算）以后，用 Agent 工具起一个新的子代理 `code-review-round`（定义在 `.claude/agents/code-review-round.md`，在后台跑），提示照下面写，把尖括号换成实际值。退出码不是 0（模型的 `outcome` 不是 `ok`、报错、要先问花钱）时不起子代理，按[常见报错查哪里](#errors)处理。

```
PR <编号>，仓库 <路径>，分支 <分支>。材料文件：<brief 路径>（问题、目标、约束和作者的说法）。对比基准：<base 提交>。
这一轮的复核已经跑完：<REVIEW_RESULT 行> <REVIEW_SPENT_TOTAL 行>
从流程卡“子代理每一轮怎么做”第 1 步开始。
```

主线程不读模型的答案、`verdicts.jsonl` 和 `judgments.md`，只看子代理交回的几行结论；Andy 问细节时再去读。

子代理交回 `NEXT fix-and-rereview` 时，主线程看一眼它交回的计数和自己那条 `REVIEW_SPENT_TOTAL`，回到第 1 步跑下一轮；交回 `fix-low-then`（低问题已改、`--accept-low` 已记账）、`low-deferred` 或 `done` 时进入收尾。

收尾时，主线程自己跑一次 `node scripts/model-review/opencode-review.mjs --assert-reviewed --pr <编号>`，看到 `REVIEW_CURRENT` 才采信它的结论（子代理自报的检查结果不算数，见[审核时直接采信代理自报的检查结果](../../docs/lessons.md#trust-reported-checks)）。然后把“可以更好”的意见、低严重度未修的意见和停下的原因报给 Andy，按[代码复核](model-review.md#code-review)第 5 到 7 步收尾。Andy 采纳了“可以更好”的意见时，先起一个子代理 `code-review-round`，提示里写明采纳的编号和 Andy 的原话，让它只做这些修改、提交推送并交回新提交；再由主线程按第 1 步跑复核，`--head` 是新提交，`--previous` 是上一轮 `ROUND_SUMMARY` 里的 `reviewed=`，然后照第 2 步起子代理判断。Andy 只要再跑一轮时，直接从第 1 步开始。

<a id="each-round"></a>
## 子代理每一轮怎么做

子代理只做一轮：这一轮的复核主线程已经跑完，子代理判断、收尾，按 `NEXT` 修改并提交，然后交回。子代理不跑 `--mode code-review`；要再复核时把 `NEXT` 打印的命令交回主线程。主线程只让你做 Andy 采纳的修改时，不做下面第 1 到 3 步，改完、跑相关测试、提交推送后交回新提交。这个 PR 之前复核过的，先读上一轮的 `judgments.md`，前面判过不成立或可以更好的意见再出现时沿用原判，除非相关代码改过或模型给了新证据。

1. 生成判断草稿：`node scripts/model-review/opencode-review.mjs --judge-skeleton --pr <编号>`。它把模型答案里每个 `###` 标题写成 `verdicts.jsonl` 的一行，编号和原话已填好；结论、侧重检查、必答问题几节里的标题不算。
2. 逐条核对并填写：打开意见说的代码核对，填 `valid`、`class`、`why`（依据：文件:行或运行结果）；成立的“会出错”再填 `severity`、`trigger`、`consequence`、`modelSeverity`，判得比模型低时加 `reason`。不是意见的行删掉，草稿漏掉的意见照格式补一行。判法见[代码复核](model-review.md#code-review)第 2 步，要点：
   - 照现在的代码有一种输入或用法会出错，或者文档和代码不符会让人做错，是“会出错”；只是写法能更好，是“可以更好”。
   - 中高：正常使用就会触发的错误结果、丢数据、泄露、能绕过合并检查或花钱上限、不能撤销的破坏。低：只有故意构造的怪输入才触发且只会报错拒绝，或文字不准但不误导。拿不准按中高。
   - 判“不成立”要给反例、运行结果或证明没有可达输入的代码引用。
3. 收尾这一轮：`node scripts/model-review/opencode-review.mjs --finish-round --pr <编号>`。它核对每条原话都在答案里、不成立和可以更好的都写了 `why`，写出 `judgments.md`，打印 `ROUND_SUMMARY` 和下一步 `NEXT`。把这一轮的记录目录提交。
4. 按 `NEXT` 做：
   - `fix-and-rereview`：修中高问题、补能证明它的测试、跑相关测试、提交推送，把打印的命令和新提交交回主线程，由主线程跑下一轮复核、再起下一个子代理。
   - `fix-low-then`：第 1、2 轮只剩低问题，照常修并补测试，提交后跑打印的 `--accept-low` 命令，再提交账本。规模上限见[代码复核](model-review.md#code-review)第 3 步。
   - `low-deferred`：第 3 轮起只剩低问题，不修、不再复核；`--report` 会在“低严重度未修”一节列出它们，交给 Andy 看。
   - `done`：没有“会出错”的意见。
5. 只在主线程要求收尾时做合并前检查：`git fetch origin main`，main 不在分支里就先合进来；跑 `--assert-reviewed --pr <编号>`，要看到 `REVIEW_CURRENT`；再跑 `--report --pr <编号> --stop <原因>`，输出原样交回主线程；没有中高“会出错”时原因是 `no-error`，连续三轮没过是 `three-rounds`，Andy 裁定是 `andy-decision`（加 `--andy-quote "<原话>"`），最后一轮该跑的模型没有 `ok` 是 `run-failed`。

<a id="stop"></a>
## 停下来交回主线程

遇到这些情况，不再开新一轮，把已做的和没解决的分开写清，交回主线程：

- 连续三轮没过（每轮都有中高问题）。
- 需要 Andy 定的事：中高问题的修法会改产品行为或规则、要改表、要花别的钱。
- 脚本报错且下面的表里找不到办法。

<a id="errors"></a>
## 常见报错查哪里

| 输出 | 读哪一节 |
| --- | --- |
| `REVIEW_RESULT` 的 `outcome` 不是 `ok`、`ROUND_NOT_OK` | [代码复核](model-review.md#code-review)第 3 步（服务报错的重跑和替补）、[怎么跑](model-review.md#how-to-run)（按 `outcome` 处理，不原样重跑） |
| `REVIEW_PREVIOUS_REFUSED`、`chain-broken` | [代码复核](model-review.md#code-review)第 6 步；用 `--finish-round` 打印的命令就不会传错 |
| `VERDICTS_INVALID`、`FINISH_ROUND_REFUSED` | [代码复核](model-review.md#code-review)第 2 步的字段说明 |
| `REVIEW_LOW_FIX_REFUSED` | [代码复核](model-review.md#code-review)第 3 步；拒绝原因同时记在 `.agents/reviews/pr-<编号>/low-fix-refusals.jsonl` |
| `REVIEW_NOT_CURRENT` | [代码复核](model-review.md#code-review)第 6 步 |
| `BUDGET_NEEDS_APPROVAL`、`api-error`、`GATEWAY_*` | [怎么跑](model-review.md#how-to-run)、[经 Magpie 调用模型](model-review.md#gateway) |
| Andy 说停、跳过、换服务方 | [Andy 怎样控制复核](model-review.md#owner-control) |
