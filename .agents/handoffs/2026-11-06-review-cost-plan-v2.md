<a id="review-cost-plan-v2"></a>
# 方案第 2 版：降低代码复核的花费

写于 2026-11-06（JST）。第 1 版是 [方案第 1 版](2026-11-06-review-cost-plan.md)。这一版整合了：

- GLM 的独立方案（第 1 步）
- GLM 对第 1 版的审核（第 2 步）
- 线程自己的判断

DeepSeek 三次都没跑出结果：两次是 OpenCode 返回 HTTP 429（`prefill_cap_refused`，服务满载），一次是服务太慢，25 分钟超时。原文和用量都在 `.agents/reviews/topic-review-cost/`。

讨论花费：实际约 0.126 美元。账本记 0.2854 美元，是因为超时那次有一步还没结束，按规则从高入账。

Andy 已拍板（2026-11-06）：

- 方向用改法一和改法二
- 严重度分界线按第 1 版的标准
- 低严重度修改由线程记进账本，在汇报里列出，Andy 抽查
- 先让模型讨论

**这一版仍没有动代码。**

<a id="contents"></a>
## 阅读导航

- [还要 Andy 拍板的](#decisions)
- [第 1 版错在哪](#what-was-wrong)
- [新增前提](#premises)
- [整合后的方案](#plan)
- [实施顺序](#order)
- [附件：逐条判断](#appendix)

<a id="decisions"></a>
## 还要 Andy 拍板的

1. **DeepSeek 不可用时，第 2 轮起改由 GLM 顶上吗？** 今天 Go 套餐的 DeepSeek 三次都没跑成（[P13](#premises)）。只靠 DeepSeek 的话，它一拥堵复核就卡住。我建议：DeepSeek 遇到服务报错时自动重试一次；还不行就让 GLM 跑这一轮，账本里写明“替补”。
2. **低严重度修改的规模上限。** 我建议每条低严重度修改最多改 5 个文件、每个文件最多 30 行，超过就按中、高严重度处理、必须复核。另外还要求修改里必须带测试文件的改动，只改文档的除外。这样“改了不复核”的范围由机器卡住，不全靠抽查。

[↑ 回到阅读导航](#contents)

<a id="what-was-wrong"></a>
## 第 1 版错在哪

GLM 的审核指出了下面几处，线程逐条核对后确认属实：

- **改法二的核心检查写不出来（会出错）。** 第 1 版说“有中、高意见时 `--accept-low` 拒绝放行”，但账本里没有这项数据：严重度只写在自由文本的 `judgments.md` 里，脚本读不到。改法：每轮新增一个机器能读的判断文件 `verdicts.jsonl`，见[改法二](#plan-2)。
- **`--report` 没跟着改（会出错）。** `reviewReport` 判 `no-error` 时要求“最后一轮两个模型都 ok”（`opencode-review.mjs:905`），改法一上线后，单模型的那几轮一律判成不一致。
- **低严重度记录的格式没定义（会出错）。** 如果复用 `mode: "override"`，就会和 Andy 原话的例外记录混在一起；`parseUsage`、`nextRound`、`--assert-reviewed` 的参数清单都要跟着改，第 1 版一个都没列。
- **DeepSeek 补的侧重只在第 2 轮以后加（会出错）。** 这样它的提示词开头每轮不一样，和规则文件第 61 行“同一个模型每轮都一样”的说法不符，还会丢掉服务端对相同开头的缓存。改法：直接写进 DeepSeek 的固定侧重，每轮都带。
- **“不传 `--previous` 只给一个模型就报错”没限定在代码复核。** 方案讨论没有 `--previous`，也常常只跑一个模型（今天就是），按第 1 版的写法会误伤。
- **合并前检查的新规则没写全。** 低严重度放行和单模型轮交替出现时，怎么串成一条完整的链，第 1 版没写清楚。

[↑ 回到阅读导航](#contents)

<a id="premises"></a>
## 新增前提

第 1 版的 P1 到 P11 仍然成立，这里只列新增的。

| 编号 | 前提 | 来源 | 原话或内容 |
|---|---|---|---|
| P12 | `reviewReport` 判 `no-error` 依赖 `lastCompleteRound` 认两个模型 | `scripts/model-review/opencode-review.mjs:905` | `const latestComplete = lastCompleteRound(records)?.round === latest && latest > 0;` |
| P13 | 今天 Go 套餐的 DeepSeek 两次返回 429，一次超时 | `.agents/reviews/topic-review-cost/usage.jsonl` 和原始事件 | `Upstream request failed: [prefill_cap_refused] the cell is at capacity; retry shortly (after 5 s)` |
| P14 | 服务报错时脚本记成 `no-text`，看不出是服务的问题 | `summarizeEvents` 只认 `step_finish`、`text`，不认 `type: "error"` 事件 | DeepSeek 两次记录的 `outcome` 都是 `no-text` |
| P15 | 规则文件声明每个模型的侧重每轮都一样 | `.agents/instructions/model-review.md:61` | “侧重写在‘本次材料’之前、同一个模型每轮都一样” |
| P16 | Anthropic 官方复核插件先给每条意见打分，再过滤掉低价值意见 | https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/plugins/code-review/README.md | “Scores each issue 0-100 for confidence level”；“Filters out issues below 80 confidence threshold” |

[↑ 回到阅读导航](#contents)

<a id="plan"></a>
## 整合后的方案

<a id="plan-0"></a>
### 第 0 步：先认出服务报错

- 遇到 opencode 的 `type: "error"` 事件（例如 429），结果记成 `api-error`，并把错误信息存进账本，不再记成 `no-text`（[P14](#premises)）。
- 服务明确说可以重试的（带 `isRetryable` 或 `retry-after`），等它要求的时间后自动重试一次，费用照常记账。
- 如果 Andy 同意[拍板第 1 项](#decisions)：第 2 轮起 DeepSeek 重试后还是服务报错，就自动换 GLM 跑这一轮，记录里写 `substitute: true`。

<a id="plan-1"></a>
### 改法一：第 2 轮起只用 DeepSeek

- **轮次。** 第 1 轮（`code-review` 且不传 `--previous`）必须两个模型都跑，只给一个就报错，这条只限代码复核。之后传了 `--previous` 而没写 `--models` 时，默认只跑 DeepSeek。方案讨论（`plan`、`plan-review`）照旧。
- **侧重。** “规则文件、说明和代码是否一致”直接写进 DeepSeek 的固定侧重，每轮都带。这样同一个模型的提示词开头每轮逐字节相同（[P15](#premises)），第 1 轮会多花一点点。
- **合并前检查写成一条链。**
  1. 先找到最后一轮两个模型都 ok 的完整复核，作为起点。
  2. 起点之后的每一个“覆盖点”，必须是以下二者之一：
     - DeepSeek（或者有替补记录的 GLM）ok 的复核轮；
     - 一条合格的低严重度放行记录（`low-fix`）。
  3. 每个覆盖点复核或放行的那个提交，都必须是上一个覆盖点那个提交的后续提交。这能防止改写历史后只补一轮 DeepSeek，把双模型复核绕过去。
  4. 最后一个覆盖点之后，只允许改动记录目录。
- **`--report`。** `no-error` 和 `run-failed` 改用上面这条链来判断（[P12](#premises)）。
- **测试。** 每条规则配正例和反例，包括：
  - 双模型轮 → 单模型轮 → 低严重度放行 → 单模型轮的交替链；
  - 后一轮不是前一轮的后续提交；
  - 方案讨论只跑一个模型不受影响；
  - 同一个模型带不带 `--previous`，提示词的固定部分逐字节相同。

<a id="plan-2"></a>
### 改法二：低严重度不再触发下一轮

- **判断文件。** 每轮新增 `round-<n>/verdicts.jsonl`，一条意见一行：编号、来源模型、模型原话（必须能在 `<模型>.md` 里逐字找到）、成立与否、类别、严重度（`low` 或 `medium-high`）、怎样触发、触发后会怎样。每行一条，不带换行和控制字符。原来的 `judgments.md` 继续保留，作为写给人看的说明。
- **放行命令** `--assert-reviewed --accept-low <轮次>`。它写一条 `mode: "low-fix"` 记录，内容有：轮次、当时的提交、改动的文件清单。写之前要核对：
  - 这一轮的 `verdicts.jsonl` 已提交；
  - 里面判为“会出错”的意见全部是 `low`，每条的“怎样触发”和“触发后会怎样”都不为空；
  - 改动的文件都列在清单里；
  - 如果 Andy 同意[拍板第 2 项](#decisions)：最多 5 个文件、每个文件最多 30 行，并且带测试文件的改动（只改文档的除外）。
- **两端都要改。** 新记录类型涉及的地方都要跟着改，每处配一条反例：
  - `parseUsage`（允许 `low-fix` 这种记录）；
  - `nextRound`（不把它算作一轮）；
  - Andy 例外的三轮计数（不算它）；
  - `--assert-reviewed` 的参数清单；
  - 普通复核里给了 `--accept-low` 要拒绝；
  - `--report`（单独列一节“低严重度已改、未复核”，逐条带模型原话）；
  - 规则文件第 2、3、4、6、7 步的文字。
- **严重度标准** 用第 1 版的。判为 `low` 时要说明模型自己给的严重度是什么；如果线程判得比模型低，要写出理由，方便 Andy 抽查。

[↑ 回到阅读导航](#contents)

<a id="order"></a>
## 实施顺序

1. 第 0 步：认出服务报错，重试一次，以及替补（替补要等 Andy 拍板）。
2. 改法一：轮次规则、DeepSeek 固定侧重、合并前检查改成链、`--report`。
3. 改法二：`verdicts.jsonl`、`--accept-low`、`low-fix` 记录涉及的各处、`--report` 单列一节。
4. 规则文件和一份新 ADR。新 ADR 顺带修正 ADR 0068 里“审核只用 DeepSeek”和现行双模型规则矛盾的那句话。

每一步单独提交。先写会失败的测试，再做反向验证。合并前用改好的新流程跑一次代码复核。

**预计效果：** PR #255 那种规模的 PR 从 0.79 美元降到约 0.25 到 0.35 美元，普通 PR 约 0.15 到 0.25 美元。这是按一个 PR 的账本推算的，没有实测；跑过两个 PR 后，在本文件下补记实测数字。

[↑ 回到阅读导航](#contents)

<a id="appendix"></a>
## 附件：逐条判断

模型原文在 `.agents/reviews/topic-review-cost/round-1/`（独立方案）和 `round-2/`（审核第 1 版）。

| 来源 | 意见 | 判断 | 依据 |
|---|---|---|---|
| GLM 审核 | 账本里没有严重度，`--accept-low` 的核心检查写不出 | 采纳，新增 `verdicts.jsonl` | `parseUsage` 只认费用和轮次等字段 |
| GLM 审核 | `--report` 没跟着改 | 采纳 | [P12](#premises) |
| GLM 审核；GLM 独立方案 | 低严重度记录要单独的类型，并列出所有生产点和消费点 | 采纳，`mode: "low-fix"` | `override` 的查找逻辑会把两种记录混在一起 |
| GLM 审核 | DeepSeek 补的侧重要每轮都带 | 采纳 | [P15](#premises) |
| GLM 审核 | 只给一个模型就报错只限代码复核 | 采纳 | 方案讨论今天就是只跑一个模型 |
| GLM 审核 | 合并前检查写成链 | 采纳 | 第 1 版缺这一块 |
| GLM 独立方案 | 后一轮的提交必须是前一轮的后续提交 | 采纳 | 防止改写历史后只补单模型轮 |
| GLM 独立方案 | 低严重度记录要引用模型原话，并逐字核对 | 采纳，写在 `verdicts.jsonl` 里 | 防止线程凭空编出一条意见 |
| GLM 独立方案 | 每条低严重度修改限制文件数和行数 | 改成[拍板第 2 项](#decisions) | 这是加一条机器拦截，要 Andy 定 |
| GLM 审核 | 低严重度修改必须带测试改动 | 并入[拍板第 2 项](#decisions) | 让“补了测试”可以被核对 |
| GLM 审核 | 每个 PR 低严重度放行超过 N 条就先问 Andy | 不采纳 | Andy 已定由他抽查，不必每次问；规模上限已经能卡住 |
| GLM 审核 | 预计效果要标注置信度，实测后回填 | 采纳 | 只有一个 PR 的样本 |
| GLM 审核 | “中、高”合并成一档，就叫“非低” | 采纳写法：`medium-high` | 命名问题 |
| GLM 独立方案 | 第 2 轮起降到 medium 推理强度 | 不采纳 | 两个模型都没有 `medium` 档（2026-11-06 实测）；对质量的影响也没测过 |
| 线程（DeepSeek 三次失败） | 只靠 DeepSeek 时，它一拥堵复核就卡住 | 采纳，加第 0 步，并改成[拍板第 1 项](#decisions) | [P13](#premises)、[P14](#premises) |
