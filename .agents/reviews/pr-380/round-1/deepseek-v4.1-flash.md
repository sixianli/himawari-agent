## 一、读代码证实的问题（按严重度）

### 高：`rule_set` 的“明说判定”可被不可信内容绕过，硬规则会在主人未确认时自动生效

- 文件:行：`apps/agent-service/src/production-owner-rules.ts:231-234`、`281-303`、`459-462`、`495-497`；工具参数定义见 `:116`。
- 问题：自动生效只要求三件事：模型自填 `inferred=false`、`quote` 里含一个通用“长期”字样、`quote` 作为子串出现在最近 6 条主人消息里。`params`、`type`、`summary` 与 `quote` 没有任何绑定；`inferred` 也完全由模型填写。`quote` 最小长度是 1，所以模型只要复用主人以前说过的“以后”“必须”“always”“每次”等任意子串即可。
- 证据：
  - `quote: { type: "string", minLength: 1, maxLength: QUOTE_LIMIT }`（`:116`）
  - `return STANDING_MARKERS.some((marker) => folded.includes(marker));`（`:233`）
  - `if (text !== undefined && comparable(text).includes(wanted)) return true;`（`:300`）
  - `const explicit = !input.inferred && standing(quote) && (await this.#ownerSaid(input.threadId, quote)); if (explicit) return this.#activate(proposal, replayed);`（`:495-497`）
- 结论：如果邮件正文、网页、文件或记忆中的内容能让聊天模型调用 `rule_set`（提示注入），攻击者可以复用主人曾说过的一个“以后/必须”子串作为 `quote`，同时把 `senderDomains`/`phrases` 换成攻击者要的匹配条件，直接写入并执行 `mail_must_notify` 或 `mail_read_whole_thread`，不经过主人确认。这也会把伪造规则永久写进规则类记忆。
- 建议：默认全部走 proposal；只有来自 UI/结构化确认的指令才允许自动生效。至少要做到：`quote` 必须来自紧邻当前轮的某条主人消息并记录 messageId/offset，设置合理最小长度，且 `params` 的每个匹配项必须能在 `quote` 中找到；做不到就降级为 proposal。另加“注入后不得自动生效”的反向测试。

### 中高：`soft` 分支完全跳过“明说/推断”校验，直接写入高重要度记忆

- 文件:行：`apps/agent-service/src/production-owner-rules.ts:463-483`
- 问题：`type === "soft"` 时不调用 `#draft`，也不检查 `inferred`、`standing`、`#ownerSaid`，直接 `#writeMemory` 写一条 `importancePermille: 900`、`inference: false`、`confidencePermille: 1000` 的偏好记忆。模型（或被注入的模型）可以把任意文字静默持久化成“主人偏好”，之后进入模型可见记忆；`#writeText` 只拒绝 `restricted`，`sensitive` 内容也会写入（`:318-320`）。
- 证据：`if (input.type === SOFT_TYPE) { ... const memoryId = await this.#writeMemory({... category: "preference" ...}) ... }`（`:463-483`）与硬规则分支的 `explicit` 判断（`:495-497`）形成明显缺口。
- 与作者/ADR 说法不一致：ADR 说“模型推断出来的只生成提议，主人点头才生效”，但 soft 路径对 `inferred=true` 也不生成提议。
- 建议：soft 也应用 `inferred`/明说判定，或统一走 proposal；敏感内容按现有敏感记忆审批规则处理，不要绕过。

### 中：整串读取返回 `undefined`/404 时被当成“读全了”，不会强制交给主人

- 文件:行：`packages/platform-node/src/gmail-related.ts:142-148`、`172-182`；失败来源见 `packages/platform-node/src/gmail-source.ts:258`、`268-272`。
- 问题：`transport.thread()` 返回 `undefined`（Gmail 404 时 `get()` 返回 undefined）或返回空数组时，`for` 循环不执行，随后仍执行 `threadRead = true`；`threadMessages` 为空，于是 `complete = threadRead && kept.length === thread.length` 变成 `true`。服务端据此认为整串已经读全，`threadUnread` 为 false，不强制改成“要你看”并推送，直接违背 H-18“读取失败就改成要你看并推送”。
- 证据：
  - `for (const message of (await transport.thread(item.threadId)) ?? []) { ... }` / `threadRead = true;`（`gmail-related.ts:142-148`）
  - `complete: threadRead && kept.length === thread.length`（`:181`）
  - `if (response.status === 404) return undefined;`（`gmail-source.ts:258`）
  - 现有反向用例只覆盖 `throw`（`gmail-related.unit.test.ts` 的 `[P2-3] REVERSE` 用 `failThread: true` 抛错），没有覆盖返回 undefined/404。
- 建议：只有拿到数组才算 `threadRead = true`；`undefined` 明确记为失败并令 `complete=false`。补 404/undefined 的反向用例。

### 中：`memory.rules.snapshot` 的 summary 校验比写入端更严，合法规则可能让记忆页查询失败

- 文件:行：`packages/gateway-contracts/src/contracts-v2.ts:1302-1316`；写入端 `packages/application/src/rules/rule-types.ts:257-263`；网关适配 `apps/agent-service/src/production-memory-control.ts:432`。
- 问题：写入端按“码点”限制 200 字且只拒绝孤立代理项（`Array.from(summary).length`、`\p{Surrogate}`），允许换行等控制字符。网关 `boundedString(200)` 按 UTF-16 `length` 限制 200，并拒绝所有 `<0x20` 控制字符。200 个 emoji 或含换行的 summary 能写入规则和记忆，却会被 `memory.rules.snapshot` 校验拒绝，导致“长期规则”列表查询失败。
- 证据：
  - `summary: boundedString(200)`（`contracts-v2.ts:1309`）
  - `Array.from(summary).length > OWNER_RULE_SUMMARY_LIMIT || /\p{Surrogate}/u.test(summary)`（`rule-types.ts:260-261`）
  - `summary: Array.from(rule.summary).slice(0, 200).join("")`（`production-memory-control.ts:432`，截到 200 码点仍可能超过 200 UTF-16 单元）
- 建议：写入端和网关统一使用同一种长度口径（建议码点），并明确拒绝 `Cc/Cf`；或在出站前做 `boundedString` 能接受的截断/清洗。补 emoji、换行、控制字符用例。

### 中：proposal 无上限且每次 `rule_set` 都同步跑全量回放，存在资源耗尽面

- 文件:行：`apps/agent-service/src/production-owner-rules.ts:485-499`、`:420-421`；回放规模见 `packages/application/src/services/owner-rule-replay.ts:141-148`。
- 问题：`ACTIVE_RULE_LIMIT=32` 只限制已生效规则；proposal 每次写一个加密载荷，没有数量上限、过期或清理。每个 `rule_set`（包括 `inferred=true` 的 proposal）在写 proposal 前都会执行 `#replay`，默认枚举 4 种结论 × 每种最多 300 封并读取模型输入。模型可在一个 run 里反复调用，或跨 run 不断生成 proposal，造成持续 CPU/IO 和载荷增长。
- 证据：
  - `const replayed = await this.#replay(draft);` 在 explicit 判断之前（`:486`）
  - proposal 路径 `await this.#writeText(proposalId, JSON.stringify(proposal));`（`:498-499`）
  - 只有 active 分支检查 `existing.length >= ACTIVE_RULE_LIMIT`（`:420-421`）
  - `for (const outcome of OUTCOMES) { ... limit: this.#options.mailsPerOutcome ... }`（`owner-rule-replay.ts:141-148`）
- 建议：对 proposal 也设每人上限和过期清理；对 proposal 延迟回放或限制每日回放次数；把回放成本计入每日模型/IO 预算；同一 run 内对相同参数去重。

### 中：现有配置单元测试会因新增必填字段而失败

- 文件:行：`packages/platform-node/test/startup-configuration.unit.test.ts:1353-1369`；返回对象见 `packages/platform-node/src/strict-configuration.ts:1069-1072`。
- 问题：`parseProactive` 现在总是返回 `wholeThreadMailsPerMail`、`wholeThreadCharactersPerMail`、`ruleReplayDays`、`ruleReplayMailsPerOutcome`，但该用例使用 `toEqual` 且期望对象未更新，会收到多余字段而失败。这说明 PR 当前不能通过完整测试门禁。
- 证据：`).toEqual({ ... relatedRequestsPerCheck: 300, memoryMinimumSimilarity: 0.45, ... })`，其中没有四个新键；而 strict config 返回对象包含 `wholeThreadMailsPerMail: optional(...)` 等。
- 建议：更新期望对象，并补充新键的非法值用例（边界、小于 `relatedCharactersPerRelatedMail` 等）。

### 低：应用层允许的规则参数可能超过 SQLite 的 16KB 上限

- 文件:行：`packages/application/src/rules/rule-types.ts:70-85`；`packages/persistence-sqlite/src/sqlite-owner-rule-operations.ts:12`、`131-132`。
- 问题：应用层允许 5 个列表各 32 项、每项 64 码点；emoji 等代理对字符在 `JSON.stringify` 后按 UTF-16 计长，最坏可超过 20KB，而 SQLite 端 `MAX_PARAMETERS = 16_384` 会拒绝，返回 `RULE_UNAVAILABLE`。这属于 I-73 所说的“清单能过前端、后端校验不认”的两端不一致。
- 建议：应用层按序列化后字节/UTF-16 长度限制，或提高 SQLite 上限并统一常量。

### 低：回放会多算“自己发出的邮件”和整串规则

- 文件:行：`packages/application/src/services/owner-rule-replay.ts:149-164`；实时检查的排除见 `packages/application/src/services/proactive-mail-check-service.ts:789-792`、`:918`；`ProactiveProcessedMessage` 没有 `sentByOwner` 字段，见 `packages/application/src/ports/proactive-checks.ts:119-130`。
- 问题：实时检查对 `sentByOwner` 跳过 `require_notify`/`require_whole_thread`，但回放拿不到该字段，会把主人自己发的已处理邮件也算进 `changed`。此外 `require_whole_thread` 的命中被统一记成 `after: "whole_thread"` 并计入“现在会改成要你看”，但实时逻辑只有在整串未读全时才强制改成 check（`:913-920`）；整串本来就完整时模型结果不变。回执数字会系统性偏高。
- 建议：在 processed 记录中保留 `sentByOwner`；整串规则的回执改成“会多读整串的邮件数”，不要直接说“会改成要你看”；或回放时读取 thread 判断是否包含 SENT/是否可能读全。

### 低：`must_notify` 推送仍可能被降频规则压掉

- 文件:行：`packages/application/src/services/proactive-mail-check-service.ts:974-993`、`:1090-1118`。
- 问题：`pushClass` 在 `push && dueSoon && !floor` 时设置，没有排除 `mustNotify`。因此一封同时符合“高优先级、临近截止”的 must-notify 邮件，其推送仍可能被 `#gateBackoff` 的 `suppress` 改成 `push:false`，与“一定提醒”冲突。整串强制推送不会遇到 dueSoon（`threadUnread` 只对非 act 生效），但 must-notify 会遇到。
- 建议：`mustNotify` 的推送应像地板规则一样跳过降频（`pushClass: null` 或 `#gateBackoff` 跳过），并补交互测试。

### 低：整串规则对 act 的例外与 ADR/H-18 文案不一致

- 文件:行：`packages/application/src/services/proactive-mail-check-service.ts:913-920`。
- 问题：`threadUnread` 含有 `judgement.result !== "act"`，所以读整串失败但模型已判“要你做事”时，不会强制推送，规则也不会记进 `ruleHits`。ADR 0213 和 H-18 只对 `mail_must_notify` 写了“act 不动”，对 `mail_read_whole_thread` 写的是“读不全或读取失败就改成要你看并推送”。
- 建议：按 ADR 去掉整串规则的 act 例外，或在 ADR/H-18 明确写出例外并补测试。

### 低：去重命中 `needs_review` 规则时回执仍报 `active`

- 文件:行：`apps/agent-service/src/production-owner-rules.ts:404-419`。
- 问题：`same` 只按 type/params 找非 retired 规则，不检查其状态；返回回执固定 `status: "active"`。如果已有同参数规则处于 `needs_review`，回执会说“已生效”，但记忆页会显示“待重新确认”。
- 建议：返回 `same.status`，并在回执里如实展示。

### 低：先写记忆再写规则，失败会留下孤儿规则记忆；撤销归档失败被静默吞掉

- 文件:行：`apps/agent-service/src/production-owner-rules.ts:422-435`、`:589-595`。
- 问题：`#writeMemory` 成功而 `rules.create` 因冲突/参数超限/SQLite 错误失败时，规则记忆已经写入但规则不存在；重试同一 tool call 会命中失败缓存，孤儿记忆不会自动清理。`undo` 归档失败用 `.catch(() => undefined)` 静默忽略，规则已 retired 但出处记忆仍 active。
- 建议：规则和记忆写入做补偿/回滚，或记录可重试的清理任务；归档失败至少写审计。

### 低：文档和清单与代码不一致

- 文件:行：`docs/agent-rulebook-inventory.md:52`、`:57`；`docs/adr/0213-owner-sentence-becomes-a-standing-rule.md:109`；`:95`；`packages/platform-node/src/gmail-related.ts:142-147`、`:172-174`。
- 问题：
  - 清单新增 H-17、H-18，但“一共盘出 54 条：程序硬规则 16 条”没有更新（应为 56/18）。
  - ADR 关联文档写“H-15、H-16、H-17”，实际新增的是 H-17、H-18。
  - ADR 说整串读取“上限是每封 50 封”，代码实际先拉取整个 thread，再用 `slice(-wholeThreadPerMail)` 限制进入模型的数量；网络/解析成本并不受 50 限制。
- 建议：同步更新计数和编号；把“读取上限”改写成“交给模型的上限”。

## 二、推测与未核实

- 未核实 `packages/prompt-catalog/prompt-manifest.json` 里新增的三个工具文本哈希是否与源码完全一致（不能运行哈希命令）。
- 未核实“工具集合变化时每次换新都留记录”的日志是否实际写出；只确认 ADR 引用了 prompt-prefix 第 6 条。
- 未核实 CEL 解析器对 `JSON.stringify` 不转义的 U+2028/U+2029 等字符的处理。`entries` 允许这类字符，理论上若 CEL 把其当字符串终止符，可能影响表达式生成；目前没有证据，属于待验证风险。
- 未核实 payload 中 `model_input` 是遮盖前还是遮盖后内容；回放只取其 `from`/`subject` 且最终仍走出口遮盖，因此未发现新的未遮盖出口，但不能确认。
- 未核实 memory 引擎对 `memory:rule:<32hex>` 这个 ID 的完整约束；只核对了 SQLite 的 `MEMORY_ID`（1–128 可打印字符）和长度约 44，满足该层。

## 三、侧重检查

- 错误路径：
  - SQLite `create`/`setStatus` 对 ruleId、时间、sourceMemoryId、source、status、reason、revision 都有校验，并使用事务；`list`/`read` 读操作无事务需求。见 `sqlite-owner-rule-operations.ts:62-197`。
  - 整串读取 404/undefined 被当成 complete=true，是已证实的错误路径缺陷。
  - `confirm()` 直接 `JSON.parse(text) as Proposal`，没有校验字段形状；载荷只能由内部写入，风险低，但损坏数据会抛出非 `OwnerRuleError`。
- 不可信输入：
  - 规则参数只允许域名/地址/短语/英文整词/排除词，不允许正则；表达式由程序生成，CEL 只允许白名单函数和结构，未发现参数直接变成代码。见 `rule-types.ts:70-133`、`rule-expression.ts:12-99`。
  - 主要漏洞是 `quote`/`params` 解耦和 soft 路径绕过；summary 的控制字符/长度口径不一致也会造成下游拒绝。
- 安全：
  - `ruleId`(`owner:`+24 hex) 能通过 SQLite `OWNER_RULE_ID` 和网关 `machineString`（允许 `:`）；proposalId(`rule-proposal:`+32 hex) 能通过 `confirm` 正则和网关 `machineString`。未发现 I-73 那类 id 不匹配。
  - 硬规则的自动生效和 soft 记忆的静默写入是本次最值得关注的安全面。
- 资源耗尽：
  - proposal 无上限、每规则同步回放是已证实的资源面；整串读取受 `requestsPerCheck` 预算约束，但 404 情况的 complete 判断有逻辑缺陷。
- 不可撤销的操作：
  - 撤销是“retired + 归档记忆”，没有硬删除；创建/撤销可逆。但建规则失败会留孤儿记忆，撤销归档失败被吞掉。
- 规则文件/说明与代码：
  - 发现清单计数、ADR 编号引用、整串读取上限措辞、整串 act 例外与代码不一致；`startup-configuration` 测试未同步新配置字段。

## 四、必答问题

1. **会不会改变模型已经见过的请求开头？**
   会改变一次：新增 `rule_set`/`rule_list`/`rule_undo` 三个工具定义，老对话下一轮开始按 `.claude/rules/prompt-prefix.md` 第 6 条“工具集合变了”换新一次；ADR 0213 也这样记录。除此之外，没有发现新的每轮变化值进入系统提示、工具定义、历史或遮盖结果：新工具的 enum 来自编译期注册表且顺序固定；回放数字、规则列表都在工具结果（末尾追加）；`content_folded`/`content_words` 只用于本地规则求值和试算，不发给模型；遮盖逻辑未改。因此“只在末尾追加”在一次性工具集合换新之后成立。每次换新是否真的写了记录未核实。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   没有发现模型可见内容的不确定性：`ruleHits` 排序、SQLite `rule_list` 的 `ORDER BY updated_at DESC, rule_id`、示例生成顺序都是确定的；`content_words` 用 Set 保序但只用于 membership。规则更新会改变 owner rules 的 `updated_at` 顺序，但只会影响 `floorHits`/决策记录的展示顺序，不影响请求头；如果要求决策记录也逐字节确定，`proactive-mail-check-service.ts:937-939` 的 union 没有排序，建议顺手排序。

3. **有没有对应的自动检查，反向用例真的会失败？**
   有：`check:rule-registry` 已加跑两个 `rule-type-*` 测试和 `test/tooling/rule-type-tests.test.ts`；工具测试对“测试文件缺失、无 `[rule-type:id]` 标签、有 skip/only、未被 check 脚本运行、未测试类型”都有会失败的反向断言；集成测试覆盖存储规则强制执行、撤销后下次检查停止、整串读取失败/成功两种路径、历史回放。缺口是：没有注入后自动生效、thread 404/undefined 被误判 complete、summary 长度/控制字符、proposal 上限、backoff 与 must-notify 交互的反向用例；并且 `startup-configuration.unit.test.ts` 当前会因新增配置字段而失败，所以 PR 现在不能通过完整测试门禁。

4. **改动产生或修改的每个值，每个使用它的地方都能接受吗？**
   - `owner:<24 hex>`：SQLite `OWNER_RULE_ID` 接受，网关 `machineString` 接受，决策链/`floorHits` 去掉 `@revision` 后仍能匹配；可以。
   - `rule-proposal:<32 hex>`：`confirm` 正则、网关 `machineString`、payload ref 均接受；可以。
   - `memory:rule:<32 hex>`、`memory-content:rule:<32 hex>`：SQLite `MEMORY_ID`（1–128 可打印字符）接受；memory 引擎的完整 ID 规则未核实。
   - 规则 `parameters` JSON：应用层最坏可超过 SQLite `MAX_PARAMETERS=16384`，两端不一致，见上面“低”问题。
   - `summary`：应用层 200 码点/允许 Cc，网关 `boundedString(200)` 按 UTF-16 且拒绝 Cc，不一致，见上面“中”问题。
   - `status`：DB 只允许 `active`/`needs_review`/`retired`，网关快照只允许前两种，`list` 已过滤 retired；可以。
   - 新增配置键：strict config 都能解析并给默认值，`ProductionProactive` 都有映射；但 `startup-configuration` 的期望对象未更新，现有测试不接受。
   - `content_folded`/`content_words`：所有事实都由 `senderFacts` 统一生成，相关单测已补字段；未发现遗漏的生产构造点。
   - `wholeThreadPerMail`/`wholeThreadCharactersPerMail`：类型、默认值、strict config、生产映射都有；未发现其它必填构造点缺失。
