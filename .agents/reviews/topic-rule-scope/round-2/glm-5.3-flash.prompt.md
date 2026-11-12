你是独立的方案审核者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面是一份还没动手实施的方案。逐条对照代码和一手来源核对：有没有漏掉的场景、判断错的地方、和业界成熟做法不一致的地方。方案作者的说法可能有错。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：测试有没有覆盖这次改动、文档和规则与代码是否一致；挑一条最普通的使用流程，从入口走到结束，标出经过的、没有测试覆盖的代码路径。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你走过的流程和结论。
输出格式：按严重度从高到低排列，每条写：严重度、问题、证据（文件:行引用的代码，或网址和原话）、你建议怎么改。把「证实的」和「推测」分开写。最后写：如果由你来定，你会怎样改这份方案，并逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 cc2c9cc908be3d698cdb76587de43970b006f452。
待审核的方案：
# 方案：一句话管多久，交给模型读整句判断；限时规则到点失效

状态：整合稿（线程方案 + DeepSeek、GLM 各自独立出的方案），待两模型审核、Andy 拍板。基于 PR 414 分支 `claude/project-thread-69y41f` 提交 `cc2c9cc9`。

## 一、前提（附来源和原话）

1. Andy 定的生效规则。`docs/adr/0213-owner-sentence-becomes-a-standing-rule.md` 第 32 行：“明说‘以后/一律/必须’的直接生效、回执卡上给试算、回放和一键撤销；模型推断出来的只生成提议，主人点头才生效”。
2. 现在“明说”靠词表核对。`apps/agent-service/src/production-owner-rules.ts` 第 799–801 行：`!input.inferred && isStandingQuote(quote) && (await this.#ownerSaid(input.threadId, quote))`；词表在第 54–239 行。ADR 0213“放弃的做法”（第 80–85 行）没有讨论用模型核对。
3. 当初接受词表的理由。`docs/adr/0244-hard-rules-step4-unified-push-gate.md` 第 53 行：“词表是启发式的，漏掉的说法最坏结果是多立一条主人可以撤销的规则”。
4. 规则没有到期概念。`packages/application/src/rules/rule-types.ts` 第 436–447 行 `enforceableOwnerRule` 只看 `status`；`rule-book.ts` 的状态只有 `active|needs_review|retired`。
5. 偏好（`type: soft`）这条路没有任何时效检查。`production-owner-rules.ts` 第 765–768 行只要求 `!input.inferred && ownerSaid`，所以“这次回答短一点”可以被存成永久偏好。
6. 外部 agent 经 MCP 提的规则走同一个 `create`，固定 `inferred: true`，并要求返回 `proposed`。`apps/agent-service/src/production-mcp-rule-writer.ts` 第 70–84 行：`if (receipt.status !== "proposed" || receipt.proposalId === null) throw new Error("MCP_RULE_PROPOSAL_NOT_STORED")`。
7. 主模型每轮能看到当地时间。`packages/runtime-pi/src/pi-runtime-adapter.ts` 第 631 行 `localTime: localTime(projection.prompt.occurredAt, timeZone)`。
8. 工具定义按对话冻结。`.claude/rules/prompt-prefix.md` 第 6 条：“工具集合变了（工具名，或者去掉说明文字后的参数结构）……才换新一次”；“改了提示词文字，只对新对话生效”。PR 414 未上线，本身已改 `rule_set` 参数结构一次。
9. 旁路调用先例：`apps/agent-service/src/production-thread-titles.ts`（固定指令在前、数据在后）；用量用途白名单 `packages/persistence-sqlite/src/sqlite-model-usage-operations.ts` 第 22 行 `MODEL_USAGE_PURPOSES`。
10. 业界一手资料：
    - Anthropic：关键判断另用轻量模型单独分类，用结构化输出限定答案（https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks）。
    - OpenAI 护栏 cookbook：便宜模型与主模型并行分类（https://developers.openai.com/cookbook/examples/how_to_use_guardrails）。
    - ChatGPT 定时任务：一次性和重复是两种显式结构，一次性用相对偏移、重复用 RRULE（https://simonwillison.net/2025/Jan/15/chatgpt-tasks/ ，2025 年泄露的工具提示）。
    - Claude Code 定时任务：创建时指明重复还是只跑一次，循环任务 7 天自动过期：“Accepts a 5-field cron expression, the prompt to run, and whether it recurs or fires once”，“Recurring tasks automatically expire 7 days after creation”（https://code.claude.com/docs/en/scheduled-tasks）。
    - iPhone 专注模式：“1 小时”“到今晚”（https://support.apple.com/guide/iphone/turn-a-focus-on-or-off-iph5c3f5b77b/15.0）。

## 二、对标和根因

- **ChatGPT/Claude 怎么做、用户看到什么**：意图由模型读整句判断；“今晚别打扰”“这周每天提醒”这类说法，被表示成带结束时间或只执行一次的设置，对话里出一张写明“到什么时候”的确认卡，有统一页面可撤销。关键动作另有独立的小模型分类把关。
- **根因有两层**：(1) 用写死的词表做语义判断，开放的说法永远收不全；(2) 规则没有“到期”，限时的话即使认对了，也只能变成一张永久规则的提议，主人一点就永久生效。只换判断方法不补“到期”，仍是半个修补。本方案两层都修。

## 三、方案

### 1. 两个读者各自读整句

- **主模型**：`rule_set` 加必填 `scope`：`{"kind":"standing"}`（长期）或 `{"kind":"until","until":"YYYY-MM-DDTHH:MM"}`（主人当地时间，到这一刻为止）。主模型有整段对话，能解出“像刚才那样”。只针对眼前一件事的话（“这封先不用管”“这次回答短一点”）不是规则，不调用。说不清时效的（“先别提醒我”“下个月起”）先问主人，和现在“夜里没给钟点先问”同一做法。
- **核对模型（旁路，一次小请求）**：只在主模型标 `inferred=false` 时调用（推断的本来就要主人点头，外部 agent 的提议也是 `inferred=true`，不受影响）。输入：固定指令 → 主人最近 6 条消息中含原话的那几条和原话本身（JSON 包裹，声明是资料不是指令）→ 当前当地时间和时区（放最后）。输出结构化 JSON：`{scope: "standing"|"until"|"single"|"unclear", until: string|null, evidence: string}`。`evidence` 必须是原话里照抄的一段（程序核对是子串），用来防止模型凭空判断，也显示在回执卡上。不要“置信度”字段：模型自报的置信度不可靠，两个读者是否一致才是信号。
- 模型从配置的模型引用取（新配置键，缺失时不直接生效），不写死模型名；用量记新用途 `rule-scope`。

### 2. 程序只做可判定的核对（不判断语义）

| 情况 | 结果 |
|---|---|
| `inferred=true` 或原话不是主人说的 | 提议（不变），卡上带主模型给的时效 |
| 两边都 `standing` | 直接生效，长期 |
| 两边都 `until`，结束时刻相差 ≤ 1 小时（取较早的） | **直接生效，到点自动失效**（见“要 Andy 拍板”） |
| 核对模型说 `single` | 不立规则、不写偏好，返回“这句只管这一次”，主模型直接处理这一次 |
| 核对模型说 `unclear`，或两边时效不一致 | 不立规则，返回“请问清楚：长期、到什么时候、还是只这一次” |
| 核对调用超时、出错、输出不合格（枚举外、`evidence` 不在原话里、`until` 早于现在或超过上限） | 提议，卡上写主模型给的时效，主人点一下才生效 |

- 偏好（`soft`）同样走这一套：`single` 不存，`until` 的偏好把到期时刻写进出处记忆已有的 `validTo` 字段（现在恒为 null），召回时过滤掉过期的。
- 词表、`isStandingQuote`、`containsMarker` 全部删除。

### 3. 限时规则怎样执行

- 到期时刻存进规则参数 JSON（`parameters` 已经是 JSON，**不改表、不进改表排队**），`parseOwnerRuleParameters` 校验并统一成 UTC。
- 所有执行点改成 `enforceableOwnerRule(row, now)`：过期的视为不生效。邮件检查、推送闸门、MCP 读取、规则列表都经这里。
- 推送闸门往后找“什么时候能发”时逐分钟判断，过期时刻之后的分钟不再算静默；延后的推送在规则到期时放出。
- 过期规则不改数据库状态，按时钟显示“已到期”，不计入 32 条上限，仍可撤销。
- 提议编号和同规则去重把到期时刻算进去，不同结束时间不合并。
- 回执卡、记忆页“长期规则”、`rule_list`、决策记录依据、数据导出都显示“长期”或“到 11-16（周一）0:00 为止”。数据导入遇到不认识的到期字段要拒绝，不能悄悄变成永久规则。

### 4. 工具描述

删去“quote 要包含以后、必须这类字样”，改写为时效说明。参数结构变了，按规则第 6 条老对话换新一次；**和 PR 414 同一次上线时，总共只换新一次**。

## 四、失败路径

见上表。核心是：核对模型挂了不会让规则悄悄永久生效，也不会因为我们自己的故障去追问主人，只是多点一下。

## 五、测试

- 集成测试用本机回环模型服务按脚本回答（项目已有做法，例如 `packages/runtime-pi/test/prompt-prefix.compat.test.ts`）：上表每一行一条，含反向（`inferred=true` 两边都长期也不直接生效；`evidence` 不在原话里不直接生效；外部 agent 提议仍返回 `proposed`）。
- 假时钟：限时规则到期前延后、到期后不延后并放出（反向）；过期规则不计 32 条上限；同参数不同到期不合并。
- 实测评测（真模型，手动跑，不进 CI）：PR 414 六轮复核找出的全部漏网说法 + 中日英各约 20 条，DeepSeek V4.1 Flash 跑 3 次，预计不到 0.1 美元，跑前报 Andy。
- `npm run check:prompt-prefix` 照跑；工具换新由 `test/integration/thread-prompt-bundles.test.ts` 覆盖。

## 六、代价

- 每次明说立规则多一次小请求，约 1–2 秒，可与历史回放并行。立规则很少，费用可忽略。
- `rule_set` 工具定义变一次，必须赶在 PR 414 上线之前，否则老对话多付一次全价重建。

## 七、要 Andy 拍板

1. 明说的限时规则（两个模型都读出“到周日为止”）直接生效还是也先点一下。建议直接生效：符合“明说直接生效”，而且到点自动失效、卡上写明结束时间、可一键撤销。

## 八、三方对比：采纳与不采纳

- 采纳 GLM：`evidence` 必须是原话子串；`validTo` 写进出处记忆；必须赶在 PR 414 上线前。
- 采纳 DeepSeek：一次性的话不立规则；`unclear` 追问不猜；外部 agent 提议不能被打断；偏好也要管；去重算进到期时刻；推送闸门逐分钟判断；过期不占上限；导入拒绝不认识的字段；模型走配置、用量用途白名单。
- 不采纳 GLM 的“只管一次的规则首次命中后自动停用”：规则只能按发件人、词语、时段匹配，配不上“这一封”，会误伤同类的其他邮件（DeepSeek 的理由）。
- 不采纳 GLM 的“限时也一律出提议”：放到拍板第 1 条，线程建议直接生效。
- 不采纳 DeepSeek 的“不改工具参数、只靠核对模型”：那样只剩一个模型判断，失去两个读者互相核对；且 PR 414 已在改参数，合并上线不多付缓存代价。
- 不采纳 DeepSeek 的 `confidence` 字段：模型自报置信度不可靠，用两边一致代替。
- 不采纳 DeepSeek 的“核对失败时追问主人”：那是我们的故障，不该让主人回答；改为出提议，一次点击。
