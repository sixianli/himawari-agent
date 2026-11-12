CLAIM|1|一致|apps/agent-service/src/production-home.ts:651-656|“首页条目”是服务器把 Himawari 主动找主人的事汇成的一张清单：等主人点头的审批、读完邮件后的提醒、等确认的记忆、到点的提醒等。|...(options.proactive ? [mailSource(options.proactive)] : []), / approvalSource(options, readCopy), / ...(options.memory ? memorySources(options.memory) : []),
CLAIM|2|一致|packages/application/src/services/home-feed.ts:240|第 1 步已经做了读取层（`packages/application/src/services/home-feed.ts`）。|export class HomeFeedService {
CLAIM|3|不一致|169a3c66a:packages/application/src/services/home-feed.ts:129|那时每件等主人定的事都标 `unscored`（还没打分），只按到期时间和创建时间排。|const RANK_ORDER: Readonly<Record<HomeRank, number>> = { rule: 0, deadline: 1, unscored: 2, recency: 3,
CLAIM|4|一致|.claude/rules/owner-standing-rules.md:26|新增模型调用属于大改动。|什么算大改动：改动较大的模块或功能，或者动到项目的核心特性，例如记忆系统、模型调用和路由、Agent 循环（模型一步步调用工具的那套流程）、权限和授权、系统主动提醒、数据存储结构；
CLAIM|5|一致|.agents/handoffs/2026-11-12-home-feed-plan.md:1|方案是 `.agents/handoffs/2026-11-12-home-feed-plan.md`。|# 方案：服务器端“首页条目”读取接口
CLAIM|6|找不到|-|Andy 2026-11-12 在项目聊天同意（原话：“以上需要我定的事情，按照你的推荐来。然后你要走方案审核讨论的话，我同意。”）。|-
CLAIM|7|一致|.agents/handoffs/2026-11-12-home-feed-plan.md:23-24|这两页的原话在方案文件第 18 到 27 行有引用。|搜索摘要里的原话：“The system adds the notification to the notification list without lighting up the screen or playing a sound.”（passive 一档）。 / GLM 审核时引的原话：“Your iPhone can determine which notifications have priority over others. Priority notifications appear at the top of the stack”
CLAIM|8|一致|.agents/handoffs/2026-11-12-home-feed-plan.md:24|方案自己注明其中一句没有逐字核对。|这一页我自己抓取时只拿到目录，这句没有逐字核对。
CLAIM|9|一致|docs/product-vision.md:55|`docs/product-vision.md:55`，“原则冲突时，按序优先：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。”|*原则冲突时，按序优先：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。*
CLAIM|10|一致|.agents/handoffs/2026-11-12-home-feed-plan.md:244|`.agents/handoffs/2026-11-12-home-feed-plan.md:244`，“打分表、打分调用、审批的一句话和肯定按钮文字。要改表，排队。”|2. 打分表、打分调用、审批的一句话和肯定按钮文字。要改表，排队。
CLAIM|11|一致|.agents/handoffs/2026-11-12-home-feed-plan.md:120|同一文件 `:120`，“哪件事对主人更要紧，是理解意思的判断，现有字段答不了：审批的 `finalRisk` 说的是动作多危险，不是多急”。|哪件事对主人更要紧，是理解意思的判断，现有字段答不了：审批的 `finalRisk` 说的是动作多危险，不是多急；
CLAIM|12|一致|.agents/handoffs/2026-11-12-home-feed-plan.md:125|同一文件 `:125-129`，“命中主人定的规则的……最前”。|1. 命中主人定的规则的（例如重要发件人，现有的 `floorRaised`）最前。规则是硬性设定，不交给模型权衡。
CLAIM|13|一致|.agents/handoffs/2026-11-12-home-feed-plan.md:126|同一文件 `:125-129`，“快到期的”。|2. 快到期的：离 `deadline` 不到“提前量”的。提前量是一项设置，页面上看得到、能改。
CLAIM|14|一致|.agents/handoffs/2026-11-12-home-feed-plan.md:127|同一文件 `:125-129`，“其余等主人定的，按模型分数从高到低。还没打分的排在这一档最前，标 `unscored`”。|3. 其余等主人定的，按模型分数从高到低。还没打分的排在这一档最前，标 `unscored`：一件等主人定的事，宁可早看到。
CLAIM|15|一致|.agents/handoffs/2026-11-12-home-feed-plan.md:130|同一文件 `:130`，“模型出错、超时、到每天上限：条目照常返回，只是标 `unscored`。任何条目都不会因为模型出问题而消失或被藏起来。”|- 模型出错、超时、到每天上限：条目照常返回，只是标 `unscored`。任何条目都不会因为模型出问题而消失或被藏起来。
CLAIM|16|一致|.agents/handoffs/2026-11-12-home-feed-plan.md:131|同一文件 `:131`，“按现有出口规则不能发给这个模型的，只发种类和到期时间；`restricted` 的一律不发。”|- 敏感内容：每类来源用它自己已有的分级（审批用意图里的分级，记忆用记忆的分级）。按现有出口规则不能发给这个模型的，只发种类和到期时间；`restricted` 的一律不发。
CLAIM|17|一致|packages/application/src/ports/model-usage.ts:11-12|`packages/application/src/ports/model-usage.ts:11-12`，`"review-prereview",`、`"home-urgency",`（后一行是本次加的）。|  "review-prereview", /  "home-urgency",
CLAIM|18|一致|packages/persistence-sqlite/src/migrations/0091_decision_prereviews.sql:79|加新用途要重建表，上一次是迁移 0091。|CREATE TABLE model_usage_observations_keep AS SELECT * FROM model_usage_observations;
CLAIM|19|一致|packages/application/src/services/review-prereview.ts:43|`packages/application/src/services/review-prereview.ts:43`，`dailyLimit: 50,`。|  dailyLimit: 50,
CLAIM|20|一致|docs/adr/0237-model-pre-rates-waiting-decisions.md:49|ADR 0237 决定第 1 条，“这张表不许改（触发器拦下 UPDATE）”。|这张表不许改（触发器拦下 UPDATE），只在它所属的决策记录或邮件记录被删掉时随之删除。
CLAIM|21|一致|.claude/rules/prompt-prefix.md:67|`.claude/rules/prompt-prefix.md:67`，“后台调用也是固定的在前、会变的在后。”|15. **后台调用也是固定的在前、会变的在后。**整理记忆、判断邮件、起对话标题这类调用，先放固定的指令，再放这次的数据，最后放当前时间这类每次都变的值。
CLAIM|22|一致|apps/agent-service/src/production-model-composition.ts:126|`apps/agent-service/src/production-model-composition.ts:126`，`proactiveModel(`。|  proactiveModel(
CLAIM|23|一致|apps/agent-service/src/production-model-composition.ts:131|它的参数里有 `readonly purpose?: ModelUsagePurpose;`（`:131`）。|      readonly purpose?: ModelUsagePurpose;
CLAIM|24|一致|.claude/rules/owner-standing-rules.md:18|`.claude/rules/owner-standing-rules.md:18`，“按量付费只用 DeepSeek V4.1 Flash 这类低价模型或免费额度。”|按量付费只用 DeepSeek V4.1 Flash 这类低价模型或免费额度。
CLAIM|25|不一致|packages/gateway-contracts/src/contracts-v2.ts:653|这五个值就是合约里的 `HOME_RANKS`（`packages/gateway-contracts/src/contracts-v2.ts:652`）。|export const HOME_RANKS = ["rule", "deadline", "unscored", "model", "recency"] as const;
CLAIM|26|一致|packages/application/src/ports/authorization.ts:182|审批只有机器字段。|  readonly intentSnapshot: ActionIntent;
CLAIM|27|一致|apps/agent-service/src/production-home.ts:715|`ProductionHomeControl.approvalCopy`（`apps/agent-service/src/production-home.ts`）单独可调。|  async approvalCopy(input: {
CLAIM|28|一致|packages/persistence-sqlite/src/migrations/0095_home_item_scores.sql:7|审批的行随审批记录级联删除。|  approval_request_id TEXT REFERENCES approval_requests(id) ON DELETE CASCADE,
CLAIM|29|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:1046|按规定流程删除数据时，审批的一句话所引用的密封内容一并清掉（`packages/persistence-sqlite/src/sqlite-governed-deletion.ts`）。|        `SELECT sentence_ref FROM home_item_scores
CLAIM|30|一致|packages/persistence-sqlite/src/migrations/0095_home_item_scores.sql:3-4|其他种类的行不含内容，只有条目编号、分数和摘要，来源被删后这些行留着，只在主人或 agent 整个被删时才删。|  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE, /  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
CLAIM|31|找不到|-|周报的“模型排第一的是不是主人最先处理的”没有做。|-
CLAIM|32|找不到|-|用量页只多了一个用途名……没有做“今天已用几次、上限几次”的显示。|-
CLAIM|33|一致|packages/application/src/services/home-feed.ts:168-174|没有把记忆的重要度作为输入……首页读取层拿到的提醒不带这个值，这一步没有加。|    facts: { text, origin: candidate.source.type, from: candidate.source.from, label: candidate.source.label, ruleHit: candidate.ruleHit, },
CLAIM|34|一致|.agents/handoffs/2026-11-12-home-feed-plan.md:221|方案写每天默认 50 次。|每天最多次数是设置，默认 50 次（和预评一样，前提 14），用量页看得到已用和上限。
CLAIM|35|一致|.agents/handoffs/2026-11-12-home-feed-plan.md:221|方案写“用量页看得到已用和上限”。|每天最多次数是设置，默认 50 次（和预评一样，前提 14），用量页看得到已用和上限。
CLAIM|36|一致|packages/application/src/services/home-urgency.ts:26-27|默认改成每天 1000 次、1 美元。|  dailyLimit: 1_000, /  dailyCostMicros: 1_000_000,
CLAIM|37|找不到|-|分数不进数据导出。|-
CLAIM|38|一致|packages/persistence-sqlite/src/data-export/snapshot.ts:231-236|预评进了导出。|const prereviews = withEvidence / ? all( / `SELECT id, decision_id, mail_source, message_id, calibration_group, category, status, / rating, confidence_permille, history_conflict, failure_code, model_ref, prompt_id, / text_digest, data_classification, cost_micros, duration_ms, created_at / FROM decision_prereviews WHERE owner_id = @ownerId AND agent_id = @agentId
CLAIM|39|一致|packages/gateway-contracts/src/contracts-v2.ts:652|合约的 `HOME_SENTENCE_BASES`……多了一个 `model`。|export const HOME_SENTENCE_BASES = ["recorded", "catalog", "model", "none"] as const;
CLAIM|40|一致|packages/gateway-contracts/src/contracts-v2.ts:653|合约的 `HOME_RANKS`……多了一个 `model`。|export const HOME_RANKS = ["rule", "deadline", "unscored", "model", "recency"] as const;
CLAIM|41|一致|packages/gateway-contracts/src/contracts-v2.ts:699|合约的 `HOME_LABEL_BASES` 各多了一个 `model`。|export const HOME_LABEL_BASES = ["catalog", "model"] as const;
CLAIM|42|找不到|-|只跑一个服务实例。|-
CLAIM|43|一致|packages/application/src/services/home-urgency.ts:114-115|改了提示词文字，提示词版本号跟着变。|export function homeUrgencyPromptId(digest: (text: string) => string): string { /  return `${HOME_URGENCY.id}@${digest(HOME_URGENCY.text).slice(0, 12)}`;
CLAIM|44|一致|packages/application/src/services/home-urgency.ts:348-354|已有的分数不重打；只有文字摘要变了的事才重打。|const fresh = open / .filter( / ({ ref }) => / !scored.has(refKey(ref)) && / !failedRecently.has(refKey(ref)) && / !this.#storeFailedAt.has(refKey(ref)), / )
CLAIM|45|找不到|-|要让全部开着的事按新提示词重打，目前没有命令。|-
CLAIM|46|一致|packages/application/src/services/home-urgency.ts:291-293|主人换了界面语言后，旧审批的模型文字语言对不上，退回通用文字；只有审批内容变了才会按新语言重写。|      row.copyLocale !== input.locale /    ) /      return { sentence: null, affirmLabel: null };
CLAIM|47|一致|test/integration/home-urgency.test.ts:35-44|`test/integration/home-urgency.test.ts`：真实 SQLite，经 `ProductionHomeControl` 走完打分、排序、参照、字节确定、重启后顺序不变、规则和到期优先、模型坏回答、24 小时退避、每天次数和费用上限、关闭、文字变了重打、审批文字的正反向（指纹、语言、各语言上限刚好和超一个字、和否定文字相同、本人在场）、分级不许时只发种类和到期时间、`restricted` 不发、存储失败时释放密封内容、表不许改和级联删除。|import { applyMigrations, loadBundledMigrations, openQualifiedDatabase, SqliteProductStateRepository, } from "@himawari-agent/persistence-sqlite"; / import { HOME_TEXT, ProductionHomeControl } from "../../apps/agent-service/src/production-home.ts";
CLAIM|48|一致|packages/application/test/home-urgency.unit.test.ts:3-10|`packages/application/test/home-urgency.unit.test.ts`：提示词的排列和字节、回答的解析、按钮文字的核对。|import { acceptsHomeAffirmLabel, DEFAULT_HOME_URGENCY, type HomeUrgencyCandidate, homeUrgencyPrompt, homeUrgencyPromptId, parseHomeUrgency, } from "../src/services/home-urgency.js";
CLAIM|49|一致|packages/platform-node/test/startup-configuration.unit.test.ts:1786|`packages/platform-node/test/startup-configuration.unit.test.ts`：`runPolicy.homeUrgency` 的默认值和越界拒绝。|it("accepts home urgency scoring settings, fills in the defaults, and refuses values out of range", () => {
CLAIM|50|一致|apps/agent-service/test/prompt-output-contracts.unit.test.ts:91|`apps/agent-service/test/prompt-output-contracts.unit.test.ts`：提示词登记在目录并有对应的解析函数。|        "home.urgency",
CLAIM|51|一致|packages/prompt-catalog/src/review.ts:71|提示词登记在目录并有对应的解析函数。|export const HOME_URGENCY = fixedPrompt({
CLAIM|52|一致|package.json:58|`npm run check:prompt-catalog`。|    "check:prompt-catalog": "vitest run --config vitest.workspace.ts --project node-services apps/agent-service/test/prompt-catalog.unit.test.ts apps/agent-service/test/prompt-rendering-golden.unit.test.ts apps/agent-service/test/prompt-output-contracts.unit.test.ts apps/agent-service/test/prompt-wording.unit.test.ts apps/agent-service/test/trusted-prompt-egress.unit.test.ts && vitest run --config vitest.workspace.ts --project unit packages/sensitive-capture/test/trusted-text.unit.test.ts && vitest run --config vitest.workspace.ts --project browser apps/control-center/test/sensitive-interceptions.unit.test.ts && vitest run --config vitest.workspace.ts --project pi-compat packages/runtime-pi/test/pi-builtin-tool-text.compat.test.ts",
CLAIM|53|找不到|-|`npm run check:egress-redaction` 通过：这次调用走现有的统一出口，没有新增直连模型的地方。|-

未核实：Andy 的聊天同意原话、周报指标确未做、用量页未显示已用/上限、数据导出不含分数、只跑一个服务实例、没有“全部重打”命令，以及 `check:egress-redaction` 的实际通过结果；验证部分只读了测试文件，没有运行测试，也没有逐条复现所列用例。另，`HOME_RANKS` 的五个值实际在 `contracts-v2.ts:653`，不是方案写的 `:652`（652 行是 `HOME_SENTENCE_BASES`）。
