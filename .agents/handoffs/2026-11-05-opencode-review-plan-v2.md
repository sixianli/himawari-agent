<a id="opencode-review-plan-v2"></a>
# 整合方案：复核流程的四项整改（T2、T3、T5、T6），第 2 版

写于 2026-11-05（JST）。第 1 版是 [方案第 1 版](2026-11-05-opencode-review-plan-t2-t3-t5-t6.md)。这一版整合了三方意见：两个模型在看不到第 1 版的情况下各自出的方案（第 1 步，`--mode plan`），两个模型对第 1 版的审核（第 2 步，`--mode plan-review`），以及线程自己的判断。四份原文和用量都存在 `.agents/reviews/topic-review-process-t2356/`，两步合计花费 0.194 美元。**这一版仍没有动工。**

Andy 已拍板的（2026-11-05，原话）：T2“同意做”、T3“同意做”、T5 真实对比“可以”、先跑方案讨论“可以”。

<a id="contents"></a>
## 阅读导航

- [还要 Andy 拍板的三项](#decisions)
- [第 1 版错在哪](#what-was-wrong)
- [前提和来源](#premises)
- [整合后的方案](#plan)
- [实施顺序](#order)
- [附件：逐条判断](#appendix)

<a id="decisions"></a>
## 还要 Andy 拍板的三项

1. **合并前，分支要不要先包含 main 的最新提交？** 复核看的是分支上的代码。如果复核之后 main 又前进了，GitHub 合并出来的代码就是两边的组合，这个组合没人复核过（[P4](#premises)）。建议**要**：合并前 main 必须已经在分支里；main 前进了，就先把 main 合进分支，再跑一轮只看新增部分的复核（约 0.06 到 0.13 美元）。代价是 main 频繁前进时会多跑几轮。不要的话，规则写明“复核只对分支自己的代码负责”。
2. **T5 的真实对比要跑两轮，不是一轮。** 旧的复核记录都没保存，没有现成的“改之前”结果可比，所以要先用旧提示词跑一轮做基线，再用新提示词跑一轮（[P7](#premises)）。预计合计 0.12 到 0.26 美元，最多 0.8 美元，超过你上次同意的“最多 0.4 美元”，所以再问一次。对比案例用 I-73 那次：#207 的合并提交 `d347c51d`，对比基准 `7911a7ad`（[P8](#premises)）。
3. **给所有复核加第 4 条必答问题：“改动产生或修改的每个值（标识、字段、配置键、清单项），每一个使用它的地方都能接受吗？”** 这是 I-73 漏掉的那类问题。两个模型都必须回答，不靠分工。它会写进 `model-review.md` 的“每次都要问的问题”，以后每次复核都会问。建议加。

[↑ 回到阅读导航](#contents)

<a id="what-was-wrong"></a>
## 第 1 版错在哪

两个模型都指出了下面几处，线程逐条核对后确认属实：

- **T2 和 T3 互相锁死（会出错）。** 第 1 版要求“最后一轮复核的提交必须等于分支当前提交”，又要求把复核记录提交进 PR。一提交记录，当前提交就变了，检查永远不过；再复核又产生新记录，没有尽头。改法：比较代码差别，只改 `.agents/reviews/<本 PR>/` 的提交不算改动。
- **T5 只改一句提示词不够（会出错）。** 两个模型的提示词不同之后，每轮只存一份 `prompt.md` 就对不上任何一个模型，T8 刚做的 `--round` 还会因为提示词核对永远报 `ROUND_PROMPT_MISMATCH`。要按模型分别生成、分别存。
- **复核记录进仓库后，下一轮的模型会读到上一轮的结论（会出错）。** 复核副本是整个仓库的克隆，读文件权限对仓库内全开。要从副本里删掉 `.agents/reviews/`。
- **T6 原来没有自动检查。** 改成脚本直接生成汇报的固定几行。
- **事实写错两处：** #248 的最终提交 `bd0859a9` 只有一个父提交，不是合并提交，它的问题是“合并 main 之后又改了规则文件”；I-73 对应的是 #207，不是 #213。

[↑ 回到阅读导航](#contents)

<a id="premises"></a>
## 前提和来源

| 编号 | 前提 | 来源 | 原话或内容 |
|---|---|---|---|
| P1 | 现行规则只对“会出错”意见引起的修改再复核 | `.agents/instructions/model-review.md:28` | “按‘会出错’的意见，或第 5 步里 Andy 采纳的意见，做了修改，就对这些修改再复核一轮” |
| P2 | #248 合并 main 后又改了规则，没再复核；它的最终提交不是合并提交 | 提交 `bd0859a9` 的说明；`git cat-file -p bd0859a9` 只有 1 行 `parent` | “合并 main 后的规则改动（把摘要白名单收窄）未再复核” |
| P3 | GitHub 按“代码差别有没有变”作废旧批准 | https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches | “dismiss stale pull request approvals when commits are pushed that affect the diff in the pull request” |
| P4 | GitHub 连目标分支前进、合并基准变化也算 | 同上 | “approving reviews will be dismissed as stale if the merge base introduces new changes after the review was submitted” |
| P5 | 复核副本是整个提交树的克隆，模型对副本内的文件都能读 | `scripts/model-review/opencode-review.mjs` 的 `prepareCopy`、`removeUnsafeProjectFiles`；`reviewConfig` 的 `read: { "*": "allow", ... }` | 只删 `.opencode/`、`opencode.json(c)`、`.env*`、指向副本外的链接 |
| P6 | 现在每轮只生成、只存一份提示词，两个模型共用 | `opencode-review.mjs` 的 `main()`：`buildPrompt` 调用一次，`writeFileSync(join(roundDir, "prompt.md"), prompt)` | 同左 |
| P7 | 旧的复核记录没有保存 | 交接文件 F3：`find / -name usage.jsonl` 无结果，`git ls-files` 里没有复核结论 | 同左 |
| P8 | I-73 由 #207 引入；`7911a7ad` 是 `d347c51d` 的第一个父提交 | `docs/incidents-and-gates.md` I-73 行；`git cat-file -p d347c51d` | “#207 让模型清单从 Magpie 动态获取……”；`parent 7911a7ad…` |
| P9 | Anthropic 官方复核插件分侧重，但在高风险项上故意让两个代理重复看 | https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/plugins/code-review/README.md | “Agents #1 & #2: Audit for CLAUDE.md compliance”（两个代理做同一件事） |
| P10 | 连续三轮没过时，规则要求改完不再复核、停下报告 | `model-review.md` 第 4 步 | “连续三轮没过，第三轮的‘会出错’意见可以先改，但改完不再复核，直接停下报告 Andy” |
| P11 | 复核每次运行都是新会话，只有追问一步续用会话 | `opencode-review.mjs` 的 `runOpencode`：`...(session ? ["--session", session] : [])` | 同左 |

[↑ 回到阅读导航](#contents)

<a id="plan"></a>
## 整合后的方案

<a id="plan-t3"></a>
### T3 复核记录进仓库

- 参数：代码复核必须传 `--pr <编号>`，方案讨论必须传 `--topic <短名>`；记录目录固定为 `--repo` 仓库下的 `.agents/reviews/pr-<编号>/` 或 `.agents/reviews/topic-<短名>/`。加前缀，纯数字的短名不会和 PR 编号撞目录。短名只允许小写字母、数字和连字符。`--out` 只在 `--self-check-only` 时允许。
- 每轮存：每个模型实际收到的提示词 `<模型>.prompt.md`、结论 `<模型>.md`、失败时的 `<模型>.stderr.txt`、`usage.jsonl`。每条用量记录新增 `base`、`previous`、`promptSha256`。原始事件 `.jsonl` 和思考 `.thinking.md` 太大（一轮可到 1 MB），只留在临时目录，不进仓库。
- 复核副本里删掉整个 `.agents/reviews/`，自检加一条探针：读 `.agents/reviews/` 下的文件必须读不到。
- `biome.json` 排除 `.agents/reviews`（理由同已排除的 `.agents/tasks`：生成的数据，不该被格式化改写）。
- 局限：`--topic` 换个短名仍能重开一本账。方案讨论的先问线是 0.5 美元，每次汇报时贴出路径，Andy 能看出是不是同一本。

<a id="plan-t2"></a>
### T2 合并的代码必须复核过

- 规则：最后一个完整轮次（两个模型都是 `ok`）之后，分支上任何改动代码的提交都要再复核一轮，包括合并 main、解决冲突、顺手的小改动；只改 `.agents/reviews/<本 PR>/` 的提交除外。若 Andy 同意[拍板第 1 项](#decisions)，合并前 main 还必须已经在分支里。
- 新增不花钱的检查 `--assert-reviewed --pr <编号>`，放在安装 opencode 和自检之前：
  - 从当前提交里读账本（`git show HEAD:.agents/reviews/pr-<编号>/usage.jsonl`），不读工作区，账本没提交就失败。
  - 只看 `mode` 为 `code-review` 的记录。取最后一个“两个模型都有 `ok` 记录”的轮次，同一轮里同一模型有多条记录（`--round` 重跑）时，有一条 `ok` 就算。
  - 这一轮的 `head` 必须是当前提交的祖先；两者之间的差别只能在 `.agents/reviews/pr-<编号>/` 下。（拍板第 1 项同意时，再要求 `origin/main` 是当前提交的祖先。）
  - 不满足就以 `REVIEW_NOT_CURRENT` 失败，列出未复核的文件和缺的模型。
- 和“连续三轮没过就停”（[P10](#premises)）的关系：那时 Andy 若仍说“合并”，线程用 `--accept-unreviewed "<Andy 原话>"` 运行检查，检查通过但打印 `REVIEW_OVERRIDE` 和原话，原话写进账本，不静默放过。
- 局限：合并由线程执行，脚本拦不住线程不跑这条检查；要真正拦下，得等 CI 能读账本、Andy 决定规则集要求 `ci/required`，本方案不做。

<a id="plan-t6"></a>
### T6 汇报由脚本生成

- 新增 `--report --pr <编号> --stop <原因>`，从账本生成固定几行：每轮的 `REVIEW_RESULT`、累计费用、`--assert-reviewed` 的结果、停下的原因，以及一句固定的话：“复核模型只读代码、不运行代码；复核通过不等于测试通过。”
- 停下的原因只有这几种：`no-error`（没有“会出错”的意见）、`three-rounds`（连续三轮没过）、`andy-decision`（Andy 裁定，必须附原话）、`run-failed`（模型没跑完）。脚本核对它和账本是否一致：例如最后一轮有模型不是 `ok`，就不能写 `no-error`。
- 规则：PR 描述和合并前的汇报，复核部分照贴 `--report` 的输出。
- 局限：哪条意见算“会出错”仍由线程判断，脚本只能核对说法和账本是否自洽。

<a id="plan-t5"></a>
### T5 共同底线加各自侧重

- 共同底线：两个模型都回答全部必答问题，包括[拍板第 3 项](#decisions)新加的接口那一条。这照搬了 Anthropic 插件在高风险项上让两个代理重复看的做法（[P9](#premises)）。
- 各自侧重，只作为额外必须回答的一节，不限制能报什么：
  - DeepSeek：错误路径、不可信输入、安全、资源耗尽、不可撤销的操作。
  - GLM：测试有没有覆盖改动、文档和规则是否与代码一致、使用流程从头到尾走一遍会经过哪些没测过的路径。
- 代码：`buildPrompt({ mode, model, ... })`，侧重写在“本次材料”之前的固定部分，同一个模型每轮都一样；每个模型的提示词分别存、分别核对（T8 的 `--round` 改为按模型核对）。
- 缓存：每次运行都是新会话（[P11](#premises)），不改写任何已发内容；上线后两个模型各自的固定开头会各失效一次。
- 自动检查：两个模型的提示词只在侧重那一节不同；同一模型两次生成逐字节相同；都含全部必答问题；把侧重删掉或换给另一个模型时测试失败。
- 真实对比（[拍板第 2 项](#decisions)）：在 `d347c51d` 上先用旧提示词跑一轮、再用新提示词跑一轮，材料只写 #207 当时的说明，不提“斜杠”“校验”这类答案。事先定好的判据：新提示词下至少一个模型指出“清单生成的模型引用过不了后端校验”这一类问题，并落到文件和行；同时记两轮各自的意见条数、重合条数、误报条数和花费。一次对比只是个案，不能证明普遍更好。

[↑ 回到阅读导航](#contents)

<a id="order"></a>
## 实施顺序

1. T3：账本先进仓库，T2 才有东西可查。
2. T2：`--assert-reviewed`。
3. T6：`--report`，用到 T2 的检查结果。
4. T5 代码部分和第 4 条必答问题。
5. T5 真实对比，花钱前按拍板第 2 项的答复。

每一步单独提交，先写会失败的测试，改完通过；全部完成后合并前跑一次代码复核，用的就是这次改好的流程。

[↑ 回到阅读导航](#contents)

<a id="appendix"></a>
## 附件：逐条判断

模型原文在 `.agents/reviews/topic-review-process-t2356/`：`round-1/` 是独立出方案，`round-2/` 是审核第 1 版。

| 来源 | 意见 | 判断 | 依据 |
|---|---|---|---|
| 两个模型的审核都提 | T2 和 T3 互相锁死 | 采纳 | 第 1 版第 57、69 行原文，见[第 1 版错在哪](#what-was-wrong) |
| 两个模型的审核都提 | T5 要按模型生成和存提示词，`--round` 核对会冲突 | 采纳 | `main()` 只生成一份提示词（[P6](#premises)）；`roundForRun` 只比一份 |
| 两个模型的审核都提；DeepSeek 第 1 步也提 | 记录进仓库后被下一轮模型读到 | 采纳，从副本里删掉 | [P5](#premises) |
| 两个模型的审核都提 | `--assert-reviewed` 的账本来源、模型核对、`mode` 过滤没写清 | 采纳 | 已写进 [T2](#plan-t2) |
| DeepSeek 审核 | 检查要从提交里读账本，不读工作区 | 采纳 | 工作区里的账本可以没提交 |
| DeepSeek 审核 | 还要检查合并基准是否变化 | 部分采纳，改成[拍板第 1 项](#decisions) | [P4](#premises)；代价是多跑几轮，由 Andy 定 |
| DeepSeek 审核 | 和“连续三轮没过”冲突 | 采纳，加 `--accept-unreviewed` | [P10](#premises) |
| DeepSeek 审核 | 侧重互不重叠会降低冗余，应保留共同底线 | 采纳 | [P9](#premises)，见[拍板第 3 项](#decisions) |
| DeepSeek 审核 | 真实对比要两轮 | 采纳，改成[拍板第 2 项](#decisions) | [P7](#premises) |
| 两个模型的审核都提 | #248 不是合并提交；I-73 是 #207 | 采纳，更正 | [P2](#premises)、[P8](#premises) |
| 两个模型的审核都提；两个模型第 1 步都提 | T6 要有自动检查，停下原因要全 | 采纳，改为 `--report` 加四种原因 | [T6](#plan-t6) |
| DeepSeek 审核 | 失败时的 `stderr.txt` 要存 | 采纳 | 现有脚本只在失败时写它 |
| GLM 审核 | `--topic` 换名就能重开一本账 | 接受这个局限，靠汇报贴路径 | 方案讨论没有 PR 编号这类外部锚点；按 `--brief` 路径推导也挡不住换文件 |
| GLM 审核 | 插新节时别切断“每次都要问的问题” | 采纳；测试改为断言恰好 4 条 | `reviewQuestions` 按下一个锚点或标题切分 |
| DeepSeek 第 1 步 | 用 sparse checkout 和 `.gitattributes` 隐藏记录 | 不采纳，改为直接删目录 | 删目录更简单，效果相同；模型用 `git show` 仍可从历史读到，写进局限 |
| DeepSeek 第 1 步 | 计划阶段的账本开 PR 后改名并入 PR 账本 | 不采纳 | 方案讨论和代码复核各有先问线（0.5 和 1 美元），本来就是两本账 |
| GLM 第 1 步 | 在合并提交说明里加 `Review-ledger:` 行，由 `npm run check` 检查 main 上的合并提交 | 不采纳 | 合并提交说明由 GitHub 生成，线程不一定能控制；`--report` 贴进 PR 描述已够事后查 |
| GLM 第 1 步 | DeepSeek 管契约、GLM 管流程推演 | 部分采纳 | 契约放进共同底线，流程推演给 GLM |
