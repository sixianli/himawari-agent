CLAIM|1|一致|packages/application/src/services/home-feed.ts:240|第 1 步已经做了读取层（`packages/application/src/services/home-feed.ts`）|export class HomeFeedService {
CLAIM|2|一致|packages/application/src/services/home-feed.ts:188|命中主人规则的和快到期的排在前面|if (candidate.ruleHit) return "rule";
CLAIM|3|一致|packages/application/src/services/home-feed.ts:190|快到期的排在前面|return "deadline";
CLAIM|4|一致|packages/application/src/services/home-feed.ts:191|其余等主人定的事都标 `unscored`（还没打分）|return scored ? "model" : "unscored";
CLAIM|5|一致|packages/application/src/services/home-feed.ts:213|彼此之间只按到期时间和创建时间排|const deadline = Date.parse(left.deadline) - Date.parse(right.deadline);
CLAIM|6|一致|apps/agent-service/src/production-home.ts:543|审批没有给人看的一句话|...(sentence ? { sentence, sentenceBasis: "model" as const } : NO_SENTENCE),
CLAIM|7|一致|docs/product-vision.md:55|原则顺序：`docs/product-vision.md:55`，“原则冲突时，按序优先：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。”|*原则冲突时，按序优先：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。*
CLAIM|8|一致|.agents/handoffs/2026-11-12-home-feed-plan.md:244|方案定了第 2 步的范围：`.agents/handoffs/2026-11-12-home-feed-plan.md:244`，“打分表、打分调用、审批的一句话和肯定按钮文字。要改表，排队。”|2. 打分表、打分调用、审批的一句话和肯定按钮文字。要改表，排队。
CLAIM|9|一致|.agents/handoffs/2026-11-12-home-feed-plan.md:120|方案说明了为什么用模型：同一文件 `:120`，“哪件事对主人更要紧，是理解意思的判断，现有字段答不了：审批的 `finalRisk` 说的是动作多危险，不是多急”。|哪件事对主人更要紧，是理解意思的判断，现有字段答不了：审批的 `finalRisk` 说的是动作多危险，不是多急；
CLAIM|10|一致|.agents/handoffs/2026-11-12-home-feed-plan.md:125|方案定了读取时的顺序：同一文件 `:125-129`，“命中主人定的规则的……最前”|1. 命中主人定的规则的（例如重要发件人，现有的 `floorRaised`）最前。规则是硬性设定，不交给模型权衡。
CLAIM|11|一致|.agents/handoffs/2026-11-12-home-feed-plan.md:126|方案定了读取时的顺序：“快到期的”|2. 快到期的：离 `deadline` 不到“提前量”的。提前量是一项设置，页面上看得到、能改。
CLAIM|12|一致|.agents/handoffs/2026-11-12-home-feed-plan.md:127|方案定了读取时的顺序：“其余等主人定的，按模型分数从高到低。还没打分的排在这一档最前，标 `unscored`”|3. 其余等主人定的，按模型分数从高到低。还没打分的排在这一档最前，标 `unscored`：一件等主人定的事，宁可早看到。
CLAIM|13|一致|.agents/handoffs/2026-11-12-home-feed-plan.md:130|方案定了模型出问题时的行为：同一文件 `:130`，“模型出错、超时、到每天上限：条目照常返回，只是标 `unscored`。任何条目都不会因为模型出问题而消失或被藏起来。”|- 模型出错、超时、到每天上限：条目照常返回，只是标 `unscored`。任何条目都不会因为模型出问题而消失或被藏起来。
CLAIM|14|一致|.agents/handoffs/2026-11-12-home-feed-plan.md:131|方案定了敏感内容怎么办：同一文件 `:131`，“按现有出口规则不能发给这个模型的，只发种类和到期时间；`restricted` 的一律不发。”|按现有出口规则不能发给这个模型的，只发种类和到期时间；`restricted` 的一律不发。
CLAIM|15|一致|packages/application/src/ports/model-usage.ts:11|模型用量表的“用途”是表约束里的清单：`packages/application/src/ports/model-usage.ts:11-12`，`"review-prereview",`|"review-prereview",
CLAIM|16|一致|packages/application/src/ports/model-usage.ts:12|模型用量表的“用途”是表约束里的清单：`packages/application/src/ports/model-usage.ts:11-12`，`"home-urgency",`|"home-urgency",
CLAIM|17|一致|packages/persistence-sqlite/src/migrations/0095_home_item_scores.sql:69|模型用量表的“用途”是表约束里的清单|purpose TEXT NOT NULL CHECK (
CLAIM|18|一致|packages/persistence-sqlite/src/migrations/0095_home_item_scores.sql:62|加新用途要重建表|DROP TABLE model_usage_observations;
CLAIM|19|一致|packages/persistence-sqlite/src/migrations/0091_decision_prereviews.sql:79|加新用途要重建表，上一次是迁移 0091|CREATE TABLE model_usage_observations_keep AS SELECT * FROM model_usage_observations;
CLAIM|20|一致|packages/application/src/services/review-prereview.ts:43|预评是先例：`packages/application/src/services/review-prereview.ts:43`，`dailyLimit: 50,`|  dailyLimit: 50,
CLAIM|21|一致|docs/adr/0237-model-pre-rates-waiting-decisions.md:49|同 ADR 0237 决定第 1 条，“这张表不许改（触发器拦下 UPDATE）”|这张表不许改（触发器拦下 UPDATE），只在它所属的决策记录或邮件记录被删掉时随之删除。
CLAIM|22|一致|.claude/rules/prompt-prefix.md:67|后台调用的排列规则：`.claude/rules/prompt-prefix.md:67`，“后台调用也是固定的在前、会变的在后。”|15. **后台调用也是固定的在前、会变的在后。**整理记忆、判断邮件、起对话标题这类调用，先放固定的指令，再放这次的数据，最后放当前时间这类每次都变的值。
CLAIM|23|一致|apps/agent-service/src/production-model-composition.ts:126|后台模型调用的统一出口：`apps/agent-service/src/production-model-composition.ts:126`，`proactiveModel(`|  proactiveModel(
CLAIM|24|一致|apps/agent-service/src/production-model-composition.ts:131|它的参数里有 `readonly purpose?: ModelUsagePurpose;`（`:131`）|      readonly purpose?: ModelUsagePurpose;
CLAIM|25|一致|.claude/rules/owner-standing-rules.md:18|禁用贵模型：`.claude/rules/owner-standing-rules.md:18`，“按量付费只用 DeepSeek V4.1 Flash 这类低价模型或免费额度。”|- 禁用贵模型：任何场景（生产、评测、裁判、测试、实验、后台任务）都不得通过按 token 付费的渠道（例如 Vercel、OpenRouter）调用 Claude、OpenAI 或同价位的模型；按量付费只用 DeepSeek V4.1 Flash 这类低价模型或免费额度。代码和评测脚本里不得写死 `anthropic/`、`openai/` 开头的模型名。
CLAIM|26|一致|packages/persistence-sqlite/src/migrations/0095_home_item_scores.sql:1|新表 `home_item_scores`（迁移文件 `packages/persistence-sqlite/src/migrations/0095_home_item_scores.sql`）存每件事的每次打分：条目编号、分数（0 到 1000）、模型写的一句话的引用、模型写的同意按钮文字、这两段文字的语言、模型、提示词版本、条目文字摘要、数据分级、这次调用的费用和耗时|CREATE TABLE home_item_scores (
CLAIM|27|一致|packages/persistence-sqlite/src/migrations/0095_home_item_scores.sql:13|失败也存一行（`status = failed`）带失败代码|  failure_code TEXT CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 128),
CLAIM|28|一致|packages/persistence-sqlite/src/migrations/0095_home_item_scores.sql:48|触发器拦下 UPDATE|CREATE TRIGGER home_item_scores_no_update BEFORE UPDATE ON home_item_scores
CLAIM|29|一致|packages/persistence-sqlite/src/migrations/0095_home_item_scores.sql:51|DELETE 只在所属的主人、agent 或审批已经被删时放行|CREATE TRIGGER home_item_scores_no_delete BEFORE DELETE ON home_item_scores
CLAIM|30|一致|packages/persistence-sqlite/src/migrations/0095_home_item_scores.sql:30|同一件事、同一份文字摘要只能有一行成功记录（唯一索引）|CREATE UNIQUE INDEX home_item_scores_done
CLAIM|31|一致|packages/persistence-sqlite/src/migrations/0095_home_item_scores.sql:73|同一迁移重建 `model_usage_observations`，给用途加 `home-urgency`|      'home-urgency', 'other'
CLAIM|32|一致|packages/application/src/services/home-urgency.ts:31|服务每隔 `checkIntervalSeconds`（默认 60 秒）看一次首页上等主人定的事|  checkIntervalSeconds: 60,
CLAIM|33|一致|packages/application/src/services/home-urgency.ts:351|没有成功记录、或者文字摘要变了的才发给模型|          !scored.has(refKey(ref)) &&
CLAIM|34|一致|packages/application/src/services/home-urgency.ts:28|几件同时出现合成一次调用（每次最多 `perCall` 件，默认 20）|  perCall: 20,
CLAIM|35|一致|packages/application/src/services/home-feed.ts:153|审批的文字摘要用它的内容指纹 `semanticSnapshotHash`|      digestBasis: approval.semanticSnapshotHash,
CLAIM|36|一致|packages/application/src/services/home-feed.ts:163|其他种类用种类、已记录的一句话和到期时间算出的摘要|    digestBasis: JSON.stringify([
CLAIM|37|一致|packages/prompt-catalog/src/review.ts:71|先是提示词目录里的固定文字（`packages/prompt-catalog/src/review.ts` 的 `HOME_URGENCY`）|export const HOME_URGENCY = fixedPrompt({
CLAIM|38|一致|packages/application/src/services/home-urgency.ts:29|最多 `referenceLimit` 条（默认 30）|  referenceLimit: 30,
CLAIM|39|一致|packages/application/src/services/home-urgency.ts:334|“参照”，即还开着、已经打过分的事和它们的分数，按条目编号排序|  open.sort((left, right) => compare(left.candidate.key, right.candidate.key));
CLAIM|40|一致|packages/application/src/services/home-urgency.ts:180|最后一行是当前时间、时区、语言和按钮文字的字数上限|      affirmMax: input.affirmMax,
CLAIM|41|不一致|packages/application/src/services/home-urgency.ts:179|JSON 的键按字典序排|      language: input.locale,
CLAIM|42|一致|packages/application/src/services/home-urgency.ts:103|条目里的事实先过出口遮盖（`maskSensitiveText`）|  if (typeof fact === "string") return maskSensitiveText(fact);
CLAIM|43|一致|packages/application/src/services/home-urgency.ts:330|`restricted` 的条目不发、不存行，一直标 `unscored`|      if (candidate.dataClassification === "restricted" || seen.has(candidate.key)) continue;
CLAIM|44|一致|packages/application/src/services/home-urgency.ts:152|模型不许看某件事的分级时，只发它的种类和到期时间，不要求写文字|    ...(item.disclosed ? { facts: maskFact(item.candidate.facts) } : {}),
CLAIM|45|不一致|packages/application/src/services/home-urgency.ts:390|这次调用的分级取所发条目里最高的一档|        "private",
CLAIM|46|一致|packages/gateway-contracts/src/contracts-v2.ts:653|这五个值就是合约里的 `HOME_RANKS`（`packages/gateway-contracts/src/contracts-v2.ts:653`）|export const HOME_RANKS = ["rule", "deadline", "unscored", "model", "recency"] as const;
CLAIM|47|一致|packages/application/src/services/home-feed.ts:179|规则和到期时间排在模型分数前面|  rule: 0,
CLAIM|48|一致|packages/application/src/services/home-feed.ts:181|还没打分的排在已打分的前面|  unscored: 2,
CLAIM|49|一致|packages/application/src/services/home-feed.ts:301|模型出错、超时、返回读不懂、漏了某个编号、编造编号、到每天上限，条目都照常返回，只是标 `unscored`|      return new Map();
CLAIM|50|一致|packages/application/src/services/home-urgency.ts:32|失败的条目 `retryAfterHours`（默认 24）小时内不再发|  retryAfterHours: 24,
CLAIM|51|一致|packages/application/src/services/home-urgency.ts:432|失败代码只记 `URGENCY_ITEM_INVALID`、`MODEL_FAILED:…`、`URGENCY_STORE_FAILED:…` 这类代码|              : "URGENCY_ITEM_INVALID"
CLAIM|52|一致|packages/application/src/services/home-urgency.ts:26|每天最多 `dailyLimit` 次调用（默认 1000）、`dailyCostMicros` 费用（默认 1000000，即 1 美元）|  dailyLimit: 1_000,
CLAIM|53|一致|packages/persistence-sqlite/src/sqlite-home-urgency-operations.ts:131|都从表里数，重启不会重置|        `SELECT count(*) AS calls, COALESCE(sum(cost), 0) AS costMicros FROM (
CLAIM|54|一致|apps/agent-service/src/service-main.ts:2032|用哪个模型由 `runPolicy.homeUrgency.modelRef` 定，没写就用主动检查的模型；两者都没有就不打分|      const homeUrgencyRef = homeUrgencyConfiguration.modelRef ?? proactiveConfiguration?.modelRef;
CLAIM|55|一致|apps/agent-service/src/service-main.ts:2057|模型经现有的统一出口 `proactiveModel` 调用，用途记 `home-urgency`|                purpose: "home-urgency",
CLAIM|56|一致|packages/platform-node/src/strict-configuration.ts:1364|全部数值都在 `runPolicy.homeUrgency` 里可改，启动时校验范围|    checkIntervalSeconds: [10, 86_400],
CLAIM|57|一致|packages/application/src/services/home-feed.ts:77|审批只有机器字段|export interface HomeApprovalDetail {
CLAIM|58|一致|packages/application/src/services/home-urgency.ts:439|同一次调用让模型写 `sentence`（一句话）和 `affirm`（同意按钮上的字）|        const sentence = wantsCopy ? reply.sentence : null;
CLAIM|59|一致|packages/application/src/services/home-urgency.ts:443|一句话按现有的密封内容方式存，表里只存引用|          sentenceRef = await this.#options.seal.seal({
CLAIM|60|一致|packages/application/src/ports/home-urgency.ts:5|按钮文字不超过 64 个字符，直接存在表里|export const HOME_URGENCY_LABEL_STORE_MAX = 64;
CLAIM|61|一致|packages/application/src/services/home-urgency.ts:291|读取时逐项核对，不合格就退回目录里的通用文字“同意”并标 `catalog`：审批的内容指纹和打分时不同；文字的语言和读的人的语言不同；按钮文字超过这门语言的上限……和否定按钮文字相同；这门语言没有配上限|      row.copyLocale !== input.locale
CLAIM|62|一致|packages/application/src/services/home-urgency.ts:33|按钮文字超过这门语言的上限（`affirmLabelMax`，默认中文 6、日文 8、英文 16 个字符，按用户看到的字符数）|  affirmLabelMax: Object.freeze({ "zh-CN": 6, ja: 8, en: 16 }),
CLAIM|63|一致|apps/agent-service/src/production-home.ts:124|要主人本人在场的审批，按钮仍是通用的“看内容再定”，模型写的字只作为这条的说明|    reviewLabel: ownerPresence ? HOME_TEXT[locale].reviewFirst : null,
CLAIM|64|一致|apps/agent-service/src/production-home.ts:562|否定按钮和其他种类的按钮永远是目录文字|            action(locale, "denied", "negative"),
CLAIM|65|一致|apps/agent-service/src/production-home.ts:715|`ProductionHomeControl.approvalCopy`（`apps/agent-service/src/production-home.ts`）单独可调，给审批编号、内容指纹和语言，返回同一份经过同样核对的文字|  async approvalCopy(input: {
CLAIM|66|一致|packages/persistence-sqlite/src/migrations/0095_home_item_scores.sql:7|审批的行随审批记录级联删除|  approval_request_id TEXT REFERENCES approval_requests(id) ON DELETE CASCADE,
CLAIM|67|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:1046|按规定流程删除数据时，审批的一句话所引用的密封内容一并清掉（`packages/persistence-sqlite/src/sqlite-governed-deletion.ts`）|        `SELECT sentence_ref FROM home_item_scores
CLAIM|68|不一致|packages/persistence-sqlite/src/migrations/0095_home_item_scores.sql:14|其他种类的行不含内容，只有条目编号、分数和摘要|  model_ref TEXT NOT NULL CHECK (length(model_ref) BETWEEN 1 AND 256),
CLAIM|69|一致|packages/persistence-sqlite/src/migrations/0095_home_item_scores.sql:3|其他种类的行……来源被删后这些行留着，只在主人或 agent 整个被删时才删|  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
CLAIM|70|一致|packages/application/src/services/home-feed.ts:87|首页读取层拿到的提醒不带这个值|export interface HomeUpcoming {
CLAIM|71|一致|.agents/handoffs/2026-11-12-home-feed-plan.md:221|方案写每天默认 50 次|- 每天最多次数是设置，默认 50 次（和预评一样，前提 14），用量页看得到已用和上限。到上限后新条目标 `unscored`，首页照常。失败的条目 24 小时内不重试。
CLAIM|72|一致|packages/persistence-sqlite/src/data-export/export.ts:797|预评进了导出|    prereviews: snapshot.prereviews.map((row) => ({
CLAIM|73|一致|packages/application/src/services/home-urgency.ts:27|每天最多 1000 次低价模型调用、1 美元，费用计入模型用量表，用途 `home-urgency`|  dailyCostMicros: 1_000_000,
CLAIM|74|一致|packages/application/src/services/home-urgency.ts:466|两个实例同时给同一件事打分时，后写的那次整批被唯一索引拒绝，记成 `URGENCY_STORE_FAILED`|        failures: [`URGENCY_STORE_FAILED:${failureCode(error)}`],
CLAIM|75|不一致|packages/application/src/services/home-urgency.ts:462|下一次检查时只补还缺的|      for (const { ref } of fresh) this.#storeFailedAt.set(refKey(ref), nowMs);
CLAIM|76|一致|packages/application/src/services/home-urgency.ts:291|主人换了界面语言后，旧审批的模型文字语言对不上，退回通用文字|      row.copyLocale !== input.locale
CLAIM|77|一致|packages/gateway-contracts/src/contracts-v2.ts:699|合约的 `HOME_SENTENCE_BASES`、`HOME_RANKS`、`HOME_LABEL_BASES` 各多了一个 `model`|export const HOME_LABEL_BASES = ["catalog", "model"] as const;
CLAIM|78|一致|test/integration/home-urgency.test.ts:253|`test/integration/home-urgency.test.ts`：真实 SQLite，经 `ProductionHomeControl` 走完打分、排序、参照、字节确定、重启后顺序不变、规则和到期优先、模型坏回答、24 小时退避、每天次数和费用上限、关闭、文字变了重打、审批文字的正反向|      const home = new ProductionHomeControl({
CLAIM|79|一致|packages/application/test/home-urgency.unit.test.ts:46|`packages/application/test/home-urgency.unit.test.ts`：提示词的排列和字节、回答的解析、按钮文字的核对|describe("[home-urgency] scoring prompt", () => {
CLAIM|80|一致|packages/platform-node/test/startup-configuration.unit.test.ts:1794|`packages/platform-node/test/startup-configuration.unit.test.ts`：`runPolicy.homeUrgency` 的默认值和越界拒绝|  raw["runPolicy"] = { ...policy, homeUrgency: {} };
CLAIM|81|一致|apps/agent-service/test/prompt-output-contracts.unit.test.ts:162|`apps/agent-service/test/prompt-output-contracts.unit.test.ts`、`npm run check:prompt-catalog`：提示词登记在目录并有对应的解析函数|  it("home urgency: accepts the items JSON the prompt asks for, and rejects a renamed key and plain text", () => {
CLAIM|82|找不到|-|周报的“模型排第一的是不是主人最先处理的”没有做|-
CLAIM|83|找不到|-|用量页只多了一个用途名；没有做“今天已用几次、上限几次”的显示|-
CLAIM|84|找不到|-|分数不进数据导出|-
CLAIM|85|找不到|-|没有用真实模型跑过这份提示词，分数和文字的质量没有数据；没有在真实网页上验收|-

未核实的主要是外部网站和第三方产品的说法、上列几条否定性说法（周报指标、用量页显示、分数不进导出、真实模型和网页验收），以及 `check:egress-redaction` 的实际运行结果；我只确认了脚本存在，没有运行它来验证“通过”。
