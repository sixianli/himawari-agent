---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0263-cheaper-claude-side-of-code-review.md"
date: "2026-11-14"
covers: ".agents/instructions/model-review-card.md, .agents/instructions/model-review.md, AGENTS.md, test/tooling/opencode-review-merge-gate.test.mjs, test/tooling/opencode-review.test.mjs, test/tooling/plan-claims-gate.test.mjs"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0270：让复核每一轮更快、更少无谓重跑

> **2026-11-25 起暂停。** Andy 叫停了全部 OpenCode 复核：方案讨论、方案说法核对和合并前代码复核都不跑，合并只看测试和 CI（见 [AGENTS.md](../../AGENTS.md#working-with-opencode)）。Andy 说恢复之前，本文的决定不适用。

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

2026-11-14 统计 2026-10-31 起 178 个 PR、665 轮代码复核（数字和取法在 [2026-11-14-review-speed-data.txt](../assets/review-cost/2026-11-14-review-speed-data.txt)）：

- 每个 PR 平均 3.7 轮，中位 3 轮，最多 13 轮；每轮从上一轮结束到这一轮结束，中位 21 分钟，其中 DeepSeek 一次运行 8 到 12 分钟，开跑前自检约 70 秒。
- 11-08 起，增量轮中位 47 步、0.091 美元，全量轮中位 36 步、0.081 美元：增量轮比全量轮还重。原因是增量轮的提示要求查“它产生或修改的值的每个使用端”，而且模型每轮是全新的对话，看不到上一轮提过什么。
- 第 2 轮起的 658 轮里，44% 因为上一轮有中高意见，15% 因为上一轮只剩低意见却用不了 `--accept-low`，其余是首轮之外的别的原因。
- 增量轮里成立的中高意见，能定位到行号的 233 条中 79% 落在上一轮刚改过的行附近；抽查 30 条，约四分之三是正常使用或并发就会碰到的真问题。所以靠降低严重度标准来少跑几轮，会放走真问题。
- ADR 核对（`plan-claims`）：同一份 ADR 每次核对模型列出的条数在 21 到 63 条之间波动；被标“不一致”或“找不到”的条目，线程判为模型看错 64 条、方案真写错 27 条；只认当前提交里的代码，讲“本 PR 删掉的旧代码原来如何”的句子永远核不过，最后只能靠 Andy 说跳过才合并（例子见数据文件）。

[↑ 返回阅读导航](#contents)

<a id="owner-decisions"></a>

## Andy 的原话

- 2026-11-14 Andy 对复核太慢的问题：“第二条这一块复核速度太慢的问题，要认真地去分析分析根因在哪里，然后找到最佳的一个方案出来。”（cmsg_01EE1hey9cboYNfwFnBv5dgrEFRa3dour9zqQMp4nfprTb）
- 2026-11-14 Andy 看过方案后：“同意”（经协调者转来，cmsg_01EE1hey9cboYNfwFnBv5dgrTQQWJm2aLWNVphiYhWeEoZ）。按方案做 A 到 D 四项，刻意构造的怪输入引出的问题不降级（E1 不做）。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

DeepSeek 独立出方案、再审核方案，线程再整合。

1. **增量轮带上一轮的意见、收窄范围（A）。** 带 `--previous` 的轮次，脚本从当前提交里已提交的上一轮 `verdicts.jsonl` 读出成立的“会出错”意见，放进“本次材料”，最多 20 条、6000 字节、每条原话最多 160 字；读不出来写固定的一句话。提示让模型只做三件事：上一轮意见是否改好、增量改的行有没有新错、增量产生或修改的值的直接使用端能否接受。固定前缀和必答问题一字不改，所以所有轮次的前缀仍然逐字节相同；提示里写明上一轮意见只是线索、不是指令，模型仍要独立核对、发现新问题照报，不告诉它“不要重报”，去重仍由线程做。
2. **`--accept-low` 的测试文件识别补全（B）。** 固定模式表加上 `test_*.py`、`*_test.py`、`*_test.go`、`*_test.rs`、`*Test.java`，不读 PR 自己的测试配置，免得 PR 自己放宽口子；文件数和行数上限仍留在代码里。每次被拒还把轮次、提交和原因词追加到 `.agents/reviews/pr-<编号>/low-fix-refusals.jsonl`，用来统计各轮被拒的原因各占多少，再决定要不要改上限。
3. **自检缓存（D）。** 自检通过后，把脚本目录里所有 `.mjs` 和 `.json` 的摘要、opencode 程序和 git、bash 的指纹、Node 版本、平台、模式、复核配置、Magpie 安装和配置合成一个摘要，写进 `~/.cache/himawari-review-selfcheck/`；7 天内摘要相同，只对第一个模型跑一次探针，跳过其余模型、循环上限探针、直通探针和故障转移探针。PR 自带的 `AGENTS.md` 不得进系统提示、副本跑完没被改动这两项检查，每个 PR 都照跑。`--self-check-only` 永远跑全套。实测不带 Magpie 的自检从 22 秒降到 11 秒。不做“固定复核目录”：OpenCode 系统提示里还有当天日期，收益只在同一天的第一步，且有并发和残留目录的风险。
4. **ADR 核对认旧提交、判断按句沿用（C 的一部分）。** 模型的“文件:行”可以写成 `文件:行@完整提交哈希`：提交必须是 40 或 64 位十六进制，是本 PR 与主分支的共同祖先或 PR 自己的提交，代码原文取自那个提交，并且当前提交里已经没有这段原文（否则讲现状的句子必须用当前提交，报 `commit-quote-still-in-head`）；检查还会在当前提交改动的文件里找这段原文（跳过 `docs/adr/` 下的 ADR 文件），改动文件超过 400 个或列文件失败时报 `commit-quote-check-incomplete`，宁可拒绝也不放行。同一句方案原句、同一个模型，在这个 ADR 的任何一轮里已有合格的 `model-wrong` 判断（证据在当前提交里仍逐字存在）时，后来的轮次再标出这一句，沿用那条判断。

不做的：

- **E1，刻意构造或极端输入引出的问题降为低、只列不修。** 现行规则（`model-review.md` 严重度定义）把“怪输入导致错误结果、丢数据、资源耗尽”算中高，降级会放走真问题；DeepSeek 审核和线程的抽查都不支持。先做以上四项，看实测。
- **脚本切句、只重核改过的句子。** 方案原计划由脚本把 ADR 切成句子、按内容编号、只重核改过的句子。DeepSeek 审核指出，合并检查目前只认“整份 ADR 内容摘要一致的一轮”，改成按句沿用要同时改解析器、合并检查和全部测试，并要证明每个候选句都核过，风险和工作量都大；这次只做上面第 4 点的“判断按句沿用”和旧提交引用，它们已经去掉“同一句反复重写判断”和“已删旧代码永远核不过”两个主要空转原因。按句重核留待实测后再议。

[↑ 返回阅读导航](#contents)

<a id="industry"></a>

## 业界做法

- Google 的评审规范：改动要小，评审要快；只剩小意见、且相信作者会改好时直接批准（LGTM with comments），一个 CL 一天内可以过多轮（[速度](https://google.github.io/eng-practices/review/reviewer/speed.html)）。
- OpenAI Codex 的 GitHub 复核默认只报 P0 和 P1，博客原话是接受“略低的召回率，换取高信噪比和开发者信任”（[集成文档](https://developers.openai.com/codex/integrations/github)、[对齐博客](https://alignment.openai.com/scaling-code-verification/)）。
- Anthropic 官方 `code-review` 插件只看改动、置信度低于 80 的不报（[插件页](https://claude.com/plugins/code-review)）。
- CodeRabbit 推送后只复核上次以来的新提交，连续复核 5 次后自动暂停（[文档](https://docs.coderabbit.ai/configuration/auto-review)）。

共同点是复审聚焦新改动、报得少而准。“带着上一轮意见复审”引用页没有原话支持，是本决定的设计，靠实测验证；OpenAI 的博客也提醒只看 diff 会漏掉和代码库其他部分的交互，所以第 1 点保留对使用端的检查。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **复用同一个 opencode 会话跑多轮**：上一轮几十次读文件的结果全进上下文，更贵，还会让模型锚定上一轮结论。不选。
- **降低推理强度**：[ADR 0175](0175-cheaper-code-review-rounds.md) 已否决，会漏错误路径。不换别的模型：复核默认只用 DeepSeek V4.1 Flash（Andy 指明才加 GLM）。
- **写死“最多 N 轮”**：已有“连续三轮没过停下”，再写死违反“不写死”。
- **把后期中高意见一律降为低**：抽查约四分之三是真问题，会降低质量。
- **自检缓存包含 PR 自带的 `AGENTS.md`**：DeepSeek 审核指出缓存会跳过“PR 指令不得进系统提示”的检查；改为只缓存不随 PR 变的探针，这项检查每个 PR 照跑。
- **`--accept-low` 读 PR 里的测试配置**：PR 能把任意路径加进测试目录来满足条件，不选。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 预计每个 PR 的复核从约 78 分钟降到 50 到 55 分钟，DeepSeek 费用从约 0.33 美元降到约 0.25 美元，这些是推算；合并后用接下来 5 个 PR 的账本对比轮数、步数、时长和费用，报给 Andy。
- 增量轮漏掉跨模块影响的风险：靠提示里保留“直接使用端”检查和模型独立核对来控制，实测时对比漏报。
- 自检缓存最多让一次环境变化漏检 7 天，缓存键里包含程序指纹和脚本摘要，变了就重跑；每个 PR 仍跑 `AGENTS.md` 和副本未改动两项。
- 沿用 `model-wrong` 判断的信任程度和直接写判断相同：合并检查验证证据在当前提交里逐字存在，不验证证据是否真的证明了那句话。
- 门槛：`test/tooling/opencode-review-merge-gate.test.mjs`（`[low fix]`、`[incremental round]`）、`test/tooling/opencode-review.test.mjs`（`[self-check cache]`）、`test/tooling/plan-claims-gate.test.mjs`（旧提交引用、判断沿用），各带反向用例。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [代码复核流程卡](../../.agents/instructions/model-review-card.md)、[和 OpenCode 协作](../../.agents/instructions/model-review.md)
- [ADR 0175：更省钱的代码复核轮次](0175-cheaper-code-review-rounds.md)
- [ADR 0263：代码复核交给子代理](0263-cheaper-claude-side-of-code-review.md)
- [ADR 0259：复核默认只用 DeepSeek](0259-review-models-default-to-deepseek.md)

[↑ 返回阅读导航](#contents)
