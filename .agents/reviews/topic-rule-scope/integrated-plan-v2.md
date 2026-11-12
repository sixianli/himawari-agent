# 方案：一句话管多久，交给模型读整句判断；限时规则到点失效

状态：第 2 版（线程方案 + DeepSeek、GLM 各自独立出的方案 + 两模型审核意见），待 Andy 拍板。基于 PR 414 分支 `claude/project-thread-69y41f` 提交 `cc2c9cc9`。方案讨论共花 0.33 美元（Andy 批的上限 0.8）。

## 阅读导航

- [一、前提](#premises)
- [二、对标和根因](#industry)
- [三、方案](#plan)
- [四、失败路径](#failures)
- [五、测试](#tests)
- [六、代价和上线时机](#cost)
- [七、要 Andy 拍板](#decisions)
- [八、三方对比：采纳与不采纳](#judgments)

<a id="premises"></a>
## 一、前提（附来源和原话）

1. Andy 定的生效规则。`docs/adr/0213-owner-sentence-becomes-a-standing-rule.md` 第 32 行：“明说‘以后/一律/必须’的直接生效、回执卡上给试算、回放和一键撤销；模型推断出来的只生成提议，主人点头才生效”。
2. 现在“明说”靠词表核对。`apps/agent-service/src/production-owner-rules.ts` 第 799–801 行：`!input.inferred && isStandingQuote(quote) && (await this.#ownerSaid(input.threadId, quote))`；词表在第 54–239 行。ADR 0213“放弃的做法”（第 80–85 行）没有讨论用模型核对。
3. 当初接受词表的理由。`docs/adr/0244-hard-rules-step4-unified-push-gate.md` 第 53 行：“词表是启发式的，漏掉的说法最坏结果是多立一条主人可以撤销的规则”。
4. 规则没有到期概念。`packages/application/src/rules/rule-types.ts` 第 436–447 行 `enforceableOwnerRule` 只看 `status`；状态只有 `active|needs_review|retired`。
5. 规则读不懂会触发推送告警。`rule-types.ts` 第 426–433 行 `unreadablePushRule`：不是 retired、`enforceableOwnerRule` 返回空、类型以 `push_` 开头就算读不懂；`apps/agent-service/src/service-main.ts` 第 2393 行 `if (unreadablePushRule(row)) throw new Error("PUSH_RULE_UNREADABLE")`。
6. 推送闸门逐分钟往后找能发的时刻，用的是同一组规则。`packages/application/src/services/web-push-gate.ts` 第 85–99 行。
7. 偏好（`soft`）这条路没有任何时效检查。`production-owner-rules.ts` 第 765–768 行只要求 `!input.inferred && ownerSaid`。
8. 规则和偏好的出处记忆 `validTo` 恒为 null（`production-owner-rules.ts` 第 609–610 行）；把记忆放进提示词时按 `validTo` 过滤（`packages/application/src/services/owner-profile-service.ts` 第 184–189 行 `currentlyValid(memory, input.now)`）。
9. 外部 agent 经 MCP 提的规则走同一个 `create`，固定 `inferred: true`，并要求返回 `proposed`（`apps/agent-service/src/production-mcp-rule-writer.ts` 第 70–84 行）。
10. 同规则去重只比类型和参数（`production-owner-rules.ts` 第 658–661 行），重新确认遇到读不懂的规则抛 `RULE_UNAVAILABLE`（第 864–865 行）；`parseOwnerRuleParameters` 不拒绝顶层未知键（`rule-types.ts` 第 379–396 行），数据导入也经它校验。
11. 主模型每轮能看到当地时间：`packages/runtime-pi/src/pi-runtime-adapter.ts` 第 631 行。
12. 工具定义按对话冻结：`.claude/rules/prompt-prefix.md` 第 6 条，“工具集合变了（工具名，或者去掉说明文字后的参数结构）……才换新一次”。PR 414 未上线，本身已改 `rule_set` 参数结构一次。
13. 业界一手资料：
    - Anthropic：关键判断另用轻量模型单独分类，用结构化输出限定答案；模型拒答要当成一种结论处理（https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks）。
    - OpenAI 护栏 cookbook：便宜模型与主模型并行分类（https://developers.openai.com/cookbook/examples/how_to_use_guardrails）。
    - Claude Code 定时任务：`CronCreate`“Accepts a 5-field cron expression, the prompt to run, and whether it recurs or fires once”，“Recurring tasks automatically expire 7 days after creation”（https://code.claude.com/docs/en/scheduled-tasks）。
    - ChatGPT 定时任务：一次性用相对偏移、重复用 RRULE（https://simonwillison.net/2025/Jan/15/chatgpt-tasks/ ，2025 年泄露的工具提示）。
    - iPhone 专注模式：“For 1 hour”“Until I leave this location”（https://support.apple.com/guide/iphone/turn-a-focus-on-or-off-iph5c3f5b77b/15.0）。

<a id="industry"></a>
## 二、对标和根因

- **ChatGPT/Claude 怎么做、用户看到什么**：意图由模型读整句判断；“一次”还是“重复”、到什么时候结束，是工具参数里的显式结构，对话里回显一张写明结束时间的卡，有统一页面可撤销；关键判断另有独立小模型分类把关。
- **根因有两层**：(1) 用写死的词表做语义判断，开放的说法永远收不全；(2) 规则没有“到期”，限时的话即使认对了也只能变成永久规则的提议。本方案两层都修。

<a id="plan"></a>
## 三、方案

### 1. 两个读者各自读整句

- **主模型**：`rule_set` 加 `scope`：`{"kind":"standing"}` 或 `{"kind":"until","until":"YYYY-MM-DDTHH:MM"}`（主人当地时间，按主人设置的时区换成 UTC）。“今晚别提醒我”“今天别发邮件提醒”是到某时刻为止，填 `until`（例如到明早 7:00）。只针对一个具体对象的话（“这封先不用管”“这次回答短一点”）不是规则，不调用。说不清的（“先别提醒我”“下个月起”）先问主人。`SET_ARGUMENTS` 和工具定义的 `required` 同步加上。
- **核对模型（旁路，一次小请求）**：只在主模型标 `inferred=false` 时调用。输入只取原话和它所在那条主人消息里前后约 2000 字以内，按“固定指令 → JSON 包裹的资料（声明不是指令） → 当前当地时间和时区”排列，走和其他模型调用相同的出口遮盖和数据分级。输出 `{scope: "standing"|"until"|"this_item"|"unclear", until, evidence}`：`evidence` 是原话里决定时效的那几个字，程序核对它是遮盖后原话的子串，也显示在回执卡上。设超时（配置项，默认 10 秒）；每次 `rule_set` 最多一次。不要置信度字段：模型自报的置信度不可靠，两个读者是否一致才是信号。
- 核对模型从新配置项取模型引用，建议配成和主模型**不同的一家**，减少两边犯同一个错；配置缺失时不直接生效。用量记新用途 `rule-scope`（`MODEL_USAGE_PURPOSES` 同步）。

### 2. 程序只做可判定的核对

| 情况 | 结果 |
|---|---|
| `inferred=true`、原话不是主人说的、外部 agent 提的 | 提议（不变），卡上带主模型给的时效；外部 agent 不给时效按长期 |
| 两边都 `standing` | 直接生效，长期 |
| 两边都 `until`，结束时刻相差 ≤ 1 小时（取较早的） | **直接生效，到点自动失效**（见拍板） |
| 核对模型说 `this_item` | 不立规则、不存偏好，返回“这句只管这一件”，主模型直接处理 |
| 核对模型说 `unclear`，或两边时效不一致 | 不立规则，返回“请问清楚：长期、到什么时候、还是只这一次” |
| 核对调用超时、出错、拒答、数据分级不允许、输出不合格（枚举外、`evidence` 不在原话里、`until` 早于现在或超过上限） | 提议，卡上写主模型给的时效，主人点一下才生效 |

- 偏好（`soft`）同样走这一套。
- 词表、`isStandingQuote`、`containsMarker` 全部删除，不留“一次性词一律提议”的否决名单（理由见第八节）。

### 3. 到期做成规则自带的一项

- `RuleRecord` 加 `expiresAt: string | null`，存在规则参数 JSON 里（**不改表、不进改表排队**）。`parseOwnerRuleParameters` 校验格式、统一成 UTC、上限（配置项，默认 366 天），并把顶层键收紧为 `{type, params, summary, expiresAt}`，数据导入遇到不认识的键就拒绝。
- 解析和执行分开：过期的规则照样能解析（不会被当成“读不懂”去触发推送告警），执行时再按时间判断。规则裁判 `RuleJudge.decide` 接收判断的时刻：推送闸门逐分钟往后找时用候选分钟，所以“静默到 7:00、规则 6:30 到期”的推送在 6:30 放出；邮件检查、MCP 读取、`rule_list` 用当前时刻。
- 规则和偏好的出处记忆 `validTo` 写同一个到期时刻，过期后不再出现在给模型看的“主人的要求”里，程序和模型同时停。
- 过期规则不改数据库状态，按时钟显示“已到期”，不占 32 条上限；同规则去重时当作不存在（重新说一遍就新立一条）；对过期规则点“重新确认”返回“已到期，请重新说”。提议编号算进到期时刻。旧版本存下的提议没有到期字段，按长期处理。
- 网页契约只加字段（`expiresAt`、`expired`），不改状态枚举。回执卡、记忆页“长期规则”、`rule_list`、决策记录依据、数据导出（含“正在执行”计数）都显示“长期”或“到 11-16（周一）7:00 为止”。

### 4. 文档和提示词

新开 ADR，写明词表退场、两个读者核对、到期字段，并修订 ADR 0213 决定 5、ADR 0244 决定 5 的词表段落；`rule_set` 描述改写时效说明，同步提示词目录清单和固定样本。

<a id="failures"></a>
## 四、失败路径

见上表。核心是：核对模型挂了不会让规则悄悄永久生效，也不会因为我们自己的故障去追问主人，只是多点一下。

<a id="tests"></a>
## 五、测试

- 集成测试用本机回环模型服务按脚本回答（项目已有做法）：判定表每一行一条，含反向（`inferred=true` 两边都长期也不直接生效；`evidence` 不在原话里不直接生效；外部 agent 提议仍返回 `proposed` 并能确认；旧格式提议能确认）。
- 假时钟：到期前延后、到期后放出（静默 7:00、到期 6:30，6:30 放出）；过期的静默规则不触发告警（反向）；过期规则不占上限、重新说一遍新立一条、出处记忆过期后不进提示词；同参数不同到期不合并；带未知键的导入被拒。
- 网页：回执卡和记忆页的到期显示有 Playwright 用例。
- 实测评测（真模型，手动跑，不进 CI）：PR 414 六轮复核找出的全部漏网说法，加中日英各约 20 条，核对模型跑 3 次，预计不到 0.1 美元，跑前报 Andy。
- `npm run check:prompt-prefix` 照跑；工具换新由 `test/integration/thread-prompt-bundles.test.ts` 覆盖。

<a id="cost"></a>
## 六、代价和上线时机

- 每次明说立规则多一次小请求，约 1–2 秒，可与历史回放并行。立规则很少，费用可忽略。
- `rule_set` 工具定义变一次。**必须和 PR 414 同一次上线**，老对话总共只重建一次缓存；晚了就多付一次全价重建。
- 编码等 PR 414 合进 main 后开始。

<a id="decisions"></a>
## 七、要 Andy 拍板

1. 明说的限时规则（两个模型都读出“到周日为止”）直接生效，还是也先点一下。线程建议直接生效：符合“明说直接生效”，到点自动失效，卡上写明结束时间，可一键撤销。

<a id="judgments"></a>
## 八、三方对比：采纳与不采纳

第 1 轮（各自出方案）：

- 采纳 GLM：`evidence` 必须是原话子串；必须赶在 PR 414 上线前。
- 采纳 DeepSeek：一次性的话不立规则；`unclear` 追问；外部 agent 提议不能被打断；偏好也要管；去重算进到期时刻；过期不占上限；模型走配置、用量用途白名单。
- 不采纳 GLM 的“只管一次的规则首次命中后自动停用”：规则只能按发件人、词语、时段匹配，配不上“这一封”，会误伤同类邮件。
- 不采纳 DeepSeek 的“不改工具参数、只靠核对模型”：只剩一个模型判断，失去互相核对。
- 不采纳 DeepSeek 的置信度字段，和“核对失败时追问主人”（那是我们的故障，不该让主人回答）。

第 2 轮（审核第 1 版）：

- 采纳（两家都提）：过期的静默规则会被当成“读不懂”而每次推送都告警 → 到期做成规则自带的一项，解析和执行分开。
- 采纳（两家都提）：过期后重新说同一句会报错 → 去重当作不存在，重新确认给明确提示。
- 采纳 DeepSeek：推送闸门要按候选分钟判断到期；硬规则的出处记忆也要写 `validTo`，否则程序停了模型还在照做；外部 agent 路径和旧提议没有时效字段要有默认值；“今晚”这类要落成 `until`，和“这一封”分开；核对输入要有长度上限、超时、走出口遮盖、处理拒答；网页契约只加字段。
- 采纳 GLM：顶层键白名单让导入拒绝未知字段；数据导出的计数和说明文字一起改；`SET_ARGUMENTS` 和 `required` 同步；用量用途要有反向测试；网页显示要有测试；ADR 0213、0244 的词表段落要修订。
- 不采纳 DeepSeek 的“保留一次性词否决名单”：那就是被 6 轮复核证明收不全的同一张词表。它挡的是“把一次性的话当成长期”，本方案用三层代替：核对模型配成另一家、`evidence` 必须是原话里决定时效的字并显示在卡上、限时的话本来就会落成到期规则而不是永久规则。剩下的风险是两家模型同时把一次性的话读成长期，后果是多一条可一键撤销的规则，这和词表漏判时的后果相同，但发生得少得多（实测评测验证）。
- 已核对、不成问题：GLM 担心记忆整理把 `validTo` 当“被取代时刻”误判。`packages/application/src/services/memory-checkup.ts` 第 302 行只在归档被取代的记忆时写 `validTo: now`，含义同样是“到这一刻为止有效”，和到期一致。
