CLAIM|1|一致|AGENTS.md:49|线程在写代码前请模型讨论方案、在合并 PR 前请模型复核代码，都用 `scripts/model-review/opencode-review.mjs`|一律用 `node scripts/model-review/opencode-review.mjs` 跑，不自己拼 `opencode run` 命令。
CLAIM|2|一致|docs/adr/0175-cheaper-code-review-rounds.md:62|本 ADR 之前的规则写在 ADR 0175 里，原话是：“代码复核第 1 轮两个模型都跑，之后默认只跑 DeepSeek。第 1 轮只给一个模型时脚本拒绝”|2. **代码复核第 1 轮两个模型都跑，之后默认只跑 DeepSeek。** 第 1 轮只给一个模型时脚本拒绝（用 `--round` 把失败的那个模型补跑进原来那一轮的除外）。
CLAIM|3|一致|docs/adr/0175-cheaper-code-review-rounds.md:63|复核链的“起点是最后一轮不带 `--previous`、两个模型都通过的复核”|起点是最后一轮不带 `--previous`、两个模型都通过的复核；
CLAIM|4|一致|docs/adr/0175-cheaper-code-review-rounds.md:70|方案讨论“仍然两个模型都跑”|方案讨论（`--mode plan`、`--mode plan-review`）不在这次改动的范围里，仍然两个模型都跑；
CLAIM|5|一致|docs/adr/0175-cheaper-code-review-rounds.md:30|两个模型指 DeepSeek V4.1 Flash 和 GLM 5.3 Flash|两个模型是 `opencode-go/deepseek-v4.1-flash` 和 `opencode-go/glm-5.3-flash`，推理强度都设为高；
CLAIM|6|一致|scripts/model-review/review-models.json:3|不写 `--models` 时都只跑默认模型，现在是 `opencode-go/deepseek-v4.1-flash`|  "default": ["opencode-go/deepseek-v4.1-flash"],
CLAIM|7|一致|scripts/model-review/review-models.json:2|`scripts/model-review/review-models.json` 有三项：`allowed`、`default`、`substitutes`|  "allowed": ["opencode-go/deepseek-v4.1-flash", "opencode-go/glm-5.3-flash"],
CLAIM|8|一致|scripts/model-review/review-models.json:2|`allowed`（能用的模型，仍然只有……两个）|  "allowed": ["opencode-go/deepseek-v4.1-flash", "opencode-go/glm-5.3-flash"],
CLAIM|9|找不到|-|`allowed`（能用的模型，仍然只有项目指令第 17 条允许的两个）|-|
CLAIM|10|一致|scripts/model-review/opencode-review.mjs:2815|`default`（不写 `--models` 时跑哪些）|    models: DEFAULT_REVIEW_MODELS,
CLAIM|11|一致|scripts/model-review/opencode-review.mjs:974|`substitutes`（哪个模型的服务用不了时由谁替补）|export const SUBSTITUTES = reviewModels.substitutes;
CLAIM|12|一致|scripts/model-review/opencode-review.mjs:95|脚本启动时读它并校验|const reviewModels = readReviewModels();
CLAIM|13|一致|scripts/model-review/opencode-review.mjs:61|`allowed` 和 `default` 不能为空|    list.length > 0 &&
CLAIM|14|一致|scripts/model-review/opencode-review.mjs:63|`allowed` 和 `default` 不能重复|    new Set(list).size === list.length;
CLAIM|15|一致|scripts/model-review/opencode-review.mjs:68|`default` 里的模型必须在 `allowed` 里|  if (!names(config?.default) || config.default.some((name) => !allowed.includes(name)))
CLAIM|16|一致|scripts/model-review/opencode-review.mjs:76|`substitutes` 里的模型都必须在 `allowed` 里|      ([from, to]) => !allowed.includes(from) || !allowed.includes(to) || from === to,
CLAIM|17|一致|scripts/model-review/opencode-review.mjs:70|`substitutes` 可以为空|  const substitutes = config?.substitutes;
CLAIM|18|一致|scripts/model-review/opencode-review.mjs:91|不合格以 `REVIEW_MODELS_CONFIG_INVALID` 停下|  if (problems.length > 0) throw new Error(`REVIEW_MODELS_CONFIG_INVALID ${problems.join(",")}`);
CLAIM|19|一致|scripts/model-review/opencode-review.mjs:333|往 `allowed` 加模型还要在脚本里补它的固定侧重|    "你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。",
CLAIM|20|一致|scripts/model-review/opencode-review.mjs:101|往 `allowed` 加模型还要在脚本里补它的输出上限|export const MODEL_OUTPUT_LIMITS = { "deepseek-v4.1-flash": 384000, "glm-5.3-flash": 131072 };
CLAIM|21|一致|scripts/model-review/gateway.json:17|在 `gateway.json` 里补条目|  "models": {
CLAIM|22|一致|scripts/model-review/opencode-review.mjs:1357|之后每一点的提交必须是前一点的后续提交|      !isAncestor(covered, point.head)
CLAIM|23|一致|scripts/model-review/opencode-review.mjs:1356|带 `--previous` 的一轮的 `previous` 不晚于前一点的提交|      !isAncestor(point.previous, covered) ||
CLAIM|24|一致|scripts/model-review/opencode-review.mjs:1383|最后一点之后只许改记录目录|  return result.stdout.split("\0").filter((file) => file && !file.startsWith(`${ledgerPath}/`));
CLAIM|25|一致|scripts/model-review/opencode-review.mjs:981|只跑一个模型的代码复核里，DeepSeek 重跑后仍是可以重试的服务报错时由 GLM 替补|  if (mode !== "code-review" || models.length !== 1) return null;
CLAIM|26|一致|docs/adr/0175-cheaper-code-review-rounds.md:62|原来只对第 2 轮起生效|第 2 轮起 DeepSeek 重跑后仍是可以重试的服务报错时，由 GLM 替补这一轮，账本记 `substitute: true`。
CLAIM|27|一致|scripts/model-review/review-models.json:5|替补只在 DeepSeek 的服务用不了时发生|    "opencode-go/deepseek-v4.1-flash": "opencode-go/glm-5.3-flash"
CLAIM|28|一致|scripts/model-review/opencode-review.mjs:3406|账本照旧记 `substitute: true`|          substitute: true,
CLAIM|29|一致|docs/adr/0175-cheaper-code-review-rounds.md:8|本 ADR 部分修正（amend）ADR 0175，不整份替代|amended_by: "docs/adr/0255-review-models-default-to-deepseek.md"
CLAIM|30|一致|docs/adr/0175-cheaper-code-review-rounds.md:62|0175 第 2 条“代码复核第 1 轮两个模型都跑”“第 1 轮只给一个模型时脚本拒绝”“第 2 轮起……由 GLM 替补”|2. **代码复核第 1 轮两个模型都跑，之后默认只跑 DeepSeek。** 第 1 轮只给一个模型时脚本拒绝（用 `--round` 把失败的那个模型补跑进原来那一轮的除外）。DeepSeek 的固定侧重加上“规则文件、说明文档和代码是否一致”，原来这项是 GLM 先查的；这句第 1 轮起每轮都带，所以 DeepSeek 的提示词开头每轮逐字节相同，仍能命中服务端对相同开头的缓存。第 2 轮起 DeepSeek 重跑后仍是可以重试的服务报错时，由 GLM 替补这一轮，账本记 `substitute: true`。
CLAIM|31|一致|docs/adr/0175-cheaper-code-review-rounds.md:63|0175 第 3 条里“起点是最后一轮不带 `--previous`、两个模型都通过的复核”|起点是最后一轮不带 `--previous`、两个模型都通过的复核；
CLAIM|32|一致|docs/adr/0175-cheaper-code-review-rounds.md:70|0175“方案讨论……仍然两个模型都跑”|方案讨论（`--mode plan`、`--mode plan-review`）不在这次改动的范围里，仍然两个模型都跑；
CLAIM|33|一致|docs/adr/0175-cheaper-code-review-rounds.md:93|0175“比较过的方案”里没有采用的“每轮都只用一个模型，包括第 1 轮”|- **每轮都只用一个模型，包括第 1 轮。** 不采用：第 1 轮看的是整个 PR，两个模型侧重不同，GLM 常能找到 DeepSeek 漏掉的测试和文档问题。
CLAIM|34|一致|docs/adr/0175-cheaper-code-review-rounds.md:61|0175 的其余内容有“认出服务报错并重跑”|1. **认出服务报错。** opencode 输出 `type: "error"` 事件时，账本的 `outcome` 记 `api-error`，并记下状态码和错误信息。
CLAIM|35|一致|docs/adr/0175-cheaper-code-review-rounds.md:64|0175 的其余内容有“意见分严重度”|4. **“会出错”的意见分中、高和低两档，只有中、高的才触发下一轮。** 分界线：
CLAIM|36|一致|docs/adr/0175-cheaper-code-review-rounds.md:68|0175 的其余内容有“低严重度修改用 `--accept-low` 记账”|5. **低严重度的修改用 `--accept-low` 记进账本，不再复核。** 线程把逐条判断写进机器能读的 `round-<n>/verdicts.jsonl`，修改和补的测试提交后运行 `--assert-reviewed --accept-low <轮次>`。
CLAIM|37|一致|docs/adr/0175-cheaper-code-review-rounds.md:62|0175 的其余内容有“DeepSeek 的固定侧重”|DeepSeek 的固定侧重加上“规则文件、说明文档和代码是否一致”，原来这项是 GLM 先查的；
CLAIM|38|一致|scripts/model-review/gateway.json:7|`gateway.json` 管的是经 Magpie 时用哪些服务方|  "providers": [
CLAIM|39|一致|scripts/model-review/opencode-review.mjs:3171|直连 OpenCode 时不读 `gateway.json`|  const gatewayConfig = options.gateway ? readGatewayConfig(undefined, REVIEW_MODELS) : null;
CLAIM|40|一致|scripts/model-review/opencode-review.mjs:986|替补只在 DeepSeek 的服务报错、重跑仍不行时发生|  if (!run.review.summary.apiError?.retryable) return null;
CLAIM|41|一致|docs/adr/0175-cheaper-code-review-rounds.md:93|0175 记过 GLM 在第 1 轮常能补到测试和文档问题|- **每轮都只用一个模型，包括第 1 轮。** 不采用：第 1 轮看的是整个 PR，两个模型侧重不同，GLM 常能找到 DeepSeek 漏掉的测试和文档问题。
CLAIM|42|一致|scripts/model-review/opencode-review.mjs:333|DeepSeek 的固定侧重已包含“规则文件、说明文档和代码是否一致”|    "你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。",
CLAIM|43|一致|scripts/model-review/opencode-review.mjs:1300|旧账本仍然能读：两个模型都通过的旧轮次按“要跑的模型都通过”算数|      models.length > 0 && models.every((model) => direct(model) || stoodIn(model));
CLAIM|44|一致|scripts/model-review/opencode-review.mjs:1303|过去“第 1 轮两个模型里 GLM 失败、DeepSeek 通过”不算完整复核，现在算（默认模型通过）|      : complete(DEFAULT_REVIEW_MODELS)
CLAIM|45|一致|scripts/model-review/opencode-review.mjs:1294|在 DeepSeek 失败的同一轮里手工补跑 GLM（没有替补记录）仍然不算数|            (record) => record.substitute === undefined && REVIEW_MODELS.includes(record.model),
CLAIM|46|一致|.agents/instructions/model-review.md:2|`.agents/instructions/model-review.md`：方案讨论和代码复核的步骤|# 和 OpenCode 协作：方案讨论和代码复核
CLAIM|47|一致|docs/adr/0175-cheaper-code-review-rounds.md:12|ADR 0175：代码复核第 2 轮起只用 DeepSeek|# ADR 0175：代码复核第 2 轮起只用 DeepSeek，低严重度意见不再触发下一轮
CLAIM|48|一致|scripts/model-review/opencode-review.mjs:90|配置……由 `opencode-review.mjs` 里的 `readReviewModels` 读入、`reviewModelsProblems` 校验|  const problems = reviewModelsProblems(config);
CLAIM|49|一致|docs/product-vision.md:55|依据的是“用户主权”（产品愿景里排第一的原则）|*原则冲突时，按序优先：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。*

只有“项目指令第 17 条”这一来源没能在仓库里核对到：仓库内的 `AGENTS.md` 等指令文件没有编号第 17 条，无法证明这两个模型出自该条；其余引用的仓库文件和代码均已亲自读到。
