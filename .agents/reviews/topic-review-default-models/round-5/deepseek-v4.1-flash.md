CLAIM|1|一致|scripts/model-review/opencode-review.mjs:102|线程在写代码前请模型讨论方案、在合并 PR 前请模型复核代码，都用 `scripts/model-review/opencode-review.mjs`|export const MODES = ["code-review", "plan", "plan-review", "plan-claims"];
CLAIM|2|一致|docs/adr/0175-cheaper-code-review-rounds.md:62|本 ADR 之前的规则写在 ADR 0175 里|代码复核第 1 轮两个模型都跑，之后默认只跑 DeepSeek。
CLAIM|3|一致|docs/adr/0175-cheaper-code-review-rounds.md:62|代码复核第 1 轮两个模型都跑|代码复核第 1 轮两个模型都跑，之后默认只跑 DeepSeek。
CLAIM|4|一致|docs/adr/0175-cheaper-code-review-rounds.md:62|之后默认只跑 DeepSeek|代码复核第 1 轮两个模型都跑，之后默认只跑 DeepSeek。
CLAIM|5|一致|docs/adr/0175-cheaper-code-review-rounds.md:62|第 1 轮只给一个模型时脚本拒绝|第 1 轮只给一个模型时脚本拒绝（用 `--round` 把失败的那个模型补跑进原来那一轮的除外）。
CLAIM|6|一致|docs/adr/0175-cheaper-code-review-rounds.md:63|复核链的“起点是最后一轮不带 `--previous`、两个模型都通过的复核”|起点是最后一轮不带 `--previous`、两个模型都通过的复核；
CLAIM|7|一致|docs/adr/0175-cheaper-code-review-rounds.md:70|方案讨论“仍然两个模型都跑”|方案讨论（`--mode plan`、`--mode plan-review`）不在这次改动的范围里，仍然两个模型都跑；
CLAIM|8|一致|docs/adr/0175-cheaper-code-review-rounds.md:30|两个模型指 DeepSeek V4.1 Flash 和 GLM 5.3 Flash|两个模型是 `opencode-go/deepseek-v4.1-flash` 和 `opencode-go/glm-5.3-flash`，推理强度都设为高；
CLAIM|9|一致|scripts/model-review/opencode-review.mjs:2819|方案讨论、核对代码说法和代码复核的每一轮（包括第 1 轮），不写 `--models` 时都只跑默认模型|models: DEFAULT_REVIEW_MODELS,
CLAIM|10|一致|scripts/model-review/review-models.json:3|现在是 `opencode-go/deepseek-v4.1-flash`|"default": ["opencode-go/deepseek-v4.1-flash"],
CLAIM|11|一致|scripts/model-review/opencode-review.mjs:2878|Andy 特别指明时，用 `--models deepseek-v4.1-flash,glm-5.3-flash` 让两个模型都跑|REVIEW_MODELS.find((model) => name && (model === name || model.endsWith(`/${name}`))),
CLAIM|12|一致|scripts/model-review/review-models.json:2|`scripts/model-review/review-models.json` 有三项：`allowed`|"allowed": ["opencode-go/deepseek-v4.1-flash", "opencode-go/glm-5.3-flash"],
CLAIM|13|一致|scripts/model-review/review-models.json:3|`scripts/model-review/review-models.json` 有三项：`default`|"default": ["opencode-go/deepseek-v4.1-flash"],
CLAIM|14|一致|scripts/model-review/review-models.json:4|`scripts/model-review/review-models.json` 有三项：`substitutes`|"substitutes": {
CLAIM|15|一致|scripts/model-review/review-models.json:2|`allowed`（能用的模型，仍然只有项目指令第 17 条允许的两个）中的“只有……两个”|"allowed": ["opencode-go/deepseek-v4.1-flash", "opencode-go/glm-5.3-flash"],
CLAIM|16|找不到|-|`allowed`（能用的模型，仍然只有项目指令第 17 条允许的两个）中的“项目指令第 17 条允许”|-
CLAIM|17|一致|scripts/model-review/opencode-review.mjs:97|`default`（不写 `--models` 时跑哪些）|export const DEFAULT_REVIEW_MODELS = reviewModels.default;
CLAIM|18|一致|scripts/model-review/review-models.json:5|`substitutes`（哪个模型的服务用不了时由谁替补）|"opencode-go/deepseek-v4.1-flash": "opencode-go/glm-5.3-flash"
CLAIM|19|一致|scripts/model-review/opencode-review.mjs:95|脚本启动时读它|const reviewModels = readReviewModels();
CLAIM|20|一致|scripts/model-review/opencode-review.mjs:61|`allowed` 和 `default` 不能为空|list.length > 0 &&
CLAIM|21|一致|scripts/model-review/opencode-review.mjs:63|`allowed` 和 `default` 不能……重复|new Set(list).size === list.length;
CLAIM|22|一致|scripts/model-review/opencode-review.mjs:68|`default`……里的模型都必须在 `allowed` 里|if (!names(config?.default) || config.default.some((name) => !allowed.includes(name)))
CLAIM|23|一致|scripts/model-review/opencode-review.mjs:76|`substitutes` 里的模型都必须在 `allowed` 里|([from, to]) => !allowed.includes(from) || !allowed.includes(to) || from === to,
CLAIM|24|一致|scripts/model-review/opencode-review.mjs:75|`substitutes` 可以为空|Object.entries(substitutes).some(
CLAIM|25|一致|scripts/model-review/opencode-review.mjs:91|不合格以 `REVIEW_MODELS_CONFIG_INVALID` 停下|if (problems.length > 0) throw new Error(`REVIEW_MODELS_CONFIG_INVALID ${problems.join(",")}`);
CLAIM|26|一致|test/tooling/opencode-review.test.mjs:524|测试里按现在的默认值写的断言要一起改|expect(DEFAULT_REVIEW_MODELS).toEqual(["opencode-go/deepseek-v4.1-flash"]);
CLAIM|27|一致|test/tooling/opencode-review.test.mjs:527|往 `allowed` 加模型还要在脚本里补它的固定侧重|expect(MODEL_LENSES[name]).toEqual(expect.any(String));
CLAIM|28|一致|test/tooling/opencode-review.test.mjs:528|往 `allowed` 加模型还要在脚本里补它的……输出上限|expect(MODEL_OUTPUT_LIMITS[name]).toEqual(expect.any(Number));
CLAIM|29|一致|scripts/model-review/opencode-review.mjs:187|往 `allowed` 加模型……在 `gateway.json` 里补条目|if (!entry) throw new Error(`GATEWAY_MODEL_UNKNOWN ${model}`);
CLAIM|30|一致|scripts/model-review/opencode-review.mjs:1298|这一轮要跑的模型（账本里这一轮出现过的、在 `allowed` 清单里、记录上没有 `substitute` 字段的模型）|(record) => record.substitute === undefined && REVIEW_MODELS.includes(record.model),
CLAIM|31|一致|scripts/model-review/opencode-review.mjs:1286|替补只在这一轮里被替补的模型自己有一条没通过的记录时才算|record.model === model && record.substitute === undefined && record.outcome !== "ok",
CLAIM|32|一致|scripts/model-review/opencode-review.mjs:1346|链的起点改成最后一个不带 `--previous` 的算数的轮次|if (point.by !== "low-fix" && point.previous === null) {
CLAIM|33|一致|scripts/model-review/opencode-review.mjs:1361|之后每一点的提交必须是前一点的后续提交|!isAncestor(covered, point.head)
CLAIM|34|一致|scripts/model-review/opencode-review.mjs:1360|带 `--previous` 的一轮的 `previous` 不晚于前一点的提交|!isAncestor(point.previous, covered) ||
CLAIM|35|一致|scripts/model-review/opencode-review.mjs:1387|最后一点之后只许改记录目录|return result.stdout.split("\0").filter((file) => file && !file.startsWith(`${ledgerPath}/`));
CLAIM|36|一致|docs/adr/0175-cheaper-code-review-rounds.md:62|替补……原来只对第 2 轮起生效|第 2 轮起 DeepSeek 重跑后仍是可以重试的服务报错时，由 GLM 替补这一轮
CLAIM|37|一致|scripts/model-review/opencode-review.mjs:3410|账本照旧记 `substitute: true`|substitute: true,
CLAIM|38|一致|docs/adr/0175-cheaper-code-review-rounds.md:62|ADR 0175 定的脚本行为是第 1 轮只给一个模型就拒绝|第 1 轮只给一个模型时脚本拒绝（用 `--round` 把失败的那个模型补跑进原来那一轮的除外）。
CLAIM|39|一致|docs/adr/0175-cheaper-code-review-rounds.md:63|复核链起点要两个模型都通过|起点是最后一轮不带 `--previous`、两个模型都通过的复核；
CLAIM|40|一致|scripts/model-review/gateway.json:7|`gateway.json` 管的是经 Magpie 时用哪些服务方|"providers": [
CLAIM|41|一致|scripts/model-review/opencode-review.mjs:3175|直连 OpenCode 时不读它|const gatewayConfig = options.gateway ? readGatewayConfig(undefined, REVIEW_MODELS) : null;
CLAIM|42|一致|scripts/model-review/opencode-review.mjs:984|替补只在 DeepSeek 的服务报错、重跑仍不行时发生|if (!replacement || run.record.outcome !== "api-error" || run.review.retry !== "retried")
CLAIM|43|一致|scripts/model-review/opencode-review.mjs:1305|旧账本仍然能读：两个模型都通过的旧轮次按“要跑的模型都通过”算数|const needed = complete(requested)
CLAIM|44|一致|docs/adr/0175-cheaper-code-review-rounds.md:63|过去“第 1 轮两个模型里 GLM 失败、DeepSeek 通过”不算完整复核|起点是最后一轮不带 `--previous`、两个模型都通过的复核；
CLAIM|45|一致|scripts/model-review/opencode-review.mjs:1307|现在算（默认模型通过）|: complete(DEFAULT_REVIEW_MODELS)
CLAIM|46|一致|scripts/model-review/opencode-review.mjs:1290|在 DeepSeek 失败的同一轮里手工补跑 GLM（没有替补记录）仍然不算数|record.substitute === true &&
CLAIM|47|一致|scripts/model-review/opencode-review.mjs:1313|合并前检查按当前配置的 `substitutes` 判断旧账本里的替补记录|record.model === SUBSTITUTES[record.substituteFor]
CLAIM|48|一致|scripts/model-review/opencode-review.mjs:333|DeepSeek 的固定侧重（已包含“规则文件、说明文档和代码是否一致”）|以及规则文件、说明文档和代码是否一致
CLAIM|49|一致|docs/adr/0175-cheaper-code-review-rounds.md:93|0175 记过 GLM 在第 1 轮常能补到测试和文档问题|GLM 常能找到 DeepSeek 漏掉的测试和文档问题
CLAIM|50|一致|.agents/instructions/model-review.md:15|`.agents/instructions/model-review.md`：方案讨论和代码复核的步骤|## 写代码之前：方案讨论
CLAIM|51|一致|docs/adr/0175-cheaper-code-review-rounds.md:12|ADR 0175：代码复核第 2 轮起只用 DeepSeek|# ADR 0175：代码复核第 2 轮起只用 DeepSeek，低严重度意见不再触发下一轮
CLAIM|52|一致|scripts/model-review/opencode-review.mjs:83|`scripts/model-review/opencode-review.mjs` 里的 `readReviewModels` 读入配置|export function readReviewModels(path = REVIEW_MODELS_CONFIG_PATH) {
CLAIM|53|一致|scripts/model-review/opencode-review.mjs:57|`reviewModelsProblems` 校验|export function reviewModelsProblems(config) {
CLAIM|54|一致|docs/product-vision.md:55|“用户主权”（产品愿景里排第一的原则）|原则冲突时，按序优先：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。
CLAIM|55|一致|scripts/model-review/opencode-review.mjs:1507|每个 PR 的全部改动仍要被至少一个模型完整看过|outsideFiles = unreviewed(complete.head, head);

未核实：没能在当前 AGENTS.md（项目指令）里找到编号“第 17 条”及其允许两个模型的规定，所以“项目指令第 17 条允许的两个”这一说法只能判找不到；其余判断都只依据本次读到的文件内容和行号。
