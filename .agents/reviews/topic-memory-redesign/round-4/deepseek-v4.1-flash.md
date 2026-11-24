CLAIM|1|一致|packages/application/src/services/context-formation-service.ts:282|由程序和单独的模型调用替主模型（和 Andy 对话的那个模型）决定它能看到什么、记什么|      .slice(0, request.maxSelectedMemories)
CLAIM|2|一致|scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:14|每轮程序搜 20 条|    "memoryLimit": 20,
CLAIM|3|一致|scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:15|最多带 5 条记忆|    "maxSelectedMemories": 5,
CLAIM|4|一致|packages/application/src/services/owner-profile-service.ts:20|外加 2000 字的主人资料|export const OWNER_PROFILE_CHARACTER_BUDGET = 2000;
CLAIM|5|一致|packages/memory-engine/src/episodes.ts:287|旧对话只能搜到每日摘要|      source: "day_summary",
CLAIM|6|一致|apps/agent-service/src/production-memory-capture.ts:1261|记不记由每轮之后另一次模型调用（后台抽取）决定|      const output = await this.options.generate(plan.request, plan.prompt, onAdmitted, call);
CLAIM|7|一致|packages/prompt-catalog/src/chat.ts:17|主模型自己不能存|    "- 主人告诉你的事，系统会在本轮回答后尝试整理进长期记忆，但整理可能失败，你看不到结果。所以不要说“已经记住了”“已记入记忆”，可以说“我会尽量记住”。也不要为了保存记忆去写文件冒充。",
CLAIM|8|一致|scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:14|第 14、15 行是 `"memoryLimit": 20`、`"maxSelectedMemories": 5`|    "memoryLimit": 20,
CLAIM|9|一致|scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:15|第 14、15 行是 `"memoryLimit": 20`、`"maxSelectedMemories": 5`|    "maxSelectedMemories": 5,
CLAIM|10|一致|packages/application/src/services/owner-profile-service.ts:20|第 20、24 行是 `OWNER_PROFILE_CHARACTER_BUDGET = 2000`、`PROFILE_MINIMUM_IMPORTANCE = 600`|export const OWNER_PROFILE_CHARACTER_BUDGET = 2000;
CLAIM|11|一致|packages/application/src/services/owner-profile-service.ts:24|第 20、24 行是 `OWNER_PROFILE_CHARACTER_BUDGET = 2000`、`PROFILE_MINIMUM_IMPORTANCE = 600`|const PROFILE_MINIMUM_IMPORTANCE = 600;
CLAIM|12|一致|apps/agent-service/src/production-memory-recall.ts:303|返回 `{ day, source, summary: text }`|        day: episode.day,
CLAIM|13|一致|apps/agent-service/src/production-memory-recall.ts:304|返回 `{ day, source, summary: text }`|        source: episode.source,
CLAIM|14|一致|apps/agent-service/src/production-memory-recall.ts:305|返回 `{ day, source, summary: text }`|        summary: text,
CLAIM|15|一致|packages/memory-engine/src/episodes.ts:292|text 是每日摘要正文|      text: summary,
CLAIM|16|一致|packages/prompt-catalog/src/chat.ts:17|主模型被告知自己不能记：`packages/prompt-catalog/src/chat.ts` 第 17 行“主人告诉你的事，系统会在本轮回答后尝试整理进长期记忆，但整理可能失败，你看不到结果”|    "- 主人告诉你的事，系统会在本轮回答后尝试整理进长期记忆，但整理可能失败，你看不到结果。所以不要说“已经记住了”“已记入记忆”，可以说“我会尽量记住”。也不要为了保存记忆去写文件冒充。",
CLAIM|17|一致|docs/adr/0142-keep-background-memory-capture.md:32|主模型调 `memory_remember` 记下 93%、92%|该记的整条记下 | 90% | 93%、92% | 67% |
CLAIM|18|一致|docs/adr/0142-keep-background-memory-capture.md:34|误记 6.7%、5%|不该记的却记了 | 0% | 6.7%、5% | 0% |
CLAIM|19|一致|docs/adr/0142-keep-background-memory-capture.md:35|密钥被记下 2、1 条|密钥被记下 | 0 | 2、1 | 0 |
CLAIM|20|一致|scripts/evals/memory-capture-live.eval.ts:196|那个工具没接后台抽取那条路上的校验|      const args = JSON.parse(call.function.arguments);
CLAIM|21|一致|.agents/instructions/prompt-prefix.md:36|发给模型的内容只追加|4. **已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。**
CLAIM|22|一致|.agents/instructions/prompt-prefix.md:42|系统提示和工具按对话冻结|6. **系统提示和工具按对话冻结**（[ADR 0165](docs/adr/0165-freeze-the-request-head-per-conversation.md)）。
CLAIM|23|一致|scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:79|生产对话模型 DeepSeek V4.1 Flash|      "name": "DeepSeek V4.1 Flash",
CLAIM|24|一致|scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:87|同一配置模板第 87 行 `"contextWindow": 1000000`|      "contextWindow": 1000000,
CLAIM|25|一致|docs/adr/0185-mark-passwords-and-keys-sensitive-instead-of-dropping-them.md:12|修改 ADR 0185 里“明说记住就存成敏感”这一条|> 2026-11-24 补：密码、密钥“明说记住就存成敏感”已由 [ADR 0286](0286-the-main-model-reads-and-writes-memory-itself.md) 改为一律不存；证件号、银行卡号当普通信息记，不再标敏感。
CLAIM|26|一致|docs/adr/0193-memory-is-visible-to-the-model.md:10|ADR 0193、0196 里为敏感记忆设的上限和遮盖|# ADR 0193：存入记忆的内容必须能被模型看到（模型可见上限和运行分级分开）
CLAIM|27|一致|docs/adr/0196-index-sensitive-memory-after-masking-and-stop-idle-archiving.md:10|ADR 0193、0196 里为敏感记忆设的上限和遮盖|# ADR 0196：敏感记忆遮盖后进检索目录，停掉“久不用就归档”
CLAIM|28|一致|docs/adr/0231-review-past-conversations-to-fix-memory.md:10|回看（ADR 0231）|# ADR 0231：后台回看过去的对话，补记漏掉的记忆、标出被取代的旧记忆
CLAIM|29|一致|packages/application/src/services/model-egress.ts:569|发给模型前遮盖密码、密钥、验证码照旧|    return redactForEgress(value, options);
CLAIM|30|一致|docs/adr/0196-index-sensitive-memory-after-masking-and-stop-idle-archiving.md:47|Himawari 已有数据库|词表是明文的 SQLite 全文表，记忆正文是加密存的；所以进词表的词等于把这部分内容以明文写到磁盘上。
CLAIM|31|一致|packages/application/src/ports/memory-projection.ts:141|已有历史版本|export interface MemoryHistoryEvent {
CLAIM|32|一致|packages/application/src/ports/memory-projection.ts:97|已有出处|  readonly sourceRefs: readonly string[];

未核实：业界做法、论文数字等外部网站内容，以及方案里的未来上线步骤和评测计划；`/mnt/project-files/memory-capture-eval/report.md` 不在仓库内，我未读取，只核对了 ADR 0142 表里的数字。
