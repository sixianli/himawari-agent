CLAIM|1|一致|.agents/instructions/model-review.md:94|线程在写代码前请模型讨论方案、在合并 PR 前请模型复核代码，都用 `scripts/model-review/opencode-review.mjs`|用 `node scripts/model-review/opencode-review.mjs` 跑，不要自己拼 `opencode run` 命令。
CLAIM|2|一致|scripts/model-review/opencode-review.mjs:830|它经 OpenCode（一个能让模型读代码、调用工具的命令行程序）调用模型|const child = spawn( binary, [ "run", "--format", "json", "--thinking", ...(session ? ["--session", session] : []), "-m", model, "--variant", REASONING_VARIANT, prompt, ], {
CLAIM|3|一致|docs/adr/0175-cheaper-code-review-rounds.md:62|按 ADR 0175 的第 2 条，代码复核第 1 轮必须 DeepSeek V4.1 Flash 和 GLM 5.3 Flash 两个模型都跑|2. **代码复核第 1 轮两个模型都跑，之后默认只跑 DeepSeek。** 第 1 轮只给一个模型时脚本拒绝（用 `--round` 把失败的那个模型补跑进原来那一轮的除外）。DeepSeek 的固定侧重加上“规则文件、说明文档和代码是否一致”，原来这项是 GLM 先查的；这句第 1 轮起每轮都带，所以 DeepSeek 的提示词开头每轮逐字节相同，仍能命中服务端对相同开头的缓存。第 2 轮起 DeepSeek 重跑后仍是可以重试的服务报错时，由 GLM 替补这一轮，账本记 `substitute: true`。
CLAIM|4|不一致|scripts/model-review/opencode-review.mjs:2815|第 1 轮只给一个模型时脚本以 `ARG_FIRST_ROUND_NEEDS_BOTH_MODELS` 拒绝|models: DEFAULT_REVIEW_MODELS,
CLAIM|5|不一致|scripts/model-review/opencode-review.mjs:2815|方案讨论（`--mode plan`、`--mode plan-review`）默认两个模型都跑|models: DEFAULT_REVIEW_MODELS,
CLAIM|6|不一致|scripts/model-review/opencode-review.mjs:96|能用哪两个模型、默认跑哪些，都写死在脚本的常量里|export const REVIEW_MODELS = reviewModels.allowed;
CLAIM|7|不一致|scripts/model-review/opencode-review.mjs:2815|照旧的脚本，这个决定执行不了：第 1 轮只给 DeepSeek 会被拒绝|models: DEFAULT_REVIEW_MODELS,
CLAIM|8|不一致|scripts/model-review/opencode-review.mjs:1342|合并前检查也只认“两个模型都通过”的轮次作为复核链的起点|if (point.by !== "low-fix" && point.previous === null) {
CLAIM|9|一致|scripts/model-review/review-models.json:3|不写 `--models` 时都只跑默认模型，现在是 `opencode-go/deepseek-v4.1-flash`|"default": ["opencode-go/deepseek-v4.1-flash"],
CLAIM|10|一致|.agents/instructions/model-review.md:4|allowed（能用的模型，仍然只有项目指令第 17 条允许的两个）|能用的只有这两个模型（Andy 在项目指令第 17 条规定）。
CLAIM|11|一致|scripts/model-review/opencode-review.mjs:1357|其余不变：之后每一点的提交必须是前一点的后续提交|!isAncestor(covered, point.head)
CLAIM|12|一致|scripts/model-review/opencode-review.mjs:1356|带 `--previous` 的一轮的 `previous` 不晚于前一点的提交|!isAncestor(point.previous, covered)
CLAIM|13|一致|scripts/model-review/opencode-review.mjs:1383|最后一点之后只许改记录目录|return result.stdout.split("\0").filter((file) => file && !file.startsWith(`${ledgerPath}/`));
CLAIM|14|一致|scripts/model-review/opencode-review.mjs:986|替补只在 DeepSeek 的服务用不了时发生|if (!run.review.summary.apiError?.retryable) return null;
CLAIM|15|一致|scripts/model-review/opencode-review.mjs:3406|账本照旧记 `substitute: true`|substitute: true,
CLAIM|16|一致|docs/adr/0175-cheaper-code-review-rounds.md:62|0175 第 2 条“代码复核第 1 轮两个模型都跑”|第 1 轮只给一个模型时脚本拒绝（用 `--round` 把失败的那个模型补跑进原来那一轮的除外）。
CLAIM|17|一致|docs/adr/0175-cheaper-code-review-rounds.md:62|0175 第 2 条“第 1 轮只给一个模型时脚本拒绝”|第 1 轮只给一个模型时脚本拒绝（用 `--round` 把失败的那个模型补跑进原来那一轮的除外）。
CLAIM|18|一致|docs/adr/0175-cheaper-code-review-rounds.md:62|0175 第 2 条“第 2 轮起……由 GLM 替补”|第 2 轮起 DeepSeek 重跑后仍是可以重试的服务报错时，由 GLM 替补这一轮，账本记 `substitute: true`。
CLAIM|19|一致|docs/adr/0175-cheaper-code-review-rounds.md:63|0175 第 3 条里“起点是最后一轮不带 `--previous`、两个模型都通过的复核”|起点是最后一轮不带 `--previous`、两个模型都通过的复核；之后通过的每一轮、每条低严重度放行记录，都是链上的一点；
CLAIM|20|一致|docs/adr/0175-cheaper-code-review-rounds.md:70|0175“方案讨论……仍然两个模型都跑”|方案讨论（`--mode plan`、`--mode plan-review`）不在这次改动的范围里，仍然两个模型都跑；
CLAIM|21|一致|docs/adr/0175-cheaper-code-review-rounds.md:93|0175“比较过的方案”里没有采用的“每轮都只用一个模型，包括第 1 轮”|- **每轮都只用一个模型，包括第 1 轮。** 不采用：第 1 轮看的是整个 PR，两个模型侧重不同，GLM 常能找到 DeepSeek 漏掉的测试和文档问题。
CLAIM|22|一致|docs/adr/0175-cheaper-code-review-rounds.md:93|当时记下的代价（GLM 常能找到 DeepSeek 漏掉的测试和文档问题）仍然成立|- **每轮都只用一个模型，包括第 1 轮。** 不采用：第 1 轮看的是整个 PR，两个模型侧重不同，GLM 常能找到 DeepSeek 漏掉的测试和文档问题。
CLAIM|23|一致|docs/adr/0175-cheaper-code-review-rounds.md:61|0175 的其余内容（认出服务报错并重跑）继续有效|1. **认出服务报错。** opencode 输出 `type: "error"` 事件时，账本的 `outcome` 记 `api-error`，并记下状态码和错误信息。服务说可以重试的（opencode 给错误标了 `isRetryable`，或响应带数字形式的 `retry-after`、`retry-after-ms`），脚本等 60 秒再整轮重跑一次，费用算在同一个 0.2 美元上限里。
CLAIM|24|一致|docs/adr/0175-cheaper-code-review-rounds.md:64|0175 的其余内容（意见分严重度）继续有效|4. **“会出错”的意见分中、高和低两档，只有中、高的才触发下一轮。** 分界线：
CLAIM|25|一致|docs/adr/0175-cheaper-code-review-rounds.md:68|0175 的其余内容（低严重度修改用 `--accept-low` 记账）继续有效|5. **低严重度的修改用 `--accept-low` 记进账本，不再复核。**
CLAIM|26|一致|docs/adr/0175-cheaper-code-review-rounds.md:62|0175 的其余内容（DeepSeek 的固定侧重）继续有效|DeepSeek 的固定侧重加上“规则文件、说明文档和代码是否一致”，原来这项是 GLM 先查的；
CLAIM|27|不一致|scripts/model-review/opencode-review.mjs:2815|脚本第 1 轮会拒绝|models: DEFAULT_REVIEW_MODELS,
CLAIM|28|不一致|scripts/model-review/opencode-review.mjs:1342|合并前检查也不认单模型的第 1 轮|if (point.by !== "low-fix" && point.previous === null) {
CLAIM|29|一致|scripts/model-review/gateway.json:7|那份文件管的是经 Magpie（本机模型网关）时用哪些服务方|"providers": [
CLAIM|30|一致|scripts/model-review/opencode-review.mjs:3171|直连 OpenCode 时不读它|const gatewayConfig = options.gateway ? readGatewayConfig(undefined, REVIEW_MODELS) : null;
CLAIM|31|一致|scripts/model-review/opencode-review.mjs:986|替补只在 DeepSeek 的服务报错、重跑仍不行时发生|if (!run.review.summary.apiError?.retryable) return null;
CLAIM|32|一致|scripts/model-review/opencode-review.mjs:1301|旧账本仍然能读：两个模型都通过的旧轮次按“要跑的模型都通过”算数|const needed = complete(requested) ? requested : complete(DEFAULT_REVIEW_MODELS) ? DEFAULT_REVIEW_MODELS : [];
CLAIM|33|一致|scripts/model-review/opencode-review.mjs:1303|现在算（默认模型通过）|: complete(DEFAULT_REVIEW_MODELS)
CLAIM|34|一致|scripts/model-review/opencode-review.mjs:1301|在 DeepSeek 失败的同一轮里手工补跑 GLM（没有替补记录）仍然不算数|const needed = complete(requested) ? requested : complete(DEFAULT_REVIEW_MODELS) ? DEFAULT_REVIEW_MODELS : [];
CLAIM|35|一致|.agents/instructions/model-review.md:1|.agents/instructions/model-review.md：方案讨论和代码复核的步骤|# 和 OpenCode 协作：方案讨论和代码复核
CLAIM|36|一致|docs/adr/0175-cheaper-code-review-rounds.md:12|ADR 0175：代码复核第 2 轮起只用 DeepSeek|# ADR 0175：代码复核第 2 轮起只用 DeepSeek，低严重度意见不再触发下一轮
CLAIM|37|一致|scripts/model-review/review-models.json:2|scripts/model-review/review-models.json、scripts/model-review/opencode-review.mjs、test/tooling/opencode-review.test.mjs、test/tooling/opencode-review-merge-gate.test.mjs、test/tooling/review-delegate.test.mjs：配置、实现和测试（配置部分）|"allowed": ["opencode-go/deepseek-v4.1-flash", "opencode-go/glm-5.3-flash"],
CLAIM|38|一致|scripts/model-review/opencode-review.mjs:1|scripts/model-review/review-models.json、scripts/model-review/opencode-review.mjs、test/tooling/opencode-review.test.mjs、test/tooling/opencode-review-merge-gate.test.mjs、test/tooling/review-delegate.test.mjs：配置、实现和测试（实现部分）|#!/usr/bin/env node
CLAIM|39|一致|test/tooling/opencode-review.test.mjs:1|scripts/model-review/review-models.json、scripts/model-review/opencode-review.mjs、test/tooling/opencode-review.test.mjs、test/tooling/opencode-review-merge-gate.test.mjs、test/tooling/review-delegate.test.mjs：配置、实现和测试（测试部分）|import { execFileSync, spawn, spawnSync } from "node:child_process";
CLAIM|40|一致|test/tooling/opencode-review-merge-gate.test.mjs:1|scripts/model-review/review-models.json、scripts/model-review/opencode-review.mjs、test/tooling/opencode-review.test.mjs、test/tooling/opencode-review-merge-gate.test.mjs、test/tooling/review-delegate.test.mjs：配置、实现和测试（测试部分）|import { execFileSync, spawnSync } from "node:child_process";
CLAIM|41|一致|test/tooling/review-delegate.test.mjs:1|scripts/model-review/review-models.json、scripts/model-review/opencode-review.mjs、test/tooling/opencode-review.test.mjs、test/tooling/opencode-review-merge-gate.test.mjs、test/tooling/review-delegate.test.mjs：配置、实现和测试（测试部分）|import { execFileSync, spawnSync } from "node:child_process";
CLAIM|42|一致|docs/product-vision.md:55|依据的是“用户主权”（产品愿景里排第一的原则）|*原则冲突时，按序优先：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。*

未核实：项目指令第 17 条的原文不在仓库里，只能依据仓库内 `model-review.md` 的转述；“原来只对第 2 轮起生效”“过去……不算完整复核”等纯历史表述没有按当前文件判。上述标为“不一致”的旧行为说法，是因为 b89ad20 已包含实现、当前文件里已不存在这些行为。
