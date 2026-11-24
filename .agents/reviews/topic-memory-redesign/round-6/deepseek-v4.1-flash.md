CLAIM|1|一致|packages/application/src/services/context-formation-service.ts:282|Himawari 现在由程序和单独的模型调用替主模型（和 Andy 对话的那个模型）决定它能看到什么、记什么|.slice(0, request.maxSelectedMemories)
CLAIM|2|一致|scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:14|每轮程序搜 20 条|"memoryLimit": 20,
CLAIM|3|一致|scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:15|最多带 5 条记忆|"maxSelectedMemories": 5,
CLAIM|4|一致|packages/application/src/services/owner-profile-service.ts:20|外加 2000 字的主人资料|export const OWNER_PROFILE_CHARACTER_BUDGET = 2000;
CLAIM|5|一致|apps/agent-service/src/production-memory-recall.ts:304|旧对话只能搜到每日摘要|summary: text,
CLAIM|6|一致|apps/agent-service/src/production-titled-runtime.ts:50|每轮之后另一次模型调用（后台抽取）|memoryAdmission = memoryCapture
CLAIM|7|一致|apps/agent-service/src/production-memory-capture.ts:1261|记不记由每轮之后另一次模型调用（后台抽取）决定|const output = await this.options.generate(plan.request, plan.prompt, onAdmitted, call);
CLAIM|8|一致|packages/prompt-catalog/src/chat.ts:17|主模型自己不能存|主人告诉你的事，系统会在本轮回答后尝试整理进长期记忆，但整理可能失败，你看不到结果。
CLAIM|9|一致|scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:14|`scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json` 第 14、15 行是 `"memoryLimit": 20`、`"maxSelectedMemories": 5`|"memoryLimit": 20,
CLAIM|10|一致|scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:15|`scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json` 第 14、15 行是 `"memoryLimit": 20`、`"maxSelectedMemories": 5`|"maxSelectedMemories": 5,
CLAIM|11|一致|packages/application/src/services/owner-profile-service.ts:20|`packages/application/src/services/owner-profile-service.ts` 第 20、24 行是 `OWNER_PROFILE_CHARACTER_BUDGET = 2000`、`PROFILE_MINIMUM_IMPORTANCE = 600`|export const OWNER_PROFILE_CHARACTER_BUDGET = 2000;
CLAIM|12|一致|packages/application/src/services/owner-profile-service.ts:24|`packages/application/src/services/owner-profile-service.ts` 第 20、24 行是 `OWNER_PROFILE_CHARACTER_BUDGET = 2000`、`PROFILE_MINIMUM_IMPORTANCE = 600`|const PROFILE_MINIMUM_IMPORTANCE = 600;
CLAIM|13|一致|apps/agent-service/src/production-memory-recall.ts:302|`apps/agent-service/src/production-memory-recall.ts` 返回 `{ day, source, summary: text }`|day: episode.day,
CLAIM|14|一致|apps/agent-service/src/production-memory-recall.ts:303|`apps/agent-service/src/production-memory-recall.ts` 返回 `{ day, source, summary: text }`|source: episode.source,
CLAIM|15|一致|apps/agent-service/src/production-memory-recall.ts:304|`apps/agent-service/src/production-memory-recall.ts` 返回 `{ day, source, summary: text }`|summary: text,
CLAIM|16|一致|packages/memory-engine/src/episodes.ts:287|text 是每日摘要正文|source: "day_summary",
CLAIM|17|一致|packages/prompt-catalog/src/chat.ts:17|`packages/prompt-catalog/src/chat.ts` 第 17 行“主人告诉你的事，系统会在本轮回答后尝试整理进长期记忆，但整理可能失败，你看不到结果”|主人告诉你的事，系统会在本轮回答后尝试整理进长期记忆，但整理可能失败，你看不到结果。
CLAIM|18|一致|docs/adr/0142-keep-background-memory-capture.md:32|主模型调 `memory_remember` 记下 93%、92%|｜ 该记的整条记下 ｜ 90% ｜ 93%、92% ｜ 67% ｜
CLAIM|19|一致|docs/adr/0142-keep-background-memory-capture.md:34|误记 6.7%、5%|｜ 不该记的却记了 ｜ 0% ｜ 6.7%、5% ｜ 0% ｜
CLAIM|20|一致|docs/adr/0142-keep-background-memory-capture.md:35|密钥被记下 2、1 条|｜ 密钥被记下 ｜ 0 ｜ 2、1 ｜ 0 ｜
CLAIM|21|一致|scripts/evals/memory-capture-live.eval.ts:197|那个工具没接后台抽取那条路上的校验|if (typeof args.text !== "string" || args.text.length === 0) continue;
CLAIM|22|一致|.agents/instructions/prompt-prefix.md:36|第 36 行“已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加”|已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加
CLAIM|23|一致|.agents/instructions/prompt-prefix.md:42|第 42 行“系统提示和工具按对话冻结”|系统提示和工具按对话冻结
CLAIM|24|一致|scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:79|生产对话模型 DeepSeek V4.1 Flash|"name": "DeepSeek V4.1 Flash",
CLAIM|25|一致|scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:87|同一配置模板第 87 行 `"contextWindow": 1000000`|"contextWindow": 1000000,
CLAIM|26|一致|apps/agent-service/src/production-memory-capture.ts:393|出处原话确实是主人说的|input.ownerMessage !== undefined && quoteFromOwnerMessage(quote, input.ownerMessage);
CLAIM|27|一致|apps/agent-service/src/production-memory-capture.ts:379|密钥扫描|const requested = classificationWithIdentifiers(
CLAIM|28|一致|apps/agent-service/src/production-memory-capture.ts:669|人物|if (candidate.people?.length && options.book)
CLAIM|29|一致|apps/agent-service/src/production-memory-capture.ts:657|提醒|if (candidate.reminder && options.reminders)
CLAIM|30|一致|apps/agent-service/src/production-memory-capture.ts:647|审计|audit: { record: async (record) => options.onAudit(record) },
CLAIM|31|一致|docs/adr/0185-mark-passwords-and-keys-sensitive-instead-of-dropping-them.md:45|ADR 0185 里“明说记住就存成敏感”这一条|主人明说“记住”的候选直接存，否则进待批准（原有的 `explicit` 规则）。
CLAIM|32|一致|docs/adr/0193-memory-is-visible-to-the-model.md:58|ADR 0193、0196 里为敏感记忆设的上限|“模型能看到什么”由固定的模型可见上限决定，上限是 sensitive，写在代码里
CLAIM|33|一致|docs/adr/0196-index-sensitive-memory-after-masking-and-stop-idle-archiving.md:10|ADR 0193、0196 里为敏感记忆设的遮盖|# ADR 0196：敏感记忆遮盖后进检索目录，停掉“久不用就归档”
CLAIM|34|一致|packages/sensitive-capture/README.md:12|发给模型前遮盖密码、密钥、验证码照旧|｜ `src/redaction.ts` ｜ 发给模型前的遮盖（`redactForEgress`）：机器密钥、密码、验证码、银行卡、证件号，生成稳定的占位符 ｜
CLAIM|35|一致|packages/persistence-sqlite/src/migrations/0052_memory_engine.sql:18|Himawari 已有数据库、历史版本和出处|CREATE TABLE memory_search_index (
CLAIM|36|一致|packages/persistence-sqlite/src/migrations/0065_memory_history.sql:3|Himawari 已有数据库、历史版本和出处|CREATE TABLE memory_history_events (
CLAIM|37|一致|packages/application/src/ports/memory-projection.ts:97|Himawari 已有数据库、历史版本和出处|readonly sourceRefs: readonly string[];

未核对方案中关于 Claude、ChatGPT、Anthropic、LongMemEval、MemDelta 等外部网站、论文和第三方产品的说法，以及属于将来实施计划的说法（比例上限、做梦、实时存、四步上线、删除旧对话等）。生产实际部署配置是否逐字等于仓库中的模板也未核实。
