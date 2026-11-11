## 读代码证实的问题（按严重度从高到低）

### 1. 高：一次性整句仍会被当成常设规则，半句防护只挡住了“半句”，没挡住“完整的一次性分句”

- 文件:行：`apps/agent-service/src/production-owner-rules.ts:232-249`、`:51-76`、`:517-519`；测试 `test/integration/production-memory-capture.test.ts:1849-1854`；ADR `docs/adr/0213-owner-sentence-becomes-a-standing-rule.md:61`
- 问题：`isStandingQuote` 只要求 quote 里出现“必须/以后/一律……”任意一个词；`saysWholeClauses` 只要求 quote 等于主人消息里连续若干个分句。因此主人说“这封必须提醒我，别的不用”时，模型只要把 **“这封必须提醒我”这个完整分句** 作为 quote，`isStandingQuote` 因“必须”返回 true，`#ownerSaid` 也会匹配，`inferred=false` 就直接 `#activate`，不需要主人确认。当前反向用例只覆盖了更短的片段“必须提醒我”，没有覆盖“这封必须提醒我”这个完整分句。
- 证据：
  - `const STANDING_MARKERS = [ "以后", … "必须", … ]`（`:51-76`）
  - `export function isStandingQuote(quote: string): boolean { const folded = foldText(quote); return STANDING_MARKERS.some((marker) => folded.includes(marker)); }`（`:232-235`）
  - `if (quote.every((clause, index) => clauses[start + index] === clause)) return true;`（`:244-249`）
  - `const explicit = !input.inferred && isStandingQuote(quote) && (await this.#ownerSaid(...)); if (explicit) return this.#activate(proposal, replayed);`（`:517-519`）
  - 测试只验证了 `["fragment of a one-off sentence", { quote: "必须提醒我" }]`（`test/integration/production-memory-capture.test.ts:1853`）
- 建议：把“必须/must”从可单独触发直接生效的标记里去掉，或要求 quote 必须包含“以后/一律/每次/from now on”这类时间或反复性限定；对“这/本封/今天/这次”等一次性指示词加分句级反向判断；同时补一条“这封必须提醒我”必须落成 proposed 的反向用例。另一个更根本的问题是 quote 与 params 没有语义绑定，模型可以把任意一次性分句配上任意发件域名，建议至少要求 params 中至少一项来自同一句原话，或所有直接生效都走主人确认。

### 2. 中：写规则失败后归档记忆，再重试 confirm 可能留下“规则生效但来源记忆已归档”

- 文件:行：`apps/agent-service/src/production-owner-rules.ts:443-455`、`:602-616`、`:543-550`；`packages/application/src/services/durable-memory-service.ts:121-143`
- 问题：`#activate` 先写规则记忆，再 `rules.create`；`create` 失败时 `catch` 归档刚写的记忆。第一次失败归档后，如果主人再次点“生效”（`confirm` 用同一个 `proposal.key`），`#writeMemory` 再次走 `applyProposal({decision:"create"})`。`applyProposal` 发现同 id 的 `sameProposal` 会直接返回已有记录，**即使它已经是 archived，也不会重新激活**。随后 `rules.create` 若成功，就得到“active 规则 + archived 来源记忆”。
- 证据：
  - `.catch(async (error: unknown) => { await this.#archiveMemory(memoryId); throw error; })`（`production-owner-rules.ts:452-455`）
  - `confirm` 直接 `return this.#activate(proposal, null);`（`:549`）
  - `if (sameProposal) { if (existing.status === "active") await this.proposeProjection(existing, "upsert", generationId); return existing; }`（`durable-memory-service.ts:134-137`）
- 建议：重试前检查来源记忆状态，archived 时 `recover`/重新创建，或以“只归档尚未关联规则的记忆”为条件；给 `confirm` 加重试测试：第一次 `rules.create` 抛错、第二次成功，断言来源记忆仍是 active。

### 3. 中：撤销先 retire 规则、后归档记忆；归档失败会留下“规则已撤销但规则记忆仍生效”

- 文件:行：`apps/agent-service/src/production-owner-rules.ts:624-635`、`:602-616`；`packages/application/src/services/owner-profile-service.ts:175-180`、`:203-206`
- 问题：`undo` 先把规则置 retired，再调用 `#archiveMemory`。归档失败时抛出 `RULE_UNAVAILABLE`（可重试），但此时规则已不再执行、规则记忆仍是 active。active 的 `category:"rule"` 记忆会被 `OwnerProfileService` 放进 profile 的 rules 段（`:203-206`），所以模型仍会看到这条已撤销的规矩。若 `latestGeneration` 已经不存在，`#archiveMemory` 抛 `RULE_MEMORY_NOT_READY`，重试也永远无法补做，和 ADR“再撤销一次会补做”不完全一致。
- 证据：
  - `if (current.status !== "retired") { … status: "retired" … } if (current.sourceMemoryId) await this.#archiveMemory(current.sourceMemoryId as MemoryId);`（`:624-635`）
  - `const generation = await this.#options.book.latestGeneration(this.#scope()); if (!generation) throw new OwnerRuleError("RULE_MEMORY_NOT_READY");`（`:603-604`）
  - `eligible.filter((memory) => memory.attributes?.category === "rule")`（`owner-profile-service.ts:203-206`）
- 建议：用可恢复的两阶段状态（例如先把记忆标成 tentative/待归档，或先归档记忆再 retire，并配补偿），或至少在归档失败后把规则也回滚到 active，避免“规则已撤销但模型还看得见”。同时把 `latestGeneration` 缺失也纳入“可重试补做”的范围，并补归档失败后重试的测试。

### 4. 中：评测脚本的判分和写入端不一致，会把写入端只会存成 proposed 的输出判为通过

- 文件:行：`scripts/evals/owner-rule-live.eval.ts:145-151`；`apps/agent-service/src/production-owner-rules.ts:308-315`、`:483-487`
- 问题：
  - soft 分支在 `if (item.expect === "soft") return …` 直接返回，只检查了 `type`，没有检查 `inferred === false`、quote 是否原话、是否是完整分句；写入端 soft 分支要求 `!input.inferred` 且 `#ownerSaid` 成功，否则抛 `RULE_NOT_EXPLICIT`。
  - 非 soft 分支用 `item.sentence.includes(quote)` 判断原话，而写入端用 `clausesOf`/`saysWholeClauses` 做整句匹配。例如模型 quote “以后必须看整个邮件串再判断” 是句子“涉及退款的邮件以后必须看整个邮件串再判断”的子串，评测会通过，但写入端 `#ownerSaid` 因它不是完整分句会返回 false，最终只生成 proposed。
  - 评测完全没有调用 `ProductionOwnerRuleWriter`，所以无法区分 active / proposed / soft。
- 证据：
  - `if (item.expect === "soft") return { caseId: item.id, pass: !reasons.length, reasons, call: args };`（`owner-rule-live.eval.ts:146-147`）
  - `if (!item.sentence.includes(quote)) reasons.push("quote 不是原话");`（`:150`）
  - 写入端：`const wanted = clausesOf(quote); … if (text !== undefined && saysWholeClauses(text, wanted)) return true;`（`production-owner-rules.ts:308-315`）
  - soft 写入端：`if (input.inferred || !(await this.#ownerSaid(input.threadId, quote))) throw new OwnerRuleError("RULE_NOT_EXPLICIT", "偏好只记主人的原话");`（`:486-487`）
- 建议：评测直接构造一个内存版的 `ProductionOwnerRuleWriter`，按真实 `create` 的返回判定 `status === "active"` 才算通过；或至少复用 `clausesOf`/`saysWholeClauses` 和 soft 的 `inferred`/原话校验逻辑。补一条“quote 是子串但不是完整分句”的失败用例。

### 5. 中：新增的 live eval 实际上不会因为判分失败而失败

- 文件:行：`scripts/evals/owner-rule-live.eval.ts:173-209`、`:52-56`
- 问题：整个测试只做了 `expect(CAP_USD).toBeGreaterThan(0)`，然后把结果写进 `result.json` 并 `console.log`，没有对 `summary` 的通过率做任何断言。模型退化到 0 分，测试仍然退出成功。另外 system prompt 只用 `CHAT_IDENTITY + CHAT_ANSWER_LANGUAGE`，不是生产主系统提示，也没有生产历史/工具循环。
- 证据：
  - `expect(CAP_USD).toBeGreaterThan(0);`（`:176`）
  - `writeFileSync(…); console.log(JSON.stringify({ spentUsd, summary }, null, 2));`（`:203-208`）
  - `const system = `${CHAT_IDENTITY.text}\n\n${CHAT_ANSWER_LANGUAGE.text}`;`（`:56`）
- 建议：如果它只是人工报告脚本，文件名和说明应明确“不设门槛”；如果要当自动检查，给每个模型/用例设最低通过率并在低于阈值时 `expect.fail`，并至少把生产的 rule 工具说明和主系统提示纳入请求。

### 6. 低：规则说明的长度/字符校验在三个地方不一致，且“不能有换行”没覆盖 U+2028/U+2029

- 文件:行：`packages/application/src/rules/rule-types.ts:258-268`；`apps/agent-service/src/production-owner-rules.ts:138`、`:483-485`；`docs/adr/0213-owner-sentence-becomes-a-standing-rule.md:58`
- 问题：
  - 硬规则用 `summary.trim().length > 200`（UTF-16 码元），工具 schema 的 `maxLength: 200` 通常按 Unicode 码点，soft 路径又用 `Array.from(summary).length > 200`（码点）。带 emoji 等增补平面字符时，schema/soft 能过、硬规则会拒。
  - 硬规则拒绝 `\p{Cc}\p{Cf}`，但 U+2028 LINE SEPARATOR、U+2029 PARAGRAPH SEPARATOR 属于 Zl/Zp，不在其中；`trim()` 只去掉首尾，内部 U+2028 仍会留下。ADR 写的是“不能有换行”。
  - soft 分支只检查 `Array.from(summary).length`，没有 Cc/Cf 检查，和硬规则不一致。
- 证据：
  - `summary.trim().length > OWNER_RULE_SUMMARY_LIMIT || /[\p{Surrogate}\p{Cc}\p{Cf}]/u.test(summary.trim())`（`rule-types.ts:260-264`）
  - `summary: { type: "string", minLength: 1, maxLength: OWNER_RULE_SUMMARY_LIMIT }`（`production-owner-rules.ts:138`）
  - soft：`if (summary.length === 0 || Array.from(summary).length > OWNER_RULE_SUMMARY_LIMIT)`（`:483-485`）
- 建议：三处统一用同一套校验函数（建议按码点计长，或明确改成 UTF-16 并同步 schema 说明）；把 `\p{Zl}\p{Zp}` 加入换行拒绝；soft 也复用同一套不可见字符检查。补 U+2028 和 emoji 的用例。

### 7. 低：文档说“最近 6 条主人消息”，代码只扫最近 24 条总消息

- 文件:行：`apps/agent-service/src/production-owner-rules.ts:47-48`、`:301-312`；`docs/adr/0213-owner-sentence-becomes-a-standing-rule.md:61`
- 问题：`MESSAGES_SCANNED = 24`，`#ownerSaid` 只取水位线前 24 条消息，再从中筛选最近 6 条 owner 消息。若一轮里工具调用/结果很多，主人的原话被挤出这 24 条窗口，就会被错误降级成 proposed。ADR 写的是“最近 6 条主人消息”，没有 24 条总消息限制。
- 证据：
  - `const OWNER_MESSAGES_CHECKED = 6; const MESSAGES_SCANNED = 24;`（`:47-48`）
  - `listMessages(ownerId, agentId, threadId, Math.max(0, thread.messageWatermark - MESSAGES_SCANNED), MESSAGES_SCANNED)`（`:301-307`）
- 建议：按角色向前分页，直到凑够 6 条 owner 消息，或在文档里明确 24 条窗口；补一个长工具循环后仍能直接生效的用例。

### 8. 低：提议按参数去重但载荷只写一次，后续调用的 quote/summary 会被静默丢弃

- 文件:行：`apps/agent-service/src/production-owner-rules.ts:520-528`、`:320-332`、`:543-549`
- 问题：`proposalId` 只由 `[ownerId, type, params]` 决定，`#writeText` 在载荷已存在时不覆盖。第一次用某个 quote/summary 生成提议后，后续同参数、不同 quote/summary 的调用会返回同一个 `proposalId`，但卡片展示的是本次 quote/summary，`confirm` 实际激活的是第一次存下的 proposal。测试 `proposals.size === 1` 只验证了去重，没有验证显示与确认内容一致。
- 证据：
  - `JSON.stringify([this.#scope().ownerId, normalized.type, normalized.params])`（`:525-527`）
  - `if (!(await this.#options.payloads.get(ref))) await this.#options.payloads.put(...)`（`:322-332`）
- 建议：把 quote/summary/threadId 也纳入 proposal 去重键，或在 `#writeText` 逻辑上更新 payload，或返回已存提议的 quote/summary，保证“看到的提议 = 确认后的提议”。

### 9. 低：工具说明与写入端对 soft + inferred 的行为不一致

- 文件:行：`packages/prompt-catalog/src/tools.ts:231`；`apps/agent-service/src/production-owner-rules.ts:483-487`
- 问题：工具说明写“inferred 填 true 表示这是推断出的规矩，只会生成提议”，但 soft 分支遇到 `inferred=true` 直接抛 `RULE_NOT_EXPLICIT`，根本不会生成提议。模型按说明调用会收到错误。
- 证据：工具文本“inferred 填 true …… 只会生成提议，要主人点头才生效”；写入端 `if (input.inferred || !(await this.#ownerSaid(...))) throw new OwnerRuleError("RULE_NOT_EXPLICIT", "偏好只记主人的原话");`
- 建议：在工具说明里明确“soft 也只能是主人原话，inferred=true 会被拒绝”，或让 soft 的 inferred 走 tentative 偏好记忆而不是报错。

## 推测 / 未核实

- 未核实运行时是否会用同一个 `toolCallId` 重试失败的 `rule_set`。如果会，问题 2 的“active 规则 + archived 记忆”在普通工具调用路径也会出现；`confirm` 重试路径已由代码逻辑证实。
- 问题 1 的实际触发取决于模型是否愿意选“这封必须提醒我”这个完整分句。代码没有概率数据；我确认的是“只要模型这样选，写入端会直接生效”。ADR 已承认“主人粘贴别人写的整句”这一类限制，但没有承认这种“主人的一次性分句”。
- 未核实生产环境的 prompt-prefix 检查是否已经覆盖“新增三个工具”的一次性换新记录；工具集合变化的通用机制在，但我没有找到针对这三个新工具的专门断言。
- 评测里的 `hit`/`miss` 使用完整 `body`，生产检查可能使用窗口化正文；可能造成“评测命中但生产不命中”或反过来，属于估计误差，我没有逐封对齐真实邮件窗口。

## 侧重检查

- **错误路径 / 补偿顺序**：查了 `#activate` 的写记忆→建规则→失败归档、`undo` 的 retire→归档、`#archiveMemory` 的两类可忽略错误。结论：create 补偿和 undo 顺序都会留下互换的不一致状态，见问题 2、3；且没有对应的失败注入测试。
- **不合规范 / 不可信输入**：查了 `ProductionOwnerRuleTools.run` 的参数白名单（`:669-677`）、`rule-types.ts` 的列表/域名/地址/整词/不可见字符校验、`parseOwnerRuleParameters` 的 summary 校验、`memory.rule.respond` 的 target/action 校验。结论：规则参数校验总体较严，CEL 字面量用 `JSON.stringify` 转义；但 summary 的 Zl/Zp、soft 控制字符、quote 的控制字符仍有缺口；`memory.rule.respond` 内部把非 confirm/reconfirm 一律当 undo，虽然网关 `enumeration(OWNER_RULE_ACTIONS)` 已挡住外部坏值，内部调用仍值得再加一次显式校验。
- **安全 / 越权**：查了显式生效条件、quote 与 params 的绑定、主人消息角色过滤。结论：只检查 quote 是否来自 owner 消息，不检查 params 是否由这句话推出；结合问题 1，模型或注入可以把一次性分句配成宽泛规则，这是一条真实的提权面。
- **资源耗尽**：查了 live eval 的费用上限、重试、`EVAL_RUNS`/`EVAL_MODELS`；规则列表 32、每列 32 项、每项 64 字、整体 16384；邮件正文有 200000 硬上限。未发现本次新增可被远程输入放大的无界循环；`findRelatedMail` 的 thread 请求仍受 `requestsPerCheck` 预算约束。
- **不可撤销的操作**：撤销本身是 retire + 归档可重试；但问题 3 的中间状态会让模型继续看到规则文本。失败补偿也没有事务，重试会改变语义（问题 2）。
- **规则文件 / 说明文档 / 代码一致性**：ADR 0213 的“最近 6 条主人消息”“写规则失败不留孤儿”“不能有换行”与代码不完全一致；工具说明对 soft + inferred 的描述与代码不一致；评测脚本的“真实评测”与生产提示/写入端也不一致。Gmail thread 404 判为不完整这一条，代码和测试是一致的。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   - 会改变一次：新增 `rule_set`/`rule_list`/`rule_undo` 三个工具定义，工具定义在请求最前面，所以老对话下一次请求的开头会变。这是 prompt-prefix 规则第 6 条允许的“工具集合变了换新一次”，ADR 0213 也写明了这个代价。
   - 除这次换新外，新增内容本身是静态工具定义、工具结果和记忆，没有发现每轮变化的时间/额度/哈希进入系统提示或工具定义；工具结果和记忆属于末尾追加内容。遮盖逻辑本次没有改。严格回答：**不是严格的“只在末尾追加”，因为工具集合在开头变了一次；之后才是只追加，每轮变化值也没有进入开头。**

2. **会不会让同一段文字在不同请求里变成不同字节？**
   - 生产路径没有发现新增的、依赖前后文的遮盖或带时间字段进入模型请求。规则参数在 `rule-types.ts` 的 `entries` 里统一 `foldText` 后去重排序；`proposalId` 基于规范化后的 `[ownerId,type,params]`；每日额度兜底里的 `ruleHits`/`floorHits` 做了 `Set` + `sort` + `slice`。这些都不依赖对象遍历或数据库返回顺序。
   - 有一个旧行为：`floorHits[item.messageId] = floorIds` 在无强制规则时没有排序，但它不进模型请求，只进决策账本；本次新增的路径已排序。另注意 `#ownerSaid` 依赖最近消息，会影响“生效还是提议”，但不会改变同一段历史的模型字节。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   - 有新增检查：近似片段（“必须提醒我”）落 proposed、提议按参数去重、summary 换行拒绝、soft + inferred 拒绝、每日额度兜底、Gmail thread 404 不完整、新配置键上下界、回执卡整串规则措辞。`production-memory-capture` 的片段反向用例如果退回子串匹配会失败，确实有效。
   - 缺口：没有“这封必须提醒我”这个完整一次性分句的反向用例（问题 1）；没有归档失败后重试的测试（问题 2、3）；评测脚本没有通过率断言（问题 5），且判分与写入端不一致（问题 4）；U+2028/emoji 没被覆盖（问题 6）。因此“反向用例真的会失败”只对已写的那几个成立，关键路径还不完整。

4. **每个新值的使用端都能接受吗？**
   - 已核对通过：
     - `OWNER_RULE_STORED_LIMIT = 16_384` 与 SQLite `MAX_PARAMETERS = 16_384` 都是 `JSON.stringify(...).length`，生成端 `parseOwnerRuleParameters` 和存储端 `sqlite-owner-rule-operations.ts:131-132` 一致。
     - `ruleId`（`owner:` + 24 hex）通过 DB `OWNER_RULE_ID` 和网关 `machineString`；`proposalId`（`rule-proposal:` + 32 hex）通过 `confirm` 正则和 `machineString`。
     - 新增四个配置键都在 `configuration.ts`、`strict-configuration.ts`、`production-proactive.ts` 和 startup 测试里闭环；`wholeThreadCharactersPerMail` 在 `proactive-mail-check-service.ts:307-309` 实际使用。
     - `content_folded`/`content_words` 在字段目录、`mailItemFacts`、生成表达式和回放里都有对应。
     - `floorHits`/`ruleHits` 里的 `owner:...@rev` 和去掉 `@rev` 的 `owner:...` 能通过 SQLite `ids()` 的字符串校验，决策链也专门处理了 `owner:` 前缀。
     - `rules.receipt.replay` 新增的 `kind` 参数在 message-id 样例和三个语言文件里都补齐了。
   - 仍有不一致：summary 的 UTF-16 vs 码点/soft 校验（问题 6）；工具的 “inferred=true 生成提议” 对 soft 不成立（问题 9）；以及来源记忆的 archived/active 状态与规则状态会互换（问题 2、3）。
