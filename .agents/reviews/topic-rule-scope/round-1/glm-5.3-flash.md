# 方案：主人一句话的时效由「模型读整句、程序只做可判定校验」决定，并把「到期」补进规则本身

## 一、方案依赖的前提（来源 + 原话）

**读代码证实的：**

1. 词表判断在 `apps/agent-service/src/production-owner-rules.ts:450-468`（`isStandingQuote`），唯一使用点在第 799-801 行：`!input.inferred && isStandingQuote(quote) && (await this.#ownerSaid(input.threadId, quote))` 才直接生效。词表共 5 组常量（第 54-239 行，含约 90 个 `ONE_OFF_MARKERS`）。
2. 规则参数解析在 `packages/application/src/rules/rule-types.ts:379-396`（`parseOwnerRuleParameters`），`parameters` 只认 `type/params/summary`，没有时效字段；`RuleStatus` 只有 `active|needs_review|retired`（`rule-book.ts:12`），没有到期概念。出处记忆的 attributes 里已有 `validFrom/validTo` 字段但恒填 null（`production-owner-rules.ts:609-610`）。
3. 规则在两个执行点装填：邮件检查 `packages/application/src/services/proactive-mail-check-service.ts:636-645`（`#storedOwnerRules` 逐行 `enforceableOwnerRule`，该服务有 `clock`）；推送闸门在 `apps/agent-service/src/service-main.ts:2394` 同样逐行装填。裁判 `RuleJudge.decide` 是纯函数（`rule-judge.ts:29-38`），不知道时间。
4. 旁路调用的两个先例：`apps/agent-service/src/production-thread-titles.ts:80`（固定指令 + `JSON.stringify({userMessage: …})`，失败回退、占位符恢复）；`packages/application/src/services/proactive-mail-check-service.ts:1277-1310`（`ModelPort.prepare/invoke`，带 deadline 与 dataClassification）。
5. 提议去重键不含时效（`production-owner-rules.ts:807-815`：哈希输入是 `[ownerId, type, params, summary, quote]`）。
6. `rule_set` 工具描述现写死“只在主人说的是以后一直有效的要求时使用”“quote 要包含表示一直有效的字样”（`packages/prompt-catalog/src/tools.ts:231`），这套说法和“去掉词表”直接冲突。
7. 测试语料在 `test/integration/production-memory-capture.test.ts:2097-2139`，42 句正反例。

**文档证实的：**

8. 原则顺序：`docs/product-vision.md:55`，“原则冲突时，按序优先：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。”
9. Andy 已定：ADR 0213 第 32 行，“明说‘以后/一律/必须’的直接生效、回执卡上给试算、回放和一键撤销；模型推断出来的只生成提议，主人点头才生效。”
10. 缓存规则：`.claude/rules/prompt-prefix.md` 规则 6——“系统提示和工具按对话冻结……只有下面这些情况才换新一次，并且每次都留记录：工具集合变了（工具名，或者去掉说明文字后的参数结构）……”；规则 15——“后台调用也是固定的在前、会变的在后……最后放当前时间这类每次都变的值”；规则 4——已发内容只能末尾追加。
11. I-73 教训：`docs/incidents-and-gates.md:112`，“双模型复核只看了 diff，没问『清单里的 id 能通过后端校验吗』”→ 每个新值要两端都校验。
12. ADR 0244 决定 5 自认：“词表是启发式的，漏掉的说法最坏结果是多立一条主人可以撤销的规则。”

**业界（一手）：**

13. Anthropic：用轻量模型单独做分类、用结构化输出限定答案 — https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks
14. OpenAI 护栏 cookbook：便宜模型与主模型并行分类，权衡准确/延迟/费用 — https://developers.openai.com/cookbook/examples/how_to_use_guardrails
15. ChatGPT 定时任务官方帮助：任务显式分 one-time 与 recurring，创建后在对话里回显确认卡，统一在 Scheduled 页管理（暂停/编辑/删除）— https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt
16. Claude Code 调度工具 `CronCreate`：“Accepts a 5-field cron expression, the prompt to run, and whether it recurs or fires once”；且循环任务 7 天自动过期——“This bounds how long a forgotten loop can run” — https://code.claude.com/docs/en/scheduled-tasks
17. Gemini scheduled actions：对话里回显摘要卡（做什么、何时、频率），Scheduled 页管理，上限 10 条、不活跃自动停 — https://support.google.com/gemini/answer/16316416 、https://blog.google/products-and-platforms/products/gemini/scheduled-actions-gemini-app/

---

## 二、方案本身

### 1. 谁判断、输出什么、程序怎么核对、限时怎么执行

**判断是“一主一备”，决定权在程序。**

**第一意见：主模型。** `rule_set` 的参数加一个必填结构（主模型填）：

```
temporal: {
  span: "standing" | "until" | "once",   // 长期 / 到某时刻为止 / 只管这一件
  basis: string                           // 原话里支撑这个判断的字（照抄）
}
```

主模型有整段对话上下文（“像刚才说的那样”能解出来），且本来就读了整句，不加调用次数。

**第二意见：旁路便宜模型。** `create()` 在判“直接生效”之前发一次旁路调用，沿 `production-thread-titles.ts` 的模式封装成注入端口（如 `classifyTemporal`）。提示词排法守 prompt-prefix 规则 15：固定指令在前 → 主人原话（quote）+ 规则类型在中 → 当前时间放最后。输出受约束 JSON：

```
{ "span": "standing" | "until" | "once", "until": "<RFC3339>|null", "basis": "<照抄>" }
```

模型经 Magpie 动态取，不写死模型名。未核实点：`service-main.ts:1483` 和 `production-http-composition.ts:1084` 两处构造 writer 时能否顺手注入一个 model 调用端口（两处都已具备 threads/payloads/protector/clock，按 titles 的接法应该可行，需要实施时确认）。

**程序只做四类可判定校验，不做语义判断：**
- `span` 在三值枚举内；
- `basis` 经 `foldText` 后必须是 quote 的子串（**锚定校验**：模型引用的字必须真的在主人原话里；程序不再维护“哪些词算长期”的清单，只验“引用属实”）；
- `until` 是合法 RFC3339、晚于当前时刻、不超过上限（建议 400 天）；
- 旁路输出解析失败/字段非法 = 判断失败，不是建规则失败。

**程序决策表（确定、无词表）：**

| 条件 | 结果 |
|---|---|
| `inferred=true` 或 `ownerSaid` 失败 | 提议（不变，ADR 0213 第 32 行） |
| 两边都说 `standing` 且锚定通过 | **直接生效** |
| 任何一方说 `until`/`once`、两边不一致、旁路失败/超时/坏输出 | 提议，提议参数里带 `span` 和（能解析时的）`until` |

`until/once` 走提议而不是直接生效，理由：`until` 的绝对时刻是算出来的值，错了会在主人没点头的情况下多静默一段——这违反“用户主权 > 主动性”。卡片上明写“这条规则到 11 月 16 日 23:59 为止（提议）”，主人点一下才生效，时刻错误在生效前可见。（这条偏保守，见“需要人拍板”第 1 条。）

**执行（把“到期”补进规则本身）：**

- 存储：`parameters` 加可选 `span`（缺省 `standing`，兼容已存行）与 `until`（`span=until` 时必填），`parseOwnerRuleParameters` 校验并统一序列化成 UTC ISO。出处记忆的 `attributes.validTo`（字段已存在，现在恒 null）填 `until`，出处与规则一致。
- 装填点过滤：邮件检查 `#storedOwnerRules` 和推送闸门装填处用时钟跳过 `span=until && until <= now` 的行；首次发现过期时顺手 `setStatus retired, reason:"expired"`，列表页显示“已到期”。`RuleJudge` 保持纯函数。
- `once` 规则第一次命中即自动停用：邮件检查和推送闸门的命中处理处（本就写决策记录）加 `setStatus retired, reason:"consumed"`；同批多封命中同一条时本批全部执行、批后停用；停用写失败则规则继续执行、下次再消耗（宁多执行，不少执行）。
- 回执卡、`rule_list`、决策记录依据抽屉、数据导出都显示 span/until。
- **词表整体删除**：`STANDING_MARKERS`…`STANDING_STARTS`（第 54-239 行）、`isStandingQuote`、`containsMarker`。`foldText` 保留给锚定校验。

### 2. 根因修复还是表面修补

**根因修复，而且一次修两个根子。** 根子一：用封闭枚举逼近开放语言——词表永远收不全（PR 414 六轮复核每轮都漏），本方案把“读整句”还给模型，程序只保留可判定的校验（枚举、锚定、格式、双方一致），开放问题不再用枚举解决。根子二：规则没有“到期”，所以即使认出限时说法也只能立成永久规则——本方案把 `span/until` 补进存储和两个执行闸门。只删词表不加到期，是半个修补；“这个周末别提醒我”会变成一张标着“长期”的提议卡，错误形态没变。

### 3. 业界遇到同样情况怎么做，用户看到什么

三家共同点：**一次性与周期性是显式的两种结构，不靠猜；创建后立刻在对话里回显一张“生效内容+时刻”的卡；有统一页面可查看/暂停/删除。**
- ChatGPT：任务显式分 one-time / recurring，对话里给确认卡，Scheduled 页统一管理（https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt）。
- Claude Code：`CronCreate` 显式带 "recurs or fires once"，循环任务 7 天自动过期（防“被遗忘的循环”）（https://code.claude.com/docs/en/scheduled-tasks）。
- Gemini：scheduled actions 回显摘要卡，Scheduled 页编辑/暂停/删除，不活跃自动停（https://support.google.com/gemini/answer/16316416）。

对应到 Himawari：回执卡就是那张“对话里的确认卡”，记忆页“长期规则”就是 Scheduled 页——本方案把 span/until 加进这两处，加一个“已到期/只管一次”的状态显示，正好对齐。

### 4. 会不会改请求开头；怎样把影响降到最小

**会改一处，且只有一处：`rule_set` 的工具定义**（参数结构加 `temporal`，描述文字删掉“要包含表示一直有效的字样”并解释三种时效）。系统提示、历史、遮盖都不动。处理：
- 按 prompt-prefix 规则 6，参数结构变化换新一次、留记录——合法。
- **必须在 PR 414 上线前合并**：PR 414 本身已改工具定义且未上线，赶在一起则老对话总共只重建一次缓存；晚一步就是第二次重建。
- 每轮会变的值（当前时间、quote）都在旁路调用自己的末尾，不进主对话；旁路输出只落库、上卡片，回执作为工具结果追加在历史末尾——符合“只追加”。
- 未核实点：换新的判定代码是否把“描述文字变了”也算换新（规则 6 的口径是“工具名或去掉说明文字后的参数结构”——本方案两者都动，无歧义）。

### 5. 失败路径

- **旁路超时/出错/坏输出**：重试一次（沿用邮件检查的调用封装），再失败→提议。直接生效这条路在旁路不可用时是关死的。
- **两边不一致**：提议。日志记 disagreement 计数，作为上线后监控指标；卡片只显示程序采用的保守结果。
- **主人说法含糊**（“别提醒我”没给范围、“那个周末”）：两边看同一文本，任一方不判 standing→提议；工具描述指示模型拿不准先问主人（`push_quiet_hours` 描述已有“没说钟点先问清楚”的先例，`tools.ts:231`）。
- **`until` 解析不出**：视同分类失败→提议，`span` 落回 `standing`，卡片时效一行明示“未能确定时限，默认按长期预览”，日志计数。这是最坏退路，但提议必须主人点卡才生效，不是悄悄执行。
- **once 消耗写库失败**：规则照常执行，下次命中再消耗；不出现“该停的没停还报错打断”。

### 6. 怎样测试（含反向用例），不依赖真模型

分类器是注入端口，测试全部打桩；真模型沿用 `scripts/evals/owner-rule-live.eval.ts` 的手动 eval（ADR 0213 后果 5 的先例），把 42 句语料扩成 span 三分类用例，人工跑、不进 CI。
- **存储校验**：`span=until` 缺 `until`、`until` 在过去、超上限、非法格式、未知 span、**已存的老行没有 span 必须仍解析为 standing**（兼容性反向）。
- **锚定校验**：`basis` 不在 quote 里必须拒（正向+反向，含大小写/全半角折迭后的匹配）。
- **执行**：假时钟下 until 规则过期后被跳过并标记 retired（反向：未过期的不得被过滤）；once 规则首次命中后停用、同批第二封仍执行（反向：消耗失败不得阻断执行）。
- **决策表**（打桩）：两边 standing→active；一边 until→proposed；不一致→proposed；旁路超时/坏 JSON→proposed；`inferred=true` 即使双 standing 也不得直接生效（反向）；`ownerSaid` 失败不得直接生效（反向）。
- **两端契约（I-73）**：新增字段进 `memory.rules.read` 网页契约，加一道类似 `check:model-ref-contract` 的契约检查：存储解析出的每个值必须能过前端契约校验、两端规则一致，反向用例“存储里塞契约不认的 span 必须失败”。
- **缓存**：`check:prompt-prefix` 照跑；换新记录用 `thread-prompt-bundles` 测试覆盖。

---

## 三、考虑过但不选的做法

1. **只让主模型填 span，不加旁路核对**。省一次调用，但“一次性变永久”的防线只剩一张卡片——主模型自评 `inferred` 已在实测里错过 1/15（ADR 0213 后果 5），span 判错的后果更重（永久静默）。第二意见只把守危险方向，值得。
2. **不改工具定义，纯旁路判断**。缓存零影响，但 `tools.ts:231` 的描述明写“只在长期要求时使用”，限时请求模型根本不会调 `rule_set`，目标 1 落空；且主模型失去提交第一意见的通道，上下文引用（“像刚才那样”）无人能解。
3. **把到期写进 CEL 表达式（如 `now < until`）**。表达式由参数生成是 ADR 0209 定的（ADR 0213 前提 2），往表达式里塞时间要在两道闸门的事实表里加 `now`，牵动内置规则和回放；在装填点过滤是一行比较，语义还一样。
4. **限时规则也直接生效**（只要双模型一致+锚定通过）。对主人更省事，但绝对时刻是算出来的值，直接生效意味着算错也先跑——违反“边界与可逆性 > 主动性”。放到“需要拍板”。
5. **保留词表作为“反向否决”（词表说 one-off 就强制提议）**。看似双保险，实际把词表的误判又请回来了（“这个周末”就是词表漏判的直接生效来源），和“不再用词表”的决定冲突。

## 四、风险和反例

- **两个便宜模型一致地判错**：“这个周末别提醒我”双双判成 standing→直接生效永久静默。缓解：卡片明示“范围：长期”+依据词（锚定的 `basis` 显示给主人）+一键撤销+决策记录；disagreement/回撤率监控。**无法消除，只能缩小**——这是把词表的确定性错误换成模型的低概率错误，方向上是用已知的低频错误换掉已证实的高频错误。
- **同句重复调用的去重**：proposalId 哈希不含 span，第一次已存 standing 提议后第二次判 until 不会再存新提议（`production-owner-rules.ts:807-815`）。低危，测试固定行为即可。
- **老对话的冻结描述**仍是旧文本（“只在长期要求时使用”），换新前模型可能拒绝对限时请求调 `rule_set`——一次性行为，换新后消失。
- **once 消耗在热路径写库**：只在首次命中发生一次；失败方向是“多执行”，安全。

## 五、需要人拍板的取舍

1. **`until/once` 提议要不要也免点直接生效**（我建议：不，保持提议+一次点击；若 Andy 要省事，可改为“双模型一致+锚定通过才直接生效限时”，但时刻错误会先跑）。
2. **合并时机**：必须赶在 PR 414 上线前，否则老对话多付一次全价重建。
3. **`until` 上限**（建议 400 天）和 `once` 消耗语义是否这期一起做（建议做——“这封必须提醒我”立永久规则正是 PR 414 的 bug 类）。

## 六、已证实与推测分开

- **已证实**：第一节全部前提；决策表涉及的每个代码位置（第 800 行判断、两个装填点、参数解析、提议哈希、工具描述、测试语料）；业界的任务/调度产品形态（三家公司官方文档）。
- **推测**：旁路模型端口在两处 writer 构造点的可注入性（有 titles 先例，未接线核实）；旁路模型对 42 句语料的三分类准确率（需手动 eval）；Magpie 侧对结构化输出的约束程度（若无 JSON 模式，靠闭合枚举校验+重试兜底）。

## 七、逐条回答必答问题

1. **请求开头**：系统提示不动、历史不动、遮盖不动；只有 `rule_set` 工具定义变一次，按 prompt-prefix 规则 6 换新、留记录，且与 PR 414 合并使总换新次数不变。每轮会变的值（当前时间、quote）都在旁路调用的末尾；旁路结果只落库上卡，回执追加在历史末尾。发给模型的内容仍只在末尾追加。
2. **字节确定性**：span/until 是判断结果，进数据库和卡片，不注入模型可见前缀；`until` 统一 UTC ISO 序列化；遮盖规则不涉及新值。回执文本可能因模型而异，但那是每轮新追加的消息，不改已发字节。提议哈希不含 span，去重行为固定、有测试。
3. **自动检查**：有，且全部打桩不依赖真模型——存储校验、锚定校验、过期/消耗的假时钟集成测试、决策表反向用例（不一致/超时/坏输出/inferred=true 都必须停在提议）、两端契约检查（反向：存储的值过不了前端契约必须失败，对齐 I-73 门槛起法）；真模型走手动 eval 语料。
4. **每个值两端核对**：`span`（主模型产生→工具 schema 枚举+`parseOwnerRuleParameters` 双重校验→执行过滤/卡片/契约消费）；`until`（旁路模型产生→RFC3339/未来/上限校验→装填点过滤、列表状态、卡片、记忆 `validTo` 消费）；`basis`（主模型产生→锚定校验→卡片“依据”消费）；旁路输出 schema（旁路产生→程序闭合校验→决策表消费）；网页契约新字段（后端产生→前端消费，加契约检查）。每条都两端有校验，且反例会失败。
