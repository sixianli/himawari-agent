## 侧重检查

我走了一遍最普通的使用流程，从入口到结束：

**主人定规则 → 模型调 `rule_set`（quote 来自主人原话）→ `create` 校验（production-owner-rules.ts:603，只查长度≤500 和代理对）→ 写记忆文本 `quote + "\n" + summary`（:522、:611）→ 主人打开记忆页 → `memory.rules.read` → `#rules`（production-memory-control.ts:515）→ `#ruleQuote` 从记忆文本剥出 quote（:487）→ 快照发给网页 → 客户端 `gatewayV2MessageSchema.parse`（apps/control-center/src/gateway-client.ts:269）→ 渲染。**

结论：
- 这条流程里 **「主人原话含换行」会在最后一环炸掉**（详见问题 1）——`#ruleQuote` 原样返回 quote，而合同 `boundedString` 拒绝控制字符；服务端 `#rules` 自己不做 schema 校验，集成测试用的是单行句子且不 parse，所以**没有任何测试盖住这条失败路径**。
- `rule_list`（模型工具）的结果形状变了：`list()` 现在多带 `revision`、`sourceMemoryId`，`ProductionOwnerRuleTools.run`（production-owner-rules.ts:811）把它整个作为工具结果发给模型。改字段不会破坏任何现有测试（模型端无校验），所以**这条路径完全无测试锁定**。
- 账本查询路径（`lastRuleUses`）覆盖较好：正向 + 别的 owner 反向 + 前缀混淆反向（test/integration/decision-ledger.test.ts:466-486）。

## 问题清单（严重度从高到低）

**1.【高】quote 含控制字符会让 `memory.rules.read` 整体失败 —— 产生端没按消费端校验（I-73 同型）**【读代码证实】
- 文件：apps/agent-service/src/production-memory-control.ts:487-495；apps/agent-service/src/production-owner-rules.ts:603；packages/gateway-contracts/src/contracts-v2.ts:1626；packages/gateway-contracts/src/validation.ts:96-99
- 证据：创建时只查 `quote.length > QUOTE_LIMIT || /\p{Surrogate}/u.test(quote)`（owner-rules.ts:603），**允许换行**；记忆文本是 `${proposal.quote}\n${parsed.summary}`（:522）。`#ruleQuote` 剥出的 quote 原样返回，没有像同文件其他视图那样过 `singleLine()`（对照 production-memory-control.ts:699）。合同 `quote: boundedString(500)`，而 `boundedString` 拒绝所有 `<0x20` 和 `0x7f` 的字符（validation.ts:96-99），`\n` `\r` `\t` 都会被拒。服务端 `#rules` 不调 `gatewayV2MessageSchema.parse`（对照 production-observation.ts:353、446 是 parse 的），坏快照直发客户端；apps/control-center/src/memory.ts:103-112 catch 后 `setFailed(true)`，规则区报错。`rule_set` 的 JSON schema 也只限长度（owner-rules.ts:166）。
- 触发：主人多行消息被模型原样引为 quote——聊天里很常见。
- 建议：`#ruleQuote` 剥出后过滤控制字符（或在创建规则时就拒绝含控制字符的 quote，与 `validRuleSummary` 对 summary 的做法一致）；给 `#rules` 补服务端 parse，并加一条「多行 quote」反向集成用例。

**2.【中】改动确实波及发给模型的内容，作者「不改发给模型的内容」的说法不成立**【读代码证实】
- 文件：apps/agent-service/src/production-owner-rules.ts:239-240、:685-699、:811、:190-195
- 证据：`ListedOwnerRule` 新增 `revision`、`sourceMemoryId`（:239-240）；`list()` 带出（:696-697）；`rule_list` 是模型工具（`ownerRuleToolDescriptors` :190-195，在 production-runtime-tools.ts:563 注册），`run()` 返回 `{ rules: await this.#writer.list() }`（:811）——每次工具结果（模型可见）都多出内部记忆 id `memory:rule:<key>` 和版本号。
- 说明：不违反「只追加」（工具结果是每次新追加的消息，系统提示/工具定义/历史未动），但与作者声明矛盾，且内部 id 泄露给模型、结果变大。
- 建议：`rule_list` 的模型结果单独挑字段，不要把 `ListedOwnerRule` 整个给模型。

**3.【中低】`lastRuleUses` 每条规则一次全量 JSON 扫描，性能隐患**【读代码证实（行数与索引）；量级为推算】
- 文件：packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:784-799；migrations/0069_decision_ledger.sql:74
- 证据：对每个 ruleId 执行一次 `ORDER BY checked_at DESC, id DESC LIMIT 1`，外层过滤只用到索引 `(owner_id, agent_id, kind, checked_at)` 的前两列（kind 未定，排序也吃不到），每行都要 `json_array_length(inputs,'$.ruleIds')` 和 `json_each` 解析。proactive 每 15 分钟一行，一年约 3.5 万行 × 最多 32 条规则（`ACTIVE_RULE_LIMIT=32`，owner-rules.ts:52）≈ 上百万次 JSON 解析，每次打开记忆页都要付。
- 建议：改成单条 SQL 用 `json_each` 展开成 `(ruleId, checked_at)` 后分组取最大，或限制扫描时间窗。

**4.【低】`changes` 语义与「修改次数」有出入**【读代码证实】
- 文件：packages/persistence-sqlite/src/sqlite-owner-rule-operations.ts:151、:180；migrations/0087_rule_book_memory_link.sql:357
- 证据：revision 创建=1，每次 `setStatus`（含撤销、重确认）和迁移触发器打成 `needs_review` 都 +1。`changes = revision - 1`（production-memory-control.ts:537）把这些系统状态翻转也算进去。作者说「changes 是规则版本号减 1」与代码一致，但若 UI 写成「改了几次」会夸大。

**5.【低】给已有 snapshot 类型加必填字段，旧客户端会解析失败**【代码证实机制；iOS 发布耦合为推测】
- 文件：packages/gateway-contracts/src/contracts-v2.ts:1626-1630；validation.ts:174-175
- 证据：`object()` 拒绝 unknown field，旧 schema 的客户端收到带 `quote/changes/lastUsed` 的快照会抛错。项目惯例是控制中心与服务端同发布（docs/execution/specs/2026-10-25-thread-execution-push-design.md:72），但 iOS App 不在本仓库，旧版 App 是否同步升级未核实。

**6.【低】测试覆盖缺口**【读代码证实】
- gateway-v2.contract.test.ts 的 rejects 列表（:180-228）没有新字段的反向用例（quote 控制字符、lastUsed 非法 kind、changes 负数）；正向由 fixture roundtrip（:38-42）盖住。
- production-memory-capture.test.ts 新增断言全是正向（:1908-1929）；作者说「正反向断言」，反向只在 decision-ledger.test.ts（别的 owner :480-486、前缀 :466-468）——说法部分准确。
- `lastRuleUses` 的 64 条上限守卫（sqlite-decision-ledger-operations.ts:786-788）无测试（实际因 32 上限不会触发，但守卫未被锁定）。

**7.【备注】「网页共用」只是数据层面**【读代码证实】：web 规则区（apps/control-center/src/components/rule-receipt.tsx:197）仍只渲染 summary，未渲染新字段；本次 diff 未改 UI。不是缺陷，但展示待做。

**未核实**：作者称 8 个文件 297 项通过、format、两套 tsc、check:operations——我无法运行命令，只能确认 diff 涉及 4 个测试文件；migration 触发器写入的 `checked_at` 是否全部 canonical（读到的两处 `NEW.updated_at` 和 `strftime('%Y-%m-%dT%H:%M:%fZ','now')` 均为 canonical 格式，倾向没问题，未穷尽）。

## 必答问题

1. **会不会改变模型已见过的请求开头？** `memory.rules.read` 是主人网页查询（production-approval-gateway.ts:108-111 → `memoryControl.query`），不进模型请求；每轮变化的 `generatedAt`/`lastUsed` 都在网关响应里。系统提示、工具定义、历史、遮盖均未动，**只追加成立**。例外：`ListedOwnerRule` 加字段使 `rule_list` 工具结果（模型可见的新追加消息）内容变了——不违反只追加，但作者「不改发给模型的内容」的说法与代码不符（问题 2）。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会影响模型内容。`quote` 的字节由记忆文本唯一决定（读同一 contentRef 同一字节）；`lastUsed` 随账本状态变化，但它是查询响应语义，不在模型消息里；rules 数组顺序固定（`ORDER BY updated_at DESC, rule_id`，sqlite-owner-rule-operations.ts:89）。字节确定性规则未被触碰。
3. **有没有自动检查、反向用例会不会真失败？** 账本层有：集成测试含正向、跨 owner 反向、前缀混淆反向，去掉实现会失败。合同层正向有（fixture roundtrip），**反向没有**——问题 1 的多行 quote 恰好证明反向缺口真实存在（它就是没被反向用例拦住的缺陷）。
4. **每个值两端校验核对：**
   - `quote`：产生端只限 500 码点，消费端 `boundedString` 还拒控制字符 → **不一致**（问题 1）。
   - `changes`：`Math.max(0, revision-1)` ≥ 0，`integer(0)` 接受 → 一致。
   - `lastUsed.at`：写入时 `validTime` 保证 canonical（validateLedgerWrite:66；触发器写入也是 canonical 格式）→ `timestamp` 通过。
   - `lastUsed.kind`：DB CHECK 限定 DECISION_KINDS（0089:24），均匹配 `machineString` → 一致。
   - `lastUsed.decisionId`：生产 id 形如 `proactive-decision:<uuid>`（service-main.ts:245）、`rule-review:<hex>`（0087:339），匹配 `machineString` → 一致；理论上外部怪 id 会破（低风险）。
   - 规则引用匹配：精确或 `ruleId+'@'` 前缀；owner 规则 id 固定 24 hex（owner-rules.ts:496），无前缀混淆；ledger 引用两种写法（带版本 proactive-rules.ts:44 / 不带版本 0087:351）都覆盖 → 与作者说法一致，测试也验证了。
   - `revision`/`sourceMemoryId` 进 `rule_list`：模型端无校验不会失败，但见问题 2。
