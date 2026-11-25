---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: ""
amended_by: "docs/adr/0259-review-models-default-to-deepseek.md, docs/adr/0263-cheaper-claude-side-of-code-review.md"
date: "2026-11-06"
---

# ADR 0175：代码复核第 2 轮起只用 DeepSeek，低严重度意见不再触发下一轮

> **2026-11-25 起暂停。** Andy 叫停了全部 OpenCode 复核：方案讨论、方案说法核对和合并前代码复核都不跑，合并只看测试和 CI（见 [AGENTS.md](../../AGENTS.md#working-with-opencode)）。Andy 说恢复之前，本文的决定不适用。

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [Andy 的原话](#owner-decisions)
- [决定](#decision)
- [与 ADR 0068 的关系](#amendments)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

合并 PR 之前，线程要用 OpenCode（一个能让模型读代码、调用工具的命令行程序）上的两个模型复核代码，步骤在 [.agents/instructions/model-review.md](../../.agents/instructions/model-review.md)：两个模型是 `opencode-go/deepseek-v4.1-flash` 和 `opencode-go/glm-5.3-flash`，推理强度都设为高；每改一次就再复核一轮，直到没有“会出错”的意见。

PR #255 复核了 6 轮，实际花了约 0.79 美元。按它的账本（`.agents/reviews/pr-255/usage.jsonl`，每次复核的用量和费用记录）拆开看：

- 每一轮约 0.10 到 0.16 美元，后面几轮并不比第 1 轮便宜。
- DeepSeek 共 0.434 美元，其中 56% 花在思考（推理 token）上；GLM 共 0.355 美元，其中 58% 是缓存读取，也就是反复读代码。
- 后面几轮的“会出错”意见，多数是只有故意构造的怪输入才能触发、触发后只是报错拒绝的问题，或者文字写得不准但不会误导人。

方案讨论记录在 `.agents/reviews/topic-review-cost/`，整合后的方案在 [`2026-11-06-review-cost-plan-v2.md`](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/.agents/handoffs/2026-11-06-review-cost-plan-v2.md)。

业界做法：Anthropic 官方的代码复核插件先给每条意见打 0 到 100 的置信分，再过滤掉 80 分以下的（[README](https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/plugins/code-review/README.md)：“Scores each issue 0-100 for confidence level”，“Filters out issues below 80 confidence threshold”）。也就是说，不是每条意见都值得再花一轮。

另外，2026-11-06 讨论这份方案时，DeepSeek 两次被 OpenCode 的服务拒绝（HTTP 429，`prefill_cap_refused`，服务满载），一次超时。脚本当时把服务报错记成 `no-text`（模型没写正文），看不出是服务的问题。本机实测 opencode 1.19.5 遇到 429 时会按服务给的间隔自己连试 5 次，都失败才报错。

[↑ 返回阅读导航](#contents)

<a id="owner-decisions"></a>

## Andy 的原话

- 2026-11-06：“我感觉现在做代码复核的费用有点太高了”。
- 对“第 2 轮起只用 DeepSeek”和“只有中、高严重度的会出错才触发下一轮”两项：“同意你这个方案”。
- 对方案第 1 版的三项（严重度分界线、低严重度由线程记进账本并由 Andy 抽查、先让模型讨论方案）：“1. 第一项：可以 2. 第二项：按照你的建议来 3. 第三项：可以”。
- 对方案第 2 版的两项（DeepSeek 用不了时由 GLM 替补、低严重度修改的规模上限）：“按照你的建议来”。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **认出服务报错。** opencode 输出 `type: "error"` 事件时，账本的 `outcome` 记 `api-error`，并记下状态码和错误信息。服务说可以重试的（opencode 给错误标了 `isRetryable`，或响应带数字形式的 `retry-after`、`retry-after-ms`），脚本等 60 秒再整轮重跑一次，费用算在同一个 0.2 美元上限里。
2. **代码复核第 1 轮两个模型都跑，之后默认只跑 DeepSeek。** 第 1 轮只给一个模型时脚本拒绝（用 `--round` 把失败的那个模型补跑进原来那一轮的除外）。DeepSeek 的固定侧重加上“规则文件、说明文档和代码是否一致”，原来这项是 GLM 先查的；这句第 1 轮起每轮都带，所以 DeepSeek 的提示词开头每轮逐字节相同，仍能命中服务端对相同开头的缓存。第 2 轮起 DeepSeek 重跑后仍是可以重试的服务报错时，由 GLM 替补这一轮，账本记 `substitute: true`。
3. **合并前检查改成一条复核链。** 起点是最后一轮不带 `--previous`、两个模型都通过的复核；之后通过的每一轮、每条低严重度放行记录，都是链上的一点；每一点的提交必须是前一点的后续提交，带 `--previous` 的一轮，它的 `previous` 还必须不晚于前一点的提交，这样模型看的增量不会跳过没复核的提交；最后一点之后只许改记录目录。
4. **“会出错”的意见分中、高和低两档，只有中、高的才触发下一轮。** 分界线：
   - 中、高：正常使用就会触发的错误结果、丢数据、泄露凭据或令牌，能绕过合并前检查或花钱上限的问题，无法撤销的破坏性操作；会让人照着做错这类事的规则或文档错误。
   - 低：只有故意构造的怪输入才能触发，且触发后是报错拒绝、不会给出错误结果；或者文字不准但不会误导人做错事。
   - 拿不准的按中、高。
5. **低严重度的修改用 `--accept-low` 记进账本，不再复核。** 线程把逐条判断写进机器能读的 `round-<n>/verdicts.jsonl`，修改和补的测试提交后运行 `--assert-reviewed --accept-low <轮次>`。脚本核对：判断文件格式对；模型原话在答案里能逐字找到；成立的“会出错”全部是低档；修改不超过 5 个文件、每个文件增删合计不超过 30 行、文件名不含换行，并且至少一个测试文件有新增的行（只改 `.md` 文档的除外）。合格才写一条 `low-fix` 记录，每一轮最多一条。`--report` 单列一节“低严重度已改、未复核”，逐条带模型原话（从那条记录自己的提交里读），由 Andy 抽查；不在复核链上的记录单独标出，不算放行。

方案讨论（`--mode plan`、`--mode plan-review`）不在这次改动的范围里，仍然两个模型都跑；只是 DeepSeek 的固定侧重是两种模式共用的，`plan-review` 里的 DeepSeek 也会多查“规则文件、说明文档和代码是否一致”。

取舍依据的原则：这是在“边界与可逆性”和“主动性与效率”之间取舍。省钱属于效率，排在边界之后（[产品愿景](../product-vision.md)里的原则顺序），所以合并前检查这道边界不放松：第 1 轮仍两个模型都看，“改了不复核”的范围由脚本按规模上限和逐字原话卡住，不只靠线程自觉。

[↑ 返回阅读导航](#contents)

<a id="amendments"></a>

## 与 ADR 0068 的关系

[ADR 0068](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0068-deepseek-only-codebuddy-fallback.md) 第 1 条写“派给代理的编码、审核和独立方案只用 DeepSeek V4.1 Flash”。它管的是把编码任务派给 opencode、CodeBuddy 这类代理的那条路（`opencode-orchestration` 技能和 [`.agents/opencode-models.toml`](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/.agents/opencode-models.toml) 模型表）。

用 `scripts/model-review/opencode-review.mjs` 做的方案讨论和合并前代码复核，从规则文件写成起就用两个 Go 套餐模型（Andy 在项目指令第 17 条规定）。两份文字一直互相矛盾。

本 ADR 部分修正（amend）ADR 0068，不整份替代：ADR 0068 第 1 条里的“审核和独立方案”不包括 `opencode-review.mjs` 做的方案讨论和代码复核。这两件事用哪个模型，以 `.agents/instructions/model-review.md` 和本 ADR 为准；ADR 0068 的其余内容继续有效。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **调低推理强度。** 不采用：这两个模型在 opencode 1.19.5 上只有 `low`、`high`、`max` 三档，没有中档；降到 `low` 会让复核漏掉错误路径，省下的思考费用不值得。
- **每轮都只用一个模型，包括第 1 轮。** 不采用：第 1 轮看的是整个 PR，两个模型侧重不同，GLM 常能找到 DeepSeek 漏掉的测试和文档问题。
- **低严重度也要 Andy 原话才能放行。** 不采用：Andy 选了由线程记账、他抽查；规模上限和测试要求由脚本卡住。
- **把低严重度意见直接忽略、不修改。** 不采用：低严重度也是真实的错误，照样要改、要补测试，只是不再为它多花一轮。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 按 PR #255 的账本推算，同样规模的 PR 约从 0.79 美元降到 0.25 到 0.35 美元；这是推算，没有实测，跑过两个 PR 后在方案文件下补记实测数字。
- 低严重度的修改不再被模型复核，靠测试、反向验证和 Andy 抽查兜底。
- 自动替补的主流程接线只有单元测试：脚本主流程要连真实的模型服务，本机没法端到端跑。
- 第 2 轮起只有 DeepSeek 一个视角；DeepSeek 拥堵时多花 60 秒等待和一次替补的钱。
- 脚本只能核对规模、格式和原话；一条意见判成低还是中、高，仍是线程的判断。模型答案和判断文件都由线程提交，线程有意在同一个提交里改掉它们，脚本认不出：这套核对防手误，不防有意伪造。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [.agents/instructions/model-review.md](../../.agents/instructions/model-review.md)：方案讨论和代码复核的步骤。
- [ADR 0068](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0068-deepseek-only-codebuddy-fallback.md)：派编码任务只用 DeepSeek。
- `scripts/model-review/opencode-review.mjs`、`test/tooling/opencode-review.test.mjs`：实现和测试。

[↑ 返回阅读导航](#contents)
