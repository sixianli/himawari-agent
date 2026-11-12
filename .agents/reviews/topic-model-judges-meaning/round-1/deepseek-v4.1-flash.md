# 方案：把 5 处“词表/正则判断自然语言”改成模型判断

## 0. 先给结论

| 位置 | 结论 | 是否新增模型调用 |
|---|---|---|
| ① 搜记忆猜时间范围 | **只改一部分**：删掉主路径上的正则兜底；有模型的路径由模型填 `from/to/includeHistory`；没有模型的主路径不再猜时间；只有后台/外部 MCP 路径按需加一次低价分类调用 | 主路径不增加；后台可选一次 |
| ② 导入/手动添加分类 | **改**：导入用一次批量低价分类；手动添加只在保存/明确要求时分类，不在打字时每次调用 | 是（批量/低频） |
| ④ 引用与待确认规矩是否相关 | **改**：不再用停用词表；新增一次“引用是否支持这条待确认规矩”的独立低价核验调用，只在极少数待确认确认场景触发 | 是（很罕见） |
| ⑤ 评测出题的“时间说法泄露” | **只改时间归一化那一段**：n-gram 和数字重叠保留；时间等价改成一次低价泄露判断调用 | 是（只在评测开启时） |
| ⑥ 邮件订单号 | **改**：模型从邮件里识别候选单号；格式、逐字出现、`mentions()` 仍由程序确定性校验 | 是（每次邮件检查一次批量调用） |

共用的是**后台低价模型调用的管道**（固定提示词、JSON 校验、超时、成本上限、缓存、失败默认值），不是把五件事塞进同一个大调用。理由见第 3 节。

---

## 1. 方案依赖的前提

### 1.1 读代码或来源证实的

**前提 1：发给模型的请求只能追加，系统提示和工具按对话冻结。**
- 来源：`.claude/rules/prompt-prefix.md:27`，原话：“固定的在前，会变的在后。顺序是：工具定义 → 系统提示 → 历史 → 最后一条用户消息。”
- 来源：`.claude/rules/prompt-prefix.md:28`，原话：“每轮都会变的内容只放在最后一条用户消息里。”
- 来源：`.claude/rules/prompt-prefix.md:41`，原话：“系统提示和工具按对话冻结……改了提示词文字，只对新对话生效。”
- 来源：`.claude/rules/prompt-prefix.md:84`，原话：“这个改动会不会让模型已经见过的请求开头变化？会，就停下来出方案，Andy 同意才动工。”

**前提 2：同样的内容必须序列化成同样的字节。**
- 来源：`.claude/rules/prompt-prefix.md:50`，原话：“同样的内容，每次都要序列化成同样的字节。JSON 的键顺序、工具的顺序、列表的顺序……都要固定，不能依赖对象遍历顺序或数据库返回顺序。”

**前提 3：原则冲突时，记忆可靠性优先于效率。**
- 来源：`docs/product-vision.md:55`，原话：“原则冲突时，按序优先：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。”

**前提 4：sensitive 记忆现在模型可见，restricted 永远不可见；但“是否敏感”判错仍有后果。**
- 来源：`docs/adr/0193-memory-is-visible-to-the-model.md:56`，原话：“‘模型能看到什么’由固定的模型可见上限决定，上限是 sensitive……restricted 永远不给模型。”
- 来源：`docs/adr/0193-memory-is-visible-to-the-model.md:59`，原话：“派生内容取来源的最高分级。”
- 来源：`docs/adr/0193-memory-is-visible-to-the-model.md:83`，原话：“不用去管以前的聊天记录，做得彻底一点。”

**前提 5：I-73 的教训是“值只在一边被校验”。**
- 来源：`docs/incidents-and-gates.md:112`，原话：“#207 的测试只测清单解析和展示，没有把清单里的引用交给发送消息的校验；双模型复核只看了 diff，没问‘清单里的 id 能通过后端校验吗’。”
- 所以下面每一项都列“产生处 / 使用处 / 两端校验”。

**前提 6：① 现在唯一真正调用 `parseTimeScope` 的生产路径是 recall 工具和 Hybrid provider 的兜底；题目列出的自动召回等路径没有把 query 文本交给它。**
- 来源：`packages/memory-engine/src/time-scope.ts:152`，函数 `parseTimeScope(query, now, timeZone)`；
- 来源：`apps/agent-service/src/production-memory-recall.ts:159`，原话：`const parsed = parseTimeScope(input.query, now, timeZone);`
- 来源：`packages/memory-engine/src/hybrid-memory-provider.ts:166`，原话：`const scope = input.scope ?? parseTimeScope(input.query, now, this.#options.timeZone);`
- 我按 `parseTimeScope` 搜索全仓库：生产调用只有上面两处，另有测试。`context-formation-service.ts:241` 传的是 `queryRef/queryTerms`，不是 query 文本；`production-proactive-memory.ts:41` 没有传 `scope`。结论：题目说“这些路径上正则是它们唯一的时间来源”**与当前代码不完全一致**；这些路径目前大多根本不解析时间。具体各 provider 实现是否另有解析，我只核对了 `HybridMemoryProvider`，其余标“未核实”。

**前提 7：recall 工具已经让模型填时间，正则只是模型没填时的兜底。**
- 来源：`packages/prompt-catalog/src/tools.ts:36`，原话：“问到具体时间时填 from、to（YYYY-MM-DD，按主人所在时区）；问以前的情况时 includeHistory 填 true。”
- 来源：`apps/agent-service/src/production-memory-recall.ts:160-184`：显式 `from/to` 优先，否则 `parseTimeScope` 兜底。

**前提 8：② 的分类和敏感标记是浏览器端算好、再交给后端契约保存的。**
- 来源：`apps/control-center/src/memory-import.ts:29-49` `guessCategory`；`:91-103` 把 `guess.sensitive` 与确定性检测做 OR，并决定 `checked`。
- 来源：`apps/control-center/src/components/memory-page.tsx:2210-2214`，手动添加时 `const category = picked ?? guessCategory(text).category;`，并且 `health/finance` 或确定性证件/卡号检测会置 `sensitive`。
- 来源：`apps/control-center/src/memory.ts:210-220`：`sensitive` 被映射成 `"sensitive"` 或 `classificationWithIdentifiers(text,"private")`，作为 `protectText` 的分级。
- 来源：`packages/gateway-contracts/src/contracts-v2.ts:1481`：`category: enumeration(MEMORY_CATEGORY_NAMES)`；`:1509` 导入同样枚举；`:1023` 是 `MEMORY_CATEGORY_NAMES`。
- 也就是说：**模型输出不能直接穿过**，必须先变成契约允许的 category 和 classification。

**前提 9：④ 的停用词表只用于“待确认规矩被再次提到时是否算确认”，且逐字核对已经存在。**
- 来源：`apps/agent-service/src/production-memory-capture.ts:148-177`：`GENERIC_TERMS`、`relevanceTokens`、`quoteRelatesToMemory`。
- 来源：`apps/agent-service/src/production-memory-capture.ts:358-369`：`confirmsTentative` 只在 `unchanged/update/merge` 指向 tentative 时成立；`evidenceRejected` 同时要求 `evidenceVerified` 和 `quoteRelatesToMemory`。
- 来源：`packages/prompt-catalog/src/memory.ts:19`，原话：“已有记忆里同样的待确认规矩再次出现时用 unchanged 指向它。”
- 来源：`packages/prompt-catalog/src/memory.ts:28`，原话：“quote：从 ownerMessage 里原样摘抄……每条都必须填。”

**前提 10：⑤ 的泄露检查只有“时间说法归一化”是中文正则，n-gram 和数字重叠是语言无关的字符串比较。**
- 来源：`packages/application/src/services/real-memory-eval.ts:128-168`：`PART_OF_DAY`、`dateTokens`、`leaksAnswer`。
- 来源：`packages/application/src/services/real-memory-eval.ts:235`：`if (leaksAnswer(question, texts)) return { rejected: "leak" };`
- 来源：`packages/application/src/services/real-memory-eval.ts:265-288`：评测另有 `REAL_EVAL_JUDGE` 和 `parseJudgeVerdict`，不是正则。

**前提 11：⑥ 的单号抽取发生在判断模型之前。**
- 来源：`packages/platform-node/src/gmail-related.ts:14-31`：`REFERENCE_CONTEXT`、`extractReferenceIds`；`:45-57` `mentions()` 逐字核对；`:159-164` 用单号去 Gmail 搜索。
- 来源：`packages/application/src/services/proactive-mail-check-service.ts:847-862`：先 `#related`，再 `#recall`，然后才 `#judge`。
- 来源：`packages/prompt-catalog/src/mail.ts:32`：判断模型已经顺带输出 `amount`。

**前提 12：业界同类做法是“模型负责语义抽取/判断，程序负责 schema、校验和引用核对”。**
- OpenAI：<https://developers.openai.com/api/docs/guides/structured-outputs>，原话：“Structured Outputs constrains completed, non-refusal model output to your supplied JSON Schema. Your application still needs to handle refusals, incomplete responses, and API errors, and validate any business rules that the schema does not express.”
- Google：<https://ai.google.dev/gemini-api/docs/structured-output>，原话：“You can configure Gemini models to generate responses that adhere to a provided JSON Schema. This ensures predictable, type-safe results and simplifies extracting structured data from unstructured text.”
- DeepSeek：<https://api-docs.deepseek.com/guides/json_mode>，原话：“DeepSeek provides JSON Output to ensure the model outputs valid JSON strings.” 同页要求：“Set the `response_format` parameter to `{'type': 'json_object'}`.” 并在 Responses API 文档 <https://api-docs.deepseek.com/api/create-response/> 提供 `{"type":"json_schema","name":...,"schema":...}`。
- Mem0：<https://github.com/mem0ai/mem0/blob/main/docs/core-concepts/how-it-works.mdx>，原话：“An LLM extracts preferences, decisions, plans, and other details your agent can reuse.” 以及 “The automatic extraction path is additive.”
- Mem0 论文：<https://arxiv.org/abs/2504.19413>，原话：“the LLM itself determines which of four distinct operations to execute: ADD... UPDATE... DELETE... NOOP...”
- Anthropic memory tool：<https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool>，原话：“Claude automatically checks its memory directory before starting a task. As it works, Claude stores what it learns in files under `/memories`...”
- Letta memory blocks：<https://docs.letta.com/agent-sdk/memory/index.md>，原话：“Memory is what makes a Letta agent stateful... the agent edits it as it learns.”
- Gmail 搜索：<https://developers.google.com/workspace/gmail/api/guides/filtering>，原话：“The `q` query parameter, which supports most of the same advanced search syntax as the Gmail web interface.”

### 1.2 推测，未核实

- 成本/延迟的具体数字：我没有查到本项目生产上 DeepSeek V4.1 Flash 经 Magpie 的实时单价与 P50/P95，下文只给量级估算。
- ④ 确认后的 rule 最终注入位置：我确认记忆/档案块是 context block（`context-formation-service.ts:373-393`、`context-projection-service.ts:403-435`），但没有继续追到 Pi 最终把它拼进最后一条用户消息还是系统提示。若 rule 会进系统提示，见第 5 节风险。
- Gmail 引号短语搜索在 API 中的精确语义，我只读到 `q` 支持 advanced search syntax，未逐条验证引号行为。
- 题目列出的自动召回/主动提醒路径是否都完全不经过 `parseTimeScope`：我只按仓库搜索和读了这两个文件，其他 provider 实现未逐一核实。

---

## 2. 共用机制：一个后台语义判断管道，而不是一个大调用

建议新增一个应用层端口，例如 `BackgroundSemanticJudgePort`，由 agent-service 用现有低价模型/成本/准入能力实现：

```ts
judge<T>(input: {
  promptId: "memory.time-scope" | "memory.import-classify" | "memory.quote-supports"
          | "eval.leak-check" | "mail.reference-extract";
  data: unknown;                 // 固定键序、固定列表顺序
  parse: (raw: unknown) => T;    // 与现有代码同一套校验
  timeoutMs: number;
  maxCostMicros?: number;
  cacheKey?: string;
}): Promise<T>
```

统一规则：

1. 固定提示词放 `packages/prompt-catalog`，用 `fixedPrompt`；数据放后，`now`/本轮时间等易变值放最后（`prompt-prefix.md:27`、`:67`）。
2. 输出只接受 JSON；**和现有代码共用的校验函数**，不新写一套宽松解析。外部模型输出即使 schema 合法，也要过业务校验（OpenAI 文档原话见前提 12）。
3. 失败默认值逐项定义，不统一“失败就继续”。
4. 缓存键 = `promptId + 版本 + 规范化输入 + 本地日期（仅时间相关）`；缓存只存已通过校验的结果。缓存解决两件事：重复导入/重复查询省钱；同一段文字不会因批次不同反复变化。
5. 模型只用低价模型（DeepSeek V4.1 Flash 一类，经 Magpie 的既有后台路由），不写死 `anthropic/`、`openai/`。
6. 不在聊天主路径上调用。用一个测试证明：普通聊天一轮内该端口调用次数为 0（① 的工具参数由主模型自己填，不算这个端口）。

---

## 3. 逐项方案

### ① 搜记忆的时间范围

**我的判断：只改一部分，主路径不要新增模型调用。**

**做法**

1. `production-memory-recall.ts`：
   - 删除 `parseTimeScope(input.query, ...)`。
   - 显式 `from/to` 的逻辑保留：`argumentsOf` 已经用 `DATE = /^\d{4}-\d{2}-\d{2}$/` 和布尔类型校验（`:100-103`）。有 `from/to` 时仍按 `startOfDay` 转成 ISO，并强制 `includeHistory:true`。
   - 没有 `from/to` 时，只使用模型给的 `includeHistory` 布尔值；没有就是 `false`，`from/to` 为 `null`。
   - 不再产生 `matched` 字段；相关测试删掉或改成新语义。
2. `hybrid-memory-provider.ts:166`：`const scope = input.scope ?? null;`，删掉正则兜底。这样所有没有显式 scope 的调用不再偷偷解析自然语言。
3. 主路径的自动召回（`context-formation-service.ts:241`）：**不解析时间**，只按现有 query terms/embedding 召回当前记忆。用户问“以前/上周三”时，由主模型调用 `recall` 工具并填 `from/to/includeHistory`——工具说明已经这么要求（`tools.ts:36`）。这符合“理解意图交给模型”，也不增加主路径延迟。
4. 没有主模型的后台/外部路径（例如 MCP 的 `find_memories`）：
   - 首选给外部工具增加可选的 `from/to/includeHistory` 参数，让调用方模型自己填；
   - 若确实需要系统代填，才用共用管道调用一次 `memory.time-scope`。
5. 不做“先无 scope 搜索、再异步解析时间补搜”，那会多一次搜索、多一次费用，且结果顺序不稳定。

**新增/修改的模型调用（仅后台可选路径）**

- 谁调：agent-service 的后台记忆路径 / MCP 适配层。
- 什么时候调：调用方没有提供时间范围、但明确要求“理解时间”。
- 输入：`MEMORY_TIME_SCOPE` 固定指令 + `{query, now, timeZone}`，`query` 原文，`now` 放最后。
- 输出：`{"from":"YYYY-MM-DD"|null,"to":"YYYY-MM-DD"|null,"includeHistory":boolean}`。
- 校验：日期正则、`from<=to`、时区换算；无效就当没有时间范围，**绝不回退正则**。
- 成本/延迟：一次几百 token；按低价模型量级是“远低于 0.001 美元/次”，延迟约几百毫秒到 1 秒（估算，未核实）。
- 失败：`from/to=null`、`includeHistory=false`，记一条决策记录/日志，搜索照常进行。

**不选的做法**

- **保留正则做兜底**：题目要解决的就是“说法千变万化”，正则永远补不完，而且“我一个月存多少钱”这类反向用例已经说明会误判（`packages/memory-engine/test/time-scope.unit.test.ts:56` 现在能过，但换一种说法就可能不过）。
- **主路径加一次模型调用**：违反“对话主路径不增加模型调用”，而且时间范围对自动召回不是必需——主模型有 recall 工具。
- **把时间解析塞进 embedding 调用**：embedding 只算向量，不产生结构化时间。

---

### ② 记忆导入和手动添加的分类、敏感判断

**做法**

1. **导入**：
   - 先做现有确定性解析、去重、Task Group 处理（不动）。
   - 只对非重复、非跳过项做分类，按原始行号排序，每批最多 40 条，最多 500 条。调用一次 `memory.import-classify`。
   - 输入：固定指令 + `[{index, text}]`，按 `index` 升序；不把文件名、章节等无关上下文塞进去，减少跨条影响。
   - 输出：`{"items":[{"index":0,"category":"health","sensitive":true}]}`。
   - 校验：
     - `index` 必须唯一、在范围内；
     - `category` 必须是 `MEMORY_CATEGORY_NAMES` 之一，否则该条回退 `"other"`；
     - `sensitive` 必须是布尔，否则按“需要复核”处理；
     - 最终 `sensitive = 模型 true || mentionsSensitiveMaterial(line) || classificationWithIdentifiers(line,"private")==="sensitive"`，确定性检测永远优先/并集。
   - 失败默认：该批 category=`"other"`、sensitive=`true`、`checked=false`（导入预览默认不勾选，等用户复核）。这是安全默认：宁可让用户多看一眼，不把可能敏感的内容静默当 private 导入。
   - 成本/延迟：100 条大约几千 token；一次导入是低价的几美分以内，延迟 1–3 秒（估算，未核实）。可在预览时异步跑，先显示“分类中”，失败就按安全默认。
2. **手动添加**：
   - 删除输入时每次 `guessCategory(text)`。
   - 初始 category=`"other"`，用户可手动选。
   - 只在“保存且用户没改过下拉”或用户点“帮我分类”时调用一次同一个分类器；模型返回后更新下拉并让用户可改。
   - `sensitive` 仍先走确定性 `classificationWithIdentifiers`；若用户选择或模型给 `health/finance`，按现有规则置 sensitive（`memory-page.tsx:2211-2214`）。
   - 失败：category=`"other"`，sensitive 只由确定性检测决定；手动添加是用户主动输入且可改，不需要像批量导入那样全部标敏感。

**值两端核对**

- 产生：浏览器端的 `category`/`sensitive`。
- 使用：
  - `apps/control-center/src/memory.ts:210-220` 把 `sensitive` 映射成分级，`category` 原样发；
  - `packages/gateway-contracts/src/contracts-v2.ts:1481`（memory.create）和 `:1509`（import.commit）用 `MEMORY_CATEGORY_NAMES` 枚举校验；
  - 后端 `apps/agent-service/src/production-memory-control.ts` 的 `#createMemory` 消费。
- 结论：模型输出必须经过“枚举白名单 + 布尔强制 + 确定性 sensitive 并集”，不能直接透传。这正是 I-73 要求的“清单里的 id 能通过后端校验吗”。

**不选的做法**

- 导入时逐条调用模型：几十到几百条会把成本放大几十倍，而且慢。
- 手动添加时实时逐字调用：会疯狂花钱，且用户打字过程中分类本来就不稳定。
- 只靠模型判断敏感、去掉确定性证件号/卡号检测：这属于安全过滤，题目明确要保留。

---

### ④ 引用是否支持一条待确认规矩

**我的判断：不使用停用词表；但也不完全信任抽取模型自己的判断，增加一次很罕见的独立核验调用。**

**做法**

1. 删除 `GENERIC_TERMS`、`relevanceTokens`、`quoteRelatesToMemory`。
2. 保留 `quoteFromOwnerMessage`（逐字核对，确定性）。
3. 仍然用抽取模型的 `decision` + `existingMemoryId` 找到“它认为在确认哪条 tentative”。
4. 当且仅当：
   - `decision in (unchanged, update, merge)`；
   - `existingMemoryId` 指向 `tentativeMemories`；
   - `quoteFromOwnerMessage(quote, ownerMessage) === true`；

   调用一次 `memory.quote-supports`：
   - 输入：`{quote, tentativeMemory: text}`，只有这两段，不放整段对话、不放其他记忆；
   - 输出：`{"supports": boolean, "reason": string|null}`；
   - 校验：`supports === true` 才确认；false、缺失、非布尔、超时、格式错都按“不确认”；
   - 失败默认：规矩保持 tentative，候选按现有 `rejectedCandidates`/`unverifiedEvidence` 处理，绝不因为核验失败而确认。
5. `confirmsTentativeCategory` 的 category 仍必须通过 `MEMORY_CATEGORIES` 校验（`production-memory-capture.ts:479-486`、`automatic-memory-service.ts:113-115,242`）。

**为什么加一次独立调用而不是让抽取模型顺手输出一个布尔**

- 抽取模型已经自己选了 `existingMemoryId`，再让它判断“引用是否支持这条记忆”有自我确认偏差。
- 这次调用只在“待确认规矩被再次提到”时发生，频率极低；输入只有两段短文本，成本和延迟可以忽略。
- 它保持了确定性逐字核对作为第一道门，模型只负责“语义是否相关”这一件程序不该做的事。

**成本/延迟**：几百 token，低价模型，估算远低于 0.001 美元/次；延迟几百毫秒到 1 秒，只在后台记忆抽取的极少数分支。

**不选的做法**

- 继续用停用词表：中文停用词永远列不全，“我喜欢开会”和“喜欢喝咖啡”这种反例已经存在（`apps/agent-service/test/production-memory-evidence.unit.test.ts:202-204`）。
- 用 embedding 相似度替代：相似度只能判断“话题接近”，不能判断“这句话是否支持这条规矩”，而且会引入新的阈值调参。
- 让抽取模型在同一调用里返回 `supports`：便宜但更容易自证；如果 Andy 更在意成本，可以降级成这个方案，见第 6 节。

---

### ⑤ 真实记忆评测的“时间说法泄露”

**做法**

1. 保留 `ngrams`、`numbers`、`fastPathVerdict` 这些确定性字符串检查。
2. 删除 `chineseNumber`、`PART_OF_DAY`、`AFTER_HOUR`、`dateTokens` 以及它们在 `leaksAnswer` 里的时间归一化部分。
3. `leaksAnswer` 只做 n-gram 和数字重叠。
4. 新增一次 `eval.leak-check`：
   - 谁调：真实评测的出题流程，在 `parseGeneratedQuestion` 里，模型出题之后、题目入库之前。
   - 什么时候调：只在配置开启真实评测时；每道题一次。
   - 输入：`{question, memory, quote}`；`question` 和来源都只来自本题。
   - 输出：`{"leaks": boolean}`。
   - 校验：必须是布尔；true → 拒绝；false 且确定性检查也过 → 接受。
   - 失败：拒绝这道题，沿用现有 `rejected: "leak"`，让评测换下一条记忆。不要因为模型失败而放行可能泄露的题。
   - 成本/延迟：每道题几百到一千 token；评测本来每次几美分，增加大约三分之一到一半；延迟几百毫秒到 1 秒（估算，未核实）。
5. 不新增 `QuestionRejection` 枚举值，避免又出现 I-73 那种“新值没有消费者接受”的问题；失败原因仍记 `leak`，日志里记 `leak_check_unavailable` 之类的内部字段即可。

**不选的做法**

- 让出题模型自己声明“有没有泄露”：省一次调用，但出题模型正是可能泄露的一方，自证不可靠。
- 继续用中文时间正则：题目明确说这是中文专用正则，换语言/换说法就漏。
- 把这个问题交给评测裁判模型：裁判在答题之后才跑，来不及阻止泄露题进入样本。

---

### ⑥ 邮件里的订单号/预约号

**我的判断：关键词表该换；但单号的“格式”和“逐字出现”必须继续由程序校验。**

**做法**

1. `gmail-related.ts` 删除 `REFERENCE_CONTEXT` 和 `extractReferenceIds`。
2. 新增一次 `mail.reference-extract`，在 `proactive-mail-check-service.#related` 之前调用：
   - 谁调：主动邮件检查服务（后台）。
   - 什么时候调：每次检查、在取相关邮件之前；只对候选邮件、排除 spam 后调用一次，不逐封调用。
   - 输入：固定指令 + `[{messageId, subject, snippet 或截断正文}]`，按 `receivedAt/messageId` 排序；邮件内容走现有出口遮盖。
   - 输出：`{"items":[{"messageId":"…","references":["…"]}]}`。
   - 校验（全部确定性）：
     - 每个 reference 必须匹配 `^[A-Z0-9][A-Z0-9-]{7,39}$`、至少含一个数字、不是 `YYYY-MM-DD`；
     - 必须在该邮件原文里逐字出现（大小写不敏感、边界按现有 `mentions()` 逻辑）；
     - 去重、每封最多 3 个、整体顺序稳定（按邮件顺序、再按首次出现）；
     - 只有通过上述校验的字符串才能拼进 Gmail `q`，防止模型输出引号/空格/操作符注入。
   - 用单号搜索后，**仍然调用现有 `mentions(message, reference)` 再核对一次**（`gmail-related.ts:45-57`），这一层不删。
3. 失败默认：这次检查不使用单号搜索，只用线程和同标题同参与人；把该邮件标记为“相关邮件不完整”，判断提示词已经有 `"relatedUnavailable":true` 的语义（`packages/prompt-catalog/src/mail.ts:17`）。少给上下文是安全方向，不会伪造上下文。
4. 预算/延迟：一次检查一次调用，输入是主题+摘要/截断正文，输出只有几个单号；估算每次检查低于 0.001–0.01 美元、延迟 1–2 秒量级（未核实）。现有 `perCheckMs`、每日成本上限继续兜底；超时/超预算就不做单号搜索。

**为什么不在判断模型输出单号后再补搜**

- 那会让判断模型先看不到相关邮件，结论可能已经错了；要补搜就得再判断一次，费用和延迟都翻倍。
- 现在在判断之前抽单号，和现有顺序一致，只替换抽取方式。

**不选的做法**

- 完全保留正则：关键词只覆盖现有几种语言和写法，换一种“参考号码”“您的申请编号是”就漏。
- 让模型直接输出 Gmail 查询语句：危险，模型可以注入搜索操作符；必须只输出候选 ID，由程序拼查询。

---

## 4. 风险与反例

1. **模型漏判时间范围**：主路径不再猜时间，用户问“以前”时如果主模型不调用 recall，自动召回只给当前记忆。反例：用户说“我以前用什么手机”，模型没调工具，答案可能只基于当前记忆。缓解：工具说明已明确；评测里加这类用例；若 Andy 不能接受，只能给主路径加一次低价时间调用，那就违反“主路径不加调用”的目标，需要他拍板。
2. **模型误判敏感**：导入时模型可能把财务/健康判成普通偏好。缓解：确定性证件/卡号检测并集；导入默认 `checked=false` 让用户复核；失败默认敏感。
3. **④ 误确认待确认规矩**：规矩确认后会变成生效硬规则，误确认后果大。缓解：逐字引用 + 独立核验 + 失败不确认 + 决策记录可追溯。
4. **⑤ 模型泄露判断失败导致评测题变少**：这是可接受的质量换安全；但会让评测样本产出率下降，需监控 `leak` 拒绝率，避免把“模型总说泄露”误当成质量变好。
5. **⑥ 模型编造单号**：格式校验、逐字出现校验、搜索后的 `mentions()` 三层拦住；最坏情况是少搜到相关邮件，不是把错误邮件当相关。
6. **跨请求字节不稳定**：② 如果同一行出现在不同批次，模型分类可能不同。缓解：按原文 hash 缓存第一次已校验结果；输入列表按固定顺序；不把批次上下文当成判断依据。这是本方案里最需要实测的一点。
7. **新值没有消费者**：新增的 prompt id、purpose（成本分类）、cache 表字段、`QuestionRejection` 等，每一个都按 I-73 的办法列产生处/使用处；能复用旧枚举就复用，不能复用就同时改契约、后端、前端、i18n 和测试。

---

## 5. 需要 Andy 拍板的取舍

1. **① 主路径是否接受“自动召回不再猜时间”**。我倾向接受，让主模型用 recall 工具；如果要求自动召回也必须理解“以前”，就必须在每轮主路径加一次低价模型调用，和“主路径不增调用”冲突。
2. **④ 用一次独立核验，还是让抽取模型同调用返回布尔**。前者更可靠、频率极低；后者更便宜。考虑“规矩确认后变成硬规则”，我推荐独立核验。
3. **② 手动添加是否保留“打字时实时猜类别”**。我建议删除，改为保存/按钮触发；如果 Andy 喜欢实时预览，可以保留但必须防抖，且接受多次模型调用。
4. **⑥ 是否接受每次邮件检查多一次低价调用**。如果每日成本上限很紧，可以降级为“只用线程/同标题同参与人”，完全不抽单号。

---

## 6. 必答问题

### 问题 1：改动会不会改变模型已经见过的请求开头？

**答：按本方案，聊天请求的系统提示、工具定义、历史消息、遮盖结果都不变，仍然只在末尾追加；每轮会变的值仍在最后一条消息或工具结果里。**

依据：

- 系统提示和工具定义不改。① 用的是现有 recall 参数，不新增/删除工具字段（`tools.ts:36`）；②④⑤⑥ 都是独立后台调用，不进入聊天请求。
- ① 的 recall 结果 `window` 和记忆列表本来就是工具结果，追加在末尾；删除正则兜底只改变“这一轮新产生的工具结果”，不改已发历史。
- ② 写入的记忆之后作为本轮/后续轮的 context block 注入（`context-formation-service.ts:373-393`），不是系统提示；旧轮次存的是当时实际发出去的内容，不会被重写。
- ④ 确认规矩影响的是后续轮次注入的记忆内容，仍应走“最后一条消息”的 context block；**未核实**确认后的 rule 是否会被拼进系统提示。如果会，则只能对新对话生效，或按 ADR 0165 换新，不能静默改老对话开头。
- ⑤ 只影响评测，不影响聊天。
- ⑥ 只影响后台邮件判断调用，不影响聊天。
- 需要保留并跑 `npm run check:prompt-prefix`；它的职责就是检查后一次请求是否以前一次请求开头（`prompt-prefix.md:74`）。

### 问题 2：会不会让同一段文字在不同请求里变成不同字节？

**答：方案本身不依赖前后文改写已发内容，但模型输出天然有随机性；必须用“校验 + 缓存 + 固定序列化”把它约束住。**

- 已发历史：不重写；遮盖规则不变。
- ① 时间范围依赖 `now` 和时区，这是“本轮值”，只放在最后一条消息/工具结果；同一句“明天”在不同日期得到不同日期是语义要求，不是缓存破坏。缓存键必须含本地日期。
- ② 同一行文字的 category/sensitive 应只取决于该行文字；批次输入按固定顺序，缓存按文字 hash 复用首次结果，避免因批次不同而变。
- ④ 只看 `quote` 和该条 tentative 记忆，不看整段对话，所以同一段引用不会因后来的消息改变判断。
- ⑤ 只看 `question` 和该题的来源，不看其他题。
- ⑥ 只看该邮件，列表排序固定；references 去重后按首次出现顺序输出。
- 所有 JSON 用固定键序；列表排序；不输出 `Set` 的遍历顺序（`prompt-prefix.md:50`）。

### 问题 3：有没有对应的自动检查？反向用例真的会失败吗？

有，但要新增；现有旧测试只能证明旧实现，不能证明新实现。

| 位置 | 正向用例 | 反向用例（期望不命中/不触发） | 反向为什么真的会失败 |
|---|---|---|---|
| ① | 模型给 `from=2026-10-13,to=2026-10-14`，recall 的 window 正确 | 同一 query 模型不给时间 → scope 为空；`我一个月存多少钱` 不得被当成一个月窗口 | 如果恢复 `parseTimeScope` 兜底，“一个月”/“上周三”会重新产生窗口，反向断言失败 |
| ② | 导入“我对花生过敏” → health+sensitive+不勾选 | “我喜欢喝咖啡” → preference、非敏感；模型返回非法 category `medical` → 回退 other；确定性卡号检测覆盖模型 private | 去掉枚举白名单/确定性并集，非法 category 会传给 `memory.create`，契约测试或反向断言失败 |
| ④ | 逐字引用“我又买了明治的牛奶”+tentative“主人偏好明治乳制品”，核验 true → 确认 | 逐字引用“明天下午开会”+tentative“主人喜欢喝咖啡”，核验 false → 拒绝；核验超时 → 保持 tentative | 若恢复 `quoteRelatesToMemory` 或忽略 `supports`，第一个反例会误确认，测试失败 |
| ⑤ | “我早上七点做什么” vs “每天 7:00 跑步” → 拒绝 | “我早上八点做什么” vs “7:30 跑步” → 接受；模型超时 → 拒绝而不是放行 | 若删掉时间检查或失败放行，正例/超时用例失败 |
| ⑥ | “注文番号: 250-1234567-8901234” → 模型返回该号，搜索后 `mentions` 为真 | “ID 123456”“order 2026-11-07”“order number: ABCDEFGH” → 不搜索；模型返回不在原文里的号 → 不搜索 | 若恢复旧正则，现有 `gmail-related.unit.test.ts:75-78` 会按旧预期失败；若把模型输出直接拼查询，注入用例失败 |

另外要加两条“机制级”测试：

1. **主路径零后台语义调用**：普通聊天一轮里 `BackgroundSemanticJudgePort.judge` 调用次数为 0；如果 ① 被错误地加到主路径，测试失败。
2. **序列化确定性**：同一输入构造两次 prompt，逐字节相等；列表顺序不受 Map/Set 遍历影响。若改成依赖数据库返回顺序，测试失败。

现有可复用的反向用例：
- `packages/memory-engine/test/time-scope.unit.test.ts:53-57`；
- `apps/agent-service/test/production-memory-evidence.unit.test.ts:170-220`；
- `packages/application/test/real-memory-eval.unit.test.ts:127-145`；
- `packages/platform-node/test/gmail-related.unit.test.ts:68-80`；
- `apps/control-center/test/memory-interactions.unit.test.ts:1720-1722`。

### 问题 4：每个新值，产生处和使用处两端都能接受吗？

按 I-73 的办法逐个核对：

**① `from` / `to` / `includeHistory`**
- 产生：主模型填的 recall 参数，或后台 `memory.time-scope` 输出。
- 使用：
  - `production-memory-recall.ts:100-103` 用 `DATE` 正则和布尔类型校验；`:163-184` 转成 `MemoryTimeScope`；
  - `HybridMemoryProvider.search` 把 `includeHistory` 传给索引（`hybrid-memory-provider.ts:177`）；
  - `fuseCandidates` 用 `Date.parse(scope.to/from)` 做时间窗加权（`fusion.ts:57-71`）；
  - recall 输出 `window:{from,to,timeZone}` 给模型（`production-memory-recall.ts:339`）；
  - episodes 搜索使用同一个 `scope`（`:327`）。
- 两端都要求 ISO 可解析、日期格式正确；新模型输出必须复用 `DATE` 和 `startOfDay`，不能产生 `2026/10/13` 之类。
- 需删掉 `matched` 的使用/断言（目前主要在测试）。

**② `category` / `sensitive`**
- 产生：浏览器端模型分类 + 确定性检测并集。
- 使用：
  - `memory.ts:210-220`：`sensitive` → `"sensitive"` 或 `"private"`，写入 `protectText`；
  - `contracts-v2.ts:1481`、`:1509`：`category` 必须属于 `MEMORY_CATEGORY_NAMES`；
  - 后端 `production-memory-control.ts` 的 `#createMemory` 消费 category/classification。
- 结论：模型输出必须先过枚举白名单；非法值回退 `other`，不能把 `medical`、`重要` 之类直接发。`sensitive` 必须是布尔，最终分类只能落在契约允许的 four classifications。

**④ `supports` / `confirmsTentativeCategory`**
- 产生：`memory.quote-supports` 的 `supports`，以及 capture 计算出的 `confirmsTentativeCategory`。
- 使用：
  - `production-memory-capture.ts:479-486` 写入 candidate；
  - `automatic-memory-service.ts:113-115,242` 读取并决定 `tentative_confirmed`；
  - category 走 `MEMORY_CATEGORIES` 校验（`production-memory-capture.ts:80,370-374`）。
- 结论：`supports` 只接受 `true`；category 必须在 `MEMORY_CATEGORIES` 内；任何一边不合法都不确认。

**⑤ `leaks` / `rejected:"leak"`**
- 产生：`eval.leak-check` 的布尔值；拒绝原因沿用现有 `QuestionRejection` 的 `"leak"`。
- 使用：`parseGeneratedQuestion` 返回 `{rejected:"leak"}`；调用方按现有拒绝路径处理。
- 结论：不新增枚举值，所有现有消费者都能接受；如果一定要新增 `"leak_check_failed"`，必须同时改类型、调用方、统计和界面文案，否则就是 I-73 的重演。

**⑥ `references`**
- 产生：`mail.reference-extract` 的 `references`。
- 使用：
  - `proactive-mail-check-service.#related` 拼 Gmail 查询；
  - `gmail-related.ts:159-164` 搜索；
  - `mentions()`（`:45-57`）逐字核对；
  - `failed` map 的 `step` 名（`reference`）进入 trace/界面。
- 结论：只允许 `[A-Z0-9-]`、8–40 位、含数字、非日期、原文逐字出现；这样 Gmail `q` 和 `mentions()` 都能接受，也不会注入查询操作符。

**共用机制新增的值**
- 新 prompt id、新 purpose、新缓存表字段、新 rejection reason：每个都要按上表方式找消费方。能复用旧值就复用；必须新增时，同时改 `gateway-contracts`、后端、前端 i18n、成本统计和测试。I-73 的原话就是“清单里的 id 能通过后端校验吗”。

---

## 7. 在代码库里找到的同类位置（第 5 项要求）

### 7.1 真正同类、建议处理

1. **`packages/application/src/services/thread-command-service.ts:59-70` `parseAnswerLocaleSettingIntent`**
   - 用一条多语言正则理解“把回答语言改成英文/日文/中文”这种用户命令。它和本题的 5 处同属“用关键词/正则判断用户意思”。
   - 建议：优先做成设置项；如果要从自然语言触发，改成交给主模型判断并返回结构化 `answerLocale`，或者只接受明确命令。至少应列入后续清单。

### 7.2 边界情况：属于检索/格式/硬规则，不建议现在改

2. **`packages/memory-engine/src/segmentation.ts:5-83` `STOPWORDS` + `queryTerms`**
   - 它用停用词表决定哪些词进入关键词检索。它不理解“意图/类别/是否敏感”，只是搜索分词；每次检索都调用模型不划算。建议保留，但注意它不是“判断用户意思”。
3. **`packages/application/src/rules/rule-book.ts:53-150` `MONEY_SUBSTRINGS` / `MONEY_WORDS`**
   - 这是“涉及钱的邮件一律重要”的硬规则，属于产品愿景里“规则不是记忆，是硬性设定”（`docs/product-vision.md:59`），由程序执行并有回归测试样例（`:180-217`）。它不是“猜用户意思”，不建议改成模型。
4. **`packages/platform-node/src/gmail-related.ts:8-9` `SUBJECT_PREFIX`**
   - 只剥 `Re:/Fwd:/回复/转发` 等邮件头前缀，是纯格式处理，保留。
5. **`apps/agent-service/src/production-memory-capture.ts:88-93` `DATE_ONLY` / `LOCAL_TIME`**
   - 只校验/解析日期时间格式，是纯格式处理，保留。
6. **`packages/application/src/services/real-memory-eval.ts:290-299` `fastPathVerdict`**
   - 字符串包含比较，不是自然语言理解，保留。

### 7.3 明确不属于本题

- `packages/sensitive-capture/**`：密码、验证码、证件号、卡号的确定性检测与遮盖，题目明确保留。
- `packages/memory-engine/src/fusion.ts`、`relevance.ts`：数值权重和排序，不是语义判断。
- `apps/control-center/src/i18n/**`、`memory-page.tsx` 的界面文案和筛选：界面逻辑，不是模型输入判断。

---

## 8. 还没核实、实施前必须补的

1. 主路径自动召回之外，是否还有别的 provider 实现会在内部调用 `parseTimeScope`；我只核对了 `HybridMemoryProvider`。
2. ④ 确认后的 rule 最终是否进入系统提示；若是，必须按 ADR 0165 处理老对话，不能静默改开头。
3. DeepSeek V4.1 Flash 经 Magpie 的实际单价、P50/P95 延迟，以及每日成本上限是否足够覆盖 ⑥ 的每检查一次调用。
4. Gmail API 引号短语搜索的精确行为，以及模型识别出的单号在 Gmail `q` 中的转义要求。
5. 导入批量的最佳大小（40 还是更小）需要用小样本实测准确率和成本，不能凭感觉定。
