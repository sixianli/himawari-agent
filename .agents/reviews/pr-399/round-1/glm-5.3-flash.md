# 复核报告：f302442（规则原话带卡号或口令时的处理）

## 作者说法逐条核对（读代码证实的）

| 说法 | 结论 |
|---|---|
| `#writeText` 用 `classificationWithIdentifiers(text, "private")` 定级，最多返回 sensitive | ✅ `packages/sensitive-capture/src/identifiers.ts:20-28`：返回类型是 `T \| "sensitive"`，入参 `"private"` 时只可能返回 `"private"` 或 `"sensitive"`，不可能 restricted |
| `dataClassification === "restricted"` 分支走不到 | ✅（restricted 这一半）。规则原话的两个 ref（`memory-content:rule:<hash>`、`rule-proposal:<hash>`）全仓库只有 `production-owner-rules.ts` 写入（grep `memory-content:rule\|rule-proposal:` 仅命中该文件 423、645、670 行），写入时的定级都来自 `classificationWithIdentifiers`（402 行），∈{private, sensitive}；外部 MCP 写入用 `memory-content:mcp:` 前缀（`production-mcp-memory-writer.ts:24`），不冲突。所以 restricted 不可达。⚠️ 但 `!payload` 这半边原理上可达（写入后读回失败），以前报 RULE_TEXT_REFUSED——作者已用“payload 读不回来时改报 RULE_UNAVAILABLE”涵盖这一点 |
| 删掉 RULE_TEXT_REFUSED（联合类型和分支） | ✅ diff 见 132、405-408 行 |
| 补集成测试、ADR 0213 写明 | ✅ `test/integration/production-memory-capture.test.ts:1813`、`docs/adr/0213-...md:103` |

## 发现的问题（严重度从高到低）

**1.（低）新测试对“撤销本次 diff”不会失败——本次实际删掉的代码没有任何会失败的检查**
- 文件：`test/integration/production-memory-capture.test.ts:1813`
- 证据：被删的旧分支是 `if (!payload || payload.dataClassification === "restricted") throw RULE_TEXT_REFUSED`。带卡号的原话经 `classificationWithIdentifiers` 得到 `"sensitive"`，旧代码同样不抛（sensitive ≠ restricted），同样建规则、同样存 sensitive。所以把 diff 整个撤销，新测试照样通过。新测试有价值——它钉住了 Andy 的**行为决策**（带卡号原话直接生效 + sensitive），防止将来有人重新加拒绝逻辑；但它验证不了死代码删除本身，也覆盖不到新改的 `!payload → RULE_UNAVAILABLE` 路径（production-owner-rules.ts:408 无测试，生产运行时工具的错误映射 `production-runtime-tools.ts:609-623` 也没有 rule 工具的测试走过——集成测试都是直接调 `ruleTools.run`，绕过这层映射）。
- 建议：死代码删除不必强求反向用例；若想钉住 408 行，可加一条 payloads 桩在 put 之后返回 undefined 的用例，断言 `code: "RULE_UNAVAILABLE"`。

**2.（低，预先存在、本次未加剧）`#writeText` 在 ref 已有载荷时不比较新旧文本，直接返回旧定级**
- 文件：`apps/agent-service/src/production-owner-rules.ts:394-410`
- 证据：396 行 `if (!(await this.#options.payloads.get(ref)))` 才写入，407-409 行无条件返回已存载荷的 `dataClassification`。当前两个 ref 都是内容寻址（proposal 的 hash 含完整 proposal 内容）或按单次工具调用寻址（key = `hash(runId\ntoolCallId)`），同一 ref 必然同一文本，所以现在无害。对比之下 MCP 写入端（`production-mcp-memory-writer.ts:200-204`）在已存在时会校验定级一致、不一致就报冲突。
- 建议：可在 ref 已存在时对新文本重算定级并取较高者，或保持现状但留意以后改 key 方案时这里会静默沿用旧分级。

**3.（低，文档措辞）ADR 0213 新增行“原话里带密码……时按 sensitive 保存”只在凭据**值**被认出来时成立**
- 文件：`docs/adr/0213-owner-sentence-becomes-a-standing-rule.md:103`；证据：`identifiers.ts:16-18` 的 `containsCredential` 依赖 `redactForEgress` 认出 password/verification-code/machine-secret 三类**值**；只提到“密码”两个字、没有值的原话定级仍是 private。与 ADR 0185/0188 的“已知缺口”口径一致，但建议把“带密码”写成“带密码等凭据的值”，避免误读为提到关键词就抬升。

**未核实**：`decision-chain.test.ts` 是否专门覆盖“sensitive 规则记忆在依据抽屉里的显示”——显示走的是通用 `reviewMemoryVisible`（sensitive 可见，见下），与其它敏感记忆同一条路径，风险低，未逐条查其用例。

## 侧重检查：一条普通使用流程的覆盖情况

流程：主人在聊天里说“银行扣款邮件以后必须提醒我” → 模型调 `rule_set`（工具描述来自提示词目录，冻结在请求开头的工具定义里，本次未动）→ `production-runtime-tools.ts:609-623` 的规则工具分发与错误映射 → `ProductionOwnerRuleTools.run`（production-owner-rules.ts:798-832）→ `create`（589-667：quote 校验、`isStandingQuote` + `#ownerSaid` 回读主人最近消息）→ `#activate`（487-567：参数校验、试算回放、同参去重、上限）→ `#writeMemory`（412-456）→ `#writeText`（394-410，本次改动处）→ `rules.create` + 失败回滚归档 → 回执工具结果 → 网页 `RuleReceiptCard`；撤销走 `memory.rule.respond` → `undo`（760-788）。

- 有测试：主流程（proposals、去重、撤销/恢复、参数非法、控制命令错误码）在 `production-memory-capture.test.ts:1845-2115` 覆盖得很厚；网页回执卡有 `apps/control-center/test/owner-rules.unit.test.ts:109-178`。
- 无测试：① `production-runtime-tools.ts:609-623` 规则工具的 OwnerRuleError→工具结果映射（整层，rule 相关无任何用例；预先存在）；② 本次新改的 `!payload → RULE_UNAVAILABLE`（见问题 1）。
- 文档与代码一致：ADR 0213 决定 5、后果节的其余描述与代码一致；`memory.rules.read` 只返回参数和说明、不返回原话（production-memory-control.ts:451-463），回执卡不渲染原话，sensitive 规则记忆不会经这些入口把卡号展示出去。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？** 不会。diff 只动了服务端规则写入和一个错误码；系统提示、工具定义、遮盖规则、历史写入都没碰。模型可见的唯一差异是失败路径下当轮**末尾追加**的工具结果里 `errorCode` 字符串（RULE_TEXT_REFUSED → RULE_UNAVAILABLE），且原 restricted 分支本就不可达。每轮会变的值（回执里的 updatedAt、决策链 generatedAt 等）只在当轮工具结果或网页查询里，不在请求开头。符合 prompt-prefix 规则第 4、2 条。

**2. 会不会让同一段文字在不同请求里变成不同字节？** 不会。规则原话的定级是文本的纯函数（`classificationWithIdentifiers`，无时间、无前后文依赖）；未新增任何带时间字段、无序集合或依赖后文的遮盖进模型请求。工具结果里的回执在同一轮内确定性序列化。

**3. 有没有对应的自动检查、反向用例会不会失败？** 有自动检查：新集成测试会随 `production-memory-capture.test.ts` 跑。但反向验证不成立——撤销 diff 测试照样通过（问题 1），因为被删的分支本就不可达；`!payload → RULE_UNAVAILABLE` 无任何用例。测试钉住的是行为决策，不是本次代码改动。

**4. 每个产生/修改的值，两端核对：**
- **删除 `RULE_TEXT_REFUSED`**：产生处已删；使用处全仓库（含契约 `gateway-contracts`、网页 `control-center`、工具映射、docs）零命中；由 `git log -S` 推得基准提交里也只存在于 `production-owner-rules.ts`（当前树 0 处 + 本 diff 删除 2 处 = 基准恰好 2 处，均在该文件）。✅
- **`RULE_UNAVAILABLE`（新用于 payload 读不回）**：工具路径 `production-runtime-tools.ts:616-620` 用 `error.code` 通用映射进工具结果，note 文案与具体码无关；控制命令 `production-memory-control.ts:1111-1117` 映射为 INVALID_OPERATION + 原 code，这两个消费端本来就在处理其它 RULE_UNAVAILABLE（undo/reconfirm 已在抛它）。✅
- **sensitive 的规则记忆**：写入端 `memory.applyProposal` 接受 sensitive（类型 `DataClassification` 含 sensitive，集成测试实证）；决策链 `reviewMemoryVisible("sensitive") = isModelVisible`（daily-review.ts:145-147、model-visibility.ts:10-14）→ 正文可见；规则列表只用参数不用记忆（production-owner-rules.ts:683-696）；规则执行只看 `rule_book_rules` 行（rule-types.ts:300-310），不依赖记忆分级；推送正文隐藏（production-web-push.ts:487）对 sensitive 是隐藏方向，安全。✅
- **“同一 ref 已存在时定级是否可能是 restricted”**：不可能——两个 ref 前缀全仓库仅 `production-owner-rules.ts` 写入，写入定级 ∈{private, sensitive}；MCP 外部记忆用 `memory-content:mcp:` 独立前缀，不冲突。✅（推断部分：若将来有别的组件写同名前缀，408 行会静默把 restricted 分级写进规则记忆——当前代码里没有这样的写入者，属推测性提醒。）
