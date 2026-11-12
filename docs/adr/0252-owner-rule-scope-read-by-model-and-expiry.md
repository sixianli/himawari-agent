---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
amends: "0213, 0244"
superseded_by: ""
date: "2026-11-12"
---

# ADR 0252：规则管多久交给模型读整句判断，限时规则到点自动失效

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [对其他 ADR 的修订](#amendments)
- [放弃的做法](#options)
- [后果](#consequences)
- [验证](#verification)
- [实测结果](#evaluation)

<a id="context"></a>

## 背景

主人说“别提醒我”，可能是“今晚别提醒我”（到明早为止）、“夜里别提醒我”（长期），也可能是“这封先不用管”（只这一件）。原来的做法是写死的词表（`isStandingQuote`，逐个看原话里有没有“以后、一律、今晚、这封”这类字样）：词表收不全开放的说法，PR 414 的六轮复核每轮都找出新的漏网说法；而且规则没有“到期”这个概念，就算认出“今晚”，也只能把它变成一条永久规则的提议。

Andy 在 2026-11-12 立了开发原则：理解用户的意思（意图、时效、是否明说）一律交给模型判断，不用词表（见 [ADR 0249](0249-the-model-judges-meaning-where-word-lists-guessed-it.md)）。本 ADR 把这条原则用到“规则管多久”上，并补上到期。

<a id="premises"></a>

## 前提

1. 明说的规则直接生效、推断的只生成提议：`docs/adr/0213-owner-sentence-becomes-a-standing-rule.md:32`，“明说‘以后/一律/必须’的直接生效、回执卡上给试算、回放和一键撤销；模型推断出来的只生成提议，主人点头才生效”。
2. 词表只是启发式：`docs/adr/0244-hard-rules-step4-unified-push-gate.md:53`，“词表是启发式的，漏掉的说法最坏结果是多立一条主人可以撤销的规则”。
3. 规则状态只有 `active|needs_review|retired`，执行时只看状态：`packages/application/src/rules/rule-types.ts` 的 `enforceableOwnerRule`（本 ADR 之前的版本，第 436–447 行）。
4. 工具定义按对话冻结，工具参数结构变了才换新一次：`.claude/rules/prompt-prefix.md` 第 6 条，“工具集合变了（工具名，或者去掉说明文字后的参数结构）……才换新一次”。
5. Andy 的决定（2026-11-12，经协调者转述并附原话）：“直接生效”（明说的限时规则不再先问一下）；“同意”（核对做成开关，Jev 作为候选，按实测定）。
6. 业界做法：Claude Code 定时任务“Accepts a 5-field cron expression, the prompt to run, and whether it recurs or fires once”，“Recurring tasks automatically expire 7 days after creation”（https://code.claude.com/docs/en/scheduled-tasks）；Anthropic 建议关键判断另用轻量模型分类、把拒答当成一种结论（https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks）。

<a id="decision"></a>

## 决定

1. **词表退场。**`isStandingQuote`、`containsMarker` 和三张词表全部删除，不留“一次性词一律只算提议”的否决名单。
2. **`rule_set` 加必填参数 `scope`**：`{"kind":"standing"}` 或 `{"kind":"until","until":"YYYY-MM-DDTHH:MM"}`（主人当地时间，程序按主人时区换成 UTC，必须晚于现在、不超过 `maxDays`，默认 366 天）。只针对一个具体对象的话不是规矩，主模型不调用；说不清管多久时先问主人。外部 agent 经 MCP 提的规则和没有 `scope` 的旧提议一律按长期处理，并且仍是提议。
3. **第二个读者（核对模型）只在主模型标 `inferred=false` 且原话确实是主人说的时才调用一次**，输入是原话和它所在那条主人消息前后各不超过 2000 字，排列是“固定指令、包裹成资料的原文、当地时间在最后”，走同样的出口遮盖和数据分级。输出 `{scope, until, evidence}`，`scope` 取 `standing|until|this_item|unclear`，`evidence` 必须是原话的子串。不要模型自报的置信度：两个读者是否一致才是信号。
4. **判定表由程序执行**（`apps/agent-service/src/production-rule-scope.ts` 的 `reconcileScope`）：

   | 情况 | 结果 |
   |---|---|
   | 推断的、不是主人说的 | 只生成提议，不调用核对模型 |
   | 两边都说长期 | 直接生效，长期 |
   | 两边都说限时，结束时刻相差不超过 1 小时 | 直接生效，取较早的那个时刻 |
   | 核对模型说只这一件 | 不立规则，返回 `RULE_SCOPE_THIS_ITEM`，主模型直接照办 |
   | 核对模型说说不清，或两边不一致 | 不立规则，返回 `RULE_SCOPE_UNCLEAR`，主模型把问题转给主人 |
   | 核对出错、超时、拒答、输出不合格、早于现在或超过上限 | 只生成提议，主人点一下才生效 |
   | 没配核对模型 | 按主模型的 `scope` 生效（明说且是主人说的） |

5. **核对做成配置**（`runPolicy.ruleScope`）：`verifier` 取 `off|model|jev`；`modelRef`（用对话模型时）；`jevThreshold` 默认 0.85（Jev 是 TypeSafe 的分类服务，只能从选项里挑，所以只核对“长期、限时、只这一件、说不清”这一项，结束时刻以主模型为准，概率低于门槛按说不清）；`timeoutMs` 默认 10 秒；`maxDays` 默认 366。用量记新用途 `rule-scope`。
6. **到期存在规则参数里，不改表。**`parseOwnerRuleParameters` 的顶层键收紧为 `{type, params, summary, expiresAt}`，到期时刻统一成 UTC；解析和执行分开：过期的规则照样能解析（不会被当成“读不懂”去触发推送告警），执行时按时刻判断。`RuleJudge.decide` 接收判断的时刻，推送闸门逐分钟往后找时用候选分钟，所以静默到 7:00、规则 6:30 到期的推送在 6:30 放出。
7. **出处记忆的 `validTo` 写同一个到期时刻**，过期后不再进给模型看的“主人的要求”，程序和模型同时停。
8. **过期规则不改数据库状态**，按时钟显示“已到期”；不占 32 条上限；同参数去重时当作不存在；对过期规则或过期提议点“重新确认”返回 `RULE_EXPIRED`；提议编号算进到期时刻。
9. **网页契约只加字段**（`expiresAt`、`expired`），回执卡、记忆页“长期规则”、`rule_list`、决策记录依据、数据导出（含“正在执行”计数和 `RULES.md`）都显示“长期有效”或“到…为止”“已到期”。

<a id="amendments"></a>

## 对其他 ADR 的修订

- **[ADR 0213](0213-owner-sentence-becomes-a-standing-rule.md) 决定 5** 里“原话带‘以后、一律、必须’这类字样、分句里不带‘这封、这次、今天’等字样”的词表判断，改为本 ADR 的两读者判定；其余（原话必须是主人在最近消息里说的完整一句、撤销与恢复、32 条上限、提议加密存放）不变，其中 32 条上限不再计入已到期的规则。
- **[ADR 0244](0244-hard-rules-step4-unified-push-gate.md) 决定 5** 里 `QUIET_REQUEST_MARKERS`、`RECURRING_TIME_MARKERS`、`ONE_OFF_MARKERS` 三张词表及“同时有时段词才算长期”的说法作废；“今晚别提醒我”现在由模型填 `until`，明说的直接生效、到点失效。其余决定（闸门位置、延后寿命等）不变。

<a id="options"></a>

## 放弃的做法

- **只改词表、补漏网的说法。**词表永远收不全；六轮复核每轮都有新的漏网。
- **限时的话仍只做提议。**Andy 已定直接生效；到期机制让“多立一条”的代价从“永久”变成“到点自动消失”。
- **只管一次的规则首次命中后自动停用。**规则只能按发件人、词语、时段匹配，配不上“这一封”，会误伤同类邮件；这类话直接不立规则。
- **不改工具参数，只靠核对模型。**那样只剩一个模型判断，失去互相核对。
- **核对模型返回置信度。**自报的置信度不可靠；Jev 的概率是它自己输出的分类概率，只用在 Jev 这一路并设为配置。
- **核对失败时追问主人。**那是我们自己的故障，不该让主人回答；改为只生成提议。

<a id="consequences"></a>

## 后果

- `rule_set` 的工具定义变了。**必须和 PR 414 同一次上线**：PR 414 未上线，本身已改过一次参数结构，同批上线老对话只重建一次缓存；晚了就多付一次全价重建。这是发给模型的内容里工具定义的一次性变化，按 [ADR 0165](0165-freeze-the-request-head-per-conversation.md) 在上线后每个老对话重建一次。
- 每次明说立规则多一次小请求，约 1–2 秒；立规则很少，费用可忽略。
- 核对模型和主模型最好不是同一家，减少一起犯同一个错；配置写了要核对但模型缺失、不可用时，只生成提议，不直接生效。
- 数据导入遇到顶层不认识的键就拒绝；旧版本存下的规则和提议没有到期字段，按长期处理。
- 主模型和核对模型都认为“只这一件”的话不会被存成偏好，也不会被记下来；这是有意的：它不是规矩。

<a id="verification"></a>

## 验证

- `packages/application/test/rule-expiry.unit.test.ts`：规则裁判按时刻跳过过期规则；解析与执行分开，过期的静默规则不被当成读不懂（反向）。
- `apps/agent-service/test/production-rule-scope.unit.test.ts`：判定表每一行；推断的和不是主人说的，即使核对模型说长期也只生成提议（反向）。
- `apps/agent-service/test/production-rule-scope-verifier.unit.test.ts`、`packages/platform-node/test/typesafe-jev-transport.unit.test.ts`：两条核对路线、超时、拒答、概率低于门槛。
- `test/integration/production-memory-capture.test.ts` 的 `[RS-1]`：真实 SQLite 加本机回环模型，从 `rule_set` 到规则生效、到期放出、不占上限、重说新立、过期提议不能确认。
- `apps/control-center/test/owner-rules.unit.test.ts`、`proactive-interactions.unit.test.ts` 的 `[RS-1]`：回执卡、规则列表、决策记录依据的到期显示，已到期的不再给“重新确认”。真实浏览器只靠这些 jsdom 用例加 `npm run check:layout`，布局审计的桩里没有规则快照，没有另加 Playwright 用例。
- `test/integration/data-export-rules.test.ts` 的 `[RS-1]`：导出的 `RULES.md` 写明期限，“正在执行”计数不含已到期的。

<a id="evaluation"></a>

## 实测结果

2026-11-12，Andy 选 OpenCode Go 套餐 key（不额外花钱，按列价折算约 0.053 美元）。语料 `test/fixtures/rule-scope-eval/dataset.json`：41 句中日英，长期 14、限时 12、只这一件 8、说不清 7，含 PR 414 六轮复核漏网的说法；每句跑 3 次，共 123 次。主模型 DeepSeek V4.1 Flash，核对模型 GLM 5.3 Flash（和主模型不同家）。脚本 `scripts/evals/rule-scope-live.eval.ts`，原始结果 `evals/rule-scope/result.json`。

| 配置 | 判对 | 错误生效 | 漏掉（该生效没生效） | 保守处理 |
|---|---|---|---|---|
| 只用主模型 | 104 | 0 | 19 | 0 |
| 主模型加对话模型核对 | 95 | 0 | 28 | 0 |

- **两种配置都没有错误生效**：只这一件和说不清的 45 次（15 句）没有一次被立成规则，长期和限时的到期时刻都落在预期窗口内。
- **漏掉的 19 次全是主模型没调用 `rule_set`**，集中在“夜里别提醒我”“Don't ping me at night”“今晚は通知しないで”“Don't notify me tonight”这类静默时段的话。我推测是工具说明要求“只说夜里没给钟点时先问清楚钟点”，模型照做去问了主人；这一点没有逐条核实（脚本没存模型的文字回复），所以不算错误，也不能说明核对模型有什么作用。
- **加核对模型后多漏 9 次**：主模型和核对模型对“今晚”“今天”“这个周末”给的结束时刻相差超过 1 小时，判定表按“两边不一致”转成追问主人。这是保守的，但在这批语料上它没有拦下任何一次错误生效，只多问了主人。
- 没测 Jev：没有 TypeSafe 的评测 key，且上面的结果说明在这批语料上核对没有拦下任何错误，Jev 的价值要等有真实的漏网样本再测。
- 局限：语料是我按已知漏网说法和常见说法写的 41 句，样本小；主模型本来就很少出错，所以这批数据没法证明核对模型有用，只能证明它在这里没有帮助、还会多问。

**生产配置**：`runPolicy.ruleScope.verifier` 先设为 `off`（代码默认也是不核对），只看主模型的 `scope`；核对的代码和配置保留。等生产上出现主模型判错的真实案例，再用那批样本重测，并补测 Jev。这条结论 Andy 此前已同意“按实测定”。

[↑ 回到阅读导航](#contents)
