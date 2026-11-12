我先读仓库里的关键文件和相关规则文档，弄清现状。
继续读五个现状文件和相关调用点。
代码现状已基本弄清。现在查业界一手来源。
补两处调用链的核对，然后写结论。
读代码与查证已足够，下面写出方案。

---

# 把 5 处“词表/正则判断”改为模型判断的方案

## 一、方案依赖的前提（读代码/来源证实的，附出处和原话）

1. **工具路径上模型本来就能给时间**。`apps/agent-service/src/production-memory-recall.ts:160-184`：`const explicit = input.from !== undefined || input.to !== undefined;` 模型填了就用模型的，没填才落到 `parsed`（正则结果）。工具说明已写“问到具体时间时填 from、to（YYYY-MM-DD，按主人所在时区）；问以前的情况时 includeHistory 填 true”（`packages/prompt-catalog/src/tools.ts:36`）。
2. **正则是所有不走工具的召回路径的唯一时间来源**。`packages/memory-engine/src/hybrid-memory-provider.ts:166`：`const scope = input.scope ?? parseTimeScope(input.query, now, this.#options.timeZone);`；`includeHistory` 直接决定是否搜已失效记忆（`:177`）。
3. **④ 的相关性判断其实是对模型自己选的指针做二次猜测**。模型在同一次调用里已给出 `existingMemoryId`、`decision`、`quote`（`packages/prompt-catalog/src/memory.ts:15,28`）；`parseMemoryCandidates` 再用 `quoteRelatesToMemory`（`apps/agent-service/src/production-memory-capture.ts:171-177`，词表在 `:148`）否决一次（`:362-369`）。逐字核对 `quoteFromOwnerMessage`（`:138-146`）是确定性的，独立于词表。
4. **② 的导入是“浏览器猜 + 人可改 + 后端照单收”**。`apps/control-center/src/memory-import.ts:29-49`（关键词→类别、健康/财务→敏感）；预览界面用户可逐条改（`apps/control-center/src/components/memory-page.tsx:1917-1985`）；后端 `#importCommit` 只校验 `assertStorable` 和契约层的 category 枚举（`apps/agent-service/src/production-memory-control.ts:996-1025`；`packages/gateway-contracts/src/contracts-v2.ts:1509`），**不再复算敏感级别**——分类值是客户端算好后经 `protectText` 传入的（`apps/control-center/src/memory.ts:224-238`）。
5. **⑤ 的泄露检查是出题阶段的拒收，三重检查里只有时间归一化是中文专用正则**。`packages/application/src/services/real-memory-eval.ts:158-168`：n-gram、数字、`dateTokens` 三种；裁判模型是另一次独立调用（`REAL_EVAL_JUDGE`，`packages/prompt-catalog/src/eval.ts:37`），已收到问题、记忆原文和回答。
6. **⑥ 的单号抽取在判断模型调用之前，且下游有确定性核验**。`packages/platform-node/src/gmail-related.ts:159-164`：抽出的单号去 Gmail 精确搜索，搜回的邮件还要 `mentions(message, reference)` 逐字核对（`:45-57`）；整个流程有请求预算和每日成本上限（`packages/application/src/services/proactive-mail-check-service.ts:829-857,914-918`）。
7. **发给模型的内容只追加、字节确定**（`.claude/rules/prompt-prefix.md:27-35,49-54`）：“每轮都会变的内容只放在最后一条用户消息里”“同样的内容，每次都要序列化成同样的字节”。
8. **敏感判错的后果不对称**：ADR 0193 决定敏感记忆不给模型看（材料给的位置）；产品顺序“用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率”（`docs/product-vision.md`，材料给的）→ 敏感级别宁高勿低，但类别（health/finance 等）判错只是组织问题。
9. 业界：Meta 开源的 Duckling 明说时间解析走“规则+样例的混合系统”：“temporal expressions are quite regular and hierarchical…A fully machine-learned approach…seemed difficult”（https://medium.com/wit-ai/open-sourcing-duckling-our-probabilistic-date-parser-4351ee66c4ba ）；Mem0 检索是“semantic、keyword、entity”加“Temporal: Scores candidates on time metadata extracted at write time against the query's temporal intent”（https://docs.mem0.ai/core-concepts/how-it-works ），其时间元数据是**写入时**由另一次模型调用抽的（https://docs.mem0.ai/core-concepts/memory-evaluation ）；Anthropic 的分类做法是封闭标签集+格式校验+失败兜底（https://www.anthropic.com/research/building-effective-agents 及其转述 https://www.agentnotebook.dev/tutorials/agentic-workflow-routing-python ）；n-gram 防泄露/防污染的先例是 GPT-3 的 13-gram 规则（https://arxiv.org/pdf/2005.14165 附录 C、https://github.com/EleutherAI/lm-evaluation-harness/blob/main/docs/decontamination.md ）。

## 二、方案本身

### ① 搜记忆的时间范围：拆成两半——程序只做“归一化”，不再做“意图”

**判断**：`includeHistory`（要不要搜被取代的历史记忆）是意图判断，正则猜它就该改；`from/to` 是把时间说法换算成具体日期，是**值归一化**，业界（Duckling、SUTime）都用规则引擎做，且主路径不允许加模型调用。所以**不是全部交给模型，而是拆开**：

- **工具路径（模型调 memory_recall）**：删掉 `production-memory-recall.ts:159` 的 `parseTimeScope` 兜底。模型没填 `from/to/includeHistory` 时，`from/to = null`、`includeHistory = true`（见下）。同时改 `TOOL_RECALL` 文字：给两三个正反例（“问现在的做法不要填 includeHistory”“问换手机前的情况要填 true”）。改说明只对新对话生效，符合冻结规则。
- **不走工具的路径（每轮自动召回、主动提醒、整理、评测、MCP）**：
  - `from/to`：把手写的约 200 行正则换成成熟的时间解析库 **chrono-node**（纯 JS，有日文/简繁中文 locale，GitHub: https://github.com/wanasit/chrono ，10k+ stars，被 date-fns 生态广泛使用），包一层 `parseTimeScope(query, now, timeZone)`，签名和输出结构不变（`{includeHistory, from, to}`），上层调用点（`hybrid-memory-provider.ts:166` 等）不动。
  - `includeHistory`：**不再用词表猜**。新规则：调用方没显式说 `includeHistory=false` 时一律 `true`；只有解析出的时间窗整体在未来（`from > now`）时才是 `false`。理由：误判“不要历史”会漏掉主人问的旧事实（违反记忆可靠性 > 效率），而多带的历史记忆有融合排序（`fusion.ts`）压着、结果里标“历史”，代价是多几条低分候选。原来的 `HISTORY` 词表（“以前/之前/过去/used to…”）整个删掉。

**每次新增模型调用说明**：无新增调用。成本 0；延迟增加是一次 JS 正则解析（毫秒级）。
**失败怎么办**：chrono 解析不出 → `from/to = null`（全量召回，靠排序）；chrono 抛异常 → 同上，记一行诊断日志；调用方显式传了 scope 就完全不碰解析器。

### ② 导入/手动添加的分类与敏感判断：搬到服务端，一次批量模型调用，人保留否决权

**判断**：导入一进来就有预览界面、用户逐条可改（memory-page.tsx 预览已存在），这是天然的人机复核点；浏览器端没有模型可用，所以分类必须搬到 agent-service。敏感判断**保留确定性检测且要补上服务端复算**，类别交给模型。

- **谁调、什么时候调**：agent-service 新增一个网关查询 `memory.import.classify`。控制台把解析出的候选条目（≤200 条、每条 ≤500 字，超出截断）发给它，在**预览界面打开时**调用（后台，不在对话主路径）。
- **输入**：固定指令（prompt-catalog 新条目 `memory.import-classify`，封闭类别表= `MEMORY_CATEGORY_NAMES` 九种）+ 按固定顺序编号的条目 JSON。固定在前、数据在后。
- **输出结构**：`{"items":[{"index":0,"category":"health","sensitive":false},…]}`，严格解析（照 `parseMemoryCandidates`/`parseJudgeVerdict` 的既有模式）；类别不在九种里或 index 越界 → 该条按失败处理。
- **成本/延迟量级**：一次调用，约 100 条 × 500 字 ≈ 15–20k 输入 token、几百输出 token，DeepSeek Flash 一类价格 < 0.01 美元；延迟几秒，预览本来是异步加载，可接受。
- **失败怎么办**：整次失败或单条输出不合法 → 该条 category = `other`、sensitive 只由确定性检测决定；条目仍出现在预览里等用户过目，不静默写库。**sensitive 的失败默认是“宁窄”**：确定性检测（`classificationWithIdentifiers`、`mentionsSensitiveMaterial`）照旧叠加，模型说敏感就敏感；模型没说、检测也没说，才不标——因为敏感级别过高只是“模型看不到”，过低是边界事故（前提 8）。
- **顺手补一个 I-73 式的两端核对**：现在 `#importCommit` 信任客户端传来的 classification（前提 4）。后端应改为 `classification = max(客户端值, classificationWithIdentifiers(text, "private"))`（照抄抽取路径 `production-memory-capture.ts:343-355` 的取高不取低模式）。
- **手动添加**（memory-page.tsx:2210 的实时正则猜）：删掉 `guessCategory` 实时猜。表单默认 `other`；用户停顿/失焦时发一次 `memory.import.classify`（单条），把模型建议填进下拉并显著标“建议”，用户可改。失败/超时 → 无建议、保持 `other`，不阻塞输入。

**证明改对了**：正向——导入一段含“我对花生过敏，匹克球球拍下周到货”的文本，预览里第一条 `health+sensitive`、第二条 `other`（或 goal），用户确认后落库；反向——同样的文本把确定性检测关掉（测试桩），断言“过敏”条目**仍**被模型标为 sensitive；再给一条“我最近在研究血压计的购买渠道”，断言它进 health 但由用户在预览里复核，不因词表误标 finance。

### ④ 抽取时的“引用和已有记忆相关”：删掉词表，把这个判断还给已经发生的那个模型调用

**判断**：模型既然已经选了 `existingMemoryId` 并给了 `decision`，“这句原话是不是在确认那条待确认规矩”就是它同一个判断的一部分，不该用二字组重合来否决它。**不加新调用，改同一个调用的输出契约**：

- `MEMORY_CAPTURE` 提示词（`packages/prompt-catalog/src/memory.ts`）加一字段：`confirmsTentative`——当 `decision` 是 `unchanged/update/merge` 且 `existingMemoryId` 指向待确认规矩时填 `true/false`，含义是“主人这条原话确实是在重申/认可这条规矩，而不是仅仅提到它”。
- `parseMemoryCandidates`（production-memory-capture.ts:259 起）：读这个布尔值；缺失或非布尔 → `false`。
- `:362-369` 的 `evidenceRejected`：删掉 `!quoteRelatesToMemory(...)` 这一项，改成 `confirmsTentative === false` 时拒；`quoteFromOwnerMessage`（逐字防编造）**原样保留**。`GENERIC_TERMS`、`relevanceTokens`、`quoteRelatesToMemory` 整体删除（含其测试 `production-memory-evidence.unit.test.ts:201-205` 改写）。

**成本**：0 次新调用，每条多几个输出 token。**失败默认**：字段缺失/格式坏 → 不确认（规矩保持待确认，等下一次出现或主人手动点头）——安全侧。
**两端核对**：产生方=抽取模型的 JSON 输出，消费方=同文件内确认逻辑，中间只隔 `parseMemoryCandidates` 的严格解析；待确认记忆的 id 集合本来就从 `tentativeMemories` 传入（`:264-267`），不存在 I-73 那种“一端认”的新值。
**证明改对了**：正向——待确认规矩“主人要 30 秒内的简短回答”，主人再说“以后回答都简短点”，抽取输出 decision=update + existingMemoryId + quote 逐字 + confirmsTentative=true → 规矩生效；反向——主人引用同一句规矩但说“那条‘简短回答’的规矩先取消”，期望模型不输出 unchanged+confirmsTentative=true（应走 supersede/新建），规矩不生效；再加一个程序级反向用例：输出里 confirmsTentative 缺失 → 确认不生效（防模型不配合时静默放行）。

### ⑤ 真实评测的防泄露：确定性预检保留，再给裁判模型加一个“是否泄题”字段

**判断**：这是评测管线的**保守拒收**（误报只是少收一道题，安全），n-gram 和数字重叠是业界标准做法（GPT-3 13-gram），**不该改**；时间说法归一化是中文专用正则，穷举不了（“下午三点”/“15 点”/“傍晚六点”/“18 時”…），但它守的事可以交给已经在场的裁判模型。**只改一部分 + 加一层**：

- `dateTokens`/`PART_OF_DAY` 等保留为第一道廉价预检（它挡掉明显泄题，省掉后面的回答+裁判调用）。
- `REAL_EVAL_JUDGE` 输出加一个字段 `questionLeaks: true|false`，定义写进裁判提示词：“只看问题文字本身，判断它是否已把答案及其关键时间/数字/日期用任何说法点出来（同义换算也算，如‘下午三点’与‘15 点’）”。裁判已经同时拿到问题和记忆原文（前提 5），加字段近乎零成本。
- 打分入库规则：预检不挡、但裁判 `questionLeaks=true` → 该题不入题库（记录原因）；裁判输出解析失败 → 照现有 `parseJudgeVerdict` 返回 null 的路径按无效处理（失败默认=不入库，安全）。

**成本**：0 次新调用。**证明改对了**：正向——记忆“主人 15 点开会”，出题“我下午三点有什么安排？”→ 预检 `dateTokens` 直接拒（现状已覆盖，real-memory-eval.unit.test.ts:142）；再构造预检漏掉的“傍晚六点”对“18:00”，断言旧代码放行、新代码被裁判拒收；反向——出题“我那天去的是哪个城市？”（答案是大阪，问题不含日期数字）→ 预检通过、裁判 questionLeaks=false → 入库。

### ⑥ 邮件里找订单号：不改成模型；它是“找一串格式化文本”，不是“判断意思”

**判断**：这处**不该改**。理由：(a) 抽出来的值要拿去 Gmail 做**逐字精确搜索**，查询串必须是字面单号，模型最多也只能输出候选字符串，核验 `mentions()` 反正还是确定性的；(b) 它发生在判断模型之前（前提 6），为它加一次前置模型调用会拖慢每次主动检查；(c) 关键词表在这里的角色是“候选召回启发”，漏检的代价只是少带几封相关邮件——判断模型仍然看得到这封邮件本身，输出 `amount` 的能力不受影响，失败默认安全。词表命中词过窄可以低成本扩充（例如补“受理番号”“跟踪号”“运单”等），这属于维护词表而非改机制。
**可选的零延迟增强**（拍板项）：判断模型的输出结构里加 `referenceIds`（它已经输出 `amount`，顺手输出邮件里提到的单号），存进主动检查的记录；同一邮件串下封邮件检查时，上一轮的 `referenceIds` 并入 `extractReferenceIds` 的结果一起搜。这样“模型判断”以异步方式补召回，不增加当轮延迟。失败默认：字段缺失 → 用词表结果，行为同现状。
**证明改对了**：正向——“注文番号： 250-1234567-8901234”抽出该单号并搜回相关邮件（现有测试 gmail-related.unit.test.ts:68 已覆盖）；反向——“ID 123456 and No. 99887766”（太短）与“order 2026-11-07”（日期）都抽不出、不发搜索（`:75-76` 已覆盖）；若做增强项，再加：判断模型输出的 referenceIds 经过 `mentions()` 核验才可用，编造的单号搜回的邮件不会被采纳。

## 三、共用机制

5 处**不共用一次“后台分类调用”**，因为它们的触发时机、输入边界和失败语义不同：① 是纯程序归一化；④⑤ 是给已存在的调用加字段；⑥ 判断不该改。真正共用的是**同一个模式**：prompt-catalog 的 `fixedPrompt`（固定指令在前、数据在后）+ 严格 JSON 解析器 + 封闭标签集 + 安全默认值——这正是 Anthropic 分类模式（前提 9）和本仓库既有实践（`parseMemoryCandidates`、`parseJudgeVerdict`）的合流。唯一的新独立设施是 ② 的 `memory.import.classify` 批量端点；它以后可以复用给 MCP 批量提议（`propose_memories` 的 category 预分类）等场景，但本期不做。

## 四、考虑过但不选的做法

- **① 每轮自动召回前加一次模型调用抽时间**：主路径加调用违反目标 2；Mem0 的做法也是把时间判断放在**写入时**异步做，查询端不付这个延迟（前提 9）。
- **① 换 Duckling**：Haskell 依赖+HTTP 服务，为单机房个人助手太重；chrono-node 同为成熟规则引擎且是 JS 原生。Duckling 的“规则+样例”论断支持用规则引擎做归一化，不等于要用它家实现。
- **① 把 includeHistory 也默认 true 到工具路径、模型不能关**：否——模型显式判断过就尊重模型，主人问“现在的做法”时不该被历史记忆刷屏；只把**程序猜**的部分去掉。
- **② 在浏览器里直连一个低价模型**：API key 进浏览器、绕开出口遮盖和成本上限，不考虑。
- **② 敏感判断也交给模型、删确定性检测**：违反“安全过滤保留”约束；且确定性检测是每次结果一致的那类（前提 7 的遮盖同级）。
- **④ 在确认环节再加一次独立模型调用复核相关性**：多一次调用、多一个失败点，而同一判断在同一次调用里模型已经做过；把否决权换成字段更便宜也更一致。
- **⑤ 删掉全部正则预检、只靠裁判**：泄题题会先进回答模型再被裁判拒，浪费每题两次调用；预检挡掉大头，二者是层次不是替代。

## 五、风险与反例（推测，需用例守）

- ① includeHistory 默认 true 会让“历史记忆”更常出现在召回候选里，融合排序的 cutoff 需要用 `test/integration/memory-engine-index.test.ts:308` 那类用例重新校准；极端情况：主人问“我现在用什么手机”，旧手机记忆作为历史出现在候选里但不该进最终结果——反例用例必须断言它排在生效记忆之后或被 cutoff 滤掉。
- ② 批量端点是把主人私人文本发给第三方模型的**新出口**：必须走既有出口遮盖（和 capture 同一管线），并在方案页写明这一点；若主人记忆里有极高敏内容，导入预览本来就让人工把关。
- ④ 模型可能为了“讨好”把 confirmsTentative 猜成 true：防线是 quote 逐字 + decision 限定；但“主人引用规矩原文进行批评”这类反例（上文）必须进测试。
- ⑤ 裁判加字段后裁判提示词变长，评测题库的判定分布会整体偏移：上线时对旧题库重放一遍对比（评测本来就有回放机制）。
- ⑥ 若做增强项，模型输出单号可能带幻觉：`mentions()` 逐字核验是硬闸，未命中即弃。

## 六、需要人（Andy）拍板的取舍

1. ① includeHistory 默认改为 true（宁多带不漏带）——改变现有“猜不出就不带历史”的行为，多付一点候选噪音。
2. ① 是否接受引入 chrono-node 依赖（新增第三方库 vs 继续维护 200 行自写正则）。
3. ② 新增一个把导入文本发给第三方模型的端点（出口已被遮盖覆盖，但属于新数据流）。
4. ⑥ 是否做“裁判模型异步补单号”的增强项（可延期）。

## 七、必答问题逐条回答

**1. 会不会改变模型已见过的请求开头？**
不会。①②④⑤⑥ 全部不触碰对话请求：① 的解析结果只影响检索范围，召回的记忆本来就是“本轮选中的记忆”落在每轮末尾（`.claude/rules/prompt-prefix.md:28`）；② 是独立网关调用，不组装对话上下文；④⑤ 是给后台调用的 JSON 契约加字段（后台调用规则 `prompt-prefix.md:67`：固定在前、数据和时间在后，本仓库 capture/judge 已照此排）；⑥ 不改。④⑤ 修改的提示词属 prompt-catalog 固定文字，只对新调用生效，且后台调用不参与对话冻结。注意一点（推测）：改 `TOOL_RECALL` 说明文字只对新对话生效，老对话的工具说明冻结不变，正则删除对老对话同样生效（它在程序侧）。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会。所有方案里进模型上下文的内容（召回的记忆、导入预览、评测题目）都不按“前后文”变化序列化；② 的批量分类按固定编号顺序输入输出；① 的 from/to 是 ISO 字符串由确定函数生成；没有任何带时间戳的字段进请求头。唯一要盯的是 ② 批量输入的 JSON 键序和条目顺序必须固定（`prompt-prefix.md:51`），实现时用 `Object.freeze` 的定序数组，像 `parseTimeScope` 返回 `Object.freeze` 那样。

**3. 有没有对应的自动检查、反向用例会不会真的失败？**
- ①：`packages/memory-engine/test/time-scope.unit.test.ts` 重写（chrono 映射用例 + “HISTORY 词表不再存在”的负断言）；反向用例：构造“以前”查询断言 `includeHistory === true` 且不再依赖词表——在删除实现的旧代码上会失败。`test/integration/memory-episodes.test.ts:318`、`memory-evaluation.test.ts:505` 同步更新。对话请求的追加性由既有 `npm run check:prompt-prefix` 兜住（反向用例已内建，`prompt-prefix.md:74`）。
- ②：`apps/control-center/test/memory-interactions.unit.test.ts:1720-1722` 的词表用例改写为端点用例：正向（过敏→health+sensitive）、反向（模型桩返回垃圾 JSON → category=other、条目仍进预览、不落库）；后端取高不取低用反向用例“客户端传 private、文本含证件号 → 服务端存 sensitive”，在旧代码上失败。
- ④：`production-memory-evidence.unit.test.ts` 改写；反向两条——confirmsTentative 缺失不生效（旧代码因 quoteRelatesToMemory 通过也会生效？不：旧代码没有该字段，该用例构造“引用逐字+词表重合但语义无关”在旧代码**误生效**、新代码不生效，即反向用例在旧实现上失败）、引用规矩原文但语义是取消 → 不生效。
- ⑤：`real-memory-eval.unit.test.ts:127-145` 保留并新增裁判桩用例（返回 questionLeaks=true → 不入库，反向在旧代码上入库而失败）。
- ⑥：现有 `gmail-related.unit.test.ts:68-80` 保留；若做增强项，加“幻觉单号被 mentions 拒收”用例。

**4. 每个新值，产生端和使用端都核对了吗？**
- ① `from/to/includeHistory`：产生端=chrono 包装层/模型参数，使用端=`fusion.ts` 排序与 `index.search` 的 includeHistory（`hybrid-memory-provider.ts:166-180`）——结构体 `MemoryTimeScope` 不变，两端无新校验需求。
- ② `memory.import.classify` 输出的 `index/category/sensitive`：产生端=模型+严格解析器；使用端=控制台预览（下拉枚举同一份 `MEMORY_CATEGORY_NAMES`）→ `memory.import.commit`（契约层枚举校验 `contracts-v2.ts:1509`）→ `#importCommit`（新增服务端 classification 复算）。I-73 的教训（`docs/incidents-and-gates.md:112`：“双模型复核只看了 diff，没问清单里的 id 能通过后端校验吗”）对应检查=契约测试+新增的反向用例。
- ④ `confirmsTentative`：产生端=抽取模型+解析器（缺失→false）；使用端=同文件确认逻辑（`:358-369`）；无跨进程传播。
- ⑤ `questionLeaks`：产生端=裁判模型+`parseJudgeVerdict` 扩展；使用端=题库入库判定；解析失败→null→不入库。
- ⑥ `referenceIds`（若做）：产生端=判断模型输出；使用端=下一轮 `findRelatedMail`，且必须过 `mentions()` 逐字核验才算数。

## 八、再找同类处（任务 5）

已核实（文件:行）：
- `packages/memory-engine/src/segmentation.ts:5` `STOPWORDS`——中文停用词表，用于检索分词/关键词匹配。**判：保留**。这是检索索引机制（和 Mem0 的 keyword 信号同性质，前提 9），不是判断用户意思；删它反而伤检索。
- `apps/control-center/src/memory-import.ts:24-26` `RULE`、`SKIPPED_SECTION`——`RULE` 参与“rule/preference”归类（`:98-100`），**并入②处理**；`SKIPPED_SECTION` 是跳过已知导出格式的段落标题，**判：格式解析，保留**。
- `apps/control-center/src/memory-import.ts:140-146` 按 `/user profile/|user preferences|general tips/` 路由段落——对已知导出文件的结构解析，**判：保留**（若要彻底，可把格式识别也交给模型，但收益低）。
- 其余四处本身就是本题对象：`time-scope.ts:19-20`（HISTORY）、`memory-import.ts:29`、`production-memory-capture.ts:148`、`real-memory-eval.ts:128-129`、`gmail-related.ts:14`。

未核实：是否还有隐藏在别的包里、形如“中文词数组→判断”的地方；我做了三轮定向 grep（中文关键词正则、KEYWORD/STOPWORDS/GENERIC_TERMS、分类相关），以上是全部命中。建议实施时以 `grep -rn "\p{Han}.*\|.*\p{Han}" --include=*.ts` 式扫描再过一遍。
