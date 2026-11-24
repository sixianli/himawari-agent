CLAIM|1|一致|packages/prompt-catalog/src/chat.ts:15|由程序和单独的模型调用替主模型决定它能看到什么|- 记忆是你最重要的能力。每轮开始前，系统会把主人档案、主人定下的要求、近期安排和与本轮相关的长期记忆作为资料交给你。
CLAIM|2|一致|apps/agent-service/src/production-memory-capture.ts:63|由程序和单独的模型调用替主模型决定它记什么|export const MEMORY_CAPTURE_POLICY_VERSION = "memory-capture:v5";
CLAIM|3|一致|scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:14|每轮程序搜 20 条|    "memoryLimit": 20,
CLAIM|4|一致|scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:15|最多带 5 条记忆|    "maxSelectedMemories": 5,
CLAIM|5|一致|packages/application/src/services/owner-profile-service.ts:20|外加 2000 字的主人资料|export const OWNER_PROFILE_CHARACTER_BUDGET = 2000;
CLAIM|6|一致|apps/agent-service/src/production-memory-recall.ts:301|旧对话只能搜到每日摘要|      conversations: episodes.map(({ episode, text }) => ({\n        day: episode.day,\n        source: episode.source,\n        summary: text,\n      })),
CLAIM|7|一致|docs/adr/0142-keep-background-memory-capture.md:26|记不记由每轮之后另一次模型调用（后台抽取）决定|现在每轮对话结束后，`apps/agent-service/src/production-memory-capture.ts` 会多调一次模型（后台抽取，`memory-capture:v5`），判断这轮有没有值得长期记住的话。
CLAIM|8|一致|packages/prompt-catalog/src/chat.ts:17|主模型自己不能存|所以不要说“已经记住了”“已记入记忆”，可以说“我会尽量记住”。也不要为了保存记忆去写文件冒充。
CLAIM|9|一致|scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:14|第 14、15 行是 `"memoryLimit": 20`|    "memoryLimit": 20,
CLAIM|10|一致|scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:15|`"maxSelectedMemories": 5`|    "maxSelectedMemories": 5,
CLAIM|11|一致|packages/application/src/services/owner-profile-service.ts:20|OWNER_PROFILE_CHARACTER_BUDGET = 2000|export const OWNER_PROFILE_CHARACTER_BUDGET = 2000;
CLAIM|12|一致|packages/application/src/services/owner-profile-service.ts:24|PROFILE_MINIMUM_IMPORTANCE = 600|const PROFILE_MINIMUM_IMPORTANCE = 600;
CLAIM|13|一致|apps/agent-service/src/production-memory-recall.ts:301|返回 `{ day, source, summary: text }`|      conversations: episodes.map(({ episode, text }) => ({\n        day: episode.day,\n        source: episode.source,\n        summary: text,\n      })),
CLAIM|14|一致|packages/memory-engine/src/episodes.ts:287|text 是每日摘要正文|      source: "day_summary",
CLAIM|15|一致|packages/prompt-catalog/src/chat.ts:17|“主人告诉你的事，系统会在本轮回答后尝试整理进长期记忆，但整理可能失败，你看不到结果”。|- 主人告诉你的事，系统会在本轮回答后尝试整理进长期记忆，但整理可能失败，你看不到结果。
CLAIM|16|一致|docs/adr/0142-keep-background-memory-capture.md:32|主模型调 `memory_remember` 记下 93%、92%|该记的整条记下 | 90% | 93%、92% | 67%
CLAIM|17|一致|docs/adr/0142-keep-background-memory-capture.md:34|误记 6.7%、5%|不该记的却记了 | 0% | 6.7%、5% | 0%
CLAIM|18|一致|docs/adr/0142-keep-background-memory-capture.md:35|密钥被记下 2、1 条|密钥被记下 | 0 | 2、1 | 0
CLAIM|19|一致|scripts/evals/memory-capture-live.eval.ts:193|那个工具没接后台抽取那条路上的校验|  for (const call of calls) {\n    if (call.function?.name !== "memory_remember") continue;\n    try {\n      const args = JSON.parse(call.function.arguments);\n      if (typeof args.text !== "string" || args.text.length === 0) continue;\n      candidates.push({
CLAIM|20|一致|.agents/instructions/prompt-prefix.md:36|发给模型的内容只追加|4. **已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。**
CLAIM|21|一致|.agents/instructions/prompt-prefix.md:42|系统提示和工具按对话冻结|6. **系统提示和工具按对话冻结**（[ADR 0165](../../docs/adr/0165-freeze-the-request-head-per-conversation.md)）。同一对话一直沿用第一次发出时的字节。
CLAIM|22|一致|scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:87|同一配置模板第 87 行 `"contextWindow": 1000000`|      "contextWindow": 1000000,
CLAIM|23|一致|docs/adr/0142-keep-background-memory-capture.md:6|取代 ADR 0142|superseded_by: docs/adr/0286-the-main-model-reads-and-writes-memory-itself.md
CLAIM|24|一致|apps/agent-service/src/production-memory-capture.ts:392|写入走后台抽取那条路上已有的校验：出处原话确实是主人说的|    const evidenceVerified =\n      input.ownerMessage !== undefined && quoteFromOwnerMessage(quote, input.ownerMessage);
CLAIM|25|一致|apps/agent-service/src/production-memory-capture.ts:379|写入走后台抽取那条路上已有的校验：密钥扫描|    const requested = classificationWithIdentifiers(\n      quote,\n      classificationWithIdentifiers(\n        text,
CLAIM|26|一致|apps/agent-service/src/production-memory-capture.ts:427|写入走后台抽取那条路上已有的校验：人物|                (entity) => entity.length > 0 && entity.length <= 64 && isSafeToIndex(entity),
CLAIM|27|一致|apps/agent-service/src/production-memory-capture.ts:491|写入走后台抽取那条路上已有的校验：提醒|        : reminderSchedule(value["dueAt"], value["repeat"], input.sentAt, input.timeZone);
CLAIM|28|一致|apps/agent-service/src/production-memory-capture.ts:1175|写入走后台抽取那条路上已有的校验：审计|    const audit = (outcome: MemoryExtractionAuditRecord["outcome"]) =>
CLAIM|29|一致|docs/adr/0185-mark-passwords-and-keys-sensitive-instead-of-dropping-them.md:45|修改 ADR 0185 里“明说记住就存成敏感”这一条|主人明说“记住”的候选直接存，否则进待批准（原有的 `explicit` 规则）。
CLAIM|30|一致|docs/adr/0193-memory-is-visible-to-the-model.md:58|ADR 0193、0196 里为敏感记忆设的上限|1. **两套分级分开。**“模型能看到什么”由固定的模型可见上限决定，上限是 sensitive，写在代码里（`packages/application/src/services/model-visibility.ts` 的 `modelVisibleCeiling()`），不再可配置；restricted 永远不给模型。
CLAIM|31|一致|docs/adr/0196-index-sensitive-memory-after-masking-and-stop-idle-archiving.md:55|ADR 0193、0196 里为敏感记忆设的遮盖|2. **建词表之前先遮盖，再丢掉像密钥的词**（`maskForIndex`，在 `packages/sensitive-capture/src/secret-like.ts`）。
CLAIM|32|一致|packages/prompt-catalog/src/chat.ts:256|发给模型前遮盖密码、密钥、验证码照旧|文中形如 [密码#abcdefgh]、[验证码#abcdefgh]、[银行卡 尾号1111#abcdefgh]、[证件号#abcdefgh]、[密钥] 的方括号内容，是系统遮住的真实敏感信息，同一个值始终是同一个编号。
CLAIM|33|一致|packages/persistence-sqlite/src/sqlite-memory-operations.ts:81|Himawari 已有数据库、历史版本|FROM memory_history_events h JOIN memory_records m ON m.id = h.memory_id`;
CLAIM|34|一致|apps/agent-service/src/production-memory-capture.ts:501|Himawari 已有出处|      sourceRefs: [input.sourceRef, ...(input.extraSourceRefs ?? [])],

未核实：业界做法里对 Claude、ChatGPT、Anthropic、LongMemEval、MemDelta 等外部网站和论文的说法以及方案后果中“随统一收件箱第 1 步全部删除”所指的跨文档计划，均不在本次读到的仓库文件内。
