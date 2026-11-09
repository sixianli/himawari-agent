结论：**不建议按现方案直接实施。** 方向（新消息用新规则、旧消息保旧字节）可以理解，但方案把“边界”定义错了，并且忽略了历史实际由原生 Pi 快照承载这一事实；在多个路径上会把已经按规则集 2 遮过的内容重新按规则集 1 发出去。下面按严重度列出我核对到的结果。

## 一、证实的（按严重度）

### 1. 【严重】边界的定义把本轮触发消息算成“旧消息”，新规则恰好漏掉最该遮的那条
- 问题：方案写 `S = 本次运行开始时已提交消息的最大 sequence + 1`。触发本轮的用户消息在运行开始前就已经是 committed，并且拥有当前最大的 sequence，所以它必然 `< S`，被划成旧规则集 1。老对话上线后第一条新消息（正是主人刚输入、最可能含密码的那条）不会被规则集 2 遮盖。
- 证据：`packages/persistence-sqlite/src/sqlite-thread-operations.ts:1100`（触发消息拿 `watermark + 1`），`:1595-1621`（`sourceWatermark` 明确用 `sequence < 触发消息.sequence`，**不含触发消息**）；`packages/application/src/services/context-formation-service.ts:189-193`（触发消息被排除出 history）。
- 方案的验收 1“第 2 轮升级后最后一条新消息里的 xyz98765 被遮”只有在边界等于“触发消息的 sequence”时才成立，也就是只能取 `sourceWatermark + 1`，不能取“max committed + 1”。建议直接把定义改成 `S = context.v1 envelope 的 sourceWatermark + 1`，并在验收里补第 3 轮，证明第 2 轮被遮的值在第 3 轮仍是 2。

### 2. 【严重】原生历史没有 sequence，按消息计数无法套用这个边界；后续可能把规则集 2 遮过的工具结果/回答重新按 1 发出
- 问题：正常多轮对话的历史主要是 Pi 的 `nativeHistory`，它只有 `messages` 和 `coveredRunIds`，没有产品消息 sequence。适配器能拿到的 `RuntimeProjectionMessage` 也没有 sequence。方案第 3 步要求“算出前 headCount 条会话消息属于旧规则集”，但无法判断原生历史中哪些消息是在边界之后首次发送的。升级运行里按 2 遮过的工具结果、助手回答，下一轮进入原生历史后会被当成“旧”消息，重新按 1 遮，宽松写法重新露出；反过来若把原生历史全当新消息，又会改写已发旧消息的字节。
- 证据：`packages/application/src/ports/runtime-history.ts:12-15`（快照只有 messages/coveredRunIds）；`packages/runtime-pi/src/pi-native-history.ts:30-74`；`packages/runtime-pi/src/pi-runtime-adapter.ts:653-668`（先 append nativeHistory，再 append product history）；`packages/application/src/services/context-projection-service.ts:343`（被 native 覆盖的产品消息会被跳过）；`packages/runtime-pi/src/pi-runtime-adapter.ts:1588-1595`（保存整个 session 的 messages）。
- 建议：不要只存一个 sequence 边界。把“首次发送时用的规则集”按消息持久化：原生历史快照 manifest 的每个 entry 带规则集（JSON payload，不需要迁移），产品消息侧用 envelope/边表带规则集；适配器按实际 provider message 顺序传入显式规则集数组。这样也不依赖“边界落在哪条 sequence”。

### 3. 【严重】“算不出 headCount 就全部按当前规则集”只作用于本次请求，下一次请求可能退回旧规则集，形成真实的“先遮后露”
- 问题：方案说 fallback 方向是“遮得更多，不会泄露；最坏缓存断一次”。但 fallback 只在当前请求生效；下一次请求若能算出 headCount，又按边界把同一条历史消息判为旧规则集 1。模型上一轮看到的是遮过的字节，这一轮看到原文，属于泄露，不只是缓存问题。压缩后的 fallback 同理。
- 证据：方案第 4 节；`packages/application/src/services/thread-prompt-bundle-service.ts:282-293`（每次运行重新 `#open` 记录，只有记录里的规则集，没有“曾用过的最高规则集”）；`model-egress.ts:226-228`（规则集按请求传入）。
- 建议：引入单调的“该消息/该对话已用过的最高规则集”下限；任何一次用 2 遮过的消息，后续不得再用 1。fallback 一旦发生，必须持久化为该对话/该消息的新状态，而不是只影响本轮。

### 4. 【高】`classification_lower` 分支会把边界丢掉并写回规则集 1
- 问题：老对话已有边界后，若数据分级降低且系统提示、工具、模型、推理强度、语言都没变，`#rulesetFor` 返回 `storedRuleset(latest)`，即旧记录里的 `redactionRuleset`（老对话为 1）。新记录由 `#create` 用 `...input.identity` 构造，不会带边界。结果是整个对话退回规则集 1，已按 2 遮过的新消息重新露出。
- 证据：`packages/application/src/services/thread-prompt-bundle-service.ts:269-279`（classification_lower 返回 `storedRuleset(latest)`）、`:245-248`（`#create` 只写 `...input.identity` 和 `redactionRuleset`）、`:201-208`。
- 建议：`#rulesetFor` 和 `#create` 必须显式携带边界；或者对所有 `classification_lower` 且提示/工具字节不变的新一代，继承边界并禁止降级。补一条“边界后 classification_lower”的回归用例。

### 5. 【高】回滚不是唯一降级路径；现有 `storedRuleset` 的 `Math.min` 本身就会把 2 降成 1
- 问题：`storedRuleset` 对记录里的规则集做 `Math.min(stored, EGRESS_RULESET_CURRENT)`。回滚到 `EGRESS_RULESET_CURRENT = 1` 的版本时，连新对话记录里的 2 也会被降成 1，所有按 2 遮过的历史重新露出。方案的风险 4 只提到“旧代码不认识新字段”，没提这个更直接的降级点。
- 证据：`packages/application/src/services/thread-prompt-bundle-service.ts:23-28`；`docs/adr/0188-recognize-passwords-without-a-separator.md:59`（明确写“比当前版本高的按当前版本”）。
- 建议：改成单调下限（`max(stored, 曾经用过的最高规则集)`），或在记录里持久化“最高已用规则集”，读到更低版本时拒绝运行/拒绝降级。回滚流程必须和这条绑定，不能只靠“先不回滚”。

### 6. 【高】守卫 UPDATE 没有锁定当前 generation，也没有定义并发失败方怎么处理
- 问题：方案只写 `WHERE … json_extract(identity_json,'$.redactionRulesetFromSequence') IS NULL`。`thread_prompt_bundles` 每个 generation 一行，旧 generation 一般也有 null 字段；若不限定 `generation = ? AND superseded_at IS NULL`，可能更新到被替换的旧行，而当前行仍没有边界。并发时第一个写成功，第二个 UPDATE 影响 0 行；方案一边说“其余读到同一个值”，一边说“写失败就让本次运行失败”，两者矛盾，且没有说明怎么区分“被别的写者抢先”和“数据库错误”。
- 证据：`packages/persistence-sqlite/src/sqlite-thread-prompt-bundle-operations.ts:14-18`、`:35-60`（每代一行）；方案第 2 节；SQLite 的 UPDATE/changes 语义见 https://sqlite.org/lang_update.html 、https://sqlite.org/lang_corefunc.html#changes 、https://sqlite.org/lang_returning.html 。
- 建议：`UPDATE ... WHERE owner/agent/thread = ? AND generation = ? AND superseded_at IS NULL AND json_extract(...) IS NULL`，用 `RETURNING` 或 `changes() === 1` 判断；0 行时在同一事务里重读当前 generation 的边界并继续，只有真正的数据库错误才让运行失败。还要写 trace，便于审计。

### 7. 【高】`resolve` 目前拿不到 sequence，方案没说明边界值从哪来
- 问题：`ThreadPromptBundleService` 的依赖只有 store/payloads/artifacts/protector/clock/ids/trace，没有线程消息仓库；`RuntimePromptBundleResolveInput` 只有 `request` 和 `hasHistory`，`RuntimeProjection` 也没有 `sourceWatermark`。方案写“本次运行开始时该对话已提交消息的最大 sequence”，但没有给出读取路径。
- 证据：`packages/application/src/services/thread-prompt-bundle-service.ts:57-65`、`:94-99`；`packages/application/src/ports/intelligence.ts:388-391`（`RuntimeProjection` 不含 sourceWatermark）；`packages/application/src/ports/context-projection.ts:75-93`（context.v1 envelope 里有 `sourceWatermark`）。
- 建议：`resolve` 通过 `artifacts.lookup` + `payloads.get` + `protector.unprotect` 读取本运行的 context.v1 envelope，使用已校验的 `sourceWatermark + 1`；不要新增一个“max committed”查询，否则会再次落入问题 1。

### 8. 【中】出口 API 根本不知道“第几条消息”，逐条选规则集需要改接口
- 问题：`maskRequest` 虽然遍历 `messages`，但 `TextRedactor` 只接收 `(value, part)`，没有消息下标；`maskTree` 还会钻进 tool_calls、content 数组、未知字段。要按“前 headCount 条”切换规则集，必须把“消息边界”显式传进 redactor，并处理 system/developer、Responses 的 `input`、Anthropic 顶层 `system`。方案只说“出口对 messages 数组”，没有接口设计。
- 证据：`packages/application/src/services/model-egress.ts:220-249`、`:467-490`、`:263-268`。
- 建议：定义 `(part, messageIndex) => ruleset` 或由 `maskRequest` 在进入每条消息时传一个局部 `TextRedactor`；system 消息单独固定；只对已验证格式启用。补单测覆盖嵌套 tool_result、多个 system/developer、content 数组。

### 9. 【中】恢复/续跑的运行可能看到“运行开始后才写入”的边界，同一运行内前后字节不一致
- 问题：方案说“同一次运行内所有请求共用同一个提示包（一次 resolve）”。但 `resolve` 对有 pin 的运行会重新 `#open` 已 pin 的 generation；boundary 是原地改在 `identity_json` 里的，pin 只存 generation，不存边界。一个运行在暂停/审批后恢复时，可能读到另一个运行刚写的边界，导致它之前发过的消息在恢复后的请求里被重新分类。
- 证据：`packages/application/src/services/thread-prompt-bundle-service.ts:174-183`、`:282-293`；`packages/runtime-pi/src/pi-runtime-adapter.ts:1230`（每次运行调用 resolve）；方案风险 1。
- 建议：把边界纳入 pin payload（第一次 resolve 时固定），或把边界做成不可变的 per-run 快照；同时证明/强制同一对话串行。

### 10. 【中】一次性、不可逆的写入，没有校验和修复路径
- 问题：`S 只写一次、永不改小`，但没有校验 `S` 是安全整数、范围合理、与记录里的 `redactionRuleset` 组合合法。`create` 的字段白名单会丢弃未知字段；新的 UPDATE 路径绕过 `create` 校验；`fromRow` 对 `identity_json` 只做 `JSON.parse` 强转，没有验证新字段。字段一旦写错（过大、负数、字符串、被并发写到旧 generation），无法修正。
- 证据：`packages/persistence-sqlite/src/sqlite-thread-prompt-bundle-operations.ts:148-165`（校验只在 create）、`:209-217`（写库白名单）、`:27-33`（fromRow 无校验）；`0077_thread_prompt_bundles.sql:11`（只有 `json_valid`）。
- 建议：新增 `setRedactionBoundary` 存储操作并在 SQLite execute switch、`durable-adapters.ts:1099-1105` 注册；生产端校验 `Number.isSafeInteger(S) && S >= 1`；读回端同样校验，非法值按“数据损坏”失败而不是 fallback；写 trace，并留一个需要 ADR 的修复工具。

### 11. 【中】只支持一次 1→2 迁移，未来规则集 3 无法表达
- 问题：记录里只有一个“旧规则集”和一个边界。将来 `EGRESS_RULESET_CURRENT` 变成 3 时，边界之后的消息会统一用 3，但其中一段曾经用 2 发过，字节会再变一次；若再写新边界又会丢掉旧边界。
- 证据：`packages/sensitive-capture/src/redaction.ts:53-54`；方案第 1、2 节。
- 建议：改成按消息记录规则集，或存储一个单调的规则集序列；至少把“本方案只解决 1→2”写进 ADR 和已知限制。

### 12. 【中】验收没有覆盖真正会出问题的路径
- 问题：现有反向用例 `[ADR-0188] REVERSE` 只证明“整个对话中途切 2”会让前缀断，不能证明逐消息边界正确；验收 1 没有第 3 轮，无法发现原生历史把 2 降回 1；没有 `classification_lower`、fallback 跨轮、非法字段、排队未发消息、格式切换、回滚、工具结果等用例。验收 2 只是“检查器必须报错”，没有断言运行时拒绝降级。
- 证据：`packages/runtime-pi/test/prompt-prefix.compat.test.ts:633-663`；`scripts/check-prompt-prefix.mjs:10`（REQUIRED=8）；方案验收 1-8。
- 建议：补上述用例，并加一条运行时断言/存储层约束：“任何消息一旦以规则集 N 发送，后续不得用低于 N 的规则集重遮”；把这条也做成反向测试。

### 13. 【中】规则文件和文档与方案不一致，方案没有更新计划
- 问题：ADR 0188 明确写“版本 1 的老对话继续原样，直到因工具/模型等原因换新；要更早补，可手动 `thread prompt rebuild`”。本方案改变了这个决定；`docs/kv-cache-guide.md:60` 和 `.claude/rules/prompt-prefix.md:36,52` 也把“规则版本随冻结记录固定”作为现状。方案只写“需要 Andy 拍板”，没有要求新增/修订 ADR、更新规则文件和 guide。
- 证据：`docs/adr/0188-recognize-passwords-without-a-separator.md:54-62`；`docs/kv-cache-guide.md:60`；`.claude/rules/prompt-prefix.md:36,52`。
- 建议：新开 ADR（取代/修订 0188 的后果部分），同步更新 ADR 0165、kv-cache-guide 第 5 行、规则文件第 4/5/11 条，并写清回滚和已知缺口。

## 二、推测 / 未核实

- **G1（provider messages 与产品历史 1:1）大概率不成立。** 现有检查用 `nativeHistory` 模拟历史，没有断言每条产品消息对应一条 provider 消息；原生 custom 消息、compaction summary、附件展开、Anthropic 的 tool_result 合并都会破坏计数。方案说“只开 openai-completions”并不能自动解决原生历史。
- **G2（同对话严格串行）未证实。** `admitOwnerMessage` 每个用户消息直接建 run，没有“线程已有活跃 run”检查；`run_execution_leases` 是 per-run 而非 per-thread（`0021_run_execution_leases.sql`）。派发层是否串行化，我未核实。
- **资源耗尽**：没有发现新增的无界循环；但 `S`/headCount 必须限制为安全整数，负数/NaN/超大值不能悄悄影响分类。
- **不可撤销**：边界写完无法改小；如果第一次写入的 S 偏大，所有早于 S 的新消息会永远停在 1。这比“缓存断一次”严重。

## 三、侧重检查

我重点查了这些路径：

- **错误路径**：边界 UPDATE 影响 0 行、并发失败、`identity_json` 非法/缺字段、headCount 超出消息数、压缩后消息数变化、未知请求格式。结论：方案要么未定义行为，要么 fallback 不持久，存在“先遮后露”。
- **不合规范/不可信输入**：`identity_json` 是数据库文本，`fromRow` 只 `JSON.parse` 强转；新字段没有类型/范围校验。`context.v1` 的 `sourceWatermark` 有校验，是更可靠的边界来源。
- **安全**：发现多条降级/重新露出路径：`classification_lower`、`storedRuleset` 的 `Math.min`、fallback 跨轮回退、原生历史无 sequence、回滚。方案“绝不退回旧规则集”只是文字承诺，代码路径没有对应的单调约束。
- **资源耗尽**：无新增明显风险，但边界值/计数需校验。
- **不可撤销操作**：原地写 `identity_json` 且“永不改小”，没有修复工具；建议至少写 trace、加校验、提供经 ADR 的修复路径。
- **规则/文档/代码一致性**：ADR 0188、ADR 0165、kv-cache-guide、prompt-prefix 规则都与方案冲突，方案没有更新计划。

## 四、如果由我来定

我不会按现方案做。两个可选方向：

1. **首选（如果产品确实要求老对话的新消息也用规则集 2）**：把“首次发送时用的规则集”按消息持久化，而不是推断一个 sequence 边界。
   - 原生历史快照 manifest 的每个 entry 带 `ruleset`；产品历史 envelope 的每条 message 也带 `ruleset`（都是 JSON payload，不需要迁移）。
   - 适配器在确认 provider 消息与产品/native 消息 1:1 后，给出口传一个显式规则集数组；出口按消息下标使用，不再传单个 headCount。
   - 记录一个单调的“最高已用规则集”，任何消息不得降级；`classification_lower`、换新、压缩、回滚都受它约束。
   - 先证明 G1/G2；证明不了就只对已验证格式启用，其他格式保持现状。

2. **最稳（如果不想承担上述复杂度）**：保留 ADR 0188 的“按对话冻结规则集 + 手动 rebuild”，不自动升级老对话。把“老对话新消息仍可能漏掉宽松密码”写进已知缺口；需要时由操作者对该对话执行 `thread prompt rebuild`，一次性付缓存失效的代价。这与业界“已发前缀只追加”的做法最一致（Anthropic/OpenAI/DeepSeek 的缓存文档都要求前缀逐字节不变，见文末链接）。

如果仍要保留 sequence 边界，至少做这些修正：`S = sourceWatermark + 1`；从 context envelope 读；UPDATE 限定当前 generation 并用 RETURNING/changes 处理并发；fallback 持久化为单调下限；`classification_lower` 和 `#create` 携带边界；校验新字段并注册 durable adapter；补第 3 轮、原生历史、classification_lower、fallback、非法字段、排队消息、回滚测试；更新 ADR/规则/guide。

## 五、必答问题

**1. 会不会改变模型已经见过的请求开头？**
头部（系统提示、工具定义、`identity_json` 之外的顶层字段）不变，边界也不进请求体；但**历史不是只追加**。在以下路径会改变已发历史字节：原生历史被重新分类（问题 2）、fallback 跨轮回退（问题 3）、`classification_lower` 丢边界（问题 4）、`Math.min`/回滚降级（问题 5）、暂停/恢复读到新边界（问题 9）。所以答案是：**不能保证“只在末尾追加”**；方案标题里的“已发字节一个不变”不成立。

**2. 同一段文字会不会在不同请求里变成不同字节？**
会。同一段历史文字会因“被判为旧/新消息”而使用规则集 1 或 2；原生历史没有 sequence，分类本身不稳定；fallback 和后续回退、未来规则集 3、回滚都会改变同一段文字的遮法。`known`/顺序本身是确定的，但“用哪个规则集”不是确定且单调的。

**3. 有没有对应的自动检查，反向用例真的会失败吗？**
部分有，但不够。现有反向用例只证明“整个对话切 2 会断”，没有覆盖逐消息边界；`check:prompt-prefix` 只跑 `prompt-prefix.compat.test.ts`，测试场景用原生历史且规则集是整包切换；验收缺少第 3 轮、原生历史、`classification_lower`、fallback 持久化、非法字段、排队消息、格式切换、回滚。反向用例能证明“检查器能发现断裂”，不能证明“运行时不会降级泄露”。`REQUIRED` 从 8 提高是必要的，但远不够。

**4. 每个产生/使用的值，两端都核对了吗？**
没有。方案只列了“resolve/新存储操作、写库白名单、校验、读回、适配器消费”这个清单，但具体缺：
- 新存储操作要加到 `packages/persistence-sqlite/src/sqlite-thread-prompt-bundle-operations.ts:118-146` 的 execute switch 和 `packages/persistence-sqlite/src/durable-adapters.ts:1099-1105`；
- `create` 的白名单 `:148-165`、`:209-217` 要加字段并校验；
- `fromRow` `:27-33` 要校验读回值；
- `#rulesetFor` `thread-prompt-bundle-service.ts:263-280` 的 `rollout`、`classification_lower`、新 origin 三个分支要分别处理；
- `#open` `:282-293` 要返回边界，`RuntimePromptBundle` 类型 `ports/thread-prompt-bundles.ts:89-92` 要扩展；
- 适配器 `pi-runtime-adapter.ts:900-907`、`:1000-1007`、`:1230-1243`、`:1567` 要传/消费边界；
- 出口 `model-egress.ts:31-38`、`:220-249`、`:467-490` 要改接口；
- 测试 `rulesetOf` 和文档也要同步。
  更重要的是，**边界值的含义在生产者（max committed）、验收（期望新消息被遮）和消费者（headCount）之间不一致**；这不是“三端同步”能解决的，必须先统一 `S` 的定义。

## 六、一手来源

- Anthropic 提示缓存（前缀逐字节匹配、前缀变化使缓存失效）：https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- OpenAI 提示缓存：https://developers.openai.com/api/docs/guides/prompt-caching
- DeepSeek KV 缓存：https://api-docs.deepseek.com/guides/kv_cache
- 本项目把“只追加”写成规则：`.claude/rules/prompt-prefix.md:6`、`:36`，并引用上述三份文档。
- SQLite JSON 函数（`json_extract`/`json_set`）：https://sqlite.org/json1.html
- SQLite UPDATE / RETURNING / changes()（用于守卫更新和并发失败判定）：https://sqlite.org/lang_update.html 、https://sqlite.org/lang_returning.html 、https://sqlite.org/lang_corefunc.html#changes
- 事故 I-73（“清单里的 id 能通过后端校验吗”）的教训：`docs/incidents-and-gates.md:112`。
