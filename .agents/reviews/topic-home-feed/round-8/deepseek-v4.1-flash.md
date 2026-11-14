CLAIM|1|一致|packages/application/src/services/home-feed.ts:240|第 1 步已经做了读取层（`packages/application/src/services/home-feed.ts`）|export class HomeFeedService {
CLAIM|2|一致|packages/application/src/services/home-feed.ts:178@169a3c66a|那时还没有模型分数|const RANK_ORDER: Readonly<Record<HomeRank, number>> = {；rule: 0,；deadline: 1,；unscored: 2,；recency: 3,；};
CLAIM|3|一致|packages/application/src/services/home-feed.ts:178@169a3c66a|命中主人规则的和快到期的排在前面|const RANK_ORDER: Readonly<Record<HomeRank, number>> = {；rule: 0,；deadline: 1,；unscored: 2,；recency: 3,；};
CLAIM|4|一致|packages/application/src/services/home-feed.ts:191@169a3c66a|其余等主人定的事都标 `unscored`（还没打分）|return "unscored";
CLAIM|5|不一致|packages/application/src/services/home-feed.ts:219|彼此之间只按到期时间和创建时间排|return compareText(left.key, right.key);
CLAIM|6|一致|.agents/handoffs/2026-11-12-home-feed-plan.md:1|方案是 `.agents/handoffs/2026-11-12-home-feed-plan.md`|# 方案：服务器端“首页条目”读取接口
CLAIM|7|一致|docs/product-vision.md:55|原则冲突时，按序优先：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。|*原则冲突时，按序优先：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。*
CLAIM|8|一致|.agents/handoffs/2026-11-12-home-feed-plan.md:244|打分表、打分调用、审批的一句话和肯定按钮文字。要改表，排队。|2. 打分表、打分调用、审批的一句话和肯定按钮文字。要改表，排队。
CLAIM|9|一致|.agents/handoffs/2026-11-12-home-feed-plan.md:120|哪件事对主人更要紧，是理解意思的判断，现有字段答不了：审批的 `finalRisk` 说的是动作多危险，不是多急|哪件事对主人更要紧，是理解意思的判断，现有字段答不了：审批的 `finalRisk` 说的是动作多危险，不是多急；
CLAIM|10|一致|.agents/handoffs/2026-11-12-home-feed-plan.md:125|命中主人定的规则的……最前|1. 命中主人定的规则的（例如重要发件人，现有的 `floorRaised`）最前。规则是硬性设定，不交给模型权衡。
CLAIM|11|一致|.agents/handoffs/2026-11-12-home-feed-plan.md:126|快到期的|2. 快到期的：离 `deadline` 不到“提前量”的。提前量是一项设置，页面上看得到、能改。
CLAIM|12|一致|.agents/handoffs/2026-11-12-home-feed-plan.md:127|其余等主人定的，按模型分数从高到低。还没打分的排在这一档最前，标 `unscored`|3. 其余等主人定的，按模型分数从高到低。还没打分的排在这一档最前，标 `unscored`：一件等主人定的事，宁可早看到。
CLAIM|13|一致|.agents/handoffs/2026-11-12-home-feed-plan.md:130|模型出错、超时、到每天上限：条目照常返回，只是标 `unscored`。任何条目都不会因为模型出问题而消失或被藏起来。|- 模型出错、超时、到每天上限：条目照常返回，只是标 `unscored`。任何条目都不会因为模型出问题而消失或被藏起来。
CLAIM|14|一致|.agents/handoffs/2026-11-12-home-feed-plan.md:131|按现有出口规则不能发给这个模型的，只发种类和到期时间；`restricted` 的一律不发。|- 敏感内容：每类来源用它自己已有的分级（审批用意图里的分级，记忆用记忆的分级）。按现有出口规则不能发给这个模型的，只发种类和到期时间；`restricted` 的一律不发。这次调用登记进提示词目录和出口遮盖检查。
CLAIM|15|一致|packages/persistence-sqlite/src/migrations/0095_home_item_scores.sql:69|模型用量表的“用途”是表约束里的清单|purpose TEXT NOT NULL CHECK (
CLAIM|16|一致|packages/application/src/ports/model-usage.ts:11|`packages/application/src/ports/model-usage.ts:11-12`，`"review-prereview",`、`"home-urgency",`|"review-prereview",；"home-urgency",
CLAIM|17|一致|packages/persistence-sqlite/src/migrations/0095_home_item_scores.sql:73|后一行是本次加的|'home-urgency', 'other'
CLAIM|18|一致|packages/persistence-sqlite/src/migrations/0095_home_item_scores.sql:60|加新用途要重建表|CREATE TABLE model_usage_observations_keep AS SELECT * FROM model_usage_observations;；DROP TABLE model_usage_observations;
CLAIM|19|一致|packages/persistence-sqlite/src/migrations/0091_decision_prereviews.sql:79|上一次是迁移 0091|CREATE TABLE model_usage_observations_keep AS SELECT * FROM model_usage_observations;；DROP TABLE model_usage_observations;
CLAIM|20|一致|packages/application/src/services/review-prereview.ts:43|`dailyLimit: 50,`|dailyLimit: 50,
CLAIM|21|一致|docs/adr/0237-model-pre-rates-waiting-decisions.md:49|这张表不许改（触发器拦下 UPDATE）|这张表不许改（触发器拦下 UPDATE），只在它所属的决策记录或邮件记录被删掉时随之删除。
CLAIM|22|一致|.claude/rules/prompt-prefix.md:67|后台调用也是固定的在前、会变的在后。|15. **后台调用也是固定的在前、会变的在后。**整理记忆、判断邮件、起对话标题这类调用，先放固定的指令，再放这次的数据，最后放当前时间这类每次都变的值。
CLAIM|23|一致|apps/agent-service/src/production-model-composition.ts:126|`apps/agent-service/src/production-model-composition.ts:126`，`proactiveModel(`|proactiveModel(
CLAIM|24|一致|apps/agent-service/src/production-model-composition.ts:131|它的参数里有 `readonly purpose?: ModelUsagePurpose;`（`:131`）|readonly purpose?: ModelUsagePurpose;
CLAIM|25|一致|.claude/rules/owner-standing-rules.md:18|按量付费只用 DeepSeek V4.1 Flash 这类低价模型或免费额度。|- 禁用贵模型：任何场景（生产、评测、裁判、测试、实验、后台任务）都不得通过按 token 付费的渠道（例如 Vercel、OpenRouter）调用 Claude、OpenAI 或同价位的模型；按量付费只用 DeepSeek V4.1 Flash 这类低价模型或免费额度。代码和评测脚本里不得写死 `anthropic/`、`openai/` 开头的模型名。
CLAIM|26|一致|packages/gateway-contracts/src/contracts-v2.ts:653|这五个值就是合约里的 `HOME_RANKS`（`packages/gateway-contracts/src/contracts-v2.ts:653`）|export const HOME_RANKS = ["rule", "deadline", "unscored", "model", "recency"] as const;
CLAIM|27|一致|apps/agent-service/src/service-main.ts:2032|用哪个模型由 `runPolicy.homeUrgency.modelRef` 定，没写就用主动检查的模型；两者都没有就不打分。|const homeUrgencyRef = homeUrgencyConfiguration.modelRef ?? proactiveConfiguration?.modelRef;
CLAIM|28|一致|apps/agent-service/src/service-main.ts:2057|模型经现有的统一出口 `proactiveModel` 调用，用途记 `home-urgency`。|purpose: "home-urgency",
CLAIM|29|一致|packages/platform-node/src/strict-configuration.ts:1358|全部数值都在 `runPolicy.homeUrgency` 里可改，启动时校验范围。|const bounds = {；dailyLimit: [0, 100_000],；dailyCostMicros: [0, 100_000_000],；perCall: [1, 50],；referenceLimit: [0, 200],；requestTimeoutMs: [1_000, 300_000],；checkIntervalSeconds: [10, 86_400],；retryAfterHours: [1, 720],；} as const;
CLAIM|30|一致|packages/persistence-sqlite/src/migrations/0095_home_item_scores.sql:10|一句话按现有的密封内容方式存，表里只存引用|sentence_ref TEXT REFERENCES payloads(ref) ON DELETE RESTRICT,
CLAIM|31|一致|packages/persistence-sqlite/src/migrations/0095_home_item_scores.sql:11|按钮文字不超过 64 个字符，直接存在表里|affirm_label TEXT CHECK (affirm_label IS NULL OR length(affirm_label) BETWEEN 1 AND 64),
CLAIM|32|一致|packages/application/src/services/home-urgency.ts:286|审批的内容指纹和打分时不同|items: [this.ref({ key: input.itemKey, digestBasis: input.semanticSnapshotHash })],
CLAIM|33|一致|packages/application/src/services/home-urgency.ts:291|文字的语言和读的人的语言不同|row.copyLocale !== input.locale
CLAIM|34|一致|packages/application/src/services/home-urgency.ts:33|按钮文字超过这门语言的上限（`affirmLabelMax`，默认中文 6、日文 8、英文 16 个字符，按用户看到的字符数）|affirmLabelMax: Object.freeze({ "zh-CN": 6, ja: 8, en: 16 }),
CLAIM|35|一致|packages/application/src/services/home-urgency.ts:136|按用户看到的字符数|if (graphemes(label) > limit) return false;
CLAIM|36|一致|packages/application/src/services/home-urgency.ts:137|和否定按钮文字相同|return (；label.toLocaleLowerCase(input.locale) !==；input.negativeLabel.trim().toLocaleLowerCase(input.locale)；);
CLAIM|37|一致|packages/application/src/services/home-urgency.ts:122|这门语言没有配上限|const limit = limits[locale];；return typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? limit : undefined;
CLAIM|38|一致|test/integration/home-urgency.test.ts:931|要主人本人在场的审批，按钮仍是通用的“看内容再定”，模型写的字只作为这条的说明。|expect((await read()).items[0]?.actions[0]).toEqual({；action: "approved",；label: "发出去",；labelBasis: "model",；polarity: "positive",；ownerPresence: true,；reviewLabel: "看内容再定",；});
CLAIM|39|一致|test/integration/home-urgency.test.ts:953|否定按钮和其他种类的按钮永远是目录文字。|expect(item?.actions.map(({ label, labelBasis }) => [label, labelBasis])).toEqual([；["完成", "catalog"],；["不再提醒", "catalog"],；]);
CLAIM|40|一致|apps/agent-service/src/production-home.ts:715|`ProductionHomeControl.approvalCopy`（`apps/agent-service/src/production-home.ts`）单独可调，给审批编号、内容指纹和语言|async approvalCopy(input: {；readonly approvalRequestId: string;；readonly semanticSnapshotHash: string;；readonly locale: HomeLocale;；}): Promise<HomeApprovalCopy> {
CLAIM|41|找不到|-|推送用它就不会和首页不一致。|-|
CLAIM|42|一致|packages/persistence-sqlite/src/migrations/0095_home_item_scores.sql:7|审批的行随审批记录级联删除|approval_request_id TEXT REFERENCES approval_requests(id) ON DELETE CASCADE,
CLAIM|43|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:1046|按规定流程删除数据时，审批的一句话所引用的密封内容一并清掉（`packages/persistence-sqlite/src/sqlite-governed-deletion.ts`）|SELECT sentence_ref FROM home_item_scores；WHERE sentence_ref IS NOT NULL AND approval_request_id IN (；SELECT id FROM approval_requests WHERE run_id IN (${placeholders(runIds)})；)
CLAIM|44|一致|packages/persistence-sqlite/src/migrations/0095_home_item_scores.sql:6|其他种类的行不含条目内容，只有条目编号、分数、摘要和模型、提示词版本、费用这类记录|item_key TEXT NOT NULL CHECK (length(item_key) BETWEEN 1 AND 256),
CLAIM|45|一致|packages/persistence-sqlite/src/migrations/0095_home_item_scores.sql:51|来源被删后这些行留着，只在主人或 agent 整个被删时才删|CREATE TRIGGER home_item_scores_no_delete BEFORE DELETE ON home_item_scores；WHEN EXISTS (SELECT 1 FROM agents WHERE id = OLD.agent_id)；
CLAIM|46|找不到|-|周报的“模型排第一的是不是主人最先处理的”没有做。|-|
CLAAMP|47|找不到|-|首页的动作入口（第 3 步的 `home/act`）才有这个记录|-|
CLAIM|48|一致|.agents/handoffs/2026-11-12-home-feed-plan.md:221|方案写“用量页看得到已用和上限”|- 每天最多次数是设置，默认 50 次（和预评一样，前提 14），用量页看得到已用和上限。到上限后新条目标 `unscored`，首页照常。失败的条目 24 小时内不重试。
CLAIM|49|找不到|-|这一步只让 `home-urgency` 的调用在用量页按用途显示|-|
CLAIM|50|找不到|-|没有做“今天已用几次、上限几次”的显示。|-|
CLAIM|51|一致|packages/application/src/services/home-feed.ts:87|首页读取层拿到的提醒不带这个值，这一步没有加。|export interface HomeUpcoming {；readonly reminderId: string;；readonly memoryId: string;；readonly text: string;；readonly dueAt: string;；readonly repeat: "none" | "yearly";；readonly sourceThreadId: string | null;；readonly dataClassification: DataClassification;；}
CLAIM|52|一致|.agents/handoffs/2026-11-12-home-feed-plan.md:221|方案写每天默认 50 次|- 每天最多次数是设置，默认 50 次（和预评一样，前提 14），用量页看得到已用和上限。到上限后新条目标 `unscored`，首页照常。失败的条目 24 小时内不重试。
CLAIM|53|一致|packages/application/src/services/home-urgency.ts:26|默认改成每天 1000 次、1 美元|dailyLimit: 1_000,；dailyCostMicros: 1_000_000,
CLAIM|54|一致|packages/application/src/ports/configuration.ts:374|两个数都能在设置里改|readonly dailyLimit: number;；readonly dailyCostMicros: number;
CLAIM|55|找不到|-|分数不进数据导出。|-|
CLAIM|56|一致|packages/persistence-sqlite/src/data-export/snapshot.ts:231|预评进了导出|const prereviews = withEvidence；? this.#rows(；database,；`SELECT * FROM decision_prereviews WHERE owner_id = @ownerId AND agent_id = @agentId`,；)；
CLAIM|57|一致|packages/application/src/services/home-urgency.ts:26|每天最多 1000 次低价模型调用、1 美元，费用计入模型用量表，用途 `home-urgency`。|dailyLimit: 1_000,；dailyCostMicros: 1_000_000,
CLAIM|58|一致|packages/persistence-sqlite/src/migrations/0095_home_item_scores.sql:30|两个实例同时给同一件事打分时，后写的那次整批被唯一索引拒绝，返回 `URGENCY_STORE_FAILED`，这一批在后写的那个进程里 `retryAfterHours` 小时内不再发|CREATE UNIQUE INDEX home_item_scores_done；ON home_item_scores(owner_id, agent_id, item_key, text_digest)；WHERE status = 'done';
CLAIM|59|一致|packages/application/src/services/home-urgency.ts:348|改了提示词文字，提示词版本号跟着变，但已有的分数不重打；只有文字摘要变了的事才重打。|const fresh = open；.filter(；({ ref }) =>；!scored.has(refKey(ref)) &&；!failedRecently.has(refKey(ref)) &&；!this.#storeFailedAt.has(refKey(ref)),；)；.slice(0, settings.perCall);
CLAIM|60|找不到|-|要让全部开着的事按新提示词重打，目前没有命令。|-|
CLAIM|61|一致|packages/application/src/services/home-urgency.ts:288|主人换了界面语言后，旧审批的模型文字语言对不上，退回通用文字；只有审批内容变了才会按新语言重写。|if (；row === undefined ||；row.approvalRequestId !== input.approvalRequestId ||；row.copyLocale !== input.locale；)；return { sentence: null, affirmLabel: null };
CLAIM|62|一致|packages/gateway-contracts/src/contracts-v2.ts:652|合约的 `HOME_SENTENCE_BASES`、`HOME_RANKS`、`HOME_LABEL_BASES` 各多了一个 `model`|export const HOME_SENTENCE_BASES = ["recorded", "catalog", "model", "none"] as const;；export const HOME_RANKS = ["rule", "deadline", "unscored", "model", "recency"] as const;；export const HOME_LABEL_BASES = ["catalog", "model"] as const;
CLAIM|63|一致|test/integration/home-urgency.test.ts:118|`test/integration/home-urgency.test.ts`：真实 SQLite，经 `ProductionHomeControl` 走完打分、排序、参照、字节确定、重启后顺序不变、规则和到期优先、模型坏回答、24 小时退避、每天次数和费用上限、关闭、文字变了重打|applyMigrations(database, await loadBundledMigrations());；const home = new ProductionHomeControl({
CLAIM|64|不一致|test/integration/home-urgency.test.ts:875|审批文字的正反向（指纹、语言、各语言上限刚好和超一个字、和否定文字相同、本人在场）|it.each([；["one character over the limit", "改到九点四十分", "同意"],；["the same words as the negative button", "不同意", "同意"],；["missing", undefined, "同意"],；["empty", "   ", "同意"],；] as const)(；)；// 该文件只在 zh-CN 上测了刚好和超一个字；ja、en 的对应用例在 packages/application/test/home-urgency.unit.test.ts:198-207
CLAIM|65|一致|test/integration/home-urgency.test.ts:201|模型只在 `ProactiveModelInvoker` 这一层用桩|const model: ProactiveModelInvoker = {
CLAIM|66|一致|packages/application/test/home-urgency.unit.test.ts:47|`packages/application/test/home-urgency.unit.test.ts`：提示词的排列和字节、回答的解析、按钮文字的核对。|it("puts the fixed text first, then scored items, then new items, and the time last", () => {
CLAIM|67|一致|packages/platform-node/test/startup-configuration.unit.test.ts:1786|`packages/platform-node/test/startup-configuration.unit.test.ts`：`runPolicy.homeUrgency` 的默认值和越界拒绝。|it("accepts home urgency scoring settings, fills in the defaults, and refuses values out of range", () => {
CLAIM|68|一致|apps/agent-service/test/prompt-output-contracts.unit.test.ts:63|`apps/agent-service/test/prompt-output-contracts.unit.test.ts`、`npm run check:prompt-catalog`：提示词登记在目录并有对应的解析函数。|parseHomeUrgency: application.parseHomeUrgency,；"home.urgency",
CLAIM|69|找不到|-|`npm run check:egress-redaction` 通过：这次调用走现有的统一出口，没有新增直连模型的地方。|-|
CLAIM|70|找不到|-|没有用真实模型跑过这份提示词，分数和文字的质量没有数据；没有在真实网页上验收（网页的首页界面不在这一步）。|-|

未能核对的部分：外部链接和 Andy 在项目聊天里的原话不在仓库内、不能上网核对；`check:egress-redaction` 等检查是否实际通过也不能运行命令确认。另有一些“没有做、没有命令、没有导出、推送使用、用量页显示”的否定或缺失性说法，仓库里没有可直接逐字引用的代码行，均标为找不到。
