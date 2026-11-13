CLAIM|1|一致|AGENTS.md:49|线程在写代码前请模型讨论方案、在合并 PR 前请模型复核代码，都用 `scripts/model-review/opencode-review.mjs`|一律用 `node scripts/model-review/opencode-review.mjs` 跑，不自己拼 `opencode run` 命令。
CLAIM|2|一致|AGENTS.md:49|它经 OpenCode（一个能让模型读代码、调用工具的命令行程序）调用模型|下面两个时机都要请 OpenCode（一个能让模型读代码、调用工具的命令行程序）上的模型看
CLAIM|3|一致|docs/adr/0175-cheaper-code-review-rounds.md:62|本 ADR 之前的规则写在 ADR 0175 里，原话是：“代码复核第 1 轮两个模型都跑，之后默认只跑 DeepSeek。第 1 轮只给一个模型时脚本拒绝”|**代码复核第 1 轮两个模型都跑，之后默认只跑 DeepSeek。** 第 1 轮只给一个模型时脚本拒绝
CLAIM|4|一致|docs/adr/0175-cheaper-code-review-rounds.md:63|复核链的“起点是最后一轮不带 `--previous`、两个模型都通过的复核”|起点是最后一轮不带 `--previous`、两个模型都通过的复核
CLAIM|5|一致|docs/adr/0175-cheaper-code-review-rounds.md:70|方案讨论“仍然两个模型都跑”|仍然两个模型都跑
CLAIM|6|一致|docs/adr/0175-cheaper-code-review-rounds.md:30|两个模型指 DeepSeek V4.1 Flash 和 GLM 5.3 Flash|两个模型是 `opencode-go/deepseek-v4.1-flash` 和 `opencode-go/glm-5.3-flash`，推理强度都设为高
CLAIM|7|一致|scripts/model-review/opencode-review.mjs:2815|方案讨论、核对代码说法和代码复核的每一轮（包括第 1 轮），不写 `--models` 时都只跑默认模型|    models: DEFAULT_REVIEW_MODELS,
CLAIM|8|一致|scripts/model-review/review-models.json:3|现在是 `opencode-go/deepseek-v4.1-flash`|  "default": ["opencode-go/deepseek-v4.1-flash"],
CLAIM|9|一致|scripts/model-review/opencode-review.mjs:2874|Andy 特别指明时，用 `--models deepseek-v4.1-flash,glm-5.3-flash` 让两个模型都跑|        REVIEW_MODELS.find((model) => name && (model === name || model.endsWith(`/${name}`))),
CLAIM|10|一致|scripts/model-review/review-models.json:2|`scripts/model-review/review-models.json` 有三项：`allowed`、`default`、`substitutes`|  "allowed": ["opencode-go/deepseek-v4.1-flash", "opencode-go/glm-5.3-flash"],
CLAIM|11|一致|scripts/model-review/review-models.json:2|`allowed`（能用的模型，仍然只有项目指令第 17 条允许的两个）|  "allowed": ["opencode-go/deepseek-v4.1-flash", "opencode-go/glm-5.3-flash"],
CLAIM|12|找不到|-|`allowed`（能用的模型，仍然只有项目指令第 17 条允许的两个）|-（仓库内没有项目指令第 17 条）
CLAIM|13|一致|scripts/model-review/review-models.json:3|`default`（不写 `--models` 时跑哪些）|  "default": ["opencode-go/deepseek-v4.1-flash"],
CLAIM|14|一致|scripts/model-review/review-models.json:5|`substitutes`（哪个模型的服务用不了时由谁替补）|    "opencode-go/deepseek-v4.1-flash": "opencode-go/glm-5.3-flash"
CLAIM|15|一致|scripts/model-review/opencode-review.mjs:95|脚本启动时读它并校验|const reviewModels = readReviewModels();
CLAIM|16|一致|scripts/model-review/opencode-review.mjs:59-63|`allowed` 和 `default` 不能为空、不能重复|    new Set(list).size === list.length;
CLAIM|17|一致|scripts/model-review/opencode-review.mjs:68|`default` 和 `substitutes` 里的模型都必须在 `allowed` 里|  if (!names(config?.default) || config.default.some((name) => !allowed.includes(name)))
CLAIM|18|一致|scripts/model-review/opencode-review.mjs:71-79|`substitutes` 可以为空|    substitutes === null ||
CLAIM|19|一致|scripts/model-review/opencode-review.mjs:91|不合格以 `REVIEW_MODELS_CONFIG_INVALID` 停下|  if (problems.length > 0) throw new Error(`REVIEW_MODELS_CONFIG_INVALID ${problems.join(",")}`);
CLAIM|20|一致|scripts/model-review/opencode-review.mjs:1300|这一轮要跑的模型（账本里这一轮出现过的、在 `allowed` 清单里、记录上没有 `substitute` 字段的模型）每个都有 `ok` 的结果或有替补它的 `ok` 结果；或者默认模型每个都有|      models.length > 0 && models.every((model) => direct(model) || stoodIn(model));
CLAIM|21|一致|scripts/model-review/opencode-review.mjs:1342|链的起点改成最后一个不带 `--previous` 的算数的轮次|    if (point.by !== "low-fix" && point.previous === null) {
CLAIM|22|一致|scripts/model-review/opencode-review.mjs:1357|之后每一点的提交必须是前一点的后续提交|      !isAncestor(covered, point.head)
CLAIM|23|一致|scripts/model-review/opencode-review.mjs:1356|带 `--previous` 的一轮的 `previous` 不晚于前一点的提交|      !isAncestor(point.previous, covered) ||
CLAIM|24|一致|scripts/model-review/opencode-review.mjs:1383|最后一点之后只许改记录目录|  return result.stdout.split("\0").filter((file) => file && !file.startsWith(`${ledgerPath}/`));
CLAIM|25|一致|scripts/model-review/opencode-review.mjs:981|只跑一个模型的代码复核里，DeepSeek 重跑后仍是可以重试的服务报错时由 GLM 替补|  if (mode !== "code-review" || models.length !== 1) return null;
CLAIM|26|一致|scripts/model-review/opencode-review.mjs:981|原来只对第 2 轮起生效，现在第 1 轮也一样|  if (mode !== "code-review" || models.length !== 1) return null;
CLAIM|27|一致|scripts/model-review/opencode-review.mjs:982|替补只在 DeepSeek 的服务用不了时发生|  const replacement = SUBSTITUTES[models[0]];
CLAIM|28|一致|scripts/model-review/opencode-review.mjs:3406|账本照旧记 `substitute: true`|          substitute: true,
CLAIM|29|一致|docs/adr/0175-cheaper-code-review-rounds.md:93|0175“比较过的方案”里没有采用的“每轮都只用一个模型，包括第 1 轮”|**每轮都只用一个模型，包括第 1 轮。** 不采用：
CLAIM|30|一致|docs/adr/0175-cheaper-code-review-rounds.md:93|当时记下的代价（GLM 常能找到 DeepSeek 漏掉的测试和文档问题）|第 1 轮看的是整个 PR，两个模型侧重不同，GLM 常能找到 DeepSeek 漏掉的测试和文档问题。
CLAIM|31|一致|scripts/model-review/opencode-review.mjs:333|DeepSeek 的固定侧重（已包含“规则文件、说明文档和代码是否一致”）|    "你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。",
CLAIM|32|一致|scripts/model-review/opencode-review.mjs:1301|旧账本仍然能读：两个模型都通过的旧轮次按“要跑的模型都通过”算数|    const needed = complete(requested)
CLAIM|33|一致|scripts/model-review/opencode-review.mjs:1303|过去“第 1 轮两个模型里 GLM 失败、DeepSeek 通过”不算完整复核，现在算（默认模型通过）|      : complete(DEFAULT_REVIEW_MODELS)
CLAIM|34|一致|scripts/model-review/opencode-review.mjs:1286|在 DeepSeek 失败的同一轮里手工补跑 GLM（没有替补记录）仍然不算数|          record.substitute === true &&
CLAIM|35|一致|docs/adr/0175-cheaper-code-review-rounds.md:62-63|ADR 0175 定的脚本行为是第 1 轮只给一个模型就拒绝、复核链起点要两个模型都通过|起点是最后一轮不带 `--previous`、两个模型都通过的复核
CLAIM|36|一致|scripts/model-review/opencode-review.mjs:3171|`gateway.json` 管的是经 Magpie（本机模型网关）时用哪些服务方，直连 OpenCode 时不读它|  const gatewayConfig = options.gateway ? readGatewayConfig(undefined, REVIEW_MODELS) : null;
CLAIM|37|一致|scripts/model-review/opencode-review.mjs:984|替补只在 DeepSeek 的服务报错、重跑仍不行时发生|  if (!replacement || run.record.outcome !== "api-error" || run.review.retry !== "retried")
CLAIM|38|一致|.agents/instructions/model-review.md:2|.agents/instructions/model-review.md：方案讨论和代码复核的步骤|# 和 OpenCode 协作：方案讨论和代码复核
CLAIM|39|一致|docs/adr/0175-cheaper-code-review-rounds.md:12|ADR 0175：代码复核第 2 轮起只用 DeepSeek|# ADR 0175：代码复核第 2 轮起只用 DeepSeek，低严重度意见不再触发下一轮
CLAIM|40|一致|scripts/model-review/review-models.json:1|`scripts/model-review/review-models.json`、`scripts/model-review/opencode-review.mjs`、`test/tooling/opencode-review.test.mjs`、`test/tooling/opencode-review-merge-gate.test.mjs`、`test/tooling/review-delegate.test.mjs`：配置、实现和测试|{
CLAIM|41|一致|scripts/model-review/opencode-review.mjs:1|`scripts/model-review/review-models.json`、`scripts/model-review/opencode-review.mjs`、`test/tooling/opencode-review.test.mjs`、`test/tooling/opencode-review-merge-gate.test.mjs`、`test/tooling/review-delegate.test.mjs`：配置、实现和测试|#!/usr/bin/env node
CLAIM|42|一致|test/tooling/opencode-review.test.mjs:1|`scripts/model-review/review-models.json`、`scripts/model-review/opencode-review.mjs`、`test/tooling/opencode-review.test.mjs`、`test/tooling/opencode-review-merge-gate.test.mjs`、`test/tooling/review-delegate.test.mjs`：配置、实现和测试|import { execFileSync, spawn, spawnSync } from "node:child_process";
CLAIM|43|一致|test/tooling/opencode-review-merge-gate.test.mjs:1|`scripts/model-review/review-models.json`、`scripts/model-review/opencode-review.mjs`、`test/tooling/opencode-review.test.mjs`、`test/tooling/opencode-review-merge-gate.test.mjs`、`test/tooling/review-delegate.test.mjs`：配置、实现和测试|import { execFileSync, spawnSync } from "node:child_process";
CLAIM|44|一致|test/tooling/review-delegate.test.mjs:1|`scripts/model-review/review-models.json`、`scripts/model-review/opencode-review.mjs`、`test/tooling/opencode-review.test.mjs`、`test/tooling/opencode-review-merge-gate.test.mjs`、`test/tooling/review-delegate.test.mjs`：配置、实现和测试|import { execFileSync, spawnSync } from "node:child_process";

项目指令第 17 条不在仓库里，无法核对“项目指令第 17 条允许的两个”这一说法；其余关于旧行为（如“原来只对第 2 轮起生效”）只依据提交 99b1cf6b 的 diff 核对，未逐行读取旧版本完整文件。
