CLAIM|1|一致|AGENTS.md:49|线程在写代码前请模型讨论方案、在合并 PR 前请模型复核代码，都用 `scripts/model-review/opencode-review.mjs`|下面两个时机都要请 OpenCode（一个能让模型读代码、调用工具的命令行程序）上的模型看：默认只用 `opencode-go/deepseek-v4.1-flash`，方案讨论和代码复核的每一轮都是这样（Andy 2026-11-12 定，[ADR 0259](docs/adr/0259-review-models-default-to-deepseek.md)）；只有 Andy 特别指明时才加上 `opencode-go/glm-5.3-flash`（`--models deepseek-v4.1-flash,glm-5.3-flash`）。默认跑哪些模型写在 `scripts/model-review/review-models.json`，不写死在脚本里。一律用 `node scripts/model-review/opencode-review.mjs` 跑，不自己拼 `opencode run` 命令。
CLAIM|2|一致|AGENTS.md:49|它经 OpenCode（一个能让模型读代码、调用工具的命令行程序）调用模型|下面两个时机都要请 OpenCode（一个能让模型读代码、调用工具的命令行程序）上的模型看：默认只用 `opencode-go/deepseek-v4.1-flash`
CLAIM|3|一致|docs/adr/0175-cheaper-code-review-rounds.md:12|本 ADR 之前的规则写在 [ADR 0175](0175-cheaper-code-review-rounds.md) 里|# ADR 0175：代码复核第 2 轮起只用 DeepSeek，低严重度意见不再触发下一轮
CLAIM|4|一致|docs/adr/0175-cheaper-code-review-rounds.md:62|“代码复核第 1 轮两个模型都跑，之后默认只跑 DeepSeek。|**代码复核第 1 轮两个模型都跑，之后默认只跑 DeepSeek。**
CLAIM|5|一致|docs/adr/0175-cheaper-code-review-rounds.md:62|第 1 轮只给一个模型时脚本拒绝|第 1 轮只给一个模型时脚本拒绝（用 `--round` 把失败的那个模型补跑进原来那一轮的除外）。
CLAIM|6|一致|docs/adr/0175-cheaper-code-review-rounds.md:63|复核链的“起点是最后一轮不带 `--previous`、两个模型都通过的复核”|起点是最后一轮不带 `--previous`、两个模型都通过的复核；
CLAIM|7|一致|docs/adr/0175-cheaper-code-review-rounds.md:70|方案讨论“仍然两个模型都跑”|方案讨论（`--mode plan`、`--mode plan-review`）不在这次改动的范围里，仍然两个模型都跑；
CLAIM|8|一致|docs/adr/0175-cheaper-code-review-rounds.md:30|两个模型指 DeepSeek V4.1 Flash 和 GLM 5.3 Flash。|两个模型是 `opencode-go/deepseek-v4.1-flash` 和 `opencode-go/glm-5.3-flash`
CLAIM|9|一致|scripts/model-review/opencode-review.mjs:2815|不写 `--models` 时都只跑默认模型|    models: DEFAULT_REVIEW_MODELS,
CLAIM|10|一致|scripts/model-review/review-models.json:3|现在是 `opencode-go/deepseek-v4.1-flash`|  "default": ["opencode-go/deepseek-v4.1-flash"],
CLAIM|11|一致|scripts/model-review/review-models.json:2|`scripts/model-review/review-models.json` 有三项：`allowed`|  "allowed": ["opencode-go/deepseek-v4.1-flash", "opencode-go/glm-5.3-flash"],
CLAIM|12|一致|scripts/model-review/review-models.json:3|有三项：`allowed`、`default`|  "default": ["opencode-go/deepseek-v4.1-flash"],
CLAIM|13|一致|scripts/model-review/review-models.json:4|有三项：`allowed`、`default`、`substitutes`|  "substitutes": {
CLAIM|14|一致|scripts/model-review/review-models.json:2|`allowed`（能用的模型，仍然只有项目指令第 17 条允许的两个）|  "allowed": ["opencode-go/deepseek-v4.1-flash", "opencode-go/glm-5.3-flash"],
CLAIM|15|找不到|-|仍然只有项目指令第 17 条允许的两个|-
CLAIM|16|一致|scripts/model-review/opencode-review.mjs:982|`substitutes`（哪个模型的服务用不了时由谁替补）|  const replacement = SUBSTITUTES[models[0]];
CLAIM|17|一致|scripts/model-review/opencode-review.mjs:95|脚本启动时读它|const reviewModels = readReviewModels();
CLAIM|18|一致|scripts/model-review/opencode-review.mjs:61|`allowed` 和 `default` 不能为空|    list.length > 0 &&
CLAIM|19|一致|scripts/model-review/opencode-review.mjs:63|`allowed` 和 `default` 不能重复|    new Set(list).size === list.length;
CLAIM|20|一致|test/tooling/opencode-review.test.mjs:541|`default` 和 `substitutes` 里的模型都必须在 `allowed` 里|      [{ ...valid, default: ["a/three"] }, "default"],
CLAIM|21|一致|test/tooling/opencode-review.test.mjs:543|`default` 和 `substitutes` 里的模型都必须在 `allowed` 里|      [{ ...valid, substitutes: { "a/one": "a/three" } }, "substitutes"],
CLAIM|22|一致|test/tooling/opencode-review.test.mjs:531|`substitutes` 可以为空|    expect(reviewModelsProblems({ ...valid, default: valid.allowed, substitutes: {} })).toEqual([]);
CLAIM|23|一致|scripts/model-review/opencode-review.mjs:91|不合格以 `REVIEW_MODELS_CONFIG_INVALID` 停下|  if (problems.length > 0) throw new Error(`REVIEW_MODELS_CONFIG_INVALID ${problems.join(",")}`);
CLAIM|24|一致|test/tooling/opencode-review.test.mjs:526|往 `allowed` 加模型还要在脚本里补它的固定侧重|      expect(MODEL_LENSES[name]).toEqual(expect.any(String));
CLAIM|25|一致|test/tooling/opencode-review.test.mjs:527|往 `allowed` 加模型还要在脚本里补它的输出上限|      expect(MODEL_OUTPUT_LIMITS[name]).toEqual(expect.any(Number));
CLAIM|26|一致|test/tooling/opencode-review.test.mjs:528|在 `gateway.json` 里补条目|      expect(readGatewayConfig(undefined, REVIEW_MODELS).models[model]).toBeDefined();
CLAIM|27|找不到|-|并且先改项目指令第 17 条|-
CLAIM|28|一致|scripts/model-review/opencode-review.mjs:1357|之后每一点的提交必须是前一点的后续提交|      !isAncestor(covered, point.head)
CLAIM|29|一致|scripts/model-review/opencode-review.mjs:1356|带 `--previous` 的一轮的 `previous` 不晚于前一点的提交|      !isAncestor(point.previous, covered) ||
CLAIM|30|一致|scripts/model-review/opencode-review.mjs:1383|最后一点之后只许改记录目录|  return result.stdout.split("\0").filter((file) => file && !file.startsWith(`${ledgerPath}/`));
CLAIM|31|一致|docs/adr/0175-cheaper-code-review-rounds.md:62|原来只对第 2 轮起生效|第 2 轮起 DeepSeek 重跑后仍是可以重试的服务报错时，由 GLM 替补这一轮，账本记 `substitute: true`。
CLAIM|32|一致|.agents/instructions/model-review.md:60|替补只在 DeepSeek 的服务用不了时发生|DeepSeek 遇到服务报错（账本 `outcome` 记 `api-error`）时，opencode 自己会先按服务给的间隔连试 5 次；还不行，脚本等 60 秒、在同一个 0.2 美元上限里整轮重跑一次；重跑后仍是可以重试的服务报错（“可以重试”指 opencode 给错误标了 `isRetryable`，或响应带数字形式的 `retry-after`、`retry-after-ms`；钱或时间不够、脚本没重跑的不算），就让 GLM 跑这一轮
CLAIM|33|一致|scripts/model-review/opencode-review.mjs:3406|账本照旧记 `substitute: true`|          substitute: true,
CLAIM|34|一致|docs/product-vision.md:55|依据的是“用户主权”（[产品愿景](../product-vision.md)里排第一的原则）|*原则冲突时，按序优先：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。*
CLAIM|35|一致|scripts/model-review/opencode-review.mjs:1503|每个 PR 的全部改动仍要被至少一个模型完整看过|    outsideFiles = unreviewed(complete.head, head);
CLAIM|36|一致|docs/adr/0175-cheaper-code-review-rounds.md:62|0175 第 2 条“代码复核第 1 轮两个模型都跑”|**代码复核第 1 轮两个模型都跑，之后默认只跑 DeepSeek。**
CLAIM|37|一致|docs/adr/0175-cheaper-code-review-rounds.md:62|0175 第 2 条“第 1 轮只给一个模型时脚本拒绝”|第 1 轮只给一个模型时脚本拒绝（用 `--round` 把失败的那个模型补跑进原来那一轮的除外）。
CLAIM|38|一致|docs/adr/0175-cheaper-code-review-rounds.md:62|0175 第 2 条“第 2 轮起……由 GLM 替补”|第 2 轮起 DeepSeek 重跑后仍是可以重试的服务报错时，由 GLM 替补这一轮，账本记 `substitute: true`。
CLAIM|39|一致|docs/adr/0175-cheaper-code-review-rounds.md:63|0175 第 3 条里“起点是最后一轮不带 `--previous`、两个模型都通过的复核”|起点是最后一轮不带 `--previous`、两个模型都通过的复核；
CLAIM|40|一致|docs/adr/0175-cheaper-code-review-rounds.md:70|0175“方案讨论……仍然两个模型都跑”|方案讨论（`--mode plan`、`--mode plan-review`）不在这次改动的范围里，仍然两个模型都跑；
CLAIM|41|一致|docs/adr/0175-cheaper-code-review-rounds.md:93|0175“比较过的方案”里没有采用的“每轮都只用一个模型，包括第 1 轮”|- **每轮都只用一个模型，包括第 1 轮。** 不采用：第 1 轮看的是整个 PR，两个模型侧重不同，GLM 常能找到 DeepSeek 漏掉的测试和文档问题。
CLAIM|42|一致|docs/adr/0175-cheaper-code-review-rounds.md:93|当时记下的代价（GLM 常能找到 DeepSeek 漏掉的测试和文档问题）仍然成立|- **每轮都只用一个模型，包括第 1 轮。** 不采用：第 1 轮看的是整个 PR，两个模型侧重不同，GLM 常能找到 DeepSeek 漏掉的测试和文档问题。
CLAIM|43|一致|docs/adr/0175-cheaper-code-review-rounds.md:61|0175 的其余内容（认出服务报错并重跑）继续有效|服务说可以重试的（opencode 给错误标了 `isRetryable`，或响应带数字形式的 `retry-after`、`retry-after-ms`），脚本等 60 秒再整轮重跑一次，费用算在同一个 0.2 美元上限里。
CLAIM|44|一致|docs/adr/0175-cheaper-code-review-rounds.md:64|0175 的其余内容（意见分严重度）继续有效|4. **“会出错”的意见分中、高和低两档，只有中、高的才触发下一轮。**
CLAIM|45|一致|docs/adr/0175-cheaper-code-review-rounds.md:68|0175 的其余内容（低严重度修改用 `--accept-low` 记账）继续有效|5. **低严重度的修改用 `--accept-low` 记进账本，不再复核。**
CLAIM|46|一致|docs/adr/0175-cheaper-code-review-rounds.md:62|0175 的其余内容（DeepSeek 的固定侧重）继续有效|DeepSeek 的固定侧重加上“规则文件、说明文档和代码是否一致”，原来这项是 GLM 先查的；
CLAIM|47|一致|docs/adr/0175-cheaper-code-review-rounds.md:62|ADR 0175 定的脚本行为是第 1 轮只给一个模型就拒绝|第 1 轮只给一个模型时脚本拒绝（用 `--round` 把失败的那个模型补跑进原来那一轮的除外）。
CLAIM|48|一致|docs/adr/0175-cheaper-code-review-rounds.md:63|复核链起点要两个模型都通过|起点是最后一轮不带 `--previous`、两个模型都通过的复核；
CLAIM|49|一致|scripts/model-review/opencode-review.mjs:3171|那份文件管的是经 Magpie（本机模型网关）时用哪些服务方|  const gatewayConfig = options.gateway ? readGatewayConfig(undefined, REVIEW_MODELS) : null;
CLAIM|50|一致|scripts/model-review/opencode-review.mjs:3171|直连 OpenCode 时不读它|  const gatewayConfig = options.gateway ? readGatewayConfig(undefined, REVIEW_MODELS) : null;
CLAIM|51|一致|.agents/instructions/model-review.md:60|替补只在 DeepSeek 的服务报错、重跑仍不行时发生|重跑后仍是可以重试的服务报错（“可以重试”指 opencode 给错误标了 `isRetryable`，或响应带数字形式的 `retry-after`、`retry-after-ms`；钱或时间不够、脚本没重跑的不算），就让 GLM 跑这一轮
CLAIM|52|一致|docs/adr/0175-cheaper-code-review-rounds.md:93|0175 记过 GLM 在第 1 轮常能补到测试和文档问题|- **每轮都只用一个模型，包括第 1 轮。** 不采用：第 1 轮看的是整个 PR，两个模型侧重不同，GLM 常能找到 DeepSeek 漏掉的测试和文档问题。
CLAIM|53|一致|scripts/model-review/opencode-review.mjs:333|DeepSeek 的固定侧重（已包含“规则文件、说明文档和代码是否一致”）|  "deepseek-v4.1-flash": "你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。",
CLAIM|54|一致|scripts/model-review/opencode-review.mjs:1742|旧账本仍然能读|        record?.round === undefined || (Number.isSafeInteger(record.round) && record.round > 0);
CLAIM|55|一致|scripts/model-review/opencode-review.mjs:1301|两个模型都通过的旧轮次按“要跑的模型都通过”算数|    const needed = complete(requested)
CLAIM|56|一致|docs/adr/0175-cheaper-code-review-rounds.md:63|过去“第 1 轮两个模型里 GLM 失败、DeepSeek 通过”不算完整复核|起点是最后一轮不带 `--previous`、两个模型都通过的复核；
CLAIM|57|一致|scripts/model-review/opencode-review.mjs:1303|现在算（默认模型通过）|      : complete(DEFAULT_REVIEW_MODELS)
CLAIM|58|一致|.agents/instructions/model-review.md:60|在 DeepSeek 失败的同一轮里手工补跑 GLM（没有替补记录）仍然不算数，和以前一样|在 DeepSeek 失败的那一轮里用 `--round <这一轮> --models glm-5.3-flash` 手工补跑的 GLM 没有替补记录，合并前检查不认这一轮，不要这样跑。
CLAIM|59|一致|.agents/instructions/model-review.md:2|`.agents/instructions/model-review.md`：方案讨论和代码复核的步骤。|# 和 OpenCode 协作：方案讨论和代码复核
CLAIM|60|一致|docs/adr/0175-cheaper-code-review-rounds.md:12|ADR 0175：代码复核第 2 轮起只用 DeepSeek。|# ADR 0175：代码复核第 2 轮起只用 DeepSeek，低严重度意见不再触发下一轮
CLAIM|61|一致|scripts/model-review/review-models.json:1|配置在 `scripts/model-review/review-models.json`|{
CLAIM|62|一致|scripts/model-review/opencode-review.mjs:83|由 `scripts/model-review/opencode-review.mjs` 里的 `readReviewModels` 读入|export function readReviewModels(path = REVIEW_MODELS_CONFIG_PATH) {
CLAIM|63|一致|scripts/model-review/opencode-review.mjs:90|由 `scripts/model-review/opencode-review.mjs` 里的 `reviewModelsProblems` 校验|  const problems = reviewModelsProblems(config);

项目指令第 17 条在仓库里找不到对应的编号条款（`AGENTS.md` 和 `.agents/instructions/` 中都没有第 17 条列模型），相关两处按「找不到」；Andy 的原话和外部产品说法不属于代码或仓库文档现状，未核对。
