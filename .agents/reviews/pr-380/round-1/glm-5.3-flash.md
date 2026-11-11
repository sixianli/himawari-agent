# 复核报告：PR 380（P2-3 主人一句话变成长期规则）

基准 `cb9c2819` → `a11c8d9`，共 64 个文件。我通读了 ADR 0213、规则注册表、写入器、检查服务、SQLite 操作、整串读取、回放、网关契约和全部新增测试，并对照了 `.claude/rules/prompt-prefix.md`。

## 发现（按严重度从高到低）

**1. 中高 | apps/agent-service/src/production-owner-rules.ts:231-234、295-303、496-497 | 「明说判定」的引语是子串匹配且触发词过宽，一次性的话可被立成长期规则；主人粘贴的外部内容也算「主人说的」**
证据：
```ts
function standing(quote: string): boolean {
  const folded = foldText(quote);
  return STANDING_MARKERS.some((marker) => folded.includes(marker));  // 含「必须」「每次」「总是」「must」
}
...
if (text !== undefined && comparable(text).includes(wanted)) return true;  // 子串包含即可
...
const explicit = !input.inferred && standing(quote) && (await this.#ownerSaid(input.threadId, quote));
```
`comparable` 只做折叠加去空白，`includes` 是子串匹配。主人说过一次「这封必须提醒我」（一次性），模型后来引用片段「必须提醒我」（本身含触发词「必须」、又是原话子串、`inferred:false`）即满足三条直接生效条件，参数却由模型填。同理，邮件正文被主人粘贴进聊天（role=owner）时，正文里「……以后一律……」的句子也能通过 `#ownerSaid`。工具描述只是提示词约束，程序端挡不住。集成测试（production-memory-capture.test.ts:1849-1860）只测了「整句没说过」「无触发词」「inferred」三个反向，没测片段引语和粘贴内容。
建议：要求 quote 是完整句子（如按句读切分后整句相等，而非 `includes`），或对片段引语（长度过短/非整句边界）降级为提议；考虑把「粘贴内容」与「主人手打」区分开（如只认 runId 关联的用户消息）。

**2. 低 | packages/application/src/services/proactive-mail-check-service.ts:913-920 vs docs/agent-rulebook-inventory.md H-18 | 文档说「读不全就改成请看原信并推送」无条件执行，代码对模型判 act 的邮件例外**
证据：
```ts
const threadUnread =
  threadRules.length > 0 &&
  relatedViews.get(item.messageId)?.wholeThreadComplete !== true &&
  judgement.result !== "act";
```
ADR 0213 决定 1 和清单 H-18 都没写这个例外。若模型判 act 但优先级 low（不满足 `dueSoon` 推送条件），邮件串没读全也不推送、不交给主人。
建议：改文档写明例外，或改代码对 act 也强制。

**3. 低 | packages/application/src/services/proactive-mail-check-service.ts:794-806、886-909 | 每日费用上限耗尽时，主人规则完全不生效，且与 floor 规则的处理不一致**
证据：`spentToday >= this.#options.limits.dailyCostMicros` 时 `relatedViews` 为空 Map（整串读取整段跳过）；此后若模型因 `capped_daily` 没判到该邮件，只有 `floor` 命中的邮件会得到 `basis: "daily_limit"` 的 `check`+push 兜底（887-909），`mustNotify`/`threadUnread` 命中的邮件没有任何 insight。`require_notify`/`require_whole_thread`「必定提醒」的承诺在每日上限下静默失效，无测试覆盖。
建议：至少给规则命中邮件同样的 `daily_limit` 兜底，或在 ADR 后果里写明。

**4. 低 | packages/application/src/services/proactive-mail-check-service.ts:937-939 | `floorHits` 数组未排序，顺序依赖规则数组顺序**
证据：
```ts
floorHits[item.messageId] = [
  ...new Set([...floorIds, ...enforced.map((ref) => ref.replace(/@\d+$/u, ""))]),
].slice(0, 16);
```
`floorIds` 顺序来自 `rules` 数组（783-787 行），其中存储规则的顺序是 SQLite 的 `ORDER BY updated_at DESC, rule_id`（sqlite-owner-rule-operations.ts:89）——`updated_at` 在 reconfirm/needs_review 后变化，同一组命中在决策记录里字节顺序可能不同。消费端（`inputs.ruleIds`、决策链的 `sortedUnique`）都排过序，所以只影响记录本体，不影响模型请求。与旁边 `ruleHits` 的 `.sort()`（936 行）不一致。
建议：同样 `.sort()`。

**5. 信息 | packages/application/src/rules/rule-book.ts:133-137 vs 105-107 | `content_words` 与 `text_words` 对 ſ(U+017F) 的折叠不一致**
`text_words` 走 `foldCase`（ſ→s、U+212A→k），`content_words` 只用 `foldText`（NFKC+toLowerCase，ſ 不变且不匹配 `[a-z0-9_]+`）。两条路径各自自洽（参数两端都走 `foldText`），只在极端字符上行为不同，属已知取舍的话可不改。

**6. 信息（确认无问题的核对结果）**
- 明说判定的引号检查本身挡住了「只出现在邮件正文（未粘贴）里的注入」：`#ownerSaid` 只认 `role === "owner"` 且 `committed` 的消息。
- 强制推送分支与原机制交互：`mustNotify` 绕过 `suppress_push`（976-979 行的 `!mustNotify` 条件）和推送退避（`pushClass` 为 null，993 行，`#gateBackoff` 对 null 不抑制），静默时段仍会 defer——`require_notify` 严格压过降推送规则，方向合理；这些交互 `[P2-3]` 集成测试正向反向都覆盖了（proactive-mail-check.test.ts:2714-2828）。
- 整串读取 `complete`：gmail-related.ts 里 `complete: threadRead && kept.length === thread.length`，加上服务端 `relatedMailView` 再验字符预算，读取失败/超 50 封/超 6 万字都判不完整，有正向和 REVERSE 测试。
- SQLite：`ownerRule.create` 幂等（同 id 同参数返回 replayed，不同参数 PORT_CONFLICT）、`setStatus` 带 `expectedRevision` 乐观并发和 `status != ?` 防空转，均在一个事务里；`OWNER_RULE_ID` 正则、时间、sourceMemoryId、参数大小都有校验。
- 0087 迁移的 `memory_rule_needs_review` 触发器只对 `status='active'` 的规则生效，撤销时先 retire 再归档记忆，不会把已撤销规则复活。
- `readSettings`（sqlite-proactive-operations.ts:230-241）按固定 rule_id 取静默时段/重要发件人，`owner:` 行不干扰；`validateInputs`（646-693）对 rule_id 无白名单，`owner:<hash>@<rev>` 能通过；决策链的 `floorHits` 在写入前已剥掉 `@rev` 后缀（938 行），`describe` 的读端正则不会因 `@` 拒绝。
- 工具描述、失败文案都进了提示词清单（prompt-manifest.json），`emphasis` 登记也对得上。

## 侧重检查（普通使用流程走查：主人说一句话 → 生效 → 下次邮件检查 → 回执/撤销）

1. 主人说「……以后必须通知我」→ 模型调 `rule_set`：描述符 `ownerRuleToolDescriptors()`（production-owner-rules.ts:99-159，纯静态）→ `ProductionRuntimeTools` 权限门 `#isOwnerRule`/`#ownerRule`（production-runtime-tools.ts:600-620、779-786）→ `writer.create` → `#draft`/`#replay`/`#ownerSaid` → `#activate` → `#writeMemory` + `rules.create`。**测试覆盖**：写入器主流程、幂等、提议、soft、未知类型/正则拒绝、reconfirm、undo（production-memory-capture.test.ts:1794-1932）。**无覆盖**：`ProductionRuntimeTools` 的权限门路径（测试直接调 `ruleTools.run`，绕过了 `#exposed`/`assertRunActive`）；`#writeText` 的 `RULE_TEXT_REFUSED`（restricted 分类）分支。
2. 回执卡：`renderToolCard`（execution-process.tsx）+ rule-receipt.tsx，`step-summary.ts` 加了 rule 类。control-center/test/owner-rules.unit.test.ts 覆盖（未逐行核实内部断言，标「部分未核实」）。
3. 下一次邮件检查：`#storedOwnerRules` 每次读库（588-597 行）→ 撤销后下一次检查即生效，有测试（proactive-mail-check.test.ts:2749-2779）。**无覆盖**：每日费用上限 × 规则命中（见发现 3）、静默时段 × 强制推送的组合。
4. 决策记录 → 网页依据抽屉：`ownerRuleSummary`/`describe`（production-decision-chain.ts:107-122）。**无覆盖**：HTTP 组合层把 `ownerRules` 装进 `ProductionMemoryControl` 的线路（测试直接实例化 control）。

## 结论（读代码证实的 vs 推测）

证实：三种新工具只追加在描述符列表末尾且内容静态；主人规则、试算、回放结果都不进任何模型请求；规则参数写入时统一折叠/排序/去重，表达式、例子、命中列表均确定生成；`check:rule-registry` 确实加跑了两类测试且 tooling 测试带反向用例；`owner:` 前缀的 ruleId 在写端、SQLite 校验、决策链、网页契约两端对得上；表结构未改。
推测（未逐行核实）：两个 rule-type 单测文件和 control-center 回执单测的内部断言细节；`DurableMemoryService.applyProposal`/`archive` 对 `memory:rule:` id 的内部校验。

## 必答问题

1. **不会。**对话请求（系统提示、历史、遮盖）完全未动；唯一变化是工具列表追加三个静态定义的工具，老对话按 prompt-prefix.md 第 6 条「工具集合变了」换新一次，ADR 0213 即留记录，符合规则。新增的每轮变化值（回执、ruleHits、回放）全部只进决策记录和网页，不进请求头。
2. **基本不会。**参数写入端 NFKC+小写+去重排序，表达式与例子按固定顺序生成；`ruleHits` 排序；存储规则列表顺序（按 updated_at）不进模型字节。唯一瑕疵是发现 4 的 `floorHits` 未排序，只影响决策记录字节，不影响模型请求。
3. **有，且反向用例会真失败。**`check:rule-registry` 现在跑 `packages/application/test/rule-type-*` 两个类型测试 + test/tooling/rule-type-tests.test.ts（package.json:58）；tooling 测试的 REVERSE 用例验证了「文件缺失/未打标/有 skip/不被该步运行/类型无测试」各自报错、`writableRuleType` 对无测试类型抛 `RULE_TYPE_UNTESTED`；集成层还有「不相关邮件不推」「已撤销规则停用」「整串读完不强制」三个反向（proactive-mail-check.test.ts:2749、2755、2810）。
4. **逐项核对均通过。**`owner:<24hex>`（写端 402 行 / SQLite 正则第 8 行 / 决策链 describe / 网关 machineString）；`rule-proposal:<32hex>`（写入/读取同一路径，confirm 有正则）；`content_folded`/`content_words`（field-catalog 注册、rule-registry 测试同步断言、内置规则不用故行为不变）；`require_notify`/`require_whole_thread`（GATE_OUTCOMES 收录、assertRuleShape 放行、消费端两个 hit 函数、SQLite 记录校验无白名单）；四个新配置键（strict-configuration 解析、production-proactive 传入、integration 测试覆盖）；两条网关消息（contracts-v2 注册 + fixture + control 实现端）。未发现 I-73 式的「改动端合法、使用端校验拒绝」断裂。
