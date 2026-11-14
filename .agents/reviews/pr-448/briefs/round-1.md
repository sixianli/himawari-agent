# PR 448 作者说明

## 问题

Andy 2026-11-12 定：“除非我特别指明，否则现在默认只让 DeepSeek 去审（就是使用 opencode 去做方案审核，还有 Code Review 的时候）”。改动前的 `scripts/model-review/opencode-review.mjs`：能用的模型和默认模型是脚本里的常量；代码复核第 1 轮只给一个模型时以 `ARG_FIRST_ROUND_NEEDS_BOTH_MODELS` 拒绝；合并前检查（`--assert-reviewed`）只认“不带 `--previous`、两个模型都通过”的轮次作为复核链起点。

## 目标

- 默认模型来自配置文件，默认只有 DeepSeek；需要时能用 `--models` 指定多个；不写死。
- 合并前检查接受默认模型单独完成的第 1 轮，同时不放过没被完整复核的改动。
- 旧账本（两个模型都通过的第 1 轮）仍然能读。
- 规则文字（`AGENTS.md`、`.agents/instructions/model-review.md`）和脚本一致。

## 约束

- 能用的模型仍只有两个（项目规定）。
- 这是开发协作工具，不是产品功能；这套检查防误操作，不防有意伪造（已有取舍）。
- 这个改动不涉及 Himawari 发给模型的请求。

## 作者的说法（请核对，不要直接采信）

- `review-models.json` 由 `readReviewModels` 读入并由 `reviewModelsProblems` 校验。
- `coveragePoints` 里一轮算数的条件：这一轮出现过的非替补模型每个都有 ok 或被替补；或默认模型每个都有。
- `walkChain` 的起点是任何不带 `--previous` 的非 low-fix 点。
- `substituteFor` 不再要求 `previous`。
- `delegate.mjs` 没改代码，它通过 `parseArgs(reviewArgv(task)).models` 得到期望的模型，所以任务不写 models 时期望的是默认模型。

请重点看：有没有哪种账本内容会让没被完整复核的改动通过合并前检查；有没有哪条规则文字和代码不一致；有没有别处还依赖“第 1 轮两个模型”的假设（包括别的脚本、测试、文档）。
