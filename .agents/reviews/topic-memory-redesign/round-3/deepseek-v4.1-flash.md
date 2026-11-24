CLAIM|1|一致|docs/product-vision.md:59|愿景原则 3：“记忆是所有决策的主要输入，必须有单一权威源，且我可查看、编辑与删除……推断带来源、时间与置信度；遗忘与纠正同样是记忆的功能……规则不是记忆，是硬性设定”（docs/product-vision.md:59）。|3. **记忆即产品** — 记忆是所有决策的主要输入，必须有单一权威源，且我可查看、编辑与删除。记忆区分事实、偏好与推断，推断带来源、时间与置信度；遗忘与纠正同样是记忆的功能，纠正应传播到受其影响的推断与行为。规则不是记忆，是硬性设定：记忆只保存一条规则的出处和修改历史；规则本身写进程序、必定执行，每条都有回归测试守着。
CLAIM|2|一致|scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:14|每轮程序搜 20 条：上线配置模板 `"memoryLimit": 20`|    "memoryLimit": 20,
CLAIM|3|一致|scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:15|最多带 5 条：`"maxSelectedMemories": 5`（scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:14-15）|    "maxSelectedMemories": 5,
CLAIM|4|一致|packages/application/src/services/context-formation-service.ts:282|context-formation-service.ts:281-282 `.slice(0, request.maxSelectedMemories)`|      .slice(0, request.maxSelectedMemories)
CLAIM|5|一致|packages/application/src/services/owner-profile-service.ts:20|主人资料块 `OWNER_PROFILE_CHARACTER_BUDGET = 2000`|export const OWNER_PROFILE_CHARACTER_BUDGET = 2000;
CLAIM|6|一致|packages/application/src/services/owner-profile-service.ts:24|`PROFILE_MINIMUM_IMPORTANCE = 600`（packages/application/src/services/owner-profile-service.ts:20,24）|const PROFILE_MINIMUM_IMPORTANCE = 600;
CLAIM|7|一致|packages/application/src/services/owner-profile-service.ts:217|规则从记忆里取：同文件 216-219 行 `category === "rule"`|      eligible.filter((memory) => memory.attributes?.category === "rule"),
CLAIM|8|一致|apps/agent-service/src/production-tool-actions.ts:247|主模型唯一的记忆工具是读工具 memory.recall|    tool: "recall",\n    family: "builtin",\n    capabilityRef: MEMORY_RECALL_CAPABILITY_REF,
CLAIM|9|一致|apps/agent-service/src/production-memory-recall.ts:41|`maximum: 10`（apps/agent-service/src/production-memory-recall.ts:24,41,289）|        limit: { type: "integer", minimum: 1, maximum: 10 },
CLAIM|10|一致|apps/agent-service/src/production-memory-recall.ts:289|对话摘要最多 5 段|            limit: Math.min(5, input.limit),
CLAIM|11|一致|packages/prompt-catalog/src/tools.ts:36|工具说明“查主人的长期记忆和以前的对话摘要”（packages/prompt-catalog/src/tools.ts:36）|  text: "查主人的长期记忆和以前的对话摘要。主人问到以前说过的事、某天或某段时间发生过什么、以前的情况（换手机前、搬家前）时使用。
CLAIM|12|一致|apps/agent-service/src/production-memory-capture.ts:64|`MAXIMUM_SOURCE_CHARACTERS = 6000`|const MAXIMUM_SOURCE_CHARACTERS = 6000;
CLAIM|13|一致|apps/agent-service/src/production-memory-capture.ts:65|`MAXIMUM_RECENT_MEMORIES = 20`|const MAXIMUM_RECENT_MEMORIES = 20;
CLAIM|14|一致|apps/agent-service/src/production-memory-capture.ts:76|`MAXIMUM_RELEVANT_MEMORIES = 10`|const MAXIMUM_RELEVANT_MEMORIES = 10;
CLAIM|15|不一致|apps/agent-service/src/production-memory-capture.ts:78|`MAXIMUM_CANDIDATES = 8`（apps/agent-service/src/production-memory-capture.ts:64-77）|const MAXIMUM_CANDIDATES = 8;
CLAIM|16|一致|apps/agent-service/src/production-memory-capture.ts:40|另有确认裁判 `MEMORY_CONFIRMATION_JUDGE`（第 40 行）|  MEMORY_CONFIRMATION_JUDGE,
CLAIM|17|一致|apps/agent-service/src/production-titled-runtime.ts:49|写记忆靠每轮之后另一次模型调用|          if (memoryCapture)\n            memoryAdmission = memoryCapture\n              .start(request)
CLAIM|18|一致|apps/agent-service/src/production-memory-recall.ts:304|召回给的旧对话只有摘要|      conversations: episodes.map(({ episode, text }) => ({\n        day: episode.day,\n        source: episode.source,\n        summary: text,\n      })),
CLAIM|19|不一致|apps/agent-service/src/production-memory-recall.ts:304|production-memory-recall.ts:301-305 返回 `episode.summary`|        summary: text,
CLAIM|20|一致|.agents/instructions/prompt-prefix.md:36|发给模型的内容只追加|4. **已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。**
CLAIM|21|一致|.agents/instructions/prompt-prefix.md:28|每轮会变的放最后一条消息|2. **每轮都会变的内容只放在最后一条用户消息里。**例如当前时间、本轮选中的记忆、本轮资料、工具状态、运行环境说明。系统提示和工具定义里不得出现会变的值，例如时间、日期、路径、服务商名、额度、版本号、哈希。
CLAIM|22|一致|.agents/instructions/prompt-prefix.md:42|系统提示和工具按对话冻结|6. **系统提示和工具按对话冻结**（[ADR 0165](../../docs/adr/0165-freeze-the-request-head-per-conversation.md)）。同一对话一直沿用第一次发出时的字节。
CLAIM|23|一致|.claude/rules/owner-standing-rules.md:62|理解用户意思交给模型，程序只做校验（.claude/rules/owner-standing-rules.md:62）|- Andy 2026-11-12 定、2026-11-13 补充（[ADR 0249](../../docs/adr/0249-the-model-judges-meaning-where-word-lists-guessed-it.md)）：判断用户一句话的意图、时效、是否明说、两句话是不是同一件事，一律交给模型，程序只做校验（原话是否逐字出自主人、格式、额度、白名单）。
CLAIM|24|一致|docs/adr/0231-review-past-conversations-to-fix-memory.md:10|已有、要复用的：每日回看对话补记忆（docs/adr/0231）|# ADR 0231：后台回看过去的对话，补记漏掉的记忆、标出被取代的旧记忆
CLAIM|25|一致|docs/adr/0232-memory-corrections-flag-derived-memories-and-recheck-rules.md:11|纠正传播和规则待复核（docs/adr/0232）|# ADR 0232：改了记忆，沿依据链标出推出来的记忆和规则；规则由模型重读来源后自动核对，对不上就暂停
CLAIM|26|一致|docs/adr/0278-tasks-the-owner-agreed-to-ask-before-writing-after-external-content.md:11|外部内容之后写操作先问（docs/adr/0278）|# ADR 0278：主人同意过的任务读到外部内容后，写操作改成问主人
CLAIM|27|一致|docs/adr/0200-portable-export-of-memories-and-decisions.md:10|记忆可携带导出格式（docs/adr/0200）|# ADR 0200：长期记忆与决定记录可以导出，也可以再导入
CLAIM|28|一致|docs/adr/0186-memory-jumps-to-the-owners-original-message.md:10|记忆跳回原话（docs/adr/0186）|# ADR 0186：记忆详情能跳到来源对话里的那句原话，找不到的显示“来源已不可查”并计数
CLAIM|29|一致|scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:15|主模型每轮只看到检索器挑的 5 条|    "maxSelectedMemories": 5,
CLAIM|30|一致|packages/application/src/services/owner-profile-service.ts:20|主模型每轮只看到……2000 字资料|export const OWNER_PROFILE_CHARACTER_BUDGET = 2000;
CLAIM|31|找不到|-|主模型不知道自己还记着什么，也没法“再看更多”“打开出处”|-
CLAIM|32|一致|packages/prompt-catalog/src/chat.ts:17|主模型不能写记忆|    "- 主人告诉你的事，系统会在本轮回答后尝试整理进长期记忆，但整理可能失败，你看不到结果。所以不要说“已经记住了”“已记入记忆”，可以说“我会尽量记住”。也不要为了保存记忆去写文件冒充。",
CLAIM|33|一致|apps/agent-service/src/production-memory-capture.ts:1197|记不记、记成什么，由每轮之后一个单独调用决定|      prompt: memoryCapturePrompt(
CLAIM|34|一致|apps/agent-service/src/production-memory-capture.ts:234|这个单独调用只看 6000 字|      ownerMessage: message.slice(0, MAXIMUM_SOURCE_CHARACTERS),
CLAIM|35|一致|apps/agent-service/src/production-memory-capture.ts:1120|这个单独调用只看 30 条旧记忆|    const relevantIds = (this.options.relevantMemoryIds?.(sourceRunId) ?? []).slice(\n      0,\n      MAXIMUM_RELEVANT_MEMORIES,\n    );\n    const relevant =\n      relevantIds.length === 0\n        ? []\n        : await this.options.state.readMany({ ownerId, agentId, memoryIds: relevantIds });\n    const recent = confirmedFirstByRecency(\n      await this.options.state.listActive(ownerId, agentId),\n    ).slice(0, MAXIMUM_RECENT_MEMORIES);
CLAIM|36|一致|apps/agent-service/src/production-memory-recall.ts:301|旧对话只能搜到每日摘要|      conversations: episodes.map(({ episode, text }) => ({\n        day: episode.day,\n        source: episode.source,\n        summary: text,\n      })),
CLAIM|37|一致|packages/application/src/services/owner-profile-service.ts:217|规则混在记忆里|      eligible.filter((memory) => memory.attributes?.category === "rule"),
CLAIM|38|一致|packages/application/src/services/owner-profile-service.ts:217|规则会不会带上，取决于模型有没有把它归成规则类|      eligible.filter((memory) => memory.attributes?.category === "rule"),
CLAIM|39|一致|packages/application/src/services/owner-profile-service.ts:203|有没有被 2000 字挤掉|    const limit = this.#options.characterBudget ?? OWNER_PROFILE_CHARACTER_BUDGET;
CLAIM|40|一致|docs/adr/0153-adopt-product-vision-v2-3.md:37|愿景采纳记录 ADR 0153/0134 已列为已知缺口|2. 本 ADR 取代 [ADR 0134](0134-adopt-product-vision-v2-2.md)。0134 里关于愿景地位的全部决定（愿景是最上层产品文档、正文只由 Andy 修改、新版本整篇替换并由新 ADR 取代旧 ADR、不再称“本地优先”）和 v2.2 新增的 9 条内容决定原样沿用，0134 的“后果”里列出的下游冲突仍是已知缺口，不随本 ADR 改变。
CLAIM|41|一致|docs/adr/0186-memory-jumps-to-the-owners-original-message.md:10|对话原文本来全存着|# ADR 0186：记忆详情能跳到来源对话里的那句原话，找不到的显示“来源已不可查”并计数
CLAIM|42|一致|packages/application/src/ports/memory-projection.ts:13|类别仍用数据库里那套固定类别|export const MEMORY_CATEGORIES = [\n  "identity",\n  "preference",\n  "relationship",\n  "goal",\n  "project",\n  "rule",\n  "health",\n  "finance",\n  "event",\n  "other",\n] as const;
CLAIM|43|一致|docs/adr/0209-rule-book-with-cel-expressions-and-judge.md:10|能由程序执行的规则（通知、静默时段等）走现有规则手册|# ADR 0209：规则手册用 CEL 表达式，由一个裁判计算（部分取代 ADR 0163 的决定 4）

未核对的部分：主模型“不知道自己还记着什么、没法再看更多/打开出处”属于能力判断，没读到能直接证明它的代码，标为找不到；外部网站、第三方产品和方案新增内容也未核对。另注：`MAXIMUM_CANDIDATES` 实际在第 78 行（方案写 64-77），召回摘要实际是 `summary: text` 而非 `episode.summary`。
