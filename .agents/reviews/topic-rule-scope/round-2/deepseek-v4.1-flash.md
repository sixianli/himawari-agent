# 方案审核：把规则时效交给两个模型判断

总体判断：方向（用模型读整句 + 补“到期”）是对的，但现稿有 3 个会直接破坏现有安全/执行路径的问题，另有若干跨层契约没接上。不建议按现稿直接实施。

---

## 一、证实的（按严重度）

### 1【阻断】过期的 `push_quiet_hours` 会被当成“读不懂的规则”，导致整个推送闸门 fail-open

- 问题：方案说“过期规则经 `enforceableOwnerRule(row, now)` 视为不生效”。但推送路径先用 `unreadablePushRule` 判断“读不懂”，而它把“返回 undefined”直接当成“不可读”：
  - `packages/application/src/rules/rule-types.ts:426`
    ```ts
    if (row.status === "retired" || enforceableOwnerRule(row, registry) !== undefined) return false;
    ```
  - `apps/agent-service/src/service-main.ts:2392-2395`
    ```ts
    if (unreadablePushRule(row)) throw new Error("PUSH_RULE_UNREADABLE");
    const rule = enforceableOwnerRule(row);
    ```
  - `apps/agent-service/src/production-web-push.ts:468-470`
    ```ts
    } catch {
      decision = { action: "deliver", failed: true };
    }
    ```
  结果：一条到期的 `push_quiet_hours` 不是被安静忽略，而是让该类推送**立即照发**并每次告警，其他静默规则也一起失效。
- 建议：`unreadablePushRule` 必须显式区分“过期”和“参数坏了”；过期规则返回 false（可读、只是不生效）。同时加反向测试：过期 `push_quiet_hours` 不得触发 `PUSH_RULE_UNREADABLE`，同类的其他静默规则仍生效。

### 2【阻断】限时硬规则只在规则参数里到期，出处记忆仍是永久，模型每轮继续被要求“遵守”

- 问题：方案只给 `soft` 偏好写 `validTo`，硬规则的出处记忆仍写死 `validTo: null`：
  - `apps/agent-service/src/production-owner-rules.ts:604-612`
    ```ts
    validFrom: null,
    validTo: null,
    ```
  - `packages/application/src/services/owner-profile-service.ts:184-189` 只按 `currentlyValid`（看 `validTo`）过滤；
  - `owner-profile-service.ts:204-207` 把 `category === "rule"` 的记忆放进 `owner-rules`；
  - `owner-profile-service.ts:305-324` 的块头写“主人对 Himawari 的要求……回答时遵守”。
  结果：规则到点后程序不再执行，但模型每轮仍能看到“照做”的规则文本。用户会看到“程序不管了、模型还在管”的分裂行为。
- 建议：硬规则建立/续期时同步把到期时刻写进出处记忆的 `validTo`（无到期则 null）；恢复记忆（`#reviveMemory`）或重新确认时必须重置 `validTo`。或者在 `owner-rules` 组装时用规则到期的 `now` 过滤，二选一，不能只改程序执行点。

### 3【阻断】推送闸门的“逐分钟判断到期”目前没有数据通路

- 问题：闸门只在每次投递前读一次规则并映射成不带到期信息的 `RuleRecord`：
  - `apps/agent-service/src/production-web-push.ts:461-467`
    ```ts
    const rules = await this.#options.readPushRules();
    decision = (this.#options.gate ?? DEFAULT_GATE).decide({ pushClass, now, ..., rules });
    ```
  - `packages/application/src/services/web-push-gate.ts:85-99` 对同一组 `input.rules` 逐分钟调用 `hitsAt(candidate)`。
  如果只按“读取时的 now”过滤，闸门就不知道候选分钟是否已过到期时刻；方案写的“过期时刻之后的分钟不再算静默、延后的推送在规则到期时放出”无法实现。
- 建议：把到期做成 `RuleRecord` 的一等字段（`expiresAt`），或让闸门接收 `(rules, at)` 的“规则在 at 是否有效”回调；逐分钟求值时用 `candidate` 而不是 `now`。补测试：静默到 07:00、规则 06:30 到期，推送应在 06:30 放出而不是 07:00。

### 4【高】`scope` 只加在聊天工具上，外部 MCP 的 `create/confirm` 路径没有这个值

- 问题：`rule_set` 的 `scope` 由主模型产生，但同一个 `create` 还被外部 agent 路径调用：
  - `apps/agent-service/src/production-owner-rules.ts:751-806` 的 `create` 没有 `scope`；
  - `apps/agent-service/src/production-mcp-rule-writer.ts:70-80`
    ```ts
    const receipt = await this.#options.rules.create({
      key: `${EXTERNAL_RULE_KEY_PREFIX}${proposal.proposalId}`,
      quote: externalRuleQuote(...),
      inferred: true,
      type: proposal.type,
      params: proposal.params,
      ...
    });
    ```
  - `docs/adr/0226-external-agents-propose-rules-through-the-rule-proposal-flow.md:53-56` 明确外部提议的参数只有五个列表、`create` 后紧接 `confirm`。
  这正是 I-73 的翻版：新值的产生端在聊天工具，使用端还有 MCP 写入器和旧提议载荷。方案只说“外部 agent 的提议不受影响”，没有回答“外部 `create` 的 scope 从哪来、确认旧提议时缺 scope 怎么办”。
- 建议：`scope` 不要做 `create` 的必填参数；在 `Proposal` 里作为可空字段，缺省按“长期/提议”处理，并在 MCP 契约里明确外部提议是否允许限时（若允许，需要给 `propose_rule` 加 `until` 并同步 ADR 0226）。补测：外部提议不带 scope 仍返回 `proposed` 并可确认；旧载荷（无 scope）确认不崩。

### 5【高】删掉词表后，“两边都 standing 直接生效”会把误判变成自动永久规则

- 问题：当前词表里 `ONE_OFF_MARKERS` 是唯一的确定性否决：
  - `apps/agent-service/src/production-owner-rules.ts:124-226`
  - `production-owner-rules.ts:450-468`
    ```ts
    if (ONE_OFF_MARKERS.some((marker) => containsMarker(whole, marker))) return false;
    ```
  方案删掉它，改成“两边都 standing → 直接生效”。两个模型可能犯相关错误（尤其 checker 与主模型同家族/同配置时），而 ADR 0244:53 的安全论证只覆盖“漏掉说法→提议”，不覆盖“把一次性说法误判成长期→直接生效”。ADR 0213 把规则定义为“硬性设定、必定执行”，误立一条自动执行的永久规则比多出一条提议严重得多。
- 建议：保留一层廉价确定性否决：只要原话出现“这封/这一条/这次/今天/今晚/刚才/right now/this time”这类一次性或指示词，就强制走提议，不让两个模型直接生效；或者要求 checker 的 `evidence` 必须覆盖决定 `scope` 的时间词，否则按 `unclear` 处理。把该反向用例放进 CI：`两边都 standing + “这封必须提醒我” → proposed`。

### 6【高】`single` 把“只针对这一封/这一次”和“只到今晚为止”混为一谈

- 问题：方案 §2 规定 checker 说 `single` 就不立规则、不写偏好，交给主模型处理“这一次”。但方案自己的对标把“今晚别打扰”列为应被表示成“带结束时间”的设置；现有词表也专门用 `QUIET_REQUEST_MARKERS + RECURRING_TIME_MARKERS` 处理“夜里别提醒我”：
  - `apps/agent-service/src/production-owner-rules.ts:80-123`
  按方案的枚举，“今晚别提醒我”很可能被 checker 判成 `single`，于是既没有规则也没有限时静默；主模型无法改变推送闸门，今晚的推送照样会发。方案没有定义“时间窗内的一次性要求”和“只针对具体对象的一次性要求”的区别。
- 建议：把 `single` 再拆成 `this_target`（这封/这条，交给主模型）和 `this_window`（今晚/今天/到明早，应落成 `until`）。至少明确：“今晚/今天/到今晚”必须输出 `until`，不能输出 `single`。

### 7【中】到期字段的存储位置没有和现有解析、去重、导入、规则 id 对齐

- 问题：`parseOwnerRuleParameters` 只对 `params` 严格拒绝未知键，顶层多余键会被忽略：
  - `packages/application/src/rules/rule-types.ts:379-396`
  - `rule-types.ts:111-112`（`params` 内部才检查未知键）
  - `apps/agent-service/src/production-owner-rules.ts:489-492` 的 `sameRule` 只比 `type + params`
  - `apps/agent-service/src/production-owner-rules.ts:807-815` 的 proposal id hash 只含 `type/params/summary`
  - `packages/persistence-sqlite/src/data-export/rules.ts:111-125` 的 `storedRuleProblem` 经 `ownerRuleRecord` 解析，顶层未知键同样被忽略。
  如果 `until` 放顶层：现有导入会**静默接受**并当成永久规则，正好违反方案“导入遇到不认识的到期字段要拒绝”；如果放 `params`：`parseMailMatch`/`parsePushQuiet` 会拒绝，必须给每个规则类型加 `until`。两种都不是“只改 parse 一处”。
- 建议：明确采用顶层 `{ type, params, summary, until }`，并在 `parseOwnerRuleParameters` 加顶层白名单、未知键拒绝、UTC 规范化；同时把 `until` 加进 `sameRule`、proposal id hash，并决定 `ruleId` 是否也要把到期算进去（目前 `ruleId = hash(proposal.key)`，同一 key 换到期会撞 id，而 `sqlite-owner-rule-operations.ts:141-144` 发现参数不同会直接 `PORT_CONFLICT`）。

### 8【中】对外契约和 UI 没有“到期”字段；把状态改成 `expired` 会破坏枚举

- 问题：方案要求回执卡、记忆页、`rule_list`、决策记录、数据导出都显示“已到期”。但现有契约没有这个值：
  - `packages/gateway-contracts/src/contracts-v2.ts:1431-1441`：`memory.rules.snapshot` 的 `status` 只有 `active | needs_review`；
  - `contracts-v2.ts:1112-1133`：决策记录 `status` 只有 `active | needs_review | retired`；
  - `apps/control-center/src/components/rule-receipt.tsx:26-82`：`parseRuleReceipt` 只认 `active | proposed | soft`，未知字段直接丢弃；
  - `apps/agent-service/src/production-memory-control.ts:451-464`：原样返回 `rule.status/enforced`。
  如果把 DB 或契约里的 `status` 改成 `expired`，会同时破坏外部 MCP 客户端和网页契约。
- 建议：加法式扩展，不改 `status` 枚举。新增 `expiresAt: nullable(timestamp)` 和/或 `expired: boolean`，同步 `memory.rules.snapshot`、决策记录、`rule_book`、`ListedOwnerRule`、回执卡和 i18n；`rule_list` 的工具说明也要改（只对新对话生效）。

### 9【中】“当地时间→UTC”没有时钟和时区通路，DST 与边界语义未定义

- 问题：方案说 `parseOwnerRuleParameters` 校验并统一成 UTC，但 writer 的配置只取了 ownerId/agentId：
  - `apps/agent-service/src/production-owner-rules.ts:402-413`
  - `packages/application/src/ports/configuration.ts:290-291` 的 `timeZone` 还是可选的。
  `parseOwnerRuleParameters` 是纯应用层函数，没有 `now`/`timeZone`，无法判断“until 早于现在”或把 `YYYY-MM-DDTHH:MM` 转 UTC。DST 的“不存在时刻/重复时刻”也没有策略。
- 建议：把 `timeZone` 和 `clock` 显式传入写入器/解析入口；定义歧义时刻策略（建议拒绝并要求主人重说，或与主人时区一致地取较早/较晚）；`until` 以 canonical UTC ISO 存储，并明确边界是 `now < until` 还是 `now <= until`，执行点与测试统一。

### 10【中】`enforceableOwnerRule` 的第二个参数现在是可注入的 registry，直接改成 `now` 会破坏调用和测试

- 问题：
  - `packages/application/src/rules/rule-types.ts:436-447` 签名是 `(row, registry = RULE_TYPES)`；
  - `rule-types.ts:426` 的 `unreadablePushRule` 明确传 `registry`；
  - 测试也把它当注入点用。
- 建议：改成 `enforceableOwnerRule(row, { now, registry })` 或加第三个参数；不要用位置参数替换 registry，否则现有测试/工具会静默传错。

### 11【中】`soft` 偏好的 `validTo` 与现有召回语义不一致

- 问题：方案说“召回时过滤掉过期的”，但现有召回只是标注 `current`，不过滤：
  - `apps/agent-service/src/production-memory-recall.ts:306-315`
    ```ts
    current: validTo === null || validTo > now,
    ```
  - 且 `validTo > now` 是字符串比较；`memory-dates.ts:16-23` 同时接受纯日期和完整 ISO。若写入 `"2026-11-16"`（纯日期）+ `now` 是 ISO，到期当天会整天被判过期或出现错位。
  - `production-owner-rules.ts:574-618` 的 `#writeMemory` 只写 `validTo: null`，`#reviveMemory` 恢复时也不更新 `validTo`。
- 建议：在召回候选过滤处加 `validTo === null || validTo > now`，并强制写完整 UTC ISO instant；恢复/重录时清除或更新 `validTo`；补日期边界测试。

### 12【中】过期规则与 32 条上限、同规则去重、`reconfirm` 的行为未定义

- 问题：
  - `production-owner-rules.ts:657-677` 的 32 条上限统计所有非 retired 行，过期行会占名额；
  - `production-owner-rules.ts:658-661` 的同规则去重会命中过期规则；
  - `production-owner-rules.ts:860-865` 的 `reconfirm` 用 `enforceableOwnerRule(current)`，对过期规则会抛 `RULE_UNAVAILABLE`。
  方案说“过期不计上限、仍可撤销”，但没说“重新说同一条规则”“对过期规则点重新确认”应该新建、续期还是报错。
- 建议：定义清楚：过期规则在去重时视为不存在（新建一条新的），还是允许“续期”更新同一条（同时清理 memory validTo）；`reconfirm` 对过期规则给出明确行为。补测试覆盖“过期后重新说同一句”。

### 13【中】checker 是新增的模型数据接收方，方案没有说明遮盖/分类/供应商边界

- 问题：checker 输入是“主人最近 6 条消息中含原话的那几条”，而 `#readText` 读的是完整原文：
  - `apps/agent-service/src/production-owner-rules.ts:514-554`
  - ADR 0213:103 明确说原话里可能含密码、验证码、银行卡号，会以 `sensitive` 保存。
  checker 在保存前就把原文发给另一个配置的模型；方案没有说是否走出口遮盖、是否允许 `sensitive` 原文离开、checker 模型的供应商是否可信。
- 建议：明确 checker 请求走同一模型出口/遮盖/分类策略；如果出口遮盖会破坏 `evidence` 子串校验，应在遮盖前完成 evidence 校验，或允许 checker 只看遮盖后的文本并用占位符证据。Anthropic 的一手文档也把“轻量模型 + 结构化输出”用于输入/工具输出筛查，并把 `stop_reason: refusal` 当作需要处理的结论（https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks）；方案应显式处理 refusal。

### 14【中】checker 输入没有长度上限、超时和次数预算

- 问题：`quote` 限 500（`production-owner-rules.ts:47`），但包含 quote 的主人消息可以很长（粘贴、附件）；checker 会把“含原话的那几条”全文送入模型。每个 `rule_set` 的显式调用都触发一次模型请求，主模型可在一轮内多次调用。
- 建议：只发送 `quote` 及前后有限字符（如 2k），总输入上限、最多消息数、单轮调用预算、明确超时；超时/拒绝/输出不合格统一走提议。否则这是一个可被长粘贴或重复工具调用放大的成本/延迟入口。

### 15【低/中】规则文件、ADR、提示词目录与代码不一致

- 问题：
  - ADR 0213:61 把“原话带以后/一律/必须……最近 6 条主人消息”的词表机制写成决定；ADR 0244:53 明确写了 `QUIET_REQUEST_MARKERS`/`RECURRING_TIME_MARKERS`/`ONE_OFF_MARKERS`；
  - ADR 0226:53-54 把外部提议参数固定为五个列表；
  - ADR 0161:84 要求改提示词时同步 `prompt-manifest.json` 和固定样本。
  方案删词表、改 `rule_set` 参数和描述，但没有提出新 ADR/修订旧 ADR，也没提提示词目录的 manifest/样本更新。
- 建议：新增一条 ADR（或明确修订 0213/0244/0226），写明词表退场、两模型核对、`scope`/`until` 语义；同步 `packages/prompt-catalog` 的 manifest、固定样本和 `rules.receipt.*` 文案。

### 16【低】测试反向用例不足

- 问题：`npm run check:prompt-prefix`（`packages/runtime-pi/test/prompt-prefix.compat.test.ts`）和 `test/integration/thread-prompt-bundles.test.ts` 确实存在，但：
  - `check:prompt-prefix` 不覆盖旁路 checker，也不覆盖过期闸门；
  - 方案点名的反向用例没有覆盖：过期 `push_quiet_hours` 不得 fail-open；过期硬规则不得继续出现在 `owner-rules` 块；`memory.rules.snapshot`/`decision.chain`/`rule_book` 的到期字段契约；MCP 外部提议无 scope；DST/纯日期边界；checker refusal。
- 建议：把上述用例加进 CI，而不是只放在手动 eval。手动 eval 可以保语义质量，但不能当作“不会退步”的门槛。

### 17【低】业界来源质量

- Claude Code 的“一次性/重复两种结构、recurring 7 天过期”已核实为一手来源：https://code.claude.com/docs/en/scheduled-tasks（原文：“Accepts a 5-field cron expression, the prompt to run, and whether it recurs or fires once.”“Recurring tasks automatically expire 7 days after creation.”）。
- Anthropic 的“轻量模型 + 结构化输出分类”已核实为一手来源：https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks。
- 但 ChatGPT 定时任务用的是 Simon Willison 转述的“2025 年泄露的工具提示”，不是 OpenAI 一手来源（https://simonwillison.net/2025/Jan/15/chatgpt-tasks/），按你定的“只认一手来源”标准不应作为权威依据。建议换成 OpenAI 官方文档，或删掉这条对标。

---

## 二、推测/未核实

1. **PR 414 是否真的尚未上线**：仓库里没有上线记录可核实。若已上线，方案“和 PR 414 同一次上线只换新一次”的缓存代价判断不成立，老对话会再付一次全量重建。
2. **checker 是否自动走出口遮盖**：我没有在 `ProductionOwnerRuleWriter` 里看到 checker 的模型调用接线；现有 `production-thread-titles.ts:80-92` 是把原文直接拼进 prompt，再用 `externalTag` 恢复输出占位符。checker 很可能也走 `ModelEgress`，但需要确认；若没有，属于敏感原文外发。
3. **新配置键能否被 `strict-configuration` 接受**：我没有读到具体的 config 解析白名单；方案说“缺失时不直接生效”，但没有说加在 `runPolicy` 哪一层、是否要改 schema/示例配置/测试。
4. **旧提议载荷兼容性**：MCP 提议可能在部署前已经存在（TTL 内）。`confirm` 直接 `JSON.parse` 后 `#activate`，如果 `Proposal` 新增必填 `until`，旧载荷会缺字段。需要默认值或版本字段。
5. **UI 契约是否会拒绝未知字段**：`parseRuleReceipt` 是“取已知字段、忽略未知”，所以新增字段不会导致解析失败，但也不会显示；`memory.rules.snapshot` 的校验器是否丢弃/拒绝未知字段需要看具体 validator。无论哪种，UI 必须改。
6. **Apple 专注模式的来源**未核实；它不影响核心判断。

---

## 三、侧重检查（错误路径、不可信输入、安全、资源耗尽、不可撤销操作、文档一致性）

- **错误路径**：checker 超时/抛错/`refusal`/枚举外/evidence 非子串 → 提议，这个默认方向是对的；但 `unreadablePushRule` 与“过期返回 undefined”的交互会制造新的 fail-open（见 1）。`confirm` 时 `until` 已过期没有处理（见 9）。
- **不可信输入**：原话来自主人消息，但可能包含粘贴的第三方文本；checker 只做 evidence 子串校验，不能证明 evidence 支持 scope。建议要求 evidence 必须覆盖时间词，或保留一次性词的确定性否决（见 5、6）。
- **安全/隐私**：checker 是新增的模型接收方；原话可能含凭据（ADR 0213:103）。必须确认出口遮盖/分类/供应商边界（见 13）。
- **资源耗尽**：checker 每显式调用一次模型，输入消息全文无上限、无超时/预算（见 14）。建议只发送 quote 窗口并设上限。
- **不可撤销操作**：自动生效的规则可撤销，但“误判成永久规则”本身是方案引入的新风险；安全默认应是“宁可提议，不要自动生效”（见 5）。到期本身是可逆的，不需要额外撤销。
- **规则/文档/代码一致性**：ADR 0213、0244、0226 仍把词表和五参数外部提议写成现行决定；ADR 0161 要求同步提示词 manifest/样本。方案没有列这些改动（见 15）。

---

## 四、如果由我定，我会怎样改这份方案

1. **把“到期”做成规则的一等字段**：`RuleRecord.expiresAt: string | null`，`enforceableOwnerRule(row, { now, registry })`，闸门逐分钟用 `candidate` 判断。不要在读取时把过期规则过滤成 `undefined` 后让 `unreadablePushRule` 误判。
2. **过期同时写两处**：规则参数里的 `until`（程序执行）和出处记忆的 `validTo`（模型可见性）；恢复/续期时重置。否则程序失效、模型继续遵守。
3. **保留确定性否决**：词表不做主要判断，但保留“一次性/指示词 → 永远提议”的黑名单；删除 `RECURRING_TIME` 那套语义判断可以，但不要删安全否决。
4. **`scope` 分四值**：`standing | until | this_target | this_window`。`this_target` 交给主模型；`this_window`（今晚/今天）必须落成 `until`，不能落成 `single`。
5. **外部 MCP 路径显式建模**：`Proposal` 里的 `until` 可空，旧载荷按长期提议处理；`propose_rule` 是否支持限时在 ADR 0226 里写清楚；不要复用聊天工具的必填 `scope`。
6. **checker 只作为附加门槛**：输入截断到 quote 窗口、设超时/单轮预算、走出口遮盖/分类；处理 `refusal`；evidence 必须包含决定 scope 的词，否则按 `unclear`。
7. **契约加法式扩展**：`expiresAt`/`expired` 新字段，不改 `status` 枚举；同步 `memory.rules.snapshot`、决策记录、`rule_book`、`ListedOwnerRule`、回执卡、i18n。
8. **文档先行**：新增/修订 ADR，更新 prompt-catalog manifest 和固定样本，再改代码。

---

## 五、逐条回答必答问题

### 1. 会不会改变模型已经见过的请求开头？

**会改变一次，但在规则允许的“换新”范围内；之后仍然只在末尾追加。**

- `rule_set` 新增必填 `scope` 属于“工具参数结构变了”，按 `.claude/rules/prompt-prefix.md:41-43` 第 6 条，在一轮开始时换新一次，并留记录；方案已承认这一点。
- 系统提示、历史消息、遮盖结果不需要变；新的 `scope` 只影响工具定义，工具结果（回执）追加在末尾。
- 每轮会变的当地时间仍在最后一条用户消息：`packages/runtime-pi/src/pi-runtime-adapter.ts:623-641` 把 `localTime` 和 context blocks 拼进 `turnPrompt`，而 `turnPrompt` 作为本轮用户消息使用。
- 需要警惕：如果实现“过期”时去改系统提示或冻结的工具定义，就会破坏前缀；按现有结构，`owner-rules` 是每轮 context block（`owner-profile-service.ts:305-324`），只应影响最后一条消息。**结论：满足“只在末尾追加、变化值在最后一条消息”，代价是一次已批准的换新。**

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**只要做到“到期值 canonical 化、只存一次、只影响最后一条消息”，不会；现稿有几处风险。**

- `until` 必须统一成 canonical UTC ISO 再入库；不要存 `YYYY-MM-DDTHH:MM` 后在每次读取时用当前时区重新解释（DST 会变字节）。
- `evidence` 是模型输出，但只在创建那一轮写入回执/载荷，之后作为历史固定下来，不能每轮重新生成。
- `validTo`/到期过滤会改变 `owner-rules` 块和召回结果，但这些都进最后一条消息，不改前缀。
- 风险点：`sameRule`/proposal id 若用 `JSON.stringify` 且对象键顺序不稳定，会产生不同 proposal id；必须用 canonical JSON。`rule-scope` 用途、回执里的“到 11-16（周一）”若要每轮按当前 locale 重算，也会变，但这些只应在显示/最后消息，不应进系统提示或工具定义。

### 3. 有没有对应的自动检查？反向用例真的会失败吗？

**有基础检查，但不够；现稿点名的反向用例方向对，缺口会漏掉最危险的回归。**

- 已有：`npm run check:prompt-prefix`（`packages/runtime-pi/test/prompt-prefix.compat.test.ts`，规则说明见 `.claude/rules/prompt-prefix.md:74`）、`test/integration/thread-prompt-bundles.test.ts`；旁路模型可用本机回环脚本模拟。
- 方案计划的反向用例（`inferred=true` 不直接生效、evidence 非子串不直接生效、外部 agent 仍 `proposed`、到期前延后/到期后放出、过期不占 32 条、不同到期不合并）在实现正确时会失败，方向是对的。
- 但缺少、且必须补的失败用例：
  - 过期 `push_quiet_hours` 不得抛 `PUSH_RULE_UNREADABLE`，其他静默规则仍生效；
  - 过期硬规则不得继续出现在 `owner-rules` 块；
  - `memory.rules.snapshot`/`decision.chain`/`rule_book` 的 `expiresAt` 契约；
  - MCP 外部提议无 `scope` 仍可提议/确认；
  - checker 超时、`refusal`、输出枚举外；
  - DST/纯日期 `validTo` 边界；
  - “两边都 standing 但原话含一次性词 → proposed”；
  - `confirm` 时 `until` 已过期 → 拒绝或重新询问。
- **`check:prompt-prefix` 不能当作本改动的唯一阻断检查**，它不覆盖旁路模型和过期执行路径。

### 4. 每个新值/改动的产生端和使用端都能接受吗？

不能，至少下面这些两端没对齐：

| 值 | 产生端 | 使用端 / 风险 |
|---|---|---|
| `scope`（必填） | 主模型 `rule_set` 参数 | `ProductionOwnerRuleTools.run` 的 `SET_ARGUMENTS`（`production-owner-rules.ts:52`）、`writer.create`、MCP `ProductionMcpRuleWriter.accept`（无 scope）、旧 proposal 载荷、工具 JSON Schema |
| `until`（规则参数） | 主模型 / checker | `parseOwnerRuleParameters`（顶层未知键被忽略）、`sameRule`（只比 type+params）、proposal id hash、`ownerRuleRecord`、`RuleRecord`、push gate、`unreadablePushRule`、MCP `rule_book`、`rule_list`、`memory.rules.snapshot`、决策记录、数据导出/导入 |
| `evidence` | checker | `RuleReceipt`（`production-owner-rules.ts:362-373` 无该字段）、control-center `parseRuleReceipt`（`rule-receipt.tsx:26-82` 丢弃未知字段）、回执卡 i18n |
| 新配置键（checker model） | 部署配置 | `ProductConfiguration`/`RunPolicyConfiguration`（`configuration.ts:290-308`）、strict config 解析、示例配置、测试 |
| `rule-scope` 用途 | checker 调用 | `MODEL_USAGE_PURPOSES`（`model-usage.ts:3-13`）、SQL 校验（`sqlite-model-usage-operations.ts:20-35`）、控制中心 `sensitive.purpose.*` 三语（`zh-CN.ts:1426-1434` 等） |
| “已到期”展示 | 执行点 / 列表 | `memory.rules.snapshot` 枚举（`contracts-v2.ts:1431-1441`）、`decision.chain` 枚举（`contracts-v2.ts:1112-1133`）、`ListedOwnerRule`、`parseRuleReceipt`、`renderRulesMarkdown`/`ownerWording`（`data-export/rules.ts:178-216`） |
| `validTo`（偏好/硬规则出处） | `#writeMemory` | `production-memory-recall.ts:306-315`（只标注不过滤）、`owner-profile-service.ts:107-112, 184-189`、`memory-dates.ts:16-23`、`#reviveMemory`（不更新 validTo） |
| 去重/规则 id | `#activate` / proposal hash | `sameRule`（`production-owner-rules.ts:489-492`）、`ruleId = hash(proposal.key)`、`sqlite-owner-rule-operations.ts:141-144`（参数不同直接 `PORT_CONFLICT`） |

**结论**：现稿把“产生值”的代码点到了，但没有逐个回答“使用它的地方能不能接受”。最典型的是 `scope` 的 MCP 路径、`until` 的导入/去重/闸门、`expiresAt` 的契约/UI，以及 `rule-scope` 的 i18n。
