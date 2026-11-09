# 方案：让老对话的新消息用规则集 2，已发出的字节一个不变

## 一、方案依赖的前提

### 读代码或来源证实的

| # | 前提 | 来源 | 原话/依据 |
|---|------|------|-----------|
| P1 | 出口遮盖每次请求对整个请求体重跑一遍，规则集是**整个请求一个值**，从提示包传来 | `packages/application/src/services/model-egress.ts:220-249`（`text()` 对每个字符串按同一组 options 遮）、`model-egress.ts:226-228`、`packages/runtime-pi/src/pi-runtime-adapter.ts:1000-1007、1567` | `...(this.#context?.redactionRuleset === undefined ? {} : { ruleset: this.#context.redactionRuleset })` |
| P2 | 提示包每次运行只解析一次，一次运行内所有请求共用同一 ruleset | `pi-runtime-adapter.ts:1230-1243`（`#run` 开头 resolve 一次）、`:1541-1568`（streamFunction 闭包捕获同一个 `bundle`） | `const bundle = await this.#dependencies.promptBundles?.resolve({...})` |
| P3 | 历史存遮盖前原文，发送时按确定规则重遮；这是唯一例外 | `.claude/rules/prompt-prefix.md:36` | 「出口遮盖是唯一的例外：历史里存的是遮盖前的内容，每次发送时按确定的规则重新遮盖」 |
| P4 | 每条 thread 消息有持久、严格递增的 `sequence`，envelope 校验强制历史按 sequence 严格递增；消息带 `run_id` | `packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:88-100`、`0015_thread_lifecycle_and_search.sql:12-14`、`packages/application/src/services/context-projection-service.ts:335-343` | 「The context history is not ordered by committed message sequence」 |
| P5 | `identity_json` 是 JSON 文本列，加字段**不需要 DDL**；但写侧是字段白名单，读侧整包 JSON.parse，校验侧是显式 if | `packages/persistence-sqlite/src/sqlite-thread-prompt-bundle-operations.ts:209-217`（写白名单）、`:31`（`identity: JSON.parse(identityJson)`，新字段自动透传）、`:148-165`（校验） | `JSON.stringify({ toolNames: [...], modelRef, thinkingLevel, answerLocale, ...(redactionRuleset === undefined ? {} : { redactionRuleset }) })` |
| P6 | 换代走 `expectedLatestGeneration` CAS + 最多 3 次重试，天然处理并发换代竞争 | `packages/application/src/services/thread-prompt-bundle-service.ts:195-215、243`；`sqlite-thread-prompt-bundle-operations.ts:174-234`（事务内比对 latest generation） | 「if ((latest?.generation ?? null) !== input.expectedLatestGeneration) … return { created: false, record: latest }」 |
| P7 | 换代不必换请求头：记录的 `system_prompt_sha256`/`tools_sha256` 若与上一代相同，`#open` 打开的头字节就相同，代数本身不发给模型 | `thread-prompt-bundle-service.ts:282-293`（sha 校验后返回 systemPrompt/tools 文本）；ADR 0165（`docs/adr/0165-*.md:64`）明确「`redactionRuleset` 不参与是否换新的判断」 | 「记录的 `identity_json` 还带……`redactionRuleset`，它不参与是否换新的判断」 |
| P8 | 规则集 2 只多两条宽松密码规则，其余规则两版相同；遮盖的跨消息效应只有 `named-earlier`，且它不受 ruleset 参数影响 | `packages/sensitive-capture/src/redaction.ts:53-54、89-97、350-363`；`named-earlier` 循环在 ruleset 判断之外：`redaction.ts:411-425` | `(options.ruleset ?? EGRESS_RULESET_CURRENT) >= EGRESS_RULESET_FIRST_LOOSE_PASSWORDS ? … : []` |
| P9 | 反向检查的架子现成且真能抓到「历史被改」 | `packages/runtime-pi/test/prompt-prefix.compat.test.ts:575-600`（两个 REVERSE 用例断言 `findConversationBreak` 非空）、`:655-663`（[ADR-0188] REVERSE：中途切 ruleset 必须报断） | 「expect(findConversationBreak(bodies)).not.toBeNull()」 |
| P10 | 业界原则：已发出的前缀不可改，只能追加；每条 item 有稳定身份 | OpenAI《Preserved reasoning》：<https://developers.openai.com/api/docs/guides/preserved-reasoning>：「keep the history that produced it intact and append new messages and tool results at the end」「If you edit, shorten, or insert a message in that prefix, the API drops the affected reasoning」；OpenAI《Conversation state》（item 持久化、按 item 追加）：<https://developers.openai.com/api/docs/guides/conversation-state>；Anthropic/OpenAI/DeepSeek 缓存文档与 Claude Code 工程文（逐字节前缀匹配）见 `.claude/rules/prompt-prefix.md:6、44` 所引 |

### 推测（未核实，需在实现时验证）

- **G1**：适配器传给 Pi 的 `Context.messages` 与出口看到的请求体 `messages` 数组**逐条一一对应**（条数与顺序）。Pi 序列化逻辑在外部包 `@earendil-works/pi-ai` 里，我没读。方案里用 fail-closed 断言兜底（见下）。
- **G2**：升级换代发生时，`resolve` 的入参链路里能拿到「本次历史的高水位 sequence」（envelope 里有 `sourceWatermark`，`context-projection-service.ts:265-271` 有校验，但它的确切语义、以及 `RuntimePromptBundleResolveInput` 能否带上它，我没核实到取值处）。
- **G3**：pin artifact（per-run）的保留期足够长。我最终方案不依赖它（见下），此条只影响备选做法。

---

## 二、方案本身

### 核心判断

**整条请求一个 ruleset 的现状，在数学上不可能同时满足「老字节不变」和「新消息用规则集 2」**：老对话历史里只要有一条消息含宽松写法（规则 1 没遮、规则 2 会遮），整请求切到 2 就会改已发字节；保持 1 则新消息漏遮。所以必须把「这条消息第一次发送时用的规则集」变成**随消息冻结的属性**，出口对每条消息按它自己的规则集遮。业界没有「中途升级遮盖规则」的一手先例，能引用的原则就是 P10：前缀不可变、逐条 item 有稳定身份、只往后追加——本方案是把「逐条 item 的稳定身份」从消息内容扩展到「消息的遮盖规则版本」。

好消息（P2）：**一次运行内所有请求共用同一 ruleset**，所以「每条消息的规则集」可以粗化到「每条消息所属的那次 run 的规则集」，再由持久化的 sequence 边界事后推导，不需要给每条消息新存任何东西。

### 三步改动（都不改表结构）

**第 1 步：头部不变的换代（每个老对话一次性，自动，无缓存损失）**

- `THREAD_PROMPT_BUNDLE_ORIGINS` 新增 `redaction_ruleset_upgrade`（`packages/application/src/ports/thread-prompt-bundles.ts:6-17`）。
- `#current`（`thread-prompt-bundle-service.ts:190-216`）发现 `latest.identity.redactionRuleset < EGRESS_RULESET_CURRENT` 时，主动走 `#create`：**复制上一代的 systemPrompt/tools 引用**（同文本重新保护，sha256 相同），identity 写 `redactionRuleset: EGRESS_RULESET_CURRENT` 和 `redactionRulesetFromSequence: S`（S = 建代时该对话已提交消息的 sequence 高水位，来源见 G2）。
- 头字节与上一代完全相同（P7），pin 原子地指向新代，trace 记 `prompt.bundle.invalidated`、reason 用新 origin（名字里带 invalidated 但头没变，写 ADR 说明）。主人零确认，缓存零损失。
- 竞争由现有 CAS + 重试吸收（P6）：两个 run 同时升级，一个 created，另一个拿到同一条记录直接用。

**第 2 步：出口按消息逐条选规则集（plan 出带外传递，不进请求体）**

- 不变量：**消息 m 的遮盖规则集 = m 第一次被发送时的规则集**；事后推导为 `m.sequence < S ? 1 : 2`。消息的 `sequence` 持久（P4），S 持久（identity_json，JSON 列，无 DDL，P5），所以**进程重启、跨 run 都能重新推导，不依赖任何内存状态，也不依赖 pin 的保留期**（G3 风险就此消除）。
- 传递：`ModelEgressContext` 加可选字段 `redactionRulesetPlan?: { default: number; byMessageIndex: readonly number[] }`。适配器在 streamFunction 闭包里构造：run 首个请求 = 投影出的历史逐条按 sequence 对照 S + 本轮新消息记当前 run 的 ruleset；run 内第 2..n 个请求，新追加的 assistant 工具调用/tool 结果从未发过，按当前 run 的 ruleset（升级后必为 2）。`default` = 旧规则集，用于非消息字符串（冻结头、上下文块）。
- 消费：`maskRequest`（`model-egress.ts:467-483`）已经逐条遍历 `messages` 数组、`partOf` 已经逐条判角色；把 `text()` 的 ruleset 从 per-Exchange 改为 per-index 即可。plan 是内存参数，**不进 JSON 请求体**，不产生任何新字节。
- **fail-closed 断言**：plan 缺失时行为与现状完全一致（老路径、老测试不破）；plan 提供了但长度 ≠ 请求体 messages 数组长度 → `refuse()`（与「request has an unknown shape」同风格）。宁可这轮不发，不可错位改字节。这是对 G1 的兜底。

**第 3 步：读/写/校验三端同步（I-73 的教训，逐端核）**

- identity 新字段 `redactionRulesetFromSequence`：
  - 产生端：`#create`（`thread-prompt-bundle-service.ts:247` 一带）。
  - 写库端：`sqlite-thread-prompt-bundle-operations.ts:209-217` 的白名单**必须加这个字段**，否则静默丢弃——这正是 I-73 式「只看改动不看两端」的坑。
  - 校验端：`:158-160` 加「安全整数 ≥ 0」校验。
  - 读端：`:31` 整包 parse，自动透传；消费端是适配器构造 plan 的地方。
- 新 origin：产生端（ports 常量数组）与消费端（sqlite 校验 `:150` 用同一个常量数组，天然一致；`promptBundleChange:81-94` 要保证新 origin 不会被当成「换新理由」再次触发换代；`#rulesetFor:263-280` 要为它写当前版本）。

### 关键正确性论证（为什么一个字节都不变）

- 老消息：文本存原文（不可变）+ 遮盖确定（P8，且 named-earlier 与 ruleset 无关）+ 每条消息的 ruleset 冻结 ⇒ 每次重遮与首发逐字节相同。规则 11 的「只取决于自己和前面的内容」从「按对话固定 ruleset」弱化为「按消息固定 ruleset」，确定性不变。
- 新消息：sequence ≥ S ⇒ 永远按 2 遮 ⇒ 不会被退回 1 重遮露明文。
- 每轮变的值仍在最后一条消息（运行环境说明、时间等机制不动）；plan 不进请求体。

### 代价

- 每个老对话一次性多一行 `thread_prompt_bundles` 记录 + 两份重复的受保护 payload（想省可以复用 ref，但 `insertPayload` 的 ref 唯一约束会拦，复制更简单）。
- 每个请求多一次 plan 构造 + 一次长度断言（不增加遮盖次数，只是逐条换 ruleset 参数）。
- 改动面：application（bundle service + ports）、persistence-sqlite（三端同步）、runtime-pi（plan 构造）、sensitive-capture 不动、model-egress（per-index）。

---

## 三、考虑过但不选的做法

| 做法 | 不选原因 |
|------|---------|
| **B1 干跑等价门**：对老对话先用两套规则集对整个当前请求体各遮一遍，字节相等才整线切 2 | 覆盖不了历史里**已经有**宽松写法的对话——恰恰是最危险、最需要修的那批，它们只能永远停在 1，目标落空。且干跑在 bundle 侧无法忠实复现出口遍历 JSON 的顺序和跳过规则（保真度缺口）。可作为后续优化（等价对话跳过 plan），不进主线 |
| **B2 新消息写历史时就存遮盖后文本** | 破坏规则 5 的架构（历史存遮盖前内容）；模型回显占位符时 `restore()` 只查本次遮盖产生的 table（`model-egress.ts:156-159`），存死的占位符查不到，主人会看到 `[密码#xxxxxxxx]`，要再存映射表才能补，复杂度反而更高 |
| **B3 给 `thread_messages` 加 ruleset 列** | 需要 DDL，违反 PA-4 排队偏好（STRICT 表也要走迁移）；sequence 边界已覆盖同一信息，冗余 |
| **B4 维持现状，等压缩或手动 rebuild** | 就是 ADR 0188 已接受的取舍，本次目标明确要补掉它 |
| **B5 全局切 2** | 老对话已发字节被重遮：有的新遮（字节变、缓存失效），更糟的有的**退遮**（历史里按 2 遮过的占位符在规则 1 下重新露出明文），双违反 |

---

## 四、风险和反例

1. **plan 与 body 错位（G1 不成立时）**。反例：老消息被标成 2，历史里原样发出的 `abc12345` 变成占位符——字节变了，缓存整段失效（虽然方向是遮更多，不泄露，但违反「一个不变」的验收）。缓解：长度断言 fail-closed + 真实适配器的门槛用例。
2. **写侧白名单漏字段（P5）**。反例：`redactionRulesetFromSequence` 没进 `sqlite-thread-prompt-bundle-operations.ts:209-217` 的白名单，库里静默没有 S，重启后 plan 退化为「全部按 1」→ 已按 2 遮过的消息被退遮露明文。缓解：三端同步 + 反向用例（见下）专门测「重启后重推导」。
3. **升级代与 run 内并发**：两个 run 同时解析出换代——现有 CAS 已覆盖（P6）；升级 run 自己的 pin 在 `#writePin` 落的是新代。
4. **压缩**：压缩本来整段失效缓存；摘要是新内容，按当前 run 的规则集（2）遮——摘要里若复述了原明文宽松密码，正好被遮，是期望行为。无需特殊处理，但要在 ADR 写一句。
5. **极老数据没有可用的高水位**（G2 落空、envelope 缺失）：这些对话保持规则集 1（= 现状），不做考古，记指标。

---

## 五、需要人拍板的取舍

1. **上下文块（主人档案、长期记忆等非消息字符串）**：方案里保守按旧规则集（它们的历史首发 run 不可靠）。残留缺口：老对话的主人档案里若有宽松写法密码，继续外发。要不要给块也做首发规则集，收益/复杂度比请 Andy 定。
2. **升级时机**：推荐「老对话下一次运行时自动升级」（零人工）；另一选项是先只做机制、升级由 `thread prompt rebuild` 触发，上线更稳但老对话要多等一轮人工。
3. **trace 语义**：头没变的换代要不要复用 `prompt.bundle.invalidated` 事件名（reason 新增）还是另立事件——影响告警和报表口径。
4. **是否同时做 B1 等价门**给「历史干净」的多数老对话省掉 plan（小收益，多一套对照逻辑）。

---

## 六、逐条回答必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。系统提示和工具：换代复制上一代文本、sha256 相同（`thread-prompt-bundle-service.ts:282-293`），请求头逐字节不变；历史：每条消息按它首发的规则集重遮，与首发逐字节一致（依据 prompt-prefix.md 第 4、5 条的同一论证，规则集从「按对话冻结」改为「按消息冻结」，确定性不降级）。发给模型的内容仍然只在末尾追加，每轮变的值仍只在最后一条消息里。成立的前提是 plan 绝不把 2 标到 sequence < S 的消息上——由持久 sequence 比较 + 长度断言 + 反向用例三重保证。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会。一条消息遮成什么样只取决于：它自己的文本、它前面已点名的值（named-earlier，与 ruleset 无关，`redaction.ts:411-425`）、以及它首发的规则集——最后一个是由持久 sequence 与 S 比较得出的常量，不随请求变化、不依赖前后文之外的无序集合、不带时间。plan 是带外参数，不进请求体，不产生新字节。符合规则 10、11。

**3. 有没有对应的自动检查，反向用例会不会真的失败？**
接进 `check:prompt-prefix`（真实适配器 + 真实出口 + 真实遮盖，`prompt-prefix.md:74`）。新增正向用例 `[ruleset-upgrade]`：老对话第 1 轮发「Wi-Fi 密码 abc12345」（按 1，原样出现），第 2 轮触发换代，第 2 轮请求里历史部分 `abc12345` 仍原样、最后一条消息里的「后台密码 xyz98765」必须被遮、`findConversationBreak` 为 null。反向用例两条：(a) plan 刻意错位一格 → 检查必须报 `message-changed`；(b) 让 plan 把已按 2 遮过的历史标回 1 → 请求体出现明文且检查必须报失败。检测能力由现有 REVERSE 用例证明（`prompt-prefix.compat.test.ts:575-600、655-663`）；新用例「真的会失败」这一点本机不跑测试，须由 `npm run check`/CI 首跑确认——标注为未核实。配套：`thread-prompt-bundles.test.ts`（换代 origin、头 sha 不变、CAS 竞争、trace）、`model-egress.unit.test.ts`（per-index 生效、长度不符必须 refuse）。

**4. 每个值的产生端和使用端都核对了吗？**
- `redaction_ruleset_upgrade`（origin）：产生 `ports/thread-prompt-bundles.ts:6-17` + service；使用 sqlite 校验 `:150`（同一常量数组，自动一致）、`promptBundleChange:81-94`（需加分支）、`#rulesetFor:263-280`（写 2）、trace payload `:377`、ADR 0165/0188 文档。
- `redactionRulesetFromSequence`：产生 `#create`；**写库白名单 `operations:209-217` 必须同步**（否则静默丢，I-73 同型坑）；校验 `:158-160` 必须同步；读 `:31` 自动透传；消费 = 适配器 plan 构造。
- `redactionRulesetPlan`：产生 `pi-runtime-adapter.ts:1000-1007、1567` 一带；消费 `model-egress.ts:226-228` 改为 per-index；缺省时行为与现状逐字节一致（老测试不破）。
- 不新增任何配置键、清单项或序列化格式进请求体。

**5. 最小可行做法？哪些直接放弃更划算？**
最小可行 = 上面三步（换代 origin + identity 加一个 JSON 字段 + 出口 per-index plan + fail-closed 断言 + 门槛用例），不需要 DDL、不需要主人确认、不需要贵模型。直接放弃更划算的：上下文块里的宽松写法（老对话按 1，记残留缺口）；没有 envelope/sequence 可考的极老对话（保持 1 = 现状）；B1 等价门这类优化（后补）；压缩期间的额外对齐（压缩本来就整段失效，摘要按 2 遮即可）。
