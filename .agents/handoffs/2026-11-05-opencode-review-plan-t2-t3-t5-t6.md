<a id="opencode-review-plan"></a>
# 方案：复核流程的四项整改（T2、T3、T5、T6）

写于 2026-11-05（JST），接手 [交接文件](2026-11-05-opencode-review-findings.md) 的线程起草。**这只是方案，没有动工**，Andy 同意后才改。四项都改的是复核流程的规则或脚本的行为，按 [Andy 定的长期规则](../../.claude/rules/owner-standing-rules.md#fixing-bugs-and-new-features) 属于“改机制或规则”。

<a id="contents"></a>
## 阅读导航

- [要 Andy 拍板的几项](#decisions)
- [前提和来源](#premises)
- [T2 合并的提交必须复核过](#t2)
- [T3 复核记录进仓库、账本按 PR 归档](#t3)
- [T5 两个模型各有侧重](#t5)
- [T6 固定汇报格式](#t6)
- [没采纳的做法](#rejected)
- [对交接文件的更正](#corrections)

<a id="decisions"></a>
## 要 Andy 拍板的几项

1. **T2：合并 main 产生的合并提交算不算“改动”？** 建议算：冲突是线程手工解决的，GitHub 的“推了新提交就作废旧的批准”也不区分合并提交（[前提 P2](#premises)）。代价是每次合并 main 后多跑一轮只看增量的复核，按最近两次的实际花费（[P6](#premises)），一轮约 0.06 到 0.13 美元。只改 `docs/`、`.agents/` 文字的提交要不要豁免：建议**不豁免**，#248 漏掉的正是一处规则文件改动（[P3](#premises)）。
2. **T3：复核记录存哪里？**
   - 选项 A（建议）：`.agents/reviews/<PR 编号>/`。不受文档治理约束，不用 frontmatter，线程照抄脚本输出即可。
   - 选项 B：`docs/reviews/<PR 编号>/`。会被当成项目文档，要先定一个文档类型，每次提交都要跑文档严格校验，负担大。
3. **T5：要不要花钱做一次真实对比？** 一轮两个模型最多 0.4 美元（[P7](#premises)），实际约 0.06 到 0.13 美元。建议**做一次**：挑一个已合并、已知复核漏过问题的 PR（例如 #213 之后 I-73 那次），对比“同一提示词”和“各有侧重”两种写法的意见重叠和漏报，花一轮的钱。不做的话，T5 只能凭推测上线。
4. **是否先跑 OpenCode 方案讨论？** 项目规则要求大改动先让两个模型独立出方案、再审线程的方案（[P8](#premises)）。两轮最多 0.8 美元，超过 0.5 美元的先问线，所以先问你。建议跑：这四项都是改复核流程本身，正好让复核模型挑毛病。

[↑ 回到阅读导航](#contents)

<a id="premises"></a>
## 前提和来源

| 编号 | 前提 | 来源 | 原话或内容 |
|---|---|---|---|
| P1 | 现行规则只要求对“会出错”意见引起的修改再复核 | `.agents/instructions/model-review.md:28` | “按‘会出错’的意见，或第 5 步里 Andy 采纳的意见，做了修改，就对这些修改再复核一轮” |
| P2 | GitHub 的分支保护把“批准之后又推了提交”当作批准作废 | https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches | “dismiss stale pull request approvals when commits are pushed that affect the diff in the pull request”；“the most recent reviewable push must be approved by someone other than the person who pushed it” |
| P3 | #248 合并 main 后的规则改动没有复核 | [sixianli/himawari-agent#248](https://github.com/sixianli/himawari-agent/pull/248) 描述 | “合并 main 后的规则改动（把摘要白名单收窄）未再复核” |
| P4 | 脚本每条用量记录都带 `head` | `scripts/model-review/opencode-review.mjs`，`main()` 里的 `record`（`head: commits.head`） | 每个模型每轮一行，含 `round`、`model`、`head`、`outcome`、`cost` |
| P5 | 费用累计只看同一个 `--out` 下的 `usage.jsonl`，结果目录在线程容器里，容器回收就没了 | `opencode-review.mjs` 的 `readUsage(out)`；交接文件 F3 的复现 | `readUsage` 读 `join(out, "usage.jsonl")` |
| P6 | 最近两次复核每轮的实际花费 | 提交 `a3aa0ad4`、`3bfc0f8a` 说明；#248 描述 | “第 4 轮（累计约 0.46 美元）”；“第 1 轮（两个模型，累计约 0.11 美元）”；“2 轮（累计 0.26 美元）” |
| P7 | 每个模型每轮最多记 0.2 美元；方案讨论超过 0.5 美元先问 | `opencode-review.mjs`：`COST_LIMIT_PER_MODEL_USD = 0.2`，`ASK_FIRST_LINE_USD = { "code-review": 1, plan: 0.5, "plan-review": 0.5 }` | 同左 |
| P8 | 大改动写代码前要先让两个模型独立出方案、再审线程方案 | `AGENTS.md`“和 OpenCode 协作”一节 | “写代码之前要出方案时（大改动一定要）：先让两个模型在不看线程结论的情况下各自出方案（`--mode plan`），再请它们审核线程自己的方案（`--mode plan-review`）” |
| P9 | 只能用这两个模型 | `model-review.md:4` | “只能用这两个模型（Andy 在项目指令第 17 条规定）” |
| P10 | Anthropic 官方的代码复核插件把复核拆给不同侧重的代理，再给每条意见打分过滤 | https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/plugins/code-review/README.md | 四个并行代理：两个“Audit for CLAUDE.md compliance”，一个“Scan for obvious bugs in changes”，一个“Analyze git blame/history for context-based issues”；“Each issue independently scored 0-100”，“Filters out issues below 80 confidence threshold” |
| P11 | 双模型复核漏过一次生产事故，原因是没问跨模块的问题 | `docs/incidents-and-gates.md` 的 I-73 一行 | “双模型复核只看了 diff，没问「清单里的 id 能通过后端校验吗」” |
| P12 | 复核模型不能运行代码 | `opencode-review.mjs`：`GIT_READ_COMMANDS` 和 `reviewConfig` 的权限表 | 只允许 read、grep、glob 和 5 条 git 读命令，`edit`、其他 bash 一律 `deny` |
| P13 | 复核模型每次运行都是新会话，不跨运行复用缓存 | `opencode-review.mjs` 的 `runOpencode`：每次 `opencode run` 新开会话，只有追问一步带 `--session` | `...(session ? ["--session", session] : [])` |

[↑ 回到阅读导航](#contents)

<a id="t2"></a>
## T2 合并的提交必须复核过

- 问题：最后一轮复核看的提交可以和合并时的提交不同（[P1](#premises)、[P3](#premises)）。
- 业界做法：GitHub 分支保护在批准之后又推了提交时，把批准作废，直到重新批准（[P2](#premises)）。这里照搬这个规则，把“批准”换成“最后一轮复核”。
- 做法：
  1. 规则：`model-review.md`“合并之前：代码复核”加一步：合并前，最后一轮复核的 `--head` 必须等于分支当前提交；不等就再跑一轮增量（`--previous <最后一轮的 head>`）。合并 main 产生的合并提交和只改文字的提交都算（见[拍板第 1 项](#decisions)）。
  2. 硬门槛：脚本加一个只读、不花钱的子命令 `--assert-reviewed <提交> --out <结果目录>`：读 `usage.jsonl`，找出 `outcome` 为 `ok` 的最大轮次，要求两个模型在这一轮都是 `ok`、`head` 等于给定提交，否则以 `REVIEW_NOT_CURRENT` 失败并打印差了哪些提交。线程合并前运行它，把输出贴进汇报（见 [T6](#t6)）。
- 门槛的局限：合并由线程执行，脚本拦不住线程不跑这条检查。真正的硬门槛要放进 GitHub 规则集（让 CI 读复核记录），那要等 T3 的记录进仓库、并且 Andy 决定规则集要求 `ci/required`，本方案不做。
- 测试：`--assert-reviewed` 的正反用例（最后一轮的 head 不等、某个模型不是 ok、只有更早的轮次是 ok）。

<a id="t3"></a>
## T3 复核记录进仓库、账本按 PR 归档

- 问题：换一个 `--out` 目录就绕过了累计费用的先问线；结果在线程容器里，容器回收就没了（[P5](#premises)）。
- 做法：
  1. 脚本加必填参数 `--pr <编号>`（方案讨论还没有 PR，改为 `--topic <短名>`）。`--out` 不再由线程指定，固定为 `<仓库>/.agents/reviews/<pr-编号 或 topic-短名>/`。同一个 PR 的所有轮次必然写进同一个账本，换目录名绕不过。
  2. 每轮保存 `prompt.md`、两个模型的结论 `<模型>.md`、`usage.jsonl`。原始事件 `.jsonl` 和思考 `.thinking.md` 很大（一轮可到几 MB），写到容器的临时目录，不进仓库。
  3. 线程在合并前把这个目录随 PR 一起提交；之后 [T2](#t2) 的检查就能在仓库里查到。
  4. `prompt.md` 一并保存，也覆盖交接文件 F10：方案讨论的材料有没有混进线程的方案，事后能对照。
- 风险：`prompt.md` 和结论会提交进仓库，里面可能引用代码片段。仓库本身就有这些代码，`npm run check:secrets` 会扫描它们，所以不额外处理。
- 测试：`--pr` 和 `--topic` 二选一、目录名只能是数字或小写短名（防止 `../`）、同一 PR 的第二轮读到第一轮的费用。

<a id="t5"></a>
## T5 两个模型各有侧重

- 问题：两个模型拿到完全相同的提示词，意见容易重叠；I-73 漏的是跨模块的问题（[P11](#premises)）。
- 业界做法：Anthropic 官方的代码复核插件给不同代理分不同的侧重（规则遵守、明显的错误、历史和上下文），再给每条意见打分过滤（[P10](#premises)）。
- 做法：模型固定不变（[P9](#premises)）。在 `MODE_TEXT` 的代码复核和方案审核里，给两个模型各加一句侧重：
  - DeepSeek：错误路径、安全、资源耗尽、不可撤销的操作，以及改动和项目规则（`AGENTS.md`、`.claude/rules/`）是否冲突。
  - GLM：跨模块的契约（改动方产生的值能不能被使用方接受，例如 I-73 的模型引用）、测试是否覆盖了改动、文档和代码是否一致。
  - 两个模型仍都回答全部必答问题，侧重只决定先查什么，不限制能报什么。
- 不加打分过滤：现行规则把“意见成不成立”交给线程逐条判断，分数过滤会和这条规则重复。
- 缓存：复核每次运行都是新会话（[P13](#premises)），两个模型的提示词开头不同不会让已有缓存失效，[只追加规则](../../.agents/instructions/prompt-prefix.md#rules)不受影响。
- 验收：见[拍板第 3 项](#decisions)，用一个已知漏报的旧 PR 对比一次。

<a id="t6"></a>
## T6 固定汇报格式

- 问题：从提交记录看不出最后一轮复核看的是哪个提交、复核后有没有未复核的改动、是不是因为“连续三轮没过”才停下（交接文件 F5）；“复核过了”容易被当成“跑过了”（[P12](#premises)）。
- 做法：`model-review.md` 加一节“汇报格式”，PR 描述和交付报告的复核部分固定写这几行：
  1. 每轮一行：脚本打印的 `REVIEW_RESULT` 原样贴（含 `steps`、`cacheRead`、`cost`）。
  2. `REVIEW_SPENT_TOTAL` 那一行。
  3. `--assert-reviewed` 的输出（[T2](#t2)）。
  4. 最后一轮之后未复核的提交和原因；没有就写“无”。
  5. 停下的原因：“没有会出错的意见”或“连续三轮没过，按第 4 步停下”。
  6. 固定一句：“复核模型只读代码、不运行代码；复核通过不等于测试通过。”
- 门槛：这一项是写作规范，没有自动检查；T2 的 `--assert-reviewed` 覆盖其中最重要的第 3、4 行。

[↑ 回到阅读导航](#contents)

<a id="rejected"></a>
## 没采纳的做法

- 让复核模型能跑测试：能补上 I-73 这类问题，但要放开执行权限，和 Andy 2026-11-03 定的“只读、防误操作”冲突（`model-review.md` 第 44 行一段），也会让一轮的时间和费用变得不可控。
- 换更强的模型或加第三个模型：违反“只能用这两个模型”（[P9](#premises)）。
- 由另一个线程判分（交接文件 F5）：要多开一个线程、多一轮来回，Andy 要转述两次。T6 把判断依据写进汇报，Andy 抽查即可，先不做。

[↑ 回到阅读导航](#contents)

<a id="corrections"></a>
## 对交接文件的更正

- 交接文件 F3 说复核记录不保存“和产品愿景里‘决策记录’这项资产不符”，T3 也这样写理由。这是错的：`docs/product-vision.md` 第 124 行的“决策记录”指 Himawari 产品自己的“主动性的校准数据”（“它何时该提醒、何时该沉默……”），不是开发过程中的复核记录。T3 的理由只剩：先问线能被绕过、事后查不到费用和模型原话。
- T4 原写“拆成带锚点的小节”，实际用的是子列表（见提交 `50ee1d88` 的说明）。

[↑ 回到阅读导航](#contents)
