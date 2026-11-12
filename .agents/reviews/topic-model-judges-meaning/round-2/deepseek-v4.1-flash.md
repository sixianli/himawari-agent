我会先定位方案提到的关键文件与规则，再逐条核对。
## 结论先行

方案的方向（把“理解语义”从词表交给模型）本身合理，但**按现在这份 v1 直接实施会踩到 I-73 的同类问题**：② 产生的 `classification/topic` 没有消费端能接收，① 只改了工具路径、没改自动召回真正使用的 `parseTimeScope` 回退，⑥ 的新模型调用没有进入成本/超时/查询转义链路。下面按严重度列出。

---

## 高严重度（证实的）

### H1. ② 服务端分类在当前契约下无法落地：分类值由客户端 `protectText` 决定，服务端分类结果没有入口

**问题**：方案说“服务端分类，失败默认按敏感处理，下拉仍可手改”。但 `memory.create` 和 `memory.import.commit` 的 payload 只有 `contentRef/category/subCategory`，没有 `classification`，也没有 `topic`；服务端 `#createMemory` 直接用 payload 里已加密时记录的 `payload.dataClassification`。也就是说：

- 浏览器若先按 `private` 保护，模型判成 `sensitive`，服务端改不了；
- 浏览器若先按 `sensitive` 保护（失败默认），模型判成 `private`，服务端也降不下来；
- 模型输出的 `topic` 没有字段可接收，最终仍由 `sensitiveTopicFor(category)` 只按 health/finance 映射，`legal/location/third_party/...` 全变成 `other`。

**证据**：
- `packages/gateway-contracts/src/contracts-v2.ts:1477-1485`：`memory.create` 只收 `contentRef/category/subCategory/pinned`。
- `packages/gateway-contracts/src/contracts-v2.ts:1506-1526`：`memory.import.commit` 的 items 同样没有 classification/topic。
- `apps/agent-service/src/production-memory-control.ts:908-925`：`dataClassification: payload.dataClassification`。
- `apps/agent-service/src/production-memory-control.ts:939-941`：`sensitiveTopicFor(input.category)`。
- `apps/agent-service/src/production-memory-control.ts:100-102`：topic 只可能是 health/finance/other。
- `apps/control-center/src/memory.ts:224-238`：浏览器在发命令前已经用 `item.sensitive ? "sensitive" : "private"` 调 `protectText`。

**建议**：把分类做成服务端能看到明文后再决定分类的路径。两种可行改法：
1. 新增 `memory.classify`/`memory.import.classify` 查询，输入是文本（或 contentRef），返回 `category/subCategory/classification/topic`；浏览器拿到 classification 后再 `protectText`，最后提交 `memory.create/import.commit`。这需要新契约和两次往返。
2. 扩展 `memory.create/import.commit`，接受服务端分类结果并在服务端重新保护 payload（不能只改浏览器）。同时把 `topic` 加进契约和 `#createMemory`，否则模型输出的 topic 必须从方案里删掉。
无论哪种，都要在服务端按 `MEMORY_CATEGORY_NAMES`、`memoryLabelSchema`（32 字符）、batch 上限 500、sensitive topic 枚举做校验；这正是 I-73 的教训（`docs/incidents-and-gates.md:112`）。

---

### H2. ② 一旦“失败默认敏感”，用户没有路径把误判的敏感记忆降回普通；分类还会永久锁住分类下拉

**问题**：方案说“下拉仍可手改”。但 `memory.category.set` 对 `dataClassification === "sensitive"` 或 `sensitiveTopic` 存在的记忆直接抛 `MEMORY_CATEGORY_LOCKED`。如果分类模型失败或误判为敏感，用户既不能改分类，也没有“这不是敏感信息”的入口，记忆会永久不进模型可见范围。

**证据**：
- `apps/agent-service/src/production-memory-control.ts:981-986`：sensitive 或 sensitiveTopic 时拒绝改 category。
- `packages/application/src/services/model-visibility.ts:24-25`：sensitive 不在模型可见集合里。

**建议**：增加一个显式的“纠正敏感分类”操作（带审计、可撤销），或允许在敏感记忆上只改 category 并保留 topic；否则“下拉可手改”只对非敏感记忆成立。还要在 UI 上区分“分类失败按敏感暂存”和“用户确认敏感”，否则失败默认会变成不可逆的沉默降级。

---

### H3. ① 自动召回仍然在用 `parseTimeScope`，方案只改了工具路径

**问题**：方案说“对话路径删 `parseTimeScope`；不经工具的自动召回不再猜时间”。但自动召回走的是 `production-run-memory.ts` → `DurableMemoryService.search` → `HybridMemoryProvider.search`；后者在 `input.scope` 为空时仍会调用 `parseTimeScope(input.query, now, timeZone)`。只改 `production-memory-recall.ts` 不会改变自动召回的行为。

**证据**：
- `apps/agent-service/src/production-memory-recall.ts:159`：工具路径调用 `parseTimeScope`。
- `apps/agent-service/src/production-run-memory.ts:450-458`：自动召回调用 `options.memory.search`，没有传 `scope`。
- `packages/application/src/services/durable-memory-service.ts:420-425`：只有 `input.scope` 存在时才传给 provider。
- `packages/memory-engine/src/hybrid-memory-provider.ts:166`：`const scope = input.scope ?? parseTimeScope(...)`。

**建议**：明确改哪一层。若要“自动召回纯语义”，必须在 `HybridMemoryProvider` 或 `DurableMemoryService` 层显式传一个“不按时间过滤”的 scope，并同步改 `production-real-eval.ts`、`production-run-memory.ts` 等调用方；否则方案描述与代码不符。

---

### H4. ① 删除 `parseTimeScope` 会破坏评测、情景摘要和现有测试；方案只说了“对话路径”

**问题**：`parseTimeScope` 不只用于对话工具。它还被：
- `production-real-eval.ts` 的评测召回（无 scope → 回退）；
- `test/integration/memory-evaluation.test.ts` 和 `memory-episodes.test.ts` 显式调用；
- `packages/memory-engine/test/time-scope.unit.test.ts` 整组测试。

如果按方案“删 `parseTimeScope`”，这些路径会编译失败或行为变化。如果只“停止在对话路径调用”，则评测和情景摘要仍保留时间过滤，方案里的“真实评测前后对比”就不是同一个变量。

**证据**：
- `packages/application/src/services/real-memory-eval-service.ts:604-613`：评测召回没有 scope。
- `test/integration/memory-evaluation.test.ts:505`、`test/integration/memory-episodes.test.ts:318`：显式使用。
- `packages/memory-engine/test/time-scope.unit.test.ts:18-56`：整组用例。

**建议**：保留 `parseTimeScope` 作为评测/情景摘要的确定性工具，只把“生产自动召回”和“recall 工具”改为模型/显式参数；或者先迁移评测再删。方案里要列出所有调用方和迁移顺序。

---

### H5. ⑥ 新抽取调用没有进入每日成本上限的预留/结算，可能在判断前就超支

**问题**：方案说“沿用现有成本上限和遮盖”。但现有 `#related` 在 `costMicros` 初始化之前执行，只检查 `spentToday >= dailyCostMicros`，没有为本次调用预留成本；`#judge` 的 cap 计算也只预留判断调用的成本。新抽取调用如果放在 `#related` 之前，必须自己先估算、预留、结算，否则：

- 抽取调用本身可能超过每日上限；
- 抽取花掉的钱没有计入 `costMicros`，后面的判断仍按旧余额放行，最终总支出超上限；
- 失败/重试没有成本记录。

**证据**：
- `packages/application/src/services/proactive-mail-check-service.ts:829-832`：`spentToday` 读取。
- `packages/application/src/services/proactive-mail-check-service.ts:847-859`：`#related` 在 `costMicros` 之前，只做 `spentToday >= dailyCostMicros` 判断。
- `packages/application/src/services/proactive-mail-check-service.ts:914-924`：判断调用的 cap 只预留 `estimate`。

**建议**：把抽取调用纳入与 `#summaries` 相同的预算对象（`spentToday + costMicros + reserveMicros`），在调用前估算并 `reserve`，调用后 `record`；超限时跳过抽取并退回线程/主题关联。还要给抽取设置 `deadlineAt`、`AbortSignal`、最大输入条数和每封截断长度。

---

### H6. ⑥ 模型输出的单号没有字符集/长度约束，存在 Gmail 查询注入和误关联风险

**问题**：方案只要求“每个必须逐字出现在原文，程序核对”。但单号会被拼进 Gmail 搜索：`search(\`"${reference}" -in:trash -in:spam\`)`。如果邮件正文里出现 `" -in:trash OR ...` 这样的字符串，模型可以原样输出并通过“逐字出现”检查，从而改变搜索语义。现有正则路径用 `[A-Z0-9][A-Z0-9-]{7,39}` 限定了字符集、长度和必须含数字；新模型路径没有继承这些约束。

**证据**：
- `packages/platform-node/src/gmail-related.ts:15`：现有 `REFERENCE_CONTEXT` 的字符集/长度/数字约束。
- `packages/platform-node/src/gmail-related.ts:21-31`：`extractReferenceIds` 的上限 3、长度 8、必须含数字、排除日期。
- `packages/platform-node/src/gmail-related.ts:153-163`：`search(\`"${reference}" ...\`)`。
- `packages/platform-node/src/gmail-related.ts:45-57`：`mentions()` 只做边界核对，不阻止查询本身。

**建议**：模型输出先过与现有正则相同的 allowlist（`[A-Z0-9-]{8,40}`、必须含数字、排除 `YYYY-MM-DD`、大写归一化、去重、最多 3 个），再做逐字核对和 `mentions()`；不要把未经校验的模型文本直接拼进 Gmail 查询。还要限制候选邮件数、每封截断长度和总搜索次数。

---

### H7. ⑥ 方案与现有测试/行为直接冲突：`No. 12345678` 现在被明确判定为“不是单号”

**问题**：方案证明要求“只写 `No. 12345678` 的邮件能串起来”。现有测试明确断言 `extractReferenceIds("ID 123456 and No. 99887766 and # 12345678")` 返回 `[]`，因为前面没有 `order/booking/...` 这类标签。方案要么改测试/行为，要么保留现有约束；不能只写“能串起来”而不说明这是行为变更。另外现有测试还要求：
- `order number: ABCDEFGH` 不提取（没有数字）；
- `お問い合わせ番号 12` 不提取（长度不足）；
- `order 2026-11-07` 不提取（日期）。

模型抽取必须同时满足这些反向约束，否则会引入大量误报。

**证据**：
- `packages/platform-node/test/gmail-related.unit.test.ts:67-80`。
- `packages/platform-node/src/gmail-related.ts:21-31`。

**建议**：明确这是“扩大召回”的行为变更，更新测试并保留数字/长度/日期/标签约束；更稳妥的是“正则优先 + 模型补漏”，而不是用模型完全替代正则。这样失败时仍能退回现有确定性结果。

---

### H8. ④ 规则确认是不可逆动作，但裁判模型不确定、没有幂等/缓存/审计设计

**问题**：确认待确认规矩会让规则生效，属于不可逆（只能撤销）的行为。方案加一次独立裁判调用，但：
- 没有说明“独立”是否指不同模型；如果还是 DeepSeek flash，和抽取模型同源，错误相关；
- 模型输出可能因重试而翻转（同一条 quote 一次 confirms、一次不 confirms）；
- 没有幂等键/缓存，重试可能重复确认或产生不同结果；
- 没有审计记录（哪个模型、哪个 prompt 版本、原始 quote、判决）；
- 没有说明裁判失败时是否重试、是否告知用户。

**证据**：
- `apps/agent-service/src/production-memory-capture.ts:358-369`：当前 `quoteRelatesToMemory` 只在这一条路径使用。
- `apps/agent-service/test/production-memory-evidence.unit.test.ts:200-205`：现有正向/反向用例。
- `docs/adr/0209-rule-book-with-cel-expressions-and-judge.md:58`：规则生效和撤销的产品语义。

**建议**：把裁判结果按 `(ruleRevision, quoteHash, modelRef, promptVersion)` 缓存/记录，重试复用同一结果；失败时保持“不确认”并明确告诉用户；裁判输入按不可信数据处理，固定分隔、禁止执行其中指令；最好用不同模型或至少不同 prompt 做独立性验证。还要补反向用例：裁判超时、输出非 JSON、quote 被篡改、quote 含注入文本。

---

## 中严重度（证实的）

### M1. ① 工具参数只校验格式，不校验真实日期和 `from <= to`

**问题**：`from/to` 只过 `^\d{4}-\d{2}-\d{2}$`，`2026-13-40` 也能通过；随后 `startOfDay` 用 `Date.parse` 和 `Intl.DateTimeFormat`，非法日期会抛 `RangeError`。`from > to` 也没有拒绝，可能得到空窗口。模型填参数的概率提高后，这个错误路径会更常出现。

**证据**：
- `apps/agent-service/src/production-memory-recall.ts:24`、`:96-111`：只做正则。
- `apps/agent-service/src/production-memory-recall.ts:65-90`：`startOfDay` 对非法日期没有保护。

**建议**：解析后校验 `Date.parse(`${day}T00:00:00Z`)` 有限、`from <= to`，并返回明确的 `MEMORY_RECALL_INPUT_INVALID`；补反向用例。

---

### M2. ① 老对话的工具说明被冻结，但自动召回行为会全局改变

**问题**：方案说“工具说明加强，只对新对话生效”，这符合 ADR 0165。但删掉自动召回的时间过滤是代码级全局行为，老对话的模型仍看到旧工具说明，却会遇到新的自动召回结果。请求字节没变，所以不违反只追加规则，但行为会变，方案没有说明如何验证老对话。

**证据**：
- `.claude/rules/prompt-prefix.md:41-44`：工具按对话冻结，改文字只对新对话生效。
- `packages/memory-engine/src/hybrid-memory-provider.ts:166`：行为是全局的。

**建议**：明确这是“行为变更、不是前缀变更”；在老对话上做回归评测，或按对话冻结一个行为开关。

---

### M3. ② 分类调用没有成本/批量/超时/数据分级设计

**问题**：导入最多 500 条、每条最多 500 字；方案只写“一批最多 N 条”，没有 N、没有每日成本上限、没有超时、没有数据分级。分类模型需要看明文，若文本含健康/财务/证件号，直接发给模型可能违反数据分级和出口遮盖要求。

**证据**：
- `packages/gateway-contracts/src/contracts-v2.ts:1518-1524`：items 1–500。
- `apps/agent-service/src/production-memory-control.ts:1005`：导入时读取明文。
- `.claude/rules/owner-standing-rules.md:16`：批量模型调用预计超过 0.5 美元要先问。
- `scripts/check-egress-redaction.mjs:8-16`、`package.json:56`：出口路径要登记。

**建议**：先做确定性密码/证件号/卡号遮盖再分类；分类调用用最高敏感级别准入；定义 N（按 token 预算）、每日 cap、超时、失败重试；把新出口登记进 `check:egress-redaction`。

---

### M4. ⑤ 删除 `dateTokens/chineseNumber/PART_OF_DAY` 会让现有 19 条泄露用例失效，且裁判失败默认未定义

**问题**：现有 `leaksAnswer` 有大量时间/中文数字用例，例如“我下午一点做什么？” vs “主人 1 点起床”应判泄露，“我早上八点” vs “7:30”应判不泄露，“我二十三号” vs “23 日体检”应判泄露。删掉这些函数后，这些用例要么失败，要么依赖新裁判；方案只给了“下午三点/15:00”和“无关问题”两个例子，没有覆盖现有反向用例。另外裁判失败时是“拒绝”还是“通过”没有写：拒绝会减少题量，通过会泄露答案并虚高评测。

**证据**：
- `packages/application/src/services/real-memory-eval.ts:128-168`。
- `packages/application/test/real-memory-eval.unit.test.ts:127-145`。
- `packages/application/src/services/real-memory-eval-service.ts:296-301`：出题后解析。

**建议**：保留一个确定性的时间/数字归一化（或至少保留现有 `dateTokens` 作为第一道），裁判只处理第一道无法判断的情况；明确失败默认（评测建议 fail-closed 拒绝，并记录原因）；把现有 19 条用例全部保留并补裁判失败/超时/非 JSON 用例。

---

### M5. 共享辅助调用封装跨层，且没有说明结构化输出的失败形态

**问题**：② 在 agent-service/control-center，④ 在 memory-capture，⑤ 在 application 的纯函数/服务，⑥ 在 application 的 mail service。`production-model-composition` 在 agent-service；application 层不能直接依赖它。方案说“共用同一个辅助调用封装”，但没有定义端口和注入方式。DeepSeek 官方文档还明确说 JSON Output 只保证“可解析的 JSON”，不保证 schema；无法识别时会把内容替换成空格，`finish_reason` 仍可能是 `stop`。

**证据**：
- `apps/agent-service/src/production-model-composition.ts:571-659`：辅助文本调用在 agent-service。
- `packages/application/src/services/proactive-mail-check-service.ts:101-107`：mail service 只接收 `ProactiveModelInvoker`。
- DeepSeek JSON Output 文档：“if the model's output cannot be recognized as JSON, the API replaces the non-JSON content with spaces... the returned content may contain only spaces... handle blank content”（https://api-docs.deepseek.com/guides/json_mode）。
- OpenAI Structured Outputs 文档也提醒仍要处理 refusal、incomplete、API errors 和 schema 未表达的业务规则（https://platform.openai.com/docs/guides/structured-outputs）。

**建议**：在 application 层定义 `AuxiliaryClassifierPort`（或类似端口），由 agent-service 用 composition 实现；统一做 JSON schema 校验、空内容/截断/非 JSON 重试、超时、成本、数据分级、trace、幂等键。不要直接让 application 依赖 agent-service 的 composition。

---

### M6. 新提示词、出口和模型调用没有列入现有门槛

**问题**：新增 ②④⑤⑥ 的提示词必须进 `packages/prompt-catalog`，否则 `check:prompt-catalog` 会拦；新增模型出口必须登记 `check:egress-redaction`；新增调用模型准入的源文件必须登记 `check:real-admission`；模型名不能触发 `check:expensive-models`。方案完全没提这些门槛。

**证据**：
- `package.json:27`：`check:steps` 包含上述检查。
- `package.json:57-62`：`check:prompt-prefix`、`check:prompt-catalog`、`check:rule-registry`、`check:expensive-models`。
- `scripts/check-real-admission-tests.mjs:10-36`：新增调用方必须登记真实 SQLite 准入测试。
- `scripts/check-egress-redaction.mjs:8-16`：出口调用必须登记。

**建议**：在方案里列出每个新提示词的 catalog id、layer、parser、usedBy；每个新调用点的出口登记；每个新模型调用方的 real-admission 测试；以及 `check:prompt-prefix` 对后台调用“固定指令在前、数据在后、当前时间最后”的验证。

---

### M7. 把 `floor_money_words` 改成模型 `involves_money` 与 ADR 0209 的“硬规则”决定冲突

**问题**：ADR 0209 明确内置规则是代码里的数据、随版本发布、每条有例子，并由确定性 CEL 裁判执行；`check:rule-registry` 还有新旧实现 2 万封邮件的逐字等价测试。把 `floor_money_words` 改成模型输出字段，会让规则不再确定性、无法回放，并且和“规则是硬性设定、写进程序、必定执行”的产品愿景冲突。方案把它列为“漏掉的同类”，但它不是同一类问题。

**证据**：
- `docs/adr/0209-rule-book-with-cel-expressions-and-judge.md:53-59`。
- `packages/application/src/rules/rule-book.ts:53-88`、`:170-217`。
- `package.json:60`：`check:rule-registry` 包含 `rule-book-legacy-equivalence`。

**建议**：本批不要动 `floor_money_words`。如果确实要语义判断金额，另开 ADR，新增一个独立字段/规则，并明确模型输出的存储、回放和失败默认；不要替换内置硬规则。

---

### M8. 成本审批规则没有覆盖 ②④⑤⑥

**问题**：方案只对 ① 写了“要花钱，先问”。但 ② 导入分类、④ 规则裁判、⑤ 评测裁判、⑥ 邮件抽取都是批量模型调用；按 Andy 的长期规则，预计超过 0.5 美元要先报预计费用和用途。

**证据**：
- `.claude/rules/owner-standing-rules.md:16`：“任何评测、测试、实验或批量模型调用，预计要花 Andy 的钱超过 0.5 美元时，先在项目聊天报出预计费用和用途，等 Andy 明确同意再开跑”。
- `.claude/rules/owner-standing-rules.md:26`：记忆系统、模型调用和路由属于大改动，方案先和 Andy 讨论。

**建议**：给 ②④⑤⑥ 各写一个量级估算（每次调用 token × 频次 × 单价），说明是否超过 0.5 美元；并把“先问 Andy”写进实施顺序。

---

## 低严重度 / 文档一致性

### L1. P9 的 LongMemEval 引用支持“自动时间过滤”，不支持“删掉自动时间过滤”

**问题**：论文 §5.4 的原话是：用 LLM `M_T` 从问题抽时间范围并过滤，round 值平均提升 11.3%，session 值提升 6.8%，且需要强 LLM。方案引用它，但 ① 的设计是“自动召回不猜时间，模型需要时自己调工具”。这两者不是同一件事：论文支持的是“在自动召回里用模型做时间范围抽取”，而不是“去掉自动时间过滤”。

**证据**：
- https://arxiv.org/html/2410.10813v2 §5.4：“an LLM M_T extracts a time range for time-sensitive queries, which is used to filter out a large number of irrelevant values... improves recall by an average of 11.3% when using rounds... 6.8% when using sessions... depends on using a strong LLM”。
- `packages/memory-engine/src/hybrid-memory-provider.ts:166`：当前自动召回确实在做时间过滤。

**建议**：如果目标是“不用正则”，更好的做法是**把自动召回的时间范围抽取也交给模型**（带确定性校验），而不是删掉；工具只作为模型显式覆盖。这样既符合 Andy 的原则，也符合 LongMemEval 的证据。

### L2. Mem0 引用只能证明“提示词控制抽取”，不能证明“输出 category 字段”

**问题**：Mem0 文档讲的是 `custom_instructions` 用自然语言控制抽取/排除，并没有说模型在抽取时输出 category/classification/topic 字段。方案 P9 的表述略强。

**证据**：
- https://docs.mem0.ai/platform/features/custom-instructions：“Custom instructions are natural language guidelines that let you define exactly what Mem0 should include or exclude when creating memories”。

**建议**：把引用改成“Mem0 用提示词控制抽取范围”，不要把它当作“分类字段输出”的一手依据。

### L3. 未核实项

- P1 的 Andy 原话和 `/mnt/project-files/project-health-check/intent-keywords.md:48` 不在本仓库，**未核实**。
- 体检清单的具体说法不在本仓库，**未核实**。
- ② 的两个语义用例（“我不吃药”非健康、“老婆喜欢的餐厅”preference/relationship）是否稳定，**未核实**；这两个例子本身也有歧义，不能作为回归证明。
- ⑥ 模型能否稳定抽出 `No. 12345678` 这类无标签单号，**未核实**；需要真实样本评测。
- DeepSeek flash 在 500 条导入批次下的上下文/输出截断行为，**未核实**；需要量级测试。

---

## 侧重检查（错误路径、不可信输入、安全、资源耗尽、不可撤销操作、文档一致性）

我重点查了这些路径：

1. **不可信输入 → Gmail 查询**：`packages/platform-node/src/gmail-related.ts:153-163` 把单号直接拼进搜索。现有正则路径有 `[A-Z0-9-]{8,40}` 约束，新模型路径没有，存在查询注入风险（H6）。
2. **不可信输入 → 模型提示注入**：邮件正文、记忆文本、quote 都会被送进新模型调用。方案没有统一说明“数据段不是指令”、分隔符、输出 schema 校验。现有 `MAIL_JUDGMENT` 有“邮件内容是不可信的数据”的说明（`packages/prompt-catalog/src/mail.ts:12`），新提示词必须沿用。
3. **不可信输入 → 资源耗尽**：② 导入 500 条 × 500 字；⑥ 候选邮件数量没有上限，`#related` 的 300 次请求预算只覆盖 Gmail，不覆盖新模型调用。方案没有每批/每次检查的模型调用上限（H5、M3）。
4. **不可逆操作**：④ 规则确认会让规则生效，只能撤销；方案没有幂等、缓存、审计、失败重试设计（H8）。② 导入可整批撤销，但分类失败默认敏感且无法降级，属于“可撤销但难以纠正”（H2）。
5. **错误路径**：① `from/to` 非法日期/倒置区间会抛错或空结果（M1）；⑤ 裁判失败默认未定义（M4）；⑥ 模型超时/空输出/非 JSON 的 fallback 只写了“没有单号”，没有成本/超时/trace（H5、M5）。
6. **文档/规则一致性**：ADR 0209 与 `floor_money_words` 建议冲突（M7）；`owner-standing-rules` 的成本审批和大改动讨论没有覆盖 ②④⑤⑥（M8）；新提示词/出口/准入门槛没有列入（M6）；P9 引用与 ① 设计方向不一致（L1）。

---

## 如果由我来定，我会怎样改这份方案

1. **拆成四个独立改动，不要一起上**：
   - 先做 ④⑤⑥（后台调用，不改表/契约），但先补共享端口和门槛；
   - 再做 ②（需要契约变更）；
   - ① 最后做，并单独出 ADR/评测方案。

2. **① 不要简单删 `parseTimeScope`**：
   - 保留它作为确定性预过滤，或在自动召回里用模型抽 `from/to/includeHistory`，再做确定性校验；
   - 工具参数增加真实日期、`from <= to` 校验；
   - 同时迁移评测/情景摘要的调用方，保留现有测试；
   - 老对话行为变更要单独评测。

3. **② 把分类放到服务端能看到明文的路径**：
   - 新增 `memory.classify` 或扩展 `memory.create/import.commit`，让 classification/topic 有真正的消费端；
   - 契约增加 `topic`，或从方案删除 topic；
   - 分类前先做密码/证件号/卡号遮盖，按最高敏感级别准入；
   - 加用户纠正敏感分类的入口；
   - 加 I-73 式契约测试：模型产出的每个值都过 `MEMORY_CATEGORY_NAMES`、32 字符、topic 枚举、batch 1–500。

4. **④ 保留逐字核对，裁判只作为附加门**：
   - 用不同模型或至少不同 prompt；按 `(ruleRevision, quoteHash, modelRef, promptVersion)` 缓存/审计；
   - 失败保持不确认；补超时/非 JSON/注入/重试用例。

5. **⑤ 保留确定性时间/数字归一化作为第一道**：
   - 裁判只处理第一道无法判断的情况；明确 fail-closed；
   - 保留现有 19 条用例并补裁判失败用例。

6. **⑥ 正则优先、模型补漏**：
   - 模型输出先过 `[A-Z0-9-]{8,40}`、必须含数字、排除日期、最多 3、去重、大写归一化；
   - 再逐字核对 + `mentions()`；
   - 调用前预留成本、设置超时、限制候选数/截断长度、遮盖并上报 sightings；
   - 失败退回现有正则 + 线程/主题关联。

7. **共享调用封装**：在 application 层定义端口，agent-service 用 `production-model-composition` 实现；统一 JSON schema 校验、空内容/截断重试、超时、成本、数据分级、trace、幂等键；每个新提示词进 `prompt-catalog`，每个新出口登记 `check:egress-redaction`，每个新模型调用方登记 `check:real-admission`。

8. **不要动 `floor_money_words`**；如果要做，另开 ADR 和新规则，不改 ADR 0209 的硬规则。

9. **给 ②④⑤⑥ 补成本估算**，按 `owner-standing-rules.md:16` 先问 Andy。

---

## 逐条回答必答问题

### 1. 会不会改变模型已经见过的请求开头？

**对话请求：不会，前提是按方案描述实现。**
- ① 工具说明改的是 `TOOL_RECALL.text`，属于工具定义；按 ADR 0165/`prompt-prefix.md:41-44`，只对新对话生效，老对话保留旧字节。
- ① 自动召回结果、② 记忆分类、④ 规则确认，最终都进入“最后一条用户消息”的资料块（`prompt-prefix.md:27-28`；`packages/prompt-catalog/src/chat.ts` 和 `runtime.ts` 的 `layer: "last-user-message"`），不是系统提示或工具定义。
- ⑤ 只在评测开启时跑；⑥ 是后台邮件判断，不进入对话请求。
- 每轮会变的值（当前时间、本轮记忆、资料）仍然只在最后一条消息里，符合规则。

**但要注意**：① 删除自动召回的时间过滤是**代码级全局行为**，老对话的请求字节不变，但行为会变；这不违反“只追加”，但方案应明确并单独评测（M2）。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**对话请求的字节：不会，前提是新值只在末尾、序列化确定。**
- 只要 ②④ 的新值不进入系统提示/工具定义，且资料块按固定顺序序列化，同一段历史在后续请求里仍是相同字节。

**但方案目前会引入“值”的不确定性：**
- ② 同一段文本在不同时间分类，可能得到不同 `category/classification/topic`；失败默认敏感后成功又可能变普通。
- ④ 同一 quote + rule 的裁判可能一次 confirms、一次不 confirms。
- ⑤ 同一道题的泄露裁判可能一次拒绝、一次通过。
- ⑥ 同一封邮件可能抽出不同单号，导致 `related` 不同。
这些不改变已发请求的字节，但会改变后续数据/行为。方案没有规定 temperature、幂等键、缓存、排序/去重、失败重试策略。如果目标是可复现（评测、审计、重试），必须补这些控制；如果只是“不改变前缀”，则对话字节是安全的，但后台行为不确定。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**有一部分，但方案的“证明”不够，而且会破坏现有测试。**
- 现有可用的：`packages/memory-engine/test/time-scope.unit.test.ts`、`packages/application/test/real-memory-eval.unit.test.ts`、`packages/platform-node/test/gmail-related.unit.test.ts`、`apps/agent-service/test/production-memory-evidence.unit.test.ts`、`check:prompt-prefix`、`check:rule-registry`。
- 方案只给了少量语义例子和“反向用例”，没有给出：
  - ① 自动召回不按时间过滤的单测、非法日期/倒置区间反向用例、老对话回归；
  - ② 契约测试（category 枚举、subCategory 32 字符、topic 枚举、batch 1–500、classification 不可降级）；
  - ④ 裁判超时/非 JSON/注入/重试/幂等反向用例；
  - ⑤ 现有 19 条泄露用例的保留，以及裁判失败默认；
  - ⑥ 查询注入、成本 cap、超时、遮盖、现有正则约束的反向用例。
- 按 I-73 的教训，**只测“模型能输出”不够，必须把模型输出交给真正的消费端校验**（`docs/incidents-and-gates.md:112`）。当前方案的 ② 就没有做到这一点。

### 4. 每个产生或修改的值，使用它的地方都能接受吗？

逐个核对：

| 值 | 产生处 | 使用处 | 结论 |
|---|---|---|---|
| ① `from/to` | 模型工具调用 | `argumentsOf` 正则、`startOfDay`、SQL 时间过滤 | 格式能过，但非法日期/倒置区间会抛错或空结果；需补校验（M1） |
| ① `includeHistory` | 模型/默认 false | `scope.includeHistory`、SQL `valid_to` | 类型能过；但自动召回仍由 `parseTimeScope` 决定（H3） |
| ② `category` | 分类模型 | `MEMORY_CATEGORY_NAMES` 契约、`#createMemory` | 枚举能过，但需校验模型输出（H1） |
| ② `subCategory` | 分类模型 | `memoryLabelSchema`（32 字符）、`subCategoryFor` | 长度能过；但提示词说 2–6 字/每类最多 8 个，服务端没有校验，可能语义漂移 |
| ② `classification` | 分类模型 | `payload.dataClassification` | **不能接受**：create/import 契约没有该字段，服务端只读 payload（H1） |
| ② `topic` | 分类模型 | `sensitiveTopicFor(category)` | **不能接受**：契约没有 topic，最终只按 category 映射（H1） |
| ④ `confirms` | 裁判模型 | 当前没有持久化字段 | 只能作为内部判决；若要存库/回放，需要新表/契约 |
| ⑤ `leak` | 裁判模型 | `parseGeneratedQuestion` 的 `rejected` | 内部值；需定义失败默认和预算（M4） |
| ⑥ 单号列表 | 抽取模型 | Gmail `search`、`mentions()` | **不能直接接受**：需字符集/长度/数字/日期/上限校验（H6） |
| 新提示词 id / purpose | prompt-catalog | `check:prompt-catalog`、出口登记 | 方案未列，需补（M6） |

**结论**：① 的 `from/to` 和 ② 的 `classification/topic`、⑥ 的单号是三个明确的“生产端/消费端不一致”点；其中 ② 最严重，和 I-73 完全同型。
