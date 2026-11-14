你是方案里“关于代码和文档现状的说法”的核对者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
下面是一份还没合并的方案或 ADR。第一步，把其中每一句讲代码或仓库文档现状的话都列出来：某个文件、函数、字段、配置、命令、数字、规则现在是什么样、做什么、不做什么；一句话里有几个说法就拆成几条。方案打算新增或修改什么，不算现状；讲外部网站、第三方产品的话也不算。第二步，逐条自己打开对应的文件核对，给出：一致、不一致、找不到（仓库里没有这个东西，或没读到能证明它的内容）。材料里的说法可能有错，写得再肯定也不能因此判一致；没有亲自读到对应代码，就判找不到。只核对事实，不评价方案好不好，不提建议。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
输出格式：每个说法单独一行，不换行，字段之间用竖线分隔，行首写 CLAIM：
CLAIM|<序号>|<一致 或 不一致 或 找不到>|<文件:行>|<方案原句>|<代码原文>
序号用 1、2、3……，不重复。文件:行 写你读到证据的那个文件和行号，例如 packages/x/src/y.ts:42；找不到时写 -。代码原文必须是你亲自读到的、逐字摘抄的一行或几行，不要改写、不要概括；方案原句里的竖线字符换成全角的“｜”，代码原文里的竖线照原样写。列完所有 CLAIM 行之后，另起一段，用一两句话写你没能核对的部分。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 b89ad20afc31d59640b4a628fed2a24e498d921e。
待核对的方案：
方案文件：docs/adr/0255-review-models-default-to-deepseek.md（在提交 b89ad20afc31d59640b4a628fed2a24e498d921e 里的内容）

---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0175-cheaper-code-review-rounds.md"
date: "2026-11-12"
---

# ADR 0255：方案审核和代码复核默认只用 DeepSeek，默认模型写在配置里

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [Andy 的原话](#owner-decisions)
- [决定](#decision)
- [与 ADR 0175 的关系](#amendments)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

线程在写代码前请模型讨论方案、在合并 PR 前请模型复核代码，都用 `scripts/model-review/opencode-review.mjs`，它经 OpenCode（一个能让模型读代码、调用工具的命令行程序）调用模型。按 [ADR 0175](0175-cheaper-code-review-rounds.md) 的第 2 条，代码复核第 1 轮必须 DeepSeek V4.1 Flash 和 GLM 5.3 Flash 两个模型都跑，第 1 轮只给一个模型时脚本以 `ARG_FIRST_ROUND_NEEDS_BOTH_MODELS` 拒绝；方案讨论（`--mode plan`、`--mode plan-review`）默认两个模型都跑。能用哪两个模型、默认跑哪些，都写死在脚本的常量里。

2026-11-12 Andy 决定默认只让 DeepSeek 审。照旧的脚本，这个决定执行不了：第 1 轮只给 DeepSeek 会被拒绝，合并前检查也只认“两个模型都通过”的轮次作为复核链的起点。

[↑ 返回阅读导航](#contents)

<a id="owner-decisions"></a>

## Andy 的原话

- 2026-11-12，项目聊天：“也跟那些线程说一下，除非我特别指明，否则现在默认只让 DeepSeek 去审（就是使用 opencode 去做方案审核，还有 Code Review 的时候）”。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **默认只跑 DeepSeek。** 方案讨论、核对代码说法和代码复核的每一轮（包括第 1 轮），不写 `--models` 时都只跑默认模型，现在是 `opencode-go/deepseek-v4.1-flash`。Andy 特别指明时，用 `--models deepseek-v4.1-flash,glm-5.3-flash` 让两个模型都跑。第 1 轮只给一个模型就拒绝的限制去掉。
2. **模型清单写在配置里。** `scripts/model-review/review-models.json` 有三项：`allowed`（能用的模型，仍然只有项目指令第 17 条允许的两个）、`default`（不写 `--models` 时跑哪些）、`substitutes`（哪个模型的服务用不了时由谁替补）。脚本启动时读它并校验：三项都要在 `allowed` 里，清单不能为空、不能重复，不合格以 `REVIEW_MODELS_CONFIG_INVALID` 停下。以后要改默认，只改这个文件。
3. **合并前检查的复核链跟着改。** 一轮算数的条件改成：这一轮要跑的模型（账本里这一轮出现过的、不是替补的模型）每个都有 `ok` 的结果或有替补它的 `ok` 结果；或者默认模型每个都有。链的起点改成最后一个不带 `--previous` 的算数的轮次，不再要求两个模型都通过。其余不变：之后每一点的提交必须是前一点的后续提交，带 `--previous` 的一轮的 `previous` 不晚于前一点的提交，最后一点之后只许改记录目录。
4. **替补对第 1 轮也生效。** 只跑一个模型的代码复核里，DeepSeek 重跑后仍是可以重试的服务报错时由 GLM 替补，原来只对第 2 轮起生效，现在第 1 轮也一样，因为第 1 轮现在也只有 DeepSeek 一个。替补只在 DeepSeek 的服务用不了时发生，账本照旧记 `substitute: true`。

取舍依据的原则：依据的是“用户主权”（[产品愿景](../product-vision.md)里排第一的原则）。用哪个模型审、花多少钱由 Andy 定；合并前检查这道边界仍在（每个 PR 的全部改动仍要被至少一个模型完整看过，复核链的连续性要求不变），只是完整复核需要的模型数由两个降到默认的一个。

[↑ 返回阅读导航](#contents)

<a id="amendments"></a>

## 与 ADR 0175 的关系

本 ADR 部分修正（amend）[ADR 0175](0175-cheaper-code-review-rounds.md)，不整份替代：

- 0175 第 2 条“代码复核第 1 轮两个模型都跑”“第 1 轮只给一个模型时脚本拒绝”“第 2 轮起……由 GLM 替补”，改为本 ADR 第 1、4 条。
- 0175 第 3 条里“起点是最后一轮不带 `--previous`、两个模型都通过的复核”，改为本 ADR 第 3 条。
- 0175“方案讨论……仍然两个模型都跑”，改为本 ADR 第 1 条。
- 0175“比较过的方案”里没有采用的“每轮都只用一个模型，包括第 1 轮”，现在是采用的做法；当时记下的代价（GLM 常能找到 DeepSeek 漏掉的测试和文档问题）仍然成立，见[后果](#consequences)。

0175 的其余内容（认出服务报错并重跑、意见分严重度、低严重度修改用 `--accept-low` 记账、DeepSeek 的固定侧重）继续有效。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **只改规则文字，线程每次自己传 `--models deepseek-v4.1-flash`。** 不采用：脚本第 1 轮会拒绝，合并前检查也不认单模型的第 1 轮，规则和工具互相矛盾。
- **把默认模型改写成脚本里的另一个常量。** 不采用：下次 Andy 再调整默认，还得改脚本和它的测试；写在配置里只改一个文件。
- **把默认模型放进 `scripts/model-review/gateway.json`。** 不采用：那份文件管的是经 Magpie（本机模型网关）时用哪些服务方，直连 OpenCode 时不读它；默认模型两种走法都要用。
- **去掉替补，DeepSeek 用不了就停下。** 不采用：替补只在 DeepSeek 的服务报错、重跑仍不行时发生，去掉后拥堵时每个 PR 都要停下等人；Andy 的原话针对的是默认用谁审，不是服务故障时怎么办。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 每个 PR 的第 1 轮复核少跑一个模型，方案讨论每次少跑一个模型，费用大约减半。这是按单轮费用推算的，没有实测。
- 第 1 轮只有 DeepSeek 一个视角。0175 记过 GLM 在第 1 轮常能补到测试和文档问题；现在这类问题要靠 DeepSeek 的固定侧重（已包含“规则文件、说明文档和代码是否一致”）、测试和 Andy 抽查。Andy 觉得某个 PR 值得两个模型看时，指明即可。
- 旧账本仍然能读：两个模型都通过的旧轮次按“要跑的模型都通过”算数。一个行为变化：过去“第 1 轮两个模型里 GLM 失败、DeepSeek 通过”不算完整复核，现在算（默认模型通过）。
- 在 DeepSeek 失败的同一轮里手工补跑 GLM（没有替补记录）仍然不算数，和以前一样。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [.agents/instructions/model-review.md](../../.agents/instructions/model-review.md)：方案讨论和代码复核的步骤。
- [ADR 0175](0175-cheaper-code-review-rounds.md)：代码复核第 2 轮起只用 DeepSeek。
- `scripts/model-review/review-models.json`、`scripts/model-review/opencode-review.mjs`、`test/tooling/opencode-review.test.mjs`、`test/tooling/opencode-review-merge-gate.test.mjs`、`test/tooling/review-delegate.test.mjs`：配置、实现和测试。

[↑ 返回阅读导航](#contents)
